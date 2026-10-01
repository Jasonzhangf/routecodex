use super::{
    V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource, V3HubProviderWireProtocol,
    V3HubResponsePayload, V3HubTransportIntent, V3ProviderCompatProfileId,
};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct V3ProviderRespInbound01Raw {
    pub(crate) payload: V3HubResponsePayload,
    pub(crate) raw_sse_chunks: Option<Arc<Vec<Vec<u8>>>>,
    pub(crate) entry_protocol: V3HubEntryProtocol,
    pub(crate) provider_protocol: V3HubProviderWireProtocol,
    /// The raw provider wire protocol that produced this response. It equals
    /// `provider_protocol` except for the Responses Relay SSE path, where the
    /// payload has already been materialized into canonical Responses while the
    /// source wire was Anthropic. `provider_protocol` keeps the canonical
    /// semantic protocol for normalization/compat consumers; this witness is
    /// only read by the Resp03 source-provenance gate. It is typed control
    /// plumbing and is never written into a business payload.
    pub(crate) source_provider_protocol: V3HubProviderWireProtocol,
    pub(crate) execution: V3HubExecutionMode,
    pub(crate) invocation_source: V3HubInvocationSource,
    pub(crate) transport_intent: V3HubTransportIntent,
    pub(crate) compatibility_profile: V3ProviderCompatProfileId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderRespInbound01RawContext {
    pub(crate) entry_protocol: V3HubEntryProtocol,
    pub(crate) provider_protocol: V3HubProviderWireProtocol,
    pub(crate) source_provider_protocol: V3HubProviderWireProtocol,
    pub(crate) execution: V3HubExecutionMode,
    pub(crate) invocation_source: V3HubInvocationSource,
    pub(crate) transport_intent: V3HubTransportIntent,
    pub(crate) compatibility_profile: V3ProviderCompatProfileId,
}

impl V3ProviderRespInbound01RawContext {
    pub fn new(
        entry_protocol: V3HubEntryProtocol,
        provider_protocol: V3HubProviderWireProtocol,
        execution: V3HubExecutionMode,
        invocation_source: V3HubInvocationSource,
        transport_intent: V3HubTransportIntent,
    ) -> Self {
        Self {
            entry_protocol,
            provider_protocol,
            source_provider_protocol: provider_protocol,
            execution,
            invocation_source,
            transport_intent,
            compatibility_profile: V3ProviderCompatProfileId::Passthrough,
        }
    }

    pub fn with_source_provider_protocol(
        mut self,
        source_provider_protocol: V3HubProviderWireProtocol,
    ) -> Self {
        self.source_provider_protocol = source_provider_protocol;
        self
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
    execution: V3HubExecutionMode,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
) -> V3ProviderRespInbound01Raw {
    build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        payload,
        V3ProviderRespInbound01RawContext::new(
            entry_protocol,
            provider_protocol,
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
        raw_sse_chunks: None,
        entry_protocol: context.entry_protocol,
        provider_protocol: context.provider_protocol,
        source_provider_protocol: context.source_provider_protocol,
        execution: context.execution,
        invocation_source: context.invocation_source,
        transport_intent: context.transport_intent,
        compatibility_profile: context.compatibility_profile,
    }
}

pub fn build_v3_provider_resp_inbound_01_raw_from_sse_chunks(
    chunks: Vec<Vec<u8>>,
    context: V3ProviderRespInbound01RawContext,
) -> V3ProviderRespInbound01Raw {
    V3ProviderRespInbound01Raw {
        payload: V3HubResponsePayload(Arc::new(Value::Null)),
        raw_sse_chunks: Some(Arc::new(chunks)),
        entry_protocol: context.entry_protocol,
        provider_protocol: context.provider_protocol,
        source_provider_protocol: context.source_provider_protocol,
        execution: context.execution,
        invocation_source: context.invocation_source,
        transport_intent: context.transport_intent,
        compatibility_profile: context.compatibility_profile,
    }
}

impl V3ProviderRespInbound01Raw {
    pub(crate) fn take_raw_sse_chunks(&mut self) -> Option<Vec<Vec<u8>>> {
        let chunks = self.raw_sse_chunks.take()?;
        Some(Arc::try_unwrap(chunks).unwrap_or_else(|chunks| chunks.as_ref().clone()))
    }
}
