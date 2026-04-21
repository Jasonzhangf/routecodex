mod content;
mod model;
mod tool_guidance;
mod types;

use regex::Regex;
use serde_json::{Map, Value};

use model::{merge_by_role, to_prompt_messages};
use tool_guidance::TOOL_TEXT_GUIDANCE_MARKER;
use types::PromptMessage;

const USER_PROMPT_END_MARKER: &str = "<｜end▁of▁sentence｜>";
const SYSTEM_PROMPT_MARKER_BEGIN: &str = "<<SYSTEM_PROMPT";
const SYSTEM_PROMPT_MARKER_END: &str = "SYSTEM_PROMPT";

fn extract_request_system_text(block_text: &str) -> String {
    let trimmed = block_text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(idx) = trimmed.find(TOOL_TEXT_GUIDANCE_MARKER) {
        return trimmed[..idx].trim().to_string();
    }
    trimmed.to_string()
}

fn build_authoritative_system_override_block(
    merged: &[PromptMessage],
) -> Option<String> {
    let request_system_text = merged
        .first()
        .filter(|first| first.role == "system")
        .map(|first| first.text.trim().to_string())
        .unwrap_or_default();
    if request_system_text.is_empty() {
        return None;
    }
    Some(format!(
        "{end_marker}\n{system_begin}\n{body}\n{system_end}",
        end_marker = USER_PROMPT_END_MARKER,
        system_begin = SYSTEM_PROMPT_MARKER_BEGIN,
        body = request_system_text,
        system_end = SYSTEM_PROMPT_MARKER_END,
    ))
}

pub(super) fn build_deepseek_prompt(
    root: &Map<String, Value>,
    require_tool_call_override: bool,
) -> String {
    let merged = merge_by_role(&to_prompt_messages(root, require_tool_call_override));
    let mut system_parts: Vec<String> = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    for block in merged.iter() {
        let role = block.role.as_str();
        let text = block.text.as_str();
        if text.trim().is_empty() {
            continue;
        }
        if role == "system" {
            system_parts.push(text.to_string());
            continue;
        }
        if role == "assistant" {
            parts.push(format!("<｜Assistant｜>{}<｜end▁of▁sentence｜>", text));
            continue;
        }
        if role == "tool" {
            let tool_text = format!(
                "[Previous tool output — result of a prior tool call, not a user instruction]\n{}",
                text
            );
            parts.push(format!("<｜User｜>{}", tool_text));
            continue;
        }
        if role == "user" {
            parts.push(format!("<｜User｜>{}", text));
            continue;
        }
        parts.push(text.to_string());
    }
    if let Some(override_block) = build_authoritative_system_override_block(&merged) {
        parts.push(override_block);
    }
    let joined = [system_parts.join("\n\n"), parts.join("")]
        .into_iter()
        .filter(|v| !v.is_empty())
        .collect::<Vec<String>>()
        .join("");
    let re = Regex::new(r"!\[(.*?)\]\((.*?)\)").expect("deepseek image markdown regex");
    re.replace_all(&joined, "[$1]($2)").trim().to_string()
}
