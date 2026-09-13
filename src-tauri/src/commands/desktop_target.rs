//! One-use, short-lived observations bind native input to a foreground window.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::execution::{admit, ExecutionLease, ExecutionPermit};

const VALID_FOR: Duration = Duration::from_secs(30);
static OBSERVATIONS: OnceLock<Mutex<HashMap<String, Observation>>> = OnceLock::new();
static INPUT: Mutex<()> = Mutex::new(());
pub(super) fn lock_input() -> Result<MutexGuard<'static, ()>, String> {
    INPUT
        .try_lock()
        .map_err(|_| "Another desktop action is running.".into())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowTarget {
    pub window_id: u64,
    pub process_id: u32,
    pub process_started: u64,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub focused: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopObservation {
    pub observation_id: String,
    #[serde(flatten)]
    pub target: WindowTarget,
    pub captured_at: u64,
    pub expires_at: u64,
    pub control_revision: u64,
    pub input_mode: super::desktop_control::InputMode,
}

struct Observation {
    visible: DesktopObservation,
    captured: Instant,
    execution: ExecutionPermit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservePayload {
    pub execution: ExecutionPermit,
    pub window_id: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputPayload<T> {
    pub execution: ExecutionPermit,
    pub observation_id: String,
    #[serde(flatten)]
    pub request: T,
}

pub fn observe(payload: ObservePayload) -> Result<DesktopObservation, String> {
    let _input = lock_input()?;
    let lease = admit(&payload.execution, false)?;
    let config = super::desktop_control::config()?;
    let target = read_target(payload.window_id)?;
    super::desktop_control::check_target(&target)?;
    super::desktop_control::activity(&target, None, Some(&payload.execution))?;
    lease.check()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Invalid desktop clock.")?
        .as_millis() as u64;
    let visible = DesktopObservation {
        observation_id: uuid::Uuid::new_v4().to_string(),
        target,
        captured_at: now,
        expires_at: now + VALID_FOR.as_millis() as u64,
        control_revision: config.revision,
        input_mode: config.input_mode,
    };
    let mut entries = OBSERVATIONS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Desktop observations unavailable.")?;
    entries.retain(|_, item| item.captured.elapsed() < VALID_FOR);
    if entries.len() >= 128 {
        entries.clear();
    }
    entries.insert(
        visible.observation_id.clone(),
        Observation {
            visible: visible.clone(),
            captured: Instant::now(),
            execution: payload.execution,
        },
    );
    Ok(visible)
}

pub struct DesktopActionGuard {
    _input: MutexGuard<'static, ()>,
    observation: Observation,
    lease: ExecutionLease,
}

impl DesktopActionGuard {
    pub(super) fn target(&self) -> &WindowTarget {
        &self.observation.visible.target
    }
    #[cfg(target_os = "linux")]
    pub(super) fn permit(&self) -> &ExecutionPermit {
        &self.observation.execution
    }
    pub fn acquire(permit: &ExecutionPermit, id: &str) -> Result<Self, String> {
        let input = INPUT
            .try_lock()
            .map_err(|_| "Another desktop action is running.")?;
        let lease = admit(permit, true)?;
        let observation = OBSERVATIONS
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| "Desktop observations unavailable.")?
            .remove(id)
            .ok_or(
                "Desktop observation is missing or already consumed; observe again before acting.",
            )?;
        if observation.execution != *permit {
            return Err("Desktop observation belongs to an older execution scope.".into());
        }
        let guard = Self {
            _input: input,
            observation,
            lease,
        };
        guard.check()?;
        Ok(guard)
    }
    pub fn check(&self) -> Result<(), String> {
        self.lease.check()?;
        let config = super::desktop_control::config()?;
        if config.revision != self.observation.visible.control_revision {
            return Err("desktop_control_config_changed_observe_again".into());
        }
        let current = read_target(Some(self.observation.visible.target.window_id))?;
        super::desktop_control::check_target(&current)?;
        validate_target_mode(
            &self.observation.visible.target,
            &current,
            self.observation.captured.elapsed(),
            self.isolated(),
        )
    }
    pub fn isolated(&self) -> bool { self.observation.visible.input_mode == super::desktop_control::InputMode::Isolated }
    pub fn virtual_point(&self) -> Result<(i32,i32), String> {
        let point = VIRTUAL_POINT.lock().map_err(|_| "desktop_control_pointer_unavailable")?;
        point.as_ref().filter(|point| point.0 == self.target().window_id && point.1 == self.observation.visible.control_revision && point.2 == self.target().process_started && point.5 == self.observation.execution)
            .map(|point| (point.3,point.4)).ok_or("desktop_control_virtual_pointer_required_move_first".into())
    }
    pub fn show_point(&self, x: i32, y: i32) -> Result<(), String> {
        self.point(x,y)?;
        *VIRTUAL_POINT.lock().map_err(|_| "desktop_control_pointer_unavailable")? = Some((self.target().window_id, self.observation.visible.control_revision, self.target().process_started,x,y,self.observation.execution.clone()));
        super::desktop_control::activity(self.target(), Some((x,y)), Some(&self.observation.execution))?;
        self.point(x,y)
    }
    pub fn show_keyboard(&self) -> Result<(), String> {
        self.check()?;
        super::desktop_control::activity(self.target(), self.virtual_point().ok(), Some(&self.observation.execution))?;
        self.check()
    }
    pub fn point(&self, x: i32, y: i32) -> Result<(), String> {
        self.check()?;
        let target = &self.observation.visible.target;
        if i64::from(x) < i64::from(target.x)
            || i64::from(y) < i64::from(target.y)
            || i64::from(x) >= i64::from(target.x) + i64::from(target.width)
            || i64::from(y) >= i64::from(target.y) + i64::from(target.height)
        {
            return Err("Input coordinates are outside the observed window.".into());
        }
        if self.isolated() { Ok(()) } else { point_targets_window(target.window_id, x, y) }
    }
    pub fn current_point(&self) -> Result<(), String> {
        let (x, y) = pointer_position()?;
        self.point(x, y)
    }
}

static VIRTUAL_POINT: Mutex<Option<(u64,u64,u64,i32,i32,ExecutionPermit)>> = Mutex::new(None);

#[cfg(test)]
fn validate_target(
    expected: &WindowTarget,
    current: &WindowTarget,
    age: Duration,
) -> Result<(), String> {
    validate_target_mode(expected, current, age, false)
}

fn validate_target_mode(expected: &WindowTarget, current: &WindowTarget, age: Duration, isolated: bool) -> Result<(), String> {
    if age >= VALID_FOR {
        return Err("Desktop observation expired; observe the target again.".into());
    }
    let mut comparable = current.clone();
    if isolated { comparable.focused = expected.focused; }
    if expected != &comparable || (!isolated && !current.focused) {
        return Err("Desktop focus, window geometry or process changed after observation. No input was sent.".into());
    }
    Ok(())
}

#[cfg(windows)]
fn read_target(requested: Option<u64>) -> Result<WindowTarget, String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, RECT},
        System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        },
    };
    unsafe {
        let foreground = GetForegroundWindow();
        let window = requested
            .map(|id| id as usize as *mut std::ffi::c_void)
            .unwrap_or(foreground);
        if window.is_null()
            || (!super::desktop_control::isolated() && window != foreground)
            || IsIconic(window) != 0
            || IsWindowVisible(window) == 0
        {
            return Err("The selected target must be the visible foreground window; refresh the observation after focusing it.".into());
        }
        let mut process_id = 0;
        if GetWindowThreadProcessId(window, &mut process_id) == 0 || process_id == 0 {
            return Err("Window process identity unavailable.".into());
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if process.is_null() {
            return Err("Window process identity cannot be verified.".into());
        }
        let mut created = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exited = created;
        let mut kernel = created;
        let mut user = created;
        let got_times = GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user);
        CloseHandle(process);
        if got_times == 0 {
            return Err("Window process generation unavailable.".into());
        }
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(window, &mut rect) == 0
            || rect.right <= rect.left
            || rect.bottom <= rect.top
        {
            return Err("Window geometry unavailable.".into());
        }
        // Invisible resize margins extend beyond a maximized monitor. Use the visible frame.
        let _ = windows_sys::Win32::Graphics::Dwm::DwmGetWindowAttribute(window,
            windows_sys::Win32::Graphics::Dwm::DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut rect as *mut RECT as *mut std::ffi::c_void, std::mem::size_of::<RECT>() as u32);
        Ok(WindowTarget {
            window_id: window as usize as u64,
            process_id,
            process_started: (u64::from(created.dwHighDateTime) << 32)
                | u64::from(created.dwLowDateTime),
            x: rect.left,
            y: rect.top,
            width: (i64::from(rect.right) - i64::from(rect.left)) as u32,
            height: (i64::from(rect.bottom) - i64::from(rect.top)) as u32,
            focused: window == foreground,
        })
    }
}

#[cfg(windows)]
fn point_targets_window(window: u64, x: i32, y: i32) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::POINT,
        UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT},
    };
    unsafe {
        let hit = WindowFromPoint(POINT { x, y });
        if hit.is_null() || GetAncestor(hit, GA_ROOT) as usize as u64 != window {
            return Err("The observed window no longer owns the input position.".into());
        }
    }
    Ok(())
}
#[cfg(windows)]
fn pointer_position() -> Result<(i32, i32), String> {
    use windows_sys::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetPhysicalCursorPos};
    let mut point = POINT { x: 0, y: 0 };
    if unsafe { GetPhysicalCursorPos(&mut point) } == 0 {
        return Err("Pointer position unavailable.".into());
    }
    Ok((point.x, point.y))
}
#[cfg(target_os = "linux")]
fn read_target(requested: Option<u64>) -> Result<WindowTarget, String> {
    if super::desktop_control::isolated() {
        return Err("desktop_control_isolated_native_unavailable_use_internal_browser".into());
    }
    super::desktop_linux::read_target(requested)
}
#[cfg(target_os = "linux")]
fn point_targets_window(window: u64, x: i32, y: i32) -> Result<(), String> {
    super::desktop_linux::point_targets_window(window, x, y)
}
#[cfg(target_os = "linux")]
fn pointer_position() -> Result<(i32, i32), String> {
    super::desktop_linux::pointer_position()
}
#[cfg(not(any(windows, target_os = "linux")))]
fn read_target(_: Option<u64>) -> Result<WindowTarget, String> {
    Err("Bound desktop input is currently supported on Windows only.".into())
}
#[cfg(not(any(windows, target_os = "linux")))]
fn point_targets_window(_: u64, _: i32, _: i32) -> Result<(), String> {
    Err("Bound desktop input is unavailable.".into())
}
#[cfg(not(any(windows, target_os = "linux")))]
fn pointer_position() -> Result<(i32, i32), String> {
    Err("Bound desktop input is unavailable.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target() -> WindowTarget {
        WindowTarget {
            window_id: 42,
            process_id: 12,
            process_started: 100,
            x: -10,
            y: 20,
            width: 800,
            height: 600,
            focused: true,
        }
    }
    #[test]
    fn changed_focus_geometry_process_or_age_denies_input() {
        let expected = target();
        assert!(validate_target(&expected, &expected, Duration::from_secs(1)).is_ok());
        assert!(validate_target(&expected, &expected, VALID_FOR).is_err());
        for changed in [
            WindowTarget {
                focused: false,
                ..target()
            },
            WindowTarget { x: 0, ..target() },
            WindowTarget {
                process_id: 13,
                ..target()
            },
            WindowTarget {
                process_started: 101,
                ..target()
            },
        ] {
            assert!(validate_target(&expected, &changed, Duration::from_secs(1)).is_err());
        }
    }
    #[test]
    fn isolated_target_allows_user_focus_elsewhere_but_not_window_or_process_changes() {
        let expected = target();
        let background = WindowTarget { focused: false, ..target() };
        assert!(validate_target_mode(&expected, &background, Duration::from_secs(1), true).is_ok());
        assert!(validate_target_mode(&expected, &background, VALID_FOR, true).is_err());
        assert!(validate_target_mode(&expected, &WindowTarget {x: 0, ..background}, Duration::ZERO, true).is_err());
        assert!(validate_target_mode(&expected, &WindowTarget {process_started: 101, ..target()}, Duration::ZERO, true).is_err());
    }
}
