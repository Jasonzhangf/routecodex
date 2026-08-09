use serde_json::{json, Value};

use crate::{classify_tool_call, RouteToolCallClassification};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RouteActiveTurnSignals {
    pub latest_message_from_user: bool,
    pub has_current_turn_tool_output: bool,
    pub has_current_turn_web_search: bool,
    pub last_assistant_tool: Option<RouteToolCallClassification>,
    pub current_user_text: String,
}

pub fn extract_active_turn_signals(request: &Value) -> RouteActiveTurnSignals {
    let message_signals = request
        .get("messages")
        .and_then(value_as_array)
        .map(|messages| extract_message_signals(&messages))
        .unwrap_or_default();
    let responses_input = responses_input(request);
    if (message_signals.latest_message_from_user || responses_input.is_empty())
        && message_signals != RouteActiveTurnSignals::default()
    {
        return message_signals;
    }
    if !responses_input.is_empty() {
        return extract_responses_signals(&responses_input);
    }
    if let Some(prompt) = request
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return RouteActiveTurnSignals {
            latest_message_from_user: true,
            current_user_text: prompt.to_string(),
            ..Default::default()
        };
    }
    message_signals
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

fn extract_message_signals(messages: &[Value]) -> RouteActiveTurnSignals {
    let latest_role = messages.iter().rev().find_map(message_role);
    let latest_user_index = messages
        .iter()
        .rposition(|message| message_role(message).as_deref() == Some("user"));
    let current_user_text = latest_user_index
        .and_then(|index| messages.get(index))
        .map(extract_user_text)
        .unwrap_or_default();
    let Some(segment) = active_segment(messages, latest_user_index, latest_role.as_deref()) else {
        return RouteActiveTurnSignals {
            latest_message_from_user: latest_role.as_deref() == Some("user"),
            has_current_turn_web_search: latest_user_index
                .and_then(|index| messages.get(index))
                .is_some_and(message_contains_web_search),
            current_user_text,
            ..Default::default()
        };
    };
    let mut has_current_turn_tool_output = false;
    let mut has_current_turn_web_search = false;
    let mut last_assistant_tool = None;
    for message in segment {
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
    RouteActiveTurnSignals {
        latest_message_from_user: latest_role.as_deref() == Some("user"),
        has_current_turn_tool_output,
        has_current_turn_web_search,
        last_assistant_tool,
        current_user_text,
    }
}

fn extract_responses_signals(entries: &[Value]) -> RouteActiveTurnSignals {
    let latest_role = entries.iter().rev().find_map(response_entry_role);
    let latest_user_index = entries.iter().rposition(is_user_carrier);
    let current_user_text = latest_user_index
        .and_then(|index| entries.get(index))
        .map(extract_user_text)
        .unwrap_or_default();
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
        return RouteActiveTurnSignals {
            latest_message_from_user: latest_role.as_deref() == Some("user"),
            has_current_turn_web_search: latest_user_index.is_some_and(|index| {
                entries[current_turn_start..=index]
                    .iter()
                    .any(entry_contains_web_search)
            }),
            current_user_text,
            ..Default::default()
        };
    };
    let mut has_current_turn_tool_output = false;
    let mut has_current_turn_web_search = false;
    let mut last_assistant_tool = None;
    for entry in segment {
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
    RouteActiveTurnSignals {
        latest_message_from_user: latest_role.as_deref() == Some("user"),
        has_current_turn_tool_output,
        has_current_turn_web_search,
        last_assistant_tool,
        current_user_text,
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

fn extract_user_text(entry: &Value) -> String {
    if let Some(text) = entry.as_str() {
        return text.to_string();
    }
    if let Some(text) = entry.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    let Some(content) = entry.get("content") else {
        return String::new();
    };
    extract_content_text(content)
}

fn extract_content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };
    items
        .iter()
        .filter_map(|item| {
            item.get("text")
                .and_then(Value::as_str)
                .or_else(|| item.as_str())
        })
        .collect::<Vec<_>>()
        .join("\n")
}
