use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{json, Value};

// feature_id: debug.pipeline_dry_run_terminal_action_plan
fn plan(input: &Value) -> Value {
    match input
        .get("providerRequestDryRunResponseMarked")
        .and_then(Value::as_bool)
    {
        Some(true) => json!({"action":"return_dry_run_terminal"}),
        Some(false) => json!({"action":"continue_normal_response"}),
        None => json!({"action":"invalid_input"}),
    }
}

#[napi(js_name = "planProviderDryRunTerminalActionJson")]
pub fn plan_provider_dry_run_terminal_action_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!("provider dry-run terminal action input parse failed: {error}"))
    })?;
    serde_json::to_string(&plan(&input)).map_err(|error| {
        napi::Error::from_reason(format!("provider dry-run terminal action output serialize failed: {error}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_marked_dry_run_before_response_postprocessing() {
        assert_eq!(
            plan(&json!({"providerRequestDryRunResponseMarked":true}))["action"],
            "return_dry_run_terminal"
        );
    }

    #[test]
    fn continues_normal_response_and_rejects_missing_marker() {
        assert_eq!(
            plan(&json!({"providerRequestDryRunResponseMarked":false}))["action"],
            "continue_normal_response"
        );
        assert_eq!(plan(&json!({}))["action"], "invalid_input");
    }
}
