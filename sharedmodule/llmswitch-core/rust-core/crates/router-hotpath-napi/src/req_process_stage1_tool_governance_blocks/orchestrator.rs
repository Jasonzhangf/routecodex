use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::hub_pipeline_blocks::responses_resume::lift_responses_resume_into_semantics;
use crate::metadata_center::{
    build_metadata_center_from_snapshot, MetadataCenter, MetadataCenterReader,
};
use crate::req_process_stage1_tool_governance_blocks::request_result::{
    apply_chat_process_request_sanitizer, build_governed_filter_payload, build_node_result,
    build_processed_request, now_millis,
};
use crate::req_process_stage1_tool_governance_blocks::request_sanitizer::{
    apply_anthropic_tool_alias_semantics, apply_post_governed_media_cleanup,
    resolve_governance_context,
};
use crate::req_process_stage1_tool_governance_blocks::servertool_injection::maybe_apply_servertool_orchestration;
use crate::shared_json_utils::{normalize_record, normalize_record_ref};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolGovernanceInput {
    pub request: Value,
    pub raw_payload: Value,
    pub metadata: Value,
    pub entry_endpoint: String,
    pub request_id: String,
    #[serde(default)]
    pub has_active_stop_message_for_continue_execution: Option<bool>,
    #[serde(default)]
    pub metadata_center_snapshot: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolGovernanceOutput {
    pub processed_request: Value,
    pub metadata: Value,
    pub node_result: Value,
}

#[derive(Debug)]
struct GovernanceContext {
    entry_endpoint: String,
}

const STOPLESS_SYSTEM_INSTRUCTION: &str = concat!(
    "停止、暂停或继续当前轮时，使用唯一 stop schema 合同。\n",
    "优先调用 reasoningStop function tool，并把 JSON schema 放进 tool call arguments。\n",
    "禁止把 reasoningStop 当成 shell / CLI 命令；不要输出或执行 exec_command(cmd=\"reasoningStop\")。\n",
    "字段是条件必填：stopreason 是唯一无条件必填字段；stopreason=0 需要 has_evidence=1 且 evidence 非空；stopreason=1 需要 reason 非空；stopreason=2 需要 current_goal 和 next_step；needs_user_input=true 时 next_step 必须直接写要问用户的问题。\n",
    "如果收到上一轮反馈，只按反馈补对应字段；没有反馈时继续当前任务。\n",
    "如果你直接 finish_reason=stop，正文末尾必须附：\n",
    "<rcc_stop_schema>\n",
    "{\"stopreason\":2,\"reason\":\"当前状态\",\"current_goal\":\"当前目标\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"下一步动作\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}\n",
    "</rcc_stop_schema>\n",
    "标准 JSON 字段：stopreason, reason, current_goal, has_evidence, evidence, issue_cause, excluded_factors, diagnostic_order, done_steps, next_step, next_suggested_path, needs_user_input, learned。\n",
    "stopreason 取值：0=finished，1=blocked，2=continue_needed。\n",
    "needs_user_input 只能是 true/false；true 只用于真的需要向用户提一个问题。\n",
    "最小可复制样本：{\"stopreason\":2,\"reason\":\"当前状态\",\"current_goal\":\"当前目标\",\"has_evidence\":0,\"evidence\":\"\",\"next_step\":\"下一步动作\",\"needs_user_input\":false}。\n",
    "没有 reasoningStop arguments 时，使用 <rcc_stop_schema>。"
);

fn text_has_current_stopless_system_instruction(content: &str) -> bool {
    content.contains("<rcc_stop_schema>") && content.contains("字段是条件必填")
}

fn text_has_any_stopless_system_instruction(content: &str) -> bool {
    content.contains("<rcc_stop_schema>")
        && (content.contains("reasoningStop") || content.contains("stopreason"))
}

fn value_has_current_stopless_system_instruction(value: &Value) -> bool {
    match value {
        Value::String(content) => text_has_current_stopless_system_instruction(content),
        Value::Array(items) => items
            .iter()
            .any(value_has_current_stopless_system_instruction),
        Value::Object(row) => row
            .values()
            .any(value_has_current_stopless_system_instruction),
        _ => false,
    }
}

fn value_has_any_stopless_system_instruction(value: &Value) -> bool {
    match value {
        Value::String(content) => text_has_any_stopless_system_instruction(content),
        Value::Array(items) => items.iter().any(value_has_any_stopless_system_instruction),
        Value::Object(row) => row.values().any(value_has_any_stopless_system_instruction),
        _ => false,
    }
}

fn build_stopless_responses_system_input_item() -> Value {
    serde_json::json!({
        "type": "message",
        "role": "system",
        "content": [{
            "type": "input_text",
            "text": STOPLESS_SYSTEM_INSTRUCTION
        }]
    })
}

fn build_stopless_chat_system_message() -> Value {
    serde_json::json!({
        "role": "system",
        "content": STOPLESS_SYSTEM_INSTRUCTION
    })
}

fn inject_stopless_system_instruction(request: &mut Map<String, Value>) {
    let has_supported_turns = request
        .get("input")
        .map(|value| matches!(value, Value::Array(_)))
        .unwrap_or(false)
        || request
            .get("messages")
            .map(|value| matches!(value, Value::Array(_)))
            .unwrap_or(false);
    if !has_supported_turns {
        return;
    }
    if request
        .get("instructions")
        .map(value_has_any_stopless_system_instruction)
        .unwrap_or(false)
    {
        request.remove("instructions");
    }
    if let Some(input) = request.get_mut("input").and_then(Value::as_array_mut) {
        if !input
            .iter()
            .any(value_has_current_stopless_system_instruction)
        {
            input.insert(0, build_stopless_responses_system_input_item());
        }
    }
    if let Some(messages) = request.get_mut("messages").and_then(Value::as_array_mut) {
        if !messages
            .iter()
            .any(value_has_current_stopless_system_instruction)
        {
            messages.insert(0, build_stopless_chat_system_message());
        }
    }
}

fn should_inject_stopless_system_instruction(center: &MetadataCenter) -> bool {
    center.stop_message_enabled().unwrap_or(false)
}

fn request_has_tool(request: &Map<String, Value>, tool_name: &str) -> bool {
    request
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools.iter().any(|tool| {
                let direct_name = tool.get("name").and_then(Value::as_str).map(str::trim);
                let function_name = tool
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|row| row.get("name"))
                    .and_then(Value::as_str)
                    .map(str::trim);
                direct_name == Some(tool_name) || function_name == Some(tool_name)
            })
        })
        .unwrap_or(false)
}

fn output_has_terminal_stopless_trigger(output: &Value) -> bool {
    let row = match output {
        Value::String(raw) => serde_json::from_str::<Value>(raw).ok(),
        Value::Object(_) => Some(output.clone()),
        _ => None,
    };
    let Some(row) = row.and_then(|value| value.as_object().cloned()) else {
        return false;
    };
    row.get("schemaGuidance")
        .or_else(|| row.get("schema_guidance"))
        .and_then(Value::as_object)
        .and_then(|schema| {
            schema
                .get("triggerHint")
                .or_else(|| schema.get("trigger_hint"))
        })
        .or_else(|| {
            row.get("input")
                .or_else(|| row.get("input_json"))
                .and_then(Value::as_object)
                .and_then(|input| {
                    input
                        .get("triggerHint")
                        .or_else(|| input.get("trigger_hint"))
                })
        })
        .and_then(Value::as_str)
        .map(is_terminal_stopless_trigger)
        .unwrap_or(false)
}

fn is_terminal_stopless_trigger(value: &str) -> bool {
    let normalized = value.trim();
    normalized.eq_ignore_ascii_case("budget_exhausted")
        || normalized.eq_ignore_ascii_case("schema_pass")
        || normalized.eq_ignore_ascii_case("stop_schema_budget_exhausted")
        || normalized.eq_ignore_ascii_case("stop_schema_finished")
        || normalized.eq_ignore_ascii_case("stop_schema_blocked")
        || normalized.eq_ignore_ascii_case("stop_schema_needs_user_input")
        || normalized.eq_ignore_ascii_case("stop_schema_forcestop")
}

fn value_contains_terminal_stopless_output(value: Option<&Value>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let Some(items) = value.as_array() else {
        return false;
    };
    items.iter().any(|entry| {
        let Some(row) = entry.as_object() else {
            return false;
        };
        let item_type = row
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(
            item_type.as_str(),
            "function_call_output" | "tool_result" | "tool_message"
        ) {
            return output_has_terminal_stopless_trigger(row.get("output").unwrap_or(&Value::Null));
        }
        let role = row
            .get("role")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if role == "tool" {
            return output_has_terminal_stopless_trigger(
                row.get("content")
                    .or_else(|| row.get("output"))
                    .unwrap_or(&Value::Null),
            );
        }
        false
    })
}

fn request_has_terminal_stopless_output(request: &Map<String, Value>) -> bool {
    value_contains_terminal_stopless_output(request.get("input"))
        || value_contains_terminal_stopless_output(request.get("messages"))
}

fn metadata_has_terminal_stopless_runtime_control(metadata: &Map<String, Value>) -> bool {
    metadata
        .get("runtime_control")
        .and_then(Value::as_object)
        .and_then(|runtime_control| runtime_control.get("stopless"))
        .and_then(Value::as_object)
        .filter(|stopless| {
            stopless
                .get("active")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .and_then(|stopless| {
            stopless
                .get("triggerHint")
                .or_else(|| stopless.get("trigger_hint"))
        })
        .and_then(Value::as_str)
        .map(is_terminal_stopless_trigger)
        .unwrap_or(false)
}

fn strip_tool_choice_for_terminal_stopless_turn(request: &mut Map<String, Value>) {
    let should_remove = request
        .get("tool_choice")
        .or_else(|| request.get("toolChoice"))
        .map(|tool_choice| match tool_choice {
            Value::String(raw) => raw.trim().eq_ignore_ascii_case("required"),
            Value::Object(row) => row
                .get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .map(|name| name.trim().eq_ignore_ascii_case("reasoningStop"))
                .unwrap_or_else(|| {
                    row.get("type")
                        .and_then(Value::as_str)
                        .map(|value| value.trim().eq_ignore_ascii_case("function"))
                        .unwrap_or(false)
                }),
            _ => false,
        })
        .unwrap_or(false);
    if should_remove {
        request.remove("tool_choice");
        request.remove("toolChoice");
    }
}

fn strip_stopless_terminal_controls(request: &mut Map<String, Value>) {
    if request
        .get("instructions")
        .map(value_has_any_stopless_system_instruction)
        .unwrap_or(false)
    {
        request.remove("instructions");
    }
    if let Some(input) = request.get_mut("input").and_then(Value::as_array_mut) {
        input.retain(|item| !value_has_any_stopless_system_instruction(item));
    }
    if let Some(messages) = request.get_mut("messages").and_then(Value::as_array_mut) {
        messages.retain(|item| !value_has_any_stopless_system_instruction(item));
    }
    if let Some(tools) = request.get_mut("tools").and_then(Value::as_array_mut) {
        tools.retain(|tool| {
            let direct_name = tool.get("name").and_then(Value::as_str).map(str::trim);
            let function_name = tool
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str)
                .map(str::trim);
            direct_name != Some("reasoningStop") && function_name != Some("reasoningStop")
        });
    }
    strip_tool_choice_for_terminal_stopless_turn(request);
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn read_u64_field(row: &Map<String, Value>, camel: &str, snake: &str) -> Option<u64> {
    row.get(camel)
        .or_else(|| row.get(snake))
        .and_then(Value::as_u64)
}

fn parse_stopless_cli_output(value: &Value) -> Option<Map<String, Value>> {
    let parsed = match value {
        Value::String(raw) => serde_json::from_str::<Value>(raw.trim()).ok()?,
        Value::Object(_) => value.clone(),
        _ => return None,
    };
    let row = parsed.as_object()?.clone();
    let tool_name = read_trimmed_string(row.get("toolName"))
        .or_else(|| read_trimmed_string(row.get("tool_name")))
        .or_else(|| read_trimmed_string(row.get("tool")));
    let flow_id = read_trimmed_string(row.get("flowId"))
        .or_else(|| read_trimmed_string(row.get("flow_id")))
        .or_else(|| read_nested_string_field(&row, "input", "flowId", "flow_id"));
    let has_stopless_counter = read_u64_field(&row, "repeatCount", "repeat_count")
        .or_else(|| {
            row.get("input")
                .and_then(Value::as_object)
                .and_then(|input| read_u64_field(input, "repeatCount", "repeat_count"))
        })
        .is_some();
    if tool_name.as_deref() != Some("stop_message_auto")
        && !(flow_id.as_deref() == Some("stop_message_flow") && has_stopless_counter)
    {
        return None;
    }
    Some(row)
}

fn latest_stopless_cli_output_from_items(items: Option<&Value>) -> Option<Map<String, Value>> {
    let items = items?.as_array()?;
    for item in items.iter().rev() {
        let Some(row) = item.as_object() else {
            continue;
        };
        if let Some(output) = row.get("output").or_else(|| row.get("content")) {
            if let Some(parsed) = parse_stopless_cli_output(output) {
                return Some(parsed);
            }
        }
        let item_type = row
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(
            item_type.as_str(),
            "function_call_output" | "tool_result" | "tool_message"
        ) {
            continue;
        }
        let role = row
            .get("role")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if role == "tool" {
            if let Some(output) = row.get("content").or_else(|| row.get("output")) {
                if let Some(parsed) = parse_stopless_cli_output(output) {
                    return Some(parsed);
                }
            }
        }
    }
    None
}

fn latest_stopless_cli_output(request: &Map<String, Value>) -> Option<Map<String, Value>> {
    latest_stopless_cli_output_from_items(request.get("input"))
        .or_else(|| latest_stopless_cli_output_from_items(request.get("messages")))
        .or_else(|| latest_stopless_cli_output_from_items(request.get("tool_outputs")))
}

fn latest_stopless_runtime_control_from_guidance(request: &Map<String, Value>) -> Option<Value> {
    latest_stopless_runtime_control_from_guidance_items(request.get("input"))
        .or_else(|| latest_stopless_runtime_control_from_guidance_items(request.get("messages")))
}

fn latest_stopless_runtime_control_from_guidance_items(items: Option<&Value>) -> Option<Value> {
    let items = items?.as_array()?;
    for item in items.iter().rev() {
        let mut texts = Vec::new();
        collect_string_segments(item, &mut texts);
        for text in texts.iter().rev() {
            if let Some(stopless) = build_stopless_runtime_control_from_guidance_text(text) {
                return Some(stopless);
            }
        }
    }
    None
}

fn collect_string_segments(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => out.push(text.clone()),
        Value::Array(items) => {
            for item in items {
                collect_string_segments(item, out);
            }
        }
        Value::Object(row) => {
            for value in row.values() {
                collect_string_segments(value, out);
            }
        }
        _ => {}
    }
}

fn build_stopless_runtime_control_from_guidance_text(text: &str) -> Option<Value> {
    if !text.contains("上一轮执行结果") || !text.contains("repeatCount=") {
        return None;
    }
    let repeat_count = parse_repeat_count_from_guidance(text)?;
    let max_repeats = parse_max_repeats_from_guidance(text).unwrap_or(3);
    let reason_code = parse_guidance_token_after(text, "reasonCode=");
    let missing_fields = parse_guidance_token_after(text, "missingFields=").map(|raw| {
        raw.split(|ch| ch == ',' || ch == '，')
            .map(str::trim)
            .filter(|field| !field.is_empty())
            .map(|field| Value::String(field.to_string()))
            .collect::<Vec<_>>()
    });

    let mut stopless = Map::new();
    stopless.insert(
        "flowId".to_string(),
        Value::String("stop_message_flow".to_string()),
    );
    stopless.insert(
        "repeatCount".to_string(),
        Value::Number(repeat_count.into()),
    );
    stopless.insert("maxRepeats".to_string(), Value::Number(max_repeats.into()));
    stopless.insert("active".to_string(), Value::Bool(true));
    if let Some(reason_code) = reason_code.clone() {
        stopless.insert(
            "triggerHint".to_string(),
            Value::String(normalize_stopless_runtime_trigger_hint(&reason_code).to_string()),
        );
        let mut feedback = Map::new();
        feedback.insert("reasonCode".to_string(), Value::String(reason_code));
        if let Some(missing_fields) = missing_fields {
            feedback.insert("missingFields".to_string(), Value::Array(missing_fields));
        }
        stopless.insert("schemaFeedback".to_string(), Value::Object(feedback));
    }
    Some(Value::Object(stopless))
}

fn parse_repeat_count_from_guidance(text: &str) -> Option<u64> {
    let raw = text.split("repeatCount=").nth(1)?;
    parse_leading_u64(raw)
}

fn parse_max_repeats_from_guidance(text: &str) -> Option<u64> {
    let raw = text.split("repeatCount=").nth(1)?;
    let after_slash = raw.split('/').nth(1)?;
    parse_leading_u64(after_slash)
}

fn parse_leading_u64(raw: &str) -> Option<u64> {
    let digits: String = raw
        .chars()
        .skip_while(|ch| ch.is_whitespace())
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u64>().ok()
    }
}

fn parse_guidance_token_after(text: &str, marker: &str) -> Option<String> {
    let raw = text.split(marker).nth(1)?;
    let token = raw
        .split(|ch: char| ch == '；' || ch == ';' || ch == '。' || ch == '\n' || ch == '\r')
        .next()?
        .trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

fn latest_stopless_cli_output_from_resume(resume: Option<&Value>) -> Option<Map<String, Value>> {
    let resume_obj = resume?.as_object()?;
    if let Some(items) = resume_obj
        .get("toolOutputsDetailed")
        .or_else(|| resume_obj.get("tool_outputs_detailed"))
        .and_then(Value::as_array)
    {
        for item in items.iter().rev() {
            let Some(row) = item.as_object() else {
                continue;
            };
            let output = row
                .get("outputText")
                .or_else(|| row.get("output_text"))
                .or_else(|| row.get("output"));
            if let Some(parsed) = output.and_then(parse_stopless_cli_output) {
                return Some(parsed);
            }
        }
    }

    let outputs = resume_obj
        .get("toolContinuation")
        .or_else(|| resume_obj.get("tool_continuation"))
        .and_then(Value::as_object)
        .and_then(|tool| {
            tool.get("resumeOutputs")
                .or_else(|| tool.get("resume_outputs"))
        })
        .and_then(Value::as_array);
    if let Some(outputs) = outputs {
        for output in outputs.iter().rev() {
            if let Some(parsed) = parse_stopless_cli_output(output) {
                return Some(parsed);
            }
        }
    }
    None
}

fn latest_stopless_cli_output_from_request_semantics(
    request: &Map<String, Value>,
) -> Option<Map<String, Value>> {
    let semantics = request.get("semantics").and_then(Value::as_object)?;
    latest_stopless_cli_output_from_items(semantics.get("input"))
        .or_else(|| {
            latest_stopless_cli_output_from_resume(
                semantics
                    .get("responses")
                    .and_then(Value::as_object)
                    .and_then(|responses| responses.get("resume")),
            )
        })
        .or_else(|| latest_stopless_cli_output_from_resume(semantics.get("continuation")))
}

fn request_truth_session_id(metadata_center: &MetadataCenter) -> Option<String> {
    metadata_center
        .request_truth
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn has_request_truth_session_id(metadata_center: &MetadataCenter) -> bool {
    request_truth_session_id(metadata_center).is_some()
}

fn read_nested_string_field<'a>(
    row: &'a Map<String, Value>,
    owner: &str,
    camel: &str,
    snake: &str,
) -> Option<String> {
    row.get(owner)
        .and_then(Value::as_object)
        .and_then(|nested| {
            read_trimmed_string(nested.get(camel))
                .or_else(|| read_trimmed_string(nested.get(snake)))
        })
}

fn normalize_stopless_runtime_trigger_hint(token: &str) -> &'static str {
    match token.trim() {
        "stop_schema_missing" | "no_schema" => "no_schema",
        "stop_schema_reason_missing"
        | "stop_schema_terminal_missing_fields"
        | "stop_schema_stopreason_missing_or_non_numeric"
        | "stop_schema_needs_user_input_missing_next_step"
        | "stop_schema_current_goal_missing"
        | "stop_schema_next_step_missing"
        | "stop_schema_forcestop_reason_missing"
        | "stop_schema_continue_without_next_step"
        | "invalid_schema" => "invalid_schema",
        "stop_schema_continue_next_step" | "non_terminal_schema" => "non_terminal_schema",
        "stop_schema_budget_exhausted" | "budget_exhausted" => "budget_exhausted",
        "stop_schema_finished"
        | "stop_schema_blocked"
        | "stop_schema_needs_user_input"
        | "stop_schema_forcestop"
        | "schema_pass" => "schema_pass",
        _ => "no_schema",
    }
}

fn build_stopless_runtime_control_from_cli(
    row: &Map<String, Value>,
    metadata_center: &MetadataCenter,
    allow_without_session_id: bool,
) -> Option<Value> {
    let session_id = request_truth_session_id(metadata_center);
    if session_id.is_none() && !allow_without_session_id {
        return None;
    }
    let repeat_count = read_u64_field(row, "repeatCount", "repeat_count").or_else(|| {
        row.get("input")
            .and_then(Value::as_object)
            .and_then(|input| read_u64_field(input, "repeatCount", "repeat_count"))
    })?;
    let max_repeats = read_u64_field(row, "maxRepeats", "max_repeats")
        .or_else(|| {
            row.get("input")
                .and_then(Value::as_object)
                .and_then(|input| read_u64_field(input, "maxRepeats", "max_repeats"))
        })
        .unwrap_or(3);
    let flow_id = read_trimmed_string(row.get("flowId"))
        .or_else(|| read_trimmed_string(row.get("flow_id")))
        .or_else(|| read_nested_string_field(row, "input", "flowId", "flow_id"))
        .unwrap_or_else(|| "stop_message_flow".to_string());
    let reason_code = row
        .get("schemaFeedback")
        .or_else(|| row.get("schema_feedback"))
        .and_then(Value::as_object)
        .and_then(|feedback| {
            read_trimmed_string(feedback.get("reasonCode"))
                .or_else(|| read_trimmed_string(feedback.get("reason_code")))
        });
    let trigger_hint = row
        .get("schemaGuidance")
        .or_else(|| row.get("schema_guidance"))
        .and_then(Value::as_object)
        .and_then(|guidance| {
            read_trimmed_string(guidance.get("triggerHint"))
                .or_else(|| read_trimmed_string(guidance.get("trigger_hint")))
        })
        .or_else(|| read_nested_string_field(row, "input", "triggerHint", "trigger_hint"))
        .or_else(|| read_trimmed_string(row.get("triggerHint")))
        .or_else(|| read_trimmed_string(row.get("trigger_hint")))
        .or(reason_code)
        .map(|token| normalize_stopless_runtime_trigger_hint(&token).to_string());
    let continuation_prompt = read_trimmed_string(row.get("continuationPrompt"))
        .or_else(|| read_trimmed_string(row.get("continuation_prompt")))
        .or_else(|| {
            metadata_center
                .runtime_control
                .stopless
                .continuation_prompt
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        });
    let schema_feedback = row
        .get("schemaFeedback")
        .or_else(|| row.get("schema_feedback"))
        .and_then(Value::as_object)
        .map(|feedback| Value::Object(feedback.clone()));

    let mut stopless = Map::new();
    stopless.insert("flowId".to_string(), Value::String(flow_id));
    if let Some(session_id) = session_id {
        stopless.insert("sessionId".to_string(), Value::String(session_id));
    }
    stopless.insert(
        "repeatCount".to_string(),
        Value::Number(repeat_count.into()),
    );
    stopless.insert("maxRepeats".to_string(), Value::Number(max_repeats.into()));
    stopless.insert("active".to_string(), Value::Bool(true));
    stopless.insert("updatedAt".to_string(), Value::Number(now_millis().into()));
    if let Some(trigger_hint) = trigger_hint {
        stopless.insert("triggerHint".to_string(), Value::String(trigger_hint));
    }
    if let Some(continuation_prompt) = continuation_prompt {
        stopless.insert(
            "continuationPrompt".to_string(),
            Value::String(continuation_prompt),
        );
    }
    if let Some(schema_feedback) = schema_feedback {
        stopless.insert("schemaFeedback".to_string(), schema_feedback);
    }
    Some(Value::Object(stopless))
}

fn build_initial_stopless_runtime_control(metadata_center: &MetadataCenter) -> Option<Value> {
    let session_id = request_truth_session_id(metadata_center)?;
    Some(serde_json::json!({
        "flowId": "stop_message_flow",
        "sessionId": session_id,
        "repeatCount": 0,
        "maxRepeats": 3,
        "active": true,
        "updatedAt": now_millis()
    }))
}

fn clone_stopless_runtime_control_from_snapshot(snapshot: &Value) -> Option<Value> {
    let stopless = snapshot
        .get("runtimeControl")
        .and_then(Value::as_object)
        .and_then(|runtime_control| runtime_control.get("stopless"))
        .and_then(Value::as_object)?;
    if stopless
        .get("active")
        .and_then(Value::as_bool)
        .is_some_and(|active| !active)
    {
        return None;
    }
    let repeat_count = read_u64_field(stopless, "repeatCount", "repeat_count")?;
    let max_repeats = read_u64_field(stopless, "maxRepeats", "max_repeats").unwrap_or(3);
    let flow_id = read_trimmed_string(stopless.get("flowId"))
        .or_else(|| read_trimmed_string(stopless.get("flow_id")))
        .unwrap_or_else(|| "stop_message_flow".to_string());

    let mut cloned = Map::new();
    cloned.insert("flowId".to_string(), Value::String(flow_id));
    cloned.insert(
        "repeatCount".to_string(),
        Value::Number(repeat_count.into()),
    );
    cloned.insert("maxRepeats".to_string(), Value::Number(max_repeats.into()));
    cloned.insert("active".to_string(), Value::Bool(true));
    if let Some(trigger_hint) = read_trimmed_string(stopless.get("triggerHint"))
        .or_else(|| read_trimmed_string(stopless.get("trigger_hint")))
    {
        cloned.insert("triggerHint".to_string(), Value::String(trigger_hint));
    }
    if let Some(continuation_prompt) = read_trimmed_string(stopless.get("continuationPrompt"))
        .or_else(|| read_trimmed_string(stopless.get("continuation_prompt")))
    {
        cloned.insert(
            "continuationPrompt".to_string(),
            Value::String(continuation_prompt),
        );
    }
    if let Some(schema_feedback) = stopless
        .get("schemaFeedback")
        .or_else(|| stopless.get("schema_feedback"))
        .filter(|value| value.is_object())
    {
        cloned.insert("schemaFeedback".to_string(), schema_feedback.clone());
    }
    Some(Value::Object(cloned))
}

fn value_contains_text(value: &Value, needle: &str) -> bool {
    match value {
        Value::String(text) => text.contains(needle),
        Value::Array(items) => items.iter().any(|item| value_contains_text(item, needle)),
        Value::Object(row) => row.values().any(|item| value_contains_text(item, needle)),
        _ => false,
    }
}

fn inject_stopless_live_continuation_prompt(
    request: &mut Map<String, Value>,
    metadata: &Map<String, Value>,
) {
    let Some(stopless) = metadata
        .get("runtime_control")
        .and_then(Value::as_object)
        .and_then(|runtime_control| runtime_control.get("stopless"))
        .and_then(Value::as_object)
    else {
        return;
    };
    let reason_code = stopless
        .get("schemaFeedback")
        .or_else(|| stopless.get("schema_feedback"))
        .and_then(Value::as_object)
        .and_then(|feedback| {
            read_trimmed_string(feedback.get("reasonCode"))
                .or_else(|| read_trimmed_string(feedback.get("reason_code")))
        });
    let trigger_hint = read_trimmed_string(stopless.get("triggerHint"))
        .or_else(|| read_trimmed_string(stopless.get("trigger_hint")));
    if reason_code.as_deref() != Some("stop_schema_continue_next_step")
        && trigger_hint.as_deref() != Some("non_terminal_schema")
    {
        return;
    }
    let Some(prompt) = read_trimmed_string(stopless.get("continuationPrompt"))
        .or_else(|| read_trimmed_string(stopless.get("continuation_prompt")))
    else {
        return;
    };
    if value_contains_text(&Value::Object(request.clone()), &prompt) {
        return;
    }
    if let Some(input) = request.get_mut("input").and_then(Value::as_array_mut) {
        input.push(serde_json::json!({
            "type": "message",
            "role": "user",
            "content": [{
                "type": "input_text",
                "text": prompt
            }]
        }));
        return;
    }
    if let Some(messages) = request.get_mut("messages").and_then(Value::as_array_mut) {
        messages.push(serde_json::json!({
            "role": "user",
            "content": prompt
        }));
    }
}

fn write_stopless_runtime_control(metadata: &mut Map<String, Value>, stopless: Value) {
    let runtime_control = metadata
        .entry("runtime_control".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !runtime_control.is_object() {
        *runtime_control = Value::Object(Map::new());
    }
    if let Some(runtime_control) = runtime_control.as_object_mut() {
        runtime_control.insert("stopless".to_string(), stopless);
    }
}

fn build_reasoning_stop_tool() -> Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "reasoningStop",
            "description": concat!(
                "Use this tool when you stop, pause, or need another turn. ",
                "Provide stop schema as JSON arguments. Fields are conditionally required: stopreason is the only unconditional required field; stopreason=0 requires has_evidence=1 and non-empty evidence; stopreason=1 requires non-empty reason; stopreason=2 requires current_goal and next_step; needs_user_input=true requires next_step to be the exact user question. ",
                "If you do not call this tool, the assistant text must end with <rcc_stop_schema>...</rcc_stop_schema>. ",
                "stopreason values: 0=finished, 1=blocked, 2=continue_needed. ",
                "If work remains, use stopreason=2 and write current_goal plus next_step. ",
                "Field meanings: stopreason, reason, current_goal, has_evidence, evidence, issue_cause, excluded_factors, diagnostic_order, done_steps, next_step, next_suggested_path, needs_user_input, learned. ",
                "Minimal continue sample: ",
                "{\"stopreason\":2,\"reason\":\"当前状态\",\"current_goal\":\"当前目标\",\"has_evidence\":0,\"evidence\":\"\",\"next_step\":\"下一步动作\",\"needs_user_input\":false}. ",
                "Minimal finished sample: ",
                "{\"stopreason\":0,\"reason\":\"stopreason=0 条件成立\",\"has_evidence\":1,\"evidence\":\"列出日志/测试/文件证据\",\"needs_user_input\":false}"
            ),
            "parameters": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "stopreason": {
                        "type": "integer",
                        "enum": [0, 1, 2],
                        "description": "0=finished, 1=blocked, 2=continue_needed"
                    },
                    "reason": {
                        "type": "string",
                        "description": "Required for blocked stopreason=1; optional summary for other stopreason values."
                    },
                    "has_evidence": {
                        "type": "integer",
                        "enum": [0, 1],
                        "description": "Required as 1 only when stopreason=0 finished."
                    },
                    "current_goal": {
                        "type": "string",
                        "description": "Required when stopreason=2 continue_needed; write the current objective before choosing next_step."
                    },
                    "evidence": {
                        "type": "string",
                        "description": "Required only when stopreason=0 finished or has_evidence=1."
                    },
                    "issue_cause": {
                        "type": "string",
                        "description": "Root cause or current blocker cause."
                    },
                    "excluded_factors": {
                        "type": "string",
                        "description": "Things already ruled out."
                    },
                    "diagnostic_order": {
                        "type": "string",
                        "description": "Investigation order already taken."
                    },
                    "done_steps": {
                        "type": "string",
                        "description": "Concrete steps already completed."
                    },
                    "next_step": {
                        "type": "string",
                        "description": "Required when stopreason=2 continue_needed, or when needs_user_input=true as the exact user question."
                    },
                    "next_suggested_path": {
                        "type": "string",
                        "description": "Suggested next path if another turn is needed."
                    },
                    "needs_user_input": {
                        "type": "boolean",
                        "description": "true only when user input is required before progress can continue."
                    },
                    "learned": {
                        "type": "string",
                        "description": "Key lesson or durable conclusion from this turn."
                    }
                },
                "required": [
                    "stopreason"
                ]
            }
        }
    })
}

fn inject_reasoning_stop_tool(request: &mut Map<String, Value>) {
    if request_has_tool(request, "reasoningStop") {
        return;
    }
    let tools = request
        .entry("tools".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !tools.is_array() {
        *tools = Value::Array(Vec::new());
    }
    if let Some(items) = tools.as_array_mut() {
        items.push(build_reasoning_stop_tool());
    }
}

pub fn apply_req_process_tool_governance(
    input: ToolGovernanceInput,
) -> Result<ToolGovernanceOutput, String> {
    let start_time_ms = now_millis();

    let ctx = resolve_governance_context(&input.metadata, &input.entry_endpoint);

    let lifted = lift_responses_resume_into_semantics(&input.request, &input.metadata);
    let lifted_obj = lifted.as_object();
    let lifted_request = lifted_obj
        .and_then(|row| row.get("request"))
        .cloned()
        .unwrap_or(input.request);
    let lifted_metadata = lifted_obj
        .and_then(|row| row.get("metadata"))
        .cloned()
        .unwrap_or(input.metadata);

    let mut metadata = normalize_record(lifted_metadata.clone());
    let metadata_center = build_metadata_center_from_snapshot(&input.metadata_center_snapshot);
    let mut request = normalize_record(lifted_request);
    apply_chat_process_request_sanitizer(&mut request);
    let has_current_session_id = has_request_truth_session_id(&metadata_center);
    let has_terminal_stopless_turn = request_has_terminal_stopless_output(&request)
        || metadata_has_terminal_stopless_runtime_control(&metadata);
    let stopless_cli_output = latest_stopless_cli_output(&request)
        .or_else(|| latest_stopless_cli_output_from_request_semantics(&request));
    if let Some(stopless) = stopless_cli_output.as_ref().and_then(|row| {
        build_stopless_runtime_control_from_cli(
            row,
            &metadata_center,
            input
                .has_active_stop_message_for_continue_execution
                .unwrap_or(false),
        )
    }) {
        write_stopless_runtime_control(&mut metadata, stopless);
    } else if !has_terminal_stopless_turn
        && metadata
            .get("runtime_control")
            .and_then(Value::as_object)
            .and_then(|runtime_control| runtime_control.get("stopless"))
            .is_none()
    {
        if let Some(stopless) =
            clone_stopless_runtime_control_from_snapshot(&input.metadata_center_snapshot)
                .or_else(|| latest_stopless_runtime_control_from_guidance(&request))
        {
            write_stopless_runtime_control(&mut metadata, stopless);
        } else if has_current_session_id
            && should_inject_stopless_system_instruction(&metadata_center)
        {
            if let Some(stopless) = build_initial_stopless_runtime_control(&metadata_center) {
                write_stopless_runtime_control(&mut metadata, stopless);
            }
        }
    }
    if has_terminal_stopless_turn {
        strip_stopless_terminal_controls(&mut request);
    }
    if has_current_session_id
        && should_inject_stopless_system_instruction(&metadata_center)
        && !has_terminal_stopless_turn
    {
        inject_stopless_live_continuation_prompt(&mut request, &metadata);
        inject_stopless_system_instruction(&mut request);
        inject_reasoning_stop_tool(&mut request);
    }
    normalize_apply_patch_freeform_tool_schema(&mut request);

    apply_anthropic_tool_alias_semantics(&mut request, &ctx.entry_endpoint);

    let governed = build_governed_filter_payload(&Value::Object(request));
    let mut governed_request = normalize_record(governed);
    maybe_apply_servertool_orchestration(
        &mut governed_request,
        &metadata,
        input
            .has_active_stop_message_for_continue_execution
            .unwrap_or(false),
    );
    apply_post_governed_media_cleanup(&mut governed_request);

    let processed = build_processed_request(Value::Object(governed_request), &metadata);
    let processed_request_map = normalize_record_ref(&processed);
    let end_time_ms = now_millis();

    let node_result = build_node_result(
        true,
        start_time_ms,
        end_time_ms,
        &processed_request_map,
        None,
    );

    Ok(ToolGovernanceOutput {
        processed_request: processed,
        metadata: Value::Object(metadata),
        node_result,
    })
}

fn normalize_apply_patch_freeform_tool_schema(request: &mut Map<String, Value>) {
    const APPLY_PATCH_LARK_GRAMMAR: &str = r#"start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
filename: /(.+)/
add_line: "+" /(.*)/ LF
change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
%import common.LF"#;
    let Some(tools) = request.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools {
        let Some(tool_obj) = tool.as_object_mut() else {
            continue;
        };
        let function_name = tool_obj
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str);
        let direct_name = tool_obj.get("name").and_then(Value::as_str);
        let name = function_name.or(direct_name).unwrap_or("").trim();
        if name != "apply_patch" {
            continue;
        }
        let description = tool_obj
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("description"))
            .and_then(Value::as_str)
            .or_else(|| tool_obj.get("description").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Use the `apply_patch` tool to edit files.");
        *tool_obj = serde_json::json!({
            "type": "custom",
            "name": "apply_patch",
            "description": description,
            "format": {
                "type": "grammar",
                "syntax": "lark",
                "definition": APPLY_PATCH_LARK_GRAMMAR
            }
        })
        .as_object()
        .cloned()
        .unwrap_or_default();
    }
}

#[cfg(test)]
mod apply_patch_tool_schema_tests {
    use super::{
        apply_req_process_tool_governance, normalize_apply_patch_freeform_tool_schema,
        ToolGovernanceInput,
    };
    use serde_json::{json, Map, Value};

    fn normalize_tools(input: Value) -> Value {
        let mut request = Map::new();
        request.insert("tools".to_string(), input);
        normalize_apply_patch_freeform_tool_schema(&mut request);
        request.get("tools").cloned().unwrap_or(Value::Null)
    }

    #[test]
    fn normalize_apply_patch_freeform_tool_schema_converts_function_shape_to_custom_freeform() {
        let tools = normalize_tools(json!([{
            "type": "function",
            "function": {
                "name": "apply_patch",
                "description": "Edit files by patch",
                "parameters": {
                    "type": "object",
                    "properties": { "patch": { "type": "string" } },
                    "required": ["patch"]
                }
            }
        }]));

        let tool = &tools.as_array().unwrap()[0];
        assert_eq!(tool["type"], json!("custom"));
        assert_eq!(tool["name"], json!("apply_patch"));
        assert_eq!(tool["description"], json!("Edit files by patch"));
        assert_eq!(tool["format"]["type"], json!("grammar"));
        assert_eq!(tool["format"]["syntax"], json!("lark"));
        let definition = tool["format"]["definition"]
            .as_str()
            .expect("apply_patch grammar definition");
        assert!(definition.contains("begin_patch:"));
        assert!(definition.contains("end_patch:"));
        assert!(definition.contains("%import common.LF"));
        assert!(tool.get("function").is_none());
        assert!(tool.get("parameters").is_none());
    }

    #[test]
    fn normalize_apply_patch_freeform_tool_schema_removes_direct_patch_parameters() {
        let tools = normalize_tools(json!([{
            "type": "custom",
            "name": "apply_patch",
            "description": "Use apply_patch",
            "parameters": {
                "type": "object",
                "properties": { "patch": { "type": "string" } },
                "required": ["patch"]
            }
        }]));

        let tool = &tools.as_array().unwrap()[0];
        assert_eq!(tool["type"], json!("custom"));
        assert_eq!(tool["name"], json!("apply_patch"));
        assert!(tool.get("parameters").is_none());
        assert_eq!(tool["format"]["type"], json!("grammar"));
        let definition = tool["format"]["definition"]
            .as_str()
            .expect("apply_patch grammar definition");
        assert!(definition.contains("begin_patch:"));
    }

    #[test]
    fn apply_req_process_tool_governance_projects_apply_patch_as_custom_freeform_tool() {
        let output = apply_req_process_tool_governance(ToolGovernanceInput {
            request: json!({
                "model": "gpt-test",
                "messages": [{ "role": "user", "content": "edit a file" }],
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "apply_patch",
                        "description": "canonical client apply_patch tool",
                        "parameters": {
                            "type": "object",
                            "properties": { "patch": { "type": "string" } },
                            "required": ["patch"]
                        }
                    }
                }],
                "parameters": {}
            }),
            raw_payload: Value::Null,
            metadata: json!({}),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req-apply-patch-freeform-prod".to_string(),
            has_active_stop_message_for_continue_execution: Some(false),
            metadata_center_snapshot: Value::Null,
        })
        .expect("governed request");

        let tool = output.processed_request["tools"][0].clone();
        assert_eq!(tool["type"], json!("custom"));
        assert_eq!(tool["name"], json!("apply_patch"));
        assert_eq!(tool["format"]["type"], json!("grammar"));
        assert_eq!(tool["format"]["syntax"], json!("lark"));
        assert!(tool.get("parameters").is_none());
        assert!(tool.get("function").is_none());
    }
}

#[napi]
pub fn apply_req_process_tool_governance_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ToolGovernanceInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output =
        apply_req_process_tool_governance(input).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}
