//! Public Direct Runtime consumer edges. The observer and unused output fields
//! deliberately outlive the stream/future terminal; no guard is manufactured.
use axum::{body::Body, extract::State, http::header, response::Response, routing::post, Router};
use futures_util::StreamExt;
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_debug::V3DebugRuntime;
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw_with_purpose_and_scope,
    execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target,
    plan_v3_responses_protocol_execution_with_provider_health, register_responses_direct_hooks,
    V3ClientBody, V3ProviderFailureRuntimeHealth, V3RequestExecutionControl, V3RequestPurpose,
    V3ResponsesDirectRuntimeOutput, V3ResponsesDirectRuntimeSharedState,
    V3ResponsesDirectServerToolScope, V3ResponsesDirectServerToolState,
};
use serde_json::json;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Notify},
    task::JoinHandle,
    time::timeout,
};

const SSE: &str = concat!(
    "event: response.output_text.delta\n",
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"direct scope edge sentinel\"}\n\n",
    "event: response.completed\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_direct_scope_edge\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"direct scope edge sentinel\"}],\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}}\n\n"
);

#[derive(Default)]
struct PeerControl {
    arrived: Notify,
    release: Notify,
    calls: AtomicUsize,
}

async fn provider(State(control): State<Arc<PeerControl>>) -> Response {
    control.calls.fetch_add(1, Ordering::SeqCst);
    control.arrived.notify_one();
    control.release.notified().await;
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(SSE))
        .unwrap()
}

struct Peer {
    base_url: String,
    control: Arc<PeerControl>,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl Peer {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let control = Arc::new(PeerControl::default());
        let app = Router::new()
            .route("/v1/responses", post(provider))
            .with_state(control.clone());
        let (shutdown, rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = rx.await;
                })
                .await
                .unwrap();
        });
        Self {
            base_url,
            control,
            shutdown,
            task,
        }
    }

    async fn finish(self) {
        self.control.release.notify_one();
        self.shutdown
            .send(())
            .expect("peer shutdown receiver must be live");
        timeout(Duration::from_secs(5), self.task)
            .await
            .expect("peer must shut down")
            .expect("peer must exit without panic");
    }
}

fn manifest(server: &str, url: &str) -> V3Config05ManifestPublished {
    std::env::set_var("REQ02_DIRECT_EDGE_KEY", "isolated-test-key");
    let source = format!(
        r#"
version = 3
[servers.{server}]
bind = "127.0.0.1"
port = 45444
routing_group = "{server}"
endpoints = ["responses"]
[servers.{server}.execution]
allowed_modes = ["direct"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{}}
[providers.test]
type = "responses"
base_url = "{url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "REQ02_DIRECT_EDGE_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "always" }}
[providers.test.models.test]
wire_name = "wire-test"
aliases = ["client-test"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[route_groups.{server}.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-test"] }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
[route_groups.{server}.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn released(control: &V3RequestExecutionControl) -> bool {
    match control.request_context().original_pair() {
        Ok(_) => false,
        Err(error) if error.contains("original pair not initialized") => false,
        Err(error) if error.contains("scope already released") => true,
        Err(error) => panic!("unexpected public scope state: {error}"),
    }
}

async fn direct(
    manifest: &V3Config05ManifestPublished,
    server: &str,
    id: &str,
    control: V3RequestExecutionControl,
) -> V3ResponsesDirectRuntimeOutput {
    let scope = V3ProviderFailureSessionScope::new(server, server, format!("{id}-session"))
        .unwrap()
        .with_transport_handoff_scope(format!("{id}-pipeline"), 45444, 1)
        .unwrap();
    let raw = build_v3_server_03_http_request_raw_with_purpose_and_scope(
        server.to_string(),
        scope,
        id.to_string(),
        format!("{id}-execution"),
        "POST".to_string(),
        "/v1/responses".to_string(),
        V3RequestPurpose::Conversation,
        Some(45444),
        Some(format!("{id}-pipeline")),
        json!({"model":"client-test", "input":"direct scope edges", "stream":true}),
    );
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(manifest);
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        manifest,
        raw.clone(),
        health.clone(),
        1000,
    )
    .unwrap();
    let state = V3ResponsesDirectServerToolState::default();
    let debug = V3DebugRuntime::new(Default::default()).unwrap();
    execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target(
        V3ResponsesDirectRuntimeSharedState::new(&state, health), manifest, raw,
        V3ResponsesDirectServerToolScope::new("/v1/responses", format!("{id}-session"), format!("{id}-conversation"), 45444, server),
        register_responses_direct_hooks(), &debug, 1000, &plan, None, Some(control),
        routecodex_v3_runtime::V3DirectEntryOrigin::ClientEntry,
    ).await
}

#[tokio::test]
async fn req02_direct_sse_eof_releases_with_output_and_observer_alive() {
    let peer = Peer::start().await;
    peer.control.release.notify_one();
    let manifest = manifest("direct_edge_eof", &peer.base_url);
    let control = V3RequestExecutionControl::new(
        &manifest,
        "direct_edge_eof",
        "direct-edge-eof",
        "responses",
    )
    .unwrap();
    let observer = control.clone();
    let mut output = timeout(
        Duration::from_secs(10),
        direct(&manifest, "direct_edge_eof", "direct-edge-eof", control),
    )
    .await
    .unwrap();
    assert_eq!(output.client_payload.status, 200);
    assert!(
        !released(&observer),
        "returned stream must keep scope active before consumption"
    );
    let body = std::mem::replace(
        &mut output.client_payload.body,
        V3ClientBody::Bytes(Vec::new()),
    );
    let V3ClientBody::CommittedSse(mut stream) = body else {
        panic!("Direct must return actual committed SSE");
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = timeout(Duration::from_secs(5), stream.next())
        .await
        .unwrap()
    {
        bytes.extend(chunk);
    }
    let terminal_state = released(&observer);
    let calls = peer.control.calls.load(Ordering::SeqCst);
    peer.finish().await;
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.contains("direct scope edge sentinel"));
    assert!(text.contains("response.completed"));
    assert!(text.contains("total_tokens"));
    assert_eq!(calls, 1);
    assert!(
        terminal_state,
        "EOF must release scope while output fields, stream and observer remain alive"
    );
    assert!(output.observability.is_some());
    drop(output);
    drop(stream);
}

#[tokio::test]
async fn req02_direct_sse_drop_releases_with_output_and_observer_alive() {
    let peer = Peer::start().await;
    peer.control.release.notify_one();
    let manifest = manifest("direct_edge_drop", &peer.base_url);
    let control = V3RequestExecutionControl::new(
        &manifest,
        "direct_edge_drop",
        "direct-edge-drop",
        "responses",
    )
    .unwrap();
    let observer = control.clone();
    let mut output = timeout(
        Duration::from_secs(10),
        direct(&manifest, "direct_edge_drop", "direct-edge-drop", control),
    )
    .await
    .unwrap();
    assert_eq!(output.client_payload.status, 200);
    assert!(!released(&observer));
    let body = std::mem::replace(
        &mut output.client_payload.body,
        V3ClientBody::Bytes(Vec::new()),
    );
    let V3ClientBody::CommittedSse(mut stream) = body else {
        panic!("Direct must return actual committed SSE");
    };
    let first = timeout(Duration::from_secs(5), stream.next())
        .await
        .unwrap()
        .expect("nonempty SSE");
    assert!(!first.is_empty());
    assert!(
        !released(&observer),
        "scope remains active before partial stream is dropped"
    );
    drop(stream);
    let terminal_state = released(&observer);
    let calls = peer.control.calls.load(Ordering::SeqCst);
    peer.finish().await;
    assert_eq!(calls, 1);
    assert!(
        terminal_state,
        "stream Drop must release scope while output fields and observer remain alive"
    );
    assert!(output.observability.is_some());
    drop(output);
}

#[tokio::test]
async fn req02_direct_pending_cancel_releases_with_observer_alive() {
    let peer = Peer::start().await;
    let manifest = manifest("direct_edge_cancel", &peer.base_url);
    let control = V3RequestExecutionControl::new(
        &manifest,
        "direct_edge_cancel",
        "direct-edge-cancel",
        "responses",
    )
    .unwrap();
    let observer = control.clone();
    let handle = tokio::spawn(async move {
        direct(
            &manifest,
            "direct_edge_cancel",
            "direct-edge-cancel",
            control,
        )
        .await
    });
    timeout(Duration::from_secs(5), peer.control.arrived.notified())
        .await
        .expect("real provider must receive request before cancellation");
    assert!(!released(&observer));
    handle.abort();
    let join_error = handle.await.expect_err("runtime future must be cancelled");
    let terminal_state = released(&observer);
    let calls = peer.control.calls.load(Ordering::SeqCst);
    peer.finish().await;
    assert!(join_error.is_cancelled());
    assert_eq!(calls, 1);
    assert!(
        terminal_state,
        "cancelled Direct future must release while observer clone remains alive"
    );
}
