use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use crate::hub_bridge_actions::normalize_reasoning_in_chat_payload;

const EMPTY_STOP_RESPONSE_PLACEHOLDER: &str =
    "[RouteCodex] assistant response became empty after response sanitization.";

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
    const EMPTY_FALLBACK: &str = "[RouteCodex] Tool output was empty; execution status unknown.";
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

fn normalize_tool_call_arguments(tool_call: &mut Value, fallback_id: Option<String>) -> bool {
    let Some(tool_call_obj) = tool_call.as_object_mut() else {
        return false;
    };
    if tool_call_obj.get("type").is_none() && tool_call_obj.get("function").is_some() {
        tool_call_obj.insert("type".to_string(), Value::String("function".to_string()));
    }
    let id_missing = tool_call_obj
        .get("id")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().is_empty())
        .unwrap_or(true);
    if id_missing {
        if let Some(id) = fallback_id {
            if !id.trim().is_empty() {
                tool_call_obj.insert("id".to_string(), Value::String(id));
            }
        }
    }
    let Some(function_obj) = tool_call_obj
        .get_mut("function")
        .and_then(|v| v.as_object_mut())
    else {
        return false;
    };
    let function_name = function_obj
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if function_name.is_empty() {
        return false;
    }
    function_obj.insert("name".to_string(), Value::String(function_name.clone()));
    let args = function_obj
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let normalized_args =
        crate::resp_process_stage1_tool_governance::normalize_tool_args_preserving_raw_shape(
            function_name.as_str(),
            Some(&args),
        )
        .unwrap_or_else(|| stringify_args(&args));
    function_obj.insert("arguments".to_string(), Value::String(normalized_args));
    true
}

fn value_has_non_empty_text(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Array(items)) => items
            .iter()
            .any(|item| value_has_non_empty_text(Some(item))),
        Some(Value::Object(obj)) => {
            value_has_non_empty_text(obj.get("text"))
                || value_has_non_empty_text(obj.get("output_text"))
                || value_has_non_empty_text(obj.get("content"))
        }
        _ => false,
    }
}

fn read_payload_error_fallback(payload: &Value) -> Option<String> {
    let error = payload.get("error")?.as_object()?;
    let message = error
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !message.is_empty() {
        return Some(message);
    }
    let code = error
        .get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if code.is_empty() {
        None
    } else {
        Some(format!("[RouteCodex] provider error: {}", code))
    }
}

fn normalize_choices(payload: &mut Value) {
    let error_fallback = read_payload_error_fallback(payload);
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return;
    };
    let Some(first_choice) = choices.first_mut() else {
        return;
    };
    let Some(first_choice_obj) = first_choice.as_object_mut() else {
        return;
    };
    let original_finish_reason = first_choice_obj
        .get("finish_reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let (has_tool_calls, has_message_text) = {
        let Some(message_value) = first_choice_obj.get_mut("message") else {
            return;
        };
        let Some(message_obj) = message_value.as_object_mut() else {
            return;
        };

        let mut has_tool_calls = false;
        if let Some(tool_calls) = message_obj
            .get_mut("tool_calls")
            .and_then(|v| v.as_array_mut())
        {
            let had_raw_tool_calls = !tool_calls.is_empty();
            let mut normalized_tool_calls: Vec<Value> = Vec::new();
            let original = std::mem::take(tool_calls);
            for (idx, mut tool_call) in original.into_iter().enumerate() {
                let fallback_id = Some(format!("call_routecodex_repaired_{}", idx + 1));
                if normalize_tool_call_arguments(&mut tool_call, fallback_id) {
                    normalized_tool_calls.push(tool_call);
                } else {
                    normalized_tool_calls.push(tool_call);
                }
            }
            *tool_calls = normalized_tool_calls;
            has_tool_calls = had_raw_tool_calls && !tool_calls.is_empty();
        }
        let has_message_text = value_has_non_empty_text(message_obj.get("content"))
            || value_has_non_empty_text(message_obj.get("reasoning_content"))
            || value_has_non_empty_text(message_obj.get("reasoning"));
        (has_tool_calls, has_message_text)
    };

    if has_tool_calls {
        if original_finish_reason != "tool_calls" {
            first_choice_obj.insert(
                "finish_reason".to_string(),
                Value::String("tool_calls".to_string()),
            );
        }
        return;
    }

    let mut repaired_finish_reason = original_finish_reason.clone();
    if original_finish_reason == "tool_calls" && !has_message_text {
        first_choice_obj.insert(
            "finish_reason".to_string(),
            Value::String("stop".to_string()),
        );
        repaired_finish_reason = "stop".to_string();
    }
    if repaired_finish_reason == "stop" && !has_message_text {
        if let Some(message_obj) = first_choice_obj
            .get_mut("message")
            .and_then(|value| value.as_object_mut())
        {
            message_obj.insert(
                "content".to_string(),
                Value::String(
                    error_fallback
                        .clone()
                        .unwrap_or_else(|| EMPTY_STOP_RESPONSE_PLACEHOLDER.to_string()),
                ),
            );
        }
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
        let mut normalized_tool_calls: Vec<Value> = Vec::new();
        let original = std::mem::take(tool_calls);
        for (idx, mut tool_call) in original.into_iter().enumerate() {
            let fallback_id = Some(format!("call_routecodex_history_{}", idx + 1));
            if !normalize_tool_call_arguments(&mut tool_call, fallback_id) {
                continue;
            }
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
            normalized_tool_calls.push(tool_call);
        }
        *tool_calls = normalized_tool_calls;
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

pub fn finalize_chat_response(input: FinalizeInput) -> Value {
    let mut payload = input.payload;
    normalize_reasoning_in_chat_payload(&mut payload);
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
    fn test_finalize_preserves_invalid_tool_calls_for_client_error_surface() {
        let input = FinalizeInput {
            payload: json!({
              "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                  "tool_calls": [{
                    "id": "call_missing_name",
                    "function": {
                      "arguments": {"cmd": "pwd"}
                    }
                  }],
                  "content": ""
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
            result["choices"][0]["message"]["tool_calls"][0]["id"],
            "call_missing_name"
        );
        assert!(
            result["choices"][0]["message"]["content"].is_null()
                || result["choices"][0]["message"]["content"] == ""
        );
    }

    #[test]
    fn test_finalize_preserves_invalid_tool_calls_even_when_original_finish_reason_is_stop() {
        let input = FinalizeInput {
            payload: json!({
              "choices": [{
                "finish_reason": "stop",
                "message": {
                  "tool_calls": [{
                    "id": "call_missing_name",
                    "function": {
                      "arguments": {"cmd": "pwd"}
                    }
                  }],
                  "content": ""
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
            result["choices"][0]["message"]["tool_calls"][0]["id"],
            "call_missing_name"
        );
    }

    #[test]
    fn test_finalize_repairs_missing_tool_call_id() {
        let input = FinalizeInput {
            payload: json!({
              "choices": [{
                "finish_reason": "stop",
                "message": {
                  "tool_calls": [{
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
            result["choices"][0]["message"]["tool_calls"][0]["id"],
            "call_routecodex_repaired_1"
        );
    }

    #[test]
    fn test_finalize_normalizes_update_plan_steps_alias() {
        let input = FinalizeInput {
            payload: json!({
              "choices": [{
                "finish_reason": "stop",
                "message": {
                  "tool_calls": [{
                    "id": "call_1",
                    "function": {
                      "name": "update_plan",
                      "arguments": {"steps": ["审计", "修复"]}
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
        let args = result["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap();
        let args_json: Value = serde_json::from_str(args).unwrap();
        assert_eq!(args_json["plan"][0]["step"], "审计");
        assert_eq!(args_json["plan"][0]["status"], "pending");
        assert_eq!(args_json["plan"][1]["step"], "修复");
        assert_eq!(args_json["plan"][1]["status"], "pending");
    }

    #[test]
    fn test_finalize_repairs_empty_tool_calls_finish_reason_shape() {
        let input = FinalizeInput {
            payload: json!({
              "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                  "content": null,
                  "tool_calls": []
                }
              }]
            }),
            stream: false,
            reasoning_mode: Some("keep".to_string()),
            endpoint: None,
            request_id: None,
        };
        let result = finalize_chat_response(input);
        assert_eq!(result["choices"][0]["finish_reason"], "stop");
        assert_eq!(
            result["choices"][0]["message"]["content"],
            EMPTY_STOP_RESPONSE_PLACEHOLDER
        );
    }

    #[test]
    fn test_finalize_repairs_empty_stop_message_shape() {
        let input = FinalizeInput {
            payload: json!({
              "choices": [{
                "finish_reason": "stop",
                "message": {
                  "content": ""
                }
              }]
            }),
            stream: false,
            reasoning_mode: Some("keep".to_string()),
            endpoint: None,
            request_id: None,
        };
        let result = finalize_chat_response(input);
        assert_eq!(
            result["choices"][0]["message"]["content"],
            EMPTY_STOP_RESPONSE_PLACEHOLDER
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
        assert_eq!(
            result["choices"][0]["message"]["content"],
            "visible  answer"
        );
        assert_eq!(
            result["choices"][0]["message"]["reasoning_content"],
            "internal"
        );
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
        assert_eq!(
            result["choices"][0]["message"]["content"],
            "visible  answer"
        );
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
        assert_eq!(
            result["choices"][0]["message"]["content"],
            "visible  answer"
        );
        assert_eq!(
            result["choices"][0]["message"]["reasoning_content"],
            "internal"
        );
    }
}
