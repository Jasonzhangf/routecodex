use serde_json::{Map, Value};

fn normalize_anthropic_stop_reason_token(raw: Option<&str>) -> String {
    raw.unwrap_or("").trim().to_ascii_lowercase()
}

fn is_context_overflow_stop_reason(normalized_stop_reason: &str) -> bool {
    matches!(
        normalized_stop_reason,
        "model_context_window_exceeded" | "context_window_exceeded" | "context_length_exceeded"
    )
}

fn map_anthropic_stop_reason_to_finish_reason(raw: Option<&str>) -> String {
    let normalized = normalize_anthropic_stop_reason_token(raw);
    match normalized.as_str() {
        "tool_use" => "tool_calls".to_string(),
        "max_tokens" => "length".to_string(),
        "stop_sequence" | "end_turn" => "stop".to_string(),
        "model_context_window_exceeded" | "context_window_exceeded" | "context_length_exceeded" => {
            "length".to_string()
        }
        _ => {
            if normalized.is_empty() {
                "stop".to_string()
            } else {
                normalized
            }
        }
    }
}

pub(crate) fn resolve_anthropic_stop_reason(raw: Option<&str>) -> Value {
    let normalized = normalize_anthropic_stop_reason_token(raw);
    Value::Object(Map::from_iter([
        ("normalized".to_string(), Value::String(normalized.clone())),
        (
            "finishReason".to_string(),
            Value::String(map_anthropic_stop_reason_to_finish_reason(raw)),
        ),
        (
            "isContextOverflow".to_string(),
            Value::Bool(is_context_overflow_stop_reason(normalized.as_str())),
        ),
    ]))
}

pub(crate) fn resolve_anthropic_chat_completion_outcome(
    raw_stop_reason: Option<&str>,
    tool_call_count: usize,
    has_visible_assistant_output: bool,
) -> Value {
    let resolution = resolve_anthropic_stop_reason(raw_stop_reason);
    let normalized = resolution
        .as_object()
        .and_then(|row| row.get("normalized"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let finish_reason_from_stop = resolution
        .as_object()
        .and_then(|row| row.get("finishReason"))
        .and_then(|v| v.as_str())
        .unwrap_or("stop")
        .to_string();
    let is_context_overflow = resolution
        .as_object()
        .and_then(|row| row.get("isContextOverflow"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let finish_reason = if tool_call_count > 0 {
        "tool_calls".to_string()
    } else {
        finish_reason_from_stop
    };
    let should_fail_empty_context_overflow = is_context_overflow && !has_visible_assistant_output;

    Value::Object(Map::from_iter([
        ("normalized".to_string(), Value::String(normalized)),
        ("finishReason".to_string(), Value::String(finish_reason)),
        (
            "isContextOverflow".to_string(),
            Value::Bool(is_context_overflow),
        ),
        (
            "shouldFailEmptyContextOverflow".to_string(),
            Value::Bool(should_fail_empty_context_overflow),
        ),
    ]))
}

pub(crate) fn build_provider_tool_summary(tool_call_count: usize, tool_names: Vec<String>) -> Value {
    let mut out = Map::new();
    out.insert(
        "toolCallCount".to_string(),
        Value::from(tool_call_count as u64),
    );
    if !tool_names.is_empty() {
        out.insert(
            "toolNames".to_string(),
            Value::Array(tool_names.into_iter().map(Value::String).collect()),
        );
    }
    Value::Object(out)
}

pub(crate) fn summarize_tool_calls_from_provider_response(payload: &Value) -> Value {
    let row = match payload.as_object() {
        Some(v) => v,
        None => return Value::Object(Map::new()),
    };

    // openai-chat
    if let Some(choices) = row.get("choices").and_then(|v| v.as_array()) {
        let tool_calls = choices
            .first()
            .and_then(|choice| choice.as_object())
            .and_then(|choice_obj| choice_obj.get("message"))
            .and_then(|msg| msg.as_object())
            .and_then(|msg_obj| msg_obj.get("tool_calls"))
            .and_then(|tc| tc.as_array())
            .cloned()
            .unwrap_or_default();
        let tool_names: Vec<String> = tool_calls
            .iter()
            .filter_map(|entry| {
                entry
                    .as_object()
                    .and_then(|entry_obj| entry_obj.get("function"))
                    .and_then(|fn_node| fn_node.as_object())
                    .and_then(|fn_obj| fn_obj.get("name"))
                    .and_then(|name| name.as_str())
                    .map(|name| name.trim().to_string())
                    .filter(|name| !name.is_empty())
            })
            .take(10)
            .collect();
        return build_provider_tool_summary(tool_calls.len(), tool_names);
    }

    // openai-responses
    if let Some(output_items) = row.get("output").and_then(|v| v.as_array()) {
        let function_calls: Vec<&Value> = output_items
            .iter()
            .filter(|item| {
                item.as_object()
                    .and_then(|obj| obj.get("type"))
                    .and_then(|v| v.as_str())
                    .map(|t| t.trim().eq_ignore_ascii_case("function_call"))
                    .unwrap_or(false)
            })
            .collect();
        let tool_names: Vec<String> = function_calls
            .iter()
            .filter_map(|item| {
                item.as_object()
                    .and_then(|obj| obj.get("name"))
                    .and_then(|name| name.as_str())
                    .map(|name| name.trim().to_string())
                    .filter(|name| !name.is_empty())
            })
            .take(10)
            .collect();
        return build_provider_tool_summary(function_calls.len(), tool_names);
    }

    // anthropic-messages
    if let Some(content_blocks) = row.get("content").and_then(|v| v.as_array()) {
        let tool_use_blocks: Vec<&Value> = content_blocks
            .iter()
            .filter(|item| {
                item.as_object()
                    .and_then(|obj| obj.get("type"))
                    .and_then(|v| v.as_str())
                    .map(|t| t.trim().eq_ignore_ascii_case("tool_use"))
                    .unwrap_or(false)
            })
            .collect();
        let tool_names: Vec<String> = tool_use_blocks
            .iter()
            .filter_map(|item| {
                item.as_object()
                    .and_then(|obj| obj.get("name"))
                    .and_then(|name| name.as_str())
                    .map(|name| name.trim().to_string())
                    .filter(|name| !name.is_empty())
            })
            .take(10)
            .collect();
        return build_provider_tool_summary(tool_use_blocks.len(), tool_names);
    }

    Value::Object(Map::new())
}

pub(crate) fn infer_provider_type_from_protocol(protocol_raw: Option<&str>) -> Option<String> {
    let normalized = protocol_raw.unwrap_or("").trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    match normalized.as_str() {
        "openai-chat" => Some("openai".to_string()),
        "openai-responses" => Some("responses".to_string()),
        "anthropic-messages" => Some("anthropic".to_string()),
        "gemini-chat" => Some("gemini".to_string()),
        _ => None,
    }
}

