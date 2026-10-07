use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Router,
};
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::{
    execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_execution_mode_and_request_control,
    execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state,
    V3HubExecutionMode, V3OpenAiChatRelayRuntimeError, V3OpenAiChatRelayRuntimeInput,
    V3ProviderFailureRuntimeHealth, V3RequestExecutionControl,
    V3ResponsesRelayProviderHealthHandle, V3ResponsesRelayProviderSnapshotCapture,
    V3ResponsesRelayRuntimeError, V3ResponsesRelayRuntimeInput, V3ResponsesRelayServerToolScope,
    V3ResponsesRelayServerToolState,
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
    sync::oneshot,
    task::JoinHandle,
    time::{timeout, Duration},
};

const AUTH_ENV: &str = "REQ02_SCOPE_PRETRANSPORT_KEY";

async fn unexpected_provider_request(State(calls): State<Arc<AtomicUsize>>) -> Response<Body> {
    calls.fetch_add(1, Ordering::SeqCst);
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .body(Body::from("unexpected provider request"))
        .unwrap()
}

async fn start_provider_probe() -> (
    String,
    Arc<AtomicUsize>,
    oneshot::Sender<()>,
    JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route("/v1/responses", post(unexpected_provider_request))
        .with_state(Arc::clone(&calls));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{address}/v1"), calls, shutdown_tx, task)
}

fn responses_manifest(server_id: &str, provider_base_url: &str) -> V3Config05ManifestPublished {
    std::env::set_var(AUTH_ENV, "req02-pretransport-key");
    let source = format!(
        r#"
version = 3
[servers.{server_id}]
bind = "127.0.0.1"
port = 45444
routing_group = "{server_id}"
endpoints = ["responses"]
[servers.{server_id}.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{}}
[providers.disabled]
enabled = false
type = "responses"
base_url = "{provider_base_url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{AUTH_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "always" }}
[providers.disabled.models.test]
wire_name = "wire-test"
aliases = ["client-test"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[route_groups.{server_id}.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-test"] }}
targets = [{{ kind = "provider_model", provider = "disabled", model = "test", key = "key", priority = 1 }}]
[route_groups.{server_id}.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "disabled", model = "test", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn openai_chat_manifest(server_id: &str, provider_base_url: &str) -> V3Config05ManifestPublished {
    std::env::set_var(AUTH_ENV, "req02-pretransport-key");
    let source = format!(
        r#"
version = 3
[servers.{server_id}]
bind = "127.0.0.1"
port = 45444
routing_group = "{server_id}"
endpoints = ["openai_chat"]
[servers.{server_id}.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{}}
[providers.disabled]
enabled = false
type = "responses"
base_url = "{provider_base_url}"
default_model = "wire-test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{AUTH_ENV}" }}] }}
[providers.disabled.models.wire-test]
wire_name = "wire-test"
aliases = ["client-test"]
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[route_groups.{server_id}.pools.chat_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["client-test"] }}
targets = [{{ kind = "provider_model", provider = "disabled", model = "wire-test", key = "key", priority = 1 }}]
[route_groups.{server_id}.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "disabled", model = "wire-test", key = "key", priority = 1 }}]
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
    entry_protocol: &str,
) -> V3RequestExecutionControl {
    V3RequestExecutionControl::new(manifest, server_id, request_id, entry_protocol).unwrap()
}

fn responses_input(server_id: &str, request_id: &str) -> V3ResponsesRelayRuntimeInput {
    V3ResponsesRelayRuntimeInput {
        server_id: server_id.to_string(),
        failure_session_scope: failure_scope(server_id, request_id),
        request_id: request_id.to_string(),
        payload: json!({
            "model": "missing-client-test",
            "input": "req02 pretransport target failure",
            "stream": false
        }),
    }
}

fn openai_chat_input(server_id: &str, request_id: &str) -> V3OpenAiChatRelayRuntimeInput {
    V3OpenAiChatRelayRuntimeInput {
        server_id: server_id.to_string(),
        failure_session_scope: failure_scope(server_id, request_id),
        request_id: request_id.to_string(),
        payload: json!({
            "model": "missing-client-test",
            "messages": [{"role": "user", "content": "req02 pretransport target failure"}],
            "stream": false
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

#[tokio::test]
async fn req02_responses_relay_target_error_releases_scope_before_provider() {
    let (provider_base_url, provider_calls, shutdown, peer) = start_provider_probe().await;
    let server_id = "req02_responses_relay_pretransport";
    let request_id = "req02-responses-relay-pretransport";
    let manifest = responses_manifest(server_id, &provider_base_url);
    let control = request_control(&manifest, server_id, request_id, "responses");
    let observer = control.clone();
    assert_eq!(scope_state(&observer), ScopeState::Active);

    let provider_health =
        V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(&manifest);
    let server_tool_state = V3ResponsesRelayServerToolState::default();
    let result = timeout(
        Duration::from_secs(5),
        execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state(
            &manifest,
            responses_input(server_id, request_id),
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
        ),
    )
    .await
    .expect("planning failure must finish before provider transport");
    shutdown.send(()).expect("peer shutdown receiver");
    timeout(Duration::from_secs(5), peer)
        .await
        .expect("peer must shut down")
        .expect("peer must exit");

    let error = result.expect_err("missing requested model target must return a real Err");
    assert!(
        matches!(error, V3ResponsesRelayRuntimeError::Target(_)),
        "expected a real Responses Relay Target error, got {error:?}"
    );
    assert_eq!(
        provider_calls.load(Ordering::SeqCst),
        0,
        "target planning failure must occur before any provider request"
    );
    assert_eq!(
        scope_state(&observer),
        ScopeState::Released,
        "a real Responses Relay planning Err must release the request scope while an observer control clone remains"
    );
}

#[tokio::test]
async fn req02_openai_chat_relay_target_error_releases_scope_before_provider() {
    let (provider_base_url, provider_calls, shutdown, peer) = start_provider_probe().await;
    let server_id = "req02_openai_chat_relay_pretransport";
    let request_id = "req02-openai-chat-relay-pretransport";
    let manifest = openai_chat_manifest(server_id, &provider_base_url);
    let control = request_control(&manifest, server_id, request_id, "openai_chat");
    let observer = control.clone();
    assert_eq!(scope_state(&observer), ScopeState::Active);

    let provider_health =
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let result = timeout(Duration::from_secs(5),
        execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_execution_mode_and_request_control(
            &manifest,
            openai_chat_input(server_id, request_id),
            provider_health,
            V3HubExecutionMode::Relay,
            control,
            None,
        ))
        .await.expect("planning failure must finish before provider transport");
    shutdown.send(()).expect("peer shutdown receiver");
    timeout(Duration::from_secs(5), peer)
        .await
        .expect("peer must shut down")
        .expect("peer must exit");

    let error = result.expect_err("missing requested model target must return a real Err");
    assert!(
        matches!(error, V3OpenAiChatRelayRuntimeError::Target(_)),
        "expected a real OpenAI Chat Relay Target error, got {error:?}"
    );
    assert_eq!(
        provider_calls.load(Ordering::SeqCst),
        0,
        "target planning failure must occur before any provider request"
    );
    assert_eq!(
        scope_state(&observer),
        ScopeState::Released,
        "a real OpenAI Chat Relay planning Err must release the request scope while an observer control clone remains"
    );
}
