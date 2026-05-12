use serde_json::{Map, Value};

use super::prompt::build_deepseek_history_messages;

pub(crate) const RCC_HISTORY_FILENAME: &str = "context.txt";
pub(crate) const RCC_HISTORY_TITLE: &str = "# context";
pub(crate) const RCC_HISTORY_SUMMARY: &str = "Prior conversation history and tool progress.";
pub(crate) const RCC_HISTORY_CONTENT_TYPE: &str = "text/plain; charset=utf-8";
pub(crate) const RCC_HISTORY_CONTINUATION_PROMPT: &str = "Continue from the latest state in the attached context. Treat it as the current working state and answer the latest user request directly.";
pub(crate) const RCC_HISTORY_TOOL_RESUME_PROMPT: &str = "Continue from the latest state in the attached context. The latest tool result has already been submitted. Do not repeat the same tool call just because it appears in history; use that result as completed context and continue to the next necessary step or final answer.";

pub(crate) fn build_history_context_transcript(root: &Map<String, Value>) -> Option<String> {
    let messages = build_deepseek_history_messages(root);
    if messages.is_empty() {
        return None;
    }

    let mut lines: Vec<String> = vec![
        RCC_HISTORY_TITLE.to_string(),
        RCC_HISTORY_SUMMARY.to_string(),
        String::new(),
    ];
    let mut entry_index = 0usize;
    for message in messages {
        let text = message.text.trim();
        if text.is_empty() {
            continue;
        }
        entry_index += 1;
        lines.push(format!(
            "=== {}. {} ===",
            entry_index,
            history_role_label(message.role.as_str())
        ));
        lines.push(text.to_string());
        lines.push(String::new());
    }

    if entry_index == 0 {
        return None;
    }

    let transcript = lines.join("\n").trim().to_string();
    if transcript.is_empty() {
        None
    } else {
        Some(format!("{}\n", transcript))
    }
}

fn history_role_label(role: &str) -> &'static str {
    match role.trim().to_ascii_lowercase().as_str() {
        "system" => "SYSTEM",
        "user" => "USER",
        "assistant" => "ASSISTANT",
        "tool" | "function" => "TOOL",
        _ => "UNKNOWN",
    }
}

#[cfg(test)]
mod tests {
    use super::{build_history_context_transcript, RCC_HISTORY_CONTINUATION_PROMPT};
    use serde_json::{json, Map, Value};

    #[test]
    fn builds_rcc_history_transcript_with_tool_context() {
        let root_value = json!({
            "messages": [
                {"role": "system", "content": "follow contract"},
                {"role": "user", "content": "请继续"},
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"bash -lc 'pwd'\"}"
                            }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "name": "exec_command",
                    "content": "pwd output: /workspace"
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
        let root: Map<String, Value> = root_value.as_object().expect("root").clone();
        let transcript = build_history_context_transcript(&root).expect("transcript");
        assert!(transcript.starts_with("# context\nPrior conversation history and tool progress.\n\n"));
        assert!(transcript.contains("=== 1. SYSTEM ===\nfollow contract"));
        assert!(transcript.contains("=== 2. USER ===\n请继续"));
        assert!(transcript.contains("=== 3. ASSISTANT ==="));
        assert!(transcript.contains("<|DSML|tool_calls>"));
        assert!(transcript.contains("tool_name: exec_command"));
        assert!(transcript.contains("=== 4. TOOL ==="));
        assert!(transcript.contains("tool_call_id: call_1"));
        assert!(transcript.contains("tool_name: exec_command"));
        assert!(transcript.contains("pwd output: /workspace"));
        assert!(RCC_HISTORY_CONTINUATION_PROMPT.contains("attached context"));
    }
}
