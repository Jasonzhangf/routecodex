use serde_json::Value;

pub(crate) fn drop_v3_client_tool_error_pairs_at_req04(input: &mut Vec<Value>) -> usize {
    let mut next = Vec::with_capacity(input.len());
    let mut index = 0;
    let mut dropped = 0;
    while index < input.len() {
        if is_v3_client_tool_error_pair_at_req04(input, index) {
            index += 2;
            dropped += 1;
            continue;
        }
        if is_v3_client_tool_error_output_at_req04(&input[index]) {
            index += 1;
            dropped += 1;
            continue;
        }
        next.push(input[index].clone());
        index += 1;
    }
    *input = next;
    dropped
}

pub(crate) fn is_v3_client_tool_error_pair_at_req04(input: &[Value], call_index: usize) -> bool {
    let Some(call) = input.get(call_index) else {
        return false;
    };
    if !is_v3_non_stopless_tool_call_at_req04(call) {
        return false;
    }
    let Some(output) = input.get(call_index.saturating_add(1)) else {
        return false;
    };
    if !is_v3_client_tool_error_output_at_req04(output) {
        return false;
    }
    let call_id = call
        .get("call_id")
        .or_else(|| call.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let output_call_id = output
        .get("call_id")
        .or_else(|| output.get("tool_call_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    call_id.is_some() && call_id == output_call_id
}

pub(crate) fn is_v3_client_tool_error_output_at_req04(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call_output" | "custom_tool_call_output" | "tool_call_output")
    ) && v3_tool_output_text_at_req04(item).is_some_and(is_v3_client_tool_error_text_at_req04)
}

fn is_v3_non_stopless_tool_call_at_req04(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call" | "custom_tool_call" | "tool_call")
    ) && !is_v3_stopless_cli_call_at_req04(item)
}

fn is_v3_stopless_cli_call_at_req04(item: &Value) -> bool {
    item.get("call_id")
        .and_then(Value::as_str)
        .is_some_and(|call_id| call_id == "call_stopless_reasoning")
        || item
            .get("arguments")
            .or_else(|| item.get("input"))
            .and_then(Value::as_str)
            .is_some_and(|value| value.contains("routecodex hook run reasoningStop"))
}

fn v3_tool_output_text_at_req04(item: &Value) -> Option<&str> {
    item.get("output")
        .or_else(|| item.get("content"))
        .and_then(Value::as_str)
}

fn is_v3_client_tool_error_text_at_req04(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("failed to parse function arguments") || lower.contains("unsupported call:")
}
