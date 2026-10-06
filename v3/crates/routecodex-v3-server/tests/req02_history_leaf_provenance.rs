use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn normalize(protocol: &str, request_id: &str, raw: Value) -> (Value, RequestScopedContextPair) {
    let handle = V3RequestContextHandle::new(request_id.to_string(), protocol.to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}-invocation"),
        format!("{request_id}-attempt"),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw)
        .expect("public capture entry must accept the real client JSON value");
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public normalize entry must execute the real REQ02 SDK slice");
    let pair = handle
        .original_pair()
        .expect("raw client entry must publish the original inverse/history pair");
    (canonical, pair)
}

fn assert_mapping(pair: &RequestScopedContextPair, source: &str, destination: &str) {
    assert!(
        pair.inverse_context
            .field_mappings
            .iter()
            .any(|mapping| mapping.source_path == source && mapping.destination == destination),
        "missing concrete history leaf association {source} -> {destination}"
    );
}

fn assert_no_wildcard_history_destinations(pair: &RequestScopedContextPair) {
    for mapping in &pair.inverse_context.field_mappings {
        if mapping.destination.starts_with("chat.messages") {
            assert!(
                !mapping.destination.contains("[]"),
                "history destination must be concrete: {} -> {}",
                mapping.source_path,
                mapping.destination
            );
        }
    }
}

#[test]
fn chat_history_leaves_use_emitted_message_part_and_call_indices() {
    let exec_arguments = format!(
        "printf '%s' '{}{}'",
        "x".repeat(70_000),
        "REQ02_CHAT_EXEC_TAIL"
    );
    let patch = "*** Begin Patch\n*** Update File: src/lib.rs\n+freeform\n*** End Patch\n";
    let (canonical, pair) = normalize(
        "openai-chat",
        "req02-history-chat",
        json!({
            "model": "chat-model",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "first part"},
                        {"type": "text", "text": "second part", "vendor.name[0]": {"keep": true}}
                    ]
                },
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "id": "call-exec",
                            "type": "function",
                            "namespace": "mcp.search",
                            "function": {"name": "exec", "arguments": exec_arguments.clone()}
                        },
                        {
                            "id": "call-patch",
                            "type": "custom",
                            "namespace": "server",
                            "custom": {"name": "apply_patch", "input": patch}
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call-exec",
                    "content": "complete exec result"
                }
            ]
        }),
    );

    assert_eq!(canonical["messages"][0]["content"][0]["type"], "text");
    assert_eq!(
        canonical["messages"][0]["content"][1]["text"],
        "second part"
    );
    assert_eq!(
        canonical["messages"][0]["content"][1]["vendor.name[0]"],
        json!({"keep": true})
    );
    assert_eq!(
        canonical["messages"][1]["tool_calls"][0]["function"]["arguments"],
        exec_arguments
    );
    assert_eq!(
        canonical["messages"][1]["tool_calls"][1]["custom"]["input"],
        patch
    );
    assert_eq!(canonical["messages"][2]["content"], "complete exec result");

    assert_mapping(
        &pair,
        "request.messages[0].content[0].type",
        "chat.messages[0].content[0].type",
    );
    assert_mapping(
        &pair,
        "request.messages[0].content[1].text",
        "chat.messages[0].content[1].text",
    );
    assert_mapping(
        &pair,
        r#"request.messages[0].content[1]["vendor.name[0]"]"#,
        r#"chat.messages[0].content[1]["vendor.name[0]"]"#,
    );
    assert_mapping(
        &pair,
        "request.messages[1].tool_calls[0].id",
        "chat.messages[1].tool_calls[0].id",
    );
    assert_mapping(
        &pair,
        "request.messages[1].tool_calls[0].namespace",
        "chat.messages[1].tool_calls[0].namespace",
    );
    assert_mapping(
        &pair,
        "request.messages[1].tool_calls[0].function.arguments",
        "chat.messages[1].tool_calls[0].function.arguments",
    );
    assert_mapping(
        &pair,
        "request.messages[1].tool_calls[1].custom.input",
        "chat.messages[1].tool_calls[1].custom.input",
    );
    assert_mapping(
        &pair,
        "request.messages[2].tool_call_id",
        "chat.messages[2].tool_call_id",
    );
    assert_mapping(
        &pair,
        "request.messages[2].content",
        "chat.messages[2].content",
    );
    assert_no_wildcard_history_destinations(&pair);
}

#[test]
fn responses_history_leaves_use_post_fold_and_instruction_shifted_indices() {
    let (canonical, pair) = normalize(
        "responses",
        "req02-history-responses",
        json!({
            "model": "responses-model",
            "instructions": "system prefix",
            "messages": [{"role": "user", "content": "primary history"}],
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "secondary first"},
                        {"type": "input_text", "text": "secondary second"}
                    ]
                },
                {
                    "type": "function_call",
                    "call_id": "call-find",
                    "namespace": "mcp.search",
                    "name": "find",
                    "arguments": "{\"query\":\"complete\"}"
                },
                {
                    "type": "custom_tool_call",
                    "call_id": "call-patch",
                    "namespace": "server",
                    "name": "apply_patch",
                    "input": "*** Begin Patch\n*** End Patch\n"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call-find",
                    "output": "complete result"
                }
            ]
        }),
    );

    assert_eq!(canonical["messages"][0]["content"], "system prefix");
    assert_eq!(canonical["messages"][1]["content"], "primary history");
    assert_eq!(
        canonical["messages"][2]["content"][1]["text"],
        "secondary second"
    );
    assert_eq!(
        canonical["messages"][3]["tool_calls"][0]["function"]["name"],
        "mcp.search__find"
    );
    assert_eq!(
        canonical["messages"][4]["tool_calls"][0]["custom"]["name"],
        "server.apply_patch"
    );
    assert_eq!(canonical["messages"][5]["content"], "complete result");

    assert_mapping(&pair, "request.instructions", "chat.messages[0].content");
    assert_mapping(&pair, "request.messages[0]", "chat.messages[1]");
    assert_mapping(
        &pair,
        "request.input[0].content[0].type",
        "chat.messages[2].content[0].type",
    );
    assert_mapping(
        &pair,
        "request.input[0].content[1].text",
        "chat.messages[2].content[1].text",
    );
    assert_mapping(
        &pair,
        "request.input[1].call_id",
        "chat.messages[3].tool_calls[0].id",
    );
    assert_mapping(
        &pair,
        "request.input[1].namespace",
        "chat.messages[3].tool_calls[0].function.name",
    );
    assert_mapping(
        &pair,
        "request.input[1].arguments",
        "chat.messages[3].tool_calls[0].function.arguments",
    );
    assert_mapping(
        &pair,
        "request.input[2].input",
        "chat.messages[4].tool_calls[0].custom.input",
    );
    assert_mapping(&pair, "request.input[3].output", "chat.messages[5].content");
    assert_no_wildcard_history_destinations(&pair);
}

#[test]
fn anthropic_history_leaves_use_emitted_tool_and_result_messages() {
    let exec_arguments = json!({
        "cmd": "printf '%s' 'complete anthropic exec'",
        "nested": {"keep": [null, 1]}
    });
    let result = "first line\r\nsecond line\r\ncomplete result";
    let (canonical, pair) = normalize(
        "anthropic",
        "req02-history-anthropic",
        json!({
            "model": "claude",
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "calling"},
                        {
                            "type": "tool_use",
                            "id": "toolu-exec",
                            "name": "exec",
                            "input": exec_arguments.clone()
                        }
                    ]
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu-exec",
                            "content": result
                        }
                    ]
                }
            ]
        }),
    );

    assert_eq!(canonical["messages"][0]["content"][0]["text"], "calling");
    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["function"]["arguments"],
        exec_arguments
    );
    assert_eq!(canonical["messages"][2]["tool_call_id"], "toolu-exec");
    assert_eq!(canonical["messages"][2]["content"], result);

    assert_mapping(
        &pair,
        "request.messages[0].content[0].type",
        "chat.messages[0].content[0].type",
    );
    assert_mapping(
        &pair,
        "request.messages[0].content[0].text",
        "chat.messages[0].content[0].text",
    );
    assert_mapping(
        &pair,
        "request.messages[0].content[1].id",
        "chat.messages[0].tool_calls[0].id",
    );
    assert_mapping(
        &pair,
        "request.messages[0].content[1].name",
        "chat.messages[0].tool_calls[0].function.name",
    );
    assert_mapping(
        &pair,
        "request.messages[0].content[1].input",
        "chat.messages[0].tool_calls[0].function.arguments",
    );
    assert_mapping(
        &pair,
        "request.messages[1].content[0].tool_use_id",
        "chat.messages[2].tool_call_id",
    );
    assert_mapping(
        &pair,
        "request.messages[1].content[0].content",
        "chat.messages[2].content",
    );
    assert_no_wildcard_history_destinations(&pair);
}

#[test]
fn gemini_history_leaves_use_emitted_message_and_call_indices() {
    let args = json!({"query": "complete mcp arguments", "nested": [null, {"keep": true}]});
    let response = json!({"output": "complete mcp result", "nested": [1, 2, 3]});
    let (canonical, pair) = normalize(
        "gemini",
        "req02-history-gemini",
        json!({
            "model": "gemini-model",
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": "first"},
                        {"vendor.name[0]": {"keep": true}}
                    ]
                },
                {
                    "role": "model",
                    "parts": [{
                        "functionCall": {
                            "id": "call-find",
                            "name": "find",
                            "args": args.clone()
                        }
                    }]
                },
                {
                    "role": "user",
                    "parts": [{
                        "functionResponse": {
                            "id": "call-find",
                            "response": response.clone()
                        }
                    }]
                }
            ]
        }),
    );

    assert_eq!(canonical["messages"][0]["content"][0]["text"], "first");
    assert_eq!(
        canonical["messages"][0]["content"][1]["vendor.name[0]"],
        json!({"keep": true})
    );
    assert_eq!(
        canonical["messages"][1]["tool_calls"][0]["function"]["arguments"],
        args
    );
    assert_eq!(canonical["messages"][3]["tool_call_id"], "call-find");
    assert_eq!(canonical["messages"][3]["content"], response);

    assert_mapping(
        &pair,
        "request.contents[0].parts[0].text",
        "chat.messages[0].content[0].text",
    );
    assert_mapping(
        &pair,
        r#"request.contents[0].parts[1]["vendor.name[0]"]"#,
        r#"chat.messages[0].content[1]["vendor.name[0]"]"#,
    );
    assert_mapping(
        &pair,
        "request.contents[1].parts[0].functionCall.id",
        "chat.messages[1].tool_calls[0].id",
    );
    assert_mapping(
        &pair,
        "request.contents[1].parts[0].functionCall.name",
        "chat.messages[1].tool_calls[0].function.name",
    );
    assert_mapping(
        &pair,
        "request.contents[1].parts[0].functionCall.args",
        "chat.messages[1].tool_calls[0].function.arguments",
    );
    assert_mapping(
        &pair,
        "request.contents[2].parts[0].functionResponse.id",
        "chat.messages[3].tool_call_id",
    );
    assert_mapping(
        &pair,
        "request.contents[2].parts[0].functionResponse.response",
        "chat.messages[3].content",
    );
    assert_no_wildcard_history_destinations(&pair);
}

#[test]
fn repeated_equivalent_results_are_remapped_to_their_emitted_occurrences_once() {
    let result = "same complete result";
    let (canonical, pair) = normalize(
        "responses",
        "req02-history-repeated-results",
        json!({
            "instructions": "system prefix",
            "messages": [{
                "role": "tool",
                "tool_call_id": "call-repeat",
                "content": result
            }],
            "input": [
                {"type": "function_call_output", "call_id": "call-repeat", "output": result},
                {"type": "function_call_output", "call_id": "call-repeat", "output": result}
            ]
        }),
    );

    assert_eq!(canonical["messages"].as_array().unwrap().len(), 3);
    assert_eq!(canonical["messages"][1]["content"], result);
    assert_eq!(canonical["messages"][2]["content"], result);

    assert_mapping(
        &pair,
        "request.messages[0].tool_call_id",
        "chat.messages[1].tool_call_id",
    );
    assert_mapping(
        &pair,
        "request.input[0].call_id",
        "chat.messages[1].tool_call_id",
    );
    assert_mapping(
        &pair,
        "request.input[1].call_id",
        "chat.messages[2].tool_call_id",
    );
    assert_mapping(
        &pair,
        "request.messages[0].content",
        "chat.messages[1].content",
    );
    assert_mapping(&pair, "request.input[0].output", "chat.messages[1].content");
    assert_mapping(&pair, "request.input[1].output", "chat.messages[2].content");
    assert_no_wildcard_history_destinations(&pair);
}
