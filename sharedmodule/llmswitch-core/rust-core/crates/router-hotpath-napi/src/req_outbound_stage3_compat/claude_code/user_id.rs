use napi::bindgen_prelude::Result as NapiResult;
use regex::Regex;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::super::AdapterContext;

const DEFAULT_USER_ID_ENV: &str = "ROUTECODEX_CLAUDE_CODE_USER_ID";
const DEFAULT_ACCOUNT_SEED_ENV: &str = "ROUTECODEX_CLAUDE_CODE_ACCOUNT_SEED";

pub(super) fn read_non_empty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .map(|raw| raw.trim())
        .filter(|trimmed| !trimmed.is_empty())
        .map(|trimmed| trimmed.to_string())
}

fn read_env_trimmed(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
}

pub(super) fn is_claude_code_user_id(value: Option<&str>) -> bool {
    let Some(raw) = value else {
        return false;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    Regex::new(r"^user_[0-9a-f]{64}_account__session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .map(|re| re.is_match(&trimmed.to_ascii_lowercase()))
        .unwrap_or(false)
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn format_uuid_from_hex32(hex32: &str) -> String {
    let hex = hex32.to_ascii_lowercase();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn uuid_from_seed(seed: &str) -> String {
    let hex = sha256_hex(seed);
    let mut chars = hex.chars().take(32).collect::<Vec<char>>();
    if chars.len() == 32 {
        chars[12] = '4';
        chars[16] = '8';
    }
    format_uuid_from_hex32(&chars.into_iter().collect::<String>())
}

fn normalize_session_uuid(candidate: Option<&str>) -> Option<String> {
    let raw = candidate
        .map(|value| value.trim())
        .filter(|trimmed| !trimmed.is_empty())?;

    let session_re = Regex::new(r"session[_:\-\s]?([0-9a-f]{8,}(?:-[0-9a-f]{4,}){0,5})").ok();
    let raw_lower = raw.to_ascii_lowercase();
    let extracted = session_re
        .and_then(|re| re.captures(&raw_lower))
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        .unwrap_or_else(|| raw.to_string());
    let trimmed = extracted.trim().to_string();
    if trimmed.is_empty() {
        return None;
    }

    let uuid_re =
        Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").ok();
    if uuid_re
        .as_ref()
        .map(|re| re.is_match(&trimmed.to_ascii_lowercase()))
        .unwrap_or(false)
    {
        return Some(trimmed.to_ascii_lowercase());
    }

    let compact = trimmed.replace('-', "");
    let hex32_re = Regex::new(r"^[0-9a-f]{32}$").ok();
    if hex32_re
        .as_ref()
        .map(|re| re.is_match(&compact.to_ascii_lowercase()))
        .unwrap_or(false)
    {
        return Some(format_uuid_from_hex32(&compact));
    }
    Some(uuid_from_seed(&trimmed))
}

fn read_string_field(map: &Map<String, Value>, key: &str) -> Option<String> {
    read_non_empty_str(map.get(key))
}

pub(super) fn resolve_claude_code_user_id(
    metadata: &Map<String, Value>,
    adapter_context: &AdapterContext,
) -> Option<String> {
    let existing = read_string_field(metadata, "user_id");
    if is_claude_code_user_id(existing.as_deref()) {
        return existing;
    }

    let env_user_id = read_env_trimmed(DEFAULT_USER_ID_ENV);
    if is_claude_code_user_id(env_user_id.as_deref()) {
        return env_user_id;
    }

    let client_headers = metadata
        .get("clientHeaders")
        .and_then(|value| value.as_object());
    let session_uuid = normalize_session_uuid(existing.as_deref())
        .or_else(|| normalize_session_uuid(env_user_id.as_deref()))
        .or_else(|| {
            client_headers
                .and_then(|headers| read_non_empty_str(headers.get("session_id")))
                .and_then(|value| normalize_session_uuid(Some(&value)))
        })
        .or_else(|| {
            client_headers
                .and_then(|headers| read_non_empty_str(headers.get("anthropic-session-id")))
                .and_then(|value| normalize_session_uuid(Some(&value)))
        })
        .or_else(|| {
            client_headers
                .and_then(|headers| read_non_empty_str(headers.get("x-session-id")))
                .and_then(|value| normalize_session_uuid(Some(&value)))
        })
        .or_else(|| {
            client_headers
                .and_then(|headers| read_non_empty_str(headers.get("conversation_id")))
                .and_then(|value| normalize_session_uuid(Some(&value)))
        })
        .or_else(|| {
            client_headers
                .and_then(|headers| read_non_empty_str(headers.get("anthropic-conversation-id")))
                .and_then(|value| normalize_session_uuid(Some(&value)))
        })
        .or_else(|| {
            client_headers
                .and_then(|headers| read_non_empty_str(headers.get("openai-conversation-id")))
                .and_then(|value| normalize_session_uuid(Some(&value)))
        })
        .or_else(|| {
            read_string_field(metadata, "sessionId")
                .and_then(|value| normalize_session_uuid(Some(&value)))
        })
        .or_else(|| {
            read_string_field(metadata, "conversationId")
                .and_then(|value| normalize_session_uuid(Some(&value)))
        })
        .or_else(|| {
            adapter_context
                .session_id
                .as_ref()
                .and_then(|value| normalize_session_uuid(Some(value)))
        })
        .or_else(|| {
            adapter_context
                .conversation_id
                .as_ref()
                .and_then(|value| normalize_session_uuid(Some(value)))
        });

    let account_seed = read_env_trimmed(DEFAULT_ACCOUNT_SEED_ENV)
        .or_else(|| read_env_trimmed("USER"))
        .unwrap_or_else(|| "routecodex".to_string());
    let account_hash = sha256_hex(&account_seed);
    let session = session_uuid.unwrap_or_else(|| Uuid::new_v4().to_string().to_ascii_lowercase());
    Some(format!(
        "user_{}_account__session_{}",
        account_hash, session
    ))
}

pub(crate) fn apply_anthropic_claude_code_user_id(
    root: &mut Map<String, Value>,
    adapter_context: &AdapterContext,
) {
    if !root
        .get("metadata")
        .and_then(|value| value.as_object())
        .is_some()
    {
        root.insert("metadata".to_string(), Value::Object(Map::new()));
    }
    if let Some(metadata) = root
        .get_mut("metadata")
        .and_then(|value| value.as_object_mut())
    {
        let current = read_non_empty_str(metadata.get("user_id"));
        if !is_claude_code_user_id(current.as_deref()) {
            if let Some(user_id) = resolve_claude_code_user_id(metadata, adapter_context) {
                metadata.insert("user_id".to_string(), Value::String(user_id));
            }
        }
    }
}

pub(crate) fn apply_anthropic_claude_code_user_id_json(
    payload_json: String,
    adapter_context_json: Option<String>,
) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let adapter_context: AdapterContext = match adapter_context_json {
        Some(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(&raw).map_err(|e| napi::Error::from_reason(e.to_string()))?
        }
        _ => AdapterContext {
            compatibility_profile: None,
            provider_protocol: None,
            request_id: None,
            entry_endpoint: None,
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
    };

    if let Some(root) = payload.as_object_mut() {
        apply_anthropic_claude_code_user_id(root, &adapter_context);
    }

    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn empty_adapter_context() -> AdapterContext {
        AdapterContext {
            compatibility_profile: None,
            provider_protocol: None,
            request_id: None,
            entry_endpoint: None,
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        }
    }

    #[test]
    fn apply_user_id_uses_client_headers_session_without_touching_other_fields() {
        let mut root = json!({
            "model": "glm-4.7",
            "temperature": 0.2,
            "metadata": {
                "clientHeaders": {
                    "session_id": "sid_test_123"
                },
                "trace": "keep"
            }
        })
        .as_object()
        .cloned()
        .unwrap();

        apply_anthropic_claude_code_user_id(&mut root, &empty_adapter_context());

        assert_eq!(root.get("temperature"), Some(&json!(0.2)));
        assert_eq!(
            root.get("metadata").and_then(|v| v.get("trace")),
            Some(&json!("keep"))
        );
        let user_id = root
            .get("metadata")
            .and_then(|v| v.get("user_id"))
            .and_then(|v| v.as_str());
        assert!(is_claude_code_user_id(user_id));
    }

    #[test]
    fn apply_user_id_preserves_existing_valid_user_id() {
        let existing = format!(
            "user_{}_account__session_123e4567-e89b-42d3-a456-426614174000",
            "a".repeat(64)
        );
        let mut root = json!({
            "metadata": {
                "user_id": existing,
                "clientHeaders": {
                    "session_id": "sid_should_not_override"
                }
            }
        })
        .as_object()
        .cloned()
        .unwrap();

        apply_anthropic_claude_code_user_id(&mut root, &empty_adapter_context());

        assert_eq!(
            root.get("metadata")
                .and_then(|v| v.get("user_id"))
                .and_then(|v| v.as_str()),
            Some(existing.as_str())
        );
    }
}
