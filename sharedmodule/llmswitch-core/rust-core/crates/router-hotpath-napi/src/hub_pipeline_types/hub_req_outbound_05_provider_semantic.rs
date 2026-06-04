use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::hub_req_chatprocess_03_governed::HubReqChatProcess03Governed;
use super::hub_req_inbound_02_standardized::{assert_no_inline_metadata, clone_object_payload};
use super::meta_error_carriers::assert_payload_has_no_meta_or_error_carrier;
use super::tool_surface_contract::{assert_tool_surface_contract, ToolNamespacePolicy};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubReqOutbound05ProviderSemantic {
    payload: Map<String, Value>,
}

impl HubReqOutbound05ProviderSemantic {
    pub(crate) fn payload(&self) -> &Map<String, Value> {
        &self.payload
    }

    pub(crate) fn into_payload(self) -> Value {
        Value::Object(self.payload)
    }
}

pub(crate) fn build_hub_req_outbound_05_from_hub_req_chatprocess_03(
    governed: HubReqChatProcess03Governed,
    outbound_payload: Value,
) -> Result<HubReqOutbound05ProviderSemantic, String> {
    assert_no_inline_metadata(
        governed.payload(),
        "HubReqOutbound05ProviderSemantic.source",
    )?;
    assert_no_inline_metadata(&outbound_payload, "HubReqOutbound05ProviderSemantic")?;
    assert_payload_has_no_meta_or_error_carrier(
        &outbound_payload,
        "HubReqOutbound05ProviderSemantic",
    )?;
    assert_tool_surface_contract(
        &outbound_payload,
        "HubReqOutbound05ProviderSemantic",
        ToolNamespacePolicy::AllowSemanticNamespace,
    )?;
    let payload = clone_object_payload(&outbound_payload, "HubReqOutbound05ProviderSemantic")?;
    Ok(HubReqOutbound05ProviderSemantic { payload })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_pipeline_types::{
        build_hub_req_chatprocess_03_from_hub_req_inbound_02, build_hub_req_inbound_02_from_payload,
    };
    use serde_json::json;

    #[test]
    fn builds_provider_semantic_from_chatprocess_only() {
        let payload = json!({"model":"m","messages":[{"role":"user","content":"hi"}]});
        let inbound = build_hub_req_inbound_02_from_payload(payload.clone()).unwrap();
        let governed =
            build_hub_req_chatprocess_03_from_hub_req_inbound_02(inbound, payload.clone()).unwrap();
        let outbound =
            build_hub_req_outbound_05_from_hub_req_chatprocess_03(governed, payload.clone())
                .unwrap();
        assert_eq!(outbound.payload().get("model"), Some(&json!("m")));
        assert_eq!(outbound.into_payload(), payload);
    }
}
