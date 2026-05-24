use serde_json::{Map, Value};
use std::collections::HashSet;

use crate::shared_json_utils::read_trimmed_string;

pub(crate) fn read_message_text_candidates(message: &Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();

    if let Some(content) = message.get("content") {
        match content {
            Value::String(text) => {
                if !text.trim().is_empty() {
                    out.push(text.clone());
                }
            }
            Value::Array(parts) => {
                for part in parts {
                    let Some(part_row) = part.as_object() else {
                        continue;
                    };
                    if let Some(text) = read_trimmed_string(part_row.get("text")) {
                        out.push(text);
                        continue;
                    }
                    if let Some(thinking) = read_trimmed_string(part_row.get("thinking")) {
                        out.push(thinking);
                        continue;
                    }
                    if let Some(text) = read_trimmed_string(part_row.get("content")) {
                        out.push(text);
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(reasoning) = read_trimmed_string(message.get("reasoning")) {
        out.push(reasoning);
    }
    if let Some(reasoning_content) = read_trimmed_string(message.get("reasoning_content")) {
        out.push(reasoning_content);
    }
    if let Some(thinking) = read_trimmed_string(message.get("thinking")) {
        out.push(thinking);
    }

    out
}

fn collect_thinking_reasoning_segments(message: &Map<String, Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::<String>::new();
    let mut push = |value: String| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        if seen.insert(trimmed.clone()) {
            out.push(trimmed);
        }
    };

    if let Some(content) = message.get("content") {
        match content {
            Value::Array(parts) => {
                for part in parts {
                    let Some(part_row) = part.as_object() else {
                        continue;
                    };
                    let part_type = read_trimmed_string(part_row.get("type"))
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    if part_type != "thinking" && part_type != "reasoning" {
                        continue;
                    }
                    if let Some(text) = read_trimmed_string(part_row.get("thinking"))
                        .or_else(|| read_trimmed_string(part_row.get("text")))
                        .or_else(|| read_trimmed_string(part_row.get("content")))
                    {
                        push(text);
                    }
                }
            }
            Value::Object(part_row) => {
                let part_type = read_trimmed_string(part_row.get("type"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if part_type == "thinking" || part_type == "reasoning" {
                    if let Some(text) = read_trimmed_string(part_row.get("thinking"))
                        .or_else(|| read_trimmed_string(part_row.get("text")))
                        .or_else(|| read_trimmed_string(part_row.get("content")))
                    {
                        push(text);
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(thinking) = read_trimmed_string(message.get("thinking")) {
        push(thinking);
    }

    out
}

fn has_visible_text_content_excluding_reasoning(content: Option<&Value>) -> bool {
    match content {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Array(parts)) => {
            parts
                .iter()
                .filter_map(|part| part.as_object())
                .any(|part_row| {
                    let part_type = read_trimmed_string(part_row.get("type"))
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    if part_type == "thinking" || part_type == "reasoning" {
                        return false;
                    }
                    read_trimmed_string(part_row.get("text")).is_some()
                        || read_trimmed_string(part_row.get("content")).is_some()
                })
        }
        Some(Value::Object(part_row)) => {
            let part_type = read_trimmed_string(part_row.get("type"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if part_type == "thinking" || part_type == "reasoning" {
                return false;
            }
            read_trimmed_string(part_row.get("text")).is_some()
                || read_trimmed_string(part_row.get("content")).is_some()
        }
        _ => false,
    }
}

pub(crate) fn normalize_thinking_only_reasoning_content(payload: &mut Value) -> i64 {
    let mut normalized = 0i64;
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return normalized;
    };

    for choice in choices {
        let Some(choice_row) = choice.as_object_mut() else {
            continue;
        };
        let Some(message) = choice_row
            .get_mut("message")
            .and_then(|v| v.as_object_mut())
        else {
            continue;
        };

        let has_tool_calls = message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .map(|rows| !rows.is_empty())
            .unwrap_or(false);
        if has_tool_calls {
            continue;
        }

        let thinking_segments = collect_thinking_reasoning_segments(message);
        if thinking_segments.is_empty() {
            continue;
        }

        let existing_reasoning = read_trimmed_string(message.get("reasoning_content"));
        let mut merged: Vec<String> = Vec::new();
        if let Some(existing) = existing_reasoning {
            merged.push(existing);
        }
        for segment in thinking_segments {
            if !merged.iter().any(|existing| existing == &segment) {
                merged.push(segment);
            }
        }
        if merged.is_empty() {
            continue;
        }

        message.insert(
            "reasoning_content".to_string(),
            Value::String(merged.join("\n\n")),
        );
        if !has_visible_text_content_excluding_reasoning(message.get("content")) {
            message.insert("content".to_string(), Value::String(String::new()));
        }
        normalized += 1;
    }

    normalized
}
