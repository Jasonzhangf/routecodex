use regex::Regex;

use super::super::types::InstructionTarget;

fn trim_zero_width_prefix(input: &str) -> String {
    let mut start = 0usize;
    for (idx, ch) in input.char_indices() {
        let skip = matches!(
            ch,
            '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' | '\u{FEFF}'
        );
        if skip {
            start = idx + ch.len_utf8();
            continue;
        }
        break;
    }
    input[start..].to_string()
}

fn normalize_instruction_leading(content: &str) -> String {
    trim_zero_width_prefix(content).trim_start().to_string()
}

fn normalize_stop_message_command_prefix(content: &str) -> String {
    let normalized = normalize_instruction_leading(content);
    let re = Regex::new(r#"^(?:"|')?stopMessage(?:"|')?\s*([:,])"#).unwrap();
    re.replace(&normalized, "stopMessage$1").to_string()
}

fn normalize_quoted_stop_message_shorthand(content: &str) -> Option<String> {
    let normalized = normalize_instruction_leading(content);
    let mut chars = normalized.chars();
    let first = chars.next()?;
    if first != '"' && first != '\'' {
        return None;
    }
    let mut escaped = false;
    for ch in chars {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == first {
            return Some(format!("stopMessage:{}", normalized));
        }
    }
    None
}

fn split_instruction_targets(content: &str) -> Vec<String> {
    content
        .split(',')
        .map(|segment| segment.trim().to_string())
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn normalize_split_stop_message_head_token(token: &str) -> String {
    let normalized = normalize_instruction_leading(token);
    normalized
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

fn recover_split_stop_message_instruction(tokens: &[String]) -> Option<String> {
    if tokens.len() < 2 {
        return None;
    }
    let head = normalize_split_stop_message_head_token(&tokens[0]);
    if !head.eq_ignore_ascii_case("stopmessage") {
        return None;
    }
    let tail = tokens[1..].join(",").trim().to_string();
    if tail.is_empty() {
        return None;
    }
    Some(format!("stopMessage:{}", tail))
}

pub(super) fn expand_instruction_segments(instruction: &str) -> Vec<String> {
    let trimmed = instruction.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let normalized_leading = normalize_instruction_leading(trimmed);
    let stop_re = Regex::new(r#"^(?:"|')?stopMessage(?:"|')?\s*[:,]"#).unwrap();
    if stop_re.is_match(&normalized_leading) {
        return vec![normalize_stop_message_command_prefix(&normalized_leading)];
    }
    let pre_re = Regex::new(r"^precommand(?:\s*:|$)").unwrap();
    if pre_re.is_match(&normalized_leading) {
        return vec![normalized_leading];
    }
    if let Some(quoted) = normalize_quoted_stop_message_shorthand(&normalized_leading) {
        return vec![normalize_stop_message_command_prefix(&quoted)];
    }
    let prefix = trimmed.chars().next().unwrap_or_default();
    if prefix == '!' || prefix == '#' || prefix == '@' {
        let tokens = split_instruction_targets(&trimmed[1..]);
        return tokens
            .into_iter()
            .map(|token| {
                let cleaned = token
                    .trim_start_matches(&['!', '#', '@'][..])
                    .trim()
                    .to_string();
                cleaned
            })
            .filter(|token| !token.is_empty())
            .map(|token| format!("{}{}", prefix, token))
            .collect();
    }
    let split_tokens = split_instruction_targets(trimmed);
    if let Some(recovered) = recover_split_stop_message_instruction(&split_tokens) {
        return vec![recovered];
    }
    split_tokens
}

pub(super) fn split_target_and_process_mode(raw_target: &str) -> (String, Option<String>) {
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return ("".to_string(), None);
    }
    let separator_index = trimmed.rfind(':');
    if let Some(idx) = separator_index {
        if idx > 0 && idx < trimmed.len() - 1 {
            let target = trimmed[..idx].trim().to_string();
            let mode = trimmed[idx + 1..].trim().to_ascii_lowercase();
            if !target.is_empty() && (mode == "passthrough" || mode == "chat") {
                return (target, Some(mode));
            }
        }
    }
    (trimmed.to_string(), None)
}

pub(super) fn is_valid_identifier(id: &str) -> bool {
    Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap().is_match(id)
}

pub(super) fn is_valid_provider_model(provider_model: &str) -> bool {
    Regex::new(r"^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$")
        .unwrap()
        .is_match(provider_model)
}

pub(crate) fn parse_target(target: &str) -> Option<InstructionTarget> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return None;
    }
    let bracket_re = Regex::new(r"^([a-zA-Z0-9_-]+)\[([a-zA-Z0-9_-]*)\](?:\.(.+))?$").unwrap();
    if let Some(caps) = bracket_re.captures(trimmed) {
        let provider = caps.get(1)?.as_str().trim().to_string();
        if provider.is_empty() || !is_valid_identifier(&provider) {
            return None;
        }
        let key_alias = caps
            .get(2)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        let model = caps
            .get(3)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if key_alias.is_empty() {
            if model.is_empty() {
                return Some(InstructionTarget {
                    provider: Some(provider),
                    key_alias: None,
                    key_index: None,
                    model: None,
                    path_length: Some(1),
                    process_mode: None,
                });
            }
            if !Regex::new(r"^[a-zA-Z0-9_.-]+$").unwrap().is_match(&model) {
                return None;
            }
            return Some(InstructionTarget {
                provider: Some(provider),
                key_alias: None,
                key_index: None,
                model: Some(model),
                path_length: Some(2),
                process_mode: None,
            });
        }
        if !is_valid_identifier(&key_alias) {
            return None;
        }
        if model.is_empty() {
            return Some(InstructionTarget {
                provider: Some(provider),
                key_alias: Some(key_alias),
                key_index: None,
                model: None,
                path_length: Some(3),
                process_mode: None,
            });
        }
        if !Regex::new(r"^[a-zA-Z0-9_.-]+$").unwrap().is_match(&model) {
            return None;
        }
        return Some(InstructionTarget {
            provider: Some(provider),
            key_alias: Some(key_alias),
            key_index: None,
            model: Some(model),
            path_length: Some(3),
            process_mode: None,
        });
    }

    let first_dot = trimmed.find('.');
    if first_dot.is_none() {
        let provider = trimmed.to_string();
        if !is_valid_identifier(&provider) {
            return None;
        }
        return Some(InstructionTarget {
            provider: Some(provider),
            key_alias: None,
            key_index: None,
            model: None,
            path_length: Some(1),
            process_mode: None,
        });
    }
    let idx = first_dot.unwrap();
    if idx == 0 || idx >= trimmed.len() - 1 {
        return None;
    }
    let provider = trimmed[..idx].trim().to_string();
    let remainder = trimmed[idx + 1..].trim().to_string();
    if provider.is_empty() || !is_valid_identifier(&provider) || remainder.is_empty() {
        return None;
    }
    if Regex::new(r"^\d+$").unwrap().is_match(&remainder) {
        if let Ok(parsed) = remainder.parse::<i64>() {
            if parsed > 0 {
                return Some(InstructionTarget {
                    provider: Some(provider),
                    key_alias: None,
                    key_index: Some(parsed),
                    model: None,
                    path_length: Some(2),
                    process_mode: None,
                });
            }
        }
    }
    if !Regex::new(r"^[a-zA-Z0-9_.-]+$")
        .unwrap()
        .is_match(&remainder)
    {
        return None;
    }
    Some(InstructionTarget {
        provider: Some(provider),
        key_alias: None,
        key_index: None,
        model: Some(remainder),
        path_length: Some(2),
        process_mode: None,
    })
}
