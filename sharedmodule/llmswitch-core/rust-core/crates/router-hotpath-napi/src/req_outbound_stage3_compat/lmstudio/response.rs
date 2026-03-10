use serde_json::{json, Map, Number, Value};
use uuid::Uuid;

use super::request::normalize_lmstudio_tool_call_ids;
use crate::resp_process_stage1_tool_governance::{govern_response, ToolGovernanceInput};

fn ensure_default_field(root: &mut Map<String, Value>, key: &str, value: Value) {
    if root.get(key).is_some() {
        return;
    }
    root.insert(key.to_string(), value);
}

fn build_lmstudio_chat_completion_id() -> String {
    format!(
        "chatcmpl_{}_{}",
        chrono::Utc::now().timestamp_millis(),
        Uuid::new_v4()
            .to_string()
            .replace('-', "")
            .chars()
            .take(8)
            .collect::<String>()
    )
}

fn apply_lmstudio_response_defaults(root: &mut Map<String, Value>) {
    ensure_default_field(root, "object", Value::String("chat.completion".to_string()));
    ensure_default_field(
        root,
        "id",
        Value::String(build_lmstudio_chat_completion_id()),
    );
    ensure_default_field(
        root,
        "created",
        Value::Number(Number::from(chrono::Utc::now().timestamp())),
    );
    ensure_default_field(root, "model", Value::String("unknown".to_string()));
}

fn extract_responses_message_text(item: &Map<String, Value>) -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
        for part in content {
            if let Some(text) = part.as_str() {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
                continue;
            }
            let Some(part_obj) = part.as_object() else {
                continue;
            };
            for key in ["text", "content", "value"] {
                let Some(text) = part_obj.get(key).and_then(|v| v.as_str()) else {
                    continue;
                };
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
            }
        }
    }

    if let Some(text) = item.get("output_text").and_then(|v| v.as_str()) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            parts.push(trimmed.to_string());
        }
    }

    parts.join("\n").trim().to_string()
}

fn recover_tool_calls_from_text(text: &str, request_id: &str) -> Vec<Value> {
    let synthetic_payload = json!({
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": text,
                    "tool_calls": []
                }
            }
        ]
    });
    let governed = match govern_response(ToolGovernanceInput {
        payload: synthetic_payload,
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: request_id.to_string(),
    }) {
        Ok(output) => output.governed_payload,
        Err(_) => return Vec::new(),
    };

    governed
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("tool_calls"))
        .and_then(|tool_calls| tool_calls.as_array())
        .cloned()
        .unwrap_or_default()
}

fn sanitize_id_token(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "id".to_string()
    } else {
        trimmed
    }
}

fn derive_fc_item_id(call_id: &str, fallback_index: usize) -> String {
    let trimmed = call_id.trim();
    if trimmed.is_empty() {
        return format!("fc_call_{}", fallback_index);
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.starts_with("fc_") || lowered.starts_with("fc-") {
        return sanitize_id_token(trimmed);
    }
    if lowered.starts_with("call_") || lowered.starts_with("call-") {
        let core = trimmed.chars().skip(5).collect::<String>();
        return format!("fc_{}", sanitize_id_token(&core));
    }
    format!("fc_{}", sanitize_id_token(trimmed))
}

fn convert_tool_call_to_responses_function_call(
    call: &Value,
    fallback_index: usize,
) -> Option<Value> {
    let call_obj = call.as_object()?;
    let fn_obj = call_obj.get("function").and_then(|v| v.as_object())?;
    let name = fn_obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())?
        .to_string();

    let call_id = call_obj
        .get("call_id")
        .or_else(|| call_obj.get("id"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("call_{}", fallback_index));
    let item_id = derive_fc_item_id(&call_id, fallback_index);

    let arguments = match fn_obj.get("arguments") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
        None => "{}".to_string(),
    };

    Some(json!({
        "type": "function_call",
        "id": item_id,
        "call_id": call_id,
        "name": name,
        "arguments": arguments
    }))
}

fn harvest_responses_output_tool_calls(root: &mut Map<String, Value>, request_id: &str) {
    let Some(entries) = root.get("output").and_then(|v| v.as_array()) else {
        return;
    };
    if entries.is_empty() {
        return;
    }

    let mut changed = false;
    let mut call_counter: usize = 0;
    let mut next_output: Vec<Value> = Vec::with_capacity(entries.len());

    for entry in entries {
        let Some(entry_obj) = entry.as_object() else {
            next_output.push(entry.clone());
            continue;
        };
        let item_type = entry_obj
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let role = entry_obj
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("assistant")
            .trim()
            .to_ascii_lowercase();
        if item_type != "message" || role != "assistant" {
            next_output.push(entry.clone());
            continue;
        }

        let text = extract_responses_message_text(entry_obj);
        if text.is_empty() {
            next_output.push(entry.clone());
            continue;
        }

        let recovered = recover_tool_calls_from_text(&text, request_id);
        if recovered.is_empty() {
            next_output.push(entry.clone());
            continue;
        }

        changed = true;
        for call in recovered {
            call_counter += 1;
            if let Some(item) = convert_tool_call_to_responses_function_call(&call, call_counter) {
                next_output.push(item);
            }
        }
    }

    if changed {
        root.insert("output".to_string(), Value::Array(next_output));
    }
}

pub(crate) fn apply_lmstudio_response_compat(payload: Value, request_id: Option<&String>) -> Value {
    let request_id_value = request_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "req_lmstudio_compat".to_string());

    let mut governed_payload = match govern_response(ToolGovernanceInput {
        payload: payload.clone(),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: request_id_value.clone(),
    }) {
        Ok(output) => output.governed_payload,
        Err(_) => payload,
    };
    if let Some(root) = governed_payload.as_object_mut() {
        harvest_responses_output_tool_calls(root, &request_id_value);
        normalize_lmstudio_tool_call_ids(root);
        apply_lmstudio_response_defaults(root);
    }
    governed_payload
}
