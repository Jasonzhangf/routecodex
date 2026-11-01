use super::*;

#[derive(Clone)]
struct MarkerPeer {
    only_labels: bool,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}

async fn upstream(State(peer): State<MarkerPeer>, axum::Json(body): axum::Json<Value>) -> Response {
    let turn = peer.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let messages = body["messages"].as_array().expect("Chat projection");
    assert!(body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["function"]["name"] == "printf42"));
    let followup = messages.iter().any(|message| message["role"] == "tool");
    let arguments = "{\"value\":\"42\"}";
    let (content, tool_calls, finish) = if followup {
        assert_eq!(turn, 1, "successful first attempt cannot be retried");
        assert!(messages.iter().any(|message| message["role"] == "assistant"
            && message["tool_calls"]
                .as_array()
                .is_some_and(
                    |calls| calls.iter().any(|call| call["id"] == "call_relay_marker"
                        && call["function"]["name"] == "printf42"
                        && call["function"]["arguments"] == arguments)
                )));
        assert!(messages.iter().any(|message| message["role"] == "tool"
            && message["tool_call_id"] == "call_relay_marker"
            && message["content"] == "42"));
        ("Calculation returned 42.", json!([]), "stop")
    } else {
        assert_eq!(turn, 0, "initial request must reach first candidate once");
        let content = if peer.only_labels {
            "<｜end▁of▁analysis｜>\n<|DSML|tool_calls>"
        } else {
            "Preparing.\n<｜end▁of▁analysis｜>\n<|DSML|tool_calls>"
        };
        let calls = if peer.only_labels {
            json!([])
        } else {
            json!([{"id":"call_relay_marker","type":"function","function":{"name":"printf42","arguments":arguments}}])
        };
        (
            content,
            calls,
            if peer.only_labels {
                "stop"
            } else {
                "tool_calls"
            },
        )
    };
    if body["stream"] == true {
        let mut wire = String::new();
        // Split labels across valid Chat SSE chunks, before materialization.
        let split = content.find("<|").unwrap_or(content.len());
        for text in [&content[..split], &content[split..]] {
            wire.push_str(&format!("data: {}\n\n", json!({"id":"chat_marker","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":null}]})));
        }
        if let Some(calls) = tool_calls.as_array().filter(|calls| !calls.is_empty()) {
            let mut calls = calls.clone();
            calls[0]["index"] = 0.into();
            wire.push_str(&format!("data: {}\n\n", json!({"id":"chat_marker","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"tool_calls":calls},"finish_reason":null}]})));
        }
        wire.push_str(&format!("data: {}\n\ndata: [DONE]\n\n", json!({"id":"chat_marker","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":finish}]})));
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(wire))
            .unwrap()
    } else {
        Response::builder().header("content-type", "application/json").body(Body::from(json!({"id":"chat_marker","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":content,"tool_calls":tool_calls},"finish_reason":finish}],"provider_extension":{"keep":true}}).to_string())).unwrap()
    }
}

pub(super) fn completed(wire: &str, stream: bool) -> Value {
    if !stream {
        return serde_json::from_str(wire).unwrap();
    }
    wire.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .find(|event| event["type"] == "response.completed")
        .expect("semantic terminal")["response"]
        .clone()
}

pub(super) fn chat_provider_response(
    stream: bool,
    content: &str,
    tool_calls: Value,
    finish: &str,
) -> Response {
    if stream {
        let mut wire = String::new();
        let split = content.find("<|").unwrap_or(content.len());
        for text in [&content[..split], &content[split..]] {
            wire.push_str(&format!("data: {}\n\n", json!({"id":"chat_marker","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":null}]})));
        }
        if let Some(calls) = tool_calls.as_array().filter(|calls| !calls.is_empty()) {
            let mut calls = calls.clone();
            calls[0]["index"] = 0.into();
            wire.push_str(&format!("data: {}\n\n", json!({"id":"chat_marker","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"tool_calls":calls},"finish_reason":null}]})));
        }
        wire.push_str(&format!("data: {}\n\ndata: [DONE]\n\n", json!({"id":"chat_marker","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":finish}]})));
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(wire))
            .unwrap()
    } else {
        Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "id":"chat_marker",
                    "object":"chat.completion",
                    "model":"wire-test",
                    "choices":[{
                        "index":0,
                        "message":{"role":"assistant","content":content,"tool_calls":tool_calls},
                        "finish_reason":finish
                    }],
                    "provider_extension":{"keep":true}
                })
                .to_string(),
            ))
            .unwrap()
    }
}

#[derive(Clone)]
struct StaticChatPeer {
    content: String,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}

async fn static_chat_upstream(
    State(peer): State<StaticChatPeer>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    let turn = peer.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(turn, 0, "static peer must receive exactly one attempt");
    assert!(body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["function"]["name"] == "printf42"));
    chat_provider_response(body["stream"] == true, &peer.content, json!([]), "stop")
}

pub(super) fn marker_recovery_manifest(
    port_a: u16,
    port_b: u16,
    primary_base_url: &str,
    fallback_base_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let mut manifest = responses_relay_provider_protocol_manifest(
        port_a,
        port_b,
        primary_base_url,
        "openai_chat",
        Some(fallback_base_url),
    );
    let chat_responses = manifest
        .providers
        .get("test")
        .and_then(|provider| provider.responses.clone());
    let fallback = manifest
        .providers
        .get_mut("fallback")
        .expect("fallback provider is declared");
    fallback.provider_type = "openai_chat".to_string();
    fallback.responses = chat_responses;
    if let Some(interface) = fallback.interfaces.get_mut("default") {
        interface.provider_type = "openai_chat".to_string();
    }
    manifest
}

pub(super) async fn spawn_marker_upstream<State>(
    state: State,
    handler: axum::routing::MethodRouter<State>,
) -> (u16, tokio::task::JoinHandle<()>)
where
    State: Clone + Send + Sync + 'static,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = Router::new()
        .route("/v1/chat/completions", handler)
        .with_state(state);
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (port, task)
}

async fn run(stream: bool, only_labels: bool) {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let app = Router::new()
        .route("/v1/chat/completions", post(upstream))
        .with_state(MarkerPeer {
            only_labels,
            calls: calls.clone(),
        });
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let port = free_port();
    let handle = spawn_v3_server_aggregate(responses_relay_provider_protocol_manifest(
        port,
        free_port(),
        &format!("http://127.0.0.1:{upstream_port}/v1"),
        "openai_chat",
        None,
    ))
    .await
    .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let url = format!("http://127.0.0.1:{port}/v1/responses");
    let tools = json!([{"type":"function","name":"printf42","parameters":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}}]);
    let first_message = json!({"role":"user","content":"Run the safe fixture calculation."});
    let response = client.post(&url).json(&json!({"model":"client-test","stream":stream,"tools":tools,"input":[first_message.clone()]})).send().await;
    if only_labels {
        if let Ok(response) = response {
            assert!(
                response.bytes().await.is_err(),
                "sole labels must terminate transport, never complete normally"
            );
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    } else {
        let response = response.unwrap();
        assert_eq!(response.status(), 200);
        let wire = response.text().await.unwrap();
        assert!(
            !wire.contains("DSML") && !wire.contains("end▁of▁analysis"),
            "orphan labels leaked: {wire}"
        );
        let first = completed(&wire, stream);
        let output = first["output"].as_array().unwrap();
        let call = output
            .iter()
            .find(|item| item["type"] == "function_call")
            .unwrap();
        assert_eq!(call["name"], "printf42");
        assert_eq!(call["call_id"], "call_relay_marker");
        let arguments: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
        let execution = std::process::Command::new("printf")
            .arg(arguments["value"].as_str().unwrap())
            .output()
            .unwrap();
        assert!(execution.status.success());
        let result = String::from_utf8(execution.stdout).unwrap();
        assert_eq!(result, "42");
        let mut input = vec![first_message];
        input.extend(output.clone());
        input
            .push(json!({"type":"function_call_output","call_id":call["call_id"],"output":result}));
        let followup = client
            .post(&url)
            .json(&json!({"model":"client-test","stream":stream,"tools":tools,"input":input}))
            .send()
            .await
            .unwrap();
        assert_eq!(followup.status(), 200);
        let answer = completed(&followup.text().await.unwrap(), stream);
        assert!(answer.to_string().contains("Calculation returned 42."));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }
    handle.shutdown().await;
    task.abort();
}

#[tokio::test]
async fn relay_control_marker_json_tool_round_trip() {
    run(false, false).await;
}
#[tokio::test]
async fn relay_control_marker_sse_tool_round_trip() {
    run(true, false).await;
}
#[tokio::test]
async fn relay_control_marker_only_json_exhaustion() {
    run(false, true).await;
}
#[tokio::test]
async fn relay_control_marker_only_sse_exhaustion() {
    run(true, true).await;
}

async fn run_marker_recovery(stream: bool) {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let primary_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let fallback_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (primary_port, primary_task) = spawn_marker_upstream(
        StaticChatPeer {
            content: "<｜end▁of▁analysis｜>\n<|DSML|tool_calls>".into(),
            calls: primary_calls.clone(),
        },
        post(static_chat_upstream),
    )
    .await;
    let (fallback_port, fallback_task) = spawn_marker_upstream(
        StaticChatPeer {
            content: "Recovered business response.".into(),
            calls: fallback_calls.clone(),
        },
        post(static_chat_upstream),
    )
    .await;
    let port = free_port();
    let handle = spawn_v3_server_aggregate(marker_recovery_manifest(
        port,
        free_port(),
        &format!("http://127.0.0.1:{primary_port}/v1"),
        &format!("http://127.0.0.1:{fallback_port}/v1"),
    ))
    .await
    .unwrap();
    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/responses"))
        .json(&json!({
            "model":"client-test", "stream":stream,
            "tools":[{"type":"function","name":"printf42","parameters":{"type":"object","properties":{"value":{"type":"string"}}}}],
            "input":"Return the fixture response."
        }))
        .send().await.unwrap();
    assert_eq!(response.status(), 200);
    let wire = response.text().await.unwrap();
    assert!(
        !wire.contains("DSML") && !wire.contains("end▁of▁analysis"),
        "{wire}"
    );
    assert!(
        !wire.contains("response.failed") && !wire.contains("network_error"),
        "{wire}"
    );
    let business = completed(&wire, stream);
    assert!(business
        .to_string()
        .contains("Recovered business response."));
    assert_eq!(primary_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(fallback_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    handle.shutdown().await;
    primary_task.abort();
    fallback_task.abort();
}

#[tokio::test]
async fn relay_control_marker_only_json_recovers() {
    run_marker_recovery(false).await;
}

#[tokio::test]
async fn relay_control_marker_only_sse_recovers() {
    run_marker_recovery(true).await;
}
