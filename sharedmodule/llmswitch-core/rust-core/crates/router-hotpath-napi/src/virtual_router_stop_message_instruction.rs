use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Serialize;

const DEFAULT_STOP_MESSAGE_MAX_REPEATS: i64 = 10;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StopMessageInstructionParseOutput {
    kind: String,
    text: Option<String>,
    max_repeats: Option<i64>,
    ai_mode: Option<String>,
}

fn starts_with_stop_message(instruction: &str) -> Option<usize> {
    let text = instruction;
    let prefix = "stopmessage";
    let head = text.get(..prefix.len())?;
    if !head.eq_ignore_ascii_case(prefix) {
        return None;
    }
    let mut idx = prefix.len();
    let bytes = text.as_bytes();
    while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
        idx += 1;
    }
    if idx >= bytes.len() {
        return None;
    }
    let sep = bytes[idx] as char;
    if sep != ':' && sep != ',' {
        return None;
    }
    Some(idx + 1)
}

fn parse_js_int_prefix(token: &str) -> Option<i64> {
    let raw = token.trim_start();
    if raw.is_empty() {
        return None;
    }
    let mut iter = raw.char_indices();
    let mut sign = 1i64;
    let mut start = 0usize;
    if let Some((idx, ch)) = iter.next() {
        if ch == '+' {
            start = idx + ch.len_utf8();
        } else if ch == '-' {
            start = idx + ch.len_utf8();
            sign = -1;
        }
    }
    let mut end = start;
    for (idx, ch) in raw[start..].char_indices() {
        if ch.is_ascii_digit() {
            end = start + idx + ch.len_utf8();
            continue;
        }
        break;
    }
    if end <= start {
        return None;
    }
    let digits = &raw[start..end];
    let parsed = digits.parse::<i64>().ok()?;
    Some(parsed * sign)
}

fn parse_ai_mode_token(token: &str) -> Option<String> {
    let lower = token.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }
    if let Some(rest) = lower.strip_prefix("mode") {
        let rest = rest.trim_start();
        if let Some(after_auto) = rest.strip_prefix("auto") {
            let after_auto = after_auto.trim_start();
            if let Some(value) = after_auto.strip_prefix('=') {
                let value = value.trim();
                if value == "ai" {
                    return Some("on".to_string());
                }
                if value == "off" {
                    return Some("off".to_string());
                }
            }
        }
    }
    if let Some(rest) = lower.strip_prefix("ai") {
        let rest = rest.trim_start();
        let value = if let Some(v) = rest.strip_prefix(':') {
            v.trim()
        } else if let Some(v) = rest.strip_prefix('=') {
            v.trim()
        } else {
            ""
        };
        if value == "on" || value == "off" {
            return Some(value.to_string());
        }
    }
    None
}

fn is_reserved_control_token(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    if lower == "clear" || lower == "on" || lower == "off" {
        return true;
    }
    parse_ai_mode_token(&lower).is_some()
}

fn parse_stop_message_tail(tokens: &[String]) -> (i64, Option<String>) {
    let mut max_repeats = DEFAULT_STOP_MESSAGE_MAX_REPEATS;
    let mut ai_mode: Option<String> = None;
    for token in tokens {
        if let Some(mode) = parse_ai_mode_token(token) {
            ai_mode = Some(mode);
            continue;
        }
        if let Some(parsed) = parse_js_int_prefix(token) {
            if parsed > 0 {
                max_repeats = parsed;
            }
        }
    }
    (max_repeats, ai_mode)
}

fn parse_quoted_text(cursor: &str) -> Option<(String, Vec<String>)> {
    let chars: Vec<char> = cursor.chars().collect();
    if chars.first().copied() != Some('"') {
        return None;
    }
    let mut escaped = false;
    let mut end_index: Option<usize> = None;
    let mut i = 1usize;
    while i < chars.len() {
        let ch = chars[i];
        if escaped {
            escaped = false;
            i += 1;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            i += 1;
            continue;
        }
        if ch == '"' {
            end_index = Some(i);
            break;
        }
        i += 1;
    }
    let end = end_index?;
    if end == 0 {
        return None;
    }
    let raw_text: String = chars[1..end].iter().collect();
    let mut tail_tokens: Vec<String> = Vec::new();
    let remainder: String = chars[(end + 1)..].iter().collect();
    let trimmed = remainder.trim();
    let tail_raw = trimmed
        .strip_prefix(',')
        .or_else(|| trimmed.strip_prefix(':'));
    if let Some(tail_raw) = tail_raw {
        tail_tokens = tail_raw
            .split(',')
            .map(|part| part.trim().to_string())
            .filter(|part| !part.is_empty())
            .collect();
    }
    Some((raw_text.replace("\\\"", "\""), tail_tokens))
}

fn parse_stop_message_instruction(
    instruction: String,
) -> Option<StopMessageInstructionParseOutput> {
    let body_index = starts_with_stop_message(&instruction)?;
    let body = instruction[body_index..].trim();
    if body.is_empty() {
        return None;
    }
    if body.eq_ignore_ascii_case("clear") {
        return Some(StopMessageInstructionParseOutput {
            kind: "clear".to_string(),
            text: None,
            max_repeats: None,
            ai_mode: None,
        });
    }
    if is_reserved_control_token(body) {
        return None;
    }

    let (text, tail_tokens) = if body.starts_with('"') {
        parse_quoted_text(body)?
    } else {
        let parts: Vec<String> = body
            .split(',')
            .map(|part| part.trim().to_string())
            .filter(|part| !part.is_empty())
            .collect();
        if parts.is_empty() {
            return None;
        }
        let text = parts[0].clone();
        if is_reserved_control_token(&text) {
            return None;
        }
        (text, parts[1..].to_vec())
    };

    if text.is_empty() {
        return None;
    }

    let (max_repeats, ai_mode) = parse_stop_message_tail(&tail_tokens);
    Some(StopMessageInstructionParseOutput {
        kind: "set".to_string(),
        text: Some(text),
        max_repeats: Some(max_repeats),
        ai_mode,
    })
}

#[napi]
pub fn parse_stop_message_instruction_json(instruction: String) -> NapiResult<String> {
    let output = parse_stop_message_instruction(instruction);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
