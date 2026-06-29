use crate::orchestration_policy_contract::ServertoolErrorPlan;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandHooksConfigTextPlanInput {
    pub content: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandHooksConfigPlan {
    pub enabled: bool,
    pub hooks: Vec<PreCommandHookRulePlan>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
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

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePreCommandStateSelectionInput {
    #[serde(default)]
    pub runtime_control_pre_command_state: Option<Value>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePreCommandStateSelectionPlan {
    pub action: RuntimePreCommandStateSelectionAction,
    pub source: RuntimePreCommandStateSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePreCommandStateSelectionAction {
    UseSelected,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePreCommandStateSource {
    RuntimeControl,
    None,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePreCommandStateRuntimeActionInput {
    #[serde(default)]
    pub runtime_control_pre_command_state: Option<Value>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePreCommandStateRuntimeActionPlan {
    pub action: RuntimePreCommandStateRuntimeAction,
    pub source: RuntimePreCommandStateSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_plan: Option<ServertoolErrorPlan>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePreCommandStateRuntimeAction {
    UseSelected,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandHookAttemptInput {
    pub hook: PreCommandHookRulePlan,
    pub request_id: String,
    pub entry_endpoint: String,
    pub provider_protocol: String,
    pub tool_name: String,
    pub tool_call_id: String,
    pub tool_arguments: String,
    pub queue_index: i64,
    pub queue_total: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandHookAttemptPlan {
    pub action: PreCommandHookAttemptAction,
    pub trace_event: PreCommandHookTraceEventPlan,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<PreCommandHookExecutionPlan>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PreCommandHookAttemptAction {
    Skip,
    Execute,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandHookExecutionPlan {
    pub hook_id: String,
    pub timeout_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_script_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jq_expression: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_command: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandHookCompletionInput {
    pub hook_id: String,
    pub priority: i64,
    pub queue_index: i64,
    pub queue_total: i64,
    pub matched: bool,
    pub changed: bool,
    #[serde(default)]
    pub error_message: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandHookCompletionPlan {
    pub action: PreCommandHookCompletionAction,
    pub trace_event: PreCommandHookTraceEventPlan,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandHookEventPayloadInput {
    pub request_id: String,
    pub entry_endpoint: String,
    pub provider_protocol: String,
    pub tool_name: String,
    pub tool_call_id: String,
    pub tool_arguments: String,
    pub hook_id: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandHookEventPayloadPlan {
    pub event_payload: Value,
    pub jq_input: Value,
    pub command: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandStdoutParseInput {
    pub stdout: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandJqStdoutParsePlan {
    pub parsed: Value,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandRuntimeScriptStdoutParsePlan {
    pub action: PreCommandRuntimeScriptStdoutAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_arguments: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PreCommandRuntimeScriptStdoutAction {
    NoChange,
    ReplaceArguments,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PreCommandHookCompletionAction {
    Continue,
    FailFast,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreCommandHookTraceEventPlan {
    pub hook_id: String,
    pub phase: String,
    pub priority: i64,
    pub queue: String,
    pub queue_index: i64,
    pub queue_total: i64,
    pub result: PreCommandHookTraceResult,
    pub reason: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PreCommandHookTraceResult {
    Miss,
    Match,
    Error,
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

pub fn plan_pre_command_hooks_config_text(
    input: &PreCommandHooksConfigTextPlanInput,
) -> Result<PreCommandHooksConfigPlan, String> {
    let raw: Value = serde_json::from_str(&input.content)
        .map_err(|e| format!("parse pre-command hooks config json: {e}"))?;
    Ok(plan_pre_command_hooks_config(
        &PreCommandHooksConfigPlanInput { raw },
    ))
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

pub fn plan_runtime_pre_command_state_selection(
    input: &RuntimePreCommandStateSelectionInput,
) -> RuntimePreCommandStateSelectionPlan {
    if let Some(state) = clone_object_value(input.runtime_control_pre_command_state.as_ref()) {
        return RuntimePreCommandStateSelectionPlan {
            action: RuntimePreCommandStateSelectionAction::UseSelected,
            source: RuntimePreCommandStateSource::RuntimeControl,
            state: Some(state),
        };
    }
    RuntimePreCommandStateSelectionPlan {
        action: RuntimePreCommandStateSelectionAction::UseSelected,
        source: RuntimePreCommandStateSource::None,
        state: None,
    }
}

pub fn plan_runtime_pre_command_state_runtime_action(
    input: &RuntimePreCommandStateRuntimeActionInput,
) -> Result<RuntimePreCommandStateRuntimeActionPlan, String> {
    let selection =
        plan_runtime_pre_command_state_selection(&RuntimePreCommandStateSelectionInput {
            runtime_control_pre_command_state: input.runtime_control_pre_command_state.clone(),
        });

    Ok(RuntimePreCommandStateRuntimeActionPlan {
        action: RuntimePreCommandStateRuntimeAction::UseSelected,
        source: selection.source,
        state: selection.state,
        error_plan: None,
    })
}

pub fn plan_pre_command_hook_attempt(
    input: PreCommandHookAttemptInput,
) -> PreCommandHookAttemptPlan {
    let normalized_tool = normalize_runtime_tool_name(&input.tool_name);
    let current_args = parse_tool_arguments_object(&input.tool_arguments);
    let current_command = extract_command_text(current_args.as_ref(), &input.tool_arguments);
    let trace_base = pre_command_trace_base(
        &input.hook.id,
        input.hook.priority,
        input.queue_index,
        input.queue_total,
    );

    if !input
        .hook
        .tool_names
        .iter()
        .any(|tool| tool == &normalized_tool)
    {
        return PreCommandHookAttemptPlan {
            action: PreCommandHookAttemptAction::Skip,
            trace_event: pre_command_trace_event(
                trace_base,
                PreCommandHookTraceResult::Miss,
                "tool_mismatch",
            ),
            execution: None,
        };
    }
    if !command_matches_regex(input.hook.cmd_regex.as_ref(), &current_command) {
        return PreCommandHookAttemptPlan {
            action: PreCommandHookAttemptAction::Skip,
            trace_event: pre_command_trace_event(
                trace_base,
                PreCommandHookTraceResult::Miss,
                "cmd_regex_mismatch",
            ),
            execution: None,
        };
    }

    PreCommandHookAttemptPlan {
        action: PreCommandHookAttemptAction::Execute,
        trace_event: pre_command_trace_event(
            trace_base,
            PreCommandHookTraceResult::Match,
            "planned",
        ),
        execution: Some(PreCommandHookExecutionPlan {
            hook_id: input.hook.id,
            timeout_ms: input.hook.timeout_ms,
            runtime_script_path: input.hook.runtime_script_path,
            jq_expression: input.hook.jq_expression,
            shell_command: input.hook.shell_command,
        }),
    }
}

pub fn plan_pre_command_hook_completion(
    input: PreCommandHookCompletionInput,
) -> PreCommandHookCompletionPlan {
    let trace_base = pre_command_trace_base(
        &input.hook_id,
        input.priority,
        input.queue_index,
        input.queue_total,
    );
    if let Some(message) = input
        .error_message
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return PreCommandHookCompletionPlan {
            action: PreCommandHookCompletionAction::FailFast,
            trace_event: pre_command_trace_event(
                trace_base,
                PreCommandHookTraceResult::Error,
                message,
            ),
        };
    }
    PreCommandHookCompletionPlan {
        action: PreCommandHookCompletionAction::Continue,
        trace_event: pre_command_trace_event(
            trace_base,
            PreCommandHookTraceResult::Match,
            if input.matched {
                if input.changed {
                    "applied"
                } else {
                    "matched"
                }
            } else {
                "no_action"
            },
        ),
    }
}

pub fn plan_pre_command_hook_event_payload(
    input: PreCommandHookEventPayloadInput,
) -> PreCommandHookEventPayloadPlan {
    let parsed_args = parse_tool_arguments_object(&input.tool_arguments);
    let command = extract_command_text(parsed_args.as_ref(), &input.tool_arguments);
    let arguments = parsed_args
        .clone()
        .unwrap_or_else(|| json!({ "args_raw": input.tool_arguments }));
    PreCommandHookEventPayloadPlan {
        event_payload: json!({
            "requestId": input.request_id,
            "entryEndpoint": input.entry_endpoint,
            "providerProtocol": input.provider_protocol,
            "toolName": normalize_runtime_tool_name(&input.tool_name),
            "toolCallId": input.tool_call_id,
            "arguments": arguments,
            "command": command,
            "hookId": input.hook_id,
        }),
        jq_input: parsed_args.unwrap_or_else(|| json!({ "args_raw": input.tool_arguments })),
        command,
    }
}

pub fn parse_pre_command_jq_stdout(
    input: PreCommandStdoutParseInput,
) -> Result<PreCommandJqStdoutParsePlan, String> {
    let payload = select_last_nonempty_stdout_line(&input.stdout).ok_or("jq_empty_output")?;
    let parsed: Value =
        serde_json::from_str(&payload).map_err(|_| "jq_invalid_json_output".to_string())?;
    if !parsed.is_object() {
        return Err("jq_non_object_output".to_string());
    }
    Ok(PreCommandJqStdoutParsePlan { parsed })
}

pub fn parse_pre_command_runtime_script_stdout(
    input: PreCommandStdoutParseInput,
) -> Result<PreCommandRuntimeScriptStdoutParsePlan, String> {
    let Some(payload) = select_last_nonempty_stdout_line(&input.stdout) else {
        return Ok(PreCommandRuntimeScriptStdoutParsePlan {
            action: PreCommandRuntimeScriptStdoutAction::NoChange,
            tool_arguments: None,
        });
    };
    let parsed = parse_runtime_script_payload(&payload)?;
    if let Some(text) = parsed.as_str() {
        if !text.trim().is_empty() {
            return Ok(replace_runtime_arguments(text.to_string()));
        }
    }
    let Some(record) = parsed.as_object() else {
        return Ok(PreCommandRuntimeScriptStdoutParsePlan {
            action: PreCommandRuntimeScriptStdoutAction::NoChange,
            tool_arguments: None,
        });
    };
    if let Some(tool_arguments) = record
        .get("toolArguments")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(replace_runtime_arguments(tool_arguments.to_string()));
    }
    if let Some(arg_value) = record.get("arguments") {
        if let Some(text) = arg_value.as_str() {
            return Ok(replace_runtime_arguments(text.to_string()));
        }
        if arg_value.is_object() {
            return Ok(replace_runtime_arguments(arg_value.to_string()));
        }
    }
    Ok(replace_runtime_arguments(
        Value::Object(record.clone()).to_string(),
    ))
}

fn replace_runtime_arguments(tool_arguments: String) -> PreCommandRuntimeScriptStdoutParsePlan {
    PreCommandRuntimeScriptStdoutParsePlan {
        action: PreCommandRuntimeScriptStdoutAction::ReplaceArguments,
        tool_arguments: Some(tool_arguments),
    }
}

fn select_last_nonempty_stdout_line(stdout: &str) -> Option<String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .last()
        .map(str::to_string)
        .or_else(|| Some(trimmed.to_string()))
}

fn parse_runtime_script_payload(payload: &str) -> Result<Value, String> {
    match serde_json::from_str::<Value>(payload) {
        Ok(value) => Ok(value),
        Err(_) => {
            let cleaned = payload.replace("\\\"", "\"").trim().to_string();
            let unwrapped =
                if cleaned.starts_with('"') && cleaned.ends_with('"') && cleaned.len() > 1 {
                    cleaned[1..cleaned.len() - 1].to_string()
                } else {
                    cleaned
                };
            serde_json::from_str::<Value>(&unwrapped).map_err(|_| {
                format!(
                    "runtime_precommand_invalid_json:{}",
                    payload.chars().take(200).collect::<String>()
                )
            })
        }
    }
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

fn clone_object_value(raw: Option<&Value>) -> Option<Value> {
    match raw {
        Some(Value::Object(record)) => Some(Value::Object(record.clone())),
        _ => None,
    }
}

fn pre_command_trace_base(
    hook_id: &str,
    priority: i64,
    queue_index: i64,
    queue_total: i64,
) -> PreCommandHookTraceEventPlan {
    PreCommandHookTraceEventPlan {
        hook_id: hook_id.to_string(),
        phase: "pre_command".to_string(),
        priority,
        queue: "A_optional".to_string(),
        queue_index,
        queue_total,
        result: PreCommandHookTraceResult::Miss,
        reason: String::new(),
    }
}

fn pre_command_trace_event(
    mut base: PreCommandHookTraceEventPlan,
    result: PreCommandHookTraceResult,
    reason: &str,
) -> PreCommandHookTraceEventPlan {
    base.result = result;
    base.reason = reason.to_string();
    base
}

fn normalize_runtime_tool_name(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn parse_tool_arguments_object(raw: &str) -> Option<Value> {
    if raw.trim().is_empty() {
        return Some(json!({}));
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => Some(Value::Object(map)),
        _ => None,
    }
}

fn extract_command_text(args: Option<&Value>, raw_args: &str) -> String {
    if let Some(record) = args.and_then(Value::as_object) {
        if let Some(cmd) = record
            .get("cmd")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return cmd.to_string();
        }
        if let Some(command) = record
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return command.to_string();
        }
    }
    raw_args.trim().to_string()
}

fn command_matches_regex(plan: Option<&PreCommandRegexPlan>, command: &str) -> bool {
    let Some(plan) = plan else {
        return true;
    };
    if plan.source.trim().is_empty() {
        return true;
    }
    let pattern = if plan.flags.contains('i') {
        format!("(?i:{})", plan.source)
    } else {
        plan.source.clone()
    };
    Regex::new(&pattern)
        .map(|regex| regex.is_match(command))
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_pre_command_jq_stdout, parse_pre_command_runtime_script_stdout,
        plan_pre_command_hook_attempt, plan_pre_command_hook_completion,
        plan_pre_command_hook_event_payload, plan_pre_command_hooks_config,
        plan_pre_command_hooks_config_text, plan_runtime_pre_command_rule,
        plan_runtime_pre_command_state_runtime_action, plan_runtime_pre_command_state_selection,
        PreCommandHookAttemptAction, PreCommandHookAttemptInput, PreCommandHookCompletionAction,
        PreCommandHookCompletionInput, PreCommandHookEventPayloadInput, PreCommandHookTraceResult,
        PreCommandHooksConfigPlanInput, PreCommandHooksConfigTextPlanInput,
        PreCommandRuntimeScriptStdoutAction, PreCommandStdoutParseInput,
        RuntimePreCommandRulePlanInput, RuntimePreCommandStateRuntimeAction,
        RuntimePreCommandStateRuntimeActionInput, RuntimePreCommandStateSelectionAction,
        RuntimePreCommandStateSelectionInput, RuntimePreCommandStateSource,
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
    fn config_text_plan_parses_json_in_rust() {
        let plan = plan_pre_command_hooks_config_text(&PreCommandHooksConfigTextPlanInput {
            content: json!({
                "hooks": [
                    { "id": "from-text", "tool": "exec_command", "jq": "." }
                ]
            })
            .to_string(),
        })
        .expect("config text plan");
        assert!(plan.enabled);
        assert_eq!(plan.hooks[0].id, "from-text");

        let err = plan_pre_command_hooks_config_text(&PreCommandHooksConfigTextPlanInput {
            content: "{not-json".to_string(),
        })
        .expect_err("invalid config json");
        assert!(err.contains("parse pre-command hooks config json"));
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

    #[test]
    fn runtime_pre_command_state_selection_uses_runtime_control_only() {
        let runtime =
            plan_runtime_pre_command_state_selection(&RuntimePreCommandStateSelectionInput {
                runtime_control_pre_command_state: Some(
                    json!({ "preCommandScriptPath": "/tmp/runtime.sh" }),
                ),
            });
        assert_eq!(
            runtime.action,
            RuntimePreCommandStateSelectionAction::UseSelected
        );
        assert_eq!(runtime.source, RuntimePreCommandStateSource::RuntimeControl);
        assert_eq!(
            runtime.state,
            Some(json!({ "preCommandScriptPath": "/tmp/runtime.sh" }))
        );
    }

    #[test]
    fn runtime_pre_command_state_selection_ignores_invalid_or_missing_control_state() {
        let plan =
            plan_runtime_pre_command_state_selection(&RuntimePreCommandStateSelectionInput {
                runtime_control_pre_command_state: Some(json!(["ignored"])),
            });
        assert_eq!(
            plan.action,
            RuntimePreCommandStateSelectionAction::UseSelected
        );
        assert_eq!(plan.source, RuntimePreCommandStateSource::None);
        assert_eq!(plan.state, None);

        let missing =
            plan_runtime_pre_command_state_selection(&RuntimePreCommandStateSelectionInput {
                runtime_control_pre_command_state: None,
            });
        assert_eq!(
            missing.action,
            RuntimePreCommandStateSelectionAction::UseSelected
        );
        assert_eq!(missing.source, RuntimePreCommandStateSource::None);
        assert_eq!(missing.state, None);
    }

    #[test]
    fn runtime_pre_command_state_runtime_action_delegates_to_selection() {
        let plan = plan_runtime_pre_command_state_runtime_action(
            &RuntimePreCommandStateRuntimeActionInput {
                runtime_control_pre_command_state: Some(json!({
                    "preCommandScriptPath": "/tmp/runtime-pre-command.sh"
                })),
            },
        )
        .expect("runtime action plan");
        assert_eq!(
            plan.action,
            RuntimePreCommandStateRuntimeAction::UseSelected
        );
        assert_eq!(plan.source, RuntimePreCommandStateSource::RuntimeControl);
        assert_eq!(
            plan.state,
            Some(json!({
                "preCommandScriptPath": "/tmp/runtime-pre-command.sh"
            }))
        );
        assert_eq!(plan.error_plan, None);
    }

    #[test]
    fn pre_command_hook_attempt_skips_mismatched_tool_or_command() {
        let hook = plan_pre_command_hooks_config(&PreCommandHooksConfigPlanInput {
            raw: json!({
                "hooks": [
                    { "id": "npm-only", "tool": "exec_command", "cmdRegex": "^npm\\s+", "jq": "." }
                ]
            }),
        })
        .hooks
        .remove(0);

        let wrong_tool = plan_pre_command_hook_attempt(PreCommandHookAttemptInput {
            hook: hook.clone(),
            request_id: "req-1".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-responses".to_string(),
            tool_name: "web_search".to_string(),
            tool_call_id: "call-1".to_string(),
            tool_arguments: json!({ "cmd": "npm test" }).to_string(),
            queue_index: 0,
            queue_total: 1,
        });
        assert_eq!(wrong_tool.action, PreCommandHookAttemptAction::Skip);
        assert_eq!(
            wrong_tool.trace_event.result,
            PreCommandHookTraceResult::Miss
        );
        assert_eq!(wrong_tool.trace_event.reason, "tool_mismatch");

        let wrong_command = plan_pre_command_hook_attempt(PreCommandHookAttemptInput {
            hook,
            request_id: "req-1".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-responses".to_string(),
            tool_name: "exec_command".to_string(),
            tool_call_id: "call-1".to_string(),
            tool_arguments: json!({ "cmd": "echo nope" }).to_string(),
            queue_index: 0,
            queue_total: 1,
        });
        assert_eq!(wrong_command.action, PreCommandHookAttemptAction::Skip);
        assert_eq!(wrong_command.trace_event.reason, "cmd_regex_mismatch");
    }

    #[test]
    fn pre_command_hook_attempt_executes_with_event_payload_and_completion_trace() {
        let hook = plan_pre_command_hooks_config(&PreCommandHooksConfigPlanInput {
            raw: json!({
                "hooks": [
                    { "id": "npm-prefix", "tool": "exec_command", "cmdRegex": "^npm\\s+", "jq": ".cmd = .cmd" }
                ]
            }),
        })
        .hooks
        .remove(0);

        let attempt = plan_pre_command_hook_attempt(PreCommandHookAttemptInput {
            hook,
            request_id: "req-1".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-responses".to_string(),
            tool_name: "EXEC_COMMAND".to_string(),
            tool_call_id: "call-1".to_string(),
            tool_arguments: json!({ "cmd": "npm test" }).to_string(),
            queue_index: 0,
            queue_total: 1,
        });
        assert_eq!(attempt.action, PreCommandHookAttemptAction::Execute);
        let execution = attempt.execution.expect("execution plan");
        assert_eq!(execution.hook_id, "npm-prefix");
        assert_eq!(execution.timeout_ms, 2000);

        let completion = plan_pre_command_hook_completion(PreCommandHookCompletionInput {
            hook_id: "npm-prefix".to_string(),
            priority: 100,
            queue_index: 0,
            queue_total: 1,
            matched: true,
            changed: true,
            error_message: None,
        });
        assert_eq!(completion.action, PreCommandHookCompletionAction::Continue);
        assert_eq!(
            completion.trace_event.result,
            PreCommandHookTraceResult::Match
        );
        assert_eq!(completion.trace_event.reason, "applied");

        let error = plan_pre_command_hook_completion(PreCommandHookCompletionInput {
            hook_id: "npm-prefix".to_string(),
            priority: 100,
            queue_index: 0,
            queue_total: 1,
            matched: true,
            changed: false,
            error_message: Some("jq_failed:1".to_string()),
        });
        assert_eq!(error.action, PreCommandHookCompletionAction::FailFast);
        assert_eq!(error.trace_event.result, PreCommandHookTraceResult::Error);
        assert_eq!(error.trace_event.reason, "jq_failed:1");
    }

    #[test]
    fn pre_command_hook_event_payload_extracts_arguments_command_and_jq_input() {
        let plan = plan_pre_command_hook_event_payload(PreCommandHookEventPayloadInput {
            request_id: "req-1".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-responses".to_string(),
            tool_name: " EXEC_COMMAND ".to_string(),
            tool_call_id: "call-1".to_string(),
            tool_arguments: json!({ "cmd": " npm test ", "workdir": "/tmp" }).to_string(),
            hook_id: "hook-1".to_string(),
        });
        assert_eq!(plan.command, "npm test");
        assert_eq!(plan.jq_input["cmd"], " npm test ");
        assert_eq!(plan.event_payload["requestId"], "req-1");
        assert_eq!(plan.event_payload["toolName"], "exec_command");
        assert_eq!(plan.event_payload["arguments"]["workdir"], "/tmp");

        let raw = plan_pre_command_hook_event_payload(PreCommandHookEventPayloadInput {
            request_id: "req-raw".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            provider_protocol: "openai-chat".to_string(),
            tool_name: "shell".to_string(),
            tool_call_id: "call-raw".to_string(),
            tool_arguments: "not-json".to_string(),
            hook_id: "hook-raw".to_string(),
        });
        assert_eq!(raw.command, "not-json");
        assert_eq!(raw.jq_input, json!({ "args_raw": "not-json" }));
        assert_eq!(
            raw.event_payload["arguments"],
            json!({ "args_raw": "not-json" })
        );
    }

    #[test]
    fn parses_jq_stdout_in_rust() {
        let plan = parse_pre_command_jq_stdout(PreCommandStdoutParseInput {
            stdout: "debug\n{\"cmd\":\"npm test\"}\n".to_string(),
        })
        .expect("jq stdout");
        assert_eq!(plan.parsed, json!({ "cmd": "npm test" }));

        let err = parse_pre_command_jq_stdout(PreCommandStdoutParseInput {
            stdout: "not-json".to_string(),
        })
        .expect_err("invalid jq stdout");
        assert_eq!(err, "jq_invalid_json_output");
    }

    #[test]
    fn parses_runtime_script_stdout_in_rust() {
        let string_plan = parse_pre_command_runtime_script_stdout(PreCommandStdoutParseInput {
            stdout: "\"npm test\"".to_string(),
        })
        .expect("string stdout");
        assert_eq!(
            string_plan.action,
            PreCommandRuntimeScriptStdoutAction::ReplaceArguments
        );
        assert_eq!(string_plan.tool_arguments.as_deref(), Some("npm test"));

        let record_plan = parse_pre_command_runtime_script_stdout(PreCommandStdoutParseInput {
            stdout: "log\n{\"arguments\":{\"cmd\":\"echo ok\"}}\n".to_string(),
        })
        .expect("record stdout");
        assert_eq!(
            record_plan.action,
            PreCommandRuntimeScriptStdoutAction::ReplaceArguments
        );
        assert_eq!(
            record_plan.tool_arguments.as_deref(),
            Some("{\"cmd\":\"echo ok\"}")
        );

        let empty_plan = parse_pre_command_runtime_script_stdout(PreCommandStdoutParseInput {
            stdout: "   ".to_string(),
        })
        .expect("empty stdout");
        assert_eq!(
            empty_plan.action,
            PreCommandRuntimeScriptStdoutAction::NoChange
        );
        assert_eq!(empty_plan.tool_arguments, None);
    }
}
