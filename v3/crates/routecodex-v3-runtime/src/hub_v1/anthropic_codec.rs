use super::{V3HubEntryProtocol, V3HubProviderWireProtocol, V3HubTransportIntent};
use serde_json::{Map, Value};

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
    reject_side_channel_fields(&semantic.payload)?;
    require_object(&semantic.payload)?;
    match semantic.trace.transport_intent {
        V3HubTransportIntent::Json => validate_json_response(&semantic.payload)?,
        V3HubTransportIntent::Sse => validate_sse_event(&semantic.payload)?,
    }
    Ok(V3AnthropicClientProjection {
        payload: semantic.payload,
        trace: trace(
            V3AnthropicCodecStage::HubResponseSemanticToClientProjection,
            semantic.trace.transport_intent,
        ),
    })
}

impl V3AnthropicHubRequestSemantic {
    pub fn payload(&self) -> &Value {
        &self.payload
    }

    pub fn trace(&self) -> &V3AnthropicCodecTrace {
        &self.trace
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
