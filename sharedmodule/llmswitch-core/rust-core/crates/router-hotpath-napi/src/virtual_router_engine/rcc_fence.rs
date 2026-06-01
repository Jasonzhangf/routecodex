use serde::{Deserialize, Serialize};

const RCC_FENCE_OPEN: &str = "<**rcc**>";
const RCC_FENCE_CLOSE: &str = "</rcc**>";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RccFenceBlock {
    pub raw: String,
    pub start_offset: usize,
    pub end_offset: usize,
    pub command_line: String,
    pub domain: String,
    pub action: String,
    pub args: Vec<String>,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RccDirective {
    pub directive_type: String,
    pub domain: String,
    pub action: String,
    pub args: Vec<String>,
    pub body: String,
    pub passthrough: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RccFenceDocument {
    pub blocks: Vec<RccFenceBlock>,
    pub directives: Vec<RccDirective>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoplessGoalState {
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
pub(crate) struct StoplessGoalDirectiveTransitionInput {
    pub current_state: Option<StoplessGoalState>,
    pub directive: RccDirective,
    pub now_ms: Option<i64>,
}

fn trim_blank_edges(text: &str) -> String {
    text.trim_matches(|ch| ch == '\n' || ch == '\r').to_string()
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
    let command_line = lines[command_index].trim().to_string();
    let tokens: Vec<&str> = command_line.split_whitespace().collect();
    if tokens.len() < 2 {
        return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
    }
    let domain = tokens[0].trim().to_ascii_lowercase();
    let action = tokens[1].trim().to_ascii_lowercase();
    let args = tokens
        .iter()
        .skip(2)
        .map(|entry| entry.trim().to_string())
        .collect();
    let body = if command_index + 1 >= lines.len() {
        String::new()
    } else {
        trim_blank_edges(&lines[(command_index + 1)..].join("\n"))
    };

    Ok(RccFenceBlock {
        raw,
        start_offset,
        end_offset,
        command_line,
        domain,
        action,
        args,
        body,
    })
}

fn require_empty_body(block: &RccFenceBlock) -> Result<(), String> {
    if block.body.trim().is_empty() {
        return Ok(());
    }
    Err("RCC_FENCE_BODY_FORBIDDEN".to_string())
}

fn require_non_empty_body(block: &RccFenceBlock) -> Result<(), String> {
    if block.body.trim().is_empty() {
        return Err("RCC_FENCE_BODY_REQUIRED".to_string());
    }
    Ok(())
}

fn resolve_directive(block: &RccFenceBlock) -> Result<RccDirective, String> {
    let directive_type = format!("{}.{}", block.domain, block.action);
    match block.domain.as_str() {
        "stopless" => match block.action.as_str() {
            "start" => {
                require_non_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: block.args.clone(),
                    body: block.body.clone(),
                    passthrough: "body-forward".to_string(),
                })
            }
            "pause" | "resume" | "stop" => Ok(RccDirective {
                directive_type,
                domain: block.domain.clone(),
                action: block.action.clone(),
                args: block.args.clone(),
                body: block.body.clone(),
                passthrough: "private-only".to_string(),
            }),
            "done" => {
                require_non_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: block.args.clone(),
                    body: block.body.clone(),
                    passthrough: "private-only".to_string(),
                })
            }
            _ => Err("RCC_FENCE_UNKNOWN_ACTION".to_string()),
        },
        "stop_message" => match block.action.as_str() {
            "set" => {
                require_non_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: block.args.clone(),
                    body: block.body.clone(),
                    passthrough: "private-only".to_string(),
                })
            }
            "clear" => {
                if !block.args.is_empty() {
                    return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
                }
                require_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: Vec::new(),
                    body: String::new(),
                    passthrough: "state-only".to_string(),
                })
            }
            _ => Err("RCC_FENCE_UNKNOWN_ACTION".to_string()),
        },
        "route" => match block.action.as_str() {
            "use" | "allow" | "disable" => {
                if block.args.is_empty() {
                    return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
                }
                require_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: block.args.clone(),
                    body: String::new(),
                    passthrough: "state-only".to_string(),
                })
            }
            "clear" => {
                if !block.args.is_empty() {
                    return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
                }
                require_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: Vec::new(),
                    body: String::new(),
                    passthrough: "state-only".to_string(),
                })
            }
            _ => Err("RCC_FENCE_UNKNOWN_ACTION".to_string()),
        },
        "precommand" => match block.action.as_str() {
            "set" => {
                if block.args.len() != 1 {
                    return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
                }
                require_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: block.args.clone(),
                    body: String::new(),
                    passthrough: "state-only".to_string(),
                })
            }
            "clear" => {
                if !block.args.is_empty() {
                    return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
                }
                require_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: Vec::new(),
                    body: String::new(),
                    passthrough: "state-only".to_string(),
                })
            }
            _ => Err("RCC_FENCE_UNKNOWN_ACTION".to_string()),
        },
        _ => Err("RCC_FENCE_UNKNOWN_DOMAIN".to_string()),
    }
}

pub(crate) fn parse_rcc_fence_blocks(text: &str) -> Result<Vec<RccFenceBlock>, String> {
    let mut blocks = Vec::new();
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
        blocks.push(parse_block(inner, raw, start_offset, end_offset)?);
        cursor = end_offset;
    }

    Ok(blocks)
}

pub(crate) fn parse_rcc_fence_document(text: &str) -> Result<RccFenceDocument, String> {
    let blocks = parse_rcc_fence_blocks(text)?;
    let mut directives = Vec::with_capacity(blocks.len());
    for block in &blocks {
        directives.push(resolve_directive(block)?);
    }
    Ok(RccFenceDocument { blocks, directives })
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

pub(crate) fn apply_stopless_goal_directive(
    input: StoplessGoalDirectiveTransitionInput,
) -> Result<StoplessGoalState, String> {
    if input.directive.domain != "stopless" {
        return Err("RCC_STOPLESS_GOAL_UNSUPPORTED_DIRECTIVE".to_string());
    }

    let now_ms = now_ms_or_default(input.now_ms);
    let current = input.current_state.unwrap_or(StoplessGoalState {
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
    let note = if input.directive.body.trim().is_empty() {
        None
    } else {
        Some(input.directive.body.trim().to_string())
    };

    match input.directive.action.as_str() {
        "start" => {
            if !matches!(current_status, "idle" | "stopped" | "completed") {
                return Err("RCC_STOPLESS_GOAL_INVALID_TRANSITION".to_string());
            }
            let objective = input.directive.body.trim().to_string();
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
            let evidence = input.directive.body.trim().to_string();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_complete_stopless_block() {
        let doc = parse_rcc_fence_document(
            "prefix\n<**rcc**>\nstopless start\nBuild the release artifact\ncollect logs\n</rcc**>\nsuffix",
        )
        .expect("document");

        assert_eq!(doc.blocks.len(), 1);
        let block = &doc.blocks[0];
        assert_eq!(block.domain, "stopless");
        assert_eq!(block.action, "start");
        assert_eq!(block.command_line, "stopless start");
        assert_eq!(block.body, "Build the release artifact\ncollect logs");

        assert_eq!(doc.directives[0].directive_type, "stopless.start");
        assert_eq!(doc.directives[0].passthrough, "body-forward");
    }

    #[test]
    fn preserves_multiple_block_order() {
        let doc = parse_rcc_fence_document(
            "<**rcc**>\nroute use provider.a.model\n</rcc**>\n<**rcc**>\nstop_message set\nhello\n</rcc**>",
        )
        .expect("document");

        assert_eq!(doc.blocks.len(), 2);
        assert_eq!(doc.directives[0].directive_type, "route.use");
        assert_eq!(doc.directives[1].directive_type, "stop_message.set");
    }

    #[test]
    fn supports_body_forward_private_only_and_state_only_passthrough_modes() {
        let start = parse_rcc_fence_document("<**rcc**>\nstopless start\nship it\n</rcc**>")
            .expect("start");
        let pause =
            parse_rcc_fence_document("<**rcc**>\nstopless pause\nwaiting for Jason\n</rcc**>")
                .expect("pause");
        let clear = parse_rcc_fence_document("<**rcc**>\nstop_message clear\n</rcc**>")
            .expect("clear");

        assert_eq!(start.directives[0].passthrough, "body-forward");
        assert_eq!(pause.directives[0].passthrough, "private-only");
        assert_eq!(clear.directives[0].passthrough, "state-only");
    }

    #[test]
    fn rejects_unclosed_block() {
        let error =
            parse_rcc_fence_document("<**rcc**>\nstopless start\nbody").expect_err("should fail");
        assert_eq!(error, "RCC_FENCE_UNCLOSED");
    }

    #[test]
    fn rejects_nested_block() {
        let error = parse_rcc_fence_document(
            "<**rcc**>\nstopless start\n<**rcc**>\nstop_message clear\n</rcc**>\n</rcc**>",
        )
        .expect_err("should fail");
        assert_eq!(error, "RCC_FENCE_NESTED_UNSUPPORTED");
    }

    #[test]
    fn rejects_unknown_domain() {
        let error = parse_rcc_fence_document("<**rcc**>\nunknown start\nbody\n</rcc**>")
            .expect_err("should fail");
        assert_eq!(error, "RCC_FENCE_UNKNOWN_DOMAIN");
    }

    #[test]
    fn rejects_missing_required_body() {
        let error = parse_rcc_fence_document("<**rcc**>\nstopless done\n</rcc**>")
            .expect_err("should fail");
        assert_eq!(error, "RCC_FENCE_BODY_REQUIRED");
    }

    #[test]
    fn applies_stopless_goal_state_transitions() {
        let start = apply_stopless_goal_directive(StoplessGoalDirectiveTransitionInput {
            current_state: None,
            directive: RccDirective {
                directive_type: "stopless.start".to_string(),
                domain: "stopless".to_string(),
                action: "start".to_string(),
                args: Vec::new(),
                body: "ship the feature".to_string(),
                passthrough: "body-forward".to_string(),
            },
            now_ms: Some(100),
        })
        .expect("start");
        assert_eq!(start.status, "active");
        assert_eq!(start.objective, "ship the feature");
        assert_eq!(start.created_at, 100);

        let paused = apply_stopless_goal_directive(StoplessGoalDirectiveTransitionInput {
            current_state: Some(start.clone()),
            directive: RccDirective {
                directive_type: "stopless.pause".to_string(),
                domain: "stopless".to_string(),
                action: "pause".to_string(),
                args: Vec::new(),
                body: "wait for confirmation".to_string(),
                passthrough: "private-only".to_string(),
            },
            now_ms: Some(110),
        })
        .expect("pause");
        assert_eq!(paused.status, "paused");
        assert_eq!(paused.latest_note.as_deref(), Some("wait for confirmation"));

        let resumed = apply_stopless_goal_directive(StoplessGoalDirectiveTransitionInput {
            current_state: Some(paused.clone()),
            directive: RccDirective {
                directive_type: "stopless.resume".to_string(),
                domain: "stopless".to_string(),
                action: "resume".to_string(),
                args: Vec::new(),
                body: "continue now".to_string(),
                passthrough: "private-only".to_string(),
            },
            now_ms: Some(120),
        })
        .expect("resume");
        assert_eq!(resumed.status, "active");
        assert_eq!(resumed.latest_note.as_deref(), Some("continue now"));

        let completed = apply_stopless_goal_directive(StoplessGoalDirectiveTransitionInput {
            current_state: Some(resumed),
            directive: RccDirective {
                directive_type: "stopless.done".to_string(),
                domain: "stopless".to_string(),
                action: "done".to_string(),
                args: Vec::new(),
                body: "tests green and live verified".to_string(),
                passthrough: "private-only".to_string(),
            },
            now_ms: Some(130),
        })
        .expect("done");
        assert_eq!(completed.status, "completed");
        assert_eq!(
            completed.completion_evidence.as_deref(),
            Some("tests green and live verified")
        );
    }

    #[test]
    fn rejects_invalid_stopless_goal_transition() {
        let error = apply_stopless_goal_directive(StoplessGoalDirectiveTransitionInput {
            current_state: None,
            directive: RccDirective {
                directive_type: "stopless.pause".to_string(),
                domain: "stopless".to_string(),
                action: "pause".to_string(),
                args: Vec::new(),
                body: String::new(),
                passthrough: "private-only".to_string(),
            },
            now_ms: Some(100),
        })
        .expect_err("should fail");
        assert_eq!(error, "RCC_STOPLESS_GOAL_INVALID_TRANSITION");
    }
}
