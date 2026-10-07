use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_direct_request,
    CurrentFieldAssociations, RequestInvocationContext, RequestNormalizationEntry,
    RequestOriginKind, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn direct_roundtrip(raw: Value) -> Value {
    let handle = V3RequestContextHandle::new("discovery-direct".into(), "responses".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "direct-invocation".into(),
        "direct-attempt".into(),
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
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    project_canonical_direct_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
    )
    .unwrap()
    .payload
}

#[test]
fn discovered_tools_keep_their_original_declaration_domain_on_direct() {
    let raw = json!({
        "tools": [{"type": "tool_search"}],
        "input": [
            {"type": "tool_search_call", "call_id": "search", "execution": "client", "arguments": {"query": "echo"}},
            {"type": "tool_search_output", "call_id": "search", "execution": "client", "tools": [
                {"type": "namespace", "name": "mcp__probe", "tools": [
                    {"type": "function", "name": "echo", "parameters": {"type": "object"}}
                ]}
            ]}
        ]
    });
    assert_eq!(direct_roundtrip(raw.clone()), raw);
}

#[test]
fn additional_tools_refresh_preserves_the_original_request_on_direct() {
    let raw = json!({
        "tools": [{"type": "function", "name": "exec", "parameters": {"type": "object"}}],
        "input": [{"type": "additional_tools", "tools": [
            {"type": "function", "name": "exec", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}}
        ]}]
    });
    assert_eq!(direct_roundtrip(raw.clone()), raw);
}

#[test]
fn standalone_responses_media_preserves_its_original_item_representation() {
    let raw = json!({
        "input": [{
            "type": "input_image", "image_url": "data:image/png;base64,UklGRg==",
            "detail": "high", "vendor": {"bytes": "opaque"}
        }]
    });
    assert_eq!(direct_roundtrip(raw.clone()), raw);
}
