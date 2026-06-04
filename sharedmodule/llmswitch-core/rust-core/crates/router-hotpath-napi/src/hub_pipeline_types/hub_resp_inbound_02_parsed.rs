use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::hub_req_inbound_02_standardized::assert_no_inline_metadata;
use super::tool_surface_contract::{assert_tool_surface_contract, ToolNamespacePolicy};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubRespInbound02Parsed {
    payload: Value,
}

impl HubRespInbound02Parsed {
    pub(crate) fn payload(&self) -> &Value {
        &self.payload
    }

    pub(crate) fn into_payload(self) -> Value {
        self.payload
    }
}

pub(crate) fn parse_hub_resp_inbound_02_from_provider_resp_inbound_01(
    payload: Value,
) -> Result<HubRespInbound02Parsed, String> {
    assert_no_inline_metadata(&payload, "HubRespInbound02Parsed")?;
    assert_not_success_error_payload(&payload, "HubRespInbound02Parsed")?;
    assert_tool_surface_contract(
        &payload,
        "HubRespInbound02Parsed",
        ToolNamespacePolicy::AllowSemanticNamespace,
    )?;
    Ok(HubRespInbound02Parsed { payload })
}

pub(super) fn assert_not_success_error_payload(
    value: &Value,
    node_name: &str,
) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let has_error = object.contains_key("error");
    let success_true = object.get("success").and_then(Value::as_bool) == Some(true);
    if has_error && success_true {
        return Err(format!(
            "{node_name} must not carry an Error* condition as successful response payload"
        ));
    }
    Ok(())
}

pub(super) fn clone_response_object_payload(
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
    fn parses_response_without_changing_payload() {
        let payload = json!({"id":"resp_1","output":[{"type":"message"}]});
        let node =
            parse_hub_resp_inbound_02_from_provider_resp_inbound_01(payload.clone()).unwrap();
        assert_eq!(node.payload(), &payload);
        assert_eq!(node.into_payload(), payload);
    }

    #[test]
    fn rejects_inline_metadata_in_normal_response_payload() {
        let err = parse_hub_resp_inbound_02_from_provider_resp_inbound_01(
            json!({"metadata":{"requestId":"x"}}),
        )
        .unwrap_err();
        assert!(err.contains("Meta* carrier"));
    }

    #[test]
    fn rejects_error_disguised_as_success_response_payload() {
        let err = parse_hub_resp_inbound_02_from_provider_resp_inbound_01(
            json!({"success":true,"error":{"message":"boom"}}),
        )
        .unwrap_err();
        assert!(err.contains("Error* condition"));
    }
}
