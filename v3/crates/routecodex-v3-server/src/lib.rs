use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, Response, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use routecodex_v3_config::{
    V3Config05ManifestPublished, V3DebugManifest, V3EntryProtocolExecutionMode, V3ServerManifest,
};
use routecodex_v3_debug::{
    V3DebugError, V3DebugRuntime, V3DebugRuntimeConfig, V3DryRunFixture, V3RedactionPolicy,
};
use routecodex_v3_error::{project_v3_http_boundary_error, V3HttpBoundaryErrorKind};
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw, execute_v3_anthropic_relay_runtime_with_default_transport,
    execute_v3_foundation_pending_runtime, execute_v3_gemini_relay_runtime_with_default_transport,
    execute_v3_openai_chat_relay_runtime_with_default_transport,
    execute_v3_responses_direct_dry_run_runtime,
    execute_v3_responses_direct_runtime_kernel_with_default_transport_debug_and_continuation,
    project_v3_anthropic_relay_runtime_failure, project_v3_debug_failure,
    project_v3_gemini_relay_runtime_failure, project_v3_openai_chat_relay_runtime_failure,
    register_responses_direct_hooks, V3AnthropicRelayRuntimeInput, V3AnthropicRelayRuntimeOutput,
    V3ClientBody, V3FoundationRuntimeInput, V3FoundationRuntimeOutput, V3GeminiRelayClientBody,
    V3GeminiRelayRuntimeInput, V3GeminiRelayRuntimeOutput, V3OpenAiChatRelayClientBody,
    V3OpenAiChatRelayRuntimeInput, V3OpenAiChatRelayRuntimeOutput, V3Resp15ClientPayload,
    V3ResponsesDirectContinuationScope, V3ResponsesDirectContinuationState,
};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const V3_PROTOCOL_PENDING_PROJECTION_RESOURCE: &str = "v3.protocol.pending_projection";

#[derive(Clone)]
struct V3ListenerState {
    server: V3ServerManifest,
    manifest_version: u16,
    manifest: Arc<V3Config05ManifestPublished>,
    debug: V3DebugRuntime,
    responses_direct_continuation: Arc<V3ResponsesDirectContinuationState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ServerStartup01ListenerSetPreflight {
    pub manifest_version: u16,
    pub listeners: Vec<V3ServerManifest>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3Server16HttpFrame {
    pub status: u16,
    pub content_type: String,
    pub body: V3Server16Body,
    pub debug_node: &'static str,
    pub error_node: &'static str,
    pub error_chain: Vec<&'static str>,
    pub node_trace: Vec<&'static str>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum V3Server16Body {
    Json(serde_json::Value),
    Bytes(Vec<u8>),
}

#[derive(Debug)]
pub struct V3ListenerHandle {
    pub server_id: String,
    pub addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Debug)]
pub struct V3ServerAggregateHandle {
    pub listeners: Vec<V3ListenerHandle>,
}

pub fn build_v3_server_startup_01_listener_set_from_config_05(
    manifest: &V3Config05ManifestPublished,
) -> V3ServerStartup01ListenerSetPreflight {
    V3ServerStartup01ListenerSetPreflight {
        manifest_version: manifest.version,
        listeners: manifest
            .servers
            .values()
            .filter(|server| server.enabled)
            .cloned()
            .collect(),
    }
}

impl V3ServerAggregateHandle {
    pub async fn shutdown(mut self) {
        for listener in &mut self.listeners {
            if let Some(shutdown) = listener.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
    }
}

pub async fn spawn_v3_server_aggregate(
    manifest: V3Config05ManifestPublished,
) -> Result<V3ServerAggregateHandle, std::io::Error> {
    let manifest = Arc::new(manifest);
    let preflight = build_v3_server_startup_01_listener_set_from_config_05(&manifest);
    let debug =
        build_v3_debug_runtime_from_manifest(&manifest.debug).map_err(std::io::Error::other)?;
    let responses_direct_continuation = Arc::new(V3ResponsesDirectContinuationState::default());
    let mut bound = Vec::with_capacity(preflight.listeners.len());
    for server in preflight.listeners {
        let addr: SocketAddr = format!("{}:{}", server.bind, server.port)
            .parse()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        let listener = TcpListener::bind(addr).await?;
        let bound_addr = listener.local_addr()?;
        bound.push((server, listener, bound_addr));
    }

    let mut listeners = Vec::with_capacity(bound.len());
    for (server, listener, addr) in bound {
        let server_id = server.id.clone();
        let app = build_v3_listener_router(V3ListenerState {
            server,
            manifest_version: preflight.manifest_version,
            manifest: manifest.clone(),
            debug: debug.clone(),
            responses_direct_continuation: responses_direct_continuation.clone(),
        });
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        listeners.push(V3ListenerHandle {
            server_id,
            addr,
            shutdown: Some(shutdown_tx),
        });
    }
    Ok(V3ServerAggregateHandle { listeners })
}

pub async fn serve_v3_server_aggregate_until_shutdown(
    manifest: V3Config05ManifestPublished,
) -> Result<(), std::io::Error> {
    let handle = spawn_v3_server_aggregate(manifest).await?;
    tokio::signal::ctrl_c().await?;
    handle.shutdown().await;
    Ok(())
}

fn build_v3_listener_router(state: V3ListenerState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models_endpoint))
        .route("/v1/responses", post(pending_endpoint))
        .route("/v1/messages", post(pending_endpoint))
        .route("/v1/chat/completions", post(pending_endpoint))
        .route(
            "/v1beta/models/:model/generateContent",
            post(pending_endpoint),
        )
        .route("/_routecodex/debug/status", get(debug_status))
        .route("/_routecodex/debug/logs", get(debug_logs))
        .route("/_routecodex/debug/snapshots", get(debug_snapshots))
        .route("/_routecodex/debug/dry-run", post(debug_dry_run))
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(path_not_found)
        .with_state(Arc::new(state))
}

async fn health(State(state): State<Arc<V3ListenerState>>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "version": 3,
        "manifest_version": state.manifest_version,
        "server_id": state.server.id,
        "bind": state.server.bind,
        "port": state.server.port,
    }))
}

async fn models_endpoint(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    json_response(200, build_v3_models_catalog(&state.manifest))
}

async fn pending_endpoint(
    State(state): State<Arc<V3ListenerState>>,
    request: Request,
) -> Response<Body> {
    let request_headers = request.headers().clone();
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let Some(binding) = state
        .manifest
        .hub_v1
        .as_ref()
        .and_then(|hub| hub.entry_protocol_binding_for_endpoint(&path))
    else {
        return error_output_response(project_http_input_error(
            V3HttpBoundaryErrorKind::EndpointNotEnabled,
            format!("endpoint path {path} has no entry protocol binding"),
        ));
    };
    let entry_protocol = binding.entry_protocol.clone();
    let execution_mode = binding.execution_mode;
    let pending_owner_symbol = binding.pending_owner_symbol.clone();
    if !state
        .server
        .endpoints
        .iter()
        .any(|declared| declared == &entry_protocol)
    {
        return error_output_response(project_http_input_error(
            V3HttpBoundaryErrorKind::EndpointNotEnabled,
            format!(
                "endpoint protocol {entry_protocol} is not enabled on server {}",
                state.server.id
            ),
        ));
    }
    let payload = match read_json_payload(request).await {
        Ok(payload) => payload,
        Err(projected) => return error_output_response(projected),
    };
    let request_id = state.debug.next_request_id(&state.server.id);
    let execution_id = state.debug.next_execution_id(&state.server.id);
    if entry_protocol == "openai_chat" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let output = match execute_v3_openai_chat_completions_request(
            &state.manifest,
            V3OpenAiChatRelayRuntimeInput {
                server_id: state.server.id.clone(),
                request_id,
                payload,
            },
        )
        .await
        {
            Ok(output) => output,
            Err(error) => project_v3_openai_chat_relay_runtime_failure(error),
        };
        return openai_chat_relay_output_response(output);
    }
    if entry_protocol == "anthropic" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let stream = payload.get("stream").and_then(serde_json::Value::as_bool) == Some(true);
        let output = match execute_v3_anthropic_messages_request(
            &state.manifest,
            V3AnthropicRelayRuntimeInput {
                server_id: state.server.id.clone(),
                request_id,
                payload,
            },
        )
        .await
        {
            Ok(output) => output,
            Err(error) => project_v3_anthropic_relay_runtime_failure(error),
        };
        return anthropic_relay_output_response(output, stream);
    }
    if entry_protocol == "gemini" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let output = match execute_v3_gemini_generate_content_request(
            &state.manifest,
            V3GeminiRelayRuntimeInput {
                server_id: state.server.id.clone(),
                request_id,
                endpoint_path: path.clone(),
                payload,
            },
        )
        .await
        {
            Ok(output) => output,
            Err(error) => project_v3_gemini_relay_runtime_failure(error),
        };
        return gemini_relay_output_response(output);
    }
    if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Direct {
        let continuation_scope = match build_responses_direct_continuation_scope(
            &request_headers,
            &request_id,
            &state.server,
            &path,
        ) {
            Ok(scope) => scope,
            Err(message) => {
                return error_output_response(project_http_input_error(
                    V3HttpBoundaryErrorKind::MalformedJson,
                    message,
                ))
            }
        };
        let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        {
            Ok(duration) => duration.as_millis() as u64,
            Err(error) => {
                return foundation_output_response(project_v3_debug_failure(
                    "V3HubReqContinuation03Classified",
                    V3DebugError::MalformedFixture(format!(
                        "system time precedes Unix epoch: {error}"
                    )),
                ))
            }
        };
        let output = execute_v3_responses_direct_runtime_kernel_with_default_transport_debug_and_continuation(
            &state.responses_direct_continuation,
            &state.manifest,
            build_v3_server_03_http_request_raw(
                state.server.id.clone(),
                request_id.clone(),
                execution_id.clone(),
                method,
                path,
                payload,
            ),
            continuation_scope,
            register_responses_direct_hooks(),
            &state.debug,
            now_epoch_ms,
        )
        .await;
        let scope = match state
            .debug
            .start_trace(&state.server.id, &request_id, &execution_id)
        {
            Ok(scope) => scope,
            Err(error) => {
                return foundation_output_response(project_v3_debug_failure(
                    "V3Debug01TraceContextStarted",
                    error,
                ))
            }
        };
        if let Err(error) = state.debug.record_node_event(
            &scope,
            "V3Server16HttpFrame",
            "projected",
            Some(json!({"status": output.client_payload.status})),
        ) {
            return foundation_output_response(project_v3_debug_failure(
                "V3Server16HttpFrame",
                error,
            ));
        }
        let frame = build_v3_server_16_http_frame_from_v3_resp_15(
            output.client_payload,
            output.node_trace,
            output.error_chain,
        );
        responses_direct_output_response(frame)
    } else if execution_mode == V3EntryProtocolExecutionMode::PendingNotImplemented {
        let pending_not_implemented = execution_mode.as_str();
        let Some(pending_owner) = pending_owner_symbol else {
            return error_output_response(project_http_input_error(
                V3HttpBoundaryErrorKind::EndpointNotEnabled,
                format!(
                    "entry protocol {entry_protocol} pending binding lacks explicit pending owner"
                ),
            ));
        };
        let output = execute_v3_foundation_pending_runtime(
            V3FoundationRuntimeInput {
                server_id: state.server.id.clone(),
                request_id,
                execution_id,
                method,
                path,
                payload,
            },
            &state.debug,
        );
        pending_binding_output_response(
            output,
            &entry_protocol,
            pending_not_implemented,
            &pending_owner,
        )
    } else {
        error_output_response(project_http_input_error(
            V3HttpBoundaryErrorKind::EndpointNotEnabled,
            format!(
                "entry protocol {entry_protocol} is bound to unsupported execution mode {}",
                execution_mode.as_str()
            ),
        ))
    }
}

fn pending_binding_output_response(
    output: V3FoundationRuntimeOutput,
    entry_protocol: &str,
    pending_not_implemented: &str,
    pending_owner: &str,
) -> Response<Body> {
    let mut response = foundation_output_response(output);
    insert_v3_projection_header(
        response.headers_mut(),
        "x-routecodex-v3-entry-protocol",
        entry_protocol,
    );
    insert_v3_projection_header(
        response.headers_mut(),
        "x-routecodex-v3-execution-mode",
        pending_not_implemented,
    );
    insert_v3_projection_header(
        response.headers_mut(),
        "x-routecodex-v3-pending-owner",
        pending_owner,
    );
    insert_v3_projection_header(
        response.headers_mut(),
        "x-routecodex-v3-pending-resource",
        V3_PROTOCOL_PENDING_PROJECTION_RESOURCE,
    );
    response
}

fn insert_v3_projection_header(headers: &mut HeaderMap, name: &'static str, value: &str) {
    headers.insert(
        name,
        HeaderValue::from_str(value)
            .expect("V3 binding projection header value is validated ASCII"),
    );
}

fn build_responses_direct_continuation_scope(
    headers: &HeaderMap,
    request_id: &str,
    server: &V3ServerManifest,
    endpoint: &str,
) -> Result<V3ResponsesDirectContinuationScope, String> {
    let turn_metadata = match headers.get("x-codex-turn-metadata") {
        Some(value) => {
            let text = value
                .to_str()
                .map_err(|error| format!("x-codex-turn-metadata is not UTF-8: {error}"))?;
            Some(
                serde_json::from_str::<serde_json::Value>(text)
                    .map_err(|error| format!("x-codex-turn-metadata is not valid JSON: {error}"))?,
            )
        }
        None => None,
    };
    let session_id = header_text(headers, "session-id")?
        .or_else(|| {
            turn_metadata
                .as_ref()
                .and_then(|metadata| metadata.get("session_id"))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| request_id.to_string());
    let conversation_id = header_text(headers, "thread-id")?
        .or_else(|| {
            turn_metadata
                .as_ref()
                .and_then(|metadata| metadata.get("thread_id"))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| session_id.clone());
    Ok(V3ResponsesDirectContinuationScope::responses(
        endpoint,
        session_id,
        conversation_id,
        server.port,
        server.routing_group.clone(),
    ))
}

fn header_text(headers: &HeaderMap, name: &str) -> Result<Option<String>, String> {
    headers
        .get(name)
        .map(|value| {
            value
                .to_str()
                .map(str::trim)
                .map(ToOwned::to_owned)
                .map_err(|error| format!("{name} is not UTF-8: {error}"))
        })
        .transpose()
        .map(|value| value.filter(|value| !value.is_empty()))
}

pub async fn execute_v3_anthropic_messages_request(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
) -> Result<V3AnthropicRelayRuntimeOutput, routecodex_v3_runtime::V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_with_default_transport(manifest, input).await
}

pub async fn execute_v3_openai_chat_completions_request(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
) -> Result<V3OpenAiChatRelayRuntimeOutput, routecodex_v3_runtime::V3OpenAiChatRelayRuntimeError> {
    execute_v3_openai_chat_relay_runtime_with_default_transport(manifest, input).await
}

pub async fn execute_v3_gemini_generate_content_request(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
) -> Result<V3GeminiRelayRuntimeOutput, routecodex_v3_runtime::V3GeminiRelayRuntimeError> {
    execute_v3_gemini_relay_runtime_with_default_transport(manifest, input).await
}

fn openai_chat_relay_output_response(output: V3OpenAiChatRelayRuntimeOutput) -> Response<Body> {
    let content_type = match &output.client_body {
        V3OpenAiChatRelayClientBody::Json(_) => "application/json",
        V3OpenAiChatRelayClientBody::Sse(_) => "text/event-stream",
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 OpenAI Chat Relay status"))
        .header("content-type", content_type)
        .header("x-routecodex-v3-node-trace", output.node_trace.join(","));
    if let Some(error_chain) = output.error_chain {
        builder = builder.header("x-routecodex-v3-error-chain", error_chain.join(","));
    }
    let body = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(client_stream) => Body::from_stream(client_stream),
        V3OpenAiChatRelayClientBody::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 OpenAI Chat Relay projection"),
        ),
    };
    builder
        .body(body)
        .expect("typed V3 OpenAI Chat Relay response")
}

fn gemini_relay_output_response(output: V3GeminiRelayRuntimeOutput) -> Response<Body> {
    let content_type = match &output.client_body {
        V3GeminiRelayClientBody::Json(_) => "application/json",
        V3GeminiRelayClientBody::Sse(_) => "text/event-stream",
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 Gemini Relay status"))
        .header("content-type", content_type)
        .header("x-routecodex-v3-node-trace", output.node_trace.join(","));
    if let Some(error_chain) = output.error_chain {
        builder = builder.header("x-routecodex-v3-error-chain", error_chain.join(","));
    }
    let body = match output.client_body {
        V3GeminiRelayClientBody::Sse(client_stream) => Body::from_stream(client_stream),
        V3GeminiRelayClientBody::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 Gemini Relay projection"),
        ),
    };
    builder.body(body).expect("typed V3 Gemini Relay response")
}

fn anthropic_relay_output_response(
    output: V3AnthropicRelayRuntimeOutput,
    stream: bool,
) -> Response<Body> {
    let stream = stream && output.error_chain.is_none();
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 Relay status"))
        .header(
            "content-type",
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            },
        )
        .header("x-routecodex-v3-node-trace", output.node_trace.join(","));
    if let Some(error_chain) = output.error_chain {
        builder = builder.header("x-routecodex-v3-error-chain", error_chain.join(","));
    }
    let body = if stream {
        let mut bytes = Vec::new();
        for event in output
            .client_response
            .get("events")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
        {
            if let (Some(name), Some(data)) = (
                event.get("event").and_then(serde_json::Value::as_str),
                event.get("data"),
            ) {
                bytes.extend_from_slice(format!("event: {name}\ndata: {data}\n\n").as_bytes());
            }
        }
        bytes
    } else {
        serde_json::to_vec(&output.client_response).expect("typed V3 Anthropic Relay projection")
    };
    builder
        .body(Body::from(body))
        .expect("typed V3 Anthropic Relay response")
}

async fn debug_status(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    match state.debug.status() {
        Ok(status) => json_response(200, json!({ "debug": status })),
        Err(error) => {
            foundation_output_response(project_v3_debug_failure("V3DebugStatusProjected", error))
        }
    }
}

async fn debug_logs(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    match state.debug.logs() {
        Ok(logs) => json_response(200, json!({ "logs": logs })),
        Err(error) => {
            foundation_output_response(project_v3_debug_failure("V3DebugLogsProjected", error))
        }
    }
}

async fn debug_snapshots(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    match state.debug.snapshots() {
        Ok(snapshots) => json_response(200, json!({ "snapshots": snapshots })),
        Err(error) => {
            foundation_output_response(project_v3_debug_failure("V3DebugSnapshotsProjected", error))
        }
    }
}

async fn debug_dry_run(
    State(state): State<Arc<V3ListenerState>>,
    request: Request,
) -> Response<Body> {
    let payload = match read_json_payload(request).await {
        Ok(payload) => payload,
        Err(projected) => return error_output_response(projected),
    };
    let fixture_id = match required_dry_run_string(&payload, "fixture_id") {
        Ok(value) => value,
        Err(error) => {
            return foundation_output_response(project_v3_debug_failure(
                "V3DryRunFixtureRegistered",
                error,
            ))
        }
    };
    let method = match required_dry_run_string(&payload, "method") {
        Ok(value) => value,
        Err(error) => {
            return foundation_output_response(project_v3_debug_failure(
                "V3DryRunFixtureRegistered",
                error,
            ))
        }
    };
    let path = match required_dry_run_string(&payload, "path") {
        Ok(value) => value,
        Err(error) => {
            return foundation_output_response(project_v3_debug_failure(
                "V3DryRunFixtureRegistered",
                error,
            ))
        }
    };
    let Some(request_payload) = payload.get("request_payload").cloned() else {
        return foundation_output_response(project_v3_debug_failure(
            "V3DryRunFixtureRegistered",
            V3DebugError::MalformedFixture("request_payload is required".to_string()),
        ));
    };
    let Some(response_payload) = payload.get("response_payload").cloned() else {
        return foundation_output_response(project_v3_debug_failure(
            "V3DryRunFixtureRegistered",
            V3DebugError::MalformedFixture("response_payload is required".to_string()),
        ));
    };
    let output = execute_v3_responses_direct_dry_run_runtime(
        V3DryRunFixture {
            fixture_id,
            server_id: state.server.id.clone(),
            method,
            path,
            request_payload,
            response_payload,
        },
        &state.manifest,
        &state.debug,
    )
    .await;
    foundation_output_response(output)
}

fn required_dry_run_string(
    payload: &serde_json::Value,
    field: &'static str,
) -> Result<String, V3DebugError> {
    payload
        .get(field)
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| V3DebugError::MalformedFixture(format!("{field} is required")))
}

fn foundation_output_response(output: V3FoundationRuntimeOutput) -> Response<Body> {
    let frame = build_v3_server_16_http_frame_from_v3_foundation_output(output);
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(frame.status).expect("typed V3 status"))
        .header("content-type", &frame.content_type)
        .header("x-routecodex-v3-debug-node", frame.debug_node);
    if frame.error_chain.is_empty() {
        builder = builder.header("x-routecodex-v3-no-network-send", "true");
    } else {
        builder = builder
            .header("x-routecodex-v3-error-node", frame.error_node)
            .header("x-routecodex-v3-error-chain", frame.error_chain.join(","));
    }
    let body = match frame.body {
        V3Server16Body::Json(value) => {
            serde_json::to_vec(&value).expect("V3Server16 JSON projection")
        }
        V3Server16Body::Bytes(bytes) => bytes,
    };
    builder.body(Body::from(body)).expect("typed response")
}

fn responses_direct_output_response(frame: V3Server16HttpFrame) -> Response<Body> {
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(frame.status).expect("typed V3 status"))
        .header("content-type", &frame.content_type)
        .header("x-routecodex-v3-debug-node", frame.debug_node)
        .header("x-routecodex-v3-node-trace", frame.node_trace.join(","));
    if !frame.error_chain.is_empty() {
        builder = builder
            .header("x-routecodex-v3-error-node", frame.error_node)
            .header("x-routecodex-v3-error-chain", frame.error_chain.join(","));
    }
    let body = match frame.body {
        V3Server16Body::Json(value) => {
            serde_json::to_vec(&value).expect("V3Server16 JSON projection")
        }
        V3Server16Body::Bytes(bytes) => bytes,
    };
    builder.body(Body::from(body)).expect("typed response")
}

pub fn build_v3_server_16_http_frame_from_v3_resp_15(
    payload: V3Resp15ClientPayload,
    mut node_trace: Vec<&'static str>,
    error_chain: Option<Vec<&'static str>>,
) -> V3Server16HttpFrame {
    node_trace.push("V3Server16HttpFrame");
    let content_type = payload
        .headers
        .get("content-type")
        .expect("V3Resp15ClientPayload owns a validated content-type")
        .clone();
    let error_chain = error_chain.unwrap_or_default();
    V3Server16HttpFrame {
        status: payload.status,
        content_type,
        body: match payload.body {
            V3ClientBody::Json(value) => V3Server16Body::Json(value),
            V3ClientBody::Bytes(bytes) => V3Server16Body::Bytes(bytes),
        },
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: if error_chain.is_empty() {
            "none"
        } else {
            "V3Error06ClientProjected"
        },
        error_chain,
        node_trace,
    }
}

fn build_v3_models_catalog(manifest: &V3Config05ManifestPublished) -> serde_json::Value {
    let mut data = Vec::new();
    for provider in manifest
        .providers
        .values()
        .filter(|provider| provider.enabled)
    {
        for model in provider.models.values() {
            let visible_ids = if model.aliases.is_empty() {
                vec![model.id.clone()]
            } else {
                model.aliases.clone()
            };
            for visible_id in visible_ids {
                data.push(json!({
                    "id": visible_id,
                    "object": "model",
                    "owned_by": format!("provider:{}", provider.id),
                    "provider_id": provider.id,
                    "canonical_model_id": model.id,
                    "wire_model": model.wire_name,
                    "aliases": model.aliases,
                    "capabilities": model.capabilities,
                    "supports_streaming": model.supports_streaming,
                    "supports_thinking": model.supports_thinking,
                    "thinking": model.thinking,
                    "max_tokens": model.max_tokens,
                    "max_context_tokens": model.max_context_tokens,
                    "features": model.features,
                }));
            }
        }
    }
    json!({
        "object": "list",
        "data": data,
    })
}

pub fn build_v3_server_16_http_frame_from_v3_error_06(
    projected: routecodex_v3_error::V3Error06ClientProjected,
) -> V3Server16HttpFrame {
    V3Server16HttpFrame {
        status: projected.status,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(projected.body),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: projected.chain[5],
        error_chain: projected.chain.to_vec(),
        node_trace: vec!["V3Error06ClientProjected", "V3Server16HttpFrame"],
    }
}

pub fn build_v3_server_16_http_frame_from_v3_foundation_output(
    output: V3FoundationRuntimeOutput,
) -> V3Server16HttpFrame {
    V3Server16HttpFrame {
        status: output.status,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(output.body),
        debug_node: output.debug_node,
        error_node: output.error_node,
        error_chain: output.error_chain,
        node_trace: output.node_trace,
    }
}

fn build_v3_debug_runtime_from_manifest(
    manifest: &V3DebugManifest,
) -> Result<V3DebugRuntime, routecodex_v3_debug::V3DebugError> {
    V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: manifest.log_console,
        log_file: manifest.log_file.clone(),
        snapshots_enabled: manifest.snapshots,
        dry_run_enabled: manifest.dry_run,
        raw_request_retention: manifest
            .retention
            .get("raw_requests")
            .copied()
            .unwrap_or(16) as usize,
        raw_response_retention: manifest
            .retention
            .get("raw_responses")
            .copied()
            .unwrap_or(16) as usize,
        event_retention: manifest.retention.get("events").copied().unwrap_or(512) as usize,
        redaction: V3RedactionPolicy::default(),
    })
}

// Preserve the V2 HTTP contract: image-bearing Responses requests may contain
// large data URLs, while the boundary still needs a finite allocation cap.
const V3_MAX_REQUEST_BODY_BYTES: usize = 64 * 1024 * 1024;

async fn read_json_payload(
    request: Request,
) -> Result<serde_json::Value, routecodex_v3_error::V3Error06ClientProjected> {
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let Some(content_type) = content_type else {
        return Err(project_http_input_error(
            V3HttpBoundaryErrorKind::ContentTypeRequired,
            "content-type application/json is required",
        ));
    };
    if !content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(project_http_input_error(
            V3HttpBoundaryErrorKind::ContentTypeUnsupported,
            format!("unsupported content-type {content_type}"),
        ));
    }
    let bytes = to_bytes(request.into_body(), V3_MAX_REQUEST_BODY_BYTES)
        .await
        .map_err(|error| {
            project_http_input_error(
                V3HttpBoundaryErrorKind::BodyTooLarge,
                format!("request body exceeds {V3_MAX_REQUEST_BODY_BYTES} bytes: {error}"),
            )
        })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        project_http_input_error(
            V3HttpBoundaryErrorKind::MalformedJson,
            format!("malformed JSON request body: {error}"),
        )
    })
}

async fn method_not_allowed() -> Response<Body> {
    error_output_response(project_http_input_error(
        V3HttpBoundaryErrorKind::MethodNotAllowed,
        "HTTP method is not allowed for this endpoint",
    ))
}

async fn path_not_found() -> Response<Body> {
    error_output_response(project_http_input_error(
        V3HttpBoundaryErrorKind::PathNotFound,
        "HTTP path is not registered",
    ))
}

fn project_http_input_error(
    kind: V3HttpBoundaryErrorKind,
    message: impl Into<String>,
) -> routecodex_v3_error::V3Error06ClientProjected {
    project_v3_http_boundary_error(kind, message)
}

fn error_output_response(
    projected: routecodex_v3_error::V3Error06ClientProjected,
) -> Response<Body> {
    responses_direct_output_response(build_v3_server_16_http_frame_from_v3_error_06(projected))
}

fn json_response(status: u16, body: serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(StatusCode::from_u16(status).expect("fixed status"))
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&body).expect("JSON projection"),
        ))
        .expect("fixed response")
}
