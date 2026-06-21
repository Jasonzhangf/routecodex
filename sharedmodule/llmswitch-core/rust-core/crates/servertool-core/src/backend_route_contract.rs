use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::outcome_contract::{
    build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03,
    ServertoolHubRespChatProcess03Input, ServertoolOutcomeError,
};
use crate::orchestration_policy_contract::ServertoolErrorPlan;
use crate::persisted_lookup::STOP_MESSAGE_FOLLOWUP_FLOW_ID;

// feature_id: hub.servertool_backend_route_runtime

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRoutePolicyInput {
    pub tool_name: String,
    pub flow_id: Option<String>,
    pub input: Value,
    pub entry_endpoint: Option<String>,
    #[serde(default)]
    pub adapter_context: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRoutePolicy01Planned {
    pub tool_name: String,
    pub flow_id: String,
    pub route_hint: String,
    pub execution_mode: ServertoolBackendRouteExecutionMode,
    pub eligible: bool,
    pub skip_reason: Option<String>,
    pub shape_guard: ServertoolBackendRouteShapeGuard,
    pub origin_delta: ServertoolBackendRouteOriginDelta,
    pub finalize: ServertoolBackendRouteFinalizePolicy,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ServertoolBackendRouteExecutionMode {
    Reenter,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRouteShapeGuard {
    pub allow_requires_action: bool,
    pub preserve_streaming: bool,
    pub fail_on_missing_payload: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRouteOriginDelta {
    pub requires_origin_seed: bool,
    pub apply_assistant_delta: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRouteFinalizePolicy {
    pub context_decoration_mode: Option<String>,
    pub short_circuit_requires_action: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRouteFinalizeInput {
    pub chat: Value,
    pub execution: Option<ServertoolBackendRouteFinalizeExecution>,
    pub decision: Option<ServertoolBackendRouteFinalizeDecision>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRouteFinalizeExecution {
    pub flow_id: Option<String>,
    pub context: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRouteFinalizeDecision {
    pub context_decoration_mode: Option<String>,
    pub ignore_requires_action_followup: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRouteRequiresActionShortCircuitInput {
    pub flow_id: Option<String>,
    pub decision: Option<ServertoolBackendRouteFinalizeDecision>,
    pub has_requires_action_shape: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupExecutionModeInput {
    pub flow_id: Option<String>,
    pub decision: Option<ServertoolFollowupExecutionModeDecision>,
    pub metadata_client_inject_only: bool,
    pub client_inject_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupExecutionModeDecision {
    pub outcome_mode: Option<String>,
    pub no_followup: Option<bool>,
    pub client_inject_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolFollowupExecutionMode {
    Skip,
    ClientInjectOnly,
    Reenter,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupExecutionModePlan {
    pub flow_id: Option<String>,
    pub execution_mode: ServertoolFollowupExecutionMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupRuntimeActionInput {
    pub flow_id: Option<String>,
    pub decision: Option<ServertoolFollowupRuntimeActionDecision>,
    pub metadata_client_inject_only: bool,
    pub has_followup_payload_raw: bool,
    pub loop_state_repeat_count: Option<i64>,
    pub client_inject_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupRuntimeActionDecision {
    pub outcome_mode: Option<String>,
    pub no_followup: Option<bool>,
    pub auto_limit: Option<bool>,
    pub client_inject_only: Option<bool>,
    pub seed_loop_payload: Option<bool>,
    pub client_inject_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolFollowupLoopPayloadSource {
    Payload,
    SeedLoopPayload,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupAutoLimitPlan {
    pub exceeded: bool,
    pub status: Option<u16>,
    pub code: Option<String>,
    pub category: Option<String>,
    pub reason: Option<String>,
    pub repeat_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupAutoLimitErrorPlanInput {
    pub flow_id: Option<String>,
    pub request_id: String,
    pub repeat_count: Option<i64>,
    pub reason: Option<String>,
    pub status: Option<u16>,
    pub code: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupClientInjectMetadataPlan {
    pub force: bool,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupRuntimeActionPlan {
    pub flow_id: Option<String>,
    pub is_stop_message_flow: bool,
    pub loop_payload_source: ServertoolFollowupLoopPayloadSource,
    pub auto_limit: ServertoolFollowupAutoLimitPlan,
    pub client_inject_metadata: ServertoolFollowupClientInjectMetadataPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupRuntimeMetadataInput {
    pub metadata: Value,
    pub metadata_runtime: Option<Value>,
    pub adapter_context: Option<Value>,
    pub adapter_runtime: Option<Value>,
    pub loop_state: Option<Value>,
    pub original_entry_endpoint: Option<String>,
    pub followup_entry_endpoint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupRuntimeMetadataPlan {
    pub root_set: Value,
    pub root_delete: Vec<String>,
    pub runtime_set: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupMaterializationInput {
    pub followup_plan: Value,
    pub entry_endpoint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolFollowupPayloadSource {
    Payload,
    Injection,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupMaterializationPlan {
    pub entry_endpoint: String,
    pub payload_source: ServertoolFollowupPayloadSource,
    pub payload: Option<Value>,
    pub injection: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupPayloadStreamPlanInput {
    pub stream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupPayloadStreamPlan {
    pub stream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHubFollowupPolicyShadowInput {
    pub mode_raw: Option<String>,
    pub sample_rate_raw: Option<Value>,
    pub request_id: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHubFollowupPolicyShadowDiffItem {
    pub path: String,
    pub baseline: Value,
    pub candidate: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHubFollowupPolicyShadowPlan {
    pub mode: String,
    pub sampled: bool,
    pub should_record: bool,
    pub should_enforce: bool,
    pub candidate: Value,
    pub diff_count: usize,
    pub diff_paths: Vec<String>,
    pub diff_head: Vec<ServertoolHubFollowupPolicyShadowDiffItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupAppendUserTextInput {
    pub followup_plan: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupAppendUserTextPlan {
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolPreferredFinalResponseInput {
    pub has_followup_body: bool,
    pub has_requires_action_shape: bool,
    pub is_empty_client_response_payload: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolPreferredFinalResponseSource {
    FollowupBody,
    FinalChatResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolPreferredFinalResponsePlan {
    pub source: ServertoolPreferredFinalResponseSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupErrorPlanInput {
    pub error: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolFollowupErrorEnvelopePlan {
    pub upstream_status: Option<i64>,
    pub upstream_code: Option<String>,
    pub reason: Option<String>,
    pub terminal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEmptyFollowupErrorPlanInput {
    pub flow_id: Option<String>,
    pub request_id: String,
    pub last_error_message: Option<String>,
    pub original_response_was_empty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEmptyFollowupErrorPlan {
    pub message: String,
    pub code: String,
    pub category: String,
    pub status: i64,
    pub details: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolMissingFollowupPayloadErrorPlanInput {
    pub flow_id: Option<String>,
    pub request_id: String,
    pub followup_plan: Value,
    pub adapter_context: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolMissingFollowupPayloadErrorPlan {
    pub message: String,
    pub code: String,
    pub category: String,
    pub status: i64,
    pub details: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBootstrapReplayPlanInput {
    pub preflight_body: Option<Value>,
    pub replay_seed: Option<Value>,
    pub adapter_context: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBootstrapPreflightFailurePlan {
    pub status: Option<i64>,
    pub code: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBootstrapReplayPlan {
    pub preflight_failure: Option<ServertoolBootstrapPreflightFailurePlan>,
    pub replay_payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolVisionEligibilityInput {
    pub adapter_context: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolVisionEligibilityPlan {
    pub should_run_vision_flow: bool,
    pub should_bypass_stop_message: bool,
    pub reason: String,
}

pub fn plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
    input: ServertoolBackendRoutePolicyInput,
) -> Result<ServertoolBackendRoutePolicy01Planned, ServertoolOutcomeError> {
    let normalized_input = normalize_backend_route_input(&input.tool_name, input.input)?;
    let hint = build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03(
        ServertoolHubRespChatProcess03Input {
            tool_name: input.tool_name,
            flow_id: input.flow_id,
            input: normalized_input,
            repeat_count: None,
            max_repeats: None,
            reasoning_text: None,
        },
    )?;
    let policy = match hint.tool_name.as_str() {
        "web_search" => ServertoolBackendRoutePolicy01Planned {
            tool_name: hint.tool_name,
            flow_id: normalize_flow_id(&hint.flow_id, "web_search_flow"),
            route_hint: hint.route_hint,
            execution_mode: ServertoolBackendRouteExecutionMode::Reenter,
            eligible: true,
            skip_reason: None,
            shape_guard: ServertoolBackendRouteShapeGuard {
                allow_requires_action: false,
                preserve_streaming: true,
                fail_on_missing_payload: true,
            },
            origin_delta: ServertoolBackendRouteOriginDelta {
                requires_origin_seed: true,
                apply_assistant_delta: true,
            },
            finalize: ServertoolBackendRouteFinalizePolicy {
                context_decoration_mode: Some("web_search_summary".to_string()),
                short_circuit_requires_action: false,
            },
            input: hint.input,
        },
        "vision_auto" => {
            let skip_reason =
                resolve_vision_skip_reason(input.adapter_context.as_ref().unwrap_or(&Value::Null));
            ServertoolBackendRoutePolicy01Planned {
                tool_name: hint.tool_name,
                flow_id: normalize_flow_id(&hint.flow_id, "vision_auto_flow"),
                route_hint: hint.route_hint,
                execution_mode: ServertoolBackendRouteExecutionMode::Reenter,
                eligible: skip_reason.is_none(),
                skip_reason,
                shape_guard: ServertoolBackendRouteShapeGuard {
                    allow_requires_action: false,
                    preserve_streaming: true,
                    fail_on_missing_payload: true,
                },
                origin_delta: ServertoolBackendRouteOriginDelta {
                    requires_origin_seed: true,
                    apply_assistant_delta: true,
                },
                finalize: ServertoolBackendRouteFinalizePolicy {
                    context_decoration_mode: None,
                    short_circuit_requires_action: false,
                },
                input: hint.input,
            }
        }
        _ => return Err(ServertoolOutcomeError::InvalidField("toolName")),
    };
    Ok(policy)
}

pub fn plan_vision_eligibility(
    input: ServertoolVisionEligibilityInput,
) -> ServertoolVisionEligibilityPlan {
    let adapter_context = &input.adapter_context;
    let runtime_metadata = read_runtime_metadata(adapter_context);
    let captured = get_captured_chat_request(adapter_context);
    let seed = captured.and_then(extract_captured_chat_seed);
    let has_image_attachment = seed
        .and_then(|seed| seed.get("messages").and_then(Value::as_array))
        .map(|messages| contains_current_turn_image(messages))
        .unwrap_or(false);
    let has_video_attachment = seed
        .and_then(|seed| seed.get("messages").and_then(Value::as_array))
        .map(|messages| latest_user_turn_contains_video(messages))
        .unwrap_or(false)
        || read_boolish(adapter_context.get("hasVideoAttachment"))
        || runtime_metadata
            .map(|rt| read_boolish(rt.get("hasVideoAttachment")))
            .unwrap_or(false);
    let should_bypass_stop_message = has_image_attachment || has_video_attachment;

    let (should_run_vision_flow, reason) =
        if has_inline_multimodal_support(adapter_context, runtime_metadata) {
            (false, "inline_multimodal")
        } else if resolve_adapter_route(adapter_context, runtime_metadata).as_deref()
            == Some("multimodal")
        {
            (false, "multimodal_route")
        } else if runtime_metadata
            .map(|rt| read_boolish(rt.get("serverToolFollowup")))
            .unwrap_or(false)
        {
            (false, "servertool_followup")
        } else if is_image_generation_request(adapter_context, runtime_metadata, captured) {
            (false, "image_generation")
        } else if !has_image_attachment {
            (false, "no_image_attachment")
        } else if has_video_attachment {
            (false, "video_attachment")
        } else if read_boolish(adapter_context.get("forceVision")) {
            (true, "force_vision")
        } else if has_inline_multimodal_provider(adapter_context, runtime_metadata) {
            (false, "inline_multimodal_provider")
        } else {
            (true, "image_attachment")
        };

    ServertoolVisionEligibilityPlan {
        should_run_vision_flow,
        should_bypass_stop_message,
        reason: reason.to_string(),
    }
}

pub fn decorate_servertool_final_chat_with_context(
    input: ServertoolBackendRouteFinalizeInput,
) -> Value {
    let mut chat = input.chat;
    let Some(execution) = input.execution else {
        return chat;
    };
    let Some(context) = execution.context else {
        return chat;
    };
    let mode = input
        .decision
        .and_then(|decision| normalize_context_decoration_mode(decision.context_decoration_mode));
    match mode.as_deref() {
        Some("continue_execution_summary") => {
            let Some(summary) =
                read_nested_trimmed_string(&context, &["continue_execution", "visibleSummary"])
            else {
                return chat;
            };
            decorate_first_choice_message_content(&mut chat, |base| {
                if base.trim().is_empty() {
                    summary.clone()
                } else {
                    format!("{summary}\n\n{base}")
                }
            });
            chat
        }
        Some("web_search_summary") => {
            let Some(summary) = read_nested_trimmed_string(&context, &["web_search", "summary"])
            else {
                return chat;
            };
            let label = match read_nested_trimmed_string(&context, &["web_search", "engineId"]) {
                Some(engine_id) => {
                    format!("\u{3010}web_search \u{539f}\u{6587} | engine: {engine_id}\u{3011}")
                }
                None => "\u{3010}web_search \u{539f}\u{6587}\u{3011}".to_string(),
            };
            let suffix = format!("{label}\n{summary}");
            decorate_first_choice_message_content(&mut chat, |base| {
                if base.trim().is_empty() {
                    suffix.clone()
                } else {
                    format!("{base}\n\n{suffix}")
                }
            });
            chat
        }
        _ => chat,
    }
}

pub fn should_short_circuit_requires_action_followup(
    input: ServertoolBackendRouteRequiresActionShortCircuitInput,
) -> bool {
    input.has_requires_action_shape
        && input
            .decision
            .and_then(|decision| decision.ignore_requires_action_followup)
            .unwrap_or(false)
}

pub fn plan_followup_execution_mode(
    input: ServertoolFollowupExecutionModeInput,
) -> Result<ServertoolFollowupExecutionModePlan, ServertoolOutcomeError> {
    let flow_id = input
        .flow_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let decision = input.decision;
    let outcome_mode = decision
        .as_ref()
        .and_then(|item| item.outcome_mode.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("reenter");
    if !matches!(outcome_mode, "skip" | "client_inject_only" | "reenter") {
        return Err(ServertoolOutcomeError::InvalidField("decision.outcomeMode"));
    }
    let no_followup = decision
        .as_ref()
        .and_then(|item| item.no_followup)
        .unwrap_or(false);
    let client_inject_only = decision
        .as_ref()
        .and_then(|item| item.client_inject_only)
        .unwrap_or(false);
    let client_inject_source = input
        .client_inject_source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let execution_mode = if outcome_mode == "skip" || no_followup {
        ServertoolFollowupExecutionMode::Skip
    } else if client_inject_source == Some("servertool.stopless_goal_continue") {
        ServertoolFollowupExecutionMode::Reenter
    } else if input.metadata_client_inject_only
        || outcome_mode == "client_inject_only"
        || client_inject_only
    {
        ServertoolFollowupExecutionMode::ClientInjectOnly
    } else {
        ServertoolFollowupExecutionMode::Reenter
    };
    Ok(ServertoolFollowupExecutionModePlan {
        flow_id,
        execution_mode,
    })
}

pub fn plan_followup_runtime_action(
    input: ServertoolFollowupRuntimeActionInput,
) -> Result<ServertoolFollowupRuntimeActionPlan, ServertoolOutcomeError> {
    let flow_id = input
        .flow_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let is_stop_message_flow = flow_id.as_deref() == Some(STOP_MESSAGE_FOLLOWUP_FLOW_ID);
    let decision = input.decision;
    let outcome_mode = decision
        .as_ref()
        .and_then(|item| item.outcome_mode.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("reenter");
    if !matches!(outcome_mode, "skip" | "client_inject_only" | "reenter") {
        return Err(ServertoolOutcomeError::InvalidField("decision.outcomeMode"));
    }
    let no_followup = decision
        .as_ref()
        .and_then(|item| item.no_followup)
        .unwrap_or(false);
    if outcome_mode == "skip" || no_followup {
        return Ok(ServertoolFollowupRuntimeActionPlan {
            flow_id,
            is_stop_message_flow,
            loop_payload_source: ServertoolFollowupLoopPayloadSource::None,
            auto_limit: ServertoolFollowupAutoLimitPlan {
                exceeded: false,
                status: None,
                code: None,
                category: None,
                reason: None,
                repeat_count: input.loop_state_repeat_count,
            },
            client_inject_metadata: ServertoolFollowupClientInjectMetadataPlan {
                force: false,
                source: None,
            },
        });
    }

    let seed_loop_payload = decision
        .as_ref()
        .and_then(|item| item.seed_loop_payload)
        .unwrap_or(false);
    let loop_payload_source = if input.has_followup_payload_raw {
        ServertoolFollowupLoopPayloadSource::Payload
    } else if seed_loop_payload {
        ServertoolFollowupLoopPayloadSource::SeedLoopPayload
    } else {
        ServertoolFollowupLoopPayloadSource::None
    };

    let auto_limit = decision
        .as_ref()
        .and_then(|item| item.auto_limit)
        .unwrap_or(false);
    let repeat_count = input.loop_state_repeat_count;
    let auto_limit_exceeded = auto_limit && repeat_count.unwrap_or(0) >= 3;
    let auto_limit_plan = if auto_limit_exceeded {
        ServertoolFollowupAutoLimitPlan {
            exceeded: true,
            status: Some(502),
            code: Some("SERVERTOOL_FOLLOWUP_FAILED".to_string()),
            category: Some("INTERNAL_ERROR".to_string()),
            reason: Some("followup_auto_limit_hit".to_string()),
            repeat_count,
        }
    } else {
        ServertoolFollowupAutoLimitPlan {
            exceeded: false,
            status: None,
            code: None,
            category: None,
            reason: None,
            repeat_count,
        }
    };

    let client_inject_only = decision
        .as_ref()
        .and_then(|item| item.client_inject_only)
        .unwrap_or(false);
    let client_inject_source = input
        .client_inject_source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            decision
                .as_ref()
                .and_then(|item| item.client_inject_source.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("servertool.followup");
    let force_client_inject_metadata = client_inject_only && !input.metadata_client_inject_only;
    Ok(ServertoolFollowupRuntimeActionPlan {
        flow_id,
        is_stop_message_flow,
        loop_payload_source,
        auto_limit: auto_limit_plan,
        client_inject_metadata: ServertoolFollowupClientInjectMetadataPlan {
            force: force_client_inject_metadata,
            source: if force_client_inject_metadata {
                Some(client_inject_source.to_string())
            } else {
                None
            },
        },
    })
}

pub fn plan_followup_auto_limit_error(
    input: ServertoolFollowupAutoLimitErrorPlanInput,
) -> Result<ServertoolErrorPlan, ServertoolOutcomeError> {
    let request_id = input.request_id.trim();
    if request_id.is_empty() {
        return Err(ServertoolOutcomeError::InvalidField("requestId"));
    }
    let status = input.status.unwrap_or(502);
    let code = input
        .code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("SERVERTOOL_FOLLOWUP_FAILED");
    let category = input
        .category
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("INTERNAL_ERROR");
    let reason = input
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("followup_auto_limit_hit");
    let flow_id = input
        .flow_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let mut details = serde_json::Map::new();
    details.insert(
        "requestId".to_string(),
        Value::String(request_id.to_string()),
    );
    details.insert("reason".to_string(), Value::String(reason.to_string()));
    if let Some(flow_id_value) = flow_id.clone() {
        details.insert("flowId".to_string(), Value::String(flow_id_value));
    }
    if let Some(repeat_count) = input.repeat_count {
        details.insert(
            "repeatCount".to_string(),
            Value::Number(serde_json::Number::from(repeat_count)),
        );
    }
    Ok(ServertoolErrorPlan {
        message:
            "[servertool] followup auto limit reached before stopless contract was satisfied"
                .to_string(),
        code: code.to_string(),
        category: category.to_string(),
        status,
        details: Value::Object(details),
    })
}

pub fn plan_followup_runtime_metadata(
    input: ServertoolFollowupRuntimeMetadataInput,
) -> ServertoolFollowupRuntimeMetadataPlan {
    let metadata = input.metadata;
    let metadata_runtime = input.metadata_runtime.unwrap_or(Value::Null);
    let adapter_context = input.adapter_context.unwrap_or(Value::Null);
    let adapter_runtime = input.adapter_runtime.unwrap_or(Value::Null);
    let followup_mode = read_trimmed_string(metadata.get("routecodexPortMode"))
        .or_else(|| read_trimmed_string(adapter_context.get("routecodexPortMode")))
        .or_else(|| read_trimmed_string(adapter_runtime.get("serverToolFollowupMode")))
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    let route_hint = read_trimmed_string(metadata.get("routeHint"))
        .or_else(|| read_trimmed_string(adapter_runtime.get("routeHint")))
        .or_else(|| read_trimmed_string(adapter_runtime.get("routeName")))
        .or_else(|| read_trimmed_string(adapter_context.get("routeHint")))
        .or_else(|| read_trimmed_string(adapter_context.get("routeId")))
        .or_else(|| read_trimmed_string(adapter_context.get("routeName")))
        .or_else(|| {
            adapter_context
                .get("target")
                .and_then(|target| read_trimmed_string(target.get("routeName")))
        });

    let mut root_set = serde_json::Map::new();
    let mut root_delete = Vec::new();
    root_set.insert("stream".to_string(), Value::Bool(false));
    root_set.insert(
        "__hubEntry".to_string(),
        Value::String("chat_process".to_string()),
    );
    if followup_mode == "router" {
        if let Some(route_hint) = route_hint {
            root_set.insert("routeHint".to_string(), Value::String(route_hint));
        } else if metadata.get("routeHint").is_some() {
            root_delete.push("routeHint".to_string());
        }
    } else if metadata.get("routeHint").is_some() {
        root_delete.push("routeHint".to_string());
    }

    let mut runtime_set = serde_json::Map::new();
    runtime_set.insert("serverToolFollowup".to_string(), Value::Bool(true));
    runtime_set.insert("preserveRouteHint".to_string(), Value::Bool(false));
    runtime_set.insert(
        "serverToolOriginalEntryEndpoint".to_string(),
        Value::String(resolve_original_entry_endpoint(
            input.original_entry_endpoint.as_deref(),
            input.followup_entry_endpoint.as_deref(),
        )),
    );
    if let Some(loop_state) = input.loop_state {
        let merged = merge_loop_state(
            metadata.get("serverToolLoopState"),
            &metadata_runtime,
            loop_state,
        );
        runtime_set.insert("serverToolLoopState".to_string(), merged);
    }

    ServertoolFollowupRuntimeMetadataPlan {
        root_set: Value::Object(root_set),
        root_delete,
        runtime_set: Value::Object(runtime_set),
    }
}

pub fn plan_followup_materialization(
    input: ServertoolFollowupMaterializationInput,
) -> ServertoolFollowupMaterializationPlan {
    let entry_endpoint =
        resolve_followup_entry_endpoint(&input.followup_plan, input.entry_endpoint.as_deref());
    let Some(plan_object) = input.followup_plan.as_object() else {
        return ServertoolFollowupMaterializationPlan {
            entry_endpoint,
            payload_source: ServertoolFollowupPayloadSource::None,
            payload: None,
            injection: None,
        };
    };
    if plan_object.contains_key("payload") {
        return ServertoolFollowupMaterializationPlan {
            entry_endpoint,
            payload_source: ServertoolFollowupPayloadSource::Payload,
            payload: plan_object.get("payload").and_then(clone_plain_json_object),
            injection: None,
        };
    }
    if plan_object.contains_key("injection") {
        return ServertoolFollowupMaterializationPlan {
            entry_endpoint,
            payload_source: ServertoolFollowupPayloadSource::Injection,
            payload: None,
            injection: plan_object
                .get("injection")
                .and_then(clone_plain_json_object),
        };
    }
    ServertoolFollowupMaterializationPlan {
        entry_endpoint,
        payload_source: ServertoolFollowupPayloadSource::None,
        payload: None,
        injection: None,
    }
}

pub fn plan_followup_payload_stream(
    input: ServertoolFollowupPayloadStreamPlanInput,
) -> ServertoolFollowupPayloadStreamPlan {
    ServertoolFollowupPayloadStreamPlan {
        stream: input.stream,
    }
}

pub fn plan_hub_followup_policy_shadow(
    input: ServertoolHubFollowupPolicyShadowInput,
) -> ServertoolHubFollowupPolicyShadowPlan {
    let mode = normalize_hub_followup_mode(input.mode_raw.as_deref());
    if mode == "off" {
        return ServertoolHubFollowupPolicyShadowPlan {
            mode,
            sampled: false,
            should_record: false,
            should_enforce: false,
            candidate: input.payload,
            diff_count: 0,
            diff_paths: Vec::new(),
            diff_head: Vec::new(),
        };
    }

    let sampled = should_sample_hub_followup(
        input.sample_rate_raw.as_ref().unwrap_or(&Value::Null),
        input.request_id.as_deref(),
    );
    if !sampled {
        return ServertoolHubFollowupPolicyShadowPlan {
            mode,
            sampled: false,
            should_record: false,
            should_enforce: false,
            candidate: input.payload,
            diff_count: 0,
            diff_paths: Vec::new(),
            diff_head: Vec::new(),
        };
    }

    let candidate = normalize_hub_followup_payload(&input.payload);
    let mut diffs = Vec::new();
    diff_hub_followup_payloads(&input.payload, &candidate, "<root>", &mut diffs);
    let diff_count = diffs.len();
    let diff_head: Vec<_> = diffs.into_iter().take(50).collect();
    let diff_paths = diff_head.iter().map(|diff| diff.path.clone()).collect();
    ServertoolHubFollowupPolicyShadowPlan {
        mode: mode.clone(),
        sampled: true,
        should_record: diff_count > 0,
        should_enforce: mode == "enforce",
        candidate,
        diff_count,
        diff_paths,
        diff_head,
    }
}

pub fn plan_followup_append_user_text(
    input: ServertoolFollowupAppendUserTextInput,
) -> ServertoolFollowupAppendUserTextPlan {
    let text = input
        .followup_plan
        .as_object()
        .and_then(|plan| plan.get("injection"))
        .and_then(Value::as_object)
        .and_then(|injection| injection.get("ops"))
        .and_then(Value::as_array)
        .and_then(|ops| {
            ops.iter().find_map(|op| {
                let record = op.as_object()?;
                if record.get("op").and_then(Value::as_str) != Some("append_user_text") {
                    return None;
                }
                record
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
        });
    ServertoolFollowupAppendUserTextPlan { text }
}

pub fn plan_preferred_final_response(
    input: ServertoolPreferredFinalResponseInput,
) -> ServertoolPreferredFinalResponsePlan {
    let source = if input.has_followup_body
        && (input.has_requires_action_shape || !input.is_empty_client_response_payload)
    {
        ServertoolPreferredFinalResponseSource::FollowupBody
    } else {
        ServertoolPreferredFinalResponseSource::FinalChatResponse
    };
    ServertoolPreferredFinalResponsePlan { source }
}

pub fn plan_followup_error_envelope(
    input: ServertoolFollowupErrorPlanInput,
) -> ServertoolFollowupErrorEnvelopePlan {
    let upstream_code = read_followup_error_code(&input.error);
    let upstream_status = read_followup_error_status(&input.error);
    let reason = read_followup_error_reason(&input.error);
    let terminal =
        is_terminal_followup_error(upstream_status, upstream_code.as_deref(), reason.as_deref());
    ServertoolFollowupErrorEnvelopePlan {
        upstream_status,
        upstream_code,
        reason,
        terminal,
    }
}

pub fn plan_empty_followup_error(
    input: ServertoolEmptyFollowupErrorPlanInput,
) -> ServertoolEmptyFollowupErrorPlan {
    let message_flow_id = input.flow_id.as_deref().unwrap_or("unknown").to_string();
    let mut details = serde_json::Map::new();
    if let Some(flow_id) = input.flow_id {
        details.insert("flowId".to_string(), Value::String(flow_id));
    }
    details.insert("requestId".to_string(), Value::String(input.request_id));
    if let Some(message) = input.last_error_message {
        details.insert("error".to_string(), Value::String(message));
    }
    if input.original_response_was_empty {
        details.insert("originalResponseWasEmpty".to_string(), Value::Bool(true));
    }
    ServertoolEmptyFollowupErrorPlan {
        message: format!(
            "[servertool] Followup returned empty response for flow {message_flow_id}"
        ),
        code: "SERVERTOOL_EMPTY_FOLLOWUP".to_string(),
        category: "EXTERNAL_ERROR".to_string(),
        status: 502,
        details: Value::Object(details),
    }
}

pub fn plan_missing_followup_payload_error(
    input: ServertoolMissingFollowupPayloadErrorPlanInput,
) -> ServertoolMissingFollowupPayloadErrorPlan {
    let followup_plan_record = input.followup_plan.as_object();
    let adapter_record = input.adapter_context.as_object();
    let captured_entry_request =
        adapter_record.and_then(|record| record.get("capturedEntryRequest"));
    let captured_chat_request = adapter_record.and_then(|record| record.get("capturedChatRequest"));
    let seed_available = captured_entry_request
        .into_iter()
        .chain(captured_chat_request)
        .any(|value| extract_captured_chat_seed(value).is_some());
    let mut details = serde_json::Map::new();
    if let Some(flow_id) = input.flow_id {
        details.insert("flowId".to_string(), Value::String(flow_id));
    }
    details.insert("requestId".to_string(), Value::String(input.request_id));
    details.insert(
        "reason".to_string(),
        Value::String("followup_payload_missing".to_string()),
    );
    details.insert(
        "hasPayloadPlan".to_string(),
        Value::Bool(followup_plan_record.is_some_and(|plan| plan.contains_key("payload"))),
    );
    details.insert(
        "hasInjectionPlan".to_string(),
        Value::Bool(followup_plan_record.is_some_and(|plan| plan.contains_key("injection"))),
    );
    details.insert(
        "hasMetadataPlan".to_string(),
        Value::Bool(followup_plan_record.is_some_and(|plan| plan.contains_key("metadata"))),
    );
    details.insert(
        "hasCapturedEntryRequest".to_string(),
        Value::Bool(captured_entry_request.is_some_and(|value| value.is_object())),
    );
    details.insert(
        "capturedSeedAvailable".to_string(),
        Value::Bool(seed_available),
    );
    ServertoolMissingFollowupPayloadErrorPlan {
        message: "[servertool] followup payload missing for non-clientInject flow".to_string(),
        code: "SERVERTOOL_FOLLOWUP_FAILED".to_string(),
        category: "INTERNAL_ERROR".to_string(),
        status: 502,
        details: Value::Object(details),
    }
}

pub fn plan_bootstrap_replay(
    input: ServertoolBootstrapReplayPlanInput,
) -> ServertoolBootstrapReplayPlan {
    let preflight_failure = input
        .preflight_body
        .as_ref()
        .and_then(|body| body.get("error"))
        .and_then(plan_bootstrap_preflight_failure);
    let replay_seed = input.replay_seed.as_ref().or_else(|| {
        input
            .adapter_context
            .as_ref()
            .and_then(extract_captured_chat_seed)
    });
    let replay_payload = if preflight_failure.is_some() {
        None
    } else {
        replay_seed.and_then(build_bootstrap_replay_payload)
    };
    ServertoolBootstrapReplayPlan {
        preflight_failure,
        replay_payload,
    }
}

fn normalize_backend_route_input(
    tool_name: &str,
    input: Value,
) -> Result<Value, ServertoolOutcomeError> {
    match tool_name {
        "web_search" => normalize_web_search_input(input),
        "vision_auto" => Ok(input),
        _ => Ok(input),
    }
}

fn normalize_web_search_input(input: Value) -> Result<Value, ServertoolOutcomeError> {
    let normalized = match input {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                Value::Object(serde_json::Map::new())
            } else {
                let parsed = serde_json::from_str::<Value>(trimmed)
                    .map_err(|_| ServertoolOutcomeError::InvalidField("input"))?;
                parsed
                    .as_object()
                    .ok_or(ServertoolOutcomeError::InvalidField("input"))?;
                parsed
            }
        }
        Value::Object(_) => input,
        Value::Null => Value::Object(serde_json::Map::new()),
        _ => return Err(ServertoolOutcomeError::InvalidField("input")),
    };
    let mut obj = normalized
        .as_object()
        .cloned()
        .ok_or(ServertoolOutcomeError::InvalidField("input"))?;
    if let Some(query) = read_trimmed_string(obj.get("query")) {
        obj.insert("query".to_string(), Value::String(query));
    }
    if let Some(engine) = read_trimmed_string(obj.get("engine")) {
        obj.insert("engine".to_string(), Value::String(engine));
    }
    if let Some(recency) = read_trimmed_string(obj.get("recency")) {
        obj.insert("recency".to_string(), Value::String(recency));
    }
    obj.insert(
        "count".to_string(),
        Value::Number(serde_json::Number::from(normalize_web_search_count(
            obj.get("count"),
        ))),
    );
    Ok(Value::Object(obj))
}

fn normalize_web_search_count(value: Option<&Value>) -> u64 {
    let parsed = match value {
        Some(Value::Number(number)) => number.as_u64().or_else(|| {
            number
                .as_i64()
                .and_then(|item| if item > 0 { Some(item as u64) } else { None })
        }),
        Some(Value::String(raw)) => raw.trim().parse::<u64>().ok(),
        _ => None,
    };
    parsed
        .filter(|count| *count > 0)
        .map(|count| count.min(10))
        .unwrap_or(10)
}

fn normalize_hub_followup_mode(raw: Option<&str>) -> String {
    match raw.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "shadow" => "shadow".to_string(),
        "enforce" => "enforce".to_string(),
        "off" | "0" | "false" | "" => "off".to_string(),
        _ => "off".to_string(),
    }
}

fn normalize_hub_followup_sample_rate(value: &Value) -> f64 {
    let parsed = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(raw) => raw.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|number| number.is_finite())
    .unwrap_or(1.0);
    parsed.clamp(0.0, 1.0)
}

fn should_sample_hub_followup(sample_rate_raw: &Value, request_id: Option<&str>) -> bool {
    let rate = normalize_hub_followup_sample_rate(sample_rate_raw);
    if rate <= 0.0 {
        return false;
    }
    if rate >= 1.0 {
        return true;
    }
    let key = request_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("no_request_id");
    let bucket = fnv1a32(key) as f64 / 0xffff_ffffu32 as f64;
    bucket < rate
}

fn fnv1a32(input: &str) -> u32 {
    let mut hash = 0x811c9dc5u32;
    for byte in input.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

fn normalize_hub_followup_payload(payload: &Value) -> Value {
    let mut out = payload.clone();
    let Some(record) = out.as_object_mut() else {
        return out;
    };
    if record.contains_key("stream") {
        record.insert("stream".to_string(), Value::Bool(false));
    }
    record.remove("routeHint");
    record.remove("route_hint");
    let private_keys: Vec<String> = record
        .keys()
        .filter(|key| key.starts_with("__"))
        .cloned()
        .collect();
    for key in private_keys {
        record.remove(&key);
    }
    if let Some(parameters) = record.get_mut("parameters").and_then(Value::as_object_mut) {
        parameters.remove("stream");
    }
    out
}

fn diff_hub_followup_payloads(
    baseline: &Value,
    candidate: &Value,
    path: &str,
    diffs: &mut Vec<ServertoolHubFollowupPolicyShadowDiffItem>,
) {
    if baseline == candidate {
        return;
    }
    match (baseline, candidate) {
        (Value::Array(baseline_items), Value::Array(candidate_items)) => {
            let max = baseline_items.len().max(candidate_items.len());
            for index in 0..max {
                diff_hub_followup_payloads(
                    baseline_items.get(index).unwrap_or(&Value::Null),
                    candidate_items.get(index).unwrap_or(&Value::Null),
                    &format!("{path}[{index}]"),
                    diffs,
                );
            }
        }
        (Value::Object(baseline_object), Value::Object(candidate_object)) => {
            let mut keys: Vec<String> = baseline_object
                .keys()
                .chain(candidate_object.keys())
                .cloned()
                .collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let next = if path == "<root>" {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                diff_hub_followup_payloads(
                    baseline_object.get(&key).unwrap_or(&Value::Null),
                    candidate_object.get(&key).unwrap_or(&Value::Null),
                    &next,
                    diffs,
                );
            }
        }
        _ => diffs.push(ServertoolHubFollowupPolicyShadowDiffItem {
            path: path.to_string(),
            baseline: baseline.clone(),
            candidate: candidate.clone(),
        }),
    }
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(Value::as_str)?.trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

fn read_lower_string(value: Option<&Value>) -> Option<String> {
    read_trimmed_string(value).map(|value| value.to_ascii_lowercase())
}

fn read_boolish(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(true)) => true,
        Some(Value::String(raw)) => {
            matches!(raw.trim().to_ascii_lowercase().as_str(), "true" | "1")
        }
        _ => false,
    }
}

fn read_runtime_metadata(adapter_context: &Value) -> Option<&Value> {
    adapter_context
        .get("__rt")
        .or_else(|| adapter_context.get("runtimeMetadata"))
        .or_else(|| adapter_context.get("runtime_metadata"))
        .filter(|value| value.as_object().is_some())
}

fn get_captured_chat_request(adapter_context: &Value) -> Option<&Value> {
    adapter_context
        .get("capturedChatRequest")
        .filter(|value| value.as_object().is_some())
}

fn extract_captured_chat_seed(source: &Value) -> Option<&Value> {
    if source.get("messages").and_then(Value::as_array).is_some() {
        return Some(source);
    }
    source
        .get("capturedChatRequest")
        .filter(|value| value.get("messages").and_then(Value::as_array).is_some())
}

fn has_inline_multimodal_provider(
    adapter_context: &Value,
    runtime_metadata: Option<&Value>,
) -> bool {
    matches!(
        read_lower_string(adapter_context.get("providerProtocol")).as_deref(),
        Some("gemini-chat" | "gemini")
    ) || read_lower_string(adapter_context.get("providerType")).as_deref() == Some("gemini")
        || runtime_metadata
            .and_then(|rt| read_lower_string(rt.get("multimodalProvider")))
            .as_deref()
            == Some("native")
}

fn has_inline_multimodal_support(
    adapter_context: &Value,
    runtime_metadata: Option<&Value>,
) -> bool {
    read_boolish(adapter_context.get("supportsMultimodal"))
        || adapter_context
            .get("target")
            .filter(|target| target.as_object().is_some())
            .map(|target| read_boolish(target.get("supportsMultimodal")))
            .unwrap_or(false)
        || runtime_metadata
            .map(|rt| read_boolish(rt.get("supportsMultimodal")))
            .unwrap_or(false)
        || has_inline_multimodal_provider(adapter_context, runtime_metadata)
}

fn resolve_adapter_route(
    adapter_context: &Value,
    runtime_metadata: Option<&Value>,
) -> Option<String> {
    read_lower_string(adapter_context.get("routeId"))
        .or_else(|| runtime_metadata.and_then(|rt| read_lower_string(rt.get("routeHint"))))
        .or_else(|| read_lower_string(adapter_context.get("routeHint")))
        .or_else(|| runtime_metadata.and_then(|rt| read_lower_string(rt.get("routeName"))))
}

fn is_image_generation_request(
    adapter_context: &Value,
    runtime_metadata: Option<&Value>,
    captured: Option<&Value>,
) -> bool {
    has_image_generation_flag(adapter_context)
        || runtime_metadata
            .map(has_image_generation_flag)
            .unwrap_or(false)
        || captured.map(has_image_generation_flag).unwrap_or(false)
}

fn has_image_generation_flag(node: &Value) -> bool {
    let tool = read_lower_string(node.get("tool")).unwrap_or_default();
    if matches!(tool.as_str(), "image_generation" | "text-to-image") {
        return true;
    }
    read_boolish(node.get("isImageGeneration"))
}

fn contains_current_turn_image(messages: &[Value]) -> bool {
    latest_user_message(messages)
        .and_then(|message| message.get("content").and_then(Value::as_array))
        .map(|parts| parts.iter().any(part_contains_image_attachment))
        .unwrap_or(false)
}

fn latest_user_turn_contains_video(messages: &[Value]) -> bool {
    latest_user_message(messages)
        .and_then(|message| message.get("content").and_then(Value::as_array))
        .map(|parts| parts.iter().any(part_contains_video_attachment))
        .unwrap_or(false)
}

fn latest_user_message(messages: &[Value]) -> Option<&Value> {
    messages
        .iter()
        .rev()
        .find(|message| read_lower_string(message.get("role")).as_deref() == Some("user"))
}

fn part_contains_image_attachment(part: &Value) -> bool {
    let part_type = read_lower_string(part.get("type")).unwrap_or_default();
    if part_type.contains("image") {
        return has_media_candidate(part, "image_url") || part.get("source").is_some();
    }
    has_media_candidate(part, "image_url")
}

fn part_contains_video_attachment(part: &Value) -> bool {
    let part_type = read_lower_string(part.get("type")).unwrap_or_default();
    if part_type.contains("video") {
        return true;
    }
    read_media_url_candidate(part, "image_url")
        .or_else(|| read_media_url_candidate(part, "video_url"))
        .map(|url| is_video_url_hint(&url))
        .unwrap_or(false)
}

fn has_media_candidate(part: &Value, key: &str) -> bool {
    read_media_url_candidate(part, key)
        .map(|value| !value.is_empty())
        .unwrap_or(false)
}

fn read_media_url_candidate(part: &Value, key: &str) -> Option<String> {
    let raw = part.get(key)?;
    if let Some(value) = read_trimmed_string(Some(raw)) {
        return Some(value);
    }
    raw.as_object()
        .and_then(|obj| read_trimmed_string(obj.get("url")))
}

fn is_video_url_hint(url: &str) -> bool {
    let lowered = url.trim().to_ascii_lowercase();
    lowered.starts_with("data:video/")
        || [
            ".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".m3u8", ".flv",
        ]
        .iter()
        .any(|ext| {
            lowered.ends_with(ext)
                || lowered.contains(&format!("{ext}?"))
                || lowered.contains(&format!("{ext}#"))
        })
}

fn read_followup_error_code(error: &Value) -> Option<String> {
    read_trimmed_string(error.get("upstreamCode"))
        .or_else(|| {
            error
                .get("details")
                .and_then(|details| read_trimmed_string(details.get("upstreamCode")))
        })
        .or_else(|| read_trimmed_string(error.get("code")))
        .or_else(|| {
            error
                .get("details")
                .and_then(|details| read_trimmed_string(details.get("code")))
        })
}

fn read_followup_error_status(error: &Value) -> Option<i64> {
    read_number_floor(error.get("status"))
        .or_else(|| read_number_floor(error.get("statusCode")))
        .or_else(|| {
            error
                .get("details")
                .and_then(|details| read_number_floor(details.get("status")))
        })
        .or_else(|| {
            error
                .get("details")
                .and_then(|details| read_number_floor(details.get("statusCode")))
        })
}

fn read_followup_error_reason(error: &Value) -> Option<String> {
    error
        .get("details")
        .and_then(|details| read_trimmed_string(details.get("reason")))
        .or_else(|| read_trimmed_string(error.get("reason")))
        .or_else(|| read_trimmed_string(error.get("message")))
}

fn read_number_floor(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number).ok();
    }
    value.as_f64().and_then(|number| {
        if number.is_finite() {
            Some(number.floor() as i64)
        } else {
            None
        }
    })
}

fn is_terminal_followup_error(
    upstream_status: Option<i64>,
    upstream_code: Option<&str>,
    reason: Option<&str>,
) -> bool {
    if upstream_status
        .map(|status| (400..500).contains(&status))
        .unwrap_or(false)
    {
        return true;
    }
    let code = upstream_code
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(
        code.as_str(),
        "bad_request"
            | "provider_not_available"
            | "client_disconnected"
            | "client_response_closed"
            | "client_request_aborted"
            | "client_timeout_hint_expired"
            | "client_tool_args_invalid"
    ) {
        return true;
    }
    let text = reason
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    text.contains("no available providers after applying routing instructions")
        || (text.contains("tool_choice") && text.contains("必须提供 tools"))
        || text.contains("client disconnected")
        || text.contains("client_response_closed")
        || text.contains("client_request_aborted")
        || text.contains("client_timeout_hint_expired")
}

fn plan_bootstrap_preflight_failure(
    preflight_error: &Value,
) -> Option<ServertoolBootstrapPreflightFailurePlan> {
    let status = read_preflight_status(preflight_error);
    if !matches!(status, Some(400 | 429)) {
        return None;
    }
    let code = read_trimmed_string(preflight_error.get("code"))
        .or_else(|| status.map(|value| format!("HTTP_{value}")))
        .unwrap_or_else(|| "SERVERTOOL_FOLLOWUP_FAILED".to_string());
    let reason = read_trimmed_string(preflight_error.get("message"));
    Some(ServertoolBootstrapPreflightFailurePlan {
        status,
        code,
        reason,
    })
}

fn read_preflight_status(preflight_error: &Value) -> Option<i64> {
    read_number_floor(preflight_error.get("status"))
        .or_else(|| read_number_floor(preflight_error.get("statusCode")))
        .or_else(|| {
            let code = read_trimmed_string(preflight_error.get("code"))?;
            parse_http_status_code(&code)
        })
}

fn parse_http_status_code(code: &str) -> Option<i64> {
    let trimmed = code.trim();
    let numeric = trimmed
        .strip_prefix("HTTP_")
        .or_else(|| trimmed.strip_prefix("http_"))
        .unwrap_or(trimmed);
    if numeric.len() == 3 && numeric.bytes().all(|item| item.is_ascii_digit()) {
        numeric.parse::<i64>().ok()
    } else {
        None
    }
}

fn build_bootstrap_replay_payload(seed: &Value) -> Option<Value> {
    let seed = seed.as_object()?;
    let messages = seed.get("messages").and_then(Value::as_array)?;
    if messages.is_empty() {
        return None;
    }
    let mut payload = serde_json::Map::new();
    if let Some(model) = read_trimmed_string(seed.get("model")) {
        payload.insert("model".to_string(), Value::String(model));
    }
    payload.insert("messages".to_string(), Value::Array(messages.clone()));
    if let Some(tools) = seed.get("tools").and_then(Value::as_array) {
        payload.insert("tools".to_string(), Value::Array(tools.clone()));
    }
    if let Some(parameters) = seed.get("parameters").and_then(Value::as_object) {
        payload.insert("parameters".to_string(), Value::Object(parameters.clone()));
    }
    Some(Value::Object(payload))
}

fn normalize_context_decoration_mode(value: Option<String>) -> Option<String> {
    match value.as_deref().map(str::trim) {
        Some("continue_execution_summary") => Some("continue_execution_summary".to_string()),
        Some("web_search_summary") => Some("web_search_summary".to_string()),
        _ => None,
    }
}

fn read_nested_trimmed_string(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    read_trimmed_string(Some(current))
}

fn decorate_first_choice_message_content<F>(chat: &mut Value, build_content: F)
where
    F: FnOnce(&str) -> String,
{
    let Some(message) = chat
        .get_mut("choices")
        .and_then(Value::as_array_mut)
        .and_then(|choices| choices.get_mut(0))
        .and_then(Value::as_object_mut)
        .and_then(|choice| choice.get_mut("message"))
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let base = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    message.insert("content".to_string(), Value::String(build_content(&base)));
}

fn resolve_vision_skip_reason(input: &Value) -> Option<String> {
    if has_qwen_image_generation_flag(input) {
        return Some("qwen_image_generation".to_string());
    }
    None
}

fn has_qwen_image_generation_flag(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    if is_enabled_object(obj.get("qwenImageGeneration")) {
        return true;
    }
    if let Some(rt) = obj.get("__rt") {
        if has_qwen_image_generation_flag(rt) {
            return true;
        }
    }
    if let Some(captured) = obj.get("capturedChatRequest") {
        if has_qwen_image_generation_flag(captured) {
            return true;
        }
    }
    if let Some(metadata) = obj.get("metadata") {
        if has_qwen_image_generation_flag(metadata) {
            return true;
        }
    }
    false
}

fn is_enabled_object(value: Option<&Value>) -> bool {
    let Some(obj) = value.and_then(Value::as_object) else {
        return false;
    };
    match obj.get("enabled") {
        Some(Value::Bool(true)) => true,
        Some(Value::String(raw)) => matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "yes" | "on"
        ),
        _ => false,
    }
}

fn normalize_flow_id(actual: &str, default_flow_id: &'static str) -> String {
    let normalized = actual.trim();
    if normalized.is_empty() || normalized == "servertool_backend_route" {
        return default_flow_id.to_string();
    }
    normalized.to_string()
}

fn resolve_original_entry_endpoint(original: Option<&str>, followup: Option<&str>) -> String {
    original
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| followup.map(str::trim).filter(|value| !value.is_empty()))
        .unwrap_or("/v1/chat/completions")
        .to_string()
}

fn resolve_followup_entry_endpoint(followup_plan: &Value, entry_endpoint: Option<&str>) -> String {
    followup_plan
        .as_object()
        .and_then(|plan| read_trimmed_string(plan.get("entryEndpoint")))
        .or_else(|| {
            entry_endpoint
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "/v1/chat/completions".to_string())
}

fn clone_plain_json_object(value: &Value) -> Option<Value> {
    match value {
        Value::Object(_) => Some(value.clone()),
        _ => None,
    }
}

fn merge_loop_state(root_loop_state: Option<&Value>, runtime: &Value, loop_state: Value) -> Value {
    let mut merged = serde_json::Map::new();
    if let Some(root) = root_loop_state.and_then(Value::as_object) {
        for (key, value) in root {
            merged.insert(key.clone(), value.clone());
        }
    }
    if let Some(current) = runtime
        .get("serverToolLoopState")
        .and_then(Value::as_object)
    {
        for (key, value) in current {
            merged.insert(key.clone(), value.clone());
        }
    }
    if let Some(next) = loop_state.as_object() {
        for (key, value) in next {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outcome_contract::ServertoolOutcome;
    use serde_json::json;

    #[test]
    fn plans_web_search_backend_route_policy() {
        let plan = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "web_search".to_string(),
                flow_id: None,
                input: json!({"query":"latest rust"}),
                entry_endpoint: Some("/v1/responses".to_string()),
                adapter_context: None,
            },
        )
        .expect("web_search backend route plan");
        assert_eq!(plan.tool_name, "web_search");
        assert_eq!(plan.flow_id, "web_search_flow");
        assert_eq!(plan.route_hint, "servertool_backend_route:web_search");
        assert_eq!(
            plan.execution_mode,
            ServertoolBackendRouteExecutionMode::Reenter
        );
        assert!(plan.shape_guard.preserve_streaming);
        assert!(plan.shape_guard.fail_on_missing_payload);
        assert!(plan.origin_delta.requires_origin_seed);
        assert!(plan.eligible);
        assert!(plan.skip_reason.is_none());
        assert_eq!(plan.input["query"], "latest rust");
        assert_eq!(plan.input["count"], 10);
        assert_eq!(
            plan.finalize.context_decoration_mode.as_deref(),
            Some("web_search_summary")
        );
    }

    #[test]
    fn parses_web_search_arguments_string_as_rust_owned_input() {
        let plan = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "web_search".to_string(),
                flow_id: None,
                input: json!(r#"{"query":"routecodex","count":3}"#),
                entry_endpoint: None,
                adapter_context: None,
            },
        )
        .expect("web_search backend route plan");
        assert_eq!(plan.input["query"], "routecodex");
        assert_eq!(plan.input["count"], 3);
    }

    #[test]
    fn normalizes_web_search_count_bounds() {
        let plan = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "web_search".to_string(),
                flow_id: None,
                input: json!({"query":"routecodex","count":999}),
                entry_endpoint: None,
                adapter_context: None,
            },
        )
        .expect("web_search backend route plan");
        assert_eq!(plan.input["count"], 10);
    }

    #[test]
    fn plans_vision_backend_route_policy() {
        let plan = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "vision_auto".to_string(),
                flow_id: None,
                input: json!({"image":"data"}),
                entry_endpoint: None,
                adapter_context: None,
            },
        )
        .expect("vision backend route plan");
        assert_eq!(plan.tool_name, "vision_auto");
        assert_eq!(plan.flow_id, "vision_auto_flow");
        assert_eq!(plan.route_hint, "servertool_backend_route:vision_auto");
        assert!(plan.finalize.context_decoration_mode.is_none());
        assert!(plan.eligible);
        assert!(plan.skip_reason.is_none());
    }

    #[test]
    fn vision_backend_route_policy_rejects_qwen_image_generation() {
        let plan = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "vision_auto".to_string(),
                flow_id: None,
                input: json!({}),
                entry_endpoint: None,
                adapter_context: Some(json!({
                    "__rt": {
                        "qwenImageGeneration": {
                            "enabled": true,
                            "mode": "edit"
                        }
                    }
                })),
            },
        )
        .expect("vision backend route plan");
        assert!(!plan.eligible);
        assert_eq!(plan.skip_reason.as_deref(), Some("qwen_image_generation"));
    }

    #[test]
    fn vision_eligibility_runs_for_image_without_native_multimodal() {
        let plan = super::plan_vision_eligibility(super::ServertoolVisionEligibilityInput {
            adapter_context: json!({
                "providerProtocol": "openai-chat",
                "providerType": "openai",
                "routeHint": "default",
                "capturedChatRequest": {
                    "messages": [{
                        "role": "user",
                        "content": [
                            { "type": "text", "text": "describe" },
                            { "type": "image_url", "image_url": { "url": "https://example.com/a.png" } }
                        ]
                    }]
                }
            }),
        });
        assert!(plan.should_run_vision_flow);
        assert!(plan.should_bypass_stop_message);
        assert_eq!(plan.reason, "image_attachment");
    }

    #[test]
    fn vision_eligibility_skips_multimodal_video_and_image_generation() {
        let multimodal = super::plan_vision_eligibility(super::ServertoolVisionEligibilityInput {
            adapter_context: json!({
                "supportsMultimodal": true,
                "capturedChatRequest": {
                    "messages": [{
                        "role": "user",
                        "content": [{ "type": "image_url", "image_url": { "url": "https://example.com/a.png" } }]
                    }]
                }
            }),
        });
        assert!(!multimodal.should_run_vision_flow);
        assert!(multimodal.should_bypass_stop_message);
        assert_eq!(multimodal.reason, "inline_multimodal");

        let video = super::plan_vision_eligibility(super::ServertoolVisionEligibilityInput {
            adapter_context: json!({
                "capturedChatRequest": {
                    "messages": [{
                        "role": "user",
                        "content": [{ "type": "image_url", "image_url": { "url": "https://example.com/a.mp4?token=1" } }]
                    }]
                }
            }),
        });
        assert!(!video.should_run_vision_flow);
        assert!(video.should_bypass_stop_message);
        assert_eq!(video.reason, "video_attachment");

        let image_generation = super::plan_vision_eligibility(
            super::ServertoolVisionEligibilityInput {
                adapter_context: json!({
                    "tool": "text-to-image",
                    "capturedChatRequest": {
                        "messages": [{
                            "role": "user",
                            "content": [{ "type": "image_url", "image_url": { "url": "https://example.com/a.png" } }]
                        }]
                    }
                }),
            },
        );
        assert!(!image_generation.should_run_vision_flow);
        assert!(image_generation.should_bypass_stop_message);
        assert_eq!(image_generation.reason, "image_generation");
    }

    #[test]
    fn stop_message_auto_cannot_build_backend_route_policy() {
        let err = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "stop_message_auto".to_string(),
                flow_id: None,
                input: json!({}),
                entry_endpoint: None,
                adapter_context: None,
            },
        )
        .expect_err("stop_message_auto is client exec, not backend route");
        assert_eq!(
            err,
            ServertoolOutcomeError::WrongOutcome {
                tool_name: "stop_message_auto".to_string(),
                expected: ServertoolOutcome::BackendRouteReenter,
                actual: ServertoolOutcome::ClientExecCliProjection
            }
        );
    }

    #[test]
    fn memory_cache_auto_cannot_build_backend_route_policy() {
        let err = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "memory_cache_auto".to_string(),
                flow_id: None,
                input: json!({}),
                entry_endpoint: None,
                adapter_context: None,
            },
        )
        .expect_err("memory cache is server io internal, not backend route");
        assert_eq!(
            err,
            ServertoolOutcomeError::WrongOutcome {
                tool_name: "memory_cache_auto".to_string(),
                expected: ServertoolOutcome::BackendRouteReenter,
                actual: ServertoolOutcome::ServerIoInternal
            }
        );
    }

    #[test]
    fn decorates_continue_execution_summary_without_rewriting_finish_reason() {
        let output =
            decorate_servertool_final_chat_with_context(ServertoolBackendRouteFinalizeInput {
                chat: json!({
                    "choices": [{
                        "finish_reason": "tool_calls",
                        "message": { "role": "assistant", "content": null }
                    }]
                }),
                execution: Some(ServertoolBackendRouteFinalizeExecution {
                    flow_id: Some("continue_execution_flow".to_string()),
                    context: Some(json!({
                        "continue_execution": { "visibleSummary": "ok" }
                    })),
                }),
                decision: Some(ServertoolBackendRouteFinalizeDecision {
                    context_decoration_mode: Some("continue_execution_summary".to_string()),
                    ignore_requires_action_followup: None,
                }),
            });
        assert_eq!(output["choices"][0]["message"]["content"], "ok");
        assert_eq!(output["choices"][0]["finish_reason"], "tool_calls");
    }

    #[test]
    fn decorates_web_search_summary_after_existing_content() {
        let output =
            decorate_servertool_final_chat_with_context(ServertoolBackendRouteFinalizeInput {
                chat: json!({
                    "choices": [{
                        "message": { "role": "assistant", "content": "answer" }
                    }]
                }),
                execution: Some(ServertoolBackendRouteFinalizeExecution {
                    flow_id: Some("web_search_flow".to_string()),
                    context: Some(json!({
                        "web_search": {
                            "engineId": "stub",
                            "summary": "raw summary"
                        }
                    })),
                }),
                decision: Some(ServertoolBackendRouteFinalizeDecision {
                    context_decoration_mode: Some("web_search_summary".to_string()),
                    ignore_requires_action_followup: None,
                }),
            });
        assert_eq!(
            output["choices"][0]["message"]["content"],
            "answer\n\n\u{3010}web_search \u{539f}\u{6587} | engine: stub\u{3011}\nraw summary"
        );
    }

    #[test]
    fn requires_action_short_circuit_is_rust_owned() {
        assert!(should_short_circuit_requires_action_followup(
            ServertoolBackendRouteRequiresActionShortCircuitInput {
                flow_id: Some("stop_message_flow".to_string()),
                decision: Some(ServertoolBackendRouteFinalizeDecision {
                    context_decoration_mode: None,
                    ignore_requires_action_followup: Some(true),
                }),
                has_requires_action_shape: true,
            }
        ));
        assert!(!should_short_circuit_requires_action_followup(
            ServertoolBackendRouteRequiresActionShortCircuitInput {
                flow_id: Some("stop_message_flow".to_string()),
                decision: Some(ServertoolBackendRouteFinalizeDecision {
                    context_decoration_mode: None,
                    ignore_requires_action_followup: Some(true),
                }),
                has_requires_action_shape: false,
            }
        ));
    }

    #[test]
    fn followup_execution_mode_skips_no_followup_decision() {
        let plan = plan_followup_execution_mode(ServertoolFollowupExecutionModeInput {
            flow_id: Some("reasoning_stop_finalize_flow".to_string()),
            decision: Some(ServertoolFollowupExecutionModeDecision {
                outcome_mode: Some("skip".to_string()),
                no_followup: Some(false),
                client_inject_only: Some(false),
            }),
            metadata_client_inject_only: false,
            client_inject_source: None,
        })
        .expect("execution mode");
        assert_eq!(
            plan.flow_id.as_deref(),
            Some("reasoning_stop_finalize_flow")
        );
        assert_eq!(plan.execution_mode, ServertoolFollowupExecutionMode::Skip);
    }

    #[test]
    fn followup_execution_mode_metadata_client_inject_only_wins() {
        let plan = plan_followup_execution_mode(ServertoolFollowupExecutionModeInput {
            flow_id: Some("continue_execution_flow".to_string()),
            decision: Some(ServertoolFollowupExecutionModeDecision {
                outcome_mode: Some("reenter".to_string()),
                no_followup: Some(false),
                client_inject_only: Some(false),
            }),
            metadata_client_inject_only: true,
            client_inject_source: None,
        })
        .expect("execution mode");
        assert_eq!(
            plan.execution_mode,
            ServertoolFollowupExecutionMode::ClientInjectOnly
        );
    }

    #[test]
    fn followup_execution_mode_stopless_goal_continue_keeps_reenter() {
        let plan = plan_followup_execution_mode(ServertoolFollowupExecutionModeInput {
            flow_id: Some("stop_message_flow".to_string()),
            decision: Some(ServertoolFollowupExecutionModeDecision {
                outcome_mode: Some("client_inject_only".to_string()),
                no_followup: Some(false),
                client_inject_only: Some(true),
            }),
            metadata_client_inject_only: true,
            client_inject_source: Some("servertool.stopless_goal_continue".to_string()),
        })
        .expect("execution mode");
        assert_eq!(
            plan.execution_mode,
            ServertoolFollowupExecutionMode::Reenter
        );
    }

    #[test]
    fn followup_execution_mode_rejects_invalid_decision_mode() {
        let err = plan_followup_execution_mode(ServertoolFollowupExecutionModeInput {
            flow_id: Some("continue_execution_flow".to_string()),
            decision: Some(ServertoolFollowupExecutionModeDecision {
                outcome_mode: Some("fallback".to_string()),
                no_followup: Some(false),
                client_inject_only: Some(false),
            }),
            metadata_client_inject_only: false,
            client_inject_source: None,
        })
        .expect_err("invalid mode");
        assert_eq!(
            err,
            ServertoolOutcomeError::InvalidField("decision.outcomeMode")
        );
    }

    #[test]
    fn followup_runtime_action_uses_payload_before_seed_loop_payload() {
        let plan = plan_followup_runtime_action(ServertoolFollowupRuntimeActionInput {
            flow_id: Some("stop_message_flow".to_string()),
            decision: Some(ServertoolFollowupRuntimeActionDecision {
                outcome_mode: Some("reenter".to_string()),
                no_followup: Some(false),
                auto_limit: Some(false),
                client_inject_only: Some(false),
                seed_loop_payload: Some(true),
                client_inject_source: None,
            }),
            metadata_client_inject_only: false,
            has_followup_payload_raw: true,
            loop_state_repeat_count: None,
            client_inject_source: None,
        })
        .expect("runtime action");
        assert_eq!(
            plan.loop_payload_source,
            ServertoolFollowupLoopPayloadSource::Payload
        );
        assert!(plan.is_stop_message_flow);
        assert!(!plan.auto_limit.exceeded);
        assert!(!plan.client_inject_metadata.force);
    }

    #[test]
    fn followup_runtime_action_selects_seed_loop_payload_when_raw_missing() {
        let plan = plan_followup_runtime_action(ServertoolFollowupRuntimeActionInput {
            flow_id: Some("stop_message_flow".to_string()),
            decision: Some(ServertoolFollowupRuntimeActionDecision {
                outcome_mode: Some("reenter".to_string()),
                no_followup: Some(false),
                auto_limit: Some(false),
                client_inject_only: Some(false),
                seed_loop_payload: Some(true),
                client_inject_source: None,
            }),
            metadata_client_inject_only: false,
            has_followup_payload_raw: false,
            loop_state_repeat_count: None,
            client_inject_source: None,
        })
        .expect("runtime action");
        assert_eq!(
            plan.loop_payload_source,
            ServertoolFollowupLoopPayloadSource::SeedLoopPayload
        );
        assert!(plan.is_stop_message_flow);
    }

    #[test]
    fn followup_runtime_action_reports_auto_limit_failure_contract() {
        let plan = plan_followup_runtime_action(ServertoolFollowupRuntimeActionInput {
            flow_id: Some("apply_patch_read_before_retry_guard".to_string()),
            decision: Some(ServertoolFollowupRuntimeActionDecision {
                outcome_mode: Some("reenter".to_string()),
                no_followup: Some(false),
                auto_limit: Some(true),
                client_inject_only: Some(false),
                seed_loop_payload: Some(false),
                client_inject_source: None,
            }),
            metadata_client_inject_only: false,
            has_followup_payload_raw: false,
            loop_state_repeat_count: Some(3),
            client_inject_source: None,
        })
        .expect("runtime action");
        assert!(plan.auto_limit.exceeded);
        assert!(!plan.is_stop_message_flow);
        assert_eq!(plan.auto_limit.status, Some(502));
        assert_eq!(
            plan.auto_limit.code.as_deref(),
            Some("SERVERTOOL_FOLLOWUP_FAILED")
        );
        assert_eq!(
            plan.auto_limit.reason.as_deref(),
            Some("followup_auto_limit_hit")
        );
    }

    #[test]
    fn followup_runtime_action_plans_client_inject_metadata_force() {
        let plan = plan_followup_runtime_action(ServertoolFollowupRuntimeActionInput {
            flow_id: Some("continue_execution_flow".to_string()),
            decision: Some(ServertoolFollowupRuntimeActionDecision {
                outcome_mode: Some("client_inject_only".to_string()),
                no_followup: Some(false),
                auto_limit: Some(false),
                client_inject_only: Some(true),
                seed_loop_payload: Some(false),
                client_inject_source: Some("servertool.continue_execution".to_string()),
            }),
            metadata_client_inject_only: false,
            has_followup_payload_raw: false,
            loop_state_repeat_count: None,
            client_inject_source: None,
        })
        .expect("runtime action");
        assert!(plan.client_inject_metadata.force);
        assert!(!plan.is_stop_message_flow);
        assert_eq!(
            plan.client_inject_metadata.source.as_deref(),
            Some("servertool.continue_execution")
        );
    }

    #[test]
    fn followup_runtime_action_does_not_force_existing_client_inject_metadata() {
        let plan = plan_followup_runtime_action(ServertoolFollowupRuntimeActionInput {
            flow_id: Some("continue_execution_flow".to_string()),
            decision: Some(ServertoolFollowupRuntimeActionDecision {
                outcome_mode: Some("client_inject_only".to_string()),
                no_followup: Some(false),
                auto_limit: Some(false),
                client_inject_only: Some(true),
                seed_loop_payload: Some(false),
                client_inject_source: Some("servertool.continue_execution".to_string()),
            }),
            metadata_client_inject_only: true,
            has_followup_payload_raw: false,
            loop_state_repeat_count: None,
            client_inject_source: None,
        })
        .expect("runtime action");
        assert!(!plan.client_inject_metadata.force);
        assert!(plan.client_inject_metadata.source.is_none());
    }

    #[test]
    fn followup_auto_limit_error_plan_projects_provider_error_contract() {
        let plan = plan_followup_auto_limit_error(ServertoolFollowupAutoLimitErrorPlanInput {
            flow_id: Some("continue_execution_flow".to_string()),
            request_id: "req-auto-limit".to_string(),
            repeat_count: Some(3),
            reason: Some("followup_auto_limit_hit".to_string()),
            status: Some(502),
            code: Some("SERVERTOOL_FOLLOWUP_FAILED".to_string()),
            category: Some("INTERNAL_ERROR".to_string()),
        })
        .expect("followup auto-limit error plan");
        assert_eq!(
            plan.message,
            "[servertool] followup auto limit reached before stopless contract was satisfied"
        );
        assert_eq!(plan.code, "SERVERTOOL_FOLLOWUP_FAILED");
        assert_eq!(plan.category, "INTERNAL_ERROR");
        assert_eq!(plan.status, 502);
        assert_eq!(plan.details["flowId"], json!("continue_execution_flow"));
        assert_eq!(plan.details["requestId"], json!("req-auto-limit"));
        assert_eq!(plan.details["repeatCount"], json!(3));
        assert_eq!(plan.details["reason"], json!("followup_auto_limit_hit"));
    }

    #[test]
    fn followup_runtime_action_skip_has_no_runtime_side_effects() {
        let plan = plan_followup_runtime_action(ServertoolFollowupRuntimeActionInput {
            flow_id: Some("reasoning_stop_finalize_flow".to_string()),
            decision: Some(ServertoolFollowupRuntimeActionDecision {
                outcome_mode: Some("skip".to_string()),
                no_followup: Some(false),
                auto_limit: Some(true),
                client_inject_only: Some(true),
                seed_loop_payload: Some(true),
                client_inject_source: Some("servertool.continue_execution".to_string()),
            }),
            metadata_client_inject_only: false,
            has_followup_payload_raw: true,
            loop_state_repeat_count: Some(3),
            client_inject_source: None,
        })
        .expect("runtime action");
        assert_eq!(
            plan.loop_payload_source,
            ServertoolFollowupLoopPayloadSource::None
        );
        assert!(!plan.is_stop_message_flow);
        assert!(!plan.auto_limit.exceeded);
        assert!(!plan.client_inject_metadata.force);
    }

    #[test]
    fn followup_runtime_metadata_preserves_router_route_hint_from_adapter() {
        let plan = plan_followup_runtime_metadata(ServertoolFollowupRuntimeMetadataInput {
            metadata: json!({}),
            metadata_runtime: None,
            adapter_context: Some(json!({
                "routecodexPortMode": "router",
                "routeId": "coding"
            })),
            adapter_runtime: None,
            loop_state: None,
            original_entry_endpoint: Some("/v1/responses".to_string()),
            followup_entry_endpoint: Some("/v1/responses".to_string()),
        });
        assert_eq!(plan.root_set["stream"], false);
        assert_eq!(plan.root_set["__hubEntry"], "chat_process");
        assert_eq!(plan.root_set["routeHint"], "coding");
        assert!(plan.root_delete.is_empty());
        assert_eq!(plan.runtime_set["serverToolFollowup"], true);
        assert_eq!(plan.runtime_set["preserveRouteHint"], false);
        assert_eq!(
            plan.runtime_set["serverToolOriginalEntryEndpoint"],
            "/v1/responses"
        );
    }

    #[test]
    fn followup_runtime_metadata_deletes_route_hint_outside_router_mode() {
        let plan = plan_followup_runtime_metadata(ServertoolFollowupRuntimeMetadataInput {
            metadata: json!({
                "routeHint": "coding",
                "routecodexPortMode": "provider"
            }),
            metadata_runtime: None,
            adapter_context: Some(json!({})),
            adapter_runtime: None,
            loop_state: None,
            original_entry_endpoint: Some("".to_string()),
            followup_entry_endpoint: Some("/v1/chat/completions".to_string()),
        });
        assert!(plan.root_set.get("routeHint").is_none());
        assert_eq!(plan.root_delete, vec!["routeHint".to_string()]);
        assert_eq!(
            plan.runtime_set["serverToolOriginalEntryEndpoint"],
            "/v1/chat/completions"
        );
    }

    #[test]
    fn followup_runtime_metadata_merges_loop_state_in_rust_order() {
        let plan = plan_followup_runtime_metadata(ServertoolFollowupRuntimeMetadataInput {
            metadata: json!({
                "serverToolLoopState": {
                    "repeatCount": 1,
                    "rootOnly": true
                }
            }),
            metadata_runtime: Some(json!({
                "serverToolLoopState": {
                    "repeatCount": 2,
                    "runtimeOnly": true
                }
            })),
            adapter_context: Some(json!({})),
            adapter_runtime: None,
            loop_state: Some(json!({
                "repeatCount": 3,
                "flowId": "stop_message_flow"
            })),
            original_entry_endpoint: None,
            followup_entry_endpoint: None,
        });
        assert_eq!(plan.runtime_set["serverToolLoopState"]["repeatCount"], 3);
        assert_eq!(plan.runtime_set["serverToolLoopState"]["rootOnly"], true);
        assert_eq!(plan.runtime_set["serverToolLoopState"]["runtimeOnly"], true);
        assert_eq!(
            plan.runtime_set["serverToolLoopState"]["flowId"],
            "stop_message_flow"
        );
        assert_eq!(
            plan.runtime_set["serverToolOriginalEntryEndpoint"],
            "/v1/chat/completions"
        );
    }

    #[test]
    fn followup_materialization_uses_plan_entry_endpoint_before_request_default() {
        let plan = plan_followup_materialization(ServertoolFollowupMaterializationInput {
            followup_plan: json!({
                "entryEndpoint": " /v1/responses ",
                "payload": {
                    "model": "gpt-test",
                    "input": "hello"
                }
            }),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
        });
        assert_eq!(plan.entry_endpoint, "/v1/responses");
        assert_eq!(
            plan.payload_source,
            ServertoolFollowupPayloadSource::Payload
        );
        assert_eq!(plan.payload.as_ref().unwrap()["input"], "hello");
        assert!(plan.injection.is_none());
    }

    #[test]
    fn followup_materialization_uses_request_endpoint_then_chat_default() {
        let request_endpoint =
            plan_followup_materialization(ServertoolFollowupMaterializationInput {
                followup_plan: json!({}),
                entry_endpoint: Some(" /v1/responses ".to_string()),
            });
        assert_eq!(request_endpoint.entry_endpoint, "/v1/responses");
        assert_eq!(
            request_endpoint.payload_source,
            ServertoolFollowupPayloadSource::None
        );

        let default_endpoint =
            plan_followup_materialization(ServertoolFollowupMaterializationInput {
                followup_plan: Value::Null,
                entry_endpoint: Some(" ".to_string()),
            });
        assert_eq!(default_endpoint.entry_endpoint, "/v1/chat/completions");
        assert_eq!(
            default_endpoint.payload_source,
            ServertoolFollowupPayloadSource::None
        );
    }

    #[test]
    fn followup_materialization_preserves_injection_as_native_plan() {
        let plan = plan_followup_materialization(ServertoolFollowupMaterializationInput {
            followup_plan: json!({
                "injection": {
                    "ops": [{ "op": "append_user_text", "text": "next" }]
                }
            }),
            entry_endpoint: None,
        });
        assert_eq!(plan.entry_endpoint, "/v1/chat/completions");
        assert_eq!(
            plan.payload_source,
            ServertoolFollowupPayloadSource::Injection
        );
        assert!(plan.payload.is_none());
        assert!(plan.injection.as_ref().unwrap()["ops"].is_array());
    }

    #[test]
    fn followup_materialization_payload_property_wins_and_invalid_value_stays_null() {
        let plan = plan_followup_materialization(ServertoolFollowupMaterializationInput {
            followup_plan: json!({
                "payload": "not-object",
                "injection": {
                    "ops": []
                }
            }),
            entry_endpoint: None,
        });
        assert_eq!(
            plan.payload_source,
            ServertoolFollowupPayloadSource::Payload
        );
        assert!(plan.payload.is_none());
        assert!(plan.injection.is_none());
    }

    #[test]
    fn followup_append_user_text_uses_first_non_empty_append_op() {
        let plan = plan_followup_append_user_text(ServertoolFollowupAppendUserTextInput {
            followup_plan: json!({
                "injection": {
                    "ops": [
                        { "op": "inject_system_text", "text": "system" },
                        { "op": "append_user_text", "text": "  continue A  " },
                        { "op": "append_user_text", "text": "continue B" }
                    ]
                }
            }),
        });
        assert_eq!(plan.text.as_deref(), Some("continue A"));
    }

    #[test]
    fn followup_append_user_text_ignores_blank_and_invalid_shapes() {
        let blank = plan_followup_append_user_text(ServertoolFollowupAppendUserTextInput {
            followup_plan: json!({
                "injection": {
                    "ops": [
                        { "op": "append_user_text", "text": "  " },
                        { "op": "append_user_text", "text": 42 }
                    ]
                }
            }),
        });
        assert_eq!(blank.text, None);

        let missing = plan_followup_append_user_text(ServertoolFollowupAppendUserTextInput {
            followup_plan: json!({ "payload": { "input": "hello" } }),
        });
        assert_eq!(missing.text, None);
    }

    #[test]
    fn followup_payload_stream_plan_preserves_requested_stream_flag() {
        let streaming =
            plan_followup_payload_stream(ServertoolFollowupPayloadStreamPlanInput { stream: true });
        assert!(streaming.stream);

        let non_streaming =
            plan_followup_payload_stream(ServertoolFollowupPayloadStreamPlanInput {
                stream: false,
            });
        assert!(!non_streaming.stream);
    }

    #[test]
    fn hub_followup_policy_shadow_off_skips_payload_planning() {
        let payload = json!({
            "stream": true,
            "routeHint": "router",
            "__rt": { "private": true }
        });
        let plan = plan_hub_followup_policy_shadow(ServertoolHubFollowupPolicyShadowInput {
            mode_raw: Some("false".to_string()),
            sample_rate_raw: Some(json!(1)),
            request_id: Some("req_shadow_off".to_string()),
            payload: payload.clone(),
        });
        assert_eq!(plan.mode, "off");
        assert!(!plan.sampled);
        assert!(!plan.should_record);
        assert!(!plan.should_enforce);
        assert_eq!(plan.candidate, payload);
        assert_eq!(plan.diff_count, 0);
    }

    #[test]
    fn hub_followup_policy_shadow_plans_normalized_candidate_and_diff() {
        let plan = plan_hub_followup_policy_shadow(ServertoolHubFollowupPolicyShadowInput {
            mode_raw: Some("shadow".to_string()),
            sample_rate_raw: Some(json!("1")),
            request_id: Some("req_shadow_payload".to_string()),
            payload: json!({
                "model": "gpt-test",
                "stream": true,
                "routeHint": "router",
                "route_hint": "router",
                "__rt": { "private": true },
                "parameters": {
                    "stream": true,
                    "temperature": 0.2
                }
            }),
        });
        assert_eq!(plan.mode, "shadow");
        assert!(plan.sampled);
        assert!(plan.should_record);
        assert!(!plan.should_enforce);
        assert_eq!(plan.candidate["stream"], json!(false));
        assert!(plan.candidate.get("routeHint").is_none());
        assert!(plan.candidate.get("route_hint").is_none());
        assert!(plan.candidate.get("__rt").is_none());
        assert!(plan.candidate["parameters"].get("stream").is_none());
        assert_eq!(plan.candidate["parameters"]["temperature"], json!(0.2));
        assert!(plan.diff_paths.contains(&"stream".to_string()));
        assert!(plan.diff_paths.contains(&"routeHint".to_string()));
        assert!(plan.diff_paths.contains(&"parameters.stream".to_string()));
    }

    #[test]
    fn hub_followup_policy_shadow_enforce_and_sampling_are_rust_owned() {
        let skipped = plan_hub_followup_policy_shadow(ServertoolHubFollowupPolicyShadowInput {
            mode_raw: Some("enforce".to_string()),
            sample_rate_raw: Some(json!(0)),
            request_id: Some("req_shadow_skip".to_string()),
            payload: json!({ "stream": true }),
        });
        assert_eq!(skipped.mode, "enforce");
        assert!(!skipped.sampled);
        assert!(!skipped.should_enforce);
        assert_eq!(skipped.candidate["stream"], json!(true));

        let enforced = plan_hub_followup_policy_shadow(ServertoolHubFollowupPolicyShadowInput {
            mode_raw: Some("enforce".to_string()),
            sample_rate_raw: Some(json!(1)),
            request_id: Some("req_shadow_enforce".to_string()),
            payload: json!({ "stream": true }),
        });
        assert!(enforced.sampled);
        assert!(enforced.should_enforce);
        assert_eq!(enforced.candidate["stream"], json!(false));
    }

    #[test]
    fn preferred_final_response_selects_followup_for_requires_action_or_non_empty_body() {
        let requires_action =
            plan_preferred_final_response(ServertoolPreferredFinalResponseInput {
                has_followup_body: true,
                has_requires_action_shape: true,
                is_empty_client_response_payload: true,
            });
        assert_eq!(
            requires_action.source,
            ServertoolPreferredFinalResponseSource::FollowupBody
        );

        let non_empty = plan_preferred_final_response(ServertoolPreferredFinalResponseInput {
            has_followup_body: true,
            has_requires_action_shape: false,
            is_empty_client_response_payload: false,
        });
        assert_eq!(
            non_empty.source,
            ServertoolPreferredFinalResponseSource::FollowupBody
        );
    }

    #[test]
    fn preferred_final_response_keeps_final_chat_for_empty_or_missing_followup() {
        let empty = plan_preferred_final_response(ServertoolPreferredFinalResponseInput {
            has_followup_body: true,
            has_requires_action_shape: false,
            is_empty_client_response_payload: true,
        });
        assert_eq!(
            empty.source,
            ServertoolPreferredFinalResponseSource::FinalChatResponse
        );

        let missing = plan_preferred_final_response(ServertoolPreferredFinalResponseInput {
            has_followup_body: false,
            has_requires_action_shape: true,
            is_empty_client_response_payload: false,
        });
        assert_eq!(
            missing.source,
            ServertoolPreferredFinalResponseSource::FinalChatResponse
        );
    }

    #[test]
    fn followup_error_envelope_marks_client_and_provider_unavailable_terminal() {
        let status_plan = plan_followup_error_envelope(ServertoolFollowupErrorPlanInput {
            error: json!({
                "details": {
                    "statusCode": 429.8,
                    "upstreamCode": "rate_limit"
                },
                "message": "too many"
            }),
        });
        assert_eq!(status_plan.upstream_status, Some(429));
        assert_eq!(status_plan.upstream_code.as_deref(), Some("rate_limit"));
        assert!(status_plan.terminal);

        let code_plan = plan_followup_error_envelope(ServertoolFollowupErrorPlanInput {
            error: json!({
                "code": "PROVIDER_NOT_AVAILABLE",
                "reason": "pool empty"
            }),
        });
        assert_eq!(
            code_plan.upstream_code.as_deref(),
            Some("PROVIDER_NOT_AVAILABLE")
        );
        assert!(code_plan.terminal);
    }

    #[test]
    fn followup_error_envelope_preserves_recoverable_non_terminal_error() {
        let plan = plan_followup_error_envelope(ServertoolFollowupErrorPlanInput {
            error: json!({
                "status": 502,
                "code": "HTTP_502",
                "message": "temporary upstream failure"
            }),
        });
        assert_eq!(plan.upstream_status, Some(502));
        assert_eq!(plan.reason.as_deref(), Some("temporary upstream failure"));
        assert!(!plan.terminal);
    }

    #[test]
    fn empty_followup_error_plan_preserves_status_and_details() {
        let plan = plan_empty_followup_error(ServertoolEmptyFollowupErrorPlanInput {
            flow_id: Some("web_search_flow".to_string()),
            request_id: "req-1".to_string(),
            last_error_message: Some("upstream empty".to_string()),
            original_response_was_empty: true,
        });
        assert_eq!(
            plan.message,
            "[servertool] Followup returned empty response for flow web_search_flow"
        );
        assert_eq!(plan.code, "SERVERTOOL_EMPTY_FOLLOWUP");
        assert_eq!(plan.category, "EXTERNAL_ERROR");
        assert_eq!(plan.status, 502);
        assert_eq!(plan.details["flowId"], json!("web_search_flow"));
        assert_eq!(plan.details["requestId"], json!("req-1"));
        assert_eq!(plan.details["error"], json!("upstream empty"));
        assert_eq!(plan.details["originalResponseWasEmpty"], json!(true));
    }

    #[test]
    fn missing_followup_payload_error_plan_reports_plan_and_seed_state() {
        let plan =
            plan_missing_followup_payload_error(ServertoolMissingFollowupPayloadErrorPlanInput {
                flow_id: Some("vision_auto_flow".to_string()),
                request_id: "req-2".to_string(),
                followup_plan: json!({ "injection": {}, "metadata": {} }),
                adapter_context: json!({
                    "capturedEntryRequest": { "messages": [{ "role": "user", "content": "hi" }] }
                }),
            });
        assert_eq!(
            plan.message,
            "[servertool] followup payload missing for non-clientInject flow"
        );
        assert_eq!(plan.code, "SERVERTOOL_FOLLOWUP_FAILED");
        assert_eq!(plan.category, "INTERNAL_ERROR");
        assert_eq!(plan.status, 502);
        assert_eq!(plan.details["flowId"], json!("vision_auto_flow"));
        assert_eq!(plan.details["requestId"], json!("req-2"));
        assert_eq!(plan.details["reason"], json!("followup_payload_missing"));
        assert_eq!(plan.details["hasPayloadPlan"], json!(false));
        assert_eq!(plan.details["hasInjectionPlan"], json!(true));
        assert_eq!(plan.details["hasMetadataPlan"], json!(true));
        assert_eq!(plan.details["hasCapturedEntryRequest"], json!(true));
        assert_eq!(plan.details["capturedSeedAvailable"], json!(true));
    }

    #[test]
    fn bootstrap_replay_plan_fails_preflight_for_400_or_429() {
        let plan = plan_bootstrap_replay(ServertoolBootstrapReplayPlanInput {
            preflight_body: Some(json!({
                "error": {
                    "code": "HTTP_400",
                    "message": "bad tool choice"
                }
            })),
            replay_seed: Some(json!({
                "model": "gpt-test",
                "messages": [{ "role": "user", "content": "hello" }]
            })),
            adapter_context: None,
        });
        let failure = plan.preflight_failure.expect("preflight failure");
        assert_eq!(failure.status, Some(400));
        assert_eq!(failure.code, "HTTP_400");
        assert_eq!(failure.reason.as_deref(), Some("bad tool choice"));
        assert!(plan.replay_payload.is_none());
    }

    #[test]
    fn bootstrap_replay_plan_builds_payload_from_seed_without_preflight_failure() {
        let plan = plan_bootstrap_replay(ServertoolBootstrapReplayPlanInput {
            preflight_body: Some(json!({ "status": "ok" })),
            replay_seed: Some(json!({
                "model": " gpt-test ",
                "messages": [{ "role": "user", "content": "hello" }],
                "tools": [{ "type": "function", "function": { "name": "search" } }],
                "parameters": { "temperature": 0.2 }
            })),
            adapter_context: None,
        });
        assert!(plan.preflight_failure.is_none());
        let payload = plan.replay_payload.expect("replay payload");
        assert_eq!(payload["model"], "gpt-test");
        assert_eq!(payload["messages"][0]["role"], "user");
        assert_eq!(payload["tools"][0]["type"], "function");
        assert_eq!(payload["parameters"]["temperature"], 0.2);
    }

    #[test]
    fn bootstrap_replay_plan_builds_payload_from_adapter_context_seed() {
        let plan = plan_bootstrap_replay(ServertoolBootstrapReplayPlanInput {
            preflight_body: Some(json!({ "status": "ok" })),
            replay_seed: None,
            adapter_context: Some(json!({
                "capturedChatRequest": {
                    "model": " gpt-adapter ",
                    "messages": [{ "role": "user", "content": "from adapter" }],
                    "tools": [{ "type": "function", "function": { "name": "inspect" } }],
                    "parameters": { "temperature": 0.4 }
                }
            })),
        });
        assert!(plan.preflight_failure.is_none());
        let payload = plan.replay_payload.expect("adapter replay payload");
        assert_eq!(payload["model"], "gpt-adapter");
        assert_eq!(payload["messages"][0]["content"], "from adapter");
        assert_eq!(payload["tools"][0]["function"]["name"], "inspect");
        assert_eq!(payload["parameters"]["temperature"], 0.4);
    }
}
