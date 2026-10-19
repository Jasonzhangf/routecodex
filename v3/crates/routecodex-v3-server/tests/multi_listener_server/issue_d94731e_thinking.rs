//! Test ID: responses_direct_d94731e_thinking_tags_public_blackbox
//!
//! Public command:
//! cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server
//!   --test multi_listener_server responses_direct_d94731e_thinking_tags_public_blackbox
//!   -- --nocapture

use super::*;

async fn issue_d94731e_thinking_upstream(Json(request): Json<Value>) -> Response<Body> {
    assert_eq!(request["model"], "wire-thinking");
    assert_eq!(request["stream"], true);
    assert_eq!(request["input"], "issue d94731e split thinking");
    let message = json!({
        "id":"msg_d94731e",
        "type":"message",
        "status":"completed",
        "role":"assistant",
        "content":[{"type":"output_text","text":"<thinking>leading body"}]
    });
    let events = [
        json!({
            "type":"response.output_item.added",
            "output_index":0,
            "item":{
                "id":"msg_d94731e",
                "type":"message",
                "status":"in_progress",
                "role":"assistant",
                "content":[{"type":"output_text","text":""}]
            }
        }),
        json!({
            "type":"response.content_part.added",
            "output_index":0,
            "item_id":"msg_d94731e",
            "content_index":0,
            "part":{"type":"output_text","text":""}
        }),
        json!({
            "type":"response.output_text.delta",
            "output_index":0,
            "item_id":"msg_d94731e",
            "content_index":0,
            "delta":"<thin"
        }),
        json!({
            "type":"response.output_text.delta",
            "output_index":0,
            "item_id":"msg_d94731e",
            "content_index":0,
            "delta":"king>leading "
        }),
        json!({
            "type":"response.output_text.delta",
            "output_index":0,
            "item_id":"msg_d94731e",
            "content_index":0,
            "delta":"body"
        }),
        json!({
            "type":"response.output_text.done",
            "output_index":0,
            "item_id":"msg_d94731e",
            "content_index":0,
            "text":"<thinking>leading body"
        }),
        json!({
            "type":"response.content_part.done",
            "output_index":0,
            "item_id":"msg_d94731e",
            "content_index":0,
            "part":{"type":"output_text","text":"<thinking>leading body"}
        }),
        json!({
            "type":"response.output_item.done",
            "output_index":0,
            "item":message.clone()
        }),
        json!({
            "type":"response.completed",
            "response":{
                "id":"resp_d94731e",
                "status":"completed",
                "output":[message]
            }
        }),
    ];
    let mut wire = String::new();
    for event in events {
        let event_type = event["type"].as_str().unwrap();
        wire.push_str("event: ");
        wire.push_str(event_type);
        wire.push_str("\ndata: ");
        wire.push_str(&serde_json::to_string(&event).unwrap());
        wire.push_str("\n\n");
    }
    wire.push_str("data: [DONE]\n\n");
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(wire))
        .unwrap()
}

fn issue_d94731e_thinking_manifest(
    port_a: u16,
    port_b: u16,
    provider_base_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let hub_v1_declaration = HUB_V1_TEST_DECLARATION;
    let hub_v1_server_execution = HUB_V1_TEST_SERVER_EXECUTION;
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}
[servers.a]
bind = "127.0.0.1"
port = {port_a}
routing_group = "default"
endpoints = ["responses"]
[servers.b]
bind = "127.0.0.1"
port = {port_b}
routing_group = "default"
endpoints = ["responses"]
{hub_v1_server_execution}
[providers.test]
type = "responses"
base_url = "{provider_base_url}"
default_model = "thinking"
compatibility_profile = "responses:thinking-tags"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_D94731E_THINKING_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "client" }}
[providers.test.models.thinking]
wire_name = "wire-thinking"
aliases = ["client-thinking"]
capabilities = ["text", "reasoning"]
supports_streaming = true
supports_thinking = true
thinking = "optional"
max_tokens = 4096
max_context_tokens = 128000
[debug]
log_console = false
snapshots = false
dry_run = false
retention = {{ raw_requests = 4, raw_responses = 4, events = 64 }}
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "thinking", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

#[tokio::test]
async fn responses_direct_d94731e_thinking_tags_public_blackbox() {
    let _test_guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_D94731E_THINKING_KEY", "controlled-d94731e-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new().route("/v1/responses", post(issue_d94731e_thinking_upstream));
    let upstream = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let handle = spawn_v3_server_aggregate(issue_d94731e_thinking_manifest(
        free_port(),
        free_port(),
        &format!("http://{address}/v1"),
    ))
    .await
    .unwrap();

    let response = reqwest::Client::new()
        .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
        .json(&json!({
            "model":"thinking",
            "stream":true,
            "input":"issue d94731e split thinking"
        }))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();

    handle.shutdown().await;
    shutdown_tx.send(()).unwrap();
    upstream.await.unwrap();
    std::env::remove_var("V3_D94731E_THINKING_KEY");

    assert_eq!(status, StatusCode::OK.as_u16(), "{body}");
    assert!(
        body.contains("response.reasoning_summary_text.delta"),
        "{body}"
    );
    assert!(body.contains("leading body"), "{body}");
    assert!(!body.contains("response.output_text.delta"), "{body}");
    assert!(!body.contains("<thinking>"), "{body}");
}
