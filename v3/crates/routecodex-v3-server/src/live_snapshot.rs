// V3 live snapshot and codex sample capture side-channel.
// This module persists debug artifacts only; it must not own request/response/provider semantics.

use super::*;

#[derive(Clone)]
struct V3LiveSnapClientResponseSseRecorder {
    state: Arc<V3ListenerState>,
    entry_protocol: String,
    endpoint: String,
    request_id: String,
    status: u16,
    node_trace: Vec<&'static str>,
    error_chain: Option<Vec<&'static str>>,
    observability: Option<Value>,
    finalized_response: Option<Value>,
    raw_sse: Arc<Mutex<String>>,
    stream_error: Arc<Mutex<Option<String>>>,
}

impl V3LiveSnapClientResponseSseRecorder {
    fn new(
        state: Arc<V3ListenerState>,
        entry_protocol: String,
        endpoint: String,
        request_id: String,
        output: &V3ResponsesRelayRuntimeOutput,
    ) -> Self {
        Self {
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
            raw_sse: Arc::new(Mutex::new(String::new())),
            stream_error: Arc::new(Mutex::new(None)),
        }
    }

    fn wrap(&self, stream: V3ResponsesRelayClientStream) -> V3ResponsesRelayClientStream {
        let recorder = self.clone();
        Box::pin(stream.map(move |chunk| match chunk {
            Ok(bytes) => recorder.append_chunk(&bytes).map(|_| bytes),
            Err(error) => recorder.record_stream_error(&error).and(Err(error)),
        }))
    }

    fn persist_initial(&self) -> Result<(), String> {
        self.persist_current()
    }

    fn append_chunk(&self, bytes: &[u8]) -> Result<(), String> {
        {
            let mut raw_sse = self.raw_sse.lock().map_err(|error| error.to_string())?;
            raw_sse.push_str(&String::from_utf8_lossy(bytes));
        }
        self.persist_current()
    }

    fn record_stream_error(&self, error: &str) -> Result<(), String> {
        {
            let mut stream_error = self
                .stream_error
                .lock()
                .map_err(|lock_error| lock_error.to_string())?;
            *stream_error = Some(error.to_string());
        }
        self.persist_current()
    }

    fn persist_current(&self) -> Result<(), String> {
        let raw_sse = self
            .raw_sse
            .lock()
            .map_err(|error| error.to_string())?
            .clone();
        let stream_error = self
            .stream_error
            .lock()
            .map_err(|error| error.to_string())?
            .clone();
        let mut payload = json!({
            "object": "routecodex.v3.client_response_snapshot",
            "stage": "client-response",
            "source": "live_server_response_stream",
            "status": self.status,
            "bodyKind": "sse",
            "rawSse": raw_sse,
            "materializedResponse": self.finalized_response.clone(),
            "node_trace": self.node_trace.clone(),
            "error_chain": self.error_chain.clone(),
            "observability": self.observability.clone(),
        });
        if let Some(stream_error) = stream_error {
            if let Some(object) = payload.as_object_mut() {
                object.insert("streamError".to_string(), Value::String(stream_error));
            }
        }
        persist_v3_codex_sample_payload(
            &self.state,
            &self.entry_protocol,
            &self.endpoint,
            &self.request_id,
            "response.json",
            &payload,
        )
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
        let payload = state.debug.redact_payload_for_side_channel(payload.clone());
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

pub(crate) fn capture_v3_responses_relay_provider_snapshots(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    output: &V3ResponsesRelayRuntimeOutput,
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
    let snapshots = output.provider_snapshots.as_ref()?;
    if let Some(provider_request) = snapshots.provider_request.as_ref() {
        if state
            .debug
            .should_capture_snapshot_stage("provider-request")
        {
            if let Err(error) = persist_v3_codex_sample_payload(
                state,
                entry_protocol,
                endpoint,
                request_id,
                "provider-request.json",
                provider_request,
            ) {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3DebugProviderRequestCaptured",
                    V3DebugError::Sink(error),
                )));
            }
        }
    }
    if let Some(provider_response) = snapshots.provider_response.as_ref() {
        if state
            .debug
            .should_capture_snapshot_stage("provider-response")
        {
            if let Err(error) = persist_v3_codex_sample_payload(
                state,
                entry_protocol,
                endpoint,
                request_id,
                "provider-response.json",
                provider_response,
            ) {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3DebugProviderResponseCaptured",
                    V3DebugError::Sink(error),
                )));
            }
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
        let payload = state
            .debug
            .redact_payload_for_side_channel(output.body.clone());
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

fn project_v3_runtime_observability_debug(observability: &V3RuntimeObservability) -> Value {
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

fn project_v3_runtime_provider_failure_event_debug(
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

fn project_v3_runtime_usage_debug(usage: &V3RuntimeUsageSummary) -> Value {
    json!({
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
        "cached_tokens": usage.cached_tokens,
    })
}

fn persist_v3_codex_sample_payload(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    file_name: &str,
    payload: &Value,
) -> Result<(), String> {
    let Some(root) = std::env::var_os("HOME") else {
        return Ok(());
    };
    let dir = PathBuf::from(root)
        .join(".rcc")
        .join("codex-samples")
        .join(format_v3_codex_sample_endpoint_dir(
            entry_protocol,
            endpoint,
        ))
        .join("ports")
        .join(state.server.port.to_string())
        .join(encode_v3_codex_sample_path_segment(request_id));
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(file_name);
    let mut file = fs::File::create(path).map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut file, payload).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    Ok(())
}

fn format_v3_codex_sample_endpoint_dir(entry_protocol: &str, endpoint: &str) -> String {
    match (entry_protocol, endpoint) {
        ("responses", "/v1/responses") => "openai-responses".to_string(),
        ("openai_chat", "/v1/chat/completions") => "openai-chat-completions".to_string(),
        ("anthropic", "/v1/messages") => "anthropic-messages".to_string(),
        ("gemini", _) => "gemini-generate-content".to_string(),
        _ => encode_v3_codex_sample_path_segment(
            endpoint.trim_start_matches('/').replace('/', "-").as_str(),
        ),
    }
}

fn encode_v3_codex_sample_path_segment(value: &str) -> String {
    let path_safe = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if path_safe.is_empty() {
        "unknown".to_string()
    } else {
        path_safe
    }
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
