use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

// feature_id: hub.response_post_servertool_client_projection

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubPipelineEffectPlan {
    #[serde(default)]
    pub effects: Vec<HubPipelineEffect>,
}

impl HubPipelineEffectPlan {
    pub fn empty() -> Self {
        Self {
            effects: Vec::new(),
        }
    }

    pub fn single(effect: HubPipelineEffect) -> Self {
        Self {
            effects: vec![effect],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubPipelineEffect {
    pub kind: HubPipelineEffectKind,
    #[serde(default)]
    pub payload: Value,
}

impl HubPipelineEffect {
    pub fn stream_pipe(payload: Value) -> Self {
        Self {
            kind: HubPipelineEffectKind::StreamPipe,
            payload,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum HubPipelineEffectKind {
    SnapshotWrite,
    ClockRuntimeAction,
    StoplessMetadataCenterWrite,
    ProviderHttpDispatch,
    StreamPipe,
    RuntimeStateWrite,
}

fn read_effect_payload<'a>(
    effect: &'a Map<String, Value>,
    kind: &str,
) -> Result<&'a Value, String> {
    let payload = effect
        .get("payload")
        .ok_or_else(|| format!("Rust HubPipeline {kind} effect missing payload"))?;
    if !payload.is_object() {
        return Err(format!("Rust HubPipeline {kind} effect missing payload"));
    }
    Ok(payload)
}

fn normalize_stream_pipe_payload(payload: &Value) -> Result<Value, String> {
    let record = payload
        .as_object()
        .ok_or_else(|| "Rust HubPipeline streamPipe effect missing payload".to_string())?;
    let codec = record.get("codec").and_then(Value::as_str).ok_or_else(|| {
        "Rust HubPipeline streamPipe effect returned unsupported codec".to_string()
    })?;
    if !matches!(
        codec,
        "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini-chat"
    ) {
        return Err("Rust HubPipeline streamPipe effect returned unsupported codec".to_string());
    }
    let request_id = record
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Rust HubPipeline streamPipe effect missing requestId".to_string())?;
    let mut output = json!({
        "codec": codec,
        "requestId": request_id,
    });
    if let Some(output_record) = output.as_object_mut() {
        if let Some(client_payload) = record.get("payload").filter(|value| value.is_object()) {
            output_record.insert("payload".to_string(), client_payload.clone());
        }
        if let Some(client_body) = record.get("body").filter(|value| value.is_object()) {
            output_record.insert("body".to_string(), client_body.clone());
        }
    }
    Ok(output)
}

pub fn normalize_provider_response_effect_plan(plan: &Value) -> Result<Value, String> {
    let record = plan
        .as_object()
        .ok_or_else(|| "Rust HubPipeline response native effect plan unavailable".to_string())?;
    let effects = record
        .get("effects")
        .and_then(Value::as_array)
        .ok_or_else(|| "Rust HubPipeline response native effect plan unavailable".to_string())?;

    let mut stream_pipe: Option<Value> = None;
    let mut runtime_state_write: Option<Value> = None;
    let mut stopless_metadata_center_write: Option<Value> = None;

    for effect in effects {
        let effect_record = effect.as_object().ok_or_else(|| {
            "Rust HubPipeline response effect plan returned unsupported effect kind".to_string()
        })?;
        let kind = effect_record
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                "Rust HubPipeline response effect plan returned unsupported effect kind".to_string()
            })?;
        match kind {
            "streamPipe" => {
                if stream_pipe.is_some() {
                    return Err(
                        "Rust HubPipeline response effect plan returned duplicate streamPipe effects"
                            .to_string(),
                    );
                }
                let payload = read_effect_payload(effect_record, "streamPipe")?;
                stream_pipe = Some(normalize_stream_pipe_payload(payload)?);
            }
            "runtimeStateWrite" => {
                if runtime_state_write.is_some() {
                    return Err("Rust HubPipeline response effect plan returned duplicate runtimeStateWrite effects".to_string());
                }
                runtime_state_write =
                    Some(read_effect_payload(effect_record, "runtimeStateWrite")?.clone());
            }
            "stoplessMetadataCenterWrite" => {
                if stopless_metadata_center_write.is_some() {
                    return Err("Rust HubPipeline response effect plan returned duplicate stoplessMetadataCenterWrite effects".to_string());
                }
                stopless_metadata_center_write = Some(
                    read_effect_payload(effect_record, "stoplessMetadataCenterWrite")?.clone(),
                );
            }
            _ => {
                return Err(
                    "Rust HubPipeline response effect plan returned unsupported effect kind"
                        .to_string(),
                );
            }
        }
    }

    Ok(json!({
        "streamPipe": stream_pipe,
        "runtimeStateWrite": runtime_state_write,
        "stoplessMetadataCenterWrite": stopless_metadata_center_write,
        "servertoolRuntimeActions": [],
    }))
}

pub fn normalize_provider_response_effect_plan_json(input_json: String) -> napi::Result<String> {
    let value: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(format!("invalid effect plan JSON: {error}")))?;
    let output =
        normalize_provider_response_effect_plan(&value).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output)
        .map_err(|error| napi::Error::from_reason(format!("serialize effect plan failed: {error}")))
}

pub fn project_metadata_write_plan_to_runtime_control(input: &Value) -> Result<Value, String> {
    let record = input.as_object().ok_or_else(|| {
        "Rust HubPipeline metadata write plan projector missing input".to_string()
    })?;
    let plan = record
        .get("plan")
        .and_then(Value::as_object)
        .ok_or_else(|| "Rust HubPipeline metadata write plan projector missing plan".to_string())?;
    let mut runtime_control = Map::new();

    for (key, value) in plan {
        if key == "learnedNote" || value.is_null() {
            continue;
        }
        runtime_control.insert(key.clone(), value.clone());
    }

    Ok(Value::Object(runtime_control))
}

pub fn project_metadata_write_plan_to_runtime_control_json(
    input_json: String,
) -> napi::Result<String> {
    let value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid metadata write plan projector JSON: {error}"
        ))
    })?;
    let output =
        project_metadata_write_plan_to_runtime_control(&value).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize metadata write plan projector failed: {error}"
        ))
    })
}

pub fn project_metadata_write_plan_to_runtime_control_write_plan(
    input: &Value,
) -> Result<Value, String> {
    let runtime_control = project_metadata_write_plan_to_runtime_control(input)?;
    let runtime_control = runtime_control
        .as_object()
        .filter(|record| !record.is_empty())
        .map(|record| Value::Object(record.clone()))
        .unwrap_or(Value::Null);

    Ok(json!({
        "runtimeControl": runtime_control
    }))
}

pub fn project_metadata_write_plan_to_runtime_control_write_plan_json(
    input_json: String,
) -> napi::Result<String> {
    let value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid metadata write plan runtime-control write-plan JSON: {error}"
        ))
    })?;
    let output = project_metadata_write_plan_to_runtime_control_write_plan(&value)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize metadata write plan runtime-control write-plan failed: {error}"
        ))
    })
}

fn request_stage_error_prefix(entry_mode: &str) -> &'static str {
    if entry_mode == "chat_process" {
        "Rust HubPipeline chat_process path"
    } else {
        "Rust HubPipeline request path"
    }
}

pub fn build_request_stage_native_result_plan(input: &Value) -> Result<Value, String> {
    let record = input
        .as_object()
        .ok_or_else(|| "Rust HubPipeline request-stage result planner missing input".to_string())?;
    let native_plan = record
        .get("nativePlan")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            "Rust HubPipeline request-stage result planner missing nativePlan".to_string()
        })?;
    let entry_mode = record
        .get("entryMode")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("request_stage");
    let prefix = request_stage_error_prefix(entry_mode);

    if native_plan.get("success").and_then(Value::as_bool) != Some(true) {
        let native_error = native_plan.get("error").and_then(Value::as_object);
        let code = native_error
            .and_then(|row| row.get("code"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("hub_pipeline_request_native_failed");
        let message = native_error
            .and_then(|row| row.get("message"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("{prefix} failed"));
        let mut error = Map::new();
        error.insert("code".to_string(), Value::String(code.to_string()));
        error.insert("message".to_string(), Value::String(message));
        if let Some(details) = native_error.and_then(|row| row.get("details")) {
            error.insert("details".to_string(), details.clone());
        }
        if code == "MALFORMED_REQUEST" {
            error.insert("status".to_string(), json!(400));
            error.insert("statusCode".to_string(), json!(400));
        }
        return Ok(json!({
            "ok": false,
            "error": Value::Object(error)
        }));
    }

    let provider_payload = native_plan
        .get("payload")
        .filter(|value| value.is_object())
        .ok_or_else(|| format!("{prefix} returned invalid provider payload"))?;
    let metadata = native_plan
        .get("metadata")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let diagnostics = native_plan
        .get("diagnostics")
        .filter(|value| value.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]));

    let mut output = Map::new();
    output.insert("ok".to_string(), Value::Bool(true));
    output.insert("providerPayload".to_string(), provider_payload.clone());
    output.insert("metadata".to_string(), metadata);
    output.insert("diagnostics".to_string(), diagnostics);
    if entry_mode != "chat_process" {
        if let Some(standardized_request) = native_plan
            .get("standardizedRequest")
            .filter(|value| value.is_object())
        {
            output.insert(
                "standardizedRequest".to_string(),
                standardized_request.clone(),
            );
        }
    }

    Ok(Value::Object(output))
}

pub fn build_request_stage_native_result_plan_json(input_json: String) -> napi::Result<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid request-stage native result plan JSON: {error}"
        ))
    })?;
    let output =
        build_request_stage_native_result_plan(&value).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize request-stage native result plan failed: {error}"
        ))
    })
}

pub fn build_request_stage_hub_pipeline_result(input: &Value) -> Result<Value, String> {
    let record = input
        .as_object()
        .ok_or_else(|| "Rust HubPipeline request-stage result builder missing input".to_string())?;
    let request_id = record
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Rust HubPipeline request-stage result builder missing requestId".to_string()
        })?;
    let result_plan = record
        .get("resultPlan")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            "Rust HubPipeline request-stage result builder missing resultPlan".to_string()
        })?;
    let entry_mode = record
        .get("entryMode")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("request_stage");

    if result_plan.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(
            "Rust HubPipeline request-stage result builder requires ok resultPlan".to_string(),
        );
    }

    let provider_payload = result_plan
        .get("providerPayload")
        .filter(|value| value.is_object())
        .ok_or_else(|| {
            "Rust HubPipeline request-stage result builder missing providerPayload".to_string()
        })?;
    let metadata = result_plan
        .get("metadata")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            "Rust HubPipeline request-stage result builder missing metadata".to_string()
        })?;
    let diagnostics = result_plan
        .get("diagnostics")
        .filter(|value| value.is_array())
        .ok_or_else(|| {
            "Rust HubPipeline request-stage result builder missing diagnostics".to_string()
        })?;

    let mut output = Map::new();
    output.insert(
        "requestId".to_string(),
        Value::String(request_id.to_string()),
    );
    output.insert("providerPayload".to_string(), provider_payload.clone());
    if let Some(target) = metadata.get("target") {
        output.insert("target".to_string(), target.clone());
    }
    if let Some(routing_decision) = metadata.get("routingDecision") {
        output.insert("routingDecision".to_string(), routing_decision.clone());
    }
    if let Some(routing_diagnostics) = metadata.get("routingDiagnostics") {
        output.insert(
            "routingDiagnostics".to_string(),
            routing_diagnostics.clone(),
        );
    }
    output.insert("metadata".to_string(), Value::Object(metadata.clone()));
    output.insert("nodeResults".to_string(), diagnostics.clone());
    if entry_mode != "chat_process" {
        if let Some(standardized_request) = result_plan
            .get("standardizedRequest")
            .filter(|value| value.is_object())
        {
            output.insert(
                "standardizedRequest".to_string(),
                standardized_request.clone(),
            );
        }
    }

    Ok(Value::Object(output))
}

pub fn build_request_stage_hub_pipeline_result_json(input_json: String) -> napi::Result<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid request-stage HubPipeline result JSON: {error}"
        ))
    })?;
    let output =
        build_request_stage_hub_pipeline_result(&value).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize request-stage HubPipeline result failed: {error}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_request_stage_hub_pipeline_result, build_request_stage_native_result_plan,
        normalize_provider_response_effect_plan,
        project_metadata_write_plan_to_runtime_control,
        project_metadata_write_plan_to_runtime_control_write_plan,
    };
    use serde_json::{json, Value};

    #[test]
    fn normalizes_provider_response_effect_plan() {
        let output = normalize_provider_response_effect_plan(&json!({
            "effects": [
                {
                    "kind": "streamPipe",
                    "payload": {
                        "codec": "openai-chat",
                        "requestId": " req-1 ",
                        "payload": { "ignored": true }
                    }
                },
                {
                    "kind": "runtimeStateWrite",
                    "payload": { "requestId": "req-1", "keepForSubmitToolOutputs": false }
                }
            ]
        }))
        .unwrap();
        assert_eq!(
            output["streamPipe"],
            json!({ "codec": "openai-chat", "requestId": "req-1", "payload": { "ignored": true } })
        );
        assert_eq!(output["runtimeStateWrite"]["requestId"], json!("req-1"));
        assert_eq!(output["servertoolRuntimeActions"], json!([]));
    }

    #[test]
    fn rejects_duplicate_stream_pipe_effects() {
        let error = normalize_provider_response_effect_plan(&json!({
            "effects": [
                { "kind": "streamPipe", "payload": { "codec": "openai-chat", "requestId": "req-1" } },
                { "kind": "streamPipe", "payload": { "codec": "openai-chat", "requestId": "req-1" } }
            ]
        }))
        .unwrap_err();
        assert!(error.contains("duplicate streamPipe effects"));
    }

    #[test]
    fn rejects_unknown_effect_kind() {
        let error = normalize_provider_response_effect_plan(&json!({
            "effects": [{ "kind": "providerHttpDispatch", "payload": {} }]
        }))
        .unwrap_err();
        assert!(error.contains("unsupported effect kind"));
    }

    #[test]
    fn projects_metadata_write_plan_to_runtime_control_in_rust() {
        let output = project_metadata_write_plan_to_runtime_control(&json!({
            "plan": {
                "servertool": true,
                "providerProtocol": "openai-chat",
                "learnedNote": { "ignored": true },
                "nullField": null,
                "nested": { "keep": true }
            }
        }))
        .unwrap();

        assert_eq!(
            output,
            json!({
                "servertool": true,
                "providerProtocol": "openai-chat",
                "nested": { "keep": true }
            })
        );
    }

    #[test]
    fn projects_metadata_write_plan_to_runtime_control_write_plan_in_rust() {
        let output = project_metadata_write_plan_to_runtime_control_write_plan(&json!({
            "plan": {
                "servertool": true,
                "learnedNote": { "ignored": true },
                "nullField": null
            }
        }))
        .unwrap();

        assert_eq!(
            output,
            json!({
                "runtimeControl": {
                    "servertool": true
                }
            })
        );
    }

    #[test]
    fn metadata_write_plan_runtime_control_write_plan_omits_empty_projection() {
        let output = project_metadata_write_plan_to_runtime_control_write_plan(&json!({
            "plan": {
                "learnedNote": { "ignored": true },
                "nullField": null
            }
        }))
        .unwrap();

        assert_eq!(output["runtimeControl"], Value::Null);
    }

    #[test]
    fn request_stage_result_plan_maps_malformed_request_to_http_400() {
        let output = build_request_stage_native_result_plan(&json!({
            "entryMode": "request_stage",
            "nativePlan": {
                "success": false,
                "error": {
                    "code": "MALFORMED_REQUEST",
                    "message": "bad request"
                }
            }
        }))
        .unwrap();

        assert_eq!(output["ok"], json!(false));
        assert_eq!(output["error"]["code"], json!("MALFORMED_REQUEST"));
        assert_eq!(output["error"]["status"], json!(400));
        assert_eq!(output["error"]["statusCode"], json!(400));
    }

    #[test]
    fn request_stage_result_plan_rejects_invalid_provider_payload() {
        let error = build_request_stage_native_result_plan(&json!({
            "entryMode": "chat_process",
            "nativePlan": {
                "success": true,
                "payload": null,
                "metadata": {},
                "diagnostics": []
            }
        }))
        .unwrap_err();

        assert!(error.contains("chat_process path returned invalid provider payload"));
    }

    #[test]
    fn request_stage_hub_pipeline_result_projects_metadata_edges() {
        let output = build_request_stage_hub_pipeline_result(&json!({
            "requestId": "req_result",
            "entryMode": "request_stage",
            "resultPlan": {
                "ok": true,
                "providerPayload": { "model": "gpt-5.5" },
                "metadata": {
                    "target": { "providerKey": "key1" },
                    "routingDecision": { "routeName": "thinking" },
                    "routingDiagnostics": { "reason": "selected" },
                    "runtime_control": { "providerProtocol": "openai-responses" }
                },
                "diagnostics": [
                    { "id": "node-1", "success": true, "metadata": {} }
                ],
                "standardizedRequest": { "messages": [] }
            }
        }))
        .unwrap();

        assert_eq!(output["requestId"], json!("req_result"));
        assert_eq!(output["providerPayload"]["model"], json!("gpt-5.5"));
        assert_eq!(output["target"]["providerKey"], json!("key1"));
        assert_eq!(output["routingDecision"]["routeName"], json!("thinking"));
        assert_eq!(output["routingDiagnostics"]["reason"], json!("selected"));
        assert_eq!(
            output["metadata"]["runtime_control"]["providerProtocol"],
            json!("openai-responses")
        );
        assert_eq!(output["nodeResults"][0]["id"], json!("node-1"));
        assert_eq!(output["standardizedRequest"]["messages"], json!([]));
    }

    #[test]
    fn request_stage_hub_pipeline_result_omits_standardized_request_for_chat_process_entry() {
        let output = build_request_stage_hub_pipeline_result(&json!({
            "requestId": "req_result",
            "entryMode": "chat_process",
            "resultPlan": {
                "ok": true,
                "providerPayload": { "model": "gpt-5.5" },
                "metadata": {},
                "diagnostics": [],
                "standardizedRequest": { "messages": [] }
            }
        }))
        .unwrap();

        assert!(output.get("standardizedRequest").is_none());
    }

    #[test]
    fn rejects_non_object_metadata_write_plan() {
        let error = project_metadata_write_plan_to_runtime_control(&json!({
            "plan": ["bad"]
        }))
        .unwrap_err();
        assert!(error.contains("missing plan"));
    }
}
