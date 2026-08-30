use crate::*;
use axum::body::Body;
use axum::http::Response;
use futures_util::StreamExt;
use routecodex_v3_runtime::V3ResponsesDirectRuntimeOutput;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub(crate) fn v3_output_has_terminal_client_error(
    status: u16,
    error_chain: Option<&[&'static str]>,
) -> bool {
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

impl V3LiveSnapSseRecorderCore {
    pub(crate) fn persist_initial(&self) -> Result<(), String> {
        self.persist_current(None)
    }

    pub(crate) fn append_chunk(&self, bytes: &[u8]) -> Result<(), String> {
        self.raw_sse
            .lock()
            .map_err(|error| error.to_string())?
            .append(bytes);
        Ok(())
    }

    pub(crate) fn persist_current(&self, stream_error: Option<&str>) -> Result<(), String> {
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
        if let Some(observation) = self.provider_observation.as_ref() {
            let snapshot = observation.snapshot()?;
                if !snapshot.provider_raw_sse.is_empty() {
                    let provider_payload = self.state.debug.project_payload_verbatim(json!({
                        "object": "routecodex.v3.provider_response_snapshot",
                        "stage": "provider-response",
                        "bodyKind": "sse",
                        "rawSse": snapshot.provider_raw_sse,
                    }));
                    persist_v3_codex_sample_payload(
                        &self.state,
                        &self.entry_protocol,
                        &self.endpoint,
                        &self.request_id,
                        "provider-response.json",
                        &provider_payload,
                    )?;
                }
        }
        Ok(())
    }
}

pub(crate) struct V3LiveSnapClientResponseSseRecorder {
    core: V3LiveSnapSseRecorderCore,
}

impl V3LiveSnapClientResponseSseRecorder {
    pub(crate) fn new(
        state: Arc<V3ListenerState>,
        entry_protocol: String,
        endpoint: String,
        request_id: String,
        output: &V3ResponsesRelayRuntimeOutput,
    ) -> Self {
        Self {
            core: V3LiveSnapSseRecorderCore {
                state,
                entry_protocol,
                endpoint,
                request_id,
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
            },
        }
    }

    pub(crate) fn wrap(
        &self,
        stream: V3ResponsesRelayClientStream,
    ) -> V3ResponsesRelayClientStream {
        let frame_recorder = self.core.clone();
        let terminal_recorder = self.core.clone();
        stream.observe(
            move |bytes| {
                if let Err(error) = frame_recorder.append_chunk(bytes) {
                    eprintln!("[v3-sse-snapshot] client response capture failed: {error}");
                }
            },
            move |terminal| {
                let disconnect = matches!(terminal, V3CommittedSseTerminal::Dropped)
                    .then_some("client disconnected before SSE replay completed");
                if let Err(error) = terminal_recorder.persist_current(disconnect) {
                    eprintln!("[v3-sse-snapshot] client response finalize failed: {error}");
                }
            },
        )
    }

    pub(crate) fn persist_initial(&self) -> Result<(), String> {
        self.core.persist_initial()
    }
}

#[derive(Clone)]
pub(crate) struct V3LiveSnapDirectClientResponseSseRecorder {
    core: V3LiveSnapSseRecorderCore,
}

impl V3LiveSnapDirectClientResponseSseRecorder {
    pub(crate) fn new(
        state: Arc<V3ListenerState>,
        entry_protocol: String,
        endpoint: String,
        request_id: String,
        frame: &V3Server16HttpFrame,
    ) -> Self {
        Self {
            core: V3LiveSnapSseRecorderCore {
                state,
                entry_protocol,
                endpoint,
                request_id,
                status: frame.status,
                node_trace: frame.node_trace.clone(),
                error_chain: Some(frame.error_chain.clone()),
                observability: frame
                    .observability
                    .as_ref()
                    .map(project_v3_runtime_observability_debug),
                finalized_response: None,
                provider_observation: frame.stream_observation.clone(),
                capture_client_response: true,
                source: "live_server_direct_response_stream",
                raw_sse: Arc::new(Mutex::new(V3DebugBoundedTextCapture::new())),
            },
        }
    }

    pub(crate) fn wrap_committed(
        &self,
        stream: V3CommittedClientSseStream,
    ) -> V3CommittedClientSseStream {
        let frame_recorder = self.core.clone();
        let terminal_recorder = self.core.clone();
        stream.observe(
            move |bytes| {
                if let Err(error) = frame_recorder.append_chunk(bytes) {
                    eprintln!("[v3-sse-snapshot] client response capture failed: {error}");
                }
            },
            move |terminal| {
                let disconnect = matches!(terminal, V3CommittedSseTerminal::Dropped)
                    .then_some("client disconnected before SSE replay completed");
                if let Err(error) = terminal_recorder.persist_current(disconnect) {
                    eprintln!("[v3-sse-snapshot] client response finalize failed: {error}");
                }
            },
        )
    }

    pub(crate) fn wrap_live(&self, stream: V3ClientSseStream) -> V3ClientSseStream {
        let recorder = self.core.clone();
        Box::pin(futures_util::stream::unfold(
            (stream, false),
            move |(mut stream, done)| {
                let recorder = recorder.clone();
                async move {
                    if done {
                        return None;
                    }
                    match stream.next().await {
                        Some(Ok(bytes)) => {
                            if let Err(error) = recorder.append_chunk(&bytes) {
                                return Some((
                                    Err(raise_v3_debug_artifact_failure(format!(
                                        "client response capture failed: {error}"
                                    ))),
                                    (stream, true),
                                ));
                            }
                            Some((Ok(bytes), (stream, false)))
                        }
                        Some(Err(error)) => {
                            if let Err(capture_error) =
                                recorder.persist_current(Some(error.message.as_str()))
                            {
                                return Some((
                                    Err(raise_v3_debug_artifact_failure(format!(
                                        "client response finalize failed: {capture_error}"
                                    ))),
                                    (stream, true),
                                ));
                            }
                            Some((Err(error), (stream, true)))
                        }
                        None => {
                            if let Err(error) = recorder.persist_current(None) {
                                return Some((
                                    Err(raise_v3_debug_artifact_failure(format!(
                                        "client response finalize failed: {error}"
                                    ))),
                                    (stream, true),
                                ));
                            }
                            None
                        }
                    }
                }
            },
        ))
    }

    pub(crate) fn persist_initial(&self) -> Result<(), String> {
        self.core.persist_initial()
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
    if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Direct {
        if !v3_codex_sample_scope_allows(state, execution_mode) {
            return None;
        }
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
        return None;
    }
    let projection = match state
        .debug
        .capture_raw_request(trace_scope, payload.clone())
    {
        Ok(projection) => projection,
        Err(error) => {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug02RawRequestCaptured",
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
            "request.json",
            &projection.payload,
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
        V3ResponsesRelayClientBody::Sse(_) => {
            let payload = json!({
                "object": "routecodex.v3.client_response_snapshot",
                "stage": "client-response",
                "source": "live_server_response_stream",
                "bodyKind": "sse",
                "rawSse": "",
                "stream": true,
                "materializedResponse": output.finalized_response.clone(),
                "status": output.status,
                "node_trace": output.node_trace.clone(),
                "error_chain": output.error_chain.clone(),
                "observability": output.observability.as_ref().map(project_v3_runtime_observability_debug),
            });
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
            let V3ResponsesRelayClientBody::Sse(stream) = std::mem::replace(
                &mut output.client_body,
                V3ResponsesRelayClientBody::Json(Value::Null),
            ) else {
                unreachable!("matched SSE client body");
            };
            let recorder = V3LiveSnapClientResponseSseRecorder::new(
                Arc::clone(state),
                entry_protocol.to_string(),
                endpoint.to_string(),
                request_id.to_string(),
                output,
            );
            if let Err(error) = recorder.persist_initial() {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3Debug03RawResponseCaptured",
                    V3DebugError::Sink(error),
                )));
            }
            output.client_body = V3ResponsesRelayClientBody::Sse(recorder.wrap(stream));
            return None;
        }
    };
    let projection = match state.debug.capture_raw_response(trace_scope, payload) {
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

pub(crate) fn capture_v3_openai_chat_relay_response(
    state: &Arc<V3ListenerState>,
    trace_scope: &V3DebugTraceScope,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    raw_request_payload: &Value,
    output: &mut V3OpenAiChatRelayRuntimeOutput,
) -> Option<Response<Body>> {
    let force_error_evidence =
        v3_output_has_terminal_client_error(output.status, output.error_chain.as_deref());
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
            let payload = state.debug.project_payload_verbatim(json!({
                "object": "routecodex.v3.client_response_snapshot",
                "stage": "client-response",
                "source": "live_server_openai_chat_response",
                "status": output.status,
                "bodyKind": "json",
                "rawBody": value,
                "node_trace": output.node_trace.clone(),
                "error_chain": output.error_chain.clone(),
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
        V3OpenAiChatRelayClientBody::Sse(_) => {
            let body = std::mem::replace(
                &mut output.client_body,
                V3OpenAiChatRelayClientBody::Json(Value::Null),
            );
            let V3OpenAiChatRelayClientBody::Sse(stream) = body else {
                unreachable!("matched OpenAI Chat SSE client body");
            };
            let recorder = V3LiveSnapOpenAiChatClientResponseSseRecorder::new(
                Arc::clone(state),
                entry_protocol.to_string(),
                endpoint.to_string(),
                request_id.to_string(),
                output,
                capture_client_response,
            );
            if let Err(error) = recorder.persist_initial() {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3Debug03RawResponseCaptured",
                    V3DebugError::Sink(error),
                )));
            }
            output.client_body = V3OpenAiChatRelayClientBody::Sse(recorder.wrap(stream));
        }
    }
    let _ = trace_scope;
    None
}

#[derive(Clone)]
pub(crate) struct V3LiveSnapOpenAiChatClientResponseSseRecorder {
    core: V3LiveSnapSseRecorderCore,
}

impl V3LiveSnapOpenAiChatClientResponseSseRecorder {
    pub(crate) fn new(
        state: Arc<V3ListenerState>,
        entry_protocol: String,
        endpoint: String,
        request_id: String,
        output: &V3OpenAiChatRelayRuntimeOutput,
        capture_client_response: bool,
    ) -> Self {
        Self {
            core: V3LiveSnapSseRecorderCore {
                state,
                entry_protocol,
                endpoint,
                request_id,
                status: output.status,
                node_trace: output.node_trace.clone(),
                error_chain: output.error_chain.clone(),
                observability: None,
                finalized_response: None,
                provider_observation: output.stream_observation.clone(),
                capture_client_response,
                source: "live_server_openai_chat_stream",
                raw_sse: Arc::new(Mutex::new(V3DebugBoundedTextCapture::new())),
            },
        }
    }

    pub(crate) fn wrap(&self, stream: V3OpenAiChatCommittedStream) -> V3OpenAiChatCommittedStream {
        let frame_recorder = self.core.clone();
        let terminal_recorder = self.core.clone();
        stream.observe(
            move |bytes| {
                if let Err(error) = frame_recorder.append_chunk(bytes) {
                    eprintln!("[v3-sse-snapshot] client response capture failed: {error}");
                }
            },
            move |_terminal| {
                if let Err(error) = terminal_recorder.persist_current(None) {
                    eprintln!("[v3-sse-snapshot] client response finalize failed: {error}");
                }
            },
        )
    }

    pub(crate) fn persist_initial(&self) -> Result<(), String> {
        self.core.persist_initial()
    }
}

pub(crate) fn capture_v3_responses_relay_provider_snapshots(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    output: &mut V3ResponsesRelayRuntimeOutput,
) -> Option<Response<Body>> {
    let terminal_error_evidence =
        v3_output_has_terminal_client_error(output.status, output.error_chain.as_deref());
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
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    output: &V3AnthropicRelayRuntimeOutput,
) -> Option<Response<Body>> {
    if !state.debug.should_capture_snapshot_stage("client-response") {
        return None;
    }
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
    None
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
    if v3_output_has_terminal_client_error(output.status, output.error_chain.as_deref()) {
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
            return foundation_output_response(project_v3_debug_failure(
                "V3DebugErrorEvidenceCaptured",
                V3DebugError::Sink(error),
            ));
        }
        if let Err(error) = persist_v3_error_evidence_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "error.json",
            &state
                .debug
                .project_payload_verbatim(json!({
                    "object": "routecodex.v3.error_evidence",
                    "stage": "error",
                    "status": output.status,
                    "request_id": request_id,
                    "endpoint": endpoint,
                    "node_trace": output.node_trace.clone(),
                    "error_chain": output.error_chain.clone(),
                "observability": output.observability.as_ref().map(project_v3_runtime_observability_debug),
            })),
            (output.status >= 400).then_some(output.status),
        ) {
            return foundation_output_response(project_v3_debug_failure(
                "V3DebugErrorEvidenceCaptured",
                V3DebugError::Sink(error),
            ));
        }

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
    for node_id in &output.node_trace {
        if let Err(error) = state.debug.record_node_event(
            trace_scope,
            *node_id,
            "executed",
            output
                .error_chain
                .as_ref()
                .map(|chain| json!({"error_chain": chain})),
        ) {
            return foundation_output_response(project_v3_debug_failure(
                "V3Debug01NodeEventRegistered",
                error,
            ));
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
    if let Some(error_chain) = output.error_chain.as_deref() {
        if let Some(response) = record_and_emit_v3_error_projection(
            state,
            trace_scope,
            V3ErrorProjectionConsoleInput {
                endpoint,
                request_id,
                entry_protocol,
                session_id: Some(&console_context.identity.session_id),
                status: output.status,
                error_chain,
                body: relay_error_body_for_console(&output.client_body),
                project_path: request_console_project_path,
            },
        ) {
            return response;
        }
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
    responses_relay_output_response(
        output,
        stream_console_finalizer,
        keepalive_interval,
        raw_request_payload
            .get("stream")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
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
        V3Server16Body::Sse(_) => {
            let body = std::mem::replace(&mut frame.body, V3Server16Body::Bytes(Vec::new()));
            let V3Server16Body::Sse(stream) = body else {
                unreachable!("matched live Direct SSE client body");
            };
            let recorder = V3LiveSnapDirectClientResponseSseRecorder::new(
                Arc::clone(state),
                entry_protocol.to_string(),
                endpoint.to_string(),
                request_id.to_string(),
                frame,
            );
            if let Err(error) = recorder.persist_initial() {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3Debug03RawResponseCaptured",
                    V3DebugError::Sink(error),
                )));
            }
            frame.body = V3Server16Body::Sse(recorder.wrap_live(stream));
            return None;
        }
        V3Server16Body::CommittedSse(_) => {
            let body = std::mem::replace(&mut frame.body, V3Server16Body::Bytes(Vec::new()));
            let V3Server16Body::CommittedSse(stream) = body else {
                unreachable!("matched committed Direct SSE client body");
            };
            let recorder = V3LiveSnapDirectClientResponseSseRecorder::new(
                Arc::clone(state),
                entry_protocol.to_string(),
                endpoint.to_string(),
                request_id.to_string(),
                frame,
            );
            if let Err(error) = recorder.persist_initial() {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3Debug03RawResponseCaptured",
                    V3DebugError::Sink(error),
                )));
            }
            frame.body = V3Server16Body::CommittedSse(recorder.wrap_committed(stream));
            return None;
        }
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
    let stages = [
        (
            "provider-request",
            "provider-request.json",
            output.provider_request_snapshot.take(),
        ),
        (
            "provider-response",
            "provider-response.json",
            output.provider_response_snapshot.take(),
        ),
    ];
    for (stage, filename, payload) in stages {
        if !state.debug.should_capture_snapshot_stage(stage) {
            continue;
        }
        let Some(payload) = payload else {
            continue;
        };
        if let Err(error) = persist_v3_codex_sample_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            filename,
            &state.debug.project_payload_verbatim(payload),
        ) {
            return Some(project_v3_debug_failure(
                "V3DebugProviderSnapshotCaptured",
                V3DebugError::Sink(error),
            ));
        }
    }
    None
}

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
        "stopless_activation": observability.stopless_activation,
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

pub(crate) fn persist_v3_codex_sample_payload(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    file_name: &str,
    payload: &Value,
) -> Result<(), String> {
    state.codex_sample_store.persist(
        state.server.port,
        entry_protocol,
        endpoint,
        request_id,
        file_name,
        payload,
        false,
        None,
    )
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
    state.codex_sample_store.persist(
        state.server.port,
        entry_protocol,
        endpoint,
        request_id,
        file_name,
        payload,
        true,
        status,
    )
}

pub(crate) fn v3_codex_sample_scope_allows(
    state: &V3ListenerState,
    execution_mode: V3EntryProtocolExecutionMode,
) -> bool {
    state.codex_sample_store.is_enabled()
        && (execution_mode != V3EntryProtocolExecutionMode::Direct
            || state.manifest.debug.snapshot_direct)
}

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
