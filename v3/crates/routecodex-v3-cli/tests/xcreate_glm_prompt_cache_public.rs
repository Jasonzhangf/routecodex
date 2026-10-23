//! Public-entry regression for issue ba8f3fe.
//!
//! The 4444 `/v1/responses` sample selected xcreate-free[key1]
//! `z-ai/glm-5.3-flash`; the OpenAI Chat upstream rejected the attempt with
//! HTTP 400 because `prompt_cache_key` is unsupported. RouteCodex then switched
//! providers, so the later 200 did not prove request-shape compatibility.
//!
//! The affected-scope tests start the real server aggregate, send the client
//! request through `/v1/responses`, and point the selected GLM Chat target at a
//! controlled loopback upstream. That upstream rejects `prompt_cache_key` with
//! HTTP 400 and otherwise returns a Chat completion. The test drives the full
//! client tool round trip: the first provider turn returns a tool call, the
//! client executes the declared `lookup` tool against a real local file, and
//! the follow-up carries the paired call/output history back to the provider.
//! It requires exactly one accepted attempt per turn, the selected GLM wire
//! model, removal of only the unsupported field, preservation of supported
//! fields, and the final client-visible Responses text.
//!
//! The unrelated-host control uses a provider outside the affected free GLM
//! Chat scope and an upstream that accepts both fields. That upstream must see
//! `prompt_cache_key` and `verbosity` unchanged, so removal outside the scope
//! fails the public entry.

use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{net::TcpListener, sync::Arc, time::Duration};
use tokio::sync::Mutex;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const PROVIDER_KEY_ENV: &str = "V3_XCREATE_FREE_GLM_PUBLIC_KEY";
const WIRE_MODEL: &str = "z-ai/glm-5.3-flash";
const CLIENT_MODEL: &str = "xcreate-glm-client";
const NVIDIA_WIRE_MODEL: &str = "z-ai/glm-5.3-flash";
const NVIDIA_CLIENT_MODEL: &str = "nvidia-glm-client";
const NVIDIA_KEY_ENV: &str = "V3_NVIDIA_GLM_PUBLIC_KEY";
const UNRELATED_WIRE_MODEL: &str = "z-ai/glm-5.3-flash";
const UNRELATED_CLIENT_MODEL: &str = "unrelated-glm-client";
const UNRELATED_KEY_ENV: &str = "V3_UNRELATED_GLM_PUBLIC_KEY";
const UNRELATED_MARKER: &str = "UNRELATED_GLM_PUBLIC_OK";
const CLIENT_MARKER: &str = "XCREATE_GLM_PUBLIC_OK";
const TOOL_NAME: &str = "lookup";
const TOOL_CALL_ID: &str = "call_xcreate_lookup_1";
const TOOL_QUERY: &str = "glm-prompt-cache";
const TOOL_RECEIPT: &str = "XCREATE_LOOKUP_RECEIPT: prompt_cache_key omitted";

#[derive(Clone)]
struct Upstream {
    captures: Arc<Mutex<Vec<Value>>>,
}

fn declared_tools() -> Value {
    json!([{
        "type": "function",
        "name": TOOL_NAME,
        "description": "Lookup docs",
        "parameters": {
            "type": "object",
            "properties": {"q": {"type": "string"}},
            "required": ["q"]
        }
    }])
}

async fn controlled_glm_upstream(
    State(state): State<Upstream>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    state.captures.lock().await.push(body.clone());
    if body.get("prompt_cache_key").is_some() || body.get("verbosity").is_some() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "type": "invalid_request_error",
                    "code": "invalid_request_error",
                    "message": "prompt_cache_key and verbosity are not supported by this GLM endpoint"
                }
            })),
        );
    }
    let has_tool_receipt = body["messages"].as_array().is_some_and(|messages| {
        messages
            .iter()
            .any(|message| message["role"] == "tool" && message["tool_call_id"] == TOOL_CALL_ID)
    });
    if has_tool_receipt {
        return (
            StatusCode::OK,
            Json(json!({
                "id": "chatcmpl-xcreate-glm-public-2",
                "object": "chat.completion",
                "model": WIRE_MODEL,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": CLIENT_MARKER},
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 7, "completion_tokens": 2, "total_tokens": 9}
            })),
        );
    }
    (
        StatusCode::OK,
        Json(json!({
            "id": "chatcmpl-xcreate-glm-public-1",
            "object": "chat.completion",
            "model": WIRE_MODEL,
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": TOOL_CALL_ID,
                        "type": "function",
                        "function": {
                            "name": TOOL_NAME,
                            "arguments": serde_json::to_string(&json!({"q": TOOL_QUERY}))
                                .expect("tool arguments serialize")
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}
        })),
    )
}

async fn controlled_preserving_glm_upstream(
    State(state): State<Upstream>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    state.captures.lock().await.push(body);
    (
        StatusCode::OK,
        Json(json!({
            "id": "chatcmpl-unrelated-glm-public-1",
            "object": "chat.completion",
            "model": UNRELATED_WIRE_MODEL,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": UNRELATED_MARKER},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 7, "completion_tokens": 2, "total_tokens": 9}
        })),
    )
}

async fn send_public(
    client: &reqwest::Client,
    endpoint: &str,
    body: &Value,
    captures: &Arc<Mutex<Vec<Value>>>,
) -> (StatusCode, Value) {
    let response = match client.post(endpoint).json(body).send().await {
        Ok(response) => response,
        Err(error) => {
            let observed = captures.lock().await.clone();
            panic!(
                "client must receive the accepted provider response, not a closed transport: {error}; upstream captures={observed:?}"
            );
        }
    };
    let status = response.status();
    let text = match response.text().await {
        Ok(text) => text,
        Err(error) => {
            let observed = captures.lock().await.clone();
            panic!(
                "client response body must complete, not close the transport: {error}; upstream captures={observed:?}"
            );
        }
    };
    let body = serde_json::from_str(&text).unwrap_or_else(|error| {
        panic!("client response must be JSON: status={status} body={text} error={error}")
    });
    (status, body)
}

#[tokio::test]
async fn xcreate_free_glm_chat_public_entry_omits_prompt_cache_key_and_completes_tool_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(PROVIDER_KEY_ENV, "controlled-xcreate-free-secret");

    let lookup_dir = tempfile::tempdir().expect("client tool fixture");
    std::fs::write(
        lookup_dir.path().join(format!("{TOOL_QUERY}.txt")),
        TOOL_RECEIPT,
    )
    .expect("client tool fixture write");

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("controlled upstream socket");
    let upstream_addr = upstream.local_addr().expect("controlled upstream address");
    let captures = Arc::new(Mutex::new(Vec::new()));
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(controlled_glm_upstream))
        .with_state(Upstream {
            captures: captures.clone(),
        });
    tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("serve controlled xcreate upstream");
    });

    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        upstream_addr.port(),
        "xcreate-free",
        WIRE_MODEL,
        CLIENT_MODEL,
        PROVIDER_KEY_ENV,
    ))
    .await
    .expect("real server aggregate must start");
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    let first_request = json!({
        "model": CLIENT_MODEL,
        "instructions": "keep supported instructions",
        "input": [{"role": "user", "content": "hello from xcreate"}],
        "prompt_cache_key": "session-1",
        "text": {"verbosity": "high"},
        "temperature": 0.2,
        "max_output_tokens": 321,
        "metadata": {"trace": "xcreate-glm-public"},
        "tools": declared_tools(),
        "stream": false
    });
    let (first_status, first_body) =
        send_public(&client, &endpoint, &first_request, &captures).await;
    assert_eq!(
        first_status,
        StatusCode::OK,
        "xcreate-free GLM Chat target must accept the first public-entry request: {first_body}"
    );
    assert_eq!(first_body["status"], "completed");
    let call = first_body["output"]
        .as_array()
        .and_then(|output| output.iter().find(|item| item["type"] == "function_call"))
        .cloned()
        .unwrap_or_else(|| {
            panic!("first response must carry the provider tool call: {first_body}")
        });
    assert_eq!(
        call["name"], TOOL_NAME,
        "tool identity must survive: {call}"
    );
    assert_eq!(
        call["call_id"], TOOL_CALL_ID,
        "tool call id must survive: {call}"
    );
    assert_eq!(
        call["arguments"],
        json!(r#"{"q":"glm-prompt-cache"}"#),
        "tool arguments must survive: {call}"
    );

    // Actual client execution: parse the model-returned arguments and read the
    // file the declared lookup tool addresses.
    let arguments: Value = serde_json::from_str(
        call["arguments"]
            .as_str()
            .expect("tool arguments must be a string"),
    )
    .expect("tool arguments must be JSON");
    let query = arguments["q"]
        .as_str()
        .expect("lookup arguments must carry q");
    let receipt = std::fs::read_to_string(lookup_dir.path().join(format!("{query}.txt")))
        .unwrap_or_else(|error| {
            panic!("actual client tool execution failed for query {query}: {error}")
        });
    assert_eq!(receipt, TOOL_RECEIPT);

    let mut followup_input = first_request["input"]
        .as_array()
        .expect("first request input array")
        .clone();
    followup_input.push(call);
    followup_input.push(json!({
        "type": "function_call_output",
        "call_id": TOOL_CALL_ID,
        "output": receipt,
    }));
    let followup_request = json!({
        "model": CLIENT_MODEL,
        "instructions": "keep supported instructions",
        "input": followup_input,
        "prompt_cache_key": "session-2",
        "text": {"verbosity": "high"},
        "temperature": 0.2,
        "max_output_tokens": 321,
        "metadata": {"trace": "xcreate-glm-public-followup"},
        "tools": declared_tools(),
        "stream": false
    });
    let (second_status, second_body) =
        send_public(&client, &endpoint, &followup_request, &captures).await;
    assert_eq!(
        second_status,
        StatusCode::OK,
        "the paired tool follow-up must reach the accepted target: {second_body}"
    );
    assert_eq!(second_body["status"], "completed");
    let output_text = second_body
        .pointer("/output/0/content/0/text")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("client-visible Responses output text missing: {second_body}"));
    assert_eq!(output_text, CLIENT_MARKER);
    assert!(
        second_body["output"]
            .as_array()
            .is_some_and(|output| output.iter().all(|item| item["type"] != "function_call")),
        "follow-up must terminate the tool round trip: {second_body}"
    );

    let observed = captures.lock().await;
    assert_eq!(
        observed.len(),
        2,
        "exactly one accepted upstream attempt per turn expected: {observed:?}"
    );
    let first_wire = &observed[0];
    let second_wire = &observed[1];
    for wire in [first_wire, second_wire] {
        assert_eq!(
            wire["model"], WIRE_MODEL,
            "upstream must bind the selected xcreate-free GLM wire model: {wire}"
        );
        assert!(
            wire.get("prompt_cache_key").is_none(),
            "only the unsupported prompt_cache_key must be omitted: {wire}"
        );
        assert!(
            wire.get("verbosity").is_none(),
            "only the unsupported verbosity must be omitted: {wire}"
        );
        assert!(
            wire.get("routecodex_chat_extension").is_none(),
            "provider wire must not leak the local response extension: {wire}"
        );
        let tool_names = wire["tools"]
            .as_array()
            .unwrap_or_else(|| panic!("provider tools missing: {wire}"))
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str())
            .collect::<Vec<_>>();
        assert!(
            tool_names.contains(&TOOL_NAME),
            "supported tool declaration lost: {wire}"
        );
        let messages = wire["messages"]
            .as_array()
            .unwrap_or_else(|| panic!("provider messages missing: {wire}"));
        assert!(
            messages.iter().any(|message| {
                message["role"] == "system"
                    && message["content"]
                        .as_str()
                        .is_some_and(|content| content.contains("keep supported instructions"))
            }),
            "supported instructions lost: {wire}"
        );
        assert!(
            messages.iter().any(|message| {
                message["role"] == "user"
                    && message["content"].as_str() == Some("hello from xcreate")
            }),
            "supported user input lost: {wire}"
        );
    }
    assert_eq!(
        first_wire["temperature"], 0.2,
        "supported field lost: {first_wire}"
    );
    assert_eq!(
        first_wire["max_completion_tokens"], 321,
        "supported output cap lost: {first_wire}"
    );
    assert_eq!(
        first_wire["metadata"]["trace"], "xcreate-glm-public",
        "supported metadata lost: {first_wire}"
    );
    assert_eq!(
        first_wire["stream"], false,
        "supported stream intent lost: {first_wire}"
    );
    let messages = second_wire["messages"]
        .as_array()
        .unwrap_or_else(|| panic!("follow-up provider messages missing: {second_wire}"));
    let historical_call = messages
        .iter()
        .flat_map(|message| message["tool_calls"].as_array().into_iter().flatten())
        .find(|call| call["id"] == TOOL_CALL_ID)
        .unwrap_or_else(|| panic!("paired assistant tool call lost: {second_wire}"));
    assert_eq!(
        historical_call["function"]["name"], TOOL_NAME,
        "historical tool identity lost: {second_wire}"
    );
    assert_eq!(
        historical_call["function"]["arguments"],
        json!(r#"{"q":"glm-prompt-cache"}"#),
        "historical tool arguments lost: {second_wire}"
    );
    let historical_result = messages
        .iter()
        .find(|message| message["role"] == "tool" && message["tool_call_id"] == TOOL_CALL_ID)
        .unwrap_or_else(|| panic!("paired tool result lost: {second_wire}"));
    assert_eq!(
        historical_result["content"], TOOL_RECEIPT,
        "actual client execution receipt lost: {second_wire}"
    );
    assert!(
        first_wire["tools"][0]["type"] == "function",
        "supported tool declaration lost: {first_wire}"
    );

    drop(observed);
    handle.shutdown().await;
    let _ = shutdown_tx.send(());
    std::env::remove_var(PROVIDER_KEY_ENV);
}

#[tokio::test]
async fn nvidia_glm_chat_public_entry_omits_prompt_cache_key_and_verbosity() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(NVIDIA_KEY_ENV, "controlled-nvidia-secret");

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("controlled nvidia upstream socket");
    let upstream_addr = upstream
        .local_addr()
        .expect("controlled nvidia upstream address");
    let captures = Arc::new(Mutex::new(Vec::new()));
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(controlled_glm_upstream))
        .with_state(Upstream {
            captures: captures.clone(),
        });
    tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("serve controlled nvidia upstream");
    });

    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        upstream_addr.port(),
        "nvidia",
        NVIDIA_WIRE_MODEL,
        NVIDIA_CLIENT_MODEL,
        NVIDIA_KEY_ENV,
    ))
    .await
    .expect("real nvidia server aggregate must start");
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    let request = json!({
        "model": NVIDIA_CLIENT_MODEL,
        "input": [{"role": "user", "content": "hello from nvidia"}],
        "prompt_cache_key": "session-nvidia",
        "text": {"verbosity": "high"},
        "tools": declared_tools(),
        "stream": false
    });
    let (status, body) = send_public(&client, &endpoint, &request, &captures).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "nvidia GLM Chat target must accept the public-entry request: {body}"
    );

    let observed = captures.lock().await;
    assert_eq!(
        observed.len(),
        1,
        "exactly one accepted nvidia attempt expected: {observed:?}"
    );
    let wire = &observed[0];
    assert_eq!(
        wire["model"], NVIDIA_WIRE_MODEL,
        "nvidia wire must bind the selected GLM model: {wire}"
    );
    assert!(
        wire.get("prompt_cache_key").is_none(),
        "nvidia GLM wire must omit prompt_cache_key: {wire}"
    );
    assert!(
        wire.get("verbosity").is_none(),
        "nvidia GLM wire must omit verbosity: {wire}"
    );
    assert!(wire.get("tools").is_some(), "supported tools lost: {wire}");

    drop(observed);
    handle.shutdown().await;
    let _ = shutdown_tx.send(());
    std::env::remove_var(NVIDIA_KEY_ENV);
}

#[tokio::test]
async fn unrelated_glm_chat_public_entry_preserves_prompt_cache_key_and_verbosity() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(UNRELATED_KEY_ENV, "controlled-unrelated-glm-secret");

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("controlled unrelated GLM upstream socket");
    let upstream_addr = upstream
        .local_addr()
        .expect("controlled unrelated GLM upstream address");
    let captures = Arc::new(Mutex::new(Vec::new()));
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(controlled_preserving_glm_upstream),
        )
        .with_state(Upstream {
            captures: captures.clone(),
        });
    tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("serve controlled preserving GLM upstream");
    });

    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        upstream_addr.port(),
        "unrelated-glm-host",
        UNRELATED_WIRE_MODEL,
        UNRELATED_CLIENT_MODEL,
        UNRELATED_KEY_ENV,
    ))
    .await
    .expect("real unrelated GLM server aggregate must start");
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    let request = json!({
        "model": UNRELATED_CLIENT_MODEL,
        "input": [{"role": "user", "content": "hello from unrelated host"}],
        "prompt_cache_key": "session-unrelated",
        "text": {"verbosity": "high"},
        "stream": false
    });
    let (status, body) = send_public(&client, &endpoint, &request, &captures).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "unrelated GLM Chat target must accept the public-entry request: {body}"
    );
    assert_eq!(body["status"], "completed");

    let observed = captures.lock().await;
    assert_eq!(
        observed.len(),
        1,
        "exactly one accepted unrelated attempt expected: {observed:?}"
    );
    let wire = &observed[0];
    assert_eq!(
        wire["model"], UNRELATED_WIRE_MODEL,
        "unrelated host wire must bind the selected GLM model: {wire}"
    );
    assert_eq!(
        wire["prompt_cache_key"], "session-unrelated",
        "unrelated GLM Chat target must preserve prompt_cache_key: {wire}"
    );
    assert_eq!(
        wire["verbosity"], "high",
        "unrelated GLM Chat target must preserve verbosity: {wire}"
    );
    assert!(
        wire.get("messages").is_some(),
        "supported messages lost: {wire}"
    );

    drop(observed);
    handle.shutdown().await;
    let _ = shutdown_tx.send(());
    std::env::remove_var(UNRELATED_KEY_ENV);
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
    upstream_port: u16,
    provider_id: &str,
    wire_model: &str,
    client_model: &str,
    key_env: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let declaration = hub_v1_fixture::hub_v1_test_declaration().replace(direct, relay);
    let execution = hub_v1_fixture::hub_v1_server_execution(provider_id);
    let source = format!(
        r#"
version = 3
{declaration}
[servers.{provider_id}]
bind = "127.0.0.1"
port = {server_port}
routing_group = "{provider_id}"
endpoints = ["responses"]
{execution}
[providers.{provider_id}]
type = "openai_chat"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "{wire_model}"
auth = {{ type = "api_key", entries = [{{ alias = "free", env = "{key_env}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "client" }}
[providers.{provider_id}.models."{wire_model}"]
wire_name = "{wire_model}"
aliases = ["{client_model}"]
capabilities = ["text", "tools"]
supports_streaming = true
[route_groups.{provider_id}.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["{client_model}"] }}
targets = [{{ kind = "provider_model", provider = "{provider_id}", model = "{wire_model}", key = "free", priority = 1 }}]
[route_groups.{provider_id}.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "{provider_id}", model = "{wire_model}", key = "free", priority = 1 }}]
[debug]
log_console = false
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}
