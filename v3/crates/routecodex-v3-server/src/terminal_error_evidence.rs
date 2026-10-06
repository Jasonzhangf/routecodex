use crate::*;
use serde_json::{json, Value};
use std::sync::Arc;

/// Write the provider-private evidence pair for a terminal client error.
///
/// Every provider terminal ends the client transport without a client payload,
/// so a request that really failed would leave no `request.json`/`error.json`
/// evidence on disk and no artifact reference to resolve. This is the single
/// owner of that file pair; callers supply only the typed chain they hold.
///
/// The pair owns no client-visible failure channel. `enqueue_persist` is the
/// existing optional-failure ledger owner: it reports a rejected diagnostic
/// write out of band and returns `Ok`, so a sink failure stays a diagnostic
/// side effect and can never replace the caller's typed terminal.
fn persist_v3_terminal_error_evidence_pair(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    raw_request_payload: &Value,
    error_evidence: Value,
    status: u16,
) {
    if !v3_output_has_terminal_client_error(status) {
        return;
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
        report_v3_terminal_evidence_persist_failure(
            state,
            request_id,
            endpoint,
            "request.json",
            &error,
        );
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
        report_v3_terminal_evidence_persist_failure(
            state,
            request_id,
            endpoint,
            "error.json",
            &error,
        );
    }
}

/// Report a rejected terminal-evidence write out of band.
///
/// The Debug sample store owns the request/file-qualified failure ledger; this
/// only surfaces the original cause and request identity on the existing human
/// console so an optional diagnostic failure is never silent.
fn report_v3_terminal_evidence_persist_failure(
    state: &V3ListenerState,
    request_id: &str,
    endpoint: &str,
    file_name: &str,
    error: &str,
) {
    let line = format_v3_console_timed_content(
        "[error-evidence]",
        &format!("req={request_id} endpoint={endpoint} file={file_name} error={error}"),
    );
    append_v3_human_console_line(state, &line);
}

/// Borrowed typed facts a Relay terminal branch holds when it commits a
/// provider terminal disposition.
///
/// Only the fields the typed runtime output actually exposes on that lane are
/// supplied. `error_class`/`error_detail` are deliberately absent: only the
/// OpenAI Chat output carries them, so they are never synthesized from a body or
/// a model name for the other lanes.
pub(crate) struct V3TerminalErrorEvidence<'a> {
    pub entry_protocol: &'a str,
    pub endpoint: &'a str,
    pub request_id: &'a str,
    pub raw_request_payload: &'a Value,
    pub status: u16,
    pub node_trace: &'a [&'static str],
    pub error_chain: Option<&'a [&'static str]>,
    pub observability: Option<&'a V3RuntimeObservability>,
}

/// Persist the request-bound terminal Error evidence for the supplied typed
/// facts through the single evidence-pair owner.
fn persist_v3_terminal_error_evidence(
    state: &Arc<V3ListenerState>,
    evidence: &V3TerminalErrorEvidence<'_>,
) {
    persist_v3_terminal_error_evidence_pair(
        state,
        evidence.entry_protocol,
        evidence.endpoint,
        evidence.request_id,
        evidence.raw_request_payload,
        json!({
            "object": "routecodex.v3.error_evidence",
            "stage": "error",
            "status": evidence.status,
            "request_id": evidence.request_id,
            "endpoint": evidence.endpoint,
            "node_trace": evidence.node_trace,
            "error_chain": evidence.error_chain,
            "observability": evidence.observability.map(project_v3_runtime_observability_debug),
        }),
        evidence.status,
    );
}

/// Shared diagnostic side channel for the four Relay terminal branches.
///
/// Observes only the supplied typed facts and the verbatim raw request used for
/// evidence. It persists the request-bound terminal Error evidence and projects
/// the typed Error chain into the existing console/WebUI observer. It owns no
/// transport response, provider selection or disposition: the caller keeps
/// `provider_terminal_response` as the sole terminal owner, and the observer
/// reports an optional Debug sink failure out of band instead of yielding a
/// client response.
pub(crate) fn project_v3_relay_terminal_diagnostics(
    state: &Arc<V3ListenerState>,
    trace_scope: &V3DebugTraceScope,
    evidence: V3TerminalErrorEvidence<'_>,
    session_id: Option<&str>,
    request_console_project_path: Option<&str>,
    error_body: Option<&Value>,
) {
    persist_v3_terminal_error_evidence(state, &evidence);
    let Some(error_chain) = evidence.error_chain else {
        return;
    };
    record_and_emit_v3_error_projection(
        state,
        trace_scope,
        V3ErrorProjectionConsoleInput {
            endpoint: evidence.endpoint,
            request_id: evidence.request_id,
            entry_protocol: evidence.entry_protocol,
            session_id,
            status: evidence.status,
            error_chain,
            body: error_body,
            project_path: request_console_project_path,
            // The live-snapshot relay lane exposes only the chain; record the
            // explicit "Error06 typed truth not exposed" marker.
            error06_exposed: false,
            error_class: None,
            health_action: None,
            upstream_request_id: None,
        },
    );
}

/// Persist the error evidence for a Responses relay output that ends in a
/// terminal client error.
///
/// Both the ordinary relay closeout and the provider-terminal-disposition
/// closeout need this. A provider terminal ends the client transport without a
/// client payload, so without an explicit call a request that really failed
/// would leave no `request.json`/`error.json` evidence on disk and no artifact
/// reference to resolve.
pub(crate) fn persist_v3_responses_relay_terminal_error_evidence(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    raw_request_payload: &Value,
    output: &V3ResponsesRelayRuntimeOutput,
) {
    persist_v3_terminal_error_evidence(
        state,
        &V3TerminalErrorEvidence {
            entry_protocol,
            endpoint,
            request_id,
            raw_request_payload,
            status: output.status,
            node_trace: &output.node_trace,
            error_chain: output.error_chain.as_deref(),
            observability: output.observability.as_ref(),
        },
    );
}

/// Persist the error evidence for a provider terminal that ends the client
/// transport before any runtime output exists.
///
/// A selection-time pool exhaustion is decided while the protocol execution
/// plan is built, so no relay/direct runtime output carries the evidence. The
/// Error06 projection is still the real typed truth, and it has to stay on disk
/// as provider-private evidence even though the client boundary is a transport
/// break.
pub(crate) fn persist_v3_projected_terminal_error_evidence(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    raw_request_payload: &Value,
    node_trace: &[&'static str],
    projected: &routecodex_v3_error::V3Error06ClientProjected,
) {
    persist_v3_terminal_error_evidence(
        state,
        &V3TerminalErrorEvidence {
            entry_protocol,
            endpoint,
            request_id,
            raw_request_payload,
            status: projected.status,
            node_trace,
            error_chain: Some(projected.chain.as_slice()),
            observability: None,
        },
    );
}

/// Project the typed Error chain of a Responses relay output into the debug
/// trace and the observability store.
///
/// The relay lane exposes only the chain, never the typed
/// `V3Error06ClientProjected`, so it records the explicit "Error06 typed truth
/// not exposed" marker instead of an empty chain that would read as "no error
/// chain".
pub(crate) fn project_v3_responses_relay_error_chain(
    state: &Arc<V3ListenerState>,
    trace_scope: &V3DebugTraceScope,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    session_id: Option<&str>,
    request_console_project_path: Option<&str>,
    output: &V3ResponsesRelayRuntimeOutput,
) {
    let Some(error_chain) = output.error_chain.as_deref() else {
        return;
    };
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
    );
}
