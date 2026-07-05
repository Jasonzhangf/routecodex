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

fn strip_xml_like_tags(raw: &str) -> String {
    Regex::new(r"(?is)<[^>]+>")
        .ok()
        .map(|re| re.replace_all(raw, "").to_string())
        .unwrap_or_else(|| raw.to_string())
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
    if let Ok(re) = Regex::new(
        r#""[^"]*?</?\s*arg_value\s*>[^"]*?</?\s*arg_value\s*>\s*</?\s*arg_key\s*>\s*([A-Za-z_][A-Za-z0-9_-]*)\s*":"#,
    ) {
        out = re.replace_all(out.as_str(), r#""$1":"#).to_string();
    }
    if let Ok(re) = Regex::new(r#""([^"]+?)\s*</?\s*arg_key\s*>\s*</?\s*arg_value\s*>([^"]*?)""#) {
        out = re.replace_all(out.as_str(), r#""$1":"$2""#).to_string();
    }
    strip_arg_key_artifacts(out.as_str())
}

fn normalize_arg_artifact_object_key(raw_key: &str) -> String {
    if raw_key.contains("<arg_key") || raw_key.contains("</arg_key") {
        if let Ok(re) = Regex::new(r"(?is)</?\s*arg_key\s*>\s*([A-Za-z_][A-Za-z0-9_-]*)\s*$") {
            if let Some(caps) = re.captures(raw_key) {
                if let Some(key) = caps.get(1) {
                    return key.as_str().trim().to_string();
                }
            }
        }
    }
    let stripped = strip_xml_like_tags(strip_arg_key_artifacts(raw_key).as_str());
    let cleaned = stripped.trim();
    if cleaned.is_empty() {
        raw_key.to_string()
    } else {
        cleaned.to_string()
    }
}

fn coerce_arg_artifact_primitive(raw: &str) -> Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Value::String(String::new());
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        _ => {}
    }
    if let Ok(number) = trimmed.parse::<i64>() {
        return Value::Number(number.into());
    }
    if let Ok(number) = trimmed.parse::<f64>() {
        if let Some(value) = serde_json::Number::from_f64(number) {
            return Value::Number(value);
        }
    }
    if (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
    {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            return parsed;
        }
    }
    Value::String(trimmed.to_string())
}

fn looks_like_arg_artifact_key(raw: &str) -> bool {
    Regex::new(r"^[A-Za-z_][A-Za-z0-9_-]*$")
        .ok()
        .map(|re| re.is_match(raw.trim()))
        .unwrap_or(false)
}

fn extract_injected_arg_pairs(raw: &str) -> Option<(String, Vec<(String, Value)>)> {
    let delimiter = "</arg_key><arg_value>";
    if !raw.contains(delimiter) {
        return None;
    }
    let parts: Vec<&str> = raw.split(delimiter).collect();
    if parts.len() < 2 {
        return None;
    }

    let mut pairs: Vec<(String, Value)> = Vec::new();
    let mut base_value = parts.first().copied().unwrap_or_default().to_string();

    if parts.len() == 2 {
        let key = parts.first().copied().unwrap_or_default().trim();
        let value = parts.get(1).copied().unwrap_or_default().trim();
        if looks_like_arg_artifact_key(key) && !value.is_empty() {
            base_value.clear();
            pairs.push((key.to_string(), coerce_arg_artifact_primitive(value)));
        }
        return (!pairs.is_empty()).then_some((base_value, pairs));
    }

    let mut index = 1usize;
    while index + 1 < parts.len() {
        let key = parts.get(index).copied().unwrap_or_default().trim();
        let value = parts.get(index + 1).copied().unwrap_or_default().trim();
        if looks_like_arg_artifact_key(key) && !value.is_empty() {
            pairs.push((key.to_string(), coerce_arg_artifact_primitive(value)));
        }
        index += 2;
    }

    (!pairs.is_empty()).then_some((base_value, pairs))
}

fn repair_arg_key_artifacts_in_value(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                repair_arg_key_artifacts_in_value(item);
            }
        }
        Value::Object(obj) => {
            let keys: Vec<String> = obj.keys().cloned().collect();
            for key in keys {
                let normalized = normalize_arg_artifact_object_key(&key);
                if normalized != key && !normalized.trim().is_empty() {
                    if !obj.contains_key(&normalized) {
                        if let Some(value) = obj.get(&key).cloned() {
                            obj.insert(normalized, value);
                        }
                    }
                    obj.remove(&key);
                }
            }

            let keys: Vec<String> = obj.keys().cloned().collect();
            for key in keys {
                let injected = obj
                    .get(&key)
                    .and_then(Value::as_str)
                    .and_then(extract_injected_arg_pairs);
                if let Some((base_value, pairs)) = injected {
                    if !base_value.is_empty() {
                        obj.insert(key.clone(), Value::String(base_value));
                    }
                    for (pair_key, pair_value) in pairs {
                        obj.entry(pair_key).or_insert(pair_value);
                    }
                }
                if let Some(next) = obj.get_mut(&key) {
                    repair_arg_key_artifacts_in_value(next);
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn parse_tool_args_json_with_artifact_repair(input: &Value) -> Value {
    let raw = input.as_str().unwrap_or_default();
    if raw.trim().is_empty() {
        return Value::Object(Map::new());
    }
    let mut parsed = try_parse_json_value_lenient(raw).unwrap_or_else(|| Value::Object(Map::new()));
    repair_arg_key_artifacts_in_value(&mut parsed);
    parsed
}

pub(crate) fn parse_tool_args_json_with_artifact_repair_json(
    input_json: String,
) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, e.to_string()))?;
    serde_json::to_string(&parse_tool_args_json_with_artifact_repair(&input))
        .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
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
