use serde_json::{Map, Value};
use std::collections::{HashSet, VecDeque};

use crate::hub_reasoning_tool_normalizer::clamp_responses_input_item_id_json;
use crate::hub_req_inbound_tool_output_snapshot::collect_tool_outputs;
use crate::hub_tool_session_compat::{normalize_tool_session_payload, ToolSessionCompatInput};
use crate::shared_metadata_semantics::read_runtime_metadata_json;
use crate::shared_responses_tool_utils::resolve_tool_call_id_style_json;

use super::types::{
    ApplyBridgeCaptureToolResultsInput, ApplyBridgeCaptureToolResultsOutput,
    ApplyBridgeEnsureToolPlaceholdersInput, ApplyBridgeEnsureToolPlaceholdersOutput,
    ApplyBridgeNormalizeHistoryInput, ApplyBridgeNormalizeHistoryOutput, BuildBridgeHistoryInput,
    BuildBridgeHistoryOutput, EnsureBridgeOutputFieldsInput, EnsureBridgeOutputFieldsOutput,
    FilterBridgeInputForUpstreamInput, FilterBridgeInputForUpstreamOutput,
    PrepareResponsesRequestEnvelopeInput, PrepareResponsesRequestEnvelopeOutput,
    ResolveResponsesBridgeToolsInput, ResolveResponsesBridgeToolsOutput,
    ResolveResponsesRequestBridgeDecisionsInput, ResolveResponsesRequestBridgeDecisionsOutput,
};
use super::utils::{
    coerce_bridge_role, flatten_content_to_string, normalize_function_call_id,
    normalize_function_call_output_id, read_trimmed_string, serialize_tool_arguments, MediaBlock,
};

fn content_blocks_to_bridge(value: &Value, blocks: &mut Vec<Value>, default_text_role: &str) {
    match value {
        Value::Array(entries) => {
            for entry in entries {
                content_blocks_to_bridge(entry, blocks, default_text_role);
            }
        }
        Value::Object(record) => {
            let type_value = record
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();

            if matches!(
                type_value.as_str(),
                "text" | "input_text" | "output_text" | "commentary"
            ) {
                if let Some(Value::String(text)) = record.get("text") {
                    let text_type = if type_value == "commentary" {
                        "commentary"
                    } else {
                        default_text_role
                    };
                    blocks.push(serde_json::json!({
                        "type": text_type,
                        "text": text
                    }));
                    return;
                }
            }

            if push_media_block_from_record(record, &mut Vec::new()) {
                let kind = if type_value == "video"
                    || type_value == "video_url"
                    || type_value == "input_video"
                    || record.contains_key("video_url")
                {
                    "video"
                } else {
                    "image"
                };
                let source = if kind == "video" {
                    record.get("video_url")
                } else {
                    record.get("image_url")
                };
                let mut url: Option<String> = None;
                if let Some(Value::String(value)) = source {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        url = Some(trimmed.to_string());
                    }
                } else if let Some(Value::Object(media_row)) = source {
                    if let Some(Value::String(value)) = media_row.get("url") {
                        let trimmed = value.trim();
                        if !trimmed.is_empty() {
                            url = Some(trimmed.to_string());
                        }
                    }
                }
                if let Some(url_value) = url {
                    let detail = match source {
                        Some(Value::Object(media_row)) => {
                            read_trimmed_string(media_row.get("detail"))
                        }
                        _ => read_trimmed_string(record.get("detail")),
                    };
                    let mut block = Map::new();
                    block.insert(
                        "type".to_string(),
                        Value::String(if kind == "video" {
                            "input_video".to_string()
                        } else {
                            "input_image".to_string()
                        }),
                    );
                    if kind == "video" {
                        block.insert("video_url".to_string(), Value::String(url_value));
                    } else {
                        block.insert("image_url".to_string(), Value::String(url_value));
                    }
                    if let Some(detail_value) = detail {
                        block.insert("detail".to_string(), Value::String(detail_value));
                    }
                    blocks.push(Value::Object(block));
                    return;
                }
            }

            if let Some(content) = record.get("content") {
                content_blocks_to_bridge(content, blocks, default_text_role);
            }
        }
        Value::String(text) => {
            blocks.push(serde_json::json!({ "type": default_text_role, "text": text }));
        }
        _ => {}
    }
}

fn collect_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(entries) => entries
            .iter()
            .map(collect_text)
            .collect::<Vec<String>>()
            .join(""),
        Value::Object(row) => {
            if let Some(Value::String(text)) = row.get("text") {
                return text.clone();
            }
            if let Some(content) = row.get("content") {
                return collect_text(content);
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn push_media_block_from_record(record: &Map<String, Value>, out: &mut Vec<MediaBlock>) -> bool {
    let type_value = record
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let kind = if type_value == "image"
        || type_value == "image_url"
        || type_value == "input_image"
        || record.contains_key("image_url")
    {
        Some("image")
    } else if type_value == "video"
        || type_value == "video_url"
        || type_value == "input_video"
        || record.contains_key("video_url")
    {
        Some("video")
    } else {
        None
    };
    let Some(kind_token) = kind else {
        return false;
    };

    let media_url = if kind_token == "video" {
        record.get("video_url")
    } else {
        record.get("image_url")
    };
    let mut url: Option<String> = None;
    if let Some(Value::String(value)) = media_url {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            url = Some(trimmed.to_string());
        }
    } else if let Some(Value::Object(media_row)) = media_url {
        if let Some(Value::String(value)) = media_row.get("url") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                url = Some(trimmed.to_string());
            }
        }
    }
    if url.is_none() {
        for key in ["url", "uri", "data"] {
            if let Some(Value::String(value)) = record.get(key) {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    url = Some(trimmed.to_string());
                    break;
                }
            }
        }
    }
    let Some(url_value) = url else {
        return false;
    };

    let detail = match media_url {
        Some(Value::Object(media_row)) => read_trimmed_string(media_row.get("detail")),
        _ => read_trimmed_string(record.get("detail")),
    };
    out.push(MediaBlock {
        kind: kind_token,
        url: url_value,
        detail,
    });
    true
}

fn extract_media_blocks_from_content(value: &Value, out: &mut Vec<MediaBlock>) {
    match value {
        Value::Array(entries) => {
            for entry in entries {
                extract_media_blocks_from_content(entry, out);
            }
        }
        Value::Object(record) => {
            let consumed = push_media_block_from_record(record, out);
            if consumed {
                return;
            }
            if let Some(content) = record.get("content") {
                extract_media_blocks_from_content(content, out);
            }
        }
        _ => {}
    }
}

fn extract_user_text_from_entry(entry: &Value) -> String {
    let Some(record) = entry.as_object() else {
        return String::new();
    };
    let direct_content = record.get("content").or_else(|| {
        record
            .get("message")
            .and_then(Value::as_object)
            .and_then(|m| m.get("content"))
    });
    if let Some(Value::String(content)) = direct_content {
        return content.trim().to_string();
    }
    if let Some(Value::Array(content_arr)) = direct_content {
        let mut merged = String::new();
        for block in content_arr {
            merged.push_str(&collect_text(block));
        }
        return merged.trim().to_string();
    }
    let text = record.get("text").or_else(|| {
        record
            .get("message")
            .and_then(Value::as_object)
            .and_then(|m| m.get("text"))
    });
    if let Some(Value::String(value)) = text {
        return value.trim().to_string();
    }
    String::new()
}

fn serialize_tool_result_payload(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(_) | Value::Object(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| value.to_string())
        }
        Value::Null => String::new(),
        _ => value.to_string(),
    }
}

fn strip_routing_tags_from_text(text: &str) -> String {
    text.to_string()
}

fn normalize_bridge_history_seed_text(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    Some(strip_routing_tags_from_text(text))
}

fn sanitize_bridge_history_blocks(value: &Value) -> Option<Value> {
    let blocks = value.as_array()?;
    let mut normalized: Vec<Value> = Vec::new();
    for block in blocks {
        let mut record = match block.as_object().cloned() {
            Some(record) => record,
            None => continue,
        };
        if let Some(Value::String(text)) = record.get("text") {
            record.insert(
                "text".to_string(),
                Value::String(strip_routing_tags_from_text(text)),
            );
        }
        normalized.push(Value::Object(record));
    }
    Some(Value::Array(normalized))
}

pub(crate) fn normalize_bridge_history_seed(seed: &Value) -> Option<BuildBridgeHistoryOutput> {
    let record = seed.as_object()?;
    let input = record.get("input")?.as_array()?;
    let mut normalized_input: Vec<Value> = Vec::new();
    for entry in input {
        let mut row = match entry.as_object().cloned() {
            Some(row) => row,
            None => continue,
        };
        if let Some(content) = row.get("content") {
            if let Some(blocks) = sanitize_bridge_history_blocks(content) {
                row.insert("content".to_string(), blocks);
            }
        }
        normalized_input.push(Value::Object(row));
    }

    let original_system_messages = record
        .get("originalSystemMessages")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str())
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(strip_routing_tags_from_text)
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();

    Some(BuildBridgeHistoryOutput {
        input: normalized_input,
        combined_system_instruction: normalize_bridge_history_seed_text(
            record.get("combinedSystemInstruction"),
        ),
        latest_user_instruction: normalize_bridge_history_seed_text(
            record.get("latestUserInstruction"),
        ),
        original_system_messages,
    })
}

fn normalize_tool_key(value: Option<&Value>) -> Option<String> {
    let mut text = value?.as_str()?.trim().to_ascii_lowercase();
    if text.is_empty() {
        return None;
    }
    if text == "websearch" || text == "web-search" {
        text = "web_search".to_string();
    }
    Some(text)
}

fn resolve_tool_identity(tool: &Value) -> Option<String> {
    let record = tool.as_object()?;
    let function_name = record
        .get("function")
        .and_then(Value::as_object)
        .and_then(|row| normalize_tool_key(row.get("name")));
    if function_name.is_some() {
        return function_name;
    }
    let direct_name = normalize_tool_key(record.get("name"));
    if direct_name.is_some() {
        return direct_name;
    }
    normalize_tool_key(record.get("type"))
}

fn is_builtin_web_search_tool(tool: &Value) -> bool {
    let Some(record) = tool.as_object() else {
        return false;
    };
    let type_name = normalize_tool_key(record.get("type")).unwrap_or_default();
    if type_name == "web_search" || type_name.starts_with("web_search") {
        return true;
    }
    false
}

fn is_server_side_web_search_function(tool: &Value) -> bool {
    let Some(record) = tool.as_object() else {
        return false;
    };
    resolve_tool_identity(&Value::Object(record.clone()))
        .map(|key| key == "web_search")
        .unwrap_or(false)
}

pub(crate) fn resolve_responses_bridge_tools(
    input: ResolveResponsesBridgeToolsInput,
) -> ResolveResponsesBridgeToolsOutput {
    let mut merged_tools: Vec<Value> = Vec::new();
    let mut seen_keys: HashSet<String> = HashSet::new();
    let inferred_server_side_web_search = input
        .chat_tools
        .as_ref()
        .map(|tools| tools.iter().any(is_server_side_web_search_function))
        .unwrap_or(false);
    let has_server_side_web_search = input
        .has_server_side_web_search
        .unwrap_or(inferred_server_side_web_search);
    let original_has_builtin_web_search = input
        .original_tools
        .as_ref()
        .map(|tools| tools.iter().any(is_builtin_web_search_tool))
        .unwrap_or(false);
    let original_has_non_builtin_tools = input
        .original_tools
        .as_ref()
        .map(|tools| tools.iter().any(|tool| !is_builtin_web_search_tool(tool)))
        .unwrap_or(false);

    let mut register = |tool: &Value| {
        if !tool.is_object() {
            return;
        }
        let Some(key) = resolve_tool_identity(tool) else {
            return;
        };
        if seen_keys.contains(key.as_str()) {
            return;
        }
        seen_keys.insert(key);
        merged_tools.push(tool.clone());
    };

    let chat_declares_server_side_web_search = input
        .chat_tools
        .as_ref()
        .map(|tools| tools.iter().any(is_server_side_web_search_function))
        .unwrap_or(false);

    if let Some(chat_tools) = input.chat_tools.as_ref() {
        for tool in chat_tools {
            if has_server_side_web_search && is_server_side_web_search_function(tool) {
                continue;
            }
            register(tool);
        }
    }

    if !has_server_side_web_search || !original_has_non_builtin_tools {
        if let Some(original_tools) = input.original_tools.as_ref() {
            for tool in original_tools {
                if !is_builtin_web_search_tool(tool) {
                    continue;
                }
                register(tool);
            }
        }
    }

    let should_inject_builtin_web_search = has_server_side_web_search
        && chat_declares_server_side_web_search
        && !original_has_builtin_web_search;

    if should_inject_builtin_web_search && !merged_tools.iter().any(is_builtin_web_search_tool) {
        merged_tools.push(serde_json::json!({ "type": "web_search" }));
    }

    let mut request = input
        .request
        .as_ref()
        .and_then(Value::as_object)
        .map(|_| Map::new());
    if let Some(request_obj) = request.as_mut() {
        if let Some(keys) = input.passthrough_keys.as_ref() {
            if let Some(chat_request) = input.request.as_ref().and_then(Value::as_object) {
                for key in keys {
                    if let Some(value) = chat_request.get(key).cloned() {
                        request_obj.insert(key.clone(), value);
                    }
                }
            }
        }
        if request_obj.is_empty() {
            request = None;
        }
    }

    ResolveResponsesBridgeToolsOutput {
        merged_tools: if merged_tools.is_empty() {
            None
        } else {
            Some(merged_tools)
        },
        request: request.map(Value::Object),
    }
}

fn normalize_tool_call_id_style_candidate(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?.trim().to_ascii_lowercase();
    match raw.as_str() {
        "fc" => Some("fc".to_string()),
        "preserve" => Some("preserve".to_string()),
        _ => None,
    }
}

fn resolve_tool_call_id_style_value(metadata: Option<&Value>) -> Option<String> {
    let metadata = metadata?;
    let raw = serde_json::to_string(metadata).ok()?;
    let resolved = resolve_tool_call_id_style_json(raw).ok()?;
    serde_json::from_str::<Value>(&resolved)
        .ok()
        .and_then(|value| value.as_str().map(|text| text.to_string()))
}

fn read_runtime_metadata_value(metadata: Option<&Value>) -> Option<Value> {
    let metadata = metadata?;
    let raw = serde_json::to_string(metadata).ok()?;
    let resolved = read_runtime_metadata_json(raw).ok()?;
    serde_json::from_str::<Value>(&resolved).ok()
}

fn read_force_web_search(context: Option<&Value>) -> bool {
    let metadata = context
        .and_then(Value::as_object)
        .and_then(|row| row.get("metadata"));
    let runtime_metadata = read_runtime_metadata_value(metadata);
    let Some(runtime_row) = runtime_metadata.as_ref().and_then(Value::as_object) else {
        return false;
    };
    if matches!(runtime_row.get("forceWebSearch"), Some(Value::Bool(true))) {
        return true;
    }
    runtime_row
        .get("webSearch")
        .and_then(Value::as_object)
        .and_then(|row| row.get("force"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn build_context_history_seed(context: Option<&Value>) -> Option<Value> {
    let context_row = context?.as_object()?;
    let input = context_row.get("input")?.as_array()?.clone();
    let mut seed = Map::new();
    seed.insert("input".to_string(), Value::Array(input));
    if let Some(original_system_messages) = context_row.get("originalSystemMessages") {
        seed.insert(
            "originalSystemMessages".to_string(),
            original_system_messages.clone(),
        );
    }
    if let Some(system_instruction) = context_row.get("systemInstruction") {
        seed.insert(
            "combinedSystemInstruction".to_string(),
            system_instruction.clone(),
        );
    }
    Some(Value::Object(seed))
}

pub(crate) fn resolve_responses_request_bridge_decisions(
    input: ResolveResponsesRequestBridgeDecisionsInput,
) -> ResolveResponsesRequestBridgeDecisionsOutput {
    let context_history_seed = build_context_history_seed(input.context.as_ref());
    let route_tool_call_id_style = input
        .request_metadata
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|row| normalize_tool_call_id_style_candidate(row.get("toolCallIdStyle")));
    let envelope_tool_call_id_style =
        resolve_tool_call_id_style_value(input.envelope_metadata.as_ref());
    let context_tool_call_id_style =
        input
            .context
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|row| {
                normalize_tool_call_id_style_candidate(row.get("toolCallIdStyle")).or_else(|| {
                    row.get("metadata")
                        .and_then(Value::as_object)
                        .and_then(|metadata| {
                            normalize_tool_call_id_style_candidate(metadata.get("toolCallIdStyle"))
                        })
                })
            });
    let history_seed = [
        input.extra_bridge_history.as_ref(),
        context_history_seed.as_ref(),
        input.bridge_metadata.as_ref().and_then(|metadata| {
            metadata
                .as_object()
                .and_then(|row| row.get("bridgeHistory"))
        }),
        input.envelope_metadata.as_ref().and_then(|metadata| {
            metadata
                .as_object()
                .and_then(|row| row.get("bridgeHistory"))
        }),
    ]
    .into_iter()
    .flatten()
    .find_map(normalize_bridge_history_seed);

    ResolveResponsesRequestBridgeDecisionsOutput {
        force_web_search: read_force_web_search(input.context.as_ref()),
        tool_call_id_style: route_tool_call_id_style
            .or(envelope_tool_call_id_style)
            .or(context_tool_call_id_style),
        history_seed,
    }
}

fn clamp_responses_input_item_id(raw: Option<&str>) -> Option<String> {
    let trimmed = raw.unwrap_or("").trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() <= 64 {
        return Some(trimmed.to_string());
    }
    let payload = serde_json::to_string(&Value::String(trimmed.to_string())).ok()?;
    let raw = clamp_responses_input_item_id_json(payload).ok()?;
    serde_json::from_str::<Option<String>>(&raw).ok().flatten()
}

pub(crate) fn filter_bridge_input_for_upstream(
    input: FilterBridgeInputForUpstreamInput,
) -> FilterBridgeInputForUpstreamOutput {
    let allow_tool_call_id = input.allow_tool_call_id.unwrap_or(false);
    let mut normalized: Vec<Value> = Vec::new();
    for item in input.input {
        let Some(mut row) = item.as_object().cloned() else {
            continue;
        };
        let item_type = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if item_type == "reasoning" {
            continue;
        }
        if !allow_tool_call_id {
            row.remove("tool_call_id");
        }
        let normalized_id = clamp_responses_input_item_id(row.get("id").and_then(Value::as_str));
        if let Some(id) = normalized_id {
            row.insert("id".to_string(), Value::String(id));
        }
        normalized.push(Value::Object(row));
    }
    FilterBridgeInputForUpstreamOutput { input: normalized }
}

fn read_trimmed_non_empty_string(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

fn collect_reasoning_instruction_segments(value: Option<&Value>) -> Vec<String> {
    let Some(raw) = value else {
        return Vec::new();
    };
    let entries: Vec<&Value> = match raw {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    entries
        .into_iter()
        .filter_map(|entry| match entry {
            Value::String(text) => Some(text.trim().to_string()),
            Value::Null => None,
            other => Some(other.to_string().trim().to_string()),
        })
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn clone_non_empty_object(value: Option<&Value>) -> Option<Map<String, Value>> {
    let record = value?.as_object()?.clone();
    if record.is_empty() {
        return None;
    }
    Some(record)
}

fn merge_parameter_sources(
    context: Option<&Value>,
    chat: Option<&Value>,
    metadata: Option<&Value>,
) -> Option<Map<String, Value>> {
    let mut merged = Map::new();
    for source in [metadata, chat, context] {
        if let Some(record) = clone_non_empty_object(source) {
            for (key, value) in record {
                merged.insert(key, value);
            }
        }
    }
    if merged.is_empty() {
        None
    } else {
        Some(merged)
    }
}

fn merge_parameters_into_request(request: &mut Map<String, Value>, source: &Map<String, Value>) {
    const ALLOWED_KEYS: &[&str] = &[
        "temperature",
        "top_p",
        "max_output_tokens",
        "seed",
        "logit_bias",
        "user",
        "parallel_tool_calls",
        "tool_choice",
        "response_format",
        "service_tier",
        "truncation",
        "include",
        "store",
        "prompt_cache_key",
        "reasoning",
        "stream",
    ];

    let mut normalized = source.clone();
    if !normalized.contains_key("max_output_tokens") {
        if let Some(value) = normalized.get("max_tokens").cloned() {
            normalized.insert("max_output_tokens".to_string(), value);
        }
    }

    for key in ALLOWED_KEYS {
        if *key == "stream" {
            continue;
        }
        if request.contains_key(*key) {
            continue;
        }
        if let Some(value) = normalized.get(*key).cloned() {
            request.insert((*key).to_string(), value);
        }
    }
}

fn read_optional_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

fn clone_plain_object(value: Option<&Value>) -> Option<Map<String, Value>> {
    value?.as_object().cloned()
}

fn apply_direct_override(request: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if request.contains_key(key) {
        return;
    }
    if let Some(candidate) = value.cloned() {
        request.insert(key.to_string(), candidate);
    }
}

fn upsert_direct_override(request: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(candidate) = value.cloned() {
        request.insert(key.to_string(), candidate);
    }
}

pub(crate) fn prepare_responses_request_envelope(
    input: PrepareResponsesRequestEnvelopeInput,
) -> PrepareResponsesRequestEnvelopeOutput {
    let mut request = input.request.as_object().cloned().unwrap_or_default();

    let instruction_candidates = [
        read_trimmed_non_empty_string(input.context_system_instruction.as_ref()),
        read_trimmed_non_empty_string(input.extra_system_instruction.as_ref()),
        read_trimmed_non_empty_string(input.metadata_system_instruction.as_ref()),
        read_trimmed_non_empty_string(input.combined_system_instruction.as_ref()),
    ];
    let resolved_instruction = instruction_candidates.into_iter().flatten().next();
    if let Some(instruction) = resolved_instruction {
        let reasoning_segments =
            collect_reasoning_instruction_segments(input.reasoning_instruction_segments.as_ref());
        if reasoning_segments.is_empty() {
            request.insert("instructions".to_string(), Value::String(instruction));
            request.remove("instructions_is_raw");
        } else {
            let mut combined = reasoning_segments.join("\n");
            if !combined.is_empty() {
                combined.push('\n');
            }
            combined.push_str(&instruction);
            request.insert(
                "instructions".to_string(),
                Value::String(combined.trim().to_string()),
            );
            request.insert("instructions_is_raw".to_string(), Value::Bool(true));
        }
    }

    if let Some(parameters) = merge_parameter_sources(
        input.context_parameters.as_ref(),
        input.chat_parameters.as_ref(),
        input.metadata_parameters.as_ref(),
    ) {
        merge_parameters_into_request(&mut request, &parameters);
    }

    let resolved_stream = read_optional_bool(input.context_stream.as_ref())
        .or_else(|| read_optional_bool(input.chat_stream.as_ref()))
        .or_else(|| read_optional_bool(input.chat_parameters_stream.as_ref()))
        .or_else(|| read_optional_bool(input.metadata_stream.as_ref()));
    if let Some(stream) = resolved_stream {
        request.insert("stream".to_string(), Value::Bool(stream));
    }

    upsert_direct_override(&mut request, "include", input.metadata_include.as_ref());
    upsert_direct_override(&mut request, "include", input.context_include.as_ref());

    if input.strip_host_fields.unwrap_or(false) {
        request.remove("store");
    } else if !request.contains_key("store") {
        if let Some(value) = input.context_store.as_ref().cloned() {
            request.insert("store".to_string(), value);
        } else if let Some(value) = input.metadata_store.as_ref().cloned() {
            request.insert("store".to_string(), value);
        } else {
            request.insert("store".to_string(), Value::Bool(false));
        }
    }

    upsert_direct_override(
        &mut request,
        "tool_choice",
        input.metadata_tool_choice.as_ref(),
    );
    upsert_direct_override(
        &mut request,
        "tool_choice",
        input.context_tool_choice.as_ref(),
    );

    upsert_direct_override(
        &mut request,
        "parallel_tool_calls",
        input.metadata_parallel_tool_calls.as_ref(),
    );
    upsert_direct_override(
        &mut request,
        "parallel_tool_calls",
        input.context_parallel_tool_calls.as_ref(),
    );

    upsert_direct_override(
        &mut request,
        "response_format",
        input.metadata_response_format.as_ref(),
    );
    upsert_direct_override(
        &mut request,
        "response_format",
        input.context_response_format.as_ref(),
    );

    upsert_direct_override(
        &mut request,
        "service_tier",
        input.metadata_service_tier.as_ref(),
    );
    upsert_direct_override(
        &mut request,
        "service_tier",
        input.context_service_tier.as_ref(),
    );

    upsert_direct_override(
        &mut request,
        "truncation",
        input.metadata_truncation.as_ref(),
    );
    upsert_direct_override(
        &mut request,
        "truncation",
        input.context_truncation.as_ref(),
    );

    if let Some(metadata) = clone_non_empty_object(input.context_metadata.as_ref()) {
        request.insert("metadata".to_string(), Value::Object(metadata));
    } else if let Some(metadata) = clone_plain_object(input.metadata_metadata.as_ref()) {
        request.insert("metadata".to_string(), Value::Object(metadata));
    }

    request.remove("parameters");

    PrepareResponsesRequestEnvelopeOutput {
        request: Value::Object(request),
    }
}

pub(crate) fn build_bridge_history(input: BuildBridgeHistoryInput) -> BuildBridgeHistoryOutput {
    let mut items: Vec<Value> = Vec::new();
    let mut system_parts: Vec<String> = Vec::new();
    let mut original_system_messages: Vec<String> = Vec::new();
    let mut latest_user_instruction: Option<String> = None;
    let mut pending_tool_call_ids: VecDeque<String> = VecDeque::new();
    let mut known_tool_call_ids: HashSet<String> = HashSet::new();
    let _tools = input.tools;

    for message in input.messages {
        let Some(row) = message.as_object() else {
            continue;
        };
        let role = coerce_bridge_role(row.get("role").and_then(Value::as_str));
        let content = row.get("content").cloned().unwrap_or(Value::Null);
        let collected_text = collect_text(&content);
        let mut media_blocks: Vec<MediaBlock> = Vec::new();
        extract_media_blocks_from_content(&content, &mut media_blocks);
        let mut ordered_blocks: Vec<Value> = Vec::new();
        let default_text_role = if role == "assistant" {
            "output_text"
        } else {
            "input_text"
        };
        content_blocks_to_bridge(&content, &mut ordered_blocks, default_text_role);
        let text = if role == "system" {
            collected_text.clone()
        } else {
            collected_text.trim().to_string()
        };

        if role == "system" {
            if !collected_text.is_empty() {
                original_system_messages.push(collected_text.clone());
                system_parts.push(collected_text);
            }
            continue;
        }

        if role == "tool" {
            let raw_tool_id = read_trimmed_string(row.get("tool_call_id"))
                .or_else(|| read_trimmed_string(row.get("call_id")))
                .or_else(|| read_trimmed_string(row.get("tool_use_id")))
                .or_else(|| read_trimmed_string(row.get("id")));
            let mut call_id = raw_tool_id.clone();
            if let Some(existing_id) = call_id.clone() {
                if known_tool_call_ids.contains(existing_id.as_str()) {
                    if let Some(pos) = pending_tool_call_ids
                        .iter()
                        .position(|entry| entry == existing_id.as_str())
                    {
                        pending_tool_call_ids.remove(pos);
                    }
                }
            }
            if call_id.is_none() && !pending_tool_call_ids.is_empty() {
                call_id = pending_tool_call_ids.pop_front();
            }
            if call_id.is_none() {
                call_id = Some(normalize_function_call_id(
                    None,
                    format!("fc_call_{}", items.len() + 1).as_str(),
                ));
            }
            let resolved_call_id =
                call_id.unwrap_or_else(|| format!("fc_call_{}", items.len() + 1));
            known_tool_call_ids.insert(resolved_call_id.clone());
            let normalized_output_id = normalize_function_call_output_id(
                Some(resolved_call_id.as_str()),
                format!("fc_tool_{}", items.len() + 1).as_str(),
            );
            let output_payload = row
                .get("content")
                .map(serialize_tool_result_payload)
                .unwrap_or_else(|| text.clone());
            let entry = serde_json::json!({
                "type": "function_call_output",
                "id": normalized_output_id,
                "call_id": resolved_call_id,
                "output": output_payload
            });
            items.push(entry);
            continue;
        }

        let tool_calls = row
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !tool_calls.is_empty() {
            for tool_call in tool_calls {
                let Some(tc_row) = tool_call.as_object() else {
                    continue;
                };
                let raw_id_candidate = read_trimmed_string(tc_row.get("id"))
                    .or_else(|| read_trimmed_string(tc_row.get("call_id")));
                let call_id = raw_id_candidate.clone().unwrap_or_else(|| {
                    normalize_function_call_id(
                        raw_id_candidate.as_deref(),
                        format!("fc_call_{}", items.len() + 1).as_str(),
                    )
                });
                let fn_row = tc_row.get("function").and_then(Value::as_object);
                let name = fn_row
                    .and_then(|v| read_trimmed_string(v.get("name")))
                    .unwrap_or_else(|| "tool".to_string());
                let args = serialize_tool_arguments(fn_row.and_then(|v| v.get("arguments")));
                let entry = serde_json::json!({
                    "type": "function_call",
                    "id": call_id,
                    "call_id": call_id,
                    "name": name,
                    "arguments": args
                });
                items.push(entry);
                known_tool_call_ids.insert(call_id.clone());
                pending_tool_call_ids.push_back(call_id);
            }
            continue;
        }

        if !ordered_blocks.is_empty() || !text.is_empty() || !media_blocks.is_empty() {
            let blocks: Vec<Value> = if !ordered_blocks.is_empty() {
                ordered_blocks
            } else {
                let text_role = if role == "assistant" {
                    "output_text"
                } else {
                    "input_text"
                };
                let mut blocks: Vec<Value> = Vec::new();
                if !text.is_empty() {
                    blocks.push(serde_json::json!({
                        "type": text_role,
                        "text": text
                    }));
                }
                for media in media_blocks {
                    if media.kind == "video" {
                        let mut block = serde_json::json!({
                            "type": "input_video",
                            "video_url": media.url
                        });
                        if let Some(detail) = media.detail {
                            if let Some(obj) = block.as_object_mut() {
                                obj.insert("detail".to_string(), Value::String(detail));
                            }
                        }
                        blocks.push(block);
                    } else {
                        let mut block = serde_json::json!({
                            "type": "input_image",
                            "image_url": media.url
                        });
                        if let Some(detail) = media.detail {
                            if let Some(obj) = block.as_object_mut() {
                                obj.insert("detail".to_string(), Value::String(detail));
                            }
                        }
                        blocks.push(block);
                    }
                }
                blocks
            };
            if !blocks.is_empty() {
                items.push(serde_json::json!({
                    "role": role,
                    "content": blocks
                }));
            }
            if role == "user" {
                let trimmed = text.trim().to_string();
                if !trimmed.is_empty() {
                    latest_user_instruction = Some(trimmed);
                }
            }
        }
    }

    if latest_user_instruction.is_none() {
        for entry in items.iter().rev() {
            let role = entry
                .as_object()
                .and_then(|row| row.get("role"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if role != "user" {
                continue;
            }
            let text = extract_user_text_from_entry(entry);
            if !text.is_empty() {
                latest_user_instruction = Some(text);
                break;
            }
        }
    }

    let combined_system_instruction = {
        let joined = system_parts.join("\n\n").trim().to_string();
        if joined.is_empty() {
            None
        } else {
            Some(joined)
        }
    };

    BuildBridgeHistoryOutput {
        input: items,
        combined_system_instruction,
        latest_user_instruction,
        original_system_messages,
    }
}

pub(crate) fn apply_bridge_normalize_history(
    input: ApplyBridgeNormalizeHistoryInput,
) -> ApplyBridgeNormalizeHistoryOutput {
    let normalized = normalize_tool_session_payload(ToolSessionCompatInput {
        messages: input.messages,
        tool_outputs: None,
    });
    let messages = normalized.messages;
    let bridge_history = serde_json::to_value(build_bridge_history(BuildBridgeHistoryInput {
        messages: messages.clone(),
        tools: input.tools,
    }))
    .ok();
    ApplyBridgeNormalizeHistoryOutput {
        messages,
        bridge_history,
    }
}

pub(crate) fn apply_bridge_capture_tool_results(
    input: ApplyBridgeCaptureToolResultsInput,
) -> ApplyBridgeCaptureToolResultsOutput {
    let stage = input.stage.trim().to_ascii_lowercase();
    let mut captured_tool_results = input.captured_tool_results.unwrap_or_default();
    if captured_tool_results.is_empty() {
        let source = if stage.starts_with("request") {
            input.raw_request.as_ref()
        } else if stage.starts_with("response") {
            input.raw_response.as_ref()
        } else {
            None
        };
        if let Some(payload) = source {
            let collected = collect_tool_outputs(payload);
            if let Ok(Value::Array(entries)) = serde_json::to_value(collected) {
                if !entries.is_empty() {
                    captured_tool_results = entries;
                }
            }
        }
    }

    let mut metadata = input.metadata.and_then(|value| value.as_object().cloned());
    if stage == "request_outbound" && !captured_tool_results.is_empty() {
        if metadata.is_none() {
            metadata = Some(Map::new());
        }
        if let Some(metadata_obj) = metadata.as_mut() {
            metadata_obj.insert(
                "capturedToolResults".to_string(),
                Value::Array(captured_tool_results.clone()),
            );
        }
    }

    ApplyBridgeCaptureToolResultsOutput {
        captured_tool_results: if captured_tool_results.is_empty() {
            None
        } else {
            Some(captured_tool_results)
        },
        metadata: metadata.map(Value::Object),
    }
}

fn resolve_stage_tool_outputs(
    stage: &str,
    captured_tool_results: Option<Vec<Value>>,
    raw_request: Option<&Value>,
    raw_response: Option<&Value>,
) -> Option<Vec<Value>> {
    if let Some(entries) = captured_tool_results {
        if !entries.is_empty() {
            return Some(entries);
        }
    }
    let source = if stage.starts_with("request") {
        raw_request
    } else if stage.starts_with("response") {
        raw_response
    } else {
        None
    };
    let payload = source?;
    if let Ok(Value::Array(entries)) = serde_json::to_value(collect_tool_outputs(payload)) {
        if !entries.is_empty() {
            return Some(entries);
        }
    }
    None
}

pub(crate) fn apply_bridge_ensure_tool_placeholders(
    input: ApplyBridgeEnsureToolPlaceholdersInput,
) -> ApplyBridgeEnsureToolPlaceholdersOutput {
    let stage = input.stage.trim().to_ascii_lowercase();
    let tool_outputs = resolve_stage_tool_outputs(
        stage.as_str(),
        input.captured_tool_results,
        input.raw_request.as_ref(),
        input.raw_response.as_ref(),
    );
    let normalized = normalize_tool_session_payload(ToolSessionCompatInput {
        messages: input.messages,
        tool_outputs,
    });
    ApplyBridgeEnsureToolPlaceholdersOutput {
        messages: normalized.messages,
        tool_outputs: normalized.tool_outputs,
    }
}

pub(crate) fn ensure_bridge_output_fields(
    input: EnsureBridgeOutputFieldsInput,
) -> EnsureBridgeOutputFieldsOutput {
    let tool_fallback = input
        .tool_fallback
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Tool call completed (no output).".to_string());
    let assistant_fallback = input
        .assistant_fallback
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Assistant response unavailable.".to_string());

    let mut messages = input.messages;
    for message in messages.iter_mut() {
        let Some(row) = message.as_object_mut() else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();

        if role == "tool" {
            let text = row
                .get("content")
                .and_then(flatten_content_to_string)
                .unwrap_or_else(|| tool_fallback.clone());
            row.insert("content".to_string(), Value::String(text));
            continue;
        }

        if role != "assistant" {
            continue;
        }

        let has_tool_calls = row
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(|entries| !entries.is_empty())
            .unwrap_or(false);

        let text = row.get("content").and_then(flatten_content_to_string);
        let has_text = text
            .as_ref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);

        if text.is_some() && !matches!(row.get("content"), Some(Value::String(_))) {
            row.insert(
                "content".to_string(),
                Value::String(text.unwrap_or_default()),
            );
            continue;
        }

        if has_text {
            continue;
        }

        let reasoning_text = row
            .get("reasoning_content")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if let Some(reasoning) = reasoning_text {
            row.insert("content".to_string(), Value::String(reasoning));
            continue;
        }

        if has_tool_calls {
            continue;
        }

        row.insert(
            "content".to_string(),
            Value::String(assistant_fallback.clone()),
        );
    }

    EnsureBridgeOutputFieldsOutput { messages }
}
