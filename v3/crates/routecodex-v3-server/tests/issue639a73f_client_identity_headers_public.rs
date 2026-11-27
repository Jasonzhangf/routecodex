//! Public-entry red test for forwarding client identity headers to Responses.
//!
//! The request uses the real `/v1/responses` server entry and a controlled
//! local Responses provider. The provider must receive the request's exact
//! `User-Agent` and `Originator`, while the client `Authorization` must not
//! replace the provider's configured credential.

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
    response::Response,
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const PROVIDER_KEY_ENV: &str = "V3_ISSUE_639A73F_PROVIDER_KEY";
const CLIENT_MODEL: &str = "identity-client-model";
const WIRE_MODEL: &str = "identity-wire-model";
const FAILING_MODEL: &str = "identity-failing-model";
const REDIRECT_WIRE_MODEL: &str = "identity-redirect-wire-model";
const USER_AGENT: &str = "codex-tui/0.1.0";
const ORIGINATOR: &str = "codex-tui";
const CLIENT_REQUEST_ID: &str = "codex-client-request-a551b52";
const CLIENT_SESSION_ID: &str = "codex-session-a551b52";
const CLIENT_THREAD_ID: &str = "codex-thread-a551b52";
const CLIENT_WINDOW_ID: &str = "codex-window-a551b52";
const CLIENT_PARENT_THREAD_ID: &str = "codex-parent-thread-a551b52";
const CLIENT_SUBAGENT: &str = "codex-subagent-a551b52";
const CONFIGURED_ORIGINATOR: &str = "configured-provider-originator";
const CONFIGURED_REQUEST_ID: &str = "configured-provider-request-id";
const CONFIGURED_SESSION_ID: &str = "configured-provider-session-id";
const CLIENT_AUTHORIZATION: &str = "Bearer client-secret";
const PROVIDER_AUTHORIZATION: &str = "Bearer provider-secret";

struct TestHomeGuard {
    previous: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "routecodex-issue639a73f-home-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &path);
        Self { previous, path }
    }
}

impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[derive(Debug)]
struct ProviderCapture {
    headers: HeaderMap,
    user_agent: Option<String>,
    originator: Option<String>,
    authorization: Option<String>,
    body: Value,
}

#[derive(Clone)]
struct ProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
    redirect_to: Option<String>,
    hits: Arc<AtomicUsize>,
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

async fn controlled_responses_upstream(
    State(state): State<Arc<ProviderState>>,
    uri: Uri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.hits.fetch_add(1, Ordering::SeqCst);
    let fail = body["model"] == FAILING_MODEL;
    let redirect = if body["model"] == REDIRECT_WIRE_MODEL && uri.query() != Some("redirected=1") {
        state.redirect_to.as_deref()
    } else {
        None
    };
    state
        .captures
        .send(ProviderCapture {
            headers: headers.clone(),
            user_agent: header_text(&headers, "user-agent"),
            originator: header_text(&headers, "originator"),
            authorization: header_text(&headers, "authorization"),
            body,
        })
        .unwrap();

    if let Some(location) = redirect {
        return Response::builder()
            .status(StatusCode::TEMPORARY_REDIRECT)
            .header("location", location)
            .body(Body::empty())
            .unwrap();
    }

    if fail {
        return Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"message":"controlled first attempt failure"}}"#,
            ))
            .unwrap();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "resp_issue639a73f",
                "object": "response",
                "status": "completed",
                "model": WIRE_MODEL,
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{
                        "type": "output_text",
                        "text": "controlled response"
                    }]
                }]
            })
            .to_string(),
        ))
        .unwrap()
}

struct Upstream {
    addr: SocketAddr,
    captures: mpsc::UnboundedReceiver<ProviderCapture>,
    hits: Arc<AtomicUsize>,
    shutdown: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

async fn start_upstream() -> Upstream {
    start_upstream_with_redirect(None).await
}

async fn start_upstream_with_redirect(redirect_to: Option<String>) -> Upstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (captures_tx, captures) = mpsc::unbounded_channel();
    let (shutdown, shutdown_rx) = oneshot::channel();
    let hits = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route("/v1/responses", post(controlled_responses_upstream))
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
            redirect_to,
            hits: hits.clone(),
        }));

    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    Upstream {
        addr,
        captures,
        hits,
        shutdown,
        task,
    }
}

fn manifest(upstream: SocketAddr, relay: bool, handoff: bool) -> V3Config05ManifestPublished {
    manifest_with_model(upstream, relay, handoff, WIRE_MODEL)
}

fn manifest_with_model(
    upstream: SocketAddr,
    relay: bool,
    handoff: bool,
    controlled_model: &str,
) -> V3Config05ManifestPublished {
    let mut declaration = hub_v1_fixture::hub_v1_test_declaration();
    if relay {
        let direct = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
        let relay = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
        assert!(declaration.contains(direct));
        declaration = declaration.replace(direct, relay);
    }
    let execution = hub_v1_fixture::hub_v1_server_execution("a");
    let port = test_ports::free_port();
    let (controlled_options, failing_provider, first_target) = if handoff {
        (
            format!(
                r#"responses = {{ process = "chat", streaming = "client" }}
headers = {{ originator = "{CONFIGURED_ORIGINATOR}", x-client-request-id = "{CONFIGURED_REQUEST_ID}", session-id = "{CONFIGURED_SESSION_ID}" }}"#
            ),
            format!(
                r#"[providers.failing]
type = "responses"
base_url = "http://{upstream}/v1"
default_model = "{FAILING_MODEL}"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
[providers.failing.models.{FAILING_MODEL}]
wire_name = "{FAILING_MODEL}"
capabilities = ["text"]
supports_streaming = true
"#
            ),
            format!(
                r#"{{ kind = "provider_model", provider = "failing", model = "{FAILING_MODEL}", key = "key", priority = 2 }},"#
            ),
        )
    } else {
        Default::default()
    };
    let source = format!(
        r#"
version = 3
{declaration}

[servers.a]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}

[providers.controlled]
type = "responses"
base_url = "http://{upstream}/v1"
default_model = "{controlled_model}"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
{controlled_options}

[providers.controlled.models.{controlled_model}]
wire_name = "{controlled_model}"
aliases = ["{CLIENT_MODEL}"]
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

{failing_provider}

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {first_target}
  {{ kind = "provider_model", provider = "controlled", model = "{controlled_model}", key = "key", priority = 1 }},
]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn with_client_identity_headers(builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    builder
        .header("User-Agent", USER_AGENT)
        .header("Originator", ORIGINATOR)
        .header("x-client-request-id", CLIENT_REQUEST_ID)
        .header("session-id", CLIENT_SESSION_ID)
        .header("thread-id", CLIENT_THREAD_ID)
        .header("x-codex-window-id", CLIENT_WINDOW_ID)
        .header("x-codex-parent-thread-id", CLIENT_PARENT_THREAD_ID)
        .header("x-openai-subagent", CLIENT_SUBAGENT)
}

#[tokio::test]
async fn responses_public_entry_forwards_client_identity_headers_without_client_credentials() {
    verify_identity_headers(false).await;
}

#[tokio::test]
async fn responses_relay_public_entry_forwards_client_identity_headers_without_client_credentials()
{
    verify_identity_headers(true).await;
}

async fn verify_identity_headers(relay: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new();
    std::env::set_var(PROVIDER_KEY_ENV, "provider-secret");

    let mut upstream = start_upstream().await;
    let handle = spawn_v3_server_aggregate(manifest(upstream.addr, relay, false))
        .await
        .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);

    let response = client
        .post(&endpoint)
        .header("User-Agent", USER_AGENT)
        .header("Originator", ORIGINATOR)
        .header("x-client-request-id", CLIENT_REQUEST_ID)
        .header("session-id", CLIENT_SESSION_ID)
        .header("thread-id", CLIENT_THREAD_ID)
        .header("x-codex-window-id", CLIENT_WINDOW_ID)
        .header("x-codex-parent-thread-id", CLIENT_PARENT_THREAD_ID)
        .header("x-openai-subagent", CLIENT_SUBAGENT)
        .header("Authorization", CLIENT_AUTHORIZATION)
        .header("Cookie", "client_cookie=fixture-value")
        .header("x-codex-installation-id", "installation-fixture")
        .header(
            "x-codex-turn-metadata",
            r#"{"workspaces":{"/private/workspace":{}}}"#,
        )
        .header("x-codex-turn-state", "upstream-turn-state-fixture")
        .header("x-codex-attestation", "client-attestation-fixture")
        .header("x-codex-beta-features", "responses-experimental")
        .header("x-routecodex-workdir", "/private/workspace")
        .header("Upgrade", "h2c")
        .header("Sec-WebSocket-Protocol", "responses-websocket-v2")
        .json(&json!({
            "model": CLIENT_MODEL,
            "stream": false,
            "input": [{
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "Reply with the controlled response."
                }]
            }]
        }))
        .send()
        .await
        .expect("public Responses request must complete");
    assert_eq!(response.status(), reqwest::StatusCode::OK);

    let capture = tokio::time::timeout(Duration::from_secs(10), upstream.captures.recv())
        .await
        .expect("provider attempt must reach the controlled upstream")
        .expect("controlled upstream must capture the provider request");

    for (name, expected) in [
        ("user-agent", USER_AGENT),
        ("originator", ORIGINATOR),
        ("x-client-request-id", CLIENT_REQUEST_ID),
        ("session-id", CLIENT_SESSION_ID),
        ("thread-id", CLIENT_THREAD_ID),
        ("x-codex-window-id", CLIENT_WINDOW_ID),
        ("x-codex-parent-thread-id", CLIENT_PARENT_THREAD_ID),
        ("x-openai-subagent", CLIENT_SUBAGENT),
    ] {
        assert_eq!(
            header_text(&capture.headers, name).as_deref(),
            Some(expected)
        );
    }
    for name in [
        "cookie",
        "x-codex-installation-id",
        "x-codex-turn-metadata",
        "x-codex-turn-state",
        "x-codex-attestation",
        "x-codex-beta-features",
        "x-routecodex-workdir",
        "upgrade",
        "sec-websocket-protocol",
    ] {
        assert_eq!(header_text(&capture.headers, name), None, "{name}");
    }
    assert_eq!(
        capture.authorization.as_deref(),
        Some(PROVIDER_AUTHORIZATION)
    );
    assert_ne!(capture.authorization.as_deref(), Some(CLIENT_AUTHORIZATION));
    assert_eq!(capture.body["model"], WIRE_MODEL);

    let response = client
        .post(&endpoint)
        .header("User-Agent", "ordinary-client/1")
        .header("Connection", "Originator, Session-Id")
        .header("Originator", "hop-local-client")
        .header("Session-Id", "hop-local-session")
        .json(&json!({"model": CLIENT_MODEL, "stream": false, "input": "hello"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let capture = tokio::time::timeout(Duration::from_secs(10), upstream.captures.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(capture.user_agent.as_deref(), Some("ordinary-client/1"));
    assert_eq!(capture.originator, None);
    assert_eq!(capture.headers.get("session-id"), None);

    let response = client
        .post(&endpoint)
        .json(&json!({"model": CLIENT_MODEL, "stream": false, "input": "hello"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let capture = tokio::time::timeout(Duration::from_secs(10), upstream.captures.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(capture.user_agent, None);
    assert_eq!(capture.originator, None);
    for name in [
        "x-client-request-id",
        "session-id",
        "thread-id",
        "x-codex-window-id",
        "x-codex-parent-thread-id",
        "x-openai-subagent",
    ] {
        assert_eq!(header_text(&capture.headers, name), None);
    }

    handle.shutdown().await;
    let _ = upstream.shutdown.send(());
}

#[tokio::test]
async fn responses_public_entry_scopes_identity_headers_to_selected_origin_across_redirects() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new();
    std::env::set_var(PROVIDER_KEY_ENV, "provider-secret");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();

    let mut same_origin_redirect =
        start_upstream_with_redirect(Some("/v1/responses?redirected=1".to_string())).await;
    let same_origin_handle = spawn_v3_server_aggregate(manifest_with_model(
        same_origin_redirect.addr,
        false,
        false,
        REDIRECT_WIRE_MODEL,
    ))
    .await
    .unwrap();
    let same_origin_endpoint = format!(
        "http://{}/v1/responses",
        same_origin_handle.listeners[0].addr
    );
    let response = with_client_identity_headers(client.post(&same_origin_endpoint))
        .json(&json!({"model": CLIENT_MODEL, "stream": false, "input": "same origin"}))
        .send()
        .await
        .expect("same-origin redirect must complete");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(same_origin_redirect.hits.load(Ordering::SeqCst), 2);
    for redirect_hop in ["initial", "redirected"] {
        let capture =
            tokio::time::timeout(Duration::from_secs(3), same_origin_redirect.captures.recv())
                .await
                .unwrap()
                .unwrap();
        for (name, expected) in [
            ("user-agent", USER_AGENT),
            ("originator", ORIGINATOR),
            ("x-client-request-id", CLIENT_REQUEST_ID),
            ("session-id", CLIENT_SESSION_ID),
            ("thread-id", CLIENT_THREAD_ID),
            ("x-codex-window-id", CLIENT_WINDOW_ID),
            ("x-codex-parent-thread-id", CLIENT_PARENT_THREAD_ID),
            ("x-openai-subagent", CLIENT_SUBAGENT),
        ] {
            assert_eq!(
                header_text(&capture.headers, name).as_deref(),
                Some(expected),
                "{redirect_hop} hop must preserve {name}"
            );
        }
    }
    same_origin_handle.shutdown().await;
    let _ = same_origin_redirect.shutdown.send(());

    let mut foreign = start_upstream().await;
    let foreign_location = format!("http://{}/v1/responses", foreign.addr);
    let mut cross_origin_redirect = start_upstream_with_redirect(Some(foreign_location)).await;
    let cross_origin_handle = spawn_v3_server_aggregate(manifest_with_model(
        cross_origin_redirect.addr,
        false,
        false,
        REDIRECT_WIRE_MODEL,
    ))
    .await
    .unwrap();
    let cross_origin_endpoint = format!(
        "http://{}/v1/responses",
        cross_origin_handle.listeners[0].addr
    );

    let ordinary = client
        .post(&cross_origin_endpoint)
        .json(&json!({"model": CLIENT_MODEL, "stream": false, "input": "ordinary"}))
        .send()
        .await
        .expect("ordinary request must preserve the existing cross-origin redirect policy");
    assert_eq!(ordinary.status(), reqwest::StatusCode::OK);
    let ordinary_capture = tokio::time::timeout(Duration::from_secs(3), foreign.captures.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ordinary_capture.body["model"], REDIRECT_WIRE_MODEL);
    let ordinary_selected = tokio::time::timeout(
        Duration::from_secs(3),
        cross_origin_redirect.captures.recv(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(ordinary_selected.user_agent, None);
    assert_eq!(foreign.hits.load(Ordering::SeqCst), 1);

    let identity_result = with_client_identity_headers(client.post(&cross_origin_endpoint))
        .json(&json!({"model": CLIENT_MODEL, "stream": false, "input": "cross origin"}))
        .send()
        .await;
    if let Ok(response) = identity_result {
        assert!(
            !response.status().is_success(),
            "a redirect outside the selected identity origin must not produce a successful response"
        );
    }
    let selected_capture = tokio::time::timeout(
        Duration::from_secs(3),
        cross_origin_redirect.captures.recv(),
    )
    .await
    .unwrap()
    .unwrap();
    for (name, expected) in [
        ("user-agent", USER_AGENT),
        ("originator", ORIGINATOR),
        ("x-client-request-id", CLIENT_REQUEST_ID),
        ("session-id", CLIENT_SESSION_ID),
        ("thread-id", CLIENT_THREAD_ID),
        ("x-codex-window-id", CLIENT_WINDOW_ID),
        ("x-codex-parent-thread-id", CLIENT_PARENT_THREAD_ID),
        ("x-openai-subagent", CLIENT_SUBAGENT),
    ] {
        assert_eq!(
            header_text(&selected_capture.headers, name).as_deref(),
            Some(expected),
            "selected origin must receive {name}"
        );
    }
    assert_eq!(foreign.hits.load(Ordering::SeqCst), 1);
    assert!(
        foreign.captures.try_recv().is_err(),
        "foreign origin received a redirected identity request"
    );

    cross_origin_handle.shutdown().await;
    let _ = cross_origin_redirect.shutdown.send(());
    let _ = foreign.shutdown.send(());
}

#[tokio::test]
async fn responses_reselection_preserves_identity_across_direct_to_relay_handoff() {
    let _guard = TEST_LOCK.lock().await;
    let home = TestHomeGuard::new();
    std::env::set_var(PROVIDER_KEY_ENV, "provider-secret");
    let mut upstream = start_upstream().await;
    let handle = spawn_v3_server_aggregate(manifest(upstream.addr, false, true))
        .await
        .unwrap();
    let addr = handle.listeners[0].addr;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap()
        .post(format!("http://{addr}/v1/responses"))
        .header("User-Agent", USER_AGENT)
        .header("Originator", ORIGINATOR)
        .header("x-client-request-id", CLIENT_REQUEST_ID)
        .header("session-id", CLIENT_SESSION_ID)
        .header("thread-id", CLIENT_THREAD_ID)
        .header("x-codex-window-id", CLIENT_WINDOW_ID)
        .header("x-codex-parent-thread-id", CLIENT_PARENT_THREAD_ID)
        .header("x-openai-subagent", CLIENT_SUBAGENT)
        .header("Authorization", CLIENT_AUTHORIZATION)
        .json(&json!({"model": CLIENT_MODEL, "stream": false, "input": "hello"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["status"], "completed");
    for (model, originator, request_id, session_id) in [
        (
            FAILING_MODEL,
            ORIGINATOR,
            CLIENT_REQUEST_ID,
            CLIENT_SESSION_ID,
        ),
        (
            WIRE_MODEL,
            CONFIGURED_ORIGINATOR,
            CONFIGURED_REQUEST_ID,
            CONFIGURED_SESSION_ID,
        ),
    ] {
        let capture = tokio::time::timeout(Duration::from_secs(3), upstream.captures.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(capture.body["model"], model);
        assert_eq!(capture.user_agent.as_deref(), Some(USER_AGENT));
        assert_eq!(capture.originator.as_deref(), Some(originator));
        assert_eq!(
            header_text(&capture.headers, "x-client-request-id").as_deref(),
            Some(request_id)
        );
        assert_eq!(
            header_text(&capture.headers, "session-id").as_deref(),
            Some(session_id)
        );
        assert_eq!(
            header_text(&capture.headers, "thread-id").as_deref(),
            Some(CLIENT_THREAD_ID)
        );
        assert_eq!(
            header_text(&capture.headers, "x-codex-window-id").as_deref(),
            Some(CLIENT_WINDOW_ID)
        );
        assert_eq!(
            header_text(&capture.headers, "x-codex-parent-thread-id").as_deref(),
            Some(CLIENT_PARENT_THREAD_ID)
        );
        assert_eq!(
            header_text(&capture.headers, "x-openai-subagent").as_deref(),
            Some(CLIENT_SUBAGENT)
        );
        assert_eq!(
            capture.authorization.as_deref(),
            Some(PROVIDER_AUTHORIZATION)
        );
    }
    handle.shutdown().await;
    let records = std::fs::read_to_string(home.path.join(format!(
        ".rcc/logs/server-v3-{}.request-records.jsonl",
        addr.port()
    )))
    .unwrap();
    let observed = records
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok());
    assert!(
        observed.into_iter().any(|entry| {
            entry["row"]["event_type"] == "request.completed"
                && entry["row"]["meta"]["wire_model"] == WIRE_MODEL
                && entry["row"]["meta"]["execution_mode"] == "relay"
        }),
        "success must be observed on the Relay candidate"
    );
    let _ = upstream.shutdown.send(());
}

#[tokio::test]
async fn issue1f60200_direct_dry_run_captures_client_identity_without_send() {
    verify_dry_run_client_identity(false).await;
}

#[tokio::test]
async fn issue1f60200_relay_dry_run_captures_client_identity_without_send() {
    verify_dry_run_client_identity(true).await;
}

async fn verify_dry_run_client_identity(relay: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new();
    std::env::set_var(PROVIDER_KEY_ENV, "provider-secret");
    let mut upstream = start_upstream().await;
    let mut manifest = manifest(upstream.addr, relay, false);
    manifest.debug.dry_run = true;
    manifest.debug.snapshots = true;
    if relay {
        let options = serde_json::from_value(json!({"process":"chat","streaming":"client"}))
            .expect("valid fixture Responses options");
        let provider = manifest.providers.get_mut("controlled").unwrap();
        provider.responses = Some(options);
        provider.interfaces.get_mut("default").unwrap().responses = provider.responses.clone();
        provider
            .headers
            .insert("originator".to_string(), CONFIGURED_ORIGINATOR.to_string());
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .pool_max_idle_per_host(0)
        .build()
        .unwrap();
    let payload = json!({"model": CLIENT_MODEL, "stream": false, "input": "identity preview"});
    let mut captures = Vec::new();
    for exclude_client_headers in [false, true] {
        let mut request = client
            .post(&endpoint)
            .header("x-routecodex-dry-run", "provider-request")
            .header("User-Agent", USER_AGENT)
            .header("Originator", ORIGINATOR)
            .header("Authorization", CLIENT_AUTHORIZATION)
            .header("Cookie", "client_cookie=fixture-value")
            .json(&payload);
        if exclude_client_headers {
            request = request.header("Connection", "oRiGiNaToR, uSeR-aGeNt");
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let preview: Value = response.json().await.unwrap();
        captures.push((exclude_client_headers, status, preview));
    }
    let upstream_dry_run_capture =
        tokio::time::timeout(Duration::from_millis(150), upstream.captures.recv()).await;
    let live = client
        .post(&endpoint)
        .header("User-Agent", USER_AGENT)
        .header("Originator", ORIGINATOR)
        .header("Authorization", CLIENT_AUTHORIZATION)
        .json(&payload)
        .send()
        .await
        .unwrap();
    let live_status = live.status();
    let live_body: Value = live.json().await.unwrap();
    let live_capture = tokio::time::timeout(Duration::from_secs(3), upstream.captures.recv()).await;

    handle.shutdown().await;
    let _ = upstream.shutdown.send(());
    upstream.task.await.unwrap();
    std::env::remove_var(PROVIDER_KEY_ENV);

    assert!(
        upstream_dry_run_capture.is_err() && upstream.captures.try_recv().is_err(),
        "dry-run must send zero Provider requests"
    );
    for (exclude_client_headers, status, preview) in captures {
        assert_eq!(status, reqwest::StatusCode::OK, "{preview}");
        assert_eq!(preview["kind"], "provider_request");
        assert_eq!(preview["evidence"]["providerNetworkSend"], false);
        assert_eq!(preview["providerRequest"]["body"]["model"], WIRE_MODEL);
        let nodes = preview["dry_run"]["node_ids"].as_array().unwrap();
        assert_eq!(
            nodes.contains(&json!("V3HubReqChatProcess04Governed")),
            relay,
            "{nodes:?}"
        );
        assert_eq!(nodes.contains(&json!("V3ResponsesDirect11Policy")), !relay);
        let headers = &preview["providerRequest"]["headers"];
        if exclude_client_headers {
            assert!(headers.get("user-agent").is_none(), "{headers}");
        } else {
            assert_eq!(headers["user-agent"], "[REDACTED]", "{headers}");
        }
        if exclude_client_headers && !relay {
            assert!(headers.get("originator").is_none(), "{headers}");
        } else {
            assert_eq!(headers["originator"], "[REDACTED]", "{headers}");
        }
        assert!(headers.get("authorization").is_none(), "{headers}");
        assert!(headers.get("cookie").is_none(), "{headers}");
        let preview = preview.to_string();
        assert!(!preview.contains("fixture-value"));
        assert!(!preview.contains(CLIENT_AUTHORIZATION));
        assert!(!preview.contains(ORIGINATOR));
        assert!(!preview.contains(CONFIGURED_ORIGINATOR));
    }
    assert_eq!(live_status, reqwest::StatusCode::OK, "{live_body}");
    assert_eq!(live_body["status"], "completed");
    let live_capture = live_capture.unwrap().unwrap();
    assert_eq!(live_capture.user_agent.as_deref(), Some(USER_AGENT));
    assert_eq!(
        live_capture.originator.as_deref(),
        Some(if relay {
            CONFIGURED_ORIGINATOR
        } else {
            ORIGINATOR
        })
    );
    assert_eq!(
        live_capture.authorization.as_deref(),
        Some(PROVIDER_AUTHORIZATION)
    );
}
