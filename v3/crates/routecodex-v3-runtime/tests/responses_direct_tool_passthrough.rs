use async_trait::async_trait;
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw as build_v3_server_03_http_request_raw_with_scope,
    execute_v3_responses_direct_runtime_kernel, register_responses_direct_hooks, V3ClientBody,
};
use serde_json::{json, Value};
use std::sync::Mutex;

fn build_v3_server_03_http_request_raw(
    server_id: String,
    request_id: String,
    execution_id: String,
    method: String,
    path: String,
    body: Value,
) -> routecodex_v3_runtime::V3Server03HttpRequestRaw {
    let failure_session_scope = routecodex_v3_error::V3ProviderFailureSessionScope::new(
        &server_id,
        "test-group",
        format!("test-session:{request_id}"),
    )
    .expect("test provider failure session scope")
    .with_transport_handoff_scope("test-pipeline", 5555, 1)
    .expect("test provider transport handoff scope");
    let mut raw = build_v3_server_03_http_request_raw_with_scope(
        server_id,
        failure_session_scope,
        request_id,
        execution_id,
        method,
        path,
        body,
    );
    raw.port = Some(5555);
    raw.pipeline_id = Some("test-pipeline".to_string());
    raw
}

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

struct ClientDisconnectTransport;

struct DirectMalformedSseAttemptTransport;

#[async_trait]
impl ResponsesTransport for DirectMalformedSseAttemptTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(vec![
                Ok(concat!(
                    "event: response.output_text.delta\n",
                    "data: {\"type\":\"response.output_text.delta\",\"response_id\":\"resp_failed_attempt_malformed\",\"delta\":\"partial\"}\n\n",
                )
                .as_bytes()
                .to_vec()),
                Ok(b"data: {malformed-json}\n\n".to_vec()),
            ])),
        ))
    }
}

struct DirectFailedTerminalSseAttemptTransport;

#[async_trait]
impl ResponsesTransport for DirectFailedTerminalSseAttemptTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(vec![
                Ok(concat!(
                    "event: response.output_text.delta\n",
                    "data: {\"type\":\"response.output_text.delta\",\"response_id\":\"resp_failed_attempt_event\",\"delta\":\"partial\"}\n\n",
                )
                .as_bytes()
                .to_vec()),
                Ok(concat!(
                    "event: response.failed\n",
                    "data: {\"type\":\"response.failed\",\"response\":{\"id\":\"resp_failed_attempt_event\",\"status\":\"failed\",\"error\":{\"code\":\"HTTP_503\",\"message\":\"provider failed after delta\"}}}\n\n",
                )
                .as_bytes()
                .to_vec()),
            ])),
        ))
    }
}

struct DirectCompletedJsonTransport;

#[async_trait]
impl ResponsesTransport for DirectCompletedJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id": "resp_after_failed_attempt",
                "status": "completed",
                "output": [{"type": "output_text", "text": "recovered"}]
            }))
            .expect("serialize completed response"),
        ))
    }
}

struct DirectTerminalSseTransport;

#[async_trait]
impl ResponsesTransport for DirectTerminalSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(vec![Ok(concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_terminal_reset\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n\n",
                "data: [DONE]\n\n",
            )
            .as_bytes()
            .to_vec())])),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for ClientDisconnectTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Err(V3ProviderError::ClientDisconnect {
            request_id: request.request_id().to_string(),
            provider_id: request.provider_id().to_string(),
        })
    }
}

fn manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[features]
[servers.s]
bind = "127.0.0.1"
port = 5555
routing_group = "g"
endpoints = ["responses"]
[servers.s.execution]
allowed_modes = ["direct"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {}
[providers.p]
enabled = true
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "a", env = "TEST_KEY" }] }
concurrency = { max_in_flight = 128, acquire_timeout_ms = 60000, stale_lease_ms = 300000 }
responses = { process = "direct", streaming = "always", transport = "http" }
[providers.p.models.m]
wire_name = "wire-m"
capabilities = ["text", "tools", "reasoning"]
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

fn recovery_request(
    request_id: &str,
    body: Value,
) -> routecodex_v3_runtime::V3Server03HttpRequestRaw {
    build_v3_server_03_http_request_raw(
        "s".into(),
        request_id.into(),
        format!("exec-{request_id}"),
        "POST".into(),
        "/v1/responses".into(),
        body,
    )
}

async fn assert_failed_attempt_does_not_poison_fresh_request<T: ResponsesTransport>(
    failed_transport: &T,
    failed_request_id: &str,
    fresh_request_id: &str,
) {
    let manifest = manifest();
    let first = execute_v3_responses_direct_runtime_kernel(
        &manifest,
        recovery_request(
            failed_request_id,
            json!({"model": "gpt-5.5", "stream": true, "input": "stream"}),
        ),
        register_responses_direct_hooks(),
        failed_transport,
    )
    .await;
    assert_eq!(first.client_payload.status, 502, "{first:?}");
    let V3ClientBody::Json(body) = first.client_payload.body else {
        panic!("failed provider attempt must project JSON Error06")
    };
    assert_eq!(
        body,
        json!({"error": {"code": "network_error", "message": "network error"}})
    );

    let second = execute_v3_responses_direct_runtime_kernel(
        &manifest,
        recovery_request(
            fresh_request_id,
            json!({"model": "gpt-5.5", "input": "next"}),
        ),
        register_responses_direct_hooks(),
        &DirectCompletedJsonTransport,
    )
    .await;
    assert_eq!(second.client_payload.status, 200, "{second:?}");
}

#[tokio::test]
async fn malformed_sse_attempt_never_commits_partial_bytes_and_fresh_request_remains_independent() {
    assert_failed_attempt_does_not_poison_fresh_request(
        &DirectMalformedSseAttemptTransport,
        "req-direct-malformed-attempt",
        "req-direct-after-malformed-attempt",
    )
    .await;
}

#[tokio::test]
async fn failed_terminal_sse_attempt_never_commits_partial_bytes_and_exhausts_to_error06() {
    assert_failed_attempt_does_not_poison_fresh_request(
        &DirectFailedTerminalSseAttemptTransport,
        "req-direct-failed-terminal-attempt",
        "req-direct-after-failed-terminal-attempt",
    )
    .await;
}

#[tokio::test]
async fn terminal_sse_success_seals_replay_without_blocking_a_fresh_request() {
    let manifest = manifest();
    let failed = execute_v3_responses_direct_runtime_kernel(
        &manifest,
        recovery_request(
            "req-direct-seed-active-gate",
            json!({"model": "gpt-5.5", "stream": true, "input": "seed"}),
        ),
        register_responses_direct_hooks(),
        &DirectMalformedSseAttemptTransport,
    )
    .await;
    assert_eq!(failed.client_payload.status, 502, "{failed:?}");

    let terminal = execute_v3_responses_direct_runtime_kernel(
        &manifest,
        recovery_request(
            "req-direct-terminal-reset",
            json!({"model": "gpt-5.5", "stream": true, "input": "reset"}),
        ),
        register_responses_direct_hooks(),
        &DirectTerminalSseTransport,
    )
    .await;
    assert_eq!(terminal.client_payload.status, 200, "{terminal:?}");

    let waiting_manifest = manifest.clone();
    let waiter = tokio::spawn(async move {
        execute_v3_responses_direct_runtime_kernel(
            &waiting_manifest,
            recovery_request(
                "req-direct-released-by-terminal-success",
                json!({"model": "gpt-5.5", "input": "released"}),
            ),
            register_responses_direct_hooks(),
            &DirectCompletedJsonTransport,
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        waiter.is_finished(),
        "fresh Direct request consumed an unrelated Error05 recovery lane"
    );
    let fresh = waiter.await.expect("fresh Direct request task panicked");
    assert_eq!(fresh.client_payload.status, 200, "{fresh:?}");

    let V3ClientBody::CommittedSse(mut body) = terminal.client_payload.body else {
        panic!("terminal Direct response must remain SSE")
    };
    let mut text = String::new();
    while let Some(chunk) = body.next().await {
        text.push_str(&String::from_utf8(chunk).expect("UTF-8"));
    }
    assert!(text.contains("response.completed"), "{text}");
    assert!(text.contains("[DONE]"), "{text}");
}

#[tokio::test]
async fn direct_client_disconnect_is_health_neutral_and_never_enters_action_wait() {
    let manifest = manifest();
    for index in 0..3 {
        let started = std::time::Instant::now();
        let output = execute_v3_responses_direct_runtime_kernel(
            &manifest,
            build_v3_server_03_http_request_raw(
                "s".into(),
                format!("req-direct-disconnect-{index}"),
                format!("exec-direct-disconnect-{index}"),
                "POST".into(),
                "/v1/responses".into(),
                json!({"model":"gpt-5.5","input":"disconnect","stream":false}),
            ),
            register_responses_direct_hooks(),
            &ClientDisconnectTransport,
        )
        .await;
        assert_eq!(output.client_payload.status, 499);
        assert!(
            started.elapsed() < std::time::Duration::from_millis(500),
            "Direct client disconnect entered provider health retry or action wait"
        );
    }
}

async fn assert_direct_response_request_preserves_client_tools(response: Value, label: &str) {
    let manifest = manifest();
    let transport = PassthroughTransport::with_response(response);
    let output = execute_v3_responses_direct_runtime_kernel(
        &manifest,
        request(json!({
            "model": "gpt-5.5",
            "input": format!("direct tool preservation negative {label}"),
            "tools": [{"type":"function","name":"exec_command","parameters":{"type":"object"}}],
            "stream": false
        })),
        register_responses_direct_hooks(),
        &transport,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{label}: {:#?}", output);
    let wire = transport
        .request
        .lock()
        .unwrap()
        .take()
        .expect("direct provider wire payload captured");
    let wire_serialized = serde_json::to_string(&wire).unwrap();
    assert_eq!(
        wire["tools"].as_array().map(|items| items.len()),
        Some(1),
        "{label}: direct path must preserve original tools without internal additions: {wire}"
    );
    assert_eq!(wire["tools"][0]["name"], "exec_command");
    for forbidden in [
        "<internal_control_schema>",
        "call_internal_control",
        "routecodex internal control",
    ] {
        assert!(
            !wire_serialized.contains(forbidden),
            "{label}: direct provider wire leaked relay internal artifact: {forbidden}"
        );
    }
    assert!(
        !output
            .node_trace
            .contains(&"V3HubRespChatProcess03Governed"),
        "{label}: direct runtime must not enter Relay RespChatProcess: {:?}",
        output.node_trace
    );
}

async fn assert_direct_response_passthrough_without_relay_governance(response: Value, label: &str) {
    let expected_status = response.get("status").cloned();
    let manifest = manifest();
    let transport = PassthroughTransport::with_response(response);
    let output = execute_v3_responses_direct_runtime_kernel(
        &manifest,
        request(json!({
            "model": "gpt-5.5",
            "input": format!("direct pass-through {label}"),
            "tools": [{"type":"function","name":"exec_command","parameters":{"type":"object"}}],
            "stream": false
        })),
        register_responses_direct_hooks(),
        &transport,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{label}: {:#?}", output);
    assert!(
        !output
            .node_trace
            .contains(&"V3HubRespChatProcess03Governed"),
        "{label}: direct runtime must not enter Relay RespChatProcess: {:?}",
        output.node_trace
    );
    let V3ClientBody::Json(parsed) = &output.client_payload.body else {
        panic!("{label}: direct client body must be JSON: {:#?}", output);
    };
    if let Some(expected_status) = expected_status {
        assert_eq!(
            parsed.get("status"),
            Some(&expected_status),
            "{label}: direct path must pass provider status through: {parsed}"
        );
    }
    let client_serialized = serde_json::to_string(parsed).unwrap();
    for forbidden in ["call_internal_control", "routecodex internal control"] {
        assert!(
            !client_serialized.contains(forbidden),
            "{label}: direct response leaked relay internal projection: {forbidden}"
        );
    }
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
async fn direct_kernel_preserves_named_unpaired_function_call_output_without_fabricated_call_id() {
    // Bug f29d7db on the Direct path: entry=responses and the selected provider is a
    // native Responses provider with process=direct (the live cc-sol shape). The
    // named unpaired output must cross to the provider wire byte-for-byte and must
    // never gain a fabricated call_id or enter Relay governance.
    let transport = PassthroughTransport::default();
    let body = json!({
        "model": "gpt-5.5",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "continue"}]
            },
            {
                "type": "function_call_output",
                "id": "fco_01a0c969-72fc-7530-9f23-0181a8b116e3",
                "name": "send_message_to_thread",
                "namespace": "codex_tui",
                "output": "<codex_delegation>cross-thread notification</codex_delegation>"
            }
        ],
        "stream": false
    });

    let output = execute_v3_responses_direct_runtime_kernel(
        &manifest(),
        request(body),
        register_responses_direct_hooks(),
        &transport,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{:#?}", output);
    assert!(
        !output
            .node_trace
            .contains(&"V3HubRespChatProcess03Governed"),
        "named unpaired output on Direct must not enter Relay ChatProcess: {:?}",
        output.node_trace
    );
    let wire = transport
        .request
        .lock()
        .unwrap()
        .take()
        .expect("direct provider wire captured");
    let item = wire["input"]
        .as_array()
        .expect("responses input array")
        .iter()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("function_call_output"))
        .unwrap_or_else(|| panic!("named unpaired output missing from the wire: {wire}"));
    assert_eq!(
        item.get("call_id"),
        None,
        "call_id must not be fabricated on the Direct wire: {wire}"
    );
    assert_eq!(item["id"], "fco_01a0c969-72fc-7530-9f23-0181a8b116e3");
    assert_eq!(item["name"], "send_message_to_thread");
    assert_eq!(item["namespace"], "codex_tui");
    assert_eq!(
        item["output"],
        "<codex_delegation>cross-thread notification</codex_delegation>"
    );
}

#[tokio::test]
async fn direct_kernel_preserves_tool_choice_parallel_tool_calls_and_tools_in_wire_payload() {
    let manifest = manifest();
    let transport = PassthroughTransport::default();

    let body = json!({
        "model": "gpt-5.5",
        "input": "use tools",
        "tools": [
            {"type": "function", "name": "search", "description": "search web"},
            {"type": "function", "name": "code", "description": "run code"}
        ],
        "tool_choice": {"type": "function", "function": {"name": "search"}},
        "parallel_tool_calls": false,
        "metadata": {"client": "kept", "session": "abc"}
    });

    let output = execute_v3_responses_direct_runtime_kernel(
        &manifest,
        request(body),
        register_responses_direct_hooks(),
        &transport,
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
async fn responses_openai_chat_field_parity_direct_kernel_preserves_responses_input_include_and_tool_history(
) {
    let manifest = manifest();
    let transport = PassthroughTransport::default();
    let malformed_arguments =
        "{\"cmd\":\"cd /Volumes/extension/code/zterm && git status --short\"}{\"cmd\":\"pwd\"}";

    let body = json!({
        "model": "gpt-5.5",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "continue"}]
            },
            {
                "type": "function_call",
                "id": "fc_019fb564-9ef3-7423-bb90-30509ef6ae8c",
                "call_id": "call_6b0251fee24f41b2b045b04e",
                "name": "exec_command",
                "arguments": malformed_arguments
            },
            {
                "type": "function_call_output",
                "call_id": "call_6b0251fee24f41b2b045b04e",
                "output": "failed to parse function arguments: trailing characters at line 1 column 66"
            }
        ],
        "include": ["reasoning.encrypted_content"],
        "stream": false
    });

    let output = execute_v3_responses_direct_runtime_kernel(
        &manifest,
        request(body),
        register_responses_direct_hooks(),
        &transport,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{:#?}", output);

    let wire = transport
        .request
        .lock()
        .unwrap()
        .take()
        .expect("direct provider wire payload captured");
    assert_eq!(wire["model"], "wire-m");
    assert!(
        wire.get("messages").is_none(),
        "Direct must not synthesize Chat messages: {wire}"
    );
    assert_eq!(wire["include"][0], "reasoning.encrypted_content");
    assert_eq!(
        wire["input"][1]["id"],
        "fc_019fb564-9ef3-7423-bb90-30509ef6ae8c"
    );
    assert_eq!(wire["input"][1]["call_id"], "call_6b0251fee24f41b2b045b04e");
    assert_eq!(wire["input"][1]["arguments"], malformed_arguments);
    assert_eq!(wire["input"][2]["call_id"], wire["input"][1]["call_id"]);
    assert_control_truth_isolated(&wire);
}

#[tokio::test]
async fn direct_kernel_preserves_service_tier_reasoning_effort_and_prompt_cache_key() {
    let manifest = manifest();
    let transport = PassthroughTransport::default();

    let body = json!({
        "model": "gpt-5.5",
        "input": "reason about tool use",
        "tools": [{"type": "function", "name": "compute"}],
        "tool_choice": "auto",
        "parallel_tool_calls": true,
        "reasoning": {"effort": "high", "summary": "auto"},
        "service_tier": "flex",
        "prompt_cache_key": "client-cache-1"
    });

    let output = execute_v3_responses_direct_runtime_kernel(
        &manifest,
        request(body),
        register_responses_direct_hooks(),
        &transport,
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
async fn direct_kernel_maps_unknown_responses_reasoning_effort_to_protocol_neutral_medium() {
    let manifest = manifest();
    let transport = PassthroughTransport::default();
    let body = json!({
        "model": "gpt-5.5",
        "input": "reason about compatibility",
        "reasoning": {"effort": "definitely_invalid"}
    });

    let output = execute_v3_responses_direct_runtime_kernel(
        &manifest,
        request(body),
        register_responses_direct_hooks(),
        &transport,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{:#?}", output);

    let wire = transport
        .request
        .lock()
        .unwrap()
        .take()
        .expect("direct provider wire payload captured");
    assert_eq!(wire["reasoning"]["effort"], "medium", "{wire}");
}

#[tokio::test]
async fn direct_kernel_response_propagates_provider_output_text_to_client_unchanged() {
    let manifest = manifest();
    let transport = PassthroughTransport::default();

    let body = json!({
        "model": "gpt-5.5",
        "input": "use tools",
        "tools": [{"type": "function", "name": "search"}]
    });

    let output = execute_v3_responses_direct_runtime_kernel(
        &manifest,
        request(body),
        register_responses_direct_hooks(),
        &transport,
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
async fn direct_kernel_passes_completed_response_without_summary_when_schema_guidance_inactive() {
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

    let original_request = json!({
        "model": "gpt-5.5",
        "input": "direct preserves completed response without summary",
        "tools": [{"type":"function","name":"exec_command","parameters":{"type":"object"}}],
        "stream": false
    });
    let output = execute_v3_responses_direct_runtime_kernel(
        &manifest,
        request(original_request.clone()),
        register_responses_direct_hooks(),
        &transport,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{:#?}", output);
    let wire = transport
        .request
        .lock()
        .unwrap()
        .take()
        .expect("direct provider wire payload captured");
    let wire_serialized = serde_json::to_string(&wire).unwrap();
    assert_eq!(
        wire.get("tools"),
        original_request.get("tools"),
        "direct provider request must preserve the original Responses $.tools field exactly and must not inject internal guidance"
    );
    assert_eq!(
        wire["tools"].as_array().map(|items| items.len()),
        Some(1),
        "direct path must preserve only client tools without injecting internal guidance: {wire}"
    );
    assert_eq!(wire["tools"][0]["name"], "exec_command");
    assert!(
        wire.get("instructions").is_none()
            || !wire["instructions"]
                .as_str()
                .unwrap_or_default()
                .contains("routecodex internal"),
        "direct provider request must not get request-side internal guidance: {wire}"
    );
    for forbidden in ["<internal_control_schema>", "call_internal_control"] {
        assert!(
            !wire_serialized.contains(forbidden),
            "direct provider wire leaked request-side internal artifact: {forbidden}"
        );
    }
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
        "direct path must not synthesize an internal no-op: {parsed}"
    );
    assert_eq!(parsed["id"], "resp_direct_missing_schema");
    let serialized = serde_json::to_string(parsed).unwrap();
    assert!(
        !serialized.contains("call_internal_control"),
        "direct no-summary response must not project client-visible internal call: {serialized}"
    );
    assert!(
        !serialized.contains("routecodex internal control"),
        "direct no-summary response must not project an internal CLI call: {serialized}"
    );
    assert!(
        serialized.contains("direct response without stop schema"),
        "direct no-summary stop must preserve visible assistant text: {serialized}"
    );
}

#[tokio::test]
async fn direct_kernel_passes_summary_matrix_when_schema_guidance_inactive() {
    let payloads = [
        (
            "no_schema",
            json!({
                "object":"response",
                "id":"resp_direct_matrix_no_schema",
                "status":"completed",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"direct matrix missing schema"}]
                }]
            }),
        ),
        (
            "invalid_schema",
            json!({
                "object":"response",
                "id":"resp_direct_matrix_invalid_schema",
                "status":"completed",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"{\"state\":\"bad\",\"reason\":\"invalid\"}"}]
                }]
            }),
        ),
        (
            "visible_text_schema_without_summary",
            json!({
                "object": "response",
                "id": "resp_direct_matrix_visible_schema_no_summary",
                "status": "completed",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "done\n<internal_control_schema>\n{\"state\":\"done\",\"evidence\":\"direct proof\"}\n</internal_control_schema>"}]
                }]
            }),
        ),
        (
            "canonical_summary",
            json!({
                "object": "response",
                "id": "resp_direct_matrix_summary",
                "status": "completed",
                "output": [
                    {
                        "type": "reasoning",
                        "summary": [{"type": "summary_text", "text": "The task is complete with direct evidence."}]
                    },
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "done with summary"}]
                    }
                ]
            }),
        ),
        (
            "internal_control_text_shaped",
            json!({
                "object":"response",
                "id":"resp_direct_matrix_internal_control_text",
                "status":"completed",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"provider text mentions internal control but direct must not enter relay governance"}]
                }]
            }),
        ),
    ];
    for (label, payload) in payloads {
        assert_direct_response_request_preserves_client_tools(payload.clone(), label).await;
        assert_direct_response_passthrough_without_relay_governance(payload, label).await;
    }
}
