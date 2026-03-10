mod content;
mod model;
mod tool_guidance;
mod types;

use regex::Regex;
use serde_json::{Map, Value};

use model::{merge_by_role, to_prompt_messages};

pub(super) fn build_deepseek_prompt(root: &Map<String, Value>) -> String {
    let merged = merge_by_role(&to_prompt_messages(root));
    let mut parts: Vec<String> = Vec::new();
    for (idx, block) in merged.iter().enumerate() {
        let role = block.role.as_str();
        let text = block.text.as_str();
        if role == "assistant" {
            parts.push(format!("<｜Assistant｜>{}<｜end▁of▁sentence｜>", text));
            continue;
        }
        if role == "user" || role == "system" || role == "tool" {
            if idx > 0 {
                parts.push(format!("<｜User｜>{}", text));
            } else {
                parts.push(text.to_string());
            }
            continue;
        }
        parts.push(text.to_string());
    }
    let joined = parts.join("");
    let re = Regex::new(r"!\[(.*?)\]\((.*?)\)").expect("deepseek image markdown regex");
    re.replace_all(&joined, "[$1]($2)").trim().to_string()
}
