use super::{V3HubEntryProtocol, V3HubProviderWireProtocol, V3HubReqTarget06Resolved};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqOutbound07ProviderSemantic {
    pub(crate) previous: V3HubReqTarget06Resolved,
    pub(crate) provider_protocol: V3HubProviderWireProtocol,
    provider_semantic_payload: Value,
}

pub fn build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
    input: V3HubReqTarget06Resolved,
    provider_protocol: V3HubProviderWireProtocol,
    web_search_route_eligibility: &routecodex_v3_target::V3TargetWebSearchRouteEligibility,
) -> V3HubReqOutbound07ProviderSemantic {
    let mut provider_semantic_payload = input.canonical_payload().clone();
    let selected_can_search = input
        .selected_target
        .model_capabilities
        .iter()
        .any(|capability| capability == "web_search");
    super::request_outbound_builtin_tool_projection::project_builtin_web_search_exposure(
        &mut provider_semantic_payload,
        web_search_route_eligibility.declaration.declared
            && web_search_route_eligibility.eligible
            && selected_can_search,
    );
    V3HubReqOutbound07ProviderSemantic {
        previous: input,
        provider_protocol,
        provider_semantic_payload,
    }
}

impl V3HubReqOutbound07ProviderSemantic {
    pub(crate) fn selected_target(&self) -> &routecodex_v3_target::V3TargetCandidate {
        &self.previous.selected_target
    }

    pub(crate) fn entry_protocol(&self) -> V3HubEntryProtocol {
        self.previous
            .previous
            .previous
            .previous
            .previous
            .entry_protocol
    }

    pub(crate) fn provider_semantic_payload(&self) -> &Value {
        &self.provider_semantic_payload
    }
}
