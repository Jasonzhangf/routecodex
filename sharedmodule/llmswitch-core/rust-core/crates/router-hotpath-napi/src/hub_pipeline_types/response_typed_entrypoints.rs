use serde_json::Value;

use super::{
    build_hub_resp_chatprocess_03_from_hub_resp_inbound_02,
    parse_hub_resp_inbound_02_from_provider_resp_inbound_01,
    project_hub_resp_outbound_04_from_hub_resp_chatprocess_03, HubRespChatProcess03Governed,
    HubRespInbound02Parsed, HubRespOutbound04ClientSemantic, ResponseAdjacentTransitionError,
};

pub(crate) fn run_hub_resp_inbound_02_parsed_entrypoint(
    payload: Value,
) -> Result<HubRespInbound02Parsed, String> {
    parse_hub_resp_inbound_02_from_provider_resp_inbound_01(payload)
}

pub(crate) fn run_hub_resp_chatprocess_03_governed_entrypoint<E, F>(
    inbound: HubRespInbound02Parsed,
    transform: F,
) -> Result<HubRespChatProcess03Governed, ResponseAdjacentTransitionError<E>>
where
    F: FnOnce(Value) -> Result<Value, E>,
{
    build_hub_resp_chatprocess_03_from_hub_resp_inbound_02(inbound, transform)
}

pub(crate) fn run_hub_resp_outbound_04_client_semantic_entrypoint<E, F>(
    governed: HubRespChatProcess03Governed,
    transform: F,
) -> Result<HubRespOutbound04ClientSemantic, ResponseAdjacentTransitionError<E>>
where
    F: FnOnce(Value) -> Result<Value, E>,
{
    project_hub_resp_outbound_04_from_hub_resp_chatprocess_03(governed, transform)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn response_typed_entrypoints_preserve_payload_for_live_path_wiring() {
        let payload = json!({"id":"resp_1","output":[{"type":"message"}]});
        let inbound = run_hub_resp_inbound_02_parsed_entrypoint(payload.clone()).unwrap();
        let governed = run_hub_resp_chatprocess_03_governed_entrypoint(inbound, |source| {
            Ok::<_, String>(source)
        })
        .unwrap();
        let outbound = run_hub_resp_outbound_04_client_semantic_entrypoint(governed, |source| {
            Ok::<_, String>(source)
        })
        .unwrap();
        assert_eq!(outbound.into_payload(), payload);
    }

    #[test]
    fn response_typed_entrypoints_reject_inline_metadata() {
        let err = run_hub_resp_inbound_02_parsed_entrypoint(
            json!({"id":"resp_1","metadata":{"requestId":"x"}}),
        )
        .unwrap_err();
        assert!(err.contains("Meta* carrier"));
    }
}
