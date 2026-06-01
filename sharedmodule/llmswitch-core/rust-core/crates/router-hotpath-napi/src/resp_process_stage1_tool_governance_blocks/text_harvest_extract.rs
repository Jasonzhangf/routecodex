use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::Path;

use crate::resp_process_stage1_tool_governance_blocks::display_sanitize::{
    contains_explicit_tool_wrapper_marker, mask_tool_wrapper_markup,
};
use crate::resp_process_stage1_tool_governance_blocks::exec_command_args::read_command_from_args;
use crate::resp_process_stage1_tool_governance_blocks::json_args::try_parse_json_value_lenient;
use crate::resp_process_stage1_tool_governance_blocks::tool_call_entry::{
    auto_close_jsonish_shape, normalize_tool_call_entry, unescape_outer_json_quotes_only,
};
use crate::resp_process_stage1_tool_governance_blocks::xml_text_utils::{
    decode_basic_xml_entities, is_xml_named_tool_container_tag, normalize_dsml_tool_markup,
    parse_xml_tag_attributes, resolve_xml_named_child_arg_key,
    resolve_xml_wrapper_tool_name_from_attrs, should_attempt_xml_wrapper_harvest,
    strip_xml_tags_preserve_text, unwrap_xml_cdata_sections,
};
use crate::shared_tooling::extract_rcc_tool_call_fence_segments;

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

pub(crate) fn normalize_shell_command_text(raw: &str, workdir: Option<&str>) -> String {
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

pub(crate) fn looks_like_exec_command_candidate(raw: &str) -> bool {
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

pub(crate) fn extract_function_calls_shell_fence_tool_call(
    text: &str,
    fallback_id: usize,
) -> Option<Value> {
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

pub(crate) fn extract_tool_prefixed_exec_command_block(
    text: &str,
    fallback_id: usize,
) -> Option<Value> {
    let pattern = Regex::new(
        r#"(?is)tool\s*:\s*exec_command\b.*?<command>\s*([\s\S]*?)\s*</command>(?:[\s\S]*?<workdir>\s*([\s\S]*?)\s*</workdir>)?"#,
    )
    .ok()?;
    let captures = pattern.captures(text)?;
    let command = captures
        .get(1)
        .map(|m| decode_basic_xml_entities(m.as_str()).trim().to_string())
        .filter(|value| !value.is_empty())?;
    let workdir = captures
        .get(2)
        .map(|m| decode_basic_xml_entities(m.as_str()).trim().to_string())
        .filter(|value| !value.is_empty());

    let mut input = Map::new();
    input.insert("cmd".to_string(), Value::String(command));
    if let Some(workdir) = workdir {
        input.insert("workdir".to_string(), Value::String(workdir));
    }

    let entry = Value::Object(
        [
            (
                "name".to_string(),
                Value::String("exec_command".to_string()),
            ),
            ("input".to_string(), Value::Object(input)),
        ]
        .into_iter()
        .collect(),
    );
    normalize_tool_call_entry(&entry, fallback_id)
}

pub(crate) fn extract_reasoning_inline_exec_command_arg_key(
    text: &str,
    fallback_id: usize,
) -> Option<Value> {
    let pattern = Regex::new(
        r#"(?is)exec_command\s*<arg_key>\s*cmd\s*</arg_key>\s*<arg_value>\s*([\s\S]*?)\s*</arg_value>"#,
    )
    .ok()?;
    let captures = pattern.captures(text)?;
    let command = captures
        .get(1)
        .map(|m| decode_basic_xml_entities(m.as_str()).trim().to_string())
        .filter(|value| !value.is_empty())?;
    let entry = json!({
        "name": "exec_command",
        "input": {
            "cmd": command
        }
    });
    normalize_tool_call_entry(&entry, fallback_id)
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
            let cleaned_value = if !contains_cdata && decoded.contains('<') && decoded.contains('>')
            {
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

pub(crate) fn extract_xml_named_tool_call_blocks(
    text: &str,
    fallback_start_id: usize,
) -> Vec<Value> {
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

pub(crate) fn extract_xml_tool_call_blocks(text: &str, fallback_start_id: usize) -> Vec<Value> {
    let Ok(pattern) = Regex::new(
        r#"(?is)<tool_call(?:\s+name\s*=\s*["']([^"']+)["'])?\s*>\s*([\s\S]*?)\s*</tool_call>"#,
    ) else {
        return Vec::new();
    };
    let mut recovered: Vec<Value> = Vec::new();
    for (idx, caps) in pattern.captures_iter(text).enumerate() {
        let wrapper_name = caps
            .get(1)
            .map(|m| m.as_str().trim())
            .filter(|v| !v.is_empty());
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

pub(crate) fn collect_harvest_text_variants(raw: &str) -> Vec<String> {
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
