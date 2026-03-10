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
mod chat_clock_clear_directive;
use chat_clock_clear_directive::strip_clock_clear_directive_text;
mod chat_clock_schedule_directive_candidate;
use chat_clock_schedule_directive_candidate::parse_clock_schedule_directive_candidate;
mod chat_clock_schedule_directive_text_parts;
use chat_clock_schedule_directive_text_parts::extract_clock_schedule_directive_text_parts;
mod anthropic_openai_codec;
mod gemini_openai_codec;
mod chat_anthropic_tool_alias;
mod chat_clock_reminder_directives;
mod chat_clock_reminder_orchestration_semantics;
mod chat_clock_reminder_semantics;
mod chat_clock_reminder_time_tag_semantics;
mod chat_clock_reminders_semantics;
mod chat_clock_tool_schema_ops;
mod chat_continue_execution_directive_injection;
mod chat_governance_context;
mod chat_governance_finalize;
mod chat_governed_filter_payload;
mod chat_node_result_semantics;
mod chat_post_governed_normalization_semantics;
mod chat_process_media_semantics;
mod chat_servertool_orchestration;
mod chat_tool_normalization;
mod chat_web_search_tool_schema;
mod hub_bridge_actions;
mod hub_bridge_policies;
mod hub_chat_envelope_validator;
mod hub_pipeline;
mod hub_pipeline_session_identifiers;
mod hub_pipeline_target_utils;
mod hub_protocol_spec_semantics;
mod hub_reasoning_tool_normalizer;
mod hub_req_inbound_context_capture;
mod hub_req_inbound_format_parse;
mod hub_req_inbound_semantic_lift;
mod hub_req_inbound_tool_call_normalization;
mod hub_req_inbound_tool_output_diagnostics;
mod hub_req_inbound_tool_output_snapshot;
mod hub_req_outbound_context_merge;
mod hub_req_outbound_format_build;
mod hub_resp_inbound_format_parse;
mod hub_resp_inbound_sse_decode_semantics;
mod hub_resp_inbound_sse_stream_sniffer;
mod hub_resp_outbound_client_semantics;
mod hub_resp_outbound_sse_stream;
mod hub_semantic_mapper_chat;
mod hub_snapshot_hooks;
mod hub_standardized_bridge;
mod hub_text_markup_normalizer;
mod hub_tool_governance_semantics;
mod hub_tool_session_compat;
mod openai_openai_codec;
mod req_outbound_stage3_compat;
mod req_process_stage1_tool_governance;
mod req_process_stage2_route_select;
mod resp_process_stage1_tool_governance;
mod resp_process_stage2_finalize;
mod responses_openai_codec;
mod shared_args_mapping;
mod shared_bridge_instructions;
mod shared_chat_output_normalizer;
mod shared_chat_request_filters;
mod shared_compaction_detect;
mod shared_gemini_tool_utils;
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
mod shared_tool_call_id_manager;
mod shared_tool_mapping;
mod shared_tooling;
mod streaming_tool_extractor;
mod thought_signature_validator;
mod tool_harvester;
mod virtual_router_engine;
mod virtual_router_provider_key;
mod virtual_router_stop_message_actions;
mod virtual_router_stop_message_instruction;
mod virtual_router_stop_message_state_codec;
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
struct AntigravitySplitOutput {
    non_antigravity: Vec<String>,
    has_antigravity: bool,
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

fn split_antigravity_targets(targets: Vec<String>) -> AntigravitySplitOutput {
    let mut non_antigravity: Vec<String> = Vec::new();
    let mut has_antigravity = false;
    for target in targets {
        let provider_id = target
            .split('.')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if provider_id == "antigravity" {
            has_antigravity = true;
            continue;
        }
        non_antigravity.push(target);
    }
    AntigravitySplitOutput {
        non_antigravity,
        has_antigravity,
    }
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
pub fn split_antigravity_targets_json(targets_json: String) -> NapiResult<String> {
    let parsed: Vec<String> =
        serde_json::from_str(&targets_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = split_antigravity_targets(parsed);
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
pub fn split_command_string_json(input_json: String) -> NapiResult<String> {
    shared_tooling::split_command_string_json(input_json)
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
pub fn pack_shell_args_json(input_json: String) -> NapiResult<String> {
    shared_tooling::pack_shell_args_json(input_json)
}

#[napi]
pub fn flatten_by_comma_json(input_json: String) -> NapiResult<String> {
    shared_tooling::flatten_by_comma_json(input_json)
}

#[napi]
pub fn chunk_string_json(input_json: String) -> NapiResult<String> {
    shared_tooling::chunk_string_json(input_json)
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
pub fn bridge_tool_to_chat_definition_json(input_json: String) -> NapiResult<String> {
    shared_tool_mapping::bridge_tool_to_chat_definition_json(input_json)
}

#[napi]
pub fn chat_tool_to_bridge_definition_json(input_json: String) -> NapiResult<String> {
    shared_tool_mapping::chat_tool_to_bridge_definition_json(input_json)
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

#[napi]
pub fn strip_clock_clear_directive_text_json(text: String) -> NapiResult<String> {
    let output = strip_clock_clear_directive_text(text);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_clock_schedule_directive_candidate_json(payload: String) -> NapiResult<String> {
    let output = parse_clock_schedule_directive_candidate(payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn extract_clock_schedule_directive_text_parts_json(text: String) -> NapiResult<String> {
    let output = extract_clock_schedule_directive_text_parts(text);
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
            out.insert("stopMessageMaxRepeats".to_string(), Value::Number(value.into()));
        }
        if let Some(value) = &stop.ai_mode {
            out.insert("stopMessageAiMode".to_string(), Value::String(value.clone()));
        }
        if let Some(value) = &stop.source {
            out.insert("stopMessageSource".to_string(), Value::String(value.clone()));
        }
        if stop.from_historical {
            out.insert("fromHistoricalUserMessage".to_string(), Value::Bool(true));
        }
    }
    if let Some(pre) = &instruction.pre_command {
        if let Some(value) = &pre.script_path {
            out.insert("preCommandScriptPath".to_string(), Value::String(value.clone()));
        }
    }
    Value::Object(out)
}

#[napi]
pub fn parse_routing_instructions_json(messages_json: String) -> NapiResult<String> {
    let messages: Vec<Value> =
        serde_json::from_str(&messages_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let parsed =
        virtual_router_engine::instructions::parse_routing_instructions_from_messages(&messages)
            .map_err(|e| napi::Error::from_reason(e))?;
    let output: Vec<Value> = parsed.iter().map(serialize_routing_instruction_for_napi).collect();
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_routing_instruction_kinds_json(request_json: String) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let parsed =
        virtual_router_engine::instructions::parse_routing_instructions_from_request(&request)
            .map_err(|e| napi::Error::from_reason(e))?;
    let kinds: Vec<String> = parsed.into_iter().map(|entry| entry.kind).collect();
    serde_json::to_string(&kinds).map_err(|e| napi::Error::from_reason(e.to_string()))
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
pub fn clean_malformed_routing_instruction_markers_json(request_json: String) -> NapiResult<String> {
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
    hub_reasoning_tool_normalizer::normalize_assistant_text_to_tool_calls_json(
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

#[napi(js_name = "prepareAntigravityThoughtSignatureForGeminiRequestJson")]
pub fn prepare_antigravity_thought_signature_for_gemini_request_json(
    payload_json: String,
    adapter_context_json: Option<String>,
) -> NapiResult<String> {
    req_outbound_stage3_compat::prepare_antigravity_signature_for_gemini_request_json(
        payload_json,
        adapter_context_json,
    )
}

#[napi(js_name = "applyIflowToolTextFallbackJson")]
pub fn apply_iflow_tool_text_fallback_json(
    payload_json: String,
    adapter_context_json: Option<String>,
    models_json: Option<String>,
) -> NapiResult<String> {
    req_outbound_stage3_compat::apply_iflow_tool_text_fallback_json(
        payload_json,
        adapter_context_json,
        models_json,
    )
}

#[napi(js_name = "applyToolTextRequestGuidanceJson")]
pub fn apply_tool_text_request_guidance_json(
    payload_json: String,
    config_json: Option<String>,
) -> NapiResult<String> {
    req_outbound_stage3_compat::apply_tool_text_request_guidance_json(payload_json, config_json)
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

mod hub_req_inbound_unified_fastpath;
use hub_req_inbound_unified_fastpath::process_unified_inbound_fast_json;

