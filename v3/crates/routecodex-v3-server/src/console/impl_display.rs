use crate::*;
use serde_json::Value;

pub(crate) fn format_v3_console_usage_summary(usage: Option<&V3RuntimeUsageSummary>) -> String {
    let Some(usage) = usage else {
        return "usage=unreported".to_string();
    };
    let input_tokens = v3_console_effective_input_tokens(usage);
    let input = input_tokens
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unreported".to_string());
    let output = usage
        .output_tokens
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unreported".to_string());
    let total = v3_console_effective_total_tokens(usage)
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

pub(crate) fn format_v3_console_human_usage_summary(
    usage: Option<&V3RuntimeUsageSummary>,
) -> Option<String> {
    let usage = usage?;
    let mut fields = Vec::new();
    let input_tokens = v3_console_effective_input_tokens(usage);
    if let Some(input) = input_tokens {
        fields.push(format!("usage_in={input}"));
    }
    if let Some(output) = usage.output_tokens {
        fields.push(format!("usage_out={output}"));
    }
    if let Some(cached) = usage.cached_tokens {
        let cache = match input_tokens {
            Some(input) if input > 0 => {
                format!(
                    "{cached}/{input}({:.1}%)",
                    (cached as f64 / input as f64) * 100.0
                )
            }
            _ => cached.to_string(),
        };
        fields.push(format!("usage_cache={cache}"));
    }
    if let Some(total) = v3_console_effective_total_tokens(usage) {
        fields.push(format!("usage_total={total}"));
    }
    (!fields.is_empty()).then(|| fields.join(" "))
}

pub(crate) fn v3_console_effective_input_tokens(usage: &V3RuntimeUsageSummary) -> Option<u64> {
    match (usage.input_tokens, usage.cached_tokens) {
        // Anthropic reports an uncached increment plus a separate cache-read count.
        (Some(input), Some(cached)) if cached > input => input.checked_add(cached),
        (input, _) => input,
    }
}

pub(crate) fn v3_console_effective_total_tokens(usage: &V3RuntimeUsageSummary) -> Option<u64> {
    match (usage.total_tokens, usage.input_tokens, usage.cached_tokens) {
        (Some(total), Some(input), Some(cached)) if cached > input => total.checked_add(cached),
        (total, _, _) => total,
    }
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
        // Responses 协议 response.incomplete 合法终态的观测兜底：reason 通常由
        // stream_observation 显式记录（max_output_tokens -> length）；JSON 路径
        // 或未知 reason 时按截断语义投影 length。
        Some(status) if status.eq_ignore_ascii_case("incomplete") => Some("length".to_string()),
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

pub(crate) fn emit_v3_frame_error_console_line(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    frame: &V3Server16HttpFrame,
    project_path: Option<&str>,
) {
    if frame.error_chain.is_empty() && frame.status < 400 {
        return;
    }
    emit_v3_error_console_line(
        server,
        endpoint,
        request_id,
        frame.status,
        &frame.error_chain,
        v3_server_frame_error_body_for_console(frame),
        project_path,
    );
}

pub(crate) fn emit_v3_frame_error_console_line_for_state(
    state: &V3ListenerState,
    endpoint: &str,
    request_id: &str,
    frame: &V3Server16HttpFrame,
    project_path: Option<&str>,
) {
    if frame.error_chain.is_empty() && frame.status < 400 {
        return;
    }
    emit_v3_error_console_line_for_state(
        state,
        endpoint,
        request_id,
        frame.status,
        &frame.error_chain,
        v3_server_frame_error_body_for_console(frame),
        project_path,
    );
}

pub(crate) fn emit_v3_frame_error_console_line_for_context(
    context: &V3ConsoleEmissionContext,
    frame: &V3Server16HttpFrame,
    observability: &V3RuntimeObservability,
) {
    if frame.error_chain.is_empty() && frame.status < 400 {
        return;
    }
    emit_v3_error_console_line_for_context(
        context,
        observability,
        frame.status,
        &frame.error_chain,
        v3_server_frame_error_body_for_console(frame),
    );
}

pub(crate) fn v3_server_frame_error_body_for_console(
    frame: &V3Server16HttpFrame,
) -> Option<&Value> {
    frame.error_body.as_ref().or_else(|| match &frame.body {
        V3Server16Body::Json(value) => Some(value),
        V3Server16Body::Bytes(_) | V3Server16Body::Sse(_) => None,
    })
}

pub(crate) fn emit_v3_error_console_line_for_context(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
) {
    let identity = context.identity.clone();
    let route = resolve_v3_console_route_projection(observability);
    let content = format_v3_error_console_content(
        &context.endpoint,
        &context.request_identity.request_id,
        status,
        error_chain,
        body,
    );
    let content_str = content.as_str();
    let prefix = format_v3_console_human_prefix_for_observability(
        &context.state.server.port.to_string(),
        &context.entry_protocol,
        identity.project_path.as_deref(),
        observability,
        &route.label,
    );
    let colorized =
        colorize_v3_error_console_line(&prefix, content_str, content_str, &identity.session_id);
    append_v3_human_console_line(&context.state, &colorized);
    eprintln!("{colorized}");
}

pub(crate) fn emit_v3_error_console_line(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
    project_path: Option<&str>,
) {
    emit_v3_error_console_line_with_port(
        &server.port.to_string(),
        endpoint,
        request_id,
        status,
        error_chain,
        body,
        project_path,
    );
}

pub(crate) fn emit_v3_error_console_line_with_port(
    port_label: &str,
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
    project_path: Option<&str>,
) {
    let (headline, debug) =
        format_v3_error_console_headline_and_debug(endpoint, request_id, status, error_chain, body);
    let prefix = format_v3_console_human_prefix_for_port(port_label, endpoint, project_path);
    eprintln!(
        "{}",
        colorize_v3_error_console_line(&prefix, &headline, &debug, "-")
    );
}

pub(crate) fn emit_v3_error_console_line_for_state(
    state: &V3ListenerState,
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
    project_path: Option<&str>,
) {
    let (headline, debug) =
        format_v3_error_console_headline_and_debug(endpoint, request_id, status, error_chain, body);
    let prefix = format_v3_console_human_prefix_for_port(
        &state.server.port.to_string(),
        endpoint,
        project_path,
    );
    let colorized = colorize_v3_error_console_line(&prefix, &headline, &debug, "-");
    append_v3_human_console_line(state, &colorized);
    eprintln!("{colorized}");
}

pub(crate) fn format_v3_error_console_headline_and_debug(
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
) -> (String, String) {
    let content = format_v3_error_console_content(endpoint, request_id, status, error_chain, body);
    (content.clone(), content)
}

pub(crate) fn format_v3_error_console_content(
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
) -> String {
    let error_code = body
        .and_then(|value| value.pointer("/error/code").and_then(Value::as_str))
        .or_else(|| body.and_then(|value| value.pointer("/error/type").and_then(Value::as_str)))
        .unwrap_or("v3_error");
    let message = body
        .and_then(|value| value.pointer("/error/message").and_then(Value::as_str))
        .unwrap_or("V3 request failed");
    let error_node = error_chain
        .last()
        .copied()
        .unwrap_or("V3Error06ClientProjected");
    let error_number = compact_v3_error_number(error_chain);
    format_v3_console_timed_content(
        &format!("❌ [{endpoint}]"),
        &format!(
            "req={} event=failed status={} error={} subcode={} node={} message={}",
            request_id,
            status,
            error_number,
            error_code,
            error_node,
            format_v3_console_single_line_message(message)
        ),
    )
}

pub(crate) fn compact_v3_error_number(error_chain: &[&'static str]) -> String {
    let node = error_chain
        .last()
        .copied()
        .unwrap_or("V3Error06ClientProjected");
    let digits = node
        .chars()
        .skip_while(|character| !character.is_ascii_digit())
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        "V3E00".to_string()
    } else {
        format!("V3E{digits}")
    }
}

pub(crate) fn emit_v3_startup_console_line(listeners: &[V3ListenerHandle]) {
    println!("{}", format_v3_startup_console_block(listeners));
    println!("{}", format_v3_plain_startup_console_line(listeners));
    let _ = io::stdout().flush();
}

fn format_v3_plain_startup_console_line(listeners: &[V3ListenerHandle]) -> String {
    let addresses = listeners
        .iter()
        .map(|listener| listener.addr.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let executable = std::env::current_exe().ok();
    let binary = executable
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let version = executable
        .as_deref()
        .and_then(resolve_routecodex_package_version_from_executable)
        .unwrap_or_else(|| "unknown".to_string());
    format!(
        "[RouteCodexV3] Server started version={} crate={} binary={} on {addresses}",
        version,
        env!("CARGO_PKG_VERSION"),
        binary,
    )
}

pub(crate) fn format_v3_startup_console_block(listeners: &[V3ListenerHandle]) -> String {
    let addresses = listeners
        .iter()
        .map(|listener| listener.addr.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let executable = std::env::current_exe().ok();
    let binary = executable
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let version = executable
        .as_deref()
        .and_then(resolve_routecodex_package_version_from_executable)
        .unwrap_or_else(|| "unknown".to_string());
    let prefix = format_v3_console_human_prefix("server", "startup", None, "-", "-");
    let headline = format_v3_console_timed_content("✅ [RouteCodexV3]", "Server started");
    let debug = format!(
        "event=started version={} crate={} binary={} addresses={addresses}",
        version,
        env!("CARGO_PKG_VERSION"),
        binary,
    );
    colorize_v3_request_console_line(&prefix, &headline, &debug, None, "-")
}

pub(crate) const ANSI_RESET: &str = "\x1b[0m";
pub(crate) const ANSI_REQUEST_CYAN: &str = "\x1b[36m";
pub(crate) const ANSI_DEBUG_DIM: &str = "\x1b[2;90m";
pub(crate) const ANSI_ERROR_RED: &str = "\x1b[31m";
pub(crate) const ANSI_ERROR_TEXT_WHITE: &str = "\x1b[97m";
pub(crate) const ANSI_STOPLESS_ORANGE: &str = "\x1b[38;5;208m";

#[derive(Clone, Copy)]
pub(crate) struct V3ConsoleLayeredBlock<'a> {
    human_prefix: &'a str,
    headline: &'a str,
    debug: &'a str,
    session_id: &'a str,
}

impl<'a> V3ConsoleLayeredBlock<'a> {
    pub(crate) fn new(
        human_prefix: &'a str,
        headline: &'a str,
        debug: &'a str,
        session_id: &'a str,
    ) -> Self {
        assert!(
            !headline.is_empty(),
            "v3 console layered headline must be non-empty"
        );
        assert!(
            !debug.is_empty(),
            "v3 console layered debug must be non-empty"
        );
        Self {
            human_prefix,
            headline,
            debug,
            session_id,
        }
    }

    pub(crate) fn diagnostic(self) -> String {
        let safe_session = format_v3_console_safe_label(self.session_id);
        let session = if safe_session.is_empty() {
            "-"
        } else {
            &safe_session
        };
        let session_width =
            V3_CONSOLE_DEBUG_SCOPE_COLUMN_WIDTH - v3_console_display_width("[sessionID:]");
        let display_session = truncate_v3_console_display_width_middle(session, session_width);
        let scope = format!("[sessionID:{display_session}]");
        let diagnostic = format!(
            "{} {}",
            align_v3_console_display_width(&scope, V3_CONSOLE_DEBUG_SCOPE_COLUMN_WIDTH),
            self.debug
        );
        if display_session == session {
            diagnostic
        } else {
            format!("{diagnostic} sessionIDFull={session}")
        }
    }
}

pub(crate) fn is_v3_console_color_enabled() -> bool {
    let routecodex_force = std::env::var("ROUTECODEX_FORCE_LOG_COLOR")
        .ok()
        .or_else(|| std::env::var("RCC_FORCE_LOG_COLOR").ok())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if matches!(routecodex_force.as_str(), "1" | "true" | "yes" | "on") {
        return true;
    }
    if matches!(routecodex_force.as_str(), "0" | "false" | "no" | "off") {
        return false;
    }
    let force_color = std::env::var("FORCE_COLOR").unwrap_or_default();
    if force_color.trim() == "0" {
        return false;
    }
    true
}

pub(crate) fn colorize_v3_request_console_line(
    human_prefix: &str,
    headline: &str,
    debug: &str,
    color_key: Option<&str>,
    session_id: &str,
) -> String {
    let block = V3ConsoleLayeredBlock::new(human_prefix, headline, debug, session_id);
    if !is_v3_console_color_enabled() {
        return format_v3_console_layered_block_plain(block);
    }
    let color = color_key
        .and_then(resolve_v3_session_color)
        .unwrap_or_else(|| ANSI_REQUEST_CYAN.to_string());
    colorize_v3_layered_console_line(block, &color, ANSI_DEBUG_DIM)
}

pub(crate) fn colorize_v3_error_console_line(
    human_prefix: &str,
    headline: &str,
    debug: &str,
    session_id: &str,
) -> String {
    let block = V3ConsoleLayeredBlock::new(human_prefix, headline, debug, session_id);
    if !is_v3_console_color_enabled() {
        return format_v3_console_layered_block_plain(block);
    }
    colorize_v3_layered_console_line(block, ANSI_ERROR_RED, ANSI_DEBUG_DIM)
}

pub(crate) fn colorize_v3_single_error_console_line(human_prefix: &str, headline: &str) -> String {
    let line = if human_prefix.is_empty() {
        headline.to_string()
    } else {
        format!("{human_prefix} {headline}")
    };
    if is_v3_console_color_enabled() {
        format!("{ANSI_ERROR_RED}{line}{ANSI_RESET}")
    } else {
        line
    }
}

/// 行内局部错误着色：只把错误段（provider 名 + 错误详情）染红，
/// 行的其余部分（req/selected/reason 等）保持正常色，避免整行一片红。
pub(crate) fn colorize_v3_console_error_segment(segment: &str) -> String {
    if is_v3_console_color_enabled() {
        format!("{ANSI_ERROR_RED}{segment}{ANSI_RESET}")
    } else {
        segment.to_string()
    }
}

pub(crate) fn colorize_v3_stopless_console_line(
    human_prefix: &str,
    headline: &str,
    debug: &str,
    session_id: &str,
) -> String {
    let block = V3ConsoleLayeredBlock::new(human_prefix, headline, debug, session_id);
    if !is_v3_console_color_enabled() {
        return format_v3_console_layered_block_plain(block);
    }
    colorize_v3_layered_console_line(block, ANSI_STOPLESS_ORANGE, ANSI_DEBUG_DIM)
}

pub(crate) fn colorize_v3_layered_console_line(
    block: V3ConsoleLayeredBlock<'_>,
    headline_color: &str,
    debug_color: &str,
) -> String {
    let human_line = if block.human_prefix.is_empty() {
        block.headline.to_string()
    } else {
        format!("{} {}", block.human_prefix, block.headline)
    };
    let diagnostic = block.diagnostic();
    format!("{headline_color}{human_line}{ANSI_RESET}\n\n{debug_color}  {diagnostic}{ANSI_RESET}")
}

pub(crate) fn format_v3_console_layered_block_plain(block: V3ConsoleLayeredBlock<'_>) -> String {
    let head = if block.human_prefix.is_empty() {
        block.headline.to_string()
    } else {
        format!("{} {}", block.human_prefix, block.headline)
    };
    format!("{head}\n\n  {}", block.diagnostic())
}

pub(crate) fn resolve_v3_log_session_color_key(
    headers: &HeaderMap,
    payload: &Value,
    request_id: &str,
) -> Option<String> {
    let turn_metadata = parse_codex_turn_metadata(headers).ok().flatten();
    let explicit_session = first_header_text(
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
    if explicit_session.is_some() {
        return explicit_session;
    }
    let explicit_conversation = first_header_text(
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
    if explicit_conversation.is_some() {
        return explicit_conversation;
    }
    let client_type = infer_v3_log_client_type(headers);
    let tmux_scope = first_header_text(
        headers,
        &[
            "x-routecodex-client-tmux-session-id",
            "x-rcc-client-tmux-session-id",
            "x-routecodex-tmux-session-id",
            "x-rcc-tmux-session-id",
            "x-tmux-session-id",
        ],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_TMUX_PATHS));
    let workdir = first_header_text(
        headers,
        &["x-routecodex-workdir", "x-rcc-workdir", "x-workdir"],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_WORKDIR_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_WORKDIR_PATHS))
    .or_else(|| {
        resolve_v3_console_project_path_with_metadata(headers, payload, turn_metadata.as_ref())
    });
    let mut parts = Vec::new();
    for value in [client_type, tmux_scope, workdir] {
        if let Some(part) = value.and_then(|candidate| normalize_v3_log_session_part(&candidate)) {
            parts.push(part);
        }
    }
    if parts.is_empty() {
        normalize_v3_log_session_part(request_id).map(|part| format!("rcc-session:request:{part}"))
    } else {
        Some(format!("rcc-session:{}", parts.join(":")))
    }
}

pub(crate) fn infer_v3_log_client_type(headers: &HeaderMap) -> Option<String> {
    let user_agent = header_text(headers, "user-agent")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let originator = header_text(headers, "originator")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if user_agent.contains("codex") || originator.contains("codex") {
        Some("codex".to_string())
    } else if user_agent.contains("claude") || originator.contains("claude") {
        Some("claude".to_string())
    } else {
        None
    }
}

pub(crate) fn normalize_v3_log_session_part(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

pub(crate) fn resolve_v3_session_color(session_id: &str) -> Option<String> {
    if session_id.trim().is_empty() {
        return None;
    }
    let hash = hash_v3_session_log_color_token(session_id.trim());
    let mut hue = (hash % 3600) as f64 / 10.0;
    if !(18.0..342.0).contains(&hue) {
        hue = (hue + 47.0) % 360.0;
    }
    let saturation = 0.62 + (((hash >> 12) & 0xff) as f64 / 255.0) * 0.24;
    let lightness = 0.50 + (((hash >> 20) & 0xff) as f64 / 255.0) * 0.16;
    let (red, green, blue) = hsl_to_rgb(hue, saturation, lightness);
    Some(format!("\x1b[38;2;{};{};{}m", red, green, blue))
}

pub(crate) fn hash_v3_session_log_color_token(value: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in value.bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x7feb352d);
    hash ^= hash >> 15;
    hash = hash.wrapping_mul(0x846ca68b);
    hash ^= hash >> 16;
    hash
}

pub(crate) fn hsl_to_rgb(hue: f64, saturation: f64, lightness: f64) -> (u8, u8, u8) {
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let hue_prime = hue / 60.0;
    let x = chroma * (1.0 - ((hue_prime % 2.0) - 1.0).abs());
    let (r1, g1, b1) = if hue_prime < 1.0 {
        (chroma, x, 0.0)
    } else if hue_prime < 2.0 {
        (x, chroma, 0.0)
    } else if hue_prime < 3.0 {
        (0.0, chroma, x)
    } else if hue_prime < 4.0 {
        (0.0, x, chroma)
    } else if hue_prime < 5.0 {
        (x, 0.0, chroma)
    } else {
        (chroma, 0.0, x)
    };
    let m = lightness - chroma / 2.0;
    let to_channel = |value: f64| -> u8 { ((value + m).clamp(0.0, 1.0) * 255.0).round() as u8 };
    (to_channel(r1), to_channel(g1), to_channel(b1))
}

pub(crate) fn console_timestamp_hhmmss() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as libc::time_t)
        .unwrap_or(0);
    console_timestamp_hhmmss_for_epoch_seconds(seconds).unwrap_or_else(|_| {
        let seconds = u64::try_from(seconds).unwrap_or(0) % 86_400;
        let hour = seconds / 3_600;
        let minute = (seconds % 3_600) / 60;
        let second = seconds % 60;
        format!("{hour:02}:{minute:02}:{second:02}")
    })
}

pub(crate) fn console_timestamp_hhmmss_for_epoch_seconds(
    seconds: libc::time_t,
) -> Result<String, String> {
    let local = format_v3_tm(seconds, true)?;
    Ok(format!(
        "{:02}:{:02}:{:02}",
        local.hour, local.minute, local.second
    ))
}
