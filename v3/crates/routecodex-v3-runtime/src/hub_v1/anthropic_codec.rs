use super::{V3HubEntryProtocol, V3HubProviderWireProtocol, V3HubTransportIntent};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

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
    if let Some(thinking) = object.get("thinking") {
        output.insert(
            "reasoning".to_string(),
            json!({"effort":"medium","thinking":thinking}),
        );
    }
    for key in [
        "metadata",
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
    let mut output = Map::new();
    output.insert(
        "model".to_string(),
        object.get("model").cloned().unwrap_or(Value::Null),
    );
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
    if !system_parts.is_empty() {
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
    if let Some(thinking) = object
        .get("reasoning")
        .and_then(|reasoning| reasoning.get("thinking"))
        .cloned()
    {
        output.insert("thinking".to_string(), thinking);
    }
    for key in ["metadata", "temperature", "top_p", "top_k", "user"] {
        if let Some(value) = object.get(key) {
            output.insert(key.to_string(), value.to_owned());
        }
    }
    if let Some(value) = object
        .get("max_output_tokens")
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

pub fn project_v3_anthropic_message_as_responses_response(
    payload: &Value,
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
            Some("thinking" | "reasoning" | "redacted_thinking") => {
                output_items.push(anthropic_reasoning_part_as_responses_reasoning(part)?);
            }
            Some("tool_use") => {
                output_items.push(json!({
                    "type":"function_call",
                    "call_id": part.get("id").cloned().unwrap_or(Value::Null),
                    "name": part.get("name").cloned().unwrap_or(Value::Null),
                    "arguments": serde_json::to_string(part.get("input").unwrap_or(&Value::Null))
                        .map_err(|_| V3AnthropicCodecError::MalformedField { field: "tool_use input" })?
                }));
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
    Ok(Value::Object(response))
}

fn anthropic_reasoning_part_as_responses_reasoning(
    part: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let object = part
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "provider response reasoning content",
        })?;
    let mut item = Map::new();
    item.insert("type".to_string(), Value::String("reasoning".to_string()));
    if let Some(text) = object
        .get("thinking")
        .or_else(|| object.get("text"))
        .or_else(|| object.get("reasoning"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        item.insert(
            "summary".to_string(),
            Value::Array(vec![json!({"type":"summary_text","text":text})]),
        );
    }
    if let Some(encrypted_content) = object
        .get("encrypted_content")
        .or_else(|| object.get("signature"))
        .or_else(|| object.get("data"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        item.insert(
            "encrypted_content".to_string(),
            Value::String(encrypted_content.to_string()),
        );
    }
    if !item.contains_key("summary") && !item.contains_key("encrypted_content") {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "provider response reasoning content",
        });
    }
    Ok(Value::Object(item))
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

fn encode_anthropic_messages_as_responses_semantic(
    messages: &[Value],
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let mut encoded = Vec::new();
    for message in messages {
        let role = message.get("role").cloned().unwrap_or(Value::Null);
        let mut content = match message.get("content") {
            Some(Value::String(text)) => vec![json!({"type":"input_text","text":text})],
            Some(Value::Array(parts)) => parts
                .iter()
                .filter_map(anthropic_content_part_as_responses_message_part)
                .collect::<Result<Vec<_>, _>>()?,
            _ => Vec::new(),
        };
        if !content.is_empty() {
            encoded.push(json!({"role":role,"content":std::mem::take(&mut content)}));
        }
        if let Some(parts) = message.get("content").and_then(Value::as_array) {
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("tool_use") => encoded.push(json!({"type":"function_call","call_id":part.get("id").cloned().unwrap_or(Value::Null),"name":part.get("name").cloned().unwrap_or(Value::Null),"arguments":serde_json::to_string(part.get("input").unwrap_or(&Value::Null)).map_err(|_| V3AnthropicCodecError::MalformedField { field: "tool_use input" })?})),
                    Some("tool_result") => encoded.push(json!({"type":"function_call_output","call_id":part.get("tool_use_id").cloned().unwrap_or(Value::Null),"output":anthropic_tool_result_output_as_responses_semantic(part.get("content"))})),
                    _ => {}
                }
            }
        }
    }
    Ok(encoded)
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

fn anthropic_tool_as_responses_function_tool(tool: &Map<String, Value>) -> Value {
    let mut output = Map::new();
    output.insert("type".to_string(), Value::String("function".to_string()));
    output.insert(
        "name".to_string(),
        tool.get("name").cloned().unwrap_or(Value::Null),
    );
    if let Some(description) = tool.get("description") {
        output.insert("description".to_string(), description.clone());
    }
    output.insert(
        "parameters".to_string(),
        tool.get("input_schema")
            .cloned()
            .unwrap_or_else(|| json!({"type":"object"})),
    );
    Value::Object(output)
}

fn anthropic_tool_choice_as_responses_tool_choice(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.to_owned();
    };
    if object.get("type").and_then(Value::as_str) == Some("tool") {
        if let Some(name) = object.get("name").and_then(Value::as_str) {
            return json!({"type":"function","name":name});
        }
    }
    value.to_owned()
}

fn responses_system_as_anthropic_system(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => non_empty_string(text),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| item.as_str())
                        .and_then(non_empty_string)
                })
                .collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join("\n\n"))
        }
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .and_then(non_empty_string),
        _ => None,
    }
}

fn append_responses_instruction_part(system_parts: &mut Vec<String>, value: Option<&Value>) {
    if let Some(system) = value.and_then(responses_system_as_anthropic_system) {
        system_parts.push(system);
    }
}

fn responses_input_as_anthropic_messages(
    value: Option<&Value>,
    system_parts: &mut Vec<String>,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    match value {
        Value::String(text) => Ok(vec![json!({
            "role":"user",
            "content":[{"type":"text","text":text}]
        })]),
        Value::Array(items) => responses_input_array_as_anthropic_messages(items, system_parts),
        Value::Object(_) => {
            let mut messages = Vec::new();
            responses_input_item_as_anthropic_messages(value, &mut messages, system_parts)?;
            Ok(messages)
        }
        _ => Err(V3AnthropicCodecError::MalformedField { field: "input" }),
    }
}

fn chat_messages_as_anthropic_messages(
    value: &Value,
    system_parts: &mut Vec<String>,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let messages = value
        .as_array()
        .ok_or(V3AnthropicCodecError::MessagesNotArray)?;
    let mut output = Vec::new();
    for message in messages {
        let object = message
            .as_object()
            .ok_or(V3AnthropicCodecError::MalformedField { field: "message" })?;
        let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
        if role == "system" || role == "developer" {
            append_responses_instruction_part(system_parts, object.get("content"));
            continue;
        }
        if role == "tool" {
            output.push(json!({
                "role":"user",
                "content":[{
                    "type":"tool_result",
                    "tool_use_id": object.get("tool_call_id").cloned().unwrap_or(Value::Null),
                    "content": responses_tool_output_as_anthropic_content(object.get("content"))
                }]
            }));
            continue;
        }
        let mut content = responses_content_as_anthropic_content(object.get("content"))?;
        if let Some(tool_calls) = object.get("tool_calls").and_then(Value::as_array) {
            for tool_call in tool_calls {
                content.push(openai_chat_tool_call_as_anthropic_tool_use(tool_call)?);
            }
        }
        if content.is_empty() {
            continue;
        }
        output.push(json!({
            "role": role,
            "content": content
        }));
    }
    Ok(output)
}

fn openai_chat_tool_call_as_anthropic_tool_use(
    value: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let object = value
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField { field: "tool_call" })?;
    let function = object.get("function").and_then(Value::as_object);
    let input = match function
        .and_then(|function| function.get("arguments"))
        .or_else(|| object.get("arguments"))
    {
        Some(Value::String(raw)) => {
            serde_json::from_str(raw).map_err(|_| V3AnthropicCodecError::MalformedField {
                field: "tool_call arguments",
            })?
        }
        Some(value) => value.to_owned(),
        None => json!({}),
    };
    Ok(json!({
        "type":"tool_use",
        "id": object.get("id").cloned().unwrap_or(Value::Null),
        "name": function
            .and_then(|function| function.get("name"))
            .or_else(|| object.get("name"))
            .cloned()
            .unwrap_or(Value::Null),
        "input": input
    }))
}

fn responses_input_array_as_anthropic_messages(
    items: &[Value],
    system_parts: &mut Vec<String>,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let mut messages = Vec::new();
    let mut index = 0usize;
    while index < items.len() {
        let item = &items[index];
        if responses_input_item_type(item) == Some("reasoning") {
            index += 1;
            continue;
        }
        if is_responses_tool_call_item(item) {
            let mut tool_uses = Vec::new();
            let mut expected_ids = Vec::new();
            while index < items.len() {
                let current = &items[index];
                if responses_input_item_type(current) == Some("reasoning") {
                    index += 1;
                    continue;
                }
                if !is_responses_tool_call_item(current) {
                    break;
                }
                let object = current
                    .as_object()
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "input item",
                    })?;
                expected_ids.push(responses_tool_call_id_value(object));
                tool_uses.push(responses_tool_call_as_anthropic_tool_use(object)?);
                index += 1;
            }

            let mut assistant_interleaved_content = Vec::new();
            while index < items.len() {
                let current = &items[index];
                if responses_input_item_type(current) == Some("reasoning") {
                    index += 1;
                    continue;
                }
                if is_responses_tool_output_item(current) {
                    break;
                }
                let Some(object) = current.as_object() else {
                    break;
                };
                if object.get("type").and_then(Value::as_str) != Some("message") {
                    break;
                }
                let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
                if role == "system" || role == "developer" {
                    append_responses_instruction_part(system_parts, object.get("content"));
                    index += 1;
                    continue;
                }
                if role != "assistant" {
                    break;
                }
                assistant_interleaved_content.extend(responses_content_as_anthropic_content(
                    object.get("content"),
                )?);
                index += 1;
            }

            let mut tool_results = Vec::new();
            let mut result_ids = Vec::new();
            while index < items.len() {
                let current = &items[index];
                if responses_input_item_type(current) == Some("reasoning") {
                    index += 1;
                    continue;
                }
                if !is_responses_tool_output_item(current) {
                    break;
                }
                let object = current
                    .as_object()
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "input item",
                    })?;
                let result_id = responses_tool_output_id_value(object);
                if !expected_ids.iter().any(|expected| expected == &result_id) {
                    return Err(V3AnthropicCodecError::MalformedField {
                        field: "function_call_output",
                    });
                }
                result_ids.push(result_id);
                tool_results.push(responses_tool_output_as_anthropic_tool_result(object));
                index += 1;
            }

            let all_results_present = expected_ids
                .iter()
                .all(|expected| result_ids.iter().any(|actual| actual == expected));
            if tool_results.is_empty() || !all_results_present {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "function_call_output",
                });
            }

            let mut assistant_content = tool_uses;
            assistant_content.extend(assistant_interleaved_content);
            messages.push(json!({
                "role":"assistant",
                "content": assistant_content
            }));
            messages.push(json!({
                "role":"user",
                "content": tool_results
            }));
            continue;
        }
        if is_responses_tool_output_item(item) {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "function_call_output",
            });
        }
        responses_input_item_as_anthropic_messages(item, &mut messages, system_parts)?;
        index += 1;
    }
    Ok(messages)
}

fn responses_input_item_as_anthropic_messages(
    item: &Value,
    messages: &mut Vec<Value>,
    system_parts: &mut Vec<String>,
) -> Result<(), V3AnthropicCodecError> {
    let object = item
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "input item",
        })?;
    match object.get("type").and_then(Value::as_str) {
        Some("reasoning") => Ok(()),
        Some("function_call") | Some("custom_tool_call") | Some("tool_call") => {
            messages.push(json!({
                "role":"assistant",
                "content":[responses_tool_call_as_anthropic_tool_use(object)?]
            }));
            Ok(())
        }
        Some("function_call_output")
        | Some("custom_tool_call_output")
        | Some("tool_call_output") => {
            messages.push(json!({
                "role":"user",
                "content":[responses_tool_output_as_anthropic_tool_result(object)]
            }));
            Ok(())
        }
        _ => {
            let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
            if role == "system" || role == "developer" {
                append_responses_instruction_part(system_parts, object.get("content"));
                return Ok(());
            }
            let content = responses_content_as_anthropic_content(object.get("content"))?;
            if content.is_empty() {
                return Ok(());
            }
            messages.push(json!({
                "role": role,
                "content": content
            }));
            Ok(())
        }
    }
}

fn responses_input_item_type(item: &Value) -> Option<&str> {
    item.as_object()
        .and_then(|object| object.get("type"))
        .and_then(Value::as_str)
}

fn is_responses_tool_call_item(item: &Value) -> bool {
    matches!(
        responses_input_item_type(item),
        Some("function_call" | "custom_tool_call" | "tool_call")
    )
}

fn is_responses_tool_output_item(item: &Value) -> bool {
    matches!(
        responses_input_item_type(item),
        Some("function_call_output" | "custom_tool_call_output" | "tool_call_output")
    )
}

fn responses_tool_call_id_value(object: &Map<String, Value>) -> Value {
    object
        .get("call_id")
        .or_else(|| object.get("id"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn responses_tool_output_id_value(object: &Map<String, Value>) -> Value {
    object
        .get("call_id")
        .or_else(|| object.get("tool_call_id"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn responses_tool_call_as_anthropic_tool_use(
    object: &Map<String, Value>,
) -> Result<Value, V3AnthropicCodecError> {
    Ok(json!({
        "type":"tool_use",
        "id": responses_tool_call_id_value(object),
        "name": object.get("name").cloned().unwrap_or(Value::Null),
        "input": responses_function_call_input(object)?
    }))
}

fn responses_tool_output_as_anthropic_tool_result(object: &Map<String, Value>) -> Value {
    json!({
        "type":"tool_result",
        "tool_use_id": responses_tool_output_id_value(object),
        "content": responses_tool_output_as_anthropic_content(object.get("output"))
    })
}

fn responses_content_as_anthropic_content(
    value: Option<&Value>,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    match value {
        Value::String(text) => Ok(vec![json!({"type":"text","text":text})]),
        Value::Array(parts) => parts
            .iter()
            .map(responses_content_part_as_anthropic_content_part)
            .collect(),
        Value::Object(_) => Ok(vec![responses_content_part_as_anthropic_content_part(
            value,
        )?]),
        _ => Err(V3AnthropicCodecError::MalformedField { field: "content" }),
    }
}

fn responses_content_part_as_anthropic_content_part(
    part: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let object = part
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "content part",
        })?;
    match object.get("type").and_then(Value::as_str) {
        Some("input_text" | "output_text" | "text") => Ok(json!({
            "type":"text",
            "text": object.get("text").cloned().unwrap_or(Value::String(String::new()))
        })),
        Some("input_image" | "image") => responses_image_part_as_anthropic_image(part),
        Some("refusal") => Ok(json!({
            "type":"text",
            "text": object.get("refusal").or_else(|| object.get("text")).cloned().unwrap_or(Value::String(String::new()))
        })),
        _ => Err(V3AnthropicCodecError::MalformedField {
            field: "content part type",
        }),
    }
}

fn responses_image_part_as_anthropic_image(part: &Value) -> Result<Value, V3AnthropicCodecError> {
    let image_url = part
        .get("image_url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(V3AnthropicCodecError::MalformedField { field: "image_url" })?;
    if let Some((media_type, data)) = image_url.strip_prefix("data:").and_then(|rest| {
        let (media_type, data) = rest.split_once(";base64,")?;
        Some((media_type, data))
    }) {
        return Ok(json!({
            "type":"image",
            "source":{"type":"base64","media_type":media_type,"data":data}
        }));
    }
    Ok(json!({
        "type":"image",
        "source":{"type":"url","url":image_url}
    }))
}

fn responses_function_call_input(
    object: &Map<String, Value>,
) -> Result<Value, V3AnthropicCodecError> {
    if object.get("type").and_then(Value::as_str) == Some("custom_tool_call") {
        return match object.get("input") {
            Some(Value::String(raw)) => Ok(json!({"input": raw})),
            Some(value) => Ok(value.to_owned()),
            None => Ok(json!({})),
        };
    }
    match object.get("arguments").or_else(|| object.get("input")) {
        Some(Value::String(raw)) => Ok(serde_json::from_str(raw).unwrap_or_else(|_| json!({}))),
        Some(value) => Ok(value.to_owned()),
        None => Ok(json!({})),
    }
}

fn responses_tool_output_as_anthropic_content(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => Value::String(text.clone()),
        Some(value) => Value::String(serde_json::to_string(value).unwrap_or_default()),
        None => Value::String(String::new()),
    }
}

fn responses_tools_for_anthropic_wire(
    object: &Map<String, Value>,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let mut output = Vec::new();
    let mut seen_names = HashSet::new();
    append_responses_tools_for_anthropic_wire(object.get("tools"), &mut output, &mut seen_names)?;
    for item in object
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) == Some("additional_tools") {
            append_responses_tools_for_anthropic_wire(
                item.get("tools"),
                &mut output,
                &mut seen_names,
            )?;
        }
    }
    Ok(output)
}

fn append_responses_tools_for_anthropic_wire(
    tools: Option<&Value>,
    output: &mut Vec<Value>,
    seen_names: &mut HashSet<String>,
) -> Result<(), V3AnthropicCodecError> {
    for tool in tools.and_then(Value::as_array).into_iter().flatten() {
        let tool_object = tool
            .as_object()
            .ok_or(V3AnthropicCodecError::MalformedField { field: "tools[]" })?;
        let anthropic_tool = responses_tool_as_anthropic_tool(tool_object)?;
        let name = anthropic_tool
            .get("name")
            .and_then(Value::as_str)
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "tools[].name",
            })?
            .to_string();
        if seen_names.insert(name) {
            output.push(anthropic_tool);
        }
    }
    Ok(())
}

fn responses_tool_as_anthropic_tool(
    tool: &Map<String, Value>,
) -> Result<Value, V3AnthropicCodecError> {
    let mut output = Map::new();
    let name = tool
        .get("name")
        .or_else(|| {
            tool.get("function")
                .and_then(|function| function.get("name"))
        })
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            tool.get("type")
                .and_then(Value::as_str)
                .filter(|tool_type| matches!(*tool_type, "tool_search" | "web_search"))
                .map(str::to_string)
        })
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "tools[].name",
        })?;
    output.insert("name".to_string(), Value::String(name));
    if let Some(description) = tool.get("description").or_else(|| {
        tool.get("function")
            .and_then(|function| function.get("description"))
    }) {
        output.insert("description".to_string(), description.clone());
    }
    output.insert(
        "input_schema".to_string(),
        tool.get("parameters")
            .or_else(|| {
                tool.get("function")
                    .and_then(|function| function.get("parameters"))
            })
            .cloned()
            .unwrap_or_else(|| json!({"type":"object"})),
    );
    Ok(Value::Object(output))
}

fn responses_tool_choice_as_anthropic_tool_choice(
    value: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    if let Some(choice) = value.as_str() {
        return match choice {
            "auto" | "none" => Ok(json!({"type":choice})),
            "required" => Ok(json!({"type":"any"})),
            _ => Err(V3AnthropicCodecError::MalformedField {
                field: "tool_choice",
            }),
        };
    }
    let Some(object) = value.as_object() else {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "tool_choice",
        });
    };
    match object.get("type").and_then(Value::as_str) {
        Some("function") | Some("tool") => Ok(object
            .get("name")
            .or_else(|| {
                object
                    .get("function")
                    .and_then(|function| function.get("name"))
            })
            .cloned()
            .map(|name| json!({"type":"tool","name":name}))
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "tool_choice.name",
            })?),
        Some("auto") | Some("any") | Some("none") => Ok(json!({
            "type": object.get("type").cloned().unwrap_or(Value::Null)
        })),
        Some("required") => Ok(json!({"type":"any"})),
        _ => Err(V3AnthropicCodecError::MalformedField {
            field: "tool_choice",
        }),
    }
}

fn anthropic_usage_as_responses_usage(value: Option<&Value>) -> Option<Value> {
    let object = value?.as_object()?;
    let input = object
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = object
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let mut usage = Map::new();
    usage.insert("input_tokens".to_string(), json!(input));
    usage.insert("output_tokens".to_string(), json!(output));
    usage.insert("total_tokens".to_string(), json!(input + output));
    if let Some(cache_creation) = object.get("cache_creation_input_tokens") {
        usage.insert(
            "cache_creation_input_tokens".to_string(),
            cache_creation.clone(),
        );
    }
    if let Some(cache_read) = object.get("cache_read_input_tokens") {
        usage.insert("cache_read_input_tokens".to_string(), cache_read.clone());
    }
    Some(Value::Object(usage))
}
