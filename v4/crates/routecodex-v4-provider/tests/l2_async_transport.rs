use routecodex_v4_provider::NativeProviderTransport;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

#[test]
fn native_provider_source_has_no_shell_or_curl_transport() {
    let source = include_str!("../src/lib.rs");
    assert!(!source.contains("/bin/sh"));
    assert!(!source.contains("curl"));
    assert!(!source.contains("Command::new"));
}

#[tokio::test]
async fn native_transport_rejects_control_payload_and_invalid_limits() {
    assert!(NativeProviderTransport::new(Duration::from_secs(1), 0).is_err());
    let transport = NativeProviderTransport::new(Duration::from_secs(1), 1024).expect("transport");
    let error = transport
        .send_json(
            "/missing-profile",
            "responses",
            &json!({"metadata": {"route": "x"}}),
            CancellationToken::new(),
        )
        .await
        .expect_err("control payload must fail at provider owner");
    assert_eq!(error.code, "provider_control_payload_leak");
}

fn profile_for(address: &str) -> String {
    static NEXT_PROFILE: AtomicU64 = AtomicU64::new(0);
    let serial = NEXT_PROFILE.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "routecodex-v4-async-transport-alias-{}-{serial}.toml",
        std::process::id()
    ));
    let profile = format!(
        "providerId = \"test-provider\"\n\n[provider]\nbaseURL = \"{address}\"\ndefaultModel = \"model\"\ntype = \"responses\"\n\n[provider.models.model]\nwireName = \"wire-model\"\n\n[provider.auth]\napiKey = \"test-key\"\n"
    );
    std::fs::write(&path, profile).expect("write provider test profile");
    path.display().to_string()
}

fn profile_for_protocol(address: &str, protocol: &str) -> String {
    static NEXT_PROFILE: AtomicU64 = AtomicU64::new(0);
    let serial = NEXT_PROFILE.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "routecodex-v4-async-transport-{}-{serial}.toml",
        std::process::id()
    ));
    let profile = format!(
        "providerId = \"test-provider\"\n\n[provider]\nbaseURL = \"{address}\"\ndefaultModel = \"model\"\ntype = \"{protocol}\"\n\n[provider.models.model]\nwireName = \"wire-model\"\n\n[provider.auth]\napiKey = \"test-key\"\n"
    );
    std::fs::write(&path, profile).expect("write provider test profile");
    path.display().to_string()
}

async fn mock_provider(
    body: Vec<u8>,
    status: u16,
    content_type: &str,
    delay: Duration,
) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock provider");
    let address = format!("http://{}", listener.local_addr().expect("mock address"));
    let content_type = content_type.to_string();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept provider request");
        let mut request = vec![0u8; 8192];
        let _ = socket.read(&mut request).await;
        sleep(delay).await;
        let header = format!(
            "HTTP/1.1 {status} Test\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        );
        let _ = socket.write_all(header.as_bytes()).await;
        let _ = socket.write_all(&body).await;
    });
    (address, task)
}

#[tokio::test]
async fn native_transport_preserves_json_status_and_body() {
    let (address, task) = mock_provider(
        br#"{"ok":true}"#.to_vec(),
        201,
        "application/json",
        Duration::ZERO,
    )
    .await;
    let profile = profile_for(&address);
    let transport = NativeProviderTransport::new(Duration::from_secs(2), 1024).expect("transport");
    let response = transport
        .send_json(
            &profile,
            "responses",
            &json!({"input": []}),
            CancellationToken::new(),
        )
        .await
        .expect("native response");
    assert_eq!(response.status, 201);
    assert_eq!(response.content_type, "application/json");
    assert_eq!(response.body, br#"{"ok":true}"#);
    task.await.expect("mock task");
}

#[tokio::test]
async fn native_transport_stream_splits_chunks_and_preserves_http_error() {
    let body = vec![b'x'; 70 * 1024];
    let (address, task) =
        mock_provider(body.clone(), 429, "text/event-stream", Duration::ZERO).await;
    let profile = profile_for(&address);
    let transport =
        NativeProviderTransport::new(Duration::from_secs(2), 128 * 1024).expect("transport");
    let mut stream = transport
        .send_streaming(
            &profile,
            "responses",
            "responses",
            &json!({"stream": true}),
            CancellationToken::new(),
        )
        .await
        .expect("native stream");
    assert_eq!(stream.status(), 429);
    assert_eq!(stream.content_type(), "text/event-stream");
    let mut received = Vec::new();
    while let Some(chunk) = stream.next_chunk().await.expect("stream chunk") {
        assert!(!chunk.is_empty());
        assert!(chunk.len() <= 64 * 1024);
        received.extend_from_slice(&chunk);
    }
    assert_eq!(received, body);
    task.await.expect("mock task");
}

#[tokio::test]
async fn native_transport_rejects_profile_protocol_mismatch_before_io() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mismatch fixture");
    let address = format!("http://{}", listener.local_addr().expect("mock address"));
    let profile = profile_for(&address);
    let transport =
        NativeProviderTransport::new(Duration::from_secs(2), 128 * 1024).expect("transport");
    let error = transport
        .send_streaming(
            &profile,
            "anthropic",
            "v1/messages",
            &json!({"stream": true}),
            CancellationToken::new(),
        )
        .await
        .expect_err("protocol mismatch must fail");
    assert_eq!(error.code, "provider_protocol_mismatch");
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err(),
        "mismatched profile must fail before provider network I/O"
    );
}

#[tokio::test]
async fn native_transport_uses_canonical_anthropic_auth_for_protocol_alias() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind alias fixture");
    let address = format!("http://{}", listener.local_addr().expect("mock address"));
    let profile = profile_for_protocol(&address, "anthropic-messages");
    let transport =
        NativeProviderTransport::new(Duration::from_secs(2), 128 * 1024).expect("transport");
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept provider request");
        let mut request = vec![0u8; 8192];
        let count = socket.read(&mut request).await.expect("read provider request");
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            )
            .await
            .expect("write provider response");
        String::from_utf8_lossy(&request[..count]).to_ascii_lowercase()
    });
    let mut stream = transport
        .send_streaming(
            &profile,
            "anthropic",
            "v1/messages",
            &json!({"stream": true}),
            CancellationToken::new(),
        )
        .await
        .expect("aliased anthropic stream");
    assert_eq!(stream.next_chunk().await.expect("stream eof"), None);
    let request = server.await.expect("provider fixture");
    assert!(request.contains("x-api-key: test-key"), "{request}");
    assert!(request.contains("anthropic-version: 2023-06-01"), "{request}");
    assert!(!request.contains("authorization: bearer"), "{request}");
}

#[tokio::test]
async fn native_transport_fails_closed_on_deadline_cancellation_and_buffer_overflow() {
    let (address, task) = mock_provider(
        br#"{"late":true}"#.to_vec(),
        200,
        "application/json",
        Duration::from_millis(200),
    )
    .await;
    let profile = profile_for(&address);
    let transport =
        NativeProviderTransport::new(Duration::from_millis(20), 1024).expect("transport");
    let error = transport
        .send_json(&profile, "responses", &json!({}), CancellationToken::new())
        .await
        .expect_err("deadline must fail");
    assert_eq!(error.code, "provider_deadline_exceeded");
    task.await.expect("deadline mock task");

    let (address, task) = mock_provider(
        br#"{"cancelled":true}"#.to_vec(),
        200,
        "application/json",
        Duration::from_millis(200),
    )
    .await;
    let profile = profile_for(&address);
    let cancellation = CancellationToken::new();
    let input = json!({});
    let request = transport.send_json(&profile, "responses", &input, cancellation.clone());
    tokio::pin!(request);
    cancellation.cancel();
    let error = request.await.expect_err("cancel must fail");
    assert_eq!(error.code, "provider_transport_cancelled");
    task.abort();
    let _ = task.await;

    let body = vec![b'o'; 2048];
    let (address, task) = mock_provider(body, 200, "application/json", Duration::ZERO).await;
    let profile = profile_for(&address);
    let bounded = NativeProviderTransport::new(Duration::from_secs(2), 1024).expect("transport");
    let error = bounded
        .send_json(&profile, "responses", &json!({}), CancellationToken::new())
        .await
        .expect_err("overflow must fail");
    assert_eq!(error.code, "provider_response_buffer_limit");
    task.await.expect("overflow mock task");
}
