use routecodex_v4_server::{
    AsyncHttpHandler, AsyncHttpServer, HttpRequest, HttpResponse, RequestTiming,
    RequestTimingSnapshot, ResponseStream,
};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

struct Handler;

impl AsyncHttpHandler for Handler {
    fn handle_async<'a>(
        &'a self,
        request: HttpRequest,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = HttpResponse> + Send + 'a>> {
        Box::pin(async move {
            if request.path == "/slow" {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            HttpResponse::json(
                200,
                format!("{{\"path\":\"{}\"}}", request.path).into_bytes(),
            )
        })
    }
}

struct IdentityHandler;

impl AsyncHttpHandler for IdentityHandler {
    fn handle_async<'a>(
        &'a self,
        request: HttpRequest,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = HttpResponse> + Send + 'a>> {
        Box::pin(async move {
            HttpResponse::json(
                200,
                format!(
                    "{}|{}|{}",
                    request.server_id, request.port, request.request_id
                )
                .into_bytes(),
            )
        })
    }
}

async fn request(address: String, path: &str) -> String {
    let mut client = TcpStream::connect(address).await.expect("connect");
    client
        .write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
        .await
        .expect("request");
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.expect("response");
    String::from_utf8(response).expect("UTF-8 response")
}

async fn request_with_headers(address: String, path: &str, headers: &[(&str, &str)]) -> String {
    let mut client = TcpStream::connect(address).await.expect("connect");
    let extra = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    client
        .write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n{extra}\r\n").as_bytes())
        .await
        .expect("request");
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.expect("response");
    String::from_utf8(response).expect("UTF-8 response")
}

#[tokio::test]
async fn async_admission_assigns_real_request_identity_scope() {
    let server = AsyncHttpServer::bind("127.0.0.1:0").await.expect("bind");
    let address = server.local_address().expect("address");
    let stop = CancellationToken::new();
    let task = tokio::spawn(server.run_until(Arc::new(IdentityHandler), stop.clone()));
    let response = request(address, "/identity").await;
    let body = response.split("\r\n\r\n").nth(1).expect("body");
    let fields: Vec<_> = body.split('|').collect();
    assert_eq!(fields.len(), 3);
    assert!(fields[0].starts_with("127.0.0.1:0"));
    assert_ne!(fields[1], "0");
    let id_parts: Vec<_> = fields[2].split('-').collect();
    assert!(id_parts.iter().any(|part| part.starts_with("20")));
    assert!(fields[2].matches('-').count() >= 3);
    stop.cancel();
    task.await.expect("join").expect("clean stop");
}

#[tokio::test]
async fn async_dispatch_does_not_head_of_line_block_connections() {
    let server = AsyncHttpServer::bind("127.0.0.1:0").await.expect("bind");
    let address = server.local_address().expect("address");
    let stop = CancellationToken::new();
    let task = tokio::spawn(server.run_until(Arc::new(Handler), stop.clone()));
    let slow = tokio::spawn(request(address.clone(), "/slow"));
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    let fast = tokio::time::timeout(
        std::time::Duration::from_millis(50),
        request(address, "/fast"),
    )
    .await
    .expect("fast request blocked");
    assert!(fast.contains("/fast"));
    assert!(slow.await.expect("slow join").contains("/slow"));
    stop.cancel();
    task.await.expect("join").expect("clean stop");
}

#[tokio::test]
async fn async_server_binds_and_stops_without_blocking_accept() {
    let server = AsyncHttpServer::bind("127.0.0.1:0").await.expect("bind");
    assert!(server.local_address().expect("address").contains(':'));
    let stop = CancellationToken::new();
    let task = tokio::spawn(server.run_until(Arc::new(Handler), stop.clone()));
    stop.cancel();
    task.await.expect("join").expect("clean stop");
}

#[tokio::test]
async fn async_admission_persists_request_record_after_response() {
    let server = AsyncHttpServer::bind("127.0.0.1:0").await.expect("bind");
    let address = server.local_address().expect("address");
    let port = address
        .rsplit(':')
        .next()
        .expect("port")
        .parse::<u16>()
        .expect("port");
    let stop = CancellationToken::new();
    let task = tokio::spawn(server.run_until(Arc::new(Handler), stop.clone()));
    let response = request(address, "/persist").await;
    assert!(response.starts_with("HTTP/1.1 200"));
    let path = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .expect("HOME")
        .join(".rcc/logs")
        .join(format!("server-v4-{port}.request-records.jsonl"));
    let records = std::fs::read_to_string(path).expect("async request record");
    assert!(records.contains("/persist"));
    stop.cancel();
    task.await.expect("join").expect("clean stop");
}

#[tokio::test]
async fn async_request_record_correlates_codex_turn_id_from_header() {
    let server = AsyncHttpServer::bind("127.0.0.1:0").await.expect("bind");
    let address = server.local_address().expect("address");
    let port = address
        .rsplit(':')
        .next()
        .expect("port")
        .parse::<u16>()
        .expect("port");
    let stop = CancellationToken::new();
    let task = tokio::spawn(server.run_until(Arc::new(Handler), stop.clone()));
    let endpoint = format!(
        "/turn-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    );
    let response = request_with_headers(
        address,
        &endpoint,
        &[(
            "x-codex-turn-metadata",
            r#"{"session_id":"session-1","turn_id":"turn-1"}"#,
        )],
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"));
    let rows = request_record_rows(port);
    let row = rows
        .iter()
        .find(|row| row["row"]["meta"]["endpoint"] == endpoint)
        .expect("turn-correlated row");
    assert_eq!(row["row"]["meta"]["turn_id"], "turn-1");
    stop.cancel();
    task.await.expect("join").expect("clean stop");
}

struct OneChunk {
    sent: bool,
}

impl ResponseStream for OneChunk {
    fn next_chunk(&mut self, chunk: &mut Vec<u8>) -> Result<bool, io::Error> {
        if self.sent {
            return Ok(false);
        }
        self.sent = true;
        chunk.extend_from_slice(b"event: done\n\n");
        Ok(true)
    }
}

struct StreamingHandler;

impl AsyncHttpHandler for StreamingHandler {
    fn handle_async<'a>(
        &'a self,
        _request: HttpRequest,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = HttpResponse> + Send + 'a>> {
        Box::pin(async {
            HttpResponse::streaming(200, "text/event-stream", Box::new(OneChunk { sent: false }))
        })
    }
}

struct TimedHandler;

#[derive(Clone)]
struct TestTiming(std::sync::Arc<std::sync::Mutex<TestTimingState>>);

struct TestTimingState {
    started: std::time::Instant,
    external_ms: u64,
    started_external: bool,
}

impl TestTiming {
    fn new() -> Self {
        Self(std::sync::Arc::new(std::sync::Mutex::new(
            TestTimingState {
                started: std::time::Instant::now(),
                external_ms: 0,
                started_external: false,
            },
        )))
    }

    fn begin_external(&self) {
        self.0.lock().expect("timing").started_external = true;
    }

    fn finish_external(&self) {
        let mut state = self.0.lock().expect("timing");
        state.started_external = false;
        state.external_ms = state.started.elapsed().as_millis() as u64;
    }
}

impl RequestTiming for TestTiming {
    fn snapshot(&self) -> Option<RequestTimingSnapshot> {
        let state = self.0.lock().expect("timing");
        let runtime_ms = state.started.elapsed().as_millis() as u64;
        Some(RequestTimingSnapshot {
            internal_ms: runtime_ms.saturating_sub(state.external_ms),
            external_ms: state.external_ms,
        })
    }
}

impl AsyncHttpHandler for TimedHandler {
    fn handle_async<'a>(
        &'a self,
        _request: HttpRequest,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = HttpResponse> + Send + 'a>> {
        Box::pin(async {
            let timing = TestTiming::new();
            timing.begin_external();
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            timing.finish_external();
            let mut response = HttpResponse::json(200, b"{}".to_vec());
            response.timing = Some(std::sync::Arc::new(timing));
            response
        })
    }
}

struct TimedFailureHandler;

impl AsyncHttpHandler for TimedFailureHandler {
    fn handle_async<'a>(
        &'a self,
        _request: HttpRequest,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = HttpResponse> + Send + 'a>> {
        Box::pin(async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            HttpResponse::error(502, "provider stream failed")
        })
    }
}

fn request_record_rows(port: u16) -> Vec<serde_json::Value> {
    let path = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .expect("HOME")
        .join(".rcc/logs")
        .join(format!("server-v4-{port}.request-records.jsonl"));
    std::fs::read_to_string(path)
        .expect("request records")
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("request record JSON"))
        .collect()
}

#[tokio::test]
async fn async_server_writes_stream_with_bounded_chunked_frames() {
    let server = AsyncHttpServer::bind("127.0.0.1:0").await.expect("bind");
    let address = server.local_address().expect("address");
    let stop = CancellationToken::new();
    let task = tokio::spawn(server.run_until(Arc::new(StreamingHandler), stop.clone()));

    let mut client = TcpStream::connect(address).await.expect("connect");
    client
        .write_all(b"GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .expect("request");
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.expect("response");
    let response = String::from_utf8(response).expect("UTF-8 response");
    assert!(response.contains("transfer-encoding: chunked"));
    assert!(response.contains("event: done\n\n"));
    assert!(response.ends_with("0\r\n\r\n"));

    stop.cancel();
    task.await.expect("join").expect("clean stop");
}

#[tokio::test]
async fn async_request_record_uses_typed_timing_side_channel() {
    let server = AsyncHttpServer::bind("127.0.0.1:0").await.expect("bind");
    let address = server.local_address().expect("address");
    let port = address
        .rsplit(':')
        .next()
        .expect("port")
        .parse::<u16>()
        .expect("port");
    let stop = CancellationToken::new();
    let task = tokio::spawn(server.run_until(Arc::new(TimedHandler), stop.clone()));
    let endpoint = format!(
        "/timed-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    );
    let response = request(address, &endpoint).await;
    assert!(response.starts_with("HTTP/1.1 200"));
    let rows = request_record_rows(port);
    let row = rows
        .iter()
        .find(|row| row["row"]["meta"]["endpoint"] == endpoint)
        .expect("timed row");
    let duration_ms = row["row"]["duration_ms"].as_u64().expect("duration");
    let internal_ms = row["row"]["timing_internal_ms"]
        .as_u64()
        .expect("internal timing");
    let external_ms = row["row"]["timing_external_ms"]
        .as_u64()
        .expect("external timing");
    assert!(external_ms >= 20, "{row}");
    assert!(external_ms <= duration_ms);
    assert!(internal_ms <= duration_ms);
    let started_epoch_ms = row["row"]["started_epoch_ms"]
        .as_u64()
        .expect("started");
    let finished_epoch_ms = row["row"]["finished_epoch_ms"]
        .as_u64()
        .expect("finished");
    assert!(
        finished_epoch_ms >= started_epoch_ms,
        "the record must preserve the server-owned start epoch"
    );
    assert!(
        finished_epoch_ms - started_epoch_ms <= duration_ms.saturating_add(2),
        "wall-clock and monotonic duration readings must agree within rounding"
    );
    stop.cancel();
    task.await.expect("join").expect("clean stop");
}

#[tokio::test]
async fn async_failed_request_record_allows_null_timing_side_channel() {
    let server = AsyncHttpServer::bind("127.0.0.1:0").await.expect("bind");
    let address = server.local_address().expect("address");
    let port = address
        .rsplit(':')
        .next()
        .expect("port")
        .parse::<u16>()
        .expect("port");
    let stop = CancellationToken::new();
    let task = tokio::spawn(server.run_until(Arc::new(TimedFailureHandler), stop.clone()));
    let endpoint = format!(
        "/timed-failure-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    );
    let response = request(address, &endpoint).await;
    assert!(response.starts_with("HTTP/1.1 502"));
    let rows = request_record_rows(port);
    let row = rows
        .iter()
        .find(|row| row["row"]["meta"]["endpoint"] == endpoint)
        .expect("timed failure row");
    assert_eq!(row["row"]["result"], "error");
    assert!(row["row"]["timing_external_ms"].is_null(), "{row}");
    assert!(row["row"]["timing_internal_ms"].is_null(), "{row}");
    stop.cancel();
    task.await.expect("join").expect("clean stop");
}
