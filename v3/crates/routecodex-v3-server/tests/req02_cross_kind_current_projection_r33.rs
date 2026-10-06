//! R33 public consumer coverage for cross-kind Responses tool history.
//!
//! The tests enter through the public SDK capture and normalize entries, apply
//! typed current edits, and then read the registered Direct and standard
//! Responses Relay projections. Final payload items are located by their
//! actual `type` plus `call_id`, so a call item can never satisfy an output
//! assertion merely because it shares the call id.

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
    .expect("registered Direct native inverse projects the cross-kind history")
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
        "r33-attempt",
    )
    .expect("standard Responses Relay projection projects the cross-kind history")
    .payload
}

fn final_input_item<'a>(payload: &'a Value, item_type: &str, call_id: &str) -> &'a Value {
    payload["input"]
        .as_array()
        .expect("projected input is an array")
        .iter()
        .find(|item| {
            item["type"].as_str() == Some(item_type)
                && item["call_id"].as_str() == Some(call_id)
        })
        .unwrap_or_else(|| {
            panic!("missing projected item type={item_type} call_id={call_id}: {payload}")
        })
}

fn current_output_carrier(canonical: &Value, call_id: &str) -> String {
    let index = canonical["messages"]
        .as_array()
        .expect("canonical messages are an array")
        .iter()
        .enumerate()
        .find_map(|(index, message)| {
            (message["role"].as_str() == Some("tool")
                && message["tool_call_id"].as_str() == Some(call_id)
                && message["routecodex_chat_extension"]
                    .get("responses_tool_output_type")
                    .is_some())
            .then_some(index)
        })
        .unwrap_or_else(|| panic!("missing current output carrier for `{call_id}`"));
    format!("chat.messages[{index}].routecodex_chat_extension")
}

fn replace(
    canonical: &Value,
    current: &CurrentFieldAssociations,
    path: String,
    value: Value,
) -> (Value, CurrentFieldAssociations) {
    apply_canonical_field_edit(
        canonical,
        current,
        &CanonicalFieldEdit::Replace { path, value },
    )
    .expect("typed current Replace applies")
}

fn remove(
    canonical: &Value,
    current: &CurrentFieldAssociations,
    path: String,
) -> (Value, CurrentFieldAssociations) {
    apply_canonical_field_edit(canonical, current, &CanonicalFieldEdit::Remove { path })
        .expect("typed current Remove applies")
}

#[test]
fn function_call_with_custom_output_keeps_cross_kind_current_fields() {
    let output = format!("{}\r\nFUNCTION_CALL_CUSTOM_OUTPUT_TAIL", "a".repeat(70_000));
    let raw = json!({
        "model": "client-model",
        "input": [
            {
                "type": "function_call",
                "call_id": "call_cross_function",
                "name": "exec",
                "arguments": "{\"cmd\":\"literal\"}"
            },
            {
                "type": "custom_tool_call_output",
                "id": "ctco_cross",
                "call_id": "call_cross_function",
                "output": output,
                "status": "completed",
                "vendor.key[0]": null,
                "nested[key].tail": {"keep": true},
                "after": [1, null, "x"]
            }
        ]
    });
    let (canonical, pair, current) = sdk_request("req02-r33-function-custom", raw.clone());
    let carrier = current_output_carrier(&canonical, "call_cross_function");

    assert_eq!(
        direct(&canonical, &pair, &current),
        raw,
        "unchanged Direct projection must restore the original cross-kind bytes"
    );
    let relay = relay_responses(&canonical, &pair, &current);
    let relay_output = final_input_item(&relay, "custom_tool_call_output", "call_cross_function");
    assert_eq!(relay_output["id"], "ctco_cross");
    assert_eq!(relay_output["output"], output);
    assert_eq!(relay_output["status"], "completed");
    assert_eq!(relay_output["vendor.key[0]"], Value::Null);
    assert_eq!(relay_output["nested[key].tail"], json!({"keep": true}));
    assert_eq!(relay_output["after"], json!([1, null, "x"]));

    let mut state = (canonical, current);
    state = replace(
        &state.0,
        &state.1,
        format!("{carrier}.responses_item_id"),
        json!("ctco_current"),
    );
    state = replace(
        &state.0,
        &state.1,
        format!("{carrier}.responses_tool_output_status"),
        json!("current-status"),
    );
    state = replace(
        &state.0,
        &state.1,
        format!(r#"{carrier}.responses_tool_output_extra_fields["vendor.key[0]"]"#),
        json!({"edited": true}),
    );
    state = replace(
        &state.0,
        &state.1,
        format!(r#"{carrier}.responses_tool_output_extra_fields["nested[key].tail"]"#),
        json!({"edited": true}),
    );

    let direct_replaced = direct(&state.0, &pair, &state.1);
    let direct_output =
        final_input_item(&direct_replaced, "custom_tool_call_output", "call_cross_function");
    assert_eq!(direct_output["id"], "ctco_current");
    assert_eq!(direct_output["status"], "current-status");
    assert_eq!(direct_output["vendor.key[0]"], json!({"edited": true}));
    assert_eq!(direct_output["nested[key].tail"], json!({"edited": true}));
    assert_eq!(direct_output["output"], output);
    assert!(direct_output.get("vendor").is_none());
    assert!(direct_output.get("nested").is_none());

    let relay_replaced = relay_responses(&state.0, &pair, &state.1);
    let relay_output =
        final_input_item(&relay_replaced, "custom_tool_call_output", "call_cross_function");
    assert_eq!(relay_output["id"], "ctco_current");
    assert_eq!(relay_output["status"], "current-status");
    assert_eq!(relay_output["vendor.key[0]"], json!({"edited": true}));
    assert_eq!(relay_output["nested[key].tail"], json!({"edited": true}));
    assert_eq!(relay_output["output"], output);
    assert!(relay_output.get("vendor").is_none());
    assert!(relay_output.get("nested").is_none());

    state = remove(
        &state.0,
        &state.1,
        format!("{carrier}.responses_item_id"),
    );
    state = remove(
        &state.0,
        &state.1,
        format!("{carrier}.responses_tool_output_status"),
    );
    state = remove(
        &state.0,
        &state.1,
        format!(r#"{carrier}.responses_tool_output_extra_fields["nested[key].tail"]"#),
    );

    let direct_removed = direct(&state.0, &pair, &state.1);
    let direct_output =
        final_input_item(&direct_removed, "custom_tool_call_output", "call_cross_function");
    assert!(direct_output.get("id").is_none());
    assert!(direct_output.get("status").is_none());
    assert_eq!(
        direct_output["vendor.key[0]"],
        json!({"edited": true}),
        "removing a later bracketed sibling must not shift the earlier dotted key"
    );
    assert!(direct_output.get("nested[key].tail").is_none());
    assert_eq!(direct_output["output"], output);

    let relay_removed = relay_responses(&state.0, &pair, &state.1);
    let relay_output =
        final_input_item(&relay_removed, "custom_tool_call_output", "call_cross_function");
    assert_ne!(relay_output["id"], "ctco_cross");
    assert_ne!(relay_output["id"], "ctco_current");
    assert!(relay_output.get("status").is_none());
    assert_eq!(relay_output["vendor.key[0]"], json!({"edited": true}));
    assert!(relay_output.get("nested[key].tail").is_none());
    assert_eq!(relay_output["output"], output);
}

#[test]
fn custom_call_with_function_output_keeps_cross_kind_current_fields() {
    let patch = format!(
        "*** Begin Patch\n*** Update File: cross.rs\n+{}\n*** End Patch\n",
        "b".repeat(70_000)
    );
    let output = format!("{}\r\nCUSTOM_CALL_FUNCTION_OUTPUT_TAIL", "c".repeat(70_000));
    let raw = json!({
        "model": "client-model",
        "input": [
            {
                "type": "custom_tool_call",
                "call_id": "call_cross_custom",
                "name": "apply_patch",
                "input": patch
            },
            {
                "type": "function_call_output",
                "id": "fco_cross",
                "call_id": "call_cross_custom",
                "output": output,
                "status": "incomplete",
                "vendor.key[0]": {"keep": true},
                "nested[key].tail": null,
                "after": {"keep": "all"}
            }
        ]
    });
    let (canonical, pair, current) = sdk_request("req02-r33-custom-function", raw.clone());
    let carrier = current_output_carrier(&canonical, "call_cross_custom");

    assert_eq!(
        direct(&canonical, &pair, &current),
        raw,
        "unchanged Direct projection must restore the original cross-kind bytes"
    );
    let relay = relay_responses(&canonical, &pair, &current);
    let relay_output = final_input_item(&relay, "function_call_output", "call_cross_custom");
    assert_eq!(relay_output["id"], "fc_fco_cross");
    assert_eq!(relay_output["output"], output);
    assert_eq!(relay_output["status"], "incomplete");
    assert_eq!(relay_output["vendor.key[0]"], json!({"keep": true}));
    assert_eq!(relay_output["nested[key].tail"], Value::Null);
    assert_eq!(relay_output["after"], json!({"keep": "all"}));

    let mut state = (canonical, current);
    state = replace(
        &state.0,
        &state.1,
        format!("{carrier}.responses_item_id"),
        json!("fco_current"),
    );
    state = replace(
        &state.0,
        &state.1,
        format!("{carrier}.responses_tool_output_status"),
        json!("current-status"),
    );
    state = replace(
        &state.0,
        &state.1,
        format!(r#"{carrier}.responses_tool_output_extra_fields["vendor.key[0]"]"#),
        json!("current-vendor"),
    );
    state = replace(
        &state.0,
        &state.1,
        format!(r#"{carrier}.responses_tool_output_extra_fields["nested[key].tail"]"#),
        json!({"current": true}),
    );

    let direct_replaced = direct(&state.0, &pair, &state.1);
    let direct_output =
        final_input_item(&direct_replaced, "function_call_output", "call_cross_custom");
    assert_eq!(direct_output["id"], "fco_current");
    assert_eq!(direct_output["status"], "current-status");
    assert_eq!(direct_output["vendor.key[0]"], "current-vendor");
    assert_eq!(direct_output["nested[key].tail"], json!({"current": true}));
    assert_eq!(direct_output["output"], output);
    assert!(direct_output.get("vendor").is_none());
    assert!(direct_output.get("nested").is_none());

    let relay_replaced = relay_responses(&state.0, &pair, &state.1);
    let relay_output =
        final_input_item(&relay_replaced, "function_call_output", "call_cross_custom");
    assert_eq!(relay_output["id"], "fc_fco_current");
    assert_eq!(relay_output["status"], "current-status");
    assert_eq!(relay_output["vendor.key[0]"], "current-vendor");
    assert_eq!(relay_output["nested[key].tail"], json!({"current": true}));
    assert_eq!(relay_output["output"], output);
    assert!(relay_output.get("vendor").is_none());
    assert!(relay_output.get("nested").is_none());

    state = remove(
        &state.0,
        &state.1,
        format!("{carrier}.responses_item_id"),
    );
    state = remove(
        &state.0,
        &state.1,
        format!("{carrier}.responses_tool_output_status"),
    );
    state = remove(
        &state.0,
        &state.1,
        format!(r#"{carrier}.responses_tool_output_extra_fields["vendor.key[0]"]"#),
    );

    let direct_removed = direct(&state.0, &pair, &state.1);
    let direct_output =
        final_input_item(&direct_removed, "function_call_output", "call_cross_custom");
    assert!(direct_output.get("id").is_none());
    assert!(direct_output.get("status").is_none());
    assert!(direct_output.get("vendor.key[0]").is_none());
    assert_eq!(
        direct_output["nested[key].tail"],
        json!({"current": true}),
        "removing a preceding dotted key must not shift the bracketed sibling"
    );
    assert_eq!(direct_output["output"], output);

    let relay_removed = relay_responses(&state.0, &pair, &state.1);
    let relay_output =
        final_input_item(&relay_removed, "function_call_output", "call_cross_custom");
    assert_ne!(relay_output["id"], "fc_fco_cross");
    assert_ne!(relay_output["id"], "fc_fco_current");
    assert!(relay_output.get("status").is_none());
    assert!(relay_output.get("vendor.key[0]").is_none());
    assert_eq!(relay_output["nested[key].tail"], json!({"current": true}));
    assert_eq!(relay_output["output"], output);
}
