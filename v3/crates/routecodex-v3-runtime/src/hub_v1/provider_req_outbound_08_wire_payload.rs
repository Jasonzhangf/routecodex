use super::{ProviderReqCompat06ProviderCompat, V3ProviderCompatProfileId};

#[derive(Debug, Clone, PartialEq)]
pub struct V3ProviderReqOutbound08WirePayload {
    pub(crate) previous: ProviderReqCompat06ProviderCompat,
}

pub fn build_v3_provider_req_outbound_08_from_provider_req_compat_06(
    input: ProviderReqCompat06ProviderCompat,
) -> V3ProviderReqOutbound08WirePayload {
    V3ProviderReqOutbound08WirePayload { previous: input }
}

impl V3ProviderReqOutbound08WirePayload {
    pub(crate) fn compat_profile(&self) -> &V3ProviderCompatProfileId {
        self.previous.profile()
    }
}
