use super::V3HubEntryProtocol;
use serde_json::{json, Map, Value};

use crate::projection_drop_log::{
    resolve_v3_json_path, split_v3_json_path, V3JsonPathSegment, V3ProjectionDropContext,
    V3ProjectionDropRecord,
};

use super::anthropic_request_field_projection::project_chat_store_to_anthropic_wire;
use super::request_outbound_builtin_tool_projection::is_openai_responses_hosted_web_search_tool;
use super::request_outbound_builtin_tool_projection::project_openai_chat_provider_tools_for_web_search_mode_recording;
use super::request_outbound_builtin_tool_projection::project_openai_responses_hosted_web_search_options_for_selected_target;
use super::request_outbound_builtin_tool_projection::promote_tool_search_output_tools_to_provider_tools;
use super::request_outbound_builtin_tool_projection::provider_tool_declaration_sources;
use super::request_outbound_declaration_emission::rewrite_direct_history_call_names;
use super::request_outbound_declaration_emission::StandardOutboundDeclarationObserver;
use super::request_outbound_metadata::{
    project_openai_chat_reasoning_context_policy,
    project_openai_chat_reasoning_effort_from_reasoning,
    project_openai_chat_reasoning_summary_policy, project_openai_client_metadata_to_metadata,
    validate_openai_metadata,
};
use std::collections::BTreeSet;
#[path = "request_outbound_responses_items.rs"]
mod request_outbound_responses_items;
pub(crate) use self::request_outbound_responses_items::build_responses_input_from_chat_messages;
use self::request_outbound_responses_items::build_responses_input_from_chat_messages_with_hosted_emissions;
use provider_compat_core::namespace_tools::flatten_namespace_tool_for_provider_with_sources;
use provider_compat_core::namespace_tools::namespace_tool_name_map;
pub(crate) fn build_v3_openai_chat_standard_request_from_chat_canonical(
    payload: &Value,
) -> Result<Value, String> {
    build_v3_openai_chat_standard_request_from_chat_canonical_recording(
        payload,
        &V3ProjectionDropContext::disabled(),
    )
    .map(|(value, _drops)| value)
}

/// stage-3 openai_chat 出站投影的 non-error carrier 版本：返回投影值 + 丢弃记录。
pub(crate) fn build_v3_openai_chat_standard_request_from_chat_canonical_recording(
    payload: &Value,
    drop_context: &V3ProjectionDropContext,
) -> Result<(Value, Vec<V3ProjectionDropRecord>), String> {
    if payload.get("messages").and_then(Value::as_array).is_none() {
        return Err("OpenAI Chat provider wire requires Chat canonical messages".to_string());
    }
    normalize_openai_chat_messages_payload(
        payload,
        None,
        routecodex_v3_config::V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
        true,
        drop_context,
        None,
    )
}
pub fn build_v3_openai_chat_standard_request_for_selected_web_search_mode(
    payload: &Value,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    has_web_search_capability: bool,
) -> Result<Value, String> {
    build_v3_openai_chat_standard_request_for_selected_web_search_mode_recording(
        payload,
        web_search_execution_mode,
        has_web_search_capability,
        &V3ProjectionDropContext::disabled(),
    )
    .map(|(value, _drops)| value)
}

/// 同上，携带显式 web search mode 的 non-error carrier 版本。
pub(crate) fn build_v3_openai_chat_standard_request_for_selected_web_search_mode_recording(
    payload: &Value,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    has_web_search_capability: bool,
    drop_context: &V3ProjectionDropContext,
) -> Result<(Value, Vec<V3ProjectionDropRecord>), String> {
    if payload.get("messages").and_then(Value::as_array).is_none() {
        return Err("OpenAI Chat provider wire requires Chat canonical messages".to_string());
    }
    // gpt 系列判定基准是客户端请求的模型名（payload.model），与路由后的
    // provider manifest 模型无关。
    normalize_openai_chat_messages_payload(
        payload,
        payload.get("model").and_then(Value::as_str),
        web_search_execution_mode,
        has_web_search_capability,
        drop_context,
        None,
    )
}

/// Standard Chat provider request plus the typed declaration mappings produced
/// while emitting provider tools. The declaration list is returned physically
/// separate from the payload; callers bind it into the attempt declaration map.
///
/// `inverse` is the request's original inverse context and `current` is the
/// request's current field association slot. Each emitted provider declaration
/// is associated with the original canonical source tool that currently lives
/// at the emitted structural path; the immutable inverse destination is never
/// used for post-governance matching. The payload is byte-identical to the
/// observer-free standard builder.
pub(crate) fn build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations_inner(
    payload: &Value,
    inverse: &crate::operation_runner::RequestInverseContext,
    current: &crate::operation_runner::CurrentFieldAssociations,
    model_id: Option<&str>,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    has_web_search_capability: bool,
    drop_context: &V3ProjectionDropContext,
) -> Result<
    (
        Value,
        Vec<V3ProjectionDropRecord>,
        Vec<crate::operation_runner::ToolMappingReference>,
    ),
    String,
> {
    if payload.get("messages").and_then(Value::as_array).is_none() {
        return Err("OpenAI Chat provider wire requires Chat canonical messages".to_string());
    }
    let mut observer = StandardOutboundDeclarationObserver::new(inverse, current);
    let hosted_emissions =
        crate::operation_runner::project_hosted_history_emissions(payload, inverse, current)?;
    let payload = crate::operation_runner::project_canonical_standard_view(payload)?;
    let (normalized, drops) = normalize_openai_chat_messages_payload_with_hosted_history(
        &payload,
        model_id,
        web_search_execution_mode,
        has_web_search_capability,
        drop_context,
        Some(&mut observer),
        &hosted_emissions,
        inverse.entry_protocol == "responses",
    )?;
    Ok((normalized, drops, observer.into_mappings()))
}

pub(crate) fn build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations(
    payload: &Value,
    inverse: &crate::operation_runner::RequestInverseContext,
    current: &crate::operation_runner::CurrentFieldAssociations,
) -> Result<(Value, Vec<crate::operation_runner::ToolMappingReference>), String> {
    let (payload, _drops, declarations) =
        build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations_inner(
            payload,
            inverse,
            current,
            None,
            routecodex_v3_config::V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
            true,
            &V3ProjectionDropContext::disabled(),
        )?;
    Ok((payload, declarations))
}

pub(crate) fn build_v3_openai_chat_standard_request_from_chat_canonical_for_selected_with_declarations(
    payload: &Value,
    inverse: &crate::operation_runner::RequestInverseContext,
    current: &crate::operation_runner::CurrentFieldAssociations,
    model_id: Option<&str>,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    has_web_search_capability: bool,
) -> Result<
    (
        Value,
        Vec<V3ProjectionDropRecord>,
        Vec<crate::operation_runner::ToolMappingReference>,
    ),
    String,
> {
    build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations_inner(
        payload,
        inverse,
        current,
        model_id,
        web_search_execution_mode,
        has_web_search_capability,
        &V3ProjectionDropContext::disabled(),
    )
}
pub(crate) fn build_v3_openai_responses_standard_request_from_chat_canonical(
    payload: &Value,
) -> Result<Value, String> {
    build_v3_openai_responses_standard_request_for_selected_target(payload, true)
}

/// Standard Responses provider request plus the typed declaration mappings
/// produced while emitting the preserved Responses tool declarations.
///
/// The observer is threaded through the same Responses projection used by the
/// observer-free builder. Namespace containers stay in the payload; their
/// emitted children are recorded at their structural destination paths. Origin
/// identity comes from the request's current field association slot, never from
/// the immutable inverse destination.
fn build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations_inner(
    payload: &Value,
    inverse: &crate::operation_runner::RequestInverseContext,
    current: &crate::operation_runner::CurrentFieldAssociations,
    has_web_search_capability: bool,
) -> Result<
    (
        Value,
        Vec<V3ProjectionDropRecord>,
        Vec<crate::operation_runner::ToolMappingReference>,
    ),
    String,
> {
    let hosted_emissions =
        crate::operation_runner::project_hosted_history_emissions(payload, inverse, current)?;
    let payload = crate::operation_runner::project_canonical_standard_view(payload)?;
    let mut observer = StandardOutboundDeclarationObserver::new(inverse, current);
    let (projected, drops) =
        build_v3_openai_responses_standard_request_for_selected_target_with_observer_and_drops_and_emissions(
            &payload,
            has_web_search_capability,
            Some(&mut observer),
            Some(hosted_emissions.as_slice()),
        )?;
    Ok((projected, drops, observer.into_mappings()))
}

pub(crate) fn build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations(
    payload: &Value,
    inverse: &crate::operation_runner::RequestInverseContext,
    current: &crate::operation_runner::CurrentFieldAssociations,
) -> Result<(Value, Vec<crate::operation_runner::ToolMappingReference>), String> {
    let (payload, _drops, declarations) =
        build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations_inner(
            payload, inverse, current, true,
        )?;
    Ok((payload, declarations))
}

pub(crate) fn build_v3_openai_responses_standard_request_from_chat_canonical_for_selected_with_declarations(
    payload: &Value,
    inverse: &crate::operation_runner::RequestInverseContext,
    current: &crate::operation_runner::CurrentFieldAssociations,
    has_web_search_capability: bool,
) -> Result<
    (
        Value,
        Vec<V3ProjectionDropRecord>,
        Vec<crate::operation_runner::ToolMappingReference>,
    ),
    String,
> {
    build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations_inner(
        payload,
        inverse,
        current,
        has_web_search_capability,
    )
}

pub(crate) fn build_v3_openai_responses_standard_request_for_selected_target(
    payload: &Value,
    has_web_search_capability: bool,
) -> Result<Value, String> {
    let drop_context = V3ProjectionDropContext::disabled();
    let (value, mut drops) =
        build_v3_openai_responses_standard_request_for_selected_target_with_drops(
            payload,
            has_web_search_capability,
        )?;
    drop_context.restamp_and_emit(&mut drops);
    Ok(value)
}

/// non-error carrier：把投影阶段的丢弃记录交给请求作用域盖章落盘。
pub(crate) fn build_v3_openai_responses_standard_request_for_selected_target_with_drops(
    payload: &Value,
    has_web_search_capability: bool,
) -> Result<(Value, Vec<V3ProjectionDropRecord>), String> {
    build_v3_openai_responses_standard_request_for_selected_target_with_observer_and_drops(
        payload,
        has_web_search_capability,
        None,
    )
}

fn build_v3_openai_responses_standard_request_for_selected_target_with_observer_and_drops(
    payload: &Value,
    has_web_search_capability: bool,
    observer: Option<&mut StandardOutboundDeclarationObserver<'_>>,
) -> Result<(Value, Vec<V3ProjectionDropRecord>), String> {
    build_v3_openai_responses_standard_request_for_selected_target_with_observer_and_drops_and_emissions(
        payload,
        has_web_search_capability,
        observer,
        None,
    )
}

fn build_v3_openai_responses_standard_request_for_selected_target_with_observer_and_drops_and_emissions(
    payload: &Value,
    has_web_search_capability: bool,
    mut observer: Option<&mut StandardOutboundDeclarationObserver<'_>>,
    hosted_emissions: Option<&[crate::operation_runner::HostedHistoryEmission]>,
) -> Result<(Value, Vec<V3ProjectionDropRecord>), String> {
    if payload.get("previous_response_id").is_some() {
        return Err(
            "UnmappedOutboundFields target_protocol=responses paths=$.previous_response_id"
                .to_string(),
        );
    }
    let (mut projected, drops) =
        build_v3_openai_responses_request_from_chat_canonical_with_drops_and_emissions(
            payload,
            has_web_search_capability,
            observer.as_mut().map(|observer| &mut **observer),
            hosted_emissions,
        )?;
    project_openai_responses_hosted_web_search_options_for_selected_target(
        &mut projected,
        has_web_search_capability,
    );
    Ok((projected, drops))
}

fn build_v3_openai_responses_request_from_chat_canonical(payload: &Value) -> Result<Value, String> {
    let drop_context = V3ProjectionDropContext::disabled();
    let (value, mut drops) =
        build_v3_openai_responses_request_from_chat_canonical_with_drops(payload, true, None)?;
    drop_context.restamp_and_emit(&mut drops);
    Ok(value)
}

/// non-error carrier：把投影阶段的丢弃记录交给请求作用域盖章落盘。
fn build_v3_openai_responses_request_from_chat_canonical_with_drops(
    payload: &Value,
    has_web_search_capability: bool,
    observer: Option<&mut StandardOutboundDeclarationObserver<'_>>,
) -> Result<(Value, Vec<V3ProjectionDropRecord>), String> {
    build_v3_openai_responses_request_from_chat_canonical_with_drops_and_emissions(
        payload,
        has_web_search_capability,
        observer,
        None,
    )
}

fn build_v3_openai_responses_request_from_chat_canonical_with_drops_and_emissions(
    payload: &Value,
    has_web_search_capability: bool,
    mut observer: Option<&mut StandardOutboundDeclarationObserver<'_>>,
    hosted_emissions: Option<&[crate::operation_runner::HostedHistoryEmission]>,
) -> Result<(Value, Vec<V3ProjectionDropRecord>), String> {
    if payload.get("reasoning").is_some() {
        return Err(
            "RawPayloadShortcut target_protocol=responses path=$.reasoning; use registered Chat reasoning fields"
                .to_string(),
        );
    }
    let (projected_source, drops) = project_outbound_payload_for_target_protocol_with_drops(
        payload,
        V3OutboundTargetProtocol::OpenAiResponses,
    )?;
    let messages = projected_source
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Responses provider wire requires Chat canonical messages".to_string())?;
    let mut responses_payload = Map::new();
    if let Some(model) = projected_source.get("model") {
        responses_payload.insert("model".to_string(), model.clone());
    }
    responses_payload.insert(
        "input".to_string(),
        build_responses_input_from_chat_messages_with_hosted_emissions(messages, hosted_emissions)?,
    );
    for key in [
        "tools",
        "tool_choice",
        "instructions",
        "temperature",
        "top_p",
        "top_k",
        "max_output_tokens",
        "max_completion_tokens",
        "max_tokens",
        "top_logprobs",
        "logprobs",
        "stream",
        "parallel_tool_calls",
        "user",
        "logit_bias",
        "seed",
        "response_format",
        "include",
        "reasoning",
        "thinking",
        "metadata",
        "safety_identifier",
        "moderation",
        "stream_options",
        "stop",
        "service_tier",
        "prompt_cache_key",
        "prompt_cache_retention",
        "store",
        "background",
        "conversation",
        "max_tool_calls",
        "prompt",
        "text",
        "truncation",
        "web_search_options",
    ] {
        if key != "tools" {
            if let Some(value) = projected_source.get(key) {
            responses_payload.insert(key.to_string(), value.clone());
            }
        }
    }
    if let Some(tools) = project_openai_responses_tools_with_emission(
        payload,
        has_web_search_capability,
        observer.as_mut().map(|observer| &mut **observer),
    )? {
        responses_payload.insert("tools".to_string(), tools);
    }
    // The same declaration traversal converts historical call names to the
    // emitted flat provider names. The provider wire no longer rewrites
    // history, and declaration-less convention guessing is not performed.
    let mut namespace_names = std::collections::HashMap::new();
    if let Some(tools) = payload.get("tools").and_then(Value::as_array) {
        for tool in tools {
            if let Some(mapping) = namespace_tool_name_map(tool)? {
                namespace_names.extend(mapping);
            }
        }
    }
    let mut responses_payload = Value::Object(responses_payload);
    rewrite_direct_history_call_names(&mut responses_payload, &namespace_names);
    Ok((
        normalize_responses_payload_for_provider_standard(&responses_payload)?,
        drops,
    ))
}

fn project_openai_responses_tools_with_emission(
    payload: &Value,
    has_web_search_capability: bool,
    mut observer: Option<&mut StandardOutboundDeclarationObserver<'_>>,
) -> Result<Option<Value>, String> {
    if let Some(tools) = payload.get("tools").filter(|tools| !tools.is_array()) {
        return Ok(Some(tools.clone()));
    }
    let sources = provider_tool_declaration_sources(payload)?;
    if sources.is_empty() && payload.get("tools").is_none() {
        return Ok(None);
    }
    let mut emitted = Vec::with_capacity(sources.len());
    for (canonical_source_path, tool) in &sources {
        if !has_web_search_capability && is_openai_responses_hosted_web_search_tool(tool) {
            continue;
        }
        if let Some(projection) =
            flatten_namespace_tool_for_provider_with_sources("openai-responses", tool)?
        {
            for (emission, flattened) in projection.sources.iter().zip(projection.tools) {
                let source_path =
                    namespace_child_canonical_path(canonical_source_path, &emission.source_child_indices);
                let destination_index = emitted.len();
                emitted.push(flattened);
                if let Some(observer) = observer.as_mut() {
                    observer.note_emitted(destination_index, &source_path, &emitted[destination_index]);
                }
            }
        } else {
            let destination_index = emitted.len();
            emitted.push(tool.clone());
            if let Some(observer) = observer.as_mut() {
                if !is_openai_responses_hosted_web_search_tool(tool) {
                    observer.note_emitted(destination_index, canonical_source_path, &emitted[destination_index]);
                }
            }
        }
    }
    Ok(Some(Value::Array(emitted)))
}

pub(super) fn namespace_child_canonical_path(
    namespace_path: &str,
    source_child_indices: &[usize],
) -> String {
    let mut path = String::from(namespace_path);
    for child_index in source_child_indices {
        path.push_str(&format!(".tools[{child_index}]"));
    }
    path
}

fn normalize_responses_payload_for_provider_standard(payload: &Value) -> Result<Value, String> {
    // The caller has already completed the adjacent Chat -> Responses projection.
    // Re-running it here would reapply public metadata limits to the provider
    // compatible slot. Client metadata is already consumed as local context.
    let mut normalized = payload.clone();
    let instructions = normalized
        .as_object_mut()
        .and_then(|row| row.remove("instructions"))
        .and_then(|value| value.as_str().map(str::to_string))
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    if let Some(instructions) = instructions {
        if responses_input_accepts_system_instruction_prefix(&normalized) {
            lift_responses_instructions_into_input(&mut normalized, instructions);
        } else if let Some(object) = normalized.as_object_mut() {
            object.insert("instructions".to_string(), Value::String(instructions));
        }
    }
    normalize_responses_input_content_parts(&mut normalized);
    normalize_responses_target_token_and_logprob_fields(&mut normalized);
    Ok(normalized)
}

pub(crate) fn normalize_responses_input_content_parts(payload: &mut Value) {
    let Some(items) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    for item in items {
        let role = item.get("role").and_then(Value::as_str).unwrap_or("").to_string();
        let is_non_assistant_message =
            Some(role.as_str())
                .is_some_and(|role| {
                    role.eq_ignore_ascii_case("user")
                        || role.eq_ignore_ascii_case("system")
                        || role.eq_ignore_ascii_case("developer")
                });
        if !is_non_assistant_message {
            continue;
        }
        let Some(parts) = item.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        for part in parts {
            *part = request_outbound_responses_items::project_responses_part_representation(
                part.clone(), &role,
            );
        }
    }
}

pub(crate) fn normalize_v3_openai_responses_provider_request_payload(
    payload: &mut Value,
) -> Result<(), String> {
    promote_tool_search_output_tools_to_provider_tools(payload)?;
    normalize_responses_input_content_parts(payload);
    Ok(())
}

fn responses_input_accepts_system_instruction_prefix(payload: &Value) -> bool {
    payload
        .get("input")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("type").and_then(Value::as_str) == Some("message")
                    || item
                        .get("role")
                        .and_then(Value::as_str)
                        .is_some_and(|role| matches!(role, "user" | "system" | "developer"))
            })
        })
}

fn lift_responses_instructions_into_input(payload: &mut Value, instructions: String) {
    let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    if input
        .iter()
        .any(|item| responses_system_message_contains(item, &instructions))
    {
        return;
    }
    if let Some(system_item) = input
        .iter_mut()
        .find(|item| responses_input_item_is_system_message(item))
    {
        append_responses_system_instruction(system_item, instructions);
        return;
    }
    input.insert(
        0,
        json!({
            "type": "message",
            "role": "system",
            "content": [{"type": "input_text", "text": instructions}]
        }),
    );
}

fn responses_input_item_is_system_message(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("message")
        && matches!(
            item.get("role").and_then(Value::as_str),
            Some("system" | "developer")
        )
}

fn responses_system_message_contains(item: &Value, needle: &str) -> bool {
    if !responses_input_item_is_system_message(item) {
        return false;
    }
    match item.get("content") {
        Some(Value::String(text)) => text.contains(needle),
        Some(Value::Array(parts)) => parts.iter().any(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains(needle))
        }),
        _ => false,
    }
}

fn append_responses_system_instruction(item: &mut Value, instructions: String) {
    let Some(row) = item.as_object_mut() else {
        return;
    };
    match row.get_mut("content") {
        Some(Value::Array(parts)) => {
            parts.push(json!({"type": "input_text", "text": instructions}));
        }
        Some(Value::String(text)) => {
            if !text.trim().is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(&instructions);
        }
        _ => {
            row.insert(
                "content".to_string(),
                Value::Array(vec![json!({"type": "input_text", "text": instructions})]),
            );
        }
    }
}

fn normalize_responses_target_token_and_logprob_fields(payload: &mut Value) {
    let Some(row) = payload.as_object_mut() else {
        return;
    };
    let max_output = row.remove("max_output_tokens");
    let max_completion = row.remove("max_completion_tokens");
    let legacy_max = row.remove("max_tokens");
    if let Some(value) = max_output.or(max_completion).or(legacy_max) {
        row.insert("max_output_tokens".to_string(), value);
    }
    let top_logprobs = row.remove("top_logprobs");
    let logprobs_enabled = row
        .remove("logprobs")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if logprobs_enabled {
        if let Some(value) = top_logprobs {
            row.insert("top_logprobs".to_string(), value);
        }
    }
}

fn build_v3_anthropic_provider_request_source_from_chat_canonical_inner(
    payload: &Value,
    _entry_protocol: V3HubEntryProtocol,
    _model_capabilities: Option<&[String]>,
) -> Result<Value, String> {
    let drop_context = V3ProjectionDropContext::disabled();
    let (value, mut drops) =
        build_v3_anthropic_provider_request_source_from_chat_canonical_with_drops(
            payload,
        )?;
    drop_context.restamp_and_emit(&mut drops);
    Ok(value)
}

/// non-error carrier：把投影阶段的丢弃记录交给请求作用域盖章落盘。
pub(crate) fn build_v3_anthropic_provider_request_source_from_chat_canonical_with_drops(
    payload: &Value,
) -> Result<(Value, Vec<V3ProjectionDropRecord>), String> {
    // Inbound has already normalized every entry to Chat. Standard Outbound
    // consumes that shape; the original entry cannot select another pipeline.
    if payload.get("messages").and_then(Value::as_array).is_none() {
        return Err("Anthropic provider wire requires governed Chat messages".to_string());
    }
    project_outbound_payload_for_target_protocol_with_drops(payload, V3OutboundTargetProtocol::Anthropic)
}

pub(crate) fn build_v3_anthropic_provider_request_source_from_chat_canonical(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
) -> Result<Value, String> {
    build_v3_anthropic_provider_request_source_from_chat_canonical_inner(
        payload,
        entry_protocol,
        None,
    )
}

pub(crate) fn build_v3_anthropic_provider_request_source_from_chat_canonical_for_selected(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
    model_capabilities: &[String],
) -> Result<Value, String> {
    build_v3_anthropic_provider_request_source_from_chat_canonical_inner(
        payload,
        entry_protocol,
        Some(model_capabilities),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3OutboundTargetProtocol {
    OpenAiChat,
    OpenAiResponses,
    Anthropic,
    Gemini,
}

impl V3OutboundTargetProtocol {
    fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiChat => "openai_chat",
            Self::OpenAiResponses => "responses",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }
}

pub(crate) fn project_outbound_payload_for_target_protocol(
    source: &Value,
    target_protocol: V3OutboundTargetProtocol,
) -> Result<Value, String> {
    let drop_context = V3ProjectionDropContext::disabled();
    let (value, mut drops) =
        project_outbound_payload_for_target_protocol_with_drops(source, target_protocol)?;
    drop_context.restamp_and_emit(&mut drops);
    Ok(value)
}

/// stage-3 target output-protocol whitelist projection 的 non-error carrier：
/// 返回投影值 + 丢弃记录，使丢弃走非错误通道（兼容优先，其次 drop+record+print）。
pub(crate) fn project_outbound_payload_for_target_protocol_with_drops(
    source: &Value,
    target_protocol: V3OutboundTargetProtocol,
) -> Result<(Value, Vec<V3ProjectionDropRecord>), String> {
    project_outbound_payload_for_target_protocol_inner_with_drops(source, target_protocol, None)
}

pub(crate) fn project_outbound_payload_for_selected_target_protocol(
    source: &Value,
    target_protocol: V3OutboundTargetProtocol,
    model_capabilities: &[String],
) -> Result<Value, String> {
    let drop_context = V3ProjectionDropContext::disabled();
    let (value, mut drops) = project_outbound_payload_for_selected_target_protocol_with_drops(
        source,
        target_protocol,
        model_capabilities,
    )?;
    drop_context.restamp_and_emit(&mut drops);
    Ok(value)
}

/// 选中目标能力的 non-error carrier：丢弃记录交给请求作用域盖章落盘，
/// 因此不会出现「投影算出丢弃但只有 stderr、没有持久化身份」的缺口。
pub(crate) fn project_outbound_payload_for_selected_target_protocol_with_drops(
    source: &Value,
    target_protocol: V3OutboundTargetProtocol,
    model_capabilities: &[String],
) -> Result<(Value, Vec<V3ProjectionDropRecord>), String> {
    project_outbound_payload_for_target_protocol_inner_with_drops(
        source,
        target_protocol,
        Some(model_capabilities),
    )
}

fn project_outbound_payload_for_target_protocol_inner_with_drops(
    source: &Value,
    target_protocol: V3OutboundTargetProtocol,
    gemini_model_capabilities: Option<&[String]>,
) -> Result<(Value, Vec<V3ProjectionDropRecord>), String> {
    let mut source = source.clone();
    if matches!(target_protocol, V3OutboundTargetProtocol::Gemini) {
        match gemini_model_capabilities {
            Some(model_capabilities) => project_gemini_compatible_fields_for_selected_target(
                &mut source,
                model_capabilities,
            )?,
            None => project_gemini_compatible_fields(&mut source)?,
        }
    }
    let source = &source;
    let control_paths = collect_outbound_control_field_paths(source);
    if !control_paths.is_empty() {
        return Err(format!(
            "ControlFieldLeak target_protocol={} paths={}",
            target_protocol.as_str(),
            control_paths.join(",")
        ));
    }
    // stage 3 白名单投影是「最大兼容优先，其次丢弃」：目标协议白名单之外的字段
    // 不携带目标协议可表示的语义，按规则 DROP + RECORD + PRINT 后继续请求，
    // 绝不变成客户端错误。`ControlFieldLeak`（上方）仍是 hard error 不变量。
    let unmapped = collect_unmapped_outbound_field_paths(source, target_protocol);
    let mut drops = Vec::new();
    for json_path in &unmapped {
        drops.push(V3ProjectionDropRecord::new(
            target_protocol.as_str(),
            json_path.clone(),
            "unmapped_target_protocol_field_unrepresentable",
            resolve_v3_json_path(source, json_path).unwrap_or(Value::Null),
            "project_outbound_payload_for_target_protocol_inner_with_drops",
        ));
    }
    let mut projected = source.clone();
    for json_path in &unmapped {
        remove_unmapped_outbound_field(&mut projected, json_path);
    }
    apply_outbound_projection_transforms(&mut projected, target_protocol)?;
    Ok((projected, drops))
}

/// 从投影结果中移除一个白名单外的出站字段。
///
/// 复用丢弃日志的同一个 path 解析器，因此 `json_path_child` 产出的任何形态
/// （`$.key`、`$["non-identifier key"]`、`$.arr[i]`）都能被真正移除，不会出现
/// 「已记录但没丢弃」的静默非丢弃。末段是对象成员时删除该成员，落在数组元素上
/// 时删除该元素；父级缺失即视为已无可丢弃内容。
fn remove_unmapped_outbound_field(projected: &mut Value, json_path: &str) {
    let Some(segments) = split_v3_json_path(json_path) else {
        return;
    };
    let Some((leaf, parents)) = segments.split_last() else {
        return;
    };
    let mut current = projected;
    for segment in parents {
        let next = match segment {
            V3JsonPathSegment::Key(key) => current.get_mut(key),
            V3JsonPathSegment::Index(index) => current.get_mut(*index),
        };
        match next {
            Some(next) => current = next,
            None => return,
        }
    }
    match leaf {
        V3JsonPathSegment::Key(key) => {
            if let Some(map) = current.as_object_mut() {
                map.remove(key);
            }
        }
        V3JsonPathSegment::Index(index) => {
            if let Some(items) = current.as_array_mut() {
                if *index < items.len() {
                    items.remove(*index);
                }
            }
        }
    }
}

include!("request_outbound_gemini.rs");

fn apply_outbound_projection_transforms(
    projected: &mut Value,
    target_protocol: V3OutboundTargetProtocol,
) -> Result<(), String> {
    match target_protocol {
        V3OutboundTargetProtocol::OpenAiResponses => {
            project_responses_request_chat_extension_to_openai_responses(projected)?;
            validate_openai_metadata(projected, "responses")?;
            project_openai_responses_reasoning_extensions_to_reasoning(projected)?;
        }
        V3OutboundTargetProtocol::OpenAiChat => {
            project_responses_request_chat_extension_to_openai_chat(projected)?;
            project_openai_client_metadata_to_metadata(projected, "openai_chat")?;
            validate_openai_metadata(projected, "openai_chat")?;
            project_openai_chat_reasoning_summary_policy(projected)?;
            project_openai_chat_reasoning_context_policy(projected)?;
        }
        V3OutboundTargetProtocol::Anthropic => {
            project_chat_store_to_anthropic_wire(projected)?;
            project_chat_canonical_web_search_tools_to_anthropic_wire(projected)?;
        }
        V3OutboundTargetProtocol::Gemini => {
            consume_gemini_transport_intent(projected)?;
        }
    }
    Ok(())
}

/// chat canonical → Anthropic wire 的 web_search 工具投影：
/// canonical tools 中的标准 hosted search 声明（`{"type":"web_search"}`，
/// 含 responses web_search item 转换形状）与 Mode B 本地 websearch function
/// （name=websearch）必须编码为 Anthropic 官方 hosted server tool
/// `{"type":"web_search_20250305","name":"web_search"}`——否则 MiniMax 等
/// Anthropic provider 不识别（表现为"我没有 web search 工具"纯文本回答，
/// 真实故障 20260808）。复用 responses_to_anthropic 的既有投影。
fn project_chat_canonical_web_search_tools_to_anthropic_wire(
    projected: &mut Value,
) -> Result<(), String> {
    let Some(root) = projected.as_object_mut() else {
        return Ok(());
    };
    let Some(tools) = root.get_mut("tools") else {
        return Ok(());
    };
    let Some(tools) = tools.as_array_mut() else {
        return Ok(());
    };
    for tool in tools.iter_mut() {
        let Some(row) = tool.as_object_mut() else {
            continue;
        };
        let kind = row.get("type").and_then(Value::as_str).unwrap_or("");
        let name = row
            .get("name")
            .or_else(|| row.get("function").and_then(|f| f.get("name")))
            .and_then(Value::as_str)
            .unwrap_or("");
        let is_web_search_declaration = matches!(kind, "web_search" | "web_search_preview")
            || name.trim().eq_ignore_ascii_case("websearch")
            || name.trim().eq_ignore_ascii_case("web_search");
        if is_web_search_declaration {
            let converted = super::anthropic_codec::responses_web_search_tool_as_anthropic_tool(
                row,
            )
            .map_err(|error| format!("anthropic web_search tool projection failed: {error}"))?;
            *tool = converted;
        }
    }
    Ok(())
}

fn consume_gemini_transport_intent(projected: &mut Value) -> Result<(), String> {
    let Some(row) = projected.as_object_mut() else {
        return Ok(());
    };
    let Some(stream) = row.remove("stream") else {
        return Ok(());
    };
    if stream.as_bool().is_none() {
        return Err(
            "MalformedOutboundField target_protocol=gemini path=$.request.stream".to_string(),
        );
    }
    Ok(())
}

fn project_responses_request_chat_extension_to_openai_responses(
    projected: &mut Value,
) -> Result<(), String> {
    let Some(extension) = take_responses_request_chat_extension(projected, "responses")? else {
        return Ok(());
    };
    let row = projected
        .as_object_mut()
        .ok_or_else(|| "OpenAI Responses projection requires an object".to_string())?;
    for key in ["metadata", "prompt_cache_key", "store", "text"] {
        if let Some(value) = extension.get(key) {
            insert_unless_matching(row, key, value.clone(), "responses")?;
        }
    }
    Ok(())
}

fn project_responses_request_chat_extension_to_openai_chat(
    projected: &mut Value,
) -> Result<(), String> {
    let Some(mut extension) = take_responses_request_chat_extension(projected, "openai_chat")?
    else {
        return Ok(());
    };
    let row = projected
        .as_object_mut()
        .ok_or_else(|| "OpenAI Chat projection requires an object".to_string())?;
    for key in ["metadata", "client_metadata"] {
        if let Some(value) = extension.remove(key) {
            insert_unless_matching(row, key, value, "openai_chat")?;
        }
    }
    for key in ["prompt_cache_key", "store"] {
        if let Some(value) = extension.remove(key) {
            insert_unless_matching(row, key, value, "openai_chat")?;
        }
    }
    if let Some(value) = extension.remove("reasoning_summary_policy") {
        insert_unless_matching(row, "reasoning_summary_policy", value, "openai_chat")?;
    }
    if let Some(value) = extension.remove("reasoning_context_policy") {
        insert_unless_matching(row, "reasoning_context_policy", value, "openai_chat")?;
    }
    if let Some(text) = extension.remove("text") {
        let mut text = text.as_object().cloned().ok_or_else(|| {
            "MalformedOutboundField target_protocol=openai_chat path=$.text".to_string()
        })?;
        if let Some(verbosity) = text.remove("verbosity") {
            insert_unless_matching(row, "verbosity", verbosity, "openai_chat")?;
        }
        if let Some(format) = text.remove("format") {
            project_responses_text_format_to_openai_chat_response_format(row, format)?;
        }
        if !text.is_empty() {
            return Err(format!(
                "UnmappedOutboundFields target_protocol=openai_chat paths={}",
                text.keys()
                    .map(|key| format!("$.request.text.{key}"))
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
    }
    if !extension.is_empty() {
        return Err(format!(
            "UnmappedOutboundFields target_protocol=openai_chat paths={}",
            extension
                .keys()
                .map(|key| format!("$.request.{key}"))
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    Ok(())
}

fn project_responses_text_format_to_openai_chat_response_format(
    row: &mut Map<String, Value>,
    format: Value,
) -> Result<(), String> {
    let format = format.as_object().ok_or_else(|| {
        "MalformedOutboundField target_protocol=openai_chat path=$.request.text.format".to_string()
    })?;
    let format_type = format.get("type").and_then(Value::as_str).ok_or_else(|| {
        "MalformedOutboundField target_protocol=openai_chat path=$.request.text.format.type"
            .to_string()
    })?;
    match format_type {
        "text" => {
            if let Some(existing) = row.get("response_format") {
                let existing_type = existing
                    .as_object()
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str);
                if existing_type != Some("text") {
                    return Err(
                        "ConflictingOutboundField target_protocol=openai_chat path=$.response_format"
                            .to_string(),
                    );
                }
            }
            reject_unmapped_responses_text_format_keys(format, &["type"])?;
            Ok(())
        }
        "json_object" => {
            reject_unmapped_responses_text_format_keys(format, &["type"])?;
            insert_unless_matching(
                row,
                "response_format",
                json!({"type": "json_object"}),
                "openai_chat",
            )
        }
        "json_schema" => {
            reject_unmapped_responses_text_format_keys(
                format,
                &["type", "name", "description", "schema", "strict"],
            )?;
            let name = format
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    "MalformedOutboundField target_protocol=openai_chat path=$.request.text.format.name"
                        .to_string()
                })?;
            let schema = format.get("schema").ok_or_else(|| {
                "MalformedOutboundField target_protocol=openai_chat path=$.request.text.format.schema"
                    .to_string()
            })?;
            if !schema.is_object() {
                return Err(
                    "MalformedOutboundField target_protocol=openai_chat path=$.request.text.format.schema"
                        .to_string(),
                );
            }
            let mut json_schema = Map::new();
            json_schema.insert("name".to_string(), Value::String(name.to_string()));
            if let Some(description) = format.get("description") {
                if !description.is_string() {
                    return Err(
                        "MalformedOutboundField target_protocol=openai_chat path=$.request.text.format.description"
                            .to_string(),
                    );
                }
                json_schema.insert("description".to_string(), description.clone());
            }
            json_schema.insert("schema".to_string(), schema.clone());
            if let Some(strict) = format.get("strict") {
                if !strict.is_boolean() {
                    return Err(
                        "MalformedOutboundField target_protocol=openai_chat path=$.request.text.format.strict"
                            .to_string(),
                    );
                }
                json_schema.insert("strict".to_string(), strict.clone());
            }
            insert_unless_matching(
                row,
                "response_format",
                json!({"type": "json_schema", "json_schema": Value::Object(json_schema)}),
                "openai_chat",
            )
        }
        _ => Err(format!(
            "MalformedOutboundField target_protocol=openai_chat path=$.request.text.format.type unsupported={format_type}"
        )),
    }
}

fn reject_unmapped_responses_text_format_keys(
    format: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(), String> {
    let unmapped = format
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .map(|key| format!("$.request.text.format.{key}"))
        .collect::<Vec<_>>();
    if unmapped.is_empty() {
        return Ok(());
    }
    Err(format!(
        "UnmappedOutboundFields target_protocol=openai_chat paths={}",
        unmapped.join(",")
    ))
}

fn take_responses_request_chat_extension(
    projected: &mut Value,
    target_protocol: &str,
) -> Result<Option<Map<String, Value>>, String> {
    let Some(row) = projected.as_object_mut() else {
        return Ok(None);
    };
    let Some(extension) = row.remove("routecodex_chat_extension") else {
        return Ok(None);
    };
    let mut extension = extension
        .as_object()
        .cloned()
        .ok_or_else(|| "MalformedOutboundField path=$.routecodex_chat_extension".to_string())?;
    let responses_request = extension.remove("responses_request");
    if !extension.is_empty() {
        return Err(format!(
            "UnmappedOutboundFields target_protocol={target_protocol} paths={}",
            extension
                .keys()
                .map(|key| format!("$.request.{key}"))
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    responses_request
        .map(|value| {
            value.as_object().cloned().ok_or_else(|| {
                "MalformedOutboundField path=$.routecodex_chat_extension.responses_request"
                    .to_string()
            })
        })
        .transpose()
}

fn insert_unless_matching(
    row: &mut Map<String, Value>,
    field: &str,
    value: Value,
    target_protocol: &str,
) -> Result<(), String> {
    if row.get(field).is_some_and(|existing| existing != &value) {
        return Err(format!(
            "ConflictingOutboundField target_protocol={target_protocol} path=$.{field}"
        ));
    }
    row.insert(field.to_string(), value);
    Ok(())
}

fn project_openai_responses_reasoning_extensions_to_reasoning(
    projected: &mut Value,
) -> Result<(), String> {
    let Some(row) = projected.as_object_mut() else {
        return Ok(());
    };
    let mut fields = Vec::new();
    for (source, target) in [
        ("reasoning_effort", "effort"),
        ("reasoning_summary_policy", "summary"),
        ("reasoning_context_policy", "context"),
        ("reasoning_mode", "mode"),
    ] {
        if let Some(value) = row.remove(source) {
            let valid = match source {
                "reasoning_effort" => value.as_str().is_some_and(|value| !value.trim().is_empty()),
                "reasoning_summary_policy" => value
                    .as_str()
                    .is_some_and(|value| matches!(value, "auto" | "concise" | "detailed")),
                "reasoning_context_policy" => value
                    .as_str()
                    .is_some_and(|value| matches!(value, "auto" | "current_turn" | "all_turns")),
                "reasoning_mode" => value.as_str().is_some_and(|value| !value.trim().is_empty()),
                _ => false,
            };
            if !valid {
                return Err(format!(
                    "MalformedOutboundField target_protocol=responses path=$.request.{source}"
                ));
            }
            fields.push((target, value));
        }
    }
    if fields.is_empty() {
        return Ok(());
    }
    let reasoning = row
        .entry("reasoning".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| {
            "ConflictingOutboundFields target_protocol=responses path=$.reasoning".to_string()
        })?;
    for (key, value) in fields {
        if reasoning
            .get(key)
            .is_some_and(|existing| existing != &value)
        {
            return Err(format!(
                "ConflictingOutboundFields target_protocol=responses path=$.reasoning.{key}"
            ));
        }
        reasoning.insert(key.to_string(), value);
    }
    Ok(())
}

fn collect_outbound_control_field_paths(value: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    collect_outbound_control_field_paths_inner(value, "$", &mut paths);
    paths
}

fn collect_outbound_control_field_paths_inner(value: &Value, path: &str, paths: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let child_path = json_path_child(path, key);
                if is_provider_outbound_control_key(key) {
                    paths.push(child_path.clone());
                }
                collect_outbound_control_field_paths_inner(child, &child_path, paths);
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                collect_outbound_control_field_paths_inner(
                    child,
                    &format!("{path}[{index}]"),
                    paths,
                );
            }
        }
        _ => {}
    }
}

fn json_path_child(parent: &str, key: &str) -> String {
    // An empty key must take the quoted branch: the bare form would render as
    // `$.`, which the path reader rejects, so the drop would be recorded
    // without ever being removed from the wire.
    if !key.is_empty()
        && key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        format!("{parent}.{key}")
    } else {
        format!(
            "{parent}[{}]",
            serde_json::to_string(key).unwrap_or_else(|_| "\"?\"".to_string())
        )
    }
}

fn is_provider_outbound_control_key(key: &str) -> bool {
    matches!(
        key,
        "routecodex_internal"
            | "routecodexInternal"
            | "route_hint"
            | "routeHint"
            | "metadata_center"
            | "metadataCenter"
            | "__metadataCenter"
            | "debug_snapshot"
            | "debugSnapshot"
            | "_debug"
            | "provider_protocol"
            | "providerProtocol"
            | "provider_runtime"
            | "providerRuntime"
            | "resource_handle"
            | "resourceHandle"
            | "continuation_owner"
            | "continuationOwner"
            | "runtime_control"
            | "runtimeControl"
            | "request_truth"
            | "requestTruth"
            | "route_selection"
            | "routeSelection"
            | "retry_exclusion_set"
            | "retryExclusionSet"
            | "selected_target"
            | "selectedTarget"
            | "opaque_target"
            | "opaqueTarget"
            | "resume_meta"
            | "resumeMeta"
            | "servertool_state"
            | "servertoolState"
            | "error_chain"
            | "errorChain"
            | "node_trace"
            | "nodeTrace"
            | "capturedChatRequest"
            | "entryOriginRequest"
            | "requestSemantics"
            | "responsesRequestContext"
            | "__raw_request_body"
            | "__rt"
            | "__rccDryRunSerialized"
            | "request_capabilities"
            | "requestCapabilities"
            | "required_capabilities"
            | "requiredCapabilities"
            | "model_capabilities"
            | "modelCapabilities"
            | "selection_plan"
            | "selectionPlan"
    )
}

fn project_outbound_nested_payload_for_target_protocol(
    source: &Value,
    target_protocol: V3OutboundTargetProtocol,
) -> Result<Value, String> {
    let control_paths = collect_outbound_control_field_paths(source);
    if !control_paths.is_empty() {
        return Err(format!(
            "ControlFieldLeak target_protocol={} paths={}",
            target_protocol.as_str(),
            control_paths.join(",")
        ));
    }
    Ok(source.clone())
}

fn collect_unmapped_outbound_field_paths(
    source: &Value,
    target_protocol: V3OutboundTargetProtocol,
) -> Vec<String> {
    let Some(map) = source.as_object() else {
        return Vec::new();
    };
    let allowed = allowed_top_level_outbound_fields(target_protocol);
    let mut paths: Vec<String> = map
        .keys()
        .filter(|key| !allowed.contains(key.as_str()))
        .map(|key| json_path_child("$", key))
        .collect();
    if !matches!(target_protocol, V3OutboundTargetProtocol::OpenAiResponses) {
        if let Some(messages) = source.get("messages").and_then(Value::as_array) {
            for (index, message) in messages.iter().enumerate() {
                if message
                    .pointer("/routecodex_chat_extension/responses_tool_output_extra_fields")
                    .is_some_and(|fields| {
                        fields.as_object().is_none_or(|fields| !fields.is_empty())
                    })
                {
                    paths.push(format!("$.messages[{index}].routecodex_chat_extension.responses_tool_output_extra_fields"));
                }
            }
        }
    }
    paths
}

fn allowed_top_level_outbound_fields(
    target_protocol: V3OutboundTargetProtocol,
) -> BTreeSet<&'static str> {
    // 出站顶层字段白名单以 request_field_map.json 为真源（查表；表缺失时 fail-fast）。
    let protocol = match target_protocol {
        V3OutboundTargetProtocol::OpenAiChat => "openai_chat",
        V3OutboundTargetProtocol::OpenAiResponses => "responses",
        V3OutboundTargetProtocol::Anthropic => "anthropic",
        V3OutboundTargetProtocol::Gemini => "gemini",
    };
    crate::protocol_tables::whitelisted_fields(protocol)
        .unwrap_or_else(|error| panic!("request_field_map lookup failed for {protocol}: {error}"))
}


/// 返回 (投影值, 丢弃记录) 的 non-error carrier 版本；丢弃记录同时来自
/// stage-3 顶层白名单投影与 openai_chat provider tools 投影。
include!("request_outbound_openai_chat_messages.rs");

#[path = "request_outbound_openai_chat_content_part.rs"]
mod request_outbound_openai_chat_content_part;

#[cfg(test)]
#[path = "request_outbound_format_extra_tests.rs"]
mod request_outbound_format_extra_tests;

#[cfg(test)]
#[path = "request_outbound_gemini_tests.rs"]
mod request_outbound_gemini_tests;

#[cfg(test)]
#[path = "request_outbound_drop_tests.rs"]
mod request_outbound_drop_tests;

#[cfg(test)]
#[path = "request_outbound_responses_declaration_emission_tests.rs"]
mod request_outbound_responses_declaration_emission_tests;

#[cfg(test)]
#[path = "request_outbound_current_emission_consumer_tests.rs"]
mod request_outbound_current_emission_consumer_tests;
