use routecodex_v3_provider_responses::{
    build_v3_transport_13_responses_http_request_from_parts_with_timeout,
    ReqwestResponsesTransport, V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderError,
    V3ProviderRequestHeader, V3ResponsesStreamIntent,
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn request(url: String) -> routecodex_v3_provider_responses::V3Transport13ResponsesRequest {
    request_with_intent(url, V3ResponsesStreamIntent::Json)
}

fn request_with_intent(
    url: String,
    intent: V3ResponsesStreamIntent,
) -> routecodex_v3_provider_responses::V3Transport13ResponsesRequest {
    build_v3_transport_13_responses_http_request_from_parts_with_timeout(
        "probe-status",
        "status-contract",
        url,
        V3ProviderAuthHandle {
            alias: "test".into(),
            secret: V3ProviderAuthSecretHandle::ApiKey("secret".into()),
        },
        intent,
        serde_json::json!({"input":"ping; reply pong","stream":intent == V3ResponsesStreamIntent::Sse}),
        vec![V3ProviderRequestHeader::new("x-probe-test", "kept")],
        Some(Duration::from_millis(500)),
    )
    .unwrap()
}

#[tokio::test]
async fn probe_accepts_every_2xx_body_without_parsing_or_waiting() {
    for (status, content_type, body) in [
        (200, "application/json", ""),
        (204, "text/plain", ""),
        (200, "text/plain", "anything other than pong"),
        (200, "application/json", "malformed"),
        (200, "application/json", r#"{"error":{"code":"bad"}}"#),
        (200, "application/json", r#"{"status":"failed"}"#),
        (200, "application/json", r#"{"status":"incomplete"}"#),
        (200, "text/event-stream", "data: partial\n\n"),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 4096];
            let length = socket.read(&mut bytes).await.unwrap();
            let wire = String::from_utf8_lossy(&bytes[..length]);
            assert!(wire
                .to_ascii_lowercase()
                .contains("authorization: bearer secret"));
            assert!(wire.to_ascii_lowercase().contains("x-probe-test: kept"));
            // Deliberately leave the body unfinished. A probe must return at headers.
            socket.write_all(format!("HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nContent-Length: 100000\r\n\r\n{body}").as_bytes()).await.unwrap();
            let _ = release_rx.await;
        });
        let result = tokio::time::timeout(
            Duration::from_millis(250),
            ReqwestResponsesTransport::default()
                .send_probe(request(format!("http://{address}/probe"))),
        )
        .await;
        let _ = release_tx.send(());
        task.await.unwrap();
        assert!(
            matches!(result, Ok(Ok(()))),
            "status={status} content_type={content_type} result={result:?}"
        );
    }
}

#[tokio::test]
async fn probe_preserves_non_2xx_status_body_and_network_errors() {
    for status in [302, 401, 429, 503] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 4096];
            let read = socket.read(&mut bytes).await.unwrap();
            assert!(
                read > 0,
                "probe request must arrive before response headers"
            );
            socket.write_all(format!("HTTP/1.1 {status} Failure\r\nContent-Length: 4\r\nx-evidence: kept\r\n\r\noops").as_bytes()).await.unwrap();
        });
        let error = ReqwestResponsesTransport::default()
            .send_probe(request(format!("http://{address}/probe")))
            .await
            .unwrap_err();
        task.await.unwrap();
        let V3ProviderError::HttpStatus { response } = error else {
            panic!("{error:?}")
        };
        assert_eq!(response.status, status);
        assert_eq!(response.body, b"oops");
        assert!(response.headers.iter().any(|h| h.name == "x-evidence"));
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    assert!(matches!(
        ReqwestResponsesTransport::default()
            .send_probe(request(format!("http://{address}/probe")))
            .await,
        Err(V3ProviderError::Transport { .. })
    ));
}

#[tokio::test]
async fn every_protocol_builder_uses_the_same_status_only_transport() {
    use routecodex_v3_config::V3ResponsesTransportKind;
    use routecodex_v3_provider_responses::{
        build_v3_provider_global_probe_request, V3ResponsesProviderTarget,
    };
    for (protocol, path, prompt_field) in [
        ("responses", "/v1/responses", "input"),
        ("openai_chat", "/v1/chat/completions", "messages"),
        ("anthropic", "/v1/messages?beta=true", "messages"),
        (
            "gemini",
            "/v1/models/test-model:generateContent",
            "contents",
        ),
    ] {
        for status in [200, 204, 429, 503] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let target = V3ResponsesProviderTarget {
                provider_id: format!("matrix-{protocol}-{status}"),
                provider_type: protocol.into(),
                base_url: if protocol == "anthropic" {
                    format!("http://{address}")
                } else {
                    format!("http://{address}/v1")
                },
                canonical_model_id: "test-model".into(),
                wire_model: "test-model".into(),
                compatibility_profile: None,
                headers: std::collections::BTreeMap::from([("x-probe-test".into(), "kept".into())]),
                auth: V3ProviderAuthHandle {
                    alias: "test".into(),
                    secret: V3ProviderAuthSecretHandle::ApiKey("secret".into()),
                },
                responses_transport: V3ResponsesTransportKind::WebsocketV2,
                websocket_v2_url: Some("wss://invalid.test/responses".into()),
                provider_request_cleanup: Default::default(),
                request_timeout_ms: 500,
                sse_first_frame_timeout_ms: None,
                initial_concurrency_budget: 8,
                concurrency_acquire_timeout_ms: 500,
            };
            let built =
                build_v3_provider_global_probe_request(target, "protocol-matrix".into()).unwrap();
            assert!(built.body()[prompt_field]
                .to_string()
                .contains("ping; reply pong"));
            assert!(built.body().get("max_output_tokens").is_none());
            assert!(built.body().get("generationConfig").is_none());
            if protocol == "anthropic" {
                assert_eq!(built.body()["max_tokens"], 1);
            } else {
                assert!(built.body().get("max_tokens").is_none());
            }
            let task = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = vec![0; 4096];
                let length = socket.read(&mut bytes).await.unwrap();
                let wire = String::from_utf8_lossy(&bytes[..length]).to_ascii_lowercase();
                assert!(
                    wire.starts_with(&format!("post {path} http/1.1").to_ascii_lowercase()),
                    "{wire}"
                );
                assert!(wire.contains("authorization: bearer secret"));
                assert!(wire.contains("x-probe-test: kept"));
                if protocol == "anthropic" {
                    assert!(wire.contains("anthropic-version: 2023-06-01"));
                }
                socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\noops").as_bytes()).await.unwrap();
            });
            let result = ReqwestResponsesTransport::default().send_probe(built).await;
            task.await.unwrap();
            if status < 300 {
                assert!(result.is_ok(), "{protocol}: {result:?}");
            } else {
                assert!(
                    matches!(result, Err(V3ProviderError::HttpStatus {response}) if response.status == status),
                    "{protocol}"
                );
            }
        }
    }
}

#[tokio::test]
async fn streaming_probe_non_2xx_unfinished_body_keeps_status_and_releases_admission() {
    for status in [429, 503] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 4096];
            let read = socket.read(&mut bytes).await.unwrap();
            assert!(
                read > 0,
                "probe request must arrive before response headers"
            );
            socket.write_all(format!("HTTP/1.1 {status} Failure\r\nContent-Length: 100000\r\nx-evidence: kept\r\n\r\npartial").as_bytes()).await.unwrap();
            let _ = release_rx.await;
        });
        let transport = ReqwestResponsesTransport::default();
        let result = tokio::time::timeout(
            Duration::from_millis(900),
            transport.send_probe(request_with_intent(
                format!("http://{address}/probe"),
                V3ResponsesStreamIntent::Sse,
            )),
        )
        .await;
        let _ = release_tx.send(());
        task.await.unwrap();
        let error = result
            .expect("probe must obey configured500ms transport deadline")
            .unwrap_err();
        let V3ProviderError::HttpStatus { response } = error else {
            panic!("realHTTPstatus must survive body timeout: {error:?}")
        };
        assert_eq!(response.status, status);
        assert!(response.body_read_failure.is_some());
        assert!(response
            .headers
            .iter()
            .any(|header| header.name == "x-evidence"));
        let snapshot=routecodex_v3_provider_responses::adaptive_concurrency::V3AdaptiveConcurrencyController::process_shared().snapshot("status-contract:test").unwrap();
        assert_eq!(
            snapshot.in_flight, 0,
            "probe failure must release admission"
        );
    }
}
