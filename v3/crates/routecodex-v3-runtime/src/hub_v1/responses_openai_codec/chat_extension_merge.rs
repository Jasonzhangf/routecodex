use serde_json::{Map, Value};

use super::{ANTHROPIC_REASONING_BLOCKS_EXTENSION, ANTHROPIC_REASONING_EXTENSION};

/// Merge the carrier from a coalesced assistant item into the assistant
/// message it folds onto. Provider reasoning blocks keep their original value
/// associations; only unrelated extension namespaces may merge recursively.
pub(super) fn merge_chat_extension(
    target: &mut Map<String, Value>,
    source: &Value,
) -> Result<(), String> {
    let source = source.as_object().ok_or_else(|| {
        "OpenAI Chat provider encoding routecodex_chat_extension is not an object".to_string()
    })?;
    let target_extension = target
        .entry("routecodex_chat_extension".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| {
            "OpenAI Chat provider encoding routecodex_chat_extension is not an object".to_string()
        })?;
    for (key, value) in source {
        match key.as_str() {
            ANTHROPIC_REASONING_BLOCKS_EXTENSION => {
                append_reasoning_blocks(target_extension, value)?;
            }
            ANTHROPIC_REASONING_EXTENSION => {
                target_extension
                    .entry(key.clone())
                    .or_insert_with(|| value.clone());
            }
            _ => merge_unrelated_objects(target_extension, key, value),
        }
    }
    Ok(())
}

fn append_reasoning_blocks(target: &mut Map<String, Value>, source: &Value) -> Result<(), String> {
    let source = source.as_array().ok_or_else(|| {
        "OpenAI Chat provider encoding anthropic_reasoning_blocks is not an array".to_string()
    })?;
    let target = target
        .entry(ANTHROPIC_REASONING_BLOCKS_EXTENSION.to_string())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| {
            "OpenAI Chat provider encoding anthropic_reasoning_blocks is not an array".to_string()
        })?;
    target.extend(source.iter().cloned());
    Ok(())
}

fn merge_unrelated_objects(target: &mut Map<String, Value>, key: &str, source: &Value) {
    match (target.get_mut(key), source) {
        (Some(Value::Object(target_object)), Value::Object(source_object)) => {
            merge_unrelated_object_members(target_object, source_object);
        }
        _ => {
            target.insert(key.to_string(), source.clone());
        }
    }
}

fn merge_unrelated_object_members(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (key, value) in source {
        merge_unrelated_objects(target, key, value);
    }
}
