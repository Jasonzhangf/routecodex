use super::{V3AnthropicCodecError, ANTHROPIC_REASONING_EXTENSION};
use crate::protocol_tables::{map_value as table_map_value, V3TableDirection, V3TableKind};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum V3AnthropicResponseContentBlockKind {
    Text,
    Thinking,
    RedactedThinking,
    ToolUse,
    ServerToolUse,
    WebSearchToolResult,
    WebFetchToolResult,
    CodeExecutionToolResult,
    BashCodeExecutionToolResult,
    TextEditorCodeExecutionToolResult,
    ToolSearchToolResult,
    ContainerUpload,
    Unknown,
}

impl V3AnthropicResponseContentBlockKind {
    pub(super) fn parse(part: &Value, index: usize) -> Result<Self, V3AnthropicCodecError> {
        let content_type = part
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(V3AnthropicCodecError::MalformedResponseContentBlockType { index })?;
        match content_type {
            "text" => Ok(Self::Text),
            "thinking" => Ok(Self::Thinking),
            "redacted_thinking" => Ok(Self::RedactedThinking),
            "tool_use" => Ok(Self::ToolUse),
            "server_tool_use" => Ok(Self::ServerToolUse),
            "web_search_tool_result" => Ok(Self::WebSearchToolResult),
            "web_fetch_tool_result" => Ok(Self::WebFetchToolResult),
            "code_execution_tool_result" => Ok(Self::CodeExecutionToolResult),
            "bash_code_execution_tool_result" => Ok(Self::BashCodeExecutionToolResult),
            "text_editor_code_execution_tool_result" => Ok(Self::TextEditorCodeExecutionToolResult),
            "tool_search_tool_result" => Ok(Self::ToolSearchToolResult),
            "container_upload" => Ok(Self::ContainerUpload),
            other => {
                eprintln!(
                    "[v3-response-warning] protocol=anthropic stage=response_content_block index={index} content_type={other:?} reason=unknown_block_ignored"
                );
                Ok(Self::Unknown)
            }
        }
    }

    pub(super) fn source_type(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Thinking => "thinking",
            Self::RedactedThinking => "redacted_thinking",
            Self::ToolUse => "tool_use",
            Self::ServerToolUse => "server_tool_use",
            Self::WebSearchToolResult => "web_search_tool_result",
            Self::WebFetchToolResult => "web_fetch_tool_result",
            Self::CodeExecutionToolResult => "code_execution_tool_result",
            Self::BashCodeExecutionToolResult => "bash_code_execution_tool_result",
            Self::TextEditorCodeExecutionToolResult => "text_editor_code_execution_tool_result",
            Self::ToolSearchToolResult => "tool_search_tool_result",
            Self::ContainerUpload => "container_upload",
            Self::Unknown => "unknown",
        }
    }

    pub(super) fn is_source_roundtrip_only(self) -> bool {
        matches!(
            self,
            Self::WebFetchToolResult
                | Self::CodeExecutionToolResult
                | Self::BashCodeExecutionToolResult
                | Self::TextEditorCodeExecutionToolResult
                | Self::ToolSearchToolResult
                | Self::ContainerUpload
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum V3AnthropicTerminalKind {
    EndTurn,
    ToolUse,
    MaxTokens,
    StopSequence,
    PauseTurn,
    Refusal,
    ContextWindowExceeded,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct V3AnthropicResponsesTerminalProjection {
    pub(super) kind: V3AnthropicTerminalKind,
    pub(super) responses_status: &'static str,
    pub(super) incomplete_reason: Option<&'static str>,
    pub(super) stop_sequence: Option<String>,
    pub(super) stop_details: Option<Value>,
}

pub(super) fn project_v3_anthropic_terminal_as_responses_terminal(
    object: &Map<String, Value>,
) -> Result<V3AnthropicResponsesTerminalProjection, V3AnthropicCodecError> {
    let stop_reason = object
        .get("stop_reason")
        .ok_or_else(|| V3AnthropicCodecError::InvalidTerminalField {
            field: "stop_reason",
            reason: "missing on materialized final message".to_string(),
        })?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| V3AnthropicCodecError::InvalidTerminalField {
            field: "stop_reason",
            reason: "must be a non-empty string on materialized final message".to_string(),
        })?;
    let hub_reason = table_map_value(
        V3TableKind::FinishReason,
        "anthropic",
        stop_reason,
        V3TableDirection::Inbound,
    )
    .map_err(|error| V3AnthropicCodecError::InvalidTerminalField {
        field: "stop_reason",
        reason: format!("finish_reason_map failed: {error}"),
    })?;

    let kind = match hub_reason {
        Some("stop") => V3AnthropicTerminalKind::EndTurn,
        Some("tool_calls") => V3AnthropicTerminalKind::ToolUse,
        Some("max_tokens") => V3AnthropicTerminalKind::MaxTokens,
        Some("stop_sequence") => V3AnthropicTerminalKind::StopSequence,
        Some("pause_turn") => V3AnthropicTerminalKind::PauseTurn,
        Some("content_filter") => V3AnthropicTerminalKind::Refusal,
        Some("context_window_exceeded") => V3AnthropicTerminalKind::ContextWindowExceeded,
        Some(other) => {
            eprintln!(
                "[v3-response-warning] protocol=anthropic stage=terminal_projection stop_reason={stop_reason:?} hub_reason={other:?} reason=unmapped_stop_reason_defaulting_end_turn"
            );
            V3AnthropicTerminalKind::EndTurn
        }
        None => {
            eprintln!(
                "[v3-response-warning] protocol=anthropic stage=terminal_projection stop_reason={stop_reason:?} reason=unknown_stop_reason_defaulting_end_turn"
            );
            V3AnthropicTerminalKind::EndTurn
        }
    };

    let stop_sequence = match (kind, object.get("stop_sequence")) {
        (V3AnthropicTerminalKind::StopSequence, Some(Value::String(value)))
            if !value.trim().is_empty() =>
        {
            Some(value.clone())
        }
        (V3AnthropicTerminalKind::StopSequence, _) => {
            return Err(V3AnthropicCodecError::InvalidTerminalField {
                field: "stop_sequence",
                reason: "stop_reason=stop_sequence requires a non-empty string".to_string(),
            })
        }
        (_, None | Some(Value::Null)) => None,
        (_, Some(_)) => {
            eprintln!(
                "[v3-response-warning] protocol=anthropic stage=terminal_projection stop_reason={stop_reason:?} reason=extraneous_stop_sequence_omitted"
            );
            None
        }
    };

    let stop_details = object.get("stop_details").cloned();

    // A `tool_use` stop reason is Anthropic's native expression of "the model
    // returned tool calls". The same semantic is a normal output item in the
    // Responses protocol, so the terminal status stays `completed`. Fabricating
    // `requires_action` here leaks a non-Responses status to the client.
    let (responses_status, incomplete_reason) = match kind {
        V3AnthropicTerminalKind::EndTurn | V3AnthropicTerminalKind::StopSequence => {
            ("completed", None)
        }
        V3AnthropicTerminalKind::ToolUse => ("completed", None),
        V3AnthropicTerminalKind::MaxTokens => ("incomplete", Some("max_output_tokens")),
        V3AnthropicTerminalKind::PauseTurn => ("in_progress", None),
        V3AnthropicTerminalKind::Refusal => ("incomplete", Some("content_filter")),
        V3AnthropicTerminalKind::ContextWindowExceeded => ("incomplete", None),
    };

    Ok(V3AnthropicResponsesTerminalProjection {
        kind,
        responses_status,
        incomplete_reason,
        stop_sequence,
        stop_details,
    })
}

pub(super) fn flush_v3_anthropic_text_content_as_responses_message(
    output_items: &mut Vec<Value>,
    message_content: &mut Vec<Value>,
    role: &Value,
) {
    if message_content.is_empty() {
        return;
    }
    output_items.push(json!({
        "type":"message",
        "role": role,
        "content": std::mem::take(message_content)
    }));
}

pub(super) fn anthropic_history_reasoning_part_as_responses_reasoning(
    part: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    anthropic_reasoning_part_as_responses_reasoning_with_omission(part, None, false)?
        .ok_or(V3AnthropicCodecError::MalformedField { field: "thinking" })
}

pub(super) fn anthropic_reasoning_part_as_responses_reasoning(
    part: &Value,
    summary_policy: Option<&str>,
) -> Result<Option<Value>, V3AnthropicCodecError> {
    anthropic_reasoning_part_as_responses_reasoning_with_omission(part, summary_policy, true)
}

fn anthropic_reasoning_part_as_responses_reasoning_with_omission(
    part: &Value,
    summary_policy: Option<&str>,
    allow_empty_unsigned_omission: bool,
) -> Result<Option<Value>, V3AnthropicCodecError> {
    let object = part
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "reasoning content",
        })?;
    match object.get("type").and_then(Value::as_str) {
        Some("thinking") => {
            let signature = optional_reasoning_string(object, "signature")?;
            let thinking = object
                .get("thinking")
                .and_then(Value::as_str)
                .ok_or(V3AnthropicCodecError::MalformedField { field: "thinking" })?;
            if thinking.trim().is_empty() && signature.is_some_and(|value| !value.trim().is_empty())
            {
                validate_anthropic_reasoning_summary_policy(summary_policy)?;
                let mut item = json!({"type":"reasoning","summary":[]});
                item["encrypted_content"] =
                    Value::String(signature.unwrap_or_default().to_string());
                preserve_anthropic_reasoning_extensions(object, &[], &mut item);
                return Ok(Some(item));
            }
            if thinking.trim().is_empty() {
                if object.contains_key("text") {
                    return Err(V3AnthropicCodecError::MalformedField { field: "thinking" });
                }
                if !allow_empty_unsigned_omission {
                    let mut item = json!({"type":"reasoning","summary":[]});
                    preserve_anthropic_reasoning_extensions(object, &[], &mut item);
                    return Ok(Some(item));
                }
                eprintln!(
                    "[v3-response-warning] protocol=anthropic stage=reasoning_projection reason=empty_unsigned_thinking_omitted"
                );
                return Ok(None);
            }
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
            if let Some(signature) = signature {
                item["encrypted_content"] = Value::String(signature.to_string());
            }
            preserve_anthropic_reasoning_extensions(
                object,
                &["type", "thinking", "signature"],
                &mut item,
            );
            Ok(Some(item))
        }
        Some("redacted_thinking") => {
            let data = require_nonempty_reasoning_string(object.get("data"), "data")?;
            let mut item = json!({
                "type":"reasoning",
                "encrypted_content":data
            });
            preserve_anthropic_reasoning_extensions(object, &["type", "data"], &mut item);
            Ok(Some(item))
        }
        _ => Err(V3AnthropicCodecError::MalformedField {
            field: "reasoning content",
        }),
    }
}

fn validate_anthropic_reasoning_summary_policy(
    summary_policy: Option<&str>,
) -> Result<(), V3AnthropicCodecError> {
    if matches!(summary_policy, None | Some("auto" | "concise" | "detailed")) {
        return Ok(());
    }
    Err(V3AnthropicCodecError::MalformedField {
        field: "reasoning_summary_policy",
    })
}

/// Carry provider extension fields on a reasoning block forward as opaque data
/// so a representable provider response is not dropped. Native fields are
/// consumed by the mapping above and are never duplicated.
fn preserve_anthropic_reasoning_extensions(
    object: &Map<String, Value>,
    native: &[&str],
    item: &mut Value,
) {
    let Some(target) = item.as_object_mut() else {
        return;
    };
    let mut extension = Map::new();
    if let Some(content_type) = object.get("type") {
        extension.insert("type".to_string(), content_type.clone());
    }
    for (key, value) in object {
        if !native.contains(&key.as_str()) {
            extension.insert(key.clone(), value.clone());
        }
    }
    if extension.len() > 1 {
        let mut carrier = Map::new();
        carrier.insert(
            ANTHROPIC_REASONING_EXTENSION.to_string(),
            Value::Object(extension),
        );
        target.insert(
            "routecodex_chat_extension".to_string(),
            Value::Object(carrier),
        );
    }
}

fn require_nonempty_reasoning_string<'a>(
    value: Option<&'a Value>,
    field: &'static str,
) -> Result<&'a str, V3AnthropicCodecError> {
    let value = value
        .and_then(Value::as_str)
        .ok_or(V3AnthropicCodecError::MalformedField { field })?;
    if value.trim().is_empty() {
        return Err(V3AnthropicCodecError::MalformedField { field });
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_string_signed_thinking_is_malformed() {
        let error = anthropic_reasoning_part_as_responses_reasoning(
            &json!({
                "type": "thinking",
                "thinking": true,
                "signature": "sig-non-string-thinking"
            }),
            None,
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "Anthropic codec malformed thinking");
    }

    #[test]
    fn missing_signed_thinking_is_malformed() {
        let error = anthropic_reasoning_part_as_responses_reasoning(
            &json!({
                "type": "thinking",
                "signature": "sig-missing-thinking"
            }),
            None,
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "Anthropic codec malformed thinking");
    }
}

fn optional_reasoning_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, V3AnthropicCodecError> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    value
        .as_str()
        .map(Some)
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "reasoning content",
        })
}
