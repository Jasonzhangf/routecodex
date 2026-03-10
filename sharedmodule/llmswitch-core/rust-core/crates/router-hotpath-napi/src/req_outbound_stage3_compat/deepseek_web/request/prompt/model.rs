use serde_json::{Map, Value};

use super::super::super::read_trimmed_string;
use super::content::{normalize_content_to_text, normalize_tool_calls_as_text};
use super::tool_guidance::{
    build_tool_fallback_instruction, has_tool_guidance_marker, is_tool_choice_required,
};
use super::types::PromptMessage;

pub(super) fn to_prompt_messages(root: &Map<String, Value>) -> Vec<PromptMessage> {
    let mut messages: Vec<PromptMessage> = Vec::new();
    let rows = root
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for item in rows {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let role = read_trimmed_string(obj.get("role"))
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_default();
        if role.is_empty() {
            continue;
        }
        let content_text = normalize_content_to_text(obj.get("content").unwrap_or(&Value::Null));
        let tool_calls_text = normalize_tool_calls_as_text(obj.get("tool_calls"));
        let reasoning = read_trimmed_string(obj.get("reasoning_content"))
            .or_else(|| read_trimmed_string(obj.get("reasoning")))
            .unwrap_or_default();
        let mut parts: Vec<String> = Vec::new();
        if !content_text.is_empty() {
            parts.push(content_text);
        }
        if !tool_calls_text.is_empty() {
            parts.push(tool_calls_text);
        }
        if !reasoning.is_empty() {
            parts.push(reasoning);
        }
        messages.push(PromptMessage {
            role,
            text: parts.join("\n").trim().to_string(),
        });
    }

    let instruction = if has_tool_guidance_marker(&messages) {
        String::new()
    } else {
        build_tool_fallback_instruction(root.get("tools"), is_tool_choice_required(root))
    };
    if !instruction.is_empty() {
        if let Some(first) = messages.first_mut() {
            if first.role == "system" {
                first.text = [first.text.clone(), instruction]
                    .into_iter()
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<String>>()
                    .join("\n\n");
                return messages;
            }
        }
        messages.insert(
            0,
            PromptMessage {
                role: "system".to_string(),
                text: instruction,
            },
        );
    }

    messages
}

pub(super) fn merge_by_role(messages: &[PromptMessage]) -> Vec<PromptMessage> {
    if messages.is_empty() {
        return Vec::new();
    }
    let mut merged: Vec<PromptMessage> = vec![messages[0].clone()];
    for item in messages.iter().skip(1) {
        let Some(last) = merged.last_mut() else {
            continue;
        };
        if last.role == item.role {
            last.text = [last.text.clone(), item.text.clone()]
                .into_iter()
                .filter(|v| !v.is_empty())
                .collect::<Vec<String>>()
                .join("\n\n");
        } else {
            merged.push(item.clone());
        }
    }
    merged
}
