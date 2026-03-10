use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::hub_reasoning_tool_normalizer::repair_arguments_to_string;

#[derive(Debug, Clone)]
pub(crate) struct MediaBlock {
    pub(crate) kind: &'static str,
    pub(crate) url: String,
    pub(crate) detail: Option<String>,
}

pub(crate) fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(Value::as_str)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
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

pub(crate) fn serialize_tool_arguments(value: Option<&Value>) -> String {
    let raw = value.unwrap_or(&Value::Null);
    repair_arguments_to_string(raw)
}

const MAX_RESPONSES_ITEM_ID_LENGTH: usize = 64;

fn sanitize_core(value: &str) -> String {
    let mut out = String::new();
    let mut prev_underscore = false;
    for ch in value.chars() {
        let normalized = if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            ch
        } else {
            '_'
        };
        if normalized == '_' {
            if !prev_underscore {
                out.push('_');
            }
            prev_underscore = true;
        } else {
            out.push(normalized);
            prev_underscore = false;
        }
    }
    out.trim_matches('_').to_string()
}

fn short_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::new();
    for byte in digest.iter().take(5) {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

fn clamp_prefixed_id(prefix: &str, core: &str, hash_source: &str) -> String {
    let sanitized = {
        let raw = sanitize_core(core);
        if raw.is_empty() {
            Uuid::new_v4().simple().to_string()[..8].to_string()
        } else {
            raw
        }
    };
    let direct = format!("{}{}", prefix, sanitized);
    if direct.len() <= MAX_RESPONSES_ITEM_ID_LENGTH {
        return direct;
    }
    let hash = short_hash(&format!("{}|{}|{}", prefix, hash_source, sanitized));
    let room = std::cmp::max(
        1,
        MAX_RESPONSES_ITEM_ID_LENGTH.saturating_sub(prefix.len() + 1 + hash.len()),
    );
    let head = {
        let raw = sanitize_core(&sanitized.chars().take(room).collect::<String>());
        if raw.is_empty() {
            "id".to_string()
        } else {
            raw
        }
    };
    format!("{}{}_{}", prefix, head, hash)
}

fn extract_core(value: Option<&str>) -> Option<String> {
    let raw = value?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut sanitized = sanitize_core(trimmed);
    if sanitized.is_empty() {
        return None;
    }
    let lower = sanitized.to_ascii_lowercase();
    if lower.starts_with("fc_") || lower.starts_with("fc-") {
        sanitized = sanitized[3..].to_string();
    } else if lower.starts_with("call_") || lower.starts_with("call-") {
        sanitized = sanitized[5..].to_string();
    }
    let normalized = sanitize_core(&sanitized);
    if normalized.is_empty() {
        return None;
    }
    Some(normalized)
}

fn normalize_with_fallback(call_id: Option<&str>, fallback: &str, prefix: &str) -> String {
    if let Some(call_core) = extract_core(call_id) {
        return clamp_prefixed_id(prefix, &call_core, call_id.unwrap_or_default());
    }
    if let Some(fallback_core) = extract_core(Some(fallback)) {
        return clamp_prefixed_id(prefix, &fallback_core, fallback);
    }
    let random_core = Uuid::new_v4().simple().to_string()[..8].to_string();
    clamp_prefixed_id(prefix, &random_core, &random_core)
}

pub(crate) fn normalize_function_call_id(call_id: Option<&str>, fallback: &str) -> String {
    normalize_with_fallback(call_id, fallback, "fc_")
}

pub(crate) fn normalize_function_call_output_id(call_id: Option<&str>, fallback: &str) -> String {
    normalize_with_fallback(call_id, fallback, "fc_")
}
