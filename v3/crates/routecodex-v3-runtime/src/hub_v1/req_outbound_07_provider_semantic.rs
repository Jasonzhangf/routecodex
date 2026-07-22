use super::{V3HubExecutionMode, V3HubProviderWireProtocol, V3HubReqTarget06Resolved};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqOutbound07ProviderSemantic {
    pub(crate) previous: V3HubReqTarget06Resolved,
    pub(crate) provider_protocol: V3HubProviderWireProtocol,
}

pub fn build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
    input: V3HubReqTarget06Resolved,
    provider_protocol: V3HubProviderWireProtocol,
) -> V3HubReqOutbound07ProviderSemantic {
    V3HubReqOutbound07ProviderSemantic {
        previous: input,
        provider_protocol,
    }
}

impl V3HubReqOutbound07ProviderSemantic {
    pub(crate) fn selected_target(&self) -> &routecodex_v3_target::V3TargetCandidate {
        &self.previous.selected_target
    }

    pub(crate) fn execution_mode(&self) -> V3HubExecutionMode {
        self.previous.previous.execution
    }

    pub(crate) fn provider_semantic_payload(&self) -> &Value {
        &self
            .previous
            .previous
            .previous
            .previous
            .previous
            .previous
            .payload
            .0
    }

    pub(crate) fn original_responses_payload(&self) -> Option<&Value> {
        self.previous
            .previous
            .previous
            .previous
            .previous
            .original_responses_payload
            .as_ref()
    }
}
