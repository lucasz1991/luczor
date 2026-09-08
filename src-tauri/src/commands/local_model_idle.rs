//! Bounded, preemptible HTTP for idle context optimization only. The caller
//! supplies the already verified private loopback runtime, never a renderer URL.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::time::Duration;

pub(super) enum Endpoint {
    InputTokens,
    Completion,
}

impl Endpoint {
    fn path(&self) -> &'static str {
        match self {
            Self::InputTokens => "/v1/chat/completions/input_tokens",
            Self::Completion => "/v1/chat/completions",
        }
    }
}

pub(super) fn post(
    port: u16,
    api_key: &str,
    endpoint: Endpoint,
    body: Vec<u8>,
    cancel: &AtomicBool,
    timeout: Duration,
    max_bytes: usize,
) -> Result<(u16, Vec<u8>), String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Local background inference was cancelled.".into());
    }
    let request = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(timeout.min(Duration::from_secs(60)))
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|_| "Local background HTTP client is unavailable.")?
        .post(format!("http://127.0.0.1:{port}{}", endpoint.path()))
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .body(body);
    let (sender, receiver) = sync_channel(1);
    let task = tauri::async_runtime::spawn(async move {
        let result = super::local_network::send_async_bounded(request, max_bytes).await;
        let _ = sender.send(result);
    });
    loop {
        if cancel.load(Ordering::SeqCst) {
            task.abort();
            // The request lease is released only after the HTTP future and its
            // socket/response have actually been dropped, never on flag alone.
            let _ = tauri::async_runtime::block_on(task);
            return Err("Local background inference was cancelled.".into());
        }
        match receiver.recv_timeout(Duration::from_millis(25)) {
            Ok(result) => {
                tauri::async_runtime::block_on(task)
                    .map_err(|_| "Local background HTTP task did not settle.")?;
                return if cancel.load(Ordering::SeqCst) {
                    Err("Local background inference was cancelled.".into())
                } else {
                    result
                };
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                let _ = tauri::async_runtime::block_on(task);
                return Err("Local background HTTP task stopped unexpectedly.".into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{mpsc::channel, Arc};
    use std::time::Instant;

    fn read_request(socket: &mut TcpStream) {
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 1024];
        loop {
            let count = socket.read(&mut buffer).unwrap();
            assert!(count > 0 && bytes.len() < 8192);
            bytes.extend_from_slice(&buffer[..count]);
            if bytes
                .windows(4)
                .position(|part| part == b"\r\n\r\n")
                .is_some_and(|end| bytes.len() >= end + 6)
            {
                break;
            }
        }
        assert!(bytes.starts_with(b"POST /v1/chat/completions"));
    }

    fn cancellation_closes_socket(after_headers: bool) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (ready_tx, ready_rx) = channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            read_request(&mut socket);
            if after_headers {
                socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\none\r\n").unwrap();
                socket.flush().unwrap();
            }
            ready_tx.send(()).unwrap();
            // Header/prefill or body generation is stalled. The HTTP task must
            // release its actual socket; a cancellation flag alone cannot pass.
            let ended = socket.read(&mut [0; 1]);
            assert!(
                matches!(ended, Ok(0))
                    || ended.is_err_and(|error| {
                        matches!(
                            error.kind(),
                            std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionAborted
                        )
                    })
            );
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let task_cancel = cancel.clone();
        let inference = std::thread::spawn(move || {
            post(
                port,
                "synthetic-private-key",
                Endpoint::Completion,
                b"{}".to_vec(),
                &task_cancel,
                Duration::from_secs(30),
                8192,
            )
        });
        ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let started = Instant::now();
        cancel.store(true, Ordering::SeqCst);
        assert!(inference.join().unwrap().unwrap_err().contains("cancelled"));
        server.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn idle_cancel_drops_http_during_prefill_before_headers() {
        cancellation_closes_socket(false);
    }

    #[test]
    fn idle_cancel_drops_http_during_stalled_response_body() {
        cancellation_closes_socket(true);
    }

    #[test]
    fn pre_cancelled_idle_work_never_connects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let cancelled = AtomicBool::new(true);
        assert!(post(
            listener.local_addr().unwrap().port(),
            "key",
            Endpoint::InputTokens,
            b"{}".to_vec(),
            &cancelled,
            Duration::from_secs(3),
            1024,
        )
        .unwrap_err()
        .contains("cancelled"));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn idle_http_preserves_status_and_enforces_bounded_body() {
        for (status, body, max, succeeds) in [
            (200, "1234", 4, true),
            (503, "{}", 4, true),
            (200, "12345", 4, false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                read_request(&mut socket);
                socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
            });
            let response = post(
                port,
                "key",
                Endpoint::InputTokens,
                b"{}".to_vec(),
                &AtomicBool::new(false),
                Duration::from_secs(3),
                max,
            );
            if succeeds {
                assert_eq!(response.unwrap(), (status, body.as_bytes().to_vec()));
            } else {
                assert!(response.unwrap_err().contains("size limit"));
            }
            server.join().unwrap();
        }
    }
}
