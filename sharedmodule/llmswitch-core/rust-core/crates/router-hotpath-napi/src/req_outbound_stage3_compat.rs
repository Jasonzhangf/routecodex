use serde::{Deserialize, Serialize};
use serde_json::Value;

// feature_id: responses.request_compat_normalization

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterContext {
    #[serde(default)]
    pub compatibility_profile: Option<String>,
    #[serde(default)]
    pub provider_protocol: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub entry_endpoint: Option<String>,
    #[serde(default)]
    pub route_id: Option<String>,
    #[serde(default, rename = "__rt")]
    pub rt: Option<Value>,
    #[serde(default)]
    pub captured_chat_request: Option<Value>,
    #[serde(default)]
    pub deepseek: Option<Value>,
    #[serde(default)]
    pub anthropic_thinking: Option<String>,
    #[serde(default)]
    pub estimated_input_tokens: Option<f64>,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub client_model_id: Option<String>,
    #[serde(default)]
    pub original_model_id: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub provider_key: Option<String>,
    #[serde(default)]
    pub runtime_key: Option<String>,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub group_request_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReqOutboundCompatInput {
    pub payload: Value,
    pub adapter_context: AdapterContext,
    #[serde(default)]
    pub explicit_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatResult {
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_profile: Option<String>,
    pub native_applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeReqOutboundCompatAdapterContextBuilderInput {
    #[serde(default)]
    metadata_center_snapshot: Option<Value>,
}

pub(crate) mod gemini;
mod glm;
mod lmstudio;
mod profile;
mod request_stage;
mod response_stage;
pub(crate) mod responses;
mod shared_tool_text_guidance;
mod single_tool_call_history;
mod thinking_history;
mod tool_text_request_guidance;
pub(crate) mod universal_shape_filter;

pub use request_stage::run_req_outbound_stage3_compat;
pub use response_stage::run_resp_inbound_stage3_compat;

#[napi_derive::napi]
pub fn run_req_outbound_stage3_compat_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: ReqOutboundCompatInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = run_req_outbound_stage3_compat(input).map_err(napi::Error::from_reason)?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi]
pub fn run_resp_inbound_stage3_compat_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: ReqOutboundCompatInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = run_resp_inbound_stage3_compat(input).map_err(napi::Error::from_reason)?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

fn read_trimmed_string(source: Option<&Value>, key: &str) -> Option<String> {
    source
        .and_then(|value| value.as_object())
        .and_then(|row| row.get(key))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn read_object<'a>(source: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    source
        .and_then(|value| value.as_object())
        .and_then(|row| row.get(key))
        .filter(|value| value.is_object())
}

fn build_native_req_outbound_compat_adapter_context(
    metadata_center_snapshot: Option<&Value>,
) -> Result<AdapterContext, String> {
    let runtime_control = read_object(metadata_center_snapshot, "runtimeControl");
    let request_truth = read_object(metadata_center_snapshot, "requestTruth");
    let provider_observation = read_object(metadata_center_snapshot, "providerObservation");
    let target = read_object(provider_observation, "target");

    let provider_protocol = read_trimmed_string(runtime_control, "providerProtocol").ok_or_else(|| {
        "Native req outbound compat adapter context requires metadata center runtime_control.providerProtocol"
            .to_string()
    })?;

    Ok(AdapterContext {
        compatibility_profile: read_trimmed_string(provider_observation, "compatibilityProfile"),
        provider_protocol: Some(provider_protocol),
        request_id: read_trimmed_string(request_truth, "requestId"),
        entry_endpoint: read_trimmed_string(request_truth, "entryEndpoint"),
        route_id: read_trimmed_string(runtime_control, "routeId"),
        rt: None,
        captured_chat_request: None,
        deepseek: None,
        anthropic_thinking: None,
        estimated_input_tokens: None,
        model_id: read_trimmed_string(provider_observation, "assignedModelId")
            .or_else(|| read_trimmed_string(provider_observation, "modelId")),
        client_model_id: read_trimmed_string(provider_observation, "clientModelId"),
        original_model_id: None,
        provider_id: read_trimmed_string(target, "providerId")
            .or_else(|| read_trimmed_string(target, "id")),
        provider_key: read_trimmed_string(provider_observation, "providerKey"),
        runtime_key: None,
        client_request_id: read_trimmed_string(request_truth, "clientRequestId"),
        group_request_id: None,
        session_id: read_trimmed_string(request_truth, "sessionId"),
        conversation_id: read_trimmed_string(request_truth, "conversationId"),
    })
}

fn serialize_adapter_context_without_nulls(output: &AdapterContext) -> napi::Result<String> {
    let mut value = serde_json::to_value(output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize adapter context: {}", e))
    })?;
    if let Some(row) = value.as_object_mut() {
        row.retain(|_, value| !value.is_null());
    }
    serde_json::to_string(&value)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi(js_name = "buildNativeReqOutboundCompatAdapterContextJson")]
pub fn build_native_req_outbound_compat_adapter_context_json(
    input_json: String,
) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: NativeReqOutboundCompatAdapterContextBuilderInput =
        serde_json::from_str(&input_json)
            .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = build_native_req_outbound_compat_adapter_context(
        input.metadata_center_snapshot.as_ref(),
    )
    .map_err(napi::Error::from_reason)?;

    serialize_adapter_context_without_nulls(&output)
}

#[napi_derive::napi]
pub fn apply_claude_thinking_tool_schema_compat_json(payload_json: String) -> napi::Result<String> {
    if payload_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Payload JSON is empty"));
    }

    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload JSON: {}", e)))?;
    let output = gemini::apply_claude_thinking_tool_schema_compat(payload);

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi]
pub fn apply_tool_text_request_guidance_json(
    payload_json: String,
    config_json: Option<String>,
) -> napi::Result<String> {
    tool_text_request_guidance::apply_tool_text_request_guidance_json(payload_json, config_json)
}

#[cfg(test)]
mod tests;
