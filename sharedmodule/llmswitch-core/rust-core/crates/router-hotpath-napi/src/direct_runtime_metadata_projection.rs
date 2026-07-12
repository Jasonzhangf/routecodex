use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

// feature_id: hub.direct_runtime_metadata_projection
const ROUTE_PRIMITIVE_KEYS: &[&str] = &[
    "requestId",
    "clientRequestId",
    "inputRequestId",
    "groupRequestId",
    "sessionId",
    "session_id",
    "conversationId",
    "conversation_id",
    "logSessionColorKey",
    "clientTmuxSessionId",
    "client_tmux_session_id",
    "tmuxSessionId",
    "tmux_session_id",
    "rccSessionClientTmuxSessionId",
    "rcc_session_client_tmux_session_id",
    "routecodexRoutingPolicyGroup",
    "routecodexLocalPort",
    "entryPort",
    "matchedPort",
    "routecodexPortMode",
    "routecodexPortBinding",
    "estimatedInputTokens",
    "estimatedTokens",
    "estimated_tokens",
    "serverToolRequired",
    "__shadowCompareForcedProviderKey",
    "routerDirectInboundProtocol",
    "routeHint",
];
const RUNTIME_KEYS: &[&str] = &[
    "clientRequestId",
    "providerStreamNoContentTimeoutMs",
    "streamNoContentTimeoutMs",
    "noContentTimeoutMs",
    "providerStreamContentIdleTimeoutMs",
    "streamContentIdleTimeoutMs",
    "contentIdleTimeoutMs",
    "providerStreamHeadersTimeoutMs",
    "streamHeadersTimeoutMs",
    "headersTimeoutMs",
];
const CONTROL_KEYS: &[&str] = &[
    "routecodexRoutingPolicyGroup",
    "providerProtocol",
    "routeHint",
    "retryProviderKey",
    "stopMessageEnabled",
    "stopMessageExcludeDirect",
    "sessionDir",
    "rccUserDir",
    "nowMs",
    "serverToolFollowup",
];

fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn copy_primitive(out: &mut Map<String, Value>, source: &Map<String, Value>, key: &str) {
    let Some(value) = source.get(key) else {
        return;
    };
    match value {
        Value::Bool(_) => {
            out.insert(key.to_string(), value.clone());
        }
        Value::String(text) if !text.trim().is_empty() => {
            out.insert(key.to_string(), Value::String(text.trim().to_string()));
        }
        Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => {
            out.insert(key.to_string(), value.clone());
        }
        _ => {}
    }
}

fn project_primitives(source: Option<&Map<String, Value>>, keys: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(source) = source {
        for key in keys {
            copy_primitive(&mut out, source, key);
        }
    }
    out
}

fn copy_string_array(out: &mut Map<String, Value>, source: &Map<String, Value>, key: &str) {
    let Some(values) = source.get(key).and_then(Value::as_array) else {
        return;
    };
    let normalized: Vec<Value> = values
        .iter()
        .filter_map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(|text| Value::String(text.to_string()))
        })
        .collect();
    if !normalized.is_empty() {
        out.insert(key.to_string(), Value::Array(normalized));
    }
}

fn copy_dry_run(source: &Map<String, Value>, out: &mut Map<String, Value>) {
    for key in ["__routecodexPipelineDryRun", "__rccDryRunSerialized"] {
        let Some(row) = source.get(key).and_then(Value::as_object) else {
            continue;
        };
        if row.get("enabled").and_then(Value::as_bool) == Some(true)
            && row.get("kind").and_then(Value::as_str) == Some("provider_request")
        {
            out.insert(key.to_string(), Value::Object(row.clone()));
            break;
        }
    }
}

fn build_route_projection(input: &Value) -> Value {
    let root = input.as_object();
    let metadata = record(root.and_then(|row| row.get("metadata")))
        .cloned()
        .unwrap_or_default();
    let snapshot = record(root.and_then(|row| row.get("metadataCenterSnapshot")))
        .or_else(|| record(metadata.get("metadataCenterSnapshot")));
    let mut out = project_primitives(Some(&metadata), ROUTE_PRIMITIVE_KEYS);
    for key in ["allowedProviders", "excludedProviderKeys"] {
        copy_string_array(&mut out, &metadata, key);
    }
    for (input_key, output_key) in [
        ("requestId", "requestId"),
        ("entryEndpoint", "entryEndpoint"),
    ] {
        if let Some(text) = root
            .and_then(|row| row.get(input_key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .or_else(|| {
                metadata
                    .get(output_key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
            })
        {
            out.insert(output_key.to_string(), Value::String(text.to_string()));
        }
    }
    let request_truth = project_primitives(
        record(snapshot.and_then(|row| row.get("requestTruth"))),
        &[
            "requestId",
            "pipelineId",
            "entryEndpoint",
            "sessionId",
            "conversationId",
            "clientRequestId",
            "portScope",
        ],
    );
    let mut projected_snapshot = Map::new();
    if !request_truth.is_empty() {
        projected_snapshot.insert(
            "requestTruth".to_string(),
            Value::Object(request_truth.clone()),
        );
    }
    let continuation_source = record(snapshot.and_then(|row| row.get("continuationContext")));
    let mut continuation = project_primitives(
        continuation_source,
        &["previousResponseId", "continuationOwner"],
    );
    let resume = project_primitives(
        record(continuation_source.and_then(|row| row.get("responsesResume"))),
        &[
            "previousResponseId",
            "responseId",
            "requestId",
            "chainId",
            "continuationOwner",
            "continuationScope",
            "stickyScope",
        ],
    );
    if !resume.is_empty() {
        continuation.insert("responsesResume".to_string(), Value::Object(resume));
    }
    if !continuation.is_empty() {
        projected_snapshot.insert(
            "continuationContext".to_string(),
            Value::Object(continuation),
        );
    }
    let mut runtime = project_primitives(
        record(snapshot.and_then(|row| row.get("runtimeControl"))),
        CONTROL_KEYS,
    );
    for (key, value) in
        project_primitives(record(metadata.get("__rt")), &["sessionDir", "rccUserDir"])
    {
        runtime.insert(key, value);
    }
    if !runtime.is_empty() {
        projected_snapshot.insert("runtimeControl".to_string(), Value::Object(runtime));
    }
    if let Some(snapshot) = snapshot {
        copy_string_array(&mut projected_snapshot, snapshot, "excludedProviderKeys");
    }
    for key in ["excludedProviderKeys", "allowedProviders"] {
        copy_string_array(&mut projected_snapshot, &metadata, key);
    }
    for key in [
        "requestId",
        "sessionId",
        "conversationId",
        "logSessionColorKey",
        "clientTmuxSessionId",
        "client_tmux_session_id",
        "tmuxSessionId",
        "tmux_session_id",
        "rccSessionClientTmuxSessionId",
        "rcc_session_client_tmux_session_id",
    ] {
        let value = request_truth.get(key).or_else(|| metadata.get(key));
        if let Some(text) = value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            projected_snapshot.insert(key.to_string(), Value::String(text.to_string()));
        }
    }
    for key in [
        "routecodexRoutingPolicyGroup",
        "routecodexLocalPort",
        "routecodexPortMode",
        "routecodexPortBinding",
    ] {
        copy_primitive(&mut projected_snapshot, &metadata, key);
    }
    out.insert(
        "metadataCenterSnapshot".to_string(),
        Value::Object(projected_snapshot),
    );
    Value::Object(out)
}

fn build_provider_projection(input: &Value) -> Value {
    let root = input.as_object();
    let metadata = record(root.and_then(|row| row.get("metadata")))
        .cloned()
        .unwrap_or_default();
    let mut out = Map::new();
    let entry = root
        .and_then(|row| row.get("entryEndpoint"))
        .and_then(Value::as_str)
        .or_else(|| metadata.get("entryEndpoint").and_then(Value::as_str));
    if let Some(text) = entry.map(str::trim).filter(|text| !text.is_empty()) {
        out.insert("entryEndpoint".into(), Value::String(text.into()));
    }
    let local_port = root
        .and_then(|row| row.get("localPort"))
        .filter(|value| value.as_f64().is_some_and(f64::is_finite))
        .or_else(|| {
            [
                "entryPort",
                "matchedPort",
                "routecodexLocalPort",
                "localPort",
            ]
            .iter()
            .find_map(|key| {
                metadata
                    .get(*key)
                    .filter(|value| value.as_f64().is_some_and(f64::is_finite))
            })
        });
    if let Some(number) = local_port {
        for key in ["entryPort", "matchedPort", "routecodexLocalPort"] {
            out.insert(key.into(), number.clone());
        }
    }
    copy_primitive(&mut out, &metadata, "routecodexRoutingPolicyGroup");
    for key in RUNTIME_KEYS {
        copy_primitive(&mut out, &metadata, key);
    }
    if root
        .and_then(|row| row.get("providerProtocol"))
        .and_then(Value::as_str)
        == Some("openai-responses")
    {
        out.insert("__responsesDirectPassthrough".into(), Value::Bool(true));
    }
    copy_dry_run(&metadata, &mut out);
    Value::Object(out)
}

// feature_id: hub.router_direct_runtime_metadata_effect_plan
fn plan_router_direct_runtime_metadata_effect(input: &Value) -> Value {
    if input.get("runtimeMetadataPresent").and_then(Value::as_bool) != Some(true) {
        return serde_json::json!({"action":"skip"});
    }
    let mut projected = Map::new();
    if let Some(source) = record(input.get("pipelineMetadata")) {
        copy_dry_run(source, &mut projected);
    }
    let dry_run_control = projected
        .get("__routecodexPipelineDryRun")
        .or_else(|| projected.get("__rccDryRunSerialized"))
        .cloned();
    serde_json::json!({
        "action":"attach",
        "dryRunControl": dry_run_control,
    })
}

fn run_projection(input_json: String, builder: fn(&Value) -> Value) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "direct runtime metadata input parse failed: {error}"
        ))
    })?;
    serde_json::to_string(&builder(&input)).map_err(|error| {
        napi::Error::from_reason(format!(
            "direct runtime metadata output serialize failed: {error}"
        ))
    })
}

#[napi(js_name = "buildRouterDirectRouteMetadataJson")]
pub fn build_router_direct_route_metadata_json(input_json: String) -> NapiResult<String> {
    run_projection(input_json, build_route_projection)
}

#[napi(js_name = "buildDirectProviderRuntimeMetadataJson")]
pub fn build_direct_provider_runtime_metadata_json(input_json: String) -> NapiResult<String> {
    run_projection(input_json, build_provider_projection)
}

#[napi(js_name = "planRouterDirectRuntimeMetadataEffectJson")]
pub fn plan_router_direct_runtime_metadata_effect_json(input_json: String) -> NapiResult<String> {
    run_projection(input_json, plan_router_direct_runtime_metadata_effect)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn route_projection_excludes_payload_mirrors() {
        let output = build_route_projection(
            &json!({"metadata":{"requestId":" r1 ","__raw_request_body":{"secret":"x"},"allowedProviders":[" p1 "]},"entryEndpoint":"/v1/responses"}),
        );
        assert_eq!(output["requestId"], "r1");
        assert_eq!(output["allowedProviders"], json!(["p1"]));
        assert!(output.get("__raw_request_body").is_none());
    }

    #[test]
    fn provider_projection_keeps_transport_controls_only() {
        let output = build_provider_projection(
            &json!({"metadata":{"clientRequestId":" c1 ","input":[1]},"localPort":5520,"providerProtocol":"openai-responses"}),
        );
        assert_eq!(output["clientRequestId"], "c1");
        assert_eq!(output["entryPort"], 5520);
        assert_eq!(output["__responsesDirectPassthrough"], true);
        assert!(output.get("input").is_none());
    }

    #[test]
    fn runtime_metadata_effect_requires_carrier_and_projects_only_valid_dry_run() {
        let control = serde_json::json!({"enabled":true,"kind":"provider_request","requestId":"dry-1"});
        let attach = plan_router_direct_runtime_metadata_effect(&serde_json::json!({
            "runtimeMetadataPresent":true,
            "pipelineMetadata":{"__rccDryRunSerialized":control,"payload":{"secret":true}}
        }));
        assert_eq!(attach["action"], "attach");
        assert_eq!(attach["dryRunControl"]["requestId"], "dry-1");
        assert_eq!(plan_router_direct_runtime_metadata_effect(&serde_json::json!({
            "runtimeMetadataPresent":false,
            "pipelineMetadata":{"__rccDryRunSerialized":control}
        }))["action"], "skip");
        assert!(plan_router_direct_runtime_metadata_effect(&serde_json::json!({
            "runtimeMetadataPresent":true,
            "pipelineMetadata":{"__rccDryRunSerialized":{"enabled":false,"kind":"provider_request"}}
        })).get("dryRunControl").is_some_and(Value::is_null));
    }
}
