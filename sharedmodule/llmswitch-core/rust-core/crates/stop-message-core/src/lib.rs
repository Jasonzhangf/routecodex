//! Stop-message decision core — pure Rust, no NAPI dependency.
//!
//! This crate implements the decision logic for `stop_message_auto` servertool handler.
//! The TS shell collects context, calls `decide()`, and acts on the result.

use serde::{Deserialize, Serialize};

// ── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum StageMode {
    On,
    Off,
    Auto,
}

impl StageMode {
    pub fn is_off(&self) -> bool {
        matches!(self, StageMode::Off)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotSource {
    /// Explicitly persisted via `<**stopMessage:on**>` or session state
    Persisted,
    /// Default snapshot from config/env when no explicit state exists
    Default,
    /// Gemini-implicit snapshot (legacy)
    ImplicitGemini,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum GoalStatus {
    Idle,
    Active,
    Paused,
    Stopped,
    Completed,
}

impl GoalStatus {
    pub fn is_active(&self) -> bool {
        matches!(self, GoalStatus::Active)
    }

    pub fn is_managed(&self) -> bool {
        !matches!(self, GoalStatus::Idle)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    PortDisabled,
    ServertoolFollowupHop,
    ResponsesSubmitToolOutputsResume,
    ExplicitModeOff,
    ExplicitModeWithoutSnapshot,
    GoalDefaultExhausted,
    NoSnapshot,
    ModeOff,
    EmptyText,
    InvalidRepeats,
    NotStopFinishReason,
    ReachedMaxRepeats,
    GoalActive,
}

impl SkipReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            SkipReason::PortDisabled => "skip_port_stopmessage_disabled",
            SkipReason::ServertoolFollowupHop => "skip_servertool_followup_hop",
            SkipReason::ResponsesSubmitToolOutputsResume => {
                "skip_responses_submit_tool_outputs_resume"
            }
            SkipReason::ExplicitModeOff => "skip_stopmessage_mode_off",
            SkipReason::ExplicitModeWithoutSnapshot => "skip_explicit_mode_without_snapshot",
            SkipReason::GoalDefaultExhausted => "skip_goal_default_exhausted",
            SkipReason::NoSnapshot => "skip_no_stopmessage_snapshot",
            SkipReason::ModeOff => "skip_stopmessage_mode_off",
            SkipReason::EmptyText => "skip_stopmessage_empty_text",
            SkipReason::InvalidRepeats => "skip_stopmessage_invalid_repeats",
            SkipReason::NotStopFinishReason => "skip_not_stop_finish_reason",
            SkipReason::ReachedMaxRepeats => "skip_reached_max_repeats",
            SkipReason::GoalActive => "skip_goal_active",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderPin {
    pub provider_key: Option<String>,
    pub model_id: Option<String>,
    pub routecodex_port_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopMessageSnapshot {
    pub text: String,
    pub max_repeats: u32,
    pub used: u32,
    pub source: SnapshotSource,
    pub stage_mode: StageMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopMessageDecisionContext {
    // Port gate
    pub port_stop_message_disabled: bool,

    // Servertool followup context
    pub followup_flow_id: Option<String>,
    pub stop_eligible: bool,
    /// finish_reason sequence from current response choices, in original order.
    /// Decision must only consider the latest non-empty finish_reason.
    pub finish_reasons: Option<Vec<String>>,

    // Submit tool outputs resume
    pub has_responses_submit_tool_outputs_resume: bool,

    // Persisted state
    pub persisted_snapshot: Option<StopMessageSnapshot>,
    pub runtime_snapshot: Option<StopMessageSnapshot>,
    pub persisted_default_exhausted: bool,

    // Explicit mode from runtime/sticky
    pub explicit_mode: Option<StageMode>,

    // Goal state
    pub goal_status: GoalStatus,

    // Default config
    pub default_enabled: bool,
    pub default_max_repeats: u32,
    pub default_text: String,

    // Empty reply continue check
    pub empty_reply_continue_local: bool,

    // Provider pin
    pub provider_pin: Option<ProviderPin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopMessageDecision {
    pub action: Action,
    pub skip_reason: Option<String>,
    pub used: u32,
    pub max_repeats: u32,
    pub followup_text: Option<String>,
    pub provider_pin: Option<ProviderPin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Skip,
    Trigger,
}

// ── Core decision function ──────────────────────────────────────────────────

/// Decide whether `stop_message_auto` should trigger a followup.
///
/// Returns a `StopMessageDecision` with the action to take.
/// This is a pure function — no I/O, no side effects.
pub fn decide(ctx: &StopMessageDecisionContext) -> StopMessageDecision {
    // 1. Port disabled?
    if ctx.port_stop_message_disabled {
        return skip(SkipReason::PortDisabled);
    }

    // 2. Followup flow check
    if ctx.followup_flow_id.is_some() {
        if ctx.stop_eligible {
            // Followup flow + eligible → proceed
        } else {
            return skip(SkipReason::ServertoolFollowupHop);
        }
    }

    // 3. Submit tool outputs resume?
    if ctx.has_responses_submit_tool_outputs_resume {
        return skip(SkipReason::ResponsesSubmitToolOutputsResume);
    }

    // 4. Explicit mode without snapshot?
    if let Some(mode) = &ctx.explicit_mode {
        if matches!(mode, StageMode::On | StageMode::Auto)
            && ctx.persisted_snapshot.is_none()
            && ctx.runtime_snapshot.is_none()
        {
            return skip(SkipReason::ExplicitModeWithoutSnapshot);
        }
    }

    // 5. Resolve snapshot: persisted > runtime > default
    let resolved_snapshot = resolve_snapshot(ctx);

    let snapshot = match resolved_snapshot {
        Some(s) => s,
        None => {
            // 5a. Default exhausted tombstone?
            if !ctx.goal_status.is_active()
                && !ctx.empty_reply_continue_local
                && ctx.persisted_default_exhausted
            {
                return skip(SkipReason::GoalDefaultExhausted);
            }
            return skip(SkipReason::NoSnapshot);
        }
    };

    // 5. Mode off?
    if snapshot.stage_mode.is_off() {
        return skip(SkipReason::ModeOff);
    }

    // 6. Empty text?
    if snapshot.text.is_empty() {
        return skip(SkipReason::EmptyText);
    }

    // 7. Invalid repeats?
    if snapshot.max_repeats == 0 {
        return skip(SkipReason::InvalidRepeats);
    }

    // 7.5 Latest finish_reason gate (current response only)
    if let Some(latest) = latest_finish_reason(ctx.finish_reasons.as_ref()) {
        if latest != "stop" {
            return skip(SkipReason::NotStopFinishReason);
        }
    }

    // 8. Not stop eligible?
    if !ctx.stop_eligible {
        return skip(SkipReason::NotStopFinishReason);
    }

    // 9. Reached max repeats?
    if snapshot.used >= snapshot.max_repeats {
        return skip(SkipReason::ReachedMaxRepeats);
    }

    // 10. Goal active?
    if ctx.goal_status.is_active() {
        return skip(SkipReason::GoalActive);
    }

    // ── Trigger ──
    StopMessageDecision {
        action: Action::Trigger,
        skip_reason: None,
        used: snapshot.used,
        max_repeats: snapshot.max_repeats,
        followup_text: Some(snapshot.text),
        provider_pin: ctx.provider_pin.clone(),
    }
}

// ── Snapshot resolution ────────────────────────────────────────────────────

fn resolve_snapshot(ctx: &StopMessageDecisionContext) -> Option<StopMessageSnapshot> {
    // 1. Try persisted snapshot first
    if let Some(snapshot) = &ctx.persisted_snapshot {
        return Some(snapshot.clone());
    }

    // 2. Try runtime snapshot
    if let Some(snapshot) = &ctx.runtime_snapshot {
        return Some(snapshot.clone());
    }

    // 3. Explicit mode without snapshot → skip
    if let Some(mode) = &ctx.explicit_mode {
        if matches!(mode, StageMode::On | StageMode::Auto) {
            return None; // caller will convert to ExplicitModeWithoutSnapshot
        }
    }

    // 4. Try default snapshot
    //    Create default when no snapshot exists, goal is not active,
    //    and current request is not an empty-reply-continue scenario.
    let should_use_default = !ctx.goal_status.is_active() && !ctx.empty_reply_continue_local;

    if should_use_default {
        if ctx.persisted_default_exhausted {
            return None; // caller: GoalDefaultExhausted
        }
        if ctx.default_enabled {
            let next_used = 0; // default starts at 0
            return Some(StopMessageSnapshot {
                text: ctx.default_text.clone(),
                max_repeats: ctx.default_max_repeats,
                used: next_used,
                source: SnapshotSource::Default,
                stage_mode: StageMode::On,
            });
        }
    }

    None
}

fn latest_finish_reason(finish_reasons: Option<&Vec<String>>) -> Option<String> {
    let reasons = finish_reasons?;
    reasons.iter().rev().find_map(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_ascii_lowercase())
        }
    })
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn skip(reason: SkipReason) -> StopMessageDecision {
    StopMessageDecision {
        action: Action::Skip,
        skip_reason: Some(reason.as_str().to_string()),
        used: 0,
        max_repeats: 0,
        followup_text: None,
        provider_pin: None,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn base_ctx() -> StopMessageDecisionContext {
        StopMessageDecisionContext {
            port_stop_message_disabled: false,
            followup_flow_id: Some("stop_message_flow".to_string()),
            stop_eligible: true,
            finish_reasons: Some(vec!["stop".to_string()]),
            has_responses_submit_tool_outputs_resume: false,
            persisted_snapshot: None,
            runtime_snapshot: None,
            persisted_default_exhausted: false,
            explicit_mode: None,
            goal_status: GoalStatus::Idle,
            default_enabled: true,
            default_max_repeats: 3,
            default_text: "继续执行".to_string(),
            empty_reply_continue_local: false,
            provider_pin: None,
        }
    }

    #[test]
    fn triggers_on_clean_stop_with_followup_context() {
        let result = decide(&base_ctx());
        assert_eq!(result.action, Action::Trigger);
        assert!(result.followup_text.is_some());
    }

    #[test]
    fn skips_when_port_disabled() {
        let mut ctx = base_ctx();
        ctx.port_stop_message_disabled = true;
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(
            result.skip_reason.unwrap(),
            "skip_port_stopmessage_disabled"
        );
    }

    #[test]
    fn only_latest_finish_reason_is_considered() {
        let mut ctx = base_ctx();
        ctx.stop_eligible = true;
        ctx.finish_reasons = Some(vec!["stop".to_string(), "content_filter".to_string()]);
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_not_stop_finish_reason");
    }

    #[test]
    fn latest_non_empty_finish_reason_is_considered() {
        let mut ctx = base_ctx();
        ctx.stop_eligible = true;
        ctx.finish_reasons = Some(vec!["stop".to_string(), "   ".to_string()]);
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
    }

    #[test]
    fn triggers_when_no_followup_context_and_default_enabled() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = None; // NOT a followup context
        ctx.default_enabled = true; // Default is ON
        let result = decide(&ctx);
        // Default now applies even without followup flow context.
        assert_eq!(result.action, Action::Trigger);
        assert_eq!(result.followup_text, Some("继续执行".to_string()));
    }

    #[test]
    fn triggers_when_persisted_snapshot_exists_even_without_followup_context() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = None;
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            max_repeats: 3,
            used: 0,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
    }

    #[test]
    fn skips_when_goal_active_with_persisted_snapshot() {
        let mut ctx = base_ctx();
        ctx.goal_status = GoalStatus::Active;
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            max_repeats: 3,
            used: 0,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_goal_active");
    }

    #[test]
    fn skips_when_goal_active_no_persisted_snapshot() {
        let mut ctx = base_ctx();
        ctx.goal_status = GoalStatus::Active;
        // No persisted snapshot → no default (goal active blocks default) → no snapshot
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_no_stopmessage_snapshot");
    }

    #[test]
    fn skips_when_used_equals_max_repeats() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            max_repeats: 3,
            used: 3,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_reached_max_repeats");
    }

    #[test]
    fn skips_when_used_exceeds_max_repeats() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            max_repeats: 3,
            used: 4,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_reached_max_repeats");
    }

    #[test]
    fn skips_when_stage_mode_is_off() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            max_repeats: 3,
            used: 0,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::Off,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_stopmessage_mode_off");
    }

    #[test]
    fn skips_when_text_is_empty() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "".to_string(),
            max_repeats: 3,
            used: 0,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_stopmessage_empty_text");
    }

    #[test]
    fn skips_when_no_followup_context_and_not_eligible() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = None;
        ctx.stop_eligible = false;
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_not_stop_finish_reason");
    }

    #[test]
    fn skips_when_followup_flow_but_not_eligible() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = Some("stop_message_flow".to_string());
        ctx.stop_eligible = false;
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_servertool_followup_hop");
    }

    #[test]
    fn default_snapshot_uses_configured_values() {
        let mut ctx = base_ctx();
        ctx.default_text = "继续".to_string();
        ctx.default_max_repeats = 5;
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        assert_eq!(result.followup_text.unwrap(), "继续");
        assert_eq!(result.max_repeats, 5);
    }

    #[test]
    fn explicit_mode_on_without_snapshot_skips() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = None;
        ctx.persisted_snapshot = None;
        ctx.runtime_snapshot = None;
        ctx.explicit_mode = Some(StageMode::On);
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(
            result.skip_reason.unwrap(),
            "skip_explicit_mode_without_snapshot"
        );
    }

    #[test]
    fn default_exhausted_tombstone_skips() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = None;
        ctx.runtime_snapshot = None;
        ctx.persisted_default_exhausted = true;
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_goal_default_exhausted");
    }

    #[test]
    fn persists_provider_pin_in_decision() {
        let mut ctx = base_ctx();
        ctx.provider_pin = Some(ProviderPin {
            provider_key: Some("mini27.key1.MiniMax-M2.7".to_string()),
            model_id: Some("MiniMax-M2.7".to_string()),
            routecodex_port_mode: Some("router".to_string()),
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        let pin = result.provider_pin.unwrap();
        assert_eq!(pin.provider_key.unwrap(), "mini27.key1.MiniMax-M2.7");
    }

    #[test]
    fn runtime_snapshot_is_used_when_no_persisted() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = None;
        ctx.runtime_snapshot = Some(StopMessageSnapshot {
            text: "继续".to_string(),
            max_repeats: 2,
            used: 1,
            source: SnapshotSource::Default,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        assert_eq!(result.used, 1);
        assert_eq!(result.max_repeats, 2);
    }

    #[test]
    fn persisted_snapshot_takes_precedence_over_runtime() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "persisted".to_string(),
            max_repeats: 5,
            used: 2,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        ctx.runtime_snapshot = Some(StopMessageSnapshot {
            text: "runtime".to_string(),
            max_repeats: 2,
            used: 0,
            source: SnapshotSource::Default,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        // Persisted wins over runtime
        assert_eq!(result.followup_text.unwrap(), "persisted");
        assert_eq!(result.max_repeats, 5);
        assert_eq!(result.used, 2);
    }
}
