// feature_id: hub.servertool_stopless_cli_continuation

use serde_json::{Map, Value};

pub(crate) const STOPLESS_TRANSPARENT_CONTINUATION_PROMPT: &str = "继续处理当前任务：先依据已有上下文判断目标是否已完成。未完成时，识别完成目标所必需的事项，按重要性和依赖顺序直接依次执行，从当前最重要且可执行的下一步继续；不要重复已完成内容，也不要因为非关键偏好、实现细节、可自主判断的选择，或询问用户“是否继续”而停止。只要存在能够自主执行且有助于完成目标的下一步，就直接执行，不要请求继续许可。只有确实缺少会影响目标、权限、实际成本或不可逆风险的用户专属决策时，才暂停并提出一个具体、可回答的问题。已完成则按系统合同收口。";

pub(crate) fn is_stopless_transparent_continuation_prompt(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed == STOPLESS_TRANSPARENT_CONTINUATION_PROMPT || trimmed == "继续执行"
}

pub(crate) fn is_stopless_internal_tool_name(raw_name: &str) -> bool {
    matches!(
        raw_name.trim().to_ascii_lowercase().as_str(),
        "reasoningstop" | "reasoning_stop" | "stop_message_auto"
    )
}

pub(crate) fn build_stop_hook_guidance_text_from_output(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(row) = parse_stopless_tool_output_payload(&Value::String(trimmed.to_string())) {
        if is_stopless_tool_output_record(&row) {
            if let Some(prompt) = read_continue_next_step_prompt(&row) {
                return prompt;
            }
            return STOPLESS_TRANSPARENT_CONTINUATION_PROMPT.to_string();
        }
    }
    trimmed.to_string()
}

fn parse_stopless_tool_output_payload(value: &Value) -> Option<Map<String, Value>> {
    match value {
        Value::Object(row) => Some(row.clone()),
        Value::String(text) => serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|parsed| parsed.as_object().cloned()),
        _ => None,
    }
}

fn is_stopless_tool_output_record(row: &Map<String, Value>) -> bool {
    let tool_name = read_trimmed_string(row.get("toolName"))
        .or_else(|| read_trimmed_string(row.get("tool_name")))
        .or_else(|| read_trimmed_string(row.get("tool")))
        .or_else(|| read_trimmed_string(row.get("kind")));
    if tool_name.as_deref() == Some("stop_message_auto") {
        return true;
    }
    read_trimmed_string(row.get("flowId"))
        .or_else(|| read_trimmed_string(row.get("flow_id")))
        .is_some_and(|flow_id| flow_id == "stop_message_flow")
        && (row.contains_key("continuationPrompt")
            || row.contains_key("continuation_prompt")
            || row.contains_key("repeatCount")
            || row.contains_key("repeat_count")
            || row.contains_key("schemaFeedback")
            || row.contains_key("schema_feedback")
            || row.contains_key("schemaGuidance")
            || row.contains_key("schema_guidance"))
}

fn read_continue_next_step_prompt(row: &Map<String, Value>) -> Option<String> {
    let feedback = row
        .get("schemaFeedback")
        .or_else(|| row.get("schema_feedback"))?
        .as_object()?;
    let reason_code = read_trimmed_string(feedback.get("reasonCode"))
        .or_else(|| read_trimmed_string(feedback.get("reason_code")))?;
    if reason_code != "stop_schema_continue_next_step" {
        return None;
    }
    read_trimmed_string(row.get("continuationPrompt"))
        .or_else(|| read_trimmed_string(row.get("continuation_prompt")))
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[derive(Debug, PartialEq)]
pub(crate) enum StoplessCurrentTurnScan<T> {
    Evidence(T),
    ResetByUserTurn,
    None,
}

pub(crate) fn scan_stopless_current_turn_items<T>(
    items: Option<&Value>,
    inspect: impl FnMut(&Map<String, Value>) -> Option<T>,
) -> StoplessCurrentTurnScan<T> {
    let Some(items) = items.and_then(Value::as_array) else {
        return StoplessCurrentTurnScan::None;
    };
    scan_stopless_current_turn_slice(items, inspect)
}

pub(crate) fn scan_stopless_current_turn_slice<T>(
    items: &[Value],
    mut inspect: impl FnMut(&Map<String, Value>) -> Option<T>,
) -> StoplessCurrentTurnScan<T> {
    for item in items.iter().rev() {
        let Some(row) = item.as_object() else {
            continue;
        };
        if let Some(evidence) = inspect(row) {
            return StoplessCurrentTurnScan::Evidence(evidence);
        }
        if row
            .get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| role.trim().eq_ignore_ascii_case("user"))
        {
            return StoplessCurrentTurnScan::ResetByUserTurn;
        }
    }
    StoplessCurrentTurnScan::None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inspect_marker(row: &Map<String, Value>) -> Option<String> {
        row.get("marker")
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    #[test]
    fn latest_real_user_turn_cuts_off_older_stopless_evidence() {
        let items = json!([
            { "type": "function_call_output", "marker": "stale" },
            { "type": "message", "role": "user", "content": "new task" }
        ]);
        assert_eq!(
            scan_stopless_current_turn_items(Some(&items), inspect_marker),
            StoplessCurrentTurnScan::ResetByUserTurn
        );
    }

    #[test]
    fn current_stopless_output_after_user_turn_is_evidence() {
        let items = json!([
            { "type": "message", "role": "user", "content": "task" },
            { "type": "function_call_output", "marker": "current" }
        ]);
        assert_eq!(
            scan_stopless_current_turn_items(Some(&items), inspect_marker),
            StoplessCurrentTurnScan::Evidence("current".to_string())
        );
    }
}
