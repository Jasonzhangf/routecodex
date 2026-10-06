//! REQ02 Direct request-view consumer coverage.
//!
//! This test drives the public Runtime request entry with an in-process
//! transport. It asserts the exact provider-request bytes produced by the
//! registered Direct request view, the canonical/original pair published on
//! the same request handle, and the typed Direct-to-Relay handoff origin.

use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use futures_util::StreamExt;
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::kernel::{
    execute_v3_direct_runtime_kernel_core_with_request_control,
    execute_v3_responses_direct_runtime_kernel_with_transport_and_request_control,
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::operation_runner::execute_v3_operation_runner_request_capture_client_json;
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw_with_purpose_and_scope, register_responses_direct_hooks,
    V3ChatDirectCodec, V3DirectRelayHandoffRequestOrigin, V3ProviderFailureRuntimeHealth,
    V3RequestExecutionControl, V3RequestPurpose, V3Server03HttpRequestRaw,
};
use serde_json::{json, Value};
use std::sync::Mutex;

const AUTH_ENV: &str = "REQ02_DIRECT_REQUEST_VIEW_TEST_KEY";

fn manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    std::env::set_var(AUTH_ENV, "req02-direct-request-view-test-key");
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3

[servers.responses]
bind = "127.0.0.1"
port = 46444
routing_group = "responses_group"
endpoints = ["responses"]
[servers.responses.execution]
allowed_modes = ["direct"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {}

[servers.chat]
bind = "127.0.0.1"
port = 46445
routing_group = "chat_group"
endpoints = ["openai_chat"]
[servers.chat.execution]
allowed_modes = ["direct"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {}

[servers.responses_handoff]
bind = "127.0.0.1"
port = 46446
routing_group = "responses_handoff_group"
endpoints = ["responses"]
[servers.responses_handoff.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {}

[servers.chat_handoff]
bind = "127.0.0.1"
port = 46447
routing_group = "chat_handoff_group"
endpoints = ["openai_chat"]
[servers.chat_handoff.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {}

[providers.resp_provider]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key", env = "REQ02_DIRECT_REQUEST_VIEW_TEST_KEY" }] }
[providers.resp_provider.models.gpt-test]
capabilities = ["text"]

[providers.chat_provider]
type = "openai_chat"
base_url = "http://127.0.0.1:9/v1"
default_model = "gpt-chat"
auth = { type = "api_key", entries = [{ alias = "key", env = "REQ02_DIRECT_REQUEST_VIEW_TEST_KEY" }] }
[providers.chat_provider.models.gpt-chat]
capabilities = ["text"]

[forwarders.responses]
model = "client-model"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "resp_provider", model = "gpt-test", priority = 1 }]

[forwarders.chat]
model = "client-model"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "chat_provider", model = "gpt-chat", priority = 1 }]

[route_groups.responses_group.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]

[route_groups.chat_group.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "chat", priority = 1 }]

[route_groups.responses_handoff_group.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]

[route_groups.chat_handoff_group.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "chat", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn direct_request_view_failure_keeps_the_scope_terminal_without_a_provider_attempt() {
    let manifest = manifest();
    let request_id = "req-direct-request-view-typed-failure";
    let control =
        V3RequestExecutionControl::new(&manifest, "responses", request_id, "responses")
            .expect("request control");
    let handle = control.request_context().clone();
    let transport = RecordingTransport::new(json!({"unused": true}));
    let mut output = execute_v3_responses_direct_runtime_kernel_with_transport_and_request_control(
        &manifest,
        raw(
            "responses",
            request_id,
            "exec-direct-request-view-typed-failure",
            "/v1/responses",
            Value::Null,
        ),
        routecodex_v3_runtime::hooks::register_responses_direct_hooks(),
        &transport,
        control,
    )
    .await;

    assert!(
        output.node_trace.contains(&"V3Config05ManifestPublished"),
        "the typed failure must keep its node trace"
    );
    assert!(output.error_chain.is_some(), "a non-object request cannot form provider wire");
    assert!(
        output.protocol_relay_handoff.is_none(),
        "a pre-transport failure must not fabricate a handoff"
    );
    assert!(
        output.provider_request_snapshot.is_none(),
        "no provider bytes may be claimed when no attempt ran"
    );
    assert!(
        transport.take_requests().is_empty(),
        "a pre-transport failure must not send a provider attempt"
    );
    assert!(
        handle.original_pair().is_ok(),
        "the failure must not reset the request pair"
    );
    assert!(
        handle.current_field_associations().is_ok(),
        "the failure must not drop the current canonical associations"
    );
    if let routecodex_v3_runtime::V3ClientBody::CommittedSse(stream) = &mut output.client_payload.body {
        while let Some(frame) = stream.next().await {
            assert!(!frame.is_empty(), "terminal error is explicitly framed");
        }
        assert!(handle.original_pair().is_err(), "terminal SSE EOF must release the same scope");
    } else {
        assert!(output.request_finalizer.is_some(), "terminal non-SSE output must carry its guard");
    }
    drop(output);
    assert!(handle.original_pair().is_err(), "terminal consumption must release the request scope");
}

fn failure_session_scope(server_id: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("test", server_id, format!("session:{server_id}"))
        .expect("test failure session scope")
        .with_transport_handoff_scope(format!("pipeline:{server_id}"), 46444, 1)
        .expect("test transport handoff scope")
}

fn raw(
    server_id: &str,
    request_id: &str,
    execution_id: &str,
    path: &str,
    client_body: Value,
) -> V3Server03HttpRequestRaw {
    let captured =
        execute_v3_operation_runner_request_capture_client_json(client_body).expect("capture");
    build_v3_server_03_http_request_raw_with_purpose_and_scope(
        server_id.to_string(),
        failure_session_scope(server_id),
        request_id.to_string(),
        execution_id.to_string(),
        "POST".to_string(),
        path.to_string(),
        V3RequestPurpose::Conversation,
        Some(46444),
        Some(format!("pipeline:{request_id}")),
        captured,
    )
}

struct RecordingTransport {
    response: Value,
    requests: Mutex<Vec<Value>>,
}

impl RecordingTransport {
    fn new(response: Value) -> Self {
        Self {
            response,
            requests: Mutex::new(Vec::new()),
        }
    }

    fn take_requests(&self) -> Vec<Value> {
        std::mem::take(&mut *self.requests.lock().expect("recording transport lock"))
    }
}

#[async_trait::async_trait]
impl ResponsesTransport for RecordingTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.requests
            .lock()
            .expect("recording transport lock")
            .push(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&self.response).expect("serialize test provider response"),
        ))
    }
}

fn exec_command() -> &'static str {
    "printf '%s\\n' 'literal $() and `bytes`'\nprintf '%s' 'exec-tail'"
}

fn apply_patch_text() -> &'static str {
    "*** Begin Patch\n*** Add File: /tmp/exact-path\n+literal $() and `bytes`\n*** End Patch\n"
}

fn mcp_output() -> Value {
    json!({"nested":[null,{"text":"complete\nMCP tail","meta":{"keep":true}}]})
}

fn responses_client_body() -> Value {
    json!({
        "model": "client-model",
        "tools": [{
            "type": "namespace",
            "name": "functions",
            "tools": [
                {"type": "function", "name": "exec", "parameters": {"type": "object"}},
                {"type": "custom", "name": "apply_patch", "format": {"type": "text"}}
            ]
        }],
        "input": [
            {
                "type": "function_call",
                "call_id": "exec-call",
                "namespace": "functions",
                "name": "exec",
                "arguments": exec_command()
            },
            {
                "type": "custom_tool_call",
                "call_id": "patch-call",
                "namespace": "functions",
                "name": "apply_patch",
                "input": apply_patch_text()
            },
            {
                "type": "function_call_output",
                "call_id": "mcp-call",
                "output": mcp_output()
            }
        ]
    })
}

fn chat_client_body() -> Value {
    json!({
        "model": "client-model",
        "messages": [
            {"role": "user", "content": "hello"},
            {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "exec-call",
                    "type": "function",
                    "function": {"name": "exec", "arguments": exec_command()}
                }]
            },
            {"role": "tool", "tool_call_id": "exec-call", "content": mcp_output().to_string()}
        ],
        "tools": [{
            "type": "function",
            "function": {"name": "exec", "parameters": {"type": "object"}}
        }]
    })
}

fn responses_provider_response() -> Value {
    json!({
        "id": "resp_direct_test",
        "status": "completed",
        "output": [{
            "type": "function_call",
            "call_id": "exec-call",
            "name": "exec",
            "arguments": exec_command()
        }]
    })
}

fn chat_provider_response() -> Value {
    json!({
        "id": "chatcmpl_direct_test",
        "object": "chat.completion",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "ok"},
            "finish_reason": "stop"
        }]
    })
}

#[tokio::test]
async fn responses_direct_request_view_consumes_canonical_and_preserves_tool_bytes() {
    let manifest = manifest();
    let execution_id = "exec-direct-request-view-responses";
    let request_id = "req-direct-request-view-responses";
    let control =
        V3RequestExecutionControl::new(&manifest, "responses", request_id, "responses")
            .expect("request control");
    let handle = control.request_context().clone();
    let transport = RecordingTransport::new(responses_provider_response());
    let output = execute_v3_responses_direct_runtime_kernel_with_transport_and_request_control(
        &manifest,
        raw(
            "responses",
            request_id,
            execution_id,
            "/v1/responses",
            responses_client_body(),
        ),
        register_responses_direct_hooks(),
        &transport,
        control,
    )
    .await;

    let pair = handle
        .original_pair()
        .expect("Responses Direct must publish the immutable original pair");
    assert!(pair
        .inverse_context
        .tool_declarations
        .iter()
        .any(|declaration| declaration.kind == "function"
            && declaration.name.as_deref() == Some("exec")));
    assert!(pair
        .inverse_context
        .tool_declarations
        .iter()
        .any(|declaration| declaration.kind == "custom"
            && declaration.name.as_deref() == Some("apply_patch")));
    assert!(handle
        .current_field_associations()
        .expect("Direct must seed current field associations")
        .associations()
        .iter()
        .any(|association| association.current_destination.contains("chat.tools")));

    let requests = transport.take_requests();
    assert_eq!(requests.len(), 1, "exactly one provider attempt");
    let body = &requests[0];
    let input = body["input"]
        .as_array()
        .expect("Responses provider input must remain an array");
    assert!(
        input
            .iter()
            .all(|item| item.get("role").and_then(Value::as_str) != Some("user")),
        "the legal tool follow-up must reach the provider without a user message"
    );
    assert_eq!(input[0]["type"], "function_call");
    assert_eq!(input[1]["type"], "custom_tool_call");
    assert_eq!(input[2]["type"], "function_call_output");
    // The Responses provider wire (committed provider-responses transport)
    // flattens each namespace child into a plain function tool; the typed
    // request pair still records the original namespace and kind, and the
    // input items keep namespace plus the exact exec/patch/MCP values.
    assert_eq!(body["tools"].as_array().map(Vec::len), Some(2));
    assert_eq!(body["tools"][0]["type"], "function");
    assert_eq!(body["tools"][0]["name"], "functions__exec");
    assert_eq!(body["tools"][0]["parameters"], json!({"type": "object"}));
    assert_eq!(body["tools"][1]["type"], "function");
    assert_eq!(body["tools"][1]["name"], "functions__apply_patch");
    assert!(pair
        .inverse_context
        .tool_declarations
        .iter()
        .any(|declaration| declaration.kind == "function"
            && declaration.name.as_deref() == Some("exec")
            && declaration.namespace.as_ref() == Some(&json!("functions"))));
    assert!(pair
        .inverse_context
        .tool_declarations
        .iter()
        .any(|declaration| declaration.kind == "custom"
            && declaration.name.as_deref() == Some("apply_patch")
            && declaration.namespace.as_ref() == Some(&json!("functions"))));
    assert_eq!(body["input"][0]["call_id"], "exec-call");
    assert_eq!(body["input"][0]["namespace"], "functions");
    assert_eq!(body["input"][0]["arguments"], exec_command());
    assert_eq!(body["input"][1]["call_id"], "patch-call");
    assert_eq!(body["input"][1]["namespace"], "functions");
    assert_eq!(body["input"][1]["input"], apply_patch_text());
    assert_eq!(body["input"][2]["call_id"], "mcp-call");
    assert_eq!(body["input"][2]["output"], mcp_output());
    assert_eq!(body["model"], "gpt-test");

    drop(output);
}

#[tokio::test]
async fn chat_direct_request_view_consumes_canonical_and_preserves_tool_bytes() {
    let manifest = manifest();
    let execution_id = "exec-direct-request-view-chat";
    let request_id = "req-direct-request-view-chat";
    let control =
        V3RequestExecutionControl::new(&manifest, "chat", request_id, "openai_chat")
            .expect("request control");
    let handle = control.request_context().clone();
    let transport = RecordingTransport::new(chat_provider_response());
    let output = execute_v3_direct_runtime_kernel_core_with_request_control::<V3ChatDirectCodec, _>(
        (),
        &manifest,
        raw(
            "chat",
            request_id,
            execution_id,
            "/v1/chat/completions",
            chat_client_body(),
        ),
        &transport,
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest),
        0,
        true,
        None,
        None,
        control,
    )
    .await;

    let pair = handle
        .original_pair()
        .expect("Chat Direct must publish the immutable original pair");
    assert_eq!(pair.inverse_context.entry_protocol, "openai_chat");
    assert!(handle
        .current_field_associations()
        .expect("Chat Direct must seed current field associations")
        .associations()
        .iter()
        .any(|association| association.current_destination.contains("chat.messages")));

    let requests = transport.take_requests();
    assert_eq!(requests.len(), 1, "exactly one provider attempt");
    let body = &requests[0];
    assert_eq!(body["messages"][1]["tool_calls"][0]["id"], "exec-call");
    assert_eq!(
        body["messages"][1]["tool_calls"][0]["function"]["name"],
        "exec"
    );
    assert_eq!(
        body["messages"][1]["tool_calls"][0]["function"]["arguments"],
        exec_command()
    );
    assert_eq!(body["messages"][2]["tool_call_id"], "exec-call");
    assert_eq!(body["messages"][2]["content"], mcp_output().to_string());
    assert_eq!(body["model"], "gpt-chat");

    drop(output);
}

#[tokio::test]
async fn direct_handoff_marks_already_canonical_and_keeps_the_same_handle() {
    let manifest = manifest();
    for (server_id, entry_protocol, path, body, execution_id) in [
        (
            "responses_handoff",
            "responses",
            "/v1/responses",
            responses_client_body(),
            "exec-handoff-request-view-responses",
        ),
        (
            "chat_handoff",
            "openai_chat",
            "/v1/chat/completions",
            chat_client_body(),
            "exec-handoff-request-view-chat",
        ),
    ] {
        let request_id = format!("req-handoff-request-view-{entry_protocol}");
        let control =
            V3RequestExecutionControl::new(&manifest, server_id, &request_id, entry_protocol)
                .expect("request control");
        let handle = control.request_context().clone();
        let transport = RecordingTransport::new(json!({"unused": true}));
        let raw = raw(server_id, &request_id, execution_id, path, body);
        let output = if entry_protocol == "responses" {
            execute_v3_responses_direct_runtime_kernel_with_transport_and_request_control(
                &manifest,
                raw,
                register_responses_direct_hooks(),
                &transport,
                control,
            )
            .await
        } else {
            execute_v3_direct_runtime_kernel_core_with_request_control::<V3ChatDirectCodec, _>(
                (),
                &manifest,
                raw,
                &transport,
                V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest),
                0,
                true,
                None,
                None,
                control,
            )
            .await
        };
        let handoff = output
            .protocol_relay_handoff
            .as_ref()
            .expect("relay-only server must produce a typed handoff");
        assert_eq!(
            handoff.request_entry_origin,
            V3DirectRelayHandoffRequestOrigin::AlreadyCanonical
        );
        assert!(
            handoff
                .request_execution_control
                .request_context()
                .same_scope(&handle),
            "handoff must move the same request scope"
        );
        assert!(
            handle.original_pair().is_ok(),
            "handoff must not reset or re-normalize the request pair"
        );
        assert!(
            handle.current_field_associations().is_ok(),
            "handoff must keep the current canonical associations"
        );
        assert!(
            transport.take_requests().is_empty(),
            "a relay decision must not send a Direct provider attempt"
        );
    }
}
