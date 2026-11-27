//! Public HTTP/SSE entry verification for MAP-001 / MAP-002 ontology
//! alignment and small-error response tolerance. No live providers contacted.

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
    openai_chat_hits: AtomicUsize,
}

async fn anthropic_upstream(
    State(state): State<Arc<RelayUpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    eprintln!("[test-upstream] anthropic_upstream received body={body}");
    state.anthropic_requests.lock().unwrap().push(body.clone());
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
    let _home = Home::new("map001-map002");
    std::env::set_var("ONTOLOGY_ANTHROPIC_KEY", "anthropic-secret");
    std::env::set_var("ONTOLOGY_OPENAI_KEY", "openai-secret");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(RelayUpstreamState::default());
    let app = Router::new()
        .route("/v1/messages", post(anthropic_upstream))
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
    let source = format!(
        r#"
version = 3
{}

[servers.a]
bind = "127.0.0.1"
port = {}
routing_group = "default"
endpoints = ["responses", "anthropic"]

[servers.a.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]

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
"#,
        relay_responses_and_anthropic_declaration(),
        listen_port
    );

    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    // 1) JSON /v1/responses with unmatched outbound fields (store=true, prompt_cache_key)
    // omits only the unmatched fields, hits anthropic_primary on first attempt (no reselection),
    // and delivers text despite container_upload + empty unsigned thinking + unpaired search result + unknown stop_reason.
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

    // 2) SSE /v1/responses with unmatched outbound field + unknown SSE events/delta + empty unsigned thinking + unknown stop_reason.
    let sse_resp = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/responses"))
        .json(&json!({
            "model": "client-alias",
            "input": "hello sse",
            "store": true,
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

    // 3) MAP-001 Inbound /v1/messages preserves multi-key metadata losslessly without inbound rejection.
    let anthropic_inbound_resp = client
        .post(format!("http://127.0.0.1:{listen_port}/v1/messages"))
        .json(&json!({
            "model": "client-alias",
            "max_tokens": 128,
            "metadata": {
                "user_id": "u-public-1",
                "custom_trace": "trace-abc",
                "session_hint": 42
            },
            "messages": [{"role": "user", "content": "hi from anthropic"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(anthropic_inbound_resp.status(), StatusCode::OK);

    // Verify first-attempt delivery without reselection to openai_fallback.
    assert_eq!(
        state.openai_chat_hits.load(Ordering::SeqCst),
        0,
        "allowlist absence or small response quirks must not reselect fallback provider"
    );
    let captured = state.anthropic_requests.lock().unwrap();
    assert!(
        captured.len() >= 3,
        "expected all 3 client requests to hit anthropic_primary: {captured:?}"
    );
    assert!(captured[0].get("store").is_none(), "{}", captured[0]);
    assert!(
        captured[0].get("prompt_cache_key").is_none(),
        "{}",
        captured[0]
    );
    assert!(
        captured
            .iter()
            .any(|req| req.get("metadata").and_then(|m| m.get("user_id"))
                == Some(&json!("u-public-1"))),
        "expected anthropic inbound metadata.user_id to survive: {captured:?}"
    );

    drop(server);
    let _ = shutdown.send(());
    let _ = task.await;
}
