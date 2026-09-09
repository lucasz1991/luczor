//! Process-local counters for the managed model HTTP client. No URL, headers,
//! credentials, request body, response content, or conversation is retained.

use reqwest::blocking::{RequestBuilder, Response};
use serde::Serialize;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Debug, Default, Serialize)]
pub(crate) struct LocalNetworkSnapshot {
    pub sent_bytes: u64,
    pub received_bytes: u64,
    pub requests: u64,
    pub active_requests: u64,
    pub failed_requests: u64,
}

#[derive(Default)]
struct Counters {
    sent: AtomicU64,
    received: AtomicU64,
    requests: AtomicU64,
    active: AtomicU64,
    failed: AtomicU64,
}

static COUNTERS: Counters = Counters {
    sent: AtomicU64::new(0),
    received: AtomicU64::new(0),
    requests: AtomicU64::new(0),
    active: AtomicU64::new(0),
    failed: AtomicU64::new(0),
};

fn add(counter: &AtomicU64, amount: u64) {
    let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        Some(value.saturating_add(amount))
    });
}

impl Counters {
    fn snapshot(&self) -> LocalNetworkSnapshot {
        LocalNetworkSnapshot {
            sent_bytes: self.sent.load(Ordering::Relaxed),
            received_bytes: self.received.load(Ordering::Relaxed),
            requests: self.requests.load(Ordering::Relaxed),
            active_requests: self.active.load(Ordering::Relaxed),
            failed_requests: self.failed.load(Ordering::Relaxed),
        }
    }
}

pub(super) fn snapshot() -> LocalNetworkSnapshot {
    COUNTERS.snapshot()
}

struct RequestCount<'a> {
    counters: &'a Counters,
    failed: bool,
}

impl<'a> RequestCount<'a> {
    fn begin(counters: &'a Counters, encoded_bytes: u64) -> Self {
        add(&counters.requests, 1);
        add(&counters.active, 1);
        add(&counters.sent, encoded_bytes);
        Self {
            counters,
            failed: false,
        }
    }

    fn fail(&mut self) {
        if !self.failed {
            add(&self.counters.failed, 1);
            self.failed = true;
        }
    }
}

impl Drop for RequestCount<'_> {
    fn drop(&mut self) {
        let _ = self
            .counters
            .active
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                Some(value.saturating_sub(1))
            });
    }
}

pub(super) struct CountedResponse<'a, Reader> {
    reader: Reader,
    count: RequestCount<'a>,
}

impl CountedResponse<'_, Response> {
    pub(super) fn status(&self) -> reqwest::StatusCode {
        self.reader.status()
    }
}

impl<Reader: Read> Read for CountedResponse<'_, Reader> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        match self.reader.read(buffer) {
            Ok(bytes) => {
                add(&self.count.counters.received, bytes as u64);
                Ok(bytes)
            }
            Err(error) => {
                self.count.fail();
                Err(error)
            }
        }
    }
}

/// Sent bytes are the encoded payload submitted to this client (including a
/// failed attempt); received bytes count only response bytes actually consumed.
/// This measures API payloads, not TCP/TLS overhead or total device traffic.
pub(super) fn send(request: RequestBuilder) -> reqwest::Result<CountedResponse<'static, Response>> {
    send_counted(request, &COUNTERS)
}

pub(super) struct AsyncResponse {
    response: reqwest::Response,
    count: RequestCount<'static>,
}
impl AsyncResponse {
    pub fn status(&self) -> u16 {
        self.response.status().as_u16()
    }
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>, String> {
        match self.response.chunk().await {
            Ok(Some(bytes)) => {
                add(&self.count.counters.received, bytes.len() as u64);
                Ok(Some(bytes.to_vec()))
            }
            Ok(None) => Ok(None),
            Err(_) => {
                self.count.fail();
                Err("Local HTTP stream failed.".into())
            }
        }
    }
}
pub(super) async fn send_async(request: reqwest::RequestBuilder) -> Result<AsyncResponse, String> {
    let (client, request) = request.build_split();
    let request = request.map_err(|_| "Local HTTP encoding failed.")?;
    let bytes = request
        .body()
        .and_then(|body| body.as_bytes())
        .map_or(0, |bytes| bytes.len() as u64);
    let mut count = RequestCount::begin(&COUNTERS, bytes);
    let response = client.execute(request).await.map_err(|_| {
        count.fail();
        "Local HTTP connection failed."
    })?;
    if !response.status().is_success() {
        count.fail();
    }
    Ok(AsyncResponse { response, count })
}

/// Background-only bounded async transport. Aborting its task drops both the
/// HTTP response and counter guard, including while waiting for headers/body.
pub(super) async fn send_async_bounded(
    request: reqwest::RequestBuilder,
    max_bytes: usize,
) -> Result<(u16, Vec<u8>), String> {
    let (client, request) = request.build_split();
    let request = request.map_err(|_| "Local background request encoding failed.")?;
    let encoded_bytes = request
        .body()
        .and_then(|body| body.as_bytes())
        .map_or(0, |bytes| bytes.len() as u64);
    let mut count = RequestCount::begin(&COUNTERS, encoded_bytes);
    let mut response = client.execute(request).await.map_err(|_| {
        count.fail();
        "Local background HTTP request failed."
    })?;
    let status = response.status();
    if !status.is_success() {
        count.fail();
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        count.fail();
        "Local background HTTP response failed."
    })? {
        add(&count.counters.received, chunk.len() as u64);
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            count.fail();
            return Err("Local background response exceeded its native size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status.as_u16(), bytes))
}

fn send_counted(
    request: RequestBuilder,
    counters: &Counters,
) -> reqwest::Result<CountedResponse<'_, Response>> {
    let (client, request) = request.build_split();
    let request = request?;
    let encoded_bytes = request
        .body()
        .and_then(|body| body.as_bytes())
        .map_or(0, |bytes| bytes.len() as u64);
    let mut count = RequestCount::begin(counters, encoded_bytes);
    match client.execute(request) {
        Ok(response) => {
            if !response.status().is_success() {
                count.fail();
            }
            Ok(CountedResponse {
                reader: response,
                count,
            })
        }
        Err(error) => {
            count.fail();
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Error};

    #[test]
    fn counts_real_loopback_request_payload_and_stream_reads_without_headers() {
        use std::io::Write;
        use std::net::TcpListener;
        use std::time::Duration;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let payload = "öffentliche Testdaten".as_bytes().to_vec();
        let expected_sent = payload.len();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut part = [0; 1024];
            loop {
                let count = socket.read(&mut part).unwrap();
                assert!(count > 0 && bytes.len() + count < 8192);
                bytes.extend_from_slice(&part[..count]);
                if bytes
                    .windows(4)
                    .position(|part| part == b"\r\n\r\n")
                    .is_some_and(|end| bytes.len() >= end + 4 + expected_sent)
                {
                    break;
                }
            }
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\npublic reply").unwrap();
        });
        let counters = Counters::default();
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let mut response = send_counted(
            client
                .post(format!("http://127.0.0.1:{port}/test"))
                .body(payload),
            &counters,
        )
        .unwrap();
        assert!(response.status().is_success());
        assert_eq!(counters.snapshot().active_requests, 1);
        std::io::copy(&mut response, &mut std::io::sink()).unwrap();
        drop(response);
        server.join().unwrap();
        let sample = counters.snapshot();
        assert_eq!(sample.sent_bytes, expected_sent as u64);
        assert_eq!(sample.received_bytes, 12);
        assert_eq!(sample.requests, 1);
        assert_eq!(sample.active_requests, 0);
        assert_eq!(sample.failed_requests, 0);
    }

    #[test]
    fn counts_stream_bytes_without_storing_the_content_and_releases_active_requests() {
        let counters = Counters::default();
        let private = b"PRIVATE_STREAM_CONTENT";
        let mut response = CountedResponse {
            reader: Cursor::new(private),
            count: RequestCount::begin(&counters, 123),
        };
        assert_eq!(counters.snapshot().active_requests, 1);
        let mut buffer = [0; 7];
        assert_eq!(response.read(&mut buffer).unwrap(), 7);
        assert_eq!(counters.snapshot().received_bytes, 7);
        std::io::copy(&mut response, &mut std::io::sink()).unwrap();
        let snapshot = counters.snapshot();
        assert_eq!(snapshot.received_bytes, private.len() as u64);
        assert_eq!(snapshot.sent_bytes, 123);
        assert_eq!(snapshot.requests, 1);
        assert_eq!(snapshot.failed_requests, 0);
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("PRIVATE"));
        drop(response);
        assert_eq!(counters.snapshot().active_requests, 0);
    }

    #[test]
    fn failed_headers_and_reader_errors_count_one_failure_and_drop_closes_the_request() {
        struct Fails;
        impl Read for Fails {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(Error::other("PRIVATE_ERROR"))
            }
        }
        let counters = Counters::default();
        let mut count = RequestCount::begin(&counters, 4);
        count.fail();
        let mut response = CountedResponse {
            reader: Fails,
            count,
        };
        assert!(response.read(&mut [0; 4]).is_err());
        assert!(response.read(&mut [0; 4]).is_err());
        assert_eq!(counters.snapshot().failed_requests, 1);
        assert_eq!(counters.snapshot().received_bytes, 0);
        drop(response);
        assert_eq!(counters.snapshot().active_requests, 0);
    }

    #[test]
    fn an_abandoned_stream_is_no_longer_active_and_counters_never_wrap() {
        let counters = Counters::default();
        counters.sent.store(u64::MAX - 2, Ordering::Relaxed);
        let response = CountedResponse {
            reader: Cursor::new(b"unread"),
            count: RequestCount::begin(&counters, 99),
        };
        drop(response);
        assert_eq!(counters.snapshot().sent_bytes, u64::MAX);
        assert_eq!(counters.snapshot().received_bytes, 0);
        assert_eq!(counters.snapshot().active_requests, 0);
    }
}
