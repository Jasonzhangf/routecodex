use super::V3AnthropicCodecError;
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
            other => Err(V3AnthropicCodecError::UnknownResponseContentBlock {
                index,
                content_type: other.to_string(),
            }),
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
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct V3AnthropicResponsesTerminalProjection {
    pub(super) kind: V3AnthropicTerminalKind,
    pub(super) source_stop_reason: String,
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
    })?
    .ok_or_else(|| V3AnthropicCodecError::InvalidTerminalField {
        field: "stop_reason",
        reason: format!("unknown value '{stop_reason}'"),
    })?;

    let kind = match hub_reason {
        "stop" => V3AnthropicTerminalKind::EndTurn,
        "tool_calls" => V3AnthropicTerminalKind::ToolUse,
        "max_tokens" => V3AnthropicTerminalKind::MaxTokens,
        "stop_sequence" => V3AnthropicTerminalKind::StopSequence,
        "pause_turn" => V3AnthropicTerminalKind::PauseTurn,
        "content_filter" => V3AnthropicTerminalKind::Refusal,
        "context_window_exceeded" => {
            return Err(V3AnthropicCodecError::UnsupportedStopReason {
                stop_reason: stop_reason.to_string(),
            })
        }
        other => {
            return Err(V3AnthropicCodecError::InvalidTerminalField {
                field: "stop_reason",
                reason: format!("finish_reason_map produced unsupported hub value '{other}'"),
            })
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
            return Err(V3AnthropicCodecError::InvalidTerminalField {
                field: "stop_sequence",
                reason: format!("must be absent or null when stop_reason={stop_reason}"),
            })
        }
    };

    let stop_details = match object.get("stop_details") {
        None | Some(Value::Null) => None,
        Some(Value::Object(_)) if kind == V3AnthropicTerminalKind::Refusal => {
            object.get("stop_details").cloned()
        }
        Some(Value::Object(_)) => {
            return Err(V3AnthropicCodecError::InvalidTerminalField {
                field: "stop_details",
                reason: format!("must be absent or null when stop_reason={stop_reason}"),
            })
        }
        Some(_) => {
            return Err(V3AnthropicCodecError::InvalidTerminalField {
                field: "stop_details",
                reason: "must be an object when present".to_string(),
            })
        }
    };

    let (responses_status, incomplete_reason) = match kind {
        V3AnthropicTerminalKind::EndTurn | V3AnthropicTerminalKind::StopSequence => {
            ("completed", None)
        }
        V3AnthropicTerminalKind::ToolUse => ("requires_action", None),
        V3AnthropicTerminalKind::MaxTokens => ("incomplete", Some("max_output_tokens")),
        V3AnthropicTerminalKind::PauseTurn => ("in_progress", None),
        V3AnthropicTerminalKind::Refusal => ("incomplete", Some("content_filter")),
    };

    Ok(V3AnthropicResponsesTerminalProjection {
        kind,
        source_stop_reason: stop_reason.to_string(),
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

fn require_nonempty_reasoning_string(value: Option<&Value>) -> Result<&str, V3AnthropicCodecError> {
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

fn optional_nonempty_reasoning_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, V3AnthropicCodecError> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    Ok(Some(require_nonempty_reasoning_string(Some(value))?))
}

fn validate_anthropic_reasoning_object_keys(
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
