//! R28 public consumer coverage: real SDK capture -> normalize -> typed current
//! edit -> registered Direct native inverse, plus the standard Responses Relay
//! projection. Output identity/status/unknown siblings keep their real source
//! mappings and read the current association (Replace/Remove), never the
//! original opaque source.

use routecodex_v3_config::{
    V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
};
use routecodex_v3_runtime::hub_v1::{V3HubExecutionMode, V3HubProviderWireProtocol};
use routecodex_v3_runtime::operation_runner::{
    apply_canonical_field_edit, execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_direct_request,
    project_canonical_request, CanonicalFieldEdit, CurrentFieldAssociations,
    RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind,
    RequestScopedContextPair, V3RequestContextHandle, V3TargetCandidate,
};
use serde_json::{json, Value};

fn responses_target() -> V3TargetCandidate {
    V3TargetCandidate {
        provider_id: "provider".to_string(),
        provider_type: "responses".to_string(),
        auth_alias: "primary".to_string(),
        model_id: "provider-model".to_string(),
        wire_model: "provider-wire-model".to_string(),
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
        env_name: Some("TEST_KEY".to_string()),
        token_file: None,
        secret_file: None,
        secret_key: None,
        api_key: None,
        required_capabilities: Vec::new(),
        priority: 0,
        weight: 1,
        pool_ids: vec!["default".to_string()],
        default_pool_member: true,
        path: vec!["provider".to_string()],
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
    let captured = execute_v3_operation_runner_request_capture_client_json(raw)
        .expect("public SDK capture accepts the real client JSON");
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public SDK normalize runs the real REQ02 slice");
    let pair = handle
        .original_pair()
        .expect("the raw client entry publishes the original inverse/history pair");
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    (canonical, pair, current)
}

fn direct(
    canonical: &Value,
    pair: &RequestScopedContextPair,
    current: &CurrentFieldAssociations,
) -> Value {
    project_canonical_direct_request(
        canonical,
        &pair.inverse_context,
        current,
        &pair.explicit_history_pairing,
    )
    .expect("registered Direct native inverse projects the output item")
    .payload
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
        "r28-attempt",
    )
    .expect("standard Responses Relay projection projects the output item")
    .payload
}

fn relay_item<'a>(payload: &'a Value, id: &str) -> &'a Value {
    payload["input"]
        .as_array()
        .expect("relay input array")
        .iter()
        .find(|item| item["id"] == id)
        .unwrap_or_else(|| panic!("missing relay item `{id}`: {payload}"))
}

#[test]
fn paired_and_named_outputs_preserve_identity_status_siblings_and_long_bytes() {
    let command = format!("{}\r\nCOMMAND_TAIL", "cmd;$()`bytes`".repeat(6_000));
    let arguments = json!({"cmd": command}).to_string();
    let patch =
        "*** Begin Patch\n*** Update File: a.rs\n+literal bytes\n*** End Patch\n".repeat(1_500);
    let mcp = json!({
        "content":[{"type":"text","text":"ok\r\nMCP_TAIL"}],
        "isError":false,
        "vendor":{"nested":[null,1]}
    });
    let raw = json!({
        "model":"client-model",
        "tools":[
            {"type":"function","name":"exec","parameters":{"type":"object"}},
            {"type":"custom","name":"apply_patch","format":{"type":"text"}}
        ],
        "input":[
            {"type":"function_call","call_id":"call_exec","name":"exec","arguments":arguments},
            {
                "type":"function_call_output",
                "id":"fco_function",
                "call_id":"call_exec",
                "output":"done\r\nRESULT_TAIL",
                "status":"completed",
                "name":"exec",
                "namespace":"functions",
                "before":{"keep":1},
                "vendor.key[0]":null,
                "after":[1,null,"x"]
            },
            {"type":"custom_tool_call","call_id":"call_patch","name":"apply_patch","input":patch},
            {
                "type":"custom_tool_call_output",
                "id":"ctco_custom",
                "call_id":"call_patch",
                "output":mcp,
                "status":"incomplete",
                "vendor":{"keep":true}
            },
            {
                "type":"function_call_output",
                "id":"item_named",
                "name":"exec",
                "namespace":"functions",
                "output":"named\r\nTAIL",
                "status":"completed",
                "vendor":{"named":true}
            }
        ]
    });
    let (canonical, pair, current) = sdk_request("req02-r28-output-shapes", raw.clone());

    // Unchanged Direct inverse is the exact raw source shape, including the
    // complete command/patch bytes and every paired/named sibling.
    assert_eq!(direct(&canonical, &pair, &current), raw);

    let relay = relay_responses(&canonical, &pair, &current);
    // Paired function output: id keeps the established fc_ encoding; the whole
    // result string and every unknown sibling are present.
    let function_output = relay_item(&relay, "fc_fco_function");
    assert_eq!(function_output["type"], "function_call_output");
    assert_eq!(function_output["call_id"], "call_exec");
    assert_eq!(function_output["output"], "done\r\nRESULT_TAIL");
    assert_eq!(function_output["status"], "completed");
    assert_eq!(function_output["before"], json!({"keep":1}));
    assert_eq!(function_output["vendor.key[0]"], Value::Null);
    assert_eq!(function_output["after"], json!([1, null, "x"]));

    // Paired custom output: custom ids are not re-prefixed; the MCP object
    // result keeps the established wire serialization exactly.
    let custom_output = relay_item(&relay, "ctco_custom");
    assert_eq!(custom_output["type"], "custom_tool_call_output");
    assert_eq!(custom_output["call_id"], "call_patch");
    assert_eq!(custom_output["output"], mcp.to_string());
    assert_eq!(custom_output["status"], "incomplete");
    assert_eq!(custom_output["vendor"], json!({"keep":true}));

    // Named (no call id) output keeps its declared id, name, namespace and
    // unknown sibling in the standard representation.
    let named_output = relay_item(&relay, "item_named");
    assert_eq!(named_output["type"], "function_call_output");
    assert_eq!(named_output["name"], "exec");
    assert_eq!(named_output["namespace"], "functions");
    assert_eq!(named_output["output"], "named\r\nTAIL");
    assert_eq!(named_output["status"], "completed");
    assert_eq!(named_output["vendor"], json!({"named":true}));
    assert!(named_output.get("call_id").is_none());
}

#[test]
fn typed_current_replace_and_remove_reflect_in_direct_and_relay() {
    let raw = json!({
        "model":"client-model",
        "input":[{
            "type":"function_call_output",
            "call_id":"call_1",
            "output":"done",
            "id":"fco_1",
            "status":"completed",
            "vendor":{"keep":true}
        }]
    });
    let (canonical, pair, current) = sdk_request("req02-r28-current-edits", raw);
    let mut state = (canonical, current);

    for (path, value) in [
        (
            "chat.messages[0].routecodex_chat_extension.responses_item_id",
            json!("fco_edited"),
        ),
        (
            "chat.messages[0].routecodex_chat_extension.responses_tool_output_status",
            json!("edited-status"),
        ),
        (
            "chat.messages[0].routecodex_chat_extension.responses_tool_output_extra_fields.vendor",
            json!({"edited":true}),
        ),
    ] {
        state = apply_canonical_field_edit(
            &state.0,
            &state.1,
            &CanonicalFieldEdit::Replace {
                path: path.to_string(),
                value,
            },
        )
        .expect("typed current Replace applies");
    }

    let direct_payload = direct(&state.0, &pair, &state.1);
    assert_eq!(direct_payload["input"][0]["id"], "fco_edited");
    assert_eq!(direct_payload["input"][0]["status"], "edited-status");
    assert_eq!(direct_payload["input"][0]["vendor"], json!({"edited":true}));

    let relay = relay_responses(&state.0, &pair, &state.1);
    let replaced = relay_item(&relay, "fc_fco_edited");
    assert_eq!(replaced["status"], "edited-status");
    assert_eq!(replaced["vendor"], json!({"edited":true}));

    for path in [
        "chat.messages[0].routecodex_chat_extension.responses_item_id",
        "chat.messages[0].routecodex_chat_extension.responses_tool_output_status",
        "chat.messages[0].routecodex_chat_extension.responses_tool_output_extra_fields.vendor",
    ] {
        state = apply_canonical_field_edit(
            &state.0,
            &state.1,
            &CanonicalFieldEdit::Remove {
                path: path.to_string(),
            },
        )
        .expect("typed current Remove applies");
    }

    let direct_payload = direct(&state.0, &pair, &state.1);
    assert!(direct_payload["input"][0].get("id").is_none());
    assert!(direct_payload["input"][0].get("status").is_none());
    assert!(direct_payload["input"][0].get("vendor").is_none());

    let relay = relay_responses(&state.0, &pair, &state.1);
    let removed = relay["input"]
        .as_array()
        .expect("relay input array")
        .iter()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == "call_1")
        .unwrap_or_else(|| panic!("missing relay output for call_1: {relay}"));
    assert!(removed.get("status").is_none());
    assert!(removed.get("vendor").is_none());
    assert_ne!(
        removed["id"], "fc_fco_edited",
        "a removed current id must not resurrect the original value"
    );
    assert!(
        !relay.to_string().contains("fco_edited"),
        "removed current values must not leak into the projection: {relay}"
    );
    // The immutable original pair is untouched by typed current edits.
    assert!(pair
        .inverse_context
        .field_mappings
        .iter()
        .any(|mapping| mapping.source_path == "request.input[0].id"));
}
