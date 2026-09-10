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
    File::open(format!("/proc/self/fd/{fd}")).map_err(|_| "linux_artifact_snapshot_failed".into())
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
pub(super) struct LifetimeGuard {
    pid: File,
    spawning_thread: Option<(std::sync::mpsc::Sender<()>, std::thread::JoinHandle<()>)>,
}
impl LifetimeGuard {
    pub(super) fn attach(child: &Child) -> Result<Self, String> {
        let fd = unsafe { syscall(434, child.id() as i32, 0u32) };
        if fd < 0 {
            return Err("linux_process_protection_unavailable".into());
        }
        Ok(Self {
            pid: unsafe { File::from_raw_fd(fd as i32) },
            spawning_thread: None,
        })
    }
}
/// Parent-death signals follow the spawning THREAD. Keep that thread alive for
/// the whole resident lifetime rather than relying on a temporary async worker.
pub(super) fn spawn(mut command: Command) -> Result<(Child, LifetimeGuard), String> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let (release, wait) = std::sync::mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("luczor-runtime-owner".into())
        .spawn(move || {
            configure(&mut command);
            match command.spawn() {
                Ok(mut child) => {
                    if let Err(error) = send.send(Ok(child)) {
                        child = error.0.unwrap();
                        let _ = child.kill();
                        let _ = child.wait();
                        return;
                    }
                    let _ = wait.recv();
                }
                Err(_) => {
                    let _ = send.send(Err("linux_runtime_spawn_failed".to_string()));
                }
            }
        })
        .map_err(|_| "linux_process_protection_unavailable")?;
    let mut child = receive
        .recv()
        .map_err(|_| "linux_process_protection_unavailable")??;
    let mut guard = match LifetimeGuard::attach(&child) {
        Ok(guard) => guard,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    guard.spawning_thread = Some((release, thread));
    Ok((child, guard))
}
impl Drop for LifetimeGuard {
    fn drop(&mut self) {
        // pidfd signalling cannot kill an unrelated process after PID reuse.
        unsafe {
            syscall(
                424,
                self.pid.as_raw_fd(),
                9i32,
                std::ptr::null::<u8>(),
                0u32,
            );
        }
        if let Some((release, thread)) = self.spawning_thread.take() {
            let _ = release.send(());
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    fn directory() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "luczor-seal-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        p
    }
    #[test]
    fn snapshot_is_sealed_and_survives_source_replacement() {
        let dir = directory();
        let path = dir.join("model");
        fs::write(&path, b"signed bytes").unwrap();
        let mut file = snapshot(&path, &AtomicBool::new(false)).unwrap();
        fs::write(&path, b"other bytes!").unwrap();
        fs::remove_file(&path).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"signed bytes");
        assert!(file.write_all(b"changed").is_err());
        assert!(file.set_len(0).is_err());
        if let Ok(mut writable) = OpenOptions::new()
            .write(true)
            .open(format!("/proc/self/fd/{}", file.as_raw_fd()))
        {
            assert!(writable.write_all(b"changed").is_err());
        }
        assert_eq!(
            unsafe { fcntl(file.as_raw_fd(), F_GET_SEALS) } & SEALS,
            SEALS
        );
        fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn resident_survives_temporary_calling_thread() {
        let (mut child, guard) = std::thread::spawn(|| {
            let mut command = Command::new("/usr/bin/sleep");
            command.arg("30");
            spawn(command).unwrap()
        })
        .join()
        .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(child.try_wait().unwrap().is_none());
        drop(guard);
        assert!(!child.wait().unwrap().success());
    }
    #[test]
    fn cancels_and_rejects_symlinks() {
        let dir = directory();
        let path = dir.join("model");
        fs::write(&path, b"ok").unwrap();
        assert!(snapshot(&path, &AtomicBool::new(true)).is_err());
        symlink(&path, dir.join("link")).unwrap();
        assert!(snapshot(&dir.join("link"), &AtomicBool::new(false)).is_err());
        fs::remove_file(dir.join("link")).unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn bundle_retains_descriptors_executes_and_cleans_up() {
        let dir = directory();
        let sealed = snapshot(Path::new("/usr/bin/true"), &AtomicBool::new(false)).unwrap();
        let bundle = Bundle::new(&dir, vec![("llama-server".into(), &sealed)]).unwrap();
        let path = bundle.path("llama-server");
        drop(sealed);
        let mut command = Command::new(&path);
        configure(&mut command);
        let mut child = command.spawn().unwrap();
        let guard = LifetimeGuard::attach(&child).unwrap();
        assert!(child.wait().unwrap().success());
        drop(guard);
        drop(bundle);
        assert!(!path.exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn guard_drop_kills_owned_child() {
        let mut command = Command::new("/usr/bin/sleep");
        command.arg("30");
        configure(&mut command);
        let mut child = command.spawn().unwrap();
        let guard = LifetimeGuard::attach(&child).unwrap();
        drop(guard);
        let deadline = Instant::now() + Duration::from_secs(3);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() > deadline {
                let _ = child.kill();
                panic!("child survived guard drop");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    #[test]
    fn parent_helper() {
        let Ok(report) = std::env::var("LUCZOR_PARENT_DEATH_TEST_REPORT") else {
            return;
        };
        let mut command = Command::new("/usr/bin/sleep");
        command
            .arg("30")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure(&mut command);
        let child = command.spawn().unwrap();
        let _guard = LifetimeGuard::attach(&child).unwrap();
        fs::write(report, child.id().to_string()).unwrap();
        std::thread::sleep(Duration::from_secs(30));
    }
    #[test]
    fn kernel_kills_child_when_parent_is_killed() {
        let dir = directory();
        let report = dir.join("pid");
        let mut parent = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!(
                    "{}::parent_helper",
                    module_path!().split_once("::").unwrap().1
                ),
                "--nocapture",
            ])
            .env("LUCZOR_PARENT_DEATH_TEST_REPORT", &report)
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !report.exists() {
            if Instant::now() > deadline {
                let _ = parent.kill();
                let _ = parent.wait();
                panic!("helper did not start");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let pid = fs::read_to_string(&report).unwrap();
        parent.kill().unwrap();
        parent.wait().unwrap();
        loop {
            let stopped = fs::read_to_string(format!("/proc/{pid}/stat"))
                .map(|s| s.split_whitespace().nth(2) == Some("Z"))
                .unwrap_or(true);
            if stopped {
                break;
            }
            assert!(Instant::now() < deadline, "child survived parent death");
            std::thread::sleep(Duration::from_millis(10));
        }
        fs::remove_file(report).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
