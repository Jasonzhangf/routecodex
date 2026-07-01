// feature_id: hub.servertool_engine_runtime_action_contract
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineRuntimeActionInput {
    pub is_stop_message_flow: bool,
    #[serde(default)]
    pub stopless_execution_flow_id: Option<String>,
    pub stopless_action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolEngineRuntimeAction {
    ReturnServertoolCliProjectionFinal,
    ReturnStopMessageTerminalFinal,
    BuildStopMessageCliProjection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolEngineRuntimeFlowIdSource {
    EngineExecution,
    CurrentFlow,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineRuntimeActionPlan {
    pub action: ServertoolEngineRuntimeAction,
    pub executed: bool,
    pub flow_id_source: ServertoolEngineRuntimeFlowIdSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineTriggerObservationInput {
    pub stop_signal_observed: bool,
    pub result: String,
    #[serde(default)]
    pub flow_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineTriggerObservationPlan {
    pub should_log: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_stop_entry: Option<ServertoolEngineTriggerLogStopEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_stop_compare: Option<ServertoolEngineTriggerLogStopCompare>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineTriggerLogStopEntry {
    pub stage: String,
    pub result: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineTriggerLogStopCompare {
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
}

pub fn plan_servertool_engine_runtime_action(
    input: ServertoolEngineRuntimeActionInput,
) -> Result<ServertoolEngineRuntimeActionPlan, String> {
    let stopless_execution_flow_id = input
        .stopless_execution_flow_id
        .as_deref()
        .unwrap_or_default()
        .trim();
    let has_servertool_cli_projection_context =
        stopless_execution_flow_id == "servertool_cli_projection";

    if !input.is_stop_message_flow && has_servertool_cli_projection_context {
        return Ok(ServertoolEngineRuntimeActionPlan {
            action: ServertoolEngineRuntimeAction::ReturnServertoolCliProjectionFinal,
            executed: true,
            flow_id_source: ServertoolEngineRuntimeFlowIdSource::EngineExecution,
        });
    }
    if input.stopless_action.trim() == "terminal_final" {
        return Ok(ServertoolEngineRuntimeActionPlan {
            action: ServertoolEngineRuntimeAction::ReturnStopMessageTerminalFinal,
            executed: true,
            flow_id_source: ServertoolEngineRuntimeFlowIdSource::EngineExecution,
        });
    }
    if input.is_stop_message_flow && input.stopless_action.trim() == "cli_projection" {
        return Ok(ServertoolEngineRuntimeActionPlan {
            action: ServertoolEngineRuntimeAction::BuildStopMessageCliProjection,
            executed: true,
            flow_id_source: ServertoolEngineRuntimeFlowIdSource::CurrentFlow,
        });
    }
    Err(format!(
        "servertool runtime action has no reenter mainline: isStopMessageFlow={} stoplessAction={} hasPendingInjection={} stoplessExecutionFlowId={}",
        input.is_stop_message_flow,
        input.stopless_action.trim(),
        false,
        stopless_execution_flow_id
    ))
}

pub fn plan_servertool_engine_trigger_observation(
    input: ServertoolEngineTriggerObservationInput,
) -> ServertoolEngineTriggerObservationPlan {
    if !input.stop_signal_observed {
        return ServertoolEngineTriggerObservationPlan {
            should_log: false,
            log_stop_entry: None,
            log_stop_compare: None,
        };
    }

    let result = input.result.trim().to_string();
    ServertoolEngineTriggerObservationPlan {
        should_log: true,
        log_stop_entry: Some(ServertoolEngineTriggerLogStopEntry {
            stage: "trigger".to_string(),
            result,
        }),
        log_stop_compare: Some(ServertoolEngineTriggerLogStopCompare {
            stage: "trigger".to_string(),
            flow_id: input
                .flow_id
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_generic_cli_projection_for_non_stop_flow() {
        let plan = plan_servertool_engine_runtime_action(ServertoolEngineRuntimeActionInput {
            is_stop_message_flow: false,
            stopless_execution_flow_id: Some(" servertool_cli_projection ".to_string()),
            stopless_action: "cli_projection".to_string(),
        })
        .expect("cli projection plan");
        assert_eq!(
            plan.action,
            ServertoolEngineRuntimeAction::ReturnServertoolCliProjectionFinal
        );
        assert_eq!(plan.executed, true);
        assert_eq!(
            plan.flow_id_source,
            ServertoolEngineRuntimeFlowIdSource::EngineExecution
        );
    }

    #[test]
    fn returns_terminal_final_for_stop_message_terminal_action() {
        let plan = plan_servertool_engine_runtime_action(ServertoolEngineRuntimeActionInput {
            is_stop_message_flow: true,
            stopless_execution_flow_id: None,
            stopless_action: "terminal_final".to_string(),
        })
        .expect("terminal plan");
        assert_eq!(
            plan.action,
            ServertoolEngineRuntimeAction::ReturnStopMessageTerminalFinal
        );
        assert_eq!(plan.executed, true);
        assert_eq!(
            plan.flow_id_source,
            ServertoolEngineRuntimeFlowIdSource::EngineExecution
        );
    }

    #[test]
    fn builds_stop_message_cli_projection_only_for_stop_flow() {
        let plan = plan_servertool_engine_runtime_action(ServertoolEngineRuntimeActionInput {
            is_stop_message_flow: true,
            stopless_execution_flow_id: None,
            stopless_action: "cli_projection".to_string(),
        })
        .expect("stopless cli plan");
        assert_eq!(
            plan.action,
            ServertoolEngineRuntimeAction::BuildStopMessageCliProjection
        );
        assert_eq!(plan.executed, true);
        assert_eq!(
            plan.flow_id_source,
            ServertoolEngineRuntimeFlowIdSource::CurrentFlow
        );
    }

    #[test]
    fn fails_fast_when_residual_reenter_mainline_is_requested() {
        let err = plan_servertool_engine_runtime_action(ServertoolEngineRuntimeActionInput {
            is_stop_message_flow: false,
            stopless_execution_flow_id: Some("generic_flow".to_string()),
            stopless_action: "continue".to_string(),
        })
        .expect_err("residual reenter mainline must fail");
        assert!(err.contains("no reenter mainline"));
    }

    #[test]
    fn trigger_observation_noops_when_stop_signal_unobserved() {
        let plan =
            plan_servertool_engine_trigger_observation(ServertoolEngineTriggerObservationInput {
                stop_signal_observed: false,
                result: "non_stop_flow".to_string(),
                flow_id: Some("flow_1".to_string()),
            });
        assert!(!plan.should_log);
        assert!(plan.log_stop_entry.is_none());
        assert!(plan.log_stop_compare.is_none());
    }

    #[test]
    fn trigger_observation_logs_trigger_entry_and_compare() {
        let plan =
            plan_servertool_engine_trigger_observation(ServertoolEngineTriggerObservationInput {
                stop_signal_observed: true,
                result: " skipped_passthrough ".to_string(),
                flow_id: Some(" flow_1 ".to_string()),
            });
        assert!(plan.should_log);
        assert_eq!(
            plan.log_stop_entry,
            Some(ServertoolEngineTriggerLogStopEntry {
                stage: "trigger".to_string(),
                result: "skipped_passthrough".to_string(),
            })
        );
        assert_eq!(
            plan.log_stop_compare,
            Some(ServertoolEngineTriggerLogStopCompare {
                stage: "trigger".to_string(),
                flow_id: Some("flow_1".to_string()),
            })
        );
    }
}
