//! Contract: Anthropic Relay target routing must classify the normalized request
//! before `tool_thinking` request governance inflates the tool schema.
//!
//! The independent Anthropic loop builds `route_facts_body` from the
//! post-governance (`ReqChatProcess04`) payload. Routing therefore sees the
//! injected `reason`/`goal_alignment_confidence` schema fields. When a
//! `longcontext` pool threshold sits between the normalized and the governed
//! size, the loop routes a short request into `longcontext` instead of
//! `default`. This test pins the contract with public runtime and public facts
//! APIs only.

use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, build_v3_router_request_facts_for_entry,
    compile_v3_hub_relay_request_hooks,
    execute_v3_anthropic_relay_runtime_with_client_headers_provider_health,
    run_v3_anthropic_relay_runtime_req_inbound, V3AnthropicRelayRuntimeInput, V3HubEntryProtocol,
    V3HubInvocationSource, V3HubRequestHookProfile, V3HubTransportIntent,
    V3ProviderFailureRuntimeHealth,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

const CLIENT_MODEL_ALIAS: &str = "claude-client-alias";

struct CapturingTransport {
    calls: AtomicUsize,
    captured_url: Mutex<Option<String>>,
    captured_body: Mutex<Option<Value>>,
}

#[async_trait]
impl ResponsesTransport for CapturingTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        *self.captured_url.lock().unwrap() = Some(request.url().to_string());
        *self.captured_body.lock().unwrap() = Some(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id": "resp_anthropic_request_order",
                "status": "completed",
                "output": [
                    {"type":"message","role":"assistant","content":[{"type":"output_text","text":"order ok"}]}
                ]
            }))
            .unwrap(),
        ))
    }
}

fn anthropic_payload() -> Value {
    // Several tools so `tool_thinking` governance measurably enlarges the
    // governed tool schema without relying on serialized byte length.
    let tools = (0..6)
        .map(|index| {
            json!({
                "name": format!("lookup_{index}"),
                "description": format!("Lookup document {index} by key"),
                "input_schema": {
                    "type": "object",
                    "properties": {"q": {"type": "string", "description": "search key"}}
                }
            })
        })
        .collect::<Vec<_>>();
    json!({
        "model": CLIENT_MODEL_ALIAS,
        "max_tokens": 64,
        "messages": [{"role": "user", "content": "Lookup alpha across all tools"}],
        "tools": tools,
        "stream": false
    })
}

/// Public hook path: normalized body is the exact `ReqInbound02` payload before
/// governance; governed body is the `ReqChatProcess04` payload that the relay
/// actually routes on.
fn normalized_and_governed_bodies(payload: &Value) -> (Value, Value) {
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        payload.clone(),
        V3HubEntryProtocol::Anthropic,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let normalized =
        run_v3_anthropic_relay_runtime_req_inbound(req01).expect("anthropic request normalizes");
    let normalized_body = normalized.payload().clone();
    let profile = V3HubRequestHookProfile::enabled().with_tool_thinking_enabled(true);
    let governed = compile_v3_hub_relay_request_hooks()
        .run_from_normalized(normalized, &profile)
        .expect("anthropic request governance succeeds")
        .payload()
        .clone();
    (normalized_body, governed)
}

fn manifest_with_longcontext_threshold(
    scope: &str,
    longcontext_threshold_tokens: u64,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

[features]
tool_thinking = true

[pipelines.hub_v1]
skeleton = "hub_v1"

[servers.{scope}]
bind = "127.0.0.1"
port = 1
routing_group = "{scope}"
endpoints = ["anthropic"]

[servers.{scope}.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]

[providers.default_target]
type = "responses"
base_url = "http://default.invalid/v1"
default_model = "{alias}"
auth = {{ type = "api_key", entries = [{{ alias = "default_target", env = "V3_ANTHROPIC_DEFAULT_KEY" }}] }}
[providers.default_target.models.{alias}]
wire_name = "{alias}"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "tool_outputs", "reasoning", "vision"]

[providers.longcontext_target]
type = "responses"
base_url = "http://longcontext.invalid/v1"
default_model = "{alias}"
auth = {{ type = "api_key", entries = [{{ alias = "longcontext_target", env = "V3_ANTHROPIC_LONGCONTEXT_KEY" }}] }}
[providers.longcontext_target.models.{alias}]
wire_name = "{alias}"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "tool_outputs", "reasoning", "vision"]

[route_groups.{scope}.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "default_target", model = "{alias}", key = "default_target", priority = 1 }}]

[route_groups.{scope}.pools.longcontext]
selection = {{ strategy = "priority" }}
match = {{ precedence = 100, entry_protocol = "anthropic", min_input_tokens = {longcontext_threshold_tokens} }}
targets = [{{ kind = "provider_model", provider = "longcontext_target", model = "{alias}", key = "longcontext_target", priority = 1 }}]
"#,
        alias = CLIENT_MODEL_ALIAS,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or_default()
        .to_string()
}

#[tokio::test]
async fn anthropic_relay_routes_on_normalized_request_before_tool_thinking_governance() {
    // This contract pins one request's routing decision and provider wire from a
    // single captured response, so the bounded Chat Process continuation is
    // pinned off; refill coverage lives in the public server entry tests.
    static PIN: std::sync::Once = std::sync::Once::new();
    PIN.call_once(|| {
        routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    });
    let scope = "anthropic_request_order";
    let payload = anthropic_payload();

    let (normalized_body, governed_body) = normalized_and_governed_bodies(&payload);
    let normalized_tokens =
        build_v3_router_request_facts_for_entry(&normalized_body, "anthropic", None).input_tokens;
    let governed_tokens =
        build_v3_router_request_facts_for_entry(&governed_body, "anthropic", None).input_tokens;
    assert!(
        normalized_tokens < governed_tokens,
        "tool_thinking governance must enlarge the governed request: normalized={normalized_tokens} governed={governed_tokens}"
    );
    // Threshold strictly between the two public facts outputs. Routing on the
    // normalized request must stay below it; routing on the governed request
    // crosses it.
    let longcontext_threshold_tokens = governed_tokens;
    assert!(normalized_tokens < longcontext_threshold_tokens);
    assert!(longcontext_threshold_tokens <= governed_tokens);

    let manifest = manifest_with_longcontext_threshold(scope, longcontext_threshold_tokens);
    let transport = CapturingTransport {
        calls: AtomicUsize::new(0),
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };

    let output = execute_v3_anthropic_relay_runtime_with_client_headers_provider_health(
        &manifest,
        V3AnthropicRelayRuntimeInput {
            server_id: scope.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-anthropic-request-order".into(),
            toolreason_observation_session_id: None,
            payload: payload.clone(),
        },
        &transport,
        Vec::new(),
        V3ProviderFailureRuntimeHealth::from_manifest_for_tests(&manifest),
    )
    .await
    .expect("anthropic relay request must complete on the captured provider response");

    let calls = transport.calls.load(Ordering::SeqCst);
    let captured_url = transport
        .captured_url
        .lock()
        .unwrap()
        .clone()
        .expect("capture transport must receive exactly one business request");
    let captured_body = transport.captured_body.lock().unwrap().clone().unwrap();

    // Forwarded governed tools: every declared tool keeps its identity and
    // carries the tool_thinking schema fields injected at Req04.
    let forwarded_tools = captured_body["tools"]
        .as_array()
        .expect("provider wire body must forward the governed tools");
    assert_eq!(
        forwarded_tools.len(),
        6,
        "all declared tools must be forwarded: {captured_body}"
    );
    for tool in forwarded_tools {
        let schema = &tool["parameters"];
        let properties = schema["properties"]
            .as_object()
            .expect("forwarded tool schema must keep properties");
        assert!(
            properties.contains_key("reason")
                && properties.contains_key("goal_alignment_confidence"),
            "governed tool_thinking schema fields must be forwarded: {tool}"
        );
        let required = schema["required"]
            .as_array()
            .expect("forwarded tool schema must keep required");
        for field in ["reason", "goal_alignment_confidence"] {
            assert!(
                required.iter().any(|value| value.as_str() == Some(field)),
                "forwarded governed schema must require {field}: {tool}"
            );
        }
    }

    assert_eq!(calls, 1, "exactly one provider business transport call");
    assert_eq!(
        output.status, 200,
        "captured provider response must complete"
    );
    let observability = output
        .observability
        .as_ref()
        .expect("relay output must carry typed observability");
    assert_eq!(
        observability.pool_id.as_deref(),
        Some("default"),
        "routing must classify the normalized request before tool_thinking governance: \
         normalized={normalized_tokens} governed={governed_tokens} threshold={longcontext_threshold_tokens} \
         route_pool={:?} reason={:?}",
        observability.pool_id,
        observability.route_classification_reason
    );
    assert_eq!(
        host_of(&captured_url),
        "default.invalid",
        "first attempt must hit the default pool target: {captured_url}"
    );
}
