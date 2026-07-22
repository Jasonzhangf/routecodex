use super::{V3HubContinuationOwnership, V3HubReqInbound02Normalized};

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqContinuation03Classified {
    pub(crate) previous: V3HubReqInbound02Normalized,
    pub(crate) continuation: V3HubContinuationOwnership,
}

pub fn build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(
    input: V3HubReqInbound02Normalized,
    continuation: V3HubContinuationOwnership,
) -> V3HubReqContinuation03Classified {
    V3HubReqContinuation03Classified {
        previous: input,
        continuation,
    }
}
