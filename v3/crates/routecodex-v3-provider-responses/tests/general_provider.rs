use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Router,
};
use routecodex_v3_config::V3ResponsesTransportKind;
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    build_v3_transport_13_responses_http_request_from_v3_provider_12, ReqwestResponsesTransport,
    ResponsesTransport, V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderCancellation,
    V3ProviderError, V3ProviderResponseBodyKind, V3ResponsesProviderTarget,
};
use serde_json::{json, Value};
use std::{convert::Infallible, sync::Arc};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug)]
struct Capture {
    authorization: Option<String>,
    accept: Option<String>,
    body: Value,
}

#[derive(Clone)]
struct UpstreamState {
    captures: mpsc::UnboundedSender<Capture>,
}

async fn upstream(
    State(state): State<Arc<UpstreamState>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(Capture {
            authorization: headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            accept: headers
                .get("accept")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            body: body.clone(),
        })
        .unwrap();

    match body["case"].as_str().unwrap_or("json") {
        "sse" => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream; charset=utf-8")
            .body(Body::from_stream(futures_util::stream::iter([
                Ok::<_, Infallible>("event: response.created\ndata: {\"id\":\"resp_sse\"}\n\n"),
                Ok::<_, Infallible>("data: [DONE]\n\n"),
            ])))
            .unwrap(),
        "malformed_sse" => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from("data: {\"id\":\"unterminated\"}\n"))
            .unwrap(),
        "status_401" => Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header("content-type", "application/json")
            .body(Body::from("{\"error\":\"unauthorized\"}"))
            .unwrap(),
        "status_503" => Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from("{\"error\":\"overloaded\"}"))
            .unwrap(),
        _ => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .header("x-upstream", "controlled")
            .body(Body::from("{\"id\":\"resp_json\",\"output_text\":\"ok\"}"))
            .unwrap(),
    }
}

async fn start_upstream() -> (
    String,
    mpsc::UnboundedReceiver<Capture>,
    oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .with_state(Arc::new(UpstreamState {
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
    (format!("http://{address}/v1"), captures_rx, shutdown_tx)
}

fn target(
    provider_id: &str,
    base_url: &str,
    wire_model: &str,
    auth_alias: &str,
    env_name: &str,
) -> V3ResponsesProviderTarget {
    target_with_auth(
        provider_id,
        base_url,
        wire_model,
        auth_alias,
        V3ProviderAuthSecretHandle::Environment(env_name.to_string()),
    )
}

fn target_with_auth(
    provider_id: &str,
    base_url: &str,
    wire_model: &str,
    auth_alias: &str,
    secret: V3ProviderAuthSecretHandle,
) -> V3ResponsesProviderTarget {
    V3ResponsesProviderTarget {
        provider_id: provider_id.to_string(),
        base_url: base_url.to_string(),
        canonical_model_id: wire_model.to_string(),
        wire_model: wire_model.to_string(),
        auth: V3ProviderAuthHandle {
            alias: auth_alias.to_string(),
            secret,
        },
        responses_transport: V3ResponsesTransportKind::Http,
        websocket_v2_url: None,
    }
}

#[tokio::test]
async fn one_generic_provider_serves_distinct_instances_and_preserves_wire_semantics() {
    let (base_url, mut captures, shutdown) = start_upstream().await;
    std::env::set_var("V3_GENERAL_ALPHA_KEY", "secret-alpha");
    std::env::set_var("V3_GENERAL_BETA_KEY", "secret-beta");
    let transport = ReqwestResponsesTransport::default();

    for (provider_id, auth_env, secret, wire_model) in [
        (
            "alpha-relay",
            "V3_GENERAL_ALPHA_KEY",
            "secret-alpha",
            "model-alpha",
        ),
        (
            "beta-relay",
            "V3_GENERAL_BETA_KEY",
            "secret-beta",
            "model-beta",
        ),
    ] {
        let body = json!({
            "model": "client-alias",
            "input": [{"role":"user","content":[{"type":"input_text","text":"hello"}]}],
            "tools": [{"type":"function","name":"lookup","parameters":{"type":"object"}}],
            "metadata": {"client_field":"preserve"},
            "unknown_extension": {"nested":[1,2,3]},
            "case": "json"
        });
        let wire = build_v3_provider_12_responses_wire_payload(
            format!("req-{provider_id}"),
            target(provider_id, &base_url, wire_model, "primary", auth_env),
            body,
        )
        .unwrap();
        assert_eq!(wire.body()["model"], wire_model);
        assert_eq!(wire.body()["unknown_extension"], json!({"nested":[1,2,3]}));
        assert!(!format!("{wire:?}").contains(secret));

        let request =
            build_v3_transport_13_responses_http_request_from_v3_provider_12(wire).unwrap();
        assert!(!format!("{request:?}").contains(secret));
        let raw = transport.send(request).await.unwrap();
        assert_eq!(raw.provider_id(), provider_id);
        assert_eq!(raw.body_kind(), V3ProviderResponseBodyKind::Json);
        assert_eq!(
            serde_json::from_slice::<Value>(&raw.into_body_bytes().await.unwrap()).unwrap(),
            json!({"id":"resp_json","output_text":"ok"})
        );

        let capture = captures.recv().await.unwrap();
        assert_eq!(
            capture.authorization.as_deref(),
            Some(format!("Bearer {secret}").as_str())
        );
        assert_eq!(capture.accept.as_deref(), Some("application/json"));
        assert_eq!(capture.body["model"], wire_model);
        assert_eq!(capture.body["metadata"], json!({"client_field":"preserve"}));
        assert_eq!(capture.body["unknown_extension"], json!({"nested":[1,2,3]}));
    }

    std::env::remove_var("V3_GENERAL_ALPHA_KEY");
    std::env::remove_var("V3_GENERAL_BETA_KEY");
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn token_file_auth_is_resolved_only_at_transport_boundary() {
    let (base_url, mut captures, shutdown) = start_upstream().await;
    let transport = ReqwestResponsesTransport::default();
    let secret = "secret-token-file";
    let token_path = std::env::temp_dir().join(format!(
        "routecodex-v3-provider-token-{}.txt",
        std::process::id()
    ));
    tokio::fs::write(&token_path, format!("{secret}\n"))
        .await
        .unwrap();

    let wire = build_v3_provider_12_responses_wire_payload(
        "req-token-file",
        target_with_auth(
            "token-file-relay",
            &base_url,
            "model-token-file",
            "file-primary",
            V3ProviderAuthSecretHandle::TokenFile(token_path.display().to_string()),
        ),
        json!({"model":"client-alias","input":"hello","case":"json"}),
    )
    .unwrap();
    assert!(!format!("{wire:?}").contains(secret));

    let request = build_v3_transport_13_responses_http_request_from_v3_provider_12(wire).unwrap();
    assert!(!format!("{request:?}").contains(secret));
    let raw = transport.send(request).await.unwrap();
    assert_eq!(raw.status(), 200);
    let capture = captures.recv().await.unwrap();
    assert_eq!(
        capture.authorization.as_deref(),
        Some(format!("Bearer {secret}").as_str())
    );
    assert_eq!(capture.body["model"], "model-token-file");

    tokio::fs::remove_file(token_path).await.unwrap();
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn sse_is_streamed_as_validated_raw_events_and_malformed_sse_fails_explicitly() {
    let (base_url, mut captures, shutdown) = start_upstream().await;
    std::env::set_var("V3_GENERAL_SSE_KEY", "secret-sse");
    let transport = ReqwestResponsesTransport::default();

    let wire = build_v3_provider_12_responses_wire_payload(
        "req-sse",
        target(
            "stream-relay",
            &base_url,
            "model-stream",
            "stream",
            "V3_GENERAL_SSE_KEY",
        ),
        json!({"model":"client","input":"hello","stream":true,"case":"sse"}),
    )
    .unwrap();
    let raw = transport
        .send(build_v3_transport_13_responses_http_request_from_v3_provider_12(wire).unwrap())
        .await
        .unwrap();
    assert_eq!(raw.body_kind(), V3ProviderResponseBodyKind::Sse);
    let bytes = raw.into_body_bytes().await.unwrap();
    assert_eq!(
        String::from_utf8(bytes).unwrap(),
        "event: response.created\ndata: {\"id\":\"resp_sse\"}\n\ndata: [DONE]\n\n"
    );
    assert_eq!(
        captures.recv().await.unwrap().accept.as_deref(),
        Some("text/event-stream")
    );

    let malformed = build_v3_provider_12_responses_wire_payload(
        "req-malformed",
        target(
            "stream-relay",
            &base_url,
            "model-stream",
            "stream",
            "V3_GENERAL_SSE_KEY",
        ),
        json!({"model":"client","input":"hello","stream":true,"case":"malformed_sse"}),
    )
    .unwrap();
    let raw = transport
        .send(build_v3_transport_13_responses_http_request_from_v3_provider_12(malformed).unwrap())
        .await
        .unwrap();
    assert!(matches!(
        raw.into_body_bytes().await.unwrap_err(),
        V3ProviderError::MalformedSse { .. }
    ));
    let _ = captures.recv().await.unwrap();

    std::env::remove_var("V3_GENERAL_SSE_KEY");
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn auth_http_connect_and_client_disconnect_errors_remain_typed_failures() {
    let (base_url, mut captures, shutdown) = start_upstream().await;
    let transport = ReqwestResponsesTransport::default();

    let missing = build_v3_provider_12_responses_wire_payload(
        "req-missing-auth",
        target(
            "missing-auth",
            &base_url,
            "model",
            "missing",
            "V3_GENERAL_MISSING_KEY",
        ),
        json!({"model":"client","input":"hello"}),
    )
    .unwrap();
    assert!(matches!(
        transport
            .send(
                build_v3_transport_13_responses_http_request_from_v3_provider_12(missing).unwrap()
            )
            .await
            .unwrap_err(),
        V3ProviderError::MissingAuthSecret { .. }
    ));

    std::env::set_var("V3_GENERAL_ERROR_KEY", "secret-error");
    for (case_name, expected_status) in [("status_401", 401), ("status_503", 503)] {
        let wire = build_v3_provider_12_responses_wire_payload(
            format!("req-{case_name}"),
            target(
                "error-relay",
                &base_url,
                "model",
                "error",
                "V3_GENERAL_ERROR_KEY",
            ),
            json!({"model":"client","input":"hello","case":case_name}),
        )
        .unwrap();
        match transport
            .send(build_v3_transport_13_responses_http_request_from_v3_provider_12(wire).unwrap())
            .await
            .unwrap_err()
        {
            V3ProviderError::HttpStatus { response } => {
                assert_eq!(response.status, expected_status);
                assert!(!response.body.is_empty());
            }
            other => panic!("expected typed HTTP status error, got {other:?}"),
        }
        let _ = captures.recv().await.unwrap();
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let closed_address = listener.local_addr().unwrap();
    drop(listener);
    let connection = build_v3_provider_12_responses_wire_payload(
        "req-connect",
        target(
            "connect-relay",
            &format!("http://{closed_address}/v1"),
            "model",
            "error",
            "V3_GENERAL_ERROR_KEY",
        ),
        json!({"model":"client","input":"hello"}),
    )
    .unwrap();
    assert!(matches!(
        transport
            .send(
                build_v3_transport_13_responses_http_request_from_v3_provider_12(connection)
                    .unwrap()
            )
            .await
            .unwrap_err(),
        V3ProviderError::Transport { .. }
    ));

    let cancellation = V3ProviderCancellation::new();
    cancellation.cancel();
    let cancelled = build_v3_provider_12_responses_wire_payload(
        "req-cancelled",
        target(
            "cancel-relay",
            &base_url,
            "model",
            "error",
            "V3_GENERAL_ERROR_KEY",
        ),
        json!({"model":"client","input":"hello"}),
    )
    .unwrap();
    let cancelled_request =
        build_v3_transport_13_responses_http_request_from_v3_provider_12(cancelled).unwrap();
    let cancelled_request = cancelled_request.with_cancellation(cancellation);
    assert!(matches!(
        transport.send(cancelled_request).await.unwrap_err(),
        V3ProviderError::ClientDisconnect { .. }
    ));

    std::env::remove_var("V3_GENERAL_ERROR_KEY");
    shutdown.send(()).unwrap();
}
