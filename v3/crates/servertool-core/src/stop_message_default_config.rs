use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_MAX_REPEATS: i64 = 3;
const DEFAULT_TEXT: &str = "继续完成当前用户目标。若仍需操作、检查或验证，必须调用可用工具继续执行；不要只总结、道歉、复述状态或输出计划。只有目标已经完成时，才输出最终简短结果。";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageDefaultConfigInput {
    pub tombstone_cleared: Option<bool>,
    pub config_enabled: Option<Value>,
    pub config_text: Option<Value>,
    pub config_max_repeats: Option<Value>,
    pub env_text: Option<Value>,
    pub env_max_repeats: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageDefaultConfigPlan {
    pub enabled: bool,
    pub text: String,
    pub max_repeats: i64,
}

pub fn plan_stop_message_default_config(
    input: &StopMessageDefaultConfigInput,
) -> StopMessageDefaultConfigPlan {
    StopMessageDefaultConfigPlan {
        enabled: if input.tombstone_cleared.unwrap_or(false) {
            false
        } else {
            input
                .config_enabled
                .as_ref()
                .and_then(Value::as_bool)
                .unwrap_or(true)
        },
        text: read_non_empty_trimmed(input.config_text.as_ref())
            .or_else(|| read_non_empty_trimmed(input.env_text.as_ref()))
            .unwrap_or_else(|| DEFAULT_TEXT.to_string()),
        max_repeats: read_positive_floor(input.config_max_repeats.as_ref())
            .or_else(|| read_positive_floor(input.env_max_repeats.as_ref()))
            .unwrap_or(DEFAULT_MAX_REPEATS),
    }
}

fn read_non_empty_trimmed(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn read_positive_floor(value: Option<&Value>) -> Option<i64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(raw) => raw.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !number.is_finite() || number <= 0.0 {
        return None;
    }
    let floored = number.floor();
    if floored < 1.0 || floored > i64::MAX as f64 {
        None
    } else {
        Some(floored as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn config_values_win_over_env_values() {
        let plan = plan_stop_message_default_config(&StopMessageDefaultConfigInput {
            tombstone_cleared: Some(false),
            config_enabled: Some(json!(false)),
            config_text: Some(json!("  config text  ")),
            config_max_repeats: Some(json!(4.8)),
            env_text: Some(json!("env text")),
            env_max_repeats: Some(json!("2")),
        });

        assert_eq!(
            plan,
            StopMessageDefaultConfigPlan {
                enabled: false,
                text: "config text".to_string(),
                max_repeats: 4
            }
        );
    }

    #[test]
    fn falls_back_to_env_text_and_max_repeats() {
        let plan = plan_stop_message_default_config(&StopMessageDefaultConfigInput {
            tombstone_cleared: Some(false),
            config_enabled: None,
            config_text: Some(json!(" ")),
            config_max_repeats: Some(json!(0)),
            env_text: Some(json!(" env text ")),
            env_max_repeats: Some(json!("5.9")),
        });

        assert!(plan.enabled);
        assert_eq!(plan.text, "env text");
        assert_eq!(plan.max_repeats, 5);
    }

    #[test]
    fn tombstone_forces_disabled_without_changing_text_or_repeats() {
        let plan = plan_stop_message_default_config(&StopMessageDefaultConfigInput {
            tombstone_cleared: Some(true),
            config_enabled: Some(json!(true)),
            config_text: Some(json!("go")),
            config_max_repeats: Some(json!(2)),
            env_text: None,
            env_max_repeats: None,
        });

        assert!(!plan.enabled);
        assert_eq!(plan.text, "go");
        assert_eq!(plan.max_repeats, 2);
    }
}
