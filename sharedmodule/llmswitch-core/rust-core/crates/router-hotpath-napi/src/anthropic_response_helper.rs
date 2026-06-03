use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{json, Map, Value};

fn is_meaningless_dot_only_text(text: &str) -> bool {
    matches!(text.trim(), "." | ".." | "...")
}

fn collapse_reasoning_segments(segments: &[String]) -> Vec<String> {
    let cleaned = segments
        .iter()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty() && !is_meaningless_dot_only_text(text))
        .collect::<Vec<String>>();
    let mut merged: Vec<String> = Vec::new();
    for entry in cleaned {
        if merged.is_empty() {
            merged.push(entry);
            continue;
        }
        let last_index = merged.len() - 1;
        let last = merged[last_index].clone();
        if entry == last || last.starts_with(entry.as_str()) {
            continue;
        }
        if entry.starts_with(last.as_str()) {
            merged[last_index] = entry;
            continue;
        }
        merged.push(entry);
    }
    merged
}

fn read_text_from_reasoning_entry(entry: &Value, allowed_types: &[&str]) -> Option<String> {
    let row = entry.as_object()?;
    let text = row.get("text")?.as_str()?.trim().to_string();
    if text.is_empty() {
        return None;
    }
    let kind = row
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_ascii_lowercase();
    if !kind.is_empty() && !allowed_types.contains(&kind.as_str()) {
        return None;
    }
    Some(text)
}

pub(crate) fn normalize_message_reasoning_payload(source: &Value) -> Option<Value> {
    let row = source.as_object()?;
    let summary_raw = row
        .get("summary")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|entry| {
                    if let Some(text) = entry
                        .as_str()
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                    {
                        return Some(text.to_string());
                    }
                    read_text_from_reasoning_entry(entry, &["summary_text"])
                })
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let content_raw = row
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|entry| {
                    read_text_from_reasoning_entry(entry, &["reasoning_text", "text"])
                })
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let encrypted_content = row
        .get("encrypted_content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);

    let summary = collapse_reasoning_segments(&summary_raw)
        .into_iter()
        .map(|text| json!({"type":"summary_text", "text": text}))
        .collect::<Vec<Value>>();
    let content = collapse_reasoning_segments(&content_raw)
        .into_iter()
        .map(|text| json!({"type":"reasoning_text", "text": text}))
        .collect::<Vec<Value>>();
    if summary.is_empty() && content.is_empty() && encrypted_content.is_none() {
        return None;
    }
    let mut out = Map::new();
    if !summary.is_empty() {
        out.insert("summary".to_string(), Value::Array(summary));
    }
    if !content.is_empty() {
        out.insert("content".to_string(), Value::Array(content));
    }
    if let Some(encrypted) = encrypted_content {
        out.insert("encrypted_content".to_string(), Value::String(encrypted));
    }
    Some(Value::Object(out))
}

fn project_reasoning_text(reasoning: &Value) -> Option<String> {
    let row = reasoning.as_object()?;
    let content_segments = row
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|entry| {
                    read_text_from_reasoning_entry(entry, &["reasoning_text", "text"])
                })
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let content = collapse_reasoning_segments(&content_segments);
    if !content.is_empty() {
        return Some(content.join("\n"));
    }
    let summary_segments = row
        .get("summary")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|entry| read_text_from_reasoning_entry(entry, &["summary_text"]))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let summary = collapse_reasoning_segments(&summary_segments);
    if summary.is_empty() {
        None
    } else {
        Some(summary.join("\n"))
    }
}

pub(crate) fn apply_reasoning_payload_to_message(mut message: Value, reasoning: &Value) -> Value {
    let Some(reasoning_payload) = normalize_message_reasoning_payload(reasoning) else {
        return message;
    };
    let Some(row) = message.as_object_mut() else {
        return message;
    };
    row.insert("reasoning".to_string(), reasoning_payload.clone());
    if let Some(projected) = project_reasoning_text(&reasoning_payload)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
    {
        row.insert("reasoning_content".to_string(), Value::String(projected));
    }
    message
}

fn normalize_anthropic_tool_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("mcp__") {
        return Some(lower);
    }
    Some(lower)
}

fn should_replace_alias(
    existing_canonical: &str,
    next_canonical: &str,
    provider_key: &str,
) -> bool {
    let existing = existing_canonical.trim().to_ascii_lowercase();
    let next = next_canonical.trim().to_ascii_lowercase();
    if existing.is_empty() {
        return true;
    }
    if next == provider_key && existing != provider_key {
        return true;
    }
    if existing == provider_key && next != provider_key {
        return false;
    }
    if provider_key == "exec_command" {
        if next == "exec_command" && existing != "exec_command" {
            return true;
        }
        if existing == "exec_command" && next != "exec_command" {
            return false;
        }
    }
    false
}

pub(crate) fn resolve_anthropic_tool_name(raw_name: &str, alias_map: Option<&Value>) -> String {
    let trimmed = raw_name.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(row) = alias_map.and_then(Value::as_object) {
        let lookup_key = trimmed.to_ascii_lowercase();
        let mut reverse: Map<String, Value> = Map::new();
        for (canonical, provider_name_value) in row {
            let Some(provider_name) = provider_name_value
                .as_str()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            else {
                continue;
            };
            let canonical_name = canonical.trim();
            if canonical_name.is_empty() {
                continue;
            }
            let provider_key = provider_name.to_ascii_lowercase();
            let should_insert = reverse
                .get(provider_key.as_str())
                .and_then(Value::as_str)
                .map(|existing| {
                    should_replace_alias(existing, canonical_name, provider_key.as_str())
                })
                .unwrap_or(true);
            if should_insert {
                reverse.insert(provider_key, Value::String(canonical_name.to_string()));
            }
        }
        if let Some(value) = reverse
            .get(lookup_key.as_str())
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return value.to_string();
        }
    }
    normalize_anthropic_tool_name(trimmed).unwrap_or_else(|| trimmed.to_string())
}

#[napi]
pub fn normalize_message_reasoning_payload_json(source_json: String) -> NapiResult<String> {
    let source: Value =
        serde_json::from_str(&source_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    serde_json::to_string(&normalize_message_reasoning_payload(&source).unwrap_or(Value::Null))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn apply_reasoning_payload_to_message_json(
    message_json: String,
    reasoning_json: String,
) -> NapiResult<String> {
    let message: Value =
        serde_json::from_str(&message_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let reasoning: Value = serde_json::from_str(&reasoning_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    serde_json::to_string(&apply_reasoning_payload_to_message(message, &reasoning))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_anthropic_tool_name_json(
    raw_name: String,
    alias_map_json: String,
) -> NapiResult<String> {
    let alias_map: Value = serde_json::from_str(&alias_map_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    serde_json::to_string(&resolve_anthropic_tool_name(
        raw_name.as_str(),
        Some(&alias_map),
    ))
    .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_message_reasoning_payload() {
        let out = normalize_message_reasoning_payload(&json!({
            "summary": [".", {"type":"summary_text", "text":" plan "}, {"type":"other", "text":"drop"}],
            "content": [{"type":"text", "text":" step "}, {"type":"reasoning_text", "text":" step next "}],
            "encrypted_content": " enc "
        })).expect("payload");
        assert_eq!(out["summary"][0]["text"], "plan");
        assert_eq!(out["content"][0]["text"], "step next");
        assert_eq!(out["encrypted_content"], "enc");
    }

    #[test]
    fn applies_reasoning_payload_to_message() {
        let out = apply_reasoning_payload_to_message(
            json!({"role":"assistant", "content":""}),
            &json!({"content":[{"type":"reasoning_text", "text":" plan "}]}),
        );
        assert_eq!(out["reasoning_content"], "plan");
        assert_eq!(out["reasoning"]["content"][0]["text"], "plan");
    }

    #[test]
    fn resolves_anthropic_tool_name_from_alias_map() {
        let out = resolve_anthropic_tool_name(
            "exec_command",
            Some(&json!({"shell_command":"exec_command"})),
        );
        assert_eq!(out, "shell_command");
        let exact = resolve_anthropic_tool_name(
            "exec_command",
            Some(&json!({"shell_command":"exec_command", "exec_command":"exec_command"})),
        );
        assert_eq!(exact, "exec_command");
        assert_eq!(resolve_anthropic_tool_name("MCP__X", None), "mcp__x");
    }
}
