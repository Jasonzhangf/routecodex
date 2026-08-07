use super::V3HubEntryProtocol;
use serde_json::{json, Map, Value};

use super::request_outbound_builtin_tool_projection::{
    normalize_json_schema_redaction_placeholders,
    project_openai_chat_provider_tools_for_web_search_mode,
};
use super::request_outbound_metadata::{
    project_openai_chat_reasoning_summary_policy, project_openai_client_metadata_to_metadata,
    validate_openai_metadata,
};
use super::request_outbound_tool_id::compact_tool_id;
use std::collections::BTreeSet;

#[cfg(test)]
pub(crate) fn build_v3_openai_chat_standard_request_from_chat_canonical(
    payload: &Value,
) -> Result<Value, String> {
    if payload.get("messages").and_then(Value::as_array).is_none() {
        return Err("OpenAI Chat provider wire requires Chat canonical messages".to_string());
    }
    normalize_openai_chat_messages_payload(
        payload,
        routecodex_v3_config::V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
        true,
    )
}

pub(crate) fn build_v3_openai_chat_standard_request_for_selected_web_search_mode(
    payload: &Value,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    has_web_search_capability: bool,
) -> Result<Value, String> {
    if payload.get("messages").and_then(Value::as_array).is_none() {
        return Err("OpenAI Chat provider wire requires Chat canonical messages".to_string());
    }
    normalize_openai_chat_messages_payload(
        payload,
        web_search_execution_mode,
        has_web_search_capability,
    )
}

pub(crate) fn build_v3_openai_responses_standard_request_from_chat_canonical(
    payload: &Value,
) -> Result<Value, String> {
    if payload.get("previous_response_id").is_some() {
        return Err(
            "UnmappedOutboundFields target_protocol=responses paths=$.previous_response_id"
                .to_string(),
        );
    }
    build_v3_openai_responses_request_from_chat_canonical(payload)
}

fn build_v3_openai_responses_request_from_chat_canonical(payload: &Value) -> Result<Value, String> {
    if payload.get("reasoning").is_some() {
        return Err(
            "RawPayloadShortcut target_protocol=responses path=$.reasoning; use registered Chat reasoning fields"
                .to_string(),
        );
    }
    let projected_source = project_outbound_payload_for_target_protocol(
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
        build_responses_input_from_chat_messages(messages)?,
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
        "metadata",
        "client_metadata",
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
        if let Some(value) = projected_source.get(key) {
            responses_payload.insert(key.to_string(), value.clone());
        }
    }
    normalize_responses_payload_for_provider_standard(&Value::Object(responses_payload))
}

fn normalize_responses_payload_for_provider_standard(payload: &Value) -> Result<Value, String> {
    // The caller has already completed the adjacent Chat -> Responses projection.
    // Re-running it here would erase client_metadata provenance and reapply public
    // metadata limits to the provider-compatible slot.
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
    normalize_responses_function_tool_schema_redaction_placeholders(&mut normalized)?;
    normalize_responses_target_token_and_logprob_fields(&mut normalized);
    Ok(normalized)
}

fn normalize_responses_function_tool_schema_redaction_placeholders(
    payload: &mut Value,
) -> Result<(), String> {
    let Some(tools) = payload.get_mut("tools").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for (index, tool) in tools.iter_mut().enumerate() {
        let Some(tool_row) = tool.as_object_mut() else {
            continue;
        };
        if tool_row.get("type").and_then(Value::as_str) != Some("function") {
            continue;
        }
        if let Some(parameters) = tool_row.get_mut("parameters") {
            normalize_json_schema_redaction_placeholders(
                parameters,
                true,
                &format!("$.tools[{index}].parameters"),
            )?;
        }
    }
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

pub(crate) fn build_v3_anthropic_provider_request_source_from_chat_canonical(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
) -> Result<Value, String> {
    match entry_protocol {
        V3HubEntryProtocol::Responses => {
            if payload.get("messages").and_then(Value::as_array).is_some() {
                return project_outbound_payload_for_target_protocol(
                    payload,
                    V3OutboundTargetProtocol::Anthropic,
                );
            }
            Err("Responses entry to Anthropic provider wire requires governed Chat extension messages".to_string())
        }
        V3HubEntryProtocol::Anthropic | V3HubEntryProtocol::OpenAiChat => {
            if payload.get("messages").and_then(Value::as_array).is_some() {
                return project_outbound_payload_for_target_protocol(
                    payload,
                    V3OutboundTargetProtocol::Anthropic,
                );
            }
            Err("Anthropic provider wire requires governed Chat/Anthropic messages".to_string())
        }
        V3HubEntryProtocol::Gemini => Err(
            "Gemini entry to Anthropic provider wire requires an explicit protocol codec"
                .to_string(),
        ),
    }
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
    let control_paths = collect_outbound_control_field_paths(source);
    if !control_paths.is_empty() {
        return Err(format!(
            "ControlFieldLeak target_protocol={} paths={}",
            target_protocol.as_str(),
            control_paths.join(",")
        ));
    }
    let unmapped = collect_unmapped_outbound_field_paths(source, target_protocol);
    if !unmapped.is_empty() {
        return Err(format!(
            "UnmappedOutboundFields target_protocol={} paths={}",
            target_protocol.as_str(),
            unmapped.join(",")
        ));
    }
    let mut projected = source.clone();
    apply_outbound_projection_transforms(&mut projected, target_protocol)?;
    Ok(projected)
}

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
        }
        V3OutboundTargetProtocol::Anthropic => {}
        V3OutboundTargetProtocol::Gemini => {
            consume_gemini_transport_intent(projected)?;
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
    for key in [
        "metadata",
        "client_metadata",
        "prompt_cache_key",
        "store",
        "text",
    ] {
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
                "reasoning_effort" => value.as_str().is_some_and(|value| {
                    matches!(
                        value,
                        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
                    )
                }),
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
    if key
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
            | "stopless_state"
            | "stoplessState"
            | "stopless_center"
            | "stoplessCenter"
            | "__routecodex_stopless_center"
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
    map.keys()
        .filter(|key| !allowed.contains(key.as_str()))
        .map(|key| json_path_child("$", key))
        .collect()
}

fn allowed_top_level_outbound_fields(
    target_protocol: V3OutboundTargetProtocol,
) -> BTreeSet<&'static str> {
    let fields: &[&str] = match target_protocol {
        V3OutboundTargetProtocol::OpenAiChat => &[
            "model",
            "messages",
            "tools",
            "tool_choice",
            "instructions",
            "temperature",
            "top_p",
            "top_k",
            "max_completion_tokens",
            "max_tokens",
            "max_output_tokens",
            "logprobs",
            "top_logprobs",
            "stream",
            "stream_options",
            "parallel_tool_calls",
            "user",
            "logit_bias",
            "seed",
            "response_format",
            "metadata",
            "client_metadata",
            "stop",
            "n",
            "frequency_penalty",
            "presence_penalty",
            "reasoning_effort",
            "reasoning_summary_policy",
            "audio",
            "modalities",
            "moderation",
            "prediction",
            "prompt_cache_key",
            "prompt_cache_options",
            "prompt_cache_retention",
            "safety_identifier",
            "service_tier",
            "store",
            "verbosity",
            "web_search_options",
            "routecodex_chat_extension",
            "function_call",
            "functions",
        ],
        V3OutboundTargetProtocol::OpenAiResponses => &[
            "model",
            "input",
            "messages",
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
            "stream_options",
            "parallel_tool_calls",
            "user",
            "logit_bias",
            "seed",
            "response_format",
            "include",
            "reasoning",
            "metadata",
            "stop",
            "safety_identifier",
            "moderation",
            "client_metadata",
            "reasoning_effort",
            "reasoning_summary_policy",
            "reasoning_context_policy",
            "reasoning_mode",
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
            "routecodex_chat_extension",
        ],
        V3OutboundTargetProtocol::Anthropic => &[
            "model",
            "messages",
            "input",
            "system",
            "instructions",
            "user",
            "tools",
            "tool_choice",
            "temperature",
            "top_p",
            "top_k",
            "max_tokens",
            "max_completion_tokens",
            "max_output_tokens",
            "stream",
            "stop",
            "stop_sequences",
            "metadata",
            "user",
            "reasoning_effort",
            "reasoning_budget_tokens",
            "reasoning_summary_policy",
            "reasoning_context_policy",
            "reasoning_mode",
            "reasoning_include_thoughts",
            "reasoning_display_policy",
            "reasoning_thinking_mode",
            "client_metadata",
            "parallel_tool_calls",
            "response_format",
            "context_management",
            "output_config",
            "routecodex_chat_extension",
        ],
        V3OutboundTargetProtocol::Gemini => &[
            "model",
            "messages",
            "input",
            "contents",
            "systemInstruction",
            "tools",
            "toolConfig",
            "generationConfig",
            "safetySettings",
            "cachedContent",
            "labels",
            "stream",
        ],
    };
    fields.iter().copied().collect()
}

fn normalize_responses_content_part_for_role(part: &Value, role: &str) -> Result<Value, String> {
    let mut normalized = project_outbound_nested_payload_for_target_protocol(
        part,
        V3OutboundTargetProtocol::OpenAiResponses,
    )?;
    let is_assistant = role.eq_ignore_ascii_case("assistant");
    if let Some(row) = normalized.as_object_mut() {
        let part_type = row.get("type").and_then(Value::as_str).unwrap_or("").trim();
        if part_type == "text" || (!is_assistant && part_type.is_empty()) {
            row.insert("type".to_string(), Value::String("input_text".to_string()));
        } else if is_assistant && (part_type.is_empty() || part_type == "input_text") {
            row.insert("type".to_string(), Value::String("output_text".to_string()));
        } else if part_type == "image_url" {
            row.insert("type".to_string(), Value::String("input_image".to_string()));
        }
        if row.get("type").and_then(Value::as_str) == Some("input_image") {
            if let Some(url) = row
                .get("image_url")
                .and_then(Value::as_object)
                .and_then(|image_url| image_url.get("url"))
                .and_then(Value::as_str)
                .map(str::to_string)
            {
                row.insert("image_url".to_string(), Value::String(url));
            }
        }
    }
    Ok(normalized)
}

fn chat_content_to_responses_content(content: &Value, role: &str) -> Result<Value, String> {
    let text_type = if role.eq_ignore_ascii_case("assistant") {
        "output_text"
    } else {
        "input_text"
    };
    match content {
        Value::String(text) => Ok(Value::Array(vec![json!({"type": text_type, "text": text})])),
        Value::Array(items) => Ok(Value::Array(
            items
                .iter()
                .map(|part| normalize_responses_content_part_for_role(part, role))
                .collect::<Result<Vec<Value>, String>>()?,
        )),
        Value::Null => Ok(Value::Array(Vec::new())),
        other => Ok(Value::Array(vec![
            normalize_responses_content_part_for_role(other, role)?,
        ])),
    }
}

fn chat_tool_call_to_responses_input_item(call: &Value) -> Result<Option<Value>, String> {
    let Some(row) = call.as_object() else {
        return Ok(None);
    };
    let function = row.get("function").and_then(Value::as_object);
    let responses_tool_call_type = row
        .get("routecodex_chat_extension")
        .and_then(|extension| extension.get("responses_tool_call_type"))
        .and_then(Value::as_str)
        .unwrap_or("function_call");
    let call_id = row
        .get("call_id")
        .or_else(|| row.get("tool_call_id"))
        .or_else(|| row.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(call_id) = call_id else {
        return Ok(None);
    };
    let name = function
        .and_then(|entry| entry.get("name"))
        .or_else(|| row.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(name) = name else {
        return Ok(None);
    };
    let arguments = function
        .and_then(|entry| entry.get("arguments"))
        .or_else(|| row.get("arguments"))
        .cloned()
        .unwrap_or_else(|| Value::String("{}".to_string()));
    let arguments_text = arguments
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| serde_json::to_string(&arguments).unwrap_or_else(|_| "{}".to_string()));
    if responses_tool_call_type == "custom_tool_call" {
        let item_id = responses_custom_item_id(row, call_id);
        let input = serde_json::from_str::<Value>(&arguments_text)
            .ok()
            .and_then(|value| value.get("input").cloned())
            .unwrap_or_else(|| Value::String(arguments_text.clone()));
        return Ok(Some(Value::Object(Map::from_iter([
            (
                "type".to_string(),
                Value::String("custom_tool_call".to_string()),
            ),
            ("id".to_string(), Value::String(item_id)),
            ("call_id".to_string(), Value::String(call_id.to_string())),
            ("name".to_string(), Value::String(name.to_string())),
            ("input".to_string(), input),
        ]))));
    }

    if responses_tool_call_type == "tool_search_call" {
        let arguments = serde_json::from_str::<Value>(&arguments_text).map_err(|error| {
            format!(
                "MalformedOutboundField target_protocol=responses path=$.input[].tool_search_call.arguments: {error}"
            )
        })?;
        let mut item = Map::from_iter([
            (
                "type".to_string(),
                Value::String("tool_search_call".to_string()),
            ),
            ("call_id".to_string(), Value::String(call_id.to_string())),
            ("arguments".to_string(), arguments),
        ]);
        project_responses_item_extension_fields(row, &mut item);
        return Ok(Some(Value::Object(item)));
    }

    let item_id = responses_function_item_id(row, call_id);
    Ok(Some(Value::Object(Map::from_iter([
        (
            "type".to_string(),
            Value::String("function_call".to_string()),
        ),
        ("id".to_string(), Value::String(item_id)),
        ("call_id".to_string(), Value::String(call_id.to_string())),
        ("name".to_string(), Value::String(name.to_string())),
        ("arguments".to_string(), Value::String(arguments_text)),
    ]))))
}

fn responses_item_id_from_chat_extension(row: &Map<String, Value>) -> Option<&str> {
    row.get("routecodex_chat_extension")
        .and_then(|extension| extension.get("responses_item_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn responses_function_item_id(row: &Map<String, Value>, call_id: &str) -> String {
    match responses_item_id_from_chat_extension(row) {
        Some(item_id) if item_id.starts_with("fc_") => item_id.to_string(),
        Some(item_id) => compact_tool_id("fc_", item_id),
        None => compact_tool_id("fc_", call_id),
    }
}

fn responses_custom_item_id(row: &Map<String, Value>, call_id: &str) -> String {
    responses_item_id_from_chat_extension(row)
        .map(str::to_string)
        .unwrap_or_else(|| compact_tool_id("fc_", call_id))
}

fn chat_tool_result_to_responses_input_item(
    row: &Map<String, Value>,
) -> Result<Option<Value>, String> {
    let responses_tool_output_type = row
        .get("routecodex_chat_extension")
        .and_then(|extension| extension.get("responses_tool_output_type"))
        .and_then(Value::as_str)
        .unwrap_or("function_call_output");
    let call_id = row
        .get("tool_call_id")
        .or_else(|| row.get("call_id"))
        .or_else(|| row.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(call_id) = call_id else {
        return Ok(None);
    };
    let output = row
        .get("content")
        .or_else(|| row.get("output"))
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => serde_json::to_string(other).unwrap_or_else(|_| String::new()),
        })
        .unwrap_or_default();
    if responses_tool_output_type == "tool_search_output" {
        let tools = serde_json::from_str::<Value>(&output).map_err(|error| {
            format!(
                "MalformedOutboundField target_protocol=responses path=$.input[].tool_search_output.tools: {error}"
            )
        })?;
        if !tools.is_array() {
            return Err(
                "MalformedOutboundField target_protocol=responses path=$.input[].tool_search_output.tools"
                    .to_string(),
            );
        }
        let mut item = Map::from_iter([
            (
                "type".to_string(),
                Value::String("tool_search_output".to_string()),
            ),
            ("call_id".to_string(), Value::String(call_id.to_string())),
            ("tools".to_string(), tools),
        ]);
        project_responses_item_extension_fields(row, &mut item);
        return Ok(Some(Value::Object(item)));
    }

    let item_id = if responses_tool_output_type == "custom_tool_call_output" {
        responses_custom_item_id(row, call_id)
    } else {
        responses_function_item_id(row, call_id)
    };

    Ok(Some(Value::Object(Map::from_iter([
        (
            "type".to_string(),
            Value::String(responses_tool_output_type.to_string()),
        ),
        ("id".to_string(), Value::String(item_id)),
        ("call_id".to_string(), Value::String(call_id.to_string())),
        ("output".to_string(), Value::String(output)),
    ]))))
}

fn project_responses_item_extension_fields(
    chat_item: &Map<String, Value>,
    responses_item: &mut Map<String, Value>,
) {
    let Some(extension) = chat_item
        .get("routecodex_chat_extension")
        .and_then(Value::as_object)
    else {
        return;
    };
    for (source, target) in [
        ("responses_item_id", "id"),
        ("responses_status", "status"),
        ("responses_execution", "execution"),
    ] {
        if let Some(value) = extension.get(source) {
            responses_item.insert(target.to_string(), value.clone());
        }
    }
}

pub(crate) fn build_responses_input_from_chat_messages(
    messages: &[Value],
) -> Result<Value, String> {
    let mut output = Vec::new();
    for message in messages {
        let Some(row) = message.as_object() else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .trim();
        if role.eq_ignore_ascii_case("tool") {
            if let Some(item) = chat_tool_result_to_responses_input_item(row)? {
                output.push(item);
            }
            continue;
        }
        if role.eq_ignore_ascii_case("assistant") {
            if let Some(tool_calls) = row.get("tool_calls").and_then(Value::as_array) {
                if let Some(reasoning) = chat_assistant_reasoning_to_responses_input_item(row) {
                    output.push(reasoning);
                }
                let items = tool_calls
                    .iter()
                    .map(chat_tool_call_to_responses_input_item)
                    .collect::<Result<Vec<Option<Value>>, String>>()?
                    .into_iter()
                    .flatten()
                    .collect::<Vec<Value>>();
                if !items.is_empty() {
                    output.extend(items);
                    continue;
                }
            }
        }
        let content = row
            .get("content")
            .map(|content| chat_content_to_responses_content(content, role))
            .transpose()?
            .unwrap_or_else(|| Value::Array(Vec::new()));
        output.push(Value::Object(Map::from_iter([
            ("type".to_string(), Value::String("message".to_string())),
            (
                "role".to_string(),
                Value::String(if role.is_empty() { "user" } else { role }.to_string()),
            ),
            ("content".to_string(), content),
        ])));
    }
    Ok(Value::Array(output))
}

fn chat_assistant_reasoning_to_responses_input_item(row: &Map<String, Value>) -> Option<Value> {
    let text = row
        .get("reasoning_content")
        .or_else(|| row.get("reasoning_text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(json!({
        "type": "reasoning",
        "summary": [{"type": "summary_text", "text": text}]
    }))
}

fn normalize_openai_chat_message_content_part(part: &Value) -> Result<Value, String> {
    let mut normalized = project_outbound_nested_payload_for_target_protocol(
        part,
        V3OutboundTargetProtocol::OpenAiChat,
    )?;
    let Some(row) = normalized.as_object_mut() else {
        return Ok(normalized);
    };
    let part_type = row
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match part_type.as_str() {
        "input_text" | "output_text" | "commentary" => {
            row.insert("type".to_string(), Value::String("text".to_string()));
        }
        "input_image" => {
            row.insert("type".to_string(), Value::String("image_url".to_string()));
            let image_url_value = match row.get("image_url").cloned() {
                Some(Value::String(url)) => Some(Value::Object(Map::from_iter([(
                    "url".to_string(),
                    Value::String(url),
                )]))),
                Some(Value::Object(existing)) => Some(Value::Object(existing)),
                _ => None,
            };
            if let Some(image_url) = image_url_value {
                row.insert("image_url".to_string(), image_url);
            }
        }
        _ => {}
    }
    Ok(normalized)
}

fn normalize_openai_chat_messages_payload(
    payload: &Value,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    has_web_search_capability: bool,
) -> Result<Value, String> {
    let mut normalized = project_outbound_payload_for_target_protocol(
        payload,
        V3OutboundTargetProtocol::OpenAiChat,
    )?;
    if let Some(row) = normalized.as_object_mut() {
        if let Some(max_output_tokens) = row.remove("max_output_tokens") {
            row.entry("max_completion_tokens".to_string())
                .or_insert(max_output_tokens);
        }
        if let Some(reasoning_effort) = project_openai_chat_reasoning_effort_from_reasoning(row) {
            row.entry("reasoning_effort".to_string())
                .or_insert(reasoning_effort);
        }
    }
    let instructions = normalized
        .as_object_mut()
        .and_then(|row| row.remove("instructions"))
        .and_then(|value| value.as_str().map(str::to_string))
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let Some(messages) = normalized.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok(normalized);
    };
    if let Some(instructions) = instructions {
        let already_visible = messages.iter().any(|message| {
            matches!(
                message.get("role").and_then(Value::as_str),
                Some("system" | "developer")
            ) && message
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| content.contains(&instructions))
        });
        if !already_visible {
            if let Some(system_message) = messages.iter_mut().find(|message| {
                matches!(
                    message.get("role").and_then(Value::as_str),
                    Some("system" | "developer")
                )
            }) {
                if let Some(system_row) = system_message.as_object_mut() {
                    match system_row.get_mut("content") {
                        Some(Value::String(content)) => {
                            if !content.trim().is_empty() {
                                content.push_str("\n\n");
                            }
                            content.push_str(&instructions);
                        }
                        Some(Value::Array(parts)) => {
                            parts.push(json!({"type": "text", "text": instructions}));
                        }
                        _ => {
                            system_row.insert("content".to_string(), Value::String(instructions));
                        }
                    }
                }
            } else {
                messages.insert(0, json!({"role": "system", "content": instructions}));
            }
        }
    }
    for message in messages.iter_mut() {
        let Some(message_row) = message.as_object_mut() else {
            continue;
        };
        consume_routecodex_chat_extension_for_openai_chat_provider(message_row);
        let Some(content) = message_row.get_mut("content") else {
            continue;
        };
        if let Value::Array(parts) = content {
            let normalized_parts = parts
                .iter()
                .map(normalize_openai_chat_message_content_part)
                .collect::<Result<Vec<_>, String>>()?;
            *content = Value::Array(normalized_parts);
        }
    }
    project_openai_chat_provider_tools_for_web_search_mode(
        &mut normalized,
        web_search_execution_mode,
        has_web_search_capability,
    )?;
    ensure_openai_chat_stream_usage_option(&mut normalized);
    Ok(normalized)
}

fn consume_routecodex_chat_extension_for_openai_chat_provider(
    message_row: &mut Map<String, Value>,
) {
    remove_object_field(message_row, "routecodex_chat_extension");
    let Some(tool_calls) = message_row
        .get_mut("tool_calls")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for tool_call in tool_calls {
        if let Some(tool_call_row) = tool_call.as_object_mut() {
            remove_object_field(tool_call_row, "routecodex_chat_extension");
        }
    }
}

fn project_openai_chat_reasoning_effort_from_reasoning(
    row: &mut Map<String, Value>,
) -> Option<Value> {
    let reasoning = remove_object_field(row, "reasoning")?;
    let effort = reasoning
        .get("effort")
        .and_then(Value::as_str)
        .or_else(|| reasoning.as_str())
        .map(str::trim)
        .filter(|effort| !effort.is_empty())?
        .to_ascii_lowercase();
    (!matches!(
        effort.as_str(),
        "none" | "off" | "disabled" | "disable" | "false"
    ))
    .then(|| Value::String(effort))
}

fn remove_object_field(row: &mut Map<String, Value>, key: &str) -> Option<Value> {
    row.remove(key)
}

fn ensure_openai_chat_stream_usage_option(payload: &mut Value) {
    let Some(row) = payload.as_object_mut() else {
        return;
    };
    if row.get("stream").and_then(Value::as_bool) != Some(true) {
        return;
    }
    if row.contains_key("stream_options") {
        return;
    }
    row.insert("stream_options".to_string(), json!({"include_usage": true}));
}

#[cfg(test)]
#[path = "request_outbound_format_extra_tests.rs"]
mod request_outbound_format_extra_tests;
