use super::{
    project_v3_openai_chat_response_as_responses_with_successful_attempt,
    restore_v3_responses_provider_representation_tool_identities_with_successful_attempt,
};
use crate::hub_v1::{
    build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations,
    V3HubProviderWireProtocol,
};
use crate::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, AttemptContext,
    AttemptDeclarationMap, AttemptProjectionContext, CurrentFieldAssociations,
    RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind, ResponseProjectionView,
    ToolDeclarationReference, V3RequestContextHandle,
};
use serde_json::{json, Value};

struct Fixture {
    canonical_before_emission: Value,
    wire: Value,
    view: ResponseProjectionView,
}

fn fixture() -> Fixture {
    fixture_from_raw(json!({
        "model": "client-model",
        "input": [{
            "role": "user",
            "content": "exercise typed tool identity"
        }],
        "tools": [
            {
                "type": "namespace",
                "name": "functions",
                "tools": [
                    {
                        "type": "custom",
                        "name": "apply_patch",
                        "format": {"type": "text"}
                    }
                ]
            },
            {
                "type": "function",
                "name": "exec_command",
                "parameters": {
                    "type": "object",
                    "properties": {"cmd": {"type": "string"}}
                }
            },
            {
                "type": "namespace",
                "name": "mcp.search",
                "tools": [{
                    "type": "function",
                    "name": "find",
                    "parameters": {
                        "type": "object",
                        "properties": {"q": {"type": "string"}}
                    }
                }]
            },
            {
                "type": "namespace",
                "name": "other",
                "tools": [{
                    "type": "function",
                    "name": "find",
                    "parameters": {
                        "type": "object",
                        "properties": {"q": {"type": "string"}}
                    }
                }]
            },
            {
                "type": "function",
                "name": "missing_namespace",
                "parameters": {
                    "type": "object",
                    "properties": {"x": {"type": "string"}}
                }
            },
            {
                "type": "function",
                "name": "null_namespace",
                "namespace": null,
                "parameters": {
                    "type": "object",
                    "properties": {"y": {"type": "string"}}
                }
            },
            {
                "type": "function",
                "name": "empty_namespace",
                "namespace": "",
                "parameters": {
                    "type": "object",
                    "properties": {"z": {"type": "string"}}
                }
            }
        ]
    }))
}

fn collision_fixture() -> Fixture {
    fixture_from_raw(json!({
        "model": "client-model",
        "input": [{
            "role": "user",
            "content": "exercise cross-declaration emitted-name collision"
        }],
        "tools": [
            {
                "type": "function",
                "name": "collision",
                "parameters": {
                    "type": "object",
                    "properties": {"top": {"type": "string"}}
                }
            },
            {
                "type": "namespace",
                "name": "ns",
                "tools": [{
                    "type": "function",
                    "name": "collision",
                    "parameters": {
                        "type": "object",
                        "properties": {"nested": {"type": "string"}}
                    }
                }]
            }
        ]
    }))
}

fn fixture_from_raw(raw: Value) -> Fixture {
    let handle =
        V3RequestContextHandle::new("req-chat-response".to_string(), "responses".to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "invocation-chat-response".to_string(),
        "attempt-success".to_string(),
        RequestOriginKind::ClientEntry,
    );
    let captured =
        execute_v3_operation_runner_request_capture_client_json(raw).expect("real public capture");
    let mut canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("real SDK normalize");
    let pair = handle.original_pair().expect("published inverse pair");
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);

    if let Some(tools) = canonical.get_mut("tools").and_then(Value::as_array_mut) {
        if let Some(tool) = tools.get_mut(1).and_then(Value::as_object_mut) {
            if tool.get("type").and_then(Value::as_str) == Some("function") {
                tool.insert(
                    "parameters".to_string(),
                    json!({"type": "object", "properties": {}}),
                );
            }
        }
        if let Some(tool) = tools
            .get_mut(2)
            .and_then(Value::as_object_mut)
            .and_then(|tool| tool.get_mut("tools"))
            .and_then(Value::as_array_mut)
            .and_then(|tools| tools.get_mut(0))
            .and_then(Value::as_object_mut)
        {
            tool.insert(
                "parameters".to_string(),
                json!({"type": "object", "properties": {}}),
            );
        }
    }
    let canonical_before_emission = canonical.clone();

    let (wire, mappings) =
        build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations(
            &canonical,
            &pair.inverse_context,
            &current,
        )
        .expect("standard Chat emitter");
    assert_eq!(
        canonical, canonical_before_emission,
        "standard projection must not mutate the current canonical"
    );

    let attempt = AttemptContext {
        attempt_id: "attempt-success".to_string(),
        projection: AttemptProjectionContext {
            attempt_id: "attempt-success".to_string(),
            provider_protocol: "openai-chat".to_string(),
            provider_model: "provider-model".to_string(),
            paths: Vec::new(),
        },
        declarations: AttemptDeclarationMap {
            attempt_id: "attempt-success".to_string(),
            provider_protocol: "openai-chat".to_string(),
            provider_model: "provider-model".to_string(),
            tool_mappings: mappings,
        },
    };
    handle
        .record_failed_attempt("attempt-failed", "stale provider attempt")
        .expect("record stale failed attempt");
    handle
        .publish_successful_attempt(attempt.clone())
        .expect("publish successful attempt");
    let view = ResponseProjectionView::from_successful_attempt(&handle, &attempt)
        .expect("successful attempt view");

    Fixture {
        canonical_before_emission,
        wire,
        view,
    }
}

fn declaration<'a>(
    view: &'a ResponseProjectionView,
    source_path: &str,
) -> &'a ToolDeclarationReference {
    view.request_inverse_context()
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == source_path)
        .unwrap_or_else(|| panic!("missing declaration for {source_path}"))
}

fn emitted_name(view: &ResponseProjectionView, source_path: &str) -> String {
    let declaration = declaration(view, source_path);
    view.attempt()
        .declarations
        .tool_mappings
        .iter()
        .find(|mapping| mapping.declaration_record_id == declaration.record_id)
        .and_then(|mapping| mapping.emitted_name.clone())
        .unwrap_or_else(|| panic!("missing emitted mapping for {source_path}"))
}

fn provider_response(fixture: &Fixture) -> Value {
    let patch = "*** Begin Patch\n*** Add File: /tmp/typed-identity\n+literal $() and `bytes`\n*** End Patch\n";
    let exec_arguments = "{\"cmd\":\"printf '%s\\n' 'complete command'\",\"cwd\":\"/tmp\"}";
    let mcp_arguments = "{\"q\":\"mcp\"}";
    let other_arguments = "{\"q\":\"other\"}";
    let missing_arguments = "{\"x\":\"missing\"}";
    let null_arguments = "{\"y\":\"null\"}";
    let empty_arguments = "{\"z\":\"empty\"}";

    json!({
        "id": "chatcmpl-typed-identity",
        "object": "chat.completion",
        "created": 1,
        "model": "provider-model",
        "choices": [{
            "index": 0,
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [
                    {
                        "id": "call-apply-patch",
                        "type": "function",
                        "function": {
                            "name": emitted_name(&fixture.view, "request.tools[0].tools[0]"),
                            "arguments": json!({"input": patch}).to_string()
                        }
                    },
                    {
                        "id": "call-exec-command",
                        "type": "function",
                        "function": {
                            "name": emitted_name(&fixture.view, "request.tools[1]"),
                            "arguments": exec_arguments
                        }
                    },
                    {
                        "id": "call-mcp-find",
                        "type": "function",
                        "function": {
                            "name": emitted_name(&fixture.view, "request.tools[2].tools[0]"),
                            "arguments": mcp_arguments
                        }
                    },
                    {
                        "id": "call-other-find",
                        "type": "function",
                        "function": {
                            "name": emitted_name(&fixture.view, "request.tools[3].tools[0]"),
                            "arguments": other_arguments
                        }
                    },
                    {
                        "id": "call-missing-namespace",
                        "type": "function",
                        "function": {
                            "name": emitted_name(&fixture.view, "request.tools[4]"),
                            "arguments": missing_arguments
                        }
                    },
                    {
                        "id": "call-null-namespace",
                        "type": "function",
                        "function": {
                            "name": emitted_name(&fixture.view, "request.tools[5]"),
                            "arguments": null_arguments
                        }
                    },
                    {
                        "id": "call-empty-namespace",
                        "type": "function",
                        "function": {
                            "name": emitted_name(&fixture.view, "request.tools[6]"),
                            "arguments": empty_arguments
                        }
                    },
                    {
                        "id": "call-unknown",
                        "type": "function",
                        "function": {
                            "name": "unknown_emitted_name",
                            "arguments": "{\"unknown\":true}"
                        }
                    }
                ]
            }
        }],
        "usage": {
            "prompt_tokens": 1,
            "completion_tokens": 1,
            "total_tokens": 2
        }
    })
}

fn native_custom_provider_response(fixture: &Fixture, call_id: &str, input: &str) -> Value {
    let name = emitted_name(&fixture.view, "request.tools[0].tools[0]");
    json!({
        "id": "chatcmpl-native-custom",
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
                    "id": call_id,
                    "type": "custom",
                    "custom": {
                        "name": name,
                        "input": input
                    }
                }]
            }
        }]
    })
}

fn assert_native_custom_input_round_trips(input: &str) {
    let fixture = fixture();
    let response = project_v3_openai_chat_response_as_responses_with_successful_attempt(
        &native_custom_provider_response(&fixture, "call-native-custom", input),
        &fixture.view,
    )
    .expect("native custom response projection");
    let output = response["output"].as_array().expect("response output");
    assert_eq!(output.len(), 1);
    assert_eq!(output[0]["type"], "custom_tool_call");
    assert_eq!(output[0]["name"], "apply_patch");
    assert_eq!(output[0]["namespace"], "functions");
    assert_eq!(output[0]["call_id"], "call-native-custom");
    assert_eq!(output[0]["input"].as_str(), Some(input));
}

#[test]
fn req02_chat_successful_attempt_restores_original_identity() {
    let fixture = fixture();
    assert_eq!(
        fixture.canonical_before_emission["tools"][1]["parameters"],
        json!({"type": "object", "properties": {}})
    );
    assert_eq!(
        fixture.canonical_before_emission["tools"][2]["tools"][0]["parameters"],
        json!({"type": "object", "properties": {}})
    );

    assert!(
        fixture
            .wire
            .get("tools")
            .and_then(Value::as_array)
            .is_some(),
        "the real standard emitter must return provider declarations"
    );
    let response = project_v3_openai_chat_response_as_responses_with_successful_attempt(
        &provider_response(&fixture),
        &fixture.view,
    )
    .expect("successful-attempt response projection");
    let output = response["output"].as_array().expect("response output");
    assert_eq!(output.len(), 8);

    assert_eq!(output[0]["type"], "custom_tool_call");
    assert_eq!(output[0]["name"], "apply_patch");
    assert_eq!(output[0]["namespace"], "functions");
    assert_eq!(output[0]["call_id"], "call-apply-patch");
    assert_eq!(
        output[0]["input"],
        "*** Begin Patch\n*** Add File: /tmp/typed-identity\n+literal $() and `bytes`\n*** End Patch\n"
    );

    assert_eq!(output[1]["type"], "function_call");
    assert_eq!(output[1]["name"], "exec_command");
    assert!(output[1].get("namespace").is_none());
    assert_eq!(
        output[1]["arguments"],
        "{\"cmd\":\"printf '%s\\n' 'complete command'\",\"cwd\":\"/tmp\"}"
    );

    assert_eq!(output[2]["type"], "function_call");
    assert_eq!(output[2]["name"], "find");
    assert_eq!(output[2]["namespace"], "mcp.search");
    assert_eq!(output[2]["arguments"], "{\"q\":\"mcp\"}");

    assert_eq!(output[3]["type"], "function_call");
    assert_eq!(output[3]["name"], "find");
    assert_eq!(output[3]["namespace"], "other");
    assert_eq!(output[3]["arguments"], "{\"q\":\"other\"}");

    assert_eq!(output[4]["type"], "function_call");
    assert_eq!(output[4]["name"], "missing_namespace");
    assert!(output[4].get("namespace").is_none());
    assert_eq!(output[4]["arguments"], "{\"x\":\"missing\"}");

    assert_eq!(output[5]["type"], "function_call");
    assert_eq!(output[5]["name"], "null_namespace");
    assert_eq!(output[5]["namespace"], Value::Null);
    assert_eq!(output[5]["arguments"], "{\"y\":\"null\"}");

    assert_eq!(output[6]["type"], "function_call");
    assert_eq!(output[6]["name"], "empty_namespace");
    assert_eq!(output[6]["namespace"], "");
    assert_eq!(output[6]["arguments"], "{\"z\":\"empty\"}");

    assert_eq!(output[7]["type"], "function_call");
    assert_eq!(output[7]["name"], "unknown_emitted_name");
    assert_eq!(output[7]["arguments"], "{\"unknown\":true}");
}

#[test]
fn req02_chat_native_custom_json_object_literal_input_is_preserved() {
    assert_native_custom_input_round_trips("{\"other\":1}");
}

#[test]
fn req02_chat_native_custom_empty_input_is_preserved() {
    assert_native_custom_input_round_trips("");
}

#[test]
fn req02_chat_native_custom_surrounding_whitespace_is_preserved() {
    assert_native_custom_input_round_trips(" \r\n\t{\"other\":1}\n ");
}

#[test]
fn req02_chat_native_custom_crlf_patch_input_is_preserved() {
    assert_native_custom_input_round_trips(
        "*** Begin Patch\r\n*** Update File: /tmp/typed-identity\r\n@@\r\n-old\r\n+new\r\n*** End Patch\r\n",
    );
}

#[test]
fn req02_chat_native_custom_exec_long_input_is_preserved() {
    let input = format!("printf '%s' '{}'\r\n", "x".repeat(4096));
    assert_native_custom_input_round_trips(&input);
}

#[test]
fn req02_responses_provider_restore_preserves_siblings_and_namespace_presence() {
    let fixture = fixture();
    let patch = "*** Begin Patch\n*** Add File: /tmp/restored-identity\n+literal $() and `bytes`\n*** End Patch\n";
    let mut provider_value = json!({
        "id": "resp_provider",
        "output": [
            {
                "id": "item_patch",
                "type": "function_call",
                "call_id": "call_patch",
                "name": emitted_name(&fixture.view, "request.tools[0].tools[0]"),
                "arguments": json!({"input": patch}).to_string(),
                "namespace": "provider-namespace",
                "status": "completed",
                "unknown_sibling": {"keep": true}
            },
            {
                "id": "item_missing_namespace",
                "type": "function_call",
                "call_id": "call_missing_namespace",
                "name": emitted_name(&fixture.view, "request.tools[4]"),
                "arguments": "{\"x\":\"missing\"}",
                "namespace": "provider-namespace",
                "status": "completed",
                "unknown_sibling": "missing"
            },
            {
                "id": "item_null_namespace",
                "type": "function_call",
                "call_id": "call_null_namespace",
                "name": emitted_name(&fixture.view, "request.tools[5]"),
                "arguments": "{\"y\":\"null\"}",
                "namespace": "provider-namespace"
            },
            {
                "id": "item_empty_namespace",
                "type": "function_call",
                "call_id": "call_empty_namespace",
                "name": emitted_name(&fixture.view, "request.tools[6]"),
                "arguments": "{\"z\":\"empty\"}",
                "namespace": "provider-namespace"
            },
            {
                "id": "item_unknown",
                "type": "function_call",
                "call_id": "call_unknown",
                "name": "unknown_emitted_name",
                "arguments": "{\"unknown\":true}",
                "status": "completed",
                "unknown_sibling": "keep"
            }
        ]
    });
    let unknown_before = provider_value["output"][4].clone();

    restore_v3_responses_provider_representation_tool_identities_with_successful_attempt(
        &mut provider_value,
        &fixture.view,
        V3HubProviderWireProtocol::Responses,
    )
    .expect("Responses provider representation restore");

    let output = provider_value["output"]
        .as_array()
        .expect("response output");
    assert_eq!(output[0]["type"], "custom_tool_call");
    assert_eq!(output[0]["name"], "apply_patch");
    assert_eq!(output[0]["namespace"], "functions");
    assert_eq!(output[0]["input"], patch);
    assert!(output[0].get("arguments").is_none());
    assert_eq!(output[0]["id"], "item_patch");
    assert_eq!(output[0]["call_id"], "call_patch");
    assert_eq!(output[0]["status"], "completed");
    assert_eq!(output[0]["unknown_sibling"], json!({"keep": true}));

    assert_eq!(output[1]["type"], "function_call");
    assert_eq!(output[1]["name"], "missing_namespace");
    assert!(output[1].get("namespace").is_none());
    assert_eq!(output[1]["id"], "item_missing_namespace");
    assert_eq!(output[1]["status"], "completed");
    assert_eq!(output[1]["unknown_sibling"], "missing");

    assert_eq!(output[2]["type"], "function_call");
    assert_eq!(output[2]["name"], "null_namespace");
    assert_eq!(output[2]["namespace"], Value::Null);

    assert_eq!(output[3]["type"], "function_call");
    assert_eq!(output[3]["name"], "empty_namespace");
    assert_eq!(output[3]["namespace"], "");

    assert_eq!(output[4], unknown_before);
}

#[test]
fn req02_anthropic_already_inversed_output_skips_provider_representation_restore() {
    let fixture = collision_fixture();
    let mut provider_value = json!({
        "id": "resp_anthropic",
        "output": [{
            "id": "item_nested_collision",
            "type": "function_call",
            "call_id": "call_nested_collision",
            "name": "collision",
            "namespace": "ns",
            "arguments": "{\"nested\":\"keep\"}",
            "status": "completed",
            "unknown_sibling": {"keep": true}
        }]
    });
    let already_inversed = provider_value.clone();

    restore_v3_responses_provider_representation_tool_identities_with_successful_attempt(
        &mut provider_value,
        &fixture.view,
        V3HubProviderWireProtocol::Anthropic,
    )
    .expect("already-inversed Anthropic output must be left unchanged");

    assert_eq!(provider_value, already_inversed);
}
