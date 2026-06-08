use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

use crate::hub_resp_outbound_client_semantics_blocks::anthropic_chat_response::{
    build_openai_chat_from_anthropic_message_full, BuildOpenAiChatFromAnthropicMessageFullInput,
};
use crate::hub_resp_outbound_client_semantics_blocks::anthropic_response::build_anthropic_response_from_chat_value;
use crate::hub_resp_outbound_client_semantics_blocks::chat_reasoning::{
    normalize_openai_chat_reasoning_outbound, sanitize_chat_completion_like,
};
use crate::hub_resp_outbound_client_semantics_blocks::client_tool_args::normalize_responses_tool_call_arguments_for_client;
use crate::hub_resp_outbound_client_semantics_blocks::context_helpers::{
    resolve_client_facing_request_id_from_context, resolve_client_protocol_for_response_entry,
    resolve_display_model_from_context, resolve_tool_surface_shadow_enabled, resolve_truthy_flag,
};
use crate::hub_resp_outbound_client_semantics_blocks::provider_outcome::{
    infer_provider_type_from_protocol, resolve_anthropic_chat_completion_outcome,
    resolve_anthropic_stop_reason, summarize_tool_calls_from_provider_response,
};
use crate::hub_resp_outbound_client_semantics_blocks::responses_payload::{
    build_responses_payload_from_chat_core, normalize_responses_function_name,
};
use crate::hub_resp_outbound_client_semantics_blocks::responses_usage::normalize_responses_usage;
use crate::hub_resp_outbound_client_semantics_blocks::tool_semantics::{
    normalize_alias_map, resolve_alias_map_from_resp_semantics, resolve_alias_map_from_sources,
    resolve_client_tools_raw, resolve_client_tools_raw_from_resp_semantics,
};
use crate::hub_resp_outbound_sse_stream::resolve_sse_stream_mode;

#[napi]
pub fn normalize_alias_map_json(candidate_json: String) -> NapiResult<String> {
    let candidate: Value = serde_json::from_str(&candidate_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_alias_map(&candidate);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_client_tools_raw_json(candidate_json: String) -> NapiResult<String> {
    let candidate: Value = serde_json::from_str(&candidate_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_client_tools_raw(&candidate);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_alias_map_from_resp_semantics_json(semantics_json: String) -> NapiResult<String> {
    let semantics: Value = serde_json::from_str(&semantics_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_alias_map_from_resp_semantics(&semantics);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_alias_map_from_sources_json(
    adapter_context_json: String,
    chat_envelope_json: String,
) -> NapiResult<String> {
    let adapter_context: Value = serde_json::from_str(&adapter_context_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let chat_envelope: Value = serde_json::from_str(&chat_envelope_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_alias_map_from_sources(&adapter_context, &chat_envelope);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_client_tools_raw_from_resp_semantics_json(
    semantics_json: String,
) -> NapiResult<String> {
    let semantics: Value = serde_json::from_str(&semantics_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_client_tools_raw_from_resp_semantics(&semantics);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn sanitize_responses_function_name_json(raw_name_json: String) -> NapiResult<String> {
    let raw_name: Value = serde_json::from_str(&raw_name_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_responses_function_name(raw_name.as_str());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn sanitize_chat_completion_like_json(candidate_json: String) -> NapiResult<String> {
    let candidate: Value = serde_json::from_str(&candidate_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = sanitize_chat_completion_like(&candidate);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "normalizeOpenaiChatReasoningOutboundJson")]
pub fn normalize_openai_chat_reasoning_outbound_json(candidate_json: String) -> NapiResult<String> {
    let candidate: Value = serde_json::from_str(&candidate_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_openai_chat_reasoning_outbound(&candidate);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_anthropic_stop_reason_json(stop_reason_json: String) -> NapiResult<String> {
    let stop_reason: Value = serde_json::from_str(&stop_reason_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_anthropic_stop_reason(stop_reason.as_str());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_anthropic_chat_completion_outcome_json(
    stop_reason_json: String,
    tool_call_count: u32,
    has_visible_assistant_output: bool,
) -> NapiResult<String> {
    let stop_reason: Value = serde_json::from_str(&stop_reason_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_anthropic_chat_completion_outcome(
        stop_reason.as_str(),
        tool_call_count as usize,
        has_visible_assistant_output,
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn summarize_tool_calls_from_provider_response_json(
    payload_json: String,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = summarize_tool_calls_from_provider_response(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_provider_type_from_protocol_json(protocol_json: String) -> NapiResult<String> {
    let protocol: Value = serde_json::from_str(&protocol_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = infer_provider_type_from_protocol(protocol.as_str());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_provider_response_context_helpers_json(
    context_json: String,
    server_tool_followup_raw_json: String,
    entry_endpoint_json: String,
    tool_surface_mode_raw_json: String,
) -> NapiResult<String> {
    let context: Value =
        serde_json::from_str(&context_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let server_tool_followup_raw: Value = serde_json::from_str(&server_tool_followup_raw_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let entry_endpoint_raw: Value = serde_json::from_str(&entry_endpoint_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tool_surface_mode_raw: Value = serde_json::from_str(&tool_surface_mode_raw_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let is_server_tool_followup = resolve_truthy_flag(&server_tool_followup_raw);

    let mut output = Map::new();
    output.insert(
        "isServerToolFollowup".to_string(),
        Value::Bool(is_server_tool_followup),
    );
    output.insert(
        "clientProtocol".to_string(),
        Value::String(resolve_client_protocol_for_response_entry(
            entry_endpoint_raw.as_str(),
            is_server_tool_followup,
        )),
    );
    output.insert(
        "toolSurfaceShadowEnabled".to_string(),
        Value::Bool(resolve_tool_surface_shadow_enabled(&tool_surface_mode_raw)),
    );
    if let Some(display_model) = resolve_display_model_from_context(&context) {
        output.insert("displayModel".to_string(), Value::String(display_model));
    }
    if let Some(client_facing_request_id) = resolve_client_facing_request_id_from_context(&context)
    {
        output.insert(
            "clientFacingRequestId".to_string(),
            Value::String(client_facing_request_id),
        );
    }

    serde_json::to_string(&Value::Object(output))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_anthropic_response_from_chat_json(
    chat_response_json: String,
    alias_map_json: String,
) -> NapiResult<String> {
    let chat_response: Value = serde_json::from_str(&chat_response_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let alias_map: Value = serde_json::from_str(&alias_map_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_anthropic_response_from_chat_value(&chat_response, Some(&alias_map));
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "buildOpenaiChatFromAnthropicJson")]
pub fn build_openai_chat_from_anthropic_json_bridge(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    crate::anthropic_openai_codec::build_openai_chat_from_anthropic_json(payload_json, options_json)
}

#[napi(js_name = "buildOpenaiChatResponseFromAnthropicMessageJson")]
pub fn build_openai_chat_response_from_anthropic_message_json(
    payload_json: String,
    request_id: Option<String>,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let resolved_request_id = request_id.unwrap_or_else(|| "unknown".to_string());
    let output = crate::hub_resp_outbound_client_semantics_blocks::anthropic_chat_response::build_openai_chat_response_from_anthropic_message(
        &payload,
        resolved_request_id.as_str(),
    )
    .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "buildOpenaiChatFromAnthropicMessageFullJson")]
pub fn build_openai_chat_from_anthropic_message_full_json(
    input_json: String,
) -> NapiResult<String> {
    let input: BuildOpenAiChatFromAnthropicMessageFullInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output =
        build_openai_chat_from_anthropic_message_full(input).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "buildAnthropicFromOpenaiChatJson")]
pub fn build_anthropic_from_openai_chat_json_bridge(
    chat_response_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    crate::anthropic_openai_codec::build_anthropic_from_openai_chat_json(
        chat_response_json,
        options_json,
    )
}

#[napi]
pub fn normalize_responses_tool_call_arguments_for_client_json(
    responses_payload_json: String,
    tools_raw_json: String,
) -> NapiResult<String> {
    let responses_payload: Value = serde_json::from_str(&responses_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tools_raw: Value = serde_json::from_str(&tools_raw_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_responses_tool_call_arguments_for_client(&responses_payload, &tools_raw);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn normalize_responses_usage_json(usage_json: String) -> NapiResult<String> {
    let usage: Value =
        serde_json::from_str(&usage_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_responses_usage(&usage);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_responses_payload_from_chat_json(
    payload_json: String,
    context_json: String,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let context: Value =
        serde_json::from_str(&context_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let request_id_hint = context
        .as_object()
        .and_then(|v| v.get("requestId"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let output =
        build_responses_payload_from_chat_core(&payload, request_id_hint.as_deref(), &context)
            .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_sse_stream_mode_json(
    wants_stream: bool,
    client_protocol: String,
) -> NapiResult<String> {
    let output = resolve_sse_stream_mode(wants_stream, client_protocol.as_str());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_anthropic_response_from_chat_full_json(input_json: String) -> NapiResult<String> {
    let input: crate::hub_resp_outbound_client_semantics_blocks::anthropic_full_response::BuildAnthropicFullInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = crate::hub_resp_outbound_client_semantics_blocks::anthropic_full_response::build_anthropic_response_from_chat_full(input)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
