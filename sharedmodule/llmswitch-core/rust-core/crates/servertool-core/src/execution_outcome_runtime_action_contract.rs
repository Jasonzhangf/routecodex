// feature_id: hub.servertool_execution_outcome_runtime_action_contract
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionOutcomeRuntimeActionInput {
    pub outcome_mode: String,
    pub requires_pending_injection: bool,
    pub followup_strategy: String,
    pub use_last_execution_followup: bool,
    pub has_last_execution_followup: bool,
    pub has_resolved_followup: bool,
    pub has_last_execution: bool,
    pub executed_tool_calls_len: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_execution: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_followup: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alias_session_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remaining_tool_call_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_injection_messages_resolved: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolExecutionOutcomeRuntimeAction {
    InvalidMixedClientToolsOutcome,
    ReuseLastExecutionFollowup,
    UseResolvedFollowup,
    MissingFollowupContract,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionOutcomeRuntimeActionPlan {
    pub action: ServertoolExecutionOutcomeRuntimeAction,
    pub reuse_last_execution_envelope: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_followup: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_execution_envelope: Option<Value>,
    pub execution_flow_id: String,
}

pub fn plan_servertool_execution_outcome_runtime_action(
    input: ServertoolExecutionOutcomeRuntimeActionInput,
) -> ServertoolExecutionOutcomeRuntimeActionPlan {
    let default_flow_id = if input.outcome_mode.trim() == "mixed_client_tools" {
        "servertool_mixed".to_string()
    } else {
        "servertool_multi".to_string()
    };
    let execution_flow_id = input
        .flow_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_flow_id.as_str())
        .to_string();

    if input.outcome_mode.trim() == "mixed_client_tools" {
        return ServertoolExecutionOutcomeRuntimeActionPlan {
            action: ServertoolExecutionOutcomeRuntimeAction::InvalidMixedClientToolsOutcome,
            reuse_last_execution_envelope: false,
            selected_followup: None,
            selected_execution_envelope: None,
            execution_flow_id,
        };
    }

    if input.use_last_execution_followup
        && input.followup_strategy.trim() == "reuse_last_execution"
        && input.has_last_execution_followup
    {
        let reuse_last_execution_envelope =
            input.has_last_execution && input.executed_tool_calls_len == 1;
        let selected_followup = input
            .last_execution
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|row| row.get("followup"))
            .cloned();
        return ServertoolExecutionOutcomeRuntimeActionPlan {
            action: ServertoolExecutionOutcomeRuntimeAction::ReuseLastExecutionFollowup,
            reuse_last_execution_envelope,
            selected_followup,
            selected_execution_envelope: if reuse_last_execution_envelope {
                input.last_execution.clone()
            } else {
                None
            },
            execution_flow_id,
        };
    }

    if input.has_resolved_followup {
        return ServertoolExecutionOutcomeRuntimeActionPlan {
            action: ServertoolExecutionOutcomeRuntimeAction::UseResolvedFollowup,
            reuse_last_execution_envelope: false,
            selected_followup: input.resolved_followup,
            selected_execution_envelope: None,
            execution_flow_id,
        };
    }

    ServertoolExecutionOutcomeRuntimeActionPlan {
        action: ServertoolExecutionOutcomeRuntimeAction::MissingFollowupContract,
        reuse_last_execution_envelope: false,
        selected_followup: None,
        selected_execution_envelope: None,
        execution_flow_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_mixed_pending_injection_after_feature_removal() {
        let plan = plan_servertool_execution_outcome_runtime_action(
            ServertoolExecutionOutcomeRuntimeActionInput {
                outcome_mode: "mixed_client_tools".to_string(),
                requires_pending_injection: true,
                followup_strategy: "pending_injection".to_string(),
                use_last_execution_followup: false,
                has_last_execution_followup: false,
                has_resolved_followup: false,
                has_last_execution: false,
                executed_tool_calls_len: 0,
                last_execution: None,
                resolved_followup: None,
                flow_id: Some("mixed_flow".to_string()),
                pending_session_id: Some("sess_1".to_string()),
                alias_session_ids: vec!["alias_1".to_string()],
                remaining_tool_call_ids: vec!["call_2".to_string()],
                pending_injection_messages_resolved: vec![serde_json::json!({
                    "role": "assistant"
                })],
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeRuntimeAction::InvalidMixedClientToolsOutcome
        );
        assert!(!plan.reuse_last_execution_envelope);
        assert_eq!(plan.execution_flow_id, "mixed_flow");
    }

    #[test]
    fn rejects_invalid_mixed_client_tools_contract() {
        let plan = plan_servertool_execution_outcome_runtime_action(
            ServertoolExecutionOutcomeRuntimeActionInput {
                outcome_mode: "mixed_client_tools".to_string(),
                requires_pending_injection: false,
                followup_strategy: "reuse_last_execution".to_string(),
                use_last_execution_followup: false,
                has_last_execution_followup: false,
                has_resolved_followup: false,
                has_last_execution: false,
                executed_tool_calls_len: 0,
                last_execution: None,
                resolved_followup: None,
                flow_id: None,
                pending_session_id: None,
                alias_session_ids: vec![],
                remaining_tool_call_ids: vec![],
                pending_injection_messages_resolved: vec![],
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeRuntimeAction::InvalidMixedClientToolsOutcome
        );
        assert!(!plan.reuse_last_execution_envelope);
    }

    #[test]
    fn reuses_last_execution_followup_when_contract_matches() {
        let plan = plan_servertool_execution_outcome_runtime_action(
            ServertoolExecutionOutcomeRuntimeActionInput {
                outcome_mode: "servertool_only".to_string(),
                requires_pending_injection: false,
                followup_strategy: "reuse_last_execution".to_string(),
                use_last_execution_followup: true,
                has_last_execution_followup: true,
                has_resolved_followup: true,
                has_last_execution: true,
                executed_tool_calls_len: 1,
                last_execution: Some(serde_json::json!({
                    "flowId": "flow_1",
                    "followup": {
                        "requestIdSuffix": ":reuse"
                    },
                    "context": {
                        "kept": true
                    }
                })),
                resolved_followup: Some(serde_json::json!({
                    "requestIdSuffix": ":resolved"
                })),
                flow_id: Some("servertool_multi".to_string()),
                pending_session_id: None,
                alias_session_ids: vec![],
                remaining_tool_call_ids: vec![],
                pending_injection_messages_resolved: vec![],
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeRuntimeAction::ReuseLastExecutionFollowup
        );
        assert!(plan.reuse_last_execution_envelope);
        assert_eq!(
            plan.selected_followup,
            Some(serde_json::json!({
                "requestIdSuffix": ":reuse"
            }))
        );
        assert_eq!(
            plan.selected_execution_envelope,
            Some(serde_json::json!({
                "flowId": "flow_1",
                "followup": {
                    "requestIdSuffix": ":reuse"
                },
                "context": {
                    "kept": true
                }
            }))
        );
    }

    #[test]
    fn keeps_followup_but_does_not_reuse_last_execution_envelope_for_multi_tool_outcome() {
        let plan = plan_servertool_execution_outcome_runtime_action(
            ServertoolExecutionOutcomeRuntimeActionInput {
                outcome_mode: "servertool_only".to_string(),
                requires_pending_injection: false,
                followup_strategy: "reuse_last_execution".to_string(),
                use_last_execution_followup: true,
                has_last_execution_followup: true,
                has_resolved_followup: true,
                has_last_execution: true,
                executed_tool_calls_len: 2,
                last_execution: Some(serde_json::json!({
                    "flowId": "flow_2",
                    "followup": {
                        "requestIdSuffix": ":reuse"
                    }
                })),
                resolved_followup: Some(serde_json::json!({
                    "requestIdSuffix": ":resolved"
                })),
                flow_id: None,
                pending_session_id: None,
                alias_session_ids: vec![],
                remaining_tool_call_ids: vec![],
                pending_injection_messages_resolved: vec![],
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeRuntimeAction::ReuseLastExecutionFollowup
        );
        assert!(!plan.reuse_last_execution_envelope);
        assert_eq!(
            plan.selected_followup,
            Some(serde_json::json!({
                "requestIdSuffix": ":reuse"
            }))
        );
        assert_eq!(plan.selected_execution_envelope, None);
    }

    #[test]
    fn uses_resolved_followup_when_available() {
        let plan = plan_servertool_execution_outcome_runtime_action(
            ServertoolExecutionOutcomeRuntimeActionInput {
                outcome_mode: "servertool_only".to_string(),
                requires_pending_injection: false,
                followup_strategy: "generic".to_string(),
                use_last_execution_followup: false,
                has_last_execution_followup: false,
                has_resolved_followup: true,
                has_last_execution: false,
                executed_tool_calls_len: 0,
                last_execution: None,
                resolved_followup: Some(serde_json::json!({
                    "requestIdSuffix": ":resolved"
                })),
                flow_id: Some("resolved_flow".to_string()),
                pending_session_id: None,
                alias_session_ids: vec![],
                remaining_tool_call_ids: vec![],
                pending_injection_messages_resolved: vec![],
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeRuntimeAction::UseResolvedFollowup
        );
        assert!(!plan.reuse_last_execution_envelope);
        assert_eq!(
            plan.selected_followup,
            Some(serde_json::json!({
                "requestIdSuffix": ":resolved"
            }))
        );
        assert_eq!(plan.execution_flow_id, "resolved_flow");
    }

    #[test]
    fn fails_when_no_followup_contract_exists() {
        let plan = plan_servertool_execution_outcome_runtime_action(
            ServertoolExecutionOutcomeRuntimeActionInput {
                outcome_mode: "servertool_only".to_string(),
                requires_pending_injection: false,
                followup_strategy: "generic".to_string(),
                use_last_execution_followup: false,
                has_last_execution_followup: false,
                has_resolved_followup: false,
                has_last_execution: false,
                executed_tool_calls_len: 0,
                last_execution: None,
                resolved_followup: None,
                flow_id: None,
                pending_session_id: None,
                alias_session_ids: vec![],
                remaining_tool_call_ids: vec![],
                pending_injection_messages_resolved: vec![],
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeRuntimeAction::MissingFollowupContract
        );
        assert!(!plan.reuse_last_execution_envelope);
    }
}
