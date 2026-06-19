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
    pub claude_code: Option<Value>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limit_detected: Option<bool>,
}

#[cfg(test)]
const DEFAULT_SYSTEM_TEXT: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

#[cfg(test)]
fn is_claude_code_user_id(value: Option<&str>) -> bool {
    let Some(raw) = value else {
        return false;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    regex::Regex::new(r"^user_[0-9a-f]{64}_account__session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .map(|re| re.is_match(&trimmed.to_ascii_lowercase()))
        .unwrap_or(false)
}

pub(crate) mod claude_code;
mod deepseek_web;
pub(crate) mod gemini;
mod glm;
mod lmstudio;
mod profile;
mod qwen;
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
