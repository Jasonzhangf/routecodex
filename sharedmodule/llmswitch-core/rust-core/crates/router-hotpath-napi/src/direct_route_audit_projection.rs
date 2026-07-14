use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{json, Value};

// feature_id: hub.router_direct_audit_projection
const OBSERVABLE_FIELDS: [&str; 4] = ["model", "reasoning", "thinking", "max_tokens"];

fn project(payload: &Value) -> Value {
    let observed_fields = payload
        .as_object()
        .map(|record| {
            OBSERVABLE_FIELDS
                .iter()
                .filter_map(|field| {
                    record
                        .get(*field)
                        .map(|value| json!({"field": field, "value": value}))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({"observedFields": observed_fields})
}

#[napi(js_name = "projectDirectRouteAuditFieldsJson")]
pub fn project_direct_route_audit_fields_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "direct audit projection input parse failed: {error}"
        ))
    })?;
    serde_json::to_string(&project(input.get("payload").unwrap_or(&Value::Null))).map_err(|error| {
        napi::Error::from_reason(format!(
            "direct audit projection output serialize failed: {error}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_only_ordered_observable_fields() {
        let output = project(
            &json!({"thinking":"high","model":"m","messages":[],"max_tokens":5,"reasoning":{"effort":"high"}}),
        );
        assert_eq!(output["observedFields"][0]["field"], "model");
        assert_eq!(output["observedFields"][1]["field"], "reasoning");
        assert_eq!(output["observedFields"][2]["field"], "thinking");
        assert_eq!(output["observedFields"][3]["field"], "max_tokens");
        assert!(!output.to_string().contains("messages"));
    }

    #[test]
    fn preserves_explicit_null_but_omits_absent_fields() {
        let output = project(&json!({"model":null,"metadata":{"model":"nested"}}));
        assert_eq!(output["observedFields"].as_array().unwrap().len(), 1);
        assert_eq!(output["observedFields"][0]["value"], Value::Null);
    }
}
