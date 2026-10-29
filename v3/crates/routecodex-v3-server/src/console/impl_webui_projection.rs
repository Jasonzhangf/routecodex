use crate::webui_observability::{
    build_v3_obs_request_key, record_v3_observability_event, record_v3_webui_error_projection,
    V3ObsErrorProjection, V3ObsErrorTruth, V3ObsEventType, V3ObsRequestMeta, V3ObsScope,
};
use crate::*;
use serde_json::Value;

/// Resolve the WebUI `route` (route classification) and `pool` labels.
///
/// A `provider.model` explicit pin bypasses classifier pool selection: the
/// virtual router resolves it to the synthetic `direct` pool and never consults
/// a classifier pool, even though the classifier still attaches its reasoning to
/// the plan. `direct` is that execution mode, not a classification pool. Such a
/// request is projected as unclassified (`route = "-"` and no `pool`) so it is
/// not counted as a classifier route, while provider identity, wire model and
/// execution mode stay on the record for diagnosis. Classified requests keep the
/// pool that actually ran.
pub(crate) fn resolve_v3_webui_route_labels(
    observability: &V3RuntimeObservability,
) -> (String, Option<String>) {
    if is_v3_explicit_provider_model_pin(observability) {
        return ("-".to_string(), None);
    }
    let route = resolve_v3_console_route_projection(observability).label;
    (route, observability.pool_id.clone())
}

/// `provider.model` explicit pin marker: the virtual router resolves an explicit
/// provider/model request to the synthetic `direct` pool without consulting a
/// classifier pool.
fn is_v3_explicit_provider_model_pin(observability: &V3RuntimeObservability) -> bool {
    observability.pool_id.as_deref() == Some("direct")
}

/// Typed WebUI projection: emits a lifecycle event to the shared
/// V3WebuiObservability handle carried by the listener state. This is a typed
/// side-channel projection, never a payload mutation.
pub(crate) fn build_v3_webui_meta_for_context(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) -> V3ObsRequestMeta {
    build_v3_webui_meta(
        &context.request_identity.request_id,
        &context.endpoint,
        &context.entry_protocol,
        observability,
    )
}

fn build_v3_webui_meta(
    request_id: &str,
    endpoint: &str,
    entry_protocol: &str,
    observability: &V3RuntimeObservability,
) -> V3ObsRequestMeta {
    let (route_label, pool_label) = resolve_v3_webui_route_labels(observability);
    // A pin bypasses classification, so the classifier reasoning is not this
    // request's route reason; keep the un-hit classifier route out of the
    // reason grouping as well.
    let route_reason = if is_v3_explicit_provider_model_pin(observability) {
        None
    } else {
        observability.route_classification_reason.clone()
    };
    V3ObsRequestMeta {
        request_id: request_id.to_string(),
        endpoint: endpoint.to_string(),
        model: observability
            .model_id
            .clone()
            .or_else(|| observability.wire_model.clone()),
        route: Some(route_label),
        route_reason,
        routing_group: observability.routing_group_id.clone(),
        pool: pool_label,
        provider_id: observability.provider_id.clone(),
        auth_alias: observability.auth_alias.clone(),
        provider_type: observability.provider_type.clone(),
        wire_model: observability.wire_model.clone(),
        provider: observability
            .provider_key
            .clone()
            .or_else(|| observability.provider_id.clone()),
        entry_protocol: Some(entry_protocol.to_string()),
        execution_mode: Some(observability.execution_mode.clone()),
        transport: Some(observability.transport.clone()),
        provider_status: observability.provider_status,
        terminal_typed_status_cleared: false,
        response_status: observability.response_status.clone(),
        finish_reason: observability.finish_reason.clone(),
        error_category: None,
        error_detail: None,
        observed_error: None,
    }
}

/// Explicit failure surface for the WebUI projection: projection/transport
/// errors must be reported, never silently swallowed.
pub(crate) fn emit_v3_webui_projection_failure(context: &V3ConsoleEmissionContext, error: &str) {
    let line = format_v3_console_timed_content(
        "[webui-observability]",
        &format!(
            "req={} error={}",
            context.request_identity.request_id, error
        ),
    );
    append_v3_human_console_line(&context.state, &line);
    eprintln!("{line}");
}

pub(crate) fn record_v3_webui_event_for_context(
    context: &V3ConsoleEmissionContext,
    event_type: V3ObsEventType,
    observability: &V3RuntimeObservability,
) -> Result<u64, String> {
    let request_key = build_v3_obs_request_key(
        context.state.server.port,
        &context.request_identity.request_id,
    );
    let scope = V3ObsScope {
        port: context.state.server.port,
        workdir: context.identity.project_path.clone(),
        session: Some(context.identity.session_id.clone()),
    };
    let meta = build_v3_webui_meta_for_context(context, observability);
    record_v3_observability_event(
        &context.state.webui_observability,
        event_type,
        &request_key,
        scope,
        meta,
        observability,
    )
}

/// WebUI error projection for the already-projected Error06. Keeps the typed
/// projection logic in webui_observability; console callers only adapt scope and
/// forward the typed Error06 truth their lane exposes.
pub(crate) fn record_v3_webui_error_for_context(
    context: &V3ConsoleEmissionContext,
    status: u16,
    body: Option<&Value>,
    typed: V3ObsErrorProjection<'_>,
) -> Result<u64, String> {
    record_v3_webui_error_projection(
        &context.state.webui_observability,
        context.state.server.port,
        &context.request_identity.request_id,
        &context.endpoint,
        &context.entry_protocol,
        context.identity.project_path.as_deref(),
        Some(&context.identity.session_id),
        status,
        body,
        typed,
    )
}

/// Started projection: uses only scope + identity (route/model/provider unknown
/// until routing). Same typed side-channel as the rest of the projection.
pub(crate) fn record_v3_webui_started_for_context(
    context: &V3ConsoleEmissionContext,
) -> Result<u64, String> {
    let request_key = build_v3_obs_request_key(
        context.state.server.port,
        &context.request_identity.request_id,
    );
    let scope = V3ObsScope {
        port: context.state.server.port,
        workdir: context.identity.project_path.clone(),
        session: Some(context.identity.session_id.clone()),
    };
    let meta = V3ObsRequestMeta {
        request_id: context.request_identity.request_id.clone(),
        endpoint: context.endpoint.clone(),
        model: None,
        route: Some("-".to_string()),
        provider: None,
        entry_protocol: Some(context.entry_protocol.clone()),
        execution_mode: None,
        transport: None,
        ..Default::default()
    };
    record_v3_observability_event(
        &context.state.webui_observability,
        V3ObsEventType::Started,
        &request_key,
        scope,
        meta,
        &crate::V3RuntimeObservability::default(),
    )
}

/// Map a provider_failure observation into a typed, non-terminal WebUI attempt
/// event. The final Error06 projection remains the only terminal error owner.
pub(crate) fn record_v3_webui_provider_failure(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
    event: &V3RuntimeProviderFailureObservation,
) -> bool {
    let status = event.status;
    let request_key = build_v3_obs_request_key(
        context.state.server.port,
        &context.request_identity.request_id,
    );
    let scope = V3ObsScope {
        port: context.state.server.port,
        workdir: context.identity.project_path.clone(),
        session: Some(context.identity.session_id.clone()),
    };
    let mut meta = build_v3_webui_meta_for_context(context, observability);
    // `provider_status` carries only the upstream provider's real HTTP status. A
    // response-less failure (network transport) keeps `None` so the record falls
    // back to its error identity instead of the projected 502.
    meta.provider_status = event.external_error_status;
    meta.response_status = Some("error".to_string());
    meta.finish_reason = Some("error".to_string());
    meta.error_category = Some(
        event
            .error_type
            .clone()
            .or_else(|| event.external_error_code.clone())
            .unwrap_or_else(|| format!("http_{status}")),
    );
    meta.error_detail = Some(event.message.clone());
    // Observed-at-attempt diagnostic snapshot: forward the typed provider-failure
    // observation verbatim. `attempt_index` is filled by the store from the row
    // attempt counter once this event lands.
    meta.observed_error = Some(V3ObsErrorTruth {
        source: "provider_attempt_failure".to_string(),
        internal_code: event.internal_code.clone(),
        external_error_kind: event.external_error_kind.clone(),
        external_error_code: event.external_error_code.clone(),
        external_error_status: event.external_error_status,
        upstream_request_id: event.upstream_request_id.clone(),
        health_state: Some(event.health_state.clone()).filter(|value| !value.trim().is_empty()),
        action: Some(event.action.clone()).filter(|value| !value.trim().is_empty()),
        failure_count: Some(event.failure_count),
        cooldown_until_ms: event.cooldown_until_ms,
        next_provider_key: event.next_provider_key.clone(),
        wait_ms: event.wait_ms,
        ..Default::default()
    });
    if let Err(error) = record_v3_observability_event(
        &context.state.webui_observability,
        V3ObsEventType::ProviderAttemptFailed,
        &request_key,
        scope,
        meta,
        &crate::V3RuntimeObservability::default(),
    ) {
        emit_v3_webui_projection_failure(context, &error);
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observability(
        pool_id: Option<&str>,
        route_classification_reason: Option<&str>,
    ) -> V3RuntimeObservability {
        V3RuntimeObservability {
            route_classification_reason: route_classification_reason.map(str::to_string),
            pool_id: pool_id.map(str::to_string),
            routing_group_id: Some("default".to_string()),
            execution_mode: "direct".to_string(),
            provider_id: Some("pinned".to_string()),
            auth_alias: Some("key".to_string()),
            provider_key: Some("pinned:key:gpt-5.5".to_string()),
            provider_type: Some("openai-responses".to_string()),
            model_id: Some("gpt-5.5".to_string()),
            wire_model: Some("gpt-5.5".to_string()),
            transport: "sse".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn explicit_provider_model_pin_is_not_reported_as_classifier_route_or_pool() {
        // A provider.model pin bypasses classifier pool selection, even though
        // the classifier still attaches a reasoning string to the plan. Neither
        // the un-hit classifier route nor a fabricated classifier pool may be
        // reported for the request.
        let observed = observability(Some("direct"), Some("thinking:user-input"));
        let (route, pool) = resolve_v3_webui_route_labels(&observed);
        assert_eq!(route, "-");
        assert_eq!(pool, None);
    }

    #[test]
    fn explicit_provider_model_pin_with_coding_reason_stays_unclassified() {
        let observed = observability(Some("direct"), Some("coding:tool-continuation"));
        let (route, pool) = resolve_v3_webui_route_labels(&observed);
        assert_eq!(route, "-");
        assert_eq!(pool, None);
    }

    #[test]
    fn classified_request_reports_the_hit_pool_truthfully() {
        // The pool that actually ran is the classification truth, not a stale
        // classifier fragment carried in the reason field.
        let observed = observability(Some("coding"), Some("thinking:user-input"));
        let (route, pool) = resolve_v3_webui_route_labels(&observed);
        assert_eq!(route, "coding");
        assert_eq!(pool.as_deref(), Some("coding"));
    }

    #[test]
    fn classified_request_without_classifier_reason_keeps_pool_label() {
        let observed = observability(Some("search"), None);
        let (route, pool) = resolve_v3_webui_route_labels(&observed);
        assert_eq!(route, "search");
        assert_eq!(pool.as_deref(), Some("search"));
    }

    #[test]
    fn unclassified_console_fallback_is_preserved() {
        let observed = V3RuntimeObservability {
            routing_group_id: Some("default".to_string()),
            execution_mode: "direct".to_string(),
            ..Default::default()
        };
        let (route, pool) = resolve_v3_webui_route_labels(&observed);
        assert_eq!(route, "default");
        assert_eq!(pool, None);
    }

    #[test]
    fn explicit_pin_meta_keeps_identity_and_mode_without_classifier_route() {
        let observed = observability(Some("direct"), Some("thinking:user-input"));
        let meta = build_v3_webui_meta("req-pin", "/v1/responses", "responses", &observed);
        assert_eq!(meta.route.as_deref(), Some("-"));
        assert_eq!(meta.pool, None);
        assert_eq!(meta.route_reason, None);
        assert_eq!(meta.execution_mode.as_deref(), Some("direct"));
        assert_eq!(meta.provider_id.as_deref(), Some("pinned"));
        assert_eq!(meta.provider.as_deref(), Some("pinned:key:gpt-5.5"));
        assert_eq!(meta.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(meta.wire_model.as_deref(), Some("gpt-5.5"));
        assert_eq!(meta.provider_type.as_deref(), Some("openai-responses"));
        assert_eq!(meta.transport.as_deref(), Some("sse"));
    }

    #[test]
    fn classified_meta_keeps_hit_pool_and_reason() {
        let observed = observability(Some("coding"), Some("thinking:user-input"));
        let meta = build_v3_webui_meta("req-code", "/v1/responses", "responses", &observed);
        assert_eq!(meta.route.as_deref(), Some("coding"));
        assert_eq!(meta.pool.as_deref(), Some("coding"));
        assert_eq!(meta.route_reason.as_deref(), Some("thinking:user-input"));
    }
}
