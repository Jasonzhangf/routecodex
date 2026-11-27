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
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"container_upload\",\"id\":\"cu_sse_1\",\"name\":\"upload_tool\",\"input\":{\"path\":\"/tmp/a.txt\"},\"file_id\":\"file_sse_unknown\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"citations_unknown_delta\",\"payload\":1}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"text_delta\",\"text\":\"tolerant sse response\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
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
                    {"type": "bash_code_execution_tool_result", "tool_use_id": "srvtoolu_unmapped", "content": {"type": "bash_code_execution_result", "stdout": "ok"}},
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
    assert!(
        !sse_text.contains("container_upload") && !sse_text.contains("file_sse_unknown"),
        "omitted SSE extension block must not leak into client SSE stream: {sse_text}"
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

    // Verify scoped projection drop log contains BOTH request-side drops (store & prompt_cache_key)
    // AND response-side omitted unrepresentable blocks (container_upload, bash_code_execution_tool_result)
    // bound to the same request_id.
    let drops_raw = std::fs::read_to_string(&drop_log)
        .expect("projection-drops.jsonl must persist scoped MAP-002 drop diagnostics");
    let drop_rows: Vec<Value> = drops_raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str::<Value>(line).expect("valid projection drop JSONL row"))
        .collect();
    let req1_id = drop_rows
        .iter()
        .find(|row| {
            row["json_path"] == "$.prompt_cache_key" && row["canonical_value"] == "cache-k1"
        })
        .and_then(|row| row["request_id"].as_str())
        .expect("expected request-side prompt_cache_key drop for cache-k1")
        .to_string();
    assert!(
        drop_rows
            .iter()
            .any(|row| row["request_id"] == req1_id && row["json_path"] == "$.store"),
        "expected same-request store drop: {drops_raw}"
    );
    assert!(
        drop_rows.iter().any(|row| row["request_id"] == req1_id
            && row["stage"] == "response_target_protocol_projection"
            && row["json_path"] == "$.content[0]"
            && row["source_value"]["type"] == "container_upload"),
        "expected same-request response-side container_upload drop record: {drops_raw}"
    );
    assert!(
        drop_rows.iter().any(|row| row["request_id"] == req1_id
            && row["stage"] == "response_target_protocol_projection"
            && row["json_path"] == "$.content[2]"
            && row["source_value"]["type"] == "bash_code_execution_tool_result"),
        "expected same-request response-side bash_code_execution_tool_result drop record: {drops_raw}"
    );
    let req2_id = drop_rows
        .iter()
        .find(|row| {
            row["json_path"] == "$.prompt_cache_key" && row["canonical_value"] == "cache-k2"
        })
        .and_then(|row| row["request_id"].as_str())
        .expect("expected request-side prompt_cache_key drop for cache-k2")
        .to_string();
    assert!(
        drop_rows.iter().any(|row| row["request_id"] == req2_id
            && row["stage"] == "response_target_protocol_projection"
            && row["json_path"] == "$.content[0]"
            && row["source_value"]["type"] == "container_upload"
            && row["source_value"]["id"] == "cu_sse_1"
            && row["source_value"]["name"] == "upload_tool"
            && row["source_value"]["input"]["path"] == "/tmp/a.txt"
            && row["source_value"]["file_id"] == "file_sse_unknown"
            && row["source_value"].get("text").is_none()),
        "expected SSE response-side container_upload drop preserving full source fields without synthetic text: {drops_raw}"
    );
    let json_text_dump = json_body.to_string();
    assert!(
        !json_text_dump.contains("container_upload")
            && !json_text_dump.contains("file_unknown")
            && !json_text_dump.contains("bash_code_execution_tool_result"),
        "omitted unrepresentable response blocks must not enter client payload: {json_body}"
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

async fn check_hard_json_failure(
    label: &str,
    result: Result<reqwest::Response, reqwest::Error>,
    leaked_markers: &[&str],
) -> Result<(), String> {
    match result {
        Err(err) => {
            if err.is_timeout() {
                return Err(format!(
                    "{label}: expected transport abort, got timeout: {err}"
                ));
            }
            Ok(())
        }
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
            if status != StatusCode::OK {
                return Err(format!(
                    "{label}: synthetic error HTTP status is disallowed for internal failure: status={status} stream_err={stream_err:?} body={body}"
                ));
            }
            if !stream_err.as_ref().is_some_and(|err| !err.is_timeout()) {
                return Err(format!(
                    "{label}: expected non-timeout transport abort after headers, got clean EOF or timeout: status={status} stream_err={stream_err:?} body={body}"
                ));
            }
            if !bytes.is_empty() {
                return Err(format!(
                    "{label}: aborted JSON response leaked body bytes before abort: status={status} body={body}"
                ));
            }
            for marker in leaked_markers {
                if body.contains(marker) {
                    return Err(format!(
                        "{label}: aborted failure leaked '{marker}': status={status} body={body}"
                    ));
                }
            }
            Ok(())
        }
    }
}

async fn assert_hard_json_failure(
    label: &str,
    result: Result<reqwest::Response, reqwest::Error>,
    leaked_markers: &[&str],
) {
    if let Err(reason) = check_hard_json_failure(label, result, leaked_markers).await {
        panic!("{reason}");
    }
}

async fn check_hard_sse_failure(
    label: &str,
    result: Result<reqwest::Response, reqwest::Error>,
    leaked_markers: &[&str],
) -> Result<(), String> {
    match result {
        Err(err) => {
            if err.is_timeout() {
                return Err(format!(
                    "{label}: expected SSE transport abort, got timeout: {err}"
                ));
            }
            Ok(())
        }
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
            if status != StatusCode::OK {
                return Err(format!(
                    "{label}: expected 200 SSE handshake before abort (never synthetic error status), got status={status} stream_err={stream_err:?} body={body}"
                ));
            }
            if !stream_err.as_ref().is_some_and(|err| !err.is_timeout()) {
                return Err(format!(
                    "{label}: SSE stream returned headers (status={status}) and ended with clean EOF instead of transport abort: body={body}"
                ));
            }
            if !body
                .lines()
                .all(|line| line.is_empty() || line.starts_with(':'))
            {
                return Err(format!(
                    "{label}: aborted SSE stream leaked non-keepalive payload before abort: status={status} body={body}"
                ));
            }
            if body.contains("response.completed")
                || body.contains("finish_reason")
                || body.contains("[DONE]")
            {
                return Err(format!(
                    "{label}: uncommitted SSE leaked completion terminal: status={status} body={body}"
                ));
            }
            for marker in leaked_markers {
                if body.contains(marker) {
                    return Err(format!(
                        "{label}: uncommitted SSE leaked '{marker}': status={status} body={body}"
                    ));
                }
            }
            Ok(())
        }
    }
}

async fn assert_hard_sse_failure(
    label: &str,
    result: Result<reqwest::Response, reqwest::Error>,
    leaked_markers: &[&str],
) {
    if let Err(reason) = check_hard_sse_failure(label, result, leaked_markers).await {
        panic!("{reason}");
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
        "mixed_cached_container_slot_refusals" => json!([
            {"type": "unknown_widget", "payload": {"ignored": true}},
            {"type": "refusal", "refusal": "CACHED_SLOT1_REFUSAL_A"},
            {"type": "refusal", "refusal": "CACHED_SLOT2_REFUSAL_B"}
        ]),
        other => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from(format!("unexpected prompt: {other}")))
                .unwrap();
        }
    };
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        if prompt == "mixed_cached_container_slot_refusals" {
            let mut sse = format!(
                "event: response.created\ndata: {}\n\n",
                json!({
                    "type": "response.created",
                    "response": {"id": "resp_refusal", "object": "response", "status": "in_progress", "model": "responses-wire", "output": []}
                })
            );
            sse.push_str(&format!(
                "event: response.in_progress\ndata: {}\n\n",
                json!({
                    "type": "response.in_progress",
                    "response": {"id": "resp_refusal", "object": "response", "status": "in_progress", "model": "responses-wire", "output": output}
                })
            ));
            sse.push_str(&format!(
                "event: response.output_item.done\ndata: {}\n\n",
                json!({
                    "type": "response.output_item.done",
                    "output_index": 1,
                    "item": {"type": "refusal", "refusal": "CACHED_SLOT1_REFUSAL_A"}
                })
            ));
            sse.push_str(&format!(
                "event: response.completed\ndata: {}\n\n",
                json!({
                    "type": "response.completed",
                    "response": {
                        "id": "resp_refusal",
                        "object": "response",
                        "status": "completed",
                        "model": "responses-wire",
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

    // Cached in_progress container provides mixed [unknown, refusal A, refusal B],
    // while terminal response.completed omits output and reuses the cached container slots.
    let cached_slot_sse = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/messages"))
        .json(&json!({
            "model": "refusal-alias",
            "max_tokens": 64,
            "messages": [{"role": "user", "content": "mixed_cached_container_slot_refusals"}],
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(cached_slot_sse.status(), StatusCode::OK);
    let cached_slot_sse_text = cached_slot_sse.text().await.unwrap();
    assert_eq!(
        cached_slot_sse_text
            .matches("CACHED_SLOT1_REFUSAL_A")
            .count(),
        1,
        "{cached_slot_sse_text}"
    );
    assert_eq!(
        cached_slot_sse_text
            .matches("CACHED_SLOT2_REFUSAL_B")
            .count(),
        1,
        "{cached_slot_sse_text}"
    );
    let cached_pos_a = cached_slot_sse_text.find("CACHED_SLOT1_REFUSAL_A").unwrap();
    let cached_pos_b = cached_slot_sse_text.find("CACHED_SLOT2_REFUSAL_B").unwrap();
    assert!(
        cached_pos_a < cached_pos_b,
        "cached container original slot order must be preserved: {cached_slot_sse_text}"
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

fn execute_local_tool_search(name: &str, arguments_raw: &str) -> String {
    assert_eq!(name, "tool_search");
    let args: Value =
        serde_json::from_str(arguments_raw).expect("tool_search arguments must be valid JSON");
    let query = args["q"]
        .as_str()
        .filter(|q| !q.trim().is_empty())
        .expect("tool_search arguments must include non-empty q");
    format!("found: {query}")
}

fn parse_sse_completed_response(sse_text: &str) -> Value {
    for block in sse_text.split("\n\n") {
        let data_lines: Vec<&str> = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect();
        if data_lines.is_empty() {
            continue;
        }
        let data = data_lines.join("\n");
        if data == "[DONE]" {
            continue;
        }
        if let Ok(event) = serde_json::from_str::<Value>(&data) {
            if event.get("type").and_then(Value::as_str) == Some("response.completed") {
                return event["response"].clone();
            }
        }
    }
    panic!("missing response.completed event in SSE stream: {sse_text}");
}

async fn strict_tool_search_chat_upstream(
    State(state): State<Arc<ToolSearchPairingState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.chat_requests.lock().unwrap().push(body.clone());
    let tools = body["tools"].as_array().cloned().unwrap_or_default();
    let has_only_function_tool_search = tools.len() == 1
        && tools[0]["type"] == "function"
        && tools[0]["function"]["name"] == "tool_search"
        && tools[0]["function"]["parameters"]["type"] == "object"
        && tools[0]["function"]["parameters"]["properties"]["q"]["type"] == "string"
        && tools[0]["function"]["parameters"]["required"] == json!(["q"]);
    if !has_only_function_tool_search
        || body["tool_choice"] != json!({"type": "function", "function": {"name": "tool_search"}})
    {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error": {"message": format!("expected retained function tool_search full schema + forced tool_choice, got {body}")}})
                    .to_string(),
            ))
            .unwrap();
    }
    let is_sse = body.get("stream").and_then(Value::as_bool) == Some(true);
    let expected_call_id = if is_sse {
        "call_fn_ts_sse_1"
    } else {
        "call_fn_ts_json_1"
    };
    let expected_query = if is_sse {
        "MAP-002-SSE"
    } else {
        "MAP-002-JSON"
    };
    let expected_args = json!({"q": expected_query}).to_string();
    let expected_output = format!("found: {expected_query}");
    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    let has_tool_result = messages.iter().any(|m| m["role"] == "tool");

    if !has_tool_result {
        if is_sse {
            let sse = format!(
                "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                json!({
                    "id": "chatcmpl_ts_sse_turn1",
                    "object": "chat.completion.chunk",
                    "model": "openai-wire",
                    "choices": [{
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [{
                                "index": 0,
                                "id": expected_call_id,
                                "type": "function",
                                "function": {"name": "tool_search", "arguments": expected_args}
                            }]
                        },
                        "finish_reason": null
                    }]
                }),
                json!({
                    "id": "chatcmpl_ts_sse_turn1",
                    "object": "chat.completion.chunk",
                    "model": "openai-wire",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                    "usage": {"prompt_tokens": 5, "completion_tokens": 4, "total_tokens": 9}
                })
            );
            return Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from(sse))
                .unwrap();
        }
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
                                "id": expected_call_id,
                                "type": "function",
                                "function": {
                                    "name": "tool_search",
                                    "arguments": expected_args
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

    let paired = messages.windows(2).any(|pair| {
        let assistant = &pair[0];
        let tool_msg = &pair[1];
        let call_ok = assistant["role"] == "assistant"
            && assistant["tool_calls"].as_array().is_some_and(|calls| {
                calls.len() == 1
                    && calls[0]["id"] == expected_call_id
                    && calls[0]["type"] == "function"
                    && calls[0]["function"]["name"] == "tool_search"
                    && calls[0]["function"]["arguments"]
                        .as_str()
                        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                        == Some(json!({"q": expected_query}))
            });
        let result_ok = tool_msg["role"] == "tool"
            && tool_msg["tool_call_id"] == expected_call_id
            && tool_msg["content"] == expected_output;
        call_ok && result_ok
    });
    if !paired {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error": {"message": format!("missing paired assistant tool_calls + following tool result for {expected_call_id}: {messages:?}")}})
                    .to_string(),
            ))
            .unwrap();
    }
    if is_sse {
        let sse = format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({
                "id": "chatcmpl_ts_sse_turn2",
                "object": "chat.completion.chunk",
                "model": "openai-wire",
                "choices": [{"index": 0, "delta": {"role": "assistant", "content": "paired sse tool_search ok"}, "finish_reason": null}]
            }),
            json!({
                "id": "chatcmpl_ts_sse_turn2",
                "object": "chat.completion.chunk",
                "model": "openai-wire",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 8, "completion_tokens": 4, "total_tokens": 12}
            })
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
    let call_item = turn1_body["output"][0].clone();
    assert_eq!(call_item["type"], "function_call");
    let call_id = call_item["call_id"].as_str().unwrap().to_string();
    let call_name = call_item["name"].as_str().unwrap();
    let call_args = call_item["arguments"].as_str().unwrap();
    let tool_output = execute_local_tool_search(call_name, call_args);

    let turn2 = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "ts-alias",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "find MAP-002"}]},
                call_item,
                {"type": "function_call_output", "call_id": call_id, "output": tool_output}
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

    // Public SSE roundtrip for the same function tool_search declaration & pairing.
    let sse_turn1 = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "ts-alias",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "find MAP-002 sse"}]}],
            "tools": tools,
            "tool_choice": tool_choice,
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(sse_turn1.status(), StatusCode::OK);
    let sse_turn1_text = sse_turn1.text().await.unwrap();
    let sse_turn1_response = parse_sse_completed_response(&sse_turn1_text);
    let sse_call_item = sse_turn1_response["output"][0].clone();
    assert_eq!(sse_call_item["type"], "function_call");
    let sse_call_id = sse_call_item["call_id"].as_str().unwrap().to_string();
    let sse_call_name = sse_call_item["name"].as_str().unwrap();
    let sse_call_args = sse_call_item["arguments"].as_str().unwrap();
    let sse_tool_output = execute_local_tool_search(sse_call_name, sse_call_args);

    let sse_turn2 = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "ts-alias",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "find MAP-002 sse"}]},
                sse_call_item,
                {"type": "function_call_output", "call_id": sse_call_id, "output": sse_tool_output}
            ],
            "tools": tools,
            "tool_choice": tool_choice,
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(sse_turn2.status(), StatusCode::OK);
    let sse_turn2_text = sse_turn2.text().await.unwrap();
    let sse_turn2_response = parse_sse_completed_response(&sse_turn2_text);
    assert_eq!(
        sse_turn2_response["output"][0]["content"][0]["text"],
        "paired sse tool_search ok"
    );
    assert_eq!(state.chat_requests.lock().unwrap().len(), 4);

    drop(server);
    let _ = shutdown.send(());
    let _ = task.await;
}

async fn read_next_failed_attempt_evidence(
    samples_root: &std::path::Path,
    seen_dirs: &mut std::collections::HashSet<std::path::PathBuf>,
) -> Value {
    for _ in 0..200 {
        if let Ok(entries) = std::fs::read_dir(samples_root) {
            for entry in entries.flatten() {
                let dir = entry.path();
                if seen_dirs.contains(&dir) {
                    continue;
                }
                let path = dir.join("provider-failed-attempts.json");
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    if let Ok(evidence) = serde_json::from_str::<Value>(&raw) {
                        seen_dirs.insert(dir);
                        return evidence;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("expected new provider-failed-attempts.json under {samples_root:?}");
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

    // Verify synthetic 502 + clean EOF, synthetic 502 + post-header stream abort, and synthetic
    // 502 + partial error body + abort are ALL rejected by check_hard_sse_failure and
    // check_hard_json_failure.
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
    let spawn_502_abort_server = |payload: &'static [u8]| async move {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(payload).await;
                let _ = sock.shutdown().await;
                drop(sock);
            }
        });
        (addr, task)
    };
    let (abort_502_addr, abort_502_task) = spawn_502_abort_server(
        b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n",
    )
    .await;
    let (json_abort_502_addr, json_abort_502_task) = spawn_502_abort_server(
        b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n",
    )
    .await;
    let (partial_502_addr, partial_502_task) = spawn_502_abort_server(
        b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\na\r\n{\"error\":\"\r\n5\r\n",
    )
    .await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let eof_502_res = client
        .post(format!("http://{syn_addr}/synthetic"))
        .send()
        .await;
    assert!(
        check_hard_sse_failure("synthetic_eof_502", eof_502_res, &[])
            .await
            .is_err(),
        "shared SSE predicate must reject synthetic 502 with clean EOF"
    );
    let eof_502_json_res = client
        .post(format!("http://{syn_addr}/synthetic"))
        .send()
        .await;
    assert!(
        check_hard_json_failure("synthetic_eof_502_json", eof_502_json_res, &[])
            .await
            .is_err(),
        "shared JSON predicate must reject synthetic 502 with clean EOF"
    );
    let abort_502_res = client
        .post(format!("http://{abort_502_addr}/synthetic-abort"))
        .send()
        .await;
    assert!(
        check_hard_sse_failure("synthetic_abort_502", abort_502_res, &[])
            .await
            .is_err(),
        "shared SSE predicate must reject synthetic 502 even if body stream aborts after headers"
    );
    let json_abort_502_res = client
        .post(format!("http://{json_abort_502_addr}/synthetic-json-abort"))
        .send()
        .await;
    assert!(
        check_hard_json_failure("synthetic_abort_502_json", json_abort_502_res, &[])
            .await
            .is_err(),
        "shared JSON predicate must reject synthetic 502 with post-header abort"
    );
    let partial_502_res = client
        .post(format!("http://{partial_502_addr}/synthetic-partial-abort"))
        .send()
        .await;
    assert!(
        check_hard_json_failure("synthetic_partial_502_json", partial_502_res, &[])
            .await
            .is_err(),
        "shared JSON predicate must reject partial error body + post-header abort"
    );
    let _ = syn_sd.send(());
    let _ = syn_task.await;
    let _ = abort_502_task.await;
    let _ = json_abort_502_task.await;
    let _ = partial_502_task.await;

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
    manifest.debug.codex_samples = true;
    manifest.debug.projection_drop_log_file = Some(drop_log.display().to_string());
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();
    let no_reason_samples = home
        .path
        .join(".rcc")
        .join("codex-samples")
        .join("openai-responses")
        .join("ports")
        .join(no_reason_port.to_string());
    let mut seen_failure_dirs = std::collections::HashSet::<std::path::PathBuf>::new();

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

    // 2) Non-reasoning Gemini model + whitespace-only effort -> fails invalid_responses_request at Inbound before provider.
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
    assert_hard_json_failure(
        "gemini_empty_effort",
        bad_empty,
        &[
            "MalformedOutboundField",
            "invalid_responses_request",
            "reasoning.effort",
        ],
    )
    .await;
    server
        .wait_for_codex_sample_persistence()
        .await
        .expect("empty effort failure sample must persist");
    let bad_empty_evidence =
        read_next_failed_attempt_evidence(&no_reason_samples, &mut seen_failure_dirs).await;
    assert_eq!(bad_empty_evidence["attempts"], json!([]));
    assert_eq!(
        bad_empty_evidence["terminal_source"]["source_stage"], "V3HubReqInbound02Normalized",
        "{bad_empty_evidence}"
    );
    assert_eq!(
        bad_empty_evidence["terminal_source"]["code"], "invalid_responses_request",
        "{bad_empty_evidence}"
    );
    let bad_empty_msg = bad_empty_evidence["terminal_source"]["message"]
        .as_str()
        .unwrap_or("");
    assert!(
        bad_empty_msg.contains("Responses reasoning.effort must be a non-empty string"),
        "empty effort must fail locally at Inbound with exact message: {bad_empty_evidence}"
    );

    // 3) Non-reasoning Gemini model + mapped effort "high" -> passes Inbound and fails Outbound capability gate before provider.
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
    assert_hard_json_failure(
        "gemini_missing_capability",
        bad_cap,
        &[
            "missing_capability",
            "network_error",
            "UnmappedOutboundFields",
        ],
    )
    .await;
    server
        .wait_for_codex_sample_persistence()
        .await
        .expect("missing capability failure sample must persist");
    let bad_cap_evidence =
        read_next_failed_attempt_evidence(&no_reason_samples, &mut seen_failure_dirs).await;
    let bad_cap_attempts = bad_cap_evidence["attempts"]
        .as_array()
        .expect("bad_cap attempts must be an array");
    assert_eq!(bad_cap_attempts.len(), 1, "{bad_cap_evidence}");
    assert_eq!(
        bad_cap_attempts[0]["action"], "terminal_request_local_provider_compat_exhausted",
        "{bad_cap_evidence}"
    );
    assert_eq!(
        bad_cap_attempts[0]["health_state"], "request_local_provider_compat",
        "{bad_cap_evidence}"
    );
    assert!(
        bad_cap_attempts[0]["provider_status"].is_null(),
        "local request compat exhaustion must record zero upstream HTTP status: {bad_cap_evidence}"
    );
    assert_eq!(
        bad_cap_attempts[0]["failure_count"], 0,
        "{bad_cap_evidence}"
    );
    assert_eq!(
        bad_cap_evidence["terminal_source"]["source_stage"], "ProviderReqCompat06ProviderCompat",
        "mapped high must reach ProviderReqCompat/Outbound capability gate: {bad_cap_evidence}"
    );
    let bad_cap_msg = bad_cap_evidence["terminal_source"]["message"]
        .as_str()
        .unwrap_or("");
    assert!(
        bad_cap_msg.contains("UnmappedOutboundFields target_protocol=gemini")
            && bad_cap_msg.contains("missing_capability=reasoning"),
        "mapped high without capability must fail locally with missing_capability=reasoning: {bad_cap_evidence}"
    );

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

#[derive(Default)]
struct RequiredToolChoiceChatState {
    requests: Mutex<Vec<Value>>,
}

async fn strict_required_tool_choice_chat_upstream(
    State(state): State<Arc<RequiredToolChoiceChatState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.requests.lock().unwrap().push(body.clone());
    let has_tools = body
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|t| !t.is_empty());
    let has_tool_choice = body.get("tool_choice").is_some();
    if !has_tools && has_tool_choice {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error": {"message": format!("orphaned tool_choice without tools: {body}")}})
                    .to_string(),
            ))
            .unwrap();
    }
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "chatcmpl_required_choice",
                "object": "chat.completion",
                "model": "openai-wire",
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": if has_tools { "callable_kept" } else { "hosted_omitted" }}
                }],
                "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}
            })
            .to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn map002_public_omitted_hosted_tool_search_adjusts_orphaned_required_tool_choice() {
    let _lock = LOCK.lock().await;
    hub_v1_fixture::pin_test_process_refill_off();
    let home = Home::new("map002-tool-search-required-choice");
    std::env::set_var("ONTOLOGY_TS_REQ_KEY", "ts-req-secret");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(RequiredToolChoiceChatState::default());
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(strict_required_tool_choice_chat_upstream),
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
    let drop_log = home.path.join("tool-search-choice-drops.jsonl");
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
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_TS_REQ_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.openai_primary.models."openai-wire"]
wire_name = "openai-wire"
aliases = ["ts-req-alias"]
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

    let mut manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    manifest.debug.projection_drop_log_file = Some(drop_log.display().to_string());
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    // 1) Hosted-only server tool_search + tool_choice="required" -> omits both tools & tool_choice.
    let hosted_only = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "ts-req-alias",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "only hosted"}]}],
            "tools": [{"type": "tool_search", "execution": "server"}],
            "tool_choice": "required",
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(hosted_only.status(), StatusCode::OK);
    let hosted_only_body: Value = hosted_only.json().await.unwrap();
    assert_eq!(
        hosted_only_body["output"][0]["content"][0]["text"],
        "hosted_omitted"
    );

    // 2) Hosted server tool_search + callable function tool + tool_choice="required" -> retains function + required.
    let with_fn = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "ts-req-alias",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "mixed"}]}],
            "tools": [
                {"type": "tool_search", "execution": "server"},
                {
                    "type": "function",
                    "name": "lookup",
                    "parameters": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}
                }
            ],
            "tool_choice": "required",
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(with_fn.status(), StatusCode::OK);
    let with_fn_body: Value = with_fn.json().await.unwrap();
    assert_eq!(
        with_fn_body["output"][0]["content"][0]["text"],
        "callable_kept"
    );

    let captured = state.requests.lock().unwrap();
    assert_eq!(captured.len(), 2);
    assert!(captured[0].get("tools").is_none(), "{}", captured[0]);
    assert!(captured[0].get("tool_choice").is_none(), "{}", captured[0]);
    assert_eq!(captured[1]["tools"][0]["function"]["name"], "lookup");
    assert_eq!(captured[1]["tool_choice"], "required");

    let drops_raw = std::fs::read_to_string(&drop_log)
        .expect("hosted-only required tool_choice drop must persist locally");
    assert!(
        drops_raw.contains("$.tools[0]") && drops_raw.contains("$.tool_choice"),
        "expected both tool and orphaned tool_choice drops: {drops_raw}"
    );

    drop(server);
    let _ = shutdown.send(());
    let _ = task.await;
}

#[derive(Default)]
struct WebSearchPairingUpstreamState {
    primary_hits: AtomicUsize,
    backup_hits: AtomicUsize,
}

async fn web_search_primary_anthropic(
    State(state): State<Arc<WebSearchPairingUpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.primary_hits.fetch_add(1, Ordering::SeqCst);
    let prompt = body["messages"][0]["content"][0]["text"]
        .as_str()
        .unwrap_or("");
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        let sse = match prompt {
            "paired_ws" => concat!(
                "event: message_start\n",
                "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_ws_sse_primary\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"anthropic-wire\",\"content\":[],\"stop_reason\":null}}\n\n",
                "event: content_block_start\n",
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"server_tool_use\",\"id\":\"srvtoolu_1\",\"name\":\"web_search\",\"input\":{}}}\n\n",
                "event: content_block_delta\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\\\"MAP-002\\\"}\"}}\n\n",
                "event: content_block_stop\n",
                "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                "event: content_block_start\n",
                "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"web_search_tool_result\",\"tool_use_id\":\"srvtoolu_1\",\"content\":[{\"title\":\"Doc\",\"url\":\"https://example.test\",\"text\":\"matched sse result\"}]}}\n\n",
                "event: content_block_stop\n",
                "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
                "event: content_block_start\n",
                "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                "event: content_block_delta\n",
                "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"text_delta\",\"text\":\"paired sse ok\"}}\n\n",
                "event: content_block_stop\n",
                "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
                "event: message_delta\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
                "event: message_stop\n",
                "data: {\"type\":\"message_stop\"}\n\n",
            ),
            "unpaired_ws" => concat!(
                "event: message_start\n",
                "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_ws_sse_unpaired\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"anthropic-wire\",\"content\":[],\"stop_reason\":null}}\n\n",
                "event: content_block_start\n",
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"web_search_tool_result\",\"tool_use_id\":\"srvtoolu_orphan\",\"content\":[{\"title\":\"Orphan\",\"url\":\"https://example.test\",\"text\":\"orphan\"}]}}\n\n",
                "event: content_block_stop\n",
                "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                "event: content_block_start\n",
                "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                "event: content_block_delta\n",
                "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"companion prose\"}}\n\n",
                "event: content_block_stop\n",
                "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
                "event: message_delta\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
                "event: message_stop\n",
                "data: {\"type\":\"message_stop\"}\n\n",
            ),
            other => {
                return Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(Body::from(format!("unexpected sse prompt: {other}")))
                    .unwrap();
            }
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(sse))
            .unwrap();
    }
    let content = match prompt {
        "paired_ws" => json!([
            {
                "type": "server_tool_use",
                "id": "srvtoolu_1",
                "name": "web_search",
                "input": {"query": "MAP-002"}
            },
            {
                "type": "web_search_tool_result",
                "tool_use_id": "srvtoolu_1",
                "content": [{"title": "Doc", "url": "https://example.test", "text": "matched result"}]
            },
            {"type": "text", "text": "paired ok"}
        ]),
        "unpaired_ws" => json!([
            {
                "type": "web_search_tool_result",
                "tool_use_id": "srvtoolu_orphan",
                "content": [{"title": "Orphan", "url": "https://example.test", "text": "orphan"}]
            },
            {"type": "text", "text": "companion prose"}
        ]),
        other => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from(format!("unexpected prompt: {other}")))
                .unwrap();
        }
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "msg_ws_primary",
                "type": "message",
                "role": "assistant",
                "model": "anthropic-wire",
                "content": content,
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 5, "output_tokens": 5}
            })
            .to_string(),
        ))
        .unwrap()
}

async fn web_search_backup_anthropic(
    State(state): State<Arc<WebSearchPairingUpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.backup_hits.fetch_add(1, Ordering::SeqCst);
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        let sse = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_ws_sse_backup\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"anthropic-backup-wire\",\"content\":[],\"stop_reason\":null}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"backup sse ok\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
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
                "id": "msg_ws_backup",
                "type": "message",
                "role": "assistant",
                "model": "anthropic-backup-wire",
                "content": [{"type": "text", "text": "backup ok"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 4, "output_tokens": 2}
            })
            .to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn map002_public_unpaired_web_search_tool_result_triggers_recovery_while_paired_succeeds() {
    let _lock = LOCK.lock().await;
    hub_v1_fixture::pin_test_process_refill_off();
    let home = Home::new("map002-ws-pairing");
    std::env::set_var("ONTOLOGY_WS_KEY", "ws-secret");

    let primary_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let primary_addr = primary_listener.local_addr().unwrap();
    let backup_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backup_addr = backup_listener.local_addr().unwrap();
    let state = Arc::new(WebSearchPairingUpstreamState::default());

    let (p_sd, p_stop) = oneshot::channel();
    let p_state = state.clone();
    let p_task = tokio::spawn(async move {
        let app = Router::new()
            .route("/v1/messages", post(web_search_primary_anthropic))
            .with_state(p_state);
        axum::serve(primary_listener, app)
            .with_graceful_shutdown(async {
                let _ = p_stop.await;
            })
            .await
            .unwrap();
    });
    let (b_sd, b_stop) = oneshot::channel();
    let b_state = state.clone();
    let b_task = tokio::spawn(async move {
        let app = Router::new()
            .route("/v1/messages", post(web_search_backup_anthropic))
            .with_state(b_state);
        axum::serve(backup_listener, app)
            .with_graceful_shutdown(async {
                let _ = b_stop.await;
            })
            .await
            .unwrap();
    });

    let listen_port = test_ports::free_port();
    let exhausted_port = test_ports::free_port();
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

[servers.exhausted]
bind = "127.0.0.1"
port = {}
routing_group = "exhausted_only"
endpoints = ["responses"]

{}

[providers.anthropic_primary]
type = "anthropic"
base_url = "http://{primary_addr}"
default_model = "anthropic-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_WS_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.anthropic_primary.models."anthropic-wire"]
wire_name = "anthropic-wire"
aliases = ["ws-alias"]
capabilities = ["text", "tools", "web_search"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.anthropic_backup]
type = "anthropic"
base_url = "http://{backup_addr}"
default_model = "anthropic-backup-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_WS_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.anthropic_backup.models."anthropic-backup-wire"]
wire_name = "anthropic-backup-wire"
capabilities = ["text", "tools", "web_search"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "anthropic_primary", model = "anthropic-wire", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "anthropic_backup", model = "anthropic-backup-wire", key = "key", priority = 1 }}
]

[route_groups.exhausted_only.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "anthropic_primary", model = "anthropic-wire", key = "key", priority = 1 }}
]
"#,
        relay_all_entry_protocols_declaration(),
        listen_port,
        hub_v1_fixture::hub_v1_server_execution("a"),
        exhausted_port,
        hub_v1_fixture::hub_v1_server_execution("exhausted"),
    );

    let mut manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    manifest.debug.codex_samples = true;
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();
    let recovery_samples = home
        .path
        .join(".rcc")
        .join("codex-samples")
        .join("openai-responses")
        .join("ports")
        .join(listen_port.to_string());
    let exhausted_samples = home
        .path
        .join(".rcc")
        .join("codex-samples")
        .join("openai-responses")
        .join("ports")
        .join(exhausted_port.to_string());
    let mut seen_recovery_dirs = std::collections::HashSet::<std::path::PathBuf>::new();
    let mut seen_exhausted_dirs = std::collections::HashSet::<std::path::PathBuf>::new();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    // 1) Paired server_tool_use + web_search_tool_result + text -> succeeds on first attempt.
    let paired = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "ws-alias",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "paired_ws"}]}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(paired.status(), StatusCode::OK);
    let paired_body: Value = paired.json().await.unwrap();
    let output = paired_body["output"].as_array().unwrap();
    assert!(
        output.iter().any(|item| item["type"] == "web_search_call"),
        "{paired_body}"
    );
    assert!(
        output
            .iter()
            .any(|item| item["type"] == "function_call_output" && item["call_id"] == "srvtoolu_1"),
        "{paired_body}"
    );
    assert_eq!(state.primary_hits.load(Ordering::SeqCst), 1);
    assert_eq!(state.backup_hits.load(Ordering::SeqCst), 0);

    // 2) Unpaired web_search_tool_result even with companion prose -> enters candidate recovery to backup.
    let unpaired = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "ws-alias",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "unpaired_ws"}]}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(unpaired.status(), StatusCode::OK);
    let unpaired_body: Value = unpaired.json().await.unwrap();
    assert_eq!(
        unpaired_body["output"][0]["content"][0]["text"],
        "backup ok"
    );
    assert_eq!(state.primary_hits.load(Ordering::SeqCst), 2);
    assert_eq!(state.backup_hits.load(Ordering::SeqCst), 1);

    server
        .wait_for_codex_sample_persistence()
        .await
        .expect("recovered unpaired ws attempt sample must persist");
    let recovery_evidence =
        read_next_failed_attempt_evidence(&recovery_samples, &mut seen_recovery_dirs).await;
    assert_eq!(
        recovery_evidence["attempts"][0]["provider_status"], 200,
        "upstream HTTP 200 must stay distinct from internal failure: {recovery_evidence}"
    );
    assert_eq!(
        recovery_evidence["attempts"][0]["status"], 502,
        "{recovery_evidence}"
    );
    assert_eq!(
        recovery_evidence["attempts"][0]["action"], "switch_provider",
        "{recovery_evidence}"
    );
    assert_eq!(
        recovery_evidence["attempts"][0]["diagnostic_source"]["source_kind"], "runtime_failure",
        "{recovery_evidence}"
    );
    assert_eq!(
        recovery_evidence["attempts"][0]["diagnostic_source"]["source_stage"],
        "V3ProviderResp14Raw",
        "{recovery_evidence}"
    );

    // 3) Exhausted single candidate with unpaired web_search_tool_result -> detectable transport abort,
    // retaining internal runtime_failure source and real upstream provider_status=200.
    let exhausted_resp = client
        .post(format!("http://127.0.0.1:{exhausted_port}/v1/responses"))
        .json(&json!({
            "model": "ws-alias",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "unpaired_ws"}]}],
            "stream": false
        }))
        .send()
        .await;
    assert_hard_json_failure(
        "unpaired_ws_exhausted",
        exhausted_resp,
        &[
            "UnpairedWebSearchToolResult",
            "srvtoolu_orphan",
            "companion prose",
        ],
    )
    .await;
    assert_eq!(state.primary_hits.load(Ordering::SeqCst), 3);
    assert_eq!(state.backup_hits.load(Ordering::SeqCst), 1);
    server
        .wait_for_codex_sample_persistence()
        .await
        .expect("exhausted unpaired ws failure sample must persist");
    let exhausted_evidence =
        read_next_failed_attempt_evidence(&exhausted_samples, &mut seen_exhausted_dirs).await;
    assert_eq!(
        exhausted_evidence["attempts"][0]["provider_status"], 200,
        "{exhausted_evidence}"
    );
    assert_eq!(
        exhausted_evidence["attempts"][0]["status"], 502,
        "{exhausted_evidence}"
    );
    assert_eq!(
        exhausted_evidence["terminal_source"]["source_kind"], "runtime_failure",
        "{exhausted_evidence}"
    );
    assert_eq!(
        exhausted_evidence["terminal_source"]["source_stage"], "V3ProviderResp14Raw",
        "{exhausted_evidence}"
    );

    // 4) SSE paired server_tool_use + input_json_delta + web_search_tool_result -> succeeds on attempt 1.
    let paired_sse = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "ws-alias",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "paired_ws"}]}],
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(paired_sse.status(), StatusCode::OK);
    let paired_sse_text = paired_sse.text().await.unwrap();
    assert!(
        paired_sse_text.contains("web_search_call")
            && paired_sse_text.contains("function_call_output")
            && paired_sse_text.contains("srvtoolu_1")
            && paired_sse_text.contains("MAP-002")
            && paired_sse_text.contains("paired sse ok")
            && paired_sse_text.contains("response.completed"),
        "expected paired SSE web_search delivery on first attempt: {paired_sse_text}"
    );
    assert_eq!(state.primary_hits.load(Ordering::SeqCst), 4);
    assert_eq!(state.backup_hits.load(Ordering::SeqCst), 1);

    // 5) SSE unpaired web_search_tool_result -> recovers to backup and records provider_status=200 + runtime_failure.
    let unpaired_sse = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "ws-alias",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "unpaired_ws"}]}],
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(unpaired_sse.status(), StatusCode::OK);
    let unpaired_sse_text = unpaired_sse.text().await.unwrap();
    assert!(
        unpaired_sse_text.contains("backup sse ok")
            && unpaired_sse_text.contains("response.completed")
            && !unpaired_sse_text.contains("companion prose"),
        "expected backup SSE delivery without primary leakage: {unpaired_sse_text}"
    );
    assert_eq!(state.primary_hits.load(Ordering::SeqCst), 5);
    assert_eq!(state.backup_hits.load(Ordering::SeqCst), 2);
    server
        .wait_for_codex_sample_persistence()
        .await
        .expect("recovered SSE unpaired ws attempt sample must persist");
    let sse_recovery_evidence =
        read_next_failed_attempt_evidence(&recovery_samples, &mut seen_recovery_dirs).await;
    assert_eq!(sse_recovery_evidence["attempts"][0]["provider_status"], 200);
    assert_eq!(sse_recovery_evidence["attempts"][0]["status"], 502);
    assert_eq!(
        sse_recovery_evidence["attempts"][0]["action"],
        "switch_provider"
    );
    assert_eq!(
        sse_recovery_evidence["attempts"][0]["diagnostic_source"]["source_kind"],
        "runtime_failure"
    );
    assert_eq!(
        sse_recovery_evidence["attempts"][0]["diagnostic_source"]["source_stage"],
        "V3ProviderResp14Raw"
    );

    // 6) SSE exhausted single candidate with unpaired web_search_tool_result -> detectable transport abort with runtime_failure + provider_status=200.
    let exhausted_sse = client
        .post(format!("http://127.0.0.1:{exhausted_port}/v1/responses"))
        .json(&json!({
            "model": "ws-alias",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "unpaired_ws"}]}],
            "stream": true
        }))
        .send()
        .await;
    assert_hard_sse_failure(
        "unpaired_ws_sse_exhausted",
        exhausted_sse,
        &[
            "UnpairedWebSearchToolResult",
            "srvtoolu_orphan",
            "companion prose",
        ],
    )
    .await;
    server
        .wait_for_codex_sample_persistence()
        .await
        .expect("exhausted SSE unpaired ws failure sample must persist");
    let sse_exhausted_evidence =
        read_next_failed_attempt_evidence(&exhausted_samples, &mut seen_exhausted_dirs).await;
    assert_eq!(
        sse_exhausted_evidence["attempts"][0]["provider_status"],
        200
    );
    assert_eq!(sse_exhausted_evidence["attempts"][0]["status"], 502);
    assert_eq!(
        sse_exhausted_evidence["terminal_source"]["source_kind"],
        "runtime_failure"
    );
    assert_eq!(
        sse_exhausted_evidence["terminal_source"]["source_stage"],
        "V3ProviderResp14Raw"
    );

    drop(server);
    let _ = p_sd.send(());
    let _ = b_sd.send(());
    let _ = p_task.await;
    let _ = b_task.await;
}

#[derive(Default)]
struct MislabeledSseContentTypeState {
    primary_hits: AtomicUsize,
    backup_hits: AtomicUsize,
}

#[tokio::test]
async fn map001_public_direct_json_body_with_sse_content_type_succeeds_first_attempt() {
    let _lock = LOCK.lock().await;
    hub_v1_fixture::pin_test_process_refill_off();
    let _home = Home::new("map001-mislabeled-sse-json");
    std::env::set_var("ONTOLOGY_SSE_JSON_KEY", "sse-json-secret");

    let primary_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let primary_addr = primary_listener.local_addr().unwrap();
    let backup_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backup_addr = backup_listener.local_addr().unwrap();
    let state = Arc::new(MislabeledSseContentTypeState::default());

    let (p_sd, p_stop) = oneshot::channel();
    let p_state = state.clone();
    let p_task = tokio::spawn(async move {
        let app = Router::new()
            .route(
                "/v1/responses",
                post(|State(s): State<Arc<MislabeledSseContentTypeState>>| async move {
                    s.primary_hits.fetch_add(1, Ordering::SeqCst);
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "text/event-stream")
                        .body(Body::from(
                            json!({
                                "id": "resp_mislabeled_ct",
                                "object": "response",
                                "status": "completed",
                                "model": "direct-wire",
                                "output": [{
                                    "type": "message",
                                    "role": "assistant",
                                    "content": [{"type": "output_text", "text": "mislabeled sse ct ok"}]
                                }],
                                "usage": {"input_tokens": 3, "output_tokens": 4, "total_tokens": 7}
                            })
                            .to_string(),
                        ))
                        .unwrap()
                }),
            )
            .with_state(p_state);
        axum::serve(primary_listener, app)
            .with_graceful_shutdown(async {
                let _ = p_stop.await;
            })
            .await
            .unwrap();
    });

    let (b_sd, b_stop) = oneshot::channel();
    let b_state = state.clone();
    let b_task = tokio::spawn(async move {
        let app = Router::new()
            .route(
                "/v1/responses",
                post(
                    |State(s): State<Arc<MislabeledSseContentTypeState>>| async move {
                        s.backup_hits.fetch_add(1, Ordering::SeqCst);
                        Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "application/json")
                            .body(Body::from(
                                json!({
                                    "id": "resp_backup_should_not_run",
                                    "object": "response",
                                    "status": "completed",
                                    "output": [{
                                        "type": "message",
                                        "role": "assistant",
                                        "content": [{"type": "output_text", "text": "backup"}]
                                    }]
                                })
                                .to_string(),
                            ))
                            .unwrap()
                    },
                ),
            )
            .with_state(b_state);
        axum::serve(backup_listener, app)
            .with_graceful_shutdown(async {
                let _ = b_stop.await;
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

[providers.direct_primary]
type = "responses"
base_url = "http://{primary_addr}/v1"
default_model = "direct-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_SSE_JSON_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.direct_primary.models."direct-wire"]
wire_name = "direct-wire"
aliases = ["mislabeled-alias"]
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.direct_backup]
type = "responses"
base_url = "http://{backup_addr}/v1"
default_model = "backup-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ONTOLOGY_SSE_JSON_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.direct_backup.models."backup-wire"]
wire_name = "backup-wire"
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "direct_primary", model = "direct-wire", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "direct_backup", model = "backup-wire", key = "key", priority = 1 }}
]
"#,
        hub_v1_fixture::hub_v1_test_declaration(),
        listen_port,
        hub_v1_fixture::hub_v1_server_execution("a"),
    );

    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    let resp = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "mislabeled-alias",
            "input": "Reply with only: ok",
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        ct.starts_with("application/json"),
        "expected application/json header for non-streaming response, got {ct}"
    );
    let body: Value = resp.json().await.unwrap();
    assert_eq!(
        body["output"][0]["content"][0]["text"],
        "mislabeled sse ct ok"
    );
    assert_eq!(state.primary_hits.load(Ordering::SeqCst), 1);
    assert_eq!(state.backup_hits.load(Ordering::SeqCst), 0);

    drop(server);
    let _ = p_sd.send(());
    let _ = b_sd.send(());
    let _ = p_task.await;
    let _ = b_task.await;
}
