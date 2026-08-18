use serde_json::{Map, Value};

/// cc-sol direct responses compatibility.
///
/// The gateway sometimes embeds reasoning in `<thinking>` tags inside the
/// current response text.  Paired blocks become `reasoning_content`; stray
/// tags are removed while preserving their surrounding text.
pub(crate) fn apply_response_compat(payload: Value) -> Value {
    transform_value(payload).0
}

fn transform_value(value: Value) -> (Value, Vec<String>) {
    match value {
        Value::Object(object) => transform_object(object),
        Value::Array(items) => {
            let mut reasoning = Vec::new();
            let items = items
                .into_iter()
                .map(|item| {
                    let (item, item_reasoning) = transform_value(item);
                    reasoning.extend(item_reasoning);
                    item
                })
                .collect();
            (Value::Array(items), reasoning)
        }
        Value::String(text) => {
            let (text, reasoning) = split_thinking_tags(&text);
            (Value::String(text), reasoning)
        }
        other => (other, Vec::new()),
    }
}

fn transform_object(mut object: Map<String, Value>) -> (Value, Vec<String>) {
    let mut reasoning = Vec::new();
    for value in object.values_mut() {
        let current = std::mem::take(value);
        let (current, current_reasoning) = transform_value(current);
        *value = current;
        reasoning.extend(current_reasoning);
    }
    if !reasoning.is_empty() {
        let joined = reasoning.join("\n");
        let existing = object
            .get("reasoning_content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| format!("{text}\n{joined}"));
        object.insert(
            "reasoning_content".to_string(),
            Value::String(existing.unwrap_or(joined)),
        );
    }
    (Value::Object(object), reasoning)
}

fn split_thinking_tags(text: &str) -> (String, Vec<String>) {
    let mut visible = String::with_capacity(text.len());
    let mut reasoning = Vec::new();
    let mut cursor = 0;
    while let Some(open_rel) = text[cursor..].find("<thinking>") {
        let open = cursor + open_rel;
        visible.push_str(&text[cursor..open]);
        let content_start = open + "<thinking>".len();
        let Some(close_rel) = text[content_start..].find("</thinking>") else {
            visible.push_str(&text[content_start..]);
            return (visible.replace("</thinking>", ""), reasoning);
        };
        let close = content_start + close_rel;
        let segment = text[content_start..close].trim();
        if !segment.is_empty() {
            reasoning.push(segment.to_string());
        }
        cursor = close + "</thinking>".len();
    }
    visible.push_str(&text[cursor..]);
    (visible.replace("</thinking>", ""), reasoning)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_paired_thinking_and_strips_unpaired_tags() {
        let mapped = apply_response_compat(json!({
            "output": [{"type": "message", "text": "<thinking>plan</thinking>answer"}],
            "tail": "<thinking>still visible"
        }));
        assert_eq!(mapped["output"][0]["text"], "answer");
        assert_eq!(mapped["output"][0]["reasoning_content"], "plan");
        assert_eq!(mapped["tail"], "still visible");
        assert!(!mapped.to_string().contains("<thinking>"));
    }

    #[test]
    fn preserves_text_when_only_an_unpaired_tag_is_present() {
        let mapped = apply_response_compat(json!({"text": "<thinking>Need update"}));
        assert_eq!(mapped["text"], "Need update");
        assert!(mapped.get("reasoning_content").is_none());
    }
}
