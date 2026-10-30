use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw,
    build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01,
    build_v3_router_request_facts_for_entry, compile_v3_hub_relay_request_hooks,
    execute_v3_responses_relay_runtime, V3HubEntryProtocol, V3HubInvocationSource,
    V3HubRequestHookProfile, V3HubTransportIntent, V3ResponsesRelayClientBody,
    V3ResponsesRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::sync::Mutex;

struct ResponsesCaptureTransport {
    bodies: Mutex<Vec<Value>>,
}

#[async_trait]
impl ResponsesTransport for ResponsesCaptureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.bodies.lock().unwrap().push(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id": "resp_request_order",
                "object": "response",
                "status": "completed",
                "model": "responses-order-model",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "ORDER_OK"}]
                }]
            }))
            .unwrap(),
        ))
    }
}

fn client_request() -> Value {
    json!({
        "model": "responses-order-model",
        "stream": false,
        "instructions": "keep this instruction",
        "input": [
            {"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": "look up order 42"}
            ]},
            {"type": "function_call", "call_id": "call_order", "name": "lookup_order",
             "arguments": "{\"order_id\":\"42\"}"},
            {"type": "function_call_output", "call_id": "call_order", "output": "order-42"},
            {"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": "route this request before schema governance"}
            ]}
        ],
        "tools": [{
            "type": "function",
            "name": "lookup_order",
            "description": "look up one order",
            "parameters": {
                "type": "object",
                "properties": {"order_id": {"type": "string"}},
                "required": ["order_id"]
            }
        }]
    })
}

fn current_turn_request(body: &Value) -> Value {
    let mut current = body.clone();
    let field = if body.get("messages").and_then(Value::as_array).is_some() {
        "messages"
    } else {
        "input"
    };
    let items = body[field]
        .as_array()
        .expect("Responses fixture history array");
    let start = items
        .iter()
        .rposition(|item| item.get("role").and_then(Value::as_str) == Some("user"))
        .expect("Responses fixture current user message");
    current[field] = Value::Array(items[start..].to_vec());
    current
}

fn manifest(
    longcontext_threshold_tokens: u64,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3
[features]
tool_thinking = true
[servers.request_order]
bind = "127.0.0.1"
port = 5555
routing_group = "request_order"
endpoints = ["responses"]
[servers.request_order.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{}}
[providers.order]
type = "responses"
base_url = "http://order.invalid/v1"
default_model = "responses-order-model"
auth = {{ type = "api_key", entries = [{{ alias = "order", env = "ORDER_KEY" }}] }}
[providers.order.models.responses-order-model]
wire_name = "responses-order-model"
capabilities = ["text", "tools"]
[route_groups.request_order.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "order", model = "responses-order-model", key = "order", priority = 1 }}]
[route_groups.request_order.pools.longcontext]
selection = {{ strategy = "priority" }}
match = {{ precedence = 1, min_input_tokens = {longcontext_threshold_tokens} }}
targets = [{{ kind = "provider_model", provider = "order", model = "responses-order-model", key = "order", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

#[tokio::test]
async fn responses_relay_routes_normalized_request_before_tool_thinking_governance() {
    let client_request = client_request();
    let req02 = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(
        build_v3_hub_req_inbound_01_client_raw(
            client_request.clone(),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        ),
    )
    .expect("Responses request must normalize losslessly");
    let normalized_request = req02.payload().clone();
    let governed_request = compile_v3_hub_relay_request_hooks()
        .run_from_normalized(
            req02,
            &V3HubRequestHookProfile::enabled().with_tool_thinking_enabled(true),
        )
        .expect("tool_thinking governance must accept the normalized request")
        .payload()
        .clone();

    let normalized_current = current_turn_request(&normalized_request);
    let governed_current = current_turn_request(&governed_request);
    let normalized_current_tokens =
        build_v3_router_request_facts_for_entry(&normalized_current, "responses", None)
            .input_tokens;
    let threshold =
        build_v3_router_request_facts_for_entry(&governed_current, "responses", None).input_tokens;
    assert!(
        normalized_current_tokens < threshold,
        "fixture must prove schema governance crosses the threshold: normalized={}, governed={}",
        normalized_current_tokens,
        threshold
    );
    let normalized_full_tokens =
        build_v3_router_request_facts_for_entry(&normalized_request, "responses", None)
            .input_tokens;
    assert!(
        normalized_full_tokens > normalized_current_tokens,
        "fixture must retain completed history for provider capacity accounting: full={}, current={}",
        normalized_full_tokens,
        normalized_current_tokens
    );
    let manifest = manifest(threshold);
    let normalized_facts =
        build_v3_router_request_facts_for_entry(&normalized_request, "responses", Some(threshold));
    let governed_facts =
        build_v3_router_request_facts_for_entry(&governed_request, "responses", Some(threshold));
    assert!(!normalized_facts
        .route_classification
        .candidates
        .iter()
        .any(|route| route == "longcontext"));
    assert!(governed_facts
        .route_classification
        .candidates
        .iter()
        .any(|route| route == "longcontext"));

    let transport = ResponsesCaptureTransport {
        bodies: Mutex::new(Vec::new()),
    };
    let output = execute_v3_responses_relay_runtime(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "request_order".into(),
            failure_session_scope: V3ProviderFailureSessionScope::new(
                "responses-request-order",
                "request_order",
                "responses_request_order_contract",
            )
            .expect("test failure scope"),
            request_id: "responses-request-order".into(),
            payload: client_request,
        },
        &transport,
    )
    .await
    .expect("real Responses Relay public entry must succeed");

    assert_eq!(output.status, 200);
    assert!(output.error_chain.is_none());
    assert!(
        matches!(output.client_body, V3ResponsesRelayClientBody::Json(_)),
        "JSON client request must receive genuine JSON success"
    );
    let observability = output.observability.expect("runtime observability");
    assert_eq!(observability.pool_id.as_deref(), Some("default"));

    let bodies = transport.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 1, "one business transport call");
    let provider_body = &bodies[0];
    let input = provider_body["input"]
        .as_array()
        .expect("Responses input items");
    let function_call = input
        .iter()
        .find(|item| item["type"] == "function_call")
        .expect("paired function call must reach provider");
    let function_call_output = input
        .iter()
        .find(|item| item["type"] == "function_call_output")
        .expect("paired function output must reach provider");
    assert_eq!(function_call["call_id"], "call_order");
    assert_eq!(function_call["name"], "lookup_order");
    assert_eq!(function_call["arguments"], "{\"order_id\":\"42\"}");
    assert_eq!(
        function_call_output["call_id"], "call_order",
        "paired tool result must keep its call identity"
    );
    assert_eq!(function_call_output["output"], "order-42");
    assert!(
        input.iter().any(|item| {
            item["role"] == "user"
                && item["content"][0]["text"] == "route this request before schema governance"
        }),
        "current client text must reach provider"
    );
    let properties = &provider_body["tools"][0]["parameters"]["properties"];
    assert_eq!(properties["reason"]["type"], "string");
    assert_eq!(properties["goal_alignment_confidence"]["type"], "integer");
    assert_eq!(
        provider_body["tools"][0]["parameters"]["required"],
        json!(["order_id", "reason", "goal_alignment_confidence"])
    );
}
