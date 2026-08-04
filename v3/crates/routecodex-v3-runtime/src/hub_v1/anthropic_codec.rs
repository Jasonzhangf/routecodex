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
use std::collections::HashSet;
use std::sync::OnceLock;

mod projection_context;
mod responses_to_anthropic;
pub use projection_context::V3AnthropicResponsesProjectionContext;
pub(crate) use responses_to_anthropic::project_v3_responses_reasoning_item_as_anthropic_content;
use responses_to_anthropic::{
    anthropic_usage_as_responses_usage, chat_messages_as_anthropic_messages,
    responses_input_as_anthropic_messages, responses_system_as_anthropic_system,
    responses_tool_choice_as_anthropic_tool_choice, responses_tools_for_anthropic_wire,
};

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
                        Some("url") => push_anthropic_shape_string(
                            &mut semantics,
                            message_index,
                            content_index,
                            source,
                            "url",
                            "request.messages[].content[].image.source.url",
                            V3AnthropicChatShapeBranchSemantic::ChatImageUrlUrl,
                        )?,
                        Some("base64") => {
                            push_anthropic_shape_string(
                                &mut semantics,
                                message_index,
                                content_index,
                                source,
                                "data",
                                "request.messages[].content[].image.source.data",
                                V3AnthropicChatShapeBranchSemantic::ChatInlineMediaData,
                            )?;
                            push_anthropic_shape_string(
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
                        push_anthropic_shape_string(
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
        .and_then(system_as_responses_instructions)
    {
        output.insert("instructions".to_string(), Value::String(instructions));
    }
    output.insert(
        "input".to_string(),
        Value::Array(encode_anthropic_messages_as_responses_semantic(
            object
                .get("messages")
                .and_then(Value::as_array)
                .ok_or(V3AnthropicCodecError::MessagesNotArray)?,
        )?),
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
    reject_side_channel_fields(&input)?;
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
        output.insert("thinking".to_string(), thinking);
    }
    for key in ANTHROPIC_ENTRY_PASSTHROUGH_EXTENSION_KEYS {
        if let Some(value) = object.get(*key) {
            output.insert((*key).to_string(), value.to_owned());
        }
    }
    project_responses_text_as_anthropic_output_config(&mut output, responses_request_extension)?;
    validate_responses_cache_and_store_for_anthropic(responses_request_extension)?;
    project_chat_reasoning_effort_as_anthropic_output_config(&mut output, object)?;
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

fn claude_code_system_prompt_for_model(model: &str) -> Option<Value> {
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
    let explicit_budget = object
        .get("reasoning_budget_tokens")
        .map(|value| {
            responses_reasoning_budget_tokens(value).ok_or(V3AnthropicCodecError::MalformedField {
                field: "reasoning_budget_tokens",
            })
        })
        .transpose()?;
    let display = object.get("reasoning_display_policy");
    if mode.is_none() && explicit_budget.is_none() && display.is_none() {
        return Ok(None);
    }
    let mode = mode
        .and_then(Value::as_str)
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "reasoning_thinking_mode",
        })?;
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
            if explicit_budget.is_some() || display.is_some() {
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

fn reject_unmapped_anthropic_payload_extensions(
    object: &Map<String, Value>,
    extension: Option<&Map<String, Value>>,
) -> Result<(), V3AnthropicCodecError> {
    let mut paths = Vec::new();
    for key in [
        "reasoning_context_policy",
        "reasoning_mode",
        "reasoning_include_thoughts",
    ] {
        if object.contains_key(key) {
            paths.push(format!("$.request.{key}"));
        }
    }
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
    let mut output_items = Vec::new();
    let mut message_content = Vec::new();
    for part in object
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                message_content.push(json!({
                    "type":"output_text",
                    "text": part.get("text").cloned().unwrap_or(Value::String(String::new()))
                }));
            }
            Some("thinking" | "redacted_thinking") => {
                output_items.push(anthropic_reasoning_part_as_responses_reasoning(
                    part,
                    context.reasoning_summary_policy(),
                )?);
            }
            Some("tool_use") => {
                output_items.push(anthropic_tool_use_as_responses_call(part, context)?);
            }
            Some(other) => {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: match other {
                        "image" => "provider response image content",
                        _ => "provider response content type",
                    },
                });
            }
            None => {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "content type",
                })
            }
        }
    }
    if !message_content.is_empty() {
        output_items.push(json!({
            "type":"message",
            "role": object.get("role").cloned().unwrap_or_else(|| Value::String("assistant".to_string())),
            "content": message_content
        }));
    }
    let stop_reason = object.get("stop_reason").and_then(Value::as_str);
    let status = if stop_reason == Some("tool_use") {
        "requires_action"
    } else {
        "completed"
    };
    let mut response = Map::new();
    response.insert(
        "id".to_string(),
        object
            .get("id")
            .cloned()
            .unwrap_or_else(|| Value::String("resp_anthropic_relay".to_string())),
    );
    response.insert("object".to_string(), Value::String("response".to_string()));
    response.insert("status".to_string(), Value::String(status.to_string()));
    if let Some(model) = object.get("model") {
        response.insert("model".to_string(), model.clone());
    }
    response.insert("output".to_string(), Value::Array(output_items));
    if let Some(usage) = anthropic_usage_as_responses_usage(object.get("usage")) {
        response.insert("usage".to_string(), usage);
    }
    if let Some(stop_reason) = object.get("stop_reason") {
        response.insert("finish_reason".to_string(), stop_reason.clone());
    }
    if let Some(metadata) = context.metadata() {
        response.insert("metadata".to_string(), metadata.clone());
    }
    Ok(Value::Object(response))
}

fn anthropic_reasoning_part_as_responses_reasoning(
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

fn trace(
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

fn require_object(value: &Value) -> Result<&Map<String, Value>, V3AnthropicCodecError> {
    value
        .as_object()
        .ok_or(V3AnthropicCodecError::PayloadNotObject)
}

fn require_messages_array(value: &Value) -> Result<(), V3AnthropicCodecError> {
    match value.get("messages") {
        Some(Value::Array(_)) => Ok(()),
        _ => Err(V3AnthropicCodecError::MessagesNotArray),
    }
}

fn require_content_array(value: &Value) -> Result<(), V3AnthropicCodecError> {
    match value.get("content") {
        Some(Value::Array(_)) => Ok(()),
        _ => Err(V3AnthropicCodecError::ContentNotArray),
    }
}

fn validate_json_response(value: &Value) -> Result<(), V3AnthropicCodecError> {
    if value.get("error").is_some() {
        validate_provider_error(value)
    } else {
        require_content_array(value)
    }
}

fn validate_sse_event(value: &Value) -> Result<(), V3AnthropicCodecError> {
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

fn into_object(value: Value) -> Result<Map<String, Value>, V3AnthropicCodecError> {
    match value {
        Value::Object(object) => Ok(object),
        _ => Err(V3AnthropicCodecError::PayloadNotObject),
    }
}

fn reject_side_channel_fields(value: &Value) -> Result<(), V3AnthropicCodecError> {
    let object = require_object(value)?;
    reject_side_channel_object_keys(object)
}

fn reject_side_channel_object_keys(
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

fn push_anthropic_shape_string(
    semantics: &mut Vec<V3AnthropicRequestShapeBranchSemantic>,
    message_index: usize,
    content_index: usize,
    source: &Map<String, Value>,
    provider_field: &'static str,
    source_field: &'static str,
    chat_semantic: V3AnthropicChatShapeBranchSemantic,
) -> Result<(), V3AnthropicCodecError> {
    let value = source
        .get(provider_field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: source_field,
        })?;
    semantics.push(V3AnthropicRequestShapeBranchSemantic {
        message_index,
        content_index,
        source_field,
        chat_semantic,
        value: value.to_owned(),
    });
    Ok(())
}

fn encode_anthropic_messages_as_responses_semantic(
    messages: &[Value],
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let mut encoded = Vec::new();
    for message in messages {
        let role = message.get("role").cloned().unwrap_or(Value::Null);
        match message.get("content") {
            Some(Value::String(text)) => {
                encoded.push(json!({
                    "role":role,
                    "content":[{"type":"input_text","text":text}]
                }));
            }
            Some(Value::Array(parts)) => {
                let mut message_content = Vec::new();
                for part in parts {
                    match part.get("type").and_then(Value::as_str) {
                        Some("text" | "image") => {
                            if let Some(content_part) =
                                anthropic_content_part_as_responses_message_part(part)
                            {
                                message_content.push(content_part?);
                            }
                        }
                        Some("thinking" | "redacted_thinking") => {
                            push_responses_message_content(
                                &mut encoded,
                                &role,
                                &mut message_content,
                            );
                            encoded
                                .push(anthropic_reasoning_part_as_responses_reasoning(part, None)?);
                        }
                        Some("reasoning") => {
                            return Err(V3AnthropicCodecError::MalformedField {
                                field: "reasoning content",
                            });
                        }
                        Some("tool_use") => {
                            push_responses_message_content(
                                &mut encoded,
                                &role,
                                &mut message_content,
                            );
                            encoded.push(json!({"type":"function_call","call_id":part.get("id").cloned().unwrap_or(Value::Null),"name":part.get("name").cloned().unwrap_or(Value::Null),"arguments":serde_json::to_string(part.get("input").unwrap_or(&Value::Null)).map_err(|_| V3AnthropicCodecError::MalformedField { field: "tool_use input" })?}));
                        }
                        Some("tool_result") => {
                            push_responses_message_content(
                                &mut encoded,
                                &role,
                                &mut message_content,
                            );
                            encoded.push(json!({"type":"function_call_output","call_id":part.get("tool_use_id").cloned().unwrap_or(Value::Null),"output":anthropic_tool_result_output_as_responses_semantic(part.get("content"))}));
                        }
                        _ => {}
                    }
                }
                push_responses_message_content(&mut encoded, &role, &mut message_content);
            }
            _ => {}
        }
    }
    Ok(encoded)
}

fn push_responses_message_content(
    encoded: &mut Vec<Value>,
    role: &Value,
    content: &mut Vec<Value>,
) {
    if !content.is_empty() {
        encoded.push(json!({
            "role":role,
            "content":std::mem::take(content)
        }));
    }
}

fn anthropic_tool_result_output_as_responses_semantic(content: Option<&Value>) -> Value {
    match content {
        Some(Value::String(text)) => Value::String(text.clone()),
        Some(Value::Array(parts)) => {
            let text = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("");
            if text.is_empty() {
                Value::String(serde_json::to_string(parts).unwrap_or_else(|_| "[]".into()))
            } else {
                Value::String(text)
            }
        }
        Some(value) => {
            Value::String(serde_json::to_string(value).unwrap_or_else(|_| "null".into()))
        }
        None => Value::String(String::new()),
    }
}

fn system_as_responses_instructions(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => non_empty_string(text),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(anthropic_text_block_text)
                .collect::<Vec<_>>();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n"))
            }
        }
        Value::Object(_) => anthropic_text_block_text(value),
        _ => None,
    }
}

fn anthropic_text_block_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => non_empty_string(text),
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .and_then(non_empty_string),
        _ => None,
    }
}

fn non_empty_string(text: &str) -> Option<String> {
    if text.trim().is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn anthropic_content_part_as_responses_message_part(
    part: &Value,
) -> Option<Result<Value, V3AnthropicCodecError>> {
    let part_type = part.get("type").and_then(Value::as_str)?;
    match part_type {
        "text" => Some(Ok(
            json!({"type":"input_text","text":part.get("text").cloned().unwrap_or(Value::Null)}),
        )),
        "image" => Some(anthropic_image_part_as_responses_input_image(part)),
        _ => None,
    }
}

fn anthropic_image_part_as_responses_input_image(
    part: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let source = part.get("source").and_then(Value::as_object).ok_or(
        V3AnthropicCodecError::MalformedField {
            field: "image source",
        },
    )?;
    match source.get("type").and_then(Value::as_str) {
        Some("url") => source
            .get("url")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|url| json!({"type":"input_image","image_url":url}))
            .ok_or(V3AnthropicCodecError::MalformedField { field: "image url" }),
        Some("base64") => {
            let media_type = source
                .get("media_type")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(V3AnthropicCodecError::MalformedField {
                    field: "image media_type",
                })?;
            let data = source
                .get("data")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(V3AnthropicCodecError::MalformedField {
                    field: "image data",
                })?;
            Ok(json!({"type":"input_image","image_url":format!("data:{media_type};base64,{data}")}))
        }
        _ => Err(V3AnthropicCodecError::MalformedField {
            field: "image source type",
        }),
    }
}
