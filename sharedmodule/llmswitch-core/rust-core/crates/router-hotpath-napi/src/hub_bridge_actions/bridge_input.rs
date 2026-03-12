use serde_json::{Map, Value};
use std::collections::HashMap;

use crate::hub_reasoning_tool_normalizer::repair_arguments_to_string;
use crate::hub_resp_outbound_client_semantics::normalize_responses_function_name;
use crate::shared_chat_output_normalizer::normalize_chat_message_content;

use super::reasoning::{
    combine_reasoning_segments, extract_reasoning_segments, to_reasoning_segments,
};
use super::types::{
    BridgeInputToChatInput, BridgeInputToChatOutput, ExtractReasoningSegmentsInput,
    ExtractReasoningSegmentsOutput, RepairToolCallInput, ValidateToolArgumentsInput,
    ValidateToolArgumentsOutput,
};
use super::utils::{
    coerce_bridge_role, normalize_function_call_id, read_trimmed_string, serialize_tool_arguments,
    MediaBlock,
};

fn default_normalize_function_name(raw: Option<&str>) -> Option<String> {
    let trimmed = raw.unwrap_or("").trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_function_name_by_mode(raw: Option<&str>, mode: &str) -> Option<String> {
    if mode.eq_ignore_ascii_case("responses") {
        return normalize_responses_function_name(raw);
    }
    default_normalize_function_name(raw)
}

fn push_normalized_chat_message(
    target: &mut Vec<Value>,
    role: &str,
    raw_content: Option<&str>,
    reasoning_segments: Option<Vec<String>>,
) {
    let Some(raw_content) = raw_content else {
        return;
    };
    let normalized = normalize_chat_message_content(&Value::String(raw_content.to_string()));
    let content_text = normalized.content_text.unwrap_or_default();
    let reasoning_text = normalized.reasoning_text.unwrap_or_default();
    let has_content = !content_text.trim().is_empty();
    if !has_content && reasoning_text.trim().is_empty() {
        return;
    }
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String(role.to_string()));
    message.insert("content".to_string(), Value::String(content_text));
    let mut combined: Vec<String> = Vec::new();
    if !reasoning_text.trim().is_empty() {
        combined.push(reasoning_text.trim().to_string());
    }
    if let Some(extra) = reasoning_segments {
        combined.extend(extra.into_iter().filter(|entry| !entry.trim().is_empty()));
    }
    if !combined.is_empty() {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(combined.join("\n")),
        );
    }
    target.push(Value::Object(message));
}

fn push_chat_message_without_reparse(
    target: &mut Vec<Value>,
    role: &str,
    raw_content: Option<&str>,
    reasoning_segments: Option<Vec<String>>,
) {
    let Some(raw_content) = raw_content else {
        return;
    };
    let trimmed = raw_content.trim();
    let mut combined: Vec<String> = reasoning_segments
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| !entry.trim().is_empty())
        .collect();
    if trimmed.is_empty() && combined.is_empty() {
        return;
    }
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String(role.to_string()));
    message.insert(
        "content".to_string(),
        Value::String(raw_content.to_string()),
    );
    if !combined.is_empty() {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(combined.join("\n")),
        );
    }
    target.push(Value::Object(message));
}

fn ensure_assistant_tool_call_identity(
    call_obj: &mut Map<String, Value>,
    fallback_id: &str,
) -> String {
    let resolved = read_trimmed_string(call_obj.get("call_id"))
        .or_else(|| read_trimmed_string(call_obj.get("tool_call_id")))
        .or_else(|| read_trimmed_string(call_obj.get("id")))
        .unwrap_or_else(|| fallback_id.to_string());
    call_obj.insert("id".to_string(), Value::String(resolved.clone()));
    call_obj.insert("tool_call_id".to_string(), Value::String(resolved.clone()));
    call_obj.insert("call_id".to_string(), Value::String(resolved.clone()));
    resolved
}

fn serialize_tool_output(entry: &Map<String, Value>) -> Option<String> {
    let out = entry.get("output")?;
    match out {
        Value::String(text) => Some(text.clone()),
        Value::Object(_) | Value::Array(_) => serde_json::to_string(out).ok(),
        _ => None,
    }
}

struct ProcessBlocksResult {
    text: Option<String>,
    media_blocks: Vec<MediaBlock>,
    ordered_content_blocks: Vec<Value>,
    tool_calls: Vec<Value>,
    tool_messages: Vec<Value>,
    last_call_id: Option<String>,
    reasoning_segments: Vec<String>,
}

fn process_message_blocks(
    blocks: &Value,
    normalize_mode: &str,
    tool_name_by_id: &mut HashMap<String, String>,
    last_tool_call_id: Option<String>,
    tool_result_fallback_text: &str,
) -> ProcessBlocksResult {
    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut tool_messages: Vec<Value> = Vec::new();
    let mut current_last_call = last_tool_call_id;
    let mut reasoning_segments: Vec<String> = Vec::new();
    let mut media_blocks: Vec<MediaBlock> = Vec::new();
    let mut ordered_content_blocks: Vec<Value> = Vec::new();

    let entries = blocks.as_array().cloned().unwrap_or_default();
    for block in entries {
        let Some(block_obj) = block.as_object() else {
            continue;
        };
        let block_type = block_obj
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if matches!(
            block_type.as_str(),
            "input_text" | "output_text" | "text" | "commentary"
        ) {
            if let Some(text) = block_obj.get("text").and_then(Value::as_str) {
                text_parts.push(text.to_string());
                ordered_content_blocks.push(serde_json::json!({
                    "type": if block_type == "output_text" { "output_text" } else if block_type == "commentary" { "commentary" } else { "input_text" },
                    "text": text
                }));
            } else if let Some(text) = block_obj.get("content").and_then(Value::as_str) {
                text_parts.push(text.to_string());
                ordered_content_blocks.push(serde_json::json!({
                    "type": "input_text",
                    "text": text
                }));
            }
            reasoning_segments.extend(to_reasoning_segments(block_obj.get("reasoning_content")));
            continue;
        }
        if block_type == "message" {
            if let Some(content) = block_obj.get("content") {
                if content.is_array() {
                    let nested = process_message_blocks(
                        content,
                        normalize_mode,
                        tool_name_by_id,
                        current_last_call.clone(),
                        tool_result_fallback_text,
                    );
                    if let Some(text) = nested.text {
                        if !text.is_empty() {
                            text_parts.push(text);
                        }
                    }
                    tool_calls.extend(nested.tool_calls);
                    tool_messages.extend(nested.tool_messages);
                    current_last_call = nested.last_call_id;
                    reasoning_segments.extend(nested.reasoning_segments);
                    if !nested.media_blocks.is_empty() {
                        media_blocks.extend(nested.media_blocks);
                    }
                    if !nested.ordered_content_blocks.is_empty() {
                        ordered_content_blocks.extend(nested.ordered_content_blocks);
                    }
                }
            }
            continue;
        }
        if matches!(block_type.as_str(), "input_image" | "image" | "image_url") {
            let mut url = String::new();
            if let Some(Value::String(value)) = block_obj.get("image_url") {
                url = value.trim().to_string();
            } else if let Some(Value::Object(row)) = block_obj.get("image_url") {
                if let Some(Value::String(value)) = row.get("url") {
                    url = value.trim().to_string();
                }
            } else if let Some(Value::String(value)) = block_obj.get("url") {
                url = value.trim().to_string();
            }
            if !url.is_empty() {
                let detail = read_trimmed_string(block_obj.get("detail"));
                media_blocks.push(MediaBlock {
                    kind: "image",
                    url,
                    detail,
                });
                let mut block = Map::new();
                block.insert("type".to_string(), Value::String("image_url".to_string()));
                let mut image_url = Map::new();
                image_url.insert(
                    "url".to_string(),
                    Value::String(media_blocks.last().unwrap().url.clone()),
                );
                if let Some(detail_value) = media_blocks.last().and_then(|item| item.detail.clone())
                {
                    image_url.insert("detail".to_string(), Value::String(detail_value));
                }
                block.insert("image_url".to_string(), Value::Object(image_url));
                ordered_content_blocks.push(Value::Object(block));
            }
            continue;
        }
        if matches!(block_type.as_str(), "input_video" | "video" | "video_url") {
            let mut url = String::new();
            if let Some(Value::String(value)) = block_obj.get("video_url") {
                url = value.trim().to_string();
            } else if let Some(Value::Object(row)) = block_obj.get("video_url") {
                if let Some(Value::String(value)) = row.get("url") {
                    url = value.trim().to_string();
                }
            } else if let Some(Value::String(value)) = block_obj.get("url") {
                url = value.trim().to_string();
            }
            if !url.is_empty() {
                let detail = read_trimmed_string(block_obj.get("detail"));
                media_blocks.push(MediaBlock {
                    kind: "video",
                    url,
                    detail,
                });
                let mut block = Map::new();
                block.insert("type".to_string(), Value::String("video_url".to_string()));
                let mut video_url = Map::new();
                video_url.insert(
                    "url".to_string(),
                    Value::String(media_blocks.last().unwrap().url.clone()),
                );
                if let Some(detail_value) = media_blocks.last().and_then(|item| item.detail.clone())
                {
                    video_url.insert("detail".to_string(), Value::String(detail_value));
                }
                block.insert("video_url".to_string(), Value::Object(video_url));
                ordered_content_blocks.push(Value::Object(block));
            }
            continue;
        }
        if block_type == "function_call" {
            let raw_name = block_obj.get("name").and_then(Value::as_str).or_else(|| {
                block_obj
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|row| row.get("name").and_then(Value::as_str))
            });
            let Some(name) = normalize_function_name_by_mode(raw_name, normalize_mode) else {
                current_last_call = None;
                continue;
            };
            let args = block_obj
                .get("arguments")
                .or_else(|| {
                    block_obj
                        .get("function")
                        .and_then(Value::as_object)
                        .and_then(|row| row.get("arguments"))
                })
                .unwrap_or(&Value::Null);
            let call_id_candidate = read_trimmed_string(block_obj.get("call_id"))
                .or_else(|| read_trimmed_string(block_obj.get("id")));
            let call_id = call_id_candidate.unwrap_or_else(|| {
                normalize_function_call_id(
                    None,
                    format!("fc_call_{}", tool_calls.len() + 1).as_str(),
                )
            });
            let serialized = serialize_tool_arguments(Some(args)).trim().to_string();
            tool_name_by_id.insert(call_id.clone(), name.clone());
            let mut fn_row = Map::new();
            fn_row.insert("name".to_string(), Value::String(name));
            fn_row.insert("arguments".to_string(), Value::String(serialized));
            let mut call_obj = Map::new();
            call_obj.insert("id".to_string(), Value::String(call_id.clone()));
            call_obj.insert("call_id".to_string(), Value::String(call_id.clone()));
            call_obj.insert("type".to_string(), Value::String("function".to_string()));
            call_obj.insert("function".to_string(), Value::Object(fn_row));
            tool_calls.push(Value::Object(call_obj));
            current_last_call = Some(call_id);
            continue;
        }
        if matches!(
            block_type.as_str(),
            "function_call_output" | "tool_result" | "tool_message"
        ) {
            let tool_call_id = read_trimmed_string(block_obj.get("tool_call_id"))
                .or_else(|| read_trimmed_string(block_obj.get("call_id")))
                .or_else(|| read_trimmed_string(block_obj.get("tool_use_id")))
                .or_else(|| read_trimmed_string(block_obj.get("id")))
                .or_else(|| current_last_call.clone());
            if let Some(id) = tool_call_id.clone() {
                let output = serialize_tool_output(block_obj);
                let mut content = output.unwrap_or_default();
                if content.trim().is_empty() {
                    content = tool_result_fallback_text.to_string();
                }
                let mut tool_msg = Map::new();
                tool_msg.insert("role".to_string(), Value::String("tool".to_string()));
                tool_msg.insert("tool_call_id".to_string(), Value::String(id.clone()));
                tool_msg.insert("content".to_string(), Value::String(content));
                if let Some(name) = tool_name_by_id.get(&id) {
                    if !name.trim().is_empty() {
                        tool_msg.insert("name".to_string(), Value::String(name.clone()));
                    }
                }
                tool_messages.push(Value::Object(tool_msg));
                current_last_call = None;
            }
            continue;
        }
    }

    let text = if text_parts.is_empty() {
        None
    } else {
        Some(text_parts.join("\n").trim().to_string())
    };
    ProcessBlocksResult {
        text,
        media_blocks,
        ordered_content_blocks,
        tool_calls,
        tool_messages,
        last_call_id: current_last_call,
        reasoning_segments,
    }
}

pub(crate) fn convert_bridge_input_to_chat_messages(
    input: BridgeInputToChatInput,
) -> BridgeInputToChatOutput {
    let mut messages: Vec<Value> = Vec::new();
    if input.input.is_empty() {
        return BridgeInputToChatOutput { messages };
    }
    let mut tool_name_by_id: HashMap<String, String> = HashMap::new();
    let mut last_tool_call_id: Option<String> = None;
    let fallback_text = input
        .tool_result_fallback_text
        .unwrap_or_else(|| "Command succeeded (no output).".to_string());
    let normalize_mode = input
        .normalize_function_name
        .unwrap_or_else(|| "default".to_string());
    let is_responses_mode = normalize_mode.eq_ignore_ascii_case("responses");

    for entry in input.input {
        let Some(entry_obj) = entry.as_object() else {
            continue;
        };
        let entry_type = entry_obj
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message")
            .trim()
            .to_ascii_lowercase();
        let entry_reasoning_segments = to_reasoning_segments(entry_obj.get("reasoning_content"));
        let mut entry_reasoning_consumed = false;
        let mut consume_entry_reasoning = || -> Option<Vec<String>> {
            if entry_reasoning_consumed || entry_reasoning_segments.is_empty() {
                return None;
            }
            entry_reasoning_consumed = true;
            Some(entry_reasoning_segments.clone())
        };

        if let Some(Value::String(content)) = entry_obj.get("content") {
            let tool_calls = entry_obj
                .get("tool_calls")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !tool_calls.is_empty() {
                let mut normalized_calls: Vec<Value> = Vec::new();
                for (idx, call) in tool_calls.into_iter().enumerate() {
                    let Value::Object(mut call_obj) = call else {
                        continue;
                    };
                    let func = call_obj.get_mut("function").and_then(Value::as_object_mut);
                    let Some(func_obj) = func else {
                        continue;
                    };
                    let raw_name = func_obj.get("name").and_then(Value::as_str);
                    let Some(name) =
                        normalize_function_name_by_mode(raw_name, normalize_mode.as_str())
                    else {
                        continue;
                    };
                    let args_val = func_obj.get("arguments").cloned().unwrap_or(Value::Null);
                    let serialized = serialize_tool_arguments(Some(&args_val)).trim().to_string();
                    func_obj.insert("name".to_string(), Value::String(name.clone()));
                    func_obj.insert("arguments".to_string(), Value::String(serialized));
                    let fallback_id = format!("fc_call_{}", messages.len() + idx + 1);
                    let call_id =
                        ensure_assistant_tool_call_identity(&mut call_obj, fallback_id.as_str());
                    tool_name_by_id.insert(call_id.clone(), name);
                    last_tool_call_id = Some(call_id);
                    normalized_calls.push(Value::Object(call_obj));
                }
                if !normalized_calls.is_empty() {
                    let role = coerce_bridge_role(entry_obj.get("role").and_then(Value::as_str));
                    let mut message = Map::new();
                    message.insert("role".to_string(), Value::String(role.clone()));
                    message.insert("content".to_string(), Value::String(content.clone()));
                    message.insert("tool_calls".to_string(), Value::Array(normalized_calls));
                    if let Some(reasoning) = consume_entry_reasoning() {
                        message.insert(
                            "reasoning_content".to_string(),
                            Value::String(reasoning.join("\n")),
                        );
                    }
                    messages.push(Value::Object(message));
                    continue;
                }
            }

            let role = coerce_bridge_role(entry_obj.get("role").and_then(Value::as_str));
            if is_responses_mode {
                push_chat_message_without_reparse(
                    &mut messages,
                    role.as_str(),
                    Some(content),
                    consume_entry_reasoning(),
                );
            } else {
                push_normalized_chat_message(
                    &mut messages,
                    role.as_str(),
                    Some(content),
                    consume_entry_reasoning(),
                );
            }
            continue;
        }

        if entry_type == "function_call" || entry_type == "tool_call" {
            let raw_name = entry_obj.get("name").and_then(Value::as_str).or_else(|| {
                entry_obj
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|row| row.get("name").and_then(Value::as_str))
            });
            let Some(name) = normalize_function_name_by_mode(raw_name, normalize_mode.as_str())
            else {
                continue;
            };
            let args = entry_obj
                .get("arguments")
                .or_else(|| {
                    entry_obj
                        .get("function")
                        .and_then(Value::as_object)
                        .and_then(|row| row.get("arguments"))
                })
                .unwrap_or(&Value::Null);
            let raw_item_id = read_trimmed_string(entry_obj.get("id"));
            let raw_call_id = read_trimmed_string(entry_obj.get("call_id"))
                .or_else(|| read_trimmed_string(entry_obj.get("tool_call_id")));
            let call_id_source = if normalize_mode.eq_ignore_ascii_case("responses") {
                raw_call_id.clone().or(raw_item_id.clone())
            } else {
                raw_item_id.clone().or(raw_call_id.clone())
            };
            let call_id = call_id_source.unwrap_or_else(|| {
                normalize_function_call_id(None, format!("fc_call_{}", messages.len() + 1).as_str())
            });
            let serialized = serialize_tool_arguments(Some(args)).trim().to_string();
            tool_name_by_id.insert(call_id.clone(), name.clone());
            let mut fn_row = Map::new();
            fn_row.insert("name".to_string(), Value::String(name));
            fn_row.insert("arguments".to_string(), Value::String(serialized));
            let mut call_obj = Map::new();
            call_obj.insert("id".to_string(), Value::String(call_id.clone()));
            call_obj.insert("call_id".to_string(), Value::String(call_id.clone()));
            call_obj.insert("tool_call_id".to_string(), Value::String(call_id.clone()));
            call_obj.insert("type".to_string(), Value::String("function".to_string()));
            call_obj.insert("function".to_string(), Value::Object(fn_row));
            let mut message = Map::new();
            message.insert("role".to_string(), Value::String("assistant".to_string()));
            message.insert("content".to_string(), Value::String(String::new()));
            message.insert(
                "tool_calls".to_string(),
                Value::Array(vec![Value::Object(call_obj)]),
            );
            messages.push(Value::Object(message));
            last_tool_call_id = Some(call_id);
            continue;
        }

        if matches!(
            entry_type.as_str(),
            "function_call_output" | "tool_result" | "tool_message"
        ) {
            let tool_call_id = read_trimmed_string(entry_obj.get("tool_call_id"))
                .or_else(|| read_trimmed_string(entry_obj.get("call_id")))
                .or_else(|| read_trimmed_string(entry_obj.get("tool_use_id")))
                .or_else(|| read_trimmed_string(entry_obj.get("id")))
                .or_else(|| last_tool_call_id.clone());
            if let Some(id) = tool_call_id.clone() {
                let output = serialize_tool_output(entry_obj);
                let mut content = output.unwrap_or_default();
                if content.trim().is_empty() {
                    content = fallback_text.clone();
                }
                let mut tool_msg = Map::new();
                tool_msg.insert("role".to_string(), Value::String("tool".to_string()));
                tool_msg.insert("tool_call_id".to_string(), Value::String(id.clone()));
                tool_msg.insert("id".to_string(), Value::String(id.clone()));
                tool_msg.insert("content".to_string(), Value::String(content));
                if let Some(name) = tool_name_by_id.get(&id) {
                    if !name.trim().is_empty() {
                        tool_msg.insert("name".to_string(), Value::String(name.clone()));
                    }
                }
                messages.push(Value::Object(tool_msg));
                last_tool_call_id = None;
            }
            continue;
        }

        let mut handled_via_explicit_message = false;
        if let Some(Value::Object(explicit)) = entry_obj.get("message") {
            if let Some(Value::Array(content)) = explicit.get("content") {
                let nested = process_message_blocks(
                    &Value::Array(content.clone()),
                    normalize_mode.as_str(),
                    &mut tool_name_by_id,
                    last_tool_call_id.clone(),
                    fallback_text.as_str(),
                );
                if !nested.tool_calls.is_empty() {
                    let mut normalized_calls: Vec<Value> = Vec::new();
                    for (idx, call) in nested.tool_calls.into_iter().enumerate() {
                        if let Value::Object(mut call_obj) = call {
                            let fallback_id = format!("fc_call_{}", messages.len() + idx + 1);
                            ensure_assistant_tool_call_identity(
                                &mut call_obj,
                                fallback_id.as_str(),
                            );
                            normalized_calls.push(Value::Object(call_obj));
                        }
                    }
                    if !normalized_calls.is_empty() {
                        let mut msg = Map::new();
                        msg.insert("role".to_string(), Value::String("assistant".to_string()));
                        msg.insert("content".to_string(), Value::String(String::new()));
                        msg.insert("tool_calls".to_string(), Value::Array(normalized_calls));
                        messages.push(Value::Object(msg));
                    }
                }
                for msg in nested.tool_messages {
                    messages.push(msg);
                }
                let role_raw = explicit
                    .get("role")
                    .and_then(Value::as_str)
                    .or_else(|| entry_obj.get("role").and_then(Value::as_str));
                let normalized_role = coerce_bridge_role(role_raw);
                if !nested.media_blocks.is_empty() {
                    let content_blocks: Vec<Value> = if !nested.ordered_content_blocks.is_empty() {
                        nested.ordered_content_blocks.clone()
                    } else {
                        let mut fallback_blocks: Vec<Value> = Vec::new();
                        if let Some(text) = nested.text.clone() {
                            if !text.trim().is_empty() {
                                fallback_blocks
                                    .push(serde_json::json!({"type": "text", "text": text}));
                            }
                        }
                        for media in nested.media_blocks {
                            if media.kind == "video" {
                                let mut block = serde_json::json!({"type": "video_url", "video_url": {"url": media.url}});
                                if let Some(detail) = media.detail {
                                    if let Some(obj) = block.as_object_mut() {
                                        if let Some(Value::Object(row)) = obj.get_mut("video_url") {
                                            row.insert("detail".to_string(), Value::String(detail));
                                        }
                                    }
                                }
                                fallback_blocks.push(block);
                            } else {
                                let mut block = serde_json::json!({"type": "image_url", "image_url": {"url": media.url}});
                                if let Some(detail) = media.detail {
                                    if let Some(obj) = block.as_object_mut() {
                                        if let Some(Value::Object(row)) = obj.get_mut("image_url") {
                                            row.insert("detail".to_string(), Value::String(detail));
                                        }
                                    }
                                }
                                fallback_blocks.push(block);
                            }
                        }
                        fallback_blocks
                    };
                    let mut msg = Map::new();
                    msg.insert("role".to_string(), Value::String(normalized_role.clone()));
                    msg.insert("content".to_string(), Value::Array(content_blocks));
                    let combined = combine_reasoning_segments(
                        consume_entry_reasoning().unwrap_or_default().as_slice(),
                        nested.reasoning_segments.as_slice(),
                    );
                    if !combined.is_empty() {
                        msg.insert(
                            "reasoning_content".to_string(),
                            Value::String(combined.join("\n")),
                        );
                    }
                    messages.push(Value::Object(msg));
                } else if let Some(text) = nested.text.clone() {
                    let combined = combine_reasoning_segments(
                        consume_entry_reasoning().unwrap_or_default().as_slice(),
                        nested.reasoning_segments.as_slice(),
                    );
                    push_normalized_chat_message(
                        &mut messages,
                        normalized_role.as_str(),
                        Some(text.as_str()),
                        if combined.is_empty() {
                            None
                        } else {
                            Some(combined)
                        },
                    );
                }
                last_tool_call_id = nested.last_call_id;
                handled_via_explicit_message = true;
            }
        }

        if !handled_via_explicit_message {
            let nested = process_message_blocks(
                entry_obj.get("content").unwrap_or(&Value::Null),
                normalize_mode.as_str(),
                &mut tool_name_by_id,
                last_tool_call_id.clone(),
                fallback_text.as_str(),
            );
            if !nested.tool_calls.is_empty() {
                let mut normalized_calls: Vec<Value> = Vec::new();
                for (idx, call) in nested.tool_calls.into_iter().enumerate() {
                    if let Value::Object(mut call_obj) = call {
                        let fallback_id = format!("fc_call_{}", messages.len() + idx + 1);
                        ensure_assistant_tool_call_identity(&mut call_obj, fallback_id.as_str());
                        normalized_calls.push(Value::Object(call_obj));
                    }
                }
                if !normalized_calls.is_empty() {
                    let mut msg = Map::new();
                    msg.insert("role".to_string(), Value::String("assistant".to_string()));
                    msg.insert("content".to_string(), Value::String(String::new()));
                    msg.insert("tool_calls".to_string(), Value::Array(normalized_calls));
                    messages.push(Value::Object(msg));
                }
            }
            for msg in nested.tool_messages {
                messages.push(msg);
            }
            let normalized_role = coerce_bridge_role(entry_obj.get("role").and_then(Value::as_str));
            if !nested.media_blocks.is_empty() {
                let content_blocks: Vec<Value> = if !nested.ordered_content_blocks.is_empty() {
                    nested.ordered_content_blocks.clone()
                } else {
                    let mut fallback_blocks: Vec<Value> = Vec::new();
                    if let Some(text) = nested.text.clone() {
                        if !text.trim().is_empty() {
                            fallback_blocks.push(serde_json::json!({"type": "text", "text": text}));
                        }
                    }
                    for media in nested.media_blocks {
                        if media.kind == "video" {
                            let mut block = serde_json::json!({"type": "video_url", "video_url": {"url": media.url}});
                            if let Some(detail) = media.detail {
                                if let Some(obj) = block.as_object_mut() {
                                    if let Some(Value::Object(row)) = obj.get_mut("video_url") {
                                        row.insert("detail".to_string(), Value::String(detail));
                                    }
                                }
                            }
                            fallback_blocks.push(block);
                        } else {
                            let mut block = serde_json::json!({"type": "image_url", "image_url": {"url": media.url}});
                            if let Some(detail) = media.detail {
                                if let Some(obj) = block.as_object_mut() {
                                    if let Some(Value::Object(row)) = obj.get_mut("image_url") {
                                        row.insert("detail".to_string(), Value::String(detail));
                                    }
                                }
                            }
                            fallback_blocks.push(block);
                        }
                    }
                    fallback_blocks
                };
                let mut msg = Map::new();
                msg.insert("role".to_string(), Value::String(normalized_role.clone()));
                msg.insert("content".to_string(), Value::Array(content_blocks));
                let combined = combine_reasoning_segments(
                    consume_entry_reasoning().unwrap_or_default().as_slice(),
                    nested.reasoning_segments.as_slice(),
                );
                if !combined.is_empty() {
                    msg.insert(
                        "reasoning_content".to_string(),
                        Value::String(combined.join("\n")),
                    );
                }
                messages.push(Value::Object(msg));
            } else if let Some(text) = nested.text.clone() {
                if is_responses_mode {
                    push_chat_message_without_reparse(
                        &mut messages,
                        normalized_role.as_str(),
                        Some(text.as_str()),
                        consume_entry_reasoning(),
                    );
                } else {
                    push_normalized_chat_message(
                        &mut messages,
                        normalized_role.as_str(),
                        Some(text.as_str()),
                        consume_entry_reasoning(),
                    );
                }
            }
            last_tool_call_id = nested.last_call_id;
        }

        let t = entry_obj
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if matches!(
            t.as_str(),
            "input_text" | "text" | "output_text" | "commentary"
        ) {
            if let Some(Value::String(text)) = entry_obj.get("text") {
                let normalized_role =
                    coerce_bridge_role(entry_obj.get("role").and_then(Value::as_str));
                if !text.is_empty() {
                    if is_responses_mode {
                        push_chat_message_without_reparse(
                            &mut messages,
                            normalized_role.as_str(),
                            Some(text),
                            consume_entry_reasoning(),
                        );
                    } else {
                        push_normalized_chat_message(
                            &mut messages,
                            normalized_role.as_str(),
                            Some(text),
                            consume_entry_reasoning(),
                        );
                    }
                }
            }
        }
    }

    BridgeInputToChatOutput { messages }
}

pub(crate) fn extract_reasoning_segments_from_text(
    input: ExtractReasoningSegmentsInput,
) -> ExtractReasoningSegmentsOutput {
    let mut segments: Vec<String> = Vec::new();
    let text = extract_reasoning_segments(input.source.as_str(), Some(&mut segments));
    ExtractReasoningSegmentsOutput { text, segments }
}

pub(crate) fn validate_tool_arguments(
    input: ValidateToolArgumentsInput,
) -> ValidateToolArgumentsOutput {
    let repaired = repair_arguments_to_string(&input.args);
    match serde_json::from_str::<Value>(&repaired) {
        Ok(_) => ValidateToolArgumentsOutput {
            repaired,
            success: true,
            error: None,
        },
        Err(err) => ValidateToolArgumentsOutput {
            repaired,
            success: false,
            error: Some(err.to_string()),
        },
    }
}

pub(crate) fn repair_tool_calls(input: Vec<RepairToolCallInput>) -> Vec<Value> {
    input
        .into_iter()
        .map(|entry| {
            let repaired =
                repair_arguments_to_string(entry.arguments.as_ref().unwrap_or(&Value::Null));
            serde_json::json!({
                "name": entry.name,
                "arguments": repaired
            })
        })
        .collect()
}
