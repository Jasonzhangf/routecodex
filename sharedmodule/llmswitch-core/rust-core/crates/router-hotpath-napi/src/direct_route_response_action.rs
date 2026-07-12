use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{json, Value};

// feature_id: hub.router_direct_response_action_plan
fn plan(input: &Value) -> Value {
    if !input.get("responseIsRecord").and_then(Value::as_bool).unwrap_or(false) {
        return json!({"action":"passthrough"});
    }
    let client_model = input.get("clientModel").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    if input.get("hasSseStream").and_then(Value::as_bool).unwrap_or(false) {
        return match client_model {
            Some(model) => json!({"action":"project_sse_headers_and_model_stream","clientModel":model}),
            None => json!({"action":"project_sse_headers_only"}),
        };
    }
    match client_model {
        Some(model) => json!({"action":"project_json_model","clientModel":model}),
        None => json!({"action":"passthrough"}),
    }
}

#[napi(js_name = "planDirectRouteResponseActionJson")]
pub fn plan_direct_route_response_action_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(format!("direct response action input parse failed: {error}")))?;
    serde_json::to_string(&plan(&input))
        .map_err(|error| napi::Error::from_reason(format!("direct response action output serialize failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_json_and_sse_projection_actions() {
        assert_eq!(plan(&json!({"responseIsRecord":true,"clientModel":" client "}))["action"], "project_json_model");
        assert_eq!(plan(&json!({"responseIsRecord":true,"hasSseStream":true,"clientModel":"client"}))["action"], "project_sse_headers_and_model_stream");
        assert_eq!(plan(&json!({"responseIsRecord":true,"hasSseStream":true}))["action"], "project_sse_headers_only");
    }

    #[test]
    fn passes_through_non_record_and_model_less_json() {
        assert_eq!(plan(&json!({"responseIsRecord":false,"clientModel":"client"}))["action"], "passthrough");
        assert_eq!(plan(&json!({"responseIsRecord":true,"clientModel":"  "}))["action"], "passthrough");
    }
}
