use regex::Regex;
use serde_json::{Map, Value};

use crate::chat_process_media_semantics::analyze_chat_process_media;
use crate::shared_json_utils::{as_object, read_trimmed_string};
use crate::virtual_router_engine::instructions::parse_routing_instructions_from_messages;

#[derive(Debug)]
pub(crate) struct GovernanceContext {
    pub(crate) entry_endpoint: String,
}

pub(crate) fn resolve_governance_context(
    metadata: &Value,
    input_entry_endpoint: &str,
) -> GovernanceContext {
    let metadata_obj = as_object(metadata);

    let entry_endpoint = read_trimmed_string(metadata_obj.and_then(|obj| obj.get("entryEndpoint")))
        .or_else(|| {
            let trimmed = input_entry_endpoint.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .unwrap_or_else(|| "/v1/chat/completions".to_string());

    GovernanceContext { entry_endpoint }
}

pub(crate) fn apply_anthropic_tool_alias_semantics(
    request: &mut Map<String, Value>,
    entry_endpoint: &str,
) {
    if !entry_endpoint.contains("/v1/messages") {
        return;
    }
    if !request.contains_key("metadata") {
        request.insert("metadata".to_string(), Value::Object(Map::new()));
    }
    if let Some(metadata) = request.get_mut("metadata").and_then(|v| v.as_object_mut()) {
        metadata.insert("preserveNativeToolNames".to_string(), Value::Bool(true));
    }
}

pub(crate) fn apply_post_governed_media_cleanup(request: &mut Map<String, Value>) {
    let current_messages = request
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if !current_messages.is_empty() {
        let media_analysis = analyze_chat_process_media(current_messages);
        if media_analysis.contains_current_turn_image {
            let metadata = request
                .entry("metadata".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(metadata_obj) = metadata.as_object_mut() {
                metadata_obj.insert("hasImageAttachment".to_string(), Value::Bool(true));
            }
        }
    }
}

pub(crate) fn strip_generic_markers_from_request(request: &mut Map<String, Value>) {
    if request_has_routing_instruction_markers(request) {
        return;
    }

    if let Some(messages) = request.get_mut("messages").and_then(|v| v.as_array_mut()) {
        for message in messages.iter_mut() {
            let Some(message_obj) = message.as_object_mut() else {
                continue;
            };
            let Some(content) = message_obj.get("content").cloned() else {
                continue;
            };
            message_obj.insert(
                "content".to_string(),
                strip_marker_syntax_from_content_value(&content),
            );
        }
    }

    let Some(context_input) = request
        .get_mut("semantics")
        .and_then(|v| v.as_object_mut())
        .and_then(|semantics| semantics.get_mut("responses"))
        .and_then(|v| v.as_object_mut())
        .and_then(|responses| responses.get_mut("context"))
        .and_then(|v| v.as_object_mut())
        .and_then(|context| context.get_mut("input"))
        .and_then(|v| v.as_array_mut())
    else {
        return;
    };

    for entry in context_input.iter_mut() {
        let Some(entry_obj) = entry.as_object_mut() else {
            continue;
        };
        let Some(content) = entry_obj.get("content").cloned() else {
            continue;
        };
        entry_obj.insert(
            "content".to_string(),
            strip_marker_syntax_from_content_value(&content),
        );
    }
}

fn compact_marker_whitespace(input: &str) -> String {
    let without_inline_space = Regex::new(r"[ \t]+\n")
        .expect("valid inline marker whitespace regex")
        .replace_all(input, "\n")
        .to_string();
    Regex::new(r"\n{3,}")
        .expect("valid repeated newline regex")
        .replace_all(without_inline_space.trim(), "\n\n")
        .to_string()
}

fn strip_marker_syntax_from_text(raw: &str) -> String {
    if !raw.contains("<**") {
        return raw.to_string();
    }

    let mut output = String::with_capacity(raw.len());
    let mut cursor = 0usize;

    while cursor < raw.len() {
        let marker_start = match raw[cursor..].find("<**") {
            Some(offset) => cursor + offset,
            None => {
                output.push_str(&raw[cursor..]);
                break;
            }
        };

        output.push_str(&raw[cursor..marker_start]);

        let close_index = raw[marker_start + 3..]
            .find("**>")
            .map(|offset| marker_start + 3 + offset);
        let newline_index = raw[marker_start + 3..]
            .find('\n')
            .map(|offset| marker_start + 3 + offset);
        let has_closed_marker = match (close_index, newline_index) {
            (Some(close), Some(newline)) => close < newline,
            (Some(_), None) => true,
            _ => false,
        };
        let marker_end = if has_closed_marker {
            close_index.unwrap() + 3
        } else {
            newline_index.unwrap_or(raw.len())
        };
        cursor = marker_end;
    }

    compact_marker_whitespace(output.as_str())
}

fn strip_marker_syntax_from_content_value(content: &Value) -> Value {
    match content {
        Value::String(text) => Value::String(strip_marker_syntax_from_text(text)),
        Value::Array(parts) => {
            let next_parts = parts
                .iter()
                .map(|part| match part {
                    Value::String(text) => Value::String(strip_marker_syntax_from_text(text)),
                    Value::Object(obj) => {
                        let mut next = obj.clone();
                        for key in ["text", "content"] {
                            let Some(Value::String(raw)) = next.get(key) else {
                                continue;
                            };
                            next.insert(
                                key.to_string(),
                                Value::String(strip_marker_syntax_from_text(raw)),
                            );
                        }
                        Value::Object(next)
                    }
                    _ => part.clone(),
                })
                .collect::<Vec<Value>>();
            Value::Array(next_parts)
        }
        _ => content.clone(),
    }
}

fn request_has_routing_instruction_markers(request: &Map<String, Value>) -> bool {
    let messages = request
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    parse_routing_instructions_from_messages(messages.as_slice())
        .map(|instructions| !instructions.is_empty())
        .unwrap_or(false)
}
