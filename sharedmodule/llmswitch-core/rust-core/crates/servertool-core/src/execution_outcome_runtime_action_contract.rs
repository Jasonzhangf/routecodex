// feature_id: hub.servertool_execution_outcome_runtime_action_contract
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionOutcomeRuntimeActionInput {
    pub outcome_mode: String,
    pub has_last_execution: bool,
    pub executed_tool_calls_len: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_execution: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolExecutionOutcomeRuntimeAction {
    InvalidMixedClientToolsOutcome,
    ReturnExecutionContract,
    MissingServertoolExecutionContract,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionOutcomeRuntimeActionPlan {
    pub action: ServertoolExecutionOutcomeRuntimeAction,
    pub reuse_last_execution_envelope: bool,
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
            selected_execution_envelope: None,
            execution_flow_id,
        };
    }

    if input.has_last_execution || input.executed_tool_calls_len > 0 {
        return ServertoolExecutionOutcomeRuntimeActionPlan {
            action: ServertoolExecutionOutcomeRuntimeAction::ReturnExecutionContract,
            reuse_last_execution_envelope: false,
            selected_execution_envelope: None,
            execution_flow_id,
        };
    }

    ServertoolExecutionOutcomeRuntimeActionPlan {
        action: ServertoolExecutionOutcomeRuntimeAction::MissingServertoolExecutionContract,
        reuse_last_execution_envelope: false,
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
                has_last_execution: false,
                executed_tool_calls_len: 0,
                last_execution: None,
                flow_id: Some("mixed_flow".to_string()),
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
                has_last_execution: false,
                executed_tool_calls_len: 0,
                last_execution: None,
                flow_id: None,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeRuntimeAction::InvalidMixedClientToolsOutcome
        );
        assert!(!plan.reuse_last_execution_envelope);
    }

    #[test]
    fn returns_execution_contract_without_followup_selection_when_execution_exists() {
        let plan = plan_servertool_execution_outcome_runtime_action(
            ServertoolExecutionOutcomeRuntimeActionInput {
                outcome_mode: "servertool_only".to_string(),
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
                flow_id: Some("servertool_multi".to_string()),
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeRuntimeAction::ReturnExecutionContract
        );
        assert!(!plan.reuse_last_execution_envelope);
        assert_eq!(plan.selected_execution_envelope, None);
    }

    #[test]
    fn returns_execution_contract_for_multi_tool_outcome() {
        let plan = plan_servertool_execution_outcome_runtime_action(
            ServertoolExecutionOutcomeRuntimeActionInput {
                outcome_mode: "servertool_only".to_string(),
                has_last_execution: true,
                executed_tool_calls_len: 2,
                last_execution: Some(serde_json::json!({
                    "flowId": "flow_2",
                    "followup": {
                        "requestIdSuffix": ":reuse"
                    }
                })),
                flow_id: None,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeRuntimeAction::ReturnExecutionContract
        );
        assert!(!plan.reuse_last_execution_envelope);
        assert_eq!(plan.selected_execution_envelope, None);
    }

    #[test]
    fn returns_execution_contract_when_execution_count_is_present() {
        let plan = plan_servertool_execution_outcome_runtime_action(
            ServertoolExecutionOutcomeRuntimeActionInput {
                outcome_mode: "servertool_only".to_string(),
                has_last_execution: false,
                executed_tool_calls_len: 1,
                last_execution: None,
                flow_id: Some("resolved_flow".to_string()),
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeRuntimeAction::ReturnExecutionContract
        );
        assert!(!plan.reuse_last_execution_envelope);
        assert_eq!(plan.execution_flow_id, "resolved_flow");
    }

    #[test]
    fn fails_when_no_execution_contract_exists() {
        let plan = plan_servertool_execution_outcome_runtime_action(
            ServertoolExecutionOutcomeRuntimeActionInput {
                outcome_mode: "servertool_only".to_string(),
                has_last_execution: false,
                executed_tool_calls_len: 0,
                last_execution: None,
                flow_id: None,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeRuntimeAction::MissingServertoolExecutionContract
        );
        assert!(!plan.reuse_last_execution_envelope);
    }
}
