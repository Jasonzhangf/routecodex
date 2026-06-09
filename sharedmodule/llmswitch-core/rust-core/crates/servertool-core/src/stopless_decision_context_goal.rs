use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessDecisionContextGoalInput {
    pub adapter_context: Value,
    pub persisted_goal_state: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessDecisionContextGoalPlan {
    pub goal_status: String,
    pub has_request_scoped_goal_state: bool,
}

pub fn plan_stopless_decision_context_goal_status(
    input: &StoplessDecisionContextGoalInput,
) -> StoplessDecisionContextGoalPlan {
    let direct_state: Option<&Value> = read_direct_goal_state(&input.adapter_context);
    let source = input
        .adapter_context
        .get("__rt")
        .filter(|value| value.is_object())
        .and_then(|rt| rt.get("stoplessGoalStateSource"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let has_request_scoped_goal_state = direct_state.is_some() && source != "persisted";
    let effective_state = direct_state.or_else(|| input.persisted_goal_state.as_ref());
    let status = effective_state
        .and_then(|state| state.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("idle");

    StoplessDecisionContextGoalPlan {
        goal_status: if has_request_scoped_goal_state && status == "active" {
            "active".to_string()
        } else if status == "idle" || status == "active" {
            "idle".to_string()
        } else {
            status.to_string()
        },
        has_request_scoped_goal_state,
    }
}

fn read_direct_goal_state(adapter_context: &Value) -> Option<&Value> {
    let state = adapter_context.get("stoplessGoalState")?;
    if !state.is_object() {
        return None;
    }
    let status = state.get("status").and_then(Value::as_str)?;
    let objective = state.get("objective").and_then(Value::as_str)?;
    let updated_at = state.get("updatedAt").and_then(Value::as_f64)?;
    let created_at = state.get("createdAt").and_then(Value::as_f64)?;
    if status.is_empty()
        || objective.is_empty()
        || !updated_at.is_finite()
        || !created_at.is_finite()
    {
        return None;
    }
    Some(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn persisted_active_direct_snapshot_is_idle_for_current_request() {
        let plan = plan_stopless_decision_context_goal_status(&StoplessDecisionContextGoalInput {
            adapter_context: json!({
                "stoplessGoalState": {
                    "status": "active",
                    "objective": "old goal",
                    "createdAt": 1,
                    "updatedAt": 2
                },
                "__rt": {
                    "stoplessGoalStateSource": "persisted"
                }
            }),
            persisted_goal_state: None,
        });

        assert_eq!(plan.goal_status, "idle");
        assert!(!plan.has_request_scoped_goal_state);
    }

    #[test]
    fn request_active_direct_snapshot_is_active() {
        let plan = plan_stopless_decision_context_goal_status(&StoplessDecisionContextGoalInput {
            adapter_context: json!({
                "stoplessGoalState": {
                    "status": "active",
                    "objective": "current goal",
                    "createdAt": 1,
                    "updatedAt": 2
                },
                "__rt": {
                    "stoplessGoalStateSource": "request"
                }
            }),
            persisted_goal_state: Some(json!({
                "status": "completed",
                "objective": "old",
                "createdAt": 1,
                "updatedAt": 2
            })),
        });

        assert_eq!(plan.goal_status, "active");
        assert!(plan.has_request_scoped_goal_state);
    }

    #[test]
    fn request_completed_direct_snapshot_stays_completed() {
        let plan = plan_stopless_decision_context_goal_status(&StoplessDecisionContextGoalInput {
            adapter_context: json!({
                "stoplessGoalState": {
                    "status": "completed",
                    "objective": "done goal",
                    "createdAt": 1,
                    "updatedAt": 2
                },
                "__rt": {
                    "stoplessGoalStateSource": "request"
                }
            }),
            persisted_goal_state: None,
        });

        assert_eq!(plan.goal_status, "completed");
        assert!(plan.has_request_scoped_goal_state);
    }

    #[test]
    fn persisted_non_active_state_can_surface_when_no_direct_state_exists() {
        let plan = plan_stopless_decision_context_goal_status(&StoplessDecisionContextGoalInput {
            adapter_context: json!({}),
            persisted_goal_state: Some(json!({
                "status": "paused",
                "objective": "paused goal",
                "createdAt": 1,
                "updatedAt": 2
            })),
        });

        assert_eq!(plan.goal_status, "paused");
        assert!(!plan.has_request_scoped_goal_state);
    }
}
