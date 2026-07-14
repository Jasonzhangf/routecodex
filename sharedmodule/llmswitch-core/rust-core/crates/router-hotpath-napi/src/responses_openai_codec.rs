use napi::bindgen_prelude::Result as NapiResult;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::hub_bridge_actions::{convert_bridge_input_to_chat_messages, BridgeInputToChatInput};
use crate::shared_json_utils::read_trimmed_string;
use crate::shared_responses_conversation_utils::normalize_responses_request_input_for_chat_codec;

// feature_id: conversion.shared.responses_openai
// canonical_builder: stage_a_conversion_shared_responses_openai_owner_boundary
pub(crate) fn stage_a_conversion_shared_responses_openai_owner_boundary() {}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResponsesOpenAiRequestOptions {
    #[serde(default)]
    request_id: Option<String>,
}

fn parse_options<T>(options_json: Option<String>) -> NapiResult<T>
where
    T: for<'de> Deserialize<'de> + Default,
{
    match options_json {
        Some(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(&raw).map_err(|e| napi::Error::from_reason(e.to_string()))
        }
        _ => Ok(T::default()),
    }
}

fn parse_value(raw: &str) -> NapiResult<Value> {
    serde_json::from_str(raw).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn stringify_value(value: &Value) -> NapiResult<String> {
    serde_json::to_string(value).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn extract_tool_call_id_style(payload: &Map<String, Value>) -> Option<Value> {
    payload.get("toolCallIdStyle").cloned().or_else(|| {
        payload
            .get("metadata")
            .and_then(|v| v.as_object())
            .and_then(|row| row.get("toolCallIdStyle"))
            .cloned()
    })
}

fn resolve_embedded_responses_context(payload: &Map<String, Value>) -> Option<Value> {
    let metadata = payload.get("metadata")?.as_object()?;
    metadata
        .get("responsesContext")
        .or_else(|| metadata.get("contextSnapshot"))
        .filter(|value| value.is_object())
        .cloned()
}

fn append_local_images(messages: Vec<Value>) -> NapiResult<Vec<Value>> {
    let raw = crate::hub_bridge_actions::append_local_image_block_on_latest_user_input_json(
        serde_json::json!({ "messages": messages }).to_string(),
    )?;
    let parsed = parse_value(&raw)?;
    Ok(parsed
        .as_object()
        .and_then(|row| row.get("messages"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default())
}

fn input_contains_tool_continuation_signals(input: &[Value]) -> bool {
    input.iter().any(|entry| {
        let Some(entry_obj) = entry.as_object() else {
            return false;
        };
        matches!(
            entry_obj
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("message")
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "function_call"
                | "tool_call"
                | "custom_tool_call"
                | "function_call_output"
                | "custom_tool_call_output"
                | "tool_result"
                | "tool_message"
        )
    })
}

fn build_request_from_responses_payload(
    payload_row: &Map<String, Value>,
    context: &Value,
) -> Result<Value, String> {
    let context_row = context
        .as_object()
        .ok_or_else(|| "responses-openai request context must be an object".to_string())?;
    let chat_messages = context_row
        .get("chatMessages")
        .and_then(|v| v.as_array())
        .filter(|messages| !messages.is_empty())
        .cloned();
    let raw_input = context_row
        .get("input")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let has_tool_continuation_signals =
        input_contains_tool_continuation_signals(raw_input.as_slice());
    let input = normalize_responses_request_input_for_chat_codec(raw_input);
    let tools = context_row
        .get("toolsNormalized")
        .and_then(|v| v.as_array())
        .cloned();
    let prefer_chat_messages_shortcut = !has_tool_continuation_signals;
    let messages = if prefer_chat_messages_shortcut {
        if let Some(messages) = chat_messages {
            messages
        } else {
            convert_bridge_input_to_chat_messages(BridgeInputToChatInput {
                input,
                tools: tools.clone(),
                tool_result_fallback_text: Some(String::new()),
                normalize_function_name: Some("responses".to_string()),
                allow_pending_terminal_tool_call: Some(true),
                allow_orphan_tool_result: Some(false),
            })?
            .messages
        }
    } else {
        convert_bridge_input_to_chat_messages(BridgeInputToChatInput {
            input,
            tools: tools.clone(),
            tool_result_fallback_text: Some(String::new()),
            normalize_function_name: Some("responses".to_string()),
            allow_pending_terminal_tool_call: Some(true),
            allow_orphan_tool_result: Some(false),
        })?
        .messages
    };
    let messages = append_local_images(messages).map_err(|e| e.to_string())?;
    if messages.is_empty() {
        return Err("Responses payload produced no chat messages".to_string());
    }

    let mut request = Map::new();
    if let Some(model) = payload_row.get("model") {
        request.insert("model".to_string(), model.clone());
    }
    request.insert("messages".to_string(), Value::Array(messages));
    if let Some(system_instruction) = context_row
        .get("systemInstruction")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request.insert(
            "instructions".to_string(),
            Value::String(system_instruction.to_string()),
        );
    }

    for key in [
        "top_p",
        "tool_choice",
        "parallel_tool_calls",
        "user",
        "logit_bias",
        "seed",
        "response_format",
    ] {
        if let Some(value) = payload_row.get(key) {
            request.insert(key.to_string(), value.clone());
        }
    }

    if let Some(max_output_tokens) = payload_row.get("max_output_tokens") {
        request.insert("max_output_tokens".to_string(), max_output_tokens.clone());
    } else if let Some(max_tokens) = payload_row.get("max_tokens") {
        request.insert("max_output_tokens".to_string(), max_tokens.clone());
    }

    if let Some(tool_defs) = tools.filter(|entries| !entries.is_empty()) {
        request.insert("tools".to_string(), Value::Array(tool_defs));
    }

    Ok(Value::Object(request))
}

pub fn run_responses_openai_request_codec_json(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    let options: ResponsesOpenAiRequestOptions = parse_options(options_json)?;
    let payload = parse_value(&payload_json)?;
    let payload_row = payload.as_object().cloned().ok_or_else(|| {
        napi::Error::from_reason("responses-openai request payload must be an object".to_string())
    })?;

    let context = if let Some(existing) = resolve_embedded_responses_context(&payload_row) {
        existing
    } else {
        let capture_input = serde_json::json!({
            "rawRequest": Value::Object(payload_row.clone()),
            "requestId": options.request_id,
            "toolCallIdStyle": extract_tool_call_id_style(&payload_row),
        });
        let context_raw = crate::hub_req_inbound_context_capture::capture_req_inbound_responses_context_snapshot_json(
            capture_input.to_string(),
        )?;
        parse_value(&context_raw)?
    };
    let request = build_request_from_responses_payload(&payload_row, &context)
        .map_err(napi::Error::from_reason)?;

    stringify_value(&serde_json::json!({
        "request": request,
        "context": context,
    }))
}

pub fn run_responses_openai_response_codec_json(
    payload_json: String,
    context_json: String,
) -> NapiResult<String> {
    let context = parse_value(&context_json)?;
    let context_row = context.as_object().cloned().unwrap_or_default();
    let request_id = read_trimmed_string(context_row.get("requestId"));
    let endpoint = read_trimmed_string(context_row.get("entryEndpoint"))
        .or_else(|| read_trimmed_string(context_row.get("endpoint")));
    let stream = context_row
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let reasoning_mode = context_row
        .get("metadata")
        .and_then(|v| v.as_object())
        .and_then(|row| read_trimmed_string(row.get("reasoningMode")));

    let normalized_chat = crate::openai_openai_codec::run_openai_openai_response_codec_json(
        payload_json,
        Some(
            serde_json::json!({
                "requestId": request_id,
                "endpoint": endpoint,
                "stream": stream,
                "reasoningMode": reasoning_mode,
                "idPrefixBase": "reasoning_choice",
            })
            .to_string(),
        ),
    )?;

    crate::hub_resp_outbound_client_semantics::build_responses_payload_from_chat_json(
        normalized_chat,
        context_json,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anthropic_openai_codec::build_anthropic_from_openai_chat_json;
    use crate::stopless_current_turn::STOPLESS_TRANSPARENT_CONTINUATION_PROMPT;
    use serde_json::json;

    #[test]
    fn request_codec_maps_responses_input_into_chat_request_and_context() {
        let raw = run_responses_openai_request_codec_json(
            json!({
                "model": "gpt-4.1",
                "stream": true,
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "run pwd" }
                        ]
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "cmd": { "type": "string" }
                            }
                        }
                    }
                ]
            })
            .to_string(),
            Some(json!({ "requestId": "req_responses_codec" }).to_string()),
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        let request = &value["request"];
        let context = &value["context"];
        assert_eq!(request["model"], Value::String("gpt-4.1".to_string()));
        assert_eq!(
            request["messages"][0]["role"],
            Value::String("user".to_string())
        );
        assert_eq!(
            request["messages"][0]["content"],
            Value::String("run pwd".to_string())
        );
        assert!(request.get("stream").is_none());
        assert_eq!(
            request["tools"][0]["name"],
            Value::String("exec_command".to_string())
        );
        assert_eq!(
            context["requestId"],
            Value::String("req_responses_codec".to_string())
        );
        assert_eq!(
            context["toolsNormalized"][0]["name"],
            Value::String("exec_command".to_string())
        );
    }

    #[test]
    fn request_codec_restores_context_system_instruction_into_chat_instructions() {
        let payload_row = json!({
            "model": "gpt-4.1",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "keep going" }
                    ]
                }
            ]
        });
        let context = json!({
            "input": payload_row["input"],
            "chatMessages": [
                {
                    "role": "user",
                    "content": "keep going"
                }
            ],
            "systemInstruction": "stopreason 取值：0=finished，1=blocked，2=continue_needed"
        });
        let request = build_request_from_responses_payload(
            payload_row.as_object().expect("payload row"),
            &context,
        )
        .expect("request");

        assert_eq!(
            request.get("instructions").and_then(Value::as_str),
            Some("stopreason 取值：0=finished，1=blocked，2=continue_needed")
        );
    }

    #[test]
    fn request_codec_rejects_orphan_tool_output_with_previous_response_id() {
        let err = run_responses_openai_request_codec_json(
            json!({
                "model": "gpt-4.1",
                "previous_response_id": "resp_prev_1",
                "input": [
                    {
                        "type": "function_call_output",
                        "call_id": "native:run_command:3",
                        "output": "/Users/fanzhang/Documents/github/routecodex"
                    }
                ]
            })
            .to_string(),
            Some(json!({ "requestId": "req_responses_submit_tool_output" }).to_string()),
        )
        .unwrap_err();
        assert!(err.to_string().contains("orphan_tool_result"));
        assert!(err.to_string().contains("native:run_command:3"));
    }

    #[test]
    fn request_codec_preserves_paired_responses_tool_continuation() {
        let raw = run_responses_openai_request_codec_json(
            json!({
                "model": "gpt-4.1",
                "previous_response_id": "resp_prev_1",
                "stream": true,
                "input": [
                    {
                        "type": "function_call",
                        "id": "fc_call_probe_1",
                        "call_id": "call_probe_1",
                        "name": "probe_tool",
                        "arguments": "{\"query\":\"routecodex_probe\"}"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_call_probe_1",
                        "call_id": "call_probe_1",
                        "output": "TOOL_RESULT_ROUTE_CODEX_OK"
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "probe_tool",
                        "parameters": { "type": "object", "properties": {} }
                    }
                ]
            })
            .to_string(),
            Some(json!({ "requestId": "req_responses_paired_tool_continuation" }).to_string()),
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        let messages = value["request"]["messages"]
            .as_array()
            .expect("request messages");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], Value::String("assistant".to_string()));
        assert_eq!(
            messages[0]["tool_calls"][0]["id"],
            Value::String("call_probe_1".to_string())
        );
        assert_eq!(
            messages[0]["tool_calls"][0]["function"]["name"],
            Value::String("probe_tool".to_string())
        );
        assert_eq!(messages[1]["role"], Value::String("tool".to_string()));
        assert_eq!(
            messages[1]["tool_call_id"],
            Value::String("call_probe_1".to_string())
        );
        assert_eq!(
            messages[1]["content"],
            Value::String("TOOL_RESULT_ROUTE_CODEX_OK".to_string())
        );
    }

    #[test]
    fn request_codec_then_anthropic_codec_preserves_responses_tool_pair_order() {
        let raw = run_responses_openai_request_codec_json(
            json!({
                "model": "router-gpt-5.5",
                "previous_response_id": "resp_prev_1",
                "stream": true,
                "input": [
                    {
                        "type": "function_call",
                        "id": "fc_call_probe_1",
                        "call_id": "call_probe_1",
                        "name": "probe_tool",
                        "arguments": "{\"query\":\"routecodex_probe\"}"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_call_probe_1",
                        "call_id": "call_probe_1",
                        "output": "TOOL_RESULT_ROUTE_CODEX_OK"
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "继续" }
                        ]
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "probe_tool",
                        "parameters": { "type": "object", "properties": {} }
                    }
                ]
            })
            .to_string(),
            Some(json!({ "requestId": "req_responses_to_anthropic_tool_pair" }).to_string()),
        )
        .unwrap();

        let openai_chat: Value = serde_json::from_str(&raw).unwrap();
        let anthropic_raw =
            build_anthropic_from_openai_chat_json(openai_chat["request"].to_string(), None)
                .expect("anthropic build success");
        let anthropic: Value = serde_json::from_str(&anthropic_raw).unwrap();
        let messages = anthropic["messages"]
            .as_array()
            .expect("anthropic messages");

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], json!("assistant"));
        assert_eq!(messages[0]["content"][0]["type"], json!("tool_use"));
        assert_eq!(messages[0]["content"][0]["id"], json!("call_probe_1"));
        assert_eq!(messages[0]["content"][0]["name"], json!("probe_tool"));
        assert_eq!(messages[1]["role"], json!("user"));
        assert_eq!(messages[1]["content"][0]["type"], json!("tool_result"));
        assert_eq!(
            messages[1]["content"][0]["tool_use_id"],
            json!("call_probe_1")
        );
        assert_eq!(
            messages[1]["content"][0]["content"],
            json!("TOOL_RESULT_ROUTE_CODEX_OK")
        );
        assert_eq!(messages[2]["role"], json!("user"));
        assert_eq!(messages[2]["content"][0]["type"], json!("text"));
        assert_eq!(messages[2]["content"][0]["text"], json!("继续"));
    }

    #[test]
    fn request_codec_then_anthropic_codec_preserves_public_tool_pair_before_stopless_pair() {
        let raw = run_responses_openai_request_codec_json(
            json!({
                "model": "router-gpt-5.5",
                "previous_response_id": "resp_prev_1",
                "stream": true,
                "input": [
                    {
                        "type": "function_call",
                        "id": "fc_call_public",
                        "call_id": "call_public",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"curl /api/catalog\"}"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_call_public",
                        "call_id": "call_public",
                        "output": "{\"owner\":\"backend\"}"
                    },
                    {
                        "type": "function_call",
                        "id": "fc_stopless",
                        "call_id": "call_stopless",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3}'\"}"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_stopless",
                        "call_id": "call_stopless",
                        "output": "{\"ok\":true,\"kind\":\"stop_message_auto\",\"tool\":\"stop_message_auto\",\"summary\":\"stopless continuation ready\"}"
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "exec_command",
                        "parameters": { "type": "object", "properties": {} }
                    }
                ]
            })
            .to_string(),
            Some(json!({ "requestId": "req_responses_to_anthropic_public_then_stopless" }).to_string()),
        )
        .unwrap();

        let openai_chat: Value = serde_json::from_str(&raw).unwrap();
        let anthropic_raw =
            build_anthropic_from_openai_chat_json(openai_chat["request"].to_string(), None)
                .expect("anthropic build success");
        let anthropic: Value = serde_json::from_str(&anthropic_raw).unwrap();
        let messages = anthropic["messages"]
            .as_array()
            .expect("anthropic messages");
        let tool_use_index = messages
            .iter()
            .position(|message| {
                message["content"].as_array().is_some_and(|content| {
                    content.iter().any(|part| {
                        part["type"].as_str() == Some("tool_use")
                            && part["id"].as_str() == Some("call_public")
                    })
                })
            })
            .expect("public tool_use");
        let result_message = messages
            .get(tool_use_index + 1)
            .expect("public tool_result");
        assert_eq!(result_message["role"], json!("user"));
        assert_eq!(result_message["content"][0]["type"], json!("tool_result"));
        assert_eq!(
            result_message["content"][0]["tool_use_id"],
            json!("call_public")
        );
        assert_eq!(
            result_message["content"][0]["content"],
            json!("{\"owner\":\"backend\"}")
        );
    }

    #[test]
    fn request_codec_preserves_stopless_cli_result_as_data_before_chatprocess_hook() {
        let raw = run_responses_openai_request_codec_json(
            json!({
                "model": "gpt-5.5",
                "previous_response_id": "resp_prev_stopless_1",
                "stream": false,
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "第一轮 stopless 指令" }
                        ]
                    },
                    {
                        "type": "reasoning",
                        "id": "reasoning_prev_1",
                        "summary": [
                            { "type": "summary_text", "text": "**Thinking** 第一轮推理" }
                        ]
                    },
                    {
                        "type": "function_call",
                        "id": "fc_stopless_1",
                        "call_id": "call_stopless_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json '{}'\"}"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_stopless_1",
                        "call_id": "call_stopless_1",
                        "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"summary\":\"stopless continuation ready\",\"repeatCount\":2,\"maxRepeats\":3,\"continuationPrompt\":\"继续。\",\"schemaFeedback\":{\"reasonCode\":\"stop_schema_missing\",\"missingFields\":[\"stopreason\",\"reason\",\"next_step\"]},\"schemaGuidance\":{\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2},\"triggerHint\":\"no_schema\"},\"input\":{\"flowId\":\"stop_message_flow\",\"repeatCount\":2,\"maxRepeats\":3,\"triggerHint\":\"no_schema\"}}"
                    },
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "exec_command",
                        "parameters": { "type": "object", "properties": {} }
                    }
                ]
            })
            .to_string(),
            Some(json!({ "requestId": "req_responses_live_stopless_1" }).to_string()),
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        let messages = value["request"]["messages"]
            .as_array()
            .expect("request messages");

        assert_eq!(messages[0]["role"], json!("user"));
        let serialized = serde_json::to_string(messages).expect("messages json");
        assert!(serialized.contains("reasoningStop"));
        assert!(serialized.contains("tool_calls"));
        assert!(serialized.contains("\"role\":\"tool\""));
        assert!(serialized.contains("stop_message_flow"));
        assert!(serialized.contains("repeatCount"));
        assert!(!serialized.contains(STOPLESS_TRANSPARENT_CONTINUATION_PROMPT));
    }

    #[test]
    fn request_codec_preserves_embedded_tool_catalog_before_chatprocess_governance() {
        let live_input = json!([
            {
                "content": [],
                "role": "assistant",
                "tool_calls": [
                    {
                        "function": {
                            "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"invalid_schema\\\"}'\"}",
                            "name": "exec_command"
                        },
                        "id": "call_servertool_cli_live_verify_1",
                        "type": "function"
                    }
                ],
                "type": "message"
            },
            {
                "content": "{\"ok\":true,\"kind\":\"stop_message_auto\",\"tool\":\"stop_message_auto\",\"summary\":\"stopless continuation ready\",\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"routeHint\":\"thinking\",\"continuationPrompt\":\"继续。\",\"repeatCount\":1,\"maxRepeats\":3,\"schemaFeedback\":{\"reasonCode\":\"invalid_schema\",\"missingFields\":[\"stopreason\",\"reason\",\"next_step\"]},\"input\":{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1,\"triggerHint\":\"invalid_schema\"}}",
                "name": "reasoningStop",
                "role": "tool",
                "tool_call_id": "call_servertool_cli_live_verify_1"
            },
            {
                "content": [
                    {
                        "text": "继续修正 stop schema 并继续执行",
                        "type": "input_text"
                    }
                ],
                "role": "user",
                "type": "message"
            }
        ]);
        let raw = run_responses_openai_request_codec_json(
            json!({
                "model": "gpt-5.4",
                "stream": false,
                "input": live_input,
                "tools": [
                    {
                        "type": "function",
                        "name": "exec_command",
                        "description": "Runs a shell command",
                        "parameters": {
                            "type": "object",
                            "properties": { "cmd": { "type": "string" } },
                            "required": ["cmd"]
                        }
                    }
                ],
                "metadata": {
                    "responsesContext": {
                        "requestId": "req_1782483890571_cd0de3c5",
                        "input": [
                            {
                                "type": "function_call",
                                "id": "fc_stopless_live_1",
                                "call_id": "call_servertool_cli_live_verify_1",
                                "name": "reasoningStop",
                                "arguments": "{}"
                            },
                            {
                                "type": "function_call_output",
                                "id": "fc_stopless_live_1",
                                "call_id": "call_servertool_cli_live_verify_1",
                                "output": "{\"ok\":true,\"flowId\":\"stop_message_flow\",\"summary\":\"stopless continuation ready\",\"repeatCount\":1,\"maxRepeats\":3,\"continuationPrompt\":\"继续。\",\"schemaFeedback\":{\"reasonCode\":\"invalid_schema\",\"missingFields\":[\"stopreason\",\"reason\",\"next_step\"]}}"
                            },
                            {
                                "type": "message",
                                "role": "user",
                                "content": [
                                    {
                                        "type": "input_text",
                                        "text": "继续修正 stop schema 并继续执行"
                                    }
                                ]
                            }
                        ],
                        "chatMessages": [
                            {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "id": "call_servertool_cli_live_verify_1",
                                        "type": "function",
                                        "function": {
                                            "name": "reasoningStop",
                                            "arguments": "{}"
                                        }
                                    }
                                ]
                            },
                            {
                                "role": "tool",
                                "tool_call_id": "call_servertool_cli_live_verify_1",
                                "content": "{\"ok\":true,\"flowId\":\"stop_message_flow\",\"summary\":\"stopless continuation ready\",\"repeatCount\":1,\"maxRepeats\":3,\"continuationPrompt\":\"继续。\",\"schemaFeedback\":{\"reasonCode\":\"invalid_schema\",\"missingFields\":[\"stopreason\",\"reason\",\"next_step\"]}}"
                            },
                            {
                                "role": "user",
                                "content": "上一轮执行结果：repeatCount=1/3。\n继续。\nstopreason 取值：0=finished，1=blocked，2=continue_needed。继续修正 stop schema 并继续执行"
                            }
                        ],
                        "toolsNormalized": [
                            {
                                "type": "function",
                                "name": "exec_command",
                                "description": "Runs a shell command",
                                "parameters": {
                                    "type": "object",
                                    "properties": { "cmd": { "type": "string" } },
                                    "required": ["cmd"]
                                }
                            },
                            {
                                "type": "function",
                                "name": "reasoningStop",
                                "description": "stopless schema tool",
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "stopreason": { "type": "integer" }
                                    }
                                }
                            }
                        ]
                    }
                }
            })
            .to_string(),
            Some(json!({ "requestId": "req_1782483890571_cd0de3c5" }).to_string()),
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        let messages = value["request"]["messages"].as_array().expect("messages");
        let serialized = serde_json::to_string(messages).expect("messages json");
        assert!(serialized.contains("tool_calls"));
        assert!(serialized.contains("\"role\":\"tool\""));
        assert!(serialized.contains("stop_message_flow"));
        assert!(serialized.contains("repeatCount"));
        assert!(serialized.contains("reasoningStop"));
        assert!(!serialized.contains(STOPLESS_TRANSPARENT_CONTINUATION_PROMPT));
        let latest_user = messages
            .iter()
            .filter(|message| message["role"] == json!("user"))
            .filter_map(|message| message["content"].as_str())
            .find(|content| *content == "继续修正 stop schema 并继续执行")
            .expect("real user turn after stopless pair");
        assert_eq!(latest_user, "继续修正 stop schema 并继续执行");
        let tools = value["request"]["tools"].as_array().expect("request tools");
        assert_eq!(tools.len(), 2);
        assert!(
            tools
                .iter()
                .any(|tool| tool["name"] == json!("exec_command"))
        );
        assert!(
            tools
                .iter()
                .any(|tool| tool["name"] == json!("reasoningStop"))
        );
    }

    #[test]
    fn response_codec_builds_responses_payload_from_chat_response() {
        let request_raw = run_responses_openai_request_codec_json(
            json!({
                "model": "gpt-4.1",
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "run pwd" }
                        ]
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "exec_command",
                        "parameters": { "type": "object", "properties": {} }
                    }
                ]
            })
            .to_string(),
            Some(json!({ "requestId": "req_responses_codec_response" }).to_string()),
        )
        .unwrap();
        let request_value: Value = serde_json::from_str(&request_raw).unwrap();
        let context = request_value["context"].clone();

        let raw = run_responses_openai_response_codec_json(
            json!({
                "choices": [
                    {
                        "finish_reason": null,
                        "message": {
                            "role": "assistant",
                            "tool_calls": [
                                {
                                    "id": "call_demo_exec",
                                    "function": {
                                        "name": "exec_command",
                                        "arguments": { "cmd": "pwd" }
                                    }
                                }
                            ]
                        }
                    }
                ]
            })
            .to_string(),
            context.to_string(),
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["object"], Value::String("response".to_string()));
        assert_eq!(
            value["status"],
            Value::String("requires_action".to_string())
        );
        assert_eq!(
            value["required_action"]["submit_tool_outputs"]["tool_calls"][0]["id"],
            Value::String("call_demo_exec".to_string())
        );
        assert_eq!(
            value["output"][0]["type"],
            Value::String("function_call".to_string())
        );
        assert_eq!(
            value["output"][0]["call_id"],
            Value::String("call_demo_exec".to_string())
        );
        assert_eq!(
            value["output"][0]["arguments"],
            Value::String("{\"cmd\":\"pwd\"}".to_string())
        );
    }

    #[test]
    fn response_codec_harvests_stop_heredoc_tool_calls_into_requires_action() {
        let request_raw = run_responses_openai_request_codec_json(
            json!({
                "model": "gpt-4.1",
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "run pwd" }
                        ]
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "exec_command",
                        "parameters": { "type": "object", "properties": {} }
                    }
                ]
            })
            .to_string(),
            Some(json!({ "requestId": "req_responses_codec_heredoc" }).to_string()),
        )
        .unwrap();
        let request_value: Value = serde_json::from_str(&request_raw).unwrap();
        let context = request_value["context"].clone();

        let raw = run_responses_openai_response_codec_json(
            json!({
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": concat!(
                                "<<RCC_TOOL_CALLS_JSON\n",
                                "{\"tool_calls\":[{\"input\":{\"cmd\":\"bash -lc 'pwd'\"},\"name\":\"exec_command\"}]}\n",
                                "RCC_TOOL_CALLS_JSON"
                            )
                        }
                    }
                ]
            })
            .to_string(),
            context.to_string(),
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            value["status"],
            Value::String("requires_action".to_string())
        );
        assert_eq!(
            value["required_action"]["submit_tool_outputs"]["tool_calls"][0]["name"],
            Value::String("exec_command".to_string())
        );
        assert_eq!(
            value["required_action"]["submit_tool_outputs"]["tool_calls"][0]["arguments"],
            Value::String("{\"cmd\":\"bash -lc 'pwd'\"}".to_string())
        );
    }

    #[test]
    fn response_codec_harvests_minimax_namespace_tool_call_into_requires_action() {
        let request_raw = run_responses_openai_request_codec_json(
            json!({
                "model": "gpt-4.1",
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "run command" }
                        ]
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "exec_command",
                        "parameters": { "type": "object", "properties": {} }
                    }
                ]
            })
            .to_string(),
            Some(json!({ "requestId": "req_responses_codec_minimax_namespace" }).to_string()),
        )
        .unwrap();
        let request_value: Value = serde_json::from_str(&request_raw).unwrap();
        let context = request_value["context"].clone();

        let raw = run_responses_openai_response_codec_json(
            json!({
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": "\n<minimax:tool_call>\n<invoke name=\"exec_command\">\n<parameter name=\"cmd\">cat note.md 2&gt;/dev/null | sed -n '400,600p'</parameter>\n</invoke>\n</minimax:tool_call>"
                        }
                    }
                ]
            })
            .to_string(),
            context.to_string(),
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            value["status"],
            Value::String("requires_action".to_string())
        );
        assert_eq!(
            value["required_action"]["submit_tool_outputs"]["tool_calls"][0]["name"],
            Value::String("exec_command".to_string())
        );
        let args: Value = serde_json::from_str(
            value["required_action"]["submit_tool_outputs"]["tool_calls"][0]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap();
        assert_eq!(
            args["cmd"],
            Value::String("cat note.md 2>/dev/null | sed -n '400,600p'".to_string())
        );
        let output = value["output"].as_array().cloned().unwrap_or_default();
        assert!(output
            .iter()
            .all(|item| !item.to_string().contains("minimax:tool_call")));
    }

    #[test]
    fn response_codec_harvests_bullet_prefixed_heredoc_tool_calls_into_requires_action() {
        let request_raw = run_responses_openai_request_codec_json(
            json!({
                "model": "gpt-4.1",
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "inspect router dns" }
                        ]
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "exec_command",
                        "parameters": { "type": "object", "properties": {} }
                    }
                ]
            })
            .to_string(),
            Some(json!({ "requestId": "req_responses_codec_bullet_heredoc" }).to_string()),
        )
        .unwrap();
        let request_value: Value = serde_json::from_str(&request_raw).unwrap();
        let context = request_value["context"].clone();

        let raw = run_responses_openai_response_codec_json(
            json!({
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": concat!(
                                "• <<RCC_TOOL_CALLS_JSON\n",
                                "{\"tool_calls\":[{\"input\":{\"cmd\":\"sshpass -p password ssh -o ConnectTimeout=10 root@192.168.5.1 \\\"echo ok\\\"\"},\"name\":\"exec_command\"}]}\n",
                                "RCC_TOOL_CALLS_JSON"
                            )
                        }
                    }
                ]
            })
            .to_string(),
            context.to_string(),
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            value["status"],
            Value::String("requires_action".to_string())
        );
        assert_eq!(
            value["required_action"]["submit_tool_outputs"]["tool_calls"][0]["name"],
            Value::String("exec_command".to_string())
        );
        assert_eq!(
            value["required_action"]["submit_tool_outputs"]["tool_calls"][0]["arguments"],
            Value::String(
                "{\"cmd\":\"sshpass -p password ssh -o ConnectTimeout=10 root@192.168.5.1 \\\"echo ok\\\"\"}"
                    .to_string()
            )
        );
    }

    #[test]
    fn request_codec_harvests_malformed_assistant_tool_markup_from_history() {
        let raw = run_responses_openai_request_codec_json(
            json!({
                "model": "glm-5",
                "input": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "[思考] <parameter name=\"input\">pwd</</parameter><parameter name=\"type\">string</parameter>"
                            }
                        ]
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "继续" }
                        ]
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "cmd": { "type": "string" }
                            }
                        }
                    }
                ]
            })
            .to_string(),
            Some(json!({ "requestId": "req_responses_harvest_markup" }).to_string()),
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        let request_messages = value["request"]["messages"]
            .as_array()
            .expect("request messages");
        let assistant = request_messages
            .iter()
            .find(|entry| entry["role"].as_str() == Some("assistant"))
            .expect("assistant message exists");
        assert!(assistant.get("tool_calls").is_none());
        assert!(assistant["content"]
            .as_str()
            .unwrap_or_default()
            .contains("<parameter name=\"input\">pwd"));
    }

    #[test]
    fn request_codec_then_anthropic_codec_keeps_html_exec_tool_result_before_later_stopless_turns()
    {
        let html_tool_output = concat!(
            "Total output lines: 170\n\n",
            "<!DOCTYPE html><html><head><title>Static Residential Proxies</title></head><body>",
            "<img src=\"data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%3e\" />",
            "<img src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB\" />",
            "<p>gateway.iproyal.com:19123</p>",
            "</body></html>"
        );
        let stopless_output = "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"summary\":\"stopless continuation ready\",\"repeatCount\":2,\"maxRepeats\":3,\"continuationPrompt\":\"继续。\",\"schemaGuidance\":{\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2},\"triggerHint\":\"no_schema\"},\"input\":{\"flowId\":\"stop_message_flow\",\"repeatCount\":2,\"maxRepeats\":3,\"triggerHint\":\"no_schema\"}}";
        let stopless_chunk_user_text = concat!(
            "Chunk ID: 8dc4a6\n",
            "Wall time: 0.1388 seconds\n",
            "Process exited with code 0\n",
            "Original token count: 1229\n",
            "Output:\n",
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\"}"
        );
        let raw = run_responses_openai_request_codec_json(
            json!({
                "model": "gpt-5.5",
                "stream": true,
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "我其实想知道，我如何配置和它的连接IPRoyal 的静态 IP" }
                        ]
                    },
                    {
                        "type": "reasoning",
                        "summary": [{ "type": "summary_text", "text": "**Thinking** search static proxy details" }]
                    },
                    {
                        "type": "function_call",
                        "call_id": "call_html_exec_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"curl -s 'https://iproyal.com/static-residential-proxies/' 2>/dev/null | head -200\",\"yield_time_ms\":10000}"
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_html_exec_1",
                        "output": html_tool_output
                    },
                    {
                        "type": "reasoning",
                        "summary": [{ "type": "summary_text", "text": "**Thinking** summarize proxy setup" }]
                    },
                    {
                        "type": "function_call",
                        "call_id": "call_stopless_1",
                        "name": "reasoningStop",
                        "arguments": "{\"stopreason\":2,\"reason\":\"continue_needed\"}"
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_stopless_1",
                        "output": stopless_output
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": stopless_chunk_user_text }
                        ]
                    },
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            { "type": "output_text", "text": "## 需要确认\nJason 从 dashboard 取真实 endpoint 后 curl 验证，再告知接入目标（sing-box / PassWall2 / 本机代理）" }
                        ]
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "它是用一个特殊的协议做单次请求，请求本身包括鉴权和内容？无状态请求？" }
                        ]
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "exec_command",
                        "parameters": { "type": "object", "properties": {} }
                    }
                ]
            })
            .to_string(),
            Some(json!({ "requestId": "req_responses_html_exec_tool_result_history" }).to_string()),
        )
        .unwrap();

        let openai_chat: Value = serde_json::from_str(&raw).unwrap();
        let anthropic_raw =
            build_anthropic_from_openai_chat_json(openai_chat["request"].to_string(), None)
                .expect("anthropic build success");
        let anthropic: Value = serde_json::from_str(&anthropic_raw).unwrap();
        let messages = anthropic["messages"]
            .as_array()
            .expect("anthropic messages");

        let tool_use_index = messages
            .iter()
            .position(|message| {
                message["content"].as_array().is_some_and(|content| {
                    content.iter().any(|part| {
                        part["type"].as_str() == Some("tool_use")
                            && part["id"].as_str() == Some("call_html_exec_1")
                    })
                })
            })
            .expect("exec tool_use exists");
        let tool_result_message = messages
            .get(tool_use_index + 1)
            .expect("tool_result follows HTML exec tool_use");
        assert_eq!(tool_result_message["role"], json!("user"));
        assert_eq!(
            tool_result_message["content"][0]["type"],
            json!("tool_result")
        );
        assert_eq!(
            tool_result_message["content"][0]["tool_use_id"],
            json!("call_html_exec_1")
        );
        assert!(tool_result_message["content"][0]["content"]
            .as_str()
            .unwrap_or_default()
            .contains("[Image omitted]"));
    }
}
