use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::hub_req_inbound_02_standardized::{assert_no_inline_metadata, clone_object_payload};
use super::hub_req_outbound_05_provider_semantic::HubReqOutbound05ProviderSemantic;
use super::meta_error_carriers::assert_payload_has_no_meta_or_error_carrier;
use super::vr_route_04_selected_target::VrRoute04SelectedTarget;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderReqOutbound06WirePayload {
    payload: Map<String, Value>,
}

impl ProviderReqOutbound06WirePayload {
    pub(crate) fn payload(&self) -> &Map<String, Value> {
        &self.payload
    }

    pub(crate) fn into_payload(self) -> Value {
        Value::Object(self.payload)
    }
}

pub(crate) fn build_provider_req_outbound_06_from_hub_req_outbound_05(
    selected_target: &VrRoute04SelectedTarget,
    semantic: HubReqOutbound05ProviderSemantic,
) -> Result<ProviderReqOutbound06WirePayload, String> {
    assert_no_inline_metadata(
        &selected_target.clone().into_decision(),
        "ProviderReqOutbound06WirePayload.route",
    )?;
    let payload = semantic.into_payload();
    assert_no_inline_metadata(&payload, "ProviderReqOutbound06WirePayload")?;
    assert_payload_has_no_meta_or_error_carrier(&payload, "ProviderReqOutbound06WirePayload")?;
    assert_no_provider_options_metadata(&payload, "ProviderReqOutbound06WirePayload")?;
    let payload = clone_object_payload(&payload, "ProviderReqOutbound06WirePayload")?;
    Ok(ProviderReqOutbound06WirePayload { payload })
}

pub(super) fn assert_no_provider_options_metadata(
    value: &Value,
    node_name: &str,
) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    for key in ["providerOptions", "openaiProviderOptions", "sdkOptions"] {
        if object
            .get(key)
            .and_then(Value::as_object)
            .is_some_and(|options| options.contains_key("metadata"))
        {
            return Err(format!(
                "{node_name} must not carry metadata in provider SDK options"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_pipeline_types::{
        build_hub_req_chatprocess_03_from_hub_req_inbound_02,
        build_hub_req_inbound_02_from_payload,
        build_hub_req_outbound_05_from_hub_req_chatprocess_03,
        build_vr_route_04_from_hub_req_chatprocess_03,
    };
    use serde_json::json;

    #[test]
    fn builds_wire_payload_from_selected_target_and_outbound_semantic() {
        let payload = json!({"model":"m","messages":[{"role":"user","content":"hi"}]});
        let inbound = build_hub_req_inbound_02_from_payload(payload.clone()).unwrap();
        let governed =
            build_hub_req_chatprocess_03_from_hub_req_inbound_02(inbound, payload.clone()).unwrap();
        let selected = build_vr_route_04_from_hub_req_chatprocess_03(
            &governed,
            json!({"providerKey":"p.key","model":"m"}),
        )
        .unwrap();
        let semantic =
            build_hub_req_outbound_05_from_hub_req_chatprocess_03(governed, payload.clone())
                .unwrap();
        let wire =
            build_provider_req_outbound_06_from_hub_req_outbound_05(&selected, semantic).unwrap();
        assert_eq!(wire.payload().get("model"), Some(&json!("m")));
        assert_eq!(wire.into_payload(), payload);
    }

    #[test]
    fn rejects_provider_options_metadata() {
        let payload = json!({"model":"m","providerOptions":{"metadata":{"x":1}}});
        let inbound = build_hub_req_inbound_02_from_payload(payload.clone()).unwrap();
        let governed =
            build_hub_req_chatprocess_03_from_hub_req_inbound_02(inbound, payload.clone()).unwrap();
        let selected = build_vr_route_04_from_hub_req_chatprocess_03(
            &governed,
            json!({"providerKey":"p.key","model":"m"}),
        )
        .unwrap();
        let semantic =
            build_hub_req_outbound_05_from_hub_req_chatprocess_03(governed, payload).unwrap();
        let err = build_provider_req_outbound_06_from_hub_req_outbound_05(&selected, semantic)
            .unwrap_err();
        assert!(err.contains("provider SDK options"));
    }
}
