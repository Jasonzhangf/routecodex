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
fn normalize_openai_chat_reasoning_outbound_projects_responses_payload_to_chat_completion() {
    let payload = serde_json::json!({
        "id": "resp_abc123",
        "object": "response",
        "created_at": 1780550359,
        "model": "gpt-5.5",
        "metadata": { "user_tag": "safe" },
        "parallel_tool_calls": true,
        "service_tier": "default",
        "reasoning": { "effort": "medium" },
        "status": "completed",
        "output": [{
            "id": "msg_abc123",
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "pong" }]
        }],
        "output_text": "pong",
        "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 }
    });

    let output = normalize_openai_chat_reasoning_outbound(&payload).expect("projected chat");

    assert_eq!(
        output["object"],
        Value::String("chat.completion".to_string())
    );
    assert_eq!(
        output["choices"][0]["message"]["content"],
        Value::String("pong".to_string())
    );
    assert_eq!(
        output["choices"][0]["finish_reason"],
        Value::String("stop".to_string())
    );
    assert_eq!(
        output["routecodex_response"]["metadata"]["user_tag"],
        Value::String("safe".to_string())
    );
    assert_eq!(
        output["routecodex_response"]["reasoning"]["effort"],
        Value::String("medium".to_string())
    );
    assert_eq!(
        output["routecodex_response"]["parallel_tool_calls"],
        Value::Bool(true)
    );
    assert_eq!(
        output["routecodex_response"]["service_tier"],
        Value::String("default".to_string())
    );
}

#[test]
fn normalize_openai_chat_reasoning_outbound_supplies_created_for_responses_payload_without_timestamp(
) {
    let payload = serde_json::json!({
        "id": "resp_no_created",
        "object": "response",
        "model": "gpt-5.5",
        "status": "completed",
        "output": [{
            "id": "msg_no_created",
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "pong" }]
        }],
        "output_text": "pong"
    });

    let output = normalize_openai_chat_reasoning_outbound(&payload).expect("projected chat");

    assert_eq!(
        output["object"],
        Value::String("chat.completion".to_string())
    );
    assert!(
        output["created"]
            .as_i64()
            .is_some_and(|created| created > 0),
        "Rust openai-chat client projection must provide created for SSE codec"
    );
}

#[test]
fn normalize_openai_chat_reasoning_outbound_supplies_created_for_chat_completion_without_timestamp()
{
    let payload = serde_json::json!({
        "id": "chatcmpl_no_created",
        "object": "chat.completion",
        "model": "gpt-5.5",
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": { "role": "assistant", "content": "pong" }
        }]
    });

    let output = normalize_openai_chat_reasoning_outbound(&payload).expect("projected chat");

    assert_eq!(
        output["object"],
        Value::String("chat.completion".to_string())
    );
    assert!(
        output["created"]
            .as_i64()
            .is_some_and(|created| created > 0),
        "Rust openai-chat client projection must provide created for chat SSE codec"
    );
}

#[test]
fn normalize_responses_usage_projects_responses_only_fields_from_anthropic_cache_shape() {
    let usage = json!({
        "cache_read_input_tokens": 28672,
        "input_tokens": 5076,
        "output_tokens": 16
    });

    let output = normalize_responses_usage(&usage);

    assert_eq!(output["input_tokens"], json!(5076.0));
    assert_eq!(output["output_tokens"], json!(16.0));
    assert_eq!(output["total_tokens"], json!(5092.0));
    assert_eq!(
        output["input_tokens_details"]["cached_tokens"],
        json!(28672.0)
    );
    assert!(output.get("prompt_tokens").is_none());
    assert!(output.get("completion_tokens").is_none());
    assert!(output.get("cache_read_input_tokens").is_none());
}

#[test]
fn normalize_responses_usage_projects_responses_only_fields_from_chat_shape() {
    let usage = json!({
        "prompt_tokens": 640,
        "completion_tokens": 2575,
        "total_tokens": 3215,
        "prompt_tokens_details": { "cached_tokens": 626 }
    });

    let output = normalize_responses_usage(&usage);

    assert_eq!(output["input_tokens"], json!(640.0));
    assert_eq!(output["output_tokens"], json!(2575.0));
    assert_eq!(output["total_tokens"], json!(3215.0));
    assert_eq!(
        output["input_tokens_details"]["cached_tokens"],
        json!(626.0)
    );
    assert!(output.get("prompt_tokens").is_none());
    assert!(output.get("completion_tokens").is_none());
    assert!(output.get("prompt_tokens_details").is_none());
}

#[test]
fn normalize_responses_usage_drops_invalid_provider_detail_fields_before_sse_projection() {
    let usage = json!({
        "input_tokens": 146536,
        "output_tokens": 0,
        "total_tokens": 146536,
        "input_tokens_details": {
            "cached_tokens": null,
            "provider_cache_hit_tokens": null
        },
        "output_tokens_details": {
            "reasoning_tokens": null
        }
    });

    let output = normalize_responses_usage(&usage);

    assert_eq!(output["input_tokens"], json!(146536.0));
    assert_eq!(output["output_tokens"], json!(0.0));
    assert_eq!(output["total_tokens"], json!(146536.0));
    assert!(output.get("input_tokens_details").is_none());
    assert!(output.get("output_tokens_details").is_none());
}

#[test]
fn normalize_chat_usage_projects_chat_shape_from_responses_style_fields() {
    let usage = json!({
        "input_tokens": 12,
        "output_tokens": 5,
        "prompt_cache_hit_tokens": 3
    });

    let output = normalize_chat_usage(&usage).expect("normalized chat usage");

    assert_eq!(output["prompt_tokens"], json!(12));
    assert_eq!(output["completion_tokens"], json!(5));
    assert_eq!(output["total_tokens"], json!(17));
    assert_eq!(output["prompt_tokens_details"]["cached_tokens"], json!(3));
}

#[test]
fn normalize_chat_usage_rejects_missing_token_fields() {
    let usage = json!({
        "prompt_tokens": 12
    });

    let error = normalize_chat_usage(&usage).expect_err("missing token fields must fail");
    assert_eq!(error, "Invalid Chat usage: missing token fields");
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
fn build_responses_payload_from_chat_fails_fast_when_choices_missing() {
    let payload = serde_json::json!({
        "id": "raw_nonstandard_response",
        "message": "upstream returned nonstandard payload"
    });

    let error = build_responses_payload_from_chat_core(
        &payload,
        Some("req_failed_model"),
        &serde_json::json!({ "model": "mimo-v2.5", "toolsRaw": [] }),
    )
    .unwrap_err();

    assert!(error.contains("upstream returned nonstandard payload"));
}

#[test]
fn build_responses_payload_from_chat_sanitizes_existing_response_shape_before_emitting() {
    let payload = serde_json::json!({
        "id": "resp_existing_shape",
        "object": "response",
        "status": "completed",
        "output": [{
            "id": "rs_existing_1",
            "type": "reasoning",
            "status": "completed",
            "summary": [{ "type": "summary_text", "text": "plan" }],
            "content": [{ "type": "reasoning_text", "text": "private reasoning" }],
            "encrypted_content": "opaque"
        },{
            "id": "fc_existing_1",
            "type": "function_call",
            "status": "in_progress",
            "name": "exec_command",
            "call_id": "call_existing_1",
            "arguments": "{\"cmd\":\"pwd\"}"
        }]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_existing_response"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");

    let output_items = output["output"].as_array().expect("output array");
    let serialized = serde_json::to_string(output_items).expect("serialize");
    assert!(!serialized.contains("\"content\""));
    assert!(!serialized.contains("\"status\":\"in_progress\""));
    assert!(!serialized.contains("\"status\":\"completed\""));
    assert!(serialized.contains("\"encrypted_content\":\"opaque\""));
}

#[test]
fn build_responses_payload_from_chat_preserves_client_model_over_upstream_provider_model() {
    let payload = serde_json::json!({
        "id": "chatcmpl_minimax_provider_model",
        "model": "MiniMax-M3",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "ok"
                },
                "finish_reason": "stop"
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_provider_model_mask"),
        &serde_json::json!({
            "model": "MiniMax-M3",
            "clientModelId": "gpt-5.5",
            "originalModelId": "gpt-5.5",
            "displayModel": "gpt-5.5",
            "toolsRaw": []
        }),
    )
    .expect("build responses payload");

    assert_eq!(output["model"], Value::String("gpt-5.5".to_string()));
    assert_eq!(output["output_text"], Value::String("ok".to_string()));
}

#[test]
fn build_responses_payload_from_anthropic_tool_use_preserves_structured_calls() {
    let payload = serde_json::json!({
        "id": "msg_minimax_tool_use",
        "type": "message",
        "role": "assistant",
        "model": "MiniMax-M3",
        "content": [
            { "type": "text", "text": "Jason，我先读项目状态。" },
            {
                "type": "tool_use",
                "id": "call_function_obb2jil9jfzs_1",
                "name": "exec_command",
                "input": { "cmd": "cd /Volumes/extension/code/zterm && ls -la", "yield_time_ms": 5000 }
            },
            {
                "type": "tool_use",
                "id": "call_function_obb2jil9jfzs_2",
                "name": "read_mcp_resource",
                "input": { "server": "filesystem", "uri": "file:///Volumes/extension/code/zterm/mac/CACHE.md" }
            }
        ],
        "stop_reason": "tool_use"
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_minimax_tool_use"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");

    assert_eq!(
        output["status"],
        Value::String("requires_action".to_string())
    );
    assert_eq!(
        output["output_text"],
        Value::String("Jason，我先读项目状态。".to_string())
    );
    assert!(!output["output_text"]
        .as_str()
        .unwrap_or("")
        .contains("minimax:tool_call"));

    let output_items = output["output"].as_array().cloned().expect("output array");
    let function_items: Vec<&Value> = output_items
        .iter()
        .filter(|item| item["type"] == Value::String("function_call".to_string()))
        .collect();
    assert_eq!(function_items.len(), 2);
    assert_eq!(
        function_items[0]["name"],
        Value::String("exec_command".to_string())
    );
    assert_eq!(
        function_items[0]["call_id"],
        Value::String("call_function_obb2jil9jfzs_1".to_string())
    );
    let args: Value = serde_json::from_str(function_items[0]["arguments"].as_str().unwrap())
        .expect("arguments json");
    assert_eq!(
        args["cmd"],
        Value::String("cd /Volumes/extension/code/zterm && ls -la".to_string())
    );
    let required_calls = output["required_action"]["submit_tool_outputs"]["tool_calls"]
        .as_array()
        .cloned()
        .expect("required tool calls");
    assert_eq!(required_calls.len(), 2);
}

#[test]
fn build_responses_payload_from_anthropic_tool_use_drops_antml_calls_marker_text() {
    let payload = serde_json::json!({
        "id": "msg_antml_tool_marker",
        "type": "message",
        "role": "assistant",
        "model": "MiniMax-M3",
        "content": [
            { "type": "text", "text": "<antml function=\"calls\">[" },
            {
                "type": "tool_use",
                "id": "call_function_antml_1",
                "name": "exec_command",
                "input": { "cmd": "echo ok" }
            }
        ],
        "stop_reason": "tool_use"
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_antml_marker"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");

    assert_eq!(
        output["status"],
        Value::String("requires_action".to_string())
    );
    assert_eq!(output["output_text"], Value::Null);
    let serialized = serde_json::to_string(&output).unwrap();
    assert!(!serialized.contains("<antml"));
    assert!(!serialized.contains("function=\\\"calls\\\""));
    let function_items: Vec<&Value> = output["output"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == Value::String("function_call".to_string()))
        .collect();
    assert_eq!(function_items.len(), 1);
    assert_eq!(
        function_items[0]["call_id"],
        Value::String("call_function_antml_1".to_string())
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
    assert_eq!(with_tool_calls["shouldFailEmptyOutput"], Value::Bool(true));

    let max_tokens_empty = resolve_anthropic_chat_completion_outcome(Some("max_tokens"), 0, false);
    assert_eq!(
        max_tokens_empty["finishReason"],
        Value::String("length".to_string())
    );
    assert_eq!(max_tokens_empty["shouldFailEmptyOutput"], Value::Bool(true));

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
    assert_eq!(
        without_tool_calls["shouldFailEmptyOutput"],
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
fn normalize_responses_tool_call_arguments_for_client_projects_freeform_apply_patch_as_raw_patch() {
    let raw_args = serde_json::to_string(&json!({
        "patch": "*** Begin Patch\n*** Add File: tmp/apft/01-hello.txt\n+hello from apply_patch\n*** End Patch"
    }))
    .unwrap();
    let payload = json!({
        "output": [{
            "type": "function_call",
            "call_id": "call_apply_patch",
            "name": "apply_patch",
            "arguments": raw_args
        }],
        "required_action": {
            "type": "submit_tool_outputs",
            "submit_tool_outputs": {
                "tool_calls": [{
                    "id": "call_apply_patch",
                    "type": "function",
                    "name": "apply_patch",
                    "arguments": raw_args,
                    "function": {
                        "name": "apply_patch",
                        "arguments": raw_args
                    }
                }]
            }
        }
    });
    let tools = json!([{
        "type": "custom",
        "name": "apply_patch",
        "description": "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
        "format": {
            "type": "grammar",
            "syntax": "lark",
                    "definition": "start: begin_patch hunk+ end_patch\nbegin_patch: \"*** Begin Patch\" LF\nend_patch: \"*** End Patch\" LF?\nhunk: add_hunk | delete_hunk | update_hunk\nadd_hunk: \"*** Add File: \" filename LF add_line+\ndelete_hunk: \"*** Delete File: \" filename LF\nupdate_hunk: \"*** Update File: \" filename LF change_move? change?\nfilename: /(.+)/\nadd_line: \"+\" /(.*)/ LF\nchange_move: \"*** Move to: \" filename LF\nchange: (change_context | change_line)+ eof_line?\nchange_context: (\"@@\" | \"@@ \" /(.+)/) LF\nchange_line: (\"+\" | \"-\" | \" \") /(.*)/ LF\neof_line: \"*** End of File\" LF\n%import common.LF"
        }
    }]);

    let output = normalize_responses_tool_call_arguments_for_client(&payload, &tools);
    let expected =
        "*** Begin Patch\n*** Add File: tmp/apft/01-hello.txt\n+hello from apply_patch\n*** End Patch";

    assert_eq!(output["output"][0]["arguments"], expected);
    assert_eq!(
        output["required_action"]["submit_tool_outputs"]["tool_calls"][0]["arguments"],
        expected
    );
    assert_eq!(
        output["required_action"]["submit_tool_outputs"]["tool_calls"][0]["function"]["arguments"],
        expected
    );
}

fn freeform_apply_patch_tool_fixture() -> Value {
    json!([{
        "type": "custom",
        "name": "apply_patch",
        "description": "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
        "format": {
            "type": "grammar",
            "syntax": "lark",
                    "definition": "start: begin_patch hunk+ end_patch\nbegin_patch: \"*** Begin Patch\" LF\nend_patch: \"*** End Patch\" LF?\nhunk: add_hunk | delete_hunk | update_hunk\nadd_hunk: \"*** Add File: \" filename LF add_line+\ndelete_hunk: \"*** Delete File: \" filename LF\nupdate_hunk: \"*** Update File: \" filename LF change_move? change?\nfilename: /(.+)/\nadd_line: \"+\" /(.*)/ LF\nchange_move: \"*** Move to: \" filename LF\nchange: (change_context | change_line)+ eof_line?\nchange_context: (\"@@\" | \"@@ \" /(.+)/) LF\nchange_line: (\"+\" | \"-\" | \" \") /(.*)/ LF\neof_line: \"*** End of File\" LF\n%import common.LF"
        }
    }])
}

#[test]
fn project_responses_client_body_for_client_projects_freeform_apply_patch_custom_tool_call() {
    let patch =
        "*** Begin Patch\n*** Add File: tmp/apft/01-body.txt\n+hello from body\n*** End Patch";
    let raw_args = serde_json::to_string(&json!({ "patch": patch })).unwrap();
    let payload = json!({
        "id": "resp_apply_patch_body",
        "object": "response",
        "status": "requires_action",
        "output": [{
            "type": "function_call",
            "call_id": "call_apply_patch",
            "name": "apply_patch",
            "arguments": raw_args
        }],
        "required_action": {
            "type": "submit_tool_outputs",
            "submit_tool_outputs": {
                "tool_calls": [{
                    "id": "call_apply_patch",
                    "type": "function",
                    "name": "apply_patch",
                    "arguments": raw_args,
                    "function": {
                        "name": "apply_patch",
                        "arguments": raw_args
                    }
                }]
            }
        }
    });
    let output =
        project_responses_client_body_for_client(&payload, &freeform_apply_patch_tool_fixture());

    assert_eq!(output["output"][0]["type"], "custom_tool_call");
    assert_eq!(output["output"][0]["name"], "apply_patch");
    assert_eq!(output["output"][0]["call_id"], "call_apply_patch");
    assert_eq!(output["output"][0]["input"], patch);
    assert_eq!(
        output["required_action"]["submit_tool_outputs"]["tool_calls"][0]["arguments"],
        patch
    );
}

#[test]
fn project_responses_client_payload_for_client_restores_client_visible_response_fields() {
    let payload = json!({
        "type": "response.completed",
        "response": {
            "id": "resp_restore",
            "object": "response",
            "status": "completed",
            "model": "provider-internal-model",
            "reasoning": { "summary": "kept" },
            "output": []
        }
    });
    let output = project_responses_client_payload_for_client(
        &payload,
        &json!([]),
        &json!({
            "clientModelId": "client-visible-model",
            "reasoning": { "effort": "high" }
        }),
    );

    assert_eq!(output["response"]["model"], "client-visible-model");
    assert_eq!(output["response"]["reasoning"]["effort"], "high");
    assert_eq!(output["response"]["reasoning"]["summary"], "kept");
}

#[test]
fn project_responses_client_payload_for_client_restores_direct_response_body_model() {
    let payload = json!({
        "id": "resp_restore_direct",
        "object": "response",
        "status": "completed",
        "output": []
    });
    let output = project_responses_client_payload_for_client(
        &payload,
        &json!([]),
        &json!({
            "originalRequest": {
                "model": "client-visible-direct-model"
            }
        }),
    );

    assert_eq!(output["model"], "client-visible-direct-model");
}

#[test]
fn plan_responses_json_client_dispatch_bypasses_direct_without_projection_context() {
    let plan = plan_responses_json_client_dispatch(&json!({
        "entryEndpoint": "/v1/responses",
        "continuationOwner": "direct",
        "hasRequestContextToolsRaw": false
    }));

    assert_eq!(plan["action"], json!("direct_passthrough"));
    assert_eq!(
        plan["reason"],
        json!("direct_continuation_without_projection_context")
    );
}

#[test]
fn plan_responses_json_client_dispatch_projects_relay_and_direct_with_context() {
    let direct_with_context = plan_responses_json_client_dispatch(&json!({
        "entryEndpoint": "/v1/responses",
        "continuationOwner": "direct",
        "hasRequestContextToolsRaw": true
    }));
    let relay = plan_responses_json_client_dispatch(&json!({
        "entryEndpoint": "/v1/responses.submit_tool_outputs",
        "continuationOwner": "relay",
        "hasRequestContextToolsRaw": true
    }));

    assert_eq!(
        direct_with_context["action"],
        json!("project_client_payload")
    );
    assert_eq!(relay["action"], json!("project_client_payload"));
}

#[test]
fn project_responses_client_payload_for_client_synthesizes_required_action_for_pending_function_calls(
) {
    let payload = json!({
        "type": "response.completed",
        "response": {
            "id": "resp_pending_exec",
            "object": "response",
            "status": "completed",
            "model": "provider-internal-model",
            "output": [{
                "id": "fc_call_exec_1",
                "type": "function_call",
                "status": "completed",
                "name": "exec_command",
                "call_id": "call_exec_1",
                "arguments": "{\"cmd\":\"pwd\"}"
            }]
        }
    });
    let output = project_responses_client_payload_for_client(&payload, &json!([]), &json!({}));

    assert_eq!(output["response"]["status"], "requires_action");
    assert_eq!(
        output["response"]["required_action"]["submit_tool_outputs"]["tool_calls"][0]["id"],
        "call_exec_1"
    );
    assert_eq!(
        output["response"]["required_action"]["submit_tool_outputs"]["tool_calls"][0]["function"]
            ["name"],
        "exec_command"
    );
    assert_eq!(
        output["response"]["required_action"]["submit_tool_outputs"]["tool_calls"][0]["function"]
            ["arguments"],
        "{\"cmd\":\"pwd\"}"
    );
}

#[test]
fn project_responses_client_payload_for_client_preserves_stopless_cli_command_arguments() {
    let cmd = "routecodex hook run reasoningStop --input-json '{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1,\"triggerHint\":\"stop_schema_continue_next_step\"}' --session-id 'manual-stopless-live-1782569604975' --request-id 'openai-responses-orangeai.key1-glm-5.2-20260627T221325004-413357-1890' --repeat-count '1' --max-repeats '3'";
    let args = serde_json::to_string(&json!({ "cmd": cmd })).expect("serialize args");
    let payload = json!({
        "id": "resp_stopless_cli_projection",
        "object": "response",
        "status": "requires_action",
        "output": [{
            "id": "fc_call_stopless",
            "type": "function_call",
            "status": "completed",
            "name": "exec_command",
            "call_id": "call_stopless",
            "arguments": args
        }],
        "required_action": {
            "type": "submit_tool_outputs",
            "submit_tool_outputs": {
                "tool_calls": [{
                    "id": "call_stopless",
                    "type": "function",
                    "name": "exec_command",
                    "arguments": args,
                    "function": {
                        "name": "exec_command",
                        "arguments": args
                    }
                }]
            }
        }
    });
    let tools_raw = json!([{
        "type": "function",
        "name": "exec_command",
        "parameters": {
            "type": "object",
            "properties": {
                "cmd": { "type": "string" }
            },
            "required": ["cmd"],
            "additionalProperties": false
        }
    }]);

    let output = project_responses_client_payload_for_client(&payload, &tools_raw, &json!({}));
    let projected_args = output["required_action"]["submit_tool_outputs"]["tool_calls"][0]
        ["function"]["arguments"]
        .as_str()
        .expect("projected arguments");
    let parsed: Value = serde_json::from_str(projected_args).expect("arguments stay valid JSON");

    assert_eq!(parsed["cmd"], Value::String(cmd.to_string()));
    assert_eq!(
        output["output"][0]["arguments"],
        Value::String(args.to_string())
    );
}

#[test]
fn project_responses_client_payload_for_client_keeps_completed_when_tool_output_already_present() {
    let payload = json!({
        "type": "response.completed",
        "response": {
            "id": "resp_completed_exec",
            "object": "response",
            "status": "completed",
            "model": "provider-internal-model",
            "tool_outputs": [{
                "tool_call_id": "call_exec_1",
                "output": "/tmp/ws"
            }],
            "output": [{
                "id": "fc_call_exec_1",
                "type": "function_call",
                "status": "completed",
                "name": "exec_command",
                "call_id": "call_exec_1",
                "arguments": "{\"cmd\":\"pwd\"}"
            }]
        }
    });
    let output = project_responses_client_payload_for_client(&payload, &json!([]), &json!({}));

    assert_eq!(output["response"]["status"], "completed");
    assert!(output["response"].get("required_action").is_none());
}

#[test]
fn project_responses_client_payload_for_client_strips_replay_unsafe_reasoning_content_and_status_fields(
) {
    let payload = json!({
        "type": "response.completed",
        "response": {
            "id": "resp_replay_unsafe_fields",
            "object": "response",
            "status": "completed",
            "model": "provider-internal-model",
            "output": [
                {
                    "id": "rs_1",
                    "type": "reasoning",
                    "status": "completed",
                    "summary": [{ "type": "summary_text", "text": "thinking..." }],
                    "content": [{ "type": "reasoning_text", "text": "private reasoning" }],
                    "encrypted_content": "opaque"
                },
                {
                    "id": "fc_1",
                    "type": "function_call",
                    "status": "in_progress",
                    "name": "exec_command",
                    "call_id": "call_1",
                    "arguments": "{\"cmd\":\"pwd\"}"
                },
                {
                    "id": "fco_1",
                    "type": "function_call_output",
                    "status": "completed",
                    "call_id": "call_1",
                    "output": "/tmp"
                }
            ]
        }
    });

    let output = project_responses_client_payload_for_client(&payload, &json!([]), &json!({}));
    let response = output["response"].as_object().expect("response object");
    let items = response["output"].as_array().expect("output array");
    let serialized = serde_json::to_string(items).expect("serialize");

    assert!(!serialized.contains("\"content\""));
    assert!(!serialized.contains("\"status\":\"completed\""));
    assert!(!serialized.contains("\"status\":\"in_progress\""));
    assert!(serialized.contains("\"encrypted_content\":\"opaque\""));
}

#[test]
fn project_responses_client_payload_for_client_strips_internal_metadata_fields() {
    let payload = json!({
        "id": "resp_client_metadata_strip",
        "object": "response",
        "status": "completed",
        "metadata": {
            "routeHint": "search",
            "providerKey": "internal.provider"
        },
        "output": [{
            "id": "msg_client_metadata_strip",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "metadata": {
                "routeHint": "tools"
            },
            "content": [{
                "type": "output_text",
                "text": "ok",
                "metadata": {
                    "debug": true
                }
            }]
        }]
    });

    let output = project_responses_client_payload_for_client(&payload, &json!([]), &json!({}));
    let serialized = serde_json::to_string(&output).expect("serialize output");

    assert_eq!(output["id"], "resp_client_metadata_strip");
    assert_eq!(output["output"][0]["content"][0]["text"], "ok");
    assert!(!serialized.contains("\"metadata\""));
    assert!(!serialized.contains("internal.provider"));
    assert!(!serialized.contains("routeHint"));
}

#[test]
fn project_responses_client_payload_for_client_strips_codex_transcript_tool_call_leak() {
    let leaked = r#"Assistant requested tool calls: - id=call_00_wpSa0J6o4cVOVh9s20T3294 type=function name=exec_command arguments={"cmd":"cd /Users/fanzhang/Documents/github/routecodex && awk test mod virtual_router_hit_log"}"#;
    let payload = json!({
        "id": "resp_codex_tool_leak",
        "object": "response",
        "status": "completed",
        "output_text": leaked,
        "output": [{
            "id": "msg_codex_tool_leak",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{
                "type": "output_text",
                "text": leaked
            }]
        }]
    });

    let output = project_responses_client_payload_for_client(&payload, &json!([]), &json!({}));
    let serialized = serde_json::to_string(&output).expect("serialize output");

    assert!(!serialized.contains("Assistant requested tool calls"));
    assert!(!serialized.contains("call_00_wpSa0J6o4cVOVh9s20T3294"));
    assert!(!serialized.contains("virtual_router_hit_log"));
    assert_eq!(output["output_text"], "");
    assert_eq!(output["output"][0]["content"][0]["text"], "");
}

#[test]
fn project_responses_client_payload_for_client_mixed_message_and_function_calls_uses_standard_requires_action(
) {
    let payload = json!({
        "type": "response.completed",
        "response": {
            "id": "resp_mixed_pending",
            "object": "response",
            "status": "completed",
            "model": "provider-internal-model",
            "output_text": "must not be client-visible before tool outputs",
            "output": [
                {
                    "id": "msg_mixed_1",
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "must not be client-visible before tool outputs"
                        }
                    ]
                },
                {
                    "id": "fc_call_exec_1",
                    "type": "function_call",
                    "status": "completed",
                    "name": "exec_command",
                    "call_id": "call_exec_1",
                    "arguments": "{\"cmd\":\"pwd\"}"
                },
                {
                    "id": "fc_call_exec_2",
                    "type": "function_call",
                    "status": "completed",
                    "name": "exec_command",
                    "call_id": "call_exec_2",
                    "arguments": "{\"cmd\":\"ls\"}"
                }
            ]
        }
    });
    let output = project_responses_client_payload_for_client(&payload, &json!([]), &json!({}));

    assert_eq!(output["response"]["status"], "requires_action");
    assert_eq!(output["response"]["output_text"], Value::Null);
    assert_eq!(
        output["response"]["required_action"]["submit_tool_outputs"]["tool_calls"][0]["id"],
        "call_exec_1"
    );
    assert_eq!(
        output["response"]["required_action"]["submit_tool_outputs"]["tool_calls"][1]["id"],
        "call_exec_2"
    );
    let output_items = output["response"]["output"]
        .as_array()
        .cloned()
        .expect("output array");
    assert!(output_items
        .iter()
        .all(|item| item["type"] != Value::String("message".to_string())));
}

#[test]
fn project_responses_sse_frame_for_client_strips_codex_transcript_tool_call_leak() {
    let leaked = r#"Assistant requested tool calls: - id=call_00_wpSa0J6o4cVOVh9s20T3294 type=function name=exec_command arguments={"cmd":"cd /Users/fanzhang/Documents/github/routecodex && awk test mod virtual_router_hit_log"}"#;
    let payload = json!({
        "type": "response.output_text.delta",
        "content_index": 0,
        "output_index": 0,
        "item_id": "msg_codex_tool_leak",
        "delta": leaked
    });
    let frame = format!(
        "event: response.output_text.delta\ndata: {}\n\n",
        serde_json::to_string(&payload).unwrap()
    );

    let output = project_responses_sse_frame_for_client(
        &frame,
        Some("response.output_text.delta"),
        &payload,
        &json!([]),
        &json!({}),
        &json!({}),
    );

    let output_frame = output["frame"].as_str().expect("frame");
    assert!(!output_frame.contains("Assistant requested tool calls"));
    assert!(!output_frame.contains("call_00_wpSa0J6o4cVOVh9s20T3294"));
    assert!(!output_frame.contains("virtual_router_hit_log"));
    assert!(output_frame.contains("\"delta\":\"\""));
}

#[test]
fn project_responses_sse_frame_for_client_strips_replay_unsafe_fields_from_response_completed_frame(
) {
    let frame = format!(
        "event: response.completed\ndata: {}\n\n",
        serde_json::to_string(&json!({
            "type": "response.completed",
            "response": {
                "id": "resp_sse_replay_unsafe",
                "object": "response",
                "status": "completed",
                "output": [
                    {
                        "id": "rs_sse_1",
                        "type": "reasoning",
                        "status": "completed",
                        "summary": [{ "type": "summary_text", "text": "plan" }],
                        "content": [{ "type": "reasoning_text", "text": "private reasoning" }]
                    },
                    {
                        "id": "fc_sse_1",
                        "type": "function_call",
                        "status": "in_progress",
                        "name": "exec_command",
                        "call_id": "call_sse_1",
                        "arguments": "{\"cmd\":\"pwd\"}"
                    }
                ]
            }
        }))
        .unwrap()
    );

    let output = project_responses_sse_frame_for_client(
        &frame,
        Some("response.completed"),
        &json!({
            "type": "response.completed",
            "response": {
                "id": "resp_sse_replay_unsafe",
                "object": "response",
                "status": "completed",
                "output": [
                    {
                        "id": "rs_sse_1",
                        "type": "reasoning",
                        "status": "completed",
                        "summary": [{ "type": "summary_text", "text": "plan" }],
                        "content": [{ "type": "reasoning_text", "text": "private reasoning" }]
                    },
                    {
                        "id": "fc_sse_1",
                        "type": "function_call",
                        "status": "in_progress",
                        "name": "exec_command",
                        "call_id": "call_sse_1",
                        "arguments": "{\"cmd\":\"pwd\"}"
                    }
                ]
            }
        }),
        &json!([]),
        &json!({}),
        &json!({}),
    );

    let output_frame = output["frame"].as_str().expect("frame");
    assert!(!output_frame.contains("\"content\":[{\"type\":\"reasoning_text\""));
    assert!(!output_frame.contains("\"status\":\"in_progress\""));
    assert!(!output_frame.contains("\"type\":\"reasoning\",\"status\""));
}

#[test]
fn project_responses_sse_frame_for_client_suppresses_apply_patch_deltas_and_projects_done() {
    let patch =
        "*** Begin Patch\n*** Add File: tmp/apft/01-sse.txt\n+hello from sse\n*** End Patch";
    let raw_args = serde_json::to_string(&json!({ "patch": patch })).unwrap();
    let mut state = json!({});
    let added_frame = format!(
        "event: response.output_item.added\ndata: {}\n\n",
        serde_json::to_string(&json!({
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "name": "apply_patch",
                "call_id": "call_patch",
                "arguments": ""
            }
        }))
        .unwrap()
    );
    let added = project_responses_sse_frame_for_client(
        added_frame.as_str(),
        Some("response.output_item.added"),
        &json!({
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "name": "apply_patch",
                "call_id": "call_patch",
                "arguments": ""
            }
        }),
        &freeform_apply_patch_tool_fixture(),
        &json!({}),
        &state,
    );
    assert_eq!(added["emit"], false);
    assert_eq!(added["frame"], "");
    state = added["state"].clone();
    assert_eq!(state["applyPatchCallIds"][0], "call_patch");

    let delta = project_responses_sse_frame_for_client(
        "event: response.function_call_arguments.delta\ndata: {}\n\n",
        Some("response.function_call_arguments.delta"),
        &json!({
            "type": "response.function_call_arguments.delta",
            "call_id": "call_patch",
            "delta": raw_args
        }),
        &freeform_apply_patch_tool_fixture(),
        &json!({}),
        &state,
    );
    assert_eq!(delta["emit"], false);
    state = delta["state"].clone();

    let done = project_responses_sse_frame_for_client(
        "event: response.function_call_arguments.done\ndata: {}\n\n",
        Some("response.function_call_arguments.done"),
        &json!({
            "type": "response.function_call_arguments.done",
            "name": "apply_patch",
            "call_id": "call_patch",
            "arguments": raw_args
        }),
        &freeform_apply_patch_tool_fixture(),
        &json!({}),
        &state,
    );
    assert_eq!(done["emit"], true);
    let frame = done["frame"].as_str().unwrap();
    assert!(frame.contains("event: response.output_item.done"));
    assert!(frame.contains("\"type\":\"custom_tool_call\""));
    assert!(frame.contains("\"input\""));
    assert!(frame.contains("tmp/apft/01-sse.txt"));

    let duplicate_done = project_responses_sse_frame_for_client(
        "event: response.function_call_arguments.done\ndata: {}\n\n",
        Some("response.function_call_arguments.done"),
        &json!({
            "type": "response.function_call_arguments.done",
            "name": "apply_patch",
            "call_id": "call_patch",
            "arguments": raw_args
        }),
        &freeform_apply_patch_tool_fixture(),
        &json!({}),
        &done["state"],
    );
    assert_eq!(duplicate_done["emit"], false);
}

#[test]
fn project_responses_sse_frame_for_client_uses_pending_apply_patch_delta_when_done_has_empty_arguments(
) {
    let patch =
        "*** Begin Patch\n*** Add File: tmp/apft/01-sse-empty-done.txt\n+hello from pending delta\n*** End Patch";
    let raw_args = serde_json::to_string(&json!({ "patch": patch })).unwrap();
    let mut state = json!({});

    let added = project_responses_sse_frame_for_client(
        "event: response.output_item.added\ndata: {}\n\n",
        Some("response.output_item.added"),
        &json!({
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "name": "apply_patch",
                "call_id": "call_patch_pending",
                "arguments": ""
            }
        }),
        &freeform_apply_patch_tool_fixture(),
        &json!({}),
        &state,
    );
    assert_eq!(added["emit"], false);
    state = added["state"].clone();

    let delta = project_responses_sse_frame_for_client(
        "event: response.function_call_arguments.delta\ndata: {}\n\n",
        Some("response.function_call_arguments.delta"),
        &json!({
            "type": "response.function_call_arguments.delta",
            "call_id": "call_patch_pending",
            "delta": raw_args
        }),
        &freeform_apply_patch_tool_fixture(),
        &json!({}),
        &state,
    );
    assert_eq!(delta["emit"], false);
    state = delta["state"].clone();

    let done = project_responses_sse_frame_for_client(
        "event: response.output_item.done\ndata: {}\n\n",
        Some("response.output_item.done"),
        &json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "name": "apply_patch",
                "call_id": "call_patch_pending",
                "arguments": ""
            }
        }),
        &freeform_apply_patch_tool_fixture(),
        &json!({}),
        &state,
    );
    assert_eq!(done["emit"], true);
    let frame = done["frame"].as_str().unwrap();
    assert!(frame.contains("event: response.output_item.done"));
    assert!(frame.contains("\"type\":\"custom_tool_call\""));
    assert!(frame.contains("tmp/apft/01-sse-empty-done.txt"));
}

#[test]
fn project_responses_sse_frame_for_client_uses_pending_apply_patch_delta_when_done_omits_name() {
    let patch =
        "*** Begin Patch\n*** Add File: tmp/apft/01-sse-missing-name.txt\n+hello from pending delta without name\n*** End Patch";
    let raw_args = serde_json::to_string(&json!({ "patch": patch })).unwrap();
    let mut state = json!({});

    let added = project_responses_sse_frame_for_client(
        "event: response.output_item.added\ndata: {}\n\n",
        Some("response.output_item.added"),
        &json!({
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "name": "apply_patch",
                "call_id": "call_patch_missing_name",
                "arguments": ""
            }
        }),
        &freeform_apply_patch_tool_fixture(),
        &json!({}),
        &state,
    );
    assert_eq!(added["emit"], false);
    state = added["state"].clone();

    let delta = project_responses_sse_frame_for_client(
        "event: response.function_call_arguments.delta\ndata: {}\n\n",
        Some("response.function_call_arguments.delta"),
        &json!({
            "type": "response.function_call_arguments.delta",
            "call_id": "call_patch_missing_name",
            "delta": raw_args
        }),
        &freeform_apply_patch_tool_fixture(),
        &json!({}),
        &state,
    );
    assert_eq!(delta["emit"], false);
    state = delta["state"].clone();

    let done = project_responses_sse_frame_for_client(
        "event: response.output_item.done\ndata: {}\n\n",
        Some("response.output_item.done"),
        &json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_patch_missing_name",
                "arguments": ""
            }
        }),
        &freeform_apply_patch_tool_fixture(),
        &json!({}),
        &state,
    );
    assert_eq!(done["emit"], true);
    let frame = done["frame"].as_str().unwrap();
    assert!(frame.contains("event: response.output_item.done"));
    assert!(frame.contains("\"type\":\"custom_tool_call\""));
    assert!(frame.contains("tmp/apft/01-sse-missing-name.txt"));
}

#[test]
fn project_responses_sse_frame_for_client_strips_stop_schema_from_reasoning_added_event() {
    let projected = project_responses_sse_frame_for_client(
        "event: response.output_item.added\ndata: {}\n\n",
        Some("response.output_item.added"),
        &json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {
                "id": "reasoning_stop_schema_1",
                "type": "reasoning",
                "status": "in_progress",
                "summary": [{
                    "type": "summary_text",
                    "text": "**Thinking** keep going\n<rcc_stop_schema>\n{\"stopreason\":2,\"reason\":\"continue\"}\n</rcc_stop_schema>"
                }]
            }
        }),
        &json!([]),
        &json!({}),
        &json!({}),
    );

    assert_eq!(projected["emit"], true);
    let frame = projected["frame"].as_str().expect("frame");
    assert!(frame.contains("event: response.output_item.added"));
    assert!(frame.contains("**Thinking** keep going"));
    assert!(!frame.contains("<rcc_stop_schema>"));
    assert!(!frame.contains("\"status\":\"in_progress\""));
}

#[test]
fn project_responses_sse_frame_for_client_replays_obfuscated_output_text_delta_from_done_text() {
    let delta = project_responses_sse_frame_for_client(
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"item_id\":\"msg_whitespace_1\",\"delta\":\"line\",\"obfuscation\":\"abc\"}\n\n",
        Some("response.output_text.delta"),
        &json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "content_index": 0,
            "item_id": "msg_whitespace_1",
            "delta": "line",
            "obfuscation": "abc",
        }),
        &json!([]),
        &json!({}),
        &json!({}),
    );
    assert_eq!(delta["emit"], false);

    let done = project_responses_sse_frame_for_client(
        "event: response.output_text.done\ndata: {\"type\":\"response.output_text.done\",\"output_index\":0,\"content_index\":0,\"item_id\":\"msg_whitespace_1\",\"text\":\"- line one\\n- line two\"}\n\n",
        Some("response.output_text.done"),
        &json!({
            "type": "response.output_text.done",
            "output_index": 0,
            "content_index": 0,
            "item_id": "msg_whitespace_1",
            "text": "- line one\n- line two",
        }),
        &json!([]),
        &json!({}),
        &delta["state"],
    );
    assert_eq!(done["emit"], true);
    let frame = done["frame"].as_str().expect("frame");
    assert!(frame.contains("event: response.output_text.delta"));
    assert!(frame.contains("\"delta\":\"- line one\\n- line two\""));
    assert!(frame.contains("event: response.output_text.done"));
    assert!(frame.contains("\"text\":\"- line one\\n- line two\""));
}

#[test]
fn project_responses_sse_frame_for_client_preserves_output_text_delta_spacing() {
    let projected = project_responses_sse_frame_for_client(
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"item_id\":\"msg_spacing_1\",\"delta\":\" leading space\"}\n\n",
        Some("response.output_text.delta"),
        &json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "content_index": 0,
            "item_id": "msg_spacing_1",
            "delta": " leading space",
        }),
        &json!([]),
        &json!({}),
        &json!({}),
    );
    assert_eq!(projected["emit"], true);
    let frame = projected["frame"].as_str().expect("frame");
    assert!(frame.contains("\"delta\":\" leading space\""));

    let projected = project_responses_sse_frame_for_client(
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"item_id\":\"msg_spacing_2\",\"delta\":\"The quick \"}\n\n",
        Some("response.output_text.delta"),
        &json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "content_index": 0,
            "item_id": "msg_spacing_2",
            "delta": "The quick ",
        }),
        &json!([]),
        &json!({}),
        &json!({}),
    );
    assert_eq!(projected["emit"], true);
    let frame = projected["frame"].as_str().expect("frame");
    assert!(frame.contains("\"delta\":\"The quick \""));
}

#[test]
fn project_responses_sse_frame_for_client_replays_obfuscated_reasoning_summary_delta_from_done_text(
) {
    let delta = project_responses_sse_frame_for_client(
        "event: response.reasoning_summary_text.delta\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"summary_index\":0,\"item_id\":\"rs_whitespace_1\",\"delta\":\"Drafting\",\"obfuscation\":\"abc\"}\n\n",
        Some("response.reasoning_summary_text.delta"),
        &json!({
            "type": "response.reasoning_summary_text.delta",
            "output_index": 0,
            "summary_index": 0,
            "item_id": "rs_whitespace_1",
            "delta": "Drafting",
            "obfuscation": "abc",
        }),
        &json!([]),
        &json!({}),
        &json!({}),
    );
    assert_eq!(delta["emit"], false);

    let done = project_responses_sse_frame_for_client(
        "event: response.reasoning_summary_text.done\ndata: {\"type\":\"response.reasoning_summary_text.done\",\"output_index\":0,\"summary_index\":0,\"item_id\":\"rs_whitespace_1\",\"text\":\"**Thinking**\\n- first\\n- second\"}\n\n",
        Some("response.reasoning_summary_text.done"),
        &json!({
            "type": "response.reasoning_summary_text.done",
            "output_index": 0,
            "summary_index": 0,
            "item_id": "rs_whitespace_1",
            "text": "**Thinking**\n- first\n- second",
        }),
        &json!([]),
        &json!({}),
        &delta["state"],
    );
    assert_eq!(done["emit"], true);
    let frame = done["frame"].as_str().expect("frame");
    assert!(frame.contains("event: response.reasoning_summary_text.delta"));
    assert!(frame.contains("\"delta\":\"**Thinking**\\n- first\\n- second\""));
    assert!(frame.contains("event: response.reasoning_summary_text.done"));
}

#[test]
fn project_responses_sse_frame_for_client_keeps_completed_function_call_frame_standard() {
    let frame = format!(
        "event: response.completed\ndata: {}\n\n",
        serde_json::to_string(&json!({
            "type": "response.completed",
            "response": {
                "id": "resp_pending_exec_sse",
                "object": "response",
                "status": "completed",
                "model": "provider-internal-model",
                "output": [{
                    "id": "fc_call_exec_sse_1",
                    "type": "function_call",
                    "status": "completed",
                    "name": "exec_command",
                    "call_id": "call_exec_sse_1",
                    "arguments": "{\"cmd\":\"pwd\"}"
                }]
            }
        }))
        .unwrap()
    );

    let projected = project_responses_sse_frame_for_client(
        &frame,
        Some("response.completed"),
        &json!({
            "type": "response.completed",
            "response": {
                "id": "resp_pending_exec_sse",
                "object": "response",
                "status": "completed",
                "model": "provider-internal-model",
                "output": [{
                    "id": "fc_call_exec_sse_1",
                    "type": "function_call",
                    "status": "completed",
                    "name": "exec_command",
                    "call_id": "call_exec_sse_1",
                    "arguments": "{\"cmd\":\"pwd\"}"
                }]
            }
        }),
        &json!([]),
        &json!({}),
        &json!({}),
    );

    assert_eq!(projected["emit"], Value::Bool(true));
    let output_frame = projected["frame"].as_str().expect("frame");
    assert!(output_frame.contains("event: response.completed"));
    assert!(output_frame.contains("\"status\":\"completed\""));
    assert!(!output_frame.contains("\"required_action\""));
    assert!(!output_frame.contains("\"status\":\"requires_action\""));
    assert!(output_frame.contains("\"call_exec_sse_1\""));
}

#[test]
fn project_responses_sse_frame_for_client_keeps_completed_when_tool_output_already_present() {
    let frame = format!(
        "event: response.completed\ndata: {}\n\n",
        serde_json::to_string(&json!({
            "type": "response.completed",
            "response": {
                "id": "resp_completed_exec_sse",
                "object": "response",
                "status": "completed",
                "model": "provider-internal-model",
                "tool_outputs": [{
                    "tool_call_id": "call_exec_sse_1",
                    "output": "/tmp/ws"
                }],
                "output": [{
                    "id": "fc_call_exec_sse_1",
                    "type": "function_call",
                    "status": "completed",
                    "name": "exec_command",
                    "call_id": "call_exec_sse_1",
                    "arguments": "{\"cmd\":\"pwd\"}"
                }]
            }
        }))
        .unwrap()
    );

    let projected = project_responses_sse_frame_for_client(
        &frame,
        Some("response.completed"),
        &json!({
            "type": "response.completed",
            "response": {
                "id": "resp_completed_exec_sse",
                "object": "response",
                "status": "completed",
                "model": "provider-internal-model",
                "tool_outputs": [{
                    "tool_call_id": "call_exec_sse_1",
                    "output": "/tmp/ws"
                }],
                "output": [{
                    "id": "fc_call_exec_sse_1",
                    "type": "function_call",
                    "status": "completed",
                    "name": "exec_command",
                    "call_id": "call_exec_sse_1",
                    "arguments": "{\"cmd\":\"pwd\"}"
                }]
            }
        }),
        &json!([]),
        &json!({}),
        &json!({}),
    );

    assert_eq!(projected["emit"], Value::Bool(true));
    let output_frame = projected["frame"].as_str().expect("frame");
    assert!(output_frame.contains("\"status\":\"completed\""));
    assert!(!output_frame.contains("\"required_action\""));
}

#[test]
fn project_responses_sse_frame_for_client_keeps_terminal_frame_unchanged() {
    let frame = "event: response.done\ndata: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_1\"}}\n\n";
    let output = project_responses_sse_frame_for_client(
        frame,
        Some("response.done"),
        &json!({ "type": "response.done", "response": { "id": "resp_1" } }),
        &freeform_apply_patch_tool_fixture(),
        &json!({}),
        &json!({}),
    );
    assert_eq!(output["emit"], true);
    assert_eq!(output["frame"], frame);
}

#[test]
fn project_responses_sse_frame_for_client_removes_required_action_from_terminal_done() {
    let frame = format!(
        "event: response.done\ndata: {}\n\n",
        serde_json::to_string(&json!({
            "type": "response.done",
            "response": {
                "id": "resp_terminal_tool",
                "object": "response",
                "status": "requires_action",
                "output": [{
                    "id": "fc_call_exec_terminal",
                    "type": "function_call",
                    "status": "in_progress",
                    "name": "exec_command",
                    "call_id": "call_exec_terminal",
                    "arguments": "{\"cmd\":\"pwd\"}"
                }],
                "required_action": {
                    "type": "submit_tool_outputs",
                    "submit_tool_outputs": {
                        "tool_calls": [{
                            "id": "call_exec_terminal",
                            "type": "function",
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"pwd\"}"
                        }]
                    }
                }
            }
        }))
        .unwrap()
    );
    let output = project_responses_sse_frame_for_client(
        &frame,
        Some("response.done"),
        &json!({
            "type": "response.done",
            "response": {
                "id": "resp_terminal_tool",
                "object": "response",
                "status": "requires_action",
                "output": [{
                    "id": "fc_call_exec_terminal",
                    "type": "function_call",
                    "status": "in_progress",
                    "name": "exec_command",
                    "call_id": "call_exec_terminal",
                    "arguments": "{\"cmd\":\"pwd\"}"
                }],
                "required_action": {
                    "type": "submit_tool_outputs",
                    "submit_tool_outputs": {
                        "tool_calls": [{
                            "id": "call_exec_terminal",
                            "type": "function",
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"pwd\"}"
                        }]
                    }
                }
            }
        }),
        &json!([]),
        &json!({}),
        &json!({}),
    );

    assert_eq!(output["emit"], true);
    let output_frame = output["frame"].as_str().expect("frame");
    assert!(output_frame.contains("event: response.done"));
    assert!(output_frame.contains("\"status\":\"completed\""));
    assert!(output_frame.contains("\"type\":\"function_call\""));
    assert!(!output_frame.contains("\"required_action\""));
    assert!(!output_frame.contains("\"status\":\"requires_action\""));
    assert!(!output_frame.contains("\"status\":\"in_progress\""));
}

#[test]
fn project_responses_sse_frame_for_client_keeps_required_action_terminal_frame_visible() {
    let frame = format!(
        "event: response.required_action\ndata: {}\n\n",
        serde_json::to_string(&json!({
            "type": "response.required_action",
            "response": {
                "id": "resp_required_action_visible",
                "object": "response",
                "status": "requires_action",
                "output": [{
                    "id": "fc_call_exec_sse_1",
                    "type": "function_call",
                    "status": "completed",
                    "name": "exec_command",
                    "call_id": "call_exec_sse_1",
                    "arguments": "{\"cmd\":\"pwd\"}"
                }]
            },
            "required_action": {
                "type": "submit_tool_outputs",
                "submit_tool_outputs": {
                    "tool_calls": [{
                        "id": "call_exec_sse_1",
                        "type": "function",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"pwd\"}"
                    }]
                }
            }
        }))
        .unwrap()
    );
    let output = project_responses_sse_frame_for_client(
        &frame,
        Some("response.required_action"),
        &json!({
            "type": "response.required_action",
            "response": {
                "id": "resp_required_action_visible",
                "object": "response",
                "status": "requires_action",
                "output": [{
                    "id": "fc_call_exec_sse_1",
                    "type": "function_call",
                    "status": "completed",
                    "name": "exec_command",
                    "call_id": "call_exec_sse_1",
                    "arguments": "{\"cmd\":\"pwd\"}"
                }]
            },
            "required_action": {
                "type": "submit_tool_outputs",
                "submit_tool_outputs": {
                    "tool_calls": [{
                        "id": "call_exec_sse_1",
                        "type": "function",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"pwd\"}"
                    }]
                }
            }
        }),
        &json!([]),
        &json!({}),
        &json!({}),
    );
    assert_eq!(output["emit"], true);
    let output_frame = output["frame"].as_str().expect("frame");
    assert!(!output_frame.contains("event: response.required_action"));
    assert!(!output_frame.contains("\"required_action\""));
    assert!(output_frame.contains("event: response.output_item.added"));
    assert!(output_frame.contains("event: response.function_call_arguments.delta"));
    assert!(output_frame.contains("event: response.function_call_arguments.done"));
    assert!(output_frame.contains("event: response.output_item.done"));
    assert!(output_frame.contains("\"call_exec_sse_1\""));
    assert!(output_frame.contains("\"exec_command\""));
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
            "__routecodexPreselectedRoute": { "providerKey": "mini27.key1.MiniMax-M2.7" },
            "__raw_request_body": { "model": "mini27.MiniMax-M2.7" },
            "target": { "providerKey": "mini27.key1.MiniMax-M2.7" },
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
    assert!(output.get("metadata").is_none());
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
fn build_responses_payload_from_chat_does_not_project_context_or_source_metadata() {
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

    assert!(output.get("metadata").is_none());
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
    assert!(reasoning_item.get("content").is_none());
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
    assert_eq!(
        output_items[0]["type"],
        Value::String("reasoning".to_string())
    );
    assert!(output_items[0].get("content").is_none());
    assert_eq!(
        output_items[0]["summary"][0]["text"],
        Value::String(
            "**Thinking** Need original upstream reasoning before calling pwd.".to_string()
        )
    );
    assert_eq!(
        output_items[1]["type"],
        Value::String("function_call".to_string())
    );
    assert_eq!(
        output_items[1]["name"],
        Value::String("exec_command".to_string())
    );
}

#[test]
fn build_responses_payload_from_chat_drops_visible_text_when_tool_calls_are_pending() {
    let payload = serde_json::json!({
        "id": "resp_pending_tool_text",
        "model": "MiniMax-M3",
        "choices": [
            {
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": "关键测试已经看到了。现在我有了完整证据链。先把这些结论直接记到 note.md，再给你出只读审计报告。",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "search_content",
                                "arguments": "{\"context\":3,\"path\":\"note.md\",\"pattern\":\"2026-06-24|2026-06-25\"}"
                            }
                        }
                    ]
                }
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_pending_tool_text"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");

    let output_items = output["output"].as_array().expect("output array");
    let message_items = output_items
        .iter()
        .filter(|item| item["type"] == Value::String("message".to_string()))
        .collect::<Vec<_>>();
    assert!(
        message_items.is_empty(),
        "pending tool-call response must not retain visible assistant text item"
    );
    let function_calls = output_items
        .iter()
        .filter(|item| item["type"] == Value::String("function_call".to_string()))
        .collect::<Vec<_>>();
    assert_eq!(function_calls.len(), 1);
    assert_eq!(
        function_calls[0]["name"],
        Value::String("search_content".to_string())
    );
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
    assert!(reasoning_item.get("content").is_none());
    assert_eq!(reasoning_item["encrypted_content"], Value::Null);
}

#[test]
fn build_responses_payload_from_chat_reasoning_only_does_not_emit_duplicate_message_item() {
    let payload = serde_json::json!({
        "id": "resp_reasoning_only_no_message",
        "model": "gpt-5.2",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning": {
                        "summary": [{ "type": "summary_text", "text": "Let me inspect tool_call_entry.rs." }],
                        "content": [{ "type": "reasoning_text", "text": "Let me inspect tool_call_entry.rs." }]
                    }
                }
            }
        ]
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_reasoning_only_no_message"),
        &serde_json::json!({ "toolsRaw": [] }),
    )
    .expect("build responses payload");

    let output_items = output["output"].as_array().expect("output array");
    assert_eq!(output_items.len(), 1);
    assert_eq!(
        output_items[0]["type"],
        Value::String("reasoning".to_string())
    );
    assert!(output_items
        .iter()
        .all(|item| item["type"] != Value::String("message".to_string())));
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
fn resolve_provider_response_context_helpers_omits_request_id_when_context_has_no_candidate() {
    let context = serde_json::json!({
        "modelId": "glm-4.7"
    });
    assert_eq!(
        resolve_client_facing_request_id_from_context(&context),
        None
    );
    assert_eq!(
        resolve_display_model_from_context(&context),
        Some("glm-4.7".to_string())
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
fn project_post_servertool_hub_resp_outbound_04_projects_responses_endpoint() {
    let payload = serde_json::json!({
        "id": "chatcmpl_post_servertool",
        "model": "upstream-model",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "done"
                }
            }
        ]
    });
    let semantics = serde_json::json!({
        "displayModel": "client-model"
    });
    let output = project_post_servertool_hub_resp_outbound_04_client_semantic(
        &payload,
        Some("/v1/responses"),
        Some("req_post_servertool"),
        &semantics,
    )
    .expect("project post-servertool client semantic");
    assert_eq!(output["object"], Value::String("response".to_string()));
    assert_eq!(
        output["request_id"],
        Value::String("req_post_servertool".to_string())
    );
    assert_eq!(output["model"], Value::String("upstream-model".to_string()));
    assert!(output.get("choices").is_none());
}

#[test]
fn project_post_servertool_hub_resp_outbound_04_keeps_non_responses_payload() {
    let payload = serde_json::json!({
        "id": "chatcmpl_post_servertool",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "done"
                }
            }
        ]
    });
    let output = project_post_servertool_hub_resp_outbound_04_client_semantic(
        &payload,
        Some("/v1/chat/completions"),
        Some("req_post_servertool"),
        &serde_json::json!({}),
    )
    .expect("project post-servertool client semantic");
    assert_eq!(output, payload);
}

#[test]
fn resolve_sse_stream_mode_supports_gemini_chat() {
    assert!(resolve_sse_stream_mode(true, "gemini-chat").unwrap());
    assert!(resolve_sse_stream_mode(true, " gemini-chat ").unwrap());
    assert!(!resolve_sse_stream_mode(false, "gemini-chat").unwrap());
    assert!(!resolve_sse_stream_mode(true, " unknown-protocol ").unwrap());
    assert!(!resolve_sse_stream_mode(true, "gemini-chat-preview").unwrap());
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
    assert!(
        reasoning[0].get("content").is_none(),
        "responses client payload must not leak reasoning.content back to client history"
    );
}

// P0: reasoning-only with text summary -> reasoning item only, no empty message
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
    assert_eq!(reasoning.len(), 1, "should emit reasoning item");
    assert_eq!(
        messages.len(),
        0,
        "reasoning-only should not emit an empty message"
    );
    assert!(
        reasoning[0].get("content").is_none(),
        "responses client payload must keep reasoning summary only"
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
fn build_responses_payload_from_chat_never_emits_reasoning_content_in_client_payload() {
    let payload = serde_json::json!({
        "id": "resp-no-reasoning-content",
        "model": "gpt-5.4",
        "choices": [{
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "final"}],
                "reasoning": {
                    "summary": [{"type": "summary_text", "text": "plan"}],
                    "content": [{"type": "reasoning_text", "text": "private reasoning"}],
                    "encrypted_content": "opaque"
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

    let reasoning_item = result["output"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["type"] == "reasoning"))
        .cloned()
        .expect("reasoning output item");
    assert!(reasoning_item.get("content").is_none());
    assert_eq!(
        reasoning_item["summary"][0]["text"],
        Value::String("**Thinking** plan".to_string())
    );
    assert_eq!(
        reasoning_item["encrypted_content"],
        Value::String("opaque".to_string())
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
    assert_eq!(json_out["object"], Value::String("response".to_string()));
    assert_eq!(core["object"], Value::String("response".to_string()));
    assert!(
        json_out["id"]
            .as_str()
            .map(|value| value.starts_with("resp_"))
            .unwrap_or(false),
        "json wrapper should allocate a Responses id"
    );
    assert!(
        core["id"]
            .as_str()
            .map(|value| value.starts_with("resp_"))
            .unwrap_or(false),
        "core should allocate a Responses id"
    );
    let mut stable_json_out = json_out;
    let mut stable_core = core;
    if let Some(row) = stable_json_out.as_object_mut() {
        row.remove("id");
        row.remove("created_at");
    }
    if let Some(row) = stable_core.as_object_mut() {
        row.remove("id");
        row.remove("created_at");
    }
    assert_eq!(stable_json_out, stable_core);
}

#[test]
fn build_responses_payload_from_chat_core_supplies_created_at_for_existing_response_payload() {
    let payload = serde_json::json!({
        "id": "resp_existing_without_created_at",
        "object": "response",
        "created_at": 0,
        "status": "requires_action",
        "model": "gpt-test",
        "output": [{
            "id": "fc_existing_call",
            "type": "function_call",
            "status": "completed",
            "name": "exec_command",
            "call_id": "call_existing",
            "arguments": "{\"cmd\":\"pwd\"}"
        }],
        "required_action": {
            "type": "submit_tool_outputs",
            "submit_tool_outputs": {
                "tool_calls": [{
                    "id": "call_existing",
                    "type": "function",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"pwd\"}"
                }]
            }
        }
    });

    let output = build_responses_payload_from_chat_core(
        &payload,
        Some("req_existing_response_created_at"),
        &serde_json::json!({}),
    )
    .expect("responses payload");

    assert_eq!(output["object"], Value::String("response".to_string()));
    assert!(
        output["created_at"]
            .as_i64()
            .is_some_and(|created_at| created_at > 0),
        "Rust Responses client projection must provide created_at before SSE encoding"
    );
    assert_eq!(
        output["status"],
        Value::String("requires_action".to_string())
    );
    assert!(output["required_action"].is_object());
}
