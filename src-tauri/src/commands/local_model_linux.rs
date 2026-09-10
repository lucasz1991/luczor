//! Linux-only sealed artifact snapshots and process lifetime protection.
//! No shell, capabilities, driver changes or privileged helper is required.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{symlink, DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

unsafe extern "C" {
    fn memfd_create(name: *const std::ffi::c_char, flags: u32) -> i32;
    fn fcntl(fd: i32, command: i32, ...) -> i32;
    fn prctl(option: i32, ...) -> i32;
    fn getppid() -> i32;
    fn syscall(number: std::ffi::c_long, ...) -> std::ffi::c_long;
}
const SEALS: i32 = 1 | 2 | 4 | 8; // SEAL, SHRINK, GROW, WRITE
const F_ADD_SEALS: i32 = 1033;
const F_GET_SEALS: i32 = 1034;

/// Snapshot first, seal, THEN hash the snapshot in the caller. Writes to the
/// original pathname cannot change bytes subsequently consumed by the runtime.
pub(super) fn snapshot(path: &Path, cancel: &AtomicBool) -> Result<File, String> {
    let source = OpenOptions::new()
        .read(true)
        .custom_flags(0x20000)
        .open(path)
        .map_err(|_| "linux_artifact_open_failed")?; // O_NOFOLLOW
    let metadata = source
        .metadata()
        .map_err(|_| "linux_artifact_open_failed")?;
    if !metadata.is_file() {
        return Err("linux_artifact_open_failed".into());
    }
    let mut source = source.take(metadata.len().saturating_add(1));
    let fd = unsafe { memfd_create(c"luczor-verified-artifact".as_ptr(), 1 | 2) };
    if fd < 0 {
        return Err("linux_artifact_sealing_unavailable".into());
    }
    let mut sealed = unsafe { File::from_raw_fd(fd) };
    let mut buffer = [0u8; 65536];
    let mut since_check = 0;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Local artifact verification was cancelled.".into());
        }
        if since_check == 0 {
            check_memory_reserve()?;
        }
        let count = source
            .read(&mut buffer)
            .map_err(|_| "linux_artifact_open_failed")?;
        if count == 0 {
            break;
        }
        sealed
            .write_all(&buffer[..count])
            .map_err(|_| "linux_artifact_snapshot_failed")?;
        since_check = (since_check + count) % (8 * 1024 * 1024);
    }
    if sealed
        .metadata()
        .map_err(|_| "linux_artifact_snapshot_failed")?
        .len()
        != metadata.len()
    {
        return Err("linux_artifact_snapshot_failed".into());
    }
    sealed
        .set_permissions(fs::Permissions::from_mode(0o500))
        .map_err(|_| "linux_artifact_snapshot_failed")?;
    if unsafe { fcntl(fd, F_ADD_SEALS, SEALS) } < 0
        || unsafe { fcntl(fd, F_GET_SEALS) } & SEALS != SEALS
    {
        return Err("linux_artifact_sealing_unavailable".into());
    }
    sealed
        .seek(SeekFrom::Start(0))
        .map_err(|_| "linux_artifact_snapshot_failed")?;
    Ok(sealed)
}

fn check_memory_reserve() -> Result<(), String> {
    let info =
        fs::read_to_string("/proc/meminfo").map_err(|_| "linux_artifact_memory_unavailable")?;
    let available = info
        .lines()
        .find_map(|line| {
            line.strip_prefix("MemAvailable:")?
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()
        })
        .ok_or("linux_artifact_memory_unavailable")?;
    // Bounded staging can consume tmpfs pages; never push into the emergency reserve.
    if available < 1024 * 1024 {
        return Err("runtime_startup_ram_pressure".into());
    }
    Ok(())
}

#[derive(Debug)]
pub(super) struct Bundle {
    directory: PathBuf,
    files: Vec<File>,
    names: Vec<String>,
}
impl Bundle {
    pub(super) fn new(root: &Path, artifacts: Vec<(String, &File)>) -> Result<Self, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = root.join(format!(
            "sealed-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut builder = fs::DirBuilder::new();
        builder
            .mode(0o700)
            .create(&directory)
            .map_err(|_| "linux_artifact_namespace_failed")?;
        let mut bundle = Self {
            directory,
            files: Vec::new(),
            names: Vec::new(),
        };
        for (name, source) in artifacts {
            if name.is_empty()
                || name == "."
                || name == ".."
                || name.contains('/')
                || name.contains('\\')
            {
                return Err("linux_artifact_namespace_failed".into());
            }
            let file = source
                .try_clone()
                .map_err(|_| "linux_artifact_namespace_failed")?;
            if unsafe { fcntl(file.as_raw_fd(), F_GET_SEALS) } & SEALS != SEALS {
                return Err("linux_artifact_sealing_unavailable".into());
            }
            let target = PathBuf::from(format!(
                "/proc/{}/fd/{}",
                std::process::id(),
                file.as_raw_fd()
            ));
            symlink(target, bundle.directory.join(&name))
                .map_err(|_| "linux_artifact_namespace_failed")?;
            bundle.files.push(file);
            bundle.names.push(name);
        }
        fs::set_permissions(&bundle.directory, fs::Permissions::from_mode(0o500))
            .map_err(|_| "linux_artifact_namespace_failed")?;
        Ok(bundle)
    }
    pub(super) fn path(&self, name: &str) -> PathBuf {
        self.directory.join(name)
    }
}
impl Drop for Bundle {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700));
        for name in &self.names {
            let _ = fs::remove_file(self.directory.join(name));
        }
        let _ = fs::remove_dir(&self.directory);
    }
}

pub(super) fn configure(command: &mut Command) {
    command.process_group(0);
    let parent = std::process::id() as i32;
    // Only async-signal-safe syscalls between fork and exec; no locks or allocation.
    unsafe {
        command.pre_exec(move || {
            if prctl(1, 9, 0, 0, 0) != 0 {
                return Err(io::Error::last_os_error());
            } // PR_SET_PDEATHSIG, SIGKILL
            if getppid() != parent {
                return Err(io::Error::from_raw_os_error(10));
            }
            Ok(())
        });
    }
}

#[derive(Debug)]
pub(super) struct LifetimeGuard(File);
impl LifetimeGuard {
    pub(super) fn attach(child: &Child) -> Result<Self, String> {
        // pidfd syscall numbers are identical on supported x86_64/aarch64 Linux.
        let fd = unsafe { syscall(434, child.id() as i32, 0u32) };
        if fd < 0 {
            return Err("linux_process_protection_unavailable".into());
        }
        Ok(Self(unsafe { File::from_raw_fd(fd as i32) }))
    }
}
impl Drop for LifetimeGuard {
    fn drop(&mut self) {
        // A pidfd never targets a reused PID. ESRCH for an already reaped child is harmless.
        unsafe {
            syscall(424, self.0.as_raw_fd(), 9i32, std::ptr::null::<u8>(), 0u32);
        }
    }
}
