use super::super::*;
use super::*;

pub(crate) fn emit_v3_request_start_console_line(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    headers: &HeaderMap,
    payload: &Value,
) {
    if !state.console_enabled {
        return;
    }
    let stream = payload.get("stream").and_then(Value::as_bool) == Some(true);
    let accepts_sse = request_accepts_sse(headers) || stream;
    let raw_input_items = response_input_item_count(payload.get("input"));
    let project_path = resolve_v3_console_project_path(headers, payload);
    let mut identity = resolve_v3_console_log_identity_from_parts(headers, payload, request_id);
    identity.project_path = project_path;
    let request_model = identity
        .request_model
        .clone()
        .unwrap_or_else(|| "-".to_string());
    let content = format_v3_console_timed_content(
        &format!("▶ [{endpoint}]"),
        &format!(
            "req={} event=started stream={} acceptsSse={} rawInputItems={} preparedInputItems={} plannedEntryMode=none",
            request_id, stream, accepts_sse, raw_input_items, raw_input_items
        ),
    );
    let line = format_v3_console_scoped_line(
        &state.server.port.to_string(),
        entry_protocol,
        &identity.session_id,
        identity.project_path.as_deref(),
        &request_model,
        "pending",
        &content,
    );
    emit_v3_colorized_request_console_line(state, &line, identity.color_key.as_deref());
}

#[derive(Clone)]
pub(crate) struct V3ConsoleEmissionContext {
    pub(crate) state: Arc<V3ListenerState>,
    pub(crate) entry_protocol: String,
    pub(crate) endpoint: String,
    pub(crate) request_id: String,
    pub(crate) headers: HeaderMap,
    pub(crate) payload: Value,
}

pub(crate) fn build_v3_console_emission_context(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    headers: &HeaderMap,
    payload: &Value,
) -> V3ConsoleEmissionContext {
    V3ConsoleEmissionContext {
        state: Arc::clone(state),
        entry_protocol: entry_protocol.to_string(),
        endpoint: endpoint.to_string(),
        request_id: request_id.to_string(),
        headers: headers.clone(),
        payload: payload.clone(),
    }
}

pub(crate) fn emit_v3_provider_observability_console_lines(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) {
    if !context.state.console_enabled {
        return;
    }
    let identity = resolve_v3_console_log_identity(context);
    for event in &observability.provider_failure_events {
        let error_content = format_v3_provider_failure_console_content(&context.request_id, event);
        let error_line = format_v3_console_line_for_observability(
            context,
            &identity,
            observability,
            &error_content,
        );
        let colorized_error = colorize_v3_error_console_line(&error_line);
        append_v3_human_console_line(&context.state, &colorized_error);
        eprintln!("{colorized_error}");
        if event.action == "switch_provider" {
            let switch_content =
                format_v3_provider_switch_console_content(&context.request_id, event);
            let switch_line = format_v3_console_line_for_observability(
                context,
                &identity,
                observability,
                &switch_content,
            );
            emit_v3_colorized_request_console_line(
                &context.state,
                &switch_line,
                identity.color_key.as_deref(),
            );
        }
    }
    if observability.provider_failure_events.is_empty()
        && !observability.unavailable_candidates.is_empty()
    {
        let selected = format_v3_console_provider_target(observability);
        let content = format_v3_console_timed_content(
            "[provider-unavailable]",
            &format!(
                "req={} unavailable={} selected={} reason=availability",
                context.request_id,
                observability.unavailable_candidates.join(","),
                selected
            ),
        );
        let line =
            format_v3_console_line_for_observability(context, &identity, observability, &content);
        emit_v3_colorized_request_console_line(
            &context.state,
            &line,
            identity.color_key.as_deref(),
        );
    }
}

pub(crate) fn format_v3_provider_failure_console_content(
    request_id: &str,
    event: &V3RuntimeProviderFailureObservation,
) -> String {
    let mut fields = format!(
        "req={} provider={} status={} failures={} health={} action={}",
        request_id,
        format_v3_console_provider_key_label(&event.provider_key),
        event.status,
        event.failure_count,
        event.health_state,
        event.action
    );
    if let Some(cooldown_until_ms) = event.cooldown_until_ms {
        fields.push_str(&format!(" cooldownUntilMs={cooldown_until_ms}"));
    }
    if let Some(wait_ms) = event.wait_ms {
        fields.push_str(&format!(" waitMs={wait_ms}"));
    }
    if let Some(next) = event.next_provider_key.as_deref() {
        fields.push_str(&format!(
            " next={}",
            format_v3_console_provider_key_label(next)
        ));
    }
    if let Some(error_type) = event.error_type.as_deref() {
        fields.push_str(&format!(" type={error_type}"));
    }
    if let Some(external_error_kind) = event.external_error_kind.as_deref() {
        fields.push_str(&format!(" external={external_error_kind}"));
    }
    if let Some(external_error_code) = event.external_error_code.as_deref() {
        fields.push_str(&format!(" externalCode={external_error_code}"));
    }
    if let Some(external_error_status) = event.external_error_status {
        fields.push_str(&format!(" externalStatus={external_error_status}"));
    }
    if let Some(internal_code) = event.internal_code.as_deref() {
        fields.push_str(&format!(" internalCode={internal_code}"));
    }
    fields.push_str(&format!(
        " message={}",
        format_v3_console_single_line_message(&event.message)
    ));
    format_v3_console_timed_content("❌ [provider-error]", &fields)
}

pub(crate) fn format_v3_provider_switch_console_content(
    request_id: &str,
    event: &V3RuntimeProviderFailureObservation,
) -> String {
    let next = event
        .next_provider_key
        .as_deref()
        .map(format_v3_console_provider_key_label)
        .unwrap_or_else(|| "-".to_string());
    format_v3_console_timed_content(
        "[provider-switch]",
        &format!(
            "req={} from={} to={} action={} reason=provider_failure",
            request_id,
            format_v3_console_provider_key_label(&event.provider_key),
            next,
            event.action
        ),
    )
}

pub(crate) fn emit_v3_request_start_console_line_for_observability(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) {
    if !context.state.console_enabled {
        return;
    }
    let stream = context.payload.get("stream").and_then(Value::as_bool) == Some(true);
    let accepts_sse = request_accepts_sse(&context.headers) || stream;
    let raw_input_items = response_input_item_count(context.payload.get("input"));
    let identity = resolve_v3_console_log_identity(context);
    let content = format_v3_console_timed_content(
        &format!("▶ [{}]", context.endpoint),
        &format!(
            "req={} event=started stream={} acceptsSse={} rawInputItems={} preparedInputItems={} plannedEntryMode=none",
            context.request_id, stream, accepts_sse, raw_input_items, raw_input_items
        ),
    );
    let line =
        format_v3_console_line_for_observability(context, &identity, observability, &content);
    emit_v3_colorized_request_console_line(&context.state, &line, identity.color_key.as_deref());
}

pub(crate) fn emit_v3_request_route_console_line(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) {
    if !context.state.console_enabled {
        return;
    }
    let identity = resolve_v3_console_log_identity(context);
    let route_label = format_v3_console_route_hit_label(&context.state, observability);
    let provider_target = format_v3_console_provider_target(observability);
    let reason = format_v3_console_hit_reason(&context.state, observability);
    let content = format_v3_console_timed_content(
        "[virtual-router-hit]",
        &format!(
            "req={} route={} target={} reason={}",
            context.request_id, route_label, provider_target, reason
        ),
    );
    let line =
        format_v3_console_line_for_observability(context, &identity, observability, &content);
    emit_v3_colorized_request_console_line(&context.state, &line, identity.color_key.as_deref());
}

pub(crate) fn emit_v3_request_complete_console_line(
    context: &V3ConsoleEmissionContext,
    status: u16,
    node_trace: &[&'static str],
    observability: &V3RuntimeObservability,
    elapsed: std::time::Duration,
) {
    if !context.state.console_enabled {
        return;
    }
    let response_status = observability
        .response_status
        .as_deref()
        .unwrap_or("completed");
    let finish_reason = observability
        .finish_reason
        .as_deref()
        .unwrap_or("unreported");
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;
    let identity = resolve_v3_console_log_identity(context);
    let content = format_v3_console_timed_content(
        &format!("✅ [{}]", context.endpoint),
        &format!(
            "req={} event=completed status={}{} responseStatus={} finish_reason={} elapsedMs={:.1} nodes={} transport={}",
            context.request_id,
            status,
            format_v3_console_upstream_status_suffix(status, observability.provider_status),
            response_status,
            finish_reason,
            elapsed_ms,
            node_trace.len(),
            observability.transport
        ),
    );
    let line =
        format_v3_console_line_for_observability(context, &identity, observability, &content);
    emit_v3_colorized_request_console_line(&context.state, &line, identity.color_key.as_deref());
}

pub(crate) fn emit_v3_usage_console_line(
    context: &V3ConsoleEmissionContext,
    node_trace: &[&'static str],
    observability: &V3RuntimeObservability,
    elapsed: std::time::Duration,
) {
    if !context.state.console_enabled {
        return;
    }
    let identity = resolve_v3_console_log_identity(context);
    let usage = format_v3_console_usage_summary(observability.usage.as_ref());
    let finish_reason = observability
        .finish_reason
        .as_deref()
        .unwrap_or("unreported");
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;
    let internal_ms = elapsed_ms;
    let external_ms = 0.0;
    let content = format_v3_console_timed_content(
        "[usage]",
        &format!(
            "req={} {} time_i={:.0}ms time_e={:.0}ms time_t={:.1}ms finish_reason={}",
            format_v3_usage_request_id(&context.request_id),
            usage,
            internal_ms,
            external_ms,
            elapsed_ms,
            finish_reason
        ),
    );
    let line =
        format_v3_console_line_for_observability(context, &identity, observability, &content);
    let _ = node_trace;
    emit_v3_colorized_request_console_line(&context.state, &line, identity.color_key.as_deref());
}

pub(crate) fn emit_v3_stopless_console_line(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) {
    if !context.state.console_enabled || !is_v3_stopless_console_activation(observability) {
        return;
    }
    let finish_reason = observability
        .finish_reason
        .as_deref()
        .unwrap_or("unreported");
    let identity = resolve_v3_console_log_identity(context);
    let content = format_v3_console_timed_content(
        "🧭 [stopless]",
        &format!(
            "req={} event=activated hook=reasoningStop callId=call_stopless_reasoning action=exec_command finish_reason={} transport={}",
            context.request_id, finish_reason, observability.transport
        ),
    );
    let line =
        format_v3_console_line_for_observability(context, &identity, observability, &content);
    let colorized = colorize_v3_stopless_console_line(&line);
    append_v3_human_console_line(&context.state, &colorized);
    println!("{colorized}");
}

pub(crate) fn is_v3_stopless_console_activation(observability: &V3RuntimeObservability) -> bool {
    observability.stopless_activation
}

pub(crate) fn append_v3_human_console_line(state: &V3ListenerState, line: &str) {
    if let Err(error) = state.debug.append_human_console_line(line) {
        eprintln!(
            "{}",
            colorize_v3_error_console_line(&format!(
                "{} ❌ {} request debug-log failed (status=500 error=V3E00 subcode=debug_sink node=V3DebugEventLedgerRecorded) {}",
                format_v3_console_monitor_prefix(
                    &state.server.port.to_string(),
                    "debug",
                    None
                ),
                console_timestamp_hhmmss(),
                error
            ))
        );
    }
}

pub(crate) fn emit_v3_colorized_request_console_line(
    state: &V3ListenerState,
    line: &str,
    color_key: Option<&str>,
) {
    let colorized = colorize_v3_request_console_line(line, color_key);
    append_v3_human_console_line(state, &colorized);
    println!("{colorized}");
}

pub(crate) fn emit_v3_observability_console_lines(
    context: &V3ConsoleEmissionContext,
    status: u16,
    node_trace: &[&'static str],
    observability: &V3RuntimeObservability,
    started_at: Instant,
    include_usage: bool,
) {
    emit_v3_request_start_console_line_for_observability(context, observability);
    emit_v3_provider_observability_console_lines(context, observability);
    emit_v3_request_route_console_line(context, observability);
    if include_usage {
        let elapsed = started_at.elapsed();
        emit_v3_stopless_console_line(context, observability);
        if should_emit_v3_request_complete_console_line(status, observability) {
            emit_v3_request_complete_console_line(
                context,
                status,
                node_trace,
                observability,
                elapsed,
            );
        }
        emit_v3_usage_console_line(context, node_trace, observability, elapsed);
    }
}

pub(crate) fn emit_v3_direct_frame_console_lines(
    context: &V3ConsoleEmissionContext,
    frame: &V3Server16HttpFrame,
    started_at: Instant,
) -> Option<V3DirectSseConsoleFinalizer> {
    let mut observability = frame.observability.clone();
    if let Some(observability) = observability.as_mut() {
        enrich_v3_direct_observability_from_frame(observability, frame);
        emit_v3_frame_error_console_line_for_context(context, frame, observability);
    } else {
        let identity = resolve_v3_console_log_identity(context);
        emit_v3_frame_error_console_line_for_state(
            &context.state,
            &context.endpoint,
            &context.request_id,
            frame,
            identity.project_path.as_deref(),
        );
    }
    let observability = observability?;
    let is_sse = matches!(frame.body, V3Server16Body::Sse(_));
    emit_v3_observability_console_lines(
        context,
        frame.status,
        &frame.node_trace,
        &observability,
        started_at,
        !is_sse,
    );
    is_sse.then(|| V3DirectSseConsoleFinalizer {
        context: context.clone(),
        status: frame.status,
        node_trace: frame.node_trace.clone(),
        observability,
        stream_observation: frame.stream_observation.clone(),
        started_at,
    })
}

pub(crate) fn enrich_v3_direct_observability_from_frame(
    observability: &mut V3RuntimeObservability,
    frame: &V3Server16HttpFrame,
) {
    observability.transport = match &frame.body {
        V3Server16Body::Json(_) => "json",
        V3Server16Body::Bytes(_) => "bytes",
        V3Server16Body::Sse(_) => "sse",
    }
    .to_string();
    observability.provider_status = observability.provider_status.or(Some(frame.status));
    let V3Server16Body::Json(body) = &frame.body else {
        return;
    };
    if let Some(status) = read_v3_console_response_status(body) {
        observability.response_status = Some(status);
    }
    if let Some(finish_reason) = read_v3_console_finish_reason(body) {
        observability.finish_reason = Some(finish_reason);
    } else if observability.finish_reason.is_none() {
        observability.finish_reason = infer_v3_console_finish_reason_from_response_status(
            observability.response_status.as_deref(),
        );
    }
    if let Some(usage) = extract_v3_console_usage_summary(body) {
        observability.usage = Some(usage);
    }
}

pub(crate) fn should_emit_v3_request_complete_console_line(
    status: u16,
    observability: &V3RuntimeObservability,
) -> bool {
    if status >= 400 {
        return false;
    }
    !matches!(
        observability.response_status.as_deref(),
        Some("error" | "failed" | "incomplete")
    )
}

pub(crate) fn format_v3_console_upstream_status_suffix(
    response_status: u16,
    provider_status: Option<u16>,
) -> String {
    match provider_status {
        Some(upstream_status) if upstream_status != response_status => {
            format!(" upstreamStatus={upstream_status}")
        }
        _ => String::new(),
    }
}
