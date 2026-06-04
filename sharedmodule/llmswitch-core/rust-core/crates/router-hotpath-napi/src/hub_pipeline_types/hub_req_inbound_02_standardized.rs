use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::tool_surface_contract::{assert_tool_surface_contract, ToolNamespacePolicy};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubReqInbound02Standardized {
    payload: Value,
}

impl HubReqInbound02Standardized {
    pub(crate) fn payload(&self) -> &Value {
        &self.payload
    }

    pub(crate) fn into_payload(self) -> Value {
        self.payload
    }
}

pub(crate) fn build_hub_req_inbound_02_from_payload(
    payload: Value,
) -> Result<HubReqInbound02Standardized, String> {
    assert_no_inline_metadata(&payload, "HubReqInbound02Standardized")?;
    assert_tool_surface_contract(
        &payload,
        "HubReqInbound02Standardized",
        ToolNamespacePolicy::AllowSemanticNamespace,
    )?;
    Ok(HubReqInbound02Standardized { payload })
}

pub(super) fn assert_no_inline_metadata(value: &Value, node_name: &str) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    if object.contains_key("metadata") {
        return Err(format!(
            "{node_name} must not carry inline metadata; use Meta* carrier"
        ));
    }
    if let Some(context) = object.get("context").and_then(Value::as_object) {
        if context.contains_key("metadata") {
            return Err(format!(
                "{node_name} must not carry context.metadata; use Meta* carrier"
            ));
        }
    }
    Ok(())
}

pub(super) fn clone_object_payload(
    value: &Value,
    node_name: &str,
) -> Result<Map<String, Value>, String> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{node_name} payload must be an object"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_standardized_request_without_changing_payload() {
        let payload = json!({"model":"m","messages":[{"role":"user","content":"hi"}]});
        let node = build_hub_req_inbound_02_from_payload(payload.clone()).unwrap();
        assert_eq!(node.payload(), &payload);
        assert_eq!(node.into_payload(), payload);
    }

    #[test]
    fn rejects_inline_metadata_in_normal_request_payload() {
        let err = build_hub_req_inbound_02_from_payload(json!({"metadata":{"routeHint":"x"}}))
            .unwrap_err();
        assert!(err.contains("Meta* carrier"));
    }
}
