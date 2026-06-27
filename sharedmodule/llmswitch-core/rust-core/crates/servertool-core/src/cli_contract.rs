use crate::outcome_contract::{
    classify_servertool_outcome, is_client_exec_cli_projection, is_denied_cli_projection,
    quote_posix_single_argument, DENIED_CLI_MARKERS,
};
use crate::stopless_prompt::{
    resolve_stopless_continuation_prompt, StoplessContinuationPromptInput,
    StoplessContinuationTrigger,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use stop_message_core::{
    evaluate_stop_schema_gate_with_reasoning_stop_arguments, StopSchemaGateAction,
};
const STOP_MESSAGE_AUTO_TOOL_NAME: &str = "stop_message_auto";
const REASONING_STOP_PUBLIC_TOOL_NAME: &str = "reasoningStop";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolCliRunInput {
    pub tool_name: String,
    pub input: Value,
    pub flow_id: Option<String>,
    pub repeat_count: Option<u32>,
    pub max_repeats: Option<u32>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolCliRunOutput {
    pub ok: bool,
    pub kind: String,
    pub tool: String,
    pub summary: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub model_guidance: String,
    pub tool_name: String,
    pub flow_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route_hint: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub continuation_prompt: String,
    pub repeat_count: u32,
    pub max_repeats: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_guidance: Option<StoplessSchemaGuidance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_feedback: Option<StoplessSchemaFeedback>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injected_prompt_preview: Option<String>,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessSchemaGuidance {
    pub schema_overview: String,
    pub schema_purpose: String,
    pub required_fields: Vec<String>,
    pub field_descriptions: Vec<StoplessSchemaFieldDescription>,
    pub stopreason_values: StopreasonValues,
    pub trigger_hint: String,
    pub decision_rules: Vec<String>,
    pub invalid_examples: Vec<String>,
    pub sample: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessSchemaFieldDescription {
    pub field: String,
    pub meaning: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessSchemaFeedback {
    pub reason_code: String,
    #[serde(default)]
    pub missing_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopreasonValues {
    pub finished: u8,
    pub blocked: u8,
    pub continue_needed: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolClientVisibleProjectionShellInput {
    pub request_id: String,
    pub client_call_id: String,
    pub native_projection: Value,
    pub reasoning_text: String,
    #[serde(default)]
    pub additional_tool_calls: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolCliProjectionExecutionContextInput {
    pub request_id: String,
    pub client_call_id: String,
    pub tool_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClientExecCliProjectionInput {
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub flow_id: Option<String>,
    #[serde(default)]
    pub input: Option<Value>,
    #[serde(default)]
    pub repeat_count: Option<u32>,
    #[serde(default)]
    pub max_repeats: Option<u32>,
    #[serde(default)]
    pub stdout_preview: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ServertoolCliError {
    UnsupportedTool(String),
    DeniedTool(String),
    DeniedMarker(&'static str),
    DeniedInternalCarrier(&'static str),
    MissingField(&'static str),
    InvalidField(&'static str),
}

impl std::fmt::Display for ServertoolCliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServertoolCliError::UnsupportedTool(tool) => {
                write!(f, "SERVERTOOL_UNSUPPORTED_TOOL: {tool}")
            }
            ServertoolCliError::DeniedTool(tool) => {
                write!(f, "SERVERTOOL_DENIED_TOOL: {tool}")
            }
            ServertoolCliError::DeniedMarker(marker) => {
                write!(f, "SERVERTOOL_DENIED_CLI_MARKER: {marker}")
            }
            ServertoolCliError::DeniedInternalCarrier(carrier) => {
                write!(f, "SERVERTOOL_DENIED_INTERNAL_CARRIER: {carrier}")
            }
            ServertoolCliError::MissingField(field) => {
                write!(f, "SERVERTOOL_CLI_MISSING_FIELD: {field}")
            }
            ServertoolCliError::InvalidField(field) => {
                write!(f, "SERVERTOOL_CLI_INVALID_FIELD: {field}")
            }
        }
    }
}

impl std::error::Error for ServertoolCliError {}

pub fn build_servertool_cli_binary_run_command_from_client_exec_result(
    input: ServertoolCliRunInput,
) -> Result<ServertoolCliRunOutput, ServertoolCliError> {
    let invoked_public_reasoning_stop = input
        .tool_name
        .trim()
        .eq_ignore_ascii_case(REASONING_STOP_PUBLIC_TOOL_NAME);
    let input = normalize_cli_run_input_aliases(input)?;
    validate_cli_run_input(&input)?;
    match input.tool_name.as_str() {
        STOP_MESSAGE_AUTO_TOOL_NAME => {
            build_stop_message_auto_run_output(input, invoked_public_reasoning_stop)
        }
        "servertool_fixture" => build_servertool_fixture_run_output(input),
        "web_search" | "vision_auto" => build_generic_client_exec_cli_run_output(input),
        other => Err(ServertoolCliError::UnsupportedTool(other.to_string())),
    }
}

fn is_safe_stopless_identity(value: &str) -> bool {
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.'))
}

fn normalize_stopless_session_identity(
    input: &ServertoolCliRunInput,
) -> Result<(Option<String>, Option<String>), ServertoolCliError> {
    let session_id = input.session_id.as_deref().and_then(read_optional_trimmed);
    let request_id = input.request_id.as_deref().and_then(read_optional_trimmed);
    if let Some(value) = session_id.as_deref() {
        if !is_safe_stopless_identity(value) {
            return Err(ServertoolCliError::InvalidField("sessionId"));
        }
    }
    if let Some(value) = request_id.as_deref() {
        if !is_safe_stopless_identity(value) {
            return Err(ServertoolCliError::InvalidField("requestId"));
        }
    }
    Ok((session_id, request_id))
}

fn validate_cli_run_input(input: &ServertoolCliRunInput) -> Result<(), ServertoolCliError> {
    validate_no_denied_cli_marker(&input.tool_name)?;
    if let Some(flow_id) = input.flow_id.as_deref() {
        validate_no_denied_cli_marker(flow_id)?;
    }
    if !is_safe_tool_name(&input.tool_name) {
        return Err(ServertoolCliError::InvalidField("toolName"));
    }
    if is_denied_cli_projection(&input.tool_name) {
        return Err(ServertoolCliError::DeniedTool(input.tool_name.clone()));
    }
    if !input.input.is_object() {
        return Err(ServertoolCliError::InvalidField("inputJson"));
    }
    validate_no_denied_cli_marker(
        &serde_json::to_string(&input.input)
            .map_err(|_| ServertoolCliError::InvalidField("inputJson"))?,
    )?;
    validate_no_internal_carrier(&input.input)?;
    Ok(())
}

fn normalize_cli_run_input_aliases(
    mut input: ServertoolCliRunInput,
) -> Result<ServertoolCliRunInput, ServertoolCliError> {
    let normalized = match input.tool_name.trim() {
        REASONING_STOP_PUBLIC_TOOL_NAME => STOP_MESSAGE_AUTO_TOOL_NAME,
        other => other,
    };
    if normalized.is_empty() {
        return Err(ServertoolCliError::MissingField("toolName"));
    }
    input.tool_name = normalized.to_string();
    Ok(input)
}

fn build_terminal_stopless_output(
    session_id: Option<String>,
    request_id: Option<String>,
    continuation_prompt: String,
    max_repeats: u32,
) -> ServertoolCliRunOutput {
    ServertoolCliRunOutput {
        ok: true,
        kind: "stop_message_auto".to_string(),
        tool: "stop_message_auto".to_string(),
        summary: "stopless budget exhausted".to_string(),
        model_guidance: continuation_prompt.clone(),
        tool_name: "stop_message_auto".to_string(),
        flow_id: "stop_message_flow".to_string(),
        route_hint: None,
        continuation_prompt,
        repeat_count: max_repeats,
        max_repeats,
        session_id,
        request_id,
        schema_guidance: Some(stopless_schema_guidance_with_trigger(
            StoplessContinuationTrigger::BudgetExhausted,
            max_repeats.saturating_sub(1),
            max_repeats,
        )),
        schema_feedback: None,
        injected_prompt_preview: None,
        input: serde_json::json!({
            "flowId": "stop_message_flow",
            "repeatCount": max_repeats,
            "maxRepeats": max_repeats,
            "triggerHint": "budget_exhausted"
        }),
    }
}

fn stop_schema_field_keys() -> &'static [&'static str] {
    &[
        "stopreason",
        "reason",
        "has_evidence",
        "evidence",
        "issue_cause",
        "excluded_factors",
        "diagnostic_order",
        "done_steps",
        "next_step",
        "next_suggested_path",
        "needs_user_input",
        "learned",
        "forcestop",
    ]
}

fn input_looks_like_raw_reasoning_stop_schema(input: &Value) -> bool {
    let Some(row) = input.as_object() else {
        return false;
    };
    stop_schema_field_keys()
        .iter()
        .any(|key| row.contains_key(*key))
}

fn extract_raw_reasoning_stop_schema(input: &Value) -> Option<Value> {
    let row = input.as_object()?;
    let mut extracted = serde_json::Map::new();
    for key in stop_schema_field_keys() {
        if let Some(value) = row.get(*key) {
            extracted.insert((*key).to_string(), value.clone());
        }
    }
    if extracted.is_empty() {
        return None;
    }
    Some(Value::Object(extracted))
}

fn derive_stopless_feedback_from_raw_reasoning_stop_input(
    input: &Value,
    current_repeat_count: u32,
    current_max_repeats: u32,
) -> Result<Option<(StoplessContinuationTrigger, Option<StoplessSchemaFeedback>)>, ServertoolCliError>
{
    if !input_looks_like_raw_reasoning_stop_schema(input) {
        return Ok(None);
    }
    let raw_schema = extract_raw_reasoning_stop_schema(input)
        .ok_or(ServertoolCliError::InvalidField("inputJson"))?;
    let raw_arguments = serde_json::to_string(&raw_schema)
        .map_err(|_| ServertoolCliError::InvalidField("inputJson"))?;
    let used = current_repeat_count.saturating_sub(1);
    let no_change_count = current_repeat_count.saturating_sub(1);
    let decision = evaluate_stop_schema_gate_with_reasoning_stop_arguments(
        "",
        Some(&raw_arguments),
        used,
        current_max_repeats,
        "",
        no_change_count,
    );
    let trigger = read_stopless_trigger_hint(&serde_json::json!({
        "triggerHint": decision.reason_code
    }));
    let feedback = match decision.action {
        StopSchemaGateAction::AllowStop => None,
        StopSchemaGateAction::Followup | StopSchemaGateAction::FailFast => {
            Some(StoplessSchemaFeedback {
                reason_code: decision.reason_code,
                missing_fields: decision.missing_fields,
            })
        }
    };
    Ok(Some((trigger, feedback)))
}

fn build_stop_message_auto_run_output(
    input: ServertoolCliRunInput,
    invoked_public_reasoning_stop: bool,
) -> Result<ServertoolCliRunOutput, ServertoolCliError> {
    let (session_id, request_id) = normalize_stopless_session_identity(&input)?;
    let current_repeat_count = input
        .repeat_count
        .or_else(|| read_u32(&input.input, "repeatCount"))
        .unwrap_or(1);
    let current_repeat_count = current_repeat_count.max(1);
    let current_max_repeats = input
        .max_repeats
        .or_else(|| read_u32(&input.input, "maxRepeats"))
        .unwrap_or(3)
        .max(1);
    let visible_repeat_count = current_repeat_count;

    let derived_schema_feedback = if invoked_public_reasoning_stop {
        derive_stopless_feedback_from_raw_reasoning_stop_input(
            &input.input,
            current_repeat_count,
            current_max_repeats,
        )?
    } else {
        None
    };
    let derived_trigger = derived_schema_feedback
        .as_ref()
        .map(|(trigger, _)| *trigger);
    if current_max_repeats == 0
        || (current_repeat_count >= current_max_repeats
            && derived_trigger != Some(StoplessContinuationTrigger::SchemaPass))
    {
        // 打满后优雅停止，不报错；但若当前这次已经提交了合法终态 schema，
        // 必须允许 schema_pass 正常收尾，而不是被 budget_exhausted 吞掉。
        let continuation_prompt =
            resolve_stopless_continuation_prompt(StoplessContinuationPromptInput {
                used: current_max_repeats.saturating_sub(1),
                max_repeats: current_max_repeats,
                trigger: StoplessContinuationTrigger::BudgetExhausted,
            })
            .expect("prompt");
        return Ok(build_terminal_stopless_output(
            session_id,
            request_id,
            continuation_prompt.client_visible_text,
            current_max_repeats,
        ));
    }
    let used_for_prompt = current_repeat_count.saturating_sub(1);
    let flow_id = input
        .flow_id
        .as_deref()
        .map(|value| non_empty(Some(value), "flowId"))
        .transpose()?
        .or_else(|| read_non_empty_string(&input.input, "flowId").ok())
        .or_else(|| invoked_public_reasoning_stop.then(|| "stop_message_flow".to_string()))
        .ok_or(ServertoolCliError::MissingField("flowId"))?;
    if flow_id != "stop_message_flow" {
        return Err(ServertoolCliError::InvalidField("flowId"));
    }
    let trigger = derived_schema_feedback
        .as_ref()
        .map(|(trigger, _)| *trigger)
        .unwrap_or_else(|| read_stopless_trigger_hint(&input.input));
    let schema_feedback = derived_schema_feedback
        .and_then(|(_, feedback)| feedback)
        .or_else(|| read_stopless_schema_feedback(&input.input));
    let canonical_input = serde_json::json!({
        "flowId": flow_id,
        "repeatCount": visible_repeat_count,
        "maxRepeats": current_max_repeats,
        "triggerHint": stopless_trigger_hint(trigger)
    });
    let continuation_prompt =
        resolve_stopless_cli_continuation_prompt(trigger, used_for_prompt, current_max_repeats)?;
    let _model_guidance = build_stopless_cli_model_guidance(
        &continuation_prompt,
        schema_feedback.as_ref(),
        current_repeat_count,
    );
    Ok(ServertoolCliRunOutput {
        ok: true,
        kind: "stop_message_auto".to_string(),
        tool: "stop_message_auto".to_string(),
        summary: "stopless continuation ready".to_string(),
        model_guidance: String::new(),
        tool_name: input.tool_name,
        flow_id,
        route_hint: Some("thinking".to_string()),
        continuation_prompt,
        repeat_count: visible_repeat_count,
        max_repeats: current_max_repeats,
        session_id,
        request_id,
        schema_guidance: None,
        schema_feedback,
        injected_prompt_preview: None,
        input: canonical_input,
    })
}

fn resolve_stopless_cli_continuation_prompt(
    trigger: StoplessContinuationTrigger,
    used_for_prompt: u32,
    max_repeats: u32,
) -> Result<String, ServertoolCliError> {
    resolve_stopless_continuation_prompt(StoplessContinuationPromptInput {
        used: used_for_prompt,
        max_repeats,
        trigger,
    })
    .map(|resolved| resolved.client_visible_text)
    .map_err(|_| ServertoolCliError::InvalidField("continuationPrompt"))
}

fn build_stopless_cli_model_guidance(
    continuation_prompt: &str,
    schema_feedback: Option<&StoplessSchemaFeedback>,
    current_repeat_count: u32,
) -> String {
    if current_repeat_count <= 1 {
        return "继续执行，完成既定目标。".to_string();
    }

    let mut parts = Vec::<String>::new();
    parts.push("这是什么：stop schema 是模型在准备结束、暂停或继续时返回的收尾报告。".to_string());
    parts.push(
        "为什么要填：它把结论、证据、根因、排查顺序和下一步固定下来，让系统知道现在是 finished、blocked 还是 continue_needed。".to_string(),
    );
    parts.push(
        "怎么理解这个 schema：它是 stop result 的结构化 JSON 约定，不是普通总结。".to_string(),
    );
    parts.push(
        "字段怎么写：stopreason=0/1/2；reason 写当前状态；has_evidence 用 0/1；evidence 写证据；issue_cause 写卡点；next_step 写下一步具体动作。".to_string(),
    );
    parts.push("怎么填：每个字段都要写具体内容；不要只写空话或只写字段名。".to_string());
    parts.push("stopreason 取值：0=finished，1=blocked，2=continue_needed。".to_string());
    parts.push(
        "最小可复制样本：{\"stopreason\":2,\"reason\":\"当前还在推进，先继续执行\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"先看入口，再看链路，再看验证\",\"done_steps\":\"已完成现有排查\",\"next_step\":\"继续完成剩余验证并补最后一轮证据\",\"next_suggested_path\":\"按当前链路继续\",\"needs_user_input\":false,\"learned\":\"把真实结论写进 stop schema\"}".to_string(),
    );
    if let Some(feedback) = schema_feedback {
        if feedback.reason_code == "stop_schema_missing" {
            if feedback.missing_fields.is_empty() {
                parts.push("这次收尾未通过：缺少 stop schema 必填字段。".to_string());
            } else {
                parts.push(format!(
                    "这次收尾未通过：缺少 stop schema 必填字段：{}。",
                    feedback.missing_fields.join(", ")
                ));
            }
        } else if feedback.missing_fields.is_empty() {
            parts.push(format!("这次收尾未通过：{}。", feedback.reason_code));
        } else {
            parts.push(format!(
                "这次收尾未通过：{}；缺少字段：{}。",
                feedback.reason_code,
                feedback.missing_fields.join(", ")
            ));
        }
        let repair_lines = build_stopless_missing_field_repair_lines(feedback);
        if !repair_lines.is_empty() {
            parts.push("这些字段必须补齐，按下面方式填写：".to_string());
            parts.extend(repair_lines);
        }
    }
    let prompt = continuation_prompt.trim();
    if !prompt.is_empty() {
        parts.push(prompt.to_string());
    }
    if let Some(feedback) = schema_feedback {
        if feedback.reason_code == "stop_schema_missing" {
            let missing = if feedback.missing_fields.is_empty() {
                String::new()
            } else {
                feedback.missing_fields.join(", ")
            };
            if current_repeat_count <= 1 {
                if missing.is_empty() {
                    parts.push("继续执行；如果任务已经完成，就按 stop schema 收尾。".to_string());
                } else {
                    parts.push(format!(
                        "继续执行；如果任务已经完成，就补齐 stop schema：{}。",
                        missing
                    ));
                }
            } else if missing.is_empty() {
                parts.push(
                    "如果任务已经完成，补齐 stop schema；如果任务还没完成，不要停，继续执行当前任务。"
                        .to_string(),
                );
            } else {
                parts.push(format!(
                    "如果任务已经完成，补齐 stop schema：{}；如果任务还没完成，不要停，继续执行当前任务。",
                    missing
                ));
            }
        }
    }
    parts.join("\n")
}

fn build_stopless_missing_field_repair_lines(feedback: &StoplessSchemaFeedback) -> Vec<String> {
    let mut lines = Vec::new();
    if feedback.reason_code == "stop_schema_terminal_missing_fields" {
        lines.push(
            "终态 stop schema 要求更严格：当 stopreason=0/1 时，has_evidence 必须是 1，且 evidence、issue_cause、excluded_factors、diagnostic_order、done_steps 都必须给出具体内容。".to_string(),
        );
    }
    for field in &feedback.missing_fields {
        if let Some(instruction) = stopless_field_repair_instruction(field) {
            lines.push(format!("- {}", instruction));
        } else {
            lines.push(format!(
                "- {}：这是 stop schema 必填字段，必须补具体内容，不能留空。",
                field
            ));
        }
    }
    lines
}

fn stopless_field_repair_instruction(field: &str) -> Option<&'static str> {
    match field {
        "stopreason" => Some(
            "stopreason：必填数字；0=finished，1=blocked，2=continue_needed。只有真的完成且没有剩余 next_step 时才能填 0。",
        ),
        "reason" => Some(
            "reason：用一句具体的话写清当前状态，说明为什么结束、为什么阻塞，或为什么还要继续。",
        ),
        "has_evidence" => Some(
            "has_evidence：只能填 0 或 1；已有文件、日志、命令输出或测试证据就填 1，没有证据才填 0。",
        ),
        "evidence" => Some(
            "evidence：写真正支撑结论的证据，例如文件路径、日志片段、命令结果或测试结论；终态 stopreason=0/1 时不能留空。",
        ),
        "issue_cause" => Some(
            "issue_cause：写根因或当前卡点；如果已经完成，也要说明本轮最终确认的问题原因是什么。",
        ),
        "excluded_factors" => Some(
            "excluded_factors：写已经排除掉的错误方向，避免只给结论不说明排除过程。",
        ),
        "diagnostic_order" => Some(
            "diagnostic_order：按顺序写本轮排查路径，例如先看入口，再看链路，再看验证结果。",
        ),
        "done_steps" => Some(
            "done_steps：列出已经实际完成的动作，不要写空话；至少说明改了什么、跑了什么验证。",
        ),
        "next_step" => Some(
            "next_step：如果 stopreason=2，必须写下一步要执行的具体动作；如果 stopreason=0/1，通常留空字符串即可。",
        ),
        "next_suggested_path" => Some(
            "next_suggested_path：写下一轮最合适的继续路径，告诉系统后面应该沿哪条线推进。",
        ),
        "needs_user_input" => Some(
            "needs_user_input：只能填 true 或 false；只有真的需要向用户提问时才填 true，而且 next_step 必须直接写出要问的问题。",
        ),
        "learned" => Some(
            "learned：写这轮真正学到的可复用结论；如果暂时没有，也要明确填一个具体结论而不是留空。",
        ),
        "forcestop" => Some(
            "forcestop：只有必须强制停止时才填 1，并且必须同时给非空 reason 说明为什么必须停。",
        ),
        _ => None,
    }
}

fn build_servertool_fixture_run_output(
    input: ServertoolCliRunInput,
) -> Result<ServertoolCliRunOutput, ServertoolCliError> {
    let flow_id = input
        .flow_id
        .as_deref()
        .map(|value| non_empty(Some(value), "flowId"))
        .transpose()?
        .or_else(|| read_non_empty_string(&input.input, "flowId").ok())
        .unwrap_or_else(|| "servertool_cli_projection".to_string());
    Ok(ServertoolCliRunOutput {
        ok: true,
        kind: "servertool_fixture".to_string(),
        tool: "servertool_fixture".to_string(),
        summary: "servertool fixture result".to_string(),
        model_guidance: String::new(),
        tool_name: input.tool_name,
        flow_id,
        route_hint: None,
        continuation_prompt: String::new(),
        repeat_count: input
            .repeat_count
            .or_else(|| read_u32(&input.input, "repeatCount"))
            .unwrap_or(0),
        max_repeats: input
            .max_repeats
            .or_else(|| read_u32(&input.input, "maxRepeats"))
            .unwrap_or(0),
        session_id: input.session_id.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }),
        request_id: input.request_id.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }),
        schema_guidance: None,
        schema_feedback: None,
        injected_prompt_preview: None,
        input: input.input,
    })
}

fn build_generic_client_exec_cli_run_output(
    input: ServertoolCliRunInput,
) -> Result<ServertoolCliRunOutput, ServertoolCliError> {
    let flow_id = input
        .flow_id
        .as_deref()
        .map(|value| non_empty(Some(value), "flowId"))
        .transpose()?
        .or_else(|| read_non_empty_string(&input.input, "flowId").ok())
        .unwrap_or_else(|| "servertool_cli_projection".to_string());
    let route_hint = route_hint_for_client_exec_tool(&input.tool_name).map(str::to_string);
    Ok(ServertoolCliRunOutput {
        ok: true,
        kind: input.tool_name.clone(),
        tool: input.tool_name.clone(),
        summary: format!("{} cli result", input.tool_name),
        model_guidance: String::new(),
        tool_name: input.tool_name,
        flow_id,
        route_hint,
        continuation_prompt: String::new(),
        repeat_count: input
            .repeat_count
            .or_else(|| read_u32(&input.input, "repeatCount"))
            .unwrap_or(0),
        max_repeats: input
            .max_repeats
            .or_else(|| read_u32(&input.input, "maxRepeats"))
            .unwrap_or(0),
        session_id: input.session_id.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }),
        request_id: input.request_id.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }),
        schema_guidance: None,
        schema_feedback: None,
        injected_prompt_preview: None,
        input: input.input,
    })
}

fn route_hint_for_client_exec_tool(tool_name: &str) -> Option<&'static str> {
    match tool_name {
        "web_search" => Some("web_search"),
        "vision_auto" => Some("multimodal"),
        _ => None,
    }
}

pub fn stopless_schema_guidance_with_trigger(
    trigger: StoplessContinuationTrigger,
    _used: u32,
    _max_repeats: u32,
) -> StoplessSchemaGuidance {
    let sample = r#"{"stopreason":2,"reason":"当前还在推进，先继续执行","has_evidence":0,"evidence":"","issue_cause":"","excluded_factors":"","diagnostic_order":"先看入口，再看链路，再看验证","done_steps":"已完成现有排查","next_step":"继续完成剩余验证并补最后一轮证据","next_suggested_path":"按当前链路继续","needs_user_input":false,"learned":"把真实结论写进 stop schema"}"#;
    StoplessSchemaGuidance {
        schema_overview: "stop schema 是模型在准备结束或暂停时返回的结构化 JSON 收尾报告。它不是普通文本总结，而是一份固定字段的结果，用来告诉系统这轮是已完成、被阻塞，还是还要继续执行。".to_string(),
        schema_purpose: "它的作用是把结束原因、证据、排查顺序、下一步动作固定成可机器判断的结构，并把每个字段的含义说清楚，避免模型只写泛泛的总结或漏字段。".to_string(),
        required_fields: vec![
            "stopreason".to_string(),
            "reason".to_string(),
            "has_evidence".to_string(),
            "evidence".to_string(),
            "issue_cause".to_string(),
            "excluded_factors".to_string(),
            "diagnostic_order".to_string(),
            "done_steps".to_string(),
            "next_step".to_string(),
            "next_suggested_path".to_string(),
            "needs_user_input".to_string(),
            "learned".to_string(),
        ],
        field_descriptions: vec![
            StoplessSchemaFieldDescription {
                field: "stopreason".to_string(),
                meaning: "0=真的做完了，1=卡住了，2=还要继续推进".to_string(),
            },
            StoplessSchemaFieldDescription {
                field: "reason".to_string(),
                meaning: "用一句话说明现在为什么停、为什么继续或为什么阻塞".to_string(),
            },
            StoplessSchemaFieldDescription {
                field: "has_evidence".to_string(),
                meaning: "0/1，表示这次结论是不是有文件、日志、命令或测试证据".to_string(),
            },
            StoplessSchemaFieldDescription {
                field: "evidence".to_string(),
                meaning: "把真正用来支撑结论的证据写出来".to_string(),
            },
            StoplessSchemaFieldDescription {
                field: "issue_cause".to_string(),
                meaning: "如果没完成，说明根因或卡点是什么".to_string(),
            },
            StoplessSchemaFieldDescription {
                field: "excluded_factors".to_string(),
                meaning: "说明已经排除掉哪些错误方向".to_string(),
            },
            StoplessSchemaFieldDescription {
                field: "diagnostic_order".to_string(),
                meaning: "写明你是按什么顺序排查到这里的".to_string(),
            },
            StoplessSchemaFieldDescription {
                field: "done_steps".to_string(),
                meaning: "列出已经实际完成的步骤".to_string(),
            },
            StoplessSchemaFieldDescription {
                field: "next_step".to_string(),
                meaning: "如果还没结束，写下一步要执行的具体动作".to_string(),
            },
            StoplessSchemaFieldDescription {
                field: "next_suggested_path".to_string(),
                meaning: "给出下一轮最合适的继续路径".to_string(),
            },
            StoplessSchemaFieldDescription {
                field: "needs_user_input".to_string(),
                meaning: "是否已经需要用户确认一个关键信息".to_string(),
            },
            StoplessSchemaFieldDescription {
                field: "learned".to_string(),
                meaning: "这轮收尾里真正学到的可复用结论".to_string(),
            },
        ],
        stopreason_values: StopreasonValues {
            finished: 0,
            blocked: 1,
            continue_needed: 2,
        },
        trigger_hint: stopless_trigger_hint(trigger).to_string(),
        decision_rules: vec![
            "Only use stopreason=0 when the task is actually finished and there is no remaining next_step to execute.".to_string(),
            "If there is still a concrete next_step, unfinished gate, pending verification, or more implementation work, use stopreason=2 instead of 0.".to_string(),
            "Use stopreason=1 only when progress is blocked by a real blocker that cannot be resolved in the current turn.".to_string(),
            "reason must describe the real current state, and next_step must match that state instead of contradicting stopreason.".to_string(),
        ],
        invalid_examples: vec![
            "Invalid: stopreason=0 with next_step saying continue writing remaining gates/manifests/package wiring.".to_string(),
            "Invalid: stopreason=0 when issue_cause still says there is unfinished work or missing verification.".to_string(),
            "Valid unfinished pattern: stopreason=2 plus a concrete next_step for the next action.".to_string(),
        ],
        sample: sample.to_string(),
    }
}

pub fn stopless_schema_guidance() -> StoplessSchemaGuidance {
    stopless_schema_guidance_with_trigger(StoplessContinuationTrigger::NoSchema, 0, 3)
}

fn stopless_trigger_hint(trigger: StoplessContinuationTrigger) -> &'static str {
    match trigger {
        StoplessContinuationTrigger::Stop | StoplessContinuationTrigger::NoSchema => "no_schema",
        StoplessContinuationTrigger::InvalidSchema => "invalid_schema",
        StoplessContinuationTrigger::NonTerminalSchema => "non_terminal_schema",
        StoplessContinuationTrigger::BudgetExhausted => "budget_exhausted",
        StoplessContinuationTrigger::SchemaPass => "schema_pass",
    }
}

pub fn normalize_stopless_trigger_hint_for_metadata(reason_code: Option<&str>) -> &'static str {
    let token = reason_code
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("no_schema");
    match token {
        "stop_schema_missing" => "no_schema",
        "stop_schema_reason_missing" => "invalid_schema",
        "stop_schema_terminal_missing_fields" => "invalid_schema",
        "stop_schema_stopreason_missing_or_non_numeric" => "invalid_schema",
        "stop_schema_needs_user_input_missing_next_step" => "invalid_schema",
        "stop_schema_next_step_missing" => "invalid_schema",
        "stop_schema_forcestop_reason_missing" => "invalid_schema",
        "stop_schema_continue_without_next_step" => "non_terminal_schema",
        "stop_schema_continue_next_step" => "non_terminal_schema",
        "stop_schema_budget_exhausted" => "budget_exhausted",
        "stop_schema_finished" => "schema_pass",
        "stop_schema_blocked" => "schema_pass",
        "stop_schema_needs_user_input" => "schema_pass",
        "stop_schema_forcestop" => "schema_pass",
        "invalid_schema" => "invalid_schema",
        "non_terminal_schema" => "non_terminal_schema",
        "budget_exhausted" => "budget_exhausted",
        "schema_pass" => "schema_pass",
        _ => "no_schema",
    }
}

fn read_stopless_trigger_hint(input: &Value) -> StoplessContinuationTrigger {
    let token = input
        .as_object()
        .and_then(|row| row.get("triggerHint").or_else(|| row.get("trigger_hint")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("no_schema");
    match token {
        "stop_schema_missing" => StoplessContinuationTrigger::NoSchema,
        "stop_schema_reason_missing" => StoplessContinuationTrigger::InvalidSchema,
        "stop_schema_terminal_missing_fields" => StoplessContinuationTrigger::InvalidSchema,
        "stop_schema_stopreason_missing_or_non_numeric" => {
            StoplessContinuationTrigger::InvalidSchema
        }
        "stop_schema_needs_user_input_missing_next_step" => {
            StoplessContinuationTrigger::InvalidSchema
        }
        "stop_schema_next_step_missing" => StoplessContinuationTrigger::InvalidSchema,
        "stop_schema_forcestop_reason_missing" => StoplessContinuationTrigger::InvalidSchema,
        "stop_schema_continue_without_next_step" => StoplessContinuationTrigger::NonTerminalSchema,
        "stop_schema_continue_next_step" => StoplessContinuationTrigger::NonTerminalSchema,
        "stop_schema_budget_exhausted" => StoplessContinuationTrigger::BudgetExhausted,
        "stop_schema_finished" => StoplessContinuationTrigger::SchemaPass,
        "stop_schema_blocked" => StoplessContinuationTrigger::SchemaPass,
        "stop_schema_needs_user_input" => StoplessContinuationTrigger::SchemaPass,
        "stop_schema_forcestop" => StoplessContinuationTrigger::SchemaPass,
        "invalid_schema" => StoplessContinuationTrigger::InvalidSchema,
        "non_terminal_schema" => StoplessContinuationTrigger::NonTerminalSchema,
        "budget_exhausted" => StoplessContinuationTrigger::BudgetExhausted,
        "schema_pass" => StoplessContinuationTrigger::SchemaPass,
        _ => StoplessContinuationTrigger::NoSchema,
    }
}

fn read_stopless_schema_feedback(input: &Value) -> Option<StoplessSchemaFeedback> {
    let feedback = input.as_object().and_then(|row| {
        row.get("schemaFeedback")
            .or_else(|| row.get("schema_feedback"))
    })?;
    let row = feedback.as_object()?;
    let reason_code = row
        .get("reasonCode")
        .or_else(|| row.get("reason_code"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let missing_fields = row
        .get("missingFields")
        .or_else(|| row.get("missing_fields"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(StoplessSchemaFeedback {
        reason_code,
        missing_fields,
    })
}

fn non_empty(raw: Option<&str>, field: &'static str) -> Result<String, ServertoolCliError> {
    let value = raw
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or(ServertoolCliError::MissingField(field))?;
    Ok(value.to_string())
}

fn read_non_empty_string(value: &Value, field: &'static str) -> Result<String, ServertoolCliError> {
    let Some(raw) = value.get(field).and_then(Value::as_str) else {
        return Err(ServertoolCliError::MissingField(field));
    };
    non_empty(Some(raw), field)
}

fn read_optional_non_empty_string(value: &Value, field: &'static str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn read_optional_trimmed(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn normalize_projection_payload(input: Option<Value>) -> Result<Value, ServertoolCliError> {
    match input {
        None | Some(Value::Null) => Ok(Value::Object(Map::new())),
        Some(Value::Object(map)) => Ok(Value::Object(map)),
        Some(_) => Err(ServertoolCliError::InvalidField("input")),
    }
}

fn read_u32(value: &Value, field: &'static str) -> Option<u32> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
}

fn is_safe_tool_name(tool_name: &str) -> bool {
    !tool_name.is_empty()
        && tool_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn is_safe_call_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn read_object_string<'a>(
    object: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a str, ServertoolCliError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(ServertoolCliError::MissingField(field))
}

fn validate_no_denied_cli_marker(raw: &str) -> Result<(), ServertoolCliError> {
    for marker in DENIED_CLI_MARKERS {
        if raw.contains(marker) {
            return Err(ServertoolCliError::DeniedMarker(marker));
        }
    }
    Ok(())
}

fn build_client_exec_cli_projection_output_with_identity(
    tool_name: &str,
    flow_id: &str,
    input: Value,
    repeat_count: u32,
    max_repeats: u32,
    session_id: Option<&str>,
    request_id: Option<&str>,
) -> Result<Value, ServertoolCliError> {
    validate_no_denied_cli_marker(tool_name)?;
    validate_no_denied_cli_marker(flow_id)?;
    if !is_safe_tool_name(tool_name) {
        return Err(ServertoolCliError::InvalidField("toolName"));
    }
    if is_denied_cli_projection(tool_name) {
        return Err(ServertoolCliError::DeniedTool(tool_name.to_string()));
    }
    if !input.is_object() {
        return Err(ServertoolCliError::InvalidField("input"));
    }
    validate_no_denied_cli_marker(
        &serde_json::to_string(&input).map_err(|_| ServertoolCliError::InvalidField("input"))?,
    )?;
    validate_no_internal_carrier(&input)?;
    if !is_client_exec_cli_projection(tool_name) {
        return Err(ServertoolCliError::UnsupportedTool(tool_name.to_string()));
    }
    if tool_name == "stop_message_auto" {
        if flow_id != "stop_message_flow" {
            return Err(ServertoolCliError::InvalidField("flowId"));
        }
        let trigger_hint = input
            .as_object()
            .and_then(|row| row.get("triggerHint").or_else(|| row.get("trigger_hint")))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let mut input_payload = Map::new();
        input_payload.insert("flowId".to_string(), Value::String(flow_id.to_string()));
        input_payload.insert(
            "repeatCount".to_string(),
            Value::Number(serde_json::Number::from(repeat_count)),
        );
        input_payload.insert(
            "maxRepeats".to_string(),
            Value::Number(serde_json::Number::from(max_repeats)),
        );
        if let Some(trigger_hint) = trigger_hint.as_deref() {
            input_payload.insert(
                "triggerHint".to_string(),
                Value::String(trigger_hint.to_string()),
            );
        }
        let input_json = serde_json::to_string(&Value::Object(input_payload))
            .map_err(|_| ServertoolCliError::InvalidField("json"))?;
        let cmd = build_client_exec_command(tool_name, &input_json, session_id, request_id);
        validate_no_denied_cli_marker(&cmd)?;
        let mut output = serde_json::json!({
            "toolName": tool_name,
            "flowId": flow_id,
            "repeatCount": repeat_count,
            "maxRepeats": max_repeats,
            "execCommand": cmd
        });
        if let Some(route_hint) = route_hint_for_client_exec_tool(tool_name) {
            output["routeHint"] = Value::String(route_hint.to_string());
        }
        if let Some(session_id) = session_id.and_then(read_optional_trimmed) {
            output["sessionId"] = Value::String(session_id);
        }
        if let Some(request_id) = request_id.and_then(read_optional_trimmed) {
            output["requestId"] = Value::String(request_id);
        }
        return Ok(output);
    }

    let input_json =
        serde_json::to_string(&input).map_err(|_| ServertoolCliError::InvalidField("json"))?;
    let cmd = build_client_exec_command(tool_name, &input_json, session_id, request_id);
    validate_no_denied_cli_marker(&cmd)?;
    let mut output = serde_json::json!({
        "toolName": tool_name,
        "flowId": flow_id,
        "repeatCount": repeat_count,
        "maxRepeats": max_repeats,
        "execCommand": cmd
    });
    if let Some(route_hint) = route_hint_for_client_exec_tool(tool_name) {
        output["routeHint"] = Value::String(route_hint.to_string());
    }
    if let Some(session_id) = session_id.and_then(read_optional_trimmed) {
        output["sessionId"] = Value::String(session_id);
    }
    if let Some(request_id) = request_id.and_then(read_optional_trimmed) {
        output["requestId"] = Value::String(request_id);
    }
    Ok(output)
}

fn build_client_exec_command(
    tool_name: &str,
    input_json: &str,
    session_id: Option<&str>,
    request_id: Option<&str>,
) -> String {
    let quoted_input = quote_posix_single_argument(&input_json);
    let mut cmd = format!(
        "routecodex hook run {} --input-json {}",
        public_cli_tool_name(tool_name),
        quoted_input
    );
    if let Some(session_id) = session_id.and_then(read_optional_trimmed) {
        cmd.push_str(" --session-id ");
        cmd.push_str(&quote_posix_single_argument(&session_id));
    }
    if let Some(request_id) = request_id.and_then(read_optional_trimmed) {
        cmd.push_str(" --request-id ");
        cmd.push_str(&quote_posix_single_argument(&request_id));
    }
    cmd
}

fn public_cli_tool_name(tool_name: &str) -> &str {
    if tool_name == STOP_MESSAGE_AUTO_TOOL_NAME {
        REASONING_STOP_PUBLIC_TOOL_NAME
    } else {
        tool_name
    }
}

pub fn build_client_exec_cli_projection_output(
    tool_name: &str,
    flow_id: &str,
    input: Value,
    repeat_count: u32,
    max_repeats: u32,
) -> Result<Value, ServertoolCliError> {
    build_client_exec_cli_projection_output_with_identity(
        tool_name,
        flow_id,
        input,
        repeat_count,
        max_repeats,
        None,
        None,
    )
}

/// feature_id: hub.servertool_cli_projection
pub fn plan_client_exec_cli_projection_output(
    input: ClientExecCliProjectionInput,
) -> Result<Value, ServertoolCliError> {
    let payload = normalize_projection_payload(input.input)?;
    let payload_object = payload
        .as_object()
        .ok_or(ServertoolCliError::InvalidField("input"))?;
    let explicit_tool_name = input.tool_name.as_deref().and_then(read_optional_trimmed);
    if let Some(tool_name) = explicit_tool_name.as_deref() {
        validate_no_denied_cli_marker(tool_name)?;
    }
    let flow_id = input
        .flow_id
        .as_deref()
        .and_then(read_optional_trimmed)
        .or_else(|| read_optional_non_empty_string(&payload, "flowId"))
        .or_else(|| {
            explicit_tool_name
                .as_ref()
                .map(|_| "servertool_cli_projection".to_string())
        })
        .ok_or(ServertoolCliError::MissingField("flowId"))?;
    validate_no_denied_cli_marker(&flow_id)?;
    let tool_name = if flow_id == "stop_message_flow" {
        if let Some(explicit) = explicit_tool_name.as_deref() {
            if explicit != "stop_message_auto" {
                return Err(ServertoolCliError::InvalidField("toolName"));
            }
        }
        "stop_message_auto".to_string()
    } else {
        explicit_tool_name.unwrap_or_else(|| flow_id.clone())
    };
    if tool_name == "stop_message_auto" && flow_id != "stop_message_flow" {
        return Err(ServertoolCliError::InvalidField("flowId"));
    }

    if tool_name == "stop_message_auto" {
        let repeat_count = input
            .repeat_count
            .or_else(|| read_u32(&payload, "repeatCount"))
            .ok_or(ServertoolCliError::MissingField("repeatCount"))?;
        let max_repeats = input
            .max_repeats
            .or_else(|| read_u32(&payload, "maxRepeats"))
            .ok_or(ServertoolCliError::MissingField("maxRepeats"))?;
        if max_repeats == 0 || repeat_count > max_repeats {
            return Err(ServertoolCliError::InvalidField("repeatCount/maxRepeats"));
        }
        let mut canonical = Map::new();
        canonical.insert("flowId".to_string(), Value::String(flow_id.clone()));
        canonical.insert(
            "repeatCount".to_string(),
            Value::Number(serde_json::Number::from(repeat_count)),
        );
        canonical.insert(
            "maxRepeats".to_string(),
            Value::Number(serde_json::Number::from(max_repeats)),
        );
        // Always carry triggerHint in projection output
        let trigger_hint = read_stopless_trigger_hint(&payload);
        canonical.insert(
            "triggerHint".to_string(),
            Value::String(stopless_trigger_hint(trigger_hint).to_string()),
        );
        if let Some(schema_feedback) = read_stopless_schema_feedback(&payload) {
            canonical.insert(
                "schemaFeedback".to_string(),
                serde_json::json!({
                    "reasonCode": schema_feedback.reason_code,
                    "missingFields": schema_feedback.missing_fields
                }),
            );
        }
        return build_client_exec_cli_projection_output_with_identity(
            &tool_name,
            &flow_id,
            Value::Object(canonical),
            repeat_count,
            max_repeats,
            input.session_id.as_deref(),
            input.request_id.as_deref(),
        );
    }

    let repeat_count = input
        .repeat_count
        .or_else(|| read_u32(&payload, "repeatCount"))
        .unwrap_or(0);
    let max_repeats = input
        .max_repeats
        .or_else(|| read_u32(&payload, "maxRepeats"))
        .unwrap_or(0);
    build_client_exec_cli_projection_output_with_identity(
        &tool_name,
        &flow_id,
        Value::Object(payload_object.clone()),
        repeat_count,
        max_repeats,
        input.session_id.as_deref(),
        input.request_id.as_deref(),
    )
}

pub fn build_client_visible_projection_shell(
    input: ServertoolClientVisibleProjectionShellInput,
) -> Result<Value, ServertoolCliError> {
    let request_id = input.request_id.trim();
    if request_id.is_empty() {
        return Err(ServertoolCliError::MissingField("requestId"));
    }
    let client_call_id = input.client_call_id.trim();
    if !is_safe_call_id(client_call_id) {
        return Err(ServertoolCliError::InvalidField("clientCallId"));
    }
    let reasoning_text = input.reasoning_text.trim();
    if reasoning_text.is_empty() {
        return Err(ServertoolCliError::MissingField("reasoningText"));
    }
    validate_no_denied_cli_marker(reasoning_text)?;

    let native_projection = input
        .native_projection
        .as_object()
        .ok_or(ServertoolCliError::InvalidField("nativeProjection"))?;
    let tool_name = read_object_string(native_projection, "toolName")?;
    if !is_safe_tool_name(tool_name) {
        return Err(ServertoolCliError::InvalidField("toolName"));
    }
    if is_denied_cli_projection(tool_name) {
        return Err(ServertoolCliError::DeniedTool(tool_name.to_string()));
    }
    if !is_client_exec_cli_projection(tool_name) {
        return Err(ServertoolCliError::UnsupportedTool(tool_name.to_string()));
    }
    let command = read_object_string(native_projection, "execCommand")?;
    validate_no_denied_cli_marker(command)?;
    let tool_arguments = serde_json::to_string(&serde_json::json!({ "cmd": command }))
        .map_err(|_| ServertoolCliError::InvalidField("toolCallArguments"))?;
    let mut tool_calls = vec![serde_json::json!({
        "id": client_call_id,
        "type": "function",
        "function": {
            "name": "exec_command",
            "arguments": tool_arguments
        }
    })];
    for tool_call in input.additional_tool_calls {
        let row = tool_call
            .as_object()
            .ok_or(ServertoolCliError::InvalidField("additionalToolCalls"))?;
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .ok_or(ServertoolCliError::InvalidField("additionalToolCalls.id"))?;
        if !is_safe_call_id(id) {
            return Err(ServertoolCliError::InvalidField("additionalToolCalls.id"));
        }
        let function = row.get("function").and_then(Value::as_object).ok_or(
            ServertoolCliError::InvalidField("additionalToolCalls.function"),
        )?;
        let function_name = function.get("name").and_then(Value::as_str).ok_or(
            ServertoolCliError::InvalidField("additionalToolCalls.function.name"),
        )?;
        if is_denied_cli_projection(function_name) {
            return Err(ServertoolCliError::DeniedTool(function_name.to_string()));
        }
        if classify_servertool_outcome(function_name).is_some() {
            return Err(ServertoolCliError::UnsupportedTool(
                function_name.to_string(),
            ));
        }
        validate_no_denied_cli_marker(
            &serde_json::to_string(&tool_call)
                .map_err(|_| ServertoolCliError::InvalidField("additionalToolCalls"))?,
        )?;
        validate_no_internal_carrier(&tool_call)?;
        tool_calls.push(Value::Object(row.clone()));
    }

    Ok(serde_json::json!({
        "id": format!("chatcmpl_{client_call_id}"),
        "object": "chat.completion",
        "created": 0,
        "model": "routecodex-servertool-cli",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_text": reasoning_text,
                    "reasoning_content": reasoning_text,
                    "reasoning": {
                        "summary": [{ "type": "summary_text", "text": reasoning_text }]
                    },
                    "tool_calls": tool_calls
                },
                "finish_reason": "tool_calls"
            }
        ]
    }))
}

pub fn build_servertool_cli_projection_execution_context(
    input: ServertoolCliProjectionExecutionContextInput,
) -> Result<Value, ServertoolCliError> {
    let request_id = input.request_id.trim();
    if request_id.is_empty() {
        return Err(ServertoolCliError::MissingField("requestId"));
    }
    let client_call_id = input.client_call_id.trim();
    if !is_safe_call_id(client_call_id) {
        return Err(ServertoolCliError::InvalidField("clientCallId"));
    }
    let tool_name = input.tool_name.trim();
    if !is_safe_tool_name(tool_name) {
        return Err(ServertoolCliError::InvalidField("toolName"));
    }
    if is_denied_cli_projection(tool_name) {
        return Err(ServertoolCliError::DeniedTool(tool_name.to_string()));
    }
    if !is_client_exec_cli_projection(tool_name) {
        return Err(ServertoolCliError::UnsupportedTool(tool_name.to_string()));
    }

    Ok(serde_json::json!({
        "flowId": "servertool_cli_projection",
        "context": {
            "servertoolCliProjection": {
                "clientCallId": client_call_id,
                "toolName": tool_name,
                "requestId": request_id
            }
        }
    }))
}

pub fn validate_client_exec_command_result(raw_output: &str) -> Result<Value, ServertoolCliError> {
    validate_no_denied_cli_marker(raw_output)?;
    let value: Value = serde_json::from_str(raw_output)
        .map_err(|_| ServertoolCliError::InvalidField("exec_command_output"))?;
    if !value.is_object() {
        return Err(ServertoolCliError::InvalidField("exec_command_output"));
    }
    validate_no_internal_carrier(&value)?;
    let tool_name = value
        .get("toolName")
        .and_then(|v| v.as_str())
        .ok_or(ServertoolCliError::MissingField("toolName"))?;
    let flow_id = value
        .get("flowId")
        .and_then(|v| v.as_str())
        .ok_or(ServertoolCliError::MissingField("flowId"))?;
    validate_no_denied_cli_marker(tool_name)?;
    validate_no_denied_cli_marker(flow_id)?;
    if is_denied_cli_projection(tool_name) {
        return Err(ServertoolCliError::DeniedTool(tool_name.to_string()));
    }
    if !is_client_exec_cli_projection(tool_name) {
        return Err(ServertoolCliError::UnsupportedTool(tool_name.to_string()));
    }
    if tool_name == "stop_message_auto" && flow_id != "stop_message_flow" {
        return Err(ServertoolCliError::InvalidField("flowId"));
    }
    Ok(value)
}

const DENIED_INTERNAL_CARRIER_KEYS: &[&str] = &[
    "__rt",
    "__raw_request_body",
    "__servertool_cli_projection",
    "metadata",
    "metaCarrier",
    "snapshot",
    "debug",
    "debugCarrier",
    "ticket",
    "restorationHandle",
    "restorationStore",
    "reenterPipeline",
    "providerInvoker",
    "serverToolFollowup",
    "serverToolFollowupSource",
];

const DENIED_INTERNAL_CARRIER_TEXT: &[&str] = &[
    "__rt",
    "__raw_request_body",
    "__servertool_cli_projection",
    "metadata",
    "metaCarrier",
    "snapshot",
    "debugCarrier",
    "restoration handle",
    "restoration store",
    "reenterPipeline",
    "providerInvoker",
    "serverToolFollowup",
    "serverToolFollowupSource",
];

fn validate_no_internal_carrier(value: &Value) -> Result<(), ServertoolCliError> {
    match value {
        Value::Object(record) => {
            for (key, item) in record {
                let normalized_key = key.trim();
                for denied in DENIED_INTERNAL_CARRIER_KEYS {
                    if normalized_key == *denied {
                        return Err(ServertoolCliError::DeniedInternalCarrier(denied));
                    }
                }
                validate_no_internal_carrier(item)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                validate_no_internal_carrier(item)?;
            }
            Ok(())
        }
        Value::String(raw) => {
            for denied in DENIED_INTERNAL_CARRIER_TEXT {
                if raw.contains(denied) {
                    return Err(ServertoolCliError::DeniedInternalCarrier(denied));
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_stop_message_auto_cli_output() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "continuationPrompt": "continue with full schema",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("stopmessage-cli-output-spec-session".to_string()),
                request_id: Some("stopmessage-cli-output-spec-request".to_string()),
            },
        )
        .expect("stop_message_auto output");
        assert_eq!(output.tool_name, "stop_message_auto");
        assert_eq!(output.flow_id, "stop_message_flow");
        assert_eq!(output.repeat_count, 1);
        assert!(!output.continuation_prompt.is_empty());
        for forbidden in [
            "schema",
            "hook",
            "stopless",
            "servertool",
            "第一轮",
            "第二轮",
            "第三轮",
            "必须调用",
            "证据不足",
            "用户目标",
            "已排除因素",
            "排查顺序",
        ] {
            assert!(
                !output.continuation_prompt.contains(forbidden),
                "stopless prompt leaks forbidden token {forbidden}: {}",
                output.continuation_prompt
            );
        }
        assert!(output.schema_guidance.is_none());
        assert!(output.model_guidance.is_empty());
        assert!(output.injected_prompt_preview.is_none());
        assert_eq!(
            output.input,
            json!({
                "flowId": "stop_message_flow",
                "repeatCount": 1,
                "maxRepeats": 3,
                "triggerHint": "no_schema"
            })
        );
        assert_eq!(output.ok, true);
        assert_eq!(output.kind, "stop_message_auto");
    }

    #[test]
    fn status_only_stopless_cli_output_does_not_require_prompt() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({ "repeatCount": 1, "maxRepeats": 3 }),
                flow_id: Some("stop_message_flow".to_string()),
                repeat_count: None,
                max_repeats: None,
                session_id: Some(format!(
                    "session-status-only-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_nanos() as u64)
                        .unwrap_or(0)
                )),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect("status-only stopless CLI must not require prompt");
        assert_eq!(output.tool_name, "stop_message_auto");
        assert_eq!(output.flow_id, "stop_message_flow");
        assert_eq!(output.repeat_count, 1);
        assert_eq!(output.max_repeats, 3);
        assert!(!output.continuation_prompt.is_empty());
        for forbidden in [
            "schema",
            "hook",
            "stopless",
            "servertool",
            "第一轮",
            "第二轮",
            "第三轮",
            "必须调用",
            "证据不足",
            "用户目标",
            "已排除因素",
            "排查顺序",
        ] {
            assert!(
                !output.continuation_prompt.contains(forbidden),
                "status-only stopless prompt leaks forbidden token {forbidden}: {}",
                output.continuation_prompt
            );
        }
        assert!(output.schema_guidance.is_none());
        assert!(output.model_guidance.is_empty());
        assert!(output.injected_prompt_preview.is_none());
        assert_eq!(
            output.input,
            json!({
                "flowId": "stop_message_flow",
                "repeatCount": 1,
                "maxRepeats": 3,
                "triggerHint": "no_schema"
            })
        );
    }

    #[test]
    fn web_search_cli_projection_output_is_executable() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "web_search".to_string(),
                input: json!({"query":"rust hooks"}),
                flow_id: Some("web_search_flow".to_string()),
                repeat_count: Some(1),
                max_repeats: Some(3),
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect("web_search must be CLI projection");
        assert_eq!(output.tool_name, "web_search");
        assert_eq!(output.flow_id, "web_search_flow");
        assert_eq!(output.route_hint.as_deref(), Some("web_search"));
        assert_eq!(output.input["query"], "rust hooks");
        assert_eq!(output.session_id.as_deref(), Some("session-test"));
        assert_eq!(output.request_id.as_deref(), Some("req-test"));
    }

    #[test]
    fn vision_auto_cli_projection_output_is_executable() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "vision_auto".to_string(),
                input: json!({"image":"img_1"}),
                flow_id: Some("vision_flow".to_string()),
                repeat_count: None,
                max_repeats: None,
                session_id: None,
                request_id: None,
            },
        )
        .expect("vision_auto must be CLI projection");
        assert_eq!(output.tool_name, "vision_auto");
        assert_eq!(output.flow_id, "vision_flow");
        assert_eq!(output.route_hint.as_deref(), Some("multimodal"));
        assert_eq!(output.input["image"], "img_1");
    }

    #[test]
    fn servertool_fixture_cli_output_is_executable() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "servertool_fixture".to_string(),
                input: json!({"value":1}),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect("fixture output");
        assert_eq!(output.ok, true);
        assert_eq!(output.kind, "servertool_fixture");
        assert_eq!(output.tool_name, "servertool_fixture");
        assert_eq!(output.flow_id, "servertool_cli_projection");
        assert!(output.schema_guidance.is_none());
        assert_eq!(output.input, json!({"value":1}));
    }

    #[test]
    fn client_exec_projection_command_carries_identity_flags() {
        let output = plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
            tool_name: Some("servertool_fixture".to_string()),
            flow_id: Some("servertool_cli_projection".to_string()),
            input: Some(json!({"value": 1})),
            repeat_count: None,
            max_repeats: None,
            stdout_preview: None,
            session_id: Some("sess-cli-proj".to_string()),
            request_id: Some("req-cli-proj".to_string()),
        })
        .expect("projection output");

        let command = output
            .get("execCommand")
            .and_then(Value::as_str)
            .expect("execCommand");
        assert!(command.contains("--session-id 'sess-cli-proj'"));
        assert!(command.contains("--request-id 'req-cli-proj'"));
    }

    #[test]
    fn stop_message_projection_command_carries_identity_flags() {
        std::env::set_var("ROUTECODEX_SESSION_DIR", "/tmp/should-not-leak-stopless");
        let output = plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
            tool_name: Some("stop_message_auto".to_string()),
            flow_id: Some("stop_message_flow".to_string()),
            input: Some(json!({
                "flowId": "stop_message_flow",
                "repeatCount": 1,
                "maxRepeats": 3
            })),
            repeat_count: Some(1),
            max_repeats: Some(3),
            stdout_preview: None,
            session_id: Some("sess-stop-proj".to_string()),
            request_id: Some("req-stop-proj".to_string()),
        })
        .expect("stop projection output");

        let command = output
            .get("execCommand")
            .and_then(Value::as_str)
            .expect("execCommand");
        assert!(command.contains("--session-id 'sess-stop-proj'"));
        assert!(command.contains("--request-id 'req-stop-proj'"));
        assert!(!command.contains("ROUTECODEX_SESSION_DIR="));
        std::env::remove_var("ROUTECODEX_SESSION_DIR");
    }

    #[test]
    fn cli_rejects_non_object_input_json() {
        let err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!(["not", "object"]),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect_err("non-object input must fail");
        assert_eq!(err, ServertoolCliError::InvalidField("inputJson"));
    }

    #[test]
    fn cli_rejects_old_restoration_markers_in_input() {
        let err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "servertool_fixture".to_string(),
                input: json!({"value":"old_cli_result_123"}),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect_err("old marker must fail");
        assert_eq!(err, ServertoolCliError::DeniedMarker("old_cli_"));
    }

    #[test]
    fn cli_rejects_old_markers_in_tool_name_and_explicit_flow() {
        let err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "old_cli_123".to_string(),
                input: json!({"value":1}),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect_err("old marker in tool name must fail");
        assert_eq!(err, ServertoolCliError::DeniedMarker("old_cli_"));

        let err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "servertool_fixture".to_string(),
                input: json!({"value":1}),
                flow_id: Some("stcli_123".to_string()),
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect_err("old marker in flow id must fail");
        assert_eq!(err, ServertoolCliError::DeniedMarker("stcli_"));
    }

    #[test]
    fn cli_rejects_internal_carrier_in_input_json() {
        let err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "servertool_fixture".to_string(),
                input: json!({"__rt":{"requestId":"req_internal"}}),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect_err("internal carrier must fail");
        assert_eq!(err, ServertoolCliError::DeniedInternalCarrier("__rt"));
    }

    #[test]
    fn projection_output_is_rust_owned_schema() {
        let out = plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
            tool_name: None,
            flow_id: Some("stop_message_flow".to_string()),
            input: Some(json!({
                "continuationPrompt": "第一轮核对：补齐 stop schema",
                "repeatCount": 2,
                "maxRepeats": 5
            })),
            repeat_count: None,
            max_repeats: None,
            stdout_preview: Some("preview".to_string()),
            session_id: None,
            request_id: None,
        })
        .expect("projection output");
        assert_eq!(out["toolName"], "stop_message_auto");
        assert_eq!(out["flowId"], "stop_message_flow");
        assert_eq!(out["repeatCount"], 2);
        assert_eq!(out["maxRepeats"], 5);
        assert!(out.get("continuationPrompt").is_none());
        assert!(out.get("schemaGuidance").is_none());
        let cmd = out["execCommand"].as_str().unwrap();
        assert!(cmd.contains("routecodex hook run"));
        assert!(!cmd.contains("continuationPrompt"));
        assert!(!cmd.contains("第一轮核对"));
        assert!(!cmd.contains("stdoutPreview"));
        assert!(!cmd.contains("schemaGuidance"));
        assert!(!cmd.contains("stcli_"), "no old stcli_ marker");
        assert!(!cmd.contains("rcc_cli_"), "no old rcc_cli_ marker");
        assert!(!cmd.contains("--ticket"), "no --ticket marker");
    }

    #[test]
    fn projection_plan_rejects_wrong_explicit_stopless_tool_name() {
        assert_eq!(
            plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
                tool_name: Some("servertool_fixture".to_string()),
                flow_id: Some("stop_message_flow".to_string()),
                input: Some(json!({
                    "repeatCount": 1,
                    "maxRepeats": 3
                })),
                repeat_count: None,
                max_repeats: None,
                stdout_preview: None,
                session_id: None,
                request_id: None,
            }),
            Err(ServertoolCliError::InvalidField("toolName"))
        );
    }

    #[test]
    fn projection_plan_rejects_invalid_stopless_repeat_window() {
        assert_eq!(
            plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
                tool_name: None,
                flow_id: Some("stop_message_flow".to_string()),
                input: Some(json!({
                    "continuationPrompt": "continue with full schema",
                    "repeatCount": 4,
                    "maxRepeats": 3
                })),
                repeat_count: None,
                max_repeats: None,
                stdout_preview: None,
                session_id: None,
                request_id: None,
            }),
            Err(ServertoolCliError::InvalidField("repeatCount/maxRepeats"))
        );
    }

    #[test]
    fn projection_plan_rejects_old_markers_in_explicit_tool_and_flow() {
        assert_eq!(
            plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
                tool_name: Some("old_cli_123".to_string()),
                flow_id: Some("servertool_cli_projection".to_string()),
                input: Some(json!({"value": 1})),
                repeat_count: None,
                max_repeats: None,
                stdout_preview: None,
                session_id: None,
                request_id: None,
            }),
            Err(ServertoolCliError::DeniedMarker("old_cli_"))
        );
        assert_eq!(
            plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
                tool_name: Some("servertool_fixture".to_string()),
                flow_id: Some("rcc_cli_123".to_string()),
                input: Some(json!({"value": 1})),
                repeat_count: None,
                max_repeats: None,
                stdout_preview: None,
                session_id: None,
                request_id: None,
            }),
            Err(ServertoolCliError::DeniedMarker("rcc_cli_"))
        );
    }

    #[test]
    fn projection_plan_defaults_non_stopless_tool_name_to_flow_id() {
        let out = plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
            tool_name: None,
            flow_id: Some("servertool_fixture".to_string()),
            input: Some(json!({"value": 1})),
            repeat_count: None,
            max_repeats: None,
            stdout_preview: None,
            session_id: None,
            request_id: None,
        })
        .expect("fixture projection");
        assert_eq!(out["toolName"], "servertool_fixture");
        assert_eq!(out["flowId"], "servertool_fixture");
        assert_eq!(
            out["execCommand"],
            "routecodex hook run servertool_fixture --input-json '{\"value\":1}'"
        );
    }

    #[test]
    fn projection_output_quotes_json_apostrophes() {
        let out = plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
            tool_name: None,
            flow_id: Some("stop_message_flow".to_string()),
            input: Some(json!({
                "continuationPrompt": "can't stop",
                "repeatCount": 2,
                "maxRepeats": 5
            })),
            repeat_count: None,
            max_repeats: None,
            stdout_preview: None,
            session_id: None,
            request_id: None,
        })
        .expect("projection output");
        let command = out["execCommand"].as_str().expect("exec command");
        let prefix = "routecodex hook run reasoningStop --input-json '";
        assert!(command.starts_with(prefix));
        let input_start = prefix.len();
        let input_json = if let Some(input_end) = command[input_start..]
            .find("' --session-id")
            .or_else(|| command[input_start..].find("' --request-id"))
        {
            &command[input_start..input_start + input_end]
        } else {
            command[input_start..]
                .strip_suffix('\'')
                .expect("input json quoted block present")
        };
        let decoded = input_json.replace("'\\''", "'");
        let parsed: Value = serde_json::from_str(&decoded).expect("quoted json");
        assert_eq!(
            parsed,
            json!({
                "flowId": "stop_message_flow",
                "repeatCount": 2,
                "maxRepeats": 5,
                "triggerHint": "no_schema"
            })
        );
        assert!(!command.contains("continuationPrompt"));
        assert!(!command.contains("can't stop"));
    }

    #[test]
    fn client_visible_projection_shell_omits_responses_reasoning_content_array() {
        let native_projection = build_client_exec_cli_projection_output(
            "stop_message_auto",
            "stop_message_flow",
            json!({"repeatCount":2,"maxRepeats":5}),
            2,
            5,
        )
        .expect("projection output");
        let shell =
            build_client_visible_projection_shell(ServertoolClientVisibleProjectionShellInput {
                request_id: "req_stop_projection".to_string(),
                client_call_id: "call_servertool_cli_stop_1".to_string(),
                native_projection,
                reasoning_text: "intercepted stop text".to_string(),
                additional_tool_calls: vec![],
            })
            .expect("client visible shell");

        let message = &shell["choices"][0]["message"];
        assert_eq!(message["reasoning_content"], "intercepted stop text");
        assert_eq!(message["reasoning"]["summary"][0]["type"], "summary_text");
        assert!(message["reasoning"].get("content").is_none());
        assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
        assert!(shell.get("__servertool_cli_projection").is_none());
        let serialized = serde_json::to_string(&shell).expect("serialize shell");
        for denied in [
            "reenterPipeline",
            "providerInvoker",
            "serverToolFollowup",
            "serverToolFollowupSource",
            "restorationHandle",
            "restorationStore",
            "ticket",
            "__rt",
            "metadata",
        ] {
            assert!(
                !serialized.contains(denied),
                "client-visible stopless CLI shell leaked private carrier {denied}"
            );
        }
    }

    #[test]
    fn client_visible_projection_shell_preserves_additional_client_tool_calls() {
        let native_projection = build_client_exec_cli_projection_output(
            "servertool_fixture",
            "servertool_cli_projection",
            json!({"value":1}),
            0,
            0,
        )
        .expect("projection output");
        let shell =
            build_client_visible_projection_shell(ServertoolClientVisibleProjectionShellInput {
                request_id: "req_mixed_projection".to_string(),
                client_call_id: "call_servertool_cli_fixture_1".to_string(),
                native_projection,
                reasoning_text: "servertool fixture projection".to_string(),
                additional_tool_calls: vec![json!({
                    "id": "call_exec_command_1",
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"echo hi\"}"
                    }
                })],
            })
            .expect("client visible shell");

        let calls = shell["choices"][0]["message"]["tool_calls"]
            .as_array()
            .unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["function"]["name"], "exec_command");
        assert_eq!(calls[1]["id"], "call_exec_command_1");
        assert_eq!(calls[1]["function"]["name"], "exec_command");
    }

    #[test]
    fn client_visible_projection_shell_rejects_additional_servertool_calls() {
        let native_projection = build_client_exec_cli_projection_output(
            "servertool_fixture",
            "servertool_cli_projection",
            json!({"value":1}),
            0,
            0,
        )
        .expect("fixture projection output");
        let err =
            build_client_visible_projection_shell(ServertoolClientVisibleProjectionShellInput {
                request_id: "req_mixed_projection".to_string(),
                client_call_id: "call_servertool_cli_fixture_1".to_string(),
                native_projection,
                reasoning_text: "servertool fixture projection".to_string(),
                additional_tool_calls: vec![json!({
                    "id": "call_web_search_1",
                    "type": "function",
                    "function": {
                        "name": "web_search",
                        "arguments": "{}"
                    }
                })],
            })
            .expect_err("additional registered servertool must not be client-visible");
        assert_eq!(
            err,
            ServertoolCliError::UnsupportedTool("web_search".to_string())
        );
    }

    #[test]
    fn client_visible_projection_shell_rejects_additional_internal_carrier() {
        let native_projection = build_client_exec_cli_projection_output(
            "servertool_fixture",
            "servertool_cli_projection",
            json!({"value":1}),
            0,
            0,
        )
        .expect("fixture projection output");
        let err =
            build_client_visible_projection_shell(ServertoolClientVisibleProjectionShellInput {
                request_id: "req_mixed_projection".to_string(),
                client_call_id: "call_servertool_cli_fixture_1".to_string(),
                native_projection,
                reasoning_text: "servertool fixture projection".to_string(),
                additional_tool_calls: vec![json!({
                    "id": "call_exec_command_1",
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"echo hi\"}"
                    },
                    "metadata": {"requestId": "req_internal"}
                })],
            })
            .expect_err("additional internal carrier must not be client-visible");
        assert_eq!(err, ServertoolCliError::DeniedInternalCarrier("metadata"));
    }

    #[test]
    fn projection_builds_web_search_and_rejects_fake_exec() {
        assert_eq!(
            build_client_exec_cli_projection_output(
                "web_search",
                "web_search_flow",
                json!({"query":"x"}),
                1,
                3
            )
            .expect("web_search projection")["toolName"],
            json!("web_search")
        );
        assert_eq!(
            build_client_exec_cli_projection_output(
                "vision_auto",
                "vision_flow",
                json!({"image":"img_1"}),
                0,
                0
            )
            .expect("vision projection")["routeHint"],
            json!("multimodal")
        );
        assert_eq!(
            build_client_exec_cli_projection_output(
                "fake_exec",
                "stop_message_flow",
                json!({}),
                1,
                3
            ),
            Err(ServertoolCliError::DeniedTool("fake_exec".to_string()))
        );
    }

    #[test]
    fn projection_rejects_old_restoration_marker_input() {
        assert_eq!(
            build_client_exec_cli_projection_output(
                "servertool_fixture",
                "servertool_cli_projection",
                json!({"value":"old_cli_result_123"}),
                0,
                0,
            ),
            Err(ServertoolCliError::DeniedMarker("old_cli_"))
        );
    }

    #[test]
    fn projection_output_rejects_old_markers_in_tool_and_flow() {
        assert_eq!(
            build_client_exec_cli_projection_output(
                "old_cli_123",
                "servertool_cli_projection",
                json!({"value":1}),
                0,
                0,
            ),
            Err(ServertoolCliError::DeniedMarker("old_cli_"))
        );
        assert_eq!(
            build_client_exec_cli_projection_output(
                "servertool_fixture",
                "stcli_123",
                json!({"value":1}),
                0,
                0,
            ),
            Err(ServertoolCliError::DeniedMarker("stcli_"))
        );
    }

    #[test]
    fn projection_rejects_internal_metadata_input() {
        assert_eq!(
            build_client_exec_cli_projection_output(
                "servertool_fixture",
                "servertool_cli_projection",
                json!({"metadata":{"debug":true}}),
                0,
                0,
            ),
            Err(ServertoolCliError::DeniedInternalCarrier("metadata"))
        );
    }

    #[test]
    fn projection_rejects_private_carrier_text_input() {
        assert_eq!(
            build_client_exec_cli_projection_output(
                "servertool_fixture",
                "servertool_cli_projection",
                json!({"value":"serverToolFollowup should never be client-visible"}),
                0,
                0,
            ),
            Err(ServertoolCliError::DeniedInternalCarrier(
                "serverToolFollowup"
            ))
        );
        assert_eq!(
            build_client_exec_cli_projection_output(
                "servertool_fixture",
                "servertool_cli_projection",
                json!({"value":"providerInvoker carrier leaked"}),
                0,
                0,
            ),
            Err(ServertoolCliError::DeniedInternalCarrier("providerInvoker"))
        );
    }

    #[test]
    fn projection_output_supports_servertool_fixture_without_stopless_schema() {
        let out = build_client_exec_cli_projection_output(
            "servertool_fixture",
            "servertool_cli_projection",
            json!({"value":1}),
            0,
            0,
        )
        .expect("fixture projection output");
        assert_eq!(out["toolName"], "servertool_fixture");
        assert_eq!(out["flowId"], "servertool_cli_projection");
        assert_eq!(
            out["execCommand"].as_str(),
            Some("routecodex hook run servertool_fixture --input-json '{\"value\":1}'")
        );
        assert!(out.get("schemaGuidance").is_none());
    }

    #[test]
    fn cli_projection_execution_context_is_rust_owned() {
        let out = build_servertool_cli_projection_execution_context(
            ServertoolCliProjectionExecutionContextInput {
                request_id: "req_cli_projection".to_string(),
                client_call_id: "call_cli_projection_1".to_string(),
                tool_name: "servertool_fixture".to_string(),
            },
        )
        .expect("cli projection execution context");
        assert_eq!(out["flowId"], "servertool_cli_projection");
        assert_eq!(
            out["context"]["servertoolCliProjection"]["clientCallId"],
            "call_cli_projection_1"
        );
        assert_eq!(
            out["context"]["servertoolCliProjection"]["toolName"],
            "servertool_fixture"
        );
        assert_eq!(
            out["context"]["servertoolCliProjection"]["requestId"],
            "req_cli_projection"
        );
    }

    #[test]
    fn cli_projection_execution_context_rejects_non_cli_tool() {
        assert_eq!(
            build_servertool_cli_projection_execution_context(
                ServertoolCliProjectionExecutionContextInput {
                    request_id: "req_bad_cli_projection".to_string(),
                    client_call_id: "call_bad_cli_projection_1".to_string(),
                    tool_name: "fake_exec".to_string(),
                },
            ),
            Err(ServertoolCliError::DeniedTool("fake_exec".to_string()))
        );
    }

    #[test]
    fn projection_plan_error_codes_are_documented_in_tests() {
        let repeat_over_budget = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "continuationPrompt": "continue",
                    "repeatCount": 4,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some(format!(
                    "session-over-budget-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_nanos() as u64)
                        .unwrap_or(0)
                )),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect("over budget must return terminal output, not error");
        assert_eq!(repeat_over_budget.ok, true);
        assert_eq!(repeat_over_budget.summary, "stopless budget exhausted");
        assert_eq!(repeat_over_budget.repeat_count, 3);
        assert_eq!(repeat_over_budget.max_repeats, 3);
        assert!(!repeat_over_budget.continuation_prompt.is_empty());

        let flow_err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "continuationPrompt": "continue",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some(format!(
                    "session-missing-flow-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_nanos() as u64)
                        .unwrap_or(0)
                )),
                request_id: Some("req-missing-flow".to_string()),
            },
        )
        .expect_err("missing flow id must fail fast");
        assert_eq!(flow_err.to_string(), "SERVERTOOL_CLI_MISSING_FIELD: flowId");

        let denied_err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "fake_exec".to_string(),
                input: json!({"value": 1}),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-denied-tool".to_string()),
                request_id: Some("req-denied-tool".to_string()),
            },
        )
        .expect_err("fake_exec must be denied");
        assert_eq!(denied_err.to_string(), "SERVERTOOL_DENIED_TOOL: fake_exec");
    }

    #[test]
    fn exec_result_validation_accepts_valid_stop_message_auto() {
        let raw = json!({
            "toolName": "stop_message_auto",
            "flowId": "stop_message_flow",
            "continuationPrompt": "continue",
            "repeatCount": 1,
            "maxRepeats": 3
        });
        let parsed = validate_client_exec_command_result(&raw.to_string()).expect("valid result");
        assert_eq!(parsed["toolName"], "stop_message_auto");
    }

    #[test]
    fn exec_result_validation_rejects_wrong_tool_name() {
        let raw = json!({"toolName": "fake_exec", "flowId": "stop_message_flow"});
        assert_eq!(
            validate_client_exec_command_result(&raw.to_string()),
            Err(ServertoolCliError::DeniedTool("fake_exec".to_string()))
        );
    }

    #[test]
    fn exec_result_validation_rejects_denied_markers() {
        let raw = json!({
            "toolName": "stop_message_auto",
            "flowId": "stop_message_flow",
            "extra": "old_cli_result_123"
        });
        assert_eq!(
            validate_client_exec_command_result(&raw.to_string()),
            Err(ServertoolCliError::DeniedMarker("old_cli_"))
        );
    }

    #[test]
    fn exec_result_validation_rejects_old_markers_in_tool_and_flow() {
        let raw = json!({"toolName": "old_cli_123", "flowId": "servertool_cli_projection"});
        assert_eq!(
            validate_client_exec_command_result(&raw.to_string()),
            Err(ServertoolCliError::DeniedMarker("old_cli_"))
        );
        let raw = json!({"toolName": "servertool_fixture", "flowId": "rcc_cli_123"});
        assert_eq!(
            validate_client_exec_command_result(&raw.to_string()),
            Err(ServertoolCliError::DeniedMarker("rcc_cli_"))
        );
    }

    #[test]
    fn exec_result_validation_rejects_wrong_flow_id() {
        let raw = json!({"toolName": "stop_message_auto", "flowId": "wrong_flow"});
        assert_eq!(
            validate_client_exec_command_result(&raw.to_string()),
            Err(ServertoolCliError::InvalidField("flowId"))
        );
    }

    #[test]
    fn exec_result_validation_rejects_internal_snapshot_carrier() {
        let raw = json!({
            "toolName": "servertool_fixture",
            "flowId": "servertool_cli_projection",
            "snapshot": {"requestId": "req_internal"}
        });
        assert_eq!(
            validate_client_exec_command_result(&raw.to_string()),
            Err(ServertoolCliError::DeniedInternalCarrier("snapshot"))
        );
    }

    #[test]
    fn exec_result_validation_accepts_servertool_fixture() {
        let raw = json!({"toolName": "servertool_fixture", "flowId": "servertool_cli_projection"});
        let parsed = validate_client_exec_command_result(&raw.to_string()).expect("valid result");
        assert_eq!(parsed["toolName"], "servertool_fixture");
    }

    #[test]
    fn exec_result_validation_accepts_web_search_route_hint() {
        let raw = json!({
            "toolName": "web_search",
            "flowId": "web_search_flow",
            "routeHint": "web_search"
        });
        let parsed = validate_client_exec_command_result(&raw.to_string()).expect("valid result");
        assert_eq!(parsed["routeHint"], "web_search");
    }

    #[test]
    fn normalize_stopless_trigger_hint_for_metadata_maps_reason_codes() {
        assert_eq!(
            normalize_stopless_trigger_hint_for_metadata(Some("stop_schema_missing")),
            "no_schema"
        );
        assert_eq!(
            normalize_stopless_trigger_hint_for_metadata(Some(
                "stop_schema_terminal_missing_fields"
            )),
            "invalid_schema"
        );
        assert_eq!(
            normalize_stopless_trigger_hint_for_metadata(Some("stop_schema_continue_next_step")),
            "non_terminal_schema"
        );
        assert_eq!(
            normalize_stopless_trigger_hint_for_metadata(Some("stop_schema_budget_exhausted")),
            "budget_exhausted"
        );
        assert_eq!(
            normalize_stopless_trigger_hint_for_metadata(Some("stop_schema_finished")),
            "schema_pass"
        );
        assert_eq!(
            normalize_stopless_trigger_hint_for_metadata(Some("")),
            "no_schema"
        );
    }

    #[test]
    fn stopless_cli_model_guidance_expands_each_missing_field_with_repair_instructions() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "reasoningStop".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "repeatCount": 1,
                    "maxRepeats": 3,
                    "stopreason": 0,
                    "reason": "准备结束",
                    "has_evidence": 0,
                    "evidence": "",
                    "issue_cause": "",
                    "excluded_factors": "",
                    "diagnostic_order": "",
                    "done_steps": "",
                    "next_step": ""
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-guidance-missing-fields".to_string()),
                request_id: Some("req-guidance-missing-fields".to_string()),
            },
        )
        .expect("reasoningStop missing fields output");

        let feedback = output.schema_feedback.expect("schema feedback");
        assert_eq!(feedback.reason_code, "stop_schema_terminal_missing_fields");
        assert!(feedback
            .missing_fields
            .contains(&"has_evidence".to_string()));
        assert!(feedback.missing_fields.contains(&"evidence".to_string()));
        assert!(feedback.missing_fields.contains(&"done_steps".to_string()));

        assert!(
            output.model_guidance.is_empty(),
            "CLI stdout must stay status-only; request restore renders semantic guidance"
        );
    }

    #[test]
    fn stopless_cli_model_guidance_explains_missing_stopreason_and_next_step() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "reasoningStop".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "repeatCount": 2,
                    "maxRepeats": 3,
                    "reason": "还要继续推进",
                    "has_evidence": 0,
                    "evidence": "",
                    "issue_cause": "",
                    "excluded_factors": "",
                    "diagnostic_order": "",
                    "done_steps": "",
                    "next_step": ""
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-guidance-next-step".to_string()),
                request_id: Some("req-guidance-next-step".to_string()),
            },
        )
        .expect("reasoningStop missing stopreason output");

        assert!(
            output.model_guidance.is_empty(),
            "CLI stdout must stay status-only; request restore renders semantic guidance"
        );
    }

    // ── trigger hint branch tests ──────────────────────────────────────────

    #[test]
    fn stopless_cli_output_with_explicit_invalid_schema_trigger_hints_produces_invalid_schema_hint()
    {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "triggerHint": "invalid_schema",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-trigger-test".to_string()),
                request_id: Some("req-trigger-test".to_string()),
            },
        )
        .expect("stop_message_auto output");
        assert!(output.schema_guidance.is_none());
        // output.input must also carry triggerHint
        let inp = output.input;
        assert_eq!(inp["triggerHint"], "invalid_schema");
    }

    #[test]
    fn stopless_cli_output_with_stopreason_non_numeric_reason_code_maps_to_invalid_schema_hint() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "triggerHint": "stop_schema_stopreason_missing_or_non_numeric",
                    "schemaFeedback": {
                        "reasonCode": "stop_schema_stopreason_missing_or_non_numeric",
                        "missingFields": ["stopreason"]
                    },
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-trigger-stopreason".to_string()),
                request_id: Some("req-trigger-stopreason".to_string()),
            },
        )
        .expect("stop_message_auto output");
        assert!(output.schema_guidance.is_none());
        let inp = output.input;
        assert_eq!(inp["triggerHint"], "invalid_schema");
        assert!(inp.get("schemaFeedback").is_none());
    }

    #[test]
    fn stopless_cli_output_with_explicit_non_terminal_schema_trigger_hints_produces_non_terminal_schema_hint(
    ) {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "triggerHint": "non_terminal_schema",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-trigger-test".to_string()),
                request_id: Some("req-trigger-test".to_string()),
            },
        )
        .expect("stop_message_auto output");
        assert!(output.schema_guidance.is_none());
        let inp = output.input;
        assert_eq!(inp["triggerHint"], "non_terminal_schema");
    }

    #[test]
    fn stopless_cli_output_with_explicit_budget_exhausted_trigger_hints_produces_budget_exhausted_hint(
    ) {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "triggerHint": "budget_exhausted",
                    "repeatCount": 3,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-trigger-test".to_string()),
                request_id: Some("req-trigger-test".to_string()),
            },
        )
        .expect("stop_message_auto output");
        let schema_guidance = output.schema_guidance.expect("must carry schema guidance");
        assert_eq!(
            schema_guidance.trigger_hint, "budget_exhausted",
            "explicit budget_exhausted triggerHint must map to budget_exhausted"
        );
        let inp = output.input;
        assert_eq!(inp["triggerHint"], "budget_exhausted");
    }

    #[test]
    fn stopless_cli_output_with_explicit_schema_pass_trigger_hints_produces_schema_pass_hint() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "triggerHint": "schema_pass",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-trigger-test".to_string()),
                request_id: Some("req-trigger-test".to_string()),
            },
        )
        .expect("stop_message_auto output");
        assert!(output.schema_guidance.is_none());
        let inp = output.input;
        assert_eq!(inp["triggerHint"], "schema_pass");
    }

    #[test]
    fn public_reasoning_stop_partial_schema_derives_missing_schema_feedback() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "reasoningStop".to_string(),
                input: json!({
                    "stopreason": 2,
                    "reason": "第一轮故意缺 schema"
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-derive-schema".to_string()),
                request_id: Some("req-derive-schema".to_string()),
            },
        )
        .expect("reasoningStop output");
        assert_eq!(output.flow_id, "stop_message_flow");
        assert_eq!(output.input["flowId"], "stop_message_flow");
        let reason_code = output
            .schema_feedback
            .as_ref()
            .map(|item| item.reason_code.as_str())
            .expect("schema feedback reason");
        assert!(!reason_code.is_empty());
        assert_ne!(
            output.input["triggerHint"],
            Value::String("budget_exhausted".to_string())
        );
        assert!(output
            .schema_feedback
            .as_ref()
            .expect("schema feedback")
            .missing_fields
            .iter()
            .any(|field| field == "next_step"));
        assert!(output.input.get("schemaFeedback").is_none());
        assert_eq!(
            output
                .schema_feedback
                .as_ref()
                .expect("schema feedback")
                .reason_code,
            reason_code
        );
    }

    #[test]
    fn public_reasoning_stop_with_control_envelope_still_derives_invalid_schema_feedback() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "reasoningStop".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "repeatCount": 1,
                    "maxRepeats": 3,
                    "stopreason": 2,
                    "reason": "还没完成",
                    "has_evidence": 0,
                    "evidence": "",
                    "issue_cause": "",
                    "excluded_factors": "",
                    "diagnostic_order": "",
                    "done_steps": "",
                    "next_suggested_path": "",
                    "needs_user_input": false,
                    "learned": ""
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_id: Some("session-control-envelope".to_string()),
                request_id: Some("req-control-envelope".to_string()),
            },
        )
        .expect("reasoningStop output");
        assert_eq!(output.flow_id, "stop_message_flow");
        assert_eq!(output.input["repeatCount"], 1);
        assert_eq!(output.input["maxRepeats"], 3);
        assert_eq!(output.input["triggerHint"], "invalid_schema");
        assert!(output.schema_guidance.is_none());
        assert_eq!(
            output
                .schema_feedback
                .as_ref()
                .expect("schema feedback")
                .reason_code,
            "stop_schema_next_step_missing"
        );
        assert!(output
            .schema_feedback
            .as_ref()
            .expect("schema feedback")
            .missing_fields
            .iter()
            .any(|field| field == "next_step"));
    }

    #[test]
    fn public_reasoning_stop_full_schema_derives_schema_pass_without_feedback() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "reasoningStop".to_string(),
                input: json!({
                    "stopreason": 0,
                    "reason": "done",
                    "has_evidence": 1,
                    "evidence": "ok",
                    "issue_cause": "fixed",
                    "excluded_factors": "none",
                    "diagnostic_order": "1",
                    "done_steps": "done",
                    "next_step": "",
                    "next_suggested_path": "",
                    "needs_user_input": false,
                    "learned": "x"
                }),
                flow_id: None,
                repeat_count: Some(1),
                max_repeats: Some(3),
                session_id: Some("session-derive-schema-pass".to_string()),
                request_id: Some("req-derive-schema-pass".to_string()),
            },
        )
        .expect("reasoningStop output");
        assert_eq!(output.flow_id, "stop_message_flow");
        assert_eq!(output.input["flowId"], "stop_message_flow");
        assert_eq!(
            output.input["triggerHint"],
            Value::String("schema_pass".to_string())
        );
        assert!(output.schema_feedback.is_none());
        assert_eq!(output.summary, "stopless continuation ready");
    }

    // projection_output_quotes_json_apostrophes already covers triggerHint in command JSON
    // but we add a dedicated projection triggerHint test for clarity:
    #[test]
    fn plan_projection_includes_trigger_hint_in_command_json() {
        let out = plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
            tool_name: Some("stop_message_auto".to_string()),
            flow_id: Some("stop_message_flow".to_string()),
            input: Some(json!({"repeatCount": 1, "maxRepeats": 3})),
            repeat_count: None,
            max_repeats: None,
            stdout_preview: None,
            session_id: None,
            request_id: None,
        })
        .expect("projection output");
        let command = out["execCommand"].as_str().expect("exec command");
        // triggerHint must appear in the JSON embedded in the shell command
        assert!(
            command.contains("triggerHint"),
            "projection command must include triggerHint: {}",
            command
        );
    }
}
