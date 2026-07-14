use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;

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
use crate::stopless_current_turn::{
    is_stopless_transparent_continuation_prompt, scan_stopless_current_turn_items,
    StoplessCurrentTurnScan,
};

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
    "停止输出合同：准备结束、暂停或总结当前回复时，最终 summary 的末尾必须附 stop schema；不要省略，也不要猜字段。\n",
    "字段类型：stopreason=整数 0/1/2；simple_question=布尔值；reason/current_goal/evidence/issue_cause/excluded_factors/diagnostic_order/done_steps/next_step/next_suggested_path/learned=字符串；has_evidence=整数 0/1；needs_user_input=布尔值。\n",
    "必选合同：普通任务必须写 stopreason。stopreason=0(finished) 必须同时写 has_evidence=1 和非空 evidence；stopreason=1(blocked) 必须写非空 reason；stopreason=2(continue_needed) 必须写非空 current_goal 和 next_step；needs_user_input=true 时 next_step 必须是要直接询问用户的完整问题。simple_question=true 仅用于当前用户输入确实是简单问答，此时可不写 stopreason。\n",
    "用户输入规则：needs_user_input=true 只允许用于缺少会影响目标、权限、实际成本或不可逆风险的用户专属决策；“是否继续”“要不要继续”“是否执行下一步”不是有效 blocked/user-input。只要存在可自主执行且有助于完成目标的下一步，就按重要性和依赖顺序直接执行，并在收口 schema 中使用 stopreason=2 和 next_step。\n",
    "可选字段：issue_cause、excluded_factors、diagnostic_order、done_steps、next_suggested_path、learned；有事实就写，没有可用空字符串。reason 在 stopreason=0/2 时可选；has_evidence=0 时 evidence 可为空。\n",
    "stopreason 取值：0=finished，1=blocked，2=continue_needed。\n",
    "输出形态：\n",
    "<rcc_stop_schema>\n",
    "{\"stopreason\":0,\"simple_question\":false,\"reason\":\"\",\"current_goal\":\"\",\"has_evidence\":1,\"evidence\":\"真实文件/日志/命令/测试证据\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"已完成事项\",\"next_step\":\"\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}\n",
    "</rcc_stop_schema>\n",
    "finished 示例：<rcc_stop_schema>{\"stopreason\":0,\"simple_question\":false,\"reason\":\"修复完成\",\"current_goal\":\"\",\"has_evidence\":1,\"evidence\":\"测试 12/12 通过\",\"issue_cause\":\"旧状态被跨 turn 恢复\",\"excluded_factors\":\"provider 响应正常\",\"diagnostic_order\":\"样本->主线->真源->回放\",\"done_steps\":\"根因修复并验证\",\"next_step\":\"\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"计数必须按当前 turn 隔离\"}</rcc_stop_schema>\n",
    "blocked 示例：<rcc_stop_schema>{\"stopreason\":1,\"simple_question\":false,\"reason\":\"缺少生产访问权限\",\"current_goal\":\"\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"权限不足\",\"excluded_factors\":\"本地构建已通过\",\"diagnostic_order\":\"本地验证后检查权限\",\"done_steps\":\"完成本地验证\",\"next_step\":\"请授权生产只读访问\",\"next_suggested_path\":\"授权后执行在线回放\",\"needs_user_input\":true,\"learned\":\"\"}</rcc_stop_schema>\n",
    "continue_needed 示例：<rcc_stop_schema>{\"stopreason\":2,\"simple_question\":false,\"reason\":\"仍需在线验证\",\"current_goal\":\"完成 stopless 透明续轮闭环\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"源码测试已通过\",\"next_step\":\"运行真实 submit_tool_outputs 回放\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}</rcc_stop_schema>"
);

fn text_has_current_stopless_system_instruction(content: &str) -> bool {
    content.contains("<rcc_stop_schema>")
        && content.contains("必选合同")
        && content.contains("可选字段")
        && content.contains("finished 示例")
        && content.contains("blocked 示例")
        && content.contains("continue_needed 示例")
        && content.contains("是否继续")
        && content.contains("stopreason=2")
        && content.contains("next_step")
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

fn current_request_stopless_runtime_control(metadata: &Map<String, Value>) -> Option<Value> {
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
                && read_u64_field(stopless, "repeatCount", "repeat_count").is_some()
        })
        .map(|stopless| Value::Object(stopless.clone()))
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

#[derive(Debug)]
enum StoplessCurrentTurnEvidence {
    CliOutput(Map<String, Value>),
    Guidance(Value),
    TransparentContinuation,
    ResetByUserTurn,
    None,
}

fn stopless_evidence_from_item(
    row: &Map<String, Value>,
    allow_internal_text_evidence: bool,
) -> Option<StoplessCurrentTurnEvidence> {
    let is_user_turn = row
        .get("role")
        .and_then(Value::as_str)
        .is_some_and(|role| role.trim().eq_ignore_ascii_case("user"));
    if is_user_turn && !allow_internal_text_evidence {
        return None;
    }
    if let Some(output) = row.get("output").or_else(|| row.get("content")) {
        if let Some(parsed) = parse_stopless_cli_output(output) {
            return Some(StoplessCurrentTurnEvidence::CliOutput(parsed));
        }
    }
    if !allow_internal_text_evidence {
        return None;
    }
    let mut texts = Vec::new();
    collect_string_segments(&Value::Object(row.clone()), &mut texts);
    for text in texts.iter().rev() {
        if is_stopless_transparent_continuation_prompt(text) {
            return Some(StoplessCurrentTurnEvidence::TransparentContinuation);
        }
        if let Some(stopless) = build_stopless_runtime_control_from_guidance_text(text) {
            return Some(StoplessCurrentTurnEvidence::Guidance(stopless));
        }
    }
    None
}

fn scan_stopless_current_turn_evidence(
    items: Option<&Value>,
    allow_internal_text_evidence: bool,
) -> StoplessCurrentTurnEvidence {
    match scan_stopless_current_turn_items(items, |row| {
        stopless_evidence_from_item(row, allow_internal_text_evidence)
    }) {
        StoplessCurrentTurnScan::Evidence(evidence) => evidence,
        StoplessCurrentTurnScan::ResetByUserTurn => StoplessCurrentTurnEvidence::ResetByUserTurn,
        StoplessCurrentTurnScan::None => StoplessCurrentTurnEvidence::None,
    }
}

fn latest_stopless_cli_output_from_items(items: Option<&Value>) -> Option<Map<String, Value>> {
    match scan_stopless_current_turn_evidence(items, false) {
        StoplessCurrentTurnEvidence::CliOutput(output) => Some(output),
        StoplessCurrentTurnEvidence::Guidance(_)
        | StoplessCurrentTurnEvidence::TransparentContinuation
        | StoplessCurrentTurnEvidence::ResetByUserTurn
        | StoplessCurrentTurnEvidence::None => None,
    }
}

fn latest_stopless_current_turn_evidence(
    request: &Map<String, Value>,
    allow_explicit_resume_output: bool,
) -> StoplessCurrentTurnEvidence {
    if allow_explicit_resume_output {
        if let Some(output) = latest_stopless_cli_output_from_items(request.get("tool_outputs")) {
            return StoplessCurrentTurnEvidence::CliOutput(output);
        }
        if let Some(output) = latest_stopless_cli_output_from_request_resume(request) {
            return StoplessCurrentTurnEvidence::CliOutput(output);
        }
        let semantics_input = request
            .get("semantics")
            .and_then(Value::as_object)
            .and_then(|semantics| semantics.get("input"));
        if let StoplessCurrentTurnEvidence::CliOutput(output) =
            scan_stopless_current_turn_evidence(semantics_input, false)
        {
            return StoplessCurrentTurnEvidence::CliOutput(output);
        }
    }
    for items in [request.get("input"), request.get("messages")] {
        match scan_stopless_current_turn_evidence(items, allow_explicit_resume_output) {
            StoplessCurrentTurnEvidence::None => {}
            evidence => return evidence,
        }
    }
    let semantics_input = request
        .get("semantics")
        .and_then(Value::as_object)
        .and_then(|semantics| semantics.get("input"));
    scan_stopless_current_turn_evidence(semantics_input, allow_explicit_resume_output)
}

fn has_current_responses_resume(request: &Map<String, Value>) -> bool {
    request
        .get("semantics")
        .and_then(Value::as_object)
        .and_then(|semantics| semantics.get("responses"))
        .and_then(Value::as_object)
        .and_then(|responses| responses.get("resume"))
        .is_some_and(Value::is_object)
}

fn latest_stopless_cli_output_from_request_resume(
    request: &Map<String, Value>,
) -> Option<Map<String, Value>> {
    let semantics = request.get("semantics").and_then(Value::as_object)?;
    latest_stopless_cli_output_from_resume(
        semantics
            .get("responses")
            .and_then(Value::as_object)
            .and_then(|responses| responses.get("resume")),
    )
    .or_else(|| latest_stopless_cli_output_from_resume(semantics.get("continuation")))
}

fn stopless_cli_output_is_terminal(row: &Map<String, Value>) -> bool {
    output_has_terminal_stopless_trigger(&Value::Object(row.clone()))
}

fn clear_stopless_runtime_control(metadata: &mut Map<String, Value>) {
    if let Some(runtime_control) = metadata
        .get_mut("runtime_control")
        .and_then(Value::as_object_mut)
    {
        runtime_control.remove("stopless");
    }
}

fn read_item_call_id(row: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(row.get("call_id"))
        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
        .or_else(|| read_trimmed_string(row.get("id")))
}

fn item_is_stopless_cli_call(row: &Map<String, Value>) -> bool {
    let item_type = row
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if item_type != "function_call" {
        return false;
    }
    let name = read_trimmed_string(row.get("name")).unwrap_or_default();
    if name != "exec_command" {
        return name == "reasoningStop" || name == "stop_message_auto";
    }
    let arguments = row
        .get("arguments")
        .map(Value::to_string)
        .unwrap_or_default();
    arguments.contains("routecodex hook run reasoningStop")
        || arguments.contains("routecodex hook run stop_message_auto")
        || (arguments.contains("stop_message_flow") && arguments.contains("repeatCount"))
}

fn nested_tool_call_is_stale_stopless(call: &Value, stale_call_ids: &HashSet<String>) -> bool {
    let Some(row) = call.as_object() else {
        return false;
    };
    if read_item_call_id(row).is_some_and(|call_id| stale_call_ids.contains(&call_id)) {
        return true;
    }
    let function = row
        .get("function")
        .and_then(Value::as_object)
        .unwrap_or(row);
    let name = read_trimmed_string(function.get("name")).unwrap_or_default();
    if name == "reasoningStop" || name == "stop_message_auto" {
        return true;
    }
    if name != "exec_command" {
        return false;
    }
    let arguments = function
        .get("arguments")
        .map(Value::to_string)
        .unwrap_or_default();
    arguments.contains("routecodex hook run reasoningStop")
        || arguments.contains("routecodex hook run stop_message_auto")
        || (arguments.contains("stop_message_flow") && arguments.contains("repeatCount"))
}

fn item_content_is_empty(row: &Map<String, Value>) -> bool {
    match row.get("content") {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.trim().is_empty(),
        Some(Value::Array(items)) => items.is_empty(),
        Some(_) => false,
    }
}

fn strip_previous_cycle_stopless_items(items: &mut Vec<Value>) {
    // This cleanup only runs after current-turn scanning has established a real user reset.
    let Some(latest_real_user_index) = items.iter().rposition(|item| {
        let Some(row) = item.as_object() else {
            return false;
        };
        row.get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| role.trim().eq_ignore_ascii_case("user"))
    }) else {
        return;
    };
    let stale_call_ids = items[..latest_real_user_index]
        .iter()
        .filter_map(Value::as_object)
        .filter(|row| stopless_evidence_from_item(row, true).is_some())
        .filter_map(read_item_call_id)
        .collect::<HashSet<_>>();
    let original_items = std::mem::take(items);
    for (index, mut item) in original_items.into_iter().enumerate() {
        if index >= latest_real_user_index {
            items.push(item);
            continue;
        }
        let Some(row) = item.as_object_mut() else {
            items.push(item);
            continue;
        };
        let is_stopless_evidence = stopless_evidence_from_item(row, true).is_some();
        let is_paired_call =
            read_item_call_id(row).is_some_and(|call_id| stale_call_ids.contains(&call_id));
        if is_stopless_evidence || is_paired_call || item_is_stopless_cli_call(row) {
            continue;
        }
        let mut removed_nested_stopless_call = false;
        if let Some(tool_calls) = row.get_mut("tool_calls").and_then(Value::as_array_mut) {
            let before = tool_calls.len();
            tool_calls.retain(|call| !nested_tool_call_is_stale_stopless(call, &stale_call_ids));
            removed_nested_stopless_call = tool_calls.len() != before;
        }
        let tool_calls_empty = row
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty);
        if removed_nested_stopless_call && tool_calls_empty && item_content_is_empty(row) {
            continue;
        }
        items.push(item);
    }
}

fn strip_previous_cycle_stopless_history(request: &mut Map<String, Value>) {
    if let Some(input) = request.get_mut("input").and_then(Value::as_array_mut) {
        strip_previous_cycle_stopless_items(input);
    }
    if let Some(messages) = request.get_mut("messages").and_then(Value::as_array_mut) {
        strip_previous_cycle_stopless_items(messages);
    }
    if let Some(semantics_input) = request
        .get_mut("semantics")
        .and_then(Value::as_object_mut)
        .and_then(|semantics| semantics.get_mut("input"))
        .and_then(Value::as_array_mut)
    {
        strip_previous_cycle_stopless_items(semantics_input);
    }
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

fn clone_stopless_runtime_control_from_snapshot(
    snapshot: &Value,
    metadata_center: &MetadataCenter,
) -> Option<Value> {
    let session_id = request_truth_session_id(metadata_center)?;
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
    cloned.insert("sessionId".to_string(), Value::String(session_id));
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
    let current_request_stopless = request
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(current_request_stopless_runtime_control);
    apply_chat_process_request_sanitizer(&mut request);
    let has_current_session_id = has_request_truth_session_id(&metadata_center);
    let allow_explicit_resume_output = input.entry_endpoint.contains("submit_tool_outputs")
        || has_current_responses_resume(&request);
    let current_turn_evidence = current_request_stopless
        .map(StoplessCurrentTurnEvidence::Guidance)
        .unwrap_or_else(|| {
            latest_stopless_current_turn_evidence(&request, allow_explicit_resume_output)
        });
    let user_turn_reset = matches!(
        current_turn_evidence,
        StoplessCurrentTurnEvidence::ResetByUserTurn
    );
    let has_terminal_stopless_turn = match &current_turn_evidence {
        StoplessCurrentTurnEvidence::CliOutput(row) => stopless_cli_output_is_terminal(row),
        StoplessCurrentTurnEvidence::Guidance(_)
        | StoplessCurrentTurnEvidence::TransparentContinuation
        | StoplessCurrentTurnEvidence::ResetByUserTurn
        | StoplessCurrentTurnEvidence::None => false,
    } || (!user_turn_reset
        && metadata_has_terminal_stopless_runtime_control(&metadata));
    let current_turn_stopless = match &current_turn_evidence {
        StoplessCurrentTurnEvidence::CliOutput(row) => build_stopless_runtime_control_from_cli(
            row,
            &metadata_center,
            input
                .has_active_stop_message_for_continue_execution
                .unwrap_or(false),
        ),
        StoplessCurrentTurnEvidence::Guidance(stopless) => stopless.as_object().and_then(|row| {
            build_stopless_runtime_control_from_cli(
                row,
                &metadata_center,
                input
                    .has_active_stop_message_for_continue_execution
                    .unwrap_or(false),
            )
        }),
        StoplessCurrentTurnEvidence::TransparentContinuation => {
            clone_stopless_runtime_control_from_snapshot(
                &input.metadata_center_snapshot,
                &metadata_center,
            )
        }
        StoplessCurrentTurnEvidence::ResetByUserTurn | StoplessCurrentTurnEvidence::None => None,
    };
    if let Some(stopless) = current_turn_stopless {
        write_stopless_runtime_control(&mut metadata, stopless);
    } else if user_turn_reset {
        strip_previous_cycle_stopless_history(&mut request);
        clear_stopless_runtime_control(&mut metadata);
        if has_current_session_id && should_inject_stopless_system_instruction(&metadata_center) {
            if let Some(stopless) = build_initial_stopless_runtime_control(&metadata_center) {
                write_stopless_runtime_control(&mut metadata, stopless);
            }
        }
    } else if !has_terminal_stopless_turn
        && metadata
            .get("runtime_control")
            .and_then(Value::as_object)
            .and_then(|runtime_control| runtime_control.get("stopless"))
            .is_none()
    {
        if let Some(stopless) = clone_stopless_runtime_control_from_snapshot(
            &input.metadata_center_snapshot,
            &metadata_center,
        ) {
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
