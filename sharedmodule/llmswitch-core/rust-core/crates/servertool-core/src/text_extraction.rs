//! Rust-owned servertool response text extraction.

use serde_json::Value;

pub fn extract_text_from_chat_like(payload: &Value) -> String {
    let current = unwrap_chat_like_payload(payload);

    if let Some(text) = extract_from_choices(current) {
        return text;
    }
    if let Some(text) = extract_from_output(current) {
        return text;
    }
    if let Some(text) =
        extract_from_web_search(current).or_else(|| extract_from_web_search(payload))
    {
        return text;
    }

    String::new()
}

fn unwrap_chat_like_payload(payload: &Value) -> &Value {
    let mut current = payload;
    for _ in 0..16 {
        let Some(object) = current.as_object() else {
            break;
        };
        if object.get("choices").and_then(Value::as_array).is_some()
            || object.get("output").and_then(Value::as_array).is_some()
        {
            break;
        }
        if let Some(data) = object.get("data").filter(|value| value.is_object()) {
            current = data;
            continue;
        }
        if let Some(response) = object.get("response").filter(|value| value.is_object()) {
            current = response;
            continue;
        }
        break;
    }
    current
}

fn extract_from_choices(payload: &Value) -> Option<String> {
    let first = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())?;
    let message = first.get("message")?;
    let content = message.get("content")?;
    if let Some(text) = trim_non_empty(content.as_str()) {
        return Some(text.to_string());
    }

    let parts = content.as_array()?;
    let mut texts = Vec::<String>::new();
    for part in parts {
        if let Some(text) = part.as_str() {
            texts.push(text.to_string());
            continue;
        }
        let Some(object) = part.as_object() else {
            continue;
        };
        if let Some(text) = object
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| object.get("content").and_then(Value::as_str))
        {
            texts.push(text.to_string());
        }
    }

    trim_joined(texts)
}

fn extract_from_output(payload: &Value) -> Option<String> {
    let output = payload.get("output").and_then(Value::as_array)?;
    let mut texts = Vec::<String>::new();
    for entry in output {
        let Some(blocks) = entry.get("content").and_then(Value::as_array) else {
            continue;
        };
        for block in blocks {
            let Some(object) = block.as_object() else {
                continue;
            };
            if let Some(text) = object
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| object.get("output_text").and_then(Value::as_str))
                .or_else(|| object.get("content").and_then(Value::as_str))
            {
                texts.push(text.to_string());
            }
        }
    }

    trim_joined(texts)
}

fn extract_from_web_search(payload: &Value) -> Option<String> {
    let items = payload.get("web_search").and_then(Value::as_array)?;
    let mut lines = Vec::<String>::new();
    for (index, item) in items
        .iter()
        .filter_map(Value::as_object)
        .take(5)
        .enumerate()
    {
        let idx = trim_non_empty(item.get("refer").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| (index + 1).to_string());
        let title = trim_non_empty(item.get("title").and_then(Value::as_str));
        let media = trim_non_empty(item.get("media").and_then(Value::as_str));
        let date = trim_non_empty(item.get("publish_date").and_then(Value::as_str));
        let content = trim_non_empty(item.get("content").and_then(Value::as_str));
        let link = trim_non_empty(item.get("link").and_then(Value::as_str));

        let header_parts: Vec<&str> = [title, media, date].into_iter().flatten().collect();
        let header = if header_parts.is_empty() {
            "搜索结果".to_string()
        } else {
            header_parts.join(" · ")
        };

        let mut segments = vec![format!("【{idx}】{header}")];
        if let Some(content) = content {
            segments.push(content.to_string());
        }
        if let Some(link) = link {
            segments.push(link.to_string());
        }
        lines.push(segments.join("\n"));
    }

    trim_joined_with(lines, "\n\n")
}

fn trim_non_empty(value: Option<&str>) -> Option<&str> {
    let value = value?.trim();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn trim_joined(values: Vec<String>) -> Option<String> {
    trim_joined_with(values, "\n")
}

fn trim_joined_with(values: Vec<String>, separator: &str) -> Option<String> {
    let joined = values.join(separator);
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_nested_chat_choice_string_content() {
        let payload = json!({
            "data": {
                "response": {
                    "choices": [{
                        "message": { "content": "  answer  " }
                    }]
                }
            }
        });

        assert_eq!(extract_text_from_chat_like(&payload), "answer");
    }

    #[test]
    fn extracts_chat_choice_array_text_parts() {
        let payload = json!({
            "choices": [{
                "message": {
                    "content": [
                        { "text": "one" },
                        { "content": "two" },
                        "three"
                    ]
                }
            }]
        });

        assert_eq!(extract_text_from_chat_like(&payload), "one\ntwo\nthree");
    }

    #[test]
    fn extracts_responses_output_text_blocks() {
        let payload = json!({
            "output": [{
                "type": "message",
                "content": [
                    { "type": "output_text", "text": "one" },
                    { "type": "output_text", "output_text": "two" },
                    { "type": "text", "content": "three" }
                ]
            }]
        });

        assert_eq!(extract_text_from_chat_like(&payload), "one\ntwo\nthree");
    }

    #[test]
    fn extracts_web_search_summary_when_no_chat_text_exists() {
        let payload = json!({
            "web_search": [
                {
                    "refer": "A",
                    "title": "Title",
                    "media": "Media",
                    "publish_date": "2026-06-08",
                    "content": "Body",
                    "link": "https://example.test/a"
                },
                { "content": "Body 2" }
            ]
        });

        assert_eq!(
            extract_text_from_chat_like(&payload),
            "【A】Title · Media · 2026-06-08\nBody\nhttps://example.test/a\n\n【2】搜索结果\nBody 2"
        );
    }

    #[test]
    fn limits_web_search_summary_to_first_five_items() {
        let payload = json!({
            "web_search": [
                { "content": "1" },
                { "content": "2" },
                { "content": "3" },
                { "content": "4" },
                { "content": "5" },
                { "content": "6" }
            ]
        });

        let text = extract_text_from_chat_like(&payload);
        assert!(text.contains("【5】搜索结果\n5"));
        assert!(!text.contains("【6】"));
    }
}
