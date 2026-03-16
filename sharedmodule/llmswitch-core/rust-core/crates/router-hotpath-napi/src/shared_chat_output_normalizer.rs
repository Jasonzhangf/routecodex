use napi::bindgen_prelude::Result as NapiResult;
use regex::Regex;
use serde_json::Value;

fn sanitize_reasoning_tagged_text(text: &str) -> String {
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

fn extract_reasoning_segments(source: &str, reasoning_collector: &mut Vec<String>) -> String {
    let mut working = source.to_string();
    let has_explicit_open = Regex::new(r"(?i)<think>|<reflection>|```\s*(?:think|reflection)|\\[\\s*思考\\s*\\]")
        .ok()
        .map(|re| re.is_match(source))
        .unwrap_or(false);
    let has_explicit_close = Regex::new(r"(?i)</think>|</reflection>|\\[\\s*/\\s*思考\\s*\\]")
        .ok()
        .map(|re| re.is_match(source))
        .unwrap_or(false);

    let think_block =
        Regex::new(r"(?is)<think>([\s\S]*?)</think>").expect("valid think capture pattern");
    let reflection_block = Regex::new(r"(?is)<reflection>([\s\S]*?)</reflection>")
        .expect("valid reflection capture pattern");
    let cn_think_block = Regex::new(r"(?is)\\[\\s*思考\\s*\\]([\\s\\S]*?)\\[\\s*/\\s*思考\\s*\\]")
        .expect("valid cn think capture pattern");
    let fenced =
        Regex::new(r"(?is)```\s*(?:think|reflection)[\s\S]*?```").expect("valid fenced pattern");
    let open_close =
        Regex::new(r"(?is)</?(?:think|reflection)>|\\[\\s*/?\\s*思考\\s*\\]")
            .expect("valid open-close pattern");
    let multiple_breaks = Regex::new(r"\n{3,}").expect("valid line breaks pattern");

    working = think_block
        .replace_all(&working, |caps: &regex::Captures| {
            if let Some(inner) = caps.get(1) {
                let trimmed = inner.as_str().trim();
                if !trimmed.is_empty() {
                    reasoning_collector.push(trimmed.to_string());
                }
            }
            ""
        })
        .to_string();
    working = reflection_block
        .replace_all(&working, |caps: &regex::Captures| {
            if let Some(inner) = caps.get(1) {
                let trimmed = inner.as_str().trim();
                if !trimmed.is_empty() {
                    reasoning_collector.push(trimmed.to_string());
                }
            }
            ""
        })
        .to_string();
    working = cn_think_block
        .replace_all(&working, |caps: &regex::Captures| {
            if let Some(inner) = caps.get(1) {
                let trimmed = inner.as_str().trim();
                if !trimmed.is_empty() {
                    reasoning_collector.push(trimmed.to_string());
                }
            }
            ""
        })
        .to_string();
    working = fenced.replace_all(&working, "").to_string();
    working = open_close.replace_all(&working, "").to_string();
    working = multiple_breaks.replace_all(&working, "\n\n").to_string();

    let trimmed = working.trim().to_string();
    if !has_explicit_open && has_explicit_close && !trimmed.is_empty() {
        reasoning_collector.push(trimmed);
        return String::new();
    }
    trimmed
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NormalizeChatMessageContentOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) content_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reasoning_text: Option<String>,
}

fn collect_text(value: &Value, text_parts: &mut Vec<String>, reasoning_parts: &mut Vec<String>) {
    if value.is_null() {
        return;
    }
    if let Some(text) = value.as_str() {
        let cleaned = extract_reasoning_segments(text, reasoning_parts);
        if !cleaned.is_empty() {
            text_parts.push(cleaned);
        }
        return;
    }
    if let Some(items) = value.as_array() {
        for entry in items {
            collect_text(entry, text_parts, reasoning_parts);
        }
        return;
    }
    if let Some(record) = value.as_object() {
        if let Some(text) = record.get("text").and_then(Value::as_str) {
            collect_text(
                &Value::String(text.to_string()),
                text_parts,
                reasoning_parts,
            );
            return;
        }
        if let Some(content) = record.get("content") {
            if let Some(text) = content.as_str() {
                collect_text(
                    &Value::String(text.to_string()),
                    text_parts,
                    reasoning_parts,
                );
                return;
            }
            if content.is_array() {
                collect_text(content, text_parts, reasoning_parts);
                return;
            }
        }
        if record.get("type").and_then(Value::as_str) == Some("image_url") {
            if let Some(image_url) = record.get("image_url").and_then(Value::as_str) {
                text_parts.push(format!("[image:{}]", image_url));
                return;
            }
        }
        let serialized =
            serde_json::to_string(record).unwrap_or_else(|_| "[object Object]".to_string());
        text_parts.push(sanitize_reasoning_tagged_text(serialized.as_str()));
        return;
    }
    text_parts.push(sanitize_reasoning_tagged_text(value.to_string().as_str()));
}

pub(crate) fn normalize_chat_message_content(content: &Value) -> NormalizeChatMessageContentOutput {
    let mut text_parts: Vec<String> = Vec::new();
    let mut reasoning_parts: Vec<String> = Vec::new();
    collect_text(content, &mut text_parts, &mut reasoning_parts);
    let text = text_parts.join("");
    let reasoning = reasoning_parts.join("\n");
    NormalizeChatMessageContentOutput {
        content_text: if text.is_empty() { None } else { Some(text) },
        reasoning_text: if reasoning.is_empty() {
            None
        } else {
            Some(reasoning)
        },
    }
}

#[napi_derive::napi]
pub fn normalize_chat_message_content_json(content_json: String) -> NapiResult<String> {
    let content: Value =
        serde_json::from_str(&content_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_chat_message_content(&content);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
