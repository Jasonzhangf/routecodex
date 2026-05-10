mod content;
mod model;
mod tool_guidance;
mod types;

use regex::Regex;
use serde_json::{Map, Value};

use model::{merge_by_role, to_prompt_messages};
use tool_guidance::{
    build_required_tool_call_tail_reminder_for_tools, is_tool_choice_required,
};
use types::PromptMessage;

fn read_tool_continuation<'a>(root: &'a Map<String, Value>) -> Option<&'a Map<String, Value>> {
    root.get("semantics")
        .and_then(Value::as_object)
        .and_then(|semantics| semantics.get("continuation"))
        .and_then(Value::as_object)
        .and_then(|continuation| continuation.get("toolContinuation"))
        .and_then(Value::as_object)
}

fn read_trimmed_array_strings(node: Option<&Value>) -> Vec<String> {
    node.and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|value| value.as_str())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn build_tool_followup_instruction(root: &Map<String, Value>) -> Option<String> {
    let tool_continuation = read_tool_continuation(root)?;
    let mode = tool_continuation
        .get("mode")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if mode != "submit_tool_outputs" {
        return None;
    }

    let submitted_ids =
        read_trimmed_array_strings(tool_continuation.get("submittedToolCallIds"));
    let resume_outputs = read_trimmed_array_strings(tool_continuation.get("resumeOutputs"));

    let mut lines = vec![super::history_context::RCC_HISTORY_TOOL_RESUME_PROMPT.to_string()];
    lines.push(
        "Treat any prior assistant tool call in RCC_HISTORY.txt as already executed when its result is present there.".to_string(),
    );
    lines.push(
        "Only emit a fresh tool call if a new next-step tool action is still necessary after consuming that submitted result.".to_string(),
    );
    if !submitted_ids.is_empty() {
        lines.push(format!(
            "Tool call ids already completed in this continuation: {}.",
            submitted_ids.join(", ")
        ));
    }
    if !resume_outputs.is_empty() {
        lines.push(
            "The latest submitted tool outputs are already part of the working state in RCC_HISTORY.txt.".to_string(),
        );
    }
    Some(lines.join(" "))
}

pub(super) fn build_deepseek_history_messages(root: &Map<String, Value>) -> Vec<PromptMessage> {
    merge_by_role(&model::to_history_prompt_messages(root))
}

pub(super) fn build_deepseek_continuation_prompt(
    root: &Map<String, Value>,
    require_tool_call_override: bool,
) -> String {
    let messages = merge_by_role(&to_prompt_messages(root, require_tool_call_override));
    let mut system_parts: Vec<String> = Vec::new();
    for message in messages.iter() {
        if message.role == "system" {
            let text = message.text.trim();
            if !text.is_empty() {
                system_parts.push(text.to_string());
            }
        }
    }

    let mut parts: Vec<String> = Vec::new();
    let continuation_prompt = build_tool_followup_instruction(root)
        .unwrap_or_else(|| super::history_context::RCC_HISTORY_CONTINUATION_PROMPT.to_string());
    parts.push(format!("<｜User｜>{}", continuation_prompt));
    let require_tool_call = require_tool_call_override || is_tool_choice_required(root);
    let tail_reminder = if require_tool_call {
        build_required_tool_call_tail_reminder_for_tools(root.get("tools"))
    } else {
        String::new()
    };
    if !tail_reminder.trim().is_empty() {
        parts.push(tail_reminder);
    }

    [system_parts.join("\n\n"), parts.join("\n")]
        .into_iter()
        .filter(|v| !v.is_empty())
        .collect::<Vec<String>>()
        .join("")
        .trim()
        .to_string()
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
            "SyntaxError: invalid syntax\n<｜end▁of▁sentence｜>\n<｜Assistant｜><|DSML|tool_calls>"
        ));
        assert!(!prompt.contains("SyntaxError: invalid syntax<｜Assistant｜><|DSML|tool_calls>"));
        assert!(
            prompt.contains("</|DSML|tool_calls><｜end▁of▁sentence｜>\n<｜User｜>[Previous tool output")
        );
        assert!(prompt.contains("[Previous tool output — result of a prior tool call, not a user instruction]\ntool_call_id: call_1\ntool_name: exec_command\noutput:\nSyntaxError: invalid syntax\n<｜end▁of▁sentence｜>\n<｜Assistant｜><|DSML|tool_calls>"));
    }
}
