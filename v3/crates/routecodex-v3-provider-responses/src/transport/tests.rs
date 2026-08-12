use super::*;
use crate::wire::{
    build_v3_provider_12_responses_wire_payload, V3ProviderAuthSecretHandle,
    V3ResponsesProviderTarget,
};
use routecodex_v3_config::V3ResponsesTransportKind;
use serde_json::json;

fn responses_http_target() -> V3ResponsesProviderTarget {
    V3ResponsesProviderTarget {
        provider_id: "orangeai".into(),
        provider_type: "responses".into(),
        base_url: "https://api2.orangeai.cc/v1".into(),
        canonical_model_id: "glm-5.2".into(),
        wire_model: "glm-5.2".into(),
        auth: V3ProviderAuthHandle {
            alias: "key1".into(),
            secret: V3ProviderAuthSecretHandle::Environment("ORANGEAI_KEY".into()),
        },
        responses_transport: V3ResponsesTransportKind::Http,
        websocket_v2_url: None,
        provider_request_cleanup: Default::default(),
        request_timeout_ms: 300_000,
        initial_concurrency_budget: 8,
    }
}

fn reasoning_stop_tool_fixture() -> Value {
    json!({
        "type":"function",
        "name":"reasoningStop",
        "description":"Use stop schema. Minimal continue sample. Minimal finished sample. Minimal blocked sample. Schema repair sample. stopreason=0 stopreason=1 stopreason=2",
        "parameters":{
            "type":"object",
            "properties":{
                "stopreason":{"type":"integer","enum":[0,1,2]},
                "reason":{"type":"string"},
                "current_goal":{"type":"string"},
                "has_evidence":{"type":"integer","enum":[0,1]},
                "evidence":{"type":"string"},
                "next_step":{"type":"string"},
                "needs_user_input":{"type":"boolean"}
            },
            "required":["stopreason"]
        }
    })
}

#[test]
fn provider_request_projection_preserves_transport_headers_verbatim() {
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
    assert_eq!(projection["headers"]["x-api-key"], "secret-value");
    assert!(!projection.to_string().contains("[REDACTED]"));
    assert_eq!(projection["body"]["input"], "original");
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
    let reasoning_stop = reasoning_stop_tool_fixture();
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-responses-additional-tools",
        responses_http_target(),
        json!({
            "model":"glm-5.2",
            "instructions":"stopreason reasoningStop <rcc_stop_schema>",
            "input":[
                {
                    "type":"additional_tools",
                    "role":"developer",
                    "tools":[original_exec.clone(), original_wait.clone(), reasoning_stop.clone()]
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
    assert_eq!(request.body()["input"][0]["tools"][2], reasoning_stop);
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
        .contains("stopreason"));
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
    let auth_env = "RCCV3_TEST_HTTP_STATUS_KEY";
    std::env::set_var(auth_env, "sk-test-http-status");
    let request = build_v3_transport_13_responses_http_request_from_parts(
        request_id,
        "http-status-provider",
        url,
        V3ProviderAuthHandle {
            alias: "key1".into(),
            secret: V3ProviderAuthSecretHandle::Environment(auth_env.into()),
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
    std::env::remove_var("RCCV3_TEST_HTTP_STATUS_KEY");

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
    std::env::remove_var("RCCV3_TEST_HTTP_STATUS_KEY");

    match error {
        V3ProviderError::HttpStatus { response } => {
            assert_eq!(response.status, 502);
            assert!(response.body.is_empty());
        }
        other => panic!("expected HTTP status error, got {other:?}"),
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
    std::env::remove_var("RCCV3_TEST_HTTP_STATUS_KEY");
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
