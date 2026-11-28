use super::req_inbound_02_normalized::{
    comparable_chat_content, V3HubAssistantItemContentRange, V3HubAssistantItemProvenance,
    V3HubExplicitHistoryProvenance, V3HubMessageHistoryProvenance, V3HubToolCallHistoryProvenance,
};
use super::V3HubEntryProtocol;
use crate::protocol_tables::{map_field as table_map_field, V3TableDirection};
use provider_compat_core::namespace_tools::resolve_responses_tool_declarations;
use serde_json::{json, Map, Value};
mod chat_extension_merge;
mod tool_output;
const ANTHROPIC_REASONING_EXTENSION: &str = "anthropic_reasoning";
const ANTHROPIC_REASONING_BLOCKS_EXTENSION: &str = "anthropic_reasoning_blocks";
pub(super) const RESPONSES_REASONING_ITEMS_EXTENSION: &str = "responses_reasoning_items";
pub(super) const RESPONSES_ASSISTANT_ITEMS_EXTENSION: &str = "responses_assistant_items";
pub(super) const RESPONSES_ASSISTANT_ITEM_STATUSES_EXTENSION: &str =
    "responses_assistant_item_statuses";
pub(super) use tool_output::{
    canonical_content as responses_tool_output_content, image_url as responses_image_url,
};
pub(crate) fn build_v3_chat_canonical_request_from_responses_payload(
    payload: &Value,
) -> Result<Value, String> {
    build_v3_chat_canonical_request_from_responses_payload_with_provenance(payload)
        .map(|(request, _)| request)
}

pub(crate) fn build_v3_chat_canonical_request_from_responses_payload_with_provenance(
    payload: &Value,
) -> Result<(Value, V3HubExplicitHistoryProvenance), String> {
    build_v3_chat_canonical_request_from_responses_semantic_with_orphan_resolution(
        payload,
        V3HubEntryProtocol::Responses,
        true,
    )
}

pub(super) fn build_v3_chat_canonical_request_from_responses_semantic(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
) -> Result<Value, String> {
    build_v3_chat_canonical_request_from_responses_semantic_with_orphan_resolution(
        payload,
        entry_protocol,
        true,
    )
    .map(|(request, _)| request)
}

pub(super) fn build_v3_chat_canonical_request_from_responses_semantic_with_orphan_resolution(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
    resolve_orphan_media: bool,
) -> Result<(Value, V3HubExplicitHistoryProvenance), String> {
    let native_responses = entry_protocol == V3HubEntryProtocol::Responses;
    let root = payload.as_object().ok_or_else(|| {
        "Responses request payload must be an object before OpenAI Chat encoding".to_string()
    })?;
    let input = match root.get("input") {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => vec![json!({
            "type": "message",
            "role": "user",
            "content": text
        })],
        _ => {
            return Err(
                "Responses request payload must contain input array before OpenAI Chat encoding"
                    .to_string(),
            );
        }
    };
    let mut messages = Vec::new();
    let mut message_provenance: Vec<V3HubMessageHistoryProvenance> = Vec::new();
    let mut pending_tool_message_index: Option<usize> = None;
    let mut pending_tool_call_ids: Vec<String> = Vec::new();
    let mut pending_tool_adjacent_deferred_messages: Vec<Value> = Vec::new();
    let mut pending_deferred_provenance: Vec<V3HubMessageHistoryProvenance> = Vec::new();
    let mut turn_assistant_tail_index: Option<usize> = None;
    if let Some(instructions) = root
        .get("instructions")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        messages.push(json!({"role":"system","content":instructions}));
        message_provenance.push(V3HubMessageHistoryProvenance::default());
    }

    // The declaration registry owns the current declaration surface. It merges
    // the root `tools` and every `additional_tools` source in source order, so
    // a later source refreshes an earlier one and one client identity keeps
    // one effective schema. The canonical Chat request carries exactly one
    // declaration source, so re-appending the raw `additional_tools` children
    // here would place two different schemas for one identity into that single
    // source and turn a representable request into a local conflict.
    let mut tools = resolve_responses_tool_declarations(payload)?;
    for (input_index, item) in input.iter().enumerate() {
        let item = item.as_object().ok_or_else(|| {
            "Responses input item must be an object before OpenAI Chat encoding".to_string()
        })?;
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message");
        match item_type {
            "additional_tools" => {
                let embedded = item.get("tools").and_then(Value::as_array).ok_or_else(|| {
                    "Responses additional_tools.tools must be an array before OpenAI Chat encoding"
                        .to_string()
                })?;
                for tool in embedded {
                    // Only declarations the identity registry does not manage
                    // stay here, such as the native discovery declaration and
                    // hosted tools. Identity declarations are already merged
                    // into one effective declaration per client identity.
                    if !matches!(
                        tool.get("type").and_then(Value::as_str),
                        Some("namespace" | "function" | "custom")
                    ) {
                        tools.push(tool.clone());
                    }
                }
            }
            "web_search" => {
                let mut tool = Map::new();
                tool.insert("type".to_string(), Value::String("web_search".to_string()));
                for key in [
                    "search_context_size",
                    "user_location",
                    "external_web_access",
                    "search_content_types",
                ] {
                    if let Some(value) = item.get(key) {
                        tool.insert(key.to_string(), value.clone());
                    }
                }
                tools.push(Value::Object(tool));
            }
            "message" => {
                let is_assistant_message = item
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("user")
                    .trim()
                    .eq_ignore_ascii_case("assistant");
                let mut message = build_v3_openai_chat_message_from_responses_message(item)?;
                let mut prov = V3HubMessageHistoryProvenance::default();
                if native_responses {
                    prov.message_input_order = Some(input_index as u64);
                    if is_assistant_message {
                        attach_v3_responses_assistant_item_status(&mut message, item);
                        prov.assistant_content_digest = Some(chat_content_digest(
                            message.get("content").unwrap_or(&Value::Null),
                        ));
                        prov.assistant_items
                            .push(build_v3_responses_assistant_item_provenance(
                                &message,
                                item,
                                input_index,
                            ));
                    }
                }
                append_v3_openai_chat_message_preserving_tool_adjacency_with_provenance(
                    &mut messages,
                    &mut message_provenance,
                    &mut pending_tool_message_index,
                    &mut pending_tool_adjacent_deferred_messages,
                    &mut pending_deferred_provenance,
                    message,
                    prov,
                    turn_assistant_tail_index,
                )?;
                if is_assistant_message {
                    turn_assistant_tail_index = Some(messages.len() - 1);
                } else {
                    turn_assistant_tail_index = None;
                }
            }
            "output_text" => {
                let mut message = build_v3_openai_chat_assistant_output_text_message(item);
                let mut prov = V3HubMessageHistoryProvenance::default();
                if native_responses {
                    attach_v3_responses_assistant_item_status(&mut message, item);
                    prov.message_input_order = Some(input_index as u64);
                    prov.assistant_content_digest = Some(chat_content_digest(
                        message.get("content").unwrap_or(&Value::Null),
                    ));
                    prov.assistant_items
                        .push(build_v3_responses_assistant_item_provenance(
                            &message,
                            item,
                            input_index,
                        ));
                }
                append_v3_openai_chat_message_preserving_tool_adjacency_with_provenance(
                    &mut messages,
                    &mut message_provenance,
                    &mut pending_tool_message_index,
                    &mut pending_tool_adjacent_deferred_messages,
                    &mut pending_deferred_provenance,
                    message,
                    prov,
                    turn_assistant_tail_index,
                )?;
                turn_assistant_tail_index = Some(messages.len() - 1);
            }
            "reasoning" => {
                if let Some(extension) = item.get("routecodex_chat_extension") {
                    let extension = extension.as_object().ok_or_else(|| {
                        "Responses reasoning routecodex_chat_extension must be an object"
                            .to_string()
                    })?;
                    if let Some(entries) = extension.get(RESPONSES_REASONING_ITEMS_EXTENSION) {
                        let entries = entries.as_array().ok_or_else(|| {
                            "Responses responses_reasoning_items must be an array".to_string()
                        })?;
                        if entries.iter().any(|entry| !entry.is_object()) {
                            return Err(
                                "Responses responses_reasoning_items entries must be objects"
                                    .to_string(),
                            );
                        }
                    }
                }
                if let Some(mut message) = build_v3_openai_chat_assistant_reasoning_message(item) {
                    let mut prov = V3HubMessageHistoryProvenance::default();
                    if native_responses {
                        prov.reasoning_item_orders = attach_v3_responses_reasoning_input_order(
                            &mut message,
                            item,
                            input_index,
                        );
                    }
                    append_v3_openai_chat_message_preserving_tool_adjacency_with_provenance(
                        &mut messages,
                        &mut message_provenance,
                        &mut pending_tool_message_index,
                        &mut pending_tool_adjacent_deferred_messages,
                        &mut pending_deferred_provenance,
                        message,
                        prov,
                        turn_assistant_tail_index,
                    )?;
                    turn_assistant_tail_index = Some(messages.len() - 1);
                }
            }
            "function_call" | "tool_call" | "custom_tool_call" => {
                let message = build_v3_openai_chat_assistant_tool_call_message(item)?;
                let prov = V3HubMessageHistoryProvenance {
                    tool_calls: vec![V3HubToolCallHistoryProvenance {
                        source_input_order: native_responses.then_some(input_index as u64),
                        suppress_responses_hosted_call: false,
                    }],
                    ..Default::default()
                };
                append_v3_openai_chat_tool_call_message_with_provenance(
                    &mut messages,
                    &mut message_provenance,
                    &mut pending_tool_message_index,
                    &mut pending_tool_call_ids,
                    message,
                    prov,
                    turn_assistant_tail_index,
                )?;
                turn_assistant_tail_index = None;
            }
            "function_call_output"
            | "tool_call_output"
            | "custom_tool_call_output"
            | "tool_result"
            | "tool_message" => {
                let (message, decoder_captured_responses_tool_output) =
                    build_v3_openai_chat_tool_result_message(item, native_responses)?;
                let prov = V3HubMessageHistoryProvenance {
                    message_input_order: native_responses.then_some(input_index as u64),
                    omit_tool_output_id: native_responses
                        && read_v3_non_empty_str(item.get("id")).is_none(),
                    preserve_native_tool_output_id: native_responses,
                    decoder_native_tool_output: native_responses,
                    decoder_captured_responses_tool_output,
                    ..Default::default()
                };
                append_v3_openai_chat_tool_result_message_with_provenance(
                    &mut messages,
                    &mut message_provenance,
                    &mut pending_tool_message_index,
                    &mut pending_tool_call_ids,
                    &mut pending_tool_adjacent_deferred_messages,
                    &mut pending_deferred_provenance,
                    message,
                    prov,
                )?;
                turn_assistant_tail_index = None;
            }
            "web_search_call" => {
                append_v3_openai_chat_hosted_tool_call_history_pair(
                    &mut messages,
                    &mut message_provenance,
                    &mut pending_tool_message_index,
                    &mut pending_tool_call_ids,
                    &mut pending_tool_adjacent_deferred_messages,
                    &mut pending_deferred_provenance,
                    item,
                    input_index,
                    V3OpenAiChatHostedToolHistoryKind::WebSearch,
                    native_responses,
                )?;
                turn_assistant_tail_index = None;
            }
            "tool_search_call" => {
                let assistant = build_v3_openai_chat_hosted_tool_assistant_tool_call_message(
                    item,
                    read_v3_non_empty_str(item.get("call_id")).ok_or_else(|| {
                        "Responses tool_search_call is missing call_id before Chat canonicalization"
                            .to_string()
                    })?,
                    V3OpenAiChatHostedToolHistoryKind::ToolSearch,
                )?;
                let prov = V3HubMessageHistoryProvenance {
                    tool_calls: vec![V3HubToolCallHistoryProvenance {
                        source_input_order: native_responses.then_some(input_index as u64),
                        suppress_responses_hosted_call: false,
                    }],
                    ..Default::default()
                };
                append_v3_openai_chat_tool_call_message_with_provenance(
                    &mut messages,
                    &mut message_provenance,
                    &mut pending_tool_message_index,
                    &mut pending_tool_call_ids,
                    assistant,
                    prov,
                    None,
                )?;
                turn_assistant_tail_index = None;
            }
            "tool_search_output" => {
                let tool_result = build_v3_openai_chat_tool_search_output_message(item)?;
                let prov = V3HubMessageHistoryProvenance {
                    message_input_order: native_responses.then_some(input_index as u64),
                    preserve_native_tool_output_id: native_responses,
                    ..Default::default()
                };
                append_v3_openai_chat_tool_result_message_with_provenance(
                    &mut messages,
                    &mut message_provenance,
                    &mut pending_tool_message_index,
                    &mut pending_tool_call_ids,
                    &mut pending_tool_adjacent_deferred_messages,
                    &mut pending_deferred_provenance,
                    tool_result,
                    prov,
                )?;
                turn_assistant_tail_index = None;
            }
            "agent_message" => {
                // OpenAI Responses Beta agent-to-agent message.  author/recipient
                // are internal agent identity (not Chat semantics) and are not
                // emitted; encrypted_content parts are Fernet ciphertext of
                // session state and must be discarded before provider wire
                // (same rule as compaction.encrypted_content).
                let parts_value: Option<Value> = item
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .filter(|part| {
                                !matches!(
                                    part.get("type").and_then(Value::as_str),
                                    Some("encrypted_content")
                                )
                            })
                            .cloned()
                            .collect::<Vec<Value>>()
                    })
                    .map(Value::Array);
                let (content, _) = build_v3_openai_chat_content_from_responses_content(
                    parts_value
                        .as_ref()
                        .or(item.get("content"))
                        .or(Some(&Value::Null)),
                )?;
                let message = json!({"role": "user", "content": content});
                let prov = V3HubMessageHistoryProvenance {
                    message_input_order: native_responses.then_some(input_index as u64),
                    ..Default::default()
                };
                append_v3_openai_chat_message_preserving_tool_adjacency_with_provenance(
                    &mut messages,
                    &mut message_provenance,
                    &mut pending_tool_message_index,
                    &mut pending_tool_adjacent_deferred_messages,
                    &mut pending_deferred_provenance,
                    message,
                    prov,
                    turn_assistant_tail_index,
                )?;
                turn_assistant_tail_index = None;
            }
            "compaction" => {
                // Client session-compaction marker. Its encrypted_content is Fernet
                // ciphertext of prior context and must be discarded here, never
                // encoded into provider messages: retaining it would pollute the
                // conversation history rendered to the provider. Mirrors the
                // encrypted-reasoning discard rule applied at response ingress.
            }
            other => {
                return Err(format!(
                    "unsupported Responses input item type for OpenAI Chat provider encoding: {other}"
                ));
            }
        }
    }
    messages.extend(std::mem::take(&mut pending_tool_adjacent_deferred_messages));
    message_provenance.extend(std::mem::take(&mut pending_deferred_provenance));
    let mut provenance = if native_responses {
        V3HubExplicitHistoryProvenance {
            message_entries: message_provenance,
        }
    } else {
        V3HubExplicitHistoryProvenance::empty()
    };
    if native_responses && resolve_orphan_media {
        resolve_orphan_responses_tool_output_media(&mut messages, &mut provenance);
    }
    if messages.is_empty() {
        return Err("OpenAI Chat provider encoding produced no messages".to_string());
    }
    let mut request = root.clone();
    for mapped in [
        "input",
        // The continuation owner consumes this known protocol locator. It is
        // not an opaque business extension in canonical Chat.
        "previous_response_id",
        "instructions",
        "metadata",
        "client_metadata",
        "prompt_cache_key",
        "store",
        "text",
        "max_output_tokens",
        "reasoning",
    ] {
        request.remove(mapped);
    }
    if let Some(model) = root.get("model") {
        request.insert("model".to_string(), model.clone());
    }
    request.insert("messages".to_string(), Value::Array(messages));
    if !tools.is_empty() {
        request.insert("tools".to_string(), Value::Array(tools));
    } else if let Some(value) = root.get("tools").filter(|value| !value.is_null()) {
        request.insert("tools".to_string(), value.clone());
    }
    for key in [
        "tool_choice",
        "parallel_tool_calls",
        "user",
        "temperature",
        "top_p",
        "top_k",
        "logit_bias",
        "seed",
        "stream",
        "response_format",
        "max_tokens",
        "stop",
        "service_tier",
        "prompt_cache_retention",
        "background",
        "conversation",
        "max_tool_calls",
        "prompt",
        "truncation",
        "web_search_options",
        "thinking",
    ] {
        if let Some(value) = root.get(key) {
            request.insert(key.to_string(), value.clone());
        }
    }
    let mut responses_request_extension = Map::new();
    if let Some(metadata) = root.get("metadata") {
        if !metadata.is_object() {
            return Err("Responses metadata/client_metadata must be an object".to_string());
        }
        responses_request_extension.insert("metadata".to_string(), metadata.clone());
    }
    if let Some(client_metadata) = root.get("client_metadata") {
        if !client_metadata.is_object() {
            return Err("Responses metadata/client_metadata must be an object".to_string());
        }
        responses_request_extension.insert("client_metadata".to_string(), client_metadata.clone());
    }
    for key in ["prompt_cache_key", "store", "text"] {
        if let Some(value) = root.get(key) {
            responses_request_extension.insert(key.to_string(), value.clone());
        }
    }
    if !responses_request_extension.is_empty() {
        request.insert(
            "routecodex_chat_extension".to_string(),
            json!({"responses_request": Value::Object(responses_request_extension)}),
        );
    }
    if let Some(value) = root.get("max_output_tokens") {
        request
            .entry("max_completion_tokens".to_string())
            .or_insert_with(|| value.clone());
    }
    if let Some(value) = root.get("top_logprobs") {
        request.insert("logprobs".to_string(), Value::Bool(true));
        request.insert("top_logprobs".to_string(), value.clone());
    }
    project_responses_reasoning_to_chat_fields(root, &mut request)?;
    Ok((Value::Object(request), provenance))
}

fn project_responses_reasoning_to_chat_fields(
    root: &Map<String, Value>,
    request: &mut Map<String, Value>,
) -> Result<(), String> {
    if root.contains_key("reasoning_effort") {
        return Err(
            "Responses reasoning_effort is not a declared top-level Responses field".to_string(),
        );
    }
    let Some(reasoning) = root.get("reasoning") else {
        return Ok(());
    };
    let reasoning = reasoning
        .as_object()
        .ok_or_else(|| "Responses reasoning must be an object".to_string())?;
    for key in reasoning.keys() {
        if !matches!(
            key.as_str(),
            "effort" | "summary" | "generate_summary" | "context" | "mode"
        ) {
            return Err(format!("Unsupported Responses reasoning field: {key}"));
        }
    }
    if let Some(effort) = reasoning.get("effort").filter(|value| !value.is_null()) {
        let effort = effort
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Responses reasoning.effort must be a non-empty string".to_string())?;
        let normalized = effort.trim().to_ascii_lowercase();
        let effort = if matches!(
            normalized.as_str(),
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
        ) {
            normalized
        } else {
            effort.to_string()
        };
        request.insert("reasoning_effort".to_string(), Value::String(effort));
    }
    let summary = match (reasoning.get("summary"), reasoning.get("generate_summary")) {
        (Some(summary), Some(generate_summary)) if summary != generate_summary => {
            return Err(
                "Responses reasoning.summary conflicts with reasoning.generate_summary".to_string(),
            );
        }
        (Some(summary), _) | (_, Some(summary)) => Some(summary),
        (None, None) => None,
    };
    if let Some(summary) = summary.filter(|value| !value.is_null()) {
        if !summary
            .as_str()
            .is_some_and(|value| matches!(value, "auto" | "concise" | "detailed"))
        {
            return Err("Responses reasoning summary policy has an invalid value".to_string());
        }
        request.insert("reasoning_summary_policy".to_string(), summary.clone());
    }
    if let Some(context) = reasoning.get("context").filter(|value| !value.is_null()) {
        if !context
            .as_str()
            .is_some_and(|value| matches!(value, "auto" | "current_turn" | "all_turns"))
        {
            return Err("Responses reasoning.context has an invalid value".to_string());
        }
        request.insert("reasoning_context_policy".to_string(), context.clone());
    }
    if let Some(mode) = reasoning.get("mode").filter(|value| !value.is_null()) {
        if !mode.as_str().is_some_and(|value| !value.trim().is_empty()) {
            return Err("Responses reasoning.mode must be a non-empty string".to_string());
        }
        request.insert("reasoning_mode".to_string(), mode.clone());
    }
    Ok(())
}
fn initial_assistant_item_content_range(content: &Value) -> V3HubAssistantItemContentRange {
    if v3_openai_chat_content_is_empty(content) {
        return V3HubAssistantItemContentRange::Empty;
    }
    match content {
        Value::Array(parts) => V3HubAssistantItemContentRange::Parts {
            start: 0,
            end: parts.len(),
        },
        Value::String(text) => V3HubAssistantItemContentRange::TextRange {
            byte_start: 0,
            byte_end: text.len(),
        },
        _ => V3HubAssistantItemContentRange::Empty,
    }
}

fn hash_json_value(value: &Value, state: &mut u64) {
    fn feed_bytes(state: &mut u64, tag: u8, bytes: &[u8]) {
        const FNV_PRIME: u64 = 1099511628211;
        *state ^= u64::from(tag);
        *state = state.wrapping_mul(FNV_PRIME);
        *state ^= bytes.len() as u64;
        *state = state.wrapping_mul(FNV_PRIME);
        for &byte in bytes {
            *state ^= u64::from(byte);
            *state = state.wrapping_mul(FNV_PRIME);
        }
    }
    match value {
        Value::Null => feed_bytes(state, 0, &[]),
        Value::Bool(flag) => feed_bytes(state, 1, &[u8::from(*flag)]),
        Value::Number(num) => feed_bytes(state, 2, num.to_string().as_bytes()),
        Value::String(text) => feed_bytes(state, 3, text.as_bytes()),
        Value::Array(items) => {
            feed_bytes(state, 4, &items.len().to_le_bytes());
            for item in items {
                hash_json_value(item, state);
            }
        }
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            feed_bytes(state, 5, &entries.len().to_le_bytes());
            for (key, item) in entries {
                feed_bytes(state, 6, key.as_bytes());
                hash_json_value(item, state);
            }
        }
    }
}

pub(super) fn chat_content_digest(content: &Value) -> u64 {
    let mut state: u64 = 14695981039346656037;
    hash_json_value(comparable_chat_content(content), &mut state);
    state
}

fn attach_v3_responses_assistant_item_status(message: &mut Value, item: &Map<String, Value>) {
    let Some(status) = item.get("status").filter(|value| !value.is_null()) else {
        return;
    };
    let Some(message_obj) = message.as_object_mut() else {
        return;
    };
    let extension = message_obj
        .entry("routecodex_chat_extension".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(extension_obj) = extension.as_object_mut() {
        extension_obj.insert(
            RESPONSES_ASSISTANT_ITEM_STATUSES_EXTENSION.to_string(),
            Value::Array(vec![status.clone()]),
        );
    }
}

fn extract_v3_responses_assistant_item_statuses(
    message: &Map<String, Value>,
    count: usize,
) -> Vec<Value> {
    let mut statuses = message
        .get("routecodex_chat_extension")
        .and_then(Value::as_object)
        .and_then(|ext| ext.get(RESPONSES_ASSISTANT_ITEM_STATUSES_EXTENSION))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    statuses.resize(count, Value::Null);
    statuses
}

fn build_v3_responses_assistant_item_provenance(
    message: &Value,
    item: &Map<String, Value>,
    input_index: usize,
) -> V3HubAssistantItemProvenance {
    V3HubAssistantItemProvenance {
        source_input_order: Some(input_index as u64),
        content_range: initial_assistant_item_content_range(
            message.get("content").unwrap_or(&Value::Null),
        ),
        id: read_v3_non_empty_str(item.get("id")).map(str::to_string),
    }
}

fn attach_v3_responses_reasoning_input_order(
    message: &mut Value,
    item: &Map<String, Value>,
    input_index: usize,
) -> Vec<Option<u64>> {
    let mut decoder_entry = Map::new();
    if let Some(item_id) = read_v3_non_empty_str(item.get("id")) {
        decoder_entry.insert("id".to_string(), Value::String(item_id.to_string()));
    }
    if let Some(Value::String(signature)) = item.get("encrypted_content") {
        decoder_entry.insert(
            "encrypted_content".to_string(),
            Value::String(signature.clone()),
        );
    }
    if let Some(summary) = item
        .get("summary")
        .and_then(Value::as_array)
        .filter(|value| !value.is_empty())
    {
        decoder_entry.insert("summary".to_string(), Value::Array(summary.clone()));
    }
    if let Some(content) = item.get("content").filter(|value| !value.is_null()) {
        decoder_entry.insert("content".to_string(), content.clone());
    }
    if let Some(text) = item.get("text").filter(|value| !value.is_null()) {
        decoder_entry.insert("text".to_string(), text.clone());
    }
    if !decoder_entry.contains_key("summary")
        && !decoder_entry.contains_key("content")
        && !decoder_entry.contains_key("text")
        && read_v3_non_empty_str(item.get("id")).is_none()
    {
        if let Some(reasoning_text) = message
            .get("reasoning_content")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            decoder_entry.insert(
                "summary".to_string(),
                Value::Array(vec![
                    json!({"type": "summary_text", "text": reasoning_text}),
                ]),
            );
        }
    }
    let Some(extension) = message
        .get_mut("routecodex_chat_extension")
        .and_then(Value::as_object_mut)
    else {
        return Vec::new();
    };
    let mut ordered = extension
        .get(RESPONSES_REASONING_ITEMS_EXTENSION)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let orders = if let Some(item_id) = read_v3_non_empty_str(item.get("id")) {
        if !ordered.iter().any(|entry| entry["id"] == item_id) {
            ordered.push(Value::Object(decoder_entry));
        }
        ordered
            .iter()
            .map(|entry| (entry["id"] == item_id).then_some(input_index as u64))
            .collect()
    } else if !decoder_entry.is_empty() || ordered.is_empty() {
        let mut orders = vec![None; ordered.len()];
        ordered.push(Value::Object(decoder_entry));
        orders.push(Some(input_index as u64));
        orders
    } else {
        vec![Some(input_index as u64); ordered.len()]
    };
    extension.insert(
        RESPONSES_REASONING_ITEMS_EXTENSION.to_string(),
        Value::Array(ordered),
    );
    orders
}

pub(super) fn resolve_orphan_responses_tool_output_media(
    messages: &mut [Value],
    provenance: &mut V3HubExplicitHistoryProvenance,
) {
    let mut seen_calls: std::collections::HashMap<String, Vec<Option<u64>>> =
        std::collections::HashMap::new();
    for (msg_idx, message) in messages.iter_mut().enumerate() {
        let is_tool_row = message.get("role").and_then(Value::as_str) == Some("tool");
        let is_named_output_row = message
            .pointer("/routecodex_chat_extension/responses_tool_output_name")
            .is_some()
            && message.get("tool_call_id").is_none();
        if is_tool_row || is_named_output_row {
            let call_id = is_tool_row
                .then(|| message.get("tool_call_id").and_then(Value::as_str))
                .flatten();
            let output_order = provenance.message_order(msg_idx);
            let paired = call_id.is_some_and(|id| {
                seen_calls.get(id).is_some_and(|call_orders| {
                    call_orders
                        .iter()
                        .any(|call_order| match (call_order, output_order) {
                            (Some(call_pos), Some(output_pos)) => call_pos < &output_pos,
                            _ => true,
                        })
                })
            });
            if !paired {
                let entry_ref = provenance.message_entries.get(msg_idx);
                let is_decoder_native =
                    entry_ref.is_some_and(|entry| entry.decoder_native_tool_output);
                let is_decoder_captured =
                    entry_ref.is_some_and(|entry| entry.decoder_captured_responses_tool_output);
                if is_decoder_native {
                    if is_decoder_captured {
                        if let Some(raw_output) = message
                            .pointer("/routecodex_chat_extension/responses_tool_output_content")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                        {
                            // An orphan (call-ID or named output) has no declared tool media semantics.
                            message["content"] = Value::String(raw_output);
                        }
                    }
                    if message.get("content").is_some_and(Value::is_string) {
                        if let Some(entry) = provenance.message_entries.get_mut(msg_idx) {
                            entry.preserve_orphan_tool_output_literal = true;
                        }
                    }
                }
            }
        }
        for (call_idx, call_id) in collect_v3_openai_chat_tool_call_ids_with_indices(message) {
            seen_calls
                .entry(call_id)
                .or_default()
                .push(provenance.tool_call_order(msg_idx, call_idx));
        }
    }
}

pub(crate) fn append_v3_openai_chat_message_preserving_tool_adjacency(
    messages: &mut Vec<Value>,
    pending_tool_message_index: &mut Option<usize>,
    pending_tool_adjacent_deferred_messages: &mut Vec<Value>,
    message: Value,
    turn_assistant_tail_index: Option<usize>,
) -> Result<(), String> {
    let mut unused_provenance = Vec::new();
    let mut unused_deferred_provenance = Vec::new();
    append_v3_openai_chat_message_preserving_tool_adjacency_with_provenance(
        messages,
        &mut unused_provenance,
        pending_tool_message_index,
        pending_tool_adjacent_deferred_messages,
        &mut unused_deferred_provenance,
        message,
        V3HubMessageHistoryProvenance::default(),
        turn_assistant_tail_index,
    )
}

#[allow(clippy::too_many_arguments)]
fn append_v3_openai_chat_message_preserving_tool_adjacency_with_provenance(
    messages: &mut Vec<Value>,
    message_provenance: &mut Vec<V3HubMessageHistoryProvenance>,
    pending_tool_message_index: &mut Option<usize>,
    pending_tool_adjacent_deferred_messages: &mut Vec<Value>,
    pending_deferred_provenance: &mut Vec<V3HubMessageHistoryProvenance>,
    message: Value,
    provenance: V3HubMessageHistoryProvenance,
    turn_assistant_tail_index: Option<usize>,
) -> Result<(), String> {
    if let Some(index) = *pending_tool_message_index {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .trim();
        if role.eq_ignore_ascii_case("assistant") {
            merge_v3_openai_chat_message_into_pending_tool_message(
                messages,
                message_provenance,
                index,
                &message,
                provenance,
            )?;
            return Ok(());
        }
        pending_tool_adjacent_deferred_messages.push(message);
        pending_deferred_provenance.push(provenance);
        return Ok(());
    } else if let Some(tail_index) = turn_assistant_tail_index {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .trim();
        if role.eq_ignore_ascii_case("assistant")
            && messages.len() == tail_index + 1
            && (v3_openai_chat_content_is_empty(
                messages[tail_index].get("content").unwrap_or(&Value::Null),
            ) || v3_openai_chat_content_is_empty(
                message.get("content").unwrap_or(&Value::Null),
            ))
        {
            merge_v3_openai_chat_message_into_pending_tool_message(
                messages,
                message_provenance,
                tail_index,
                &message,
                provenance,
            )?;
            return Ok(());
        }
    }
    messages.push(message);
    message_provenance.push(provenance);
    Ok(())
}

fn append_v3_openai_chat_tool_call_message_with_provenance(
    messages: &mut Vec<Value>,
    message_provenance: &mut Vec<V3HubMessageHistoryProvenance>,
    pending_tool_message_index: &mut Option<usize>,
    pending_tool_call_ids: &mut Vec<String>,
    message: Value,
    provenance: V3HubMessageHistoryProvenance,
    turn_assistant_tail_index: Option<usize>,
) -> Result<(), String> {
    let call_ids = collect_v3_openai_chat_tool_call_ids(&message);
    if call_ids.is_empty() {
        messages.push(message);
        message_provenance.push(provenance);
        return Ok(());
    }
    if let Some(index) = *pending_tool_message_index {
        merge_v3_openai_chat_message_into_pending_tool_message(
            messages,
            message_provenance,
            index,
            &message,
            provenance,
        )?;
    } else if let Some(tail_index) = turn_assistant_tail_index {
        if messages.len() == tail_index + 1 {
            merge_v3_openai_chat_message_into_pending_tool_message(
                messages,
                message_provenance,
                tail_index,
                &message,
                provenance,
            )?;
            *pending_tool_message_index = Some(tail_index);
        } else {
            messages.push(message);
            message_provenance.push(provenance);
            *pending_tool_message_index = Some(messages.len() - 1);
        }
    } else {
        messages.push(message);
        message_provenance.push(provenance);
        *pending_tool_message_index = Some(messages.len() - 1);
    }
    for call_id in call_ids {
        if !pending_tool_call_ids.iter().any(|entry| entry == &call_id) {
            pending_tool_call_ids.push(call_id);
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_v3_openai_chat_tool_result_message_with_provenance(
    messages: &mut Vec<Value>,
    message_provenance: &mut Vec<V3HubMessageHistoryProvenance>,
    pending_tool_message_index: &mut Option<usize>,
    pending_tool_call_ids: &mut Vec<String>,
    pending_tool_adjacent_deferred_messages: &mut Vec<Value>,
    pending_deferred_provenance: &mut Vec<V3HubMessageHistoryProvenance>,
    message: Value,
    provenance: V3HubMessageHistoryProvenance,
) -> Result<(), String> {
    let call_id = message
        .get("tool_call_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(call_id) = call_id {
        if let Some(position) = pending_tool_call_ids
            .iter()
            .position(|entry| entry == &call_id)
        {
            messages.push(message);
            message_provenance.push(provenance);
            pending_tool_call_ids.remove(position);
            if pending_tool_call_ids.is_empty() {
                *pending_tool_message_index = None;
                messages.extend(std::mem::take(pending_tool_adjacent_deferred_messages));
                message_provenance.extend(std::mem::take(pending_deferred_provenance));
            }
            return Ok(());
        }
    }
    messages.push(message);
    message_provenance.push(provenance);
    Ok(())
}

fn merge_v3_openai_chat_message_into_pending_tool_message(
    messages: &mut [Value],
    message_provenance: &mut [V3HubMessageHistoryProvenance],
    index: usize,
    source: &Value,
    source_provenance: V3HubMessageHistoryProvenance,
) -> Result<(), String> {
    let target = messages
        .get_mut(index)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            "OpenAI Chat provider encoding pending tool message is not an object".to_string()
        })?;
    let target_assistant_count = message_provenance
        .get(index)
        .map_or(0, |prov| prov.assistant_items.len());
    let source_assistant_count = source_provenance.assistant_items.len();
    let existing_assistant_statuses =
        extract_v3_responses_assistant_item_statuses(target, target_assistant_count);
    let source_assistant_statuses = source
        .as_object()
        .map(|obj| extract_v3_responses_assistant_item_statuses(obj, source_assistant_count))
        .unwrap_or_else(|| vec![Value::Null; source_assistant_count]);
    let target_content_before = target.get("content").cloned().unwrap_or(Value::Null);
    let source_content_val = source.get("content").unwrap_or(&Value::Null);
    let target_empty = v3_openai_chat_content_is_empty(&target_content_before);
    let source_empty = v3_openai_chat_content_is_empty(source_content_val);
    let mut merged_assistant_items_and_digest: Option<(Vec<V3HubAssistantItemProvenance>, u64)> =
        None;
    if let Some(target_prov) = message_provenance.get_mut(index) {
        if target_prov.message_input_order.is_none() {
            target_prov.message_input_order = source_provenance.message_input_order;
        }
        target_prov.tool_calls.extend(source_provenance.tool_calls);
        target_prov
            .reasoning_item_orders
            .extend(source_provenance.reasoning_item_orders);
        target_prov.omit_tool_output_id |= source_provenance.omit_tool_output_id;
        target_prov.preserve_native_tool_output_id |=
            source_provenance.preserve_native_tool_output_id;
        target_prov.decoder_native_tool_output |= source_provenance.decoder_native_tool_output;
        target_prov.decoder_captured_responses_tool_output |=
            source_provenance.decoder_captured_responses_tool_output;

        let mut source_items = source_provenance.assistant_items;
        if source_empty {
            target_prov.assistant_items.extend(source_items);
            if target_prov.assistant_content_digest.is_none()
                && !target_prov.assistant_items.is_empty()
            {
                target_prov.assistant_content_digest =
                    Some(chat_content_digest(&target_content_before));
            }
        } else if target_empty {
            target_prov.assistant_items.extend(source_items);
            target_prov.assistant_content_digest = Some(chat_content_digest(source_content_val));
        } else if let (Value::String(existing_text), Value::String(source_text)) =
            (&target_content_before, source_content_val)
        {
            let separator_len =
                usize::from(!existing_text.trim().is_empty() && !source_text.trim().is_empty());
            let offset = existing_text.len() + separator_len;
            for item in &mut source_items {
                if let V3HubAssistantItemContentRange::TextRange {
                    byte_start,
                    byte_end,
                } = item.content_range
                {
                    item.content_range = V3HubAssistantItemContentRange::TextRange {
                        byte_start: offset + byte_start,
                        byte_end: offset + byte_end,
                    };
                }
            }
            target_prov.assistant_items.extend(source_items);
        } else {
            let mut merged_parts = if let Value::String(existing_str) = &target_content_before {
                let has_text_ranges = target_prov.assistant_items.iter().any(|item| {
                    matches!(
                        item.content_range,
                        V3HubAssistantItemContentRange::TextRange { .. }
                    )
                });
                if has_text_ranges {
                    let mut parts = Vec::new();
                    for item in &mut target_prov.assistant_items {
                        if let V3HubAssistantItemContentRange::TextRange {
                            byte_start,
                            byte_end,
                        } = item.content_range
                        {
                            let idx = parts.len();
                            parts.push(
                                json!({"type": "text", "text": &existing_str[byte_start..byte_end]}),
                            );
                            item.content_range = V3HubAssistantItemContentRange::Parts {
                                start: idx,
                                end: idx + 1,
                            };
                        }
                    }
                    parts
                } else {
                    v3_openai_chat_content_to_parts(&target_content_before)
                }
            } else {
                v3_openai_chat_content_to_parts(&target_content_before)
            };
            let prefix_len = merged_parts.len();
            let source_parts = v3_openai_chat_content_to_parts(source_content_val);
            let source_parts_len = source_parts.len();
            merged_parts.extend(source_parts);
            for item in &mut source_items {
                item.content_range = match item.content_range {
                    V3HubAssistantItemContentRange::Empty => V3HubAssistantItemContentRange::Empty,
                    V3HubAssistantItemContentRange::Parts { start, end } => {
                        V3HubAssistantItemContentRange::Parts {
                            start: prefix_len + start,
                            end: prefix_len + end,
                        }
                    }
                    V3HubAssistantItemContentRange::TextRange { .. } => {
                        V3HubAssistantItemContentRange::Parts {
                            start: prefix_len,
                            end: prefix_len + source_parts_len,
                        }
                    }
                };
            }
            target_prov.assistant_items.extend(source_items);
            let merged_array = Value::Array(merged_parts);
            let digest = chat_content_digest(&merged_array);
            merged_assistant_items_and_digest = Some((Vec::new(), digest));
            target.insert("content".to_string(), merged_array);
        }
    }
    if let Some(source_tool_calls) = source.get("tool_calls").and_then(Value::as_array) {
        let target_tool_calls = target
            .entry("tool_calls".to_string())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| {
                "OpenAI Chat provider encoding pending tool_calls is not an array".to_string()
            })?;
        target_tool_calls.extend(source_tool_calls.iter().cloned());
    }
    if merged_assistant_items_and_digest.is_none() {
        if let Some(source_content) = source.get("content") {
            merge_v3_openai_chat_message_content(target, source_content);
        }
    }
    if let Some(target_prov) = message_provenance.get_mut(index) {
        if let Some((_, digest)) = merged_assistant_items_and_digest {
            target_prov.assistant_content_digest = Some(digest);
        } else if !source_empty && !target_prov.assistant_items.is_empty() {
            target_prov.assistant_content_digest = target.get("content").map(chat_content_digest);
        }
    }
    if let Some(source_reasoning) = source
        .get("reasoning_content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let existing = target
            .get("reasoning_content")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default();
        let merged = if existing.trim().is_empty() {
            source_reasoning.to_string()
        } else {
            format!("{existing}\n{source_reasoning}")
        };
        target.insert("reasoning_content".to_string(), Value::String(merged));
    }
    if let Some(source_extension) = source.get("routecodex_chat_extension") {
        // Keep every Responses reasoning id/cipher association in source order.
        // The canonical assistant message may fold several provider-origin
        // reasoning items, so the ordered list is the complete business
        // association while the legacy scalar fields remain compatibility
        // projections of the first item.
        let existing_items = target
            .get("routecodex_chat_extension")
            .and_then(Value::as_object)
            .and_then(|extension| extension.get(RESPONSES_REASONING_ITEMS_EXTENSION))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let existing_signature = target
            .get("routecodex_chat_extension")
            .and_then(Value::as_object)
            .and_then(|extension| extension.get("responses_reasoning_encrypted_content"))
            .cloned();
        chat_extension_merge::merge_chat_extension(target, source_extension)?;
        let source_items = source_extension
            .get(RESPONSES_REASONING_ITEMS_EXTENSION)
            .and_then(Value::as_array);
        let mut ordered_items = existing_items;
        if let Some(source_items) = source_items {
            ordered_items.extend(source_items.iter().cloned());
        }
        if let Some(extension) = target
            .get_mut("routecodex_chat_extension")
            .and_then(Value::as_object_mut)
        {
            if !ordered_items.is_empty() {
                extension.insert(
                    RESPONSES_REASONING_ITEMS_EXTENSION.to_string(),
                    Value::Array(ordered_items),
                );
            }
            if let Some(signature) = existing_signature {
                extension.insert(
                    "responses_reasoning_encrypted_content".to_string(),
                    signature,
                );
            }
        }
    }
    if target_assistant_count > 0 || source_assistant_count > 0 {
        let mut merged_statuses = existing_assistant_statuses;
        merged_statuses.extend(source_assistant_statuses);
        if merged_statuses.iter().any(|value| !value.is_null()) {
            let extension = target
                .entry("routecodex_chat_extension".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(extension_obj) = extension.as_object_mut() {
                extension_obj.insert(
                    RESPONSES_ASSISTANT_ITEM_STATUSES_EXTENSION.to_string(),
                    Value::Array(merged_statuses),
                );
            }
        } else if let Some(extension_obj) = target
            .get_mut("routecodex_chat_extension")
            .and_then(Value::as_object_mut)
        {
            extension_obj.remove(RESPONSES_ASSISTANT_ITEM_STATUSES_EXTENSION);
            if extension_obj.is_empty() {
                target.remove("routecodex_chat_extension");
            }
        }
    }
    Ok(())
}

fn merge_v3_openai_chat_message_content(target: &mut Map<String, Value>, source_content: &Value) {
    if v3_openai_chat_content_is_empty(source_content) {
        return;
    }
    let Some(existing) = target.get_mut("content") else {
        target.insert("content".to_string(), source_content.clone());
        return;
    };
    if v3_openai_chat_content_is_empty(existing) {
        *existing = source_content.clone();
        return;
    }
    match (existing, source_content) {
        (Value::String(existing_text), Value::String(source_text)) => {
            if !existing_text.trim().is_empty() && !source_text.trim().is_empty() {
                existing_text.push('\n');
            }
            existing_text.push_str(source_text);
        }
        (existing_value, source_value) => {
            let mut parts = v3_openai_chat_content_to_parts(existing_value);
            parts.extend(v3_openai_chat_content_to_parts(source_value));
            *existing_value = Value::Array(parts);
        }
    }
}

pub(super) fn v3_openai_chat_content_is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.trim().is_empty(),
        Value::Array(parts) => parts.is_empty(),
        _ => false,
    }
}

fn v3_openai_chat_content_to_parts(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(parts) => parts.clone(),
        Value::String(text) => {
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![json!({"type":"text","text":text})]
            }
        }
        Value::Null => Vec::new(),
        other => vec![other.clone()],
    }
}

fn v3_openai_chat_message_has_visible_payload(message: &Value) -> bool {
    message
        .get("content")
        .is_some_and(|content| !v3_openai_chat_content_is_empty(content))
        || message
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|tool_calls| !tool_calls.is_empty())
}

pub(super) fn collect_v3_openai_chat_tool_call_ids(message: &Value) -> Vec<String> {
    collect_v3_openai_chat_tool_call_ids_with_indices(message)
        .into_iter()
        .map(|(_, id)| id)
        .collect()
}

pub(super) fn collect_v3_openai_chat_tool_call_ids_with_indices(
    message: &Value,
) -> Vec<(usize, String)> {
    message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|tool_calls| {
            tool_calls
                .iter()
                .enumerate()
                .filter_map(|(index, call)| {
                    let call_id = call
                        .get("id")
                        .or_else(|| call.get("call_id"))
                        .or_else(|| call.get("tool_call_id"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)?;
                    Some((index, call_id))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(crate) fn build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(
    payload: &Value,
) -> Result<Value, String> {
    build_v3_chat_canonical_request_from_responses_payload(payload)
}

pub(super) fn build_v3_chat_canonical_request_from_responses_payload_for_req_inbound_compat(
    payload: &Value,
) -> Result<Value, String> {
    build_v3_chat_canonical_request_from_responses_payload_for_req_inbound_compat_with_orphan_resolution(
        payload, true,
    )
    .map(|(request, _)| request)
}

pub(super) fn build_v3_chat_canonical_request_from_responses_payload_for_merge_with_provenance(
    payload: &Value,
) -> Result<(Value, V3HubExplicitHistoryProvenance), String> {
    build_v3_chat_canonical_request_from_responses_payload_for_req_inbound_compat_with_orphan_resolution(
        payload, false,
    )
}

fn build_v3_chat_canonical_request_from_responses_payload_for_req_inbound_compat_with_orphan_resolution(
    payload: &Value,
    resolve_orphan_media: bool,
) -> Result<(Value, V3HubExplicitHistoryProvenance), String> {
    let (mut request, provenance) =
        build_v3_chat_canonical_request_from_responses_semantic_with_orphan_resolution(
            payload,
            V3HubEntryProtocol::Responses,
            resolve_orphan_media,
        )?;
    let root_tool_count = payload
        .get("tools")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if let Some(tools) = request.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools.iter_mut().take(root_tool_count) {
            normalize_v3_codex_integer_tool_schema(tool);
        }
    }
    Ok((request, provenance))
}

/// Convert a finalized Responses `message` output item into a canonical Chat
/// assistant message for a refill continuation history. The Chat Process owns
/// continuation construction; this codec owns the Responses-to-Chat content
/// projection, so the continuation reuses the exact same conversion the inbound
/// canonicalization already applies.
pub(crate) fn build_v3_chat_assistant_message_from_responses_output_item(
    item: &Value,
) -> Result<Value, String> {
    let item = item.as_object().ok_or_else(|| {
        "Responses message output item must be an object before Chat assistant encoding".to_string()
    })?;
    build_v3_openai_chat_message_from_responses_message(item)
}

/// Convert a finalized Responses `reasoning` output item into a canonical Chat
/// assistant message carrying the provider-origin reasoning content and opaque
/// signature association. RCC-synthesized reasoning has no provider identity
/// and is omitted by the caller before this helper runs.
pub(crate) fn build_v3_chat_assistant_reasoning_message_from_responses_output_item(
    item: &Value,
) -> Option<Value> {
    let item = item.as_object()?;
    build_v3_openai_chat_assistant_reasoning_message(item)
}

fn build_v3_openai_chat_message_from_responses_message(
    item: &Map<String, Value>,
) -> Result<Value, String> {
    let role = item
        .get("role")
        .and_then(Value::as_str)
        .map(v3_openai_chat_wire_role)
        .unwrap_or("user");
    let (content, mut reasoning_segments) =
        build_v3_openai_chat_content_from_responses_content(item.get("content"))?;
    reasoning_segments.extend(collect_v3_openai_chat_reasoning_segments(
        item.get("reasoning_content")
            .or_else(|| item.get("reasoning_text"))
            .or_else(|| item.get("thinking")),
    ));
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String(role.to_string()));
    message.insert("content".to_string(), content);
    if let Some(reasoning_content) =
        join_v3_openai_chat_reasoning_segments(reasoning_segments.as_slice())
    {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(reasoning_content.clone()),
        );
        retain_anthropic_reasoning_block_for_message(item, &reasoning_content, &mut message)?;
    }
    Ok(Value::Object(message))
}

fn build_v3_openai_chat_assistant_output_text_message(item: &Map<String, Value>) -> Value {
    let content = item
        .get("text")
        .or_else(|| item.get("content"))
        .or_else(|| item.get("output"))
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => serde_json::to_string(other).unwrap_or_else(|_| String::new()),
        })
        .unwrap_or_default();
    json!({"role":"assistant", "content":content})
}

fn build_v3_openai_chat_assistant_reasoning_message(item: &Map<String, Value>) -> Option<Value> {
    // 提取 reasoning 条目的明文段（text/content/summary/reasoning_content/thinking）。
    // 无任何明文（如 Codex 只回传 encrypted_content 密文、密文在 wire 层已剥离）时
    // 仍保留 reasoning 条目并以空 reasoning_content 呈现——opencode/DeepSeek 语义要求
    // 每条 assistant 消息都必须带 reasoning 表示（transform.ts 对缺失轮补
    // `{type:"reasoning", text:""}`；空 reasoning_content 是 DeepSeek 标准接受的回传形态）。
    // 直接丢弃会让该轮 assistant 消息缺 reasoning，触发 "reasoning_content must be passed
    // back" 400。
    let reasoning_content = join_v3_openai_chat_reasoning_segments(
        collect_v3_openai_chat_reasoning_segments(Some(&Value::Object(item.clone()))).as_slice(),
    )
    .unwrap_or_default();
    let mut message = json!({
        "role":"assistant",
        "content":"",
        "reasoning_content":reasoning_content
    });
    if let Some(extension) = item.get("routecodex_chat_extension") {
        let mut extension = extension.clone();
        if let Some(extension) = extension.as_object_mut() {
            // Client-supplied order/assistant-item fields on reasoning carriers
            // must never override decoder-owned history provenance.
            extension.remove("responses_tool_input_order");
            extension.remove(RESPONSES_ASSISTANT_ITEMS_EXTENSION);
            if let Some(entries) = extension
                .get_mut(RESPONSES_REASONING_ITEMS_EXTENSION)
                .and_then(Value::as_array_mut)
            {
                for entry in entries {
                    if let Some(object) = entry.as_object_mut() {
                        object.remove("source_input_order");
                    }
                }
            }
            retain_anthropic_reasoning_block_association(item, &reasoning_content, extension);
        }
        message["routecodex_chat_extension"] = extension;
    } else {
        let mut extension = Map::new();
        retain_anthropic_reasoning_block_association(item, &reasoning_content, &mut extension);
        message["routecodex_chat_extension"] = Value::Object(extension);
    }
    // Preserve the Responses reasoning `encrypted_content` as an opaque business
    // association so the Anthropic outbound projection can restore the exact
    // thinking signature. Present-empty and non-empty both pass through; an
    // absent field leaves the key absent.
    if let Some(Value::String(signature)) = item.get("encrypted_content") {
        if let Some(extension) = message
            .get_mut("routecodex_chat_extension")
            .and_then(Value::as_object_mut)
        {
            extension.insert(
                "responses_reasoning_encrypted_content".to_string(),
                Value::String(signature.clone()),
            );
        } else {
            message["routecodex_chat_extension"] = json!({
                "responses_reasoning_encrypted_content": signature
            });
        }
    }
    // Carry the Responses reasoning item identity so an outbound Chat->Responses
    // projection can restore a reasoning input item even when the plaintext
    // summary is empty. Every provider-origin reasoning item in the same turn
    // keeps its complete id/cipher pair in source order so a continuation does
    // not collapse distinct reasoning items into one.
    let provider_item_id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty());
    if let Some(item_id) = provider_item_id {
        if let Some(extension) = message
            .get_mut("routecodex_chat_extension")
            .and_then(Value::as_object_mut)
        {
            extension.insert(
                "responses_reasoning_item_id".to_string(),
                Value::String(item_id.to_string()),
            );
            let mut ordered = extension
                .get(RESPONSES_REASONING_ITEMS_EXTENSION)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut entry = Map::new();
            entry.insert("id".to_string(), Value::String(item_id.to_string()));
            if let Some(Value::String(signature)) = item.get("encrypted_content") {
                entry.insert(
                    "encrypted_content".to_string(),
                    Value::String(signature.clone()),
                );
            }
            if let Some(summary) = item
                .get("summary")
                .and_then(Value::as_array)
                .filter(|value| !value.is_empty())
            {
                entry.insert("summary".to_string(), Value::Array(summary.clone()));
            }
            if let Some(content) = item.get("content").filter(|value| !value.is_null()) {
                entry.insert("content".to_string(), content.clone());
            }
            if let Some(text) = item.get("text").filter(|value| !value.is_null()) {
                entry.insert("text".to_string(), text.clone());
            }
            if !ordered.iter().any(|entry| entry["id"] == item_id) {
                ordered.push(Value::Object(entry));
            }
            extension.insert(
                RESPONSES_REASONING_ITEMS_EXTENSION.to_string(),
                Value::Array(ordered),
            );
        }
    }
    Some(message)
}

fn retain_anthropic_reasoning_block_association(
    item: &Map<String, Value>,
    reasoning_content: &str,
    extension: &mut Map<String, Value>,
) {
    let anthropic_reasoning = extension
        .get(ANTHROPIC_REASONING_EXTENSION)
        .and_then(Value::as_object);
    if extension
        .get(ANTHROPIC_REASONING_BLOCKS_EXTENSION)
        .and_then(Value::as_array)
        .is_some_and(|blocks| !blocks.is_empty())
    {
        return;
    }
    let mut block = Map::new();
    let native_type = anthropic_reasoning
        .and_then(|extension| extension.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            // `encrypted_content: null` is a present key without ciphertext.
            // Only non-empty ciphertext can form a legal `redacted_thinking`
            // block; key presence alone would fabricate a data-less block.
            let has_encrypted_content = item
                .get("encrypted_content")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty());
            if reasoning_content.trim().is_empty() && has_encrypted_content {
                "redacted_thinking"
            } else {
                "thinking"
            }
        });
    block.insert("type".to_string(), Value::String(native_type.to_string()));
    block.insert(
        "reasoning_content".to_string(),
        Value::String(reasoning_content.to_string()),
    );
    if let Some(encrypted_content) = item.get("encrypted_content") {
        block.insert("encrypted_content".to_string(), encrypted_content.clone());
    }
    if let Some(anthropic_reasoning) = anthropic_reasoning {
        block.insert(
            ANTHROPIC_REASONING_EXTENSION.to_string(),
            Value::Object(anthropic_reasoning.clone()),
        );
    }
    extension.insert(
        ANTHROPIC_REASONING_BLOCKS_EXTENSION.to_string(),
        Value::Array(vec![Value::Object(block)]),
    );
}

fn retain_anthropic_reasoning_block_for_message(
    item: &Map<String, Value>,
    reasoning_content: &str,
    message: &mut Map<String, Value>,
) -> Result<(), String> {
    let mut extension = match item.get("routecodex_chat_extension") {
        Some(extension) => extension
            .as_object()
            .cloned()
            .ok_or_else(|| "reasoning routecodex_chat_extension is not an object".to_string())?,
        None => Map::new(),
    };
    retain_anthropic_reasoning_block_association(item, reasoning_content, &mut extension);
    message.insert(
        "routecodex_chat_extension".to_string(),
        Value::Object(extension),
    );
    Ok(())
}

fn build_v3_openai_chat_assistant_tool_call_message(
    item: &Map<String, Value>,
) -> Result<Value, String> {
    let call_id = read_v3_non_empty_str(item.get("call_id"))
        .or_else(|| read_v3_non_empty_str(item.get("tool_call_id")))
        .or_else(|| read_v3_non_empty_str(item.get("id")))
        .ok_or_else(|| {
            "Responses function_call is missing call_id/id before OpenAI Chat encoding".to_string()
        })?;
    let name = read_v3_non_empty_str(item.get("name"))
        .or_else(|| {
            item.get("function")
                .and_then(Value::as_object)
                .and_then(|function| read_v3_non_empty_str(function.get("name")))
        })
        .ok_or_else(|| {
            "Responses function_call is missing name before OpenAI Chat encoding".to_string()
        })?;
    let tool_call = project_v3_responses_tool_call_to_openai_chat(item, call_id, name);
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String("assistant".to_string()));
    if item.contains_key("content") {
        let (content, _) =
            build_v3_openai_chat_content_from_responses_content(item.get("content"))?;
        message.insert("content".to_string(), content);
    }
    message.insert("tool_calls".to_string(), Value::Array(vec![tool_call]));
    if let Some(reasoning_content) = join_v3_openai_chat_reasoning_segments(
        collect_v3_openai_chat_reasoning_segments(
            item.get("reasoning_content")
                .or_else(|| item.get("reasoning_text"))
                .or_else(|| item.get("thinking")),
        )
        .as_slice(),
    ) {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(reasoning_content.clone()),
        );
        retain_anthropic_reasoning_block_for_message(item, &reasoning_content, &mut message)?;
    }
    Ok(Value::Object(message))
}

/// The request and response adapters use the same reversible Chat encoding.
pub(crate) fn project_v3_responses_tool_call_to_openai_chat(
    item: &Map<String, Value>,
    call_id: &str,
    name: &str,
) -> Value {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    let name = if let Some(namespace) = read_v3_non_empty_str(item.get("namespace")) {
        if item_type == "custom_tool_call" {
            format!("{namespace}.{name}")
        } else {
            format!("{namespace}__{name}")
        }
    } else {
        name.to_string()
    };
    let arguments = if item_type == "custom_tool_call" {
        item.get("input")
            .map(|input| json!({ "input": input }).to_string())
    } else {
        item.get("arguments")
            .or_else(|| {
                item.get("function")
                    .and_then(|function| function.get("arguments"))
            })
            .map(|arguments| match arguments {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
    };
    let mut function = Map::new();
    function.insert("name".to_string(), Value::String(name));
    if let Some(arguments) = arguments {
        function.insert("arguments".to_string(), Value::String(arguments));
    }
    let mut tool_call = json!({
        "id": call_id,
        "type": "function",
        "function": Value::Object(function)
    });
    if let Some(signature) = item.get("thought_signature") {
        tool_call["thought_signature"] = signature.clone();
    }
    let responses_item_id = read_v3_verbatim_non_empty_str(item.get("id"));
    if item_type == "custom_tool_call" || responses_item_id.is_some() {
        let mut extension = Map::new();
        if item_type == "custom_tool_call" {
            extension.insert(
                "responses_tool_call_type".to_string(),
                Value::String("custom_tool_call".to_string()),
            );
        }
        if let Some(item_id) = responses_item_id {
            extension.insert(
                "responses_item_id".to_string(),
                Value::String(item_id.to_string()),
            );
        }
        if let Some(object) = tool_call.as_object_mut() {
            object.insert(
                "routecodex_chat_extension".to_string(),
                Value::Object(extension),
            );
        }
    }
    tool_call
}

fn build_v3_openai_chat_tool_result_message(
    item: &Map<String, Value>,
    native_responses: bool,
) -> Result<(Value, bool), String> {
    let call_id = read_v3_non_empty_str(item.get("tool_call_id"))
        .or_else(|| read_v3_non_empty_str(item.get("call_id")))
        .or_else(|| read_v3_non_empty_str(item.get("tool_use_id")));
    let output = item
        .get("output")
        .or_else(|| item.get("content"))
        .ok_or("Responses tool output is missing output/content before OpenAI Chat encoding")?;
    let content = tool_output::canonical_content(output)?;
    let item_type = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("function_call_output");
    let mut extension = Map::new();
    extension.insert("responses_tool_output_type".to_string(), json!(item_type));
    if let Some(item_id) = read_v3_verbatim_non_empty_str(item.get("id")) {
        extension.insert("responses_item_id".to_string(), json!(item_id));
    }
    let decoder_captured_responses_tool_output =
        native_responses && (output.is_string() || output.is_array());
    if decoder_captured_responses_tool_output {
        extension.insert("responses_tool_output_content".to_string(), output.clone());
    }
    let extra_fields: Map<String, Value> = item
        .iter()
        .filter(|(key, _)| {
            !matches!(
                key.as_str(),
                "type"
                    | "id"
                    | "status"
                    | "call_id"
                    | "tool_call_id"
                    | "tool_use_id"
                    | "output"
                    | "content"
                    | "routecodex_chat_extension"
            ) && !(call_id.is_none() && matches!(key.as_str(), "name" | "namespace"))
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if !extra_fields.is_empty() {
        extension.insert(
            "responses_tool_output_extra_fields".to_string(),
            Value::Object(extra_fields),
        );
    }
    let Some(call_id) = call_id else {
        // 命名无配对输出：name/namespace 是配对身份，不得伪造 call_id。Chat 的 tool 角色
        // 只能按 tool_call_id 配对，故以 user 角色承载 output 并保留注册扩展身份。
        let name = read_v3_non_empty_str(item.get("name")).ok_or(
            "Responses tool output is missing call_id/tool_call_id before OpenAI Chat encoding",
        )?;
        let mut named_extension = extension;
        named_extension.insert("responses_tool_output_name".to_string(), json!(name));
        if let Some(namespace) = read_v3_non_empty_str(item.get("namespace")) {
            named_extension.insert(
                "responses_tool_output_namespace".to_string(),
                json!(namespace),
            );
        }
        copy_v3_responses_tool_result_status(item, &mut named_extension)?;
        copy_v3_anthropic_tool_result_is_error(item, &mut named_extension);
        return Ok((
            json!({
                "role":"user",
                "content":content,
                "routecodex_chat_extension":Value::Object(named_extension)
            }),
            decoder_captured_responses_tool_output,
        ));
    };
    copy_v3_responses_tool_result_status(item, &mut extension)?;
    copy_v3_anthropic_tool_result_is_error(item, &mut extension);
    Ok((
        json!({
            "role":"tool",
            "tool_call_id":call_id,
            "content":content,
            "routecodex_chat_extension":Value::Object(extension)
        }),
        decoder_captured_responses_tool_output,
    ))
}

fn copy_v3_responses_tool_result_status(
    item: &Map<String, Value>,
    extension: &mut Map<String, Value>,
) -> Result<(), String> {
    match item.get("status") {
        None => Ok(()),
        Some(_) if !matches!(item["status"].as_str(), Some("completed" | "incomplete")) => {
            Err(TOOL_RESULT_STATUS_ERROR.to_string())
        }
        Some(status) => {
            extension.insert("responses_tool_output_status".to_string(), status.clone());
            Ok(())
        }
    }
}

fn copy_v3_anthropic_tool_result_is_error(
    item: &Map<String, Value>,
    extension: &mut Map<String, Value>,
) {
    if let Some(Value::Object(source)) = item.get("routecodex_chat_extension") {
        if let Some(is_error) = source.get("anthropic_tool_result_is_error") {
            extension.insert(
                "anthropic_tool_result_is_error".to_string(),
                is_error.clone(),
            );
        }
    }
}

const TOOL_RESULT_STATUS_ERROR: &str = "Responses function_call_output.status must be completed or incomplete before OpenAI Chat encoding";

#[derive(Clone, Copy)]
enum V3OpenAiChatHostedToolHistoryKind {
    WebSearch,
    ToolSearch,
}

impl V3OpenAiChatHostedToolHistoryKind {
    fn responses_item_type(self) -> &'static str {
        match self {
            Self::WebSearch => "web_search_call",
            Self::ToolSearch => "tool_search_call",
        }
    }

    fn openai_chat_function_name(self) -> &'static str {
        match self {
            Self::WebSearch => "web_search",
            Self::ToolSearch => "tool_search",
        }
    }

    fn synthetic_call_id_prefix(self) -> &'static str {
        match self {
            Self::WebSearch => "call_routecodex_web_search",
            Self::ToolSearch => "call_routecodex_tool_search",
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn append_v3_openai_chat_hosted_tool_call_history_pair(
    messages: &mut Vec<Value>,
    message_provenance: &mut Vec<V3HubMessageHistoryProvenance>,
    pending_tool_message_index: &mut Option<usize>,
    pending_tool_call_ids: &mut Vec<String>,
    pending_tool_adjacent_deferred_messages: &mut Vec<Value>,
    pending_deferred_provenance: &mut Vec<V3HubMessageHistoryProvenance>,
    item: &Map<String, Value>,
    input_index: usize,
    kind: V3OpenAiChatHostedToolHistoryKind,
    native_responses: bool,
) -> Result<(), String> {
    let call_id = build_v3_openai_chat_hosted_tool_history_call_id(item, input_index, kind);
    let assistant =
        build_v3_openai_chat_hosted_tool_assistant_tool_call_message(item, call_id.as_str(), kind)?;
    let assistant_prov = V3HubMessageHistoryProvenance {
        tool_calls: vec![V3HubToolCallHistoryProvenance {
            source_input_order: native_responses.then_some(input_index as u64),
            suppress_responses_hosted_call: native_responses
                && matches!(kind, V3OpenAiChatHostedToolHistoryKind::WebSearch),
        }],
        ..Default::default()
    };
    let mut tool_result =
        build_v3_openai_chat_hosted_tool_result_message(item, call_id.as_str(), kind)?;
    if native_responses {
        tool_result["routecodex_chat_extension"]["responses_tool_output_type"] =
            json!(kind.responses_item_type());
    }
    let result_prov = V3HubMessageHistoryProvenance {
        message_input_order: native_responses.then_some(input_index as u64),
        preserve_native_tool_output_id: native_responses,
        restore_responses_hosted_web_search: native_responses
            && matches!(kind, V3OpenAiChatHostedToolHistoryKind::WebSearch),
        ..Default::default()
    };
    append_v3_openai_chat_tool_call_message_with_provenance(
        messages,
        message_provenance,
        pending_tool_message_index,
        pending_tool_call_ids,
        assistant,
        assistant_prov,
        None,
    )?;
    append_v3_openai_chat_tool_result_message_with_provenance(
        messages,
        message_provenance,
        pending_tool_message_index,
        pending_tool_call_ids,
        pending_tool_adjacent_deferred_messages,
        pending_deferred_provenance,
        tool_result,
        result_prov,
    )
}

fn build_v3_openai_chat_hosted_tool_history_call_id(
    item: &Map<String, Value>,
    input_index: usize,
    kind: V3OpenAiChatHostedToolHistoryKind,
) -> String {
    read_v3_non_empty_str(item.get("call_id"))
        .or_else(|| read_v3_non_empty_str(item.get("tool_call_id")))
        .or_else(|| read_v3_non_empty_str(item.get("id")))
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}_{}", kind.synthetic_call_id_prefix(), input_index))
}

fn build_v3_openai_chat_hosted_tool_assistant_tool_call_message(
    item: &Map<String, Value>,
    call_id: &str,
    kind: V3OpenAiChatHostedToolHistoryKind,
) -> Result<Value, String> {
    let arguments_value = build_v3_openai_chat_hosted_tool_arguments_value(item, kind);
    let mut extension = Map::new();
    extension.insert(
        "responses_tool_call_type".to_string(),
        Value::String(kind.responses_item_type().to_string()),
    );
    let mut function = json!({"name":kind.openai_chat_function_name()});
    if let Some(arguments_value) = arguments_value {
        let raw_string = matches!(kind, V3OpenAiChatHostedToolHistoryKind::ToolSearch)
            && arguments_value.is_string();
        let arguments = if raw_string {
            arguments_value.as_str().unwrap().to_string()
        } else {
            serde_json::to_string(&arguments_value).map_err(|error| error.to_string())?
        };
        function["arguments"] = Value::String(arguments);
        if matches!(kind, V3OpenAiChatHostedToolHistoryKind::ToolSearch) {
            extension.insert(
                "responses_arguments_serialized".to_string(),
                Value::Bool(!raw_string),
            );
        }
    }
    copy_v3_responses_item_extension_fields(item, &mut extension);
    Ok(json!({
        "role": "assistant",
        "content": "",
        "tool_calls": [{
            "id": call_id,
            "type": "function",
            "function": function,
            "routecodex_chat_extension": Value::Object(extension)
        }]
    }))
}

fn build_v3_openai_chat_tool_search_output_message(
    item: &Map<String, Value>,
) -> Result<Value, String> {
    let call_id = read_v3_non_empty_str(item.get("call_id")).ok_or_else(|| {
        "Responses tool_search_output is missing call_id before Chat canonicalization".to_string()
    })?;
    let tools = item.get("tools").and_then(Value::as_array).ok_or_else(|| {
        "Responses tool_search_output is missing tools array before Chat canonicalization"
            .to_string()
    })?;
    let content = serde_json::to_string(tools).map_err(|error| error.to_string())?;
    let mut extension = Map::new();
    extension.insert(
        "responses_tool_output_type".to_string(),
        Value::String("tool_search_output".to_string()),
    );
    extension.insert(
        "responses_output_field".to_string(),
        Value::String("tools".to_string()),
    );
    copy_v3_responses_item_extension_fields(item, &mut extension);
    Ok(json!({
        "role": "tool",
        "tool_call_id": call_id,
        "content": content,
        "routecodex_chat_extension": Value::Object(extension)
    }))
}

fn copy_v3_responses_item_extension_fields(
    item: &Map<String, Value>,
    extension: &mut Map<String, Value>,
) {
    for source in ["id", "status", "execution"] {
        if let Some(value) = item.get(source) {
            if let Some(target) = table_map_field("openai_chat", source, V3TableDirection::Inbound)
                .ok()
                .flatten()
            {
                extension.insert(target.to_string(), value.clone());
            }
        }
    }
}

fn build_v3_openai_chat_hosted_tool_arguments_value(
    item: &Map<String, Value>,
    kind: V3OpenAiChatHostedToolHistoryKind,
) -> Option<Value> {
    let source = match kind {
        V3OpenAiChatHostedToolHistoryKind::WebSearch => item.get("action"),
        V3OpenAiChatHostedToolHistoryKind::ToolSearch => {
            item.get("arguments").or_else(|| item.get("action"))
        }
    };
    if matches!(kind, V3OpenAiChatHostedToolHistoryKind::ToolSearch) {
        return source.cloned();
    }
    Some(match source {
        Some(Value::Object(object)) => Value::Object(object.clone()),
        Some(value) => json!({ "value": value }),
        None => Value::Object(Map::new()),
    })
}

fn build_v3_openai_chat_hosted_tool_result_message(
    item: &Map<String, Value>,
    call_id: &str,
    kind: V3OpenAiChatHostedToolHistoryKind,
) -> Result<Value, String> {
    let event = build_v3_openai_chat_hosted_tool_result_event(item, kind);
    let content = serde_json::to_string(&event).map_err(|error| error.to_string())?;
    Ok(json!({"role":"tool","tool_call_id":call_id,"content":content}))
}

fn build_v3_openai_chat_hosted_tool_result_event(
    item: &Map<String, Value>,
    kind: V3OpenAiChatHostedToolHistoryKind,
) -> Value {
    let mut event = Map::new();
    for key in [
        "type",
        "id",
        "call_id",
        "tool_call_id",
        "status",
        "action",
        "arguments",
        "execution",
        "result",
        "result_items",
        "results",
        "output",
        "error",
        "errors",
    ] {
        if let Some(value) = item.get(key) {
            event.insert(key.to_string(), value.clone());
        }
    }
    for (key, value) in item {
        if key == "routecodex_chat_extension" || event.contains_key(key) {
            continue;
        }
        event.insert(key.clone(), value.clone());
    }
    if !event.contains_key("type") {
        event.insert(
            "type".to_string(),
            Value::String(kind.responses_item_type().to_string()),
        );
    }
    Value::Object(event)
}

fn build_v3_openai_chat_content_from_responses_content(
    content: Option<&Value>,
) -> Result<(Value, Vec<String>), String> {
    let Some(content) = content else {
        return Ok((Value::String(String::new()), Vec::new()));
    };
    if let Some(text) = content.as_str() {
        return Ok((Value::String(text.to_string()), Vec::new()));
    }
    let Some(parts) = content.as_array() else {
        return Ok((Value::String(content.to_string()), Vec::new()));
    };
    let mut converted_parts = Vec::new();
    let mut reasoning_segments = Vec::new();
    for part in parts {
        let object = part.as_object().ok_or_else(|| {
            "Responses message content part must be an object before OpenAI Chat encoding"
                .to_string()
        })?;
        match object.get("type").and_then(Value::as_str) {
            Some("input_text" | "output_text" | "text") => {
                let mut converted = object.clone();
                converted.insert("type".to_string(), Value::String("text".to_string()));
                if let Some(text) = converted.get_mut("text") {
                    if !text.is_string() {
                        *text = Value::String(text.to_string());
                    }
                }
                converted_parts.push(Value::Object(converted));
            }
            Some("reasoning_text" | "thinking" | "reasoning") => {
                reasoning_segments.extend(collect_v3_openai_chat_reasoning_segments(Some(part)));
            }
            Some("input_image" | "image_url") => {
                converted_parts.push(convert_v3_responses_image_part_to_openai_chat_part(object));
            }
            Some("refusal") => {
                // A provider refusal is legal business content: preserve it
                // faithfully in the continuation history rather than treating
                // the whole assistant message as unsupported.
                let mut converted = object.clone();
                if let Some(text) = converted.get_mut("refusal") {
                    if !text.is_string() {
                        *text = Value::String(text.to_string());
                    }
                }
                converted_parts.push(Value::Object(converted));
            }
            Some(other) => {
                return Err(format!(
                    "unsupported Responses message content part for OpenAI Chat provider encoding: {other}"
                ));
            }
            None => {
                return Err(
                    "Responses message content part is missing type before OpenAI Chat encoding"
                        .to_string(),
                );
            }
        }
    }
    Ok((Value::Array(converted_parts), reasoning_segments))
}

fn collect_v3_openai_chat_reasoning_segments(value: Option<&Value>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    match value {
        Value::String(text) => read_v3_trimmed_owned(text).into_iter().collect(),
        Value::Array(items) => items
            .iter()
            .flat_map(|item| collect_v3_openai_chat_reasoning_segments(Some(item)))
            .collect(),
        Value::Object(row) => {
            // Codex 回传的 reasoning item 常带显式 `content: null` 占位（明文在
            // `summary`），JSON null 等价于缺失，必须按 key 顺序取第一个非 null 值。
            let mut picked = None;
            for key in [
                "text",
                "content",
                "summary",
                "reasoning_content",
                "thinking",
            ] {
                if let Some(value) = row.get(key).filter(|value| !value.is_null()) {
                    picked = Some(value);
                    break;
                }
            }
            picked
                .into_iter()
                .flat_map(|item| collect_v3_openai_chat_reasoning_segments(Some(item)))
                .collect()
        }
        _ => Vec::new(),
    }
}

fn join_v3_openai_chat_reasoning_segments(segments: &[String]) -> Option<String> {
    let joined = segments
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    read_v3_trimmed_owned(joined.as_str())
}

fn read_v3_trimmed_owned(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn convert_v3_responses_image_part_to_openai_chat_part(part: &Map<String, Value>) -> Value {
    let image_url = responses_image_url(part);
    let source_key = image_url.as_ref().and_then(|_| {
        ["image_url", "url", "file_url", "data"]
            .into_iter()
            .find(|key| part.contains_key(*key))
    });
    let mut converted = part.clone();
    converted.insert("type".to_string(), Value::String("image_url".to_string()));
    if let Some(source_key) = source_key {
        if source_key != "image_url" {
            converted.remove(source_key);
        }
        if source_key == "data"
            && part
                .get("data")
                .and_then(Value::as_str)
                .is_some_and(|data| !data.starts_with("data:image/"))
        {
            if let Some(media_type_key) = ["media_type", "mime_type"]
                .into_iter()
                .find(|key| part.contains_key(*key))
            {
                converted.remove(media_type_key);
            }
        }
        let nested_detail_already_present = part
            .get(source_key)
            .and_then(Value::as_object)
            .is_some_and(|source| source.contains_key("detail"));
        if !nested_detail_already_present {
            converted.remove("detail");
        }
    }
    converted.insert(
        "image_url".to_string(),
        image_url.unwrap_or_else(|| json!({"url":null})),
    );
    Value::Object(converted)
}

fn v3_openai_chat_wire_role(role: &str) -> &str {
    match role {
        "developer" => "system",
        other => other,
    }
}

fn read_v3_non_empty_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn read_v3_verbatim_non_empty_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn normalize_v3_codex_integer_tool_schema(tool: &mut Value) {
    let Some(tool_object) = tool.as_object_mut() else {
        return;
    };
    let tool_name = tool_object.get("name").and_then(Value::as_str).or_else(|| {
        tool_object
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)
    });
    let Some(tool_name) = tool_name else {
        return;
    };
    let is_registered_codex_schema = match tool_name {
        "exec_command" => is_registered_codex_tool_schema(
            tool_object,
            &[
                "cmd",
                "justification",
                "login",
                "max_output_tokens",
                "prefix_rule",
                "sandbox_permissions",
                "shell",
                "tty",
                "workdir",
                "yield_time_ms",
            ],
            &["cmd"],
        ),
        "write_stdin" => is_registered_codex_tool_schema(
            tool_object,
            &["chars", "max_output_tokens", "session_id", "yield_time_ms"],
            &["session_id"],
        ),
        _ => false,
    };
    if !is_registered_codex_schema {
        return;
    }
    let integer_fields: &[&str] = match tool_name {
        "exec_command" => &["yield_time_ms", "max_output_tokens"],
        "write_stdin" => &["session_id", "yield_time_ms", "max_output_tokens"],
        _ => return,
    };
    let parameters = if tool_object.contains_key("parameters") {
        tool_object.get_mut("parameters")
    } else {
        tool_object
            .get_mut("function")
            .and_then(Value::as_object_mut)
            .and_then(|function| function.get_mut("parameters"))
    };
    let Some(properties) = parameters
        .and_then(Value::as_object_mut)
        .and_then(|parameters| parameters.get_mut("properties"))
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    for field in integer_fields {
        if properties
            .get(*field)
            .and_then(Value::as_object)
            .and_then(|property| property.get("type"))
            .and_then(Value::as_str)
            == Some("number")
        {
            if let Some(property) = properties.get_mut(*field).and_then(Value::as_object_mut) {
                property.insert("type".to_string(), Value::String("integer".to_string()));
            }
        }
    }
}

pub(crate) fn is_registered_codex_tool_schema(
    tool: &Map<String, Value>,
    property_names: &[&str],
    required_names: &[&str],
) -> bool {
    let tool_name = tool.get("name").and_then(Value::as_str);
    let expected_description = match tool_name {
        Some("exec_command") => Some("Runs a command in a PTY, returning output or a session ID."),
        Some("write_stdin") => {
            Some("Writes characters to an existing unified exec session and returns recent output.")
        }
        _ => None,
    };
    let description = tool.get("description").and_then(Value::as_str);
    let registered_description = description == expected_description
        || (tool_name == Some("exec_command")
            && description
                == Some(
                    "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
                ));
    if !tool.keys().all(|key| {
        matches!(
            key.as_str(),
            "description" | "name" | "parameters" | "strict" | "type"
        )
    }) || !registered_description
    {
        return false;
    }
    if tool.get("type").and_then(Value::as_str) != Some("function")
        || tool.get("strict").and_then(Value::as_bool) != Some(false)
    {
        return false;
    }
    let Some(parameters) = tool.get("parameters").and_then(Value::as_object) else {
        return false;
    };
    if parameters.get("type").and_then(Value::as_str) != Some("object")
        || parameters
            .get("additionalProperties")
            .and_then(Value::as_bool)
            != Some(false)
    {
        return false;
    }
    let Some(properties) = parameters.get("properties").and_then(Value::as_object) else {
        return false;
    };
    let Some(required) = parameters.get("required").and_then(Value::as_array) else {
        return false;
    };
    let expected_types = [
        ("cmd", "string"),
        ("justification", "string"),
        ("login", "boolean"),
        ("prefix_rule", "array"),
        ("sandbox_permissions", "string"),
        ("shell", "string"),
        ("tty", "boolean"),
        ("workdir", "string"),
        ("chars", "string"),
    ];
    let schema_properties_are_registered = properties.iter().all(|(name, property)| {
        let Some(property) = property.as_object() else {
            return false;
        };
        if !property
            .keys()
            .all(|key| matches!(key.as_str(), "type" | "description" | "items" | "enum"))
        {
            return false;
        }
        if property.get("items").is_some()
            && property
                .get("items")
                .and_then(Value::as_object)
                .and_then(|items| items.get("type"))
                .and_then(Value::as_str)
                != Some("string")
        {
            return false;
        }
        if property.get("enum").is_some()
            && !property
                .get("enum")
                .and_then(Value::as_array)
                .is_some_and(|values| values.iter().all(Value::is_string))
        {
            return false;
        }
        match name.as_str() {
            "prefix_rule" => property.get("items").is_some(),
            "sandbox_permissions" => property.get("enum").is_some(),
            _ => property.get("items").is_none() && property.get("enum").is_none(),
        }
    });
    properties.len() == property_names.len()
        && property_names
            .iter()
            .all(|name| properties.contains_key(*name))
        && schema_properties_are_registered
        && expected_types.iter().all(|(name, expected)| {
            if !property_names.contains(name) {
                true
            } else {
                properties
                    .get(*name)
                    .and_then(Value::as_object)
                    .and_then(|property| property.get("type"))
                    .and_then(Value::as_str)
                    == Some(*expected)
            }
        })
        && required.len() == required_names.len()
        && required.iter().all(|value| {
            value
                .as_str()
                .is_some_and(|name| required_names.contains(&name))
        })
}

#[cfg(test)]
#[path = "responses_openai_codec_tests.rs"]
mod responses_openai_codec_tests;

#[cfg(test)]
#[path = "responses_openai_codec_extra_tests.rs"]
mod responses_openai_codec_extra_tests;
