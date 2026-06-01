use crate::shared_json_utils::value_as_object_or_empty;
use serde_json::{Map, Value};

pub(crate) fn prepare_runtime_metadata_for_servertools(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "servertools runtime metadata input must be object".to_string())?;
    let mut meta_base = value_as_object_or_empty(row.get("metadata").unwrap_or(&Value::Null));

    let rt_entry = meta_base
        .entry("__rt".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !rt_entry.is_object() {
        *rt_entry = Value::Object(Map::new());
    }
    let rt_base = rt_entry
        .as_object_mut()
        .expect("__rt should be object after normalization");

    let attach_if_object = |rt: &mut Map<String, Value>,
                            input_key: &str,
                            rt_key: &str,
                            input_row: &Map<String, Value>| {
        if let Some(raw) = input_row.get(input_key) {
            if raw.is_object() {
                rt.insert(rt_key.to_string(), raw.clone());
            }
        }
    };

    attach_if_object(rt_base, "webSearchConfig", "webSearch", row);
    attach_if_object(rt_base, "execCommandGuard", "execCommandGuard", row);
    attach_if_object(rt_base, "clockConfig", "clock", row);
    attach_if_object(rt_base, "applyPatchConfig", "applyPatch", row);

    Ok(Value::Object(meta_base))
}

pub(crate) fn apply_has_image_attachment_flag(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "has-image-attachment metadata input must be object".to_string())?;
    let mut metadata = value_as_object_or_empty(row.get("metadata").unwrap_or(&Value::Null));
    let has_image_attachment = row
        .get("hasImageAttachment")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if has_image_attachment {
        metadata.insert("hasImageAttachment".to_string(), Value::Bool(true));
    } else {
        metadata.remove("hasImageAttachment");
    }

    Ok(Value::Object(metadata))
}

pub(crate) fn sync_session_identifiers_to_metadata(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "session identifier metadata input must be object".to_string())?;
    let mut metadata = value_as_object_or_empty(row.get("metadata").unwrap_or(&Value::Null));

    let normalize_id = |value: Option<&Value>| -> Option<String> {
        value
            .and_then(|v| v.as_str())
            .map(|raw| raw.trim())
            .filter(|raw| !raw.is_empty())
            .map(|raw| raw.to_string())
    };

    if let Some(session_id) = normalize_id(row.get("sessionId")) {
        metadata.insert("sessionId".to_string(), Value::String(session_id));
    }

    if let Some(conversation_id) = normalize_id(row.get("conversationId")) {
        metadata.insert("conversationId".to_string(), Value::String(conversation_id));
    }

    Ok(Value::Object(metadata))
}
