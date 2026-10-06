//! R40 public consumer for the standard Responses hosted-history emitter.
//!
//! The tests enter through the public SDK capture/normalize/current-edit path
//! and read the Relay Responses provider input produced by
//! `project_canonical_request`. They assert the single current native event,
//! its position among ordinary history, current edits, and non-deduplication
//! of distinct events sharing an ID.

use routecodex_v3_config::{
    V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::hub_v1::{V3HubExecutionMode, V3HubProviderWireProtocol};
use routecodex_v3_runtime::operation_runner::{
    apply_canonical_field_edit, execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_request,
    CanonicalFieldEdit, CurrentFieldAssociations, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair,
    V3RequestContextHandle, V3TargetCandidate,
};
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime_with_default_transport, V3ResponsesRelayClientBody,
    V3ResponsesRelayRuntimeInput,
};
use axum::{extract::State, routing::post, Json, Router};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot},
    time::{timeout, Duration},
};

const EXTENSION_KEY: &str = "responses_hosted_history_event";

fn responses_target() -> V3TargetCandidate {
    V3TargetCandidate {
        provider_id: "req02-r40-provider".to_string(),
        provider_type: "responses".to_string(),
        auth_alias: "primary".to_string(),
        model_id: "req02-r40-model".to_string(),
        wire_model: "req02-r40-wire".to_string(),
        visible_model_ids: vec!["client-model".to_string()],
        model_capabilities: vec!["text".to_string()],
        web_search_execution_mode: V3WebSearchExecutionMode::None,
        max_context_tokens: None,
        max_tokens: None,
        context_token_estimate_scale_bps: 10_000,
        base_url: "https://provider.invalid/v1".to_string(),
        responses_process: None,
        responses_transport: V3ResponsesTransportKind::Http,
        websocket_v2_url: None,
        provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
        request_timeout_ms: 300_000,
        sse_first_frame_timeout_ms: None,
        initial_concurrency_budget: 8,
        concurrency_acquire_timeout_ms: 60_000,
        compatibility_profile: None,
        headers: Default::default(),
        env_name: Some("REQ02_R40_HOSTED_KEY".to_string()),
        token_file: None,
        secret_file: None,
        secret_key: None,
        api_key: None,
        required_capabilities: Vec::new(),
        priority: 0,
        weight: 1,
        pool_ids: vec!["default".to_string()],
        default_pool_member: true,
        path: vec!["req02-r40-provider".to_string()],
    }
}

fn sdk_request(
    request_id: &str,
    raw: Value,
) -> (Value, RequestScopedContextPair, CurrentFieldAssociations) {
    let handle = V3RequestContextHandle::new(request_id.to_string(), "responses".to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}-invocation"),
        format!("{request_id}-attempt"),
        RequestOriginKind::ClientEntry,
    );
    let captured =
        execute_v3_operation_runner_request_capture_client_json(raw).expect("public capture");
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public normalize");
    let pair = handle.original_pair().expect("immutable original pair");
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    (canonical, pair, current)
}

fn relay_responses(
    canonical: &Value,
    pair: &RequestScopedContextPair,
    current: &CurrentFieldAssociations,
) -> Value {
    project_canonical_request(
        canonical,
        &pair.inverse_context,
        current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Responses,
        &responses_target(),
        "req02-r40-attempt",
    )
    .expect("standard Responses Relay projection")
    .payload
}

fn edit(
    canonical: &Value,
    current: &CurrentFieldAssociations,
    edit: CanonicalFieldEdit,
) -> (Value, CurrentFieldAssociations) {
    apply_canonical_field_edit(canonical, current, &edit).expect("typed current edit")
}

fn hosted_index(canonical: &Value) -> usize {
    canonical["messages"]
        .as_array()
        .expect("canonical messages")
        .iter()
        .position(|message| {
            message["routecodex_chat_extension"][EXTENSION_KEY].is_object()
        })
        .unwrap_or_else(|| panic!("missing hosted anchor: {canonical}"))
}

fn event_path(message_index: usize) -> String {
    format!(
        "chat.messages[{message_index}].routecodex_chat_extension.{EXTENSION_KEY}"
    )
}

fn input_descriptors(payload: &Value) -> Vec<(String, Option<String>)> {
    payload["input"]
        .as_array()
        .expect("provider input")
        .iter()
        .map(|item| {
            let kind = item["type"]
                .as_str()
                .unwrap_or("message")
                .to_string();
            let id = item["call_id"]
                .as_str()
                .or_else(|| item["id"].as_str())
                .map(str::to_string);
            (kind, id)
        })
        .collect()
}

#[test]
fn relay_responses_emits_current_event_once_in_full_history_order() {
    let long = format!("{}\r\nRESPONSES_HOSTED_EXACT_TAIL", "x".repeat(70_000));
    let item = json!({
        "type": "web_search_call",
        "id": "ws_full",
        "status": "completed",
        "action": {"type": "search", "query": long, "dotted.key": {"a.b": "c"}},
        "result": {"title": "RouteCodex", "url": "https://example.test"},
        "unknown_sibling": {"future": [1, null, "x"]},
        "execution": {"attempts": 2}
    });
    let raw = json!({
        "model": "client-model",
        "input": [
            {"role": "user", "content": "before"},
            item.clone(),
            {"type": "function_call", "id": "fc_exec", "call_id": "exec-call",
                "name": "exec", "arguments": "{\"cmd\":\"complete\"}"},
            {"type": "function_call_output", "id": "fco_exec", "call_id": "exec-call",
                "output": "exec-result"},
            {"type": "custom_tool_call", "call_id": "patch-call",
                "name": "apply_patch", "input": "*** Begin Patch\n+opaque\n*** End Patch\n"},
            {"type": "custom_tool_call_output", "call_id": "patch-call",
                "output": "patch-result"},
            {"type": "function_call", "call_id": "mcp-call",
                "namespace": "mcp__mcpx.workspace", "name": "read",
                "arguments": "{\"path\":\"x\"}"},
            {"type": "function_call_output", "call_id": "mcp-call",
                "output": "mcp-result"},
            {"role": "user", "content": "after"}
        ]
    });
    let (canonical, pair, current) = sdk_request("req02-r40-full-order", raw);
    let canonical_before = canonical.clone();
    let payload = relay_responses(&canonical, &pair, &current);

    assert_eq!(
        canonical, canonical_before,
        "standard Responses projection must not mutate canonical"
    );
    let input = payload["input"].as_array().expect("provider input");
    let events = input
        .iter()
        .filter(|entry| entry["type"] == "web_search_call" && entry["id"] == "ws_full")
        .count();
    assert_eq!(events, 1, "current event must be emitted exactly once");
    assert_eq!(
        payload["input"][1], item,
        "the complete original native event must be the hosted history item"
    );
    assert_eq!(
        input_descriptors(&payload),
        vec![
            ("message".to_string(), None),
            ("web_search_call".to_string(), Some("ws_full".to_string())),
            ("function_call".to_string(), Some("exec-call".to_string())),
            ("function_call_output".to_string(), Some("exec-call".to_string())),
            ("custom_tool_call".to_string(), Some("patch-call".to_string())),
            ("custom_tool_call_output".to_string(), Some("patch-call".to_string())),
            ("function_call".to_string(), Some("mcp-call".to_string())),
            ("function_call_output".to_string(), Some("mcp-call".to_string())),
            ("message".to_string(), None),
        ],
        "hosted and ordinary history must keep full input order"
    );
    assert!(
        !payload.to_string().contains("routecodex_chat_extension"),
        "typed request control must not enter the provider payload"
    );
}

#[test]
fn current_replace_and_field_remove_govern_the_emitted_event() {
    let item = json!({
        "type": "web_search_call",
        "id": "ws_edit",
        "status": "completed",
        "action": {"type": "search", "query": "before"},
        "result": {"title": "before", "url": "https://example.test"},
        "result_items": [{"rank": 1}, {"rank": 2}],
        "unknown_field": "keep"
    });
    let (canonical, pair, current) =
        sdk_request("req02-r40-current-edit", json!({"model":"m","input":[item]}));
    let index = hosted_index(&canonical);
    let base = event_path(index);

    let (canonical, current) = edit(
        &canonical,
        &current,
        CanonicalFieldEdit::Replace {
            path: format!("{base}.action"),
            value: json!({"type": "search", "query": "after"}),
        },
    );
    let (canonical, current) = edit(
        &canonical,
        &current,
        CanonicalFieldEdit::Replace {
            path: format!("{base}.unknown_field"),
            value: json!({"replaced": true}),
        },
    );
    let (canonical, current) = edit(
        &canonical,
        &current,
        CanonicalFieldEdit::MoveArray {
            array_path: format!("{base}.result_items"),
            from: 0,
            to: 1,
        },
    );
    let (canonical, current) = edit(
        &canonical,
        &current,
        CanonicalFieldEdit::Remove {
            path: format!("{base}.result"),
        },
    );

    let payload = relay_responses(&canonical, &pair, &current);
    let expected = json!({
        "type": "web_search_call",
        "id": "ws_edit",
        "status": "completed",
        "action": {"type": "search", "query": "after"},
        "result_items": [{"rank": 2}, {"rank": 1}],
        "unknown_field": {"replaced": true}
    });
    assert_eq!(
        payload["input"],
        json!([expected]),
        "current replace/remove/move must govern the single emitted event"
    );
}

#[test]
fn moving_the_anchor_keeps_the_event_at_its_current_message_index() {
    let item = json!({
        "type": "web_search_call",
        "id": "ws_move",
        "status": "completed",
        "action": {"type": "search", "query": "q"},
        "result": {"title": "t"}
    });
    let raw = json!({
        "model": "m",
        "input": [
            {"role": "user", "content": "before"},
            item.clone(),
            {"role": "user", "content": "after"}
        ]
    });
    let (canonical, pair, current) = sdk_request("req02-r40-move-anchor", raw);
    let index = hosted_index(&canonical);
    let message_count = canonical["messages"].as_array().unwrap().len();
    let (canonical, current) = edit(
        &canonical,
        &current,
        CanonicalFieldEdit::MoveArray {
            array_path: "chat.messages".to_string(),
            from: index,
            to: message_count - 1,
        },
    );

    let payload = relay_responses(&canonical, &pair, &current);
    let input = payload["input"].as_array().unwrap();
    assert_eq!(
        input.last().unwrap(),
        &item,
        "moving the hosted anchor must move the native event with its current association"
    );
    assert_eq!(
        input
            .iter()
            .filter(|entry| entry["id"] == "ws_move")
            .count(),
        1
    );
}

#[test]
fn whole_anchor_removal_emits_no_event() {
    let item = json!({
        "type": "web_search_call",
        "id": "ws_remove",
        "status": "completed",
        "action": {"type": "search", "query": "q"}
    });
    let raw = json!({
        "model": "m",
        "input": [
            {"role": "user", "content": "keep"},
            item.clone(),
            {"role": "user", "content": "tail"}
        ]
    });
    let (canonical, pair, current) = sdk_request("req02-r40-remove-anchor", raw);
    let index = hosted_index(&canonical);
    let (canonical, current) = edit(
        &canonical,
        &current,
        CanonicalFieldEdit::Remove {
            path: format!("chat.messages[{index}]"),
        },
    );

    let payload = relay_responses(&canonical, &pair, &current);
    assert_eq!(
        input_descriptors(&payload),
        vec![
            ("message".to_string(), None),
            ("message".to_string(), None),
        ],
        "a removed hosted anchor must leave only ordinary history"
    );
}

#[test]
fn absent_original_id_is_preserved_and_no_current_declaration_is_needed() {
    let item = json!({
        "type": "web_search_call",
        "status": "failed",
        "action": "raw-action",
        "result": {"title": "t"},
        "error": {"code": "upstream"},
        "unknown_member": {"x": 1}
    });
    let (canonical, pair, current) =
        sdk_request("req02-r40-no-id", json!({"model":"m","input":[item.clone()]}));
    let payload = relay_responses(&canonical, &pair, &current);
    assert_eq!(
        payload["input"],
        json!([item]),
        "absent identity and declaration-less historical events must survive"
    );
}

#[test]
fn distinct_events_with_the_same_id_are_not_deduplicated() {
    let first = json!({
        "type": "web_search_call",
        "id": "same-id",
        "action": {"type": "search", "query": "one"}
    });
    let second = json!({
        "type": "web_search_call",
        "id": "same-id",
        "action": {"type": "search", "query": "two"}
    });
    let raw = json!({
        "model": "m",
        "input": [
            {"role": "user", "content": "before"},
            first.clone(),
            {"role": "user", "content": "middle"},
            second.clone(),
            {"role": "user", "content": "after"}
        ]
    });
    let (canonical, pair, current) = sdk_request("req02-r40-same-id", raw);
    let payload = relay_responses(&canonical, &pair, &current);
    let events = payload["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["type"] == "web_search_call" && entry["id"] == "same-id")
        .collect::<Vec<_>>();
    assert_eq!(events.len(), 2, "shared call ids must not deduplicate events");
    assert_eq!(events[0]["action"]["query"], "one");
    assert_eq!(events[1]["action"]["query"], "two");
}

struct R40ProviderState {
    expected_event: Value,
    captures: mpsc::UnboundedSender<Value>,
}

async fn r40_responses_provider(
    State(state): State<Arc<R40ProviderState>>,
    Json(body): Json<Value>,
) -> (axum::http::StatusCode, Json<Value>) {
    let _ = state.captures.send(body.clone());
    let event_ok = body["input"]
        .as_array()
        .and_then(|items| items.get(1))
        .is_some_and(|item| item == &state.expected_event);
    let event_count = body["input"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| item["type"] == "web_search_call")
                .count()
        })
        .unwrap_or(0);
    if !event_ok || event_count != 1 {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"error":{"message":"provider received changed hosted history"}})),
        );
    }
    (
        axum::http::StatusCode::OK,
        Json(json!({
            "id":"r40-http-response","object":"response","status":"completed","model":"r40-wire",
            "output":[{"type":"message","id":"r40-message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"r40-http-complete","annotations":[]}]}],
            "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}
        })),
    )
}

#[tokio::test]
async fn real_http_provider_capture_accepts_complete_current_event_then_completes() {
    std::env::set_var("REQ02_R40_HOSTED_KEY", "r40-hosted-key");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures, mut received) = mpsc::unbounded_channel();
    let event = json!({
        "type": "web_search_call",
        "id": "ws_http",
        "status": "completed",
        "action": {"type": "search", "query": "routecodex hosted history"},
        "result": {"title": "RouteCodex", "url": "https://example.test"},
        "unknown_marker": {"keep": true}
    });
    let app = Router::new()
        .route("/v1/responses", post(r40_responses_provider))
        .with_state(Arc::new(R40ProviderState {
            expected_event: event.clone(),
            captures,
        }));
    let (shutdown, stopped) = oneshot::channel::<()>();
    let upstream = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let config = format!(
        r#"
version = 3
[servers.r40]
bind = "127.0.0.1"
port = 45444
routing_group = "r40"
endpoints = ["responses"]
[servers.r40.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{}}
[providers.r40]
type = "responses"
base_url = "http://{address}/v1"
default_model = "r40-wire"
auth = {{type="api_key",entries=[{{alias="key",env="REQ02_R40_HOSTED_KEY"}}]}}
[providers.r40.models.r40-wire]
capabilities = ["text", "tools"]
[route_groups.r40.pools.default]
selection = {{strategy="priority"}}
targets = [{{kind="provider_model",provider="r40",model="r40-wire",key="key",priority=1}}]
"#
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&config).unwrap()).unwrap();
    let raw = json!({
        "model": "r40-wire",
        "stream": false,
        "input": [
            {"role": "user", "content": "before"},
            event.clone(),
            {"role": "user", "content": "after"}
        ]
    });
    let result = timeout(
        Duration::from_secs(5),
        execute_v3_responses_relay_runtime_with_default_transport(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: "r40".into(),
                request_id: "r40-http".into(),
                payload: raw,
                failure_session_scope: V3ProviderFailureSessionScope::new("r40", "r40", "r40-http")
                    .unwrap(),
            },
        ),
    )
    .await;
    let capture = received.try_recv();
    let duplicate = received.try_recv();
    let _ = shutdown.send(());
    timeout(Duration::from_secs(3), upstream)
        .await
        .unwrap()
        .unwrap();
    let output = result
        .expect("public consumer must finish")
        .expect("real HTTP attempt must succeed");
    assert_eq!(
        output.status, 200,
        "strict provider rejected the hosted history: {output:?}"
    );
    assert!(
        output.error_chain.is_none(),
        "successful first attempt must have no error chain"
    );
    let capture = capture.expect("actual provider must receive the request");
    assert!(
        duplicate.is_err(),
        "a successful input must require exactly one attempt"
    );
    assert_eq!(
        capture["input"][1], event,
        "the provider must receive the complete current native event once"
    );
    assert_eq!(
        capture["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "web_search_call")
            .count(),
        1
    );
    let V3ResponsesRelayClientBody::Json(body) = output.client_body else {
        panic!("JSON public consumer must return JSON");
    };
    assert_eq!(body["status"], "completed");
    assert_eq!(
        body["output"],
        json!([{"type":"message","id":"r40-message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"r40-http-complete","annotations":[]}]}]),
        "native Responses output must preserve the exact provider message"
    );
}
