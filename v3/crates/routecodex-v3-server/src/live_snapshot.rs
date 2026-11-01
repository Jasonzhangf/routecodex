use crate::*;
use axum::body::{Body, BodyDataStream, Bytes};
use axum::http::Response;
use routecodex_v3_runtime::hub_v1::{V3AnthropicRelayClientBody, V3GeminiRelayClientBody};
use routecodex_v3_runtime::V3ResponsesDirectRuntimeOutput;
use serde_json::{json, Value};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

pub(crate) fn start_v3_live_snapshot_session(
    state: &V3ListenerState,
    trace_scope: &routecodex_v3_debug::V3DebugTraceScope,
) -> Result<Option<String>, Box<Response<Body>>> {
    match state.debug.start_snapshot_session(trace_scope, "live") {
        Ok(session_id) => Ok(Some(session_id)),
        Err(V3DebugError::Disabled("snapshots")) => Ok(None),
        Err(error) => Err(Box::new(foundation_output_response(
            project_v3_debug_failure("V3SnapshotSessionStarted", error),
        ))),
    }
}

pub(crate) fn record_v3_live_snapshot_projection(
    state: &V3ListenerState,
    trace_scope: &routecodex_v3_debug::V3DebugTraceScope,
    snapshot_session_id: Option<&str>,
    status: u16,
    node_trace: &[&'static str],
    phase: &'static str,
) -> Option<Response<Body>> {
    let session_id = snapshot_session_id?;
    for node_id in node_trace {
        if let Err(error) = state.debug.record_snapshot(
            trace_scope,
            session_id,
            *node_id,
            json!({
                "node_id": node_id,
                "phase": phase,
                "status": status,
                "live": true
            }),
        ) {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3SnapshotNodeCaptured",
                error,
            )));
        }
    }
    if let Err(error) = state
        .debug
        .close_snapshot_session_keep_snapshots(trace_scope, session_id)
    {
        return Some(foundation_output_response(project_v3_debug_failure(
            "V3SnapshotSessionClosed",
            error,
        )));
    }
    None
}

pub(crate) fn relay_error_body_for_console(body: &V3ResponsesRelayClientBody) -> Option<&Value> {
    match body {
        V3ResponsesRelayClientBody::Json(value) => Some(value),
        V3ResponsesRelayClientBody::Sse(_) => None,
    }
}

pub(crate) fn openai_chat_error_body_for_console(
    body: &V3OpenAiChatRelayClientBody,
) -> Option<&Value> {
    match body {
        V3OpenAiChatRelayClientBody::Json(value) => Some(value),
        V3OpenAiChatRelayClientBody::Sse(_) => None,
    }
}

pub(crate) fn gemini_error_body_for_console(body: &V3GeminiRelayClientBody) -> Option<&Value> {
    match body {
        V3GeminiRelayClientBody::Json(value) => Some(value),
        V3GeminiRelayClientBody::Sse(_) => None,
    }
}

/// `true` when a relay/direct runtime output carries a terminal client error.
///
/// The client status is the whole predicate: the output's Error chain is not
/// consulted, because a terminal failure is already visible to the client as an
/// error status, and requiring a chain here would drop error evidence for a
/// failure the client really received. This is the contract the recovered-attempt
/// test asserts (`recovered_provider_attempts_do_not_create_terminal_client_error_truth`).
pub(crate) fn v3_output_has_terminal_client_error(status: u16) -> bool {
    status >= 400
}

#[derive(Clone)]
pub(crate) struct V3LiveSnapSseRecorderCore {
    state: Arc<V3ListenerState>,
    entry_protocol: String,
    endpoint: String,
    request_id: String,
    status: u16,
    node_trace: Vec<&'static str>,
    error_chain: Option<Vec<&'static str>>,
    observability: Option<Value>,
    finalized_response: Option<Value>,
    provider_observation: Option<V3RuntimeStreamObservation>,
    capture_client_response: bool,
    source: &'static str,
    raw_sse: Arc<Mutex<V3DebugBoundedTextCapture>>,
}

fn persist_v3_stream_observation_provider_response(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    observation: Option<&V3RuntimeStreamObservation>,
) -> Result<bool, String> {
    let Some(observation) = observation else {
        return Ok(false);
    };
    let snapshot = observation.snapshot()?;
    if snapshot.provider_raw_sse.is_empty() {
        return Ok(false);
    }
    let provider_payload = state.debug.project_payload_verbatim(json!({
        "object": "routecodex.v3.provider_response_snapshot",
        "stage": "provider-response",
        "bodyKind": "sse",
        "rawSse": snapshot.provider_raw_sse,
    }));
    persist_v3_codex_sample_payload(
        state,
        entry_protocol,
        endpoint,
        request_id,
        "provider-response.json",
        &provider_payload,
    )?;
    Ok(true)
}

impl V3LiveSnapSseRecorderCore {
    fn persist_terminal(&self, stream_error: Option<&str>) -> Result<(), String> {
        let raw_sse = self
            .raw_sse
            .lock()
            .map_err(|error| error.to_string())?
            .rendered_text();
        if self.capture_client_response {
            let mut payload = json!({
                "object": "routecodex.v3.client_response_snapshot",
                "stage": "client-response",
                "source": self.source,
                "status": self.status,
                "bodyKind": "sse",
                "rawSse": raw_sse,
                "node_trace": self.node_trace.clone(),
                "error_chain": self.error_chain.clone(),
            });
            if let Some(observability) = self.observability.as_ref() {
                if let Some(object) = payload.as_object_mut() {
                    object.insert("observability".to_string(), observability.clone());
                }
            }
            if let Some(finalized_response) = self.finalized_response.as_ref() {
                if let Some(object) = payload.as_object_mut() {
                    object.insert(
                        "materializedResponse".to_string(),
                        finalized_response.clone(),
                    );
                }
            }
            if let Some(stream_error) = stream_error {
                if let Some(object) = payload.as_object_mut() {
                    object.insert(
                        "streamError".to_string(),
                        Value::String(stream_error.to_string()),
                    );
                }
            }
            let payload = self.state.debug.project_payload_verbatim(payload);
            persist_v3_codex_sample_payload(
                &self.state,
                &self.entry_protocol,
                &self.endpoint,
                &self.request_id,
                "response.json",
                &payload,
            )?;
        }
        persist_v3_stream_observation_provider_response(
            &self.state,
            &self.entry_protocol,
            &self.endpoint,
            &self.request_id,
            self.provider_observation.as_ref(),
        )?;
        Ok(())
    }
}

/// Carries a created client-response recorder to the client transport boundary.
///
/// The runtime response body is not the client wire once first-frame commit
/// exists: the committed channel emits the frames the runtime already flushed and
/// only then drains the sealed outcome body. The recorder therefore travels on the
/// response and the transport boundary wraps the final client body.
#[derive(Clone)]
pub(crate) struct V3LiveSnapPendingClientCapture {
    core: V3LiveSnapSseRecorderCore,
}

/// Lets the committed client channel hand a deferred recorder to the boundary.
///
/// The channel response exists before the runtime outcome does, so the outcome
/// response cannot carry the recorder into that response. The channel moves the
/// recorder into this slot when the outcome arrives; the transport boundary reads
/// the same slot when it wraps the final client body.
#[derive(Clone)]
pub(crate) struct V3LiveSnapClientWireCaptureSlot {
    core: Arc<Mutex<Option<V3LiveSnapSseRecorderCore>>>,
}

impl V3LiveSnapClientWireCaptureSlot {
    pub(crate) fn new() -> Self {
        Self {
            core: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn adopt(&self, core: V3LiveSnapSseRecorderCore) {
        if let Ok(mut slot) = self.core.lock() {
            *slot = Some(core);
        }
    }

    fn take(&self) -> Option<V3LiveSnapSseRecorderCore> {
        self.core.lock().ok().and_then(|mut slot| slot.take())
    }

    /// Adopt the recorder the runtime attached to its projected outcome.
    pub(crate) fn adopt_from_response(&self, response: &mut Response<Body>) {
        let Some(pending) = response
            .extensions_mut()
            .remove::<V3LiveSnapPendingClientCapture>()
        else {
            return;
        };
        self.adopt(pending.core);
    }
}

struct V3LiveSnapClientWireBodyStream {
    inner: Pin<Box<BodyDataStream>>,
    /// The recorder a response owner attached directly. Its own buffer is reused,
    /// so a poisoned recorder mutex still fails only the optional sample.
    core: Option<V3LiveSnapSseRecorderCore>,
    /// The recorder the committed client channel adopts when the outcome arrives.
    slot: Option<V3LiveSnapClientWireCaptureSlot>,
    raw_sse: Arc<Mutex<V3DebugBoundedTextCapture>>,
    finished: bool,
}

impl V3LiveSnapClientWireBodyStream {
    fn persist_terminal(&mut self, stream_error: Option<&str>) {
        let core = self
            .core
            .take()
            .or_else(|| self.slot.as_ref().and_then(|slot| slot.take()));
        let Some(mut core) = core else {
            return;
        };
        // The recorded wire belongs to the transport, so the terminal record must
        // persist these exact bytes instead of the recorder's own buffer.
        core.raw_sse = Arc::clone(&self.raw_sse);
        if let Err(error) = core.persist_terminal(stream_error) {
            eprintln!("[v3-sse-snapshot] client response finalize failed: {error}");
        }
    }
}

impl futures_util::Stream for V3LiveSnapClientWireBodyStream {
    type Item = Result<Bytes, axum::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.as_mut().get_mut();
        match this.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(bytes))) => {
                if let Ok(mut raw_sse) = this.raw_sse.lock() {
                    raw_sse.append(&bytes);
                } else {
                    eprintln!("[v3-sse-snapshot] client response capture failed: poisoned mutex");
                }
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(Some(Err(error))) => {
                let capture_error_text = error.to_string();
                this.finished = true;
                this.persist_terminal(Some(capture_error_text.as_str()));
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                this.finished = true;
                this.persist_terminal(None);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for V3LiveSnapClientWireBodyStream {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.persist_terminal(Some("client disconnected before response stream completed"));
    }
}

/// Carry a pending client-response recorder onto a replacement response.
///
/// A transport-owner response may be replaced before the client transport
/// boundary runs, for example when a model outcome has no client payload and the
/// transport breaks. The replacement carries the same client wire, so the recorder
/// must move with it instead of being dropped with the replaced response.
pub(crate) fn transfer_v3_live_client_capture(from: &mut Response<Body>, to: &mut Response<Body>) {
    if let Some(pending) = from
        .extensions_mut()
        .remove::<V3LiveSnapPendingClientCapture>()
    {
        to.extensions_mut().insert(pending);
    }
}

/// Wrap the final client SSE wire so the sample records exactly those bytes.
///
/// The transport owner has finished projecting keepalive, committed-stream, and
/// protocol framing before this wrapper runs. A response without a recorder, and
/// any non-SSE response, passes through unchanged, so an unsampled request pays
/// no per-chunk cost.
pub(crate) fn observe_v3_live_client_wire(mut response: Response<Body>) -> Response<Body> {
    let pending = response
        .extensions_mut()
        .remove::<V3LiveSnapPendingClientCapture>();
    let slot = response
        .extensions_mut()
        .remove::<V3LiveSnapClientWireCaptureSlot>();
    if pending.is_none() && slot.is_none() {
        return response;
    }
    let is_sse = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    if !is_sse {
        return response;
    }
    let raw_sse = match pending.as_ref() {
        Some(pending) => Arc::clone(&pending.core.raw_sse),
        None => Arc::new(Mutex::new(V3DebugBoundedTextCapture::new())),
    };
    let (parts, body) = response.into_parts();
    let stream = V3LiveSnapClientWireBodyStream {
        inner: Box::pin(body.into_data_stream()),
        core: pending.map(|pending| pending.core),
        slot,
        raw_sse,
        finished: false,
    };
    Response::from_parts(parts, Body::from_stream(stream))
}

/// Builds the client-response sample recorder a runtime or endpoint owner
/// attaches to its projected response.
///
/// The recorder travels to the transport boundary via
/// `V3LiveSnapPendingClientCapture`, so the final body wrap records the exact
/// client wire even when a committed client channel frames the payload.
pub(crate) struct V3LiveSnapFinalSseResponseCapture {
    core: V3LiveSnapSseRecorderCore,
}

impl V3LiveSnapFinalSseResponseCapture {
    fn new(core: V3LiveSnapSseRecorderCore) -> Self {
        Self { core }
    }

    pub(crate) fn from_direct_frame(
        state: &Arc<V3ListenerState>,
        entry_protocol: &str,
        endpoint: &str,
        request_id: &str,
        frame: &V3Server16HttpFrame,
    ) -> Option<Self> {
        if !state.debug.should_capture_snapshot_stage("client-response")
            || !v3_codex_sample_scope_allows(state, V3EntryProtocolExecutionMode::Direct)
        {
            return None;
        }
        Some(Self::new(V3LiveSnapSseRecorderCore {
            state: Arc::clone(state),
            entry_protocol: entry_protocol.to_string(),
            endpoint: endpoint.to_string(),
            request_id: request_id.to_string(),
            status: frame.status,
            node_trace: frame.node_trace.clone(),
            error_chain: Some(frame.error_chain.clone()),
            observability: frame
                .observability
                .as_ref()
                .map(project_v3_runtime_observability_debug),
            finalized_response: None,
            provider_observation: state
                .debug
                .should_capture_snapshot_stage("provider-response")
                .then(|| frame.stream_observation.clone())
                .flatten(),
            capture_client_response: true,
            source: "live_server_direct_response_stream",
            raw_sse: Arc::new(Mutex::new(V3DebugBoundedTextCapture::new())),
        }))
    }

    pub(crate) fn from_openai_chat_relay(
        state: &Arc<V3ListenerState>,
        entry_protocol: &str,
        endpoint: &str,
        request_id: &str,
        output: &V3OpenAiChatRelayRuntimeOutput,
    ) -> Option<Self> {
        let capture_client_response = state.debug.should_capture_snapshot_stage("client-response");
        let capture_provider_response = state
            .debug
            .should_capture_snapshot_stage("provider-response");
        if !capture_client_response && !capture_provider_response {
            return None;
        }
        Some(Self::new(V3LiveSnapSseRecorderCore {
            state: Arc::clone(state),
            entry_protocol: entry_protocol.to_string(),
            endpoint: endpoint.to_string(),
            request_id: request_id.to_string(),
            status: output.status,
            node_trace: output.node_trace.clone(),
            error_chain: output.error_chain.clone(),
            observability: output
                .observability
                .as_ref()
                .map(project_v3_runtime_observability_debug),
            finalized_response: None,
            provider_observation: capture_provider_response
                .then(|| output.stream_observation.clone())
                .flatten(),
            capture_client_response,
            source: "live_server_openai_chat_stream",
            raw_sse: Arc::new(Mutex::new(V3DebugBoundedTextCapture::new())),
        }))
    }

    pub(crate) fn from_anthropic_relay(
        state: &Arc<V3ListenerState>,
        entry_protocol: &str,
        endpoint: &str,
        request_id: &str,
        output: &V3AnthropicRelayRuntimeOutput,
    ) -> Option<Self> {
        if !state.debug.should_capture_snapshot_stage("client-response") {
            return None;
        }
        Some(Self::new(V3LiveSnapSseRecorderCore {
            state: Arc::clone(state),
            entry_protocol: entry_protocol.to_string(),
            endpoint: endpoint.to_string(),
            request_id: request_id.to_string(),
            status: output.status,
            node_trace: output.node_trace.clone(),
            error_chain: output.error_chain.clone(),
            observability: output
                .observability
                .as_ref()
                .map(project_v3_runtime_observability_debug),
            finalized_response: None,
            provider_observation: None,
            capture_client_response: true,
            source: "live_server_anthropic_stream",
            raw_sse: Arc::new(Mutex::new(V3DebugBoundedTextCapture::new())),
        }))
    }

    pub(crate) fn from_gemini_relay(
        state: &Arc<V3ListenerState>,
        entry_protocol: &str,
        endpoint: &str,
        request_id: &str,
        output: &V3GeminiRelayRuntimeOutput,
    ) -> Option<Self> {
        let capture_client_response = state.debug.should_capture_snapshot_stage("client-response");
        let capture_provider_response = state
            .debug
            .should_capture_snapshot_stage("provider-response");
        if !capture_client_response && !capture_provider_response {
            return None;
        }
        Some(Self::new(V3LiveSnapSseRecorderCore {
            state: Arc::clone(state),
            entry_protocol: entry_protocol.to_string(),
            endpoint: endpoint.to_string(),
            request_id: request_id.to_string(),
            status: output.status,
            node_trace: output.node_trace.clone(),
            error_chain: output.error_chain.clone(),
            observability: output
                .observability
                .as_ref()
                .map(project_v3_runtime_observability_debug),
            finalized_response: None,
            provider_observation: capture_provider_response
                .then(|| output.stream_observation.clone())
                .flatten(),
            capture_client_response,
            source: "live_server_gemini_stream",
            raw_sse: Arc::new(Mutex::new(V3DebugBoundedTextCapture::new())),
        }))
    }

    pub(crate) fn from_responses_relay(
        state: &Arc<V3ListenerState>,
        entry_protocol: &str,
        endpoint: &str,
        request_id: &str,
        output: &V3ResponsesRelayRuntimeOutput,
    ) -> Option<Self> {
        if !state.debug.should_capture_snapshot_stage("client-response") {
            return None;
        }
        Some(Self::new(V3LiveSnapSseRecorderCore {
            state: Arc::clone(state),
            entry_protocol: entry_protocol.to_string(),
            endpoint: endpoint.to_string(),
            request_id: request_id.to_string(),
            status: output.status,
            node_trace: output.node_trace.clone(),
            error_chain: output.error_chain.clone(),
            observability: output
                .observability
                .as_ref()
                .map(project_v3_runtime_observability_debug),
            finalized_response: output.finalized_response.clone(),
            provider_observation: None,
            capture_client_response: true,
            source: "live_server_response_stream",
            raw_sse: Arc::new(Mutex::new(V3DebugBoundedTextCapture::new())),
        }))
    }

    /// Attach the recorder so the transport boundary wraps the final client wire.
    ///
    /// The runtime response body is not the client wire once first-frame commit
    /// exists, so a body wrap here would seal in the un-flushed remainder. The
    /// recorder travels on the response instead; `observe_v3_live_client_wire`
    /// reads it at the transport boundary and the same path still captures a
    /// plain response that never went through a committed channel.
    pub(crate) fn defer_into(self, mut response: Response<Body>) -> Response<Body> {
        response
            .extensions_mut()
            .insert(V3LiveSnapPendingClientCapture { core: self.core });
        response
    }

    #[cfg(test)]
    pub(crate) fn observe_response(self, response: Response<Body>) -> Response<Body> {
        observe_v3_live_client_wire(self.defer_into(response))
    }

    #[cfg(test)]
    pub(crate) fn poison_raw_sse_capture_for_test(&self) {
        let raw_sse = Arc::clone(&self.core.raw_sse);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = raw_sse.lock().expect("test capture lock");
            panic!("poison V3 live snapshot capture mutex for test");
        }));
    }
}

pub(crate) fn capture_v3_live_raw_request(
    state: &V3ListenerState,
    trace_scope: &routecodex_v3_debug::V3DebugTraceScope,
    entry_protocol: &str,
    execution_mode: V3EntryProtocolExecutionMode,
    endpoint: &str,
    request_id: &str,
    payload: &Value,
) -> Option<Response<Body>> {
    if !state.debug.should_capture_snapshot_stage("client-request") {
        return None;
    }
    let direct = execution_mode == V3EntryProtocolExecutionMode::Direct;
    if direct && !v3_codex_sample_scope_allows(state, execution_mode) {
        return None;
    }
    // Responses Direct keeps its historical no-ring-buffer path. Other Direct
    // protocols and Relay still populate the in-memory capture when retention
    // permits it, but disk samples no longer depend on that projection.
    if !(direct && entry_protocol == "responses") {
        if let Err(error) = state
            .debug
            .capture_raw_request(trace_scope, payload.clone())
        {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug02RawRequestCaptured",
                error,
            )));
        }
    }
    if v3_codex_sample_scope_allows(state, execution_mode) {
        let payload = state.debug.project_payload_verbatim(payload.clone());
        if let Err(error) = persist_v3_codex_sample_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "request.json",
            &payload,
        ) {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug02RawRequestCaptured",
                V3DebugError::Sink(error),
            )));
        }
    }
    None
}

pub(crate) fn capture_v3_responses_relay_response(
    state: &Arc<V3ListenerState>,
    trace_scope: &routecodex_v3_debug::V3DebugTraceScope,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    output: &mut V3ResponsesRelayRuntimeOutput,
) -> Option<Response<Body>> {
    if !state.debug.should_capture_snapshot_stage("client-response") {
        return None;
    }
    let payload = match &output.client_body {
        V3ResponsesRelayClientBody::Json(value) => value.clone(),
        // The final SSE body is observed after protocol and transport framing
        // are applied, so the sample records the exact client wire.
        V3ResponsesRelayClientBody::Sse(_) => return None,
    };
    let projection = match state
        .debug
        .capture_raw_response(trace_scope, payload.clone())
    {
        Ok(projection) => projection,
        Err(error) => {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug03RawResponseCaptured",
                error,
            )));
        }
    };
    let payload = projection
        .map(|projection| projection.payload)
        .unwrap_or_else(|| state.debug.project_payload_verbatim(payload));
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
    None
}

pub(crate) fn capture_v3_openai_chat_relay_response(
    state: &Arc<V3ListenerState>,
    trace_scope: &V3DebugTraceScope,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    raw_request_payload: &Value,
    output: &mut V3OpenAiChatRelayRuntimeOutput,
) -> Option<Response<Body>> {
    let force_error_evidence = v3_output_has_terminal_client_error(output.status);
    if force_error_evidence {
        if let Err(error) = persist_v3_error_evidence_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "request.json",
            &state
                .debug
                .project_payload_verbatim(raw_request_payload.clone()),
            (output.status >= 400).then_some(output.status),
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
            &state.debug.project_payload_verbatim(json!({
                "object": "routecodex.v3.error_evidence",
                "stage": "error",
                "status": output.status,
                "request_id": request_id,
                "endpoint": endpoint,
                "node_trace": output.node_trace.clone(),
                "error_chain": output.error_chain.clone(),
            })),
            (output.status >= 400).then_some(output.status),
        ) {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3DebugErrorEvidenceCaptured",
                V3DebugError::Sink(error),
            )));
        }
    }
    let capture_client_response =
        state.debug.should_capture_snapshot_stage("client-response") || force_error_evidence;
    let capture_provider_response = state
        .debug
        .should_capture_snapshot_stage("provider-response");
    if !capture_client_response && !capture_provider_response {
        return None;
    }
    match &output.client_body {
        V3OpenAiChatRelayClientBody::Json(value) => {
            if capture_client_response {
                let payload = state.debug.project_payload_verbatim(json!({
                    "object": "routecodex.v3.client_response_snapshot",
                    "stage": "client-response",
                    "source": "live_server_openai_chat_response",
                    "status": output.status,
                    "bodyKind": "json",
                    "rawBody": value,
                    "node_trace": output.node_trace.clone(),
                    "error_chain": output.error_chain.clone(),
                    "observability": output.observability.as_ref().map(project_v3_runtime_observability_debug),
                }));
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
            }
            if capture_provider_response {
                if let Err(error) = persist_v3_stream_observation_provider_response(
                    state,
                    entry_protocol,
                    endpoint,
                    request_id,
                    output.stream_observation.as_ref(),
                ) {
                    return Some(foundation_output_response(project_v3_debug_failure(
                        "V3DebugProviderResponseCaptured",
                        V3DebugError::Sink(error),
                    )));
                }
            }
        }
        // Captured from the final projected response body by the caller.
        V3OpenAiChatRelayClientBody::Sse(_) => {}
    }
    let _ = trace_scope;
    None
}

pub(crate) fn capture_v3_responses_relay_provider_snapshots(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    output: &mut V3ResponsesRelayRuntimeOutput,
) -> Option<Response<Body>> {
    let terminal_error_evidence = v3_output_has_terminal_client_error(output.status);
    let provider_attempt_evidence = output
        .observability
        .as_ref()
        .is_some_and(|observability| !observability.provider_failure_events.is_empty());
    let capture_for_evidence = terminal_error_evidence || provider_attempt_evidence;
    let force_error_evidence = terminal_error_evidence;
    if !state
        .debug
        .should_capture_snapshot_stage("provider-request")
        && !state
            .debug
            .should_capture_snapshot_stage("provider-response")
        && !capture_for_evidence
    {
        return None;
    }
    let snapshots = match output.provider_snapshots.as_mut() {
        Some(snapshots) => snapshots,
        None => return None,
    };
    let error_status = (output.status >= 400).then_some(output.status);
    if let Some(provider_request) = snapshots.provider_request.take() {
        if capture_for_evidence
            || state
                .debug
                .should_capture_snapshot_stage("provider-request")
        {
            let provider_request = state.debug.project_payload_verbatim(provider_request);
            let result = if force_error_evidence {
                persist_v3_error_evidence_payload(
                    state,
                    entry_protocol,
                    endpoint,
                    request_id,
                    "provider-request.json",
                    &provider_request,
                    error_status,
                )
            } else {
                persist_v3_codex_sample_payload(
                    state,
                    entry_protocol,
                    endpoint,
                    request_id,
                    "provider-request.json",
                    &provider_request,
                )
            };
            if let Err(error) = result {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3DebugProviderRequestCaptured",
                    V3DebugError::Sink(error),
                )));
            }
        }
    }
    if let Some(provider_response) = snapshots.provider_response.take() {
        if capture_for_evidence
            || state
                .debug
                .should_capture_snapshot_stage("provider-response")
        {
            let provider_response = state.debug.project_payload_verbatim(provider_response);
            let result = if force_error_evidence {
                persist_v3_error_evidence_payload(
                    state,
                    entry_protocol,
                    endpoint,
                    request_id,
                    "provider-response.json",
                    &provider_response,
                    error_status,
                )
            } else {
                persist_v3_codex_sample_payload(
                    state,
                    entry_protocol,
                    endpoint,
                    request_id,
                    "provider-response.json",
                    &provider_response,
                )
            };
            if let Err(error) = result {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3DebugProviderResponseCaptured",
                    V3DebugError::Sink(error),
                )));
            }
        }
    }
    None
}

pub(crate) fn capture_v3_relay_provider_snapshots(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    snapshots: &mut Option<V3RelayProviderSnapshots>,
) -> Option<Response<Body>> {
    if !state
        .debug
        .should_capture_snapshot_stage("provider-request")
        && !state
            .debug
            .should_capture_snapshot_stage("provider-response")
    {
        return None;
    }
    let snapshots = snapshots.as_mut()?;
    for (stage, filename, value) in [
        (
            "provider-request",
            "provider-request.json",
            snapshots.provider_request.take(),
        ),
        (
            "provider-response",
            "provider-response.json",
            snapshots.provider_response.take(),
        ),
    ] {
        if !state.debug.should_capture_snapshot_stage(stage) {
            continue;
        }
        let Some(value) = value else {
            continue;
        };
        let value = state.debug.project_payload_verbatim(value);
        if let Err(error) = persist_v3_codex_sample_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            filename,
            &value,
        ) {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3DebugProviderSnapshotCaptured",
                V3DebugError::Sink(error),
            )));
        }
    }
    None
}

pub(crate) fn capture_v3_anthropic_relay_response(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    output: &mut V3AnthropicRelayRuntimeOutput,
) -> Option<Response<Body>> {
    if !state.debug.should_capture_snapshot_stage("client-response") {
        return None;
    }
    match &mut output.client_body {
        V3AnthropicRelayClientBody::Json => {
            let payload = state.debug.project_payload_verbatim(json!({
                "object": "routecodex.v3.client_response_snapshot",
                "stage": "client-response",
                "source": "live_server_anthropic_relay_response",
                "status": output.status,
                "bodyKind": "json",
                "rawBody": output.client_response,
                "node_trace": output.node_trace.clone(),
                "error_chain": output.error_chain.clone(),
                "observability": output.observability.as_ref().map(project_v3_runtime_observability_debug),
            }));
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
        }
        // Captured from the final projected response body by the caller.
        V3AnthropicRelayClientBody::Sse(_) => {}
    }
    None
}

pub(crate) fn capture_v3_gemini_relay_response(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    output: &mut V3GeminiRelayRuntimeOutput,
) -> Option<Response<Body>> {
    let capture_client_response = state.debug.should_capture_snapshot_stage("client-response");
    let capture_provider_response = state
        .debug
        .should_capture_snapshot_stage("provider-response");
    if !capture_client_response && !capture_provider_response {
        return None;
    }
    match &mut output.client_body {
        V3GeminiRelayClientBody::Json(value) => {
            if capture_client_response {
                let payload = state.debug.project_payload_verbatim(json!({
                    "object": "routecodex.v3.client_response_snapshot",
                    "stage": "client-response",
                    "source": "live_server_gemini_response",
                    "status": output.status,
                    "bodyKind": "json",
                    "rawBody": value,
                    "node_trace": output.node_trace.clone(),
                    "error_chain": output.error_chain.clone(),
                    "observability": output.observability.as_ref().map(project_v3_runtime_observability_debug),
                }));
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
            }
            if capture_provider_response {
                if let Err(error) = persist_v3_stream_observation_provider_response(
                    state,
                    entry_protocol,
                    endpoint,
                    request_id,
                    output.stream_observation.as_ref(),
                ) {
                    return Some(foundation_output_response(project_v3_debug_failure(
                        "V3DebugProviderResponseCaptured",
                        V3DebugError::Sink(error),
                    )));
                }
            }
        }
        // Captured from the final projected response body by the caller.
        V3GeminiRelayClientBody::Sse(_) => {}
    }
    None
}

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
            execution_mode: output
                .observability
                .as_ref()
                .map(|observability| observability.execution_mode.as_str()),
            error06_exposed: false,
            error_class: None,
            health_action: None,
            upstream_request_id: None,
        },
    )
}

pub(crate) fn finalize_v3_responses_relay_server_output(
    state: &Arc<V3ListenerState>,
    trace_scope: &V3DebugTraceScope,
    snapshot_session_id: Option<&str>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    mut output: V3ResponsesRelayRuntimeOutput,
    console_context: &V3ConsoleEmissionContext,
    started_at: Instant,
    request_console_project_path: Option<&str>,
    raw_request_payload: &Value,
    keepalive_interval: Option<Duration>,
) -> Response<Body> {
    if let Some(response) = persist_v3_responses_relay_terminal_error_evidence(
        state,
        entry_protocol,
        endpoint,
        request_id,
        raw_request_payload,
        &output,
    ) {
        return response;
    }
    if v3_output_has_terminal_client_error(output.status) {
        // Direct provider failures can happen before the protocol handoff to
        // relay. In that case the relay snapshot carrier is absent, but the
        // direct SSE observer still owns the provider bytes already received.
        // Preserve those bytes in the same request-id evidence directory so a
        // failed provider attempt is not replaced by the later successful
        // provider after switching.
        let has_provider_response_snapshot = output
            .provider_snapshots
            .as_ref()
            .and_then(|snapshots| snapshots.provider_response.as_ref())
            .is_some();
        if !has_provider_response_snapshot {
            if let Some(stream_observation) = output.stream_observation.as_ref() {
                match stream_observation.snapshot() {
                    Ok(snapshot) => {
                        if !snapshot.provider_raw_sse.is_empty() {
                            if let Err(error) = persist_v3_error_evidence_payload(
                                state,
                                entry_protocol,
                                endpoint,
                                request_id,
                                "provider-response.json",
                                &state.debug.project_payload_verbatim(json!({
                                    "object": "routecodex.v3.provider_response_snapshots",
                                    "stage": "provider-response",
                                    "source": "direct_provider_sse_observation",
                                    "attempts": [{
                                        "attempt": 1,
                                        "response": {
                                            "bodyKind": "sse",
                                            "rawSse": snapshot.provider_raw_sse,
                                        }
                                    }]
                                })),
                                (output.status >= 400).then_some(output.status),
                            ) {
                                return foundation_output_response(project_v3_debug_failure(
                                    "V3DebugProviderResponseCaptured",
                                    V3DebugError::Sink(error),
                                ));
                            }
                        }
                    }
                    Err(error) => {
                        return foundation_output_response(project_v3_debug_failure(
                            "V3DebugProviderResponseCaptured",
                            V3DebugError::Sink(error),
                        ));
                    }
                }
            }
        }
    }
    if let Some(response) = capture_v3_responses_relay_provider_snapshots(
        state,
        entry_protocol,
        endpoint,
        request_id,
        &mut output,
    ) {
        return response;
    }
    if let Some(response) = capture_v3_responses_relay_response(
        state,
        trace_scope,
        entry_protocol,
        endpoint,
        request_id,
        &mut output,
    ) {
        return response;
    }
    if let Some(response) = record_v3_live_snapshot_projection(
        state,
        trace_scope,
        snapshot_session_id,
        output.status,
        &output.node_trace,
        "live_response",
    ) {
        return response;
    }
    if let Some(response) = project_v3_responses_relay_error_chain(
        state,
        trace_scope,
        entry_protocol,
        endpoint,
        request_id,
        Some(&console_context.identity.session_id),
        request_console_project_path,
        &output,
    ) {
        return response;
    }
    let stream_console_finalizer = match (
        output.stream_observation.clone(),
        output.observability.clone(),
    ) {
        (Some(stream_observation), Some(observability)) => Some(V3SseConsoleFinalizer {
            context: console_context.clone(),
            status: output.status,
            node_trace: output.node_trace.clone(),
            observability,
            stream_observation,
            started_at,
        }),
        _ => None,
    };
    if let Some(observability) = output.observability.as_ref() {
        emit_v3_observability_console_lines(
            console_context,
            output.status,
            &output.node_trace,
            observability,
            started_at,
            output.stream_observation.is_none(),
        );
    }
    let client_response_capture = V3LiveSnapFinalSseResponseCapture::from_responses_relay(
        state,
        entry_protocol,
        endpoint,
        request_id,
        &output,
    );
    let response = responses_relay_output_response(
        output,
        stream_console_finalizer,
        keepalive_interval,
        raw_request_payload
            .get("stream")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    );
    match client_response_capture {
        Some(capture) => capture.defer_into(response),
        None => response,
    }
}

pub(crate) fn capture_v3_responses_direct_response(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    frame: &mut V3Server16HttpFrame,
) -> Option<Response<Body>> {
    if !state.debug.should_capture_snapshot_stage("client-response")
        || !v3_codex_sample_scope_allows(state, V3EntryProtocolExecutionMode::Direct)
    {
        return None;
    }
    let payload = match &frame.body {
        V3Server16Body::Json(value) => value.clone(),
        V3Server16Body::Bytes(bytes) => json!({
            "object": "routecodex.v3.client_response_snapshot",
            "stage": "client-response",
            "source": "live_server_direct_response_bytes",
            "status": frame.status,
            "bodyKind": "bytes",
            "rawBody": String::from_utf8_lossy(bytes),
            "node_trace": frame.node_trace.clone(),
            "error_chain": frame.error_chain.clone(),
            "observability": frame.observability.as_ref().map(project_v3_runtime_observability_debug),
        }),
        // The final projected response body is observed by the caller so
        // `rawSse` includes transport keepalive and final framing bytes.
        V3Server16Body::Sse(_) | V3Server16Body::CommittedSse(_) => return None,
    };
    let payload = state.debug.project_payload_verbatim(payload);
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
    None
}

pub(crate) fn capture_v3_responses_direct_provider_snapshots(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    output: &mut V3ResponsesDirectRuntimeOutput,
) -> Option<V3FoundationRuntimeOutput> {
    if !v3_codex_sample_scope_allows(state, V3EntryProtocolExecutionMode::Direct) {
        return None;
    }
    if state
        .debug
        .should_capture_snapshot_stage("provider-request")
    {
        if let Some(payload) = output.provider_request_snapshot.take() {
            if let Err(error) = persist_v3_codex_sample_payload(
                state,
                entry_protocol,
                endpoint,
                request_id,
                "provider-request.json",
                &state.debug.project_payload_verbatim(payload),
            ) {
                return Some(project_v3_debug_failure(
                    "V3DebugProviderSnapshotCaptured",
                    V3DebugError::Sink(error),
                ));
            }
        }
    }
    if state
        .debug
        .should_capture_snapshot_stage("provider-response")
    {
        let mut persisted = false;
        if let Some(payload) = output.provider_response_snapshot.take() {
            if let Err(error) = persist_v3_codex_sample_payload(
                state,
                entry_protocol,
                endpoint,
                request_id,
                "provider-response.json",
                &state.debug.project_payload_verbatim(payload),
            ) {
                return Some(project_v3_debug_failure(
                    "V3DebugProviderSnapshotCaptured",
                    V3DebugError::Sink(error),
                ));
            }
            persisted = true;
        }
        // A JSON client response can be collapsed from a provider SSE attempt.
        // That attempt has no typed JSON carrier, so persist its buffered raw
        // provider wire here. SSE client bodies keep their recorder-owned flush.
        if !persisted && matches!(output.client_payload.body, V3ClientBody::Json(_)) {
            if let Err(error) = persist_v3_stream_observation_provider_response(
                state,
                entry_protocol,
                endpoint,
                request_id,
                output.stream_observation.as_ref(),
            ) {
                return Some(project_v3_debug_failure(
                    "V3DebugProviderResponseCaptured",
                    V3DebugError::Sink(error),
                ));
            }
        }
    }
    None
}

pub(crate) fn persist_v3_codex_sample_payload(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    file_name: &str,
    payload: &Value,
) -> Result<(), String> {
    state
        .codex_sample_store
        .enqueue_persist(routecodex_v3_debug::V3CodexSamplePersistJob {
            port: state.server.port,
            entry_protocol: entry_protocol.to_owned(),
            endpoint: endpoint.to_owned(),
            request_id: request_id.to_owned(),
            file_name: file_name.to_owned(),
            payload: Arc::new(payload.clone()),
            force: false,
            status: None,
        })
}

pub(crate) fn persist_v3_error_evidence_payload(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    file_name: &str,
    payload: &Value,
    status: Option<u16>,
) -> Result<(), String> {
    state
        .codex_sample_store
        .enqueue_persist(routecodex_v3_debug::V3CodexSamplePersistJob {
            port: state.server.port,
            entry_protocol: entry_protocol.to_owned(),
            endpoint: endpoint.to_owned(),
            request_id: request_id.to_owned(),
            file_name: file_name.to_owned(),
            payload: Arc::new(payload.clone()),
            force: true,
            status,
        })
}

pub(crate) fn v3_codex_sample_scope_allows(
    state: &V3ListenerState,
    execution_mode: V3EntryProtocolExecutionMode,
) -> bool {
    state.codex_sample_store.is_enabled()
        && (execution_mode != V3EntryProtocolExecutionMode::Direct
            || state.manifest.debug.snapshot_direct)
}
