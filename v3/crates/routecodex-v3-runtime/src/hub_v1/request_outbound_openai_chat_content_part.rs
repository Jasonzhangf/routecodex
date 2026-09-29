use super::{project_outbound_nested_payload_for_target_protocol, V3OutboundTargetProtocol};
use serde_json::{Map, Value};

pub(super) fn normalize_openai_chat_message_content_part(part: &Value) -> Result<Value, String> {
    let mut normalized = project_outbound_nested_payload_for_target_protocol(
        part,
        V3OutboundTargetProtocol::OpenAiChat,
    )?;
    let Some(row) = normalized.as_object_mut() else {
        return Ok(normalized);
    };
    let part_type = row
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match part_type.as_str() {
        "input_text" | "output_text" | "commentary" => {
            row.insert("type".to_string(), Value::String("text".to_string()));
        }
        "input_image" => {
            row.insert("type".to_string(), Value::String("image_url".to_string()));
            let image_url_value = match row.get("image_url").cloned() {
                Some(Value::String(url)) => Some(Value::Object(Map::from_iter([(
                    "url".to_string(),
                    Value::String(url),
                )]))),
                Some(Value::Object(existing)) => Some(Value::Object(existing)),
                _ => None,
            };
            if let Some(image_url) = image_url_value {
                row.insert("image_url".to_string(), image_url);
            }
        }
        _ => {}
    }
    Ok(normalized)
}
