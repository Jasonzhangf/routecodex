use napi::bindgen_prelude::Result as NapiResult;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};

fn read_string_value(value: &Value) -> String {
    value.as_str().unwrap_or("").to_string()
}

fn parse_lenient_string(value: &str) -> Value {
    let s0 = value.trim();
    if s0.is_empty() {
        return Value::Object(Map::new());
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(s0) {
        return parsed;
    }

    let fence_pattern =
        Regex::new(r"(?is)```(?:json)?\s*([\s\S]*?)\s*```").expect("valid fence pattern");
    let candidate = fence_pattern
        .captures(s0)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().trim().to_string()))
        .unwrap_or_else(|| s0.to_string());

    let object_pattern = Regex::new(r"(?s)\{[\s\S]*\}").expect("valid object pattern");
    if let Some(matched) = object_pattern.find(candidate.as_str()) {
        if let Ok(parsed) = serde_json::from_str::<Value>(matched.as_str()) {
            return parsed;
        }
    }

    let array_pattern = Regex::new(r"(?s)\[[\s\S]*\]").expect("valid array pattern");
    if let Some(matched) = array_pattern.find(candidate.as_str()) {
        if let Ok(parsed) = serde_json::from_str::<Value>(matched.as_str()) {
            return parsed;
        }
    }

    let single_quote_pattern =
        Regex::new(r#"'([^'\\]*(?:\\.[^'\\]*)*)'"#).expect("valid single quote pattern");
    let unquoted_key_pattern =
        Regex::new(r#"([{,\s])([A-Za-z_][A-Za-z0-9_-]*)\s*:"#).expect("valid key quote pattern");
    let quoted = single_quote_pattern
        .replace_all(candidate.as_str(), r#"\"$1\""#)
        .to_string();
    let normalized = unquoted_key_pattern
        .replace_all(quoted.as_str(), r#"$1\"$2\":"#)
        .to_string();
    if let Ok(parsed) = serde_json::from_str::<Value>(normalized.as_str()) {
        return parsed;
    }

    let mut object = Map::new();
    let split_pattern = Regex::new(r"[\n,]+").expect("valid split pattern");
    let pair_pattern =
        Regex::new(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(.+)$").expect("valid pair pattern");
    for piece in split_pattern
        .split(candidate.as_str())
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
    {
        let Some(caps) = pair_pattern.captures(piece) else {
            continue;
        };
        let key = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        let mut raw_value = caps
            .get(2)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if raw_value.is_empty() {
            continue;
        }
        let quoted = (raw_value.starts_with('"') && raw_value.ends_with('"'))
            || (raw_value.starts_with('\'') && raw_value.ends_with('\''));
        if quoted && raw_value.len() >= 2 {
            raw_value = raw_value[1..raw_value.len() - 1].to_string();
        }

        let parsed_value = match serde_json::from_str::<Value>(raw_value.as_str()) {
            Ok(value) => value,
            Err(_) => {
                if raw_value.eq_ignore_ascii_case("true") {
                    Value::Bool(true)
                } else if raw_value.eq_ignore_ascii_case("false") {
                    Value::Bool(false)
                } else if raw_value.eq_ignore_ascii_case("null") {
                    Value::Null
                } else {
                    Value::String(raw_value.clone())
                }
            }
        };
        object.insert(key.to_string(), parsed_value);
    }

    Value::Object(object)
}

fn to_string_array(value: &Value) -> Vec<String> {
    match value {
        Value::Array(entries) => entries
            .iter()
            .map(|entry| match entry {
                Value::String(v) => v.trim().to_string(),
                Value::Null => String::new(),
                other => other.to_string().trim().to_string(),
            })
            .filter(|token| !token.is_empty())
            .collect(),
        Value::String(v) => {
            let trimmed = v.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed.to_string()]
            }
        }
        _ => Vec::new(),
    }
}

fn split_command_string_impl(input: &str) -> Vec<String> {
    let s = input.trim();
    if s.is_empty() {
        return Vec::new();
    }

    if s.starts_with('{') || s.starts_with('[') {
        let parsed = parse_lenient_string(s);
        if let Some(cmd_value) = parsed.get("command") {
            if let Value::Array(arr) = cmd_value {
                let tokens: Vec<String> = arr
                    .iter()
                    .filter_map(|entry| match entry {
                        Value::String(v) => Some(v.trim().to_string()),
                        Value::Null => None,
                        other => Some(other.to_string().trim().to_string()),
                    })
                    .filter(|token| !token.is_empty())
                    .collect();
                if !tokens.is_empty() {
                    return tokens;
                }
            }
        }
    }

    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if in_single {
            if ch == '\'' {
                in_single = false;
            } else {
                cur.push(ch);
            }
            i += 1;
            continue;
        }
        if in_double {
            if ch == '"' {
                in_double = false;
            } else if ch == '\\' && i + 1 < chars.len() {
                i += 1;
                cur.push(chars[i]);
            } else {
                cur.push(ch);
            }
            i += 1;
            continue;
        }
        if ch == '\'' {
            in_single = true;
            i += 1;
            continue;
        }
        if ch == '"' {
            in_double = true;
            i += 1;
            continue;
        }
        if ch.is_whitespace() {
            if !cur.is_empty() {
                out.push(cur.clone());
                cur.clear();
            }
            i += 1;
            continue;
        }
        cur.push(ch);
        i += 1;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn escape_unescaped_parens(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev_backslash = false;
    for ch in input.chars() {
        if (ch == '(' || ch == ')') && !prev_backslash {
            out.push('\\');
            out.push(ch);
        } else {
            out.push(ch);
        }
        prev_backslash = ch == '\\';
    }
    out
}

fn repair_find_meta_impl(script: &str) -> String {
    let s = script.to_string();
    if s.is_empty() {
        return s;
    }
    let has_find = Regex::new(r"(^|\s)find\s").unwrap().is_match(s.as_str());
    if !has_find {
        return s;
    }
    let exec_re = Regex::new(r"-exec([^;]*?)(?:\\*);").unwrap();
    let mut out = exec_re.replace_all(s.as_str(), "-exec$1 \\\\;").to_string();
    out = escape_unescaped_parens(out.as_str());
    out
}

fn pack_shell_args_impl(input: &Value) -> Value {
    let mut out = match input.as_object() {
        Some(obj) => obj.clone(),
        None => Map::new(),
    };
    let cmd_raw = out.get("command").cloned().unwrap_or(Value::Null);
    let workdir = out
        .get("workdir")
        .and_then(Value::as_str)
        .map(|v| v.to_string());

    if let Value::String(cmd_text) = cmd_raw {
        let tokens = split_command_string_impl(cmd_text.as_str());
        if tokens.len() >= 2 && tokens[0] == "cd" && !tokens[1].is_empty() {
            let dir = tokens[1].clone();
            let mut rest: Vec<String> = tokens[2..].to_vec();
            if let Some(first) = rest.first() {
                if first == "&&" || first == ";" {
                    rest = rest[1..].to_vec();
                }
            }
            if workdir.as_ref().map(|v| v.is_empty()).unwrap_or(true) {
                out.insert("workdir".to_string(), Value::String(dir));
            }
            if rest.is_empty() {
                rest.push("pwd".to_string());
            }
            out.insert(
                "command".to_string(),
                Value::Array(rest.into_iter().map(Value::String).collect()),
            );
            return Value::Object(out);
        }
        let tokens = if tokens.is_empty() {
            vec!["pwd".to_string()]
        } else {
            tokens
        };
        if let Some(wd) = workdir.clone() {
            if !wd.is_empty() {
                out.insert("workdir".to_string(), Value::String(wd));
            }
        }
        out.insert(
            "command".to_string(),
            Value::Array(tokens.into_iter().map(Value::String).collect()),
        );
        return Value::Object(out);
    }

    let mut tokens = to_string_array(&cmd_raw);
    if tokens.is_empty() {
        tokens.push("pwd".to_string());
    }
    if tokens.len() >= 2 && tokens[0] == "cd" && !tokens[1].is_empty() {
        let dir = tokens[1].clone();
        let rest: Vec<String> = if tokens.len() > 2 {
            tokens[2..].to_vec()
        } else {
            vec!["pwd".to_string()]
        };
        if workdir.as_ref().map(|v| v.is_empty()).unwrap_or(true) {
            out.insert("workdir".to_string(), Value::String(dir));
        }
        out.insert(
            "command".to_string(),
            Value::Array(rest.into_iter().map(Value::String).collect()),
        );
        return Value::Object(out);
    }
    if let Some(wd) = workdir {
        if !wd.is_empty() {
            out.insert("workdir".to_string(), Value::String(wd));
        }
    }
    out.insert(
        "command".to_string(),
        Value::Array(tokens.into_iter().map(Value::String).collect()),
    );
    Value::Object(out)
}

fn flatten_by_comma_impl(items: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let text = match item {
            Value::String(v) => v.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        for part in text.split(',') {
            let trimmed = part.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_string());
            }
        }
    }
    out
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunkStringInput {
    s: Option<String>,
    min_parts: Option<usize>,
    max_parts: Option<usize>,
    target_chunk: Option<usize>,
}

fn chunk_string_impl(
    s: &str,
    min_parts: usize,
    max_parts: usize,
    target_chunk: usize,
) -> Vec<String> {
    if s.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = s.chars().collect();
    let len = chars.len();
    if len == 0 {
        return Vec::new();
    }
    let target = if target_chunk == 0 { 1 } else { target_chunk } as f64;
    let mut parts = (len as f64 / target).ceil() as usize;
    let min_p = min_parts.max(1);
    let max_p = max_parts.max(min_p);
    if parts < min_p {
        parts = min_p;
    }
    if parts > max_p {
        parts = max_p;
    }
    let step = ((len as f64) / (parts as f64)).ceil() as usize;
    let step = step.max(1);
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < len {
        let end = std::cmp::min(len, i + step);
        let chunk: String = chars[i..end].iter().collect();
        out.push(chunk);
        i = end;
    }
    out
}

#[napi_derive::napi]
pub fn repair_find_meta_json(input_json: String) -> NapiResult<String> {
    let value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let script = value
        .as_str()
        .or_else(|| value.get("script").and_then(Value::as_str))
        .unwrap_or("");
    let repaired = repair_find_meta_impl(script);
    serde_json::to_string(&Value::String(repaired))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn split_command_string_json(input_json: String) -> NapiResult<String> {
    let value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let input = value
        .as_str()
        .or_else(|| value.get("input").and_then(Value::as_str))
        .unwrap_or("");
    let tokens = split_command_string_impl(input);
    let output = Value::Array(tokens.into_iter().map(Value::String).collect());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn pack_shell_args_json(input_json: String) -> NapiResult<String> {
    let value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = pack_shell_args_impl(&value);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn flatten_by_comma_json(input_json: String) -> NapiResult<String> {
    let value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let items = value.as_array().cloned().unwrap_or_default();
    let output = flatten_by_comma_impl(&items);
    let output = Value::Array(output.into_iter().map(Value::String).collect());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn chunk_string_json(input_json: String) -> NapiResult<String> {
    let value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let input: ChunkStringInput =
        serde_json::from_value(value).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let s = input.s.unwrap_or_default();
    let min_parts = input.min_parts.unwrap_or(3);
    let max_parts = input.max_parts.unwrap_or(12);
    let target_chunk = input.target_chunk.unwrap_or(12);
    let output = chunk_string_impl(s.as_str(), min_parts, max_parts, target_chunk);
    let output = Value::Array(output.into_iter().map(Value::String).collect());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests;
