use serde_json::{Map, Value};

use crate::hub_reasoning_tool_normalizer::{
    normalize_message_reasoning_ssot, project_message_reasoning_text,
};

pub(crate) fn sanitize_chat_completion_like(candidate: &Value) -> Option<Value> {
    let mut row = candidate.as_object()?.clone();
    if row
        .get("choices")
        .map(|value| !matches!(value, Value::Array(_)))
        .unwrap_or(false)
    {
        row.remove("choices");
    }
    if row
        .get("usage")
        .map(|value| !matches!(value, Value::Object(_)))
        .unwrap_or(false)
    {
        row.remove("usage");
    }
    Some(Value::Object(row))
}

fn read_non_empty_string(raw: Option<&Value>) -> Option<String> {
    raw.and_then(|value| {
        value
            .as_str()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

fn response_id_for_chat(response: &Map<String, Value>) -> String {
    read_non_empty_string(response.get("id"))
        .map(|id| {
            if id.starts_with("chatcmpl") {
                id
            } else if let Some(rest) = id.strip_prefix("resp_") {
                format!("chatcmpl_{}", rest)
            } else {
                format!("chatcmpl_{}", id)
            }
        })
        .unwrap_or_else(|| "chatcmpl_response_projection".to_string())
}

fn response_created_for_chat(response: &Map<String, Value>) -> Value {
    response
        .get("created")
        .or_else(|| response.get("created_at"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn response_finish_reason_for_chat(response: &Map<String, Value>, has_tool_calls: bool) -> Value {
    if has_tool_calls {
        return Value::String("tool_calls".to_string());
    }
    match read_non_empty_string(response.get("status")).as_deref() {
        Some("completed") => Value::String("stop".to_string()),
        Some("incomplete") => Value::String("length".to_string()),
        _ => Value::Null,
    }
}

fn collect_response_message_text(content: Option<&Value>) -> String {
    let Some(items) = content.and_then(Value::as_array) else {
        return String::new();
    };
    let mut parts = Vec::new();
    for item in items {
        let Some(row) = item.as_object() else {
            continue;
        };
        let item_type = read_non_empty_string(row.get("type"));
        if matches!(
            item_type.as_deref(),
            Some("output_text") | Some("text") | None
        ) {
            if let Some(text) = read_non_empty_string(row.get("text")) {
                parts.push(text);
            }
        }
    }
    parts.join("")
}

fn collect_response_tool_calls(output_items: &[Value]) -> Vec<Value> {
    let mut tool_calls = Vec::new();
    for item in output_items {
        let Some(row) = item.as_object() else {
            continue;
        };
        let item_type = read_non_empty_string(row.get("type"));
        if item_type.as_deref() != Some("function_call") {
            continue;
        }
        let id = read_non_empty_string(row.get("call_id"))
            .or_else(|| read_non_empty_string(row.get("id")))
            .unwrap_or_else(|| format!("call_{}", tool_calls.len()));
        let name = read_non_empty_string(row.get("name")).unwrap_or_else(|| "tool".to_string());
        let arguments = row
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| Value::String("{}".to_string()));
        tool_calls.push(serde_json::json!({
            "id": id,
            "type": "function",
            "function": {
                "name": name,
                "arguments": arguments
            }
        }));
    }
    tool_calls
}

pub(crate) fn build_openai_chat_completion_from_responses_payload(
    candidate: &Value,
) -> Option<Value> {
    let response = candidate.as_object()?;
    if response.get("object").and_then(Value::as_str) != Some("response") {
        return None;
    }
    let output_items = response
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let message_item = output_items.iter().find(|item| {
        item.as_object()
            .and_then(|row| row.get("type"))
            .and_then(Value::as_str)
            == Some("message")
    });
    let message_row = message_item.and_then(Value::as_object);
    let content = message_row
        .map(|row| collect_response_message_text(row.get("content")))
        .filter(|text| !text.is_empty())
        .or_else(|| read_non_empty_string(response.get("output_text")))
        .unwrap_or_default();
    let role = message_row
        .and_then(|row| read_non_empty_string(row.get("role")))
        .unwrap_or_else(|| "assistant".to_string());
    let tool_calls = collect_response_tool_calls(&output_items);
    let has_tool_calls = !tool_calls.is_empty();
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String(role));
    if has_tool_calls {
        message.insert("content".to_string(), Value::Null);
    } else {
        message.insert("content".to_string(), Value::String(content));
    }
    if has_tool_calls {
        message.insert("tool_calls".to_string(), Value::Array(tool_calls));
    }
    let mut choice = Map::new();
    choice.insert("index".to_string(), Value::from(0));
    choice.insert("message".to_string(), Value::Object(message));
    choice.insert(
        "finish_reason".to_string(),
        response_finish_reason_for_chat(response, has_tool_calls),
    );
    let mut out = Map::new();
    out.insert(
        "id".to_string(),
        Value::String(response_id_for_chat(response)),
    );
    out.insert(
        "object".to_string(),
        Value::String("chat.completion".to_string()),
    );
    out.insert("created".to_string(), response_created_for_chat(response));
    out.insert(
        "model".to_string(),
        response
            .get("model")
            .cloned()
            .unwrap_or_else(|| Value::String("unknown".to_string())),
    );
    out.insert(
        "choices".to_string(),
        Value::Array(vec![Value::Object(choice)]),
    );
    if let Some(usage) = response.get("usage").filter(|value| value.is_object()) {
        out.insert("usage".to_string(), usage.clone());
    }
    out.insert(
        "routecodex_response".to_string(),
        Value::Object(response.clone()),
    );
    Some(Value::Object(out))
}

pub(crate) fn derive_reasoning_details_from_payload(reasoning: &Value) -> Vec<Value> {
    let mut details: Vec<Value> = Vec::new();
    let Some(reasoning_row) = reasoning.as_object() else {
        return details;
    };

    if let Some(summary_items) = reasoning_row.get("summary").and_then(Value::as_array) {
        for entry in summary_items {
            let Some(entry_row) = entry.as_object() else {
                continue;
            };
            let text = entry_row
                .get("text")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let Some(text) = text else {
                continue;
            };
            let kind = entry_row
                .get("type")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "summary_text".to_string());
            details.push(Value::String(format!("[{}] {}", kind, text)));
        }
    }

    if let Some(content_items) = reasoning_row.get("content").and_then(Value::as_array) {
        for entry in content_items {
            let Some(entry_row) = entry.as_object() else {
                continue;
            };
            let text = entry_row
                .get("text")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let Some(text) = text else {
                continue;
            };
            let kind = entry_row
                .get("type")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "reasoning_text".to_string());
            details.push(Value::String(format!("[{}] {}", kind, text)));
        }
    }

    if let Some(encrypted_content) = reasoning_row
        .get("encrypted_content")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        details.push(Value::String(format!(
            "[reasoning.encrypted_content] {}",
            encrypted_content
        )));
    }

    details
}

pub(crate) fn normalize_client_openai_chat_message_reasoning(message: &mut Map<String, Value>) {
    normalize_message_reasoning_ssot(message);
    let has_reasoning_payload = message.get("reasoning").is_some();

    let reasoning_text = message
        .get("reasoning")
        .and_then(project_message_reasoning_text)
        .or_else(|| read_non_empty_string(message.get("reasoning_content")));
    let reasoning_details = message
        .get("reasoning")
        .map(derive_reasoning_details_from_payload)
        .unwrap_or_default();

    if let Some(text) = reasoning_text {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(text.to_string()),
        );
    } else {
        message.remove("reasoning_content");
        if !has_reasoning_payload {
            message.remove("reasoning");
        }
    }
    if !reasoning_details.is_empty() {
        message.insert(
            "reasoning_details".to_string(),
            Value::Array(reasoning_details),
        );
    } else {
        message.remove("reasoning_details");
    }
}

pub(crate) fn normalize_openai_chat_reasoning_outbound(candidate: &Value) -> Option<Value> {
    let chat_candidate = build_openai_chat_completion_from_responses_payload(candidate)
        .unwrap_or_else(|| candidate.clone());
    let mut row = sanitize_chat_completion_like(&chat_candidate)?
        .as_object()?
        .clone();
    if let Some(choices) = row.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices.iter_mut() {
            let Some(choice_row) = choice.as_object_mut() else {
                continue;
            };
            if let Some(message) = choice_row.get_mut("message").and_then(Value::as_object_mut) {
                normalize_client_openai_chat_message_reasoning(message);
            }
        }
    }
    Some(Value::Object(row))
}
