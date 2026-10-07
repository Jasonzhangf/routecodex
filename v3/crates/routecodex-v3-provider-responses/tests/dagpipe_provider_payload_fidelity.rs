use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Router,
};
use routecodex_v3_config::V3ResponsesTransportKind;
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    build_v3_transport_13_responses_request_from_v3_provider_12, ProviderResponsesTransport,
    ResponsesTransport, V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderError,
    V3ProviderResponseBodyKind, V3ResponsesProviderTarget, V3ResponsesStreamIntent,
};
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::{mpsc, oneshot};

const APPLY_PATCH_FREE_TEXT: &str = concat!(
    "*** Begin Patch\n",
    "*** Update File: src/example.rs\n",
    "@@\n",
    "-let value = \"old\";\n",
    "+let value = \"new\";\n",
    "*** End Patch\n",
    "TRAILING_SENTINEL_APPLY_PATCH\n",
);

#[derive(Debug)]
struct Capture {
    accept: Option<String>,
    content_type: Option<String>,
    authorization: Option<String>,
    body_bytes: Vec<u8>,
}

#[derive(Clone)]
struct UpstreamState {
    captures: mpsc::UnboundedSender<Capture>,
    request_count: Arc<AtomicUsize>,
    mode: UpstreamMode,
}

#[derive(Debug, Clone, Copy)]
enum UpstreamMode {
    Success,
    Error,
}

async fn upstream(
    State(state): State<Arc<UpstreamState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    state.request_count.fetch_add(1, Ordering::SeqCst);
    state
        .captures
        .send(Capture {
            accept: headers
                .get("accept")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            content_type: headers
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            authorization: headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            body_bytes: body.to_vec(),
        })
        .expect("capture receiver must remain live for the request");

    if matches!(state.mode, UpstreamMode::Error) {
        return Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from(
                "{\"error\":{\"message\":\"controlled overload\"}}",
            ))
            .unwrap();
    }

    let stream = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|value| value.get("stream").and_then(Value::as_bool))
        .unwrap_or(false);
    if stream {
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(
                "event: response.output_text.delta\ndata: {\"delta\":\"ok\"}\n\ndata: [DONE]\n\n",
            ))
            .unwrap()
    } else {
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from("{\"id\":\"resp-json\",\"output_text\":\"ok\"}"))
            .unwrap()
    }
}

async fn start_provider(
    route: &'static str,
    mode: UpstreamMode,
) -> (
    String,
    mpsc::UnboundedReceiver<Capture>,
    oneshot::Sender<()>,
    Arc<AtomicUsize>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let request_count = Arc::new(AtomicUsize::new(0));
    let state = Arc::new(UpstreamState {
        captures: captures_tx,
        request_count: request_count.clone(),
        mode,
    });
    let app = Router::new().route(route, post(upstream)).with_state(state);
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (
        format!("http://{address}/v1"),
        captures_rx,
        shutdown_tx,
        request_count,
    )
}

fn exec_command() -> String {
    let mut command = String::with_capacity(80_000);
    command.push_str("#!/bin/sh\nset -eu\ncat <<'EOF'\n");
    for index in 0..2_200 {
        writeln!(command, "L{index:05}: literal $HOME `backtick` \\\\ slash").unwrap();
    }
    command.push_str(
        "EOF\nprintf '%s\\n' \"line one\"\nprintf '%s\\n' \"line two with CRLF\r\n\"\nprintf '%s\\n' 'SENTINEL_EXEC_END'\n",
    );
    assert!(command.len() > 70 * 1024);
    assert!(command.ends_with("SENTINEL_EXEC_END'\n"));
    command
}

fn target(
    provider_id: &str,
    base_url: &str,
    wire_model: &str,
    auth_alias: &str,
) -> V3ResponsesProviderTarget {
    V3ResponsesProviderTarget {
        provider_id: provider_id.to_string(),
        provider_type: "responses".to_string(),
        base_url: base_url.to_string(),
        canonical_model_id: wire_model.to_string(),
        wire_model: wire_model.to_string(),
        compatibility_profile: None,
        headers: Default::default(),
        auth: V3ProviderAuthHandle {
            alias: auth_alias.to_string(),
            secret: V3ProviderAuthSecretHandle::ApiKey("v3-proof-secret".to_string()),
        },
        responses_transport: V3ResponsesTransportKind::Http,
        websocket_v2_url: None,
        provider_request_cleanup: Default::default(),
        request_timeout_ms: 30_000,
        sse_first_frame_timeout_ms: Some(30_000),
        initial_concurrency_budget: 4,
        concurrency_acquire_timeout_ms: 1_000,
    }
}

fn request_body(model: &str) -> Value {
    json!({
        "model": model,
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "run the tool"}]
        }],
        "tools": [{
            "type": "function",
            "name": "exec",
            "description": "execute",
            "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}
        }],
        "tool_choice": "auto",
        "parallel_tool_calls": true,
        "unknown_client_sibling": {
            "nested": [1, true, null, {"keep": "exact"}],
            "trailing": "preserve"
        }
    })
}

fn serialize_value(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

fn json_body_from_capture(capture: &Capture) -> Value {
    serde_json::from_slice(&capture.body_bytes).unwrap()
}

#[tokio::test]
async fn json_exec_multiline_crlf_sentinel_arguments_are_wire_and_transport_exact() {
    let command = exec_command();
    let (base_url, mut captures, shutdown, request_count) =
        start_provider("/v1/responses", UpstreamMode::Success).await;
    let model = "provider-json-fidelity";
    let mut body = request_body(model);
    body["tools"][0]["name"] = json!("exec");
    body["tools"][0]["parameters"]["properties"]["command"]["description"] =
        json!("raw shell command; do not parse");
    body["input"] = json!([
        {
            "type": "function_call",
            "name": "exec",
            "arguments": command.clone(),
            "call_id": "call_exec_byte_exact",
            "unknown_call_sibling": {"keep": "call-sibling"}
        },
        {
            "type": "function_call_output",
            "call_id": "call_exec_byte_exact",
            "output": "literal output\r\nSENTINEL_OUTPUT_END\n",
            "unknown_output_sibling": {"keep": "output-sibling"}
        }
    ]);
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-json-fidelity",
        target("provider-json-fidelity", &base_url, model, "primary-json"),
        body.clone(),
    )
    .unwrap();
    assert_eq!(wire.stream_intent(), V3ResponsesStreamIntent::Json);
    assert_eq!(wire.body(), &body);
    assert_eq!(
        wire.body()["input"][0]["arguments"],
        Value::String(command.clone())
    );
    assert!(wire.body()["input"][0]["arguments"].as_str().unwrap().len() > 70 * 1024);

    let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap();
    assert_eq!(request.stream_intent(), V3ResponsesStreamIntent::Json);
    assert_eq!(request.body(), &body);
    assert_eq!(
        request.provider_request_projection()["body"],
        body,
        "transport projection must retain the complete wire body"
    );

    let raw = ProviderResponsesTransport::default()
        .send(request)
        .await
        .unwrap();
    assert_eq!(raw.body_kind(), V3ProviderResponseBodyKind::Json);
    let capture = captures.recv().await.unwrap();
    assert_eq!(capture.accept.as_deref(), Some("application/json"));
    assert_eq!(
        capture.content_type.as_deref(),
        Some("application/json"),
        "JSON intent must be sent as JSON"
    );
    assert_eq!(
        capture.authorization.as_deref(),
        Some("Bearer v3-proof-secret")
    );
    assert_eq!(capture.body_bytes, serialize_value(&body));
    let observed = json_body_from_capture(&capture);
    assert_eq!(observed["input"][0]["arguments"], command);
    assert_eq!(
        observed["input"][0]["unknown_call_sibling"],
        json!({"keep": "call-sibling"})
    );
    assert_eq!(
        observed["input"][1]["output"],
        "literal output\r\nSENTINEL_OUTPUT_END\n"
    );
    assert_eq!(
        observed["input"][1]["unknown_output_sibling"],
        json!({"keep": "output-sibling"})
    );
    assert_eq!(
        observed["unknown_client_sibling"],
        body["unknown_client_sibling"]
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 1);

    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn sse_free_text_apply_patch_and_unknown_siblings_are_byte_exact() {
    let (base_url, mut captures, shutdown, request_count) =
        start_provider("/v1/responses", UpstreamMode::Success).await;
    let model = "provider-sse-fidelity";
    let mut body = request_body(model);
    body["stream"] = json!(true);
    body["input"] = json!([
        {
            "type": "function_call",
            "name": "apply_patch",
            "arguments": APPLY_PATCH_FREE_TEXT,
            "call_id": "call_patch_byte_exact",
            "unknown_patch_sibling": {
                "preserve": ["a", "b"],
                "nested": {"value": "opaque"}
            }
        },
        {
            "type": "function_call_output",
            "call_id": "call_patch_byte_exact",
            "output": APPLY_PATCH_FREE_TEXT,
            "unknown_result_sibling": {"keep": true}
        }
    ]);
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-sse-fidelity",
        target("provider-sse-fidelity", &base_url, model, "primary-sse"),
        body.clone(),
    )
    .unwrap();
    assert_eq!(wire.stream_intent(), V3ResponsesStreamIntent::Sse);
    assert_eq!(wire.body(), &body);
    assert_eq!(
        wire.body()["input"][0]["arguments"],
        Value::String(APPLY_PATCH_FREE_TEXT.to_string())
    );

    let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap();
    assert_eq!(request.stream_intent(), V3ResponsesStreamIntent::Sse);
    assert_eq!(request.body(), &body);

    let raw = ProviderResponsesTransport::default()
        .send(request)
        .await
        .unwrap();
    assert_eq!(raw.body_kind(), V3ProviderResponseBodyKind::Sse);
    let capture = captures.recv().await.unwrap();
    assert_eq!(capture.accept.as_deref(), Some("text/event-stream"));
    assert_eq!(capture.content_type.as_deref(), Some("application/json"));
    assert_eq!(capture.body_bytes, serialize_value(&body));
    let observed = json_body_from_capture(&capture);
    assert_eq!(observed["input"][0]["arguments"], APPLY_PATCH_FREE_TEXT);
    assert_eq!(
        observed["input"][0]["unknown_patch_sibling"],
        json!({"preserve": ["a", "b"], "nested": {"value": "opaque"}})
    );
    assert_eq!(observed["input"][1]["output"], APPLY_PATCH_FREE_TEXT);
    assert_eq!(
        observed["input"][1]["unknown_result_sibling"],
        json!({"keep": true})
    );
    assert_eq!(
        observed["unknown_client_sibling"],
        body["unknown_client_sibling"]
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 1);

    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn namespace_mcp_opaque_arguments_and_result_are_preserved_without_parsing() {
    let (base_url, mut captures, shutdown, request_count) =
        start_provider("/v1/responses", UpstreamMode::Success).await;
    let model = "provider-namespace-fidelity";
    let mcp_arguments = concat!(
        "{\n",
        "  \"view\": \"capabilities\",\n",
        "  \"opaque\": {\"array\": [1, 2, 3], \"literal\": \"$HOME\\\\n\"},\n",
        "  \"sentinel\": \"MCP_ARGUMENTS_SENTINEL\"\n",
        "}\n",
    );
    let mcp_result = concat!(
        "{\n",
        "  \"data\": {\"version\": \"0.9.0\"},\n",
        "  \"opaque\": [true, false, null],\n",
        "  \"sentinel\": \"MCP_RESULT_SENTINEL\"\n",
        "}\n",
    );
    let mut body = request_body(model);
    body["tools"] = json!([
        {
            "type": "namespace",
            "name": "mcpx",
            "description": "opaque MCP namespace",
            "tools": [
                {
                    "type": "function",
                    "name": "runtime_read",
                    "description": "read runtime",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "view": {"type": "string"},
                            "opaque": {"type": "object"},
                            "sentinel": {"type": "string"}
                        },
                        "required": ["view"]
                    }
                }
            ]
        }
    ]);
    body["input"] = json!([
        {
            "type": "function_call",
            "name": "mcpx.runtime_read",
            "arguments": mcp_arguments,
            "call_id": "call_mcp_byte_exact",
            "unknown_namespace_call_sibling": {"keep": "call"}
        },
        {
            "type": "function_call_output",
            "call_id": "call_mcp_byte_exact",
            "output": mcp_result,
            "unknown_namespace_result_sibling": {"keep": "result"}
        }
    ]);
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-namespace-fidelity",
        target(
            "provider-namespace-fidelity",
            &base_url,
            model,
            "primary-namespace",
        ),
        body.clone(),
    )
    .unwrap();
    assert_eq!(wire.body()["tools"][0]["type"], "function");
    assert_eq!(wire.body()["tools"][0]["name"], "mcpx__runtime_read");
    assert_eq!(
        wire.body()["tools"][0]["parameters"],
        body["tools"][0]["tools"][0]["parameters"],
        "namespace flattening must preserve the public schema"
    );
    assert_eq!(
        wire.body()["input"][0]["arguments"],
        Value::String(mcp_arguments.to_string()),
        "MCP arguments are opaque bytes and must not be parsed or rewritten"
    );
    assert_eq!(
        wire.body()["input"][1]["output"],
        Value::String(mcp_result.to_string()),
        "MCP results are opaque bytes and must not be parsed or rewritten"
    );
    assert_eq!(
        wire.body()["input"][0]["unknown_namespace_call_sibling"],
        json!({"keep": "call"})
    );
    assert_eq!(
        wire.body()["input"][1]["unknown_namespace_result_sibling"],
        json!({"keep": "result"})
    );

    let expected_body = wire.body().clone();
    let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap();
    assert_eq!(request.body(), &expected_body);
    let raw = ProviderResponsesTransport::default()
        .send(request)
        .await
        .unwrap();
    assert_eq!(raw.status(), 200);
    let capture = captures.recv().await.unwrap();
    assert_eq!(capture.accept.as_deref(), Some("application/json"));
    assert_eq!(capture.body_bytes, serialize_value(&expected_body));
    let observed = json_body_from_capture(&capture);
    assert_eq!(observed["input"][0]["arguments"], mcp_arguments);
    assert_eq!(observed["input"][1]["output"], mcp_result);
    assert_eq!(
        observed["input"][0]["name"], "mcpx__runtime_read",
        "only the callable name may be rewritten by namespace projection"
    );
    assert_eq!(
        observed["input"][0]["call_id"], "call_mcp_byte_exact",
        "call identity must remain paired"
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 1);

    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn declared_wire_construction_failures_are_typed_and_do_not_reach_provider() {
    let model = "provider-failure-fidelity";
    let base_target = target(
        "provider-failure-fidelity",
        "http://127.0.0.1:9/v1",
        model,
        "primary-failure",
    );

    let invalid_stream = build_v3_provider_12_responses_wire_payload(
        "req-invalid-stream",
        base_target.clone(),
        json!({"model": model, "input": "hello", "stream": "yes"}),
    )
    .unwrap_err();
    assert!(matches!(
        invalid_stream,
        V3ProviderError::InvalidStreamIntent { .. }
    ));

    let invalid_body = build_v3_provider_12_responses_wire_payload(
        "req-invalid-body",
        base_target.clone(),
        json!(["not-an-object"]),
    )
    .unwrap_err();
    assert!(matches!(
        invalid_body,
        V3ProviderError::InvalidWireBody { .. }
    ));

    let control_field = build_v3_provider_12_responses_wire_payload(
        "req-control-field",
        base_target.clone(),
        json!({
            "model": model,
            "input": [{
                "type": "function_call",
                "name": "exec",
                "arguments": "{}",
                "error_chain": {"must": "not-cross"}
            }]
        }),
    )
    .unwrap_err();
    assert!(matches!(
        control_field,
        V3ProviderError::ControlFieldInWireBody { .. }
    ));

    let model_mismatch = build_v3_provider_12_responses_wire_payload(
        "req-model-mismatch",
        base_target,
        json!({"model": "different-model", "input": "hello"}),
    )
    .unwrap_err();
    assert!(matches!(
        model_mismatch,
        V3ProviderError::ProviderModelBindingMismatch { .. }
    ));
}

#[tokio::test]
async fn transport_http_status_failure_preserves_typed_body_and_releases_resources() {
    let (base_url, mut captures, shutdown, request_count) =
        start_provider("/v1/responses", UpstreamMode::Error).await;
    let model = "provider-status-fidelity";
    let body = json!({
        "model": model,
        "input": "hello",
        "tools": [{"type": "function", "name": "exec", "parameters": {"type": "object"}}],
        "unknown_client_sibling": {"keep": "status-failure"}
    });

    let wire = build_v3_provider_12_responses_wire_payload(
        "req-status-fidelity",
        target(
            "provider-status-fidelity",
            &base_url,
            model,
            "primary-status",
        ),
        body.clone(),
    )
    .unwrap();
    let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap();
    let error = ProviderResponsesTransport::default()
        .send(request)
        .await
        .unwrap_err();

    match error {
        V3ProviderError::HttpStatus { response } => {
            assert_eq!(response.status, 503);
            assert_eq!(
                response.body,
                br#"{"error":{"message":"controlled overload"}}"#.to_vec()
            );
            assert!(response
                .headers
                .iter()
                .any(|header| header.name.eq_ignore_ascii_case("content-type")));
        }
        other => panic!("expected typed HTTP status failure, got {other:?}"),
    }

    let capture = captures.recv().await.unwrap();
    assert_eq!(capture.body_bytes, serialize_value(&body));
    assert_eq!(request_count.load(Ordering::SeqCst), 1);

    let controller = routecodex_v3_provider_responses::adaptive_concurrency::V3AdaptiveConcurrencyController::process_shared();
    let snapshot = controller
        .snapshot("provider-status-fidelity:primary-status")
        .expect("provider admission must exist after a real attempt");
    assert_eq!(
        snapshot.in_flight, 0,
        "HTTP status failure must release provider capacity"
    );
    assert!(!snapshot.probe_in_flight);

    shutdown.send(()).unwrap();
}
