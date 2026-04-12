mod content;
mod model;
mod tool_guidance;
mod types;

use regex::Regex;
use serde_json::{Map, Value};

use model::{merge_by_role, to_prompt_messages};
use tool_guidance::build_required_tool_call_tail_reminder;

pub(super) fn build_deepseek_prompt(
    root: &Map<String, Value>,
    require_tool_call_override: bool,
) -> String {
    let merged = merge_by_role(&to_prompt_messages(root, require_tool_call_override));
    let mut parts: Vec<String> = Vec::new();
    for (idx, block) in merged.iter().enumerate() {
        let role = block.role.as_str();
        let text = block.text.as_str();
        if text.trim().is_empty() {
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
        if role == "user" || role == "system" {
            if idx > 0 {
                parts.push(format!("<｜User｜>{}", text));
            } else {
                parts.push(text.to_string());
            }
            continue;
        }
        parts.push(text.to_string());
    }
    if require_tool_call_override {
        parts.push(format!(
            "<｜User｜>{}",
            build_required_tool_call_tail_reminder()
        ));
    }
    let joined = parts.join("");
    let re = Regex::new(r"!\[(.*?)\]\((.*?)\)").expect("deepseek image markdown regex");
    re.replace_all(&joined, "[$1]($2)").trim().to_string()
}
