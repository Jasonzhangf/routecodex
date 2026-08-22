use serde::{Deserialize, Serialize};
use serde_json::Value;

// feature_id: hub.servertool_engine_selection

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSelectionStartInput {
    #[serde(default)]
    pub primary_auto_hook_ids: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineSelectionStartPlan {
    pub action: EngineSelectionAction,
    pub overrides: EngineSelectionOverrides,
    pub primary_auto_hook_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSelectionAfterRunInput {
    pub primary_auto_hook_ids: Vec<String>,
    pub engine_result: Value,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineSelectionAfterRunPlan {
    pub action: EngineSelectionAction,
    pub overrides: Option<EngineSelectionOverrides>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EngineSelectionAction {
    RunDefault,
    RunPrimaryHooks,
    RerunExcludingPrimaryHooks,
    ReturnCurrent,
}

#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineSelectionOverrides {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_tool_call_handlers: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub include_auto_hook_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub exclude_auto_hook_ids: Vec<String>,
}

pub fn plan_engine_selection_start(input: EngineSelectionStartInput) -> EngineSelectionStartPlan {
    let primary_auto_hook_ids = normalize_hook_ids(input.primary_auto_hook_ids);
    if primary_auto_hook_ids.is_empty() {
        return EngineSelectionStartPlan {
            action: EngineSelectionAction::RunDefault,
            overrides: EngineSelectionOverrides::default(),
            primary_auto_hook_ids,
        };
    }
    EngineSelectionStartPlan {
        action: EngineSelectionAction::RunPrimaryHooks,
        overrides: EngineSelectionOverrides {
            disable_tool_call_handlers: Some(true),
            include_auto_hook_ids: primary_auto_hook_ids.clone(),
            exclude_auto_hook_ids: Vec::new(),
        },
        primary_auto_hook_ids,
    }
}

pub fn plan_engine_selection_after_run(
    input: EngineSelectionAfterRunInput,
) -> EngineSelectionAfterRunPlan {
    let primary_auto_hook_ids = normalize_hook_ids(input.primary_auto_hook_ids);
    if primary_auto_hook_ids.is_empty() || engine_result_has_execution(&input.engine_result) {
        return EngineSelectionAfterRunPlan {
            action: EngineSelectionAction::ReturnCurrent,
            overrides: None,
        };
    }
    EngineSelectionAfterRunPlan {
        action: EngineSelectionAction::RerunExcludingPrimaryHooks,
        overrides: Some(EngineSelectionOverrides {
            disable_tool_call_handlers: None,
            include_auto_hook_ids: Vec::new(),
            exclude_auto_hook_ids: primary_auto_hook_ids,
        }),
    }
}

fn normalize_hook_ids(values: Vec<String>) -> Vec<String> {
    let mut output = Vec::new();
    for value in values {
        let normalized = value.trim().to_string();
        if !normalized.is_empty() && !output.iter().any(|existing| existing == &normalized) {
            output.push(normalized);
        }
    }
    output
}

fn engine_result_has_execution(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    if record.get("mode").and_then(Value::as_str) == Some("passthrough") {
        return false;
    }
    match record.get("execution") {
        Some(Value::Null) | None => false,
        Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) | Some(Value::Bool(true)) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        plan_engine_selection_after_run, plan_engine_selection_start, EngineSelectionAction,
        EngineSelectionAfterRunInput, EngineSelectionStartInput,
    };
    use serde_json::json;

    #[test]
    fn start_runs_default_without_primary_hooks() {
        let plan = plan_engine_selection_start(EngineSelectionStartInput {
            primary_auto_hook_ids: vec![" ".to_string()],
        });
        assert_eq!(plan.action, EngineSelectionAction::RunDefault);
        assert!(plan.overrides.include_auto_hook_ids.is_empty());
    }

    #[test]
    fn start_runs_primary_hooks_with_deduped_ids() {
        let plan = plan_engine_selection_start(EngineSelectionStartInput {
            primary_auto_hook_ids: vec![
                " stop_message_auto ".to_string(),
                "stop_message_auto".to_string(),
                "vision_auto".to_string(),
            ],
        });
        assert_eq!(plan.action, EngineSelectionAction::RunPrimaryHooks);
        assert_eq!(
            plan.overrides.include_auto_hook_ids,
            vec!["stop_message_auto", "vision_auto"]
        );
        assert_eq!(plan.overrides.disable_tool_call_handlers, Some(true));
    }

    #[test]
    fn after_run_reruns_when_primary_attempt_passthrough_or_has_no_execution() {
        let hooks = vec!["stop_message_auto".to_string()];
        let passthrough = plan_engine_selection_after_run(EngineSelectionAfterRunInput {
            primary_auto_hook_ids: hooks.clone(),
            engine_result: json!({ "mode": "passthrough" }),
        });
        assert_eq!(
            passthrough.action,
            EngineSelectionAction::RerunExcludingPrimaryHooks
        );
        assert_eq!(
            passthrough.overrides.unwrap().exclude_auto_hook_ids,
            vec!["stop_message_auto"]
        );

        let no_execution = plan_engine_selection_after_run(EngineSelectionAfterRunInput {
            primary_auto_hook_ids: hooks,
            engine_result: json!({ "mode": "tool_flow" }),
        });
        assert_eq!(
            no_execution.action,
            EngineSelectionAction::RerunExcludingPrimaryHooks
        );
    }

    #[test]
    fn after_run_returns_current_when_execution_exists() {
        let plan = plan_engine_selection_after_run(EngineSelectionAfterRunInput {
            primary_auto_hook_ids: vec!["stop_message_auto".to_string()],
            engine_result: json!({ "mode": "tool_flow", "execution": { "flowId": "stop_message_flow" } }),
        });
        assert_eq!(plan.action, EngineSelectionAction::ReturnCurrent);
        assert!(plan.overrides.is_none());

        let empty_execution = plan_engine_selection_after_run(EngineSelectionAfterRunInput {
            primary_auto_hook_ids: vec!["stop_message_auto".to_string()],
            engine_result: json!({ "mode": "tool_flow", "execution": {} }),
        });
        assert_eq!(empty_execution.action, EngineSelectionAction::ReturnCurrent);
    }
}
