use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn normalize(id: &str, raw: Value, expected_pairs: usize) -> (Value, RequestScopedContextPair) {
    let handle = V3RequestContextHandle::new(id.to_owned(), "responses".to_owned());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{id}-entry"),
        format!("{id}-attempt"),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw).unwrap();
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .unwrap();
    let pair = handle.original_pair().unwrap();
    assert_eq!(pair.explicit_history_pairing.messages.len(), expected_pairs);
    (canonical, pair)
}

#[test]
fn equivalent_cross_source_result_has_one_canonical_item_and_two_associations() {
    let (canonical, _) = normalize(
        "req02-cross-source-result",
        json!({
            "model": "test",
            "messages": [{"role":"tool", "tool_call_id":"call-one", "content":"one\r\n"}],
            "input": [{"type":"function_call_output", "call_id":"call-one", "output":"one\r\n"}]
        }),
        2,
    );
    assert_eq!(
        canonical["messages"].as_array().unwrap().len(),
        1,
        "{}",
        canonical["messages"]
    );
    assert_eq!(canonical["messages"][0]["content"], "one\r\n");
}

#[test]
fn repeated_results_inside_secondary_source_are_preserved_when_primary_is_absent() {
    let output = json!({"type":"function_call_output", "call_id":"call-one", "output":"one\r\n"});
    let (canonical, _) = normalize(
        "req02-repeated-secondary-result",
        json!({
            "model":"test", "input":[output.clone(), output]
        }),
        2,
    );
    assert_eq!(
        canonical["messages"].as_array().unwrap().len(),
        2,
        "{}",
        canonical["messages"]
    );
    assert_eq!(canonical["messages"][0], canonical["messages"][1]);
}

#[test]
fn custom_call_result_alias_does_not_acquire_a_function_identity() {
    let patch = "*** Begin Patch\n*** Add File: marker.txt\n+exact patch\n*** End Patch\n";
    let (canonical, pair) = normalize(
        "req02-custom-result-alias",
        json!({
            "model":"test",
            "messages":[
                {"role":"assistant","content":"", "tool_calls":[{
                    "id":"call-patch", "type":"custom", "namespace":"functions", "custom":{"name":"apply_patch","input":patch}
                }]},
                {"role":"tool", "tool_call_id":"call-patch", "content":"patched"}
            ],
            "input":[{"type":"custom_tool_call_output", "call_id":"call-patch", "output":"patched"}]
        }),
        3,
    );
    assert_eq!(canonical["messages"].as_array().unwrap().len(), 2);
    let call = pair
        .explicit_history_pairing
        .messages
        .iter()
        .find(|history| history.source_path == "request.messages[0].tool_calls[0]")
        .unwrap();
    assert_eq!(call.namespace, Some(json!("functions")));
    assert_eq!(canonical["messages"][0]["tool_calls"][0]["type"], "custom");
    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["custom"]["input"],
        patch
    );
}

#[test]
fn instruction_mapping_does_not_point_at_an_unrelated_history_message() {
    let handle =
        V3RequestContextHandle::new("req02-instruction-mapping".into(), "responses".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "entry".into(),
        "attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(json!({
        "model":"test", "instructions":"system-policy", "input":"secondary-user",
        "messages":[{"role":"user","content":"primary-user"}]
    }))
    .unwrap();
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .unwrap();
    assert_eq!(canonical["messages"][0]["content"], "system-policy");
    let pair = handle.original_pair().unwrap();
    let mapping = pair
        .inverse_context
        .field_mappings
        .iter()
        .find(|mapping| mapping.source_path == "request.instructions")
        .unwrap();
    assert_eq!(mapping.destination, "chat.messages[0].content");
    assert_eq!(canonical["messages"][0]["role"], "system");
    for (source, destination) in [
        ("request.messages[0]", "chat.messages[1]"),
        ("request.input", "chat.messages[2]"),
    ] {
        assert!(
            pair.inverse_context.field_mappings.iter().any(|mapping| {
                mapping.source_path == source && mapping.destination == destination
            }),
            "missing folded history association {source} -> {destination}"
        );
    }
}
