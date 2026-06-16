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
    "stop_reason",
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
        used,
        max_repeats,
        trigger,
    } = input;

    if matches!(trigger, StoplessContinuationTrigger::SchemaPass) {
        return Ok(StoplessContinuationPrompt {
            client_visible_text: String::new(),
            require_stop_hook_call: false,
            schema_guidance_required: false,
        });
    }

    let phase = if max_repeats == 0 || used + 1 >= max_repeats {
        // Final guard round: ask the model to wrap up if it can.
        "final"
    } else if used == 0 {
        "first"
    } else if used == 1 {
        "middle"
    } else {
        "final"
    };

    let text = match (trigger, phase) {
        (StoplessContinuationTrigger::BudgetExhausted, _) => {
            "不要再继续执行了。现在直接收尾并给出最终结论；如果正常收尾已经做不到，就明确说明为什么必须停，并把最后卡点交代清楚。"
        }
        (StoplessContinuationTrigger::InvalidSchema, _) => {
            "刚才那段我没看明白；按你现在看到的真实情况重说一遍，直接说结果和下一步。"
        }
        (StoplessContinuationTrigger::NonTerminalSchema, _) => {
            "继续往下做；要是能收尾就直接告诉我做完了，不然就继续推进。"
        }
        (StoplessContinuationTrigger::Stop, "final") => {
            "这次不要再泛泛地说了。把还能验证的文件、日志、命令都直接补完；如果还是收不住，就明确写清楚卡点、已经排除的路、以及还差我拍板的那一步。"
        }
        (StoplessContinuationTrigger::Stop, "middle") => {
            "继续推进；缺哪块结果就补哪块，别停在概述上。"
        }
        (StoplessContinuationTrigger::Stop, _) => {
            "继续做下一步；先把手头能确认的结果拿回来。"
        }
        (StoplessContinuationTrigger::NoSchema, "final") => {
            "这次不要再泛泛地说了。把还能验证的文件、日志、命令都直接补完；如果还是收不住，就明确写清楚卡点、已经排除的路、以及还差我拍板的那一步。"
        }
        (StoplessContinuationTrigger::NoSchema, "middle") => {
            "继续推进；缺哪块结果就补哪块，别停在概述上。"
        }
        (StoplessContinuationTrigger::NoSchema, _) => {
            "继续做下一步；先把手头能确认的结果拿回来。"
        }
        (StoplessContinuationTrigger::SchemaPass, _) => "",
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
    let prompt = if matches!(trigger, StoplessContinuationTrigger::BudgetExhausted) {
        StoplessContinuationPrompt {
            require_stop_hook_call: true,
            ..prompt
        }
    } else {
        prompt
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
        assert!(prompt.client_visible_text.contains("继续做下一步"));
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
        assert!(prompt.client_visible_text.starts_with("继续推进"));
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
        assert!(prompt.client_visible_text.starts_with("这次不要再泛泛地说了"));
        assert!(prompt.client_visible_text.contains("文件、日志、命令"));
        assert!(prompt.client_visible_text.contains("卡点"));
        assert!(prompt.client_visible_text.contains("已经排除的路"));
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
        assert!(prompt.client_visible_text.starts_with("刚才那段我没看明白"));
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
        assert!(prompt.client_visible_text.starts_with("继续往下做"));
        assert_no_forbidden_token(&prompt.client_visible_text).expect("no forbidden");
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
