use super::{
    build_v3_hub_req_inbound_01_client_raw, build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01,
    build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04,
    characterize_v3_anthropic_client_input_to_hub_semantic,
    validate_v3_anthropic_hub_response_payload_for_client_projection, V3AnthropicCodecError,
    V3HubEntryProtocol, V3HubExecutionMode, V3HubOpaquePayload, V3HubProviderWireProtocol,
    V3HubReqInbound01ClientRaw, V3HubReqInbound02Normalized, V3HubRespContinuation04Committed,
    V3HubRespOutbound05ClientSemantic, V3HubTransportIntent,
};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3AnthropicRelayProtocolHookError {
    #[error("Anthropic Relay hook accepts only the Anthropic entry protocol")]
    EntryProtocolNotAnthropic,
    #[error("Anthropic Relay hook accepts only Relay execution")]
    ExecutionModeNotRelay,
    #[error("Anthropic Relay hook keeps Responses as the provider wire protocol")]
    ProviderWireProtocolNotResponses,
    #[error(transparent)]
    Codec(#[from] V3AnthropicCodecError),
}

impl V3HubReqInbound02Normalized {
    pub fn payload(&self) -> &Value {
        &self.previous.payload.0
    }

    pub fn entry_protocol(&self) -> V3HubEntryProtocol {
        self.previous.entry_protocol
    }

    pub fn transport_intent(&self) -> V3HubTransportIntent {
        self.previous.transport_intent
    }

    pub fn node_id(&self) -> &'static str {
        "V3HubReqInbound02Normalized"
    }
}

impl V3HubRespOutbound05ClientSemantic {
    pub fn payload(&self) -> &Value {
        &self.previous.previous.previous.previous.payload.0
    }

    pub fn entry_protocol(&self) -> V3HubEntryProtocol {
        self.previous.previous.previous.previous.entry_protocol
    }

    pub fn execution_mode(&self) -> V3HubExecutionMode {
        self.previous.previous.previous.previous.execution
    }

    pub fn provider_wire_protocol(&self) -> V3HubProviderWireProtocol {
        self.previous.previous.previous.previous.provider_protocol
    }

    pub fn transport_intent(&self) -> V3HubTransportIntent {
        self.previous.previous.previous.previous.transport_intent
    }

    pub fn node_id(&self) -> &'static str {
        "V3HubRespOutbound05ClientSemantic"
    }
}

#[derive(Debug, Clone, Copy)]
pub struct V3AnthropicRelayProtocolHooks {
    req_inbound: fn(
        V3HubReqInbound01ClientRaw,
        V3HubExecutionMode,
        V3HubProviderWireProtocol,
    ) -> Result<V3HubReqInbound02Normalized, V3AnthropicRelayProtocolHookError>,
    client_projection:
        fn(
            V3HubRespContinuation04Committed,
        ) -> Result<V3HubRespOutbound05ClientSemantic, V3AnthropicRelayProtocolHookError>,
}

pub fn compile_v3_anthropic_relay_protocol_hooks() -> V3AnthropicRelayProtocolHooks {
    V3AnthropicRelayProtocolHooks {
        req_inbound: run_v3_anthropic_relay_req_inbound_hook,
        client_projection: run_v3_anthropic_relay_client_projection_hook,
    }
}

impl V3AnthropicRelayProtocolHooks {
    pub fn req_inbound(
        &self,
        raw: V3HubReqInbound01ClientRaw,
        execution: V3HubExecutionMode,
        provider_wire_protocol: V3HubProviderWireProtocol,
    ) -> Result<V3HubReqInbound02Normalized, V3AnthropicRelayProtocolHookError> {
        (self.req_inbound)(raw, execution, provider_wire_protocol)
    }

    pub fn client_projection(
        &self,
        committed: V3HubRespContinuation04Committed,
    ) -> Result<V3HubRespOutbound05ClientSemantic, V3AnthropicRelayProtocolHookError> {
        (self.client_projection)(committed)
    }
}

fn run_v3_anthropic_relay_req_inbound_hook(
    raw: V3HubReqInbound01ClientRaw,
    execution: V3HubExecutionMode,
    provider_wire_protocol: V3HubProviderWireProtocol,
) -> Result<V3HubReqInbound02Normalized, V3AnthropicRelayProtocolHookError> {
    assert_anthropic_relay_responses_axes(raw.entry_protocol, execution, provider_wire_protocol)?;
    let V3HubReqInbound01ClientRaw {
        payload,
        entry_protocol,
        invocation_source,
        transport_intent,
    } = raw;
    let V3HubOpaquePayload(payload) = payload;
    let semantic = characterize_v3_anthropic_client_input_to_hub_semantic(
        payload,
        entry_protocol,
        transport_intent,
    )?;
    let raw = build_v3_hub_req_inbound_01_client_raw(
        semantic.into_payload(),
        entry_protocol,
        invocation_source,
        transport_intent,
    );
    Ok(build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(raw))
}

fn run_v3_anthropic_relay_client_projection_hook(
    committed: V3HubRespContinuation04Committed,
) -> Result<V3HubRespOutbound05ClientSemantic, V3AnthropicRelayProtocolHookError> {
    let raw = &committed.previous.previous.previous;
    let entry_protocol = raw.entry_protocol;
    let execution = raw.execution;
    let provider_wire_protocol = raw.provider_protocol;
    let transport_intent = raw.transport_intent;
    assert_anthropic_relay_responses_axes(entry_protocol, execution, provider_wire_protocol)?;
    validate_v3_anthropic_hub_response_payload_for_client_projection(
        &raw.payload.0,
        entry_protocol,
        transport_intent,
    )?;
    Ok(build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(committed))
}

fn assert_anthropic_relay_responses_axes(
    entry_protocol: V3HubEntryProtocol,
    execution: V3HubExecutionMode,
    provider_wire_protocol: V3HubProviderWireProtocol,
) -> Result<(), V3AnthropicRelayProtocolHookError> {
    if entry_protocol != V3HubEntryProtocol::Anthropic {
        return Err(V3AnthropicRelayProtocolHookError::EntryProtocolNotAnthropic);
    }
    if execution != V3HubExecutionMode::Relay {
        return Err(V3AnthropicRelayProtocolHookError::ExecutionModeNotRelay);
    }
    if provider_wire_protocol != V3HubProviderWireProtocol::Responses {
        return Err(V3AnthropicRelayProtocolHookError::ProviderWireProtocolNotResponses);
    }
    Ok(())
}
