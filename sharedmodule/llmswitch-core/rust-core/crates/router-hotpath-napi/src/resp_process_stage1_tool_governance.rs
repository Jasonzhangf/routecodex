use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

const TOOL_CALL_JSON_MARKER: &str = "\"tool_calls\"";

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolGovernanceInput {
    pub payload: Value,
    pub client_protocol: String,
    pub entry_endpoint: String,
    pub request_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolGovernanceSummary {
    pub applied: bool,
    pub tool_calls_normalized: i64,
    pub apply_patch_repaired: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolGovernancePreparationSummary {
    pub converted: bool,
    pub shape_sanitized: bool,
    pub harvested_tool_calls: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolGovernancePreparationOutput {
    pub prepared_payload: Value,
    pub summary: ToolGovernancePreparationSummary,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolGovernanceOutput {
    pub governed_payload: Value,
    pub summary: ToolGovernanceSummary,
}

fn is_canonical_chat_completion(payload: &Value) -> bool {
    let Some(row) = payload.as_object() else {
        return false;
    };
    let Some(choices) = row.get("choices").and_then(|v| v.as_array()) else {
        return false;
    };
    let Some(first) = choices.first().and_then(|v| v.as_object()) else {
        return false;
    };
    first.get("message").and_then(|v| v.as_object()).is_some()
}

fn coerce_to_canonical_chat_completion(payload: &Value) -> (Value, bool) {
    if is_canonical_chat_completion(payload) {
        return (payload.clone(), false);
    }

    let Ok(payload_json) = serde_json::to_string(payload) else {
        return (payload.clone(), false);
    };
    let Ok(raw) = crate::shared_responses_response_utils::build_chat_response_from_responses_json(
        payload_json,
    ) else {
        return (payload.clone(), false);
    };
    let Ok(coerced) = serde_json::from_str::<Value>(&raw) else {
        return (payload.clone(), false);
    };
    if is_canonical_chat_completion(&coerced) {
        return (coerced, true);
    }
    (payload.clone(), false)
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}

fn read_string_array_command(value: Option<&Value>) -> Option<String> {
    let parts = value.and_then(|v| v.as_array())?;
    let tokens: Vec<String> = parts
        .iter()
        .map(|item| match item {
            Value::String(v) => v.trim().to_string(),
            Value::Null => String::new(),
            other => other.to_string().trim().to_string(),
        })
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(tokens.join(" "))
}

fn escape_newlines_inside_json_strings(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_string = false;
    let mut escaped = false;
    for ch in raw.chars() {
        if in_string {
            if escaped {
                escaped = false;
                out.push(ch);
                continue;
            }
            if ch == '\\' {
                escaped = true;
                out.push(ch);
                continue;
            }
            if ch == '"' {
                in_string = false;
                out.push(ch);
                continue;
            }
            if ch == '\n' {
                out.push_str("\\n");
                continue;
            }
            if ch == '\r' {
                out.push_str("\\r");
                continue;
            }
            out.push(ch);
            continue;
        }

        if ch == '"' {
            in_string = true;
        }
        out.push(ch);
    }
    out
}

fn escape_unescaped_quotes_inside_json_strings(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len() + 8);
    let mut in_string = false;
    let mut escaped = false;
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
                let should_close =
                    matches!(next, None | Some(',') | Some('}') | Some(']') | Some(':'));
                if should_close {
                    in_string = false;
                    out.push(ch);
                } else {
                    out.push('\\');
                    out.push(ch);
                }
                idx += 1;
                continue;
            }
            out.push(ch);
            idx += 1;
            continue;
        }

        if ch == '"' {
            in_string = true;
        }
        out.push(ch);
        idx += 1;
    }

    out
}

fn try_parse_json_value_lenient(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        return Some(parsed);
    }

    let escaped_newlines = escape_newlines_inside_json_strings(trimmed);
    if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_newlines) {
        return Some(parsed);
    }
    let escaped_quotes = escape_unescaped_quotes_inside_json_strings(trimmed);
    if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_quotes) {
        return Some(parsed);
    }
    let escaped_quotes_newlines = escape_newlines_inside_json_strings(&escaped_quotes);
    if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_quotes_newlines) {
        return Some(parsed);
    }

    let mut candidate = trimmed.to_string();
    let fence_pattern =
        Regex::new(r"(?is)^```(?:json|tool_call|tool_calls|function_call)?\s*([\s\S]*?)\s*```$")
            .expect("valid lenient parse fence pattern");
    if let Some(caps) = fence_pattern.captures(candidate.as_str()) {
        if let Some(inner) = caps.get(1) {
            candidate = inner.as_str().trim().to_string();
        }
    }

    let line_comment_pattern = Regex::new(r"(?m)//.*$").expect("valid lenient parse line comment");
    let block_comment_pattern =
        Regex::new(r"(?s)/\*[\s\S]*?\*/").expect("valid lenient parse block comment");
    let trailing_comma_pattern =
        Regex::new(r",\s*([}\]])").expect("valid lenient parse trailing comma");
    let single_quote_pattern =
        Regex::new(r#"'([^'\\]*(?:\\.[^'\\]*)*)'"#).expect("valid lenient parse single quote");
    let unquoted_key_pattern = Regex::new(r#"([{,\s])([A-Za-z_][A-Za-z0-9_-]*)\s*:"#)
        .expect("valid lenient parse unquoted key");

    candidate = line_comment_pattern
        .replace_all(candidate.as_str(), "")
        .to_string();
    candidate = block_comment_pattern
        .replace_all(candidate.as_str(), "")
        .to_string();
    candidate = trailing_comma_pattern
        .replace_all(candidate.as_str(), "$1")
        .to_string();
    candidate = single_quote_pattern
        .replace_all(candidate.as_str(), r#""$1""#)
        .to_string();
    candidate = unquoted_key_pattern
        .replace_all(candidate.as_str(), r#"$1"$2":"#)
        .to_string();

    if let Ok(parsed) = serde_json::from_str::<Value>(candidate.as_str()) {
        return Some(parsed);
    }
    let escaped_candidate_quotes = escape_unescaped_quotes_inside_json_strings(candidate.as_str());
    if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_candidate_quotes) {
        return Some(parsed);
    }
    let escaped_candidate = escape_newlines_inside_json_strings(candidate.as_str());
    if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_candidate) {
        return Some(parsed);
    }
    let escaped_candidate_mix = escape_newlines_inside_json_strings(&escaped_candidate_quotes);
    if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_candidate_mix) {
        return Some(parsed);
    }

    let first_block_pattern =
        Regex::new(r"(?s)\{[\s\S]*\}|\[[\s\S]*\]").expect("valid lenient parse first block");
    if let Some(matched) = first_block_pattern.find(candidate.as_str()) {
        if let Ok(parsed) = serde_json::from_str::<Value>(matched.as_str()) {
            return Some(parsed);
        }
        let escaped_quotes = escape_unescaped_quotes_inside_json_strings(matched.as_str());
        if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_quotes) {
            return Some(parsed);
        }
        let escaped = escape_newlines_inside_json_strings(matched.as_str());
        if let Ok(parsed) = serde_json::from_str::<Value>(&escaped) {
            return Some(parsed);
        }
        let escaped_mix = escape_newlines_inside_json_strings(&escaped_quotes);
        if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_mix) {
            return Some(parsed);
        }
    }

    None
}

fn parse_json_record(value: Option<&Value>) -> Option<Map<String, Value>> {
    match value {
        Some(Value::Object(row)) => Some(row.clone()),
        Some(Value::String(raw)) => {
            if raw.trim().is_empty() {
                return Some(Map::new());
            }
            let parsed = try_parse_json_value_lenient(raw.as_str())?;
            parsed.as_object().cloned()
        }
        _ => None,
    }
}

fn read_command_from_args(args: &Map<String, Value>) -> Option<String> {
    let input = args.get("input");
    let read_value = |value: Option<&Value>| -> Option<String> {
        read_trimmed_string(value).or_else(|| read_string_array_command(value))
    };
    let direct = read_value(args.get("cmd"))
        .or_else(|| read_value(args.get("command")))
        .or_else(|| read_value(args.get("script")))
        .or_else(|| read_value(args.get("toon")))
        .or_else(|| read_value(args.get("input")))
        .or_else(|| read_value(args.get("text")));
    if direct.is_some() {
        return direct;
    }
    input
        .and_then(Value::as_object)
        .and_then(|input_row| {
            read_value(input_row.get("cmd"))
                .or_else(|| read_value(input_row.get("command")))
                .or_else(|| read_value(input_row.get("script")))
                .or_else(|| read_value(input_row.get("toon")))
        })
        .or_else(|| {
            args.get("args")
                .and_then(Value::as_object)
                .and_then(|input_row| {
                    read_value(input_row.get("cmd"))
                        .or_else(|| read_value(input_row.get("command")))
                        .or_else(|| read_value(input_row.get("script")))
                        .or_else(|| read_value(input_row.get("toon")))
                })
        })
}

fn read_workdir_from_args(args: &Map<String, Value>) -> Option<String> {
    let input = args.get("input").and_then(|v| v.as_object());
    read_trimmed_string(args.get("workdir"))
        .or_else(|| read_trimmed_string(args.get("cwd")))
        .or_else(|| read_trimmed_string(args.get("workDir")))
        .or_else(|| input.and_then(|row| read_trimmed_string(row.get("workdir"))))
        .or_else(|| input.and_then(|row| read_trimmed_string(row.get("cwd"))))
}

fn decode_escaped_newlines_if_needed(raw: &str) -> String {
    if raw.contains('\n') || !raw.contains("\\n") {
        return raw.to_string();
    }
    raw.replace("\\n", "\n")
}

fn find_first_patch_marker(raw: &str) -> Option<usize> {
    [
        "*** Begin Patch",
        "*** Add File:",
        "*** Update File:",
        "*** Delete File:",
    ]
    .iter()
    .filter_map(|marker| raw.find(marker))
    .min()
}

fn trim_to_patch_window(raw: &str) -> String {
    let trimmed = raw.trim();
    let Some(start) = find_first_patch_marker(trimmed) else {
        return trimmed.to_string();
    };
    let mut patch = trimmed[start..].trim().to_string();
    if let Some(end_rel) = patch.rfind("*** End Patch") {
        let end = end_rel + "*** End Patch".len();
        patch = patch[..end].trim().to_string();
    }
    patch
}

fn looks_like_patch_body_after_apply_patch_prefix(raw: &str) -> bool {
    let trimmed = raw.trim_start();
    [
        "*** Begin Patch",
        "*** Add File:",
        "*** Update File:",
        "*** Delete File:",
        "--- ",
        "+++ ",
        "*** a/",
        "*** b/",
        "diff --git ",
    ]
    .iter()
    .any(|marker| trimmed.starts_with(marker) || trimmed.contains(marker))
}

fn strip_apply_patch_command_prefix(raw: &str) -> String {
    let trimmed = raw.trim_start();
    let Some(rest) = trimmed.strip_prefix("apply_patch") else {
        return raw.to_string();
    };
    let stripped = rest.trim_start();
    if stripped.is_empty() || !looks_like_patch_body_after_apply_patch_prefix(stripped) {
        return raw.to_string();
    }
    stripped.to_string()
}

fn has_unified_like_header(text: &str) -> bool {
    text.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with("--- ")
            || trimmed.starts_with("+++ ")
            || trimmed.starts_with("*** a/")
            || trimmed.starts_with("*** b/")
    })
}

fn extract_apply_patch_text(raw_args: Option<&Value>) -> Option<String> {
    match raw_args {
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                return extract_apply_patch_text(Some(&parsed));
            }
            Some(
                decode_escaped_newlines_if_needed(trimmed)
                    .trim()
                    .to_string(),
            )
        }
        Some(Value::Object(row)) => read_trimmed_string(row.get("patch"))
            .or_else(|| read_trimmed_string(row.get("input")))
            .or_else(|| read_trimmed_string(row.get("instructions")))
            .or_else(|| read_trimmed_string(row.get("text")))
            .or_else(|| read_trimmed_string(row.get("command")))
            .or_else(|| read_trimmed_string(row.get("cmd")))
            .or_else(|| read_trimmed_string(row.get("script")))
            .or_else(|| {
                row.get("result")
                    .and_then(|value| extract_apply_patch_text(Some(value)))
            })
            .or_else(|| {
                row.get("payload")
                    .and_then(|value| extract_apply_patch_text(Some(value)))
            })
            .or_else(|| {
                row.get("data")
                    .and_then(|value| extract_apply_patch_text(Some(value)))
            })
            .or_else(|| {
                row.get("tool_input")
                    .and_then(|value| extract_apply_patch_text(Some(value)))
            })
            .or_else(|| {
                row.get("toolInput")
                    .and_then(|value| extract_apply_patch_text(Some(value)))
            })
            .or_else(|| {
                row.get("arguments")
                    .and_then(|value| extract_apply_patch_text(Some(value)))
            }),
        Some(Value::Array(items)) => items
            .iter()
            .find_map(|value| extract_apply_patch_text(Some(value))),
        _ => None,
    }
}

fn normalize_apply_patch_header_path(raw: &str) -> String {
    let mut out = raw.trim().to_string();
    if out.is_empty() {
        return out;
    }
    let bytes = out.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0] as char;
        let last = bytes[bytes.len() - 1] as char;
        let is_wrapped = (first == '"' && last == '"')
            || (first == '\'' && last == '\'')
            || (first == '`' && last == '`');
        if is_wrapped {
            out = out[1..out.len() - 1].trim().to_string();
        }
    }
    out
}

fn normalize_apply_patch_header_line(line: &str) -> String {
    let add_re = Regex::new(r"^\*\*\* Add File:\s*(.+?)(?:\s+\*\*\*)?\s*$").unwrap();
    if let Some(caps) = add_re.captures(line) {
        if let Some(path) = caps.get(1) {
            return format!(
                "*** Add File: {}",
                normalize_apply_patch_header_path(path.as_str())
            );
        }
    }
    let update_re = Regex::new(r"^\*\*\* Update File:\s*(.+?)(?:\s+\*\*\*)?\s*$").unwrap();
    if let Some(caps) = update_re.captures(line) {
        if let Some(path) = caps.get(1) {
            return format!(
                "*** Update File: {}",
                normalize_apply_patch_header_path(path.as_str())
            );
        }
    }
    let delete_re = Regex::new(r"^\*\*\* Delete File:\s*(.+?)(?:\s+\*\*\*)?\s*$").unwrap();
    if let Some(caps) = delete_re.captures(line) {
        if let Some(path) = caps.get(1) {
            return format!(
                "*** Delete File: {}",
                normalize_apply_patch_header_path(path.as_str())
            );
        }
    }
    line.to_string()
}

fn normalize_unified_header_path(raw: &str) -> String {
    let normalized = normalize_apply_patch_header_path(raw);
    if let Some(stripped) = normalized.strip_prefix("a/") {
        return stripped.to_string();
    }
    if let Some(stripped) = normalized.strip_prefix("b/") {
        return stripped.to_string();
    }
    normalized
}

fn normalize_apply_patch_text(raw: &str) -> String {
    let mut text = decode_escaped_newlines_if_needed(raw).replace("\r\n", "\n");
    text = strip_apply_patch_command_prefix(&text);
    text = trim_to_patch_window(&text);
    if text.is_empty() {
        return text;
    }
    text = text.trim().to_string();
    if text.is_empty() {
        return text;
    }

    text = text.replace("*** Create File:", "*** Add File:");

    // Some models emit single-line markers like:
    // "*** Begin Patch *** Create File: a.ts ... *** End Patch"
    text = text.replace(
        "*** Begin Patch *** Add File:",
        "*** Begin Patch\n*** Add File:",
    );
    text = text.replace(
        "*** Begin Patch *** Update File:",
        "*** Begin Patch\n*** Update File:",
    );
    text = text.replace(
        "*** Begin Patch *** Delete File:",
        "*** Begin Patch\n*** Delete File:",
    );
    text = text.replace(
        "*** Begin Patch *** Create File:",
        "*** Begin Patch\n*** Add File:",
    );
    text = text.replace("*** Add File:", "\n*** Add File:");
    text = text.replace("*** Update File:", "\n*** Update File:");
    text = text.replace("*** Delete File:", "\n*** Delete File:");
    text = text.replace("\n\n*** Add File:", "\n*** Add File:");
    text = text.replace("\n\n*** Update File:", "\n*** Update File:");
    text = text.replace("\n\n*** Delete File:", "\n*** Delete File:");

    if text.contains("*** Begin Patch") && text.contains("*** End Patch") && !text.contains('\n') {
        text = text.replace("*** Begin Patch", "*** Begin Patch\n");
        text = text.replace("*** End Patch", "\n*** End Patch");
    }

    let has_begin = text.contains("*** Begin Patch");
    let has_file_header = text.contains("*** Add File:")
        || text.contains("*** Update File:")
        || text.contains("*** Delete File:");
    let has_unified_header = has_unified_like_header(&text);
    if !has_begin && (has_file_header || has_unified_header) {
        text = format!("*** Begin Patch\n{}\n*** End Patch", text.trim());
    } else if has_begin && !text.contains("*** End Patch") {
        text = format!("{}\n*** End Patch", text.trim());
    }

    let mut out: Vec<String> = Vec::new();
    let mut in_add_section = false;
    let mut pending_unified_from: Option<String> = None;
    for line in text.split('\n') {
        let raw_line = line.strip_suffix('\r').unwrap_or(line);
        let mut normalized = normalize_apply_patch_header_line(raw_line.trim());
        if raw_line.trim() == "***************" {
            continue;
        }
        if normalized.starts_with("*** a/") {
            normalized = format!("--- {}", normalized.trim_start_matches("*** ").trim());
        } else if normalized.starts_with("*** b/") {
            normalized = format!("+++ {}", normalized.trim_start_matches("*** ").trim());
        }

        if normalized.starts_with("--- ") {
            pending_unified_from = Some(normalized.trim_start_matches("--- ").trim().to_string());
            continue;
        }
        if normalized.starts_with("+++ ") {
            let plus_path = normalized.trim_start_matches("+++ ").trim().to_string();
            let minus_path = pending_unified_from.take();
            let plus_is_dev_null = plus_path == "/dev/null";
            let minus_is_dev_null = minus_path.as_deref() == Some("/dev/null");
            if minus_is_dev_null && !plus_is_dev_null {
                out.push(format!(
                    "*** Add File: {}",
                    normalize_unified_header_path(&plus_path)
                ));
                in_add_section = true;
                continue;
            }
            if plus_is_dev_null {
                if let Some(from_path) = minus_path {
                    out.push(format!(
                        "*** Delete File: {}",
                        normalize_unified_header_path(&from_path)
                    ));
                    in_add_section = false;
                    continue;
                }
            }
            let update_path = if !plus_path.is_empty() {
                plus_path
            } else {
                minus_path.unwrap_or_default()
            };
            if !update_path.is_empty() {
                out.push(format!(
                    "*** Update File: {}",
                    normalize_unified_header_path(&update_path)
                ));
                in_add_section = false;
                continue;
            }
        }
        if normalized.starts_with("@@") {
            if let Some(from_path) = pending_unified_from.take() {
                if from_path != "/dev/null" && !from_path.is_empty() {
                    out.push(format!(
                        "*** Update File: {}",
                        normalize_unified_header_path(&from_path)
                    ));
                    in_add_section = false;
                }
            }
        }

        if normalized.starts_with("*** Begin Patch") {
            out.push("*** Begin Patch".to_string());
            in_add_section = false;
            pending_unified_from = None;
            continue;
        }
        if normalized.starts_with("*** End Patch") {
            out.push("*** End Patch".to_string());
            in_add_section = false;
            pending_unified_from = None;
            continue;
        }
        if normalized.starts_with("*** Add File:") {
            out.push(normalized);
            in_add_section = true;
            pending_unified_from = None;
            continue;
        }
        if normalized.starts_with("*** Update File:") || normalized.starts_with("*** Delete File:")
        {
            out.push(normalized);
            in_add_section = false;
            pending_unified_from = None;
            continue;
        }
        if in_add_section {
            if raw_line.starts_with('+') {
                out.push(raw_line.to_string());
            } else {
                out.push(format!("+{}", raw_line));
            }
            continue;
        }
        out.push(raw_line.to_string());
    }

    out.join("\n").trim().to_string()
}

fn normalize_tool_name(raw_name: &str) -> Option<String> {
    let mut lowered = raw_name.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return None;
    }
    if let Some(stripped) = lowered.strip_prefix("functions.") {
        lowered = stripped.trim().to_string();
    }

    let canonical = lowered.as_str();
    let known = matches!(
        canonical,
        "exec_command"
            | "shell_command"
            | "shell"
            | "bash"
            | "terminal"
            | "write_stdin"
            | "apply_patch"
            | "update_plan"
            | "view_image"
            | "list_mcp_resources"
            | "read_mcp_resource"
            | "list_mcp_resource_templates"
            | "list_directory"
    );
    if !known {
        return None;
    }
    Some(canonical.to_string())
}

fn infer_tool_name_from_args(raw_args: Option<&Value>) -> Option<String> {
    let args = parse_json_record(raw_args).unwrap_or_default();
    if args.is_empty() {
        return None;
    }

    if let Some(patch_text) = extract_apply_patch_text(raw_args) {
        let decoded = decode_escaped_newlines_if_needed(&patch_text);
        if looks_like_patch_body_after_apply_patch_prefix(decoded.as_str()) {
            let normalized = normalize_apply_patch_text(decoded.as_str());
            if !normalized.is_empty() {
                return Some("apply_patch".to_string());
            }
        }
    }

    if read_command_from_args(&args).is_some() {
        return Some("exec_command".to_string());
    }

    let has_plan = args
        .get("plan")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    let has_explanation = args
        .get("explanation")
        .and_then(Value::as_str)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if has_plan || has_explanation {
        return Some("update_plan".to_string());
    }

    let has_view_path = args
        .get("path")
        .and_then(Value::as_str)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if has_view_path {
        return Some("view_image".to_string());
    }

    let has_session_id = args.get("session_id").is_some() || args.get("sessionId").is_some();
    let has_chars = args.get("chars").is_some()
        || args.get("text").is_some()
        || args.get("data").is_some()
        || args.get("input").is_some();
    if has_session_id && has_chars {
        return Some("write_stdin".to_string());
    }

    None
}

fn normalize_tool_args(tool_name: &str, raw_args: Option<&Value>) -> Option<String> {
    let name = normalize_tool_name(tool_name)?;
    let args = parse_json_record(raw_args).unwrap_or_default();

    if name == "exec_command" {
        let cmd = read_command_from_args(&args)?;
        let mut out = Map::new();
        out.insert("cmd".to_string(), Value::String(cmd.clone()));
        out.insert("command".to_string(), Value::String(cmd));
        if let Some(workdir) = read_workdir_from_args(&args) {
            out.insert("workdir".to_string(), Value::String(workdir));
        }
        return serde_json::to_string(&Value::Object(out)).ok();
    }

    if matches!(
        name.as_str(),
        "shell_command" | "shell" | "bash" | "terminal"
    ) {
        let command = read_command_from_args(&args)?;
        let mut out = Map::new();
        out.insert("command".to_string(), Value::String(command.clone()));
        out.insert("cmd".to_string(), Value::String(command));
        if let Some(workdir) = read_workdir_from_args(&args) {
            out.insert("cwd".to_string(), Value::String(workdir.clone()));
            out.insert("workdir".to_string(), Value::String(workdir));
        }
        return serde_json::to_string(&Value::Object(out)).ok();
    }

    if name == "write_stdin" {
        let mut out = Map::new();
        let session_id = args
            .get("session_id")
            .or_else(|| args.get("sessionId"))
            .and_then(|v| match v {
                Value::Number(_) => Some(v.clone()),
                Value::String(raw) => raw.parse::<i64>().ok().map(|n| Value::Number(n.into())),
                _ => None,
            })?;
        out.insert("session_id".to_string(), session_id);

        let chars = args
            .get("chars")
            .or_else(|| args.get("text"))
            .or_else(|| args.get("input"))
            .or_else(|| args.get("data"))
            .cloned()
            .unwrap_or(Value::String(String::new()));
        out.insert(
            "chars".to_string(),
            Value::String(match chars {
                Value::String(v) => v,
                other => other.to_string(),
            }),
        );

        return serde_json::to_string(&Value::Object(out)).ok();
    }

    if name == "apply_patch" {
        let patch = extract_apply_patch_text(raw_args)?;
        let patch = normalize_apply_patch_text(&patch);
        if patch.is_empty() {
            return None;
        }
        let mut out = Map::new();
        out.insert("patch".to_string(), Value::String(patch.clone()));
        out.insert("input".to_string(), Value::String(patch));
        return serde_json::to_string(&Value::Object(out)).ok();
    }

    serde_json::to_string(&Value::Object(args)).ok()
}

fn extract_balanced_json_object_at(text: &str, start_index: usize) -> Option<String> {
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

fn extract_balanced_json_array_at(text: &str, start_index: usize) -> Option<String> {
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

fn extract_json_candidates_from_text(text: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut seen = HashSet::new();
    let trimmed = text.trim();

    if !trimmed.is_empty() && !has_unclosed_code_fence(trimmed) {
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

    if let Some(repaired_shape) = parse_tool_calls_shape_from_text(text) {
        if let Ok(key) = serde_json::to_string(&repaired_shape) {
            if seen.insert(key) {
                out.push(repaired_shape);
            }
        }
    }

    out
}

fn extract_function_calls_shell_fence_tool_call(text: &str, fallback_id: usize) -> Option<Value> {
    if !text.contains("<function_calls>") {
        return None;
    }
    let fence_pattern = Regex::new(
        r"(?is)<function_calls>\s*```(?:bash|sh|zsh|shell|cmd|powershell)?\s*\n([\s\S]*?)\s*```\s*</function_calls>",
    )
    .ok()?;
    let body = fence_pattern
        .captures(text)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_string())
        .filter(|body| !body.is_empty())?;
    let entry = json!({
        "name": "exec_command",
        "input": {
            "cmd": body,
            "command": body
        }
    });
    normalize_tool_call_entry(&entry, fallback_id)
}

fn collect_harvest_text_variants(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::<String>::new();
    let mut push_variant = |value: &str| {
        let candidate = value.trim();
        if candidate.is_empty() {
            return;
        }
        if seen.insert(candidate.to_string()) {
            out.push(candidate.to_string());
        }
    };

    push_variant(raw);

    let quote_pattern =
        Regex::new(r"(?is)<quote>\s*([\s\S]*?)\s*</quote>").expect("valid quote capture pattern");
    for caps in quote_pattern.captures_iter(raw) {
        if let Some(inner) = caps.get(1).map(|m| m.as_str()) {
            push_variant(inner);
        }
    }

    out
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
    if candidate.is_empty() {
        None
    } else {
        Some(candidate)
    }
}

fn auto_close_jsonish_shape(raw: &str) -> String {
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
                    }
                }
                out.push(ch);
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

fn parse_tool_calls_shape_from_text(text: &str) -> Option<Value> {
    let candidate = build_tool_calls_shape_candidate(text)?;
    let repaired = auto_close_jsonish_shape(candidate.as_str());
    try_parse_json_value_lenient(repaired.as_str())
}

fn normalize_tool_call_entry(entry: &Value, fallback_id: usize) -> Option<Value> {
    let row = entry.as_object()?;
    let fn_row = row.get("function").and_then(|v| v.as_object());
    let args_source = row
        .get("input")
        .or_else(|| row.get("arguments"))
        .or_else(|| row.get("params"))
        .or_else(|| row.get("parameters"))
        .or_else(|| row.get("payload"))
        .or_else(|| fn_row.and_then(|f| f.get("arguments")))
        .or_else(|| fn_row.and_then(|f| f.get("input")))
        .or_else(|| fn_row.and_then(|f| f.get("params")))
        .or_else(|| fn_row.and_then(|f| f.get("parameters")))
        .or_else(|| fn_row.and_then(|f| f.get("payload")));

    let raw_name = read_trimmed_string(row.get("name"))
        .or_else(|| fn_row.and_then(|f| read_trimmed_string(f.get("name"))))
        .or_else(|| infer_tool_name_from_args(args_source))?;
    let canonical_name = normalize_tool_name(&raw_name)?;
    let normalized_args = normalize_tool_args(&canonical_name, args_source)?;

    let call_id = read_trimmed_string(row.get("call_id"))
        .or_else(|| read_trimmed_string(row.get("id")))
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

fn extract_tool_call_entries_from_unknown(value: &Value) -> Vec<Value> {
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
        return extract_tool_call_entries_from_unknown(tool_calls);
    }

    normalize_tool_call_entry(value, 1)
        .map(|call| vec![call])
        .unwrap_or_default()
}

fn extract_tool_calls_from_qwen_markers(text: &str, fallback_start_id: usize) -> Vec<Value> {
    fn normalize_qwen_marker_tokens(input: &str) -> String {
        let mut normalized = input.to_string();
        let replacements = [
            (
                r"(?is)<\|\s*tool_calls_section_begin\s*\|>",
                "<|tool_calls_section_begin|>",
            ),
            (
                r"(?is)<\|\s*tool_calls_section_end\s*\|>",
                "<|tool_calls_section_end|>",
            ),
            (r"(?is)<\|\s*tool_call_begin\s*\|>", "<|tool_call_begin|>"),
            (
                r"(?is)<\|\s*tool_call_argument_begin\s*\|>",
                "<|tool_call_argument_begin|>",
            ),
            (r"(?is)<\|\s*tool_call_end\s*\|>", "<|tool_call_end|>"),
        ];
        for (pattern, target) in replacements {
            if let Ok(re) = Regex::new(pattern) {
                normalized = re.replace_all(&normalized, target).to_string();
            }
        }
        normalized
    }

    let normalized_text = normalize_qwen_marker_tokens(text);
    let marker_re = match Regex::new(
        r"(?is)<\|tool_call_begin\|>\s*([^\s<]+)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>",
    ) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut recovered: Vec<Value> = Vec::new();
    for (index, captures) in marker_re.captures_iter(&normalized_text).enumerate() {
        let raw_tool = captures
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if raw_tool.is_empty() {
            continue;
        }
        let tool_name = raw_tool.split(':').next().map(|v| v.trim()).unwrap_or("");
        let Some(canonical_name) = normalize_tool_name(tool_name) else {
            continue;
        };
        let emitted_name = if matches!(
            canonical_name.as_str(),
            "shell_command" | "shell" | "bash" | "terminal"
        ) {
            "exec_command"
        } else {
            canonical_name.as_str()
        };

        let raw_args = match captures.get(2) {
            Some(m) => m.as_str().trim().to_string(),
            None => "{}".to_string(),
        };
        let normalized_args = normalize_tool_args(emitted_name, Some(&Value::String(raw_args)))
            .unwrap_or_else(|| "{}".to_string());

        recovered.push(json!({
            "id": format!("call_{}", fallback_start_id + index),
            "type": "function",
            "function": {
                "name": emitted_name,
                "arguments": normalized_args
            }
        }));
    }

    recovered
}

fn read_message_text_candidates(message: &Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();

    if let Some(content) = message.get("content") {
        match content {
            Value::String(text) => {
                if !text.trim().is_empty() {
                    out.push(text.clone());
                }
            }
            Value::Array(parts) => {
                for part in parts {
                    let Some(part_row) = part.as_object() else {
                        continue;
                    };
                    if let Some(text) = read_trimmed_string(part_row.get("text")) {
                        out.push(text);
                        continue;
                    }
                    if let Some(text) = read_trimmed_string(part_row.get("content")) {
                        out.push(text);
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(reasoning) = read_trimmed_string(message.get("reasoning")) {
        out.push(reasoning);
    }
    if let Some(thinking) = read_trimmed_string(message.get("thinking")) {
        out.push(thinking);
    }

    out
}

fn strip_orphan_function_calls_tag(payload: &mut Value) {
    if let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) {
        for choice in choices {
            if let Some(message) = choice.get_mut("message").and_then(|v| v.as_object_mut()) {
                if let Some(content_val) = message.get_mut("content") {
                    if let Some(content) = content_val.as_str() {
                        let new_content = content
                            .replace("<function_calls>", "")
                            .replace("</function_calls>", "");
                        *content_val = Value::String(new_content);
                    }
                }
            }
        }
    }
}

#[napi]
pub fn strip_orphan_function_calls_tag_json(payload_json: String) -> napi::Result<String> {
    if payload_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Payload JSON is empty"));
    }
    let mut payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload JSON: {}", e)))?;
    strip_orphan_function_calls_tag(&mut payload);
    serde_json::to_string(&payload)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize payload: {}", e)))
}

fn maybe_harvest_empty_tool_calls_from_json_content(payload: &mut Value) -> i64 {
    let mut harvested = 0i64;
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return harvested;
    };

    for choice in choices.iter_mut() {
        let Some(choice_row) = choice.as_object_mut() else {
            continue;
        };
        let Some(message) = choice_row
            .get_mut("message")
            .and_then(|v| v.as_object_mut())
        else {
            continue;
        };

        let existing_tool_calls = message.get("tool_calls").and_then(|v| v.as_array());
        if let Some(rows) = existing_tool_calls {
            if !rows.is_empty() {
                continue;
            }
        }

        let mut recovered: Vec<Value> = Vec::new();
        for text in read_message_text_candidates(message) {
            if let Some(function_call_shell) =
                extract_function_calls_shell_fence_tool_call(&text, (harvested as usize) + 1)
            {
                recovered = vec![function_call_shell];
                break;
            }
            let normalized_text = text
                .replace("<function_calls>", "")
                .replace("</function_calls>", "")
                .trim()
                .to_string();
            if normalized_text.is_empty() {
                continue;
            }
            for candidate_text in collect_harvest_text_variants(&normalized_text) {
                let qwen_markers =
                    extract_tool_calls_from_qwen_markers(&candidate_text, (harvested as usize) + 1);
                if !qwen_markers.is_empty() {
                    recovered = qwen_markers;
                    break;
                }
                let has_tool_marker = candidate_text.contains(TOOL_CALL_JSON_MARKER)
                    || candidate_text.contains("'tool_calls'")
                    || candidate_text.contains("tool_calls:")
                    || candidate_text.contains("\"name\"")
                    || candidate_text.contains("'name'")
                    || candidate_text.contains("name:")
                    || candidate_text.contains("<invoke")
                    || candidate_text.contains("<tool_call")
                    || candidate_text.contains("<|tool_call_begin|>");
                if !has_tool_marker {
                    continue;
                }

                for parsed in extract_json_candidates_from_text(&candidate_text) {
                    recovered = extract_tool_call_entries_from_unknown(&parsed);
                    if !recovered.is_empty() {
                        break;
                    }
                }
                if recovered.is_empty() {
                    if let Some(repaired_shape) = parse_tool_calls_shape_from_text(&candidate_text)
                    {
                        recovered = extract_tool_call_entries_from_unknown(&repaired_shape);
                    }
                }
                if !recovered.is_empty() {
                    break;
                }
            }
            if !recovered.is_empty() {
                break;
            }
        }

        if recovered.is_empty() {
            continue;
        }

        harvested += recovered.len() as i64;
        message.insert("tool_calls".to_string(), Value::Array(recovered));
        message.insert("content".to_string(), Value::String(String::new()));

        let finish_reason = read_trimmed_string(choice_row.get("finish_reason"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if finish_reason.is_empty() || finish_reason == "stop" {
            choice_row.insert(
                "finish_reason".to_string(),
                Value::String("tool_calls".to_string()),
            );
        }
    }

    harvested
}

fn normalize_apply_patch_tool_calls(payload: &mut Value) -> i64 {
    let mut repaired = 0i64;
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return repaired;
    };

    for choice in choices {
        let Some(message) = choice.get_mut("message").and_then(|v| v.as_object_mut()) else {
            continue;
        };
        let Some(tool_calls) = message.get_mut("tool_calls").and_then(|v| v.as_array_mut()) else {
            continue;
        };

        for tool_call in tool_calls.iter_mut() {
            let Some(function) = tool_call
                .get_mut("function")
                .and_then(|v| v.as_object_mut())
            else {
                continue;
            };
            let Some(name) = read_trimmed_string(function.get("name")) else {
                continue;
            };
            if name.to_ascii_lowercase() != "apply_patch" {
                continue;
            }

            if let Some(args) = function.get_mut("arguments") {
                if let Some(normalized) = normalize_tool_args("apply_patch", Some(args)) {
                    let next = Value::String(normalized);
                    if *args != next {
                        *args = next;
                        repaired += 1;
                    }
                }
            }
        }
    }

    repaired
}

fn remap_tool_calls_for_client_protocol(payload: &mut Value, client_protocol: &str) {
    let protocol = client_protocol.trim().to_ascii_lowercase();
    let wants_anthropic_shell = protocol == "anthropic-messages";
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return;
    };

    for choice in choices {
        let Some(tool_calls) = choice
            .get_mut("message")
            .and_then(|v| v.as_object_mut())
            .and_then(|message| message.get_mut("tool_calls"))
            .and_then(|v| v.as_array_mut())
        else {
            continue;
        };

        for tool_call in tool_calls {
            let Some(function) = tool_call
                .get_mut("function")
                .and_then(|v| v.as_object_mut())
            else {
                continue;
            };
            let Some(name) = read_trimmed_string(function.get("name")) else {
                continue;
            };
            let lowered = name.to_ascii_lowercase();
            let is_shell_alias = matches!(
                lowered.as_str(),
                "shell_command" | "shell" | "bash" | "terminal"
            );
            let is_exec_command = lowered == "exec_command";
            if !is_shell_alias && !is_exec_command {
                continue;
            }

            let target_name = if wants_anthropic_shell {
                if is_shell_alias {
                    "shell_command"
                } else {
                    "exec_command"
                }
            } else {
                "exec_command"
            };
            function.insert("name".to_string(), Value::String(target_name.to_string()));

            let Some(arguments) = function.get("arguments").cloned() else {
                continue;
            };
            let normalized_args = if wants_anthropic_shell && is_shell_alias {
                normalize_tool_args("shell_command", Some(&arguments))
            } else {
                normalize_tool_args("exec_command", Some(&arguments))
            };
            if let Some(normalized_args) = normalized_args {
                function.insert("arguments".to_string(), Value::String(normalized_args));
            }
        }
    }
}

fn count_normalized_tool_calls(payload: &Value) -> i64 {
    payload
        .get("choices")
        .and_then(|v| v.as_array())
        .map(|choices| {
            choices
                .iter()
                .map(|choice| {
                    choice
                        .get("message")
                        .and_then(|v| v.as_object())
                        .and_then(|message| message.get("tool_calls"))
                        .and_then(|v| v.as_array())
                        .map(|rows| rows.len() as i64)
                        .unwrap_or(0)
                })
                .sum::<i64>()
        })
        .unwrap_or(0)
}

fn prepare_payload_for_governance(
    payload: &Value,
) -> Result<ToolGovernancePreparationOutput, String> {
    let (mut prepared_payload, converted) = coerce_to_canonical_chat_completion(payload);
    let harvested_tool_calls =
        maybe_harvest_empty_tool_calls_from_json_content(&mut prepared_payload);
    let before_strip = prepared_payload.clone();
    strip_orphan_function_calls_tag(&mut prepared_payload);
    let shape_sanitized = harvested_tool_calls > 0 || prepared_payload != before_strip;

    Ok(ToolGovernancePreparationOutput {
        prepared_payload,
        summary: ToolGovernancePreparationSummary {
            converted,
            shape_sanitized,
            harvested_tool_calls,
        },
    })
}

pub fn govern_response(input: ToolGovernanceInput) -> Result<ToolGovernanceOutput, String> {
    let mut payload = input.payload.clone();

    let harvested = maybe_harvest_empty_tool_calls_from_json_content(&mut payload);
    strip_orphan_function_calls_tag(&mut payload);

    let apply_patch_repaired = normalize_apply_patch_tool_calls(&mut payload);
    remap_tool_calls_for_client_protocol(&mut payload, &input.client_protocol);
    let tool_calls_normalized = count_normalized_tool_calls(&payload);

    let applied = harvested > 0 || tool_calls_normalized > 0 || apply_patch_repaired > 0;

    Ok(ToolGovernanceOutput {
        governed_payload: payload,
        summary: ToolGovernanceSummary {
            applied,
            tool_calls_normalized,
            apply_patch_repaired,
        },
    })
}

#[napi]
pub fn govern_response_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ToolGovernanceInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = govern_response(input).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn prepare_resp_process_tool_governance_payload_json(
    payload_json: String,
) -> napi::Result<String> {
    if payload_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Payload JSON is empty"));
    }
    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload JSON: {}", e)))?;
    let output = prepare_payload_for_governance(&payload).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prepare_payload_for_governance_coerces_responses_shape_and_harvests_text() {
        let payload = serde_json::json!({
            "object": "response",
            "id": "resp_stage1_native",
            "model": "gpt-test",
            "status": "completed",
            "output_text": "<function_calls>```bash\npwd\n```</function_calls>",
            "output": []
        });

        let prepared = prepare_payload_for_governance(&payload).unwrap();
        assert!(prepared.summary.converted);
        assert!(prepared.summary.shape_sanitized);
        assert_eq!(prepared.summary.harvested_tool_calls, 1);
        assert_eq!(
            prepared.prepared_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
        assert_eq!(
            prepared.prepared_payload["choices"][0]["message"]["content"],
            ""
        );
    }

    #[test]
    fn test_govern_response_harvests_function_calls_shell_fence_before_tag_strip() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "content": "<function_calls>```bash\npwd\n```</function_calls>",
                        "tool_calls": []
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            request_id: "req_stage1_shell_fence".to_string(),
        };

        let governed = govern_response(input).unwrap();
        assert!(governed.summary.applied);
        assert_eq!(governed.summary.tool_calls_normalized, 1);
        assert_eq!(
            governed.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
        assert_eq!(governed.governed_payload["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(governed.governed_payload["choices"][0]["message"]["content"], "");
    }

    #[test]
    fn test_govern_response_empty_payload() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": []}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_123".to_string(),
        };
        let result = govern_response(input).unwrap();
        assert!(!result.summary.applied);
        assert_eq!(result.summary.tool_calls_normalized, 0);
        assert_eq!(result.summary.apply_patch_repaired, 0);
    }

    #[test]
    fn test_govern_response_with_tool_calls() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": [{"message": {"tool_calls": [{"function": {"name": "exec_command", "arguments": "{}"}}]}}]}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_123".to_string(),
        };
        let result = govern_response(input).unwrap();
        assert!(result.summary.applied);
        assert_eq!(result.summary.tool_calls_normalized, 1);
    }

    #[test]
    fn test_govern_response_apply_patch_repair() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": [{"message": {"tool_calls": [{"function": {"name": "apply_patch", "arguments": "{\"patch\": \"test\"}"}}]}}]}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_123".to_string(),
        };
        let result = govern_response(input).unwrap();
        assert!(result.summary.applied);
        assert_eq!(result.summary.apply_patch_repaired, 1);
        let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
            ["arguments"]
            .as_str()
            .unwrap_or("");
        let parsed: Value = serde_json::from_str(args).unwrap();
        assert_eq!(parsed["patch"].as_str().unwrap_or(""), "test");
        assert_eq!(parsed["input"].as_str().unwrap_or(""), "test");
    }

    #[test]
    fn test_govern_response_apply_patch_inline_create_file_shape() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [{
                            "function": {
                                "name": "apply_patch",
                                "arguments": "*** Begin Patch *** Create File: src/a.ts\nconsole.log('ok')\n*** End Patch"
                            }
                        }]
                    }
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_123".to_string(),
        };
        let result = govern_response(input).unwrap();
        let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
            ["arguments"]
            .as_str()
            .unwrap_or("");
        let parsed: Value = serde_json::from_str(args).unwrap();
        let patch = parsed["patch"].as_str().unwrap_or("");
        assert!(patch.contains("*** Begin Patch"));
        assert!(patch.contains("*** Add File: src/a.ts"));
        assert!(patch.contains("+console.log('ok')"));
        assert!(patch.contains("*** End Patch"));
    }

    #[test]
    fn test_govern_response_apply_patch_strips_quoted_paths() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [{
                            "function": {
                                "name": "apply_patch",
                                "arguments": "*** Begin Patch\n*** Add File: \"src/quoted.ts\"\n+console.log('ok')\n*** End Patch"
                            }
                        }]
                    }
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_quoted_path".to_string(),
        };
        let result = govern_response(input).unwrap();
        let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
            ["arguments"]
            .as_str()
            .unwrap_or("");
        let parsed: Value = serde_json::from_str(args).unwrap();
        let patch = parsed["patch"].as_str().unwrap_or("");
        assert!(patch.contains("*** Add File: src/quoted.ts"));
        assert!(!patch.contains("*** Add File: \"src/quoted.ts\""));
    }

    #[test]
    fn test_strip_orphan_function_calls_tag() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": [{"message": {"content": "<function_calls>{\"name\": \"test\"}</function_calls>"}}]}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_123".to_string(),
        };
        let result = govern_response(input).unwrap();
        let content = result.governed_payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap();
        assert!(!content.contains("<function_calls>"));
        assert!(!content.contains("</function_calls>"));
    }

    #[test]
    fn test_normalize_tool_name_shell_command_preserve() {
        assert_eq!(
            normalize_tool_name("functions.shell_command"),
            Some("shell_command".to_string())
        );
        assert!(normalize_tool_name("totally_unknown_tool").is_none());
    }

    #[test]
    fn test_normalize_tool_name_edge_cases() {
        assert!(normalize_tool_name("").is_none());
        assert!(normalize_tool_name("   ").is_none());
        assert!(normalize_tool_name("functions.").is_none());
        assert_eq!(
            normalize_tool_name("  FuNcTiOnS.SHELL_COMMAND "),
            Some("shell_command".to_string())
        );
    }

    #[test]
    fn test_parse_json_record_edge_cases() {
        let empty = Value::String("   ".to_string());
        let parsed = parse_json_record(Some(&empty)).unwrap();
        assert!(parsed.is_empty());

        let none = parse_json_record(Some(&Value::Null));
        assert!(none.is_none());

        let raw = Value::String("{\"note\":\"a\rb\"}".to_string());
        let parsed = parse_json_record(Some(&raw)).unwrap();
        assert_eq!(parsed.get("note").and_then(Value::as_str), Some("a\rb"));

        let arr = Value::Array(vec![Value::Null, Value::String("".to_string())]);
        assert!(read_string_array_command(Some(&arr)).is_none());
    }

    #[test]
    fn test_workdir_and_tool_args_missing_paths() {
        let mut args = Map::new();
        args.insert("input".to_string(), json!({"cwd": "/tmp/cwd"}));
        assert_eq!(read_workdir_from_args(&args), Some("/tmp/cwd".to_string()));

        let raw_args = json!({});
        assert!(normalize_tool_args("shell", Some(&raw_args)).is_none());

        let raw_args = json!({"session_id": "abc"});
        assert!(normalize_tool_args("write_stdin", Some(&raw_args)).is_none());
    }

    #[test]
    fn test_extract_balanced_json_object_edges() {
        assert!(extract_balanced_json_object_at("xx", 0).is_none());
        assert!(extract_balanced_json_object_at("{", 0).is_none());
    }

    #[test]
    fn test_extract_json_candidates_edge_cases() {
        let text = "```json\n{\"a\":1}\n";
        assert!(extract_json_candidates_from_text(text).is_empty());

        let text = "\"tool_calls\"";
        assert!(!extract_json_candidates_from_text(text).is_empty());
    }

    #[test]
    fn test_qwen_marker_unknown_tool_skips() {
        let text = "<|tool_call_begin|>unknown<|tool_call_argument_begin|>{\"command\":\"pwd\"}<|tool_call_end|>";
        assert!(extract_tool_calls_from_qwen_markers(text, 1).is_empty());
    }

    #[test]
    fn test_message_candidates_misc() {
        let msg = json!({"content": [1, {"text": "x"}, {"content": "y"}]});
        let parts = read_message_text_candidates(msg.as_object().unwrap());
        assert_eq!(parts.len(), 2);
    }

    #[test]
    fn test_strip_orphan_function_calls_tag_json_empty() {
        let result = strip_orphan_function_calls_tag_json("".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_normalize_apply_patch_tool_calls_noop_and_count() {
        let normalized = normalize_tool_args(
            "apply_patch",
            Some(&Value::String(
                r#"{"patch":"*** Begin Patch\n*** End Patch"}"#.to_string(),
            )),
        )
        .unwrap();
        let mut payload = json!({
            "choices": [{
                "message": {
                    "tool_calls": [{"function": {"name": "apply_patch", "arguments": normalized.clone()}}]
                }
            }]
        });
        let repaired = normalize_apply_patch_tool_calls(&mut payload);
        assert_eq!(repaired, 0);

        let payload = json!({
            "choices": [{
                "message": {"tool_calls": [{"function": {"name": "exec_command", "arguments": "{}"}}, {"function": {"name": "exec_command", "arguments": "{}"}}]}
            }]
        });
        assert_eq!(count_normalized_tool_calls(&payload), 2);
    }

    #[test]
    fn test_harvest_tool_calls_from_function_calls_json() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "<function_calls>{\"tool_calls\":[{\"id\":\"call_abc\",\"type\":\"function\",\"function\":{\"name\":\"shell_command\",\"arguments\":{\"command\":\"pwd\",\"cwd\":\"/tmp\"}}}]}</function_calls>"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "anthropic-messages".to_string(),
            entry_endpoint: "/v1/messages".to_string(),
            request_id: "req_tool_harvest_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert_eq!(
            message["tool_calls"][0]["function"]["name"],
            "shell_command"
        );

        let args_str = message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap();
        let args_json: Value = serde_json::from_str(args_str).unwrap();
        assert_eq!(args_json["command"], "pwd");
        assert_eq!(args_json["cwd"], "/tmp");
        assert_eq!(message["content"], "");
    }

    #[test]
    fn test_strip_orphan_function_calls_tag_json_api() {
        let payload = serde_json::json!({
            "choices": [{
                "message": { "content": "<function_calls>{\"name\":\"exec_command\"}</function_calls>" }
            }]
        });
        let output = strip_orphan_function_calls_tag_json(payload.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();
        let content = parsed["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");
        assert!(!content.contains("<function_calls>"));
        assert!(!content.contains("</function_calls>"));
    }

    #[test]
    fn test_harvest_tool_calls_when_tool_calls_field_missing() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "content": "{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"ls\",\"workdir\":\"/Users\"}}]}"
                    }
                }]
            }),
            client_protocol: "anthropic-messages".to_string(),
            entry_endpoint: "/v1/messages".to_string(),
            request_id: "req_tool_harvest_2".to_string(),
        };

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
    }

    #[test]
    fn test_shape_harvest_does_not_infer_tool_call_from_plain_bash_fence_text() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "先检查实现。\n```bash\npwd\n```\n然后继续\n```bash\ncat src/runtime/event-bus.ts | head -100\n```"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_bash_fence_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 0);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "stop"
        );
        assert_eq!(message["tool_calls"], json!([]));
        assert_ne!(message["content"], "");
    }

    #[test]
    fn test_harvest_tool_calls_from_qwen_markers() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "继续\n<|tool_calls_section_begin|>\n<|tool_call_begin|> functions.exec_command:66 <|tool_call_argument_begin|> {\"cmd\":\"pwd\",\"workdir\":\"/tmp\"} <|tool_call_end|>\n<|tool_calls_section_end|>\n"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_qwen_marker_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
        let args_str = message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
        assert_eq!(args_json["cmd"], "pwd");
        assert_eq!(args_json["workdir"], "/tmp");
    }

    #[test]
    fn test_harvest_qwen_markers_repairs_newline_inside_json_string() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "继续\n<|tool_calls_section_begin|>\n<|tool_call_begin|> functions.exec_command:45 <|tool_call_argument_begin|> {\"command\":\"head -70 /tmp/a.py\nmore.py\"} <|tool_call_end|>\n<|tool_calls_section_end|>\n"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_qwen_marker_2".to_string(),
        };

        let result = govern_response(input).unwrap();
        let args_str = result.governed_payload["choices"][0]["message"]["tool_calls"][0]
            ["function"]["arguments"]
            .as_str()
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
        let cmd = args_json["cmd"].as_str().unwrap_or("");
        assert!(cmd.contains("head -70 /tmp/a.py"));
        assert!(cmd.contains("more.py"));
    }

    #[test]
    fn test_harvest_qwen_markers_with_split_marker_tokens() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "The push command is running.\n<|tool_calls_section_begin|> <|\n  tool_call_begin|> functions.write_stdin:69 <|tool_call_argument_begin|> {} <|\n  tool_call_end|> <|tool_calls_section_end|>"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_qwen_marker_split_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "write_stdin"
        );
    }

    #[test]
    fn test_quote_wrapped_tool_calls_can_be_harvested() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "原文是：<quote>{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"git status\"}}]}</quote>"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_quote_skip_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        let tool_calls = message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0]["function"]["name"], "exec_command");
    }

    #[test]
    fn test_error_empty_json_input() {
        let result = govern_response_json("".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Input JSON is empty"));
    }

    #[test]
    fn test_error_invalid_json_input() {
        let result = govern_response_json("invalid".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Failed to parse input JSON"));
    }

    #[test]
    fn test_govern_response_no_tool_calls() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": [{"message": {"content": "Hello, world!"}}]}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_123".to_string(),
        };
        let result = govern_response(input).unwrap();
        assert!(!result.summary.applied);
        assert_eq!(result.summary.tool_calls_normalized, 0);
    }
    #[test]
    fn test_apply_patch_helpers() {
        assert_eq!(
            normalize_apply_patch_header_line(r#"*** Add File: "src/a.ts" ***"#),
            "*** Add File: src/a.ts"
        );
        assert_eq!(
            normalize_apply_patch_header_line(r#"*** Update File: `src/b.ts`"#),
            "*** Update File: src/b.ts"
        );
        assert_eq!(
            normalize_apply_patch_header_line(r#"*** Delete File: 'src/c.ts'"#),
            "*** Delete File: src/c.ts"
        );

        let input = r#"*** Add File: a.ts
console.log('ok')"#;
        let normalized = normalize_apply_patch_text(input);
        assert!(normalized.contains("*** Begin Patch"));
        assert!(normalized.contains("*** Add File: a.ts"));
        assert!(normalized.contains("+console.log('ok')"));
        assert!(normalized.contains("*** End Patch"));

        let input = r#"*** Begin Patch *** Create File: a.ts
+ok
*** End Patch"#;
        let normalized = normalize_apply_patch_text(input);
        assert!(normalized.contains("*** Begin Patch"));
        assert!(normalized.contains("*** Add File: a.ts"));
        assert!(normalized.contains("*** End Patch"));
    }

    #[test]
    fn test_parse_helpers_and_normalizers() {
        let raw = Value::String("{\"note\":\"line1\nline2\"}".to_string());
        let parsed = parse_json_record(Some(&raw)).unwrap();
        assert_eq!(
            parsed.get("note").and_then(Value::as_str),
            Some("line1\nline2")
        );

        let arr = Value::Array(vec![
            Value::String(" ls ".to_string()),
            Value::Number(1.into()),
            Value::Null,
            Value::String("".to_string()),
        ]);
        assert_eq!(
            read_string_array_command(Some(&arr)),
            Some("ls 1".to_string())
        );

        let mut args = Map::new();
        args.insert("command".to_string(), Value::String("pwd".to_string()));
        assert_eq!(read_command_from_args(&args), Some("pwd".to_string()));

        let mut args = Map::new();
        args.insert("input".to_string(), json!({"command": "ls"}));
        assert_eq!(read_command_from_args(&args), Some("ls".to_string()));

        let mut args = Map::new();
        args.insert("workDir".to_string(), Value::String("/tmp".to_string()));
        assert_eq!(read_workdir_from_args(&args), Some("/tmp".to_string()));

        assert_eq!(decode_escaped_newlines_if_needed("a\\n b"), "a\n b");
        assert_eq!(decode_escaped_newlines_if_needed("a\n b"), "a\n b");

        let raw = Value::String(r#"{"patch":"*** Begin Patch\n*** End Patch"}"#.to_string());
        assert!(extract_apply_patch_text(Some(&raw))
            .unwrap()
            .contains("*** Begin Patch"));

        let raw = json!({"instructions": "*** Begin Patch\n*** End Patch"});
        assert_eq!(
            extract_apply_patch_text(Some(&raw)).unwrap(),
            "*** Begin Patch\n*** End Patch"
        );

        assert_eq!(
            normalize_apply_patch_header_path("\"src/a.ts\""),
            "src/a.ts"
        );
    }

    #[test]
    fn test_normalize_tool_args_variants() {
        let raw_args = json!({"command": "pwd", "cwd": "/tmp"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["cmd"], "pwd");
        assert_eq!(parsed["command"], "pwd");
        assert_eq!(parsed["workdir"], "/tmp");

        let raw_args = json!({"sessionId": "123", "text": 42});
        let out = normalize_tool_args("write_stdin", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["session_id"], 123);
        assert_eq!(parsed["chars"], "42");

        let raw_args = Value::String("  ".to_string());
        assert!(normalize_tool_args("apply_patch", Some(&raw_args)).is_none());

        let raw_args = json!({"command": "pwd"});
        assert!(normalize_tool_args("bash", Some(&raw_args)).is_some());
    }

    #[test]
    fn test_json_extraction_helpers() {
        let text = "xx {\"a\":1} yy";
        let idx = text.find('{').unwrap();
        assert_eq!(
            extract_balanced_json_object_at(text, idx).unwrap(),
            "{\"a\":1}"
        );
        assert!(extract_balanced_json_object_at("nope", 0).is_none());

        let fenced = "```json\n{\"tool_calls\": []}\n```";
        let out = extract_json_candidates_from_text(fenced);
        assert!(!out.is_empty());

        let marker = "prefix {\"tool_calls\": []} suffix";
        let out = extract_json_candidates_from_text(marker);
        assert!(!out.is_empty());

        let quote_wrapped = "<quote>{tool_calls:[{name:'exec_command',input:{cmd:'pwd'}}]}</quote>";
        let out = extract_json_candidates_from_text(quote_wrapped);
        assert!(!out.is_empty());
    }

    #[test]
    fn test_tool_call_entry_and_qwen_marker_parsing() {
        let entry = json!({"function": {"name": "exec_command", "arguments": {"command": "pwd"}}});
        let out = normalize_tool_call_entry(&entry, 1).unwrap();
        assert_eq!(out["function"]["name"], "exec_command");

        let entry = json!({"input": {"cmd": "pwd", "justification": "check"}});
        let out = normalize_tool_call_entry(&entry, 2).unwrap();
        assert_eq!(out["function"]["name"], "exec_command");
        let args = out["function"]["arguments"].as_str().unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(args_json["cmd"], "pwd");

        let entry = json!({"input": {"plan": [{"step":"继续执行","status":"in_progress"}], "explanation": "shape inference"}});
        let out = normalize_tool_call_entry(&entry, 3).unwrap();
        assert_eq!(out["function"]["name"], "update_plan");
        let args = out["function"]["arguments"].as_str().unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert!(args_json["plan"].is_array());

        let entry = json!({"function": {"name": "unknown_tool"}});
        assert!(normalize_tool_call_entry(&entry, 1).is_none());

        let obj = json!({"tool_calls": [{"function": {"name": "exec_command", "arguments": {"command": "pwd"}}}]});
        let out = extract_tool_call_entries_from_unknown(&obj);
        assert_eq!(out.len(), 1);

        let text = "<|tool_call_begin|>shell<|tool_call_argument_begin|>{\"command\":\"pwd\"}<|tool_call_end|>";
        let out = extract_tool_calls_from_qwen_markers(text, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
    }

    #[test]
    fn test_message_candidates_only() {
        let msg = json!({
            "content": [{"text": "a"}, {"content": "b"}],
            "reasoning": "r",
            "thinking": "t"
        });
        let row = msg.as_object().unwrap();
        let parts = read_message_text_candidates(row);
        assert_eq!(parts.len(), 4);
    }

    #[test]
    fn test_maybe_harvest_empty_tool_calls_paths() {
        // Existing tool_calls -> skip
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [{"function": {"name": "exec_command", "arguments": "{}"}}], "content": "x"},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            0
        );

        // Quote marker -> skip
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": "<quote>skip</quote>"},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            0
        );

        // Quote-wrapped JSON-ish payload should be harvested.
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": "原文是：<quote>{tool_calls:[{name:'exec_command',input:{cmd:'git status'}}]}</quote>"},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            1
        );
        assert_eq!(
            payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
        let args = payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(parsed["cmd"], "git status");
        assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");

        // Quote-wrapped tool_calls payload without explicit name should still infer exec_command.
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": "原文是：<quote>{tool_calls:[{input:{cmd:'pwd',justification:'check daemon'}}]}</quote>"},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            1
        );
        assert_eq!(
            payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
        let args = payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(parsed["cmd"], "pwd");
        assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");

        // Plain bash fence without tool_calls shape -> no harvest
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": "```bash\npwd\n```"},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            0
        );
        assert_eq!(payload["choices"][0]["finish_reason"], "stop");

        // Qwen markers -> harvest
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": "<|tool_call_begin|>shell<|tool_call_argument_begin|>{\"command\":\"pwd\"}<|tool_call_end|>"},
                "finish_reason": "length"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            1
        );
        assert_eq!(payload["choices"][0]["finish_reason"], "length");

        // Markdown bullet + JSON payload should still be harvested.
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": "• {\"tool_calls\":[{\"input\":{\"cmd\":\"cd /Users/fanzhang/Documents/github/webauto && node bin/webauto.mjs daemon start 2>&1\"},\"name\":\"exec_command\"}]}"},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            1
        );
        assert_eq!(
            payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );

        // Command values containing unescaped inner quotes should be repaired and harvested.
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": r#"{"tool_calls":[{"input":{"cmd":"bd --no-db create "Mailbox 统一消息与心跳优先级改造" --type epic --description "统一 mailbox 消息三段式格式""},"name":"exec_command"}]}"#},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            1
        );
        let args = payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert!(parsed["cmd"]
            .as_str()
            .unwrap_or("")
            .contains("Mailbox 统一消息与心跳优先级改造"));
        assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");

        // Truncated malformed tool_calls JSON should still be shape-repaired and harvested.
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": r#"{"tool_calls":[{"name":"exec_command","input":{"cmd":"bash -lc 'bd --no-db create "Mailbox 三段式消息生成器" --type task"#},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            1
        );
        assert_eq!(
            payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
        let args = payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert!(parsed["cmd"]
            .as_str()
            .unwrap_or("")
            .contains("Mailbox 三段式消息生成器"));
        assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");

        // Marker but invalid JSON -> no harvest
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": "{\"tool_calls\":["},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            0
        );
    }

    #[test]
    fn test_read_string_array_command_empty_tokens() {
        let arr = Value::Array(vec![
            Value::String("   ".to_string()),
            Value::Null,
            Value::String("\t".to_string()),
        ]);
        assert!(read_string_array_command(Some(&arr)).is_none());
    }

    #[test]
    fn test_parse_json_record_escape_branches_and_non_object() {
        let raw = Value::String("{\"note\":\"line1\\\"line2\nline3\rline4\"}".to_string());
        let parsed = parse_json_record(Some(&raw)).unwrap();
        let note = parsed.get("note").and_then(Value::as_str).unwrap_or("");
        assert!(note.contains("line3"));
        assert!(note.contains('\n'));

        let none = parse_json_record(Some(&Value::Bool(true)));
        assert!(none.is_none());
    }

    #[test]
    fn test_read_command_from_args_input_variants() {
        let mut args = Map::new();
        args.insert("input".to_string(), json!({"script": "echo hi"}));
        assert_eq!(read_command_from_args(&args), Some("echo hi".to_string()));

        let mut args = Map::new();
        args.insert("input".to_string(), json!({"command": ["ls", "-la"]}));
        assert_eq!(read_command_from_args(&args), Some("ls -la".to_string()));
    }

    #[test]
    fn test_read_workdir_from_args_input_variants() {
        let mut args = Map::new();
        args.insert("input".to_string(), json!({"workdir": "/tmp/inner"}));
        assert_eq!(
            read_workdir_from_args(&args),
            Some("/tmp/inner".to_string())
        );

        let mut args = Map::new();
        args.insert("input".to_string(), json!({"cwd": "/tmp/cwd"}));
        assert_eq!(read_workdir_from_args(&args), Some("/tmp/cwd".to_string()));
    }

    #[test]
    fn test_extract_apply_patch_text_variants() {
        let stars = "*".repeat(3);
        let raw_text = format!("{} {} {}", stars, "Begin", "Patch");
        let raw_text = format!("{}\n{} {}", raw_text, stars, "End Patch");
        let raw = json!({"text": raw_text});
        assert!(extract_apply_patch_text(Some(&raw))
            .unwrap()
            .contains("Patch"));

        let wrapped = json!({
            "ok": true,
            "result": {
                "command": "apply_patch *** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch"
            }
        });
        let extracted = extract_apply_patch_text(Some(&wrapped)).unwrap();
        assert!(extracted.starts_with("apply_patch *** Begin Patch"));

        let raw = Value::Bool(true);
        assert!(extract_apply_patch_text(Some(&raw)).is_none());
    }

    #[test]
    fn test_normalize_apply_patch_text_single_line_and_missing_end() {
        let stars = "*".repeat(3);
        let begin_marker = format!("{} {} {}", stars, "Begin", "Patch");
        let end_marker = format!("{} {} {}", stars, "End", "Patch");
        let update_marker = format!("{} {} {}", stars, "Update", "File:");
        let delete_marker = format!("{} {} {}", stars, "Delete", "File:");

        let input = format!(
            "{} {} {} {}",
            begin_marker, update_marker, "src/a.ts", end_marker
        );
        let normalized = normalize_apply_patch_text(&input);
        assert!(normalized.contains("Begin"));
        assert!(normalized.contains("Update"));
        assert!(normalized.contains("End"));

        let input = format!("{} {} {}", begin_marker, update_marker, "src/a.ts");
        let normalized = normalize_apply_patch_text(&input);
        assert!(normalized.contains("End"));

        let input = format!("{} {}", delete_marker, "src/a.ts");
        let normalized = normalize_apply_patch_text(&input);
        assert!(normalized.contains("Begin"));
        assert!(normalized.contains("Delete"));
        assert!(normalized.contains("End"));
    }

    #[test]
    fn test_normalize_apply_patch_text_preserves_blank_lines_in_add_file() {
        let input = "*** Begin Patch\n*** Add File: src/blank-lines.ts\nconst first = true;\n\nconst third = true;\n*** End Patch";
        let normalized = normalize_apply_patch_text(input);
        assert!(normalized.contains("+const first = true;\n+\n+const third = true;"));
    }

    #[test]
    fn test_normalize_apply_patch_header_path_empty() {
        assert_eq!(normalize_apply_patch_header_path("   "), "");
    }

    #[test]
    fn test_normalize_tool_args_apply_patch_strips_apply_patch_prefix() {
        let raw_args = json!({
            "command": "apply_patch *** Begin Patch\n*** Add File: src/new.ts\nconsole.log('ok');\n*** End Patch"
        });
        let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let patch = parsed["patch"].as_str().unwrap_or("");
        assert!(patch.starts_with("*** Begin Patch"));
        assert!(!patch.starts_with("apply_patch "));
        assert!(patch.contains("*** Add File: src/new.ts"));
    }

    #[test]
    fn test_normalize_tool_args_apply_patch_handles_legacy_unified_header_without_plus_line() {
        let raw_args = json!({
            "patch": "*** Begin Patch\n--- a/apps/mobile-app/src/services/mobileWebdavSync.ts\n@@ -1 +1 @@\n-old\n+new\n*** End Patch"
        });
        let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let patch = parsed["patch"].as_str().unwrap_or("");
        assert!(patch.contains("*** Update File: apps/mobile-app/src/services/mobileWebdavSync.ts"));
        assert!(!patch.contains("--- a/apps/mobile-app/src/services/mobileWebdavSync.ts"));
        assert!(patch.contains("@@ -1 +1 @@"));
    }

    #[test]
    fn test_normalize_tool_args_apply_patch_strips_context_diff_separator_lines() {
        let raw_args = json!({
            "patch": "*** Begin Patch\n*** Update File: src/a.ts\n***************\n@@ -1 +1 @@\n-old\n+new\n*** End Patch"
        });
        let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let patch = parsed["patch"].as_str().unwrap_or("");
        assert!(patch.contains("*** Update File: src/a.ts"));
        assert!(patch.contains("@@ -1 +1 @@"));
        assert!(!patch.contains("***************"));
    }

    #[test]
    fn test_normalize_tool_args_write_stdin_number_and_input() {
        let raw_args = json!({"session_id": 7, "input": "abc"});
        let out = normalize_tool_args("write_stdin", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["session_id"], 7);
        assert_eq!(parsed["chars"], "abc");

        let raw_args = json!({"session_id": true});
        assert!(normalize_tool_args("write_stdin", Some(&raw_args)).is_none());
    }

    #[test]
    fn test_normalize_tool_args_shell_input_command() {
        let raw_args = json!({"input": {"command": "pwd"}});
        let out = normalize_tool_args("shell", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["command"], "pwd");
        assert_eq!(parsed["cmd"], "pwd");
    }

    #[test]
    fn test_normalize_tool_args_exec_command_input_string_shape() {
        let raw_args = json!({"input": "git status"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["command"], "git status");
        assert_eq!(parsed["cmd"], "git status");
    }

    #[test]
    fn test_normalize_tool_args_exec_command_nested_args_command_shape() {
        let raw_args = json!({"args": {"command": "ls -la"}, "cwd": "/workspace"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["command"], "ls -la");
        assert_eq!(parsed["cmd"], "ls -la");
        assert_eq!(parsed["workdir"], "/workspace");
    }

    #[test]
    fn test_normalize_tool_args_write_stdin_data_field() {
        let raw_args = json!({"sessionId": "42", "data": {"x": 1}});
        let out = normalize_tool_args("write_stdin", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["session_id"], 42);
        assert_eq!(parsed["chars"], "{\"x\":1}");
    }

    #[test]
    fn test_normalize_tool_call_entry_input_and_missing_args() {
        let entry = json!({"function": {"name": "exec_command", "input": {"command": "pwd"}}});
        let out = normalize_tool_call_entry(&entry, 1).unwrap();
        assert_eq!(out["function"]["name"], "exec_command");

        let entry = json!({"function": {"name": "exec_command", "arguments": {}}});
        assert!(normalize_tool_call_entry(&entry, 1).is_none());

        let entry = Value::String("not an object".to_string());
        assert!(normalize_tool_call_entry(&entry, 1).is_none());
    }

    #[test]
    fn test_extract_tool_call_entries_from_unknown_non_object() {
        let value = Value::String("oops".to_string());
        assert!(extract_tool_call_entries_from_unknown(&value).is_empty());
    }

    #[test]
    fn test_extract_tool_call_entries_from_unknown_object() {
        let value = json!({"name": "exec_command", "arguments": {"command": "pwd"}});
        let out = extract_tool_call_entries_from_unknown(&value);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
    }

    #[test]
    fn test_extract_json_candidates_unclosed_fence() {
        let text = "```json\n{\"a\":1}\n";
        let out = extract_json_candidates_from_text(text);
        assert!(out.is_empty());
    }

    #[test]
    fn test_read_message_text_candidates_edge_paths() {
        let msg = json!({"content": "   "});
        let parts = read_message_text_candidates(msg.as_object().unwrap());
        assert!(parts.is_empty());

        let msg = json!({"content": [1, {"text": "ok"}, {"content": "more"}]});
        let parts = read_message_text_candidates(msg.as_object().unwrap());
        assert_eq!(parts.len(), 2);

        let msg = json!({"content": 123});
        let parts = read_message_text_candidates(msg.as_object().unwrap());
        assert!(parts.is_empty());
    }

    #[test]
    fn test_govern_response_json_success() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": []}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_json_ok".to_string(),
        };
        let output = govern_response_json(serde_json::to_string(&input).unwrap()).unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();
        assert!(parsed.get("summary").is_some());
    }

    #[test]
    fn test_govern_response_json_js_function_coverage() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": []}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_json_js".to_string(),
        };
        let output = govern_response_json(serde_json::to_string(&input).unwrap()).unwrap();
        assert!(output.contains("\"summary\""));
    }

    #[test]
    fn test_strip_orphan_function_calls_tag_json_js_function_coverage() {
        let payload = serde_json::json!({
            "choices": [{
                "message": { "content": "<function_calls>{\\\"name\\\":\\\"exec_command\\\"}</function_calls>" }
            }]
        });
        let output = strip_orphan_function_calls_tag_json(payload.to_string()).unwrap();
        assert!(!output.contains("<function_calls>"));
    }
}
