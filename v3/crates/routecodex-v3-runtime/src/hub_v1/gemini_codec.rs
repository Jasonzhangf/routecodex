use super::{V3HubEntryProtocol, V3HubProviderWireProtocol, V3HubTransportIntent};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3GeminiCodecStage {
    ClientInputToHubSemantic,
    HubSemanticToProviderWire,
    ProviderRawToHubResponseSemantic,
    HubResponseSemanticToClientProjection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3GeminiCodecTrace {
    pub stage: V3GeminiCodecStage,
    pub entry_protocol: V3HubEntryProtocol,
    pub provider_protocol: V3HubProviderWireProtocol,
    pub transport_intent: V3HubTransportIntent,
}

macro_rules! payload_wrapper {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq)]
        pub struct $name {
            payload: Value,
            trace: V3GeminiCodecTrace,
        }

        impl $name {
            pub fn payload(&self) -> &Value {
                &self.payload
            }

            pub fn trace(&self) -> &V3GeminiCodecTrace {
                &self.trace
            }
        }
    };
}

payload_wrapper!(V3GeminiHubRequestSemantic);
payload_wrapper!(V3GeminiProviderWirePayload);
payload_wrapper!(V3GeminiHubResponseSemantic);
payload_wrapper!(V3GeminiClientProjection);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3GeminiCodecError {
    #[error("Gemini codec accepts only the Gemini entry protocol")]
    EntryProtocolNotGemini,
    #[error("Gemini codec accepts only the Gemini provider protocol")]
    ProviderProtocolNotGemini,
    #[error("Gemini codec payload must be an object")]
    PayloadNotObject,
    #[error("Gemini codec payload leaked RouteCodex side-channel field: {field}")]
    SideChannelLeaked { field: &'static str },
    #[error("Gemini request contents must be an array")]
    ContentsNotArray,
    #[error("Gemini content parts must be an array")]
    PartsNotArray,
    #[error("Gemini response candidates must be an array")]
    CandidatesNotArray,
    #[error("Gemini provider error requires error.message")]
    MalformedProviderError,
}

pub fn validate_v3_gemini_client_input_payload(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
) -> Result<(), V3GeminiCodecError> {
    if entry_protocol != V3HubEntryProtocol::Gemini {
        return Err(V3GeminiCodecError::EntryProtocolNotGemini);
    }
    validate_request(payload)
}

pub fn validate_v3_gemini_provider_response_payload(
    payload: &Value,
    provider_protocol: V3HubProviderWireProtocol,
) -> Result<(), V3GeminiCodecError> {
    if provider_protocol != V3HubProviderWireProtocol::Gemini {
        return Err(V3GeminiCodecError::ProviderProtocolNotGemini);
    }
    validate_response(payload)
}

pub fn characterize_v3_gemini_client_input_to_hub_semantic(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<V3GeminiHubRequestSemantic, V3GeminiCodecError> {
    validate_v3_gemini_client_input_payload(&payload, entry_protocol)?;
    Ok(V3GeminiHubRequestSemantic {
        payload,
        trace: trace(
            V3GeminiCodecStage::ClientInputToHubSemantic,
            transport_intent,
        ),
    })
}

pub fn characterize_v3_gemini_hub_semantic_to_provider_wire(
    semantic: V3GeminiHubRequestSemantic,
) -> Result<V3GeminiProviderWirePayload, V3GeminiCodecError> {
    validate_request(&semantic.payload)?;
    Ok(V3GeminiProviderWirePayload {
        payload: semantic.payload,
        trace: trace(
            V3GeminiCodecStage::HubSemanticToProviderWire,
            semantic.trace.transport_intent,
        ),
    })
}

pub fn characterize_v3_gemini_provider_raw_to_hub_response_semantic(
    payload: Value,
    provider_protocol: V3HubProviderWireProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<V3GeminiHubResponseSemantic, V3GeminiCodecError> {
    validate_v3_gemini_provider_response_payload(&payload, provider_protocol)?;
    Ok(V3GeminiHubResponseSemantic {
        payload,
        trace: trace(
            V3GeminiCodecStage::ProviderRawToHubResponseSemantic,
            transport_intent,
        ),
    })
}

pub fn characterize_v3_gemini_hub_response_semantic_to_client_projection(
    semantic: V3GeminiHubResponseSemantic,
) -> Result<V3GeminiClientProjection, V3GeminiCodecError> {
    validate_response(&semantic.payload)?;
    Ok(V3GeminiClientProjection {
        payload: semantic.payload,
        trace: trace(
            V3GeminiCodecStage::HubResponseSemanticToClientProjection,
            semantic.trace.transport_intent,
        ),
    })
}

fn trace(stage: V3GeminiCodecStage, transport_intent: V3HubTransportIntent) -> V3GeminiCodecTrace {
    V3GeminiCodecTrace {
        stage,
        entry_protocol: V3HubEntryProtocol::Gemini,
        provider_protocol: V3HubProviderWireProtocol::Gemini,
        transport_intent,
    }
}

fn validate_request(payload: &Value) -> Result<(), V3GeminiCodecError> {
    reject_side_channel_fields(payload)?;
    let contents = payload
        .get("contents")
        .and_then(Value::as_array)
        .ok_or(V3GeminiCodecError::ContentsNotArray)?;
    validate_content_shapes(contents)
}

fn validate_content_shapes(contents: &[Value]) -> Result<(), V3GeminiCodecError> {
    for content in contents {
        content
            .get("parts")
            .and_then(Value::as_array)
            .ok_or(V3GeminiCodecError::PartsNotArray)?;
    }
    Ok(())
}

fn validate_response(payload: &Value) -> Result<(), V3GeminiCodecError> {
    reject_side_channel_fields(payload)?;
    if payload.get("error").is_some() {
        return validate_provider_error(payload);
    }
    let candidates = payload
        .get("candidates")
        .and_then(Value::as_array)
        .ok_or(V3GeminiCodecError::CandidatesNotArray)?;
    for candidate in candidates {
        let parts = candidate
            .get("content")
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
            .ok_or(V3GeminiCodecError::PartsNotArray)?;
        for part in parts {
            require_object(part)?;
        }
    }
    Ok(())
}

fn validate_provider_error(payload: &Value) -> Result<(), V3GeminiCodecError> {
    let valid = payload
        .get("error")
        .and_then(Value::as_object)
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .is_some_and(|message| !message.is_empty());
    if valid {
        Ok(())
    } else {
        Err(V3GeminiCodecError::MalformedProviderError)
    }
}

fn reject_side_channel_fields(payload: &Value) -> Result<(), V3GeminiCodecError> {
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
            return Err(V3GeminiCodecError::SideChannelLeaked { field });
        }
    }
    Ok(())
}

fn require_object(payload: &Value) -> Result<&Map<String, Value>, V3GeminiCodecError> {
    payload
        .as_object()
        .ok_or(V3GeminiCodecError::PayloadNotObject)
}
