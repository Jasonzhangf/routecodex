use serde::{Deserialize, Serialize};
use serde_json::Value;

const STOP_MESSAGE_BLOCKED_TEXT_SCAN_LIMIT: usize = 12;
const STOP_MESSAGE_BLOCKED_CANDIDATE_MAX_LENGTH: usize = 12_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageBlockedReport {
    pub summary: String,
    pub blocker: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impact: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_action: Option<String>,
    pub evidence: Vec<String>,
}

pub fn extract_blocked_report_from_messages(messages: &Value) -> Option<StopMessageBlockedReport> {
    let items = messages.as_array()?;
    if items.is_empty() {
        return None;
    }
    let start = items
        .len()
        .saturating_sub(STOP_MESSAGE_BLOCKED_TEXT_SCAN_LIMIT);
    for message in items[start..].iter().rev() {
        let text = extract_captured_message_text(message);
        if text.is_empty() {
            continue;
        }
        if let Some(report) = extract_blocked_report_from_text(&text) {
            return Some(report);
        }
    }
    None
}

pub fn extract_captured_message_text(message: &Value) -> String {
    if let Some(text) = message.as_str() {
        return text.trim().to_string();
    }
    let Some(record) = message.as_object() else {
        return String::new();
    };
    for key in ["content", "input", "output"] {
        let text = extract_text_from_message_content(record.get(key).unwrap_or(&Value::Null));
        if !text.is_empty() {
            return text;
        }
    }
    to_non_empty_text(record.get("arguments").unwrap_or(&Value::Null))
}

pub fn extract_text_from_message_content(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.trim().to_string();
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };
    let mut chunks = Vec::new();
    for item in items {
        if let Some(text) = item.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                chunks.push(trimmed.to_string());
            }
            continue;
        }
        let Some(record) = item.as_object() else {
            continue;
        };
        let item_type =
            to_non_empty_text(record.get("type").unwrap_or(&Value::Null)).to_lowercase();
        if item_type == "text"
            || item_type == "output_text"
            || item_type == "input_text"
            || item_type.is_empty()
        {
            let text = to_non_empty_text(record.get("text").unwrap_or(&Value::Null));
            if !text.is_empty() {
                chunks.push(text);
            }
            continue;
        }
        let blocked_text = ["content", "value"]
            .iter()
            .find_map(|key| {
                let text = to_non_empty_text(record.get(*key).unwrap_or(&Value::Null));
                (!text.is_empty()).then_some(text)
            })
            .or_else(|| {
                ["input", "arguments", "args", "patch", "payload"]
                    .iter()
                    .find_map(|key| {
                        let text =
                            extract_unknown_text(record.get(*key).unwrap_or(&Value::Null), 0);
                        (!text.is_empty()).then_some(text)
                    })
            });
        if let Some(text) = blocked_text {
            chunks.push(text);
        }
    }
    dedupe_and_join_texts(chunks)
}

fn extract_unknown_text(value: &Value, depth: usize) -> String {
    if depth > 4 || value.is_null() {
        return String::new();
    }
    if let Some(text) = value.as_str() {
        return text.trim().to_string();
    }
    if value.is_number() || value.is_boolean() {
        return value.to_string();
    }
    if let Some(items) = value.as_array() {
        return dedupe_and_join_texts(
            items
                .iter()
                .map(|entry| extract_unknown_text(entry, depth + 1))
                .filter(|entry| !entry.is_empty())
                .collect(),
        );
    }
    let Some(record) = value.as_object() else {
        return String::new();
    };
    let priority_keys = [
        "text",
        "content",
        "value",
        "input",
        "arguments",
        "args",
        "patch",
        "payload",
        "summary",
        "reasoning",
        "thinking",
        "analysis",
    ];
    dedupe_and_join_texts(
        priority_keys
            .iter()
            .filter_map(|key| record.get(*key))
            .map(|entry| extract_unknown_text(entry, depth + 1))
            .filter(|entry| !entry.is_empty())
            .collect(),
    )
}

fn extract_blocked_report_from_text(text: &str) -> Option<StopMessageBlockedReport> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut candidates = Vec::new();
    push_candidate(&mut candidates, trimmed.to_string());
    for code_block in extract_json_code_blocks(trimmed) {
        push_candidate(&mut candidates, code_block);
    }
    for object_text in extract_balanced_json_object_strings(trimmed) {
        if object_text.contains("\"type\"") && object_text.to_lowercase().contains("\"blocked\"") {
            push_candidate(&mut candidates, object_text);
        }
    }
    for candidate in candidates {
        let Ok(parsed) = serde_json::from_str::<Value>(&candidate) else {
            continue;
        };
        if let Some(report) = normalize_blocked_report(&parsed) {
            return Some(report);
        }
    }
    None
}

fn push_candidate(candidates: &mut Vec<String>, candidate: String) {
    let normalized = candidate.trim().to_string();
    if normalized.is_empty() || normalized.len() > STOP_MESSAGE_BLOCKED_CANDIDATE_MAX_LENGTH {
        return;
    }
    if !candidates.iter().any(|existing| existing == &normalized) {
        candidates.push(normalized);
    }
}

fn normalize_blocked_report(value: &Value) -> Option<StopMessageBlockedReport> {
    if let Some(items) = value.as_array() {
        return items.iter().find_map(normalize_blocked_report);
    }
    let record = value.as_object()?;
    let report_type = to_non_empty_text(record.get("type").unwrap_or(&Value::Null)).to_lowercase();
    if report_type != "blocked" {
        return None;
    }
    let summary = first_text(record, &["summary", "title", "problem"])?;
    let blocker = first_text(record, &["blocker", "reason", "blocked_by"])?;
    let impact = first_text(record, &["impact", "effect"]).map(|text| truncate_chars(&text, 1_000));
    let next_action = first_text(record, &["next_action", "nextAction", "next_step"])
        .map(|text| truncate_chars(&text, 1_000));
    Some(StopMessageBlockedReport {
        summary: truncate_chars(&summary, 1_000),
        blocker: truncate_chars(&blocker, 1_000),
        impact,
        next_action,
        evidence: normalize_blocked_evidence(record.get("evidence").unwrap_or(&Value::Null)),
    })
}

fn normalize_blocked_evidence(raw: &Value) -> Vec<String> {
    if let Some(items) = raw.as_array() {
        return items
            .iter()
            .map(to_non_empty_text)
            .filter(|entry| !entry.is_empty())
            .map(|entry| truncate_chars(&entry, 800))
            .take(8)
            .collect();
    }
    let single = to_non_empty_text(raw);
    if single.is_empty() {
        Vec::new()
    } else {
        vec![truncate_chars(&single, 800)]
    }
}

fn extract_json_code_blocks(text: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("```") {
        rest = &rest[start + 3..];
        if rest.len() >= 4 && rest[..4].eq_ignore_ascii_case("json") {
            rest = &rest[4..];
        }
        rest = rest.trim_start();
        let Some(end) = rest.find("```") else {
            break;
        };
        let body = rest[..end].trim();
        if !body.is_empty() {
            candidates.push(body.to_string());
        }
        rest = &rest[end + 3..];
    }
    candidates
}

fn extract_balanced_json_object_strings(text: &str) -> Vec<String> {
    let mut results = Vec::new();
    let mut start: Option<usize> = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (idx, ch) in text.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '{' {
            if depth == 0 {
                start = Some(idx);
            }
            depth += 1;
            continue;
        }
        if ch == '}' {
            if depth == 0 {
                continue;
            }
            depth -= 1;
            if depth == 0 {
                if let Some(start_idx) = start.take() {
                    results.push(text[start_idx..idx + ch.len_utf8()].to_string());
                }
            }
        }
    }
    results
}

fn first_text(record: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .map(|key| to_non_empty_text(record.get(*key).unwrap_or(&Value::Null)))
        .find(|text| !text.is_empty())
}

fn to_non_empty_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn dedupe_and_join_texts(parts: Vec<String>) -> String {
    let mut unique = Vec::new();
    for part in parts {
        let trimmed = part.trim();
        if trimmed.is_empty() || unique.iter().any(|entry: &String| entry == trimmed) {
            continue;
        }
        unique.push(trimmed.to_string());
    }
    unique.join("\n").trim().to_string()
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_structured_blocked_json_report_from_assistant_text_payload() {
        let report = extract_blocked_report_from_messages(&json!([
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "text",
                        "text": concat!(
                            "执行受阻，请建单：\n",
                            "```json\n",
                            "{\"type\":\"blocked\",\"summary\":\"deepseek token refresh failed\",\"blocker\":\"HTTP 401 from oauth endpoint\",\"impact\":\"cannot continue auth flow\",\"next_action\":\"rotate credential and retry\",\"evidence\":[\"requestId=req_1\",\"provider=deepseek-web.3\"]}\n",
                            "```"
                        )
                    }
                ]
            }
        ]))
        .expect("blocked report");
        assert_eq!(report.summary, "deepseek token refresh failed");
        assert_eq!(report.blocker, "HTTP 401 from oauth endpoint");
        assert_eq!(
            report.next_action.as_deref(),
            Some("rotate credential and retry")
        );
        assert_eq!(
            report.evidence,
            vec!["requestId=req_1", "provider=deepseek-web.3"]
        );
    }

    #[test]
    fn scans_only_recent_messages_from_newest_to_oldest() {
        let mut messages = vec![json!({"content": "old"})];
        for index in 0..12 {
            messages.push(json!({"content": format!("message {index}")}));
        }
        messages.push(json!({
            "content": "{\"type\":\"blocked\",\"summary\":\"latest\",\"blocker\":\"missing token\"}"
        }));
        let report = extract_blocked_report_from_messages(&Value::Array(messages)).expect("report");
        assert_eq!(report.summary, "latest");
        assert_eq!(report.blocker, "missing token");
    }

    #[test]
    fn extracts_balanced_json_object_embedded_in_text() {
        let report = extract_blocked_report_from_messages(&json!([
            {"content": "prefix {\"type\":\"blocked\",\"summary\":\"blocked\",\"blocker\":\"quota\",\"evidence\":\"quota=0\"} suffix"}
        ]))
        .expect("report");
        assert_eq!(report.evidence, vec!["quota=0"]);
    }

    #[test]
    fn extracts_uppercase_json_code_block_language() {
        let report = extract_blocked_report_from_messages(&json!([
            {
                "content": concat!(
                    "blocked detail\n",
                    "```JSON\n",
                    "{\"type\":\"blocked\",\"title\":\"auth blocked\",\"reason\":\"token expired\"}\n",
                    "```"
                )
            }
        ]))
        .expect("report");

        assert_eq!(report.summary, "auth blocked");
        assert_eq!(report.blocker, "token expired");
    }
}
