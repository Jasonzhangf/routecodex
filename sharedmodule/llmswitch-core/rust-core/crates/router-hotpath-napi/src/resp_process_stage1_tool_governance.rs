use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::Path;

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
        || payload_contains_explicit_text_tool_markup(payload)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextToolProviderFamily {
    Other,
    DeepSeek,
    Qwen,
}

fn read_text_tool_provider_family_from_governance(payload: &Value) -> Option<TextToolProviderFamily> {
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
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    let lowered = trimmed.to_ascii_lowercase();
    if lowered.contains("<<rcc_tool_calls")
        || lowered.contains("<function_calls>")
        || lowered.contains("<tool_call>")
        || lowered.contains("<|tool_call_begin|>")
        || lowered.contains("<|tool_calls_section_begin|>")
        || lowered.contains("<invoke")
        || lowered.contains("\"tool_calls\"")
        || lowered.contains("'tool_calls'")
        || lowered.contains("tool_calls:")
    {
        return true;
    }

    if lowered.contains("tool:") {
        let has_xml_body = lowered.contains("</tool:")
            || lowered.contains("<command>")
            || lowered.contains("<arg_key>")
            || lowered.contains("<arg_value>")
            || lowered.contains("<parameter>");
        if has_xml_body {
            return true;
        }
    }

    false
}

fn contains_explicit_tool_wrapper_marker(raw: &str) -> bool {
    let lowered = raw.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return false;
    }
    if lowered.contains("<<rcc_tool_calls")
        || lowered.contains("<function_calls>")
        || lowered.contains("</function_calls>")
        || lowered.contains("<tool_call>")
        || lowered.contains("</tool_call>")
        || lowered.contains("<|tool_call_begin|>")
        || lowered.contains("<|tool_calls_section_begin|>")
    {
        return true;
    }

    let Ok(tag_re) = Regex::new(r"(?is)</?\s*tool:[a-z0-9_.-]+") else {
        return false;
    };
    if tag_re.is_match(raw) {
        return true;
    }

    let Ok(named_re) = Regex::new(r"(?is)</?\s*(exec_command|execute_command|apply_patch|write_stdin|update_plan|request_user_input|spawn_agent|send_input|resume_agent|wait_agent|close_agent|view_image|shell_command|shell|bash|terminal)\b") else {
        return false;
    };
    named_re.is_match(raw)
}

fn payload_contains_explicit_text_tool_markup(payload: &Value) -> bool {
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
                    .any(|text| text_contains_explicit_tool_markup(text))
            })
            .unwrap_or(false)
    })
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

    if let Some(body) = current.strip_prefix("bash -lc '") {
        if !body.ends_with('\'') && !body.contains('\'') {
            current.push('\'');
        }
    }

    current
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

    let Some(command_token) = tokens.next().map(str::trim).filter(|value| !value.is_empty()) else {
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
            })
            .or_else(|| {
                let path = read_trimmed_string(row.get("path").or_else(|| row.get("file")))?;
                let content = read_trimmed_string(
                    row.get("content")
                        .or_else(|| row.get("contents"))
                        .or_else(|| row.get("body")),
                )?;
                let normalized_path = normalize_apply_patch_header_path(path.as_str());
                if normalized_path.trim().is_empty() {
                    return None;
                }
                let normalized_content = decode_escaped_newlines_if_needed(content.as_str());
                let mut lines: Vec<String> = normalized_content
                    .split('\n')
                    .map(|line| format!("+{}", line))
                    .collect();
                if normalized_content.is_empty() {
                    lines.push("+".to_string());
                }
                Some(format!(
                    "*** Begin Patch\n*** Add File: {}\n{}\n*** End Patch",
                    normalized_path,
                    lines.join("\n")
                ))
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
        let cmd = strip_python_heredoc_pseudo_escapes(
            repair_shell_wrapper_shape(read_command_from_args(&args)?.as_str()).as_str(),
        );
        let mut out = Map::new();
        let preserve_command_alias = source_is_shell_alias
            || args.contains_key("command")
            || args
                .get("input")
                .and_then(Value::as_object)
                .map(|row| row.contains_key("command"))
                .unwrap_or(false)
            || args
                .get("args")
                .and_then(Value::as_object)
                .map(|row| row.contains_key("command"))
                .unwrap_or(false);
        if preserve_command_alias {
            out.insert("command".to_string(), Value::String(cmd.clone()));
        }
        out.insert("cmd".to_string(), Value::String(cmd));
        if let Some(workdir) = read_workdir_from_args(&args) {
            out.insert("workdir".to_string(), Value::String(workdir));
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
                    if let Some(step_text) = row.as_str().map(str::trim).filter(|value| !value.is_empty()) {
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

fn stringify_tool_args_losslessly(raw_args: Option<&Value>) -> Option<String> {
    match raw_args {
        None => None,
        Some(Value::Null) => Some("{}".to_string()),
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                Some("{}".to_string())
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(other) => serde_json::to_string(other).ok(),
    }
}

pub(crate) fn normalize_tool_args_preserving_raw_shape(
    tool_name: &str,
    raw_args: Option<&Value>,
) -> Option<String> {
    let canonical_name = normalize_tool_name(tool_name)?;
    if canonical_name != "exec_command" {
        return normalize_tool_args(tool_name, raw_args);
    }
    stringify_tool_args_losslessly(raw_args)
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
    let Ok(attr_pattern) = Regex::new(
        r#"([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
    ) else {
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
    let attr_tool_name = read_xml_tag_attribute(attrs, &["name", "tool", "tool_name", "call", "action"]);
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
        if let Some(attr_name) = read_xml_tag_attribute(attrs, &["name", "key", "field", "property"]) {
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
            let decoded = decode_basic_xml_entities(raw_value).trim().to_string();
            let cleaned_value = if decoded.contains('<') && decoded.contains('>') {
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

    let mut masked_plain = String::with_capacity(body.len());
    let mut last = 0usize;
    for (start, end) in masked_ranges {
        if start > last {
            masked_plain.push_str(&body[last..start]);
        }
        masked_plain.push(' ');
        last = end.min(body.len());
    }
    if last < body.len() {
        masked_plain.push_str(&body[last..]);
    }
    let masked_plain = decode_basic_xml_entities(masked_plain.as_str())
        .trim()
        .to_string();
    let stripped_plain = strip_xml_tags_preserve_text(body);
    if !masked_plain.is_empty() || !stripped_plain.is_empty() {
        let plain_exec_fallback = if !masked_plain.is_empty() {
            masked_plain.clone()
        } else {
            stripped_plain.clone()
        };
        let plain_patch_fallback = if !masked_plain.is_empty() {
            masked_plain.clone()
        } else {
            stripped_plain.clone()
        };
        if matches!(
            canonical_name.as_str(),
            "exec_command" | "shell_command" | "shell" | "bash" | "terminal"
        ) && read_command_from_args(&args).is_none()
        {
            if !plain_exec_fallback.is_empty() {
                args.insert("cmd".to_string(), Value::String(plain_exec_fallback));
            }
        } else if canonical_name == "apply_patch"
            && extract_apply_patch_text(Some(&Value::Object(args.clone()))).is_none()
        {
            if !plain_patch_fallback.is_empty() {
                args.insert(
                    "patch".to_string(),
                    Value::String(plain_patch_fallback.clone()),
                );
                args.insert("input".to_string(), Value::String(plain_patch_fallback));
            }
        } else if args.is_empty() {
            let source = if !masked_plain.is_empty() {
                masked_plain
            } else {
                stripped_plain
            };
            let value = try_parse_json_value_lenient(source.as_str())
                .unwrap_or_else(|| Value::String(source));
            args.insert("input".to_string(), value);
        }
    }

    if args.is_empty() {
        return None;
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
    let Ok(open_pattern) = Regex::new(r"(?is)<([A-Za-z_][A-Za-z0-9_.-]*)(?:\s+[^<>]*?)?>") else {
        return Vec::new();
    };
    let text_lower = text.to_ascii_lowercase();

    let mut recovered: Vec<Value> = Vec::new();
    let mut seen = HashSet::<String>::new();
    let mut cursor = 0usize;
    let mut index = 0usize;
    while let Some(caps) = open_pattern.captures(&text[cursor..]) {
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
            .unwrap_or(text.len());
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
            let body = text[open_end..body_end].trim();
            if !body.is_empty() {
                index += 1;
                if let Some(entry) = build_xml_named_tool_call_entry(
                    raw_name,
                    body,
                    &wrapper_attrs,
                    fallback_start_id + index - 1,
                )
                {
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
    let Ok(open_pattern) = Regex::new(r"(?is)<([A-Za-z_][A-Za-z0-9_.-]*)(?:\s+[^<>]*?)?>") else {
        return raw.to_string();
    };
    let raw_lower = raw.to_ascii_lowercase();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0usize;
    while let Some(caps) = open_pattern.captures(&raw[cursor..]) {
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
            .unwrap_or(raw.len());
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
        return raw.to_string();
    }

    let mut out = String::with_capacity(raw.len());
    let mut last = 0usize;
    for (start, end) in ranges {
        if start > last {
            out.push_str(&raw[last..start]);
        }
        last = end.min(raw.len());
    }
    if last < raw.len() {
        out.push_str(&raw[last..]);
    }
    out
}

fn extract_xml_tool_call_blocks(text: &str, fallback_start_id: usize) -> Vec<Value> {
    let Ok(pattern) = Regex::new(r"(?is)<tool_call>\s*([\s\S]*?)\s*</tool_call>") else {
        return Vec::new();
    };
    let mut recovered: Vec<Value> = Vec::new();
    for (idx, caps) in pattern.captures_iter(text).enumerate() {
        let Some(raw) = caps.get(1).map(|m| m.as_str().trim()) else {
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        let parsed = try_parse_json_value_lenient(raw).or_else(|| {
            let repaired = auto_close_jsonish_shape(raw);
            try_parse_json_value_lenient(repaired.as_str())
        });
        let Some(value) = parsed else {
            continue;
        };
        if let Some(entry) = normalize_tool_call_entry(&value, fallback_start_id + idx) {
            recovered.push(entry);
        }
    }
    recovered
}

fn extract_tool_argument_label_blocks(text: &str, fallback_start_id: usize) -> Vec<Value> {
    let Ok(tool_pattern) = Regex::new(r"(?im)^[>\-\*\s]*Tool\s*:\s*([A-Za-z0-9_.-]+)\s*$") else {
        return Vec::new();
    };
    let Ok(args_pattern) = Regex::new(r"(?im)^[>\-\*\s]*Arguments?\s*:\s*") else {
        return Vec::new();
    };

    let tool_matches: Vec<(usize, usize, String)> = tool_pattern
        .captures_iter(text)
        .filter_map(|caps| {
            let whole = caps.get(0)?;
            let name = caps.get(1)?.as_str().trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some((whole.start(), whole.end(), name))
        })
        .collect();
    if tool_matches.is_empty() {
        return Vec::new();
    }

    let mut recovered: Vec<Value> = Vec::new();
    for (idx, (_, tool_line_end, tool_name)) in tool_matches.iter().enumerate() {
        let block_end = tool_matches
            .get(idx + 1)
            .map(|entry| entry.0)
            .unwrap_or(text.len());
        if *tool_line_end >= block_end {
            continue;
        }
        let segment = &text[*tool_line_end..block_end];
        let Some(args_match) = args_pattern.find(segment) else {
            continue;
        };
        let args_tail = &segment[args_match.end()..];
        let Some((non_ws_rel, first_char)) =
            args_tail.char_indices().find(|(_, ch)| !ch.is_whitespace())
        else {
            continue;
        };
        let candidate_start = args_match.end() + non_ws_rel;
        let candidate_raw = match first_char {
            '{' => extract_balanced_json_object_at(segment, candidate_start),
            '[' => extract_balanced_json_array_at(segment, candidate_start),
            _ => None,
        }
        .or_else(|| {
            let trimmed = args_tail.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });
        let Some(candidate_raw) = candidate_raw else {
            continue;
        };
        let parsed = try_parse_json_value_lenient(candidate_raw.as_str()).or_else(|| {
            let repaired = auto_close_jsonish_shape(candidate_raw.as_str());
            try_parse_json_value_lenient(repaired.as_str())
        });
        let Some(arguments) = parsed else {
            continue;
        };
        let entry = json!({
            "name": tool_name,
            "arguments": arguments,
        });
        if let Some(normalized) =
            normalize_tool_call_entry(&entry, fallback_start_id + recovered.len())
        {
            recovered.push(normalized);
        }
    }

    recovered
}

fn extract_balanced_parenthesized_body_at(text: &str, open_paren_index: usize) -> Option<String> {
    let bytes = text.as_bytes();
    if open_paren_index >= bytes.len() || bytes[open_paren_index] != b'(' {
        return None;
    }

    let mut depth = 0i64;
    let mut in_string = false;
    let mut quote_char = b'"';
    let mut escaped = false;

    for idx in open_paren_index..bytes.len() {
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
            if ch == quote_char {
                in_string = false;
            }
            continue;
        }

        if ch == b'"' || ch == b'\'' {
            in_string = true;
            quote_char = ch;
            continue;
        }

        if ch == b'(' {
            depth += 1;
            continue;
        }
        if ch == b')' {
            depth -= 1;
            if depth == 0 {
                return Some(text[open_paren_index + 1..idx].to_string());
            }
        }
    }

    None
}

fn split_top_level_function_style_args(raw: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut brace_depth = 0i64;
    let mut bracket_depth = 0i64;
    let mut paren_depth = 0i64;
    let mut in_string = false;
    let mut quote_char = '\0';
    let mut escaped = false;

    for ch in raw.chars() {
        if in_string {
            current.push(ch);
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == quote_char {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' | '\'' => {
                in_string = true;
                quote_char = ch;
                current.push(ch);
            }
            '{' => {
                brace_depth += 1;
                current.push(ch);
            }
            '}' => {
                brace_depth -= 1;
                current.push(ch);
            }
            '[' => {
                bracket_depth += 1;
                current.push(ch);
            }
            ']' => {
                bracket_depth -= 1;
                current.push(ch);
            }
            '(' => {
                paren_depth += 1;
                current.push(ch);
            }
            ')' => {
                paren_depth -= 1;
                current.push(ch);
            }
            ',' if brace_depth == 0 && bracket_depth == 0 && paren_depth == 0 => {
                let trimmed = current.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }

    let trimmed = current.trim();
    if !trimmed.is_empty() {
        parts.push(trimmed.to_string());
    }
    parts
}

fn decode_function_style_string(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() < 2 {
        return trimmed.to_string();
    }
    let mut chars = trimmed.chars();
    let quote = chars.next().unwrap_or('"');
    if (quote != '"' && quote != '\'') || !trimmed.ends_with(quote) {
        return trimmed.to_string();
    }
    let inner = &trimmed[1..trimmed.len() - 1];
    let mut out = String::new();
    let mut escaped = false;
    for ch in inner.chars() {
        if escaped {
            out.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '\\' => '\\',
                '"' => '"',
                '\'' => '\'',
                other => other,
            });
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        out.push(ch);
    }
    if escaped {
        out.push('\\');
    }
    out
}

fn parse_function_style_argument_value(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
    {
        if let Some(parsed) = try_parse_json_value_lenient(trimmed) {
            return Some(parsed);
        }
    }
    if (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('\'') && trimmed.ends_with('\''))
    {
        return Some(Value::String(decode_function_style_string(trimmed)));
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "true" => return Some(Value::Bool(true)),
        "false" => return Some(Value::Bool(false)),
        "null" => return Some(Value::Null),
        _ => {}
    }
    if let Ok(parsed) = trimmed.parse::<i64>() {
        return Some(Value::Number(parsed.into()));
    }
    if let Ok(parsed) = trimmed.parse::<f64>() {
        if let Some(num) = serde_json::Number::from_f64(parsed) {
            return Some(Value::Number(num));
        }
    }
    Some(Value::String(trimmed.to_string()))
}

fn resolve_allowlisted_function_style_name(
    raw_name: &str,
    allowed_names: &HashSet<String>,
) -> Option<String> {
    let trimmed = raw_name.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut candidates: Vec<String> = vec![trimmed.to_string()];
    let lowered = trimmed.to_ascii_lowercase();
    if let Some(stripped) = lowered.strip_prefix("tool") {
        if !stripped.trim().is_empty() {
            candidates.push(stripped.trim().to_string());
        }
    }

    for candidate in candidates {
        let Some(canonical_name) = normalize_tool_name(candidate.as_str()) else {
            continue;
        };
        if allowed_names.contains(canonical_name.as_str()) {
            return Some(canonical_name);
        }
    }

    None
}

fn extract_allowlisted_function_style_calls(
    text: &str,
    requested_tool_name_keys: &HashSet<String>,
    fallback_start_id: usize,
) -> Vec<Value> {
    let standalone_fallback_allowlist: HashSet<String> = [
        "exec_command",
        "write_stdin",
        "update_plan",
        "apply_patch",
        "view_image",
        "request_user_input",
        "spawn_agent",
        "send_input",
        "resume_agent",
        "wait_agent",
        "close_agent",
    ]
    .iter()
    .map(|name| name.to_string())
    .collect();
    let restrict_to_standalone_call = requested_tool_name_keys.is_empty();
    let allowed_names: HashSet<String> = if restrict_to_standalone_call {
        standalone_fallback_allowlist
    } else {
        requested_tool_name_keys
            .iter()
            .filter_map(|name| normalize_tool_name(name))
            .collect()
    };
    if allowed_names.is_empty() {
        return Vec::new();
    }

    let Ok(pattern) = Regex::new(r"([A-Za-z_][A-Za-z0-9_.-]*)\s*\(") else {
        return Vec::new();
    };

    let mut recovered = Vec::new();
    for caps in pattern.captures_iter(text) {
        let Some(name_match) = caps.get(1) else {
            continue;
        };
        let Some(whole) = caps.get(0) else {
            continue;
        };
        let Some(canonical_name) =
            resolve_allowlisted_function_style_name(name_match.as_str().trim(), &allowed_names)
        else {
            continue;
        };
        let open_paren_index = whole.end().saturating_sub(1);
        let Some(body) = extract_balanced_parenthesized_body_at(text, open_paren_index) else {
            continue;
        };
        if restrict_to_standalone_call {
            let candidate = format!("{}({})", name_match.as_str().trim(), body);
            if text.trim() != candidate {
                continue;
            }
        }
        let mut args = Map::new();
        let mut valid = true;
        for segment in split_top_level_function_style_args(body.as_str()) {
            let Some(eq_idx) = segment.find('=') else {
                valid = false;
                break;
            };
            let key = segment[..eq_idx].trim();
            if key.is_empty() {
                valid = false;
                break;
            }
            let Some(value) = parse_function_style_argument_value(&segment[eq_idx + 1..]) else {
                valid = false;
                break;
            };
            args.insert(key.to_string(), value);
        }
        if !valid || args.is_empty() {
            continue;
        }
        let entry = json!({
            "name": canonical_name,
            "arguments": Value::Object(args),
        });
        if let Some(normalized) =
            normalize_tool_call_entry(&entry, fallback_start_id + recovered.len())
        {
            recovered.push(normalized);
        }
    }

    recovered
}

fn collect_line_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start = 0usize;
    for (idx, ch) in text.char_indices() {
        if ch == '\n' {
            spans.push((start, idx + 1));
            start = idx + 1;
        }
    }
    if start < text.len() {
        spans.push((start, text.len()));
    }
    spans
}

fn find_allowlisted_wrapper_line_tool_name(
    line: &str,
    allowed_names: &[String],
) -> Option<(usize, String)> {
    let lowered = line.to_ascii_lowercase();
    if !lowered.contains("calling") && !lowered.contains("tool") {
        return None;
    }

    for tool_name in allowed_names {
        let name_lowered = tool_name.to_ascii_lowercase();
        let Some(name_idx) = lowered.find(name_lowered.as_str()) else {
            continue;
        };
        let prefix = &lowered[..name_idx];
        if prefix.contains("calling")
            || prefix.contains("tool:")
            || prefix.contains("tool：")
            || prefix.contains("tool ")
            || prefix.contains("tool\t")
        {
            return Some((name_idx + tool_name.len(), tool_name.clone()));
        }
    }

    None
}

fn extract_allowlisted_calling_label_blocks(
    text: &str,
    requested_tool_name_keys: &HashSet<String>,
    fallback_start_id: usize,
) -> Vec<Value> {
    if requested_tool_name_keys.is_empty() {
        return Vec::new();
    }

    let mut allowed_names: Vec<String> = requested_tool_name_keys
        .iter()
        .filter_map(|name| normalize_tool_name(name))
        .collect();
    allowed_names.sort();
    allowed_names.dedup();
    if allowed_names.is_empty() {
        return Vec::new();
    }

    let line_spans = collect_line_spans(text);
    let mut matches: Vec<(usize, usize, String)> = Vec::new();
    for (line_start, line_end) in &line_spans {
        let line = &text[*line_start..*line_end];
        let Some((inline_after_name, tool_name)) =
            find_allowlisted_wrapper_line_tool_name(line, &allowed_names)
        else {
            continue;
        };
        let segment_start = (*line_start + inline_after_name).min(*line_end);
        matches.push((segment_start, *line_end, tool_name));
    }

    if matches.is_empty() {
        return Vec::new();
    }

    let mut recovered: Vec<Value> = Vec::new();
    for (idx, (segment_start, label_end, tool_name)) in matches.iter().enumerate() {
        let block_end = matches
            .get(idx + 1)
            .map(|entry| entry.0)
            .unwrap_or(text.len());
        let start = (*segment_start).min(*label_end);
        if start >= block_end {
            continue;
        }
        let segment = text[start..block_end].trim();
        if segment.is_empty() {
            continue;
        }

        let mut direct_recovered: Vec<Value> = Vec::new();
        for candidate in extract_json_candidates_from_text(segment) {
            let direct = extract_tool_call_entries_from_unknown(&candidate);
            if !direct.is_empty() {
                direct_recovered = direct;
                break;
            }
            let entry = json!({
                "name": tool_name,
                "arguments": candidate,
            });
            if let Some(normalized) =
                normalize_tool_call_entry(&entry, fallback_start_id + recovered.len())
            {
                direct_recovered.push(normalized);
                break;
            }
        }

        if direct_recovered.is_empty() {
            if segment.contains('<') && segment.contains('>') {
                if let Some(normalized) = build_xml_named_tool_call_entry(
                    tool_name.as_str(),
                    segment,
                    &[],
                    fallback_start_id + recovered.len(),
                ) {
                    direct_recovered.push(normalized);
                }
            }
        }

        if direct_recovered.is_empty() {
            continue;
        }
        recovered.extend(direct_recovered);
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

    let masked_wrapper_variant = mask_tool_wrapper_markup(raw);
    if !masked_wrapper_variant.is_empty() && masked_wrapper_variant != raw.trim() {
        push_variant(masked_wrapper_variant.as_str());
    }

    if raw.contains("\\\"tool_calls\\\"") {
        let unescaped = raw
            .replace("\\\"", "\"")
            .replace("\\n", "\n")
            .replace("\\r", "\r");
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

    push_variant(raw);

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

    if let Ok(re) = Regex::new(r#"(?m)^[ \t]*[•·*]\s+(?=(?:\{|\[|<<RCC_TOOL_CALLS|<\|tool_call))"#) {
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

fn maybe_parse_tool_call_text_value(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(parsed) = try_parse_json_value_lenient(trimmed) {
        return Some(parsed);
    }
    if trimmed.contains("\\\"") {
        let unescaped = trimmed
            .replace("\\\"", "\"")
            .replace("\\n", "\n")
            .replace("\\r", "\r");
        if let Some(parsed) = try_parse_json_value_lenient(unescaped.as_str()) {
            return Some(parsed);
        }
        if let Some(parsed) = parse_tool_calls_shape_from_text(unescaped.as_str()) {
            return Some(parsed);
        }
    }
    parse_tool_calls_shape_from_text(trimmed)
}

fn normalize_tool_call_entry(entry: &Value, fallback_id: usize) -> Option<Value> {
    let row = entry.as_object()?;
    let fn_row = row.get("function").and_then(|v| v.as_object());
    let args_source_with_mode = row
        .get("input")
        .map(|value| (value, false))
        .or_else(|| row.get("arguments").map(|value| (value, true)))
        .or_else(|| row.get("params").map(|value| (value, true)))
        .or_else(|| row.get("parameters").map(|value| (value, true)))
        .or_else(|| row.get("payload").map(|value| (value, true)))
        .or_else(|| fn_row.and_then(|f| f.get("arguments")).map(|value| (value, true)))
        .or_else(|| fn_row.and_then(|f| f.get("input")).map(|value| (value, false)))
        .or_else(|| fn_row.and_then(|f| f.get("params")).map(|value| (value, true)))
        .or_else(|| fn_row.and_then(|f| f.get("parameters")).map(|value| (value, true)))
        .or_else(|| fn_row.and_then(|f| f.get("payload")).map(|value| (value, true)));
    let (args_source, preserve_raw_shape) = args_source_with_mode?;

    let raw_name = read_trimmed_string(row.get("name"))
        .or_else(|| fn_row.and_then(|f| read_trimmed_string(f.get("name"))))
        .or_else(|| infer_tool_name_from_args(Some(args_source)))?;
    let canonical_name = normalize_tool_name(&raw_name)?;
    let normalized_args = if preserve_raw_shape {
        normalize_tool_args_preserving_raw_shape(&raw_name, Some(args_source))?
    } else {
        normalize_tool_args(&raw_name, Some(args_source))?
    };

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
            "<|tool_calls_section_begin|>",
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

    let raw = strip_empty_tool_calls_payload_noise(raw);
    if raw.trim().is_empty() {
        return String::new();
    }
    if looks_like_direct_tool_payload_text(raw.as_str()) {
        return String::new();
    }

    let mut direct_payload_lines_changed = false;
    let mut filtered_lines: Vec<&str> = Vec::new();
    for line in raw.lines() {
        if looks_like_direct_tool_payload_text(line) {
            direct_payload_lines_changed = true;
            continue;
        }
        filtered_lines.push(line);
    }
    let raw = if direct_payload_lines_changed {
        filtered_lines.join("\n")
    } else {
        raw
    };

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

    let patterns = [
        r"(?is)<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>",
        r"(?is)<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>",
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
        r"(?im)^[ \t<|/_-]*tool_calls?(?:_section)?_?begin[a-z_]*[ \t>|/_-]*\r?\n?",
        r"(?im)^[ \t<|/_-]*tool_call_argument_begin[a-z_]*[ \t>|/_-]*\r?\n?",
        r"(?im)^[ \t<|/_-]*tool_calls?(?:_section)?_?end[a-z_]*[ \t>|/_-]*\r?\n?",
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

fn sanitize_textual_noise_field_in_message(message: &mut Map<String, Value>, key: &str) -> bool {
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
    if let Some(preserved) = fallback_preserve_inner_text_when_cleaned_empty(raw.as_str(), cleaned.as_str()) {
        message.insert(key.to_string(), Value::String(preserved));
    } else if cleaned.is_empty() {
        message.remove(key);
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
    if let Some(preserved) = fallback_preserve_inner_text_when_cleaned_empty(raw.as_str(), cleaned.as_str()) {
        message.insert(key.to_string(), Value::String(preserved));
    } else if cleaned.is_empty() {
        message.remove(key);
    } else {
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
    let cleaned = strip_tool_call_marker_payload(raw.as_str());
    if cleaned == raw {
        return false;
    }
    if let Some(preserved) = fallback_preserve_inner_text_when_cleaned_empty(raw.as_str(), cleaned.as_str()) {
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

fn sanitize_content_field_after_tool_markup(
    message: &mut Map<String, Value>,
    _allow_empty_clear: bool,
) -> i64 {
    let Some(content) = message.get_mut("content") else {
        return 0;
    };

    match content {
        Value::String(raw) => {
            let cleaned =
                strip_orphan_tool_markup_lines(strip_tool_call_marker_payload(raw).as_str());
            if cleaned == raw.as_str() {
                return 0;
            }
            if let Some(preserved) =
                fallback_preserve_inner_text_when_cleaned_empty(raw.as_str(), cleaned.as_str())
            {
                *content = Value::String(preserved);
            } else if cleaned.is_empty() {
                *content = Value::String(String::new());
            } else {
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
                    if let Some(preserved) = fallback_preserve_inner_text_when_cleaned_empty(
                        raw,
                        cleaned.as_str(),
                    ) {
                        part_row.insert(key.to_string(), Value::String(preserved));
                    } else if cleaned.is_empty() {
                        part_row.remove(key);
                    } else {
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
                if let Some(preserved) =
                    fallback_preserve_inner_text_when_cleaned_empty(raw, cleaned.as_str())
                {
                    part_row.insert(key.to_string(), Value::String(preserved));
                } else if cleaned.is_empty() {
                    part_row.remove(key);
                } else {
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
        if sanitize_textual_noise_field_in_message(message, "content") {
            changed += 1;
        }
        if sanitize_textual_noise_field_in_message(message, "reasoning_content") {
            changed += 1;
        }
        if sanitize_textual_noise_field_in_message(message, "thinking") {
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
                if let Some(content_val) = message.get_mut("content") {
                    if let Some(content) = content_val.as_str() {
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
    let mut harvested = 0i64;
    let requested_tool_name_keys = collect_requested_tool_name_keys(payload);
    let provider_family = detect_text_tool_provider_family(payload);
    let enable_qwen_specific_harvest = provider_family == TextToolProviderFamily::Qwen;
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
                let xml_tool_calls =
                    extract_xml_tool_call_blocks(&candidate_text, (harvested as usize) + 1);
                if !xml_tool_calls.is_empty() {
                    recovered = xml_tool_calls;
                    break;
                }
                let xml_named_tool_calls =
                    extract_xml_named_tool_call_blocks(&candidate_text, (harvested as usize) + 1);
                if !xml_named_tool_calls.is_empty() {
                    recovered = xml_named_tool_calls;
                    break;
                }
                let label_tool_calls =
                    extract_tool_argument_label_blocks(&candidate_text, (harvested as usize) + 1);
                if !label_tool_calls.is_empty() {
                    recovered = label_tool_calls;
                    break;
                }
                let allowlisted_calling_blocks = extract_allowlisted_calling_label_blocks(
                    &candidate_text,
                    &requested_tool_name_keys,
                    (harvested as usize) + 1,
                );
                if !allowlisted_calling_blocks.is_empty() {
                    recovered = allowlisted_calling_blocks;
                    break;
                }
                if enable_qwen_specific_harvest {
                    let function_style_calls = extract_allowlisted_function_style_calls(
                        &candidate_text,
                        &requested_tool_name_keys,
                        (harvested as usize) + 1,
                    );
                    if !function_style_calls.is_empty() {
                        recovered = function_style_calls;
                        break;
                    }
                    let qwen_markers = extract_tool_calls_from_qwen_markers(
                        &candidate_text,
                        (harvested as usize) + 1,
                    );
                    if !qwen_markers.is_empty() {
                        recovered = qwen_markers;
                        break;
                    }
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
                    if requested_tool_name_keys.contains("apply_patch")
                        && candidate_text.contains("*** Begin Patch")
                    {
                        let patch_entry = json!({
                            "name": "apply_patch",
                            "input": {
                                "patch": candidate_text
                            }
                        });
                        if let Some(normalized_patch) = normalize_tool_call_entry(
                            &patch_entry,
                            (harvested as usize) + 1,
                        ) {
                            recovered = vec![normalized_patch];
                            break;
                        }
                    }
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

        let _dropped = retain_allowed_tool_calls(&mut recovered, &requested_tool_name_keys);
        if recovered.is_empty() {
            continue;
        }

        harvested += recovered.len() as i64;
        message.insert("tool_calls".to_string(), Value::Array(recovered));
        sanitize_textual_marker_field_in_message(message, "content");
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
    harvest_text_tool_calls_from_payload(payload)
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
    let mut payload = input.payload.clone();
    let text_harvest_enabled = resolve_text_harvest_enabled(&payload);

    let harvested = if text_harvest_enabled {
        maybe_harvest_empty_tool_calls_from_json_content(&mut payload)
    } else {
        0
    };
    let thinking_reasoning_normalized = normalize_thinking_only_reasoning_content(&mut payload);
    let sanitized_tool_markup = sanitize_payload_tool_markup_fields(&mut payload);
    strip_orphan_function_calls_tag(&mut payload);

    let apply_patch_repaired = normalize_apply_patch_tool_calls(&mut payload);
    let disallowed_tool_calls_dropped = drop_disallowed_tool_calls_from_payload(&mut payload);
    remap_tool_calls_for_client_protocol(&mut payload, &input.client_protocol);
    strip_internal_tool_governance_state(&mut payload);
    let tool_calls_normalized = count_normalized_tool_calls(&payload);

    let applied = harvested > 0
        || thinking_reasoning_normalized > 0
        || sanitized_tool_markup > 0
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
        assert!(
            prepared.prepared_payload["choices"][0]["message"]
                .get("content")
                .is_none()
                || prepared.prepared_payload["choices"][0]["message"]["content"]
                    .as_str()
                    .map(|value| value.is_empty())
                    .unwrap_or(false)
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
        assert_eq!(
            governed.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert!(
            governed.governed_payload["choices"][0]["message"]
                .get("content")
                .is_none()
                || governed.governed_payload["choices"][0]["message"]["content"]
                    .as_str()
                    .map(|value| value.is_empty())
                    .unwrap_or(false)
        );
    }

    #[test]
    fn test_prepare_payload_for_governance_harvests_function_style_apply_patch_from_responses() {
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
        assert_eq!(prepared.summary.harvested_tool_calls, 1);
        let args = prepared.prepared_payload["choices"][0]["message"]["tool_calls"][0]["function"]
            ["arguments"]
            .as_str()
            .unwrap();
        let args_json: Value = serde_json::from_str(args).unwrap();
        let patch = args_json["patch"].as_str().unwrap();
        assert!(patch.contains("*** Add File: hello.txt"));
        assert!(patch.contains("+hello"));
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
    fn test_qwen_marker_unknown_tool_skips() {
        let text = "<|tool_call_begin|>unknown<|tool_call_argument_begin|>{\"command\":\"pwd\"}<|tool_call_end|>";
        let out = extract_tool_calls_from_qwen_markers(text, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "unknown");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args["command"], "pwd");
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
        assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");

        let args_str = message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap();
        let args_json: Value = serde_json::from_str(args_str).unwrap();
        assert_eq!(args_json["cmd"], "pwd");
        assert!(args_json.get("command").is_none());
        assert!(args_json.get("cwd").is_none());
        assert_eq!(args_json["workdir"], "/tmp");
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
    fn test_harvest_qwen_markers_from_anthropic_thinking_block_shape() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": [
                            {
                                "type": "thinking",
                                "thinking": "<|tool_calls_section_begin|>\n<|tool_call_begin|> functions.exec_command:13 <|tool_call_argument_begin|> {\"cmd\":\"pwd\",\"workdir\":\"/tmp\"} <|tool_call_end|>\n<|tool_calls_section_end|>"
                            }
                        ]
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "anthropic-messages".to_string(),
            entry_endpoint: "/v1/messages".to_string(),
            request_id: "req_qwen_marker_anthropic_thinking_1".to_string(),
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
        assert!(message.get("reasoning_content").is_none());
    }

    #[test]
    fn test_harvest_qwen_markers_strips_marker_payload_from_reasoning_fields() {
        let marker_text = "<|tool_calls_section_begin|><|tool_call_begin|>functions.exec_command:3<|tool_call_argument_begin|>{\"cmd\":\"pwd\"}<|tool_call_end|><|tool_calls_section_end|>";
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": marker_text,
                        "reasoning_content": marker_text,
                        "reasoning": {
                            "content": [{
                                "type": "reasoning_text",
                                "text": marker_text
                            }]
                        }
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_qwen_marker_strip_reasoning_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert!(message.get("reasoning_content").is_none());
        let reasoning_text = message
            .get("reasoning")
            .and_then(|v| v.get("content"))
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(|v| v.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(!reasoning_text.contains("<|tool_calls_section_begin|>"));
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
        assert_eq!(content, "先分析。");
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
        assert!(parsed.get("command").is_none());
        assert_eq!(parsed["workdir"], "/tmp");

        let raw_args = json!({"command": "bash-lc 'pwd'"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["cmd"], "bash -lc 'pwd'");

        let raw_args = json!({"command": "bash -lc 'which memsearch && memsearch --help 2>&1 | head -20 || echo \"memsearch not found\""});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["cmd"],
            "bash -lc 'which memsearch && memsearch --help 2>&1 | head -20 || echo \"memsearch not found\"'"
        );

        let raw_args = json!({"command": "bash -lc\"cd /Volumes/extension/code/finger && memsearch index MEMORY.md memory/ --force 2>&1\""});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["cmd"],
            "bash -lc \"cd /Volumes/extension/code/finger && memsearch index MEMORY.md memory/ --force 2>&1\""
        );

        let raw_args = json!({"command": "bash -lc'cd /Volumes/extension/code/finger && pwd'"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["cmd"],
            "bash -lc 'cd /Volumes/extension/code/finger && pwd'"
        );

        let raw_args = json!({"command": "bash -lc 'printf 'oops'"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["cmd"], "bash -lc 'printf 'oops'");

        let raw_args = json!({"command": "cd /Volumes/extension/code/finger && python3 << 'PYEOF'\nwith open\\('src/blocks/agent-runtime-block/index.ts', 'r'\\) as f:\n    content = f.read\\(\\)\nPYEOF"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["cmd"],
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
    fn test_normalize_tool_args_preserving_raw_shape_does_not_guess_exec_command_aliases() {
        let raw_args = json!({"command": "pwd", "workdir": "/workspace"});
        let out = normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["command"], "pwd");
        assert_eq!(parsed["workdir"], "/workspace");
        assert!(parsed.get("cmd").is_none());

        let raw_args = Value::String("{\"command\":\"pwd\"}".to_string());
        let out = normalize_tool_args_preserving_raw_shape("shell_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["command"], "pwd");
        assert!(parsed.get("cmd").is_none());
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
        let out = normalize_tool_call_entry(&entry, 1).unwrap();
        assert_eq!(out["function"]["name"], "unknown_tool");
        let args = out["function"]["arguments"].as_str().unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        assert_eq!(args_json, json!({}));

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
    fn test_strip_python_heredoc_pseudo_escapes_only_for_python_like_commands() {
        let repaired = strip_python_heredoc_pseudo_escapes(
            "python3 << 'PYEOF'\nwith open\\('a.py', 'r'\\) as f:\n    print\\(f.read\\(\\)\\)\nPYEOF",
        );
        assert!(repaired.contains("with open('a.py', 'r') as f:"));
        assert!(repaired.contains("print(f.read())"));

        let untouched = strip_python_heredoc_pseudo_escapes(
            "grep -E \"foo\\(bar\\)\" src/file.ts",
        );
        assert_eq!(untouched, "grep -E \"foo\\(bar\\)\" src/file.ts");
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
        assert_eq!(parsed["cmd"], "pwd");
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
        assert_eq!(parsed["cmd"], "ls -la");
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
        assert_eq!(parsed["cmd"], "pwd");
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
        let out = normalize_tool_call_entry(&entry, 1).unwrap();
        assert_eq!(out["function"]["arguments"], "{}");

        let entry = Value::String("not an object".to_string());
        assert!(normalize_tool_call_entry(&entry, 1).is_none());
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
            args["cmd"],
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
        assert_eq!(args["cmd"], "pwd");
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
            args["cmd"],
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
            args["cmd"],
            r#"cd /Volumes/extension/code/finger && grep -n "resolveTargetModule\|moduleLookup" src/blocks/agent-runtime-block/index.ts | head -30"#
        );
        assert_eq!(args["workdir"], "/Volumes/extension/code/finger");
        assert_eq!(args["yield_time_ms"], 30000);
    }

    #[test]
    fn test_extract_xml_named_tool_call_blocks_invoke_parameter_attribute_wrapper_inside_tool_calls() {
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
    fn test_harvest_tool_calls_from_generic_command_wrappers() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": r#"根据你的描述，system agent 重启后无法向 project agent 派发任务。
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && grep -n "agentRegistry\|registerAgent\|getAgent" src/orchestration/message-hub.ts | head -30
  </grep_command>
</command>
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && ls -la src/agents/finger-system-agent/registry.ts
  </grep_command>
</command>"#
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_generic_command_wrapper_harvest_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 2);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
        assert_eq!(message["tool_calls"][1]["function"]["name"], "exec_command");
        let args0: Value = serde_json::from_str(
            message["tool_calls"][0]["function"]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        let args1: Value = serde_json::from_str(
            message["tool_calls"][1]["function"]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        assert_eq!(
            args0["cmd"],
            r#"cd /Volumes/extension/code/finger && grep -n "agentRegistry\|registerAgent\|getAgent" src/orchestration/message-hub.ts | head -30"#
        );
        assert_eq!(
            args1["cmd"],
            "cd /Volumes/extension/code/finger && ls -la src/agents/finger-system-agent/registry.ts"
        );
        let content = message["content"].as_str().unwrap_or("");
        assert!(content.contains("system agent 重启后无法向 project agent 派发任务"));
        assert!(!content.contains("<command>"));
        assert!(!content.contains("<grep_command>"));
    }

    #[test]
    fn test_extract_allowlisted_function_style_calls_exec_command() {
        let requested = HashSet::from(["exec_command".to_string()]);
        let out = extract_allowlisted_function_style_calls(
            r#"exec_command(cmd="bash -lc'pwd'")"#,
            &requested,
            1,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args["cmd"], "bash -lc 'pwd'");
    }

    #[test]
    fn test_extract_allowlisted_function_style_calls_tool_prefixed_exec_command() {
        let requested = HashSet::from(["exec_command".to_string()]);
        let out = extract_allowlisted_function_style_calls(
            r#"```toolexec_command(command="head -n3 docs/ARCHITECTURE.md")```"#,
            &requested,
            1,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args["cmd"], "head -n3 docs/ARCHITECTURE.md");
    }

    #[test]
    fn test_extract_allowlisted_function_style_calls_apply_patch_without_requested_tools() {
        let requested = HashSet::new();
        let out = extract_allowlisted_function_style_calls(
            r#"apply_patch(path="hello.txt", content="hello")"#,
            &requested,
            1,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "apply_patch");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        let patch = args["patch"].as_str().unwrap_or("");
        assert!(patch.contains("*** Add File: hello.txt"));
        assert!(patch.contains("+hello"));
    }

    #[test]
    fn test_harvest_tool_calls_from_allowlisted_function_style_blocks() {
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
        assert_eq!(args["cmd"], "bash -lc 'pwd'");
    }

    #[test]
    fn test_harvest_tool_calls_from_tool_prefixed_function_style_blocks() {
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
        assert_eq!(args["cmd"], "head -n3 docs/ARCHITECTURE.md");
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
    fn test_harvest_tool_calls_from_real_failed_command_wrapper_batch() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": r#"根据你的描述，system agent 重启后无法向 project agent 派发任务，问题出在 agent 注册表在重启后未重建。
让我定位具体代码：
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && grep -n "agentRegistry\|registerAgent\|getAgent" src/orchestration/message-hub.ts | head -30
  </grep_command>
</command>
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && grep -n "resolveTargetModule\|moduleLookup" src/blocks/agent-runtime-block/index.ts | head -30
  </grep_command>
</command>
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && ls -la src/agents/finger-system-agent/registry.ts
  </grep_command>
</command>"#
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_real_failed_command_wrapper_batch_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 3);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        let tool_calls = message["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 3);
        for entry in &tool_calls {
            assert_eq!(entry["function"]["name"], "exec_command");
        }
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
        let args2: Value = serde_json::from_str(
            tool_calls[2]["function"]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        assert_eq!(
            args0["cmd"],
            r#"cd /Volumes/extension/code/finger && grep -n "agentRegistry\|registerAgent\|getAgent" src/orchestration/message-hub.ts | head -30"#
        );
        assert_eq!(
            args1["cmd"],
            r#"cd /Volumes/extension/code/finger && grep -n "resolveTargetModule\|moduleLookup" src/blocks/agent-runtime-block/index.ts | head -30"#
        );
        assert_eq!(
            args2["cmd"],
            "cd /Volumes/extension/code/finger && ls -la src/agents/finger-system-agent/registry.ts"
        );
        let content = message["content"].as_str().unwrap_or("");
        assert!(content.contains("system agent 重启后无法向 project agent 派发任务"));
        assert!(content.contains("让我定位具体代码"));
        assert!(!content.contains("<command>"));
        assert!(!content.contains("<grep_command>"));
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
    fn test_extract_tool_argument_label_blocks_exec_command() {
        let text = r#"
我来进行一次系统的 project 管理审计。
Tool: exec_command
Arguments: {"cmd":"find /workspace -maxdepth 1","workdir":"/workspace"}

Tool: functions.exec_command
Arguments:
{"cmd":"git status","workdir":"/workspace"}
"#;
        let out = extract_tool_argument_label_blocks(text, 1);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args0: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args0["cmd"], "find /workspace -maxdepth 1");
        assert_eq!(args0["workdir"], "/workspace");
        assert_eq!(out[1]["function"]["name"], "exec_command");
        let args1: Value =
            serde_json::from_str(out[1]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        assert_eq!(args1["cmd"], "git status");
        assert_eq!(args1["workdir"], "/workspace");
    }

    #[test]
    fn test_extract_allowlisted_calling_label_blocks_exec_command() {
        let text = r#"
我来审计自动压缩功能。
**Calling:** `exec_command`
```json
{"cmd":"bash -lc 'cd /Volumes/extension/code/finger && find . -type f -name \"*.ts\" | xargs grep -l \"compress|compression\" 2>/dev/null | head -20'","max_output_tokens":2000}
```
"#;
        let requested = HashSet::from([String::from("exec_command")]);
        let out = extract_allowlisted_calling_label_blocks(text, &requested, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
        let args: Value =
            serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
                .unwrap_or(Value::Null);
        let cmd = args["cmd"].as_str().unwrap_or("");
        assert!(cmd.contains("bash -lc"));
        assert!(cmd.contains("find . -type f -name"));
        assert!(cmd.contains("compress|compression"));
        assert_eq!(args["max_output_tokens"], 2000);
    }

    #[test]
    fn test_harvest_tool_calls_from_tool_argument_label_blocks() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "我将通过分析实际代码来回答你的问题。\n\nTool: exec_command\nArguments: {\"cmd\":\"find /Volumes/extension/code/finger -name \\\"project\\\" -type f\",\"workdir\":\"/Volumes/extension/code/finger\"}"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_tool_label_harvest_1".to_string(),
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
            "find /Volumes/extension/code/finger -name \"project\" -type f"
        );
        assert_eq!(args["workdir"], "/Volumes/extension/code/finger");
    }

    #[test]
    fn test_harvest_tool_calls_from_allowlisted_calling_blocks() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "__rcc_tool_governance": {
                    "requestedToolNames": ["exec_command"]
                },
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "我来审计自动压缩功能。\\nCalling: exec_command\\n```json\\n{\"cmd\":\"bash -lc 'cd /Volumes/extension/code/finger && find . -type f -name \\\"*.ts\\\" | xargs grep -l \\\"compress|compression\\\" 2>/dev/null | head -20'\",\"max_output_tokens\":2000}\\n```"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_allowlisted_calling_harvest_1".to_string(),
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
        let cmd = args["cmd"].as_str().unwrap_or("");
        assert!(cmd.contains("bash -lc"));
        assert!(cmd.contains("find . -type f -name"));
        assert!(cmd.contains("compress|compression"));
        assert_eq!(args["max_output_tokens"], 2000);
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
            args["cmd"],
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
        assert!(variants
            .iter()
            .any(|item| item.contains("\"tool_calls\"") && !item.contains("<<RCC_TOOL_CALLS_JSON")));
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
                    "content": "• {\"tool_calls\":[{\"name\":\"apply_patch\",\"input\":{\"patch\":\"*** Begin Patch\\n*** Add File: demo.txt\\n+hi\\n*** End Patch\"}}]}"
                },
                "finish_reason": "stop"
            }]
        });
        assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 1);
        assert_eq!(
            payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "apply_patch"
        );
        let args: Value = serde_json::from_str(
            payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
                .as_str()
                .unwrap_or("{}"),
        )
        .unwrap_or(Value::Null);
        assert!(args["patch"]
            .as_str()
            .unwrap_or("")
            .contains("*** Begin Patch"));
        assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");
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
    fn test_govern_response_keeps_wrapper_only_content_when_no_tool_calls_recovered() {
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
        let content = result.governed_payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");
        assert!(content.contains("\"mailbox.status\""));
        assert!(content.contains("<function_calls>"));
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
        assert_eq!(
            strip_xml_tags_preserve_text(raw),
            "第一行\n\n第二行 query"
        );
    }

    #[test]
    fn test_sanitize_textual_marker_field_preserves_inner_text_when_wrapper_only_content_would_empty() {
        let mut message = serde_json::json!({
            "content": "<function_calls>保留内部文本</function_calls>"
        })
        .as_object()
        .cloned()
        .unwrap();
        assert!(sanitize_textual_marker_field_in_message(&mut message, "content"));
        assert_eq!(message["content"], "保留内部文本");
    }

    #[test]
    fn test_sanitize_textual_marker_field_preserves_trailing_text_when_rcc_wrapper_starts_first() {
        let mut message = serde_json::json!({
            "content": "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\"}}]}\nRCC_TOOL_CALLS_JSON\n保留正文"
        })
        .as_object()
        .cloned()
        .unwrap();
        assert!(sanitize_textual_marker_field_in_message(&mut message, "content"));
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
        assert!(!sanitize_textual_marker_field_in_message(&mut message, "content"));
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
        assert!(!sanitize_textual_marker_field_in_message(&mut message, "content"));
        assert_eq!(message["content"], raw);
    }

    #[test]
    fn test_govern_response_keeps_malformed_rcc_wrapper_when_name_missing() {
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

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.tool_calls_normalized, 0);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "stop"
        );
        assert_eq!(
            result.governed_payload["choices"][0]["message"]["content"],
            raw
        );
    }

    #[test]
    fn test_govern_response_keeps_malformed_rcc_wrapper_multiline_whitespace_when_name_missing() {
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

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.tool_calls_normalized, 0);
        assert_eq!(
            result.governed_payload["choices"][0]["message"]["content"],
            raw
        );
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
