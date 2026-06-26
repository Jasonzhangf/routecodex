use serde_json::Value;

use super::{
    build_hub_req_chatprocess_03_from_hub_req_inbound_02, build_hub_req_inbound_02_from_payload,
    build_hub_req_outbound_05_from_vr_route_04_selected_target,
    build_vr_route_04_from_hub_req_chatprocess_03, HubReqChatProcess03Governed,
    HubReqInbound02Standardized, HubReqOutbound05ProviderSemantic, VrRoute04SelectedTarget,
};

pub(crate) fn run_hub_req_inbound_02_standardized_entrypoint(
    payload: Value,
) -> Result<HubReqInbound02Standardized, String> {
    build_hub_req_inbound_02_from_payload(payload)
}

pub(crate) fn run_hub_req_chatprocess_03_governed_entrypoint(
    inbound: HubReqInbound02Standardized,
    governed_payload: Value,
) -> Result<HubReqChatProcess03Governed, String> {
    build_hub_req_chatprocess_03_from_hub_req_inbound_02(inbound, governed_payload)
}

pub(crate) fn run_vr_route_04_selected_target_entrypoint(
    governed: HubReqChatProcess03Governed,
    route_decision: Value,
) -> Result<VrRoute04SelectedTarget, String> {
    build_vr_route_04_from_hub_req_chatprocess_03(&governed, route_decision)
}

pub(crate) fn run_hub_req_outbound_05_provider_semantic_entrypoint(
    governed: HubReqChatProcess03Governed,
    selected_target: &VrRoute04SelectedTarget,
    outbound_payload: Value,
) -> Result<HubReqOutbound05ProviderSemantic, String> {
    build_hub_req_outbound_05_from_vr_route_04_selected_target(
        governed,
        selected_target,
        outbound_payload,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_typed_entrypoints_preserve_payload_for_live_path_wiring() {
        let payload = json!({"model":"m","messages":[{"role":"user","content":"hi"}]});
        let inbound = run_hub_req_inbound_02_standardized_entrypoint(payload.clone()).unwrap();
        let governed =
            run_hub_req_chatprocess_03_governed_entrypoint(inbound, payload.clone()).unwrap();
        let selected = run_vr_route_04_selected_target_entrypoint(
            governed.clone(),
            json!({"providerKey":"p.key","modelId":"m2","routeName":"default"}),
        )
        .unwrap();
        let outbound = run_hub_req_outbound_05_provider_semantic_entrypoint(
            governed,
            &selected,
            payload.clone(),
        )
        .unwrap();
        assert_eq!(
            selected.decision().get("providerKey"),
            Some(&json!("p.key"))
        );
        assert_eq!(outbound.into_payload(), payload);
    }

    #[test]
    fn request_typed_entrypoints_reject_inline_metadata() {
        let err = run_hub_req_inbound_02_standardized_entrypoint(
            json!({"model":"m","metadata":{"routeHint":"x"}}),
        )
        .unwrap_err();
        assert!(err.contains("Meta* carrier"));
    }
}
