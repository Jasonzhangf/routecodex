use super::{V3HubEntryProtocol, V3HubProviderWireProtocol, V3HubTransportIntent};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3OpenAiChatCodecStage {
    ClientInputToHubSemantic,
    HubSemanticToProviderWire,
    ProviderRawToHubResponseSemantic,
    HubResponseSemanticToClientProjection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatCodecTrace {
    pub stage: V3OpenAiChatCodecStage,
    pub entry_protocol: V3HubEntryProtocol,
    pub provider_protocol: V3HubProviderWireProtocol,
    pub transport_intent: V3HubTransportIntent,
}

macro_rules! payload_wrapper {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq)]
        pub struct $name {
            payload: Value,
            trace: V3OpenAiChatCodecTrace,
        }

        impl $name {
            pub fn payload(&self) -> &Value {
                &self.payload
            }
            pub fn trace(&self) -> &V3OpenAiChatCodecTrace {
                &self.trace
            }
        }
    };
}

payload_wrapper!(V3OpenAiChatHubRequestSemantic);
payload_wrapper!(V3OpenAiChatProviderWirePayload);
payload_wrapper!(V3OpenAiChatHubResponseSemantic);
payload_wrapper!(V3OpenAiChatClientProjection);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3OpenAiChatCodecError {
    #[error("OpenAI Chat codec accepts only the OpenAI Chat entry protocol")]
    EntryProtocolNotOpenAiChat,
    #[error("OpenAI Chat codec accepts only the OpenAI Chat provider protocol")]
    ProviderProtocolNotOpenAiChat,
    #[error("OpenAI Chat codec payload must be an object")]
    PayloadNotObject,
    #[error("OpenAI Chat codec payload leaked RouteCodex side-channel field: {field}")]
    SideChannelLeaked { field: &'static str },
    #[error("OpenAI Chat request messages must be an array")]
    MessagesNotArray,
    #[error("OpenAI Chat response choices must be an array")]
    ChoicesNotArray,
    #[error("OpenAI Chat tool-call identity is missing, duplicated, or orphaned")]
    InvalidToolCallIdentity,
    #[error("OpenAI Chat SSE event is malformed")]
    MalformedSseEvent,
    #[error("OpenAI Chat provider error requires error.message")]
    MalformedProviderError,
}

pub fn characterize_v3_openai_chat_client_input_to_hub_semantic(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<V3OpenAiChatHubRequestSemantic, V3OpenAiChatCodecError> {
    if entry_protocol != V3HubEntryProtocol::OpenAiChat {
        return Err(V3OpenAiChatCodecError::EntryProtocolNotOpenAiChat);
    }
    validate_request(&payload)?;
    Ok(V3OpenAiChatHubRequestSemantic {
        payload,
        trace: trace(
            V3OpenAiChatCodecStage::ClientInputToHubSemantic,
            transport_intent,
        ),
    })
}

pub fn characterize_v3_openai_chat_hub_semantic_to_provider_wire(
    semantic: V3OpenAiChatHubRequestSemantic,
) -> Result<V3OpenAiChatProviderWirePayload, V3OpenAiChatCodecError> {
    validate_request(&semantic.payload)?;
    Ok(V3OpenAiChatProviderWirePayload {
        payload: semantic.payload,
        trace: trace(
            V3OpenAiChatCodecStage::HubSemanticToProviderWire,
            semantic.trace.transport_intent,
        ),
    })
}

pub fn characterize_v3_openai_chat_provider_raw_to_hub_response_semantic(
    payload: Value,
    provider_protocol: V3HubProviderWireProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<V3OpenAiChatHubResponseSemantic, V3OpenAiChatCodecError> {
    if provider_protocol != V3HubProviderWireProtocol::OpenAiChat {
        return Err(V3OpenAiChatCodecError::ProviderProtocolNotOpenAiChat);
    }
    validate_response(&payload, transport_intent)?;
    Ok(V3OpenAiChatHubResponseSemantic {
        payload,
        trace: trace(
            V3OpenAiChatCodecStage::ProviderRawToHubResponseSemantic,
            transport_intent,
        ),
    })
}

pub fn characterize_v3_openai_chat_hub_response_semantic_to_client_projection(
    semantic: V3OpenAiChatHubResponseSemantic,
) -> Result<V3OpenAiChatClientProjection, V3OpenAiChatCodecError> {
    validate_response(&semantic.payload, semantic.trace.transport_intent)?;
    Ok(V3OpenAiChatClientProjection {
        payload: semantic.payload,
        trace: trace(
            V3OpenAiChatCodecStage::HubResponseSemanticToClientProjection,
            semantic.trace.transport_intent,
        ),
    })
}

fn trace(
    stage: V3OpenAiChatCodecStage,
    transport_intent: V3HubTransportIntent,
) -> V3OpenAiChatCodecTrace {
    V3OpenAiChatCodecTrace {
        stage,
        entry_protocol: V3HubEntryProtocol::OpenAiChat,
        provider_protocol: V3HubProviderWireProtocol::OpenAiChat,
        transport_intent,
    }
}

fn validate_request(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {
    reject_side_channel_fields(payload)?;
    let messages = payload
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(V3OpenAiChatCodecError::MessagesNotArray)?;
    validate_message_tool_identity(messages)
}

fn validate_message_tool_identity(messages: &[Value]) -> Result<(), V3OpenAiChatCodecError> {
    let mut declared = BTreeSet::new();
    for message in messages {
        if let Some(calls) = message.get("tool_calls") {
            let calls = calls
                .as_array()
                .ok_or(V3OpenAiChatCodecError::InvalidToolCallIdentity)?;
            for call in calls {
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or(V3OpenAiChatCodecError::InvalidToolCallIdentity)?;
                if !declared.insert(id.to_owned()) {
                    return Err(V3OpenAiChatCodecError::InvalidToolCallIdentity);
                }
            }
        }
        if message.get("role").and_then(Value::as_str) == Some("tool") {
            let id = message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or(V3OpenAiChatCodecError::InvalidToolCallIdentity)?;
            if !declared.contains(id) {
                return Err(V3OpenAiChatCodecError::InvalidToolCallIdentity);
            }
        }
    }
    Ok(())
}

fn validate_response(
    payload: &Value,
    transport: V3HubTransportIntent,
) -> Result<(), V3OpenAiChatCodecError> {
    reject_side_channel_fields(payload)?;
    match transport {
        V3HubTransportIntent::Json => validate_json_response(payload),
        V3HubTransportIntent::Sse => validate_sse_event(payload),
    }
}

fn validate_json_response(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {
    if payload.get("error").is_some() {
        return validate_provider_error(payload);
    }
    let choices = payload
        .get("choices")
        .and_then(Value::as_array)
        .ok_or(V3OpenAiChatCodecError::ChoicesNotArray)?;
    let messages: Vec<Value> = choices
        .iter()
        .filter_map(|choice| choice.get("message").cloned())
        .collect();
    validate_message_tool_identity(&messages)
}

fn validate_sse_event(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {
    let object = require_object(payload)?;
    if object.get("object").and_then(Value::as_str) != Some("chat.completion.chunk")
        || !matches!(object.get("choices"), Some(Value::Array(_)))
    {
        return Err(V3OpenAiChatCodecError::MalformedSseEvent);
    }
    Ok(())
}

fn validate_provider_error(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {
    let valid = payload
        .get("error")
        .and_then(Value::as_object)
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .is_some_and(|message| !message.is_empty());
    if valid {
        Ok(())
    } else {
        Err(V3OpenAiChatCodecError::MalformedProviderError)
    }
}

fn reject_side_channel_fields(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {
    for key in require_object(payload)?.keys() {
        let label = match key.as_str() {
            "routecodex_internal" => Some("routecodex_internal"),
            "metadata_center" => Some("metadata_center"),
            "debug_snapshot" => Some("debug_snapshot"),
            "provider_protocol" => Some("provider_protocol"),
            "resource_handle" => Some("resource_handle"),
            "continuation_owner" => Some("continuation_owner"),
            _ => None,
        };
        if let Some(field) = label {
            return Err(V3OpenAiChatCodecError::SideChannelLeaked { field });
        }
    }
    Ok(())
}

fn require_object(payload: &Value) -> Result<&Map<String, Value>, V3OpenAiChatCodecError> {
    payload
        .as_object()
        .ok_or(V3OpenAiChatCodecError::PayloadNotObject)
}
