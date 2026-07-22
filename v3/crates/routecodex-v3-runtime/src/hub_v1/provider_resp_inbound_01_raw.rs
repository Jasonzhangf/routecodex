use super::{
    V3HubContinuationOwnership, V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource,
    V3HubProviderWireProtocol, V3HubResponsePayload, V3HubTransportIntent,
    V3ProviderCompatProfileId,
};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct V3ProviderRespInbound01Raw {
    pub(crate) payload: V3HubResponsePayload,
    pub(crate) entry_protocol: V3HubEntryProtocol,
    pub(crate) provider_protocol: V3HubProviderWireProtocol,
    pub(crate) continuation: V3HubContinuationOwnership,
    pub(crate) execution: V3HubExecutionMode,
    pub(crate) invocation_source: V3HubInvocationSource,
    pub(crate) transport_intent: V3HubTransportIntent,
    pub(crate) compatibility_profile: V3ProviderCompatProfileId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderRespInbound01RawContext {
    pub(crate) entry_protocol: V3HubEntryProtocol,
    pub(crate) provider_protocol: V3HubProviderWireProtocol,
    pub(crate) continuation: V3HubContinuationOwnership,
    pub(crate) execution: V3HubExecutionMode,
    pub(crate) invocation_source: V3HubInvocationSource,
    pub(crate) transport_intent: V3HubTransportIntent,
    pub(crate) compatibility_profile: V3ProviderCompatProfileId,
}

impl V3ProviderRespInbound01RawContext {
    pub fn new(
        entry_protocol: V3HubEntryProtocol,
        provider_protocol: V3HubProviderWireProtocol,
        continuation: V3HubContinuationOwnership,
        execution: V3HubExecutionMode,
        invocation_source: V3HubInvocationSource,
        transport_intent: V3HubTransportIntent,
    ) -> Self {
        Self {
            entry_protocol,
            provider_protocol,
            continuation,
            execution,
            invocation_source,
            transport_intent,
            compatibility_profile: V3ProviderCompatProfileId::Passthrough,
        }
    }

    pub fn with_compatibility_profile(mut self, compatibility_profile: Option<&str>) -> Self {
        self.compatibility_profile = V3ProviderCompatProfileId::from_config(compatibility_profile);
        self
    }
}

pub fn build_v3_provider_resp_inbound_01_raw(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    provider_protocol: V3HubProviderWireProtocol,
    continuation: V3HubContinuationOwnership,
    execution: V3HubExecutionMode,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
) -> V3ProviderRespInbound01Raw {
    build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        payload,
        V3ProviderRespInbound01RawContext::new(
            entry_protocol,
            provider_protocol,
            continuation,
            execution,
            invocation_source,
            transport_intent,
        ),
    )
}

pub fn build_v3_provider_resp_inbound_01_raw_with_compat_profile(
    payload: Value,
    context: V3ProviderRespInbound01RawContext,
) -> V3ProviderRespInbound01Raw {
    V3ProviderRespInbound01Raw {
        payload: V3HubResponsePayload(Arc::new(payload)),
        entry_protocol: context.entry_protocol,
        provider_protocol: context.provider_protocol,
        continuation: context.continuation,
        execution: context.execution,
        invocation_source: context.invocation_source,
        transport_intent: context.transport_intent,
        compatibility_profile: context.compatibility_profile,
    }
}
