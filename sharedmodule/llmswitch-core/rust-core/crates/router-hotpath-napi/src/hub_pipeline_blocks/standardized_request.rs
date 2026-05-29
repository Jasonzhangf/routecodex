use crate::hub_bridge_actions::{convert_bridge_input_to_chat_messages, BridgeInputToChatInput};
use crate::hub_standardized_bridge::normalize_chat_envelope_tool_calls;
use serde_json::{Map, Value};

pub(crate) fn coerce_standardized_request_from_payload(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "coerce standardized request input must be object".to_string())?;
    let payload = row
        .get("payload")
        .cloned()
        .ok_or_else(|| "payload must be object".to_string())?;
    let payload = normalize_chat_envelope_tool_calls(&payload).map_err(|err| err.to_string())?;
    let payload = payload
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
    let tools = payload.get("tools").and_then(|v| v.as_array()).cloned();
    let messages =
        if let Some(messages) = payload.get("messages").and_then(|v| v.as_array()).cloned() {
            messages
        } else if let Some(input_items) = payload.get("input").and_then(|v| v.as_array()).cloned() {
            convert_bridge_input_to_chat_messages(BridgeInputToChatInput {
                input: input_items,
                tools: tools.clone(),
                tool_result_fallback_text: None,
                normalize_function_name: Some("responses".to_string()),
                allow_pending_terminal_tool_call: Some(true),
                allow_orphan_tool_result: Some(
                    payload
                        .get("previous_response_id")
                        .and_then(|v| v.as_str())
                        .map(|v| !v.trim().is_empty())
                        .unwrap_or(false),
                ),
            })?
            .messages
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
    let metadata_from_payload = payload.get("metadata").and_then(|v| v.as_object()).cloned();
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
    if let Some(source_metadata) = metadata_from_payload {
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
