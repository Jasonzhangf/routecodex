//! Test ID: responses_direct_d94731e_thinking_tags_public_blackbox
//! Test ID: responses_direct_d94731e_thinking_reordered_wire_public_blackbox
//! Test ID: responses_direct_d94731e_thinking_multipart_public_blackbox
//!
//! Public command:
//! cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server
//!   --test multi_listener_server responses_direct_d94731e_
//!   -- --nocapture

use super::*;
use axum::Json;

async fn issue_d94731e_thinking_upstream(Json(request): Json<Value>) -> Response<Body> {
    assert_eq!(request["model"], "wire-thinking");
    assert_eq!(request["stream"], true);
    let events = match request["input"].as_str().unwrap() {
        "issue d94731e split thinking" => issue_d94731e_thinking_events(),
        "issue d94731e reordered thinking native call" => issue_d94731e_reordered_thinking_events(),
        "issue d94731e multipart thinking" => issue_d94731e_multipart_thinking_events(),
        input => panic!("unexpected d94731e input: {input}"),
    };
    controlled_sse_response(events)
}

fn issue_d94731e_thinking_events() -> Vec<Value> {
    let message = issue_d94731e_message("msg_d94731e", "<thinking>leading body");
    vec![
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
    ]
}

fn issue_d94731e_reordered_thinking_events() -> Vec<Value> {
    let wire_message = issue_d94731e_message("msg_d94731e_reordered", "A<thinking>r</thinking>");
    let native_call = json!({
        "id":"call_d94731e_reordered",
        "type":"function_call",
        "status":"completed",
        "call_id":"call_d94731e_reordered",
        "name":"exec_command",
        "arguments":"{\"cmd\":\"printf keep\"}"
    });
    vec![
        json!({
            "type":"response.output_item.added",
            "output_index":0,
            "item":{
                "id":"msg_d94731e_reordered",
                "type":"message",
                "status":"in_progress",
                "role":"assistant",
                "content":[{"type":"output_text","text":""}]
            }
        }),
        json!({
            "type":"response.content_part.added",
            "output_index":0,
            "item_id":"msg_d94731e_reordered",
            "content_index":0,
            "part":{"type":"output_text","text":""}
        }),
        json!({
            "type":"response.output_text.delta",
            "output_index":0,
            "content_index":0,
            "delta":"A<thinking>r</thinking>"
        }),
        json!({
            "type":"response.output_text.done",
            "output_index":0,
            "content_index":0,
            "text":"A<thinking>r</thinking>"
        }),
        json!({
            "type":"response.content_part.done",
            "output_index":0,
            "item_id":"msg_d94731e_reordered",
            "content_index":0,
            "part":{"type":"output_text","text":"A<thinking>r</thinking>"}
        }),
        json!({
            "type":"response.output_item.done",
            "output_index":0,
            "item":wire_message
        }),
        json!({
            "type":"response.output_item.added",
            "output_index":1,
            "item":native_call.clone()
        }),
        json!({
            "type":"response.output_item.done",
            "output_index":1,
            "item":native_call.clone()
        }),
        json!({
            "type":"response.completed",
            "response":{
                "id":"resp_d94731e_reordered",
                "status":"completed",
                "output":[native_call, wire_message]
            }
        }),
    ]
}

fn issue_d94731e_multipart_thinking_events() -> Vec<Value> {
    let wire_message = json!({
        "id":"msg_d94731e_multipart",
        "type":"message",
        "status":"completed",
        "role":"assistant",
        "content":[
            {"type":"output_text","text":"A<thinking>r</thinking>"},
            {"type":"output_text","text":"B"}
        ]
    });
    vec![
        json!({
            "type":"response.output_item.added",
            "output_index":0,
            "item":{
                "id":"msg_d94731e_multipart",
                "type":"message",
                "status":"in_progress",
                "role":"assistant",
                "content":[
                    {"type":"output_text","text":""},
                    {"type":"output_text","text":""}
                ]
            }
        }),
        json!({
            "type":"response.content_part.added",
            "output_index":0,
            "item_id":"msg_d94731e_multipart",
            "content_index":0,
            "part":{"type":"output_text","text":""}
        }),
        json!({
            "type":"response.content_part.added",
            "output_index":0,
            "item_id":"msg_d94731e_multipart",
            "content_index":1,
            "part":{"type":"output_text","text":""}
        }),
        json!({
            "type":"response.output_text.delta",
            "output_index":0,
            "item_id":"msg_d94731e_multipart",
            "content_index":0,
            "delta":"A<thinking>r</thinking>"
        }),
        json!({
            "type":"response.output_text.delta",
            "output_index":0,
            "item_id":"msg_d94731e_multipart",
            "content_index":1,
            "delta":"B"
        }),
        json!({
            "type":"response.output_text.done",
            "output_index":0,
            "item_id":"msg_d94731e_multipart",
            "content_index":0,
            "text":"A<thinking>r</thinking>"
        }),
        json!({
            "type":"response.output_text.done",
            "output_index":0,
            "item_id":"msg_d94731e_multipart",
            "content_index":1,
            "text":"B"
        }),
        json!({
            "type":"response.content_part.done",
            "output_index":0,
            "item_id":"msg_d94731e_multipart",
            "content_index":0,
            "part":{"type":"output_text","text":"A<thinking>r</thinking>"}
        }),
        json!({
            "type":"response.content_part.done",
            "output_index":0,
            "item_id":"msg_d94731e_multipart",
            "content_index":1,
            "part":{"type":"output_text","text":"B"}
        }),
        json!({
            "type":"response.output_item.done",
            "output_index":0,
            "item":wire_message.clone()
        }),
        json!({
            "type":"response.completed",
            "response":{
                "id":"resp_d94731e_multipart",
                "status":"completed",
                "output":[wire_message]
            }
        }),
    ]
}

fn issue_d94731e_message(id: &str, text: &str) -> Value {
    json!({
        "id":id,
        "type":"message",
        "status":"completed",
        "role":"assistant",
        "content":[{"type":"output_text","text":text}]
    })
}

fn controlled_sse_response(events: Vec<Value>) -> Response<Body> {
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
    with_profile: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let hub_v1_declaration = HUB_V1_TEST_DECLARATION;
    let hub_v1_server_execution = HUB_V1_TEST_SERVER_EXECUTION;
    let profile = if with_profile {
        "compatibility_profile = \"responses:thinking-tags\""
    } else {
        ""
    };
    let thinking = if with_profile {
        "capabilities = [\"text\", \"reasoning\"]\nsupports_thinking = true\nthinking = \"optional\""
    } else {
        "capabilities = [\"text\", \"tools\"]"
    };
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
{profile}
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_D94731E_THINKING_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "client" }}
[providers.test.models.thinking]
wire_name = "wire-thinking"
aliases = ["client-thinking"]
{thinking}
supports_streaming = true
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
    let (status, body) = run_thinking_public(true, "issue d94731e split thinking").await;
    assert_eq!(status, StatusCode::OK.as_u16(), "{body}");
    assert!(
        body.contains("response.reasoning_summary_text.delta"),
        "{body}"
    );
    assert!(body.contains("leading body"), "{body}");
    assert!(!body.contains("response.output_text.delta"), "{body}");
    assert!(!body.contains("<thinking>"), "{body}");
}

#[tokio::test]
async fn responses_direct_d94731e_without_profile_or_reasoning_capability() {
    let (status, body) = run_thinking_public(false, "issue d94731e split thinking").await;
    assert_eq!(status, StatusCode::OK.as_u16(), "{body}");
    assert!(
        body.contains("response.reasoning_summary_text.delta"),
        "{body}"
    );
    assert!(body.contains("leading body"), "{body}");
    assert!(!body.contains("response.output_text.delta"), "{body}");
    assert!(!body.contains("<thinking>"), "{body}");
}

#[tokio::test]
async fn responses_direct_d94731e_thinking_reordered_wire_public_blackbox() {
    let (status, body) =
        run_thinking_public(true, "issue d94731e reordered thinking native call").await;
    assert_eq!(status, StatusCode::OK.as_u16(), "{body}");
    let events = parse_sse_events(&body);
    assert!(!body.contains("<thinking>"), "{body}");
    assert!(!body.contains("</thinking>"), "{body}");

    let native_items = events
        .iter()
        .filter_map(|event| event.get("item"))
        .filter(|item| item["id"] == "call_d94731e_reordered")
        .collect::<Vec<_>>();
    assert!(
        !native_items.is_empty(),
        "native function call disappeared: {body}"
    );
    assert!(
        native_items.iter().all(|item| {
            item["type"] == "function_call"
                && item["call_id"] == "call_d94731e_reordered"
                && item["name"] == "exec_command"
                && item["arguments"] == "{\"cmd\":\"printf keep\"}"
        }),
        "native function identity changed: {body}"
    );

    let terminal = terminal_response_event(&events);
    assert_eq!(
        &terminal["response"]["output"][0], native_items[0],
        "terminal native call differs from streamed native item: {body}"
    );
    assert_eq!(
        terminal["response"]["output"][1]["content"][0]["text"], "A",
        "{body}"
    );
    assert_eq!(
        terminal["response"]["output"][2]["summary"][0]["text"], "r",
        "{body}"
    );
}

#[tokio::test]
async fn responses_direct_d94731e_thinking_multipart_public_blackbox() {
    let (status, body) = run_thinking_public(true, "issue d94731e multipart thinking").await;
    assert_eq!(status, StatusCode::OK.as_u16(), "{body}");
    let events = parse_sse_events(&body);
    assert!(!body.contains("<thinking>"), "{body}");
    assert!(!body.contains("</thinking>"), "{body}");

    let deltas = reconstructed_output_text_deltas(&events);
    assert_eq!(
        deltas.get(&("msg_d94731e_multipart".to_owned(), 0)),
        Some(&"A".to_owned()),
        "content_index 0 was duplicated or crossed with another part: {body}"
    );
    assert_eq!(
        deltas.get(&("msg_d94731e_multipart".to_owned(), 1)),
        Some(&"B".to_owned()),
        "content_index 1 was duplicated or crossed with another part: {body}"
    );

    for event in events.iter().filter(|event| {
        matches!(
            event["type"].as_str(),
            Some("response.output_text.done" | "response.content_part.done")
        )
    }) {
        let content_index = event["content_index"].as_u64().unwrap();
        let text = if event["type"] == "response.output_text.done" {
            event["text"].as_str().unwrap()
        } else {
            event["part"]["text"].as_str().unwrap()
        };
        assert_eq!(
            text,
            if content_index == 0 { "A" } else { "B" },
            "done event crossed content parts: {body}"
        );
    }

    let terminal = terminal_response_event(&events);
    assert_eq!(
        terminal["response"]["output"][0]["content"][0]["text"], "A",
        "{body}"
    );
    assert_eq!(
        terminal["response"]["output"][0]["content"][1]["text"], "B",
        "{body}"
    );
    assert_eq!(
        terminal["response"]["output"][1]["summary"][0]["text"], "r",
        "{body}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "response.reasoning_summary_text.delta")
            .count(),
        1,
        "reasoning summary must be emitted exactly once: {body}"
    );
}

async fn run_thinking_public(with_profile: bool, input: &str) -> (u16, String) {
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
        with_profile,
    ))
    .await
    .unwrap();

    let response = reqwest::Client::new()
        .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
        .json(&json!({
            "model":"thinking",
            "stream":true,
            "input":input
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

    (status.as_u16(), body)
}

fn parse_sse_events(body: &str) -> Vec<Value> {
    body.split("\n\n")
        .filter_map(|block| {
            let data = block
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(|line| line.strip_prefix(' ').unwrap_or(line))
                .filter(|line| *line != "[DONE]")
                .collect::<Vec<_>>()
                .join("\n");
            (!data.is_empty()).then(|| serde_json::from_str(&data).unwrap())
        })
        .collect()
}

fn terminal_response_event(events: &[Value]) -> &Value {
    events
        .iter()
        .find(|event| event["type"] == "response.completed")
        .expect("response.completed event")
}

fn reconstructed_output_text_deltas(
    events: &[Value],
) -> std::collections::BTreeMap<(String, u64), String> {
    let mut parts = std::collections::BTreeMap::new();
    for event in events
        .iter()
        .filter(|event| event["type"] == "response.output_text.delta")
    {
        let key = (
            event["item_id"].as_str().unwrap().to_owned(),
            event["content_index"].as_u64().unwrap(),
        );
        parts
            .entry(key)
            .or_insert_with(String::new)
            .push_str(event["delta"].as_str().unwrap());
    }
    parts
}
