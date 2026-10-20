use super::*;

pub(crate) fn project_v3_responses_reasoning_item_as_anthropic_content(
    item: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let object = item
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "reasoning item",
        })?;
    let content_text =
        responses_reasoning_text_entries(object.get("content"), &["reasoning_text"])?;
    let summary_text = responses_reasoning_text_entries(object.get("summary"), &["summary_text"])?;
    if !content_text.is_empty() && !summary_text.is_empty() {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "reasoning item",
        });
    }
    let thinking = if !content_text.is_empty() {
        content_text.join("\n\n")
    } else {
        summary_text.join("\n\n")
    };
    let encrypted_content = match object.get("encrypted_content") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let value = value
                .as_str()
                .ok_or(V3AnthropicCodecError::MalformedField {
                    field: "reasoning item",
                })?;
            if value.trim().is_empty() {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "reasoning item",
                });
            }
            Some(value)
        }
    };
    if !thinking.is_empty() {
        let mut block = Map::new();
        block.insert("type".to_string(), Value::String("thinking".to_string()));
        block.insert("thinking".to_string(), Value::String(thinking));
        if let Some(signature) = encrypted_content {
            block.insert(
                "signature".to_string(),
                Value::String(signature.to_string()),
            );
        }
        restore_anthropic_reasoning_extensions(object, &mut block);
        return Ok(Value::Object(block));
    }
    if let Some(data) = encrypted_content {
        let mut block = Map::new();
        block.insert(
            "type".to_string(),
            Value::String("redacted_thinking".to_string()),
        );
        block.insert("data".to_string(), Value::String(data.to_string()));
        restore_anthropic_reasoning_extensions(object, &mut block);
        return Ok(Value::Object(block));
    }
    Err(V3AnthropicCodecError::MalformedField {
        field: "reasoning item",
    })
}

pub(super) fn restore_anthropic_reasoning_extensions(
    item: &Map<String, Value>,
    block: &mut Map<String, Value>,
) {
    let Some(extension) = item
        .get("routecodex_chat_extension")
        .and_then(Value::as_object)
        .and_then(|extension| extension.get(ANTHROPIC_REASONING_EXTENSION))
        .and_then(Value::as_object)
    else {
        return;
    };
    for (key, value) in extension {
        if key != "type" {
            block.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
}

fn responses_reasoning_text_entries(
    value: Option<&Value>,
    accepted_types: &[&str],
) -> Result<Vec<String>, V3AnthropicCodecError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let entries = value
        .as_array()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "reasoning item",
        })?;
    let mut text = Vec::new();
    for entry in entries {
        let object = entry
            .as_object()
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "reasoning item",
            })?;
        if !accepted_types
            .iter()
            .any(|accepted| object.get("type").and_then(Value::as_str) == Some(*accepted))
        {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "reasoning item",
            });
        }
        let value = object
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "reasoning item",
            })?;
        text.push(value.to_string());
    }
    Ok(text)
}
