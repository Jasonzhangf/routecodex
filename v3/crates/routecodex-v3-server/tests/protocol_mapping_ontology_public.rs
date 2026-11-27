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
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"future_terminal\",\"stop_sequence\":null}}\n\n",
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
                "stop_reason": "future_terminal",
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

    // 2) SSE /v1/responses with unmatched outbound fields + unknown SSE events/delta + empty unsigned thinking + unknown stop_reason.
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
    hits: AtomicUsize,
}

async fn negative_anthropic_upstream(
    State(state): State<Arc<NegativeUpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.hits.fetch_add(1, Ordering::SeqCst);
    let prompt = body["messages"][0]["content"][0]["text"]
        .as_str()
        .or_else(|| body["messages"][0]["content"].as_str())
        .unwrap_or("");
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        let sse = match prompt {
            "cross_protocol_sse" => concat!(
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
            ),
            "missing_block_type_sse" => concat!(
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
            ),
            _ => "",
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(sse))
            .unwrap();
    }

    let response_json = match prompt {
        "missing_stop_sequence_json" => json!({
            "id": "msg_bad_seq",
            "type": "message",
            "role": "assistant",
            "model": "anthropic-wire",
            "content": [{"type": "text", "text": "stopped without sequence"}],
            "stop_reason": "stop_sequence",
            "usage": {"input_tokens": 5, "output_tokens": 3}
        }),
        "empty_attempt_json" => json!({
            "id": "msg_empty_attempt",
            "type": "message",
            "role": "assistant",
            "model": "anthropic-wire",
            "content": [
                {"type": "container_upload", "file_id": "file_only"},
                {"type": "thinking", "thinking": ""}
            ],
            "stop_reason": "future_terminal",
            "usage": {"input_tokens": 5, "output_tokens": 0}
        }),
        _ => json!({}),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(response_json.to_string()))
        .unwrap()
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
endpoints = ["responses", "anthropic"]

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

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "anthropic_primary", model = "anthropic-wire", key = "key", priority = 1 }}
]
"#,
        relay_responses_and_anthropic_declaration(),
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
    if let Ok(resp) = bad_store {
        assert_ne!(resp.status(), StatusCode::OK);
    }
    assert_eq!(state.hits.load(Ordering::SeqCst), 0);

    // 2) Cross-protocol SSE frame mid-stream must abort attempt rather than committing response.completed.
    let cross_sse = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "cross_protocol_sse",
            "stream": true
        }))
        .send()
        .await;
    if let Ok(resp) = cross_sse {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        assert!(
            status != StatusCode::OK || !body.contains("response.completed"),
            "cross-protocol SSE must not commit response.completed: status={status} body={body}"
        );
    }

    // 3) Missing content[].type in Anthropic SSE alongside valid text must fail attempt.
    let missing_block_type = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "missing_block_type_sse",
            "stream": true
        }))
        .send()
        .await;
    if let Ok(resp) = missing_block_type {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        assert!(
            status != StatusCode::OK || !body.contains("response.completed"),
            "missing SSE block type must not commit response.completed: status={status} body={body}"
        );
    }

    // 4) stop_reason=stop_sequence without stop_sequence must fail attempt (no fabricated completion).
    let missing_seq = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "missing_stop_sequence_json",
            "stream": false
        }))
        .send()
        .await;
    if let Ok(resp) = missing_seq {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        assert!(
            status != StatusCode::OK,
            "missing stop_sequence must not return HTTP 200: status={status} body={body}"
        );
    }

    // 5) Attempt with only unrepresentable/empty blocks and no deliverable output must fail GovernedAttemptEmpty.
    let empty_attempt = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "empty_attempt_json",
            "stream": false
        }))
        .send()
        .await;
    if let Ok(resp) = empty_attempt {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        assert!(
            status != StatusCode::OK,
            "empty deliverable attempt must not fabricate HTTP 200 completion: status={status} body={body}"
        );
    }

    drop(server);
    let _ = shutdown.send(());
    let _ = task.await;
}
