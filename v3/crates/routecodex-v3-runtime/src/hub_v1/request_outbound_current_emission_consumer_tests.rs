//! REQ02 current-origin consumption at the real standard emit points.
//!
//! Every case enters through the public SDK capture + lossless normalize,
//! applies structural changes only through the registered paired edit consumer
//! (`apply_canonical_field_edit`, consuming both the returned data and the
//! returned current association set), and then drives the real standard
//! Chat/Responses emitters. The final case binds the surviving declaration into
//! a real `AttemptContext -> publish_successful_attempt -> ResponseProjectionView`
//! and reverses through the public Chat response inverse. No hand-built inverse
//! stands in for a successful attempt.

use crate::hub_v1::{
    build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations,
    build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations,
    project_v3_openai_chat_response_as_responses_with_successful_attempt,
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

struct SdkRequest {
    handle: V3RequestContextHandle,
    canonical: Value,
    pair: RequestScopedContextPair,
    initial: CurrentFieldAssociations,
}

fn sdk_request(request_id: &str, raw: Value) -> SdkRequest {
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
    SdkRequest {
        handle,
        canonical,
        pair,
        initial,
    }
}

fn namespace_pair_raw() -> Value {
    json!({
        "model": "client-model",
        "input": [{"role": "user", "content": "use the declared tools"}],
        "tools": [{
            "type": "namespace",
            "name": "functions",
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
    })
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

fn chat_emit(
    canonical: &Value,
    pair: &RequestScopedContextPair,
    current: &CurrentFieldAssociations,
) -> (Value, Vec<ToolMappingReference>) {
    build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations(
        canonical,
        &pair.inverse_context,
        current,
    )
    .expect("standard Chat emitter must consume the current origins")
}

fn responses_emit(
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

fn chat_tool_names(wire: &Value) -> Vec<String> {
    wire["tools"]
        .as_array()
        .expect("provider tools array")
        .iter()
        .map(|tool| {
            tool["function"]["name"]
                .as_str()
                .expect("flattened Chat provider tool name")
                .to_string()
        })
        .collect()
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
fn current_origin_survives_consecutive_registered_removals() {
    let sdk = sdk_request(
        "consumer-consecutive",
        json!({
            "input": [],
            "tools": [{"type": "namespace", "name": "functions", "tools": [
                {"type": "custom", "name": "first", "format": {"type": "text"}},
                {"type": "custom", "name": "second", "format": {"type": "text"}},
                {"type": "function", "name": "survivor", "parameters": {"type": "object"}}
            ]}]
        }),
    );
    let survivor = declaration_at(&sdk.pair, "request.tools[0].tools[2]");
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

    let (wire, mappings) = chat_emit(&canonical, &sdk.pair, &current);
    assert_eq!(chat_tool_names(&wire), vec!["functions__survivor"]);
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0].declaration_record_id, survivor.record_id);
    assert_eq!(mappings[0].source_path, "request.tools[0].tools[2]");
    assert_eq!(mappings[0].destination_path, "tools[0]");
}

#[test]
fn current_origin_inserted_front_element_does_not_invent_a_record() {
    let sdk = sdk_request(
        "consumer-insert-front",
        json!({
            "input": [],
            "tools": [{"type": "namespace", "name": "functions", "tools": [
                {"type": "function", "name": "original", "parameters": {"type": "object"}}
            ]}]
        }),
    );
    let original = declaration_at(&sdk.pair, "request.tools[0].tools[0]");
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

    let (wire, mappings) = chat_emit(&canonical, &sdk.pair, &current);
    assert_eq!(
        chat_tool_names(&wire),
        vec!["functions__injected", "functions__original"]
    );
    assert_eq!(
        mappings.len(),
        1,
        "a producer-inserted element has no original mapping and must not invent one"
    );
    assert_eq!(mappings[0].declaration_record_id, original.record_id);
    assert_eq!(mappings[0].source_path, "request.tools[0].tools[0]");
    assert_eq!(mappings[0].destination_path, "tools[1]");
    assert!(
        mappings
            .iter()
            .all(|mapping| mapping.destination_path != "tools[0]"),
        "the inserted element must stay unassociated"
    );
}

#[test]
fn current_origin_follows_registered_array_move() {
    let sdk = sdk_request(
        "consumer-move",
        json!({
            "input": [],
            "tools": [{"type": "namespace", "name": "functions", "tools": [
                {"type": "function", "name": "alpha", "parameters": {"type": "object"}},
                {"type": "function", "name": "beta", "parameters": {"type": "object"}},
                {"type": "function", "name": "gamma", "parameters": {"type": "object"}}
            ]}]
        }),
    );
    let alpha = declaration_at(&sdk.pair, "request.tools[0].tools[0]");
    let beta = declaration_at(&sdk.pair, "request.tools[0].tools[1]");
    let gamma = declaration_at(&sdk.pair, "request.tools[0].tools[2]");
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

    let (wire, mappings) = chat_emit(&canonical, &sdk.pair, &current);
    assert_eq!(
        chat_tool_names(&wire),
        vec!["functions__beta", "functions__alpha", "functions__gamma"]
    );
    assert_eq!(
        mapping_at(&mappings, "tools[0]").declaration_record_id,
        beta.record_id
    );
    assert_eq!(
        mapping_at(&mappings, "tools[1]").declaration_record_id,
        alpha.record_id
    );
    assert_eq!(
        mapping_at(&mappings, "tools[2]").declaration_record_id,
        gamma.record_id
    );
    assert_eq!(
        mapping_at(&mappings, "tools[1]").source_path,
        "request.tools[0].tools[0]"
    );
    assert_eq!(
        mapping_at(&mappings, "tools[0]").source_path,
        "request.tools[0].tools[1]"
    );
}

#[test]
fn current_origin_survives_nested_namespace_removal() {
    let sdk = sdk_request(
        "consumer-nested",
        json!({
            "input": [],
            "tools": [{"type": "namespace", "name": "outer", "tools": [{
                "type": "namespace", "name": "inner", "tools": [
                    {"type": "custom", "name": "apply_patch", "format": {"type": "text"}},
                    {"type": "function", "name": "exec", "parameters": {"type": "object"}}
                ]
            }]}]
        }),
    );
    let exec = declaration_at(&sdk.pair, "request.tools[0].tools[0].tools[1]");
    let (canonical, current) = apply_canonical_field_edit(
        &sdk.canonical,
        &sdk.initial,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0].tools[0]".to_string(),
        },
    )
    .expect("registered nested removal");

    let (wire, mappings) = chat_emit(&canonical, &sdk.pair, &current);
    assert_eq!(chat_tool_names(&wire), vec!["outer__inner__exec"]);
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0].declaration_record_id, exec.record_id);
    assert_eq!(
        mappings[0].source_path,
        "request.tools[0].tools[0].tools[1]"
    );
}

#[test]
fn current_origin_distinguishes_identical_name_and_schema() {
    let sdk = sdk_request(
        "consumer-same-shape",
        json!({
            "input": [],
            "tools": [
                {"type": "namespace", "name": "alpha", "tools": [{
                    "type": "function", "name": "dup",
                    "parameters": {"type": "object", "properties": {"x": {"type": "string"}}}
                }]},
                {"type": "namespace", "name": "beta", "tools": [{
                    "type": "function", "name": "dup",
                    "parameters": {"type": "object", "properties": {"x": {"type": "string"}}}
                }]}
            ]
        }),
    );
    let beta = declaration_at(&sdk.pair, "request.tools[1].tools[0]");
    let (canonical, current) = apply_canonical_field_edit(
        &sdk.canonical,
        &sdk.initial,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0]".to_string(),
        },
    )
    .expect("registered container removal");

    let (wire, mappings) = chat_emit(&canonical, &sdk.pair, &current);
    assert_eq!(chat_tool_names(&wire), vec!["beta__dup"]);
    assert_eq!(mappings.len(), 1);
    assert_eq!(
        mappings[0].declaration_record_id, beta.record_id,
        "identical leaf name and schema must not re-identify the surviving origin"
    );
    assert_eq!(mappings[0].source_path, "request.tools[1].tools[0]");
}

#[test]
fn current_origin_is_stable_across_registered_schema_replace() {
    let sdk = sdk_request("consumer-schema", namespace_pair_raw());
    let patch = declaration_at(&sdk.pair, "request.tools[0].tools[0]");
    let exec = declaration_at(&sdk.pair, "request.tools[0].tools[1]");
    let (canonical, current) = apply_canonical_field_edit(
        &sdk.canonical,
        &sdk.initial,
        &CanonicalFieldEdit::Replace {
            path: "chat.tools[0].tools[1].parameters".to_string(),
            value: json!({
                "type": "object",
                "properties": {"cmd": {"type": "string"}, "cwd": {"type": "string"}}
            }),
        },
    )
    .expect("registered schema replace");

    let (wire, mappings) = chat_emit(&canonical, &sdk.pair, &current);
    assert_eq!(
        chat_tool_names(&wire),
        vec!["functions__apply_patch", "functions__exec"]
    );
    assert_eq!(mappings.len(), 2);
    assert_eq!(
        mapping_at(&mappings, "tools[0]").declaration_record_id,
        patch.record_id
    );
    assert_eq!(
        mapping_at(&mappings, "tools[1]").declaration_record_id,
        exec.record_id
    );
    assert_eq!(
        wire["tools"][1]["function"]["parameters"]["properties"]["cwd"]["type"], "string",
        "the emitter must read the current schema, not the original value"
    );
}

#[test]
fn registered_edits_leave_the_original_pair_and_canonical_unchanged() {
    let sdk = sdk_request("consumer-pair-immutable", namespace_pair_raw());
    let original_canonical = sdk.canonical.clone();
    let original_inverse = sdk.pair.inverse_context.clone();
    let original_history = sdk.pair.explicit_history_pairing.clone();

    let (edited, current) = apply_canonical_field_edit(
        &sdk.canonical,
        &sdk.initial,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        },
    )
    .expect("registered removal");
    let _ = current;

    assert_ne!(edited, sdk.canonical, "the edit returns new data");
    assert_eq!(
        sdk.canonical, original_canonical,
        "the caller's canonical must not be mutated in place"
    );
    assert_eq!(
        sdk.canonical["tools"][0]["tools"].as_array().unwrap().len(),
        2,
        "the removed declaration stays on the original canonical"
    );
    let pair = sdk.handle.original_pair().unwrap();
    assert_eq!(pair.inverse_context, original_inverse);
    assert_eq!(pair.explicit_history_pairing, original_history);
}

#[test]
fn surviving_exec_maps_on_chat_and_responses_and_reverses_to_original_identity() {
    let sdk = sdk_request("consumer-round-trip", namespace_pair_raw());
    let exec = declaration_at(&sdk.pair, "request.tools[0].tools[1]");
    let (canonical, current) = apply_canonical_field_edit(
        &sdk.canonical,
        &sdk.initial,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        },
    )
    .expect("registered removal of the preceding declaration");

    // Chat standard wire: the surviving exec keeps its real origin and actual destination.
    let (chat_wire, chat_mappings) = chat_emit(&canonical, &sdk.pair, &current);
    assert_eq!(chat_tool_names(&chat_wire), vec!["functions__exec"]);
    assert_eq!(chat_mappings.len(), 1);
    assert_eq!(chat_mappings[0].destination_path, "tools[0]");
    assert_eq!(chat_mappings[0].source_path, "request.tools[0].tools[1]");
    assert_eq!(chat_mappings[0].declaration_record_id, exec.record_id);
    assert_eq!(
        chat_mappings[0].emitted_name.as_deref(),
        Some("functions__exec")
    );

    // Responses standard wire: the current Responses declaration owner emits
    // the flat provider-facing child and records that actual destination.
    let (responses_wire, responses_mappings) = responses_emit(&canonical, &sdk.pair, &current);
    assert_eq!(responses_wire["tools"][0]["type"], "function");
    assert_eq!(responses_wire["tools"][0]["name"], "functions__exec");
    assert_eq!(responses_mappings.len(), 1);
    assert_eq!(responses_mappings[0].destination_path, "tools[0]");
    assert_eq!(
        responses_mappings[0].source_path,
        "request.tools[0].tools[1]"
    );
    assert_eq!(responses_mappings[0].declaration_record_id, exec.record_id);
    assert_eq!(responses_mappings[0].emitted_name.as_deref(), Some("functions__exec"));
    assert_eq!(responses_mappings[0].emitted_namespace, None);

    // Bind the real emitted Chat name + actual mapping into a real successful attempt.
    let attempt = AttemptContext {
        attempt_id: "consumer-round-trip-attempt".to_string(),
        projection: AttemptProjectionContext {
            attempt_id: "consumer-round-trip-attempt".to_string(),
            provider_protocol: "openai-chat".to_string(),
            provider_model: "provider-model".to_string(),
            paths: Vec::new(),
        },
        declarations: AttemptDeclarationMap {
            attempt_id: "consumer-round-trip-attempt".to_string(),
            provider_protocol: "openai-chat".to_string(),
            provider_model: "provider-model".to_string(),
            tool_mappings: chat_mappings.clone(),
        },
    };
    sdk.handle
        .record_failed_attempt("consumer-stale-attempt", "provider 500")
        .expect("record stale failed attempt");
    sdk.handle
        .publish_successful_attempt(attempt.clone())
        .expect("publish successful attempt");
    let view = ResponseProjectionView::from_successful_attempt(&sdk.handle, &attempt)
        .expect("successful attempt view");

    let emitted_name = chat_mappings[0]
        .emitted_name
        .clone()
        .expect("surviving exec emitted name");
    let full_arguments = "{\"cmd\":\"printf '%s\\n' 'complete command'\",\"cwd\":\"/tmp\"}";
    let provider_response = json!({
        "id": "chatcmpl-consumer-round-trip",
        "object": "chat.completion",
        "created": 1,
        "model": "provider-model",
        "choices": [{
            "index": 0,
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call-exec",
                    "type": "function",
                    "function": {"name": emitted_name, "arguments": full_arguments}
                }]
            }
        }]
    });
    let response = project_v3_openai_chat_response_as_responses_with_successful_attempt(
        &provider_response,
        &view,
    )
    .expect("public Chat response inverse");
    let output = response["output"].as_array().expect("responses output");
    assert_eq!(output.len(), 1);
    assert_eq!(output[0]["type"], "function_call");
    assert_eq!(
        output[0]["name"], "exec",
        "the original client tool name must be restored, not the emitted alias"
    );
    assert_eq!(output[0]["namespace"], "functions");
    assert_eq!(output[0]["call_id"], "call-exec");
    assert_eq!(
        output[0]["arguments"], full_arguments,
        "the complete argument bytes must round-trip unchanged"
    );
}
