use regex::Regex;
use serde_json::{json, Map, Value};

use crate::virtual_router_engine::message_utils::extract_message_text;

use super::super::types::RoutingInstruction;
use super::parse_instructions::{
    normalize_stop_message_instruction_precedence, parse_single_instruction,
};
use super::parse_targets::expand_instruction_segments;

fn strip_code_segments(text: &str) -> String {
    if text.is_empty() {
        return "".to_string();
    }
    let mut sanitized = Regex::new(r"```[\s\S]*?```")
        .unwrap()
        .replace_all(text, " ")
        .to_string();
    sanitized = Regex::new(r"~~~[\s\S]*?~~~")
        .unwrap()
        .replace_all(&sanitized, " ")
        .to_string();
    sanitized = Regex::new(r"`[^`]*`")
        .unwrap()
        .replace_all(&sanitized, " ")
        .to_string();
    sanitized
}

pub(crate) fn parse_routing_instructions_from_messages(
    messages: &[Value],
) -> Result<Vec<RoutingInstruction>, String> {
    if messages.is_empty() {
        return Ok(Vec::new());
    }
    let latest = match messages.last() {
        Some(value) => value,
        None => return Ok(Vec::new()),
    };
    if latest.get("role").and_then(|v| v.as_str()).unwrap_or("") != "user" {
        return Ok(Vec::new());
    }
    let content = extract_message_text(latest);
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let sanitized = strip_code_segments(&content);
    let marker_re = Regex::new(r"<\*\*[\s\S]*?\*\*>").unwrap();
    if !marker_re.is_match(&sanitized) {
        return Ok(Vec::new());
    }
    let mut instructions: Vec<RoutingInstruction> = Vec::new();
    let regex = Regex::new(r"<\*\*([\s\S]*?)\*\*>").unwrap();
    for cap in regex.captures_iter(&sanitized) {
        let raw = cap
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if raw.is_empty() {
            continue;
        }
        let segments = expand_instruction_segments(&raw);
        for segment in segments {
            if segment.trim().is_empty() {
                continue;
            }
            match parse_single_instruction(&segment) {
                Ok(Some(parsed)) => instructions.push(parsed),
                Ok(None) => {}
                Err(_) => continue,
            }
        }
    }
    Ok(normalize_stop_message_instruction_precedence(instructions))
}

fn extract_responses_input_text(entry: &Map<String, Value>) -> String {
    if let Some(content) = entry.get("content") {
        if let Some(text) = content.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        if content.is_array() {
            let message = json!({ "role": "user", "content": content });
            let extracted = extract_message_text(&message);
            if !extracted.trim().is_empty() {
                return extracted;
            }
        }
    }
    "".to_string()
}

fn get_latest_user_text_from_responses_context(context: Option<&Value>) -> String {
    let context = match context {
        Some(val) => val,
        None => return "".to_string(),
    };
    let input = context.get("input").and_then(|v| v.as_array());
    let input = match input {
        Some(arr) => arr,
        None => return "".to_string(),
    };
    for entry in input.iter().rev() {
        let record = match entry.as_object() {
            Some(map) => map,
            None => continue,
        };
        let entry_type = record
            .get("type")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "message".to_string());
        if entry_type != "message" {
            continue;
        }
        let role = record
            .get("role")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "user".to_string());
        if role != "user" {
            continue;
        }
        let text = extract_responses_input_text(record);
        if !text.trim().is_empty() {
            return text;
        }
    }
    "".to_string()
}

pub(crate) fn has_routing_instruction_marker_in_responses_context(context: Option<&Value>) -> bool {
    let latest_user_text = get_latest_user_text_from_responses_context(context);
    if latest_user_text.trim().is_empty() {
        return false;
    }
    Regex::new(r"<\*\*[\s\S]*?\*\*>")
        .unwrap()
        .is_match(&latest_user_text)
}

pub(crate) fn parse_routing_instructions_from_request(
    request: &Value,
) -> Result<Vec<RoutingInstruction>, String> {
    let messages = request
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut parsed = parse_routing_instructions_from_messages(&messages)?;
    let responses_context = request
        .get("semantics")
        .and_then(|v| v.get("responses"))
        .and_then(|v| v.get("context"));
    let responses_has_marker =
        has_routing_instruction_marker_in_responses_context(responses_context);
    if parsed.is_empty() && responses_has_marker {
        let latest_user_text = get_latest_user_text_from_responses_context(responses_context);
        if !latest_user_text.trim().is_empty() {
            let message = json!({ "role": "user", "content": latest_user_text });
            parsed = parse_routing_instructions_from_messages(&[message])?;
        }
    }
    Ok(parsed)
}

pub(crate) fn has_routing_instruction_marker_in_messages(messages: &[Value]) -> bool {
    let marker_re = Regex::new(r"<\*\*[\s\S]*?\*\*>").unwrap();
    let latest = match messages.last() {
        Some(value) => value,
        None => return false,
    };
    if latest.get("role").and_then(|v| v.as_str()).unwrap_or("") != "user" {
        return false;
    }
    let content = extract_message_text(latest);
    if content.is_empty() {
        return false;
    }
    marker_re.is_match(content.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::virtual_router_engine::instructions::clean::clean_routing_instruction_markers;
    use serde_json::json;

    #[test]
    fn malformed_marker_is_ignored_without_failing_request_parse() {
        let request = json!({
            "messages": [
                { "role": "user", "content": "<**stopMessage:file://missing-file.txt**> continue" }
            ]
        });
        let parsed = parse_routing_instructions_from_request(&request).unwrap();
        assert!(parsed.is_empty());
    }

    #[test]
    fn malformed_marker_is_still_cleaned_from_request_content() {
        let mut request = json!({
            "messages": [
                { "role": "user", "content": "<**stopMessage:file://missing-file.txt**> continue" }
            ]
        });
        clean_routing_instruction_markers(&mut request);
        assert_eq!(request["messages"][0]["content"].as_str(), Some("continue"));
    }

    #[test]
    fn bare_force_supports_bracket_alias_model_targets() {
        let request = json!({
            "messages": [
                { "role": "user", "content": "<**ark-coding-plan[key1].doubao-seed-2.0-code**> continue" }
            ]
        });
        let parsed = parse_routing_instructions_from_request(&request).unwrap();
        assert_eq!(parsed.len(), 1);
        let inst = &parsed[0];
        assert_eq!(inst.kind, "force");
        let target = inst.target.as_ref().expect("target");
        assert_eq!(target.provider.as_deref(), Some("ark-coding-plan"));
        assert_eq!(target.key_alias.as_deref(), Some("key1"));
        assert_eq!(target.model.as_deref(), Some("doubao-seed-2.0-code"));
    }
}
