use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize)]
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReqOutboundCompatInput {
    pub payload: Value,
    pub adapter_context: AdapterContext,
    #[serde(default)]
    pub explicit_profile: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatResult {
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_profile: Option<String>,
    pub native_applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limit_detected: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityPinnedAliasLookupInput {
    pub session_id: String,
    #[serde(default)]
    pub hydrate: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityPinnedAliasLookupOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityPinnedAliasUnpinInput {
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityPinnedAliasUnpinOutput {
    pub changed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityCacheSignatureInput {
    pub alias_key: String,
    pub session_id: String,
    pub signature: String,
    #[serde(default)]
    pub message_count: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityCacheSignatureOutput {
    pub ok: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityRequestSessionMetaInput {
    pub request_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityRequestSessionMetaOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<i64>,
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
pub(crate) mod gemini_cli;
mod glm;
mod iflow;
mod lmstudio;
mod profile;
mod qwen;
mod qwenchat;
mod request_stage;
mod response_stage;
mod responses;
mod shared_tool_text_guidance;
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
pub fn extract_antigravity_gemini_session_id_json(payload_json: String) -> napi::Result<String> {
    if payload_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Payload JSON is empty"));
    }

    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload JSON: {}", e)))?;
    let output = gemini_cli::extract_antigravity_gemini_session_id(&payload);

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

#[napi_derive::napi]
pub fn lookup_antigravity_pinned_alias_for_session_id_json(
    input_json: String,
) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: AntigravityPinnedAliasLookupInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let alias = gemini_cli::lookup_antigravity_pinned_alias_for_session_id(
        &input.session_id,
        input.hydrate.unwrap_or(true),
    );
    let output = AntigravityPinnedAliasLookupOutput { alias };

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi]
pub fn unpin_antigravity_session_alias_for_session_id_json(
    input_json: String,
) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: AntigravityPinnedAliasUnpinInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let changed = gemini_cli::unpin_antigravity_session_alias_for_session_id(&input.session_id);
    let output = AntigravityPinnedAliasUnpinOutput { changed };

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi]
pub fn cache_antigravity_session_signature_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: AntigravityCacheSignatureInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    gemini_cli::cache_antigravity_session_signature_for_bridge(
        &input.alias_key,
        &input.session_id,
        &input.signature,
        input.message_count.unwrap_or(1),
    );
    let output = AntigravityCacheSignatureOutput { ok: true };
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi]
pub fn get_antigravity_request_session_meta_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: AntigravityRequestSessionMetaInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = if let Some((alias_key, session_id, message_count)) =
        gemini_cli::get_antigravity_request_session_meta_for_bridge(&input.request_id)
    {
        AntigravityRequestSessionMetaOutput {
            alias_key: Some(alias_key),
            session_id: Some(session_id),
            message_count: Some(message_count),
        }
    } else {
        AntigravityRequestSessionMetaOutput {
            alias_key: None,
            session_id: None,
            message_count: None,
        }
    };

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi]
pub fn reset_antigravity_signature_caches_json() -> napi::Result<String> {
    gemini_cli::reset_antigravity_signature_caches_for_bridge();
    let output = AntigravityCacheSignatureOutput { ok: true };
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi]
pub fn prepare_antigravity_signature_for_gemini_request_json(
    payload_json: String,
    adapter_context_json: Option<String>,
) -> napi::Result<String> {
    if payload_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Payload JSON is empty"));
    }

    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload JSON: {}", e)))?;
    let adapter_context: AdapterContext = match adapter_context_json {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw).map_err(|e| {
            napi::Error::from_reason(format!("Failed to parse adapter context JSON: {}", e))
        })?,
        _ => AdapterContext {
            compatibility_profile: None,
            provider_protocol: None,
            request_id: None,
            entry_endpoint: None,
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
    };

    let output =
        gemini_cli::prepare_antigravity_signature_for_gemini_request(payload, &adapter_context);

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi]
pub fn apply_iflow_tool_text_fallback_json(
    payload_json: String,
    adapter_context_json: Option<String>,
    models_json: Option<String>,
) -> napi::Result<String> {
    iflow::apply_iflow_tool_text_fallback_json(payload_json, adapter_context_json, models_json)
}

#[napi_derive::napi]
pub fn apply_lmstudio_responses_input_stringify_json(
    payload_json: String,
    adapter_context_json: Option<String>,
) -> napi::Result<String> {
    lmstudio::apply_lmstudio_responses_input_stringify_json(payload_json, adapter_context_json)
}

#[cfg(test)]
mod tests;
