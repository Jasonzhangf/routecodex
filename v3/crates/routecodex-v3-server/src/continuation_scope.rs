// V3 Responses continuation scope and request metadata helpers.
// Builds Direct/Relay continuation scopes and related request metadata only.

use super::*;

pub(super) fn request_accepts_sse(headers: &HeaderMap) -> bool {
    headers
        .get("accept")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("text/event-stream"))
        })
}

pub(super) fn v3_responses_request_wants_sse(headers: &HeaderMap, payload: &Value) -> bool {
    payload.get("stream").and_then(Value::as_bool) == Some(true) || request_accepts_sse(headers)
}

pub(super) fn response_input_item_count(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Array(items)) => items.len(),
        Some(Value::Null) | None => 0,
        Some(Value::String(text)) if text.trim().is_empty() => 0,
        Some(_) => 1,
    }
}

pub(super) fn build_responses_direct_continuation_scope(
    headers: &HeaderMap,
    request_id: &str,
    server: &V3ServerManifest,
    endpoint: &str,
    payload: &Value,
) -> Result<V3ResponsesDirectContinuationScope, String> {
    let turn_metadata = parse_codex_turn_metadata(headers)?;
    let session_id = first_header_text(headers, &["session-id", "session_id", "x-session-id"])?
        .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_SESSION_PATHS))
        .or_else(|| read_first_scope_value(Some(payload), BODY_SESSION_PATHS));
    let conversation_id = first_header_text(
        headers,
        &[
            "thread-id",
            "thread_id",
            "conversation-id",
            "conversation_id",
            "x-conversation-id",
        ],
    )?
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_CONVERSATION_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_CONVERSATION_PATHS));
    let (session_id, conversation_id) = resolve_transparent_continuation_scope(
        session_id,
        conversation_id,
        payload_needs_direct_continuation_scope(payload),
        request_id,
    )?;
    Ok(V3ResponsesDirectContinuationScope::responses(
        endpoint,
        session_id,
        conversation_id,
        server.port,
        server.routing_group.clone(),
    ))
}

pub(super) fn build_responses_relay_execution_env<'a, T: V3ResponsesTransport>(
    state: &'a V3ListenerState,
    transport: &'a T,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> V3ResponsesRelayExecutionEnv<'a, T> {
    V3ResponsesRelayExecutionEnv::new(
        transport,
        V3ResponsesRelayHealthSource::Shared(&state.provider_health),
    )
    .with_local_stopless_control(V3ResponsesRelayLocalStoplessControlInput::new(
        &state.responses_relay_local_continuation,
        &state.responses_relay_stopless_control,
        scope,
        now_epoch_ms,
    ))
}

pub(super) async fn execute_responses_relay_runtime_for_http_request<T: V3ResponsesTransport>(
    state: &V3ListenerState,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
    plan: Option<&V3ResponsesProtocolExecutionPlan>,
) -> V3ResponsesRelayRuntimeOutput {
    let mut env = build_responses_relay_execution_env(state, transport, scope, now_epoch_ms);
    if let Some(plan) = plan {
        env = env.with_initial_target(plan.decision.target.clone());
    }
    match execute_v3_responses_relay_runtime(&state.manifest, input, env).await {
        Ok(mut output) => {
            if let Some(plan) = plan {
                prepend_v3_protocol_plan_trace_to_responses_relay_output(
                    &mut output,
                    &plan.node_trace,
                );
            }
            output
        }
        Err(error) => project_v3_responses_relay_runtime_failure(error),
    }
}

pub(super) fn build_responses_relay_local_continuation_scope(
    headers: &HeaderMap,
    request_id: &str,
    server: &V3ServerManifest,
    endpoint: &str,
    payload: &Value,
) -> Result<V3ResponsesRelayLocalContinuationScope, String> {
    let turn_metadata = parse_codex_turn_metadata(headers)?;
    let session_id = first_header_text(headers, &["session-id", "session_id", "x-session-id"])?
        .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_SESSION_PATHS))
        .or_else(|| read_first_scope_value(Some(payload), BODY_SESSION_PATHS));
    let conversation_id = first_header_text(
        headers,
        &[
            "thread-id",
            "thread_id",
            "conversation-id",
            "conversation_id",
            "x-conversation-id",
        ],
    )?
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_CONVERSATION_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_CONVERSATION_PATHS));
    let (session_id, conversation_id) = resolve_transparent_continuation_scope(
        session_id,
        conversation_id,
        payload_needs_relay_local_continuation_scope(payload),
        request_id,
    )?;
    Ok(V3ResponsesRelayLocalContinuationScope::responses(
        endpoint,
        session_id,
        conversation_id,
        server.port,
        server.routing_group.clone(),
    ))
}

pub(super) fn build_responses_previous_response_owner_resolution_context(
    headers: &HeaderMap,
    request_id: &str,
    server: &V3ServerManifest,
    endpoint: &str,
    payload: &Value,
) -> Result<Option<V3ResponsesPreviousResponseOwnerResolutionContext>, String> {
    if payload
        .get("previous_response_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Ok(None);
    }
    let direct_scope =
        build_responses_direct_continuation_scope(headers, request_id, server, endpoint, payload)?;
    let relay_scope = build_responses_relay_local_continuation_scope(
        headers, request_id, server, endpoint, payload,
    )?;
    let now_epoch_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("system time precedes Unix epoch: {error}"))?
        .as_millis() as u64;
    Ok(Some(V3ResponsesPreviousResponseOwnerResolutionContext {
        direct_scope,
        relay_scope,
        now_epoch_ms,
    }))
}

pub(super) fn resolve_transparent_continuation_scope(
    session_id: Option<String>,
    conversation_id: Option<String>,
    requires_client_scope: bool,
    request_id: &str,
) -> Result<(String, String), String> {
    match (session_id, conversation_id) {
        (Some(session_id), Some(conversation_id)) => Ok((session_id, conversation_id)),
        (None, None) if !requires_client_scope => {
            let request_scope = format!("request:{request_id}");
            Ok((request_scope.clone(), request_scope))
        }
        _ => Err(
            "Responses continuation requires client-provided session_id and thread_id via transparent headers, x-codex-turn-metadata, or body client_metadata"
                .to_string(),
        ),
    }
}

pub(super) fn payload_needs_direct_continuation_scope(payload: &Value) -> bool {
    payload.get("previous_response_id").is_some()
        || payload_input_has_function_call_output(payload.get("input"))
}

pub(super) fn payload_needs_relay_local_continuation_scope(payload: &Value) -> bool {
    payload.get("previous_response_id").is_some()
        || payload_input_has_unpaired_function_call_output(payload.get("input"))
}

pub(super) fn payload_input_has_function_call_output(input: Option<&Value>) -> bool {
    match input {
        Some(Value::Array(items)) => items
            .iter()
            .any(|item| item.get("type").and_then(Value::as_str) == Some("function_call_output")),
        Some(Value::Object(item)) => {
            item.get("type").and_then(Value::as_str) == Some("function_call_output")
        }
        _ => false,
    }
}

pub(super) fn payload_input_has_unpaired_function_call_output(input: Option<&Value>) -> bool {
    let Some(input) = input else {
        return false;
    };
    let Some(items) = input.as_array() else {
        return input
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|item_type| {
                matches!(
                    item_type,
                    "function_call_output" | "custom_tool_call_output" | "tool_call_output"
                )
            });
    };
    let paired_call_ids: Vec<&str> = items
        .iter()
        .filter_map(|item| {
            let item_type = item.get("type").and_then(Value::as_str)?;
            if !matches!(
                item_type,
                "function_call" | "custom_tool_call" | "tool_call"
            ) {
                return None;
            }
            item.get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        })
        .collect();
    items.iter().any(|item| {
        let Some(item_type) = item.get("type").and_then(Value::as_str) else {
            return false;
        };
        if !matches!(
            item_type,
            "function_call_output" | "custom_tool_call_output" | "tool_call_output"
        ) {
            return false;
        }
        let Some(call_id) = item
            .get("call_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return false;
        };
        !paired_call_ids.iter().any(|paired| paired == &call_id)
    })
}

pub(super) const TURN_METADATA_SESSION_PATHS: &[&[&str]] =
    &[&["session_id"], &["sessionId"], &["session-id"]];

pub(super) const TURN_METADATA_CONVERSATION_PATHS: &[&[&str]] = &[
    &["thread_id"],
    &["threadId"],
    &["thread-id"],
    &["conversation_id"],
    &["conversationId"],
    &["conversation-id"],
];

pub(super) const TURN_METADATA_TMUX_PATHS: &[&[&str]] = &[
    &["clientTmuxSessionId"],
    &["client_tmux_session_id"],
    &["rccSessionClientTmuxSessionId"],
    &["rcc_session_client_tmux_session_id"],
    &["tmux_session"],
    &["tmuxSession"],
    &["tmuxSessionId"],
    &["tmux_session_id"],
    &["scope", "clientTmuxSessionId"],
    &["scope", "client_tmux_session_id"],
    &["scope", "rccSessionClientTmuxSessionId"],
    &["scope", "rcc_session_client_tmux_session_id"],
    &["scope", "tmux_session"],
    &["scope", "tmuxSession"],
    &["scope", "tmuxSessionId"],
    &["scope", "tmux_session_id"],
];

pub(super) const TURN_METADATA_WORKDIR_PATHS: &[&[&str]] = &[
    &["workdir"],
    &["cwd"],
    &["workingDirectory"],
    &["working_directory"],
];

pub(super) const BODY_SESSION_PATHS: &[&[&str]] = &[
    &["client_metadata", "session_id"],
    &["client_metadata", "sessionId"],
    &["client_metadata", "session-id"],
    &["clientMetadata", "session_id"],
    &["clientMetadata", "sessionId"],
    &["metadata", "session_id"],
    &["metadata", "sessionId"],
    &["metadata", "client_metadata", "session_id"],
    &["metadata", "client_metadata", "sessionId"],
    &["metadata", "clientMetadata", "session_id"],
    &["metadata", "clientMetadata", "sessionId"],
];

pub(super) const BODY_WORKDIR_PATHS: &[&[&str]] = &[
    &["workdir"],
    &["cwd"],
    &["workingDirectory"],
    &["working_directory"],
    &["metadata", "workdir"],
    &["metadata", "cwd"],
    &["metadata", "workingDirectory"],
    &["metadata", "working_directory"],
];

pub(super) const BODY_CONVERSATION_PATHS: &[&[&str]] = &[
    &["client_metadata", "thread_id"],
    &["client_metadata", "threadId"],
    &["client_metadata", "thread-id"],
    &["client_metadata", "conversation_id"],
    &["client_metadata", "conversationId"],
    &["client_metadata", "conversation-id"],
    &["clientMetadata", "thread_id"],
    &["clientMetadata", "threadId"],
    &["clientMetadata", "conversation_id"],
    &["clientMetadata", "conversationId"],
    &["metadata", "thread_id"],
    &["metadata", "threadId"],
    &["metadata", "conversation_id"],
    &["metadata", "conversationId"],
    &["metadata", "client_metadata", "thread_id"],
    &["metadata", "client_metadata", "threadId"],
    &["metadata", "client_metadata", "conversation_id"],
    &["metadata", "client_metadata", "conversationId"],
    &["metadata", "clientMetadata", "thread_id"],
    &["metadata", "clientMetadata", "threadId"],
    &["metadata", "clientMetadata", "conversation_id"],
    &["metadata", "clientMetadata", "conversationId"],
];

pub(super) fn parse_codex_turn_metadata(headers: &HeaderMap) -> Result<Option<Value>, String> {
    let Some(text) = header_text(headers, "x-codex-turn-metadata")? else {
        return Ok(None);
    };
    let mut last_error = match serde_json::from_str::<Value>(&text) {
        Ok(value) => return Ok(Some(value)),
        Err(error) => error.to_string(),
    };
    if let Some(decoded) = percent_decode_header_value(&text)? {
        match serde_json::from_str::<Value>(&decoded) {
            Ok(value) => return Ok(Some(value)),
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(format!(
        "x-codex-turn-metadata is not valid JSON: {last_error}"
    ))
}

pub(super) fn percent_decode_header_value(value: &str) -> Result<Option<String>, String> {
    if !value.as_bytes().contains(&b'%') {
        return Ok(None);
    }
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            return Err("x-codex-turn-metadata has incomplete percent escape".to_string());
        }
        let high = decode_hex(bytes[index + 1])
            .ok_or_else(|| "x-codex-turn-metadata has invalid percent escape".to_string())?;
        let low = decode_hex(bytes[index + 2])
            .ok_or_else(|| "x-codex-turn-metadata has invalid percent escape".to_string())?;
        decoded.push((high << 4) | low);
        index += 3;
    }
    String::from_utf8(decoded).map(Some).map_err(|error| {
        format!("x-codex-turn-metadata percent-decoded value is not UTF-8: {error}")
    })
}

pub(super) fn decode_hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

pub(super) fn first_header_text(
    headers: &HeaderMap,
    names: &[&str],
) -> Result<Option<String>, String> {
    for name in names {
        if let Some(value) = header_text(headers, name)? {
            return Ok(Some(value));
        }
    }
    Ok(None)
}

pub(super) fn read_first_scope_value(source: Option<&Value>, paths: &[&[&str]]) -> Option<String> {
    for path in paths {
        if let Some(value) = read_scope_value_at_path(source?, path) {
            return Some(value);
        }
    }
    None
}

pub(super) fn read_scope_value_at_path(source: &Value, path: &[&str]) -> Option<String> {
    let mut current = source;
    for segment in path {
        current = current.get(*segment)?;
    }
    let value = current.as_str()?.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

pub(super) fn header_text(headers: &HeaderMap, name: &str) -> Result<Option<String>, String> {
    headers
        .get(name)
        .map(|value| {
            value
                .to_str()
                .map(str::trim)
                .map(ToOwned::to_owned)
                .map_err(|error| format!("{name} is not UTF-8: {error}"))
        })
        .transpose()
        .map(|value| value.filter(|value| !value.is_empty()))
}
