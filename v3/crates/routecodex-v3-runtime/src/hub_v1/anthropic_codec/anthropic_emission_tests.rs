use super::super::request_outbound_format::build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations;
use super::{
    anthropic_tool_use_as_responses_call, encode_v3_responses_semantic_as_anthropic_request,
    encode_v3_responses_semantic_as_anthropic_request_with_declarations,
    project_v3_anthropic_message_as_responses_response_with_context,
    V3AnthropicResponsesProjectionContext,
};
use crate::operation_runner::{
    apply_canonical_field_edit, execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, AttemptContext,
    AttemptDeclarationMap, AttemptProjectionContext, CanonicalFieldEdit, CurrentFieldAssociations,
    RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind,
    RequestScopedContextPair, ResponseProjectionView, ToolDeclarationReference,
    ToolMappingReference, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn tool_mapping(
    declaration_record_id: &str,
    source_path: &str,
    destination_path: &str,
    emitted_name: &str,
) -> ToolMappingReference {
    ToolMappingReference {
        declaration_record_id: declaration_record_id.to_string(),
        source_path: source_path.to_string(),
        destination_path: destination_path.to_string(),
        emitted_kind: "function".to_string(),
        emitted_name: Some(emitted_name.to_string()),
        emitted_namespace: None,
        encoding: "json".to_string(),
    }
}

fn publish_anthropic_attempt(
    handle: &V3RequestContextHandle,
    attempt_id: &str,
    mappings: Vec<ToolMappingReference>,
) -> AttemptContext {
    let attempt = AttemptContext {
        attempt_id: attempt_id.to_string(),
        projection: AttemptProjectionContext {
            attempt_id: attempt_id.to_string(),
            provider_protocol: "anthropic".to_string(),
            provider_model: "provider-model".to_string(),
            paths: Vec::new(),
        },
        declarations: AttemptDeclarationMap {
            attempt_id: attempt_id.to_string(),
            provider_protocol: "anthropic".to_string(),
            provider_model: "provider-model".to_string(),
            tool_mappings: mappings,
        },
    };
    handle
        .publish_successful_attempt(attempt.clone())
        .expect("publish successful Anthropic attempt");
    attempt
}

fn successful_view(
    handle: &V3RequestContextHandle,
    attempt: &AttemptContext,
) -> ResponseProjectionView {
    ResponseProjectionView::from_successful_attempt(handle, attempt)
        .expect("successful attempt view")
}

struct AnthropicSdkRequest {
    handle: V3RequestContextHandle,
    canonical: Value,
    pair: RequestScopedContextPair,
    initial: CurrentFieldAssociations,
}

fn anthropic_sdk_request(request_id: &str, raw: Value) -> AnthropicSdkRequest {
    let handle = V3RequestContextHandle::new(request_id.to_string(), "responses".to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}-invocation"),
        format!("{request_id}-attempt"),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw)
        .expect("public SDK capture must accept the client request");
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public SDK normalize must publish the immutable original pair");
    let pair = handle.original_pair().expect("published inverse pair");
    let initial = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    AnthropicSdkRequest {
        handle,
        canonical,
        pair,
        initial,
    }
}

fn declaration_at<'a>(
    pair: &'a RequestScopedContextPair,
    source_path: &str,
) -> &'a ToolDeclarationReference {
    pair.inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == source_path)
        .unwrap_or_else(|| panic!("missing original declaration for {source_path}"))
}

fn emit_responses(
    canonical: &Value,
    pair: &RequestScopedContextPair,
    current: &CurrentFieldAssociations,
) -> (Value, Vec<ToolMappingReference>) {
    build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations(
        canonical,
        &pair.inverse_context,
        current,
    )
    .expect("standard Responses emitter must consume the current origins")
}

fn emit_anthropic(
    responses_wire: Value,
    source_mappings: &[ToolMappingReference],
) -> (Value, Vec<ToolMappingReference>) {
    encode_v3_responses_semantic_as_anthropic_request_with_declarations(
        responses_wire,
        source_mappings,
    )
    .expect("Anthropic emitter must consume the Responses declaration map")
}

fn mapping_at<'a>(
    mappings: &'a [ToolMappingReference],
    destination_path: &str,
) -> &'a ToolMappingReference {
    mappings
        .iter()
        .find(|mapping| mapping.destination_path == destination_path)
        .unwrap_or_else(|| panic!("missing emitted mapping at {destination_path}"))
}

#[test]
fn anthropic_emission_consumes_standard_responses_declarations_and_projects_tools() {
    let patch = "*** Begin Patch\n*** Add File: /tmp/req02-anthropic\n+literal $() and `bytes`\n*** End Patch\n";
    let raw = json!({
        "model": "client-model",
        "input": [{"role": "user", "content": "Use the declared tools"}],
        "tools": [{
            "type": "namespace",
            "name": "functions",
            "tools": [{
                "type": "namespace",
                "name": "mcp__mcpx",
                "tools": [
                    {"type": "custom", "name": "apply_patch", "format": {"type": "text"}},
                    {
                        "type": "function",
                        "name": "exec",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}}
                        }
                    }
                ]
            }]
        }]
    });
    let handle = V3RequestContextHandle::new(
        "req-anthropic-emission".to_string(),
        "responses".to_string(),
    );
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "invocation-anthropic-emission".to_string(),
        "attempt-anthropic-emission".to_string(),
        RequestOriginKind::ClientEntry,
    );
    let captured =
        execute_v3_operation_runner_request_capture_client_json(raw).expect("real SDK capture");
    let mut canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("real SDK normalize");
    let pair = handle.original_pair().expect("original inverse pair");
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);

    canonical["tools"][0]["tools"][0]["tools"][1]["parameters"]["x-unknown"] = json!(null);
    canonical["tools"][0]["tools"][0]["tools"][1]["parameters"]["properties"]["cmd"]["nullable"] =
        json!(true);
    let canonical_before_emission = canonical.clone();

    let (responses_wire, source_mappings) =
        build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations(
            &canonical,
            &pair.inverse_context,
            &current,
        )
        .expect("standard Responses emitter");
    assert_eq!(
        canonical, canonical_before_emission,
        "standard emission must not mutate the current canonical"
    );
    assert_eq!(source_mappings.len(), 2);

    let (anthropic_wire, mappings) =
        encode_v3_responses_semantic_as_anthropic_request_with_declarations(
            responses_wire.clone(),
            &source_mappings,
        )
        .expect("Anthropic emission with typed source declarations");
    let observer_free_wire = encode_v3_responses_semantic_as_anthropic_request(responses_wire)
        .expect("observer-free Anthropic emission");
    assert_eq!(
        anthropic_wire, observer_free_wire,
        "the observer-free and declaration-aware APIs must share byte-equivalent wire output"
    );

    assert_eq!(mappings.len(), 2);
    let patch_declaration = pair
        .inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == "request.tools[0].tools[0].tools[0]")
        .expect("apply_patch declaration");
    let patch_mapping = mappings
        .iter()
        .find(|mapping| mapping.destination_path == "tools[0]")
        .expect("apply_patch destination mapping");
    assert_eq!(
        patch_mapping.declaration_record_id,
        patch_declaration.record_id
    );
    assert_eq!(patch_mapping.source_path, patch_declaration.source_path);
    assert_eq!(
        patch_mapping.emitted_name.as_deref(),
        Some("functions__mcp__mcpx__apply_patch")
    );
    assert_eq!(patch_mapping.emitted_kind, "function");
    assert_eq!(patch_mapping.emitted_namespace, None);

    let exec_mapping = mappings
        .iter()
        .find(|mapping| mapping.destination_path == "tools[1]")
        .expect("exec destination mapping");
    assert_eq!(
        exec_mapping.source_path,
        "request.tools[0].tools[0].tools[1]"
    );
    assert_eq!(
        exec_mapping.emitted_name.as_deref(),
        Some("functions__mcp__mcpx__exec")
    );
    assert_eq!(
        anthropic_wire["tools"][1]["input_schema"]["x-unknown"],
        Value::Null
    );
    assert_eq!(
        anthropic_wire["tools"][1]["input_schema"]["properties"]["cmd"]["nullable"],
        true
    );

    let attempt =
        publish_anthropic_attempt(&handle, "attempt-anthropic-emission", mappings.clone());
    let view = successful_view(&handle, &attempt);
    let context = V3AnthropicResponsesProjectionContext::from_successful_attempt(&view)
        .expect("Anthropic response projection context");

    let patch_call = anthropic_tool_use_as_responses_call(
        &json!({
            "type": "tool_use",
            "id": "call-patch",
            "name": "functions__mcp__mcpx__apply_patch",
            "input": {"input": patch}
        }),
        &context,
    )
    .expect("custom tool_use must restore the original declaration");
    assert_eq!(patch_call["type"], "custom_tool_call");
    assert_eq!(patch_call["name"], "apply_patch");
    assert_eq!(patch_call["namespace"], "mcp__mcpx");
    assert_eq!(patch_call["input"], patch);

    let exec_input = json!({
        "cmd": "printf '%s\\n' 'complete command'",
        "cwd": "/tmp"
    });
    let exec_call = anthropic_tool_use_as_responses_call(
        &json!({
            "type": "tool_use",
            "id": "call-exec",
            "name": "functions__mcp__mcpx__exec",
            "input": exec_input.clone()
        }),
        &context,
    )
    .expect("function tool_use must restore the original declaration");
    assert_eq!(exec_call["type"], "function_call");
    assert_eq!(exec_call["name"], "exec");
    assert_eq!(exec_call["namespace"], "mcp__mcpx");
    assert_eq!(
        serde_json::from_str::<Value>(exec_call["arguments"].as_str().unwrap()).unwrap(),
        exec_input
    );
}

#[test]
fn anthropic_emission_keeps_same_leaf_custom_and_function_sources_distinct() {
    let raw = json!({
        "model": "client-model",
        "input": [{"role": "user", "content": "Use both exec declarations"}],
        "tools": [
            {
                "type": "namespace",
                "name": "alpha",
                "tools": [{"type": "custom", "name": "exec", "format": {"type": "text"}}]
            },
            {
                "type": "namespace",
                "name": "beta",
                "tools": [{"type": "function", "name": "exec", "parameters": {"type": "object"}}]
            }
        ]
    });
    let handle = V3RequestContextHandle::new("req-same-leaf".to_string(), "responses".to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "invocation-same-leaf".to_string(),
        "attempt-same-leaf".to_string(),
        RequestOriginKind::ClientEntry,
    );
    let captured =
        execute_v3_operation_runner_request_capture_client_json(raw).expect("real SDK capture");
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("real SDK normalize");
    let pair = handle.original_pair().expect("original inverse pair");
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    let (responses_wire, source_mappings) =
        build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations(
            &canonical,
            &pair.inverse_context,
            &current,
        )
        .expect("standard Responses emitter");

    let (anthropic_wire, mappings) =
        encode_v3_responses_semantic_as_anthropic_request_with_declarations(
            responses_wire,
            &source_mappings,
        )
        .expect("Anthropic emission");

    assert_eq!(anthropic_wire["tools"][0]["name"], "alpha__exec");
    assert_eq!(anthropic_wire["tools"][1]["name"], "beta__exec");
    assert_eq!(mappings.len(), 2);
    let alpha = mappings
        .iter()
        .find(|mapping| mapping.destination_path == "tools[0]")
        .expect("alpha mapping");
    let beta = mappings
        .iter()
        .find(|mapping| mapping.destination_path == "tools[1]")
        .expect("beta mapping");
    assert_eq!(alpha.source_path, "request.tools[0].tools[0]");
    assert_eq!(beta.source_path, "request.tools[1].tools[0]");
    assert_ne!(alpha.declaration_record_id, beta.declaration_record_id);
    assert_eq!(alpha.emitted_name.as_deref(), Some("alpha__exec"));
    assert_eq!(beta.emitted_name.as_deref(), Some("beta__exec"));
}

#[test]
fn anthropic_emission_uses_latest_same_wire_name_source() {
    let responses_wire = json!({
        "tools": [
            {"type": "function", "name": "exec", "parameters": {"type": "object"}},
            {"type": "function", "name": "exec", "parameters": {"type": "object"}}
        ]
    });
    let source_declarations = vec![
        tool_mapping("record-first", "request.tools[0]", "tools[0]", "exec"),
        tool_mapping("record-second", "request.tools[1]", "tools[1]", "exec"),
    ];

    let (wire, mappings) = encode_v3_responses_semantic_as_anthropic_request_with_declarations(
        responses_wire,
        &source_declarations,
    )
    .expect("same-name replacement must consume the actual final source");

    assert_eq!(wire["tools"].as_array().unwrap().len(), 1);
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0].declaration_record_id, "record-second");
    assert_eq!(mappings[0].source_path, "request.tools[1]");
    assert_eq!(mappings[0].destination_path, "tools[0]");
}

#[test]
fn anthropic_emission_does_not_invent_source_for_additional_tools_override() {
    let responses_wire = json!({
        "tools": [
            {
                "type": "function",
                "name": "exec",
                "parameters": {"type": "object", "properties": {"base": {"type": "string"}}}
            },
            {
                "type": "function",
                "name": "lookup",
                "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}
            }
        ],
        "input": [{
            "type": "additional_tools",
            "tools": [{
                "type": "function",
                "name": "exec",
                "parameters": {"type": "object", "properties": {"replacement": {"type": "string"}}}
            }]
        }]
    });
    let source_declarations = vec![
        tool_mapping("record-exec", "request.tools[0]", "tools[0]", "exec"),
        tool_mapping("record-lookup", "request.tools[1]", "tools[1]", "lookup"),
    ];

    let (wire, mappings) = encode_v3_responses_semantic_as_anthropic_request_with_declarations(
        responses_wire,
        &source_declarations,
    )
    .expect("additional_tools must use its actual input path");

    assert_eq!(wire["tools"].as_array().unwrap().len(), 2);
    assert_eq!(
        wire["tools"][0]["input_schema"]["properties"]["replacement"]["type"],
        "string"
    );
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0].declaration_record_id, "record-lookup");
    assert_eq!(mappings[0].destination_path, "tools[1]");
    assert!(mappings
        .iter()
        .all(|mapping| mapping.declaration_record_id != "record-exec"));
}

#[test]
fn anthropic_emission_tracks_consecutive_sdk_removals_and_reverses_survivor() {
    let sdk = anthropic_sdk_request(
        "anthropic-consecutive",
        json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "Use the declared tools"}],
            "tools": [{
                "type": "namespace",
                "name": "functions",
                "tools": [
                    {"type": "custom", "name": "first", "format": {"type": "text"}},
                    {"type": "custom", "name": "second", "format": {"type": "text"}},
                    {
                        "type": "function",
                        "name": "survivor",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}}
                        }
                    }
                ]
            }]
        }),
    );
    let first_id = declaration_at(&sdk.pair, "request.tools[0].tools[0]")
        .record_id
        .clone();
    let second_id = declaration_at(&sdk.pair, "request.tools[0].tools[1]")
        .record_id
        .clone();
    let survivor = declaration_at(&sdk.pair, "request.tools[0].tools[2]");
    let survivor_id = survivor.record_id.clone();
    let survivor_source = survivor.source_path.clone();
    let original_canonical = sdk.canonical.clone();
    let original_inverse = sdk.pair.inverse_context.clone();
    let original_history = sdk.pair.explicit_history_pairing.clone();
    let original_current = sdk.initial.clone();

    let (canonical, current) = apply_canonical_field_edit(
        &sdk.canonical,
        &sdk.initial,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        },
    )
    .expect("first registered removal");
    let (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        },
    )
    .expect("second registered removal");

    assert_eq!(
        sdk.canonical, original_canonical,
        "registered edits must not mutate the request canonical"
    );
    assert_eq!(
        sdk.pair.inverse_context, original_inverse,
        "registered edits must not mutate the original inverse"
    );
    assert_eq!(
        sdk.pair.explicit_history_pairing, original_history,
        "registered edits must not mutate the original history pairing"
    );
    assert_eq!(
        sdk.initial, original_current,
        "registered edits must not mutate the input current associations"
    );

    let (responses_wire, source_mappings) = emit_responses(&canonical, &sdk.pair, &current);
    assert_eq!(responses_wire["tools"].as_array().unwrap().len(), 1);
    assert_eq!(responses_wire["tools"][0]["name"], "functions__survivor");
    assert_eq!(source_mappings.len(), 1);
    let source_survivor = mapping_at(&source_mappings, "tools[0]");
    assert_eq!(source_survivor.declaration_record_id, survivor_id);
    assert_eq!(source_survivor.source_path, survivor_source);

    let (anthropic_wire, mappings) = emit_anthropic(responses_wire, &source_mappings);
    assert_eq!(anthropic_wire["tools"].as_array().unwrap().len(), 1);
    assert_eq!(anthropic_wire["tools"][0]["name"], "functions__survivor");
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0].declaration_record_id, survivor_id);
    assert_eq!(mappings[0].source_path, survivor_source);
    assert_eq!(mappings[0].destination_path, "tools[0]");
    assert!(
        mappings
            .iter()
            .all(|mapping| mapping.declaration_record_id != first_id
                && mapping.declaration_record_id != second_id),
        "removed custom declarations must not remain associated"
    );

    let attempt = publish_anthropic_attempt(
        &sdk.handle,
        "anthropic-consecutive-attempt",
        mappings.clone(),
    );
    let view = successful_view(&sdk.handle, &attempt);
    let context = V3AnthropicResponsesProjectionContext::from_successful_attempt(&view)
        .expect("Anthropic response projection context");
    let exec_input = json!({
        "cmd": "printf '%s\\n' 'complete command'",
        "cwd": "/tmp"
    });
    let expected_arguments = serde_json::to_string(&exec_input).unwrap();
    let response = project_v3_anthropic_message_as_responses_response_with_context(
        &json!({
            "id": "msg-consecutive",
            "model": "provider-model",
            "content": [{
                "type": "tool_use",
                "id": "call-exec",
                "name": "functions__survivor",
                "input": exec_input
            }],
            "stop_reason": "tool_use"
        }),
        &context,
    )
    .expect("successful Anthropic attempt must reverse through the existing response mapper");
    let output = response["output"].as_array().expect("Responses output");
    assert_eq!(output.len(), 1);
    assert_eq!(output[0]["type"], "function_call");
    assert_eq!(output[0]["name"], "survivor");
    assert_eq!(output[0]["namespace"], "functions");
    assert_eq!(output[0]["call_id"], "call-exec");
    assert_eq!(output[0]["arguments"], expected_arguments);
}

#[test]
fn anthropic_emission_tracks_nested_namespace_shift_and_reverses_custom_tool() {
    let patch = "*** Begin Patch\n*** Add File: /tmp/req02-anthropic-shift\n+literal $() and `bytes`\n*** End Patch\n";
    let sdk = anthropic_sdk_request(
        "anthropic-nested-shift",
        json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "Use the nested tools"}],
            "tools": [{
                "type": "namespace",
                "name": "outer",
                "tools": [{
                    "type": "namespace",
                    "name": "inner",
                    "tools": [
                        {"type": "function", "name": "drop", "parameters": {"type": "object"}},
                        {"type": "custom", "name": "apply_patch", "format": {"type": "text"}}
                    ]
                }]
            }]
        }),
    );
    let dropped_id = declaration_at(&sdk.pair, "request.tools[0].tools[0].tools[0]")
        .record_id
        .clone();
    let patch_declaration = declaration_at(&sdk.pair, "request.tools[0].tools[0].tools[1]");
    let patch_id = patch_declaration.record_id.clone();
    let patch_source = patch_declaration.source_path.clone();

    let (canonical, current) = apply_canonical_field_edit(
        &sdk.canonical,
        &sdk.initial,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0].tools[0]".to_string(),
        },
    )
    .expect("registered nested removal");
    let (responses_wire, source_mappings) = emit_responses(&canonical, &sdk.pair, &current);

    assert_eq!(responses_wire["tools"].as_array().unwrap().len(), 1);
    assert_eq!(responses_wire["tools"][0]["type"], "function");
    assert_eq!(
        responses_wire["tools"][0]["parameters"]["properties"]["input"]["type"],
        "string"
    );
    assert_eq!(
        responses_wire["tools"][0]["name"],
        "outer__inner__apply_patch"
    );
    assert_eq!(source_mappings.len(), 1);
    let source_patch = mapping_at(&source_mappings, "tools[0]");
    assert_eq!(source_patch.declaration_record_id, patch_id);
    assert_eq!(source_patch.source_path, patch_source);

    let (anthropic_wire, mappings) = emit_anthropic(responses_wire, &source_mappings);
    assert_eq!(anthropic_wire["tools"].as_array().unwrap().len(), 1);
    assert_eq!(
        anthropic_wire["tools"][0]["name"],
        "outer__inner__apply_patch"
    );
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0].declaration_record_id, patch_id);
    assert_eq!(mappings[0].source_path, patch_source);
    assert_eq!(mappings[0].destination_path, "tools[0]");
    assert_eq!(
        mappings[0].emitted_name.as_deref(),
        Some("outer__inner__apply_patch")
    );
    assert_eq!(mappings[0].emitted_namespace, None);
    assert!(
        mappings
            .iter()
            .all(|mapping| mapping.declaration_record_id != dropped_id),
        "the removed nested declaration must not remain associated"
    );

    let attempt =
        publish_anthropic_attempt(&sdk.handle, "anthropic-nested-shift-attempt", mappings);
    let view = successful_view(&sdk.handle, &attempt);
    let context = V3AnthropicResponsesProjectionContext::from_successful_attempt(&view)
        .expect("Anthropic response projection context");
    let response = project_v3_anthropic_message_as_responses_response_with_context(
        &json!({
            "id": "msg-nested",
            "model": "provider-model",
            "content": [{
                "type": "tool_use",
                "id": "call-patch",
                "name": "outer__inner__apply_patch",
                "input": {"input": patch}
            }],
            "stop_reason": "tool_use"
        }),
        &context,
    )
    .expect("successful Anthropic attempt must restore the nested custom declaration");
    let output = response["output"].as_array().expect("Responses output");
    assert_eq!(output.len(), 1);
    assert_eq!(output[0]["type"], "custom_tool_call");
    assert_eq!(output[0]["name"], "apply_patch");
    assert_eq!(output[0]["namespace"], "inner");
    assert_eq!(output[0]["call_id"], "call-patch");
    assert_eq!(output[0]["input"], patch);
}

#[test]
fn anthropic_emission_tracks_sdk_insert_without_inventing_source() {
    let sdk = anthropic_sdk_request(
        "anthropic-insert",
        json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "Use the declared tool"}],
            "tools": [{
                "type": "namespace",
                "name": "functions",
                "tools": [{
                    "type": "function",
                    "name": "original",
                    "parameters": {"type": "object"}
                }]
            }]
        }),
    );
    let original = declaration_at(&sdk.pair, "request.tools[0].tools[0]");
    let original_id = original.record_id.clone();
    let original_source = original.source_path.clone();

    let (canonical, current) = apply_canonical_field_edit(
        &sdk.canonical,
        &sdk.initial,
        &CanonicalFieldEdit::InsertArray {
            array_path: "chat.tools[0].tools".to_string(),
            index: 0,
            value: json!({"type": "function", "name": "injected", "parameters": {"type": "object"}}),
        },
    )
    .expect("registered front insert");
    let (responses_wire, source_mappings) = emit_responses(&canonical, &sdk.pair, &current);
    assert_eq!(responses_wire["tools"][0]["name"], "functions__injected");
    assert_eq!(responses_wire["tools"][1]["name"], "functions__original");
    assert_eq!(source_mappings.len(), 1);
    let source_original = mapping_at(&source_mappings, "tools[1]");
    assert_eq!(source_original.declaration_record_id, original_id);
    assert_eq!(source_original.source_path, original_source);

    let (anthropic_wire, mappings) = emit_anthropic(responses_wire, &source_mappings);
    assert_eq!(anthropic_wire["tools"][0]["name"], "functions__injected");
    assert_eq!(anthropic_wire["tools"][1]["name"], "functions__original");
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0].declaration_record_id, original_id);
    assert_eq!(mappings[0].source_path, original_source);
    assert_eq!(mappings[0].destination_path, "tools[1]");
}

#[test]
fn anthropic_emission_tracks_sdk_array_move_by_original_records() {
    let sdk = anthropic_sdk_request(
        "anthropic-move",
        json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "Use the declared tools"}],
            "tools": [{
                "type": "namespace",
                "name": "functions",
                "tools": [
                    {"type": "function", "name": "alpha", "parameters": {"type": "object"}},
                    {"type": "function", "name": "beta", "parameters": {"type": "object"}},
                    {"type": "function", "name": "gamma", "parameters": {"type": "object"}}
                ]
            }]
        }),
    );
    let alpha = declaration_at(&sdk.pair, "request.tools[0].tools[0]");
    let alpha_id = alpha.record_id.clone();
    let alpha_source = alpha.source_path.clone();
    let beta = declaration_at(&sdk.pair, "request.tools[0].tools[1]");
    let beta_id = beta.record_id.clone();
    let beta_source = beta.source_path.clone();
    let gamma = declaration_at(&sdk.pair, "request.tools[0].tools[2]");
    let gamma_id = gamma.record_id.clone();
    let gamma_source = gamma.source_path.clone();

    let (canonical, current) = apply_canonical_field_edit(
        &sdk.canonical,
        &sdk.initial,
        &CanonicalFieldEdit::MoveArray {
            array_path: "chat.tools[0].tools".to_string(),
            from: 0,
            to: 1,
        },
    )
    .expect("registered array move");
    let (responses_wire, source_mappings) = emit_responses(&canonical, &sdk.pair, &current);
    assert_eq!(responses_wire["tools"][0]["name"], "functions__beta");
    assert_eq!(responses_wire["tools"][1]["name"], "functions__alpha");
    assert_eq!(responses_wire["tools"][2]["name"], "functions__gamma");
    assert_eq!(source_mappings.len(), 3);
    assert_eq!(
        mapping_at(&source_mappings, "tools[0]").declaration_record_id,
        beta_id
    );
    assert_eq!(
        mapping_at(&source_mappings, "tools[1]").declaration_record_id,
        alpha_id
    );
    assert_eq!(
        mapping_at(&source_mappings, "tools[2]").declaration_record_id,
        gamma_id
    );

    let (anthropic_wire, mappings) = emit_anthropic(responses_wire, &source_mappings);
    assert_eq!(anthropic_wire["tools"][0]["name"], "functions__beta");
    assert_eq!(anthropic_wire["tools"][1]["name"], "functions__alpha");
    assert_eq!(anthropic_wire["tools"][2]["name"], "functions__gamma");
    assert_eq!(mappings.len(), 3);
    let beta_mapping = mapping_at(&mappings, "tools[0]");
    assert_eq!(beta_mapping.declaration_record_id, beta_id);
    assert_eq!(beta_mapping.source_path, beta_source);
    let alpha_mapping = mapping_at(&mappings, "tools[1]");
    assert_eq!(alpha_mapping.declaration_record_id, alpha_id);
    assert_eq!(alpha_mapping.source_path, alpha_source);
    let gamma_mapping = mapping_at(&mappings, "tools[2]");
    assert_eq!(gamma_mapping.declaration_record_id, gamma_id);
    assert_eq!(gamma_mapping.source_path, gamma_source);
}
