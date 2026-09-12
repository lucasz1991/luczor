//! One frame from an already consented portal PipeWire connection. No global capture fallback.
//! System helper contracts: GStreamer pngenc(snapshot), fdsink(fd), PipeWire pipewiresrc(fd,path).

use std::io::Read;

const MAX_PNG_BYTES: usize = 8 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const PNG_END: &[u8] = b"\0\0\0\0IEND\xaeB`\x82";

fn pipeline_arguments(node_id: u32, serial: Option<u64>) -> Vec<String> {
    [
        "-q".into(),
        "pipewiresrc".into(),
        "fd=3".into(),
        serial
            .map(|value| format!("target-object={value}"))
            .unwrap_or_else(|| format!("path={node_id}")),
        "num-buffers=1".into(),
        "!".into(),
        "videoconvert".into(),
        "!".into(),
        "pngenc".into(),
        "snapshot=true".into(),
        "!".into(),
        "fdsink".into(),
        "fd=1".into(),
        "sync=false".into(),
    ]
    .into()
}

fn read_png(reader: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(64 * 1024);
    reader
        .take((MAX_PNG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "desktop_portal_capture_read_failed".to_string())?;
    if bytes.len() > MAX_PNG_BYTES {
        return Err("desktop_portal_capture_too_large".into());
    }
    if bytes.len() < 33 || !bytes.starts_with(PNG_SIGNATURE) || !bytes.ends_with(PNG_END) {
        return Err("desktop_portal_capture_png_invalid".into());
    }
    // The caller decodes dimensions and pixels with image::load_from_memory before releasing the observation.
    Ok(bytes)
}

#[cfg(target_os = "linux")]
pub(super) fn capture(
    fd: std::os::fd::OwnedFd,
    node_id: u32,
    serial: Option<u64>,
) -> Result<Vec<u8>, String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    if node_id == 0 || serial == Some(0) {
        return Err("desktop_portal_capture_node_invalid".into());
    }
    // Start the absolute budget before spawn. The remaining second is reserved for kill/reap on failure.
    let deadline = Instant::now() + Duration::from_secs(9);
    let raw_fd = fd.as_raw_fd();
    let mut command = Command::new("/usr/bin/gst-launch-1.0");
    command
        .args(pipeline_arguments(node_id, serial))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GST_DEBUG", "0")
        .env_remove("GST_DEBUG_FILE")
        .env_remove("GST_DEBUG_DUMP_DOT_DIR")
        .env_remove("GST_TRACERS")
        .process_group(0);
    // SAFETY: only async-signal-safe libc calls run after fork. fd stays owned until spawn finishes.
    // It is never accepted from renderer input and is only the descriptor returned by OpenPipeWireRemote.
    unsafe {
        command.pre_exec(move || {
            if raw_fd != 3 && libc::dup2(raw_fd, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let flags = libc::fcntl(3, libc::F_GETFD);
            if flags < 0 || libc::fcntl(3, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "desktop_portal_capture_helper_unavailable".to_string()
        } else {
            "desktop_portal_capture_start_failed".to_string()
        }
    })?;
    drop(fd);
    collect_child(child, deadline)
}

#[cfg(target_os = "linux")]
fn collect_child(
    mut child: std::process::Child,
    deadline: std::time::Instant,
) -> Result<Vec<u8>, String> {
    use std::sync::mpsc::{sync_channel, TryRecvError};
    use std::time::{Duration, Instant};

    fn terminate(child: &mut std::process::Child) {
        // Own process group only; a timed-out GStreamer/plugin helper must not retain the portal FD.
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
        let _ = child.kill();
        let _ = child.wait();
    }

    let Some(stdout) = child.stdout.take() else {
        terminate(&mut child);
        return Err("desktop_portal_capture_stdout_missing".into());
    };
    let (tx, rx) = sync_channel(1);
    let reader = std::thread::Builder::new()
        .name("luczor-portal-frame".into())
        .spawn(move || {
            let _ = tx.send(read_png(stdout));
        });
    if reader.is_err() {
        terminate(&mut child);
        return Err("desktop_portal_capture_read_failed".into());
    }
    let mut png = None;
    loop {
        if Instant::now() >= deadline {
            terminate(&mut child);
            return Err("desktop_portal_capture_timeout".into());
        }
        if png.is_none() {
            match rx.try_recv() {
                Ok(Ok(bytes)) => png = Some(bytes),
                Ok(Err(error)) => {
                    terminate(&mut child);
                    return Err(error);
                }
                Err(TryRecvError::Disconnected) => {
                    terminate(&mut child);
                    return Err("desktop_portal_capture_read_failed".into());
                }
                Err(TryRecvError::Empty) => {}
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => {
                terminate(&mut child);
                return Err("desktop_portal_capture_pipeline_failed".into());
            }
            Ok(Some(_)) if png.is_some() => return Ok(png.take().unwrap_or_default()),
            Err(_) => {
                terminate(&mut child);
                return Err("desktop_portal_capture_wait_failed".into());
            }
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fixed_pipeline_and_numeric_consented_node_are_forwarded() {
        let args = pipeline_arguments(u32::MAX, None);
        assert!(args.contains(&"path=4294967295".to_string()));
        assert!(args.contains(&"fd=3".to_string()));
        assert!(args.contains(&"num-buffers=1".to_string()));
        assert!(args.contains(&"snapshot=true".to_string()));
        assert!(!args
            .iter()
            .any(|arg| arg.contains("http") || arg.contains("location=")));
    }

    #[test]
    fn portal_serial_prevents_reusing_an_unrelated_node_id() {
        let args = pipeline_arguments(42, Some(1234567890123));
        assert!(args.contains(&"target-object=1234567890123".to_string()));
        assert!(!args.iter().any(|arg| arg.starts_with("path=")));
    }

    #[test]
    fn rejects_diagnostics_or_truncated_frames_and_bounds_reader_allocation() {
        assert!(read_png(&b"pipeline error with private details"[..]).is_err());
        assert!(read_png(PNG_SIGNATURE).is_err());
        assert_eq!(
            read_png(std::io::repeat(b'x')).unwrap_err(),
            "desktop_portal_capture_too_large"
        );
        let mut fixture = PNG_SIGNATURE.to_vec();
        fixture.extend_from_slice(&[0; 24]);
        fixture.extend_from_slice(PNG_END);
        assert_eq!(read_png(&fixture[..]).unwrap(), fixture);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stalled_child_is_killed_and_reaped_within_capture_deadline() {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        let child = Command::new("/usr/bin/sleep")
            .arg("10")
            .stdout(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id();
        let start = Instant::now();
        assert_eq!(
            collect_child(child, start + Duration::from_millis(30)).unwrap_err(),
            "desktop_portal_capture_timeout"
        );
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    }
}
