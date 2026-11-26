//! Detects that the package manager replaced or removed the running program.
//!
//! A Debian upgrade swaps `/usr/bin/<binary>` while a tray-hidden instance keeps
//! running the previous file. Nothing is terminated from outside: the renderer
//! shows the state and the user decides when to restart through the ordinary
//! graceful quit path.

use std::sync::atomic::{AtomicBool, Ordering};

#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FileIdentity {
    pub device: u64,
    pub inode: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallState {
    Unchanged,
    Replaced,
    Removed,
}

/// `installed` is the file currently at the startup path, if one exists.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub(crate) fn classify(running: FileIdentity, installed: Option<FileIdentity>) -> InstallState {
    match installed {
        None => InstallState::Removed,
        Some(identity) if identity == running => InstallState::Unchanged,
        Some(_) => InstallState::Replaced,
    }
}

/// The kernel appends this marker once the running file has been unlinked.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub(crate) fn startup_path(reported: &str) -> &str {
    reported.strip_suffix(" (deleted)").unwrap_or(reported)
}

static RESTART_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "linux")]
mod platform {
    use super::{classify, startup_path, FileIdentity, InstallState};
    use std::os::unix::fs::MetadataExt;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    static STARTUP_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

    fn identity(path: &std::path::Path) -> std::io::Result<FileIdentity> {
        let metadata = std::fs::metadata(path)?;
        Ok(FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }

    pub fn path() -> Option<&'static PathBuf> {
        STARTUP_PATH
            .get_or_init(|| {
                let reported = std::env::current_exe().ok()?;
                let path = PathBuf::from(startup_path(reported.to_str()?));
                path.is_absolute().then_some(path)
            })
            .as_ref()
    }

    pub fn state() -> InstallState {
        // Development builds are rebuilt in place by Cargo; only packages count.
        if cfg!(debug_assertions) {
            return InstallState::Unchanged;
        }
        let Some(path) = path() else {
            return InstallState::Unchanged;
        };
        // `/proc/self/exe` still resolves to the running file after an unlink.
        let Ok(running) = identity(std::path::Path::new("/proc/self/exe")) else {
            return InstallState::Unchanged;
        };
        match identity(path) {
            Ok(installed) => classify(running, Some(installed)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => classify(running, None),
            // An unreadable path is not evidence of an update.
            Err(_) => InstallState::Unchanged,
        }
    }

    /// Starts the newly installed program once this process has ended, so the
    /// single-instance guard of the new process does not see the old one.
    pub fn relaunch() {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        let Some(path) = path() else { return };
        const WAIT_THEN_START: &str =
            "i=0; while kill -0 \"$1\" 2>/dev/null && [ \"$i\" -lt 150 ]; \
             do sleep 0.2; i=$((i+1)); done; exec \"$2\"";
        let result = Command::new("/bin/sh")
            .arg("-c")
            .arg(WAIT_THEN_START)
            .arg("luczor-relaunch")
            .arg(std::process::id().to_string())
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn();
        if let Err(error) = result {
            eprintln!("[luczor] Neustart nach Aktualisierung nicht möglich: {error}");
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use super::InstallState;

    // The Windows installer closes the running app itself; macOS replaces the bundle.
    pub fn state() -> InstallState {
        InstallState::Unchanged
    }
    pub fn relaunch() {}
}

pub(crate) fn state() -> InstallState {
    platform::state()
}

/// Called from the worker tick; reports only a change since the last probe.
pub(crate) fn changed_state(previous: &mut InstallState) -> Option<InstallState> {
    let current = state();
    if current == *previous {
        return None;
    }
    *previous = current;
    Some(current)
}

/// Runs when the event loop has ended and all owned processes are stopped.
pub(crate) fn relaunch_if_requested() {
    if RESTART_REQUESTED.swap(false, Ordering::AcqRel) {
        platform::relaunch();
    }
}

#[tauri::command]
pub fn app_install_state(window: super::CallerWebview) -> Result<InstallState, String> {
    super::ensure_main_webview(&window)?;
    Ok(state())
}

#[tauri::command]
pub fn app_restart_after_update(
    app: tauri::AppHandle,
    window: super::CallerWebview,
) -> Result<(), String> {
    super::ensure_main_webview(&window)?;
    if state() != InstallState::Replaced {
        return Err("app_restart_not_available".into());
    }
    RESTART_REQUESTED.store(true, Ordering::Release);
    crate::request_app_quit(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNNING: FileIdentity = FileIdentity {
        device: 2049,
        inode: 100,
    };

    #[test]
    fn same_file_is_unchanged() {
        assert_eq!(classify(RUNNING, Some(RUNNING)), InstallState::Unchanged);
    }

    #[test]
    fn another_inode_or_device_at_the_startup_path_is_a_replacement() {
        for installed in [
            FileIdentity {
                inode: 101,
                ..RUNNING
            },
            FileIdentity {
                device: 2050,
                ..RUNNING
            },
        ] {
            assert_eq!(classify(RUNNING, Some(installed)), InstallState::Replaced);
        }
    }

    #[test]
    fn missing_file_is_a_removal_not_an_update() {
        assert_eq!(classify(RUNNING, None), InstallState::Removed);
    }

    #[test]
    fn unlinked_marker_is_stripped_from_the_startup_path_only_as_a_suffix() {
        assert_eq!(
            startup_path("/usr/bin/tauri-app (deleted)"),
            "/usr/bin/tauri-app"
        );
        assert_eq!(startup_path("/usr/bin/tauri-app"), "/usr/bin/tauri-app");
        assert_eq!(startup_path("/opt/a (deleted)/app"), "/opt/a (deleted)/app");
    }

    #[test]
    fn a_change_is_reported_once() {
        let mut previous = InstallState::Replaced;
        // Tests run as a debug build or on a host without package replacement.
        assert_eq!(changed_state(&mut previous), Some(InstallState::Unchanged));
        assert_eq!(changed_state(&mut previous), None);
    }

    #[test]
    fn states_use_the_renderer_contract_names() {
        for (state, name) in [
            (InstallState::Unchanged, "\"unchanged\""),
            (InstallState::Replaced, "\"replaced\""),
            (InstallState::Removed, "\"removed\""),
        ] {
            assert_eq!(serde_json::to_string(&state).unwrap(), name);
        }
    }
}
