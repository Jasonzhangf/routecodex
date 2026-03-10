use serde_json::{Map, Value};
use std::collections::HashSet;

use super::reasoning::extract_reasoning_segments;
use super::types::{
    ApplyBridgeEnsureSystemInstructionInput, ApplyBridgeEnsureSystemInstructionOutput,
    ApplyBridgeInjectSystemInstructionInput, ApplyBridgeInjectSystemInstructionOutput,
    ApplyBridgeMetadataActionInput, ApplyBridgeMetadataActionOutput,
};
use super::utils::{ensure_object_value, flatten_content_to_string, read_option_string};

fn read_instruction_value(source: &Map<String, Value>, field: &str) -> Option<String> {
    let raw = source.get(field).and_then(Value::as_str)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn read_instruction_reasoning(source: &Map<String, Value>, field: Option<&str>) -> Vec<String> {
    let Some(reasoning_field) = field else {
        return Vec::new();
    };
    let Some(raw) = source.get(reasoning_field) else {
        return Vec::new();
    };
    match raw {
        Value::String(text) => {
            let trimmed = text.trim().to_string();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed]
            }
        }
        Value::Array(entries) => entries
            .iter()
            .filter_map(Value::as_str)
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn build_instruction_message(text: &str, reasoning_segments: &[String]) -> Option<Value> {
    let mut extracted_reasoning: Vec<String> = Vec::new();
    let content = extract_reasoning_segments(text, Some(&mut extracted_reasoning));
    let mut merged: Vec<String> = extracted_reasoning
        .into_iter()
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect();
    for segment in reasoning_segments {
        let trimmed = segment.trim().to_string();
        if !trimmed.is_empty() {
            merged.push(trimmed);
        }
    }
    if content.trim().is_empty() && merged.is_empty() {
        return None;
    }
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String("system".to_string()));
    message.insert("content".to_string(), Value::String(content));
    if !merged.is_empty() {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(merged.join("\n")),
        );
    }
    Some(Value::Object(message))
}

pub(crate) fn apply_bridge_inject_system_instruction(
    input: ApplyBridgeInjectSystemInstructionInput,
) -> ApplyBridgeInjectSystemInstructionOutput {
    let stage = input.stage.trim().to_ascii_lowercase();
    let mut messages = input.messages;
    if stage != "request_inbound" {
        return ApplyBridgeInjectSystemInstructionOutput { messages };
    }
    let Some(raw_request) = input.raw_request else {
        return ApplyBridgeInjectSystemInstructionOutput { messages };
    };
    let Some(raw_obj) = raw_request.as_object() else {
        return ApplyBridgeInjectSystemInstructionOutput { messages };
    };

    let options = input.options.as_ref().and_then(Value::as_object);
    let field = read_option_string(options, "field").unwrap_or_else(|| "instructions".to_string());
    let reasoning_field = read_option_string(options, "reasoningField");
    let Some(instructions) = read_instruction_value(raw_obj, field.as_str()) else {
        return ApplyBridgeInjectSystemInstructionOutput { messages };
    };
    let reasoning_segments = read_instruction_reasoning(raw_obj, reasoning_field.as_deref());
    let Some(message) = build_instruction_message(instructions.as_str(), &reasoning_segments)
    else {
        return ApplyBridgeInjectSystemInstructionOutput { messages };
    };
    messages.insert(0, message);
    ApplyBridgeInjectSystemInstructionOutput { messages }
}

pub(crate) fn apply_bridge_ensure_system_instruction(
    mut input: ApplyBridgeEnsureSystemInstructionInput,
) -> ApplyBridgeEnsureSystemInstructionOutput {
    let stage = input.stage.trim().to_ascii_lowercase();
    let mut messages = input.messages;
    if messages.is_empty() {
        return ApplyBridgeEnsureSystemInstructionOutput {
            messages,
            metadata: input.metadata,
        };
    }

    if stage == "request_outbound" {
        let mut originals: Vec<String> = Vec::new();
        for message in messages.iter() {
            let Some(obj) = message.as_object() else {
                continue;
            };
            let role = obj
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if role != "system" {
                continue;
            }
            let text = obj
                .get("content")
                .and_then(flatten_content_to_string)
                .unwrap_or_default()
                .trim()
                .to_string();
            if !text.is_empty() {
                originals.push(text);
            }
        }
        if !originals.is_empty() {
            let metadata = ensure_object_value(&mut input.metadata);
            metadata.insert(
                "systemInstruction".to_string(),
                Value::String(originals.join("\n\n")),
            );
            metadata.insert(
                "originalSystemMessages".to_string(),
                Value::Array(originals.into_iter().map(Value::String).collect()),
            );
        }
        return ApplyBridgeEnsureSystemInstructionOutput {
            messages,
            metadata: input.metadata,
        };
    }

    if stage == "request_inbound" {
        let system_instruction = input
            .metadata
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|metadata| metadata.get("systemInstruction"))
            .and_then(Value::as_str)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty());
        let Some(system_instruction) = system_instruction else {
            return ApplyBridgeEnsureSystemInstructionOutput {
                messages,
                metadata: input.metadata,
            };
        };
        let has_system = messages.iter().any(|message| {
            message
                .as_object()
                .and_then(|obj| obj.get("role"))
                .and_then(Value::as_str)
                .map(|role| role.trim().eq_ignore_ascii_case("system"))
                .unwrap_or(false)
        });
        if !has_system {
            messages.insert(
                0,
                serde_json::json!({
                  "role": "system",
                  "content": system_instruction
                }),
            );
        }
    }

    ApplyBridgeEnsureSystemInstructionOutput {
        messages,
        metadata: input.metadata,
    }
}

fn collect_extra_fields(
    source: &Map<String, Value>,
    allowed: Option<&HashSet<String>>,
) -> Option<Map<String, Value>> {
    let mut extras = Map::new();
    for (key, value) in source.iter() {
        if let Some(set) = allowed {
            if set.contains(key) {
                continue;
            }
        }
        extras.insert(key.to_string(), value.clone());
    }
    if extras.is_empty() {
        return None;
    }
    Some(extras)
}

fn resolve_stage_payload_mut<'a>(
    stage: &str,
    raw_request: &'a mut Option<Value>,
    raw_response: &'a mut Option<Value>,
) -> Option<&'a mut Map<String, Value>> {
    if stage.starts_with("request") {
        return raw_request.as_mut().and_then(Value::as_object_mut);
    }
    if stage.starts_with("response") {
        return raw_response.as_mut().and_then(Value::as_object_mut);
    }
    None
}

fn parse_provider_metadata(raw: &Value) -> Option<Value> {
    if let Some(text) = raw.as_str() {
        let parsed: Value = serde_json::from_str(text).ok()?;
        if parsed.is_object() {
            return Some(parsed);
        }
        return None;
    }
    if raw.is_object() {
        return Some(raw.clone());
    }
    None
}

pub(crate) fn apply_bridge_metadata_action(
    mut input: ApplyBridgeMetadataActionInput,
) -> ApplyBridgeMetadataActionOutput {
    let action = input.action_name.trim();
    if action.is_empty() {
        return ApplyBridgeMetadataActionOutput {
            raw_request: input.raw_request,
            raw_response: input.raw_response,
            metadata: input.metadata,
        };
    }

    let stage = input.stage.trim().to_ascii_lowercase();
    let options = input.options.as_ref().and_then(Value::as_object);

    if action == "metadata.extra-fields" {
        if stage.ends_with("inbound") {
            let Some(payload) = resolve_stage_payload_mut(
                stage.as_str(),
                &mut input.raw_request,
                &mut input.raw_response,
            ) else {
                return ApplyBridgeMetadataActionOutput {
                    raw_request: input.raw_request,
                    raw_response: input.raw_response,
                    metadata: input.metadata,
                };
            };

            let allowed = options
                .and_then(|row| row.get("allowedKeys"))
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|entry| entry.to_string())
                        .collect::<HashSet<String>>()
                });
            if let Some(extras) = collect_extra_fields(payload, allowed.as_ref()) {
                let metadata = ensure_object_value(&mut input.metadata);
                if let Some(existing) = metadata
                    .get_mut("extraFields")
                    .and_then(Value::as_object_mut)
                {
                    for (key, value) in extras {
                        existing.insert(key, value);
                    }
                } else {
                    metadata.insert("extraFields".to_string(), Value::Object(extras));
                }
            }
        } else {
            let payload = resolve_stage_payload_mut(
                stage.as_str(),
                &mut input.raw_request,
                &mut input.raw_response,
            );
            let metadata = input.metadata.as_ref().and_then(Value::as_object);
            let extras = metadata
                .and_then(|row| row.get("extraFields"))
                .and_then(Value::as_object);
            if let (Some(payload_obj), Some(extra_fields)) = (payload, extras) {
                for (key, value) in extra_fields {
                    if !payload_obj.contains_key(key) {
                        payload_obj.insert(key.to_string(), value.clone());
                    }
                }
            }
        }

        return ApplyBridgeMetadataActionOutput {
            raw_request: input.raw_request,
            raw_response: input.raw_response,
            metadata: input.metadata,
        };
    }

    if action == "metadata.provider-field" {
        let field = read_option_string(options, "field").unwrap_or_else(|| "metadata".to_string());
        let target =
            read_option_string(options, "target").unwrap_or_else(|| "providerMetadata".to_string());

        if stage.ends_with("inbound") {
            let Some(payload) = resolve_stage_payload_mut(
                stage.as_str(),
                &mut input.raw_request,
                &mut input.raw_response,
            ) else {
                return ApplyBridgeMetadataActionOutput {
                    raw_request: input.raw_request,
                    raw_response: input.raw_response,
                    metadata: input.metadata,
                };
            };
            let Some(value) = payload.get(field.as_str()) else {
                return ApplyBridgeMetadataActionOutput {
                    raw_request: input.raw_request,
                    raw_response: input.raw_response,
                    metadata: input.metadata,
                };
            };
            if !value.is_object() {
                return ApplyBridgeMetadataActionOutput {
                    raw_request: input.raw_request,
                    raw_response: input.raw_response,
                    metadata: input.metadata,
                };
            }
            let metadata = ensure_object_value(&mut input.metadata);
            metadata.insert(target, value.clone());
        } else {
            let payload = resolve_stage_payload_mut(
                stage.as_str(),
                &mut input.raw_request,
                &mut input.raw_response,
            );
            let provider = input
                .metadata
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|row| row.get(target.as_str()))
                .filter(|value| value.is_object());
            if let (Some(payload_obj), Some(provider_obj)) = (payload, provider) {
                if !payload_obj.contains_key(field.as_str()) {
                    payload_obj.insert(field, provider_obj.clone());
                }
            }
        }

        return ApplyBridgeMetadataActionOutput {
            raw_request: input.raw_request,
            raw_response: input.raw_response,
            metadata: input.metadata,
        };
    }

    if action == "metadata.provider-sentinel" {
        let sentinel = read_option_string(options, "sentinel");
        let target =
            read_option_string(options, "target").unwrap_or_else(|| "providerMetadata".to_string());
        let Some(sentinel_key) = sentinel else {
            return ApplyBridgeMetadataActionOutput {
                raw_request: input.raw_request,
                raw_response: input.raw_response,
                metadata: input.metadata,
            };
        };

        let payload = resolve_stage_payload_mut(
            stage.as_str(),
            &mut input.raw_request,
            &mut input.raw_response,
        );
        let Some(payload_obj) = payload else {
            return ApplyBridgeMetadataActionOutput {
                raw_request: input.raw_request,
                raw_response: input.raw_response,
                metadata: input.metadata,
            };
        };

        if stage.ends_with("inbound") {
            if let Some(raw) = payload_obj.remove(sentinel_key.as_str()) {
                if let Some(provider) = parse_provider_metadata(&raw) {
                    let metadata = ensure_object_value(&mut input.metadata);
                    metadata.insert(target, provider);
                }
            }
            return ApplyBridgeMetadataActionOutput {
                raw_request: input.raw_request,
                raw_response: input.raw_response,
                metadata: input.metadata,
            };
        }

        if stage == "request_outbound" {
            payload_obj.remove(sentinel_key.as_str());
            return ApplyBridgeMetadataActionOutput {
                raw_request: input.raw_request,
                raw_response: input.raw_response,
                metadata: input.metadata,
            };
        }

        let provider = input
            .metadata
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|row| row.get(target.as_str()))
            .filter(|value| value.is_object());
        if let Some(provider_value) = provider {
            match serde_json::to_string(provider_value) {
                Ok(text) => {
                    payload_obj.insert(sentinel_key, Value::String(text));
                }
                Err(_) => {
                    payload_obj.insert(sentinel_key, provider_value.clone());
                }
            }
        } else {
            payload_obj.remove(sentinel_key.as_str());
        }

        return ApplyBridgeMetadataActionOutput {
            raw_request: input.raw_request,
            raw_response: input.raw_response,
            metadata: input.metadata,
        };
    }

    ApplyBridgeMetadataActionOutput {
        raw_request: input.raw_request,
        raw_response: input.raw_response,
        metadata: input.metadata,
    }
}
