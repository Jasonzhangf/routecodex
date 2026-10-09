use super::*;

#[test]
fn provider_default_http_read_timeout_matches_fifteen_minute_local_budget() {
    assert_eq!(
        super::V3_PROVIDER_HTTP_READ_TIMEOUT_SECS,
        900,
        "the provider client read timeout must not truncate a configured 15-minute local cold start"
    );
}
use crate::wire::{
    build_v3_provider_12_responses_compact_wire_payload,
    build_v3_provider_12_responses_wire_payload, V3ProviderAuthHandle, V3ProviderAuthSecretHandle,
    V3ResponsesProviderTarget,
};
use crate::{
    V3ProviderTransportAttemptBroker, V3ProviderTransportAttemptKey,
    V3ProviderTransportAttemptState, V3ProviderTransportHandoffScope, V3ProviderTransportKind,
};
use routecodex_v3_config::V3ResponsesTransportKind;
use serde_json::json;

fn probe_sse_fixture(
    stream: V3ProviderSseStream,
) -> (
    V3ProviderResp14Raw,
    V3AdaptiveConcurrencyController,
    V3ProviderTransportAttemptBroker,
    V3ProviderTransportAttemptKey,
) {
    let provider_key = "probe-sse-provider:key1";
    let controller = V3AdaptiveConcurrencyController::new(2).unwrap();
    let held = controller.try_acquire(provider_key, 0).unwrap();
    controller.observe_rate_limit(provider_key, 0).unwrap();
    let probe = controller
        .try_acquire(
            provider_key,
            crate::adaptive_concurrency::V3_PROVIDER_CONCURRENCY_PROBE_INTERVAL_MS,
        )
        .unwrap();
    assert!(probe.is_probe());
    controller.release(held.into_permit()).unwrap();
    let guard = V3AdaptiveConcurrencyPermitGuard::new(controller.clone(), probe.into_permit())
        .with_probe_result(V3AdaptiveConcurrencyProbeResult::Accepted);

    let broker = V3ProviderTransportAttemptBroker::default();
    let key = V3ProviderTransportAttemptKey {
        request_id: "req-probe-sse".into(),
        provider_id: "probe-sse-provider".into(),
        attempt_id: 0,
    };
    broker
        .begin(
            key.clone(),
            V3ProviderTransportKind::Http,
            V3ProviderTransportHandoffScope {
                pipeline_id: "pipeline-probe-sse".into(),
                server_id: "server-probe-sse".into(),
                port: 4444,
                session_scope: "session-probe-sse".into(),
                runtime_generation: 1,
            },
        )
        .unwrap();
    broker
        .transition(&key, V3ProviderTransportAttemptState::Streaming)
        .unwrap();
    let raw = V3ProviderResp14Raw::from_sse(
        "req-probe-sse".into(),
        "probe-sse-provider".into(),
        200,
        vec![],
        stream,
    );
    (
        hold_sse_lease(raw, guard, broker.clone(), Some(key.clone())),
        controller,
        broker,
        key,
    )
}

fn assert_probe_sse_accepted(controller: &V3AdaptiveConcurrencyController) {
    let snapshot = controller.snapshot("probe-sse-provider:key1").unwrap();
    assert_eq!(snapshot.in_flight, 0);
    assert!(!snapshot.probe_in_flight);
    assert_eq!(
        snapshot.budget, 2,
        "accepted SSE probe must expand adaptive budget"
    );
    assert!(!snapshot.saturated);
    assert_eq!(snapshot.next_probe_at_ms, None);
}

#[test]
fn dropping_request_with_pre_acquired_admission_releases_provider_capacity() {
    let provider_id = "drop-pre-acquired-provider";
    let auth_alias = "key1";
    let provider_key = format!("{provider_id}:{auth_alias}");
    let controller = V3AdaptiveConcurrencyController::process_shared();
    controller.ensure_initial_budget(&provider_key, 1).unwrap();
    let lease = controller
        .try_acquire_business(&provider_key)
        .expect("pre-acquired lease must fill provider capacity");
    assert_eq!(controller.snapshot(&provider_key).unwrap().in_flight, 1);

    let request =
        build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency(
            "req-drop-pre-acquired",
            provider_id,
            "https://provider.example/v1/responses",
            V3ProviderAuthHandle {
                alias: auth_alias.into(),
                secret: V3ProviderAuthSecretHandle::ApiKey("secret-value".into()),
            },
            V3ResponsesStreamIntent::Json,
            json!({"model":"wire-model","input":"hello"}),
            vec![],
            None,
            100,
            None,
        )
        .unwrap()
        .with_pre_acquired_admission(lease);

    drop(request);
    assert_eq!(
        controller.snapshot(&provider_key).unwrap().in_flight,
        0,
        "dropping a request with pre-acquired admission must release capacity"
    );
}

#[test]
fn dropping_request_releases_pre_acquired_admission_through_its_controller() {
    let provider_id = "drop-local-controller-provider";
    let auth_alias = "key1";
    let provider_key = format!("{provider_id}:{auth_alias}");
    let controller = V3AdaptiveConcurrencyController::new(1).unwrap();
    let lease = controller
        .try_acquire_business(&provider_key)
        .expect("local controller lease must be acquired");
    assert_eq!(controller.snapshot(&provider_key).unwrap().in_flight, 1);

    let request =
        build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency(
            "req-drop-local-controller-pre-acquired",
            provider_id,
            "https://provider.example/v1/responses",
            V3ProviderAuthHandle {
                alias: auth_alias.into(),
                secret: V3ProviderAuthSecretHandle::ApiKey("secret-value".into()),
            },
            V3ResponsesStreamIntent::Json,
            json!({"model":"wire-model","input":"hello"}),
            vec![],
            None,
            100,
            None,
        )
        .unwrap()
        .with_pre_acquired_admission(lease);

    drop(request);
    assert_eq!(
        controller.snapshot(&provider_key).unwrap().in_flight,
        0,
        "pre-acquired lease must release through the controller that issued it"
    );
}

#[test]
fn probe_sse_headers_keep_permit_and_handoff_streaming() {
    let (raw, controller, broker, key) = probe_sse_fixture(Box::pin(stream::pending::<
        Result<Vec<u8>, V3ProviderError>,
    >()));
    let snapshot = controller.snapshot("probe-sse-provider:key1").unwrap();
    assert_eq!(snapshot.in_flight, 1);
    assert!(snapshot.probe_in_flight);
    assert!(snapshot.saturated);
    assert_eq!(snapshot.budget, 1);
    assert_eq!(
        broker.state(&key),
        Some(V3ProviderTransportAttemptState::Streaming)
    );
    drop(raw);
    assert_probe_sse_accepted(&controller);
}

#[tokio::test]
async fn probe_sse_eof_releases_once_and_marks_handoff_terminal() {
    let (raw, controller, broker, key) =
        probe_sse_fixture(Box::pin(stream::empty::<Result<Vec<u8>, V3ProviderError>>()));
    let V3ProviderResponseBody::Sse(mut body) = raw.into_body() else {
        panic!("probe response must remain SSE");
    };
    assert!(body.next().await.is_none());
    assert_probe_sse_accepted(&controller);
    assert_eq!(
        broker.state(&key),
        Some(V3ProviderTransportAttemptState::Terminal)
    );
    drop(body);
    assert_probe_sse_accepted(&controller);
}

#[tokio::test]
async fn probe_sse_error_releases_immediately_and_marks_handoff_failed() {
    let error = V3ProviderError::ResponseBody {
        request_id: "req-probe-sse".into(),
        provider_id: "probe-sse-provider".into(),
        reason: "injected stream failure".into(),
    };
    let (raw, controller, broker, key) =
        probe_sse_fixture(Box::pin(stream::once(async move { Err(error) })));
    let V3ProviderResponseBody::Sse(mut body) = raw.into_body() else {
        panic!("probe response must remain SSE");
    };
    assert!(body.next().await.unwrap().is_err());
    assert_probe_sse_accepted(&controller);
    assert_eq!(
        broker.state(&key),
        Some(V3ProviderTransportAttemptState::Failed)
    );
    assert!(body.next().await.is_none());
    assert_probe_sse_accepted(&controller);
}

fn responses_http_target() -> V3ResponsesProviderTarget {
    V3ResponsesProviderTarget {
        provider_id: "orangeai".into(),
        provider_type: "responses".into(),
        base_url: "https://api2.orangeai.cc/v1".into(),
        canonical_model_id: "glm-5.2".into(),
        wire_model: "glm-5.2".into(),
        compatibility_profile: None,
        headers: Default::default(),
        auth: V3ProviderAuthHandle {
            alias: "key1".into(),
            secret: V3ProviderAuthSecretHandle::Environment("ORANGEAI_KEY".into()),
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

#[tokio::test(flavor = "current_thread")]
async fn saturated_provider_admission_without_preacquired_lease_does_not_wait() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let provider_key = "admission-no-wait-provider:key1";
    let controller = V3AdaptiveConcurrencyController::process_shared();
    controller.ensure_initial_budget(provider_key, 1).unwrap();
    let held = controller
        .try_acquire_business(provider_key)
        .expect("the configured provider budget must be occupied");

    let mut target = responses_http_target();
    target.provider_id = "admission-no-wait-provider".into();
    target.base_url = format!("http://{addr}/v1");
    target.auth.alias = "key1".into();
    target.auth.secret = V3ProviderAuthSecretHandle::ApiKey("test-secret".into());
    target.initial_concurrency_budget = 1;
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-admission-no-wait",
        target,
        json!({"model":"glm-5.2","input":"hello"}),
    )
    .unwrap();
    let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap();
    let started = std::time::Instant::now();
    let result = tokio::time::timeout(
        Duration::from_millis(500),
        ProviderResponsesTransport::default().send(request),
    )
    .await
    .expect("full concurrency must return immediately");
    assert!(matches!(
        result,
        Err(V3ProviderError::ConcurrencyBusy { .. })
    ));
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err(),
        "a full provider must not receive an upstream request"
    );

    controller.release(held.into_permit()).unwrap();
}

#[test]
fn compact_wire_uses_the_native_http_endpoint() {
    let wire = build_v3_provider_12_responses_compact_wire_payload(
        "req-compact",
        responses_http_target(),
        json!({"model":"glm-5.2","input":[{"role":"user","content":"history"}]}),
    )
    .unwrap();
    let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap();
    assert_eq!(
        request.url(),
        "https://api2.orangeai.cc/v1/responses/compact"
    );
}

#[test]
fn compact_wire_rejects_websocket_transport() {
    let mut target = responses_http_target();
    target.responses_transport = V3ResponsesTransportKind::WebsocketV2;
    target.websocket_v2_url = Some("wss://provider.invalid/v1/responses".to_string());
    let wire = build_v3_provider_12_responses_compact_wire_payload(
        "req-compact-websocket",
        target,
        json!({"model":"glm-5.2","input":[{"role":"user","content":"history"}]}),
    )
    .unwrap();
    let error = build_v3_transport_13_responses_request_from_v3_provider_12(wire)
        .expect_err("native compact must not use Responses WebSocket transport");
    assert!(error
        .to_string()
        .contains("responses compact requires HTTP transport"));
}

fn additional_tool_fixture() -> Value {
    json!({
        "type":"function",
        "name":"request_user_input",
        "description":"Request structured input from the user when the tool contract requires it.",
        "parameters":{
            "type":"object",
            "properties":{
                "questions":{"type":"array"}
            },
            "required":["questions"]
        }
    })
}

#[test]
fn configured_provider_headers_projection_redacts_values() {
    let request = build_v3_transport_13_responses_http_request_with_provider_headers_from_parts(
        "req-provider-projection-verbatim",
        "provider-projection",
        "https://provider.example/v1/responses",
        V3ProviderAuthHandle {
            alias: "key1".into(),
            secret: V3ProviderAuthSecretHandle::ApiKey("secret-value".into()),
        },
        V3ResponsesStreamIntent::Sse,
        json!({"model":"deepseek-v4-flash","input":"original"}),
        vec![V3ProviderRequestHeader::new("x-api-key", "secret-value")],
    )
    .unwrap();
    let projection = request.provider_request_projection();
    assert_eq!(projection["headers"]["x-api-key"], "[REDACTED]");
    assert!(!projection.to_string().contains("secret-value"));
    assert_eq!(projection["body"]["input"], "original");
}

#[test]
fn configured_provider_headers_debug_redacts_value() {
    let header = V3ProviderRequestHeader::new("x-opencode-session", "session-secret");
    let debug = format!("{header:?}");

    assert!(debug.contains("x-opencode-session"));
    assert!(debug.contains("[REDACTED]"));
    assert!(!debug.contains("session-secret"));
}

#[tokio::test]
async fn configured_provider_headers_reach_wire_with_single_bearer_and_unchanged_body() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let upstream = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut chunk = [0_u8; 1024];
        let body_start = loop {
            let read = stream.read(&mut chunk).await.unwrap();
            assert_ne!(read, 0, "client closed before the request was complete");
            request.extend_from_slice(&chunk[..read]);
            if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let head = String::from_utf8_lossy(&request[..body_start]).to_ascii_lowercase();
        let content_length = head
            .lines()
            .find_map(|line| line.strip_prefix("content-length: "))
            .expect("request content-length")
            .trim()
            .parse::<usize>()
            .unwrap();
        while request.len() - body_start < content_length {
            let read = stream.read(&mut chunk).await.unwrap();
            assert_ne!(
                read, 0,
                "client closed before the request body was complete"
            );
            request.extend_from_slice(&chunk[..read]);
        }
        let body = request[body_start..body_start + content_length].to_vec();
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 35\r\nconnection: close\r\n\r\n{\"id\":\"chatcmpl-test\",\"choices\":[]}",
            )
            .await
            .unwrap();
        (
            String::from_utf8_lossy(&request[..body_start]).to_ascii_lowercase(),
            body,
        )
    });

    let body = json!({
        "model": "step-5-preview-free",
        "stream": true,
        "reasoning_effort": "low",
        "tools": [
            {"type":"function","function":{"name":"bash","parameters":{"type":"object"}}},
            {"type":"function","function":{"name":"read","parameters":{"type":"object"}}}
        ]
    });
    let request = build_v3_transport_13_responses_http_request_from_parts_with_timeout(
        "req-opencode-zen-configured-headers-wire",
        "opencode-zen-free",
        format!("http://{addr}/v1/chat/completions"),
        V3ProviderAuthHandle {
            alias: "key3".into(),
            secret: V3ProviderAuthSecretHandle::ApiKey("test-account-secret".into()),
        },
        V3ResponsesStreamIntent::Sse,
        body.clone(),
        vec![
            V3ProviderRequestHeader::new("x-opencode-client", "cli"),
            V3ProviderRequestHeader::new("x-opencode-session", "ses_test"),
            V3ProviderRequestHeader::new("x-opencode-request", "msg_test"),
        ],
        Some(Duration::from_secs(5)),
    )
    .unwrap();
    let projection = request.provider_request_projection();
    assert_eq!(projection["headers"]["x-opencode-client"], "[REDACTED]");
    assert_eq!(projection["headers"]["x-opencode-session"], "[REDACTED]");
    assert_eq!(projection["body"], body);
    assert_eq!(projection["streamIntent"], "sse");
    assert!(!projection.to_string().contains("ses_test"));

    ProviderResponsesTransport::default()
        .send(request)
        .await
        .expect("loopback provider response succeeds");
    let (headers, wire_body) = upstream.await.unwrap();
    assert!(headers.contains("x-opencode-client: cli\r\n"), "{headers}");
    assert!(
        headers.contains("x-opencode-session: ses_test\r\n"),
        "{headers}"
    );
    assert!(
        headers.contains("x-opencode-request: msg_test\r\n"),
        "{headers}"
    );
    assert_eq!(headers.matches("authorization:").count(), 1, "{headers}");
    assert!(
        headers.contains("authorization: bearer test-account-secret\r\n"),
        "{headers}"
    );
    assert_eq!(serde_json::from_slice::<Value>(&wire_body).unwrap(), body);
}

#[test]
fn responses_http_request_builds_provider_headers_from_target() {
    let mut target = responses_http_target();
    target.headers.insert(
        "x-openai-actor-authorization".to_string(),
        "local-image-extension".to_string(),
    );
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-resp-provider-headers-from-target",
        target,
        json!({"model":"glm-5.2","input":"hello"}),
    )
    .unwrap();
    let request = build_v3_transport_13_responses_http_request_from_v3_provider_12(wire).unwrap();
    let headers = request
        .provider_headers()
        .iter()
        .map(|header| (header.name().to_string(), header.value().to_string()))
        .collect::<Vec<_>>();
    assert_eq!(
        headers,
        vec![(
            "x-openai-actor-authorization".to_string(),
            "local-image-extension".to_string()
        )]
    );
}

#[test]
fn responses_http_provider_request_preserves_additional_tools_surface() {
    let original_exec = json!({
        "type":"custom",
        "name":"exec",
        "description":"run javascript",
        "format":{"type":"grammar","syntax":"lark","definition":"start: SOURCE"}
    });
    let original_wait = json!({
        "type":"function",
        "name":"wait",
        "description":"wait for exec",
        "parameters":{"type":"object","properties":{"cell_id":{"type":"string"}}}
    });
    let additional_tool = additional_tool_fixture();
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-responses-additional-tools",
        responses_http_target(),
        json!({
            "model":"glm-5.2",
            "instructions":"preserve the additional tool declaration",
            "input":[
                {
                    "type":"additional_tools",
                    "role":"developer",
                    "tools":[original_exec.clone(), original_wait.clone(), additional_tool.clone()]
                },
                {"role":"user","content":"continue"}
            ],
            "stream":true
        }),
    )
    .unwrap();
    let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap();
    assert_eq!(request.provider_id(), "orangeai");
    assert!(
        request.body().get("tools").is_none(),
        "request path $.tools must be absent because the original request did not contain $.tools: {}",
        request.body()
    );
    assert_eq!(request.body()["input"][0]["type"], "additional_tools");
    assert_eq!(request.body()["input"][0]["tools"][0], original_exec);
    assert_eq!(request.body()["input"][0]["tools"][1], original_wait);
    assert_eq!(request.body()["input"][0]["tools"][2], additional_tool);
    assert_eq!(
        request.body()["input"][0]["tools"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(request.body()["input"][1]["content"], "continue");
    assert!(request.body()["instructions"]
        .as_str()
        .unwrap()
        .contains("additional tool"));
}

#[tokio::test]
async fn anthropic_messages_http_transport_sends_claude_code_compat_headers() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let captured_for_server = std::sync::Arc::clone(&captured);
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let n = stream.read(&mut buffer).await.unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..n]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        *captured_for_server.lock().unwrap() = String::from_utf8_lossy(&request).into_owned();
        let body = r#"{"id":"msg_test","type":"message","role":"assistant","content":[],"stop_reason":"end_turn"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });

    let auth_env = "RCCV3_TEST_ANTHROPIC_HEADER_KEY";
    std::env::set_var(auth_env, "sk-test-headers");
    let request = build_v3_transport_13_responses_http_request_from_parts(
        "req-anthropic-compat-headers",
        "anthropic-test",
        format!("http://{addr}/anthropic/v1/messages"),
        V3ProviderAuthHandle {
            alias: "key1".into(),
            secret: V3ProviderAuthSecretHandle::Environment(auth_env.into()),
        },
        V3ResponsesStreamIntent::Json,
        json!({"model":"claude-fable-5","messages":[],"stream":false}),
    )
    .unwrap();
    let transport = ProviderResponsesTransport::default();
    transport.send(request).await.unwrap();
    std::env::remove_var(auth_env);
    server.await.unwrap();

    let raw_headers = captured.lock().unwrap().to_ascii_lowercase();
    assert!(raw_headers.contains("authorization: bearer sk-test-headers"));
    assert!(raw_headers.contains("x-api-key: sk-test-headers"));
    assert!(raw_headers.contains("anthropic-version: 2023-06-01"));
    assert!(raw_headers.contains("anthropic-beta: "));
    assert!(raw_headers.contains("claude-code-20250219"));
    assert!(raw_headers.contains("anthropic-dangerous-direct-browser-access: true"));
    assert!(raw_headers.contains("x-app: cli"));
    assert!(raw_headers.contains("user-agent: claude-cli/2.1.220 (external, sdk-cli)"));
    assert!(raw_headers.contains("x-stainless-lang: js"));
    assert!(raw_headers.contains("x-stainless-package-version: 0.94.0"));
    assert!(raw_headers.contains("x-stainless-runtime: node"));
    assert!(raw_headers.contains("x-stainless-retry-count: 0"));
    assert!(raw_headers.contains("x-stainless-timeout: 300"));
}

#[tokio::test]
async fn responses_http_transport_times_out_on_stalled_read_instead_of_waiting_forever() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await;
    });

    let auth_env = "RCCV3_TEST_HTTP_TIMEOUT_KEY";
    std::env::set_var(auth_env, "sk-test-timeout");
    let request = build_v3_transport_13_responses_http_request_from_parts(
        "req-timeout",
        "timeout-provider",
        format!("http://{addr}/v1/responses"),
        V3ProviderAuthHandle {
            alias: "key1".into(),
            secret: V3ProviderAuthSecretHandle::Environment(auth_env.into()),
        },
        V3ResponsesStreamIntent::Json,
        json!({"model":"timeout-model","input":"hello","stream":false}),
    )
    .unwrap();
    let transport =
        ProviderResponsesTransport::with_http_read_timeout_for_test(Duration::from_millis(50));
    let started = std::time::Instant::now();
    let error = transport
        .send(request)
        .await
        .expect_err("provider send must timeout");
    std::env::remove_var(auth_env);
    server.abort();

    assert!(started.elapsed() < Duration::from_secs(2));
    match error {
        V3ProviderError::Transport { .. } => {}
        other => panic!("expected transport timeout, got {other:?}"),
    }
}

#[tokio::test]
async fn responses_http_transport_uses_sse_first_frame_timeout_for_header_wait() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let n = stream.read(&mut buffer).await.unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..n]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        let body = "data: {\"type\":\"response.output_text.done\"}\n\n";
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });

    let request =
        build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency(
            "req-sse-header-wait",
            "kdns-test",
            format!("http://{addr}/v1/chat/completions"),
            V3ProviderAuthHandle {
                alias: "key1".into(),
                secret: V3ProviderAuthSecretHandle::ApiKey("sk-test-sse-header-wait".into()),
            },
            V3ResponsesStreamIntent::Sse,
            json!({"model":"deepseek-v4.1-flash","stream":true}),
            Vec::new(),
            Some(Duration::from_secs(5)),
            60_000,
            Some(50),
        )
        .unwrap();

    let started = tokio::time::Instant::now();
    let error = ProviderResponsesTransport::default()
        .send(request)
        .await
        .expect_err("SSE header wait must honor configured first-frame timeout");
    server.abort();

    assert!(
        started.elapsed() < Duration::from_secs(2),
        "SSE header wait should fail quickly"
    );
    match error {
        V3ProviderError::Transport { reason, .. } => {
            assert!(
                reason.contains("SSE first-frame"),
                "expected SSE first-frame timeout reason, got {reason}"
            );
        }
        other => panic!("expected transport timeout, got {other:?}"),
    }
}

async fn spawn_http_error_response(
    status: u16,
    headers: &[(&str, &str)],
    body: &[u8],
) -> std::net::SocketAddr {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let response_headers = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    let body = body.to_vec();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request).await.unwrap();
        let response =
            format!("HTTP/1.1 {status} Error\r\n{response_headers}connection: close\r\n\r\n");
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(&body).await.unwrap();
    });
    addr
}

fn http_transport_request(
    request_id: &str,
    url: String,
    cancellation: Option<V3ProviderCancellation>,
) -> V3Transport13ResponsesRequest {
    let request = build_v3_transport_13_responses_http_request_from_parts(
        request_id,
        "http-status-provider",
        url,
        V3ProviderAuthHandle {
            alias: "key1".into(),
            secret: V3ProviderAuthSecretHandle::ApiKey("sk-test-http-status".into()),
        },
        V3ResponsesStreamIntent::Json,
        json!({"model":"status-model","input":"hello","stream":false}),
    )
    .unwrap();
    match cancellation {
        Some(cancellation) => request.with_cancellation(cancellation),
        None => request,
    }
}

#[tokio::test]
async fn transport_http_status_preserves_body_when_read_succeeds() {
    let body = br#"{"error":{"message":"upstream rejected request"}}"#;
    let content_length = body.len().to_string();
    let addr = spawn_http_error_response(
        429,
        &[
            ("content-type", "application/json"),
            ("content-length", &content_length),
        ],
        body,
    )
    .await;
    let request = http_transport_request(
        "req-http-status-readable-body",
        format!("http://{addr}/v1/responses"),
        None,
    );
    let error = ProviderResponsesTransport::default()
        .send(request)
        .await
        .expect_err("HTTP error response must fail");
    match error {
        V3ProviderError::HttpStatus { response } => {
            assert_eq!(response.status, 429);
            assert_eq!(response.body, body);
        }
        other => panic!("expected HTTP status error, got {other:?}"),
    }
}

#[tokio::test]
async fn transport_http_status_preserves_real_code_on_body_decode_failure() {
    let addr = spawn_http_error_response(
        502,
        &[
            ("content-type", "application/json"),
            ("content-length", "64"),
        ],
        b"short",
    )
    .await;
    let request = http_transport_request(
        "req-http-status-corrupt-body",
        format!("http://{addr}/v1/responses"),
        None,
    );
    let error = ProviderResponsesTransport::default()
        .send(request)
        .await
        .expect_err("HTTP error response must fail");
    match error {
        V3ProviderError::HttpStatus { response } => {
            assert_eq!(response.status, 502);
            assert!(response.body.is_empty());
        }
        other => panic!("expected HTTP status error, got {other:?}"),
    }
}

#[tokio::test]
async fn transport_success_body_read_failure_is_a_network_failure() {
    let addr = spawn_http_error_response(
        200,
        &[
            ("content-type", "application/json"),
            ("content-length", "64"),
        ],
        b"short",
    )
    .await;
    let request = http_transport_request(
        "req-success-corrupt-body",
        format!("http://{addr}/v1/responses"),
        None,
    );
    let error = ProviderResponsesTransport::default()
        .send(request)
        .await
        .expect_err("truncated success body must fail");
    // No usable upstream response body arrived, so this stays a network
    // transport failure and must not project as a response-stage 599. The head
    // did arrive, so it survives on the error instead of being erased.
    match error {
        V3ProviderError::ResponseBodyUnreadable {
            status,
            headers,
            reason,
            ..
        } => {
            assert_eq!(status, 200);
            assert!(
                headers.iter().any(|header| {
                    header.name == "content-type" && header.value == &b"application/json"[..]
                }),
                "the received head must survive a failed body read: {headers:?}"
            );
            assert!(
                reason.contains("error decoding response body"),
                "unexpected reason: {reason}"
            );
        }
        other => panic!("expected an unreadable-body error, got {other:?}"),
    }
}

#[tokio::test]
async fn transport_sse_stream_read_failure_is_a_network_failure() {
    use futures_util::StreamExt;

    let addr = spawn_http_error_response(
        200,
        &[
            ("content-type", "text/event-stream"),
            ("content-length", "64"),
        ],
        b"data: {\"a\":1}\n\n",
    )
    .await;
    let request = build_v3_transport_13_responses_http_request_from_parts(
        "req-sse-corrupt-stream",
        "sse-provider",
        format!("http://{addr}/v1/responses"),
        V3ProviderAuthHandle {
            alias: "key1".into(),
            secret: V3ProviderAuthSecretHandle::ApiKey("sk-test-sse".into()),
        },
        V3ResponsesStreamIntent::Sse,
        json!({"model":"status-model","input":"hello","stream":true}),
    )
    .unwrap();
    let raw = ProviderResponsesTransport::default()
        .send(request)
        .await
        .expect("SSE response must be accepted");
    let crate::V3ProviderResponseBody::Sse(mut stream) = raw.into_body() else {
        panic!("expected an SSE body");
    };
    let mut failure = None;
    while let Some(item) = stream.next().await {
        if let Err(error) = item {
            failure = Some(error);
            break;
        }
    }
    // A truncated SSE stream is a network read failure, not a response-body
    // failure, and must not project as a response-stage 599.
    match failure.expect("truncated SSE stream must fail") {
        V3ProviderError::Transport { reason, .. } => {
            assert!(
                reason.contains("error decoding response body"),
                "unexpected reason: {reason}"
            );
        }
        other => panic!("expected transport error, got {other:?}"),
    }
}

#[tokio::test]
async fn transport_http_status_body_read_cancellation_remains_client_disconnect() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request).await.unwrap();
        stream
            .write_all(
                b"HTTP/1.1 502 Error\r\ncontent-type: application/json\r\ncontent-length: 64\r\nconnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await;
    });
    let cancellation = V3ProviderCancellation::new();
    let request = http_transport_request(
        "req-http-status-client-disconnect",
        format!("http://{addr}/v1/responses"),
        Some(cancellation.clone()),
    );
    let send =
        tokio::spawn(async move { ProviderResponsesTransport::default().send(request).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    cancellation.cancel();
    let error = send
        .await
        .unwrap()
        .expect_err("cancelled HTTP error body read must fail");
    server.abort();

    match error {
        V3ProviderError::ClientDisconnect { .. } => {}
        other => panic!("expected client disconnect, got {other:?}"),
    }
}

#[test]
fn responses_http_submit_tool_outputs_uses_native_response_endpoint() {
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-responses-submit-tool-outputs",
        responses_http_target(),
        json!({
            "model":"glm-5.2",
            "response_id":"resp_submit_http_v2_parity",
            "tool_outputs":[{"call_id":"call_submit_http","output":"ok"}],
            "stream":true
        }),
    )
    .unwrap();
    let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap();
    assert_eq!(
        request.url(),
        "https://api2.orangeai.cc/v1/responses/resp_submit_http_v2_parity/submit_tool_outputs"
    );
    assert_eq!(request.stream_intent(), V3ResponsesStreamIntent::Sse);
    assert_eq!(
        request.body()["tool_outputs"],
        json!([{"call_id":"call_submit_http","output":"ok"}])
    );
    assert_eq!(request.body()["stream"], true);
    assert!(request.body().get("response_id").is_none());
    assert!(request.body().get("responseId").is_none());
}

async fn spawn_http_success_response(body: &[u8]) -> std::net::SocketAddr {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let body = body.to_vec();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request).await.unwrap();
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(&body).await.unwrap();
    });
    addr
}

#[tokio::test]
async fn transport_response_carries_target_compatibility_profile() {
    // 契约：wire target 声明的 compatibility_profile 必须随 transport 流到
    // V3ProviderResp14Raw，响应侧能力回射按 profile 门控而不是 provider_id。
    std::env::set_var("ORANGEAI_KEY", "sk-test-profile-carry");
    let body =
        br#"{"id":"resp_1","output":[{"type":"function_call","call_id":"call_1","name":"exec_command","arguments":"{\"input\":\"ls\"}"}]}"#;
    let addr = spawn_http_success_response(body).await;
    let target = V3ResponsesProviderTarget {
        base_url: format!("http://{addr}/v1"),
        canonical_model_id: "glm-5.2".into(),
        wire_model: "glm-5.2".into(),
        compatibility_profile: Some("responses:deepseek-console-go".into()),
        ..responses_http_target()
    };
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-profile-carry",
        target,
        json!({"model":"glm-5.2","input":"hello","stream":false}),
    )
    .unwrap();
    let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap();
    let raw = ProviderResponsesTransport::default()
        .send(request)
        .await
        .expect("successful provider response");
    std::env::remove_var("ORANGEAI_KEY");

    assert_eq!(
        raw.compatibility_profile(),
        Some("responses:deepseek-console-go")
    );
}

// ---------------------------------------------------------------------------
// upstream model discovery (WebUI onboarding)
// ---------------------------------------------------------------------------

const DISCOVERY_SECRET: &str = "sk-discover-secret-value";

fn discovery_auth() -> V3ProviderAuthHandle {
    V3ProviderAuthHandle {
        alias: "key1".into(),
        secret: V3ProviderAuthSecretHandle::ApiKey(DISCOVERY_SECRET.into()),
    }
}

/// 单连接 mock：捕获请求行与请求头，返回固定响应。
async fn spawn_discovery_server(
    status: u16,
    body: &'static str,
) -> (String, std::sync::Arc<std::sync::Mutex<String>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let captured_for_server = std::sync::Arc::clone(&captured);
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let n = stream.read(&mut buffer).await.unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..n]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        *captured_for_server.lock().unwrap() = String::from_utf8_lossy(&request).into_owned();
        let reason = if status == 200 { "OK" } else { "Unauthorized" };
        let response = format!(
            "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    (format!("http://{addr}"), captured)
}

#[tokio::test]
async fn discover_models_uses_provider_specific_path_and_auth_header() {
    let cases = [
        (
            "openai_chat",
            "/models",
            "authorization: bearer sk-discover-secret-value",
            r#"{"data":[{"id":"gpt-a"},{"id":"gpt-b"}]}"#,
        ),
        (
            "responses",
            "/models",
            "authorization: bearer sk-discover-secret-value",
            r#"{"data":[{"id":"gpt-a"},{"id":"gpt-b"}]}"#,
        ),
        (
            "anthropic",
            "/v1/models",
            "x-api-key: sk-discover-secret-value",
            r#"{"data":[{"id":"claude-a"}]}"#,
        ),
        (
            "gemini",
            "/v1beta/models",
            "x-goog-api-key: sk-discover-secret-value",
            r#"{"models":[{"name":"models/gemini-a"}]}"#,
        ),
    ];
    for (provider_type, expected_path, expected_header, body) in cases {
        let (base_url, captured) = spawn_discovery_server(200, body).await;
        let models = discover_v3_provider_models(
            "discover-provider",
            provider_type,
            &base_url,
            &discovery_auth(),
        )
        .await
        .unwrap_or_else(|error| panic!("{provider_type} discovery must succeed, got {error}"));
        assert!(
            !models.is_empty(),
            "{provider_type} must return model names"
        );
        let raw = captured.lock().unwrap().to_ascii_lowercase();
        assert!(
            raw.starts_with(&format!("get {expected_path} http/1.1")),
            "{provider_type} must GET {expected_path}, got {:?}",
            raw.lines().next().unwrap_or_default()
        );
        assert!(
            raw.contains(expected_header),
            "{provider_type} must send {expected_header}"
        );
    }
}

#[tokio::test]
async fn discover_models_strips_gemini_prefix_and_dedupes() {
    let (base_url, _) = spawn_discovery_server(
        200,
        r#"{"models":[{"name":"models/gemini-a"},{"name":"gemini-a"},{"name":"models/gemini-b"}]}"#,
    )
    .await;
    let models =
        discover_v3_provider_models("discover-provider", "gemini", &base_url, &discovery_auth())
            .await
            .unwrap();
    assert_eq!(models, vec!["gemini-a".to_string(), "gemini-b".to_string()]);
}

#[tokio::test]
async fn discover_models_failure_is_typed_and_never_leaks_the_secret() {
    let (base_url, _) = spawn_discovery_server(401, r#"{"error":{"message":"bad key"}}"#).await;
    let error = discover_v3_provider_models(
        "discover-provider",
        "openai_chat",
        &base_url,
        &discovery_auth(),
    )
    .await
    .expect_err("HTTP 401 must not be reported as success");
    let rendered = error.to_string();
    assert!(
        rendered.contains("401"),
        "failure must carry the real status, got {rendered}"
    );
    assert!(
        !rendered.contains(DISCOVERY_SECRET),
        "failure must not echo the resolved secret, got {rendered}"
    );
}

#[tokio::test]
async fn discover_models_rejects_unrecognized_shape_instead_of_guessing() {
    let (base_url, _) = spawn_discovery_server(200, r#"{"unexpected":[]}"#).await;
    let error = discover_v3_provider_models(
        "discover-provider",
        "openai_chat",
        &base_url,
        &discovery_auth(),
    )
    .await
    .expect_err("unrecognized body shape must not yield a guessed list");
    assert!(error.to_string().contains("unrecognized"), "got {error}");
}

#[tokio::test]
async fn discover_models_rejects_unknown_provider_type_without_network_call() {
    let error = discover_v3_provider_models(
        "discover-provider",
        "carrier_pigeon",
        "http://127.0.0.1:1",
        &discovery_auth(),
    )
    .await
    .expect_err("unknown provider type must fail explicitly");
    assert!(error.to_string().contains("carrier_pigeon"), "got {error}");
}
