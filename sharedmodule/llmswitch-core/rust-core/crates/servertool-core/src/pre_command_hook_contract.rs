use serde::{Deserialize, Serialize};
use serde_json::Value;

// feature_id: hub.servertool_pre_command_hooks
const DEFAULT_TIMEOUT_MS: i64 = 2000;
const MAX_TIMEOUT_MS: i64 = 30_000;
const DEFAULT_PRIORITY: i64 = 100;
const DEFAULT_TOOLS: [&str; 3] = ["exec_command", "shell", "shell_command"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandHooksConfigPlanInput {
    pub raw: Value,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandHooksConfigPlan {
    pub enabled: bool,
    pub hooks: Vec<PreCommandHookRulePlan>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandHookRulePlan {
    pub id: String,
    pub tool_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cmd_regex: Option<PreCommandRegexPlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jq_expression: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_script_path: Option<String>,
    pub timeout_ms: i64,
    pub priority: i64,
    pub order: i64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandRegexPlan {
    pub source: String,
    pub flags: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePreCommandRulePlanInput {
    pub raw_state: Value,
    #[serde(default)]
    pub env_timeout_ms: Option<Value>,
    pub script_path_allowed: bool,
}

pub fn plan_pre_command_hooks_config(
    input: &PreCommandHooksConfigPlanInput,
) -> PreCommandHooksConfigPlan {
    let Some(record) = input.raw.as_object() else {
        return disabled_config();
    };
    if record.get("enabled").and_then(Value::as_bool) == Some(false) {
        return disabled_config();
    }
    let mut hooks = record
        .get("hooks")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| normalize_pre_command_hook_rule(item, index as i64))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    hooks.sort_by(|left, right| {
        left.priority
            .cmp(&right.priority)
            .then(left.order.cmp(&right.order))
            .then(left.id.cmp(&right.id))
    });
    PreCommandHooksConfigPlan {
        enabled: true,
        hooks,
    }
}

pub fn plan_runtime_pre_command_rule(
    input: &RuntimePreCommandRulePlanInput,
) -> Option<PreCommandHookRulePlan> {
    let record = input.raw_state.as_object()?;
    let script_path = read_string(
        record
            .get("preCommandScriptPath")
            .or_else(|| record.get("scriptPath")),
    )?;
    if !input.script_path_allowed {
        return None;
    }
    let timeout_ms = normalize_timeout_ms(
        record
            .get("timeoutMs")
            .or_else(|| record.get("timeout_ms"))
            .or(input.env_timeout_ms.as_ref()),
    );
    Some(PreCommandHookRulePlan {
        id: format!(
            "runtime_precommand:{}",
            sanitize_hook_id(
                script_path
                    .rsplit(['/', '\\'])
                    .next()
                    .filter(|value| !value.is_empty())
                    .unwrap_or("script")
            )
        ),
        tool_names: DEFAULT_TOOLS
            .iter()
            .map(|tool| (*tool).to_string())
            .collect(),
        cmd_regex: None,
        jq_expression: None,
        shell_command: None,
        runtime_script_path: Some(script_path),
        timeout_ms,
        priority: -1000,
        order: -1,
    })
}

fn disabled_config() -> PreCommandHooksConfigPlan {
    PreCommandHooksConfigPlan {
        enabled: false,
        hooks: Vec::new(),
    }
}

fn normalize_pre_command_hook_rule(raw: &Value, order: i64) -> Option<PreCommandHookRulePlan> {
    let record = raw.as_object()?;
    if record.get("enabled").and_then(Value::as_bool) == Some(false) {
        return None;
    }

    let jq_expression = read_string(
        record
            .get("jq")
            .or_else(|| record.get("jqTransform"))
            .or_else(|| record.get("expression")),
    );
    let shell_command = read_string(record.get("shell").or_else(|| record.get("command")));
    if jq_expression.is_none() && shell_command.is_none() {
        return None;
    }
    Some(PreCommandHookRulePlan {
        id: normalize_hook_id(record.get("id"), order),
        tool_names: normalize_tool_set(record.get("tool").or_else(|| record.get("tools"))),
        cmd_regex: parse_regex_plan(
            record
                .get("cmdRegex")
                .or_else(|| record.get("commandRegex"))
                .or_else(|| record.get("matchCommand")),
        ),
        jq_expression,
        shell_command,
        runtime_script_path: None,
        timeout_ms: normalize_timeout_ms(
            record.get("timeoutMs").or_else(|| record.get("timeout_ms")),
        ),
        priority: normalize_priority(record.get("priority")),
        order,
    })
}

fn normalize_hook_id(value: Option<&Value>, order: i64) -> String {
    read_string(value)
        .map(|text| sanitize_hook_id(&text))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| format!("pre_command_hook_{}", order + 1))
}

fn sanitize_hook_id(value: &str) -> String {
    let mut output = String::new();
    let mut previous_underscore = false;
    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-' {
            ch
        } else {
            '_'
        };
        if next == '_' {
            if previous_underscore {
                continue;
            }
            previous_underscore = true;
        } else {
            previous_underscore = false;
        }
        output.push(next);
    }
    output
}

fn normalize_tool_set(raw: Option<&Value>) -> Vec<String> {
    let mut output = Vec::new();
    let mut push = |value: &Value| {
        if let Some(tool) = read_string(Some(value)).map(|text| text.to_ascii_lowercase()) {
            if !output.iter().any(|existing| existing == &tool) {
                output.push(tool);
            }
        }
    };
    if let Some(Value::Array(items)) = raw {
        for item in items {
            push(item);
        }
    } else if let Some(value) = raw {
        push(value);
    }
    if output.is_empty() {
        output.extend(DEFAULT_TOOLS.iter().map(|tool| (*tool).to_string()));
    }
    output
}

fn parse_regex_plan(raw: Option<&Value>) -> Option<PreCommandRegexPlan> {
    let value = read_string(raw)?;
    if value.is_empty() {
        return None;
    }
    if value.starts_with('/') {
        if let Some(end_index) = value.rfind('/') {
            if end_index > 0 {
                let source = value[1..end_index].to_string();
                let flags = value[end_index + 1..].trim();
                return Some(PreCommandRegexPlan {
                    source,
                    flags: if flags.is_empty() {
                        "i".to_string()
                    } else {
                        flags.to_string()
                    },
                });
            }
        }
    }
    Some(PreCommandRegexPlan {
        source: value,
        flags: "i".to_string(),
    })
}

fn normalize_timeout_ms(raw: Option<&Value>) -> i64 {
    let Some(value) = read_floor_i64(raw) else {
        return DEFAULT_TIMEOUT_MS;
    };
    if value <= 0 {
        return DEFAULT_TIMEOUT_MS;
    }
    value.min(MAX_TIMEOUT_MS)
}

fn normalize_priority(raw: Option<&Value>) -> i64 {
    read_floor_i64(raw).unwrap_or(DEFAULT_PRIORITY)
}

fn read_string(raw: Option<&Value>) -> Option<String> {
    raw.and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn read_floor_i64(raw: Option<&Value>) -> Option<i64> {
    let value = raw?;
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number).ok();
    }
    if let Some(number) = value.as_f64() {
        if number.is_finite() {
            return Some(number.floor() as i64);
        }
    }
    if let Some(text) = value.as_str() {
        return parse_js_int_prefix(text);
    }
    None
}

fn parse_js_int_prefix(value: &str) -> Option<i64> {
    let trimmed = value.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    let mut chars = trimmed.char_indices();
    let mut end = 0usize;
    if let Some((index, ch)) = chars.next() {
        if ch == '+' || ch == '-' {
            end = index + ch.len_utf8();
        } else if ch.is_ascii_digit() {
            end = index + ch.len_utf8();
        } else {
            return None;
        }
    }
    for (index, ch) in chars {
        if !ch.is_ascii_digit() {
            break;
        }
        end = index + ch.len_utf8();
    }
    let candidate = &trimmed[..end];
    if candidate == "+" || candidate == "-" {
        return None;
    }
    candidate.parse::<i64>().ok()
}

#[cfg(test)]
mod tests {
    use super::{
        plan_pre_command_hooks_config, plan_runtime_pre_command_rule,
        PreCommandHooksConfigPlanInput, RuntimePreCommandRulePlanInput,
    };
    use serde_json::json;

    #[test]
    fn config_plan_normalizes_rules_and_orders_by_priority() {
        let plan = plan_pre_command_hooks_config(&PreCommandHooksConfigPlanInput {
            raw: json!({
                "enabled": true,
                "hooks": [
                    { "id": "second hook", "tool": "exec_command", "priority": "20.8", "jq": ".cmd = .cmd", "timeoutMs": "999999" },
                    { "id": "unit-timeout", "tool": "exec_command", "priority": "30ms", "jq": ".cmd = .cmd", "timeoutMs": "1500ms" },
                    { "id": "first-hook", "tools": [" SHELL ", "shell"], "priority": 10, "cmdRegex": "/^npm\\s+/g", "shell": "echo ok" },
                    { "id": "disabled", "enabled": false, "jq": "." },
                    { "id": "no-action" }
                ]
            }),
        });

        assert!(plan.enabled);
        assert_eq!(plan.hooks.len(), 3);
        assert_eq!(plan.hooks[0].id, "first-hook");
        assert_eq!(plan.hooks[0].tool_names, vec!["shell"]);
        assert_eq!(plan.hooks[0].priority, 10);
        assert_eq!(plan.hooks[0].cmd_regex.as_ref().unwrap().source, "^npm\\s+");
        assert_eq!(plan.hooks[0].cmd_regex.as_ref().unwrap().flags, "g");
        assert_eq!(plan.hooks[1].id, "second_hook");
        assert_eq!(plan.hooks[1].timeout_ms, 30_000);
        assert_eq!(plan.hooks[2].id, "unit-timeout");
        assert_eq!(plan.hooks[2].priority, 30);
        assert_eq!(plan.hooks[2].timeout_ms, 1500);
    }

    #[test]
    fn config_plan_disables_non_object_and_disabled_config() {
        assert!(
            !plan_pre_command_hooks_config(&PreCommandHooksConfigPlanInput { raw: json!(null) })
                .enabled
        );
        assert!(
            !plan_pre_command_hooks_config(&PreCommandHooksConfigPlanInput {
                raw: json!({ "enabled": false, "hooks": [{ "jq": "." }] })
            })
            .enabled
        );
    }

    #[test]
    fn runtime_rule_plan_uses_allowed_script_and_env_timeout() {
        let plan = plan_runtime_pre_command_rule(&RuntimePreCommandRulePlanInput {
            raw_state: json!({ "preCommandScriptPath": "/tmp/rewrite script.sh" }),
            env_timeout_ms: Some(json!("1234.9")),
            script_path_allowed: true,
        })
        .expect("runtime plan");

        assert_eq!(plan.id, "runtime_precommand:rewrite_script.sh");
        assert_eq!(
            plan.tool_names,
            vec!["exec_command", "shell", "shell_command"]
        );
        assert_eq!(
            plan.runtime_script_path.as_deref(),
            Some("/tmp/rewrite script.sh")
        );
        assert_eq!(plan.timeout_ms, 1234);
        assert_eq!(plan.priority, -1000);

        assert!(
            plan_runtime_pre_command_rule(&RuntimePreCommandRulePlanInput {
                raw_state: json!({ "preCommandScriptPath": "/tmp/rewrite.sh" }),
                env_timeout_ms: None,
                script_path_allowed: false,
            })
            .is_none()
        );
    }
}
