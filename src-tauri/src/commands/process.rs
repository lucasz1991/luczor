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
    command: Command,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<BoundedProcessOutput, String> {
    run_bounded_command_guarded(command, stdin, timeout, max_output_bytes, None)
}

pub(crate) fn run_bounded_command_guarded(
    command: Command,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    max_output_bytes: usize,
    execution: Option<super::execution::ExecutionLease>,
) -> Result<BoundedProcessOutput, String> {
    run_bounded_command_scoped(command, stdin, timeout, max_output_bytes, execution, None)
}

pub(crate) fn run_bounded_command_scoped(
    mut command: Command,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    max_output_bytes: usize,
    execution: Option<super::execution::ExecutionLease>,
    scope_check: Option<&dyn Fn() -> Result<(), String>>,
) -> Result<BoundedProcessOutput, String> {
    let check = || {
        if let Some(gate) = &execution { gate.check()?; }
        if let Some(scope) = scope_check { scope()?; }
        Ok::<(), String>(())
    };
    check()?;
    let deadline = Instant::now() + timeout;
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
    // On Windows the child is still suspended here. Reject a rebinding before resuming it.
    if let Err(error) = check() { terminate_process_tree(&mut child); let _ = child.wait(); return Err(error); }
    #[cfg(windows)]
    let lifetime = match super::codex::LifetimeGuard::attach(&child) {
        Ok(guard) => guard,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    {
        if let Err(error) = check() {
            terminate_process_tree(&mut child);
            let _ = child.wait();
            return Err(error);
        }
    }
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

    let (status, timed_out) = loop {
        if check().is_err() {
            terminate_process_tree(&mut child);
            let _ = child.wait();
            return Err("Execution policy changed; local process stopped.".into());
        }
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

    // Always close the process tree, even when the immediate parent exited
    // successfully. A descendant must not retain inherited pipes indefinitely.
    #[cfg(windows)]
    drop(lifetime);
    #[cfg(not(windows))]
    terminate_process_tree(&mut child);
    let drain_deadline = Instant::now() + Duration::from_secs(2);
    if let Some(handle) = stdin_thread {
        finish_thread(handle, drain_deadline, "stdin")?;
    }
    let stdout = finish_thread(stdout_thread, drain_deadline, "stdout")?;
    let stderr = finish_thread(stderr_thread, drain_deadline, "stderr")?;
    check()?;

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

pub(crate) fn finish_thread<T>(
    handle: thread::JoinHandle<T>,
    deadline: Instant,
    name: &str,
) -> Result<T, String> {
    while !handle.is_finished() {
        if Instant::now() >= deadline {
            return Err(format!(
                "{name} pipe did not close before the process deadline."
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
    handle.join().map_err(|_| format!("{name} worker panicked"))
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
    command.creation_flags(0x0000_0004 | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
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
    // The mandatory Job Object owned by run_bounded_command_guarded closes on
    // every exit and kills all descendants. Never launch an unbounded taskkill
    // helper or address a potentially recycled numeric PID.
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

    #[cfg(windows)]
    #[test]
    fn successful_parent_exit_cannot_leave_descendants_holding_pipes() {
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", "start /B ping 127.0.0.1 -n 20 >NUL"]);
        let started = std::time::Instant::now();
        let output = run_bounded_command(command, None, Duration::from_secs(5), 64).unwrap();
        assert!(!output.timed_out);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn pipe_join_deadline_does_not_wait_for_an_unresponsive_reader() {
        let handle = std::thread::spawn(|| std::thread::sleep(Duration::from_millis(100)));
        let started = std::time::Instant::now();
        assert!(
            super::finish_thread(handle, started + Duration::from_millis(5), "fixture").is_err()
        );
        assert!(started.elapsed() < Duration::from_millis(90));
    }

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
