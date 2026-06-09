use serde::{Deserialize, Serialize};
use serde_json::Value;

const FOLLOWUP_ERROR_REASON_MAX_LENGTH: usize = 220;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolTimeoutPolicyInput {
    #[serde(default)]
    pub raw: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolClientInjectTextInput {
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolProviderKeyInput {
    pub adapter_context: Value,
}

pub fn parse_servertool_timeout_ms(input: &ServertoolTimeoutPolicyInput) -> Result<u64, String> {
    let Some(raw) = input.raw.as_ref() else {
        return Ok(0);
    };
    let value = match raw {
        Value::String(text) => text.trim().parse::<f64>().ok(),
        Value::Number(number) => number.as_f64(),
        _ => None,
    };
    let Some(value) = value else {
        return Err("parseTimeoutMs: invalid timeout value".to_string());
    };
    if !value.is_finite() || value <= 0.0 {
        return Err("parseTimeoutMs: invalid timeout value".to_string());
    }
    Ok(value.floor() as u64)
}

pub fn read_client_inject_only(metadata: &Value) -> bool {
    let value = metadata.get("clientInjectOnly").unwrap_or(&Value::Null);
    matches!(parse_boolean_like(value), Some(true))
}

pub fn normalize_client_inject_text(
    input: &ServertoolClientInjectTextInput,
) -> Result<String, String> {
    let Some(text) = input.value.as_str() else {
        return Err("normalizeClientInjectText: value must be a non-empty string".to_string());
    };
    if text.trim().is_empty() {
        return Err("normalizeClientInjectText: value must be a non-empty string".to_string());
    }
    let sanitized = sanitize_followup_text(text.trim());
    if sanitized.is_empty() {
        return Err("normalizeClientInjectText: sanitized result is empty".to_string());
    }
    Ok(sanitized)
}

pub fn compact_followup_error_reason(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    let normalized = collapse_ascii_whitespace(text.trim());
    if normalized.is_empty() {
        return None;
    }
    if let Some(code) = extract_http_status_code(&normalized) {
        return Some(format!("HTTP_{code}"));
    }
    let lower = normalized.to_ascii_lowercase();
    if lower.contains("<!doctype html") || lower.contains("<html") {
        return Some("UPSTREAM_HTML_ERROR".to_string());
    }
    if normalized.len() <= FOLLOWUP_ERROR_REASON_MAX_LENGTH {
        return Some(normalized);
    }
    Some(format!(
        "{}...",
        truncate_utf8_boundary(&normalized, FOLLOWUP_ERROR_REASON_MAX_LENGTH)
    ))
}

pub fn resolve_adapter_context_provider_key(input: &ServertoolProviderKeyInput) -> String {
    let Some(record) = input.adapter_context.as_object() else {
        return String::new();
    };
    if let Some(target) = record.get("target").and_then(Value::as_object) {
        if let Some(provider_key) = read_non_empty_string(target.get("providerKey")) {
            return provider_key;
        }
        if let Some(provider_id) = read_non_empty_string(target.get("providerId")) {
            return provider_id;
        }
    }
    if let Some(target_provider_key) = read_non_empty_string(record.get("targetProviderKey")) {
        return target_provider_key;
    }
    read_non_empty_string(record.get("providerKey")).unwrap_or_default()
}

fn parse_boolean_like(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn sanitize_followup_text(raw: &str) -> String {
    let without_stop_markers = remove_stopmessage_markers(raw);
    let without_time_tags = remove_time_tag_blocks(&without_stop_markers);
    let without_images = without_time_tags.replace("[Image omitted]", " ");
    let normalized_lines = without_images
        .lines()
        .map(|line| line.trim())
        .collect::<Vec<_>>()
        .join("\n");
    collapse_blank_lines(&normalized_lines)
}

fn remove_stopmessage_markers(raw: &str) -> String {
    let mut output = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find("<**") {
        output.push_str(&rest[..start]);
        let after_start = &rest[start + 3..];
        if let Some(end) = after_start.find("**>") {
            output.push(' ');
            rest = &after_start[end + 3..];
        } else {
            output.push_str(&rest[start..]);
            rest = "";
            break;
        }
    }
    output.push_str(rest);
    output
}

fn remove_time_tag_blocks(raw: &str) -> String {
    raw.lines()
        .filter(|line| !line.trim_start().starts_with("[Time/Date]:"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn collapse_blank_lines(raw: &str) -> String {
    let mut output = String::new();
    let mut blank_seen = false;
    for line in raw.lines() {
        let trimmed = line.trim_end();
        if trimmed.trim().is_empty() {
            if !blank_seen && !output.is_empty() {
                output.push('\n');
                output.push('\n');
                blank_seen = true;
            }
            continue;
        }
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(trimmed);
        blank_seen = false;
    }
    output.trim().to_string()
}

fn collapse_ascii_whitespace(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn extract_http_status_code(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("http ") {
        let digits = rest
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .collect::<String>();
        if digits.len() == 3 {
            return Some(digits);
        }
    }
    let words = lower
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    for window in words.windows(2) {
        if window[0] == "http"
            && window[1].len() == 3
            && window[1].chars().all(|ch| ch.is_ascii_digit())
        {
            return Some(window[1].to_string());
        }
    }
    for word in words {
        if let Some(digits) = word.strip_prefix("http") {
            if digits.len() == 3 && digits.chars().all(|ch| ch.is_ascii_digit()) {
                return Some(digits.to_string());
            }
        }
    }
    None
}

fn truncate_utf8_boundary(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn read_non_empty_string(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_timeout_or_zero_and_rejects_invalid_values() {
        assert_eq!(
            parse_servertool_timeout_ms(&ServertoolTimeoutPolicyInput { raw: None }).unwrap(),
            0
        );
        assert_eq!(
            parse_servertool_timeout_ms(&ServertoolTimeoutPolicyInput {
                raw: Some(json!("1500.9"))
            })
            .unwrap(),
            1500
        );
        assert!(parse_servertool_timeout_ms(&ServertoolTimeoutPolicyInput {
            raw: Some(json!("0"))
        })
        .is_err());
    }

    #[test]
    fn parses_client_inject_only_boolean_like_values() {
        assert!(read_client_inject_only(
            &json!({ "clientInjectOnly": " true " })
        ));
        assert!(!read_client_inject_only(
            &json!({ "clientInjectOnly": "false" })
        ));
        assert!(!read_client_inject_only(
            &json!({ "clientInjectOnly": "yes" })
        ));
    }

    #[test]
    fn normalizes_client_inject_text_with_followup_sanitizer() {
        let normalized = normalize_client_inject_text(&ServertoolClientInjectTextInput {
            value: json!("  hello\n[Time/Date]: now\n<**hidden**>\n[Image omitted]\n\n\nworld  "),
        })
        .unwrap();
        assert_eq!(normalized, "hello\n\nworld");
    }

    #[test]
    fn compacts_error_reason_status_html_and_length() {
        assert_eq!(
            compact_followup_error_reason(&json!("HTTP 429: too many")),
            Some("HTTP_429".to_string())
        );
        assert_eq!(
            compact_followup_error_reason(&json!("upstream http 503 refused")),
            Some("HTTP_503".to_string())
        );
        assert_eq!(
            compact_followup_error_reason(&json!("<html><body>bad</body></html>")),
            Some("UPSTREAM_HTML_ERROR".to_string())
        );
        let long = "x".repeat(300);
        let compacted = compact_followup_error_reason(&json!(long)).unwrap();
        assert_eq!(compacted.len(), 223);
        assert!(compacted.ends_with("..."));
    }

    #[test]
    fn resolves_adapter_context_provider_key_order() {
        assert_eq!(
            resolve_adapter_context_provider_key(&ServertoolProviderKeyInput {
                adapter_context: json!({
                    "providerKey": "alias",
                    "targetProviderKey": "direct",
                    "target": { "providerKey": " target " }
                })
            }),
            "target"
        );
        assert_eq!(
            resolve_adapter_context_provider_key(&ServertoolProviderKeyInput {
                adapter_context: json!({ "target": { "providerId": " provider " } })
            }),
            "provider"
        );
    }
}
