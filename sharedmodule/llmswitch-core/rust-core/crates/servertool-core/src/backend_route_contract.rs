use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::outcome_contract::{
    build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03,
    ServertoolHubRespChatProcess03Input, ServertoolOutcomeError,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRoutePolicyInput {
    pub tool_name: String,
    pub flow_id: Option<String>,
    pub input: Value,
    pub entry_endpoint: Option<String>,
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
            let skip_reason = resolve_vision_skip_reason(&hint.input);
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
        return Err(ServertoolOutcomeError::InvalidField(
            "decision.outcomeMode",
        ));
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

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(Value::as_str)?.trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
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
    if let Some(adapter) = obj.get("adapterContext") {
        if has_qwen_image_generation_flag(adapter) {
            return true;
        }
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
                input: json!({
                    "adapterContext": {
                        "__rt": {
                            "qwenImageGeneration": {
                                "enabled": true,
                                "mode": "edit"
                            }
                        }
                    }
                }),
                entry_endpoint: None,
            },
        )
        .expect("vision backend route plan");
        assert!(!plan.eligible);
        assert_eq!(plan.skip_reason.as_deref(), Some("qwen_image_generation"));
    }

    #[test]
    fn stop_message_auto_cannot_build_backend_route_policy() {
        let err = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "stop_message_auto".to_string(),
                flow_id: None,
                input: json!({}),
                entry_endpoint: None,
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
        assert_eq!(plan.flow_id.as_deref(), Some("reasoning_stop_finalize_flow"));
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
        assert_eq!(plan.execution_mode, ServertoolFollowupExecutionMode::Reenter);
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
        assert_eq!(err, ServertoolOutcomeError::InvalidField("decision.outcomeMode"));
    }
}
