use regex::Regex;
use serde_json::{Map, Value};

pub(crate) fn read_string_array_command(value: Option<&Value>) -> Option<String> {
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

fn strip_arg_key_artifacts(raw: &str) -> String {
    let mut out = raw.to_string();
    let patterns = [
        r"(?is)</?\s*tool_call[^>]*>",
        r"(?is)</?\s*arg_key\s*>",
        r"(?is)</?\s*arg_value\s*>",
    ];
    for pattern in patterns {
        if let Ok(re) = Regex::new(pattern) {
            out = re.replace_all(out.as_str(), "").to_string();
        }
    }
    out
}

fn repair_arg_key_artifacts_in_raw_json(raw: &str) -> String {
    let mut out = raw.to_string();
    if !out.contains("<arg_key")
        && !out.contains("<arg_value")
        && !out.contains("</arg_key")
        && !out.contains("</arg_value")
    {
        return out;
    }
    if let Ok(re) = Regex::new(r#""([^"]+?)\s*</?\s*arg_key\s*>\s*</?\s*arg_value\s*>([^"]*?)""#) {
        out = re.replace_all(out.as_str(), r#""$1":"$2""#).to_string();
    }
    strip_arg_key_artifacts(out.as_str())
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
                let is_valid_json_escape =
                    matches!(ch, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u');
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

pub(crate) fn parse_json_record(value: Option<&Value>) -> Option<Map<String, Value>> {
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

pub(crate) fn try_parse_json_value_lenient(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        return Some(parsed);
    }

    let repaired_arg_key = repair_arg_key_artifacts_in_raw_json(trimmed);
    if repaired_arg_key != trimmed {
        if let Ok(parsed) = serde_json::from_str::<Value>(&repaired_arg_key) {
            return Some(parsed);
        }
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
    let escaped_invalid_backslashes = escape_invalid_backslashes_inside_json_strings(trimmed);
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
    candidate = repair_arg_key_artifacts_in_raw_json(candidate.as_str());
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
