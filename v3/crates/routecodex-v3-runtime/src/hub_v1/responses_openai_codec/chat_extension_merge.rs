use serde_json::{Map, Value};

/// Merge the carrier from a coalesced assistant item into the assistant
/// message it folds onto. Unrelated extension keys from both items survive and
/// later leaves win, so folding a reasoning item never drops its provider
/// extension (`cache_control` and similar).
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
    merge_objects(target_extension, source);
    Ok(())
}

fn merge_objects(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (key, value) in source {
        match (target.get_mut(key), value) {
            (Some(Value::Object(target_object)), Value::Object(source_object)) => {
                merge_objects(target_object, source_object);
            }
            _ => {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}
