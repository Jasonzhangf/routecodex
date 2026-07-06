use serde_json::{Map, Value};
use std::collections::{HashMap, VecDeque};

use crate::hub_reasoning_tool_normalizer::normalize_assistant_text_to_tool_calls_json;
use crate::hub_resp_outbound_client_semantics::normalize_responses_function_name;
use crate::shared_chat_output_normalizer::normalize_chat_message_content;
use crate::shared_json_utils::read_trimmed_string;
use crate::shared_tooling::{
    normalize_tool_result_value, parse_lenient_string, repair_arguments_to_string,
};

use super::history::can_allow_terminal_pending_tool_calls;
use super::reasoning::{
    combine_reasoning_segments, extract_reasoning_segments, to_reasoning_segments,
};
use super::types::{
    BridgeInputToChatInput, BridgeInputToChatOutput, ExtractReasoningSegmentsInput,
    ExtractReasoningSegmentsOutput, RepairToolCallInput, ValidateToolArgumentsInput,
    ValidateToolArgumentsOutput,
};
use super::utils::{
    coerce_bridge_role, is_stopless_cli_result_content, is_synthetic_routecodex_control_content,
    is_synthetic_routecodex_tool_call_id, MediaBlock,
};

#[derive(Clone)]
struct DeferredToolResult {
    call_id: String,
    message: Value,
}

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
    let combined: Vec<String> = reasoning_segments
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

fn require_explicit_tool_call_id(call_id: Option<String>, reason: &str) -> Result<String, String> {
    let resolved = call_id.ok_or_else(|| reason.to_string())?;
    if is_synthetic_routecodex_tool_call_id(resolved.as_str()) {
        return Err(format!(
            "synthetic_tool_call_id: RouteCodex synthetic fallback tool_call id is forbidden: {}",
            resolved
        ));
    }
    Ok(resolved)
}

fn register_pending_tool_call(pending_tool_call_ids: &mut VecDeque<String>, call_id: &str) {
    if !pending_tool_call_ids.iter().any(|entry| entry == call_id) {
        pending_tool_call_ids.push_back(call_id.to_string());
    }
}

fn increment_call_count(counts: &mut HashMap<String, usize>, call_id: &str) {
    let next = counts.get(call_id).copied().unwrap_or(0) + 1;
    counts.insert(call_id.to_string(), next);
}

fn decrement_call_count(counts: &mut HashMap<String, usize>, call_id: &str) {
    let next = counts.get(call_id).copied().unwrap_or(0);
    if next <= 1 {
        counts.remove(call_id);
    } else {
        counts.insert(call_id.to_string(), next - 1);
    }
}

fn consume_pending_tool_call(
    pending_tool_call_ids: &mut VecDeque<String>,
    call_id: &str,
    reason: &str,
) -> Result<(), String> {
    let Some(position) = pending_tool_call_ids
        .iter()
        .position(|entry| entry == call_id)
    else {
        return Err(format!("orphan_tool_result: {}: {}", reason, call_id));
    };
    pending_tool_call_ids.remove(position);
    Ok(())
}

fn should_probe_assistant_tool_markup(content: &str) -> bool {
    let lowered = content.to_ascii_lowercase();
    lowered.contains("<tool_call")
        || lowered.contains("<parameter")
        || lowered.contains("<arg_key>")
        || lowered.contains("<arg_value>")
        || lowered.contains("<function=")
        || lowered.contains("</command>")
        || lowered.contains("```tool_call")
        || lowered.contains("\"tool_calls\"")
        || lowered.contains("tool_calls:[")
}

fn harvest_assistant_tool_message_from_text(
    raw_content: &str,
    reasoning_segments: &[String],
) -> Option<Map<String, Value>> {
    if raw_content.trim().is_empty() || !should_probe_assistant_tool_markup(raw_content) {
        return None;
    }

    let mut seed = Map::new();
    seed.insert("role".to_string(), Value::String("assistant".to_string()));
    seed.insert(
        "content".to_string(),
        Value::String(raw_content.to_string()),
    );
    let reasoning = reasoning_segments
        .iter()
        .filter(|entry| !entry.trim().is_empty())
        .cloned()
        .collect::<Vec<String>>();
    if !reasoning.is_empty() {
        seed.insert(
            "reasoning_content".to_string(),
            Value::String(reasoning.join("\n")),
        );
    }

    let normalized_raw =
        normalize_assistant_text_to_tool_calls_json(Value::Object(seed).to_string(), None).ok()?;
    let normalized: Value = serde_json::from_str(&normalized_raw).ok()?;
    let mut message = normalized.as_object().cloned()?;
    let has_tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|arr| !arr.is_empty())
        .unwrap_or(false);
    if !has_tool_calls {
        return None;
    }
    message.insert("role".to_string(), Value::String("assistant".to_string()));
    if !message.contains_key("content") {
        message.insert("content".to_string(), Value::String(String::new()));
    }
    Some(message)
}

fn append_harvested_assistant_tool_message(
    messages: &mut Vec<Value>,
    tool_name_by_id: &mut HashMap<String, String>,
    pending_tool_call_ids: &mut VecDeque<String>,
    raw_content: &str,
    reasoning_segments: &[String],
) -> Result<bool, String> {
    let Some(mut harvested) =
        harvest_assistant_tool_message_from_text(raw_content, reasoning_segments)
    else {
        return Ok(false);
    };
    if let Some(tool_calls) = harvested
        .get_mut("tool_calls")
        .and_then(Value::as_array_mut)
    {
        for call in tool_calls.iter_mut() {
            let Value::Object(call_obj) = call else {
                continue;
            };
            let call_id = require_explicit_tool_call_id(
                read_trimmed_string(call_obj.get("call_id"))
                    .or_else(|| read_trimmed_string(call_obj.get("tool_call_id")))
                    .or_else(|| read_trimmed_string(call_obj.get("id"))),
                "missing_tool_call_id: harvested assistant tool_call is missing id/call_id",
            )?;
            call_obj.insert("id".to_string(), Value::String(call_id.clone()));
            call_obj.insert("tool_call_id".to_string(), Value::String(call_id.clone()));
            call_obj.insert("call_id".to_string(), Value::String(call_id.clone()));
            if let Some(name) = call_obj
                .get("function")
                .and_then(Value::as_object)
                .and_then(|fn_obj| fn_obj.get("name"))
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            {
                tool_name_by_id.insert(call_id.clone(), name);
            }
            register_pending_tool_call(pending_tool_call_ids, call_id.as_str());
        }
    }
    messages.push(Value::Object(harvested));
    Ok(true)
}

fn serialize_tool_output(entry: &Map<String, Value>) -> Option<String> {
    let out = entry.get("output")?;
    match out {
        Value::String(text) => Some(text.clone()),
        Value::Object(_) | Value::Array(_) => Some(normalize_tool_result_value(out)),
        _ => Some(normalize_tool_result_value(out)),
    }
}

fn repair_bridge_tool_arguments(
    entry_type: &str,
    entry: &Map<String, Value>,
    args: &Value,
) -> String {
    if entry_type == "custom_tool_call" {
        let input = entry.get("input").cloned().unwrap_or(Value::Null);
        if read_trimmed_string(entry.get("name")).as_deref() == Some("apply_patch") {
            return input
                .as_str()
                .map(ToString::to_string)
                .unwrap_or_else(|| normalize_tool_result_value(&input));
        }
        return serde_json::to_string(&serde_json::json!({ "input": input }))
            .unwrap_or_else(|_| "{}".to_string());
    }
    repair_arguments_to_string(args).trim().to_string()
}

struct ProcessBlocksResult {
    text: Option<String>,
    media_blocks: Vec<MediaBlock>,
    ordered_content_blocks: Vec<Value>,
    tool_calls: Vec<Value>,
    tool_messages: Vec<Value>,
    reasoning_segments: Vec<String>,
}

fn process_message_blocks(
    blocks: &Value,
    normalize_mode: &str,
    tool_name_by_id: &mut HashMap<String, String>,
    pending_tool_call_ids: &mut VecDeque<String>,
    tool_result_fallback_text: &str,
) -> Result<ProcessBlocksResult, String> {
    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut tool_messages: Vec<Value> = Vec::new();
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
        if matches!(
            block_type.as_str(),
            "reasoning_text" | "thinking" | "reasoning"
        ) {
            // Extract from primary block-level text field (one source per block to avoid duplicates)
            if let Some(text) = block_obj.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    reasoning_segments.push(trimmed.to_string());
                }
            } else if let Some(text) = block_obj.get("thinking").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    reasoning_segments.push(trimmed.to_string());
                }
            } else if let Some(text) = block_obj.get("content").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    reasoning_segments.push(trimmed.to_string());
                }
            }
            // Only extend from reasoning_content if NO block-level text was found (avoid duplicates)
            let has_block_text = block_obj
                .get("text")
                .and_then(Value::as_str)
                .map(|t| !t.trim().is_empty())
                .unwrap_or(false)
                || block_obj
                    .get("thinking")
                    .and_then(Value::as_str)
                    .map(|t| !t.trim().is_empty())
                    .unwrap_or(false)
                || block_obj
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|t| !t.trim().is_empty())
                    .unwrap_or(false);
            if !has_block_text {
                reasoning_segments
                    .extend(to_reasoning_segments(block_obj.get("reasoning_content")));
            }
            continue;
        }
        if block_type == "message" {
            if let Some(content) = block_obj.get("content") {
                if content.is_array() {
                    let nested = process_message_blocks(
                        content,
                        normalize_mode,
                        tool_name_by_id,
                        pending_tool_call_ids,
                        tool_result_fallback_text,
                    )?;
                    if let Some(text) = nested.text {
                        if !text.is_empty() {
                            text_parts.push(text);
                        }
                    }
                    tool_calls.extend(nested.tool_calls);
                    tool_messages.extend(nested.tool_messages);
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
        if block_type == "function_call" || block_type == "custom_tool_call" {
            let raw_name = block_obj.get("name").and_then(Value::as_str).or_else(|| {
                block_obj
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|row| row.get("name").and_then(Value::as_str))
            });
            let Some(name) = normalize_function_name_by_mode(raw_name, normalize_mode) else {
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
                .or_else(|| read_trimmed_string(block_obj.get("tool_call_id")))
                .or_else(|| read_trimmed_string(block_obj.get("id")));
            let call_id = require_explicit_tool_call_id(
                call_id_candidate,
                "missing_tool_call_id: bridge function_call block is missing call_id/id",
            )?;
            let serialized = repair_bridge_tool_arguments(block_type.as_str(), block_obj, args);
            tool_name_by_id.insert(call_id.clone(), name.clone());
            register_pending_tool_call(pending_tool_call_ids, call_id.as_str());
            let mut fn_row = Map::new();
            fn_row.insert("name".to_string(), Value::String(name));
            fn_row.insert("arguments".to_string(), Value::String(serialized));
            let mut call_obj = Map::new();
            call_obj.insert("id".to_string(), Value::String(call_id.clone()));
            call_obj.insert("call_id".to_string(), Value::String(call_id.clone()));
            call_obj.insert("type".to_string(), Value::String("function".to_string()));
            call_obj.insert("function".to_string(), Value::Object(fn_row));
            tool_calls.push(Value::Object(call_obj));
            continue;
        }
        if matches!(
            block_type.as_str(),
            "function_call_output" | "custom_tool_call_output" | "tool_result" | "tool_message"
        ) {
            let tool_call_id = require_explicit_tool_call_id(
                read_trimmed_string(block_obj.get("tool_call_id"))
                    .or_else(|| read_trimmed_string(block_obj.get("call_id")))
                    .or_else(|| read_trimmed_string(block_obj.get("tool_use_id")))
                    .or_else(|| read_trimmed_string(block_obj.get("id"))),
                "missing_tool_call_id: bridge tool_result block is missing call_id/tool_call_id",
            )?;
            consume_pending_tool_call(
                pending_tool_call_ids,
                tool_call_id.as_str(),
                "bridge tool_result block references unknown or already-consumed call_id",
            )?;
            let output = serialize_tool_output(block_obj);
            let content = output.unwrap_or_default();
            let mut tool_msg = Map::new();
            tool_msg.insert("role".to_string(), Value::String("tool".to_string()));
            tool_msg.insert(
                "tool_call_id".to_string(),
                Value::String(tool_call_id.clone()),
            );
            tool_msg.insert("content".to_string(), Value::String(content));
            if let Some(name) = tool_name_by_id.get(&tool_call_id) {
                if !name.trim().is_empty() {
                    tool_msg.insert("name".to_string(), Value::String(name.clone()));
                }
            }
            tool_messages.push(Value::Object(tool_msg));
            continue;
        }
    }

    let text = if text_parts.is_empty() {
        None
    } else {
        Some(text_parts.join("\n").trim().to_string())
    };
    Ok(ProcessBlocksResult {
        text,
        media_blocks,
        ordered_content_blocks,
        tool_calls,
        tool_messages,
        reasoning_segments,
    })
}

pub(crate) fn convert_bridge_input_to_chat_messages(
    input: BridgeInputToChatInput,
) -> Result<BridgeInputToChatOutput, String> {
    let mut messages: Vec<Value> = Vec::new();
    if input.input.is_empty() {
        return Ok(BridgeInputToChatOutput { messages });
    }
    let mut tool_name_by_id: HashMap<String, String> = HashMap::new();
    let mut pending_tool_call_ids: VecDeque<String> = VecDeque::new();
    let mut pending_tool_call_message_index: HashMap<String, usize> = HashMap::new();
    let mut non_system_message_indices: Vec<usize> = Vec::new();
    let mut future_tool_call_counts: HashMap<String, usize> = HashMap::new();
    let mut deferred_tool_results: HashMap<String, VecDeque<DeferredToolResult>> = HashMap::new();
    let allow_pending_terminal_tool_call = input.allow_pending_terminal_tool_call.unwrap_or(false);
    let allow_orphan_tool_result = input.allow_orphan_tool_result.unwrap_or(false);
    let fallback_text = input.tool_result_fallback_text.unwrap_or_default();
    let normalize_mode = input
        .normalize_function_name
        .unwrap_or_else(|| "default".to_string());
    let is_responses_mode = normalize_mode.eq_ignore_ascii_case("responses");

    for entry in input.input.iter() {
        let Some(entry_obj) = entry.as_object() else {
            continue;
        };
        let entry_type = entry_obj
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message")
            .trim()
            .to_ascii_lowercase();
        if let Some(Value::String(content)) = entry_obj.get("content") {
            let _ = content;
            let tool_calls = entry_obj
                .get("tool_calls")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !tool_calls.is_empty() {
                for call in tool_calls {
                    let Value::Object(call_obj) = call else {
                        continue;
                    };
                    if let Some(call_id) = read_trimmed_string(call_obj.get("call_id"))
                        .or_else(|| read_trimmed_string(call_obj.get("tool_call_id")))
                        .or_else(|| read_trimmed_string(call_obj.get("id")))
                    {
                        increment_call_count(&mut future_tool_call_counts, call_id.as_str());
                    }
                }
            }
        }
        if entry_type == "function_call"
            || entry_type == "tool_call"
            || entry_type == "custom_tool_call"
        {
            if let Some(call_id) = read_trimmed_string(entry_obj.get("call_id"))
                .or_else(|| read_trimmed_string(entry_obj.get("tool_call_id")))
                .or_else(|| read_trimmed_string(entry_obj.get("id")))
            {
                increment_call_count(&mut future_tool_call_counts, call_id.as_str());
            }
        }
    }

    for (entry_index, entry) in input.input.into_iter().enumerate() {
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
        let role_hint = entry_obj
            .get("role")
            .and_then(Value::as_str)
            .map(|role| coerce_bridge_role(Some(role)))
            .unwrap_or_else(|| "user".to_string());
        let original_content = entry_obj.get("content").cloned().unwrap_or(Value::Null);
        if role_hint == "user" && is_stopless_cli_result_content(&original_content) {
            continue;
        }
        if role_hint != "system" {
            non_system_message_indices.push(entry_index);
        }

        if let Some(Value::String(content)) = entry_obj.get("content") {
            let tool_calls = entry_obj
                .get("tool_calls")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !tool_calls.is_empty() {
                let mut normalized_calls: Vec<Value> = Vec::new();
                for call in tool_calls {
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
                    let serialized = repair_arguments_to_string(&args_val).trim().to_string();
                    func_obj.insert("name".to_string(), Value::String(name.clone()));
                    func_obj.insert("arguments".to_string(), Value::String(serialized));
                    let call_id = require_explicit_tool_call_id(
                        read_trimmed_string(call_obj.get("call_id"))
                            .or_else(|| read_trimmed_string(call_obj.get("tool_call_id")))
                            .or_else(|| read_trimmed_string(call_obj.get("id"))),
                        "missing_tool_call_id: assistant tool_call is missing id/call_id",
                    )?;
                    decrement_call_count(&mut future_tool_call_counts, call_id.as_str());
                    call_obj.insert("id".to_string(), Value::String(call_id.clone()));
                    call_obj.insert("tool_call_id".to_string(), Value::String(call_id.clone()));
                    call_obj.insert("call_id".to_string(), Value::String(call_id.clone()));
                    tool_name_by_id.insert(call_id.clone(), name);
                    register_pending_tool_call(&mut pending_tool_call_ids, call_id.as_str());
                    pending_tool_call_message_index.insert(call_id.clone(), entry_index);
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
            if role == "assistant"
                && !entry_obj
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .map(|items| !items.is_empty())
                    .unwrap_or(false)
                && is_synthetic_routecodex_control_content(&Value::String(content.clone()))
            {
                return Err(format!(
                    "synthetic_local_control_text: bridge input contains synthetic RouteCodex local control text at index {}",
                    entry_index
                ));
            }
            if role == "assistant" {
                if append_harvested_assistant_tool_message(
                    &mut messages,
                    &mut tool_name_by_id,
                    &mut pending_tool_call_ids,
                    content,
                    entry_reasoning_segments.as_slice(),
                )? {
                    continue;
                }
            }

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

        if entry_type == "function_call"
            || entry_type == "tool_call"
            || entry_type == "custom_tool_call"
        {
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
            let call_id = require_explicit_tool_call_id(
                call_id_source,
                "missing_tool_call_id: bridge function_call item is missing call_id/id",
            )?;
            decrement_call_count(&mut future_tool_call_counts, call_id.as_str());
            let serialized = repair_bridge_tool_arguments(entry_type.as_str(), entry_obj, args);
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
            if let Some(reasoning) = consume_entry_reasoning() {
                message.insert(
                    "reasoning_content".to_string(),
                    Value::String(reasoning.join("\n")),
                );
            }
            messages.push(Value::Object(message));
            register_pending_tool_call(&mut pending_tool_call_ids, call_id.as_str());
            pending_tool_call_message_index.insert(call_id.clone(), entry_index);
            if let Some(queue) = deferred_tool_results.get_mut(&call_id) {
                if let Some(deferred) = queue.pop_front() {
                    consume_pending_tool_call(
                        &mut pending_tool_call_ids,
                        call_id.as_str(),
                        "bridge tool_result item references unknown or already-consumed call_id",
                    )?;
                    messages.push(deferred.message);
                }
                if queue.is_empty() {
                    deferred_tool_results.remove(&call_id);
                }
            }
            continue;
        }

        if matches!(
            entry_type.as_str(),
            "function_call_output" | "custom_tool_call_output" | "tool_result" | "tool_message"
        ) {
            let tool_call_id = require_explicit_tool_call_id(
                read_trimmed_string(entry_obj.get("tool_call_id"))
                    .or_else(|| read_trimmed_string(entry_obj.get("call_id")))
                    .or_else(|| read_trimmed_string(entry_obj.get("tool_use_id")))
                    .or_else(|| read_trimmed_string(entry_obj.get("id"))),
                "missing_tool_call_id: bridge tool_result item is missing call_id/tool_call_id",
            )?;
            let output = serialize_tool_output(entry_obj);
            let mut content = output.unwrap_or_default();
            if content.trim().is_empty() {
                content = fallback_text.clone();
            }
            let mut tool_msg = Map::new();
            tool_msg.insert("role".to_string(), Value::String("tool".to_string()));
            tool_msg.insert(
                "tool_call_id".to_string(),
                Value::String(tool_call_id.clone()),
            );
            tool_msg.insert("id".to_string(), Value::String(tool_call_id.clone()));
            tool_msg.insert("content".to_string(), Value::String(content));
            if let Some(name) = tool_name_by_id.get(&tool_call_id) {
                if !name.trim().is_empty() {
                    tool_msg.insert("name".to_string(), Value::String(name.clone()));
                }
            }
            if pending_tool_call_ids
                .iter()
                .any(|entry| entry == &tool_call_id)
            {
                consume_pending_tool_call(
                    &mut pending_tool_call_ids,
                    tool_call_id.as_str(),
                    "bridge tool_result item references unknown or already-consumed call_id",
                )?;
                messages.push(Value::Object(tool_msg));
                continue;
            }
            if future_tool_call_counts
                .get(&tool_call_id)
                .copied()
                .unwrap_or(0)
                > 0
            {
                deferred_tool_results
                    .entry(tool_call_id.clone())
                    .or_insert_with(VecDeque::new)
                    .push_back(DeferredToolResult {
                        call_id: tool_call_id.clone(),
                        message: Value::Object(tool_msg),
                    });
                continue;
            }
            if allow_orphan_tool_result {
                messages.push(Value::Object(tool_msg));
                continue;
            }
            return Err(format!(
                "orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id: {}",
                tool_call_id
            ));
        }

        let mut handled_via_explicit_message = false;
        if let Some(Value::Object(explicit)) = entry_obj.get("message") {
            if let Some(Value::Array(content)) = explicit.get("content") {
                let nested = process_message_blocks(
                    &Value::Array(content.clone()),
                    normalize_mode.as_str(),
                    &mut tool_name_by_id,
                    &mut pending_tool_call_ids,
                    fallback_text.as_str(),
                )?;
                if !nested.tool_calls.is_empty() {
                    let normalized_calls: Vec<Value> = nested.tool_calls.into_iter().collect();
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
                    if normalized_role == "assistant"
                        && append_harvested_assistant_tool_message(
                            &mut messages,
                            &mut tool_name_by_id,
                            &mut pending_tool_call_ids,
                            text.as_str(),
                            combined.as_slice(),
                        )?
                    {
                        continue;
                    }
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
                } else if is_responses_mode && normalized_role == "assistant" {
                    let combined = combine_reasoning_segments(
                        consume_entry_reasoning().unwrap_or_default().as_slice(),
                        nested.reasoning_segments.as_slice(),
                    );
                    if !combined.is_empty() {
                        push_chat_message_without_reparse(
                            &mut messages,
                            normalized_role.as_str(),
                            Some(""),
                            Some(combined),
                        );
                    }
                }
                handled_via_explicit_message = true;
            }
        }

        if !handled_via_explicit_message {
            let nested = process_message_blocks(
                entry_obj.get("content").unwrap_or(&Value::Null),
                normalize_mode.as_str(),
                &mut tool_name_by_id,
                &mut pending_tool_call_ids,
                fallback_text.as_str(),
            )?;
            if !nested.tool_calls.is_empty() {
                let normalized_calls: Vec<Value> = nested.tool_calls.into_iter().collect();
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
                let combined = combine_reasoning_segments(
                    consume_entry_reasoning().unwrap_or_default().as_slice(),
                    nested.reasoning_segments.as_slice(),
                );
                if normalized_role == "assistant"
                    && append_harvested_assistant_tool_message(
                        &mut messages,
                        &mut tool_name_by_id,
                        &mut pending_tool_call_ids,
                        text.as_str(),
                        combined.as_slice(),
                    )?
                {
                    continue;
                }
                if is_responses_mode {
                    push_chat_message_without_reparse(
                        &mut messages,
                        normalized_role.as_str(),
                        Some(text.as_str()),
                        if combined.is_empty() {
                            None
                        } else {
                            Some(combined)
                        },
                    );
                } else {
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
            } else if is_responses_mode && normalized_role == "assistant" {
                let combined = combine_reasoning_segments(
                    consume_entry_reasoning().unwrap_or_default().as_slice(),
                    nested.reasoning_segments.as_slice(),
                );
                if !combined.is_empty() {
                    push_chat_message_without_reparse(
                        &mut messages,
                        normalized_role.as_str(),
                        Some(""),
                        Some(combined),
                    );
                }
            }
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

    if let Some(call_id) = pending_tool_call_ids.front() {
        if allow_pending_terminal_tool_call
            && can_allow_terminal_pending_tool_calls(
                &pending_tool_call_ids,
                &pending_tool_call_message_index,
                non_system_message_indices.as_slice(),
            )
        {
            return Ok(BridgeInputToChatOutput { messages });
        }
        return Err(format!(
            "dangling_tool_call: bridge tool_call {} does not have a matching tool result in history",
            call_id
        ));
    }

    if let Some(first_deferred) = deferred_tool_results
        .values()
        .find_map(|queue| queue.front().cloned())
    {
        if allow_orphan_tool_result {
            return Ok(BridgeInputToChatOutput { messages });
        }
        return Err(format!(
            "orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id: {}",
            first_deferred.call_id
        ));
    }

    Ok(BridgeInputToChatOutput { messages })
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
    let repaired = match &input.args {
        Value::String(raw) => repair_arguments_to_string(&parse_lenient_string(raw)),
        other => repair_arguments_to_string(other),
    };
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
