use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};

const MAX_TRAILING_TOOL_MESSAGES: usize = 8;
const MAX_RUNTIME_SIGNAL_SCAN_STEPS: usize = 1200;

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

fn is_likely_content_path(path: &[String]) -> bool {
    path.iter().any(|segment| {
        matches!(
            segment.as_str(),
            "message"
                | "content"
                | "contents"
                | "text"
                | "messages"
                | "tool_calls"
                | "function"
                | "arguments"
                | "call_id"
                | "input"
                | "output"
                | "reasoning"
                | "summary"
                | "excerpt"
                | "observation"
        )
    })
}

fn should_skip_runtime_signal_path(path: &[String]) -> bool {
    is_likely_content_path(path) || path.iter().any(|segment| segment.starts_with("trace"))
}

fn collect_runtime_signal_texts(payload: &Value) -> Vec<String> {
    let mut candidates = Vec::<String>::new();
    let mut queue = VecDeque::from([(payload, Vec::<String>::new())]);
    let mut steps = 0usize;

    while let Some((value, path)) = queue.pop_front() {
        if steps >= MAX_RUNTIME_SIGNAL_SCAN_STEPS {
            break;
        }
        steps += 1;
        match value {
            Value::String(text) => {
                if !should_skip_runtime_signal_path(&path) {
                    candidates.push(text.clone());
                }
            }
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    let mut child_path = path.clone();
                    child_path.push(index.to_string());
                    queue.push_back((item, child_path));
                }
            }
            Value::Object(record) => {
                for (key, child) in record.iter() {
                    if key == "error"
                        || key == "message"
                        || key == "reason"
                        || key == "detail"
                        || key == "details"
                        || key == "statusText"
                        || key == "failure"
                        || key == "failureReason"
                        || key.ends_with("Error")
                        || key.ends_with("Reason")
                        || key.ends_with("Message")
                        || key.ends_with("Detail")
                    {
                        let mut child_path = path.clone();
                        child_path.push(key.clone());
                        queue.push_back((child, child_path));
                    }
                }
            }
            _ => {}
        }
    }

    candidates
}

fn has_direct_runtime_error_hint(payload: &Value) -> bool {
    let Some(record) = payload.as_object() else {
        return false;
    };
    ["error", "message", "reason"].iter().any(|key| {
        record
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
    })
}

fn should_inspect_runtime_error_value(stage: &str, payload: &Value) -> bool {
    if stage == "chat_process.resp.stage1.sse_decode" {
        return true;
    }
    if (stage.starts_with("chat_process.req.") || stage.starts_with("chat_process.resp."))
        && (stage.contains("format_parse")
            || stage.contains("semantic_map")
            || stage.contains("format_build")
            || stage.contains("tool_governance"))
    {
        return true;
    }
    if stage.contains("tool_governance") {
        return true;
    }
    if stage.starts_with("servertool.") || stage.starts_with("hub_followup.") {
        return true;
    }
    has_direct_runtime_error_hint(payload)
}

fn read_direct_runtime_error_hint(payload: &Value) -> String {
    let Some(record) = payload.as_object() else {
        return String::new();
    };
    for key in ["error", "message", "reason", "detail", "failureReason"] {
        let value = record.get(key);
        let text = read_trimmed(value);
        if !text.is_empty() {
            return text;
        }
        if let Some(row) = value.and_then(Value::as_object) {
            for nested_key in ["message", "error", "reason", "detail"] {
                let nested = read_trimmed(row.get(nested_key));
                if !nested.is_empty() {
                    return nested;
                }
            }
        }
    }
    String::new()
}

fn should_inspect_runtime_error_fast_value(stage: &str, payload: &Value) -> bool {
    if !should_inspect_runtime_error_value(stage, payload) {
        return false;
    }
    let stage_lower = stage.to_ascii_lowercase();
    stage_lower.contains("error")
        || stage_lower.contains("fail")
        || !read_direct_runtime_error_hint(payload).is_empty()
}

fn should_inspect_tool_failures_value(stage: &str) -> bool {
    !stage.is_empty()
        && (stage.starts_with("chat_process.req.")
            || stage.starts_with("chat_process.resp.")
            || stage.starts_with("hub_followup.")
            || stage.starts_with("servertool."))
}

fn clip_preview_text(input: &str, max: usize) -> String {
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

fn summarize_content_text(value: &Value, max: usize) -> String {
    match value {
        Value::String(text) => clip_preview_text(text, max),
        Value::Array(items) => {
            let mut parts: Vec<String> = Vec::new();
            for item in items.iter().take(3) {
                if let Some(row) = item.as_object() {
                    for key in ["text", "output_text", "input_text"] {
                        let text = read_trimmed(row.get(key));
                        if !text.is_empty() {
                            parts.push(clip_preview_text(&text, max / 2));
                        }
                    }
                    let nested = row
                        .get("content")
                        .map(|content| summarize_content_text(content, max / 2))
                        .unwrap_or_default();
                    if !nested.is_empty() {
                        parts.push(nested);
                    }
                    if parts.len() >= 3 {
                        break;
                    }
                } else if let Some(text) = item.as_str() {
                    parts.push(clip_preview_text(text, max / 2));
                }
            }
            clip_preview_text(
                &parts
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<String>>()
                    .join(" | "),
                max,
            )
        }
        Value::Object(row) => {
            let role = read_trimmed(row.get("role"));
            let item_type = read_trimmed(row.get("type"));
            let name = read_trimmed(row.get("name"));
            let tool_name = read_trimmed(row.get("tool_name"));
            let text = row
                .get("content")
                .map(|content| summarize_content_text(content, max / 2))
                .filter(|text| !text.is_empty())
                .or_else(|| {
                    row.get("text")
                        .map(|value| summarize_content_text(value, max / 2))
                        .filter(|text| !text.is_empty())
                })
                .or_else(|| {
                    row.get("input")
                        .map(|value| summarize_content_text(value, max / 2))
                        .filter(|text| !text.is_empty())
                })
                .or_else(|| {
                    row.get("output_text")
                        .map(|value| summarize_content_text(value, max / 2))
                        .filter(|text| !text.is_empty())
                })
                .or_else(|| {
                    row.get("input_text")
                        .map(|value| summarize_content_text(value, max / 2))
                        .filter(|text| !text.is_empty())
                })
                .unwrap_or_default();
            let prefix = [
                role,
                item_type,
                if name.is_empty() { tool_name } else { name },
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<String>>()
            .join("/");
            if prefix.is_empty() {
                clip_preview_text(&text, max)
            } else if text.is_empty() {
                clip_preview_text(&format!("{prefix}:-"), max)
            } else {
                clip_preview_text(&format!("{prefix}:{text}"), max)
            }
        }
        _ => String::new(),
    }
}

fn summarize_tail(value: Option<&Value>, max: usize) -> String {
    let Some(value) = value else {
        return String::new();
    };
    match value {
        Value::String(text) => clip_preview_text(text, max),
        Value::Array(items) => {
            let start = items.len().saturating_sub(2);
            let parts = items
                .iter()
                .skip(start)
                .map(|item| summarize_content_text(item, max / 2))
                .filter(|part| !part.is_empty())
                .collect::<Vec<String>>();
            clip_preview_text(&parts.join(" || "), max)
        }
        _ => summarize_content_text(value, max),
    }
}

fn resolve_request_tail_summary_value(stage: &str, payload: &Value) -> Value {
    let Some(record) = payload.as_object() else {
        return Value::Null;
    };
    let messages_preview = summarize_tail(record.get("messages"), 3200);
    if !messages_preview.is_empty() {
        return json_object(vec![
            ("stage", Value::String(stage.to_string())),
            (
                "preview",
                Value::String(format!("messages_tail={messages_preview}")),
            ),
        ]);
    }
    let input_preview = summarize_tail(record.get("input"), 3200);
    if !input_preview.is_empty() {
        return json_object(vec![
            ("stage", Value::String(stage.to_string())),
            (
                "preview",
                Value::String(format!("input_tail={input_preview}")),
            ),
        ]);
    }
    let nested_payload = record.get("payload").and_then(Value::as_object);
    if let Some(nested) = nested_payload {
        let nested_messages_preview = summarize_tail(nested.get("messages"), 3200);
        if !nested_messages_preview.is_empty() {
            return json_object(vec![
                ("stage", Value::String(stage.to_string())),
                (
                    "preview",
                    Value::String(format!("payload.messages_tail={nested_messages_preview}")),
                ),
            ]);
        }
        let nested_input_preview = summarize_tail(nested.get("input"), 3200);
        if !nested_input_preview.is_empty() {
            return json_object(vec![
                ("stage", Value::String(stage.to_string())),
                (
                    "preview",
                    Value::String(format!("payload.input_tail={nested_input_preview}")),
                ),
            ]);
        }
    }
    Value::Null
}

fn read_optional_string(record: &Map<String, Value>, key: &str) -> Option<Value> {
    let text = read_trimmed(record.get(key));
    if text.is_empty() {
        None
    } else {
        Some(Value::String(text))
    }
}

fn summarize_client_tool_observation_value(payload: &Value, failures: &Value) -> Value {
    let top_level_keys = payload
        .as_object()
        .map(|record| {
            record
                .keys()
                .take(20)
                .map(|key| Value::String(key.clone()))
                .collect::<Vec<Value>>()
        })
        .unwrap_or_default();
    let failure_rows = failures.as_array().cloned().unwrap_or_default();
    let failure_count = failure_rows.len();
    let tail_start = failure_count.saturating_sub(4);
    let failures_tail = failure_rows
        .iter()
        .skip(tail_start)
        .filter_map(Value::as_object)
        .map(|failure| {
            let mut row = Map::new();
            if let Some(value) = read_optional_string(failure, "toolName") {
                row.insert("toolName".to_string(), value);
            }
            if let Some(value) = read_optional_string(failure, "errorType") {
                row.insert("errorType".to_string(), value);
            }
            if let Some(value) = read_optional_string(failure, "toolCallId") {
                row.insert("toolCallId".to_string(), value);
            }
            if let Some(value) = read_optional_string(failure, "callId") {
                row.insert("callId".to_string(), value);
            }
            row.insert(
                "matchedPreview".to_string(),
                Value::String(clip_text(&read_trimmed(failure.get("matchedText")), 180)),
            );
            Value::Object(row)
        })
        .collect::<Vec<Value>>();
    let tool_messages = failure_rows
        .iter()
        .skip(tail_start)
        .filter_map(Value::as_object)
        .map(|failure| {
            let mut row = Map::new();
            if let Some(value) = read_optional_string(failure, "toolName") {
                row.insert("name".to_string(), value);
            }
            if let Some(value) = read_optional_string(failure, "toolCallId") {
                row.insert("tool_call_id".to_string(), value);
            }
            if let Some(value) = read_optional_string(failure, "callId") {
                row.insert("call_id".to_string(), value);
            }
            row.insert(
                "contentPreview".to_string(),
                Value::String(clip_text(&read_trimmed(failure.get("matchedText")), 180)),
            );
            Value::Object(row)
        })
        .collect::<Vec<Value>>();

    json_object(vec![
        ("topLevelKeys", Value::Array(top_level_keys)),
        ("failureCount", Value::from(failure_count as u64)),
        ("toolMessageCount", Value::from(failure_count as u64)),
        ("failures", Value::Array(failures_tail)),
        ("toolMessages", Value::Array(tool_messages)),
    ])
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

pub fn classify_runtime_error_signal_json(
    stage: String,
    payload_json: String,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    if stage == "chat_process.resp.stage1.sse_decode" {
        let decoded = payload.get("decoded").and_then(Value::as_bool);
        let err = payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if decoded == Some(false) && !err.is_empty() {
            let value = json_object(vec![
                ("group", Value::String("parse-error".to_string())),
                ("errorType", Value::String("sse_decode_error".to_string())),
                ("matchedText", Value::String(err)),
            ]);
            return serde_json::to_string(&value)
                .map_err(|e| napi::Error::from_reason(e.to_string()));
        }
    }

    for candidate in collect_runtime_signal_texts(&payload) {
        if let Some(value) = classify_runtime_error_signal_from_text_value(&candidate) {
            return serde_json::to_string(&value)
                .map_err(|e| napi::Error::from_reason(e.to_string()));
        }
    }

    Ok("null".to_string())
}

pub fn should_inspect_runtime_error_fast_json(
    stage: String,
    payload_json: String,
) -> NapiResult<bool> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(should_inspect_runtime_error_fast_value(&stage, &payload))
}

pub fn should_inspect_tool_failures_json(stage: String) -> NapiResult<bool> {
    Ok(should_inspect_tool_failures_value(&stage))
}

pub fn resolve_request_tail_summary_json(
    stage: String,
    payload_json: String,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    serde_json::to_string(&resolve_request_tail_summary_value(&stage, &payload))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn summarize_client_tool_observation_json(
    payload_json: String,
    failures_json: String,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let failures: Value = serde_json::from_str(&failures_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    serde_json::to_string(&summarize_client_tool_observation_value(
        &payload, &failures,
    ))
    .map_err(|e| napi::Error::from_reason(e.to_string()))
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
        let parsed = classify_runtime_error_signal_from_text_value(
            "apply_patch verification failed: Failed to find expected lines in src/main.rs",
        )
        .unwrap_or(Value::Null);
        assert_eq!(parsed["group"], "exec-error");
        assert_eq!(parsed["errorType"], "apply_patch_expected_lines_not_found");
    }

    #[test]
    fn classifies_runtime_sse_decode_payload() {
        let raw = classify_runtime_error_signal_json(
            "chat_process.resp.stage1.sse_decode".to_string(),
            json!({"decoded": false, "error": "Anthropic SSE error event [500] Operation failed"})
                .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["group"], "parse-error");
        assert_eq!(parsed["errorType"], "sse_decode_error");
        assert_eq!(
            parsed["matchedText"],
            "Anthropic SSE error event [500] Operation failed"
        );
    }

    #[test]
    fn runtime_payload_classifier_ignores_normal_content_paths() {
        let raw = classify_runtime_error_signal_json(
            "chat_process.req.stage2.semantic_map".to_string(),
            json!({
                "messages": [
                    {
                        "role": "user",
                        "content": "failed to parse function arguments: missing field `cmd`"
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert!(parsed.is_null());
    }

    #[test]
    fn decides_runtime_error_inspection_from_stage_and_direct_error() {
        assert!(should_inspect_runtime_error_value(
            "chat_process.req.stage2.semantic_map",
            &json!({})
        ));
        assert!(should_inspect_runtime_error_value(
            "provider.send",
            &json!({"message":"transport failed"})
        ));
        assert!(!should_inspect_runtime_error_value(
            "provider.send",
            &json!({"content":"missing field `cmd`"})
        ));
    }

    #[test]
    fn summarizes_client_tool_observation_from_native_truth() {
        let raw = summarize_client_tool_observation_json(
            json!({"input": [], "model": "gpt-test", "extra": true}).to_string(),
            json!([
                {"toolName":"exec_command","errorType":"exec_command_args_missing_cmd","matchedText":"missing field `cmd`","toolCallId":"call_1","callId":"call_1"}
            ])
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["failureCount"], 1);
        assert_eq!(parsed["toolMessageCount"], 1);
        assert_eq!(parsed["failures"][0]["toolName"], "exec_command");
        assert_eq!(parsed["toolMessages"][0]["name"], "exec_command");
        assert_eq!(parsed["toolMessages"][0]["tool_call_id"], "call_1");
        assert_eq!(parsed["topLevelKeys"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn resolves_request_tail_summary_from_latest_messages() {
        let raw = resolve_request_tail_summary_json(
            "chat_process.req.stage2.semantic_map".to_string(),
            json!({
                "messages": [
                    {"role": "system", "content": "old"},
                    {"role": "user", "content": [{"type":"input_text","text":"hello"}]},
                    {"role": "assistant", "content": "world"}
                ]
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["stage"], "chat_process.req.stage2.semantic_map");
        assert_eq!(
            parsed["preview"],
            "messages_tail=user:hello || assistant:world"
        );
    }

    #[test]
    fn decides_tool_and_runtime_fast_inspection_in_native() {
        assert!(should_inspect_tool_failures_json(
            "chat_process.req.stage2.semantic_map".to_string()
        )
        .unwrap());
        assert!(!should_inspect_tool_failures_json("provider.send".to_string()).unwrap());
        assert!(should_inspect_runtime_error_fast_json(
            "provider.send_error".to_string(),
            json!({"message":"transport failed"}).to_string(),
        )
        .unwrap());
        assert!(!should_inspect_runtime_error_fast_json(
            "chat_process.req.stage2.semantic_map".to_string(),
            json!({}).to_string(),
        )
        .unwrap());
    }

    #[test]
    fn ignores_runtime_text_without_known_failure_signal() {
        let parsed = classify_runtime_error_signal_from_text_value("ordinary provider response");
        assert!(parsed.is_none());
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
