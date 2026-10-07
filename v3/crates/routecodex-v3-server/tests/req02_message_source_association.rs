use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn normalize(raw: Value) -> (Value, RequestScopedContextPair) {
    let handle =
        V3RequestContextHandle::new("message-associations".to_string(), "responses".to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "invocation".to_string(),
        "attempt".to_string(),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw).unwrap();
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .unwrap();
    (canonical, handle.original_pair().unwrap())
}

fn assert_destination(pair: &RequestScopedContextPair, source: &str, destination: &str) {
    assert!(
        pair.inverse_context.field_mappings.iter().any(|mapping| {
            mapping.source_path == source
                && mapping.destination == destination
                && mapping.operator == "routecodex.v3.field.array_container_shape@1"
        }),
        "missing actual source association {source} -> {destination}"
    );
}

#[test]
fn inserted_system_message_shifts_the_actual_source_destination() {
    let (canonical, pair) = normalize(json!({
        "instructions":"system prefix", "input":[{"role":"user","content":"user text"}]
    }));
    assert_eq!(canonical["messages"][0]["role"], "system");
    assert_eq!(canonical["messages"][1]["content"], "user text");
    assert_destination(&pair, "request.input[0]", "chat.messages[1]");
}

#[test]
fn mixed_histories_record_aliases_and_distinct_items_after_the_actual_fold() {
    let (canonical, pair) = normalize(json!({
        "input":[{"role":"user","content":"same"}],
        "messages":[{"role":"user","content":"same"}]
    }));
    assert_eq!(canonical["messages"].as_array().unwrap().len(), 1);
    assert_destination(&pair, "request.input[0]", "chat.messages[0]");
    assert_destination(&pair, "request.messages[0]", "chat.messages[0]");

    let (distinct, distinct_pair) = normalize(json!({
        "input":[{"role":"user","content":"first"}],
        "messages":[{"role":"user","content":"second"}]
    }));
    assert_eq!(distinct["messages"].as_array().unwrap().len(), 2);
    assert_eq!(distinct["messages"][0]["content"], "second");
    assert_eq!(distinct["messages"][1]["content"], "first");
    assert_destination(&distinct_pair, "request.input[0]", "chat.messages[1]");
    assert_destination(&distinct_pair, "request.messages[0]", "chat.messages[0]");
}

#[test]
fn string_input_association_retains_the_complete_multiline_value() {
    let input = format!(
        "{}\n*** Begin Patch\n+literal\n*** End Patch\nTAIL",
        "x".repeat(70_000)
    );
    let (canonical, pair) = normalize(json!({"input":input}));
    assert_eq!(canonical["messages"][0]["content"], input);
    assert_destination(&pair, "request.input", "chat.messages[0]");
}
