use serde_json::{Map, Value};
use std::collections::HashMap;

use super::types::{
    ApplyBridgeNormalizeToolIdentifiersInput, NormalizeBridgeToolCallIdsInput,
    NormalizeBridgeToolCallIdsOutput,
};
use super::utils::read_trimmed_string;

#[derive(Debug)]
struct ToolIdNormalizer {
    id_prefix: String,
    counter: usize,
    alias_map: HashMap<String, String>,
    pending_queue: Vec<String>,
}

impl ToolIdNormalizer {
    fn new(id_prefix: Option<String>) -> Self {
        let prefix = id_prefix
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "bridge_tool".to_string());
        Self {
            id_prefix: prefix,
            counter: 0,
            alias_map: HashMap::new(),
            pending_queue: Vec::new(),
        }
    }

    fn next_id(&mut self) -> String {
        self.counter += 1;
        format!("{}_{}", self.id_prefix, self.counter)
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

    fn consume_pending(&mut self, id: &str) {
        if let Some(index) = self.pending_queue.iter().position(|v| v == id) {
            self.pending_queue.remove(index);
        }
    }

    fn normalize_id_value(&mut self, raw: Option<&str>, consume_queue: bool) -> String {
        let existing = raw.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        if let Some(existing_id) = existing {
            if let Some(mapped) = self.alias_map.get(existing_id.as_str()) {
                return mapped.clone();
            }
            if consume_queue && !self.pending_queue.is_empty() {
                let queued = self.pending_queue.remove(0);
                self.register_alias(Some(existing_id.as_str()), queued.as_str());
                return queued;
            }
            self.register_alias(Some(existing_id.as_str()), existing_id.as_str());
            return existing_id;
        }
        if consume_queue && !self.pending_queue.is_empty() {
            let queued = self.pending_queue.remove(0);
            self.register_alias(Some(queued.as_str()), queued.as_str());
            return queued;
        }
        let generated = self.next_id();
        self.register_alias(Some(generated.as_str()), generated.as_str());
        generated
    }
}

fn normalize_tool_call_obj(
    call_obj: &mut Map<String, Value>,
    normalizer: &mut ToolIdNormalizer,
    consume_queue: bool,
) -> Option<String> {
    let raw_id = read_trimmed_string(call_obj.get("id"))
        .or_else(|| read_trimmed_string(call_obj.get("tool_call_id")))
        .or_else(|| read_trimmed_string(call_obj.get("call_id")));
    let normalized = normalizer.normalize_id_value(raw_id.as_deref(), consume_queue);
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
) -> String {
    let raw_id = read_trimmed_string(message_obj.get("tool_call_id"))
        .or_else(|| read_trimmed_string(message_obj.get("call_id")))
        .or_else(|| read_trimmed_string(message_obj.get("id")));
    let normalized = normalizer.normalize_id_value(raw_id.as_deref(), true);
    let prev_tool_call_id = read_trimmed_string(message_obj.get("tool_call_id"));
    let prev_call_id = read_trimmed_string(message_obj.get("call_id"));
    let prev_id = read_trimmed_string(message_obj.get("id"));
    normalizer.register_alias(prev_tool_call_id.as_deref(), normalized.as_str());
    normalizer.register_alias(prev_call_id.as_deref(), normalized.as_str());
    normalizer.register_alias(prev_id.as_deref(), normalized.as_str());
    normalizer.consume_pending(normalized.as_str());
    message_obj.insert(
        "tool_call_id".to_string(),
        Value::String(normalized.clone()),
    );
    message_obj.insert("call_id".to_string(), Value::String(normalized.clone()));
    if !message_obj.contains_key("id") {
        message_obj.insert("id".to_string(), Value::String(normalized.clone()));
    }
    normalized
}

fn normalize_tool_output_obj(
    row: &mut Map<String, Value>,
    normalizer: &mut ToolIdNormalizer,
) -> String {
    let raw_id = read_trimmed_string(row.get("tool_call_id"))
        .or_else(|| read_trimmed_string(row.get("call_id")))
        .or_else(|| read_trimmed_string(row.get("id")));
    let normalized = normalizer.normalize_id_value(raw_id.as_deref(), true);
    let prev_tool_call_id = read_trimmed_string(row.get("tool_call_id"));
    let prev_call_id = read_trimmed_string(row.get("call_id"));
    normalizer.register_alias(prev_tool_call_id.as_deref(), normalized.as_str());
    normalizer.register_alias(prev_call_id.as_deref(), normalized.as_str());
    normalizer.consume_pending(normalized.as_str());
    row.insert(
        "tool_call_id".to_string(),
        Value::String(normalized.clone()),
    );
    row.insert("call_id".to_string(), Value::String(normalized.clone()));
    normalized
}

fn normalize_messages(messages: &mut [Value], normalizer: &mut ToolIdNormalizer) {
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
                if let Some(normalized) = normalize_tool_call_obj(call_obj, normalizer, false) {
                    normalizer.pending_queue.push(normalized);
                }
            }
            continue;
        }
        if role == "tool" {
            normalize_tool_message_obj(message_obj, normalizer);
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
        normalize_tool_call_obj(call_obj, normalizer, false);
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
        normalize_tool_output_obj(row, normalizer);
    }
}

pub(crate) fn normalize_bridge_tool_call_ids(
    input: NormalizeBridgeToolCallIdsInput,
) -> NormalizeBridgeToolCallIdsOutput {
    let mut messages = input.messages;
    let mut raw_request = input.raw_request;
    let mut captured_tool_results = input.captured_tool_results;
    let mut normalizer = ToolIdNormalizer::new(input.id_prefix);

    normalize_messages(messages.as_mut_slice(), &mut normalizer);
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
    let mut output = normalize_bridge_tool_call_ids(NormalizeBridgeToolCallIdsInput {
        messages: input.messages,
        raw_request: input.raw_request,
        captured_tool_results: input.captured_tool_results,
        id_prefix: input.id_prefix,
    });
    if stage == "request_inbound" && is_openai_responses_context(protocol, module_type) {
        trim_responses_inbound_tool_aliases(&mut output.messages);
    }
    output
}
