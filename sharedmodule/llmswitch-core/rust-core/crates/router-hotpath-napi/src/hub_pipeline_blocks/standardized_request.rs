use crate::hub_bridge_actions::{convert_bridge_input_to_chat_messages, BridgeInputToChatInput};
use crate::hub_req_inbound_context_capture::normalize_responses_input_items;
use crate::hub_req_inbound_tool_call_normalization::{
    build_stop_hook_guidance_text_from_output, build_stop_hook_reasoning_stop_output_text,
};
use crate::hub_standardized_bridge::normalize_chat_envelope_tool_calls;
use crate::shared_json_utils::read_trimmed_string;
use crate::virtual_router_engine::derive_model_id;
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

    let metadata_from_normalized = normalized
        .get("metadata")
        .and_then(|v| v.as_object())
        .cloned();
    let model = payload
        .get("model")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| derive_model_from_continuation_metadata(metadata_from_normalized.as_ref()))
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
    let submit_tool_outputs_input = payload
        .get("tool_outputs")
        .and_then(|v| v.as_array())
        .cloned()
        .map(normalize_submit_tool_outputs_as_responses_input);
    let messages =
        if let Some(messages) = payload.get("messages").and_then(|v| v.as_array()).cloned() {
            messages
        } else if let Some(input_items) = payload.get("input").and_then(|v| v.as_array()).cloned() {
            let normalized_input_items =
                normalize_responses_input_items(payload).unwrap_or_else(|| input_items.clone());
            let allow_output_only_resume_tool_result =
                is_output_only_resume_tool_result(payload, normalized_input_items.as_slice());
            convert_bridge_input_to_chat_messages(BridgeInputToChatInput {
                input: drop_stale_orphan_responses_tool_outputs(payload, normalized_input_items),
                tools: tools.clone(),
                tool_result_fallback_text: None,
                normalize_function_name: Some("responses".to_string()),
                allow_pending_terminal_tool_call: Some(true),
                allow_orphan_tool_result: Some(allow_output_only_resume_tool_result),
            })?
            .messages
        } else if let Some(input_items) = submit_tool_outputs_input.clone() {
            convert_bridge_input_to_chat_messages(BridgeInputToChatInput {
                input: input_items,
                tools: tools.clone(),
                tool_result_fallback_text: None,
                normalize_function_name: Some("responses".to_string()),
                allow_pending_terminal_tool_call: Some(true),
                allow_orphan_tool_result: Some(true),
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
    } else if let Some(input_array) = submit_tool_outputs_input.as_ref() {
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

fn derive_model_from_continuation_metadata(
    metadata: Option<&Map<String, Value>>,
) -> Option<String> {
    let metadata = metadata?;
    let provider_key = read_trimmed_string(metadata.get("retryProviderKey")).or_else(|| {
        metadata
            .get("responsesResume")
            .and_then(Value::as_object)
            .and_then(|resume| read_trimmed_string(resume.get("providerKey")))
    })?;
    let model = derive_model_id(provider_key.as_str());
    let model = model.trim();
    if model.is_empty() {
        None
    } else {
        Some(model.to_string())
    }
}

fn normalize_submit_tool_outputs_as_responses_input(tool_outputs: Vec<Value>) -> Vec<Value> {
    tool_outputs
        .into_iter()
        .map(|entry| {
            let Some(row) = entry.as_object() else {
                return entry;
            };
            let mut normalized = row.clone();
            normalized
                .entry("type".to_string())
                .or_insert_with(|| Value::String("function_call_output".to_string()));
            Value::Object(normalized)
        })
        .collect()
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

fn responses_function_call_semantic_signature(entry: &Value) -> Option<String> {
    let row = entry.as_object()?;
    if !is_responses_function_call_item(entry) {
        return None;
    }
    let call_id = read_trimmed_string(row.get("call_id"))
        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
        .or_else(|| read_trimmed_string(row.get("id")))?;
    let name = read_trimmed_string(row.get("name")).unwrap_or_default();
    let arguments = match row.get("arguments") {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(other) => serde_json::to_string(other).unwrap_or_else(|_| format!("{other:?}")),
        None => String::new(),
    };
    Some(format!("{call_id}\u{1f}{name}\u{1f}{arguments}"))
}

fn responses_tool_output_call_id(entry: &Value) -> Option<String> {
    let row = entry.as_object()?;
    if !is_responses_tool_output_item(entry) {
        return None;
    }
    read_trimmed_string(row.get("call_id"))
        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
        .or_else(|| read_trimmed_string(row.get("tool_use_id")))
        .or_else(|| read_trimmed_string(row.get("id")))
}

fn dedupe_identical_responses_tool_history_entries(input_items: Vec<Value>) -> Vec<Value> {
    let mut repeated_semantic_call_ids = std::collections::HashSet::<String>::new();
    let mut semantic_call_signature_counts = std::collections::HashMap::<String, usize>::new();
    for entry in &input_items {
        let Some(signature) = responses_function_call_semantic_signature(entry) else {
            continue;
        };
        let count = semantic_call_signature_counts
            .entry(signature.clone())
            .or_insert(0);
        *count += 1;
        if *count > 1 {
            if let Some((call_id, _)) = signature.split_once('\u{1f}') {
                repeated_semantic_call_ids.insert(call_id.to_string());
            }
        }
    }

    let mut seen_function_call_signatures = std::collections::HashSet::<String>::new();
    let mut seen_output_signatures = std::collections::HashSet::<String>::new();
    let mut seen_replayed_output_call_ids = std::collections::HashSet::<String>::new();
    let mut deduped = Vec::with_capacity(input_items.len());

    for entry in input_items {
        if let Some(signature) = responses_function_call_semantic_signature(&entry) {
            if !seen_function_call_signatures.insert(signature) {
                continue;
            }
            deduped.push(entry);
            continue;
        }

        if let Some(call_id) = responses_tool_output_call_id(&entry) {
            if repeated_semantic_call_ids.contains(call_id.as_str())
                && !seen_replayed_output_call_ids.insert(call_id.clone())
            {
                continue;
            }
            let signature = serde_json::to_string(&entry).unwrap_or_else(|_| format!("{entry:?}"));
            if !seen_output_signatures.insert(signature) {
                continue;
            }
        }
        deduped.push(entry);
    }

    deduped
}

fn drop_stale_orphan_responses_tool_outputs(
    payload: &Map<String, Value>,
    input_items: Vec<Value>,
) -> Vec<Value> {
    let input_items = dedupe_identical_responses_tool_history_entries(input_items);
    if is_output_only_resume_tool_result(payload, input_items.as_slice()) {
        return input_items;
    }
    let has_function_call = input_items.iter().any(is_responses_function_call_item);
    if has_function_call {
        let mut pending_call_ids = std::collections::HashSet::new();
        for entry in input_items.iter() {
            let Some(row) = entry.as_object() else {
                continue;
            };
            if !is_responses_function_call_item(entry) {
                continue;
            }
            let Some(call_id) = read_trimmed_string(row.get("call_id"))
                .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                .or_else(|| read_trimmed_string(row.get("id")))
            else {
                continue;
            };
            pending_call_ids.insert(call_id);
        }
        return input_items
            .into_iter()
            .filter(|entry| {
                if !is_responses_tool_output_item(entry) {
                    return true;
                }
                let Some(row) = entry.as_object() else {
                    return false;
                };
                let call_id = read_trimmed_string(row.get("call_id"))
                    .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                    .or_else(|| read_trimmed_string(row.get("tool_use_id")))
                    .or_else(|| read_trimmed_string(row.get("id")));
                match call_id {
                    Some(id) => pending_call_ids.contains(id.as_str()),
                    None => false,
                }
            })
            .collect();
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
    if let Some(parameters) = tool_map
        .get("parameters")
        .or_else(|| tool_map.get("input_schema"))
        .cloned()
    {
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
    fn normalize_tool_definition_preserves_top_level_input_schema_as_parameters() {
        let normalized = normalize_tool_definition(&json!({
            "type": "function",
            "name": "read_file",
            "description": "Read file",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }
        }));

        assert_eq!(normalized["function"]["name"], "read_file");
        assert_eq!(
            normalized["function"]["parameters"]["properties"]["path"]["type"],
            "string"
        );
        assert_eq!(
            normalized["function"]["parameters"]["required"],
            json!(["path"])
        );
    }

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
    fn responses_standardization_does_not_restore_stopless_resume_tool_output_from_metadata() {
        let stopless_output = json!({
            "ok": true,
            "kind": "stop_message_auto",
            "tool": "stop_message_auto",
            "toolName": "stop_message_auto",
            "flowId": "stop_message_flow",
            "summary": "stopless continuation ready",
            "continuationPrompt": "继续推进当前任务。",
            "repeatCount": 1,
            "maxRepeats": 3,
            "schemaFeedback": {
                "reasonCode": "stop_schema_continue_next_step",
                "missingFields": []
            },
            "input": {
                "flowId": "stop_message_flow",
                "maxRepeats": 3,
                "repeatCount": 1,
                "triggerHint": "non_terminal_schema"
            }
        })
        .to_string();
        let input = json!({
            "payload": {
                "model": "glm-5.2",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "original task" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "继续执行，完成既定目标。" }] }
                ]
            },
            "normalized": {
                "id": "req_test",
                "entryEndpoint": "/v1/responses",
                "stream": false,
                "processMode": "chat",
                "metadata": {
                    "responsesResume": {
                        "continuationOwner": "relay",
                        "entryKind": "responses",
                        "toolOutputsDetailed": [{
                            "callId": "call_stopless_resume",
                            "originalId": "call_stopless_resume",
                            "outputText": stopless_output
                        }]
                    }
                }
            }
        });

        let output = coerce_standardized_request_from_payload(&input).unwrap();
        let messages = output["standardizedRequest"]["messages"]
            .as_array()
            .expect("standardized messages");
        let serialized = serde_json::to_string(messages).unwrap();
        assert!(
            !serialized.contains("reasoningStop"),
            "request standardization must not restore stopless resume output from continuation metadata: {}",
            serialized
        );
        assert!(
            !serialized.contains("repeatCount=1/3"),
            "request standardization must not render stopless guidance from continuation metadata: {}",
            serialized
        );
        assert!(
            !serialized.contains("stop_message_auto"),
            "continuation metadata stopless identity must not be projected by request standardization: {}",
            serialized
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
    fn responses_standardization_preserves_submit_tool_outputs_in_semantics_input() {
        let input = json!({
            "payload": {
                "model": "gpt-test",
                "previous_response_id": "resp_prev",
                "tool_outputs": [{
                    "tool_call_id": "call_stopless_round1",
                    "output": "{\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3}"
                }]
            },
            "normalized": {
                "id": "req_submit_tool_outputs",
                "entryEndpoint": "/v1/responses.submit_tool_outputs",
                "stream": false,
                "processMode": "chat"
            }
        });

        let output = coerce_standardized_request_from_payload(&input).unwrap();
        let semantics_input = output["standardizedRequest"]["semantics"]["input"]
            .as_array()
            .expect("semantics input");
        assert_eq!(semantics_input.len(), 1);
        assert_eq!(semantics_input[0]["type"], json!("function_call_output"));
        assert_eq!(semantics_input[0]["tool_call_id"], json!("call_stopless_round1"));
    }

    #[test]
    fn responses_standardization_drops_stale_tool_output_when_new_function_call_exists() {
        let input = json!({
            "payload": {
                "model": "gpt-test",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "continue" }] },
                    { "type": "function_call_output", "call_id": "call_stale", "output": "stale output from prior turn" },
                    { "type": "function_call", "call_id": "call_live", "name": "exec_command", "arguments": "{}" }
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
        let messages = output["standardizedRequest"]["messages"]
            .as_array()
            .expect("messages");
        let serialized = serde_json::to_string(messages).unwrap();
        assert!(!serialized.contains("call_stale"));
        assert!(!serialized.contains("stale output from prior turn"));
    }

    #[test]
    fn responses_standardization_keeps_matching_tool_output_for_current_function_call() {
        let input = json!({
            "payload": {
                "model": "gpt-test",
                "input": [
                    { "type": "function_call", "call_id": "call_live", "name": "exec_command", "arguments": "{}" },
                    { "type": "function_call_output", "call_id": "call_live", "output": "ok" },
                    { "type": "function_call_output", "call_id": "call_stale", "output": "stale" }
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
        let messages = output["standardizedRequest"]["messages"]
            .as_array()
            .expect("messages");
        let serialized = serde_json::to_string(messages).unwrap();
        assert!(!serialized.contains("call_stale"));
    }

    #[test]
    fn responses_standardization_dedupes_identical_duplicate_tool_history_block() {
        let input = json!({
            "payload": {
                "model": "gpt-test",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "continue" }] },
                    { "type": "function_call", "call_id": "call_dup", "id": "call_dup", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    { "type": "function_call_output", "call_id": "call_dup", "id": "out_dup", "output": "{\"stdout\":\"/tmp\"}" },
                    { "type": "function_call", "call_id": "call_dup", "id": "call_dup", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    { "type": "function_call_output", "call_id": "call_dup", "id": "out_dup", "output": "{\"stdout\":\"/tmp\"}" }
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
        let messages = output["standardizedRequest"]["messages"]
            .as_array()
            .expect("messages");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[1]["role"], json!("assistant"));
        assert_eq!(messages[2]["role"], json!("tool"));
    }

    #[test]
    fn responses_standardization_dedupes_duplicate_tool_history_block_with_different_chunk_headers()
    {
        let input = json!({
            "payload": {
                "model": "gpt-test",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "continue" }] },
                    { "type": "function_call", "call_id": "call_dup", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    { "type": "function_call_output", "call_id": "call_dup", "output": "Chunk ID: aaa\\nOutput:\\n/tmp\\n" },
                    { "type": "function_call", "call_id": "call_dup", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    { "type": "function_call_output", "call_id": "call_dup", "output": "Chunk ID: bbb\\nOutput:\\n/tmp\\n" }
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
        let messages = output["standardizedRequest"]["messages"]
            .as_array()
            .expect("messages");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[1]["role"], json!("assistant"));
        assert_eq!(messages[2]["role"], json!("tool"));
    }

    #[test]
    fn responses_standardization_keeps_distinct_duplicate_tool_outputs_invalid() {
        let input = json!({
            "payload": {
                "model": "gpt-test",
                "input": [
                    { "type": "function_call", "call_id": "call_dup", "id": "call_dup", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    { "type": "function_call_output", "call_id": "call_dup", "id": "out_dup_1", "output": "{\"stdout\":\"/tmp\"}" },
                    { "type": "function_call_output", "call_id": "call_dup", "id": "out_dup_2", "output": "{\"stdout\":\"/var\"}" }
                ]
            },
            "normalized": {
                "id": "req_test",
                "entryEndpoint": "/v1/responses",
                "stream": true,
                "processMode": "chat"
            }
        });

        let error = coerce_standardized_request_from_payload(&input).unwrap_err();
        assert!(error.contains("already-consumed"));
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
