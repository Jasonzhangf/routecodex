use super::{V3HubEntryProtocol, V3HubInvocationSource, V3HubOpaquePayload, V3HubTransportIntent};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqInbound01ClientRaw {
    pub(crate) payload: V3HubOpaquePayload,
    pub(crate) entry_protocol: V3HubEntryProtocol,
    pub(crate) invocation_source: V3HubInvocationSource,
    pub(crate) transport_intent: V3HubTransportIntent,
}

pub fn build_v3_hub_req_inbound_01_client_raw(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
) -> V3HubReqInbound01ClientRaw {
    V3HubReqInbound01ClientRaw {
        payload: V3HubOpaquePayload(payload),
        entry_protocol,
        invocation_source,
        transport_intent,
    }
}
