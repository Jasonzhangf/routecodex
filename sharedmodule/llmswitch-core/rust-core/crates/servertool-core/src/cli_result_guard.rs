//! Rust-owned recognition for migrated servertool CLI result returns.

use crate::cli_contract;
use serde_json::{Map, Value};

const ROUTECODEX_STOP_MESSAGE_AUTO_CLI: &str = "routecodex hook run stop_message_auto";
const ROUTECODEX_REASONING_STOP_CLI: &str = "routecodex hook run reasoning_stop";
const MAX_SCAN_DEPTH: usize = 10;
const MAX_SCAN_NODES: usize = 2000;

pub fn has_stop_message_auto_cli_result_in_request(payload: &Value) -> bool {
    let mut seen = 0usize;
    for root in collect_scan_roots(payload) {
        if scan_value(root, 0, &mut seen) {
            return true;
        }
    }
    false
}

pub fn extract_servertool_cli_result_route_hint_from_request(payload: &Value) -> Option<String> {
    let mut seen = 0usize;
    for root in collect_scan_roots(payload) {
        if let Some(route_hint) = scan_value_for_route_hint(root, 0, &mut seen) {
            return Some(route_hint);
        }
    }
    None
}

fn collect_scan_roots(payload: &Value) -> Vec<&Value> {
    let adapter = payload.get("adapterContext").and_then(Value::as_object);
    let runtime = payload.get("runtimeMetadata").and_then(Value::as_object);
    let responses_context = adapter
        .and_then(|record| record.get("responsesRequestContext"))
        .and_then(Value::as_object)
        .or_else(|| {
            runtime
                .and_then(|record| record.get("responsesRequestContext"))
                .and_then(Value::as_object)
        });

    [
        adapter.and_then(|record| record.get("__raw_request_body")),
        adapter.and_then(|record| record.get("capturedChatRequest")),
        responses_context.and_then(|record| record.get("payload")),
        responses_context.and_then(|record| record.get("context")),
        runtime.and_then(|record| record.get("capturedChatRequest")),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn scan_value(value: &Value, depth: usize, seen: &mut usize) -> bool {
    if depth > MAX_SCAN_DEPTH {
        return false;
    }
    *seen += 1;
    if *seen > MAX_SCAN_NODES {
        return false;
    }
    if is_stop_message_auto_cli_result_object(value) {
        return true;
    }
    if let Some(items) = value.as_array() {
        return items.iter().any(|item| scan_value(item, depth + 1, seen));
    }
    let Some(record) = value.as_object() else {
        return false;
    };
    record
        .values()
        .any(|item| scan_value(item, depth + 1, seen))
}

fn scan_value_for_route_hint(value: &Value, depth: usize, seen: &mut usize) -> Option<String> {
    if depth > MAX_SCAN_DEPTH {
        return None;
    }
    *seen += 1;
    if *seen > MAX_SCAN_NODES {
        return None;
    }
    if let Some(route_hint) = extract_route_hint_from_value(value) {
        return Some(route_hint);
    }
    if let Some(items) = value.as_array() {
        for item in items {
            if let Some(route_hint) = scan_value_for_route_hint(item, depth + 1, seen) {
                return Some(route_hint);
            }
        }
        return None;
    }
    let Some(record) = value.as_object() else {
        return None;
    };
    for item in record.values() {
        if let Some(route_hint) = scan_value_for_route_hint(item, depth + 1, seen) {
            return Some(route_hint);
        }
    }
    None
}

fn is_stop_message_auto_cli_result_object(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    if !is_tool_result_like(record) {
        return false;
    }
    text_contains_stop_message_auto_cli_result(&read_result_text(record))
}

fn is_tool_result_like(record: &Map<String, Value>) -> bool {
    let kind = |key: &str| {
        record
            .get(key)
            .and_then(Value::as_str)
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_default()
    };
    let type_value = kind("type");
    let role = kind("role");
    type_value == "function_call_output"
        || type_value == "tool_result"
        || type_value == "tool_message"
        || role == "tool"
        || record.contains_key("call_id")
        || record.contains_key("tool_call_id")
}

fn read_result_text(record: &Map<String, Value>) -> String {
    let mut parts = Vec::<String>::new();
    for key in ["output", "content", "text", "arguments"] {
        collect_text(record.get(key), &mut parts);
    }
    let tool = record.get("tool").and_then(Value::as_str);
    let kind = record.get("kind").and_then(Value::as_str);
    if tool.is_some() || kind.is_some() {
        let mut marker = Map::<String, Value>::new();
        if let Some(tool) = tool {
            marker.insert("tool".to_string(), Value::String(tool.to_string()));
        }
        if let Some(kind) = kind {
            marker.insert("kind".to_string(), Value::String(kind.to_string()));
        }
        if let Ok(text) = serde_json::to_string(&Value::Object(marker)) {
            parts.push(text);
        }
    }
    parts.join("\n")
}

fn collect_text(value: Option<&Value>, out: &mut Vec<String>) {
    match value {
        Some(Value::String(text)) => out.push(text.clone()),
        Some(Value::Array(items)) => {
            for item in items {
                collect_text(Some(item), out);
            }
        }
        Some(Value::Object(record)) => {
            collect_text(record.get("text"), out);
            collect_text(record.get("output_text"), out);
            collect_text(record.get("content"), out);
        }
        _ => {}
    }
}

fn text_contains_stop_message_auto_cli_result(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.contains(ROUTECODEX_STOP_MESSAGE_AUTO_CLI)
        || trimmed.contains(ROUTECODEX_REASONING_STOP_CLI)
    {
        return true;
    }
    for candidate in parse_json_object_candidates(trimmed) {
        if cli_contract::validate_client_exec_command_result(&candidate.to_string()).is_ok() {
            return true;
        }
    }
    false
}

fn extract_route_hint_from_value(value: &Value) -> Option<String> {
    let record = value.as_object()?;
    if let Some(route_hint) = read_route_hint_like(record.get("routeHint")) {
        return Some(route_hint);
    }
    if let Some(route_hint) = read_route_hint_like(record.get("route_hint")) {
        return Some(route_hint);
    }
    let text = read_result_text(record);
    if text.trim().is_empty() {
        return None;
    }
    for candidate in parse_json_object_candidates(&text) {
        let Some(candidate_record) = candidate.as_object() else {
            continue;
        };
        if let Some(route_hint) = read_route_hint_like(candidate_record.get("routeHint")) {
            return Some(route_hint);
        }
        if let Some(route_hint) = read_route_hint_like(candidate_record.get("route_hint")) {
            return Some(route_hint);
        }
    }
    None
}

fn read_route_hint_like(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_json_object_candidates(text: &str) -> Vec<Value> {
    let mut candidates = Vec::<&str>::new();
    candidates.push(text);
    let first_brace = text.find('{');
    let last_brace = text.rfind('}');
    if let (Some(start), Some(end)) = (first_brace, last_brace) {
        if end > start {
            candidates.push(&text[start..=end]);
        }
    }

    let mut out = Vec::<Value>::new();
    for candidate in candidates {
        let Ok(parsed) = serde_json::from_str::<Value>(candidate) else {
            continue;
        };
        if parsed.is_object() {
            out.push(parsed);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detects_stop_message_auto_cli_json_output_in_raw_request() {
        let payload = json!({
            "adapterContext": {
                "__raw_request_body": {
                    "input": [{
                        "type": "function_call_output",
                        "call_id": "call_servertool",
                        "output": "{\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\"}"
                    }]
                }
            }
        });

        assert!(has_stop_message_auto_cli_result_in_request(&payload));
    }

    #[test]
    fn detects_stop_message_auto_command_marker_in_nested_content() {
        let payload = json!({
            "runtimeMetadata": {
                "responsesRequestContext": {
                    "payload": {
                        "messages": [{
                            "role": "tool",
                            "content": [{
                                "text": "routecodex hook run reasoning_stop --input-json '{}' --session-id 'session-a' --request-id 'req-a'"
                            }]
                        }]
                    }
                }
            }
        });

        assert!(has_stop_message_auto_cli_result_in_request(&payload));
    }

    #[test]
    fn ignores_non_tool_like_marker_text() {
        let payload = json!({
            "adapterContext": {
                "__raw_request_body": {
                    "messages": [{
                        "role": "user",
                        "content": "routecodex hook run reasoning_stop --input-json '{}' --session-id 'session-a' --request-id 'req-a'"
                    }]
                }
            }
        });

        assert!(!has_stop_message_auto_cli_result_in_request(&payload));
    }

    #[test]
    fn rejects_web_search_cli_result_json() {
        let payload = json!({
            "adapterContext": {
                "capturedChatRequest": {
                    "messages": [{
                        "role": "tool",
                        "content": "{\"toolName\":\"web_search\",\"flowId\":\"stop_message_flow\"}"
                    }]
                }
            }
        });

        assert!(!has_stop_message_auto_cli_result_in_request(&payload));
    }
}
