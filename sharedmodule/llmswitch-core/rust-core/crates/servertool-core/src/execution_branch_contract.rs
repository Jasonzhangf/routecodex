use serde::{Deserialize, Serialize};

// feature_id: hub.servertool_execution_branch_contract

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutableToolCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub execution_mode: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionBranchPlanInput {
    #[serde(default)]
    pub executable_tool_calls: Vec<ServertoolExecutableToolCall>,
    #[serde(default)]
    pub executed_tool_calls_len: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolExecutionBranchAction {
    ClientExecCliProjection,
    ResolveExecutionOutcome,
    ContinueResponseStage,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionBranchPlan {
    pub action: ServertoolExecutionBranchAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projected_tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projected_tool_call_index: Option<usize>,
}

pub fn plan_servertool_execution_branch(
    input: ServertoolExecutionBranchPlanInput,
) -> ServertoolExecutionBranchPlan {
    if let Some(projected) = input
        .executable_tool_calls
        .iter()
        .enumerate()
        .find(|(_, tool_call)| tool_call.execution_mode.trim() == "client_exec_cli_projection")
    {
        let (projected_tool_call_index, projected_tool_call) = projected;
        if projected_tool_call.name.trim() == "stop_message_auto" {
            return ServertoolExecutionBranchPlan {
                action: ServertoolExecutionBranchAction::ContinueResponseStage,
                projected_tool_call_id: None,
                projected_tool_call_index: None,
            };
        }
        let projected_tool_call_id = projected_tool_call.id.trim();
        return ServertoolExecutionBranchPlan {
            action: ServertoolExecutionBranchAction::ClientExecCliProjection,
            projected_tool_call_id: if projected_tool_call_id.is_empty() {
                None
            } else {
                Some(projected_tool_call_id.to_string())
            },
            projected_tool_call_index: Some(projected_tool_call_index),
        };
    }
    if input.executed_tool_calls_len > 0 {
        return ServertoolExecutionBranchPlan {
            action: ServertoolExecutionBranchAction::ResolveExecutionOutcome,
            projected_tool_call_id: None,
            projected_tool_call_index: None,
        };
    }
    ServertoolExecutionBranchPlan {
        action: ServertoolExecutionBranchAction::ContinueResponseStage,
        projected_tool_call_id: None,
        projected_tool_call_index: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        plan_servertool_execution_branch, ServertoolExecutableToolCall,
        ServertoolExecutionBranchAction, ServertoolExecutionBranchPlanInput,
    };

    #[test]
    fn plans_cli_projection_before_other_actions_for_non_stop_message_auto() {
        let plan = plan_servertool_execution_branch(ServertoolExecutionBranchPlanInput {
            executable_tool_calls: vec![ServertoolExecutableToolCall {
                id: " call_1 ".to_string(),
                name: "web_search".to_string(),
                execution_mode: "client_exec_cli_projection".to_string(),
            }],
            executed_tool_calls_len: 1,
        });
        assert_eq!(
            plan.action,
            ServertoolExecutionBranchAction::ClientExecCliProjection
        );
        assert_eq!(plan.projected_tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(plan.projected_tool_call_index, Some(0));
    }

    #[test]
    fn continues_response_stage_for_stop_message_auto_projection_candidate() {
        let plan = plan_servertool_execution_branch(ServertoolExecutionBranchPlanInput {
            executable_tool_calls: vec![ServertoolExecutableToolCall {
                id: " call_stopless ".to_string(),
                name: " stop_message_auto ".to_string(),
                execution_mode: "client_exec_cli_projection".to_string(),
            }],
            executed_tool_calls_len: 0,
        });
        assert_eq!(
            plan.action,
            ServertoolExecutionBranchAction::ContinueResponseStage
        );
        assert_eq!(plan.projected_tool_call_id, None);
        assert_eq!(plan.projected_tool_call_index, None);
    }

    #[test]
    fn plans_execution_outcome_when_any_tool_already_executed() {
        let plan = plan_servertool_execution_branch(ServertoolExecutionBranchPlanInput {
            executable_tool_calls: vec![],
            executed_tool_calls_len: 2,
        });
        assert_eq!(
            plan.action,
            ServertoolExecutionBranchAction::ResolveExecutionOutcome
        );
        assert_eq!(plan.projected_tool_call_id, None);
        assert_eq!(plan.projected_tool_call_index, None);
    }

    #[test]
    fn continues_response_stage_when_no_projection_and_no_execution() {
        let plan = plan_servertool_execution_branch(ServertoolExecutionBranchPlanInput {
            executable_tool_calls: vec![ServertoolExecutableToolCall {
                id: "call_2".to_string(),
                name: "web_search".to_string(),
                execution_mode: "backend".to_string(),
            }],
            executed_tool_calls_len: 0,
        });
        assert_eq!(
            plan.action,
            ServertoolExecutionBranchAction::ContinueResponseStage
        );
    }
}
