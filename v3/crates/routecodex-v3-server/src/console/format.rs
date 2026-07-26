use super::super::*;
use super::*;

#[derive(Debug, Clone)]
pub(crate) struct V3ConsoleLogIdentity {
    pub(crate) color_key: Option<String>,
    pub(crate) session_id: String,
    pub(crate) project_path: Option<String>,
    pub(crate) request_model: Option<String>,
}

pub(crate) fn resolve_v3_console_log_identity(
    context: &V3ConsoleEmissionContext,
) -> V3ConsoleLogIdentity {
    resolve_v3_console_log_identity_from_parts(
        &context.headers,
        &context.payload,
        &context.request_id,
    )
}

pub(crate) fn resolve_v3_console_log_identity_from_parts(
    headers: &HeaderMap,
    payload: &Value,
    request_id: &str,
) -> V3ConsoleLogIdentity {
    let turn_metadata = parse_codex_turn_metadata(headers).ok().flatten();
    let session_id = first_header_text(
        headers,
        &[
            "session-id",
            "session_id",
            "x-session-id",
            "x-routecodex-session-id",
            "x-rcc-session-id",
        ],
    )
    .ok()
    .flatten()
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
            "x-routecodex-conversation-id",
        ],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_CONVERSATION_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_CONVERSATION_PATHS));
    let project_path =
        resolve_v3_console_project_path_with_metadata(headers, payload, turn_metadata.as_ref());
    let color_key = resolve_v3_log_session_color_key(headers, payload, request_id);
    let session_display = session_id
        .or(conversation_id)
        .or_else(|| color_key.clone())
        .unwrap_or_else(|| format!("request:{}", format_v3_usage_request_id(request_id)));
    V3ConsoleLogIdentity {
        color_key,
        session_id: format_v3_console_safe_label(&session_display),
        project_path,
        request_model: payload
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    }
}

pub(crate) fn resolve_v3_console_project_path(
    headers: &HeaderMap,
    payload: &Value,
) -> Option<String> {
    let turn_metadata = parse_codex_turn_metadata(headers).ok().flatten();
    resolve_v3_console_project_path_with_metadata(headers, payload, turn_metadata.as_ref())
}

pub(crate) fn resolve_v3_console_project_path_with_metadata(
    headers: &HeaderMap,
    payload: &Value,
    turn_metadata: Option<&Value>,
) -> Option<String> {
    first_header_text(
        headers,
        &["x-routecodex-workdir", "x-rcc-workdir", "x-workdir"],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata, TURN_METADATA_WORKDIR_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_WORKDIR_PATHS))
    .or_else(|| read_v3_environment_context_cwd_from_payload(payload))
}

pub(crate) fn read_v3_environment_context_cwd_from_payload(payload: &Value) -> Option<String> {
    for item in payload.get("input").and_then(Value::as_array)? {
        let Some(parts) = item.get("content").and_then(Value::as_array) else {
            continue;
        };
        for text in parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
        {
            if let Some(cwd) = read_v3_environment_context_cwd_from_text(text) {
                return Some(cwd);
            }
        }
    }
    None
}

pub(crate) fn read_v3_environment_context_cwd_from_text(text: &str) -> Option<String> {
    let start = text.find("<environment_context>")?;
    let tail = &text[start..];
    let cwd_start = tail.find("<cwd>")? + "<cwd>".len();
    let cwd_tail = &tail[cwd_start..];
    let cwd_end = cwd_tail.find("</cwd>")?;
    let cwd = cwd_tail[..cwd_end].trim();
    if cwd.is_empty() {
        None
    } else {
        Some(cwd.to_string())
    }
}

pub(crate) fn format_v3_console_line_for_observability(
    context: &V3ConsoleEmissionContext,
    identity: &V3ConsoleLogIdentity,
    observability: &V3RuntimeObservability,
    content: &str,
) -> String {
    format_v3_console_scoped_line(
        &context.state.server.port.to_string(),
        &context.entry_protocol,
        &identity.session_id,
        identity.project_path.as_deref(),
        &format_v3_console_provider_target_compact(observability),
        &format_v3_console_route_hit_label(&context.state, observability),
        content,
    )
}

pub(crate) fn format_v3_console_monitor_line(
    port_label: &str,
    entry_protocol: &str,
    project_path: Option<&str>,
    content: &str,
) -> String {
    format!(
        "{} {}",
        format_v3_console_monitor_prefix(port_label, entry_protocol, project_path),
        content
    )
}

pub(crate) fn format_v3_console_monitor_prefix(
    port_label: &str,
    entry_protocol: &str,
    project_path: Option<&str>,
) -> String {
    format_v3_console_scoped_prefix(port_label, entry_protocol, "-", project_path, "-", "-")
}

pub(crate) fn format_v3_console_scoped_line(
    port_label: &str,
    entry_protocol: &str,
    session_id: &str,
    project_path: Option<&str>,
    model_scope: &str,
    route_scope: &str,
    content: &str,
) -> String {
    format!(
        "{} {}",
        format_v3_console_scoped_prefix(
            port_label,
            entry_protocol,
            session_id,
            project_path,
            model_scope,
            route_scope,
        ),
        content
    )
}

pub(crate) fn format_v3_console_scoped_prefix(
    port_label: &str,
    entry_protocol: &str,
    session_id: &str,
    project_path: Option<&str>,
    model_scope: &str,
    route_scope: &str,
) -> String {
    format!(
        "[{}:{}:sessionID:{}][{}][{}][{}]",
        format_v3_console_safe_label(port_label),
        format_v3_console_entry_protocol_label(entry_protocol),
        format_v3_console_safe_label(session_id),
        format_v3_console_aligned_scope_value(
            &format_v3_console_project_name(project_path),
            V3_CONSOLE_PROJECT_SCOPE_WIDTH,
        ),
        format_v3_console_aligned_scope_value(
            &format_v3_console_safe_label(model_scope),
            V3_CONSOLE_MODEL_SCOPE_WIDTH,
        ),
        format_v3_console_aligned_scope_value(
            &format_v3_console_safe_label(route_scope),
            V3_CONSOLE_ROUTE_SCOPE_WIDTH,
        )
    )
}

const V3_CONSOLE_PROJECT_SCOPE_WIDTH: usize = 12;
const V3_CONSOLE_MODEL_SCOPE_WIDTH: usize = 28;
const V3_CONSOLE_ROUTE_SCOPE_WIDTH: usize = 13;
const V3_CONSOLE_CONTENT_TAG_WIDTH: usize = 24;

pub(crate) fn format_v3_console_aligned_scope_value(value: &str, width: usize) -> String {
    align_v3_console_display_width(value, width)
}

pub(crate) fn format_v3_console_timed_content(tag: &str, fields: &str) -> String {
    let tag = align_v3_console_display_width(tag, V3_CONSOLE_CONTENT_TAG_WIDTH);
    let timestamp = console_timestamp_hhmmss();
    format!("{tag} {timestamp} {fields}")
}

pub(crate) fn align_v3_console_display_width(value: &str, width: usize) -> String {
    let display_width = v3_console_display_width(value);
    if display_width >= width {
        return value.to_string();
    }
    format!("{value}{}", " ".repeat(width - display_width))
}

pub(crate) fn v3_console_display_width(value: &str) -> usize {
    value.chars().map(v3_console_char_display_width).sum()
}

pub(crate) fn v3_console_char_display_width(character: char) -> usize {
    let codepoint = character as u32;
    if character.is_control()
        || matches!(
            codepoint,
            0x0300..=0x036F
                | 0x1AB0..=0x1AFF
                | 0x1DC0..=0x1DFF
                | 0x20D0..=0x20FF
                | 0xFE00..=0xFE0F
        )
    {
        0
    } else if matches!(
        codepoint,
        0x1100..=0x115F
            | 0x2329..=0x232A
            | 0x2E80..=0xA4CF
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE10..=0xFE19
            | 0xFE30..=0xFE6F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
            | 0x2705
            | 0x274C
            | 0x1F000..=0x1FAFF
            | 0x20000..=0x3FFFD
    ) {
        2
    } else {
        1
    }
}

pub(crate) fn format_v3_console_entry_protocol_label(entry_protocol_or_endpoint: &str) -> String {
    let entry = match entry_protocol_or_endpoint.trim() {
        "/v1/responses" => "responses",
        "/v1/messages" => "anthropic",
        "/v1/chat/completions" => "openai_chat",
        "/v1beta/models"
        | "/v1beta/models:generateContent"
        | "/v1beta/models:streamGenerateContent" => "gemini",
        value => value,
    };
    format_v3_console_safe_label(entry)
}

pub(crate) fn format_v3_console_safe_label(value: &str) -> String {
    let normalized = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_control() || character.is_whitespace() {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if normalized.is_empty() {
        "-".to_string()
    } else {
        normalized
    }
}

pub(crate) fn format_v3_console_route_hit_label(
    state: &V3ListenerState,
    observability: &V3RuntimeObservability,
) -> String {
    let reason = format_v3_console_hit_reason(state, observability);
    if reason == "provider-request-dry-run" {
        return reason;
    }
    observability
        .pool_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "dry_run")
        .or(observability.routing_group_id.as_deref())
        .unwrap_or(&state.server.routing_group)
        .to_string()
}

pub(crate) fn format_v3_console_hit_reason(
    _state: &V3ListenerState,
    observability: &V3RuntimeObservability,
) -> String {
    if observability.pool_id.as_deref() == Some("dry_run")
        || observability
            .target_path
            .iter()
            .any(|part| part.contains("dry_run"))
    {
        return "provider-request-dry-run".to_string();
    }
    if let Some(pool) = observability
        .pool_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!("pool:{pool}");
    }
    observability
        .routing_group_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("route:{value}"))
        .unwrap_or_else(|| "route:selected".to_string())
}

pub(crate) fn format_v3_console_provider_target_compact(
    observability: &V3RuntimeObservability,
) -> String {
    let (provider_from_key, _, model_from_key) =
        parse_v3_console_provider_key(observability.provider_key.as_deref());
    let provider = observability
        .provider_id
        .as_deref()
        .or(provider_from_key.as_deref())
        .unwrap_or("-");
    let model = observability
        .wire_model
        .as_deref()
        .or(model_from_key.as_deref())
        .or(observability.model_id.as_deref())
        .unwrap_or("-");
    if provider == "-" && model == "-" {
        "-".to_string()
    } else if model == "-" || model.trim().is_empty() {
        provider.to_string()
    } else {
        format!("{provider}.{model}")
    }
}

pub(crate) fn format_v3_console_provider_target(observability: &V3RuntimeObservability) -> String {
    let (provider_from_key, alias_from_key, model_from_key) =
        parse_v3_console_provider_key(observability.provider_key.as_deref());
    let provider = observability
        .provider_id
        .as_deref()
        .or(provider_from_key.as_deref())
        .unwrap_or("-");
    let alias = observability
        .auth_alias
        .as_deref()
        .or(alias_from_key.as_deref())
        .filter(|value| !value.trim().is_empty());
    let model = observability
        .wire_model
        .as_deref()
        .or(model_from_key.as_deref())
        .or(observability.model_id.as_deref());
    let provider_label = match alias {
        Some(alias) => format!("{provider}[{alias}]"),
        None => provider.to_string(),
    };
    match model {
        Some(model) if !model.trim().is_empty() && model != "-" => {
            format!("{provider_label}.{model}")
        }
        _ => provider_label,
    }
}

pub(crate) fn format_v3_console_provider_key_label(provider_key: &str) -> String {
    let (provider_from_key, alias_from_key, model_from_key) =
        parse_v3_console_provider_key(Some(provider_key));
    let provider = provider_from_key.unwrap_or_else(|| provider_key.to_string());
    let provider_label = match alias_from_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(alias) => format!("{provider}[{alias}]"),
        None => provider,
    };
    match model_from_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(model) => format!("{provider_label}.{model}"),
        None => provider_label,
    }
}

pub(crate) fn format_v3_console_single_line_message(message: &str) -> String {
    let normalized = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        "-".to_string()
    } else {
        normalized
    }
}

pub(crate) fn parse_v3_console_provider_key(
    provider_key: Option<&str>,
) -> (Option<String>, Option<String>, Option<String>) {
    let Some(provider_key) = provider_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return (None, None, None);
    };
    let parts = provider_key.split(':').collect::<Vec<_>>();
    match parts.as_slice() {
        [provider, alias, model, ..] => (
            Some((*provider).to_string()),
            Some((*alias).to_string()),
            Some((*model).to_string()),
        ),
        [provider, model] => (
            Some((*provider).to_string()),
            None,
            Some((*model).to_string()),
        ),
        [provider] => (Some((*provider).to_string()), None, None),
        [] => (None, None, None),
    }
}

pub(crate) fn format_v3_usage_request_id(request_id: &str) -> String {
    let normalized = request_id.trim();
    let normalized = if normalized.is_empty() {
        "unknown-request"
    } else {
        normalized
    };
    if let Some(sequence) = parse_v3_direct_sequence(normalized, '-') {
        return sequence;
    }
    if let Some(rest) = normalized.strip_prefix("req_") {
        if let Some(sequence) = parse_v3_direct_sequence(rest, '_') {
            return sequence;
        }
    }
    if let Some(sequence) = parse_v3_trailing_provider_sequence(normalized) {
        return sequence;
    }
    short_v3_request_tail(normalized, 8)
}

pub(crate) fn parse_v3_direct_sequence(value: &str, delimiter: char) -> Option<String> {
    let (left, right) = value.split_once(delimiter)?;
    if !left.is_empty()
        && !right.is_empty()
        && left.chars().all(|character| character.is_ascii_digit())
        && right.chars().all(|character| character.is_ascii_digit())
    {
        Some(format!("{left}-{right}"))
    } else {
        None
    }
}

pub(crate) fn parse_v3_trailing_provider_sequence(value: &str) -> Option<String> {
    let without_suffix = value.split(':').next().unwrap_or(value);
    let mut segments = without_suffix.rsplitn(3, '-');
    let daily = segments.next()?;
    let total = segments.next()?;
    if !daily.is_empty()
        && !total.is_empty()
        && daily.chars().all(|character| character.is_ascii_digit())
        && total.chars().all(|character| character.is_ascii_digit())
    {
        Some(format!("{total}-{daily}"))
    } else {
        None
    }
}

pub(crate) fn short_v3_request_tail(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return value.to_string();
    }
    chars[chars.len() - max_chars..].iter().collect()
}

pub(crate) fn format_v3_console_project_name(project_path: Option<&str>) -> String {
    let Some(project) = project_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return "-".to_string();
    };
    let trimmed = project.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return "-".to_string();
    }
    std::path::Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .map(format_v3_console_safe_label)
        .filter(|value| value != "-")
        .unwrap_or_else(|| {
            trimmed
                .rsplit(['/', '\\'])
                .find(|value| !value.trim().is_empty())
                .map(format_v3_console_safe_label)
                .unwrap_or_else(|| "-".to_string())
        })
}

pub(crate) fn format_v3_console_usage_summary(usage: Option<&V3RuntimeUsageSummary>) -> String {
    let Some(usage) = usage else {
        return "usage=unreported".to_string();
    };
    let input_tokens = usage.input_tokens;
    let input = input_tokens
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unreported".to_string());
    let output = usage
        .output_tokens
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unreported".to_string());
    let total = usage
        .total_tokens
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unreported".to_string());
    let cache = match (usage.cached_tokens, input_tokens) {
        (Some(cached), Some(input)) if input > 0 => {
            format!(
                "{cached}/{input}({:.1}%)",
                (cached as f64 / input as f64) * 100.0
            )
        }
        (Some(cached), _) => cached.to_string(),
        (None, _) => "0".to_string(),
    };
    format!("usage_in={input} usage_out={output} usage_cache={cache} usage_total={total}")
}

pub(crate) fn build_v3_foundation_console_observability(
    state: &V3ListenerState,
    output: &V3FoundationRuntimeOutput,
) -> V3RuntimeObservability {
    let provider_request = output
        .body
        .get("providerRequest")
        .or_else(|| output.body.pointer("/dry_run/provider_request"))
        .unwrap_or(&Value::Null);
    let provider_id = provider_request
        .get("providerId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let model_id = provider_request
        .pointer("/body/model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let transport = provider_request
        .get("streamIntent")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("json")
        .to_string();
    let response_status = output
        .body
        .pointer("/dry_run/response_payload/status")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            output
                .body
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let finish_reason = output
        .body
        .pointer("/dry_run/response_payload")
        .and_then(read_v3_console_finish_reason)
        .or_else(|| read_v3_console_finish_reason(&output.body))
        .or_else(|| {
            infer_v3_console_finish_reason_from_response_status(response_status.as_deref())
        });
    let usage = output
        .body
        .pointer("/dry_run/response_payload")
        .and_then(extract_v3_console_usage_summary);
    let auth_alias =
        resolve_v3_foundation_console_auth_alias(&state.manifest, provider_id.as_deref());
    V3RuntimeObservability {
        entry_protocol: "responses".to_string(),
        execution_mode: "direct".to_string(),
        transport,
        routing_group_id: Some(state.server.routing_group.clone()),
        pool_id: Some("dry_run".to_string()),
        provider_key: provider_id.as_ref().map(|provider| {
            match (auth_alias.as_deref(), model_id.as_deref()) {
                (Some(alias), Some(model)) => format!("{provider}:{alias}:{model}"),
                (Some(alias), None) => format!("{provider}:{alias}"),
                (None, Some(model)) => format!("{provider}:{model}"),
                (None, None) => provider.clone(),
            }
        }),
        provider_type: Some("responses".to_string()),
        provider_id,
        auth_alias,
        model_id: model_id.clone(),
        wire_model: model_id,
        provider_status: Some(output.status),
        response_status,
        finish_reason,
        stopless_activation: false,
        attempts: Some(1),
        unavailable_candidates: Vec::new(),
        provider_failure_events: Vec::new(),
        target_path: vec!["dry_run:provider_request".to_string()],
        usage,
    }
}

pub(crate) fn resolve_v3_foundation_console_auth_alias(
    manifest: &V3Config05ManifestPublished,
    provider_id: Option<&str>,
) -> Option<String> {
    let provider = manifest.providers.get(provider_id?)?;
    if provider.auth.entries.len() == 1 {
        return provider
            .auth
            .entries
            .first()
            .map(|entry| entry.alias.clone());
    }
    None
}

pub(crate) fn read_v3_console_response_status(value: &Value) -> Option<String> {
    read_v3_console_string_path(value, &["status"])
        .or_else(|| read_v3_console_string_path(value, &["response", "status"]))
        .or_else(|| read_v3_console_string_path(value, &["message", "status"]))
}

pub(crate) fn read_v3_console_finish_reason(value: &Value) -> Option<String> {
    read_v3_console_string_path(value, &["finish_reason"])
        .or_else(|| read_v3_console_string_path(value, &["finishReason"]))
        .or_else(|| read_v3_console_string_path(value, &["stop_reason"]))
        .or_else(|| read_v3_console_string_path(value, &["stopReason"]))
        .or_else(|| read_v3_console_string_path(value, &["response", "finish_reason"]))
        .or_else(|| read_v3_console_string_path(value, &["response", "finishReason"]))
        .or_else(|| read_v3_console_string_path(value, &["response", "stop_reason"]))
        .or_else(|| read_v3_console_string_path(value, &["response", "stopReason"]))
        .or_else(|| read_v3_console_string_path(value, &["choices", "0", "finish_reason"]))
        .or_else(|| read_v3_console_string_path(value, &["candidates", "0", "finishReason"]))
}

pub(crate) fn infer_v3_console_finish_reason_from_response_status(
    response_status: Option<&str>,
) -> Option<String> {
    match response_status.map(str::trim) {
        Some(status) if status.eq_ignore_ascii_case("completed") => Some("stop".to_string()),
        Some(status) if status.eq_ignore_ascii_case("done") => Some("stop".to_string()),
        Some(status) if status.eq_ignore_ascii_case("requires_action") => {
            Some("tool_calls".to_string())
        }
        _ => None,
    }
}

pub(crate) fn read_v3_console_string_path(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for segment in path {
        if let Ok(index) = segment.parse::<usize>() {
            current = current.get(index)?;
        } else {
            current = current.get(*segment)?;
        }
    }
    current
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn extract_v3_console_usage_summary(value: &Value) -> Option<V3RuntimeUsageSummary> {
    let usage = value.get("usage")?;
    let summary = V3RuntimeUsageSummary {
        input_tokens: read_v3_console_usage_u64(usage, &["input_tokens"])
            .or_else(|| read_v3_console_usage_u64(usage, &["prompt_tokens"])),
        output_tokens: read_v3_console_usage_u64(usage, &["output_tokens"])
            .or_else(|| read_v3_console_usage_u64(usage, &["completion_tokens"])),
        total_tokens: read_v3_console_usage_u64(usage, &["total_tokens"]),
        cached_tokens: read_v3_console_usage_u64(usage, &["input_tokens_details", "cached_tokens"])
            .or_else(|| {
                read_v3_console_usage_u64(usage, &["input_tokens_details", "cached_read_tokens"])
            })
            .or_else(|| {
                read_v3_console_usage_u64(usage, &["input_tokens_details", "cache_read_tokens"])
            })
            .or_else(|| {
                read_v3_console_usage_u64(usage, &["prompt_tokens_details", "cached_tokens"])
            })
            .or_else(|| {
                read_v3_console_usage_u64(usage, &["prompt_tokens_details", "cached_read_tokens"])
            })
            .or_else(|| {
                read_v3_console_usage_u64(usage, &["prompt_tokens_details", "cache_read_tokens"])
            })
            .or_else(|| read_v3_console_usage_u64(usage, &["cache_read_input_tokens"])),
    };
    if summary.input_tokens.is_some()
        || summary.output_tokens.is_some()
        || summary.total_tokens.is_some()
        || summary.cached_tokens.is_some()
    {
        Some(summary)
    } else {
        None
    }
}

pub(crate) fn read_v3_console_usage_u64(value: &Value, path: &[&str]) -> Option<u64> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_u64().or_else(|| {
        current
            .as_i64()
            .and_then(|number| u64::try_from(number).ok())
    })
}
