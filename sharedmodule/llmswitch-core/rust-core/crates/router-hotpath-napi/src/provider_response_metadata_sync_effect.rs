use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{json, Value};

// feature_id: hub.provider_response_metadata_sync_effect_plan
fn plan(input: &Value) -> Value {
    if !input
        .get("pipelineMetadataIsRecord")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || !input
            .get("bridgeCenterExists")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return json!({"action":"no_op","writes":[]});
    }
    if !input
        .get("pipelineCenterExists")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({"action":"bind_bridge_center","writes":[]});
    }
    if input
        .get("centersAreSame")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({"action":"no_op","writes":[]});
    }

    let mut writes = Vec::new();
    let runtime_control = input.get("bridgeRuntimeControl").and_then(Value::as_object);
    for (key, reason) in [
        (
            "stopless",
            "provider response stopless runtime pipeline sync",
        ),
        (
            "stopMessageCompareContext",
            "provider response stop-message compare pipeline sync",
        ),
    ] {
        if let Some(value) = runtime_control.and_then(|record| record.get(key)) {
            if !value.is_null() {
                writes.push(json!({
                    "family":"runtime_control",
                    "key":key,
                    "value":value,
                    "reason":reason,
                    "writer":{"module":"src/server/runtime/http-server/executor/provider-response-converter.ts","symbol":"syncBridgeRuntimeBackToPipelineMetadata","stage":"provider_response_runtime_control"}
                }));
            }
        }
    }
    if let Some(hub_stage_top) = input
        .get("bridgeDebugSnapshot")
        .and_then(Value::as_object)
        .and_then(|record| record.get("hubStageTop"))
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
    {
        writes.push(json!({
            "family":"debug_snapshot",
            "key":"hubStageTop",
            "value":hub_stage_top,
            "reason":"provider response hub-stage-top debug snapshot sync",
            "writer":{"module":"src/server/runtime/http-server/executor/provider-response-converter.ts","symbol":"syncBridgeRuntimeBackToPipelineMetadata","stage":"provider_response_debug_snapshot"}
        }));
    }
    json!({"action":"apply_writes","writes":writes})
}

#[napi(js_name = "planProviderResponseMetadataSyncEffectJson")]
pub fn plan_provider_response_metadata_sync_effect_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "provider response metadata sync input parse failed: {error}"
        ))
    })?;
    serde_json::to_string(&plan(&input)).map_err(|error| {
        napi::Error::from_reason(format!(
            "provider response metadata sync output serialize failed: {error}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_bind_and_no_op_actions() {
        assert_eq!(
            plan(&json!({"pipelineMetadataIsRecord":false}))["action"],
            "no_op"
        );
        assert_eq!(
            plan(
                &json!({"pipelineMetadataIsRecord":true,"bridgeCenterExists":true,"pipelineCenterExists":false})
            )["action"],
            "bind_bridge_center"
        );
        assert_eq!(
            plan(
                &json!({"pipelineMetadataIsRecord":true,"bridgeCenterExists":true,"pipelineCenterExists":true,"centersAreSame":true})
            )["action"],
            "no_op"
        );
    }

    #[test]
    fn emits_only_owned_non_empty_sync_writes() {
        let output = plan(&json!({
            "pipelineMetadataIsRecord":true,
            "bridgeCenterExists":true,
            "pipelineCenterExists":true,
            "centersAreSame":false,
            "bridgeRuntimeControl":{"stopless":{"active":true},"serverToolLoopState":{"active":true}},
            "bridgeDebugSnapshot":{"hubStageTop":[{"stage":"resp_inbound","totalMs":2}]}
        }));
        assert_eq!(output["action"], "apply_writes");
        let writes = output["writes"].as_array().unwrap();
        assert_eq!(writes.len(), 2);
        assert_eq!(writes[0]["key"], "stopless");
        assert_eq!(writes[1]["key"], "hubStageTop");
    }
}
