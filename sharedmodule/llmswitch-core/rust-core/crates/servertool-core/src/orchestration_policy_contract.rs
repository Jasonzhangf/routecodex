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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolTimeoutWatcherInput {
    #[serde(default)]
    pub timeout_ms: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolTimeoutWatcherPlan {
    pub armed: bool,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolClientDisconnectWatcherInput {
    #[serde(default)]
    pub poll_interval_ms: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolClientDisconnectWatcherPlan {
    pub interval_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolClientDisconnectedErrorInput {
    pub request_id: String,
    #[serde(default)]
    pub flow_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolErrorPlan {
    pub message: String,
    pub code: String,
    pub category: String,
    pub status: u16,
    pub details: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolTimeoutErrorInput {
    pub request_id: String,
    pub phase: String,
    pub timeout_ms: Value,
    #[serde(default)]
    pub flow_id: Option<String>,
    #[serde(default)]
    pub attempt: Option<Value>,
    #[serde(default)]
    pub max_attempts: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageFetchFailedErrorInput {
    pub request_id: String,
    pub reason: String,
    #[serde(default)]
    pub elapsed_ms: Option<Value>,
    #[serde(default)]
    pub repeat_count: Option<Value>,
    #[serde(default)]
    pub attempt: Option<Value>,
    #[serde(default)]
    pub max_attempts: Option<Value>,
}

pub fn parse_servertool_timeout_ms(input: &ServertoolTimeoutPolicyInput) -> Result<u64, String> {
    let Some(raw) = input.raw.as_ref() else {
        return Ok(0);
    };
    let value = read_number_or_string(raw);
    let Some(value) = value else {
        return Err("parseTimeoutMs: invalid timeout value".to_string());
    };
    if !value.is_finite() || value <= 0.0 {
        return Err("parseTimeoutMs: invalid timeout value".to_string());
    }
    Ok(value.floor() as u64)
}

pub fn plan_servertool_timeout_watcher(
    input: &ServertoolTimeoutWatcherInput,
) -> ServertoolTimeoutWatcherPlan {
    let timeout_ms = input
        .timeout_ms
        .as_ref()
        .and_then(read_positive_floor_number)
        .unwrap_or(0);
    ServertoolTimeoutWatcherPlan {
        armed: timeout_ms > 0,
        timeout_ms,
    }
}

pub fn is_adapter_client_disconnected(adapter_context: &Value) -> bool {
    let Some(record) = adapter_context.as_object() else {
        return false;
    };
    if record
        .get("clientConnectionState")
        .and_then(Value::as_object)
        .and_then(|state| parse_boolean_like(state.get("disconnected").unwrap_or(&Value::Null)))
        == Some(true)
    {
        return true;
    }
    parse_boolean_like(record.get("clientDisconnected").unwrap_or(&Value::Null)) == Some(true)
}

pub fn plan_client_disconnect_watcher(
    input: &ServertoolClientDisconnectWatcherInput,
) -> ServertoolClientDisconnectWatcherPlan {
    let interval_ms = input
        .poll_interval_ms
        .as_ref()
        .and_then(read_positive_floor_number)
        .map(|value| value.max(20))
        .unwrap_or(80);
    ServertoolClientDisconnectWatcherPlan { interval_ms }
}

pub fn plan_servertool_client_disconnected_error(
    input: &ServertoolClientDisconnectedErrorInput,
) -> ServertoolErrorPlan {
    let flow_id = normalize_optional_string(input.flow_id.as_deref());
    let message = format!(
        "[servertool] client disconnected during followup{}",
        flow_id
            .as_ref()
            .map(|flow| format!(" flow={flow}"))
            .unwrap_or_default()
    );
    ServertoolErrorPlan {
        message,
        code: "SERVERTOOL_CLIENT_DISCONNECTED".to_string(),
        category: "INTERNAL_ERROR".to_string(),
        status: 499,
        details: details_with_request_flow(&input.request_id, flow_id),
    }
}

pub fn plan_servertool_timeout_error(
    input: &ServertoolTimeoutErrorInput,
) -> Result<ServertoolErrorPlan, String> {
    let phase = match input.phase.as_str() {
        "engine" | "followup" => input.phase.as_str(),
        _ => return Err("planServertoolTimeoutError: invalid phase".to_string()),
    };
    let timeout_ms = read_positive_floor_number(&input.timeout_ms)
        .ok_or_else(|| "planServertoolTimeoutError: invalid timeoutMs".to_string())?;
    let flow_id = normalize_optional_string(input.flow_id.as_deref());
    let mut details = details_with_request_flow(&input.request_id, flow_id.clone());
    let Value::Object(ref mut record) = details else {
        unreachable!("details builder returns object");
    };
    record.insert("phase".to_string(), Value::String(phase.to_string()));
    record.insert(
        "timeoutMs".to_string(),
        Value::Number(serde_json::Number::from(timeout_ms)),
    );
    if let Some(attempt) = input.attempt.as_ref().and_then(read_positive_floor_number) {
        record.insert(
            "attempt".to_string(),
            Value::Number(serde_json::Number::from(attempt)),
        );
    }
    if let Some(max_attempts) = input
        .max_attempts
        .as_ref()
        .and_then(read_positive_floor_number)
    {
        record.insert(
            "maxAttempts".to_string(),
            Value::Number(serde_json::Number::from(max_attempts)),
        );
    }
    let message = format!(
        "[servertool] {phase} timeout after {timeout_ms}ms{}",
        flow_id
            .as_ref()
            .map(|flow| format!(" flow={flow}"))
            .unwrap_or_default()
    );
    Ok(ServertoolErrorPlan {
        message,
        code: "SERVERTOOL_TIMEOUT".to_string(),
        category: "INTERNAL_ERROR".to_string(),
        status: 504,
        details,
    })
}

pub fn plan_stop_message_fetch_failed_error(
    input: &StopMessageFetchFailedErrorInput,
) -> Result<ServertoolErrorPlan, String> {
    if input.reason != "loop_limit" {
        return Err("planStopMessageFetchFailedError: invalid reason".to_string());
    }
    let mut record = serde_json::Map::new();
    record.insert(
        "requestId".to_string(),
        Value::String(input.request_id.trim().to_string()),
    );
    record.insert("reason".to_string(), Value::String(input.reason.clone()));
    insert_optional_floor(&mut record, "elapsedMs", input.elapsed_ms.as_ref(), 0);
    insert_optional_floor(&mut record, "repeatCount", input.repeat_count.as_ref(), 0);
    insert_optional_floor(&mut record, "attempt", input.attempt.as_ref(), 1);
    insert_optional_floor(&mut record, "maxAttempts", input.max_attempts.as_ref(), 1);
    Ok(ServertoolErrorPlan {
        message: "fetch failed: network error (stopMessage loop detected)".to_string(),
        code: "SERVERTOOL_TIMEOUT".to_string(),
        category: "EXTERNAL_ERROR".to_string(),
        status: 502,
        details: Value::Object(record),
    })
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

fn read_number_or_string(value: &Value) -> Option<f64> {
    match value {
        Value::String(text) => text.trim().parse::<f64>().ok(),
        Value::Number(number) => number.as_f64(),
        _ => None,
    }
}

fn read_positive_floor_number(value: &Value) -> Option<u64> {
    let value = read_number_or_string(value)?;
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    Some(value.floor() as u64)
}

fn read_floor_clamped_number(value: &Value, minimum: u64) -> Option<u64> {
    let value = read_number_or_string(value)?;
    if !value.is_finite() {
        return None;
    }
    let floored = value.floor();
    if floored < minimum as f64 {
        return Some(minimum);
    }
    Some(floored as u64)
}

fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    let text = value?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn details_with_request_flow(request_id: &str, flow_id: Option<String>) -> Value {
    let mut record = serde_json::Map::new();
    record.insert(
        "requestId".to_string(),
        Value::String(request_id.trim().to_string()),
    );
    if let Some(flow_id) = flow_id {
        record.insert("flowId".to_string(), Value::String(flow_id));
    }
    Value::Object(record)
}

fn insert_optional_floor(
    record: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<&Value>,
    minimum: u64,
) {
    let Some(raw) = value else {
        return;
    };
    let parsed = read_floor_clamped_number(raw, minimum);
    if let Some(parsed) = parsed {
        record.insert(
            key.to_string(),
            Value::Number(serde_json::Number::from(parsed)),
        );
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
    fn plans_timeout_watcher_and_disconnect_policy() {
        assert_eq!(
            plan_servertool_timeout_watcher(&ServertoolTimeoutWatcherInput {
                timeout_ms: Some(json!("20.8"))
            }),
            ServertoolTimeoutWatcherPlan {
                armed: true,
                timeout_ms: 20
            }
        );
        assert_eq!(
            plan_servertool_timeout_watcher(&ServertoolTimeoutWatcherInput {
                timeout_ms: Some(json!(0))
            }),
            ServertoolTimeoutWatcherPlan {
                armed: false,
                timeout_ms: 0
            }
        );
        assert!(is_adapter_client_disconnected(
            &json!({ "clientConnectionState": { "disconnected": " TRUE " } })
        ));
        assert!(is_adapter_client_disconnected(
            &json!({ "clientDisconnected": true })
        ));
        assert!(!is_adapter_client_disconnected(&json!({})));
        assert_eq!(
            plan_client_disconnect_watcher(&ServertoolClientDisconnectWatcherInput {
                poll_interval_ms: Some(json!(5.9))
            }),
            ServertoolClientDisconnectWatcherPlan { interval_ms: 20 }
        );
        assert_eq!(
            plan_client_disconnect_watcher(&ServertoolClientDisconnectWatcherInput {
                poll_interval_ms: None
            }),
            ServertoolClientDisconnectWatcherPlan { interval_ms: 80 }
        );
    }

    #[test]
    fn plans_servertool_error_payloads() {
        let disconnected =
            plan_servertool_client_disconnected_error(&ServertoolClientDisconnectedErrorInput {
                request_id: " req-1 ".to_string(),
                flow_id: Some(" flow-1 ".to_string()),
            });
        assert_eq!(disconnected.code, "SERVERTOOL_CLIENT_DISCONNECTED");
        assert_eq!(disconnected.status, 499);
        assert_eq!(
            disconnected.message,
            "[servertool] client disconnected during followup flow=flow-1"
        );
        assert_eq!(
            disconnected.details,
            json!({ "requestId": "req-1", "flowId": "flow-1" })
        );

        let timeout = plan_servertool_timeout_error(&ServertoolTimeoutErrorInput {
            request_id: "req-2".to_string(),
            phase: "followup".to_string(),
            timeout_ms: json!("1000.9"),
            flow_id: Some("web_search_flow".to_string()),
            attempt: Some(json!(2.2)),
            max_attempts: Some(json!("3.8")),
        })
        .unwrap();
        assert_eq!(timeout.status, 504);
        assert_eq!(
            timeout.message,
            "[servertool] followup timeout after 1000ms flow=web_search_flow"
        );
        assert_eq!(
            timeout.details,
            json!({
                "requestId": "req-2",
                "flowId": "web_search_flow",
                "phase": "followup",
                "timeoutMs": 1000,
                "attempt": 2,
                "maxAttempts": 3
            })
        );

        let fetch_failed =
            plan_stop_message_fetch_failed_error(&StopMessageFetchFailedErrorInput {
                request_id: "req-3".to_string(),
                reason: "loop_limit".to_string(),
                elapsed_ms: Some(json!(-5)),
                repeat_count: Some(json!(4.7)),
                attempt: Some(json!(0)),
                max_attempts: Some(json!("5.9")),
            })
            .unwrap();
        assert_eq!(fetch_failed.status, 502);
        assert_eq!(fetch_failed.category, "EXTERNAL_ERROR");
        assert_eq!(
            fetch_failed.details,
            json!({
                "requestId": "req-3",
                "reason": "loop_limit",
                "elapsedMs": 0,
                "repeatCount": 4,
                "attempt": 1,
                "maxAttempts": 5
            })
        );
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
