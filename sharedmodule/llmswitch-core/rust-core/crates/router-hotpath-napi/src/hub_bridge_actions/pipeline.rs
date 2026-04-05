use serde_json::{Map, Value};
use std::mem;

use super::history::{
    apply_bridge_capture_tool_results, apply_bridge_ensure_tool_placeholders,
    apply_bridge_normalize_history, ensure_bridge_output_fields,
};
use super::metadata::{
    apply_bridge_ensure_system_instruction, apply_bridge_inject_system_instruction,
    apply_bridge_metadata_action,
};
use super::reasoning::{apply_bridge_reasoning_extract, apply_bridge_responses_output_reasoning};
use super::tool_ids::apply_bridge_normalize_tool_identifiers;
use super::types::*;

fn pick_option_str(options: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    options
        .and_then(|row| row.get(key))
        .and_then(|value| value.as_str())
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

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
    if let Some(prefix) = pick_option_str(options, "idPrefix") {
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

pub(crate) fn run_bridge_action_pipeline(input: BridgeActionPipelineInput) -> BridgeActionState {
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
        return state;
    }

    for descriptor in action_list {
        let name = descriptor.name.as_str();
        let options = &descriptor.options;
        let options_ref = options.as_ref();
        match name {
            "messages.inject-system-instruction" => {
                let output = apply_bridge_inject_system_instruction(
                    ApplyBridgeInjectSystemInstructionInput {
                        stage: stage.clone(),
                        options: options.clone().map(Value::Object),
                        messages: mem::take(&mut state.messages),
                        raw_request: state.raw_request.clone(),
                    },
                );
                state.messages = output.messages;
            }
            "reasoning.extract" => {
                let drop_from_content =
                    pick_option_bool(options_ref, "dropFromContent").unwrap_or(true);
                let id_prefix_base = pick_option_str(options_ref, "idPrefix")
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
                let output =
                    apply_bridge_ensure_tool_placeholders(ApplyBridgeEnsureToolPlaceholdersInput {
                        stage: stage.clone(),
                        messages: mem::take(&mut state.messages),
                        captured_tool_results: state.captured_tool_results.clone(),
                        raw_request: state.raw_request.clone(),
                        raw_response: state.raw_response.clone(),
                    });
                state.messages = output.messages;
                if let Some(tool_outputs) = output.tool_outputs {
                    state.captured_tool_results = Some(tool_outputs);
                }
            }
            "messages.ensure-system-instruction" => {
                let output = apply_bridge_ensure_system_instruction(
                    ApplyBridgeEnsureSystemInstructionInput {
                        stage: stage.clone(),
                        messages: mem::take(&mut state.messages),
                        metadata: state.metadata.clone(),
                    },
                );
                state.messages = output.messages;
                if let Some(metadata) = output.metadata {
                    state.metadata = Some(metadata);
                }
            }
            "messages.normalize-history" => {
                if stage == "request_outbound" {
                    let tools = state
                        .raw_request
                        .as_ref()
                        .and_then(|value| value.get("tools"))
                        .and_then(|value| value.as_array())
                        .map(|items| items.clone());
                    let output = apply_bridge_normalize_history(ApplyBridgeNormalizeHistoryInput {
                        messages: mem::take(&mut state.messages),
                        tools,
                    });
                    state.messages = output.messages;
                    if let Some(bridge_history) = output.bridge_history {
                        apply_metadata_bridge_history(&mut state, bridge_history);
                    }
                }
            }
            "messages.ensure-output-fields" => {
                if stage == "request_outbound" {
                    let tool_fallback = pick_option_str(options_ref, "toolFallback")
                        .unwrap_or_else(|| "Tool call completed (no output).".to_string());
                    let assistant_fallback = pick_option_str(options_ref, "assistantFallback")
                        .unwrap_or_else(|| "Assistant response unavailable.".to_string());
                    let output = ensure_bridge_output_fields(EnsureBridgeOutputFieldsInput {
                        messages: mem::take(&mut state.messages),
                        tool_fallback: Some(tool_fallback),
                        assistant_fallback: Some(assistant_fallback),
                    });
                    state.messages = output.messages;
                }
            }
            "tools.capture-results" => {
                let output =
                    apply_bridge_capture_tool_results(ApplyBridgeCaptureToolResultsInput {
                        stage: stage.clone(),
                        captured_tool_results: state.captured_tool_results.clone(),
                        raw_request: state.raw_request.clone(),
                        raw_response: state.raw_response.clone(),
                        metadata: state.metadata.clone(),
                    });
                if let Some(results) = output.captured_tool_results {
                    state.captured_tool_results = Some(results);
                }
                if let Some(metadata) = output.metadata {
                    state.metadata = Some(metadata);
                }
            }
            "reasoning.attach-output" | "responses.output-reasoning" => {
                if stage == "response_inbound" {
                    let id_prefix = format!(
                        "{}_{}_output",
                        protocol.clone().unwrap_or_else(|| "responses".to_string()),
                        stage
                    );
                    let output = apply_bridge_responses_output_reasoning(
                        ApplyBridgeResponsesOutputReasoningInput {
                            messages: mem::take(&mut state.messages),
                            raw_response: state.raw_response.clone(),
                            id_prefix: Some(id_prefix),
                        },
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
                        raw_request: state.raw_request.clone(),
                        captured_tool_results: state.captured_tool_results.clone(),
                        id_prefix: Some(id_prefix),
                    },
                );
                state.messages = output.messages;
                if let Some(raw_request) = output.raw_request {
                    state.raw_request = Some(raw_request);
                }
                if let Some(captured) = output.captured_tool_results {
                    state.captured_tool_results = Some(captured);
                }
            }
            "metadata.extra-fields" | "metadata.provider-field" | "metadata.provider-sentinel" => {
                let output = apply_bridge_metadata_action(ApplyBridgeMetadataActionInput {
                    action_name: name.to_string(),
                    stage: stage.clone(),
                    options: options.clone().map(Value::Object),
                    raw_request: state.raw_request.clone(),
                    raw_response: state.raw_response.clone(),
                    metadata: state.metadata.clone(),
                });
                if let Some(raw_request) = output.raw_request {
                    state.raw_request = Some(raw_request);
                }
                if let Some(raw_response) = output.raw_response {
                    state.raw_response = Some(raw_response);
                }
                if let Some(metadata) = output.metadata {
                    state.metadata = Some(metadata);
                }
            }
            _ => {
                // Unknown action: skip (custom actions handled in TS).
            }
        }
    }

    state
}
