use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw,
    execute_v3_responses_direct_runtime_kernel_with_continuation, register_responses_direct_hooks,
    V3ClientBody, V3ResponsesDirectContinuationScope, V3ResponsesDirectContinuationState,
};
use serde_json::{json, Value};
use std::sync::Mutex;

#[derive(Default)]
struct PassthroughTransport {
    request: Mutex<Option<Value>>,
    response: Mutex<Option<Value>>,
}

impl PassthroughTransport {
    fn with_response(response: Value) -> Self {
        Self {
            request: Mutex::new(None),
            response: Mutex::new(Some(response)),
        }
    }
}

#[async_trait]
impl ResponsesTransport for PassthroughTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        *self.request.lock().unwrap() = Some(request.body().clone());
        let response = self.response.lock().unwrap().clone().unwrap_or_else(|| {
            json!({
                "id": "resp_passthrough",
                "status": "completed",
                "output": [{"type": "output_text", "text": "ok"}]
            })
        });
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&response).unwrap(),
        ))
    }
}

fn manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 5555
routing_group = "g"
endpoints = ["responses"]
[providers.p]
enabled = true
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "a", env = "TEST_KEY" }] }
responses = { process = "chat", streaming = "always", transport = "http" }
[providers.p.models.m]
wire_name = "wire-m"
capabilities = ["text", "tools", "streaming"]
supports_streaming = true
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "a", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn request(body: Value) -> routecodex_v3_runtime::V3Server03HttpRequestRaw {
    build_v3_server_03_http_request_raw(
        "s".into(),
        "req-pt-1".into(),
        "exec-pt-1".into(),
        "POST".into(),
        "/v1/responses".into(),
        body,
    )
}

fn scope() -> V3ResponsesDirectContinuationScope {
    V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-pt",
        "conversation-pt",
        5555,
        "g",
    )
}

fn assert_control_truth_isolated(body: &Value) {
    for forbidden in [
        "provider_id",
        "auth_alias",
        "continuation_owner",
        "capability_revision",
        "routecodex_internal",
    ] {
        assert!(body.get(forbidden).is_none(), "{forbidden} leaked: {body}");
    }
}

#[tokio::test]
async fn direct_kernel_preserves_tool_choice_parallel_tool_calls_and_tools_in_wire_payload() {
    let manifest = manifest();
    let transport = PassthroughTransport::default();

    let body = json!({
        "model": "client-model",
        "input": "use tools",
        "tools": [
            {"type": "function", "name": "search", "description": "search web"},
            {"type": "function", "name": "code", "description": "run code"}
        ],
        "tool_choice": {"type": "function", "function": {"name": "search"}},
        "parallel_tool_calls": false,
        "metadata": {"client": "kept", "session": "abc"}
    });

    let output = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &V3ResponsesDirectContinuationState::default(),
        &manifest,
        request(body),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{:#?}", output);

    let wire = transport
        .request
        .lock()
        .unwrap()
        .take()
        .expect("wire payload captured");
    assert_eq!(
        wire["model"], "wire-m",
        "model must be rewritten to wire model: {wire}"
    );
    assert_eq!(
        wire["tool_choice"],
        json!({"type": "function", "function": {"name": "search"}}),
        "tool_choice dropped: {wire}"
    );
    assert_eq!(
        wire["parallel_tool_calls"], false,
        "parallel_tool_calls dropped: {wire}"
    );
    assert_eq!(
        wire["tools"].as_array().map(|a| a.len()),
        Some(2),
        "tools truncated: {wire}"
    );
    assert_eq!(
        wire["tools"][0]["name"], "search",
        "tools[0] dropped: {wire}"
    );
    assert_eq!(wire["tools"][1]["name"], "code", "tools[1] dropped: {wire}");
    assert_eq!(
        wire["metadata"]["client"], "kept",
        "client metadata dropped: {wire}"
    );
    assert_eq!(wire["input"], "use tools", "input dropped: {wire}");
    assert_control_truth_isolated(&wire);
}

#[tokio::test]
async fn direct_kernel_preserves_service_tier_reasoning_effort_and_prompt_cache_key() {
    let manifest = manifest();
    let transport = PassthroughTransport::default();

    let body = json!({
        "model": "client-model",
        "input": "reason about tool use",
        "tools": [{"type": "function", "name": "compute"}],
        "tool_choice": "auto",
        "parallel_tool_calls": true,
        "reasoning": {"effort": "high", "summary": "auto"},
        "service_tier": "flex",
        "prompt_cache_key": "client-cache-1"
    });

    let output = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &V3ResponsesDirectContinuationState::default(),
        &manifest,
        request(body),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{:#?}", output);

    let wire = transport
        .request
        .lock()
        .unwrap()
        .take()
        .expect("wire payload captured");
    assert_eq!(wire["model"], "wire-m", "model rewritten: {wire}");
    assert_eq!(
        wire["tool_choice"], "auto",
        "tool_choice='auto' dropped: {wire}"
    );
    assert_eq!(
        wire["parallel_tool_calls"], true,
        "parallel_tool_calls=true dropped: {wire}"
    );
    assert_eq!(
        wire["reasoning"]["effort"], "high",
        "reasoning.effort dropped: {wire}"
    );
    assert_eq!(
        wire["reasoning"]["summary"], "auto",
        "reasoning.summary dropped: {wire}"
    );
    assert_eq!(wire["service_tier"], "flex", "service_tier dropped: {wire}");
    assert_eq!(
        wire["prompt_cache_key"], "client-cache-1",
        "prompt_cache_key dropped: {wire}"
    );
    assert_control_truth_isolated(&wire);
}

#[tokio::test]
async fn direct_kernel_response_propagates_provider_output_text_to_client_unchanged() {
    let manifest = manifest();
    let transport = PassthroughTransport::default();

    let body = json!({
        "model": "client-model",
        "input": "use tools",
        "tools": [{"type": "function", "name": "search"}]
    });

    let output = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &V3ResponsesDirectContinuationState::default(),
        &manifest,
        request(body),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{:#?}", output);

    let V3ClientBody::Json(parsed) = &output.client_payload.body else {
        panic!(
            "client body must be JSON for completed status: {:#?}",
            output
        );
    };
    assert_eq!(
        parsed["status"], "completed",
        "client body shape wrong: {parsed}"
    );
    assert_eq!(
        parsed["id"], "resp_passthrough",
        "client body id dropped: {parsed}"
    );
    assert_eq!(
        parsed["output"][0]["type"], "output_text",
        "output_text dropped: {parsed}"
    );
    assert_eq!(
        parsed["output"][0]["text"], "ok",
        "output text dropped: {parsed}"
    );
}

#[tokio::test]
async fn direct_kernel_does_not_run_stopless_for_completed_missing_schema_response() {
    let manifest = manifest();
    let transport = PassthroughTransport::with_response(json!({
        "object":"response",
        "id":"resp_direct_missing_schema",
        "status":"completed",
        "output":[{
            "type":"message",
            "role":"assistant",
            "content":[{"type":"output_text","text":"direct response without stop schema"}]
        }]
    }));

    let output = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &V3ResponsesDirectContinuationState::default(),
        &manifest,
        request(json!({
            "model": "client-model",
            "input": "direct must not use stopless",
            "stream": false
        })),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{:#?}", output);
    assert!(
        !output
            .node_trace
            .contains(&"V3HubRespChatProcess03Governed"),
        "direct runtime must not enter Relay RespChatProcess: {:?}",
        output.node_trace
    );

    let V3ClientBody::Json(parsed) = &output.client_payload.body else {
        panic!(
            "client body must be JSON for completed status: {:#?}",
            output
        );
    };
    assert_eq!(
        parsed["status"], "completed",
        "client body shape wrong: {parsed}"
    );
    assert_eq!(parsed["id"], "resp_direct_missing_schema");
    let serialized = serde_json::to_string(parsed).unwrap();
    for forbidden in [
        "call_stopless_reasoning",
        "reasoningStop",
        "routecodex hook run",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "direct response leaked stopless projection: {forbidden}"
        );
    }
}
