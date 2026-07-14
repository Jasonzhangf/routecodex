use serde_json::{Map, Value};
use std::mem;

use crate::shared_json_utils::read_object_trimmed_string;

use super::history::{
    apply_bridge_capture_tool_results_borrowed, apply_bridge_ensure_tool_placeholders_borrowed,
    apply_bridge_normalize_history, ensure_bridge_output_fields,
};
use super::metadata::{
    apply_bridge_ensure_system_instruction, apply_bridge_inject_system_instruction_borrowed,
    apply_bridge_metadata_action,
};
use super::reasoning::{
    apply_bridge_reasoning_extract, apply_bridge_responses_output_reasoning_borrowed,
};
use super::tool_ids::apply_bridge_normalize_tool_identifiers;
use super::types::*;

fn pick_option_bool(options: Option<&Map<String, Value>>, key: &str) -> Option<bool> {
    options
        .and_then(|row| row.get(key))
        .and_then(|value| value.as_bool())
}

fn derive_tool_id_prefix(
    options: Option<&Map<String, Value>>,
    request_id: &Option<String>,
    protocol: &Option<String>,
) -> String {
    if let Some(prefix) = options.and_then(|row| read_object_trimmed_string(row, "idPrefix")) {
        return prefix;
    }
    if let Some(req) = request_id
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        let safe: String = req.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        if !safe.is_empty() {
            let suffix: String = safe
                .chars()
                .rev()
                .take(24)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            return format!("{}_tool", suffix);
        }
    }
    let base = protocol.as_deref().unwrap_or("bridge");
    format!("{}_tool", base)
}

fn apply_metadata_bridge_history(state: &mut BridgeActionState, bridge_history: Value) {
    let mut metadata_obj = match state.metadata.take() {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    metadata_obj.insert("bridgeHistory".to_string(), bridge_history);
    state.metadata = Some(Value::Object(metadata_obj));
}

pub(crate) fn run_bridge_action_pipeline(
    input: BridgeActionPipelineInput,
) -> Result<BridgeActionState, String> {
    let BridgeActionPipelineInput {
        stage,
        actions,
        protocol,
        module_type,
        request_id,
        mut state,
    } = input;

    let action_list = actions.unwrap_or_default();
    if action_list.is_empty() {
        return Ok(state);
    }

    for descriptor in action_list {
        let name = descriptor.name.as_str();
        let options = &descriptor.options;
        let options_ref = options.as_ref();
        match name {
            "messages.inject-system-instruction" => {
                let output = apply_bridge_inject_system_instruction_borrowed(
                    stage.as_str(),
                    options_ref,
                    mem::take(&mut state.messages),
                    state.raw_request.as_ref(),
                );
                state.messages = output.messages;
            }
            "reasoning.extract" => {
                let drop_from_content =
                    pick_option_bool(options_ref, "dropFromContent").unwrap_or(true);
                let id_prefix_base = options_ref
                    .and_then(|row| read_object_trimmed_string(row, "idPrefix"))
                    .or_else(|| {
                        Some(format!(
                            "{}_{}",
                            protocol.clone().unwrap_or_else(|| "bridge".to_string()),
                            stage
                        ))
                    })
                    .filter(|value| !value.trim().is_empty());
                let output = apply_bridge_reasoning_extract(ApplyBridgeReasoningExtractInput {
                    messages: mem::take(&mut state.messages),
                    drop_from_content: Some(drop_from_content),
                    id_prefix_base,
                });
                state.messages = output.messages;
            }
            "tools.ensure-response-placeholders" | "tools.ensure-placeholders" => {
                let output = apply_bridge_ensure_tool_placeholders_borrowed(
                    stage.as_str(),
                    mem::take(&mut state.messages),
                    state.captured_tool_results.take(),
                    state.raw_request.as_ref(),
                    state.raw_response.as_ref(),
                );
                state.messages = output.messages;
                state.captured_tool_results = output.tool_outputs.or(output.retained_tool_outputs);
            }
            "messages.ensure-system-instruction" => {
                let output = apply_bridge_ensure_system_instruction(
                    ApplyBridgeEnsureSystemInstructionInput {
                        stage: stage.clone(),
                        messages: mem::take(&mut state.messages),
                        metadata: state.metadata.take(),
                    },
                );
                state.messages = output.messages;
                state.metadata = output.metadata;
            }
            "messages.normalize-history" => {
                if stage == "request_outbound" {
                    let output =
                        apply_bridge_normalize_history(ApplyBridgeNormalizeHistoryInput {
                            messages: mem::take(&mut state.messages),
                            tools: None,
                            allow_pending_terminal_tool_call: Some(true),
                        })?;
                    state.messages = output.messages;
                    if let Some(bridge_history) = output.bridge_history {
                        apply_metadata_bridge_history(&mut state, bridge_history);
                    }
                }
            }
            "messages.ensure-output-fields" => {
                if stage == "request_outbound" {
                    let tool_fallback = options_ref
                        .and_then(|row| read_object_trimmed_string(row, "toolFallback"))
                        .unwrap_or_default();
                    let assistant_fallback = options_ref
                        .and_then(|row| read_object_trimmed_string(row, "assistantFallback"))
                        .unwrap_or_default();
                    let output = ensure_bridge_output_fields(EnsureBridgeOutputFieldsInput {
                        messages: mem::take(&mut state.messages),
                        tool_fallback: Some(tool_fallback),
                        assistant_fallback: Some(assistant_fallback),
                    });
                    state.messages = output.messages;
                }
            }
            "tools.capture-results" => {
                let captured_tool_results_was_some = state.captured_tool_results.is_some();
                let metadata = state.metadata.take();
                let (metadata_for_action, metadata_fallback) = match metadata {
                    Some(Value::Object(map)) => (Some(Value::Object(map)), None),
                    other => (None, other),
                };
                let output = apply_bridge_capture_tool_results_borrowed(
                    stage.as_str(),
                    state.captured_tool_results.take(),
                    state.raw_request.as_ref(),
                    state.raw_response.as_ref(),
                    metadata_for_action,
                );
                state.captured_tool_results = output
                    .captured_tool_results
                    .or_else(|| captured_tool_results_was_some.then(Vec::new));
                state.metadata = output.metadata.or(metadata_fallback);
            }
            "reasoning.attach-output" | "responses.output-reasoning" => {
                if stage == "response_inbound" {
                    let id_prefix = format!(
                        "{}_{}_output",
                        protocol.clone().unwrap_or_else(|| "responses".to_string()),
                        stage
                    );
                    let output = apply_bridge_responses_output_reasoning_borrowed(
                        mem::take(&mut state.messages),
                        state.raw_response.as_ref(),
                        Some(id_prefix),
                    );
                    state.messages = output.messages;
                }
            }
            "tools.normalize-call-ids" => {
                let id_prefix = derive_tool_id_prefix(options_ref, &request_id, &protocol);
                let output = apply_bridge_normalize_tool_identifiers(
                    ApplyBridgeNormalizeToolIdentifiersInput {
                        stage: stage.clone(),
                        protocol: protocol.clone(),
                        module_type: module_type.clone(),
                        messages: mem::take(&mut state.messages),
                        raw_request: state.raw_request.take(),
                        captured_tool_results: state.captured_tool_results.take(),
                        id_prefix: Some(id_prefix),
                    },
                );
                state.messages = output.messages;
                state.raw_request = output.raw_request;
                state.captured_tool_results = output.captured_tool_results;
            }
            "metadata.extra-fields" | "metadata.provider-field" | "metadata.provider-sentinel" => {
                let output = apply_bridge_metadata_action(ApplyBridgeMetadataActionInput {
                    action_name: name.to_string(),
                    stage: stage.clone(),
                    options: options.clone().map(Value::Object),
                    raw_request: state.raw_request.take(),
                    raw_response: state.raw_response.take(),
                    metadata: state.metadata.take(),
                });
                state.raw_request = output.raw_request;
                state.raw_response = output.raw_response;
                state.metadata = output.metadata;
            }
            _ => {
                // Unknown action: skip (custom actions handled in TS).
            }
        }
    }

    Ok(state)
}
