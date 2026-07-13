use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{json, Value};

use crate::direct_semantic_classification::{
    build_direct_resp_05_projection_plan, DirectFieldProjection, VrDirect03ResolvedSemantics,
};

// feature_id: hub.router_direct_response_action_plan
fn plan_direct_route_response_action(input: &Value) -> Result<Value, String> {
    let resolved_value = input
        .get("resolvedSemantics")
        .ok_or_else(|| "direct response projector requires resolvedSemantics".to_string())?;
    let resolved: VrDirect03ResolvedSemantics =
        serde_json::from_value(resolved_value.clone()).map_err(|error| {
            format!("direct response projector received invalid resolvedSemantics: {error}")
        })?;
    let projection = build_direct_resp_05_projection_plan(&resolved);
    if !input.get("responseIsRecord").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(json!({"action":"passthrough"}));
    }
    if input.get("hasSseStream").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(match &projection.model {
            DirectFieldProjection::RestoreOriginal(model) => {
                json!({"action":"project_sse_headers_and_model_stream","clientModel":model})
            }
            DirectFieldProjection::Preserve | DirectFieldProjection::Set(_) => {
                json!({"action":"project_sse_headers_only"})
            }
        });
    }
    Ok(match &projection.model {
        DirectFieldProjection::RestoreOriginal(model) => {
            json!({"action":"project_json_model","clientModel":model})
        }
        DirectFieldProjection::Preserve | DirectFieldProjection::Set(_) => {
            json!({"action":"passthrough"})
        }
    })
}

#[napi(js_name = "planDirectRouteResponseActionJson")]
pub fn plan_direct_route_response_action_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(format!("direct response action input parse failed: {error}")))?;
    let output = plan_direct_route_response_action(&input).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output)
        .map_err(|error| napi::Error::from_reason(format!("direct response action output serialize failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_json_and_sse_projection_actions() {
        assert_eq!(plan_direct_route_response_action(&json!({"responseIsRecord":true,"resolvedSemantics":{"semanticClass":"routing","originalClientModel":" client "}})).unwrap()["action"], "project_json_model");
        assert_eq!(plan_direct_route_response_action(&json!({"responseIsRecord":true,"hasSseStream":true,"resolvedSemantics":{"semanticClass":"routing","originalClientModel":"client"}})).unwrap()["action"], "project_sse_headers_and_model_stream");
        assert_eq!(plan_direct_route_response_action(&json!({"responseIsRecord":true,"hasSseStream":true,"resolvedSemantics":{"semanticClass":"routing"}})).unwrap()["action"], "project_sse_headers_only");
    }

    #[test]
    fn passes_through_non_record_and_model_less_json() {
        assert_eq!(plan_direct_route_response_action(&json!({"responseIsRecord":false,"resolvedSemantics":{"semanticClass":"routing","originalClientModel":"client"}})).unwrap()["action"], "passthrough");
        assert_eq!(plan_direct_route_response_action(&json!({"responseIsRecord":true,"resolvedSemantics":{"semanticClass":"routing"}})).unwrap()["action"], "passthrough");
    }

    #[test]
    fn passthrough_preserves_json_and_sse_model_fields() {
        assert_eq!(plan_direct_route_response_action(&json!({"responseIsRecord":true,"resolvedSemantics":{"semanticClass":"passthrough","originalClientModel":"client"}})).unwrap()["action"], "passthrough");
        assert_eq!(plan_direct_route_response_action(&json!({"responseIsRecord":true,"hasSseStream":true,"resolvedSemantics":{"semanticClass":"passthrough","originalClientModel":"client"}})).unwrap()["action"], "project_sse_headers_only");
        assert!(plan_direct_route_response_action(&json!({"responseIsRecord":true})).is_err());
    }
}
