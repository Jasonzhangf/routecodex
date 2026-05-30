use super::*;
use crate::hub_resp_outbound_client_semantics_blocks::chat_reasoning::*;
use crate::hub_resp_outbound_client_semantics_blocks::client_tool_args::*;
use crate::hub_resp_outbound_client_semantics_blocks::context_helpers::*;
use crate::hub_resp_outbound_client_semantics_blocks::provider_outcome::*;
use crate::hub_resp_outbound_client_semantics_blocks::responses_payload::*;
use crate::hub_resp_outbound_client_semantics_blocks::responses_usage::*;
use crate::hub_resp_outbound_client_semantics_blocks::tool_semantics::*;
use crate::hub_resp_outbound_sse_stream::resolve_sse_stream_mode;
use serde_json::{json, Value};

#[test]
fn normalize_openai_chat_reasoning_outbound_maps_structured_reasoning_for_clients() {
    let payload = serde_json::json!({
        "id": "chatcmpl_reasoning_client",
        "object": "chat.completion",
        "created": 1,
        "model": "qwen3.6-plus",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning": {
                        "summary": [{ "type": "summary_text", "text": "先确认目标" }],
                        "content": [{ "type": "reasoning_text", "text": "再检查代码路径" }],
                        "encrypted_content": "opaque-sig"
                    }
                }
            }
        ]
    });

    let output = normalize_openai_chat_reasoning_outbound(&payload).expect("normalized");
    let message = &output["choices"][0]["message"];
    assert_eq!(
        message["reasoning"]["content"][0]["text"],
        Value::String("再检查代码路径".to_string())
    );
    assert_eq!(
        message["reasoning_content"],
        Value::String("再检查代码路径".to_string())
    );
    let details = message["reasoning_details"]
        .as_array()
        .cloned()
        .expect("reasoning details");
    assert_eq!(
        details,
        vec![
            Value::String("[summary_text] 先确认目标".to_string()),
            Value::String("[reasoning_text] 再检查代码路径".to_string()),
            Value::String("[reasoning.encrypted_content] opaque-sig".to_string())
        ]
    );
}

#[test]
fn build_responses_payload_from_chat_filters_executed_tool_outputs_from_required_action() {
    let payload = serde_json::json!({
        "id": "resp_partial",
        "model": "glm-4.7",
        "tool_outputs": [
            { "tool_call_id": "fc_call_1", "output": "done" }
        ],
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "done",
                    "tool_calls": [
                        {
                            "id": "fc_call_1",
                            "type": "function",
                            "function": { "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                        },
                        {
                            "id": "fc_call_2",
                            "type": "function",
                            "function": { "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}" }
                        }
                    ]
                }
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_partial"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");
    assert_eq!(
        output["status"],
        Value::String("requires_action".to_string())
    );
    let required_calls = output["required_action"]["submit_tool_outputs"]["tool_calls"]
        .as_array()
        .cloned()
        .expect("tool calls array");
    assert_eq!(required_calls.len(), 1);
    assert_eq!(
        required_calls[0]["id"],
        Value::String("fc_call_2".to_string())
    );

    let output_items = output["output"].as_array().cloned().expect("output array");
    let function_items: Vec<&Value> = output_items
        .iter()
        .filter(|item| item["type"] == Value::String("function_call".to_string()))
        .collect();
    assert_eq!(function_items.len(), 2);
    assert_eq!(
        function_items[0]["status"],
        Value::String("completed".to_string())
    );
    assert_eq!(
        function_items[1]["status"],
        Value::String("in_progress".to_string())
    );
}

#[test]
fn build_responses_payload_from_chat_filters_native_tool_output_id_alias_from_required_action() {
    let payload = serde_json::json!({
        "id": "resp_native_completed",
        "model": "gpt-5.4-medium",
        "tool_outputs": [
            { "tool_call_id": "fc_native:run_command:3", "output": "/tmp/ws\n" }
        ],
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "native:run_command:3",
                            "type": "function",
                            "function": { "name": "run_command", "arguments": "{\"command_line\":\"pwd\"}" }
                        }
                    ]
                }
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_native_completed"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");
    assert_eq!(output["status"], Value::String("completed".to_string()));
    assert!(output.get("required_action").is_none());
    let output_items = output["output"].as_array().cloned().expect("output array");
    let function_items: Vec<&Value> = output_items
        .iter()
        .filter(|item| item["type"] == Value::String("function_call".to_string()))
        .collect();
    assert_eq!(function_items.len(), 1);
    assert_eq!(
        function_items[0]["status"],
        Value::String("completed".to_string())
    );
}

#[test]
fn build_responses_payload_from_chat_rejects_missing_tool_call_id() {
    let payload = serde_json::json!({
        "id": "resp_missing_tool_call_id",
        "model": "glm-4.7",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "done",
                    "tool_calls": [
                        {
                            "type": "function",
                            "function": { "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                        }
                    ]
                }
            }
        ]
    });

    let error = build_responses_payload_from_chat_core(
        &payload,
        Some("req_missing_tool_call_id"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .unwrap_err();
    assert!(error.contains("missing_tool_call_id"));
}

#[test]
fn resolve_anthropic_stop_reason_maps_context_overflow_to_length() {
    let output = resolve_anthropic_stop_reason(Some("model_context_window_exceeded"));
    assert_eq!(output["finishReason"], "length");
    assert_eq!(output["isContextOverflow"], true);
}

#[test]
fn resolve_anthropic_stop_reason_maps_tool_use_and_default() {
    let tool_use = resolve_anthropic_stop_reason(Some("tool_use"));
    assert_eq!(tool_use["finishReason"], "tool_calls");
    assert_eq!(tool_use["isContextOverflow"], false);

    let unknown = resolve_anthropic_stop_reason(Some("weird_stop"));
    assert_eq!(unknown["finishReason"], "weird_stop");
    assert_eq!(unknown["normalized"], "weird_stop");

    let empty = resolve_anthropic_stop_reason(None);
    assert_eq!(empty["finishReason"], "stop");
}

#[test]
fn resolve_anthropic_chat_completion_outcome_prefers_tool_calls_and_sets_overflow_gate() {
    let with_tool_calls =
        resolve_anthropic_chat_completion_outcome(Some("model_context_window_exceeded"), 2, false);
    assert_eq!(
        with_tool_calls["finishReason"],
        Value::String("tool_calls".to_string())
    );
    assert_eq!(with_tool_calls["isContextOverflow"], Value::Bool(true));
    assert_eq!(
        with_tool_calls["shouldFailEmptyContextOverflow"],
        Value::Bool(true)
    );

    let without_tool_calls =
        resolve_anthropic_chat_completion_outcome(Some("model_context_window_exceeded"), 0, true);
    assert_eq!(
        without_tool_calls["finishReason"],
        Value::String("length".to_string())
    );
    assert_eq!(
        without_tool_calls["shouldFailEmptyContextOverflow"],
        Value::Bool(false)
    );
}

#[test]
fn summarize_tool_calls_from_provider_response_supports_chat_responses_and_anthropic() {
    let openai_chat = serde_json::json!({
        "choices": [
            {
                "message": {
                    "tool_calls": [
                        { "function": { "name": "exec_command" } },
                        { "function": { "name": "apply_patch" } }
                    ]
                }
            }
        ]
    });
    let chat_summary = summarize_tool_calls_from_provider_response(&openai_chat);
    assert_eq!(chat_summary["toolCallCount"], Value::from(2));
    assert_eq!(
        chat_summary["toolNames"],
        Value::Array(vec![
            Value::String("exec_command".to_string()),
            Value::String("apply_patch".to_string())
        ])
    );

    let responses_payload = serde_json::json!({
        "output": [
            { "type": "function_call", "name": "exec_command" },
            { "type": "message", "content": [] },
            { "type": "function_call", "name": "apply_patch" }
        ]
    });
    let responses_summary = summarize_tool_calls_from_provider_response(&responses_payload);
    assert_eq!(responses_summary["toolCallCount"], Value::from(2));
    assert_eq!(
        responses_summary["toolNames"],
        Value::Array(vec![
            Value::String("exec_command".to_string()),
            Value::String("apply_patch".to_string())
        ])
    );

    let anthropic_payload = serde_json::json!({
        "content": [
            { "type": "tool_use", "name": "shell_command" },
            { "type": "text", "text": "done" }
        ]
    });
    let anthropic_summary = summarize_tool_calls_from_provider_response(&anthropic_payload);
    assert_eq!(anthropic_summary["toolCallCount"], Value::from(1));
    assert_eq!(
        anthropic_summary["toolNames"],
        Value::Array(vec![Value::String("shell_command".to_string())])
    );
}

#[test]
fn infer_provider_type_from_protocol_maps_known_protocols() {
    assert_eq!(
        infer_provider_type_from_protocol(Some("openai-chat")),
        Some("openai".to_string())
    );
    assert_eq!(
        infer_provider_type_from_protocol(Some("openai-responses")),
        Some("responses".to_string())
    );
    assert_eq!(
        infer_provider_type_from_protocol(Some("anthropic-messages")),
        Some("anthropic".to_string())
    );
    assert_eq!(
        infer_provider_type_from_protocol(Some("gemini-chat")),
        Some("gemini".to_string())
    );
    assert_eq!(infer_provider_type_from_protocol(Some("unknown")), None);
    assert_eq!(infer_provider_type_from_protocol(None), None);
}

#[test]
fn build_responses_payload_from_chat_does_not_leak_completed_native_call_through_choices() {
    let payload = serde_json::json!({
        "id": "resp_native_completed",
        "model": "gpt-5.4-medium",
        "tool_outputs": [
            { "tool_call_id": "native:run_command:3", "output": "/tmp/ws\n" }
        ],
        "choices": [
            {
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": "Running `pwd` now.",
                    "tool_calls": [
                        {
                            "id": "native:run_command:3",
                            "type": "function",
                            "function": {
                                "name": "run_command",
                                "arguments": "{\"command_line\":\"pwd\",\"cwd\":\"/tmp/ws\"}"
                            }
                        }
                    ]
                }
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_native_completed"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");

    assert_eq!(output["status"], Value::String("completed".to_string()));
    assert!(output.get("required_action").is_none());
    assert!(
        output.get("choices").is_none(),
        "responses client payload must not retain chat choices with repeated completed tool_calls"
    );
    let function_calls = output["output"]
        .as_array()
        .expect("output array")
        .iter()
        .filter(|item| item["type"] == Value::String("function_call".to_string()))
        .collect::<Vec<_>>();
    assert_eq!(function_calls.len(), 1);
    assert_eq!(
        function_calls[0]["status"],
        Value::String("completed".to_string())
    );
}

#[test]
fn build_responses_payload_from_chat_keeps_completed_when_no_pending_tool_calls_remain() {
    let payload = serde_json::json!({
        "id": "resp_completed",
        "model": "glm-4.7",
        "tool_outputs": [
            { "tool_call_id": "fc_call_1", "output": "done-1" },
            { "tool_call_id": "fc_call_2", "output": "done-2" }
        ],
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "all done",
                    "tool_calls": [
                        {
                            "id": "fc_call_1",
                            "type": "function",
                            "function": { "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                        },
                        {
                            "id": "fc_call_2",
                            "type": "function",
                            "function": { "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}" }
                        }
                    ]
                }
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_completed"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");
    assert_eq!(output["status"], Value::String("completed".to_string()));
    assert!(output.get("required_action").is_none());
    let output_items = output["output"].as_array().cloned().expect("output array");
    for item in output_items
        .iter()
        .filter(|item| item["type"] == Value::String("function_call".to_string()))
    {
        assert_eq!(item["status"], Value::String("completed".to_string()));
    }
}

#[test]
fn normalize_responses_function_name_preserves_dotted_tool_names() {
    assert_eq!(
        normalize_responses_function_name(Some("mailbox.status")),
        Some("mailbox.status".to_string())
    );
    assert_eq!(
        normalize_responses_function_name(Some("agent.dispatch")),
        Some("agent.dispatch".to_string())
    );
}

#[test]
fn normalize_responses_tool_call_arguments_for_client_recovers_declared_tool_names() {
    let responses_payload = serde_json::json!({
        "output": [
            {
                "type": "function_call",
                "name": "mailbox_status",
                "arguments": "{\"target\":\"finger-system-agent\"}"
            },
            {
                "type": "function_call",
                "name": "functions.mailbox_status",
                "arguments": "{\"target\":\"finger-system-agent\"}"
            }
        ],
        "required_action": {
            "type": "submit_tool_outputs",
            "submit_tool_outputs": {
                "tool_calls": [
                    {
                        "name": "mailbox-status",
                        "arguments": "{\"target\":\"finger-system-agent\"}",
                        "function": {
                            "name": "mailbox-status",
                            "arguments": "{\"target\":\"finger-system-agent\"}"
                        }
                    }
                ]
            }
        }
    });
    let tools_raw = serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "mailbox.status",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "target": { "type": "string" }
                    },
                    "required": ["target"],
                    "additionalProperties": false
                }
            }
        }
    ]);
    let normalized =
        normalize_responses_tool_call_arguments_for_client(&responses_payload, &tools_raw);
    let output_calls = normalized["output"].as_array().expect("output calls");
    assert_eq!(
        output_calls[0]["name"],
        Value::String("mailbox.status".to_string())
    );
    assert_eq!(
        output_calls[1]["name"],
        Value::String("mailbox.status".to_string())
    );
    assert_eq!(
        normalized["required_action"]["submit_tool_outputs"]["tool_calls"][0]["name"],
        Value::String("mailbox.status".to_string())
    );
    assert_eq!(
        normalized["required_action"]["submit_tool_outputs"]["tool_calls"][0]["function"]["name"],
        Value::String("mailbox.status".to_string())
    );
}

#[test]
fn normalize_responses_tool_call_arguments_for_client_bridges_apply_patch_minus_plus_args() {
    let payload = json!({
        "output": [{
            "type": "function_call",
            "call_id": "call_apply_patch",
            "name": "apply_patch",
            "arguments": serde_json::to_string(&json!({
                "patch": "- old\n+ new",
                "filePath": "sample.txt",
                "fileContent": "old\n"
            })).unwrap()
        }],
        "required_action": {
            "type": "submit_tool_outputs",
            "submit_tool_outputs": {
                "tool_calls": [{
                    "id": "call_apply_patch",
                    "type": "function",
                    "name": "apply_patch",
                    "arguments": serde_json::to_string(&json!({
                        "patch": "- old\n+ new",
                        "filePath": "sample.txt",
                        "fileContent": "old\n"
                    })).unwrap(),
                    "function": {
                        "name": "apply_patch",
                        "arguments": serde_json::to_string(&json!({
                            "patch": "- old\n+ new",
                            "filePath": "sample.txt",
                            "fileContent": "old\n"
                        })).unwrap()
                    }
                }]
            }
        }
    });
    let output = normalize_responses_tool_call_arguments_for_client(
        &payload,
        &json!([{ "type": "function", "name": "apply_patch", "parameters": { "type": "object", "properties": { "patch": { "type": "string" } }, "required": ["patch"] } }]),
    );
    let args = output["output"][0]["arguments"].as_str().unwrap();
    assert!(args.contains("*** Begin Patch"));
    assert!(args.contains("*** Update File: sample.txt"));
    assert!(args.contains("-old"));
    assert!(args.contains("+new"));
    assert_eq!(
        output["required_action"]["submit_tool_outputs"]["tool_calls"][0]["arguments"],
        output["required_action"]["submit_tool_outputs"]["tool_calls"][0]["function"]["arguments"]
    );
}

#[test]
fn normalize_responses_tool_call_arguments_for_client_repairs_exec_command_aliases_by_schema() {
    let responses_payload = serde_json::json!({
        "required_action": {
            "type": "submit_tool_outputs",
            "submit_tool_outputs": {
                "tool_calls": [
                    {
                        "name": "exec_command",
                        "arguments": "{\"command\":\"pwd\"}",
                        "function": {
                            "name": "exec_command",
                            "arguments": "{\"command\":\"pwd\"}"
                        }
                    }
                ]
            }
        }
    });
    let tools_raw = serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "exec_command",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cmd": { "type": "string" }
                    },
                    "required": ["cmd"],
                    "additionalProperties": false
                }
            }
        }
    ]);
    let normalized =
        normalize_responses_tool_call_arguments_for_client(&responses_payload, &tools_raw);
    assert_eq!(
        normalized["required_action"]["submit_tool_outputs"]["tool_calls"][0]["function"]
            ["arguments"],
        Value::String("{\"cmd\":\"pwd\"}".to_string())
    );
    assert_eq!(
        normalized["required_action"]["submit_tool_outputs"]["tool_calls"][0]["arguments"],
        Value::String("{\"cmd\":\"pwd\"}".to_string())
    );
}

#[test]
fn normalize_responses_tool_call_arguments_for_client_drops_exec_command_command_alias_when_schema_is_cmd_only(
) {
    let responses_payload = serde_json::json!({
        "output": [
            {
                "type": "function_call",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"bash -lc 'pwd'\",\"command\":\"bash -lc 'pwd'\"}",
                "function": {
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"bash -lc 'pwd'\",\"command\":\"bash -lc 'pwd'\"}"
                }
            }
        ],
        "required_action": {
            "type": "submit_tool_outputs",
            "submit_tool_outputs": {
                "tool_calls": [
                    {
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"bash -lc 'pwd'\",\"command\":\"bash -lc 'pwd'\"}",
                        "function": {
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"bash -lc 'pwd'\",\"command\":\"bash -lc 'pwd'\"}"
                        }
                    }
                ]
            }
        }
    });
    let tools_raw = serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "exec_command",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cmd": { "type": "string" }
                    },
                    "required": ["cmd"],
                    "additionalProperties": false
                }
            }
        }
    ]);
    let normalized =
        normalize_responses_tool_call_arguments_for_client(&responses_payload, &tools_raw);
    assert_eq!(
        normalized["output"][0]["arguments"],
        Value::String("{\"cmd\":\"bash -lc 'pwd'\"}".to_string())
    );
    assert_eq!(
        normalized["required_action"]["submit_tool_outputs"]["tool_calls"][0]["function"]
            ["arguments"],
        Value::String("{\"cmd\":\"bash -lc 'pwd'\"}".to_string())
    );
    assert_eq!(
        normalized["required_action"]["submit_tool_outputs"]["tool_calls"][0]["arguments"],
        Value::String("{\"cmd\":\"bash -lc 'pwd'\"}".to_string())
    );
}

#[test]
fn build_responses_payload_from_chat_restores_declared_tool_name_from_tools_raw() {
    let payload = serde_json::json!({
        "id": "resp_tool_alias_restore",
        "model": "qwen3.6-plus",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "mailbox_status",
                                "arguments": "{\"target\":\"finger-system-agent\"}"
                            }
                        }
                    ]
                }
            }
        ]
    });
    let context = serde_json::json!({
        "toolsRaw": [
            {
                "type": "function",
                "function": {
                    "name": "mailbox.status",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "target": { "type": "string" }
                        },
                        "required": ["target"],
                        "additionalProperties": false
                    }
                }
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(&payload, Some("req_tool_alias"), &context)
        .expect("build responses payload");

    let output_calls = output["output"].as_array().expect("output array");
    let function_call = output_calls
        .iter()
        .find(|item| item["type"] == Value::String("function_call".to_string()))
        .expect("function_call item");
    assert_eq!(
        function_call["name"],
        Value::String("mailbox.status".to_string())
    );
    assert_eq!(
        output["required_action"]["submit_tool_outputs"]["tool_calls"][0]["name"],
        Value::String("mailbox.status".to_string())
    );
}

#[test]
fn build_responses_payload_from_chat_restores_namespace_tool_shape_from_tools_raw() {
    let payload = serde_json::json!({
        "id": "resp_namespace_restore",
        "model": "qwen3.6-plus",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "mcp__computer_use__get_app_state",
                                "arguments": "{\"app\":\"Chrome\"}"
                            }
                        }
                    ]
                }
            }
        ]
    });
    let context = serde_json::json!({
        "toolsRaw": [
            {
                "type": "namespace",
                "name": "mcp__computer_use__",
                "tools": [
                    {
                        "type": "function",
                        "name": "get_app_state",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "app": { "type": "string" }
                            },
                            "required": ["app"],
                            "additionalProperties": false
                        }
                    }
                ]
            }
        ]
    });

    let output =
        build_responses_payload_from_chat_core(&payload, Some("req_tool_namespace"), &context)
            .expect("build responses payload");

    let function_call = output["output"]
        .as_array()
        .expect("output array")
        .iter()
        .find(|item| item["type"] == Value::String("function_call".to_string()))
        .expect("function_call item");
    assert_eq!(
        function_call["name"],
        Value::String("get_app_state".to_string())
    );
    assert_eq!(
        function_call["namespace"],
        Value::String("mcp__computer_use__".to_string())
    );
    assert_eq!(
        output["required_action"]["submit_tool_outputs"]["tool_calls"][0]["name"],
        Value::String("get_app_state".to_string())
    );
    assert_eq!(
        output["required_action"]["submit_tool_outputs"]["tool_calls"][0]["namespace"],
        Value::String("mcp__computer_use__".to_string())
    );
}

#[test]
fn build_responses_payload_from_chat_merges_source_retention_and_context_fields() {
    let payload = serde_json::json!({
        "id": "resp_merge",
        "model": "glm-4.7",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "hello" }
                    ]
                }
            }
        ]
    });

    let context = serde_json::json!({
        "requestId": "req_merge",
        "toolsRaw": [],
        "metadata": {
            "toolCallIdStyle": "fc",
            "keep": true,
            "extraFields": { "__rcc_debug": "drop" }
        },
        "parallelToolCalls": true,
        "toolChoice": "required",
        "include": ["reasoning.encrypted_content"],
        "store": true,
        "stripHostManagedFields": false,
        "sourceForRetention": {
            "metadata": { "source": true },
            "temperature": 0.4,
            "top_p": 0.8,
            "prompt_cache_key": "cache-key",
            "reasoning": { "effort": "high" },
            "output": [
                {
                    "id": "message_req_merge_1",
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "summary": [{ "type": "summary_text", "text": "filled summary" }],
                    "encrypted_content": "encrypted"
                }
            ]
        }
    });

    let output = build_responses_payload_from_chat_core(&payload, Some("req_merge"), &context)
        .expect("build responses payload");

    assert_eq!(output["request_id"], Value::String("req_merge".to_string()));
    assert_eq!(output["metadata"]["keep"], Value::Bool(true));
    assert_eq!(output["metadata"]["source"], Value::Bool(true));
    assert!(output["metadata"].get("toolCallIdStyle").is_none());
    assert_eq!(output["temperature"], Value::from(0.4));
    assert_eq!(output["top_p"], Value::from(0.8));
    assert_eq!(
        output["prompt_cache_key"],
        Value::String("cache-key".to_string())
    );
    assert_eq!(
        output["reasoning"]["effort"],
        Value::String("high".to_string())
    );
    assert_eq!(output["parallel_tool_calls"], Value::Bool(true));
    assert_eq!(output["tool_choice"], Value::String("required".to_string()));
    assert_eq!(
        output["include"][0],
        Value::String("reasoning.encrypted_content".to_string())
    );
    assert_eq!(output["store"], Value::Bool(true));
    assert_eq!(
        output["output"][0]["summary"][0]["text"],
        Value::String("filled summary".to_string())
    );
    assert_eq!(
        output["output"][0]["encrypted_content"],
        Value::String("encrypted".to_string())
    );
}

#[test]
fn build_responses_payload_from_chat_source_metadata_overrides_context_deepseek_tool_state() {
    let payload = serde_json::json!({
        "id": "resp_deepseek_meta",
        "model": "deepseek-chat",
        "choices": [
            {
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"pwd\"}"
                            }
                        }
                    ]
                }
            }
        ]
    });

    let context = serde_json::json!({
        "requestId": "req_deepseek_meta",
        "toolsRaw": [],
        "metadata": {
            "keep": true,
            "deepseek": {
                "toolCallState": "no_tool_calls",
                "toolCallSource": "none"
            }
        },
        "sourceForRetention": {
            "metadata": {
                "deepseek": {
                    "toolCallState": "text_tool_calls",
                    "toolCallSource": "fallback"
                }
            }
        }
    });

    let output =
        build_responses_payload_from_chat_core(&payload, Some("req_deepseek_meta"), &context)
            .expect("build responses payload");

    assert_eq!(output["metadata"]["keep"], Value::Bool(true));
    assert_eq!(
        output["metadata"]["deepseek"]["toolCallState"],
        Value::String("text_tool_calls".to_string())
    );
    assert_eq!(
        output["metadata"]["deepseek"]["toolCallSource"],
        Value::String("fallback".to_string())
    );
}

#[test]
fn build_responses_payload_from_chat_preserves_structured_message_reasoning() {
    let payload = serde_json::json!({
        "id": "resp_reasoning",
        "model": "gpt-5.2",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "done",
                    "reasoning": {
                        "summary": [{ "type": "summary_text", "text": "summary-1" }],
                        "content": [
                            { "type": "reasoning_text", "text": "raw-1" },
                            { "type": "reasoning_text", "text": "raw-2" }
                        ],
                        "encrypted_content": "enc-1"
                    }
                }
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_reasoning"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");

    let reasoning_item = output["output"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item["type"] == Value::String("reasoning".to_string()))
        })
        .cloned()
        .expect("reasoning output item");
    assert_eq!(
        reasoning_item["summary"][0]["text"],
        Value::String("**Thinking** summary-1".to_string())
    );
    assert_eq!(
        reasoning_item["content"][0]["text"],
        Value::String("raw-1".to_string())
    );
    assert_eq!(
        reasoning_item["content"][1]["text"],
        Value::String("raw-2".to_string())
    );
    assert_eq!(
        reasoning_item["encrypted_content"],
        Value::String("enc-1".to_string())
    );
}

#[test]
fn build_responses_payload_from_chat_preserves_deepseek_reasoning_before_tool_call() {
    let payload = serde_json::json!({
        "id": "chatcmpl_deepseek_tool_reasoning",
        "model": "deepseek-v4-flash-free",
        "choices": [
            {
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "Need original upstream reasoning before calling pwd.",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"pwd\"}"
                            }
                        }
                    ]
                }
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_deepseek_tool_reasoning"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");

    let output_items = output["output"].as_array().expect("output array");
    assert_eq!(output_items[0]["type"], Value::String("reasoning".to_string()));
    assert_eq!(
        output_items[0]["content"][0]["text"],
        Value::String("Need original upstream reasoning before calling pwd.".to_string())
    );
    assert_eq!(
        output_items[1]["type"],
        Value::String("function_call".to_string())
    );
    assert_eq!(output_items[1]["name"], Value::String("exec_command".to_string()));
}

#[test]
fn build_responses_payload_from_chat_backfills_reasoning_summary_from_content() {
    let payload = serde_json::json!({
        "id": "resp_reasoning_backfill",
        "model": "gpt-5.2",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "done",
                    "reasoning": {
                        "content": [
                            { "type": "reasoning_text", "text": "raw-only-1" },
                            { "type": "reasoning_text", "text": "raw-only-2" }
                        ]
                    }
                }
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_reasoning_backfill"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");

    let reasoning_item = output["output"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item["type"] == Value::String("reasoning".to_string()))
        })
        .cloned()
        .expect("reasoning output item");
    assert_eq!(
        reasoning_item["summary"][0]["text"],
        Value::String("**Thinking** raw-only-1".to_string())
    );
    assert_eq!(
        reasoning_item["summary"][1]["text"],
        Value::String("raw-only-2".to_string())
    );
    assert_eq!(
        reasoning_item["content"][0]["text"],
        Value::String("raw-only-1".to_string())
    );
    assert_eq!(
        reasoning_item["content"][1]["text"],
        Value::String("raw-only-2".to_string())
    );
    assert_eq!(reasoning_item["encrypted_content"], Value::Null);
}

#[test]
fn build_responses_payload_from_chat_preserves_output_text_whitespace_and_concat_shape() {
    let payload = serde_json::json!({
        "id": "resp_output_text_whitespace",
        "model": "gpt-5.2",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "output_text", "text": "\nline-1\n\n" },
                        { "type": "output_text", "text": "line-2\n" }
                    ]
                }
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_output_text_whitespace"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");

    let message_item = output["output"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item["type"] == Value::String("message".to_string()))
        })
        .cloned()
        .expect("message output item");
    assert_eq!(
        message_item["content"][0]["text"],
        Value::String("\nline-1\n\n".to_string())
    );
    assert_eq!(
        message_item["content"][1]["text"],
        Value::String("line-2\n".to_string())
    );
    assert_eq!(
        output["output_text"],
        Value::String("\nline-1\n\nline-2\n".to_string())
    );
}

#[test]
fn build_responses_payload_from_chat_keeps_display_compatible_reasoning_summary() {
    let payload = serde_json::json!({
        "id": "resp_reasoning_header",
        "model": "gpt-5.2",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "done",
                    "reasoning": {
                        "summary": [{ "type": "summary_text", "text": "**Plan**\n\ncheck files" }]
                    }
                }
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_reasoning_header"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");

    let reasoning_item = output["output"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item["type"] == Value::String("reasoning".to_string()))
        })
        .cloned()
        .expect("reasoning output item");
    assert_eq!(
        reasoning_item["summary"][0]["text"],
        Value::String("**Plan**\n\ncheck files".to_string())
    );
}

#[test]
fn build_responses_payload_from_chat_normalizes_mid_body_bold_reasoning_summary() {
    let payload = serde_json::json!({
        "id": "resp_reasoning_mid_bold",
        "model": "gpt-5.2",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "done",
                    "reasoning": {
                        "summary": [
                            {
                                "type": "summary_text",
                                "text": "先看现状。\\n\\n1. **重点** 先修复"
                            }
                        ]
                    }
                }
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_reasoning_mid_bold"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");

    let reasoning_item = output["output"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item["type"] == Value::String("reasoning".to_string()))
        })
        .cloned()
        .expect("reasoning output item");
    assert_eq!(
        reasoning_item["summary"][0]["text"],
        Value::String("**Thinking** 先看现状。\n\n1. **重点** 先修复".to_string())
    );
}

#[test]
fn resolve_alias_map_from_sources_prefers_adapter_context_then_metadata() {
    let from_context = resolve_alias_map_from_sources(
        &serde_json::json!({
            "anthropicToolNameMap": {
                "exec_command": "ExecCommand"
            }
        }),
        &serde_json::json!({
            "metadata": {
                "anthropicToolNameMap": {
                    "exec_command": "MetaCommand"
                }
            },
            "semantics": {
                "tools": {
                    "toolNameAliasMap": {
                        "exec_command": "SemCommand"
                    }
                }
            }
        }),
    )
    .expect("alias map");
    assert_eq!(
        from_context.get("exec_command").and_then(|v| v.as_str()),
        Some("ExecCommand")
    );

    let from_metadata = resolve_alias_map_from_sources(
        &serde_json::json!({}),
        &serde_json::json!({
            "metadata": {
                "context": {
                    "anthropicToolNameMap": {
                        "apply_patch": "ApplyPatch"
                    }
                }
            }
        }),
    )
    .expect("alias map from metadata context");
    assert_eq!(
        from_metadata.get("apply_patch").and_then(|v| v.as_str()),
        Some("ApplyPatch")
    );
}

#[test]
fn resolve_alias_map_from_sources_falls_back_to_semantics() {
    let output = resolve_alias_map_from_sources(
        &serde_json::json!({}),
        &serde_json::json!({
            "semantics": {
                "tools": {
                    "toolNameAliasMap": {
                        "exec_command": "ExecCommand"
                    }
                }
            }
        }),
    )
    .expect("alias map from semantics");
    assert_eq!(
        output.get("exec_command").and_then(|v| v.as_str()),
        Some("ExecCommand")
    );
}

#[test]
fn resolve_alias_map_from_sources_repairs_anthropic_semantics_mirror_shape() {
    let output = resolve_alias_map_from_sources(
        &serde_json::json!({}),
        &serde_json::json!({
            "semantics": {
                "anthropic": {
                    "toolNameAliasMap": {
                        "shell_command": "Bash"
                    }
                }
            }
        }),
    )
    .expect("alias map from anthropic semantics mirror");
    assert_eq!(
        output.get("shell_command").and_then(|v| v.as_str()),
        Some("Bash")
    );
}

#[test]
fn resolve_client_tools_raw_from_resp_semantics_repairs_anthropic_semantics_mirror_shape() {
    let output = resolve_client_tools_raw_from_resp_semantics(&serde_json::json!({
        "anthropic": {
            "clientToolsRaw": [
                {
                    "type": "function",
                    "function": {
                        "name": "Bash",
                        "parameters": {
                            "type": "object"
                        }
                    }
                }
            ]
        }
    }))
    .expect("client tools raw from anthropic semantics mirror");
    assert_eq!(output.len(), 1);
    assert_eq!(output[0]["function"]["name"].as_str(), Some("Bash"));
}

#[test]
fn resolve_alias_map_from_sources_derives_shell_command_alias_from_anthropic_client_tools_raw() {
    let output = resolve_alias_map_from_sources(
        &serde_json::json!({}),
        &serde_json::json!({
            "semantics": {
                "anthropic": {
                    "clientToolsRaw": [
                        {
                            "name": "Bash",
                            "input_schema": {
                                "type": "object",
                                "properties": {
                                    "command": { "type": "string" }
                                }
                            }
                        }
                    ]
                }
            }
        }),
    )
    .expect("derived alias map from anthropic client tools raw");
    assert_eq!(
        output.get("shell_command").and_then(|v| v.as_str()),
        Some("Bash")
    );
}

#[test]
fn resolve_provider_response_context_helpers_prefers_display_and_request_id_candidates() {
    let context = serde_json::json!({
        "requestId": "req_base",
        "groupRequestId": "req_group",
        "clientRequestId": "req_client",
        "modelId": "glm-4.7",
        "clientModelId": "glm-client",
        "originalModelId": "glm-original"
    });
    assert_eq!(
        resolve_display_model_from_context(&context),
        Some("glm-original".to_string())
    );
    assert_eq!(
        resolve_client_facing_request_id_from_context(&context),
        Some("req_client".to_string())
    );
}

#[test]
fn resolve_provider_response_context_helpers_parses_followup_and_tool_surface_mode() {
    assert!(resolve_truthy_flag(&Value::String("true".to_string())));
    assert!(resolve_truthy_flag(&Value::String("1".to_string())));
    assert!(!resolve_truthy_flag(&Value::String("false".to_string())));

    assert!(resolve_tool_surface_shadow_enabled(&Value::String(
        "shadow".to_string()
    )));
    assert!(resolve_tool_surface_shadow_enabled(&Value::String(
        "enforce".to_string()
    )));
    assert!(!resolve_tool_surface_shadow_enabled(&Value::String(
        "off".to_string()
    )));
    assert!(!resolve_tool_surface_shadow_enabled(&Value::String(
        "".to_string()
    )));

    assert_eq!(
        resolve_client_protocol_for_response_entry(Some("/v1/responses"), false),
        "openai-responses"
    );
    assert_eq!(
        resolve_client_protocol_for_response_entry(Some("/v1/messages"), false),
        "anthropic-messages"
    );
    assert_eq!(
        resolve_client_protocol_for_response_entry(Some("/v1/chat/completions"), false),
        "openai-chat"
    );
    assert_eq!(
        resolve_client_protocol_for_response_entry(Some("/v1/responses"), true),
        "openai-responses"
    );
}

#[test]
fn resolve_sse_stream_mode_supports_gemini_chat() {
    assert!(resolve_sse_stream_mode(true, "gemini-chat").unwrap());
    assert!(resolve_sse_stream_mode(true, " gemini-chat ").unwrap());
    assert!(!resolve_sse_stream_mode(false, "gemini-chat").unwrap());
    assert!(resolve_sse_stream_mode(true, " unknown-protocol ").is_err());
    assert!(resolve_sse_stream_mode(true, "gemini-chat-preview").is_err());
}

#[test]
fn resolve_clock_reservation_from_context_normalizes_valid_payload() {
    let output = resolve_clock_reservation_from_context(&serde_json::json!({
        "__clockReservation": {
            "reservationId": "  res-1  ",
            "sessionId": "  sess-1  ",
            "taskIds": ["  task-a  ", "", 1, "task-b"],
            "reservedAtMs": 1234.9
        }
    }))
    .expect("clock reservation");
    assert_eq!(
        output.get("reservationId").and_then(|v| v.as_str()),
        Some("res-1")
    );
    assert_eq!(
        output.get("sessionId").and_then(|v| v.as_str()),
        Some("sess-1")
    );
    assert_eq!(
        output.get("taskIds").and_then(|v| v.as_array()).cloned(),
        Some(vec![
            Value::String("task-a".to_string()),
            Value::String("task-b".to_string())
        ])
    );
    assert_eq!(
        output.get("reservedAtMs").and_then(|v| v.as_i64()),
        Some(1234)
    );
}

#[test]
fn resolve_clock_reservation_from_context_uses_now_when_reserved_at_invalid() {
    let start = now_unix_millis() as i64;
    let output = resolve_clock_reservation_from_context(&serde_json::json!({
        "__clockReservation": {
            "reservationId": "res-2",
            "sessionId": "sess-2",
            "taskIds": ["task-a"],
            "reservedAtMs": "invalid"
        }
    }))
    .expect("clock reservation");
    let resolved = output
        .get("reservedAtMs")
        .and_then(|v| v.as_i64())
        .expect("reservedAtMs");
    assert!(resolved >= start);
}

#[test]
fn resolve_clock_reservation_from_context_returns_none_when_required_fields_missing() {
    assert!(resolve_clock_reservation_from_context(&serde_json::json!({
        "__clockReservation": {
            "reservationId": "res-1",
            "taskIds": ["task-a"]
        }
    }))
    .is_none());
    assert!(resolve_clock_reservation_from_context(&serde_json::json!({
        "__clockReservation": {
            "reservationId": "res-1",
            "sessionId": "sess-1",
            "taskIds": []
        }
    }))
    .is_none());
}

// P0: encrypted-only reasoning should emit reasoning item but NOT empty message
#[test]
fn build_responses_payload_encrypted_only_reasoning_no_message() {
    let payload = serde_json::json!({
        "id": "resp-enc-1",
        "choices": [{
            "message": {
                "role": "assistant",
                "reasoning": { "encrypted_content": "opaque-sig-123" }
            }
        }]
    });
    let result = build_responses_payload_from_chat_core(
        &payload,
        Some("test_req"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("payload");
    let items = result["output"].as_array().expect("output array");
    let reasoning: Vec<_> = items.iter().filter(|i| i["type"] == "reasoning").collect();
    let messages: Vec<_> = items.iter().filter(|i| i["type"] == "message").collect();
    assert_eq!(
        reasoning.len(),
        1,
        "encrypted-only should emit reasoning item"
    );
    assert_eq!(
        messages.len(),
        0,
        "encrypted-only should NOT emit empty message"
    );
}

// P0: reasoning + content both present -> both emitted
#[test]
fn build_responses_payload_emits_both_when_reasoning_and_content_differ() {
    let payload = serde_json::json!({
        "id": "resp-both-1",
        "choices": [{
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "final answer"}],
                "reasoning": {
                    "summary": [{"type": "summary_text", "text": "thinking..."}],
                    "content": [{"type": "reasoning_text", "text": "processing..."}]
                }
            }
        }]
    });
    let result = build_responses_payload_from_chat_core(
        &payload,
        Some("test_req"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("payload");
    let items = result["output"].as_array().expect("output array");
    let reasoning: Vec<_> = items.iter().filter(|i| i["type"] == "reasoning").collect();
    let messages: Vec<_> = items.iter().filter(|i| i["type"] == "message").collect();
    assert_eq!(reasoning.len(), 1, "should emit reasoning");
    assert_eq!(messages.len(), 1, "should emit message");
}

// P0: reasoning-only with text summary -> both reasoning and message emitted
#[test]
fn build_responses_payload_only_reasoning_with_summary_emits_both() {
    let payload = serde_json::json!({
        "id": "resp-reasoning-only-1",
        "choices": [{
            "message": {
                "role": "assistant",
                "content": [],
                "reasoning": {
                    "summary": [{"type": "summary_text", "text": "thinking about this"}],
                    "content": [{"type": "reasoning_text", "text": "processing step 1..."}]
                }
            }
        }]
    });
    let result = build_responses_payload_from_chat_core(
        &payload,
        Some("test_req"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("payload");
    let items = result["output"].as_array().expect("output array");
    let reasoning: Vec<_> = items.iter().filter(|i| i["type"] == "reasoning").collect();
    let messages: Vec<_> = items.iter().filter(|i| i["type"] == "message").collect();
    // reasoning.summary present = has_text_reasoning = true -> message emitted
    assert_eq!(reasoning.len(), 1, "should emit reasoning item");
    assert_eq!(
        messages.len(),
        1,
        "reasoning with text summary should emit message too"
    );
}

// P0: reasoning text matches message text -> dedup: only message, no reasoning item
#[test]
fn build_responses_payload_deduplicates_reasoning_and_message_when_text_matches() {
    let payload = serde_json::json!({
        "id": "resp-dedup-1",
        "choices": [{
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "The answer is 42"}],
                "reasoning": {
                    "summary": [{"type": "summary_text", "text": "The answer is 42"}],
                    "content": [{"type": "reasoning_text", "text": "The answer is 42"}]
                }
            }
        }]
    });
    let result = build_responses_payload_from_chat_core(
        &payload,
        Some("test_req"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("payload");
    let items = result["output"].as_array().expect("output array");
    let reasoning: Vec<_> = items.iter().filter(|i| i["type"] == "reasoning").collect();
    let messages: Vec<_> = items.iter().filter(|i| i["type"] == "message").collect();
    assert_eq!(messages.len(), 1, "should emit message");
    assert_eq!(
        reasoning.len(),
        0,
        "matching reasoning+content should dedup reasoning"
    );
}

#[test]
fn build_responses_payload_from_chat_json_matches_core_shape() {
    let payload = serde_json::json!({
        "id": "chatcmpl_equiv",
        "model": "gpt-test",
        "choices": [{
            "message": {"role": "assistant", "content": " hello "},
            "finish_reason": "stop"
        }]
    });
    let context = serde_json::json!({"requestId":"req_equiv_outbound","toolsRaw":[]});
    let core =
        build_responses_payload_from_chat_core(&payload, Some("req_equiv_outbound"), &context)
            .expect("core");
    let json_out: serde_json::Value = serde_json::from_str(
        &build_responses_payload_from_chat_json(payload.to_string(), context.to_string())
            .expect("json"),
    )
    .unwrap();
    assert_eq!(json_out, core);
}
