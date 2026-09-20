//! Cancellation addresses only handles registered by Luczor at child creation.
//! Never discover or terminate another application's processes by name or PID.
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Arc, Mutex, OnceLock, Weak,
};
use std::time::Instant;

struct CancellationState {
    transition: Mutex<()>,
    stopped: AtomicBool,
    cleaning: AtomicBool,
    closing: AtomicBool,
    generation: AtomicU64,
}
impl CancellationState {
    const fn new() -> Self {
        Self {
            transition: Mutex::new(()),
            stopped: AtomicBool::new(false),
            cleaning: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            generation: AtomicU64::new(1),
        }
    }
    fn check(&self, generation: u64) -> Result<(), String> {
        if self.stopped.load(Ordering::Acquire)
            || self.cleaning.load(Ordering::Acquire)
            || self.closing.load(Ordering::Acquire)
            || generation != self.generation.load(Ordering::Acquire)
        {
            Err("native_agents_stopped".into())
        } else {
            Ok(())
        }
    }
    fn start_stop(&self, closing: bool) -> Result<(), String> {
        if closing {
            self.closing.store(true, Ordering::Release);
        }
        let _transition = self
            .transition
            .try_lock()
            .map_err(|_| "native_stop_in_progress".to_string())?;
        self.cleaning
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "native_stop_in_progress".to_string())?;
        self.stopped.store(true, Ordering::Release);
        self.generation.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }
    fn finish_stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.cleaning.store(false, Ordering::Release);
    }
    fn resume(&self, expected_generation: u64) {
        let Ok(_transition) = self.transition.lock() else {
            return;
        };
        if expected_generation == self.generation.load(Ordering::Acquire)
            && !self.cleaning.load(Ordering::Acquire)
            && !self.closing.load(Ordering::Acquire)
        {
            self.stopped.store(false, Ordering::Release);
        }
    }
}
static STATE: CancellationState = CancellationState::new();
static OPERATIONS: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone)]
pub(crate) struct CancellationToken(u64);
impl CancellationToken {
    pub(crate) fn capture() -> Result<Self, String> {
        let token = Self(STATE.generation.load(Ordering::Acquire));
        token.check()?;
        Ok(token)
    }
    pub(crate) fn check(&self) -> Result<(), String> {
        STATE.check(self.0)
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
    fn drop(&mut self) {
        OPERATIONS.fetch_sub(1, Ordering::AcqRel);
    }
}
pub(crate) fn pending_operations() -> usize {
    OPERATIONS.load(Ordering::Acquire)
}
pub(crate) fn check_policy_resume(kill_switch: bool) -> Result<u64, String> {
    let generation = STATE.generation.load(Ordering::Acquire);
    if !kill_switch
        && (STATE.cleaning.load(Ordering::Acquire) || STATE.closing.load(Ordering::Acquire))
    {
        Err("native_stop_in_progress".into())
    } else {
        Ok(generation)
    }
}
pub(crate) fn apply_policy(kill_switch: bool, generation: u64) {
    if !kill_switch {
        STATE.resume(generation);
    }
}
pub(crate) struct StopGuard;
pub(crate) fn begin_stop(closing: bool) -> Result<StopGuard, String> {
    STATE.start_stop(closing)?;
    Ok(StopGuard)
}
impl Drop for StopGuard {
    fn drop(&mut self) {
        STATE.finish_stop();
    }
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
    let mut entries = registry()
        .lock()
        .map_err(|_| "native_process_registry_unavailable")?;
    entries.retain(|entry| entry.strong_count() > 0);
    if STATE
        .check(STATE.generation.load(Ordering::Acquire))
        .is_err()
    {
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
        Err(_) => {
            return ProcessStop {
                process_count: 0,
                pending_count: 1,
                errors: vec!["native_process_registry_unavailable".into()],
            }
        }
    };
    terminate_targets(entries, deadline)
}
fn terminate_targets(entries: Vec<Arc<dyn OwnedTarget>>, deadline: Instant) -> ProcessStop {
    let mut errors = Vec::new();
    for entry in &entries {
        if let Err(error) = entry.terminate() {
            errors.push(error);
        }
    }
    let pending_count = loop {
        let mut pending = 0;
        for entry in &entries {
            match entry.running() {
                Ok(false) => {}
                Ok(true) => pending += 1,
                Err(error) => {
                    pending += 1;
                    if !errors.contains(&error) {
                        errors.push(error);
                    }
                }
            }
        }
        if pending == 0 || Instant::now() >= deadline {
            break pending;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    ProcessStop {
        process_count: entries.len(),
        pending_count,
        errors,
    }
}

#[cfg(windows)]
#[derive(Debug)]
pub(crate) struct WindowsJob {
    handle: isize,
}
#[cfg(windows)]
impl WindowsJob {
    /// Takes ownership of a configured Job Object handle, including error paths.
    pub(crate) fn register(handle: isize) -> Result<Arc<Self>, String> {
        register(Self { handle })
    }
    pub(crate) fn terminate(&self) -> Result<(), String> {
        <Self as OwnedTarget>::terminate(self)
    }
}
#[cfg(windows)]
impl OwnedTarget for WindowsJob {
    fn terminate(&self) -> Result<(), String> {
        if !self.running()? {
            return Ok(());
        }
        let ok = unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle as _, 1)
        };
        if ok == 0 {
            Err("native_owned_process_termination_failed".into())
        } else {
            Ok(())
        }
    }
    fn running(&self) -> Result<bool, String> {
        use windows_sys::Win32::System::JobObjects::*;
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let ok = unsafe {
            QueryInformationJobObject(
                self.handle as _,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err("native_owned_process_status_failed".into())
        } else {
            Ok(info.ActiveProcesses > 0)
        }
    }
}
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle as _);
        }
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
pub(crate) struct LinuxProcess {
    pidfd: std::fs::File,
    group: i32,
}
#[cfg(target_os = "linux")]
impl LinuxProcess {
    pub(crate) fn attach(child: &std::process::Child) -> Result<Arc<Self>, String> {
        use std::os::fd::FromRawFd;
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, child.id() as i32, 0) };
        if fd < 0 {
            return Err("native_process_protection_unavailable".into());
        }
        let process = register(Self {
            pidfd: unsafe { std::fs::File::from_raw_fd(fd as i32) },
            group: child.id() as i32,
        })?;
        // Keep unresolved groups visible even when their worker drops its guard.
        // This conservative ledger never grants numeric-PID termination rights.
        static GROUPS: OnceLock<Mutex<Vec<Arc<LinuxProcess>>>> = OnceLock::new();
        let mut groups = GROUPS
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| "native_process_registry_unavailable")?;
        groups.retain(|entry| !matches!(entry.running(), Ok(false)));
        groups.push(process.clone());
        Ok(process)
    }
}
#[cfg(target_os = "linux")]
impl OwnedTarget for LinuxProcess {
    fn terminate(&self) -> Result<(), String> {
        use std::os::fd::AsRawFd;
        // The owner may concurrently reap the child. Only the pidfd is safe to
        // signal here; numeric group signalling would race PID reuse.
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.pidfd.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
            Err("native_owned_process_termination_failed".into())
        } else {
            Ok(())
        }
    }
    fn running(&self) -> Result<bool, String> {
        use std::os::fd::AsRawFd;
        let mut poll = libc::pollfd {
            fd: self.pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        if unsafe { libc::poll(&mut poll, 1, 0) } < 0 {
            Err("native_owned_process_status_failed".into())
        } else {
            if poll.revents & libc::POLLIN == 0 {
                return Ok(true);
            }
            // A dead leader alone is not proof that descendants have stopped.
            // Probe existence only; an ambiguous/reused group is never killed.
            let exists = unsafe { libc::kill(-self.group, 0) };
            if exists == 0 {
                Ok(true)
            } else if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                Ok(false)
            } else {
                Err("native_owned_process_group_unconfirmed".into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_token_cannot_resume_after_stop() {
        let state = CancellationState::new();
        let captured = state.generation.load(Ordering::Acquire);
        assert!(state.check(captured).is_ok());
        state.start_stop(false).unwrap();
        state.resume(state.generation.load(Ordering::Acquire));
        assert!(state.check(captured).is_err());
        state.finish_stop();
        assert!(state
            .check(state.generation.load(Ordering::Acquire))
            .is_err());
        state.resume(captured);
        assert!(state
            .check(state.generation.load(Ordering::Acquire))
            .is_err());
        state.resume(state.generation.load(Ordering::Acquire));
        assert!(state.check(captured).is_err());
        assert!(state
            .check(state.generation.load(Ordering::Acquire))
            .is_ok());
    }
    #[test]
    fn quit_and_overlapping_stop_cannot_be_resumed() {
        let state = CancellationState::new();
        state.start_stop(true).unwrap();
        assert!(state.start_stop(false).is_err());
        state.finish_stop();
        state.resume(state.generation.load(Ordering::Acquire));
        assert!(state
            .check(state.generation.load(Ordering::Acquire))
            .is_err());
    }
    struct Fixture {
        running: AtomicBool,
        refuse: bool,
    }
    impl OwnedTarget for Fixture {
        fn terminate(&self) -> Result<(), String> {
            if self.refuse {
                return Err("termination_denied".into());
            }
            self.running.store(false, Ordering::Release);
            Ok(())
        }
        fn running(&self) -> Result<bool, String> {
            Ok(self.running.load(Ordering::Acquire))
        }
    }
    #[test]
    fn registry_terminates_only_explicitly_owned_targets_and_reports_refusal() {
        let foreign = Arc::new(Fixture {
            running: AtomicBool::new(true),
            refuse: false,
        });
        let owned = Arc::new(Fixture {
            running: AtomicBool::new(true),
            refuse: false,
        });
        let refused = Arc::new(Fixture {
            running: AtomicBool::new(true),
            refuse: true,
        });
        let report = terminate_targets(vec![owned.clone(), refused.clone()], Instant::now());
        assert_eq!(report.process_count, 2);
        assert_eq!(report.pending_count, 1);
        assert_eq!(report.errors, vec!["termination_denied"]);
        assert!(!owned.running().unwrap());
        assert!(refused.running().unwrap());
        assert!(foreign.running().unwrap());
    }
    #[test]
    fn empty_registry_completes_immediately() {
        let report = terminate_targets(Vec::new(), Instant::now());
        assert_eq!(report.pending_count, 0);
        assert!(report.errors.is_empty());
    }
}
