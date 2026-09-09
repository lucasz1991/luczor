//! Bounded asynchronous socket ownership behind the synchronous SSE parser.
//! Bytes alone are not progress: only parsed generation metadata/deltas renew
//! the idle deadline. Dropping this reader settles the socket task first.
use serde_json::Value;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub(super) struct Deadlines {
    pub first: Duration,
    pub idle: Duration,
    pub total: Duration,
}
pub(super) struct Progress {
    started: Instant,
    last: Option<Instant>,
    generated: u64,
}
impl Progress {
    pub fn observe(&mut self, value: &Value) {
        let generated = value
            .pointer("/timings/predicted_n")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let delta = value.pointer("/choices/0/delta");
        let content = delta.is_some_and(|d| {
            ["content", "reasoning_content"].iter().any(|key| {
                d.get(key)
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
            }) || d
                .get("tool_calls")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty())
        });
        if generated > self.generated || content {
            self.last = Some(Instant::now());
        }
        self.generated = self.generated.max(generated);
    }
    fn expired(&self, limits: Deadlines) -> Option<&'static str> {
        if self.started.elapsed() >= limits.total {
            Some("Local generation exceeded its total deadline.")
        } else if self.last.is_none() && self.started.elapsed() >= limits.first {
            Some("Local generation produced no first progress before its deadline.")
        } else if self.last.is_some_and(|last| last.elapsed() >= limits.idle) {
            Some("Local generation stopped making progress before its idle deadline.")
        } else {
            None
        }
    }
}
enum Part {
    Status(u16),
    Bytes(Vec<u8>),
    End,
    Failed(String),
}
pub(super) struct Stream {
    receiver: tauri::async_runtime::Receiver<Part>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    pub progress: Arc<Mutex<Progress>>,
    cancel: Arc<AtomicBool>,
    limits: Deadlines,
    buffer: std::io::Cursor<Vec<u8>>,
    ended: bool,
}
impl Drop for Stream {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = tauri::async_runtime::block_on(task);
        }
    }
}
impl Stream {
    pub fn open(
        port: u16,
        key: &str,
        body: Vec<u8>,
        cancel: Arc<AtomicBool>,
        limits: Deadlines,
        max_bytes: usize,
    ) -> Result<(u16, Self), String> {
        let request = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(limits.total)
            .pool_max_idle_per_host(0)
            .build()
            .map_err(|_| "Local generation HTTP client is unavailable.")?
            .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .bearer_auth(key)
            .header("Content-Type", "application/json")
            .body(body);
        let (sender, receiver) = tauri::async_runtime::channel(4);
        let task = tauri::async_runtime::spawn(async move {
            let result: Result<(), String> = async {
                let mut response = super::local_network::send_async(request).await?;
                sender
                    .send(Part::Status(response.status()))
                    .await
                    .map_err(|_| "Local generation reader closed.")?;
                let mut received = 0usize;
                while let Some(chunk) = response.chunk().await? {
                    received = received.saturating_add(chunk.len());
                    if received > max_bytes {
                        return Err("Local generation exceeded its native size limit.".into());
                    }
                    for part in chunk.chunks(32 * 1024) {
                        sender
                            .send(Part::Bytes(part.to_vec()))
                            .await
                            .map_err(|_| "Local generation reader closed.")?;
                    }
                }
                Ok(())
            }
            .await;
            let _ = sender
                .send(match result {
                    Ok(()) => Part::End,
                    Err(e) => Part::Failed(e),
                })
                .await;
        });
        let mut stream = Self {
            receiver,
            task: Some(task),
            progress: Arc::new(Mutex::new(Progress {
                started: Instant::now(),
                last: None,
                generated: 0,
            })),
            cancel,
            limits,
            buffer: std::io::Cursor::new(Vec::new()),
            ended: false,
        };
        match stream.next()? {
            Part::Status(status) => Ok((status, stream)),
            _ => Err("Local generation returned no HTTP status.".into()),
        }
    }
    fn check(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err("Local inference was cancelled.".into());
        }
        if let Some(error) = self
            .progress
            .lock()
            .map_err(|_| "Local progress is unavailable.")?
            .expired(self.limits)
        {
            return Err(error.into());
        }
        Ok(())
    }
    fn next(&mut self) -> Result<Part, String> {
        loop {
            self.check()?;
            match self.receiver.try_recv() {
                Ok(Part::Failed(error)) => return Err(error),
                Ok(part) => return Ok(part),
                Err(_) if !self.receiver.is_closed() => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(_) => return Err("Local generation HTTP task ended unexpectedly.".into()),
            }
        }
    }
}
impl Read for Stream {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        loop {
            self.check().map_err(io::Error::other)?;
            let count = self.buffer.read(output)?;
            if count > 0 || self.ended {
                return Ok(count);
            }
            match self.next().map_err(io::Error::other)? {
                Part::Bytes(bytes) => self.buffer = std::io::Cursor::new(bytes),
                Part::End => self.ended = true,
                _ => {
                    return Err(io::Error::other(
                        "Local generation stream state is invalid.",
                    ))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::{TcpListener, TcpStream};
    fn request(socket: &mut TcpStream) {
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut buf = [0; 1024];
            let n = socket.read(&mut buf).unwrap();
            assert!(n > 0 && bytes.len() + n < 8192);
            bytes.extend_from_slice(&buf[..n]);
            if bytes
                .windows(4)
                .position(|p| p == b"\r\n\r\n")
                .is_some_and(|end| bytes.len() >= end + 6)
            {
                break;
            }
        }
        assert!(bytes.starts_with(b"POST /v1/chat/completions HTTP/1.1"));
    }
    fn closed(socket: &mut TcpStream) {
        let result = socket.read(&mut [0]);
        assert!(
            matches!(result, Ok(0))
                || result.is_err_and(|e| matches!(
                    e.kind(),
                    io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
                ))
        );
    }
    fn limits() -> Deadlines {
        Deadlines {
            first: Duration::from_millis(180),
            idle: Duration::from_millis(180),
            total: Duration::from_secs(3),
        }
    }
    #[test]
    fn first_progress_timeout_drops_the_real_socket_after_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            request(&mut socket);
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            closed(&mut socket);
        });
        let (_, mut response) = Stream::open(
            port,
            "fixture-key",
            b"{}".to_vec(),
            Arc::new(AtomicBool::new(false)),
            limits(),
            4096,
        )
        .unwrap();
        let error = response.read_to_end(&mut Vec::new()).unwrap_err();
        assert!(error.to_string().contains("first progress"));
        drop(response);
        server.join().unwrap();
    }
    #[test]
    fn prefill_cancellation_closes_http_without_runtime_access() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            request(&mut socket);
            signal.store(true, Ordering::SeqCst);
            closed(&mut socket);
        });
        let error = Stream::open(port, "fixture-key", b"{}".to_vec(), cancel, limits(), 4096)
            .err()
            .unwrap();
        assert!(error.contains("cancelled"));
        server.join().unwrap();
    }
    #[test]
    fn progress_can_continue_beyond_first_deadline_without_total_timeout_confusion() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            request(&mut socket);
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            for _ in 0..6 {
                socket.write_all(b"1\r\nx\r\n").unwrap();
                std::thread::sleep(Duration::from_millis(70));
            }
            socket.write_all(b"0\r\n\r\n").unwrap();
        });
        let (_, mut response) = Stream::open(
            port,
            "fixture-key",
            b"{}".to_vec(),
            Arc::new(AtomicBool::new(false)),
            limits(),
            4096,
        )
        .unwrap();
        let start = Instant::now();
        let mut count = 0;
        while response.read(&mut [0]).unwrap() > 0 {
            count += 1;
            response
                .progress
                .lock()
                .unwrap()
                .observe(&serde_json::json!({"timings":{"predicted_n":count}}));
        }
        assert_eq!(count, 6);
        assert!(start.elapsed() > limits().first);
        drop(response);
        server.join().unwrap();
    }
    #[test]
    fn byte_limit_is_independent_of_text_and_queue_limits() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            request(&mut socket);
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\n12345678901234567890").unwrap();
        });
        let (_, mut response) = Stream::open(
            port,
            "fixture-key",
            b"{}".to_vec(),
            Arc::new(AtomicBool::new(false)),
            limits(),
            10,
        )
        .unwrap();
        assert!(response
            .read_to_end(&mut Vec::new())
            .unwrap_err()
            .to_string()
            .contains("size limit"));
        drop(response);
        server.join().unwrap();
    }
    #[test]
    fn empty_metadata_does_not_renew_idle_and_real_progress_cannot_extend_total_deadline() {
        let mut p = Progress {
            started: Instant::now() - Duration::from_secs(2),
            last: None,
            generated: 0,
        };
        p.observe(&serde_json::json!({"choices":[{"delta":{"role":"assistant","content":""}}],"timings":{"predicted_n":0}}));
        assert!(p.last.is_none());
        assert!(p.expired(limits()).unwrap().contains("first progress"));
        p.observe(&serde_json::json!({"timings":{"predicted_n":1}}));
        assert!(p.expired(limits()).is_none());
        p.last = Some(Instant::now() - Duration::from_secs(1));
        assert!(p.expired(limits()).unwrap().contains("idle deadline"));
        p.started = Instant::now() - Duration::from_secs(4);
        p.observe(&serde_json::json!({"timings":{"predicted_n":2}}));
        assert!(p.expired(limits()).unwrap().contains("total deadline"));
    }
}
