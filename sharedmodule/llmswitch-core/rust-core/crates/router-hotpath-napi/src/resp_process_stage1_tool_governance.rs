use crate::hub_bridge_actions::utils::{
    can_servertool_own_tool_call_id, create_harvested_tool_call_id, create_servertool_tool_call_id,
    is_synthetic_routecodex_tool_call_id,
};
use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::env;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

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
    pub disallowed_tool_calls_dropped: i64,
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

fn resolve_text_harvest_enabled(payload: &Value) -> bool {
    let governance = payload
        .as_object()
        .and_then(|row| row.get("__rcc_tool_governance"))
        .and_then(Value::as_object);
    if governance
        .and_then(|row| row.get("skipTextHarvest"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return false;
    }
    if let Some(enabled) = governance
        .and_then(|row| row.get("enableTextHarvest"))
        .and_then(Value::as_bool)
    {
        return enabled;
    }
    detect_text_tool_provider_family(payload) != TextToolProviderFamily::Other
        || payload_contains_harvestable_text_tool_payload(payload)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextToolProviderFamily {
    Other,
    DeepSeek,
    Qwen,
}

fn read_text_tool_provider_family_from_governance(
    payload: &Value,
) -> Option<TextToolProviderFamily> {
    let family = payload
        .as_object()
        .and_then(|row| row.get("__rcc_tool_governance"))
        .and_then(Value::as_object)
        .and_then(|row| row.get("providerFamily"))
        .and_then(Value::as_str)
        .map(|raw| raw.trim().to_ascii_lowercase())?;
    match family.as_str() {
        "deepseek" | "deepseek-web" => Some(TextToolProviderFamily::DeepSeek),
        "qwen" | "qwenchat" | "qwenchat-web" => Some(TextToolProviderFamily::Qwen),
        _ => Some(TextToolProviderFamily::Other),
    }
}

fn looks_like_text_tool_provider_token(raw: &str) -> TextToolProviderFamily {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return TextToolProviderFamily::Other;
    }
    if normalized.contains("deepseek") {
        return TextToolProviderFamily::DeepSeek;
    }
    if normalized.contains("qwen") {
        return TextToolProviderFamily::Qwen;
    }
    TextToolProviderFamily::Other
}

fn detect_text_tool_provider_family(payload: &Value) -> TextToolProviderFamily {
    if let Some(explicit) = read_text_tool_provider_family_from_governance(payload) {
        return explicit;
    }
    let Some(root) = payload.as_object() else {
        return TextToolProviderFamily::Other;
    };

    let mut candidates: Vec<String> = Vec::new();
    for key in ["model", "providerKey", "providerId", "runtimeKey"] {
        if let Some(raw) = read_trimmed_string(root.get(key)) {
            candidates.push(raw);
        }
    }
    if let Some(metadata) = root.get("metadata").and_then(Value::as_object) {
        for key in ["model", "providerKey", "providerId", "runtimeKey"] {
            if let Some(raw) = read_trimmed_string(metadata.get(key)) {
                candidates.push(raw);
            }
        }
        if metadata.get("deepseek").is_some() {
            candidates.push("deepseek".to_string());
        }
        if let Some(provider) = metadata.get("provider").and_then(Value::as_object) {
            for key in ["key", "id", "runtimeKey"] {
                if let Some(raw) = read_trimmed_string(provider.get(key)) {
                    candidates.push(raw);
                }
            }
        }
    }

    for candidate in candidates {
        let family = looks_like_text_tool_provider_token(candidate.as_str());
        if family != TextToolProviderFamily::Other {
            return family;
        }
    }
    TextToolProviderFamily::Other
}

fn text_contains_explicit_tool_markup(text: &str) -> bool {
    contains_explicit_tool_wrapper_marker(text)
}

fn contains_explicit_tool_wrapper_marker(raw: &str) -> bool {
    // Pre-normalize fullwidth pipe (U+FF5C) and block drawing chars (U+258F, U+2590)
    // DeepSeek sometimes emits DSML markup with fullwidth characters
    let pre_normalized: String = raw.trim().chars().map(|c| match c {
        '\u{ff5c}' | '\u{258f}' | '\u{2590}' => '|',
        c => c,
    }).collect();
    let normalized = normalize_dsml_tool_markup(pre_normalized.as_str());
    let lowered = normalized.to_ascii_lowercase();
    if lowered.is_empty() {
        return false;
    }
    lowered.contains("<<rcc_tool_calls")
        || lowered.contains("<function_calls>")
        || lowered.contains("</function_calls>")
        || lowered.contains("<|dsml|tool_calls>")
        || lowered.contains("</|dsml|tool_calls>")
        || lowered.contains("<|dsml|invoke")
        || lowered.contains("</|dsml|invoke>")
        || lowered.contains("<|dsml|parameter")
        || lowered.contains("</|dsml|parameter>")
        || lowered.contains("<tool_call>")
        || lowered.contains("</tool_call>")
        || lowered.contains("<tool_calls>")
        || lowered.contains("</tool_calls>")
        || lowered.contains("<invoke")
        || lowered.contains("</invoke>")
        || lowered.contains("<parameter")
        || lowered.contains("</parameter>")
}

fn strip_box_drawing_prefix(line: &str) -> String {
    Regex::new(r"^[\s│└├─]+")
        .map(|re| re.replace(line, "").to_string())
        .unwrap_or_else(|_| line.trim_start().to_string())
}

fn strip_terminal_right_gutter_noise(line: &str) -> String {
    Regex::new(r"\s+[│┃]\s*[·.]{6,}\s*$")
        .map(|re| re.replace(line, "").to_string())
        .unwrap_or_else(|_| line.to_string())
}

fn is_transcript_collapsed_placeholder(line: &str) -> bool {
    Regex::new(r"(?i)^\s*[│└├─\s]*[.…·]+\s*\+\d+\s+lines\s*$")
        .map(|re| re.is_match(line))
        .unwrap_or(false)
}

fn transcript_tree_marker(line: &str) -> Option<char> {
    line.trim_start()
        .chars()
        .next()
        .filter(|ch| matches!(ch, '│' | '└' | '├'))
}

fn unwrap_ran_transcript_shape(raw: &str) -> Option<String> {
    let lines: Vec<&str> = raw.lines().collect();
    let first = lines.first()?.trim_start();
    if !first.starts_with("• Ran ") {
        return None;
    }
    if lines.len() < 2 {
        return None;
    }
    let has_tree_body = lines.iter().skip(1).any(|line| {
        Regex::new(r"^[\s]*[│└├]")
            .map(|re| re.is_match(line))
            .unwrap_or(false)
    });
    if !has_tree_body {
        return None;
    }

    let mut out: Vec<String> = Vec::new();
    for line in lines.iter().skip(1) {
        if is_transcript_collapsed_placeholder(line) {
            continue;
        }
        match transcript_tree_marker(line) {
            Some('└') => {}
            Some('│') | Some('├') => continue,
            _ => {}
        }
        let stripped = strip_box_drawing_prefix(line).trim().to_string();
        if stripped.is_empty() || stripped.eq_ignore_ascii_case("(ctrl + t to view transcript)") {
            continue;
        }
        out.push(stripped);
    }
    let text = out.join("\n").trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn is_chunked_exec_transcript_header_line(line: &str) -> bool {
    Regex::new(
        r"(?i)^(?:\[工具结果\]|Command:\s+.*|Chunk ID:\s+.*|Wall time:\s+.*|Process exited with code\s+.*|Process running with session ID\s+.*|Original token count:\s+.*)$",
    )
    .map(|re| re.is_match(line.trim()))
    .unwrap_or(false)
}

fn unwrap_chunked_exec_transcript_shape(raw: &str) -> Option<String> {
    let lines: Vec<&str> = raw.lines().collect();
    if lines.is_empty() {
        return None;
    }
    let output_idx = lines
        .iter()
        .position(|line| line.trim().eq_ignore_ascii_case("Output:"))?;
    let header = &lines[..output_idx];
    if header.is_empty()
        || !header
            .iter()
            .all(|line| is_chunked_exec_transcript_header_line(line))
    {
        return None;
    }
    Some(
        lines
            .iter()
            .skip(output_idx + 1)
            .copied()
            .collect::<Vec<&str>>()
            .join("\n")
            .trim()
            .to_string(),
    )
}

fn sanitize_text_harvest_shape(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let without_gutter = trimmed
        .lines()
        .map(strip_terminal_right_gutter_noise)
        .collect::<Vec<String>>()
        .join("\n");
    if let Some(unwrapped) = unwrap_chunked_exec_transcript_shape(without_gutter.as_str()) {
        return unwrapped;
    }
    if let Some(unwrapped) = unwrap_ran_transcript_shape(without_gutter.as_str()) {
        return unwrapped;
    }
    without_gutter.trim().to_string()
}

fn collect_stage1_harvest_input_texts(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::<String>::new();
    let mut push = |value: String| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        if seen.insert(trimmed.clone()) {
            out.push(trimmed);
        }
    };

    push(raw.to_string());
    push(sanitize_text_harvest_shape(raw));
    out
}

fn payload_contains_harvestable_text_tool_payload(payload: &Value) -> bool {
    let Some(choices) = payload.get("choices").and_then(Value::as_array) else {
        return false;
    };

    choices.iter().any(|choice| {
        choice
            .get("message")
            .and_then(Value::as_object)
            .map(|message| {
                read_message_text_candidates(message)
                    .iter()
                    .any(|text| {
                        collect_stage1_harvest_input_texts(text)
                            .iter()
                            .any(|candidate| {
                                text_contains_explicit_tool_markup(candidate)
                                    || !extract_tool_calls_from_text_candidate(candidate, 1)
                                        .is_empty()
                            })
                    })
            })
            .unwrap_or(false)
    })
}

fn detect_unharvested_text_tool_markup(payload: &Value) -> Option<&'static str> {
    let choices = payload.get("choices").and_then(Value::as_array)?;

    for choice in choices {
        let Some(message) = choice.get("message").and_then(Value::as_object) else {
            continue;
        };
        let has_tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false);
        if has_tool_calls {
            continue;
        }
        for text in read_message_text_candidates(message) {
            for candidate in collect_stage1_harvest_input_texts(&text) {
                let cleaned = strip_orphan_tool_markup_lines(
                    strip_tool_call_marker_payload(candidate.as_str()).as_str(),
                );
                if contains_explicit_tool_wrapper_marker(cleaned.as_str())
                    && explicit_wrapper_inner_payload_has_tool_name_marker(cleaned.as_str())
                {
                    return Some("explicit_tool_wrapper");
                }
            }
        }
    }

    None
}

fn explicit_wrapper_inner_payload_has_tool_name_marker(raw: &str) -> bool {
    let Some(inner) = extract_explicit_tool_wrapper_inner_payload(raw) else {
        return false;
    };
    let lowered = inner.to_ascii_lowercase();
    lowered.contains("\"name\"")
        || lowered.contains("'name'")
        || lowered.contains("<name>")
        || lowered.contains("tool_name")
        || lowered.contains("\"function\"")
}

fn strip_internal_tool_governance_state(payload: &mut Value) {
    let Some(root) = payload.as_object_mut() else {
        return;
    };
    root.remove("__rcc_tool_governance");
}

fn copy_internal_tool_governance_state(source: &Value, target: &mut Value) {
    let source_state = source
        .as_object()
        .and_then(|root| root.get("__rcc_tool_governance"))
        .cloned();
    let Some(source_state) = source_state else {
        return;
    };
    let Some(target_root) = target.as_object_mut() else {
        return;
    };
    if !target_root.contains_key("__rcc_tool_governance") {
        target_root.insert("__rcc_tool_governance".to_string(), source_state);
    }
}

fn normalize_requested_tool_name_key(raw_name: &str) -> Option<String> {
    let normalized = normalize_tool_name(raw_name)?;
    let key = normalized.trim().to_ascii_lowercase();
    if key.is_empty() {
        return None;
    }
    Some(key)
}

fn collect_requested_tool_name_keys_from_candidate(
    candidate: Option<&Value>,
    out: &mut HashSet<String>,
) {
    let Some(value) = candidate else {
        return;
    };
    let Some(rows) = value.as_array() else {
        return;
    };

    for row in rows {
        if let Some(raw_name) = row.as_str() {
            if let Some(key) = normalize_requested_tool_name_key(raw_name) {
                out.insert(key);
            }
            continue;
        }
        let Some(obj) = row.as_object() else {
            continue;
        };
        let raw_name = obj
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| read_trimmed_string(function.get("name")))
            .or_else(|| read_trimmed_string(obj.get("name")));
        if let Some(raw_name) = raw_name {
            if let Some(key) = normalize_requested_tool_name_key(raw_name.as_str()) {
                out.insert(key);
            }
        }
    }
}

fn collect_requested_tool_name_keys(payload: &Value) -> HashSet<String> {
    let mut out = HashSet::new();
    let root = match payload.as_object() {
        Some(root) => root,
        None => return out,
    };

    let governance = root.get("__rcc_tool_governance").and_then(Value::as_object);
    collect_requested_tool_name_keys_from_candidate(root.get("tools"), &mut out);
    collect_requested_tool_name_keys_from_candidate(
        governance.and_then(|row| row.get("requestedToolNames")),
        &mut out,
    );
    collect_requested_tool_name_keys_from_candidate(
        governance.and_then(|row| row.get("allowedToolNames")),
        &mut out,
    );
    out
}

fn read_tool_call_name_key(tool_call: &Value) -> Option<String> {
    let raw_name = tool_call
        .as_object()
        .and_then(|row| row.get("function"))
        .and_then(Value::as_object)
        .and_then(|function| read_trimmed_string(function.get("name")))?;
    normalize_requested_tool_name_key(raw_name.as_str())
}

fn retain_allowed_tool_calls(
    tool_calls: &mut Vec<Value>,
    requested_tool_name_keys: &HashSet<String>,
) -> i64 {
    if requested_tool_name_keys.is_empty() {
        return 0;
    }
    let before = tool_calls.len();
    tool_calls.retain(|entry| {
        read_tool_call_name_key(entry)
            .map(|key| requested_tool_name_keys.contains(key.as_str()))
            .unwrap_or(false)
    });
    (before.saturating_sub(tool_calls.len())) as i64
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

fn escape_invalid_backslashes_inside_json_strings(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len() + 16);
    let mut in_string = false;
    let mut escaped = false;
    let mut idx = 0usize;

    while idx < chars.len() {
        let ch = chars[idx];
        if in_string {
            if escaped {
                let is_valid_json_escape = matches!(
                    ch,
                    '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u'
                );
                if !is_valid_json_escape {
                    out.push('\\');
                }
                out.push(ch);
                escaped = false;
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
                in_string = false;
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
    let escaped_invalid_backslashes =
        escape_invalid_backslashes_inside_json_strings(trimmed);
    if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_invalid_backslashes) {
        return Some(parsed);
    }
    let escaped_invalid_backslashes_newlines =
        escape_newlines_inside_json_strings(&escaped_invalid_backslashes);
    if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_invalid_backslashes_newlines) {
        return Some(parsed);
    }
    let escaped_invalid_backslashes_quotes =
        escape_unescaped_quotes_inside_json_strings(&escaped_invalid_backslashes);
    if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_invalid_backslashes_quotes) {
        return Some(parsed);
    }
    let escaped_invalid_backslashes_quotes_newlines =
        escape_newlines_inside_json_strings(&escaped_invalid_backslashes_quotes);
    if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_invalid_backslashes_quotes_newlines)
    {
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
    let escaped_candidate_invalid_backslashes =
        escape_invalid_backslashes_inside_json_strings(candidate.as_str());
    if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_candidate_invalid_backslashes) {
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
    let escaped_candidate_invalid_backslashes_mix =
        escape_newlines_inside_json_strings(&escaped_candidate_invalid_backslashes);
    if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_candidate_invalid_backslashes_mix) {
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
        let escaped_invalid_backslashes =
            escape_invalid_backslashes_inside_json_strings(matched.as_str());
        if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_invalid_backslashes) {
            return Some(parsed);
        }
        let escaped_mix = escape_newlines_inside_json_strings(&escaped_quotes);
        if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_mix) {
            return Some(parsed);
        }
        let escaped_invalid_backslashes_mix =
            escape_newlines_inside_json_strings(&escaped_invalid_backslashes);
        if let Ok(parsed) = serde_json::from_str::<Value>(&escaped_invalid_backslashes_mix) {
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

const EXEC_COMMAND_HEREDOC_BLOCK_THRESHOLD: usize = 4096;
const EXEC_COMMAND_HEREDOC_PREVIEW_CHARS: usize = 240;

fn truncate_preview(raw: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    for ch in raw.chars() {
        if count >= max_chars {
            out.push('…');
            break;
        }
        out.push(ch);
        count += 1;
    }
    out
}

fn shell_single_quote(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "'\"'\"'"))
}

fn extract_exec_command_preview_from_malformed_args(raw: &str) -> String {
    let lowered = raw.to_ascii_lowercase();
    let key = if lowered.contains("\"cmd\"") {
        "\"cmd\""
    } else if lowered.contains("\"command\"") {
        "\"command\""
    } else {
        ""
    };
    if key.is_empty() {
        return truncate_preview(raw.trim(), EXEC_COMMAND_HEREDOC_PREVIEW_CHARS);
    }
    let Some(idx) = raw.find(key) else {
        return truncate_preview(raw.trim(), EXEC_COMMAND_HEREDOC_PREVIEW_CHARS);
    };
    truncate_preview(raw[idx..].trim(), EXEC_COMMAND_HEREDOC_PREVIEW_CHARS)
}

fn is_large_heredoc_file_generation_command(cmd: &str) -> bool {
    if cmd.len() < EXEC_COMMAND_HEREDOC_BLOCK_THRESHOLD {
        return false;
    }
    Regex::new(r#"(?is)\bcat\s*>\s*\S+\s*<<\s*['"]?[A-Za-z0-9_:-]+['"]?"#)
        .map(|re| re.is_match(cmd))
        .unwrap_or(false)
}

fn build_exec_command_large_write_guard_command(preview: &str) -> String {
    let message = format!(
        "[routecodex] exec_command blocked: large heredoc file generation was truncated before execution. \
Use apply_patch for file creation or updates instead of cat <<EOF / bulk shell writes. \
Adjust and retry with apply_patch. Command preview: {}",
        preview
    );
    format!("printf '%s\\n' {} >&2; exit 64", shell_single_quote(message.as_str()))
}

fn build_exec_command_object_with_shape(
    cmd: String,
    args: Option<&Map<String, Value>>,
    source_is_shell_alias: bool,
    force_cmd: Option<bool>,
    force_command: Option<bool>,
) -> Option<String> {
    let empty = Map::new();
    let args = args.unwrap_or(&empty);
    let mut out = Map::new();
    let has_cmd = force_cmd.unwrap_or_else(|| args_contain_direct_or_nested_key(args, "cmd"));
    let has_command =
        force_command.unwrap_or_else(|| args_contain_direct_or_nested_key(args, "command"));
    let emit_cmd = has_cmd || (!has_command && !source_is_shell_alias);
    let emit_command = has_command || (source_is_shell_alias && !has_cmd);
    if emit_command {
        out.insert("command".to_string(), Value::String(cmd.clone()));
    }
    if emit_cmd {
        out.insert("cmd".to_string(), Value::String(cmd));
    }
    if let Some(workdir) = read_workdir_from_args(args) {
        out.insert("workdir".to_string(), Value::String(workdir));
    }
    serde_json::to_string(&Value::Object(out)).ok()
}

fn maybe_guard_large_exec_command_from_raw_string(
    raw_args: Option<&Value>,
    source_is_shell_alias: bool,
) -> Option<String> {
    let raw = match raw_args {
        Some(Value::String(raw)) => raw.trim(),
        _ => return None,
    };
    if raw.is_empty() {
        return None;
    }
    let lowered = raw.to_ascii_lowercase();
    if raw.len() < EXEC_COMMAND_HEREDOC_BLOCK_THRESHOLD
        || !lowered.contains("cat >")
        || !lowered.contains("<<")
        || (!lowered.contains("\"cmd\"") && !lowered.contains("\"command\""))
    {
        return None;
    }
    let preview = extract_exec_command_preview_from_malformed_args(raw);
    let guard = build_exec_command_large_write_guard_command(preview.as_str());
    let has_cmd = lowered.contains("\"cmd\"");
    let has_command = lowered.contains("\"command\"");
    build_exec_command_object_with_shape(
        guard,
        None,
        source_is_shell_alias,
        Some(has_cmd),
        Some(has_command),
    )
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

fn repair_shell_wrapper_shape(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut current = trimmed.to_string();
    if let Some(rest) = current.strip_prefix("bash-lc") {
        let next = rest.chars().next();
        if next.is_none() || next.is_some_and(|ch| ch.is_whitespace() || ch == '\'' || ch == '"') {
            current = format!("bash -lc{}", rest);
        }
    }
    if let Some(rest) = current.strip_prefix("bash -lc\"") {
        current = format!("bash -lc \"{}", rest);
    } else if let Some(rest) = current.strip_prefix("bash -lc'") {
        current = format!("bash -lc '{}", rest);
    }

    current
}

fn find_matching_double_quote(raw: &str, start_idx: usize) -> Option<usize> {
    let bytes = raw.as_bytes();
    let mut idx = start_idx;
    let mut escaped = false;
    while idx < bytes.len() {
        let ch = bytes[idx] as char;
        if escaped {
            escaped = false;
            idx += 1;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            idx += 1;
            continue;
        }
        if ch == '"' {
            return Some(idx);
        }
        idx += 1;
    }
    None
}

fn looks_like_inline_interpreter_eval_prefix(raw: &str) -> bool {
    Regex::new(
        r#"(?is)\b(?:node|bun|deno|python|python2|python3|python\d+(?:\.\d+)?|ruby|perl)\b[\s\S]*?(?:\s-e\b|\s-c\b|\s--eval\b)\s*$"#,
    )
    .map(|re| re.is_match(raw))
    .unwrap_or(false)
}

fn repair_bash_lc_inline_eval_single_quotes(raw: &str) -> String {
    let trimmed = raw.trim();
    let Some(inner) = trimmed
        .strip_prefix("bash -lc '")
        .and_then(|value| value.strip_suffix('\''))
    else {
        return trimmed.to_string();
    };

    let bytes = inner.as_bytes();
    let mut cursor = 0usize;
    let mut repaired = inner.to_string();
    let mut changed = false;

    while cursor < bytes.len() {
        let Some(rel_quote_idx) = inner[cursor..].find('"') else {
            break;
        };
        let quote_idx = cursor + rel_quote_idx;
        let prefix = inner[..quote_idx]
            .trim_end_matches('\\')
            .trim_end();
        if !looks_like_inline_interpreter_eval_prefix(prefix) {
            cursor = quote_idx + 1;
            continue;
        }
        let end_quote_idx = inner.rfind('"').filter(|idx| *idx > quote_idx).or_else(|| {
            find_matching_double_quote(inner, quote_idx + 1)
        });
        let Some(end_quote_idx) = end_quote_idx else {
            break;
        };
        let code = &inner[quote_idx + 1..end_quote_idx];
        if code.contains('\'') {
            let escaped_code = code.replace('\'', "'\\''");
            repaired = format!(
                "{}{}{}",
                &inner[..quote_idx + 1],
                escaped_code,
                &inner[end_quote_idx..]
            );
            changed = true;
        }
        cursor = end_quote_idx + 1;
    }

    if changed {
        format!("bash -lc '{}'", repaired)
    } else {
        trimmed.to_string()
    }
}

fn looks_like_python_heredoc_command(raw: &str) -> bool {
    let lowered = raw.to_ascii_lowercase();
    if !lowered.contains("python") {
        return false;
    }
    lowered.contains("<<")
        || lowered.contains("pyeof")
        || lowered.contains("with open\\(")
        || lowered.contains("print\\(")
        || lowered.contains("read\\(")
        || lowered.contains("write\\(")
}

fn strip_python_heredoc_pseudo_escapes(raw: &str) -> String {
    if !looks_like_python_heredoc_command(raw) {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.peek().copied() {
                if matches!(next, '(' | ')' | '\'' | '"') {
                    out.push(next);
                    chars.next();
                    continue;
                }
            }
        }
        out.push(ch);
    }
    out
}

fn normalize_exec_command_text(raw: &str) -> String {
    let repaired = repair_shell_wrapper_shape(raw);
    let repaired = repair_bash_lc_inline_eval_single_quotes(repaired.as_str());
    strip_python_heredoc_pseudo_escapes(repaired.as_str())
}

fn repair_command_like_fields_in_args(args: &mut Map<String, Value>) {
    fn repair_value(value: &mut Value) {
        match value {
            Value::String(raw) => {
                *raw = normalize_exec_command_text(raw.as_str());
            }
            Value::Object(obj) => repair_command_like_fields_in_args(obj),
            _ => {}
        }
    }

    for key in ["cmd", "command", "script", "toon", "input", "text", "args"] {
        if let Some(value) = args.get_mut(key) {
            repair_value(value);
        }
    }
}

fn args_contain_direct_or_nested_key(args: &Map<String, Value>, key: &str) -> bool {
    if args.contains_key(key) {
        return true;
    }
    ["input", "args"].iter().any(|container_key| {
        args.get(*container_key)
            .and_then(Value::as_object)
            .map(|row| row.contains_key(key))
            .unwrap_or(false)
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

fn looks_like_pathish_suffix(raw: &str) -> bool {
    let trimmed = raw.trim();
    !trimmed.is_empty()
        && (trimmed.starts_with('/')
            || trimmed.starts_with("./")
            || trimmed.starts_with("../")
            || trimmed.starts_with("~/")
            || trimmed.contains('/'))
}

fn pathish_suffix_exists(raw: &str, workdir: Option<&str>) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !looks_like_pathish_suffix(trimmed) {
        return false;
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return path.exists();
    }
    workdir
        .map(Path::new)
        .map(|root| root.join(path).exists())
        .unwrap_or(false)
}

fn repair_compact_leading_path_command(raw: &str, workdir: Option<&str>) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.chars().any(char::is_whitespace)
        || trimmed.starts_with('/')
        || trimmed.starts_with("./")
        || trimmed.starts_with("../")
        || trimmed.starts_with("~/")
        || trimmed
            .chars()
            .any(|ch| matches!(ch, '&' | '|' | ';' | '<' | '>' | '(' | ')' | '{' | '}'))
    {
        return trimmed.to_string();
    }

    for idx in trimmed.char_indices().skip(1).map(|(idx, _)| idx) {
        let prefix = &trimmed[..idx];
        let suffix = &trimmed[idx..];
        let prefix_ok = prefix
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
            && prefix
                .chars()
                .next()
                .map(|ch| ch.is_ascii_alphabetic())
                .unwrap_or(false);
        if !prefix_ok || !pathish_suffix_exists(suffix, workdir) {
            continue;
        }
        return format!("{} {}", prefix, suffix);
    }

    trimmed.to_string()
}

fn push_spacing_if_needed(out: &mut String) {
    if out
        .chars()
        .last()
        .map(|ch| !ch.is_whitespace())
        .unwrap_or(false)
    {
        out.push(' ');
    }
}

fn repair_shell_operator_spacing(raw: &str) -> String {
    let chars: Vec<char> = raw.trim().chars().collect();
    if chars.is_empty() {
        return String::new();
    }

    let mut out = String::with_capacity(raw.len() + 8);
    let mut idx = 0usize;
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;

    while idx < chars.len() {
        let ch = chars[idx];
        if in_single {
            if ch == '\'' {
                in_single = false;
            }
            out.push(ch);
            idx += 1;
            continue;
        }
        if in_double {
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
                in_double = false;
            }
            out.push(ch);
            idx += 1;
            continue;
        }
        if ch == '\'' {
            in_single = true;
            out.push(ch);
            idx += 1;
            continue;
        }
        if ch == '"' {
            in_double = true;
            out.push(ch);
            idx += 1;
            continue;
        }

        if idx + 1 < chars.len()
            && ((ch == '&' && chars[idx + 1] == '&') || (ch == '|' && chars[idx + 1] == '|'))
        {
            push_spacing_if_needed(&mut out);
            out.push(ch);
            out.push(chars[idx + 1]);
            if chars
                .get(idx + 2)
                .map(|next| !next.is_whitespace())
                .unwrap_or(false)
            {
                out.push(' ');
            }
            idx += 2;
            continue;
        }

        if (ch == '1' || ch == '2') && chars.get(idx + 1) == Some(&'>') {
            push_spacing_if_needed(&mut out);
            out.push(ch);
            out.push('>');
            idx += 2;
            if chars.get(idx) == Some(&'&') {
                out.push('&');
                idx += 1;
                if let Some(fd) = chars.get(idx) {
                    out.push(*fd);
                    idx += 1;
                }
            }
            if chars
                .get(idx)
                .map(|next| !next.is_whitespace())
                .unwrap_or(false)
            {
                out.push(' ');
            }
            continue;
        }

        out.push(ch);
        idx += 1;
    }

    out.trim().to_string()
}

fn normalize_shell_command_text(raw: &str, workdir: Option<&str>) -> String {
    let mut current = raw.trim().to_string();
    for _ in 0..3 {
        let repaired = repair_compact_leading_path_command(
            repair_shell_operator_spacing(current.as_str()).as_str(),
            workdir,
        );
        if repaired == current {
            break;
        }
        current = repaired;
    }
    current
}

fn looks_like_exec_command_candidate(raw: &str) -> bool {
    let normalized = normalize_shell_command_text(raw, None);
    let mut tokens = normalized.split_whitespace().peekable();
    while let Some(token) = tokens.peek().copied() {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            tokens.next();
            continue;
        }
        let Some(eq_idx) = trimmed.find('=') else {
            break;
        };
        let key = trimmed[..eq_idx].trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
        {
            break;
        }
        tokens.next();
    }

    let Some(command_token) = tokens
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };

    if !command_token
        .chars()
        .next()
        .map(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '~' | '$' | '_' | '-'))
        .unwrap_or(false)
    {
        return false;
    }

    command_token.chars().all(|ch| {
        ch.is_ascii_alphanumeric()
            || matches!(ch, '/' | '.' | '_' | '-' | '~' | '$' | ':' | '+' | '=')
    })
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

fn looks_like_shell_wrapped_apply_patch(raw: &str) -> bool {
    let trimmed = raw.trim_start().to_ascii_lowercase();
    if trimmed.is_empty() {
        return false;
    }
    let starts_with_shell = trimmed.starts_with("bash ")
        || trimmed.starts_with("sh ")
        || trimmed.starts_with("zsh ")
        || trimmed.starts_with("env ")
        || trimmed.starts_with("command ");
    starts_with_shell && trimmed.contains("apply_patch <<")
}

fn extract_apply_patch_text_from_object(row: &Map<String, Value>) -> Option<String> {
    row.get("patch")
        .and_then(|value| extract_apply_patch_text(Some(value)))
        .or_else(|| {
            row.get("input")
                .and_then(|value| extract_apply_patch_text(Some(value)))
        })
        .or_else(|| {
            row.get("instructions")
                .and_then(|value| extract_apply_patch_text(Some(value)))
        })
        .or_else(|| {
            row.get("arguments")
                .and_then(|value| extract_apply_patch_text(Some(value)))
        })
}

fn extract_apply_patch_text(raw_args: Option<&Value>) -> Option<String> {
    match raw_args {
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            if looks_like_shell_wrapped_apply_patch(trimmed) {
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
        Some(Value::Object(row)) => extract_apply_patch_text_from_object(row),
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
    relativize_workspace_path(out.as_str())
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

fn current_workspace_root() -> Option<PathBuf> {
    env::current_dir().ok()
}

fn relativize_workspace_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let candidate = Path::new(trimmed);
    if !candidate.is_absolute() {
        return trimmed.replace('\\', "/");
    }
    let Some(root) = current_workspace_root() else {
        return trimmed.replace('\\', "/");
    };
    let Ok(relative) = candidate.strip_prefix(root.as_path()) else {
        return trimmed.replace('\\', "/");
    };
    let text = relative.to_string_lossy().replace('\\', "/");
    if text.trim().is_empty() {
        ".".to_string()
    } else {
        text
    }
}

fn normalize_patch_compare_line(raw: &str) -> String {
    raw.replace('\r', "")
        .replace('\t', " ")
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
        .trim()
        .to_string()
}

fn line_sequence_matches_exact(haystack: &[String], start: usize, needle: &[String]) -> bool {
    if needle.is_empty() || start + needle.len() > haystack.len() {
        return false;
    }
    needle
        .iter()
        .enumerate()
        .all(|(offset, line)| haystack[start + offset] == *line)
}

fn line_sequence_matches_trimmed(haystack: &[String], start: usize, needle: &[String]) -> bool {
    if needle.is_empty() || start + needle.len() > haystack.len() {
        return false;
    }
    needle.iter().enumerate().all(|(offset, line)| {
        haystack[start + offset].trim_end() == line.trim_end()
    })
}

fn line_sequence_matches_whitespace_normalized(
    haystack: &[String],
    start: usize,
    needle: &[String],
) -> bool {
    if needle.is_empty() || start + needle.len() > haystack.len() {
        return false;
    }
    needle.iter().enumerate().all(|(offset, line)| {
        normalize_patch_compare_line(haystack[start + offset].as_str())
            == normalize_patch_compare_line(line.as_str())
    })
}

fn unique_match_in_window<F>(
    haystack: &[String],
    needle: &[String],
    preferred_index: usize,
    window_radius: usize,
    matcher: F,
) -> Option<usize>
where
    F: Fn(&[String], usize, &[String]) -> bool,
{
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let max_start = haystack.len().saturating_sub(needle.len());
    let window_start = preferred_index.saturating_sub(window_radius).min(max_start);
    let window_end = preferred_index
        .saturating_add(window_radius)
        .min(max_start);
    let mut matches = Vec::<usize>::new();
    for start in window_start..=window_end {
        if matcher(haystack, start, needle) {
            matches.push(start);
            if matches.len() > 1 {
                return None;
            }
        }
    }
    matches.into_iter().next()
}

fn unique_match_anywhere<F>(haystack: &[String], needle: &[String], matcher: F) -> Option<usize>
where
    F: Fn(&[String], usize, &[String]) -> bool,
{
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let max_start = haystack.len().saturating_sub(needle.len());
    let mut matches = Vec::<usize>::new();
    for start in 0..=max_start {
        if matcher(haystack, start, needle) {
            matches.push(start);
            if matches.len() > 1 {
                return None;
            }
        }
    }
    matches.into_iter().next()
}

fn locate_live_file_block(
    file_lines: &[String],
    removed_lines: &[String],
    preferred_index: usize,
) -> Option<usize> {
    if removed_lines.is_empty() || file_lines.len() < removed_lines.len() {
        return None;
    }
    unique_match_in_window(
        file_lines,
        removed_lines,
        preferred_index,
        8,
        line_sequence_matches_exact,
    )
    .or_else(|| {
        unique_match_in_window(
            file_lines,
            removed_lines,
            preferred_index,
            8,
            line_sequence_matches_trimmed,
        )
    })
    .or_else(|| {
        unique_match_in_window(
            file_lines,
            removed_lines,
            preferred_index,
            8,
            line_sequence_matches_whitespace_normalized,
        )
    })
    .or_else(|| unique_match_anywhere(file_lines, removed_lines, line_sequence_matches_exact))
    .or_else(|| unique_match_anywhere(file_lines, removed_lines, line_sequence_matches_trimmed))
    .or_else(|| {
        unique_match_anywhere(
            file_lines,
            removed_lines,
            line_sequence_matches_whitespace_normalized,
        )
    })
}

fn parse_unified_hunk_header_line_numbers(line: &str) -> Option<(usize, usize, usize, usize)> {
    let caps = Regex::new(r"^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@")
        .ok()?
        .captures(line.trim())?;
    let old_start = caps.get(1)?.as_str().parse::<usize>().ok()?;
    let old_len = caps
        .get(2)
        .and_then(|m| m.as_str().parse::<usize>().ok())
        .unwrap_or(1);
    let new_start = caps.get(3)?.as_str().parse::<usize>().ok()?;
    let new_len = caps
        .get(4)
        .and_then(|m| m.as_str().parse::<usize>().ok())
        .unwrap_or(1);
    Some((old_start, old_len, new_start, new_len))
}

fn try_rebuild_line_number_hunk_with_live_context(
    file_path: &str,
    header: &str,
    body_lines: &[String],
) -> Option<Vec<String>> {
    let (old_start, old_len, _new_start, _new_len) = parse_unified_hunk_header_line_numbers(header)?;
    let cwd = current_workspace_root()?;
    let absolute_path = cwd.join(file_path);
    let source = fs::read_to_string(absolute_path).ok()?;
    let file_lines: Vec<String> = source
        .replace("\r\n", "\n")
        .split('\n')
        .map(|line| line.to_string())
        .collect();

    let removed_lines: Vec<String> = body_lines
        .iter()
        .filter_map(|line| line.strip_prefix('-').map(|rest| rest.to_string()))
        .collect();
    let added_lines: Vec<String> = body_lines
        .iter()
        .filter_map(|line| line.strip_prefix('+').map(|rest| rest.to_string()))
        .collect();
    let context_lines: Vec<String> = body_lines
        .iter()
        .filter_map(|line| line.strip_prefix(' ').map(|rest| rest.to_string()))
        .collect();

    if !context_lines.is_empty() {
        return None;
    }

    let preferred_index = old_start.saturating_sub(1);
    let block_start = if !removed_lines.is_empty() {
        locate_live_file_block(file_lines.as_slice(), removed_lines.as_slice(), preferred_index)?
    } else {
        preferred_index.min(file_lines.len())
    };

    let block_end = if !removed_lines.is_empty() {
        block_start.saturating_add(removed_lines.len())
    } else {
        block_start
    };

    let mut rebuilt = Vec::<String>::new();
    rebuilt.push("@@".to_string());
    if block_start > 0 {
        rebuilt.push(format!(" {}", file_lines[block_start - 1]));
    }
    for line in &removed_lines {
        rebuilt.push(format!("-{}", line));
    }
    if removed_lines.is_empty() && old_len > 0 {
        let insert_end = block_start.saturating_add(old_len).min(file_lines.len());
        for line in &file_lines[block_start..insert_end] {
            rebuilt.push(format!(" {}", line));
        }
    }
    for line in &added_lines {
        rebuilt.push(format!("+{}", line));
    }
    if block_end < file_lines.len() {
        rebuilt.push(format!(" {}", file_lines[block_end]));
    }
    Some(rebuilt)
}

fn repair_line_number_update_hunks_with_live_context(patch_text: &str) -> String {
    let lines: Vec<String> = patch_text
        .split('\n')
        .map(|line| line.to_string())
        .collect();
    if lines.is_empty() {
        return patch_text.to_string();
    }

    let mut out = Vec::<String>::new();
    let mut current_update_path: Option<String> = None;
    let mut index = 0usize;

    while index < lines.len() {
        let line = lines[index].clone();
        if let Some(path) = line.strip_prefix("*** Update File:") {
            let normalized_path = normalize_apply_patch_header_path(path.trim());
            current_update_path = Some(normalized_path);
            out.push(format!(
                "*** Update File: {}",
                current_update_path.as_deref().unwrap_or("")
            ));
            index += 1;
            continue;
        }

        if line.starts_with("*** Add File:")
            || line.starts_with("*** Delete File:")
            || line.starts_with("*** Begin Patch")
            || line.starts_with("*** End Patch")
        {
            current_update_path = None;
            out.push(line);
            index += 1;
            continue;
        }

        if line.starts_with("@@") {
            let header = line.clone();
            let mut body = Vec::<String>::new();
            let mut cursor = index + 1;
            while cursor < lines.len() {
                let next = lines[cursor].clone();
                if next.starts_with("@@")
                    || next.starts_with("*** Update File:")
                    || next.starts_with("*** Add File:")
                    || next.starts_with("*** Delete File:")
                    || next.starts_with("*** End Patch")
                {
                    break;
                }
                body.push(next);
                cursor += 1;
            }

            let rebuilt = current_update_path
                .as_deref()
                .and_then(|path| try_rebuild_line_number_hunk_with_live_context(path, header.as_str(), body.as_slice()));
            if let Some(next_hunk) = rebuilt {
                out.extend(next_hunk);
            } else {
                out.push(header);
                out.extend(body);
            }
            index = cursor;
            continue;
        }

        out.push(line);
        index += 1;
    }

    out.join("\n")
}


fn build_apply_patch_guard_patch(reason: &str, message: &str) -> String {
    let reason_slug: String = reason
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let safe_reason = if reason_slug.trim().is_empty() {
        "unknown".to_string()
    } else {
        reason_slug
    };
    let safe_message = message
        .replace('\\', "\\\\")
        .replace('\r', " ")
        .replace('\n', " ")
        .trim()
        .chars()
        .take(240)
        .collect::<String>();
    format!(
        "*** Begin Patch\n*** Update File: __APPLY_PATCH_ERROR__/{}.txt\n@@\n-guard\n+APPLY_PATCH_ERROR: {}\n*** End Patch",
        safe_reason,
        if safe_message.is_empty() {
            "invalid apply_patch schema or patch grammar"
        } else {
            safe_message.as_str()
        }
    )
}

fn apply_patch_error_message(reason: &str) -> &'static str {
    match reason {
        "missing_patch" => "apply_patch requires schema arguments with patch as a string.",
        "empty_patch" => "apply_patch patch must be non-empty.",
        "conflict_markers" => "Conflict markers are not allowed in apply_patch patches; remove <<<<<<<, =======, and >>>>>>> blocks.",
        "mixed_gnu_diff" => "GNU diff headers are not valid apply_patch input; use the *** Begin Patch grammar with file markers.",
        "unsupported_patch_format" => "Invalid apply_patch grammar. Use *** Begin Patch / *** End Patch with Add/Update/Delete File markers.",
        "empty_add_file_block" => "Add File requires + content lines. Use + for every created file line.",
        "empty_update_hunk" => "Update File requires a non-empty @@ hunk with context and/or +/- lines.",
        _ => "Invalid apply_patch schema or patch grammar.",
    }
}

fn detect_apply_patch_authoring_invalid_reason(raw: &str) -> Option<&'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some("empty_patch");
    }
    if trimmed.contains("<<<<<<<") || trimmed.contains("=======") || trimmed.contains(">>>>>>>") {
        return Some("conflict_markers");
    }
    if trimmed.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("diff --git ") || line.starts_with("--- ") || line.starts_with("+++ ")
    }) {
        return Some("mixed_gnu_diff");
    }
    if !(trimmed.starts_with("*** Begin Patch") && trimmed.contains("*** End Patch")) {
        return Some("unsupported_patch_format");
    }

    let lines: Vec<&str> = trimmed.lines().collect();
    let mut idx: usize = 0;
    while idx < lines.len() {
        let line = lines[idx].trim_end();
        if line.starts_with("*** Add File:") {
            let mut saw_plus = false;
            idx += 1;
            while idx < lines.len() {
                let body = lines[idx];
                if body.starts_with("*** ") {
                    break;
                }
                if body.starts_with('+') && !body.starts_with("+++") {
                    saw_plus = true;
                } else if !body.trim().is_empty() {
                    return Some("empty_add_file_block");
                }
                idx += 1;
            }
            if !saw_plus {
                return Some("empty_add_file_block");
            }
            continue;
        }
        if line.starts_with("*** Update File:") {
            let mut saw_hunk = false;
            let mut current_hunk_has_body = false;
            idx += 1;
            while idx < lines.len() {
                let body = lines[idx];
                if body.starts_with("*** ") {
                    break;
                }
                if body.starts_with("@@") {
                    if saw_hunk && !current_hunk_has_body {
                        return Some("empty_update_hunk");
                    }
                    saw_hunk = true;
                    current_hunk_has_body = false;
                } else if saw_hunk {
                    if body.starts_with(' ') || body.starts_with('+') || body.starts_with('-') {
                        current_hunk_has_body = true;
                    } else if !body.trim().is_empty() {
                        return Some("empty_update_hunk");
                    }
                }
                idx += 1;
            }
            if !saw_hunk || !current_hunk_has_body {
                return Some("empty_update_hunk");
            }
            continue;
        }
        idx += 1;
    }

    None
}

fn make_apply_patch_guard_args(reason: &str) -> String {
    let patch = build_apply_patch_guard_patch(reason, apply_patch_error_message(reason));
    let mut out = Map::new();
    out.insert("patch".to_string(), Value::String(patch.clone()));
    out.insert("input".to_string(), Value::String(patch));
    serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| {
        "{\"patch\":\"*** Begin Patch\\n*** Update File: __APPLY_PATCH_ERROR__/unknown.txt\\n@@\\n-guard\\n+APPLY_PATCH_ERROR: invalid apply_patch schema or patch grammar\\n*** End Patch\",\"input\":\"*** Begin Patch\\n*** Update File: __APPLY_PATCH_ERROR__/unknown.txt\\n@@\\n-guard\\n+APPLY_PATCH_ERROR: invalid apply_patch schema or patch grammar\\n*** End Patch\"}".to_string()
    })
}

fn detect_apply_patch_invalid_reason(patch: &str) -> Option<&'static str> {
    let trimmed = patch.trim();
    if trimmed.is_empty() {
        return Some("empty_patch");
    }
    if trimmed.contains("<<<<<<<") || trimmed.contains("=======") || trimmed.contains(">>>>>>>") {
        return Some("conflict_markers");
    }
    if trimmed.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("diff --git ") || line.starts_with("--- ") || line.starts_with("+++ ")
    }) {
        return Some("mixed_gnu_diff");
    }
    if !(trimmed.starts_with("*** Begin Patch") && trimmed.contains("*** End Patch")) {
        return Some("unsupported_patch_format");
    }
    let has_file_marker = trimmed.contains("*** Add File:")
        || trimmed.contains("*** Update File:")
        || trimmed.contains("*** Delete File:");
    if !has_file_marker {
        return Some("unsupported_patch_format");
    }
    if trimmed.contains("*** Add File:") && !trimmed.lines().any(|line| {
        line.starts_with('+') && !line.starts_with("+++")
    }) {
        return Some("empty_add_file_block");
    }
    None
}

pub(crate) fn normalize_apply_patch_schema_args(raw_args: Option<&Value>) -> (String, bool) {
    let Some(raw_args) = raw_args else {
        let mut out = Map::new();
        out.insert("patch".to_string(), Value::String(String::new()));
        out.insert("input".to_string(), Value::String(String::new()));
        return (
            serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".to_string()),
            true,
        );
    };
    let args = parse_json_record(Some(raw_args)).unwrap_or_default();
    let patch_source = args
        .get("patch")
        .or_else(|| args.get("input"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or_else(|| {
            extract_apply_patch_text(Some(raw_args))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        });
    let Some(patch_source) = patch_source else {
        let mut out = Map::new();
        out.insert("patch".to_string(), Value::String(String::new()));
        out.insert("input".to_string(), Value::String(String::new()));
        return (
            serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".to_string()),
            true,
        );
    };
    let patch = normalize_apply_patch_text(patch_source.as_str());
    let mut out = Map::new();
    out.insert("patch".to_string(), Value::String(patch.clone()));
    out.insert("input".to_string(), Value::String(patch));
    (serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".to_string()), false)
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
            if raw_line.trim_start().starts_with("@@") {
                continue;
            }
            if raw_line.starts_with('+') {
                out.push(raw_line.to_string());
            } else {
                out.push(format!("+{}", raw_line));
            }
            continue;
        }
        out.push(raw_line.to_string());
    }

    repair_line_number_update_hunks_with_live_context(out.join("\n").trim())
        .trim()
        .to_string()
}

fn normalize_tool_name(raw_name: &str) -> Option<String> {
    let trimmed = raw_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized_raw = if trimmed.to_ascii_lowercase().starts_with("functions.") {
        trimmed[10..].trim().to_string()
    } else {
        trimmed.to_string()
    };
    if normalized_raw.is_empty() {
        return None;
    }
    let alias_normalized = match normalized_raw.to_ascii_lowercase().as_str() {
        "execute_command" | "execute-command" | "shell_command" | "shell" | "bash" | "terminal" => {
            "exec_command".to_string()
        }
        _ => normalized_raw,
    };
    let canonical_name =
        crate::hub_resp_outbound_client_semantics::normalize_responses_function_name(Some(
            alias_normalized.as_str(),
        ))?;

    let canonical_lowered = canonical_name.to_ascii_lowercase();
    let canonical = canonical_lowered.as_str();
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
            | "request_user_input"
            | "spawn_agent"
            | "send_input"
            | "resume_agent"
            | "wait_agent"
            | "close_agent"
            | "view_image"
            | "list_mcp_resources"
            | "read_mcp_resource"
            | "list_mcp_resource_templates"
            | "list_directory"
    );
    if known {
        return Some(canonical.to_string());
    }

    // Keep shape-only harvest generic: do not filter tool names here.
    // The model-declared tool list is the source of truth; this layer should only normalize shape.
    Some(canonical_name)
}

fn infer_tool_name_from_args(raw_args: Option<&Value>) -> Option<String> {
    let args = parse_json_record(raw_args).unwrap_or_default();
    if args.is_empty() {
        return None;
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

pub(crate) fn normalize_tool_args(tool_name: &str, raw_args: Option<&Value>) -> Option<String> {
    let source_tool_name = tool_name.trim().to_ascii_lowercase();
    let source_is_shell_alias = matches!(
        source_tool_name.as_str(),
        "shell_command" | "shell" | "bash" | "terminal" | "execute_command" | "execute-command"
    );
    let name = normalize_tool_name(tool_name)?;
    let args = parse_json_record(raw_args).unwrap_or_default();
    if name == "exec_command" {
        if let Some(guarded) =
            maybe_guard_large_exec_command_from_raw_string(raw_args, source_is_shell_alias)
        {
            return Some(guarded);
        }
        let mut cmd = normalize_exec_command_text(read_command_from_args(&args)?.as_str());
        if is_large_heredoc_file_generation_command(cmd.as_str()) {
            let preview = truncate_preview(cmd.as_str(), EXEC_COMMAND_HEREDOC_PREVIEW_CHARS);
            cmd = build_exec_command_large_write_guard_command(preview.as_str());
        }
        let read_nested_value = |keys: &[&str]| -> Option<Value> {
            for key in keys {
                if let Some(value) = args.get(*key) {
                    return Some(value.clone());
                }
            }
            for container_key in ["input", "args"] {
                let Some(container) = args.get(container_key).and_then(Value::as_object) else {
                    continue;
                };
                for key in keys {
                    if let Some(value) = container.get(*key) {
                        return Some(value.clone());
                    }
                }
            }
            None
        };
        let read_i64_value = |keys: &[&str]| -> Option<Value> {
            match read_nested_value(keys)? {
                Value::Number(n) => Some(Value::Number(n)),
                Value::String(raw) => raw
                    .trim()
                    .parse::<i64>()
                    .ok()
                    .map(|v| Value::Number(v.into())),
                _ => None,
            }
        };
        let read_bool_value = |keys: &[&str]| -> Option<Value> {
            match read_nested_value(keys)? {
                Value::Bool(v) => Some(Value::Bool(v)),
                Value::String(raw) => match raw.trim().to_ascii_lowercase().as_str() {
                    "true" => Some(Value::Bool(true)),
                    "false" => Some(Value::Bool(false)),
                    _ => None,
                },
                _ => None,
            }
        };
        let read_string_value = |keys: &[&str]| -> Option<Value> {
            match read_nested_value(keys)? {
                Value::String(raw) => {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(Value::String(trimmed.to_string()))
                    }
                }
                _ => None,
            }
        };
        let read_string_array_value = |keys: &[&str]| -> Option<Value> {
            match read_nested_value(keys)? {
                Value::Array(items) => {
                    let normalized: Vec<Value> = items
                        .into_iter()
                        .filter_map(|item| match item {
                            Value::String(raw) => {
                                let trimmed = raw.trim();
                                if trimmed.is_empty() {
                                    None
                                } else {
                                    Some(Value::String(trimmed.to_string()))
                                }
                            }
                            _ => None,
                        })
                        .collect();
                    if normalized.is_empty() {
                        None
                    } else {
                        Some(Value::Array(normalized))
                    }
                }
                _ => None,
            }
        };
        let parsed = build_exec_command_object_with_shape(
            cmd,
            Some(&args),
            source_is_shell_alias,
            None,
            None,
        )?;
        let mut out_value: Value = serde_json::from_str(parsed.as_str()).ok()?;
        let out = out_value.as_object_mut()?;

        for (key, value) in [
            ("yield_time_ms", read_i64_value(&["yield_time_ms"])),
            ("max_output_tokens", read_i64_value(&["max_output_tokens"])),
            ("tty", read_bool_value(&["tty"])),
            ("login", read_bool_value(&["login"])),
            ("justification", read_string_value(&["justification"])),
            ("shell", read_string_value(&["shell"])),
            (
                "sandbox_permissions",
                read_string_value(&["sandbox_permissions"]),
            ),
            ("prefix_rule", read_string_array_value(&["prefix_rule"])),
        ] {
            if let Some(value) = value {
                out.insert(key.to_string(), value);
            }
        }
        return serde_json::to_string(&out_value).ok();
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

    if name == "update_plan" {
        let mut out = Map::new();
        if let Some(explanation) = args
            .get("explanation")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            out.insert(
                "explanation".to_string(),
                Value::String(explanation.to_string()),
            );
        }
        let source_plan = args
            .get("plan")
            .and_then(Value::as_array)
            .or_else(|| args.get("steps").and_then(Value::as_array));
        if let Some(rows) = source_plan {
            let normalized_rows: Vec<Value> = rows
                .iter()
                .filter_map(|row| {
                    if let Some(step_text) = row
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        return Some(json!({
                            "step": step_text,
                            "status": "pending",
                        }));
                    }
                    let obj = row.as_object()?;
                    let step = obj
                        .get("step")
                        .or_else(|| obj.get("name"))
                        .or_else(|| obj.get("title"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())?;
                    let status = obj
                        .get("status")
                        .or_else(|| obj.get("state"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())?;
                    Some(json!({
                        "step": step,
                        "status": status,
                    }))
                })
                .collect();
            if !normalized_rows.is_empty() {
                out.insert("plan".to_string(), Value::Array(normalized_rows));
            }
        }
        if out.contains_key("plan") {
            return serde_json::to_string(&Value::Object(out)).ok();
        }
    }

    if name == "apply_patch" {
        return Some(normalize_apply_patch_schema_args(raw_args).0);
    }

    serde_json::to_string(&Value::Object(args)).ok()
}

pub(crate) fn normalize_tool_args_preserving_raw_shape(
    tool_name: &str,
    raw_args: Option<&Value>,
) -> Option<String> {
    let canonical_name = normalize_tool_name(tool_name)?;
    if canonical_name != "exec_command" {
        return normalize_tool_args(tool_name, raw_args);
    }
    let source_tool_name = tool_name.trim().to_ascii_lowercase();
    let source_is_shell_alias = matches!(
        source_tool_name.as_str(),
        "shell_command" | "shell" | "bash" | "terminal" | "execute_command" | "execute-command"
    );
    if let Some(guarded) =
        maybe_guard_large_exec_command_from_raw_string(raw_args, source_is_shell_alias)
    {
        return Some(guarded);
    }
    let args = parse_json_record(raw_args).unwrap_or_default();
    let cmd = read_command_from_args(&args)?;
    if is_large_heredoc_file_generation_command(cmd.as_str()) {
        let preview = truncate_preview(cmd.as_str(), EXEC_COMMAND_HEREDOC_PREVIEW_CHARS);
        let guard = build_exec_command_large_write_guard_command(preview.as_str());
        return build_exec_command_object_with_shape(
            guard,
            Some(&args),
            source_is_shell_alias,
            None,
            None,
        );
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
            "cmd": body
        }
    });
    normalize_tool_call_entry(&entry, fallback_id)
}

fn decode_basic_xml_entities(raw: &str) -> String {
    raw.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn unwrap_xml_cdata_sections(raw: &str) -> String {
    if !raw.contains("<![CDATA[") {
        return raw.to_string();
    }

    let mut out = String::with_capacity(raw.len());
    let mut remaining = raw;
    loop {
        let Some(start) = remaining.find("<![CDATA[") else {
            out.push_str(remaining);
            break;
        };
        out.push_str(&remaining[..start]);
        let after_start = &remaining[start + "<![CDATA[".len()..];
        let Some(end) = after_start.find("]]>") else {
            out.push_str(after_start);
            break;
        };
        out.push_str(&after_start[..end]);
        remaining = &after_start[end + "]]>".len()..];
    }
    out
}

fn is_supported_xml_named_tool_name(raw_name: &str) -> bool {
    matches!(
        raw_name,
        "exec_command"
            | "execute_command"
            | "shell_command"
            | "shell"
            | "bash"
            | "terminal"
            | "write_stdin"
            | "apply_patch"
            | "update_plan"
            | "request_user_input"
            | "spawn_agent"
            | "send_input"
            | "resume_agent"
            | "wait_agent"
            | "close_agent"
            | "view_image"
            | "list_mcp_resources"
            | "read_mcp_resource"
            | "list_mcp_resource_templates"
            | "list_directory"
    )
}

fn is_generic_xml_wrapper_tag(raw_name: &str) -> bool {
    matches!(
        raw_name,
        "command"
            | "commands"
            | "cmd"
            | "tool"
            | "tools"
            | "call"
            | "calls"
            | "invoke"
            | "invocation"
            | "action"
            | "actions"
            | "operation"
            | "operations"
            | "step"
            | "steps"
            | "execute"
            | "execution"
    )
}

fn looks_like_exec_command_wrapper_name(raw_name: &str) -> bool {
    let normalized = raw_name.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    is_generic_xml_wrapper_tag(normalized.as_str())
        || normalized == "exec"
        || normalized == "shell"
        || normalized == "bash"
        || normalized == "terminal"
        || normalized == "run"
        || normalized.contains("command")
        || normalized.contains("shell")
        || normalized.contains("bash")
        || normalized.contains("terminal")
        || normalized.contains("exec")
}

fn looks_like_apply_patch_wrapper_name(raw_name: &str) -> bool {
    let normalized = raw_name.trim().to_ascii_lowercase();
    !normalized.is_empty()
        && (normalized == "patch"
            || normalized == "diff"
            || normalized.contains("patch")
            || normalized.contains("diff"))
}

fn is_xml_named_tool_container_tag(raw_name: &str) -> bool {
    matches!(raw_name, "tool_calls")
}

fn should_attempt_xml_wrapper_harvest(raw_name: &str) -> bool {
    is_supported_xml_named_tool_name(raw_name)
        || is_generic_xml_wrapper_tag(raw_name)
        || looks_like_exec_command_wrapper_name(raw_name)
        || looks_like_apply_patch_wrapper_name(raw_name)
}

fn resolve_xml_wrapper_tool_name(raw_name: &str) -> Option<String> {
    let normalized = raw_name.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if is_supported_xml_named_tool_name(normalized.as_str()) {
        return normalize_tool_name(raw_name);
    }
    if looks_like_apply_patch_wrapper_name(normalized.as_str()) {
        return Some("apply_patch".to_string());
    }
    if looks_like_exec_command_wrapper_name(normalized.as_str()) {
        return Some("exec_command".to_string());
    }
    None
}

fn normalize_preserved_text_whitespace(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n");
    let mut lines: Vec<String> = Vec::new();
    let mut previous_blank = false;
    for line in normalized.lines() {
        let collapsed = line.split_whitespace().collect::<Vec<&str>>().join(" ");
        if collapsed.is_empty() {
            if !previous_blank && !lines.is_empty() {
                lines.push(String::new());
            }
            previous_blank = true;
            continue;
        }
        lines.push(collapsed);
        previous_blank = false;
    }
    lines.join("\n").trim().to_string()
}

fn strip_xml_tags_preserve_text(raw: &str) -> String {
    let Ok(tag_pattern) = Regex::new(r"(?is)</?[A-Za-z_][A-Za-z0-9_.-]*>") else {
        return raw.trim().to_string();
    };
    let decoded = decode_basic_xml_entities(raw);
    let text = tag_pattern.replace_all(decoded.as_str(), " ").to_string();
    normalize_preserved_text_whitespace(text.as_str())
}

fn canonicalize_xml_named_tool_arg_key(raw_key: &str, tool_name: &str) -> String {
    let normalized = raw_key
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace('.', "_");
    match normalized.as_str() {
        "cmd" if tool_name == "exec_command" => "cmd".to_string(),
        "commandline" | "command_line" => "command".to_string(),
        "work_dir" | "workspace" => "workdir".to_string(),
        "sessionid" => "session_id".to_string(),
        "yieldtimems" => "yield_time_ms".to_string(),
        "maxoutputtokens" => "max_output_tokens".to_string(),
        "diff" if tool_name == "apply_patch" => "patch".to_string(),
        _ if tool_name == "exec_command"
            && looks_like_exec_command_wrapper_name(normalized.as_str()) =>
        {
            "command".to_string()
        }
        _ if tool_name == "apply_patch"
            && looks_like_apply_patch_wrapper_name(normalized.as_str()) =>
        {
            "patch".to_string()
        }
        _ => normalized,
    }
}

fn parse_xml_tag_attributes(raw_tag: &str) -> Vec<(String, String)> {
    let Ok(attr_pattern) =
        Regex::new(r#"([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#)
    else {
        return Vec::new();
    };
    attr_pattern
        .captures_iter(raw_tag)
        .filter_map(|caps| {
            let key = caps.get(1)?.as_str().trim().to_ascii_lowercase();
            if key.is_empty() {
                return None;
            }
            let value = caps
                .get(2)
                .or_else(|| caps.get(3))
                .or_else(|| caps.get(4))
                .map(|m| decode_basic_xml_entities(m.as_str()).trim().to_string())
                .unwrap_or_default();
            Some((key, value))
        })
        .collect()
}

fn normalize_dsml_tool_markup(raw: &str) -> String {
    // Normalize fullwidth pipe chars (U+FF5C, U+258F, U+2590) to ASCII pipe
    let raw: String = raw.chars().map(|c| match c {
        '\u{ff5c}' | '\u{258f}' | '\u{2590}' => '|',
        c => c,
    }).collect();
    let mut normalized = raw;
    let replacements = [
        (
            r#"(?is)<\s*\|?\s*dsml\s*\|\s*tool_calls\s*>"#,
            "<tool_calls>",
        ),
        (
            r#"(?is)</\s*\|?\s*dsml\s*\|\s*tool_calls\s*>"#,
            "</tool_calls>",
        ),
        (r#"(?is)<\s*\|?\s*dsml\s*\|\s*invoke\b"#, "<invoke"),
        (r#"(?is)</\s*\|?\s*dsml\s*\|\s*invoke\s*>"#, "</invoke>"),
        (
            r#"(?is)<\s*\|?\s*dsml\s*\|\s*parameter\b"#,
            "<parameter",
        ),
        (
            r#"(?is)</\s*\|?\s*dsml\s*\|\s*parameter\s*>"#,
            "</parameter>",
        ),
    ];
    for (pattern, target) in replacements {
        if let Ok(re) = Regex::new(pattern) {
            normalized = re.replace_all(normalized.as_str(), target).to_string();
        }
    }
    normalized
}

fn read_xml_tag_attribute<'a>(attrs: &'a [(String, String)], keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some((_, value)) = attrs.iter().find(|(name, _)| name == key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

fn resolve_xml_wrapper_tool_name_from_attrs(
    raw_tool_name: &str,
    attrs: &[(String, String)],
) -> Option<String> {
    let attr_tool_name =
        read_xml_tag_attribute(attrs, &["name", "tool", "tool_name", "call", "action"]);
    if let Some(candidate) = attr_tool_name {
        if let Some(canonical) = normalize_tool_name(candidate) {
            return Some(canonical);
        }
    }
    resolve_xml_wrapper_tool_name(raw_tool_name)
}

fn resolve_xml_named_child_arg_key(
    raw_key: &str,
    attrs: &[(String, String)],
    tool_name: &str,
) -> String {
    let normalized = raw_key.trim().to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "parameter" | "param" | "arg" | "argument" | "field" | "property" | "item" | "value"
    ) {
        if let Some(attr_name) =
            read_xml_tag_attribute(attrs, &["name", "key", "field", "property"])
        {
            return canonicalize_xml_named_tool_arg_key(attr_name, tool_name);
        }
    }
    canonicalize_xml_named_tool_arg_key(raw_key, tool_name)
}

fn merge_xml_named_tool_arg(args: &mut Map<String, Value>, key: String, value: Value) {
    if let Some(existing) = args.get_mut(&key) {
        match existing {
            Value::Array(items) => items.push(value),
            other => {
                let previous = other.clone();
                *other = Value::Array(vec![previous, value]);
            }
        }
        return;
    }
    args.insert(key, value);
}

fn maybe_mirror_exec_command_xml_args(args: &mut Map<String, Value>) {
    if args.contains_key("cmd") && !args.contains_key("command") {
        if let Some(value) = args.get("cmd").cloned() {
            args.insert("command".to_string(), value);
        }
    } else if args.contains_key("command") && !args.contains_key("cmd") {
        if let Some(value) = args.get("command").cloned() {
            args.insert("cmd".to_string(), value);
        }
    }
}

fn build_xml_named_tool_call_entry(
    raw_tool_name: &str,
    body: &str,
    wrapper_attrs: &[(String, String)],
    fallback_id: usize,
) -> Option<Value> {
    let canonical_name = resolve_xml_wrapper_tool_name_from_attrs(raw_tool_name, wrapper_attrs)?;
    let child_open_pattern =
        Regex::new(r"(?is)<([A-Za-z_][A-Za-z0-9_.-]*)(?:\s+[^<>]*?)?>").ok()?;
    let body_lower = body.to_ascii_lowercase();

    let mut args = Map::new();
    let mut masked_ranges: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0usize;
    while let Some(caps) = child_open_pattern.captures(&body[cursor..]) {
        let Some(whole) = caps.get(0) else {
            break;
        };
        let Some(raw_key) = caps.get(1).map(|m| m.as_str().trim()) else {
            break;
        };
        let attrs = parse_xml_tag_attributes(whole.as_str());
        let open_start = cursor + whole.start();
        let open_end = cursor + whole.end();
        let close_tag = format!("</{}>", raw_key.to_ascii_lowercase());
        let next_open = child_open_pattern.find_at(body, open_end);
        let value_end = body_lower[open_end..]
            .find(close_tag.as_str())
            .map(|rel| open_end + rel)
            .or_else(|| next_open.as_ref().map(|m| m.start()))
            .unwrap_or(body.len());
        let full_end = body_lower[value_end..]
            .starts_with(close_tag.as_str())
            .then_some(value_end + close_tag.len())
            .unwrap_or(value_end);
        let raw_value = body[open_end..value_end].trim();
        if !raw_key.is_empty() && !raw_value.is_empty() {
            let key = resolve_xml_named_child_arg_key(raw_key, &attrs, canonical_name.as_str());
            let contains_cdata = raw_value.contains("<![CDATA[");
            let decoded = unwrap_xml_cdata_sections(decode_basic_xml_entities(raw_value).as_str())
                .trim()
                .to_string();
            let cleaned_value = if !contains_cdata && decoded.contains('<') && decoded.contains('>') {
                let stripped = strip_xml_tags_preserve_text(decoded.as_str());
                if stripped.trim().is_empty() {
                    decoded.clone()
                } else {
                    stripped
                }
            } else {
                decoded.clone()
            };
            if !cleaned_value.is_empty() {
                let value = try_parse_json_value_lenient(cleaned_value.as_str())
                    .unwrap_or_else(|| Value::String(cleaned_value));
                merge_xml_named_tool_arg(&mut args, key, value);
                masked_ranges.push((open_start, full_end.max(open_start)));
            }
        }
        if full_end <= cursor {
            break;
        }
        cursor = full_end;
    }

    let _ = masked_ranges;

    if args.is_empty() {
        return None;
    }

    if canonical_name == "exec_command" {
        maybe_mirror_exec_command_xml_args(&mut args);
    }

    if matches!(
        canonical_name.as_str(),
        "exec_command" | "shell_command" | "shell" | "bash" | "terminal"
    ) {
        let command = read_command_from_args(&args)?;
        if !looks_like_exec_command_candidate(command.as_str()) {
            return None;
        }
    }

    let entry = json!({
        "name": canonical_name,
        "input": Value::Object(args)
    });
    normalize_tool_call_entry(&entry, fallback_id)
}

fn extract_xml_named_tool_call_blocks(text: &str, fallback_start_id: usize) -> Vec<Value> {
    let normalized_text = normalize_dsml_tool_markup(text);
    let Ok(open_pattern) = Regex::new(r"(?is)<([A-Za-z_][A-Za-z0-9_.-]*)(?:\s+[^<>]*?)?>") else {
        return Vec::new();
    };
    let text_lower = normalized_text.to_ascii_lowercase();

    let mut recovered: Vec<Value> = Vec::new();
    let mut seen = HashSet::<String>::new();
    let mut cursor = 0usize;
    let mut index = 0usize;
    while let Some(caps) = open_pattern.captures(&normalized_text[cursor..]) {
        let Some(whole) = caps.get(0) else {
            break;
        };
        let Some(raw_name) = caps.get(1).map(|m| m.as_str().trim()) else {
            break;
        };
        let wrapper_attrs = parse_xml_tag_attributes(whole.as_str());
        let open_end = cursor + whole.end();
        let raw_name_lower = raw_name.to_ascii_lowercase();
        if is_xml_named_tool_container_tag(raw_name_lower.as_str()) {
            if open_end <= cursor {
                break;
            }
            cursor = open_end;
            continue;
        }
        let close_tag = format!("</{}>", raw_name_lower);
        let body_end = text_lower[open_end..]
            .find(close_tag.as_str())
            .map(|rel| open_end + rel)
            .unwrap_or(normalized_text.len());
        let full_end = text_lower[body_end..]
            .starts_with(close_tag.as_str())
            .then_some(body_end + close_tag.len())
            .unwrap_or(body_end);
        if !raw_name.is_empty()
            && !matches!(
                raw_name_lower.as_str(),
                "tool_call" | "function_calls" | "function_results" | "quote"
            )
            && should_attempt_xml_wrapper_harvest(raw_name_lower.as_str())
        {
            let body = normalized_text[open_end..body_end].trim();
            if !body.is_empty() {
                index += 1;
                if let Some(entry) = build_xml_named_tool_call_entry(
                    raw_name,
                    body,
                    &wrapper_attrs,
                    fallback_start_id + index - 1,
                ) {
                    if let Ok(key) = serde_json::to_string(&entry) {
                        if seen.insert(key) {
                            recovered.push(entry);
                        }
                    }
                }
            }
        }
        if full_end <= cursor {
            break;
        }
        cursor = full_end;
    }
    recovered
}

fn strip_supported_xml_named_tool_blocks(raw: &str) -> String {
    let normalized_raw = normalize_dsml_tool_markup(raw);
    let Ok(open_pattern) = Regex::new(r"(?is)<([A-Za-z_][A-Za-z0-9_.-]*)(?:\s+[^<>]*?)?>") else {
        return normalized_raw;
    };
    let raw_lower = normalized_raw.to_ascii_lowercase();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0usize;
    while let Some(caps) = open_pattern.captures(&normalized_raw[cursor..]) {
        let Some(whole) = caps.get(0) else {
            break;
        };
        let Some(raw_name) = caps.get(1).map(|m| m.as_str().trim()) else {
            break;
        };
        let start = cursor + whole.start();
        let open_end = cursor + whole.end();
        let raw_name_lower = raw_name.to_ascii_lowercase();
        if matches!(
            raw_name_lower.as_str(),
            "tool_call" | "function_calls" | "function_results" | "quote"
        ) || !should_attempt_xml_wrapper_harvest(raw_name_lower.as_str())
        {
            cursor = open_end;
            continue;
        }
        let close_tag = format!("</{}>", raw_name_lower);
        let body_end = raw_lower[open_end..]
            .find(close_tag.as_str())
            .map(|rel| open_end + rel)
            .unwrap_or(normalized_raw.len());
        let full_end = raw_lower[body_end..]
            .starts_with(close_tag.as_str())
            .then_some(body_end + close_tag.len())
            .unwrap_or(body_end);
        ranges.push((start, full_end));
        if full_end <= cursor {
            break;
        }
        cursor = full_end;
    }

    if ranges.is_empty() {
        return normalized_raw;
    }

    let mut out = String::with_capacity(normalized_raw.len());
    let mut last = 0usize;
    for (start, end) in ranges {
        if start > last {
            out.push_str(&normalized_raw[last..start]);
        }
        last = end.min(normalized_raw.len());
    }
    if last < normalized_raw.len() {
        out.push_str(&normalized_raw[last..]);
    }
    out
}

fn extract_xml_tool_call_blocks(text: &str, fallback_start_id: usize) -> Vec<Value> {
    let Ok(pattern) =
        Regex::new(r#"(?is)<tool_call(?:\s+name\s*=\s*["']([^"']+)["'])?\s*>\s*([\s\S]*?)\s*</tool_call>"#)
    else {
        return Vec::new();
    };
    let mut recovered: Vec<Value> = Vec::new();
    for (idx, caps) in pattern.captures_iter(text).enumerate() {
        let wrapper_name = caps.get(1).map(|m| m.as_str().trim()).filter(|v| !v.is_empty());
        let Some(raw) = caps.get(2).map(|m| m.as_str().trim()) else {
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        let parsed = try_parse_json_value_lenient(raw).or_else(|| {
            let repaired = auto_close_jsonish_shape(raw);
            try_parse_json_value_lenient(repaired.as_str())
        });
        let Some(mut value) = parsed else {
            continue;
        };
        if let Some(explicit_name) = wrapper_name {
            if let Some(row) = value.as_object_mut() {
                if !row.contains_key("name") {
                    row.insert("name".to_string(), Value::String(explicit_name.to_string()));
                }
            }
        }
        if let Some(entry) = normalize_tool_call_entry(&value, fallback_start_id + idx) {
            recovered.push(entry);
        }
    }
    recovered
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

    for inner in extract_rcc_tool_call_fence_segments(raw) {
        push_variant(inner.as_str());
    }

    // Preserve exact payload semantics first. Wrapper-stripped variants are lossy and
    // must only run after the exact raw text, and only when explicit wrapper markers exist.
    push_variant(raw);

    if contains_explicit_tool_wrapper_marker(raw) {
        let masked_wrapper_variant = mask_tool_wrapper_markup(raw);
        if !masked_wrapper_variant.is_empty() && masked_wrapper_variant != raw.trim() {
            push_variant(masked_wrapper_variant.as_str());
        }
    }

    if raw.contains("\\\"tool_calls\\\"") {
        let unescaped = unescape_outer_json_quotes_only(raw);
        push_variant(unescaped.as_str());
    }

    let rcc_patterns = [
        r"(?s)<<RCC_TOOL_CALLS_JSON(?:\s*\n|\s+)([\s\S]*?)(?:\n?\s*RCC_TOOL_CALLS_JSON\b|$)",
        r"(?s)<<RCC_TOOL_CALLS(?:\s*\n|\s+)([\s\S]*?)(?:\n?\s*RCC_TOOL_CALLS\b|$)",
    ];
    for pattern in rcc_patterns {
        let Ok(re) = Regex::new(pattern) else {
            continue;
        };
        let captures: Vec<_> = re.captures_iter(raw).collect();
        for caps in captures.into_iter().rev() {
            if let Some(inner) = caps.get(1) {
                push_variant(inner.as_str());
            }
        }
    }

    out
}

fn extract_rcc_tool_call_fence_segments(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::<String>::new();
    let patterns = [
        Regex::new(r"(?ims)^[^\S\r\n]*(?:[•*-]\s+)?<<\s*RCC_TOOL_CALLS_JSON\s*$([\s\S]*?)^[^\S\r\n]*RCC_TOOL_CALLS_JSON\s*$")
            .expect("valid strict rcc tool calls json heredoc pattern"),
        Regex::new(r"(?ims)^[^\S\r\n]*(?:[•*-]\s+)?<<\s*RCC_TOOL_CALLS\s*$([\s\S]*?)^[^\S\r\n]*RCC_TOOL_CALLS\s*$")
            .expect("valid strict rcc tool calls heredoc pattern"),
    ];

    for pattern in patterns {
        for caps in pattern.captures_iter(raw) {
            let Some(inner) = caps.get(1) else {
                continue;
            };
            let candidate = inner.as_str().trim();
            if !candidate.is_empty() && seen.insert(candidate.to_string()) {
                out.push(candidate.to_string());
            }
        }
    }

    out
}

fn mask_tool_wrapper_markup(raw: &str) -> String {
    let mut masked = raw.replace('\u{feff}', "");

    let wrapper_line_patterns = [
        r"(?im)^[ \t]*```(?:json|javascript|js)?[ \t]*\r?\n?",
        r"(?im)^[ \t]*```[ \t]*\r?\n?",
        r"(?im)^[ \t]*<<RCC_TOOL_CALLS_JSON[ \t]*\r?\n?",
        r"(?im)^[ \t]*RCC_TOOL_CALLS_JSON[ \t]*\r?\n?",
        r"(?im)^[ \t]*<<RCC_TOOL_CALLS[ \t]*\r?\n?",
        r"(?im)^[ \t]*RCC_TOOL_CALLS[ \t]*\r?\n?",
        r"(?im)^[ \t]*<\\|tool_calls_begin\\|>[ \t]*\r?\n?",
        r"(?im)^[ \t]*<\\|tool_calls_end\\|>[ \t]*\r?\n?",
        r"(?im)^[ \t]*<function_calls>[ \t]*\r?\n?",
        r"(?im)^[ \t]*</function_calls>[ \t]*\r?\n?",
    ];
    for pattern in wrapper_line_patterns {
        if let Ok(re) = Regex::new(pattern) {
            masked = re.replace_all(masked.as_str(), "\n").into_owned();
        }
    }

    if let Ok(re) = Regex::new(r#"(?m)^[ \t]*[•·*]\s+(?=(?:\{|\[|<<RCC_TOOL_CALLS|<\|tool_call))"#)
    {
        masked = re.replace_all(masked.as_str(), "").into_owned();
    }

    masked.trim().to_string()
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

fn parse_tool_calls_shape_from_text(text: &str) -> Option<Value> {
    let candidate = build_tool_calls_shape_candidate(text)?;
    let repaired = auto_close_jsonish_shape(candidate.as_str());
    try_parse_json_value_lenient(repaired.as_str())
}

fn extract_tool_call_entries_from_malformed_tool_calls_text(
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
                        if let Some(entry) = normalize_tool_call_entry(
                            &parsed,
                            fallback_start_id + recovered.len(),
                        ) {
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
                        if let Some(entry) = normalize_tool_call_entry(
                            &parsed,
                            fallback_start_id + recovered.len(),
                        ) {
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
                        if let Some(entry) = normalize_tool_call_entry(
                            &parsed,
                            fallback_start_id + recovered.len(),
                        ) {
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

    if !current.trim().is_empty() && (saw_entry_separator_repair || !recovered.is_empty() || saw_array_close) {
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

fn unescape_outer_json_quotes_only(raw: &str) -> String {
    raw.replace("\\\"", "\"")
}

fn maybe_parse_tool_call_text_value(raw: &str) -> Option<Value> {
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

fn is_obviously_truncated_tool_calls_payload(text: &str) -> bool {
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

fn normalize_tool_call_entry(entry: &Value, fallback_id: usize) -> Option<Value> {
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

fn ensure_payload_tool_call_ids(payload: &mut Value, request_id: &str) -> Result<i64, String> {
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

fn read_tool_name_hint_from_args(raw_args: Option<&Value>) -> Option<String> {
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

fn read_tool_call_id_hint_from_args(raw_args: Option<&Value>) -> Option<String> {
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

fn extract_tool_call_entries_from_unknown(value: &Value) -> Vec<Value> {
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
                    if let Some(thinking) = read_trimmed_string(part_row.get("thinking")) {
                        out.push(thinking);
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
    if let Some(reasoning_content) = read_trimmed_string(message.get("reasoning_content")) {
        out.push(reasoning_content);
    }
    if let Some(thinking) = read_trimmed_string(message.get("thinking")) {
        out.push(thinking);
    }

    out
}

fn collect_thinking_reasoning_segments(message: &Map<String, Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::<String>::new();
    let mut push = |value: String| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        if seen.insert(trimmed.clone()) {
            out.push(trimmed);
        }
    };

    if let Some(content) = message.get("content") {
        match content {
            Value::Array(parts) => {
                for part in parts {
                    let Some(part_row) = part.as_object() else {
                        continue;
                    };
                    let part_type = read_trimmed_string(part_row.get("type"))
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    if part_type != "thinking" && part_type != "reasoning" {
                        continue;
                    }
                    if let Some(text) = read_trimmed_string(part_row.get("thinking"))
                        .or_else(|| read_trimmed_string(part_row.get("text")))
                        .or_else(|| read_trimmed_string(part_row.get("content")))
                    {
                        push(text);
                    }
                }
            }
            Value::Object(part_row) => {
                let part_type = read_trimmed_string(part_row.get("type"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if part_type == "thinking" || part_type == "reasoning" {
                    if let Some(text) = read_trimmed_string(part_row.get("thinking"))
                        .or_else(|| read_trimmed_string(part_row.get("text")))
                        .or_else(|| read_trimmed_string(part_row.get("content")))
                    {
                        push(text);
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(thinking) = read_trimmed_string(message.get("thinking")) {
        push(thinking);
    }

    out
}

fn has_visible_text_content_excluding_reasoning(content: Option<&Value>) -> bool {
    match content {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Array(parts)) => {
            parts
                .iter()
                .filter_map(|part| part.as_object())
                .any(|part_row| {
                    let part_type = read_trimmed_string(part_row.get("type"))
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    if part_type == "thinking" || part_type == "reasoning" {
                        return false;
                    }
                    read_trimmed_string(part_row.get("text")).is_some()
                        || read_trimmed_string(part_row.get("content")).is_some()
                })
        }
        Some(Value::Object(part_row)) => {
            let part_type = read_trimmed_string(part_row.get("type"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if part_type == "thinking" || part_type == "reasoning" {
                return false;
            }
            read_trimmed_string(part_row.get("text")).is_some()
                || read_trimmed_string(part_row.get("content")).is_some()
        }
        _ => false,
    }
}

fn normalize_thinking_only_reasoning_content(payload: &mut Value) -> i64 {
    let mut normalized = 0i64;
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return normalized;
    };

    for choice in choices {
        let Some(choice_row) = choice.as_object_mut() else {
            continue;
        };
        let Some(message) = choice_row
            .get_mut("message")
            .and_then(|v| v.as_object_mut())
        else {
            continue;
        };

        let has_tool_calls = message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .map(|rows| !rows.is_empty())
            .unwrap_or(false);
        if has_tool_calls {
            continue;
        }

        let thinking_segments = collect_thinking_reasoning_segments(message);
        if thinking_segments.is_empty() {
            continue;
        }

        let existing_reasoning = read_trimmed_string(message.get("reasoning_content"));
        let mut merged: Vec<String> = Vec::new();
        if let Some(existing) = existing_reasoning {
            merged.push(existing);
        }
        for segment in thinking_segments {
            if !merged.iter().any(|existing| existing == &segment) {
                merged.push(segment);
            }
        }
        if merged.is_empty() {
            continue;
        }

        message.insert(
            "reasoning_content".to_string(),
            Value::String(merged.join("\n\n")),
        );
        if !has_visible_text_content_excluding_reasoning(message.get("content")) {
            message.insert("content".to_string(), Value::String(String::new()));
        }
        normalized += 1;
    }

    normalized
}

fn strip_leading_bullet_prefix(raw: &str) -> &str {
    raw.trim_start_matches(|ch: char| matches!(ch, ' ' | '\t' | '\r' | '\n' | '•' | '·' | '*'))
}

fn is_empty_tool_calls_payload(value: &Value) -> bool {
    value
        .as_object()
        .and_then(|obj| obj.get("tool_calls"))
        .and_then(Value::as_array)
        .map(|rows| rows.is_empty())
        .unwrap_or(false)
}

fn looks_like_empty_tool_calls_payload_text(raw: &str) -> bool {
    let trimmed = strip_leading_bullet_prefix(raw).trim();
    if trimmed.is_empty() {
        return false;
    }
    let starts_like_direct_payload = trimmed.starts_with('{')
        || trimmed.starts_with('[')
        || trimmed.starts_with("```")
        || trimmed.starts_with("<<RCC_TOOL_CALLS");
    if !starts_like_direct_payload {
        return false;
    }
    try_parse_json_value_lenient(trimmed)
        .as_ref()
        .map(is_empty_tool_calls_payload)
        .unwrap_or(false)
}

fn strip_empty_tool_calls_payload_noise(raw: &str) -> String {
    if looks_like_empty_tool_calls_payload_text(raw) {
        return String::new();
    }

    let mut lines: Vec<&str> = Vec::new();
    let mut changed = false;
    for line in raw.lines() {
        if looks_like_empty_tool_calls_payload_text(line) {
            changed = true;
            continue;
        }
        lines.push(line);
    }
    let mut text = if changed {
        lines.join("\n")
    } else {
        raw.to_string()
    };

    let rcc_patterns = [
        r"(?s)<<RCC_TOOL_CALLS_JSON(?:\s*\n|\s+)([\s\S]*?)(?:\n?\s*RCC_TOOL_CALLS_JSON\b|$)",
        r"(?s)<<RCC_TOOL_CALLS(?:\s*\n|\s+)([\s\S]*?)(?:\n?\s*RCC_TOOL_CALLS\b|$)",
    ];
    for pattern in rcc_patterns {
        let Ok(re) = Regex::new(pattern) else {
            continue;
        };
        text = re
            .replace_all(text.as_str(), |caps: &regex::Captures| {
                let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                if looks_like_empty_tool_calls_payload_text(inner) {
                    String::new()
                } else {
                    caps.get(0)
                        .map(|m| m.as_str().to_string())
                        .unwrap_or_default()
                }
            })
            .to_string();
    }

    text
}

fn strip_tool_call_marker_payload(raw: &str) -> String {
    fn is_rcc_wrapper_only_text(raw: &str) -> bool {
        let patterns = [
            r"(?s)<<RCC_TOOL_CALLS_JSON(?:\s*\n|\s+)[\s\S]*?(?:\n?\s*RCC_TOOL_CALLS_JSON\b|$)",
            r"(?s)<<RCC_TOOL_CALLS(?:\s*\n|\s+)[\s\S]*?(?:\n?\s*RCC_TOOL_CALLS\b|$)",
        ];
        for pattern in patterns {
            let Ok(re) = Regex::new(pattern) else {
                continue;
            };
            if let Some(matched) = re.find(raw) {
                let prefix = raw[..matched.start()].trim();
                let suffix = raw[matched.end()..].trim();
                if prefix.is_empty() && suffix.is_empty() {
                    return true;
                }
            }
        }
        false
    }

    fn looks_like_direct_tool_payload_text(raw: &str) -> bool {
        let trimmed = strip_leading_bullet_prefix(raw).trim();
        if trimmed.is_empty() {
            return false;
        }
        let starts_like_payload = trimmed.starts_with('{')
            || trimmed.starts_with('[')
            || trimmed.starts_with("```")
            || trimmed.starts_with("<<RCC_TOOL_CALLS");
        if !starts_like_payload {
            return false;
        }
        if trimmed.starts_with("<<RCC_TOOL_CALLS") && !is_rcc_wrapper_only_text(trimmed) {
            return false;
        }
        maybe_parse_tool_call_text_value(trimmed)
            .as_ref()
            .map(|parsed| !extract_tool_call_entries_from_unknown(parsed).is_empty())
            .unwrap_or(false)
    }

    fn wrapper_contains_harvestable_tool_payload(raw: &str) -> bool {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return false;
        }
        maybe_parse_tool_call_text_value(trimmed)
            .as_ref()
            .map(|parsed| !extract_tool_call_entries_from_unknown(parsed).is_empty())
            .unwrap_or(false)
    }

    fn find_first_tool_wrapper_start(raw: &str) -> Option<usize> {
        let mut earliest = [
            "<function_calls>",
            "<tool_call>",
            "<tool_calls>",
            "<|dsml|tool_calls>",
        ]
        .iter()
        .filter_map(|marker| raw.find(marker))
        .min();

        if let Ok(open_pattern) = Regex::new(r"(?is)<([A-Za-z_][A-Za-z0-9_.-]*)>") {
            for caps in open_pattern.captures_iter(raw) {
                let Some(whole) = caps.get(0) else {
                    continue;
                };
                let Some(raw_name) = caps.get(1).map(|m| m.as_str().trim()) else {
                    continue;
                };
                let normalized = raw_name.to_ascii_lowercase();
                let is_supported = if normalized == "quote" {
                    raw[whole.end()..]
                        .to_ascii_lowercase()
                        .contains("tool_calls")
                } else if matches!(
                    normalized.as_str(),
                    "tool_call" | "function_calls" | "function_results"
                ) {
                    true
                } else {
                    should_attempt_xml_wrapper_harvest(normalized.as_str())
                };
                if !is_supported {
                    continue;
                }
                earliest = Some(match earliest {
                    Some(current) => current.min(whole.start()),
                    None => whole.start(),
                });
            }
        }

        earliest
    }

    let normalized_raw = normalize_dsml_tool_markup(raw);
    let raw = strip_empty_tool_calls_payload_noise(normalized_raw.as_str());
    if raw.trim().is_empty() {
        return String::new();
    }
    if looks_like_direct_tool_payload_text(raw.as_str()) {
        return String::new();
    }

    let mut text = raw.to_string();
    let rcc_patterns = [
        r"(?s)<<RCC_TOOL_CALLS_JSON(?:\s*\n|\s+)([\s\S]*?)(?:\n?\s*RCC_TOOL_CALLS_JSON\b|$)",
        r"(?s)<<RCC_TOOL_CALLS(?:\s*\n|\s+)([\s\S]*?)(?:\n?\s*RCC_TOOL_CALLS\b|$)",
    ];
    for pattern in rcc_patterns {
        let Ok(re) = Regex::new(pattern) else {
            continue;
        };
        text = re
            .replace_all(text.as_str(), |caps: &regex::Captures| {
                let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                if wrapper_contains_harvestable_tool_payload(inner) {
                    String::new()
                } else {
                    caps.get(0)
                        .map(|m| m.as_str().to_string())
                        .unwrap_or_default()
                }
            })
            .to_string();
    }

    let mut direct_payload_lines_changed = false;
    let mut filtered_lines: Vec<&str> = Vec::new();
    for line in text.lines() {
        if looks_like_direct_tool_payload_text(line) {
            direct_payload_lines_changed = true;
            continue;
        }
        filtered_lines.push(line);
    }
    if direct_payload_lines_changed {
        text = filtered_lines.join("\n");
    }

    let patterns = [
        r"(?is)<tool_calls>[\s\S]*?</tool_calls>",
        r"(?is)<tool_call>[\s\S]*?</tool_call>",
        r"(?is)<function_calls>[\s\S]*?</function_calls>",
        r"(?is)<quote>\s*[\s\S]*?\btool_calls\b[\s\S]*?</quote>",
    ];
    for pattern in patterns {
        if let Ok(re) = Regex::new(pattern) {
            text = re.replace_all(text.as_str(), "").to_string();
        }
    }
    text = strip_supported_xml_named_tool_blocks(text.as_str());
    if let Some(start) = find_first_tool_wrapper_start(text.as_str()) {
        text = text[..start].to_string();
    }
    text = strip_known_non_tool_xml_tags_preserve_text(text.as_str());
    text.trim().to_string()
}

fn strip_orphan_tool_markup_lines(raw: &str) -> String {
    let mut text = raw.to_string();
    let patterns = [
        r"(?im)^[ \t]*</function_calls>[ \t]*\r?\n?",
        r"(?im)^[ \t]*</tool_call>[ \t]*\r?\n?",
        r"(?im)^[ \t]*</function>[ \t]*\r?\n?",
        r"(?im)^[ \t]*</parameter>[ \t]*\r?\n?",
        r"(?im)^[ \t]*</arg_key>[ \t]*\r?\n?",
        r"(?im)^[ \t]*</arg_value>[ \t]*\r?\n?",
    ];
    for pattern in patterns {
        if let Ok(re) = Regex::new(pattern) {
            text = re.replace_all(text.as_str(), "").to_string();
        }
    }
    text.trim().to_string()
}

fn strip_known_non_tool_xml_tags_preserve_text(raw: &str) -> String {
    let Ok(tag_re) = Regex::new(r"(?is)</?(search|query)>") else {
        return raw.trim().to_string();
    };
    if !tag_re.is_match(raw) {
        return raw.to_string();
    }
    let replaced = tag_re.replace_all(raw, " ").to_string();
    normalize_preserved_text_whitespace(replaced.as_str())
}

fn strip_text_tool_wrapper_noise(raw: &str) -> String {
    let mut text = raw.to_string();
    let patterns = [
        r"(?is)<\|ChunkingError\|>[\s\S]*?(?:<｜end▁of▁thinking｜>|<\|end▁of▁thinking\|>|$)",
        r"(?is)<｜end▁of▁thinking｜>",
        r"(?im)^\s*Tool\s+[A-Za-z0-9_.-]+\s+does\s+not\s+exists\.\s*$",
        r"(?im)^\s*I cannot access your local files\.?\s*$",
        r"(?im)^\s*当前环境是沙箱隔离.*$",
    ];
    for pattern in patterns {
        let Ok(re) = Regex::new(pattern) else {
            continue;
        };
        text = re.replace_all(text.as_str(), "").to_string();
    }
    text = strip_known_non_tool_xml_tags_preserve_text(text.as_str());
    text.trim().to_string()
}

fn fallback_preserve_inner_text_when_cleaned_empty(raw: &str, cleaned: &str) -> Option<String> {
    if !cleaned.trim().is_empty() {
        return None;
    }
    if looks_like_empty_tool_calls_payload_text(raw) {
        return None;
    }
    if contains_explicit_tool_wrapper_marker(raw) {
        return None;
    }
    let rcc_patterns = [
        r"(?s)<<RCC_TOOL_CALLS_JSON(?:\s*\n|\s+)([\s\S]*?)(?:\n?\s*RCC_TOOL_CALLS_JSON\b|$)",
        r"(?s)<<RCC_TOOL_CALLS(?:\s*\n|\s+)([\s\S]*?)(?:\n?\s*RCC_TOOL_CALLS\b|$)",
    ];
    for pattern in rcc_patterns {
        let Ok(re) = Regex::new(pattern) else {
            continue;
        };
        let captures: Vec<_> = re.captures_iter(raw).collect();
        for caps in captures.into_iter().rev() {
            let Some(full) = caps.get(0) else {
                continue;
            };
            let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            if looks_like_empty_tool_calls_payload_text(inner) {
                continue;
            }
            let prefix = normalize_preserved_text_whitespace(&raw[..full.start()]);
            let suffix = normalize_preserved_text_whitespace(&raw[full.end()..]);
            let mut outside: Vec<String> = Vec::new();
            if !prefix.is_empty() {
                outside.push(prefix);
            }
            if !suffix.is_empty() {
                outside.push(suffix);
            }
            if !outside.is_empty() {
                return Some(outside.join("\n\n"));
            }
        }
    }
    if raw.contains('<') && raw.contains('>') {
        let preserved = strip_xml_tags_preserve_text(raw);
        if !preserved.trim().is_empty() {
            return Some(preserved);
        }
    }
    if let Some(inner) = extract_rcc_tool_call_inner_payload(raw) {
        return Some(inner);
    }
    None
}

fn extract_rcc_tool_call_inner_payload(raw: &str) -> Option<String> {
    let patterns = [
        r"(?s)<<RCC_TOOL_CALLS_JSON(?:\s*\n|\s+)([\s\S]*?)(?:\n?\s*RCC_TOOL_CALLS_JSON\b|$)",
        r"(?s)<<RCC_TOOL_CALLS(?:\s*\n|\s+)([\s\S]*?)(?:\n?\s*RCC_TOOL_CALLS\b|$)",
    ];
    for pattern in patterns {
        let Ok(re) = Regex::new(pattern) else {
            continue;
        };
        let captures: Vec<_> = re.captures_iter(raw).collect();
        for caps in captures.into_iter().rev() {
            let Some(inner) = caps.get(1).map(|m| m.as_str().trim()) else {
                continue;
            };
            if inner.is_empty() {
                continue;
            }
            if looks_like_empty_tool_calls_payload_text(inner) {
                continue;
            }
            return Some(inner.to_string());
        }
    }
    None
}

fn extract_explicit_tool_wrapper_inner_payload(raw: &str) -> Option<String> {
    if let Some(inner) = extract_rcc_tool_call_inner_payload(raw) {
        return Some(inner);
    }
    let patterns = [
        r"(?is)<function_calls>\s*([\s\S]*?)\s*</function_calls>",
        r"(?is)<tool_call>\s*([\s\S]*?)\s*</tool_call>",
    ];
    for pattern in patterns {
        let Ok(re) = Regex::new(pattern) else {
            continue;
        };
        let captures: Vec<_> = re.captures_iter(raw).collect();
        for caps in captures.into_iter().rev() {
            let Some(inner) = caps.get(1).map(|m| m.as_str().trim()) else {
                continue;
            };
            if inner.is_empty() || looks_like_empty_tool_calls_payload_text(inner) {
                continue;
            }
            return Some(inner.to_string());
        }
    }
    None
}

fn fallback_preserve_explicit_wrapper_content_when_cleaned_empty(raw: &str) -> Option<String> {
    if !contains_explicit_tool_wrapper_marker(raw) {
        return None;
    }
    let inner = extract_explicit_tool_wrapper_inner_payload(raw)?;
    let harvestable = maybe_parse_tool_call_text_value(inner.as_str())
        .as_ref()
        .map(|parsed| !extract_tool_call_entries_from_unknown(parsed).is_empty())
        .unwrap_or(false);
    if harvestable {
        return Some(raw.trim().to_string());
    }
    let preserved = strip_xml_tags_preserve_text(inner.as_str());
    if !preserved.trim().is_empty() {
        return Some(preserved);
    }
    None
}

fn fallback_preserve_wrapper_only_code_fence_when_cleaned_empty(raw: &str) -> Option<String> {
    if !is_wrapper_only_explicit_tool_markup(raw) {
        return None;
    }
    let inner = extract_explicit_tool_wrapper_inner_payload(raw)?;
    let harvestable = maybe_parse_tool_call_text_value(inner.as_str())
        .as_ref()
        .map(|parsed| !extract_tool_call_entries_from_unknown(parsed).is_empty())
        .unwrap_or(false);
    if harvestable {
        return None;
    }
    if !inner.contains("```") {
        return None;
    }
    let preserved = strip_xml_tags_preserve_text(inner.as_str());
    if preserved.trim().is_empty() {
        None
    } else {
        Some(preserved)
    }
}

fn is_wrapper_only_explicit_tool_markup(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    let patterns = [
        r"(?is)\A<function_calls>\s*[\s\S]*?\s*</function_calls>\z",
        r"(?is)\A<tool_call>\s*[\s\S]*?\s*</tool_call>\z",
        r"(?is)\A<<RCC_TOOL_CALLS_JSON(?:\s*\n|\s+)[\s\S]*?(?:\n?\s*RCC_TOOL_CALLS_JSON\b)\s*\z",
        r"(?is)\A<<RCC_TOOL_CALLS(?:\s*\n|\s+)[\s\S]*?(?:\n?\s*RCC_TOOL_CALLS\b)\s*\z",
    ];
    patterns.iter().any(|pattern| {
        Regex::new(pattern)
            .map(|re| re.is_match(trimmed))
            .unwrap_or(false)
    })
}

fn resolve_cleaned_empty_marker_preservation(
    raw: &str,
    cleaned: &str,
    allow_empty_removal: bool,
) -> Option<String> {
    if allow_empty_removal {
        return fallback_preserve_wrapper_only_code_fence_when_cleaned_empty(raw);
    }
    fallback_preserve_explicit_wrapper_content_when_cleaned_empty(raw)
        .or_else(|| fallback_preserve_inner_text_when_cleaned_empty(raw, cleaned))
}

fn strip_rcc_wrapper_trailing_terminal_noise(raw: &str) -> String {
    let Ok(prompt_re) = Regex::new(r"^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+\*?$") else {
        return raw.trim().to_string();
    };
    let mut kept: Vec<&str> = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        let is_terminal_tail = trimmed.starts_with('›')
            || trimmed.starts_with('⏺')
            || trimmed.starts_with('✻')
            || prompt_re.is_match(trimmed);
        if is_terminal_tail {
            break;
        }
        kept.push(line);
    }
    kept.join("\n").trim().to_string()
}

fn sanitize_textual_noise_field_in_message(
    message: &mut Map<String, Value>,
    key: &str,
    allow_empty_removal: bool,
) -> bool {
    let Some(raw) = message
        .get(key)
        .and_then(Value::as_str)
        .map(|v| v.to_string())
    else {
        return false;
    };
    let cleaned = strip_text_tool_wrapper_noise(raw.as_str());
    if cleaned == raw {
        return false;
    }
    if let Some(preserved) = (!allow_empty_removal)
        .then(|| fallback_preserve_inner_text_when_cleaned_empty(raw.as_str(), cleaned.as_str()))
        .flatten()
    {
        message.insert(key.to_string(), Value::String(preserved));
    } else if cleaned.is_empty() {
        if allow_empty_removal {
            message.remove(key);
        } else {
            message.insert(key.to_string(), Value::String(String::new()));
        }
    } else {
        message.insert(key.to_string(), Value::String(cleaned));
    }
    true
}

fn sanitize_textual_marker_field_in_message(message: &mut Map<String, Value>, key: &str) -> bool {
    let Some(raw) = message
        .get(key)
        .and_then(Value::as_str)
        .map(|v| v.to_string())
    else {
        return false;
    };
    let cleaned = strip_tool_call_marker_payload(raw.as_str());
    if cleaned == raw {
        return false;
    }
    if cleaned.is_empty() {
        if let Some(preserved) =
            resolve_cleaned_empty_marker_preservation(raw.as_str(), cleaned.as_str(), false)
        {
            message.insert(key.to_string(), Value::String(preserved));
        } else {
            message.remove(key);
        }
    } else {
        let cleaned = if raw.contains("<<RCC_TOOL_CALLS") {
            strip_rcc_wrapper_trailing_terminal_noise(cleaned.as_str())
        } else {
            cleaned
        };
        message.insert(key.to_string(), Value::String(cleaned));
    }
    true
}

fn sanitize_textual_marker_field_in_message_with_policy(
    message: &mut Map<String, Value>,
    key: &str,
    allow_empty_removal: bool,
) -> bool {
    let Some(raw) = message
        .get(key)
        .and_then(Value::as_str)
        .map(|v| v.to_string())
    else {
        return false;
    };
    let mut cleaned = strip_tool_call_marker_payload(raw.as_str());
    if allow_empty_removal
        && !cleaned.trim().is_empty()
        && contains_explicit_tool_wrapper_marker(raw.as_str())
    {
        let transcript_unwrapped = sanitize_text_harvest_shape(raw.as_str());
        if transcript_unwrapped != raw {
            let transcript_cleaned = strip_rcc_wrapper_trailing_terminal_noise(
                strip_tool_call_marker_payload(transcript_unwrapped.as_str()).as_str(),
            );
            if transcript_cleaned.trim().is_empty() {
                cleaned = String::new();
            }
        }
    }
    if cleaned == raw {
        return false;
    }
    if cleaned.is_empty() {
        if let Some(preserved) = resolve_cleaned_empty_marker_preservation(
            raw.as_str(),
            cleaned.as_str(),
            allow_empty_removal,
        ) {
            message.insert(key.to_string(), Value::String(preserved));
        } else if allow_empty_removal {
            message.remove(key);
        } else {
            message.insert(key.to_string(), Value::String(String::new()));
        }
    } else {
        let cleaned = if allow_empty_removal && raw.contains("<<RCC_TOOL_CALLS") {
            strip_rcc_wrapper_trailing_terminal_noise(cleaned.as_str())
        } else {
            cleaned
        };
        message.insert(key.to_string(), Value::String(cleaned));
    }
    true
}

pub(crate) fn strip_tool_markup_for_display_text(raw: &str) -> String {
    let cleaned = strip_orphan_tool_markup_lines(strip_tool_call_marker_payload(raw).as_str());
    if let Some(preserved) = fallback_preserve_inner_text_when_cleaned_empty(raw, cleaned.as_str())
    {
        return preserved;
    }
    cleaned
}

fn sanitize_content_field_after_tool_markup(
    message: &mut Map<String, Value>,
    allow_empty_clear: bool,
) -> i64 {
    let Some(content) = message.get_mut("content") else {
        return 0;
    };

    match content {
        Value::String(raw) => {
            let mut cleaned =
                strip_orphan_tool_markup_lines(strip_tool_call_marker_payload(raw).as_str());
            if allow_empty_clear
                && !cleaned.trim().is_empty()
                && contains_explicit_tool_wrapper_marker(raw.as_str())
            {
                let transcript_unwrapped = sanitize_text_harvest_shape(raw.as_str());
                if transcript_unwrapped != raw.as_str() {
                    let transcript_cleaned = strip_rcc_wrapper_trailing_terminal_noise(
                        strip_orphan_tool_markup_lines(
                            strip_tool_call_marker_payload(transcript_unwrapped.as_str()).as_str(),
                        )
                        .as_str(),
                    );
                    if transcript_cleaned.trim().is_empty() {
                        cleaned = String::new();
                    }
                }
            }
            if cleaned == raw.as_str() {
                return 0;
            }
            if cleaned.is_empty() {
                if let Some(preserved) = resolve_cleaned_empty_marker_preservation(
                    raw.as_str(),
                    cleaned.as_str(),
                    allow_empty_clear,
                ) {
                    *content = Value::String(preserved);
                } else {
                    *content = Value::String(String::new());
                }
            } else {
                let cleaned = if allow_empty_clear && raw.contains("<<RCC_TOOL_CALLS") {
                    strip_rcc_wrapper_trailing_terminal_noise(cleaned.as_str())
                } else {
                    cleaned
                };
                *content = Value::String(cleaned);
            }
            1
        }
        Value::Array(parts) => {
            let original = std::mem::take(parts);
            let mut next: Vec<Value> = Vec::new();
            let mut changed = 0i64;
            for mut part in original {
                let Some(part_row) = part.as_object_mut() else {
                    next.push(part);
                    continue;
                };
                for key in ["text", "content", "thinking"] {
                    let Some(raw) = part_row.get(key).and_then(Value::as_str) else {
                        continue;
                    };
                    let cleaned = strip_orphan_tool_markup_lines(
                        strip_tool_call_marker_payload(raw).as_str(),
                    );
                    if cleaned == raw {
                        continue;
                    }
                    changed += 1;
                    if cleaned.is_empty() {
                        if let Some(preserved) = resolve_cleaned_empty_marker_preservation(
                            raw,
                            cleaned.as_str(),
                            allow_empty_clear,
                        ) {
                            part_row.insert(key.to_string(), Value::String(preserved));
                        } else {
                            part_row.remove(key);
                        }
                    } else {
                        let cleaned = if allow_empty_clear && raw.contains("<<RCC_TOOL_CALLS") {
                            strip_rcc_wrapper_trailing_terminal_noise(cleaned.as_str())
                        } else {
                            cleaned
                        };
                        part_row.insert(key.to_string(), Value::String(cleaned));
                    }
                }
                let keep = part_row.values().any(|value| match value {
                    Value::String(raw) => !raw.trim().is_empty(),
                    Value::Array(items) => !items.is_empty(),
                    Value::Object(obj) => !obj.is_empty(),
                    Value::Null => false,
                    _ => true,
                });
                if keep {
                    next.push(part);
                } else {
                    changed += 1;
                }
            }
            *parts = next;
            changed
        }
        Value::Object(part_row) => {
            let mut changed = 0i64;
            for key in ["text", "content", "thinking"] {
                let Some(raw) = part_row.get(key).and_then(Value::as_str) else {
                    continue;
                };
                let cleaned =
                    strip_orphan_tool_markup_lines(strip_tool_call_marker_payload(raw).as_str());
                if cleaned == raw {
                    continue;
                }
                changed += 1;
                if cleaned.is_empty() {
                    if let Some(preserved) = resolve_cleaned_empty_marker_preservation(
                        raw,
                        cleaned.as_str(),
                        allow_empty_clear,
                    ) {
                        part_row.insert(key.to_string(), Value::String(preserved));
                    } else {
                        part_row.remove(key);
                    }
                } else {
                    let cleaned = if allow_empty_clear && raw.contains("<<RCC_TOOL_CALLS") {
                        strip_rcc_wrapper_trailing_terminal_noise(cleaned.as_str())
                    } else {
                        cleaned
                    };
                    part_row.insert(key.to_string(), Value::String(cleaned));
                }
            }
            changed
        }
        _ => 0,
    }
}

fn sanitize_reasoning_fields_after_tool_harvest(message: &mut Map<String, Value>) -> i64 {
    let mut changed = 0i64;
    let has_tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    changed += sanitize_content_field_after_tool_markup(message, has_tool_calls);
    if sanitize_textual_marker_field_in_message_with_policy(
        message,
        "reasoning_content",
        has_tool_calls,
    ) {
        changed += 1;
    }
    if sanitize_textual_marker_field_in_message_with_policy(message, "thinking", has_tool_calls) {
        changed += 1;
    }

    let mut should_remove_reasoning = false;
    if has_tool_calls {
        if let Some(reasoning) = message.get_mut("reasoning") {
            match reasoning {
                Value::String(raw) => {
                    let cleaned = strip_tool_call_marker_payload(raw);
                    if cleaned != raw.as_str() {
                        changed += 1;
                        if cleaned.is_empty() {
                            should_remove_reasoning = true;
                        } else {
                            *reasoning = Value::String(cleaned);
                        }
                    }
                }
                Value::Object(row) => {
                    if let Some(content) = row.get_mut("content").and_then(Value::as_array_mut) {
                        let original = std::mem::take(content);
                        let mut next: Vec<Value> = Vec::new();
                        for mut entry in original {
                            let Some(entry_row) = entry.as_object_mut() else {
                                continue;
                            };
                            let text_key =
                                if entry_row.get("text").and_then(Value::as_str).is_some() {
                                    Some("text")
                                } else if entry_row.get("content").and_then(Value::as_str).is_some()
                                {
                                    Some("content")
                                } else {
                                    None
                                };

                            if let Some(key) = text_key {
                                let raw = entry_row
                                    .get(key)
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string();
                                let cleaned = strip_tool_call_marker_payload(raw.as_str());
                                if cleaned != raw {
                                    changed += 1;
                                }
                                if cleaned.is_empty() {
                                    continue;
                                }
                                entry_row.insert(key.to_string(), Value::String(cleaned));
                            }
                            next.push(entry);
                        }
                        *content = next;
                        if content.is_empty() {
                            row.remove("content");
                        }
                    }
                    let has_content = row
                        .get("content")
                        .and_then(Value::as_array)
                        .map(|entries| !entries.is_empty())
                        .unwrap_or(false);
                    let has_summary = row
                        .get("summary")
                        .and_then(Value::as_array)
                        .map(|entries| !entries.is_empty())
                        .unwrap_or(false);
                    let has_encrypted = row.get("encrypted_content").is_some();
                    if !has_content && !has_summary && !has_encrypted {
                        should_remove_reasoning = true;
                    }
                }
                _ => {}
            }
        }
    }

    if should_remove_reasoning {
        message.remove("reasoning");
        changed += 1;
    }

    if has_tool_calls {
        if sanitize_textual_noise_field_in_message(message, "content", true) {
            changed += 1;
        }
        if sanitize_textual_noise_field_in_message(message, "reasoning_content", true) {
            changed += 1;
        }
        if sanitize_textual_noise_field_in_message(message, "thinking", true) {
            changed += 1;
        }
    }
    changed
}

fn sanitize_payload_tool_markup_fields(payload: &mut Value) -> i64 {
    let mut changed = 0i64;
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return changed;
    };
    for choice in choices {
        let Some(message) = choice
            .get_mut("message")
            .and_then(|value| value.as_object_mut())
        else {
            continue;
        };
        changed += sanitize_reasoning_fields_after_tool_harvest(message);
    }
    changed
}

fn strip_orphan_function_calls_tag(payload: &mut Value) {
    if let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) {
        for choice in choices {
            if let Some(message) = choice.get_mut("message").and_then(|v| v.as_object_mut()) {
                let has_tool_calls = message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .map(|rows| !rows.is_empty())
                    .unwrap_or(false);
                if let Some(content_val) = message.get_mut("content") {
                    if let Some(content) = content_val.as_str() {
                        if !has_tool_calls {
                            let stripped_payload = strip_tool_call_marker_payload(content);
                            if stripped_payload == content {
                                continue;
                            }
                            let cleaned_payload =
                                strip_orphan_tool_markup_lines(stripped_payload.as_str());
                            if !cleaned_payload.is_empty() {
                                *content_val = Value::String(cleaned_payload);
                                continue;
                            }
                            if let Some(preserved) = is_wrapper_only_explicit_tool_markup(content)
                                .then(|| {
                                    fallback_preserve_explicit_wrapper_content_when_cleaned_empty(
                                        content,
                                    )
                                })
                                .flatten()
                            {
                                *content_val = Value::String(preserved);
                                continue;
                            }
                        }
                        let new_content = content
                            .replace("<function_calls>", "")
                            .replace("</function_calls>", "");
                        let new_content = strip_orphan_tool_markup_lines(new_content.as_str());
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

pub(crate) fn harvest_text_tool_calls_from_payload(payload: &mut Value) -> i64 {
    harvest_explicit_wrapper_only_tool_calls_from_payload(payload)
}

fn extract_strict_wrapper_tool_calls_from_function_calls(
    text: &str,
    fallback_start_id: usize,
) -> Vec<Value> {
    let Ok(pattern) = Regex::new(r"(?is)<function_calls>\s*([\s\S]*?)\s*</function_calls>") else {
        return Vec::new();
    };
    let mut recovered: Vec<Value> = Vec::new();
    for caps in pattern.captures_iter(text) {
        let Some(raw) = caps.get(1).map(|m| m.as_str().trim()) else {
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        let parsed = try_parse_json_value_lenient(raw);
        let Some(value) = parsed else {
            continue;
        };
        for entry in extract_tool_call_entries_from_unknown(&value) {
            if let Some(normalized) =
                normalize_tool_call_entry(&entry, fallback_start_id + recovered.len())
            {
                recovered.push(normalized);
            }
        }
    }
    recovered
}

fn extract_strict_wrapper_tool_calls_from_tool_calls_container(
    text: &str,
    fallback_start_id: usize,
) -> Vec<Value> {
    let normalized_text = normalize_dsml_tool_markup(text);
    let Ok(pattern) = Regex::new(r"(?is)<tool_calls>\s*([\s\S]*?)\s*</tool_calls>") else {
        return Vec::new();
    };
    let mut recovered: Vec<Value> = Vec::new();
    for caps in pattern.captures_iter(&normalized_text) {
        let Some(raw) = caps.get(1).map(|m| m.as_str().trim()) else {
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        let parsed = maybe_parse_tool_call_text_value(raw);
        let Some(value) = parsed else {
            continue;
        };
        for entry in extract_tool_call_entries_from_unknown(&value) {
            if let Some(normalized) =
                normalize_tool_call_entry(&entry, fallback_start_id + recovered.len())
            {
                recovered.push(normalized);
            }
        }
    }
    recovered
}

fn extract_strict_wrapper_tool_calls_from_rcc(text: &str, fallback_start_id: usize) -> Vec<Value> {
    let mut recovered: Vec<Value> = Vec::new();
    for inner in extract_rcc_tool_call_fence_segments(text) {
        let parsed = try_parse_json_value_lenient(inner.as_str());
        let Some(value) = parsed else {
            continue;
        };
        for entry in extract_tool_call_entries_from_unknown(&value) {
            if let Some(normalized) =
                normalize_tool_call_entry(&entry, fallback_start_id + recovered.len())
            {
                recovered.push(normalized);
            }
        }
    }
    recovered
}

fn extract_tool_calls_from_text_candidate(text: &str, fallback_start_id: usize) -> Vec<Value> {
    if is_obviously_truncated_tool_calls_payload(text) {
        return Vec::new();
    }

    let mut recovered: Vec<Value> = Vec::new();

    recovered =
        extract_tool_call_entries_from_malformed_tool_calls_text(text, fallback_start_id);

    if recovered.is_empty() {
        if let Some(parsed) = maybe_parse_tool_call_text_value(text) {
        recovered = extract_tool_call_entries_from_unknown(&parsed);
        }
    }

    if recovered.is_empty() {
        for parsed in extract_json_candidates_from_text(text) {
            recovered = extract_tool_call_entries_from_unknown(&parsed);
            if !recovered.is_empty() {
                break;
            }
        }
    }

    if recovered.is_empty() {
        if let Some(shape) = parse_tool_calls_shape_from_text(text) {
            recovered = extract_tool_call_entries_from_unknown(&shape);
        }
    }

    if recovered.is_empty() {
        recovered = extract_xml_tool_call_blocks(text, fallback_start_id);
    }
    if recovered.is_empty() {
        recovered = extract_xml_named_tool_call_blocks(text, fallback_start_id);
    }
    if recovered.is_empty() {
        recovered = extract_strict_wrapper_tool_calls_from_tool_calls_container(
            text,
            fallback_start_id,
        );
    }
    if recovered.is_empty() {
        recovered = extract_strict_wrapper_tool_calls_from_function_calls(text, fallback_start_id);
    }
    if recovered.is_empty() {
        recovered = extract_strict_wrapper_tool_calls_from_rcc(text, fallback_start_id);
    }

    recovered
}

pub(crate) fn harvest_explicit_wrapper_only_tool_calls_from_payload(payload: &mut Value) -> i64 {
    let mut harvested = 0i64;
    let requested_tool_name_keys = collect_requested_tool_name_keys(payload);
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
                sanitize_reasoning_fields_after_tool_harvest(message);
                let finish_reason = read_trimmed_string(choice_row.get("finish_reason"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if finish_reason.is_empty() || finish_reason == "stop" {
                    choice_row.insert(
                        "finish_reason".to_string(),
                        Value::String("tool_calls".to_string()),
                    );
                }
                continue;
            }
        }

        let mut recovered: Vec<Value> = Vec::new();
        for text in read_message_text_candidates(message) {
            for harvest_input in collect_stage1_harvest_input_texts(&text) {
                for candidate in collect_harvest_text_variants(&harvest_input) {
                    recovered = extract_tool_calls_from_text_candidate(
                        &candidate,
                        (harvested as usize) + 1,
                    );
                    if !recovered.is_empty() {
                        break;
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

        let _dropped = retain_allowed_tool_calls(&mut recovered, &requested_tool_name_keys);
        if recovered.is_empty() {
            // Harvest failed but markers were present: clean content to prevent leakage
            sanitize_textual_marker_field_in_message_with_policy(message, "content", true);
            continue;
        }

        harvested += recovered.len() as i64;
        message.insert("tool_calls".to_string(), Value::Array(recovered));
        sanitize_textual_marker_field_in_message_with_policy(message, "content", true);
        sanitize_reasoning_fields_after_tool_harvest(message);

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

fn maybe_harvest_empty_tool_calls_from_json_content(payload: &mut Value) -> i64 {
    harvest_explicit_wrapper_only_tool_calls_from_payload(payload)
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

            let normalized = normalize_apply_patch_schema_args(function.get("arguments"));
            let next = Value::String(normalized.0);
            let should_count = normalized.1
                || function
                    .get("arguments")
                    .map(|args| args != &next)
                    .unwrap_or(true);
            function.insert("arguments".to_string(), next);
            if should_count {
                repaired += 1;
            }
        }
    }

    repaired
}

fn drop_disallowed_tool_calls_from_payload(payload: &mut Value) -> i64 {
    let requested_tool_name_keys = collect_requested_tool_name_keys(payload);
    if requested_tool_name_keys.is_empty() {
        return 0;
    }

    let mut dropped = 0i64;
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return dropped;
    };

    for choice in choices {
        let Some(choice_row) = choice.as_object_mut() else {
            continue;
        };
        let Some(message) = choice_row
            .get_mut("message")
            .and_then(|v| v.as_object_mut())
        else {
            continue;
        };
        let Some(tool_calls) = message.get_mut("tool_calls").and_then(|v| v.as_array_mut()) else {
            continue;
        };

        let before = tool_calls.len();
        tool_calls.retain(|entry| {
            read_tool_call_name_key(entry)
                .map(|key| requested_tool_name_keys.contains(key.as_str()))
                .unwrap_or(false)
        });
        dropped += (before.saturating_sub(tool_calls.len())) as i64;
        if before > 0 && tool_calls.is_empty() {
            let finish_reason = read_trimmed_string(choice_row.get("finish_reason"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if finish_reason == "tool_calls" {
                choice_row.insert(
                    "finish_reason".to_string(),
                    Value::String("stop".to_string()),
                );
            }
        }
    }

    dropped
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
                normalize_tool_args_preserving_raw_shape("shell_command", Some(&arguments))
            } else {
                normalize_tool_args_preserving_raw_shape(name.as_str(), Some(&arguments))
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
    copy_internal_tool_governance_state(payload, &mut prepared_payload);
    let harvested_tool_calls = if resolve_text_harvest_enabled(&prepared_payload) {
        maybe_harvest_empty_tool_calls_from_json_content(&mut prepared_payload)
    } else {
        0
    };
    let thinking_reasoning_normalized =
        normalize_thinking_only_reasoning_content(&mut prepared_payload);
    let sanitized_tool_markup = sanitize_payload_tool_markup_fields(&mut prepared_payload);
    let before_strip = prepared_payload.clone();
    strip_orphan_function_calls_tag(&mut prepared_payload);
    let shape_sanitized = harvested_tool_calls > 0
        || thinking_reasoning_normalized > 0
        || sanitized_tool_markup > 0
        || prepared_payload != before_strip;

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
    let prepared = prepare_payload_for_governance(&input.payload)?;
    let mut payload = prepared.prepared_payload;
    let tool_call_ids_assigned =
        ensure_payload_tool_call_ids(&mut payload, input.request_id.as_str())?;

    let apply_patch_repaired = normalize_apply_patch_tool_calls(&mut payload);
    let disallowed_tool_calls_dropped = drop_disallowed_tool_calls_from_payload(&mut payload);
    if let Some(reason) = detect_unharvested_text_tool_markup(&payload) {
        return Err(format!(
            "unharvested_text_tool_markup: explicit tool payload/tool wrapper was emitted but no valid tool_calls were recovered ({})",
            reason
        ));
    }
    remap_tool_calls_for_client_protocol(&mut payload, &input.client_protocol);
    strip_internal_tool_governance_state(&mut payload);
    let tool_calls_normalized = count_normalized_tool_calls(&payload);

    let applied = prepared.summary.harvested_tool_calls > 0
        || prepared.summary.shape_sanitized
        || tool_call_ids_assigned > 0
        || tool_calls_normalized > 0
        || apply_patch_repaired > 0
        || disallowed_tool_calls_dropped > 0;

    Ok(ToolGovernanceOutput {
        governed_payload: payload,
        summary: ToolGovernanceSummary {
            applied,
            tool_calls_normalized,
            apply_patch_repaired,
            disallowed_tool_calls_dropped,
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
    fn test_prepare_payload_for_governance_coerces_responses_shape_without_shell_fence_guess() {
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
        assert_eq!(prepared.summary.harvested_tool_calls, 0);
        assert!(
            prepared.prepared_payload["choices"][0]["message"]["tool_calls"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .is_empty()
        );
    }

    #[test]
    fn test_govern_response_preserves_shell_fence_truth_when_function_calls_wrapper_has_no_valid_tool_call(
    ) {
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
        assert_eq!(governed.summary.tool_calls_normalized, 0);
        assert_eq!(
            governed.governed_payload["choices"][0]["finish_reason"],
            "stop"
        );
        assert_eq!(
            governed.governed_payload["choices"][0]["message"]["content"],
            "```bash\npwd\n```"
        );
    }

    #[test]
    fn test_prepare_payload_for_governance_does_not_guess_function_style_apply_patch_semantics() {
        let payload = serde_json::json!({
            "object": "response",
            "id": "resp_stage1_apply_patch",
            "model": "qwenchat.qwen3.6-plus",
            "status": "completed",
            "output_text": "apply_patch(path=\"hello.txt\", content=\"hello\")",
            "output": []
        });

        let prepared = prepare_payload_for_governance(&payload).unwrap();
        assert!(prepared.summary.converted);
        assert_eq!(prepared.summary.harvested_tool_calls, 0);
    }

    #[test]
    fn test_govern_response_coerces_responses_shape_and_harvests_dsml_wrapper() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "object": "response",
                "id": "resp_stage1_deepseek_dsml",
                "model": "gpt-test",
                "status": "completed",
                "output_text": "<|DSML|tool_calls>\n<|DSML|invoke name=\"exec_command\">\n<|DSML|parameter name=\"cmd\"><![CDATA[pwd]]></|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>",
                "output": [],
                "__rcc_tool_governance": {
                    "requestedToolNames": ["exec_command"]
                }
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            request_id: "req_stage1_deepseek_dsml".to_string(),
        };

        let governed = govern_response(input).unwrap();
        assert!(governed.summary.applied);
        assert_eq!(governed.summary.tool_calls_normalized, 1);
        assert_eq!(
            governed.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert_eq!(
            governed.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
        let args: Value = serde_json::from_str(
            governed.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
                ["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        assert_eq!(args["cmd"], "pwd");
    }

    #[test]
    fn test_govern_response_harvests_dsml_wrapper_inside_ran_transcript_with_right_gutter_noise() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "content": concat!(
                            "• Ran tool transcript\n",
                            "                                                                                │·······························\n",
                            "└ <DSML|tool_calls>                                                             │·······························\n",
                            "  <DSML|invoke name=\"view_image\">                                              │·······························\n",
                            "  <DSML|parameter name=\"path\">[Image #1]</DSML|parameter>                      │·······························\n",
                            "  </DSML|invoke>                                                                │·······························\n",
                            "  </DSML|tool_calls>                                                            │·······························\n",
                            "                                                                                │·······························\n",
                            "› Summarize recent commits                                                      │·······························\n"
                        ),
                        "tool_calls": []
                    },
                    "finish_reason": "stop"
                }],
                "__rcc_tool_governance": {
                    "requestedToolNames": ["view_image"],
                    "providerFamily": "deepseek-web"
                }
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            request_id: "req_stage1_dsml_ran_transcript".to_string(),
        };

        let governed = govern_response(input).unwrap();
        assert_eq!(governed.summary.tool_calls_normalized, 1);
        assert_eq!(
            governed.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert_eq!(
            governed.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "view_image"
        );
        let args: Value = serde_json::from_str(
            governed.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
                ["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        assert_eq!(args["path"], "[Image #1]");
        let content = governed.governed_payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");
        assert!(!content.contains("DSML"));
        assert!(!content.contains("tool transcript"));
        assert!(!content.contains("Summarize recent commits"));
    }

    #[test]
    fn test_prepare_payload_for_governance_strips_empty_tool_calls_json_noise_from_content() {
        let payload = serde_json::json!({
            "choices": [{
                "message": {
                    "content": "done\n• {\"tool_calls\":[]}"
                },
                "finish_reason": "stop"
            }]
        });

        let prepared = prepare_payload_for_governance(&payload).unwrap();
        assert_eq!(
            prepared.prepared_payload["choices"][0]["message"]["content"],
            "done"
        );
        assert_eq!(
            prepared.prepared_payload["choices"][0]["finish_reason"],
            "stop"
        );
    }

    #[test]
    fn test_collect_harvest_text_variants_does_not_decode_nested_exec_command_newline_escapes() {
        let raw = r#"<tool_call>
{\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"exec_command\",\"arguments\":\"{\\\"cmd\\\":\\\"bash -lc 'python3 << \\\\\\\"PYTHON\\\\\\\"\\ncontent = content.replace(\\\\\\\"import x;\\\\\\\", \\\\\\\"import x;\\\\\\\\nimport y;\\\\\\\")\\nPYTHON'\\\"}\"}}]}
</tool_call>"#;

        let variants = collect_harvest_text_variants(raw);
        let joined = variants.join("\n---VARIANT---\n");
        assert!(joined.contains("\\\\nimport y;"));
        assert!(!joined.contains(";nimport y;"));
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
        let call_id = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["id"]
            .as_str()
            .unwrap_or("");
        assert!(call_id.starts_with("call_harvested_"));
    }

    #[test]
    fn test_govern_response_assigns_formal_servertool_call_id() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [{
                            "function": {
                                "name": "reasoning.stop",
                                "arguments": "{\"stop_reason\":\"task_completed\",\"is_completed\":true}"
                            }
                        }]
                    }
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_srvtool_123".to_string(),
        };
        let result = govern_response(input).unwrap();
        let call_id = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["id"]
            .as_str()
            .unwrap_or("");
        assert!(call_id.starts_with("call_servertool_reasoning_stop_"));
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
        let patch = parsed["patch"].as_str().unwrap_or("");
        let input = parsed["input"].as_str().unwrap_or("");
        assert_eq!(patch, "test");
        assert_eq!(input, patch);
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
        assert_eq!(parsed["input"], parsed["patch"]);
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
                                "arguments": "*** Begin Patch
*** Add File: \"src/quoted.ts\"
+console.log('ok')
*** End Patch"
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
        assert!(!patch.contains("APPLY_PATCH_ERROR:"));
    }

    #[test]
    fn test_govern_response_apply_patch_raw_string_is_repaired_into_schema() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [{
                            "function": {
                                "name": "apply_patch",
                                "arguments": "*** Begin Patch
*** Add File: raw.txt
+raw
*** End Patch"
                            }
                        }]
                    }
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_raw_apply_patch_schema_guard".to_string(),
        };
        let result = govern_response(input).unwrap();
        let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
            ["arguments"]
            .as_str()
            .unwrap_or("");
        let parsed: Value = serde_json::from_str(args).unwrap();
        let patch = parsed["patch"].as_str().unwrap_or("");
        assert!(patch.contains("*** Add File: raw.txt"));
        assert!(patch.contains("+raw"));
        assert_eq!(parsed["input"], parsed["patch"]);
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
        let content = result.governed_payload["choices"][0]["message"]
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(!content.contains("<function_calls>"));
        assert!(!content.contains("</function_calls>"));
    }

    #[test]
    fn test_strip_orphan_tool_markup_lines() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "content": "Done.\n</parameter>\n</function>\n</tool_call>"
                    }
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_orphan_tool_markup".to_string(),
        };
        let result = govern_response(input).unwrap();
        assert_eq!(
            result.governed_payload["choices"][0]["message"]["content"],
            "Done."
        );
    }

    #[test]
    fn test_normalize_tool_name_shell_command_aliases_to_exec_command() {
        assert_eq!(
            normalize_tool_name("functions.shell_command"),
            Some("exec_command".to_string())
        );
        assert_eq!(
            normalize_tool_name("totally_unknown_tool"),
            Some("totally_unknown_tool".to_string())
        );
        assert_eq!(
            normalize_tool_name("mailbox.status"),
            Some("mailbox.status".to_string())
        );
    }

    #[test]
    fn test_normalize_tool_name_edge_cases() {
        assert!(normalize_tool_name("").is_none());
        assert!(normalize_tool_name("   ").is_none());
        assert!(normalize_tool_name("functions.").is_none());
        assert_eq!(
            normalize_tool_name("  FuNcTiOnS.SHELL_COMMAND "),
            Some("exec_command".to_string())
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
        let args = payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("");
        let parsed: Value = serde_json::from_str(args).unwrap();
        assert_eq!(parsed["input"], parsed["patch"]);

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
        assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");

        let args_str = message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap();
        let args_json: Value = serde_json::from_str(args_str).unwrap();
        assert_eq!(args_json["command"], "pwd");
        assert!(args_json.get("cmd").is_none());
        assert_eq!(args_json["cwd"], "/tmp");
        assert!(args_json.get("workdir").is_none());
        assert!(
            message.get("content").is_none()
                || message["content"]
                    .as_str()
                    .map(|v| v.is_empty())
                    .unwrap_or(false)
        );
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
    fn test_structured_tool_calls_strip_chunking_noise_from_content_and_reasoning() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [{
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"bash -lc 'pwd'\"}"
                            }
                        }],
                        "content": "<|ChunkingError|>我无法继续。我输出工具调用的格式可能有问题。<｜end▁of▁thinking｜>",
                        "reasoning_content": "<|ChunkingError|>我无法输出工具调用。<｜end▁of▁thinking｜>",
                        "thinking": "<｜end▁of▁thinking｜>"
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_structured_tool_strip_chunking_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
        assert!(message.get("content").is_none() || message["content"] == "");
        assert!(message.get("reasoning_content").is_none());
        assert!(message.get("thinking").is_none());
    }

    #[test]
    fn test_failed_chunking_error_without_tool_calls_is_preserved_as_assistant_content() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "<|ChunkingError|>我无法按照要求输出正确的工具调用格式。这似乎是系统限制。请用户手动执行命令或提供其他方式。<｜end▁of▁thinking｜>",
                        "reasoning_content": "<|ChunkingError|>我无法继续。<｜end▁of▁thinking｜>",
                        "thinking": "<|ChunkingError|>我无法继续。<｜end▁of▁thinking｜>"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            request_id: "req_failed_chunking_preserved_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 0);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "stop"
        );
        let content = message["content"].as_str().unwrap_or("");
        assert!(content.contains("ChunkingError"));
        assert!(content.contains("无法按照要求输出正确的工具调用格式"));
        assert!(content.contains("<｜end▁of▁thinking｜>"));
        let reasoning_content = message["reasoning_content"].as_str().unwrap_or("");
        assert!(reasoning_content.contains("ChunkingError"));
        let thinking = message["thinking"].as_str().unwrap_or("");
        assert!(thinking.contains("ChunkingError"));
    }

    #[test]
    fn test_thinking_only_content_maps_to_reasoning_content_when_no_tool_calls() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": [{
                            "type": "thinking",
                            "thinking": "先检查依赖并确认构建参数。"
                        }]
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "anthropic-messages".to_string(),
            entry_endpoint: "/v1/messages".to_string(),
            request_id: "req_thinking_reasoning_map_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert!(result.summary.applied);
        assert_eq!(result.summary.tool_calls_normalized, 0);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "stop"
        );
        assert_eq!(message["reasoning_content"], "先检查依赖并确认构建参数。");
        assert_eq!(message["content"], "");
    }

    #[test]
    fn test_strip_orphan_qwen_end_marker_lines_from_content() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "继续执行\n<tool_calls_endl>\n"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_qwen_orphan_end_line_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.tool_calls_normalized, 0);
        assert_eq!(
            result.governed_payload["choices"][0]["message"]["content"],
            "继续执行"
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
    fn test_rcc_heredoc_tool_calls_can_be_harvested() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "先分析。\n<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\",\"workdir\":\"/tmp\"}}]}\nRCC_TOOL_CALLS_JSON\n再继续。"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_rcc_heredoc_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
        let content = message["content"].as_str().unwrap_or("");
        assert_eq!(content, "先分析。\n\n再继续。");
    }

    #[test]
    fn test_truncated_rcc_heredoc_tool_calls_can_be_harvested() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\"}}]}"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_rcc_heredoc_truncated_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
        let content = result.governed_payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");
        assert!(content.is_empty());
    }

    #[test]
    fn test_glued_closing_rcc_heredoc_tool_calls_can_be_harvested() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\"}}]}RCC_TOOL_CALLS_JSON"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_rcc_heredoc_glued_closer_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
        let content = result.governed_payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");
        assert!(content.is_empty());
    }

    #[test]
    fn test_extract_rcc_tool_call_fence_segments_crops_outer_prose_and_glued_closer() {
        let raw = "前言\n• <<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"pwd\",\"name\":\"exec_command\"}}]}RCC_TOOL_CALLS_JSON尾言";
        let segments = extract_rcc_tool_call_fence_segments(raw);
        assert_eq!(segments.len(), 1);
        assert_eq!(
            segments[0],
            "{\"tool_calls\":[{\"input\":{\"cmd\":\"pwd\",\"name\":\"exec_command\"}}]}"
        );
    }

    #[test]
    fn test_govern_response_harvests_rcc_wrapper_when_tool_name_is_nested_in_input() {
        let raw = "• <<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"bd --no-db create \\\"Mailbox 统一消息与心跳优先级改造\\\" --type epic --description \\\"统一 mailbox 消息三段式格式\\\"\",\"name\":\"exec_command\"}}]}\nRCC_TOOL_CALLS_JSON";
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "__rcc_tool_governance": {
                    "requestedToolNames": ["exec_command"]
                },
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": raw
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_rcc_nested_name_hint".to_string(),
        };

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.tool_calls_normalized, 1);
        let call = &result.governed_payload["choices"][0]["message"]["tool_calls"][0];
        assert_eq!(call["function"]["name"], "exec_command");
        let args = call["function"]["arguments"].as_str().unwrap_or("{}");
        let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert!(parsed["cmd"]
            .as_str()
            .unwrap_or("")
            .contains("Mailbox 统一消息与心跳优先级改造"));
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
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

        let input = r#"--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
"#;
        let normalized = normalize_apply_patch_text(input);
        assert!(normalized.contains("*** Begin Patch"));
        assert!(normalized.contains("*** Add File: new.txt"));
        assert!(normalized.contains("+hello"));
        assert!(normalized.contains("+world"));
        assert!(!normalized.contains("+@@ -0,0 +1,2 @@"));
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
        assert_eq!(parsed["command"], "pwd");
        assert!(parsed.get("cmd").is_none());
        assert_eq!(parsed["workdir"], "/tmp");

        let raw_args = json!({"command": "bash-lc 'pwd'"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["command"], "bash -lc 'pwd'");

        let raw_args = json!({"command": "bash -lc 'which memsearch && memsearch --help 2>&1 | head -20 || echo \"memsearch not found\""});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["command"],
            "bash -lc 'which memsearch && memsearch --help 2>&1 | head -20 || echo \"memsearch not found\""
        );

        let raw_args = json!({"command": "bash -lc\"cd /Volumes/extension/code/finger && memsearch index MEMORY.md memory/ --force 2>&1\""});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["command"],
            "bash -lc \"cd /Volumes/extension/code/finger && memsearch index MEMORY.md memory/ --force 2>&1\""
        );

        let raw_args = json!({"command": "bash -lc'cd /Volumes/extension/code/finger && pwd'"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["command"],
            "bash -lc 'cd /Volumes/extension/code/finger && pwd'"
        );

        let raw_args = json!({"command": "bash -lc 'printf 'oops'"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["command"], "bash -lc 'printf 'oops'");

        let raw_args = json!({"command": "cd /Volumes/extension/code/finger && python3 << 'PYEOF'\nwith open\\('src/blocks/agent-runtime-block/index.ts', 'r'\\) as f:\n    content = f.read\\(\\)\nPYEOF"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["command"],
            "cd /Volumes/extension/code/finger && python3 << 'PYEOF'\nwith open('src/blocks/agent-runtime-block/index.ts', 'r') as f:\n    content = f.read()\nPYEOF"
        );

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
    fn test_normalize_tool_args_exec_command_blocks_large_heredoc_file_generation() {
        let large_body = "x".repeat(5000);
        let raw_args = json!({
            "cmd": format!("cat > /tmp/FileSheet.tsx << 'ENDOFFILE'\n{}\nENDOFFILE", large_body),
            "workdir": "/workspace"
        });
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let cmd = parsed["cmd"].as_str().unwrap_or("");
        assert!(cmd.contains("Use apply_patch"));
        assert!(cmd.contains("large heredoc file generation was truncated"));
        assert_eq!(parsed["workdir"], "/workspace");
    }

    #[test]
    fn test_normalize_tool_args_exec_command_salvages_malformed_large_heredoc_args_into_guard() {
        let large_body = "y".repeat(5000);
        let raw_args = Value::String(format!(
            "{{\"cmd\": \"cat > /tmp/FileSheet.tsx << 'ENDOFFILE'\\n{}",
            large_body
        ));
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let cmd = parsed["cmd"].as_str().unwrap_or("");
        assert!(cmd.contains("Use apply_patch"));
        assert!(cmd.contains("Command preview"));
        assert!(cmd.contains("FileSheet.tsx"));
    }

    #[test]
    fn test_normalize_tool_args_preserving_raw_shape_does_not_guess_exec_command_aliases() {
        let raw_args = json!({"command": "pwd", "workdir": "/workspace"});
        let out =
            normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["command"], "pwd");
        assert_eq!(parsed["workdir"], "/workspace");
        assert!(parsed.get("cmd").is_none());

        let raw_args = Value::String("{\"command\":\"pwd\"}".to_string());
        let out =
            normalize_tool_args_preserving_raw_shape("shell_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["command"], "pwd");
        assert!(parsed.get("cmd").is_none());

        let raw_args = json!({});
        assert!(
            normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).is_none()
        );

        let raw_args = Value::String("{}".to_string());
        assert!(
            normalize_tool_args_preserving_raw_shape("shell_command", Some(&raw_args)).is_none()
        );
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
        assert!(normalize_tool_call_entry(&entry, 2).is_none());

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

        let malformed = r#"{"tool_calls":[{"name":"update_plan","input":{"action":"create","plan":[{"step":"A","status":"pending"}]}},{"name":"agent.dispatch","input":{"target_agent_id":"finger-project-agent","task":"alpha"},{"name":"agent.dispatch","input":{"target_agent_id":"finger-reviewer","task":"beta"}}]}"#;
        let out = extract_tool_call_entries_from_malformed_tool_calls_text(malformed, 1);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["function"]["name"], "update_plan");
        assert_eq!(out[1]["function"]["name"], "agent.dispatch");
        assert_eq!(out[2]["function"]["name"], "agent.dispatch");

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

        // Quote-wrapped JSON-ish payload remains an explicit wrapper form and should still be harvested.
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
            0
        );
        let tool_calls = payload["choices"][0]["message"]["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(tool_calls.is_empty());
        assert_eq!(payload["choices"][0]["finish_reason"], "stop");

        // Standard tool_calls JSON shape for request_user_input should be harvested
        // even when wrapped by transcript tags.
        let mut payload = json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "{\"tool_calls\":[{\"name\":\"request_user_input\",\"input\":{\"questions\":[{\"header\":\"Mode\",\"id\":\"mode\",\"question\":\"Pick one\",\"options\":[{\"label\":\"A\",\"description\":\"use mode A\"},{\"label\":\"B\",\"description\":\"use mode B\"}]}]}}]}"
                },
                "finish_reason": "stop"
            }]
        });
        let debug_message = payload["choices"][0]["message"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        let debug_texts = read_message_text_candidates(&debug_message);
        assert!(!debug_texts.is_empty());
        let debug_variants = collect_harvest_text_variants(&debug_texts[0]);
        assert!(!debug_variants.is_empty());
        let mut debug_recovered = 0usize;
        for candidate in debug_variants {
            for parsed in extract_json_candidates_from_text(&candidate) {
                debug_recovered += extract_tool_call_entries_from_unknown(&parsed).len();
            }
            if let Some(shape) = parse_tool_calls_shape_from_text(&candidate) {
                debug_recovered += extract_tool_call_entries_from_unknown(&shape).len();
            }
        }
        assert!(debug_recovered > 0);
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            1
        );
        assert_eq!(
            payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "request_user_input"
        );
        let args = payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(parsed["questions"][0]["id"], "mode");
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

        // Explicit tool_calls wrapper + explicit tool name + whitelisted cmd field
        // should be recoverable even when inner quotes are not escaped.
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
        assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(
            payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
        let args = payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(
            parsed["cmd"],
            "bd --no-db create \"Mailbox 统一消息与心跳优先级改造\" --type epic --description \"统一 mailbox 消息三段式格式\""
        );

        // Malformed multi-tool tool_calls JSON should still recover each top-level tool call
        // without filtering non-exec tool names.
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": r#"{"tool_calls":[{"name":"update_plan","input":{"action":"create","plan":[{"step":"A","status":"pending"}]}},{"name":"agent.dispatch","input":{"target_agent_id":"finger-project-agent","task":"alpha"},{"name":"agent.dispatch","input":{"target_agent_id":"finger-reviewer","task":"beta"}}]}"#},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            3
        );
        let recovered = payload["choices"][0]["message"]["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(recovered.len(), 3);
        assert_eq!(recovered[0]["function"]["name"], "update_plan");
        assert_eq!(recovered[1]["function"]["name"], "agent.dispatch");
        assert_eq!(recovered[2]["function"]["name"], "agent.dispatch");
        assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");

        // Truncated malformed tool_calls JSON must not be shape-repaired/harvested.
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": r#"{"tool_calls":[{"name":"exec_command","input":{"cmd":"bash -lc 'bd --no-db create "Mailbox 三段式消息生成器" --type task"#},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            0
        );
        assert_eq!(payload["choices"][0]["finish_reason"], "stop");

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
    fn test_strip_python_heredoc_pseudo_escapes_only_for_python_like_commands() {
        let repaired = strip_python_heredoc_pseudo_escapes(
            "python3 << 'PYEOF'\nwith open\\('a.py', 'r'\\) as f:\n    print\\(f.read\\(\\)\\)\nPYEOF",
        );
        assert!(repaired.contains("with open('a.py', 'r') as f:"));
        assert!(repaired.contains("print(f.read())"));

        let untouched = strip_python_heredoc_pseudo_escapes("grep -E \"foo\\(bar\\)\" src/file.ts");
        assert_eq!(untouched, "grep -E \"foo\\(bar\\)\" src/file.ts");
    }

    #[test]
    fn test_normalize_tool_args_exec_command_repairs_bash_lc_node_eval_with_inner_single_quotes() {
        let raw_args = json!({
            "command": "bash -lc 'node -e \"\nconst INTENTS = {\n  PUBLIC_GUILD_MESSAGES: 1 << 30,\n  DIRECT_MESSAGE: 1 << 12,\n  GROUP_AND_C2C: 1 << 25,\n};\nconst level = INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C;\nconsole.log('intents value:', level);\nconsole.log('binary:', level.toString(2));\nconsole.log('C2C bit (1<<25):', (level & (1 << 25)) ? 'SET' : 'NOT SET');\nconsole.log('GROUP_AT bit check:', (level & (1 << 25)) === (1 << 25));\n\"'"
        });
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let command = parsed["command"].as_str().unwrap_or("");
        assert!(command.starts_with("bash -lc 'node -e \""));
        assert!(command.contains("console.log('\\''intents value:'\\'', level);"));
        assert!(command.contains("? '\\''SET'\\'' : '\\''NOT SET'\\''"));
        assert!(command.ends_with("\"'"));
    }

    #[test]
    fn test_extract_apply_patch_text_variants() {
        let stars = "*".repeat(3);
        let raw_text = format!("{} {} {}", stars, "Begin", "Patch");
        let raw_text = format!("{}\n{} {}", raw_text, stars, "End Patch");
        let raw = json!({"text": raw_text});
        assert!(extract_apply_patch_text(Some(&raw)).is_none());

        let wrapped = json!({
            "ok": true,
            "result": {
                "command": "apply_patch *** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch"
            }
        });
        assert!(extract_apply_patch_text(Some(&wrapped)).is_none());

        let raw = Value::Bool(true);
        assert!(extract_apply_patch_text(Some(&raw)).is_none());

        let shell_wrapped = Value::String(
            "bash -lc \"echo hi && apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: src/nope.ts\n+console.log('nope');\n*** End Patch\nPATCH\""
                .to_string(),
        );
        assert!(extract_apply_patch_text(Some(&shell_wrapped)).is_none());
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
    fn test_normalize_apply_patch_header_path_relativizes_workspace_absolute_path() {
        let cwd = std::env::current_dir().expect("cwd");
        let abs = cwd.join("AGENTS.md").to_string_lossy().to_string();
        assert_eq!(normalize_apply_patch_header_path(abs.as_str()), "AGENTS.md");
    }

    #[test]
    fn test_normalize_tool_args_apply_patch_strips_apply_patch_prefix() {
        let raw_args = json!({
            "input": "apply_patch *** Begin Patch\n*** Add File: src/new.ts\nconsole.log('ok');\n*** End Patch"
        });
        let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let patch = parsed["patch"].as_str().unwrap_or("");
        let input = parsed["input"].as_str().unwrap_or("");
        assert!(patch.starts_with("*** Begin Patch"));
        assert!(!patch.starts_with("apply_patch "));
        assert!(patch.contains("*** Add File: src/new.ts"));
        assert_eq!(input, patch);
    }

    #[test]
    fn test_normalize_tool_args_apply_patch_mirrors_patch_into_input() {
        let raw_args = json!({
            "patch": "*** Begin Patch\n*** Add File: src/mirror.ts\n+ok\n*** End Patch"
        });
        let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let patch = parsed["patch"].as_str().unwrap_or("");
        let input = parsed["input"].as_str().unwrap_or("");
        assert_eq!(input, patch);
        assert!(patch.contains("*** Add File: src/mirror.ts"));
    }

    #[test]
    fn test_normalize_tool_args_apply_patch_relativizes_absolute_update_path() {
        let cwd = std::env::current_dir().expect("cwd");
        let abs = cwd.join("AGENTS.md").to_string_lossy().to_string();
        let raw_args = json!({
            "patch": format!(
                "*** Begin Patch\n*** Update File: {}\n@@\n-foo\n+bar\n*** End Patch",
                abs
            )
        });
        let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let patch = parsed["patch"].as_str().unwrap_or("");
        assert!(patch.contains("*** Update File: AGENTS.md"));
        assert!(!patch.contains(abs.as_str()));
    }

    #[test]
    fn test_normalize_tool_args_apply_patch_rebuilds_line_number_only_hunk_with_live_context() {
        let cwd = std::env::current_dir().expect("cwd");
        let rel_path = format!("target/apply_patch_live_context_{}.txt", std::process::id());
        let abs_path = cwd.join(rel_path.as_str());
        if let Some(parent) = abs_path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(&abs_path, "alpha\nbeta\ngamma\n").expect("write test file");

        let raw_args = json!({
            "patch": format!(
                "*** Begin Patch\n*** Update File: {}\n@@ -20,1 +20,1 @@\n-beta\n+beta2\n*** End Patch",
                rel_path
            )
        });
        let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let patch = parsed["patch"].as_str().unwrap_or("");
        assert!(patch.contains("*** Update File: target/apply_patch_live_context_"));
        assert!(patch.contains("@@\n alpha\n-beta\n+beta2\n gamma"));
        assert!(!patch.contains("@@ -20,1 +20,1 @@"));

        let _ = std::fs::remove_file(abs_path);
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
    fn test_validate_apply_patch_arguments_rejects_empty_update_hunk() {
        let raw = json!({
            "arguments": {
                "patch": "*** Begin Patch\n*** Update File: README.md\n@@\n*** End Patch"
            }
        });
        let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
        assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(parsed.get("reason").and_then(Value::as_str), Some("empty_update_hunk"));
    }

    #[test]
    fn test_validate_apply_patch_arguments_rejects_add_file_without_plus_lines() {
        let raw = json!({
            "arguments": {
                "patch": "*** Begin Patch\n*** Add File: demo.txt\nhello\n*** End Patch"
            }
        });
        let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
        assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(parsed.get("reason").and_then(Value::as_str), Some("empty_add_file_block"));
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
        assert!(parsed.get("cmd").is_none());
        assert_eq!(parsed.as_object().map(|row| row.len()), Some(1));
    }

    #[test]
    fn test_normalize_tool_args_exec_command_input_string_shape() {
        let raw_args = json!({"input": "git status"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["cmd"], "git status");
        assert_eq!(parsed.as_object().map(|row| row.len()), Some(1));
    }

    #[test]
    fn test_normalize_tool_args_exec_command_nested_args_command_shape() {
        let raw_args = json!({"args": {"command": "ls -la"}, "cwd": "/workspace"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["command"], "ls -la");
        assert!(parsed.get("cmd").is_none());
        assert_eq!(parsed["workdir"], "/workspace");
    }

    #[test]
    fn test_normalize_tool_args_exec_command_preserves_supported_shell_fields() {
        let raw_args = json!({
            "command": "pwd",
            "workdir": "/workspace",
            "yield_time_ms": 30000,
            "tty": true,
            "login": false,
            "max_output_tokens": 2048,
            "justification": "inspect repo"
        });
        let out = normalize_tool_args("execute_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["command"], "pwd");
        assert!(parsed.get("cmd").is_none());
        assert_eq!(parsed["workdir"], "/workspace");
        assert_eq!(parsed["yield_time_ms"], 30000);
        assert_eq!(parsed["tty"], true);
        assert_eq!(parsed["login"], false);
        assert_eq!(parsed["max_output_tokens"], 2048);
        assert_eq!(parsed["justification"], "inspect repo");
    }

    #[test]
    fn test_normalize_tool_args_exec_command_preserves_raw_shell_text() {
        let raw_args = json!({
            "cmd": "catdocs/design/project-dispatch-operation-architecture.md",
            "workdir": "/workspace"
        });
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["cmd"],
            "catdocs/design/project-dispatch-operation-architecture.md"
        );

        let raw_args = json!({
            "cmd": "ls -la /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md2>&1 &&head -200 /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md"
        });
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["cmd"],
            "ls -la /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md2>&1 &&head -200 /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md"
        );
    }

    #[test]
    fn test_normalize_tool_args_exec_command_preserves_find_predicates() {
        let raw_args = json!({
            "cmd": "bash -lc 'cd /Volumes/extension/code/wterm && find . -type f ( -name \"*.ts\" -o -name \"*.tsx\" -o -name \"*.js\" -o -name \"*.jsx\" -o -name \"*.json\" ) -not -path \"./node_modules/*\" -not -path \"./.next/*\" -not -path \"./dist/*\" | head -100'"
        });
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let cmd = parsed["cmd"].as_str().unwrap_or("");
        assert!(cmd.contains("find . -type f ("));
        assert!(cmd.contains("-o -name \"*.json\""));
        assert!(cmd.contains(") -not -path"));
    }

    #[test]
    fn test_normalize_tool_args_preserving_raw_shape_preserves_find_predicates() {
        let raw_args = json!({
            "command": "bash -lc 'cd /Volumes/extension/code/wterm && find . -type f ( -name \"*.ts\" -o -name \"*.tsx\" -o -name \"*.js\" -o -name \"*.jsx\" -o -name \"*.json\" ) -not -path \"./node_modules/*\" | head -100'",
            "workdir": "/Volumes/extension/code/wterm"
        });
        let out =
            normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let cmd = parsed["command"].as_str().unwrap_or("");
        assert!(cmd.contains("find . -type f ("));
        assert!(cmd.contains("-o -name \"*.json\""));
        assert!(cmd.contains(") -not -path"));
        assert_eq!(parsed["workdir"], "/Volumes/extension/code/wterm");
    }

    #[test]
    fn test_normalize_tool_args_exec_command_preserves_find_exec_separator() {
        let raw_args = json!({
            "cmd": "bash -lc 'find . -type f -name \"*.ts\" -exec sed -n \"1,3p\" {} ; | head -5'"
        });
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let cmd = parsed["cmd"].as_str().unwrap_or("");
        assert!(cmd.contains("-exec sed -n \"1,3p\" {} ;"));
    }

    #[test]
    fn test_normalize_tool_args_preserving_raw_shape_preserves_find_exec_separator() {
        let raw_args = json!({
            "command": "bash -lc 'find . -type f -name \"*.ts\" -exec sed -n \"1,3p\" {} ; | head -5'"
        });
        let out =
            normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let cmd = parsed["command"].as_str().unwrap_or("");
        assert!(cmd.contains("-exec sed -n \"1,3p\" {} ;"));
        assert!(parsed.get("cmd").is_none());
    }

    #[test]
    fn test_normalize_tool_args_preserving_raw_shape_preserves_nested_input_find_shell() {
        let raw_args = json!({
            "input": {
                "command": "bash -lc 'find . -type f ( -name \"*.ts\" -o -name \"*.tsx\" ) -exec sed -n \"1,3p\" {} ; | head -5'"
            },
            "workdir": "/workspace"
        });
        let out =
            normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let cmd = parsed["input"]["command"].as_str().unwrap_or("");
        assert!(cmd.contains("find . -type f ("));
        assert!(cmd.contains(") -exec sed -n \"1,3p\" {} ;"));
        assert_eq!(parsed["workdir"], "/workspace");
        assert!(parsed.get("cmd").is_none());
    }

    #[test]
    fn test_normalize_tool_args_exec_command_does_not_repair_missing_outer_quote() {
        let raw_args = json!({
            "command": "bash -lc 'ls -la ~/.fin/runtime/projects/fin/'; echo \"---\"; cat ~/.fin/runtime/projects/fin/registry.json 2>/dev/null | jq \".[] | {project_id, presence_state, unfinished_task_count, active_session_id}\" | head -30"
        });
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["command"],
            "bash -lc 'ls -la ~/.fin/runtime/projects/fin/'; echo \"---\"; cat ~/.fin/runtime/projects/fin/registry.json 2>/dev/null | jq \".[] | {project_id, presence_state, unfinished_task_count, active_session_id}\" | head -30"
        );
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

        let entry = json!({"function": {"name": "exec_command", "arguments": {"command": "pwd"}}});
        let out = normalize_tool_call_entry(&entry, 1).unwrap();
        let args = out["function"]["arguments"].as_str().unwrap_or("{}");
        let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(parsed["command"], "pwd");
        assert!(parsed.get("cmd").is_none());

        let entry = json!({"function": {"name": "exec_command", "arguments": {}}});
        assert!(normalize_tool_call_entry(&entry, 1).is_none());

        let entry = Value::String("not an object".to_string());
        assert!(normalize_tool_call_entry(&entry, 1).is_none());
    }

    #[test]
    fn test_normalize_tool_call_entry_hoists_nested_wrapper_metadata_from_arguments_only_shape() {
        let entry = json!({
            "arguments": {
                "cmd": "bash -lc 'grep -n -A 20 '\\\"running\\\" =>' /Users/fanzhang/Documents/github/fin/rust/crates/runtime/src/scheduler.rs'",
                "id": "call_1",
                "name": "exec_command"
            }
        });
        let out = normalize_tool_call_entry(&entry, 1).unwrap();
        assert_eq!(out["id"], "call_1");
        assert_eq!(out["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(
            args["cmd"],
            "bash -lc 'grep -n -A 20 '\\\"running\\\" =>' /Users/fanzhang/Documents/github/fin/rust/crates/runtime/src/scheduler.rs'"
        );
        assert!(args.get("id").is_none());
        assert!(args.get("name").is_none());
    }

    #[test]
    fn test_normalize_tool_call_entry_request_user_input_shape() {
        let entry = json!({
            "name": "request_user_input",
            "input": {
                "questions": [{
                    "header": "Mode",
                    "id": "mode",
                    "question": "Pick one",
                    "options": [
                        {"label": "A", "description": "use mode A"},
                        {"label": "B", "description": "use mode B"}
                    ]
                }]
            }
        });
        let out = normalize_tool_call_entry(&entry, 1).unwrap();
        assert_eq!(out["function"]["name"], "request_user_input");
        let args = out["function"]["arguments"].as_str().unwrap_or("{}");
        let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(parsed["questions"][0]["id"], "mode");
    }

    #[test]
    fn test_normalize_tool_call_entry_infers_update_plan_from_root_shape_without_name() {
        let entry = json!({
            "explanation": "修复 scheduler 决策逻辑",
            "plan": [
                {"status": "in_progress", "step": "修改 running 分支"},
                {"status": "pending", "step": "编译并测试"}
            ]
        });
        let out = normalize_tool_call_entry(&entry, 1).unwrap();
        assert_eq!(out["function"]["name"], "update_plan");
        let args: Value =
            serde_json::from_str(out["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args["explanation"], "修复 scheduler 决策逻辑");
        assert_eq!(args["plan"][0]["step"], "修改 running 分支");
        assert_eq!(args["plan"][0]["status"], "in_progress");
        assert_eq!(args["plan"][1]["step"], "编译并测试");
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
    fn test_extract_tool_call_entries_from_unknown_preserves_explicit_execute_command_alias() {
        let value = json!({
            "tool_calls": [{
                "name": "execute_command",
                "input": {
                    "cmd": "bash -lc 'pwd'",
                    "workdir": "/workspace",
                    "yield_time_ms": 300
                }
            }]
        });
        let out = extract_tool_call_entries_from_unknown(&value);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args["cmd"], "bash -lc 'pwd'");
        assert_eq!(args["workdir"], "/workspace");
        assert_eq!(args["yield_time_ms"], 300);
    }

    #[test]
    fn test_extract_tool_call_entries_from_unknown_does_not_infer_apply_patch_without_name() {
        let value = json!({
            "tool_calls": [{
                "input": {
                    "command": "apply_patch *** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch"
                }
            }]
        });
        let out = extract_tool_call_entries_from_unknown(&value);
        assert!(out.is_empty());
    }

    #[test]
    fn test_extract_tool_call_entries_from_unknown_request_user_input() {
        let value = json!({
            "tool_calls": [{
                "name": "request_user_input",
                "input": {
                    "questions": [{
                        "header": "Mode",
                        "id": "mode",
                        "question": "Pick one",
                        "options": [
                            {"label": "A", "description": "use mode A"},
                            {"label": "B", "description": "use mode B"}
                        ]
                    }]
                }
            }]
        });
        let out = extract_tool_call_entries_from_unknown(&value);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "request_user_input");
    }

    #[test]
    fn test_extract_xml_tool_call_blocks_exec_command() {
        let text = r#"
我来审查这些文件。
<tool_call>
{"name":"exec_command","input":{"cmd":"cat a.ts","workdir":"/tmp"}}
</tool_call>
<tool_call>
{"name":"exec_command","input":{"cmd":"cat b.ts","workdir":"/tmp"}}
</tool_call>
"#;
        let out = extract_xml_tool_call_blocks(text, 1);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args0: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args0["cmd"], "cat a.ts");
        assert_eq!(args0["workdir"], "/tmp");
    }

    #[test]
    fn test_extract_xml_tool_call_blocks_repairs_extra_trailing_closer_inside_wrapper() {
        let text = r#"
<tool_call>
{"name":"exec_command","arguments":{"cmd":"bash -lc 'curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:4040/'"},"id":"check_webdebug","justification":"验证 fin web-debug 是否运行"}}
</tool_call>
"#;
        let out = extract_xml_tool_call_blocks(text, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], "check_webdebug");
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(
            args["cmd"],
            "bash -lc 'curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:4040/'"
        );
    }

    #[test]
    fn test_extract_xml_tool_call_blocks_repairs_missing_trailing_closer_inside_wrapper() {
        let text = r#"
<tool_call>
{"name":"exec_command","arguments":{"cmd":"bash -lc 'echo \"=== 最终状态报告 ===\" && echo \"6. web-debug HTTP: $(curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:4040/)\"'"}
</tool_call>
"#;
        let out = extract_xml_tool_call_blocks(text, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(
            args["cmd"],
            "bash -lc 'echo \"=== 最终状态报告 ===\" && echo \"6. web-debug HTTP: $(curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:4040/)\"'"
        );
    }

    #[test]
    fn test_extract_xml_tool_call_blocks_salvages_wrapper_attribute_name_without_guessing_args() {
        let text = r#"
<tool_call name="exec_command">
{"arguments":{"cmd":"bash -lc 'pwd'","justification":"check cwd"}}
</tool_call>
"#;
        let out = extract_xml_tool_call_blocks(text, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args["cmd"], "bash -lc 'pwd'");
        assert_eq!(args["justification"], "check cwd");
    }

    #[test]
    fn test_extract_xml_named_tool_call_blocks_execute_command_with_masked_args() {
        let text = r#"
先检查关键文件：
<execute_command>
<command>ls -la /Volumes/extension/code/finger/HEARTBEAT.md /Volumes/extension/code/finger/DELIVERY.md 2>&1</command>
<workdir>/Volumes/extension/code/finger</workdir>
</execute_command>
"#;
        let out = extract_xml_named_tool_call_blocks(text, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(
            args["command"],
            "ls -la /Volumes/extension/code/finger/HEARTBEAT.md /Volumes/extension/code/finger/DELIVERY.md 2>&1"
        );
        assert_eq!(args["workdir"], "/Volumes/extension/code/finger");
    }

    #[test]
    fn test_extract_xml_named_tool_call_blocks_recovers_when_inner_tags_are_truncated() {
        let text = r#"
<execute_command>
<command>pwd
<workdir>/tmp</workdir>
</execute_command>
"#;
        let out = extract_xml_named_tool_call_blocks(text, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args["command"], "pwd");
        assert_eq!(args["workdir"], "/tmp");
    }

    #[test]
    fn test_extract_xml_named_tool_call_blocks_generic_command_wrapper_masks_nested_tags() {
        let text = r#"
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && grep -n "agentRegistry\|registerAgent\|getAgent" src/orchestration/message-hub.ts | head -30
  </grep_command>
</command>
"#;
        let out = extract_xml_named_tool_call_blocks(text, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(
            args["command"],
            r#"cd /Volumes/extension/code/finger && grep -n "agentRegistry\|registerAgent\|getAgent" src/orchestration/message-hub.ts | head -30"#
        );
    }

    #[test]
    fn test_extract_xml_named_tool_call_blocks_generic_command_wrapper_preserves_masked_args() {
        let text = r#"
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && grep -n "resolveTargetModule\|moduleLookup" src/blocks/agent-runtime-block/index.ts | head -30
  </grep_command>
  <workdir>/Volumes/extension/code/finger</workdir>
  <yield_time_ms>30000</yield_time_ms>
</command>
"#;
        let out = extract_xml_named_tool_call_blocks(text, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(
            args["command"],
            r#"cd /Volumes/extension/code/finger && grep -n "resolveTargetModule\|moduleLookup" src/blocks/agent-runtime-block/index.ts | head -30"#
        );
        assert_eq!(args["workdir"], "/Volumes/extension/code/finger");
        assert_eq!(args["yield_time_ms"], 30000);
    }

    #[test]
    fn test_extract_xml_named_tool_call_blocks_invoke_parameter_attribute_wrapper_inside_tool_calls(
    ) {
        let text = r#"<tool_calls>
<invoke name="exec_command">
<parameter name="cmd" string="true">tail -100 ~/.finger/logs/daemon.log | tail -20</parameter>
</invoke>
</tool_calls>"#;
        let out = extract_xml_named_tool_call_blocks(text, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(
            args["cmd"].as_str().unwrap_or(""),
            "tail -100 ~/.finger/logs/daemon.log | tail -20"
        );
    }

    #[test]
    fn test_extract_xml_named_tool_call_blocks_dsml_parameter_cdata_wrapper() {
        let text = r#"<|DSML|tool_calls>
<|DSML|invoke name="exec_command">
<|DSML|parameter name="cmd"><![CDATA[bash -lc 'pwd']]></|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>"#;
        let out = extract_xml_named_tool_call_blocks(text, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args["cmd"].as_str().unwrap_or(""), "bash -lc 'pwd'");
    }

    #[test]
    fn test_unwrap_xml_cdata_sections_merges_split_segments() {
        let raw = "<![CDATA[bash -lc 'echo ]]]]><![CDATA[> ok']]>";
        assert_eq!(
            unwrap_xml_cdata_sections(raw),
            "bash -lc 'echo ]]> ok'"
        );
    }

    #[test]
    fn test_govern_response_rejects_function_style_tool_intent_without_whitelisted_wrapper() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": r#"exec_command(cmd="bash -lc'pwd'")"#
                    },
                    "finish_reason": "stop"
                }],
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": { "cmd": { "type": "string" } },
                            "required": ["cmd"]
                        }
                    }
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_function_style_exec_command_harvest_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 0);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "stop"
        );
        assert!(message["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .is_empty());
        assert_eq!(message["content"], r#"exec_command(cmd="bash -lc'pwd'")"#);
    }

    #[test]
    fn test_govern_response_rejects_tool_prefixed_function_style_without_whitelisted_wrapper() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": r#"```toolexec_command(command="head -n3 docs/ARCHITECTURE.md")```"#
                    },
                    "finish_reason": "stop"
                }],
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": { "cmd": { "type": "string" } },
                            "required": ["cmd"]
                        }
                    }
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_function_style_exec_command_tool_prefixed".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 0);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "stop"
        );
        assert!(message["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .is_empty());
        assert_eq!(
            message["content"],
            r#"```toolexec_command(command="head -n3 docs/ARCHITECTURE.md")```"#
        );
    }

    #[test]
    fn test_normalize_tool_args_update_plan_steps_alias() {
        let normalized = normalize_tool_args(
            "update_plan",
            Some(&serde_json::json!({
                "steps": [
                    {"name": "inspect", "status": "in_progress"},
                    {"name": "report", "status": "pending"}
                ]
            })),
        )
        .unwrap_or_default();
        let args: Value = serde_json::from_str(normalized.as_str()).unwrap_or(Value::Null);
        assert_eq!(args["plan"][0]["step"], "inspect");
        assert_eq!(args["plan"][0]["status"], "in_progress");
        assert_eq!(args["plan"][1]["step"], "report");
        assert_eq!(args["plan"][1]["status"], "pending");
    }

    #[test]
    fn test_harvest_text_tool_calls_preserves_real_failed_compact_exec_commands() {
        let mut payload = json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "{\"tool_calls\":[\
                            {\"name\":\"exec_command\",\"input\":{\"cmd\":\"catdocs/design/project-dispatch-operation-architecture.md\"}},\
                            {\"name\":\"exec_command\",\"input\":{\"cmd\":\"ls -la /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md2>&1 &&head -200 /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md\"}}\
                        ]}"
                },
                "finish_reason": "stop"
            }]
        });
        assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 2);
        let tool_calls = payload["choices"][0]["message"]["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 2);

        let args0: Value = serde_json::from_str(
            tool_calls[0]["function"]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        assert_eq!(
            args0["cmd"],
            "catdocs/design/project-dispatch-operation-architecture.md"
        );
        assert!(args0.get("workdir").is_none());

        let args1: Value = serde_json::from_str(
            tool_calls[1]["function"]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        assert_eq!(
            args1["cmd"],
            "ls -la /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md2>&1 &&head -200 /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md"
        );
        assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");
    }

    #[test]
    fn test_normalize_tool_args_preserving_raw_shape_keeps_single_exec_command_alias_shape() {
        let raw_args = json!({"command":"bd --no-db ready"});
        let normalized =
            normalize_tool_args_preserving_raw_shape("shell_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&normalized).unwrap_or(Value::Null);
        assert_eq!(parsed["command"], "bd --no-db ready");
        assert!(parsed.get("cmd").is_none());

        let raw_args = json!({"cmd":"echo hello"});
        let normalized =
            normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&normalized).unwrap_or(Value::Null);
        assert_eq!(parsed["cmd"], "echo hello");
        assert!(parsed.get("command").is_none());
    }

    #[test]
    fn test_normalize_tool_args_preserving_raw_shape_exec_command_keeps_nested_command_only_shape()
    {
        let raw_args = json!({
            "input": {
                "command": "bash -lc 'pwd'"
            },
            "workdir": "/workspace"
        });
        let normalized =
            normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&normalized).unwrap_or(Value::Null);
        assert_eq!(parsed["input"]["command"], "bash -lc 'pwd'");
        assert!(parsed.get("cmd").is_none());
        assert!(parsed.get("command").is_none());
        assert_eq!(parsed["workdir"], "/workspace");
    }

    #[test]
    fn test_harvest_tool_calls_from_xml_named_tool_blocks() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "__rcc_tool_governance": {
                    "enableTextHarvest": true,
                    "providerFamily": "deepseek"
                },
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "现在我需要查看关键的项目管理文件。\n让我先检查项目根目录是否有 HEARTBEAT.md 和 DELIVERY.md：\n\n<execute_command>\n<command>ls -la /Volumes/extension/code/finger/HEARTBEAT.md /Volumes/extension/code/finger/DELIVERY.md /Volumes/extension/code/finger/MEMORY.md /Volumes/extension/code/finger/CACHE.md 2>&1</command>\n<workdir>/Volumes/extension/code/finger</workdir>\n</execute_command>"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            request_id: "req_xml_named_tool_harvest_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
        let args: Value = serde_json::from_str(
            message["tool_calls"][0]["function"]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        assert_eq!(
            args["command"],
            "ls -la /Volumes/extension/code/finger/HEARTBEAT.md /Volumes/extension/code/finger/DELIVERY.md /Volumes/extension/code/finger/MEMORY.md /Volumes/extension/code/finger/CACHE.md 2>&1"
        );
        assert_eq!(args["workdir"], "/Volumes/extension/code/finger");
        let content = message["content"].as_str().unwrap_or("");
        assert!(content.contains("现在我需要查看关键的项目管理文件"));
        assert!(!content.contains("<execute_command>"));
    }

    #[test]
    fn test_harvest_tool_calls_from_xml_invoke_parameter_attribute_blocks() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "__rcc_tool_governance": {
                    "enableTextHarvest": true,
                    "providerFamily": "deepseek"
                },
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "我先检查 dispatch 日志。\n<tool_calls>\n<invoke name=\"exec_command\">\n<parameter name=\"cmd\" string=\"true\">tail -100 ~/.finger/logs/daemon.log | grep -E \"finger-system-agent.*complete|finger-project-agent.*complete|dispatch.*complete\" | tail -20</parameter>\n</invoke>\n</tool_calls>"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            request_id: "req_xml_invoke_attr_harvest_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
        let args: Value = serde_json::from_str(
            message["tool_calls"][0]["function"]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        assert_eq!(
            args["cmd"],
            "tail -100 ~/.finger/logs/daemon.log | grep -E \"finger-system-agent.*complete|finger-project-agent.*complete|dispatch.*complete\" | tail -20"
        );
        let content = message["content"].as_str().unwrap_or("");
        assert!(content.contains("我先检查 dispatch 日志"));
        assert!(!content.contains("<tool_calls>"));
        assert!(!content.contains("<invoke name=\"exec_command\">"));
        assert!(!content.contains("<parameter name=\"cmd\""));
    }

    #[test]
    fn test_extract_json_candidates_unclosed_fence() {
        let text = "```json\n{\"a\":1}\n";
        let out = extract_json_candidates_from_text(text);
        assert!(out.is_empty());
    }

    #[test]
    fn test_collect_harvest_text_variants_masks_wrapper_lines_and_bullet_prefix() {
        let text = "• <<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"apply_patch\",\"input\":{\"patch\":\"*** Begin Patch\\n*** Add File: demo.txt\\n+hi\\n*** End Patch\"}}]}\nRCC_TOOL_CALLS_JSON";
        let variants = collect_harvest_text_variants(text);
        assert!(!variants.is_empty());
        assert!(
            variants
                .iter()
                .any(|item| item.contains("\"tool_calls\"")
                    && !item.contains("<<RCC_TOOL_CALLS_JSON"))
        );
    }

    #[test]
    fn test_harvest_text_tool_calls_recovers_bullet_prefixed_apply_patch_json_wrapper() {
        let mut payload = json!({
            "__rcc_tool_governance": {
                "providerFamily": "qwen",
                "requestedToolNames": ["apply_patch"]
            },
            "tools": [{
                "type": "function",
                "function": {
                    "name": "apply_patch"
                }
            }],
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": r#"• {"tool_calls":[{"name":"apply_patch","input":{"patch":"*** Begin Patch
*** Add File: demo.txt
+hi
*** End Patch"}}]}"#
                },
                "finish_reason": "stop"
            }]
        });
        assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 0);
        assert!(payload["choices"][0]["message"]["tool_calls"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_harvest_text_tool_calls_recovers_noisy_exec_command_json_wrapper_with_trailing_status()
    {
        let mut payload = json!({
            "__rcc_tool_governance": {
                "providerFamily": "deepseek-web",
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "⏺ {\"tool_calls\":[{\"name\":\"shell_command\",\"input\":{\"command\":\"bd --no-db ready\"}},{\"name\":\"shell_command\",\"input\":{\"command\":\"bd --no-db list --status in_progress\"}}]}\n\n✻ Baked for 41s"
                },
                "finish_reason": "stop"
            }]
        });
        assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 2);
        let tool_calls = payload["choices"][0]["message"]["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 2);
        assert_eq!(tool_calls[0]["function"]["name"], "exec_command");
        assert_eq!(tool_calls[1]["function"]["name"], "exec_command");
        let args0: Value = serde_json::from_str(
            tool_calls[0]["function"]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        let args1: Value = serde_json::from_str(
            tool_calls[1]["function"]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        assert_eq!(args0["command"], "bd --no-db ready");
        assert_eq!(args1["command"], "bd --no-db list --status in_progress");
    }

    #[test]
    fn test_harvest_text_tool_calls_recovers_escaped_exec_command_transcript_with_trailing_text() {
        let mut payload = json!({
            "__rcc_tool_governance": {
                "providerFamily": "deepseek-web",
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "{\\\"tool_calls\\\":[{\\\"name\\\":\\\"exec_command\\\",\\\"input\\\":{\\\"cmd\\\":\\\"npm run build:dev\\\",\\\"workdir\\\":\\\"/Users/fanzhang/Documents/github/routecodex\\\"}}]}<｜User｜>> routecodex@0.89.2125 build:dev<｜Assistant｜>继续执行"
                },
                "finish_reason": "stop"
            }]
        });
        assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 0);
        let call = &payload["choices"][0]["message"]["tool_calls"][0];
        assert_eq!(call["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args["cmd"], "npm run build:dev");
        assert_eq!(
            args["workdir"],
            "/Users/fanzhang/Documents/github/routecodex"
        );
    }

    #[test]
    fn test_harvest_text_tool_calls_recovers_trailing_exec_command_json_after_prose() {
        let mut payload = json!({
            "__rcc_tool_governance": {
                "providerFamily": "deepseek-web",
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "我将按以下步骤执行：\n\n1. 先检查项目状态\n2. 再执行构建\n\n让我立即开始：\n\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"command\":\"bd --no-db ready\"}}]}"
                },
                "finish_reason": "stop"
            }]
        });
        assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 0);
        let call = &payload["choices"][0]["message"]["tool_calls"][0];
        assert_eq!(call["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args["command"], "bd --no-db ready");
    }

    #[test]
    fn test_harvest_text_tool_calls_recovers_exec_command_inside_chunked_transcript_shape() {
        let mut payload = json!({
            "__rcc_tool_governance": {
                "providerFamily": "deepseek-web",
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "Chunk ID: abc\nWall time: 0.1s\nProcess exited with code 0\nOriginal token count: 12\nOutput:\n<tool_call>\n{\"arguments\":{\"cmd\":\"echo next\"},\"id\":\"call_1\",\"name\":\"exec_command\"}\n</tool_call>\n"
                },
                "finish_reason": "stop"
            }]
        });
        assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 0);
        let call = &payload["choices"][0]["message"]["tool_calls"][0];
        assert_eq!(call["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args["cmd"], "echo next");
    }

    #[test]
    fn test_harvest_text_tool_calls_strips_right_gutter_noise_before_exec_command_recovery() {
        let mut payload = json!({
            "__rcc_tool_governance": {
                "providerFamily": "deepseek-web",
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "Chunk ID: abc\nWall time: 0.1s\nProcess exited with code 1\nOriginal token count: 12\nOutput:\n<tool_call>                                                                    │··········································\n{\"arguments\":{\"cmd\":\"python3 -V\"},\"id\":\"call_1\",\"name\":\"exec_command\"} │··········································\n</tool_call>                                                                   │··········································\n"
                },
                "finish_reason": "stop"
            }]
        });
        assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 0);
        let call = &payload["choices"][0]["message"]["tool_calls"][0];
        assert_eq!(call["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args["cmd"], "python3 -V");
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
    fn test_govern_response_drops_structured_tool_calls_not_in_requested_allowlist() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "__rcc_tool_governance": {
                    "requestedToolNames": ["exec_command"]
                },
                "choices": [{
                    "message": {
                        "content": "保持正文",
                        "tool_calls": [{
                            "function": {
                                "name": "mailbox.status",
                                "arguments": r#"{"target":"finger-system-agent"}"#
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_allowlist_drop_structured".to_string(),
        };

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.disallowed_tool_calls_dropped, 1);
        assert_eq!(result.summary.tool_calls_normalized, 0);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "stop"
        );
        let tool_calls = result.governed_payload["choices"][0]["message"]["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(tool_calls.is_empty());
        assert_eq!(
            result.governed_payload["choices"][0]["message"]["content"],
            "保持正文"
        );
        assert!(result
            .governed_payload
            .get("__rcc_tool_governance")
            .is_none());
    }

    #[test]
    fn test_govern_response_allows_shell_alias_when_exec_command_requested() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "__rcc_tool_governance": {
                    "requestedToolNames": ["exec_command"]
                },
                "choices": [{
                    "message": {
                        "tool_calls": [{
                            "function": {
                                "name": "shell_command",
                                "arguments": {"command": "pwd"}
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_allowlist_shell_alias".to_string(),
        };

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.disallowed_tool_calls_dropped, 0);
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
    }

    #[test]
    fn test_govern_response_harvest_respects_requested_allowlist_and_preserves_text() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "__rcc_tool_governance": {
                    "requestedToolNames": ["exec_command"]
                },
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": r#"<function_calls>{"tool_calls":[{"name":"mailbox.status","input":{"target":"finger-system-agent"}}]}</function_calls>
            保留正文"#
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_allowlist_harvest_drop".to_string(),
        };

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.disallowed_tool_calls_dropped, 0);
        assert_eq!(result.summary.tool_calls_normalized, 0);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "stop"
        );
        let tool_calls = result.governed_payload["choices"][0]["message"]["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(tool_calls.is_empty());
        let content = result.governed_payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");
        assert_eq!(content, "保留正文");
    }

    #[test]
    fn test_govern_response_cleans_explicit_wrapper_when_tool_calls_are_unharvested() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "__rcc_tool_governance": {
                    "requestedToolNames": ["exec_command"]
                },
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": r#"<function_calls>{"tool_calls":[{"name":"mailbox.status","input":{"target":"finger-system-agent"}}]}</function_calls>"#
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_preserve_wrapper_only_when_unharvested".to_string(),
        };

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.tool_calls_normalized, 0);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "stop"
        );
        let tool_calls = result.governed_payload["choices"][0]["message"]["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(tool_calls.is_empty());
        assert!(
            result.governed_payload["choices"][0]["message"]
                .get("content")
                .is_none()
                || result.governed_payload["choices"][0]["message"]["content"]
                    .as_str()
                    .map(|v| !v.contains("<function_calls>") && !v.contains("</function_calls>"))
                    .unwrap_or(true)
        );
    }

    #[test]
    fn test_strip_tool_call_marker_payload_preserves_trailing_prose_for_closed_function_calls() {
        let raw = "<function_calls>```bash\npwd\n```</function_calls>\n保留正文";
        assert_eq!(strip_tool_call_marker_payload(raw), "保留正文");
    }

    #[test]
    fn test_strip_text_tool_wrapper_noise_strips_search_query_tags_but_preserves_text() {
        let raw = "<search>\n<query>context rebuild rebuild_context</query>\n</search>";
        assert_eq!(
            strip_text_tool_wrapper_noise(raw),
            "context rebuild rebuild_context"
        );
    }

    #[test]
    fn test_strip_xml_tags_preserve_text_keeps_line_breaks() {
        let raw = "<review>\n第一行\n\n第二行 <search>query</search>\n</review>";
        assert_eq!(strip_xml_tags_preserve_text(raw), "第一行\n\n第二行 query");
    }

    #[test]
    fn test_sanitize_textual_marker_field_preserves_inner_text_when_wrapper_only_content_would_empty(
    ) {
        let mut message = serde_json::json!({
            "content": "<function_calls>保留内部文本</function_calls>"
        })
        .as_object()
        .cloned()
        .unwrap();
        assert!(sanitize_textual_marker_field_in_message(
            &mut message,
            "content"
        ));
        assert_eq!(message["content"], "保留内部文本");
    }

    #[test]
    fn test_sanitize_textual_marker_field_preserves_trailing_text_when_rcc_wrapper_starts_first() {
        let raw = "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\"}}]}\nRCC_TOOL_CALLS_JSON\n保留正文";
        assert_eq!(strip_tool_call_marker_payload(raw), "保留正文");
        let mut message = serde_json::json!({
            "content": raw
        })
        .as_object()
        .cloned()
        .unwrap();
        assert!(sanitize_textual_marker_field_in_message(
            &mut message,
            "content"
        ));
        assert_eq!(message["content"], "保留正文");
    }

    #[test]
    fn test_sanitize_textual_marker_field_preserves_malformed_rcc_wrapper_without_name() {
        let raw = "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"pwd\"}}]}\nRCC_TOOL_CALLS_JSON";
        let mut message = serde_json::json!({
            "content": raw
        })
        .as_object()
        .cloned()
        .unwrap();
        assert!(!sanitize_textual_marker_field_in_message(
            &mut message,
            "content"
        ));
        assert_eq!(message["content"], raw);
    }

    #[test]
    fn test_sanitize_textual_marker_field_preserves_malformed_rcc_wrapper_multiline_whitespace() {
        let raw = "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"bash -lc 'cat << \\\"EOF\\\"\\n  line1\\n    line2\\nEOF\\n'\"}}]}\nRCC_TOOL_CALLS_JSON";
        let mut message = serde_json::json!({
            "content": raw
        })
        .as_object()
        .cloned()
        .unwrap();
        assert!(!sanitize_textual_marker_field_in_message(
            &mut message,
            "content"
        ));
        assert_eq!(message["content"], raw);
    }

    #[test]
    fn test_govern_response_fails_fast_for_malformed_rcc_wrapper_when_name_missing() {
        let raw = "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"pwd\"}}]}\nRCC_TOOL_CALLS_JSON";
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "__rcc_tool_governance": {
                    "requestedToolNames": ["exec_command"]
                },
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": raw
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_preserve_malformed_rcc_missing_name".to_string(),
        };

        let output = govern_response(input).unwrap();
        let tool_calls = output.governed_payload["choices"][0]["message"]["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0]["function"]["name"], "exec_command");
        let args: Value = serde_json::from_str(
            tool_calls[0]["function"]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        assert_eq!(args["cmd"], "pwd");
    }

    #[test]
    fn test_govern_response_fails_fast_for_malformed_rcc_wrapper_multiline_whitespace_when_name_missing(
    ) {
        let raw = "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"bash -lc 'cat << \\\"EOF\\\"\\n  line1\\n    line2\\nEOF\\n'\"}}]}\nRCC_TOOL_CALLS_JSON";
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "__rcc_tool_governance": {
                    "providerFamily": "deepseek-web",
                    "requestedToolNames": ["exec_command"]
                },
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": raw
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_preserve_malformed_rcc_multiline_whitespace".to_string(),
        };

        let output = govern_response(input).unwrap();
        let tool_calls = output.governed_payload["choices"][0]["message"]["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0]["function"]["name"], "exec_command");
        let args: Value = serde_json::from_str(
            tool_calls[0]["function"]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        assert_eq!(
            args["cmd"],
            "bash -lc 'cat << \"EOF\"\\n  line1\\n    line2\\nEOF\\n'"
        );
    }

    #[test]
    fn test_govern_response_recovers_deepseek_web_update_plan_tool_call_without_name() {
        let raw = "<tool_call>\n{\"explanation\":\"修复 scheduler 决策逻辑：当 execution_state 为 running 但 owner_loop_action 指示有 ready 任务可派发时，不应等待 running 完成而应直接派发。\",\"plan\":[{\"status\":\"in_progress\",\"step\":\"修改 scheduler.rs derive_scheduler_decision 中的 running 分支，允许覆盖为 dispatch_ready_task\"},{\"status\":\"pending\",\"step\":\"编译并测试修改\"},{\"status\":\"pending\",\"step\":\"清理状态并重新启动 daemon 验证\"}]}\n</tool_call>";
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "__rcc_tool_governance": {
                    "providerFamily": "deepseek-web",
                    "requestedToolNames": ["update_plan"]
                },
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": raw
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_deepseek_web_update_plan_without_name".to_string(),
        };

        let output = govern_response(input).unwrap();
        let tool_calls = output.governed_payload["choices"][0]["message"]["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0]["function"]["name"], "update_plan");
        let args: Value = serde_json::from_str(
            tool_calls[0]["function"]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        assert_eq!(args["plan"][0]["status"], "in_progress");
        assert_eq!(
            args["plan"][0]["step"],
            "修改 scheduler.rs derive_scheduler_decision 中的 running 分支，允许覆盖为 dispatch_ready_task"
        );
        assert!(output.governed_payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .is_empty());
        assert_eq!(
            output.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
    }

    #[test]
    fn test_govern_response_sanitizes_marker_text_when_structured_tool_calls_already_exist() {
        let raw = "• <<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\"}}]}\nRCC_TOOL_CALLS_JSON";
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [{
                            "id": "call_existing",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"pwd\"}"
                            }
                        }],
                        "content": raw
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_existing_tool_calls_sanitize_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
        assert_eq!(message["content"], "");
    }

    #[test]
    fn test_rcc_heredoc_tail_is_stripped_even_when_nonstandard_tool_call_is_recovered() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "开始分析。\n<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"name\":\"多轨实现\",\"description\":\"为 Finger 项目增加 multi-track 支持\"},\"name\":\"bd\"}]}\nRCC_TOOL_CALLS_JSON\n› Implement {feature}\nMacstudio.0:zsh*"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_rcc_strip_tail_recover_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert!(result.summary.applied);
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert_eq!(message["tool_calls"][0]["function"]["name"], "bd");
        let content = message["content"].as_str().unwrap_or("");
        assert_eq!(content, "开始分析。");
        assert!(!content.contains("RCC_TOOL_CALLS_JSON"));
        assert!(!content.contains("Implement {feature}"));
        assert!(!content.contains("Macstudio.0:zsh*"));
    }

    #[test]
    fn test_govern_response_preserves_allowed_multi_tool_calls() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "__rcc_tool_governance": {
                    "requestedToolNames": ["exec_command", "apply_patch"]
                },
                "choices": [{
                    "message": {
                        "tool_calls": [{
                            "function": {
                                "name": "apply_patch",
                                "arguments": "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch"
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_allowlist_multi_keep".to_string(),
        };

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.disallowed_tool_calls_dropped, 0);
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "apply_patch"
        );
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

/// Collect tool names from a candidate (array of tools) and return as JSON array.
#[napi]
pub fn collect_tool_names_from_candidate_json(candidate_json: String) -> napi::Result<String> {
    let candidate: serde_json::Value = serde_json::from_str(&candidate_json)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, e.to_string()))?;

    let arr = match &candidate {
        serde_json::Value::Array(a) => a,
        _ => return Ok("[]".to_string()),
    };

    let mut names: Vec<String> = Vec::new();
    for item in arr {
        let name = match item {
            serde_json::Value::String(s) => {
                let t = s.trim();
                if t.is_empty() { None } else { Some(t.to_string()) }
            }
            serde_json::Value::Object(m) => {
                // Try function.name first
                if let Some(serde_json::Value::Object(func)) = m.get("function") {
                    if let Some(serde_json::Value::String(n)) = func.get("name") {
                        let t = n.trim();
                        if t.is_empty() { None } else { Some(t.to_string()) }
                    } else { None }
                } else if let Some(serde_json::Value::String(n)) = m.get("name") {
                    let t = n.trim();
                    if t.is_empty() { None } else { Some(t.to_string()) }
                } else { None }
            }
            _ => None,
        };
        if let Some(n) = name {
            names.push(n);
        }
    }

    serde_json::to_string(&names)
        .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
}

/// Resolve requested tool names from multiple sources in one call.
#[napi]
pub fn resolve_requested_tool_names_json(input_json: String) -> napi::Result<String> {
    let input: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, e.to_string()))?;
    let mut names: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    fn collect(candidate: &serde_json::Value, names: &mut Vec<String>, seen: &mut std::collections::HashSet<String>) {
        let arr = match candidate { serde_json::Value::Array(a) => a, _ => return };
        for item in arr {
            let name = match item {
                serde_json::Value::String(s) => { let t = s.trim(); if t.is_empty() { None } else { Some(t.to_string()) } }
                serde_json::Value::Object(m) => {
                    if let Some(serde_json::Value::Object(func)) = m.get("function") {
                        if let Some(serde_json::Value::String(n)) = func.get("name") { let t = n.trim(); if t.is_empty() { None } else { Some(t.to_string()) } } else { None }
                    } else if let Some(serde_json::Value::String(n)) = m.get("name") { let t = n.trim(); if t.is_empty() { None } else { Some(t.to_string()) } } else { None }
                }
                _ => None,
            };
            if let Some(n) = name { if !seen.contains(&n) { seen.insert(n.clone()); names.push(n); } }
        }
    }
    if let Some(serde_json::Value::Object(sem)) = input.get("requestSemantics") {
        if let Some(tools) = sem.get("tools") { collect(tools, &mut names, &mut seen); }
        if let Some(serde_json::Value::Object(t)) = sem.get("tools") {
            if let Some(v) = t.get("clientToolsRaw") { collect(v, &mut names, &mut seen); }
            if let Some(v) = t.get("baselineTools") { collect(v, &mut names, &mut seen); }
        }
    }
    if let Some(serde_json::Value::Object(ac)) = input.get("adapterContext") {
        if let Some(serde_json::Value::Object(cr)) = ac.get("capturedChatRequest") {
            if let Some(tools) = cr.get("tools") { collect(tools, &mut names, &mut seen); }
        }
    }
    serde_json::to_string(&names).map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
}

#[napi]
pub fn normalize_apply_patch_arguments_json(input_json: String) -> napi::Result<String> {
    let input: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, e.to_string()))?;
    let raw_args = input.get("arguments");
    let normalized = normalize_apply_patch_schema_args(raw_args);
    let mut out = Map::new();
    out.insert(
        "normalizedArguments".to_string(),
        Value::String(normalized.0.clone()),
    );
    out.insert("repaired".to_string(), Value::Bool(normalized.1));
    serde_json::to_string(&Value::Object(out))
        .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
}

#[napi]
pub fn validate_apply_patch_arguments_json(input_json: String) -> napi::Result<String> {
    let input: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, e.to_string()))?;
    let raw_args = input.get("arguments");
    let parsed_args = parse_json_record(raw_args).unwrap_or_default();
    let raw_source = parsed_args
        .get("patch")
        .or_else(|| parsed_args.get("input"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or_else(|| {
            extract_apply_patch_text(raw_args)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_default();
    let normalized = normalize_apply_patch_schema_args(raw_args);
    let normalized_args_value: Value =
        serde_json::from_str(&normalized.0).unwrap_or_else(|_| Value::Object(Map::new()));
    let patch = normalized_args_value
        .as_object()
        .and_then(|row| row.get("patch"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let invalid_reason = detect_apply_patch_authoring_invalid_reason(raw_source.as_str())
        .or_else(|| detect_apply_patch_invalid_reason(patch.as_str()));

    let mut out = Map::new();
    out.insert("ok".to_string(), Value::Bool(invalid_reason.is_none()));
    out.insert(
        "normalizedArguments".to_string(),
        Value::String(normalized.0.clone()),
    );
    out.insert("repaired".to_string(), Value::Bool(normalized.1));
    if let Some(reason) = invalid_reason {
        out.insert("reason".to_string(), Value::String(reason.to_string()));
        out.insert(
            "message".to_string(),
            Value::String(apply_patch_error_message(reason).to_string()),
        );
    }
    serde_json::to_string(&Value::Object(out))
        .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
}
