use serde_json::{json, Map, Value};
use std::collections::HashSet;

use super::super::AdapterContext;
use super::user_id::apply_anthropic_claude_code_user_id;

const DEFAULT_SYSTEM_TEXT: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

fn read_claude_code_config_value<'a>(
    adapter_context: &'a AdapterContext,
    key: &str,
) -> Option<&'a Value> {
    adapter_context
        .claude_code
        .as_ref()
        .and_then(|value| value.as_object())
        .and_then(|map| map.get(key))
}

fn resolve_system_text(adapter_context: &AdapterContext) -> String {
    read_claude_code_config_value(adapter_context, "systemText")
        .and_then(|value| value.as_str())
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
        .unwrap_or(DEFAULT_SYSTEM_TEXT)
        .to_string()
}

fn should_preserve_existing_system(adapter_context: &AdapterContext) -> bool {
    !matches!(
        read_claude_code_config_value(adapter_context, "preserveExistingSystemAsUserMessage"),
        Some(Value::Bool(false))
    )
}

fn normalize_system_blocks(system: Option<&Value>) -> Vec<Map<String, Value>> {
    let mut blocks: Vec<Map<String, Value>> = Vec::new();
    let push_text =
        |target: &mut Vec<Map<String, Value>>, text: &str, extra: Option<&Map<String, Value>>| {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return;
            }
            let mut block = extra.cloned().unwrap_or_default();
            block.insert("type".to_string(), Value::String("text".to_string()));
            block.insert("text".to_string(), Value::String(trimmed.to_string()));
            target.push(block);
        };

    let Some(system_value) = system else {
        return blocks;
    };
    match system_value {
        Value::String(text) => {
            push_text(&mut blocks, text, None);
        }
        Value::Array(entries) => {
            for entry in entries {
                match entry {
                    Value::String(text) => push_text(&mut blocks, text, None),
                    Value::Object(obj) => {
                        let text = obj.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        if text.is_empty() {
                            continue;
                        }
                        let mut extra = obj.clone();
                        extra.remove("type");
                        extra.remove("text");
                        push_text(&mut blocks, text, Some(&extra));
                    }
                    _ => {}
                }
            }
        }
        Value::Object(obj) => {
            let text = obj.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if !text.is_empty() {
                let mut extra = obj.clone();
                extra.remove("type");
                extra.remove("text");
                push_text(&mut blocks, text, Some(&extra));
            }
        }
        _ => {}
    }
    blocks
}

fn dedupe_system_blocks_by_text(blocks: Vec<Map<String, Value>>) -> Vec<Map<String, Value>> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut result: Vec<Map<String, Value>> = Vec::new();
    for mut block in blocks {
        let text = block
            .get("text")
            .and_then(|v| v.as_str())
            .map(|raw| raw.trim().to_string())
            .unwrap_or_default();
        if text.is_empty() || seen.contains(&text) {
            continue;
        }
        seen.insert(text.clone());
        block.insert("type".to_string(), Value::String("text".to_string()));
        block.insert("text".to_string(), Value::String(text));
        result.push(block);
    }
    result
}

fn block_text(block: &Map<String, Value>) -> Option<String> {
    block
        .get("text")
        .and_then(|v| v.as_str())
        .map(|text| text.trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
}

fn read_trimmed_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .map(|raw| raw.trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
}

fn should_inject_thinking(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(Value::Null) => true,
        Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        Some(Value::Object(map)) => {
            let has_type = map
                .get("type")
                .and_then(|v| v.as_str())
                .map(|raw| !raw.trim().is_empty())
                .unwrap_or(false);
            !has_type
        }
        Some(Value::String(text)) => text.trim().is_empty(),
        _ => true,
    }
}

fn normalize_effort(value: &str) -> Option<&'static str> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "minimal" | "low" => Some("low"),
        "medium" => Some("medium"),
        "high" | "max" => Some("high"),
        _ => None,
    }
}

fn resolve_effort(adapter_context: &AdapterContext, model: Option<&Value>) -> &'static str {
    if let Some(configured) = adapter_context
        .anthropic_thinking
        .as_deref()
        .and_then(normalize_effort)
    {
        return configured;
    }
    let model_id = read_trimmed_str(model)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if model_id.starts_with("glm-5") {
        "high"
    } else {
        "medium"
    }
}

fn ensure_adaptive_thinking(root: &mut Map<String, Value>) {
    if should_inject_thinking(root.get("thinking")) {
        root.insert("thinking".to_string(), json!({ "type": "adaptive" }));
    }
}

fn ensure_output_effort(root: &mut Map<String, Value>, adapter_context: &AdapterContext) {
    let effort = resolve_effort(adapter_context, root.get("model"));
    match root.get_mut("output_config") {
        Some(Value::Object(map)) => {
            let has_effort = map
                .get("effort")
                .and_then(|v| v.as_str())
                .map(|raw| !raw.trim().is_empty())
                .unwrap_or(false);
            if !has_effort {
                map.insert("effort".to_string(), Value::String(effort.to_string()));
            }
        }
        _ => {
            let mut map = Map::new();
            map.insert("effort".to_string(), Value::String(effort.to_string()));
            root.insert("output_config".to_string(), Value::Object(map));
        }
    }
}

fn prepend_user_content(messages: &mut Vec<Value>, blocks: &[Map<String, Value>]) {
    if blocks.is_empty() {
        return;
    }
    let block_values = blocks
        .iter()
        .cloned()
        .map(Value::Object)
        .collect::<Vec<Value>>();
    if let Some(first) = messages.first_mut() {
        if let Some(first_obj) = first.as_object_mut() {
            let is_user = first_obj
                .get("role")
                .and_then(|value| value.as_str())
                .map(|role| role.eq_ignore_ascii_case("user"))
                .unwrap_or(false);
            if is_user {
                match first_obj.get_mut("content") {
                    Some(Value::String(existing)) => {
                        let injected = blocks
                            .iter()
                            .filter_map(block_text)
                            .collect::<Vec<String>>()
                            .join("\n\n");
                        if existing.trim().is_empty() {
                            *existing = injected;
                        } else if !injected.is_empty() {
                            *existing = format!("{}\n\n{}", injected, existing);
                        }
                    }
                    Some(Value::Array(existing)) => {
                        let mut next = block_values.clone();
                        next.append(existing);
                        *existing = next;
                    }
                    Some(_) => {
                        first_obj.insert("content".to_string(), Value::Array(block_values.clone()));
                    }
                    None => {
                        first_obj.insert("content".to_string(), Value::Array(block_values.clone()));
                    }
                }
                return;
            }
        }
    }
    let mut user_msg = Map::new();
    user_msg.insert("role".to_string(), Value::String("user".to_string()));
    user_msg.insert("content".to_string(), Value::Array(block_values));
    messages.insert(0, Value::Object(user_msg));
}

pub(crate) fn apply_anthropic_claude_code_system_prompt_compat(
    root: &mut Map<String, Value>,
    adapter_context: &AdapterContext,
) {
    let system_text = resolve_system_text(adapter_context);
    let preserve_existing = should_preserve_existing_system(adapter_context);

    apply_anthropic_claude_code_user_id(root, adapter_context);

    let existing_blocks = dedupe_system_blocks_by_text(normalize_system_blocks(root.get("system")))
        .into_iter()
        .filter(|block| block_text(block).unwrap_or_default() != system_text)
        .collect::<Vec<Map<String, Value>>>();

    let mut system_block = Map::new();
    system_block.insert("type".to_string(), Value::String("text".to_string()));
    system_block.insert("text".to_string(), Value::String(system_text));
    root.insert(
        "system".to_string(),
        Value::Array(vec![Value::Object(system_block)]),
    );

    ensure_adaptive_thinking(root);
    ensure_output_effort(root, adapter_context);

    if existing_blocks.is_empty() || !preserve_existing {
        return;
    }

    let messages_was_defined = root.contains_key("messages");
    let mut messages = root
        .get("messages")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    if !messages.is_empty() || messages_was_defined {
        prepend_user_content(&mut messages, &existing_blocks);
        root.insert("messages".to_string(), Value::Array(messages));
    }
}
