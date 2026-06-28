//! Provider Response Shared Pure Blocks — Rust migration batch #3.
//!
//! Pure data-transformation functions migrated from
//! `src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.ts`.
//!
//! All functions are deterministic, no I/O, no external state.

use serde_json::Value;

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/// Safely coerce any value to `Record<string, unknown> | undefined`.
/// Mirrors TS `asFlatRecord`.
pub fn as_flat_record(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Trim a string value, returning None if empty.
/// Mirrors TS `readSessionLikeToken`.
pub fn read_session_like_token(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// JSON parsing helpers
// ---------------------------------------------------------------------------

/// Extract the first balanced JSON object `{...}` from a raw string.
/// Mirrors TS `extractFirstBalancedJsonObject`.
pub fn extract_first_balanced_json_object(raw: &str) -> Option<String> {
    let start = raw.find('{')?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaping = false;

    for (i, ch) in raw[start..].char_indices() {
        let abs_i = start + i;
        if in_string {
            if escaping {
                escaping = false;
                continue;
            }
            if ch == '\\' {
                escaping = true;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(raw[start..=abs_i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Try to parse a string as JSON, falling back to extracting balanced object.
/// Mirrors TS `tryParseJsonLikeString`.
pub fn try_parse_json_like_string(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Quick heuristic: must look like JSON
    let starts_with_brace_or_bracket = trimmed.starts_with('{') || trimmed.starts_with('[');
    let contains_json = trimmed.contains("{\"") || trimmed.contains("{'");
    if !starts_with_brace_or_bracket && !contains_json {
        return None;
    }

    // Try direct parse first
    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
        return Some(val);
    }

    // Fall back to balanced object extraction
    extract_first_balanced_json_object(trimmed)
        .and_then(|balanced| serde_json::from_str(&balanced).ok())
}

// ---------------------------------------------------------------------------
// Stopless / request scanning
// ---------------------------------------------------------------------------

/// Extract text content from a message content field that could be a string or array of parts.
/// Mirrors TS `extractContentTextForStoplessScan`.
pub fn extract_content_text_for_stopless_scan(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(arr) => {
            let mut parts = Vec::new();
            for item in arr {
                match item {
                    Value::String(s) => parts.push(s.clone()),
                    Value::Object(map) => {
                        if let Some(Value::String(text)) = map.get("text") {
                            parts.push(text.clone());
                        }
                    }
                    _ => {}
                }
            }
            parts.join("\n")
        }
        _ => String::new(),
    }
}

/// Extract the latest user text from a request payload (chat messages or responses input).
/// Mirrors TS `extractLatestUserTextForStoplessScan`.
pub fn extract_latest_user_text_for_stopless_scan(source: &Value) -> String {
    let obj = match as_flat_record(source) {
        Some(m) => m,
        None => return String::new(),
    };

    let rows: Vec<&Value> = if let Some(Value::Array(arr)) = obj.get("messages") {
        arr.iter().collect()
    } else if let Some(Value::Array(arr)) = obj.get("input") {
        arr.iter().collect()
    } else {
        return String::new();
    };

    for row in rows.iter().rev() {
        let row_map = match as_flat_record(row) {
            Some(m) => m,
            None => continue,
        };
        let role = row_map
            .get("role")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_lowercase())
            .unwrap_or_default();
        if role != "user" {
            continue;
        }
        let content = row_map
            .get("content")
            .map(|v| extract_content_text_for_stopless_scan(v));
        if let Some(text) = content {
            let trimmed = text.trim().to_string();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
    }
    String::new()
}

/// Check whether a request payload contains a stopless directive in the latest user message.
/// Mirrors TS `hasStoplessDirectiveInRequestPayload`.
pub fn has_stopless_directive_in_request_payload(source: &Value) -> bool {
    let text = extract_latest_user_text_for_stopless_scan(source);
    // Pattern: <**stopless:*>
    text.contains("<**stopless:") && text.contains("**>")
}

// ---------------------------------------------------------------------------
// Nested payload traversal
// ---------------------------------------------------------------------------

/// Recursively find the first non-empty string in a nested payload hierarchy.
/// Mirrors TS `findNestedRawString`.
pub fn find_nested_raw_string(payload: &Value, depth: i32) -> String {
    if depth < 0 || payload.is_null() {
        return String::new();
    }
    match payload {
        Value::String(s) => s.clone(),
        Value::Object(map) => {
            // Check direct "raw" field first
            if let Some(Value::String(raw)) = map.get("raw") {
                if !raw.is_empty() {
                    return raw.clone();
                }
            }
            // Descend into known keys
            for key in &["body", "data", "payload", "response", "error"] {
                if let Some(nested) = map.get(*key) {
                    let result = find_nested_raw_string(nested, depth - 1);
                    if !result.is_empty() {
                        return result;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

/// Recursively find the first non-empty error string in a nested payload hierarchy.
/// Mirrors TS `findNestedErrorMarker`.
pub fn find_nested_error_marker(payload: &Value, depth: i32) -> String {
    if depth < 0 || payload.is_null() {
        return String::new();
    }
    match payload {
        Value::String(s) => s.clone(),
        Value::Object(map) => {
            // Check direct "error" field first
            if let Some(Value::String(err)) = map.get("error") {
                let trimmed = err.trim().to_string();
                if !trimmed.is_empty() {
                    return trimmed;
                }
            }
            // Descend into known keys
            for key in &["body", "data", "payload", "response"] {
                if let Some(nested) = map.get(*key) {
                    let result = find_nested_error_marker(nested, depth - 1);
                    if !result.is_empty() {
                        return result;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Payload extraction
// ---------------------------------------------------------------------------

/// Extract the payload from a provider bridge response body.
/// Mirrors TS `extractBridgeProviderResponsePayload`.
pub fn extract_bridge_provider_response_payload(body: &Value) -> Option<Value> {
    let body_map = match body {
        Value::Object(m) => m,
        _ => return None,
    };

    // Prefer body.payload
    if let Some(payload) = body_map.get("payload") {
        if payload.is_object() {
            return Some(payload.clone());
        }
    }

    // body.body → body.body.data → body.body
    if let Some(nested_body) = body_map.get("body").and_then(|v| v.as_object()) {
        if let Some(data) = nested_body.get("data").and_then(|v| v.as_object()) {
            return Some(Value::Object(data.clone()));
        }
        return Some(Value::Object(nested_body.clone()));
    }

    // body.data
    if let Some(data) = body_map.get("data").and_then(|v| v.as_object()) {
        return Some(Value::Object(data.clone()));
    }

    None
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // -- as_flat_record --

    #[test]
    fn flat_record_from_object() {
        let v = json!({"key": "val"});
        assert!(as_flat_record(&v).is_some());
    }

    #[test]
    fn flat_record_null() {
        assert!(as_flat_record(&Value::Null).is_none());
    }

    #[test]
    fn flat_record_array() {
        assert!(as_flat_record(&json!([1, 2, 3])).is_none());
    }

    // -- read_session_like_token --

    #[test]
    fn session_token_trimmed() {
        assert_eq!(
            read_session_like_token(&json!("  abc  ")),
            Some("abc".to_string())
        );
    }

    #[test]
    fn session_token_empty() {
        assert_eq!(read_session_like_token(&json!("  ")), None);
    }

    #[test]
    fn session_token_non_string() {
        assert_eq!(read_session_like_token(&json!(123)), None);
    }

    // -- extract_first_balanced_json_object --

    #[test]
    fn extract_balanced_simple() {
        let result = extract_first_balanced_json_object(r#"prefix {"a":1} suffix"#);
        assert_eq!(result, Some(r#"{"a":1}"#.to_string()));
    }

    #[test]
    fn extract_balanced_nested() {
        let result = extract_first_balanced_json_object(r#"{"a":{"b":2}}"#);
        assert_eq!(result, Some(r#"{"a":{"b":2}}"#.to_string()));
    }

    #[test]
    fn extract_balanced_no_brace() {
        assert_eq!(extract_first_balanced_json_object("no braces"), None);
    }

    #[test]
    fn extract_balanced_with_escaped_string() {
        let result = extract_first_balanced_json_object(r#"{"msg":"hello \"world\""}"#);
        assert!(result.is_some());
        assert!(result.unwrap().contains("hello"));
    }

    // -- try_parse_json_like_string --

    #[test]
    fn parse_valid_json() {
        let result = try_parse_json_like_string(r#"{"a":1}"#);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), json!({"a":1}));
    }

    #[test]
    fn parse_extract_balanced() {
        // Wrap in extra text
        let result = try_parse_json_like_string(r#"prefix {"a":1} suffix"#);
        assert!(result.is_some());
    }

    #[test]
    fn parse_non_json() {
        assert!(try_parse_json_like_string("just text").is_none());
    }

    // -- extract_content_text_for_stopless_scan --

    #[test]
    fn content_from_string() {
        assert_eq!(
            extract_content_text_for_stopless_scan(&json!("hello")),
            "hello"
        );
    }

    #[test]
    fn content_from_array() {
        let v = json!([{"text":"hello"}, {"text":"world"}]);
        assert_eq!(extract_content_text_for_stopless_scan(&v), "hello\nworld");
    }

    #[test]
    fn content_from_empty() {
        assert_eq!(extract_content_text_for_stopless_scan(&json!(null)), "");
    }

    // -- extract_latest_user_text_for_stopless_scan --

    #[test]
    fn latest_user_from_messages() {
        let v = json!({
            "messages": [
                {"role": "system", "content": "system msg"},
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "answer"},
                {"role": "user", "content": "last user"}
            ]
        });
        assert_eq!(extract_latest_user_text_for_stopless_scan(&v), "last user");
    }

    #[test]
    fn latest_user_from_input() {
        let v = json!({
            "input": [
                {"role": "user", "content": "from input"}
            ]
        });
        assert_eq!(extract_latest_user_text_for_stopless_scan(&v), "from input");
    }

    #[test]
    fn latest_user_no_messages() {
        assert_eq!(extract_latest_user_text_for_stopless_scan(&json!({})), "");
    }

    // -- has_stopless_directive_in_request_payload --

    #[test]
    fn stopless_directive_found() {
        let v = json!({
            "messages": [
                {"role": "user", "content": "<**stopless:continue**>"}
            ]
        });
        assert!(has_stopless_directive_in_request_payload(&v));
    }

    #[test]
    fn stopless_directive_not_found() {
        let v = json!({
            "messages": [
                {"role": "user", "content": "normal query"}
            ]
        });
        assert!(!has_stopless_directive_in_request_payload(&v));
    }

    // -- find_nested_raw_string --

    #[test]
    fn nested_raw_direct() {
        let v = json!({"raw": "direct raw"});
        assert_eq!(find_nested_raw_string(&v, 3), "direct raw");
    }

    #[test]
    fn nested_raw_body() {
        let v = json!({"body": {"raw": "body raw"}});
        assert_eq!(find_nested_raw_string(&v, 3), "body raw");
    }

    #[test]
    fn nested_raw_empty() {
        assert_eq!(find_nested_raw_string(&json!({}), 3), "");
    }

    // -- find_nested_error_marker --

    #[test]
    fn error_marker_direct() {
        let v = json!({"error": "direct error"});
        assert_eq!(find_nested_error_marker(&v, 3), "direct error");
    }

    #[test]
    fn error_marker_nested() {
        let v = json!({"body": {"error": "nested error"}});
        assert_eq!(find_nested_error_marker(&v, 3), "nested error");
    }

    #[test]
    fn error_marker_empty() {
        assert_eq!(find_nested_error_marker(&json!({}), 3), "");
    }

    // -- extract_bridge_provider_response_payload --

    #[test]
    fn payload_from_payload_field() {
        let v = json!({"payload": {"result": "ok"}});
        let result = extract_bridge_provider_response_payload(&v);
        assert_eq!(result, Some(json!({"result": "ok"})));
    }

    #[test]
    fn payload_from_body() {
        let v = json!({"body": {"nested": "data"}});
        let result = extract_bridge_provider_response_payload(&v);
        assert_eq!(result, Some(json!({"nested": "data"})));
    }

    #[test]
    fn payload_from_body_data() {
        let v = json!({"body": {"data": {"actual": "payload"}}});
        let result = extract_bridge_provider_response_payload(&v);
        assert_eq!(result, Some(json!({"actual": "payload"})));
    }

    #[test]
    fn payload_from_root_data() {
        let v = json!({"data": {"root": "data"}});
        let result = extract_bridge_provider_response_payload(&v);
        assert_eq!(result, Some(json!({"root": "data"})));
    }

    #[test]
    fn payload_not_found() {
        assert_eq!(
            extract_bridge_provider_response_payload(&json!("string")),
            None
        );
    }
}
