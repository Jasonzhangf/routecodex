use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::hub_req_inbound_02_standardized::{assert_no_inline_metadata, clone_object_payload};
use super::hub_req_outbound_05_provider_semantic::HubReqOutbound05ProviderSemantic;
use super::meta_error_carriers::assert_payload_has_no_meta_or_error_carrier;
use super::tool_surface_contract::{assert_tool_surface_contract, ToolNamespacePolicy};
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
    assert_no_request_context_or_namespace_tools(&payload, "ProviderReqOutbound06WirePayload")?;
    assert_tool_surface_contract(
        &payload,
        "ProviderReqOutbound06WirePayload",
        ToolNamespacePolicy::ForbidProviderWireNamespace,
    )?;
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

fn assert_no_request_context_or_namespace_tools(
    value: &Value,
    node_name: &str,
) -> Result<(), String> {
    fn walk(value: &Value, node_name: &str, path: &str) -> Result<(), String> {
        match value {
            Value::Object(object) => {
                for forbidden in [
                    "toolsRaw",
                    "clientToolsRaw",
                    "responsesContext",
                    "contextSnapshot",
                    "requestMetadata",
                    "__raw_request_body",
                    "rawBody",
                ] {
                    if object.contains_key(forbidden) {
                        return Err(format!(
                            "{node_name} must not carry request context field {forbidden} at {path}"
                        ));
                    }
                }
                let item_type = object
                    .get("type")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("");
                if item_type.eq_ignore_ascii_case("namespace") {
                    return Err(format!(
                        "{node_name} must not carry namespace tool aggregate at {path}"
                    ));
                }
                if object.contains_key("tools")
                    && object.get("tools").is_some_and(Value::is_array)
                    && object.get("name").and_then(Value::as_str).is_some()
                    && !object.contains_key("function")
                {
                    return Err(format!(
                        "{node_name} must not carry namespace tool aggregate at {path}"
                    ));
                }
                for (key, child) in object {
                    let child_path = if path == "$" {
                        format!("$.{key}")
                    } else {
                        format!("{path}.{key}")
                    };
                    walk(child, node_name, child_path.as_str())?;
                }
            }
            Value::Array(items) => {
                for (index, child) in items.iter().enumerate() {
                    walk(child, node_name, format!("{path}[{index}]").as_str())?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    walk(value, node_name, "$")
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

    #[test]
    fn rejects_request_context_fields_in_wire_payload() {
        let payload = json!({"model":"m","toolsRaw":[{"type":"function","name":"leak"}]});
        let inbound = build_hub_req_inbound_02_from_payload(json!({"model":"m"})).unwrap();
        let governed =
            build_hub_req_chatprocess_03_from_hub_req_inbound_02(inbound, json!({"model":"m"}))
                .unwrap();
        let selected = build_vr_route_04_from_hub_req_chatprocess_03(
            &governed,
            json!({"providerKey":"p.key","model":"m"}),
        )
        .unwrap();
        let semantic =
            build_hub_req_outbound_05_from_hub_req_chatprocess_03(governed, payload).unwrap();
        let err = build_provider_req_outbound_06_from_hub_req_outbound_05(&selected, semantic)
            .unwrap_err();
        assert!(err.contains("request context field toolsRaw"));
    }

    #[test]
    fn rejects_namespace_tool_aggregate_in_wire_payload() {
        let payload = json!({
            "model":"m",
            "tools":[{"type":"namespace","name":"multi_agent_v1","tools":[{"type":"function","name":"spawn_agent"}]}]
        });
        let inbound = build_hub_req_inbound_02_from_payload(json!({"model":"m"})).unwrap();
        let governed =
            build_hub_req_chatprocess_03_from_hub_req_inbound_02(inbound, json!({"model":"m"}))
                .unwrap();
        let selected = build_vr_route_04_from_hub_req_chatprocess_03(
            &governed,
            json!({"providerKey":"p.key","model":"m"}),
        )
        .unwrap();
        let semantic =
            build_hub_req_outbound_05_from_hub_req_chatprocess_03(governed, payload).unwrap();
        let err = build_provider_req_outbound_06_from_hub_req_outbound_05(&selected, semantic)
            .unwrap_err();
        assert!(err.contains("namespace tool aggregate"));
    }
}
