use serde_json::{Map, Value};
use std::collections::{HashMap, VecDeque};

use crate::shared_json_utils::read_trimmed_string;

use super::types::{
    ApplyBridgeNormalizeToolIdentifiersInput, NormalizeBridgeToolCallIdsInput,
    NormalizeBridgeToolCallIdsOutput,
};

#[derive(Debug)]
struct ToolIdNormalizer {
    alias_map: HashMap<String, String>,
    raw_call_counts: HashMap<String, usize>,
    pending_by_raw: HashMap<String, VecDeque<String>>,
}

impl ToolIdNormalizer {
    fn new(_id_prefix: Option<String>) -> Self {
        Self {
            alias_map: HashMap::new(),
            raw_call_counts: HashMap::new(),
            pending_by_raw: HashMap::new(),
        }
    }

    fn register_alias(&mut self, raw: Option<&str>, normalized: &str) {
        if let Some(value) = raw {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                self.alias_map
                    .insert(trimmed.to_string(), normalized.to_string());
            }
        }
        self.alias_map
            .insert(normalized.to_string(), normalized.to_string());
    }

    fn normalize_id_value(&mut self, raw: Option<&str>) -> Option<String> {
        let existing = raw.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        if let Some(existing_id) = existing {
            if let Some(mapped) = self.alias_map.get(existing_id.as_str()) {
                return Some(mapped.clone());
            }
            self.register_alias(Some(existing_id.as_str()), existing_id.as_str());
            return Some(existing_id);
        }
        None
    }

    fn normalize_new_tool_call_id(&mut self, raw: Option<&str>) -> Option<String> {
        let existing = raw
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())?;
        let count = self.raw_call_counts.entry(existing.clone()).or_insert(0);
        *count += 1;
        let normalized = if *count == 1 {
            existing.clone()
        } else {
            format!("{}__dup{}", existing, *count)
        };
        self.register_alias(Some(existing.as_str()), normalized.as_str());
        self.pending_by_raw
            .entry(existing)
            .or_insert_with(VecDeque::new)
            .push_back(normalized.clone());
        Some(normalized)
    }

    fn normalize_tool_result_id(&mut self, raw: Option<&str>) -> Option<String> {
        let existing = raw
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())?;
        if let Some(queue) = self.pending_by_raw.get_mut(existing.as_str()) {
            if let Some(next) = queue.pop_front() {
                self.register_alias(Some(existing.as_str()), next.as_str());
                return Some(next);
            }
        }
        self.normalize_id_value(Some(existing.as_str()))
    }
}

fn normalize_tool_call_obj(
    call_obj: &mut Map<String, Value>,
    normalizer: &mut ToolIdNormalizer,
    unique_call_turn_ids: bool,
) -> Option<String> {
    let raw_id = read_trimmed_string(call_obj.get("id"))
        .or_else(|| read_trimmed_string(call_obj.get("tool_call_id")))
        .or_else(|| read_trimmed_string(call_obj.get("call_id")));
    let normalized = if unique_call_turn_ids {
        normalizer.normalize_new_tool_call_id(raw_id.as_deref())?
    } else {
        normalizer.normalize_id_value(raw_id.as_deref())?
    };
    let prev_id = read_trimmed_string(call_obj.get("id"));
    let prev_tool_call_id = read_trimmed_string(call_obj.get("tool_call_id"));
    let prev_call_id = read_trimmed_string(call_obj.get("call_id"));
    normalizer.register_alias(prev_id.as_deref(), normalized.as_str());
    normalizer.register_alias(prev_tool_call_id.as_deref(), normalized.as_str());
    normalizer.register_alias(prev_call_id.as_deref(), normalized.as_str());
    call_obj.insert("id".to_string(), Value::String(normalized.clone()));
    call_obj.insert(
        "tool_call_id".to_string(),
        Value::String(normalized.clone()),
    );
    call_obj.insert("call_id".to_string(), Value::String(normalized.clone()));
    Some(normalized)
}

fn normalize_tool_message_obj(
    message_obj: &mut Map<String, Value>,
    normalizer: &mut ToolIdNormalizer,
) -> Option<String> {
    let raw_id = read_trimmed_string(message_obj.get("tool_call_id"))
        .or_else(|| read_trimmed_string(message_obj.get("call_id")))
        .or_else(|| read_trimmed_string(message_obj.get("id")));
    let normalized = normalizer.normalize_tool_result_id(raw_id.as_deref())?;
    let prev_tool_call_id = read_trimmed_string(message_obj.get("tool_call_id"));
    let prev_call_id = read_trimmed_string(message_obj.get("call_id"));
    let prev_id = read_trimmed_string(message_obj.get("id"));
    normalizer.register_alias(prev_tool_call_id.as_deref(), normalized.as_str());
    normalizer.register_alias(prev_call_id.as_deref(), normalized.as_str());
    normalizer.register_alias(prev_id.as_deref(), normalized.as_str());
    message_obj.insert(
        "tool_call_id".to_string(),
        Value::String(normalized.clone()),
    );
    message_obj.insert("call_id".to_string(), Value::String(normalized.clone()));
    if !message_obj.contains_key("id") {
        message_obj.insert("id".to_string(), Value::String(normalized.clone()));
    }
    Some(normalized)
}

fn normalize_tool_output_obj(
    row: &mut Map<String, Value>,
    normalizer: &mut ToolIdNormalizer,
) -> Option<String> {
    let raw_id = read_trimmed_string(row.get("tool_call_id"))
        .or_else(|| read_trimmed_string(row.get("call_id")))
        .or_else(|| read_trimmed_string(row.get("id")));
    let normalized = normalizer.normalize_tool_result_id(raw_id.as_deref())?;
    let prev_tool_call_id = read_trimmed_string(row.get("tool_call_id"));
    let prev_call_id = read_trimmed_string(row.get("call_id"));
    normalizer.register_alias(prev_tool_call_id.as_deref(), normalized.as_str());
    normalizer.register_alias(prev_call_id.as_deref(), normalized.as_str());
    row.insert(
        "tool_call_id".to_string(),
        Value::String(normalized.clone()),
    );
    row.insert("call_id".to_string(), Value::String(normalized.clone()));
    Some(normalized)
}

fn normalize_messages(
    messages: &mut [Value],
    normalizer: &mut ToolIdNormalizer,
    unique_call_turn_ids: bool,
) {
    for message in messages.iter_mut() {
        let Some(message_obj) = message.as_object_mut() else {
            continue;
        };
        let role = message_obj
            .get("role")
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role == "assistant" {
            let Some(tool_calls) = message_obj
                .get_mut("tool_calls")
                .and_then(Value::as_array_mut)
            else {
                continue;
            };
            for call in tool_calls.iter_mut() {
                let Some(call_obj) = call.as_object_mut() else {
                    continue;
                };
                let _ = normalize_tool_call_obj(call_obj, normalizer, unique_call_turn_ids);
            }
            continue;
        }
        if role == "tool" {
            let _ = normalize_tool_message_obj(message_obj, normalizer);
        }
    }
}

fn normalize_raw_request(raw_request: &mut Option<Value>, normalizer: &mut ToolIdNormalizer) {
    let Some(payload) = raw_request.as_mut() else {
        return;
    };
    let Some(root) = payload.as_object_mut() else {
        return;
    };
    if let Some(tool_outputs) = root.get_mut("tool_outputs").and_then(Value::as_array_mut) {
        for entry in tool_outputs.iter_mut() {
            let Some(row) = entry.as_object_mut() else {
                continue;
            };
            normalize_tool_output_obj(row, normalizer);
        }
    }
    let Some(required_action) = root
        .get_mut("required_action")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let Some(submit) = required_action
        .get_mut("submit_tool_outputs")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let Some(tool_calls) = submit.get_mut("tool_calls").and_then(Value::as_array_mut) else {
        return;
    };
    for call in tool_calls.iter_mut() {
        let Some(call_obj) = call.as_object_mut() else {
            continue;
        };
        let _ = normalize_tool_call_obj(call_obj, normalizer, false);
    }
}

fn normalize_captured_tool_results(
    captured_tool_results: &mut Option<Vec<Value>>,
    normalizer: &mut ToolIdNormalizer,
) {
    let Some(entries) = captured_tool_results.as_mut() else {
        return;
    };
    for entry in entries.iter_mut() {
        let Some(row) = entry.as_object_mut() else {
            continue;
        };
        let _ = normalize_tool_output_obj(row, normalizer);
    }
}

pub(crate) fn normalize_bridge_tool_call_ids(
    input: NormalizeBridgeToolCallIdsInput,
) -> NormalizeBridgeToolCallIdsOutput {
    normalize_bridge_tool_call_ids_with_policy(input, false)
}

fn normalize_bridge_tool_call_ids_with_policy(
    input: NormalizeBridgeToolCallIdsInput,
    unique_call_turn_ids: bool,
) -> NormalizeBridgeToolCallIdsOutput {
    let mut messages = input.messages;
    let mut raw_request = input.raw_request;
    let mut captured_tool_results = input.captured_tool_results;
    let mut normalizer = ToolIdNormalizer::new(input.id_prefix);

    normalize_messages(
        messages.as_mut_slice(),
        &mut normalizer,
        unique_call_turn_ids,
    );
    normalize_raw_request(&mut raw_request, &mut normalizer);
    normalize_captured_tool_results(&mut captured_tool_results, &mut normalizer);

    NormalizeBridgeToolCallIdsOutput {
        messages,
        raw_request,
        captured_tool_results,
    }
}

fn is_openai_responses_context(protocol: Option<&str>, module_type: Option<&str>) -> bool {
    let protocol_token = protocol.unwrap_or("").trim().to_ascii_lowercase();
    let module_token = module_type.unwrap_or("").trim().to_ascii_lowercase();
    protocol_token == "openai-responses" || module_token == "openai-responses"
}

fn trim_responses_inbound_tool_aliases(messages: &mut Vec<Value>) {
    for message in messages.iter_mut() {
        let Some(message_obj) = message.as_object_mut() else {
            continue;
        };
        let role = message_obj
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role == "assistant" {
            if let Some(tool_calls) = message_obj
                .get_mut("tool_calls")
                .and_then(Value::as_array_mut)
            {
                for call in tool_calls.iter_mut() {
                    let Some(call_obj) = call.as_object_mut() else {
                        continue;
                    };
                    call_obj.remove("tool_call_id");
                    call_obj.remove("call_id");
                }
            }
            continue;
        }
        if role == "tool" {
            message_obj.remove("call_id");
        }
    }
}

pub(crate) fn apply_bridge_normalize_tool_identifiers(
    input: ApplyBridgeNormalizeToolIdentifiersInput,
) -> NormalizeBridgeToolCallIdsOutput {
    let stage = input.stage.trim().to_ascii_lowercase();
    let protocol = input.protocol.as_deref();
    let module_type = input.module_type.as_deref();
    let unique_call_turn_ids = stage == "request_outbound";
    let mut output = normalize_bridge_tool_call_ids_with_policy(
        NormalizeBridgeToolCallIdsInput {
            messages: input.messages,
            raw_request: input.raw_request,
            captured_tool_results: input.captured_tool_results,
            id_prefix: input.id_prefix,
        },
        unique_call_turn_ids,
    );
    if stage == "request_inbound" && is_openai_responses_context(protocol, module_type) {
        trim_responses_inbound_tool_aliases(&mut output.messages);
    }
    output
}
