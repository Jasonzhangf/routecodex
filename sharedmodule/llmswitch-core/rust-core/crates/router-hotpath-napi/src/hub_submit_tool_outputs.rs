//! Hub servertool followup payload shape NAPI bridge.

use napi::bindgen_prelude::Result as NapiResult;
use serde_json::Value;

use crate::shared_json_utils::read_trimmed_string;

fn as_object(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value.as_object()
}

fn input_text_item(text: String) -> Value {
    serde_json::json!({ "type": "input_text", "text": text })
}

fn stringify_json_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => serde_json::to_string(other).unwrap_or_else(|_| other.to_string()),
    }
}

fn tool_arguments_to_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => "{}".to_string(),
        Some(other) => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
    }
}

fn coerce_assistant_tool_calls_to_responses_input(
    message: &serde_json::Map<String, Value>,
) -> Vec<Value> {
    let mut out = Vec::new();
    let Some(tool_calls) = message.get("tool_calls").and_then(|value| value.as_array()) else {
        return out;
    };
    for entry in tool_calls {
        let Some(record) = as_object(entry) else {
            continue;
        };
        let id = read_trimmed_string(record.get("id")).unwrap_or_default();
        let function = record.get("function").and_then(as_object);
        let name = function
            .and_then(|row| read_trimmed_string(row.get("name")))
            .or_else(|| read_trimmed_string(record.get("name")))
            .unwrap_or_default();
        if id.is_empty() || name.is_empty() {
            continue;
        }
        out.push(serde_json::json!({
            "type": "function_call",
            "call_id": id,
            "name": name,
            "arguments": tool_arguments_to_string(function.and_then(|row| row.get("arguments")))
        }));
    }
    out
}

fn coerce_chat_message_to_responses_input(message: &serde_json::Map<String, Value>) -> Vec<Value> {
    if let Some(item_type) = message.get("type").and_then(|value| value.as_str()) {
        if item_type == "message" || message.contains_key("role") {
            return vec![Value::Object(message.clone())];
        }
        if !item_type.trim().is_empty() {
            return vec![Value::Object(message.clone())];
        }
    }
    let role = read_trimmed_string(message.get("role"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    let content = message.get("content");
    if role == "tool" {
        let call_id = read_trimmed_string(message.get("tool_call_id"));
        let output = stringify_json_value(content);
        if let Some(call_id) = call_id {
            return vec![serde_json::json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": output
            })];
        }
        return vec![serde_json::json!({
            "role": "user",
            "content": [input_text_item(output)]
        })];
    }
    if role == "assistant" {
        let tool_calls = coerce_assistant_tool_calls_to_responses_input(message);
        if !tool_calls.is_empty() {
            return tool_calls;
        }
    }
    if let Some(Value::Array(content_array)) = content {
        return vec![serde_json::json!({
            "role": if role.is_empty() { "user" } else { role.as_str() },
            "content": content_array
        })];
    }
    vec![serde_json::json!({
        "role": if role.is_empty() { "user" } else { role.as_str() },
        "content": [input_text_item(stringify_json_value(content))]
    })]
}

fn endpoint_is_responses(entry_endpoint: &str) -> bool {
    entry_endpoint
        .to_ascii_lowercase()
        .contains("/v1/responses")
}

fn normalize_servertool_followup_payload_shape_value(
    entry_endpoint: &str,
    payload: Value,
) -> Value {
    if !endpoint_is_responses(entry_endpoint) {
        return payload;
    }
    let mut object = match payload {
        Value::Object(object) => object,
        other => return other,
    };
    if object
        .get("input")
        .and_then(|value| value.as_array())
        .is_some()
        || object
            .get("messages")
            .and_then(|value| value.as_array())
            .is_none()
    {
        return Value::Object(object);
    }
    if object.get("tool_choice").is_none() {
        if let Some(tool_choice) = object
            .get("semantics")
            .and_then(Value::as_object)
            .and_then(|semantics| semantics.get("responses"))
            .and_then(Value::as_object)
            .and_then(|responses| responses.get("requestParameters"))
            .and_then(Value::as_object)
            .and_then(|request_parameters| request_parameters.get("tool_choice"))
            .filter(|value| !value.is_null())
            .cloned()
        {
            object.insert("tool_choice".to_string(), tool_choice);
        }
    }
    let mut input = Vec::new();
    if let Some(messages) = object.get("messages").and_then(|value| value.as_array()) {
        let mut seen_tool_outputs = std::collections::HashSet::<String>::new();
        for message in messages {
            let Some(message_object) = as_object(message) else {
                continue;
            };
            for item in coerce_chat_message_to_responses_input(message_object) {
                let item_type = item
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if item_type == "function_call_output" {
                    let call_id = item
                        .get("call_id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if call_id.is_empty() || seen_tool_outputs.contains(&call_id) {
                        continue;
                    }
                    seen_tool_outputs.insert(call_id);
                }
                input.push(item);
            }
        }
    }
    object.insert("input".to_string(), Value::Array(input));
    object.remove("messages");
    Value::Object(object)
}

pub fn normalize_servertool_followup_payload_shape_json(
    entry_endpoint: String,
    payload_json: String,
) -> NapiResult<String> {
    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let output = normalize_servertool_followup_payload_shape_value(&entry_endpoint, payload);
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_responses_followup_messages_to_input_in_rust() {
        let payload = json!({
            "model": "gpt-5.5",
            "semantics": {
                "responses": {
                    "requestParameters": {
                        "tool_choice": "auto"
                    }
                }
            },
            "messages": [
                {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_1",
                        "function": { "name": "exec_command", "arguments": { "cmd": "pwd" } }
                    }]
                },
                { "role": "tool", "tool_call_id": "call_1", "content": { "ok": true } },
                { "role": "tool", "tool_call_id": "call_1", "content": "duplicate" },
                { "role": "user", "content": "continue" }
            ]
        });

        let normalized =
            normalize_servertool_followup_payload_shape_value("/v1/responses", payload);
        assert!(normalized.get("messages").is_none());
        let input = normalized
            .get("input")
            .and_then(|value| value.as_array())
            .unwrap();
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[0]["call_id"], "call_1");
        assert_eq!(input[0]["name"], "exec_command");
        assert_eq!(input[0]["arguments"], r#"{"cmd":"pwd"}"#);
        assert_eq!(input[1]["type"], "function_call_output");
        assert_eq!(input[1]["call_id"], "call_1");
        assert_eq!(input[1]["output"], r#"{"ok":true}"#);
        assert_eq!(input[2]["role"], "user");
        assert_eq!(normalized["tool_choice"], "auto");
    }

    #[test]
    fn normalizes_responses_followup_preserves_root_tool_choice() {
        let payload = json!({
            "model": "gpt-5.5",
            "tool_choice": "required",
            "semantics": {
                "responses": {
                    "requestParameters": {
                        "tool_choice": "auto"
                    }
                }
            },
            "messages": [
                { "role": "user", "content": "continue" }
            ]
        });

        let normalized =
            normalize_servertool_followup_payload_shape_value("/v1/responses", payload);
        assert_eq!(normalized["tool_choice"], "required");
    }

    #[test]
    fn normalizes_responses_followup_preserves_responses_role_items() {
        let payload = json!({
            "model": "gpt-5.5",
            "messages": [
                {"role":"user", "content":[{"type":"input_text", "text":"hi"}]}
            ]
        });

        let normalized =
            normalize_servertool_followup_payload_shape_value("/v1/responses", payload);
        assert!(normalized.get("messages").is_none());
        let input = normalized
            .get("input")
            .and_then(|value| value.as_array())
            .unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[0]["content"][0]["type"], "input_text");
        assert_eq!(input[0]["content"][0]["text"], "hi");
    }

    #[test]
    fn normalizes_responses_followup_preserves_tool_controls_and_tools() {
        let tools = json!([
            {
                "type": "function",
                "function": {
                    "name": "exec_command",
                    "description": "run command",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "cmd": { "type": "string" }
                        },
                        "required": ["cmd"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "update_plan",
                    "description": "update plan",
                    "parameters": {
                        "type": "object",
                        "properties": {}
                    }
                }
            }
        ]);
        let payload = json!({
            "model": "gpt-5.5",
            "tools": tools.clone(),
            "tool_choice": { "type": "auto" },
            "parallel_tool_calls": false,
            "messages": [
                { "role": "user", "content": "continue" }
            ]
        });

        let normalized =
            normalize_servertool_followup_payload_shape_value("/v1/responses", payload);
        assert_eq!(normalized["tools"], tools);
        assert_eq!(normalized["tool_choice"], json!({ "type": "auto" }));
        assert_eq!(normalized["parallel_tool_calls"], false);
        assert!(normalized.get("messages").is_none());
        assert!(normalized.get("input").is_some());
    }

    #[test]
    fn leaves_non_responses_followup_payload_unchanged() {
        let payload = json!({ "messages": [{ "role": "user", "content": "hello" }] });
        let normalized = normalize_servertool_followup_payload_shape_value(
            "/v1/chat/completions",
            payload.clone(),
        );
        assert_eq!(normalized, payload);
    }
}
