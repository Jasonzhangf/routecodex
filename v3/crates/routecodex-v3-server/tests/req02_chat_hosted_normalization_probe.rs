use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, V3RequestContextHandle,
};
use serde_json::json;

#[test]
fn differing_opaque_arguments_and_repeated_single_source_history_remain_distinct() {
    let arguments = format!("{}\r\nEXACT_ARGUMENT_TAIL", "x".repeat(70_000));
    let handle = V3RequestContextHandle::new("distinct-fold-probe".into(), "responses".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "distinct-invocation".into(),
        "distinct-attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let call = json!({"role":"assistant","tool_calls":[{
        "id":"same-call","type":"function","function":{"name":"exec", "arguments": arguments}
    }]});
    let raw = json!({
        "messages": [call.clone(), call],
        "input": [{"type":"function_call","call_id":"same-call","name":"exec", "arguments": format!("{arguments}!")}]
    });
    let captured = execute_v3_operation_runner_request_capture_client_json(raw).unwrap();
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .unwrap();
    assert_eq!(canonical["messages"].as_array().unwrap().len(), 3);
    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["function"]["arguments"],
        arguments
    );
    assert_eq!(
        canonical["messages"][1]["tool_calls"][0]["function"]["arguments"],
        arguments
    );
    assert_eq!(
        canonical["messages"][2]["tool_calls"][0]["function"]["arguments"],
        format!("{arguments}!")
    );
}

#[test]
fn equivalent_tool_histories_alias_with_original_item_annotations_preserved() {
    let handle = V3RequestContextHandle::new("dual-tool-fold-probe".into(), "responses".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "dual-tool-invocation".into(),
        "dual-tool-attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let raw = json!({
        "messages": [
            {"role":"assistant","tool_calls":[{"id":"call_full","type":"function","function":{"name":"lookup","arguments":"{}"}}]},
            {"role":"tool","tool_call_id":"call_full","content":"done"}
        ],
        "input": [
            {"type":"function_call","id":"fc_source","call_id":"call_full","name":"lookup","arguments":"{}"},
            {"type":"function_call_output","id":"fco_source","call_id":"call_full","output":"done"}
        ]
    });
    let captured = execute_v3_operation_runner_request_capture_client_json(raw).unwrap();
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .unwrap();
    assert_eq!(
        canonical["messages"].as_array().unwrap().len(),
        2,
        "canonical={canonical}"
    );
    let pair = handle.original_pair().unwrap();
    for source in ["request.messages[0]", "request.input[0]"] {
        assert!(pair
            .inverse_context
            .field_mappings
            .iter()
            .any(|m| m.source_path == source && m.destination == "chat.messages[0]"));
    }
    for source in ["request.input[0].id", "request.input[1].id"] {
        assert!(pair
            .inverse_context
            .opaque_record_references
            .iter()
            .any(|r| r.path == source));
    }
}

#[test]
fn equivalent_dual_text_uses_one_canonical_history_item_and_keeps_source_aliases() {
    let handle = V3RequestContextHandle::new("dual-text-fold-probe".into(), "responses".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "dual-invocation".into(),
        "dual-attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let raw = json!({"input": "hi", "messages": [{"role": "user", "content": "hi"}]});
    let captured = execute_v3_operation_runner_request_capture_client_json(raw).unwrap();
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .unwrap();
    assert_eq!(
        canonical["messages"].as_array().unwrap().len(),
        1,
        "canonical={canonical}"
    );
    assert!(
        canonical.get("input").is_none(),
        "consumed history must not remain active: {canonical}"
    );
    let pair = handle.original_pair().unwrap();
    assert!(pair
        .inverse_context
        .field_mappings
        .iter()
        .any(|m| m.source_path == "request.input"));
    assert!(pair
        .inverse_context
        .field_mappings
        .iter()
        .any(|m| m.source_path == "request.messages[0]"));
}

#[test]
fn null_optional_message_container_does_not_invent_a_user_turn() {
    let handle = V3RequestContextHandle::new("null-history-probe".into(), "responses".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "null-invocation".into(),
        "null-attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let raw = json!({"input": "hi", "messages": null});
    let captured = execute_v3_operation_runner_request_capture_client_json(raw).unwrap();
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .unwrap();
    assert_eq!(
        canonical["messages"],
        json!([{"role":"user", "content":"hi"}]),
        "canonical={canonical}"
    );
    let pair = handle.original_pair().unwrap();
    assert!(pair
        .inverse_context
        .opaque_record_references
        .iter()
        .any(|r| r.path == "request.messages"));
}

#[test]
fn chat_hosted_and_function_declarations_pass_public_normalization() {
    let mut raw = json!({
        "model": "gateway.glm-5.3",
        "stream": false,
        "tools": [
            {"type": "web_search"},
            {"type": "function", "function": {
                "name": "exec_command", "parameters": {"type": "object"}
            }}
        ],
        "messages": [
            {"role": "user", "content": "continue the calculation"},
            {"role": "assistant", "content": null, "tool_calls": [{
                "id": "call_old", "type": "function", "function": {
                    "name": "exec_command", "arguments": "{\"value\":1}"
                }
            }]},
            {"role": "tool", "tool_call_id": "call_old", "content": "EXECUTED:2"},
            {"role": "assistant", "content": null, "tool_calls": [{
                "id": "call_retired", "type": "function", "function": {
                    "name": "update_plan", "arguments": "{\"plan\":[]}"
                }
            }]},
            {"role": "tool", "tool_call_id": "call_retired", "content": "PLAN_SAVED"}
        ]
    });
    for index in 0..377 {
        raw["tools"].as_array_mut().unwrap().push(json!({
            "type": "function", "function": {
                "name": format!("mcp__codex_apps__codex_security_cloud___defense_factory_workflow_repositories_{index}"),
                "parameters": {"type": "object"}
            }
        }));
    }
    let handle = V3RequestContextHandle::new("chat-hosted-probe".into(), "openai_chat".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "chat-hosted-invocation".into(),
        "chat-hosted-attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw).unwrap();
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("hosted Chat declaration must not block lossless request normalization");
    assert_eq!(canonical["messages"].as_array().unwrap().len(), 5);
    assert_eq!(canonical["tools"].as_array().unwrap().len(), 379);
    assert_eq!(
        handle
            .original_pair()
            .unwrap()
            .inverse_context
            .tool_declarations
            .len(),
        379
    );
}
