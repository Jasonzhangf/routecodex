use regex::Regex;
use serde_json::Value;

fn extract_message_text_from_value(message: &Value) -> String {
    let Some(record) = message.as_object() else {
        return String::new();
    };
    if let Some(content) = record.get("content").and_then(|v| v.as_str()) {
        if !content.trim().is_empty() {
            return content.to_string();
        }
    }
    let Some(content_parts) = record.get("content").and_then(|v| v.as_array()) else {
        return String::new();
    };
    let mut parts: Vec<String> = Vec::new();
    for entry in content_parts {
        if let Some(text) = entry.as_str() {
            if !text.trim().is_empty() {
                parts.push(text.to_string());
            }
            continue;
        }
        let Some(part_obj) = entry.as_object() else {
            continue;
        };
        if let Some(text) = part_obj.get("text").and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                parts.push(text.to_string());
                continue;
            }
        }
        if let Some(text) = part_obj.get("content").and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                parts.push(text.to_string());
            }
        }
    }
    let joined = parts.join("\n");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed.to_string()
}

fn strip_code_segments(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let fenced_backticks = Regex::new(r"(?s)```.*?```").unwrap();
    let fenced_tildes = Regex::new(r"(?s)~~~.*?~~~").unwrap();
    let inline_code = Regex::new(r"`[^`]*`").unwrap();
    let sanitized = fenced_backticks.replace_all(text, " ");
    let sanitized = fenced_tildes.replace_all(&sanitized, " ");
    inline_code.replace_all(&sanitized, " ").into_owned()
}

fn normalize_instruction_leading(content: &str) -> String {
    let mut char_indices = content.char_indices();
    let mut start = 0usize;
    while let Some((idx, ch)) = char_indices.next() {
        let is_zero_width = ch == '\u{200B}'
            || ch == '\u{200C}'
            || ch == '\u{200D}'
            || ch == '\u{2060}'
            || ch == '\u{FEFF}';
        if is_zero_width {
            start = idx + ch.len_utf8();
            continue;
        }
        break;
    }
    content[start..].trim_start().to_string()
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
        .trim_matches(|ch| ch == '"' || ch == '\'')
        .trim()
        .to_string()
}

fn recover_split_stop_message_instruction(tokens: &[String]) -> Option<String> {
    if tokens.len() < 2 {
        return None;
    }
    let head = normalize_split_stop_message_head_token(tokens[0].as_str());
    if !head.eq_ignore_ascii_case("stopmessage") {
        return None;
    }
    let tail = tokens[1..].join(",").trim().to_string();
    if tail.is_empty() {
        return None;
    }
    Some(format!("stopMessage:{}", tail))
}

fn normalize_stop_message_command_prefix(content: &str) -> String {
    let normalized = normalize_instruction_leading(content);
    let re = Regex::new(r#"^(?:"|')?stopMessage(?:"|')?\s*([:,])"#).unwrap();
    re.replace(&normalized, "stopMessage$1").to_string()
}

fn expand_instruction_segments(instruction: &str) -> Vec<String> {
    let trimmed = instruction.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let normalized_leading = normalize_instruction_leading(trimmed);
    let stop_message_re = Regex::new(r#"^(?:"|')?stopMessage(?:"|')?\s*[:,]"#).unwrap();
    if stop_message_re.is_match(&normalized_leading) {
        return vec![normalize_stop_message_command_prefix(&normalized_leading)];
    }
    let pre_command_re = Regex::new(r"(?i)^precommand(?:\s*:|$)").unwrap();
    if pre_command_re.is_match(&normalized_leading) {
        return vec![normalized_leading];
    }

    let mut chars = trimmed.chars();
    let prefix = chars.next().unwrap_or_default();
    if prefix == '!' || prefix == '#' || prefix == '@' {
        let targets = split_instruction_targets(chars.as_str());
        return targets
            .iter()
            .map(|token| {
                token
                    .trim_start_matches(|ch| ch == '!' || ch == '#' || ch == '@')
                    .trim()
                    .to_string()
            })
            .filter(|token| !token.is_empty())
            .map(|token| format!("{}{}", prefix, token))
            .collect();
    }

    let split_tokens = split_instruction_targets(trimmed);
    if let Some(recovered) = recover_split_stop_message_instruction(split_tokens.as_slice()) {
        return vec![recovered];
    }
    split_tokens
}

fn is_valid_identifier(id: &str) -> bool {
    Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap().is_match(id)
}

fn is_valid_model_token(token: &str) -> bool {
    Regex::new(r"^[a-zA-Z0-9_.-]+$").unwrap().is_match(token)
}

fn parse_target_is_valid(target: &str) -> bool {
    if target.is_empty() {
        return false;
    }
    let bracket_re = Regex::new(r"^([a-zA-Z0-9_-]+)\[([a-zA-Z0-9_-]*)\](?:\.(.+))?$").unwrap();
    if let Some(captures) = bracket_re.captures(target) {
        let provider = captures.get(1).map(|m| m.as_str()).unwrap_or("").trim();
        let key_alias = captures.get(2).map(|m| m.as_str()).unwrap_or("").trim();
        let model = captures.get(3).map(|m| m.as_str()).unwrap_or("").trim();
        if provider.is_empty() || !is_valid_identifier(provider) {
            return false;
        }
        if key_alias.is_empty() {
            return model.is_empty() || is_valid_model_token(model);
        }
        if !is_valid_identifier(key_alias) {
            return false;
        }
        return model.is_empty() || is_valid_model_token(model);
    }

    let Some(first_dot) = target.find('.') else {
        let provider = target.trim();
        return !provider.is_empty() && is_valid_identifier(provider);
    };
    let provider = target[..first_dot].trim();
    let remainder = target[first_dot + 1..].trim();
    if provider.is_empty() || remainder.is_empty() || !is_valid_identifier(provider) {
        return false;
    }
    if remainder.chars().all(|ch| ch.is_ascii_digit()) {
        return remainder.parse::<u32>().map(|v| v > 0).unwrap_or(false);
    }
    is_valid_model_token(remainder)
}

fn split_target_and_process_mode(raw_target: &str) -> (String, Option<String>) {
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return (String::new(), None);
    }
    let Some(separator_index) = trimmed.rfind(':') else {
        return (trimmed.to_string(), None);
    };
    if separator_index == 0 || separator_index + 1 >= trimmed.len() {
        return (trimmed.to_string(), None);
    }
    let target = trimmed[..separator_index].trim();
    let mode_token = trimmed[separator_index + 1..].trim().to_ascii_lowercase();
    if target.is_empty() {
        return (trimmed.to_string(), None);
    }
    match mode_token.as_str() {
        "passthrough" => (target.to_string(), Some("passthrough".to_string())),
        "chat" => (target.to_string(), Some("chat".to_string())),
        _ => (target.to_string(), None),
    }
}

fn parse_named_target_instruction_requests_passthrough(instruction: &str, prefix: &str) -> bool {
    let re = Regex::new(format!(r"(?i)^{}\s*:", regex::escape(prefix)).as_str()).unwrap();
    if !re.is_match(instruction) {
        return false;
    }
    let body_start = instruction.find(':').unwrap_or(0);
    let body = instruction[body_start + 1..].trim();
    if body.is_empty() {
        return false;
    }
    let (target, process_mode) = split_target_and_process_mode(body);
    if !parse_target_is_valid(target.as_str()) {
        return false;
    }
    matches!(process_mode.as_deref(), Some("passthrough"))
}

fn parse_single_instruction_requests_passthrough(instruction: &str) -> bool {
    if parse_named_target_instruction_requests_passthrough(instruction, "sticky")
        || parse_named_target_instruction_requests_passthrough(instruction, "force")
        || parse_named_target_instruction_requests_passthrough(instruction, "prefer")
    {
        return true;
    }
    if instruction.starts_with('!') {
        let raw_target = instruction[1..].trim();
        let (target, process_mode) = split_target_and_process_mode(raw_target);
        if target.is_empty() || !parse_target_is_valid(target.as_str()) {
            return false;
        }
        if !target.contains('.') {
            return false;
        }
        return matches!(process_mode.as_deref(), Some("passthrough"));
    }
    false
}

pub(crate) fn resolve_has_instruction_requested_passthrough(messages: &Value) -> bool {
    let Some(rows) = messages.as_array() else {
        return false;
    };
    if rows.is_empty() {
        return false;
    }
    let latest = match rows.last().and_then(|v| v.as_object()) {
        Some(v) => v,
        None => return false,
    };
    if latest
        .get("role")
        .and_then(|v| v.as_str())
        .map(|v| v == "user")
        != Some(true)
    {
        return false;
    }
    let content = extract_message_text_from_value(&Value::Object(latest.clone()));
    if content.is_empty() {
        return false;
    }
    let sanitized = strip_code_segments(content.as_str());
    if sanitized.is_empty() {
        return false;
    }
    let marker_re = Regex::new(r"(?s)<\*\*(.*?)\*\*>").unwrap();
    if !marker_re.is_match(&sanitized) {
        return false;
    }
    for captures in marker_re.captures_iter(&sanitized) {
        let instruction = captures
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if instruction.is_empty() {
            continue;
        }
        for segment in expand_instruction_segments(instruction.as_str()) {
            if parse_single_instruction_requests_passthrough(segment.as_str()) {
                return true;
            }
        }
    }
    false
}

pub(crate) fn resolve_active_process_mode(base_mode: &str, messages: &Value) -> String {
    if base_mode.eq_ignore_ascii_case("passthrough") {
        return "passthrough".to_string();
    }
    if resolve_has_instruction_requested_passthrough(messages) {
        return "passthrough".to_string();
    }
    "chat".to_string()
}

pub(crate) fn find_mappable_semantics_keys(metadata: &Value) -> Vec<String> {
    let Some(row) = metadata.as_object() else {
        return Vec::new();
    };
    let banned = [
        "responsesResume",
        "responses_resume",
        "clientToolsRaw",
        "client_tools_raw",
        "anthropicToolNameMap",
        "anthropic_tool_name_map",
        "responsesContext",
        "responses_context",
        "responseFormat",
        "response_format",
        "systemInstructions",
        "system_instructions",
        "toolsFieldPresent",
        "tools_field_present",
        "extraFields",
        "extra_fields",
    ];
    banned
        .iter()
        .filter(|key| row.get(**key).is_some_and(|value| !value.is_null()))
        .map(|key| key.to_string())
        .collect()
}
