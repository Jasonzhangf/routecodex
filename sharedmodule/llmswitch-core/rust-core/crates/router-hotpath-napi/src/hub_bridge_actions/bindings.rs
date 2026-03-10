use napi::bindgen_prelude::Result as NapiResult;
use serde_json::Value;

use super::bridge_input::{
    convert_bridge_input_to_chat_messages, extract_reasoning_segments_from_text, repair_tool_calls,
    validate_tool_arguments,
};
use super::history::{
    apply_bridge_capture_tool_results, apply_bridge_ensure_tool_placeholders,
    apply_bridge_normalize_history, build_bridge_history, ensure_bridge_output_fields,
    filter_bridge_input_for_upstream, normalize_bridge_history_seed,
    prepare_responses_request_envelope, resolve_responses_bridge_tools,
    resolve_responses_request_bridge_decisions,
};
use super::local_image::append_local_image_block_on_latest_user_input;
use super::metadata::{
    apply_bridge_ensure_system_instruction, apply_bridge_inject_system_instruction,
    apply_bridge_metadata_action,
};
use super::pipeline::run_bridge_action_pipeline;
use super::reasoning::{
    apply_bridge_reasoning_extract, apply_bridge_responses_output_reasoning,
    normalize_reasoning_in_anthropic_payload, normalize_reasoning_in_chat_payload,
    normalize_reasoning_in_gemini_payload, normalize_reasoning_in_responses_payload,
};
use super::tool_ids::{apply_bridge_normalize_tool_identifiers, normalize_bridge_tool_call_ids};
use super::types::*;
use super::utils::{coerce_bridge_role, serialize_tool_arguments};

pub fn convert_bridge_input_to_chat_messages_json(input_json: String) -> NapiResult<String> {
    let input: BridgeInputToChatInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = convert_bridge_input_to_chat_messages(input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn extract_reasoning_segments_json(input_json: String) -> NapiResult<String> {
    let input: ExtractReasoningSegmentsInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = extract_reasoning_segments_from_text(input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn map_reasoning_content_to_responses_output_json(input_json: String) -> NapiResult<String> {
    crate::hub_reasoning_tool_normalizer::map_reasoning_content_to_responses_output_json(input_json)
}

pub fn validate_tool_arguments_json(input_json: String) -> NapiResult<String> {
    let input: ValidateToolArgumentsInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = validate_tool_arguments(input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn repair_tool_calls_json(input_json: String) -> NapiResult<String> {
    let input: Vec<RepairToolCallInput> =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = repair_tool_calls(input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn coerce_bridge_role_json(input_json: String) -> NapiResult<String> {
    let value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let role = value
        .as_object()
        .and_then(|row| row.get("role"))
        .and_then(Value::as_str);
    let normalized = coerce_bridge_role(role);
    serde_json::to_string(&normalized).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn serialize_tool_output_json(input_json: String) -> NapiResult<String> {
    let value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output_value = value.as_object().and_then(|row| row.get("output")).cloned();
    let serialized = match output_value {
        Some(Value::String(text)) => Some(text),
        Some(Value::Object(_) | Value::Array(_) | Value::Number(_) | Value::Bool(_)) => {
            serde_json::to_string(&output_value.unwrap()).ok()
        }
        Some(Value::Null) | None => None,
    };
    serde_json::to_string(&serialized).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn serialize_tool_arguments_json(input_json: String) -> NapiResult<String> {
    let value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let args_value = value.as_object().and_then(|row| row.get("args")).cloned();
    let serialized = serialize_tool_arguments(args_value.as_ref());
    serde_json::to_string(&serialized).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn ensure_messages_array_json(input_json: String) -> NapiResult<String> {
    let value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let messages = value
        .as_object()
        .and_then(|row| row.get("state"))
        .and_then(Value::as_object)
        .and_then(|row| row.get("messages"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let output = serde_json::json!({ "messages": messages });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn normalize_reasoning_in_chat_payload_json(input_json: String) -> NapiResult<String> {
    let mut value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut fallback = Value::Null;
    let payload = value
        .as_object_mut()
        .and_then(|row| row.get_mut("payload"))
        .unwrap_or(&mut fallback);
    if !payload.is_null() {
        normalize_reasoning_in_chat_payload(payload);
    }
    let output = serde_json::json!({ "payload": payload });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn normalize_reasoning_in_openai_payload_json(input_json: String) -> NapiResult<String> {
    let mut value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut fallback = Value::Null;
    let payload = value
        .as_object_mut()
        .and_then(|row| row.get_mut("payload"))
        .unwrap_or(&mut fallback);
    if !payload.is_null() {
        normalize_reasoning_in_chat_payload(payload);
    }
    let output = serde_json::json!({ "payload": payload });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn normalize_reasoning_in_responses_payload_json(input_json: String) -> NapiResult<String> {
    let mut value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut fallback = Value::Null;
    let options = value
        .as_object()
        .and_then(|row| row.get("options").cloned())
        .unwrap_or(Value::Null);
    let payload = value
        .as_object_mut()
        .and_then(|row| row.get_mut("payload"))
        .unwrap_or(&mut fallback);
    if !payload.is_null() {
        normalize_reasoning_in_responses_payload(payload, &options);
    }
    let output = serde_json::json!({ "payload": payload });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn normalize_reasoning_in_gemini_payload_json(input_json: String) -> NapiResult<String> {
    let mut value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut fallback = Value::Null;
    let payload = value
        .as_object_mut()
        .and_then(|row| row.get_mut("payload"))
        .unwrap_or(&mut fallback);
    if !payload.is_null() {
        normalize_reasoning_in_gemini_payload(payload);
    }
    let output = serde_json::json!({ "payload": payload });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn normalize_reasoning_in_anthropic_payload_json(input_json: String) -> NapiResult<String> {
    let mut value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut fallback = Value::Null;
    let payload = value
        .as_object_mut()
        .and_then(|row| row.get_mut("payload"))
        .unwrap_or(&mut fallback);
    if !payload.is_null() {
        normalize_reasoning_in_anthropic_payload(payload);
    }
    let output = serde_json::json!({ "payload": payload });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn normalize_bridge_tool_call_ids_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: NormalizeBridgeToolCallIdsInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = normalize_bridge_tool_call_ids(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn apply_bridge_normalize_tool_identifiers_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ApplyBridgeNormalizeToolIdentifiersInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = apply_bridge_normalize_tool_identifiers(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn build_bridge_history_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: BuildBridgeHistoryInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = build_bridge_history(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn normalize_bridge_history_seed_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let value: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = normalize_bridge_history_seed(&value)
        .ok_or_else(|| napi::Error::from_reason("Invalid bridge history seed".to_string()))?;
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn resolve_responses_bridge_tools_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ResolveResponsesBridgeToolsInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = resolve_responses_bridge_tools(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn resolve_responses_request_bridge_decisions_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ResolveResponsesRequestBridgeDecisionsInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = resolve_responses_request_bridge_decisions(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn filter_bridge_input_for_upstream_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: FilterBridgeInputForUpstreamInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = filter_bridge_input_for_upstream(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn prepare_responses_request_envelope_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: PrepareResponsesRequestEnvelopeInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = prepare_responses_request_envelope(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn append_local_image_block_on_latest_user_input_json(
    input_json: String,
) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: AppendLocalImageBlockOnLatestUserInputInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = append_local_image_block_on_latest_user_input(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn apply_bridge_normalize_history_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ApplyBridgeNormalizeHistoryInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = apply_bridge_normalize_history(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn apply_bridge_capture_tool_results_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ApplyBridgeCaptureToolResultsInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = apply_bridge_capture_tool_results(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn apply_bridge_ensure_tool_placeholders_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ApplyBridgeEnsureToolPlaceholdersInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = apply_bridge_ensure_tool_placeholders(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn ensure_bridge_output_fields_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: EnsureBridgeOutputFieldsInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = ensure_bridge_output_fields(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn apply_bridge_metadata_action_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ApplyBridgeMetadataActionInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = apply_bridge_metadata_action(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn apply_bridge_inject_system_instruction_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ApplyBridgeInjectSystemInstructionInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = apply_bridge_inject_system_instruction(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn apply_bridge_ensure_system_instruction_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ApplyBridgeEnsureSystemInstructionInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = apply_bridge_ensure_system_instruction(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn apply_bridge_reasoning_extract_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ApplyBridgeReasoningExtractInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = apply_bridge_reasoning_extract(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn apply_bridge_responses_output_reasoning_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ApplyBridgeResponsesOutputReasoningInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = apply_bridge_responses_output_reasoning(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn run_bridge_action_pipeline_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: BridgeActionPipelineInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = run_bridge_action_pipeline(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}
