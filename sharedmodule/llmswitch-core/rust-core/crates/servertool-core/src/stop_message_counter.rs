//! Stop-message budget counter and persisted-state update planning.
//!
//! I/O operations (disk persistence) stay in TS. Rust owns the decision and the
//! stop-message state fields that must be persisted.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BudgetDecision {
    /// Whether a stop signal was observed
    pub observed: bool,
    /// Whether the stop is eligible for budget tracking
    pub stop_eligible: bool,
    /// The next used count to persist
    pub next_used: u32,
    /// Configured max repeats
    pub max_repeats: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BudgetSnapshot {
    pub text: String,
    pub max_repeats: u32,
    pub used: u32,
    pub source: String,
    pub stage_mode: Option<String>,
    pub ai_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DefaultBudgetConfig {
    pub enabled: bool,
    pub text: String,
    pub max_repeats: u32,
    pub is_non_active_managed_goal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopGatewayBudgetContext {
    pub observed: bool,
    pub eligible: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStateUpdateInput {
    pub stop_signal: StopGatewayBudgetContext,
    pub existing_state: Option<Value>,
    pub snapshot: Option<BudgetSnapshot>,
    pub default_config: Option<DefaultBudgetConfig>,
    pub now_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStateUpdatePlan {
    pub observed: bool,
    pub stop_eligible: bool,
    pub used: Option<u32>,
    pub max_repeats: Option<u32>,
    pub should_persist: bool,
    pub next_state: Option<Value>,
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Calculate the budget after a finish_reason event.
///
/// Pure logic: given the stop signal, existing snapshot, and default config,
/// determine what the next used count should be.
///
/// - If stop NOT observed → no budget update
/// - If stop NOT eligible → reset used to 0
/// - If stop IS eligible → increment used by 1
pub fn calculate_budget(
    observed: bool,
    stop_eligible: bool,
    snapshot: Option<&BudgetSnapshot>,
    default_config: Option<&DefaultBudgetConfig>,
) -> BudgetDecision {
    let max_repeats = snapshot
        .map(|s| s.max_repeats)
        .or_else(|| default_config.map(|c| c.max_repeats))
        .unwrap_or(3);

    if !observed {
        return BudgetDecision {
            observed: false,
            stop_eligible: false,
            next_used: 0,
            max_repeats,
        };
    }

    if !stop_eligible {
        return BudgetDecision {
            observed: true,
            stop_eligible: false,
            next_used: 0,
            max_repeats,
        };
    }

    let current_used = snapshot.map(|s| s.used).unwrap_or(0);
    let next_used = std::cmp::max(0, current_used as i32) as u32 + 1;

    BudgetDecision {
        observed: true,
        stop_eligible: true,
        next_used,
        max_repeats,
    }
}

pub fn plan_budget_state_update(input: BudgetStateUpdateInput) -> BudgetStateUpdatePlan {
    if !input.stop_signal.observed {
        let snapshot = input.snapshot.as_ref();
        let decision = calculate_budget(false, false, snapshot, input.default_config.as_ref());
        let existing_state = input.existing_state.clone();
        let has_existing_budget_state = existing_state
            .as_ref()
            .and_then(Value::as_object)
            .is_some_and(|row| {
                row.contains_key("stopMessageUsed")
                    || row.contains_key("stopMessageText")
                    || row.contains_key("stopMessageMaxRepeats")
            });
        let should_persist_reset = snapshot.is_some() || has_existing_budget_state;
        if !should_persist_reset {
            return BudgetStateUpdatePlan {
                observed: false,
                stop_eligible: false,
                used: None,
                max_repeats: None,
                should_persist: false,
                next_state: input.existing_state,
            };
        }

        let (text, source) =
            resolve_budget_text_and_source(snapshot, input.default_config.as_ref());
        let mut state = existing_state
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        state.insert("stopMessageSource".to_string(), Value::String(source));
        state.insert("stopMessageText".to_string(), Value::String(text));
        state.insert(
            "stopMessageMaxRepeats".to_string(),
            Value::Number(serde_json::Number::from(decision.max_repeats)),
        );
        state.insert(
            "stopMessageUsed".to_string(),
            Value::Number(serde_json::Number::from(0)),
        );
        state.insert(
            "stopMessageUpdatedAt".to_string(),
            Value::Number(serde_json::Number::from(input.now_ms)),
        );
        state.remove("stopMessageLastUsedAt");
        if !state.contains_key("stopMessageStageMode") {
            state.insert(
                "stopMessageStageMode".to_string(),
                Value::String(
                    snapshot
                        .and_then(|snapshot| {
                            normalize_mode(&snapshot.stage_mode, &["on", "off", "auto"])
                        })
                        .unwrap_or_else(|| "on".to_string()),
                ),
            );
        }
        return BudgetStateUpdatePlan {
            observed: false,
            stop_eligible: false,
            used: Some(0),
            max_repeats: Some(decision.max_repeats),
            should_persist: true,
            next_state: Some(Value::Object(state)),
        };
    }

    let should_update =
        input.stop_signal.eligible || should_reset_budget_for_non_eligible_stop(&input.stop_signal);
    let snapshot = input.snapshot.as_ref();
    let decision = calculate_budget(
        true,
        input.stop_signal.eligible,
        snapshot,
        input.default_config.as_ref(),
    );

    if !should_update {
        return BudgetStateUpdatePlan {
            observed: true,
            stop_eligible: false,
            used: Some(snapshot.map(|snap| snap.used).unwrap_or(decision.next_used)),
            max_repeats: Some(decision.max_repeats),
            should_persist: false,
            next_state: input.existing_state,
        };
    }

    let (text, source) = resolve_budget_text_and_source(snapshot, input.default_config.as_ref());
    let mut state = input
        .existing_state
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();

    state.insert("stopMessageSource".to_string(), Value::String(source));
    state.insert("stopMessageText".to_string(), Value::String(text));
    state.insert(
        "stopMessageMaxRepeats".to_string(),
        Value::Number(serde_json::Number::from(decision.max_repeats)),
    );
    state.insert(
        "stopMessageUsed".to_string(),
        Value::Number(serde_json::Number::from(decision.next_used)),
    );
    state.insert(
        "stopMessageUpdatedAt".to_string(),
        Value::Number(serde_json::Number::from(input.now_ms)),
    );
    if decision.next_used > 0 {
        state.insert(
            "stopMessageLastUsedAt".to_string(),
            Value::Number(serde_json::Number::from(input.now_ms)),
        );
    } else {
        state.remove("stopMessageLastUsedAt");
    }

    let stage_mode = snapshot
        .and_then(|snapshot| normalize_mode(&snapshot.stage_mode, &["on", "off", "auto"]))
        .unwrap_or_else(|| "on".to_string());
    if !state.contains_key("stopMessageStageMode") {
        state.insert(
            "stopMessageStageMode".to_string(),
            Value::String(stage_mode),
        );
    }

    BudgetStateUpdatePlan {
        observed: true,
        stop_eligible: input.stop_signal.eligible,
        used: Some(decision.next_used),
        max_repeats: Some(decision.max_repeats),
        should_persist: true,
        next_state: Some(Value::Object(state)),
    }
}

/// Resolve the default max_repeats value based on goal state.
/// Matches TS `resolveDefaultSnapshot` logic:
/// - Non-active managed goal → max_repeats = 1
/// - Otherwise → configured value or 3
pub fn resolve_default_max_repeats(
    configured: Option<u32>,
    is_non_active_managed_goal: bool,
) -> u32 {
    if is_non_active_managed_goal {
        return 1;
    }
    configured.filter(|&v| v > 0).unwrap_or(3)
}

fn should_reset_budget_for_non_eligible_stop(signal: &StopGatewayBudgetContext) -> bool {
    if !signal.observed || signal.eligible {
        return false;
    }
    let reason = signal.reason.trim().to_lowercase();
    reason == "finish_reason_tool_calls"
        || reason == "responses_required_action"
        || reason.contains("embedded_tool_markers")
}

fn resolve_budget_text_and_source(
    snapshot: Option<&BudgetSnapshot>,
    default_config: Option<&DefaultBudgetConfig>,
) -> (String, String) {
    if let Some(snapshot) = snapshot {
        let text = normalize_text(&snapshot.text).unwrap_or_else(|| "继续执行".to_string());
        let source = normalize_text(&snapshot.source).unwrap_or_else(|| "default".to_string());
        return (text, source);
    }
    if let Some(default_config) = default_config {
        let text = normalize_text(&default_config.text).unwrap_or_else(|| "继续执行".to_string());
        return (text, "default".to_string());
    }
    ("继续执行".to_string(), "default".to_string())
}

fn normalize_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_mode(value: &Option<String>, allowed: &[&str]) -> Option<String> {
    let normalized = value.as_deref()?.trim().to_lowercase();
    if allowed.iter().any(|allowed| *allowed == normalized) {
        Some(normalized)
    } else {
        None
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_observed_no_update() {
        let result = calculate_budget(false, false, None, None);
        assert!(!result.observed);
        assert_eq!(result.next_used, 0);
        assert_eq!(result.max_repeats, 3);
    }

    #[test]
    fn not_eligible_resets_used() {
        let result = calculate_budget(
            true,
            false,
            Some(&BudgetSnapshot {
                text: "继续执行".into(),
                max_repeats: 3,
                used: 2,
                source: "default".into(),
                stage_mode: Some("on".into()),
                ai_mode: Some("off".into()),
            }),
            None,
        );
        assert!(result.observed);
        assert!(!result.stop_eligible);
        assert_eq!(result.next_used, 0);
    }

    #[test]
    fn eligible_increments_used() {
        let result = calculate_budget(
            true,
            true,
            Some(&BudgetSnapshot {
                text: "继续执行".into(),
                max_repeats: 3,
                used: 1,
                source: "default".into(),
                stage_mode: Some("on".into()),
                ai_mode: Some("off".into()),
            }),
            None,
        );
        assert!(result.observed);
        assert!(result.stop_eligible);
        assert_eq!(result.next_used, 2);
    }

    #[test]
    fn no_snapshot_starts_from_zero() {
        let result = calculate_budget(true, true, None, None);
        assert_eq!(result.next_used, 1);
        assert_eq!(result.max_repeats, 3);
    }

    #[test]
    fn uses_default_config_when_no_snapshot() {
        let result = calculate_budget(
            true,
            true,
            None,
            Some(&DefaultBudgetConfig {
                enabled: true,
                text: "继续".into(),
                max_repeats: 5,
                is_non_active_managed_goal: false,
            }),
        );
        assert_eq!(result.max_repeats, 5);
    }

    #[test]
    fn snapshot_takes_precedence_over_default() {
        let result = calculate_budget(
            true,
            true,
            Some(&BudgetSnapshot {
                text: "snapshot".into(),
                max_repeats: 10,
                used: 3,
                source: "persisted".into(),
                stage_mode: Some("on".into()),
                ai_mode: Some("off".into()),
            }),
            Some(&DefaultBudgetConfig {
                enabled: true,
                text: "default".into(),
                max_repeats: 5,
                is_non_active_managed_goal: false,
            }),
        );
        assert_eq!(result.max_repeats, 10);
        assert_eq!(result.next_used, 4);
    }

    #[test]
    fn resolve_default_max_repeats_managed_goal() {
        assert_eq!(resolve_default_max_repeats(Some(3), true), 1);
    }

    #[test]
    fn resolve_default_max_repeats_normal() {
        assert_eq!(resolve_default_max_repeats(Some(3), false), 3);
    }

    #[test]
    fn resolve_default_max_repeats_no_configured() {
        assert_eq!(resolve_default_max_repeats(None, false), 3);
    }

    #[test]
    fn plan_persists_clean_stop_increment() {
        let result = plan_budget_state_update(BudgetStateUpdateInput {
            stop_signal: StopGatewayBudgetContext {
                observed: true,
                eligible: true,
                reason: "finish_reason_stop".into(),
            },
            existing_state: Some(serde_json::json!({"stopMessageStageMode": "auto"})),
            snapshot: Some(BudgetSnapshot {
                text: "继续执行".into(),
                max_repeats: 3,
                used: 1,
                source: "persisted".into(),
                stage_mode: Some("auto".into()),
                ai_mode: Some("on".into()),
            }),
            default_config: None,
            now_ms: 1000,
        });

        assert!(result.should_persist);
        assert_eq!(result.used, Some(2));
        let state = result.next_state.unwrap();
        assert_eq!(state["stopMessageUsed"], 2);
        assert_eq!(state["stopMessageText"], "继续执行");
        assert_eq!(state["stopMessageSource"], "persisted");
        assert_eq!(state["stopMessageStageMode"], "auto");
        assert_eq!(state["stopMessageLastUsedAt"], 1000);
    }

    #[test]
    fn plan_resets_on_chat_tool_calls() {
        let result = plan_budget_state_update(BudgetStateUpdateInput {
            stop_signal: StopGatewayBudgetContext {
                observed: true,
                eligible: false,
                reason: "finish_reason_tool_calls".into(),
            },
            existing_state: Some(serde_json::json!({"stopMessageUsed": 2})),
            snapshot: Some(BudgetSnapshot {
                text: "继续执行".into(),
                max_repeats: 3,
                used: 2,
                source: "persisted".into(),
                stage_mode: Some("on".into()),
                ai_mode: Some("off".into()),
            }),
            default_config: None,
            now_ms: 2000,
        });

        assert!(result.should_persist);
        assert_eq!(result.used, Some(0));
        assert_eq!(result.next_state.unwrap()["stopMessageUsed"], 0);
    }

    #[test]
    fn plan_does_not_reset_responses_tool_result_history() {
        let result = plan_budget_state_update(BudgetStateUpdateInput {
            stop_signal: StopGatewayBudgetContext {
                observed: true,
                eligible: false,
                reason: "responses_tool_like_output".into(),
            },
            existing_state: Some(serde_json::json!({"stopMessageUsed": 2})),
            snapshot: Some(BudgetSnapshot {
                text: "继续执行".into(),
                max_repeats: 3,
                used: 2,
                source: "persisted".into(),
                stage_mode: Some("on".into()),
                ai_mode: Some("off".into()),
            }),
            default_config: None,
            now_ms: 3000,
        });

        assert!(!result.should_persist);
        assert_eq!(result.used, Some(2));
        assert_eq!(result.next_state.unwrap()["stopMessageUsed"], 2);
    }

    #[test]
    fn plan_uses_default_config_without_snapshot() {
        let result = plan_budget_state_update(BudgetStateUpdateInput {
            stop_signal: StopGatewayBudgetContext {
                observed: true,
                eligible: true,
                reason: "status_completed".into(),
            },
            existing_state: None,
            snapshot: None,
            default_config: Some(DefaultBudgetConfig {
                enabled: true,
                text: "keep going".into(),
                max_repeats: 5,
                is_non_active_managed_goal: false,
            }),
            now_ms: 4000,
        });

        let state = result.next_state.unwrap();
        assert_eq!(result.used, Some(1));
        assert_eq!(result.max_repeats, Some(5));
        assert_eq!(state["stopMessageText"], "keep going");
        assert_eq!(state["stopMessageMaxRepeats"], 5);
    }

    #[test]
    fn plan_resets_when_followup_is_non_stop_after_prior_stop_chain() {
        let result = plan_budget_state_update(BudgetStateUpdateInput {
            stop_signal: StopGatewayBudgetContext {
                observed: false,
                eligible: false,
                reason: "followup_finished_without_stop".into(),
            },
            existing_state: Some(serde_json::json!({
                "stopMessageText": "继续执行",
                "stopMessageUsed": 2,
                "stopMessageMaxRepeats": 3,
                "stopMessageLastUsedAt": 999
            })),
            snapshot: Some(BudgetSnapshot {
                text: "继续执行".into(),
                max_repeats: 3,
                used: 2,
                source: "persisted".into(),
                stage_mode: Some("on".into()),
                ai_mode: Some("off".into()),
            }),
            default_config: None,
            now_ms: 5000,
        });

        assert!(result.should_persist);
        assert_eq!(result.used, Some(0));
        let state = result.next_state.unwrap();
        assert_eq!(state["stopMessageUsed"], 0);
        assert_eq!(state["stopMessageMaxRepeats"], 3);
        assert_eq!(state["stopMessageUpdatedAt"], 5000);
        assert!(state.get("stopMessageLastUsedAt").is_none());
    }
}
