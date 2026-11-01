use serde_json::Value;

fn safe_unsigned_integer(value: &Value) -> Option<u64> {
    let number = value.as_number()?;
    if let Some(integer) = number.as_u64() {
        return Some(integer);
    }
    let float = number.as_f64().filter(|_| number.is_f64())?;
    (float.is_finite() && float >= 0.0 && float <= 9_007_199_254_740_991.0 && float.fract() == 0.0)
        .then_some(float as u64)
}

/// The registered Codex shell tools declare integer fields but some Relay
/// providers return an integral JSON float. Restore that exact client type
/// only for those fields after the complete tool call has been governed.
pub(crate) fn normalize_v3_codex_integer_tool_values_at_resp03(
    request: &Value,
    response: &mut Value,
) {
    let Some(tools) = request.get("tools").and_then(Value::as_array) else {
        return;
    };
    let Some(output) = response.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    for item in output {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            continue;
        }
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let (property_names, required_names, integer_fields): (&[&str], &[&str], &[&str]) =
            match name {
                "exec_command" => (
                    &[
                        "cmd",
                        "justification",
                        "login",
                        "max_output_tokens",
                        "prefix_rule",
                        "sandbox_permissions",
                        "shell",
                        "tty",
                        "workdir",
                        "yield_time_ms",
                    ],
                    &["cmd"],
                    &["max_output_tokens", "yield_time_ms"],
                ),
                "write_stdin" => (
                    &["chars", "max_output_tokens", "session_id", "yield_time_ms"],
                    &["session_id"],
                    &["max_output_tokens", "session_id", "yield_time_ms"],
                ),
                _ => continue,
            };
        let mut matching = tools
            .iter()
            .filter(|tool| tool.get("name").and_then(Value::as_str) == Some(name));
        let Some(tool) = matching.next() else {
            continue;
        };
        if matching.next().is_some() {
            continue;
        }
        let Some(schema) = tool.as_object() else {
            continue;
        };
        if !super::responses_openai_codec::is_registered_codex_tool_schema(
            schema,
            property_names,
            required_names,
        ) {
            continue;
        }
        let Some(arguments_text) = item.get("arguments").and_then(Value::as_str) else {
            continue;
        };
        if super::resp_chat_process_03_governed::json_object_has_duplicate_keys_at_resp03(
            arguments_text,
        ) {
            continue;
        }
        let Ok(mut arguments) = serde_json::from_str::<Value>(arguments_text) else {
            continue;
        };
        let Some(arguments_object) = arguments.as_object_mut() else {
            continue;
        };
        // These tools declare only scalar fields and an array of strings. An
        // unrelated number or nested object could lose precision or duplicate
        // keys when the arguments string is encoded again.
        if arguments_object.iter().any(|(field, value)| {
            if integer_fields.contains(&field.as_str()) {
                match value {
                    Value::Number(_) => safe_unsigned_integer(value).is_none(),
                    Value::Object(_) | Value::Array(_) => true,
                    _ => false,
                }
            } else {
                match value {
                    Value::Number(_) | Value::Object(_) => true,
                    Value::Array(items) => !items.iter().all(Value::is_string),
                    _ => false,
                }
            }
        }) {
            continue;
        }
        let mut changed = false;
        for field in integer_fields {
            if tool
                .pointer(&format!("/parameters/properties/{field}/type"))
                .and_then(Value::as_str)
                != Some("integer")
            {
                continue;
            }
            let Some(value) = arguments_object.get_mut(*field) else {
                continue;
            };
            let Some(number) = value.as_number().filter(|number| number.is_f64()) else {
                continue;
            };
            if let Some(integer) = safe_unsigned_integer(&Value::Number(number.clone())) {
                *value = Value::from(integer);
                changed = true;
            }
        }
        if changed {
            if let Ok(encoded) = serde_json::to_string(&arguments) {
                item["arguments"] = Value::String(encoded);
            }
        }
    }
}

#[cfg(test)]
#[path = "resp_chat_process_codex_integer_values_tests.rs"]
mod tests;
