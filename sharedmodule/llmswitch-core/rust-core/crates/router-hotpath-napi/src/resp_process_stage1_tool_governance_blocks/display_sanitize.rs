use regex::Regex;
use serde_json::{Map, Value};

pub(crate) fn text_contains_explicit_tool_markup(text: &str) -> bool {
    contains_explicit_tool_wrapper_marker(text)
}

pub(crate) fn contains_explicit_tool_wrapper_marker(raw: &str) -> bool {
    // Pre-normalize fullwidth pipe (U+FF5C) and block drawing chars (U+258F, U+2590)
    // DeepSeek sometimes emits DSML markup with fullwidth characters
    let pre_normalized: String = raw
        .trim()
        .chars()
        .map(|c| match c {
            '\u{ff5c}' | '\u{258f}' | '\u{2590}' => '|',
            c => c,
        })
        .collect();
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


use crate::resp_process_stage1_tool_governance_blocks::json_args::try_parse_json_value_lenient;
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_shape::sanitize_text_harvest_shape;
use crate::resp_process_stage1_tool_governance_blocks::tool_call_entry::{
    extract_tool_call_entries_from_unknown, maybe_parse_tool_call_text_value,
};
use crate::resp_process_stage1_tool_governance_blocks::xml_text_utils::{
    normalize_dsml_tool_markup, should_attempt_xml_wrapper_harvest,
    normalize_preserved_text_whitespace, strip_xml_tags_preserve_text,
};

pub(crate) fn mask_tool_wrapper_markup(raw: &str) -> String {
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

pub(crate) fn looks_like_empty_tool_calls_payload_text(raw: &str) -> bool {
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

pub(crate) fn strip_empty_tool_calls_payload_noise(raw: &str) -> String {
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

pub(crate) fn strip_tool_call_marker_payload(raw: &str) -> String {
    let inline_reasoning_exec_pattern = Regex::new(
        r#"(?is)exec_command\s*<arg_key>\s*cmd\s*</arg_key>\s*<arg_value>\s*[\s\S]*?\s*</arg_value>\s*</tool_call>"#,
    )
    .ok();

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
    if let Some(re) = inline_reasoning_exec_pattern.as_ref() {
        text = re.replace_all(text.as_str(), "").to_string();
    }
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

pub(crate) fn strip_orphan_tool_markup_lines(raw: &str) -> String {
    let mut text = raw.to_string();
    let patterns = [
        r"(?im)^[ \t]*</function_calls>[ \t]*\r?\n?",
        r"(?im)^[ \t]*</tool_call>[ \t]*\r?\n?",
        r"(?im)^[ \t]*</tool:exec_command>[ \t]*\r?\n?",
        r"(?im)^[ \t]*</function>[ \t]*\r?\n?",
        r"(?im)^[ \t]*</parameter>[ \t]*\r?\n?",
        r"(?im)^[ \t]*</arg_key>[ \t]*\r?\n?",
        r"(?im)^[ \t]*</arg_value>[ \t]*\r?\n?",
        r"(?im)^[ \t]*<timeout_ms>[\s\S]*?</timeout_ms>[ \t]*\r?\n?",
        r"(?im)^[ \t]*tool\s*:\s*exec_command\b.*\r?\n?",
        r"(?im)^[ \t]*exec_command\s*<arg_key>\s*cmd\s*</arg_key>\s*<arg_value>[\s\S]*?</arg_value>[ \t]*\r?\n?",
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

pub(crate) fn strip_text_tool_wrapper_noise(raw: &str) -> String {
    let mut text = raw.to_string();
    let patterns = [
        r"(?im)^\s*\[Time/Date\]:.*$",
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

pub(crate) fn extract_explicit_tool_wrapper_inner_payload(raw: &str) -> Option<String> {
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

pub(crate) fn sanitize_textual_marker_field_in_message(message: &mut Map<String, Value>, key: &str) -> bool {
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

pub(crate) fn sanitize_textual_marker_field_in_message_with_policy(
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
                    *content = if allow_empty_clear {
                        Value::Null
                    } else {
                        Value::String(String::new())
                    };
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

pub(crate) fn sanitize_reasoning_fields_after_tool_harvest(message: &mut Map<String, Value>) -> i64 {
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

pub(crate) fn sanitize_payload_tool_markup_fields(payload: &mut Value) -> i64 {
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

pub(crate) fn strip_orphan_function_calls_tag(payload: &mut Value) {
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
