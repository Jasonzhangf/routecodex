use serde_json::{Map, Value};

use crate::hub_pipeline_lib::errors::{HubPipelineError, HubPipelineResult};
use crate::metadata_center::{
    build_metadata_center_from_snapshot, build_stopless_metadata_center_reset_write_plan,
    MetadataCenterReader,
};
use crate::servertool_core_blocks::inspect_stop_gateway_signal;
use crate::shared_json_utils::parse_json_with_context;
use crate::stopless_auto_handler_bridge::{
    build_stopless_auto_cli_projection_from_engine_json, run_stopless_auto_handler_runtime_json,
};
use crate::stopless_current_turn::build_stop_hook_guidance_text_from_output;

pub(crate) struct ServertoolHookOutput {
    pub payload: Option<Value>,
    pub flow_id: Option<String>,
    pub metadata_write_plan: Option<Value>,
    pub alarm: Option<Value>,
}

pub(crate) fn rewrite_stopless_request_after_restore(
    request: &mut Map<String, Value>,
    cli_output: &Map<String, Value>,
) {
    strip_stopless_cli_history(request);
    let prompt =
        build_stop_hook_guidance_text_from_output(&Value::Object(cli_output.clone()).to_string());
    append_stopless_user_prompt(request, prompt);
}

fn append_stopless_user_prompt(request: &mut Map<String, Value>, prompt: String) {
    if prompt.trim().is_empty() {
        return;
    }
    if let Some(input) = request.get_mut("input").and_then(Value::as_array_mut) {
        input.push(serde_json::json!({
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": prompt }]
        }));
        return;
    }
    if let Some(messages) = request.get_mut("messages").and_then(Value::as_array_mut) {
        messages.push(serde_json::json!({
            "role": "user",
            "content": prompt
        }));
    }
}

fn strip_stopless_cli_history(request: &mut Map<String, Value>) {
    for key in ["input", "messages"] {
        if let Some(items) = request.get_mut(key).and_then(Value::as_array_mut) {
            strip_stopless_cli_items(items);
        }
    }
    if let Some(items) = request
        .get_mut("semantics")
        .and_then(Value::as_object_mut)
        .and_then(|semantics| semantics.get_mut("input"))
        .and_then(Value::as_array_mut)
    {
        strip_stopless_cli_items(items);
    }
}

fn strip_stopless_cli_items(items: &mut Vec<Value>) {
    let original = std::mem::take(items);
    for item in original {
        if item_is_stopless_cli_artifact(&item) {
            continue;
        }
        items.push(item);
    }
}

fn item_is_stopless_cli_artifact(item: &Value) -> bool {
    let Some(row) = item.as_object() else {
        return false;
    };
    if output_is_stopless_cli(row.get("output").or_else(|| row.get("content"))) {
        return true;
    }
    let item_type = row
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let name = row
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if matches!(name, "reasoningStop" | "stop_message_auto") {
        return true;
    }
    if row
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|tool_calls| tool_calls.iter().any(item_is_stopless_nested_tool_call))
    {
        return true;
    }
    if item_type == "function_call" && name == "exec_command" {
        let arguments = row
            .get("arguments")
            .map(Value::to_string)
            .unwrap_or_default();
        return arguments.contains("routecodex hook run reasoningStop")
            || arguments.contains("routecodex hook run stop_message_auto")
            || (arguments.contains("stop_message_flow") && arguments.contains("repeatCount"));
    }
    false
}

fn item_is_stopless_nested_tool_call(call: &Value) -> bool {
    let Some(row) = call.as_object() else {
        return false;
    };
    let function = row
        .get("function")
        .and_then(Value::as_object)
        .unwrap_or(row);
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if matches!(name, "reasoningStop" | "stop_message_auto") {
        return true;
    }
    if name != "exec_command" {
        return false;
    }
    let arguments = function
        .get("arguments")
        .map(Value::to_string)
        .unwrap_or_default();
    arguments.contains("routecodex hook run reasoningStop")
        || arguments.contains("routecodex hook run stop_message_auto")
        || (arguments.contains("stop_message_flow") && arguments.contains("repeatCount"))
}

fn output_is_stopless_cli(output: Option<&Value>) -> bool {
    let Some(output) = output else {
        return false;
    };
    let parsed = match output {
        Value::Object(row) => Some(row.clone()),
        Value::String(raw) => serde_json::from_str::<Value>(raw.trim())
            .ok()
            .and_then(|value| value.as_object().cloned()),
        _ => None,
    };
    let Some(row) = parsed else {
        return false;
    };
    let tool_name = row
        .get("toolName")
        .or_else(|| row.get("tool_name"))
        .or_else(|| row.get("tool"))
        .or_else(|| row.get("kind"))
        .and_then(Value::as_str)
        .map(str::trim);
    if tool_name == Some("stop_message_auto") {
        return true;
    }
    let flow_id = row
        .get("flowId")
        .or_else(|| row.get("flow_id"))
        .and_then(Value::as_str)
        .map(str::trim);
    flow_id == Some("stop_message_flow")
}

pub(crate) fn run_stopless_response_hook(
    chatprocess_payload: &Value,
    metadata_center_snapshot: &Value,
    request_id: &str,
) -> HubPipelineResult<Option<ServertoolHookOutput>> {
    let runtime_active = is_stopless_runtime_active(metadata_center_snapshot);
    let response_runtime_enabled =
        is_stop_message_response_runtime_enabled(metadata_center_snapshot);
    let stop_gateway = inspect_stop_gateway_signal(&chatprocess_payload.to_string())
        .ok()
        .and_then(|raw| parse_json_with_context::<Value>(&raw, "inspect stop gateway signal").ok())
        .unwrap_or(Value::Null);
    let stop_gateway_eligible = stop_gateway
        .get("eligible")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let stop_gateway_reason = stop_gateway
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let gateway_internal_stop_tool = stop_gateway_eligible
        && matches!(
            stop_gateway_reason,
            "finish_reason_tool_calls_internal_stop_tool"
                | "responses_required_action_internal_stop_tool"
        );
    let gateway_requires_stopless = stop_gateway_eligible
        && matches!(
            stop_gateway_reason,
            "finish_reason_stop"
                | "finish_reason_tool_calls_internal_stop_tool"
                | "responses_required_action_internal_stop_tool"
                | "status_completed"
                | "responses_output_completed"
        );
    if !runtime_active && !response_runtime_enabled && !gateway_internal_stop_tool {
        return Ok(None);
    }
    let center = build_metadata_center_from_snapshot(metadata_center_snapshot);
    let request_session_id = center
        .request_truth
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if request_session_id.is_none() {
        if !runtime_active && !gateway_requires_stopless {
            return Ok(None);
        }
        return Ok(Some(ServertoolHookOutput {
            payload: None,
            flow_id: Some("stop_message_flow".to_string()),
            metadata_write_plan: None,
            alarm: Some(serde_json::json!({
                "alarm": "stopless_missing_session_id",
                "requestId": request_id,
                "reason": "stopless requires requestTruth.sessionId before interception",
            })),
        }));
    }
    if !gateway_requires_stopless {
        if !runtime_active {
            return Ok(None);
        }
        let reset_plan = build_stopless_metadata_center_reset_write_plan(
            &center,
            request_id,
            current_timestamp_ms()?,
            "non_stop_response",
            true,
        );
        return Ok(Some(ServertoolHookOutput {
            payload: None,
            flow_id: Some("stop_message_flow".to_string()),
            metadata_write_plan: Some(serde_json::to_value(reset_plan).map_err(|error| {
                HubPipelineError::new(
                    "hub_pipeline_stopless_reset_plan_invalid",
                    format!("Rust stopless reset write plan failed to serialize: {error}"),
                )
            })?),
            alarm: None,
        }));
    }
    let runtime_input = serde_json::json!({
        "base": chatprocess_payload,
        "requestId": request_id,
        "runtimeMetadata": {
            "metadataCenterSnapshot": sanitize_stopless_metadata_center_snapshot(metadata_center_snapshot, request_session_id)
        }
    });
    let raw_runtime =
        run_stopless_auto_handler_runtime_json(runtime_input.to_string()).map_err(|error| {
            HubPipelineError::new("hub_pipeline_stopless_resp_hook_failed", error.reason)
        })?;
    let runtime_output: Value = parse_json_with_context(
        &raw_runtime,
        "Rust stopless response hook runtime returned invalid JSON",
    )
    .map_err(|message| {
        HubPipelineError::new("hub_pipeline_stopless_resp_hook_invalid_output", message)
    })?;
    let action = runtime_output
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let flow_id = runtime_output
        .get("flowId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let metadata_write_plan = runtime_output.get("metadataWritePlan").cloned();
    match action {
        "return_null" => Ok(None),
        "throw_error" => {
            let message = runtime_output
                .get("error")
                .and_then(|value| value.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Rust stopless inline runtime requested an error");
            Err(HubPipelineError::new(
                "hub_pipeline_stopless_resp_hook_runtime_error",
                message.to_string(),
            ))
        }
        "return_handler_result" => {
            let handler_result = runtime_output.get("handlerResult").ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_stopless_resp_hook_missing_handler_result",
                    "Rust stopless response hook runtime missing handlerResult",
                )
            })?;
            let execution = handler_result.get("execution").cloned().ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_stopless_resp_hook_missing_execution",
                    "Rust stopless response hook runtime missing handler execution",
                )
            })?;
            let terminal_final = execution
                .get("context")
                .and_then(|context| context.get("stopMessageTerminalFinal"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let payload = if terminal_final {
                require_terminal_stopless_chat_response(handler_result)?
            } else {
                let projection_input = serde_json::json!({
                    "metadataCenterSnapshot": metadata_center_snapshot,
                    "execution": execution,
                    "metadataWritePlan": metadata_write_plan,
                    "requestId": request_id
                });
                let raw_projection = build_stopless_auto_cli_projection_from_engine_json(
                    projection_input.to_string(),
                )
                .map_err(|error| {
                    HubPipelineError::new(
                        "hub_pipeline_stopless_resp_hook_projection_failed",
                        error.reason,
                    )
                })?;
                let projection_output: Value = parse_json_with_context(
                    &raw_projection,
                    "Rust stopless response hook projection returned invalid JSON",
                )
                .map_err(|message| {
                    HubPipelineError::new(
                        "hub_pipeline_stopless_resp_hook_projection_invalid_output",
                        message,
                    )
                })?;
                projection_output
                    .get("chatResponse")
                    .cloned()
                    .ok_or_else(|| {
                        HubPipelineError::new(
                            "hub_pipeline_stopless_resp_hook_projection_missing_chat_response",
                            "Rust stopless response hook projection missing chatResponse",
                        )
                    })?
            };
            Ok(Some(ServertoolHookOutput {
                payload: Some(payload),
                flow_id,
                metadata_write_plan,
                alarm: None,
            }))
        }
        _ => Err(HubPipelineError::new(
            "hub_pipeline_stopless_resp_hook_unknown_action",
            format!("Rust stopless response hook runtime returned unsupported action: {action}"),
        )),
    }
}

pub(crate) fn require_terminal_stopless_chat_response(
    handler_result: &Value,
) -> HubPipelineResult<Value> {
    handler_result.get("chatResponse").cloned().ok_or_else(|| {
        HubPipelineError::new(
            "hub_pipeline_stopless_resp_hook_terminal_missing_chat_response",
            "Rust stopless terminal handler result requires chatResponse",
        )
    })
}

fn current_timestamp_ms() -> HubPipelineResult<u64> {
    timestamp_ms_from_system_time(std::time::SystemTime::now())
}

pub(crate) fn timestamp_ms_from_system_time(
    now: std::time::SystemTime,
) -> HubPipelineResult<u64> {
    now.duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| {
            HubPipelineError::new(
                "hub_pipeline_state_clock_failed",
                format!("Rust HubPipeline state clock failed: {error}"),
            )
        })
}

fn read_stopless_session_id(stopless: &Value) -> Option<&str> {
    stopless
        .get("sessionId")
        .or_else(|| stopless.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn sanitize_stopless_metadata_center_snapshot(
    metadata_center_snapshot: &Value,
    request_session_id: Option<&str>,
) -> Value {
    let mut snapshot = metadata_center_snapshot.clone();
    let Some(request_session_id) = request_session_id else {
        return snapshot;
    };
    let Some(runtime_control) = snapshot
        .get_mut("runtimeControl")
        .and_then(Value::as_object_mut)
    else {
        return snapshot;
    };
    let should_reset = runtime_control
        .get("stopless")
        .is_some_and(|stopless| read_stopless_session_id(stopless) != Some(request_session_id));
    if should_reset {
        let max_repeats = runtime_control
            .get("stopless")
            .and_then(|stopless| {
                stopless
                    .get("maxRepeats")
                    .or_else(|| stopless.get("max_repeats"))
            })
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .unwrap_or(3);
        runtime_control.insert(
            "stopless".to_string(),
            serde_json::json!({
                "flowId": "stop_message_flow",
                "sessionId": request_session_id,
                "repeatCount": 0,
                "maxRepeats": max_repeats,
                "active": true,
                "triggerHint": "session_changed"
            }),
        );
    }
    snapshot
}

pub(crate) fn is_stopless_runtime_active(metadata_center_snapshot: &Value) -> bool {
    build_metadata_center_from_snapshot(metadata_center_snapshot)
        .runtime_control
        .stopless
        .active
        == Some(true)
}

fn is_stop_message_response_runtime_enabled(metadata_center_snapshot: &Value) -> bool {
    let center = build_metadata_center_from_snapshot(metadata_center_snapshot);
    center.stop_message_enabled().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_rewrite_strips_stopless_cli_pair_and_appends_user_prompt() {
        let mut request = json!({
            "input": [
                { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "fix stopless" }] },
                { "type": "function_call", "call_id": "call_stopless", "name": "exec_command", "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json '{}'\"}" },
                { "type": "function_call_output", "call_id": "call_stopless", "output": "{\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3}" }
            ]
        })
        .as_object()
        .cloned()
        .unwrap();
        let cli_output = json!({
            "toolName": "stop_message_auto",
            "flowId": "stop_message_flow",
            "repeatCount": 1,
            "maxRepeats": 3
        })
        .as_object()
        .cloned()
        .unwrap();

        rewrite_stopless_request_after_restore(&mut request, &cli_output);

        let input = request.get("input").and_then(Value::as_array).unwrap();
        let serialized = serde_json::to_string(input).unwrap();
        assert_eq!(input.len(), 2);
        assert!(!serialized.contains("reasoningStop"));
        assert!(!serialized.contains("stop_message_auto"));
        assert!(serialized.contains("继续处理当前任务"));
    }

    #[test]
    fn request_rewrite_uses_next_step_prompt_when_schema_supplies_it() {
        let mut request = json!({
            "messages": [
                { "role": "user", "content": "task" },
                { "type": "function_call_output", "call_id": "call_stopless", "output": "{\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":1}" }
            ]
        })
        .as_object()
        .cloned()
        .unwrap();
        let cli_output = json!({
            "toolName": "stop_message_auto",
            "flowId": "stop_message_flow",
            "continuationPrompt": "运行 cargo test 验证",
            "schemaFeedback": { "reasonCode": "stop_schema_continue_next_step", "missingFields": [] },
            "repeatCount": 1,
            "maxRepeats": 3
        })
        .as_object()
        .cloned()
        .unwrap();

        rewrite_stopless_request_after_restore(&mut request, &cli_output);

        let messages = request.get("messages").and_then(Value::as_array).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["role"], json!("user"));
        assert_eq!(messages[1]["content"], json!("运行 cargo test 验证"));
    }
}
