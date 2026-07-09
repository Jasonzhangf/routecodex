// feature_id: hub.servertool_stopless_cli_continuation
// Single owner of client-visible stopless continuation prompts.
// Both servertool-cli stdout (build_stop_message_auto_run_output)
// and stop_message followup append_user_text
// (chat_servertool_orchestration::plan_stop_message_followup)
// must resolve their client-visible text exclusively from here.

use serde::{Deserialize, Serialize};

pub const STOPLESS_PROMPT_FORBIDDEN_TOKENS: &[&str] = &[
    "schema",
    "hook",
    "stopless",
    "servertool",
    "stop_message_auto",
    "第一轮",
    "第二轮",
    "第三轮",
    "必须调用",
    "必须调用可用工具",
    "必须直接调用工具",
    "必须主动调用停止 hook",
    "stop schema",
    "stop reason",
    "证据不足",
    "用户目标",
    "已排除因素",
    "排查顺序",
    "已收敛",
    "停止检查已收敛",
    "stop_reason",
    concat!("直接", "收尾"),
    concat!("不要再", "继续"),
    concat!("必须", "停"),
    concat!("任务已经", "完成"),
    concat!("任务确实已经", "完成"),
    concat!("你当前的", "目标是"),
    concat!("建议的", "下一步"),
    concat!("确定你", "完成了吗"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StoplessContinuationTrigger {
    Stop,
    NoSchema,
    InvalidSchema,
    NonTerminalSchema,
    BudgetExhausted,
    SchemaPass,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessContinuationPromptInput {
    pub used: u32,
    pub max_repeats: u32,
    pub trigger: StoplessContinuationTrigger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessContinuationPrompt {
    pub client_visible_text: String,
    pub require_stop_hook_call: bool,
    pub schema_guidance_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoplessPromptError {
    ForbiddenToken(&'static str),
}

impl std::fmt::Display for StoplessPromptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoplessPromptError::ForbiddenToken(token) => {
                write!(f, "stopless prompt contains forbidden token: {token}")
            }
        }
    }
}

impl std::error::Error for StoplessPromptError {}

pub fn resolve_stopless_continuation_prompt(
    input: StoplessContinuationPromptInput,
) -> Result<StoplessContinuationPrompt, StoplessPromptError> {
    let StoplessContinuationPromptInput {
        used: _used,
        max_repeats: _max_repeats,
        trigger,
    } = input;

    if matches!(trigger, StoplessContinuationTrigger::SchemaPass) {
        return Ok(StoplessContinuationPrompt {
            client_visible_text: String::new(),
            require_stop_hook_call: false,
            schema_guidance_required: false,
        });
    }

    let text = match trigger {
        StoplessContinuationTrigger::InvalidSchema => "继续；按上一轮反馈修正。",
        StoplessContinuationTrigger::NonTerminalSchema => "继续。",
        StoplessContinuationTrigger::BudgetExhausted => "继续；按上一轮反馈处理。",
        StoplessContinuationTrigger::Stop | StoplessContinuationTrigger::NoSchema => "继续。",
        StoplessContinuationTrigger::SchemaPass => "",
    };

    let prompt = StoplessContinuationPrompt {
        client_visible_text: text.to_string(),
        require_stop_hook_call: false,
        schema_guidance_required: matches!(
            trigger,
            StoplessContinuationTrigger::NoSchema
                | StoplessContinuationTrigger::InvalidSchema
                | StoplessContinuationTrigger::BudgetExhausted
        ),
    };
    assert_no_forbidden_token(&prompt.client_visible_text)?;
    Ok(prompt)
}

pub fn assert_no_forbidden_token(text: &str) -> Result<(), StoplessPromptError> {
    for token in STOPLESS_PROMPT_FORBIDDEN_TOKENS {
        if text.contains(token) {
            return Err(StoplessPromptError::ForbiddenToken(token));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_schema_first_round_is_natural_user_language() {
        let prompt = resolve_stopless_continuation_prompt(StoplessContinuationPromptInput {
            used: 0,
            max_repeats: 3,
            trigger: StoplessContinuationTrigger::NoSchema,
        })
        .expect("prompt");
        assert!(!prompt.client_visible_text.is_empty());
        assert!(!prompt.client_visible_text.contains("schema"));
        assert!(!prompt.client_visible_text.contains("hook"));
        assert!(!prompt.client_visible_text.contains("stopless"));
        assert!(!prompt.client_visible_text.contains("servertool"));
        assert!(!prompt.client_visible_text.contains("第一轮"));
        assert_eq!(prompt.client_visible_text, "继续。");
        assert!(
            prompt.schema_guidance_required,
            "NoSchema stopless prompt must require schema guidance via CLI/tool contract"
        );
    }

    #[test]
    fn no_schema_middle_round_uses_middle_template() {
        let prompt = resolve_stopless_continuation_prompt(StoplessContinuationPromptInput {
            used: 1,
            max_repeats: 3,
            trigger: StoplessContinuationTrigger::NoSchema,
        })
        .expect("prompt");
        assert_eq!(prompt.client_visible_text, "继续。");
        assert_no_forbidden_token(&prompt.client_visible_text).expect("no forbidden");
    }

    #[test]
    fn no_schema_final_round_uses_final_template() {
        let prompt = resolve_stopless_continuation_prompt(StoplessContinuationPromptInput {
            used: 2,
            max_repeats: 3,
            trigger: StoplessContinuationTrigger::NoSchema,
        })
        .expect("prompt");
        assert_eq!(prompt.client_visible_text, "继续。");
        assert_no_forbidden_token(&prompt.client_visible_text).expect("no forbidden");
    }

    #[test]
    fn invalid_schema_always_uses_invalid_template() {
        let prompt = resolve_stopless_continuation_prompt(StoplessContinuationPromptInput {
            used: 2,
            max_repeats: 3,
            trigger: StoplessContinuationTrigger::InvalidSchema,
        })
        .expect("prompt");
        assert_eq!(prompt.client_visible_text, "继续；按上一轮反馈修正。");
        assert!(prompt.schema_guidance_required);
        assert_no_forbidden_token(&prompt.client_visible_text).expect("no forbidden");
    }

    #[test]
    fn non_terminal_schema_uses_non_terminal_template() {
        let prompt = resolve_stopless_continuation_prompt(StoplessContinuationPromptInput {
            used: 0,
            max_repeats: 3,
            trigger: StoplessContinuationTrigger::NonTerminalSchema,
        })
        .expect("prompt");
        assert_eq!(prompt.client_visible_text, "继续。");
        assert_no_forbidden_token(&prompt.client_visible_text).expect("no forbidden");
    }

    #[test]
    fn budget_exhausted_stays_neutral_and_does_not_claim_terminal_truth() {
        let prompt = resolve_stopless_continuation_prompt(StoplessContinuationPromptInput {
            used: 3,
            max_repeats: 3,
            trigger: StoplessContinuationTrigger::BudgetExhausted,
        })
        .expect("prompt");
        assert_eq!(prompt.client_visible_text, "继续；按上一轮反馈处理。");
        assert_no_forbidden_token(&prompt.client_visible_text).expect("no forbidden");
        assert!(!prompt.require_stop_hook_call);
        assert!(prompt.schema_guidance_required);
    }

    #[test]
    fn schema_pass_returns_empty_text() {
        let prompt = resolve_stopless_continuation_prompt(StoplessContinuationPromptInput {
            used: 0,
            max_repeats: 3,
            trigger: StoplessContinuationTrigger::SchemaPass,
        })
        .expect("prompt");
        assert!(prompt.client_visible_text.is_empty());
        assert!(!prompt.require_stop_hook_call);
    }

    #[test]
    fn forbidden_token_detector_catches_known_internal_terms() {
        for token in STOPLESS_PROMPT_FORBIDDEN_TOKENS {
            let bad = format!("before {token} after");
            assert!(assert_no_forbidden_token(&bad).is_err());
        }
    }
}
