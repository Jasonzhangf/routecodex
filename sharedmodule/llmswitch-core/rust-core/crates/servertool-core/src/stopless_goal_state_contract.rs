use serde::{Deserialize, Serialize};
use serde_json::Value;

const RCC_FENCE_OPEN: &str = "<**rcc**>";
const RCC_FENCE_CLOSE: &str = "</rcc**>";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessGoalState {
    pub status: String,
    pub objective: String,
    pub latest_note: Option<String>,
    pub completion_evidence: Option<String>,
    pub next_step: Option<String>,
    pub user_question: Option<String>,
    pub cannot_continue_reason: Option<String>,
    pub blocking_evidence: Option<String>,
    pub attempts_exhausted: Option<bool>,
    pub error_class: Option<String>,
    pub completion_summary: Option<String>,
    pub ssot_assessment: Option<String>,
    pub consecutive_irrecoverable_errors: Option<i64>,
    pub consecutive_validation_failures: Option<i64>,
    pub consecutive_no_progress: Option<i64>,
    pub updated_at: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessGoalStateSyncPlanInput {
    pub latest_user_text: String,
    pub current_state: Option<StoplessGoalState>,
    pub now_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessGoalStateSyncPlan {
    pub had_directive: bool,
    pub directive_types: Vec<String>,
    pub rewritten_text: Option<String>,
    pub next_state: Option<StoplessGoalState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessGoalStateReadPlanInput {
    pub adapter_context: Value,
    pub persisted_state: Option<StoplessGoalState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessGoalStateReadPlan {
    pub sticky_key: String,
    pub state: Option<StoplessGoalState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessGoalStatePersistPlanInput {
    pub adapter_context: Value,
    pub state: StoplessGoalState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessGoalStatePersistPlan {
    pub sticky_key: String,
    pub state: StoplessGoalState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RccFenceBlock {
    raw: String,
    start_offset: usize,
    end_offset: usize,
    domain: String,
    action: String,
    body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RccDirective {
    directive_type: String,
    domain: String,
    action: String,
    body: String,
    passthrough: String,
}

pub fn plan_stopless_goal_state_sync(
    input: StoplessGoalStateSyncPlanInput,
) -> Result<StoplessGoalStateSyncPlan, String> {
    if !input.latest_user_text.contains(RCC_FENCE_OPEN) {
        return Ok(StoplessGoalStateSyncPlan {
            had_directive: false,
            directive_types: Vec::new(),
            rewritten_text: None,
            next_state: input.current_state,
        });
    }

    let document = parse_stopless_document(&input.latest_user_text)?;
    if document.is_empty() {
        return Ok(StoplessGoalStateSyncPlan {
            had_directive: false,
            directive_types: Vec::new(),
            rewritten_text: None,
            next_state: input.current_state,
        });
    }

    let mut out = String::new();
    let mut cursor = 0usize;
    let mut directive_types = Vec::new();
    let mut next_state = input.current_state;
    let now_ms = now_ms_or_default(input.now_ms);

    for (block, directive) in document {
        out.push_str(&input.latest_user_text[cursor..block.start_offset]);
        directive_types.push(directive.directive_type.clone());
        next_state = Some(apply_stopless_goal_directive(
            next_state, &directive, now_ms,
        )?);
        if directive.passthrough == "body-forward" {
            out.push_str(&directive.body);
        }
        cursor = block.end_offset;
    }
    out.push_str(&input.latest_user_text[cursor..]);

    Ok(StoplessGoalStateSyncPlan {
        had_directive: true,
        directive_types,
        rewritten_text: Some(compact_rewritten_text(&out)),
        next_state,
    })
}

pub fn plan_stopless_goal_state_read(
    input: StoplessGoalStateReadPlanInput,
) -> Result<StoplessGoalStateReadPlan, String> {
    let sticky_key = resolve_stopless_goal_sticky_key(&input.adapter_context).unwrap_or_default();
    Ok(StoplessGoalStateReadPlan {
        sticky_key,
        state: input.persisted_state,
    })
}

pub fn plan_stopless_goal_state_persist(
    input: StoplessGoalStatePersistPlanInput,
) -> Result<StoplessGoalStatePersistPlan, String> {
    let sticky_key = resolve_stopless_goal_sticky_key(&input.adapter_context)
        .ok_or_else(|| "STOPLESS_GOAL_RUNTIME_SCOPE_REQUIRED".to_string())?;
    Ok(StoplessGoalStatePersistPlan {
        sticky_key,
        state: input.state,
    })
}

fn resolve_stopless_goal_sticky_key(adapter_context: &Value) -> Option<String> {
    let session_id = read_trimmed_string(adapter_context.get("sessionId"))
        .or_else(|| read_trimmed_string(adapter_context.get("session_id")));
    if let Some(session_id) = session_id {
        return Some(format!("session:{session_id}"));
    }
    let conversation_id = read_trimmed_string(adapter_context.get("conversationId"))
        .or_else(|| read_trimmed_string(adapter_context.get("conversation_id")));
    if let Some(conversation_id) = conversation_id {
        return Some(format!("conversation:{conversation_id}"));
    }
    None
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?.trim();
    if raw.is_empty() { None } else { Some(raw.to_string()) }
}

fn parse_stopless_document(text: &str) -> Result<Vec<(RccFenceBlock, RccDirective)>, String> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(open_rel) = text[cursor..].find(RCC_FENCE_OPEN) {
        let start_offset = cursor + open_rel;
        let content_start = start_offset + RCC_FENCE_OPEN.len();
        let remaining = &text[content_start..];
        let Some(close_rel) = remaining.find(RCC_FENCE_CLOSE) else {
            return Err("RCC_FENCE_UNCLOSED".to_string());
        };
        let close_offset = content_start + close_rel;
        if let Some(nested_rel) = remaining[..close_rel].find(RCC_FENCE_OPEN) {
            let nested_abs = content_start + nested_rel;
            if nested_abs < close_offset {
                return Err("RCC_FENCE_NESTED_UNSUPPORTED".to_string());
            }
        }
        let end_offset = close_offset + RCC_FENCE_CLOSE.len();
        let raw = text[start_offset..end_offset].to_string();
        let inner = &text[content_start..close_offset];
        let block = parse_block(inner, raw, start_offset, end_offset)?;
        if block.domain == "stopless" {
            let directive = resolve_stopless_directive(&block)?;
            out.push((block, directive));
        }
        cursor = end_offset;
    }
    Ok(out)
}

fn parse_block(
    content: &str,
    raw: String,
    start_offset: usize,
    end_offset: usize,
) -> Result<RccFenceBlock, String> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let Some(command_index) = lines.iter().position(|line| !line.trim().is_empty()) else {
        return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
    };
    let command_line = lines[command_index].trim();
    let tokens: Vec<&str> = command_line.split_whitespace().collect();
    if tokens.len() < 2 {
        return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
    }
    let domain = tokens[0].trim().to_ascii_lowercase();
    let action = tokens[1].trim().to_ascii_lowercase();
    let body = if command_index + 1 >= lines.len() {
        String::new()
    } else {
        trim_blank_edges(&lines[(command_index + 1)..].join("\n"))
    };

    Ok(RccFenceBlock {
        raw,
        start_offset,
        end_offset,
        domain,
        action,
        body,
    })
}

fn resolve_stopless_directive(block: &RccFenceBlock) -> Result<RccDirective, String> {
    let directive_type = format!("{}.{}", block.domain, block.action);
    match block.action.as_str() {
        "start" => {
            require_non_empty_body(block)?;
            Ok(RccDirective {
                directive_type,
                domain: block.domain.clone(),
                action: block.action.clone(),
                body: block.body.clone(),
                passthrough: "body-forward".to_string(),
            })
        }
        "pause" | "resume" | "stop" => Ok(RccDirective {
            directive_type,
            domain: block.domain.clone(),
            action: block.action.clone(),
            body: block.body.clone(),
            passthrough: "private-only".to_string(),
        }),
        "done" => {
            require_non_empty_body(block)?;
            Ok(RccDirective {
                directive_type,
                domain: block.domain.clone(),
                action: block.action.clone(),
                body: block.body.clone(),
                passthrough: "private-only".to_string(),
            })
        }
        _ => Err("RCC_FENCE_UNKNOWN_ACTION".to_string()),
    }
}

fn apply_stopless_goal_directive(
    current_state: Option<StoplessGoalState>,
    directive: &RccDirective,
    now_ms: i64,
) -> Result<StoplessGoalState, String> {
    if directive.domain != "stopless" {
        return Err("RCC_STOPLESS_GOAL_UNSUPPORTED_DIRECTIVE".to_string());
    }

    let current = current_state.unwrap_or_else(|| StoplessGoalState {
        status: "idle".to_string(),
        objective: String::new(),
        latest_note: None,
        completion_evidence: None,
        next_step: None,
        user_question: None,
        cannot_continue_reason: None,
        blocking_evidence: None,
        attempts_exhausted: None,
        error_class: None,
        completion_summary: None,
        ssot_assessment: None,
        consecutive_irrecoverable_errors: None,
        consecutive_validation_failures: None,
        consecutive_no_progress: None,
        updated_at: now_ms,
        created_at: now_ms,
    });
    let current_status = normalize_goal_status(&current.status)
        .ok_or_else(|| "RCC_STOPLESS_GOAL_INVALID_STATE".to_string())?;
    let note = non_empty_trimmed(&directive.body);

    match directive.action.as_str() {
        "start" => {
            if !matches!(current_status, "idle" | "stopped" | "completed") {
                return Err("RCC_STOPLESS_GOAL_INVALID_TRANSITION".to_string());
            }
            let objective = directive.body.trim().to_string();
            if objective.is_empty() {
                return Err("RCC_FENCE_BODY_REQUIRED".to_string());
            }
            Ok(StoplessGoalState {
                status: "active".to_string(),
                objective,
                latest_note: None,
                completion_evidence: None,
                next_step: None,
                user_question: None,
                cannot_continue_reason: None,
                blocking_evidence: None,
                attempts_exhausted: None,
                error_class: None,
                completion_summary: None,
                ssot_assessment: None,
                consecutive_irrecoverable_errors: None,
                consecutive_validation_failures: None,
                consecutive_no_progress: None,
                updated_at: now_ms,
                created_at: now_ms,
            })
        }
        "pause" => {
            if current_status != "active" {
                return Err("RCC_STOPLESS_GOAL_INVALID_TRANSITION".to_string());
            }
            Ok(StoplessGoalState {
                status: "paused".to_string(),
                objective: current.objective,
                latest_note: note,
                completion_evidence: current.completion_evidence,
                next_step: None,
                user_question: current.user_question,
                cannot_continue_reason: current.cannot_continue_reason,
                blocking_evidence: current.blocking_evidence,
                attempts_exhausted: current.attempts_exhausted,
                error_class: current.error_class,
                completion_summary: current.completion_summary,
                ssot_assessment: current.ssot_assessment,
                consecutive_irrecoverable_errors: current.consecutive_irrecoverable_errors,
                consecutive_validation_failures: current.consecutive_validation_failures,
                consecutive_no_progress: current.consecutive_no_progress,
                updated_at: now_ms,
                created_at: current.created_at,
            })
        }
        "resume" => {
            if !matches!(current_status, "paused" | "active") {
                return Err("RCC_STOPLESS_GOAL_INVALID_TRANSITION".to_string());
            }
            Ok(StoplessGoalState {
                status: "active".to_string(),
                objective: current.objective,
                latest_note: note,
                completion_evidence: current.completion_evidence,
                next_step: current.next_step,
                user_question: None,
                cannot_continue_reason: None,
                blocking_evidence: current.blocking_evidence,
                attempts_exhausted: current.attempts_exhausted,
                error_class: current.error_class,
                completion_summary: current.completion_summary,
                ssot_assessment: current.ssot_assessment,
                consecutive_irrecoverable_errors: current.consecutive_irrecoverable_errors,
                consecutive_validation_failures: current.consecutive_validation_failures,
                consecutive_no_progress: current.consecutive_no_progress,
                updated_at: now_ms,
                created_at: current.created_at,
            })
        }
        "stop" => {
            if !matches!(current_status, "active" | "paused") {
                return Err("RCC_STOPLESS_GOAL_INVALID_TRANSITION".to_string());
            }
            Ok(StoplessGoalState {
                status: "stopped".to_string(),
                objective: current.objective,
                latest_note: note,
                completion_evidence: current.completion_evidence,
                next_step: None,
                user_question: current.user_question,
                cannot_continue_reason: current.cannot_continue_reason,
                blocking_evidence: current.blocking_evidence,
                attempts_exhausted: current.attempts_exhausted,
                error_class: current.error_class,
                completion_summary: current.completion_summary,
                ssot_assessment: current.ssot_assessment,
                consecutive_irrecoverable_errors: current.consecutive_irrecoverable_errors,
                consecutive_validation_failures: current.consecutive_validation_failures,
                consecutive_no_progress: current.consecutive_no_progress,
                updated_at: now_ms,
                created_at: current.created_at,
            })
        }
        "done" => {
            if !matches!(current_status, "active" | "paused") {
                return Err("RCC_STOPLESS_GOAL_INVALID_TRANSITION".to_string());
            }
            let evidence = directive.body.trim().to_string();
            if evidence.is_empty() {
                return Err("RCC_FENCE_BODY_REQUIRED".to_string());
            }
            Ok(StoplessGoalState {
                status: "completed".to_string(),
                objective: current.objective,
                latest_note: current.latest_note,
                completion_evidence: Some(evidence),
                next_step: None,
                user_question: None,
                cannot_continue_reason: None,
                blocking_evidence: current.blocking_evidence,
                attempts_exhausted: current.attempts_exhausted,
                error_class: current.error_class,
                completion_summary: current.completion_summary,
                ssot_assessment: current.ssot_assessment,
                consecutive_irrecoverable_errors: current.consecutive_irrecoverable_errors,
                consecutive_validation_failures: current.consecutive_validation_failures,
                consecutive_no_progress: current.consecutive_no_progress,
                updated_at: now_ms,
                created_at: current.created_at,
            })
        }
        _ => Err("RCC_STOPLESS_GOAL_UNSUPPORTED_DIRECTIVE".to_string()),
    }
}

fn compact_rewritten_text(text: &str) -> String {
    let mut out = String::new();
    let mut previous_blank = false;
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            if !previous_blank && !out.is_empty() {
                out.push('\n');
                previous_blank = true;
            }
            continue;
        }
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&collapse_horizontal_whitespace(line));
        previous_blank = false;
    }
    out.trim().to_string()
}

fn collapse_horizontal_whitespace(text: &str) -> String {
    let mut out = String::new();
    let mut previous_space = false;
    for ch in text.chars() {
        if ch == ' ' || ch == '\t' {
            if !previous_space {
                out.push(' ');
                previous_space = true;
            }
        } else {
            out.push(ch);
            previous_space = false;
        }
    }
    out
}

fn require_non_empty_body(block: &RccFenceBlock) -> Result<(), String> {
    if block.body.trim().is_empty() {
        Err("RCC_FENCE_BODY_REQUIRED".to_string())
    } else {
        Ok(())
    }
}

fn trim_blank_edges(text: &str) -> String {
    text.trim_matches(|ch| ch == '\n' || ch == '\r').to_string()
}

fn non_empty_trimmed(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_goal_status(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "idle" => Some("idle"),
        "active" => Some("active"),
        "paused" => Some("paused"),
        "stopped" => Some("stopped"),
        "completed" => Some("completed"),
        _ => None,
    }
}

fn now_ms_or_default(now_ms: Option<i64>) -> i64 {
    now_ms.unwrap_or(0).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_start_directive_rewrite_and_state() {
        let plan =
            plan_stopless_goal_state_sync(StoplessGoalStateSyncPlanInput {
                latest_user_text:
                    "前文\n<**rcc**>\nstopless start\n实现统一 RCC stopless\n</rcc**>\n后文"
                        .to_string(),
                current_state: None,
                now_ms: Some(100),
            })
            .expect("plan");

        assert!(plan.had_directive);
        assert_eq!(plan.directive_types, vec!["stopless.start"]);
        assert_eq!(
            plan.rewritten_text.as_deref(),
            Some("前文\n实现统一 RCC stopless\n后文")
        );
        let state = plan.next_state.expect("state");
        assert_eq!(state.status, "active");
        assert_eq!(state.objective, "实现统一 RCC stopless");
        assert_eq!(state.created_at, 100);
    }

    #[test]
    fn plans_private_pause_without_leaking_fence_body() {
        let current = StoplessGoalState {
            status: "active".to_string(),
            objective: "持续推进改造".to_string(),
            latest_note: None,
            completion_evidence: None,
            next_step: None,
            user_question: None,
            cannot_continue_reason: None,
            blocking_evidence: None,
            attempts_exhausted: None,
            error_class: None,
            completion_summary: None,
            ssot_assessment: None,
            consecutive_irrecoverable_errors: None,
            consecutive_validation_failures: None,
            consecutive_no_progress: None,
            updated_at: 100,
            created_at: 100,
        };
        let plan = plan_stopless_goal_state_sync(StoplessGoalStateSyncPlanInput {
            latest_user_text: "<**rcc**>\nstopless pause\n等待 Jason 确认\n</rcc**>".to_string(),
            current_state: Some(current),
            now_ms: Some(110),
        })
        .expect("plan");

        assert_eq!(plan.rewritten_text.as_deref(), Some(""));
        let state = plan.next_state.expect("state");
        assert_eq!(state.status, "paused");
        assert_eq!(state.latest_note.as_deref(), Some("等待 Jason 确认"));
    }

    #[test]
    fn ignores_non_stopless_fence_for_this_contract() {
        let plan = plan_stopless_goal_state_sync(StoplessGoalStateSyncPlanInput {
            latest_user_text: "<**rcc**>\nroute use provider.model\n</rcc**>".to_string(),
            current_state: None,
            now_ms: Some(100),
        })
        .expect("plan");

        assert!(!plan.had_directive);
        assert!(plan.rewritten_text.is_none());
        assert!(plan.next_state.is_none());
    }
}
