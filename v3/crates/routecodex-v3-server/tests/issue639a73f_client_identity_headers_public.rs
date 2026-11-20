//! Public-entry red test for forwarding client identity headers to Responses.
//!
//! The request uses the real `/v1/responses` server entry and a controlled
//! local Responses provider. The provider must receive the request's exact
//! `User-Agent` and `Originator`, while the client `Authorization` must not
//! replace the provider's configured credential.

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{ffi::OsString, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const PROVIDER_KEY_ENV: &str = "V3_ISSUE_639A73F_PROVIDER_KEY";
const CLIENT_MODEL: &str = "identity-client-model";
const WIRE_MODEL: &str = "identity-wire-model";
const USER_AGENT: &str = "codex-tui/0.1.0";
const ORIGINATOR: &str = "codex-tui";
const CLIENT_AUTHORIZATION: &str = "Bearer client-secret";
const PROVIDER_AUTHORIZATION: &str = "Bearer provider-secret";

struct TestHomeGuard {
    previous: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new() -> Self {
        let path = PathBuf::from("/private/tmp").join(format!(
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
    user_agent: Option<String>,
    originator: Option<String>,
    authorization: Option<String>,
    body: Value,
}

#[derive(Clone)]
struct ProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

async fn controlled_responses_upstream(
    State(state): State<Arc<ProviderState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture {
            user_agent: header_text(&headers, "user-agent"),
            originator: header_text(&headers, "originator"),
            authorization: header_text(&headers, "authorization"),
            body,
        })
        .unwrap();

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
    shutdown: oneshot::Sender<()>,
}

async fn start_upstream() -> Upstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (captures_tx, captures) = mpsc::unbounded_channel();
    let (shutdown, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(controlled_responses_upstream))
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));

    tokio::spawn(async move {
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
        shutdown,
    }
}

fn manifest(upstream: SocketAddr, relay: bool) -> V3Config05ManifestPublished {
    let mut declaration = hub_v1_fixture::hub_v1_test_declaration();
    if relay {
        let direct = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
        let relay = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
        assert!(declaration.contains(direct));
        declaration = declaration.replace(direct, relay);
    }
    let execution = hub_v1_fixture::hub_v1_server_execution("a");
    let port = test_ports::free_port();
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
default_model = "{WIRE_MODEL}"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}

[providers.controlled.models.{WIRE_MODEL}]
wire_name = "{WIRE_MODEL}"
aliases = ["{CLIENT_MODEL}"]
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "controlled", model = "{WIRE_MODEL}", key = "key", priority = 1 }},
]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
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
    let handle = spawn_v3_server_aggregate(manifest(upstream.addr, relay))
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
        .header("Authorization", CLIENT_AUTHORIZATION)
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

    assert_eq!(capture.user_agent.as_deref(), Some(USER_AGENT));
    assert_eq!(capture.originator.as_deref(), Some(ORIGINATOR));
    assert_eq!(
        capture.authorization.as_deref(),
        Some(PROVIDER_AUTHORIZATION)
    );
    assert_ne!(capture.authorization.as_deref(), Some(CLIENT_AUTHORIZATION));
    assert_eq!(capture.body["model"], WIRE_MODEL);

    let response = client
        .post(&endpoint)
        .header("User-Agent", "ordinary-client/1")
        .header("Connection", "Originator")
        .header("Originator", "hop-local-client")
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

    handle.shutdown().await;
    let _ = upstream.shutdown.send(());
}
