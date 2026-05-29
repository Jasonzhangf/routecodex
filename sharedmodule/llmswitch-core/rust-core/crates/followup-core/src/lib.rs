//! Followup helper functions — pure Rust, no NAPI dependency.
//!
//! Small pure functions extracted from `servertool/followup-mainline-block.ts`.

use serde::{Deserialize, Serialize};

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_FOLLOWUP_SUFFIX: &str = ":followup";

// ── Request ID builder ──────────────────────────────────────────────────────

/// Build a followup request ID by appending a suffix to the base ID.
///
/// Matches the TS `buildFollowupRequestId(baseRequestId, suffix?)`.
/// The TS original: trims base+suffix, falls back to 'servertool' / ':followup'."
pub fn build_followup_request_id(base: &str, suffix: Option<&str>) -> String {
    let trimmed_base = base.trim();
    let b = if trimmed_base.is_empty() {
        "servertool"
    } else {
        trimmed_base
    };
    let s = suffix
        .and_then(|x| {
            let t = x.trim();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        })
        .unwrap_or(DEFAULT_FOLLOWUP_SUFFIX);
    format!("{}{}", b, s)
}

// ── Loop warning injection ──────────────────────────────────────────────────

/// Input for injecting a loop warning into the stop-message followup payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopWarningInput {
    /// The current messages in the payload.
    pub messages: Vec<Message>,
    /// Current repeat count (raw, before threshold clamping).
    pub repeat_count: u32,
    /// Threshold at which warnings start (default 5).
    pub warn_threshold: u32,
    /// Threshold at which the loop fails (default 10).
    pub fail_threshold: u32,
}

/// A single message in the payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

/// Result of injecting a loop warning — returns the new messages array.
///
/// Matches the TS `appendLoopWarning(payload, repeatCountRaw, warnThreshold, failThreshold)`:
/// - Clamps repeatCount to >= warnThreshold
/// - Pushes a `{ role: 'system', content: warningText }` message
pub fn inject_loop_warning(input: LoopWarningInput) -> Vec<Message> {
    let repeat_count = if input.repeat_count >= input.warn_threshold {
        input.repeat_count
    } else {
        input.warn_threshold
    };

    let warning_text = format!(
        "检测到 stopMessage 请求/响应参数已连续 {} 轮一致。\n\
         请立即尝试跳出循环（换路径、换验证方法、或直接给结论）。\n\
         若继续达到 {} 轮一致，将返回 fetch failed 网络错误并停止自动续跑。",
        repeat_count, input.fail_threshold,
    );

    let mut messages = input.messages;
    messages.push(Message {
        role: "system".to_string(),
        content: warning_text,
    });
    messages
}

// ── Budget reset decision ───────────────────────────────────────────────────

/// Decision about whether to reset the stop-message budget.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BudgetResetDecision {
    /// Whether the budget should be reset (tool call occurred).
    pub should_reset: bool,
    /// The next used value to persist.
    pub next_used: u32,
}

/// Decide whether to reset the stop-message budget after a non-stop followup.
///
/// Matches the TS `resetStopMessageBudgetAfterNonStopFollowup`:
/// - If stop is NOT observed OR it's eligible (clean stop) → no reset
/// - If stop IS observed BUT not eligible (e.g., tool_calls) → increment budget
///
/// Returns `BudgetResetDecision` with `should_reset` and the next `used` count.
pub fn decide_budget_reset(
    stop_observed: bool,
    stop_eligible: bool,
    current_used: u32,
) -> BudgetResetDecision {
    if !stop_observed || stop_eligible {
        BudgetResetDecision {
            should_reset: false,
            next_used: current_used,
        }
    } else {
        BudgetResetDecision {
            should_reset: true,
            next_used: current_used + 1,
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── build_followup_request_id ──────────────────────────────────────────

    #[test]
    fn builds_request_id_with_default_suffix() {
        let result = build_followup_request_id("req-123", None);
        assert_eq!(result, "req-123:followup");
    }

    #[test]
    fn builds_request_id_with_custom_suffix() {
        let result = build_followup_request_id("req-123", Some(":stop_followup"));
        assert_eq!(result, "req-123:stop_followup");
    }

    #[test]
    fn falls_back_to_servertool_when_base_empty() {
        let result = build_followup_request_id("", None);
        assert_eq!(result, "servertool:followup");
    }

    #[test]
    fn falls_back_to_servertool_when_base_whitespace() {
        let result = build_followup_request_id("  ", None);
        assert_eq!(result, "servertool:followup");
    }

    #[test]
    fn trims_suffix() {
        let result = build_followup_request_id("req-123", Some("  :stop  "));
        assert_eq!(result, "req-123:stop");
    }

    // ── inject_loop_warning ────────────────────────────────────────────────

    #[test]
    fn injects_warning_message() {
        let result = inject_loop_warning(LoopWarningInput {
            messages: vec![Message {
                role: "user".to_string(),
                content: "hi".to_string(),
            }],
            repeat_count: 7,
            warn_threshold: 5,
            fail_threshold: 10,
        });
        assert_eq!(result.len(), 2);
        assert_eq!(result[1].role, "system");
        assert!(result[1].content.contains("7 轮一致"));
        assert!(result[1].content.contains("10 轮一致"));
    }

    #[test]
    fn clamps_repeat_count_to_warn_threshold() {
        let result = inject_loop_warning(LoopWarningInput {
            messages: vec![],
            repeat_count: 3,
            warn_threshold: 5,
            fail_threshold: 10,
        });
        assert_eq!(result.len(), 1);
        assert!(result[0].content.contains("5 轮一致"));
    }

    // ── decide_budget_reset ────────────────────────────────────────────────

    #[test]
    fn does_not_reset_when_stop_not_observed() {
        let result = decide_budget_reset(false, false, 0);
        assert!(!result.should_reset);
        assert_eq!(result.next_used, 0);
    }

    #[test]
    fn does_not_reset_when_stop_is_eligible() {
        let result = decide_budget_reset(true, true, 2);
        assert!(!result.should_reset);
        assert_eq!(result.next_used, 2);
    }

    #[test]
    fn increments_when_stop_observed_but_not_eligible() {
        let result = decide_budget_reset(true, false, 2);
        assert!(result.should_reset);
        assert_eq!(result.next_used, 3);
    }

    #[test]
    fn starts_from_zero() {
        let result = decide_budget_reset(true, false, 0);
        assert!(result.should_reset);
        assert_eq!(result.next_used, 1);
    }
}
