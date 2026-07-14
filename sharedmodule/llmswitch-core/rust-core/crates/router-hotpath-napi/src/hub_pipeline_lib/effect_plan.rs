use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

// feature_id: hub.response_post_servertool_client_projection
// feature_id: hub.provider_response_outbound_effect_materialization

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

fn read_effect_payload_owned(effect: &mut Map<String, Value>, kind: &str) -> Result<Value, String> {
    let payload = effect
        .remove("payload")
        .ok_or_else(|| format!("Rust HubPipeline {kind} effect missing payload"))?;
    if !payload.is_object() {
        return Err(format!("Rust HubPipeline {kind} effect missing payload"));
    }
    Ok(payload)
}

fn normalize_stream_pipe_payload(payload: &Value) -> Result<Value, String> {
    normalize_stream_pipe_payload_owned(payload.clone())
}

fn ensure_stream_pipe_metadata_only(record: &Map<String, Value>) -> Result<(), String> {
    if record.contains_key("payload") || record.contains_key("body") {
        return Err("Rust HubPipeline streamPipe effect must not own client payload".to_string());
    }
    Ok(())
}

fn normalize_stream_pipe_payload_owned(payload: Value) -> Result<Value, String> {
    let mut payload = payload;
    let record = payload
        .as_object_mut()
        .ok_or_else(|| "Rust HubPipeline streamPipe effect missing payload".to_string())?;
    ensure_stream_pipe_metadata_only(record)?;
    let codec = record
        .get("codec")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| {
            "Rust HubPipeline streamPipe effect returned unsupported codec".to_string()
        })?;
    if !matches!(
        codec,
        "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini-chat"
    ) {
        return Err("Rust HubPipeline streamPipe effect returned unsupported codec".to_string());
    }
    let codec = codec.to_string();
    let request_id = record
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Rust HubPipeline streamPipe effect missing requestId".to_string())?;
    let request_id = request_id.to_string();
    let mut output = Map::new();
    output.insert("codec".to_string(), Value::String(codec));
    output.insert("requestId".to_string(), Value::String(request_id));
    Ok(Value::Object(output))
}

fn normalize_runtime_state_write_payload(payload: &Value) -> Result<Value, String> {
    normalize_runtime_state_write_payload_owned(payload.clone())
}

fn normalize_runtime_state_write_payload_owned(payload: Value) -> Result<Value, String> {
    let mut payload = payload;
    let record = payload
        .as_object_mut()
        .ok_or_else(|| "Rust HubPipeline runtimeStateWrite effect missing payload".to_string())?;
    let mut output = Map::new();

    if let Some(usage) = record.get("usage") {
        if usage.is_object() {
            let usage = record
                .remove("usage")
                .expect("usage validated before removal");
            output.insert("usage".to_string(), usage);
        } else if !usage.is_null() {
            return Err(
                "Rust HubPipeline runtimeStateWrite usage must be an object or null".to_string(),
            );
        }
    }

    if let Some(keep_for_submit) = record.get("keepForSubmitToolOutputs") {
        match keep_for_submit.as_bool() {
            Some(true) => {
                output.insert("keepForSubmitToolOutputs".to_string(), Value::Bool(true));
            }
            Some(false) => {}
            None => {
                return Err(
                    "Rust HubPipeline runtimeStateWrite keepForSubmitToolOutputs must be boolean"
                        .to_string(),
                );
            }
        }
    }

    Ok(Value::Object(output))
}

fn normalize_provider_response_effect_plan(plan: &Value) -> Result<Value, String> {
    normalize_provider_response_effect_plan_owned(plan.clone())
}

fn normalize_provider_response_effect_plan_owned(plan: Value) -> Result<Value, String> {
    let mut plan = plan;
    let record = plan
        .as_object_mut()
        .ok_or_else(|| "Rust HubPipeline response native effect plan unavailable".to_string())?;
    let effects = match record.remove("effects") {
        Some(Value::Array(effects)) => effects,
        _ => {
            return Err("Rust HubPipeline response native effect plan unavailable".to_string());
        }
    };

    let mut stream_pipe: Option<Value> = None;
    let mut runtime_state_write: Option<Value> = None;
    let mut stopless_metadata_center_write: Option<Value> = None;

    for effect in effects {
        let mut effect = effect;
        let effect_record = effect.as_object_mut().ok_or_else(|| {
            "Rust HubPipeline response effect plan returned unsupported effect kind".to_string()
        })?;
        let kind = effect_record
            .get("kind")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| {
                "Rust HubPipeline response effect plan returned unsupported effect kind".to_string()
            })?;
        match kind.as_str() {
            "streamPipe" => {
                if stream_pipe.is_some() {
                    return Err(
                        "Rust HubPipeline response effect plan returned duplicate streamPipe effects"
                            .to_string(),
                    );
                }
                let payload = read_effect_payload_owned(effect_record, "streamPipe")?;
                stream_pipe = Some(normalize_stream_pipe_payload_owned(payload)?);
            }
            "runtimeStateWrite" => {
                if runtime_state_write.is_some() {
                    return Err("Rust HubPipeline response effect plan returned duplicate runtimeStateWrite effects".to_string());
                }
                let payload = read_effect_payload_owned(effect_record, "runtimeStateWrite")?;
                runtime_state_write = Some(normalize_runtime_state_write_payload_owned(payload)?);
            }
            "stoplessMetadataCenterWrite" => {
                if stopless_metadata_center_write.is_some() {
                    return Err("Rust HubPipeline response effect plan returned duplicate stoplessMetadataCenterWrite effects".to_string());
                }
                stopless_metadata_center_write = Some(read_effect_payload_owned(
                    effect_record,
                    "stoplessMetadataCenterWrite",
                )?);
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

pub fn materialize_provider_response_outbound_effect_plan(plan: &Value) -> Result<Value, String> {
    materialize_provider_response_outbound_effect_plan_owned(plan.clone())
}

pub fn materialize_provider_response_outbound_effect_plan_owned(
    plan: Value,
) -> Result<Value, String> {
    let mut plan = plan;
    let record = plan.as_object_mut().ok_or_else(|| {
        "Rust HubPipeline response outbound effect materializer missing native plan".to_string()
    })?;
    let raw_payload = record
        .remove("payload")
        .filter(|value| value.is_object())
        .ok_or_else(|| {
            "Rust HubPipeline response outbound effect materializer missing payload".to_string()
        })?;
    let request_id = record
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            "Rust HubPipeline response outbound effect materializer missing requestId".to_string()
        })?;
    let diagnostics = record
        .remove("diagnostics")
        .filter(|value| value.is_array())
        .ok_or_else(|| {
            "Rust HubPipeline response outbound effect materializer missing diagnostics".to_string()
        })?;
    let effect_plan = record.remove("effectPlan").ok_or_else(|| {
        "Rust HubPipeline response outbound effect materializer missing effectPlan".to_string()
    })?;
    let runtime_effects = normalize_provider_response_effect_plan_owned(effect_plan)?;

    let mut diagnostic_input = Map::new();
    diagnostic_input.insert("requestId".to_string(), Value::String(request_id));
    diagnostic_input.insert("diagnostics".to_string(), diagnostics);

    let mut output = Map::new();
    output.insert("rawPayload".to_string(), raw_payload);
    output.insert("runtimeEffects".to_string(), runtime_effects);
    output.insert(
        "diagnosticInput".to_string(),
        Value::Object(diagnostic_input),
    );
    Ok(Value::Object(output))
}

pub fn materialize_provider_response_outbound_effect_plan_json(
    input_json: String,
) -> napi::Result<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid response outbound effect materialization JSON: {error}"
        ))
    })?;
    let output = materialize_provider_response_outbound_effect_plan_owned(value)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize response outbound effect materialization failed: {error}"
        ))
    })
}

// feature_id: hub.provider_response_stage_recorder_effect_plan
pub fn plan_provider_response_stage_recorder_effect(input: &Value) -> Result<Value, String> {
    let record = input.as_object().ok_or_else(|| {
        "Rust HubPipeline response stage recorder planner missing input".to_string()
    })?;
    let client_semantic = record
        .get("clientSemantic")
        .filter(|value| value.is_object())
        .ok_or_else(|| {
            "Rust HubPipeline response stage recorder planner missing clientSemantic".to_string()
        })?;
    let stream_pipe = record.get("streamPipe").ok_or_else(|| {
        "Rust HubPipeline response stage recorder planner missing streamPipe".to_string()
    })?;
    let protocol = if stream_pipe.is_null() {
        "native-effect-plan"
    } else {
        let stream_pipe_record = stream_pipe.as_object().ok_or_else(|| {
            "Rust HubPipeline response stage recorder planner malformed streamPipe".to_string()
        })?;
        stream_pipe_record
            .get("codec")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "Rust HubPipeline response stage recorder planner malformed streamPipe codec"
                    .to_string()
            })?
    };

    Ok(json!({
        "records": [
            {
                "stage": "chat_process.resp.stage9.client_remap",
                "payload": client_semantic,
            },
            {
                "stage": "chat_process.resp.stage10.sse_stream",
                "payload": {
                    "passthrough": false,
                    "protocol": protocol,
                    "payload": client_semantic,
                },
            }
        ]
    }))
}

pub fn plan_provider_response_stage_recorder_effect_json(
    input_json: String,
) -> napi::Result<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid response stage recorder effect JSON: {error}"
        ))
    })?;
    let output =
        plan_provider_response_stage_recorder_effect(&value).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize response stage recorder effect failed: {error}"
        ))
    })
}

// feature_id: hub.provider_response_diagnostic_alarm_effect_plan
pub fn plan_provider_response_diagnostic_alarm_effect(input: &Value) -> Result<Value, String> {
    let record = input.as_object().ok_or_else(|| {
        "Rust HubPipeline response diagnostic alarm planner missing input".to_string()
    })?;
    let request_id = record
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Rust HubPipeline response diagnostic alarm planner missing requestId".to_string()
        })?;
    let diagnostics = record
        .get("diagnostics")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "Rust HubPipeline response diagnostic alarm planner missing diagnostics".to_string()
        })?;

    let mut messages = Vec::new();
    for diagnostic in diagnostics {
        let Some(details) = diagnostic.get("details").and_then(Value::as_object) else {
            continue;
        };
        let Some(alarm) = details
            .get("alarm")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let details_json = serde_json::to_string(details).map_err(|error| {
            format!("serialize provider response diagnostic alarm details failed: {error}")
        })?;
        messages.push(format!(
            "[hub-pipeline][alarm] {alarm} requestId={request_id} details={details_json}"
        ));
    }

    if messages.is_empty() {
        return Ok(json!({ "action": "no_op" }));
    }
    Ok(json!({ "action": "emit", "messages": messages }))
}

pub fn plan_provider_response_diagnostic_alarm_effect_json(
    input_json: String,
) -> napi::Result<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid provider response diagnostic alarm input JSON: {error}"
        ))
    })?;
    let output =
        plan_provider_response_diagnostic_alarm_effect(&value).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize provider response diagnostic alarm effect failed: {error}"
        ))
    })
}

// feature_id: hub.provider_response_servertool_retirement_effect_plan
pub fn plan_provider_response_servertool_retirement_effect(input: &Value) -> Result<Value, String> {
    let record = input.as_object().ok_or_else(|| {
        "Rust HubPipeline response servertool retirement planner missing input".to_string()
    })?;
    let actions = record
        .get("servertoolRuntimeActions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "Rust HubPipeline response path returned malformed servertool runtime actions"
                .to_string()
        })?;

    if actions.is_empty() {
        return Ok(json!({ "action": "continue" }));
    }

    let stop_gateway_write = actions.iter().find_map(|action| {
        action.as_object().and_then(|record| {
            record
                .get("stopGateway")
                .filter(|value| value.is_object())
                .map(|value| {
                    json!({
                        "stopGatewayContext": value,
                        "writer": {
                            "module": "provider-response.ts",
                            "symbol": "convertProviderResponse",
                            "stage": "HubRespChatProcess03Governed"
                        },
                        "reason": "rust stop gateway control signal"
                    })
                })
        })
    });

    Ok(json!({
        "action": "reject_legacy_actions",
        "stopGatewayWrite": stop_gateway_write,
        "errorMessage": "Rust HubPipeline returned unsupported servertool runtime actions; server-side tool execution has been removed and CLI-owned tools must be projected by Rust"
    }))
}

pub fn plan_provider_response_servertool_retirement_effect_json(
    input_json: String,
) -> napi::Result<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid provider response servertool retirement input JSON: {error}"
        ))
    })?;
    let output = plan_provider_response_servertool_retirement_effect(&value)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize provider response servertool retirement plan failed: {error}"
        ))
    })
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

// feature_id: hub.provider_response_stopless_runtime_control_effect_plan
pub fn plan_provider_response_stopless_runtime_control_effect(
    input: &Value,
) -> Result<Value, String> {
    let record = input.as_object().ok_or_else(|| {
        "Rust provider response stopless runtime-control planner missing input".to_string()
    })?;
    let source = record
        .get("stoplessMetadataCenterWrite")
        .unwrap_or(&Value::Null);
    let is_absent = source.is_null()
        || source.as_bool() == Some(false)
        || source.as_f64() == Some(0.0)
        || source.as_str() == Some("");
    if is_absent {
        return Ok(json!({ "action": "no_op" }));
    }

    let source = source.as_object().ok_or_else(|| {
        "Rust provider response stopless runtime-control planner malformed write plan".to_string()
    })?;
    for key in source.keys() {
        if !matches!(
            key.as_str(),
            "stopless" | "stopMessageCompareContext" | "learnedNote"
        ) {
            return Err(format!(
                "Rust provider response stopless runtime-control planner unknown write-plan field: {key}"
            ));
        }
    }
    let mut runtime_control = Map::new();
    for key in ["stopless", "stopMessageCompareContext"] {
        if let Some(value) = source.get(key).filter(|value| !value.is_null()) {
            if !value.is_object() {
                return Err(format!(
                    "Rust provider response stopless runtime-control planner malformed {key}"
                ));
            }
            runtime_control.insert(key.to_string(), value.clone());
        }
    }
    if runtime_control.is_empty() {
        return Ok(json!({ "action": "no_op" }));
    }

    Ok(json!({
        "action": "apply_runtime_control",
        "runtimeControl": Value::Object(runtime_control),
        "writer": {
            "module": "provider-response.ts",
            "symbol": "convertProviderResponse",
            "stage": "HubRespChatProcess03Governed"
        },
        "reason": "rust response chatprocess runtime control"
    }))
}

pub fn plan_provider_response_stopless_runtime_control_effect_json(
    input_json: String,
) -> napi::Result<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid provider response stopless runtime-control input JSON: {error}"
        ))
    })?;
    let output = plan_provider_response_stopless_runtime_control_effect(&value)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize provider response stopless runtime-control plan failed: {error}"
        ))
    })
}

// feature_id: hub.provider_response_stream_pipe_effect_plan
pub fn plan_provider_response_stream_pipe_effect(input: &Value) -> Result<Value, String> {
    let record = input
        .as_object()
        .ok_or_else(|| "Rust provider response stream-pipe planner missing input".to_string())?;
    let source = record.get("streamPipe").unwrap_or(&Value::Null);
    if source.is_null() {
        return Ok(json!({ "action": "no_pipe" }));
    }
    let pipe = source.as_object().ok_or_else(|| {
        "Rust HubPipeline response path returned malformed stream pipe effect".to_string()
    })?;
    ensure_stream_pipe_metadata_only(pipe)?;
    let codec = pipe
        .get("codec")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let request_id = pipe
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (Some(codec), Some(request_id)) = (codec, request_id) else {
        return Err(
            "Rust HubPipeline response path returned malformed stream pipe effect".to_string(),
        );
    };
    Ok(json!({
        "action": "use_pipe",
        "pipe": {
            "codec": codec,
            "requestId": request_id
        }
    }))
}

pub fn plan_provider_response_stream_pipe_effect_json(input_json: String) -> napi::Result<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid provider response stream-pipe input JSON: {error}"
        ))
    })?;
    let output =
        plan_provider_response_stream_pipe_effect(&value).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize provider response stream-pipe plan failed: {error}"
        ))
    })
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
    build_request_stage_native_result_plan_owned(input.clone())
}

pub fn build_request_stage_native_result_plan_owned(input: Value) -> Result<Value, String> {
    let mut input = input;
    let record = input
        .as_object_mut()
        .ok_or_else(|| "Rust HubPipeline request-stage result planner missing input".to_string())?;
    let entry_mode = record
        .get("entryMode")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("request_stage")
        .to_string();
    let prefix = request_stage_error_prefix(&entry_mode);
    let mut native_plan = record.remove("nativePlan").ok_or_else(|| {
        "Rust HubPipeline request-stage result planner missing nativePlan".to_string()
    })?;
    let native_plan_record = native_plan.as_object_mut().ok_or_else(|| {
        "Rust HubPipeline request-stage result planner missing nativePlan".to_string()
    })?;

    if native_plan_record.get("success").and_then(Value::as_bool) != Some(true) {
        let mut native_error = native_plan_record
            .remove("error")
            .unwrap_or_else(|| json!({}));
        let native_error = native_error.as_object_mut();
        let code = native_error
            .as_ref()
            .and_then(|row| row.get("code"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("hub_pipeline_request_native_failed")
            .to_string();
        let message = native_error
            .as_ref()
            .and_then(|row| row.get("message"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("{prefix} failed"));
        let mut error = Map::new();
        error.insert("code".to_string(), Value::String(code.clone()));
        error.insert("message".to_string(), Value::String(message));
        if let Some(details) = native_error.and_then(|row| row.remove("details")) {
            error.insert("details".to_string(), details);
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

    let provider_payload = native_plan_record
        .remove("payload")
        .filter(|value| value.is_object())
        .ok_or_else(|| format!("{prefix} returned invalid provider payload"))?;
    let metadata = native_plan_record
        .remove("metadata")
        .filter(|value| value.is_object())
        .unwrap_or_else(|| json!({}));
    let diagnostics = native_plan_record
        .remove("diagnostics")
        .filter(|value| value.is_array())
        .unwrap_or_else(|| json!([]));

    let mut output = Map::new();
    output.insert("ok".to_string(), Value::Bool(true));
    output.insert("providerPayload".to_string(), provider_payload);
    output.insert("metadata".to_string(), metadata);
    output.insert("diagnostics".to_string(), diagnostics);
    if entry_mode != "chat_process" {
        if let Some(standardized_request) = native_plan_record
            .remove("standardizedRequest")
            .filter(|value| value.is_object())
        {
            output.insert("standardizedRequest".to_string(), standardized_request);
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
        build_request_stage_native_result_plan_owned(value).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize request-stage native result plan failed: {error}"
        ))
    })
}

pub fn build_request_stage_hub_pipeline_result(input: &Value) -> Result<Value, String> {
    build_request_stage_hub_pipeline_result_owned(input.clone())
}

pub fn build_request_stage_hub_pipeline_result_owned(input: Value) -> Result<Value, String> {
    let mut input = input;
    let record = input
        .as_object_mut()
        .ok_or_else(|| "Rust HubPipeline request-stage result builder missing input".to_string())?;
    let request_id = record
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            "Rust HubPipeline request-stage result builder missing requestId".to_string()
        })?;
    let entry_mode = record
        .get("entryMode")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("request_stage")
        .to_string();
    let mut result_plan = record.remove("resultPlan").ok_or_else(|| {
        "Rust HubPipeline request-stage result builder missing resultPlan".to_string()
    })?;
    let result_plan = result_plan.as_object_mut().ok_or_else(|| {
        "Rust HubPipeline request-stage result builder missing resultPlan".to_string()
    })?;

    if result_plan.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(
            "Rust HubPipeline request-stage result builder requires ok resultPlan".to_string(),
        );
    }

    let provider_payload = result_plan
        .remove("providerPayload")
        .filter(|value| value.is_object())
        .ok_or_else(|| {
            "Rust HubPipeline request-stage result builder missing providerPayload".to_string()
        })?;
    let metadata = result_plan
        .remove("metadata")
        .filter(|value| value.is_object())
        .ok_or_else(|| {
            "Rust HubPipeline request-stage result builder missing metadata".to_string()
        })?;
    let diagnostics = result_plan
        .remove("diagnostics")
        .filter(|value| value.is_array())
        .ok_or_else(|| {
            "Rust HubPipeline request-stage result builder missing diagnostics".to_string()
        })?;

    let mut output = Map::new();
    output.insert("requestId".to_string(), Value::String(request_id));
    output.insert("providerPayload".to_string(), provider_payload);
    let metadata_record = metadata
        .as_object()
        .expect("metadata object validated before projection");
    if let Some(target) = metadata_record.get("target") {
        output.insert("target".to_string(), target.clone());
    }
    if let Some(routing_decision) = metadata_record.get("routingDecision") {
        output.insert("routingDecision".to_string(), routing_decision.clone());
    }
    if let Some(routing_diagnostics) = metadata_record.get("routingDiagnostics") {
        output.insert(
            "routingDiagnostics".to_string(),
            routing_diagnostics.clone(),
        );
    }
    output.insert("metadata".to_string(), metadata);
    output.insert("nodeResults".to_string(), diagnostics);
    if entry_mode != "chat_process" {
        if let Some(standardized_request) = result_plan
            .remove("standardizedRequest")
            .filter(|value| value.is_object())
        {
            output.insert("standardizedRequest".to_string(), standardized_request);
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
        build_request_stage_hub_pipeline_result_owned(value).map_err(napi::Error::from_reason)?;
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
        materialize_provider_response_outbound_effect_plan,
        normalize_provider_response_effect_plan, plan_provider_response_diagnostic_alarm_effect,
        plan_provider_response_servertool_retirement_effect,
        plan_provider_response_stage_recorder_effect,
        plan_provider_response_stopless_runtime_control_effect,
        plan_provider_response_stream_pipe_effect, project_metadata_write_plan_to_runtime_control,
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
                        "requestId": " req-1 "
                    }
                },
                {
                    "kind": "runtimeStateWrite",
                    "payload": {
                        "requestId": "req-1",
                        "clientProtocol": "openai-chat",
                        "payload": { "duplicate": "client-response" },
                        "responseRecord": {
                            "response": { "duplicate": "continuation-response" }
                        },
                        "usage": { "input_tokens": 3, "output_tokens": 5 },
                        "keepForSubmitToolOutputs": true
                    }
                }
            ]
        }))
        .unwrap();
        assert_eq!(
            output["streamPipe"],
            json!({ "codec": "openai-chat", "requestId": "req-1" })
        );
        assert!(output["streamPipe"].get("payload").is_none());
        assert!(output["streamPipe"].get("body").is_none());
        assert_eq!(
            output["runtimeStateWrite"],
            json!({
                "usage": { "input_tokens": 3, "output_tokens": 5 },
                "keepForSubmitToolOutputs": true
            })
        );
        assert!(output["runtimeStateWrite"].get("requestId").is_none());
        assert!(output["runtimeStateWrite"].get("clientProtocol").is_none());
        assert!(output["runtimeStateWrite"].get("payload").is_none());
        assert!(output["runtimeStateWrite"].get("responseRecord").is_none());
        assert_eq!(output["servertoolRuntimeActions"], json!([]));
    }

    #[test]
    fn rejects_malformed_runtime_state_write_fields() {
        for (payload, expected) in [
            (
                json!({ "usage": "invalid" }),
                "Rust HubPipeline runtimeStateWrite usage must be an object or null",
            ),
            (
                json!({ "keepForSubmitToolOutputs": "invalid" }),
                "Rust HubPipeline runtimeStateWrite keepForSubmitToolOutputs must be boolean",
            ),
        ] {
            let error = normalize_provider_response_effect_plan(&json!({
                "effects": [{
                    "kind": "runtimeStateWrite",
                    "payload": payload
                }]
            }))
            .unwrap_err();
            assert_eq!(error, expected);
        }
    }

    #[test]
    fn materializes_provider_response_outbound_effect_plan() {
        let output = materialize_provider_response_outbound_effect_plan(&json!({
            "success": true,
            "requestId": " req-materialize-1 ",
            "payload": {
                "id": "chatcmpl-materialize-1",
                "object": "chat.completion"
            },
            "diagnostics": [
                { "details": { "alarm": "missing_session" } }
            ],
            "effectPlan": {
                "effects": [
                    {
                        "kind": "streamPipe",
                        "payload": {
                            "codec": "openai-responses",
                            "requestId": " req-materialize-1 "
                        }
                    },
                    {
                        "kind": "runtimeStateWrite",
                        "payload": {
                            "requestId": "req-materialize-1",
                            "keepForSubmitToolOutputs": true
                        }
                    },
                    {
                        "kind": "stoplessMetadataCenterWrite",
                        "payload": {
                            "stopless": { "active": true }
                        }
                    }
                ]
            }
        }))
        .unwrap();

        assert_eq!(
            output["rawPayload"],
            json!({ "id": "chatcmpl-materialize-1", "object": "chat.completion" })
        );
        assert_eq!(
            output["diagnosticInput"]["requestId"],
            json!("req-materialize-1")
        );
        assert_eq!(
            output["diagnosticInput"]["diagnostics"][0]["details"]["alarm"],
            json!("missing_session")
        );
        assert_eq!(
            output["runtimeEffects"]["streamPipe"],
            json!({
                "codec": "openai-responses",
                "requestId": "req-materialize-1"
            })
        );
        assert_eq!(
            output["runtimeEffects"]["runtimeStateWrite"]["keepForSubmitToolOutputs"],
            json!(true)
        );
        assert_eq!(
            output["runtimeEffects"]["stoplessMetadataCenterWrite"]["stopless"]["active"],
            json!(true)
        );
        assert_eq!(
            output["runtimeEffects"]["servertoolRuntimeActions"],
            json!([])
        );
    }

    #[test]
    fn rejects_malformed_provider_response_outbound_effect_materialization_inputs() {
        for (input, expected) in [
            (
                json!(null),
                "Rust HubPipeline response outbound effect materializer missing native plan",
            ),
            (
                json!({ "requestId": "req", "diagnostics": [], "effectPlan": { "effects": [] } }),
                "Rust HubPipeline response outbound effect materializer missing payload",
            ),
            (
                json!({ "payload": {}, "requestId": " ", "diagnostics": [], "effectPlan": { "effects": [] } }),
                "Rust HubPipeline response outbound effect materializer missing requestId",
            ),
            (
                json!({ "payload": {}, "requestId": "req", "diagnostics": null, "effectPlan": { "effects": [] } }),
                "Rust HubPipeline response outbound effect materializer missing diagnostics",
            ),
            (
                json!({ "payload": {}, "requestId": "req", "diagnostics": [], "effectPlan": { "effects": null } }),
                "Rust HubPipeline response native effect plan unavailable",
            ),
        ] {
            let error = materialize_provider_response_outbound_effect_plan(&input).unwrap_err();
            assert_eq!(error, expected);
        }
    }

    #[test]
    fn provider_response_stage_recorder_effect_projects_body_and_stream_records() {
        let body_plan = plan_provider_response_stage_recorder_effect(&json!({
            "clientSemantic": {"id": "resp-body"},
            "streamPipe": null
        }))
        .expect("body stage recorder plan");
        assert_eq!(
            body_plan,
            json!({
                "records": [
                    {
                        "stage": "chat_process.resp.stage9.client_remap",
                        "payload": {"id": "resp-body"}
                    },
                    {
                        "stage": "chat_process.resp.stage10.sse_stream",
                        "payload": {
                            "passthrough": false,
                            "protocol": "native-effect-plan",
                            "payload": {"id": "resp-body"}
                        }
                    }
                ]
            })
        );

        let stream_plan = plan_provider_response_stage_recorder_effect(&json!({
            "clientSemantic": {"id": "resp-stream"},
            "streamPipe": {
                "codec": "openai-responses",
                "requestId": "req-stage",
                "payload": {"id": "resp-stream"}
            }
        }))
        .expect("stream stage recorder plan");
        assert_eq!(
            stream_plan["records"][1]["payload"]["protocol"],
            json!("openai-responses")
        );
    }

    #[test]
    fn provider_response_stage_recorder_effect_rejects_malformed_input() {
        for input in [
            json!(null),
            json!({"clientSemantic": "bad", "streamPipe": null}),
            json!({"clientSemantic": {}, "streamPipe": []}),
            json!({"clientSemantic": {}, "streamPipe": {"codec": ""}}),
        ] {
            let error = plan_provider_response_stage_recorder_effect(&input).unwrap_err();
            assert!(error.contains("stage recorder"));
        }
    }

    #[test]
    fn plans_provider_response_diagnostic_alarm_emit_and_no_op_paths() {
        let emit = plan_provider_response_diagnostic_alarm_effect(&json!({
            "requestId": " req-alarm ",
            "diagnostics": [
                { "details": { "alarm": " stopless_missing_session_id ", "reason": "missing session" } },
                { "details": { "alarm": " " } },
                { "details": null }
            ]
        }))
        .unwrap();
        assert_eq!(emit["action"], json!("emit"));
        assert_eq!(
            emit["messages"],
            json!(["[hub-pipeline][alarm] stopless_missing_session_id requestId=req-alarm details={\"alarm\":\" stopless_missing_session_id \",\"reason\":\"missing session\"}"])
        );

        let no_op = plan_provider_response_diagnostic_alarm_effect(&json!({
            "requestId": "req-no-alarm",
            "diagnostics": [{ "details": { "status": "ok" } }]
        }))
        .unwrap();
        assert_eq!(no_op, json!({ "action": "no_op" }));

        let malformed = plan_provider_response_diagnostic_alarm_effect(&json!({
            "requestId": "req-malformed",
            "diagnostics": null
        }))
        .unwrap_err();
        assert!(malformed.contains("missing diagnostics"));
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
    fn plans_provider_response_servertool_retirement_continue_and_reject_paths() {
        let continue_plan = plan_provider_response_servertool_retirement_effect(&json!({
            "servertoolRuntimeActions": []
        }))
        .unwrap();
        assert_eq!(continue_plan, json!({ "action": "continue" }));

        let reject_plan = plan_provider_response_servertool_retirement_effect(&json!({
            "servertoolRuntimeActions": [{
                "action": "requireResponseHookRuntime",
                "stopGateway": { "observed": true, "eligible": true }
            }]
        }))
        .unwrap();
        assert_eq!(reject_plan["action"], json!("reject_legacy_actions"));
        assert_eq!(
            reject_plan["stopGatewayWrite"]["stopGatewayContext"],
            json!({ "observed": true, "eligible": true })
        );
        assert_eq!(
            reject_plan["stopGatewayWrite"]["reason"],
            json!("rust stop gateway control signal")
        );

        let malformed = plan_provider_response_servertool_retirement_effect(&json!({
            "servertoolRuntimeActions": null
        }))
        .unwrap_err();
        assert!(malformed.contains("malformed servertool runtime actions"));
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
    fn plans_provider_response_stopless_runtime_control_effects() {
        for absent in [Value::Null, json!(false), json!(0), json!("")] {
            let output = plan_provider_response_stopless_runtime_control_effect(&json!({
                "stoplessMetadataCenterWrite": absent
            }))
            .unwrap();
            assert_eq!(output, json!({ "action": "no_op" }));
        }

        let empty = plan_provider_response_stopless_runtime_control_effect(&json!({
            "stoplessMetadataCenterWrite": { "stopless": null, "stopMessageCompareContext": null, "learnedNote": {} }
        }))
        .unwrap();
        assert_eq!(empty, json!({ "action": "no_op" }));

        let apply = plan_provider_response_stopless_runtime_control_effect(&json!({
            "stoplessMetadataCenterWrite": {
                "stopless": { "active": true },
                "stopMessageCompareContext": { "decision": "trigger" },
                "learnedNote": { "ignored": true }
            }
        }))
        .unwrap();
        assert_eq!(apply["action"], json!("apply_runtime_control"));
        assert_eq!(
            apply["runtimeControl"],
            json!({
                "stopless": { "active": true },
                "stopMessageCompareContext": { "decision": "trigger" }
            })
        );
        assert_eq!(
            apply["reason"],
            json!("rust response chatprocess runtime control")
        );

        let malformed = plan_provider_response_stopless_runtime_control_effect(&json!({
            "stoplessMetadataCenterWrite": { "plan": {} }
        }))
        .unwrap_err();
        assert_eq!(malformed, "Rust provider response stopless runtime-control planner unknown write-plan field: plan");
    }

    #[test]
    fn plans_provider_response_stream_pipe_effects() {
        assert_eq!(
            plan_provider_response_stream_pipe_effect(&json!({ "streamPipe": null })).unwrap(),
            json!({ "action": "no_pipe" })
        );
        let output = plan_provider_response_stream_pipe_effect(&json!({
            "streamPipe": {
                "codec": " openai-responses ",
                "requestId": " req-stream-1 "
            }
        }))
        .unwrap();
        assert_eq!(
            output,
            json!({
                "action": "use_pipe",
                "pipe": {
                    "codec": "openai-responses",
                    "requestId": "req-stream-1"
                }
            })
        );
        for legacy in [
            json!({ "streamPipe": { "codec": "openai-chat", "requestId": "req-1", "payload": {} } }),
            json!({ "streamPipe": { "codec": "openai-chat", "requestId": "req-1", "body": {} } }),
        ] {
            assert_eq!(
                plan_provider_response_stream_pipe_effect(&legacy).unwrap_err(),
                "Rust HubPipeline streamPipe effect must not own client payload"
            );
        }
        for malformed in [
            json!({ "streamPipe": false }),
            json!({ "streamPipe": { "codec": "openai-chat" } }),
            json!({ "streamPipe": { "codec": "", "requestId": "req-1" } }),
        ] {
            assert_eq!(
                plan_provider_response_stream_pipe_effect(&malformed).unwrap_err(),
                "Rust HubPipeline response path returned malformed stream pipe effect"
            );
        }
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
