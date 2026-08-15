use serde_json::{json, Value};

use crate::{classify_tool_call, RouteToolCallClassification};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct V3CurrentTurnSignals {
    pub latest_message_from_user: bool,
    pub has_current_turn_tool_output: bool,
    pub has_current_turn_web_search: bool,
    pub has_current_turn_image: bool,
    pub last_assistant_tool: Option<RouteToolCallClassification>,
}

pub fn build_v3_current_turn_route_facts(request: &Value) -> V3CurrentTurnSignals {
    let message_signals = request
        .get("messages")
        .and_then(value_as_array)
        .map(|messages| extract_message_signals(&messages))
        .unwrap_or_default();
    let responses_input = responses_input(request);
    if (message_signals.latest_message_from_user || responses_input.is_empty())
        && message_signals != V3CurrentTurnSignals::default()
    {
        return message_signals;
    }
    if let Some(contents) = request.get("contents").and_then(value_as_array) {
        if !contents.is_empty() {
            return extract_gemini_signals(&contents);
        }
    }
    if !responses_input.is_empty() {
        return extract_responses_signals(&responses_input);
    }
    if request
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .is_some()
    {
        return V3CurrentTurnSignals {
            latest_message_from_user: true,
            ..Default::default()
        };
    }
    message_signals
}

fn extract_gemini_signals(contents: &[Value]) -> V3CurrentTurnSignals {
    let latest_role = contents
        .iter()
        .rev()
        .find_map(|content| content.get("role").and_then(Value::as_str));
    let latest_user_index = contents
        .iter()
        .rposition(|content| content.get("role").and_then(Value::as_str) == Some("user"));
    let segment_start = latest_user_index.unwrap_or(0);
    let mut has_current_turn_image = false;
    for content in contents.iter().skip(segment_start) {
        has_current_turn_image |= value_contains_image(content);
    }
    V3CurrentTurnSignals {
        latest_message_from_user: latest_role == Some("user"),
        has_current_turn_image,
        ..Default::default()
    }
}

fn value_as_array(value: &Value) -> Option<Vec<Value>> {
    if let Some(items) = value.as_array() {
        return Some(items.clone());
    }
    let raw = value.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|parsed| parsed.as_array().cloned())
}

fn responses_input(request: &Value) -> Vec<Value> {
    if let Some(input) = request.get("input") {
        if let Some(items) = value_as_array(input) {
            if !items.is_empty() {
                return items;
            }
        }
        if let Some(text) = input
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            return vec![json!({"type":"input_text","text":text})];
        }
    }
    request
        .pointer("/semantics/responses/context/input")
        .and_then(value_as_array)
        .unwrap_or_default()
}

fn extract_message_signals(messages: &[Value]) -> V3CurrentTurnSignals {
    let latest_role = messages.iter().rev().find_map(message_role);
    let latest_user_index = messages
        .iter()
        .rposition(|message| message_role(message).as_deref() == Some("user"));
    let Some(segment) = active_segment(messages, latest_user_index, latest_role.as_deref()) else {
        return V3CurrentTurnSignals {
            latest_message_from_user: latest_role.as_deref() == Some("user"),
            has_current_turn_web_search: latest_user_index
                .and_then(|index| messages.get(index))
                .is_some_and(message_contains_web_search),
            has_current_turn_image: latest_user_index
                .and_then(|index| messages.get(index))
                .is_some_and(message_contains_image),
            ..Default::default()
        };
    };
    let mut has_current_turn_tool_output = false;
    let mut has_current_turn_web_search = false;
    let mut has_current_turn_image = latest_user_index
        .and_then(|index| messages.get(index))
        .is_some_and(message_contains_image);
    let mut last_assistant_tool = None;
    for message in segment {
        has_current_turn_image |= message_contains_image(message);
        match message_role(message).as_deref() {
            Some("tool") => has_current_turn_tool_output = true,
            Some("assistant") => {
                if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                    if !calls.is_empty() {
                        has_current_turn_tool_output = true;
                    }
                    for call in calls {
                        if let Some(classification) = classify_call_value(call) {
                            last_assistant_tool = Some(classification);
                        }
                    }
                }
                if let Some(content) = message.get("content").and_then(Value::as_array) {
                    for item in content {
                        if entry_type(item).as_str() == "web_search" {
                            has_current_turn_web_search = true;
                        }
                        if is_tool_call_type(entry_type(item).as_str()) {
                            has_current_turn_tool_output = true;
                            if let Some(classification) = classify_call_value(item) {
                                last_assistant_tool = Some(classification);
                            }
                        }
                    }
                }
            }
            Some("user") => {
                if let Some(content) = message.get("content").and_then(Value::as_array) {
                    for item in content {
                        if entry_type(item).as_str() == "web_search" {
                            has_current_turn_web_search = true;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    V3CurrentTurnSignals {
        latest_message_from_user: latest_role.as_deref() == Some("user"),
        has_current_turn_tool_output,
        has_current_turn_web_search,
        has_current_turn_image,
        last_assistant_tool,
    }
}

fn extract_responses_signals(entries: &[Value]) -> V3CurrentTurnSignals {
    let latest_role = entries.iter().rev().find_map(response_entry_role);
    let latest_user_index = entries.iter().rposition(is_user_carrier);
    let Some(segment) = active_segment(entries, latest_user_index, latest_role.as_deref()) else {
        let current_turn_start = latest_user_index
            .map(|index| {
                entries[..index]
                    .iter()
                    .rposition(is_user_carrier)
                    .map(|previous| previous + 1)
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        return V3CurrentTurnSignals {
            latest_message_from_user: latest_role.as_deref() == Some("user"),
            has_current_turn_web_search: latest_user_index.is_some_and(|index| {
                entries[current_turn_start..=index]
                    .iter()
                    .any(entry_contains_web_search)
            }),
            has_current_turn_image: latest_user_index.is_some_and(|index| {
                entries[current_turn_start..=index]
                    .iter()
                    .any(entry_contains_image)
            }),
            ..Default::default()
        };
    };
    let mut has_current_turn_tool_output = false;
    let mut has_current_turn_web_search = false;
    let mut has_current_turn_image =
        latest_user_index.is_some_and(|index| entries[index..].iter().any(entry_contains_image));
    let mut last_assistant_tool = None;
    for entry in segment {
        has_current_turn_image |= entry_contains_image(entry);
        let kind = entry_type(entry);
        if kind == "web_search" {
            has_current_turn_web_search = true;
        }
        if is_tool_call_type(&kind) {
            has_current_turn_tool_output = true;
            if let Some(classification) = classify_call_value(entry) {
                last_assistant_tool = Some(classification);
            }
            continue;
        }
        if is_tool_output_type(&kind) {
            has_current_turn_tool_output = true;
            continue;
        }
        if response_entry_role(entry).as_deref() != Some("assistant") {
            continue;
        }
        if let Some(calls) = entry.get("tool_calls").and_then(Value::as_array) {
            if !calls.is_empty() {
                has_current_turn_tool_output = true;
            }
            for call in calls {
                if let Some(classification) = classify_call_value(call) {
                    last_assistant_tool = Some(classification);
                }
            }
        }
        if let Some(content) = entry.get("content").and_then(Value::as_array) {
            for item in content {
                if is_tool_call_type(entry_type(item).as_str()) {
                    has_current_turn_tool_output = true;
                    if let Some(classification) = classify_call_value(item) {
                        last_assistant_tool = Some(classification);
                    }
                }
            }
        }
    }
    V3CurrentTurnSignals {
        latest_message_from_user: latest_role.as_deref() == Some("user"),
        has_current_turn_tool_output,
        has_current_turn_web_search,
        has_current_turn_image,
        last_assistant_tool,
    }
}

fn active_segment<'a>(
    entries: &'a [Value],
    latest_user_index: Option<usize>,
    latest_role: Option<&str>,
) -> Option<&'a [Value]> {
    if latest_role == Some("user") {
        return None;
    }
    let start = latest_user_index.map(|index| index + 1).unwrap_or(0);
    Some(&entries[start..])
}

fn message_role(message: &Value) -> Option<String> {
    message
        .get("role")
        .and_then(Value::as_str)
        .map(|role| role.trim().to_ascii_lowercase())
        .filter(|role| matches!(role.as_str(), "user" | "assistant" | "tool"))
}

fn response_entry_role(entry: &Value) -> Option<String> {
    let kind = entry_type(entry);
    if matches!(kind.as_str(), "input_text" | "text" | "output_text") {
        return Some("user".to_string());
    }
    if is_tool_call_type(&kind) {
        return Some("assistant".to_string());
    }
    if is_tool_output_type(&kind) {
        return Some("tool".to_string());
    }
    message_role(entry)
}

fn is_user_carrier(entry: &Value) -> bool {
    response_entry_role(entry).as_deref() == Some("user")
}

fn message_contains_web_search(message: &Value) -> bool {
    message
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|content| {
            content
                .iter()
                .any(|item| entry_type(item).as_str() == "web_search")
        })
}

fn message_contains_image(message: &Value) -> bool {
    message.get("content").is_some_and(value_contains_image)
}

fn entry_contains_image(entry: &Value) -> bool {
    value_contains_image(entry)
}

/// 当前轮图片检测只认协议 media 事实（input_image / image_url / data:image
/// 内容），不扫描 payload 文本重建意图。历史轮图片不在当前轮段内，
/// 不会驱动 multimodal 路由。
fn value_contains_image(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(value_contains_image),
        Value::Object(values) => {
            let type_value = values
                .get("type")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_ascii_lowercase())
                .unwrap_or_default();
            if type_value.contains("image") {
                return true;
            }
            if values.contains_key("image_url") {
                return true;
            }
            if values.contains_key("inline_data") || values.contains_key("file_data") {
                return true;
            }
            if values
                .get("data")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_ascii_lowercase())
                .is_some_and(|value| value.starts_with("data:image/"))
            {
                return true;
            }
            ["content", "parts"]
                .into_iter()
                .filter_map(|field| values.get(field))
                .any(value_contains_image)
        }
        _ => false,
    }
}

fn entry_contains_web_search(entry: &Value) -> bool {
    entry_type(entry).as_str() == "web_search"
}

fn entry_type(entry: &Value) -> String {
    entry
        .get("type")
        .and_then(Value::as_str)
        .map(|kind| kind.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "message".to_string())
}

fn is_tool_call_type(kind: &str) -> bool {
    matches!(
        kind,
        "function_call" | "custom_tool_call" | "tool_call" | "web_search_call"
    )
}

fn is_tool_output_type(kind: &str) -> bool {
    matches!(
        kind,
        "function_call_output"
            | "custom_tool_call_output"
            | "tool_call_output"
            | "tool_result"
            | "tool_message"
            | "web_search_call_output"
    )
}

fn classify_call_value(call: &Value) -> Option<RouteToolCallClassification> {
    let name = call
        .pointer("/function/name")
        .or_else(|| call.get("name"))
        .and_then(Value::as_str)
        .or_else(|| (entry_type(call) == "web_search_call").then_some("web_search"))?;
    let arguments = call
        .pointer("/function/arguments")
        .or_else(|| call.get("arguments"))
        .or_else(|| call.get("input"));
    classify_tool_call(name, arguments)
}
