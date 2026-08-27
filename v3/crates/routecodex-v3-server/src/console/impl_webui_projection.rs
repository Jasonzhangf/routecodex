use crate::webui_observability::{
    build_v3_obs_request_key, record_v3_observability_event, record_v3_webui_error_projection,
    V3ObsEventType, V3ObsRequestMeta, V3ObsScope,
};
use crate::*;
use serde_json::Value;

/// Typed WebUI projection: emits a lifecycle event to the shared
/// V3WebuiObservability handle carried by the listener state. This is a typed
/// side-channel projection, never a payload mutation.
pub(crate) fn build_v3_webui_meta_for_context(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) -> V3ObsRequestMeta {
    V3ObsRequestMeta {
        request_id: context.request_identity.request_id.clone(),
        endpoint: context.endpoint.clone(),
        model: observability
            .model_id
            .clone()
            .or_else(|| observability.wire_model.clone()),
        route: Some(resolve_v3_console_route_projection(observability).label),
        route_reason: observability.route_classification_reason.clone(),
        routing_group: observability.routing_group_id.clone(),
        pool: observability.pool_id.clone(),
        provider_id: observability.provider_id.clone(),
        auth_alias: observability.auth_alias.clone(),
        provider_type: observability.provider_type.clone(),
        wire_model: observability.wire_model.clone(),
        provider: observability
            .provider_key
            .clone()
            .or_else(|| observability.provider_id.clone()),
        entry_protocol: Some(context.entry_protocol.clone()),
        execution_mode: Some(observability.execution_mode.clone()),
        transport: Some(observability.transport.clone()),
        provider_status: observability.provider_status,
        response_status: observability.response_status.clone(),
        finish_reason: observability.finish_reason.clone(),
        error_category: None,
        error_detail: None,
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
/// projection logic in webui_observability; console callers only adapt scope.
pub(crate) fn record_v3_webui_error_for_context(
    context: &V3ConsoleEmissionContext,
    status: u16,
    body: Option<&Value>,
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
    meta.provider_status = Some(status);
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
