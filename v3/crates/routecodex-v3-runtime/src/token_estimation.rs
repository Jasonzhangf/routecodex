// feature_id: v3.virtual_router_full_function
use serde_json::Value;
use tiktoken_rs::{
    cl100k_base_singleton, o200k_base_singleton, p50k_base_singleton, p50k_edit_singleton,
    r50k_base_singleton, CoreBPE,
};

use crate::nodes::detect_v3_media_kind;

pub(crate) fn estimate_v3_request_tokens(body: &Value) -> u64 {
    let encoder = select_v3_request_encoder(body);
    let mut total_tokens: usize = 0;
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for message in messages {
            total_tokens += count_v3_message_tokens(message, encoder);
        }
    }
    let request_extras = count_v3_request_extras_tokens(body, encoder);
    total_tokens += request_extras;
    let responses_context_tokens = count_v3_responses_context_tokens(body, encoder);
    total_tokens.max(responses_context_tokens + request_extras) as u64
}

fn select_v3_request_encoder(body: &Value) -> &'static CoreBPE {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    match v3_tiktoken_encoding_name(model) {
        "o200k_base" => o200k_base_singleton(),
        "p50k_base" => p50k_base_singleton(),
        "p50k_edit" => p50k_edit_singleton(),
        "r50k_base" | "gpt2" => r50k_base_singleton(),
        _ => cl100k_base_singleton(),
    }
}

fn v3_tiktoken_encoding_name(model: &str) -> &'static str {
    match model {
        "gpt-4o"
        | "gpt-4o-2024-05-13"
        | "gpt-4o-2024-08-06"
        | "gpt-4o-2024-11-20"
        | "gpt-4o-mini-2024-07-18"
        | "gpt-4o-mini"
        | "gpt-4o-search-preview"
        | "gpt-4o-search-preview-2025-03-11"
        | "gpt-4o-mini-search-preview"
        | "gpt-4o-mini-search-preview-2025-03-11"
        | "gpt-4o-audio-preview"
        | "gpt-4o-audio-preview-2024-12-17"
        | "gpt-4o-audio-preview-2024-10-01"
        | "gpt-4o-mini-audio-preview"
        | "gpt-4o-mini-audio-preview-2024-12-17"
        | "o1"
        | "o1-2024-12-17"
        | "o1-mini"
        | "o1-mini-2024-09-12"
        | "o1-preview"
        | "o1-preview-2024-09-12"
        | "o1-pro"
        | "o1-pro-2025-03-19"
        | "o3"
        | "o3-2025-04-16"
        | "o3-mini"
        | "o3-mini-2025-01-31"
        | "o4-mini"
        | "o4-mini-2025-04-16"
        | "chatgpt-4o-latest"
        | "gpt-4o-realtime"
        | "gpt-4o-realtime-preview-2024-10-01"
        | "gpt-4o-realtime-preview-2024-12-17"
        | "gpt-4o-mini-realtime-preview"
        | "gpt-4o-mini-realtime-preview-2024-12-17"
        | "gpt-4.1"
        | "gpt-4.1-2025-04-14"
        | "gpt-4.1-mini"
        | "gpt-4.1-mini-2025-04-14"
        | "gpt-4.1-nano"
        | "gpt-4.1-nano-2025-04-14"
        | "gpt-4.5-preview"
        | "gpt-4.5-preview-2025-02-27"
        | "gpt-5"
        | "gpt-5-2025-08-07"
        | "gpt-5-nano"
        | "gpt-5-nano-2025-08-07"
        | "gpt-5-mini"
        | "gpt-5-mini-2025-08-07"
        | "gpt-5-chat-latest" => "o200k_base",
        "text-davinci-003" | "text-davinci-002" | "code-davinci-002" | "code-davinci-001"
        | "code-cushman-002" | "code-cushman-001" | "davinci-codex" | "cushman-codex" => {
            "p50k_base"
        }
        "text-davinci-edit-001" | "code-davinci-edit-001" => "p50k_edit",
        "text-davinci-001"
        | "text-curie-001"
        | "text-babbage-001"
        | "text-ada-001"
        | "davinci"
        | "curie"
        | "babbage"
        | "ada"
        | "text-similarity-davinci-001"
        | "text-similarity-curie-001"
        | "text-similarity-babbage-001"
        | "text-similarity-ada-001"
        | "text-search-davinci-doc-001"
        | "text-search-curie-doc-001"
        | "text-search-babbage-doc-001"
        | "text-search-ada-doc-001"
        | "code-search-babbage-code-001"
        | "code-search-ada-code-001" => "r50k_base",
        "gpt2" => "gpt2",
        _ => "cl100k_base",
    }
}

fn count_v3_message_tokens(message: &Value, encoder: &CoreBPE) -> usize {
    let mut total = 0;
    if let Some(role) = message.get("role").and_then(Value::as_str) {
        total += count_v3_text_tokens(role, encoder);
    }
    if let Some(content) = message.get("content") {
        total += count_v3_content_tokens(content, encoder);
    }
    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in tool_calls {
            total += count_v3_json_value_as_text_tokens(call, encoder);
        }
    }
    if let Some(name) = message.get("name").and_then(Value::as_str) {
        total += count_v3_text_tokens(name, encoder);
    }
    if let Some(tool_call_id) = message.get("tool_call_id").and_then(Value::as_str) {
        total += count_v3_text_tokens(tool_call_id, encoder);
    }
    total
}

fn count_v3_request_extras_tokens(body: &Value, encoder: &CoreBPE) -> usize {
    let mut total = 0;
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        for tool in tools {
            total += count_v3_json_value_as_text_tokens(tool, encoder);
        }
    }
    if let Some(parameters) = body.get("parameters") {
        total += count_v3_json_value_as_text_tokens(parameters, encoder);
    }
    if let Some(instructions) = body.get("instructions") {
        total += count_v3_content_tokens(instructions, encoder);
    }
    total
}

fn count_v3_responses_context_tokens(body: &Value, encoder: &CoreBPE) -> usize {
    let top_level = body
        .get("input")
        .map(|input| count_v3_structured_tokens(input, encoder))
        .unwrap_or(0);
    let semantic_context = if let Some(input) = body
        .pointer("/semantics/responses/context/input")
        .and_then(Value::as_array)
    {
        input
            .iter()
            .map(|entry| count_v3_structured_tokens(entry, encoder))
            .sum()
    } else {
        0
    };
    top_level.max(semantic_context)
}

fn count_v3_content_tokens(content: &Value, encoder: &CoreBPE) -> usize {
    match content {
        Value::String(text) => count_v3_content_string_tokens(text, encoder),
        Value::Array(items) => items
            .iter()
            .map(|part| count_v3_content_part_tokens(part, encoder))
            .sum(),
        Value::Object(map) => count_v3_content_object_tokens(map, encoder),
        _ => 0,
    }
}

fn count_v3_content_string_tokens(raw: &str, encoder: &CoreBPE) -> usize {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let likely_json = (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'));
    if likely_json {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            return count_v3_content_tokens(&parsed, encoder);
        }
    }
    count_v3_text_tokens(raw, encoder)
}

fn count_v3_content_part_tokens(part: &Value, encoder: &CoreBPE) -> usize {
    match part {
        Value::String(text) => count_v3_text_tokens(text, encoder),
        Value::Object(map) => count_v3_content_object_tokens(map, encoder),
        _ => count_v3_structured_tokens(part, encoder),
    }
}

fn count_v3_content_object_tokens(
    map: &serde_json::Map<String, Value>,
    encoder: &CoreBPE,
) -> usize {
    if detect_v3_media_kind(map).is_some() {
        return 0;
    }
    if let Some(text) = map.get("text").and_then(Value::as_str) {
        return count_v3_text_tokens(text, encoder);
    }
    if let Some(content) = map.get("content").and_then(Value::as_str) {
        return count_v3_text_tokens(content, encoder);
    }
    count_v3_json_value_as_text_tokens(&Value::Object(map.clone()), encoder)
}

fn count_v3_structured_tokens(value: &Value, encoder: &CoreBPE) -> usize {
    match value {
        Value::Null => 0,
        Value::Bool(v) => count_v3_text_tokens(&v.to_string(), encoder),
        Value::Number(v) => count_v3_text_tokens(&v.to_string(), encoder),
        Value::String(v) => count_v3_content_string_tokens(v, encoder),
        Value::Array(values) => values
            .iter()
            .map(|entry| count_v3_structured_tokens(entry, encoder))
            .sum(),
        Value::Object(map) => {
            if detect_v3_media_kind(map).is_some() {
                let type_tokens = map
                    .get("type")
                    .and_then(Value::as_str)
                    .map(|v| count_v3_text_tokens(v, encoder))
                    .unwrap_or_else(|| count_v3_text_tokens("media", encoder));
                return type_tokens + count_v3_text_tokens("[omitted_media]", encoder);
            }
            map.iter()
                .map(|(key, entry)| {
                    count_v3_text_tokens(key, encoder) + count_v3_structured_tokens(entry, encoder)
                })
                .sum()
        }
    }
}

fn count_v3_json_value_as_text_tokens(value: &Value, encoder: &CoreBPE) -> usize {
    let text = serde_json::to_string(value).expect("serde_json::Value serialization cannot fail");
    count_v3_text_tokens(&text, encoder)
}

fn count_v3_text_tokens(text: &str, encoder: &CoreBPE) -> usize {
    if text.trim().is_empty() {
        return 0;
    }
    encoder.count_with_special_tokens(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn v3_token_estimate_uses_o200k_for_gpt4o_family() {
        let request = json!({
            "model": "gpt-4o",
            "messages": [{ "role": "user", "content": "hello world" }]
        });
        let tokens = estimate_v3_request_tokens(&request);
        assert!(tokens > 0 && tokens < 16, "unexpected estimate: {tokens}");
    }

    #[test]
    fn v3_token_estimate_falls_back_to_cl100k_for_unknown_models() {
        let request = json!({
            "model": "glm-4.7",
            "messages": [{ "role": "user", "content": "hello world" }]
        });
        assert!(estimate_v3_request_tokens(&request) > 0);
    }

    #[test]
    fn v3_token_estimate_counts_tools_and_parameters_as_extras() {
        let base = json!({
            "model": "gpt-4o",
            "messages": [{ "role": "user", "content": "run the tool" }]
        });
        let with_extras = json!({
            "model": "gpt-4o",
            "messages": [{ "role": "user", "content": "run the tool" }],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Look up the current weather for a city",
                    "parameters": { "type": "object", "properties": { "city": { "type": "string" } } }
                }
            }],
            "parameters": { "temperature": 0.7 }
        });
        assert!(estimate_v3_request_tokens(&with_extras) > estimate_v3_request_tokens(&base));
    }

    #[test]
    fn v3_token_estimate_merges_chat_and_responses_context_with_max() {
        let long_text = "alpha beta gamma delta ".repeat(64);
        let chat_only = json!({
            "model": "gpt-4o",
            "messages": [{ "role": "user", "content": long_text.clone() }]
        });
        let responses_only = json!({
            "model": "gpt-4o",
            "input": [{ "role": "user", "content": [{ "type": "input_text", "text": long_text.clone() }] }]
        });
        let both = json!({
            "model": "gpt-4o",
            "messages": [{ "role": "user", "content": "short" }],
            "input": [{ "role": "user", "content": [{ "type": "input_text", "text": long_text }] }]
        });
        let chat_tokens = estimate_v3_request_tokens(&chat_only);
        let responses_tokens = estimate_v3_request_tokens(&responses_only);
        let both_tokens = estimate_v3_request_tokens(&both);
        assert!(chat_tokens > 0 && responses_tokens > 0);
        assert!(
            both_tokens >= responses_tokens,
            "max merge must keep the larger responses context; both={both_tokens}, responses={responses_tokens}"
        );
    }

    #[test]
    fn v3_token_estimate_omits_media_payload_bytes() {
        let base = json!({
            "model": "gpt-4o",
            "input": [{
                "role": "user",
                "content": [{ "type": "input_text", "text": "Describe this image." }]
            }]
        });
        let with_image = json!({
            "model": "gpt-4o",
            "input": [{
                "role": "user",
                "content": [
                    { "type": "input_text", "text": "Describe this image." },
                    {
                        "type": "input_image",
                        "image_url": { "url": format!("data:image/png;base64,{}", "A".repeat(1_200_000)) }
                    }
                ]
            }]
        });
        let base_tokens = estimate_v3_request_tokens(&base);
        let image_tokens = estimate_v3_request_tokens(&with_image);
        assert!(
            image_tokens <= base_tokens + 8,
            "media bytes must be omitted; base={base_tokens}, image={image_tokens}"
        );
    }

    #[test]
    fn v3_token_estimate_counts_instructions() {
        let base = json!({
            "model": "gpt-4o",
            "input": [{ "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }]
        });
        let with_instructions = json!({
            "model": "gpt-4o",
            "instructions": "You are a meticulous assistant that always answers in French.",
            "input": [{ "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }]
        });
        assert!(estimate_v3_request_tokens(&with_instructions) > estimate_v3_request_tokens(&base));
    }
}
