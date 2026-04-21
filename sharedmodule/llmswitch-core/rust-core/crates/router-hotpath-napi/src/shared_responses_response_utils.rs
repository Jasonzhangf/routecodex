use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

use crate::hub_reasoning_tool_normalizer::{
    build_message_reasoning_value, normalize_message_reasoning_ssot,
    project_message_reasoning_text, sanitize_reasoning_tagged_text,
};
use crate::hub_resp_outbound_client_semantics::normalize_responses_function_name;
use crate::shared_output_content_normalizer::extract_output_segments;

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}

fn normalize_function_call_id(call_id: Option<&str>, fallback: &str) -> String {
    let trimmed = call_id.unwrap_or("").trim();
    if trimmed.is_empty() {
        return fallback.trim().to_string();
    }
    if trimmed.starts_with("fc_") {
        return trimmed.to_string();
    }
    let core = trimmed
        .strip_prefix("call_")
        .unwrap_or(trimmed)
        .trim_matches('_');
    if core.is_empty() {
        return fallback.trim().to_string();
    }
    format!("fc_{}", core)
}

fn select_call_id(entry: &Map<String, Value>) -> Option<String> {
    ["call_id", "tool_call_id", "tool_use_id", "id"]
        .iter()
        .find_map(|key| read_trimmed_string(entry.get(*key)))
}

fn stringify_args(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
    }
}

fn normalize_tool_call(entry: &Map<String, Value>, fallback_prefix: &str) -> Option<Value> {
    let function_row = entry.get("function").and_then(Value::as_object);
    let raw_name = function_row
        .and_then(|row| row.get("name").and_then(Value::as_str))
        .or_else(|| entry.get("name").and_then(Value::as_str));
    let normalized_name = match normalize_responses_function_name(raw_name)?.as_str() {
        "shell_command" => "exec_command".to_string(),
        other => other.to_string(),
    };

    let args_value = function_row
        .and_then(|row| row.get("arguments"))
        .or_else(|| entry.get("arguments"))
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let args_str =
        crate::resp_process_stage1_tool_governance::normalize_tool_args_preserving_raw_shape(
            normalized_name.as_str(),
            Some(&args_value),
        )
        .unwrap_or_else(|| stringify_args(&args_value));

    let call_id_raw = select_call_id(entry);
    let fallback = format!("{}_native", fallback_prefix);
    let call_id = call_id_raw
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| normalize_function_call_id(None, fallback.as_str()));

    Some(serde_json::json!({
        "id": call_id,
        "type": "function",
        "function": {
            "name": normalized_name,
            "arguments": args_str
        }
    }))
}

fn collect_tool_calls_from_responses_impl(response: &Value) -> Vec<Value> {
    let Some(response_obj) = response.as_object() else {
        return Vec::new();
    };

    let mut collected: Vec<Value> = Vec::new();
    let mut seen_ids = std::collections::HashSet::<String>::new();

    let mut push_call = |call: Option<Value>, source: &str| {
        let Some(call) = call else {
            return;
        };
        let key = call
            .as_object()
            .and_then(|row| row.get("id"))
            .and_then(Value::as_str)
            .map(|value| value.to_string())
            .unwrap_or_else(|| format!("{}_{}", source, collected.len()));
        if seen_ids.insert(key) {
            collected.push(call);
        }
    };

    let required_calls = response_obj
        .get("required_action")
        .and_then(Value::as_object)
        .and_then(|row| row.get("submit_tool_outputs"))
        .and_then(Value::as_object)
        .and_then(|row| row.get("tool_calls"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for call in required_calls {
        let normalized = call
            .as_object()
            .and_then(|row| normalize_tool_call(row, "req_call"));
        push_call(normalized, "req_call");
    }

    let output_items = response_obj
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for item in output_items {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        let item_type = item_obj
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if item_type != "function_call" {
            continue;
        }
        push_call(normalize_tool_call(item_obj, "output_call"), "output_call");
    }

    collected
}

fn resolve_finish_reason_impl(response: &Value, tool_calls: &[Value]) -> String {
    let Some(response_obj) = response.as_object() else {
        return "stop".to_string();
    };

    if !tool_calls.is_empty() {
        return "tool_calls".to_string();
    }

    if let Some(metadata_finish_reason) = response_obj
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|row| row.get("finish_reason"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return metadata_finish_reason;
    }

    let status = response_obj
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match status.as_str() {
        "requires_action" => "tool_calls".to_string(),
        "in_progress" | "streaming" => "length".to_string(),
        "cancelled" => "cancelled".to_string(),
        "failed" => "error".to_string(),
        _ => "stop".to_string(),
    }
}

fn collect_pending_tool_call_ids(tool_calls: &[Value]) -> Vec<Value> {
    let mut out = Vec::<Value>::new();
    for call in tool_calls {
        let Some(row) = call.as_object() else {
            continue;
        };
        let call_id =
            read_trimmed_string(row.get("id")).or_else(|| read_trimmed_string(row.get("call_id")));
        let Some(call_id) = call_id else {
            continue;
        };
        out.push(Value::String(call_id));
    }
    out
}

fn build_responses_continuation(
    response_obj: &Map<String, Value>,
    tool_calls: &[Value],
) -> Option<Value> {
    let response_id = read_trimmed_string(response_obj.get("id"));
    let request_id = read_trimmed_string(response_obj.get("request_id"));
    let previous_response_id = read_trimmed_string(response_obj.get("previous_response_id"));
    let status = read_trimmed_string(response_obj.get("status"));
    let pending_tool_call_ids = collect_pending_tool_call_ids(tool_calls);

    if response_id.is_none()
        && request_id.is_none()
        && previous_response_id.is_none()
        && status.is_none()
        && pending_tool_call_ids.is_empty()
    {
        return None;
    }

    let mut continuation = Map::<String, Value>::new();
    if let Some(chain_id) = request_id
        .clone()
        .or_else(|| previous_response_id.clone())
        .or_else(|| response_id.clone())
    {
        continuation.insert("chainId".to_string(), Value::String(chain_id));
    }
    if let Some(previous_turn_id) = previous_response_id.clone() {
        continuation.insert(
            "previousTurnId".to_string(),
            Value::String(previous_turn_id),
        );
    }

    let mut resume_from = Map::<String, Value>::new();
    resume_from.insert(
        "protocol".to_string(),
        Value::String("openai-responses".to_string()),
    );
    if let Some(request_id) = request_id {
        resume_from.insert("requestId".to_string(), Value::String(request_id));
    }
    if let Some(response_id) = response_id.clone() {
        resume_from.insert("responseId".to_string(), Value::String(response_id));
    }
    if let Some(previous_response_id) = previous_response_id.clone() {
        resume_from.insert(
            "previousResponseId".to_string(),
            Value::String(previous_response_id),
        );
    }
    if !resume_from.is_empty() {
        continuation.insert("resumeFrom".to_string(), Value::Object(resume_from));
    }

    if let Some(status) = status.clone() {
        continuation.insert(
            "protocolHints".to_string(),
            Value::Object(Map::from_iter([(
                "status".to_string(),
                Value::String(status),
            )])),
        );
    }

    if !pending_tool_call_ids.is_empty()
        || status
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case("requires_action"))
            .unwrap_or(false)
    {
        let mut tool_continuation = Map::<String, Value>::new();
        tool_continuation.insert(
            "mode".to_string(),
            Value::String("required_action".to_string()),
        );
        if !pending_tool_call_ids.is_empty() {
            tool_continuation.insert(
                "pendingToolCallIds".to_string(),
                Value::Array(pending_tool_call_ids),
            );
        }
        continuation.insert(
            "toolContinuation".to_string(),
            Value::Object(tool_continuation),
        );
    }

    continuation.insert(
        "stickyScope".to_string(),
        Value::String("request_chain".to_string()),
    );
    continuation.insert(
        "stateOrigin".to_string(),
        Value::String("openai-responses".to_string()),
    );
    continuation.insert(
        "restored".to_string(),
        Value::Bool(previous_response_id.is_some()),
    );

    Some(Value::Object(continuation))
}

fn unwrap_responses_response_impl(payload: &Value) -> Option<Value> {
    let mut current = payload;
    let mut visited: Vec<*const Value> = Vec::new();

    loop {
        let ptr = current as *const Value;
        if visited.contains(&ptr) {
            return None;
        }
        visited.push(ptr);

        let row = current.as_object()?;
        let object = row.get("object").and_then(Value::as_str).unwrap_or("");
        if object == "response"
            || row.get("output").map(Value::is_array).unwrap_or(false)
            || row.get("status").and_then(Value::as_str).is_some()
            || row.get("required_action").is_some()
        {
            return Some(current.clone());
        }

        if let Some(next) = row.get("response") {
            current = next;
            continue;
        }
        if let Some(next) = row.get("data") {
            current = next;
            continue;
        }
        return None;
    }
}

fn collect_reasoning_segments_impl(
    response: &Map<String, Value>,
) -> (Vec<String>, Vec<String>, Option<String>) {
    let mut raw_reasoning_segments: Vec<String> = Vec::new();
    let mut summary_reasoning_segments: Vec<String> = Vec::new();
    let mut encrypted_reasoning: Option<String> = None;
    let output_items = response
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for item in output_items {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        let item_type = item_obj
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if item_type != "reasoning" {
            continue;
        }

        if encrypted_reasoning.is_none() {
            encrypted_reasoning = item_obj
                .get("encrypted_content")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
        }

        if let Some(content) = item_obj.get("content").and_then(Value::as_array) {
            for part in content {
                let Some(text) = part
                    .as_object()
                    .and_then(|row| row.get("text"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                let sanitized = sanitize_reasoning_tagged_text(text);
                if !sanitized.is_empty() {
                    raw_reasoning_segments.push(sanitized);
                }
            }
        }

        if let Some(summary) = item_obj.get("summary").and_then(Value::as_array) {
            for entry in summary {
                let text = if let Some(raw) = entry.as_str() {
                    raw.trim().to_string()
                } else {
                    entry
                        .as_object()
                        .and_then(|row| row.get("text"))
                        .and_then(Value::as_str)
                        .map(|value| value.trim().to_string())
                        .unwrap_or_default()
                };
                if !text.is_empty() {
                    summary_reasoning_segments.push(text);
                }
            }
        }
    }

    (
        raw_reasoning_segments,
        summary_reasoning_segments,
        encrypted_reasoning,
    )
}

fn build_chat_response_from_responses_impl(payload: &Value) -> Value {
    let Some(response) = unwrap_responses_response_impl(payload) else {
        return payload.clone();
    };
    let Some(response_obj) = response.as_object() else {
        return payload.clone();
    };

    let id =
        read_trimmed_string(response_obj.get("id")).unwrap_or_else(|| "resp_native".to_string());
    let model = response_obj.get("model").cloned().unwrap_or(Value::Null);
    let created = response_obj
        .get("created_at")
        .and_then(Value::as_i64)
        .or_else(|| response_obj.get("created").and_then(Value::as_i64))
        .unwrap_or(0);
    let usage = response_obj.get("usage").cloned();

    let tool_calls = collect_tool_calls_from_responses_impl(&response);
    let extracted = extract_output_segments(&response, "output");
    let (raw_reasoning_segments, summary_reasoning_segments, encrypted_reasoning) =
        collect_reasoning_segments_impl(response_obj);
    let output_text_raw = response_obj
        .get("output_text")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let has_tool_calls = !tool_calls.is_empty();
    let sanitize_output_text = |value: &str| -> String {
        let reasoning_sanitized = sanitize_reasoning_tagged_text(value);
        if !has_tool_calls {
            return reasoning_sanitized;
        }
        crate::resp_process_stage1_tool_governance::strip_tool_markup_for_display_text(
            reasoning_sanitized.as_str(),
        )
    };
    let explicit_output = output_text_raw
        .as_ref()
        .map(|value| sanitize_output_text(value.as_str()))
        .filter(|value| !value.is_empty());
    let message_content_text = explicit_output.unwrap_or_else(|| {
        let joined = extracted.text_parts.join("\n").trim().to_string();
        if !has_tool_calls {
            return joined;
        }
        sanitize_output_text(joined.as_str())
    });

    let mut message = Map::new();
    message.insert("role".to_string(), Value::String("assistant".to_string()));
    message.insert("content".to_string(), Value::String(message_content_text));
    if has_tool_calls {
        message.insert("tool_calls".to_string(), Value::Array(tool_calls.clone()));
    }
    let reasoning_segments = if !raw_reasoning_segments.is_empty() {
        raw_reasoning_segments.clone()
    } else if !extracted.reasoning_parts.is_empty() {
        extracted.reasoning_parts.clone()
    } else {
        summary_reasoning_segments.clone()
    };
    if let Some(reasoning_payload) = build_message_reasoning_value(
        summary_reasoning_segments.as_slice(),
        if !raw_reasoning_segments.is_empty() {
            raw_reasoning_segments.as_slice()
        } else {
            extracted.reasoning_parts.as_slice()
        },
        encrypted_reasoning.as_deref(),
    ) {
        if let Some(text) = project_message_reasoning_text(&reasoning_payload) {
            message.insert("reasoning_content".to_string(), Value::String(text));
        }
        message.insert("reasoning".to_string(), reasoning_payload);
    } else if !reasoning_segments.is_empty() {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(reasoning_segments.join("\n")),
        );
    }
    normalize_message_reasoning_ssot(&mut message);

    let finish_reason = resolve_finish_reason_impl(&response, tool_calls.as_slice());
    let mut choice = Map::new();
    choice.insert("index".to_string(), Value::Number(0.into()));
    choice.insert("finish_reason".to_string(), Value::String(finish_reason));
    choice.insert("message".to_string(), Value::Object(message));

    let mut chat = Map::new();
    chat.insert("id".to_string(), Value::String(id.clone()));
    chat.insert(
        "object".to_string(),
        Value::String("chat.completion".to_string()),
    );
    chat.insert("created".to_string(), Value::Number(created.into()));
    chat.insert("model".to_string(), model);
    chat.insert(
        "choices".to_string(),
        Value::Array(vec![Value::Object(choice)]),
    );

    chat.insert(
        "__responses_output_text_meta".to_string(),
        serde_json::json!({
            "hasField": response_obj.contains_key("output_text"),
            "value": output_text_raw
                .as_ref()
                .map(|value| sanitize_output_text(value.as_str()))
        }),
    );

    if let Some(usage_value) = usage {
        chat.insert("usage".to_string(), usage_value);
    }
    if let Some(request_id) = read_trimmed_string(response_obj.get("request_id"))
        .or_else(|| read_trimmed_string(response_obj.get("id")))
    {
        chat.insert("request_id".to_string(), Value::String(request_id));
    }
    if let Some(continuation) = build_responses_continuation(response_obj, tool_calls.as_slice()) {
        chat.insert(
            "semantics".to_string(),
            Value::Object(Map::from_iter([("continuation".to_string(), continuation)])),
        );
    }

    Value::Object(chat)
}

#[napi]
pub fn collect_tool_calls_from_responses_json(response_json: String) -> NapiResult<String> {
    let response: Value = serde_json::from_str(&response_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = collect_tool_calls_from_responses_impl(&response);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_finish_reason_json(
    response_json: String,
    tool_calls_json: String,
) -> NapiResult<String> {
    let response: Value = serde_json::from_str(&response_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tool_calls: Vec<Value> = serde_json::from_str(&tool_calls_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_finish_reason_impl(&response, tool_calls.as_slice());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_chat_response_from_responses_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_chat_response_from_responses_impl(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_response_utils_collect_tool_calls_from_required_and_output() {
        let response = serde_json::json!({
            "required_action": {
                "submit_tool_outputs": {
                    "tool_calls": [
                        {
                            "call_id": "call_required",
                            "function": {
                                "name": "shell_command",
                                "arguments": { "cmd": "pwd" }
                            }
                        }
                    ]
                }
            },
            "output": [
                {
                    "type": "function_call",
                    "id": "call_output",
                    "name": "view_image",
                    "arguments": { "path": "/tmp/a.png" }
                }
            ]
        });
        let output = collect_tool_calls_from_responses_impl(&response);
        assert_eq!(output.len(), 2);
        assert_eq!(
            output[0].get("id").and_then(Value::as_str),
            Some("call_required")
        );
        assert_eq!(
            output[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("exec_command")
        );
        let req_args = output[0]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|row| row.get("arguments"))
            .and_then(Value::as_str)
            .unwrap();
        let req_args_json: Value = serde_json::from_str(req_args).unwrap();
        assert_eq!(
            req_args_json.get("cmd").and_then(Value::as_str),
            Some("pwd")
        );

        assert_eq!(
            output[1].get("id").and_then(Value::as_str),
            Some("call_output")
        );
        assert_eq!(
            output[1]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("view_image")
        );
    }

    #[test]
    fn responses_response_utils_normalizes_update_plan_native_arguments() {
        let response = serde_json::json!({
            "required_action": {
                "submit_tool_outputs": {
                    "tool_calls": [
                        {
                            "call_id": "call_required",
                            "function": {
                                "name": "update_plan",
                                "arguments": { "steps": ["审计", "修复"] }
                            }
                        }
                    ]
                }
            }
        });
        let output = collect_tool_calls_from_responses_impl(&response);
        assert_eq!(output.len(), 1);
        let args = output[0]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|row| row.get("arguments"))
            .and_then(Value::as_str)
            .unwrap();
        let args_json: Value = serde_json::from_str(args).unwrap();
        assert_eq!(args_json["plan"][0]["step"], "审计");
        assert_eq!(args_json["plan"][0]["status"], "pending");
        assert_eq!(args_json["plan"][1]["step"], "修复");
        assert_eq!(args_json["plan"][1]["status"], "pending");
    }

    #[test]
    fn responses_response_utils_resolve_finish_reason_prefers_tool_calls_then_metadata_then_status()
    {
        let response = serde_json::json!({
            "metadata": { "finish_reason": "custom_stop" },
            "status": "requires_action"
        });
        let finish = resolve_finish_reason_impl(&response, &[]);
        assert_eq!(finish, "custom_stop");

        let finish = resolve_finish_reason_impl(&response, &[serde_json::json!({"id":"call_1"})]);
        assert_eq!(finish, "tool_calls");

        let response = serde_json::json!({ "status": "failed" });
        let finish = resolve_finish_reason_impl(&response, &[]);
        assert_eq!(finish, "error");

        let response = serde_json::json!({ "status": "completed" });
        let finish = resolve_finish_reason_impl(&response, &[serde_json::json!({"id":"call_1"})]);
        assert_eq!(finish, "tool_calls");
    }

    #[test]
    fn responses_response_utils_build_chat_response_from_responses() {
        let payload = serde_json::json!({
            "id": "resp_123",
            "object": "response",
            "model": "gpt-test",
            "created": 1700000000,
            "usage": {"total_tokens": 12},
            "output_text": "hello",
            "output": [
                {
                    "type": "reasoning",
                    "content": [{"text": "<think>hidden</think>plan"}],
                    "summary": [{"text": "sum"}],
                    "encrypted_content": "enc"
                },
                {
                    "type": "function_call",
                    "id": "call_abc",
                    "name": "shell_command",
                    "arguments": {"cmd":"pwd"}
                }
            ]
        });
        let output = build_chat_response_from_responses_impl(&payload);
        assert_eq!(output["object"], "chat.completion");
        assert_eq!(output["id"], "resp_123");
        assert_eq!(output["choices"][0]["message"]["role"], "assistant");
        assert_eq!(output["choices"][0]["message"]["content"], "hello");
        assert_eq!(
            output["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
        assert_eq!(output["choices"][0]["message"]["reasoning_content"], "plan");
        assert_eq!(
            output["choices"][0]["message"]["reasoning"]["summary"][0]["text"],
            "sum"
        );
        assert_eq!(
            output["choices"][0]["message"]["reasoning"]["encrypted_content"],
            "enc"
        );
        assert_eq!(output["__responses_output_text_meta"]["hasField"], true);
        assert!(output.get("__responses_payload_snapshot").is_none());
    }

    #[test]
    fn responses_response_utils_build_chat_response_strips_tool_wrapper_from_output_text_when_structured_tool_calls_exist(
    ) {
        let payload = serde_json::json!({
            "id": "resp_tool_text",
            "object": "response",
            "model": "gpt-test",
            "created": 1700000000,
            "status": "requires_action",
            "output_text": "• <<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\"}}]}\nRCC_TOOL_CALLS_JSON",
            "required_action": {
                "submit_tool_outputs": {
                    "tool_calls": [
                        {
                            "call_id": "call_required",
                            "function": {
                                "name": "exec_command",
                                "arguments": { "cmd": "pwd" }
                            }
                        }
                    ]
                }
            }
        });

        let output = build_chat_response_from_responses_impl(&payload);
        assert_eq!(output["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(
            output["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
        assert_eq!(output["choices"][0]["message"]["content"], "");
        assert_eq!(output["__responses_output_text_meta"]["hasField"], true);
        assert_eq!(output["__responses_output_text_meta"]["value"], "");
    }
}
