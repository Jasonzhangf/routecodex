use serde_json::{json, Map, Value};

use super::super::deepseek_web::apply_deepseek_web_response_compat;
use super::super::AdapterContext;

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(Value::as_str)?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(raw.to_string())
}

fn normalize_qwenchat_legacy_function_call(payload: &mut Value) {
    let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) else {
        return;
    };

    for (choice_index, choice) in choices.iter_mut().enumerate() {
        let Some(message) = choice
            .as_object_mut()
            .and_then(|row| row.get_mut("message"))
            .and_then(Value::as_object_mut)
        else {
            continue;
        };

        let has_tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false);
        if has_tool_calls {
            continue;
        }

        let Some(function_call) = message
            .get("function_call")
            .and_then(Value::as_object)
            .cloned()
        else {
            continue;
        };

        let name = read_trimmed_string(function_call.get("name"));
        let arguments = function_call
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| Value::String("{}".to_string()));
        let call_id = read_trimmed_string(function_call.get("id"))
            .unwrap_or_else(|| format!("call_qwenchat_legacy_{}", choice_index + 1));

        if name.is_none() && arguments == Value::String("{}".to_string()) {
            continue;
        }

        let mut function = Map::new();
        if let Some(name) = name {
            function.insert("name".to_string(), Value::String(name));
        }
        function.insert("arguments".to_string(), arguments);

        message.insert(
            "tool_calls".to_string(),
            Value::Array(vec![json!({
                "id": call_id,
                "type": "function",
                "function": Value::Object(function),
            })]),
        );
        message.remove("function_call");

        if let Some(choice_obj) = choice.as_object_mut() {
            choice_obj.insert(
                "finish_reason".to_string(),
                Value::String("tool_calls".to_string()),
            );
        }
    }
}

pub(crate) fn apply_qwenchat_web_response_compat(
    payload: Value,
    adapter_context: &AdapterContext,
) -> Result<Value, String> {
    let mut normalized = payload;
    normalize_qwenchat_legacy_function_call(&mut normalized);
    apply_deepseek_web_response_compat(normalized, adapter_context)
}
