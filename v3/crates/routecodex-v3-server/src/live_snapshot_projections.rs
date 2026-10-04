//! Foundation runtime response snapshot capture, runtime observability debug
//! projections, and the provider-terminal evidence record.
//!
//! Split out of `live_snapshot.rs` to keep that file within the V3
//! module-decomposition size limit. Behavior, node order and public
//! (`pub(crate)`) paths are unchanged; the crate-root facade in `lib.rs`
//! re-exports these symbols so callers keep their existing paths.
use crate::*;
use axum::body::Body;
use axum::http::Response;
use serde_json::{json, Value};

pub(crate) fn capture_v3_foundation_runtime_response(
    state: &V3ListenerState,
    trace_scope: &routecodex_v3_debug::V3DebugTraceScope,
    entry_protocol: &str,
    execution_mode: V3EntryProtocolExecutionMode,
    endpoint: &str,
    request_id: &str,
    output: &V3FoundationRuntimeOutput,
) -> Option<Response<Body>> {
    if !state.debug.should_capture_snapshot_stage("client-response") {
        return None;
    }
    if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Direct {
        if !v3_codex_sample_scope_allows(state, execution_mode) {
            return None;
        }
        let payload = state.debug.project_payload_verbatim(output.body.clone());
        if let Err(error) = persist_v3_codex_sample_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "response.json",
            &payload,
        ) {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug03RawResponseCaptured",
                V3DebugError::Sink(error),
            )));
        }
        return None;
    }
    let projection = match state
        .debug
        .capture_raw_response(trace_scope, output.body.clone())
    {
        Ok(projection) => projection,
        Err(error) => {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug03RawResponseCaptured",
                error,
            )));
        }
    };
    if let Some(projection) = projection {
        if let Err(error) = persist_v3_codex_sample_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "response.json",
            &projection.payload,
        ) {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug03RawResponseCaptured",
                V3DebugError::Sink(error),
            )));
        }
    }
    None
}

pub(crate) fn project_v3_runtime_observability_debug(
    observability: &V3RuntimeObservability,
) -> Value {
    json!({
        "routing_group_id": observability.routing_group_id,
        "pool_id": observability.pool_id,
        "provider_id": observability.provider_id,
        "provider_key": observability.provider_key,
        "model_id": observability.model_id,
        "wire_model": observability.wire_model,
        "provider_type": observability.provider_type,
        "attempts": observability.attempts,
        "transport": observability.transport,
        "provider_status": observability.provider_status,
        "response_status": observability.response_status,
        "finish_reason": observability.finish_reason,
        "target_path": observability.target_path,
        "unavailable_candidates": observability.unavailable_candidates,
        "provider_failure_events": observability.provider_failure_events.iter().map(project_v3_runtime_provider_failure_event_debug).collect::<Vec<Value>>(),
        "usage": observability.usage.as_ref().map(project_v3_runtime_usage_debug),
    })
}

pub(crate) fn project_v3_runtime_provider_failure_event_debug(
    event: &V3RuntimeProviderFailureObservation,
) -> Value {
    json!({
        "provider_key": &event.provider_key,
        "provider_id": &event.provider_id,
        "auth_alias": event.auth_alias.as_ref(),
        "model_id": &event.model_id,
        "status": event.status,
        "error_type": event.error_type.as_ref(),
        "external_error_kind": event.external_error_kind.as_ref(),
        "external_error_code": event.external_error_code.as_ref(),
        "external_error_status": event.external_error_status,
        "internal_code": event.internal_code.as_ref(),
        "message": &event.message,
        "failure_count": event.failure_count,
        "health_state": &event.health_state,
        "cooldown_until_ms": event.cooldown_until_ms,
        "action": &event.action,
        "next_provider_key": event.next_provider_key.as_ref(),
        "wait_ms": event.wait_ms,
    })
}

pub(crate) fn project_v3_runtime_usage_debug(usage: &V3RuntimeUsageSummary) -> Value {
    json!({
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
        "cached_tokens": usage.cached_tokens,
    })
}

/// Record the typed provider terminal as provider-private evidence.
///
/// The client boundary must never project the provider's own status, headers, or
/// body, so the only place that real upstream error stays readable is the
/// provider-private evidence directory. This is the single owner of that
/// artifact: the witness accessors exist for this record, and without it the
/// witness would be built and carried across every attempt and reselection only
/// to be discarded at the boundary. The artifact is separate from `error.json`
/// because the error-evidence pair has its own owner and lanes that already
/// write it; two writers to one file would race.
///
/// The record states what the provider actually did, not what the client was
/// allowed to see. `external_http` means a real upstream response head was
/// received and its status, headers, and body are recorded here losslessly,
/// whatever that status is; that is decoupled from the client-projection rule
/// (bug `705d624` keeps HTTP 502 out of any client response), and a failed body
/// read is recorded as `body_read_failure` rather than erasing the status and
/// headers that really arrived. `no_response` is reserved for the case where no
/// upstream response head existed at all.
///
/// Returns nothing: the debug sink records every persistence failure in its own
/// failure ledger and reports it out of band, so a diagnostic write can never
/// turn a provider terminal into a client error and there is no error to
/// propagate here.
pub(crate) fn persist_v3_provider_terminal_evidence(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    disposition: &routecodex_v3_error::V3ProviderTerminalDisposition,
) {
    let payload = match disposition {
        // The provider's real status, headers, and body are the error truth this
        // artifact exists to keep: they are recorded losslessly here and never
        // reach the client.
        routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness) => json!({
            "object": "routecodex.v3.provider_terminal_evidence",
            "kind": "external_http",
            "status": witness.status(),
            "headers": witness.headers(),
            "body": witness.body(),
            "body_read_failure": witness.body_read_failure(),
        }),
        routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse => json!({
            "object": "routecodex.v3.provider_terminal_evidence",
            "kind": "no_response",
        }),
    };
    let _persisted = persist_v3_error_evidence_payload(
        state,
        entry_protocol,
        endpoint,
        request_id,
        "provider-terminal.json",
        &state.debug.project_payload_verbatim(payload),
        None,
    );
}
