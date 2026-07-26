use super::super::*;
use super::*;

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
    let identity = resolve_v3_console_log_identity(context);
    let content = format_v3_error_console_content(
        &context.endpoint,
        &context.request_id,
        status,
        error_chain,
        body,
    );
    let line =
        format_v3_console_line_for_observability(context, &identity, observability, &content);
    let colorized = colorize_v3_error_console_line(&line);
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
    let line = format_v3_error_console_line_with_port(
        port_label,
        endpoint,
        request_id,
        status,
        error_chain,
        body,
        project_path,
    );
    eprintln!("{}", colorize_v3_error_console_line(&line));
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
    let line = format_v3_error_console_line_with_port(
        &state.server.port.to_string(),
        endpoint,
        request_id,
        status,
        error_chain,
        body,
        project_path,
    );
    let colorized = colorize_v3_error_console_line(&line);
    append_v3_human_console_line(state, &colorized);
    eprintln!("{colorized}");
}

pub(crate) fn format_v3_error_console_line_with_port(
    port_label: &str,
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
    project_path: Option<&str>,
) -> String {
    let content = format_v3_error_console_content(endpoint, request_id, status, error_chain, body);
    format_v3_console_monitor_line(port_label, endpoint, project_path, &content)
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
    println!(
        "[RouteCodexV3] Server started version={} crate={} binary={} on {addresses}",
        executable
            .as_deref()
            .and_then(resolve_routecodex_package_version_from_executable)
            .unwrap_or_else(|| "unknown".to_string()),
        env!("CARGO_PKG_VERSION"),
        binary
    );
}
