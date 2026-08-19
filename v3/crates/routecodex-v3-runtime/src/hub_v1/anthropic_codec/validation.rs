use super::{
    V3AnthropicCodecError, V3AnthropicCodecStage, V3AnthropicCodecTrace, V3HubEntryProtocol,
    V3HubProviderWireProtocol, V3HubTransportIntent, CLAUDE_CODE_SYSTEM_PROMPT_MD,
};
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

pub(super) fn claude_code_system_prompt_for_model(model: &str) -> Option<Value> {
    if !model.trim().starts_with("claude-") {
        return None;
    }
    Some(Value::Array(claude_code_system_prompt_blocks().to_vec()))
}

fn claude_code_system_prompt_blocks() -> &'static [Value] {
    static BLOCKS: OnceLock<Vec<Value>> = OnceLock::new();
    BLOCKS
        .get_or_init(|| {
            parse_claude_code_system_prompt_blocks(CLAUDE_CODE_SYSTEM_PROMPT_MD)
                .expect("Claude Code Anthropic system prompt markdown must parse")
        })
        .as_slice()
}

fn parse_claude_code_system_prompt_blocks(content: &str) -> Result<Vec<Value>, String> {
    let mut blocks = Vec::new();
    let mut lines = content.lines();
    while let Some(line) = lines.next() {
        let marker = line.trim();
        let Some(marker_tail) = marker.strip_prefix("<!-- routecodex-system-block:") else {
            continue;
        };
        if !marker_tail.ends_with("-->") {
            return Err("system block marker is unterminated".to_string());
        }
        let cache_control_ephemeral = marker_tail.contains("cache_control=ephemeral");
        let mut text_lines = Vec::new();
        loop {
            let Some(next_line) = lines.next() else {
                return Err("system block is missing closing marker".to_string());
            };
            if next_line.trim() == "<!-- /routecodex-system-block -->" {
                break;
            }
            text_lines.push(next_line);
        }
        let text = text_lines.join("\n");
        let mut entry = Map::new();
        entry.insert("type".to_string(), Value::String("text".to_string()));
        entry.insert("text".to_string(), Value::String(text));
        if cache_control_ephemeral {
            entry.insert("cache_control".to_string(), json!({"type":"ephemeral"}));
        }
        blocks.push(Value::Object(entry));
    }
    if blocks.is_empty() {
        return Err("no routecodex-system-block entries found".to_string());
    }
    Ok(blocks)
}

pub(super) fn require_nonempty_reasoning_string(
    value: Option<&Value>,
) -> Result<&str, V3AnthropicCodecError> {
    let value = value
        .and_then(Value::as_str)
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "reasoning content",
        })?;
    if value.trim().is_empty() {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "reasoning content",
        });
    }
    Ok(value)
}

pub(super) fn optional_nonempty_reasoning_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, V3AnthropicCodecError> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    Ok(Some(require_nonempty_reasoning_string(Some(value))?))
}

pub(super) fn validate_anthropic_reasoning_object_keys(
    object: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(), V3AnthropicCodecError> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "reasoning content",
        });
    }
    Ok(())
}

pub(super) fn anthropic_reasoning_part_as_responses_reasoning(
    part: &Value,
    summary_policy: Option<&str>,
) -> Result<Value, V3AnthropicCodecError> {
    let object = part
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "reasoning content",
        })?;
    match object.get("type").and_then(Value::as_str) {
        Some("thinking") => {
            validate_anthropic_reasoning_object_keys(object, &["type", "thinking", "signature"])?;
            let thinking = require_nonempty_reasoning_string(object.get("thinking"))?;
            let summary_text = match summary_policy {
                None | Some("auto" | "concise" | "detailed") => thinking,
                Some(_) => {
                    return Err(V3AnthropicCodecError::MalformedField {
                        field: "reasoning_summary_policy",
                    })
                }
            };
            let mut item = json!({
                "type":"reasoning",
                "summary":[{"type":"summary_text","text":summary_text}]
            });
            if let Some(signature) = optional_nonempty_reasoning_string(object, "signature")? {
                item["encrypted_content"] = Value::String(signature.to_string());
            }
            Ok(item)
        }
        Some("redacted_thinking") => {
            validate_anthropic_reasoning_object_keys(object, &["type", "data"])?;
            let data = require_nonempty_reasoning_string(object.get("data"))?;
            Ok(json!({
                "type":"reasoning",
                "encrypted_content":data
            }))
        }
        _ => Err(V3AnthropicCodecError::MalformedField {
            field: "reasoning content",
        }),
    }
}

pub(super) fn trace(
    stage: V3AnthropicCodecStage,
    transport_intent: V3HubTransportIntent,
) -> V3AnthropicCodecTrace {
    V3AnthropicCodecTrace {
        stage,
        entry_protocol: V3HubEntryProtocol::Anthropic,
        provider_protocol: V3HubProviderWireProtocol::Anthropic,
        transport_intent,
    }
}

pub(super) fn require_object(value: &Value) -> Result<&Map<String, Value>, V3AnthropicCodecError> {
    value
        .as_object()
        .ok_or(V3AnthropicCodecError::PayloadNotObject)
}

pub(super) fn require_messages_array(value: &Value) -> Result<(), V3AnthropicCodecError> {
    match value.get("messages") {
        Some(Value::Array(_)) => Ok(()),
        _ => Err(V3AnthropicCodecError::MessagesNotArray),
    }
}

pub(super) fn require_content_array(value: &Value) -> Result<(), V3AnthropicCodecError> {
    match value.get("content") {
        Some(Value::Array(_)) => Ok(()),
        _ => Err(V3AnthropicCodecError::ContentNotArray),
    }
}

pub(super) fn validate_json_response(value: &Value) -> Result<(), V3AnthropicCodecError> {
    if value.get("error").is_some() {
        validate_provider_error(value)
    } else {
        require_content_array(value)
    }
}

pub(super) fn validate_sse_event(value: &Value) -> Result<(), V3AnthropicCodecError> {
    let object = require_object(value)?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or(V3AnthropicCodecError::MalformedSseEvent)?;
    match kind {
        "message_start"
        | "content_block_start"
        | "content_block_delta"
        | "content_block_stop"
        | "message_delta"
        | "message_stop"
        | "ping" => Ok(()),
        "error" => validate_provider_error(value),
        _ => Err(V3AnthropicCodecError::MalformedSseEvent),
    }
}

fn validate_provider_error(value: &Value) -> Result<(), V3AnthropicCodecError> {
    let Some(error) = value.get("error").and_then(Value::as_object) else {
        return Err(V3AnthropicCodecError::MalformedProviderError);
    };
    let has_type = error
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|item| !item.is_empty());
    let has_message = error
        .get("message")
        .and_then(Value::as_str)
        .is_some_and(|item| !item.is_empty());
    if has_type && has_message {
        Ok(())
    } else {
        Err(V3AnthropicCodecError::MalformedProviderError)
    }
}

pub(super) fn into_object(value: Value) -> Result<Map<String, Value>, V3AnthropicCodecError> {
    match value {
        Value::Object(object) => Ok(object),
        _ => Err(V3AnthropicCodecError::PayloadNotObject),
    }
}

pub(super) fn reject_side_channel_fields(value: &Value) -> Result<(), V3AnthropicCodecError> {
    let object = require_object(value)?;
    reject_side_channel_object_keys(object)
}

pub(super) fn reject_side_channel_object_keys(
    object: &Map<String, Value>,
) -> Result<(), V3AnthropicCodecError> {
    for key in object.keys() {
        if is_internal_side_channel_field(key) {
            return Err(V3AnthropicCodecError::SideChannelLeaked {
                field: side_channel_label(key),
            });
        }
    }
    Ok(())
}

fn is_internal_side_channel_field(key: &str) -> bool {
    matches!(
        key,
        "routecodex_internal"
            | "metadata_center"
            | "debug_snapshot"
            | "provider_protocol"
            | "resource_handle"
    )
}

fn side_channel_label(key: &str) -> &'static str {
    match key {
        "routecodex_internal" => "routecodex_internal",
        "metadata_center" => "metadata_center",
        "debug_snapshot" => "debug_snapshot",
        "provider_protocol" => "provider_protocol",
        "resource_handle" => "resource_handle",
        _ => "unknown",
    }
}
