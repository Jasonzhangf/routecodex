use crate::hub_reasoning_tool_normalizer::sanitize_reasoning_tagged_text;
use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

fn push_trimmed(parts: &mut Vec<String>, value: &str) {
    let trimmed = value.trim();
    if !trimmed.is_empty() {
        parts.push(trimmed.to_string());
    }
}

fn collect_text_from_blocks(value: &Value, parts: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for entry in items {
                collect_text_from_blocks(entry, parts);
            }
        }
        Value::Object(record) => {
            let type_value = record
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            if matches!(
                type_value.as_str(),
                "input_text" | "output_text" | "text" | "commentary"
            ) {
                if let Some(text) = record.get("text").and_then(Value::as_str) {
                    push_trimmed(parts, text);
                    return;
                }
            }
            if type_value == "message" {
                if let Some(content) = record.get("content") {
                    collect_text_from_blocks(content, parts);
                    return;
                }
            }
            if let Some(content) = record.get("content") {
                match content {
                    Value::String(text) => {
                        push_trimmed(parts, text);
                    }
                    Value::Array(_) | Value::Object(_) => {
                        collect_text_from_blocks(content, parts);
                    }
                    _ => {}
                }
            }
            if let Some(text) = record.get("text").and_then(Value::as_str) {
                push_trimmed(parts, text);
            }
        }
        _ => {}
    }
}

fn is_system_entry(entry: &Value) -> bool {
    let role = entry
        .get("role")
        .and_then(Value::as_str)
        .or_else(|| {
            entry
                .get("message")
                .and_then(Value::as_object)
                .and_then(|msg| msg.get("role"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    role.eq_ignore_ascii_case("system")
}

fn extract_system_instruction(entry: &Value) -> Option<String> {
    if !is_system_entry(entry) {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(content) = entry.get("content") {
        match content {
            Value::Array(_) | Value::Object(_) => collect_text_from_blocks(content, &mut parts),
            Value::String(text) => push_trimmed(&mut parts, text),
            _ => {}
        }
    }
    if let Some(text) = entry.get("text").and_then(Value::as_str) {
        push_trimmed(&mut parts, text);
    }
    if let Some(message) = entry.get("message").and_then(Value::as_object) {
        if let Some(content) = message.get("content") {
            match content {
                Value::Array(_) | Value::Object(_) => collect_text_from_blocks(content, &mut parts),
                Value::String(text) => push_trimmed(&mut parts, text),
                _ => {}
            }
        }
        if let Some(text) = message.get("text").and_then(Value::as_str) {
            push_trimmed(&mut parts, text);
        }
    }
    if parts.is_empty() {
        return None;
    }
    let merged = sanitize_reasoning_tagged_text(parts.join("\n").as_str());
    let trimmed = merged.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

pub(crate) fn ensure_bridge_instructions(payload: &mut Map<String, Value>) -> Option<String> {
    let mut instructions = payload
        .get("instructions")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let has_client_instruction = payload
        .get("instructions")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false);

    if let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) {
        let mut next: Vec<Value> = Vec::with_capacity(input.len());
        for entry in input.drain(..) {
            if is_system_entry(&entry) {
                if !has_client_instruction && instructions.is_empty() {
                    if let Some(text) = extract_system_instruction(&entry) {
                        if !text.is_empty() {
                            instructions = text;
                        }
                    }
                }
                continue;
            }
            next.push(entry);
        }
        *input = next;
    }

    if !instructions.is_empty() {
        payload.insert(
            "instructions".to_string(),
            Value::String(instructions.clone()),
        );
        return Some(instructions);
    }
    if payload.contains_key("instructions") {
        payload.remove("instructions");
    }
    None
}

#[napi]
pub fn ensure_bridge_instructions_json(payload_json: String) -> NapiResult<String> {
    let mut payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload JSON: {}", e)))?;
    if let Some(obj) = payload.as_object_mut() {
        ensure_bridge_instructions(obj);
    }
    serde_json::to_string(&payload)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize payload: {}", e)))
}
