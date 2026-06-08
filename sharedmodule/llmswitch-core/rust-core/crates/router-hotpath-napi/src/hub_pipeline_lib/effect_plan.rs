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

fn read_effect_payload<'a>(effect: &'a Map<String, Value>, kind: &str) -> Result<&'a Value, String> {
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
    let codec = record
        .get("codec")
        .and_then(Value::as_str)
        .ok_or_else(|| "Rust HubPipeline streamPipe effect returned unsupported codec".to_string())?;
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
        let kind = effect_record.get("kind").and_then(Value::as_str).ok_or_else(|| {
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
                servertool_runtime_actions
                    .push(read_effect_payload(effect_record, "servertoolRuntimeAction")?.clone());
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
    let output = normalize_provider_response_effect_plan(&value)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output)
        .map_err(|error| napi::Error::from_reason(format!("serialize effect plan failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::normalize_provider_response_effect_plan;
    use serde_json::json;

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
                    "payload": { "action": "requireRuntimeExecutor", "requestId": "req-1" }
                }
            ]
        }))
        .unwrap();
        assert_eq!(output["streamPipe"], json!({ "codec": "openai-chat", "requestId": "req-1" }));
        assert_eq!(output["runtimeStateWrite"]["requestId"], json!("req-1"));
        assert_eq!(output["servertoolRuntimeActions"][0]["action"], json!("requireRuntimeExecutor"));
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
}
