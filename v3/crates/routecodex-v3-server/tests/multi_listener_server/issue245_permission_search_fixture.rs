use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

use super::{TestHomeGuard, HUB_V1_TEST_DECLARATION, TEST_LOCK};

const KEY_ENV: &str = "V3_ISSUE245_PERMISSION_TEST_KEY";
const PROVIDER_A: &str = "denied";
const PROVIDER_B: &str = "healthy";
static DENIED_PROBE_RECOVERS: AtomicBool = AtomicBool::new(false);
static DENIED_PROBE_FAILURES: AtomicUsize = AtomicUsize::new(0);
static DENIED_PROBE_SUCCESSES: AtomicUsize = AtomicUsize::new(0);

fn assert_wire_tool(body: &Value) {
    let expected = json!({"type":"function", "function":{
        "name":"issue245_continuation", "description":"issue245 paired continuation",
        "parameters":{"type":"object", "properties":{
            "nonce":{"type":"string"}, "query":{"type":"string"}
        }, "required":["nonce", "query"]}
    }});
    let tool = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["function"]["name"] == "issue245_continuation")
        .expect("wire must retain the declared client tool");
    assert_eq!(
        tool, &expected,
        "full tool declaration must survive provider projection"
    );
}

fn execute_nonce_handler(arguments: &Value) -> String {
    let nonce = arguments["nonce"].as_str().expect("nonce string");
    let query = arguments["query"].as_str().expect("query string");
    format!("ISSUE245_TOOL_RESULT:{nonce}:{query}")
}

#[derive(Debug)]
struct ProviderCapture {
    upstream: &'static str,
    path: String,
    authorization: Option<String>,
    body: Value,
}

#[derive(Clone)]
struct UpstreamState {
    upstream: &'static str,
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

/// One conditional business handler for both providers.
///
/// The request marker decides success or failure. Business sends always carry
/// the client tool history; probes carry the fixed "ping; reply pong" body and
/// are therefore distinguishable inside the handler, never by an extra header.
async fn conditional_upstream(
    State(state): State<Arc<UpstreamState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    let is_probe =
        body.pointer("/messages/0/content").and_then(Value::as_str) == Some("ping; reply pong");
    if !is_probe {
        assert_wire_tool(&body);
        let marker = body
            .pointer("/messages/0/content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        // Actual provider HTTP error channel: candidate A returns HTTP 400 with
        // a real typed error body. This is a Provider failure, never a client
        // response. Candidate B is the healthy fallback and must not see the
        // same marker as a failure.
        if marker == "ISSUE245_EXHAUST"
            || (state.upstream == PROVIDER_A && marker.starts_with("ISSUE245_PERMISSION_DENIED_"))
        {
            state
                .captures
                .send(ProviderCapture {
                    upstream: state.upstream,
                    path: "/v1/chat/completions".to_string(),
                    authorization: headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        .map(ToOwned::to_owned),
                    body: body.clone(),
                })
                .expect("capture receiver remains live");
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "error": {
                            "type": "permission_error",
                            "code": "11128",
                            "message": "Illegal API invocation from an unapproved channel"
                        }
                    })
                    .to_string(),
                ))
                .unwrap();
        }
        // B must verify exact tools, arguments, call ID and result before it
        // answers the follow-up. A nonce is returned from complete arguments.
        let call_id = "call_issue245_continuation";
        let expected_arguments = json!({
            "nonce": "ISSUE245_NONCE_0001",
            "query": "issue245 paired tool continuation"
        })
        .to_string();
        let expected_result =
            "ISSUE245_TOOL_RESULT:ISSUE245_NONCE_0001:issue245 paired tool continuation";
        let has_paired_history = body["messages"].as_array().is_some_and(|messages| {
            let assistant_call = messages.iter().any(|message| {
                message["role"] == "assistant"
                    && message["tool_calls"].as_array().is_some_and(|calls| {
                        calls.iter().any(|call| {
                            call["id"] == call_id
                                && call["function"]["name"] == "issue245_continuation"
                                && call["function"]["arguments"] == expected_arguments
                        })
                    })
            });
            let paired_result = messages.iter().any(|message| {
                message["role"] == "tool"
                    && message["tool_call_id"] == call_id
                    && message["content"] == expected_result
            });
            assistant_call && paired_result
        });
        state
            .captures
            .send(ProviderCapture {
                upstream: state.upstream,
                path: "/v1/chat/completions".to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    .map(ToOwned::to_owned),
                body: body.clone(),
            })
            .expect("capture receiver remains live");
        if has_paired_history {
            return chat_response(json!([{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "ISSUE245_CONTINUATION_OK"
                },
                "finish_reason": "stop"
            }]));
        }
        // First business turn: B delivers a real function call with complete
        // arguments the client must actually execute.
        return chat_response(json!([{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": "issue245_continuation",
                        "arguments": expected_arguments
                    }
                }]
            },
            "finish_reason": "tool_calls"
        }]));
    }
    if state.upstream == PROVIDER_A && !DENIED_PROBE_RECOVERS.load(Ordering::SeqCst) {
        DENIED_PROBE_FAILURES.fetch_add(1, Ordering::SeqCst);
        return Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"type":"api_error","message":"controlled failed probe"}})
                    .to_string(),
            ))
            .unwrap();
    }
    if state.upstream == PROVIDER_A {
        DENIED_PROBE_SUCCESSES.fetch_add(1, Ordering::SeqCst);
    }
    // A matching successful semantic probe can restore this identity.
    chat_response(json!([{
        "index": 0,
        "message": {"role": "assistant", "content": "pong"},
        "finish_reason": "stop"
    }]))
}

fn chat_response(choices: Value) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "chatcmpl-issue245",
                "object": "chat.completion",
                "model": "chat-wire",
                "choices": choices,
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
            })
            .to_string(),
        ))
        .unwrap()
}

async fn start_upstream(
    upstream: &'static str,
    captures: mpsc::UnboundedSender<ProviderCapture>,
) -> (String, oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(conditional_upstream))
        .route("/v1/responses", post(hosted_upstream))
        .with_state(Arc::new(UpstreamState { upstream, captures }));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{address}/v1"), shutdown_tx)
}

async fn hosted_upstream(
    State(state): State<Arc<UpstreamState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    assert_eq!(state.upstream, "hosted");
    assert_eq!(body["model"], "hosted-wire");
    let is_probe = body["input"].to_string().contains("ping; reply pong");
    if !is_probe {
        assert!(
            body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["type"] == "web_search"),
            "native hosted search must keep its native tool: {body}"
        );
        assert!(!body.to_string().contains("call_issue245_prior_search"));
        state
            .captures
            .send(ProviderCapture {
                upstream: state.upstream,
                path: "/v1/responses".into(),
                authorization: headers
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .map(ToOwned::to_owned),
                body,
            })
            .unwrap();
    }
    Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id":"resp_issue245_hosted", "object":"response", "status":"completed",
                "model":"hosted-wire", "output":[{"type":"message", "role":"assistant",
                    "content":[{"type":"output_text", "text":"ISSUE245_HOSTED_OK"}]}]
            })
            .to_string(),
        ))
        .unwrap()
}

/// Search continuation and native hosted search have separate explicit pools.
fn manifest(
    port: u16,
    base_a: &str,
    base_b: &str,
    base_hosted: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    assert!(HUB_V1_TEST_DECLARATION.contains(direct_binding));
    let hub_v1_declaration = HUB_V1_TEST_DECLARATION.replace(direct_binding, relay_binding);
    let server_execution = r#"
[servers.issue245.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
"#;
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}
[servers.issue245]
bind = "127.0.0.1"
port = {port}
routing_group = "issue245"
endpoints = ["responses"]
{server_execution}
[providers.denied]
type = "openai_chat"
base_url = "{base_a}"
default_model = "chat-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.denied.models.chat-wire]
wire_name = "chat-wire"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[providers.healthy]
type = "openai_chat"
base_url = "{base_b}"
default_model = "chat-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.healthy.models.chat-wire]
wire_name = "chat-wire"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[providers.hosted]
type = "responses"
base_url = "{base_hosted}"
default_model = "hosted-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "client" }}
[providers.hosted.models.hosted-wire]
wire_name = "hosted-wire"
capabilities = ["text", "web_search"]
web_search_execution_mode = "native_remote_search_tool_mix"
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[debug]
log_console = true
snapshots = false
codex_samples = false
[route_groups.issue245.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "healthy", model = "chat-wire", key = "key", priority = 1 }}]
[route_groups.issue245.pools.search]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses" }}
targets = [{{ kind = "provider_model", provider = "denied", model = "chat-wire", key = "key", priority = 2 }}, {{ kind = "provider_model", provider = "healthy", model = "chat-wire", key = "key", priority = 1 }}]
[route_groups.issue245.pools.web_search]
selection = {{ strategy = "priority" }}
match = {{ precedence = 20, entry_protocol = "responses" }}
targets = [{{ kind = "provider_model", provider = "hosted", model = "hosted-wire", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn cooldown_pool(client: &reqwest::Client, base: &str) -> Value {
    let response = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .expect("cooldown pool request must complete");
    assert_eq!(response.status(), 200);
    response.json::<Value>().await.unwrap()
}

fn find_entry<'a>(pool: &'a Value, provider: &str) -> Option<&'a Value> {
    pool["entries"].as_array().unwrap().iter().find(|entry| {
        entry["provider_id"] == provider
            && entry["auth_alias"] == "key"
            && entry["model_id"] == "chat-wire"
    })
}
