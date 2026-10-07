//! Parent-owned author regressions; the response worker owns its other test file.
use routecodex_v3_runtime::operation_runner::{
    AttemptContext, AttemptDeclarationMap, AttemptProjectionContext, RequestScopedContextPair,
    ResponseProjectionView, ToolMappingReference, V3RequestContextHandle,
};
use routecodex_v3_runtime::{
    project_v3_anthropic_message_as_responses_response_with_context,
    V3AnthropicResponsesProjectionContext,
};
use serde_json::{json, Value};

fn project_original(kind: &str, namespace: Option<Value>, input: Value) -> Value {
    let handle = V3RequestContextHandle::new("cross-kind-request".into(), "responses".into());
    let mut declaration = json!({
        "record_id": "original-tool",
        "source_path": "$.tools[0]",
        "kind": kind,
        "name": "original_tool",
        "encoding": "json-object",
    });
    if let Some(namespace) = namespace {
        declaration["namespace"] = namespace;
    }
    let pair = RequestScopedContextPair::from_field_json(
        json!({
            "entry_protocol": "responses",
            "normalized_protocol": "chat",
            "field_mappings": [],
            "opaque_record_references": [],
            "tool_declarations": [declaration],
        }),
        json!({"entry_protocol": "responses", "messages": []}),
    )
    .expect("original request declaration");
    handle.publish_original_pair(pair).expect("original pair");
    let attempt = AttemptContext {
        attempt_id: "successful-wire-attempt".into(),
        projection: AttemptProjectionContext {
            attempt_id: "successful-wire-attempt".into(),
            provider_protocol: "anthropic".into(),
            provider_model: "provider-model".into(),
            paths: vec![],
        },
        declarations: AttemptDeclarationMap {
            attempt_id: "successful-wire-attempt".into(),
            provider_protocol: "anthropic".into(),
            provider_model: "provider-model".into(),
            tool_mappings: vec![ToolMappingReference {
                declaration_record_id: "original-tool".into(),
                source_path: "$.tools[0]".into(),
                destination_path: "$.tools[0]".into(),
                emitted_kind: "function".into(),
                emitted_name: Some("wire_alias".into()),
                emitted_namespace: None,
                encoding: "json-object".into(),
            }],
        },
    };
    handle
        .publish_successful_attempt(attempt.clone())
        .expect("successful attempt");
    let view = ResponseProjectionView::from_successful_attempt(&handle, &attempt)
        .expect("successful attempt view");
    let context = V3AnthropicResponsesProjectionContext::from_successful_attempt(&view)
        .expect("projection may change kind and flatten namespace");
    project_v3_anthropic_message_as_responses_response_with_context(
        &json!({
            "id": "provider-message", "type": "message", "role": "assistant",
            "model": "provider-model", "stop_reason": "tool_use",
            "content": [{"type": "tool_use", "id": "original-call-id", "name": "wire_alias", "input": input}],
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }),
        &context,
    ).expect("public response projector")
}

#[test]
fn namespaced_custom_projected_as_flat_function_restores_original_identity() {
    let text =
        "*** Begin Patch\n*** Add File: /tmp/exact-path\n+literal $() and `bytes`\n*** End Patch\n";
    let response = project_original("custom", Some(json!("functions")), json!({"input": text}));
    let call = &response["output"][0];
    assert_eq!(call["type"], "custom_tool_call");
    assert_eq!(call["namespace"], "functions");
    assert_eq!(call["name"], "original_tool");
    assert_eq!(call["call_id"], "original-call-id");
    assert_eq!(call["input"], text);
}

#[test]
fn renamed_function_without_namespace_restores_original_name() {
    let parameters =
        json!({"cmd": "printf '%s\\n' 'complete command'\nprintf '%s' 'tail'", "cwd": "/tmp"});
    let response = project_original("function", None, parameters.clone());
    let call = &response["output"][0];
    assert_eq!(call["type"], "function_call");
    assert_eq!(call["name"], "original_tool");
    assert!(call.get("namespace").is_none());
    assert_eq!(call["call_id"], "original-call-id");
    assert_eq!(
        serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
        parameters
    );
}
