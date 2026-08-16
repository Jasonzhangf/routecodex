use serde::{Deserialize, Serialize};

// feature_id: hub.servertool_execution_branch_contract

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutableToolCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolExecutionBranchAction {
    ClientExecCliProjection,
    ResolveExecutionOutcome,
    ContinueResponseStage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionBranchPlan {
    pub action: ServertoolExecutionBranchAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projected_tool_call: Option<ServertoolProjectedToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projected_tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projected_tool_call_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolProjectedToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionBranchApplicationInput {
    pub branch_plan: ServertoolExecutionBranchPlan,
    #[serde(default)]
    pub phase: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionBranchApplicationPlan {
    pub project_client_exec_cli: bool,
    pub resolve_execution_outcome: bool,
    pub continue_response_stage: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projected_tool_call: Option<ServertoolProjectedToolCall>,
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
                projected_tool_call: None,
                projected_tool_call_id: None,
                projected_tool_call_index: None,
            };
        }
        let projected_tool_call_id = projected_tool_call.id.trim();
        let projected_tool_call_name = projected_tool_call.name.trim();
        return ServertoolExecutionBranchPlan {
            action: ServertoolExecutionBranchAction::ClientExecCliProjection,
            projected_tool_call: Some(ServertoolProjectedToolCall {
                id: projected_tool_call_id.to_string(),
                name: projected_tool_call_name.to_string(),
                arguments: projected_tool_call.arguments.clone(),
            }),
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
            projected_tool_call: None,
            projected_tool_call_id: None,
            projected_tool_call_index: None,
        };
    }
    ServertoolExecutionBranchPlan {
        action: ServertoolExecutionBranchAction::ContinueResponseStage,
        projected_tool_call: None,
        projected_tool_call_id: None,
        projected_tool_call_index: None,
    }
}

pub fn plan_servertool_execution_branch_application(
    input: ServertoolExecutionBranchApplicationInput,
) -> Result<ServertoolExecutionBranchApplicationPlan, String> {
    match input.branch_plan.action {
        ServertoolExecutionBranchAction::ClientExecCliProjection => {
            if input.phase.trim() != "pre_execution" {
                return Err("client exec cli projection is only valid before execution".to_string());
            }
            let projected_tool_call = input.branch_plan.projected_tool_call.ok_or_else(|| {
                "client exec cli projection missing projected tool call".to_string()
            })?;
            Ok(ServertoolExecutionBranchApplicationPlan {
                project_client_exec_cli: true,
                resolve_execution_outcome: false,
                continue_response_stage: false,
                projected_tool_call: Some(projected_tool_call),
            })
        }
        ServertoolExecutionBranchAction::ResolveExecutionOutcome => {
            if input.phase.trim() != "post_execution" {
                return Err("resolve execution outcome is only valid after execution".to_string());
            }
            Ok(ServertoolExecutionBranchApplicationPlan {
                project_client_exec_cli: false,
                resolve_execution_outcome: true,
                continue_response_stage: false,
                projected_tool_call: None,
            })
        }
        ServertoolExecutionBranchAction::ContinueResponseStage => {
            Ok(ServertoolExecutionBranchApplicationPlan {
                project_client_exec_cli: false,
                resolve_execution_outcome: false,
                continue_response_stage: true,
                projected_tool_call: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        plan_servertool_execution_branch, plan_servertool_execution_branch_application,
        ServertoolExecutableToolCall, ServertoolExecutionBranchAction,
        ServertoolExecutionBranchApplicationInput, ServertoolExecutionBranchPlanInput,
    };

    #[test]
    fn plans_cli_projection_before_other_actions_for_non_stop_message_auto() {
        let plan = plan_servertool_execution_branch(ServertoolExecutionBranchPlanInput {
            executable_tool_calls: vec![ServertoolExecutableToolCall {
                id: " call_1 ".to_string(),
                name: "web_search".to_string(),
                arguments: "{\"query\":\"rust\"}".to_string(),
                execution_mode: "client_exec_cli_projection".to_string(),
            }],
            executed_tool_calls_len: 1,
        });
        assert_eq!(
            plan.action,
            ServertoolExecutionBranchAction::ClientExecCliProjection
        );
        assert_eq!(
            plan.projected_tool_call,
            Some(super::ServertoolProjectedToolCall {
                id: "call_1".to_string(),
                name: "web_search".to_string(),
                arguments: "{\"query\":\"rust\"}".to_string(),
            })
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
                arguments: "{}".to_string(),
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
                arguments: "{}".to_string(),
                execution_mode: "backend".to_string(),
            }],
            executed_tool_calls_len: 0,
        });
        assert_eq!(
            plan.action,
            ServertoolExecutionBranchAction::ContinueResponseStage
        );
    }

    #[test]
    fn application_projects_client_exec_cli_before_execution() {
        let branch_plan = plan_servertool_execution_branch(ServertoolExecutionBranchPlanInput {
            executable_tool_calls: vec![ServertoolExecutableToolCall {
                id: " call_1 ".to_string(),
                name: "web_search".to_string(),
                arguments: "{}".to_string(),
                execution_mode: "client_exec_cli_projection".to_string(),
            }],
            executed_tool_calls_len: 0,
        });
        let application = plan_servertool_execution_branch_application(
            ServertoolExecutionBranchApplicationInput {
                branch_plan,
                phase: "pre_execution".to_string(),
            },
        )
        .expect("application plan");

        assert_eq!(application.project_client_exec_cli, true);
        assert_eq!(application.resolve_execution_outcome, false);
        assert_eq!(application.continue_response_stage, false);
        assert_eq!(
            application.projected_tool_call,
            Some(super::ServertoolProjectedToolCall {
                id: "call_1".to_string(),
                name: "web_search".to_string(),
                arguments: "{}".to_string(),
            })
        );
    }

    #[test]
    fn application_resolves_execution_outcome_after_execution() {
        let branch_plan = plan_servertool_execution_branch(ServertoolExecutionBranchPlanInput {
            executable_tool_calls: vec![],
            executed_tool_calls_len: 1,
        });
        let application = plan_servertool_execution_branch_application(
            ServertoolExecutionBranchApplicationInput {
                branch_plan,
                phase: "post_execution".to_string(),
            },
        )
        .expect("application plan");

        assert_eq!(application.project_client_exec_cli, false);
        assert_eq!(application.resolve_execution_outcome, true);
        assert_eq!(application.continue_response_stage, false);
    }

    #[test]
    fn application_rejects_projection_after_execution() {
        let branch_plan = plan_servertool_execution_branch(ServertoolExecutionBranchPlanInput {
            executable_tool_calls: vec![ServertoolExecutableToolCall {
                id: "call_1".to_string(),
                name: "web_search".to_string(),
                arguments: "{}".to_string(),
                execution_mode: "client_exec_cli_projection".to_string(),
            }],
            executed_tool_calls_len: 0,
        });
        let err = plan_servertool_execution_branch_application(
            ServertoolExecutionBranchApplicationInput {
                branch_plan,
                phase: "post_execution".to_string(),
            },
        )
        .expect_err("projection after execution must fail");

        assert!(err.contains("only valid before execution"));
    }
}
