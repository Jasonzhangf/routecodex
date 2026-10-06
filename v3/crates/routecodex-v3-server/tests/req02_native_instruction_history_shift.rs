//! Public producer dependency regression, not the full tool execution E2E gate.
use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn assert_emitted_call_leaf(protocol: &str, raw: Value, source: &str) {
    let handle = V3RequestContextHandle::new(format!("native-prefix-{protocol}"), protocol.into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "client-entry".into(),
        "attempt-one".into(),
        RequestOriginKind::ClientEntry,
    );
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(raw),
    )
    .unwrap();
    let pair = handle.original_pair().unwrap();
    let mapping = pair
        .inverse_context
        .field_mappings
        .iter()
        .find(|mapping| mapping.source_path == source)
        .unwrap();
    assert_eq!(mapping.destination, "chat.messages[1].tool_calls[0].id");
    assert_eq!(
        canonical["messages"][1]["tool_calls"][0]["id"],
        "native-call"
    );
}

#[test]
fn anthropic_system_prefix_moves_call_leaf_with_its_message() {
    assert_emitted_call_leaf(
        "anthropic",
        json!({
            "system":"prefix", "messages":[{"role":"assistant","content":[
                {"type":"tool_use","id":"native-call","name":"exec","input":{"cmd":"line1\nline2"}}
            ]}]
        }),
        "request.messages[0].content[0].id",
    );
}

#[test]
fn gemini_system_prefix_moves_call_leaf_with_its_message() {
    assert_emitted_call_leaf(
        "gemini",
        json!({
            "systemInstruction":{"parts":[{"text":"prefix"}]},
            "contents":[{"role":"model","parts":[
                {"functionCall":{"id":"native-call","name":"exec","args":{"cmd":"line1\nline2"}}}
            ]}]
        }),
        "request.contents[0].parts[0].functionCall.id",
    );
}
