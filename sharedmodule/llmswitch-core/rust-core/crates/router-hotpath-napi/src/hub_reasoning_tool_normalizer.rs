use crate::hub_resp_outbound_client_semantics::normalize_responses_function_name;
use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const MAX_RESPONSES_ITEM_ID_LENGTH: usize = 64;

#[derive(Debug, Clone)]
struct ParsedToolCall {
    id: Option<String>,
    name: String,
    args: String,
}

#[derive(Debug, Clone)]
struct MatchEntry {
    start: usize,
    end: usize,
    call: ParsedToolCall,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NormalizeMessageReasoningToolsOutput {
    message: Value,
    tool_calls_added: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    cleaned_reasoning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractToolCallsFromReasoningTextOutput {
    cleaned_text: String,
    tool_calls: Vec<Value>,
}

#[derive(Debug, Serialize)]
struct ResponsesReasoningItem {
    r#type: String,
    content: String,
}

fn flatten_reasoning(value: &Value, depth: usize) -> String {
    if depth > 4 {
        return String::new();
    }
    match value {
        Value::String(text) => text.clone(),
        Value::Array(entries) => entries
            .iter()
            .map(|entry| flatten_reasoning(entry, depth + 1))
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<String>>()
            .join("\n"),
        Value::Object(row) => {
            if let Some(text) = row.get("text").and_then(Value::as_str) {
                return text.to_string();
            }
            if let Some(text) = row.get("content").and_then(Value::as_str) {
                return text.to_string();
            }
            if let Some(content) = row.get("content") {
                return flatten_reasoning(content, depth + 1);
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn collect_typed_reasoning_entries(value: Option<&Value>, expected_type: &str) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Some(entries) = value.as_array() else {
        return Vec::new();
    };

    entries
        .iter()
        .filter_map(|entry| {
            let row = entry.as_object()?;
            let kind = row
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or(expected_type)
                .trim()
                .to_ascii_lowercase();
            if kind != expected_type {
                return None;
            }
            row.get("text")
                .and_then(Value::as_str)
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
        })
        .collect()
}

fn read_trimmed_reasoning_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

pub(crate) fn build_message_reasoning_value(
    summary_segments: &[String],
    content_segments: &[String],
    encrypted_content: Option<&str>,
) -> Option<Value> {
    let summary: Vec<Value> = summary_segments
        .iter()
        .filter_map(|text| {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(serde_json::json!({
                    "type": "summary_text",
                    "text": trimmed,
                }))
            }
        })
        .collect();
    let content: Vec<Value> = content_segments
        .iter()
        .filter_map(|text| {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(serde_json::json!({
                    "type": "reasoning_text",
                    "text": trimmed,
                }))
            }
        })
        .collect();
    let encrypted = encrypted_content
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());

    if summary.is_empty() && content.is_empty() && encrypted.is_none() {
        return None;
    }

    let mut reasoning = Map::new();
    if !summary.is_empty() {
        reasoning.insert("summary".to_string(), Value::Array(summary));
    }
    if !content.is_empty() {
        reasoning.insert("content".to_string(), Value::Array(content));
    }
    if let Some(encrypted_content) = encrypted {
        reasoning.insert(
            "encrypted_content".to_string(),
            Value::String(encrypted_content),
        );
    }
    Some(Value::Object(reasoning))
}

fn collect_message_reasoning_state(
    message: &Map<String, Value>,
) -> (Vec<String>, Vec<String>, Option<String>) {
    if let Some(reasoning) = message.get("reasoning") {
        if let Some(reasoning_row) = reasoning.as_object() {
            let summary =
                collect_typed_reasoning_entries(reasoning_row.get("summary"), "summary_text");
            let content =
                collect_typed_reasoning_entries(reasoning_row.get("content"), "reasoning_text");
            let encrypted = read_trimmed_reasoning_string(reasoning_row.get("encrypted_content"));
            if !summary.is_empty() || !content.is_empty() || encrypted.is_some() {
                return (summary, content, encrypted);
            }
        }

        let text = flatten_reasoning(reasoning, 0).trim().to_string();
        if !text.is_empty() {
            return (Vec::new(), vec![text], None);
        }
    }

    let reasoning_content = message
        .get("reasoning_content")
        .map(|value| flatten_reasoning(value, 0).trim().to_string())
        .filter(|text| !text.is_empty())
        .into_iter()
        .collect::<Vec<String>>();
    (Vec::new(), reasoning_content, None)
}

pub(crate) fn collect_reasoning_content_segments(value: Option<&Value>) -> Vec<String> {
    let Some(reasoning) = value else {
        return Vec::new();
    };
    if let Some(reasoning_row) = reasoning.as_object() {
        let content =
            collect_typed_reasoning_entries(reasoning_row.get("content"), "reasoning_text");
        if !content.is_empty() {
            return content;
        }
    }
    let text = flatten_reasoning(reasoning, 0).trim().to_string();
    if text.is_empty() {
        return Vec::new();
    }
    vec![text]
}

pub(crate) fn collect_reasoning_summary_segments(value: Option<&Value>) -> Vec<String> {
    let Some(reasoning) = value else {
        return Vec::new();
    };
    let Some(reasoning_row) = reasoning.as_object() else {
        return Vec::new();
    };
    collect_typed_reasoning_entries(reasoning_row.get("summary"), "summary_text")
}

pub(crate) fn project_message_reasoning_text(value: &Value) -> Option<String> {
    let content = collect_reasoning_content_segments(Some(value));
    if !content.is_empty() {
        return Some(content.join("\n"));
    }

    let summary = collect_reasoning_summary_segments(Some(value));
    if !summary.is_empty() {
        return Some(summary.join("\n"));
    }

    None
}

pub(crate) fn normalize_message_reasoning_ssot(message: &mut Map<String, Value>) {
    let (summary, content, encrypted) = collect_message_reasoning_state(message);
    let Some(reasoning) = build_message_reasoning_value(&summary, &content, encrypted.as_deref())
    else {
        message.remove("reasoning");
        message.remove("reasoning_content");
        return;
    };

    let projection = project_message_reasoning_text(&reasoning);
    message.insert("reasoning".to_string(), reasoning);
    if let Some(text) = projection {
        message.insert("reasoning_content".to_string(), Value::String(text));
    } else {
        message.remove("reasoning_content");
    }
}

fn collect_reasoning_fragments(message: &Map<String, Value>) -> Vec<String> {
    let mut fragments: Vec<String> = Vec::new();
    if let Some(reasoning) = message.get("reasoning") {
        let text = flatten_reasoning(reasoning, 0);
        if !text.is_empty() {
            fragments.push(text);
        }
        return fragments;
    }
    if let Some(reasoning_content) = message.get("reasoning_content") {
        let text = flatten_reasoning(reasoning_content, 0);
        if !text.is_empty() {
            fragments.push(text);
        }
    }
    fragments
}

fn write_reasoning_content(message: &mut Map<String, Value>, text: &str) {
    let trimmed = text.trim().to_string();
    let (summary, _content, encrypted) = collect_message_reasoning_state(message);
    let content = if trimmed.is_empty() {
        Vec::new()
    } else {
        vec![trimmed]
    };
    if let Some(reasoning) = build_message_reasoning_value(&summary, &content, encrypted.as_deref())
    {
        let projection = project_message_reasoning_text(&reasoning);
        message.insert("reasoning".to_string(), reasoning);
        if let Some(text) = projection {
            message.insert("reasoning_content".to_string(), Value::String(text));
        } else {
            message.remove("reasoning_content");
        }
    } else {
        message.remove("reasoning");
        message.remove("reasoning_content");
    }
}

fn strip_reasoning_tags(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let think_pattern = Regex::new(r"(?i)</?think[^>]*>").expect("valid think pattern");
    let reflection_pattern =
        Regex::new(r"(?i)</?reflection[^>]*>").expect("valid reflection pattern");
    let cn_think_tag = Regex::new(r"(?is)\[/?\s*思考\s*\]").expect("valid cn think tag pattern");
    let without_think = think_pattern.replace_all(text, "");
    let without_reflection = reflection_pattern.replace_all(&without_think, "");
    let without_cn_think = cn_think_tag.replace_all(&without_reflection, "");
    without_cn_think.trim().to_string()
}

pub(crate) fn sanitize_reasoning_tagged_text(text: &str) -> String {
    if text.trim().is_empty() {
        return String::new();
    }
    let fenced = Regex::new(r"(?is)```\s*(?:think|reflection)[\s\S]*?```")
        .expect("valid fenced think pattern");
    let think = Regex::new(r"(?is)<think>[\s\S]*?</think>").expect("valid think block pattern");
    let reflection = Regex::new(r"(?is)<reflection>[\s\S]*?</reflection>")
        .expect("valid reflection block pattern");
    let open_close =
        Regex::new(r"(?is)</?(?:think|reflection)>").expect("valid open/close pattern");
    let cn_think_tag = Regex::new(r"(?is)\[/?\s*思考\s*\]").expect("valid cn think tag pattern");
    let multiple_breaks = Regex::new(r"\n{3,}").expect("valid line break pattern");

    let without_fenced = fenced.replace_all(text, "");
    let without_think = think.replace_all(&without_fenced, "");
    let without_reflection = reflection.replace_all(&without_think, "");
    let without_open_close = open_close.replace_all(&without_reflection, "");
    let without_cn_think = cn_think_tag.replace_all(&without_open_close, "");
    let without_tags = without_cn_think;
    multiple_breaks
        .replace_all(&without_tags, "\n\n")
        .trim()
        .to_string()
}

fn map_reasoning_content_to_responses_output(
    reasoning_content: &Value,
) -> Vec<ResponsesReasoningItem> {
    if reasoning_content.is_null() {
        return Vec::new();
    }
    let text = if let Some(entries) = reasoning_content.as_array() {
        entries
            .iter()
            .filter_map(|entry| {
                entry
                    .as_object()
                    .and_then(|row| row.get("text"))
                    .and_then(Value::as_str)
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
            })
            .collect::<Vec<String>>()
            .join("\n")
    } else if let Some(row) = reasoning_content.as_object() {
        row.get("text")
            .and_then(Value::as_str)
            .map(|v| v.trim().to_string())
            .unwrap_or_default()
    } else {
        String::new()
    };

    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Vec::new();
    }
    vec![ResponsesReasoningItem {
        r#type: "reasoning".to_string(),
        content: trimmed,
    }]
}

fn is_image_path(input: &str) -> bool {
    let lowered = input.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return false;
    }
    let re = Regex::new(r"\.(png|jpg|jpeg|gif|webp|bmp|svg|tiff?|ico|heic|jxl)$")
        .expect("valid image suffix pattern");
    re.is_match(lowered.as_str())
}

fn short_hash(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::new();
    for byte in digest.iter().take(5) {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

fn sanitize_core(value: &str) -> String {
    let non_word = Regex::new(r"[^A-Za-z0-9_-]").expect("valid non-word pattern");
    let mut out = non_word.replace_all(value, "_").to_string();
    let repeated = Regex::new(r"_{2,}").expect("valid repeated underscore pattern");
    out = repeated.replace_all(out.as_str(), "_").to_string();
    out.trim_matches('_').to_string()
}

fn extract_core(value: Option<&str>) -> Option<String> {
    let trimmed = value.unwrap_or("").trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut sanitized = sanitize_core(trimmed);
    if sanitized.is_empty() {
        return None;
    }
    let lowered = sanitized.to_ascii_lowercase();
    if lowered.starts_with("fc_") || lowered.starts_with("fc-") {
        sanitized = sanitized.chars().skip(3).collect::<String>();
    } else if lowered.starts_with("call_") || lowered.starts_with("call-") {
        sanitized = sanitized.chars().skip(5).collect::<String>();
    }
    let normalized = sanitize_core(sanitized.as_str());
    if normalized.is_empty() {
        return None;
    }
    Some(normalized)
}

fn clamp_prefixed_id(prefix: &str, core: &str, hash_source: &str) -> String {
    let sanitized = sanitize_core(core);
    let stable = if sanitized.is_empty() {
        short_hash(hash_source)
    } else {
        sanitized
    };
    let direct = format!("{}{}", prefix, stable);
    if direct.len() <= MAX_RESPONSES_ITEM_ID_LENGTH {
        return direct;
    }
    let hash = short_hash(format!("{}|{}|{}", prefix, hash_source, stable).as_str());
    let room = MAX_RESPONSES_ITEM_ID_LENGTH
        .saturating_sub(prefix.len())
        .saturating_sub(1)
        .max(1);
    let capped_room = room.saturating_sub(hash.len()).max(1);
    let head = sanitize_core(&stable.chars().take(capped_room).collect::<String>());
    let normalized_head = if head.is_empty() {
        "id".to_string()
    } else {
        head
    };
    format!("{}{}_{}", prefix, normalized_head, hash)
}

fn normalize_with_fallback(call_id: Option<&str>, fallback: Option<&str>, prefix: &str) -> String {
    if let Some(call_core) = extract_core(call_id) {
        return clamp_prefixed_id(prefix, call_core.as_str(), call_id.unwrap_or(""));
    }
    if let Some(fallback_core) = extract_core(fallback) {
        return clamp_prefixed_id(prefix, fallback_core.as_str(), fallback.unwrap_or(""));
    }
    let seed = short_hash("routecodex_fallback");
    clamp_prefixed_id(prefix, seed.as_str(), seed.as_str())
}

fn clamp_responses_input_item_id(raw: Option<&str>) -> Option<String> {
    let trimmed = raw.unwrap_or("").trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() <= MAX_RESPONSES_ITEM_ID_LENGTH {
        return Some(trimmed.to_string());
    }
    let hash = short_hash(trimmed);
    let room = MAX_RESPONSES_ITEM_ID_LENGTH
        .saturating_sub(1)
        .saturating_sub(hash.len())
        .max(1);
    let head = trimmed.chars().take(room).collect::<String>();
    Some(format!("{}_{}", head, hash))
}

fn parse_lenient_string(value: &str) -> Value {
    let s0 = value.trim();
    if s0.is_empty() {
        return Value::Object(Map::new());
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(s0) {
        return parsed;
    }

    let fence_pattern =
        Regex::new(r"(?is)```(?:json)?\s*([\s\S]*?)\s*```").expect("valid fence pattern");
    let candidate = fence_pattern
        .captures(s0)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().trim().to_string()))
        .unwrap_or_else(|| s0.to_string());

    let object_pattern = Regex::new(r"(?s)\{[\s\S]*\}").expect("valid object pattern");
    if let Some(matched) = object_pattern.find(candidate.as_str()) {
        if let Ok(parsed) = serde_json::from_str::<Value>(matched.as_str()) {
            return parsed;
        }
    }

    let array_pattern = Regex::new(r"(?s)\[[\s\S]*\]").expect("valid array pattern");
    if let Some(matched) = array_pattern.find(candidate.as_str()) {
        if let Ok(parsed) = serde_json::from_str::<Value>(matched.as_str()) {
            return parsed;
        }
    }

    let single_quote_pattern =
        Regex::new(r#"'([^'\\]*(?:\\.[^'\\]*)*)'"#).expect("valid single quote pattern");
    let unquoted_key_pattern =
        Regex::new(r#"([{,\s])([A-Za-z_][A-Za-z0-9_-]*)\s*:"#).expect("valid key quote pattern");
    let quoted = single_quote_pattern
        .replace_all(candidate.as_str(), r#""$1""#)
        .to_string();
    let normalized = unquoted_key_pattern
        .replace_all(quoted.as_str(), r#"$1"$2":"#)
        .to_string();
    if let Ok(parsed) = serde_json::from_str::<Value>(normalized.as_str()) {
        return parsed;
    }
    let normalized_escaped_quotes =
        escape_unescaped_quotes_inside_json_strings(normalized.as_str());
    if let Ok(parsed) = serde_json::from_str::<Value>(normalized_escaped_quotes.as_str()) {
        return parsed;
    }

    let mut object = Map::new();
    let split_pattern = Regex::new(r"[\n,]+").expect("valid split pattern");
    let pair_pattern =
        Regex::new(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(.+)$").expect("valid pair pattern");
    for piece in split_pattern
        .split(candidate.as_str())
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
    {
        let Some(caps) = pair_pattern.captures(piece) else {
            continue;
        };
        let key = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        let mut raw_value = caps
            .get(2)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if raw_value.is_empty() {
            continue;
        }
        let quoted = (raw_value.starts_with('"') && raw_value.ends_with('"'))
            || (raw_value.starts_with('\'') && raw_value.ends_with('\''));
        if quoted && raw_value.len() >= 2 {
            raw_value = raw_value[1..raw_value.len() - 1].to_string();
        }

        let parsed_value = serde_json::from_str::<Value>(raw_value.as_str())
            .or_else(|_| {
                if raw_value.eq_ignore_ascii_case("true") {
                    Ok(Value::Bool(true))
                } else if raw_value.eq_ignore_ascii_case("false") {
                    Ok(Value::Bool(false))
                } else if let Ok(num) = raw_value.parse::<f64>() {
                    if num.fract() == 0.0 {
                        Ok(Value::Number((num as i64).into()))
                    } else {
                        serde_json::Number::from_f64(num)
                            .map(Value::Number)
                            .ok_or_else(|| {
                                serde_json::Error::io(std::io::Error::new(
                                    std::io::ErrorKind::Other,
                                    "invalid number",
                                ))
                            })
                    }
                } else {
                    Ok(Value::String(raw_value.clone()))
                }
            })
            .unwrap_or(Value::String(raw_value));
        object.insert(key.to_string(), parsed_value);
    }

    Value::Object(object)
}

fn escape_unescaped_quotes_inside_json_strings(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len() + 8);
    let mut in_string = false;
    let mut escaped = false;
    let mut idx = 0usize;

    while idx < chars.len() {
        let ch = chars[idx];
        if in_string {
            if escaped {
                escaped = false;
                out.push(ch);
                idx += 1;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                out.push(ch);
                idx += 1;
                continue;
            }
            if ch == '"' {
                let mut lookahead = idx + 1;
                while lookahead < chars.len() && chars[lookahead].is_whitespace() {
                    lookahead += 1;
                }
                let next = chars.get(lookahead).copied();
                let should_close =
                    matches!(next, None | Some(',') | Some('}') | Some(']') | Some(':'));
                if should_close {
                    in_string = false;
                    out.push(ch);
                } else {
                    out.push('\\');
                    out.push(ch);
                }
                idx += 1;
                continue;
            }
            out.push(ch);
            idx += 1;
            continue;
        }

        if ch == '"' {
            in_string = true;
        }
        out.push(ch);
        idx += 1;
    }

    out
}

fn join_command_array(mut obj: Value) -> Value {
    if let Value::Object(row) = &mut obj {
        if let Some(command_value) = row.get_mut("command") {
            if let Value::Array(tokens) = command_value {
                let joined = tokens
                    .iter()
                    .map(|token| match token {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .collect::<Vec<String>>()
                    .join(" ");
                *command_value = Value::String(joined);
            }
        }
    }
    obj
}

pub(crate) fn repair_arguments_to_string(value: &Value) -> String {
    match value {
        Value::Null => "{}".to_string(),
        Value::Object(_) | Value::Array(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
        }
        Value::String(raw) => {
            let raw_text = raw.as_str();
            if looks_like_apply_patch(raw_text) {
                return raw_text.to_string();
            }
            let mut s = raw.trim().to_string();
            if s.is_empty() {
                return "{}".to_string();
            }

            if serde_json::from_str::<Value>(s.as_str()).is_ok() {
                return s;
            }

            let fence_pattern =
                Regex::new(r"(?is)```(?:json)?\s*([\s\S]*?)\s*```").expect("valid fence pattern");
            if let Some(caps) = fence_pattern.captures(s.as_str()) {
                if let Some(inner) = caps.get(1) {
                    s = inner.as_str().trim().to_string();
                }
            }

            let line_comment_pattern =
                Regex::new(r"(?m)//.*$").expect("valid line comment pattern");
            let block_comment_pattern =
                Regex::new(r"(?s)/\*[\s\S]*?\*/").expect("valid block comment pattern");
            s = line_comment_pattern.replace_all(s.as_str(), "").to_string();
            s = block_comment_pattern
                .replace_all(s.as_str(), "")
                .to_string();

            let trailing_comma_pattern =
                Regex::new(r",\s*([}\]])").expect("valid trailing comma pattern");
            s = trailing_comma_pattern
                .replace_all(s.as_str(), "$1")
                .to_string();

            let single_quote_pattern =
                Regex::new(r#"'([^'\\]*(?:\\.[^'\\]*)*)'"#).expect("valid single quote pattern");
            let unquoted_key_pattern = Regex::new(r#"([{,\s])([A-Za-z_][A-Za-z0-9_-]*)\s*:"#)
                .expect("valid unquoted key pattern");
            s = single_quote_pattern
                .replace_all(s.as_str(), r#""$1""#)
                .to_string();
            s = unquoted_key_pattern
                .replace_all(s.as_str(), r#"$1"$2":"#)
                .to_string();

            if let Ok(obj) = serde_json::from_str::<Value>(s.as_str()) {
                return serde_json::to_string(&join_command_array(obj))
                    .unwrap_or_else(|_| "{}".to_string());
            }

            let first_block_pattern =
                Regex::new(r"(?s)\{[\s\S]*\}|\[[\s\S]*\]").expect("valid first block pattern");
            if let Some(matched) = first_block_pattern.find(s.as_str()) {
                if let Ok(obj) = serde_json::from_str::<Value>(matched.as_str()) {
                    return serde_json::to_string(&join_command_array(obj))
                        .unwrap_or_else(|_| "{}".to_string());
                }
            }

            "{}".to_string()
        }
        other => serde_json::to_string(&serde_json::json!({ "_raw": other.to_string() }))
            .unwrap_or_else(|_| "{}".to_string()),
    }
}

fn looks_like_apply_patch(raw: &str) -> bool {
    if raw.is_empty() {
        return false;
    }
    let begin_pattern =
        Regex::new(r"(?m)^\s*\*{3}\s*Begin Patch\b").expect("valid begin patch pattern");
    let end_pattern = Regex::new(r"(?m)^\s*\*{3}\s*End Patch\b").expect("valid end patch pattern");
    begin_pattern.is_match(raw) || end_pattern.is_match(raw)
}

fn normalize_tool_arg_key(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut key = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            key.push(ch.to_ascii_lowercase());
        } else if ch == '-' || ch == '.' || ch.is_ascii_whitespace() {
            key.push('_');
        }
    }
    let compacted = key
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<&str>>()
        .join("_");
    if compacted.is_empty() {
        None
    } else {
        Some(compacted)
    }
}

fn parse_markup_argument_value(raw: &str) -> Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Value::String(String::new());
    }
    let trimmed = {
        let mut candidate = trimmed.to_string();
        if let Ok(trailing_broken_close_re) = Regex::new(r"(?is)</\s*$") {
            candidate = trailing_broken_close_re
                .replace(candidate.as_str(), "")
                .to_string();
        }
        candidate.trim().to_string()
    };
    if trimmed.is_empty() {
        return Value::String(String::new());
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed.as_str()) {
        return parsed;
    }
    if (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
    {
        let parsed = parse_lenient_string(trimmed.as_str());
        if !matches!(parsed, Value::Object(ref row) if row.is_empty()) {
            return parsed;
        }
    }
    if trimmed.eq_ignore_ascii_case("true") {
        return Value::Bool(true);
    }
    if trimmed.eq_ignore_ascii_case("false") {
        return Value::Bool(false);
    }
    if let Ok(value) = trimmed.parse::<i64>() {
        return Value::Number(value.into());
    }
    if let Ok(value) = trimmed.parse::<f64>() {
        if let Some(number) = serde_json::Number::from_f64(value) {
            return Value::Number(number);
        }
    }
    let quoted = (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('\'') && trimmed.ends_with('\''));
    if quoted && trimmed.len() >= 2 {
        return Value::String(trimmed[1..trimmed.len() - 1].to_string());
    }
    Value::String(trimmed.to_string())
}

fn normalize_tool_name(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("execute") {
        return "shell".to_string();
    }
    let without_prefix = if trimmed.to_ascii_lowercase().starts_with("functions.") {
        trimmed[10..].trim()
    } else {
        trimmed
    };
    normalize_responses_function_name(Some(without_prefix))
        .unwrap_or_else(|| without_prefix.to_string())
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        Value::Array(entries) => entries
            .iter()
            .map(value_to_string)
            .collect::<Vec<String>>()
            .join(" "),
        other => other.to_string(),
    }
}

fn apply_markup_arg_aliases(tool_name: &str, args_obj: &mut Map<String, Value>) {
    let lname = tool_name.trim().to_ascii_lowercase();
    if lname == "write_stdin" {
        if !args_obj.contains_key("chars") && !args_obj.contains_key("text") {
            if let Some(value) = args_obj.remove("data").or_else(|| args_obj.remove("input")) {
                args_obj.insert("chars".to_string(), Value::String(value_to_string(&value)));
            }
        } else {
            args_obj.remove("data");
            args_obj.remove("input");
        }

        if !args_obj.contains_key("yield_time_ms") {
            if let Some(wait) = args_obj.remove("wait") {
                let mut ms: Option<i64> = None;
                match wait {
                    Value::Number(n) => {
                        if let Some(v) = n.as_f64() {
                            ms = Some(if v <= 1000.0 {
                                (v * 1000.0).round() as i64
                            } else {
                                v.round() as i64
                            });
                        }
                    }
                    Value::String(text) => {
                        if let Ok(v) = text.trim().parse::<f64>() {
                            ms = Some(if v <= 1000.0 {
                                (v * 1000.0).round() as i64
                            } else {
                                v.round() as i64
                            });
                        }
                    }
                    _ => {}
                }
                if let Some(value) = ms {
                    args_obj.insert("yield_time_ms".to_string(), Value::Number(value.into()));
                }
            }
        } else {
            args_obj.remove("wait");
        }

        if let Some(session) = args_obj.get("session_id").cloned() {
            let normalized = match session {
                Value::Number(number) => number.as_i64(),
                Value::String(text) => text.trim().parse::<i64>().ok(),
                _ => None,
            };
            if let Some(value) = normalized {
                args_obj.insert("session_id".to_string(), Value::Number(value.into()));
            }
        }
    }

    if lname == "exec_command" || lname == "shell_command" || lname == "shell" {
        if !args_obj.contains_key("cmd") {
            if let Some(command) =
                read_command_from_args_value(Some(&Value::Object(args_obj.clone())))
            {
                if !command.trim().is_empty() {
                    args_obj.insert("cmd".to_string(), Value::String(command.clone()));
                    if !args_obj.contains_key("command") {
                        args_obj.insert("command".to_string(), Value::String(command));
                    }
                }
            }
        }
    }
}

fn read_string_array_command(value: Option<&Value>) -> Option<String> {
    let rows = value?.as_array()?;
    let parts = rows
        .iter()
        .filter_map(|entry| match entry {
            Value::String(text) => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .collect::<Vec<String>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

fn parse_args_record(value: Option<&Value>) -> Option<Map<String, Value>> {
    match value {
        Some(Value::Object(row)) => Some(row.clone()),
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Some(Map::new());
            }
            parse_lenient_string(trimmed).as_object().cloned()
        }
        _ => None,
    }
}

fn read_command_text_value(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(Value::Number(number)) => Some(number.to_string()),
        Some(Value::Bool(flag)) => Some(flag.to_string()),
        Some(Value::Array(_)) => read_string_array_command(value),
        _ => None,
    }
}

fn read_command_from_args_value(value: Option<&Value>) -> Option<String> {
    if let Some(Value::String(raw)) = value {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        let looks_like_json_container = (trimmed.starts_with('{') && trimmed.ends_with('}'))
            || (trimmed.starts_with('[') && trimmed.ends_with(']'));
        let parsed = parse_lenient_string(trimmed);
        match &parsed {
            Value::Object(row) => {
                if !row.is_empty() {
                    if let Some(parsed_command) = read_command_from_args_value(Some(&parsed)) {
                        return Some(parsed_command);
                    }
                } else if looks_like_json_container {
                    return None;
                }
            }
            Value::Array(_) => {
                if let Some(array_command) = read_string_array_command(Some(&parsed)) {
                    return Some(array_command);
                }
                if looks_like_json_container {
                    return None;
                }
            }
            Value::String(parsed_text) => {
                let quoted = (trimmed.starts_with('"') && trimmed.ends_with('"'))
                    || (trimmed.starts_with('\'') && trimmed.ends_with('\''));
                if quoted {
                    let nested = parsed_text.trim();
                    if !nested.is_empty() {
                        return Some(nested.to_string());
                    }
                }
            }
            _ => {}
        }
        return read_command_text_value(value);
    }

    if let Some(direct) = read_command_text_value(value) {
        return Some(direct);
    }
    let args = parse_args_record(value).unwrap_or_default();
    if args.is_empty() {
        return None;
    }
    let input = args.get("input");
    let direct = read_command_text_value(args.get("cmd"))
        .or_else(|| read_command_text_value(args.get("command")))
        .or_else(|| read_command_text_value(args.get("script")))
        .or_else(|| read_command_text_value(args.get("toon")))
        .or_else(|| read_command_text_value(args.get("input")))
        .or_else(|| read_command_text_value(args.get("text")));
    if direct.is_some() {
        return direct;
    }
    input
        .and_then(Value::as_object)
        .and_then(|input_row| {
            read_command_text_value(input_row.get("cmd"))
                .or_else(|| read_command_text_value(input_row.get("command")))
                .or_else(|| read_command_text_value(input_row.get("script")))
                .or_else(|| read_command_text_value(input_row.get("toon")))
        })
        .or_else(|| {
            args.get("args").and_then(Value::as_object).and_then(|row| {
                read_command_text_value(row.get("cmd"))
                    .or_else(|| read_command_text_value(row.get("command")))
                    .or_else(|| read_command_text_value(row.get("script")))
                    .or_else(|| read_command_text_value(row.get("toon")))
            })
        })
}

fn read_workdir_from_args_value(value: Option<&Value>) -> Option<String> {
    let args = parse_args_record(value).unwrap_or_default();
    if args.is_empty() {
        return None;
    }
    let input = args.get("input").and_then(Value::as_object);
    read_command_text_value(args.get("workdir"))
        .or_else(|| read_command_text_value(args.get("cwd")))
        .or_else(|| read_command_text_value(args.get("workDir")))
        .or_else(|| input.and_then(|row| read_command_text_value(row.get("workdir"))))
        .or_else(|| input.and_then(|row| read_command_text_value(row.get("cwd"))))
}

fn read_write_stdin_session_id(value: Option<&Value>) -> Option<i64> {
    let args = parse_args_record(value).unwrap_or_default();
    args.get("session_id")
        .or_else(|| args.get("sessionId"))
        .and_then(|entry| match entry {
            Value::Number(number) => number.as_i64(),
            Value::String(text) => text.trim().parse::<i64>().ok(),
            _ => None,
        })
}

fn read_write_stdin_chars(value: Option<&Value>) -> Option<String> {
    let args = parse_args_record(value).unwrap_or_default();
    args.get("chars")
        .or_else(|| args.get("text"))
        .or_else(|| args.get("input"))
        .or_else(|| args.get("data"))
        .map(value_to_string)
        .filter(|text| !text.is_empty())
}

fn looks_like_apply_patch_payload(raw: &str) -> bool {
    let trimmed = raw.trim();
    !trimmed.is_empty()
        && (trimmed.contains("*** Begin Patch")
            || trimmed.contains("*** Update File:")
            || trimmed.contains("*** Add File:")
            || trimmed.contains("*** Delete File:"))
}

fn extract_apply_patch_text_value(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                return extract_apply_patch_text_value(Some(&parsed));
            }
            if looks_like_apply_patch_payload(trimmed) {
                return Some(trimmed.to_string());
            }
            None
        }
        Some(Value::Object(row)) => row
            .get("patch")
            .or_else(|| row.get("input"))
            .or_else(|| row.get("instructions"))
            .or_else(|| row.get("text"))
            .or_else(|| row.get("command"))
            .or_else(|| row.get("cmd"))
            .or_else(|| row.get("script"))
            .and_then(|entry| extract_apply_patch_text_value(Some(entry))),
        Some(Value::Array(entries)) => entries
            .iter()
            .find_map(|entry| extract_apply_patch_text_value(Some(entry))),
        _ => None,
    }
}

fn is_structured_tool_name(raw: &str) -> bool {
    let trimmed = raw.trim();
    !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-')
}

fn normalize_reasoning_harvested_arguments(
    tool_name: &str,
    args_source: &Value,
    args_text: String,
) -> Option<String> {
    let normalized_name = normalize_tool_name(tool_name);
    let lowered = normalized_name.trim().to_ascii_lowercase();
    if !is_structured_tool_name(normalized_name.as_str()) {
        return None;
    }

    if matches!(
        lowered.as_str(),
        "exec_command" | "shell_command" | "shell" | "bash" | "terminal"
    ) {
        let parsed_args = parse_lenient_string(args_text.as_str());
        let command = read_command_from_args_value(Some(args_source))
            .or_else(|| read_command_from_args_value(Some(&parsed_args)))?;
        let workdir = read_workdir_from_args_value(Some(args_source))
            .or_else(|| read_workdir_from_args_value(Some(&parsed_args)));
        let mut args_obj = Map::new();
        args_obj.insert("cmd".to_string(), Value::String(command.clone()));
        args_obj.insert("command".to_string(), Value::String(command));
        if let Some(path) = workdir {
            args_obj.insert("workdir".to_string(), Value::String(path.clone()));
            if lowered != "exec_command" {
                args_obj.insert("cwd".to_string(), Value::String(path));
            }
        }
        return serde_json::to_string(&Value::Object(args_obj)).ok();
    }

    if lowered == "write_stdin" {
        let session_id = read_write_stdin_session_id(Some(args_source)).or_else(|| {
            read_write_stdin_session_id(Some(&parse_lenient_string(args_text.as_str())))
        })?;
        let mut args_obj = Map::new();
        args_obj.insert("session_id".to_string(), Value::Number(session_id.into()));
        if let Some(chars) = read_write_stdin_chars(Some(args_source))
            .or_else(|| read_write_stdin_chars(Some(&parse_lenient_string(args_text.as_str()))))
        {
            args_obj.insert("chars".to_string(), Value::String(chars));
        }
        return serde_json::to_string(&Value::Object(args_obj)).ok();
    }

    if lowered == "apply_patch" {
        let patch = extract_apply_patch_text_value(Some(args_source)).or_else(|| {
            extract_apply_patch_text_value(Some(&parse_lenient_string(args_text.as_str())))
        })?;
        let mut args_obj = Map::new();
        args_obj.insert("input".to_string(), Value::String(patch.clone()));
        args_obj.insert("patch".to_string(), Value::String(patch));
        return serde_json::to_string(&Value::Object(args_obj)).ok();
    }

    Some(args_text)
}

fn normalize_shell_like_args_text_for_tool_name(
    tool_name: &str,
    args_source: &Value,
    args_text: String,
) -> String {
    let normalized_tool_name = normalize_tool_name(tool_name);
    if normalized_tool_name != "exec_command" && normalized_tool_name != "shell_command" {
        return args_text;
    }

    let parsed_args = parse_lenient_string(args_text.as_str());
    let mut args_obj = parse_args_record(Some(&parsed_args)).unwrap_or_default();
    let inferred_command = read_command_from_args_value(Some(args_source))
        .or_else(|| read_command_from_args_value(Some(&parsed_args)));

    if let Some(command) = inferred_command {
        if normalized_tool_name == "exec_command" {
            if !args_obj.contains_key("cmd") {
                args_obj.insert("cmd".to_string(), Value::String(command.clone()));
            }
            if !args_obj.contains_key("command") {
                args_obj.insert("command".to_string(), Value::String(command));
            }
        } else if !args_obj.contains_key("command") {
            args_obj.insert("command".to_string(), Value::String(command));
        }
    }

    serde_json::to_string(&Value::Object(args_obj)).unwrap_or(args_text)
}

fn infer_tool_name_from_args_value(value: Option<&Value>) -> Option<String> {
    let looks_like_apply_patch = match value {
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            trimmed.contains("*** Begin Patch")
                || trimmed.contains("*** Update File:")
                || trimmed.contains("*** Add File:")
                || trimmed.contains("*** Delete File:")
        }
        Some(Value::Object(row)) => row
            .get("patch")
            .or_else(|| row.get("instructions"))
            .or_else(|| row.get("input"))
            .and_then(Value::as_str)
            .map(|text| {
                let trimmed = text.trim();
                trimmed.contains("*** Begin Patch")
                    || trimmed.contains("*** Update File:")
                    || trimmed.contains("*** Add File:")
                    || trimmed.contains("*** Delete File:")
            })
            .unwrap_or(false),
        _ => false,
    };
    if looks_like_apply_patch {
        return Some("apply_patch".to_string());
    }

    if read_command_from_args_value(value).is_some() {
        return Some("exec_command".to_string());
    }

    let args = parse_args_record(value).unwrap_or_default();
    if args.is_empty() {
        return None;
    }
    let has_session_id = args.get("session_id").is_some() || args.get("sessionId").is_some();
    let has_chars = args.get("chars").is_some()
        || args.get("text").is_some()
        || args.get("data").is_some()
        || args.get("input").is_some();
    if has_session_id && has_chars {
        return Some("write_stdin".to_string());
    }

    let has_plan = args
        .get("plan")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    let has_explanation = args
        .get("explanation")
        .and_then(Value::as_str)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if has_plan || has_explanation {
        return Some("update_plan".to_string());
    }

    let has_view_path = args
        .get("path")
        .and_then(Value::as_str)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if has_view_path {
        return Some("view_image".to_string());
    }
    None
}

fn pick_tool_call_args_source<'a>(row: &'a Map<String, Value>) -> Option<&'a Value> {
    row.get("function")
        .and_then(Value::as_object)
        .and_then(|f| f.get("arguments"))
        .or_else(|| row.get("arguments"))
        .or_else(|| row.get("args"))
        .or_else(|| row.get("input"))
        .or_else(|| row.get("params"))
        .or_else(|| row.get("parameters"))
        .or_else(|| row.get("payload"))
        .or_else(|| {
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|f| f.get("args"))
        })
        .or_else(|| {
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|f| f.get("input"))
        })
        .or_else(|| {
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|f| f.get("parameters"))
        })
}

fn parse_markup_tool_call(raw: &str, name_hint: Option<&str>) -> Option<ParsedToolCall> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.contains('<') && !trimmed.contains('[') {
        return None;
    }

    let mut name = name_hint
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let id = Regex::new(r"(?is)<\s*id\s*>\s*([^<\s]+)\s*</\s*id\s*>")
        .expect("valid markup id pattern")
        .captures(trimmed)
        .and_then(|caps| caps.get(1))
        .map(|value| value.as_str().trim().to_string())
        .filter(|value| !value.is_empty());
    if name.is_none() {
        let name_tag_pattern = Regex::new(
            r"(?is)<\s*(?:function|name|tool_name|toolname|tool)\s*>\s*([A-Za-z0-9_.-]+)\s*</\s*(?:function|name|tool_name|toolname|tool)\s*>",
        )
        .expect("valid markup name tag pattern");
        if let Some(caps) = name_tag_pattern.captures(trimmed) {
            if let Some(captured) = caps.get(1) {
                let value = captured.as_str().trim();
                if !value.is_empty() {
                    name = Some(value.to_string());
                }
            }
        }
    }
    if name.is_none() {
        let line_name_pattern =
            Regex::new(r"^[A-Za-z_][A-Za-z0-9_.-]*$").expect("valid tool name line pattern");
        for line in trimmed.lines() {
            let candidate = line.trim();
            if candidate.is_empty() || candidate.starts_with('<') || candidate.starts_with('[') {
                continue;
            }
            if line_name_pattern.is_match(candidate) {
                let lowered = candidate.to_ascii_lowercase();
                if matches!(
                    lowered.as_str(),
                    "true" | "false" | "null" | "none" | "nil" | "undefined" | "n/a"
                ) {
                    continue;
                }
                name = Some(candidate.to_string());
                break;
            }
        }
    }

    let mut args_obj = Map::new();

    let arg_pair_pattern = Regex::new(
        r"(?is)<\s*arg_key\s*>\s*([^<]+?)\s*</\s*arg_key\s*>\s*<\s*arg_value\s*>\s*([\s\S]*?)\s*</\s*arg_value\s*>",
    )
    .expect("valid arg pair pattern");
    for caps in arg_pair_pattern.captures_iter(trimmed) {
        let Some(raw_key) = caps.get(1).map(|m| m.as_str()) else {
            continue;
        };
        let Some(key) = normalize_tool_arg_key(raw_key) else {
            continue;
        };
        let value =
            parse_markup_argument_value(caps.get(2).map(|m| m.as_str()).unwrap_or_default());
        if key == "toon" {
            args_obj.insert("command".to_string(), value.clone());
            args_obj.insert("cmd".to_string(), value);
            continue;
        }
        args_obj.insert(key, value);
    }

    let parameter_name_pattern = Regex::new(
        r#"(?is)<\s*parameter\s+name\s*=\s*"([^"]+)"\s*>\s*([\s\S]*?)\s*</\s*<?\s*parameter\s*>"#,
    )
    .expect("valid parameter name pattern");
    for caps in parameter_name_pattern.captures_iter(trimmed) {
        let Some(raw_key) = caps.get(1).map(|m| m.as_str()) else {
            continue;
        };
        let Some(key) = normalize_tool_arg_key(raw_key) else {
            continue;
        };
        let value =
            parse_markup_argument_value(caps.get(2).map(|m| m.as_str()).unwrap_or_default());
        args_obj.insert(key, value);
    }

    let parameter_eq_pattern =
        Regex::new(r#"(?is)<\s*parameter\s*=\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*>\s*([\s\S]*?)\s*</\s*<?\s*parameter\s*>"#)
            .expect("valid parameter equals pattern");
    for caps in parameter_eq_pattern.captures_iter(trimmed) {
        let Some(raw_key) = caps.get(1).map(|m| m.as_str()) else {
            continue;
        };
        let Some(key) = normalize_tool_arg_key(raw_key) else {
            continue;
        };
        let value =
            parse_markup_argument_value(caps.get(2).map(|m| m.as_str()).unwrap_or_default());
        args_obj.insert(key, value);
    }

    if args_obj.is_empty() {
        let parsed = parse_lenient_string(trimmed);
        if let Some(row) = parsed.as_object() {
            if !row.is_empty() {
                args_obj = row.clone();
            }
        } else if parsed.is_array() {
            args_obj.insert("arguments".to_string(), parsed);
        }
    }

    if name.is_none()
        && (args_obj.contains_key("command")
            || args_obj.contains_key("cmd")
            || args_obj.contains_key("toon"))
    {
        name = Some("exec_command".to_string());
    }

    if name.is_none() {
        name = infer_tool_name_from_args_value(Some(&Value::Object(args_obj.clone())));
    }

    if name.is_none()
        && (trimmed.contains("</command>")
            || trimmed.contains("<command>")
            || trimmed.contains("</arg_value>"))
        && (args_obj.contains_key("input")
            || args_obj.contains_key("cmd")
            || args_obj.contains_key("command")
            || args_obj.contains_key("toon"))
    {
        name = Some("exec_command".to_string());
    }

    let resolved_name = normalize_tool_name(name?.as_str());
    apply_markup_arg_aliases(resolved_name.as_str(), &mut args_obj);
    let args_source = Value::Object(args_obj);
    let args = normalize_reasoning_harvested_arguments(
        resolved_name.as_str(),
        &args_source,
        repair_arguments_to_string(&args_source),
    )?;
    Some(ParsedToolCall {
        id,
        name: resolved_name,
        args,
    })
}

fn parse_tool_call(raw: &str, name_hint: Option<&str>) -> Option<ParsedToolCall> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let parsed = parse_lenient_string(trimmed);
    if let Some(row) = parsed.as_object() {
        let empty_obj = Value::Object(Map::new());
        let args_source = pick_tool_call_args_source(row).unwrap_or(&empty_obj);
        let candidate_name = row
            .get("name")
            .or_else(|| {
                row.get("function")
                    .and_then(Value::as_object)
                    .and_then(|f| f.get("name"))
            })
            .or_else(|| row.get("tool_name"))
            .or_else(|| row.get("tool"));

        let mut name = candidate_name
            .and_then(Value::as_str)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        if name.is_none() {
            name = name_hint
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
        }
        if name.is_none() {
            name = infer_tool_name_from_args_value(Some(args_source));
        }

        if let Some(resolved_name) = name {
            let args = normalize_shell_like_args_text_for_tool_name(
                resolved_name.as_str(),
                args_source,
                repair_arguments_to_string(args_source),
            );
            let Some(args) =
                normalize_reasoning_harvested_arguments(resolved_name.as_str(), args_source, args)
            else {
                return None;
            };
            return Some(ParsedToolCall {
                id: row
                    .get("id")
                    .or_else(|| row.get("call_id"))
                    .or_else(|| row.get("tool_call_id"))
                    .and_then(Value::as_str)
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty()),
                name: normalize_tool_name(resolved_name.as_str()),
                args,
            });
        }
    }

    parse_markup_tool_call(trimmed, name_hint)
}

fn build_tool_call(parsed: &ParsedToolCall, prefix: &str, index: usize) -> Value {
    serde_json::json!({
        "id": parsed.id.clone().unwrap_or_else(|| format!("{}_{}", prefix, index + 1)),
        "type": "function",
        "function": {
            "name": parsed.name,
            "arguments": parsed.args
        }
    })
}

fn extract_balanced_json_object_at(text: &str, start_byte: usize) -> Option<(usize, String)> {
    if start_byte >= text.len() || !text[start_byte..].starts_with('{') {
        return None;
    }

    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in text[start_byte..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '{' {
            depth += 1;
            continue;
        }
        if ch == '}' {
            depth -= 1;
            if depth == 0 {
                let end_byte = start_byte + offset + ch.len_utf8();
                return Some((end_byte, text[start_byte..end_byte].to_string()));
            }
        }
    }

    None
}

fn extract_balanced_json_array_at(text: &str, start_byte: usize) -> Option<(usize, String)> {
    if start_byte >= text.len() || !text[start_byte..].starts_with('[') {
        return None;
    }

    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in text[start_byte..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '[' {
            depth += 1;
            continue;
        }
        if ch == ']' {
            depth -= 1;
            if depth == 0 {
                let end_byte = start_byte + offset + ch.len_utf8();
                return Some((end_byte, text[start_byte..end_byte].to_string()));
            }
        }
    }

    None
}

fn recover_tool_call_entry_candidates_from_malformed_tool_calls_shape(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();
    let lowered = text.to_ascii_lowercase();
    let Some(marker_index) = lowered.find("tool_calls") else {
        return out;
    };
    let tail = &text[marker_index..];
    let Some(array_rel) = tail.find('[') else {
        return out;
    };
    let array_start = marker_index + array_rel;
    let array_slice = extract_balanced_json_array_at(text, array_start)
        .map(|(_, arr)| arr)
        .unwrap_or_else(|| text[array_start..].to_string());
    let body = array_slice
        .trim()
        .strip_prefix('[')
        .unwrap_or(array_slice.trim())
        .strip_suffix(']')
        .unwrap_or(array_slice.trim())
        .to_string();
    if body.trim().is_empty() {
        return out;
    }

    let entry_start_pattern = Regex::new(
        r#"(?is)\{\s*(?:"name"|'name'|name|"function"|'function'|function|"tool"|'tool'|tool)\s*:"#,
    )
    .expect("valid malformed tool call entry start pattern");
    let starts: Vec<usize> = entry_start_pattern
        .find_iter(body.as_str())
        .map(|m| m.start())
        .collect();
    if starts.is_empty() {
        return out;
    }

    for (idx, start) in starts.iter().enumerate() {
        let end = starts.get(idx + 1).copied().unwrap_or(body.len());
        if *start >= end || end > body.len() {
            continue;
        }
        let mut chunk = body[*start..end]
            .trim()
            .trim_matches(',')
            .trim()
            .to_string();
        if chunk.is_empty() || !chunk.starts_with('{') {
            continue;
        }
        chunk = auto_close_jsonish_shape(chunk.as_str());
        if !matches!(parse_lenient_string(chunk.as_str()), Value::Object(_)) {
            continue;
        }
        if seen.insert(chunk.clone()) {
            out.push(chunk);
        }
    }

    out
}

fn collect_sentinel_tool_calls_candidates(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();
    let mut push = |raw: &str| {
        let candidate = raw.trim().to_string();
        if candidate.is_empty() || !seen.insert(candidate.clone()) {
            return;
        }
        out.push(candidate);
    };

    let xml_tag_pattern = Regex::new(
        r"(?is)<\s*rcc_tool_calls(?:_json)?\s*>\s*([\s\S]*?)\s*<\s*/\s*rcc_tool_calls(?:_json)?\s*>",
    )
    .expect("valid rcc tool calls xml-like tag pattern");
    for caps in xml_tag_pattern.captures_iter(text) {
        if let Some(inner) = caps.get(1) {
            push(inner.as_str());
        }
    }

    let heredoc_json_pattern =
        Regex::new(r"(?ims)^\s*<<\s*RCC_TOOL_CALLS_JSON\s*$([\s\S]*?)^\s*RCC_TOOL_CALLS_JSON\s*$")
            .expect("valid rcc tool calls heredoc json pattern");
    for caps in heredoc_json_pattern.captures_iter(text) {
        if let Some(inner) = caps.get(1) {
            push(inner.as_str());
        }
    }

    let heredoc_pattern =
        Regex::new(r"(?ims)^\s*<<\s*RCC_TOOL_CALLS\s*$([\s\S]*?)^\s*RCC_TOOL_CALLS\s*$")
            .expect("valid rcc tool calls heredoc pattern");
    for caps in heredoc_pattern.captures_iter(text) {
        if let Some(inner) = caps.get(1) {
            push(inner.as_str());
        }
    }

    out
}

fn collect_explicit_tool_calls_json_candidates(text: &str) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();
    let mut push_candidate = |raw: &str| {
        let candidate = raw.trim().to_string();
        if candidate.is_empty() || seen.contains(&candidate) {
            return;
        }
        seen.insert(candidate.clone());
        candidates.push(candidate);
    };

    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        push_candidate(trimmed);
    }

    let quote_pattern =
        Regex::new(r"(?is)<quote>\s*([\s\S]*?)\s*</quote>").expect("valid explicit quote pattern");
    for caps in quote_pattern.captures_iter(text) {
        if let Some(inner) = caps.get(1) {
            push_candidate(inner.as_str());
        }
    }

    for candidate in collect_sentinel_tool_calls_candidates(text) {
        push_candidate(candidate.as_str());
    }

    let fence_pattern = Regex::new(
        r"(?is)```\s*(?:json|tool_call|tool_calls|function_call)\s*\r?\n([\s\S]*?)\s*```",
    )
    .expect("valid explicit json fence pattern");
    for caps in fence_pattern.captures_iter(text) {
        if let Some(body) = caps.get(1) {
            push_candidate(body.as_str());
        }
    }

    for (index, ch) in text.char_indices() {
        if ch != '{' {
            continue;
        }
        let Some((_end, candidate)) = extract_balanced_json_object_at(text, index) else {
            continue;
        };
        if candidate.contains("\"tool_calls\"") || candidate.contains("'tool_calls'") {
            push_candidate(candidate.as_str());
        }
    }

    candidates
}

fn is_jsonish_value_boundary(next: Option<char>) -> bool {
    matches!(
        next,
        None | Some(',') | Some('}') | Some(']') | Some(':') | Some('\n') | Some('\r')
    )
}

fn build_tool_calls_shape_candidate(text: &str) -> Option<String> {
    if !text.to_ascii_lowercase().contains("tool_calls") {
        return None;
    }
    let trimmed = text.trim();
    let marker_re =
        Regex::new(r#"(?is)(?:"tool_calls"|'tool_calls'|\btool_calls\b)"#).expect("valid marker");
    let marker = marker_re.find(trimmed)?;
    let start = trimmed[..marker.start()]
        .rfind('{')
        .or_else(|| trimmed.find('{'))
        .unwrap_or(marker.start());
    let mut candidate = trimmed[start..].trim().to_string();
    if !candidate.starts_with('{') {
        let after_marker = &trimmed[marker.end()..];
        if let Some(rel_open) = after_marker.find('[') {
            candidate = format!("{{\"tool_calls\":{}}}", &after_marker[rel_open..]);
        } else {
            candidate = format!("{{\"tool_calls\":[{}]}}", after_marker.trim());
        }
    }
    if candidate.is_empty() {
        None
    } else {
        Some(candidate)
    }
}

fn auto_close_jsonish_shape(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len() + 16);
    let mut in_string = false;
    let mut escaped = false;
    let mut closers: Vec<char> = Vec::new();
    let mut idx = 0usize;

    while idx < chars.len() {
        let ch = chars[idx];
        if in_string {
            if escaped {
                escaped = false;
                out.push(ch);
                idx += 1;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                out.push(ch);
                idx += 1;
                continue;
            }
            if ch == '"' {
                let mut lookahead = idx + 1;
                while lookahead < chars.len() && chars[lookahead].is_whitespace() {
                    lookahead += 1;
                }
                let next = chars.get(lookahead).copied();
                if is_jsonish_value_boundary(next) {
                    in_string = false;
                    out.push(ch);
                } else {
                    out.push('\\');
                    out.push(ch);
                }
                idx += 1;
                continue;
            }
            if ch == '\n' {
                out.push_str("\\n");
                idx += 1;
                continue;
            }
            if ch == '\r' {
                out.push_str("\\r");
                idx += 1;
                continue;
            }
            out.push(ch);
            idx += 1;
            continue;
        }

        match ch {
            '"' => {
                in_string = true;
                out.push(ch);
            }
            '{' => {
                closers.push('}');
                out.push(ch);
            }
            '[' => {
                closers.push(']');
                out.push(ch);
            }
            '}' | ']' => {
                if let Some(expected) = closers.last().copied() {
                    if expected == ch {
                        closers.pop();
                    }
                }
                out.push(ch);
            }
            _ => out.push(ch),
        }
        idx += 1;
    }

    if in_string {
        out.push('"');
    }
    while let Some(close) = closers.pop() {
        out.push(close);
    }
    out
}

fn parse_tool_calls_shape_from_text(text: &str) -> Option<Value> {
    let candidate = build_tool_calls_shape_candidate(text)?;
    let repaired = auto_close_jsonish_shape(candidate.as_str());
    let parsed = parse_lenient_string(repaired.as_str());
    if matches!(parsed, Value::Null) {
        None
    } else {
        Some(parsed)
    }
}

fn parse_explicit_json_tool_calls(text: &str, id_prefix: &str) -> Vec<Value> {
    let mut tool_calls = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();

    for candidate in collect_explicit_tool_calls_json_candidates(text) {
        let parsed_initial = serde_json::from_str::<Value>(candidate.as_str())
            .unwrap_or_else(|_| parse_lenient_string(candidate.as_str()));
        let parsed = match &parsed_initial {
            Value::Object(row) if row.is_empty() => {
                parse_tool_calls_shape_from_text(candidate.as_str()).unwrap_or(parsed_initial)
            }
            _ => parsed_initial,
        };

        let entries = match parsed {
            Value::Object(ref row) => {
                if let Some(items) = row.get("tool_calls").and_then(Value::as_array) {
                    Some(items.clone())
                } else {
                    let has_name = row.get("name").is_some()
                        || row
                            .get("function")
                            .and_then(Value::as_object)
                            .and_then(|function| function.get("name"))
                            .is_some()
                        || row.get("tool_name").is_some()
                        || row.get("tool").is_some();
                    let has_arguments = row.get("arguments").is_some()
                        || row.get("input").is_some()
                        || row.get("params").is_some()
                        || row.get("parameters").is_some()
                        || row.get("payload").is_some()
                        || row
                            .get("function")
                            .and_then(Value::as_object)
                            .and_then(|function| {
                                function
                                    .get("arguments")
                                    .or_else(|| function.get("input"))
                                    .or_else(|| function.get("parameters"))
                            })
                            .is_some();
                    let has_tool_type = row
                        .get("type")
                        .and_then(Value::as_str)
                        .map(|value| {
                            let lowered = value.trim().to_ascii_lowercase();
                            lowered == "function" || lowered == "function_call"
                        })
                        .unwrap_or(false);
                    if has_name && (has_arguments || has_tool_type) {
                        Some(vec![Value::Object(row.clone())])
                    } else {
                        None
                    }
                }
            }
            Value::Array(ref items) => Some(items.clone()),
            _ => None,
        };

        let Some(entries) = entries else {
            continue;
        };

        for (index, entry) in entries.iter().enumerate() {
            let Value::Object(row) = entry else {
                continue;
            };
            let has_name = row.get("name").is_some()
                || row
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("name"))
                    .is_some()
                || row.get("tool_name").is_some()
                || row.get("tool").is_some();
            let has_arguments = row.get("arguments").is_some()
                || row.get("input").is_some()
                || row.get("params").is_some()
                || row.get("parameters").is_some()
                || row.get("payload").is_some()
                || row
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| {
                        function
                            .get("arguments")
                            .or_else(|| function.get("input"))
                            .or_else(|| function.get("parameters"))
                    })
                    .is_some();
            if !(has_name && has_arguments) {
                continue;
            }
            let Ok(raw_entry) = serde_json::to_string(entry) else {
                continue;
            };
            let Some(parsed_call) = parse_tool_call(raw_entry.as_str(), None) else {
                continue;
            };
            let key = format!("{}::{}", parsed_call.name, parsed_call.args);
            if !seen.insert(key) {
                continue;
            }
            tool_calls.push(build_tool_call(&parsed_call, id_prefix, index));
        }

        if !tool_calls.is_empty() {
            break;
        }
    }

    if tool_calls.is_empty() {
        if let Some(repaired) = parse_tool_calls_shape_from_text(text) {
            let recovered = match repaired {
                Value::Object(ref row) => row
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                Value::Array(ref rows) => rows.clone(),
                _ => Vec::new(),
            };
            for (index, entry) in recovered.iter().enumerate() {
                let Value::Object(row) = entry else {
                    continue;
                };
                let has_name = row.get("name").is_some()
                    || row
                        .get("function")
                        .and_then(Value::as_object)
                        .and_then(|function| function.get("name"))
                        .is_some()
                    || row.get("tool_name").is_some()
                    || row.get("tool").is_some();
                if !has_name {
                    continue;
                }
                let Ok(raw_entry) = serde_json::to_string(entry) else {
                    continue;
                };
                let Some(parsed_call) = parse_tool_call(raw_entry.as_str(), None) else {
                    continue;
                };
                let key = format!("{}::{}", parsed_call.name, parsed_call.args);
                if !seen.insert(key) {
                    continue;
                }
                tool_calls.push(build_tool_call(&parsed_call, id_prefix, index));
            }
        }
    }

    if tool_calls.is_empty() {
        for (index, candidate) in
            recover_tool_call_entry_candidates_from_malformed_tool_calls_shape(text)
                .iter()
                .enumerate()
        {
            let Some(parsed_call) = parse_tool_call(candidate.as_str(), None) else {
                continue;
            };
            let key = format!("{}::{}", parsed_call.name, parsed_call.args);
            if !seen.insert(key) {
                continue;
            }
            tool_calls.push(build_tool_call(&parsed_call, id_prefix, index));
        }
    }

    tool_calls
}

fn consume_pattern(
    source: &str,
    pattern: &Regex,
    get_payload: impl Fn(&regex::Captures) -> Option<(String, Option<String>)>,
    matches: &mut Vec<MatchEntry>,
) {
    for caps in pattern.captures_iter(source) {
        let Some(whole) = caps.get(0) else {
            continue;
        };
        let Some((body, hint)) = get_payload(&caps) else {
            continue;
        };
        let parsed = parse_tool_call(body.as_str(), hint.as_deref());
        let Some(call) = parsed else {
            continue;
        };
        matches.push(MatchEntry {
            start: whole.start(),
            end: whole.end(),
            call,
        });
    }
}

fn looks_like_markup_tool_call_payload(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    if lowered.is_empty() {
        return false;
    }
    let has_markup = lowered.contains("<parameter")
        || lowered.contains("<arg_key")
        || lowered.contains("<arg_value")
        || lowered.contains("</arg_value>")
        || lowered.contains("</command>")
        || lowered.contains("<tool_call")
        || lowered.contains("<function_call")
        || lowered.contains("<function=");
    if !has_markup {
        return false;
    }
    lowered.contains("</arg_value>")
        || lowered.contains("</command>")
        || lowered.contains("</tool_call>")
        || lowered.contains("</function_call>")
        || lowered.contains("</function>")
        || lowered.contains("</parameter>")
        || lowered.contains("</</parameter>")
}

fn strip_trailing_orphan_tool_markup_suffix(text: &str) -> String {
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return String::new();
    }
    let orphan_suffix_pattern = Regex::new(
        r"(?is)(?:\s*</\s*<?\s*(?:parameter|arg_value|tool_call|function_call|command)\s*>\s*)+$",
    )
    .expect("valid orphan suffix pattern");
    orphan_suffix_pattern
        .replace(trimmed, "")
        .trim_end()
        .to_string()
}

fn find_markup_tail_start(text: &str) -> Option<usize> {
    let lowered = text.to_ascii_lowercase();
    let markers = [
        "<tool_call",
        "[tool_call",
        "<function_call",
        "[function_call",
        "<function=",
        "<invoke",
        "<tool:",
        "<parameter",
        "<arg_key",
        "<arg_value",
    ];
    markers
        .iter()
        .filter_map(|marker| lowered.find(marker))
        .min()
}

fn extract_tool_calls_from_reasoning_text(text: &str, id_prefix: &str) -> (String, Vec<Value>) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return (text.to_string(), Vec::new());
    }

    let mut matches: Vec<MatchEntry> = Vec::new();

    let fence_pattern = Regex::new(
        r"(?is)```\s*(?:tool_call|tool_calls|function_call|json)\s*\r?\n([\s\S]*?)\s*```",
    )
    .expect("valid fence pattern");
    consume_pattern(
        text,
        &fence_pattern,
        |caps| {
            let body = caps.get(1).map(|m| m.as_str().to_string())?;
            Some((body, None))
        },
        &mut matches,
    );

    let tag_tool_pattern =
        Regex::new(r#"(?is)<tool_call(?:\s+name=\"([^\"]+)\")?\s*>([\s\S]*?)</tool_call>"#)
            .expect("valid tool tag pattern");
    consume_pattern(
        text,
        &tag_tool_pattern,
        |caps| {
            let body = caps.get(2).map(|m| m.as_str().to_string())?;
            let hint = caps.get(1).map(|m| m.as_str().to_string());
            Some((body, hint))
        },
        &mut matches,
    );

    let tag_function_pattern =
        Regex::new(r#"(?is)<function_call(?:\s+name=\"([^\"]+)\")?\s*>([\s\S]*?)</function_call>"#)
            .expect("valid function tag pattern");
    consume_pattern(
        text,
        &tag_function_pattern,
        |caps| {
            let body = caps.get(2).map(|m| m.as_str().to_string())?;
            let hint = caps.get(1).map(|m| m.as_str().to_string());
            Some((body, hint))
        },
        &mut matches,
    );

    let function_equals_pattern =
        Regex::new(r#"(?is)<function=([A-Za-z0-9_.-]+)\s*>([\s\S]*?)</function>"#)
            .expect("valid function equals pattern");
    consume_pattern(
        text,
        &function_equals_pattern,
        |caps| {
            let body = caps.get(2).map(|m| m.as_str().to_string())?;
            let hint = caps.get(1).map(|m| m.as_str().to_string());
            Some((body, hint))
        },
        &mut matches,
    );

    let invoke_pattern =
        Regex::new(r#"(?is)<invoke(?:\s+name=\"([^\"]+)\")?\s*>([\s\S]*?)</invoke>"#)
            .expect("valid invoke pattern");
    consume_pattern(
        text,
        &invoke_pattern,
        |caps| {
            let body = caps.get(2).map(|m| m.as_str().to_string())?;
            let hint = caps.get(1).map(|m| m.as_str().to_string());
            Some((body, hint))
        },
        &mut matches,
    );

    let tool_namespace_pattern =
        Regex::new(r#"(?is)<tool:([A-Za-z0-9_.-]+)\s*>([\s\S]*?)</tool:[A-Za-z0-9_.-]+\s*>"#)
            .expect("valid tool namespace pattern");
    consume_pattern(
        text,
        &tool_namespace_pattern,
        |caps| {
            let body = caps.get(2).map(|m| m.as_str().to_string())?;
            let hint = caps.get(1).map(|m| m.as_str().to_string());
            Some((body, hint))
        },
        &mut matches,
    );

    let bracket_tool_pattern =
        Regex::new(r#"(?is)\[tool_call(?:\s+name=\"([^\"]+)\")?\]([\s\S]*?)\[/tool_call\]"#)
            .expect("valid tool bracket pattern");
    consume_pattern(
        text,
        &bracket_tool_pattern,
        |caps| {
            let body = caps.get(2).map(|m| m.as_str().to_string())?;
            let hint = caps.get(1).map(|m| m.as_str().to_string());
            Some((body, hint))
        },
        &mut matches,
    );

    let bracket_function_pattern = Regex::new(
        r#"(?is)\[function_call(?:\s+name=\"([^\"]+)\")?\]([\s\S]*?)\[/function_call\]"#,
    )
    .expect("valid function bracket pattern");
    consume_pattern(
        text,
        &bracket_function_pattern,
        |caps| {
            let body = caps.get(2).map(|m| m.as_str().to_string())?;
            let hint = caps.get(1).map(|m| m.as_str().to_string());
            Some((body, hint))
        },
        &mut matches,
    );

    let label_pattern = Regex::new(r"(?is)(tool_call|function_call)\s*[:=]\s*(\{[\s\S]+?\})")
        .expect("valid label pattern");
    consume_pattern(
        text,
        &label_pattern,
        |caps| {
            let body = caps.get(2).map(|m| m.as_str().to_string())?;
            Some((body, None))
        },
        &mut matches,
    );

    if matches.is_empty() {
        let explicit_json_tool_calls = parse_explicit_json_tool_calls(text, id_prefix);
        if !explicit_json_tool_calls.is_empty() {
            return (String::new(), explicit_json_tool_calls);
        }
        if looks_like_markup_tool_call_payload(text) {
            if let Some(parsed_call) = parse_tool_call(text, None) {
                return (
                    String::new(),
                    vec![build_tool_call(&parsed_call, id_prefix, 0)],
                );
            }
            if let Some(start) = find_markup_tail_start(text) {
                let candidate = text[start..].trim();
                if !candidate.is_empty() && looks_like_markup_tool_call_payload(candidate) {
                    if let Some(parsed_call) = parse_tool_call(candidate, None) {
                        return (
                            text[..start].trim().to_string(),
                            vec![build_tool_call(&parsed_call, id_prefix, 0)],
                        );
                    }
                }
            }
            let stripped = strip_trailing_orphan_tool_markup_suffix(text);
            if stripped.len() < text.trim_end().len() {
                return (stripped, Vec::new());
            }
        }
        return (text.to_string(), Vec::new());
    }

    let tool_calls = matches
        .iter()
        .enumerate()
        .map(|(index, entry)| build_tool_call(&entry.call, id_prefix, index))
        .collect::<Vec<Value>>();

    matches.sort_by(|a, b| b.start.cmp(&a.start));
    let mut cleaned = text.to_string();
    for entry in matches {
        if entry.start <= entry.end && entry.end <= cleaned.len() {
            cleaned.replace_range(entry.start..entry.end, "");
        }
    }

    (cleaned.trim().to_string(), tool_calls)
}

fn derive_tool_call_key(call: &Value) -> Option<String> {
    let row = call.as_object()?;
    let function = row.get("function")?.as_object()?;
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    let args_raw = function.get("arguments");
    let args = match args_raw {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
        None => String::new(),
    };

    if name.is_empty() && args.is_empty() {
        return None;
    }
    Some(format!("{}::{}", name, args))
}

fn merge_tool_calls(existing: Option<&Vec<Value>>, additions: &[Value]) -> Vec<Value> {
    let mut base = existing.cloned().unwrap_or_default();
    if additions.is_empty() {
        return base;
    }

    let mut seen = std::collections::HashSet::<String>::new();
    for call in &base {
        if let Some(key) = derive_tool_call_key(call) {
            seen.insert(key);
        }
    }

    for call in additions {
        let key = derive_tool_call_key(call);
        if let Some(ref k) = key {
            if seen.contains(k) {
                continue;
            }
        }
        base.push(call.clone());
        if let Some(k) = key {
            seen.insert(k);
        }
    }

    base
}

fn normalize_tool_calls_in_message(message_obj: &mut Map<String, Value>) -> bool {
    let Some(Value::Array(tool_calls)) = message_obj.get_mut("tool_calls") else {
        return false;
    };
    if tool_calls.is_empty() {
        return false;
    }

    for call in tool_calls.iter_mut() {
        let Some(call_obj) = call.as_object_mut() else {
            continue;
        };
        let Some(func_val) = call_obj.get_mut("function") else {
            continue;
        };
        let Some(func_obj) = func_val.as_object_mut() else {
            continue;
        };
        let args_source = func_obj.get("arguments").cloned().unwrap_or(Value::Null);
        let repaired = repair_arguments_to_string(&args_source);
        func_obj.insert("arguments".to_string(), Value::String(repaired));
    }

    true
}

fn collect_message_content_text_candidates(message_obj: &Map<String, Value>) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    let Some(content) = message_obj.get("content") else {
        return candidates;
    };

    match content {
        Value::String(text) => {
            if !text.trim().is_empty() {
                candidates.push(text.clone());
            }
        }
        Value::Array(parts) => {
            for part in parts {
                let Some(part_obj) = part.as_object() else {
                    continue;
                };
                if let Some(text) = part_obj
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                {
                    candidates.push(text);
                    continue;
                }
                if let Some(text) = part_obj
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                {
                    candidates.push(text);
                }
            }
        }
        _ => {}
    }

    candidates
}

fn harvest_tool_calls_from_message_content(
    message_obj: &mut Map<String, Value>,
    id_prefix: &str,
) -> usize {
    let candidates = collect_message_content_text_candidates(message_obj);
    if candidates.is_empty() {
        return 0;
    }

    for candidate in candidates {
        let parsed_calls = parse_explicit_json_tool_calls(candidate.as_str(), id_prefix);
        if parsed_calls.is_empty() {
            continue;
        }
        let current_calls = message_obj.get("tool_calls").and_then(Value::as_array);
        let merged = merge_tool_calls(current_calls, &parsed_calls);
        let before = current_calls.map(|arr| arr.len()).unwrap_or(0);
        let added = merged.len().saturating_sub(before);
        message_obj.insert("tool_calls".to_string(), Value::Array(merged));
        message_obj.insert("content".to_string(), Value::String(String::new()));
        return added;
    }

    0
}

pub(crate) fn normalize_message_reasoning_tools_record(
    message_obj: &mut Map<String, Value>,
    id_prefix: &str,
) -> (usize, Option<String>) {
    let fragments = collect_reasoning_fragments(message_obj);
    if fragments.is_empty() {
        let added_from_content = harvest_tool_calls_from_message_content(message_obj, id_prefix);
        if added_from_content > 0 {
            return (added_from_content, None);
        }
        normalize_message_reasoning_ssot(message_obj);
        return (0, None);
    }

    let combined = fragments.join("\n").trim().to_string();
    if combined.is_empty() {
        write_reasoning_content(message_obj, "");
        return (0, None);
    }

    let sanitized = strip_reasoning_tags(combined.as_str());
    if sanitized.is_empty() {
        write_reasoning_content(message_obj, "");
        return (0, None);
    }

    let (cleaned_text, tool_calls) =
        extract_tool_calls_from_reasoning_text(sanitized.as_str(), id_prefix);
    let trimmed = cleaned_text.trim().to_string();
    write_reasoning_content(message_obj, trimmed.as_str());

    let raw_content = message_obj
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let prefix = id_prefix.trim().to_ascii_lowercase();
    let allow_reasoning_tag_lift = !prefix.starts_with("responses_response_output");
    if raw_content.is_empty() && !trimmed.is_empty() && allow_reasoning_tag_lift {
        let has_thinking_tags = trimmed.contains("[思考]") && trimmed.contains("[/思考]");
        let next_content = if has_thinking_tags {
            trimmed.clone()
        } else {
            format!("[思考]\n{}\n[/思考]", trimmed)
        };
        message_obj.insert("content".to_string(), Value::String(next_content));
    }

    if tool_calls.is_empty() {
        let added_from_content = harvest_tool_calls_from_message_content(message_obj, id_prefix);
        if added_from_content > 0 {
            return (added_from_content, Some(trimmed));
        }
        return (0, Some(trimmed));
    }

    let current_calls = message_obj.get("tool_calls").and_then(Value::as_array);
    let merged = merge_tool_calls(current_calls, &tool_calls);
    let before = current_calls.map(|arr| arr.len()).unwrap_or(0);
    let added = merged.len().saturating_sub(before);
    message_obj.insert("tool_calls".to_string(), Value::Array(merged));

    (added, Some(trimmed))
}

#[napi]
pub fn normalize_message_reasoning_tools_json(
    message_json: String,
    id_prefix: Option<String>,
) -> NapiResult<String> {
    let mut message: Value = serde_json::from_str(&message_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse message JSON: {}", e)))?;

    let prefix = id_prefix
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "reasoning".to_string());

    let (tool_calls_added, cleaned_reasoning) = match message.as_object_mut() {
        Some(row) => normalize_message_reasoning_tools_record(row, prefix.as_str()),
        None => (0, None),
    };

    let output = NormalizeMessageReasoningToolsOutput {
        message,
        tool_calls_added,
        cleaned_reasoning,
    };
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn normalize_chat_response_reasoning_tools_json(
    response_json: String,
    id_prefix_base: Option<String>,
) -> NapiResult<String> {
    let mut response: Value = serde_json::from_str(&response_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse response JSON: {}", e)))?;

    let prefix_base = id_prefix_base
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "reasoning_choice".to_string());

    if let Some(response_obj) = response.as_object_mut() {
        if let Some(choices) = response_obj
            .get_mut("choices")
            .and_then(Value::as_array_mut)
        {
            for (idx, choice) in choices.iter_mut().enumerate() {
                let Some(choice_obj) = choice.as_object_mut() else {
                    continue;
                };
                let mut has_tool_calls = false;
                {
                    let Some(message) = choice_obj.get_mut("message") else {
                        continue;
                    };
                    let Some(message_obj) = message.as_object_mut() else {
                        continue;
                    };
                    let prefix = format!("{}_{}", prefix_base, idx + 1);
                    normalize_message_reasoning_tools_record(message_obj, prefix.as_str());
                    if normalize_tool_calls_in_message(message_obj) {
                        message_obj.insert("content".to_string(), Value::Null);
                        has_tool_calls = true;
                    }
                }
                if has_tool_calls {
                    choice_obj.insert(
                        "finish_reason".to_string(),
                        Value::String("tool_calls".to_string()),
                    );
                }
            }
        }
    }

    serde_json::to_string(&response)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn parse_lenient_jsonish_json(value_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&value_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = match value {
        Value::Null => Value::Object(Map::new()),
        Value::Object(_) | Value::Array(_) => value,
        Value::String(ref text) => parse_lenient_string(text),
        other => serde_json::json!({ "_raw": other.to_string() }),
    };
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn repair_arguments_to_string_jsonish_json(value_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&value_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    Ok(repair_arguments_to_string(&value))
}

#[napi]
pub fn extract_tool_calls_from_reasoning_text_json(
    text: String,
    id_prefix: Option<String>,
) -> NapiResult<String> {
    let prefix = id_prefix
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "reasoning".to_string());
    let (cleaned_text, tool_calls) =
        extract_tool_calls_from_reasoning_text(text.as_str(), prefix.as_str());
    let output = ExtractToolCallsFromReasoningTextOutput {
        cleaned_text,
        tool_calls,
    };
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn normalize_assistant_text_to_tool_calls_json(
    message_json: String,
    _options_json: Option<String>,
) -> NapiResult<String> {
    let mut message: Value = serde_json::from_str(&message_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse message JSON: {}", e)))?;
    if !message.is_object() {
        return serde_json::to_string(&message)
            .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)));
    }

    let has_tool_calls = message
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .map(|arr| !arr.is_empty())
        .unwrap_or(false);
    if has_tool_calls {
        return serde_json::to_string(&message)
            .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)));
    }

    let mut candidates: Vec<String> = Vec::new();
    if let Some(content) = message.get("content") {
        match content {
            Value::String(s) => {
                if !s.trim().is_empty() {
                    candidates.push(s.clone());
                }
            }
            Value::Array(arr) => {
                for part in arr {
                    if let Value::Object(obj) = part {
                        if let Some(Value::String(s)) = obj.get("text") {
                            if !s.trim().is_empty() {
                                candidates.push(s.clone());
                                continue;
                            }
                        }
                        if let Some(Value::String(s)) = obj.get("content") {
                            if !s.trim().is_empty() {
                                candidates.push(s.clone());
                                continue;
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(Value::String(s)) = message.get("reasoning") {
        if !s.trim().is_empty() {
            candidates.push(s.clone());
        }
    }
    if let Some(Value::String(s)) = message.get("thinking") {
        if !s.trim().is_empty() {
            candidates.push(s.clone());
        }
    }
    if let Some(Value::String(s)) = message.get("reasoning_content") {
        if !s.trim().is_empty() {
            candidates.push(s.clone());
        }
    }
    if candidates.is_empty() {
        return serde_json::to_string(&message)
            .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)));
    }

    let mut mapped_calls: Vec<Value> = Vec::new();
    let mut candidate_ids: Vec<String> = Vec::new();
    for (idx, text) in candidates.iter().enumerate() {
        if candidate_ids.is_empty() {
            if let Ok(re) = Regex::new(r"(?s)<tool_call>\s*([\s\S]*?)\s*</tool_call>") {
                for caps in re.captures_iter(text.as_str()) {
                    if let Some(body) = caps.get(1) {
                        if let Ok(id_re) = Regex::new(r"<id>\s*([^<\s]+)\s*</id>") {
                            if let Some(id_caps) = id_re.captures(body.as_str()) {
                                if let Some(id_match) = id_caps.get(1) {
                                    let id = id_match.as_str().trim().to_string();
                                    if !id.is_empty() {
                                        candidate_ids.push(id);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        let (_cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(text.as_str(), "reasoning");
        if tool_calls.is_empty() {
            continue;
        }
        for (entry_idx, entry) in tool_calls.iter().enumerate() {
            if let Value::Object(obj) = entry {
                let function_node = obj.get("function").and_then(|v| v.as_object());
                let name = function_node
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        obj.get("name")
                            .and_then(|v| v.as_str())
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                    });
                if name.is_none() {
                    continue;
                }
                let args_candidate = function_node
                    .and_then(|f| f.get("arguments"))
                    .or_else(|| obj.get("arguments"))
                    .or_else(|| obj.get("args"))
                    .cloned()
                    .unwrap_or(Value::String("{}".to_string()));
                let args = match args_candidate {
                    Value::String(s) => s,
                    other => serde_json::to_string(&other).unwrap_or_else(|_| "{}".to_string()),
                };
                let id = obj
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        obj.get("call_id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                    })
                    .unwrap_or_else(|| format!("call_{}", idx + entry_idx + 1));

                let mut fn_obj = Map::new();
                fn_obj.insert("name".to_string(), Value::String(name.unwrap()));
                fn_obj.insert("arguments".to_string(), Value::String(args));
                let mut call_obj = Map::new();
                call_obj.insert("id".to_string(), Value::String(id));
                call_obj.insert("type".to_string(), Value::String("function".to_string()));
                call_obj.insert("function".to_string(), Value::Object(fn_obj));
                mapped_calls.push(Value::Object(call_obj));
            }
        }
        if !mapped_calls.is_empty() {
            break;
        }
    }

    if !mapped_calls.is_empty() && !candidate_ids.is_empty() {
        for (idx, call) in mapped_calls.iter_mut().enumerate() {
            if let Value::Object(obj) = call {
                if let Some(id) = candidate_ids.get(idx) {
                    obj.insert("id".to_string(), Value::String(id.clone()));
                }
            }
        }
    }

    if mapped_calls.is_empty() {
        return serde_json::to_string(&message)
            .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)));
    }

    if let Value::Object(obj) = &mut message {
        obj.insert("tool_calls".to_string(), Value::Array(mapped_calls));
        obj.insert("content".to_string(), Value::String("".to_string()));
    }

    serde_json::to_string(&message)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn sanitize_reasoning_tagged_text_json(text: String) -> NapiResult<String> {
    Ok(sanitize_reasoning_tagged_text(text.as_str()))
}

#[napi]
pub fn derive_tool_call_key_json(call_json: String) -> NapiResult<String> {
    let call: Value = serde_json::from_str(&call_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse call JSON: {}", e)))?;
    let output = derive_tool_call_key(&call)
        .map(Value::String)
        .unwrap_or(Value::Null);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn merge_tool_calls_json(existing_json: String, additions_json: String) -> NapiResult<String> {
    let existing: Value = serde_json::from_str(&existing_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse existing JSON: {}", e)))?;
    let additions: Value = serde_json::from_str(&additions_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse additions JSON: {}", e)))?;

    let existing_array = existing.as_array().cloned();
    let additions_array = additions.as_array().cloned().unwrap_or_default();
    let merged = merge_tool_calls(existing_array.as_ref(), additions_array.as_slice());
    serde_json::to_string(&Value::Array(merged))
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn map_reasoning_content_to_responses_output_json(
    reasoning_content_json: String,
) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&reasoning_content_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse reasoning content JSON: {}", e))
    })?;
    let output = map_reasoning_content_to_responses_output(&value);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn is_image_path_json(path_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&path_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse path JSON: {}", e)))?;
    let path = value.as_str().unwrap_or("");
    serde_json::to_string(&Value::Bool(is_image_path(path)))
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn normalize_function_call_id_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let row = input.as_object().cloned().unwrap_or_default();
    let output = normalize_with_fallback(
        row.get("callId").and_then(Value::as_str),
        row.get("fallback").and_then(Value::as_str),
        "fc_",
    );
    Ok(output)
}

#[napi]
pub fn normalize_function_call_output_id_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let row = input.as_object().cloned().unwrap_or_default();
    let output = normalize_with_fallback(
        row.get("callId").and_then(Value::as_str),
        row.get("fallback").and_then(Value::as_str),
        "fc_",
    );
    Ok(output)
}

#[napi]
pub fn normalize_responses_call_id_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let row = input.as_object().cloned().unwrap_or_default();
    let output = normalize_with_fallback(
        row.get("callId").and_then(Value::as_str),
        row.get("fallback").and_then(Value::as_str),
        "call_",
    );
    Ok(output)
}

#[napi]
pub fn clamp_responses_input_item_id_json(raw_json: String) -> NapiResult<String> {
    let raw: Value = serde_json::from_str(&raw_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = clamp_responses_input_item_id(raw.as_str())
        .map(Value::String)
        .unwrap_or(Value::Null);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_message_extracts_reasoning_and_tool_calls() {
        let mut message = json!({
            "role": "assistant",
            "reasoning_content": "<think>{\"name\":\"exec_command\",\"arguments\":{\"command\":\"pwd\"}}</think>",
            "content": ""
        });
        let row = message.as_object_mut().unwrap();
        let (added, cleaned) = normalize_message_reasoning_tools_record(row, "reasoning_test");
        assert_eq!(added, 1);
        assert_eq!(cleaned.unwrap_or_default(), "");
        let tool_calls = row
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
    }

    #[test]
    fn normalize_message_lifts_reasoning_to_content() {
        let mut message = json!({
            "role": "assistant",
            "reasoning_content": "analysis",
            "content": ""
        });
        let row = message.as_object_mut().unwrap();
        let (_added, cleaned) = normalize_message_reasoning_tools_record(row, "reasoning_test");
        assert_eq!(cleaned.unwrap_or_default(), "analysis");
        assert_eq!(
            row.get("content").and_then(Value::as_str),
            Some("[思考]\nanalysis\n[/思考]")
        );
        assert_eq!(
            row["reasoning"]["content"][0]["text"],
            Value::String("analysis".to_string())
        );
    }

    #[test]
    fn normalize_message_skips_reasoning_lift_for_responses_output() {
        let mut message = json!({
            "role": "assistant",
            "reasoning_content": "analysis",
            "content": ""
        });
        let row = message.as_object_mut().unwrap();
        let (_added, cleaned) =
            normalize_message_reasoning_tools_record(row, "responses_response_output");
        assert_eq!(cleaned.unwrap_or_default(), "analysis");
        assert_eq!(row.get("content").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn normalize_message_reasoning_ssot_promotes_structured_reasoning() {
        let mut message = json!({
            "reasoning_content": "Need cwd"
        });
        let row = message.as_object_mut().unwrap();

        normalize_message_reasoning_ssot(row);

        assert_eq!(
            row["reasoning"]["content"][0]["type"],
            Value::String("reasoning_text".to_string())
        );
        assert_eq!(
            row["reasoning"]["content"][0]["text"],
            Value::String("Need cwd".to_string())
        );
        assert_eq!(
            row.get("reasoning_content"),
            Some(&Value::String("Need cwd".to_string()))
        );
    }

    #[test]
    fn normalize_chat_response_choice_messages() {
        let mut response = json!({
            "choices": [
                {"message": {"reasoning_content": "first"}},
                {"message": {"reasoning_content": "second"}}
            ]
        });
        if let Some(choices) = response.get_mut("choices").and_then(Value::as_array_mut) {
            for (idx, choice) in choices.iter_mut().enumerate() {
                let row = choice.as_object_mut().unwrap();
                let msg = row.get_mut("message").unwrap().as_object_mut().unwrap();
                normalize_message_reasoning_tools_record(
                    msg,
                    format!("reasoning_choice_{}", idx + 1).as_str(),
                );
            }
        }
        let choices = response
            .get("choices")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(choices.len(), 2);
        assert_eq!(
            choices[0]
                .as_object()
                .and_then(|row| row.get("message"))
                .and_then(Value::as_object)
                .and_then(|msg| msg.get("content"))
                .and_then(Value::as_str),
            Some("[思考]\nfirst\n[/思考]")
        );
    }

    #[test]
    fn extract_tool_calls_parses_xml_arg_pairs() {
        let source = "<tool_call>\nshell\n<arg_key>command</arg_key><arg_value>[\"pwd\"]</arg_value>\n</tool_call>";
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert_eq!(cleaned, "");
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .as_object()
                .and_then(|row| row.get("function"))
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("shell")
        );
    }

    #[test]
    fn extract_tool_calls_preserves_markup_id() {
        let source = "<tool_call>\n<id>call_native_a</id>\nshell\n<arg_key>command</arg_key><arg_value>[\"pwd\"]</arg_value>\n</tool_call>";
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert_eq!(cleaned, "");
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0].get("id").and_then(Value::as_str),
            Some("call_native_a")
        );
    }

    #[test]
    fn extract_tool_calls_skips_shell_like_call_without_command_shape() {
        let source = r#"{"tool_calls":[{"name":"exec_command","arguments":"{}"}]}"#;
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert!(tool_calls.is_empty());
        assert_eq!(cleaned, source);
    }

    #[test]
    fn extract_tool_calls_skips_invalid_non_identifier_tool_name() {
        let source = r#"{"tool_calls":[{"name":"1. 检查 ledger slot 号（记录： 备份 user.md","arguments":"{}"}]}"#;
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert!(tool_calls.is_empty());
        assert_eq!(cleaned, source);
    }

    #[test]
    fn extract_tool_calls_maps_execute_block_to_shell() {
        let source = "<function=execute><parameter=command>ls -la</parameter></function>";
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert_eq!(cleaned, "");
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .as_object()
                .and_then(|row| row.get("function"))
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("exec_command")
        );
    }

    #[test]
    fn extract_tool_calls_ignores_language_fence() {
        let source = "```bash\nls -la\n```";
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert_eq!(cleaned, source);
        assert!(tool_calls.is_empty());
    }

    #[test]
    fn normalize_assistant_text_preserves_tool_call_ids() {
        let message = json!({
            "role": "assistant",
            "content": "",
            "reasoning_content": "<tool_call>\n<id>call_a</id>\nshell\n<arg_key>command</arg_key><arg_value>[\"pwd\"]</arg_value>\n</tool_call>\n<tool_call>\n<id>call_b</id>\nshell\n<arg_key>command</arg_key><arg_value>[\"ls\"]</arg_value>\n</tool_call>"
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");

        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        let tool_calls = output
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        assert_eq!(tool_calls.len(), 2);
        assert_eq!(
            tool_calls[0].get("id").and_then(Value::as_str),
            Some("call_a")
        );
        assert_eq!(
            tool_calls[1].get("id").and_then(Value::as_str),
            Some("call_b")
        );
    }

    #[test]
    fn extract_tool_calls_ignores_displaying_contents_marker() {
        let source = "<is_displaying_contents>\nfalse\n</is_displaying_contents>\n\n<filepaths>\n</filepaths>";
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert_eq!(cleaned, source);
        assert!(tool_calls.is_empty());
    }

    #[test]
    fn extract_tool_calls_rejects_punctuation_only_markup_name() {
        let source = "<tool_call>
---
<arg_key>data</arg_key><arg_value>{summaryData}</arg_value>
</tool_call>";
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert_eq!(cleaned, source);
        assert!(tool_calls.is_empty());
    }

    #[test]
    fn extract_tool_calls_accepts_tool_call_fence() {
        let source =
            "```tool_call\n{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"ls\"}}\n```";
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert_eq!(cleaned, "");
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .as_object()
                .and_then(|row| row.get("function"))
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("exec_command")
        );
    }

    #[test]
    fn extract_tool_calls_harvests_malformed_parameter_markup_payload() {
        let source = r#"
<parameter name="input">pwd</</parameter>
<parameter name="newVersion">
  <parameter name="newVersion">
<parameter name="type">string</parameter>
<parameter name="description"/>
<parameter name="type">string</parameter>
</command></arg_value>
"#;
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert_eq!(cleaned, "");
        assert_eq!(tool_calls.len(), 1);
        let function = tool_calls[0]
            .as_object()
            .and_then(|row| row.get("function"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            function.get("name").and_then(Value::as_str),
            Some("exec_command")
        );
        let args = function
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(args_json["cmd"], "pwd");
    }

    #[test]
    fn extract_tool_calls_harvests_reported_glm_parameter_fragment() {
        let source = r#"<parameter name="input">.389</</parameter>
        <parameter name="newVersion">
          <parameter name="newVersion">
        <parameter name="type">string</parameter>
        <parameter name="description"/>
        <parameter name="type">string</parameter>
      </command></arg_value>"#;
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert_eq!(cleaned, "");
        assert_eq!(tool_calls.len(), 1);
        let function = tool_calls[0]
            .as_object()
            .and_then(|row| row.get("function"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            function.get("name").and_then(Value::as_str),
            Some("exec_command")
        );
        let args = function
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(args_json["cmd"], "0.389");
    }

    #[test]
    fn extract_tool_calls_does_not_harvest_plain_parameter_markup_without_call_shape() {
        let source = r#"<parameter name="description">just text</parameter>"#;
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert_eq!(cleaned, source);
        assert!(tool_calls.is_empty());
    }

    #[test]
    fn extract_tool_calls_skips_markup_exec_command_without_command_shape() {
        let source = r#"<tool_call>
exec_command
<arg_key>workdir</arg_key><arg_value>/Users/fanzhang/Documents/github/camo</arg_value>
</tool_call>"#;
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert!(tool_calls.is_empty());
        assert!(cleaned.contains("exec_command"));
        assert!(!cleaned.contains("</arg_value>"));
        assert!(!cleaned.contains("</tool_call>"));
    }

    #[test]
    fn extract_tool_calls_strips_orphan_closing_markup_suffix_when_no_call_harvested() {
        let source = r#"分析失败原因，发布失败，需要 OTP（一次性密码）验证。 npm 发布需要双重验证（2FA）。
让用户获取 npm OTP token 并使用 --otp 参数重试。
</parameter></parameter></arg_value></tool_call>"#;
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert!(tool_calls.is_empty());
        assert!(cleaned.contains("发布失败"));
        assert!(!cleaned.contains("</arg_value>"));
        assert!(!cleaned.contains("</tool_call>"));
    }

    #[test]
    fn extract_tool_calls_harvests_markup_tail_after_prose_prefix() {
        let source = r#"已分析失败原因，准备继续执行。
<parameter name="input">cd /Users/fanzhang/Documents/github/camo && npm publish --otp 123456</parameter>
</command></arg_value></tool_call>"#;
        let (cleaned, tool_calls) =
            extract_tool_calls_from_reasoning_text(source, "reasoning_test");
        assert_eq!(tool_calls.len(), 1);
        assert!(!cleaned.contains("</arg_value>"));
        assert!(!cleaned.contains("</tool_call>"));
        let function = tool_calls[0]
            .as_object()
            .and_then(|row| row.get("function"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            function.get("name").and_then(Value::as_str),
            Some("exec_command")
        );
        let args = function
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(
            args_json["cmd"],
            "cd /Users/fanzhang/Documents/github/camo && npm publish --otp 123456"
        );
    }

    #[test]
    fn normalize_assistant_text_ignores_plain_markdown_tsx_response() {
        let message = json!({
            "role": "assistant",
            "content": r#"## ✅ 工作完成！

### 1. AI 使用流程已保存到记忆

---

```tsx
<EditableRegistryView
  data={summaryData}
  onChange={(newData) => { /* 更新数据 */ }}
  readOnly={true}
/>
```"#
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");

        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        assert!(output.get("tool_calls").is_none());
        assert_eq!(
            output.get("content").and_then(Value::as_str),
            message.get("content").and_then(Value::as_str)
        );
    }

    #[test]
    fn normalize_assistant_text_accepts_explicit_json_tool_calls_payload() {
        let message = json!({
            "role": "assistant",
            "content": r#"{"tool_calls":[{"id":"call_explicit_1","name":"exec_command","arguments":{"cmd":"pwd"}}]}"#
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");

        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        let tool_calls = output
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("exec_command")
        );
        assert_eq!(
            tool_calls[0].get("id").and_then(Value::as_str),
            Some("call_explicit_1")
        );
        assert_eq!(output.get("content").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn normalize_assistant_text_accepts_lenient_jsonish_tool_calls_payload() {
        let message = json!({
            "role": "assistant",
            "content": r#"{tool_calls:[{id:'call_explicit_2',name:'exec_command',input:{cmd:'git status'}}]}"#
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");

        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        let tool_calls = output
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("exec_command")
        );
        let args = tool_calls[0]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|row| row.get("arguments"))
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(args_json["cmd"], "git status");
        assert_eq!(output.get("content").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn normalize_assistant_text_accepts_nameless_input_cmd_tool_calls_payload() {
        let message = json!({
            "role": "assistant",
            "content": r#"{"tool_calls":[{"input":{"cmd":"cd /repo && node bin/webauto.mjs daemon status --json","justification":"检查 daemon 状态"}}]}"#
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");

        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        let tool_calls = output
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("exec_command")
        );
        let args = tool_calls[0]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|row| row.get("arguments"))
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert!(args_json["cmd"]
            .as_str()
            .unwrap_or("")
            .contains("node bin/webauto.mjs daemon status --json"));
        assert_eq!(output.get("content").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn normalize_assistant_text_accepts_nameless_input_string_tool_calls_payload() {
        let message = json!({
            "role": "assistant",
            "content": r#"{"tool_calls":[{"input":"pwd"}]}"#
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");

        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        let tool_calls = output
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("exec_command")
        );
        let args = tool_calls[0]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|row| row.get("arguments"))
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(args_json["cmd"], "pwd");
        assert_eq!(args_json["command"], "pwd");
        assert_eq!(output.get("content").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn normalize_assistant_text_accepts_nameless_args_command_tool_calls_payload() {
        let message = json!({
            "role": "assistant",
            "content": r#"{"tool_calls":[{"args":{"command":"git status"}}]}"#
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");

        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        let tool_calls = output
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("exec_command")
        );
        let args = tool_calls[0]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|row| row.get("arguments"))
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(args_json["cmd"], "git status");
        assert_eq!(args_json["command"], "git status");
        assert_eq!(output.get("content").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn normalize_assistant_text_accepts_nameless_input_plan_tool_calls_payload() {
        let message = json!({
            "role": "assistant",
            "content": r#"{"tool_calls":[{"input":{"plan":[{"step":"继续执行","status":"in_progress"}],"explanation":"shape inference fallback"}}]}"#
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");

        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        let tool_calls = output
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("update_plan")
        );
        let args = tool_calls[0]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|row| row.get("arguments"))
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert!(args_json["plan"].is_array());
        assert_eq!(output.get("content").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn normalize_assistant_text_repairs_unescaped_quotes_inside_cmd() {
        let message = json!({
            "role": "assistant",
            "content": r#"{"tool_calls":[{"input":{"cmd":"bd --no-db create "Mailbox 统一消息与心跳优先级改造" --type epic --description "统一 mailbox 消息三段式格式""},"name":"exec_command"}]}"#
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");

        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        let tool_calls = output
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("exec_command")
        );
        let args = tool_calls[0]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|row| row.get("arguments"))
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert!(args_json["cmd"]
            .as_str()
            .unwrap_or("")
            .contains("Mailbox 统一消息与心跳优先级改造"));
    }

    #[test]
    fn normalize_assistant_text_repairs_truncated_tool_calls_shape() {
        let message = json!({
            "role": "assistant",
            "content": "{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"bash -lc 'bd --no-db create \\\"Mailbox 三段式消息生成器\\\" --type task\""
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");

        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        let tool_calls = output
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("exec_command")
        );
        let args = tool_calls[0]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|row| row.get("arguments"))
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert!(args_json["cmd"]
            .as_str()
            .unwrap_or("")
            .contains("Mailbox 三段式消息生成器"));
    }

    #[test]
    fn normalize_assistant_text_accepts_quote_wrapped_tool_calls_payload() {
        let message = json!({
            "role": "assistant",
            "content": r#"原文是：<quote>{tool_calls:[{name:'exec_command',input:{cmd:'pwd'}}]}</quote>"#
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");

        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        let tool_calls = output
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("exec_command")
        );
    }

    #[test]
    fn normalize_assistant_text_accepts_heredoc_wrapped_tool_calls_payload() {
        let message = json!({
            "role": "assistant",
            "content": "说明如下\n<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"update_plan\",\"input\":{\"action\":\"create\",\"plan\":[{\"step\":\"A\",\"status\":\"pending\"}]}}]}\nRCC_TOOL_CALLS_JSON\n尾部说明"
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");

        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        let tool_calls = output
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("update_plan")
        );
    }

    #[test]
    fn normalize_assistant_text_accepts_xml_tag_wrapped_tool_calls_payload() {
        let message = json!({
            "role": "assistant",
            "content": "分析中...\n<rcc_tool_calls_json>{\"tool_calls\":[{\"name\":\"agent.dispatch\",\"input\":{\"target_agent_id\":\"finger-project-agent\",\"task\":\"x\"}}]}</rcc_tool_calls_json>"
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");

        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        let tool_calls = output
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("agent.dispatch")
        );
    }

    #[test]
    fn normalize_assistant_text_does_not_infer_tool_name_from_sentinel_payload() {
        let message = json!({
            "role": "assistant",
            "content": "说明\n<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"pwd\"}}]}\nRCC_TOOL_CALLS_JSON"
        });

        let output_json = normalize_assistant_text_to_tool_calls_json(message.to_string(), None)
            .expect("normalize_assistant_text_to_tool_calls_json failed");
        let output: Value =
            serde_json::from_str(&output_json).expect("failed to parse output json");
        let tool_calls = output
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 0);
    }

    #[test]
    fn reasoning_tool_normalizer_chat_payload_json() {
        let response = json!({
            "choices": [
                {
                    "message": {
                        "reasoning_content": "<tool_call>{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}</tool_call>",
                        "content": ""
                    }
                }
            ]
        });
        let raw = normalize_chat_response_reasoning_tools_json(response.to_string(), None).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let choice = parsed
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(Value::as_object)
            .unwrap();
        let message = choice.get("message").and_then(Value::as_object).unwrap();
        let tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        let function = tool_calls[0]
            .get("function")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(
            function.get("name").and_then(Value::as_str),
            Some("exec_command")
        );
        assert_eq!(
            choice.get("finish_reason").and_then(Value::as_str),
            Some("tool_calls")
        );
    }

    #[test]
    fn reasoning_tool_normalizer_harvests_content_json_tool_calls() {
        let response = json!({
            "choices": [
                {
                    "message": {
                        "content": "{\"tool_calls\":[{\"name\":\"update_plan\",\"input\":{\"action\":\"create\",\"plan\":[{\"step\":\"A\",\"status\":\"pending\"}]}},{\"name\":\"agent.dispatch\",\"input\":{\"target_agent_id\":\"finger-project-agent\"}}]}",
                        "reasoning_content": ""
                    },
                    "finish_reason": "stop"
                }
            ]
        });
        let raw = normalize_chat_response_reasoning_tools_json(response.to_string(), None).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let choice = parsed
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(Value::as_object)
            .unwrap();
        let message = choice.get("message").and_then(Value::as_object).unwrap();
        let tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 2);
        assert_eq!(
            tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("update_plan")
        );
        assert_eq!(
            tool_calls[1]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("agent.dispatch")
        );
        assert_eq!(
            choice.get("finish_reason").and_then(Value::as_str),
            Some("tool_calls")
        );
    }

    #[test]
    fn reasoning_tool_normalizer_harvests_tool_calls_from_content_json() {
        let response = json!({
            "choices": [
                {
                    "message": {
                        "content": "{\"tool_calls\":[{\"name\":\"update_plan\",\"input\":{\"action\":\"create\",\"plan\":[{\"step\":\"A\",\"status\":\"pending\"}]}},{\"name\":\"agent.dispatch\",\"input\":{\"target_agent_id\":\"finger-project-agent\",\"task\":\"do work\"}}]}",
                        "reasoning_content": "",
                        "tool_calls": []
                    },
                    "finish_reason": "stop"
                }
            ]
        });
        let raw = normalize_chat_response_reasoning_tools_json(response.to_string(), None).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let choice = parsed
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(Value::as_object)
            .unwrap();
        let message = choice.get("message").and_then(Value::as_object).unwrap();
        let tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 2);
        let first_name = tool_calls[0]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|row| row.get("name"))
            .and_then(Value::as_str);
        let second_name = tool_calls[1]
            .get("function")
            .and_then(Value::as_object)
            .and_then(|row| row.get("name"))
            .and_then(Value::as_str);
        assert_eq!(first_name, Some("update_plan"));
        assert_eq!(second_name, Some("agent.dispatch"));
        assert_eq!(
            choice.get("finish_reason").and_then(Value::as_str),
            Some("tool_calls")
        );
    }

    #[test]
    fn reasoning_tool_normalizer_harvests_tool_calls_from_malformed_content_json() {
        let malformed = "{\"tool_calls\":[{\"name\":\"update_plan\",\"input\":{\"action\":\"create\",\"plan\":[{\"step\":\"A\",\"status\":\"pending\"}]}},{\"name\":\"agent.dispatch\",\"input\":{\"target_agent_id\":\"finger-project-agent\",\"task\":\"alpha\"},{\"name\":\"agent.dispatch\",\"input\":{\"target_agent_id\":\"finger-reviewer\",\"task\":\"beta\"}}]}";
        let response = json!({
            "choices": [
                {
                    "message": {
                        "content": malformed,
                        "reasoning_content": "",
                        "tool_calls": []
                    },
                    "finish_reason": "stop"
                }
            ]
        });

        let raw = normalize_chat_response_reasoning_tools_json(response.to_string(), None).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let choice = parsed
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(Value::as_object)
            .unwrap();
        let message = choice.get("message").and_then(Value::as_object).unwrap();
        let tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 3);
        assert_eq!(
            tool_calls[0]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("update_plan")
        );
        assert_eq!(
            tool_calls[1]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("agent.dispatch")
        );
        assert_eq!(
            tool_calls[2]
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str),
            Some("agent.dispatch")
        );
        assert_eq!(
            choice.get("finish_reason").and_then(Value::as_str),
            Some("tool_calls")
        );
    }

    #[test]
    fn repair_arguments_preserves_apply_patch_freeform() {
        let patch =
            "*** Begin Patch\n*** Update File: src/main.rs\n@@\n-foo\n+bar\n*** End Patch\n";
        let repaired = repair_arguments_to_string(&Value::String(patch.to_string()));
        assert_eq!(repaired, patch);
    }
}
