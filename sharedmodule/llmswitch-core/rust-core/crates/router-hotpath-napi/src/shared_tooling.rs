use napi::bindgen_prelude::Result as NapiResult;
use regex::Regex;
use serde_json::{Map, Value};
use std::{collections::HashSet, sync::OnceLock};

pub(crate) fn parse_lenient_string(value: &str) -> Value {
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
        .replace_all(candidate.as_str(), r#""$1""#)
        .to_string();
    let normalized = unquoted_key_pattern
        .replace_all(quoted.as_str(), r#"$1"$2":"#)
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

pub(crate) fn unwrap_xml_cdata_sections(raw: &str) -> String {
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
            out.push_str(remaining);
            break;
        };
        out.push_str(&after_start[..end]);
        remaining = &after_start[end + "]]>".len()..];
    }
    out
}

pub(crate) fn decode_basic_xml_entities(raw: &str) -> String {
    raw.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

pub(crate) fn normalize_xml_scalar_text(raw: &str) -> String {
    decode_basic_xml_entities(unwrap_xml_cdata_sections(raw).trim())
}

pub(crate) fn collapse_extra_newlines_and_trim(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut newline_run = 0usize;
    for ch in input.chars() {
        if ch == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                out.push(ch);
            }
            continue;
        }
        newline_run = 0;
        out.push(ch);
    }
    out.trim().to_string()
}

pub(crate) fn strip_terminal_right_gutter_noise(line: &str) -> String {
    terminal_right_gutter_noise_regex()
        .replace(line, "")
        .to_string()
}

fn strip_box_drawing_prefix(line: &str) -> String {
    box_drawing_prefix_regex().replace(line, "").to_string()
}

fn is_transcript_collapsed_placeholder(line: &str) -> bool {
    transcript_collapsed_placeholder_regex().is_match(line)
}

fn terminal_right_gutter_noise_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\s+[│┃]\s*[·.]{6,}\s*$").expect("valid terminal right gutter regex")
    })
}

fn box_drawing_prefix_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[\s│└├─]+").expect("valid box drawing prefix regex"))
}

fn transcript_collapsed_placeholder_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^\s*[│└├─\s]*[.…·]+\s*\+\d+\s+lines\s*$")
            .expect("valid transcript collapsed placeholder regex")
    })
}

fn chunked_exec_transcript_header_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^(?:\[工具结果\]|Command:\s+.*|Chunk ID:\s+.*|Wall time:\s+.*|Process exited with code\s+.*|Process running with session ID\s+.*|Original token count:\s+.*)$",
        )
        .expect("valid chunked exec transcript header regex")
    })
}

fn ran_tree_body_line_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[\s]*[│└├]").expect("valid ran transcript tree body regex"))
}

fn transcript_tree_marker(line: &str) -> Option<char> {
    line.trim_start()
        .chars()
        .next()
        .filter(|ch| matches!(ch, '│' | '└' | '├'))
}

pub(crate) fn is_chunked_exec_transcript_header_line(line: &str) -> bool {
    chunked_exec_transcript_header_regex().is_match(line.trim())
}

pub(crate) fn unwrap_chunked_exec_transcript_shape(raw: &str) -> Option<String> {
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

pub(crate) fn unwrap_ran_transcript_shape(raw: &str) -> Option<String> {
    let lines: Vec<&str> = raw.lines().collect();
    let first = lines.first()?.trim_start();
    if !first.starts_with("• Ran ") {
        return None;
    }
    if lines.len() < 2 {
        return None;
    }
    let has_tree_body = lines
        .iter()
        .skip(1)
        .any(|line| ran_tree_body_line_regex().is_match(line));
    if !has_tree_body {
        return None;
    }

    let mut out: Vec<String> = Vec::new();
    for line in lines.iter().skip(1) {
        if is_transcript_collapsed_placeholder(line) {
            continue;
        }
        let stripped = match transcript_tree_marker(line) {
            Some(_) => strip_box_drawing_prefix(line).trim().to_string(),
            None => line.trim().to_string(),
        };
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

pub(crate) fn normalize_standard_chunked_tool_text(raw: &str) -> String {
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
    without_gutter.trim().to_string()
}

pub(crate) fn normalize_ran_tree_or_chunked_tool_text(raw: &str) -> String {
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

pub(crate) fn normalize_tool_result_text(raw: &str) -> String {
    let normalized = normalize_ran_tree_or_chunked_tool_text(raw);
    let without_provider_sentinels = strip_provider_tool_sentinel_residue(normalized.as_str());
    replace_inline_data_images_with_placeholder(
        collapse_extra_newlines_and_trim(without_provider_sentinels.as_str()).as_str(),
    )
}

pub(crate) fn strip_provider_tool_sentinel_residue(raw: &str) -> String {
    static BRACKET_SENTINEL_RE: OnceLock<Regex> = OnceLock::new();
    static EMPTY_TOOL_CALL_LINE_RE: OnceLock<Regex> = OnceLock::new();
    static EMPTY_TOOL_CALL_TAG_RE: OnceLock<Regex> = OnceLock::new();

    let bracket_sentinel_re = BRACKET_SENTINEL_RE.get_or_init(|| {
        Regex::new(r"\]<\][A-Za-z][A-Za-z0-9_-]*\[>\[")
            .expect("valid provider bracket sentinel regex")
    });
    let empty_tool_call_line_re = EMPTY_TOOL_CALL_LINE_RE.get_or_init(|| {
        Regex::new(
            r"(?im)^\s*(?:[-*•]\s*)?[A-Za-z][A-Za-z0-9_-]*:tool_call\s*\([^\n)]*:tool_call\)\s*$",
        )
        .expect("valid empty provider tool-call line regex")
    });
    let empty_tool_call_tag_re = EMPTY_TOOL_CALL_TAG_RE.get_or_init(|| {
        Regex::new(r"(?im)^\s*</[A-Za-z][A-Za-z0-9_-]*:tool_call>\s*$")
            .expect("valid empty provider tool-call tag regex")
    });

    let without_brackets = bracket_sentinel_re.replace_all(raw, "");
    let without_lines = empty_tool_call_line_re.replace_all(without_brackets.as_ref(), "");
    let without_tags = empty_tool_call_tag_re.replace_all(without_lines.as_ref(), "");
    without_tags
        .lines()
        .map(str::trim_end)
        .collect::<Vec<&str>>()
        .join("\n")
}

pub(crate) fn split_provider_tool_sentinel_text(raw: &str) -> Option<(String, String)> {
    static BRACKET_SENTINEL_RE: OnceLock<Regex> = OnceLock::new();
    let re = BRACKET_SENTINEL_RE.get_or_init(|| {
        Regex::new(r"\]<\][A-Za-z][A-Za-z0-9_-]*\[>\[")
            .expect("valid provider bracket sentinel regex")
    });
    let matched = re.find_iter(raw).last()?;
    let before = strip_provider_tool_sentinel_residue(&raw[..matched.start()])
        .trim()
        .to_string();
    let after = strip_provider_tool_sentinel_residue(&raw[matched.end()..])
        .trim()
        .to_string();
    Some((before, after))
}

fn replace_inline_data_images_with_placeholder(raw: &str) -> String {
    static DATA_IMAGE_RE: OnceLock<Regex> = OnceLock::new();
    let re = DATA_IMAGE_RE.get_or_init(|| {
        Regex::new(r"data:image/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+")
            .expect("valid data image regex")
    });
    re.replace_all(raw, "[Image omitted]").to_string()
}

pub(crate) fn normalize_tool_result_value(value: &Value) -> String {
    match value {
        Value::String(text) => normalize_tool_result_text(text),
        Value::Null => String::new(),
        other => serde_json::to_string(other)
            .ok()
            .map(|text| normalize_tool_result_text(text.as_str()))
            .unwrap_or_default(),
    }
}

pub(crate) fn find_last_user_message_index(messages: &[Value]) -> Option<usize> {
    messages
        .iter()
        .enumerate()
        .rev()
        .find_map(|(idx, message)| {
            let role = message
                .as_object()
                .and_then(|obj| obj.get("role"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if role == "user" {
                Some(idx)
            } else {
                None
            }
        })
}

pub(crate) fn is_image_path(input: &str) -> bool {
    let lowered = input.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return false;
    }
    let re = Regex::new(r"\.(png|jpg|jpeg|gif|webp|bmp|svg|tiff?|ico|heic|jxl)$")
        .expect("valid image suffix pattern");
    re.is_match(lowered.as_str())
}

pub(crate) fn value_to_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items
            .iter()
            .map(value_to_string)
            .collect::<Vec<String>>()
            .join(" "),
        Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
    }
}

pub(crate) fn repair_arguments_to_string(value: &Value) -> String {
    match value {
        Value::Null => "{}".to_string(),
        Value::Object(_) | Value::Array(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
        }
        Value::String(raw) => {
            if raw.trim().is_empty() {
                return "{}".to_string();
            }
            raw.to_string()
        }
        other => serde_json::to_string(&serde_json::json!({ "_raw": other.to_string() }))
            .unwrap_or_else(|_| "{}".to_string()),
    }
}

pub(crate) fn extract_rcc_tool_call_fence_segments(raw: &str) -> Vec<String> {
    fn find_open_marker(raw: &str, cursor: usize, open_marker: &str) -> Option<usize> {
        let mut search_from = cursor;
        while search_from < raw.len() {
            let rel_start = raw[search_from..].find(open_marker)?;
            let start = search_from + rel_start;
            if open_marker == "<<RCC_TOOL_CALLS"
                && raw[start + open_marker.len()..].starts_with("_JSON")
            {
                search_from = start + open_marker.len();
                continue;
            }
            return Some(start);
        }
        None
    }

    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::<String>::new();
    let markers = [
        ("<<RCC_TOOL_CALLS_JSON", "RCC_TOOL_CALLS_JSON"),
        ("<<RCC_TOOL_CALLS", "RCC_TOOL_CALLS"),
    ];

    for (open_marker, close_marker) in markers {
        let mut cursor = 0usize;
        while cursor < raw.len() {
            let Some(open_start) = find_open_marker(raw, cursor, open_marker) else {
                break;
            };
            let start = open_start + open_marker.len();
            let remainder = &raw[start..];
            let inner = if let Some(rel_end) = remainder.find(close_marker) {
                &remainder[..rel_end]
            } else {
                remainder
            };
            let candidate = inner.trim();
            if !candidate.is_empty() && seen.insert(candidate.to_string()) {
                out.push(candidate.to_string());
            }
            if let Some(rel_end) = remainder.find(close_marker) {
                cursor = start + rel_end + close_marker.len();
            } else {
                break;
            }
        }
    }

    out
}

pub(crate) fn is_structured_apply_patch_payload(value: &Value) -> bool {
    matches!(value.get("changes"), Some(Value::Array(_)))
}

pub(crate) fn extract_structured_apply_patch_payloads_with<F>(
    text: &str,
    mut parse_json: F,
) -> Vec<Value>
where
    F: FnMut(&str) -> Option<Value>,
{
    let mut payloads = Vec::new();
    let fence_re = Regex::new(r"```(?:json|apply_patch|toon)?\s*([\s\S]*?)\s*```")
        .expect("valid structured apply_patch fence regex");
    for caps in fence_re.captures_iter(text) {
        if let Some(body) = caps.get(1) {
            if let Some(parsed) = parse_json(body.as_str()) {
                if is_structured_apply_patch_payload(&parsed) {
                    payloads.push(parsed);
                }
            }
        }
    }
    if payloads.is_empty() && text.contains("\"changes\"") {
        if let Some(parsed) = parse_json(text) {
            if is_structured_apply_patch_payload(&parsed) {
                payloads.push(parsed);
            }
        }
    }
    payloads
}

pub(crate) fn chunk_string_by_bytes(input: &str, size: usize) -> Vec<String> {
    if input.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut idx = 0usize;
    while idx < input.len() {
        let end = std::cmp::min(idx + size, input.len());
        out.push(input[idx..end].to_string());
        idx = end;
    }
    out
}

pub(crate) fn repair_find_meta_impl(script: &str) -> String {
    let s = script.to_string();
    if s.is_empty() {
        return s;
    }
    let has_find = Regex::new(r#"(^|[\s'"`;|&(])find\s"#)
        .unwrap()
        .is_match(s.as_str());
    if !has_find {
        return s;
    }
    let exec_re = Regex::new(r"-exec([^;]*?)(?:\s*)(?:\\*);").unwrap();
    let mut out = exec_re.replace_all(s.as_str(), "-exec$1 \\;").to_string();
    out = escape_unescaped_parens(out.as_str());
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

#[cfg(test)]
mod tests;
