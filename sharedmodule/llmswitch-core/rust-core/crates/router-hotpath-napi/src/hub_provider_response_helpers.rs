//! Hub provider-response helper NAPI bridge.
//! Rust SSOT for provider response tool-call signature extraction.

use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::Value;
use std::collections::HashSet;

fn extract_tool_signatures_from_content(content: &Value, out: &mut HashSet<String>) {
    let arr = match content.as_array() {
        Some(a) => a,
        None => return,
    };
    for entry in arr {
        let row = match entry.as_object() {
            Some(r) => r,
            None => continue,
        };
        if row.get("type").and_then(|v| v.as_str()) == Some("function_calling") {
            if let Some(name) = row.get("name").and_then(|v| v.as_str()) {
                out.insert(name.to_string());
            }
        }
        if let Some(input) = row.get("input").and_then(|v| v.as_object()) {
            if let Some(call_id) = input.get("id").and_then(|v| v.as_str()) {
                out.insert(call_id.to_string());
            }
        }
        if let Some(inner_content) = row.get("content") {
            extract_tool_signatures_from_content(inner_content, out);
        }
    }
}

fn extract_tool_signatures_from_message(message: &Value, out: &mut HashSet<String>) {
    let content = match message.as_object() {
        Some(m) => m,
        None => return,
    };
    if let Some(arr) = content.get("content").and_then(|v| v.as_array()) {
        extract_tool_signatures_from_content(&Value::Array(arr.clone()), out);
    }
}

/// Returns sorted JSON array of unique tool call signatures (names + call_ids) in a payload.
fn extract_tool_signatures_from_payload(payload: &Value) -> Vec<String> {
    let mut signatures = HashSet::new();

    // Try choices[].message.content for chat-format
    if let Some(choices) = payload.get("choices").and_then(|v| v.as_array()) {
        for choice in choices {
            let row = match choice.as_object() {
                Some(c) => c,
                None => continue,
            };
            if let Some(msg) = row.get("message").and_then(|v| v.as_object()) {
                extract_tool_signatures_from_message(&Value::Object(msg.clone()), &mut signatures);
            }
        }
    }

    // Try output[].function_calling for responses-format
    if let Some(output) = payload.get("output").and_then(|v| v.as_array()) {
        for entry in output {
            let row = match entry.as_object() {
                Some(r) => r,
                None => continue,
            };
            if row.get("type").and_then(|v| v.as_str()) == Some("function_calling") {
                if let Some(name) = row.get("name").and_then(|v| v.as_str()) {
                    signatures.insert(name.to_string());
                }
                if let Some(input) = row.get("input").and_then(|v| v.as_object()) {
                    if let Some(id) = input.get("id").and_then(|v| v.as_str()) {
                        signatures.insert(id.to_string());
                    }
                }
            }
            if let Some(content) = row.get("content") {
                extract_tool_signatures_from_content(content, &mut signatures);
            }
        }
    }

    let mut result: Vec<String> = signatures.into_iter().collect();
    result.sort();
    result
}

/// Returns true if the after-payload has new governed tool calls not present in before.
fn has_new_governed_server_tool_calls(before: &Value, after: &Value) -> bool {
    let before_set: HashSet<String> = extract_tool_signatures_from_payload(before)
        .into_iter()
        .collect();
    let after_sigs = extract_tool_signatures_from_payload(after);
    after_sigs.into_iter().any(|sig| !before_set.contains(&sig))
}

/// Returns true if the payload requires submit_tool_outputs (has pending function_calling).
fn responses_payload_requires_submit_tool_outputs(payload: &Value) -> bool {
    let has_required_tool_calls = payload
        .get("required_action")
        .and_then(Value::as_object)
        .and_then(|row| row.get("submit_tool_outputs"))
        .and_then(Value::as_object)
        .and_then(|row| row.get("tool_calls"))
        .and_then(Value::as_array)
        .map(|calls| !calls.is_empty())
        .unwrap_or(false);
    if has_required_tool_calls {
        return true;
    }
    if let Some(output) = payload.get("output").and_then(|v| v.as_array()) {
        for entry in output {
            if let Some(kind) = entry
                .as_object()
                .and_then(|r| r.get("type"))
                .and_then(|v| v.as_str())
            {
                if kind == "function_calling" {
                    return true;
                }
                if kind == "function_call" {
                    let status = entry
                        .as_object()
                        .and_then(|row| row.get("status"))
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if status != "completed" {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[napi]
pub fn extract_tool_signatures_from_payload_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = extract_tool_signatures_from_payload(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn has_new_governed_server_tool_calls_json(
    before_json: String,
    after_json: String,
) -> NapiResult<String> {
    let before: Value =
        serde_json::from_str(&before_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let after: Value =
        serde_json::from_str(&after_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    serde_json::to_string(&has_new_governed_server_tool_calls(&before, &after))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn responses_payload_requires_submit_tool_outputs_json(
    payload_json: String,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    serde_json::to_string(&responses_payload_requires_submit_tool_outputs(&payload))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn responses_payload_requires_submit_tool_outputs_ignores_completed_function_call_items() {
        let payload = json!({
            "status": "completed",
            "output": [
                {
                    "type": "function_call",
                    "status": "completed",
                    "call_id": "native:run_command:3",
                    "name": "run_command",
                    "arguments": "{}"
                }
            ]
        });
        assert!(!responses_payload_requires_submit_tool_outputs(&payload));
    }
}
