//! routecodex-v4-server L2 regression: console/identity/evidence resources.

use routecodex_v4_server::{
    HttpHandler, HttpRequest, HttpResponse, RequestIdentityError, V4ConsoleTerminalOutput,
    V4ErrorEvidenceFlushOnTerminalFailure, V4HttpServer, V4RequestIdCounter, WireEvidenceError,
};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

#[test]
fn console_output_projection_positive() {
    let mut console = V4ConsoleTerminalOutput::new();
    console.write("srv-1", "req-1", "responses", "info", "route ok");
    assert_eq!(console.lines().count(), 1);
    assert_eq!(console.lines().next().unwrap().severity, "info");
}

#[test]
fn listener_uses_supplied_address_without_default_port() {
    let server = V4HttpServer::bind("127.0.0.1:0").expect("bind configured address");
    let address = server.local_address().expect("local address");
    assert!(address.starts_with("127.0.0.1:"));
    assert!(!address.ends_with(":0"));
}

struct HealthHandler {
    handled: Arc<AtomicBool>,
}

impl HttpHandler for HealthHandler {
    fn handle(&mut self, request: HttpRequest) -> HttpResponse {
        assert_eq!(request.path, "/health");
        self.handled.store(true, Ordering::Release);
        HttpResponse::json(200, br#"{"id":"rccv4"}"#.to_vec())
    }
}

#[test]
fn accepted_socket_waits_for_delayed_request_bytes() {
    let server = V4HttpServer::bind("127.0.0.1:0").expect("bind configured address");
    let address = server.local_address().expect("local address");
    let handled = Arc::new(AtomicBool::new(false));
    let server_handled = Arc::clone(&handled);
    let server_thread = thread::spawn(move || {
        let mut handler = HealthHandler {
            handled: Arc::clone(&server_handled),
        };
        server
            .run_until(&mut handler, || server_handled.load(Ordering::Acquire))
            .expect("serve delayed request");
    });

    let mut client = TcpStream::connect(address).expect("connect");
    thread::sleep(Duration::from_millis(50));
    client
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .expect("write delayed request");
    let mut response = String::new();
    client.read_to_string(&mut response).expect("read response");
    server_thread.join().expect("server thread");

    assert!(handled.load(Ordering::Acquire));
    assert!(response.starts_with("HTTP/1.1 200 OK"));
    assert!(response.contains("{\"id\":\"rccv4\"}"));
}

#[test]
fn request_identity_counter_positive_and_red() {
    let mut counter = V4RequestIdCounter::new();
    let first = counter
        .next_request_identity("srv-1", "2026-08-16")
        .expect("identity must be issued");
    let second = counter
        .next_request_identity("srv-1", "2026-08-16")
        .expect("identity must be issued");
    assert_eq!(first.sequence, 1);
    assert_eq!(second.sequence, 2);
    assert_ne!(first.request_id, second.request_id);
    assert!(matches!(
        counter.next_request_identity("", "2026-08-16"),
        Err(RequestIdentityError::EmptyServerId)
    ));
}

#[test]
fn request_identity_counter_persists_and_reloads() {
    let path = std::env::temp_dir().join(format!("rccv4-counter-{}.json", std::process::id()));
    let mut first = V4RequestIdCounter::from_state_file(path.clone()).expect("load counter");
    let issued = first
        .next_request_identity("srv-1", "2026-08-16")
        .expect("persist identity");
    assert_eq!(issued.sequence, 1);
    let mut second = V4RequestIdCounter::from_state_file(path.clone()).expect("reload counter");
    let reloaded = second
        .next_request_identity("srv-1", "2026-08-16")
        .expect("continue identity");
    assert_eq!(reloaded.sequence, 2);
    std::fs::remove_file(path).expect("remove test state");
}

#[test]
fn request_identity_counter_rejects_corrupt_state() {
    let path = std::env::temp_dir().join(format!("rccv4-counter-corrupt-{}.json", std::process::id()));
    std::fs::write(&path, br#"{"version":99}"#).expect("write corrupt state");
    assert!(V4RequestIdCounter::from_state_file(path.clone()).is_err());
    std::fs::remove_file(path).expect("remove corrupt state");
}

#[test]
fn request_identity_counter_resets_daily_window_but_keeps_total() {
    let path = std::env::temp_dir().join(format!("rccv4-counter-day-{}.json", std::process::id()));
    let mut counter = V4RequestIdCounter::from_state_file(path.clone()).expect("load counter");
    assert_eq!(counter.next_request_identity("srv-1", "2026-08-16").unwrap().sequence, 1);
    assert_eq!(counter.next_request_identity("srv-1", "2026-08-17").unwrap().sequence, 1);
    let state: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).expect("read state")).expect("parse state");
    assert_eq!(state["windowCount"], 1);
    assert_eq!(state["totalCount"], 2);
    std::fs::remove_file(path).expect("remove day state");
}

#[test]
fn wire_evidence_terminal_failure_positive_and_red() {
    let mut evidence = V4ErrorEvidenceFlushOnTerminalFailure::new();
    let record = evidence
        .flush("responses", "localhost", 5555, "req-1", "req.json", b"{}")
        .expect("terminal failure flush must succeed");
    assert_eq!(record.wire_bytes, b"{}");
    assert_eq!(evidence.records().count(), 1);
    assert!(matches!(
        evidence.flush("responses", "localhost", 5555, "", "req.json", b"{}"),
        Err(WireEvidenceError::EmptyRequestId)
    ));
}

#[test]
fn provider_exchange_evidence_requires_canonical_same_request_bundle() {
    let mut evidence = V4ErrorEvidenceFlushOnTerminalFailure::new();
    let bundle = evidence
        .capture_provider_exchange("responses", "/v1/responses", 5520, "req-1", b"{}", b"{}");
    let bundle = bundle.expect("canonical provider exchange must be captured");
    assert_eq!(bundle.provider_request.artifact_name, "provider-request.json");
    assert_eq!(bundle.provider_response.artifact_name, "provider-response.json");
    assert_eq!(bundle.provider_request.request_id, bundle.provider_response.request_id);
    assert_eq!(evidence.records().count(), 2);
}
