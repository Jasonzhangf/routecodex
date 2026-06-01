use serde_json::Value;

use super::{
    build_hub_req_chatprocess_03_from_hub_req_inbound_02, build_hub_req_inbound_02_from_payload,
    build_hub_req_outbound_05_from_hub_req_chatprocess_03, HubReqChatProcess03Governed,
    HubReqInbound02Standardized, HubReqOutbound05ProviderSemantic,
};

pub(crate) fn run_hub_req_inbound_02_standardized_entrypoint(
    payload: Value,
) -> Result<HubReqInbound02Standardized, String> {
    build_hub_req_inbound_02_from_payload(payload)
}

pub(crate) fn run_hub_req_chatprocess_03_governed_entrypoint(
    inbound: HubReqInbound02Standardized,
) -> Result<HubReqChatProcess03Governed, String> {
    build_hub_req_chatprocess_03_from_hub_req_inbound_02(inbound)
}

pub(crate) fn run_hub_req_outbound_05_provider_semantic_entrypoint(
    governed: HubReqChatProcess03Governed,
) -> Result<HubReqOutbound05ProviderSemantic, String> {
    build_hub_req_outbound_05_from_hub_req_chatprocess_03(governed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_typed_entrypoints_preserve_payload_without_live_path_wiring() {
        let payload = json!({"model":"m","messages":[{"role":"user","content":"hi"}]});
        let inbound = run_hub_req_inbound_02_standardized_entrypoint(payload.clone()).unwrap();
        let governed = run_hub_req_chatprocess_03_governed_entrypoint(inbound).unwrap();
        let outbound = run_hub_req_outbound_05_provider_semantic_entrypoint(governed).unwrap();
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
