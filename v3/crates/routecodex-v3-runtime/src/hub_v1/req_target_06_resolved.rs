use super::{V3HubReqExecution05Planned, V3HubTargetResolution};

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqTarget06Resolved {
    pub(crate) previous: V3HubReqExecution05Planned,
    pub(crate) target_resolution: V3HubTargetResolution,
    pub(crate) selected_target: routecodex_v3_target::V3TargetCandidate,
}

pub fn build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
    input: V3HubReqExecution05Planned,
    target_resolution: V3HubTargetResolution,
    selected_target: routecodex_v3_target::V3TargetCandidate,
) -> V3HubReqTarget06Resolved {
    V3HubReqTarget06Resolved {
        previous: input,
        target_resolution,
        selected_target,
    }
}
