use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use crate::hub_bridge_actions::normalize_reasoning_in_chat_payload;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeInput {
    pub payload: Value,
    pub stream: bool,
    pub reasoning_mode: Option<String>,
    pub endpoint: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeOutput {
    pub finalized_payload: Value,
}

fn stringify_args(arg_val: &Value) -> String {
    match arg_val {
        Value::String(text) => text.clone(),
        _ => serde_json::to_string(arg_val).unwrap_or_else(|_| "{}".to_string()),
    }
}

fn to_string_content(val: &Value) -> String {
    const EMPTY_FALLBACK: &str = "Command succeeded (no output).";
    match val {
        Value::Null => EMPTY_FALLBACK.to_string(),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                EMPTY_FALLBACK.to_string()
            } else {
                text.clone()
            }
        }
        Value::Array(_) | Value::Object(_) => {
            let text = serde_json::to_string(val).unwrap_or_default();
            if text.trim().is_empty() {
                EMPTY_FALLBACK.to_string()
            } else {
                text
            }
        }
        other => {
            let text = other.to_string();
            if text.trim().is_empty() {
                EMPTY_FALLBACK.to_string()
            } else {
                text
            }
        }
    }
}

fn normalize_tool_call_arguments(tool_call: &mut Value) {
    let Some(tool_call_obj) = tool_call.as_object_mut() else {
        return;
    };
    if tool_call_obj.get("type").is_none() && tool_call_obj.get("function").is_some() {
        tool_call_obj.insert("type".to_string(), Value::String("function".to_string()));
    }
    let Some(function_obj) = tool_call_obj
        .get_mut("function")
        .and_then(|v| v.as_object_mut())
    else {
        return;
    };
    let args = function_obj
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    function_obj.insert(
        "arguments".to_string(),
        Value::String(stringify_args(&args)),
    );
}

fn normalize_choices(payload: &mut Value) {
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return;
    };
    let Some(first_choice) = choices.first_mut() else {
        return;
    };
    let Some(first_choice_obj) = first_choice.as_object_mut() else {
        return;
    };
    let Some(message_obj) = first_choice_obj
        .get_mut("message")
        .and_then(|v| v.as_object_mut())
    else {
        return;
    };
    let Some(tool_calls) = message_obj
        .get_mut("tool_calls")
        .and_then(|v| v.as_array_mut())
    else {
        return;
    };
    for tool_call in tool_calls.iter_mut() {
        normalize_tool_call_arguments(tool_call);
    }
    let finish_reason = first_choice_obj
        .get("finish_reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if finish_reason != "tool_calls" {
        first_choice_obj.insert(
            "finish_reason".to_string(),
            Value::String("tool_calls".to_string()),
        );
    }
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

fn normalize_messages(payload: &mut Value) {
    let Some(messages) = payload.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return;
    };

    let mut id_to_name = HashMap::<String, String>::new();
    for message in messages.iter_mut().rev() {
        let Some(message_obj) = message.as_object_mut() else {
            continue;
        };
        let role = read_trimmed_string(message_obj.get("role")).unwrap_or_default();
        if !role.eq_ignore_ascii_case("assistant") {
            continue;
        }
        let Some(tool_calls) = message_obj
            .get_mut("tool_calls")
            .and_then(|v| v.as_array_mut())
        else {
            continue;
        };
        if tool_calls.is_empty() {
            continue;
        }
        for tool_call in tool_calls.iter_mut() {
            normalize_tool_call_arguments(tool_call);
            let Some(tool_call_obj) = tool_call.as_object() else {
                continue;
            };
            let call_id = read_trimmed_string(tool_call_obj.get("id"));
            let function_name = tool_call_obj
                .get("function")
                .and_then(|v| v.as_object())
                .and_then(|v| read_trimmed_string(v.get("name")));
            if let (Some(id), Some(name)) = (call_id, function_name) {
                id_to_name.insert(id, name);
            }
        }
        break;
    }

    for message in messages.iter_mut() {
        let Some(message_obj) = message.as_object_mut() else {
            continue;
        };
        let role = read_trimmed_string(message_obj.get("role")).unwrap_or_default();
        if !role.eq_ignore_ascii_case("tool") {
            continue;
        }
        if read_trimmed_string(message_obj.get("name")).is_none() {
            let call_id = read_trimmed_string(message_obj.get("tool_call_id"));
            if let Some(id) = call_id {
                if let Some(name) = id_to_name.get(&id) {
                    message_obj.insert("name".to_string(), Value::String(name.clone()));
                }
            }
        }
        let content = message_obj.get("content").cloned().unwrap_or(Value::Null);
        message_obj.insert(
            "content".to_string(),
            Value::String(to_string_content(&content)),
        );
    }
}

fn append_reasoning_to_content(container: &mut Map<String, Value>, reasoning: &str) {
    let separator = if reasoning.starts_with('\n') {
        ""
    } else {
        "\n"
    };
    match container.get_mut("content") {
        Some(Value::String(existing)) => {
            let base = existing.clone();
            if base.trim().is_empty() {
                *existing = reasoning.to_string();
            } else {
                *existing = format!("{base}{separator}{reasoning}");
            }
        }
        Some(Value::Array(arr)) => {
            arr.push(json!({ "type": "text", "text": reasoning }));
        }
        Some(Value::Object(obj)) => {
            let serialized = serde_json::to_string(obj).unwrap_or_default();
            let merged = if serialized.trim().is_empty() {
                reasoning.to_string()
            } else {
                format!("{serialized}{separator}{reasoning}")
            };
            container.insert("content".to_string(), Value::String(merged));
        }
        _ => {
            container.insert("content".to_string(), Value::String(reasoning.to_string()));
        }
    }
}

fn normalize_reasoning_field(container: &mut Map<String, Value>, mode: &str) {
    let raw_value = container
        .get("reasoning_content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let trimmed = raw_value.trim().to_string();

    if trimmed.is_empty() {
        if container.contains_key("reasoning_content") {
            container.remove("reasoning_content");
        }
        return;
    }

    if mode == "drop" {
        container.remove("reasoning_content");
        return;
    }

    if mode == "append_to_content" {
        append_reasoning_to_content(container, &trimmed);
        container.remove("reasoning_content");
        return;
    }
}

fn apply_reasoning_policy(payload: &mut Value, mode: Option<&str>) {
    let selected_mode = mode.unwrap_or("keep").trim().to_ascii_lowercase();
    if selected_mode == "keep" {
        return;
    }

    if let Some(messages) = payload.get_mut("messages").and_then(|v| v.as_array_mut()) {
        for message in messages.iter_mut() {
            if let Some(message_obj) = message.as_object_mut() {
                normalize_reasoning_field(message_obj, &selected_mode);
            }
        }
    }

    if let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) {
        for choice in choices.iter_mut() {
            let Some(choice_obj) = choice.as_object_mut() else {
                continue;
            };
            if let Some(message_obj) = choice_obj
                .get_mut("message")
                .and_then(|v| v.as_object_mut())
            {
                normalize_reasoning_field(message_obj, &selected_mode);
            }
            if let Some(delta_obj) = choice_obj.get_mut("delta").and_then(|v| v.as_object_mut()) {
                normalize_reasoning_field(delta_obj, &selected_mode);
            }
        }
    }
}

fn should_normalize_reasoning(input: &FinalizeInput) -> bool {
    let wants_non_keep_mode = input
        .reasoning_mode
        .as_deref()
        .map(|mode| mode.trim().to_ascii_lowercase())
        .map(|mode| !mode.is_empty() && mode != "keep")
        .unwrap_or(false);
    let wants_anthropic_reasoning = input
        .endpoint
        .as_deref()
        .map(|endpoint| endpoint.to_ascii_lowercase().contains("/v1/messages"))
        .unwrap_or(false);
    wants_non_keep_mode || wants_anthropic_reasoning
}

pub fn finalize_chat_response(input: FinalizeInput) -> Value {
    let should_normalize = should_normalize_reasoning(&input);
    let mut payload = input.payload;
    if should_normalize {
        normalize_reasoning_in_chat_payload(&mut payload);
    }
    normalize_choices(&mut payload);
    normalize_messages(&mut payload);
    apply_reasoning_policy(&mut payload, input.reasoning_mode.as_deref());
    payload
}

#[napi]
pub fn finalize_chat_response_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: FinalizeInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let finalized_payload = finalize_chat_response(input);
    let output = FinalizeOutput { finalized_payload };
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_finalize_tool_call_args_and_finish_reason() {
        let input = FinalizeInput {
            payload: json!({
              "choices": [{
                "finish_reason": "stop",
                "message": {
                  "tool_calls": [{
                    "id": "call_1",
                    "function": {
                      "name": "exec_command",
                      "arguments": {"cmd": "pwd"}
                    }
                  }]
                }
              }]
            }),
            stream: false,
            reasoning_mode: Some("keep".to_string()),
            endpoint: None,
            request_id: None,
        };
        let result = finalize_chat_response(input);
        assert_eq!(result["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(
            result["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
            "{\"cmd\":\"pwd\"}"
        );
    }

    #[test]
    fn test_finalize_tool_role_message_content_and_name() {
        let input = FinalizeInput {
            payload: json!({
              "messages": [
                {
                  "role": "assistant",
                  "tool_calls": [{
                    "id": "call_1",
                    "function": {
                      "name": "exec_command",
                      "arguments": {"cmd": "ls"}
                    }
                  }]
                },
                {
                  "role": "tool",
                  "tool_call_id": "call_1",
                  "content": {"ok": true}
                }
              ]
            }),
            stream: false,
            reasoning_mode: Some("keep".to_string()),
            endpoint: None,
            request_id: None,
        };
        let result = finalize_chat_response(input);
        assert_eq!(result["messages"][1]["name"], "exec_command");
        assert_eq!(result["messages"][1]["content"], "{\"ok\":true}");
    }

    #[test]
    fn test_finalize_reasoning_drop() {
        let input = FinalizeInput {
            payload: json!({
              "choices": [{
                "message": {
                  "content": "hello",
                  "reasoning_content": "internal"
                }
              }]
            }),
            stream: false,
            reasoning_mode: Some("drop".to_string()),
            endpoint: None,
            request_id: None,
        };
        let result = finalize_chat_response(input);
        assert!(result["choices"][0]["message"]["reasoning_content"].is_null());
        assert_eq!(result["choices"][0]["message"]["content"], "hello");
    }

    #[test]
    fn test_finalize_reasoning_keep_normalizes_internal_markup() {
        let input = FinalizeInput {
            payload: json!({
              "choices": [{
                "message": {
                  "content": "visible <think>internal</think> answer"
                }
              }]
            }),
            stream: false,
            reasoning_mode: Some("keep".to_string()),
            endpoint: Some("/v1/chat/completions".to_string()),
            request_id: None,
        };
        let result = finalize_chat_response(input);
        assert_eq!(result["choices"][0]["message"]["content"], "visible  answer");
        assert_eq!(result["choices"][0]["message"]["reasoning_content"], "internal");
    }

    #[test]
    fn test_finalize_reasoning_drop_normalizes_before_policy() {
        let input = FinalizeInput {
            payload: json!({
              "choices": [{
                "message": {
                  "content": "visible <think>internal</think> answer"
                }
              }]
            }),
            stream: false,
            reasoning_mode: Some("drop".to_string()),
            endpoint: Some("/v1/chat/completions".to_string()),
            request_id: None,
        };
        let result = finalize_chat_response(input);
        assert_eq!(result["choices"][0]["message"]["content"], "visible  answer");
        assert!(result["choices"][0]["message"]["reasoning_content"].is_null());
    }

    #[test]
    fn test_finalize_anthropic_endpoint_normalizes_even_when_keep() {
        let input = FinalizeInput {
            payload: json!({
              "choices": [{
                "message": {
                  "content": "visible <reflection>internal</reflection> answer"
                }
              }]
            }),
            stream: false,
            reasoning_mode: Some("keep".to_string()),
            endpoint: Some("/v1/messages".to_string()),
            request_id: None,
        };
        let result = finalize_chat_response(input);
        assert_eq!(result["choices"][0]["message"]["content"], "visible  answer");
        assert_eq!(result["choices"][0]["message"]["reasoning_content"], "internal");
    }
}
