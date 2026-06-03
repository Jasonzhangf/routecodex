use serde_json::{Map, Value};

use crate::shared_tool_call_id_core::{
    clamp_prefixed_tool_call_id, extract_tool_call_id_core, normalize_prefixed_tool_call_id,
    sanitize_id_core,
};

#[derive(Debug, Clone)]
pub(crate) struct MediaBlock {
    pub(crate) kind: &'static str,
    pub(crate) url: String,
    pub(crate) detail: Option<String>,
}

pub(crate) fn is_synthetic_routecodex_tool_call_id(call_id: &str) -> bool {
    let lowered = call_id.trim().to_ascii_lowercase();
    lowered.starts_with("call_servertool_fallback_")
}

fn normalize_control_text_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<&str>>().join(" ")
}

pub(crate) fn is_synthetic_routecodex_control_text(text: &str) -> bool {
    let normalized = normalize_control_text_whitespace(text);
    let lowered = normalized.to_ascii_lowercase();
    lowered.starts_with("[routecodex]")
        && (lowered.starts_with("[routecodex] request timed out before a response was received")
            || lowered
                == "[routecodex] assistant response became empty after response sanitization."
            || lowered
                == "[routecodex] assistant response became empty after response sanitization"
            || lowered == "[routecodex] tool output was empty; execution status unknown."
            || lowered == "[routecodex] tool output was empty; execution status unknown"
            || lowered.starts_with("[routecodex] tool call result unknown"))
}

fn extract_plain_text_from_control_content(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let normalized = normalize_control_text_whitespace(text);
            if normalized.is_empty() {
                None
            } else {
                Some(normalized)
            }
        }
        Value::Array(items) => {
            let mut fragments: Vec<String> = Vec::new();
            for item in items {
                let row = item.as_object()?;
                let text = row
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| row.get("input_text").and_then(Value::as_str))
                    .or_else(|| row.get("output_text").and_then(Value::as_str))
                    .or_else(|| row.get("content").and_then(Value::as_str))?;
                let normalized = normalize_control_text_whitespace(text);
                if !normalized.is_empty() {
                    fragments.push(normalized);
                }
            }
            if fragments.is_empty() {
                None
            } else {
                Some(fragments.join("\n"))
            }
        }
        Value::Object(row) => {
            if let Some(text) = row.get("text").and_then(Value::as_str) {
                return extract_plain_text_from_control_content(&Value::String(text.to_string()));
            }
            if let Some(text) = row.get("output_text").and_then(Value::as_str) {
                return extract_plain_text_from_control_content(&Value::String(text.to_string()));
            }
            if let Some(text) = row.get("output").and_then(Value::as_str) {
                return extract_plain_text_from_control_content(&Value::String(text.to_string()));
            }
            row.get("content")
                .and_then(extract_plain_text_from_control_content)
        }
        _ => None,
    }
}

pub(crate) fn is_synthetic_routecodex_control_content(value: &Value) -> bool {
    extract_plain_text_from_control_content(value)
        .map(|text| is_synthetic_routecodex_control_text(text.as_str()))
        .unwrap_or(false)
}

pub(crate) fn coerce_bridge_role(role: Option<&str>) -> String {
    let normalized = role.unwrap_or("user").trim().to_ascii_lowercase();
    match normalized.as_str() {
        "system" | "assistant" | "user" | "tool" => normalized,
        _ => "user".to_string(),
    }
}

pub(crate) fn read_option_string(
    options: Option<&Map<String, Value>>,
    key: &str,
) -> Option<String> {
    let value = options
        .and_then(|row| row.get(key))
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    if value.is_empty() {
        return None;
    }
    Some(value)
}

pub(crate) fn ensure_object_value(value: &mut Option<Value>) -> &mut Map<String, Value> {
    if !matches!(value, Some(Value::Object(_))) {
        *value = Some(Value::Object(Map::new()));
    }
    value
        .as_mut()
        .and_then(Value::as_object_mut)
        .expect("object value expected")
}

pub(crate) fn flatten_content_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(entries) => {
            let parts: Vec<String> = entries
                .iter()
                .filter_map(flatten_content_to_string)
                .filter(|entry| !entry.is_empty())
                .collect();
            if parts.is_empty() {
                Some(String::new())
            } else {
                Some(parts.join("\n"))
            }
        }
        Value::Object(record) => {
            if let Some(Value::String(text)) = record.get("text") {
                return Some(text.clone());
            }
            if let Some(Value::String(content)) = record.get("content") {
                return Some(content.clone());
            }
            if let Some(content) = record.get("content") {
                return flatten_content_to_string(content);
            }
            None
        }
        _ => None,
    }
}

fn sanitize_servertool_name_token(value: &str) -> String {
    sanitize_id_core(value.replace('.', "_").as_str())
}

fn normalize_with_fallback(call_id: Option<&str>, fallback: &str, prefix: &str) -> String {
    normalize_prefixed_tool_call_id(call_id, Some(fallback), prefix)
}

pub(crate) fn can_servertool_own_tool_call_id(tool_name: &str) -> bool {
    matches!(
        sanitize_servertool_name_token(tool_name).as_str(),
        "continue_execution" | "web_search"
    )
}

pub(crate) fn create_servertool_tool_call_id(
    tool_name: &str,
    request_id: Option<&str>,
    sequence: usize,
) -> String {
    let tool_token = sanitize_servertool_name_token(tool_name);
    let request_token = extract_tool_call_id_core(request_id)
        .or_else(|| extract_tool_call_id_core(Some("req")))
        .unwrap_or_else(|| "req".to_string());
    clamp_prefixed_tool_call_id(
        "call_servertool_",
        format!("{tool_token}_{request_token}_{sequence}").as_str(),
        format!("{tool_name}|{}|{sequence}", request_id.unwrap_or("")).as_str(),
    )
}

pub(crate) fn create_harvested_tool_call_id(request_id: Option<&str>, sequence: usize) -> String {
    let request_token = extract_tool_call_id_core(request_id)
        .or_else(|| extract_tool_call_id_core(Some("req")))
        .unwrap_or_else(|| "req".to_string());
    clamp_prefixed_tool_call_id(
        "call_harvested_",
        format!("{request_token}_{sequence}").as_str(),
        format!("{}|{sequence}", request_id.unwrap_or("")).as_str(),
    )
}

pub(crate) fn normalize_function_call_id(call_id: Option<&str>, fallback: &str) -> String {
    normalize_with_fallback(call_id, fallback, "fc_")
}

pub(crate) fn normalize_function_call_output_id(call_id: Option<&str>, fallback: &str) -> String {
    normalize_with_fallback(call_id, fallback, "fc_")
}
