use serde_json::{Map, Value};

use super::super::super::read_trimmed_string;
use super::content::{normalize_content_to_text, normalize_tool_calls_as_text};
use super::tool_guidance::{
    build_required_tool_call_tail_reminder_for_tools, build_tool_fallback_instruction,
    is_tool_choice_required, strip_existing_tool_guidance_block,
};
use super::types::PromptMessage;

pub(super) fn to_prompt_messages(
    root: &Map<String, Value>,
    require_tool_call_override: bool,
) -> Vec<PromptMessage> {
    let mut messages: Vec<PromptMessage> = Vec::new();
    let require_tool_call =
        require_tool_call_override || is_tool_choice_required(root);
    let tail_reminder = if require_tool_call {
        build_required_tool_call_tail_reminder_for_tools(root.get("tools"))
    } else {
        String::new()
    };
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
        let mut content_text = normalize_content_to_text(obj.get("content").unwrap_or(&Value::Null));
        if role == "system" {
            content_text = strip_existing_tool_guidance_block(content_text.as_str());
        }
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
        let text = parts.join("\n").trim().to_string();
        if text.is_empty() {
            continue;
        }
        messages.push(PromptMessage { role, text });
    }

    if require_tool_call && !tail_reminder.is_empty() {
        if let Some(last_user) = messages.iter_mut().rev().find(|msg| msg.role == "user") {
            let current = last_user.text.trim();
            if !current.contains("This turn is tool-required.")
                && !current.contains("Return exactly one RCC_TOOL_CALLS_JSON heredoc container.")
            {
                last_user.text = if current.is_empty() {
                    tail_reminder.clone()
                } else {
                    [current.to_string(), tail_reminder.clone()].join("\n\n")
                };
            }
        }
    }

    let instruction = build_tool_fallback_instruction(
        root.get("tools"),
        require_tool_call,
    );
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
