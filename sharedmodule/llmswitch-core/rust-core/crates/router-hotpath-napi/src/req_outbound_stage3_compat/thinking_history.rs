use crate::shared_json_utils::read_trimmed_string;
use serde_json::{Map, Value};

use super::AdapterContext;

fn read_trimmed(value: Option<&String>) -> Option<String> {
    let raw = value?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

fn has_non_empty_tool_calls(row: &Map<String, Value>) -> bool {
    row.get("tool_calls")
        .and_then(|v| v.as_array())
        .map(|entries| !entries.is_empty())
        .unwrap_or(false)
}

fn find_last_user_index(messages: &[Value]) -> Option<usize> {
    let mut last_user_index: Option<usize> = None;
    for (index, message) in messages.iter().enumerate() {
        let Some(row) = message.as_object() else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role == "user" {
            last_user_index = Some(index);
        }
    }
    last_user_index
}

fn missing_reasoning_content(row: &Map<String, Value>) -> bool {
    row.get("reasoning_content")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().is_empty())
        .unwrap_or(true)
}

fn provider_matches_local_deepseek_thinking_chain(adapter_context: &AdapterContext) -> bool {
    let provider_id = read_trimmed(adapter_context.provider_id.as_ref());
    if matches!(provider_id.as_deref(), Some("omlx") | Some("rapidmlx")) {
        return true;
    }

    let Some(provider_key) = read_trimmed(adapter_context.provider_key.as_ref()) else {
        return false;
    };
    provider_key.starts_with("omlx.") || provider_key.starts_with("rapidmlx.")
}

fn model_matches_local_deepseek_thinking_chain(
    adapter_context: &AdapterContext,
    payload: &Value,
) -> bool {
    let payload_model = payload
        .as_object()
        .and_then(|root| root.get("model"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase());
    let model_tokens = [
        read_trimmed(adapter_context.model_id.as_ref()),
        read_trimmed(adapter_context.client_model_id.as_ref()),
        read_trimmed(adapter_context.original_model_id.as_ref()),
        payload_model,
    ];
    model_tokens
        .iter()
        .flatten()
        .any(|token| token.starts_with("deepseek-v4-flash-mxfp8"))
}

fn provider_matches_deepseek(adapter_context: &AdapterContext) -> bool {
    let provider_id = read_trimmed(adapter_context.provider_id.as_ref());
    if matches!(provider_id.as_deref(), Some("deepseek")) {
        return true;
    }
    let provider_key = read_trimmed(adapter_context.provider_key.as_ref());
    matches!(provider_key.as_deref(), Some(key) if key.starts_with("deepseek."))
}

fn model_matches_deepseek_family(adapter_context: &AdapterContext, payload: &Value) -> bool {
    let payload_model = payload
        .as_object()
        .and_then(|root| root.get("model"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase());
    let model_tokens = [
        read_trimmed(adapter_context.model_id.as_ref()),
        read_trimmed(adapter_context.client_model_id.as_ref()),
        read_trimmed(adapter_context.original_model_id.as_ref()),
        payload_model,
    ];
    model_tokens.iter().flatten().any(|token| {
        token.starts_with("deepseek-v4-")
            || token.contains(".deepseek-v4-")
            || token.starts_with("deepseek-chat")
            || token.contains(".deepseek-chat")
    })
}

fn is_thinking_enabled(payload: &Value) -> bool {
    let Some(thinking) = payload.as_object().and_then(|root| root.get("thinking")) else {
        return true;
    };
    if thinking == &Value::Bool(false) || thinking == &Value::Null {
        return false;
    }
    if thinking == &Value::Bool(true) {
        return true;
    }
    if let Some(token) = thinking.as_str() {
        let normalized = token.trim().to_ascii_lowercase();
        return !normalized.is_empty()
            && !matches!(normalized.as_str(), "disabled" | "off" | "false" | "none");
    }
    let Some(row) = thinking.as_object() else {
        return true;
    };
    if row.get("enabled") == Some(&Value::Bool(false)) {
        return false;
    }
    !parse_disabled_type(row.get("type")) && !parse_disabled_type(row.get("mode"))
}

pub(crate) fn should_apply_local_deepseek_thinking_history_compat(
    payload: &Value,
    adapter_context: &AdapterContext,
) -> bool {
    let Some(provider_protocol) = read_trimmed(adapter_context.provider_protocol.as_ref()) else {
        return false;
    };
    if provider_protocol != "openai-chat" {
        return false;
    }
    provider_matches_local_deepseek_thinking_chain(adapter_context)
        && model_matches_local_deepseek_thinking_chain(adapter_context, payload)
}

pub(crate) fn should_apply_deepseek_thinking_history_compat(
    payload: &Value,
    adapter_context: &AdapterContext,
) -> bool {
    let Some(provider_protocol) = read_trimmed(adapter_context.provider_protocol.as_ref()) else {
        return false;
    };
    if provider_protocol != "openai-chat" && provider_protocol != "anthropic-messages" {
        return false;
    }
    model_matches_deepseek_family(adapter_context, payload) && is_thinking_enabled(payload)
}

fn parse_disabled_type(raw: Option<&Value>) -> bool {
    let Some(token) = raw.and_then(|v| v.as_str()) else {
        return false;
    };
    let normalized = token.trim().to_ascii_lowercase();
    matches!(normalized.as_str(), "disabled" | "off" | "false" | "none")
}

fn is_anthropic_thinking_enabled(payload: &Value) -> bool {
    let thinking = payload.as_object().and_then(|root| root.get("thinking"));
    let Some(thinking) = thinking else {
        return false;
    };
    if thinking == &Value::Bool(false) || thinking == &Value::Null {
        return false;
    }
    if thinking == &Value::Bool(true) {
        return true;
    }
    if let Some(token) = thinking.as_str() {
        let normalized = token.trim().to_ascii_lowercase();
        return !normalized.is_empty()
            && !matches!(normalized.as_str(), "disabled" | "off" | "false" | "none");
    }
    let Some(row) = thinking.as_object() else {
        return false;
    };
    if row.get("enabled") == Some(&Value::Bool(false)) {
        return false;
    }
    if parse_disabled_type(row.get("type")) || parse_disabled_type(row.get("mode")) {
        return false;
    }
    true
}

pub(crate) fn should_apply_anthropic_thinking_history_compat(
    payload: &Value,
    adapter_context: &AdapterContext,
) -> bool {
    let Some(provider_protocol) = read_trimmed(adapter_context.provider_protocol.as_ref()) else {
        return false;
    };
    provider_protocol == "anthropic-messages" && is_anthropic_thinking_enabled(payload)
}

pub(crate) fn fill_reasoning_content_for_tool_calls(root: &mut Map<String, Value>) {
    let Some(messages) = root.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for message in messages.iter_mut() {
        let Some(row) = message.as_object_mut() else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role != "assistant" || !has_non_empty_tool_calls(row) || !missing_reasoning_content(row)
        {
            continue;
        }
        row.insert(
            "reasoning_content".to_string(),
            Value::String(".".to_string()),
        );
    }
}

pub(crate) fn mirror_assistant_content_into_reasoning_content(root: &mut Map<String, Value>) {
    let Some(messages) = root.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for message in messages.iter_mut() {
        let Some(row) = message.as_object_mut() else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role != "assistant" || has_non_empty_tool_calls(row) || !missing_reasoning_content(row) {
            continue;
        }
        let Some(content) = row.get("content").and_then(|v| v.as_str()) else {
            continue;
        };
        if content.trim().is_empty() {
            continue;
        }
        row.insert(
            "reasoning_content".to_string(),
            Value::String(content.to_string()),
        );
    }
}

pub(crate) fn move_post_last_user_assistant_content_into_reasoning(root: &mut Map<String, Value>) {
    let Some(messages) = root.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return;
    };
    let last_user_index = find_last_user_index(messages.as_slice());
    let Some(last_user_index) = last_user_index else {
        return;
    };

    for (index, message) in messages.iter_mut().enumerate() {
        if index <= last_user_index {
            continue;
        }
        let Some(row) = message.as_object_mut() else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role != "assistant" || has_non_empty_tool_calls(row) {
            continue;
        }
        let Some(content) = row.get("content").and_then(|v| v.as_str()) else {
            continue;
        };
        if content.trim().is_empty() {
            continue;
        }
        if missing_reasoning_content(row) {
            row.insert(
                "reasoning_content".to_string(),
                Value::String(content.to_string()),
            );
        }
        row.insert("content".to_string(), Value::String(String::new()));
    }
}

pub(crate) fn ensure_reasoning_content_for_assistant_history(root: &mut Map<String, Value>) {
    fill_reasoning_content_for_tool_calls(root);
    mirror_assistant_content_into_reasoning_content(root);
    move_post_last_user_assistant_content_into_reasoning(root);
}

fn content_has_thinking_block(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().any(|entry| {
                let Some(row) = entry.as_object() else {
                    return false;
                };
                let block_type = row
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase();
                if block_type == "thinking" {
                    return true;
                }
                row.get("thinking")
                    .and_then(|v| v.as_str())
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

pub(crate) fn ensure_deepseek_thinking_content_for_assistant_history(
    root: &mut Map<String, Value>,
) {
    ensure_reasoning_content_for_assistant_history(root);
    strip_anthropic_thinking_blocks_for_openai_chat(root);
    strip_deepseek_openai_chat_unsupported_tool_schema_fields(root);
}

pub(crate) fn ensure_deepseek_anthropic_thinking_block_for_tool_use_history(
    root: &mut Map<String, Value>,
) {
    let Some(messages) = root.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return;
    };

    for message in messages.iter_mut() {
        let Some(row) = message.as_object_mut() else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role != "assistant" || !has_non_empty_tool_calls(row) {
            continue;
        }
        if content_has_thinking_block(row.get("content")) {
            continue;
        }
        let Some(reasoning) = read_trimmed_string(row.get("reasoning_content")) else {
            continue;
        };
        row.insert(
            "content".to_string(),
            Value::Array(vec![serde_json::json!({
                "type": "thinking",
                "thinking": reasoning,
            })]),
        );
    }
}

pub(crate) fn strip_anthropic_thinking_blocks_for_openai_chat(root: &mut Map<String, Value>) {
    let Some(messages) = root.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for message in messages.iter_mut() {
        let Some(row) = message.as_object_mut() else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role != "assistant" {
            continue;
        }
        if !has_non_empty_tool_calls(row) {
            continue;
        }
        let Some(content) = row.get("content") else {
            continue;
        };
        if !content_has_thinking_block(Some(content)) {
            continue;
        }
        row.insert("content".to_string(), Value::String(String::new()));
    }
}

pub(crate) fn strip_deepseek_openai_chat_unsupported_tool_schema_fields(
    root: &mut Map<String, Value>,
) {
    root.remove("parallel_tool_calls");

    let Some(tools) = root.get_mut("tools").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for tool in tools.iter_mut() {
        let Some(tool_obj) = tool.as_object_mut() else {
            continue;
        };
        let Some(function_obj) = tool_obj.get_mut("function").and_then(|v| v.as_object_mut())
        else {
            continue;
        };
        function_obj.remove("strict");
    }
}

fn collect_anthropic_text_from_content(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        }
        Value::Array(items) => {
            let mut out: Vec<String> = Vec::new();
            for entry in items {
                let Some(row) = entry.as_object() else {
                    continue;
                };
                let block_type = row
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase();
                if block_type != "text" && block_type != "thinking" {
                    continue;
                }
                if let Some(text) = read_trimmed_string(row.get("text")) {
                    out.push(text);
                } else if let Some(text) = read_trimmed_string(row.get("content")) {
                    out.push(text);
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out.join("\n"))
            }
        }
        _ => None,
    }
}

fn anthropic_content_has_tool_use(value: &Value) -> bool {
    value
        .as_array()
        .map(|items| {
            items.iter().any(|entry| {
                entry
                    .as_object()
                    .and_then(|row| row.get("type"))
                    .and_then(|v| v.as_str())
                    .map(|kind| kind.trim().eq_ignore_ascii_case("tool_use"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn anthropic_content_is_safe_to_clear(value: &Value) -> bool {
    match value {
        Value::String(_) => true,
        Value::Array(items) => items.iter().all(|entry| {
            entry
                .as_object()
                .and_then(|row| row.get("type"))
                .and_then(|v| v.as_str())
                .map(|kind| {
                    matches!(
                        kind.trim().to_ascii_lowercase().as_str(),
                        "text" | "thinking" | "reasoning"
                    )
                })
                .unwrap_or(false)
        }),
        _ => false,
    }
}

pub(crate) fn ensure_reasoning_content_for_anthropic_assistant_history(
    root: &mut Map<String, Value>,
) {
    let Some(messages) = root.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return;
    };

    for message in messages.iter_mut() {
        let Some(row) = message.as_object_mut() else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role != "assistant" || !missing_reasoning_content(row) {
            continue;
        }
        let Some(content) = row.get("content") else {
            continue;
        };
        let text = collect_anthropic_text_from_content(content);
        let has_tool_use = anthropic_content_has_tool_use(content);
        if has_tool_use {
            row.insert(
                "reasoning_content".to_string(),
                Value::String(text.unwrap_or_else(|| ".".to_string())),
            );
            continue;
        }
        if let Some(text) = text {
            row.insert("reasoning_content".to_string(), Value::String(text));
        }
    }

    let Some(last_user_index) = find_last_user_index(messages.as_slice()) else {
        return;
    };

    for (index, message) in messages.iter_mut().enumerate() {
        if index <= last_user_index {
            continue;
        }
        let Some(row) = message.as_object_mut() else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role != "assistant" {
            continue;
        }
        let Some(content) = row.get("content").cloned() else {
            continue;
        };
        if anthropic_content_has_tool_use(&content) || !anthropic_content_is_safe_to_clear(&content)
        {
            continue;
        }
        let Some(text) = collect_anthropic_text_from_content(&content) else {
            continue;
        };
        if missing_reasoning_content(row) {
            row.insert("reasoning_content".to_string(), Value::String(text));
        }
        row.insert("content".to_string(), Value::String(String::new()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deepseek_anthropic_tool_use_history_injects_thinking_block() {
        let mut root = json!({
            "messages": [
                {
                    "role": "assistant",
                    "reasoning_content": "need to call tool",
                    "content": [
                        { "type": "tool_use", "id": "call_1", "name": "exec_command", "input": { "cmd": "pwd" } }
                    ]
                }
            ]
        });
        let root_obj = root.as_object_mut().expect("object");
        ensure_deepseek_anthropic_thinking_block_for_tool_use_history(root_obj);
        let messages = root_obj
            .get("messages")
            .and_then(|v| v.as_array())
            .expect("messages");
        let content = messages[0]
            .as_object()
            .and_then(|v| v.get("content"))
            .and_then(|v| v.as_array())
            .expect("content");
        assert_eq!(
            content
                .first()
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str()),
            Some("thinking")
        );
    }
}
