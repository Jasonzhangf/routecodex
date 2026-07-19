use super::{V3HubEntryProtocol, V3HubProviderWireProtocol, V3HubTransportIntent};
use serde_json::{json, Map, Value};

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
    output.insert(
        "input".to_string(),
        Value::Array(encode_anthropic_messages_as_responses_semantic(
            object
                .get("messages")
                .and_then(Value::as_array)
                .ok_or(V3AnthropicCodecError::MessagesNotArray)?,
        )),
    );
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        output.insert(
            "tools".to_string(),
            Value::Array(tools.iter().filter_map(Value::as_object).map(|tool| {
                json!({
                    "type":"function",
                    "name":tool.get("name").cloned().unwrap_or(Value::Null),
                    "parameters":tool.get("input_schema").cloned().unwrap_or_else(|| json!({"type":"object"}))
                })
            }).collect::<Vec<_>>()),
        );
    }
    if object.get("thinking").is_some() {
        output.insert("reasoning".to_string(), json!({"effort":"medium"}));
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

fn encode_anthropic_messages_as_responses_semantic(messages: &[Value]) -> Vec<Value> {
    let mut encoded = Vec::new();
    for message in messages {
        let role = message.get("role").cloned().unwrap_or(Value::Null);
        let mut content = match message.get("content") {
            Some(Value::String(text)) => vec![json!({"type":"input_text","text":text})],
            Some(Value::Array(parts)) => parts.iter().filter(|part| part.get("type").and_then(Value::as_str) == Some("text")).map(|part| json!({"type":"input_text","text":part.get("text").cloned().unwrap_or(Value::Null)})).collect(),
            _ => Vec::new(),
        };
        if !content.is_empty() {
            encoded.push(json!({"role":role,"content":std::mem::take(&mut content)}));
        }
        if let Some(parts) = message.get("content").and_then(Value::as_array) {
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("tool_use") => encoded.push(json!({"type":"function_call","call_id":part.get("id").cloned().unwrap_or(Value::Null),"name":part.get("name").cloned().unwrap_or(Value::Null),"arguments":serde_json::to_string(part.get("input").unwrap_or(&Value::Null)).unwrap_or_else(|_| "null".to_string())})),
                    Some("tool_result") => encoded.push(json!({"type":"function_call_output","call_id":part.get("tool_use_id").cloned().unwrap_or(Value::Null),"output":anthropic_tool_result_output_as_responses_semantic(part.get("content"))})),
                    _ => {}
                }
            }
        }
    }
    encoded
}

fn anthropic_tool_result_output_as_responses_semantic(content: Option<&Value>) -> Value {
    match content {
        Some(Value::String(text)) => Value::String(text.clone()),
        Some(value) => {
            Value::String(serde_json::to_string(value).unwrap_or_else(|_| "null".into()))
        }
        None => Value::String(String::new()),
    }
}
