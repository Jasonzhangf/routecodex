use serde_json::{json, Map, Value};

use crate::hub_tool_session_compat::{
    filter_namespace_mcp_aggregator_tool_definitions, normalize_tool_session_messages,
};
use crate::shared_json_utils::{as_object, normalize_record};
use crate::shared_response_compat::{sanitize_chat_process_messages_value, SanitizeMessagesOutput};

use super::request_sanitizer::strip_generic_markers_from_request;

pub(crate) fn apply_chat_process_request_sanitizer(request: &mut Map<String, Value>) {
    strip_generic_markers_from_request(request);
    let sanitized = sanitize_chat_process_messages_value(&Value::Object(request.clone()));
    let normalized_messages = normalize_tool_session_messages(sanitized.messages.clone());
    request.insert("messages".to_string(), Value::Array(normalized_messages));
    if let Some(tools) = request.get_mut("tools") {
        filter_namespace_mcp_aggregator_tool_definitions(tools);
    }
    attach_chat_process_sanitizer_metadata(request, &sanitized);
}

pub(crate) fn build_governed_filter_payload(request: &Value) -> Value {
    let request_obj = as_object(request);
    let model = request_obj
        .and_then(|obj| obj.get("model"))
        .cloned()
        .unwrap_or(Value::Null);
    let messages = request_obj
        .and_then(|obj| obj.get("messages"))
        .filter(|v| v.is_array())
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    let semantics = request_obj
        .and_then(|obj| obj.get("semantics"))
        .cloned()
        .unwrap_or(Value::Null);
    let metadata = request_obj
        .and_then(|obj| obj.get("metadata"))
        .and_then(|v| v.as_object())
        .map(|row| Value::Object(row.clone()))
        .unwrap_or_else(|| Value::Object(Map::new()));
    let tools = request_obj
        .and_then(|obj| obj.get("tools"))
        .cloned()
        .unwrap_or(Value::Null);

    let parameters = request_obj
        .and_then(|obj| obj.get("parameters"))
        .and_then(|v| v.as_object())
        .map(|row| Value::Object(row.clone()))
        .unwrap_or_else(|| Value::Object(Map::new()));

    let parameter_obj = parameters.as_object();
    let tool_choice = request_obj
        .and_then(|obj| obj.get("tool_choice"))
        .or_else(|| parameter_obj.and_then(|obj| obj.get("tool_choice")))
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| {
            tools
                .as_array()
                .filter(|items| !items.is_empty())
                .map(|_| Value::String("auto".to_string()))
        });
    let stream = request_obj
        .and_then(|obj| obj.get("stream"))
        .or_else(|| parameter_obj.and_then(|obj| obj.get("stream")))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut out = Map::new();
    out.insert("model".to_string(), model);
    out.insert("messages".to_string(), messages);
    if !semantics.is_null() {
        out.insert("semantics".to_string(), semantics);
    }
    out.insert("metadata".to_string(), metadata);
    if !tools.is_null() {
        out.insert("tools".to_string(), tools);
    }
    if let Some(tool_choice) = tool_choice {
        out.insert("tool_choice".to_string(), tool_choice);
    }
    out.insert("stream".to_string(), Value::Bool(stream));
    out.insert("parameters".to_string(), parameters);
    Value::Object(out)
}

pub(crate) fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn build_node_result(
    success: bool,
    start_time_ms: u64,
    end_time_ms: u64,
    processed_request: &Map<String, Value>,
    error: Option<&str>,
) -> Value {
    let duration_ms = end_time_ms.saturating_sub(start_time_ms);
    let messages = processed_request
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|v| v.len() as u64)
        .unwrap_or(0);
    let tools = processed_request
        .get("tools")
        .and_then(|v| v.as_array())
        .map(|v| v.len() as u64)
        .unwrap_or(0);

    let mut result = Map::new();
    result.insert("success".to_string(), Value::Bool(success));
    result.insert(
        "metadata".to_string(),
        json!({
          "node": "hub-chat-process",
          "executionTime": duration_ms,
          "startTime": start_time_ms,
          "endTime": end_time_ms
        }),
    );
    result.insert(
        "observation".to_string(),
        json!({
          "dataProcessed": {
            "messages": messages,
            "tools": tools
          }
        }),
    );

    if let Some(err) = error {
        let mut err_map = Map::new();
        err_map.insert(
            "code".to_string(),
            Value::String("tool_governance_error".to_string()),
        );
        err_map.insert("message".to_string(), Value::String(err.to_string()));
        result.insert("error".to_string(), Value::Object(err_map));
    }

    Value::Object(result)
}

pub(crate) fn build_processed_request(governed: Value, metadata: &Map<String, Value>) -> Value {
    let mut processed = normalize_record(governed);
    let stream_enabled = processed
        .get("parameters")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("stream"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut merged_metadata = metadata.clone();
    let governed_metadata = processed
        .get("metadata")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    for (key, value) in governed_metadata {
        merged_metadata.insert(key, value);
    }
    processed.insert("metadata".to_string(), Value::Object(merged_metadata));

    let timestamp = now_millis();
    processed.insert(
        "processed".to_string(),
        json!({
          "timestamp": timestamp,
          "appliedRules": ["tool-governance"],
          "status": "success"
        }),
    );
    let mut processing_metadata = Map::new();
    processing_metadata.insert(
        "streaming".to_string(),
        json!({
          "enabled": stream_enabled,
          "chunkCount": 0
        }),
    );
    processed.insert(
        "processingMetadata".to_string(),
        Value::Object(processing_metadata),
    );
    Value::Object(processed)
}

fn attach_chat_process_sanitizer_metadata(
    request: &mut Map<String, Value>,
    sanitize_output: &SanitizeMessagesOutput,
) {
    if sanitize_output.removed_assistant_turns < 1 && !sanitize_output.did_mutate_message_shapes {
        return;
    }

    let metadata = request
        .entry("metadata".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !metadata.is_object() {
        *metadata = Value::Object(Map::new());
    }
    let Some(metadata_obj) = metadata.as_object_mut() else {
        return;
    };

    metadata_obj.insert(
        "chatProcessSanitizer".to_string(),
        json!({
            "removedAssistantTurns": sanitize_output.removed_assistant_turns,
            "removedEmptyAssistantTurns": sanitize_output.removed_empty_assistant_turns,
            "removedTemplateAssistantTurns": sanitize_output.removed_template_assistant_turns,
            "removedDuplicateMirrorAssistantTurns": sanitize_output.removed_duplicate_mirror_assistant_turns,
            "removedHistoricalGoalTurns": sanitize_output.removed_historical_goal_turns,
            "removedToolTurns": 0,
            "removedEmptyToolTurns": 0,
            "removedOrphanToolTurns": 0,
            "backfilledToolCallIds": 0
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn governed_filter_payload_defaults_tool_choice_auto_when_tools_exist() {
        let output = build_governed_filter_payload(&json!({
            "model": "MiniMax-M3",
            "messages": [{ "role": "user", "content": "继续执行" }],
            "tools": [{ "type": "function", "function": { "name": "apply_patch" } }]
        }));

        assert_eq!(output["tool_choice"], json!("auto"));
    }

    #[test]
    fn governed_filter_payload_drops_null_tool_choice_without_tools() {
        let output = build_governed_filter_payload(&json!({
            "model": "MiniMax-M3",
            "messages": [],
            "tool_choice": null
        }));

        assert!(!output.as_object().unwrap().contains_key("tool_choice"));
    }
}
