//! Stop-message loop guard — detects infinite stop-message loops.
//!
//! Matches `servertool/stop-message-loop-guard-block.ts`.

use serde::{Deserialize, Serialize};

// ── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopGuardInput {
    pub started_at_ms: Option<u64>,
    pub stop_pair_repeat_count: Option<u32>,
    pub stop_pair_warned: Option<bool>,
    pub now_ms: Option<u64>,
    pub warn_threshold: u32,
    pub fail_threshold: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LoopGuardOutput {
    pub should_inject_warning: bool,
    pub stop_pair_warned: Option<bool>,
    pub hit_limit: bool,
    pub elapsed_ms: u64,
    pub repeat_count: u32,
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Evaluate the stop-message loop guard.
///
/// Matches TS `evaluateStopMessageLoopGuard(args)`.
///
/// Returns:
/// - `hit_limit: true` if elapsed >= 900s or repeat_count >= fail_threshold
/// - `should_inject_warning: true` if repeat_count >= warn_threshold and not yet warned
/// - Updates `stop_pair_warned` to `Some(true)` on first warning
pub fn evaluate(input: LoopGuardInput) -> LoopGuardOutput {
    let now_ms = input.now_ms.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    });

    let elapsed_ms = input
        .started_at_ms
        .map(|start| {
            if now_ms > start {
                now_ms - start
            } else {
                0
            }
        })
        .unwrap_or(0);

    let repeat_count = input
        .stop_pair_repeat_count
        .map(|c| std::cmp::max(0, c as i32) as u32)
        .unwrap_or(0);

    let fail_threshold = std::cmp::max(1, input.fail_threshold);
    let warn_threshold = std::cmp::max(1, input.warn_threshold);

    // Fail: elapsed >= 900s OR repeat_count >= fail_threshold
    if elapsed_ms >= 900_000 || repeat_count >= fail_threshold {
        return LoopGuardOutput {
            should_inject_warning: false,
            stop_pair_warned: None,
            hit_limit: true,
            elapsed_ms,
            repeat_count,
        };
    }

    // Warn: repeat_count >= warn_threshold AND not yet warned
    if repeat_count >= warn_threshold && !input.stop_pair_warned.unwrap_or(false) {
        return LoopGuardOutput {
            should_inject_warning: true,
            stop_pair_warned: Some(true),
            hit_limit: false,
            elapsed_ms,
            repeat_count,
        };
    }

    LoopGuardOutput {
        should_inject_warning: false,
        stop_pair_warned: None,
        hit_limit: false,
        elapsed_ms,
        repeat_count,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_loop_state_no_warning() {
        let result = evaluate(LoopGuardInput {
            started_at_ms: None,
            stop_pair_repeat_count: None,
            stop_pair_warned: None,
            now_ms: None,
            warn_threshold: 5,
            fail_threshold: 10,
        });
        assert!(!result.should_inject_warning);
        assert!(!result.hit_limit);
    }

    #[test]
    fn below_warn_threshold_no_warning() {
        let result = evaluate(LoopGuardInput {
            started_at_ms: Some(1000),
            stop_pair_repeat_count: Some(3),
            stop_pair_warned: Some(false),
            now_ms: Some(2000),
            warn_threshold: 5,
            fail_threshold: 10,
        });
        assert!(!result.should_inject_warning);
        assert!(!result.hit_limit);
        assert_eq!(result.repeat_count, 3);
    }

    #[test]
    fn at_warn_threshold_injects_warning() {
        let result = evaluate(LoopGuardInput {
            started_at_ms: Some(1000),
            stop_pair_repeat_count: Some(5),
            stop_pair_warned: Some(false),
            now_ms: Some(2000),
            warn_threshold: 5,
            fail_threshold: 10,
        });
        assert!(result.should_inject_warning);
        assert!(!result.hit_limit);
        assert_eq!(result.stop_pair_warned, Some(true));
    }

    #[test]
    fn at_fail_threshold_hits_limit() {
        let result = evaluate(LoopGuardInput {
            started_at_ms: Some(1000),
            stop_pair_repeat_count: Some(10),
            stop_pair_warned: Some(false),
            now_ms: Some(2000),
            warn_threshold: 5,
            fail_threshold: 10,
        });
        assert!(result.hit_limit);
        assert_eq!(result.repeat_count, 10);
    }

    #[test]
    fn elapsed_900s_hits_limit() {
        let result = evaluate(LoopGuardInput {
            started_at_ms: Some(1000),
            stop_pair_repeat_count: Some(1),
            stop_pair_warned: Some(false),
            now_ms: Some(901_000),
            warn_threshold: 5,
            fail_threshold: 10,
        });
        assert!(result.hit_limit);
        assert_eq!(result.elapsed_ms, 900_000);
    }

    #[test]
    fn already_warned_no_second_warning() {
        let result = evaluate(LoopGuardInput {
            started_at_ms: Some(1000),
            stop_pair_repeat_count: Some(6),
            stop_pair_warned: Some(true),
            now_ms: Some(2000),
            warn_threshold: 5,
            fail_threshold: 10,
        });
        assert!(!result.should_inject_warning);
        assert!(!result.hit_limit);
    }
}
