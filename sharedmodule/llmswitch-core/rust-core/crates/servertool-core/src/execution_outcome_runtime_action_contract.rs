// feature_id: hub.servertool_execution_outcome_runtime_action_contract
use crate::execution_dispatch_contract::{
    plan_servertool_invalid_mixed_client_tools_outcome_error,
    plan_servertool_missing_execution_contract_error,
    ServertoolInvalidMixedClientToolsOutcomeErrorInput,
    ServertoolMissingExecutionContractErrorInput,
};
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionOutcomeMaterializationInput {
    pub request_id: String,
    pub outcome_mode: String,
    pub requires_pending_injection: bool,
    pub has_last_execution: bool,
    pub executed_tool_calls_len: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_execution: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolExecutionOutcomeMaterializationAction {
    ThrowDispatchError,
    ReturnToolFlow,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionOutcomeMaterializationPlan {
    pub action: ServertoolExecutionOutcomeMaterializationAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_plan: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_flow_id: Option<String>,
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

pub fn plan_servertool_execution_outcome_materialization(
    input: ServertoolExecutionOutcomeMaterializationInput,
) -> ServertoolExecutionOutcomeMaterializationPlan {
    let runtime_plan = plan_servertool_execution_outcome_runtime_action(
        ServertoolExecutionOutcomeRuntimeActionInput {
            outcome_mode: input.outcome_mode.clone(),
            has_last_execution: input.has_last_execution,
            executed_tool_calls_len: input.executed_tool_calls_len,
            last_execution: input.last_execution,
            flow_id: input.flow_id,
        },
    );

    match runtime_plan.action {
        ServertoolExecutionOutcomeRuntimeAction::InvalidMixedClientToolsOutcome => {
            ServertoolExecutionOutcomeMaterializationPlan {
                action: ServertoolExecutionOutcomeMaterializationAction::ThrowDispatchError,
                error_plan: Some(plan_servertool_invalid_mixed_client_tools_outcome_error(
                    &ServertoolInvalidMixedClientToolsOutcomeErrorInput {
                        request_id: input.request_id,
                        outcome_mode: input.outcome_mode,
                        requires_pending_injection: input.requires_pending_injection,
                    },
                )),
                execution_flow_id: None,
            }
        }
        ServertoolExecutionOutcomeRuntimeAction::MissingServertoolExecutionContract => {
            ServertoolExecutionOutcomeMaterializationPlan {
                action: ServertoolExecutionOutcomeMaterializationAction::ThrowDispatchError,
                error_plan: Some(plan_servertool_missing_execution_contract_error(
                    &ServertoolMissingExecutionContractErrorInput {
                        request_id: input.request_id,
                        outcome_mode: input.outcome_mode,
                    },
                )),
                execution_flow_id: None,
            }
        }
        ServertoolExecutionOutcomeRuntimeAction::ReturnExecutionContract => {
            ServertoolExecutionOutcomeMaterializationPlan {
                action: ServertoolExecutionOutcomeMaterializationAction::ReturnToolFlow,
                error_plan: None,
                execution_flow_id: Some(runtime_plan.execution_flow_id),
            }
        }
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
        assert_eq!(plan.execution_flow_id, "servertool_multi");
    }

    #[test]
    fn defaults_blank_flow_id_in_rust() {
        let plan = plan_servertool_execution_outcome_runtime_action(
            ServertoolExecutionOutcomeRuntimeActionInput {
                outcome_mode: "mixed_client_tools".to_string(),
                has_last_execution: false,
                executed_tool_calls_len: 0,
                last_execution: None,
                flow_id: Some("  ".to_string()),
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeRuntimeAction::InvalidMixedClientToolsOutcome
        );
        assert_eq!(plan.execution_flow_id, "servertool_mixed");
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

    #[test]
    fn materialization_plans_mixed_client_tools_dispatch_error() {
        let plan = plan_servertool_execution_outcome_materialization(
            ServertoolExecutionOutcomeMaterializationInput {
                request_id: "req-mixed".to_string(),
                outcome_mode: "mixed_client_tools".to_string(),
                requires_pending_injection: true,
                has_last_execution: false,
                executed_tool_calls_len: 0,
                last_execution: None,
                flow_id: None,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeMaterializationAction::ThrowDispatchError
        );
        assert_eq!(
            plan.error_plan.unwrap()["details"]["requiresPendingInjection"],
            true
        );
        assert_eq!(plan.execution_flow_id, None);
    }

    #[test]
    fn materialization_plans_missing_execution_dispatch_error() {
        let plan = plan_servertool_execution_outcome_materialization(
            ServertoolExecutionOutcomeMaterializationInput {
                request_id: "req-missing".to_string(),
                outcome_mode: "servertool_only".to_string(),
                requires_pending_injection: false,
                has_last_execution: false,
                executed_tool_calls_len: 0,
                last_execution: None,
                flow_id: None,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeMaterializationAction::ThrowDispatchError
        );
        assert_eq!(
            plan.error_plan.unwrap()["message"],
            "[servertool] missing native execution contract for servertool-only outcome"
        );
        assert_eq!(plan.execution_flow_id, None);
    }

    #[test]
    fn materialization_plans_tool_flow_return() {
        let plan = plan_servertool_execution_outcome_materialization(
            ServertoolExecutionOutcomeMaterializationInput {
                request_id: "req-tool-flow".to_string(),
                outcome_mode: "servertool_only".to_string(),
                requires_pending_injection: false,
                has_last_execution: true,
                executed_tool_calls_len: 1,
                last_execution: None,
                flow_id: Some("flow-return".to_string()),
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionOutcomeMaterializationAction::ReturnToolFlow
        );
        assert_eq!(plan.error_plan, None);
        assert_eq!(plan.execution_flow_id, Some("flow-return".to_string()));
    }
}
