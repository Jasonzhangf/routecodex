use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn normalize(protocol: &str, raw: Value) -> (Value, RequestScopedContextPair) {
    let handle = V3RequestContextHandle::new("field-sources".into(), protocol.into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "field-invocation".into(),
        "field-attempt".into(),
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

fn mapping(pair: &RequestScopedContextPair, source: &str, destination: &str) {
    assert!(
        pair.inverse_context
            .field_mappings
            .iter()
            .any(|mapping| { mapping.source_path == source && mapping.destination == destination }),
        "missing source association {source} -> {destination}"
    );
}

#[test]
fn anthropic_inverse_boolean_records_the_actual_canonical_field() {
    let (canonical, pair) = normalize(
        "anthropic",
        json!({
            "messages":[], "tool_choice":{"type":"auto","disable_parallel_tool_use":true,"vendor":null}
        }),
    );
    assert_eq!(canonical["tool_choice"], "auto");
    assert_eq!(canonical["parallel_tool_calls"], false);
    mapping(
        &pair,
        "request.tool_choice.disable_parallel_tool_use",
        "chat.parallel_tool_calls",
    );
}

#[test]
fn gemini_safety_container_association_resolves_its_extension_value() {
    let safety =
        json!([{"category":"category","threshold":"BLOCK_NONE","vendor":{"keep":[null,1]}}]);
    let (canonical, pair) = normalize("gemini", json!({"contents":[],"safetySettings":safety}));
    assert_eq!(
        canonical["routecodex_chat_extension"]["gemini_request"]["safetySettings"],
        safety
    );
    mapping(
        &pair,
        "request.safetySettings",
        "chat.routecodex_chat_extension.gemini_request.safetySettings",
    );
}

#[test]
fn gemini_unknown_generation_field_records_literal_extension_key() {
    let opaque = json!({"nested":[null,{"complete":"line1\nline2"}]});
    let (canonical, pair) = normalize(
        "gemini",
        json!({"contents":[],"generationConfig":{"vendor":opaque}}),
    );
    assert_eq!(
        canonical["routecodex_chat_extension"]["gemini_request"]["generationConfig.vendor"],
        opaque
    );
    mapping(
        &pair,
        "request.generationConfig.vendor",
        r#"chat.routecodex_chat_extension.gemini_request["generationConfig.vendor"]"#,
    );
}

#[test]
fn unknown_literal_top_key_preserves_identity_and_full_value() {
    let value = format!(
        "{}\n*** Begin Patch\n+literal\n*** End Patch\nTAIL",
        "x".repeat(70_000)
    );
    let (canonical, pair) = normalize("responses", json!({"input":[],"vendor.name[0]":value}));
    assert_eq!(canonical["vendor.name[0]"], value);
    mapping(
        &pair,
        r#"request["vendor.name[0]"]"#,
        r#"chat["vendor.name[0]"]"#,
    );
}
