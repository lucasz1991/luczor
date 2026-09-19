//! Bounded asynchronous socket ownership behind the synchronous SSE parser.
//! Bytes alone are not progress: only parsed generation metadata/deltas renew
//! the idle deadline. Dropping this reader settles the socket task first.
use serde_json::Value;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub(super) const FIRST_PROGRESS_TIMEOUT: &str =
    "Local generation produced no first progress before its deadline.";
pub(super) const PROGRESS_TIMEOUT: &str =
    "Local generation stopped making progress before its idle deadline.";
pub(super) const TOTAL_TIMEOUT: &str = "Local generation exceeded its total deadline.";

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
            Some(TOTAL_TIMEOUT)
        } else if self.last.is_none() && self.started.elapsed() >= limits.first {
            Some(FIRST_PROGRESS_TIMEOUT)
        } else if self.last.is_some_and(|last| last.elapsed() >= limits.idle) {
            Some(PROGRESS_TIMEOUT)
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
    reasoning_interruption: Arc<AtomicBool>,
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
        reasoning_interruption: Arc<AtomicBool>,
        limits: Deadlines,
        max_bytes: usize,
    ) -> Result<(u16, Self), String> {
        if cancel.load(Ordering::SeqCst) {
            return Err("Local inference was cancelled.".into());
        }
        if reasoning_interruption.load(Ordering::SeqCst) {
            return Err(super::reasoning_budget::CONTROL_UNAVAILABLE.into());
        }
        // Start before the HTTP client: a transport's total timeout must not
        // race ahead of the same, explicitly classified generation deadline.
        let started = Instant::now();
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
                started,
                last: None,
                generated: 0,
            })),
            cancel,
            reasoning_interruption,
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
        if self.reasoning_interruption.load(Ordering::SeqCst) {
            return Err(super::reasoning_budget::CONTROL_UNAVAILABLE.into());
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
    #[test]
    fn repetition_guard_handles_fragmented_unicode_sentences_and_short_closings() {
        for phrase in [
            "Fertig. Warte auf deine Anweisung. ",
            "Prüfung abgeschlossen. Grüße aus Köln!\n",
            "Done. ",
        ] {
            let mut guard = super::super::generation_safety::RepetitionGuard::default();
            assert!(guard
                .observe("Ein hilfreicher, einmaliger Zwischenstand.\n")
                .is_none());
            let repeated = phrase.repeat(100);
            let mut detected = false;
            for ch in repeated.chars() {
                if guard.observe(&ch.to_string()).is_some() {
                    detected = true;
                    break;
                }
            }
            assert!(detected, "{phrase}");
        }
    }

    #[test]
    fn repetition_guard_keeps_normal_code_tables_and_nonconsecutive_refrains() {
        let phrase = "Fertig. Warte auf deine Anweisung.\n";
        for input in [
            format!("```text\n{}```\nEine normale Antwort.", phrase.repeat(100)),
            format!("~~~text\n{}~~~\nEine normale Antwort.", phrase.repeat(100)),
            "    console.log('repeat');\n".repeat(100),
            "| Status | Erledigt |\n".repeat(100),
            "{\"status\":\"waiting\"}\n".repeat(100),
            (0..100)
                .map(|n| {
                    format!("{phrase}Ein neuer Abschnitt mit eigenem Inhalt und Nummer {n}.\n")
                })
                .collect(),
        ] {
            let mut guard = super::super::generation_safety::RepetitionGuard::default();
            for ch in input.chars() {
                assert!(guard.observe(&ch.to_string()).is_none());
            }
        }
        let mut guard = super::super::generation_safety::RepetitionGuard::default();
        for chunk in ["`", "``js\ncode\n`", "`", "`\n"] {
            assert!(guard.observe(chunk).is_none());
        }
        assert!(guard.observe(&phrase.repeat(100)).is_some());
    }
    #[test]
    fn repetition_guard_bounds_empty_generation_but_preserves_fenced_whitespace() {
        for text in ["\n".repeat(600), "⏎\n".repeat(300)] {
            let mut guard = super::super::generation_safety::RepetitionGuard::default();
            assert!(guard.observe(&text).is_some());
        }
        let mut guard = super::super::generation_safety::RepetitionGuard::default();
        assert!(guard
            .observe(&format!("```text\n{}```", "\n".repeat(600)))
            .is_none());
    }
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

    fn idle_request() -> super::super::LocalInferenceRequest {
        serde_json::from_value(serde_json::json!({
            "requestId":"idle-test","scopeDigest":"a".repeat(64),"modelReleaseId":"synthetic-model","useCase":"context.optimize",
            "catalogBinding":{"acceptanceSessionId":"00000000-0000-4000-8000-000000000001","acceptanceGeneration":1,"manifestPayloadSha256":"b".repeat(64)},
            "messages":[{"role":"user","content":"synthetic bounded portion"}],"tools":[],"toolChoice":"none","reasoningMode":"off","maxOutputTokens":768
        })).unwrap()
    }

    #[test]
    fn idle_completion_observes_each_delta_before_finish_and_can_outlast_first_progress_deadline() {
        use serde_json::json;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (delta_tx, delta_rx) = std::sync::mpsc::sync_channel(1);
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            request(&mut socket);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let first = json!({"choices":[{"delta":{"content":"{"}}]});
            write!(socket, "data: {first}\n\n").unwrap();
            // A full-body buffer cannot pass: the first public delta must be
            // observed while the server is still holding the stream open.
            delta_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            for index in 0..8 {
                std::thread::sleep(Duration::from_millis(100));
                let value = json!({"timings":{"predicted_n":index + 2},"choices":[{"delta":{"content":" "}}]});
                write!(socket, "data: {value}\n\n").unwrap();
            }
            let finish = json!({"choices":[{"delta":{"content":"}"},"finish_reason":"stop"}]});
            write!(socket, "data: {finish}\n\ndata: [DONE]\n\n").unwrap();
        });
        let once = AtomicBool::new(false);
        let channel = tauri::ipc::Channel::new(move |_| {
            if !once.swap(true, Ordering::SeqCst) {
                delta_tx.send(()).unwrap();
            }
            Ok(())
        });
        let limits = Deadlines {
            first: Duration::from_millis(500),
            idle: Duration::from_millis(500),
            total: Duration::from_secs(3),
        };
        let started = Instant::now();
        let result = super::super::stream_idle_completion(
            port,
            "synthetic-key",
            b"{}".to_vec(),
            &idle_request(),
            Arc::new(AtomicBool::new(false)),
            &channel,
            limits,
        )
        .unwrap();
        assert_eq!(result.content, format!("{{{}}}", " ".repeat(8)));
        assert!(started.elapsed() > limits.first);
        assert_eq!(result.finish_reason, "stop");
        server.join().unwrap();
    }

    #[test]
    fn idle_stalled_generation_reports_exact_stage_and_drops_socket_before_returning() {
        for progressed in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                request(&mut socket);
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").unwrap();
                if progressed {
                    write!(
                        socket,
                        "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{{\"}}}}]}}\n\n"
                    )
                    .unwrap();
                }
                closed(&mut socket);
            });
            let failure = super::super::stream_idle_completion(
                port,
                "synthetic-key",
                b"{}".to_vec(),
                &idle_request(),
                Arc::new(AtomicBool::new(false)),
                &tauri::ipc::Channel::new(|_| Ok(())),
                limits(),
            )
            .err()
            .unwrap();
            assert_eq!(
                failure.code,
                if progressed {
                    "runtime_progress_timeout"
                } else {
                    "runtime_first_progress_timeout"
                }
            );
            assert!(failure.preserves_runtime_for_use_case("context.optimize"));
            assert!(!failure.preserves_runtime_for_use_case("chat"));
            server.join().unwrap();
        }
    }

    #[test]
    fn idle_deadlines_remain_bounded_and_are_not_transport_failure_evidence() {
        let deadlines = super::super::idle_generation_deadlines(1200).unwrap();
        assert_eq!(deadlines.first, Duration::from_secs(12));
        assert_eq!(deadlines.idle, Duration::from_secs(12));
        assert_eq!(deadlines.total, Duration::from_secs(120));
        let maximum = super::super::idle_generation_deadlines(u64::MAX).unwrap();
        assert_eq!(maximum.first, Duration::from_secs(120));
        assert_eq!(maximum.total, Duration::from_secs(120));
        for (message, code) in [
            (FIRST_PROGRESS_TIMEOUT, "runtime_first_progress_timeout"),
            (PROGRESS_TIMEOUT, "runtime_progress_timeout"),
            (TOTAL_TIMEOUT, "runtime_total_timeout"),
        ] {
            let failure = super::super::LocalInferenceFailure::from(message);
            assert_eq!(failure.code, code);
            assert!(failure.preserves_runtime_for_use_case("context.optimize"));
            assert!(!failure.preserves_runtime_for_use_case("chat"));
        }
        let transport = super::super::LocalInferenceFailure::from("Local HTTP connection failed.");
        assert_eq!(transport.code, "runtime_stream_failed");
        assert!(!transport.preserves_runtime_for_use_case("context.optimize"));
    }

    #[test]
    fn already_cancelled_generation_never_opens_a_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let error = Stream::open(
            listener.local_addr().unwrap().port(),
            "synthetic-key",
            b"{}".to_vec(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(AtomicBool::new(false)),
            limits(),
            4096,
        )
        .err()
        .unwrap();
        assert!(error.contains("cancelled"));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    }
    #[test]
    fn repeated_generation_closes_owned_http_stream_before_returning_failure() {
        use serde_json::json;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            request(&mut socket);
            let data = json!({"choices":[{"delta":{"content":"Fertig. Warte auf deine Anweisung. ".repeat(80)}}]});
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {data}\n\n").unwrap();
            closed(&mut socket);
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let (status, response) = Stream::open(
            port,
            "synthetic-key",
            b"{}".to_vec(),
            cancel.clone(),
            Arc::new(AtomicBool::new(false)),
            limits(),
            16384,
        )
        .unwrap();
        assert_eq!(status, 200);
        let input = serde_json::from_value(json!({
            "requestId":"synthetic-round","scopeDigest":"a".repeat(64),"modelReleaseId":"synthetic-model","useCase":"chat",
            "catalogBinding":{"acceptanceSessionId":"00000000-0000-4000-8000-000000000001","acceptanceGeneration":1,"manifestPayloadSha256":"b".repeat(64)},
            "messages":[],"tools":[],"toolChoice":"none","reasoningMode":"off"
        })).unwrap();
        let channel = tauri::ipc::Channel::new(|_| Ok(()));
        let result = super::super::parse_sse(response, &input, cancel.clone(), &channel);
        let failure = result.err().unwrap();
        assert_eq!(failure.code, "runtime_output_repeated");
        assert!(!cancel.load(Ordering::SeqCst)); // not misreported as a user cancellation
        server.join().unwrap();
    }

    #[test]
    fn generation_rejection_preserves_bounded_json_body_for_diagnostics() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let body = br#"{"error":{"code":400,"type":"invalid_request_error","message":"Invalid type for 'enable_thinking'"}}"#;
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            request(&mut socket);
            // A real HTTP rejection has a JSON body, not SSE. Fragment it to
            // exercise the asynchronous reader through the native classifier.
            write!(socket, "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
            for chunk in body.chunks(13) {
                write!(socket, "{:x}\r\n", chunk.len()).unwrap();
                socket.write_all(chunk).unwrap();
                socket.write_all(b"\r\n").unwrap();
            }
            socket.write_all(b"0\r\n\r\n").unwrap();
        });
        let (status, response) = Stream::open(
            port,
            "fixture-key",
            b"{}".to_vec(),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            Deadlines {
                first: Duration::from_secs(3),
                ..limits()
            },
            4096,
        )
        .unwrap();
        let failure = super::super::llama_http_failure(status, response);
        let diagnostic = serde_json::to_value(&failure.diagnostic).unwrap();
        assert_eq!(status, 400);
        assert_eq!(diagnostic["parameter"], "enable_thinking");
        assert_eq!(diagnostic["reason"], "parameter_type");
        assert!(failure.preserves_resident_runtime());
        assert!(!diagnostic.to_string().contains("Invalid type"));
        server.join().unwrap();
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
        let error = Stream::open(
            port,
            "fixture-key",
            b"{}".to_vec(),
            cancel,
            Arc::new(AtomicBool::new(false)),
            limits(),
            4096,
        )
        .err()
        .unwrap();
        assert!(error.contains("cancelled"));
        server.join().unwrap();
    }
    #[test]
    fn control_failure_closes_stalled_socket_without_cancelling_model_operation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = Arc::new(AtomicBool::new(false));
        let interruption = Arc::new(AtomicBool::new(false));
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
            cancel.clone(),
            interruption.clone(),
            limits(),
            4096,
        )
        .unwrap();
        interruption.store(true, Ordering::SeqCst);
        let error = super::super::read_bounded_line(
            &mut std::io::BufReader::new(&mut response),
            &mut Vec::new(),
            4096,
        )
        .unwrap_err();
        assert_eq!(error, super::super::reasoning_budget::CONTROL_UNAVAILABLE);
        assert!(!cancel.load(Ordering::SeqCst));
        drop(response);
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
