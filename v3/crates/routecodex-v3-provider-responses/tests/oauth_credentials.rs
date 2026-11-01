//! Real-transport black-box acceptance for Codex OAuth credential resolution.
//!
//! The provider transport is the public entry: a request built from an OAuth
//! secret handle reaches a loopback model endpoint that checks the bearer
//! header, and the refresh runs against a loopback token endpoint. Nothing is
//! mocked below the transport boundary.

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use routecodex_v3_config::V3ResponsesTransportKind;
use routecodex_v3_oauth::{V3OAuthDeclaration, V3OAuthSource, V3OAuthStore};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    build_v3_transport_13_responses_http_request_from_v3_provider_12, ReqwestResponsesTransport,
    ResponsesTransport, V3ProviderAuthHandle, V3ProviderAuthSecretHandle,
    V3ResponsesProviderTarget,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone)]
struct TokenState {
    status: u16,
    access_token: String,
    refresh_token: String,
    delay: Option<std::time::Duration>,
    calls: Arc<AtomicUsize>,
    bodies: Arc<Mutex<Vec<Value>>>,
}

async fn token_endpoint(
    State(state): State<TokenState>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.calls.fetch_add(1, Ordering::SeqCst);
    state.bodies.lock().unwrap().push(body);
    if let Some(delay) = state.delay {
        tokio::time::sleep(delay).await;
    }
    if state.status != 200 {
        return Response::builder()
            .status(StatusCode::from_u16(state.status).unwrap())
            .header("content-type", "application/json")
            .body(Body::from("{\"error\":\"rejected\"}"))
            .unwrap();
    }
    let payload = json!({
        "access_token": state.access_token,
        "refresh_token": state.refresh_token,
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap()
}

#[derive(Debug)]
struct Capture {
    authorization: Option<String>,
    body: Value,
}

#[derive(Clone)]
struct ModelState {
    captures: mpsc::UnboundedSender<Capture>,
    delay: Option<std::time::Duration>,
}

async fn model_endpoint(
    State(state): State<Arc<ModelState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    if let Some(delay) = state.delay {
        tokio::time::sleep(delay).await;
    }
    state
        .captures
        .send(Capture {
            authorization: headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            body,
        })
        .unwrap();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from("{\"id\":\"resp_oauth\",\"output_text\":\"ok\"}"))
        .unwrap()
}

struct Harness {
    token_base: String,
    model_base: String,
    captures: mpsc::UnboundedReceiver<Capture>,
    token_state: TokenState,
    _shutdowns: Vec<oneshot::Sender<()>>,
}

async fn start_harness(token_status: u16, access_token: String) -> Harness {
    start_harness_with_delay(None, token_status, None, access_token).await
}

async fn start_harness_with_delay(
    delay: Option<std::time::Duration>,
    token_status: u16,
    model_delay: Option<std::time::Duration>,
    access_token: String,
) -> Harness {
    let token_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token_address = token_listener.local_addr().unwrap();
    let token_state = TokenState {
        status: token_status,
        access_token,
        refresh_token: "rotated-refresh".to_string(),
        delay,
        calls: Arc::new(AtomicUsize::new(0)),
        bodies: Arc::new(Mutex::new(Vec::new())),
    };
    let (token_shutdown_tx, token_shutdown_rx) = oneshot::channel();
    let token_app = Router::new()
        .route("/refresh", post(token_endpoint))
        .with_state(token_state.clone());
    tokio::spawn(async move {
        axum::serve(token_listener, token_app)
            .with_graceful_shutdown(async move {
                let _ = token_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let model_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let model_address = model_listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (model_shutdown_tx, model_shutdown_rx) = oneshot::channel();
    let model_app = Router::new()
        .route("/v1/responses", post(model_endpoint))
        .with_state(Arc::new(ModelState {
            captures: captures_tx,
            delay: model_delay,
        }));
    tokio::spawn(async move {
        axum::serve(model_listener, model_app)
            .with_graceful_shutdown(async move {
                let _ = model_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    Harness {
        token_base: format!("http://{token_address}"),
        model_base: format!("http://{model_address}/v1"),
        captures: captures_rx,
        token_state,
        _shutdowns: vec![token_shutdown_tx, model_shutdown_tx],
    }
}

fn fake_jwt(exp: i64) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#);
    let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#).as_bytes());
    format!("{header}.{payload}.signature")
}

fn write_source(dir: &tempfile::TempDir) -> std::path::PathBuf {
    let path = dir.path().join("auth.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "access_token": "stale-access",
                "refresh_token": "refresh-one",
                "expires_at": 0,
            }
        }))
        .unwrap(),
    )
    .unwrap();
    path
}

fn target(base_url: &str, declaration: V3OAuthDeclaration) -> V3ResponsesProviderTarget {
    V3ResponsesProviderTarget {
        provider_id: "oauth-relay".to_string(),
        provider_type: "responses".to_string(),
        interface_id: "default".to_string(),
        base_url: base_url.to_string(),
        canonical_model_id: "gpt-oauth".to_string(),
        wire_model: "gpt-oauth".to_string(),
        compatibility_profile: None,
        headers: Default::default(),
        auth: V3ProviderAuthHandle {
            alias: "oauth-primary".to_string(),
            secret: V3ProviderAuthSecretHandle::OAuth(declaration),
        },
        responses_transport: V3ResponsesTransportKind::Http,
        websocket_v2_url: None,
        provider_request_cleanup: Default::default(),
        request_timeout_ms: 300_000,
        sse_first_frame_timeout_ms: None,
        initial_concurrency_budget: 8,
        concurrency_acquire_timeout_ms: 60_000,
    }
}

#[tokio::test]
async fn oauth_refresh_reaches_model_endpoint_with_new_bearer_and_leaves_source_untouched() {
    let refreshed = fake_jwt(4_000_000_000);
    let mut harness = start_harness(200, refreshed.clone()).await;
    let dir = tempfile::tempdir().unwrap();
    let source = write_source(&dir);
    let before = std::fs::read(&source).unwrap();
    let store = dir.path().join("oauth-store.json");
    let declaration = V3OAuthDeclaration {
        oauth_source: V3OAuthSource::CodexAuthJson {
            path: source.display().to_string(),
        },
        refresh_endpoint: format!("{}/refresh", harness.token_base),
        client_id: "client-id".to_string(),
        refresh_before_seconds: 300,
        oauth_store: V3OAuthStore::File {
            path: store.display().to_string(),
        },
    };

    let transport = ReqwestResponsesTransport::default();
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-oauth",
        target(&harness.model_base, declaration),
        json!({"model":"gpt-oauth","input":"hello"}),
    )
    .unwrap();
    // The declaration and the resolved token never leak into the wire payload.
    let wire_debug = format!("{wire:?}");
    assert!(!wire_debug.contains("refresh-one"));
    assert!(!wire_debug.contains(&refreshed));
    let request = build_v3_transport_13_responses_http_request_from_v3_provider_12(wire).unwrap();
    let request_debug = format!("{request:?}");
    assert!(!request_debug.contains(&refreshed));

    let raw = transport.send(request).await.unwrap();
    assert_eq!(raw.status(), 200);

    let capture = harness.captures.recv().await.unwrap();
    assert_eq!(
        capture.authorization.as_deref(),
        Some(format!("Bearer {refreshed}").as_str())
    );
    assert_eq!(capture.body["model"], "gpt-oauth");
    assert_eq!(harness.token_state.calls.load(Ordering::SeqCst), 1);
    let refresh_body = harness.token_state.bodies.lock().unwrap()[0].clone();
    assert_eq!(refresh_body["grant_type"], "refresh_token");
    assert_eq!(refresh_body["client_id"], "client-id");
    assert_eq!(refresh_body["refresh_token"], "refresh-one");
    assert!(refresh_body["scope"]
        .as_str()
        .unwrap()
        .contains("offline_access"));

    // The Codex source is read-only.
    assert_eq!(std::fs::read(&source).unwrap(), before);
}

#[tokio::test]
async fn oauth_refresh_failure_is_typed_and_never_calls_the_model_endpoint() {
    let mut harness = start_harness(401, fake_jwt(4_000_000_000)).await;
    let dir = tempfile::tempdir().unwrap();
    let source = write_source(&dir);
    let declaration = V3OAuthDeclaration {
        oauth_source: V3OAuthSource::CodexAuthJson {
            path: source.display().to_string(),
        },
        refresh_endpoint: format!("{}/refresh", harness.token_base),
        client_id: "client-id".to_string(),
        refresh_before_seconds: 300,
        oauth_store: V3OAuthStore::Memory,
    };

    let transport = ReqwestResponsesTransport::default();
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-oauth-fail",
        target(&harness.model_base, declaration),
        json!({"model":"gpt-oauth","input":"hello"}),
    )
    .unwrap();
    let request = build_v3_transport_13_responses_http_request_from_v3_provider_12(wire).unwrap();

    let error = transport.send(request).await.unwrap_err();
    let message = format!("{error:?}");
    assert!(
        message.contains("OAuthCredential") || message.contains("RefreshRejected"),
        "expected a typed OAuth credential error, got: {message}"
    );
    assert!(!message.contains("refresh-one"));
    assert_eq!(harness.token_state.calls.load(Ordering::SeqCst), 1);
    // No model request was attempted because resolution failed first.
    assert!(harness.captures.try_recv().is_err());
}

#[tokio::test]
async fn oauth_refresh_timeout_is_bounded_by_the_request_budget() {
    // The token endpoint outlives the request budget. A refresh that ignored the
    // budget would hold this request for the full delay.
    let mut harness = start_harness_with_delay(
        Some(std::time::Duration::from_secs(30)),
        200,
        None,
        fake_jwt(4_000_000_000),
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let source = write_source(&dir);
    let declaration = V3OAuthDeclaration {
        oauth_source: V3OAuthSource::CodexAuthJson {
            path: source.display().to_string(),
        },
        refresh_endpoint: format!("{}/refresh", harness.token_base),
        client_id: "client-id".to_string(),
        refresh_before_seconds: 300,
        oauth_store: V3OAuthStore::Memory,
    };

    let mut provider_target = target(&harness.model_base, declaration);
    provider_target.request_timeout_ms = 5_000;
    let transport = ReqwestResponsesTransport::default();
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-oauth-budget",
        provider_target,
        json!({"model":"gpt-oauth","input":"hello"}),
    )
    .unwrap();
    let request = build_v3_transport_13_responses_http_request_from_v3_provider_12(wire).unwrap();

    let started = std::time::Instant::now();
    let error = transport.send(request).await.unwrap_err();
    assert!(
        started.elapsed() < std::time::Duration::from_secs(20),
        "refresh must not outlive the request budget, took {:?}",
        started.elapsed()
    );
    assert!(
        format!("{error:?}").contains("OAuthCredential"),
        "expected a typed OAuth credential error, got: {error:?}"
    );
    assert!(harness.captures.try_recv().is_err());
}

#[tokio::test]
async fn oauth_refresh_and_model_response_share_the_request_budget() {
    // Refresh succeeds first and consumes most of the request budget. The model
    // endpoint then outlives only the remaining budget.
    let mut harness = start_harness_with_delay(
        Some(std::time::Duration::from_millis(1_000)),
        200,
        Some(std::time::Duration::from_millis(250)),
        fake_jwt(4_000_000_000),
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let source = write_source(&dir);
    let declaration = V3OAuthDeclaration {
        oauth_source: V3OAuthSource::CodexAuthJson {
            path: source.display().to_string(),
        },
        refresh_endpoint: format!("{}/refresh", harness.token_base),
        client_id: "client-id".to_string(),
        refresh_before_seconds: 300,
        oauth_store: V3OAuthStore::Memory,
    };

    let mut provider_target = target(&harness.model_base, declaration);
    provider_target.request_timeout_ms = 1_200;
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-oauth-shared-budget",
        provider_target,
        json!({"model": "gpt-oauth", "input": "shared-budget"}),
    )
    .unwrap();
    let request = build_v3_transport_13_responses_http_request_from_v3_provider_12(wire).unwrap();

    let started = std::time::Instant::now();
    let error = ReqwestResponsesTransport::default()
        .send(request)
        .await
        .unwrap_err();
    let elapsed = started.elapsed();

    assert!(
        elapsed <= std::time::Duration::from_millis(1_600),
        "shared budget must not grant a fresh model timeout, took {elapsed:?}"
    );
    assert!(
        elapsed >= std::time::Duration::from_millis(1_000),
        "refresh must consume its portion of the shared budget before the model request, took {elapsed:?}"
    );
    assert!(
        format!("{error:?}").contains("Transport") || format!("{error:?}").contains("timeout"),
        "the exhausted model response must fail as a transport timeout, got: {error:?}"
    );
    assert_eq!(harness.token_state.calls.load(Ordering::SeqCst), 1);
    assert!(harness.captures.try_recv().is_err());
}

#[tokio::test]
async fn oauth_refresh_wait_is_bounded_when_the_identity_lock_is_held() {
    let mut harness = start_harness_with_delay(
        Some(std::time::Duration::from_millis(1_500)),
        200,
        None,
        fake_jwt(4_000_000_000),
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let source = write_source(&dir);
    let declaration = V3OAuthDeclaration {
        oauth_source: V3OAuthSource::CodexAuthJson {
            path: source.display().to_string(),
        },
        refresh_endpoint: format!("{}/refresh", harness.token_base),
        client_id: "client-id".to_string(),
        refresh_before_seconds: 300,
        oauth_store: V3OAuthStore::Memory,
    };

    let first_transport = ReqwestResponsesTransport::default();
    let first_wire = build_v3_provider_12_responses_wire_payload(
        "req-oauth-lock-first",
        target(&harness.model_base, declaration.clone()),
        json!({"model":"gpt-oauth","input":"first"}),
    )
    .unwrap();
    let first_request =
        build_v3_transport_13_responses_http_request_from_v3_provider_12(first_wire).unwrap();
    let first = tokio::spawn(async move { first_transport.send(first_request).await });
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while harness.token_state.calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the first request must enter the token endpoint and hold the identity lock");

    let mut second_target = target(&harness.model_base, declaration);
    second_target.request_timeout_ms = 300;
    let second_wire = build_v3_provider_12_responses_wire_payload(
        "req-oauth-lock-second",
        second_target,
        json!({"model":"gpt-oauth","input":"second"}),
    )
    .unwrap();
    let second_request =
        build_v3_transport_13_responses_http_request_from_v3_provider_12(second_wire).unwrap();
    let started = std::time::Instant::now();
    let error = ReqwestResponsesTransport::default()
        .send(second_request)
        .await
        .unwrap_err();

    assert!(
        started.elapsed() < std::time::Duration::from_secs(1),
        "identity-lock wait must share the request budget, took {:?}",
        started.elapsed()
    );
    assert!(matches!(
        error,
        routecodex_v3_provider_responses::V3ProviderError::OAuthCredential { .. }
    ));
    assert!(harness.captures.try_recv().is_err());

    assert_eq!(first.await.unwrap().unwrap().status(), 200);
    assert!(harness.captures.recv().await.is_some());
}

#[tokio::test]
async fn oauth_refresh_wait_is_cancelled_without_waiting_for_the_budget() {
    let mut harness = start_harness_with_delay(
        Some(std::time::Duration::from_millis(1_500)),
        200,
        None,
        fake_jwt(4_000_000_000),
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let source = write_source(&dir);
    let declaration = V3OAuthDeclaration {
        oauth_source: V3OAuthSource::CodexAuthJson {
            path: source.display().to_string(),
        },
        refresh_endpoint: format!("{}/refresh", harness.token_base),
        client_id: "client-id".to_string(),
        refresh_before_seconds: 300,
        oauth_store: V3OAuthStore::Memory,
    };

    let first_transport = ReqwestResponsesTransport::default();
    let first_wire = build_v3_provider_12_responses_wire_payload(
        "req-oauth-cancel-first",
        target(&harness.model_base, declaration.clone()),
        json!({"model":"gpt-oauth","input":"first"}),
    )
    .unwrap();
    let first_request =
        build_v3_transport_13_responses_http_request_from_v3_provider_12(first_wire).unwrap();
    let first = tokio::spawn(async move { first_transport.send(first_request).await });
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while harness.token_state.calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the first request must enter the token endpoint and hold the identity lock");

    let mut second_target = target(&harness.model_base, declaration);
    second_target.request_timeout_ms = 10_000;
    let second_wire = build_v3_provider_12_responses_wire_payload(
        "req-oauth-cancel-second",
        second_target,
        json!({"model":"gpt-oauth","input":"second"}),
    )
    .unwrap();
    let cancellation = routecodex_v3_provider_responses::V3ProviderCancellation::new();
    let second_request =
        build_v3_transport_13_responses_http_request_from_v3_provider_12(second_wire)
            .unwrap()
            .with_cancellation(cancellation.clone());
    let started = std::time::Instant::now();
    let second = tokio::spawn(async move {
        ReqwestResponsesTransport::default()
            .send(second_request)
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    cancellation.cancel();

    let error = second.await.unwrap().unwrap_err();
    assert!(
        started.elapsed() < std::time::Duration::from_secs(1),
        "cancellation must not wait for the refresh budget, took {:?}",
        started.elapsed()
    );
    assert!(
        matches!(
            error,
            routecodex_v3_provider_responses::V3ProviderError::ClientDisconnect { .. }
        ),
        "expected ClientDisconnect, got {error:?}"
    );
    assert!(harness.captures.try_recv().is_err());

    assert_eq!(first.await.unwrap().unwrap().status(), 200);
    assert!(harness.captures.recv().await.is_some());
}
