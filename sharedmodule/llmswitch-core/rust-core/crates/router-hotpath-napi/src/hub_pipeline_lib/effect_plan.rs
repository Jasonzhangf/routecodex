use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

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
    ServertoolRuntimeAction,
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
    Ok(json!({
        "codec": codec,
        "requestId": request_id,
    }))
}

fn normalize_stop_gateway_payload(payload: &Value) -> Result<Value, String> {
    let record = payload.as_object().ok_or_else(|| {
        "Rust HubPipeline servertoolRuntimeAction stopGateway missing context".to_string()
    })?;
    let observed = record
        .get("observed")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            "Rust HubPipeline servertoolRuntimeAction stopGateway missing observed".to_string()
        })?;
    let eligible = record
        .get("eligible")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            "Rust HubPipeline servertoolRuntimeAction stopGateway missing eligible".to_string()
        })?;
    let source = record
        .get("source")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown");
    let reason = record
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown");
    let mut output = Map::new();
    output.insert("observed".to_string(), Value::Bool(observed));
    output.insert("eligible".to_string(), Value::Bool(eligible));
    output.insert("source".to_string(), Value::String(source.to_string()));
    output.insert("reason".to_string(), Value::String(reason.to_string()));
    if let Some(choice_index) = record
        .get("choiceIndex")
        .or_else(|| record.get("choice_index"))
    {
        if choice_index.is_i64() || choice_index.is_u64() {
            output.insert("choiceIndex".to_string(), choice_index.clone());
        }
    }
    if let Some(has_tool_calls) = record
        .get("hasToolCalls")
        .or_else(|| record.get("has_tool_calls"))
    {
        if has_tool_calls.is_boolean() {
            output.insert("hasToolCalls".to_string(), has_tool_calls.clone());
        }
    }
    Ok(Value::Object(output))
}

fn normalize_servertool_runtime_action_payload(payload: &Value) -> Result<Value, String> {
    let record = payload.as_object().ok_or_else(|| {
        "Rust HubPipeline servertoolRuntimeAction effect missing payload".to_string()
    })?;
    let mut output = record.clone();
    if let Some(raw_stop_gateway) = record.get("stopGateway") {
        output.insert(
            "stopGateway".to_string(),
            normalize_stop_gateway_payload(raw_stop_gateway)?,
        );
    }
    Ok(Value::Object(output))
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
    let mut servertool_runtime_actions: Vec<Value> = Vec::new();

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
            "servertoolRuntimeAction" => {
                servertool_runtime_actions.push(normalize_servertool_runtime_action_payload(
                    read_effect_payload(effect_record, "servertoolRuntimeAction")?,
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
        "servertoolRuntimeActions": servertool_runtime_actions,
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

fn read_bool(record: &Map<String, Value>, key: &str) -> bool {
    record.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn read_optional_trimmed_string(record: &Map<String, Value>, key: &str) -> Option<String> {
    record
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn build_servertool_runtime_error(
    message: &str,
    code: &str,
    request_id: Option<String>,
    reason: Option<String>,
) -> Value {
    let mut details = Map::new();
    if let Some(request_id) = request_id {
        details.insert("requestId".to_string(), Value::String(request_id));
    }
    if let Some(reason) = reason {
        details.insert("reason".to_string(), Value::String(reason));
    }
    json!({
        "message": message,
        "code": code,
        "category": "INTERNAL_ERROR",
        "details": Value::Object(details),
    })
}

pub fn plan_provider_response_servertool_runtime_actions(input: &Value) -> Result<Value, String> {
    let record = input.as_object().ok_or_else(|| {
        "Rust HubPipeline servertoolRuntimeAction planner missing input".to_string()
    })?;
    let actions = record
        .get("servertoolRuntimeActions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "Rust HubPipeline servertoolRuntimeAction planner missing actions".to_string()
        })?;
    let has_provider_invoker = read_bool(record, "providerInvoker");
    let has_reenter_pipeline = read_bool(record, "reenterPipeline");
    let has_client_inject_dispatch = read_bool(record, "clientInjectDispatch");
    let has_any_runtime_executor =
        has_provider_invoker || has_reenter_pipeline || has_client_inject_dispatch;
    let mut execution_plans: Vec<Value> = Vec::new();

    for action in actions {
        let action_record = action.as_object().ok_or_else(|| {
            "Rust HubPipeline servertoolRuntimeAction returned unsupported action".to_string()
        })?;
        let request_id = read_optional_trimmed_string(action_record, "requestId");
        let reason = read_optional_trimmed_string(action_record, "reason")
            .or_else(|| Some("unknown".to_string()));
        let payload = action_record
            .get("payload")
            .filter(|value| value.is_object())
            .ok_or_else(|| {
                "Rust HubPipeline servertoolRuntimeAction missing chat-process payload".to_string()
            })?;
        match action_record.get("action").and_then(Value::as_str) {
            Some("requireReenterPipeline") => {
                if !has_reenter_pipeline {
                    return Ok(json!({
                        "executionPlans": [],
                        "error": build_servertool_runtime_error(
                            "[servertool] followup requires reenter pipeline",
                            "SERVERTOOL_FOLLOWUP_FAILED",
                            request_id,
                            reason,
                        )
                    }));
                }
                execution_plans.push(json!({
                    "payload": payload,
                    "projectionStage": "HubRespChatProcess03Governed",
                    "allowFollowup": true,
                    "stopGateway": action_record.get("stopGateway").cloned().unwrap_or(Value::Null),
                }));
            }
            Some("requireRuntimeExecutor") => {
                if !has_any_runtime_executor {
                    return Ok(json!({
                        "executionPlans": [],
                        "error": build_servertool_runtime_error(
                            "Rust HubPipeline servertoolRuntimeAction requires runtime executor",
                            "SERVERTOOL_HANDLER_FAILED",
                            request_id,
                            reason,
                        )
                    }));
                }
                execution_plans.push(json!({
                    "payload": payload,
                    "projectionStage": "HubRespChatProcess03Governed",
                    "allowFollowup": false,
                    "stopGateway": action_record.get("stopGateway").cloned().unwrap_or(Value::Null),
                }));
            }
            _ => {
                return Err(
                    "Rust HubPipeline servertoolRuntimeAction returned unsupported action"
                        .to_string(),
                );
            }
        }
    }

    Ok(json!({
        "executionPlans": execution_plans,
        "error": Value::Null,
    }))
}

pub fn plan_provider_response_servertool_runtime_actions_json(
    input_json: String,
) -> napi::Result<String> {
    let value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "invalid servertoolRuntimeAction planner JSON: {error}"
        ))
    })?;
    let output = plan_provider_response_servertool_runtime_actions(&value)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!(
            "serialize servertoolRuntimeAction planner failed: {error}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_provider_response_effect_plan, plan_provider_response_servertool_runtime_actions,
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
                },
                {
                    "kind": "servertoolRuntimeAction",
                    "payload": {
                        "action": "requireRuntimeExecutor",
                        "requestId": "req-1",
                        "stopGateway": {
                            "observed": true,
                            "eligible": true,
                            "source": " responses ",
                            "reason": " status_completed ",
                            "choice_index": 2,
                            "has_tool_calls": false
                        }
                    }
                }
            ]
        }))
        .unwrap();
        assert_eq!(
            output["streamPipe"],
            json!({ "codec": "openai-chat", "requestId": "req-1" })
        );
        assert_eq!(output["runtimeStateWrite"]["requestId"], json!("req-1"));
        assert_eq!(
            output["servertoolRuntimeActions"][0]["action"],
            json!("requireRuntimeExecutor")
        );
        assert_eq!(
            output["servertoolRuntimeActions"][0]["stopGateway"],
            json!({
                "observed": true,
                "eligible": true,
                "source": "responses",
                "reason": "status_completed",
                "choiceIndex": 2,
                "hasToolCalls": false
            })
        );
    }

    #[test]
    fn rejects_invalid_stop_gateway_context_in_servertool_runtime_action() {
        let error = normalize_provider_response_effect_plan(&json!({
            "effects": [{
                "kind": "servertoolRuntimeAction",
                "payload": {
                    "action": "requireRuntimeExecutor",
                    "requestId": "req-1",
                    "stopGateway": { "eligible": true }
                }
            }]
        }))
        .unwrap_err();
        assert!(error.contains("stopGateway missing observed"));
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
    fn plans_servertool_runtime_action_execution_in_rust() {
        let output = plan_provider_response_servertool_runtime_actions(&json!({
            "servertoolRuntimeActions": [{
                "action": "requireRuntimeExecutor",
                "requestId": "req-1",
                "reason": "tool_call_dispatch",
                "stopGateway": {
                    "observed": true,
                    "eligible": true,
                    "source": "responses",
                    "reason": "status_completed"
                },
                "payload": { "choices": [] }
            }],
            "providerInvoker": true,
            "reenterPipeline": false,
            "clientInjectDispatch": false
        }))
        .unwrap();
        assert_eq!(output["error"], Value::Null);
        assert_eq!(
            output["executionPlans"][0]["projectionStage"],
            json!("HubRespChatProcess03Governed")
        );
        assert_eq!(output["executionPlans"][0]["allowFollowup"], json!(false));
        assert_eq!(
            output["executionPlans"][0]["stopGateway"],
            json!({
                "observed": true,
                "eligible": true,
                "source": "responses",
                "reason": "status_completed"
            })
        );
    }

    #[test]
    fn plans_missing_reenter_pipeline_as_explicit_error() {
        let output = plan_provider_response_servertool_runtime_actions(&json!({
            "servertoolRuntimeActions": [{
                "action": "requireReenterPipeline",
                "requestId": "req-1",
                "reason": "web_search_followup",
                "payload": { "choices": [] }
            }],
            "providerInvoker": true,
            "reenterPipeline": false,
            "clientInjectDispatch": false
        }))
        .unwrap();
        assert_eq!(output["executionPlans"], json!([]));
        assert_eq!(output["error"]["code"], json!("SERVERTOOL_FOLLOWUP_FAILED"));
        assert_eq!(output["error"]["details"]["requestId"], json!("req-1"));
        assert_eq!(
            output["error"]["details"]["reason"],
            json!("web_search_followup")
        );
    }

    #[test]
    fn plans_missing_runtime_executor_as_explicit_error() {
        let output = plan_provider_response_servertool_runtime_actions(&json!({
            "servertoolRuntimeActions": [{
                "action": "requireRuntimeExecutor",
                "requestId": "req-2",
                "payload": { "choices": [] }
            }],
            "providerInvoker": false,
            "reenterPipeline": false,
            "clientInjectDispatch": false
        }))
        .unwrap();
        assert_eq!(output["executionPlans"], json!([]));
        assert_eq!(output["error"]["code"], json!("SERVERTOOL_HANDLER_FAILED"));
        assert_eq!(output["error"]["details"]["reason"], json!("unknown"));
    }

    #[test]
    fn rejects_unsupported_servertool_runtime_action() {
        let error = plan_provider_response_servertool_runtime_actions(&json!({
            "servertoolRuntimeActions": [{
                "action": "runInTypescript",
                "payload": { "choices": [] }
            }],
            "providerInvoker": true
        }))
        .unwrap_err();
        assert!(error.contains("unsupported action"));
    }
}
