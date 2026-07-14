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
