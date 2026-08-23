use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub(crate) struct BoundedProcessOutput {
    pub success: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
}

struct CapturedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

/// Execute a child in its own process group and keep draining both pipes while
/// retaining only the configured number of bytes. On timeout the full process
/// tree is terminated, so grandchildren cannot keep running or keep pipes open.
pub(crate) fn run_bounded_command(
    mut command: Command,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<BoundedProcessOutput, String> {
    configure_child_process(&mut command);
    command
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn failed: {error}"))?;
    let stdout = child.stdout.take().ok_or("child stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("child stderr is unavailable")?;
    let stdout_thread = thread::spawn(move || drain_bounded(stdout, max_output_bytes));
    let stderr_thread = thread::spawn(move || drain_bounded(stderr, max_output_bytes));
    let stdin_thread = stdin.map(|bytes| {
        let mut child_stdin = child.stdin.take();
        thread::spawn(move || {
            if let Some(ref mut writer) = child_stdin {
                let _ = writer.write_all(&bytes);
                let _ = writer.flush();
            }
        })
    });

    let deadline = Instant::now() + timeout;
    let (status, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status, false),
            Ok(None) if Instant::now() >= deadline => {
                terminate_process_tree(&mut child);
                let status = child
                    .wait()
                    .map_err(|error| format!("wait after timeout failed: {error}"))?;
                break (status, true);
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(error) => {
                terminate_process_tree(&mut child);
                let _ = child.wait();
                return Err(format!("wait failed: {error}"));
            }
        }
    };

    if let Some(handle) = stdin_thread {
        let _ = handle.join();
    }
    let stdout = stdout_thread.join().map_err(|_| "stdout reader panicked")?;
    let stderr = stderr_thread.join().map_err(|_| "stderr reader panicked")?;

    Ok(BoundedProcessOutput {
        success: status.success() && !timed_out,
        code: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        timed_out,
    })
}

fn drain_bounded(mut reader: impl Read, max_bytes: usize) -> CapturedOutput {
    let mut retained = Vec::with_capacity(max_bytes.min(16 * 1024));
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let remaining = max_bytes.saturating_sub(retained.len());
                let keep = remaining.min(read);
                retained.extend_from_slice(&buffer[..keep]);
                truncated |= keep < read;
            }
        }
    }
    CapturedOutput {
        bytes: retained,
        truncated,
    }
}

#[cfg(windows)]
fn configure_child_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn configure_child_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(any(windows, unix)))]
fn configure_child_process(_command: &mut Command) {}

#[cfg(windows)]
fn terminate_process_tree(child: &mut Child) {
    let mut taskkill = Command::new("taskkill.exe");
    taskkill
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_child_process(&mut taskkill);
    let _ = taskkill.status();
    let _ = child.kill();
}

#[cfg(unix)]
fn terminate_process_tree(child: &mut Child) {
    let _ = Command::new("kill")
        .args(["-KILL", "--", &format!("-{}", child.id())])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

#[cfg(not(any(windows, unix)))]
fn terminate_process_tree(child: &mut Child) {
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::run_bounded_command;
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[test]
    fn process_output_is_bounded_while_the_pipe_is_fully_drained() {
        let command = noisy_command();
        let output = run_bounded_command(command, None, Duration::from_secs(5), 64)
            .expect("bounded process must run");

        assert!(output.success);
        assert_eq!(output.stdout.len(), 64);
        assert!(output.stdout_truncated);
    }

    #[test]
    fn process_timeout_returns_promptly() {
        let command = slow_command();
        let started = Instant::now();
        let output = run_bounded_command(command, None, Duration::from_millis(150), 64)
            .expect("timed process must return");

        assert!(output.timed_out);
        assert!(!output.success);
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[cfg(windows)]
    fn noisy_command() -> Command {
        let mut command = Command::new("cmd.exe");
        command.args([
            "/D",
            "/S",
            "/C",
            "for /L %i in (1,1,100) do @echo 1234567890",
        ]);
        command
    }

    #[cfg(unix)]
    fn noisy_command() -> Command {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "i=0; while [ $i -lt 100 ]; do echo 1234567890; i=$((i+1)); done",
        ]);
        command
    }

    #[cfg(windows)]
    fn slow_command() -> Command {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", "ping 127.0.0.1 -n 6 >NUL"]);
        command
    }

    #[cfg(unix)]
    fn slow_command() -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 5"]);
        command
    }
}
