use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
mod chat_web_search_intent;
use chat_process_media_semantics::{
    analyze_chat_process_media, strip_chat_process_historical_images,
    strip_responses_stored_context_input_media,
};
use chat_web_search_intent::analyze_chat_web_search_intent;
mod anthropic_openai_codec;
mod anthropic_response_helper;
mod anthropic_sse_event_payload;
mod chat_governed_filter_payload;
mod chat_node_result_semantics;
mod chat_process_media_semantics;
mod chat_servertool_orchestration;
mod chat_sse_event_payload;
mod chat_web_search_tool_schema;
mod compat_field_mapping;
mod compat_harvest_tool_calls_from_text;
mod compat_tool_schema;
mod config_file_codec;
mod config_provider_codec;
mod config_toml_codec;
mod direct_decision;
mod failure_policy;
mod followup_mainline_blocks;
mod gemini_openai_codec;
mod gemini_sse_event_payload;
mod hashline;
mod hub_bridge_actions;
mod hub_bridge_policies;
mod hub_pipeline;
mod hub_pipeline_blocks;
mod hub_pipeline_contracts;
mod hub_pipeline_engine;
mod hub_pipeline_lib;
mod hub_pipeline_session_identifiers;
mod hub_pipeline_types;
mod hub_protocol_spec_semantics;
mod hub_reasoning_tool_normalizer;
mod hub_req_chatprocess_03_governance_boundary;
mod hub_req_inbound_context_capture;
mod hub_req_inbound_format_parse;
mod hub_req_inbound_semantic_lift;
mod hub_req_inbound_tool_call_normalization;
mod hub_req_inbound_tool_output_diagnostics;
mod hub_req_inbound_tool_output_snapshot;
mod hub_req_outbound_context_merge;
mod hub_req_outbound_format_build;
mod hub_resp_chatprocess_03_governance_boundary;
mod hub_resp_inbound_format_parse;
mod hub_resp_inbound_sse_decode_semantics;
mod hub_resp_inbound_sse_stream_sniffer;
mod hub_resp_outbound_04_client_payload_boundary;
mod hub_resp_outbound_04_finalize_boundary;
mod hub_resp_outbound_client_semantics;
mod hub_resp_outbound_client_semantics_blocks;
mod hub_resp_outbound_sse_stream;
mod hub_snapshot_hooks;
mod hub_standardized_bridge;
mod hub_submit_tool_outputs;
mod hub_text_markup_normalizer;
mod hub_tool_session_compat;
mod metadata_center;
mod openai_openai_codec;
mod primary_exhausted_to_default_pool_blocks;
mod provider_response_shared_pure_blocks;
mod provider_response_tool_validation_blocks;
mod req_executor_pipeline_attempt;
mod req_outbound_stage3_compat;
mod req_process_stage1_tool_governance;
mod req_process_stage1_tool_governance_blocks;
mod req_process_stage2_route_select;
mod resp_process_stage1_tool_governance;
mod resp_process_stage1_tool_governance_blocks;
mod resp_process_stage2_finalize;
mod responses_openai_codec;
mod responses_reasoning_registry;
mod responses_sse_event_payload;
mod server_contracts;
mod servertool_core_blocks;
mod servertool_followup_delta;
mod servertool_skeleton;
mod servertool_skeleton_config;
mod shared_args_mapping;
mod shared_bridge_instructions;
mod shared_chat_output_normalizer;
mod shared_chat_request_filters;
mod shared_compaction_detect;
mod shared_gemini_tool_utils;
mod shared_json_utils;
mod shared_mcp_injection;
mod shared_metadata_semantics;
mod shared_openai_message_normalize;
mod shared_output_content_normalizer;
mod shared_payload_budget;
mod shared_provider_errors;
mod shared_response_compat;
mod shared_responses_conversation_utils;
mod shared_responses_response_utils;
mod shared_responses_tool_utils;
mod shared_tool_call_id_core;
mod shared_tool_call_id_manager;
mod shared_tool_mapping;
mod shared_tooling;
mod snapshot_tool_failures;
mod sse_runtime_dispatch;
mod stop_message_auto_blocks;
mod stopless_auto_handler_bridge;
mod streaming_tool_extractor;
mod tool_harvester;
mod virtual_router_engine;
mod virtual_router_hit_log;
mod virtual_router_stop_message_actions;
mod virtual_router_stop_message_instruction;
mod vr_route_04_selection_boundary;
mod web_search_mode;
use crate::virtual_router_engine::routing::resolve_routing_state_key as resolve_virtual_router_routing_state_key;
use crate::virtual_router_engine::routing::resolve_stop_message_scope as resolve_virtual_router_stop_message_scope;
use crate::virtual_router_engine::routing::{
    resolve_error_err05_route_availability_decision, ErrorErr05RouteAvailabilityDecisionInput,
};
use crate::virtual_router_engine::{
    evaluate_singleton_route_pool_exhaustion, SingletonRoutePoolExhaustionDecision,
    SingletonRoutePoolExhaustionInput,
};
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingToolSyncOutput {
    ready: bool,
    insert_at: i64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContinueExecutionInjectionOutput {
    has_directive: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoutingInstructionParseOptions {
    #[serde(default)]
    rcc_user_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreCommandScriptAllowedInput {
    path: String,
    #[serde(default)]
    rcc_user_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyRoutingInstructionsInput {
    instructions: Vec<Value>,
    state: Value,
}

fn parse_routing_instruction_parse_options(
    options_json: Option<String>,
) -> NapiResult<RoutingInstructionParseOptions> {
    let raw = match options_json {
        Some(value) if !value.trim().is_empty() => value,
        _ => return Ok(RoutingInstructionParseOptions::default()),
    };
    serde_json::from_str(&raw).map_err(|e| napi::Error::from_reason(e.to_string()))
}
#[napi]
pub fn resolve_virtual_router_routing_state_key_json(metadata_json: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output =
        resolve_virtual_router_routing_state_key(metadata_center_snapshot_or_self(&metadata));
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn evaluate_singleton_route_pool_exhaustion_json(input_json: String) -> NapiResult<String> {
    let input: SingletonRoutePoolExhaustionInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output: SingletonRoutePoolExhaustionDecision =
        evaluate_singleton_route_pool_exhaustion(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_error_err05_route_availability_decision_json(
    input_json: String,
) -> NapiResult<String> {
    let input: ErrorErr05RouteAvailabilityDecisionInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_error_err05_route_availability_decision(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_chat_process_session_usage_json(input_json: String) -> NapiResult<String> {
    let output =
        virtual_router_engine::chat_process_session_usage::plan_chat_process_session_usage_json(
            input_json,
        )
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_virtual_router_stop_message_scope_json(metadata_json: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output =
        resolve_virtual_router_stop_message_scope(metadata_center_snapshot_or_self(&metadata));
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn metadata_center_snapshot_or_self(metadata: &Value) -> &Value {
    metadata.get("metadataCenterSnapshot").unwrap_or(metadata)
}

#[napi]
pub fn parse_route_codex_toml_record_json(raw: String) -> NapiResult<String> {
    config_toml_codec::parse_toml_record_json(&raw).map_err(napi::Error::from_reason)
}

#[napi]
pub fn serialize_route_codex_toml_record_json(record_json: String) -> NapiResult<String> {
    config_toml_codec::serialize_toml_record_json(&record_json).map_err(napi::Error::from_reason)
}

#[napi]
pub fn update_route_codex_toml_string_scalar_in_table_json(
    input_json: String,
) -> NapiResult<String> {
    config_toml_codec::update_toml_string_scalar_in_table_json(&input_json)
        .map_err(napi::Error::from_reason)
}

#[napi]
pub fn decode_route_codex_user_config_text_json(input_json: String) -> NapiResult<String> {
    config_file_codec::decode_user_config_text_json(&input_json).map_err(napi::Error::from_reason)
}

#[napi]
pub fn decode_route_codex_provider_config_text_json(input_json: String) -> NapiResult<String> {
    config_file_codec::decode_provider_config_text_json(&input_json)
        .map_err(napi::Error::from_reason)
}

#[napi]
pub fn detect_route_codex_user_config_format_json(input_json: String) -> NapiResult<String> {
    config_file_codec::detect_user_config_format_json(&input_json).map_err(napi::Error::from_reason)
}

#[napi]
pub fn detect_route_codex_provider_config_format_json(input_json: String) -> NapiResult<String> {
    config_file_codec::detect_provider_config_format_json(&input_json)
        .map_err(napi::Error::from_reason)
}

#[napi]
pub fn write_route_codex_user_config_file_json(input_json: String) -> NapiResult<String> {
    config_file_codec::write_user_config_file_json(&input_json).map_err(napi::Error::from_reason)
}

#[napi]
pub fn write_route_codex_provider_config_file_json(input_json: String) -> NapiResult<String> {
    config_file_codec::write_provider_config_file_json(&input_json)
        .map_err(napi::Error::from_reason)
}

#[napi]
pub fn update_route_codex_user_config_string_scalar_json(input_json: String) -> NapiResult<String> {
    config_file_codec::update_user_config_string_scalar_json(&input_json)
        .map_err(napi::Error::from_reason)
}

#[napi]
pub fn load_route_codex_config_json(input_json: String) -> NapiResult<String> {
    config_file_codec::load_routecodex_config_json(&input_json).map_err(napi::Error::from_reason)
}

#[napi]
pub fn coerce_route_codex_provider_config_v2_json(input_json: String) -> NapiResult<String> {
    config_provider_codec::coerce_provider_config_v2_from_parsed_json(&input_json)
        .map_err(napi::Error::from_reason)
}

#[napi]
pub fn plan_route_codex_provider_config_v2_files_json(input_json: String) -> NapiResult<String> {
    config_provider_codec::plan_provider_config_v2_files_json(&input_json)
        .map_err(napi::Error::from_reason)
}

#[napi]
pub fn resolve_route_codex_provider_config_v2_identity_json(
    input_json: String,
) -> NapiResult<String> {
    config_provider_codec::resolve_provider_config_v2_identity_json(&input_json)
        .map_err(napi::Error::from_reason)
}

#[napi]
pub fn load_route_codex_provider_configs_v2_from_root_json(
    input_json: String,
) -> NapiResult<String> {
    config_provider_codec::load_provider_configs_v2_from_root_json(&input_json)
        .map_err(napi::Error::from_reason)
}

fn analyze_pending_tool_sync(
    messages: Vec<Value>,
    after_tool_call_ids: Vec<String>,
) -> PendingToolSyncOutput {
    let normalized_after_ids: Vec<String> = after_tool_call_ids
        .into_iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect();
    if normalized_after_ids.is_empty() {
        return PendingToolSyncOutput {
            ready: false,
            insert_at: -1,
        };
    }

    let mut tool_call_ids: HashSet<String> = HashSet::new();
    let mut insert_at: i64 = -1;
    for (idx, message) in messages.iter().enumerate() {
        let obj = match message.as_object() {
            Some(v) => v,
            None => continue,
        };
        if obj
            .get("role")
            .and_then(|v| v.as_str())
            .map(|v| v == "tool")
            .unwrap_or(false)
        {
            insert_at = idx as i64;
            let tool_call_id = obj
                .get("tool_call_id")
                .and_then(|v| v.as_str())
                .or_else(|| obj.get("toolCallId").and_then(|v| v.as_str()))
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
            if let Some(id) = tool_call_id {
                tool_call_ids.insert(id);
            }
        }
    }

    let ready = normalized_after_ids
        .iter()
        .all(|id| tool_call_ids.contains(id));
    PendingToolSyncOutput { ready, insert_at }
}

fn message_content_contains_token(content: &Value, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    if let Some(raw) = content.as_str() {
        return raw.contains(token);
    }
    let parts = match content.as_array() {
        Some(v) => v,
        None => return false,
    };
    for part in parts {
        let obj = match part.as_object() {
            Some(v) => v,
            None => continue,
        };
        if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
            if text.contains(token) {
                return true;
            }
        }
    }
    false
}

fn analyze_continue_execution_injection(
    messages: Vec<Value>,
    marker: String,
    target_text: String,
) -> ContinueExecutionInjectionOutput {
    let marker = marker.trim().to_string();
    let target_text = target_text.trim().to_string();
    if marker.is_empty() && target_text.is_empty() {
        return ContinueExecutionInjectionOutput {
            has_directive: false,
        };
    }
    for message in messages {
        let obj = match message.as_object() {
            Some(v) => v,
            None => continue,
        };
        if obj
            .get("role")
            .and_then(|v| v.as_str())
            .map(|v| v == "user")
            .unwrap_or(false)
            == false
        {
            continue;
        }
        let content = match obj.get("content") {
            Some(v) => v,
            None => continue,
        };
        if message_content_contains_token(content, marker.as_str())
            || message_content_contains_token(content, target_text.as_str())
        {
            return ContinueExecutionInjectionOutput {
                has_directive: true,
            };
        }
    }
    ContinueExecutionInjectionOutput {
        has_directive: false,
    }
}

#[napi]
pub fn analyze_pending_tool_sync_json(
    messages_json: String,
    after_tool_call_ids_json: String,
) -> NapiResult<String> {
    let messages: Vec<Value> = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let after_tool_call_ids: Vec<String> = serde_json::from_str(&after_tool_call_ids_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = analyze_pending_tool_sync(messages, after_tool_call_ids);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn analyze_continue_execution_injection_json(
    messages_json: String,
    marker: String,
    target_text: String,
) -> NapiResult<String> {
    let messages: Vec<Value> = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = analyze_continue_execution_injection(messages, marker, target_text);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn analyze_chat_process_media_json(messages_json: String) -> NapiResult<String> {
    let messages: Vec<Value> = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = analyze_chat_process_media(messages);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn strip_chat_process_historical_images_json(
    messages_json: String,
    placeholder_text: String,
) -> NapiResult<String> {
    let messages: Vec<Value> = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = strip_chat_process_historical_images(messages, placeholder_text);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn strip_responses_stored_context_input_media_json(
    input_entries_json: String,
    placeholder_text: String,
) -> NapiResult<String> {
    let input_entries: Vec<Value> = serde_json::from_str(&input_entries_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = strip_responses_stored_context_input_media(input_entries, placeholder_text);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn analyze_chat_web_search_intent_json(messages_json: String) -> NapiResult<String> {
    let messages: Vec<Value> = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = analyze_chat_web_search_intent(messages);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn normalize_args_by_schema_json(
    input_json: String,
    schema_json: String,
) -> NapiResult<String> {
    shared_args_mapping::normalize_args_by_schema_json(input_json, schema_json)
}

#[napi]
pub fn repair_find_meta_json(input_json: String) -> NapiResult<String> {
    shared_tooling::repair_find_meta_json(input_json)
}

#[napi]
pub fn normalize_id_value_json(input_json: String) -> NapiResult<String> {
    shared_tool_call_id_manager::normalize_id_value_json(input_json)
}

#[napi]
pub fn extract_tool_call_id_json(input_json: String) -> NapiResult<String> {
    shared_tool_call_id_manager::extract_tool_call_id_json(input_json)
}

#[napi]
pub fn create_tool_call_id_transformer_json(input_json: String) -> NapiResult<String> {
    shared_tool_call_id_manager::create_tool_call_id_transformer_json(input_json)
}

#[napi]
pub fn transform_tool_call_id_json(input_json: String) -> NapiResult<String> {
    shared_tool_call_id_manager::transform_tool_call_id_json(input_json)
}

#[napi]
pub fn enforce_tool_call_id_style_json(input_json: String) -> NapiResult<String> {
    shared_tool_call_id_manager::enforce_tool_call_id_style_json(input_json)
}

#[napi]
pub fn prune_chat_request_payload_json(input_json: String) -> NapiResult<String> {
    shared_chat_request_filters::prune_chat_request_payload_json(input_json)
}

#[napi]
pub fn extract_streaming_tool_calls_json(input_json: String) -> NapiResult<String> {
    streaming_tool_extractor::extract_streaming_tool_calls_json(input_json)
}

#[napi(js_name = "createStreamingToolExtractorStateJson")]
pub fn create_streaming_tool_extractor_state_json(
    input_json: Option<String>,
) -> NapiResult<String> {
    streaming_tool_extractor::create_streaming_tool_extractor_state_json(input_json)
}

#[napi(js_name = "resetStreamingToolExtractorStateJson")]
pub fn reset_streaming_tool_extractor_state_json(state_json: String) -> NapiResult<String> {
    streaming_tool_extractor::reset_streaming_tool_extractor_state_json(state_json)
}

#[napi(js_name = "feedStreamingToolExtractorJson")]
pub fn feed_streaming_tool_extractor_json(input_json: String) -> NapiResult<String> {
    streaming_tool_extractor::feed_streaming_tool_extractor_json(input_json)
}

#[napi]
pub fn map_bridge_tools_to_chat_with_options_json(input_json: String) -> NapiResult<String> {
    shared_tool_mapping::map_bridge_tools_to_chat_with_options_json(input_json)
}

#[napi]
pub fn map_chat_tools_to_bridge_with_options_json(input_json: String) -> NapiResult<String> {
    shared_tool_mapping::map_chat_tools_to_bridge_with_options_json(input_json)
}

#[napi]
pub fn flatten_chat_tools_for_function_calling_with_options_json(
    input_json: String,
) -> NapiResult<String> {
    shared_tool_mapping::flatten_chat_tools_for_function_calling_with_options_json(input_json)
}

#[napi]
pub fn map_chat_tools_to_anthropic_tools_json(tools_json: String) -> NapiResult<String> {
    anthropic_openai_codec::map_chat_tools_to_anthropic_tools_json(tools_json)
}

#[napi]
pub fn normalize_bridge_tool_call_ids_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::normalize_bridge_tool_call_ids_json(input_json)
}

#[napi]
pub fn apply_bridge_normalize_tool_identifiers_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::apply_bridge_normalize_tool_identifiers_json(input_json)
}

#[napi]
pub fn build_bridge_history_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::build_bridge_history_json(input_json)
}

#[napi]
pub fn normalize_bridge_history_seed_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::normalize_bridge_history_seed_json(input_json)
}

#[napi]
pub fn resolve_responses_bridge_tools_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::resolve_responses_bridge_tools_json(input_json)
}

#[napi]
pub fn resolve_responses_request_bridge_decisions_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::resolve_responses_request_bridge_decisions_json(input_json)
}

#[napi]
pub fn filter_bridge_input_for_upstream_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::filter_bridge_input_for_upstream_json(input_json)
}

#[napi]
pub fn sanitize_captured_responses_input_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::sanitize_captured_responses_input_json(input_json)
}

#[napi]
pub fn pick_responses_request_parameters_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::pick_responses_request_parameters_json(input_json)
}

#[napi]
pub fn pick_responses_tool_passthrough_fields_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::pick_responses_tool_passthrough_fields_json(input_json)
}

#[napi]
pub fn pick_responses_bridge_decision_metadata_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::pick_responses_bridge_decision_metadata_json(input_json)
}

#[napi]
pub fn extract_responses_metadata_extra_fields_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::extract_responses_metadata_extra_fields_json(input_json)
}

#[napi]
pub fn strip_responses_tool_control_fields_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::strip_responses_tool_control_fields_json(input_json)
}

#[napi]
pub fn unwrap_responses_data_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::unwrap_responses_data_json(input_json)
}

#[napi]
pub fn build_slim_responses_bridge_context_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::build_slim_responses_bridge_context_json(input_json)
}

#[napi]
pub fn merge_retained_responses_request_parameters_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::merge_retained_responses_request_parameters_json(input_json)
}

#[napi]
pub fn prepare_responses_request_envelope_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::prepare_responses_request_envelope_json(input_json)
}

#[napi]
pub fn append_local_image_block_on_latest_user_input_json(
    input_json: String,
) -> NapiResult<String> {
    hub_bridge_actions::append_local_image_block_on_latest_user_input_json(input_json)
}

#[napi]
pub fn apply_bridge_normalize_history_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::apply_bridge_normalize_history_json(input_json)
}

#[napi]
pub fn apply_bridge_capture_tool_results_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::apply_bridge_capture_tool_results_json(input_json)
}

#[napi]
pub fn apply_bridge_ensure_tool_placeholders_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::apply_bridge_ensure_tool_placeholders_json(input_json)
}

#[napi]
pub fn convert_bridge_input_to_chat_messages_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::convert_bridge_input_to_chat_messages_json(input_json)
}

#[napi(js_name = "buildResponsesRequestFromChatJson")]
pub fn build_responses_request_from_chat_json(input_json: String) -> NapiResult<String> {
    hub_req_outbound_format_build::build_responses_request_from_chat_json(input_json)
}

#[napi]
pub fn extract_reasoning_segments_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::extract_reasoning_segments_json(input_json)
}

#[napi]
pub fn map_reasoning_content_to_responses_output_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::map_reasoning_content_to_responses_output_json(input_json)
}

#[napi]
pub fn collect_tool_calls_from_responses_json(response_json: String) -> NapiResult<String> {
    shared_responses_response_utils::collect_tool_calls_from_responses_json(response_json)
}

#[napi]
pub fn resolve_finish_reason_json(
    response_json: String,
    tool_calls_json: String,
) -> NapiResult<String> {
    shared_responses_response_utils::resolve_finish_reason_json(response_json, tool_calls_json)
}

#[napi(js_name = "buildChatResponseFromResponsesJson")]
pub fn build_chat_response_from_responses_json(payload_json: String) -> NapiResult<String> {
    shared_responses_response_utils::build_chat_response_from_responses_json(payload_json)
}

#[napi(js_name = "buildChatResponseFromResponsesFullJson")]
pub fn build_chat_response_from_responses_full_json(input_json: String) -> NapiResult<String> {
    shared_responses_response_utils::build_chat_response_from_responses_full_json(input_json)
}

#[napi(js_name = "parseRespFormatEnvelopeJson")]
pub fn parse_resp_format_envelope_json_bridge(input_json: String) -> NapiResult<String> {
    hub_resp_inbound_format_parse::parse_resp_format_envelope_json(input_json)
}

#[napi(js_name = "buildResponsesJsonFromSseJson")]
pub fn build_responses_json_from_sse_json_bridge(input_json: String) -> NapiResult<String> {
    hub_resp_inbound_format_parse::build_responses_json_from_sse_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildJsonFromSseJson")]
pub fn build_json_from_sse_json_bridge(input_json: String) -> NapiResult<String> {
    sse_runtime_dispatch::build_json_from_sse_json(input_json).map_err(napi::Error::from_reason)
}

#[napi(js_name = "updateResponsesContractProbeFromSseChunkJson")]
pub fn update_responses_contract_probe_from_sse_chunk_json_bridge(
    chunk_json: String,
    probe_json: String,
) -> NapiResult<String> {
    shared_responses_response_utils::update_responses_contract_probe_from_sse_chunk_json(
        chunk_json, probe_json,
    )
}

#[napi(js_name = "updateResponsesSseTransportTerminalStateJson")]
pub fn update_responses_sse_transport_terminal_state_json_bridge(
    chunk_json: String,
    state_json: String,
    flush_remainder: bool,
) -> NapiResult<String> {
    shared_responses_response_utils::update_responses_sse_transport_terminal_state_json(
        chunk_json,
        state_json,
        flush_remainder,
    )
}

#[napi]
pub fn validate_tool_arguments_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::validate_tool_arguments_json(input_json)
}

#[napi]
pub fn validate_exec_command_guard_json(input_json: String) -> NapiResult<String> {
    resp_process_stage1_tool_governance_blocks::exec_command_guard::validate_exec_command_guard_json(
        &input_json,
    )
    .map_err(napi::Error::from_reason)
}

#[napi(js_name = "normalizeExecCommandArgsJson")]
pub fn normalize_exec_command_args_json(input_json: String) -> NapiResult<String> {
    resp_process_stage1_tool_governance_blocks::exec_command_args::normalize_exec_command_args_json(
        input_json,
    )
}

#[napi]
pub fn repair_tool_calls_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::repair_tool_calls_json(input_json)
}

#[napi(js_name = "parseToolArgsJsonWithArtifactRepairJson")]
pub fn parse_tool_args_json_with_artifact_repair_json(input_json: String) -> NapiResult<String> {
    resp_process_stage1_tool_governance_blocks::json_args::parse_tool_args_json_with_artifact_repair_json(
        input_json,
    )
}

#[napi]
pub fn coerce_bridge_role_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::coerce_bridge_role_json(input_json)
}

#[napi]
pub fn serialize_tool_output_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::serialize_tool_output_json(input_json)
}

#[napi]
pub fn serialize_tool_arguments_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::serialize_tool_arguments_json(input_json)
}

#[napi]
pub fn harvest_tools_json(input_json: String) -> NapiResult<String> {
    tool_harvester::harvest_tools_json(input_json)
}

#[napi]
pub fn ensure_messages_array_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::ensure_messages_array_json(input_json)
}

#[napi]
pub fn normalize_reasoning_in_chat_payload_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::normalize_reasoning_in_chat_payload_json(input_json)
}

#[napi]
pub fn normalize_reasoning_in_openai_payload_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::normalize_reasoning_in_openai_payload_json(input_json)
}

#[napi]
pub fn normalize_reasoning_in_responses_payload_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::normalize_reasoning_in_responses_payload_json(input_json)
}

#[napi]
pub fn normalize_reasoning_in_gemini_payload_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::normalize_reasoning_in_gemini_payload_json(input_json)
}

#[napi]
pub fn normalize_reasoning_in_anthropic_payload_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::normalize_reasoning_in_anthropic_payload_json(input_json)
}

#[napi]
pub fn build_slim_responses_context_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::build_slim_responses_context_json(input_json)
}

#[napi(js_name = "shouldLogClientRemapDebugJson")]
pub fn should_log_client_remap_debug_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::should_log_client_remap_debug_json(input_json)
}

#[napi(js_name = "extractClientToolIndexJson")]
pub fn extract_client_tool_index_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::extract_client_tool_index_json(input_json)
}

#[napi(js_name = "executeHubPipelineJson")]
pub fn execute_hub_pipeline_json(input_json: String) -> NapiResult<String> {
    hub_pipeline_lib::execute_hub_pipeline_json(input_json)
        .map_err(|error| napi::Error::from_reason(format!("{}: {}", error.code, error.message)))
}

#[napi(js_name = "runHubPipelineLibJson")]
pub fn run_hub_pipeline_lib_json(input_json: String) -> NapiResult<String> {
    hub_pipeline_lib::run_hub_pipeline_lib_json(input_json)
        .map_err(|error| napi::Error::from_reason(format!("{}: {}", error.code, error.message)))
}

#[napi(js_name = "normalizeProviderResponseEffectPlanJson")]
pub fn normalize_provider_response_effect_plan_json(input_json: String) -> NapiResult<String> {
    hub_pipeline_lib::effect_plan::normalize_provider_response_effect_plan_json(input_json)
}

// feature_id: hub.request_stage_pipeline_bridge
#[napi(js_name = "resolveProviderProtocolJson")]
pub fn resolve_provider_protocol_json(input_json: String) -> NapiResult<String> {
    hub_pipeline_blocks::napi_bindings::resolve_provider_protocol_json(input_json)
}

#[napi(js_name = "buildRequestStageMetadataDispatchJson")]
pub fn build_request_stage_metadata_dispatch_json(input_json: String) -> NapiResult<String> {
    hub_pipeline_blocks::napi_bindings::build_request_stage_metadata_dispatch_json(input_json)
}

#[napi(js_name = "buildHubPipelineMaterializedRequestPlanJson")]
pub fn build_hub_pipeline_materialized_request_plan_json(input_json: String) -> NapiResult<String> {
    hub_pipeline_blocks::napi_bindings::build_hub_pipeline_materialized_request_plan_json(
        input_json,
    )
}

#[napi(js_name = "buildProviderResponseMetadataSnapshotJson")]
pub fn build_provider_response_metadata_snapshot_json(input_json: String) -> NapiResult<String> {
    hub_pipeline_blocks::napi_bindings::build_provider_response_metadata_snapshot_json(input_json)
}

#[napi(js_name = "buildRequestStageRuntimeControlWritePlanJson")]
pub fn build_request_stage_runtime_control_write_plan_json(
    input_json: String,
) -> NapiResult<String> {
    hub_pipeline_blocks::napi_bindings::build_request_stage_runtime_control_write_plan_json(
        input_json,
    )
}

#[napi(js_name = "buildRequestStageNativeResultPlanJson")]
pub fn build_request_stage_native_result_plan_json(input_json: String) -> NapiResult<String> {
    hub_pipeline_lib::effect_plan::build_request_stage_native_result_plan_json(input_json)
}

#[napi(js_name = "buildRequestStageHubPipelineResultJson")]
pub fn build_request_stage_hub_pipeline_result_json(input_json: String) -> NapiResult<String> {
    hub_pipeline_lib::effect_plan::build_request_stage_hub_pipeline_result_json(input_json)
}

#[napi(js_name = "projectMetadataWritePlanToRuntimeControlJson")]
pub fn project_metadata_write_plan_to_runtime_control_json(
    input_json: String,
) -> NapiResult<String> {
    hub_pipeline_lib::effect_plan::project_metadata_write_plan_to_runtime_control_json(input_json)
}

#[napi(js_name = "projectMetadataWritePlanToRuntimeControlWritePlanJson")]
pub fn project_metadata_write_plan_to_runtime_control_write_plan_json(
    input_json: String,
) -> NapiResult<String> {
    hub_pipeline_lib::effect_plan::project_metadata_write_plan_to_runtime_control_write_plan_json(
        input_json,
    )
}

#[napi(js_name = "resolveClientToolFromIndexJson")]
pub fn resolve_client_tool_from_index_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::resolve_client_tool_from_index_json(input_json)
}

#[napi(js_name = "remapChatToolCallsJson")]
pub fn remap_chat_tool_calls_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::remap_chat_tool_calls_json(input_json)
}

#[napi]
pub fn normalize_resp_inbound_reasoning_payload_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::normalize_resp_inbound_reasoning_payload_json(input_json)
}

#[napi]
pub fn ensure_bridge_output_fields_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::ensure_bridge_output_fields_json(input_json)
}

#[napi]
pub fn apply_bridge_metadata_action_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::apply_bridge_metadata_action_json(input_json)
}

#[napi]
pub fn apply_bridge_inject_system_instruction_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::apply_bridge_inject_system_instruction_json(input_json)
}

#[napi]
pub fn apply_bridge_ensure_system_instruction_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::apply_bridge_ensure_system_instruction_json(input_json)
}

#[napi]
pub fn apply_bridge_reasoning_extract_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::apply_bridge_reasoning_extract_json(input_json)
}

#[napi]
pub fn apply_bridge_responses_output_reasoning_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::apply_bridge_responses_output_reasoning_json(input_json)
}

#[napi]
pub fn run_bridge_action_pipeline_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::run_bridge_action_pipeline_json(input_json)
}

fn serialize_instruction_target_for_napi(
    target: &crate::virtual_router_engine::instructions::InstructionTarget,
    out: &mut Map<String, Value>,
) {
    if let Some(value) = &target.provider {
        out.insert("provider".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = &target.key_alias {
        out.insert("keyAlias".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = target.key_index {
        out.insert("keyIndex".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = &target.model {
        out.insert("model".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = target.path_length {
        out.insert("pathLength".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = &target.process_mode {
        out.insert("processMode".to_string(), Value::String(value.clone()));
    }
}

fn serialize_routing_instruction_for_napi(
    instruction: &crate::virtual_router_engine::instructions::RoutingInstruction,
) -> Value {
    let mut out = Map::new();
    out.insert("type".to_string(), Value::String(instruction.kind.clone()));
    if let Some(target) = &instruction.target {
        serialize_instruction_target_for_napi(target, &mut out);
    }
    if let Some(provider) = &instruction.provider {
        out.insert("provider".to_string(), Value::String(provider.clone()));
    }
    if let Some(stop) = &instruction.stop_message {
        if let Some(value) = &stop.text {
            out.insert("stopMessageText".to_string(), Value::String(value.clone()));
        }
        if let Some(value) = stop.max_repeats {
            out.insert(
                "stopMessageMaxRepeats".to_string(),
                Value::Number(value.into()),
            );
        }
        if let Some(value) = &stop.stage_mode {
            out.insert(
                "stopMessageStageMode".to_string(),
                Value::String(value.clone()),
            );
        }
        if let Some(value) = &stop.ai_mode {
            out.insert(
                "stopMessageAiMode".to_string(),
                Value::String(value.clone()),
            );
        }
        if let Some(value) = &stop.source {
            out.insert(
                "stopMessageSource".to_string(),
                Value::String(value.clone()),
            );
        }
        if stop.from_historical {
            out.insert("fromHistoricalUserMessage".to_string(), Value::Bool(true));
        }
    }
    if let Some(pre) = &instruction.pre_command {
        if let Some(value) = &pre.script_path {
            out.insert(
                "preCommandScriptPath".to_string(),
                Value::String(value.clone()),
            );
        }
    }
    Value::Object(out)
}

fn deserialize_instruction_target_for_napi(
    raw: Option<&Value>,
) -> Option<crate::virtual_router_engine::instructions::InstructionTarget> {
    let obj = raw?.as_object()?;
    Some(
        crate::virtual_router_engine::instructions::InstructionTarget {
            provider: obj
                .get("provider")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            key_alias: obj
                .get("keyAlias")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            key_index: obj.get("keyIndex").and_then(|v| v.as_i64()),
            model: obj
                .get("model")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            path_length: obj.get("pathLength").and_then(|v| v.as_i64()),
            process_mode: obj
                .get("processMode")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
        },
    )
}

fn deserialize_routing_instruction_for_napi(
    raw: &Value,
) -> Option<crate::virtual_router_engine::instructions::RoutingInstruction> {
    let obj = raw.as_object()?;
    let kind = obj
        .get("type")
        .or_else(|| obj.get("kind"))?
        .as_str()?
        .to_string();
    let stop_message = match kind.as_str() {
        "stopMessageSet" | "stopMessageMode" | "stopMessageClear" => Some(
            crate::virtual_router_engine::instructions::StopMessageInstruction {
                kind: match kind.as_str() {
                    "stopMessageClear" => "clear".to_string(),
                    "stopMessageMode" => "mode".to_string(),
                    _ => "set".to_string(),
                },
                text: obj
                    .get("stopMessageText")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
                max_repeats: obj.get("stopMessageMaxRepeats").and_then(|v| v.as_i64()),
                stage_mode: obj
                    .get("stopMessageStageMode")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
                ai_mode: obj
                    .get("stopMessageAiMode")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
                source: obj
                    .get("stopMessageSource")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string())
                    .or_else(|| Some("explicit".to_string())),
                from_historical: obj
                    .get("fromHistorical")
                    .or_else(|| obj.get("fromHistoricalUserMessage"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            },
        ),
        _ => None,
    };
    let pre_command = match kind.as_str() {
        "preCommandSet" | "preCommandClear" => Some(
            crate::virtual_router_engine::instructions::PreCommandInstruction {
                kind: if kind == "preCommandClear" {
                    "clear".to_string()
                } else {
                    "set".to_string()
                },
                script_path: obj
                    .get("preCommandScriptPath")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
            },
        ),
        _ => None,
    };
    Some(
        crate::virtual_router_engine::instructions::RoutingInstruction {
            kind,
            target: deserialize_instruction_target_for_napi(Some(raw)),
            provider: obj
                .get("provider")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            stop_message,
            pre_command,
        },
    )
}

#[napi]
pub fn parse_routing_instructions_json(
    messages_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    let messages: Vec<Value> = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let options = parse_routing_instruction_parse_options(options_json)?;
    let parsed = virtual_router_engine::instructions::with_rcc_user_dir_override(
        options.rcc_user_dir.as_deref(),
        || virtual_router_engine::instructions::parse_routing_instructions_from_messages(&messages),
    )
    .map_err(|e| napi::Error::from_reason(e))?;
    let output: Vec<Value> = parsed
        .iter()
        .map(serialize_routing_instruction_for_napi)
        .collect();
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "applyRoutingInstructionsJson")]
pub fn apply_routing_instructions_json(input_json: String) -> NapiResult<String> {
    let input: ApplyRoutingInstructionsInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut state =
        virtual_router_engine::routing_state_store::deserialize_routing_instruction_state(
            &input.state,
        )
        .unwrap_or_default();
    let mut instructions = Vec::with_capacity(input.instructions.len());
    for instruction in &input.instructions {
        let parsed = deserialize_routing_instruction_for_napi(instruction)
            .ok_or_else(|| napi::Error::from_reason("invalid routing instruction payload"))?;
        instructions.push(parsed);
    }
    virtual_router_engine::instructions::apply_routing_instructions(&instructions, &mut state)
        .map_err(napi::Error::from_reason)?;
    let out =
        virtual_router_engine::routing_state_store::serialize_routing_instruction_state(&state);
    serde_json::to_string(&out).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn serialize_routing_instruction_state_json(state_json: String) -> NapiResult<String> {
    let state_value: Value =
        serde_json::from_str(&state_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let state = virtual_router_engine::routing_state_store::deserialize_routing_instruction_state(
        &state_value,
    )
    .unwrap_or_default();
    let out =
        virtual_router_engine::routing_state_store::serialize_routing_instruction_state(&state);
    serde_json::to_string(&out).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn deserialize_routing_instruction_state_json(state_json: String) -> NapiResult<String> {
    let state_value: Value =
        serde_json::from_str(&state_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let state = virtual_router_engine::routing_state_store::deserialize_routing_instruction_state(
        &state_value,
    )
    .ok_or_else(|| napi::Error::from_reason("invalid routing instruction state payload"))?;
    let out =
        virtual_router_engine::routing_state_store::serialize_routing_instruction_state(&state);
    serde_json::to_string(&out).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn is_routing_instruction_state_persistent_key_json(key: Option<String>) -> NapiResult<String> {
    let persistent = key
        .as_deref()
        .map(virtual_router_engine::routing_state_store::is_persistent_key)
        .unwrap_or(false);
    serde_json::to_string(&persistent).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn is_routing_instruction_state_empty_json(state_json: String) -> NapiResult<String> {
    let state_value: Value =
        serde_json::from_str(&state_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let state = virtual_router_engine::routing_state_store::deserialize_routing_instruction_state(
        &state_value,
    )
    .unwrap_or_default();
    let empty = virtual_router_engine::routing_state_store::is_state_empty(&state);
    serde_json::to_string(&empty).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn should_save_routing_instruction_state_sync_json(key: Option<String>) -> NapiResult<String> {
    let should_sync = key
        .as_deref()
        .map(virtual_router_engine::routing_state_store::should_save_sync)
        .unwrap_or(false);
    serde_json::to_string(&should_sync).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn load_routing_instruction_state_json(
    key: String,
    session_dir: Option<String>,
) -> NapiResult<String> {
    let state = virtual_router_engine::routing_state_store::with_session_dir_override(
        session_dir.as_deref(),
        || virtual_router_engine::routing_state_store::load_routing_instruction_state(&key),
    );
    let out = state
        .as_ref()
        .map(virtual_router_engine::routing_state_store::serialize_routing_instruction_state);
    serde_json::to_string(&out).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn save_routing_instruction_state_json(
    key: String,
    state_json: String,
    session_dir: Option<String>,
) -> NapiResult<String> {
    let state_value: Value =
        serde_json::from_str(&state_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    if state_value.is_null() {
        virtual_router_engine::routing_state_store::with_session_dir_override(
            session_dir.as_deref(),
            || {
                virtual_router_engine::routing_state_store::persist_routing_instruction_state(
                    &key, None,
                )
            },
        );
        return Ok("true".to_string());
    }
    let state = virtual_router_engine::routing_state_store::deserialize_routing_instruction_state(
        &state_value,
    )
    .ok_or_else(|| napi::Error::from_reason("invalid routing instruction state payload"))?;
    virtual_router_engine::routing_state_store::with_session_dir_override(
        session_dir.as_deref(),
        || {
            virtual_router_engine::routing_state_store::persist_routing_instruction_state(
                &key,
                Some(&state),
            )
        },
    );
    Ok("true".to_string())
}

#[napi]
pub fn merge_stop_message_from_persisted_json(
    existing_json: String,
    persisted_json: String,
) -> NapiResult<String> {
    let existing_value: Value = serde_json::from_str(&existing_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let persisted_value: Value = serde_json::from_str(&persisted_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let existing =
        virtual_router_engine::routing_state_store::deserialize_routing_instruction_state(
            &existing_value,
        )
        .unwrap_or_default();
    let persisted = if persisted_value.is_null() {
        None
    } else {
        virtual_router_engine::routing_state_store::deserialize_routing_instruction_state(
            &persisted_value,
        )
    };
    let merged = virtual_router_engine::routing_state_store::merge_stop_message_from_persisted(
        &existing,
        persisted.as_ref(),
    );
    let out =
        virtual_router_engine::routing_state_store::serialize_routing_instruction_state(&merged);
    serde_json::to_string(&out).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_routing_instruction_kinds_json(
    request_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let options = parse_routing_instruction_parse_options(options_json)?;
    let parsed = virtual_router_engine::instructions::with_rcc_user_dir_override(
        options.rcc_user_dir.as_deref(),
        || virtual_router_engine::instructions::parse_routing_instructions_from_request(&request),
    )
    .map_err(|e| napi::Error::from_reason(e))?;
    let kinds: Vec<String> = parsed.into_iter().map(|entry| entry.kind).collect();
    serde_json::to_string(&kinds).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RccUserDirResolveInput {
    #[serde(default)]
    home_dir: Option<String>,
    #[serde(default)]
    rcc_home: Option<String>,
    #[serde(default)]
    routecodex_user_dir: Option<String>,
    #[serde(default)]
    routecodex_home: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RccPathResolveInput {
    #[serde(default)]
    home_dir: Option<String>,
    #[serde(default)]
    segments: Vec<String>,
    #[serde(default)]
    rcc_home: Option<String>,
    #[serde(default)]
    routecodex_user_dir: Option<String>,
    #[serde(default)]
    routecodex_home: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RccSnapshotsDirResolveInputJson {
    #[serde(default)]
    home_dir: Option<String>,
    #[serde(default)]
    rcc_snapshot_dir: Option<String>,
    #[serde(default)]
    routecodex_snapshot_dir: Option<String>,
    #[serde(default)]
    rcc_home: Option<String>,
    #[serde(default)]
    routecodex_user_dir: Option<String>,
    #[serde(default)]
    routecodex_home: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthFileResolvePlanInputJson {
    key_id: String,
    #[serde(default)]
    auth_dir: Option<String>,
    #[serde(default)]
    home_dir: Option<String>,
    #[serde(default)]
    rcc_home: Option<String>,
    #[serde(default)]
    routecodex_user_dir: Option<String>,
    #[serde(default)]
    routecodex_home: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteCodexConfigLoaderPathPlanInputJson {
    #[serde(default)]
    explicit_path: Option<String>,
    #[serde(default)]
    routecodex_provider_dir: Option<String>,
    #[serde(default)]
    rcc_provider_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfigRootPlanInputJson {
    #[serde(default)]
    root_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteCodexConfigPathResolveInputJson {
    #[serde(default)]
    preferred_path: Option<String>,
    #[serde(default)]
    config_name: Option<String>,
    #[serde(default = "default_true")]
    allow_directory_scan: bool,
    #[serde(default)]
    base_dir: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    home_dir: Option<String>,
    #[serde(default)]
    exec_path: Option<String>,
    #[serde(default)]
    routecodex_config_path: Option<String>,
    #[serde(default)]
    routecodex_config: Option<String>,
    #[serde(default)]
    rcc_home: Option<String>,
    #[serde(default)]
    routecodex_user_dir: Option<String>,
    #[serde(default)]
    routecodex_home: Option<String>,
}

fn default_true() -> bool {
    true
}

#[napi(js_name = "resolveRccUserDirJson")]
pub fn resolve_rcc_user_dir_json(input_json: String) -> NapiResult<String> {
    let input: RccUserDirResolveInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let path = virtual_router_engine::instructions::resolve_rcc_user_dir_for_host_with_env(
        input.home_dir.as_deref(),
        &[
            ("RCC_HOME", input.rcc_home.as_deref()),
            ("ROUTECODEX_USER_DIR", input.routecodex_user_dir.as_deref()),
            ("ROUTECODEX_HOME", input.routecodex_home.as_deref()),
        ],
    )
    .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&path.to_string_lossy().to_string())
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi(js_name = "resolveRccPathJson")]
pub fn resolve_rcc_path_json(input_json: String) -> NapiResult<String> {
    let input: RccPathResolveInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let path = virtual_router_engine::instructions::resolve_rcc_path_for_host_with_env(
        input.home_dir.as_deref(),
        &input.segments,
        &[
            ("RCC_HOME", input.rcc_home.as_deref()),
            ("ROUTECODEX_USER_DIR", input.routecodex_user_dir.as_deref()),
            ("ROUTECODEX_HOME", input.routecodex_home.as_deref()),
        ],
    )
    .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&path.to_string_lossy().to_string())
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi(js_name = "resolveRccSnapshotsDirJson")]
pub fn resolve_rcc_snapshots_dir_json(input_json: String) -> NapiResult<String> {
    let input: RccSnapshotsDirResolveInputJson = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let plan = virtual_router_engine::instructions::resolve_rcc_snapshots_dir_for_host_with_env(
        virtual_router_engine::instructions::RccSnapshotsDirResolveInput {
            home_dir: input.home_dir.as_deref(),
            rcc_snapshot_dir: input.rcc_snapshot_dir.as_deref(),
            routecodex_snapshot_dir: input.routecodex_snapshot_dir.as_deref(),
            rcc_home: input.rcc_home.as_deref(),
            routecodex_user_dir: input.routecodex_user_dir.as_deref(),
            routecodex_home: input.routecodex_home.as_deref(),
        },
    )
    .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&plan).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi(js_name = "planAuthFileResolutionJson")]
pub fn plan_auth_file_resolution_json(input_json: String) -> NapiResult<String> {
    let input: AuthFileResolvePlanInputJson = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let plan = virtual_router_engine::instructions::plan_auth_file_resolution_for_host(
        virtual_router_engine::instructions::AuthFileResolvePlanInput {
            key_id: &input.key_id,
            auth_dir: input.auth_dir.as_deref(),
            home_dir: input.home_dir.as_deref(),
            rcc_home: input.rcc_home.as_deref(),
            routecodex_user_dir: input.routecodex_user_dir.as_deref(),
            routecodex_home: input.routecodex_home.as_deref(),
        },
    )
    .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&plan).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi(js_name = "resolveAuthFileKeyJson")]
pub fn resolve_auth_file_key_json(input_json: String) -> NapiResult<String> {
    let input: AuthFileResolvePlanInputJson = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let output = virtual_router_engine::instructions::resolve_auth_file_key_for_host(
        virtual_router_engine::instructions::AuthFileResolvePlanInput {
            key_id: &input.key_id,
            auth_dir: input.auth_dir.as_deref(),
            home_dir: input.home_dir.as_deref(),
            rcc_home: input.rcc_home.as_deref(),
            routecodex_user_dir: input.routecodex_user_dir.as_deref(),
            routecodex_home: input.routecodex_home.as_deref(),
        },
    )
    .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi(js_name = "planRouteCodexConfigLoaderPathsJson")]
pub fn plan_routecodex_config_loader_paths_json(input_json: String) -> NapiResult<String> {
    let input: RouteCodexConfigLoaderPathPlanInputJson = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let plan = virtual_router_engine::instructions::plan_routecodex_config_loader_paths_for_host(
        virtual_router_engine::instructions::RouteCodexConfigLoaderPathPlanInput {
            explicit_path: input.explicit_path.as_deref(),
            routecodex_provider_dir: input.routecodex_provider_dir.as_deref(),
            rcc_provider_dir: input.rcc_provider_dir.as_deref(),
        },
    );
    serde_json::to_string(&plan).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi(js_name = "planProviderConfigRootJson")]
pub fn plan_provider_config_root_json(input_json: String) -> NapiResult<String> {
    let input: ProviderConfigRootPlanInputJson = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let plan = virtual_router_engine::instructions::plan_provider_config_root_for_host(
        virtual_router_engine::instructions::ProviderConfigRootPlanInput {
            root_dir: input.root_dir.as_deref(),
        },
    );
    serde_json::to_string(&plan).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi(js_name = "resolveRouteCodexConfigPathJson")]
pub fn resolve_routecodex_config_path_json(input_json: String) -> NapiResult<String> {
    let input: RouteCodexConfigPathResolveInputJson = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let path = virtual_router_engine::instructions::resolve_routecodex_config_path_for_host(
        virtual_router_engine::instructions::RouteCodexConfigPathResolveInput {
            preferred_path: input.preferred_path.as_deref(),
            config_name: input.config_name.as_deref(),
            allow_directory_scan: input.allow_directory_scan,
            base_dir: input.base_dir.as_deref(),
            cwd: input.cwd.as_deref(),
            home_dir: input.home_dir.as_deref(),
            exec_path: input.exec_path.as_deref(),
            routecodex_config_path: input.routecodex_config_path.as_deref(),
            routecodex_config: input.routecodex_config.as_deref(),
            rcc_home: input.rcc_home.as_deref(),
            routecodex_user_dir: input.routecodex_user_dir.as_deref(),
            routecodex_home: input.routecodex_home.as_deref(),
        },
    )
    .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&path.to_string_lossy().to_string())
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn parse_rcc_fence_document_json(text: String) -> NapiResult<String> {
    let parsed = virtual_router_engine::rcc_fence::parse_rcc_fence_document(&text)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&parsed).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "parseResolvedStopMessageInstructionJson")]
pub fn parse_resolved_stop_message_instruction_json(
    instruction: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    let options = parse_routing_instruction_parse_options(options_json)?;
    let parsed = virtual_router_engine::instructions::with_rcc_user_dir_override(
        options.rcc_user_dir.as_deref(),
        || virtual_router_engine::instructions::parse_single_instruction(&instruction),
    )
    .map_err(napi::Error::from_reason)?;
    match parsed {
        Some(instruction) if instruction.stop_message.is_some() => {
            serde_json::to_string(&serialize_routing_instruction_for_napi(&instruction))
                .map_err(|e| napi::Error::from_reason(e.to_string()))
        }
        _ => Ok("null".to_string()),
    }
}

#[napi]
pub fn decide_stop_message_action(ctx_json: String) -> NapiResult<String> {
    let ctx: stop_message_core::StopMessageDecisionContext = serde_json::from_str(&ctx_json)
        .map_err(|e| {
            napi::Error::from_reason(format!("deserialize StopMessageDecisionContext: {e}"))
        })?;
    let decision = stop_message_auto_blocks::decide_stop_message_action(&ctx);
    serde_json::to_string(&decision)
        .map_err(|e| napi::Error::from_reason(format!("serialize StopMessageDecision: {e}")))
}

#[napi(js_name = "evaluateStopSchemaGateJson")]
pub fn evaluate_stop_schema_gate_json(
    assistant_text: String,
    used: u32,
    max_repeats: u32,
    prev_observation_hash: String,
    prev_no_change_count: u32,
    reasoning_stop_arguments: Option<String>,
) -> NapiResult<String> {
    let decision = stop_message_auto_blocks::evaluate_stop_schema(
        &assistant_text,
        reasoning_stop_arguments.as_deref(),
        used,
        max_repeats,
        &prev_observation_hash,
        prev_no_change_count,
    );
    let output = serde_json::json!({
        "action": decision.action,
        "reason_code": decision.reason_code,
        "summary_prefix": decision.summary_prefix,
        "followup_text": decision.followup_text,
        "count_budget": decision.count_budget,
        "max_repeats": decision.max_repeats,
        "missing_fields": decision.missing_fields,
        "no_change_count": decision.no_change_count,
        "observation_hash": decision.observation_hash,
        "parsed": decision.parsed,
        "feedback_history": decision.feedback_history,
    });
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("serialize StopSchemaGateDecision: {e}")))
}

#[napi]
pub fn build_followup_request_id(base: String, suffix: Option<String>) -> String {
    followup_mainline_blocks::build_request_id(&base, suffix.as_deref())
}

#[napi]
pub fn inject_loop_warning_json(input_json: String) -> NapiResult<String> {
    let input: followup_core::LoopWarningInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("deserialize LoopWarningInput: {e}")))?;
    let messages = followup_mainline_blocks::inject_warning(input);
    serde_json::to_string(&messages)
        .map_err(|e| napi::Error::from_reason(format!("serialize messages: {e}")))
}

#[napi]
pub fn decide_budget_reset_json(
    stop_observed: bool,
    stop_eligible: bool,
    current_used: u32,
) -> NapiResult<String> {
    let decision =
        followup_mainline_blocks::budget_reset(stop_observed, stop_eligible, current_used);
    serde_json::to_string(&decision)
        .map_err(|e| napi::Error::from_reason(format!("serialize BudgetResetDecision: {e}")))
}

#[napi]
pub fn inspect_stop_gateway_signal(payload_json: String) -> NapiResult<String> {
    servertool_core_blocks::inspect_stop_gateway_signal(&payload_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn normalize_stop_gateway_context_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::normalize_stop_gateway_context_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn extract_stop_message_blocked_report_from_messages_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::extract_stop_message_blocked_report_from_messages_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn normalize_stop_message_compare_context_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::normalize_stop_message_compare_context_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn format_stop_message_compare_context_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::format_stop_message_compare_context_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn evaluate_loop_guard(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::evaluate_loop_guard(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn calculate_budget(
    observed: bool,
    stop_eligible: bool,
    snapshot_json: Option<String>,
    default_config_json: Option<String>,
) -> NapiResult<String> {
    servertool_core_blocks::calculate_budget_json(
        observed,
        stop_eligible,
        snapshot_json.as_deref(),
        default_config_json.as_deref(),
    )
    .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_budget_state_update_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_budget_state_update_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_servertool_state_key_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::resolve_servertool_state_key_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_runtime_stop_message_state_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::resolve_runtime_stop_message_state_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_runtime_stop_message_state_from_metadata_center_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::resolve_runtime_stop_message_state_from_metadata_center_json(
        &input_json,
    )
    .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn read_runtime_stop_message_stage_mode_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::read_runtime_stop_message_stage_mode_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn normalize_stop_message_stage_mode_value_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::normalize_stop_message_stage_mode_value_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn has_armed_stop_message_state_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::has_armed_stop_message_state_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_stop_message_routing_snapshot_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_stop_message_routing_snapshot_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_stop_message_persisted_state_selection_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_stop_message_persisted_state_selection_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_stop_message_routing_state_apply_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_stop_message_routing_state_apply_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_stop_message_routing_state_clear_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_stop_message_routing_state_clear_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_stopless_decision_context_signals_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_stopless_decision_context_signals_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_stop_message_default_config_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_stop_message_default_config_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_stop_message_persist_snapshot_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_stop_message_persist_snapshot_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_bd_working_directory_for_record_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::resolve_bd_working_directory_for_record_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_stop_message_followup_provider_key_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::resolve_stop_message_followup_provider_key_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_client_connection_state_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::resolve_client_connection_state_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn has_compaction_flag_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::has_compaction_flag_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_entry_endpoint_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::resolve_entry_endpoint_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_stop_message_followup_tool_content_max_chars_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::resolve_stop_message_followup_tool_content_max_chars_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_persist_stop_message_state_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_persist_stop_message_state_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_auto_hook_runtime_attempt_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_auto_hook_runtime_attempt_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_auto_hook_caller_finalization_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_auto_hook_caller_finalization_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_auto_hook_caller_result_projection_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_auto_hook_caller_result_projection_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_execution_branch_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_execution_branch_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_execution_branch_application_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_execution_branch_application_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_servertool_timeout_ms_from_env_candidates_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::resolve_servertool_timeout_ms_from_env_candidates_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_engine_preflight_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_engine_preflight_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_engine_orchestration_preflight_action_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_engine_orchestration_preflight_action_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_engine_orchestration_preflight_application_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_engine_orchestration_preflight_application_json(
        &input_json,
    )
    .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_engine_runtime_action_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_engine_runtime_action_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_engine_trigger_observation_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_engine_trigger_observation_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_engine_skip_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_engine_skip_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_engine_skip_application_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_engine_skip_application_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_execution_outcome_runtime_action_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_execution_outcome_runtime_action_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_execution_outcome_materialization_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_execution_outcome_materialization_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_execution_loop_runtime_action_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_execution_loop_runtime_action_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_execution_loop_effect_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_execution_loop_effect_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_response_stage_runtime_action_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_response_stage_runtime_action_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_response_stage_prepass_initial_application_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_response_stage_prepass_initial_application_json(
        &input_json,
    )
    .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_response_stage_auto_hook_pre_application_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_response_stage_auto_hook_pre_application_json(
        &input_json,
    )
    .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_response_stage_auto_hook_post_application_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_response_stage_auto_hook_post_application_json(
        &input_json,
    )
    .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_response_stage_orchestration_output_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_response_stage_orchestration_output_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_response_stage_orchestration_gate_application_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_response_stage_orchestration_gate_application_json(
        &input_json,
    )
    .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn materialize_servertool_response_stage_orchestration_output_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::materialize_servertool_response_stage_orchestration_output_json(
        &input_json,
    )
    .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_entry_preflight_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_entry_preflight_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_entry_preflight_application_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_entry_preflight_application_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_run_engine_entry_preflight_application_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_run_engine_entry_preflight_application_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_entry_context_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_entry_context_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_engine_prepass_action_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_engine_prepass_action_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_run_engine_prepass_application_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_run_engine_prepass_application_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_registry_lookup_action_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_registry_lookup_action_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_registry_auto_hook_descriptors_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_registry_auto_hook_descriptors_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_registry_projection_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_registry_projection_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_registry_source_projection_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_registry_source_projection_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_stopless_cli_projection_context_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_stopless_cli_projection_context_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_engine_selection_start_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_engine_selection_start_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_engine_selection_after_run_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_engine_selection_after_run_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_execution_dispatch_error_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_execution_dispatch_error_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn build_servertool_postflight_observation_summary_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::build_servertool_postflight_observation_summary_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_servertool_engine_match_hit_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::resolve_servertool_engine_match_hit_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_handler_materialization_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_handler_materialization_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn create_servertool_execution_loop_state_json() -> NapiResult<String> {
    servertool_core_blocks::create_servertool_execution_loop_state_json()
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn append_servertool_executed_record_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::append_servertool_executed_record_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_default_stop_message_snapshot_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::resolve_default_stop_message_snapshot_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_implicit_gemini_stop_message_snapshot_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::resolve_implicit_gemini_stop_message_snapshot_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn read_servertool_loop_state_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::read_servertool_loop_state_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_loop_state_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_loop_state_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn parse_servertool_timeout_ms_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::parse_servertool_timeout_ms_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_timeout_watcher_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_timeout_watcher_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn is_adapter_client_disconnected_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::is_adapter_client_disconnected_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_client_disconnect_watcher_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_client_disconnect_watcher_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_client_disconnected_error_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_client_disconnected_error_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_timeout_error_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_timeout_error_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_state_load_failed_error_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_state_load_failed_error_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_required_response_hook_empty_error_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_required_response_hook_empty_error_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_stop_message_fetch_failed_error_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_stop_message_fetch_failed_error_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn read_client_inject_only_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::read_client_inject_only_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn normalize_client_inject_text_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::normalize_client_inject_text_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn compact_followup_error_reason_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::compact_followup_error_reason_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_adapter_context_provider_key_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::resolve_adapter_context_provider_key_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn build_client_exec_cli_projection_output_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::build_client_exec_cli_projection_output_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn parse_servertool_cli_projection_tool_arguments_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::parse_servertool_cli_projection_tool_arguments_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn build_servertool_cli_projection_runtime_branch_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::build_servertool_cli_projection_runtime_branch_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_stopless_orchestration_action_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_stopless_orchestration_action_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi(js_name = "normalizeStoplessTriggerHintForMetadataJson")]
pub fn normalize_stopless_trigger_hint_for_metadata_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::normalize_stopless_trigger_hint_for_metadata_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_stopless_learned_note_write_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_stopless_learned_note_write_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn validate_servertool_hook_skeleton_phase_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::validate_servertool_hook_skeleton_phase_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_servertool_hook_schedule_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_hook_schedule_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn build_client_visible_projection_shell_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::build_client_visible_projection_shell_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn build_servertool_cli_projection_execution_context_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::build_servertool_cli_projection_execution_context_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn build_servertool_handler_error_tool_output_payload_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::build_servertool_handler_error_tool_output_payload_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn collect_servertool_additional_client_tool_calls_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::collect_servertool_additional_client_tool_calls_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn is_servertool_client_exec_cli_projection_tool_call_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::is_servertool_client_exec_cli_projection_tool_call_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn validate_client_exec_command_result_json(raw_output: String) -> NapiResult<String> {
    servertool_core_blocks::validate_client_exec_command_result_json(&raw_output)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn has_stop_message_auto_cli_result_in_request_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::has_stop_message_auto_cli_result_in_request_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn extract_servertool_cli_result_route_hint_from_request_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::extract_servertool_cli_result_route_hint_from_request_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn extract_stop_message_auto_cli_result_snapshot_from_request_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::extract_stop_message_auto_cli_result_snapshot_from_request_json(
        &input_json,
    )
    .map_err(|e| napi::Error::from_reason(e))
}

// ── stopless_auto_handler_bridge NAPI functions ───────────────────────────────

/// Plan stopless auto handler — Rust-native entry point replacing TS round-trip.
/// Input: StopMessageAutoHandlerInput JSON. Output: StopMessageAutoHandlerPlan JSON.
#[napi(js_name = "planStoplessAutoHandlerJson")]
pub fn plan_stopless_auto_handler_json_bridge(input_json: String) -> NapiResult<String> {
    stopless_auto_handler_bridge::plan_stopless_auto_handler_json(input_json)
}

/// Build stopless auto handler input — Rust-native.
/// Replaces TS-side stopless handler input assembly and loop-state normalization.
#[napi(js_name = "buildStoplessAutoHandlerInputJson")]
pub fn build_stopless_auto_handler_input_json_bridge(input_json: String) -> NapiResult<String> {
    stopless_auto_handler_bridge::build_stopless_auto_handler_input_json(input_json)
}

/// Run complete stopless auto handler runtime — Rust-native.
/// Replaces TS handler input assembly + plan interpretation + learned-note trigger.
#[napi(js_name = "runStoplessAutoHandlerRuntimeJson")]
pub fn run_stopless_auto_handler_runtime_json_bridge(input_json: String) -> NapiResult<String> {
    stopless_auto_handler_bridge::run_stopless_auto_handler_runtime_json(input_json)
}

/// Run complete stopless builtin handler runtime and return final handler result.
/// TS builtin catalog may only consume this materialized output, not interpret
/// stopless runtime actions locally.
#[napi(js_name = "runStoplessBuiltinHandlerForRuntimeJson")]
pub fn run_stopless_builtin_handler_for_runtime_json_bridge(
    input_json: String,
) -> NapiResult<String> {
    stopless_auto_handler_bridge::run_stopless_builtin_handler_for_runtime_json(input_json)
}

/// Build complete stopless auto CLI projection — Rust-native.
/// Replaces TS `buildServertoolCliProjectionForAutoFlow` + three Native calls.
#[napi(js_name = "buildStoplessAutoCliProjectionJson")]
pub fn build_stopless_auto_cli_projection_json_bridge(input_json: String) -> NapiResult<String> {
    stopless_auto_handler_bridge::build_stopless_auto_cli_projection_json(input_json)
}

/// Write stopless learned note — Rust-native file I/O.
/// Replaces TS `writeStoplessLearnedNoteEntry` from cache-writer.ts.
#[napi(js_name = "writeStoplessLearnedNoteJson")]
pub fn write_stopless_learned_note_json_bridge(input_json: String) -> NapiResult<String> {
    stopless_auto_handler_bridge::write_stopless_learned_note_json(input_json)
}

#[napi]
pub fn extract_servertool_text_from_chat_like_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::extract_text_from_chat_like_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn extract_current_assistant_stop_text_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::extract_current_assistant_stop_text_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn extract_current_assistant_reasoning_stop_arguments_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::extract_current_assistant_reasoning_stop_arguments_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn strip_stop_schema_control_text_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::strip_stop_schema_control_text_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn build_stop_message_terminal_visible_payload_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::build_stop_message_terminal_visible_payload_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn inject_mcp_tools_for_chat_json(
    tools_json: String,
    discovered_servers_json: String,
) -> NapiResult<String> {
    let tools: Value =
        serde_json::from_str(&tools_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let discovered: Vec<String> = serde_json::from_str(&discovered_servers_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = shared_mcp_injection::inject_mcp_tools(&tools, &discovered, "chat");
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn inject_mcp_tools_for_responses_json(
    tools_json: String,
    discovered_servers_json: String,
) -> NapiResult<String> {
    let tools: Value =
        serde_json::from_str(&tools_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let discovered: Vec<String> = serde_json::from_str(&discovered_servers_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = shared_mcp_injection::inject_mcp_tools(&tools, &discovered, "responses");
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn extract_tool_calls_from_reasoning_text_json(
    text: String,
    id_prefix: Option<String>,
) -> NapiResult<String> {
    hub_reasoning_tool_normalizer::extract_tool_calls_from_reasoning_text_json(text, id_prefix)
}

#[napi(js_name = "applyRequestRulesJson")]
pub fn apply_request_rules_json(
    payload_json: String,
    config_json: Option<String>,
) -> NapiResult<String> {
    shared_response_compat::apply_request_rules_json(payload_json, config_json)
}

#[napi(js_name = "applyResponseBlacklistJson")]
pub fn apply_response_blacklist_json(
    payload_json: String,
    config_json: Option<String>,
) -> NapiResult<String> {
    shared_response_compat::apply_response_blacklist_json(payload_json, config_json)
}

#[napi(js_name = "normalizeResponsePayloadJson")]
pub fn normalize_response_payload_json(
    payload_json: String,
    config_json: Option<String>,
) -> NapiResult<String> {
    shared_response_compat::normalize_response_payload_json(payload_json, config_json)
}

#[napi(js_name = "validateResponsePayloadJson")]
pub fn validate_response_payload_json(payload_json: String) -> NapiResult<String> {
    shared_response_compat::validate_response_payload_json(payload_json)
}

#[napi]
pub fn normalizeAssistantTextToToolCallsJson(
    message_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    let message: Value = serde_json::from_str(&message_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse message JSON: {}", e)))?;
    if !message.is_object() {
        return serde_json::to_string(&message)
            .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)));
    }
    crate::hub_reasoning_tool_normalizer::normalize_assistant_text_to_tool_calls_json(
        message_json,
        options_json,
    )
}

#[napi]
pub fn normalizeChatMessageContentJson(content_json: String) -> NapiResult<String> {
    shared_chat_output_normalizer::normalize_chat_message_content_json(content_json)
}

#[napi(js_name = "normalizeResponsesMessageItemJson")]
pub fn normalize_responses_message_item_json(
    item_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    shared_output_content_normalizer::normalize_responses_message_item_json(item_json, options_json)
}

#[napi(js_name = "expandResponsesMessageItemJson")]
pub fn expand_responses_message_item_json(
    item_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    shared_output_content_normalizer::expand_responses_message_item_json(item_json, options_json)
}

#[napi(js_name = "normalizeResponsesOutputItemsJson")]
pub fn normalize_responses_output_items_json(output_json: String) -> NapiResult<String> {
    shared_output_content_normalizer::normalize_responses_output_items_json(output_json)
}

#[napi]
pub fn normalizeChatResponseReasoningToolsJson(
    response_json: String,
    id_prefix: Option<String>,
) -> NapiResult<String> {
    hub_reasoning_tool_normalizer::normalize_chat_response_reasoning_tools_json(
        response_json,
        id_prefix,
    )
}

#[napi(js_name = "canonicalizeResponsesSseEventPayloadJson")]
pub fn canonicalize_responses_sse_event_payload_json(event_json: String) -> NapiResult<String> {
    responses_sse_event_payload::canonicalize_responses_sse_event_payload_json(event_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "serializeResponsesSseEventToWireJson")]
pub fn serialize_responses_sse_event_to_wire_json(event_json: String) -> NapiResult<String> {
    responses_sse_event_payload::serialize_responses_sse_event_to_wire_json(event_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "deserializeResponsesSseEventFromWireJson")]
pub fn deserialize_responses_sse_event_from_wire_json(
    wire_data_json: String,
) -> NapiResult<String> {
    responses_sse_event_payload::deserialize_responses_sse_event_from_wire_json(wire_data_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "validateResponsesSseWireFormatJson")]
pub fn validate_responses_sse_wire_format_json(wire_data_json: String) -> NapiResult<String> {
    responses_sse_event_payload::validate_responses_sse_wire_format_json(wire_data_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "normalizeResponsesSseResponsePayloadJson")]
pub fn normalize_responses_sse_response_payload_json(
    response_json: String,
    status_json: Option<String>,
) -> NapiResult<String> {
    responses_sse_event_payload::normalize_responses_sse_response_payload_json(
        response_json,
        status_json,
    )
    .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseResponseEventPayloadJson")]
pub fn build_responses_sse_response_event_payload_json(
    payload_json: String,
    lifecycle_json: Option<String>,
) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_response_event_payload_json(
        payload_json,
        lifecycle_json,
    )
    .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseTextChunksJson")]
pub fn build_responses_sse_text_chunks_json(payload_json: String) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_text_chunks_json(payload_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "normalizeResponsesSseReasoningSummaryJson")]
pub fn normalize_responses_sse_reasoning_summary_json(summary_json: String) -> NapiResult<String> {
    responses_sse_event_payload::normalize_responses_sse_reasoning_summary_json(summary_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseOutputItemDescriptorJson")]
pub fn build_responses_sse_output_item_descriptor_json(
    output_item_json: String,
    lifecycle_json: Option<String>,
) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_output_item_descriptor_json(
        output_item_json,
        lifecycle_json,
    )
    .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseContentPartDescriptorJson")]
pub fn build_responses_sse_content_part_descriptor_json(
    content_part_json: String,
    lifecycle_json: Option<String>,
) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_content_part_descriptor_json(
        content_part_json,
        lifecycle_json,
    )
    .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseOutputItemEventPayloadJson")]
pub fn build_responses_sse_output_item_event_payload_json(
    payload_json: String,
    lifecycle_json: Option<String>,
) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_output_item_event_payload_json(
        payload_json,
        lifecycle_json,
    )
    .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseContentPartEventPayloadJson")]
pub fn build_responses_sse_content_part_event_payload_json(
    payload_json: String,
    lifecycle_json: Option<String>,
) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_content_part_event_payload_json(
        payload_json,
        lifecycle_json,
    )
    .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseOutputTextDonePayloadJson")]
pub fn build_responses_sse_output_text_done_payload_json(
    payload_json: String,
) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_output_text_done_payload_json(payload_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseOutputTextDeltaPayloadJson")]
pub fn build_responses_sse_output_text_delta_payload_json(
    payload_json: String,
) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_output_text_delta_payload_json(payload_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseFunctionCallArgumentsDeltaPayloadJson")]
pub fn build_responses_sse_function_call_arguments_delta_payload_json(
    payload_json: String,
) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_function_call_arguments_delta_payload_json(
        payload_json,
    )
    .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseFunctionCallArgumentsDonePayloadJson")]
pub fn build_responses_sse_function_call_arguments_done_payload_json(
    payload_json: String,
) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_function_call_arguments_done_payload_json(
        payload_json,
    )
    .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseReasoningSummaryPayloadJson")]
pub fn build_responses_sse_reasoning_summary_payload_json(
    payload_json: String,
    lifecycle_json: Option<String>,
) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_reasoning_summary_payload_json(
        payload_json,
        lifecycle_json,
    )
    .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseReasoningLifecyclePayloadJson")]
pub fn build_responses_sse_reasoning_lifecycle_payload_json(
    payload_json: String,
    lifecycle_json: Option<String>,
) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_reasoning_lifecycle_payload_json(
        payload_json,
        lifecycle_json,
    )
    .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseReasoningDeltaPayloadJson")]
pub fn build_responses_sse_reasoning_delta_payload_json(
    payload_json: String,
    lifecycle_json: Option<String>,
) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_reasoning_delta_payload_json(
        payload_json,
        lifecycle_json,
    )
    .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseEventSequenceJson")]
pub fn build_responses_sse_event_sequence_json(input_json: String) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_event_sequence_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildSseFramesFromJsonJson")]
pub fn build_sse_frames_from_json_json_bridge(input_json: String) -> NapiResult<String> {
    sse_runtime_dispatch::build_sse_frames_from_json_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "ResponsesSseStreamJson")]
pub fn build_responses_sse_stream_json_bridge(input_json: String) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_stream_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "ResponsesSseStreamFramesJson")]
pub fn build_responses_sse_stream_frames_json_bridge(input_json: String) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_stream_frames_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildResponsesSseEventEnvelopeJson")]
pub fn build_responses_sse_event_envelope_json(input_json: String) -> NapiResult<String> {
    responses_sse_event_payload::build_responses_sse_event_envelope_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildChatSseEventEnvelopeJson")]
pub fn build_chat_sse_event_envelope_json(input_json: String) -> NapiResult<String> {
    chat_sse_event_payload::build_chat_sse_event_envelope_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildChatSseErrorPayloadJson")]
pub fn build_chat_sse_error_payload_json(input_json: String) -> NapiResult<String> {
    chat_sse_event_payload::build_chat_sse_error_payload_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildChatSseRoleDeltaPayloadJson")]
pub fn build_chat_sse_role_delta_payload_json(input_json: String) -> NapiResult<String> {
    chat_sse_event_payload::build_chat_sse_role_delta_payload_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildChatSseContentDeltaPayloadJson")]
pub fn build_chat_sse_content_delta_payload_json(input_json: String) -> NapiResult<String> {
    chat_sse_event_payload::build_chat_sse_content_delta_payload_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildChatSseReasoningDeltaPayloadJson")]
pub fn build_chat_sse_reasoning_delta_payload_json(input_json: String) -> NapiResult<String> {
    chat_sse_event_payload::build_chat_sse_reasoning_delta_payload_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildChatSseToolCallArgsDeltaPayloadJson")]
pub fn build_chat_sse_tool_call_args_delta_payload_json(input_json: String) -> NapiResult<String> {
    chat_sse_event_payload::build_chat_sse_tool_call_args_delta_payload_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildChatSseToolCallStartPayloadJson")]
pub fn build_chat_sse_tool_call_start_payload_json(input_json: String) -> NapiResult<String> {
    chat_sse_event_payload::build_chat_sse_tool_call_start_payload_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildChatSseFinishPayloadJson")]
pub fn build_chat_sse_finish_payload_json(input_json: String) -> NapiResult<String> {
    chat_sse_event_payload::build_chat_sse_finish_payload_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildChatSseEventSequenceJson")]
pub fn build_chat_sse_event_sequence_json(input_json: String) -> NapiResult<String> {
    chat_sse_event_payload::build_chat_sse_event_sequence_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildChatSseStreamJson")]
pub fn build_chat_sse_stream_json_bridge(input_json: String) -> NapiResult<String> {
    chat_sse_event_payload::build_chat_sse_stream_json(input_json).map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildChatSseStreamFramesJson")]
pub fn build_chat_sse_stream_frames_json_bridge(input_json: String) -> NapiResult<String> {
    chat_sse_event_payload::build_chat_sse_stream_frames_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildChatJsonFromSseJson")]
pub fn build_chat_json_from_sse_json(input_json: String) -> NapiResult<String> {
    chat_sse_event_payload::build_chat_json_from_sse_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildGeminiSseEventSequenceJson")]
pub fn napi_build_gemini_sse_event_sequence_json(input_json: String) -> NapiResult<String> {
    gemini_sse_event_payload::build_gemini_sse_event_sequence_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "GeminiSseStreamJson")]
pub fn build_gemini_sse_stream_json_bridge(input_json: String) -> NapiResult<String> {
    gemini_sse_event_payload::build_gemini_sse_stream_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "GeminiSseStreamFramesJson")]
pub fn build_gemini_sse_stream_frames_json_bridge(input_json: String) -> NapiResult<String> {
    gemini_sse_event_payload::build_gemini_sse_stream_frames_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildGeminiJsonFromSseJson")]
pub fn napi_build_gemini_json_from_sse_json(input_json: String) -> NapiResult<String> {
    gemini_sse_event_payload::build_gemini_json_from_sse_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildAnthropicSseEventSequenceJson")]
pub fn napi_build_anthropic_sse_event_sequence_json(input_json: String) -> NapiResult<String> {
    anthropic_sse_event_payload::build_anthropic_sse_event_sequence_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "AnthropicSseStreamJson")]
pub fn build_anthropic_sse_stream_json_bridge(input_json: String) -> NapiResult<String> {
    anthropic_sse_event_payload::build_anthropic_sse_stream_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "AnthropicSseStreamFramesJson")]
pub fn build_anthropic_sse_stream_frames_json_bridge(input_json: String) -> NapiResult<String> {
    anthropic_sse_event_payload::build_anthropic_sse_stream_frames_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "buildAnthropicJsonFromSseJson")]
pub fn napi_build_anthropic_json_from_sse_json(input_json: String) -> NapiResult<String> {
    anthropic_sse_event_payload::build_anthropic_json_from_sse_json(input_json)
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "hasRequestedToolsInSemanticsJson")]
pub fn has_requested_tools_in_semantics_json_bridge(
    request_semantics_json: String,
) -> NapiResult<bool> {
    chat_node_result_semantics::has_requested_tools_in_semantics_json(request_semantics_json)
}

#[napi(js_name = "isRequiredToolCallTurnJson")]
pub fn is_required_tool_call_turn_json_bridge(request_semantics_json: String) -> NapiResult<bool> {
    chat_node_result_semantics::is_required_tool_call_turn_json(request_semantics_json)
}

#[napi(js_name = "isToolResultFollowupTurnJson")]
pub fn is_tool_result_followup_turn_json_bridge(
    request_semantics_json: String,
) -> NapiResult<bool> {
    chat_node_result_semantics::is_tool_result_followup_turn_json(request_semantics_json)
}

#[napi(js_name = "detectRetryableEmptyAssistantResponseJson")]
pub fn detect_retryable_empty_assistant_response_json_bridge(
    body_json: String,
    request_semantics_json: String,
) -> NapiResult<String> {
    chat_node_result_semantics::detect_retryable_empty_assistant_response_json(
        body_json,
        request_semantics_json,
    )
}

#[napi(js_name = "deriveFinishReasonJson")]
pub fn derive_finish_reason_json_bridge(body_json: String) -> NapiResult<String> {
    chat_node_result_semantics::derive_finish_reason_json(body_json)
}

#[napi(js_name = "isToolCallContinuationResponseJson")]
pub fn is_tool_call_continuation_response_json_bridge(body_json: String) -> NapiResult<bool> {
    chat_node_result_semantics::is_tool_call_continuation_response_json(body_json)
}

#[napi(js_name = "isProviderNativeResumeContinuationJson")]
pub fn is_provider_native_resume_continuation_json_bridge(
    request_semantics_json: String,
) -> NapiResult<bool> {
    chat_node_result_semantics::is_provider_native_resume_continuation_json(request_semantics_json)
}

#[napi(js_name = "isEmptyClientResponsePayloadJson")]
pub fn is_empty_client_response_payload_json_bridge(body_json: String) -> NapiResult<bool> {
    chat_node_result_semantics::is_empty_client_response_payload_json(body_json)
}

#[napi(js_name = "classifyEmptyResponseSignalJson")]
pub fn classify_empty_response_signal_json_bridge(
    stage: String,
    body_json: String,
) -> NapiResult<String> {
    chat_node_result_semantics::classify_empty_response_signal_json(stage, body_json)
}

#[napi(js_name = "detectToolExecutionFailuresJson")]
pub fn detect_tool_execution_failures_json_bridge(payload_json: String) -> NapiResult<String> {
    snapshot_tool_failures::detect_tool_execution_failures_json(payload_json)
}

#[napi(js_name = "classifyRuntimeErrorSignalFromTextJson")]
pub fn classify_runtime_error_signal_from_text_json_bridge(
    stage: String,
    message: String,
) -> NapiResult<String> {
    snapshot_tool_failures::classify_runtime_error_signal_from_text_json(stage, message)
}

#[napi(js_name = "classifyRuntimeErrorSignalJson")]
pub fn classify_runtime_error_signal_json_bridge(
    stage: String,
    payload_json: String,
) -> NapiResult<String> {
    snapshot_tool_failures::classify_runtime_error_signal_json(stage, payload_json)
}

#[napi(js_name = "shouldLogClientToolErrorToConsoleJson")]
pub fn should_log_client_tool_error_to_console_json_bridge(
    failure_json: String,
) -> NapiResult<bool> {
    snapshot_tool_failures::should_log_client_tool_error_to_console_json(failure_json)
}

#[napi(js_name = "shouldInspectRuntimeErrorJson")]
pub fn should_inspect_runtime_error_json_bridge(
    stage: String,
    payload_json: String,
) -> NapiResult<bool> {
    snapshot_tool_failures::should_inspect_runtime_error_json(stage, payload_json)
}

#[napi(js_name = "summarizeClientToolObservationJson")]
pub fn summarize_client_tool_observation_json_bridge(
    payload_json: String,
    failures_json: String,
) -> NapiResult<String> {
    snapshot_tool_failures::summarize_client_tool_observation_json(payload_json, failures_json)
}

#[napi(js_name = "normalizeToolCallIdsJson")]
pub fn normalize_tool_call_ids_json(payload_json: String) -> NapiResult<String> {
    shared_response_compat::normalize_tool_call_ids_json(payload_json)
}

#[napi(js_name = "applyUniversalShapeRequestFilterJson")]
pub fn apply_universal_shape_request_filter_json(
    payload_json: String,
    config_json: Option<String>,
) -> NapiResult<String> {
    req_outbound_stage3_compat::universal_shape_filter::apply_universal_shape_request_filter_json(
        payload_json,
        config_json,
    )
}

#[napi(js_name = "applyGeminiWebSearchRequestCompatJson")]
pub fn apply_gemini_web_search_request_compat_json(
    payload_json: String,
    adapter_context_json: Option<String>,
) -> NapiResult<String> {
    req_outbound_stage3_compat::gemini::apply_gemini_web_search_request_compat_json(
        payload_json,
        adapter_context_json,
    )
}

#[napi(js_name = "applyToolTextRequestGuidanceJson")]
pub fn apply_tool_text_request_guidance_json(
    payload_json: String,
    config_json: Option<String>,
) -> NapiResult<String> {
    req_outbound_stage3_compat::apply_tool_text_request_guidance_json(payload_json, config_json)
}

#[napi(js_name = "buildSystemToolGuidanceJson")]
pub fn build_system_tool_guidance_json() -> NapiResult<String> {
    req_outbound_stage3_compat::build_system_tool_guidance_json()
}

#[napi(js_name = "augmentOpenAIToolsJson")]
pub fn augment_openai_tools_json(tools_json: String) -> NapiResult<String> {
    req_outbound_stage3_compat::augment_openai_tools_json(tools_json)
}

#[napi(js_name = "augmentAnthropicToolsJson")]
pub fn augment_anthropic_tools_json(tools_json: String) -> NapiResult<String> {
    req_outbound_stage3_compat::augment_anthropic_tools_json(tools_json)
}

#[napi(js_name = "harvestToolCallsFromTextJson")]
pub fn harvest_tool_calls_from_text_json_bridge(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    compat_harvest_tool_calls_from_text::harvest_tool_calls_from_text_json(
        payload_json,
        options_json,
    )
}

#[napi(js_name = "normalizeServertoolFollowupPayloadShapeJson")]
pub fn normalize_servertool_followup_payload_shape_json_bridge(
    entry_endpoint: String,
    payload_json: String,
) -> NapiResult<String> {
    hub_submit_tool_outputs::normalize_servertool_followup_payload_shape_json(
        entry_endpoint,
        payload_json,
    )
}

#[napi(js_name = "applyFieldMappingsJson")]
pub fn apply_field_mappings_json_bridge(
    payload_json: String,
    mappings_json: String,
) -> NapiResult<String> {
    compat_field_mapping::apply_field_mappings_json(payload_json, mappings_json)
}

#[napi(js_name = "sanitizeToolSchemaGlmShellJson")]
pub fn sanitize_tool_schema_glm_shell_json_bridge(payload_json: String) -> NapiResult<String> {
    compat_tool_schema::sanitize_tool_schema_glm_shell_json(payload_json)
}

#[napi(js_name = "applyUniversalShapeResponseFilterJson")]
pub fn apply_universal_shape_response_filter_json(
    payload_json: String,
    config_json: Option<String>,
    adapter_context_json: Option<String>,
) -> NapiResult<String> {
    req_outbound_stage3_compat::universal_shape_filter::apply_universal_shape_response_filter_json(
        payload_json,
        config_json,
        adapter_context_json,
    )
}

#[napi(js_name = "normalizeResponsesToolCallIdsJson")]
pub fn normalize_responses_tool_call_ids_json(payload_json: String) -> NapiResult<String> {
    shared_responses_tool_utils::normalize_responses_tool_call_ids_json(payload_json)
}

#[napi(js_name = "resolveToolCallIdStyleJson")]
pub fn resolve_tool_call_id_style_json(metadata_json: String) -> NapiResult<String> {
    shared_responses_tool_utils::resolve_tool_call_id_style_json(metadata_json)
}

#[napi(js_name = "stripInternalToolingMetadataJson")]
pub fn strip_internal_tooling_metadata_json(metadata_json: String) -> NapiResult<String> {
    shared_responses_tool_utils::strip_internal_tooling_metadata_json(metadata_json)
}

#[napi(js_name = "enforceLmstudioResponsesFcToolCallIdsJson")]
pub fn enforce_lmstudio_responses_fc_tool_call_ids_json(
    payload_json: String,
) -> NapiResult<String> {
    shared_response_compat::enforce_lmstudio_responses_fc_tool_call_ids_json(payload_json)
}

#[napi(js_name = "runOpenaiOpenaiRequestCodecJson")]
pub fn run_openai_openai_request_codec_json_bridge(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    openai_openai_codec::run_openai_openai_request_codec_json(payload_json, options_json)
}

#[napi(js_name = "runOpenaiOpenaiResponseCodecJson")]
pub fn run_openai_openai_response_codec_json_bridge(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    openai_openai_codec::run_openai_openai_response_codec_json(payload_json, options_json)
}

#[napi(js_name = "runResponsesOpenaiRequestCodecJson")]
pub fn run_responses_openai_request_codec_json_bridge(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    responses_openai_codec::run_responses_openai_request_codec_json(payload_json, options_json)
}

#[napi(js_name = "runResponsesOpenaiResponseCodecJson")]
pub fn run_responses_openai_response_codec_json_bridge(
    payload_json: String,
    context_json: String,
) -> NapiResult<String> {
    responses_openai_codec::run_responses_openai_response_codec_json(payload_json, context_json)
}

#[napi(js_name = "runGeminiOpenaiRequestCodecJson")]
pub fn run_gemini_openai_request_codec_json_bridge(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    gemini_openai_codec::run_gemini_openai_request_codec_json(payload_json, options_json)
}

#[napi(js_name = "runGeminiOpenaiResponseCodecJson")]
pub fn run_gemini_openai_response_codec_json_bridge(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    gemini_openai_codec::run_gemini_openai_response_codec_json(payload_json, options_json)
}

#[napi(js_name = "runGeminiFromOpenaiChatCodecJson")]
pub fn run_gemini_from_openai_chat_codec_json_bridge(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    gemini_openai_codec::run_gemini_from_openai_chat_codec_json(payload_json, options_json)
}

#[napi(js_name = "bootstrapVirtualRouterConfigJson")]
pub fn bootstrap_virtual_router_config_json_bridge(input_json: String) -> NapiResult<String> {
    virtual_router_engine::bootstrap::bootstrap_virtual_router_config_json(input_json)
}

#[napi(js_name = "bootstrapVirtualRouterProvidersJson")]
pub fn bootstrap_virtual_router_providers_json_bridge(
    providers_json: String,
) -> NapiResult<String> {
    virtual_router_engine::provider_bootstrap::bootstrap_virtual_router_providers_json(
        providers_json,
    )
}

#[napi(js_name = "compileRouteCodexRuntimeManifestJson")]
pub fn compile_routecodex_runtime_manifest_json_bridge(input_json: String) -> NapiResult<String> {
    virtual_router_engine::runtime_config_materialization::compile_routecodex_runtime_manifest_json(
        input_json,
    )
}

#[napi(js_name = "collectRouteCodexV2ConfigSourceErrorsJson")]
pub fn collect_routecodex_v2_config_source_errors_json_bridge(
    input_json: String,
) -> NapiResult<String> {
    virtual_router_engine::runtime_config_materialization::collect_v2_config_source_errors_json(
        input_json,
    )
}

#[napi(js_name = "normalizeRouteCodexV2RuntimeSourceJson")]
pub fn normalize_routecodex_v2_runtime_source_json_bridge(
    input_json: String,
) -> NapiResult<String> {
    virtual_router_engine::runtime_config_materialization::normalize_routecodex_v2_runtime_source_json(
        input_json,
    )
}

#[napi(js_name = "resolvePrimaryRouteCodexRoutingPolicyGroupJson")]
pub fn resolve_primary_routecodex_routing_policy_group_json_bridge(
    input_json: String,
) -> NapiResult<String> {
    virtual_router_engine::runtime_config_materialization::resolve_primary_routecodex_routing_policy_group_json(
        input_json,
    )
}

#[napi(js_name = "extractRouteCodexMaterializedProviderConfigsJson")]
pub fn extract_routecodex_materialized_provider_configs_json_bridge(
    input_json: String,
) -> NapiResult<String> {
    virtual_router_engine::runtime_config_materialization::extract_routecodex_materialized_provider_configs_json(
        input_json,
    )
}

#[napi(js_name = "materializeRouteCodexUserConfigFromManifestJson")]
pub fn materialize_routecodex_user_config_from_manifest_json_bridge(
    input_json: String,
) -> NapiResult<String> {
    virtual_router_engine::runtime_config_materialization::materialize_routecodex_user_config_from_manifest_json(
        input_json,
    )
}

#[napi(js_name = "buildRouteCodexProviderProfilesJson")]
pub fn build_routecodex_provider_profiles_json_bridge(input_json: String) -> NapiResult<String> {
    virtual_router_engine::runtime_config_materialization::build_routecodex_provider_profiles_json(
        input_json,
    )
}

#[napi(js_name = "buildRouteCodexForwarderProfilesJson")]
pub fn build_routecodex_forwarder_profiles_json_bridge(input_json: String) -> NapiResult<String> {
    virtual_router_engine::runtime_config_materialization::build_routecodex_forwarder_profiles_json(
        input_json,
    )
}

#[napi(js_name = "estimateVirtualRouterRequestTokensJson")]
pub fn estimate_virtual_router_request_tokens_json_bridge(
    input_json: String,
) -> NapiResult<String> {
    virtual_router_engine::features::estimate_request_tokens_payload_json(input_json)
}

#[napi(js_name = "isPreCommandScriptPathAllowedJson")]
pub fn is_pre_command_script_path_allowed_json_bridge(input_json: String) -> NapiResult<String> {
    let input: PreCommandScriptAllowedInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let allowed = virtual_router_engine::instructions::with_rcc_user_dir_override(
        input.rcc_user_dir.as_deref(),
        || virtual_router_engine::instructions::is_precommand_script_path_allowed(&input.path),
    )
    .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&serde_json::json!({ "allowed": allowed }))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "reportProviderErrorToRouterPolicyJson")]
pub fn report_provider_error_to_router_policy_json_bridge(
    event_json: String,
) -> NapiResult<String> {
    let event_value: Value =
        serde_json::from_str(&event_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let normalized =
        virtual_router_engine::provider_runtime_ingress::report_provider_error(&event_value);
    serde_json::to_string(&normalized).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "reportProviderSuccessToRouterPolicyJson")]
pub fn report_provider_success_to_router_policy_json_bridge(
    event_json: String,
) -> NapiResult<String> {
    let event_value: Value =
        serde_json::from_str(&event_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let normalized =
        virtual_router_engine::provider_runtime_ingress::report_provider_success(&event_value);
    serde_json::to_string(&normalized).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "resetProviderRuntimeIngressForTestsJson")]

pub fn reset_provider_runtime_ingress_for_tests_json_bridge() -> NapiResult<String> {
    virtual_router_engine::provider_runtime_ingress::reset_for_tests();
    Ok("true".to_string())
}

#[napi(js_name = "buildStopMessageMarkerParseLogJson")]
pub fn build_stop_message_marker_parse_log_json_bridge(
    request_json: String,
    metadata_json: String,
    parsed_kinds_json: String,
    stop_scope: Option<String>,
) -> napi::Result<String> {
    crate::virtual_router_engine::virtual_router_host_effects::build_stop_message_marker_parse_log_json(
        request_json,
        metadata_json,
        parsed_kinds_json,
        stop_scope,
    )
}

#[napi(js_name = "formatStopMessageStatusLabelJson")]
pub fn format_stop_message_status_label_json_bridge(
    snapshot_json: Option<String>,
    scope: Option<String>,
    force_show: bool,
) -> napi::Result<String> {
    crate::virtual_router_engine::virtual_router_host_effects::format_stop_message_status_label_json(
        snapshot_json,
        scope,
        force_show,
    )
}

#[napi(js_name = "emitStopMessageMarkerParseLogJson")]
pub fn emit_stop_message_marker_parse_log_json_bridge(
    log_json: Option<String>,
) -> napi::Result<()> {
    crate::virtual_router_engine::virtual_router_host_effects::emit_stop_message_marker_parse_log_json(log_json)
}

#[napi(js_name = "cleanStopMessageMarkersInPlaceJson")]
pub fn clean_stop_message_markers_in_place_json_bridge(
    request_json: String,
) -> napi::Result<String> {
    crate::virtual_router_engine::virtual_router_host_effects::clean_stop_message_markers_in_place_json(request_json)
}

#[napi(js_name = "planVirtualRouterRouteHostEffectsJson")]
pub fn plan_virtual_router_route_host_effects_json_bridge(
    request_json: String,
    metadata_json: String,
    rcc_user_dir: Option<String>,
) -> napi::Result<String> {
    crate::virtual_router_engine::virtual_router_host_effects::plan_virtual_router_route_host_effects_json(
        request_json,
        metadata_json,
        rcc_user_dir,
    )
}

#[napi(js_name = "finalizeVirtualRouterRouteHostEffectsJson")]
pub fn finalize_virtual_router_route_host_effects_json_bridge(
    input_json: String,
) -> napi::Result<String> {
    crate::virtual_router_engine::virtual_router_host_effects::finalize_virtual_router_route_host_effects_json(input_json)
}

#[napi(js_name = "createVirtualRouterHitRecordJson")]
pub fn create_virtual_router_hit_record_json_bridge(input_json: String) -> napi::Result<String> {
    crate::virtual_router_hit_log::create_virtual_router_hit_record_json(input_json)
}

#[napi(js_name = "formatVirtualRouterHitJson")]
pub fn format_virtual_router_hit_json_bridge(
    record_json: String,
    config_json: Option<String>,
) -> napi::Result<String> {
    crate::virtual_router_hit_log::format_virtual_router_hit_json(record_json, config_json)
}

#[napi(js_name = "formatContinuationScopeJson")]
pub fn format_continuation_scope_json_bridge(scope: Option<String>) -> napi::Result<String> {
    crate::virtual_router_hit_log::format_continuation_scope_json(scope)
}

#[napi(js_name = "parseVirtualRouterHitProviderKeyJson")]
pub fn parse_virtual_router_hit_provider_key_json_bridge(
    provider_key: String,
) -> napi::Result<String> {
    crate::virtual_router_hit_log::parse_virtual_router_hit_provider_key_json(provider_key)
}

#[napi(js_name = "resolveSessionLogColorKeyJson")]
pub fn resolve_session_log_color_key_json_bridge(input_json: String) -> napi::Result<String> {
    crate::virtual_router_hit_log::resolve_session_log_color_key_json(input_json)
}

#[napi(js_name = "describeTargetProviderJson")]
pub fn describe_target_provider_json_bridge(
    provider_key: String,
    fallback_model_id: Option<String>,
) -> napi::Result<String> {
    crate::virtual_router_hit_log::describe_target_provider_json(provider_key, fallback_model_id)
}

#[napi(js_name = "resolveRouteColorStr")]
pub fn resolve_route_color_str_bridge(route_name: String) -> String {
    crate::virtual_router_hit_log::resolve_route_color_str(route_name)
}

#[napi(js_name = "resolveSessionColorStr")]
pub fn resolve_session_color_str_bridge(session_id: Option<String>) -> napi::Result<String> {
    crate::virtual_router_hit_log::resolve_session_color_str(session_id)
}

#[napi(js_name = "buildHitReasonJson")]
pub fn build_hit_reason_json_bridge(
    route_used: String,
    provider_key: String,
    classification_reasoning: Option<String>,
    route_changed: bool,
    estimated_tokens: Option<f64>,
    last_assistant_tool_label: Option<String>,
    provider_max_context_tokens: Option<f64>,
    context_warn_ratio: Option<f64>,
) -> napi::Result<String> {
    crate::virtual_router_hit_log::build_hit_reason_json(
        route_used,
        provider_key,
        classification_reasoning,
        route_changed,
        estimated_tokens,
        last_assistant_tool_label,
        provider_max_context_tokens,
        context_warn_ratio,
    )
}

#[napi(js_name = "toVirtualRouterHitEventJson")]
pub fn to_virtual_router_hit_event_json_bridge(
    record_json: String,
    meta_json: String,
) -> napi::Result<String> {
    crate::virtual_router_hit_log::to_virtual_router_hit_event_json(record_json, meta_json)
}
#[napi(js_name = "classifyProviderFailureJson")]
pub fn classify_provider_failure_json(
    status_code: Option<u16>,
    error_code: Option<String>,
    upstream_code: Option<String>,
    is_network_error: bool,
) -> NapiResult<String> {
    let classification = failure_policy::classify_failure(
        status_code,
        error_code.as_deref(),
        upstream_code.as_deref(),
        is_network_error,
    );
    Ok(serde_json::to_string(&classification)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?)
}

#[napi(js_name = "networkErrorSetJson")]
pub fn network_error_set_json() -> NapiResult<String> {
    serde_json::to_string(&[
        "ECONNRESET",
        "ECONNREFUSED",
        "EHOSTUNREACH",
        "ENOTFOUND",
        "EAI_AGAIN",
        "EPIPE",
        "ETIMEDOUT",
        "ECONNABORTED",
    ])
    .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "isProviderFailureBlockingRecoverableJson")]
pub fn is_provider_failure_blocking_recoverable_json(
    classification_json: String,
    stage: Option<String>,
) -> NapiResult<bool> {
    let classification: failure_policy::FailureClassification =
        serde_json::from_str(&classification_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(failure_policy::is_blocking_recoverable(
        classification,
        stage.as_deref(),
    ))
}

#[napi(js_name = "shouldRetryProviderFailureJson")]
pub fn should_retry_provider_failure_json(
    classification_json: String,
    attempt: u32,
    max_attempts: u32,
) -> NapiResult<bool> {
    let classification: failure_policy::FailureClassification =
        serde_json::from_str(&classification_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(failure_policy::should_retry(
        classification,
        attempt,
        max_attempts,
    ))
}

#[napi(js_name = "computeProviderBackoffMsJson")]
pub fn compute_provider_backoff_ms_json(
    classification_json: String,
    attempt: u32,
) -> NapiResult<i64> {
    let classification: failure_policy::FailureClassification =
        serde_json::from_str(&classification_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(failure_policy::compute_backoff(classification, attempt) as i64)
}

#[napi(js_name = "resolveProviderRetryExecutionPolicyJson")]
pub fn resolve_provider_retry_execution_policy_json(input_json: String) -> NapiResult<String> {
    let input: failure_policy::ProviderRetryExecutionPolicyInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let decision = failure_policy::resolve_retry_execution_policy(input);
    serde_json::to_string(&decision).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub use responses_reasoning_registry::{
    consume_responses_passthrough_by_aliases_json, consume_responses_passthrough_json,
    consume_responses_payload_snapshot_by_aliases_json, consume_responses_payload_snapshot_json,
    register_responses_passthrough_json, register_responses_payload_snapshot_json,
};
pub use shared_responses_conversation_utils::{
    materialize_provider_owned_submit_context_json, plan_responses_captured_entry_json,
    plan_responses_continuation_request_action_json, plan_responses_conversation_preflight_json,
    plan_responses_handler_entry_json, plan_responses_record_continuation_flag_json,
    plan_responses_request_body_for_http_json, plan_responses_request_context_json,
    prepare_responses_conversation_entry_json, publish_responses_record_plan_json,
};

// ---------------------------------------------------------------------------
// failure_policy NAPI exports — Rust migration batch #2
// ---------------------------------------------------------------------------

#[napi]
pub fn is_context_length_exceeded_error_json(input_json: String) -> NapiResult<String> {
    failure_policy::is_context_length_exceeded_error_json(input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn is_rate_limit_like_error_json(input_json: String) -> NapiResult<String> {
    failure_policy::is_rate_limit_like_error_json(input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn is_retryable_network_sse_wrapper_error_json(input_json: String) -> NapiResult<String> {
    failure_policy::is_retryable_network_sse_wrapper_error_json(input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn is_client_disconnect_like_error_json(input_json: String) -> NapiResult<String> {
    failure_policy::is_client_disconnect_like_error_json(input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn is_generic_bridge_response_contract_error_json(input_json: String) -> NapiResult<String> {
    failure_policy::is_generic_bridge_response_contract_error_json(input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

// ---------------------------------------------------------------------------
// provider_response_tool_validation_blocks NAPI exports — batch #5
// ---------------------------------------------------------------------------

use provider_response_tool_validation_blocks::validation;

#[napi]
pub fn validate_canonical_client_tool_call_json(input_json: String) -> NapiResult<String> {
    validation::validate_canonical_client_tool_call_json(input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn contains_broad_kill_command_json(input_json: String) -> NapiResult<String> {
    validation::contains_broad_kill_command_json(input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn has_invalid_shell_wrapper_shape_json(input_json: String) -> NapiResult<String> {
    validation::has_invalid_shell_wrapper_shape_json(input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

// ---------------------------------------------------------------------------
// provider_response_shared_pure_blocks NAPI exports — Rust migration batch #3
// ---------------------------------------------------------------------------

use provider_response_shared_pure_blocks::payload_extraction;

#[napi]
pub fn as_flat_record_json(input_json: String) -> NapiResult<Option<String>> {
    let raw: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("parse input: {}", e)))?;
    let result = payload_extraction::as_flat_record(&raw);
    Ok(result.map(|m| serde_json::to_string(m).unwrap()))
}

#[napi]
pub fn extract_first_balanced_json_object_json(raw_string: String) -> NapiResult<Option<String>> {
    Ok(payload_extraction::extract_first_balanced_json_object(
        &raw_string,
    ))
}

#[napi]
pub fn try_parse_json_like_string_json(raw_string: String) -> NapiResult<Option<String>> {
    let result = payload_extraction::try_parse_json_like_string(&raw_string);
    Ok(result.map(|v| v.to_string()))
}

#[napi]
pub fn extract_content_text_for_stopless_scan_json(input_json: String) -> NapiResult<String> {
    let raw: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("parse input: {}", e)))?;
    Ok(payload_extraction::extract_content_text_for_stopless_scan(
        &raw,
    ))
}

#[napi]
pub fn extract_latest_user_text_for_stopless_scan_json(input_json: String) -> NapiResult<String> {
    let raw: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("parse input: {}", e)))?;
    Ok(payload_extraction::extract_latest_user_text_for_stopless_scan(&raw))
}

#[napi]
pub fn has_stopless_directive_in_request_payload_json(input_json: String) -> NapiResult<bool> {
    let raw: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("parse input: {}", e)))?;
    Ok(payload_extraction::has_stopless_directive_in_request_payload(&raw))
}

#[napi]
pub fn find_nested_raw_string_json(input_json: String) -> NapiResult<String> {
    let raw: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("parse input: {}", e)))?;
    Ok(payload_extraction::find_nested_raw_string(&raw, 3))
}

#[napi]
pub fn find_nested_error_marker_json(input_json: String) -> NapiResult<String> {
    let raw: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("parse input: {}", e)))?;
    Ok(payload_extraction::find_nested_error_marker(&raw, 3))
}

#[napi]
pub fn extract_bridge_provider_response_payload_json(
    input_json: String,
) -> NapiResult<Option<String>> {
    let raw: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("parse input: {}", e)))?;
    let result = payload_extraction::extract_bridge_provider_response_payload(&raw);
    Ok(result.map(|v| v.to_string()))
}

// ---------------------------------------------------------------------------
// direct_decision NAPI exports — Rust migration batch #4
// ---------------------------------------------------------------------------

#[napi]
pub fn decide_direct_router_retry_json(input_json: String) -> NapiResult<String> {
    direct_decision::decision::decide_direct_router_retry_json(input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn decide_direct_provider_retry_json(input_json: String) -> NapiResult<String> {
    direct_decision::decision::decide_direct_provider_retry_json(input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

// ---------------------------------------------------------------------------
// req_executor_pipeline_attempt NAPI exports — Rust migration batch #1
// ---------------------------------------------------------------------------

#[napi]
pub fn normalize_explicit_route_pool_json(input_json: String) -> NapiResult<String> {
    let raw: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("parse input JSON: {}", e)))?;
    let output = req_executor_pipeline_attempt::route_pool::normalize_explicit_route_pool_json(raw)
        .map_err(|e| napi::Error::from_reason(e))?;
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("serialize output: {}", e)))
}

#[napi]
pub fn merge_observed_route_pool_chain_json(
    existing_json: Option<String>,
    observed_json: String,
) -> NapiResult<Option<String>> {
    let result = req_executor_pipeline_attempt::route_pool::merge_observed_route_pool_chain_json(
        existing_json,
        observed_json,
    )
    .map_err(|e| napi::Error::from_reason(e))?;
    match result {
        Some(s) if s.trim().is_empty() => Ok(None),
        other => Ok(other),
    }
}

#[napi(js_name = "sanitizeProviderOutboundPayloadJson")]
pub fn sanitize_provider_outbound_payload_export_json(input_json: String) -> NapiResult<String> {
    hub_protocol_spec_semantics::sanitize_provider_outbound_payload_json(input_json)
}

#[napi(js_name = "normalizeResponsesDirectCurrentRequestPayloadJson")]
pub fn normalize_responses_direct_current_request_payload_json(
    input_json: String,
) -> NapiResult<String> {
    hub_protocol_spec_semantics::normalize_responses_direct_current_request_payload_json(input_json)
}

// ---------------------------------------------------------------------------
// traffic-governor-core NAPI exports
// ---------------------------------------------------------------------------

#[napi]
pub fn traffic_governor_acquire_json(input_json: String) -> NapiResult<String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        runtime_key: String,
        #[serde(default)]
        provider_key: Option<String>,
        request_id: String,
        #[serde(default)]
        scope_key: Option<String>,
        #[serde(default)]
        max_in_flight: Option<u32>,
        #[serde(default)]
        acquire_timeout_ms: Option<u64>,
        #[serde(default)]
        stale_lease_ms: Option<u64>,
        #[serde(default)]
        requests_per_minute: Option<u32>,
        #[serde(default)]
        rpm_timeout_ms: Option<u64>,
        #[serde(default)]
        store_root: Option<String>,
    }

    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("parse input: {}", e)))?;

    let store_root = input
        .store_root
        .as_deref()
        .unwrap_or("/tmp/routecodex-traffic");
    let governor = traffic_governor_core::TrafficGovernor::new(store_root);

    let ctx = traffic_governor_core::types::AcquireContext {
        runtime_key: input.runtime_key,
        provider_key: input.provider_key,
        request_id: input.request_id,
        scope_key: input.scope_key,
        max_in_flight: input.max_in_flight.map(|v| v as usize),
        acquire_timeout_ms: input.acquire_timeout_ms,
        stale_lease_ms: input.stale_lease_ms,
        requests_per_minute: input.requests_per_minute,
        rpm_timeout_ms: input.rpm_timeout_ms,
    };

    let result = governor
        .acquire(&ctx)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    serde_json::to_string(&serde_json::json!({
        "permit": {
            "runtimeKey": result.permit.runtime_key,
            "providerKey": result.permit.provider_key,
            "requestId": result.permit.request_id,
            "leaseId": result.permit.lease_id,
            "stateKey": result.permit.state_key,
            "scopeKey": result.permit.scope_key,
            "maxInFlight": result.permit.max_in_flight,
            "pid": result.permit.pid,
            "serverId": result.permit.server_id,
            "startedAt": result.permit.started_at,
            "expiresAt": result.permit.expires_at,
        },
        "policy": {
            "maxInFlight": result.policy.max_in_flight,
            "acquireTimeoutMs": result.policy.acquire_timeout_ms,
            "staleLeaseMs": result.policy.stale_lease_ms,
            "requestsPerMinute": result.policy.requests_per_minute,
            "rpmTimeoutMs": result.policy.rpm_timeout_ms,
            "rpmWindowMs": result.policy.rpm_window_ms,
        },
        "waitedMs": result.waited_ms,
        "activeInFlight": result.active_in_flight,
        "rpmInWindow": result.rpm_in_window,
    }))
    .map_err(|e| napi::Error::from_reason(format!("serialize: {}", e)))
}

#[napi]
pub fn traffic_governor_release_json(input_json: String) -> NapiResult<String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        runtime_key: String,
        request_id: String,
        lease_id: String,
        state_key: String,
        #[serde(default)]
        store_root: Option<String>,
    }

    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("parse input: {}", e)))?;

    let store_root = input
        .store_root
        .as_deref()
        .unwrap_or("/tmp/routecodex-traffic");
    let governor = traffic_governor_core::TrafficGovernor::new(store_root);

    let permit = traffic_governor_core::types::Permit {
        runtime_key: input.runtime_key,
        provider_key: None,
        request_id: input.request_id,
        lease_id: input.lease_id,
        state_key: input.state_key,
        scope_key: None,
        max_in_flight: 0,
        pid: 0,
        server_id: String::new(),
        started_at: 0,
        expires_at: 0,
    };

    let result = governor
        .release(&permit)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    serde_json::to_string(&serde_json::json!({
        "released": result.released,
        "activeInFlight": result.active_in_flight,
    }))
    .map_err(|e| napi::Error::from_reason(format!("serialize: {}", e)))
}

#[napi]
pub fn traffic_governor_is_at_capacity_json(input_json: String) -> NapiResult<bool> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        runtime_key: String,
        #[serde(default)]
        store_root: Option<String>,
    }

    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("parse input: {}", e)))?;

    let store_root = input
        .store_root
        .as_deref()
        .unwrap_or("/tmp/routecodex-traffic");
    let governor = traffic_governor_core::TrafficGovernor::new(store_root);

    Ok(governor.is_at_capacity(&input.runtime_key))
}

#[napi]
pub fn traffic_governor_observe_outcome_json(input_json: String) -> NapiResult<()> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        runtime_key: String,
        #[serde(default)]
        provider_key: Option<String>,
        #[serde(default)]
        request_id: Option<String>,
        success: bool,
        #[serde(default)]
        status_code: Option<u16>,
        #[serde(default)]
        error_code: Option<String>,
        #[serde(default)]
        upstream_code: Option<String>,
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        active_in_flight: Option<u32>,
        #[serde(default)]
        store_root: Option<String>,
    }

    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("parse input: {}", e)))?;

    let store_root = input
        .store_root
        .as_deref()
        .unwrap_or("/tmp/routecodex-traffic");
    let governor = traffic_governor_core::TrafficGovernor::new(store_root);

    let event = traffic_governor_core::types::OutcomeEvent {
        runtime_key: input.runtime_key,
        provider_key: input.provider_key,
        request_id: input.request_id,
        success: input.success,
        status_code: input.status_code,
        error_code: input.error_code,
        upstream_code: input.upstream_code,
        reason: input.reason,
        active_in_flight: input.active_in_flight,
        observed_at_ms: None,
        configured_max_in_flight: None,
    };

    governor.observe_outcome(&event);
    Ok(())
}

#[cfg(test)]
mod metadata_center_snapshot_input_tests {
    use super::metadata_center_snapshot_or_self;
    use serde_json::json;

    #[test]
    fn metadata_center_snapshot_carrier_prefers_snapshot_payload() {
        let metadata = json!({
            "sessionId": "outer-session-must-not-win",
            "metadataCenterSnapshot": {
                "sessionId": "snapshot-session"
            }
        });

        assert_eq!(
            metadata_center_snapshot_or_self(&metadata)
                .get("sessionId")
                .and_then(|value| value.as_str()),
            Some("snapshot-session")
        );
    }

    #[test]
    fn metadata_center_snapshot_carrier_accepts_already_unwrapped_snapshot() {
        let metadata = json!({
            "sessionId": "direct-snapshot"
        });

        assert_eq!(
            metadata_center_snapshot_or_self(&metadata)
                .get("sessionId")
                .and_then(|value| value.as_str()),
            Some("direct-snapshot")
        );
    }
}

#[napi(js_name = "safeStringifyJson")]
pub fn safe_stringify_json(value_json: String) -> NapiResult<Option<String>> {
    let parsed: Option<Value> = if value_json.trim().is_empty() {
        None
    } else {
        match serde_json::from_str::<Value>(&value_json) {
            Ok(value) => Some(value),
            Err(_) => return Ok(None),
        }
    };
    match parsed {
        Some(value) => serde_json::to_string(&value)
            .map(Some)
            .map_err(|e| napi::Error::from_reason(e.to_string())),
        None => Ok(None),
    }
}

#[napi(js_name = "parseRecordJson")]
pub fn parse_record_json(value_json: String) -> NapiResult<Option<String>> {
    if value_json.trim().is_empty() {
        return Ok(None);
    }
    let parsed: Value = match serde_json::from_str(&value_json) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if !parsed.is_object() {
        return Ok(None);
    }
    serde_json::to_string(&parsed)
        .map(Some)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "formatUnknownErrorJson")]
pub fn format_unknown_error_json(value_json: String) -> NapiResult<String> {
    if value_json.trim().is_empty() {
        return Ok("Error: empty payload".to_string());
    }
    let parsed: Value = match serde_json::from_str(&value_json) {
        Ok(value) => value,
        Err(error) => return Ok(format!("Error: {}", error)),
    };
    if let Some(name) = parsed.get("name").and_then(Value::as_str) {
        let message = parsed.get("message").and_then(Value::as_str).unwrap_or("");
        let stack = parsed.get("stack").and_then(Value::as_str);
        if let Some(stack) = stack {
            if !stack.trim().is_empty() {
                return Ok(stack.to_string());
            }
        }
        if message.is_empty() {
            return Ok(name.to_string());
        }
        return Ok(format!("{}: {}", name, message));
    }
    if let Some(message) = parsed.get("message").and_then(Value::as_str) {
        if !message.is_empty() {
            return Ok(message.to_string());
        }
    }
    serde_json::to_string(&parsed).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod native_json_tool_function_tests {
    use super::{format_unknown_error_json, parse_record_json, safe_stringify_json};

    #[test]
    fn safe_stringify_json_returns_none_for_invalid_json() {
        assert_eq!(safe_stringify_json("{bad".to_string()).unwrap(), None);
    }

    #[test]
    fn parse_record_json_accepts_only_json_objects() {
        assert_eq!(parse_record_json("[]".to_string()).unwrap(), None);
        assert_eq!(
            parse_record_json("{\"ok\":true}".to_string()).unwrap(),
            Some("{\"ok\":true}".to_string())
        );
    }

    #[test]
    fn format_unknown_error_json_prefers_stack_then_name_message() {
        assert_eq!(
            format_unknown_error_json(
                "{\"name\":\"TypeError\",\"message\":\"bad\",\"stack\":\"stack line\"}".to_string()
            )
            .unwrap(),
            "stack line"
        );
        assert_eq!(
            format_unknown_error_json("{\"name\":\"TypeError\",\"message\":\"bad\"}".to_string())
                .unwrap(),
            "TypeError: bad"
        );
    }
}
