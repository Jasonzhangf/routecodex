use super::{
    ProviderRespCompat02ProviderCompat, V3HubResponseNormalizedKind, V3HubTransportIntent,
    V3ProviderRespInbound01Raw,
};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespInbound02Normalized {
    pub(crate) previous: ProviderRespCompat02ProviderCompat,
    pub(crate) normalized_kind: V3HubResponseNormalizedKind,
}

pub fn build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(
    input: ProviderRespCompat02ProviderCompat,
) -> V3HubRespInbound02Normalized {
    let normalized_kind = match input.raw().transport_intent {
        V3HubTransportIntent::Json => V3HubResponseNormalizedKind::Json,
        V3HubTransportIntent::Sse => V3HubResponseNormalizedKind::Sse,
    };
    V3HubRespInbound02Normalized {
        previous: input,
        normalized_kind,
    }
}

impl V3HubRespInbound02Normalized {
    pub fn provider_raw(&self) -> &V3ProviderRespInbound01Raw {
        self.previous.raw()
    }

    pub(crate) fn provider_raw_mut(&mut self) -> &mut V3ProviderRespInbound01Raw {
        self.previous.raw_mut()
    }

    pub(crate) fn provider_payload(&self) -> &Arc<Value> {
        &self.provider_raw().payload.0
    }

    pub(crate) fn provider_payload_mut(&mut self) -> &mut Arc<Value> {
        &mut self.provider_raw_mut().payload.0
    }

    pub fn normalized_kind(&self) -> V3HubResponseNormalizedKind {
        self.normalized_kind
    }
}
