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
    let output = convert_bridge_input_to_chat_messages(input).map_err(napi::Error::from_reason)?;
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

pub fn normalize_req_inbound_reasoning_payload_json(input_json: String) -> NapiResult<String> {
    let mut value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let protocol = value
        .as_object()
        .and_then(|row| row.get("protocol"))
        .and_then(Value::as_str)
        .unwrap_or("openai-chat")
        .trim()
        .to_ascii_lowercase();
    let mut fallback = Value::Null;
    let payload = value
        .as_object_mut()
        .and_then(|row| row.get_mut("payload"))
        .unwrap_or(&mut fallback);
    if !payload.is_null() {
        match protocol.as_str() {
            "openai-responses" => {
                let options = serde_json::json!({
                    "includeInput": true,
                    "includeInstructions": true
                });
                normalize_reasoning_in_responses_payload(payload, &options);
            }
            "anthropic-messages" => normalize_reasoning_in_anthropic_payload(payload),
            "gemini-chat" => normalize_reasoning_in_gemini_payload(payload),
            _ => normalize_reasoning_in_chat_payload(payload),
        }
    }
    serde_json::to_string(payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn value_contains_reasoning(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(s) => {
            let lower = s.to_lowercase();
            lower.contains("<think") || lower.contains("</think")
                || lower.contains("<reflection") || lower.contains("</reflection")
                || lower.contains("```think") || lower.contains("```reflection")
                || lower.contains("[思考]") || lower.contains("[/思考]")
        }
        serde_json::Value::Array(arr) => arr.iter().any(value_contains_reasoning),
        serde_json::Value::Object(obj) => {
            if let Some(text) = obj.get("text").and_then(serde_json::Value::as_str) {
                let lower = text.to_lowercase();
                if lower.contains("<think") || lower.contains("</think")
                    || lower.contains("<reflection") || lower.contains("</reflection")
                    || lower.contains("```think") || lower.contains("```reflection")
                    || lower.contains("[思考]") || lower.contains("[/思考]")
                {
                    return true;
                }
            }
            if let Some(content) = obj.get("content") {
                if content.is_array() && content.as_array().unwrap().iter().any(value_contains_reasoning) {
                    return true;
                }
            }
            obj.values().any(value_contains_reasoning)
        }
        _ => false,
    }
}

fn chat_payload_contains_reasoning(payload: &serde_json::Value) -> bool {
    payload.get("messages").map(value_contains_reasoning).unwrap_or(false)
        || payload.get("choices").map(value_contains_reasoning).unwrap_or(false)
}

fn responses_payload_contains_reasoning(payload: &serde_json::Value) -> bool {
    (payload.get("output").map(value_contains_reasoning).unwrap_or(false))
        || (payload.get("input").map(value_contains_reasoning).unwrap_or(false))
        || (payload.get("instructions").map(value_contains_reasoning).unwrap_or(false))
        || (payload.get("required_action").map(value_contains_reasoning).unwrap_or(false))
}

fn anthropic_payload_contains_reasoning(payload: &serde_json::Value) -> bool {
    payload.get("messages").map(value_contains_reasoning).unwrap_or(false)
        || payload.get("content").map(value_contains_reasoning).unwrap_or(false)
}

fn gemini_payload_contains_reasoning(payload: &serde_json::Value) -> bool {
    payload.get("contents").map(value_contains_reasoning).unwrap_or(false)
        || payload.get("candidates").map(value_contains_reasoning).unwrap_or(false)
}

pub fn should_normalize_reasoning_payload_json(input_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let payload = value.get("payload").unwrap_or(&serde_json::Value::Null);
    let protocol = value
        .get("protocol")
        .and_then(Value::as_str)
        .unwrap_or("openai-chat")
        .trim()
        .to_ascii_lowercase();
    let should = match protocol.as_str() {
        "openai-responses" => responses_payload_contains_reasoning(payload),
        "anthropic-messages" => anthropic_payload_contains_reasoning(payload),
        "gemini-chat" => gemini_payload_contains_reasoning(payload),
        _ => chat_payload_contains_reasoning(payload),
    };
    serde_json::to_string(&should).map_err(|e| napi::Error::from_reason(e.to_string()))
}


pub fn normalize_resp_inbound_reasoning_payload_json(input_json: String) -> NapiResult<String> {
    let mut value: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let protocol = value
        .as_object()
        .and_then(|row| row.get("protocol"))
        .and_then(Value::as_str)
        .unwrap_or("openai-chat")
        .trim()
        .to_ascii_lowercase();
    let mut fallback = Value::Null;
    let payload = value
        .as_object_mut()
        .and_then(|row| row.get_mut("payload"))
        .unwrap_or(&mut fallback);
    if !payload.is_null() {
        match protocol.as_str() {
            "openai-responses" => {
                let options = serde_json::json!({
                    "includeOutput": true,
                    "includeRequiredAction": true
                });
                normalize_reasoning_in_responses_payload(payload, &options);
            }
            "anthropic-messages" => normalize_reasoning_in_anthropic_payload(payload),
            "gemini-chat" => normalize_reasoning_in_gemini_payload(payload),
            _ => normalize_reasoning_in_chat_payload(payload),
        }
    }
    serde_json::to_string(payload).map_err(|e| napi::Error::from_reason(e.to_string()))
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
    let output = build_bridge_history(input).map_err(napi::Error::from_reason)?;
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
    let output = apply_bridge_normalize_history(input).map_err(napi::Error::from_reason)?;
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
    let output = run_bridge_action_pipeline(input).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}




pub fn strip_function_namespace_json(input_json: String) -> NapiResult<String> {
    let trimmed = input_json.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let lowered: String = trimmed.to_lowercase();
    if lowered.starts_with("functions.") {
        return Ok(trimmed["functions.".len()..].trim().to_string());
    }
    if lowered.starts_with("function.") {
        return Ok(trimmed["function.".len()..].trim().to_string());
    }
    Ok(trimmed.to_string())
}

pub fn to_canonical_tool_name_json(input_json: String) -> NapiResult<String> {
    // First strip namespace
    let stripped = {
        let trimmed = input_json.trim();
        if trimmed.is_empty() {
            String::new()
        } else {
            let lowered: String = trimmed.to_lowercase();
            if lowered.starts_with("functions.") {
                trimmed["functions.".len()..].trim().to_string()
            } else if lowered.starts_with("function.") {
                trimmed["function.".len()..].trim().to_string()
            } else {
                trimmed.to_string()
            }
        }
    };
    // Then normalize separators
    let result = stripped
        .to_lowercase()
        .chars()
        .map(|c| if c == ' ' || c == '_' || c == '-' { '.' } else { c })
        .collect::<String>();
    // Collapse multiple dots
    let mut collapsed = String::new();
    let mut prev_dot = false;
    for c in result.chars() {
        if c == '.' {
            if !prev_dot {
                collapsed.push('.');
                prev_dot = true;
            }
        } else {
            collapsed.push(c);
            prev_dot = false;
        }
    }
    // Trim leading/trailing dots
    let result = collapsed.trim_matches('.').to_string();
    Ok(result)
}

pub fn to_compact_tool_name_json(input_json: String) -> NapiResult<String> {
    // Reuse canonical logic then remove ._- separators
    let canonical = to_canonical_tool_name_json(input_json)?;
    let compact = canonical.replace(|c: char| c == '.' || c == '_' || c == '-', "");
    Ok(compact)
}

// Shell tool names - should match TS SHELL_TOOL_ALIASES
const SHELL_TOOL_ALIASES: &[&str] = &[
    "bash",
    "shell",
    "cmd",
    "cmd_exe",
    "shell_cmd",
    "bash_cmd",
    "exec",
    "run",
    "command",
    "system",
    "run_command",
    "execute",
    "exec_command",
    "bash_command",
    "shell_command",
    "run_shell",
    "bash_shell",
    "system_command",
    "shell_exec",
    "run_cmd",
    "bash_exec",
];

fn is_shell_tool_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    SHELL_TOOL_ALIASES.contains(&lower.as_str())
}

pub fn resolve_tool_family_json(input_json: String) -> NapiResult<String> {
    let canonical = to_canonical_tool_name_json(input_json)?;
    if canonical.is_empty() {
        return Ok(String::new());
    }

    let shell_candidate = canonical.replace('.', "_");
    if is_shell_tool_name(&canonical) || is_shell_tool_name(&shell_candidate) || canonical == "terminal" {
        return Ok("shell_like".to_string());
    }

    if canonical == "apply.patch" || canonical == "apply_patch" {
        return Ok("apply_patch".to_string());
    }

    if canonical == "write.stdin" || canonical == "write_stdin" {
        return Ok("write_stdin".to_string());
    }

    Ok(canonical)
}

fn namespace_joiner(namespace: &str) -> &'static str {
    let trimmed = namespace.trim();
    if trimmed.ends_with("__") || trimmed.ends_with('_') || trimmed.ends_with('.') || trimmed.ends_with('/') || trimmed.ends_with('-') {
        ""
    } else {
        "__"
    }
}

pub fn build_namespace_alias_json(namespace_json: String, raw_name_json: String) -> NapiResult<String> {
    let ns = namespace_json.trim();
    let name = raw_name_json.trim();
    if ns.is_empty() || name.is_empty() {
        return Ok(String::new());
    }
    let result = format!("{}{}{}", ns, namespace_joiner(ns), name);
    Ok(result)
}

pub fn build_namespace_lookup_key_json(namespace_json: String, raw_name_json: String) -> NapiResult<String> {
    let ns = namespace_json.trim().to_lowercase();
    let name = raw_name_json.trim().to_lowercase();
    if ns.is_empty() || name.is_empty() {
        return Ok(String::new());
    }
    let result = format!("{}::{}", ns, name);
    Ok(result)
}

fn extract_function_parameters(obj: &serde_json::Value) -> Option<serde_json::Value> {
    // Look for function.parameters or direct parameters
    if let Some(function_obj) = obj.get("function") {
        if let Some(params) = function_obj.get("parameters") {
            return Some(params.clone());
        }
    }
    if let Some(params) = obj.get("parameters") {
        return Some(params.clone());
    }
    None
}

pub fn read_schema_json(input_json: String) -> NapiResult<String> {
    let input: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid input JSON: {}", e)))?;

    let result = extract_function_parameters(&input);
    match result {
        Some(val) => serde_json::to_string(&val).map_err(|e| napi::Error::from_reason(e.to_string())),
        None => Ok("null".to_string()),
    }
}

pub fn should_log_client_remap_debug_json(input_json: String) -> NapiResult<String> {
    let input: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid input JSON: {}", e)))?;

    // Check __rcc_tool_governance.textHarvestApplied === true
    let result = input
        .get("__rcc_tool_governance")
        .and_then(|gov| gov.get("textHarvestApplied"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    serde_json::to_string(&result).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn extract_declared_tool_names_json(input_json: String) -> NapiResult<String> {
    let input: Vec<serde_json::Value> = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid input JSON: {}", e)))?;

    let names: Vec<String> = input
        .iter()
        .filter_map(|tool| {
            // Try function.name first
            let fn_name = tool
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            if fn_name.is_some() {
                return fn_name;
            }

            // Fall back to top-level name
            tool.get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .collect();

    serde_json::to_string(&names).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn assert_no_unknown_tool_names_json(input_json: String) -> NapiResult<String> {
    #[derive(serde::Deserialize)]
    struct Input {
        request_id: String,
        client_protocol: String,
        unknown_names: Vec<String>,
        client_tools_raw: Option<Vec<serde_json::Value>>,
    }

    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid input JSON: {}", e)))?;

    let unique_unknown: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        let mut result = Vec::new();
        for name in &input.unknown_names {
            let trimmed = name.trim();
            if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
                result.push(trimmed.to_string());
            }
        }
        result
    };

    if unique_unknown.is_empty() {
        return Ok("null".to_string());
    }

    // Extract declared tool names
    let declared_names: Vec<String> = input.client_tools_raw
        .unwrap_or_default()
        .iter()
        .filter_map(|tool| {
            let fn_name = tool
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            if fn_name.is_some() {
                return fn_name;
            }
            tool.get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .collect();

    let declared_preview: Vec<String> = declared_names.iter().take(20).cloned().collect();

    // Build error JSON
    #[derive(serde::Serialize)]
    struct ErrorDetails {
        code: String,
        status_code: u16,
        retryable: bool,
        message: String,
        details: ErrorInfo,
    }

    #[derive(serde::Serialize)]
    struct ErrorInfo {
        unknown_tool_names: Vec<String>,
        declared_tool_names: Vec<String>,
        protocol: String,
        request_id: String,
    }

    let error = ErrorDetails {
        code: "CLIENT_TOOL_NAME_MISMATCH".to_string(),
        status_code: 502,
        retryable: true,
        message: format!(
            "[client-remap] tool name mismatch after remap: unknown=[{}] protocol={} requestId={}{}",
            unique_unknown.join(", "),
            input.client_protocol,
            input.request_id,
            if declared_preview.is_empty() {
                " declared=[none]".to_string()
            } else {
                format!(" declared=[{}]", declared_preview.join(", "))
            }
        ),
        details: ErrorInfo {
            unknown_tool_names: unique_unknown,
            declared_tool_names: declared_names,
            protocol: input.client_protocol,
            request_id: input.request_id,
        },
    };

    serde_json::to_string(&error).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn extract_client_tool_index_json(input_json: String) -> NapiResult<String> {
    #[derive(serde::Deserialize)]
    struct Input {
        client_tools_raw: Option<Vec<serde_json::Value>>,
    }

    #[derive(serde::Serialize)]
    struct Output {
        by_exact_lower: std::collections::HashMap<String, serde_json::Value>,
        by_stripped_lower: std::collections::HashMap<String, serde_json::Value>,
        by_canonical_lower: std::collections::HashMap<String, serde_json::Value>,
        by_compact_lower: std::collections::HashMap<String, serde_json::Value>,
        by_family: std::collections::HashMap<String, serde_json::Value>,
        by_namespace_name: std::collections::HashMap<String, serde_json::Value>,
    }

    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid input JSON: {}", e)))?;

    let tools = input.client_tools_raw.unwrap_or_default();

    let mut by_exact_lower = std::collections::HashMap::new();
    let mut by_stripped_lower = std::collections::HashMap::new();
    let mut by_canonical_lower = std::collections::HashMap::new();
    let mut by_compact_lower = std::collections::HashMap::new();
    let mut by_family = std::collections::HashMap::new();
    let mut by_namespace_name = std::collections::HashMap::new();

    for tool in tools {
        let row = match tool.as_object() {
            Some(r) => r,
            None => continue,
        };

        let tool_type = row
            .get("type")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "function".to_string());

        if tool_type == "namespace" {
            let namespace = match row.get("name").and_then(|v| v.as_str()).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
                Some(ns) => ns,
                None => continue,
            };

            let children = match row.get("tools").and_then(|v| v.as_array()) {
                Some(c) => c,
                None => continue,
            };

            for child in children {
                let child_row = match child.as_object() {
                    Some(r) => r,
                    None => continue,
                };

                let raw_child_name = child_row
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .or_else(|| {
                        child.as_object()
                            .and_then(|r| r.get("function"))
                            .and_then(|f| f.as_object())
                            .and_then(|fo| fo.get("name"))
                            .and_then(|n| n.as_str())
                            .map(|v| v.trim().to_string())
                    });

                let child_name = match raw_child_name {
                    Some(name) => name,
                    None => continue,
                };

                let entry = serde_json::json!({
                    "declaredName": child_name,
                    "namespace": namespace,
                    "tool": child,
                });

                // Register with namespace key
                let ns_key = format!("{}::{}", namespace.to_lowercase(), child_name.to_lowercase());
                if !by_namespace_name.contains_key(&ns_key) {
                    by_namespace_name.insert(ns_key, entry.clone());
                }

                // Use helper functions
                let stripped = strip_function_namespace_impl(&child_name);
                let canonical = to_canonical_tool_name_impl(&stripped);
                let compact = canonical.replace(|c: char| c == '.' || c == '_' || c == '-', "");
                let family = resolve_tool_family_impl(&canonical);

                let exact_key = child_name.to_lowercase();
                if !by_exact_lower.contains_key(&exact_key) {
                    by_exact_lower.insert(exact_key, entry.clone());
                }

                if !stripped.is_empty() && !by_stripped_lower.contains_key(&stripped) {
                    by_stripped_lower.insert(stripped, entry.clone());
                }

                if !canonical.is_empty() && !by_canonical_lower.contains_key(&canonical) {
                    by_canonical_lower.insert(canonical, entry.clone());
                }

                if !compact.is_empty() && !by_compact_lower.contains_key(&compact) {
                    by_compact_lower.insert(compact, entry.clone());
                }

                if !family.is_empty() && !by_family.contains_key(&family) {
                    by_family.insert(family, entry);
                }
            }
            continue;
        }

        // Regular function tool
        let raw_name = row
            .get("function")
            .and_then(|f| f.as_object())
            .and_then(|fo| fo.get("name"))
            .and_then(|n| n.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .or_else(|| {
                row.get("name")
                    .and_then(|n| n.as_str())
                    .map(|v| v.trim().to_string())
            });

        let normalized_name = match raw_name {
            Some(name) => name,
            None => continue,
        };

        let entry = serde_json::json!({
            "declaredName": normalized_name,
            "tool": &tool,
        });

        let stripped = strip_function_namespace_impl(&normalized_name);
        let canonical = to_canonical_tool_name_impl(&stripped);
        let compact = canonical.replace(|c: char| c == '.' || c == '_' || c == '-', "");
        let family = resolve_tool_family_impl(&canonical);

        let exact_key = normalized_name.to_lowercase();
        if !by_exact_lower.contains_key(&exact_key) {
            by_exact_lower.insert(exact_key, entry.clone());
        }

        if !stripped.is_empty() && !by_stripped_lower.contains_key(&stripped) {
            by_stripped_lower.insert(stripped, entry.clone());
        }

        if !canonical.is_empty() && !by_canonical_lower.contains_key(&canonical) {
            by_canonical_lower.insert(canonical, entry.clone());
        }

        if !compact.is_empty() && !by_compact_lower.contains_key(&compact) {
            by_compact_lower.insert(compact, entry.clone());
        }

        if !family.is_empty() && !by_family.contains_key(&family) {
            by_family.insert(family, entry);
        }
    }

    let output = Output {
        by_exact_lower,
        by_stripped_lower,
        by_canonical_lower,
        by_compact_lower,
        by_family,
        by_namespace_name,
    };

    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

// Helper implementations (reused from other functions)
fn strip_function_namespace_impl(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lowered = trimmed.to_lowercase();
    if lowered.starts_with("functions.") {
        trimmed["functions.".len()..].trim().to_string()
    } else if lowered.starts_with("function.") {
        trimmed["function.".len()..].trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn to_canonical_tool_name_impl(input: &str) -> String {
    let stripped = strip_function_namespace_impl(input);
    let result: String = stripped
        .to_lowercase()
        .chars()
        .map(|c| if c == ' ' || c == '_' || c == '-' { '.' } else { c })
        .collect();
    let mut collapsed = String::new();
    let mut prev_dot = false;
    for c in result.chars() {
        if c == '.' {
            if !prev_dot {
                collapsed.push('.');
                prev_dot = true;
            }
        } else {
            collapsed.push(c);
            prev_dot = false;
        }
    }
    collapsed.trim_matches('.').to_string()
}

fn resolve_tool_family_impl(canonical: &str) -> String {
    if canonical.is_empty() {
        return String::new();
    }

    let shell_candidate = canonical.replace('.', "_");
    let shell_aliases = [
        "bash", "shell", "cmd", "cmd_exe", "shell_cmd", "bash_cmd", "exec", "run",
        "command", "system", "run_command", "execute", "exec_command", "bash_command",
        "shell_command", "run_shell", "bash_shell", "system_command", "shell_exec",
        "run_cmd", "bash_exec",
    ];

    if shell_aliases.contains(&canonical) || shell_aliases.contains(&shell_candidate.as_str()) || canonical == "terminal" {
        return "shell_like".to_string();
    }

    if canonical == "apply.patch" || canonical == "apply_patch" {
        return "apply_patch".to_string();
    }

    if canonical == "write.stdin" || canonical == "write_stdin" {
        return "write_stdin".to_string();
    }

    canonical.to_string()
}

pub fn resolve_client_tool_from_index_json(input_json: String) -> NapiResult<String> {
    #[derive(serde::Deserialize)]
    struct LookupInput {
        by_exact_lower: std::collections::HashMap<String, serde_json::Value>,
        by_stripped_lower: std::collections::HashMap<String, serde_json::Value>,
        by_canonical_lower: std::collections::HashMap<String, serde_json::Value>,
        by_compact_lower: std::collections::HashMap<String, serde_json::Value>,
        by_family: std::collections::HashMap<String, serde_json::Value>,
        by_namespace_name: std::collections::HashMap<String, serde_json::Value>,
    }

    #[derive(serde::Deserialize)]
    struct Input {
        index: LookupInput,
        raw_name: String,
        namespace: Option<String>,
    }

    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid input JSON: {}", e)))?;

    let trimmed = input.raw_name.trim();
    if trimmed.is_empty() {
        return Ok("null".to_string());
    }

    // First try namespace lookup
    if let Some(ns) = &input.namespace {
        let ns_key = format!("{}::{}", ns.to_lowercase(), trimmed.to_lowercase());
        if let Some(result) = input.index.by_namespace_name.get(&ns_key) {
            return serde_json::to_string(result).map_err(|e| napi::Error::from_reason(e.to_string()));
        }
    }

    // Then try various normalizations
    let exact_lower = trimmed.to_lowercase();
    let stripped_lower = strip_function_namespace_impl(trimmed);
    let canonical = to_canonical_tool_name_impl(&stripped_lower);
    let compact = canonical.replace(|c: char| c == '.' || c == '_' || c == '-', "");
    let family = resolve_tool_family_impl(&canonical);

    // Try in order
    if let Some(result) = input.index.by_exact_lower.get(&exact_lower) {
        return serde_json::to_string(result).map_err(|e| napi::Error::from_reason(e.to_string()));
    }

    let stripped_lower_key = stripped_lower.to_lowercase();
    if let Some(result) = input.index.by_exact_lower.get(&stripped_lower_key) {
        return serde_json::to_string(result).map_err(|e| napi::Error::from_reason(e.to_string()));
    }

    if let Some(result) = input.index.by_stripped_lower.get(&stripped_lower_key) {
        return serde_json::to_string(result).map_err(|e| napi::Error::from_reason(e.to_string()));
    }

    if !canonical.is_empty() {
        if let Some(result) = input.index.by_canonical_lower.get(&canonical) {
            return serde_json::to_string(result).map_err(|e| napi::Error::from_reason(e.to_string()));
        }
        if let Some(result) = input.index.by_stripped_lower.get(&canonical) {
            return serde_json::to_string(result).map_err(|e| napi::Error::from_reason(e.to_string()));
        }
    }

    if !compact.is_empty() {
        if let Some(result) = input.index.by_compact_lower.get(&compact) {
            return serde_json::to_string(result).map_err(|e| napi::Error::from_reason(e.to_string()));
        }
    }

    if !family.is_empty() {
        if let Some(result) = input.index.by_family.get(&family) {
            return serde_json::to_string(result).map_err(|e| napi::Error::from_reason(e.to_string()));
        }
    }

    Ok("null".to_string())
}

pub fn remap_chat_tool_calls_json(input_json: String) -> NapiResult<String> {
    #[derive(serde::Deserialize)]
    struct Input {
        payload: serde_json::Value,
        client_tools_raw: Option<Vec<serde_json::Value>>,
    }

    #[derive(serde::Serialize)]
    struct Output {
        payload: serde_json::Value,
        unknown_names: Vec<String>,
    }

    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid input JSON: {}", e)))?;

    // Build index using existing function
    let tools_raw_json = serde_json::to_string(&serde_json::json!({
        "client_tools_raw": input.client_tools_raw
    })).map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let index_json = extract_client_tool_index_json(tools_raw_json)?;
    #[derive(serde::Deserialize)]
    struct IndexOutput {
        by_exact_lower: std::collections::HashMap<String, serde_json::Value>,
        by_stripped_lower: std::collections::HashMap<String, serde_json::Value>,
        by_canonical_lower: std::collections::HashMap<String, serde_json::Value>,
        by_compact_lower: std::collections::HashMap<String, serde_json::Value>,
        by_family: std::collections::HashMap<String, serde_json::Value>,
        by_namespace_name: std::collections::HashMap<String, serde_json::Value>,
    }
    let index: IndexOutput = serde_json::from_str(&index_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid index JSON: {}", e)))?;

    let mut payload = input.payload;
    let mut unknown_names: Vec<String> = Vec::new();
    let mut seen_unknown = std::collections::HashSet::new();

    // Helper to lookup tool
    let lookup = |name: &str, namespace: Option<&str>| -> Option<serde_json::Value> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return None;
        }

        // Namespace lookup
        if let Some(ns) = namespace {
            let ns_key = format!("{}::{}", ns.to_lowercase(), trimmed.to_lowercase());
            if let Some(result) = index.by_namespace_name.get(&ns_key) {
                return Some(result.clone());
            }
        }

        let exact_lower = trimmed.to_lowercase();
        let stripped_lower = strip_function_namespace_impl(trimmed);
        let canonical = to_canonical_tool_name_impl(&stripped_lower);
        let compact = canonical.replace(|c: char| c == '.' || c == '_' || c == '-', "");

        // Try exact
        if let Some(result) = index.by_exact_lower.get(&exact_lower) {
            return Some(result.clone());
        }

        // Try stripped exact
        let stripped_key = stripped_lower.to_lowercase();
        if let Some(result) = index.by_exact_lower.get(&stripped_key) {
            return Some(result.clone());
        }

        if let Some(result) = index.by_stripped_lower.get(&stripped_key) {
            return Some(result.clone());
        }

        if !canonical.is_empty() {
            if let Some(result) = index.by_canonical_lower.get(&canonical) {
                return Some(result.clone());
            }
            if let Some(result) = index.by_stripped_lower.get(&canonical) {
                return Some(result.clone());
            }
        }

        if !compact.is_empty() {
            if let Some(result) = index.by_compact_lower.get(&compact) {
                return Some(result.clone());
            }
        }

        None
    };

    // Iterate choices
    if let Some(choices) = payload.get_mut("choices").and_then(|c| c.as_array_mut()) {
        for choice in choices {
            if let Some(message) = choice.get_mut("message").and_then(|m| m.as_object_mut()) {
                if let Some(tool_calls) = message.get_mut("tool_calls").and_then(|tc| tc.as_array_mut()) {
                    for tool_call in tool_calls {
                        if let Some(tc_obj) = tool_call.as_object_mut() {
                            let function = tc_obj.get_mut("function").and_then(|f| f.as_object_mut());
                            let current_name = function
                                .and_then(|f| f.get("name"))
                                .and_then(|n| n.as_str())
                                .map(|s| s.trim().to_string());

                            let current_name = match current_name {
                                Some(n) => n,
                                None => continue,
                            };

                            let namespace = tc_obj.get("namespace").and_then(|n| n.as_str());

                            if let Some(matched) = lookup(&current_name, namespace) {
                                // Update function.name
                                if let Some(function) = tc_obj.get_mut("function").and_then(|f| f.as_object_mut()) {
                                    if let Some(declared) = matched.get("declaredName").and_then(|d| d.as_str()) {
                                        function.insert("name".to_string(), serde_json::Value::String(declared.to_string()));
                                    }
                                }
                            } else {
                                // Unknown name
                                let key = current_name.trim().to_string();
                                if !key.is_empty() && seen_unknown.insert(key.clone()) {
                                    unknown_names.push(key);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let output = Output {
        payload,
        unknown_names,
    };

    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn remap_responses_tool_calls_json(input_json: String) -> NapiResult<String> {
    #[derive(serde::Deserialize)]
    struct Input {
        payload: serde_json::Value,
        client_tools_raw: Option<Vec<serde_json::Value>>,
    }

    #[derive(serde::Serialize)]
    struct Output {
        payload: serde_json::Value,
        unknown_names: Vec<String>,
    }

    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid input JSON: {}", e)))?;

    // Build index
    let tools_raw_json = serde_json::to_string(&serde_json::json!({
        "client_tools_raw": input.client_tools_raw
    })).map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let index_json = extract_client_tool_index_json(tools_raw_json)?;
    #[derive(serde::Deserialize)]
    struct IndexOutput {
        by_exact_lower: std::collections::HashMap<String, serde_json::Value>,
        by_stripped_lower: std::collections::HashMap<String, serde_json::Value>,
        by_canonical_lower: std::collections::HashMap<String, serde_json::Value>,
        by_compact_lower: std::collections::HashMap<String, serde_json::Value>,
        by_family: std::collections::HashMap<String, serde_json::Value>,
        by_namespace_name: std::collections::HashMap<String, serde_json::Value>,
    }
    let index: IndexOutput = serde_json::from_str(&index_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid index JSON: {}", e)))?;

    let mut payload = input.payload;
    let mut unknown_names: Vec<String> = Vec::new();
    let mut seen_unknown = std::collections::HashSet::new();

    // Lookup helper
    let lookup = |name: &str, namespace: Option<&str>| -> Option<serde_json::Value> {
        let trimmed = name.trim();
        if trimmed.is_empty() { return None; }

        if let Some(ns) = namespace {
            let ns_key = format!("{}::{}", ns.to_lowercase(), trimmed.to_lowercase());
            if let Some(result) = index.by_namespace_name.get(&ns_key) {
                return Some(result.clone());
            }
        }

        let exact_lower = trimmed.to_lowercase();
        let stripped_lower = strip_function_namespace_impl(trimmed);
        let canonical = to_canonical_tool_name_impl(&stripped_lower);

        if let Some(result) = index.by_exact_lower.get(&exact_lower) {
            return Some(result.clone());
        }
        if let Some(result) = index.by_stripped_lower.get(&stripped_lower.to_lowercase()) {
            return Some(result.clone());
        }
        if !canonical.is_empty() {
            if let Some(result) = index.by_canonical_lower.get(&canonical) {
                return Some(result.clone());
            }
        }
        None
    };

    let update_tool_name = |obj: &mut serde_json::Map<String, serde_json::Value>, name: &str, matched: &serde_json::Value| {
        if let Some(declared) = matched.get("declaredName").and_then(|d| d.as_str()) {
            obj.insert("name".to_string(), serde_json::Value::String(declared.to_string()));
            if let Some(ns) = matched.get("namespace").and_then(|n| n.as_str()) {
                obj.insert("namespace".to_string(), serde_json::Value::String(ns.to_string()));
            }
            if let Some(function) = obj.get_mut("function").and_then(|f| f.as_object_mut()) {
                function.insert("name".to_string(), serde_json::Value::String(declared.to_string()));
            }
        }
    };

    // Process required_action calls
    if let Some(required_action) = payload.get_mut("required_action").and_then(|a| a.as_object_mut()) {
        if let Some(submit_tool_outputs) = required_action.get_mut("submit_tool_outputs")
            .and_then(|o| o.as_object_mut()) {
            if let Some(tool_calls) = submit_tool_outputs.get_mut("tool_calls")
                .and_then(|tc| tc.as_array_mut()) {
                for call in tool_calls {
                    if let Some(call_obj) = call.as_object_mut() {
                        let name = call_obj.get("name").and_then(|n| n.as_str()).map(|s| s.trim().to_string());
                        let name = match name { Some(n) => n, None => continue };

                        let namespace = call_obj.get("namespace").and_then(|n| n.as_str());

                        if let Some(matched) = lookup(&name, namespace) {
                            update_tool_name(call_obj, &name, &matched);
                        } else {
                            if !name.is_empty() && seen_unknown.insert(name.clone()) {
                                unknown_names.push(name);
                            }
                        }
                    }
                }
            }
        }
    }

    // Process output items
    if let Some(output) = payload.get_mut("output").and_then(|o| o.as_array_mut()) {
        for item in output {
            if let Some(item_obj) = item.as_object_mut() {
                let type_str = item_obj.get("type").and_then(|t| t.as_str()).map(|s| s.trim().to_lowercase());
                if type_str.as_deref() != Some("function_call") {
                    continue;
                }

                let name = item_obj.get("name").and_then(|n| n.as_str()).map(|s| s.trim().to_string());
                let name = match name { Some(n) => n, None => continue };

                let namespace = item_obj.get("namespace").and_then(|n| n.as_str());

                if let Some(matched) = lookup(&name, namespace) {
                    update_tool_name(item_obj, &name, &matched);
                } else {
                    if !name.is_empty() && seen_unknown.insert(name.clone()) {
                        unknown_names.push(name);
                    }
                }
            }
        }
    }

    let output = Output { payload, unknown_names };
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn as_record_json(input_json: String) -> NapiResult<String> {
    let input: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid input JSON: {}", e)))?;

    let result = if input.is_object() && !input.is_array() {
        input
    } else {
        serde_json::Value::Null
    };

    serde_json::to_string(&result).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn build_slim_responses_context_json(input_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let src = match value.as_object() {
        Some(obj) => obj,
        None => return serde_json::to_string(&serde_json::Value::Null).map_err(|e| napi::Error::from_reason(e.to_string())),
    };
    let mut result = serde_json::Map::with_capacity(src.len().saturating_sub(2));
    for (k, v) in src {
        if k == "input" || k == "__captured_tool_results" {
            continue;
        }
        result.insert(k.clone(), v.clone());
    }
    serde_json::to_string(&Value::Object(result)).map_err(|e| napi::Error::from_reason(e.to_string()))
}
