use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

use crate::hub_bridge_actions::utils::{
    can_servertool_own_tool_call_id, create_harvested_tool_call_id,
    create_servertool_tool_call_id, is_synthetic_routecodex_tool_call_id,
};
use crate::resp_process_stage1_tool_governance_blocks::json_args::{
    parse_json_record, try_parse_json_value_lenient,
};
use crate::resp_process_stage1_tool_governance_blocks::tool_args::{
    infer_tool_name_from_args, normalize_tool_args, normalize_tool_args_preserving_raw_shape,
};
use crate::resp_process_stage1_tool_governance_blocks::tool_names::normalize_tool_name;
use crate::shared_json_utils::read_trimmed_string;

const TOOL_CALL_JSON_MARKER: &str = "\"tool_calls\"";

pub(crate) fn extract_balanced_json_object_at(text: &str, start_index: usize) -> Option<String> {
    let bytes = text.as_bytes();
    if start_index >= bytes.len() || bytes[start_index] != b'{' {
        return None;
    }

    let mut depth = 0i64;
    let mut in_string = false;
    let mut escaped = false;

    for idx in start_index..bytes.len() {
        let ch = bytes[idx];
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == b'\\' {
                escaped = true;
                continue;
            }
            if ch == b'"' {
                in_string = false;
            }
            continue;
        }

        if ch == b'"' {
            in_string = true;
            continue;
        }
        if ch == b'{' {
            depth += 1;
            continue;
        }
        if ch == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some(text[start_index..=idx].to_string());
            }
        }
    }

    None
}

pub(crate) fn extract_balanced_json_array_at(text: &str, start_index: usize) -> Option<String> {
    let bytes = text.as_bytes();
    if start_index >= bytes.len() || bytes[start_index] != b'[' {
        return None;
    }

    let mut depth = 0i64;
    let mut in_string = false;
    let mut escaped = false;

    for idx in start_index..bytes.len() {
        let ch = bytes[idx];
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == b'\\' {
                escaped = true;
                continue;
            }
            if ch == b'"' {
                in_string = false;
            }
            continue;
        }

        if ch == b'"' {
            in_string = true;
            continue;
        }
        if ch == b'[' {
            depth += 1;
            continue;
        }
        if ch == b']' {
            depth -= 1;
            if depth == 0 {
                return Some(text[start_index..=idx].to_string());
            }
        }
    }

    None
}

fn has_unclosed_code_fence(text: &str) -> bool {
    let fence_count = text.match_indices("```").count();
    fence_count % 2 == 1
}

pub(crate) fn extract_json_candidates_from_text(text: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut seen = HashSet::new();
    let trimmed = text.trim();

    if !trimmed.is_empty()
        && !has_unclosed_code_fence(trimmed)
        && !is_unsafe_double_quoted_tool_json_candidate(trimmed)
    {
        if let Some(parsed) = try_parse_json_value_lenient(trimmed) {
            out.push(parsed);
            seen.insert(trimmed.to_string());
        }
    }

    let mut cursor = 0usize;
    while let Some(rel_start) = text[cursor..].find("```") {
        let fence_start = cursor + rel_start;
        let lang_end = text[fence_start + 3..]
            .find('\n')
            .map(|v| fence_start + 3 + v)
            .unwrap_or(fence_start + 3);
        let content_start = if lang_end < text.len() {
            lang_end + 1
        } else {
            lang_end
        };
        let rest = &text[content_start..];
        let Some(rel_end) = rest.find("```") else {
            break;
        };
        let fence_end = content_start + rel_end;
        let block = text[content_start..fence_end].trim();
        if !block.is_empty() && !seen.contains(block) {
            if is_unsafe_double_quoted_tool_json_candidate(block) {
                cursor = fence_end + 3;
                continue;
            }
            if let Some(parsed) = try_parse_json_value_lenient(block) {
                out.push(parsed);
                seen.insert(block.to_string());
            }
        }
        cursor = fence_end + 3;
    }

    if text.contains(TOOL_CALL_JSON_MARKER) {
        let mut search_from = 0usize;
        while let Some(rel_idx) = text[search_from..].find(TOOL_CALL_JSON_MARKER) {
            let idx = search_from + rel_idx;
            let prefix = &text[..idx];
            if let Some(open_brace_idx) = prefix.rfind('{') {
                if let Some(segment) = extract_balanced_json_object_at(text, open_brace_idx) {
                    let normalized = segment.trim().to_string();
                    if !normalized.is_empty() && !seen.contains(&normalized) {
                        if is_unsafe_double_quoted_tool_json_candidate(&normalized) {
                            search_from = idx + TOOL_CALL_JSON_MARKER.len();
                            continue;
                        }
                        if let Some(parsed) = try_parse_json_value_lenient(&normalized) {
                            out.push(parsed);
                            seen.insert(normalized);
                        }
                    }
                }
            }
            search_from = idx + TOOL_CALL_JSON_MARKER.len();
        }
    }

    let marker_pattern =
        Regex::new(r#"(?i)(?:"tool_calls"|'tool_calls'|\btool_calls\b)"#).expect("valid marker");
    for marker in marker_pattern.find_iter(text) {
        let tail = &text[marker.end()..];
        let Some(rel_open) = tail.find('[') else {
            continue;
        };
        let open_idx = marker.end() + rel_open;
        let Some(array_segment) = extract_balanced_json_array_at(text, open_idx) else {
            continue;
        };
        let normalized = array_segment.trim().to_string();
        if normalized.is_empty() {
            continue;
        }
        if is_unsafe_double_quoted_tool_json_candidate(&normalized) {
            continue;
        }
        let parsed_array = try_parse_json_value_lenient(normalized.as_str())
            .and_then(|value| value.as_array().cloned());
        let Some(array) = parsed_array else {
            continue;
        };
        let wrapped = json!({ "tool_calls": array });
        let Ok(key) = serde_json::to_string(&wrapped) else {
            continue;
        };
        if seen.insert(key) {
            out.push(wrapped);
        }
    }

    out
}

fn is_unsafe_double_quoted_tool_json_candidate(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.contains('"') {
        return false;
    }
    let looks_like_tool_json = trimmed.contains(TOOL_CALL_JSON_MARKER)
        || trimmed.contains("\"name\"")
        || trimmed.contains("\"input\"")
        || trimmed.contains("\"function\"");
    looks_like_tool_json && serde_json::from_str::<Value>(trimmed).is_err()
}

pub(crate) fn unescape_outer_json_quotes_only(raw: &str) -> String {
    raw.replace("\\\"", "\"")
}

pub(crate) fn maybe_parse_tool_call_text_value(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(parsed) = try_parse_json_value_lenient(trimmed) {
        return Some(parsed);
    }
    if trimmed.starts_with('{') {
        if let Some(balanced) = extract_balanced_json_object_at(trimmed, 0) {
            if let Some(parsed) = try_parse_json_value_lenient(balanced.as_str()) {
                return Some(parsed);
            }
        }
    } else if trimmed.starts_with('[') {
        if let Some(balanced) = extract_balanced_json_array_at(trimmed, 0) {
            if let Some(parsed) = try_parse_json_value_lenient(balanced.as_str()) {
                return Some(parsed);
            }
        }
    }
    if trimmed.contains("\\\"") {
        let unescaped = unescape_outer_json_quotes_only(trimmed);
        if let Some(parsed) = try_parse_json_value_lenient(unescaped.as_str()) {
            return Some(parsed);
        }
        if unescaped.starts_with('{') {
            if let Some(balanced) = extract_balanced_json_object_at(unescaped.as_str(), 0) {
                if let Some(parsed) = try_parse_json_value_lenient(balanced.as_str()) {
                    return Some(parsed);
                }
            }
        } else if unescaped.starts_with('[') {
            if let Some(balanced) = extract_balanced_json_array_at(unescaped.as_str(), 0) {
                if let Some(parsed) = try_parse_json_value_lenient(balanced.as_str()) {
                    return Some(parsed);
                }
            }
        }
        if let Some(parsed) = parse_tool_calls_shape_from_text(unescaped.as_str()) {
            return Some(parsed);
        }
    }
    parse_tool_calls_shape_from_text(trimmed)
}

pub(crate) fn is_obviously_truncated_tool_calls_payload(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    if !lowered.contains("tool_calls") {
        return false;
    }
    let Some(marker_idx) = lowered.find("tool_calls") else {
        return false;
    };
    let tail = &text[marker_idx..];
    tail.contains('[') && !tail.contains(']')
}

pub(crate) fn normalize_tool_call_entry(entry: &Value, fallback_id: usize) -> Option<Value> {
    let row = entry.as_object()?;
    let fn_row = row.get("function").and_then(|v| v.as_object());
    let direct_root_inferred_name = if fn_row.is_none()
        && read_trimmed_string(row.get("name")).is_none()
        && read_trimmed_string(row.get("tool_name")).is_none()
    {
        infer_tool_name_from_args(Some(entry))
    } else {
        None
    };
    let args_source_with_mode = row
        .get("input")
        .map(|value| (value, false))
        .or_else(|| row.get("arguments").map(|value| (value, true)))
        .or_else(|| row.get("params").map(|value| (value, true)))
        .or_else(|| row.get("parameters").map(|value| (value, true)))
        .or_else(|| row.get("payload").map(|value| (value, true)))
        .or_else(|| {
            fn_row
                .and_then(|f| f.get("arguments"))
                .map(|value| (value, true))
        })
        .or_else(|| {
            fn_row
                .and_then(|f| f.get("input"))
                .map(|value| (value, false))
        })
        .or_else(|| {
            fn_row
                .and_then(|f| f.get("params"))
                .map(|value| (value, true))
        })
        .or_else(|| {
            fn_row
                .and_then(|f| f.get("parameters"))
                .map(|value| (value, true))
        })
        .or_else(|| {
            fn_row
                .and_then(|f| f.get("payload"))
                .map(|value| (value, true))
        })
        .or_else(|| direct_root_inferred_name.as_ref().map(|_| (entry, true)));
    let (args_source, preserve_raw_shape) = args_source_with_mode?;

    let explicit_name = read_trimmed_string(row.get("name"))
        .or_else(|| fn_row.and_then(|f| read_trimmed_string(f.get("name"))));
    let inferred_name = read_tool_name_hint_from_args(Some(args_source))
        .or_else(|| infer_tool_name_from_args(Some(args_source)))
        .or(direct_root_inferred_name);
    let raw_name = explicit_name.clone().or_else(|| inferred_name.clone())?;
    let canonical_name = normalize_tool_name(&raw_name)?;
    let explicit_call_id = read_trimmed_string(row.get("call_id"))
        .or_else(|| read_trimmed_string(row.get("id")))
        .or_else(|| read_trimmed_string(row.get("tool_call_id")));
    let inferred_call_id = if explicit_call_id.is_none() {
        read_tool_call_id_hint_from_args(Some(args_source))
    } else {
        None
    };
    let sanitized_args = if is_arguments_only_wrapper_row(row, fn_row, explicit_name.is_some())
        && inferred_name.is_some()
    {
        parse_json_record(Some(args_source))
            .map(|args| Value::Object(strip_wrapper_metadata_from_args(&args)))
    } else {
        None
    };
    let args_ref = sanitized_args.as_ref().unwrap_or(args_source);
    let normalized_args = if preserve_raw_shape {
        normalize_tool_args_preserving_raw_shape(&raw_name, Some(args_ref))?
    } else {
        normalize_tool_args(&raw_name, Some(args_ref))?
    };

    let call_id = explicit_call_id
        .or(inferred_call_id)
        .unwrap_or_else(|| format!("call_{}", fallback_id));

    Some(json!({
        "id": call_id,
        "type": "function",
        "function": {
            "name": canonical_name,
            "arguments": normalized_args
        }
    }))
}

fn ensure_tool_call_id_fields(
    tool_call_obj: &mut Map<String, Value>,
    request_id: &str,
    sequence: &mut usize,
) -> Result<bool, String> {
    let existing_id = read_trimmed_string(tool_call_obj.get("id"))
        .or_else(|| read_trimmed_string(tool_call_obj.get("tool_call_id")))
        .or_else(|| read_trimmed_string(tool_call_obj.get("call_id")));
    if let Some(existing) = existing_id {
        if is_synthetic_routecodex_tool_call_id(existing.as_str()) {
            return Err(format!(
                "synthetic_tool_call_id: RouteCodex synthetic fallback tool_call id is forbidden: {}",
                existing
            ));
        }
        tool_call_obj.insert("id".to_string(), Value::String(existing.clone()));
        tool_call_obj.insert("tool_call_id".to_string(), Value::String(existing.clone()));
        tool_call_obj.insert("call_id".to_string(), Value::String(existing));
        return Ok(false);
    }

    *sequence += 1;
    let function_name = tool_call_obj
        .get("function")
        .and_then(Value::as_object)
        .and_then(|row| read_trimmed_string(row.get("name")))
        .or_else(|| read_trimmed_string(tool_call_obj.get("name")));
    let canonical_name = function_name
        .as_deref()
        .and_then(normalize_tool_name)
        .or(function_name.clone());
    let generated = match canonical_name {
        Some(name) if can_servertool_own_tool_call_id(name.as_str()) => {
            create_servertool_tool_call_id(name.as_str(), Some(request_id), *sequence)
        }
        _ => create_harvested_tool_call_id(Some(request_id), *sequence),
    };
    tool_call_obj.insert("id".to_string(), Value::String(generated.clone()));
    tool_call_obj.insert("tool_call_id".to_string(), Value::String(generated.clone()));
    tool_call_obj.insert("call_id".to_string(), Value::String(generated));
    Ok(true)
}

pub(crate) fn ensure_payload_tool_call_ids(payload: &mut Value, request_id: &str) -> Result<i64, String> {
    let mut assigned = 0i64;
    let mut sequence = 0usize;

    let mut visit_message = |message: &mut Map<String, Value>| -> Result<(), String> {
        let Some(tool_calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) else {
            return Ok(());
        };
        for tool_call in tool_calls.iter_mut() {
            let Some(tool_call_obj) = tool_call.as_object_mut() else {
                continue;
            };
            if ensure_tool_call_id_fields(tool_call_obj, request_id, &mut sequence)? {
                assigned += 1;
            }
        }
        Ok(())
    };

    if let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices.iter_mut() {
            let Some(message) = choice
                .as_object_mut()
                .and_then(|row| row.get_mut("message"))
                .and_then(Value::as_object_mut)
            else {
                continue;
            };
            visit_message(message)?;
        }
    }

    if let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages.iter_mut() {
            let Some(message_obj) = message.as_object_mut() else {
                continue;
            };
            if !read_trimmed_string(message_obj.get("role"))
                .unwrap_or_default()
                .eq_ignore_ascii_case("assistant")
            {
                continue;
            }
            visit_message(message_obj)?;
        }
    }

    Ok(assigned)
}

fn is_jsonish_value_boundary(next: Option<char>) -> bool {
    matches!(
        next,
        None | Some(',') | Some('}') | Some(']') | Some(':') | Some('\n') | Some('\r')
    )
}

fn build_tool_calls_shape_candidate(text: &str) -> Option<String> {
    if !text.to_ascii_lowercase().contains("tool_calls") {
        return None;
    }
    let trimmed = text.trim();
    let marker_re =
        Regex::new(r#"(?is)(?:"tool_calls"|'tool_calls'|\btool_calls\b)"#).expect("valid marker");
    let marker = marker_re.find(trimmed)?;
    let start = trimmed[..marker.start()]
        .rfind('{')
        .or_else(|| trimmed.find('{'))
        .unwrap_or(marker.start());
    let mut candidate = trimmed[start..].trim().to_string();
    if !candidate.starts_with('{') {
        let after_marker = &trimmed[marker.end()..];
        if let Some(rel_open) = after_marker.find('[') {
            candidate = format!("{{\"tool_calls\":{}}}", &after_marker[rel_open..]);
        } else {
            candidate = format!("{{\"tool_calls\":[{}]}}", after_marker.trim());
        }
    }
    let trailing_rcc_closer_patterns = [
        r"(?is)([}\]])\s*RCC_TOOL_CALLS_JSON\s*$",
        r"(?is)([}\]])\s*RCC_TOOL_CALLS\s*$",
    ];
    for pattern in trailing_rcc_closer_patterns {
        if let Ok(re) = Regex::new(pattern) {
            candidate = re.replace(candidate.as_str(), "$1").to_string();
        }
    }
    if candidate.starts_with('{') {
        if let Some(balanced) = extract_balanced_json_object_at(candidate.as_str(), 0) {
            candidate = balanced;
        }
    } else if candidate.starts_with('[') {
        if let Some(balanced) = extract_balanced_json_array_at(candidate.as_str(), 0) {
            candidate = balanced;
        }
    }
    if candidate.is_empty() {
        None
    } else {
        Some(candidate)
    }
}

pub(crate) fn auto_close_jsonish_shape(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len() + 16);
    let mut in_string = false;
    let mut escaped = false;
    let mut closers: Vec<char> = Vec::new();
    let mut idx = 0usize;

    while idx < chars.len() {
        let ch = chars[idx];
        if in_string {
            if escaped {
                escaped = false;
                out.push(ch);
                idx += 1;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                out.push(ch);
                idx += 1;
                continue;
            }
            if ch == '"' {
                let mut lookahead = idx + 1;
                while lookahead < chars.len() && chars[lookahead].is_whitespace() {
                    lookahead += 1;
                }
                let next = chars.get(lookahead).copied();
                if is_jsonish_value_boundary(next) {
                    in_string = false;
                    out.push(ch);
                } else {
                    out.push('\\');
                    out.push(ch);
                }
                idx += 1;
                continue;
            }
            if ch == '\n' {
                out.push_str("\\n");
                idx += 1;
                continue;
            }
            if ch == '\r' {
                out.push_str("\\r");
                idx += 1;
                continue;
            }
            out.push(ch);
            idx += 1;
            continue;
        }

        match ch {
            '"' => {
                in_string = true;
                out.push(ch);
            }
            '{' => {
                closers.push('}');
                out.push(ch);
            }
            '[' => {
                closers.push(']');
                out.push(ch);
            }
            '}' | ']' => {
                if let Some(expected) = closers.last().copied() {
                    if expected == ch {
                        closers.pop();
                        out.push(ch);
                        idx += 1;
                        continue;
                    }
                }
                idx += 1;
                continue;
            }
            _ => out.push(ch),
        }
        idx += 1;
    }

    if in_string {
        out.push('"');
    }
    while let Some(close) = closers.pop() {
        out.push(close);
    }
    out
}

pub(crate) fn parse_tool_calls_shape_from_text(text: &str) -> Option<Value> {
    let candidate = build_tool_calls_shape_candidate(text)?;
    let repaired = auto_close_jsonish_shape(candidate.as_str());
    try_parse_json_value_lenient(repaired.as_str())
}

pub(crate) fn extract_tool_call_entries_from_malformed_tool_calls_text(
    text: &str,
    fallback_start_id: usize,
) -> Vec<Value> {
    let marker_re =
        Regex::new(r#"(?is)(?:"tool_calls"|'tool_calls'|\btool_calls\b)"#).expect("valid marker");
    let Some(marker) = marker_re.find(text) else {
        return Vec::new();
    };
    let tail = &text[marker.end()..];
    let Some(rel_open) = tail.find('[') else {
        return Vec::new();
    };
    let open_idx = marker.end() + rel_open;
    let chars: Vec<char> = text[open_idx..].chars().collect();
    if chars.first().copied() != Some('[') {
        return Vec::new();
    }

    let mut recovered: Vec<Value> = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    let mut object_depth = 0i64;
    let mut array_depth = 0i64;
    let mut current = String::new();
    let mut saw_entry_separator_repair = false;
    let mut saw_array_close = false;
    let mut idx = 1usize;

    while idx < chars.len() {
        let ch = chars[idx];
        if in_string {
            current.push(ch);
            if escaped {
                escaped = false;
                idx += 1;
                continue;
            }
            if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            idx += 1;
            continue;
        }

        if object_depth == 0 {
            match ch {
                '"' => {
                    in_string = true;
                    idx += 1;
                }
                '{' => {
                    object_depth = 1;
                    array_depth = 0;
                    current.clear();
                    current.push(ch);
                    idx += 1;
                }
                ']' => break,
                _ => idx += 1,
            }
            continue;
        }

        match ch {
            '"' => {
                in_string = true;
                current.push(ch);
            }
            '{' => {
                object_depth += 1;
                current.push(ch);
            }
            '}' => {
                object_depth -= 1;
                current.push(ch);
                if object_depth == 0 {
                    let repaired = auto_close_jsonish_shape(current.trim());
                    if let Some(parsed) = try_parse_json_value_lenient(repaired.as_str()) {
                        if let Some(entry) =
                            normalize_tool_call_entry(&parsed, fallback_start_id + recovered.len())
                        {
                            recovered.push(entry);
                        }
                    }
                    current.clear();
                }
            }
            '[' => {
                array_depth += 1;
                current.push(ch);
            }
            ']' => {
                if array_depth > 0 {
                    array_depth -= 1;
                    current.push(ch);
                } else {
                    saw_array_close = true;
                    let repaired = auto_close_jsonish_shape(current.trim());
                    if let Some(parsed) = try_parse_json_value_lenient(repaired.as_str()) {
                        if let Some(entry) =
                            normalize_tool_call_entry(&parsed, fallback_start_id + recovered.len())
                        {
                            recovered.push(entry);
                        }
                    }
                    break;
                }
            }
            ',' if object_depth == 1 && array_depth == 0 => {
                let mut lookahead = idx + 1;
                while lookahead < chars.len() && chars[lookahead].is_whitespace() {
                    lookahead += 1;
                }
                if chars.get(lookahead).copied() == Some('{') {
                    saw_entry_separator_repair = true;
                    let repaired = auto_close_jsonish_shape(current.trim());
                    if let Some(parsed) = try_parse_json_value_lenient(repaired.as_str()) {
                        if let Some(entry) =
                            normalize_tool_call_entry(&parsed, fallback_start_id + recovered.len())
                        {
                            recovered.push(entry);
                        }
                    }
                    current.clear();
                    object_depth = 1;
                    array_depth = 0;
                    current.push('{');
                    idx = lookahead + 1;
                    continue;
                }
                current.push(ch);
            }
            _ => current.push(ch),
        }

        idx += 1;
    }

    if !current.trim().is_empty()
        && (saw_entry_separator_repair || !recovered.is_empty() || saw_array_close)
    {
        let repaired = auto_close_jsonish_shape(current.trim());
        if let Some(parsed) = try_parse_json_value_lenient(repaired.as_str()) {
            if let Some(entry) =
                normalize_tool_call_entry(&parsed, fallback_start_id + recovered.len())
            {
                recovered.push(entry);
            }
        }
    }

    recovered
}

pub(crate) fn read_tool_name_hint_from_args(raw_args: Option<&Value>) -> Option<String> {
    fn scan(value: &Value, depth: usize) -> Option<String> {
        if depth == 0 {
            return None;
        }
        let obj = value.as_object()?;
        if let Some(raw_name) = read_trimmed_string(obj.get("name")) {
            if let Some(normalized) = normalize_tool_name(&raw_name) {
                return Some(normalized);
            }
        }
        for key in ["function", "input", "args", "payload"] {
            if let Some(child) = obj.get(key) {
                if let Some(hint) = scan(child, depth - 1) {
                    return Some(hint);
                }
            }
        }
        None
    }

    match raw_args {
        Some(Value::Object(_)) => scan(raw_args?, 3),
        Some(Value::Array(items)) => items.iter().find_map(|item| scan(item, 2)),
        _ => None,
    }
}

pub(crate) fn read_tool_call_id_hint_from_args(raw_args: Option<&Value>) -> Option<String> {
    fn scan(value: &Value, depth: usize) -> Option<String> {
        if depth == 0 {
            return None;
        }
        let obj = value.as_object()?;
        for key in ["id", "tool_call_id", "call_id"] {
            if let Some(raw_id) = read_trimmed_string(obj.get(key)) {
                return Some(raw_id);
            }
        }
        for key in ["function", "input", "args", "payload"] {
            if let Some(child) = obj.get(key) {
                if let Some(hint) = scan(child, depth - 1) {
                    return Some(hint);
                }
            }
        }
        None
    }

    match raw_args {
        Some(Value::Object(_)) => scan(raw_args?, 3),
        Some(Value::Array(items)) => items.iter().find_map(|item| scan(item, 2)),
        _ => None,
    }
}

fn is_arguments_only_wrapper_row(
    row: &Map<String, Value>,
    fn_row: Option<&Map<String, Value>>,
    has_explicit_name: bool,
) -> bool {
    if fn_row.is_some() || has_explicit_name {
        return false;
    }
    row.keys().all(|key| {
        matches!(
            key.as_str(),
            "arguments" | "input" | "params" | "parameters" | "payload" | "type"
        )
    })
}

fn strip_wrapper_metadata_from_args(args: &Map<String, Value>) -> Map<String, Value> {
    let mut sanitized = args.clone();
    sanitized.remove("name");
    sanitized.remove("id");
    sanitized.remove("call_id");
    sanitized.remove("tool_call_id");
    if sanitized
        .get("type")
        .and_then(Value::as_str)
        .map(|raw| raw.trim().eq_ignore_ascii_case("function"))
        .unwrap_or(false)
    {
        sanitized.remove("type");
    }
    sanitized
}

pub(crate) fn extract_tool_call_entries_from_unknown(value: &Value) -> Vec<Value> {
    if let Some(raw) = value.as_str() {
        if let Some(parsed) = maybe_parse_tool_call_text_value(raw) {
            return extract_tool_call_entries_from_unknown(&parsed);
        }
        return Vec::new();
    }

    if let Some(rows) = value.as_array() {
        return rows
            .iter()
            .enumerate()
            .filter_map(|(idx, entry)| normalize_tool_call_entry(entry, idx + 1))
            .collect();
    }

    let Some(row) = value.as_object() else {
        return Vec::new();
    };

    if let Some(tool_calls) = row.get("tool_calls") {
        let direct = extract_tool_call_entries_from_unknown(tool_calls);
        if !direct.is_empty() {
            return direct;
        }
        if let Some(raw) = tool_calls.as_str() {
            if let Some(parsed) = maybe_parse_tool_call_text_value(raw) {
                return extract_tool_call_entries_from_unknown(&parsed);
            }
        }
    }

    normalize_tool_call_entry(value, 1)
        .map(|call| vec![call])
        .unwrap_or_default()
}
