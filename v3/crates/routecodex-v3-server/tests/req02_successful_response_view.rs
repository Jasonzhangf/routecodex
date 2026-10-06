use routecodex_v3_runtime::operation_runner::{
    AttemptContext, AttemptDeclarationMap, AttemptProjectionContext, RequestScopedContextPair,
    ResponseProjectionView, ToolDeclarationReference, ToolMappingReference, V3RequestContextHandle,
};
use routecodex_v3_runtime::{
    materialize_v3_provider_sse_as_canonical_response_with_context,
    project_v3_anthropic_message_as_responses_response_with_context,
    V3AnthropicResponsesProjectionContext, V3HubProviderWireProtocol,
};
use serde_json::{json, Value};

fn request_context(
    request_id: &str,
    tool_declarations: Vec<ToolDeclarationReference>,
) -> V3RequestContextHandle {
    let handle = V3RequestContextHandle::new(request_id.to_string(), "responses".to_string());
    let tool_declaration_values = tool_declarations
        .into_iter()
        .map(|declaration| {
            let mut value = json!({
                "record_id": declaration.record_id,
                "source_path": declaration.source_path,
                "kind": declaration.kind,
                "name": declaration.name,
                "encoding": declaration.encoding,
            });
            if let Some(namespace) = declaration.namespace {
                value["namespace"] = namespace;
            }
            value
        })
        .collect::<Vec<_>>();
    let pair = RequestScopedContextPair::from_field_json(
        json!({
            "entry_protocol": "responses",
            "normalized_protocol": "chat",
            "field_mappings": [],
            "opaque_record_references": [],
            "tool_declarations": tool_declaration_values,
        }),
        json!({
            "entry_protocol": "responses",
            "messages": [],
        }),
    )
    .expect("valid request inverse pair");
    handle
        .publish_original_pair(pair)
        .expect("publish original pair once");
    handle
}

fn attempt_context(attempt_id: &str, tool_mappings: Vec<ToolMappingReference>) -> AttemptContext {
    AttemptContext {
        attempt_id: attempt_id.to_string(),
        projection: AttemptProjectionContext {
            attempt_id: attempt_id.to_string(),
            provider_protocol: "anthropic".to_string(),
            provider_model: "claude-provider".to_string(),
            paths: Vec::new(),
        },
        declarations: AttemptDeclarationMap {
            attempt_id: attempt_id.to_string(),
            provider_protocol: "anthropic".to_string(),
            provider_model: "claude-provider".to_string(),
            tool_mappings,
        },
    }
}

fn declaration(
    record_id: &str,
    kind: &str,
    name: &str,
    namespace: Option<Value>,
) -> ToolDeclarationReference {
    ToolDeclarationReference {
        record_id: record_id.to_string(),
        source_path: format!("request.tools[{record_id}]"),
        kind: kind.to_string(),
        name: Some(name.to_string()),
        namespace,
        encoding: "json-object".to_string(),
    }
}

fn tool_mapping(
    declaration_record_id: &str,
    emitted_name: &str,
    emitted_kind: &str,
    emitted_namespace: Option<Value>,
) -> ToolMappingReference {
    ToolMappingReference {
        declaration_record_id: declaration_record_id.to_string(),
        source_path: format!("request.tools[{declaration_record_id}]"),
        destination_path: format!("provider.tools[{emitted_name}]"),
        emitted_kind: emitted_kind.to_string(),
        emitted_name: Some(emitted_name.to_string()),
        emitted_namespace,
        encoding: "json-object".to_string(),
    }
}

fn provider_tool_use(name: &str, input: Value) -> Value {
    json!({
        "id": "msg-provider",
        "type": "message",
        "role": "assistant",
        "model": "claude-provider",
        "content": [{
            "type": "tool_use",
            "id": "call-shared",
            "name": name,
            "input": input,
        }],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 1, "output_tokens": 1},
    })
}

fn typed_context(
    handle: &V3RequestContextHandle,
    attempt: &AttemptContext,
) -> V3AnthropicResponsesProjectionContext {
    typed_context_with_business_context(handle, attempt, None, None)
}

fn typed_context_with_business_context(
    handle: &V3RequestContextHandle,
    attempt: &AttemptContext,
    metadata: Option<Value>,
    reasoning_summary_policy: Option<&str>,
) -> V3AnthropicResponsesProjectionContext {
    let view = ResponseProjectionView::from_successful_attempt(handle, attempt)
        .expect("successful attempt view");
    V3AnthropicResponsesProjectionContext::from_successful_attempt_with_business_context(
        &view,
        metadata,
        reasoning_summary_policy,
    )
    .expect("typed attempt projection context")
}

#[test]
fn legacy_canonical_request_context_cannot_restore_successful_attempt_identity() {
    let handle = request_context(
        "req-legacy-context",
        vec![declaration(
            "decl-custom",
            "custom",
            "apply_patch",
            Some(json!("server")),
        )],
    );
    let attempt = attempt_context(
        "attempt-success",
        vec![tool_mapping(
            "decl-custom",
            "shared_tool",
            "custom",
            Some(json!("server")),
        )],
    );
    handle
        .publish_successful_attempt(attempt.clone())
        .expect("publish successful attempt");

    let canonical_request = json!({
        "tools": [{"type": "function", "name": "shared_tool"}]
    });
    let context =
        V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&canonical_request)
            .expect("legacy context still compiles");
    let projected = project_v3_anthropic_message_as_responses_response_with_context(
        &provider_tool_use(
            "shared_tool",
            json!({"input": "*** Begin Patch\n*** End Patch"}),
        ),
        &context,
    )
    .expect("legacy response projection");

    assert_eq!(projected["output"][0]["type"], "function_call");

    let legacy_context =
        V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&canonical_request)
            .expect("legacy context");
    let legacy_projected = project_v3_anthropic_message_as_responses_response_with_context(
        &provider_tool_use(
            "shared_tool",
            json!({"input": "*** Begin Patch\n*** End Patch"}),
        ),
        &legacy_context,
    )
    .expect("legacy projection");
    assert_eq!(legacy_projected["output"][0]["type"], "function_call");

    let attempt_context = typed_context(&handle, &attempt);
    let attempt_projected = project_v3_anthropic_message_as_responses_response_with_context(
        &provider_tool_use(
            "shared_tool",
            json!({"input": "*** Begin Patch\n*** End Patch"}),
        ),
        &attempt_context,
    )
    .expect("successful attempt response projection");
    assert_eq!(attempt_projected["output"][0]["type"], "custom_tool_call");
    assert_eq!(attempt_projected["output"][0]["namespace"], "server");
    assert_eq!(attempt_projected["output"][0]["name"], "apply_patch");
    assert_eq!(attempt_projected["output"][0]["call_id"], "call-shared");
    assert_eq!(
        attempt_projected["output"][0]["input"],
        "*** Begin Patch\n*** End Patch"
    );
}

#[test]
fn successful_attempt_view_preserves_explicit_business_context() {
    let handle = request_context(
        "req-business-context",
        vec![declaration(
            "decl-business",
            "custom",
            "apply_patch",
            Some(json!("server")),
        )],
    );
    let attempt = attempt_context(
        "attempt-business",
        vec![tool_mapping(
            "decl-business",
            "shared_name",
            "function",
            None,
        )],
    );
    handle
        .publish_successful_attempt(attempt.clone())
        .expect("publish successful business attempt");
    let context = typed_context_with_business_context(
        &handle,
        &attempt,
        Some(json!({"trace_id": "business-context"})),
        Some("concise"),
    );

    let response = project_v3_anthropic_message_as_responses_response_with_context(
        &json!({
            "id": "provider-message",
            "type": "message",
            "role": "assistant",
            "model": "claude-provider",
            "content": [
                {"type": "thinking", "thinking": "provider reasoning", "signature": "sig"},
                {"type": "tool_use", "id": "call-business", "name": "shared_name", "input": {"input": "business patch"}}
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }),
        &context,
    )
    .expect("business context response projection");

    assert_eq!(response["metadata"]["trace_id"], "business-context");
    assert_eq!(response["output"][0]["type"], "reasoning");
    assert_eq!(
        response["output"][0]["summary"][0]["text"],
        "provider reasoning"
    );
    assert_eq!(response["output"][1]["type"], "custom_tool_call");
    assert_eq!(response["output"][1]["namespace"], "server");
    assert_eq!(response["output"][1]["name"], "apply_patch");
    assert_eq!(response["output"][1]["input"], "business patch");
}

#[test]
fn successful_attempt_view_isolates_original_kind_namespace_and_preserves_payload() {
    let request_a = request_context(
        "req-a",
        vec![declaration(
            "decl-a-custom",
            "custom",
            "exec",
            Some(json!("functions")),
        )],
    );
    let attempt_a = attempt_context(
        "attempt-a",
        vec![tool_mapping(
            "decl-a-custom",
            "shared_name",
            "custom",
            Some(json!("functions")),
        )],
    );
    request_a
        .publish_successful_attempt(attempt_a.clone())
        .expect("successful attempt a");

    let request_b = request_context(
        "req-b",
        vec![declaration(
            "decl-b-function",
            "function",
            "exec",
            Some(json!("other")),
        )],
    );
    let attempt_b = attempt_context(
        "attempt-b",
        vec![tool_mapping(
            "decl-b-function",
            "shared_name",
            "function",
            Some(json!("other")),
        )],
    );
    request_b
        .publish_successful_attempt(attempt_b.clone())
        .expect("successful attempt b");

    let context_a = typed_context(&request_a, &attempt_a);
    let custom = project_v3_anthropic_message_as_responses_response_with_context(
        &provider_tool_use("shared_name", json!("*** Begin Patch\n*** End Patch")),
        &context_a,
    )
    .expect("custom projection");
    assert_eq!(custom["output"][0]["type"], "custom_tool_call");
    assert_eq!(custom["output"][0]["namespace"], "functions");
    assert_eq!(custom["output"][0]["name"], "exec");
    assert_eq!(custom["output"][0]["call_id"], "call-shared");
    assert_eq!(
        custom["output"][0]["input"],
        "*** Begin Patch\n*** End Patch"
    );

    let context_b = typed_context(&request_b, &attempt_b);
    let function = project_v3_anthropic_message_as_responses_response_with_context(
        &provider_tool_use(
            "shared_name",
            json!({"cmd": "pwd", "nested": {"exec": "printf 'x'"}}),
        ),
        &context_b,
    )
    .expect("function projection");
    assert_eq!(function["output"][0]["type"], "function_call");
    assert_eq!(function["output"][0]["namespace"], "other");
    assert_eq!(function["output"][0]["name"], "exec");
    assert_eq!(function["output"][0]["call_id"], "call-shared");
    assert_eq!(
        function["output"][0]["arguments"],
        "{\"cmd\":\"pwd\",\"nested\":{\"exec\":\"printf 'x'\"}}"
    );
}

#[test]
fn failed_attempt_then_successful_attempt_reencodes_from_only_successful_map() {
    let handle = request_context(
        "req-retry",
        vec![
            declaration("decl-first", "function", "first", None),
            declaration("decl-final", "custom", "apply_patch", Some(json!("server"))),
        ],
    );
    handle
        .record_failed_attempt("attempt-1", "provider failed")
        .expect("record failed attempt");
    let successful = attempt_context(
        "attempt-2",
        vec![tool_mapping(
            "decl-final",
            "shared_name",
            "custom",
            Some(json!("server")),
        )],
    );
    handle
        .publish_successful_attempt(successful.clone())
        .expect("publish successful attempt");

    let context = typed_context(&handle, &successful);
    let projected = project_v3_anthropic_message_as_responses_response_with_context(
        &provider_tool_use("shared_name", json!({"input": "second"})),
        &context,
    )
    .expect("successful attempt after failure");
    assert_eq!(projected["output"][0]["type"], "custom_tool_call");
    assert_eq!(projected["output"][0]["namespace"], "server");
    assert_eq!(projected["output"][0]["name"], "apply_patch");
    assert_eq!(projected["output"][0]["input"], "second");

    let failed = attempt_context(
        "attempt-1",
        vec![tool_mapping("decl-first", "shared_name", "function", None)],
    );
    assert!(ResponseProjectionView::from_successful_attempt(&handle, &failed).is_err());
}

#[test]
fn namespace_absence_and_nulls_follow_original_declaration_without_guessing() {
    let handle = request_context(
        "req-namespaces",
        vec![
            declaration("decl-absent", "function", "absent", None),
            declaration("decl-null", "function", "null_name", Some(Value::Null)),
            declaration(
                "decl-string",
                "function",
                "string_name",
                Some(json!("mcp.namespace")),
            ),
        ],
    );
    let attempt = attempt_context(
        "attempt-namespaces",
        vec![
            tool_mapping("decl-absent", "call_absent", "function", None),
            tool_mapping("decl-null", "call_null", "function", Some(Value::Null)),
            tool_mapping(
                "decl-string",
                "call_string",
                "function",
                Some(json!("mcp.namespace")),
            ),
        ],
    );
    handle
        .publish_successful_attempt(attempt.clone())
        .expect("successful namespaces");
    let context = typed_context(&handle, &attempt);

    let absent = project_v3_anthropic_message_as_responses_response_with_context(
        &provider_tool_use("call_absent", json!({})),
        &context,
    )
    .expect("absent namespace");
    assert!(absent["output"][0].get("namespace").is_none());
    assert_eq!(absent["output"][0]["name"], "absent");

    let null = project_v3_anthropic_message_as_responses_response_with_context(
        &provider_tool_use("call_null", json!({})),
        &context,
    )
    .expect("null namespace");
    assert_eq!(null["output"][0]["namespace"], Value::Null);
    assert_eq!(null["output"][0]["name"], "null_name");

    let string = project_v3_anthropic_message_as_responses_response_with_context(
        &provider_tool_use("call_string", json!({})),
        &context,
    )
    .expect("string namespace");
    assert_eq!(string["output"][0]["namespace"], "mcp.namespace");
    assert_eq!(string["output"][0]["name"], "string_name");
}

#[tokio::test]
async fn public_provider_sse_consumes_successful_attempt_identity() {
    let handle = request_context(
        "req-sse",
        vec![declaration(
            "decl-sse",
            "custom",
            "apply_patch",
            Some(json!("server")),
        )],
    );
    let attempt = attempt_context(
        "attempt-sse",
        vec![tool_mapping("decl-sse", "shared_name", "function", None)],
    );
    handle
        .publish_successful_attempt(attempt.clone())
        .expect("successful sse attempt");
    let context = typed_context(&handle, &attempt);
    let provider = Box::pin(futures_util::stream::iter(vec![
        Ok(br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_sse","type":"message","role":"assistant","model":"claude-provider","content":[],"usage":{"input_tokens":1}}}

"#
        .to_vec()),
        Ok(br#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-shared","name":"shared_name"}}

"#
        .to_vec()),
        Ok(br#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"input\":\"sse patch\"}"}}

"#
        .to_vec()),
        Ok(br#"event: content_block_stop
data: {"type":"content_block_stop","index":0}

"#
        .to_vec()),
        Ok(br#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":2}}

"#
        .to_vec()),
        Ok(br#"event: message_stop
data: {"type":"message_stop"}

"#
        .to_vec()),
    ]));

    let response = materialize_v3_provider_sse_as_canonical_response_with_context(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &context,
    )
    .await
    .expect("real Anthropic provider SSE materialization");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["namespace"], "server");
    assert_eq!(response["output"][0]["name"], "apply_patch");
    assert_eq!(response["output"][0]["call_id"], "call-shared");
    assert_eq!(response["output"][0]["input"], "sse patch");
}
