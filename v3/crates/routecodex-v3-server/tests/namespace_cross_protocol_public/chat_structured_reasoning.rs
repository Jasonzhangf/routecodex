use super::*;

const CLIENT_MODEL: &str = "chat-reasoning-client";
const WIRE_MODEL: &str = "chat-reasoning-wire";
const TOOL_NAME: &str = "reasoning_add";
const TOOL_DESCRIPTION: &str = "Add two integers for the structured reasoning round trip";
const CALL_ID: &str = "call_structured_reasoning_add";
const THINKING: &str = "Add the two integers before returning the tool call.";
const ARGUMENTS: &str = r#"{"left":19,"right":23}"#;
const FINAL_TEXT: &str = "structured reasoning roundtrip complete";
const USER_TEXT: &str = "Run reasoning_add with 19 and 23.";

#[derive(Clone, Copy, Debug)]
enum ClientKind {
    Responses,
    Anthropic,
}

impl ClientKind {
    fn label(self) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::Anthropic => "anthropic",
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Self::Responses => "/v1/responses",
            Self::Anthropic => "/v1/messages",
        }
    }

    fn stream(self) -> bool {
        matches!(self, Self::Anthropic)
    }
}

#[derive(Clone)]
struct ChatUpstreamState {
    captures: mpsc::UnboundedSender<Value>,
    signature: String,
    expected_stream: bool,
}

async fn strict_chat_upstream(
    State(state): State<ChatUpstreamState>,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    if is_health_probe(&body) {
        return chat_completion(json!({"role":"assistant","content":"pong"}), "stop", false);
    }

    let followup = is_followup(&body);
    let violations = chat_violations(
        &uri,
        &body,
        &state.signature,
        state.expected_stream,
        followup,
    );
    state
        .captures
        .send(json!({
            "path": uri.path(),
            "body": body.clone(),
            "followup": followup,
            "same_source_violations": violations.clone(),
        }))
        .unwrap();

    if has_nonstring_reasoning(&body) {
        return Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "error": {
                        "message": "cannot unmarshal object into Go struct field Message.messages.reasoning of type string",
                        "type": "api_error",
                        "param": null,
                        "code": "api_error11101"
                    }
                })
                .to_string(),
            ))
            .unwrap();
    }

    if !violations.is_empty() {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"message":violations.join("; ")}}).to_string(),
            ))
            .unwrap();
    }

    let stream = body["stream"].as_bool().unwrap_or(false);
    if followup {
        chat_completion(
            json!({"role":"assistant","content":FINAL_TEXT}),
            "stop",
            stream,
        )
    } else {
        let mut message = json!({
            "role":"assistant",
            "content":null,
            "reasoning_content":THINKING,
            "tool_calls":[{
                "id":CALL_ID,
                "type":"function",
                "function":{"name":TOOL_NAME,"arguments":ARGUMENTS}
            }]
        });
        if !state.expected_stream {
            message["reasoning"] = json!({
                "summary":[{"type":"summary_text","text":THINKING}],
                "content":[{"type":"reasoning_text","text":THINKING}],
                "encrypted_content":state.signature
            });
        }
        chat_completion(
            message,
            "tool_calls",
            // The controlled provider returns a complete JSON business response.
            // Client SSE framing is independent of provider response framing.
            false,
        )
    }
}

fn is_health_probe(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages
            .iter()
            .any(|message| message["content"].as_str() == Some("ping; reply pong"))
    })
}

fn is_followup(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages.iter().any(|message| {
            message["role"] == "tool"
                || message["tool_calls"]
                    .as_array()
                    .is_some_and(|calls| !calls.is_empty())
        })
    })
}

fn has_nonstring_reasoning(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages.iter().any(|message| {
            message
                .get("reasoning")
                .is_some_and(|reasoning| !reasoning.is_string())
        })
    })
}

fn chat_violations(
    uri: &Uri,
    body: &Value,
    signature: &str,
    expected_stream: bool,
    followup: bool,
) -> Vec<String> {
    let mut violations = Vec::new();
    if uri.path() != "/v1/chat/completions" {
        violations.push(format!("unexpected provider path: {}", uri.path()));
    }
    if body["model"] != WIRE_MODEL {
        violations.push(format!("wire model changed: {body}"));
    }
    if body["stream"].as_bool() != Some(expected_stream) {
        violations.push(format!(
            "provider stream intent changed: expected {expected_stream}, got {body}"
        ));
    }
    if body["tools"] != expected_chat_tools() {
        violations.push(format!("tool declarations changed: {body}"));
    }
    if body["tool_choice"] != expected_chat_tool_choice() {
        violations.push(format!("forced tool choice changed: {body}"));
    }
    let Some(messages) = body["messages"].as_array() else {
        violations.push(format!("Chat provider request requires messages: {body}"));
        return violations;
    };

    if !followup {
        if messages != &[json!({"role":"user","content":USER_TEXT})] {
            violations.push(format!("first turn history changed: {body}"));
        }
        if messages
            .iter()
            .any(|message| message.get("reasoning").is_some())
        {
            violations.push(format!(
                "first turn unexpectedly carried reasoning history: {body}"
            ));
        }
        return violations;
    }

    if messages.len() != 3 {
        violations.push(format!(
            "follow-up must preserve exactly user, assistant, and tool history: {body}"
        ));
    }
    if messages.first() != Some(&json!({"role":"user","content":USER_TEXT})) {
        violations.push(format!("first user message changed: {body}"));
    }

    let Some(assistant) = messages.get(1) else {
        violations.push(format!("missing assistant tool-call history: {body}"));
        return violations;
    };
    if assistant["role"] != "assistant" {
        violations.push(format!("assistant history order changed: {body}"));
    }
    if !assistant
        .get("content")
        .is_none_or(|value| value.is_null() || value.as_str() == Some(""))
    {
        violations.push(format!(
            "the canonical assistant tool-call message must remain contentless: {body}"
        ));
    }
    match assistant.get("reasoning").and_then(Value::as_str) {
        Some(reasoning) => match serde_json::from_str::<Value>(reasoning) {
            Ok(decoded) if decoded == json!({"encrypted_content":signature}) => {}
            Ok(decoded) => violations.push(format!(
                "message.reasoning must decode to the complete signature object, got {decoded}: {body}"
            )),
            Err(error) => violations.push(format!(
                "message.reasoning must be a JSON-encoded signature object: {error}: {body}"
            )),
        },
        None => violations.push(format!(
            "follow-up assistant history must carry string message.reasoning: {body}"
        )),
    }
    let calls = assistant["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let expected_call = json!({
        "id":CALL_ID,
        "type":"function",
        "function":{"name":TOOL_NAME,"arguments":ARGUMENTS}
    });
    if calls != [expected_call] {
        violations.push(format!(
            "assistant tool call id, name, or arguments changed: {body}"
        ));
    }

    let Some(tool) = messages.get(2) else {
        violations.push(format!("missing paired tool result history: {body}"));
        return violations;
    };
    if tool != &json!({"role":"tool","tool_call_id":CALL_ID,"content":"42"}) {
        violations.push(format!("paired tool result history changed: {body}"));
    }
    violations
}

fn expected_chat_tools() -> Value {
    json!([{
        "type":"function",
        "function":{
            "name":TOOL_NAME,
            "description":TOOL_DESCRIPTION,
            "parameters":tool_parameters()
        }
    }])
}

fn expected_chat_tool_choice() -> Value {
    json!({"type":"function","function":{"name":TOOL_NAME}})
}

fn tool_parameters() -> Value {
    json!({
        "type":"object",
        "properties":{
            "left":{"type":"integer"},
            "right":{"type":"integer"}
        },
        "required":["left","right"],
        "additionalProperties":false
    })
}

fn chat_completion(message: Value, finish_reason: &str, stream: bool) -> Response<Body> {
    if stream {
        let chunk = json!({
            "id":"chatcmpl_structured_reasoning",
            "object":"chat.completion.chunk",
            "created":1784812451,
            "model":WIRE_MODEL,
            "choices":[{
                "index":0,
                "delta":message,
                "finish_reason":finish_reason
            }],
            "usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}
        });
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(format!("data: {chunk}\n\ndata: [DONE]\n\n")))
            .unwrap()
    } else {
        let body = json!({
            "id":"chatcmpl_structured_reasoning",
            "object":"chat.completion",
            "created":1784812451,
            "model":WIRE_MODEL,
            "choices":[{
                "index":0,
                "message":message,
                "finish_reason":finish_reason
            }],
            "usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}
        });
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }
}

fn manifest(
    server_port: u16,
    upstream_base_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let declaration =
        hub_v1_fixture::hub_v1_test_declaration().replace(direct_binding, relay_binding);
    let source = format!(
        r#"
version = 3
{declaration}

[servers.reasoning]
bind = "127.0.0.1"
port = {server_port}
routing_group = "reasoning"
endpoints = ["responses", "anthropic"]
{server_execution}

[providers.reasoning]
type = "openai_chat"
base_url = "{upstream_base_url}/v1"
default_model = "{WIRE_MODEL}"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "V3_NAMESPACE_PUBLIC_KEY" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "client" }}

[providers.reasoning.models.{WIRE_MODEL}]
wire_name = "{WIRE_MODEL}"
aliases = ["{CLIENT_MODEL}"]
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning"]

[route_groups.reasoning.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["{CLIENT_MODEL}"] }}
targets = [{{ kind = "provider_model", provider = "reasoning", model = "{WIRE_MODEL}", key = "controlled", priority = 1 }}]

[route_groups.reasoning.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "reasoning", model = "{WIRE_MODEL}", key = "controlled", priority = 1 }}]

[debug]
log_console = false
"#,
        server_execution = hub_v1_fixture::hub_v1_server_execution("reasoning"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn spawn_chat_upstream(
    signature: &str,
    expected_stream: bool,
) -> (String, mpsc::UnboundedReceiver<Value>, oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(strict_chat_upstream))
        .with_state(ChatUpstreamState {
            captures: captures_tx,
            signature: signature.to_string(),
            expected_stream,
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

fn responses_tools() -> Value {
    json!([{
        "type":"function",
        "name":TOOL_NAME,
        "description":TOOL_DESCRIPTION,
        "parameters":tool_parameters()
    }])
}

fn anthropic_tools() -> Value {
    json!([{
        "name":TOOL_NAME,
        "description":TOOL_DESCRIPTION,
        "input_schema":tool_parameters()
    }])
}

fn responses_first_request() -> Value {
    json!({
        "model":CLIENT_MODEL,
        "stream":false,
        "input":[{"role":"user","content":USER_TEXT}],
        "tools":responses_tools(),
        "tool_choice":{"type":"function","name":TOOL_NAME}
    })
}

fn anthropic_first_request() -> Value {
    json!({
        "model":CLIENT_MODEL,
        "max_tokens":128,
        "stream":true,
        "tools":anthropic_tools(),
        "tool_choice":{"type":"tool","name":TOOL_NAME},
        "messages":[{"role":"user","content":USER_TEXT}]
    })
}

fn parse_responses_first(status: StatusCode, text: &str, signature: &str) -> (Value, Value) {
    let body = parsed(status, text).unwrap();
    let items = output_items(&body).unwrap();
    let reasoning = item(&items, "reasoning")
        .cloned()
        .unwrap_or_else(|| panic!("Responses output must expose reasoning: {body}"));
    let call = item(&items, "function_call")
        .cloned()
        .unwrap_or_else(|| panic!("Responses output must expose a function_call: {body}"));
    assert_eq!(
        reasoning["summary"][0]["text"], THINKING,
        "reasoning summary changed: {reasoning}"
    );
    assert_eq!(
        reasoning["encrypted_content"], signature,
        "Responses reasoning signature changed: {reasoning}"
    );
    assert_eq!(call["call_id"], CALL_ID, "{call}");
    assert_eq!(call["name"], TOOL_NAME, "{call}");
    assert_eq!(call["arguments"], ARGUMENTS, "{call}");
    (reasoning, call)
}

fn parse_anthropic_first(text: &str) -> Value {
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
    assert!(
        signature_events.is_empty(),
        "Chat provider did not supply a signature: {text}"
    );
    let call = events
        .iter()
        .find(|event| {
            event["type"] == "content_block_start" && event["content_block"]["type"] == "tool_use"
        })
        .and_then(|event| event["content_block"].as_object())
        .cloned()
        .unwrap_or_else(|| panic!("Anthropic SSE must expose a complete tool_use block: {text}"));
    assert_eq!(call["id"], CALL_ID);
    assert_eq!(call["name"], TOOL_NAME);
    assert_eq!(call["input"], json!({"left":19,"right":23}));
    assert!(
        events.iter().any(|event| event["type"] == "message_stop"),
        "missing message_stop: {text}"
    );
    Value::Object(call)
}

fn execute_tool(call: &Value, client_kind: ClientKind) -> String {
    let (arguments, call_id) = match client_kind {
        ClientKind::Responses => (
            serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
            &call["call_id"],
        ),
        ClientKind::Anthropic => (call["input"].clone(), &call["id"]),
    };
    let output =
        (arguments["left"].as_i64().unwrap() + arguments["right"].as_i64().unwrap()).to_string();
    eprintln!(
        "EVIDENCE_CHAT_REASONING_CONSUMER call_id={} arguments={} output={output}",
        call_id, arguments
    );
    output
}

fn responses_followup(reasoning: &Value, call: &Value, output: &str) -> Value {
    json!({
        "model":CLIENT_MODEL,
        "stream":false,
        "input":[
            {"role":"user","content":USER_TEXT},
            reasoning.clone(),
            call.clone(),
            {"type":"function_call_output","call_id":CALL_ID,"output":output}
        ],
        "tools":responses_tools(),
        "tool_choice":{"type":"function","name":TOOL_NAME}
    })
}

fn anthropic_followup(signature: &str, call: &Value, output: &str) -> Value {
    // The signature is client-supplied history, as in the reported Claude
    // request. Tool identity/arguments and the executed result come from the
    // actual first response. Provider-supplied signature preservation has its
    // separate Responses-to-Anthropic round-trip regression.
    json!({
        "model":CLIENT_MODEL,
        "max_tokens":128,
        "stream":true,
        "tools":anthropic_tools(),
        "tool_choice":{"type":"tool","name":TOOL_NAME},
        "messages":[
            {"role":"user","content":USER_TEXT},
            {"role":"assistant","content":[
                {"type":"thinking","thinking":THINKING,"signature":signature},
                call.clone()
            ]},
            {"role":"user","content":[
                {"type":"tool_result","tool_use_id":CALL_ID,"content":output}
            ]}
        ]
    })
}

fn assert_responses_final(status: StatusCode, text: &str) {
    let body = parsed(status, text).unwrap();
    let visible = body["output"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "message")
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter_map(|part| part["text"].as_str())
        .collect::<String>();
    assert_eq!(visible, FINAL_TEXT, "{body}");
}

fn assert_anthropic_final(text: &str) {
    let events = sse_events(text);
    let visible = events
        .iter()
        .filter(|event| event["delta"]["type"] == "text_delta")
        .filter_map(|event| event["delta"]["text"].as_str())
        .collect::<String>();
    assert_eq!(visible, FINAL_TEXT, "{text}");
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

async fn public_exchange(
    client: &reqwest::Client,
    endpoint: &str,
    payload: &Value,
    captures: &mut mpsc::UnboundedReceiver<Value>,
    label: &str,
) -> (Result<(StatusCode, String), String>, Option<Value>) {
    let (client_result, captured) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(12), send(client, endpoint, payload)),
        capture(captures)
    );
    let client_result = match client_result {
        Ok(result) => result,
        Err(_) => Err(format!("{label} public entry did not terminate within 12s")),
    };
    if let Ok(capture) = &captured {
        eprintln!("EVIDENCE_{label}_UPSTREAM={capture}");
    }
    if let Err(error) = &client_result {
        eprintln!("EVIDENCE_{label}_CLIENT_ERROR={error}");
    }
    (client_result, captured.ok())
}

fn assert_single_business_attempt(captures: &mut mpsc::UnboundedReceiver<Value>, label: &str) {
    if let Ok(extra) = captures.try_recv() {
        panic!("{label} must use exactly one business provider attempt, got extra: {extra}");
    }
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

async fn run_case(client_kind: ClientKind, signature: &str, label: &str) {
    let _home = TestHomeGuard::new(&format!(
        "chat-structured-reasoning-{}-{label}",
        client_kind.label()
    ));
    let (upstream_base, mut captures, upstream_shutdown) =
        spawn_chat_upstream(signature, client_kind.stream()).await;
    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), &upstream_base))
        .await
        .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}{}", client_kind.endpoint());
    let client = http_client();

    let first_payload = match client_kind {
        ClientKind::Responses => responses_first_request(),
        ClientKind::Anthropic => anthropic_first_request(),
    };
    let first_label = format!("CHAT_REASONING_{}_{}_FIRST", client_kind.label(), label);
    let (first_result, first_capture) = public_exchange(
        &client,
        &endpoint,
        &first_payload,
        &mut captures,
        &first_label,
    )
    .await;
    let (first_status, first_text) = first_result.unwrap();
    assert_eq!(first_status, StatusCode::OK, "{first_text}");
    let first_capture = first_capture.unwrap_or_else(|| panic!("{first_label}: no capture"));
    assert!(
        captured_violations(&first_capture).is_empty(),
        "{first_capture}"
    );
    assert_single_business_attempt(&mut captures, &first_label);

    let (second_payload, call) = match client_kind {
        ClientKind::Responses => {
            let (reasoning, call) = parse_responses_first(first_status, &first_text, signature);
            let output = execute_tool(&call, client_kind);
            assert_eq!(output, "42");
            (responses_followup(&reasoning, &call, &output), call)
        }
        ClientKind::Anthropic => {
            let call = parse_anthropic_first(&first_text);
            let output = execute_tool(&call, client_kind);
            assert_eq!(output, "42");
            (anthropic_followup(signature, &call, &output), call)
        }
    };
    assert_eq!(call["name"], TOOL_NAME);

    let after_first = cooldown_pool(&client, &base).await;
    assert!(
        after_first["entries"].as_array().is_some_and(Vec::is_empty),
        "successful first turn must not create provider health entries: {after_first}"
    );

    let second_label = format!("CHAT_REASONING_{}_{}_FOLLOWUP", client_kind.label(), label);
    let (second_result, second_capture) = public_exchange(
        &client,
        &endpoint,
        &second_payload,
        &mut captures,
        &second_label,
    )
    .await;
    let (second_status, second_text) = second_result.unwrap();
    assert_eq!(second_status, StatusCode::OK, "{second_text}");
    let second_capture = second_capture.unwrap_or_else(|| panic!("{second_label}: no capture"));
    assert!(
        captured_violations(&second_capture).is_empty(),
        "{second_capture}"
    );
    assert_single_business_attempt(&mut captures, &second_label);

    match client_kind {
        ClientKind::Responses => assert_responses_final(second_status, &second_text),
        ClientKind::Anthropic => assert_anthropic_final(&second_text),
    }
    let after_second = cooldown_pool(&client, &base).await;
    assert!(
        after_second["entries"]
            .as_array()
            .is_some_and(Vec::is_empty),
        "successful follow-up must not create provider health entries: {after_second}"
    );

    handle.shutdown().await;
    upstream_shutdown.send(()).unwrap();
}

pub(super) async fn run_responses() {
    let _guard = TEST_LOCK.lock().await;
    for (label, signature) in [
        ("empty", ""),
        ("nonempty", "sig-nonempty"),
        ("padded", " padded signature "),
    ] {
        run_case(ClientKind::Responses, signature, label).await;
    }
}

pub(super) async fn run_anthropic() {
    let _guard = TEST_LOCK.lock().await;
    for (label, signature) in [
        ("empty", ""),
        ("nonempty", "sig-nonempty"),
        ("padded", " padded signature "),
    ] {
        run_case(ClientKind::Anthropic, signature, label).await;
    }
}
