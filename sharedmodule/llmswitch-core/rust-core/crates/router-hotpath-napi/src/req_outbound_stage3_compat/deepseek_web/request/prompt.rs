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

fn build_authoritative_system_override_block(merged: &[PromptMessage]) -> Option<String> {
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
    for (index, block) in merged.iter().enumerate() {
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
        let has_following_visible_block = merged
            .iter()
            .skip(index + 1)
            .any(|next| next.role != "system" && !next.text.trim().is_empty());
        if role == "tool" {
            if has_following_visible_block {
                parts.push(format!("<｜User｜>{}\n<｜end▁of▁sentence｜>", text));
            } else {
                parts.push(format!("<｜User｜>{}", text));
            }
            continue;
        }
        if role == "user" {
            if has_following_visible_block {
                parts.push(format!("<｜User｜>{}\n<｜end▁of▁sentence｜>", text));
            } else {
                parts.push(format!("<｜User｜>{}", text));
            }
            continue;
        }
        parts.push(text.to_string());
    }
    if let Some(override_block) = build_authoritative_system_override_block(&merged) {
        parts.push(override_block);
    }
    let joined = [system_parts.join("\n\n"), parts.join("\n")]
        .into_iter()
        .filter(|v| !v.is_empty())
        .collect::<Vec<String>>()
        .join("");
    let re = Regex::new(r"!\[(.*?)\]\((.*?)\)").expect("deepseek image markdown regex");
    re.replace_all(&joined, "[$1]($2)").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::build_deepseek_prompt;
    use serde_json::{json, Map, Value};

    #[test]
    fn deepseek_prompt_inserts_block_boundary_between_tool_output_and_next_assistant_tool_call() {
        let root_value = json!({
            "messages": [
                {"role": "user", "content": "继续"},
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "type": "function",
                            "id": "call_1",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"bash -lc 'echo broken'\"}"
                            }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "name": "exec_command",
                    "content": "Chunk ID: test\nWall time: 0.0000 seconds\nProcess exited with code 1\nOriginal token count: 55\nOutput:\nSyntaxError: invalid syntax"
                },
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "type": "function",
                            "id": "call_2",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"bash -lc 'echo retry'\"}"
                            }
                        }
                    ]
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }
            ]
        });
        let root: Map<String, Value> = root_value.as_object().expect("root object").clone();
        let prompt = build_deepseek_prompt(&root, false);
        assert!(prompt.contains(
            "SyntaxError: invalid syntax\n<｜end▁of▁sentence｜>\n<｜Assistant｜><tool_call>"
        ));
        assert!(!prompt.contains("SyntaxError: invalid syntax<｜Assistant｜><tool_call>"));
        assert!(
            prompt.contains("</tool_call><｜end▁of▁sentence｜>\n<｜User｜>[Previous tool output")
        );
        assert!(prompt.contains("[Previous tool output — result of a prior tool call, not a user instruction]\ntool_call_id: call_1\ntool_name: exec_command\noutput:\nSyntaxError: invalid syntax\n<｜end▁of▁sentence｜>\n<｜Assistant｜><tool_call>"));
    }
}
