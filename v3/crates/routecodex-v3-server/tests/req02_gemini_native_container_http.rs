//! REQ02 Gemini native-container HTTP contract.
//!
//! Relay is the implemented Gemini HTTP path. The two Relay cases assert the
//! complete native request shape and the controlled success response.
//!
//! The two unsupported-Direct cases are negative declarations. They force the
//! Direct execution-mode branch at the public HTTP entry so the fixture can
//! prove that no provider attempt, Relay fallback, HTTP error response, or
//! fabricated success crosses the client boundary.

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
use std::{net::TcpListener, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use test_ports::free_port;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const GEMINI_RELAY_BINDING: &str = r#"{ entry_protocol = "gemini", endpoint_patterns = ["/v1beta/models/:model/generateContent"], execution_mode = "relay", protocol_profile_owner = "v3.gemini_relay_runtime_integration", implemented = true, forbidden_reentry_behavior = "Gemini endpoint must not fall through to pending or direct runtime.", runtime_owner_symbol = "execute_v3_gemini_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs" }"#;

// Test-only negative declaration. The current runtime has no Gemini Direct
// owner. The sentinel runtime-owner values satisfy the authoring schema only;
// the fixture uses this binding to force the unsupported Direct branch.
const GEMINI_DIRECT_NEGATIVE_BINDING: &str = r#"{ entry_protocol = "gemini", endpoint_patterns = ["/v1beta/models/:model/generateContent"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Test-only negative declaration: Gemini Direct must not silently reach Relay, pending, or a provider.", runtime_owner_symbol = "test_only_gemini_direct_negative_declaration", runtime_owner_path = "v3/crates/routecodex-v3-server/tests/req02_gemini_native_container_http.rs" }"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExecutionMode {
    Relay,
    Direct,
}

impl ExecutionMode {
    fn label(self) -> &'static str {
        match self {
            Self::Relay => "relay",
            Self::Direct => "unsupported_direct",
        }
    }
}

#[derive(Debug)]
struct ProviderCapture {
    path: String,
    body: Value,
}

#[derive(Clone)]
struct ProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

enum ClientObservation {
    Completed {
        status: StatusCode,
        body: Result<Value, String>,
    },
    HeadersReceivedBodyError {
        status: StatusCode,
        error: String,
    },
    TransportError {
        error: String,
        timeout: bool,
    },
}

struct CaseObservation {
    client: ClientObservation,
    capture: Option<ProviderCapture>,
    entry_execution_modes: Vec<String>,
    server_port: u16,
    upstream_port: u16,
    server_port_released: bool,
    upstream_port_released: bool,
}

async fn controlled_gemini_upstream(
    State(state): State<Arc<ProviderState>>,
    _headers: HeaderMap,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    if uri.path() != "/v1beta/models/gemini-wire:generateContent" {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    }

    state
        .captures
        .send(ProviderCapture {
            path: uri.path().to_string(),
            body: body.clone(),
        })
        .unwrap();

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "candidates": [{
                    "index": 0,
                    "finishReason": "STOP",
                    "content": {
                        "role": "model",
                        "parts": [{"text": "controlled response"}]
                    }
                }],
                "usageMetadata": {
                    "promptTokenCount": 3,
                    "candidatesTokenCount": 2,
                    "totalTokenCount": 5
                }
            }))
            .unwrap(),
        ))
        .unwrap()
}

fn native_container_request(with_actual_call_id: bool) -> Value {
    let mut call = json!({
        "name": "lookup_weather",
        "args": {"city": "Paris"},
        "call_extra": "call-inner"
    });
    let mut result = json!({
        "name": "lookup_weather",
        "response": {"forecast": "sunny"},
        "result_extra": "result-inner"
    });
    if with_actual_call_id {
        call["id"] = json!("call-weather");
        result["id"] = json!("call-weather");
    }
    json!({
        "contents": [
            {
                "role": "user",
                "message_extra": "content-row",
                "parts": [
                    {"text": "lookup weather", "part_extra": "text-part"},
                    {
                        "inlineData": {
                            "mimeType": "image/png",
                            "data": "YWJj",
                            "media_extra": "media-inner"
                        },
                        "part_extra": "media-part"
                    }
                ]
            },
            {
                "role": "model",
                "message_extra": "call-row",
                "parts": [
                    {"functionCall": call, "part_extra": "call-part"}
                ]
            },
            {
                "role": "user",
                "message_extra": "result-row",
                "parts": [
                    {"functionResponse": result, "part_extra": "result-part"}
                ]
            }
        ],
        "tools": [{
            "functionDeclarations": [{
                "name": "lookup_weather",
                "parameters": {"type": "object"},
                "declaration_extra": "declaration"
            }]
        }],
        "generationConfig": {
            "temperature": 0.2,
            "config_extra": "generation"
        },
        "stream": false
    })
}

async fn run_case(mode: ExecutionMode, with_actual_call_id: bool) -> CaseObservation {
    let key = format!(
        "V3_REQ02_GEMINI_HTTP_{}_{}",
        mode.label().to_ascii_uppercase(),
        if with_actual_call_id {
            "WITH_ID"
        } else {
            "WITHOUT_ID"
        }
    );
    std::env::set_var(&key, "controlled-secret");

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = upstream.local_addr().unwrap().port();
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (upstream_shutdown_tx, upstream_shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route(
            "/v1beta/models/gemini-wire:generateContent",
            post(controlled_gemini_upstream),
        )
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    let mut upstream_task = tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = upstream_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let server_port = free_port();
    let handle = spawn_v3_server_aggregate(manifest(server_port, upstream_port, mode, &key))
        .await
        .unwrap();
    let server_addr = handle.listeners[0].addr;
    let endpoint = format!("http://{server_addr}/v1beta/models/gemini-client/generateContent");
    let request_body = native_container_request(with_actual_call_id);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let client_observation = match client
        .post(&endpoint)
        .header(
            "x-session-id",
            format!("req02-{}-{with_actual_call_id}", mode.label()),
        )
        .header(
            "x-conversation-id",
            format!("req02-{}-{with_actual_call_id}", mode.label()),
        )
        .json(&request_body)
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            match response.text().await {
                Ok(body_text) => ClientObservation::Completed {
                    status,
                    body: serde_json::from_str(&body_text)
                        .map_err(|error| format!("{error}; body={body_text}")),
                },
                Err(error) => ClientObservation::HeadersReceivedBodyError {
                    status,
                    error: error.to_string(),
                },
            }
        }
        Err(error) => ClientObservation::TransportError {
            error: error.to_string(),
            timeout: error.is_timeout(),
        },
    };

    let entry_execution_modes = match client
        .get(format!("http://{server_addr}/_routecodex/debug/logs"))
        .send()
        .await
    {
        Ok(response) => response
            .json::<Value>()
            .await
            .ok()
            .and_then(|logs| {
                logs["logs"].as_array().map(|events| {
                    events
                        .iter()
                        .filter(|event| event["node_id"] == "V3Server03HttpRequestRaw")
                        .filter_map(|event| event["details"]["execution_mode"].as_str())
                        .map(ToOwned::to_owned)
                        .collect::<Vec<_>>()
                })
            })
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    let capture = tokio::time::timeout(Duration::from_secs(2), captures_rx.recv())
        .await
        .ok()
        .flatten();

    let _ = handle.shutdown().await;
    let _ = upstream_shutdown_tx.send(());
    if tokio::time::timeout(Duration::from_secs(2), &mut upstream_task)
        .await
        .is_err()
    {
        upstream_task.abort();
        let _ = upstream_task.await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;

    let server_port_released = TcpListener::bind(("127.0.0.1", server_port)).is_ok();
    let upstream_port_released = TcpListener::bind(("127.0.0.1", upstream_port)).is_ok();
    std::env::remove_var(&key);

    CaseObservation {
        client: client_observation,
        capture,
        entry_execution_modes,
        server_port,
        upstream_port,
        server_port_released,
        upstream_port_released,
    }
}

fn assert_ports_released(observation: &CaseObservation, context: &str) {
    assert!(
        observation.server_port_released,
        "{context}: server port {} was not released",
        observation.server_port
    );
    assert!(
        observation.upstream_port_released,
        "{context}: upstream port {} was not released",
        observation.upstream_port
    );
}

async fn assert_relay_case(with_actual_call_id: bool) {
    let raw = native_container_request(with_actual_call_id);
    let observation = run_case(ExecutionMode::Relay, with_actual_call_id).await;
    let context = format!("mode=relay, with_actual_call_id={with_actual_call_id}");

    assert_ports_released(&observation, &context);

    let response_body = match observation.client {
        ClientObservation::Completed { status, body } => {
            assert!(
                status.is_success(),
                "{context}: real Gemini HTTP entry returned {status}; expected 2xx"
            );
            body.unwrap_or_else(|error| panic!("{context}: client response is not JSON: {error}"))
        }
        ClientObservation::HeadersReceivedBodyError { status, error } => {
            panic!("{context}: Relay response body failed after {status}: {error}")
        }
        ClientObservation::TransportError { error, timeout } => {
            panic!("{context}: Relay transport failed (timeout={timeout}): {error}")
        }
    };
    assert_eq!(
        response_body["candidates"][0]["content"]["parts"][0]["text"], "controlled response",
        "{context}: client response text"
    );
    assert_eq!(
        response_body["candidates"][0]["finishReason"], "STOP",
        "{context}: client response terminal semantics"
    );
    assert_eq!(
        response_body["usageMetadata"]["totalTokenCount"], 5,
        "{context}: client response usage semantics"
    );

    let capture = observation.capture.unwrap_or_else(|| {
        panic!("{context}: provider-bound request was not captured; no fallback is accepted")
    });
    assert_eq!(
        capture.path, "/v1beta/models/gemini-wire:generateContent",
        "{context}: provider wire path"
    );
    assert_eq!(
        capture.body["contents"], raw["contents"],
        "{context}: complete Gemini contents with all six native containers"
    );
    assert_eq!(
        capture.body["tools"], raw["tools"],
        "{context}: tool declaration and declaration sibling"
    );
    assert_eq!(
        capture.body["generationConfig"], raw["generationConfig"],
        "{context}: generation config and config sibling"
    );

    let call = &capture.body["contents"][1]["parts"][0]["functionCall"];
    let result = &capture.body["contents"][2]["parts"][0]["functionResponse"];
    assert_eq!(
        call["call_extra"], "call-inner",
        "{context}: functionCall sibling stays in functionCall"
    );
    assert_eq!(
        result["result_extra"], "result-inner",
        "{context}: functionResponse sibling stays in functionResponse"
    );
    assert!(
        capture.body["contents"][1]["parts"][0]
            .get("call_extra")
            .is_none(),
        "{context}: functionCall sibling leaked to the part container"
    );
    assert!(
        capture.body["contents"][2]["parts"][0]
            .get("result_extra")
            .is_none(),
        "{context}: functionResponse sibling leaked to the part container"
    );
    assert!(
        capture.body["contents"][2]["parts"][0]
            .get("name")
            .is_none(),
        "{context}: functionResponse name leaked to the part container"
    );
    assert!(
        capture.body["contents"][2]["parts"][0]
            .get("response")
            .is_none(),
        "{context}: functionResponse response leaked to the part container"
    );

    if with_actual_call_id {
        assert_eq!(call["id"], "call-weather", "{context}: functionCall ID");
        assert_eq!(
            result["id"], "call-weather",
            "{context}: functionResponse actual ID"
        );
    } else {
        assert!(
            call.get("id").is_none(),
            "{context}: functionCall ID must stay absent"
        );
        assert!(
            result.get("id").is_none(),
            "{context}: functionResponse ID must stay absent"
        );
    }
}

async fn assert_unsupported_direct_case(with_actual_call_id: bool) {
    let observation = run_case(ExecutionMode::Direct, with_actual_call_id).await;
    let context = format!("mode=unsupported_direct, with_actual_call_id={with_actual_call_id}");

    assert_ports_released(&observation, &context);
    assert!(
        observation.capture.is_none(),
        "{context}: unsupported Direct must not reach a provider"
    );
    assert!(
        !observation.entry_execution_modes.is_empty(),
        "{context}: the HTTP entry must record its binding-resolved execution mode"
    );
    assert!(
        observation
            .entry_execution_modes
            .iter()
            .all(|mode| mode == "direct"),
        "{context}: unsupported Direct must not fall through to Relay: {:?}",
        observation.entry_execution_modes
    );

    match observation.client {
        // A real transport disconnect is the expected no-response outcome.
        ClientObservation::TransportError { error, timeout } => {
            assert!(
                !timeout,
                "{context}: unsupported Direct must disconnect, not time out: {error}"
            );
            assert!(
                !error.is_empty(),
                "{context}: the transport disconnect must carry a diagnostic error"
            );
        }
        // A head may be written before the body is aborted. That is still an
        // incomplete transfer, not an HTTP error response or a fake success.
        ClientObservation::HeadersReceivedBodyError { status, error } => {
            assert!(
                !status.is_client_error() && !status.is_server_error(),
                "{context}: unsupported Direct returned HTTP error status {status}"
            );
            assert!(
                !error.is_empty(),
                "{context}: the aborted body must carry a diagnostic error"
            );
        }
        ClientObservation::Completed { status, body } => {
            panic!(
                "{context}: unsupported Direct returned a complete HTTP response: status={status}, body={body:?}"
            );
        }
    }
}

#[tokio::test]
async fn relay_http_preserves_native_containers_without_actual_call_id() {
    let _guard = TEST_LOCK.lock().await;
    assert_relay_case(false).await;
}

#[tokio::test]
async fn relay_http_preserves_native_containers_with_actual_call_id() {
    let _guard = TEST_LOCK.lock().await;
    assert_relay_case(true).await;
}

#[tokio::test]
async fn unsupported_direct_http_disconnects_without_provider_without_actual_call_id() {
    let _guard = TEST_LOCK.lock().await;
    assert_unsupported_direct_case(false).await;
}

#[tokio::test]
async fn unsupported_direct_http_disconnects_without_provider_with_actual_call_id() {
    let _guard = TEST_LOCK.lock().await;
    assert_unsupported_direct_case(true).await;
}

fn manifest(
    server_port: u16,
    upstream_port: u16,
    mode: ExecutionMode,
    key_env: &str,
) -> V3Config05ManifestPublished {
    let mut declaration = hub_v1_test_declaration();
    match mode {
        ExecutionMode::Relay => {
            assert!(
                declaration.contains(GEMINI_RELAY_BINDING),
                "fixture must declare Gemini Relay explicitly"
            );
        }
        ExecutionMode::Direct => {
            assert!(
                declaration.contains(GEMINI_RELAY_BINDING),
                "fixture must contain the Gemini binding before selecting Direct"
            );
            declaration = declaration.replace(GEMINI_RELAY_BINDING, GEMINI_DIRECT_NEGATIVE_BINDING);
            assert!(
                declaration.contains(GEMINI_DIRECT_NEGATIVE_BINDING),
                "fixture must declare the test-only Gemini Direct negative binding"
            );
        }
    }

    let source = format!(
        r#"
version = 3

{declaration}

[servers.req02_gemini_http]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req02_gemini_http"
endpoints = ["gemini"]

{server_execution}

[providers.req02_gemini_http]
type = "gemini"
base_url = "http://127.0.0.1:{upstream_port}/v1beta"
default_model = "gemini-wire"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "{key_env}" }}] }}
[providers.req02_gemini_http.models.gemini-wire]
wire_name = "gemini-wire"
aliases = ["gemini-client"]
supports_streaming = true
capabilities = ["text", "tools"]
[route_groups.req02_gemini_http.pools.gemini_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "gemini", models = ["gemini-client"] }}
targets = [{{ kind = "provider_model", provider = "req02_gemini_http", model = "gemini-wire", key = "controlled", priority = 1 }}]
[route_groups.req02_gemini_http.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "req02_gemini_http", model = "gemini-wire", key = "controlled", priority = 1 }}]
"#,
        server_execution = hub_v1_server_execution("req02_gemini_http"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}
