use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::hub_req_inbound_02_standardized::{assert_no_inline_metadata, into_object_payload};
use super::hub_resp_chatprocess_03_governed::HubRespChatProcess03Governed;
use super::hub_resp_inbound_02_parsed::{
    assert_not_success_error_payload, ResponseAdjacentTransitionError,
};
use super::meta_error_carriers::assert_payload_has_no_meta_or_error_carrier;
use super::tool_surface_contract::{assert_tool_surface_contract, ToolNamespacePolicy};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubRespOutbound04ClientSemantic {
    payload: Map<String, Value>,
}

impl HubRespOutbound04ClientSemantic {
    pub(crate) fn payload(&self) -> &Map<String, Value> {
        &self.payload
    }

    pub(crate) fn into_payload(self) -> Value {
        Value::Object(self.payload)
    }
}

pub(crate) fn project_hub_resp_outbound_04_from_hub_resp_chatprocess_03<E, F>(
    governed: HubRespChatProcess03Governed,
    transform: F,
) -> Result<HubRespOutbound04ClientSemantic, ResponseAdjacentTransitionError<E>>
where
    F: FnOnce(Value) -> Result<Value, E>,
{
    assert_no_inline_metadata(governed.payload(), "HubRespOutbound04ClientSemantic.source")
        .map_err(ResponseAdjacentTransitionError::Contract)?;
    assert_not_success_error_payload(governed.payload(), "HubRespOutbound04ClientSemantic.source")
        .map_err(ResponseAdjacentTransitionError::Contract)?;
    let client_payload =
        transform(governed.into_payload()).map_err(ResponseAdjacentTransitionError::Transform)?;
    assert_payload_has_no_meta_or_error_carrier(&client_payload, "HubRespOutbound04ClientSemantic")
        .map_err(ResponseAdjacentTransitionError::Contract)?;
    assert_not_success_error_payload(&client_payload, "HubRespOutbound04ClientSemantic")
        .map_err(ResponseAdjacentTransitionError::Contract)?;
    assert_tool_surface_contract(
        &client_payload,
        "HubRespOutbound04ClientSemantic",
        ToolNamespacePolicy::AllowSemanticNamespace,
    )
    .map_err(ResponseAdjacentTransitionError::Contract)?;
    let payload = into_object_payload(client_payload, "HubRespOutbound04ClientSemantic")
        .map_err(ResponseAdjacentTransitionError::Contract)?;
    Ok(HubRespOutbound04ClientSemantic { payload })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_pipeline_types::{
        build_hub_resp_chatprocess_03_from_hub_resp_inbound_02,
        parse_hub_resp_inbound_02_from_provider_resp_inbound_01,
    };
    use serde_json::json;

    #[test]
    fn projects_client_semantic_from_response_chatprocess_only() {
        let payload = json!({"id":"resp_1","output":[{"type":"message"}]});
        let inbound =
            parse_hub_resp_inbound_02_from_provider_resp_inbound_01(payload.clone()).unwrap();
        let governed = build_hub_resp_chatprocess_03_from_hub_resp_inbound_02(inbound, |source| {
            Ok::<_, String>(source)
        })
        .unwrap();
        let outbound =
            project_hub_resp_outbound_04_from_hub_resp_chatprocess_03(governed, |source| {
                Ok::<_, String>(source)
            })
            .unwrap();
        assert_eq!(outbound.payload().get("id"), Some(&json!("resp_1")));
        assert_eq!(outbound.into_payload(), payload);
    }

    #[test]
    fn preserves_client_protocol_metadata_without_internal_carriers() {
        let payload = json!({"id":"resp_1","output":[{"type":"message"}]});
        let inbound = parse_hub_resp_inbound_02_from_provider_resp_inbound_01(payload).unwrap();
        let governed = build_hub_resp_chatprocess_03_from_hub_resp_inbound_02(inbound, |source| {
            Ok::<_, String>(source)
        })
        .unwrap();
        let outbound =
            project_hub_resp_outbound_04_from_hub_resp_chatprocess_03(governed, |mut source| {
                source
                    .as_object_mut()
                    .unwrap()
                    .insert("metadata".to_string(), json!({"client":"preserved"}));
                Ok::<_, String>(source)
            })
            .unwrap();
        assert_eq!(
            outbound.into_payload()["metadata"]["client"],
            json!("preserved")
        );
    }
}
