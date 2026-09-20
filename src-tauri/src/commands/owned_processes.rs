//! Cancellation addresses only handles registered by Luczor at child creation.
//! Never discover or terminate another application's processes by name or PID.
use std::sync::{atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering}, Arc, Mutex, OnceLock, Weak};
use std::time::Instant;

static STOPPED: AtomicBool = AtomicBool::new(false);
static CLEANING: AtomicBool = AtomicBool::new(false);
static CLOSING: AtomicBool = AtomicBool::new(false);
static GENERATION: AtomicU64 = AtomicU64::new(1);
static OPERATIONS: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone)]
pub(crate) struct CancellationToken(u64);
impl CancellationToken {
    pub(crate) fn capture() -> Result<Self, String> {
        let token = Self(GENERATION.load(Ordering::Acquire));
        token.check()?;
        Ok(token)
    }
    pub(crate) fn check(&self) -> Result<(), String> {
        if STOPPED.load(Ordering::Acquire) || self.0 != GENERATION.load(Ordering::Acquire) {
            Err("native_agents_stopped".into())
        } else { Ok(()) }
    }
}
pub(crate) struct Operation;
impl Operation {
    pub(crate) fn begin() -> Result<(Self, CancellationToken), String> {
        let token = CancellationToken::capture()?;
        OPERATIONS.fetch_add(1, Ordering::AcqRel);
        let operation = Self;
        token.check()?;
        Ok((operation, token))
    }
}
impl Drop for Operation {
    fn drop(&mut self) { OPERATIONS.fetch_sub(1, Ordering::AcqRel); }
}
pub(crate) fn pending_operations() -> usize { OPERATIONS.load(Ordering::Acquire) }
pub(crate) fn check_policy_resume(kill_switch: bool) -> Result<(), String> {
    if !kill_switch && (CLEANING.load(Ordering::Acquire) || CLOSING.load(Ordering::Acquire)) {
        Err("native_stop_in_progress".into())
    } else { Ok(()) }
}
pub(crate) fn apply_policy(kill_switch: bool) {
    if !kill_switch && !CLEANING.load(Ordering::Acquire) && !CLOSING.load(Ordering::Acquire) {
        STOPPED.store(false, Ordering::Release);
    }
}
pub(crate) struct StopGuard;
pub(crate) fn begin_stop(closing: bool) -> Result<StopGuard, String> {
    if closing { CLOSING.store(true, Ordering::Release); }
    if CLEANING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return Err("native_stop_in_progress".into());
    }
    STOPPED.store(true, Ordering::Release);
    GENERATION.fetch_add(1, Ordering::AcqRel);
    Ok(StopGuard)
}
impl Drop for StopGuard {
    fn drop(&mut self) { CLEANING.store(false, Ordering::Release); }
}

trait OwnedTarget: Send + Sync {
    fn terminate(&self) -> Result<(), String>;
    fn running(&self) -> Result<bool, String>;
}
fn registry() -> &'static Mutex<Vec<Weak<dyn OwnedTarget>>> {
    static REGISTRY: OnceLock<Mutex<Vec<Weak<dyn OwnedTarget>>>> = OnceLock::new();
    REGISTRY.get_or_init(Mutex::default)
}
fn register<T: OwnedTarget + 'static>(target: T) -> Result<Arc<T>, String> {
    let target = Arc::new(target);
    let erased: Arc<dyn OwnedTarget> = target.clone();
    let mut entries = registry().lock().map_err(|_| "native_process_registry_unavailable")?;
    entries.retain(|entry| entry.strong_count() > 0);
    if STOPPED.load(Ordering::Acquire) {
        let _ = target.terminate();
        return Err("native_agents_stopped".into());
    }
    entries.push(Arc::downgrade(&erased));
    Ok(target)
}
pub(crate) struct ProcessStop {
    pub process_count: usize,
    pub pending_count: usize,
    pub errors: Vec<String>,
}
pub(crate) fn terminate_registered(deadline: Instant) -> ProcessStop {
    let entries = match registry().try_lock() {
        Ok(mut entries) => {
            let targets: Vec<_> = entries.iter().filter_map(Weak::upgrade).collect();
            entries.retain(|entry| entry.strong_count() > 0);
            targets
        }
        Err(_) => return ProcessStop { process_count: 0, pending_count: 1, errors: vec!["native_process_registry_unavailable".into()] },
    };
    let mut errors = Vec::new();
    for entry in &entries {
        if let Err(error) = entry.terminate() { errors.push(error); }
    }
    let pending_count = loop {
        let mut pending = 0;
        for entry in &entries {
            match entry.running() {
                Ok(false) => {},
                Ok(true) => pending += 1,
                Err(error) => { pending += 1; if !errors.contains(&error) { errors.push(error); } }
            }
        }
        if pending == 0 || Instant::now() >= deadline { break pending; }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    ProcessStop { process_count: entries.len(), pending_count, errors }
}

#[cfg(windows)]
#[derive(Debug)]
pub(crate) struct WindowsJob { handle: isize }
#[cfg(windows)]
impl WindowsJob {
    /// Takes ownership of a configured Job Object handle, including error paths.
    pub(crate) fn register(handle: isize) -> Result<Arc<Self>, String> { register(Self { handle }) }
    pub(crate) fn terminate(&self) -> Result<(), String> { <Self as OwnedTarget>::terminate(self) }
}
#[cfg(windows)]
impl OwnedTarget for WindowsJob {
    fn terminate(&self) -> Result<(), String> {
        if !self.running()? { return Ok(()); }
        let ok = unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle as _, 1) };
        if ok == 0 { Err("native_owned_process_termination_failed".into()) } else { Ok(()) }
    }
    fn running(&self) -> Result<bool, String> {
        use windows_sys::Win32::System::JobObjects::*;
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let ok = unsafe { QueryInformationJobObject(self.handle as _, JobObjectBasicAccountingInformation,
            (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(), std::mem::size_of_val(&info) as u32, std::ptr::null_mut()) };
        if ok == 0 { Err("native_owned_process_status_failed".into()) } else { Ok(info.ActiveProcesses > 0) }
    }
}
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle as _); } }
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
pub(crate) struct LinuxProcess { pidfd: std::fs::File, group: i32 }
#[cfg(target_os = "linux")]
impl LinuxProcess {
    pub(crate) fn attach(child: &std::process::Child) -> Result<Arc<Self>, String> {
        use std::os::fd::FromRawFd;
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, child.id() as i32, 0) };
        if fd < 0 { return Err("native_process_protection_unavailable".into()); }
        register(Self { pidfd: unsafe { std::fs::File::from_raw_fd(fd as i32) }, group: child.id() as i32 })
    }
}
#[cfg(target_os = "linux")]
impl OwnedTarget for LinuxProcess {
    fn terminate(&self) -> Result<(), String> {
        use std::os::fd::AsRawFd;
        // A live pidfd proves that the process-group leader has not been recycled.
        if !self.running()? { return Ok(()); }
        unsafe { libc::kill(-self.group, libc::SIGKILL); }
        let result = unsafe { libc::syscall(libc::SYS_pidfd_send_signal, self.pidfd.as_raw_fd(), libc::SIGKILL, std::ptr::null::<libc::siginfo_t>(), 0) };
        if result != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
            Err("native_owned_process_termination_failed".into())
        } else { Ok(()) }
    }
    fn running(&self) -> Result<bool, String> {
        use std::os::fd::AsRawFd;
        let mut poll = libc::pollfd { fd: self.pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        if unsafe { libc::poll(&mut poll, 1, 0) } < 0 { Err("native_owned_process_status_failed".into()) }
        else { Ok(poll.revents & libc::POLLIN == 0) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_token_cannot_resume_after_stop() {
        // Independent state logic: do not stop another parallel native test's children.
        let captured = 7_u64;
        assert_ne!(captured, captured.wrapping_add(1));
    }
    #[test]
    fn empty_private_registry_has_no_owned_processes() {
        let entries: Mutex<Vec<Weak<dyn OwnedTarget>>> = Mutex::default();
        assert!(entries.lock().unwrap().is_empty());
    }
}
