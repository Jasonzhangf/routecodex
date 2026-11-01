use super::*;

const COMMAND: &str = "printf '%s' 'RCC455_SAFE_OK'";
const DESCRIPTION: &str = "literal description";
const DONE: &str = "RCC455_PAIRED_DONE";

fn arguments() -> Value {
    json!({"command":COMMAND,"description":DESCRIPTION,"timeoutMs":170000})
}

fn text() -> String {
    format!("Before.\n<tool_call>bash<arg_key>command</arg_key><arg_value>{COMMAND}</arg_value><arg_key>description</arg_key><arg_value>{DESCRIPTION}</arg_value><arg_key>timeoutMs</arg_key><arg_value>170000</arg_value></tool_call>\nAfter.")
}

#[derive(Clone)]
struct Peer {
    provider_sse: bool,
    captures: mpsc::UnboundedSender<Value>,
    preserve: Option<(String, String)>,
    native_invalid: bool,
}

fn response(text: &str) -> Value {
    json!({"id":"resp_ff1e031","object":"response","status":"completed",
        "output":[{"type":"message","id":"msg_ff1e031","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":text}]}],
        "usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}})
}

async fn upstream(
    State(peer): State<Arc<Peer>>,
    axum::Json(body): axum::Json<Value>,
) -> Response<Body> {
    peer.captures.send(body.clone()).unwrap();
    assert_eq!(body["model"], "wire-test");
    let tools = body["tools"].as_array().unwrap();
    let declared = peer
        .preserve
        .as_ref()
        .map_or("bash", |(_, name)| name.as_str());
    let bash = tools.iter().find(|tool| tool["name"] == declared).unwrap();
    assert_eq!(bash["type"], "function");
    assert_eq!(
        bash["parameters"]["properties"]["command"]["type"],
        "string"
    );
    assert_eq!(
        bash["parameters"]["properties"]["description"]["type"],
        "string"
    );
    assert_eq!(
        bash["parameters"]["properties"]["timeoutMs"]["type"],
        "integer"
    );
    let input = body["input"].as_array().unwrap();
    let output = input
        .iter()
        .find(|item| item["type"] == "function_call_output");
    let visible = if let Some(output) = output {
        assert_eq!(
            output["output"],
            if peer.native_invalid {
                "RCC455_TOOL_ERROR"
            } else {
                "RCC455_SAFE_OK"
            }
        );
        let call = input
            .iter()
            .find(|item| item["type"] == "function_call" && item["call_id"] == output["call_id"])
            .expect("paired assistant call must survive Chat history projection");
        assert_eq!(call["name"], "bash");
        if peer.native_invalid {
            assert_eq!(call["arguments"], "{\"command\":false}");
        } else {
            assert_eq!(
                serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
                arguments()
            );
        }
        DONE.to_owned()
    } else {
        peer.preserve
            .as_ref()
            .map_or_else(text, |(text, _)| text.clone())
    };
    let mut final_response = response(&visible);
    if peer.native_invalid && output.is_none() {
        final_response["output"] = json!([{"type":"function_call","id":"fc_native_ff1e031","call_id":"native_ff1e031","name":"bash","arguments":"{\"command\":false}","status":"completed"}]);
    }
    if !peer.provider_sse {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&final_response).unwrap()))
            .unwrap();
    }
    let item = &final_response["output"][0];
    if item["type"] == "function_call" {
        let mut initial = item.clone();
        initial["arguments"] = "".into();
        initial["status"] = "in_progress".into();
        return sse_response(vec![
            json!({"type":"response.created","response":{"id":"resp_ff1e031","status":"in_progress","output":[]}}),
            json!({"type":"response.output_item.added","output_index":0,"item":initial}),
            json!({"type":"response.function_call_arguments.delta","output_index":0,"item_id":item["id"],"delta":item["arguments"]}),
            json!({"type":"response.function_call_arguments.done","output_index":0,"item_id":item["id"],"arguments":item["arguments"]}),
            json!({"type":"response.output_item.done","output_index":0,"item":item}),
            json!({"type":"response.completed","response":final_response}),
        ]);
    }
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_ff1e031","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_ff1e031","role":"assistant","status":"in_progress","content":[]}}),
        json!({"type":"response.content_part.added","output_index":0,"item_id":"msg_ff1e031","content_index":0,"part":{"type":"output_text","text":""}}),
    ];
    for bytes in visible.as_bytes().chunks(7) {
        events.push(json!({"type":"response.output_text.delta","output_index":0,"item_id":"msg_ff1e031","content_index":0,"delta":std::str::from_utf8(bytes).unwrap()}));
    }
    events.extend([
        json!({"type":"response.output_text.done","output_index":0,"item_id":"msg_ff1e031","content_index":0,"text":visible}),
        json!({"type":"response.content_part.done","output_index":0,"item_id":"msg_ff1e031","content_index":0,"part":item["content"][0]}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":final_response}),
    ]);
    sse_response(events)
}

fn sse_response(events: Vec<Value>) -> Response<Body> {
    let mut wire = String::new();
    for event in events {
        wire.push_str(&format!(
            "event: {}\ndata: {}\n\n",
            event["type"].as_str().unwrap(),
            event
        ));
    }
    wire.push_str("data: [DONE]\n\n");
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(wire))
        .unwrap()
}

async fn client_message(response: reqwest::Response, sse: bool) -> (Value, String) {
    assert_eq!(response.status(), StatusCode::OK);
    let raw = response.text().await.unwrap();
    if !sse {
        let body: Value = serde_json::from_str(&raw).unwrap();
        return (
            body["choices"][0]["message"].clone(),
            body["choices"][0]["finish_reason"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    let mut content = String::new();
    let mut name = String::new();
    let mut args = String::new();
    let mut id = String::new();
    let mut finish = String::new();
    let mut done = 0;
    for data in raw.lines().filter_map(|line| line.strip_prefix("data: ")) {
        if data == "[DONE]" {
            done += 1;
            continue;
        }
        let event: Value = serde_json::from_str(data).unwrap();
        let Some(choice) = event["choices"]
            .as_array()
            .and_then(|choices| choices.first())
        else {
            continue;
        };
        if let Some(reason) = choice["finish_reason"].as_str() {
            finish = reason.to_owned();
        }
        let message = choice
            .get("delta")
            .or_else(|| choice.get("message"))
            .unwrap();
        if let Some(value) = message["content"].as_str() {
            content.push_str(value);
        }
        if let Some(calls) = message["tool_calls"].as_array() {
            for call in calls {
                assert!(call.get("index").is_none_or(|index| index == 0));
                if let Some(value) = call["id"].as_str() {
                    if id.is_empty() {
                        id = value.to_owned();
                    } else {
                        assert_eq!(id, value);
                    }
                }
                if let Some(value) = call["function"]["name"].as_str() {
                    name.push_str(value);
                }
                if let Some(value) = call["function"]["arguments"].as_str() {
                    args.push_str(value);
                }
            }
        }
    }
    assert_eq!(
        done, 1,
        "one complete public Chat SSE terminal is required: {raw}"
    );
    let calls = if id.is_empty() {
        json!([])
    } else {
        json!([{"id":id,"type":"function","function":{"name":name,"arguments":args}}])
    };
    (
        json!({"role":"assistant","content":content,"tool_calls":calls}),
        finish,
    )
}

async fn round_trip(provider_sse: bool, client_sse: bool) {
    run_case(provider_sse, client_sse, None, false).await;
}

async fn run_case(
    provider_sse: bool,
    client_sse: bool,
    preserve: Option<(String, String)>,
    native_invalid: bool,
) {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-ff1e031-fixture");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, mut captures) = mpsc::unbounded_channel();
    let (shutdown, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .with_state(Arc::new(Peer {
            provider_sse,
            captures: captures_tx,
            preserve: preserve.clone(),
            native_invalid,
        }));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let port_a = TcpListener::bind("127.0.0.1:0").unwrap();
    let port_b = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut manifest = responses_relay_manifest(
        port_a.local_addr().unwrap().port(),
        port_b.local_addr().unwrap().port(),
        &format!("http://{address}/v1"),
    );
    drop((port_a, port_b));
    for server in manifest.servers.values_mut() {
        server.endpoints.push("openai_chat".to_owned());
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/chat/completions", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let declared = preserve.as_ref().map_or("bash", |(_, name)| name.as_str());
    let tools = json!([{"type":"function","function":{"name":declared,"parameters":{"type":"object","properties":{"command":{"type":"string"},"description":{"type":"string"},"timeoutMs":{"type":"integer"}},"required":["command","description","timeoutMs"]}}}]);
    let user = json!({"role":"user","content":"Run the declared safe fixture."});
    let first = client
        .post(&endpoint)
        .json(&json!({"model":"client-test","messages":[user],"tools":tools,"stream":client_sse}))
        .send()
        .await
        .unwrap();
    let (assistant, finish) = client_message(first, client_sse).await;
    let first_capture = captures.recv().await.unwrap();
    assert_eq!(first_capture["model"], "wire-test");
    if let Some((expected, _)) = preserve {
        assert_eq!(assistant["content"], expected);
        assert!(assistant
            .get("tool_calls")
            .is_none_or(|calls| calls.as_array().is_some_and(Vec::is_empty)));
        assert_eq!(finish, "stop");
        assert!(captures.try_recv().is_err());
        handle.shutdown().await;
        shutdown.send(()).unwrap();
        std::env::remove_var("V3_P6_TEST_KEY");
        return;
    }
    assert_eq!(
        finish, "tool_calls",
        "complete declared tool markup must become a native call, not assistant text: {assistant}"
    );
    let calls = assistant["tool_calls"].as_array().unwrap();
    assert_eq!(calls.len(), 1, "{assistant}");
    let call = &calls[0];
    assert!(!call["id"].as_str().unwrap().is_empty());
    assert_eq!(call["function"]["name"], "bash");
    let result = if native_invalid {
        assert_eq!(call["id"], "native_ff1e031");
        assert_eq!(call["function"]["arguments"], "{\"command\":false}");
        "RCC455_TOOL_ERROR".to_owned()
    } else {
        assert_eq!(
            serde_json::from_str::<Value>(call["function"]["arguments"].as_str().unwrap()).unwrap(),
            arguments()
        );
        assert_eq!(assistant["content"], "Before.\n\nAfter.");
        assert!(!assistant["content"]
            .as_str()
            .unwrap()
            .contains("<tool_call>"));
        // Only this fixed, asserted test-owned command can execute.
        let output = std::process::Command::new("sh")
            .args(["-c", COMMAND])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"RCC455_SAFE_OK");
        String::from_utf8(output.stdout).unwrap()
    };
    let second = client.post(&endpoint).json(&json!({"model":"client-test","messages":[user,assistant,{"role":"tool","tool_call_id":call["id"],"content":result}],"tools":tools,"stream":client_sse})).send().await.unwrap();
    let (final_message, final_finish) = client_message(second, client_sse).await;
    assert_eq!(final_message["content"], DONE);
    assert_eq!(final_finish, "stop");
    captures.recv().await.unwrap();
    assert!(
        captures.try_recv().is_err(),
        "successful business content must not reselect a provider"
    );
    handle.shutdown().await;
    shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
}

#[tokio::test]
async fn openai_chat_responses_ff1e031_json_json_round_trip() {
    round_trip(false, false).await;
}
#[tokio::test]
async fn openai_chat_responses_ff1e031_sse_json_round_trip() {
    round_trip(true, false).await;
}
#[tokio::test]
async fn openai_chat_responses_ff1e031_sse_sse_round_trip() {
    round_trip(true, true).await;
}

#[tokio::test]
async fn openai_chat_responses_ff1e031_literal_unknown_and_native_error_controls() {
    for (provider_sse, client_sse) in [(false, false), (true, false), (true, true)] {
        for (value, declared) in [
            (text(), "other"),
            (format!("```xml\n{}\n```", text()), "bash"),
            (format!("\"{}\"", text()), "bash"),
        ] {
            run_case(
                provider_sse,
                client_sse,
                Some((value, declared.to_owned())),
                false,
            )
            .await;
        }
        run_case(provider_sse, client_sse, None, true).await;
    }
}
