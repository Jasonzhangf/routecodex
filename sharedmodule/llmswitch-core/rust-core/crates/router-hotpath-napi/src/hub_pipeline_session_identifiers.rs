use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdentifiers {
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
}

const SESSION_FIELD_KEYS: [&str; 4] = [
    "sessionid",
    "session_id",
    "session-id",
    "anthropic-session-id",
];
const CONVERSATION_FIELD_KEYS: [&str; 5] = [
    "conversationid",
    "conversation_id",
    "conversation-id",
    "anthropic-conversation-id",
    "openai-conversation-id",
];
const SESSION_HEADER_KEYS: [&str; 4] = [
    "session_id",
    "session-id",
    "x-session-id",
    "anthropic-session-id",
];
const CONVERSATION_HEADER_KEYS: [&str; 5] = [
    "conversation_id",
    "conversation-id",
    "x-conversation-id",
    "anthropic-conversation-id",
    "openai-conversation-id",
];

fn normalize_identifier(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn normalize_header_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '_' && *ch != '-')
        .collect::<String>()
        .to_ascii_lowercase()
}

fn normalize_header_key_public(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '_' && *ch != '-')
        .collect::<String>()
}

fn coerce_client_headers_from_map(
    obj: Option<&Map<String, Value>>,
) -> Option<Vec<(String, String)>> {
    let obj = obj?;
    let mut out: Vec<(String, String)> = Vec::new();
    for (key, value) in obj {
        if let Some(raw_value) = value.as_str() {
            let trimmed = raw_value.trim();
            if !trimmed.is_empty() {
                out.push((key.clone(), trimmed.to_string()));
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn coerce_client_headers(raw: Option<&Value>) -> Option<Vec<(String, String)>> {
    coerce_client_headers_from_map(raw.and_then(|value| value.as_object()))
}

fn coerce_client_headers_public(raw: Option<&Value>) -> Option<Map<String, Value>> {
    let obj = raw?.as_object()?;
    let mut out = Map::<String, Value>::new();
    for (key, value) in obj {
        if let Some(raw_value) = value.as_str() {
            if !raw_value.trim().is_empty() {
                out.insert(key.clone(), Value::String(raw_value.to_string()));
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn find_header_value(headers: &[(String, String)], target: &str) -> Option<String> {
    let lowered = target.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return None;
    }
    let normalized_target = normalize_header_key(&lowered);
    for (key, value) in headers {
        let lowered_key = key.to_ascii_lowercase();
        if lowered_key == lowered {
            return Some(value.clone());
        }
        if normalize_header_key(&lowered_key) == normalized_target {
            return Some(value.clone());
        }
    }
    None
}

fn pick_header(headers: &[(String, String)], candidates: &[&str]) -> Option<String> {
    for candidate in candidates {
        if let Some(value) = find_header_value(headers, candidate) {
            return Some(value);
        }
    }
    None
}

fn find_identifier(source: &Value, preferred_keys: &[&str], regex: &Regex) -> Option<String> {
    match source {
        Value::Null => None,
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Some(captures) = regex.captures(trimmed) {
                if let Some(matched) = captures.get(1) {
                    let token = matched.as_str().trim();
                    if !token.is_empty() {
                        return Some(token.to_string());
                    }
                }
            }
            let looks_like_json = (trimmed.starts_with('{') && trimmed.ends_with('}'))
                || (trimmed.starts_with('[') && trimmed.ends_with(']'));
            if !looks_like_json {
                return None;
            }
            match serde_json::from_str::<Value>(trimmed) {
                Ok(parsed) => find_identifier(&parsed, preferred_keys, regex),
                Err(_) => None,
            }
        }
        Value::Array(items) => {
            for item in items {
                if let Some(found) = find_identifier(item, preferred_keys, regex) {
                    return Some(found);
                }
            }
            None
        }
        Value::Object(record) => {
            for (key, value) in record {
                let lowered = key.to_ascii_lowercase();
                if preferred_keys.contains(&lowered.as_str()) {
                    if let Some(found) = normalize_identifier(Some(value)) {
                        return Some(found);
                    }
                }
                if let Some(found) = find_identifier(value, preferred_keys, regex) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn extract_session_id_from_user_metadata(
    raw_record: &Map<String, Value>,
    session_regex: &Regex,
) -> Option<String> {
    let metadata = raw_record.get("metadata")?.as_object()?;
    let user_id = metadata.get("user_id")?.as_str()?;
    let trimmed = user_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    let captures = session_regex.captures(trimmed)?;
    let matched = captures.get(1)?;
    let token = matched.as_str().trim();
    if token.is_empty() {
        return None;
    }
    Some(token.to_string())
}

fn derive_identifiers_from_raw_payload(
    metadata: &Map<String, Value>,
    session_regex: &Regex,
    conversation_regex: &Regex,
) -> (Option<String>, Option<String>) {
    let raw = metadata.get("__raw_request_body");
    if raw.is_none() {
        return (None, None);
    }

    let mut targets: Vec<&Value> = Vec::new();
    let mut raw_user_metadata_session: Option<String> = None;
    if let Some(raw_value) = raw {
        targets.push(raw_value);
        if let Some(raw_record) = raw_value.as_object() {
            raw_user_metadata_session =
                extract_session_id_from_user_metadata(raw_record, session_regex);
            if let Some(metadata_node) = raw_record.get("metadata") {
                targets.push(metadata_node);
            }
            if let Some(raw_text) = raw_record.get("rawText") {
                targets.push(raw_text);
            }
            if let Some(events) = raw_record.get("events") {
                targets.push(events);
            }
        }
    }

    let mut session_id = raw_user_metadata_session.clone();
    let mut conversation_id = raw_user_metadata_session;

    for candidate in targets {
        if session_id.is_none() {
            session_id = find_identifier(candidate, &SESSION_FIELD_KEYS, session_regex);
        }
        if conversation_id.is_none() {
            conversation_id =
                find_identifier(candidate, &CONVERSATION_FIELD_KEYS, conversation_regex);
        }
        if session_id.is_some() && conversation_id.is_some() {
            break;
        }
    }

    if session_id.is_none() && conversation_id.is_some() {
        session_id = conversation_id.clone();
    } else if session_id.is_some() && conversation_id.is_none() {
        conversation_id = session_id.clone();
    }

    (session_id, conversation_id)
}

fn extract_session_identifiers_from_metadata(metadata: Option<&Value>) -> SessionIdentifiers {
    let Some(metadata_obj) = metadata.and_then(|value| value.as_object()) else {
        return SessionIdentifiers {
            session_id: None,
            conversation_id: None,
        };
    };

    let direct_session = normalize_identifier(metadata_obj.get("sessionId"));
    let direct_conversation = normalize_identifier(metadata_obj.get("conversationId"));
    let headers = coerce_client_headers(metadata_obj.get("clientHeaders"));

    let mut session_id = direct_session.clone();
    if session_id.is_none() {
        if let Some(header_values) = headers.as_ref() {
            session_id = pick_header(header_values, &SESSION_HEADER_KEYS);
        }
    }

    let mut conversation_id = direct_conversation.clone();
    if conversation_id.is_none() {
        if let Some(header_values) = headers.as_ref() {
            conversation_id = pick_header(header_values, &CONVERSATION_HEADER_KEYS);
        }
    }

    let session_regex =
        Regex::new(r"(?i)session[_:\-\s]?([0-9a-f]{8,}(?:-[0-9a-f]{4,}){0,5})").unwrap();
    let conversation_regex =
        Regex::new(r"(?i)conversation[_:\-\s]?([0-9a-f]{8,}(?:-[0-9a-f]{4,}){0,5})").unwrap();

    if session_id.is_none() || conversation_id.is_none() {
        let (fallback_session, fallback_conversation) =
            derive_identifiers_from_raw_payload(metadata_obj, &session_regex, &conversation_regex);
        if session_id.is_none() {
            session_id = fallback_session;
        }
        if conversation_id.is_none() {
            conversation_id = fallback_conversation.or_else(|| session_id.clone());
        }
    }

    SessionIdentifiers {
        session_id,
        conversation_id,
    }
}

#[napi]
pub fn extract_session_identifiers_json(metadata_json: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = extract_session_identifiers_from_metadata(Some(&metadata));
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output JSON: {}", e)))
}

#[napi]
pub fn coerce_client_headers_json(raw_json: String) -> NapiResult<String> {
    let raw: Value = serde_json::from_str(&raw_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse raw JSON: {}", e)))?;
    let output = coerce_client_headers_public(Some(&raw)).map(Value::Object);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output JSON: {}", e)))
}

#[napi]
pub fn find_header_value_json(headers_json: String, target: String) -> NapiResult<String> {
    let headers_value: Value = serde_json::from_str(&headers_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse headers JSON: {}", e)))?;
    let headers_obj = headers_value.as_object();
    let headers = coerce_client_headers_from_map(headers_obj);
    let output = headers
        .as_ref()
        .and_then(|rows| find_header_value(rows.as_slice(), target.as_str()));
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output JSON: {}", e)))
}

#[napi]
pub fn pick_header_json(headers_json: String, candidates_json: String) -> NapiResult<String> {
    let headers_value: Value = serde_json::from_str(&headers_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse headers JSON: {}", e)))?;
    let candidates_value: Value = serde_json::from_str(&candidates_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse candidates JSON: {}", e)))?;
    let headers_obj = headers_value.as_object();
    let headers = coerce_client_headers_from_map(headers_obj);
    let candidates: Vec<String> = match candidates_value.as_array() {
        Some(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(|s| s.to_string()))
            .collect(),
        None => Vec::new(),
    };
    let output = if candidates.is_empty() {
        None
    } else {
        headers.as_ref().and_then(|rows| {
            let refs: Vec<&str> = candidates.iter().map(|item| item.as_str()).collect();
            pick_header(rows.as_slice(), refs.as_slice())
        })
    };
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output JSON: {}", e)))
}

#[napi]
pub fn normalize_header_key_json(value: String) -> NapiResult<String> {
    let output = normalize_header_key_public(value.as_str());
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output JSON: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolves_direct_identifiers() {
        let metadata = json!({
          "sessionId": "session-123",
          "conversationId": "conv-456"
        });
        let result = extract_session_identifiers_from_metadata(Some(&metadata));
        assert_eq!(result.session_id.as_deref(), Some("session-123"));
        assert_eq!(result.conversation_id.as_deref(), Some("conv-456"));
    }

    #[test]
    fn resolves_from_headers() {
        let metadata = json!({
          "clientHeaders": {
            "x-session-id": "sess-a",
            "conversation_id": "conv-b"
          }
        });
        let result = extract_session_identifiers_from_metadata(Some(&metadata));
        assert_eq!(result.session_id.as_deref(), Some("sess-a"));
        assert_eq!(result.conversation_id.as_deref(), Some("conv-b"));
    }

    #[test]
    fn resolves_from_raw_payload_and_mirrors_missing_conversation() {
        let metadata = json!({
          "__raw_request_body": {
            "metadata": {
              "user_id": "prefix_session_019c7393-e244-7892-801a-d1b32c360af9_suffix"
            }
          }
        });
        let result = extract_session_identifiers_from_metadata(Some(&metadata));
        assert_eq!(
            result.session_id.as_deref(),
            Some("019c7393-e244-7892-801a-d1b32c360af9")
        );
        assert_eq!(
            result.conversation_id.as_deref(),
            Some("019c7393-e244-7892-801a-d1b32c360af9")
        );
    }

    #[test]
    fn normalize_header_key_public_removes_spaces_underscore_hyphen_only() {
        assert_eq!(normalize_header_key_public(" X-Session_Id "), "XSessionId");
    }

    #[test]
    fn coerce_client_headers_public_preserves_original_string_value() {
        let raw = json!({
          "x-session-id": "  sess-1  ",
          "x-empty": "   ",
          "x-number": 1
        });
        let result = coerce_client_headers_public(Some(&raw)).expect("headers");
        assert_eq!(
            result.get("x-session-id").and_then(|v| v.as_str()),
            Some("  sess-1  ")
        );
        assert!(result.get("x-empty").is_none());
        assert!(result.get("x-number").is_none());
    }
}
