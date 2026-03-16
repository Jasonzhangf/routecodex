use napi::bindgen_prelude::Result as NapiResult;
use regex::Regex;
use serde_json::{json, Map, Value};

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

fn extract_reasoning_segments(
    source: &str,
    reasoning_collector: Option<&mut Vec<String>>,
) -> String {
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

    let mut collected: Vec<String> = Vec::new();
    working = think_block
        .replace_all(&working, |caps: &regex::Captures| {
            if let Some(inner) = caps.get(1) {
                let trimmed = inner.as_str().trim();
                if !trimmed.is_empty() {
                    collected.push(trimmed.to_string());
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
                    collected.push(trimmed.to_string());
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
                    collected.push(trimmed.to_string());
                }
            }
            ""
        })
        .to_string();
    working = fenced.replace_all(&working, "").to_string();
    working = open_close.replace_all(&working, "").to_string();
    working = multiple_breaks.replace_all(&working, "\n\n").to_string();

    let trimmed = working.trim().to_string();
    if let Some(collector) = reasoning_collector {
        collector.extend(collected.into_iter());
        if !has_explicit_open && has_explicit_close && !trimmed.is_empty() {
            collector.push(trimmed);
            return String::new();
        }
    }
    trimmed
}

fn push_text_value(value: &str, text_parts: &mut Vec<String>, reasoning_parts: &mut Vec<String>) {
    let cleaned = extract_reasoning_segments(value, Some(reasoning_parts));
    if !cleaned.is_empty() {
        text_parts.push(cleaned);
    }
}

fn collect_text_and_reasoning(blocks: &Value, collector: &mut OutputContentExtractionResult) {
    if let Some(text) = blocks.as_str() {
        push_text_value(
            text,
            &mut collector.text_parts,
            &mut collector.reasoning_parts,
        );
        return;
    }
    let Some(items) = blocks.as_array() else {
        return;
    };
    for block in items {
        let Some(row) = block.as_object() else {
            continue;
        };
        let block_type = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if ["text", "input_text", "output_text", "commentary"].contains(&block_type.as_str()) {
            if let Some(text) = row
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| row.get("content").and_then(Value::as_str))
            {
                push_text_value(
                    text,
                    &mut collector.text_parts,
                    &mut collector.reasoning_parts,
                );
            }
            continue;
        }
        if let Some(content) = row.get("content") {
            if content.is_array() {
                collect_text_and_reasoning(content, collector);
                continue;
            }
        }
        if let Some(text) = row.get("text").and_then(Value::as_str) {
            push_text_value(
                text,
                &mut collector.text_parts,
                &mut collector.reasoning_parts,
            );
        }
    }
}

pub(crate) fn extract_output_segments(
    source: &Value,
    items_key: &str,
) -> OutputContentExtractionResult {
    let mut result = OutputContentExtractionResult {
        text_parts: Vec::new(),
        reasoning_parts: Vec::new(),
    };
    let Some(source_obj) = source.as_object() else {
        return result;
    };
    let output_items = source_obj
        .get(items_key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for item in output_items {
        let Some(row) = item.as_object() else {
            continue;
        };
        let item_type = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if item_type == "message" {
            let message_obj = row.get("message").and_then(Value::as_object).unwrap_or(row);
            let content = message_obj
                .get("content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            collect_text_and_reasoning(&Value::Array(content), &mut result);
            continue;
        }
        if item_type == "output_text" {
            if let Some(text) = row.get("text").and_then(Value::as_str) {
                let cleaned = extract_reasoning_segments(text, Some(&mut result.reasoning_parts));
                if !cleaned.is_empty() {
                    result.text_parts.push(cleaned);
                }
            }
            continue;
        }
        if item_type == "reasoning" {
            let content = row
                .get("content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for block in content {
                let Some(block_row) = block.as_object() else {
                    continue;
                };
                let Some(text) = block_row.get("text").and_then(Value::as_str) else {
                    continue;
                };
                let sanitized = sanitize_reasoning_tagged_text(text);
                if !sanitized.is_empty() {
                    result.reasoning_parts.push(sanitized);
                }
            }
        }
    }
    result
}

fn spread_like_record(value: &Value) -> Map<String, Value> {
    if let Some(row) = value.as_object() {
        return row.clone();
    }
    if let Some(items) = value.as_array() {
        let mut row = Map::new();
        for (idx, entry) in items.iter().enumerate() {
            row.insert(idx.to_string(), entry.clone());
        }
        return row;
    }
    Map::new()
}

fn normalize_content_part(
    part: &Value,
    reasoning_collector: &mut Vec<String>,
) -> Option<Map<String, Value>> {
    if part.is_null() {
        return None;
    }
    if let Some(text) = part.as_str() {
        let cleaned = extract_reasoning_segments(text, Some(reasoning_collector));
        return Some(Map::from_iter(vec![
            ("type".to_string(), Value::String("output_text".to_string())),
            ("text".to_string(), Value::String(cleaned)),
        ]));
    }
    if !part.is_object() && !part.is_array() {
        return Some(Map::from_iter(vec![
            ("type".to_string(), Value::String("output_text".to_string())),
            (
                "text".to_string(),
                Value::String(sanitize_reasoning_tagged_text(part.to_string().as_str())),
            ),
        ]));
    }

    let mut clone = spread_like_record(part);
    clone.remove("_initialText");
    clone.remove("_hasDelta");

    if let Some(text) = clone
        .get("text")
        .and_then(Value::as_str)
        .map(|v| v.to_string())
    {
        clone.insert(
            "text".to_string(),
            Value::String(extract_reasoning_segments(
                text.as_str(),
                Some(reasoning_collector),
            )),
        );
    }
    if let Some(output_text) = clone.get("output_text").and_then(Value::as_object) {
        if let Some(text) = output_text.get("text").and_then(Value::as_str) {
            let mut next = output_text.clone();
            next.insert(
                "text".to_string(),
                Value::String(extract_reasoning_segments(text, Some(reasoning_collector))),
            );
            clone.insert("output_text".to_string(), Value::Object(next));
        }
    }
    if let Some(content) = clone
        .get("content")
        .and_then(Value::as_str)
        .map(|v| v.to_string())
    {
        clone.insert(
            "content".to_string(),
            Value::String(extract_reasoning_segments(
                content.as_str(),
                Some(reasoning_collector),
            )),
        );
    }

    if !clone.contains_key("type") {
        clone.insert("type".to_string(), Value::String("output_text".to_string()));
    }
    if clone
        .get("type")
        .and_then(Value::as_str)
        .map(|v| v == "output_text")
        .unwrap_or(false)
        && !clone.get("text").map(Value::is_string).unwrap_or(false)
    {
        clone.insert("text".to_string(), Value::String(String::new()));
    }
    Some(clone)
}

pub(crate) fn normalize_message_content_parts(
    parts: &Value,
    reasoning_collector: Option<&Value>,
) -> Value {
    let mut reasoning_chunks: Vec<String> = reasoning_collector
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|v| v.to_string())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let mut normalized_parts: Vec<Value> = Vec::new();

    if !parts.is_array() {
        if let Some(part) = normalize_content_part(parts, &mut reasoning_chunks) {
            normalized_parts.push(Value::Object(part));
        }
        return json!({
            "normalizedParts": normalized_parts,
            "reasoningChunks": reasoning_chunks
        });
    }

    for part in parts.as_array().unwrap_or(&Vec::new()) {
        if let Some(normalized) = normalize_content_part(part, &mut reasoning_chunks) {
            normalized_parts.push(Value::Object(normalized));
        }
    }
    json!({
        "normalizedParts": normalized_parts,
        "reasoningChunks": reasoning_chunks
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputContentExtractionResult {
    pub(crate) text_parts: Vec<String>,
    pub(crate) reasoning_parts: Vec<String>,
}

#[napi_derive::napi]
pub fn extract_output_segments_json(
    source_json: String,
    items_key: Option<String>,
) -> NapiResult<String> {
    let source: Value =
        serde_json::from_str(&source_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = extract_output_segments(
        &source,
        items_key.unwrap_or_else(|| "output".to_string()).as_str(),
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn normalize_output_content_part_json(
    part_json: String,
    reasoning_collector_json: String,
) -> NapiResult<String> {
    let part: Value =
        serde_json::from_str(&part_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let collector_seed: Value = serde_json::from_str(&reasoning_collector_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut reasoning_collector: Vec<String> = collector_seed
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|v| v.to_string())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let normalized = normalize_content_part(&part, &mut reasoning_collector)
        .map(Value::Object)
        .unwrap_or(Value::Null);
    let output = json!({
      "normalized": normalized,
      "reasoningCollector": reasoning_collector
    });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn normalize_message_content_parts_json(
    parts_json: String,
    reasoning_collector_json: String,
) -> NapiResult<String> {
    let parts: Value =
        serde_json::from_str(&parts_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let collector_seed: Value = serde_json::from_str(&reasoning_collector_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_message_content_parts(&parts, Some(&collector_seed));
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
