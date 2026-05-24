use serde_json::Value;
use std::collections::HashMap;

pub(crate) fn is_missing_field(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(Value::Null) => true,
        Some(Value::Array(arr)) => arr.is_empty(),
        _ => false,
    }
}

fn is_summary_text_array(value: &Value) -> bool {
    let Some(arr) = value.as_array() else {
        return false;
    };
    if arr.is_empty() {
        return false;
    }
    for entry in arr {
        let Some(row) = entry.as_object() else {
            return false;
        };
        let kind = row
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let has_text = row
            .get("text")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        if kind != "summary_text" || !has_text {
            return false;
        }
    }
    true
}

fn is_codex_reasoning_summary_display_compatible(text: &str) -> bool {
    let trimmed = text.trim_start();
    if !trimmed.starts_with("**") {
        return false;
    }
    let after_open = &trimmed[2..];
    let Some(close) = after_open.find("**") else {
        return false;
    };
    if close == 0 {
        return false;
    }
    after_open[(close + 2)..]
        .chars()
        .any(|ch| !ch.is_whitespace())
}

fn collapse_whitespace_to_single_spaces(raw: &str) -> String {
    let mut output = String::new();
    let mut last_was_space = false;
    for ch in raw.chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                output.push(' ');
                last_was_space = true;
            }
            continue;
        }
        output.push(ch);
        last_was_space = false;
    }
    output.trim().to_string()
}

fn strip_reasoning_markdown_line_prefix(raw: &str) -> String {
    let mut current = raw.trim_start();
    loop {
        let before = current;
        if let Some(rest) = current.strip_prefix('>') {
            current = rest.trim_start();
            continue;
        }
        if let Some(rest) = current.strip_prefix("- ") {
            current = rest.trim_start();
            continue;
        }
        if let Some(rest) = current.strip_prefix("* ") {
            current = rest.trim_start();
            continue;
        }
        if let Some(rest) = current.strip_prefix("+ ") {
            current = rest.trim_start();
            continue;
        }

        let bytes = current.as_bytes();
        let mut cursor = 0usize;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if cursor > 0 && cursor + 1 < bytes.len() {
            let marker = bytes[cursor];
            let space = bytes[cursor + 1];
            if (marker == b'.' || marker == b')') && space.is_ascii_whitespace() {
                current = current[(cursor + 1)..].trim_start();
                continue;
            }
        }

        if before == current {
            break;
        }
    }

    current.trim().to_string()
}

fn compact_reasoning_summary_body(raw: &str) -> String {
    let normalized = raw
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\r", "\n")
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut lines: Vec<String> = Vec::new();
    let mut last_blank = false;
    for line in normalized.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            continue;
        }
        if trimmed.is_empty() {
            if !last_blank && !lines.is_empty() {
                lines.push(String::new());
            }
            last_blank = true;
            continue;
        }
        lines.push(trimmed.to_string());
        last_blank = false;
    }
    lines.join("\n").trim().to_string()
}

fn normalize_reasoning_summary_text_for_codex(text: &str, ensure_header: bool) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    let (header, body_raw) = if trimmed.starts_with("**") {
        let after_open = &trimmed[2..];
        if let Some(close) = after_open.find("**") {
            if close > 0 {
                let header_end = 2 + close + 2;
                (
                    trimmed[..header_end].trim().to_string(),
                    trimmed[header_end..].to_string(),
                )
            } else {
                (String::new(), trimmed.to_string())
            }
        } else {
            (String::new(), trimmed.to_string())
        }
    } else {
        (String::new(), trimmed.to_string())
    };

    let normalized_body_source = body_raw
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\r", "\n")
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let body = compact_reasoning_summary_body(normalized_body_source.as_str());
    if !header.is_empty() {
        if body.is_empty() {
            return Some(header);
        }
        let wants_paragraph_gap = normalized_body_source.starts_with('\n')
            || normalized_body_source.starts_with("\n\n")
            || normalized_body_source.contains("\n\n");
        if wants_paragraph_gap {
            return Some(format!("{}\n\n{}", header, body.trim()).trim().to_string());
        }
        return Some(format!("{} {}", header, body).trim().to_string());
    }

    if body.is_empty() {
        return None;
    }
    if ensure_header {
        if body.contains('\n') {
            return Some(format!("**Thinking** {}", body));
        }
        return Some(format!("**Thinking** {}", body));
    }
    Some(body)
}

pub(crate) fn normalize_reasoning_summary_for_codex_display(summary_value: &mut Value) {
    let Some(summary_items) = summary_value.as_array_mut() else {
        return;
    };
    if summary_items.is_empty() {
        return;
    }

    let mut summary_text_index: usize = 0;
    for entry in summary_items.iter_mut() {
        let Some(row) = entry.as_object_mut() else {
            continue;
        };
        let kind = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if kind != "summary_text" {
            continue;
        }
        let Some(text) = row.get("text").and_then(Value::as_str) else {
            continue;
        };
        let ensure_header = summary_text_index == 0;
        summary_text_index += 1;
        let Some(normalized_text) = normalize_reasoning_summary_text_for_codex(text, ensure_header)
        else {
            continue;
        };
        if ensure_header && !is_codex_reasoning_summary_display_compatible(normalized_text.as_str())
        {
            continue;
        }
        row.insert("text".to_string(), Value::String(normalized_text));
    }
}

pub(crate) fn merge_responses_output_items(base: &[Value], source: &[Value]) -> Vec<Value> {
    let mut source_by_id: HashMap<String, Value> = HashMap::new();
    for entry in source {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let Some(id) = row.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if !id.trim().is_empty() {
            source_by_id.insert(id.trim().to_string(), entry.clone());
        }
    }

    let mut merged: Vec<Value> = Vec::with_capacity(base.len());
    for (index, entry) in base.iter().enumerate() {
        let Some(base_row) = entry.as_object() else {
            merged.push(entry.clone());
            continue;
        };
        let mut next = base_row.clone();
        let source_item = next
            .get("id")
            .and_then(|v| v.as_str())
            .and_then(|id| source_by_id.get(id))
            .cloned()
            .or_else(|| source.get(index).cloned());
        let Some(source_item) = source_item else {
            merged.push(Value::Object(next));
            continue;
        };
        let Some(source_row) = source_item.as_object() else {
            merged.push(Value::Object(next));
            continue;
        };

        if is_missing_field(next.get("content")) {
            if let Some(content) = source_row.get("content") {
                next.insert("content".to_string(), content.clone());
            }
        }

        if let Some(summary) = source_row.get("summary") {
            let base_summary = next.get("summary");
            let should_override = is_missing_field(base_summary)
                || base_summary.map(is_summary_text_array).unwrap_or(false);
            if should_override {
                next.insert("summary".to_string(), summary.clone());
            }
        }

        if is_missing_field(next.get("encrypted_content")) {
            if let Some(encrypted) = source_row.get("encrypted_content") {
                next.insert("encrypted_content".to_string(), encrypted.clone());
            }
        }

        merged.push(Value::Object(next));
    }
    merged
}
