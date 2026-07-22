use super::V3HubRespContinuation04Committed;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespOutbound05ClientSemantic {
    pub(crate) previous: V3HubRespContinuation04Committed,
}

pub fn build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(
    input: V3HubRespContinuation04Committed,
) -> V3HubRespOutbound05ClientSemantic {
    V3HubRespOutbound05ClientSemantic { previous: input }
}
