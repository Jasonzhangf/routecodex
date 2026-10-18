use super::*;

const CLIENT_MODEL: &str = "claude-signature-client";
const WIRE_MODEL: &str = "signature-wire-model";
const TOOL_NAME: &str = "signature_add";
const TOOL_DESCRIPTION: &str = "Add two integers for the signature round trip";
const CALL_ID: &str = "call_signature_roundtrip";
const THINKING: &str = "Add the two integers before returning the tool call.";
const ARGUMENTS: &str = r#"{"left":19,"right":23}"#;
const FINAL_TEXT: &str = "signature roundtrip complete";

#[derive(Clone)]
struct SignatureUpstream {
    captures: mpsc::UnboundedSender<Value>,
    signature: String,
}

async fn signature_upstream(
    State(state): State<SignatureUpstream>,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    if body["input"].to_string().contains("ping; reply pong") {
        return response_sse(json!([{
            "type":"message",
            "role":"assistant",
            "content":[{"type":"output_text","text":"pong"}]
        }]));
    }
    let violations = signature_request_violations(&uri, &body, &state.signature);
    state
        .captures
        .send(json!({
            "path": uri.path(),
            "body": body.clone(),
            "same_source_violations": violations,
        }))
        .unwrap();
    if !violations.is_empty() {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"message":violations.join("; ")}}).to_string(),
            ))
            .unwrap();
    }

    if is_followup(&body) {
        response_sse(json!([{
            "type":"message",
            "role":"assistant",
            "content":[{"type":"output_text","text":FINAL_TEXT}]
        }]))
    } else {
        response_sse(json!([
            {
                "type":"reasoning",
                "summary":[{"type":"summary_text","text":THINKING}],
                "encrypted_content":state.signature
            },
            {
                "type":"function_call",
                "call_id":CALL_ID,
                "name":TOOL_NAME,
                "arguments":ARGUMENTS
            }
        ]))
    }
}

fn response_sse(output: Value) -> Response<Body> {
    let created = json!({
        "type":"response.created",
        "response":{"id":"resp_signature","status":"in_progress","output":[]}
    });
    let completed = json!({
        "type":"response.completed",
        "response":{
            "id":"resp_signature",
            "status":"completed",
            "output":output
        }
    });
    let text = format!(
        "event: response.created\ndata: {created}\n\n\
event: response.completed\ndata: {completed}\n\n\
data: [DONE]\n\n"
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(text))
        .unwrap()
}

fn is_followup(body: &Value) -> bool {
    body["input"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["type"] == "function_call_output")
    })
}

fn signature_request_violations(uri: &Uri, body: &Value, signature: &str) -> Vec<String> {
    let mut violations = Vec::new();
    if uri.path() != "/v1/responses" {
        violations.push(format!("unexpected provider path: {}", uri.path()));
    }
    if body["model"] != WIRE_MODEL {
        violations.push(format!("wire model changed: {body}"));
    }
    if body["stream"] != true {
        violations.push(format!("provider request must be streaming: {body}"));
    }
    if body.get("messages").is_some() {
        violations.push("Anthropic messages leaked to the Responses provider".into());
    }
    let tools = body["tools"].as_array().cloned().unwrap_or_default();
    if tools.len() != 1
        || tools[0]["type"] != "function"
        || tools[0]["name"] != TOOL_NAME
        || tools[0]["description"] != TOOL_DESCRIPTION
        || tools[0]["parameters"]["properties"]["left"]["type"] != "integer"
        || tools[0]["parameters"]["properties"]["right"]["type"] != "integer"
    {
        violations.push(format!("tool declaration changed: {body}"));
    }
    let items = body["input"].as_array().cloned().unwrap_or_default();
    if !items.iter().any(|item| {
        item["type"] == "message"
            && item["role"] == "user"
            && item["content"].as_array().is_some_and(|content| {
                content
                    .iter()
                    .any(|part| part["text"] == "Run signature_add with 19 and 23.")
            })
    }) {
        violations.push(format!("first user request changed: {body}"));
    }
    if is_followup(body) {
        let reasoning = items.iter().find(|item| item["type"] == "reasoning");
        let call = items.iter().find(|item| item["type"] == "function_call");
        let output = items
            .iter()
            .find(|item| item["type"] == "function_call_output");
        if !reasoning.is_some_and(|item| {
            item["summary"][0]["text"] == THINKING
                && item.get("encrypted_content").and_then(Value::as_str) == Some(signature)
        }) {
            violations.push(format!("paired reasoning signature changed: {body}"));
        }
        if !call.is_some_and(|item| {
            item["call_id"] == CALL_ID
                && item["name"] == TOOL_NAME
                && item["arguments"] == ARGUMENTS
        }) {
            violations.push(format!("paired function call changed: {body}"));
        }
        if !output.is_some_and(|item| item["call_id"] == CALL_ID && item["output"] == "42") {
            violations.push(format!("paired tool output changed: {body}"));
        }
    } else if items
        .iter()
        .any(|item| matches!(item["type"].as_str(), Some("reasoning" | "function_call")))
    {
        violations.push("first turn unexpectedly contained tool history".into());
    }
    violations
}

fn manifest(
    server_port: u16,
    upstream_base_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let hub_v1_declaration = hub_v1_fixture::hub_v1_test_declaration();
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}

[servers.signature]
bind = "127.0.0.1"
port = {server_port}
routing_group = "signature"
endpoints = ["anthropic"]
{server_execution}

[providers.signature]
type = "responses"
base_url = "{upstream_base_url}/v1"
default_model = "{WIRE_MODEL}"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "V3_NAMESPACE_PUBLIC_KEY" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "always" }}

[providers.signature.models.{WIRE_MODEL}]
wire_name = "{WIRE_MODEL}"
aliases = ["{CLIENT_MODEL}"]
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "tool_outputs", "reasoning"]

[route_groups.signature.pools.signature]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "anthropic", models = ["{CLIENT_MODEL}"] }}
targets = [{{ kind = "provider_model", provider = "signature", model = "{WIRE_MODEL}", key = "controlled", priority = 1 }}]

[route_groups.signature.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "signature", model = "{WIRE_MODEL}", key = "controlled", priority = 1 }}]
"#,
        server_execution = hub_v1_fixture::hub_v1_server_execution("signature"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn spawn_signature_upstream(
    signature: String,
) -> (String, mpsc::UnboundedReceiver<Value>, oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(signature_upstream))
        .with_state(SignatureUpstream {
            captures: captures_tx,
            signature,
        });
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{address}"), captures_rx, shutdown_tx)
}

fn request_payload(messages: Value) -> Value {
    json!({
        "model":CLIENT_MODEL,
        "max_tokens":128,
        "stream":true,
        "tools":[{
            "name":TOOL_NAME,
            "description":TOOL_DESCRIPTION,
            "input_schema":{
                "type":"object",
                "properties":{
                    "left":{"type":"integer"},
                    "right":{"type":"integer"}
                },
                "required":["left","right"]
            }
        }],
        "messages":messages
    })
}

fn first_messages() -> Value {
    json!([{"role":"user","content":"Run signature_add with 19 and 23."}])
}

fn parse_first_client_response(text: &str, signature: &str) -> Value {
    let events = sse_events(text);
    let thinking = events
        .iter()
        .filter(|event| event["delta"]["type"] == "thinking_delta")
        .filter_map(|event| event["delta"]["thinking"].as_str())
        .collect::<String>();
    assert_eq!(thinking, THINKING, "{text}");
    let signature_events = events
        .iter()
        .filter(|event| event["delta"]["type"] == "signature_delta")
        .collect::<Vec<_>>();
    assert_eq!(signature_events.len(), 1, "{text}");
    assert_eq!(signature_events[0]["delta"]["signature"], signature);
    let call = events
        .iter()
        .find(|event| {
            event["type"] == "content_block_start" && event["content_block"]["type"] == "tool_use"
        })
        .and_then(|event| event["content_block"].as_object())
        .cloned()
        .expect("Anthropic SSE must expose the complete tool_use block");
    assert_eq!(call["id"], CALL_ID);
    assert_eq!(call["name"], TOOL_NAME);
    assert_eq!(call["input"], json!({"left":19,"right":23}));
    assert!(
        events.iter().any(|event| event["type"] == "message_stop"),
        "missing message_stop: {text}"
    );
    Value::Object(call)
}

fn execute_signature_tool(call: &Value) -> String {
    let left = call["input"]["left"].as_i64().unwrap();
    let right = call["input"]["right"].as_i64().unwrap();
    let output = (left + right).to_string();
    eprintln!(
        "EVIDENCE_ANTHROPIC_SIGNATURE_CONSUMER call_id={} input={} output={output}",
        call["id"], call["input"]
    );
    output
}

fn second_messages(signature: &str, call: &Value, output: &str) -> Value {
    json!([
        {"role":"user","content":"Run signature_add with 19 and 23."},
        {"role":"assistant","content":[
            {"type":"thinking","thinking":THINKING,"signature":signature},
            call
        ]},
        {"role":"user","content":[
            {"type":"tool_result","tool_use_id":CALL_ID,"content":output}
        ]}
    ])
}

fn parse_final_client_response(text: &str) {
    let events = sse_events(text);
    let text = events
        .iter()
        .filter(|event| event["delta"]["type"] == "text_delta")
        .filter_map(|event| event["delta"]["text"].as_str())
        .collect::<String>();
    assert_eq!(text, FINAL_TEXT);
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "message_stop")
            .count(),
        1
    );
    assert!(
        events.iter().all(|event| event["type"] != "error"),
        "SSE must finish normally"
    );
}

async fn cooldown_pool(client: &reqwest::Client, base: &str) -> Value {
    client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn run_case(signature: &str) {
    let label = if signature.is_empty() {
        "empty"
    } else {
        "nonempty"
    };
    let _home = TestHomeGuard::new(&format!("anthropic-empty-signature-{label}"));
    let (upstream_base, mut captures, upstream_shutdown) =
        spawn_signature_upstream(signature.to_string()).await;
    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), &upstream_base))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let client = http_client();

    let first_result = send(&client, &endpoint, &request_payload(first_messages())).await;
    let first_capture = capture(&mut captures).await;
    match &first_capture {
        Ok(captured) => eprintln!("EVIDENCE_ANTHROPIC_SIGNATURE_FIRST={captured}"),
        Err(error) => eprintln!("EVIDENCE_ANTHROPIC_SIGNATURE_FIRST_MISSING={error}"),
    }
    if let Err(error) = &first_result {
        eprintln!("EVIDENCE_ANTHROPIC_SIGNATURE_FIRST_CLIENT_ERROR={error}");
    }
    let (status, text) = first_result.unwrap();
    assert_eq!(status, StatusCode::OK, "{text}");
    let first_capture = first_capture.unwrap();
    assert!(
        captured_violations(&first_capture).is_empty(),
        "{first_capture}"
    );
    assert!(
        captures.try_recv().is_err(),
        "first turn must use one provider attempt"
    );
    let call = parse_first_client_response(&text, signature);
    let output = execute_signature_tool(&call);
    assert_eq!(output, "42");
    let base = format!("http://{}", handle.listeners[0].addr);
    let after_first = cooldown_pool(&client, &base).await;
    eprintln!("EVIDENCE_ANTHROPIC_SIGNATURE_HEALTH_AFTER_FIRST={after_first}");
    assert!(
        after_first["entries"].as_array().is_some_and(Vec::is_empty),
        "successful first turn must not create provider health entries: {after_first}"
    );

    let second_payload = request_payload(second_messages(signature, &call, &output));
    eprintln!("EVIDENCE_ANTHROPIC_SIGNATURE_SECOND_CLIENT_REQUEST={second_payload}");
    let second_result = send(&client, &endpoint, &second_payload).await;
    let second_capture = capture(&mut captures).await;
    match &second_capture {
        Ok(captured) => eprintln!("EVIDENCE_ANTHROPIC_SIGNATURE_SECOND={captured}"),
        Err(error) => eprintln!("EVIDENCE_ANTHROPIC_SIGNATURE_SECOND_MISSING={error}"),
    }
    if let Err(error) = &second_result {
        eprintln!("EVIDENCE_ANTHROPIC_SIGNATURE_SECOND_CLIENT_ERROR={error}");
    }
    let (status, text) = second_result.unwrap();
    assert_eq!(status, StatusCode::OK, "{text}");
    let second_capture = second_capture.unwrap();
    assert!(
        captured_violations(&second_capture).is_empty(),
        "{second_capture}"
    );
    assert!(
        captures.try_recv().is_err(),
        "follow-up turn must use one provider attempt"
    );
    eprintln!("EVIDENCE_ANTHROPIC_SIGNATURE_SECOND={second_capture}");
    parse_final_client_response(&text);

    let pool = cooldown_pool(&client, &base).await;
    assert!(
        pool["entries"].as_array().is_some_and(Vec::is_empty),
        "signature round trip must not create provider health entries: {pool}"
    );

    handle.shutdown().await;
    upstream_shutdown.send(()).unwrap();
}

pub(super) async fn run() {
    let _guard = TEST_LOCK.lock().await;
    run_case("").await;
    run_case("sig-nonempty").await;
    run_case(" padded signature ").await;
}
