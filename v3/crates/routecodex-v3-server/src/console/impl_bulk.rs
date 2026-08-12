use crate::*;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(crate) struct V3ConsoleEmissionContext {
    pub(crate) state: Arc<V3ListenerState>,
    pub(crate) entry_protocol: String,
    pub(crate) endpoint: String,
    pub(crate) request_identity: V3AllocatedRequestIdentity,
    pub(crate) identity: V3ConsoleLogIdentity,
    pub(crate) realtime_provider_failure_event_keys: Arc<Mutex<BTreeSet<String>>>,
    pub(crate) realtime_route_selection_keys: Arc<Mutex<BTreeSet<String>>>,
}

pub(crate) fn build_v3_console_emission_context(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_identity: &V3AllocatedRequestIdentity,
    headers: &HeaderMap,
    payload: &Value,
) -> V3ConsoleEmissionContext {
    let identity = resolve_v3_console_log_identity_from_parts(
        headers,
        payload,
        &request_identity.request_id,
    );
    V3ConsoleEmissionContext {
        state: Arc::clone(state),
        entry_protocol: entry_protocol.to_string(),
        endpoint: endpoint.to_string(),
        request_identity: request_identity.clone(),
        identity,
        realtime_provider_failure_event_keys: Arc::new(Mutex::new(BTreeSet::new())),
        realtime_route_selection_keys: Arc::new(Mutex::new(BTreeSet::new())),
    }
}

pub(crate) fn emit_v3_provider_observability_console_lines(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) {
    if !context.state.console_enabled {
        return;
    }
    let identity = context.identity.clone();
    let route = resolve_v3_console_route_projection(observability);
    for event in &observability.provider_failure_events {
        emit_v3_provider_failure_console_event(context, observability, event);
    }
    if observability.provider_failure_events.is_empty()
        && !observability.unavailable_candidates.is_empty()
    {
        let selected = format_v3_console_provider_target(observability);
        let content = format_v3_console_timed_content(
            "[provider-unavailable]",
            &format!(
                "req={} unavailable={} selected={} reason=availability",
                context.request_identity.request_id,
                observability.unavailable_candidates.join(","),
                selected
            ),
        );
        emit_v3_colorized_request_console_line(
            &context.state,
            &content,
            &content,
            identity.color_key.as_deref(),
            &format_v3_console_human_prefix_for_observability(
                &context.state.server.port.to_string(),
                &context.entry_protocol,
                identity.project_path.as_deref(),
                observability,
                &route.label,
            ),
            &identity.session_id,
        );
    }
}

pub(crate) fn build_v3_route_selection_event_sink(
    context: &V3ConsoleEmissionContext,
) -> V3RuntimeRouteSelectionEventSink {
    let context = context.clone();
    Arc::new(move |observability| {
        emit_v3_request_route_hit_console_line_for_observability(&context, observability);
    })
}

pub(crate) fn has_v3_realtime_route_selection_console_event(context: &V3ConsoleEmissionContext) -> bool {
    !context
        .realtime_route_selection_keys
        .lock()
        .expect("V3 console route-selection dedupe mutex poisoned")
        .is_empty()
}

pub(crate) fn mark_v3_route_selection_console_event_once(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) -> bool {
    let key = format_v3_route_selection_console_event_key(observability);
    context
        .realtime_route_selection_keys
        .lock()
        .expect("V3 console route-selection dedupe mutex poisoned")
        .insert(key)
}

pub(crate) fn format_v3_route_selection_console_event_key(observability: &V3RuntimeObservability) -> String {
    format!(
        "{}|{}|{}|{}",
        observability.routing_group_id.as_deref().unwrap_or("-"),
        observability.pool_id.as_deref().unwrap_or("-"),
        observability.provider_key.as_deref().unwrap_or("-"),
        observability.model_id.as_deref().unwrap_or("-")
    )
}

pub(crate) fn build_v3_provider_failure_event_sink(
    context: &V3ConsoleEmissionContext,
) -> V3RuntimeProviderFailureEventSink {
    let context = context.clone();
    Arc::new(move |observability, event| {
        emit_v3_provider_failure_console_event(&context, observability, event);
    })
}

pub(crate) fn emit_v3_provider_failure_console_event(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
    event: &V3RuntimeProviderFailureObservation,
) {
    if !context.state.console_enabled {
        return;
    }
    if !mark_v3_provider_failure_console_event_once(context, event) {
        return;
    }
    let identity = context.identity.clone();
    let route = resolve_v3_console_route_projection(observability);
    let event_observability =
        build_v3_console_provider_failure_event_observability(observability, event);
    let error_content =
        format_v3_provider_failure_console_content(&context.request_identity.request_id, event);
    let error_content_str = error_content.as_str();
    let error_human_prefix = format_v3_console_human_prefix_for_observability(
        &context.state.server.port.to_string(),
        &context.entry_protocol,
        identity.project_path.as_deref(),
        &event_observability,
        &route.label,
    );
    let colorized_error = colorize_v3_error_console_line(
        &error_human_prefix,
        error_content_str,
        error_content_str,
        &identity.session_id,
    );
    append_v3_human_console_line(&context.state, &colorized_error);
    eprintln!("{colorized_error}");
    if event.action == "switch_provider" {
        let switch_content =
            format_v3_provider_switch_console_content(&context.request_identity.request_id, event);
        let switch_content_str = switch_content.as_str();
        let switch_human_prefix = format_v3_console_human_prefix_for_observability(
            &context.state.server.port.to_string(),
            &context.entry_protocol,
            identity.project_path.as_deref(),
            &event_observability,
            &route.label,
        );
        let colorized_switch = colorize_v3_error_console_line(
            &switch_human_prefix,
            switch_content_str,
            switch_content_str,
            &identity.session_id,
        );
        append_v3_human_console_line(&context.state, &colorized_switch);
        eprintln!("{colorized_switch}");
    }
}

pub(crate) fn mark_v3_provider_failure_console_event_once(
    context: &V3ConsoleEmissionContext,
    event: &V3RuntimeProviderFailureObservation,
) -> bool {
    let key = format_v3_provider_failure_console_event_key(event);
    context
        .realtime_provider_failure_event_keys
        .lock()
        .expect("V3 console provider-failure dedupe mutex poisoned")
        .insert(key)
}

pub(crate) fn format_v3_provider_failure_console_event_key(
    event: &V3RuntimeProviderFailureObservation,
) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        event.provider_key,
        event.status,
        event.failure_count,
        event.health_state,
        event.action,
        event.next_provider_key.as_deref().unwrap_or("-"),
        event.message
    )
}

pub(crate) fn build_v3_console_provider_failure_event_observability(
    observability: &V3RuntimeObservability,
    event: &V3RuntimeProviderFailureObservation,
) -> V3RuntimeObservability {
    let mut event_observability = observability.clone();
    event_observability.provider_id = Some(event.provider_id.clone());
    event_observability.auth_alias = event.auth_alias.clone();
    event_observability.provider_key = Some(event.provider_key.clone());
    event_observability.model_id = Some(event.model_id.clone());
    event_observability.wire_model = Some(event.model_id.clone());
    event_observability.provider_status = Some(event.status);
    event_observability
}

pub(crate) fn format_v3_provider_failure_console_content(
    request_id: &str,
    event: &V3RuntimeProviderFailureObservation,
) -> String {
    let provider = format_v3_console_provider_key_label(&event.provider_key);
    let next = event
        .next_provider_key
        .as_deref()
        .map(format_v3_console_provider_key_label)
        .unwrap_or_else(|| "-".to_string());
    let mut fields = if event.action == "switch_provider" && event.next_provider_key.is_some() {
        format!(
            "req={} [switch to:{}] [switch from:{}] model={} result={} causeStatus={} failures={} health={}",
            request_id,
            next,
            provider,
            event.model_id,
            event.action,
            event.status,
            event.failure_count,
            event.health_state
        )
    } else {
        format!(
            "req={} target={} model={} result={} next={} causeStatus={} failures={} health={}",
            request_id,
            provider,
            event.model_id,
            event.action,
            next,
            event.status,
            event.failure_count,
            event.health_state
        )
    };
    if let Some(cooldown_until_ms) = event.cooldown_until_ms {
        fields.push_str(&format!(" cooldownUntilMs={cooldown_until_ms}"));
    }
    if let Some(wait_ms) = event.wait_ms {
        fields.push_str(&format!(" waitMs={wait_ms}"));
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
    let from = format_v3_console_provider_key_label(&event.provider_key);
    let target = event
        .next_provider_key
        .as_deref()
        .map(format_v3_console_provider_key_label)
        .unwrap_or_else(|| "-".to_string());
    format_v3_console_timed_content(
        "[provider-switch]",
        &format!(
            "req={} [switch to:{}] [switch from:{}] model={} result={} reason=provider_failure causeStatus={} failures={} health={} message={}",
            request_id,
            target,
            from,
            event.model_id,
            event.action,
            event.status,
            event.failure_count,
            event.health_state,
            format_v3_console_single_line_message(&event.message)
        ),
    )
}

pub(crate) struct V3ConsoleRequestHeadline<'a> {
    pub(crate) endpoint: &'a str,
    pub(crate) route: &'a str,
    pub(crate) target: &'a str,
    pub(crate) reason: &'a str,
    pub(crate) request_identity: &'a V3AllocatedRequestIdentity,
}

pub(crate) fn render_v3_request_console_block(headline: &V3ConsoleRequestHeadline<'_>) -> String {
    format_v3_console_timed_content(
        &format!("▶ [{}]", headline.endpoint),
        &format!(
            "{} route={} target={} reason={}",
            format_v3_console_request_count(headline.request_identity),
            headline.route,
            headline.target,
            headline.reason
        ),
    )
}

pub(crate) struct V3ConsoleResponseHeadline<'a> {
    pub(crate) endpoint: &'a str,
    pub(crate) status: u16,
    pub(crate) response_status: &'a str,
    pub(crate) finish_reason: &'a str,
    pub(crate) elapsed_ms: f64,
    pub(crate) reason: &'a str,
    pub(crate) usage: Option<&'a str>,
    pub(crate) internal_timing: &'a str,
    pub(crate) external_timing: &'a str,
    pub(crate) transport: &'a str,
    pub(crate) request_identity: &'a V3AllocatedRequestIdentity,
}

pub(crate) fn render_v3_response_console_block(headline: &V3ConsoleResponseHeadline<'_>) -> String {
    let mut fields = format!(
        "{} status={} responseStatus={} finish_reason={} elapsedMs={:.1} reason={}",
        format_v3_console_request_count(headline.request_identity),
        headline.status,
        headline.response_status,
        headline.finish_reason,
        headline.elapsed_ms,
        headline.reason,
    );
    if let Some(usage) = headline.usage.filter(|value| !value.is_empty()) {
        fields.push(' ');
        fields.push_str(usage);
    }
    fields.push_str(&format!(
        " time_i={} time_e={} time_t={:.1}ms transport={}",
        headline.internal_timing, headline.external_timing, headline.elapsed_ms, headline.transport
    ));
    format_v3_console_timed_content(&format!("✅ [{}]", headline.endpoint), &fields)
}

pub(crate) fn format_v3_console_request_count(identity: &V3AllocatedRequestIdentity) -> String {
    align_v3_console_display_width(
        &format!("[#{}/{}]", identity.total_count, identity.daily_count),
        V3_CONSOLE_REQUEST_COUNT_COLUMN_WIDTH,
    )
}

pub(crate) fn emit_v3_request_route_hit_console_line_for_observability(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) {
    if !context.state.console_enabled {
        return;
    }
    if !mark_v3_route_selection_console_event_once(context, observability) {
        return;
    }
    let identity = context.identity.clone();
    let route = resolve_v3_console_route_projection(observability);
    let provider_target = format_v3_console_provider_target(observability);
    let headline = render_v3_request_console_block(&V3ConsoleRequestHeadline {
        endpoint: &context.endpoint,
        route: &route.label,
        target: &provider_target,
        reason: &route.reason,
        request_identity: &context.request_identity,
    });
    let debug = format_v3_console_timed_content(
        "[virtual-router-hit]",
        &format!(
            "req={} event=route_selected route={} target={} reason={}",
            context.request_identity.request_id, route.label, provider_target, route.reason
        ),
    );
    emit_v3_colorized_request_console_line(
        &context.state,
        headline.as_str(),
        debug.as_str(),
        identity.color_key.as_deref(),
        &format_v3_console_human_prefix_for_observability(
            &context.state.server.port.to_string(),
            &context.entry_protocol,
            identity.project_path.as_deref(),
            observability,
            &route.label,
        ),
        &identity.session_id,
    );
}

pub(crate) fn emit_v3_request_complete_console_line(
    context: &V3ConsoleEmissionContext,
    status: u16,
    node_trace: &[&'static str],
    observability: &V3RuntimeObservability,
    elapsed: std::time::Duration,
) -> Result<(), String> {
    if !context.state.console_enabled {
        return Ok(());
    }
    let response_status = observability
        .response_status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "successful V3 Runtime observability is missing response_status".to_string()
        })?;
    let finish_reason = observability
        .finish_reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| infer_v3_console_finish_reason_from_response_status(Some(response_status)))
        .ok_or_else(|| {
            "successful V3 Runtime observability is missing finish_reason".to_string()
        })?;
    let human_usage = format_v3_console_human_usage_summary(observability.usage.as_ref());
    let debug_usage = format_v3_console_usage_summary(observability.usage.as_ref());
    let route = resolve_v3_console_route_projection(observability);
    let (internal_timing, external_timing) =
        format_v3_console_runtime_timing(observability.timing.as_ref())?;
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;
    let identity = context.identity.clone();
    let headline = render_v3_response_console_block(&V3ConsoleResponseHeadline {
        endpoint: &context.endpoint,
        status,
        response_status,
        finish_reason: finish_reason.as_str(),
        elapsed_ms,
        reason: &route.reason,
        usage: human_usage.as_deref(),
        internal_timing: &internal_timing,
        external_timing: &external_timing,
        transport: &observability.transport,
        request_identity: &context.request_identity,
    });
    let debug = format_v3_console_timed_content(
        &format!("✅ [{}]", context.endpoint),
        &format!(
            "req={} event=completed detail=[usage] status={}{} responseStatus={} finish_reason={} elapsedMs={:.1} reason={} {} time_i={} time_e={} time_t={:.1}ms nodes={} transport={}",
            context.request_identity.request_id,
            status,
            format_v3_console_upstream_status_suffix(status, observability.provider_status),
            response_status,
            finish_reason,
            elapsed_ms,
            route.reason,
            debug_usage,
            internal_timing,
            external_timing,
            elapsed_ms,
            node_trace.len(),
            observability.transport
        ),
    );
    emit_v3_colorized_request_console_line(
        &context.state,
        headline.as_str(),
        debug.as_str(),
        identity.color_key.as_deref(),
        &format_v3_console_human_prefix_for_observability(
            &context.state.server.port.to_string(),
            &context.entry_protocol,
            identity.project_path.as_deref(),
            observability,
            &route.label,
        ),
        &identity.session_id,
    );
    Ok(())
}

pub(crate) fn format_v3_console_runtime_timing(
    timing: Option<&V3RuntimeTimingSummary>,
) -> Result<(String, String), String> {
    let timing = timing
        .ok_or_else(|| "successful V3 Runtime observability is missing timing".to_string())?;
    if timing.internal.checked_add(timing.external) != Some(timing.runtime_total) {
        return Err("V3 Runtime timing identity is invalid".to_string());
    }
    Ok((
        format!("{:.1}ms", timing.internal.as_secs_f64() * 1000.0),
        format!("{:.1}ms", timing.external.as_secs_f64() * 1000.0),
    ))
}

pub(crate) fn emit_v3_runtime_observability_contract_failure(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
    error: impl Into<String>,
) {
    let source = raise_v3_runtime_observability_contract_failure(error);
    emit_v3_post_commit_sse_source_console_line_for_context(context, observability, 500, &source);
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
        .expect("Stopless console activation requires a typed finish reason");
    let identity = context.identity.clone();
    let route = resolve_v3_console_route_projection(observability);
    let content = format_v3_console_timed_content(
        "🧭 [stopless]",
        &format!(
            "req={} event=activated hook=reasoningStop callId=call_stopless_reasoning action=exec_command finish_reason={} transport={}",
            context.request_identity.request_id, finish_reason, observability.transport
        ),
    );
    let content_str = content.as_str();
    let stopless_human_prefix = format_v3_console_human_prefix_for_observability(
        &context.state.server.port.to_string(),
        &context.entry_protocol,
        identity.project_path.as_deref(),
        observability,
        &route.label,
    );
    let colorized = colorize_v3_stopless_console_line(
        &stopless_human_prefix,
        content_str,
        content_str,
        &identity.session_id,
    );
    append_v3_human_console_line(&context.state, &colorized);
    println!("{colorized}");
}

pub(crate) fn is_v3_stopless_console_activation(observability: &V3RuntimeObservability) -> bool {
    observability.stopless_activation
}

pub(crate) fn append_v3_human_console_line(state: &V3ListenerState, line: &str) {
    if let Err(error) = state.debug.append_human_console_line(line) {
        emit_v3_debug_sink_console_failure(state, &error);
    }
}

pub(crate) fn emit_v3_debug_sink_console_failure(state: &V3ListenerState, error: &V3DebugError) {
    let debug_msg = format!(
        "{} ❌ {} request debug-log failed (status=500 error=V3E00 subcode=debug_sink node=V3DebugEventLedgerRecorded) {}",
        format_v3_console_human_prefix(
            &state.server.port.to_string(),
            "debug",
            None,
            "-",
            "-",
        ),
        console_timestamp_hhmmss(),
        error
    );
    eprintln!(
        "{}",
        colorize_v3_error_console_line("", &debug_msg, &debug_msg, "-")
    );
}

pub(crate) fn emit_v3_colorized_request_console_line(
    state: &V3ListenerState,
    headline: &str,
    debug: &str,
    color_key: Option<&str>,
    human_prefix: &str,
    session_id: &str,
) {
    let colorized =
        colorize_v3_request_console_line(human_prefix, headline, debug, color_key, session_id);
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
    if !has_v3_realtime_route_selection_console_event(context) {
        emit_v3_request_route_hit_console_line_for_observability(context, observability);
    }
    emit_v3_provider_observability_console_lines(context, observability);
    if include_usage {
        let elapsed = started_at.elapsed();
        emit_v3_stopless_console_line(context, observability);
        if should_emit_v3_request_complete_console_line(status, observability) {
            if let Err(error) = emit_v3_request_complete_console_line(
                context,
                status,
                node_trace,
                observability,
                elapsed,
            ) {
                emit_v3_runtime_observability_contract_failure(context, observability, error);
            }
        }
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
        let identity = context.identity.clone();
        emit_v3_frame_error_console_line_for_state(
            &context.state,
            &context.endpoint,
            &context.request_identity.request_id,
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

pub(crate) struct V3SseConsoleFinalizer {
    pub(crate) context: V3ConsoleEmissionContext,
    pub(crate) status: u16,
    pub(crate) node_trace: Vec<&'static str>,
    pub(crate) observability: V3RuntimeObservability,
    pub(crate) stream_observation: V3RuntimeStreamObservation,
    pub(crate) started_at: Instant,
}

pub(crate) struct V3DirectSseConsoleFinalizer {
    pub(crate) context: V3ConsoleEmissionContext,
    pub(crate) status: u16,
    pub(crate) node_trace: Vec<&'static str>,
    pub(crate) observability: V3RuntimeObservability,
    pub(crate) stream_observation: Option<V3RuntimeStreamObservation>,
    pub(crate) started_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum V3SseConsoleStreamTerminal {
    Completed,
    Dropped,
}

impl V3SseConsoleFinalizer {
    pub(crate) fn complete_relay_sse(mut self) {
        if let Err(error) = merge_v3_runtime_stream_observation(
            &mut self.observability,
            Some(&self.stream_observation),
        ) {
            self.provider_stream_failed(&error);
            return;
        }
        if let Some(status) = self.observability.response_status.clone() {
            if is_v3_sse_terminal_success_status(&status) {
                self.emit_relay_sse_complete_console_lines();
                return;
            }
            if is_v3_sse_terminal_failure_status(&status) {
                self.provider_stream_terminal_failed(&status);
                return;
            }
        }
        self.provider_stream_missing_terminal();
    }

    pub(crate) fn emit_relay_sse_complete_console_lines(self) {
        let elapsed = self.started_at.elapsed();
        emit_v3_stopless_console_line(&self.context, &self.observability);
        if let Err(error) = emit_v3_request_complete_console_line(
            &self.context,
            self.status,
            &self.node_trace,
            &self.observability,
            elapsed,
        ) {
            emit_v3_runtime_observability_contract_failure(
                &self.context,
                &self.observability,
                error,
            );
        }
    }

    pub(crate) fn provider_stream_failed(self, error: &str) {
        self.emit_relay_sse_failure_console_line(
            502,
            raise_v3_sse_provider_failure("provider_response_sse_stream", error),
        );
    }

    pub(crate) fn provider_stream_missing_terminal(self) {
        self.provider_stream_failed("provider response SSE stream ended before terminal event");
    }

    pub(crate) fn provider_stream_terminal_failed(self, status: &str) {
        self.emit_relay_sse_failure_console_line(
            502,
            raise_v3_sse_provider_failure(
                "provider_response_sse_terminal_failure",
                format!("response SSE stream ended with terminal status {status}"),
            ),
        );
    }

    pub(crate) fn client_disconnected(mut self) {
        if let Err(error) = merge_v3_runtime_stream_observation(
            &mut self.observability,
            Some(&self.stream_observation),
        ) {
            self.provider_stream_failed(&error);
            return;
        }
        if let Some(status) = self.observability.response_status.clone() {
            if is_v3_sse_terminal_success_status(&status) {
                self.emit_relay_sse_complete_console_lines();
                return;
            }
            if is_v3_sse_terminal_failure_status(&status) {
                self.provider_stream_terminal_failed(&status);
                return;
            }
        }
        self.emit_relay_sse_failure_console_line(499, raise_v3_sse_client_disconnect());
    }

    pub(crate) fn emit_relay_sse_failure_console_line(self, status: u16, source: V3Error01SourceRaised) {
        emit_v3_post_commit_sse_source_console_line_for_context(
            &self.context,
            &self.observability,
            status,
            &source,
        );
    }
}

impl V3DirectSseConsoleFinalizer {
    pub(crate) fn complete(mut self) {
        if let Err(error) = self.merge_stream_observation() {
            self.provider_stream_failed(&error);
            return;
        }
        if let Some(status) = self.observability.response_status.clone() {
            if is_v3_sse_terminal_success_status(&status) {
                self.emit_direct_sse_complete_console_lines();
                return;
            }
            if is_v3_sse_terminal_failure_status(&status) {
                self.provider_stream_terminal_failed(&status);
                return;
            }
        }
        self.provider_stream_missing_terminal();
    }

    pub(crate) fn emit_direct_sse_complete_console_lines(self) {
        let elapsed = self.started_at.elapsed();
        emit_v3_stopless_console_line(&self.context, &self.observability);
        if should_emit_v3_request_complete_console_line(self.status, &self.observability) {
            if let Err(error) = emit_v3_request_complete_console_line(
                &self.context,
                self.status,
                &self.node_trace,
                &self.observability,
                elapsed,
            ) {
                emit_v3_runtime_observability_contract_failure(
                    &self.context,
                    &self.observability,
                    error,
                );
            }
        }
    }

    pub(crate) fn provider_stream_failed(self, error: &str) {
        self.emit_direct_sse_failure_console_line(
            502,
            raise_v3_sse_provider_failure("provider_response_sse_stream", error),
        );
    }

    pub(crate) fn provider_stream_missing_terminal(self) {
        self.provider_stream_failed("provider response SSE stream ended before terminal event");
    }

    pub(crate) fn provider_stream_terminal_failed(self, status: &str) {
        self.emit_direct_sse_failure_console_line(
            502,
            raise_v3_sse_provider_failure(
                "provider_response_sse_terminal_failure",
                format!("response SSE stream ended with terminal status {status}"),
            ),
        );
    }

    pub(crate) fn client_disconnected(mut self) {
        if let Err(error) = self.merge_stream_observation() {
            self.provider_stream_failed(&error);
            return;
        }
        if let Some(status) = self.observability.response_status.clone() {
            if is_v3_sse_terminal_success_status(&status) {
                if self.observability.timing.is_none() {
                    return;
                }
                self.emit_direct_sse_complete_console_lines();
                return;
            }
            if is_v3_sse_terminal_failure_status(&status) {
                self.provider_stream_terminal_failed(&status);
                return;
            }
        }
        self.emit_direct_sse_failure_console_line(499, raise_v3_sse_client_disconnect());
    }

    pub(crate) fn merge_stream_observation(&mut self) -> Result<(), String> {
        merge_v3_runtime_stream_observation(
            &mut self.observability,
            self.stream_observation.as_ref(),
        )
    }

    pub(crate) fn emit_direct_sse_failure_console_line(self, status: u16, source: V3Error01SourceRaised) {
        emit_v3_post_commit_sse_source_console_line_for_context(
            &self.context,
            &self.observability,
            status,
            &source,
        );
    }
}

pub(crate) fn emit_v3_post_commit_sse_source_console_line_for_context(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
    status: u16,
    source: &V3Error01SourceRaised,
) {
    let projected = project_v3_post_commit_sse_source(source.clone(), status);
    emit_v3_error_console_line_for_context(
        context,
        observability,
        projected.status,
        &projected.chain,
        Some(&projected.body),
    );
}

pub(crate) fn merge_v3_runtime_stream_observation(
    observability: &mut V3RuntimeObservability,
    observation: Option<&V3RuntimeStreamObservation>,
) -> Result<(), String> {
    if let Some(observation) = observation {
        let snapshot = observation.snapshot()?;
        if snapshot.response_status.is_some() {
            observability.response_status = snapshot.response_status;
        }
        if snapshot.finish_reason.is_some() {
            observability.finish_reason = snapshot.finish_reason;
        }
        if snapshot.usage.is_some() {
            observability.usage = snapshot.usage;
        }
        if snapshot.timing.is_some() {
            observability.timing = snapshot.timing;
        }
    }
    Ok(())
}

pub(crate) fn is_v3_sse_terminal_success_status(status: &str) -> bool {
    matches!(status.trim(), "completed" | "requires_action" | "done")
}

pub(crate) fn is_v3_sse_terminal_failure_status(status: &str) -> bool {
    matches!(
        status.trim(),
        "failed" | "incomplete" | "cancelled" | "canceled" | "error"
    )
}

#[derive(Debug, Clone)]
pub(crate) struct V3ConsoleLogIdentity {
    pub(crate) color_key: Option<String>,
    pub(crate) session_id: String,
    pub(crate) project_path: Option<String>,
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
    }
}

pub(crate) fn resolve_v3_console_project_path(headers: &HeaderMap, payload: &Value) -> Option<String> {
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
        .or_else(|| console::read_injected_workspace_cwd_from_payload(payload))
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

pub(crate) fn format_v3_console_human_prefix(
    port_label: &str,
    entry_protocol: &str,
    project_path: Option<&str>,
    model_scope: &str,
    route_scope: &str,
) -> String {
    let model = format_v3_console_safe_label(model_scope);
    let route = format_v3_console_safe_label(route_scope);
    let route_model = match (route.as_str(), model.as_str()) {
        ("-", "-") => "-".to_string(),
        ("-", model) => model.to_string(),
        (route, "-") => route.to_string(),
        (route, model) => format!("{route}:{model}"),
    };
    let port_protocol = format!(
        "{}:{}",
        format_v3_console_safe_label(port_label),
        format_v3_console_entry_protocol_label(entry_protocol)
    );
    let project = format_v3_console_project_name(project_path);
    format!(
        "[{}][{}][{}]",
        fit_v3_console_display_width(&port_protocol, V3_CONSOLE_PREFIX_PORT_PROTOCOL_COLUMN_WIDTH),
        fit_v3_console_display_width(&project, V3_CONSOLE_PREFIX_PROJECT_COLUMN_WIDTH),
        fit_v3_console_display_width(&route_model, V3_CONSOLE_PREFIX_ROUTE_MODEL_COLUMN_WIDTH)
    )
}

pub(crate) fn format_v3_console_human_prefix_for_observability(
    port_label: &str,
    entry_protocol: &str,
    project_path: Option<&str>,
    observability: &V3RuntimeObservability,
    route_label: &str,
) -> String {
    format_v3_console_human_prefix(
        port_label,
        entry_protocol,
        project_path,
        &format_v3_console_provider_target_compact(observability),
        route_label,
    )
}

pub(crate) fn format_v3_console_human_prefix_for_port(
    port_label: &str,
    endpoint: &str,
    project_path: Option<&str>,
) -> String {
    format_v3_console_human_prefix(port_label, endpoint, project_path, "-", "-")
}

pub(crate) const V3_CONSOLE_CONTENT_TAG_WIDTH: usize = 24;
pub(crate) const V3_CONSOLE_PREFIX_PORT_PROTOCOL_COLUMN_WIDTH: usize = 24;
pub(crate) const V3_CONSOLE_PREFIX_PROJECT_COLUMN_WIDTH: usize = 20;
pub(crate) const V3_CONSOLE_PREFIX_ROUTE_MODEL_COLUMN_WIDTH: usize = 36;
pub(crate) const V3_CONSOLE_DEBUG_SCOPE_COLUMN_WIDTH: usize = 52;
pub(crate) const V3_CONSOLE_REQUEST_COUNT_COLUMN_WIDTH: usize = 18;

pub(crate) fn format_v3_console_timed_content(tag: &str, fields: &str) -> String {
    let tag = align_v3_console_display_width(tag, V3_CONSOLE_CONTENT_TAG_WIDTH);
    let timestamp = console_timestamp_hhmmss();
    format!("{tag} {timestamp} {fields}")
}

pub(crate) fn align_v3_console_display_width(value: &str, width: usize) -> String {
    console::align_display_width(value, width)
}

pub(crate) fn fit_v3_console_display_width(value: &str, width: usize) -> String {
    console::fit_display_width(value, width)
}

pub(crate) fn truncate_v3_console_display_width_middle(value: &str, width: usize) -> String {
    console::truncate_display_width_middle(value, width)
}

pub(crate) fn v3_console_display_width(value: &str) -> usize {
    console::display_width(value)
}

pub(crate) fn v3_console_char_display_width(character: char) -> usize {
    console::char_display_width(character)
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

pub(crate) struct V3ConsoleRouteProjection {
    pub(crate) label: String,
    pub(crate) reason: String,
}

pub(crate) fn resolve_v3_console_route_projection(
    observability: &V3RuntimeObservability,
) -> V3ConsoleRouteProjection {
    if observability.pool_id.as_deref() == Some("dry_run")
        || observability
            .target_path
            .iter()
            .any(|part| part.contains("dry_run"))
    {
        panic!("provider-request dry-run must terminate before V3 console observability emission");
    }
    if let Some(pool) = observability
        .pool_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return V3ConsoleRouteProjection {
            label: pool.to_string(),
            reason: format!("pool:{pool}"),
        };
    }
    if let Some(route) = observability
        .routing_group_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return V3ConsoleRouteProjection {
            label: route.to_string(),
            reason: format!("route:{route}"),
        };
    }
    panic!("v3 console route projection requires pool_id or routing_group_id");
}

pub(crate) fn format_v3_console_provider_target_compact(observability: &V3RuntimeObservability) -> String {
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


