use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{json, Value};

// feature_id: hub.router_direct_eligibility_plan
fn text(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn plan(input: &Value) -> Value {
    let mode = text(input, "mode").unwrap_or_default();
    let configured_behavior = text(input, "sameProtocolBehavior");
    let effective_behavior = if mode == "router" {
        configured_behavior.unwrap_or_else(|| "direct".to_string())
    } else {
        "relay".to_string()
    };
    if mode != "router" {
        return json!({"action":"skip","reason":"not a router-mode port","effectiveBehavior":effective_behavior,"eligible":false});
    }
    if effective_behavior != "direct" {
        return json!({"action":"skip","reason":format!("sameProtocolBehavior is '{effective_behavior}', not 'direct'"),"effectiveBehavior":effective_behavior,"eligible":false});
    }
    let Some(provider_found) = input.get("providerFound").and_then(Value::as_bool) else {
        return json!({"action":"resolve_provider","effectiveBehavior":effective_behavior,"eligible":true});
    };
    if !provider_found {
        let runtime_key = text(input, "runtimeKey").unwrap_or_default();
        return json!({"action":"skip","reason":format!("provider not found for runtimeKey: {runtime_key}"),"effectiveBehavior":effective_behavior,"eligible":true});
    }
    let inbound = text(input, "inboundProtocol").unwrap_or_default();
    let provider = text(input, "providerProtocol").unwrap_or_default();
    if inbound != provider {
        return json!({"action":"skip","reason":format!("protocol mismatch: inbound={inbound}, provider={provider}"),"effectiveBehavior":effective_behavior,"eligible":true});
    }
    json!({"action":"execute_direct","effectiveBehavior":effective_behavior,"eligible":true})
}

#[napi(js_name = "planDirectRouteEligibilityJson")]
pub fn plan_direct_route_eligibility_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!("direct eligibility input parse failed: {error}"))
    })?;
    serde_json::to_string(&plan(&input)).map_err(|error| {
        napi::Error::from_reason(format!(
            "direct eligibility output serialize failed: {error}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_router_default_direct_through_provider_resolution_and_protocol_match() {
        assert_eq!(
            plan(&json!({"mode":"router"}))["action"],
            "resolve_provider"
        );
        assert_eq!(
            plan(
                &json!({"mode":"router","providerFound":true,"inboundProtocol":"openai-chat","providerProtocol":"openai-chat"})
            )["action"],
            "execute_direct"
        );
    }

    #[test]
    fn rejects_non_router_relay_missing_provider_and_protocol_mismatch() {
        assert_eq!(
            plan(&json!({"mode":"provider"}))["reason"],
            "not a router-mode port"
        );
        assert_eq!(
            plan(&json!({"mode":"router","sameProtocolBehavior":"relay"}))["eligible"],
            false
        );
        assert!(
            plan(&json!({"mode":"router","providerFound":false,"runtimeKey":"missing"}))["reason"]
                .as_str()
                .unwrap()
                .contains("missing")
        );
        assert!(plan(&json!({"mode":"router","providerFound":true,"inboundProtocol":"openai-chat","providerProtocol":"anthropic-messages"}))["reason"].as_str().unwrap().contains("protocol mismatch"));
    }
}
