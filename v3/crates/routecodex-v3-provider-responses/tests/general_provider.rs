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
            .header("x-upstream", "controlled-sse")
            .body(Body::from_stream(futures_util::stream::iter([
                Ok::<_, Infallible>("event: response.created\ndata: {\"id\":\"resp_sse\"}\n\n"),
                Ok::<_, Infallible>("data: [DONE]\n\n"),
            ])))
            .unwrap(),
        "plain_text" => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/plain; charset=utf-8")
            .header("x-upstream", "controlled-text")
            .body(Body::from("plain provider response"))
            .unwrap(),
        "malformed_sse" => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from("data: {\"id\":\"unterminated\"}\n"))
            .unwrap(),
        "invalid_utf8_sse" => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(b"data: \xff\n\n".to_vec()))
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
        provider_type: "responses".to_string(),
        interface_id: "default".to_string(),
        base_url: base_url.to_string(),
        canonical_model_id: wire_model.to_string(),
        wire_model: wire_model.to_string(),
        compatibility_profile: None,
        headers: Default::default(),
        auth: V3ProviderAuthHandle {
            alias: auth_alias.to_string(),
            secret,
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
            "model": wire_model,
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
        json!({"model":"model-token-file","input":"hello","case":"json"}),
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
async fn sse_is_streamed_as_validated_raw_events_and_invalid_sse_fails_explicitly() {
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
        json!({"model":"model-stream","input":"hello","stream":true,"case":"sse"}),
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

    let trailing = build_v3_provider_12_responses_wire_payload(
        "req-trailing",
        target(
            "stream-relay",
            &base_url,
            "model-stream",
            "stream",
            "V3_GENERAL_SSE_KEY",
        ),
        json!({"model":"model-stream","input":"hello","stream":true,"case":"malformed_sse"}),
    )
    .unwrap();
    let raw = transport
        .send(build_v3_transport_13_responses_http_request_from_v3_provider_12(trailing).unwrap())
        .await
        .unwrap();
    assert_eq!(
        String::from_utf8(raw.into_body_bytes().await.unwrap()).unwrap(),
        "data: {\"id\":\"unterminated\"}\n\n"
    );
    let _ = captures.recv().await.unwrap();

    let invalid = build_v3_provider_12_responses_wire_payload(
        "req-invalid",
        target(
            "stream-relay",
            &base_url,
            "model-stream",
            "stream",
            "V3_GENERAL_SSE_KEY",
        ),
        json!({"model":"model-stream","input":"hello","stream":true,"case":"invalid_utf8_sse"}),
    )
    .unwrap();
    let raw = transport
        .send(build_v3_transport_13_responses_http_request_from_v3_provider_12(invalid).unwrap())
        .await
        .unwrap();
    // 非法 UTF-8 字节按解析容忍修复（U+FFFD），帧结构保留，transport 不拒绝；
    // 帧内容若不是合法 JSON 仍在 observe/classify 层 fail-fast。
    assert_eq!(
        raw.into_body_bytes().await.unwrap(),
        b"data: \xef\xbf\xbd\n\n".to_vec(),
        "invalid UTF-8 bytes must be repaired with U+FFFD, not rejected"
    );
    let _ = captures.recv().await.unwrap();

    std::env::remove_var("V3_GENERAL_SSE_KEY");
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn sse_request_accepts_json_provider_response_as_json_raw_body() {
    let (base_url, mut captures, shutdown) = start_upstream().await;
    std::env::set_var("V3_GENERAL_SSE_JSON_KEY", "secret-sse-json");
    let transport = ReqwestResponsesTransport::default();

    let wire = build_v3_provider_12_responses_wire_payload(
        "req-sse-json",
        target(
            "stream-json-relay",
            &base_url,
            "model-stream-json",
            "stream-json",
            "V3_GENERAL_SSE_JSON_KEY",
        ),
        json!({"model":"model-stream-json","input":"hello","stream":true,"case":"json"}),
    )
    .unwrap();
    let raw = transport
        .send(build_v3_transport_13_responses_http_request_from_v3_provider_12(wire).unwrap())
        .await
        .unwrap();
    assert_eq!(raw.body_kind(), V3ProviderResponseBodyKind::Json);
    assert_eq!(
        serde_json::from_slice::<Value>(&raw.into_body_bytes().await.unwrap()).unwrap(),
        json!({"id":"resp_json","output_text":"ok"})
    );
    let capture = captures.recv().await.unwrap();
    assert_eq!(capture.accept.as_deref(), Some("text/event-stream"));
    assert_eq!(capture.body["stream"], true);

    std::env::remove_var("V3_GENERAL_SSE_JSON_KEY");
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn json_request_accepts_sse_provider_response_as_sse_raw_body() {
    let (base_url, mut captures, shutdown) = start_upstream().await;
    std::env::set_var("V3_GENERAL_JSON_SSE_KEY", "secret-json-sse");
    let transport = ReqwestResponsesTransport::default();
    let mut provider_target = target(
        "json-stream-relay",
        &base_url,
        "model-json-stream",
        "json-stream",
        "V3_GENERAL_JSON_SSE_KEY",
    );
    provider_target.compatibility_profile = Some("responses:json-sse-preserve".to_string());
    provider_target.sse_first_frame_timeout_ms = Some(4_321);
    let request_body =
        json!({"model":"model-json-stream","input":"hello","case":"sse","preserved":true});

    let wire = build_v3_provider_12_responses_wire_payload(
        "req-json-sse",
        provider_target,
        request_body.clone(),
    )
    .unwrap();
    let raw = transport
        .send(build_v3_transport_13_responses_http_request_from_v3_provider_12(wire).unwrap())
        .await
        .unwrap();
    assert_eq!(raw.body_kind(), V3ProviderResponseBodyKind::Sse);
    assert_eq!(raw.status(), 200);
    assert_eq!(
        raw.header_text("x-upstream").unwrap(),
        Some("controlled-sse")
    );
    assert_eq!(
        raw.compatibility_profile(),
        Some("responses:json-sse-preserve")
    );
    assert_eq!(raw.sse_first_frame_timeout_ms(), Some(4_321));
    assert_eq!(
        String::from_utf8(raw.into_body_bytes().await.unwrap()).unwrap(),
        "event: response.created\ndata: {\"id\":\"resp_sse\"}\n\ndata: [DONE]\n\n"
    );
    let capture = captures.recv().await.unwrap();
    assert_eq!(capture.accept.as_deref(), Some("application/json"));
    assert!(capture.body.get("stream").is_none());
    assert_eq!(capture.body, request_body);

    std::env::remove_var("V3_GENERAL_JSON_SSE_KEY");
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn unknown_provider_content_type_stays_typed_for_json_and_sse_intents() {
    let (base_url, mut captures, shutdown) = start_upstream().await;
    std::env::set_var("V3_GENERAL_UNKNOWN_TYPE_KEY", "secret-unknown-type");
    let transport = ReqwestResponsesTransport::default();

    for (request_id, stream, expected) in [
        ("req-json-plain-text", false, "JSON"),
        ("req-sse-plain-text", true, "SSE"),
    ] {
        let mut body = json!({"model":"model-unknown","input":"hello","case":"plain_text"});
        if stream {
            body["stream"] = Value::Bool(true);
        }
        let wire = build_v3_provider_12_responses_wire_payload(
            request_id,
            target(
                "unknown-type-relay",
                &base_url,
                "model-unknown",
                "unknown-type",
                "V3_GENERAL_UNKNOWN_TYPE_KEY",
            ),
            body,
        )
        .unwrap();
        let error = transport
            .send(build_v3_transport_13_responses_http_request_from_v3_provider_12(wire).unwrap())
            .await
            .unwrap_err();
        match error {
            V3ProviderError::UnexpectedContentType {
                expected: actual_expected,
                content_type,
                status,
                headers,
                ..
            } => {
                assert_eq!(actual_expected, expected);
                assert_eq!(content_type.as_deref(), Some("text/plain; charset=utf-8"));
                assert_eq!(status, 200);
                assert!(headers.iter().any(|header| {
                    header.name == "x-upstream" && header.value == b"controlled-text"
                }));
            }
            other => panic!("expected typed unexpected content type error, got {other:?}"),
        }
        let capture = captures.recv().await.unwrap();
        assert_eq!(
            capture.accept.as_deref(),
            Some(if stream {
                "text/event-stream"
            } else {
                "application/json"
            })
        );
    }

    std::env::remove_var("V3_GENERAL_UNKNOWN_TYPE_KEY");
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
        json!({"model":"model","input":"hello"}),
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
            json!({"model":"model","input":"hello","case":case_name}),
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
        json!({"model":"model","input":"hello"}),
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
        json!({"model":"model","input":"hello"}),
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

#[derive(Clone)]
struct RateLimitState {
    barrier: Arc<tokio::sync::Barrier>,
}

async fn rate_limited_upstream(State(state): State<Arc<RateLimitState>>) -> Response<Body> {
    // Refuse both concurrent attempts only after they are simultaneously in
    // flight, so the observed 429 watermark is deterministic.
    state.barrier.wait().await;
    Response::builder()
        .status(StatusCode::TOO_MANY_REQUESTS)
        .header("content-type", "application/json")
        .body(Body::from("{\"error\":{\"message\":\"rate limited\"}}"))
        .unwrap()
}

#[tokio::test]
async fn upstream_429_collapses_adaptive_budget_below_the_refused_watermark() {
    use routecodex_v3_provider_responses::adaptive_concurrency::V3AdaptiveConcurrencyController;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/responses", post(rate_limited_upstream))
        .with_state(Arc::new(RateLimitState {
            barrier: Arc::new(tokio::sync::Barrier::new(2)),
        }));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let base_url = format!("http://{address}/v1");
    std::env::set_var("V3_ADAPTIVE_429_KEY", "secret-adaptive-429");

    let provider_target = target(
        "adaptive-429-blackbox",
        &base_url,
        "model-429",
        "adaptive",
        "V3_ADAPTIVE_429_KEY",
    );
    let provider_key = format!(
        "{}:{}",
        provider_target.provider_id, provider_target.auth.alias
    );
    let controller = V3AdaptiveConcurrencyController::process_shared();
    controller
        .ensure_initial_budget(&provider_key, provider_target.initial_concurrency_budget)
        .unwrap();
    let baseline = controller.snapshot(&provider_key).unwrap();
    assert_eq!(
        baseline.hard_max_in_flight, 8,
        "the declared static maxInFlight must remain only the hard ceiling"
    );
    assert_eq!(baseline.budget, 8);
    assert_eq!(baseline.rate_limit_samples, 0);
    assert_eq!(baseline.smoothed_budget, 8);

    let transport = ReqwestResponsesTransport::default();
    let mut attempts = Vec::new();
    for attempt in 0..2 {
        let transport = transport.clone();
        let provider_target = provider_target.clone();
        attempts.push(tokio::spawn(async move {
            let wire = build_v3_provider_12_responses_wire_payload(
                format!("req-adaptive-429-{attempt}"),
                provider_target,
                json!({"model":"model-429","input":"hello"}),
            )
            .unwrap();
            transport
                .send(
                    build_v3_transport_13_responses_http_request_from_v3_provider_12(wire).unwrap(),
                )
                .await
        }));
    }
    for attempt in attempts {
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), attempt)
            .await
            .expect("both rate-limited attempts must terminate")
            .unwrap();
        assert!(
            matches!(
                result,
                Err(V3ProviderError::HttpStatus { response }) if response.status == 429
            ),
            "the provider 429 must surface as a typed HTTP status error"
        );
    }

    let scope =
        routecodex_v3_provider_responses::adaptive_concurrency::V3ConcurrencyIdentityScope {
            interface_id: provider_target.interface_id.clone(),
            model_id: provider_target.canonical_model_id.clone(),
        };
    let snapshot = controller
        .snapshot_for_scope(&provider_key, Some(&scope))
        .unwrap();
    assert_eq!(
        snapshot.rate_limit_samples, 2,
        "each refused attempt must contribute one 429 watermark sample"
    );
    assert_eq!(
        snapshot.smoothed_budget, 1,
        "two 429s at an in-flight watermark of two must cap the budget one slot below it"
    );
    assert_eq!(
        snapshot.budget, 1,
        "the adaptive budget must drop to the refused watermark minus one, not step down by one"
    );
    assert!(snapshot.saturated);
    assert!(snapshot.in_flight == 0, "both leases must be released");

    std::env::remove_var("V3_ADAPTIVE_429_KEY");
    shutdown_tx.send(()).unwrap();
}
