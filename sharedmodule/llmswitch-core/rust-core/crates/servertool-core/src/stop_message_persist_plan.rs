use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessagePersistPlanInput {
    pub schema_gate: Value,
    pub decision: Value,
    pub state_update: Option<Value>,
    pub default_text: Option<String>,
    pub schema_used_before_count: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessagePersistSnapshotPlan {
    pub text: String,
    pub max_repeats: i64,
    pub used: i64,
    pub source: String,
    pub stage_mode: String,
    pub ai_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessagePersistPlan {
    pub compare_max_repeats: i64,
    pub compare_remaining: i64,
    pub next_max_repeats: i64,
    pub next_used: i64,
    pub snapshot: StopMessagePersistSnapshotPlan,
}

pub fn plan_stop_message_persist_snapshot(
    input: &StopMessagePersistPlanInput,
) -> StopMessagePersistPlan {
    let state_update = input
        .state_update
        .as_ref()
        .filter(|value| value.is_object());
    let should_count_budget = input
        .schema_gate
        .get("count_budget")
        .or_else(|| input.schema_gate.get("countBudget"))
        .and_then(Value::as_bool)
        != Some(false);
    let schema_used_before_count = read_non_negative_floor(input.schema_used_before_count.as_ref())
        .unwrap_or_else(|| read_non_negative_floor(input.decision.get("used")).unwrap_or(0));
    let decision_max_repeats = read_non_negative_floor(input.decision.get("max_repeats"))
        .or_else(|| read_non_negative_floor(input.decision.get("maxRepeats")))
        .unwrap_or(0);
    let decision_used = read_non_negative_floor(input.decision.get("used")).unwrap_or(0);
    let gate_max_repeats = read_non_negative_floor(input.schema_gate.get("max_repeats"))
        .or_else(|| read_non_negative_floor(input.schema_gate.get("maxRepeats")))
        .unwrap_or(0);
    let resolved_max_repeats = if gate_max_repeats > 0 {
        gate_max_repeats
    } else {
        decision_max_repeats
    };
    let schema_budget_max_repeats = resolved_max_repeats.max(1);
    let next_max_repeats = if should_count_budget {
        schema_budget_max_repeats
    } else {
        decision_max_repeats
    };
    let state_used = state_update.and_then(|row| read_non_negative_floor(row.get("used")));
    let next_used = if should_count_budget {
        state_used.unwrap_or(schema_used_before_count + 1)
    } else {
        decision_used
    };
    let compare_remaining = (schema_budget_max_repeats - decision_used).max(0);
    let default_text = input.default_text.clone().unwrap_or_default();
    let text = state_update
        .and_then(|row| row.get("text"))
        .map(value_to_string)
        .unwrap_or(default_text);
    let source = state_update
        .and_then(|row| row.get("source"))
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_string();
    let stage_mode = state_update
        .and_then(|row| row.get("stageMode").or_else(|| row.get("stage_mode")))
        .and_then(Value::as_str)
        .unwrap_or("on")
        .to_string();

    StopMessagePersistPlan {
        compare_max_repeats: schema_budget_max_repeats,
        compare_remaining,
        next_max_repeats,
        next_used,
        snapshot: StopMessagePersistSnapshotPlan {
            text,
            max_repeats: next_max_repeats,
            used: next_used,
            source,
            stage_mode,
            ai_mode: "off".to_string(),
        },
    }
}

fn read_non_negative_floor(value: Option<&Value>) -> Option<i64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(raw) => raw.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    let floored = number.floor();
    if floored > i64::MAX as f64 {
        None
    } else {
        Some(floored as i64)
    }
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_budget_with_gate_cap_and_state_update_used() {
        let plan = plan_stop_message_persist_snapshot(&StopMessagePersistPlanInput {
            schema_gate: json!({ "count_budget": true, "max_repeats": 3 }),
            decision: json!({ "used": 1, "max_repeats": 30 }),
            state_update: Some(json!({
                "used": 2,
                "text": "keep going",
                "source": "persisted",
                "stageMode": "auto"
            })),
            default_text: Some("default".to_string()),
            schema_used_before_count: Some(json!(1)),
        });

        assert_eq!(plan.compare_max_repeats, 3);
        assert_eq!(plan.compare_remaining, 2);
        assert_eq!(plan.next_max_repeats, 3);
        assert_eq!(plan.next_used, 2);
        assert_eq!(plan.snapshot.text, "keep going");
        assert_eq!(plan.snapshot.source, "persisted");
        assert_eq!(plan.snapshot.stage_mode, "auto");
    }

    #[test]
    fn fills_used_from_previous_count_when_state_update_omits_it() {
        let plan = plan_stop_message_persist_snapshot(&StopMessagePersistPlanInput {
            schema_gate: json!({ "count_budget": true, "max_repeats": 0 }),
            decision: json!({ "used": 4, "max_repeats": 9 }),
            state_update: Some(json!({})),
            default_text: Some("default".to_string()),
            schema_used_before_count: Some(json!(4.8)),
        });

        assert_eq!(plan.compare_max_repeats, 9);
        assert_eq!(plan.next_max_repeats, 9);
        assert_eq!(plan.next_used, 5);
        assert_eq!(plan.snapshot.text, "default");
        assert_eq!(plan.snapshot.source, "default");
        assert_eq!(plan.snapshot.stage_mode, "on");
    }

    #[test]
    fn non_counting_gate_preserves_decision_budget_and_used() {
        let plan = plan_stop_message_persist_snapshot(&StopMessagePersistPlanInput {
            schema_gate: json!({ "count_budget": false, "max_repeats": 3 }),
            decision: json!({ "used": 7, "max_repeats": 30 }),
            state_update: Some(json!({ "used": 8 })),
            default_text: Some("default".to_string()),
            schema_used_before_count: None,
        });

        assert_eq!(plan.compare_max_repeats, 3);
        assert_eq!(plan.compare_remaining, 0);
        assert_eq!(plan.next_max_repeats, 30);
        assert_eq!(plan.next_used, 7);
        assert_eq!(plan.snapshot.max_repeats, 30);
        assert_eq!(plan.snapshot.used, 7);
    }
}
