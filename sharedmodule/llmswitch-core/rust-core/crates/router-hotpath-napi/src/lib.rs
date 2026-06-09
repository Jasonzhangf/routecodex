use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};
mod chat_web_search_intent;
use chat_process_media_semantics::{
    analyze_chat_process_media, strip_chat_process_historical_images,
};
use chat_web_search_intent::{analyze_chat_web_search_intent, extract_web_search_semantics_hint};
mod anthropic_openai_codec;
mod anthropic_response_helper;
mod chat_anthropic_tool_alias;
mod chat_continue_execution_directive_injection;
mod chat_governance_context;
mod chat_governance_finalize;
mod chat_governed_filter_payload;
mod chat_node_result_semantics;
mod chat_post_governed_normalization_semantics;
mod chat_process_media_semantics;
mod chat_servertool_orchestration;
mod chat_web_search_tool_schema;
mod compat_field_mapping;
mod compat_harvest_tool_calls_from_text;
mod compat_tool_schema;
mod failure_policy;
mod followup_mainline_blocks;
mod gemini_openai_codec;
mod hashline;
mod hub_bridge_actions;
mod hub_bridge_policies;
mod hub_chat_envelope_validator;
mod hub_pipeline;
mod hub_pipeline_blocks;
mod hub_pipeline_contracts;
mod hub_pipeline_lib;
mod hub_pipeline_session_identifiers;
mod hub_pipeline_target_utils;
mod hub_pipeline_types;
mod hub_protocol_spec_semantics;
mod hub_provider_response_helpers;
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
mod hub_semantic_mapper_chat;
mod hub_snapshot_hooks;
mod hub_standardized_bridge;
mod hub_submit_tool_outputs;
mod hub_text_markup_normalizer;
mod hub_tool_governance_semantics;
mod hub_tool_session_compat;
mod openai_openai_codec;
mod req_outbound_stage3_compat;
mod req_process_stage1_tool_governance;
mod req_process_stage1_tool_governance_blocks;
mod req_process_stage2_route_select;
mod resp_process_stage1_tool_governance;
mod resp_process_stage1_tool_governance_blocks;
mod resp_process_stage2_finalize;
mod responses_openai_codec;
mod responses_reasoning_registry;
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
mod stop_message_auto_blocks;
mod streaming_tool_extractor;
mod thought_signature_validator;
mod tool_harvester;
mod virtual_router_engine;
mod virtual_router_provider_key;
mod virtual_router_stop_message_actions;
mod virtual_router_stop_message_instruction;
mod virtual_router_stop_message_state_codec;
mod vr_route_04_selection_boundary;
mod web_search_mode;
use crate::virtual_router_engine::routing::resolve_routing_state_key as resolve_virtual_router_routing_state_key;
use crate::virtual_router_engine::routing::resolve_stop_message_scope as resolve_virtual_router_stop_message_scope;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuotaBucketInputEntry {
    key: String,
    order: i64,
    has_quota: bool,
    in_pool: bool,
    cooldown_until: Option<f64>,
    blacklist_until: Option<f64>,
    priority_tier: Option<f64>,
    selection_penalty: Option<f64>,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QuotaBucketOutputEntry {
    key: String,
    penalty: i64,
    order: i64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuotaBucketOutput {
    priorities: Vec<i64>,
    buckets: Vec<QuotaBucketOutputTier>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuotaBucketOutputTier {
    priority: i64,
    entries: Vec<QuotaBucketOutputEntry>,
}
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
fn read_priority(entry: &QuotaBucketInputEntry) -> i64 {
    if let Some(raw) = entry.priority_tier {
        if raw.is_finite() {
            return raw.floor() as i64;
        }
    }
    100
}
fn read_penalty(entry: &QuotaBucketInputEntry) -> i64 {
    if let Some(raw) = entry.selection_penalty {
        if raw.is_finite() && raw > 0.0 {
            return raw.floor() as i64;
        }
    }
    0
}
fn is_cooling(entry: &QuotaBucketInputEntry, now_ms: f64) -> bool {
    entry
        .cooldown_until
        .map(|v| v.is_finite() && v > now_ms)
        .unwrap_or(false)
}
fn is_blacklisted(entry: &QuotaBucketInputEntry, now_ms: f64) -> bool {
    entry
        .blacklist_until
        .map(|v| v.is_finite() && v > now_ms)
        .unwrap_or(false)
}

fn compute_quota_buckets(entries: Vec<QuotaBucketInputEntry>, now_ms: f64) -> QuotaBucketOutput {
    let mut buckets: BTreeMap<i64, Vec<QuotaBucketOutputEntry>> = BTreeMap::new();

    for entry in entries {
        if !entry.has_quota {
            buckets
                .entry(100)
                .or_default()
                .push(QuotaBucketOutputEntry {
                    key: entry.key,
                    penalty: 0,
                    order: entry.order,
                });
            continue;
        }
        if !entry.in_pool || is_cooling(&entry, now_ms) || is_blacklisted(&entry, now_ms) {
            continue;
        }
        let priority = read_priority(&entry);
        let penalty = read_penalty(&entry);
        buckets
            .entry(priority)
            .or_default()
            .push(QuotaBucketOutputEntry {
                key: entry.key,
                penalty,
                order: entry.order,
            });
    }

    let mut priorities: Vec<i64> = buckets.keys().cloned().collect();
    priorities.sort_unstable();

    let tiers = priorities
        .iter()
        .map(|priority| QuotaBucketOutputTier {
            priority: *priority,
            entries: buckets.get(priority).cloned().unwrap_or_default(),
        })
        .collect();

    QuotaBucketOutput {
        priorities,
        buckets: tiers,
    }
}

#[napi]
pub fn resolve_virtual_router_routing_state_key_json(metadata_json: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_virtual_router_routing_state_key(&metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_virtual_router_stop_message_scope_json(metadata_json: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_virtual_router_stop_message_scope(&metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
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
pub fn compute_quota_buckets_json(entries_json: String, now_ms: f64) -> NapiResult<String> {
    let parsed: Vec<QuotaBucketInputEntry> =
        serde_json::from_str(&entries_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = compute_quota_buckets(parsed, now_ms);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
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
pub fn normalize_tools_json(tools_json: String) -> NapiResult<String> {
    shared_args_mapping::normalize_tools_json(tools_json)
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

#[napi(js_name = "updateResponsesContractProbeFromSseChunkJson")]
pub fn update_responses_contract_probe_from_sse_chunk_json_bridge(
    chunk_json: String,
    probe_json: String,
) -> NapiResult<String> {
    shared_responses_response_utils::update_responses_contract_probe_from_sse_chunk_json(
        chunk_json, probe_json,
    )
}

#[napi(js_name = "buildResponsesTerminalSseFramesFromProbeJson")]
pub fn build_responses_terminal_sse_frames_from_probe_json_bridge(
    probe_json: String,
    request_label: String,
) -> NapiResult<String> {
    shared_responses_response_utils::build_responses_terminal_sse_frames_from_probe_json(
        probe_json,
        request_label,
    )
}

#[napi]
pub fn validate_tool_arguments_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::validate_tool_arguments_json(input_json)
}

#[napi]
pub fn repair_tool_calls_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::repair_tool_calls_json(input_json)
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
pub fn has_valid_thought_signature_json(input_json: String) -> NapiResult<String> {
    thought_signature_validator::has_valid_thought_signature_json(input_json)
}

#[napi]
pub fn sanitize_thinking_block_json(input_json: String) -> NapiResult<String> {
    thought_signature_validator::sanitize_thinking_block_json(input_json)
}

#[napi]
pub fn filter_invalid_thinking_blocks_json(input_json: String) -> NapiResult<String> {
    thought_signature_validator::filter_invalid_thinking_blocks_json(input_json)
}

#[napi]
pub fn remove_trailing_unsigned_thinking_blocks_json(input_json: String) -> NapiResult<String> {
    thought_signature_validator::remove_trailing_unsigned_thinking_blocks_json(input_json)
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
pub fn normalize_req_inbound_reasoning_payload_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::normalize_req_inbound_reasoning_payload_json(input_json)
}

#[napi]
pub fn should_normalize_reasoning_payload_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::should_normalize_reasoning_payload_json(input_json)
}

#[napi]
pub fn normalize_reasoning_payload_v2_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::normalize_reasoning_payload_v2_json(input_json)
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

#[napi(js_name = "planProviderResponseServertoolRuntimeActionsJson")]
pub fn plan_provider_response_servertool_runtime_actions_json(
    input_json: String,
) -> NapiResult<String> {
    hub_pipeline_lib::effect_plan::plan_provider_response_servertool_runtime_actions_json(
        input_json,
    )
}

#[napi(js_name = "planSseStreamEffectJson")]
pub fn plan_sse_stream_effect_json(input_json: String) -> NapiResult<String> {
    hub_resp_outbound_sse_stream::plan_sse_stream_effect_json(input_json)
}

#[napi(js_name = "resolveClientToolFromIndexJson")]
pub fn resolve_client_tool_from_index_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::resolve_client_tool_from_index_json(input_json)
}

#[napi(js_name = "remapChatToolCallsJson")]
pub fn remap_chat_tool_calls_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::remap_chat_tool_calls_json(input_json)
}

#[napi(js_name = "remapResponsesToolCallsJson")]
pub fn remap_responses_tool_calls_json(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::remap_responses_tool_calls_json(input_json)
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

#[napi]
pub fn extract_web_search_semantics_hint_json(semantics_json: String) -> NapiResult<String> {
    let semantics: Value = serde_json::from_str(&semantics_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = extract_web_search_semantics_hint(&semantics);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
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

#[napi]
pub fn evaluate_stop_schema_gate_json(
    assistant_text: String,
    used: u32,
    max_repeats: u32,
) -> NapiResult<String> {
    let decision =
        stop_message_auto_blocks::evaluate_stop_schema(&assistant_text, used, max_repeats);
    serde_json::to_string(&decision)
        .map_err(|e| napi::Error::from_reason(format!("serialize StopSchemaGateDecision: {e}")))
}

#[napi(js_name = "evaluateGoalActiveStopLoopGuardJson")]
pub fn evaluate_goal_active_stop_loop_guard_json(input_json: String) -> NapiResult<String> {
    let input: stop_message_core::GoalActiveStopLoopInput = serde_json::from_str(&input_json)
        .map_err(|e| {
            napi::Error::from_reason(format!("deserialize GoalActiveStopLoopInput: {e}"))
        })?;
    let decision = stop_message_auto_blocks::evaluate_goal_active_stop_loop_guard(&input);
    serde_json::to_string(&decision)
        .map_err(|e| napi::Error::from_reason(format!("serialize GoalActiveStopLoopDecision: {e}")))
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
pub fn resolve_runtime_stop_message_state_from_adapter_context_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::resolve_runtime_stop_message_state_from_adapter_context_json(
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
pub fn read_servertool_followup_flow_id_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::read_servertool_followup_flow_id_json(&input_json)
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
pub fn get_captured_request_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::get_captured_request_json(&input_json)
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
pub fn resolve_pending_session_file_name_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::resolve_pending_session_file_name_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn resolve_pending_session_max_age_ms_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::resolve_pending_session_max_age_ms_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_pending_session_save_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_pending_session_save_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_pending_session_load_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_pending_session_load_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_pending_injection_persist_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_pending_injection_persist_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_pending_injection_persist_error_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_pending_injection_persist_error_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_pre_command_hooks_config_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_pre_command_hooks_config_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_runtime_pre_command_rule_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_runtime_pre_command_rule_json(&input_json)
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
pub fn plan_stop_message_cli_projection_seed_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_stop_message_cli_projection_seed_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_stopless_orchestration_action_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_stopless_orchestration_action_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn build_client_visible_projection_shell_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::build_client_visible_projection_shell_json(&input_json)
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
pub fn plan_servertool_backend_route_policy_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_servertool_backend_route_policy_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_vision_eligibility_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_vision_eligibility_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn decorate_servertool_final_chat_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::decorate_servertool_final_chat_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn should_short_circuit_requires_action_followup_json(
    input_json: String,
) -> NapiResult<String> {
    servertool_core_blocks::should_short_circuit_requires_action_followup_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_followup_execution_mode_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_followup_execution_mode_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_followup_runtime_action_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_followup_runtime_action_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_followup_runtime_metadata_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_followup_runtime_metadata_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_followup_materialization_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_followup_materialization_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_followup_error_envelope_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_followup_error_envelope_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn plan_bootstrap_replay_json(input_json: String) -> NapiResult<String> {
    servertool_core_blocks::plan_bootstrap_replay_json(&input_json)
        .map_err(|e| napi::Error::from_reason(e))
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
pub fn apply_stopless_goal_directive_json(payload_json: String) -> NapiResult<String> {
    let payload = serde_json::from_str::<
        virtual_router_engine::rcc_fence::StoplessGoalDirectiveTransitionInput,
    >(&payload_json)
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let next = virtual_router_engine::rcc_fence::apply_stopless_goal_directive(payload)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&next).map_err(|e| napi::Error::from_reason(e.to_string()))
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
pub fn clean_routing_instruction_markers_json(request_json: String) -> NapiResult<String> {
    let mut request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    virtual_router_engine::instructions::clean_routing_instruction_markers(&mut request);
    serde_json::to_string(&request).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn clean_malformed_routing_instruction_markers_json(
    request_json: String,
) -> NapiResult<String> {
    let mut request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    virtual_router_engine::instructions::clean_malformed_routing_instruction_markers(&mut request);
    serde_json::to_string(&request).map_err(|e| napi::Error::from_reason(e.to_string()))
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

#[napi(js_name = "normalizeToolCallIdsJson")]
pub fn normalize_tool_call_ids_json(payload_json: String) -> NapiResult<String> {
    shared_response_compat::normalize_tool_call_ids_json(payload_json)
}

#[allow(non_snake_case)]
#[napi(js_name = "sanitizeChatProcessMessagesJson")]
pub fn sanitize_chat_process_messages_json(input_json: String) -> NapiResult<String> {
    shared_response_compat::sanitize_chat_process_messages_json(input_json)
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

#[napi(js_name = "applyAnthropicClaudeCodeUserIdJson")]
pub fn apply_anthropic_claude_code_user_id_json(
    payload_json: String,
    adapter_context_json: Option<String>,
) -> NapiResult<String> {
    req_outbound_stage3_compat::claude_code::apply_anthropic_claude_code_user_id_json(
        payload_json,
        adapter_context_json,
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

#[napi(js_name = "applyLmstudioResponsesInputStringifyJson")]
pub fn apply_lmstudio_responses_input_stringify_json_bridge(
    payload_json: String,
    adapter_context_json: Option<String>,
) -> NapiResult<String> {
    req_outbound_stage3_compat::apply_lmstudio_responses_input_stringify_json(
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

#[napi(js_name = "normalizeReasoningInOpenAIPayloadJson")]
pub fn normalizeReasoningInOpenAIPayloadJson(input_json: String) -> NapiResult<String> {
    hub_bridge_actions::normalize_reasoning_in_openai_payload_json(input_json)
}

#[napi(js_name = "bootstrapVirtualRouterRoutingJson")]
pub fn bootstrap_virtual_router_routing_json_bridge(
    routing_json: String,
    alias_index_json: String,
    model_index_json: String,
    forwarder_ids_json: Option<String>,
) -> NapiResult<String> {
    virtual_router_engine::routing::bootstrap_virtual_router_routing_json(
        routing_json,
        alias_index_json,
        model_index_json,
        forwarder_ids_json,
    )
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

#[napi(js_name = "bootstrapVirtualRouterProviderProfilesJson")]
pub fn bootstrap_virtual_router_provider_profiles_json_bridge(
    routed_target_keys_json: String,
    alias_index_json: String,
    model_index_json: String,
    runtime_entries_json: String,
) -> NapiResult<String> {
    virtual_router_engine::provider_bootstrap::bootstrap_virtual_router_provider_profiles_json(
        routed_target_keys_json,
        alias_index_json,
        model_index_json,
        runtime_entries_json,
    )
}

#[napi(js_name = "bootstrapVirtualRouterConfigMetaJson")]
pub fn bootstrap_virtual_router_config_meta_json_bridge(
    section_json: String,
    routing_source_json: String,
) -> NapiResult<String> {
    virtual_router_engine::config_bootstrap::bootstrap_virtual_router_config_meta_json(
        section_json,
        routing_source_json,
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

mod hub_req_inbound_unified_fastpath;

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

#[napi(js_name = "filterOutExecutedServerToolCallsJson")]
pub fn filter_out_executed_server_tool_calls_json(
    finalized_payload_json: String,
    orchestration_payload_json: String,
) -> NapiResult<String> {
    let finalized_payload: Value = serde_json::from_str(&finalized_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let orchestration_payload: Value = serde_json::from_str(&orchestration_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = servertool_skeleton::finalize_strip::filter_out_executed_servertool_calls(
        &finalized_payload,
        &orchestration_payload,
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "runHashlineNativeEditJson")]
pub fn run_hashline_native_edit_json(input_json: String) -> NapiResult<String> {
    let input: hashline::HashlineNativeEditInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = hashline::run_hashline_native_edit(input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub use responses_reasoning_registry::{
    consume_responses_passthrough_by_aliases_json, consume_responses_passthrough_json,
    consume_responses_payload_snapshot_by_aliases_json, consume_responses_payload_snapshot_json,
    register_responses_passthrough_json, register_responses_payload_snapshot_json,
};
pub use shared_responses_conversation_utils::{
    materialize_responses_continuation_payload_json, plan_responses_handler_entry_json,
    prepare_responses_conversation_entry_json, resume_responses_conversation_payload_json,
};

#[napi(js_name = "resolveHubProtocolSpecJson")]
pub fn resolve_hub_protocol_spec_export_json(input_json: String) -> NapiResult<String> {
    hub_protocol_spec_semantics::resolve_hub_protocol_spec_json(input_json)
}

#[napi(js_name = "resolveHubProtocolAllowlistsJson")]
pub fn resolve_hub_protocol_allowlists_export_json() -> NapiResult<String> {
    hub_protocol_spec_semantics::resolve_hub_protocol_allowlists_json()
}

#[napi(js_name = "sanitizeProviderOutboundPayloadJson")]
pub fn sanitize_provider_outbound_payload_export_json(input_json: String) -> NapiResult<String> {
    hub_protocol_spec_semantics::sanitize_provider_outbound_payload_json(input_json)
}
