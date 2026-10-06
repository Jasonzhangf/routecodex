use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode},
    response::Response,
    routing::post,
    Router,
};
use futures_util::StreamExt;
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_debug::V3DebugRuntime;
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw_with_purpose_and_scope,
    execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target,
    execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state,
    plan_v3_responses_protocol_execution_with_provider_health, register_responses_direct_hooks,
    V3ProviderFailureRuntimeHealth, V3RequestExecutionControl, V3RequestPurpose,
    V3ResponsesDirectRuntimeSharedState, V3ResponsesDirectServerToolScope,
    V3ResponsesDirectServerToolState, V3ResponsesRelayClientBody,
    V3ResponsesRelayProviderHealthHandle, V3ResponsesRelayProviderSnapshotCapture,
    V3ResponsesRelayRuntimeInput, V3ResponsesRelayServerToolScope, V3ResponsesRelayServerToolState,
    V3Server03HttpRequestRaw,
};
use serde_json::json;
use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Notify},
    time::{timeout, Duration},
};

const AUTH_ENV: &str = "REQ02_SCOPE_RUNTIME_TEST_KEY";

#[derive(Default)]
struct BufferedAttemptBoundary {
    prefix_read: Notify,
    release_terminal: Notify,
}

async fn gated_sse_upstream(
    State(boundary): State<Arc<BufferedAttemptBoundary>>,
) -> Response<Body> {
    let prefix_boundary = Arc::clone(&boundary);
    let prefix = futures_util::stream::once(async move {
        prefix_boundary.prefix_read.notify_one();
        Ok::<_, std::io::Error>(axum::body::Bytes::from_static(
            b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"req02-gated-prefix\"}\n\n",
        ))
    });
    let terminal = futures_util::stream::once(async move {
        boundary.release_terminal.notified().await;
        Ok::<_, std::io::Error>(axum::body::Bytes::from_static(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_req02_gated\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"req02-gated-terminal\"}]}}\n\n",
        ))
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from_stream(prefix.chain(terminal)))
        .unwrap()
}

async fn assert_attempt_buffer_boundary(direct: bool) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let boundary = Arc::new(BufferedAttemptBoundary::default());
    let app = Router::new()
        .route("/v1/responses", post(gated_sse_upstream))
        .with_state(Arc::clone(&boundary));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let upstream = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let mode = if direct { "direct" } else { "relay" };
    let server_id = format!("req02_gated_{mode}");
    let request_id = format!("req02-gated-{mode}");
    let manifest = manifest(
        &server_id,
        &format!("\"{mode}\""),
        "responses",
        if direct { "direct" } else { "chat" },
        &format!("http://{address}/v1"),
    );
    let control = request_control(&manifest, &server_id, &request_id);
    let observer = control.clone();
    let attempt_id = if direct {
        format!("{request_id}:direct-attempt:0")
    } else {
        format!("{request_id}:relay-attempt:0")
    };
    let completion_observer = observer.clone();
    let completed_attempt_id = attempt_id.clone();
    let runtime = tokio::spawn(async move {
        let handle = completion_observer.request_context().clone();
        if direct {
            let output =
                call_direct_runtime(&manifest, &server_id, &request_id, true, control).await;
            assert_eq!(output.client_payload.status, 200, "{output:?}");
            handle
                .successful_attempt(&completed_attempt_id)
                .expect("complete provider terminal must publish its actual attempt");
            let payload = match output.client_payload.body {
                routecodex_v3_runtime::V3ClientBody::CommittedSse(mut replay) => {
                    let mut bytes = Vec::new();
                    while let Some(chunk) = replay.next().await {
                        bytes.extend_from_slice(&chunk);
                    }
                    bytes
                }
                other => panic!("Direct must return a completely buffered SSE attempt: {other:?}"),
            };
            (payload, handle)
        } else {
            let output = call_relay_runtime(&manifest, &server_id, &request_id, true, control)
                .await
                .expect("Relay must complete the controlled provider attempt");
            assert_eq!(output.status, 200, "{output:?}");
            handle
                .successful_attempt(&completed_attempt_id)
                .expect("complete provider terminal must publish its actual attempt");
            let payload = match output.client_body {
                V3ResponsesRelayClientBody::Sse(mut replay) => {
                    let mut bytes = Vec::new();
                    while let Some(chunk) = replay.next().await {
                        bytes.extend_from_slice(&chunk);
                    }
                    bytes
                }
                V3ResponsesRelayClientBody::Json(value) => {
                    panic!("Relay must return a completely buffered SSE attempt: {value}")
                }
            };
            (payload, handle)
        }
    });
    timeout(Duration::from_secs(5), boundary.prefix_read.notified())
        .await
        .expect("real provider HTTP stream must emit its first frame");
    assert!(
        !runtime.is_finished(),
        "client payload cannot commit before the provider terminal frame"
    );
    assert!(
        observer
            .request_context()
            .successful_attempt(&attempt_id)
            .is_err(),
        "a prefix-only provider stream must not publish a successful attempt"
    );
    boundary.release_terminal.notify_one();
    let (payload, handle) = timeout(Duration::from_secs(5), runtime)
        .await
        .expect("terminal frame must finish the buffered attempt")
        .expect("public runtime consumer must not panic");
    assert!(String::from_utf8(payload)
        .unwrap()
        .contains("req02-gated-terminal"));
    assert!(
        handle.original_pair().is_err(),
        "consuming the SSE EOF must release its request scope"
    );
    shutdown_tx.send(()).unwrap();
    timeout(Duration::from_secs(3), upstream)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn req02_attempt_buffer_boundary_direct() {
    assert_attempt_buffer_boundary(true).await;
}

#[tokio::test]
async fn req02_attempt_buffer_boundary_relay() {
    assert_attempt_buffer_boundary(false).await;
}

#[derive(Clone, Copy)]
enum UpstreamReply {
    JsonOk,
    SseOk,
    Http400,
}

struct UpstreamControl {
    reply: UpstreamReply,
    arrived: Arc<Notify>,
    release: Arc<Notify>,
    calls: Arc<AtomicUsize>,
}

async fn controlled_upstream(State(control): State<Arc<UpstreamControl>>) -> Response<Body> {
    control.calls.fetch_add(1, Ordering::SeqCst);
    control.arrived.notify_one();
    control.release.notified().await;

    match control.reply {
        UpstreamReply::JsonOk => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "id": "resp_req02_direct_json",
                    "status": "completed",
                    "output": [{"type": "output_text", "text": "direct json ok"}],
                    "usage": {
                        "input_tokens": 3,
                        "output_tokens": 2,
                        "total_tokens": 5
                    }
                }))
                .unwrap(),
            ))
            .unwrap(),
        UpstreamReply::SseOk => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from(
                concat!(
                    "event: response.output_text.delta\n",
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"relay sse ok\"}\n\n",
                    "event: response.completed\n",
                    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_req02_relay_sse\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"relay sse ok\"}],\"usage\":{\"input_tokens\":3,\"output_tokens\":3,\"total_tokens\":6}}}\n\n"
                ),
            ))
            .unwrap(),
        UpstreamReply::Http400 => Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "error": {
                        "message": "controlled upstream rejected request",
                        "type": "invalid_request_error",
                        "code": "controlled_req02_400"
                    }
                }))
                .unwrap(),
            ))
            .unwrap(),
    }
}

async fn start_upstream(
    reply: UpstreamReply,
) -> (String, Arc<UpstreamControl>, oneshot::Sender<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let control = Arc::new(UpstreamControl {
        reply,
        arrived: Arc::new(Notify::new()),
        release: Arc::new(Notify::new()),
        calls: Arc::new(AtomicUsize::new(0)),
    });
    let app = Router::new()
        .route("/v1/responses", post(controlled_upstream))
        .with_state(Arc::clone(&control));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{address}/v1"), control, shutdown_tx)
}

fn manifest(
    server_id: &str,
    allowed_modes_literal: &str,
    provider_type: &str,
    provider_process: &str,
    provider_base_url: &str,
) -> V3Config05ManifestPublished {
    std::env::set_var(AUTH_ENV, "req02-test-key");
    let source = format!(
        r#"
version = 3
[servers.{server_id}]
bind = "127.0.0.1"
port = 45444
routing_group = "{server_id}"
endpoints = ["responses"]
[servers.{server_id}.execution]
allowed_modes = [{allowed_modes_literal}]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{}}
[providers.test]
type = "{provider_type}"
base_url = "{provider_base_url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{AUTH_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "{provider_process}", streaming = "always" }}
[providers.test.models.test]
wire_name = "wire-test"
aliases = ["client-test"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[route_groups.{server_id}.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-test"] }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
[route_groups.{server_id}.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn relay_to_direct_manifest(
    server_id: &str,
    relay_base_url: &str,
    direct_base_url: &str,
) -> V3Config05ManifestPublished {
    std::env::set_var("REQ02_RELAY_FIRST_KEY", "req02-relay-key");
    std::env::set_var("REQ02_DIRECT_SECOND_KEY", "req02-direct-key");
    let source = format!(
        r#"
version = 3
[servers.{server_id}]
bind = "127.0.0.1"
port = 45444
routing_group = "{server_id}"
endpoints = ["responses"]
[servers.{server_id}.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{}}
[providers.relay_first]
type = "anthropic"
base_url = "{relay_base_url}"
default_model = "claude-test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "REQ02_RELAY_FIRST_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.relay_first.models.claude-test]
wire_name = "claude-test"
capabilities = ["text"]
[providers.direct_second]
type = "responses"
base_url = "{direct_base_url}"
default_model = "responses-test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "REQ02_DIRECT_SECOND_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "always", transport = "http" }}
[providers.direct_second.models.responses-test]
wire_name = "responses-test"
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[forwarders.mixed]
model = "client-test"
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "relay_first", model = "claude-test", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "direct_second", model = "responses-test", key = "key", priority = 1 }}
]
[route_groups.{server_id}.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "mixed", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn failure_scope(server_id: &str, request_id: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new(server_id, server_id, format!("{request_id}-session"))
        .unwrap()
        .with_transport_handoff_scope(format!("{request_id}-pipeline"), 45444, 1)
        .unwrap()
}

fn request_control(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    request_id: &str,
) -> V3RequestExecutionControl {
    V3RequestExecutionControl::new(manifest, server_id, request_id, "responses").unwrap()
}

fn raw_responses_request(
    server_id: &str,
    request_id: &str,
    stream: bool,
) -> V3Server03HttpRequestRaw {
    build_v3_server_03_http_request_raw_with_purpose_and_scope(
        server_id.to_string(),
        failure_scope(server_id, request_id),
        request_id.to_string(),
        format!("{request_id}-execution"),
        "POST".to_string(),
        "/v1/responses".to_string(),
        V3RequestPurpose::Conversation,
        Some(45444),
        Some(format!("{request_id}-pipeline")),
        json!({
            "model": "client-test",
            "input": "req02 runtime consumer",
            "stream": stream
        }),
    )
}

fn relay_input(server_id: &str, request_id: &str, stream: bool) -> V3ResponsesRelayRuntimeInput {
    V3ResponsesRelayRuntimeInput {
        server_id: server_id.to_string(),
        failure_session_scope: failure_scope(server_id, request_id),
        request_id: request_id.to_string(),
        payload: json!({
            "model": "client-test",
            "input": "req02 runtime consumer",
            "stream": stream
        }),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScopeState {
    Active,
    Released,
}

fn scope_state(control: &V3RequestExecutionControl) -> ScopeState {
    match control.request_context().original_pair() {
        Ok(_) => ScopeState::Active,
        Err(error) if error.contains("scope already released") => ScopeState::Released,
        Err(error) if error.contains("original pair not initialized") => ScopeState::Active,
        Err(error) => panic!("unexpected public request-scope state: {error}"),
    }
}

async fn call_relay_runtime(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    request_id: &str,
    stream: bool,
    control: V3RequestExecutionControl,
) -> Result<
    routecodex_v3_runtime::V3ResponsesRelayRuntimeOutput,
    routecodex_v3_runtime::V3ResponsesRelayRuntimeError,
> {
    let provider_health =
        V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(manifest);
    let server_tool_state = V3ResponsesRelayServerToolState::default();
    execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state(
        manifest,
        relay_input(server_id, request_id, stream),
        &provider_health,
        &server_tool_state,
        V3ResponsesRelayServerToolScope::new(
            "/v1/responses",
            format!("{request_id}-session"),
            format!("{request_id}-conversation"),
            45444,
            server_id,
        ),
        V3ResponsesRelayProviderSnapshotCapture::new(false, false),
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        None,
        Some(control),
        routecodex_v3_runtime::V3ResponsesRelayRuntimeSeeds::default(),
        routecodex_v3_runtime::V3RelayEntryOrigin::ClientEntry,
    )
    .await
}

async fn call_direct_runtime(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    request_id: &str,
    stream: bool,
    control: V3RequestExecutionControl,
) -> routecodex_v3_runtime::V3ResponsesDirectRuntimeOutput {
    let raw = raw_responses_request(server_id, request_id, stream);
    let provider_health =
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(manifest);
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        manifest,
        raw.clone(),
        provider_health.clone(),
        1_000,
    )
    .expect("direct request must have a public protocol execution plan");
    let server_tool_state = V3ResponsesDirectServerToolState::default();
    let debug = V3DebugRuntime::new(Default::default()).unwrap();
    execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target(
        V3ResponsesDirectRuntimeSharedState::new(&server_tool_state, provider_health),
        manifest,
        raw,
        V3ResponsesDirectServerToolScope::new(
            "/v1/responses",
            format!("{request_id}-session"),
            format!("{request_id}-conversation"),
            45444,
            server_id,
        ),
        register_responses_direct_hooks(),
        &debug,
        1_000,
        &plan,
        None,
        Some(control),
    )
    .await
}

#[tokio::test]
async fn req02_relay_sse_releases_on_eof_with_observer_control_alive() {
    let (base_url, upstream, shutdown) = start_upstream(UpstreamReply::SseOk).await;
    upstream.release.notify_one();
    let manifest = manifest(
        "req02_relay_sse_eof",
        "\"relay\"",
        "responses",
        "chat",
        &base_url,
    );
    let control = request_control(&manifest, "req02_relay_sse_eof", "req02-relay-sse-eof");
    let observer = control.clone();
    assert_eq!(scope_state(&observer), ScopeState::Active);

    let output = call_relay_runtime(
        &manifest,
        "req02_relay_sse_eof",
        "req02-relay-sse-eof",
        true,
        control,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 200);
    assert_eq!(upstream.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        scope_state(&observer),
        ScopeState::Active,
        "scope must remain active after SSE output is returned but before EOF"
    );

    let V3ResponsesRelayClientBody::Sse(mut stream) = output.client_body else {
        panic!("real Relay SSE request must return an SSE client body");
    };
    let mut forwarded = Vec::new();
    while let Some(chunk) = stream.next().await {
        forwarded.extend(chunk);
    }
    let forwarded = String::from_utf8(forwarded).unwrap();
    assert!(forwarded.contains("response.completed"));
    assert_eq!(
        scope_state(&observer),
        ScopeState::Released,
        "real Relay SSE EOF must release the request scope even while an observer control clone remains"
    );
    let _ = shutdown.send(());
}

#[tokio::test]
async fn req02_relay_cancel_releases_with_observer_control_alive() {
    let (base_url, upstream, shutdown) = start_upstream(UpstreamReply::SseOk).await;
    let manifest = manifest(
        "req02_relay_cancel",
        "\"relay\"",
        "responses",
        "chat",
        &base_url,
    );
    let control = request_control(&manifest, "req02_relay_cancel", "req02-relay-cancel");
    let observer = control.clone();
    let manifest_for_task = manifest.clone();
    let handle = tokio::spawn(async move {
        call_relay_runtime(
            &manifest_for_task,
            "req02_relay_cancel",
            "req02-relay-cancel",
            true,
            control,
        )
        .await
    });

    timeout(Duration::from_secs(5), upstream.arrived.notified())
        .await
        .expect("runtime must reach the real upstream before cancellation");
    handle.abort();
    let join_error = handle.await.expect_err("runtime task must be cancelled");
    assert!(join_error.is_cancelled());
    tokio::task::yield_now().await;
    assert_eq!(
        scope_state(&observer),
        ScopeState::Released,
        "cancelling the real Runtime future must release its request scope while an observer control clone remains"
    );
    upstream.release.notify_one();
    let _ = shutdown.send(());
}

#[tokio::test]
async fn req02_direct_json_success_releases_when_public_output_drops() {
    let (base_url, upstream, shutdown) = start_upstream(UpstreamReply::JsonOk).await;
    upstream.release.notify_one();
    let manifest = manifest(
        "req02_direct_json",
        "\"direct\"",
        "responses",
        "direct",
        &base_url,
    );
    let control = request_control(&manifest, "req02_direct_json", "req02-direct-json");
    let observer = control.clone();
    assert_eq!(scope_state(&observer), ScopeState::Active);

    let output = call_direct_runtime(
        &manifest,
        "req02_direct_json",
        "req02-direct-json",
        false,
        control,
    )
    .await;
    assert_eq!(
        output.client_payload.status, 200,
        "real Direct JSON success must return the upstream 200: {output:#?}"
    );
    assert!(
        output.request_finalizer.is_some(),
        "real Direct JSON success must carry the request-scope finalizer on the public output"
    );
    assert_eq!(
        scope_state(&observer),
        ScopeState::Active,
        "scope must remain active while the public Direct output owns the finalizer"
    );
    drop(output);
    assert_eq!(
        scope_state(&observer),
        ScopeState::Released,
        "dropping the consumed public Direct JSON output must release the request scope"
    );
    let _ = shutdown.send(());
}

#[tokio::test]
async fn req02_direct_error_releases_when_public_output_drops() {
    let (base_url, upstream, shutdown) = start_upstream(UpstreamReply::Http400).await;
    upstream.release.notify_one();
    let manifest = manifest(
        "req02_direct_error",
        "\"direct\"",
        "responses",
        "direct",
        &base_url,
    );
    let control = request_control(&manifest, "req02_direct_error", "req02-direct-error");
    let observer = control.clone();

    let output = call_direct_runtime(
        &manifest,
        "req02_direct_error",
        "req02-direct-error",
        false,
        control,
    )
    .await;
    let output_debug = format!("{output:#?}");
    // The Server consumes the typed terminal disposition before client_payload.
    // Its ExternalHttp witness is the public provider error outcome at this boundary.
    let status = match output.terminal_disposition.as_ref() {
        Some(routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness)) => {
            witness.status()
        }
        other => panic!("expected the eligible upstream HTTP terminal, got {other:?}"),
    };
    assert_eq!(
        scope_state(&observer),
        ScopeState::Active,
        "the real Direct terminal output must own its scope until consumption or Drop"
    );
    drop(output);
    let state = scope_state(&observer);
    assert_eq!(
        (status, state),
        (400, ScopeState::Released),
        "real Direct HTTP terminal must preserve its eligible upstream witness and release after public output drop: {output_debug}"
    );
    let _ = shutdown.send(());
}

#[tokio::test]
async fn req02_relay_to_direct_handoff_preserves_same_scope() {
    let (direct_base_url, _upstream, shutdown) = start_upstream(UpstreamReply::JsonOk).await;
    let relay_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay_address = relay_listener.local_addr().unwrap();
    drop(relay_listener);
    let relay_base_url = format!("http://{relay_address}/v1");
    let manifest = relay_to_direct_manifest(
        "req02_relay_direct_handoff",
        &relay_base_url,
        &direct_base_url,
    );
    let control = request_control(
        &manifest,
        "req02_relay_direct_handoff",
        "req02-relay-direct-handoff",
    );
    let observer = control.clone();
    let output = call_relay_runtime(
        &manifest,
        "req02_relay_direct_handoff",
        "req02-relay-direct-handoff",
        false,
        control,
    )
    .await
    .unwrap();
    let handoff = output
        .protocol_direct_handoff
        .expect("same-protocol Relay entry must expose the public Direct handoff");
    assert!(
        observer
            .request_context()
            .same_scope(handoff.request_execution_control.request_context()),
        "Relay-to-Direct handoff must preserve the exact request context identity"
    );
    assert_eq!(scope_state(&observer), ScopeState::Active);
    let _ = shutdown.send(());
}
