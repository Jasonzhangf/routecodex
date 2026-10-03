//! Provider-private terminal error evidence persistence and relay error-chain
//! projection.
//!
//! Split out of `live_snapshot.rs` to keep that file within the V3
//! module-decomposition size limit. Behavior, node order and public
//! (`pub(crate)`) paths are unchanged; the crate-root facade in `lib.rs`
//! re-exports these symbols so callers keep their existing paths.
use crate::*;
use axum::body::Body;
use axum::http::Response;
use serde_json::{json, Value};
use std::sync::Arc;

/// Write the provider-private evidence pair for a terminal client error.
///
/// Every provider terminal ends the client transport without a client payload,
/// so a request that really failed would leave no `request.json`/`error.json`
/// evidence on disk and no artifact reference to resolve. This is the single
/// owner of that file pair; callers supply only the typed chain they hold.
/// Returns a debug-failure response when the debug sink itself fails; `None`
/// means the status is not a terminal client error.
fn persist_v3_terminal_error_evidence_pair(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    raw_request_payload: &Value,
    error_evidence: Value,
    status: u16,
) -> Option<Response<Body>> {
    if !v3_output_has_terminal_client_error(status) {
        return None;
    }
    if let Err(error) = persist_v3_error_evidence_payload(
        state,
        entry_protocol,
        endpoint,
        request_id,
        "request.json",
        &state
            .debug
            .project_payload_verbatim(raw_request_payload.clone()),
        Some(status),
    ) {
        return Some(foundation_output_response(project_v3_debug_failure(
            "V3DebugErrorEvidenceCaptured",
            V3DebugError::Sink(error),
        )));
    }
    if let Err(error) = persist_v3_error_evidence_payload(
        state,
        entry_protocol,
        endpoint,
        request_id,
        "error.json",
        &state.debug.project_payload_verbatim(error_evidence),
        Some(status),
    ) {
        return Some(foundation_output_response(project_v3_debug_failure(
            "V3DebugErrorEvidenceCaptured",
            V3DebugError::Sink(error),
        )));
    }
    None
}

/// Persist the error evidence for a Responses relay output that ends in a
/// terminal client error.
///
/// Both the ordinary relay closeout and the provider-terminal-disposition
/// closeout need this. A provider terminal ends the client transport without a
/// client payload, so without an explicit call a request that really failed
/// would leave no `request.json`/`error.json` evidence on disk and no artifact
/// reference to resolve. Returns a debug-failure response when the debug sink
/// itself fails; `None` means the output is not a terminal client error.
pub(crate) fn persist_v3_responses_relay_terminal_error_evidence(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    raw_request_payload: &Value,
    output: &V3ResponsesRelayRuntimeOutput,
) -> Option<Response<Body>> {
    persist_v3_terminal_error_evidence_pair(
        state,
        entry_protocol,
        endpoint,
        request_id,
        raw_request_payload,
        json!({
            "object": "routecodex.v3.error_evidence",
            "stage": "error",
            "status": output.status,
            "request_id": request_id,
            "endpoint": endpoint,
            "node_trace": output.node_trace.clone(),
            "error_chain": output.error_chain.clone(),
            "observability": output.observability.as_ref().map(project_v3_runtime_observability_debug),
        }),
        output.status,
    )
}

/// Persist the error evidence for a provider terminal that ends the client
/// transport before any runtime output exists.
///
/// A selection-time pool exhaustion is decided while the protocol execution
/// plan is built, so no relay/direct runtime output carries the evidence. The
/// Error06 projection is still the real typed truth, and it has to stay on disk
/// as provider-private evidence even though the client boundary is a transport
/// break. Returns a debug-failure response when the debug sink itself fails;
/// `None` means the projection is not a terminal client error.
pub(crate) fn persist_v3_projected_terminal_error_evidence(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    raw_request_payload: &Value,
    node_trace: &[&'static str],
    projected: &routecodex_v3_error::V3Error06ClientProjected,
) -> Option<Response<Body>> {
    persist_v3_terminal_error_evidence_pair(
        state,
        entry_protocol,
        endpoint,
        request_id,
        raw_request_payload,
        json!({
            "object": "routecodex.v3.error_evidence",
            "stage": "error",
            "status": projected.status,
            "request_id": request_id,
            "endpoint": endpoint,
            "node_trace": node_trace,
            "error_chain": projected.chain,
            "observability": Value::Null,
        }),
        projected.status,
    )
}

/// Project the typed Error chain of a Responses relay output into the debug
/// trace and the observability store.
///
/// The relay lane exposes only the chain, never the typed
/// `V3Error06ClientProjected`, so it records the explicit "Error06 typed truth
/// not exposed" marker instead of an empty chain that would read as "no error
/// chain". `None` when the output carries no chain, or when the node-event sink
/// fails and the caller must return the debug-failure response.
pub(crate) fn project_v3_responses_relay_error_chain(
    state: &Arc<V3ListenerState>,
    trace_scope: &V3DebugTraceScope,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    session_id: Option<&str>,
    request_console_project_path: Option<&str>,
    output: &V3ResponsesRelayRuntimeOutput,
) -> Option<Response<Body>> {
    let error_chain = output.error_chain.as_deref()?;
    record_and_emit_v3_error_projection(
        state,
        trace_scope,
        V3ErrorProjectionConsoleInput {
            endpoint,
            request_id,
            entry_protocol,
            session_id,
            status: output.status,
            error_chain,
            body: relay_error_body_for_console(&output.client_body),
            project_path: request_console_project_path,
            // The live-snapshot relay lane exposes only the chain; record the
            // explicit "Error06 typed truth not exposed" marker.
            error06_exposed: false,
            error_class: None,
            health_action: None,
            upstream_request_id: None,
        },
    )
}
