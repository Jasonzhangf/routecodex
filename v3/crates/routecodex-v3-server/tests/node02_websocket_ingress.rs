use futures_util::{SinkExt, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{fs, net::TcpListener, path::PathBuf};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{
    accept_async, connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

struct RequestIdCounterGuard {
    directory: PathBuf,
}

impl RequestIdCounterGuard {
    fn new(label: &str) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "routecodex-node02-ws-{label}-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        std::env::set_var(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            directory.join("request-id-counter.json"),
        );
        Self { directory }
    }
}

impl Drop for RequestIdCounterGuard {
    fn drop(&mut self) {
        std::env::remove_var("ROUTECODEX_REQUEST_ID_COUNTER_FILE");
        fs::remove_dir_all(&self.directory).unwrap();
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn manifest(
    server_port: u16,
    provider_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}
[servers.node02_ws]
bind = "127.0.0.1"
port = {server_port}
routing_group = "node02_ws"
endpoints = ["responses"]
{server_execution}
[providers.controlled]
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_NODE02_WS_TEST_KEY" }}] }}
responses = {{ process = "chat", streaming = "always", transport = "websocket_v2", websocket_v2_url = "{provider_url}" }}
[providers.controlled.models.test]
wire_name = "wire-test"
capabilities = ["text", "tools", "tool_outputs"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[debug]
log_console = false
snapshots = false
dry_run = false
[route_groups.node02_ws.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "test", key = "key", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution("node02_ws"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

#[tokio::test]
async fn responses_websocket_real_endpoint_captures_body_without_protocol_discriminator() {
    let _lock = TEST_LOCK.lock().await;
    let _counter = RequestIdCounterGuard::new("success");
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_url = format!(
        "ws://{}/v1/responses",
        provider_listener.local_addr().unwrap()
    );
    let (provider_event_tx, mut provider_event_rx) = mpsc::unbounded_channel();
    let (provider_shutdown_tx, provider_shutdown_rx) = oneshot::channel();
    let provider_task = tokio::spawn(async move {
        let (stream, _) = provider_listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let event = socket.next().await.unwrap().unwrap();
        let value: Value = serde_json::from_str(event.to_text().unwrap()).unwrap();
        provider_event_tx.send(value).unwrap();
        socket
            .send(Message::Text(
                json!({
                    "type": "response.completed",
                    "response": {
                        "id": "resp_node02_ws",
                        "status": "completed",
                        "output": [{"type": "output_text", "text": "ok"}]
                    }
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let _ = provider_shutdown_rx.await;
    });

    std::env::set_var("V3_NODE02_WS_TEST_KEY", "node02-ws-test-secret");
    let handle = spawn_v3_server_aggregate(manifest(free_port(), &provider_url))
        .await
        .unwrap();
    let endpoint = format!("ws://{}/v1/responses", handle.listeners[0].addr);
    let mut request = endpoint.into_client_request().unwrap();
    request.headers_mut().insert(
        "openai-beta",
        HeaderValue::from_static("responses_websockets=2026-02-06"),
    );
    let (mut client, handshake) = connect_async(request).await.unwrap();
    assert_eq!(handshake.status().as_u16(), 101);
    client
        .send(Message::Text(
            json!({"type": "response.create", "model": "test", "input": "hello"}).to_string(),
        ))
        .await
        .unwrap();

    let client_event = timeout(Duration::from_secs(5), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let client_value: Value = serde_json::from_str(client_event.to_text().unwrap()).unwrap();
    assert_eq!(client_value["type"], "response.completed", "{client_value}");
    assert_eq!(client_value["response"]["id"], "resp_node02_ws");

    let provider_value = timeout(Duration::from_secs(5), provider_event_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(provider_value["type"], "response.create");
    assert_eq!(provider_value["model"], "wire-test");
    assert!(provider_value.get("entry_protocol").is_none());
    assert!(provider_value.get("request_origin_kind").is_none());

    let _ = client.close(None).await;
    handle.shutdown().await;
    provider_shutdown_tx.send(()).unwrap();
    provider_task.await.unwrap();
    std::env::remove_var("V3_NODE02_WS_TEST_KEY");
}

#[tokio::test]
async fn responses_websocket_client_disconnect_during_provider_operation() {
    let _lock = TEST_LOCK.lock().await;
    let _counter = RequestIdCounterGuard::new("disconnect");
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_url = format!(
        "ws://{}/v1/responses",
        provider_listener.local_addr().unwrap()
    );
    let (provider_event_tx, provider_event_rx) = oneshot::channel();
    let (provider_closed_tx, provider_closed_rx) = oneshot::channel();
    let provider_task = tokio::spawn(async move {
        let (stream, _) = provider_listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let event = socket.next().await.unwrap().unwrap();
        let value: Value = serde_json::from_str(event.to_text().unwrap()).unwrap();
        provider_event_tx.send(value).unwrap();
        let next = socket.next().await;
        assert!(
            matches!(next, Some(Ok(Message::Close(_))) | None | Some(Err(_))),
            "client close must cancel the pending provider operation: {next:?}"
        );
        provider_closed_tx.send(()).unwrap();
    });

    std::env::set_var("V3_NODE02_WS_TEST_KEY", "node02-ws-disconnect-secret");
    let handle = spawn_v3_server_aggregate(manifest(free_port(), &provider_url))
        .await
        .unwrap();
    let endpoint = format!("ws://{}/v1/responses", handle.listeners[0].addr);
    let mut request = endpoint.into_client_request().unwrap();
    request.headers_mut().insert(
        "openai-beta",
        HeaderValue::from_static("responses_websockets=2026-02-06"),
    );
    let (mut client, handshake) = connect_async(request).await.unwrap();
    assert_eq!(handshake.status().as_u16(), 101);
    client
        .send(Message::Text(
            json!({"type": "response.create", "model": "test", "input": "disconnect"}).to_string(),
        ))
        .await
        .unwrap();
    let provider_value = timeout(Duration::from_secs(5), provider_event_rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(provider_value["type"], "response.create");

    client.close(None).await.unwrap();
    drop(client);
    timeout(Duration::from_secs(5), provider_closed_rx)
        .await
        .expect("provider must observe cancellation before it sends a response")
        .unwrap();
    timeout(Duration::from_secs(5), provider_task)
        .await
        .unwrap()
        .unwrap();
    handle.shutdown().await;
    std::env::remove_var("V3_NODE02_WS_TEST_KEY");
}

#[tokio::test]
async fn responses_websocket_queues_next_create_without_reordering() {
    let _lock = TEST_LOCK.lock().await;
    let _counter = RequestIdCounterGuard::new("two-frames");
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_url = format!(
        "ws://{}/v1/responses",
        provider_listener.local_addr().unwrap()
    );
    let (provider_event_tx, mut provider_event_rx) = mpsc::unbounded_channel();
    let (release_first_tx, release_first_rx) = oneshot::channel();
    let provider_task = tokio::spawn(async move {
        let (stream, _) = provider_listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let mut release_first_rx = Some(release_first_rx);
        for (index, input) in ["first", "second"].into_iter().enumerate() {
            let event = socket.next().await.unwrap().unwrap();
            let value: Value = serde_json::from_str(event.to_text().unwrap()).unwrap();
            provider_event_tx.send(value).unwrap();
            if index == 0 {
                release_first_rx.take().unwrap().await.unwrap();
            }
            socket
                .send(Message::Text(
                    json!({
                        "type": "response.completed",
                        "response": {
                            "id": format!("resp_{input}"),
                            "status": "completed",
                            "output": []
                        }
                    })
                    .to_string(),
                ))
                .await
                .unwrap();
        }
    });

    std::env::set_var("V3_NODE02_WS_TEST_KEY", "node02-ws-two-frames-secret");
    let handle = spawn_v3_server_aggregate(manifest(free_port(), &provider_url))
        .await
        .unwrap();
    let endpoint = format!("ws://{}/v1/responses", handle.listeners[0].addr);
    let mut request = endpoint.into_client_request().unwrap();
    request.headers_mut().insert(
        "openai-beta",
        HeaderValue::from_static("responses_websockets=2026-02-06"),
    );
    let (mut client, handshake) = connect_async(request).await.unwrap();
    assert_eq!(handshake.status().as_u16(), 101);
    client
        .send(Message::Text(
            json!({"type": "response.create", "model": "test", "input": "first"}).to_string(),
        ))
        .await
        .unwrap();
    let first_provider_value = timeout(Duration::from_secs(5), provider_event_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        first_provider_value.pointer("/input/0/content/0/text"),
        Some(&json!("first"))
    );
    client
        .send(Message::Text(
            json!({"type": "response.create", "model": "test", "input": "second"}).to_string(),
        ))
        .await
        .unwrap();
    release_first_tx.send(()).unwrap();

    for expected_id in ["resp_first", "resp_second"] {
        let message = timeout(Duration::from_secs(5), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let event: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        assert_eq!(event["type"], "response.completed", "{event}");
        assert_eq!(event["response"]["id"], expected_id, "{event}");
    }
    let second_provider_value = timeout(Duration::from_secs(5), provider_event_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        second_provider_value.pointer("/input/0/content/0/text"),
        Some(&json!("second"))
    );

    let _ = client.close(None).await;
    handle.shutdown().await;
    provider_task.await.unwrap();
    std::env::remove_var("V3_NODE02_WS_TEST_KEY");
}
