use crate::hub_bridge_actions::{convert_bridge_input_to_chat_messages, BridgeInputToChatInput};
use crate::hub_standardized_bridge::normalize_chat_envelope_tool_calls;
use crate::shared_json_utils::read_trimmed_string;
use serde_json::{Map, Value};

pub(crate) fn coerce_standardized_request_from_payload(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "coerce standardized request input must be object".to_string())?;
    let raw_payload = row
        .get("payload")
        .cloned()
        .ok_or_else(|| "payload must be object".to_string())?;
    let raw_payload = raw_payload
        .as_object()
        .ok_or_else(|| "payload must be object".to_string())?;
    let normalized_payload_value =
        normalize_chat_envelope_tool_calls(&Value::Object(raw_payload.clone()))
            .map_err(|err| err.to_string())?;
    let payload = normalized_payload_value
        .as_object()
        .ok_or_else(|| "payload must be object".to_string())?;
    let normalized = row
        .get("normalized")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "normalized must be object".to_string())?;

    let model = payload
        .get("model")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "[HubPipeline] outbound stage requires payload.model".to_string())?;
    let tools = payload
        .get("tools")
        .and_then(|v| v.as_array())
        .map(|tools| {
            tools
                .iter()
                .map(normalize_tool_definition)
                .collect::<Vec<_>>()
        });
    let messages =
        if let Some(messages) = payload.get("messages").and_then(|v| v.as_array()).cloned() {
            messages
        } else if let Some(input_items) = payload.get("input").and_then(|v| v.as_array()).cloned() {
            let allow_output_only_resume_tool_result =
                is_output_only_resume_tool_result(payload, input_items.as_slice());
            convert_bridge_input_to_chat_messages(BridgeInputToChatInput {
                input: drop_stale_orphan_responses_tool_outputs(payload, input_items),
                tools: tools.clone(),
                tool_result_fallback_text: None,
                normalize_function_name: Some("responses".to_string()),
                allow_pending_terminal_tool_call: Some(true),
                allow_orphan_tool_result: Some(allow_output_only_resume_tool_result),
            })?
            .messages
        } else if let Some(input_text) = payload
            .get("input")
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            vec![serde_json::json!({ "role": "user", "content": input_text })]
        } else {
            return Err(
                "[HubPipeline] outbound stage requires payload.messages[] or payload.input[]"
                    .to_string(),
            );
        };
    let parameters = payload
        .get("parameters")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let semantics_from_payload = payload
        .get("semantics")
        .and_then(|v| v.as_object())
        .cloned();
    let metadata_from_normalized = normalized
        .get("metadata")
        .and_then(|v| v.as_object())
        .cloned();
    let previous_response_id = payload
        .get("previous_response_id")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let mut metadata = Map::<String, Value>::new();
    metadata.insert(
        "originalEndpoint".to_string(),
        Value::String(
            normalized
                .get("entryEndpoint")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        ),
    );
    if let Some(source_metadata) = metadata_from_normalized {
        for (key, value) in source_metadata {
            metadata.insert(key, value);
        }
    }
    metadata.insert(
        "requestId".to_string(),
        Value::String(
            normalized
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        ),
    );
    metadata.insert(
        "stream".to_string(),
        Value::Bool(
            normalized
                .get("stream")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        ),
    );
    metadata.insert(
        "processMode".to_string(),
        Value::String(
            normalized
                .get("processMode")
                .and_then(|v| v.as_str())
                .unwrap_or("chat")
                .to_string(),
        ),
    );
    if let Some(route_hint) = normalized.get("routeHint").and_then(|v| v.as_str()) {
        if !route_hint.is_empty() {
            metadata.insert(
                "routeHint".to_string(),
                Value::String(route_hint.to_string()),
            );
        }
    }

    let mut semantics = semantics_from_payload.unwrap_or_default();
    if let Some(previous_response_id) = previous_response_id.clone() {
        let continuation_node = semantics
            .entry("continuation".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !continuation_node.is_object() {
            *continuation_node = Value::Object(Map::new());
        }
        if let Some(continuation_map) = continuation_node.as_object_mut() {
            let resume_from = continuation_map
                .entry("resumeFrom".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if !resume_from.is_object() {
                *resume_from = Value::Object(Map::new());
            }
            if let Some(resume_from_map) = resume_from.as_object_mut() {
                resume_from_map.insert(
                    "previousResponseId".to_string(),
                    Value::String(previous_response_id.clone()),
                );
            }
        }
    }
    let tools_node = semantics
        .entry("tools".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !tools_node.is_object() {
        *tools_node = Value::Object(Map::new());
    }
    if let Some(tools_array) = tools.as_ref() {
        if !tools_array.is_empty() {
            if let Some(tools_map) = tools_node.as_object_mut() {
                if !tools_map.contains_key("clientToolsRaw") {
                    tools_map.insert(
                        "clientToolsRaw".to_string(),
                        Value::Array(tools_array.clone()),
                    );
                }
            }
        }
    }
    if let Some(input_array) = raw_payload.get("input").and_then(Value::as_array) {
        if !input_array.is_empty() && !semantics.contains_key("input") {
            semantics.insert("input".to_string(), Value::Array(input_array.clone()));
        }
    }

    let mut standardized_request = Map::<String, Value>::new();
    standardized_request.insert("model".to_string(), Value::String(model.clone()));
    standardized_request.insert("messages".to_string(), Value::Array(messages.clone()));
    if let Some(previous_response_id) = previous_response_id.clone() {
        standardized_request.insert(
            "previous_response_id".to_string(),
            Value::String(previous_response_id),
        );
    }
    if let Some(tools_array) = tools.as_ref() {
        standardized_request.insert("tools".to_string(), Value::Array(tools_array.clone()));
    }
    copy_optional_payload_fields(
        payload,
        &mut standardized_request,
        &[
            "tool_choice",
            "parallel_tool_calls",
            "temperature",
            "top_p",
            "max_tokens",
            "max_completion_tokens",
            "reasoning_effort",
        ],
    );
    standardized_request.insert("parameters".to_string(), Value::Object(parameters.clone()));
    standardized_request.insert("metadata".to_string(), Value::Object(metadata));
    standardized_request.insert("semantics".to_string(), Value::Object(semantics));

    let mut raw_payload = Map::<String, Value>::new();
    raw_payload.insert("model".to_string(), Value::String(model));
    raw_payload.insert("messages".to_string(), Value::Array(messages));
    if let Some(previous_response_id) = previous_response_id {
        raw_payload.insert(
            "previous_response_id".to_string(),
            Value::String(previous_response_id),
        );
    }
    if let Some(tools_array) = tools {
        raw_payload.insert("tools".to_string(), Value::Array(tools_array));
    }
    copy_optional_payload_fields(
        payload,
        &mut raw_payload,
        &[
            "tool_choice",
            "parallel_tool_calls",
            "temperature",
            "top_p",
            "max_tokens",
            "max_completion_tokens",
            "reasoning_effort",
        ],
    );
    if !parameters.is_empty() {
        raw_payload.insert("parameters".to_string(), Value::Object(parameters));
    }

    let mut output = Map::<String, Value>::new();
    output.insert(
        "standardizedRequest".to_string(),
        Value::Object(standardized_request),
    );
    output.insert("rawPayload".to_string(), Value::Object(raw_payload));
    Ok(Value::Object(output))
}

fn copy_optional_payload_fields(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    keys: &[&str],
) {
    for key in keys {
        if let Some(value) = source.get(*key).cloned() {
            target.insert((*key).to_string(), value);
        }
    }
}

fn is_responses_tool_output_item(value: &Value) -> bool {
    let Some(row) = value.as_object() else {
        return false;
    };
    let ty = read_trimmed_string(row.get("type"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        ty.as_str(),
        "function_call_output" | "tool_result" | "tool_message"
    )
}

fn is_responses_function_call_item(value: &Value) -> bool {
    let Some(row) = value.as_object() else {
        return false;
    };
    let ty = read_trimmed_string(row.get("type"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(ty.as_str(), "function_call" | "tool_call")
}

fn is_output_only_resume_tool_result(payload: &Map<String, Value>, input_items: &[Value]) -> bool {
    read_trimmed_string(payload.get("previous_response_id")).is_some()
        && input_items
            .iter()
            .all(|entry| !entry.is_object() || is_responses_tool_output_item(entry))
}

fn drop_stale_orphan_responses_tool_outputs(
    payload: &Map<String, Value>,
    input_items: Vec<Value>,
) -> Vec<Value> {
    if input_items.iter().any(is_responses_function_call_item) {
        return input_items;
    }
    if is_output_only_resume_tool_result(payload, input_items.as_slice()) {
        return input_items;
    }
    input_items
        .into_iter()
        .filter(|entry| !is_responses_tool_output_item(entry))
        .collect()
}

fn normalize_tool_definition(tool: &Value) -> Value {
    let Some(tool_map) = tool.as_object() else {
        return tool.clone();
    };
    if tool_map
        .get("function")
        .and_then(Value::as_object)
        .is_some()
    {
        return tool.clone();
    }
    if tool_map.get("type").and_then(Value::as_str) != Some("function") {
        return tool.clone();
    }
    let Some(name) = tool_map.get("name").cloned() else {
        return tool.clone();
    };
    let mut function = Map::new();
    function.insert("name".to_string(), name);
    if let Some(description) = tool_map.get("description").cloned() {
        function.insert("description".to_string(), description);
    }
    if let Some(parameters) = tool_map.get("parameters").cloned() {
        function.insert("parameters".to_string(), parameters);
    }
    let mut normalized = Map::new();
    normalized.insert("type".to_string(), Value::String("function".to_string()));
    normalized.insert("function".to_string(), Value::Object(function));
    Value::Object(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn responses_standardization_drops_mixed_orphan_tool_result_even_with_previous_response_id() {
        let input = json!({
            "payload": {
                "model": "minimax-m3-free",
                "previous_response_id": "resp_previous",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "continue" }] },
                    {
                        "type": "function_call_output",
                        "call_id": "call_1",
                        "output": "stale output from prior polluted context"
                    }
                ]
            },
            "normalized": {
                "id": "req_test",
                "entryEndpoint": "/v1/responses",
                "stream": true,
                "processMode": "chat"
            }
        });

        let output = coerce_standardized_request_from_payload(&input).unwrap();
        let standardized = output.get("standardizedRequest").unwrap();
        assert_eq!(standardized["messages"].as_array().unwrap().len(), 1);
        assert_eq!(standardized["messages"][0]["role"], json!("user"));
    }

    #[test]
    fn responses_standardization_allows_output_only_orphan_tool_result_with_previous_response_id() {
        let input = json!({
            "payload": {
                "model": "minimax-m3-free",
                "previous_response_id": "resp_previous",
                "input": [{
                    "type": "function_call_output",
                    "call_id": "call_function_snr978zyv21w_1",
                    "output": "ok"
                }]
            },
            "normalized": {
                "id": "req_test",
                "entryEndpoint": "/v1/responses",
                "stream": true,
                "processMode": "chat"
            }
        });

        let output = coerce_standardized_request_from_payload(&input).unwrap();
        let standardized = output.get("standardizedRequest").unwrap();
        assert_eq!(standardized["messages"].as_array().unwrap().len(), 1);
        assert_eq!(standardized["messages"][0]["role"], json!("tool"));
        assert_eq!(
            standardized["messages"][0]["tool_call_id"],
            json!("call_function_snr978zyv21w_1")
        );
    }

    #[test]
    fn responses_standardization_preserves_input_in_semantics_for_tool_result_followup() {
        let input = json!({
            "payload": {
                "model": "gpt-test",
                "input": [
                    { "type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{}" },
                    { "type": "function_call_output", "call_id": "call_1", "output": "ok" }
                ]
            },
            "normalized": {
                "id": "req_test",
                "entryEndpoint": "/v1/responses",
                "stream": true,
                "processMode": "chat"
            }
        });

        let output = coerce_standardized_request_from_payload(&input).unwrap();
        let semantics_input = output["standardizedRequest"]["semantics"]["input"]
            .as_array()
            .expect("semantics input");
        assert_eq!(semantics_input.len(), 2);
        assert_eq!(semantics_input[1]["type"], json!("function_call_output"));
    }

    #[test]
    fn takes_internal_metadata_from_normalized_carrier_not_payload() {
        let input = json!({
            "payload": {
                "model": "m",
                "input": [{ "role": "user", "content": "hi" }]
            },
            "normalized": {
                "id": "req_test",
                "entryEndpoint": "/v1/responses",
                "stream": true,
                "processMode": "chat",
                "metadata": { "routeHint": "tools", "sessionId": "s1" }
            }
        });

        let output = coerce_standardized_request_from_payload(&input).unwrap();
        let standardized = output.get("standardizedRequest").unwrap();
        assert_eq!(standardized["metadata"]["routeHint"], json!("tools"));
        assert_eq!(standardized["metadata"]["sessionId"], json!("s1"));
        assert!(output["rawPayload"].get("metadata").is_none());
    }
}
