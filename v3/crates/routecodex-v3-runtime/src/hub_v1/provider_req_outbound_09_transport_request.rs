use super::V3ProviderReqOutbound08WirePayload;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct V3ProviderReqOutbound09TransportRequest {
    pub(crate) previous: V3ProviderReqOutbound08WirePayload,
}

pub fn build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(
    input: V3ProviderReqOutbound08WirePayload,
) -> V3ProviderReqOutbound09TransportRequest {
    V3ProviderReqOutbound09TransportRequest { previous: input }
}

impl V3ProviderReqOutbound09TransportRequest {
    pub(crate) fn into_provider_semantic_payload(self) -> Value {
        self.previous.previous.provider_semantic_payload().clone()
    }

    pub fn compat_profile_id(&self) -> &str {
        self.previous.compat_profile().as_str()
    }
}
