use crate::hub_bridge_actions::utils::normalize_function_call_id;
use crate::hub_reasoning_tool_normalizer::normalize_assistant_text_to_tool_calls_json;
use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};

fn read_trimmed_non_empty_string(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

fn extract_responses_message_text(item: &Map<String, Value>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(Value::Array(content)) = item.get("content") {
        for part in content {
            let Some(part_obj) = part.as_object() else {
                continue;
            };
            let text = read_trimmed_non_empty_string(part_obj.get("text"))
                .or_else(|| read_trimmed_non_empty_string(part_obj.get("content")))
                .or_else(|| read_trimmed_non_empty_string(part_obj.get("value")));
            if let Some(text) = text {
                parts.push(text);
            }
        }
    }
    if let Some(text) = read_trimmed_non_empty_string(item.get("output_text")) {
        parts.push(text);
    }
    parts.join("\n").trim().to_string()
}

fn normalize_assistant_message(message: &Value, options_json: Option<&String>) -> Option<Value> {
    let message_json = serde_json::to_string(message).ok()?;
    let normalized_json =
        normalize_assistant_text_to_tool_calls_json(message_json, options_json.cloned()).ok()?;
    serde_json::from_str::<Value>(&normalized_json).ok()
}

fn has_tool_calls(message: &Value) -> bool {
    message
        .as_object()
        .and_then(|obj| obj.get("tool_calls"))
        .and_then(Value::as_array)
        .map(|arr| !arr.is_empty())
        .unwrap_or(false)
}

fn should_force_tool_calls_finish_reason(choice_obj: &Map<String, Value>) -> bool {
    let finish = choice_obj
        .get("finish_reason")
        .and_then(Value::as_str)
        .map(|raw| raw.trim().to_ascii_lowercase())
        .unwrap_or_default();
    finish.is_empty() || finish == "stop" || finish == "length"
}

fn harvest_chat_choices_in_place(root: &mut Map<String, Value>, options_json: Option<&String>) {
    let Some(Value::Array(choices)) = root.get_mut("choices") else {
        return;
    };
    for choice in choices.iter_mut() {
        let Some(choice_obj) = choice.as_object_mut() else {
            continue;
        };
        let message_original = choice_obj.get("message").cloned();
        let Some(message) = message_original else {
            continue;
        };
        if !message.is_object() {
            continue;
        }
        let Some(normalized) = normalize_assistant_message(&message, options_json) else {
            continue;
        };
        if normalized != message {
            choice_obj.insert("message".to_string(), normalized.clone());
        }
        if has_tool_calls(&normalized) && should_force_tool_calls_finish_reason(choice_obj) {
            choice_obj.insert(
                "finish_reason".to_string(),
                Value::String("tool_calls".to_string()),
            );
        }
    }
}

fn build_responses_function_calls_from_text(
    text: &str,
    options_json: Option<&String>,
    fallback_counter: &mut usize,
) -> Vec<Value> {
    let message = serde_json::json!({
        "role": "assistant",
        "content": text
    });
    let Some(normalized) = normalize_assistant_message(&message, options_json) else {
        return Vec::new();
    };
    let tool_calls = normalized
        .as_object()
        .and_then(|obj| obj.get("tool_calls"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if tool_calls.is_empty() {
        return Vec::new();
    }

    let mut out: Vec<Value> = Vec::new();
    for call in tool_calls {
        let Some(call_obj) = call.as_object() else {
            continue;
        };
        let fn_obj = call_obj.get("function").and_then(Value::as_object);
        let name = fn_obj
            .and_then(|row| read_trimmed_non_empty_string(row.get("name")))
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let arguments = fn_obj
            .and_then(|row| row.get("arguments"))
            .and_then(Value::as_str)
            .unwrap_or("{}")
            .to_string();

        let call_id = read_trimmed_non_empty_string(call_obj.get("call_id"))
            .or_else(|| read_trimmed_non_empty_string(call_obj.get("id")))
            .unwrap_or_else(|| {
                *fallback_counter += 1;
                format!("call_auto_{}", fallback_counter)
            });
        let fallback_item_id = format!("fc_{}", call_id);
        let item_id = normalize_function_call_id(Some(call_id.as_str()), fallback_item_id.as_str());
        out.push(serde_json::json!({
            "type": "function_call",
            "id": item_id,
            "call_id": call_id,
            "name": name,
            "arguments": arguments
        }));
    }
    out
}

fn harvest_responses_output_in_place(root: &mut Map<String, Value>, options_json: Option<&String>) {
    let Some(Value::Array(output)) = root.get("output") else {
        return;
    };
    let mut next_output: Vec<Value> = Vec::new();
    let mut changed = false;
    let mut fallback_counter: usize = 0;

    for item in output {
        let Some(item_obj) = item.as_object() else {
            next_output.push(item.clone());
            continue;
        };
        let item_type = item_obj
            .get("type")
            .and_then(Value::as_str)
            .map(|raw| raw.trim().to_ascii_lowercase())
            .unwrap_or_default();
        let role = item_obj
            .get("role")
            .and_then(Value::as_str)
            .map(|raw| raw.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if item_type != "message" || role != "assistant" {
            next_output.push(item.clone());
            continue;
        }

        let text = extract_responses_message_text(item_obj);
        if text.is_empty() {
            next_output.push(item.clone());
            continue;
        }

        let harvested = build_responses_function_calls_from_text(
            text.as_str(),
            options_json,
            &mut fallback_counter,
        );
        if harvested.is_empty() {
            next_output.push(item.clone());
            continue;
        }
        changed = true;
        next_output.extend(harvested);
    }

    if changed {
        root.insert("output".to_string(), Value::Array(next_output));
    }
}

pub fn harvest_tool_calls_from_text_json(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    if !payload.is_object() {
        return serde_json::to_string(&payload)
            .map_err(|e| napi::Error::from_reason(e.to_string()));
    }
    let root = payload.as_object_mut().expect("object checked");

    let choices_len = root
        .get("choices")
        .and_then(Value::as_array)
        .map(|arr| arr.len())
        .unwrap_or(0);
    if choices_len > 0 {
        harvest_chat_choices_in_place(root, options_json.as_ref());
    } else {
        harvest_responses_output_in_place(root, options_json.as_ref());
    }

    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_assistant_message_harvests_reasoning_prefix_payload() {
        let raw_reasoning = "[Time/Date]: utc=`2026-03-10T12:18:35.686Z`\nexec_command<arg_key>cmd</arg_key><arg_value>pwd</arg_value></tool_call>";

        let message = serde_json::json!({
            "role": "assistant",
            "reasoning_content": raw_reasoning
        });
        let normalized = normalize_assistant_message(&message, None).expect("normalized");
        let tool_calls = normalized
            .as_object()
            .and_then(|obj| obj.get("tool_calls"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .as_object()
                .and_then(|obj| obj.get("function"))
                .and_then(Value::as_object)
                .and_then(|obj| obj.get("name"))
                .and_then(Value::as_str)
                .unwrap_or(""),
            "exec_command"
        );
    }

    #[test]
    fn normalize_assistant_message_rejects_malformed_parameter_reasoning_payload_without_explicit_tool_name(
    ) {
        let raw_reasoning = "<parameter name=\"input\">pwd</</parameter>\n<parameter name=\"type\">string</parameter>\n</command></arg_value>";

        let message = serde_json::json!({
            "role": "assistant",
            "reasoning_content": raw_reasoning
        });
        let normalized = normalize_assistant_message(&message, None).expect("normalized");
        let tool_calls = normalized
            .as_object()
            .and_then(|obj| obj.get("tool_calls"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(tool_calls.is_empty());
    }
}
