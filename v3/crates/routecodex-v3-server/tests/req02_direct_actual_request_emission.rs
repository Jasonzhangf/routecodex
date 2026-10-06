//! REQ02 Direct actual request-emission coverage.
//!
//! This test enters through the public capture/normalize/govern path, invokes
//! the registered Direct request hook, and sends the exact transport request
//! returned by that hook through the real provider HTTP transport to a loopback
//! capture server. The returned `AttemptContext` is therefore checked against
//! the provider bytes that were actually emitted, not against a reconstructed
//! payload or a hand-built observer.

use axum::{extract::State, routing::post, Json, Router};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::kernel::{
    default_responses_transport, ResponsesTransport, V3DirectRequestProjectionView,
};
use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_request,
    AttemptContext, CanonicalFieldEdit, RequestInvocationContext, RequestNormalizationEntry,
    RequestOriginKind, RequestScopedContextPair, ToolDeclarationReference, ToolMappingReference,
    V3RequestContextHandle,
};
use routecodex_v3_runtime::{
    build_v3_req_04_standardized_responses_from_v3_server_03,
    build_v3_server_03_http_request_raw_with_purpose_and_scope,
    govern_v3_operation_runner_current_request_fields,
    plan_v3_responses_protocol_execution_with_provider_health, register_responses_direct_hooks,
    V3HubExecutionMode, V3HubProviderWireProtocol, V3ProviderFailureRuntimeHealth,
    V3RequestPurpose, V3Server03HttpRequestRaw,
};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

const AUTH_ENV: &str = "REQ02_DIRECT_ACTUAL_REQUEST_EMISSION_TEST_KEY";

fn manifest(base_url: &str) -> routecodex_v3_config::V3Config05ManifestPublished {
    std::env::set_var(AUTH_ENV, "req02-direct-actual-request-emission-test-key");
    let authoring = r#"
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

[providers.resp_provider]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key", env = "REQ02_DIRECT_ACTUAL_REQUEST_EMISSION_TEST_KEY" }] }
[providers.resp_provider.models.gpt-test]
capabilities = ["text"]

[forwarders.responses]
model = "client-model"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "resp_provider", model = "gpt-test", priority = 1 }]

[route_groups.responses_group.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#
    .replace("http://127.0.0.1:9/v1", base_url);
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&authoring).unwrap()).unwrap()
}

fn failure_session_scope(server_id: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("test", server_id, format!("session:{server_id}"))
        .expect("test failure session scope")
        .with_transport_handoff_scope(format!("pipeline:{server_id}"), 46444, 1)
        .expect("test transport handoff scope")
}

fn raw(
    request_id: &str,
    execution_id: &str,
    client_body: Value,
) -> V3Server03HttpRequestRaw {
    let captured =
        execute_v3_operation_runner_request_capture_client_json(client_body).expect("capture");
    build_v3_server_03_http_request_raw_with_purpose_and_scope(
        "responses".to_string(),
        failure_session_scope("responses"),
        request_id.to_string(),
        execution_id.to_string(),
        "POST".to_string(),
        "/v1/responses".to_string(),
        V3RequestPurpose::Conversation,
        Some(46444),
        Some(format!("pipeline:{request_id}")),
        captured,
    )
}

fn exec_arguments() -> String {
    serde_json::to_string(&json!({
        "cmd": format!(
            "printf '%s' '{}{}'",
            "x".repeat(70_000),
            "REQ02_ACTUAL_EXEC_TAIL"
        ),
        "workdir": "/workspace/routecodex",
        "yield_time_ms": 1000
    }))
    .unwrap()
}

fn apply_patch_text() -> String {
    format!(
        "*** Begin Patch\n*** Add File: /tmp/req02-direct-actual-emission\n+{}\n*** End Patch\n",
        "literal $() and `bytes`\n+".repeat(200)
    )
}

fn mcp_arguments() -> String {
    serde_json::to_string(&json!({
        "path": "docs/architecture/v3-function-map.yml",
        "filters": {
            "labels": ["required", "runtime"],
            "nested": {"keep": [1, null, true, {"value": "opaque"}]}
        },
        "cursor": null
    }))
    .unwrap()
}

fn mcp_output() -> Value {
    json!({
        "content": [{"type": "text", "text": "complete\nMCP tail"}],
        "structuredContent": {
            "values": [1, null, {"nested": ["keep", true]}]
        },
        "isError": false
    })
}

fn client_body() -> Value {
    json!({
        "model": "client-model",
        "tools": [
            {
                "type": "namespace",
                "name": "removed",
                "tools": [
                    {
                        "type": "function",
                        "name": "drop",
                        "parameters": {"type": "object"}
                    }
                ]
            },
            {
                "type": "namespace",
                "name": "functions",
                "tools": [
                    {
                        "type": "function",
                        "name": "drop_first",
                        "parameters": {"type": "object"}
                    },
                    {
                        "type": "custom",
                        "name": "apply_patch",
                        "format": {"type": "text"}
                    },
                    {
                        "type": "function",
                        "name": "exec",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}}
                        }
                    }
                ]
            },
            {
                "type": "namespace",
                "name": "mcp__mcpx",
                "tools": [
                    {
                        "type": "function",
                        "name": "workspace",
                        "parameters": {"type": "object"}
                    },
                    {
                        "type": "namespace",
                        "name": "workspace",
                        "tools": [
                            {
                                "type": "function",
                                "name": "read",
                                "parameters": {
                                    "type": "object",
                                    "properties": {"path": {"type": "string"}}
                                }
                            }
                        ]
                    }
                ]
            }
        ],
        "input": [
            {
                "type": "function_call",
                "call_id": "exec-call",
                "namespace": "functions",
                "name": "exec",
                "arguments": exec_arguments()
            },
            {
                "type": "custom_tool_call",
                "call_id": "patch-call",
                "namespace": "functions",
                "name": "apply_patch",
                "input": apply_patch_text()
            },
            {
                "type": "function_call",
                "call_id": "mcp-call",
                "namespace": "mcp__mcpx.workspace",
                "name": "read",
                "arguments": mcp_arguments()
            },
            {
                "type": "function_call_output",
                "call_id": "mcp-call",
                "output": mcp_output()
            }
        ]
    })
}

async fn start_capture_server() -> (String, mpsc::UnboundedReceiver<Value>, oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(capture_provider_request))
        .with_state(captures_tx);
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{address}/v1"), captures_rx, shutdown_tx)
}

async fn capture_provider_request(
    State(captures): State<mpsc::UnboundedSender<Value>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    captures.send(body).unwrap();
    Json(json!({
        "id": "resp_actual_request_emission",
        "status": "completed",
        "output": []
    }))
}

fn mapping_for_source<'a>(
    attempt: &'a AttemptContext,
    source_path: &str,
) -> &'a ToolMappingReference {
    attempt
        .declarations
        .tool_mappings
        .iter()
        .find(|mapping| mapping.source_path == source_path)
        .unwrap_or_else(|| panic!("missing actual emission mapping for {source_path}"))
}

fn declaration_for_source<'a>(
    pair: &'a RequestScopedContextPair,
    source_path: &str,
) -> &'a ToolDeclarationReference {
    pair.inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == source_path)
        .unwrap_or_else(|| panic!("missing original declaration for {source_path}"))
}

fn input_item<'a>(body: &'a Value, call_id: &str, item_type: &str) -> &'a Value {
    body["input"]
        .as_array()
        .expect("provider Responses input array")
        .iter()
        .find(|item| item["call_id"] == call_id && item["type"] == item_type)
        .unwrap_or_else(|| panic!("missing provider input item {item_type}/{call_id}"))
}

#[tokio::test]
async fn registered_direct_request_hook_http_emission_matches_returned_attempt_context() {
    let (base_url, mut captures, shutdown) = start_capture_server().await;
    let manifest = manifest(&base_url);
    let request_id = "req-direct-actual-request-emission";
    let execution_id = "exec-direct-actual-request-emission";
    let body = client_body();
    let raw_request = raw(request_id, execution_id, body.clone());
    let standardized =
        build_v3_req_04_standardized_responses_from_v3_server_03(raw_request.clone())
            .expect("standardized Responses request");
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw_request,
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest),
        0,
    )
    .expect("public protocol plan");
    let hooks = register_responses_direct_hooks();
    let policy = hooks.run_route(plan.decision.target.clone(), &standardized);

    let handle = V3RequestContextHandle::new(request_id.to_string(), "responses".to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}-invocation"),
        format!("{request_id}-attempt"),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(body)
        .expect("public capture entry");
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public normalize entry");
    let canonical = govern_v3_operation_runner_current_request_fields(
        &canonical,
        &invocation,
        &[
            CanonicalFieldEdit::Remove {
                path: "chat.tools[0]".to_string(),
            },
            CanonicalFieldEdit::Remove {
                path: "chat.tools[0].tools[0]".to_string(),
            },
        ],
    )
    .expect("registered paired removals");
    let pair = handle
        .original_pair()
        .expect("immutable original request pair");
    let current = handle
        .current_field_associations()
        .expect("current field associations");
    let projection = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Direct,
        V3HubProviderWireProtocol::Responses,
        &plan.decision.target.candidate,
        &format!("{request_id}:direct-attempt:0"),
    )
    .expect("Direct request projection");
    let view = V3DirectRequestProjectionView {
        payload: projection.payload,
        attempt: projection.attempt,
        inverse: pair.inverse_context.clone(),
        current: current.clone(),
    };
    let (wire, actual_attempt) = hooks
        .run_request_projection(&policy, &view)
        .expect("registered Direct request projection hook");
    let transport_request = hooks
        .run_provider_transport(wire)
        .expect("registered Direct provider transport hook");
    let expected_http_body = transport_request.body().clone();
    let response = default_responses_transport()
        .send(transport_request)
        .await
        .expect("real loopback provider HTTP transport");
    assert_eq!(response.status(), 200);
    let captured_http_body = captures
        .recv()
        .await
        .expect("provider HTTP transport must emit one captured request");
    assert_eq!(
        captured_http_body, expected_http_body,
        "the loopback provider must receive the exact request body returned by the Direct hook"
    );

    let patch = mapping_for_source(&actual_attempt, "request.tools[1].tools[1]");
    let exec = mapping_for_source(&actual_attempt, "request.tools[1].tools[2]");
    let workspace = mapping_for_source(&actual_attempt, "request.tools[2].tools[0]");
    let read = mapping_for_source(&actual_attempt, "request.tools[2].tools[1].tools[0]");
    assert_eq!(actual_attempt.declarations.tool_mappings.len(), 4);
    assert_eq!(patch.destination_path, "tools[0]");
    assert_eq!(patch.emitted_kind, "function");
    assert_eq!(patch.emitted_name.as_deref(), Some("functions__apply_patch"));
    assert_eq!(
        patch.declaration_record_id,
        declaration_for_source(&pair, "request.tools[1].tools[1]").record_id
    );
    assert_eq!(exec.destination_path, "tools[1]");
    assert_eq!(exec.emitted_kind, "function");
    assert_eq!(exec.emitted_name.as_deref(), Some("functions__exec"));
    assert_eq!(
        exec.declaration_record_id,
        declaration_for_source(&pair, "request.tools[1].tools[2]").record_id
    );
    assert_eq!(workspace.destination_path, "tools[2]");
    assert_eq!(workspace.emitted_kind, "function");
    assert_eq!(
        workspace.emitted_name.as_deref(),
        Some("mcp__mcpx__workspace")
    );
    assert_eq!(
        workspace.declaration_record_id,
        declaration_for_source(&pair, "request.tools[2].tools[0]").record_id
    );
    assert_eq!(read.destination_path, "tools[3]");
    assert_eq!(read.emitted_kind, "function");
    assert_eq!(
        read.emitted_name.as_deref(),
        Some("mcp__mcpx__workspace__read")
    );
    assert_eq!(
        read.declaration_record_id,
        declaration_for_source(&pair, "request.tools[2].tools[1].tools[0]").record_id
    );

    assert_eq!(captured_http_body["tools"].as_array().unwrap().len(), 4);
    assert_eq!(captured_http_body["tools"][0]["type"], "function");
    assert_eq!(
        captured_http_body["tools"][0]["name"],
        patch.emitted_name.clone().unwrap()
    );
    assert_eq!(captured_http_body["tools"][1]["type"], "function");
    assert_eq!(
        captured_http_body["tools"][1]["name"],
        exec.emitted_name.clone().unwrap()
    );
    assert_eq!(captured_http_body["tools"][2]["type"], "function");
    assert_eq!(
        captured_http_body["tools"][2]["name"],
        workspace.emitted_name.clone().unwrap()
    );
    assert_eq!(captured_http_body["tools"][3]["type"], "function");
    assert_eq!(
        captured_http_body["tools"][3]["name"],
        read.emitted_name.clone().unwrap()
    );
    assert!(captured_http_body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|tool| tool["name"] != "removed__drop"));
    assert!(captured_http_body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|tool| tool["name"] != "functions__drop_first"));

    let exec_call = input_item(&captured_http_body, "exec-call", "function_call");
    assert_eq!(exec_call["name"], "functions__exec");
    assert_eq!(exec_call["namespace"], "functions");
    assert_eq!(exec_call["arguments"], exec_arguments());
    let patch_call = input_item(&captured_http_body, "patch-call", "custom_tool_call");
    assert_eq!(patch_call["name"], "functions__apply_patch");
    assert_eq!(patch_call["namespace"], "functions");
    assert_eq!(patch_call["input"], apply_patch_text());
    let mcp_call = input_item(&captured_http_body, "mcp-call", "function_call");
    assert_eq!(mcp_call["name"], "mcp__mcpx__workspace__read");
    assert_eq!(mcp_call["namespace"], "mcp__mcpx.workspace");
    assert_eq!(mcp_call["arguments"], mcp_arguments());
    let mcp_result = input_item(&captured_http_body, "mcp-call", "function_call_output");
    assert_eq!(mcp_result["output"], mcp_output());

    let _ = shutdown.send(());
}
