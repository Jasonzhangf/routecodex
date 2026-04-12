use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;

use crate::hub_reasoning_tool_normalizer::normalize_message_reasoning_tools_record;
use crate::hub_reasoning_tool_normalizer::sanitize_reasoning_tagged_text;
use crate::shared_chat_output_normalizer::normalize_chat_message_content;
use crate::shared_output_content_normalizer::normalize_message_content_parts;

use super::RESPONSES_INSTRUCTIONS_REASONING_FIELD;

use super::types::{
    ApplyBridgeReasoningExtractInput, ApplyBridgeReasoningExtractOutput,
    ApplyBridgeResponsesOutputReasoningInput, ApplyBridgeResponsesOutputReasoningOutput,
};

static THINK_OPEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<think>").expect("valid think open regex"));
static REFLECTION_OPEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<reflection>").expect("valid reflection open regex"));
static FENCED_OPEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)```\s*(?:think|reflection)").expect("valid fenced reasoning open regex")
});
static THINK_CLOSE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</think>").expect("valid think close regex"));
static REFLECTION_CLOSE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</reflection>").expect("valid reflection close regex"));
static THINK_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<think>(.*?)</think>").expect("valid think block regex"));
static REFLECTION_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<reflection>(.*?)</reflection>").expect("valid reflection block regex")
});
static FENCED_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)```\s*(?:think|reflection)[\s\S]*?```").expect("valid fenced block regex")
});
static THINK_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</?think>").expect("valid think tag regex"));
static REFLECTION_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</?reflection>").expect("valid reflection tag regex"));
static CN_THINK_OPEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)\[\s*思考\s*\]").expect("valid cn think open regex"));
static CN_THINK_CLOSE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)\[\s*/\s*思考\s*\]").expect("valid cn think close regex"));
static CN_THINK_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)\[\s*思考\s*\](.*?)\[\s*/\s*思考\s*\]").expect("valid cn think block regex")
});
static CN_THINK_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)\[\s*/?\s*思考\s*\]").expect("valid cn think tag regex"));
static BLANK_LINES_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n{3,}").expect("valid blank lines regex"));

fn maybe_contains_reasoning_markup(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    lower.contains("<think")
        || lower.contains("</think")
        || lower.contains("<reflection")
        || lower.contains("</reflection")
        || lower.contains("```think")
        || lower.contains("```reflection")
        || lower.contains("[思考]")
        || lower.contains("[/思考]")
}

pub(crate) fn extract_reasoning_segments(
    source: &str,
    reasoning_collector: Option<&mut Vec<String>>,
) -> String {
    if !maybe_contains_reasoning_markup(source) {
        return source.trim().to_string();
    }

    let has_explicit_open = THINK_OPEN_RE.is_match(source)
        || REFLECTION_OPEN_RE.is_match(source)
        || FENCED_OPEN_RE.is_match(source)
        || CN_THINK_OPEN_RE.is_match(source);
    let has_explicit_close = THINK_CLOSE_RE.is_match(source)
        || REFLECTION_CLOSE_RE.is_match(source)
        || CN_THINK_CLOSE_RE.is_match(source);

    let mut working = source.to_string();
    working = THINK_BLOCK_RE.replace_all(&working, "").to_string();
    working = REFLECTION_BLOCK_RE.replace_all(&working, "").to_string();
    working = FENCED_BLOCK_RE.replace_all(&working, "").to_string();
    working = CN_THINK_BLOCK_RE.replace_all(&working, "").to_string();
    working = THINK_TAG_RE.replace_all(&working, "").to_string();
    working = REFLECTION_TAG_RE.replace_all(&working, "").to_string();
    working = CN_THINK_TAG_RE.replace_all(&working, "").to_string();
    working = BLANK_LINES_RE.replace_all(&working, "\n\n").to_string();

    // second pass to collect inner segments with mutable borrow (keeps behavior aligned with TS)
    if let Some(collector) = reasoning_collector {
        for caps in THINK_BLOCK_RE.captures_iter(source) {
            let inner = caps
                .get(1)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            if !inner.is_empty() {
                collector.push(inner);
            }
        }
        for caps in REFLECTION_BLOCK_RE.captures_iter(source) {
            let inner = caps
                .get(1)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            if !inner.is_empty() {
                collector.push(inner);
            }
        }
        for caps in CN_THINK_BLOCK_RE.captures_iter(source) {
            let inner = caps
                .get(1)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            if !inner.is_empty() {
                collector.push(inner);
            }
        }
        if !has_explicit_open && has_explicit_close {
            let trimmed = working.trim().to_string();
            if !trimmed.is_empty() {
                collector.push(trimmed);
            }
            return String::new();
        }
    }

    working.trim().to_string()
}

fn process_text_value(value: &str, collector: &mut Vec<String>, drop_from_content: bool) -> String {
    let sanitized = extract_reasoning_segments(value, Some(collector));
    if drop_from_content {
        sanitized
    } else {
        value.to_string()
    }
}

fn strip_reasoning_from_value(
    value: &mut Value,
    collector: &mut Vec<String>,
    drop_from_content: bool,
) {
    match value {
        Value::String(text) => {
            *text = process_text_value(text, collector, drop_from_content);
        }
        Value::Array(entries) => {
            for entry in entries.iter_mut() {
                strip_reasoning_from_value(entry, collector, drop_from_content);
            }
        }
        Value::Object(record) => {
            if let Some(Value::String(text)) = record.get_mut("text") {
                *text = process_text_value(text, collector, drop_from_content);
            }
            if let Some(content) = record.get_mut("content") {
                match content {
                    Value::String(text) => {
                        *text = process_text_value(text, collector, drop_from_content);
                    }
                    Value::Array(entries) => {
                        for entry in entries.iter_mut() {
                            strip_reasoning_from_value(entry, collector, drop_from_content);
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

fn assign_reasoning_to_message(message_obj: &mut Map<String, Value>, parts: &[String]) {
    let mut trimmed_parts: Vec<String> = parts
        .iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect();
    if trimmed_parts.is_empty() {
        return;
    }
    if let Some(existing) = message_obj
        .get("reasoning_content")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        trimmed_parts.insert(0, existing);
    }
    let merged = trimmed_parts.join("\n").trim().to_string();
    if !merged.is_empty() {
        message_obj.insert("reasoning_content".to_string(), Value::String(merged));
    }
}

pub(crate) fn apply_bridge_reasoning_extract(
    input: ApplyBridgeReasoningExtractInput,
) -> ApplyBridgeReasoningExtractOutput {
    let drop_from_content = input.drop_from_content.unwrap_or(true);
    let id_prefix_base = input
        .id_prefix_base
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "bridge_reasoning".to_string());
    let mut messages = input.messages;
    for (idx, message) in messages.iter_mut().enumerate() {
        let Some(message_obj) = message.as_object_mut() else {
            continue;
        };
        let mut reasoning_parts: Vec<String> = Vec::new();
        if let Some(content) = message_obj.get_mut("content") {
            match content {
                Value::String(text) => {
                    *text = process_text_value(text, &mut reasoning_parts, drop_from_content);
                }
                Value::Array(entries) => {
                    for entry in entries.iter_mut() {
                        strip_reasoning_from_value(entry, &mut reasoning_parts, drop_from_content);
                    }
                }
                _ => {}
            }
        }
        assign_reasoning_to_message(message_obj, &reasoning_parts);
        let id_prefix = format!("{}_{}", id_prefix_base, idx + 1);
        normalize_message_reasoning_tools_record(message_obj, id_prefix.as_str());
    }
    ApplyBridgeReasoningExtractOutput { messages }
}

fn push_output_text(value: &str, text_parts: &mut Vec<String>, reasoning_parts: &mut Vec<String>) {
    if value.trim().is_empty() {
        return;
    }
    let cleaned = extract_reasoning_segments(value, Some(reasoning_parts));
    if !cleaned.is_empty() {
        text_parts.push(cleaned);
    }
}

fn collect_text_and_reasoning(
    blocks: &Value,
    text_parts: &mut Vec<String>,
    reasoning_parts: &mut Vec<String>,
) {
    match blocks {
        Value::String(text) => {
            push_output_text(text, text_parts, reasoning_parts);
        }
        Value::Array(entries) => {
            for entry in entries {
                let Some(record) = entry.as_object() else {
                    continue;
                };
                let block_type = record
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase();
                if matches!(
                    block_type.as_str(),
                    "text" | "input_text" | "output_text" | "commentary"
                ) {
                    if let Some(text) = record
                        .get("text")
                        .or_else(|| record.get("content"))
                        .and_then(Value::as_str)
                    {
                        push_output_text(text, text_parts, reasoning_parts);
                    }
                    continue;
                }
                if let Some(content) = record.get("content") {
                    if content.is_array() {
                        collect_text_and_reasoning(content, text_parts, reasoning_parts);
                        continue;
                    }
                }
                if let Some(text) = record.get("text").and_then(Value::as_str) {
                    push_output_text(text, text_parts, reasoning_parts);
                }
            }
        }
        _ => {}
    }
}

fn extract_output_segments(source: &Value, items_key: &str) -> (Vec<String>, Vec<String>) {
    let mut text_parts: Vec<String> = Vec::new();
    let mut reasoning_parts: Vec<String> = Vec::new();
    let Some(root) = source.as_object() else {
        return (text_parts, reasoning_parts);
    };
    let output_items = root
        .get(items_key)
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
        if item_type == "message" {
            let message = item_obj
                .get("message")
                .and_then(Value::as_object)
                .unwrap_or(item_obj);
            if let Some(content) = message.get("content") {
                collect_text_and_reasoning(content, &mut text_parts, &mut reasoning_parts);
            }
            continue;
        }
        if item_type == "output_text" {
            if let Some(text) = item_obj.get("text").and_then(Value::as_str) {
                let cleaned = extract_reasoning_segments(text, Some(&mut reasoning_parts));
                if !cleaned.is_empty() {
                    text_parts.push(cleaned);
                }
            }
            continue;
        }
        if item_type == "reasoning" {
            if let Some(content) = item_obj.get("content").and_then(Value::as_array) {
                for block in content {
                    let Some(block_obj) = block.as_object() else {
                        continue;
                    };
                    let Some(text) = block_obj.get("text").and_then(Value::as_str) else {
                        continue;
                    };
                    let sanitized = extract_reasoning_segments(text, None);
                    if !sanitized.is_empty() {
                        reasoning_parts.push(sanitized);
                    }
                }
            }
        }
    }

    (text_parts, reasoning_parts)
}

pub(crate) fn apply_bridge_responses_output_reasoning(
    input: ApplyBridgeResponsesOutputReasoningInput,
) -> ApplyBridgeResponsesOutputReasoningOutput {
    let mut messages = input.messages;
    let id_prefix = input
        .id_prefix
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "responses_response_output".to_string());
    let Some(raw_response) = input.raw_response else {
        return ApplyBridgeResponsesOutputReasoningOutput { messages };
    };
    let (text_parts, reasoning_parts) = extract_output_segments(&raw_response, "output");
    if text_parts.is_empty() && reasoning_parts.is_empty() {
        return ApplyBridgeResponsesOutputReasoningOutput { messages };
    }
    if messages.is_empty() {
        messages.push(serde_json::json!({
            "role": "assistant",
            "content": text_parts.join("\n")
        }));
    }

    let mut target_index = 0usize;
    for (idx, message) in messages.iter().enumerate() {
        let Some(obj) = message.as_object() else {
            continue;
        };
        let role = obj
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role == "assistant" {
            target_index = idx;
            break;
        }
    }

    if let Some(target) = messages
        .get_mut(target_index)
        .and_then(Value::as_object_mut)
    {
        if !text_parts.is_empty() {
            let combined_text = text_parts.join("\n");
            let has_content = target
                .get("content")
                .and_then(Value::as_str)
                .map(|text| !text.trim().is_empty())
                .unwrap_or(false);
            if !has_content {
                target.insert("content".to_string(), Value::String(combined_text));
            }
        }
        if !reasoning_parts.is_empty() {
            assign_reasoning_to_message(target, &reasoning_parts);
        }
        normalize_message_reasoning_tools_record(target, id_prefix.as_str());
    }

    ApplyBridgeResponsesOutputReasoningOutput { messages }
}

pub(crate) fn to_reasoning_segments(value: Option<&Value>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    match value {
        Value::Array(entries) => entries
            .iter()
            .filter_map(|entry| entry.as_str())
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect(),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed.to_string()]
            }
        }
        _ => Vec::new(),
    }
}

pub(crate) fn combine_reasoning_segments(primary: &[String], secondary: &[String]) -> Vec<String> {
    let mut combined: Vec<String> = Vec::new();
    for entry in primary {
        let trimmed = entry.trim();
        if !trimmed.is_empty() {
            combined.push(trimmed.to_string());
        }
    }
    for entry in secondary {
        let trimmed = entry.trim();
        if !trimmed.is_empty() {
            combined.push(trimmed.to_string());
        }
    }
    combined
}

fn normalize_reasoning_chat_message_container(container: &mut Map<String, Value>) {
    let existing_reasoning = container
        .get("reasoning_content")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let has_tool_calls = container
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    let normalized =
        normalize_chat_message_content(container.get("content").unwrap_or(&Value::Null));
    let role = container
        .get("role")
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    if let Some(content) = normalized
        .content_text
        .as_ref()
        .map(|text| text.trim().to_string())
    {
        if !content.is_empty() {
            container.insert("content".to_string(), Value::String(content));
        }
    } else if let Some(reasoning) = container
        .get("reasoning_content")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .filter(|_| !has_tool_calls)
    {
        container.insert("content".to_string(), Value::String(reasoning));
    } else if let Some(role_value) = role.as_deref() {
        if role_value != "system" && role_value != "tool" && !has_tool_calls {
            container.insert("content".to_string(), Value::String(String::new()));
        }
    }
    if let Some(reasoning) = normalized
        .reasoning_text
        .as_ref()
        .map(|text| text.trim().to_string())
    {
        if !reasoning.is_empty() {
            container.insert("reasoning_content".to_string(), Value::String(reasoning));
            return;
        }
    }
    if let Some(existing) = existing_reasoning {
        container.insert("reasoning_content".to_string(), Value::String(existing));
    } else if container.contains_key("reasoning_content") {
        container.remove("reasoning_content");
    }
}

pub(crate) fn normalize_reasoning_in_chat_payload(payload: &mut Value) {
    let Some(root) = payload.as_object_mut() else {
        return;
    };
    if let Some(messages) = root.get_mut("messages").and_then(Value::as_array_mut) {
        for entry in messages.iter_mut() {
            if let Some(obj) = entry.as_object_mut() {
                normalize_reasoning_chat_message_container(obj);
            }
        }
    }
    if let Some(choices) = root.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices.iter_mut() {
            let Some(choice_obj) = choice.as_object_mut() else {
                continue;
            };
            if let Some(message) = choice_obj.get_mut("message").and_then(Value::as_object_mut) {
                normalize_reasoning_chat_message_container(message);
            }
            if let Some(delta) = choice_obj.get_mut("delta").and_then(Value::as_object_mut) {
                normalize_reasoning_chat_message_container(delta);
            }
        }
    }
}

fn is_responses_message_item(value: &Value) -> bool {
    let Some(row) = value.as_object() else {
        return false;
    };
    if row.get("type").and_then(Value::as_str) != Some("message") {
        return false;
    }
    if !row.get("content").map(|v| v.is_array()).unwrap_or(false) {
        return false;
    }
    let status = row.get("status").and_then(Value::as_str).unwrap_or("");
    let role = row.get("role").and_then(Value::as_str).unwrap_or("");
    !status.is_empty() && !role.is_empty()
}

fn normalize_responses_output(payload: &mut Map<String, Value>) {
    let request_id = payload
        .get("id")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "responses".to_string());
    let Some(output_items) = payload.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    let mut normalized: Vec<Value> = Vec::new();
    for (idx, entry) in output_items.iter().enumerate() {
        if is_responses_message_item(entry) {
            let mut message = entry.clone();
            if let Some(obj) = message.as_object_mut() {
                let base_id = obj
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| format!("{}-message-{}", request_id, idx));
                obj.insert("id".to_string(), Value::String(base_id.clone()));
                let content = obj.get("content").cloned().unwrap_or(Value::Null);
                let normalized_parts_value = normalize_message_content_parts(&content, None);
                let normalized_parts = normalized_parts_value
                    .get("normalizedParts")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(vec![]));
                let reasoning_chunks = normalized_parts_value
                    .get("reasoningChunks")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                obj.insert("content".to_string(), normalized_parts.clone());
                if !reasoning_chunks.is_empty() {
                    let reasoning_item = serde_json::json!({
                        "id": format!("{}_reasoning", base_id),
                        "type": "reasoning",
                        "summary": [],
                        "content": reasoning_chunks
                            .iter()
                            .filter_map(Value::as_str)
                            .map(|text| serde_json::json!({"type": "reasoning_text", "text": text}))
                            .collect::<Vec<Value>>()
                    });
                    normalized.push(reasoning_item);
                }
            }
            normalized.push(message);
        } else {
            normalized.push(entry.clone());
        }
    }
    *output_items = normalized;
}

fn merge_reasoning_text(existing: Option<&Value>, segments: &[String]) -> Option<String> {
    let mut combined: Vec<String> = Vec::new();
    if let Some(Value::String(text)) = existing {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            combined.push(trimmed.to_string());
        }
    }
    for segment in segments {
        let trimmed = segment.trim();
        if !trimmed.is_empty() {
            combined.push(trimmed.to_string());
        }
    }
    if combined.is_empty() {
        None
    } else {
        Some(combined.join("\n"))
    }
}

fn to_reasoning_segments_from_value(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(entries)) => entries
            .iter()
            .filter_map(Value::as_str)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .collect(),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed.to_string()]
            }
        }
        _ => Vec::new(),
    }
}

fn strip_reasoning_from_text_value(text: &str, segments: &mut Vec<String>) -> String {
    let cleaned = extract_reasoning_segments(text, Some(segments));
    let sanitized = sanitize_reasoning_tagged_text(text);
    if sanitized.is_empty() {
        cleaned
    } else {
        sanitized
    }
}

fn normalize_responses_content_block(block: &mut Value, segments: &mut Vec<String>) {
    if let Some(text) = block.as_str() {
        let cleaned = strip_reasoning_from_text_value(text, segments);
        *block = Value::String(cleaned);
        return;
    }
    let Some(obj) = block.as_object_mut() else {
        return;
    };
    let block_type = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        block_type.as_str(),
        "input_text" | "output_text" | "text" | "commentary"
    ) {
        if let Some(text) = obj
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| obj.get("content").and_then(Value::as_str))
        {
            let cleaned = strip_reasoning_from_text_value(text, segments);
            obj.insert("text".to_string(), Value::String(cleaned));
            if !segments.is_empty() {
                if let Some(merged) = merge_reasoning_text(obj.get("reasoning_content"), segments) {
                    obj.insert("reasoning_content".to_string(), Value::String(merged));
                }
            }
        }
    }
    if let Some(content) = obj.get_mut("content") {
        if let Some(content_arr) = content.as_array_mut() {
            for nested in content_arr.iter_mut() {
                normalize_responses_content_block(nested, segments);
            }
        } else if let Some(text) = content.as_str() {
            let cleaned = strip_reasoning_from_text_value(text, segments);
            *content = Value::String(cleaned);
            if !segments.is_empty() {
                if let Some(merged) = merge_reasoning_text(obj.get("reasoning_content"), segments) {
                    obj.insert("reasoning_content".to_string(), Value::String(merged));
                }
            }
        }
    }
}

fn normalize_responses_message_block(
    message: &mut Map<String, Value>,
    collector: &mut Vec<String>,
) {
    let mut local_segments: Vec<String> = Vec::new();
    if let Some(content) = message.get_mut("content") {
        if let Some(arr) = content.as_array_mut() {
            for block in arr.iter_mut() {
                normalize_responses_content_block(block, &mut local_segments);
            }
        } else if let Some(text) = content.as_str() {
            let cleaned = strip_reasoning_from_text_value(text, &mut local_segments);
            *content = Value::String(cleaned);
        }
    }
    if let Some(text) = message.get("text").and_then(Value::as_str) {
        let cleaned = strip_reasoning_from_text_value(text, &mut local_segments);
        message.insert("text".to_string(), Value::String(cleaned));
    }
    if !local_segments.is_empty() {
        collector.extend(local_segments.clone());
        if let Some(merged) =
            merge_reasoning_text(message.get("reasoning_content"), &local_segments)
        {
            message.insert("reasoning_content".to_string(), Value::String(merged));
        }
    }
}

fn normalize_responses_input(payload: &mut Map<String, Value>) {
    let Some(entries) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    for entry in entries.iter_mut() {
        let Some(entry_obj) = entry.as_object_mut() else {
            continue;
        };
        let mut reasoning_segments: Vec<String> = Vec::new();
        if let Some(content) = entry_obj.get_mut("content") {
            if let Some(text) = content.as_str() {
                let cleaned = strip_reasoning_from_text_value(text, &mut reasoning_segments);
                *content = Value::String(cleaned);
            } else if let Some(content_arr) = content.as_array_mut() {
                for block in content_arr.iter_mut() {
                    normalize_responses_content_block(block, &mut reasoning_segments);
                }
            }
        }
        if let Some(message) = entry_obj.get_mut("message").and_then(Value::as_object_mut) {
            normalize_responses_message_block(message, &mut reasoning_segments);
        }
        if let Some(text) = entry_obj.get("text").and_then(Value::as_str) {
            let cleaned = strip_reasoning_from_text_value(text, &mut reasoning_segments);
            entry_obj.insert("text".to_string(), Value::String(cleaned));
        }
        if !reasoning_segments.is_empty() {
            if let Some(merged) =
                merge_reasoning_text(entry_obj.get("reasoning_content"), &reasoning_segments)
            {
                entry_obj.insert("reasoning_content".to_string(), Value::String(merged));
            }
        }
    }
}

fn normalize_responses_instructions(payload: &mut Map<String, Value>) {
    let Some(instructions) = payload.get("instructions").and_then(Value::as_str) else {
        return;
    };
    let mut segments: Vec<String> = Vec::new();
    let cleaned = strip_reasoning_from_text_value(instructions, &mut segments);
    payload.insert("instructions".to_string(), Value::String(cleaned));
    if !segments.is_empty() {
        payload.insert(
            RESPONSES_INSTRUCTIONS_REASONING_FIELD.to_string(),
            Value::String(segments.join("\n")),
        );
    }
}

fn normalize_responses_required_action(payload: &mut Map<String, Value>) {
    let Some(required_action) = payload
        .get_mut("required_action")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let Some(submit) = required_action
        .get_mut("submit_tool_outputs")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let Some(tool_calls) = submit.get_mut("tool_calls").and_then(Value::as_array_mut) else {
        return;
    };
    for call in tool_calls.iter_mut() {
        let Some(call_obj) = call.as_object_mut() else {
            continue;
        };
        if let Some(instructions) = call_obj.get("instructions").and_then(Value::as_str) {
            let mut segments: Vec<String> = Vec::new();
            let cleaned = strip_reasoning_from_text_value(instructions, &mut segments);
            call_obj.insert("instructions".to_string(), Value::String(cleaned));
            if !segments.is_empty() {
                if let Some(merged) =
                    merge_reasoning_text(call_obj.get("reasoning_content"), &segments)
                {
                    call_obj.insert("reasoning_content".to_string(), Value::String(merged));
                }
            }
        }
    }
}

pub(crate) fn normalize_reasoning_in_responses_payload(payload: &mut Value, options: &Value) {
    let Some(obj) = payload.as_object_mut() else {
        return;
    };
    let include_output = options
        .get("includeOutput")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let include_input = options
        .get("includeInput")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let include_required_action = options
        .get("includeRequiredAction")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let include_instructions = options
        .get("includeInstructions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if include_output {
        normalize_responses_output(obj);
    }
    if include_input {
        normalize_responses_input(obj);
    }
    if include_instructions {
        normalize_responses_instructions(obj);
    }
    if include_required_action {
        normalize_responses_required_action(obj);
    }
}

pub(crate) fn normalize_reasoning_in_gemini_payload(payload: &mut Value) {
    let Some(obj) = payload.as_object_mut() else {
        return;
    };
    let Some(contents) = obj.get_mut("contents").and_then(Value::as_array_mut) else {
        return;
    };
    for content in contents.iter_mut() {
        let Some(content_obj) = content.as_object_mut() else {
            continue;
        };
        let Some(parts) = content_obj.get_mut("parts").and_then(Value::as_array_mut) else {
            continue;
        };
        for part in parts.iter_mut() {
            let Some(part_obj) = part.as_object_mut() else {
                continue;
            };
            let Some(text) = part_obj.get("text").and_then(Value::as_str) else {
                continue;
            };
            let mut segments: Vec<String> = Vec::new();
            let cleaned = extract_reasoning_segments(text, Some(&mut segments));
            part_obj.insert("text".to_string(), Value::String(cleaned));
            if !segments.is_empty() {
                part_obj.insert("reasoning".to_string(), Value::String(segments.join("\n")));
            } else {
                part_obj.remove("reasoning");
            }
        }
    }
}

fn flatten_anthropic_text(source: &Value) -> String {
    if let Some(text) = source.as_str() {
        return text.to_string();
    }
    if let Some(arr) = source.as_array() {
        return arr
            .iter()
            .map(flatten_anthropic_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<String>>()
            .join("");
    }
    if let Some(obj) = source.as_object() {
        if let Some(text) = obj.get("text").and_then(Value::as_str) {
            return text.to_string();
        }
        if let Some(content) = obj.get("content") {
            return flatten_anthropic_text(content);
        }
    }
    String::new()
}

fn normalize_anthropic_block(block: &mut Value, collector: &mut Vec<String>) {
    if let Some(text) = block.as_str() {
        let cleaned = strip_reasoning_from_text_value(text, collector);
        *block = Value::String(cleaned);
        return;
    }
    let Some(obj) = block.as_object_mut() else {
        return;
    };
    let block_type = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if block_type == "text" {
        if let Some(text) = obj.get("text").and_then(Value::as_str) {
            let cleaned = strip_reasoning_from_text_value(text, collector);
            obj.insert("text".to_string(), Value::String(cleaned));
            return;
        }
    }
    if block_type == "thinking" || block_type == "reasoning" {
        let flattened = flatten_anthropic_text(&Value::Object(obj.clone()));
        if !flattened.trim().is_empty() {
            collector.push(flattened.trim().to_string());
        }
        return;
    }
    if let Some(content) = obj.get_mut("content") {
        if let Some(arr) = content.as_array_mut() {
            for nested in arr.iter_mut() {
                normalize_anthropic_block(nested, collector);
            }
        } else if let Some(text) = content.as_str() {
            let cleaned = strip_reasoning_from_text_value(text, collector);
            *content = Value::String(cleaned);
        }
    }
}

fn normalize_anthropic_message(message: &mut Map<String, Value>) {
    let mut segments: Vec<String> = Vec::new();
    if let Some(content) = message.get_mut("content") {
        if let Some(arr) = content.as_array_mut() {
            for block in arr.iter_mut() {
                normalize_anthropic_block(block, &mut segments);
            }
        } else if let Some(text) = content.as_str() {
            let cleaned = strip_reasoning_from_text_value(text, &mut segments);
            *content = Value::String(cleaned);
        }
    }
    if !segments.is_empty() {
        if let Some(merged) = merge_reasoning_text(message.get("reasoning_content"), &segments) {
            message.insert("reasoning_content".to_string(), Value::String(merged));
        }
    }
}

pub(crate) fn normalize_reasoning_in_anthropic_payload(payload: &mut Value) {
    let Some(obj) = payload.as_object_mut() else {
        return;
    };
    if let Some(content) = obj.get_mut("content") {
        if let Some(arr) = content.as_array_mut() {
            let mut response_segments: Vec<String> = Vec::new();
            for block in arr.iter_mut() {
                normalize_anthropic_block(block, &mut response_segments);
            }
            if !response_segments.is_empty() {
                if let Some(merged) =
                    merge_reasoning_text(obj.get("reasoning_content"), &response_segments)
                {
                    obj.insert("reasoning_content".to_string(), Value::String(merged));
                }
            }
        }
    }
    if let Some(messages) = obj.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages.iter_mut() {
            if let Some(msg_obj) = message.as_object_mut() {
                normalize_anthropic_message(msg_obj);
            }
        }
    }
    if let Some(system_field) = obj.get_mut("system") {
        if let Some(text) = system_field.as_str() {
            let cleaned = strip_reasoning_from_text_value(text, &mut Vec::new());
            *system_field = Value::String(cleaned);
        } else if let Some(arr) = system_field.as_array_mut() {
            for entry in arr.iter_mut() {
                normalize_anthropic_block(entry, &mut Vec::new());
            }
        } else if let Some(sys_obj) = system_field.as_object_mut() {
            if let Some(content) = sys_obj.get_mut("content") {
                if let Some(arr) = content.as_array_mut() {
                    for entry in arr.iter_mut() {
                        normalize_anthropic_block(entry, &mut Vec::new());
                    }
                }
            }
        }
    }
}
