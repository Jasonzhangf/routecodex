use super::{V3HubEntryProtocol, V3HubProviderWireProtocol, V3HubTransportIntent};
use serde_json::{json, Map, Value};

use super::anthropic_codec_tool_projection::{
    anthropic_tool_as_responses_function_tool, anthropic_tool_choice_as_responses_tool_choice,
    anthropic_tool_use_as_responses_call,
};
use super::anthropic_request_field_projection::{
    insert_matching_anthropic_output_config_field,
    project_responses_text_as_anthropic_output_config,
    reject_responses_reasoning_summary_for_anthropic, responses_metadata_as_anthropic_metadata,
    validate_responses_cache_and_store_for_anthropic,
};
use super::client_metadata_projection::unsupported_client_metadata_paths;
use std::collections::{BTreeMap, HashSet};

mod message_encoding;
mod projection_context;
mod response_projection;
mod responses_to_anthropic;
mod validation;
use message_encoding::non_empty_string;
pub use projection_context::V3AnthropicResponsesProjectionContext;
use response_projection::{
    anthropic_reasoning_part_as_responses_reasoning,
    flush_v3_anthropic_text_content_as_responses_message,
    project_v3_anthropic_terminal_as_responses_terminal, V3AnthropicResponseContentBlockKind,
    V3AnthropicTerminalKind,
};
use responses_to_anthropic::{
    anthropic_usage_as_responses_usage, chat_messages_as_anthropic_messages,
    responses_input_as_anthropic_messages, responses_system_as_anthropic_system,
    responses_tool_choice_as_anthropic_tool_choice, responses_tools_for_anthropic_wire,
};
pub(crate) use responses_to_anthropic::{
    project_v3_responses_reasoning_item_as_anthropic_content,
    responses_web_search_tool_as_anthropic_tool,
};
use validation::*;

const CLAUDE_CODE_SYSTEM_PROMPT_MD: &str = include_str!("claude_code_system_prompt.md");
const ANTHROPIC_REQUEST_EXTENSION: &str = "anthropic_request";
const ANTHROPIC_ENTRY_PASSTHROUGH_EXTENSION_KEYS: &[&str] = &["context_management"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3AnthropicCodecStage {
    ClientInputToHubSemantic,
    HubSemanticToProviderWire,
    ProviderRawToHubResponseSemantic,
    HubResponseSemanticToClientProjection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3AnthropicCodecTrace {
    pub stage: V3AnthropicCodecStage,
    pub entry_protocol: V3HubEntryProtocol,
    pub provider_protocol: V3HubProviderWireProtocol,
    pub transport_intent: V3HubTransportIntent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3AnthropicChatShapeBranchSemantic {
    ChatImageUrlUrl,
    ChatInlineMediaData,
    ChatMediaMimeType,
    ChatFileFileData,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3AnthropicRequestShapeBranchSemantic {
    pub message_index: usize,
    pub content_index: usize,
    pub source_field: &'static str,
    pub chat_semantic: V3AnthropicChatShapeBranchSemantic,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3AnthropicHubRequestSemantic {
    payload: Value,
    trace: V3AnthropicCodecTrace,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3AnthropicProviderWirePayload {
    payload: Value,
    trace: V3AnthropicCodecTrace,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3AnthropicHubResponseSemantic {
    payload: Value,
    trace: V3AnthropicCodecTrace,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3AnthropicClientProjection {
    payload: Value,
    trace: V3AnthropicCodecTrace,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3AnthropicCodecError {
    #[error("Anthropic codec accepts only the Anthropic entry protocol")]
    EntryProtocolNotAnthropic,
    #[error("Anthropic codec accepts only the Anthropic provider protocol")]
    ProviderProtocolNotAnthropic,
    #[error("Anthropic codec payload must be an object")]
    PayloadNotObject,
    #[error("Anthropic codec payload leaked RouteCodex side-channel field: {field}")]
    SideChannelLeaked { field: &'static str },
    #[error("Anthropic request messages must be an array")]
    MessagesNotArray,
    #[error("Anthropic response content must be an array")]
    ContentNotArray,
    #[error("Anthropic SSE event requires a supported type")]
    MalformedSseEvent,
    #[error("Anthropic provider error requires error.type and error.message")]
    MalformedProviderError,
    #[error("Anthropic codec malformed {field}")]
    MalformedField { field: &'static str },
    #[error("Anthropic terminal field {field} is invalid: {reason}")]
    InvalidTerminalField { field: &'static str, reason: String },
    #[error("Anthropic stop_reason '{stop_reason}' is unsupported for Responses projection")]
    UnsupportedStopReason { stop_reason: String },
    #[error("Anthropic provider response.content[{index}].type is missing or malformed")]
    MalformedResponseContentBlockType { index: usize },
    #[error("Anthropic provider response.content[{index}].type '{content_type}' is unknown")]
    UnknownResponseContentBlock { index: usize, content_type: String },
    #[error("Anthropic provider response.content[{index}].type '{content_type}' is source-roundtrip-only and unsupported for Responses Relay")]
    UnsupportedResponseContentBlock { index: usize, content_type: String },
    #[error(
        "Anthropic provider response.content[{index}].type '{content_type}' is malformed: {reason}"
    )]
    MalformedResponseContentBlock {
        index: usize,
        content_type: String,
        reason: String,
    },
    #[error("Anthropic provider response.content[{index}].type 'server_tool_use' name '{name}' is unsupported for Responses Relay")]
    UnsupportedServerToolUse { index: usize, name: String },
    #[error("Anthropic provider response.content[{index}].type 'web_search_tool_result' tool_use_id '{tool_use_id}' has no matching server_tool_use")]
    UnpairedWebSearchToolResult { index: usize, tool_use_id: String },
    #[error("UnmappedOutboundFields target_protocol=anthropic paths={paths}")]
    UnmappedOutboundFields { paths: String },
}

pub fn validate_v3_anthropic_client_input_payload(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
) -> Result<(), V3AnthropicCodecError> {
    if entry_protocol != V3HubEntryProtocol::Anthropic {
        return Err(V3AnthropicCodecError::EntryProtocolNotAnthropic);
    }
    reject_side_channel_fields(payload)?;
    require_object(payload)?;
    require_messages_array(payload)
}

pub fn validate_v3_anthropic_provider_response_payload(
    payload: &Value,
    provider_protocol: V3HubProviderWireProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<(), V3AnthropicCodecError> {
    if provider_protocol != V3HubProviderWireProtocol::Anthropic {
        return Err(V3AnthropicCodecError::ProviderProtocolNotAnthropic);
    }
    reject_side_channel_fields(payload)?;
    require_object(payload)?;
    match transport_intent {
        V3HubTransportIntent::Json => validate_json_response(payload),
        V3HubTransportIntent::Sse => validate_sse_event(payload),
    }
}

pub fn collect_v3_anthropic_request_shape_branch_semantics(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
) -> Result<Vec<V3AnthropicRequestShapeBranchSemantic>, V3AnthropicCodecError> {
    validate_v3_anthropic_client_input_payload(payload, entry_protocol)?;
    let messages = payload
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(V3AnthropicCodecError::MessagesNotArray)?;
    let mut semantics = Vec::new();
    for (message_index, message) in messages.iter().enumerate() {
        let Some(content) = message.get("content").and_then(Value::as_array) else {
            continue;
        };
        for (content_index, part) in content.iter().enumerate() {
            match part.get("type").and_then(Value::as_str) {
                Some("image") => {
                    let source = part.get("source").and_then(Value::as_object).ok_or(
                        V3AnthropicCodecError::MalformedField {
                            field: "image source",
                        },
                    )?;
                    match source.get("type").and_then(Value::as_str) {
                        Some("url") => message_encoding::push_anthropic_shape_string(
                            &mut semantics,
                            message_index,
                            content_index,
                            source,
                            "url",
                            "request.messages[].content[].image.source.url",
                            V3AnthropicChatShapeBranchSemantic::ChatImageUrlUrl,
                        )?,
                        Some("base64") => {
                            message_encoding::push_anthropic_shape_string(
                                &mut semantics,
                                message_index,
                                content_index,
                                source,
                                "data",
                                "request.messages[].content[].image.source.data",
                                V3AnthropicChatShapeBranchSemantic::ChatInlineMediaData,
                            )?;
                            message_encoding::push_anthropic_shape_string(
                                &mut semantics,
                                message_index,
                                content_index,
                                source,
                                "media_type",
                                "request.messages[].content[].image.source.media_type",
                                V3AnthropicChatShapeBranchSemantic::ChatMediaMimeType,
                            )?;
                        }
                        _ => {
                            return Err(V3AnthropicCodecError::MalformedField {
                                field: "image source type",
                            });
                        }
                    }
                }
                Some("document") => {
                    let source = part.get("source").and_then(Value::as_object).ok_or(
                        V3AnthropicCodecError::MalformedField {
                            field: "document source",
                        },
                    )?;
                    if source.get("type").and_then(Value::as_str) == Some("base64") {
                        message_encoding::push_anthropic_shape_string(
                            &mut semantics,
                            message_index,
                            content_index,
                            source,
                            "data",
                            "request.messages[].content[].document.source.data",
                            V3AnthropicChatShapeBranchSemantic::ChatFileFileData,
                        )?;
                    }
                }
                _ => continue,
            }
        }
    }
    Ok(semantics)
}

pub fn encode_v3_anthropic_request_as_responses_semantic(
    input: Value,
) -> Result<Value, V3AnthropicCodecError> {
    let transport_intent = match input.get("stream").and_then(Value::as_bool) {
        Some(true) => V3HubTransportIntent::Sse,
        _ => V3HubTransportIntent::Json,
    };
    let input = characterize_v3_anthropic_client_input_to_hub_semantic(
        input,
        V3HubEntryProtocol::Anthropic,
        transport_intent,
    )?
    .into_payload();
    let object = input
        .as_object()
        .ok_or(V3AnthropicCodecError::PayloadNotObject)?;
    let mut output = Map::new();
    output.insert(
        "model".to_string(),
        object.get("model").cloned().unwrap_or(Value::Null),
    );
    if let Some(instructions) = object
        .get("system")
        .and_then(message_encoding::system_as_responses_instructions)
    {
        output.insert("instructions".to_string(), Value::String(instructions));
    }
    output.insert(
        "input".to_string(),
        Value::Array(
            message_encoding::encode_anthropic_messages_as_responses_semantic(
                object
                    .get("messages")
                    .and_then(Value::as_array)
                    .ok_or(V3AnthropicCodecError::MessagesNotArray)?,
            )?,
        ),
    );
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        output.insert(
            "tools".to_string(),
            Value::Array(
                tools
                    .iter()
                    .filter_map(Value::as_object)
                    .map(anthropic_tool_as_responses_function_tool)
                    .collect::<Vec<_>>(),
            ),
        );
    }
    if let Some(tool_choice) = object.get("tool_choice") {
        output.insert(
            "tool_choice".to_string(),
            anthropic_tool_choice_as_responses_tool_choice(tool_choice),
        );
    }
    if let Some(thinking) = object.get("thinking").and_then(Value::as_object) {
        for (source, target) in [
            ("type", "reasoning_thinking_mode"),
            ("budget_tokens", "reasoning_budget_tokens"),
            ("display", "reasoning_display_policy"),
        ] {
            if let Some(value) = thinking.get(source) {
                output.insert(target.to_string(), value.clone());
            }
        }
    }
    if let Some(output_config) = object.get("output_config").and_then(Value::as_object) {
        if let Some(effort) = output_config.get("effort") {
            output.insert("reasoning_effort".to_string(), effort.clone());
        }
    }
    let mut responses_request_extension = Map::new();
    if let Some(metadata) = object.get("metadata") {
        let metadata = metadata
            .as_object()
            .ok_or(V3AnthropicCodecError::MalformedField { field: "metadata" })?;
        if metadata.keys().any(|key| key != "user_id") {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "metadata.unsupported",
            });
        }
        if let Some(user_id) = metadata.get("user_id").filter(|value| !value.is_null()) {
            let user_id = user_id
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(V3AnthropicCodecError::MalformedField {
                    field: "metadata.user_id",
                })?;
            responses_request_extension
                .insert("client_metadata".to_string(), json!({"user_id": user_id}));
        }
    }
    if let Some(format) = object
        .get("output_config")
        .and_then(Value::as_object)
        .and_then(|row| row.get("format"))
    {
        responses_request_extension.insert("text".to_string(), json!({"format": format}));
    }
    let mut chat_extension = Map::new();
    if !responses_request_extension.is_empty() {
        chat_extension.insert(
            "responses_request".to_string(),
            Value::Object(responses_request_extension),
        );
    }
    if let Some(system) = object.get("system").filter(|value| !value.is_string()) {
        chat_extension.insert(
            ANTHROPIC_REQUEST_EXTENSION.to_string(),
            json!({"system": system}),
        );
    }
    if !chat_extension.is_empty() {
        output.insert(
            "routecodex_chat_extension".to_string(),
            Value::Object(chat_extension),
        );
    }
    for key in ANTHROPIC_ENTRY_PASSTHROUGH_EXTENSION_KEYS {
        if let Some(value) = object.get(*key) {
            output.insert((*key).to_string(), value.to_owned());
        }
    }
    for key in [
        "temperature",
        "top_p",
        "top_k",
        "user",
        "parallel_tool_calls",
    ] {
        if let Some(value) = object.get(key) {
            output.insert(key.to_string(), value.to_owned());
        }
    }
    if let Some(value) = object
        .get("max_output_tokens")
        .or_else(|| object.get("max_tokens"))
    {
        output.insert("max_output_tokens".to_string(), value.to_owned());
    }
    if let Some(stop) = object.get("stop_sequences") {
        output.insert("stop".to_string(), stop.clone());
    }
    output.insert(
        "stream".to_string(),
        Value::Bool(
            object
                .get("stream")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    Ok(Value::Object(output))
}

pub fn encode_v3_responses_semantic_as_anthropic_request(
    input: Value,
) -> Result<Value, V3AnthropicCodecError> {
    encode_v3_responses_semantic_as_anthropic_request_for_target(input, true)
}

pub fn encode_v3_responses_semantic_as_anthropic_request_for_target(
    input: Value,
    supports_thinking: bool,
) -> Result<Value, V3AnthropicCodecError> {
    reject_side_channel_fields(&input)?;
    reject_unmapped_responses_reasoning_extensions(&input)?;
    let object = input
        .as_object()
        .ok_or(V3AnthropicCodecError::PayloadNotObject)?;
    let responses_request_extension = responses_request_chat_extension(object)?;
    reject_unmapped_anthropic_payload_extensions(object, responses_request_extension)?;
    reject_responses_reasoning_summary_for_anthropic(object)?;
    let mut output = Map::new();
    output.insert(
        "model".to_string(),
        object.get("model").cloned().unwrap_or(Value::Null),
    );
    let anthropic_system_blocks = anthropic_request_system_extension(object)?;
    let claude_code_system = object
        .get("model")
        .and_then(Value::as_str)
        .and_then(claude_code_system_prompt_for_model);
    let mut system_parts = Vec::new();
    if let Some(system) = object
        .get("instructions")
        .or_else(|| object.get("system"))
        .and_then(responses_system_as_anthropic_system)
    {
        system_parts.push(system);
    }
    let messages = if let Some(messages) = object.get("messages") {
        chat_messages_as_anthropic_messages(messages, &mut system_parts)?
    } else {
        responses_input_as_anthropic_messages(object.get("input"), &mut system_parts)?
    };
    if let Some(system) = anthropic_system_blocks {
        output.insert("system".to_string(), system.to_owned());
    } else if let Some(system) = claude_code_system {
        output.insert("system".to_string(), system);
    } else if !system_parts.is_empty() {
        output.insert(
            "system".to_string(),
            Value::String(system_parts.join("\n\n")),
        );
    }
    output.insert("messages".to_string(), Value::Array(messages));
    let tools = responses_tools_for_anthropic_wire(object)?;
    if !tools.is_empty() {
        output.insert("tools".to_string(), Value::Array(tools));
    }
    if let Some(tool_choice) = object.get("tool_choice") {
        output.insert(
            "tool_choice".to_string(),
            responses_tool_choice_as_anthropic_tool_choice(tool_choice)?,
        );
    }
    if let Some(thinking) = responses_reasoning_fields_as_anthropic_thinking(object)? {
        if supports_thinking {
            output.insert("thinking".to_string(), thinking);
        }
    }
    for key in ANTHROPIC_ENTRY_PASSTHROUGH_EXTENSION_KEYS {
        if let Some(value) = object.get(*key) {
            output.insert((*key).to_string(), value.to_owned());
        }
    }
    project_responses_text_as_anthropic_output_config(&mut output, responses_request_extension)?;
    validate_responses_cache_and_store_for_anthropic(responses_request_extension)?;
    let mut reasoning_output_config = Map::new();
    project_chat_reasoning_effort_as_anthropic_output_config(&mut reasoning_output_config, object)?;
    if supports_thinking {
        output.extend(reasoning_output_config);
    }
    for key in ["temperature", "top_p", "top_k"] {
        if let Some(value) = object.get(key) {
            output.insert(key.to_string(), value.to_owned());
        }
    }
    if let Some(metadata) = responses_metadata_as_anthropic_metadata(responses_request_extension)? {
        output.insert("metadata".to_string(), metadata);
    }
    if let Some(value) = object
        .get("max_output_tokens")
        .or_else(|| object.get("max_completion_tokens"))
        .or_else(|| object.get("max_tokens"))
    {
        output.insert("max_tokens".to_string(), value.to_owned());
    }
    if let Some(stop) = object.get("stop").or_else(|| object.get("stop_sequences")) {
        output.insert("stop_sequences".to_string(), stop.clone());
    }
    output.insert(
        "stream".to_string(),
        Value::Bool(
            object
                .get("stream")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    Ok(Value::Object(output))
}

fn responses_request_chat_extension(
    object: &Map<String, Value>,
) -> Result<Option<&Map<String, Value>>, V3AnthropicCodecError> {
    let Some(extension) = object.get("routecodex_chat_extension") else {
        return Ok(None);
    };
    let extension = extension
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "routecodex_chat_extension",
        })?;
    if extension
        .keys()
        .any(|key| !matches!(key.as_str(), "responses_request" | "anthropic_request"))
    {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "routecodex_chat_extension",
        });
    }
    extension
        .get("responses_request")
        .map(|responses_request| {
            responses_request
                .as_object()
                .ok_or(V3AnthropicCodecError::MalformedField {
                    field: "routecodex_chat_extension.responses_request",
                })
        })
        .transpose()
}

fn anthropic_request_system_extension(
    object: &Map<String, Value>,
) -> Result<Option<&Value>, V3AnthropicCodecError> {
    let Some(extension) = object.get("routecodex_chat_extension") else {
        return Ok(None);
    };
    let extension = extension
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "routecodex_chat_extension",
        })?;
    let Some(anthropic_request) = extension.get(ANTHROPIC_REQUEST_EXTENSION) else {
        return Ok(None);
    };
    let anthropic_request =
        anthropic_request
            .as_object()
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "routecodex_chat_extension.anthropic_request",
            })?;
    if anthropic_request.len() != 1 || anthropic_request.keys().any(|key| key != "system") {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "routecodex_chat_extension.anthropic_request",
        });
    }
    Ok(anthropic_request.get("system"))
}

fn responses_reasoning_fields_as_anthropic_thinking(
    object: &Map<String, Value>,
) -> Result<Option<Value>, V3AnthropicCodecError> {
    let mode = object.get("reasoning_thinking_mode");
    let summary_policy = object.get("reasoning_summary_policy");
    if let Some(summary_policy) = summary_policy {
        if !summary_policy
            .as_str()
            .is_some_and(|value| matches!(value, "auto" | "concise" | "detailed"))
        {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "reasoning_summary_policy",
            });
        }
    }
    let explicit_budget = object
        .get("reasoning_budget_tokens")
        .map(|value| {
            responses_reasoning_budget_tokens(value).ok_or(V3AnthropicCodecError::MalformedField {
                field: "reasoning_budget_tokens",
            })
        })
        .transpose()?;
    let display = object.get("reasoning_display_policy");
    if mode.is_none() && explicit_budget.is_none() && display.is_none() && summary_policy.is_none()
    {
        return Ok(None);
    }
    let mode = match mode.and_then(Value::as_str) {
        Some(mode) => mode,
        None if summary_policy.is_some() && explicit_budget.is_none() && display.is_none() => {
            "adaptive"
        }
        None => {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "reasoning_thinking_mode",
            })
        }
    };
    let mut thinking = Map::new();
    match mode {
        "enabled" => {
            let budget = explicit_budget.ok_or(V3AnthropicCodecError::MalformedField {
                field: "reasoning_budget_tokens",
            })?;
            if budget < 1024 {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "reasoning_budget_tokens",
                });
            }
            if object
                .get("max_output_tokens")
                .or_else(|| object.get("max_completion_tokens"))
                .or_else(|| object.get("max_tokens"))
                .and_then(Value::as_u64)
                .is_some_and(|max_tokens| budget >= max_tokens)
            {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "reasoning_budget_tokens",
                });
            }
            thinking.insert("type".to_string(), Value::String("enabled".to_string()));
            thinking.insert("budget_tokens".to_string(), json!(budget));
        }
        "adaptive" => {
            if explicit_budget.is_some() {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "reasoning_budget_tokens",
                });
            }
            thinking.insert("type".to_string(), Value::String("adaptive".to_string()));
        }
        "disabled" => {
            if explicit_budget.is_some() || display.is_some() || summary_policy.is_some() {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "reasoning_thinking_mode",
                });
            }
            thinking.insert("type".to_string(), Value::String("disabled".to_string()));
        }
        _ => {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "reasoning_thinking_mode",
            });
        }
    }
    if let Some(display) = display {
        if !display
            .as_str()
            .is_some_and(|value| matches!(value, "summarized" | "omitted"))
        {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "reasoning_display_policy",
            });
        }
        thinking.insert("display".to_string(), display.clone());
    }
    Ok(Some(Value::Object(thinking)))
}

fn reject_unmapped_responses_reasoning_extensions(
    input: &Value,
) -> Result<(), V3AnthropicCodecError> {
    const RESPONSES_ONLY_REASONING_KEYS: &[&str] = &[
        "reasoning_context_policy",
        "reasoning_mode",
        "reasoning_include_thoughts",
    ];
    let Some(object) = input.as_object() else {
        return Ok(());
    };
    let paths = RESPONSES_ONLY_REASONING_KEYS
        .iter()
        .filter(|key| object.contains_key(**key))
        .map(|key| format!("$.request.{key}"))
        .collect::<Vec<_>>();
    if paths.is_empty() {
        Ok(())
    } else {
        Err(V3AnthropicCodecError::UnmappedOutboundFields {
            paths: paths.join(","),
        })
    }
}

fn reject_unmapped_anthropic_payload_extensions(
    object: &Map<String, Value>,
    extension: Option<&Map<String, Value>>,
) -> Result<(), V3AnthropicCodecError> {
    let mut paths = Vec::new();
    if let Some(extension) = extension {
        for key in extension.keys() {
            if !matches!(
                key.as_str(),
                "metadata" | "client_metadata" | "prompt_cache_key" | "store" | "text"
            ) {
                paths.push(format!("$.request.{key}"));
            }
        }
        if extension
            .get("metadata")
            .is_some_and(|metadata| !metadata.is_object())
        {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "routecodex_chat_extension.responses_request.metadata",
            });
        }
        if let Some(client_metadata) = extension.get("client_metadata") {
            let client_metadata =
                client_metadata
                    .as_object()
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "routecodex_chat_extension.responses_request.client_metadata",
                    })?;
            if client_metadata.is_empty() {
                paths.push("$.request.client_metadata".to_string());
            }
            paths.extend(unsupported_client_metadata_paths(client_metadata));
        }
        if let Some(text) = extension.get("text") {
            let text = text
                .as_object()
                .ok_or(V3AnthropicCodecError::MalformedField {
                    field: "routecodex_chat_extension.responses_request.text",
                })?;
            for key in text
                .keys()
                .filter(|key| !matches!(key.as_str(), "format" | "verbosity"))
            {
                paths.push(format!("$.request.text.output_config.{key}"));
            }
        }
    }
    if paths.is_empty() {
        Ok(())
    } else {
        Err(V3AnthropicCodecError::UnmappedOutboundFields {
            paths: paths.join(","),
        })
    }
}

fn project_chat_reasoning_effort_as_anthropic_output_config(
    output: &mut Map<String, Value>,
    object: &Map<String, Value>,
) -> Result<(), V3AnthropicCodecError> {
    let Some(effort) = object.get("reasoning_effort") else {
        return Ok(());
    };
    let value = effort
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "reasoning_effort",
        })?
        .to_ascii_lowercase();
    let value = value.as_str();
    if !matches!(value, "low" | "medium" | "high" | "xhigh" | "max") {
        return Err(V3AnthropicCodecError::UnmappedOutboundFields {
            paths: "$.request.reasoning_effort".to_string(),
        });
    }
    let output_config = output
        .entry("output_config".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "output_config",
        })?;
    insert_matching_anthropic_output_config_field(
        output_config,
        "effort",
        Value::String(value.to_string()),
    )
}

fn responses_reasoning_budget_tokens(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        .filter(|budget| *budget > 0)
}

pub fn project_v3_anthropic_message_as_responses_response(
    payload: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    project_v3_anthropic_message_as_responses_response_with_context(
        payload,
        &V3AnthropicResponsesProjectionContext::default(),
    )
}

pub fn project_v3_anthropic_message_as_responses_response_with_context(
    payload: &Value,
    context: &V3AnthropicResponsesProjectionContext,
) -> Result<Value, V3AnthropicCodecError> {
    reject_side_channel_fields(payload)?;
    let object = payload
        .as_object()
        .ok_or(V3AnthropicCodecError::PayloadNotObject)?;
    require_content_array(payload)?;
    let content = object
        .get("content")
        .and_then(Value::as_array)
        .ok_or(V3AnthropicCodecError::ContentNotArray)?;
    let terminal = project_v3_anthropic_terminal_as_responses_terminal(object)?;
    let classified_blocks = content
        .iter()
        .enumerate()
        .map(|(index, part)| {
            V3AnthropicResponseContentBlockKind::parse(part, index).map(|kind| (index, kind, part))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let has_client_tool_use = classified_blocks
        .iter()
        .any(|(_, kind, _)| *kind == V3AnthropicResponseContentBlockKind::ToolUse);
    if terminal.kind == V3AnthropicTerminalKind::ToolUse && !has_client_tool_use {
        return Err(V3AnthropicCodecError::InvalidTerminalField {
            field: "stop_reason",
            reason: "tool_use requires at least one response.content[].type=tool_use".to_string(),
        });
    }
    if terminal.kind != V3AnthropicTerminalKind::ToolUse && has_client_tool_use {
        return Err(V3AnthropicCodecError::InvalidTerminalField {
            field: "stop_reason",
            reason: format!(
                "{} contradicts response.content[].type=tool_use",
                terminal.source_stop_reason
            ),
        });
    }
    let mut output_items = Vec::new();
    let mut message_content = Vec::new();
    let message_role = object
        .get("role")
        .cloned()
        .unwrap_or_else(|| Value::String("assistant".to_string()));
    // MiniMax hosted web search（Mode A）：预收集同响应 web_search_tool_result
    // 供 server_tool_use 投影消费（web_search_call results + 配对
    // function_call_output）。content type 已在上方一次性分类；这里不做第二套判定。
    let mut hosted_results_by_call: BTreeMap<String, (usize, Value)> = BTreeMap::new();
    for (index, kind, part) in &classified_blocks {
        if *kind != V3AnthropicResponseContentBlockKind::WebSearchToolResult {
            continue;
        }
        let call_id = part
            .get("tool_use_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| V3AnthropicCodecError::MalformedResponseContentBlock {
                index: *index,
                content_type: kind.source_type().to_string(),
                reason: "tool_use_id must be a non-empty string".to_string(),
            })?;
        let result_content = part
            .get("content")
            .filter(|value| value.is_array())
            .cloned()
            .ok_or_else(|| V3AnthropicCodecError::MalformedResponseContentBlock {
                index: *index,
                content_type: kind.source_type().to_string(),
                reason: "content must be an array for the registered Responses mapping".to_string(),
            })?;
        if hosted_results_by_call
            .insert(call_id.to_string(), (*index, result_content))
            .is_some()
        {
            return Err(V3AnthropicCodecError::MalformedResponseContentBlock {
                index: *index,
                content_type: kind.source_type().to_string(),
                reason: format!("duplicate tool_use_id '{call_id}'"),
            });
        }
    }
    let mut consumed_hosted_result_ids = HashSet::new();
    for (index, kind, part) in &classified_blocks {
        if kind.is_source_roundtrip_only() {
            return Err(V3AnthropicCodecError::UnsupportedResponseContentBlock {
                index: *index,
                content_type: kind.source_type().to_string(),
            });
        }
        match kind {
            V3AnthropicResponseContentBlockKind::Text => {
                let text = part.get("text").and_then(Value::as_str).ok_or_else(|| {
                    V3AnthropicCodecError::MalformedResponseContentBlock {
                        index: *index,
                        content_type: kind.source_type().to_string(),
                        reason: "text must be a string".to_string(),
                    }
                })?;
                message_content.push(json!({
                    "type":"output_text",
                    "text": text
                }));
            }
            V3AnthropicResponseContentBlockKind::Thinking
            | V3AnthropicResponseContentBlockKind::RedactedThinking => {
                flush_v3_anthropic_text_content_as_responses_message(
                    &mut output_items,
                    &mut message_content,
                    &message_role,
                );
                output_items.push(anthropic_reasoning_part_as_responses_reasoning(
                    part,
                    context.reasoning_summary_policy(),
                )?);
            }
            V3AnthropicResponseContentBlockKind::ToolUse => {
                flush_v3_anthropic_text_content_as_responses_message(
                    &mut output_items,
                    &mut message_content,
                    &message_role,
                );
                output_items.push(anthropic_tool_use_as_responses_call(part, context)?);
            }
            V3AnthropicResponseContentBlockKind::ServerToolUse => {
                flush_v3_anthropic_text_content_as_responses_message(
                    &mut output_items,
                    &mut message_content,
                    &message_role,
                );
                // MiniMax hosted web search（Mode A）：server_tool_use 投影为
                // Codex hosted `web_search_call` + 配对 `function_call_output`
                // （results 从预收集的 hosted_results_by_call 提取）。
                let name = part
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| V3AnthropicCodecError::MalformedResponseContentBlock {
                        index: *index,
                        content_type: kind.source_type().to_string(),
                        reason: "name must be a non-empty string".to_string(),
                    })?;
                if name != "web_search" {
                    return Err(V3AnthropicCodecError::UnsupportedServerToolUse {
                        index: *index,
                        name: name.to_string(),
                    });
                }
                let call_id = part
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| V3AnthropicCodecError::MalformedResponseContentBlock {
                        index: *index,
                        content_type: kind.source_type().to_string(),
                        reason: "id must be a non-empty string".to_string(),
                    })?;
                let query = part
                    .get("input")
                    .and_then(Value::as_object)
                    .and_then(|input| input.get("query"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| V3AnthropicCodecError::MalformedResponseContentBlock {
                        index: *index,
                        content_type: kind.source_type().to_string(),
                        reason: "input.query must be a non-empty string".to_string(),
                    })?;
                let hosted_results = hosted_results_by_call.get(call_id);
                let mut results = Vec::new();
                if let Some((result_index, Value::Array(result_items))) = hosted_results {
                    for result in result_items {
                        let title = result
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty());
                        let url = result
                            .get("url")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty());
                        let text = result
                            .get("text")
                            .or_else(|| result.get("content"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .ok_or_else(|| {
                                V3AnthropicCodecError::MalformedResponseContentBlock {
                                    index: *result_index,
                                    content_type: "web_search_tool_result".to_string(),
                                    reason: "each result requires non-empty text or content"
                                        .to_string(),
                                }
                            })?;
                        results.push(json!({
                            "type": "text_result",
                            "ref_id": call_id,
                            "title": title,
                            "url": url,
                            "text": text
                        }));
                    }
                }
                let status = if hosted_results.is_some() {
                    "completed"
                } else {
                    "started"
                };
                let mut call = Map::new();
                call.insert(
                    "type".to_string(),
                    Value::String("web_search_call".to_string()),
                );
                call.insert(
                    "id".to_string(),
                    Value::String(format!("web_search_{call_id}")),
                );
                call.insert("name".to_string(), Value::String("web_search".to_string()));
                call.insert("status".to_string(), Value::String(status.to_string()));
                call.insert("action".to_string(), json!({"type":"search","query":query}));
                call.insert("results".to_string(), Value::Array(results));
                output_items.push(Value::Object(call));
                // 配对 function_call_output（Codex hosted search 在 output
                // 中必须紧跟 function_call_output，否则 client 端 web search
                // tool 装配失败）。
                if let Some((_, result_content)) = hosted_results {
                    consumed_hosted_result_ids.insert(call_id.to_string());
                    let paired = json!({
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": json!({
                            "type":"web_search_tool_result",
                            "results": result_content
                        })
                    });
                    output_items.push(paired);
                }
            }
            V3AnthropicResponseContentBlockKind::WebSearchToolResult => {
                // MiniMax hosted web search（Mode A）：已由 server_tool_use 分支
                // 投影为 web_search_call + function_call_output 配对；这里跳过，
                // 避免在 client output 中重复出现原始 web_search_tool_result。
            }
            V3AnthropicResponseContentBlockKind::WebFetchToolResult
            | V3AnthropicResponseContentBlockKind::CodeExecutionToolResult
            | V3AnthropicResponseContentBlockKind::BashCodeExecutionToolResult
            | V3AnthropicResponseContentBlockKind::TextEditorCodeExecutionToolResult
            | V3AnthropicResponseContentBlockKind::ToolSearchToolResult
            | V3AnthropicResponseContentBlockKind::ContainerUpload => {
                unreachable!("source-roundtrip-only content blocks fail before the mapped match")
            }
        }
    }
    flush_v3_anthropic_text_content_as_responses_message(
        &mut output_items,
        &mut message_content,
        &message_role,
    );
    for (tool_use_id, (index, _)) in &hosted_results_by_call {
        if !consumed_hosted_result_ids.contains(tool_use_id) {
            return Err(V3AnthropicCodecError::UnpairedWebSearchToolResult {
                index: *index,
                tool_use_id: tool_use_id.clone(),
            });
        }
    }
    let mut response = Map::new();
    response.insert(
        "id".to_string(),
        object
            .get("id")
            .cloned()
            .unwrap_or_else(|| Value::String("resp_anthropic_relay".to_string())),
    );
    response.insert("object".to_string(), Value::String("response".to_string()));
    response.insert(
        "status".to_string(),
        Value::String(terminal.responses_status.to_string()),
    );
    if let Some(model) = object.get("model") {
        response.insert("model".to_string(), model.clone());
    }
    response.insert("output".to_string(), Value::Array(output_items));
    if let Some(usage) = anthropic_usage_as_responses_usage(object.get("usage")) {
        response.insert("usage".to_string(), usage);
    }
    response.insert(
        "finish_reason".to_string(),
        Value::String(terminal.source_stop_reason),
    );
    if let Some(reason) = terminal.incomplete_reason {
        response.insert("incomplete_details".to_string(), json!({"reason": reason}));
    }
    if let Some(stop_sequence) = terminal.stop_sequence {
        response.insert("stop_sequence".to_string(), Value::String(stop_sequence));
    }
    if let Some(stop_details) = terminal.stop_details {
        response.insert("stop_details".to_string(), stop_details);
    }
    if let Some(metadata) = context.metadata() {
        response.insert("metadata".to_string(), metadata.clone());
    }
    Ok(Value::Object(response))
}

pub fn characterize_v3_anthropic_client_input_to_hub_semantic(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<V3AnthropicHubRequestSemantic, V3AnthropicCodecError> {
    if entry_protocol != V3HubEntryProtocol::Anthropic {
        return Err(V3AnthropicCodecError::EntryProtocolNotAnthropic);
    }
    reject_side_channel_fields(&payload)?;
    require_object(&payload)?;
    require_messages_array(&payload)?;
    Ok(V3AnthropicHubRequestSemantic {
        payload,
        trace: trace(
            V3AnthropicCodecStage::ClientInputToHubSemantic,
            transport_intent,
        ),
    })
}

pub fn characterize_v3_anthropic_hub_semantic_to_provider_wire(
    semantic: V3AnthropicHubRequestSemantic,
) -> Result<V3AnthropicProviderWirePayload, V3AnthropicCodecError> {
    reject_side_channel_fields(&semantic.payload)?;
    require_object(&semantic.payload)?;
    require_messages_array(&semantic.payload)?;
    let V3AnthropicHubRequestSemantic {
        payload,
        trace: semantic_trace,
    } = semantic;
    let wire = into_object(payload)?;
    Ok(V3AnthropicProviderWirePayload {
        payload: Value::Object(wire),
        trace: trace(
            V3AnthropicCodecStage::HubSemanticToProviderWire,
            semantic_trace.transport_intent,
        ),
    })
}

pub fn characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
    payload: Value,
    provider_protocol: V3HubProviderWireProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<V3AnthropicHubResponseSemantic, V3AnthropicCodecError> {
    if provider_protocol != V3HubProviderWireProtocol::Anthropic {
        return Err(V3AnthropicCodecError::ProviderProtocolNotAnthropic);
    }
    reject_side_channel_fields(&payload)?;
    require_object(&payload)?;
    match transport_intent {
        V3HubTransportIntent::Json => validate_json_response(&payload)?,
        V3HubTransportIntent::Sse => validate_sse_event(&payload)?,
    }
    Ok(V3AnthropicHubResponseSemantic {
        payload,
        trace: trace(
            V3AnthropicCodecStage::ProviderRawToHubResponseSemantic,
            transport_intent,
        ),
    })
}

pub fn characterize_v3_anthropic_hub_response_semantic_to_client_projection(
    semantic: V3AnthropicHubResponseSemantic,
) -> Result<V3AnthropicClientProjection, V3AnthropicCodecError> {
    validate_v3_anthropic_hub_response_payload_for_client_projection(
        &semantic.payload,
        semantic.trace.entry_protocol,
        semantic.trace.transport_intent,
    )?;
    Ok(V3AnthropicClientProjection {
        payload: semantic.payload,
        trace: trace(
            V3AnthropicCodecStage::HubResponseSemanticToClientProjection,
            semantic.trace.transport_intent,
        ),
    })
}

pub fn validate_v3_anthropic_hub_response_payload_for_client_projection(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<(), V3AnthropicCodecError> {
    if entry_protocol != V3HubEntryProtocol::Anthropic {
        return Err(V3AnthropicCodecError::EntryProtocolNotAnthropic);
    }
    reject_side_channel_fields(payload)?;
    require_object(payload)?;
    match transport_intent {
        V3HubTransportIntent::Json => validate_json_response(payload)?,
        V3HubTransportIntent::Sse => validate_sse_event(payload)?,
    }
    Ok(())
}

impl V3AnthropicHubRequestSemantic {
    pub fn payload(&self) -> &Value {
        &self.payload
    }

    pub fn trace(&self) -> &V3AnthropicCodecTrace {
        &self.trace
    }

    pub fn into_payload(self) -> Value {
        self.payload
    }
}

impl V3AnthropicProviderWirePayload {
    pub fn payload(&self) -> &Value {
        &self.payload
    }

    pub fn trace(&self) -> &V3AnthropicCodecTrace {
        &self.trace
    }
}

impl V3AnthropicHubResponseSemantic {
    pub fn payload(&self) -> &Value {
        &self.payload
    }

    pub fn trace(&self) -> &V3AnthropicCodecTrace {
        &self.trace
    }
}

impl V3AnthropicClientProjection {
    pub fn payload(&self) -> &Value {
        &self.payload
    }

    pub fn trace(&self) -> &V3AnthropicCodecTrace {
        &self.trace
    }
}
