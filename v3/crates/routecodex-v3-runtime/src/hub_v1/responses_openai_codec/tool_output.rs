use serde_json::{json, Map, Value};

pub(crate) fn canonical_content(output: &Value) -> Result<Value, String> {
    let parsed_output = output
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let image_output = parsed_output.as_ref().unwrap_or(output);
    if image_output.as_array().is_some_and(|parts| {
        parts
            .iter()
            .any(|part| part.as_object().and_then(image_url).is_some())
    }) {
        Ok(Value::Array(
            image_output
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|part| {
                    let (converted, represented): (Value, &[&str]) =
                        if let Some(url) = part.as_object().and_then(image_url) {
                            (
                                json!({"type":"image_url","image_url":url}),
                                &[
                                    "type",
                                    "image_url",
                                    "url",
                                    "file_url",
                                    "data",
                                    "media_type",
                                    "mime_type",
                                ],
                            )
                        } else if matches!(
                            part.get("type").and_then(Value::as_str),
                            Some("input_text" | "output_text" | "text")
                        ) && part.get("text").is_some_and(Value::is_string)
                        {
                            (
                                json!({"type":"text","text":part["text"]}),
                                &["type", "text"],
                            )
                        } else {
                            // Chat/Anthropic cannot represent every Responses tool part.
                            // Keep its complete opaque value as text, as before decoding.
                            return vec![json!({"type":"text","text":part.to_string()})];
                        };
                    let mut extras: Map<String, Value> = part
                        .as_object()
                        .unwrap()
                        .iter()
                        .filter(|(key, _)| !represented.contains(&key.as_str()))
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect();
                    // Source aliases map to one standard image URL. Keep fields
                    // that the image/text representation cannot carry as opaque
                    // text beside that part, without copying the image bytes.
                    for field in ["image_url", "url", "file_url"] {
                        if let Some(source) = part.get(field).and_then(Value::as_object) {
                            let fields: Map<String, Value> = source
                                .iter()
                                .filter(|(key, _)| key.as_str() != "url")
                                .map(|(key, value)| (key.clone(), value.clone()))
                                .collect();
                            if !fields.is_empty() {
                                extras.insert(field.into(), Value::Object(fields));
                            }
                        }
                    }
                    let mut parts = vec![converted];
                    if !extras.is_empty() {
                        parts.push(json!({"type":"text","text":Value::Object(extras).to_string()}));
                    }
                    parts
                })
                .collect(),
        ))
    } else {
        Ok(Value::String(match output {
            Value::String(text) => text.clone(),
            other => serde_json::to_string(other).map_err(|error| error.to_string())?,
        }))
    }
}

pub(crate) fn image_url(part: &Map<String, Value>) -> Option<Value> {
    match part.get("type").and_then(Value::as_str) {
        Some("input_image" | "image_url" | "image") => {}
        Some(_) => return None,
        None if part.contains_key("image_url")
            || part.contains_key("file_url")
            || part.contains_key("data") => {}
        None => return None,
    }
    let source = part
        .get("image_url")
        .or_else(|| part.get("url"))
        .or_else(|| part.get("file_url"))
        .cloned()
        .or_else(|| {
            let data = part.get("data")?.as_str()?;
            if data.starts_with("data:image/") {
                Some(Value::String(data.to_string()))
            } else {
                let media_type = part
                    .get("media_type")
                    .or_else(|| part.get("mime_type"))?
                    .as_str()?;
                media_type
                    .starts_with("image/")
                    .then(|| Value::String(format!("data:{media_type};base64,{data}")))
            }
        })?;
    let mut url = match source {
        Value::String(url) if !url.is_empty() => {
            Map::from_iter([("url".to_string(), Value::String(url))])
        }
        Value::Object(url)
            if url
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty()) =>
        {
            url
        }
        _ => return None,
    };
    if let Some(detail) = part.get("detail") {
        url.entry("detail".to_string())
            .or_insert_with(|| detail.clone());
    }
    Some(Value::Object(url))
}
