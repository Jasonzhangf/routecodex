use super::bridge_input::convert_bridge_input_to_chat_messages;
use super::history::{
    apply_bridge_capture_tool_results, apply_bridge_ensure_tool_placeholders,
    apply_bridge_normalize_history, build_bridge_history, ensure_bridge_output_fields,
    filter_bridge_input_for_upstream, normalize_bridge_history_seed,
    prepare_responses_request_envelope, resolve_responses_bridge_tools,
    resolve_responses_request_bridge_decisions,
};
use super::local_image::append_local_image_block_on_latest_user_input;
use super::metadata::{
    apply_bridge_ensure_system_instruction, apply_bridge_inject_system_instruction,
    apply_bridge_metadata_action,
};
use super::reasoning::{apply_bridge_reasoning_extract, apply_bridge_responses_output_reasoning};
use super::tool_ids::{apply_bridge_normalize_tool_identifiers, normalize_bridge_tool_call_ids};
use super::*;
use crate::hub_resp_outbound_client_semantics::normalize_responses_function_name;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

#[test]
fn normalizes_missing_tool_ids_with_pending_queue() {
    let input = NormalizeBridgeToolCallIdsInput {
        messages: vec![
            json!({
              "role": "assistant",
              "tool_calls": [
                {"type": "function", "function": {"name": "shell"}}
              ]
            }),
            json!({
              "role": "tool",
              "content": "ok"
            }),
        ],
        raw_request: None,
        captured_tool_results: None,
        id_prefix: Some("bridge_tool".to_string()),
    };
    let output = normalize_bridge_tool_call_ids(input);
    let call_obj = output.messages[0]
        .as_object()
        .and_then(|msg| msg.get("tool_calls"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap();
    assert_eq!(
        call_obj.get("id").and_then(|v| v.as_str()),
        Some("bridge_tool_1")
    );
    assert_eq!(
        call_obj.get("tool_call_id").and_then(|v| v.as_str()),
        Some("bridge_tool_1")
    );
    assert_eq!(
        call_obj.get("call_id").and_then(|v| v.as_str()),
        Some("bridge_tool_1")
    );
    let tool_message = output.messages[1].as_object().unwrap();
    assert_eq!(
        tool_message.get("tool_call_id").and_then(|v| v.as_str()),
        Some("bridge_tool_1")
    );
    assert_eq!(
        tool_message.get("call_id").and_then(|v| v.as_str()),
        Some("bridge_tool_1")
    );
}

#[test]
fn normalizes_raw_request_and_captured_results() {
    let input = NormalizeBridgeToolCallIdsInput {
        messages: vec![json!({
          "role": "assistant",
          "tool_calls": [{"id": "call_keep", "type": "function", "function": {"name": "keep"}}]
        })],
        raw_request: Some(json!({
          "tool_outputs": [{"tool_call_id": "call_keep", "output": "ok"}],
          "required_action": {
            "submit_tool_outputs": {
              "tool_calls": [{"call_id": "call_keep", "type": "function"}]
            }
          }
        })),
        captured_tool_results: Some(vec![json!({
          "call_id": "call_keep",
          "output": "done"
        })]),
        id_prefix: Some("bridge_tool".to_string()),
    };
    let output = normalize_bridge_tool_call_ids(input);
    let raw = output.raw_request.unwrap();
    let tool_output = raw
        .as_object()
        .and_then(|obj| obj.get("tool_outputs"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap();
    assert_eq!(
        tool_output.get("tool_call_id").and_then(|v| v.as_str()),
        Some("call_keep")
    );
    assert_eq!(
        tool_output.get("call_id").and_then(|v| v.as_str()),
        Some("call_keep")
    );
    let submit_call = raw
        .as_object()
        .and_then(|obj| obj.get("required_action"))
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.get("submit_tool_outputs"))
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.get("tool_calls"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap();
    assert_eq!(
        submit_call.get("id").and_then(|v| v.as_str()),
        Some("call_keep")
    );
    assert_eq!(
        submit_call.get("tool_call_id").and_then(|v| v.as_str()),
        Some("call_keep")
    );
    assert_eq!(
        submit_call.get("call_id").and_then(|v| v.as_str()),
        Some("call_keep")
    );
    let captured = output.captured_tool_results.unwrap();
    let first = captured[0].as_object().unwrap();
    assert_eq!(
        first.get("tool_call_id").and_then(|v| v.as_str()),
        Some("call_keep")
    );
    assert_eq!(
        first.get("call_id").and_then(|v| v.as_str()),
        Some("call_keep")
    );
}

#[test]
fn applies_bridge_normalize_tool_identifiers_openai_responses_inbound_trim() {
    let output = apply_bridge_normalize_tool_identifiers(
        ApplyBridgeNormalizeToolIdentifiersInput {
            stage: "request_inbound".to_string(),
            protocol: Some("openai-responses".to_string()),
            module_type: None,
            messages: vec![
                json!({
                  "role": "assistant",
                  "tool_calls": [{"id":"call_1","tool_call_id":"call_1","call_id":"call_1","type":"function"}]
                }),
                json!({
                  "role": "tool",
                  "tool_call_id": "call_1",
                  "call_id": "call_1",
                  "content": "ok"
                }),
            ],
            raw_request: None,
            captured_tool_results: None,
            id_prefix: None,
        },
    );
    let assistant_call = output.messages[0]
        .as_object()
        .and_then(|row| row.get("tool_calls"))
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(Value::as_object)
        .cloned()
        .unwrap();
    assert_eq!(
        assistant_call.get("id").and_then(Value::as_str),
        Some("call_1")
    );
    assert!(!assistant_call.contains_key("tool_call_id"));
    assert!(!assistant_call.contains_key("call_id"));
    let tool = output.messages[1].as_object().cloned().unwrap();
    assert_eq!(
        tool.get("tool_call_id").and_then(Value::as_str),
        Some("call_1")
    );
    assert!(!tool.contains_key("call_id"));
}

#[test]
fn builds_bridge_history_for_tool_turn() {
    let input = BuildBridgeHistoryInput {
        messages: vec![
            json!({"role":"system","content":"You are helpful."}),
            json!({"role":"user","content":"Run tool"}),
            json!({
              "role":"assistant",
              "tool_calls":[{"id":"call_1","function":{"name":"read","arguments":{"path":"a.txt"}}}]
            }),
            json!({"role":"tool","tool_call_id":"call_1","content":"ok"}),
        ],
        tools: None,
    };
    let output = build_bridge_history(input);
    assert_eq!(output.original_system_messages.len(), 1);
    assert_eq!(output.latest_user_instruction.as_deref(), Some("Run tool"));
    assert!(output.input.iter().any(|entry| {
        entry
            .as_object()
            .and_then(|row| row.get("type"))
            .and_then(|v| v.as_str())
            == Some("function_call")
    }));
    assert!(output.input.iter().any(|entry| {
        entry
            .as_object()
            .and_then(|row| row.get("type"))
            .and_then(|v| v.as_str())
            == Some("function_call_output")
    }));
}

#[test]
fn builds_bridge_history_uses_output_text_for_assistant_string_content() {
    let input = BuildBridgeHistoryInput {
        messages: vec![json!({
          "role":"assistant",
          "content":"Task complete"
        })],
        tools: None,
    };
    let output = build_bridge_history(input);
    assert_eq!(output.input.len(), 1);
    let entry = output.input[0].as_object().unwrap();
    assert_eq!(entry.get("role").and_then(Value::as_str), Some("assistant"));
    let content = entry.get("content").and_then(|v| v.as_array()).unwrap();
    assert_eq!(content[0]["type"].as_str(), Some("output_text"));
    assert_eq!(content[0]["text"].as_str(), Some("Task complete"));
}

#[test]
fn builds_bridge_history_with_media_blocks() {
    let input = BuildBridgeHistoryInput {
        messages: vec![json!({
          "role":"user",
          "content":[
            {"type":"text","text":"Check image"},
            {"type":"input_image","image_url":"https://x/y.png","detail":"high"}
          ]
        })],
        tools: None,
    };
    let output = build_bridge_history(input);
    assert_eq!(output.input.len(), 1);
    let entry = output.input[0].as_object().unwrap();
    let content = entry.get("content").and_then(|v| v.as_array()).unwrap();
    assert!(content.iter().any(|block| {
        block
            .as_object()
            .and_then(|row| row.get("type"))
            .and_then(|v| v.as_str())
            == Some("input_image")
    }));
    assert_eq!(content[0]["type"].as_str(), Some("input_text"));
    assert_eq!(content[1]["type"].as_str(), Some("input_image"));
}

#[test]
fn applies_bridge_normalize_history() {
    let output = apply_bridge_normalize_history(ApplyBridgeNormalizeHistoryInput {
        messages: vec![json!({
          "role": "assistant",
          "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "echo"}}]
        })],
        tools: None,
    });
    assert_eq!(output.messages.len(), 2);
    let tool_message = output.messages[1].as_object().cloned().unwrap();
    assert_eq!(
        tool_message.get("role").and_then(Value::as_str),
        Some("tool")
    );
    assert_eq!(
        tool_message.get("tool_call_id").and_then(Value::as_str),
        Some("call_1")
    );
    let bridge_history = output.bridge_history.unwrap();
    let bridge_input = bridge_history
        .as_object()
        .and_then(|row| row.get("input"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap();
    assert!(bridge_input.iter().any(|entry| {
        entry
            .as_object()
            .and_then(|row| row.get("type"))
            .and_then(Value::as_str)
            == Some("function_call")
    }));
    assert!(bridge_input.iter().any(|entry| {
        entry
            .as_object()
            .and_then(|row| row.get("type"))
            .and_then(Value::as_str)
            == Some("function_call_output")
    }));
}

#[test]
fn normalizes_bridge_history_seed_preserving_multimodal_order() {
    let seed = json!({
      "input": [
        {
          "role": "user",
          "content": [
            {"type": "input_text", "text": "first"},
            {"type": "input_image", "image_url": "https://x/y.png", "detail": "high"},
            {"type": "input_text", "text": "second"}
          ]
        }
      ],
      "combinedSystemInstruction": " system ",
      "latestUserInstruction": " user ",
      "originalSystemMessages": [" keep ", "", " second "]
    });
    let output = normalize_bridge_history_seed(&seed).unwrap();
    assert_eq!(
        output.combined_system_instruction.as_deref(),
        Some("system")
    );
    assert_eq!(output.latest_user_instruction.as_deref(), Some("user"));
    assert_eq!(output.original_system_messages, vec!["keep", "second"]);
    let content = output.input[0]
        .as_object()
        .and_then(|row| row.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap();
    assert_eq!(content.len(), 3);
    assert_eq!(
        content[0].get("type").and_then(Value::as_str),
        Some("input_text")
    );
    assert_eq!(
        content[1].get("type").and_then(Value::as_str),
        Some("input_image")
    );
    assert_eq!(
        content[1].get("image_url").and_then(Value::as_str),
        Some("https://x/y.png")
    );
    assert_eq!(
        content[2].get("type").and_then(Value::as_str),
        Some("input_text")
    );
}

#[test]
fn normalizes_bridge_history_seed_filters_empty_system_messages_and_preserves_text_order() {
    let seed = json!({
      "input": [
        {
          "role": "user",
          "content": [
            {"type": "input_text", "text": " alpha "},
            {"type": "input_image", "image_url": "https://x/y.png"},
            {"type": "input_text", "text": " beta "}
          ]
        }
      ],
      "combinedSystemInstruction": "  sys keep  ",
      "latestUserInstruction": "  user keep  ",
      "originalSystemMessages": ["  first  ", "   ", "", " second "]
    });
    let output = normalize_bridge_history_seed(&seed).unwrap();
    assert_eq!(output.original_system_messages, vec!["first", "second"]);
    assert_eq!(
        output.combined_system_instruction.as_deref(),
        Some("sys keep")
    );
    assert_eq!(output.latest_user_instruction.as_deref(), Some("user keep"));

    let content = output.input[0]
        .as_object()
        .and_then(|row| row.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap();
    assert_eq!(
        content[0].get("text").and_then(Value::as_str),
        Some(" alpha ")
    );
    assert_eq!(
        content[1].get("type").and_then(Value::as_str),
        Some("input_image")
    );
    assert_eq!(
        content[2].get("text").and_then(Value::as_str),
        Some(" beta ")
    );
}

#[test]
fn resolves_responses_bridge_tools_dedupes_by_function_name_and_preserves_builtin_web_search() {
    let output = resolve_responses_bridge_tools(ResolveResponsesBridgeToolsInput {
        original_tools: Some(vec![json!({ "type": "web_search" })]),
        chat_tools: Some(vec![
            json!({ "type": "function", "function": { "name": "exec_command" } }),
            json!({ "type": "function", "function": { "name": "exec_command" } }),
        ]),
        has_server_side_web_search: Some(false),
        passthrough_keys: None,
        request: None,
    });
    let merged = output.merged_tools.unwrap();
    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0]["function"]["name"], "exec_command");
    assert_eq!(merged[1]["type"], "web_search");
}

#[test]
fn resolves_responses_bridge_tools_injects_builtin_web_search_for_server_side_tool() {
    let output = resolve_responses_bridge_tools(ResolveResponsesBridgeToolsInput {
        original_tools: Some(vec![]),
        chat_tools: Some(vec![json!({
            "type": "function",
            "function": { "name": "web_search", "parameters": { "type": "object", "properties": {} } }
        }), json!({
            "type": "function",
            "function": { "name": "exec_command" }
        })]),
        has_server_side_web_search: Some(true),
        passthrough_keys: None,
        request: None,
    });
    let merged = output.merged_tools.unwrap();
    assert!(merged.iter().any(|tool| tool["type"] == "web_search"));
    assert!(merged
        .iter()
        .any(|tool| tool["function"]["name"] == "exec_command"));
}

#[test]
fn resolves_responses_bridge_tools_does_not_inject_builtin_web_search_without_web_search_function() {
    let output = resolve_responses_bridge_tools(ResolveResponsesBridgeToolsInput {
        original_tools: Some(vec![]),
        chat_tools: Some(vec![json!({
            "type": "function",
            "function": { "name": "exec_command" }
        })]),
        has_server_side_web_search: Some(true),
        passthrough_keys: None,
        request: None,
    });
    let merged = output.merged_tools.unwrap();
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0]["function"]["name"], "exec_command");
    assert!(!merged.iter().any(|tool| tool["type"] == "web_search"));
}

#[test]
fn resolves_responses_bridge_tools_dedupes_builtin_web_search_by_type() {
    let output = resolve_responses_bridge_tools(ResolveResponsesBridgeToolsInput {
        original_tools: Some(vec![
            json!({ "type": "web_search" }),
            json!({ "type": "web_search_preview" }),
        ]),
        chat_tools: None,
        has_server_side_web_search: Some(true),
        passthrough_keys: None,
        request: None,
    });
    let merged = output.merged_tools.unwrap();
    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0]["type"], "web_search");
    assert_eq!(merged[1]["type"], "web_search_preview");
}

#[test]
fn resolves_responses_bridge_tools_strips_server_side_web_search_function_and_preserves_passthrough(
) {
    let output = resolve_responses_bridge_tools(ResolveResponsesBridgeToolsInput {
        original_tools: Some(vec![json!({ "type": "web_search" })]),
        chat_tools: Some(vec![
            json!({
                "type": "function",
                "name": "web_search",
                "function": { "name": "web_search", "parameters": { "type": "object", "properties": {} } },
                "parameters": { "type": "object", "properties": {} }
            }),
            json!({
                "type": "function",
                "name": "exec_command",
                "function": { "name": "exec_command", "parameters": { "type": "object", "properties": {} } },
                "parameters": { "type": "object", "properties": {} }
            }),
        ]),
        has_server_side_web_search: Some(true),
        passthrough_keys: Some(vec!["temperature".to_string(), "seed".to_string()]),
        request: Some(json!({ "temperature": 0.4, "seed": 7 })),
    });
    let merged = output.merged_tools.unwrap();
    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0]["function"]["name"], "exec_command");
    assert_eq!(merged[1]["type"], "web_search");
    let request = output.request.unwrap();
    assert_eq!(request["temperature"], json!(0.4));
    assert_eq!(request["seed"], json!(7));
}

#[test]
fn resolves_responses_bridge_tools_does_not_double_inject_builtin_web_search_when_original_tools_already_have_it(
) {
    let output = resolve_responses_bridge_tools(ResolveResponsesBridgeToolsInput {
        original_tools: Some(vec![
            json!({
                "type": "function",
                "name": "exec_command",
                "function": { "name": "exec_command", "parameters": { "type": "object", "properties": {} } },
                "parameters": { "type": "object", "properties": {} }
            }),
            json!({
                "type": "function",
                "name": "write_stdin",
                "function": { "name": "write_stdin", "parameters": { "type": "object", "properties": {} } },
                "parameters": { "type": "object", "properties": {} }
            }),
            json!({ "type": "web_search" }),
        ]),
        chat_tools: Some(vec![
            json!({
                "type": "function",
                "function": { "name": "exec_command", "parameters": { "type": "object", "properties": {} } }
            }),
            json!({
                "type": "function",
                "function": { "name": "write_stdin", "parameters": { "type": "object", "properties": {} } }
            }),
        ]),
        has_server_side_web_search: Some(true),
        passthrough_keys: None,
        request: None,
    });

    let merged = output.merged_tools.unwrap();
    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0]["function"]["name"], "exec_command");
    assert_eq!(merged[1]["function"]["name"], "write_stdin");
    assert!(!merged.iter().any(|tool| tool["type"] == "web_search"));
}

#[test]
fn resolves_responses_bridge_tools_request_only_keeps_passthrough_fields() {
    let output = resolve_responses_bridge_tools(ResolveResponsesBridgeToolsInput {
        original_tools: None,
        chat_tools: Some(vec![json!({
            "type": "function",
            "function": { "name": "exec_command", "parameters": { "type": "object", "properties": {} } }
        })]),
        has_server_side_web_search: Some(false),
        passthrough_keys: Some(vec!["temperature".to_string(), "top_p".to_string()]),
        request: Some(json!({
            "messages": [{ "role": "user", "content": "hello" }],
            "temperature": 0.4,
            "top_p": 0.8,
            "metadata": { "keep": true }
        })),
    });

    let request = output.request.expect("request passthrough");
    assert!(request.get("messages").is_none());
    assert_eq!(request["temperature"], json!(0.4));
    assert_eq!(request["top_p"], json!(0.8));
    assert!(request.get("metadata").is_none());
}

#[test]
fn resolves_responses_request_bridge_decisions_prefers_route_style_and_force_web_search() {
    let output =
        resolve_responses_request_bridge_decisions(ResolveResponsesRequestBridgeDecisionsInput {
            context: Some(json!({
                "toolCallIdStyle": "preserve",
                "metadata": {
                    "toolCallIdStyle": "preserve",
                    "__rt": {
                        "forceWebSearch": true,
                        "webSearch": { "force": true }
                    }
                },
                "input": [{
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "ctx input" }]
                }],
                "originalSystemMessages": [" ctx sys ", ""],
                "systemInstruction": " ctx instruction "
            })),
            request_metadata: Some(json!({
                "toolCallIdStyle": "fc"
            })),
            envelope_metadata: Some(json!({
                "toolCallIdStyle": "preserve"
            })),
            bridge_metadata: None,
            extra_bridge_history: Some(json!({
                "input": [{
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "extra input" }]
                }],
                "combinedSystemInstruction": " extra keep ",
                "originalSystemMessages": [" first ", "   ", "second "]
            })),
        });
    assert!(output.force_web_search);
    assert_eq!(output.tool_call_id_style.as_deref(), Some("fc"));
    let history_seed = output.history_seed.expect("history seed");
    assert_eq!(
        history_seed.combined_system_instruction.as_deref(),
        Some("extra keep")
    );
    assert_eq!(
        history_seed.original_system_messages,
        vec!["first", "second"]
    );
    assert_eq!(
        history_seed.input[0]["content"][0]["text"].as_str(),
        Some("extra input")
    );
}

#[test]
fn resolves_responses_request_bridge_decisions_falls_back_to_context_history_seed() {
    let output =
        resolve_responses_request_bridge_decisions(ResolveResponsesRequestBridgeDecisionsInput {
            context: Some(json!({
                "metadata": {
                    "toolCallIdStyle": "preserve",
                    "__rt": {}
                },
                "input": [{
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "ctx fallback" }]
                }],
                "originalSystemMessages": [" keep ", "   "],
                "systemInstruction": " sys keep "
            })),
            request_metadata: None,
            envelope_metadata: Some(json!({})),
            bridge_metadata: None,
            extra_bridge_history: None,
        });
    assert!(!output.force_web_search);
    assert_eq!(output.tool_call_id_style.as_deref(), Some("fc"));
    let history_seed = output.history_seed.expect("history seed");
    assert_eq!(
        history_seed.combined_system_instruction.as_deref(),
        Some("sys keep")
    );
    assert_eq!(history_seed.original_system_messages, vec!["keep"]);
    assert_eq!(
        history_seed.input[0]["content"][0]["text"].as_str(),
        Some("ctx fallback")
    );
}

#[test]
fn filters_bridge_input_for_upstream_removes_reasoning_and_preserves_order() {
    let output = filter_bridge_input_for_upstream(FilterBridgeInputForUpstreamInput {
        input: vec![
            json!({ "type": "message", "role": "user", "id": "msg_1" }),
            json!({ "type": "reasoning", "id": "reasoning_1", "content": [] }),
            json!({ "type": "function_call_output", "id": "out_1", "call_id": "call_1" }),
        ],
        allow_tool_call_id: Some(false),
    });
    assert_eq!(output.input.len(), 2);
    assert_eq!(output.input[0]["id"], "msg_1");
    assert_eq!(output.input[1]["id"], "out_1");
}

#[test]
fn filters_bridge_input_for_upstream_strips_tool_call_id_and_clamps_id() {
    let long_id = "x".repeat(90);
    let output = filter_bridge_input_for_upstream(FilterBridgeInputForUpstreamInput {
        input: vec![json!({
            "type": "function_call_output",
            "id": long_id,
            "tool_call_id": "call_1",
            "call_id": "call_1",
            "output": "ok"
        })],
        allow_tool_call_id: Some(false),
    });
    let item = output.input[0].as_object().unwrap();
    assert!(item.get("tool_call_id").is_none());
    let clamped = item.get("id").and_then(Value::as_str).unwrap();
    assert!(clamped.len() <= 64);
    assert_eq!(item.get("call_id").and_then(Value::as_str), Some("call_1"));
}

#[test]
fn reasoning_prepare_responses_request_envelope_combines_segments_before_instruction() {
    let output = prepare_responses_request_envelope(PrepareResponsesRequestEnvelopeInput {
        request: json!({}),
        context_system_instruction: Some(json!("  ctx keep  ")),
        extra_system_instruction: Some(json!("extra ignored")),
        metadata_system_instruction: Some(json!("meta ignored")),
        combined_system_instruction: Some(json!("history ignored")),
        reasoning_instruction_segments: Some(json!(["  segment one  ", "segment two"])),
        context_parameters: None,
        chat_parameters: None,
        metadata_parameters: None,
        context_stream: None,
        metadata_stream: None,
        chat_stream: None,
        chat_parameters_stream: None,
        context_include: None,
        metadata_include: None,
        context_store: None,
        metadata_store: None,
        strip_host_fields: None,
        context_tool_choice: None,
        metadata_tool_choice: None,
        context_parallel_tool_calls: None,
        metadata_parallel_tool_calls: None,
        context_response_format: None,
        metadata_response_format: None,
        context_service_tier: None,
        metadata_service_tier: None,
        context_truncation: None,
        metadata_truncation: None,
        context_metadata: None,
        metadata_metadata: None,
    });
    let request = output.request.as_object().cloned().unwrap();
    assert_eq!(
        request.get("instructions").and_then(Value::as_str),
        Some("segment one\nsegment two\nctx keep")
    );
    assert_eq!(
        request.get("instructions_is_raw").and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn reasoning_prepare_responses_request_envelope_flattens_allowed_parameters() {
    let output = prepare_responses_request_envelope(PrepareResponsesRequestEnvelopeInput {
        request: json!({
            "stream": false,
            "parameters": { "ignored": true }
        }),
        context_system_instruction: None,
        extra_system_instruction: None,
        metadata_system_instruction: None,
        combined_system_instruction: None,
        reasoning_instruction_segments: None,
        context_parameters: Some(json!({
            "max_tokens": 123,
            "response_format": { "type": "json_schema" },
            "include": ["reasoning.encrypted_content"],
            "stream": true
        })),
        chat_parameters: Some(json!({
            "prompt_cache_key": "chat-cache",
            "ignored_field": "drop"
        })),
        metadata_parameters: None,
        context_stream: None,
        metadata_stream: None,
        chat_stream: None,
        chat_parameters_stream: None,
        context_include: None,
        metadata_include: None,
        context_store: None,
        metadata_store: None,
        strip_host_fields: None,
        context_tool_choice: None,
        metadata_tool_choice: None,
        context_parallel_tool_calls: None,
        metadata_parallel_tool_calls: None,
        context_response_format: None,
        metadata_response_format: None,
        context_service_tier: None,
        metadata_service_tier: None,
        context_truncation: None,
        metadata_truncation: None,
        context_metadata: None,
        metadata_metadata: None,
    });
    let request = output.request.as_object().cloned().unwrap();
    assert_eq!(
        request.get("max_output_tokens").and_then(Value::as_i64),
        Some(123)
    );
    assert_eq!(
        request
            .get("response_format")
            .and_then(Value::as_object)
            .and_then(|row| row.get("type"))
            .and_then(Value::as_str),
        Some("json_schema")
    );
    assert_eq!(
        request
            .get("include")
            .and_then(Value::as_array)
            .map(|entries| entries.len()),
        Some(1)
    );
    assert_eq!(request.get("stream").and_then(Value::as_bool), Some(false));
    assert!(request.get("parameters").is_none());
    assert!(request.get("ignored_field").is_none());
}

#[test]
fn reasoning_prepare_responses_request_envelope_prefers_ctx_over_metadata_and_defaults_store_false()
{
    let output = prepare_responses_request_envelope(PrepareResponsesRequestEnvelopeInput {
        request: json!({}),
        context_system_instruction: None,
        extra_system_instruction: None,
        metadata_system_instruction: None,
        combined_system_instruction: None,
        reasoning_instruction_segments: None,
        context_parameters: None,
        chat_parameters: Some(json!({
            "response_format": { "type": "chat-params" },
            "parallel_tool_calls": false
        })),
        metadata_parameters: Some(json!({
            "response_format": { "type": "metadata-params" },
            "parallel_tool_calls": false
        })),
        context_stream: Some(json!(false)),
        metadata_stream: Some(json!(true)),
        chat_stream: Some(json!(true)),
        chat_parameters_stream: Some(json!(true)),
        context_include: Some(json!(["ctx-include"])),
        metadata_include: Some(json!(["meta-include"])),
        context_store: None,
        metadata_store: None,
        strip_host_fields: Some(false),
        context_tool_choice: Some(json!("required")),
        metadata_tool_choice: Some(json!("auto")),
        context_parallel_tool_calls: Some(json!(true)),
        metadata_parallel_tool_calls: Some(json!(false)),
        context_response_format: Some(json!({ "type": "ctx-format" })),
        metadata_response_format: Some(json!({ "type": "meta-format" })),
        context_service_tier: Some(json!("priority")),
        metadata_service_tier: Some(json!("flex")),
        context_truncation: Some(json!("auto")),
        metadata_truncation: Some(json!("disabled")),
        context_metadata: Some(json!({ "ctx": true })),
        metadata_metadata: Some(json!({ "meta": true })),
    });
    let request = output.request.as_object().cloned().unwrap();
    assert_eq!(request.get("stream").and_then(Value::as_bool), Some(false));
    assert_eq!(request.get("store").and_then(Value::as_bool), Some(false));
    assert_eq!(
        request.get("tool_choice").and_then(Value::as_str),
        Some("required")
    );
    assert_eq!(
        request.get("parallel_tool_calls").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        request
            .get("response_format")
            .and_then(Value::as_object)
            .and_then(|row| row.get("type"))
            .and_then(Value::as_str),
        Some("ctx-format")
    );
    assert_eq!(
        request.get("service_tier").and_then(Value::as_str),
        Some("priority")
    );
    assert_eq!(
        request.get("truncation").and_then(Value::as_str),
        Some("auto")
    );
    assert_eq!(
        request
            .get("include")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_str),
        Some("ctx-include")
    );
    assert_eq!(
        request
            .get("metadata")
            .and_then(Value::as_object)
            .and_then(|row| row.get("ctx"))
            .and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn applies_bridge_capture_tool_results() {
    let output = apply_bridge_capture_tool_results(ApplyBridgeCaptureToolResultsInput {
        stage: "request_outbound".to_string(),
        captured_tool_results: None,
        raw_request: Some(json!({
          "tool_outputs": [{"tool_call_id":"call_1","output":"ok","name":"echo"}]
        })),
        raw_response: None,
        metadata: Some(json!({})),
    });
    let captured = output.captured_tool_results.unwrap();
    assert_eq!(captured.len(), 1);
    let first = captured[0].as_object().cloned().unwrap();
    assert_eq!(
        first.get("tool_call_id").and_then(Value::as_str),
        Some("call_1")
    );
    let metadata = output.metadata.unwrap().as_object().cloned().unwrap();
    let mirrored = metadata
        .get("capturedToolResults")
        .and_then(Value::as_array)
        .cloned()
        .unwrap();
    assert_eq!(mirrored.len(), 1);
}

#[test]
fn applies_bridge_ensure_tool_placeholders() {
    let output = apply_bridge_ensure_tool_placeholders(ApplyBridgeEnsureToolPlaceholdersInput {
        stage: "request_outbound".to_string(),
        messages: vec![json!({
          "role": "assistant",
          "tool_calls": [{"id":"call_1","type":"function","function":{"name":"echo"}}]
        })],
        captured_tool_results: Some(vec![json!({
          "tool_call_id": "call_1",
          "output": "ok",
          "name": "echo"
        })]),
        raw_request: None,
        raw_response: None,
    });
    assert_eq!(output.messages.len(), 2);
    let tool_message = output.messages[1].as_object().cloned().unwrap();
    assert_eq!(
        tool_message.get("tool_call_id").and_then(Value::as_str),
        Some("call_1")
    );
    assert_eq!(
        tool_message.get("content").and_then(Value::as_str),
        Some("ok")
    );
    let tool_outputs = output.tool_outputs.unwrap();
    assert_eq!(tool_outputs.len(), 1);
}

#[test]
fn tool_argument_repairer_repair_tool_calls_json() {
    let input = json!([
        {
            "name": "exec_command",
            "arguments": "{\"cmd\":\"pwd\",}"
        }
    ])
    .to_string();
    let output = repair_tool_calls_json(input).expect("repair_tool_calls_json");
    let parsed: Vec<Value> = serde_json::from_str(&output).expect("parsed output");
    let first = parsed.first().and_then(Value::as_object).cloned().unwrap();
    let repaired_args = first
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(repaired_args.contains("\"cmd\""));
    assert!(repaired_args.contains("\"pwd\""));
}

#[test]
fn ensures_bridge_output_fields_for_tool_and_assistant() {
    let input = EnsureBridgeOutputFieldsInput {
        messages: vec![
            json!({"role":"tool","content":null}),
            json!({"role":"assistant","content":[]}),
            json!({"role":"assistant","reasoning_content":"Reasoning only"}),
            json!({"role":"assistant","content":null}),
        ],
        tool_fallback: None,
        assistant_fallback: None,
    };
    let output = ensure_bridge_output_fields(input);
    let tool_msg = output.messages[0].as_object().unwrap();
    assert_eq!(
        tool_msg.get("content").and_then(|v| v.as_str()),
        Some("Tool call completed (no output).")
    );
    let assistant_empty = output.messages[1].as_object().unwrap();
    assert_eq!(
        assistant_empty.get("content").and_then(|v| v.as_str()),
        Some("")
    );
    let assistant_reasoning = output.messages[2].as_object().unwrap();
    assert_eq!(
        assistant_reasoning.get("content").and_then(|v| v.as_str()),
        Some("Reasoning only")
    );
    let assistant_fallback = output.messages[3].as_object().unwrap();
    assert_eq!(
        assistant_fallback.get("content").and_then(|v| v.as_str()),
        Some("Assistant response unavailable.")
    );
}

#[test]
fn preserves_assistant_tool_calls_without_fallback_text() {
    let input = EnsureBridgeOutputFieldsInput {
        messages: vec![json!({
          "role":"assistant",
          "tool_calls":[{"id":"call_1","type":"function","function":{"name":"shell"}}],
          "content": null
        })],
        tool_fallback: None,
        assistant_fallback: Some("X".to_string()),
    };
    let output = ensure_bridge_output_fields(input);
    let assistant = output.messages[0].as_object().unwrap();
    assert!(matches!(assistant.get("content"), None | Some(Value::Null)));
}

#[test]
fn convert_bridge_input_to_chat_messages_json_basic_user_text() {
    let input = BridgeInputToChatInput {
        input: vec![json!({"type": "message", "role": "user", "content": "hello"})],
        tools: None,
        tool_result_fallback_text: None,
        normalize_function_name: None,
    };
    let output = convert_bridge_input_to_chat_messages(input);
    assert_eq!(output.messages.len(), 1);
    let msg = output.messages[0].as_object().unwrap();
    assert_eq!(msg.get("role").and_then(Value::as_str), Some("user"));
    assert_eq!(msg.get("content").and_then(Value::as_str), Some("hello"));
}

#[test]
fn bridge_message_utils_json_string_input() {
    let input = json!({
        "input": [{"type": "message", "role": "user", "content": "hi"}]
    });
    let raw = convert_bridge_input_to_chat_messages_json(input.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let messages = parsed.get("messages").and_then(Value::as_array).unwrap();
    assert_eq!(messages.len(), 1);
    let msg = messages[0].as_object().unwrap();
    assert_eq!(msg.get("role").and_then(Value::as_str), Some("user"));
    assert_eq!(msg.get("content").and_then(Value::as_str), Some("hi"));
}

#[test]
fn bridge_message_utils_coerce_role_and_serialize_output_json() {
    let role_input = json!({"role": "ASSISTANT"}).to_string();
    let role_raw = coerce_bridge_role_json(role_input).unwrap();
    let role_value: Value = serde_json::from_str(&role_raw).unwrap();
    assert_eq!(role_value.as_str(), Some("assistant"));

    let output_input = json!({"output": {"cmd": "pwd"}}).to_string();
    let output_raw = serialize_tool_output_json(output_input).unwrap();
    let output_value: Value = serde_json::from_str(&output_raw).unwrap();
    let output_str = output_value.as_str().unwrap();
    let parsed: Value = serde_json::from_str(output_str).unwrap();
    assert_eq!(parsed.get("cmd").and_then(Value::as_str), Some("pwd"));
}

#[test]
fn bridge_message_utils_ensure_messages_array_json() {
    let input = json!({
        "state": {
            "messages": [
                {"role": "user", "content": "hi"}
            ]
        }
    })
    .to_string();
    let raw = ensure_messages_array_json(input).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let messages = parsed.get("messages").and_then(Value::as_array).unwrap();
    assert_eq!(messages.len(), 1);
    let msg = messages[0].as_object().unwrap();
    assert_eq!(msg.get("role").and_then(Value::as_str), Some("user"));
    assert_eq!(msg.get("content").and_then(Value::as_str), Some("hi"));
}

#[test]
fn convert_bridge_input_preserves_tool_calls_with_content() {
    let input = BridgeInputToChatInput {
        input: vec![json!({
            "type": "message",
            "role": "assistant",
            "content": "hello",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "arguments": { "cmd": "pwd" }
                    }
                }
            ]
        })],
        tools: None,
        tool_result_fallback_text: None,
        normalize_function_name: None,
    };
    let output = convert_bridge_input_to_chat_messages(input);
    assert_eq!(output.messages.len(), 1);
    let msg = output.messages[0].as_object().unwrap();
    assert_eq!(msg.get("role").and_then(Value::as_str), Some("assistant"));
    assert_eq!(msg.get("content").and_then(Value::as_str), Some("hello"));
    let tool_calls = msg.get("tool_calls").and_then(Value::as_array).unwrap();
    assert_eq!(tool_calls.len(), 1);
    let call = tool_calls[0].as_object().unwrap();
    assert_eq!(call.get("id").and_then(Value::as_str), Some("call_1"));
    assert_eq!(call.get("call_id").and_then(Value::as_str), Some("call_1"));
    let function = call.get("function").and_then(Value::as_object).unwrap();
    assert_eq!(
        function.get("name").and_then(Value::as_str),
        Some("exec_command")
    );
    let args = function.get("arguments").and_then(Value::as_str).unwrap();
    let parsed: Value = serde_json::from_str(args).unwrap();
    assert_eq!(parsed.get("cmd").and_then(Value::as_str), Some("pwd"));
}

#[test]
fn convert_bridge_input_harvests_malformed_assistant_parameter_markup_into_tool_calls() {
    let input = BridgeInputToChatInput {
        input: vec![json!({
            "type": "message",
            "role": "assistant",
            "content": r#"[思考] <parameter name="input">pwd</</parameter>
<parameter name="newVersion"><parameter name="type">string</parameter>"#
        })],
        tools: None,
        tool_result_fallback_text: None,
        normalize_function_name: Some("responses".to_string()),
    };

    let output = convert_bridge_input_to_chat_messages(input);
    assert_eq!(output.messages.len(), 1);
    let msg = output.messages[0].as_object().unwrap();
    assert_eq!(msg.get("role").and_then(Value::as_str), Some("assistant"));
    let tool_calls = msg.get("tool_calls").and_then(Value::as_array).unwrap();
    assert!(!tool_calls.is_empty());
    let first = tool_calls[0].as_object().unwrap();
    let function = first.get("function").and_then(Value::as_object).unwrap();
    assert_eq!(
        function.get("name").and_then(Value::as_str),
        Some("exec_command")
    );
    assert_eq!(
        msg.get("content").and_then(Value::as_str),
        Some("")
    );
}

#[test]
fn convert_bridge_input_keeps_plain_assistant_text_without_tool_markup() {
    let input = BridgeInputToChatInput {
        input: vec![json!({
            "type": "message",
            "role": "assistant",
            "content": "Jason，我先检查一下日志再继续。"
        })],
        tools: None,
        tool_result_fallback_text: None,
        normalize_function_name: Some("responses".to_string()),
    };

    let output = convert_bridge_input_to_chat_messages(input);
    assert_eq!(output.messages.len(), 1);
    let msg = output.messages[0].as_object().unwrap();
    assert_eq!(msg.get("role").and_then(Value::as_str), Some("assistant"));
    assert_eq!(
        msg.get("content").and_then(Value::as_str),
        Some("Jason，我先检查一下日志再继续。")
    );
    assert!(msg.get("tool_calls").is_none());
}

#[test]
fn applies_bridge_ensure_tool_placeholders_preserves_exec_command_payload() {
    let output = apply_bridge_ensure_tool_placeholders(ApplyBridgeEnsureToolPlaceholdersInput {
        stage: "request_outbound".to_string(),
        messages: vec![json!({
          "role": "assistant",
          "tool_calls": [{
            "id": "call_demo_exec",
            "call_id": "call_demo_exec",
            "type": "function",
            "function": {"name": "exec_command", "arguments": "{\"cmd\":\"ls -la\"}"}
          }]
        })],
        captured_tool_results: Some(vec![json!({
          "tool_call_id": "call_demo_exec",
          "output": {"stdout": "ok", "status": "completed"},
          "name": "exec_command"
        })]),
        raw_request: None,
        raw_response: None,
    });
    assert_eq!(output.messages.len(), 2);
    let tool_message = output.messages[1].as_object().unwrap();
    assert_eq!(
        tool_message.get("tool_call_id").and_then(Value::as_str),
        Some("call_demo_exec")
    );
    let content = tool_message.get("content").and_then(Value::as_str).unwrap();
    let parsed: Value = serde_json::from_str(content).unwrap();
    assert_eq!(parsed.get("stdout").and_then(Value::as_str), Some("ok"));
    assert_eq!(
        parsed.get("status").and_then(Value::as_str),
        Some("completed")
    );
}

#[test]
fn responses_exec_command_roundtrip_preserves_structured_tool_result() {
    let structured_output = json!({
        "status": "completed",
        "stdout": "total 8\n-rw-r--r--  focus.md",
        "exit_code": 0,
        "result": {
            "ok": true,
            "cwd": "/Users/example/project"
        }
    });
    let chat = convert_bridge_input_to_chat_messages(BridgeInputToChatInput {
        input: vec![
            json!({
              "type": "message",
              "role": "user",
              "content": [{"type": "input_text", "text": "列出 workspace 根目录文件"}]
            }),
            json!({
              "type": "function_call",
              "id": "fc_demo_exec",
              "call_id": "call_demo_exec",
              "name": "exec_command",
              "arguments": {"cmd": "ls -la", "workdir": "/Users/example/project"}
            }),
            json!({
              "type": "function_call_output",
              "id": "fc_demo_exec",
              "call_id": "call_demo_exec",
              "output": structured_output
            }),
        ],
        tools: None,
        tool_result_fallback_text: None,
        normalize_function_name: Some("responses".to_string()),
    });

    assert_eq!(chat.messages.len(), 3);
    let assistant = chat.messages[1].as_object().unwrap();
    let tool_calls = assistant
        .get("tool_calls")
        .and_then(Value::as_array)
        .unwrap();
    let first_call = tool_calls[0].as_object().unwrap();
    assert_eq!(
        first_call.get("id").and_then(Value::as_str),
        Some("call_demo_exec")
    );

    let tool_message = chat.messages[2].as_object().unwrap();
    assert_eq!(
        tool_message.get("tool_call_id").and_then(Value::as_str),
        Some("call_demo_exec")
    );
    let tool_content = tool_message.get("content").and_then(Value::as_str).unwrap();
    let parsed_tool_content: Value = serde_json::from_str(tool_content).unwrap();
    assert_eq!(
        parsed_tool_content.get("status").and_then(Value::as_str),
        Some("completed")
    );
    assert_eq!(
        parsed_tool_content.get("exit_code").and_then(Value::as_i64),
        Some(0)
    );

    let rebuilt = build_bridge_history(BuildBridgeHistoryInput {
        messages: chat.messages,
        tools: None,
    });
    let function_output = rebuilt
        .input
        .iter()
        .find(|entry| entry.get("type").and_then(Value::as_str) == Some("function_call_output"))
        .and_then(Value::as_object)
        .unwrap();
    assert_eq!(
        function_output.get("call_id").and_then(Value::as_str),
        Some("call_demo_exec")
    );
    let roundtrip_output = function_output
        .get("output")
        .and_then(Value::as_str)
        .unwrap();
    let parsed_roundtrip: Value = serde_json::from_str(roundtrip_output).unwrap();
    assert_eq!(
        parsed_roundtrip.get("status").and_then(Value::as_str),
        Some("completed")
    );
    assert_eq!(
        parsed_roundtrip
            .get("result")
            .and_then(|value| value.get("cwd"))
            .and_then(Value::as_str),
        Some("/Users/example/project")
    );
}

#[test]
fn convert_bridge_input_preserves_mixed_media_order() {
    let input = BridgeInputToChatInput {
        input: vec![json!({
            "type": "message",
            "role": "user",
            "content": [
                { "type": "input_image", "image_url": "data:image/png;base64,AAA" },
                { "type": "input_text", "text": "读取 README.md 内容" }
            ]
        })],
        tools: None,
        tool_result_fallback_text: None,
        normalize_function_name: None,
    };
    let output = convert_bridge_input_to_chat_messages(input);
    assert_eq!(output.messages.len(), 1);
    let msg = output.messages[0].as_object().unwrap();
    let content = msg.get("content").and_then(Value::as_array).unwrap();
    assert_eq!(content[0]["type"].as_str(), Some("image_url"));
    assert_eq!(
        content[0]["image_url"]["url"].as_str(),
        Some("data:image/png;base64,AAA")
    );
    assert_eq!(content[1]["type"].as_str(), Some("input_text"));
    assert_eq!(content[1]["text"].as_str(), Some("读取 README.md 内容"));
}

#[test]
fn bridge_message_utils_append_local_image_block_on_latest_user_input_json() {
    let temp_dir =
        std::env::temp_dir().join(format!("llmswitch-local-image-rust-{}", std::process::id()));
    fs::create_dir_all(&temp_dir).unwrap();
    let image_path: PathBuf = temp_dir.join("sample.png");
    let png_bytes = vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x60,
        0x00, 0x00, 0x02, 0x00, 0x01, 0x54, 0xA2, 0xB0, 0xC5, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
        0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    fs::write(&image_path, png_bytes).unwrap();

    let output = append_local_image_block_on_latest_user_input(
        AppendLocalImageBlockOnLatestUserInputInput {
            messages: vec![json!({
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": format!("\"{}\" 根据图片 review 架构", image_path.display())
                    }
                ]
            })],
        },
    );

    let content = output.messages[0]
        .get("content")
        .and_then(Value::as_array)
        .unwrap();
    assert_eq!(
        content[0].get("type").and_then(Value::as_str),
        Some("input_text")
    );
    assert_eq!(
        content[1].get("type").and_then(Value::as_str),
        Some("image_url")
    );
    assert!(content[1]
        .get("image_url")
        .and_then(|value| value.get("url"))
        .and_then(Value::as_str)
        .unwrap()
        .starts_with("data:image/png;base64,"));

    let missing_output = append_local_image_block_on_latest_user_input(
        AppendLocalImageBlockOnLatestUserInputInput {
            messages: vec![json!({
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": format!(
                            "请执行命令 --output=\"{}\" 然后继续",
                            temp_dir.join("missing.png").display()
                        )
                    }
                ]
            })],
        },
    );
    let missing_content = missing_output.messages[0]
        .get("content")
        .and_then(Value::as_array)
        .unwrap();
    assert_eq!(missing_content.len(), 2);
    assert_eq!(
        missing_content[1].get("type").and_then(Value::as_str),
        Some("text")
    );
    assert!(missing_content[1]
        .get("text")
        .and_then(Value::as_str)
        .unwrap()
        .contains("文件不可读"));
}

#[test]
fn reasoning_normalizer_chat_payload_json() {
    let payload = json!({
        "messages": [
            {"role": "assistant", "content": "<think>skip</think> Hello"}
        ]
    });
    let input = json!({"payload": payload}).to_string();
    let raw = normalize_reasoning_in_chat_payload_json(input).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let messages = parsed
        .get("payload")
        .and_then(|v| v.get("messages"))
        .and_then(Value::as_array)
        .unwrap();
    let msg = messages[0].as_object().unwrap();
    assert_eq!(msg.get("content").and_then(Value::as_str), Some("Hello"));
}

#[test]
fn reasoning_normalizer_chat_payload_does_not_backfill_content_when_tool_calls_present() {
    let payload = json!({
        "choices": [{
            "message": {
                "role": "assistant",
                "content": null,
                "reasoning_content": "<|tool_calls_section_begin|><|tool_call_begin|>functions.exec_command:1<|tool_call_argument_begin|>{\"cmd\":\"pwd\"}<|tool_call_end|><|tool_calls_section_end|>",
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"pwd\"}"
                    }
                }]
            },
            "finish_reason": "tool_calls"
        }]
    });
    let input = json!({"payload": payload}).to_string();
    let raw = normalize_reasoning_in_chat_payload_json(input).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let message = parsed
        .get("payload")
        .and_then(|v| v.get("choices"))
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(|v| v.get("message"))
        .and_then(Value::as_object)
        .unwrap();
    let content = message.get("content");
    assert!(!content.and_then(Value::as_str).map(|v| v.contains("<|tool_calls_section_begin|>")).unwrap_or(false));
}

#[test]
fn reasoning_normalizer_responses_payload_json() {
    let payload = json!({
        "id": "resp_1",
        "output": [
            {
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [
                    {"type": "output_text", "text": "<think>skip</think> Hi"}
                ]
            }
        ]
    });
    let input = json!({
        "payload": payload,
        "options": {"includeOutput": true}
    })
    .to_string();
    let raw = normalize_reasoning_in_responses_payload_json(input).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let output = parsed
        .get("payload")
        .and_then(|v| v.get("output"))
        .and_then(Value::as_array)
        .unwrap();
    assert!(!output.is_empty());
    let message = output
        .iter()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .and_then(Value::as_object)
        .unwrap();
    let content = message.get("content").and_then(Value::as_array).unwrap();
    let text = content[0].get("text").and_then(Value::as_str).unwrap();
    assert_eq!(text, "Hi");
}

#[test]
fn reasoning_utils_extract_reasoning_segments_json() {
    let input = json!({"source": "A<think>why</think> B"});
    let raw = extract_reasoning_segments_json(input.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed.get("text").and_then(Value::as_str), Some("A B"));
    let segments = parsed.get("segments").and_then(Value::as_array).unwrap();
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0].as_str(), Some("why"));
}

#[test]
fn reasoning_mapping_map_reasoning_content_to_responses_output_json() {
    let input = json!({"text": "first\nsecond"});
    let raw = map_reasoning_content_to_responses_output_json(input.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let arr = parsed.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(
        arr[0].get("type").and_then(Value::as_str),
        Some("reasoning")
    );
    assert_eq!(
        arr[0].get("content").and_then(Value::as_str),
        Some("first\nsecond")
    );
}

#[test]
fn bridge_message_utils_serialize_tool_arguments_json() {
    let input = json!({"args": {"cmd": "pwd"}});
    let raw = serialize_tool_arguments_json(input.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let args: Value = serde_json::from_str(parsed.as_str().unwrap()).unwrap();
    assert_eq!(args.get("cmd").and_then(Value::as_str), Some("pwd"));
}

#[test]
fn bridge_message_utils_serialize_tool_arguments_json_string_input() {
    let input = json!({"args": "{\"cmd\":\"pwd\"}"});
    let raw = serialize_tool_arguments_json(input.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let args: Value = serde_json::from_str(parsed.as_str().unwrap()).unwrap();
    assert_eq!(args.get("cmd").and_then(Value::as_str), Some("pwd"));
}

#[test]
fn bridge_message_utils_serialize_tool_arguments_json_string() {
    let input = json!({"args": "{\"cmd\":\"pwd\"}"});
    let raw = serialize_tool_arguments_json(input.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let parsed_str = parsed.as_str().unwrap_or_default();
    assert!(!parsed_str.is_empty());
    assert!(parsed_str.contains("cmd"));
    let inner: Value = serde_json::from_str(parsed_str).unwrap();
    assert!(inner.get("cmd").is_some());
}

#[test]
fn tool_argument_repairer_validate_tool_arguments_json() {
    let input = json!({"toolName": "exec_command", "args": "{cmd: 'pwd'}"});
    let raw = validate_tool_arguments_json(input.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed.get("success").and_then(Value::as_bool), Some(true));
    let repaired = parsed.get("repaired").and_then(Value::as_str).unwrap();
    let parsed_args: Value = serde_json::from_str(repaired).unwrap();
    assert_eq!(parsed_args.get("cmd").and_then(Value::as_str), Some("pwd"));
}

#[test]
fn applies_metadata_extra_fields_inbound_and_outbound() {
    let inbound = apply_bridge_metadata_action(ApplyBridgeMetadataActionInput {
        action_name: "metadata.extra-fields".to_string(),
        stage: "request_inbound".to_string(),
        options: Some(json!({"allowedKeys": ["messages", "model"]})),
        raw_request: Some(json!({
          "messages": [],
          "model": "x",
          "temperature": 0.7,
          "metadata": {"k":"v"}
        })),
        raw_response: None,
        metadata: None,
    });
    let metadata = inbound.metadata.unwrap().as_object().cloned().unwrap();
    let extras = metadata
        .get("extraFields")
        .and_then(Value::as_object)
        .cloned()
        .unwrap();
    assert!(extras.contains_key("temperature"));
    assert!(extras.contains_key("metadata"));

    let outbound = apply_bridge_metadata_action(ApplyBridgeMetadataActionInput {
        action_name: "metadata.extra-fields".to_string(),
        stage: "request_outbound".to_string(),
        options: Some(json!({"allowedKeys": ["messages", "model"]})),
        raw_request: Some(json!({
          "messages": [],
          "model": "x"
        })),
        raw_response: None,
        metadata: Some(json!({
          "extraFields": {
            "temperature": 0.7
          }
        })),
    });
    let raw_request = outbound.raw_request.unwrap().as_object().cloned().unwrap();
    assert_eq!(
        raw_request.get("temperature").and_then(Value::as_f64),
        Some(0.7)
    );
}

#[test]
fn applies_metadata_provider_sentinel_response_outbound() {
    let output = apply_bridge_metadata_action(ApplyBridgeMetadataActionInput {
        action_name: "metadata.provider-sentinel".to_string(),
        stage: "response_outbound".to_string(),
        options: Some(json!({
          "sentinel": "__rcc_provider_metadata",
          "target": "providerMetadata"
        })),
        raw_request: None,
        raw_response: Some(json!({ "ok": true })),
        metadata: Some(json!({
          "providerMetadata": {
            "provider": "iflow",
            "alias": "173"
          }
        })),
    });
    let raw_response = output.raw_response.unwrap().as_object().cloned().unwrap();
    let sentinel = raw_response
        .get("__rcc_provider_metadata")
        .and_then(Value::as_str)
        .unwrap_or("");
    assert!(sentinel.contains("\"provider\":\"iflow\""));
    assert!(sentinel.contains("\"alias\":\"173\""));
}

#[test]
fn applies_bridge_reasoning_extract() {
    let output = apply_bridge_reasoning_extract(ApplyBridgeReasoningExtractInput {
        messages: vec![json!({
          "role": "assistant",
          "content": "hello <think>internal</think> world"
        })],
        drop_from_content: Some(true),
        id_prefix_base: None,
    });
    let message = output.messages[0].as_object().cloned().unwrap();
    assert_eq!(
        message.get("content").and_then(Value::as_str),
        Some("hello  world")
    );
    assert_eq!(
        message.get("reasoning_content").and_then(Value::as_str),
        Some("internal")
    );
}

#[test]
fn applies_bridge_responses_output_reasoning() {
    let output =
        apply_bridge_responses_output_reasoning(ApplyBridgeResponsesOutputReasoningInput {
            messages: vec![json!({
              "role": "assistant",
              "content": ""
            })],
            raw_response: Some(json!({
              "output": [
                {
                  "type": "output_text",
                  "text": "answer<think>internal note</think>"
                }
              ]
            })),
            id_prefix: None,
        });
    let message = output.messages[0].as_object().cloned().unwrap();
    assert_eq!(
        message.get("content").and_then(Value::as_str),
        Some("answer")
    );
    assert_eq!(
        message.get("reasoning_content").and_then(Value::as_str),
        Some("internal note")
    );
}

#[test]
fn applies_bridge_inject_system_instruction() {
    let output = apply_bridge_inject_system_instruction(ApplyBridgeInjectSystemInstructionInput {
        stage: "request_inbound".to_string(),
        options: Some(json!({
          "field": "instructions",
          "reasoningField": "__rcc_reasoning_instructions"
        })),
        messages: vec![json!({
          "role": "user",
          "content": "hello"
        })],
        raw_request: Some(json!({
          "instructions": "be strict <think>inner</think>",
          "__rcc_reasoning_instructions": ["extra-a", "extra-b"]
        })),
    });
    let first = output.messages[0].as_object().cloned().unwrap();
    assert_eq!(first.get("role").and_then(Value::as_str), Some("system"));
    assert_eq!(
        first.get("content").and_then(Value::as_str),
        Some("be strict")
    );
    assert_eq!(
        first.get("reasoning_content").and_then(Value::as_str),
        Some("inner\nextra-a\nextra-b")
    );
}

#[test]
fn applies_bridge_ensure_system_instruction() {
    let outbound =
        apply_bridge_ensure_system_instruction(ApplyBridgeEnsureSystemInstructionInput {
            stage: "request_outbound".to_string(),
            messages: vec![
                json!({"role":"system","content":"A"}),
                json!({"role":"system","content":[{"type":"text","text":"B"}]}),
                json!({"role":"user","content":"U"}),
            ],
            metadata: None,
        });
    let metadata = outbound.metadata.unwrap().as_object().cloned().unwrap();
    assert_eq!(
        metadata.get("systemInstruction").and_then(Value::as_str),
        Some("A\n\nB")
    );
    assert_eq!(
        metadata
            .get("originalSystemMessages")
            .and_then(Value::as_array)
            .map(|arr| arr.len()),
        Some(2)
    );

    let inbound = apply_bridge_ensure_system_instruction(ApplyBridgeEnsureSystemInstructionInput {
        stage: "request_inbound".to_string(),
        messages: vec![json!({"role":"user","content":"hi"})],
        metadata: Some(json!({"systemInstruction":"A\n\nB"})),
    });
    let first = inbound.messages[0].as_object().cloned().unwrap();
    assert_eq!(first.get("role").and_then(Value::as_str), Some("system"));
    assert_eq!(first.get("content").and_then(Value::as_str), Some("A\n\nB"));
}

#[test]
fn responses_function_name_rejects_overlong_tool_names() {
    let overlong = "clock___".repeat(40);
    assert_eq!(
        normalize_responses_function_name(Some(overlong.as_str())),
        None
    );
}

#[test]
fn convert_bridge_input_skips_overlong_responses_function_calls() {
    let overlong = "clock___".repeat(40);
    let input = BridgeInputToChatInput {
        input: vec![json!({
            "type": "function_call",
            "id": "call_bad_1",
            "name": overlong,
            "arguments": { "action": "schedule" }
        })],
        tools: None,
        tool_result_fallback_text: None,
        normalize_function_name: Some("responses".to_string()),
    };
    let output = convert_bridge_input_to_chat_messages(input);
    assert!(output.messages.is_empty());
}
