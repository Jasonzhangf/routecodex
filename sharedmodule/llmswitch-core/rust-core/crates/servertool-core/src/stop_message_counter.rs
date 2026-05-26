//! Stop-message budget counter — pure budget calculation logic.
//!
//! Matches the pure logic parts of `servertool/stop-message-counter.ts`.
//! I/O operations (disk persistence) stay in TS.

use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetSnapshot {
    pub text: String,
    pub max_repeats: u32,
    pub used: u32,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefaultBudgetConfig {
    pub enabled: bool,
    pub text: String,
    pub max_repeats: u32,
    pub is_non_active_managed_goal: bool,
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
    if !observed {
        return BudgetDecision {
            observed: false,
            stop_eligible: false,
            next_used: 0,
            max_repeats: 0,
        };
    }

    let max_repeats = snapshot
        .map(|s| s.max_repeats)
        .or_else(|| default_config.map(|c| c.max_repeats))
        .unwrap_or(3);

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

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_observed_no_update() {
        let result = calculate_budget(false, false, None, None);
        assert!(!result.observed);
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
}
