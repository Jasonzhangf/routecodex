//! Public-entry regression for canonical issue 35f96d3.
//!
//! The LaneAI DeepSeek Anthropic Relay path reaches a strict `qingyanx`
//! Responses backend that rejects `input[]` items of type `reasoning` and
//! `tools[]` entries of type `tool_search`. Without the declared
//! `responses:strict-legacy-input` compatibility profile the proxy forwards the
//! raw shape and the backend answers HTTP 400. With the profile declared the
//! request is projected into the older schema and the same public request
//! succeeds.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{net::TcpListener, sync::Arc, time::Duration};
use tokio::sync::Mutex;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const PROVIDER_MODEL: &str = "deepseek-v3.1";
const PROVIDER_KEY_ENV: &str = "V3_STRICT_LEGACY_COMPAT_KEY";
const PROVIDER_KEY: &str = "strict-key";

#[derive(Clone)]
struct StrictLegacyGateway {
    responses: Arc<Mutex<Vec<Value>>>,
    rejections: Arc<Mutex<Vec<String>>>,
    expected_authorization: String,
}

fn rejected_variant(body: &Value) -> Option<String> {
    if let Some(input) = body["input"].as_array() {
        if input.iter().any(|item| item["type"] == "reasoning") {
            return Some(
                "input: data did not match any variant of untagged enum ResponseInput".to_string(),
            );
        }
        if input.iter().any(|item| item["type"] == "custom_tool_call") {
            return Some(
                "input: data did not match any variant of untagged enum ResponseInput".to_string(),
            );
        }
    }
    if let Some(tools) = body["tools"].as_array() {
        if tools.iter().any(|tool| tool["type"] == "custom") {
            return Some(
                "tools[0].type: unknown variant `custom`, expected `function`".to_string(),
            );
        }
        if tools.iter().any(|tool| tool["type"] == "tool_search") {
            return Some(
                "tools[0].type: unknown variant `tool_search`, expected one of \
                 `function`, `custom`, `web_search`"
                    .to_string(),
            );
        }
    }
    None
}

fn bad_request(reason: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error": {"message": reason}})),
    )
        .into_response()
}

async fn responses_gateway(
    State(state): State<StrictLegacyGateway>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    assert_eq!(
        headers.get("authorization").unwrap(),
        state.expected_authorization.as_str()
    );
    state.responses.lock().await.push(body.clone());
    if let Some(reason) = rejected_variant(&body) {
        state.rejections.lock().await.push(reason.clone());
        return bad_request(reason);
    }
    (
        StatusCode::OK,
        Json(json!({
            "id": "resp_strict_1",
            "object": "response",
            "created_at": 1,
            "status": "completed",
            "model": PROVIDER_MODEL,
            "output": [{
                "id": "msg_strict_1",
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "ok"}]
            }]
        })),
    )
        .into_response()
}

async fn start_gateway() -> (
    String,
    Arc<Mutex<Vec<Value>>>,
    Arc<Mutex<Vec<String>>>,
    tokio::task::JoinHandle<()>,
) {
    start_gateway_with_authorization("Bearer strict-key").await
}

async fn start_gateway_with_authorization(
    authorization: &str,
) -> (
    String,
    Arc<Mutex<Vec<Value>>>,
    Arc<Mutex<Vec<String>>>,
    tokio::task::JoinHandle<()>,
) {
    let responses = Arc::new(Mutex::new(Vec::new()));
    let rejections = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn({
        let state = StrictLegacyGateway {
            responses: responses.clone(),
            rejections: rejections.clone(),
            expected_authorization: authorization.to_string(),
        };
        async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/v1/responses", post(responses_gateway))
                    .with_state(state),
            )
            .await
            .unwrap()
        }
    });
    (upstream, responses, rejections, task)
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn manifest(
    port: u16,
    upstream: &str,
    profile: Option<&str>,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("test");
    let profile_line = profile
        .map(|profile| format!("compatibility_profile = \"{profile}\"\n"))
        .unwrap_or_default();
    let source = format!(
        r#"
version = 3
{declaration}
[servers.test]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}

[providers.gateway]
type = "responses"
base_url = "{upstream}/v1"
default_model = "{PROVIDER_MODEL}"
{profile_line}responses = {{ process = "direct", streaming = "never" }}
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.gateway.models."{PROVIDER_MODEL}"]
wire_name = "{PROVIDER_MODEL}"
capabilities = ["text", "tools", "reasoning"]
supports_streaming = false
max_tokens = 4096
max_context_tokens = 128000

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "gateway", model = "{PROVIDER_MODEL}", key = "key", priority = 1 }}]

[debug]
log_console = false
snapshots = false
dry_run = false
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn manifest_with_image_history_sibling(
    port: u16,
    strict_upstream: &str,
    sibling_upstream: &str,
    process: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let declaration = hub_v1_fixture::hub_v1_test_declaration()
        .replace(direct, if process == "chat" { relay } else { direct });
    let execution = hub_v1_fixture::hub_v1_server_execution("test");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.test]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}

[providers.qingyanx]
type = "responses"
base_url = "{strict_upstream}/v1"
default_model = "{PROVIDER_MODEL}"
compatibility_profile = "responses:strict-legacy-input"
responses = {{ process = "{process}", streaming = "never" }}
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.qingyanx.models."{PROVIDER_MODEL}"]
wire_name = "{PROVIDER_MODEL}"
capabilities = ["text", "tools", "reasoning"]
supports_streaming = false
max_tokens = 4096
max_context_tokens = 128000

[providers.sibling]
type = "responses"
base_url = "{sibling_upstream}/v1"
default_model = "{PROVIDER_MODEL}"
responses = {{ process = "{process}", streaming = "never" }}
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.sibling.models."{PROVIDER_MODEL}"]
wire_name = "{PROVIDER_MODEL}"
capabilities = ["text", "tools", "reasoning"]
supports_streaming = false
max_tokens = 4096
max_context_tokens = 128000

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
    {{ kind = "provider_model", provider = "qingyanx", model = "{PROVIDER_MODEL}", key = "key", priority = 2 }},
    {{ kind = "provider_model", provider = "sibling", model = "{PROVIDER_MODEL}", key = "key", priority = 1 }}
]

[debug]
log_console = false
snapshots = false
dry_run = false
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn manifest_with_image_history_only(
    port: u16,
    strict_upstream: &str,
    process: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let declaration = hub_v1_fixture::hub_v1_test_declaration()
        .replace(direct, if process == "chat" { relay } else { direct });
    let execution = hub_v1_fixture::hub_v1_server_execution("test");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.test]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}

[providers.qingyanx]
type = "responses"
base_url = "{strict_upstream}/v1"
default_model = "{PROVIDER_MODEL}"
compatibility_profile = "responses:strict-legacy-input"
responses = {{ process = "{process}", streaming = "never" }}
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.qingyanx.models."{PROVIDER_MODEL}"]
wire_name = "{PROVIDER_MODEL}"
capabilities = ["text", "tools", "reasoning"]
supports_streaming = false
max_tokens = 4096
max_context_tokens = 128000

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
    {{ kind = "provider_model", provider = "qingyanx", model = "{PROVIDER_MODEL}", key = "key", priority = 1 }}
]

[debug]
log_console = false
snapshots = false
dry_run = false
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn strict_request() -> Value {
    json!({
        "model": format!("gateway.{PROVIDER_MODEL}"),
        "stream": false,
        "tools": [
            {"type": "custom", "name": "apply_patch", "description": "Apply patch"},
            {"type": "function", "name": "exec_command", "parameters": {
                "type": "object", "properties": {"cmd": {"type": "string"}}, "required": ["cmd"]
            }},
            {"type": "tool_search", "name": "tool_search", "description": "Search tools",
             "parameters": {"type": "object", "properties": {"query": {"type": "string"}}},
             "x_qingyanx_extension": {"preserve": true}}
        ],
        "tool_choice": "auto",
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "find a tool"}]},
            {"type": "custom_tool_call", "call_id": "call_patch", "name": "apply_patch", "input": "*** Begin Patch\n*** End Patch"},
            {"type": "custom_tool_call_output", "call_id": "call_patch", "output": "EXECUTED:patch"},
            {"type": "function_call", "call_id": "call_exec", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
            {"type": "function_call_output", "call_id": "call_exec", "output": "ORDINARY:ok"},
            {"type": "reasoning", "summary": []}
        ]
    })
}

fn image_history_request() -> Value {
    json!({
        "model": format!("gateway.{PROVIDER_MODEL}"),
        "stream": false,
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect the image"}]
            },
            {
                "type": "function_call",
                "call_id": "call_view",
                "name": "view_image",
                "arguments": "{\"path\":\"/tmp/image.png\"}"
            },
            {
                "type": "function_call_output",
                "call_id": "call_view",
                "output": [{
                    "type": "input_image",
                    "image_url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
                }]
            }
        ]
    })
}

async fn post_public(server: &routecodex_v3_server::V3ServerAggregateHandle) -> (bool, String) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let url = format!("http://{}/v1/responses", server.listeners[0].addr);
    match client.post(&url).json(&strict_request()).send().await {
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            (status.is_success(), format!("{status} {body}"))
        }
        Err(error) => (false, format!("transport error: {error}")),
    }
}

async fn post_image_history(
    server: &routecodex_v3_server::V3ServerAggregateHandle,
) -> (bool, String) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let url = format!("http://{}/v1/responses", server.listeners[0].addr);
    match client
        .post(&url)
        .json(&image_history_request())
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            (status.is_success(), format!("{status} {body}"))
        }
        Err(error) => (false, format!("transport error: {error}")),
    }
}

async fn post_image_history_transport(
    server: &routecodex_v3_server::V3ServerAggregateHandle,
) -> Result<reqwest::Response, reqwest::Error> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let url = format!("http://{}/v1/responses", server.listeners[0].addr);
    client
        .post(&url)
        .json(&image_history_request())
        .send()
        .await
}

async fn assert_image_history_exhaustion(
    server: &routecodex_v3_server::V3ServerAggregateHandle,
    strict_responses: &Arc<Mutex<Vec<Value>>>,
    strict_rejections: &Arc<Mutex<Vec<String>>>,
) {
    let client_result = post_image_history_transport(server).await;
    match client_result {
        Err(error) => {
            let detail = error.to_string();
            assert!(
                !detail.is_empty(),
                "the request-local exhaustion must expose a transport error"
            );
        }
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            panic!(
                "request-local compatibility exhaustion must not return HTTP {status} or a body: {body}"
            );
        }
    }
    assert!(
        strict_responses.lock().await.is_empty(),
        "the strict-legacy candidate must be excluded before Provider send"
    );
    assert!(
        strict_rejections.lock().await.is_empty(),
        "the strict candidate must not receive an HTTP 400 request"
    );

    let base = format!("http://{}", server.listeners[0].addr);
    let pool: Value = reqwest::Client::new()
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .expect("cooldown-pool observability must remain available")
        .json()
        .await
        .expect("cooldown-pool response must be JSON");
    assert_eq!(
        pool["entries"].as_array().map(Vec::len),
        Some(0),
        "request-local compatibility exhaustion must keep provider health neutral: {pool}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn strict_legacy_input_red_before_profile_rejects_raw_shape() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(PROVIDER_KEY_ENV, PROVIDER_KEY);
    let (upstream, responses, rejections, upstream_task) = start_gateway().await;
    let server = spawn_v3_server_aggregate(manifest(free_port(), &upstream, None))
        .await
        .unwrap();

    let (success, detail) = post_public(&server).await;
    assert!(
        !success,
        "without the profile the strict backend must reject the raw shape: {detail}"
    );
    let captured = responses.lock().await.clone();
    assert_eq!(captured.len(), 1, "exactly one provider attempt expected");
    assert!(
        captured[0]["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["type"] == "reasoning"),
        "red baseline forwarded the reasoning input item unchanged"
    );
    assert!(
        captured[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["type"] == "tool_search"),
        "red baseline forwarded the tool_search tool unchanged"
    );
    assert!(
        captured[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["type"] == "custom"),
        "red baseline forwarded the custom tool declaration unchanged"
    );
    assert_eq!(
        rejections.lock().await.len(),
        1,
        "the strict backend recorded the raw-shape rejection"
    );
    server.shutdown().await;
    upstream_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn strict_legacy_input_green_after_profile_projects_and_succeeds() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(PROVIDER_KEY_ENV, PROVIDER_KEY);
    let (upstream, responses, rejections, upstream_task) = start_gateway().await;
    let server = spawn_v3_server_aggregate(manifest(
        free_port(),
        &upstream,
        Some("responses:strict-legacy-input"),
    ))
    .await
    .unwrap();

    let (success, detail) = post_public(&server).await;
    assert!(
        success,
        "projected request must reach the strict backend: {detail}"
    );
    assert!(
        rejections.lock().await.is_empty(),
        "projected request must not be rejected: {:?}",
        rejections.lock().await
    );
    let captured = responses.lock().await.clone();
    assert_eq!(captured.len(), 1, "exactly one provider attempt expected");
    assert!(
        !captured[0]["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["type"] == "reasoning"),
        "reasoning input items must be projected out"
    );
    let tools = captured[0]["tools"].as_array().unwrap();
    assert!(
        tools.iter().all(|tool| tool["type"] == "function"),
        "every tool must be projected to a function declaration: {tools:?}"
    );
    assert!(
        tools.iter().any(|tool| tool["name"] == "tool_search"),
        "tool_search must be projected to a function tool"
    );
    assert_eq!(
        tools
            .iter()
            .find(|tool| tool["name"] == "tool_search")
            .unwrap()["x_qingyanx_extension"],
        json!({"preserve": true}),
        "unrelated tool_search fields must survive the strict-legacy projection"
    );
    assert!(
        tools
            .iter()
            .any(|tool| tool["name"] == "routecodex_custom__6170706c795f7061746368"),
        "custom tool must be projected to its wire function name"
    );
    assert!(
        captured[0]["input"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["type"] != "custom_tool_call"
                && item["type"] != "custom_tool_call_output"),
        "custom_tool_call history must be projected to function_call history"
    );
    assert_eq!(captured[0]["tool_choice"], "auto");
    server.shutdown().await;
    upstream_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn strict_legacy_image_history_reselects_before_provider_send() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(PROVIDER_KEY_ENV, PROVIDER_KEY);
    let (strict_upstream, strict_responses, strict_rejections, strict_task) =
        start_gateway_with_authorization("Bearer strict-key").await;
    let (sibling_upstream, sibling_responses, sibling_rejections, sibling_task) =
        start_gateway_with_authorization("Bearer strict-key").await;
    let server = spawn_v3_server_aggregate(manifest_with_image_history_sibling(
        free_port(),
        &strict_upstream,
        &sibling_upstream,
        "direct",
    ))
    .await
    .unwrap();

    let (success, detail) = post_image_history(&server).await;
    assert!(
        success,
        "sibling must complete the unchanged image history: {detail}"
    );
    assert!(
        strict_responses.lock().await.is_empty(),
        "strict-legacy qingyanx candidate must be excluded before Provider send"
    );
    assert!(
        strict_rejections.lock().await.is_empty(),
        "the strict candidate must not receive a rejected request"
    );
    assert!(
        sibling_rejections.lock().await.is_empty(),
        "the sibling must accept the original Responses history"
    );
    let sibling_captured = sibling_responses.lock().await.clone();
    assert_eq!(
        sibling_captured.len(),
        1,
        "exactly one sibling attempt expected"
    );
    assert_eq!(
        sibling_captured[0]["input"][1],
        image_history_request()["input"][1],
        "the paired function_call history must remain unchanged"
    );
    assert_eq!(
        sibling_captured[0]["input"][2],
        image_history_request()["input"][2],
        "the complete function_call_output image item must remain unchanged"
    );
    server.shutdown().await;
    strict_task.abort();
    sibling_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn strict_legacy_image_history_reselects_before_provider_send_through_relay() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(PROVIDER_KEY_ENV, PROVIDER_KEY);
    let (strict_upstream, strict_responses, strict_rejections, strict_task) =
        start_gateway_with_authorization("Bearer strict-key").await;
    let (sibling_upstream, sibling_responses, sibling_rejections, sibling_task) =
        start_gateway_with_authorization("Bearer strict-key").await;
    let server = spawn_v3_server_aggregate(manifest_with_image_history_sibling(
        free_port(),
        &strict_upstream,
        &sibling_upstream,
        "chat",
    ))
    .await
    .unwrap();

    let (success, detail) = post_image_history(&server).await;
    assert!(
        success,
        "Relay sibling must complete the unchanged image history: {detail}"
    );
    assert!(
        strict_responses.lock().await.is_empty(),
        "Relay strict-legacy qingyanx candidate must be excluded before Provider send"
    );
    assert!(
        strict_rejections.lock().await.is_empty(),
        "Relay strict candidate must not receive a rejected request"
    );
    assert!(
        sibling_rejections.lock().await.is_empty(),
        "Relay sibling must accept the original Responses history"
    );
    let sibling_captured = sibling_responses.lock().await.clone();
    assert_eq!(
        sibling_captured.len(),
        1,
        "Relay must make exactly one sibling attempt"
    );
    assert_eq!(
        sibling_captured[0]["input"][1]["type"],
        image_history_request()["input"][1]["type"],
        "Relay must preserve the function_call type"
    );
    assert_eq!(
        sibling_captured[0]["input"][1]["call_id"],
        image_history_request()["input"][1]["call_id"],
        "Relay must preserve the paired function_call call_id"
    );
    assert_eq!(
        sibling_captured[0]["input"][1]["name"],
        image_history_request()["input"][1]["name"],
        "Relay must preserve the paired function_call name"
    );
    assert_eq!(
        sibling_captured[0]["input"][1]["arguments"],
        image_history_request()["input"][1]["arguments"],
        "Relay must preserve the paired function_call arguments"
    );
    assert_eq!(
        sibling_captured[0]["input"][2]["type"],
        image_history_request()["input"][2]["type"],
        "Relay must preserve the function_call_output type"
    );
    assert_eq!(
        sibling_captured[0]["input"][2]["call_id"],
        image_history_request()["input"][2]["call_id"],
        "Relay must preserve the paired function_call_output call_id"
    );
    assert_eq!(
        sibling_captured[0]["input"][2]["output"],
        image_history_request()["input"][2]["output"],
        "Relay must preserve the complete function_call_output image item"
    );
    server.shutdown().await;
    strict_task.abort();
    sibling_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn strict_legacy_image_history_exhausts_direct_without_provider_send() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(PROVIDER_KEY_ENV, PROVIDER_KEY);
    let (strict_upstream, strict_responses, strict_rejections, strict_task) =
        start_gateway_with_authorization("Bearer strict-key").await;
    let server = spawn_v3_server_aggregate(manifest_with_image_history_only(
        free_port(),
        &strict_upstream,
        "direct",
    ))
    .await
    .unwrap();

    assert_image_history_exhaustion(&server, &strict_responses, &strict_rejections).await;

    server.shutdown().await;
    strict_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn strict_legacy_image_history_exhausts_relay_without_provider_send() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(PROVIDER_KEY_ENV, PROVIDER_KEY);
    let (strict_upstream, strict_responses, strict_rejections, strict_task) =
        start_gateway_with_authorization("Bearer strict-key").await;
    let server = spawn_v3_server_aggregate(manifest_with_image_history_only(
        free_port(),
        &strict_upstream,
        "chat",
    ))
    .await
    .unwrap();

    assert_image_history_exhaustion(&server, &strict_responses, &strict_rejections).await;

    server.shutdown().await;
    strict_task.abort();
}
