//! Public HTTP/SSE entry verification for MAP-001 / MAP-002 ontology
//! alignment, small-error response tolerance, and hard-error negative
//! controls. No live providers contacted.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

struct Home {
    previous: Option<OsString>,
    path: std::path::PathBuf,
}

impl Home {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!("rcc-ontology-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &path);
        Self { previous, path }
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[derive(Default)]
struct RelayUpstreamState {
    anthropic_requests: Mutex<Vec<Value>>,
    responses_requests: Mutex<Vec<Value>>,
    openai_chat_hits: AtomicUsize,
}

fn validate_strict_anthropic_wire(body: &Value) -> Result<(), String> {
    if body.get("model").and_then(Value::as_str) != Some("anthropic-wire") {
        return Err(format!("unexpected anthropic model: {body}"));
    }
    if !body
        .get("messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| !messages.is_empty())
    {
        return Err(format!(
            "anthropic wire requires non-empty messages: {body}"
        ));
    }
    for forbidden in ["store", "prompt_cache_key"] {
        if body.get(forbidden).is_some() {
            return Err(format!(
                "unmapped field {forbidden} leaked to anthropic wire: {body}"
            ));
        }
    }
    Ok(())
}

async fn anthropic_upstream(
    State(state): State<Arc<RelayUpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.anthropic_requests.lock().unwrap().push(body.clone());
    if let Err(reason) = validate_strict_anthropic_wire(&body) {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error": {"message": reason}}).to_string(),
            ))
            .unwrap();
    }
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        let sse = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sse_tolerant\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"anthropic-wire\",\"content\":[],\"stop_reason\":null}}\n\n",
            "event: ping\n",
            "data: {\"type\":\"ping\"}\n\n",
            "event: vendor_progress\n",
            "data: {\"type\":\"vendor_progress\",\"step\":\"routing\"}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"citations_unknown_delta\",\"payload\":1}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"tolerant sse response\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":\"extra_omitted\"}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(sse))
            .unwrap();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "msg_json_tolerant",
                "type": "message",
                "role": "assistant",
                "model": "anthropic-wire",
                "content": [
                    {"type": "container_upload", "file_id": "file_unknown"},
                    {"type": "thinking", "thinking": ""},
                    {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_unpaired", "content": []},
                    {"type": "text", "text": "first attempt preserved"}
                ],
                "stop_reason": "end_turn",
                "stop_sequence": "extra_omitted",
                "usage": {"input_tokens": 8, "output_tokens": 5}
            })
            .to_string(),
        ))
        .unwrap()
}

async fn responses_echo_upstream(
    State(state): State<Arc<RelayUpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.responses_requests.lock().unwrap().push(body.clone());
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "resp_map001_echo",
                "object": "response",
                "status": "completed",
                "model": "responses-wire",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "responses echo ok"}]
                }],
                "usage": {"input_tokens": 5, "output_tokens": 3, "total_tokens": 8}
            })
            .to_string(),
        ))
        .unwrap()
}

async fn openai_chat_fallback_upstream(
    State(state): State<Arc<RelayUpstreamState>>,
    Json(_body): Json<Value>,
) -> Response<Body> {
    state.openai_chat_hits.fetch_add(1, Ordering::SeqCst);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "chatcmpl_fallback",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "should not switch"}
                }],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
            })
            .to_string(),
        ))
        .unwrap()
}

fn relay_responses_and_anthropic_declaration() -> String {
    let mut declaration = hub_v1_fixture::hub_v1_test_declaration();
    declaration = declaration.replace(
        r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#,
        r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#,
    );
    declaration
}

fn relay_all_entry_protocols_declaration() -> String {
    relay_responses_and_anthropic_declaration().replace(
        r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#,
        r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" }"#,
    )
}

#[tokio::test]
async fn map001_map002_outbound_unmapped_fields_omit_without_reselection_and_tolerate_small_response_quirks(
) {
    let _lock = LOCK.lock().await;
    hub_v1_fixture::pin_test_process_refill_off();
    let home = Home::new("map001-map002");
    std::env::set_var("ONTOLOGY_ANTHROPIC_KEY", "anthropic-secret");
    std::env::set_var("ONTOLOGY_OPENAI_KEY", "openai-secret");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(RelayUpstreamState::default());
    let app = Router::new()
        .route("/v1/messages", post(anthropic_upstream))
        .route("/v1/responses", post(responses_echo_upstream))
        .route("/v1/chat/completions", post(openai_chat_fallback_upstream))
        .with_state(state.clone());
    let (shutdown, stop) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop.await;
            })
            .await
            .unwrap();
    });

    let listen_port = test_ports::free_port();
    let responses_only_port = test_ports::free_port();
    let drop_log = home.path.join("projection-drops.jsonl");
    let source = format!(
        r#"
version = 3
{}

[servers.a]
bind = "127.0.0.1"
port = {}
routing_group = "default"
endpoints = ["responses", "anthropic"]

{}

[servers.b]
bind = "127.0.0.1"
port = {}
routing_group = "responses_only"
endpoints = ["anthropic"]

{}

[providers.anthropic_primary]
type = "anthropic"
base_url = "http://{addr}"
default_model = "anthropic-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_ANTHROPIC_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.anthropic_primary.models."anthropic-wire"]
wire_name = "anthropic-wire"
aliases = ["client-alias"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.responses_echo]
type = "responses"
base_url = "http://{addr}/v1"
default_model = "responses-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_OPENAI_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.responses_echo.models."responses-wire"]
wire_name = "responses-wire"
aliases = ["responses-alias"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.openai_fallback]
type = "openai_chat"
base_url = "http://{addr}/v1"
default_model = "openai-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_OPENAI_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.openai_fallback.models."openai-wire"]
wire_name = "openai-wire"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "anthropic_primary", model = "anthropic-wire", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "openai_fallback", model = "openai-wire", key = "key", priority = 1 }}
]

[route_groups.responses_only.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "responses_echo", model = "responses-wire", key = "key", priority = 1 }}
]
"#,
        relay_responses_and_anthropic_declaration(),
        listen_port,
        hub_v1_fixture::hub_v1_server_execution("a"),
        responses_only_port,
        hub_v1_fixture::hub_v1_server_execution("b"),
    );

    let mut manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    manifest.debug.projection_drop_log_file = Some(drop_log.display().to_string());
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    // 1) JSON /v1/responses with unmatched outbound fields (store=true, prompt_cache_key)
    let json_resp = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "hello",
            "store": true,
            "prompt_cache_key": "cache-k1",
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(json_resp.status(), StatusCode::OK);
    let json_body: Value = json_resp.json().await.unwrap();
    assert_eq!(json_body["status"], "completed");
    assert_eq!(
        json_body["output"][0]["content"][0]["text"],
        "first attempt preserved"
    );

    // 2) SSE /v1/responses with unmatched outbound fields + unknown SSE events/delta + empty unsigned thinking + contradictory optional stop_sequence.
    let sse_resp = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "hello sse",
            "store": true,
            "prompt_cache_key": "cache-k2",
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(sse_resp.status(), StatusCode::OK);
    let sse_text = sse_resp.text().await.unwrap();
    assert!(
        sse_text.contains("tolerant sse response"),
        "expected tolerant sse response body: {sse_text}"
    );
    assert!(
        sse_text.contains("response.completed"),
        "expected completed SSE terminal: {sse_text}"
    );

    // 3) MAP-001 Inbound /v1/messages preserves multi-key metadata losslessly without trimming user_id
    // or dropping additional metadata keys before Chat Process (verified via responses_echo wire).
    let anthropic_to_responses_resp = client
        .post(format!(
            "http://127.0.0.1:{responses_only_port}/v1/messages"
        ))
        .json(&json!({
            "model": "responses-alias",
            "max_tokens": 128,
            "metadata": {
                "user_id": "  u-public-raw  ",
                "custom_trace": "trace-abc",
                "session_hint": "h-42"
            },
            "messages": [{"role": "user", "content": "hi to responses"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(anthropic_to_responses_resp.status(), StatusCode::OK);

    // 4) MAP-001 Inbound /v1/messages targeting Anthropic still projects trimmed user_id on wire
    // while omitting unsupported keys on outbound without blocking Inbound.
    let anthropic_inbound_resp = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/messages"))
        .json(&json!({
            "model": "client-alias",
            "max_tokens": 128,
            "metadata": {
                "user_id": "  u-public-1  ",
                "custom_trace": "trace-abc",
                "session_hint": 42
            },
            "messages": [{"role": "user", "content": "hi from anthropic"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(anthropic_inbound_resp.status(), StatusCode::OK);

    // Verify zero fallback hits and strict mapped-wire expectations on both JSON and SSE attempts.
    assert_eq!(state.openai_chat_hits.load(Ordering::SeqCst), 0);
    let captured = state.anthropic_requests.lock().unwrap();
    assert_eq!(captured.len(), 3, "{captured:?}");
    for idx in [0usize, 1usize] {
        assert!(
            captured[idx].get("store").is_none(),
            "{idx}: {}",
            captured[idx]
        );
        assert!(
            captured[idx].get("prompt_cache_key").is_none(),
            "{idx}: {}",
            captured[idx]
        );
        assert_eq!(captured[idx]["model"], "anthropic-wire");
    }
    assert_eq!(
        captured[2].get("metadata").and_then(|m| m.get("user_id")),
        Some(&json!("u-public-1"))
    );

    let responses_captured = state.responses_requests.lock().unwrap();
    assert_eq!(responses_captured.len(), 1, "{responses_captured:?}");
    assert_eq!(
        responses_captured[0]["metadata"],
        json!({
            "user_id": "  u-public-raw  ",
            "custom_trace": "trace-abc",
            "session_hint": "h-42"
        }),
        "MAP-001 Inbound must pass all metadata keys and exact untrimmed values through Chat Process"
    );

    // Verify scoped projection drop log contains recorded drops for store & prompt_cache_key.
    let drops_raw = std::fs::read_to_string(&drop_log)
        .expect("projection-drops.jsonl must persist scoped MAP-002 drop diagnostics");
    assert!(
        drops_raw.contains("store") && drops_raw.contains("prompt_cache_key"),
        "expected store and prompt_cache_key in drop log: {drops_raw}"
    );
    assert!(
        drops_raw.contains("unmapped_target_protocol_field_unrepresentable"),
        "expected unmapped_target_protocol_field_unrepresentable reason: {drops_raw}"
    );

    drop(server);
    let _ = shutdown.send(());
    let _ = task.await;
}

#[derive(Default)]
struct NegativeUpstreamState {
    anthropic_hits: AtomicUsize,
    responses_hits: AtomicUsize,
    matched_scenarios: Mutex<Vec<String>>,
    captured_requests: Mutex<Vec<Value>>,
}

async fn negative_anthropic_upstream(
    State(state): State<Arc<NegativeUpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.anthropic_hits.fetch_add(1, Ordering::SeqCst);
    state.captured_requests.lock().unwrap().push(body.clone());
    let prompt = body["messages"][0]["content"][0]["text"]
        .as_str()
        .or_else(|| body["messages"][0]["content"].as_str())
        .unwrap_or("");
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        let sse = match prompt {
            "cross_protocol_sse" => {
                state
                    .matched_scenarios
                    .lock()
                    .unwrap()
                    .push("anthropic:cross_protocol_sse".to_string());
                concat!(
                    "event: message_start\n",
                    "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_x\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"anthropic-wire\",\"content\":[],\"stop_reason\":null}}\n\n",
                    "event: content_block_start\n",
                    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                    "event: content_block_delta\n",
                    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n",
                    "event: response.output_text.delta\n",
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"leak\"}\n\n",
                    "event: content_block_stop\n",
                    "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                    "event: message_delta\n",
                    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
                    "event: message_stop\n",
                    "data: {\"type\":\"message_stop\"}\n\n",
                )
            }
            "missing_block_type_sse" => {
                state
                    .matched_scenarios
                    .lock()
                    .unwrap()
                    .push("anthropic:missing_block_type_sse".to_string());
                concat!(
                    "event: message_start\n",
                    "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_mt\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"anthropic-wire\",\"content\":[],\"stop_reason\":null}}\n\n",
                    "event: content_block_start\n",
                    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                    "event: content_block_delta\n",
                    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"valid\"}}\n\n",
                    "event: content_block_stop\n",
                    "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                    "event: content_block_start\n",
                    "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"text\":\"missing type\"}}\n\n",
                    "event: content_block_stop\n",
                    "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
                    "event: message_delta\n",
                    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
                    "event: message_stop\n",
                    "data: {\"type\":\"message_stop\"}\n\n",
                )
            }
            unexpected => {
                return Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(Body::from(format!("unmatched stream prompt: {unexpected}")))
                    .unwrap();
            }
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(sse))
            .unwrap();
    }

    let response_json = match prompt {
        "positive_control" => {
            state
                .matched_scenarios
                .lock()
                .unwrap()
                .push("anthropic:positive_control".to_string());
            json!({
                "id": "msg_pos_ctrl",
                "type": "message",
                "role": "assistant",
                "model": "anthropic-wire",
                "content": [{"type": "text", "text": "positive_control_ok"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 4, "output_tokens": 2}
            })
        }
        "missing_stop_sequence_json" => {
            state
                .matched_scenarios
                .lock()
                .unwrap()
                .push("anthropic:missing_stop_sequence_json".to_string());
            json!({
                "id": "msg_bad_seq",
                "type": "message",
                "role": "assistant",
                "model": "anthropic-wire",
                "content": [{"type": "text", "text": "stopped without sequence"}],
                "stop_reason": "stop_sequence",
                "usage": {"input_tokens": 5, "output_tokens": 3}
            })
        }
        "unknown_stop_reason_json" => {
            state
                .matched_scenarios
                .lock()
                .unwrap()
                .push("anthropic:unknown_stop_reason_json".to_string());
            json!({
                "id": "msg_unknown_stop",
                "type": "message",
                "role": "assistant",
                "model": "anthropic-wire",
                "content": [{"type": "text", "text": "unknown stop reason must fail"}],
                "stop_reason": "future_terminal",
                "usage": {"input_tokens": 5, "output_tokens": 4}
            })
        }
        "empty_attempt_json" => {
            state
                .matched_scenarios
                .lock()
                .unwrap()
                .push("anthropic:empty_attempt_json".to_string());
            json!({
                "id": "msg_empty_attempt",
                "type": "message",
                "role": "assistant",
                "model": "anthropic-wire",
                "content": [
                    {"type": "container_upload", "file_id": "file_only"},
                    {"type": "thinking", "thinking": ""}
                ],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 5, "output_tokens": 0}
            })
        }
        unexpected => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from(format!("unmatched json prompt: {unexpected}")))
                .unwrap();
        }
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(response_json.to_string()))
        .unwrap()
}

async fn negative_responses_upstream(
    State(state): State<Arc<NegativeUpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.responses_hits.fetch_add(1, Ordering::SeqCst);
    state.captured_requests.lock().unwrap().push(body.clone());
    let prompt = body["input"][0]["content"][0]["text"]
        .as_str()
        .or_else(|| body["input"].as_str())
        .unwrap_or("");
    if body.get("stream").and_then(Value::as_bool) != Some(true) && prompt == "positive_control" {
        state
            .matched_scenarios
            .lock()
            .unwrap()
            .push("responses:positive_control".to_string());
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "id": "resp_pos_ctrl",
                    "object": "response",
                    "status": "completed",
                    "model": "responses-wire",
                    "output": [{
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "responses_positive_control_ok"}]
                    }],
                    "usage": {"input_tokens": 4, "output_tokens": 2, "total_tokens": 6}
                })
                .to_string(),
            ))
            .unwrap();
    }
    if prompt != "cross_protocol_responses_sse" {
        return Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Body::from(format!(
                "unmatched responses prompt: {prompt} body={body}"
            )))
            .unwrap();
    }
    state
        .matched_scenarios
        .lock()
        .unwrap()
        .push("responses:cross_protocol_responses_sse".to_string());
    let sse = concat!(
        "event: response.created\n",
        "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_cross\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"responses-wire\",\"output\":[]}}\n\n",
        "event: response.output_item.added\n",
        "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"msg_r1\",\"type\":\"message\",\"role\":\"assistant\",\"status\":\"in_progress\",\"content\":[]}}\n\n",
        "event: response.output_text.delta\n",
        "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_r1\",\"output_index\":0,\"content_index\":0,\"delta\":\"partial\"}\n\n",
        "event: content_block_stop\n",
        "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: response.completed\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_cross\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"responses-wire\",\"output\":[{\"id\":\"msg_r1\",\"type\":\"message\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"partial\"}]}]}}\n\n",
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(sse))
        .unwrap()
}

async fn assert_hard_json_failure(
    label: &str,
    result: Result<reqwest::Response, reqwest::Error>,
    leaked_markers: &[&str],
) {
    match result {
        Err(err) => assert!(
            !err.is_timeout(),
            "{label}: expected transport abort, got timeout: {err}"
        ),
        Ok(mut resp) => {
            let status = resp.status();
            let mut bytes = Vec::new();
            let mut stream_err = None;
            loop {
                match resp.chunk().await {
                    Ok(Some(chunk)) => bytes.extend_from_slice(&chunk),
                    Ok(None) => break,
                    Err(err) => {
                        stream_err = Some(err);
                        break;
                    }
                }
            }
            let body = String::from_utf8_lossy(&bytes);
            assert!(
                status != StatusCode::OK && stream_err.is_some(),
                "{label}: expected detectable transport abort instead of synthetic payload or 200: status={status} body={body}"
            );
            for marker in leaked_markers {
                assert!(
                    !body.contains(marker),
                    "{label}: aborted failure leaked '{marker}': status={status} body={body}"
                );
            }
        }
    }
}

async fn assert_hard_sse_failure(
    label: &str,
    result: Result<reqwest::Response, reqwest::Error>,
    leaked_markers: &[&str],
) {
    match result {
        Err(err) => assert!(
            !err.is_timeout(),
            "{label}: expected SSE transport abort, got timeout: {err}"
        ),
        Ok(mut resp) => {
            let status = resp.status();
            let mut bytes = Vec::new();
            let mut stream_err = None;
            loop {
                match resp.chunk().await {
                    Ok(Some(chunk)) => bytes.extend_from_slice(&chunk),
                    Ok(None) => break,
                    Err(err) => {
                        stream_err = Some(err);
                        break;
                    }
                }
            }
            let body = String::from_utf8_lossy(&bytes);
            let stream_aborted = stream_err.as_ref().is_some_and(|err| !err.is_timeout());
            assert!(
                stream_aborted,
                "{label}: SSE stream returned headers (status={status}) and ended with clean EOF instead of transport abort: body={body}"
            );
            assert!(
                body.lines()
                    .all(|line| line.is_empty() || line.starts_with(':')),
                "{label}: aborted SSE stream leaked non-keepalive payload before abort: status={status} body={body}"
            );
            assert!(
                !body.contains("response.completed")
                    && !body.contains("finish_reason")
                    && !body.contains("[DONE]"),
                "{label}: uncommitted SSE leaked completion terminal: status={status} body={body}"
            );
            for marker in leaked_markers {
                assert!(
                    !body.contains(marker),
                    "{label}: uncommitted SSE leaked '{marker}': status={status} body={body}"
                );
            }
        }
    }
}

#[tokio::test]
async fn map001_map002_public_hard_errors_reject_malformed_cross_protocol_and_empty_attempts() {
    let _lock = LOCK.lock().await;
    hub_v1_fixture::pin_test_process_refill_off();
    let _home = Home::new("map001-map002-neg");
    std::env::set_var("ONTOLOGY_NEG_KEY", "neg-secret");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(NegativeUpstreamState::default());
    let app = Router::new()
        .route("/v1/messages", post(negative_anthropic_upstream))
        .route("/v1/responses", post(negative_responses_upstream))
        .with_state(state.clone());
    let (shutdown, stop) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop.await;
            })
            .await
            .unwrap();
    });

    let listen_port = test_ports::free_port();
    let responses_chat_port = test_ports::free_port();
    let source = format!(
        r#"
version = 3
{}

[servers.a]
bind = "127.0.0.1"
port = {}
routing_group = "default"
endpoints = ["responses", "anthropic", "openai_chat"]

{}

[servers.b]
bind = "127.0.0.1"
port = {}
routing_group = "responses_group"
endpoints = ["openai_chat"]

{}

[providers.anthropic_primary]
type = "anthropic"
base_url = "http://{addr}"
default_model = "anthropic-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_NEG_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.anthropic_primary.models."anthropic-wire"]
wire_name = "anthropic-wire"
aliases = ["client-alias"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.responses_primary]
type = "responses"
base_url = "http://{addr}/v1"
default_model = "responses-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_NEG_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.responses_primary.models."responses-wire"]
wire_name = "responses-wire"
aliases = ["responses-alias"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "anthropic_primary", model = "anthropic-wire", key = "key", priority = 1 }}
]

[route_groups.responses_group.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "responses_primary", model = "responses-wire", key = "key", priority = 1 }}
]
"#,
        relay_all_entry_protocols_declaration(),
        listen_port,
        hub_v1_fixture::hub_v1_server_execution("a"),
        responses_chat_port,
        hub_v1_fixture::hub_v1_server_execution("b"),
    );

    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    // 1) Malformed registered outbound field (`store` as string) must fail before hitting provider.
    let bad_store = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "hello",
            "store": "not-a-bool",
            "stream": false
        }))
        .send()
        .await;
    assert_eq!(state.anthropic_hits.load(Ordering::SeqCst), 0);
    assert_hard_json_failure("bad_store", bad_store, &[]).await;

    // 2) Cross-protocol SSE frame mid-stream on /v1/responses -> Anthropic must abort attempt rather than committing response.completed.
    let before = state.anthropic_hits.load(Ordering::SeqCst);
    let cross_sse = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "cross_protocol_sse",
            "stream": true
        }))
        .send()
        .await;
    assert_eq!(state.anthropic_hits.load(Ordering::SeqCst), before + 1);
    assert_hard_sse_failure(
        "responses_cross_protocol_anthropic_sse",
        cross_sse,
        &["partial", "leak"],
    )
    .await;

    // 3) Missing content[].type in Anthropic SSE alongside valid text must fail attempt.
    let before = state.anthropic_hits.load(Ordering::SeqCst);
    let missing_block_type = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "missing_block_type_sse",
            "stream": true
        }))
        .send()
        .await;
    assert_eq!(state.anthropic_hits.load(Ordering::SeqCst), before + 1);
    assert_hard_sse_failure("missing_block_type_sse", missing_block_type, &["valid"]).await;

    // 4) stop_reason=stop_sequence without stop_sequence must fail attempt (no fabricated completion).
    let before = state.anthropic_hits.load(Ordering::SeqCst);
    let missing_seq = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "missing_stop_sequence_json",
            "stream": false
        }))
        .send()
        .await;
    assert_eq!(state.anthropic_hits.load(Ordering::SeqCst), before + 1);
    assert_hard_json_failure(
        "missing_stop_sequence_json",
        missing_seq,
        &["stopped without sequence"],
    )
    .await;

    // 5) Unregistered/unknown stop_reason must fail explicitly rather than mapping to EndTurn/stop.
    let before = state.anthropic_hits.load(Ordering::SeqCst);
    let unknown_stop = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "unknown_stop_reason_json",
            "stream": false
        }))
        .send()
        .await;
    assert_eq!(state.anthropic_hits.load(Ordering::SeqCst), before + 1);
    assert_hard_json_failure(
        "unknown_stop_reason_json",
        unknown_stop,
        &["unknown stop reason must fail"],
    )
    .await;

    // 6) Attempt with only unrepresentable/empty blocks and no deliverable output must fail GovernedAttemptEmpty.
    let before = state.anthropic_hits.load(Ordering::SeqCst);
    let empty_attempt = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "empty_attempt_json",
            "stream": false
        }))
        .send()
        .await;
    assert_eq!(state.anthropic_hits.load(Ordering::SeqCst), before + 1);
    assert_hard_json_failure("empty_attempt_json", empty_attempt, &["file_only"]).await;

    // 7) Public /v1/chat/completions stream -> Anthropic upstream emitting late cross-protocol `response.*` event must abort before finish_reason/[DONE].
    let before = state.anthropic_hits.load(Ordering::SeqCst);
    let chat_anthropic_cross = client
        .post(format!(
            "http://127.0.0.1:{listen_port}/v1/chat/completions"
        ))
        .json(&json!({
            "model": "client-alias",
            "messages": [{"role": "user", "content": "cross_protocol_sse"}],
            "stream": true
        }))
        .send()
        .await;
    assert_eq!(state.anthropic_hits.load(Ordering::SeqCst), before + 1);
    assert_hard_sse_failure(
        "chat_cross_protocol_anthropic_sse",
        chat_anthropic_cross,
        &["partial", "leak"],
    )
    .await;

    // 8) Public /v1/chat/completions stream -> Responses upstream emitting late cross-protocol `content_block_stop` must abort before finish_reason/[DONE].
    let before = state.responses_hits.load(Ordering::SeqCst);
    let chat_responses_cross = client
        .post(format!(
            "http://127.0.0.1:{responses_chat_port}/v1/chat/completions"
        ))
        .json(&json!({
            "model": "responses-alias",
            "messages": [{"role": "user", "content": "cross_protocol_responses_sse"}],
            "stream": true
        }))
        .send()
        .await;
    assert_eq!(state.responses_hits.load(Ordering::SeqCst), before + 1);
    assert_hard_sse_failure(
        "chat_cross_protocol_responses_sse",
        chat_responses_cross,
        &["partial"],
    )
    .await;

    // Positive controls on both routes verify normal delivery works on the exact same configuration.
    let before = state.anthropic_hits.load(Ordering::SeqCst);
    let pos_resp = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "positive_control",
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(state.anthropic_hits.load(Ordering::SeqCst), before + 1);
    assert_eq!(pos_resp.status(), StatusCode::OK);
    let pos_json: Value = pos_resp.json().await.unwrap();
    assert_eq!(
        pos_json["output"][0]["content"][0]["text"],
        "positive_control_ok"
    );

    let before = state.responses_hits.load(Ordering::SeqCst);
    let pos_chat = client
        .post(format!(
            "http://127.0.0.1:{responses_chat_port}/v1/chat/completions"
        ))
        .json(&json!({
            "model": "responses-alias",
            "messages": [{"role": "user", "content": "positive_control"}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(state.responses_hits.load(Ordering::SeqCst), before + 1);
    assert_eq!(pos_chat.status(), StatusCode::OK);
    let pos_chat_json: Value = pos_chat.json().await.unwrap();
    assert_eq!(
        pos_chat_json["choices"][0]["message"]["content"],
        "responses_positive_control_ok"
    );

    let matched = state.matched_scenarios.lock().unwrap().clone();
    assert_eq!(
        matched,
        vec![
            "anthropic:cross_protocol_sse",
            "anthropic:missing_block_type_sse",
            "anthropic:missing_stop_sequence_json",
            "anthropic:unknown_stop_reason_json",
            "anthropic:empty_attempt_json",
            "anthropic:cross_protocol_sse",
            "responses:cross_protocol_responses_sse",
            "anthropic:positive_control",
            "responses:positive_control",
        ]
    );

    drop(server);
    let _ = shutdown.send(());
    let _ = task.await;
}

#[derive(Default)]
struct RefusalUpstreamState {
    requests: Mutex<Vec<Value>>,
}

async fn responses_top_level_refusal_upstream(
    State(state): State<Arc<RefusalUpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.requests.lock().unwrap().push(body.clone());
    let prompt = body["input"][0]["content"][0]["text"]
        .as_str()
        .or_else(|| body["input"].as_str())
        .unwrap_or("");
    let output = match prompt {
        "pure_refusal" => json!([{"type": "refusal", "refusal": "PUBLIC_PURE_REFUSAL"}]),
        "mixed_refusal" => json!([
            {"type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "PUBLIC_LEAD_TEXT "}]},
            {"type": "refusal", "refusal": "PUBLIC_MIXED_REFUSAL"}
        ]),
        "mixed_unknown_slot_refusals" => json!([
            {"type": "unknown_widget", "payload": {"ignored": true}},
            {"type": "refusal", "refusal": "SLOT1_REFUSAL_A"},
            {"type": "refusal", "refusal": "SLOT2_REFUSAL_B"}
        ]),
        other => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from(format!("unexpected prompt: {other}")))
                .unwrap();
        }
    };
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        let mut sse = String::from(
            "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_refusal\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"responses-wire\",\"output\":[]}}\n\n",
        );
        if prompt == "mixed_unknown_slot_refusals" {
            // Only emit slot 1 refusal via output_item.done while unknown slot 0 compacts terminal output.
            sse.push_str(&format!(
                "event: response.output_item.done\ndata: {}\n\n",
                json!({
                    "type": "response.output_item.done",
                    "output_index": 1,
                    "item": {"type": "refusal", "refusal": "SLOT1_REFUSAL_A"}
                })
            ));
        } else {
            for (idx, item) in output.as_array().unwrap().iter().enumerate() {
                sse.push_str(&format!(
                    "event: response.output_item.done\ndata: {}\n\n",
                    json!({"type": "response.output_item.done", "output_index": idx, "item": item})
                ));
            }
        }
        sse.push_str(&format!(
            "event: response.completed\ndata: {}\n\n",
            json!({
                "type": "response.completed",
                "response": {
                    "id": "resp_refusal",
                    "object": "response",
                    "status": "completed",
                    "model": "responses-wire",
                    "output": output,
                    "usage": {"input_tokens": 5, "output_tokens": 4, "total_tokens": 9}
                }
            })
        ));
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(sse))
            .unwrap();
    }
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "resp_refusal",
                "object": "response",
                "status": "completed",
                "model": "responses-wire",
                "output": output,
                "usage": {"input_tokens": 5, "output_tokens": 4, "total_tokens": 9}
            })
            .to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn map001_map002_public_chat_and_messages_deliver_responses_top_level_refusal() {
    let _lock = LOCK.lock().await;
    hub_v1_fixture::pin_test_process_refill_off();
    let _home = Home::new("map001-refusal-public");
    std::env::set_var("ONTOLOGY_REFUSAL_KEY", "refusal-secret");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(RefusalUpstreamState::default());
    let app = Router::new()
        .route("/v1/responses", post(responses_top_level_refusal_upstream))
        .with_state(state.clone());
    let (shutdown, stop) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop.await;
            })
            .await
            .unwrap();
    });

    let listen_port = test_ports::free_port();
    let source = format!(
        r#"
version = 3
{}

[servers.a]
bind = "127.0.0.1"
port = {}
routing_group = "default"
endpoints = ["openai_chat", "anthropic"]

{}

[providers.responses_primary]
type = "responses"
base_url = "http://{addr}/v1"
default_model = "responses-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_REFUSAL_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.responses_primary.models."responses-wire"]
wire_name = "responses-wire"
aliases = ["refusal-alias"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "responses_primary", model = "responses-wire", key = "key", priority = 1 }}
]
"#,
        relay_all_entry_protocols_declaration(),
        listen_port,
        hub_v1_fixture::hub_v1_server_execution("a"),
    );

    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    for (prompt, expected) in [
        ("pure_refusal", "PUBLIC_PURE_REFUSAL"),
        ("mixed_refusal", "PUBLIC_MIXED_REFUSAL"),
    ] {
        // /v1/chat/completions JSON + SSE
        let chat_json = client
            .post(format!(
                "http://127.0.0.1:{listen_port}/v1/chat/completions"
            ))
            .json(&json!({
                "model": "refusal-alias",
                "messages": [{"role": "user", "content": prompt}],
                "stream": false
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(chat_json.status(), StatusCode::OK);
        let chat_val: Value = chat_json.json().await.unwrap();
        assert_eq!(chat_val["choices"][0]["message"]["refusal"], expected);

        let chat_sse = client
            .post(format!(
                "http://127.0.0.1:{listen_port}/v1/chat/completions"
            ))
            .json(&json!({
                "model": "refusal-alias",
                "messages": [{"role": "user", "content": prompt}],
                "stream": true
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(chat_sse.status(), StatusCode::OK);
        let chat_sse_text = chat_sse.text().await.unwrap();
        assert_eq!(
            chat_sse_text.matches(expected).count(),
            1,
            "expected refusal once in Chat SSE: {chat_sse_text}"
        );

        // /v1/messages JSON + SSE
        let msg_json = client
            .post(format!("http://127.0.0.1:{listen_port}/v1/messages"))
            .json(&json!({
                "model": "refusal-alias",
                "max_tokens": 64,
                "messages": [{"role": "user", "content": prompt}],
                "stream": false
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(msg_json.status(), StatusCode::OK);
        let msg_val: Value = msg_json.json().await.unwrap();
        assert!(msg_val.to_string().contains(expected), "{msg_val}");

        let msg_sse = client
            .post(format!("http://127.0.0.1:{listen_port}/v1/messages"))
            .json(&json!({
                "model": "refusal-alias",
                "max_tokens": 64,
                "messages": [{"role": "user", "content": prompt}],
                "stream": true
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(msg_sse.status(), StatusCode::OK);
        let msg_sse_text = msg_sse.text().await.unwrap();
        assert_eq!(
            msg_sse_text.matches(expected).count(),
            1,
            "expected refusal once in Anthropic SSE: {msg_sse_text}"
        );
    }

    // Slot preservation when unknown item creates a gap before two un-IDed refusals.
    let slot_sse = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/messages"))
        .json(&json!({
            "model": "refusal-alias",
            "max_tokens": 64,
            "messages": [{"role": "user", "content": "mixed_unknown_slot_refusals"}],
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(slot_sse.status(), StatusCode::OK);
    let slot_sse_text = slot_sse.text().await.unwrap();
    assert_eq!(
        slot_sse_text.matches("SLOT1_REFUSAL_A").count(),
        1,
        "{slot_sse_text}"
    );
    assert_eq!(
        slot_sse_text.matches("SLOT2_REFUSAL_B").count(),
        1,
        "{slot_sse_text}"
    );
    let pos_a = slot_sse_text.find("SLOT1_REFUSAL_A").unwrap();
    let pos_b = slot_sse_text.find("SLOT2_REFUSAL_B").unwrap();
    assert!(
        pos_a < pos_b,
        "original slot order must be preserved: {slot_sse_text}"
    );

    drop(server);
    let _ = shutdown.send(());
    let _ = task.await;
}

#[derive(Default)]
struct DirectCompatState {
    responses_captured: Mutex<Vec<Value>>,
    chat_captured: Mutex<Vec<Value>>,
}

async fn direct_compat_responses_upstream(
    State(state): State<Arc<DirectCompatState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.responses_captured.lock().unwrap().push(body);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "resp_zen_direct",
                "object": "response",
                "status": "completed",
                "model": "x-preview-f-free",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "zen direct responses ok"}]
                }],
                "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}
            })
            .to_string(),
        ))
        .unwrap()
}

async fn direct_compat_chat_upstream(
    State(state): State<Arc<DirectCompatState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.chat_captured.lock().unwrap().push(body);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "chatcmpl_zen_direct",
                "object": "chat.completion",
                "model": "x-preview-f-free",
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "zen direct chat ok"}
                }],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
            })
            .to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn map002_public_direct_opencode_zen_omits_unmapped_effort_and_logs_drop() {
    let _lock = LOCK.lock().await;
    hub_v1_fixture::pin_test_process_refill_off();
    let home = Home::new("map002-direct-zen");
    std::env::set_var("ONTOLOGY_ZEN_KEY", "zen-secret");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(DirectCompatState::default());
    let app = Router::new()
        .route("/v1/responses", post(direct_compat_responses_upstream))
        .route("/v1/chat/completions", post(direct_compat_chat_upstream))
        .with_state(state.clone());
    let (shutdown, stop) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop.await;
            })
            .await
            .unwrap();
    });

    let responses_port = test_ports::free_port();
    let drop_log = home.path.join("direct-projection-drops.jsonl");
    let responses_source = format!(
        r#"
version = 3
{}

[servers.a]
bind = "127.0.0.1"
port = {}
routing_group = "resp_group"
endpoints = ["responses"]

{}

[providers.opencode-go-zen]
type = "responses"
base_url = "http://{addr}/v1"
default_model = "x-preview-f-free"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_ZEN_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.opencode-go-zen.models."x-preview-f-free"]
wire_name = "x-preview-f-free"
aliases = ["zen-resp-alias"]
capabilities = ["text", "reasoning"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.resp_group.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "opencode-go-zen", model = "x-preview-f-free", key = "key", priority = 1 }}
]
"#,
        hub_v1_fixture::hub_v1_test_declaration(),
        responses_port,
        hub_v1_fixture::hub_v1_server_execution("a"),
    );

    let mut responses_manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&responses_source).unwrap())
            .unwrap();
    responses_manifest.debug.projection_drop_log_file = Some(drop_log.display().to_string());
    let responses_server = spawn_v3_server_aggregate(responses_manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    let resp_res = client
        .post(format!("http://127.0.0.1:{responses_port}/v1/responses"))
        .json(&json!({
            "model": "zen-resp-alias",
            "input": "hello direct zen",
            "reasoning": {"effort": "ultra"},
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp_res.status(), StatusCode::OK);
    let resp_captured = state.responses_captured.lock().unwrap();
    assert_eq!(resp_captured.len(), 1);
    assert!(
        resp_captured[0].get("reasoning").is_none(),
        "{}",
        resp_captured[0]
    );
    drop(resp_captured);
    drop(responses_server);

    let chat_port = test_ports::free_port();
    let chat_source = format!(
        r#"
version = 3
{}

[servers.b]
bind = "127.0.0.1"
port = {}
routing_group = "chat_group"
endpoints = ["openai_chat"]

{}

[providers.opencode-go-zen]
type = "openai_chat"
base_url = "http://{addr}/v1"
default_model = "x-preview-f-free"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_ZEN_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.opencode-go-zen.models."x-preview-f-free"]
wire_name = "x-preview-f-free"
aliases = ["zen-chat-alias"]
capabilities = ["text", "reasoning"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.chat_group.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "opencode-go-zen", model = "x-preview-f-free", key = "key", priority = 1 }}
]
"#,
        hub_v1_fixture::hub_v1_test_declaration(),
        chat_port,
        hub_v1_fixture::hub_v1_server_execution("b"),
    );

    let mut chat_manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&chat_source).unwrap()).unwrap();
    chat_manifest.debug.projection_drop_log_file = Some(drop_log.display().to_string());
    let chat_server = spawn_v3_server_aggregate(chat_manifest).await.unwrap();

    let chat_res = client
        .post(format!("http://127.0.0.1:{chat_port}/v1/chat/completions"))
        .json(&json!({
            "model": "zen-chat-alias",
            "messages": [{"role": "user", "content": "hello direct zen chat"}],
            "reasoning_effort": "ultra",
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(chat_res.status(), StatusCode::OK);
    let chat_captured = state.chat_captured.lock().unwrap();
    assert_eq!(chat_captured.len(), 1);
    assert!(
        chat_captured[0].get("reasoning_effort").is_none(),
        "{}",
        chat_captured[0]
    );

    let drops_raw = std::fs::read_to_string(&drop_log)
        .expect("Direct provider compat drop must persist to projection-drops.jsonl");
    assert!(
        drops_raw.contains("$.reasoning.effort") && drops_raw.contains("$.reasoning_effort"),
        "expected both Direct effort drop paths in log: {drops_raw}"
    );

    drop(chat_server);
    let _ = shutdown.send(());
    let _ = task.await;
}

#[derive(Default)]
struct ToolSearchPairingState {
    chat_requests: Mutex<Vec<Value>>,
}

async fn strict_tool_search_chat_upstream(
    State(state): State<Arc<ToolSearchPairingState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let mut requests = state.chat_requests.lock().unwrap();
    requests.push(body.clone());
    let turn = requests.len();
    drop(requests);
    let tools = body["tools"].as_array().cloned().unwrap_or_default();
    let has_only_function_tool_search = tools.len() == 1
        && tools[0]["type"] == "function"
        && tools[0]["function"]["name"] == "tool_search";
    if !has_only_function_tool_search
        || body["tool_choice"] != json!({"type": "function", "function": {"name": "tool_search"}})
    {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error": {"message": format!("expected retained function tool_search + forced tool_choice, got {body}")}})
                    .to_string(),
            ))
            .unwrap();
    }
    if turn == 1 {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "id": "chatcmpl_ts_turn1",
                    "object": "chat.completion",
                    "model": "openai-wire",
                    "choices": [{
                        "index": 0,
                        "finish_reason": "tool_calls",
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [{
                                "id": "call_fn_ts_1",
                                "type": "function",
                                "function": {
                                    "name": "tool_search",
                                    "arguments": "{\"q\":\"ontology\"}"
                                }
                            }]
                        }
                    }],
                    "usage": {"prompt_tokens": 5, "completion_tokens": 4, "total_tokens": 9}
                })
                .to_string(),
            ))
            .unwrap();
    }

    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    let paired = messages.iter().any(|m| {
        m["role"] == "tool"
            && m["tool_call_id"] == "call_fn_ts_1"
            && m["content"] == "found: MAP-002"
    });
    if !paired {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error": {"message": format!("missing paired tool result for call_fn_ts_1: {messages:?}")}})
                    .to_string(),
            ))
            .unwrap();
    }
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "chatcmpl_ts_turn2",
                "object": "chat.completion",
                "model": "openai-wire",
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "paired tool_search ok"}
                }],
                "usage": {"prompt_tokens": 8, "completion_tokens": 4, "total_tokens": 12}
            })
            .to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn map002_public_omitted_hosted_tool_search_retains_same_named_function_dispatch_and_pairing()
{
    let _lock = LOCK.lock().await;
    hub_v1_fixture::pin_test_process_refill_off();
    let _home = Home::new("map002-tool-search-pairing");
    std::env::set_var("ONTOLOGY_TS_KEY", "ts-secret");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(ToolSearchPairingState::default());
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(strict_tool_search_chat_upstream),
        )
        .with_state(state.clone());
    let (shutdown, stop) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop.await;
            })
            .await
            .unwrap();
    });

    let listen_port = test_ports::free_port();
    let source = format!(
        r#"
version = 3
{}

[servers.a]
bind = "127.0.0.1"
port = {}
routing_group = "default"
endpoints = ["responses"]

{}

[providers.openai_primary]
type = "openai_chat"
base_url = "http://{addr}/v1"
default_model = "openai-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_TS_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.openai_primary.models."openai-wire"]
wire_name = "openai-wire"
aliases = ["ts-alias"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "openai_primary", model = "openai-wire", key = "key", priority = 1 }}
]
"#,
        relay_all_entry_protocols_declaration(),
        listen_port,
        hub_v1_fixture::hub_v1_server_execution("a"),
    );

    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    let tools = json!([
        {"type": "tool_search", "execution": "server"},
        {
            "type": "function",
            "name": "tool_search",
            "parameters": {
                "type": "object",
                "properties": {"q": {"type": "string"}},
                "required": ["q"]
            }
        }
    ]);
    let tool_choice = json!({"type": "function", "name": "tool_search"});

    let turn1 = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "ts-alias",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "find MAP-002"}]}],
            "tools": tools,
            "tool_choice": tool_choice,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(turn1.status(), StatusCode::OK);
    let turn1_body: Value = turn1.json().await.unwrap();
    assert_eq!(turn1_body["output"][0]["type"], "function_call");
    assert_eq!(turn1_body["output"][0]["call_id"], "call_fn_ts_1");
    assert_eq!(turn1_body["output"][0]["name"], "tool_search");

    let turn2 = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "ts-alias",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "find MAP-002"}]},
                turn1_body["output"][0].clone(),
                {"type": "function_call_output", "call_id": "call_fn_ts_1", "output": "found: MAP-002"}
            ],
            "tools": tools,
            "tool_choice": tool_choice,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(turn2.status(), StatusCode::OK);
    let turn2_body: Value = turn2.json().await.unwrap();
    assert_eq!(
        turn2_body["output"][0]["content"][0]["text"],
        "paired tool_search ok"
    );
    assert_eq!(state.chat_requests.lock().unwrap().len(), 2);

    drop(server);
    let _ = shutdown.send(());
    let _ = task.await;
}

#[derive(Default)]
struct GeminiUpstreamState {
    requests: Mutex<Vec<(String, Value)>>,
}

async fn controlled_gemini_upstream(
    State(state): State<Arc<GeminiUpstreamState>>,
    axum::extract::Path(operation): axum::extract::Path<String>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.requests.lock().unwrap().push((operation, body));
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "candidates": [{
                    "content": {"role": "model", "parts": [{"text": "gemini public ok"}]},
                    "finishReason": "STOP"
                }],
                "usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 3, "totalTokenCount": 7}
            })
            .to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn map002_public_gemini_outbound_preserves_unmapped_drop_malformed_and_capability_boundaries()
{
    let _lock = LOCK.lock().await;
    hub_v1_fixture::pin_test_process_refill_off();
    let home = Home::new("map002-gemini-public");
    std::env::set_var("ONTOLOGY_GEM_KEY", "gem-secret");

    // Verify synthetic 502 + clean EOF would be rejected by assert_hard_sse_failure helper semantics.
    let synthetic_app = Router::new().route(
        "/synthetic",
        post(|| async {
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from("{\"error\":\"synthetic\"}"))
                .unwrap()
        }),
    );
    let syn_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let syn_addr = syn_listener.local_addr().unwrap();
    let (syn_sd, syn_stop) = oneshot::channel();
    let syn_task = tokio::spawn(async move {
        axum::serve(syn_listener, synthetic_app)
            .with_graceful_shutdown(async {
                let _ = syn_stop.await;
            })
            .await
            .unwrap();
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let mut syn_resp = client
        .post(format!("http://{syn_addr}/synthetic"))
        .send()
        .await
        .unwrap();
    assert_eq!(syn_resp.status(), StatusCode::BAD_GATEWAY);
    let mut syn_bytes = Vec::new();
    let mut syn_err = None;
    loop {
        match syn_resp.chunk().await {
            Ok(Some(c)) => syn_bytes.extend_from_slice(&c),
            Ok(None) => break,
            Err(e) => {
                syn_err = Some(e);
                break;
            }
        }
    }
    assert!(
        syn_err.is_none() && !syn_bytes.is_empty(),
        "clean EOF 502 control is distinct from aborted stream"
    );
    let _ = syn_sd.send(());
    let _ = syn_task.await;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(GeminiUpstreamState::default());
    let app = Router::new()
        .route(
            "/v1beta/models/:operation",
            post(controlled_gemini_upstream),
        )
        .with_state(state.clone());
    let (shutdown, stop) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop.await;
            })
            .await
            .unwrap();
    });

    let no_reason_port = test_ports::free_port();
    let with_reason_port = test_ports::free_port();
    let drop_log = home.path.join("gemini-projection-drops.jsonl");
    let source = format!(
        r#"
version = 3
{}

[servers.no_reason]
bind = "127.0.0.1"
port = {}
routing_group = "no_reason_group"
endpoints = ["responses"]

{}

[servers.with_reason]
bind = "127.0.0.1"
port = {}
routing_group = "with_reason_group"
endpoints = ["responses"]

{}

[providers.gemini_primary]
type = "gemini"
base_url = "http://{addr}/v1beta"
default_model = "gemini-no-reason"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_GEM_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.gemini_primary.models."gemini-no-reason"]
wire_name = "gemini-no-reason"
aliases = ["gem-no-reason"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.gemini_primary.models."gemini-with-reason"]
wire_name = "gemini-with-reason"
aliases = ["gem-with-reason"]
capabilities = ["text", "reasoning", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.no_reason_group.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "gemini_primary", model = "gemini-no-reason", key = "key", priority = 1 }}
]

[route_groups.with_reason_group.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "gemini_primary", model = "gemini-with-reason", key = "key", priority = 1 }}
]
"#,
        relay_all_entry_protocols_declaration(),
        no_reason_port,
        hub_v1_fixture::hub_v1_server_execution("no_reason"),
        with_reason_port,
        hub_v1_fixture::hub_v1_server_execution("with_reason"),
    );

    let mut manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    manifest.debug.projection_drop_log_file = Some(drop_log.display().to_string());
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();

    // 1) Non-reasoning Gemini model + unmapped effort "ultra" -> omits cleanly, logs drop, delivers HTTP 200 on first attempt.
    let ok_ultra = client
        .post(format!("http://127.0.0.1:{no_reason_port}/v1/responses"))
        .json(&json!({
            "model": "gem-no-reason",
            "input": "hello ultra",
            "reasoning": {"effort": "ultra"},
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok_ultra.status(), StatusCode::OK);
    assert_eq!(state.requests.lock().unwrap().len(), 1);
    assert!(state.requests.lock().unwrap()[0]
        .1
        .pointer("/generationConfig/thinkingConfig")
        .is_none());

    // 2) Non-reasoning Gemini model + whitespace-only effort -> fails MalformedOutboundField before provider.
    let bad_empty = client
        .post(format!("http://127.0.0.1:{no_reason_port}/v1/responses"))
        .json(&json!({
            "model": "gem-no-reason",
            "input": "bad empty",
            "reasoning": {"effort": "   "},
            "stream": false
        }))
        .send()
        .await;
    assert_eq!(state.requests.lock().unwrap().len(), 1);
    assert_hard_json_failure("gemini_empty_effort", bad_empty, &[]).await;

    // 3) Non-reasoning Gemini model + mapped effort "high" -> preserves capability failure before provider.
    let bad_cap = client
        .post(format!("http://127.0.0.1:{no_reason_port}/v1/responses"))
        .json(&json!({
            "model": "gem-no-reason",
            "input": "mapped high without capability",
            "reasoning": {"effort": "high"},
            "stream": false
        }))
        .send()
        .await;
    assert_eq!(state.requests.lock().unwrap().len(), 1);
    assert_hard_json_failure("gemini_missing_capability", bad_cap, &[]).await;

    // 4) Reasoning-capable Gemini model + mapped effort "high" -> projects thinkingLevel == "HIGH" on first attempt.
    let ok_reason = client
        .post(format!("http://127.0.0.1:{with_reason_port}/v1/responses"))
        .json(&json!({
            "model": "gem-with-reason",
            "input": "mapped high with capability",
            "reasoning": {"effort": "high"},
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok_reason.status(), StatusCode::OK);
    let captured = state.requests.lock().unwrap();
    assert_eq!(captured.len(), 2);
    assert_eq!(
        captured[1].1["generationConfig"]["thinkingConfig"]["thinkingLevel"],
        "HIGH"
    );

    let drops_raw = std::fs::read_to_string(&drop_log)
        .expect("Gemini unmapped reasoning effort drop must persist locally");
    assert!(
        drops_raw.contains("$.reasoning_effort")
            && drops_raw.contains("unmapped_target_protocol_field_unrepresentable"),
        "expected $.reasoning_effort drop in log: {drops_raw}"
    );

    drop(server);
    let _ = shutdown.send(());
    let _ = task.await;
}
