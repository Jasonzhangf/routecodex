use serde_json::{Map, Value};

use crate::hub_reasoning_tool_normalizer::{
    normalize_message_reasoning_ssot, project_message_reasoning_text,
};

fn is_json_object(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)))
}

pub(crate) fn build_client_passthrough_patch(
    client_payload: &Value,
    source_payload: &Value,
) -> Map<String, Value> {
    let client_row = match client_payload.as_object() {
        Some(v) => v,
        None => return Map::new(),
    };
    let source_row = match source_payload.as_object() {
        Some(v) => v,
        None => return Map::new(),
    };

    let mut patch = Map::new();
    for key in [
        "metadata",
        "temperature",
        "top_p",
        "prompt_cache_key",
        "reasoning",
    ] {
        if client_row.contains_key(key) {
            continue;
        }
        if let Some(value) = source_row.get(key) {
            patch.insert(key.to_string(), value.clone());
        }
    }

    if is_json_object(source_row.get("error")) {
        if let Some(value) = source_row.get("error") {
            patch.insert("error".to_string(), value.clone());
        }
    }

    patch
}

pub(crate) fn apply_client_passthrough_patch(
    client_payload: &Value,
    source_payload: &Value,
) -> Value {
    let mut merged = match client_payload.as_object() {
        Some(row) => row.clone(),
        None => return client_payload.clone(),
    };
    let patch = build_client_passthrough_patch(client_payload, source_payload);
    for (key, value) in patch {
        merged.insert(key, value);
    }
    Value::Object(merged)
}

pub(crate) fn sanitize_chat_completion_like(candidate: &Value) -> Option<Value> {
    let mut row = candidate.as_object()?.clone();
    if row
        .get("choices")
        .map(|value| !matches!(value, Value::Array(_)))
        .unwrap_or(false)
    {
        row.remove("choices");
    }
    if row
        .get("usage")
        .map(|value| !matches!(value, Value::Object(_)))
        .unwrap_or(false)
    {
        row.remove("usage");
    }
    Some(Value::Object(row))
}

pub(crate) fn derive_reasoning_details_from_payload(reasoning: &Value) -> Vec<Value> {
    let mut details: Vec<Value> = Vec::new();
    let Some(reasoning_row) = reasoning.as_object() else {
        return details;
    };

    if let Some(summary_items) = reasoning_row.get("summary").and_then(Value::as_array) {
        for entry in summary_items {
            let Some(entry_row) = entry.as_object() else {
                continue;
            };
            let text = entry_row
                .get("text")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let Some(text) = text else {
                continue;
            };
            let kind = entry_row
                .get("type")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "summary_text".to_string());
            details.push(Value::String(format!("[{}] {}", kind, text)));
        }
    }

    if let Some(content_items) = reasoning_row.get("content").and_then(Value::as_array) {
        for entry in content_items {
            let Some(entry_row) = entry.as_object() else {
                continue;
            };
            let text = entry_row
                .get("text")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let Some(text) = text else {
                continue;
            };
            let kind = entry_row
                .get("type")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "reasoning_text".to_string());
            details.push(Value::String(format!("[{}] {}", kind, text)));
        }
    }

    if let Some(encrypted_content) = reasoning_row
        .get("encrypted_content")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        details.push(Value::String(format!(
            "[reasoning.encrypted_content] {}",
            encrypted_content
        )));
    }

    details
}

pub(crate) fn normalize_client_openai_chat_message_reasoning(message: &mut Map<String, Value>) {
    normalize_message_reasoning_ssot(message);
    let has_reasoning_payload = message.get("reasoning").is_some();

    let reasoning_text = message
        .get("reasoning")
        .and_then(project_message_reasoning_text)
        .or_else(|| resolve_non_empty_string(message.get("reasoning_content")));
    let reasoning_details = message
        .get("reasoning")
        .map(derive_reasoning_details_from_payload)
        .unwrap_or_default();

    if let Some(text) = reasoning_text {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(text.to_string()),
        );
    } else {
        message.remove("reasoning_content");
        if !has_reasoning_payload {
            message.remove("reasoning");
        }
    }
    if !reasoning_details.is_empty() {
        message.insert(
            "reasoning_details".to_string(),
            Value::Array(reasoning_details),
        );
    } else {
        message.remove("reasoning_details");
    }
}

pub(crate) fn normalize_openai_chat_reasoning_outbound(candidate: &Value) -> Option<Value> {
    let mut row = sanitize_chat_completion_like(candidate)?
        .as_object()?
        .clone();
    if let Some(choices) = row.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices.iter_mut() {
            let Some(choice_row) = choice.as_object_mut() else {
                continue;
            };
            if let Some(message) = choice_row.get_mut("message").and_then(Value::as_object_mut) {
                normalize_client_openai_chat_message_reasoning(message);
            }
        }
    }
    Some(Value::Object(row))
}

fn resolve_non_empty_string(raw: Option<&Value>) -> Option<String> {
    raw.and_then(|value| {
        value
            .as_str()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}
