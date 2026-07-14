use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::{Response, StatusCode};
use axum::routing::{any, get};
use axum::{Json, Router};
use routecodex_v3_config::{V3Config05ManifestPublished, V3DebugManifest, V3ServerManifest};
use routecodex_v3_debug::{
    V3DebugError, V3DebugRuntime, V3DebugRuntimeConfig, V3DryRunFixture, V3RedactionPolicy,
};
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw, execute_v3_foundation_dry_run_runtime,
    execute_v3_foundation_pending_runtime,
    execute_v3_responses_direct_runtime_kernel_with_default_transport_and_debug,
    project_v3_debug_failure, register_responses_direct_hooks, V3ClientBody,
    V3FoundationRuntimeInput, V3FoundationRuntimeOutput, V3ResponsesDirectRuntimeOutput,
};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

#[derive(Clone)]
struct V3ListenerState {
    server: V3ServerManifest,
    manifest_version: u16,
    manifest: Arc<V3Config05ManifestPublished>,
    debug: V3DebugRuntime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ServerStartup01ListenerSetPreflight {
    pub manifest_version: u16,
    pub listeners: Vec<V3ServerManifest>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3Server16HttpFrame {
    pub status: u16,
    pub body: serde_json::Value,
    pub debug_node: &'static str,
    pub error_node: &'static str,
    pub error_chain: Vec<&'static str>,
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
    let mut bound = Vec::with_capacity(preflight.listeners.len());
    for server in preflight.listeners {
        let addr: SocketAddr = format!("{}:{}", server.bind, server.port)
            .parse()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        let listener = TcpListener::bind(addr).await?;
        bound.push((server, listener));
    }

    let mut listeners = Vec::with_capacity(bound.len());
    for (server, listener) in bound {
        let addr = listener.local_addr()?;
        let server_id = server.id.clone();
        let app = build_v3_listener_router(V3ListenerState {
            server,
            manifest_version: preflight.manifest_version,
            manifest: manifest.clone(),
            debug: debug.clone(),
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
        .route("/v1/responses", any(pending_endpoint))
        .route("/v1/messages", any(pending_endpoint))
        .route("/v1/chat/completions", any(pending_endpoint))
        .route(
            "/v1beta/models/:model/generateContent",
            any(pending_endpoint),
        )
        .route("/_routecodex/debug/status", any(debug_status))
        .route("/_routecodex/debug/logs", any(debug_logs))
        .route("/_routecodex/debug/snapshots", any(debug_snapshots))
        .route("/_routecodex/debug/dry-run", any(debug_dry_run))
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
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let payload = read_json_payload(request).await;
    let request_id = state.debug.next_request_id(&state.server.id);
    let execution_id = state.debug.next_execution_id(&state.server.id);
    let is_responses = path == "/v1/responses";
    if is_responses {
        let output = execute_v3_responses_direct_runtime_kernel_with_default_transport_and_debug(
            &state.manifest,
            build_v3_server_03_http_request_raw(
                state.server.id.clone(),
                request_id,
                execution_id,
                method,
                path,
                payload,
            ),
            register_responses_direct_hooks(),
            &state.debug,
        )
        .await;
        responses_direct_output_response(output)
    } else {
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
        foundation_output_response(output)
    }
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
    let payload = read_json_payload(request).await;
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
    let output = execute_v3_foundation_dry_run_runtime(
        V3DryRunFixture {
            fixture_id,
            server_id: state.server.id.clone(),
            method,
            path,
            request_payload,
            response_payload,
        },
        &state.debug,
    );
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
        .header("content-type", "application/json")
        .header("x-routecodex-v3-debug-node", frame.debug_node);
    if frame.error_chain.is_empty() {
        builder = builder.header("x-routecodex-v3-no-network-send", "true");
    } else {
        builder = builder
            .header("x-routecodex-v3-error-node", frame.error_node)
            .header("x-routecodex-v3-error-chain", frame.error_chain.join(","));
    }
    builder
        .body(Body::from(
            serde_json::to_vec(&frame.body).expect("typed JSON projection"),
        ))
        .expect("typed response")
}

fn responses_direct_output_response(output: V3ResponsesDirectRuntimeOutput) -> Response<Body> {
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.client_payload.status).expect("typed V3 status"))
        .header(
            "content-type",
            output
                .client_payload
                .headers
                .get("content-type")
                .map(String::as_str)
                .unwrap_or("application/json"),
        )
        .header("x-routecodex-v3-debug-node", "V3Debug01NodeEventRegistered")
        .header("x-routecodex-v3-node-trace", output.node_trace.join(","));
    if let Some(chain) = output.error_chain.as_ref() {
        builder = builder
            .header("x-routecodex-v3-error-node", "V3Error06ClientProjected")
            .header("x-routecodex-v3-error-chain", chain.join(","));
    }
    let body = match output.client_payload.body {
        V3ClientBody::Json(value) => serde_json::to_vec(&value).expect("typed JSON projection"),
        V3ClientBody::Bytes(bytes) => bytes,
    };
    builder.body(Body::from(body)).expect("typed response")
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
        body: projected.body,
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: projected.chain[5],
        error_chain: projected.chain.to_vec(),
    }
}

pub fn build_v3_server_16_http_frame_from_v3_foundation_output(
    output: V3FoundationRuntimeOutput,
) -> V3Server16HttpFrame {
    V3Server16HttpFrame {
        status: output.status,
        body: output.body,
        debug_node: output.debug_node,
        error_node: output.error_node,
        error_chain: output.error_chain,
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

async fn read_json_payload(request: Request) -> serde_json::Value {
    match to_bytes(request.into_body(), 1024 * 1024).await {
        Ok(bytes) if bytes.is_empty() => json!({}),
        Ok(bytes) => serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"raw_body_bytes": bytes.len()})),
        Err(error) => json!({"body_read_error": error.to_string()}),
    }
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
