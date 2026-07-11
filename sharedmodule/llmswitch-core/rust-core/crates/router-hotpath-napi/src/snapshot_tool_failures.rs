use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

const MAX_TRAILING_TOOL_MESSAGES: usize = 8;

fn read_trimmed(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn clip_text(input: &str, max: usize) -> String {
    let text = input.trim();
    if text.is_empty() {
        return String::new();
    }
    if text.len() <= max {
        text.to_string()
    } else {
        format!("{}...", &text[..max])
    }
}

fn looks_like_tool_output_transcript(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    lower.contains("chunk id:")
        && lower.contains("wall time:")
        && lower.contains("process exited with code")
        && (lower.contains("output:") || lower.contains("original token count:"))
}

fn resolve_exec_command_failure(content: &str) -> Option<(String, String)> {
    let raw = content;
    let lower = raw.to_ascii_lowercase();
    if looks_like_tool_output_transcript(raw) {
        return None;
    }
    if lower.contains("failed to parse function arguments") {
        if lower.contains("missing field `cmd`") {
            return Some((
                "exec_command_args_missing_cmd".to_string(),
                "missing field `cmd`".to_string(),
            ));
        }
        if lower.contains("missing field `input`") {
            return Some((
                "exec_command_args_missing_input".to_string(),
                "missing field `input`".to_string(),
            ));
        }
        return Some((
            "exec_command_args_parse_failed".to_string(),
            clip_text(raw, 320),
        ));
    }
    if let Some(code) = extract_process_exit_code(raw) {
        if code != 0 {
            return Some((
                "exec_command_non_zero_exit".to_string(),
                format!("process exited with code {code}"),
            ));
        }
    }
    if lower.contains("exec_command failed") {
        return Some(("exec_command_failed".to_string(), clip_text(raw, 320)));
    }
    None
}

fn extract_process_exit_code(raw: &str) -> Option<i64> {
    let lower = raw.to_ascii_lowercase();
    let marker = "process exited with code";
    let start = lower.find(marker)? + marker.len();
    let rest = raw.get(start..)?.trim_start();
    let token: String = rest
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '-')
        .collect();
    token.parse::<i64>().ok()
}

fn classify_apply_patch_verification_failure(content: &str) -> (String, String) {
    let raw = content;
    let lower = raw.to_ascii_lowercase();
    let invalid_header_token = extract_invalid_hunk_header_token(raw).unwrap_or_default();
    let invalid_header_lower = invalid_header_token.to_ascii_lowercase();
    if lower.contains("update file hunk for path")
        && (lower.contains("is empty") || lower.contains("missing hunk body"))
    {
        return (
            "apply_patch_empty_update_hunk".to_string(),
            clip_text(raw, 320),
        );
    }
    if lower.contains("unexpected line found in update hunk") && lower.contains("'@@'") {
        return (
            "apply_patch_unexpected_hunk_line".to_string(),
            clip_text(raw, 320),
        );
    }
    if !invalid_header_token.is_empty()
        && invalid_header_token.starts_with("*** ")
        && invalid_header_token.ends_with(" ****")
        && invalid_header_token[4..invalid_header_token.len() - 5]
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch == ',')
    {
        return (
            "apply_patch_legacy_context_diff_hunk_header".to_string(),
            clip_text(raw, 320),
        );
    }
    if !invalid_header_token.is_empty()
        && invalid_header_lower.starts_with("*** update ")
        && !invalid_header_lower.starts_with("*** update file:")
    {
        return (
            "apply_patch_legacy_update_header_missing_file_keyword".to_string(),
            clip_text(raw, 320),
        );
    }
    if !invalid_header_token.is_empty() && invalid_header_lower.starts_with("*** new file:") {
        return (
            "apply_patch_legacy_new_file_header".to_string(),
            clip_text(raw, 320),
        );
    }
    if !invalid_header_token.is_empty() && invalid_header_lower.starts_with("*** start file:") {
        return (
            "apply_patch_legacy_start_file_header".to_string(),
            clip_text(raw, 320),
        );
    }
    if !invalid_header_token.is_empty() && invalid_header_lower == "*** begin patch" {
        return (
            "apply_patch_nested_begin_patch_marker".to_string(),
            clip_text(raw, 320),
        );
    }
    if lower.contains("the first line of the patch must be '*** begin patch'") {
        return (
            "apply_patch_missing_begin_patch_header".to_string(),
            clip_text(raw, 320),
        );
    }
    if lower.contains("the last line of the patch must be '*** end patch'") {
        return (
            "apply_patch_missing_end_header".to_string(),
            clip_text(raw, 320),
        );
    }
    if lower.contains("expected '*** end patch'") || lower.contains("missing end patch") {
        return (
            "apply_patch_missing_end_header".to_string(),
            clip_text(raw, 320),
        );
    }
    if lower.contains("expected update hunk to start with a @@ context marker, got: '=======")
        || lower.contains("expected update hunk to start with a @@ context marker, got: '<<<<<<<")
        || lower.contains("expected update hunk to start with a @@ context marker, got: '>>>>>>>")
    {
        return (
            "apply_patch_conflict_markers_or_merge_chunks".to_string(),
            clip_text(raw, 320),
        );
    }
    if lower.contains("expected update hunk to start with a @@ context marker, got:") {
        return (
            "apply_patch_missing_hunk_context_marker".to_string(),
            clip_text(raw, 320),
        );
    }
    if lower.contains("failed to find context") && lower.contains("@@") {
        return (
            "apply_patch_gnu_line_number_context_not_found".to_string(),
            clip_text(raw, 320),
        );
    }
    if !invalid_header_token.is_empty()
        && (invalid_header_lower.starts_with("--- a/")
            || invalid_header_lower.starts_with("--- /dev/null")
            || invalid_header_lower.starts_with("+++ b/"))
    {
        return (
            "apply_patch_mixed_gnu_diff_inside_begin_patch".to_string(),
            clip_text(raw, 320),
        );
    }
    if lower.contains("failed to find expected lines in ") {
        return (
            "apply_patch_expected_lines_not_found".to_string(),
            clip_text(raw, 320),
        );
    }
    (
        "apply_patch_verification_failed".to_string(),
        clip_text(raw, 320),
    )
}

fn classify_runtime_error_signal_from_text_value(message: &str) -> Option<Value> {
    let raw = message;
    let lower = raw.to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }
    if lower.contains("apply_patch verification failed") {
        let (error_type, matched_text) = classify_apply_patch_verification_failure(raw);
        return Some(json_object(vec![
            ("group", Value::String("exec-error".to_string())),
            ("errorType", Value::String(error_type)),
            ("matchedText", Value::String(matched_text)),
        ]));
    }
    for (needle, error_type) in [
        (
            "apply_patch verification failed",
            "apply_patch_verification_failed",
        ),
        ("followup failed for flow", "followup_execution_failed"),
        ("tool execution failed", "tool_execution_failed"),
    ] {
        if lower.contains(needle) {
            return Some(json_object(vec![
                ("group", Value::String("exec-error".to_string())),
                ("errorType", Value::String(error_type.to_string())),
                ("matchedText", Value::String(needle.to_string())),
            ]));
        }
    }
    for (needle, error_type) in [
        (
            "failed to parse function arguments",
            "tool_args_parse_failed",
        ),
        ("missing field `cmd`", "tool_args_missing_cmd"),
        ("missing field `input`", "tool_args_missing_input"),
        ("missing field `command`", "tool_args_missing_command"),
        ("failed to decode sse payload", "sse_decode_failed"),
        ("upstream sse terminated", "sse_upstream_terminated"),
        ("does not support sse decoding", "sse_protocol_unsupported"),
    ] {
        if lower.contains(needle) {
            return Some(json_object(vec![
                ("group", Value::String("parse-error".to_string())),
                ("errorType", Value::String(error_type.to_string())),
                ("matchedText", Value::String(needle.to_string())),
            ]));
        }
    }
    None
}

fn json_object(entries: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    for (key, value) in entries {
        object.insert(key.to_string(), value);
    }
    Value::Object(object)
}

fn extract_invalid_hunk_header_token(raw: &str) -> Option<String> {
    let lower = raw.to_ascii_lowercase();
    let marker = "invalid hunk at line";
    lower.find(marker).and_then(|idx| {
        let slice = &raw[idx..];
        let first = slice.find('\'')? + 1;
        let rest = &slice[first..];
        let end = rest.find('\'')?;
        Some(rest[..end].trim().to_string())
    })
}

fn resolve_apply_patch_failure(content: &str) -> Option<(String, String)> {
    let raw = content;
    let lower = raw.to_ascii_lowercase();
    if looks_like_tool_output_transcript(raw) {
        return None;
    }
    if lower.contains("failed to parse function arguments") {
        if lower.contains("missing field `input`") {
            return Some((
                "apply_patch_args_missing_input".to_string(),
                "missing field `input`".to_string(),
            ));
        }
        if lower.contains("missing field `patch`") {
            return Some((
                "apply_patch_args_missing_patch".to_string(),
                "missing field `patch`".to_string(),
            ));
        }
        return Some((
            "apply_patch_args_parse_failed".to_string(),
            clip_text(raw, 320),
        ));
    }
    if lower.contains("apply_patch verification failed") || lower.contains("invalid patch") {
        return Some(classify_apply_patch_verification_failure(raw));
    }
    if let Some(code) = extract_process_exit_code(raw) {
        if code != 0 {
            return Some((
                "apply_patch_non_zero_exit".to_string(),
                format!("process exited with code {code}"),
            ));
        }
    }
    if lower.contains("apply_patch failed") {
        return Some(("apply_patch_failed".to_string(), clip_text(raw, 320)));
    }
    None
}

fn resolve_shell_command_failure(content: &str) -> Option<(String, String)> {
    let raw = content;
    let lower = raw.to_ascii_lowercase();
    if looks_like_tool_output_transcript(raw) {
        return None;
    }
    if lower.contains("failed to parse function arguments") {
        if lower.contains("missing field `command`") {
            return Some((
                "shell_command_args_missing_command".to_string(),
                "missing field `command`".to_string(),
            ));
        }
        return Some((
            "shell_command_args_parse_failed".to_string(),
            clip_text(raw, 320),
        ));
    }
    if let Some(code) = extract_process_exit_code(raw) {
        if code != 0 {
            return Some((
                "shell_command_non_zero_exit".to_string(),
                format!("process exited with code {code}"),
            ));
        }
    }
    if lower.contains("shell_command failed") || lower.contains("shell command failed") {
        return Some(("shell_command_failed".to_string(), clip_text(raw, 320)));
    }
    None
}

fn push_array<'a>(candidates: &mut Vec<&'a Vec<Value>>, value: Option<&'a Value>) {
    if let Some(items) = value.and_then(Value::as_array) {
        candidates.push(items);
    }
}

fn collect_tool_messages(payload: &Value) -> Vec<Map<String, Value>> {
    let mut direct_candidates: Vec<&Vec<Value>> = Vec::new();
    push_array(&mut direct_candidates, payload.get("messages"));
    push_array(&mut direct_candidates, payload.get("input"));
    if let Some(payload_record) = payload.as_object() {
        if let Some(nested_payload) = payload_record.get("payload").and_then(Value::as_object) {
            push_array(&mut direct_candidates, nested_payload.get("messages"));
            push_array(&mut direct_candidates, nested_payload.get("input"));
        }
        if let Some(governed_payload) = payload_record
            .get("governedPayload")
            .and_then(Value::as_object)
        {
            push_array(&mut direct_candidates, governed_payload.get("messages"));
            push_array(&mut direct_candidates, governed_payload.get("input"));
        }
    }

    let mut seen_keys = HashSet::<String>::new();
    let mut collected: Vec<Map<String, Value>> = Vec::new();
    for candidate in direct_candidates {
        if candidate.is_empty() {
            continue;
        }
        let mut name_by_id = HashMap::<String, String>::new();
        for row in candidate {
            let Some(record) = row.as_object() else {
                continue;
            };
            let item_type = read_trimmed(record.get("type")).to_ascii_lowercase();
            if item_type != "function_call" && item_type != "function" {
                continue;
            }
            let call_id = first_non_empty(vec![
                record.get("call_id"),
                record.get("tool_call_id"),
                record.get("id"),
            ]);
            let name = read_trimmed(record.get("name")).if_empty_else(|| {
                record
                    .get("function")
                    .and_then(Value::as_object)
                    .map(|f| read_trimmed(f.get("name")))
                    .unwrap_or_default()
            });
            if !call_id.is_empty() && !name.is_empty() {
                name_by_id.insert(call_id, name);
            }
        }
        let mut seen_trailing_tool = 0usize;
        for row in candidate.iter().rev() {
            let Some(record) = row.as_object() else {
                if seen_trailing_tool > 0 {
                    break;
                }
                continue;
            };
            let role = read_trimmed(record.get("role")).to_ascii_lowercase();
            let name = read_trimmed(record.get("name")).to_ascii_lowercase();
            let content = read_trimmed(record.get("content"));
            let item_type = read_trimmed(record.get("type")).to_ascii_lowercase();
            if !role.is_empty() && role != "tool" {
                break;
            }
            if role == "tool" && !name.is_empty() && !content.is_empty() {
                seen_trailing_tool += 1;
                let key = serde_json::to_string(record).unwrap_or_default();
                if seen_keys.insert(key) {
                    collected.insert(0, record.clone());
                }
                if seen_trailing_tool >= MAX_TRAILING_TOOL_MESSAGES {
                    break;
                }
                continue;
            }
            if matches!(
                item_type.as_str(),
                "function_call_output" | "tool_result" | "tool_message"
            ) {
                let call_id =
                    first_non_empty(vec![record.get("call_id"), record.get("tool_call_id")]);
                let output = first_non_empty(vec![record.get("output"), record.get("content")]);
                let resolved_name = if !call_id.is_empty() {
                    name_by_id.get(&call_id).cloned().unwrap_or_default()
                } else {
                    String::new()
                }
                .if_empty_else(|| read_trimmed(record.get("name")))
                .if_empty_else(|| read_trimmed(record.get("tool_name")));
                if !resolved_name.is_empty() && !output.is_empty() {
                    seen_trailing_tool += 1;
                    let mut synthetic = Map::new();
                    synthetic.insert("role".to_string(), Value::String("tool".to_string()));
                    synthetic.insert("name".to_string(), Value::String(resolved_name));
                    synthetic.insert("content".to_string(), Value::String(output));
                    if !call_id.is_empty() {
                        synthetic
                            .insert("tool_call_id".to_string(), Value::String(call_id.clone()));
                        synthetic.insert("call_id".to_string(), Value::String(call_id));
                    }
                    collected.insert(0, synthetic);
                    if seen_trailing_tool >= MAX_TRAILING_TOOL_MESSAGES {
                        break;
                    }
                    continue;
                }
            }
            if item_type == "function_call" || item_type == "function" {
                if seen_trailing_tool > 0 {
                    continue;
                }
                break;
            }
            if !item_type.is_empty() || seen_trailing_tool > 0 {
                break;
            }
        }
    }
    collected
}

fn first_non_empty(values: Vec<Option<&Value>>) -> String {
    for value in values {
        let text = read_trimmed(value);
        if !text.is_empty() {
            return text;
        }
    }
    String::new()
}

trait IfEmptyElse {
    fn if_empty_else<F: FnOnce() -> String>(self, fallback: F) -> String;
}
impl IfEmptyElse for String {
    fn if_empty_else<F: FnOnce() -> String>(self, fallback: F) -> String {
        if self.is_empty() {
            fallback()
        } else {
            self
        }
    }
}

pub fn detect_tool_execution_failures_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut failures: Vec<Value> = Vec::new();
    let mut dedup = HashSet::<String>::new();
    for msg in collect_tool_messages(&payload) {
        let raw_tool_name = read_trimmed(msg.get("name")).to_ascii_lowercase();
        let tool_name = match raw_tool_name.as_str() {
            "shell" | "bash" | "terminal" => "shell_command".to_string(),
            other => other.to_string(),
        };
        if !matches!(
            tool_name.as_str(),
            "exec_command" | "apply_patch" | "shell_command"
        ) {
            continue;
        }
        let content = read_trimmed(msg.get("content"));
        let resolved = match tool_name.as_str() {
            "exec_command" => resolve_exec_command_failure(&content),
            "apply_patch" => resolve_apply_patch_failure(&content),
            _ => resolve_shell_command_failure(&content),
        };
        let Some((error_type, matched_text)) = resolved else {
            continue;
        };
        let tool_call_id = read_trimmed(msg.get("tool_call_id"));
        let call_id = read_trimmed(msg.get("call_id"));
        let key = format!(
            "{}|{}|{}|{}|{}",
            tool_name, error_type, matched_text, tool_call_id, call_id
        );
        if !dedup.insert(key) {
            continue;
        }
        let mut row = Map::new();
        row.insert("toolName".to_string(), Value::String(tool_name));
        row.insert("errorType".to_string(), Value::String(error_type));
        row.insert("matchedText".to_string(), Value::String(matched_text));
        if !tool_call_id.is_empty() {
            row.insert("toolCallId".to_string(), Value::String(tool_call_id));
        }
        if !call_id.is_empty() {
            row.insert("callId".to_string(), Value::String(call_id));
        }
        failures.push(Value::Object(row));
    }
    serde_json::to_string(&Value::Array(failures))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn classify_runtime_error_signal_from_text_json(
    _stage: String,
    message: String,
) -> NapiResult<String> {
    let value = classify_runtime_error_signal_from_text_value(&message).unwrap_or(Value::Null);
    serde_json::to_string(&value).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn should_log_client_tool_error_to_console_json(failure_json: String) -> NapiResult<bool> {
    let failure: Value =
        serde_json::from_str(&failure_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let Some(record) = failure.as_object() else {
        return Ok(false);
    };
    let tool_name = read_trimmed(record.get("toolName"));
    let error_type = read_trimmed(record.get("errorType"));
    Ok(match tool_name.as_str() {
        "apply_patch" => matches!(
            error_type.as_str(),
            "apply_patch_args_missing_input"
                | "apply_patch_args_missing_patch"
                | "apply_patch_args_parse_failed"
        ),
        "exec_command" => matches!(
            error_type.as_str(),
            "exec_command_args_missing_cmd"
                | "exec_command_args_missing_input"
                | "exec_command_args_parse_failed"
        ),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detects_exec_command_non_zero_exit_from_tool_message() {
        let payload = json!({"messages":[{"role":"tool","name":"exec_command","tool_call_id":"call_1","call_id":"call_1","content":"Chunk ID: test\nProcess exited with code 2\nOutput: denied"}]});
        let raw = detect_tool_execution_failures_json(payload.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed[0]["toolName"], "exec_command");
        assert_eq!(parsed[0]["errorType"], "exec_command_non_zero_exit");
    }

    #[test]
    fn ignores_successful_transcript_noise() {
        let payload = json!({"messages":[{"role":"tool","name":"exec_command","content":"Chunk ID: f9\nWall time: 0.0000 seconds\nProcess exited with code 0\nOutput:\nfailed to parse function arguments: missing field `cmd`"}]});
        let raw = detect_tool_execution_failures_json(payload.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 0);
    }

    #[test]
    fn detects_responses_function_call_output_by_call_id() {
        let payload = json!({"input":[{"type":"function_call","call_id":"call_a","name":"apply_patch"},{"type":"function_call_output","call_id":"call_a","output":"failed to parse function arguments: missing field `input`"}]});
        let raw = detect_tool_execution_failures_json(payload.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed[0]["toolName"], "apply_patch");
        assert_eq!(parsed[0]["errorType"], "apply_patch_args_missing_input");
    }

    #[test]
    fn classifies_runtime_apply_patch_verification_text() {
        let raw = classify_runtime_error_signal_from_text_json(
            "provider.send".to_string(),
            "apply_patch verification failed: Failed to find expected lines in src/main.rs"
                .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["group"], "exec-error");
        assert_eq!(parsed["errorType"], "apply_patch_expected_lines_not_found");
    }

    #[test]
    fn ignores_runtime_text_without_known_failure_signal() {
        let raw = classify_runtime_error_signal_from_text_json(
            "provider.send".to_string(),
            "ordinary provider response".to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert!(parsed.is_null());
    }

    #[test]
    fn decides_client_tool_console_logging_from_native_truth() {
        assert!(should_log_client_tool_error_to_console_json(
            json!({"toolName":"exec_command","errorType":"exec_command_args_missing_cmd"})
                .to_string()
        )
        .unwrap());
        assert!(!should_log_client_tool_error_to_console_json(
            json!({"toolName":"exec_command","errorType":"exec_command_non_zero_exit"}).to_string()
        )
        .unwrap());
    }
}
