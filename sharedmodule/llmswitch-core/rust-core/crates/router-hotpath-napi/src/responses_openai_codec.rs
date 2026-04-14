use napi::bindgen_prelude::Result as NapiResult;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::hub_bridge_actions::{convert_bridge_input_to_chat_messages, BridgeInputToChatInput};

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

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
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

fn build_request_from_responses_payload(
    payload_row: &Map<String, Value>,
    context: &Value,
) -> Result<Value, String> {
    let context_row = context
        .as_object()
        .ok_or_else(|| "responses-openai request context must be an object".to_string())?;
    let input = context_row
        .get("input")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let tools = context_row
        .get("toolsNormalized")
        .and_then(|v| v.as_array())
        .cloned();

    let converted = convert_bridge_input_to_chat_messages(BridgeInputToChatInput {
        input,
        tools: tools.clone(),
        tool_result_fallback_text: Some("Command succeeded (no output).".to_string()),
        normalize_function_name: Some("responses".to_string()),
    });
    let messages = append_local_images(converted.messages).map_err(|e| e.to_string())?;
    if messages.is_empty() {
        return Err("Responses payload produced no chat messages".to_string());
    }

    let mut request = Map::new();
    if let Some(model) = payload_row.get("model") {
        request.insert("model".to_string(), model.clone());
    }
    request.insert("messages".to_string(), Value::Array(messages));

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

    let capture_input = serde_json::json!({
        "rawRequest": Value::Object(payload_row.clone()),
        "requestId": options.request_id,
        "toolCallIdStyle": extract_tool_call_id_style(&payload_row),
    });
    let context_raw = crate::hub_req_inbound_context_capture::capture_req_inbound_responses_context_snapshot_json(
        capture_input.to_string(),
    )?;
    let context = parse_value(&context_raw)?;
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
            request["tools"][0]["function"]["name"],
            Value::String("exec_command".to_string())
        );
        assert_eq!(
            context["requestId"],
            Value::String("req_responses_codec".to_string())
        );
        assert_eq!(
            context["toolsNormalized"][0]["function"]["name"],
            Value::String("exec_command".to_string())
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
        let tool_calls = assistant["tool_calls"].as_array().expect("tool_calls");
        assert!(!tool_calls.is_empty());
        assert_eq!(
            tool_calls[0]["function"]["name"].as_str(),
            Some("exec_command")
        );
        assert_eq!(assistant["content"].as_str(), Some(""));
    }
}
