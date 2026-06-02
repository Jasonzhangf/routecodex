use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::hub_req_chatprocess_03_governed::HubReqChatProcess03Governed;
use super::hub_req_inbound_02_standardized::{assert_no_inline_metadata, clone_object_payload};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VrRoute04SelectedTarget {
    decision: Map<String, Value>,
}

impl VrRoute04SelectedTarget {
    pub(crate) fn decision(&self) -> &Map<String, Value> {
        &self.decision
    }

    pub(crate) fn into_decision(self) -> Value {
        Value::Object(self.decision)
    }
}

pub(crate) fn build_vr_route_04_from_hub_req_chatprocess_03(
    governed: &HubReqChatProcess03Governed,
    decision: Value,
) -> Result<VrRoute04SelectedTarget, String> {
    assert_no_inline_metadata(governed.payload(), "VrRoute04SelectedTarget.source")?;
    assert_no_inline_metadata(&decision, "VrRoute04SelectedTarget")?;
    assert_no_payload_patch_fields(&decision, "VrRoute04SelectedTarget")?;
    let decision = clone_object_payload(&decision, "VrRoute04SelectedTarget")?;
    Ok(VrRoute04SelectedTarget { decision })
}

pub(super) fn assert_no_payload_patch_fields(value: &Value, node_name: &str) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    for key in [
        "payload",
        "patchedPayload",
        "providerPayload",
        "wirePayload",
        "messages",
        "tools",
        "tool_calls",
    ] {
        if object.contains_key(key) {
            return Err(format!(
                "{node_name} must not patch payload or tool governance fields"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_pipeline_types::{
        build_hub_req_chatprocess_03_from_hub_req_inbound_02, build_hub_req_inbound_02_from_payload,
    };
    use serde_json::json;

    #[test]
    fn builds_selected_target_without_changing_route_decision() {
        let payload = json!({"model":"m","messages":[{"role":"user","content":"hi"}]});
        let inbound = build_hub_req_inbound_02_from_payload(payload.clone()).unwrap();
        let governed =
            build_hub_req_chatprocess_03_from_hub_req_inbound_02(inbound, payload).unwrap();
        let decision = json!({"providerKey":"p.key","model":"m","routeId":"r1"});
        let selected =
            build_vr_route_04_from_hub_req_chatprocess_03(&governed, decision.clone()).unwrap();
        assert_eq!(
            selected.decision().get("providerKey"),
            Some(&json!("p.key"))
        );
        assert_eq!(selected.into_decision(), decision);
    }

    #[test]
    fn rejects_payload_patch_inside_route_decision() {
        let payload = json!({"model":"m","messages":[]});
        let inbound = build_hub_req_inbound_02_from_payload(payload.clone()).unwrap();
        let governed =
            build_hub_req_chatprocess_03_from_hub_req_inbound_02(inbound, payload).unwrap();
        let err = build_vr_route_04_from_hub_req_chatprocess_03(
            &governed,
            json!({"providerKey":"p.key","patchedPayload":{}}),
        )
        .unwrap_err();
        assert!(err.contains("must not patch payload"));
    }
}
