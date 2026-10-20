use super::issue4effed6_relay_markers::{
    chat_provider_response, completed, marker_recovery_manifest, spawn_marker_upstream,
};
use super::*;

#[derive(Clone, Copy)]
enum Mode {
    Complete,
    Partial,
    InvalidNative,
    HalfThinking,
    Namespace,
    Recovered,
}
#[derive(Clone)]
struct Peer {
    mode: Mode,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}
const CALL: &str = "call_serialized42";
const ARGS: &str = "{\"value\":\"42\"}";
const BAD_ARGS: &str = "{model-invalid";
const OPAQUE_PARTIAL_READ: &str =
    "<tool_call>read_image<arg_key>file_path</arg_key><arg_value>opaque.png</arg_value>";
const OPAQUE_FLAT_PARTIAL_READ: &str =
    "<tool_call>read_image<arg_key>path</arg_key><arg_value>flat.png</arg_value>";

async fn upstream(State(peer): State<Peer>, axum::Json(body): axum::Json<Value>) -> Response {
    let turn = peer.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let wire_name = if matches!(peer.mode, Mode::Namespace) {
        "functions__printf42"
    } else {
        "printf42"
    };
    assert!(body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["function"]["name"] == wire_name));
    let messages = body["messages"].as_array().unwrap();
    let followup = messages.iter().any(|message| message["role"] == "tool");
    let text;
    let mut native = json!([]);
    let finish;
    if matches!(peer.mode, Mode::Recovered) {
        assert_eq!(turn, 0);
        text = "RECOVERED_SERIALIZED".to_owned();
        finish = "stop";
    } else if followup {
        assert_eq!(
            turn, 1,
            "first attempt must be accepted without reselection"
        );
        for (id, arguments, result) in std::iter::once((CALL, ARGS, "42")).chain(
            matches!(peer.mode, Mode::InvalidNative).then_some((
                "native_bad",
                BAD_ARGS,
                "tool_error",
            )),
        ) {
            assert!(messages.iter().any(|message| message["role"] == "assistant"
                && message["tool_calls"]
                    .as_array()
                    .is_some_and(|calls| calls.iter().any(|call| call["id"] == id
                        && call["function"]["arguments"] == arguments
                        && call["function"]["name"] == wire_name))));
            assert!(messages.iter().any(|message| message["role"] == "tool"
                && message["tool_call_id"] == id
                && message["content"] == result));
        }
        text = "MATCHED_TOOL_RESULT_42".to_owned();
        finish = "stop";
    } else {
        assert_eq!(turn, 0);
        assert!(messages
            .to_vec()
            .iter()
            .any(|message| message.to_string().contains("SERIALIZED_FIXTURE")));
        let envelope = format!("<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name=\"{wire_name}\" call_id=\"{CALL}\"><｜｜DSML｜｜ parameter name=\"value\" string=\"true\">42</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>");
        text = match peer.mode {
            Mode::Partial => format!("FAILED_ATTEMPT_PROSE\n{envelope}\n<tool_call>printf42<arg_key>value</arg_key><arg_value>broken"),
            Mode::HalfThinking => format!("<thinking>Preparing.\n{envelope}\nDone preparing."),
            _ => format!("Preparing.\n{envelope}\nDone preparing."),
        };
        if matches!(peer.mode, Mode::InvalidNative) {
            native = json!([{"id":"native_bad","type":"function","function":{"name":"printf42","arguments":BAD_ARGS}}]);
        }
        finish = if matches!(peer.mode, Mode::InvalidNative) {
            "tool_calls"
        } else {
            "stop"
        };
    }
    chat_provider_response(body["stream"] == true, &text, native, finish)
}

fn tools() -> Value {
    json!([{"type":"function","name":"printf42","parameters":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}}])
}

async fn round_trip(stream: bool, mode: Mode) {
    let invalid_native = matches!(mode, Mode::InvalidNative);
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (upstream_port, task) = spawn_marker_upstream(
        Peer {
            mode,
            calls: calls.clone(),
        },
        post(upstream),
    )
    .await;
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
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let url = format!("http://127.0.0.1:{port}/v1/responses");
    let message = json!({"role":"user","content":"SERIALIZED_FIXTURE"});
    let tools = if matches!(mode, Mode::Namespace) {
        json!([{"type":"namespace","name":"functions","tools":tools()}])
    } else {
        tools()
    };
    let response = client
        .post(&url)
        .json(
            &json!({"model":"client-test","stream":stream,"tools":tools,"input":[message.clone()]}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let wire = response.text().await.unwrap();
    assert!(
        !wire.contains("DSML") && !wire.contains("<tool_call>"),
        "serialized invocation leaked: {wire}"
    );
    assert!(
        !wire.contains("<thinking>"),
        "thinking label leaked: {wire}"
    );
    let result = completed(&wire, stream);
    let output = result["output"].as_array().unwrap();
    if matches!(mode, Mode::HalfThinking) {
        let prose: String = output
            .iter()
            .filter(|item| item["type"] == "message")
            .flat_map(|item| item["content"].as_array().unwrap())
            .filter_map(|part| part["text"].as_str())
            .collect();
        assert_eq!(prose, "Preparing.\n\nDone preparing.");
    }
    let call = output
        .iter()
        .find(|item| item["type"] == "function_call" && item["call_id"] == CALL)
        .expect("harvested native call");
    assert_eq!(call["name"], "printf42");
    if matches!(mode, Mode::Namespace) {
        assert_eq!(call["namespace"], "functions");
    }
    assert_eq!(call["arguments"], ARGS);
    let args: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
    let execution = std::process::Command::new("printf")
        .arg("%s")
        .arg(args["value"].as_str().unwrap())
        .output()
        .unwrap();
    assert!(execution.status.success());
    let text = String::from_utf8(execution.stdout).unwrap();
    assert_eq!(text, "42");
    let mut input = vec![message];
    input.extend(output.clone());
    input.push(json!({"type":"function_call_output","call_id":CALL,"output":text}));
    if invalid_native {
        let bad = output
            .iter()
            .find(|item| item["call_id"] == "native_bad")
            .expect("native invalid arguments are business");
        assert_eq!(bad["arguments"], BAD_ARGS);
        input.push(
            json!({"type":"function_call_output","call_id":"native_bad","output":"tool_error"}),
        );
    }
    let response = client
        .post(&url)
        .json(&json!({"model":"client-test","stream":stream,"tools":tools,"input":input}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(completed(&response.text().await.unwrap(), stream)
        .to_string()
        .contains("MATCHED_TOOL_RESULT_42"));
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    handle.shutdown().await;
    task.abort();
}

async fn partial(stream: bool, recover: bool) {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (primary, task) = spawn_marker_upstream(
        Peer {
            mode: Mode::Partial,
            calls: calls.clone(),
        },
        post(upstream),
    )
    .await;
    let fallback_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (fallback, fallback_task) = spawn_marker_upstream(
        Peer {
            mode: Mode::Recovered,
            calls: fallback_calls.clone(),
        },
        post(upstream),
    )
    .await;
    let port = free_port();
    let manifest = marker_recovery_manifest(
        port,
        free_port(),
        &format!("http://127.0.0.1:{primary}/v1"),
        &format!("http://127.0.0.1:{fallback}/v1"),
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let response = reqwest::Client::builder().timeout(Duration::from_secs(20)).build().unwrap().post(format!("http://127.0.0.1:{port}/v1/responses"))
        .json(&json!({"model":if recover { "client-test" } else { "test.test" },"stream":stream,"tools":tools(),"input":"SERIALIZED_FIXTURE"})).send().await;
    if recover {
        let response = response.unwrap();
        assert_eq!(response.status(), 200);
        let wire = response.text().await.unwrap();
        assert!(
            !wire.contains("FAILED_ATTEMPT_PROSE")
                && !wire.contains(CALL)
                && !wire.contains("DSML"),
            "failed attempt leaked: {wire}"
        );
        assert!(completed(&wire, stream)
            .to_string()
            .contains("RECOVERED_SERIALIZED"));
    } else if let Ok(response) = response {
        use futures_util::StreamExt;
        let mut chunks = response.bytes_stream();
        let mut wire = Vec::new();
        let mut failed = false;
        while let Some(chunk) = chunks.next().await {
            match chunk {
                Ok(bytes) => wire.extend_from_slice(&bytes),
                Err(error) => {
                    assert!(
                        !error.is_timeout(),
                        "timeout is not terminal transport evidence"
                    );
                    failed = true;
                    break;
                }
            }
        }
        assert!(failed, "incomplete attempt must terminate transport");
        let wire = String::from_utf8_lossy(&wire);
        for forbidden in [
            "FAILED_ATTEMPT_PROSE",
            CALL,
            "DSML",
            "response.completed",
            "response.failed",
            "network_error",
        ] {
            assert!(!wire.contains(forbidden), "{wire}");
        }
    } else if let Err(error) = response {
        assert!(
            !error.is_timeout(),
            "timeout is not terminal transport evidence"
        );
    }
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        fallback_calls.load(std::sync::atomic::Ordering::SeqCst),
        usize::from(recover)
    );
    if !recover {
        let healthy = reqwest::Client::new().post(format!("http://127.0.0.1:{port}/v1/responses"))
            .json(&json!({"model":"fallback.test","stream":false,"tools":tools(),"input":"SERIALIZED_FIXTURE"})).send().await.unwrap();
        assert_eq!(healthy.status(), 200);
        assert!(healthy
            .text()
            .await
            .unwrap()
            .contains("RECOVERED_SERIALIZED"));
        assert_eq!(fallback_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
    handle.shutdown().await;
    task.abort();
    fallback_task.abort();
}

fn opaque_tools() -> Value {
    json!([
        {"type":"function","name":"printf42","parameters":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}},
        {"type":"function","name":"read_image","parameters":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}}
    ])
}

fn opaque_provider_output() -> Value {
    json!([
        {
            "id":"msg_opaque_item",
            "type":"message",
            "role":"assistant",
            "status":"completed",
            "vendor_item":{"business":"item-kept","raw":"I".repeat(128)},
            "content":[{
                "type":"output_text",
                "text":OPAQUE_PARTIAL_READ,
                "annotations":[{"type":"url_citation","url":"https://opaque.invalid/citation","title":"opaque citation"}],
                "logprobs":[{"token":"read_image","logprob":-0.25}],
                "vendor_part":{"business":"part-kept","raw":"P".repeat(128)}
            }]
        },
        {
            "id":"flat_opaque",
            "type":"output_text",
            "text":OPAQUE_FLAT_PARTIAL_READ,
            "annotations":[{"type":"url_citation","url":"https://flat.invalid/citation","title":"flat citation"}],
            "logprobs":[{"token":"path","logprob":-0.5}],
            "vendor_flat":{"business":"flat-kept","raw":"F".repeat(128)}
        },
        {
            "id":"fc_opaque_native",
            "type":"function_call",
            "call_id":CALL,
            "name":"printf42",
            "arguments":ARGS,
            "status":"completed",
            "vendor_native":{"business":"native-kept","raw":"N".repeat(128)}
        }
    ])
}

fn opaque_provider_response(stream: bool, output: Value, text: &str) -> Response {
    let response = json!({
        "id":"resp_opaque_carrier",
        "object":"response",
        "model":"wire-test",
        "status":"completed",
        "output":output,
        "output_text":text,
        "vendor_terminal":{"business":"terminal-kept","raw":"T".repeat(128)}
    });
    if stream {
        let mut wire = format!(
            "event: response.created\ndata: {}\n\n",
            json!({"type":"response.created","response":{"id":"resp_opaque_carrier","status":"in_progress","model":"wire-test","output":[]}})
        );
        for (index, item) in response["output"].as_array().unwrap().iter().enumerate() {
            wire.push_str(&format!(
                "event: response.output_item.done\ndata: {}\n\n",
                json!({"type":"response.output_item.done","output_index":index,"item":item})
            ));
        }
        wire.push_str(&format!(
            "event: response.completed\ndata: {}\n\ndata: [DONE]\n\n",
            json!({"type":"response.completed","response":response})
        ));
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(wire))
            .unwrap()
    } else {
        Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(response.to_string()))
            .unwrap()
    }
}

async fn spawn_responses_upstream<State>(
    state: State,
    handler: axum::routing::MethodRouter<State>,
) -> (u16, tokio::task::JoinHandle<()>)
where
    State: Clone + Send + Sync + 'static,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = Router::new()
        .route("/v1/responses", handler)
        .with_state(state);
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (port, task)
}

async fn opaque_counterexample(stream: bool) {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (primary_port, primary_task) = spawn_responses_upstream(
        calls.clone(),
        post(
            |State(calls): State<Arc<std::sync::atomic::AtomicUsize>>,
             axum::Json(body): axum::Json<Value>| async move {
                let turn = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                assert!(body["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["name"] == "read_image"));
                if turn == 0 {
                    assert!(body.to_string().contains("OPAQUE_CARRIER_FIXTURE"));
                    opaque_provider_response(body["stream"] == true, opaque_provider_output(), "")
                } else {
                    assert_eq!(turn, 1);
                    let input = body["input"].as_array().expect("responses follow-up input");
                    assert!(input.iter().any(|item| item["type"] == "function_call"
                        && item["call_id"] == CALL
                        && item["name"] == "printf42"
                        && item["arguments"] == ARGS));
                    assert!(input
                        .iter()
                        .any(|item| item["type"] == "function_call_output"
                            && item["call_id"] == CALL
                            && item["output"] == "42"));
                    opaque_provider_response(
                        body["stream"] == true,
                        json!([{
                            "id":"msg_opaque_done",
                            "type":"message",
                            "role":"assistant",
                            "status":"completed",
                            "content":[{"type":"output_text","text":"OPAQUE_NATIVE_DONE_42"}]
                        }]),
                        "OPAQUE_NATIVE_DONE_42",
                    )
                }
            },
        ),
    )
    .await;
    let fallback_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (fallback_port, fallback_task) = spawn_responses_upstream(
        fallback_calls.clone(),
        post(
            |State(calls): State<Arc<std::sync::atomic::AtomicUsize>>,
             axum::Json(body): axum::Json<Value>| async move {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                opaque_provider_response(
                    body["stream"] == true,
                    json!([{
                        "id":"msg_fallback",
                        "type":"message",
                        "role":"assistant",
                        "status":"completed",
                        "content":[{"type":"output_text","text":"FALLBACK_MUST_NOT_RUN"}]
                    }]),
                    "FALLBACK_MUST_NOT_RUN",
                )
            },
        ),
    )
    .await;
    let port = free_port();
    let mut manifest = responses_relay_provider_protocol_manifest(
        port,
        free_port(),
        &format!("http://127.0.0.1:{primary_port}/v1"),
        "responses",
        Some(&format!("http://127.0.0.1:{fallback_port}/v1")),
    );
    let responses = manifest
        .providers
        .get("test")
        .and_then(|provider| provider.responses.clone());
    manifest
        .providers
        .get_mut("fallback")
        .expect("fallback provider")
        .responses = responses;
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let url = format!("http://127.0.0.1:{port}/v1/responses");
    let message = json!({"role":"user","content":"OPAQUE_CARRIER_FIXTURE"});
    let tools = opaque_tools();
    let response = client
        .post(&url)
        .json(
            &json!({"model":"client-test","stream":stream,"tools":tools,"input":[message.clone()]}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let wire = response.text().await.unwrap();
    let result = completed(&wire, stream);
    let output = result["output"].as_array().unwrap();

    let opaque_item = output
        .iter()
        .find(|item| item["id"] == "msg_opaque_item")
        .expect("opaque item with vendor extension must survive");
    assert_eq!(
        opaque_item["vendor_item"],
        json!({"business":"item-kept","raw":"I".repeat(128)})
    );
    let opaque_part = &opaque_item["content"][0];
    assert_eq!(opaque_part["text"], OPAQUE_PARTIAL_READ);
    assert_eq!(
        opaque_part["annotations"],
        json!([{"type":"url_citation","url":"https://opaque.invalid/citation","title":"opaque citation"}])
    );
    assert_eq!(
        opaque_part["logprobs"],
        json!([{"token":"read_image","logprob":-0.25}])
    );
    assert_eq!(
        opaque_part["vendor_part"],
        json!({"business":"part-kept","raw":"P".repeat(128)})
    );

    let flat = output
        .iter()
        .find(|item| item["id"] == "flat_opaque")
        .expect("flat output_text carrier must survive");
    assert_eq!(flat["content"][0]["text"], OPAQUE_FLAT_PARTIAL_READ);
    assert_eq!(
        flat["content"][0]["vendor_flat"],
        json!({"business":"flat-kept","raw":"F".repeat(128)})
    );
    assert_eq!(
        flat["content"][0]["annotations"],
        json!([{"type":"url_citation","url":"https://flat.invalid/citation","title":"flat citation"}])
    );
    assert_eq!(
        flat["content"][0]["logprobs"],
        json!([{"token":"path","logprob":-0.5}])
    );

    let call = output
        .iter()
        .find(|item| item["type"] == "function_call" && item["call_id"] == CALL)
        .expect("complete native sibling must survive");
    assert_eq!(call["name"], "printf42");
    assert_eq!(call["arguments"], ARGS);
    assert_eq!(
        call["vendor_native"],
        json!({"business":"native-kept","raw":"N".repeat(128)})
    );
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(fallback_calls.load(std::sync::atomic::Ordering::SeqCst), 0);

    let args: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
    let execution = std::process::Command::new("printf")
        .arg("%s")
        .arg(args["value"].as_str().unwrap())
        .output()
        .unwrap();
    assert!(execution.status.success());
    let text = String::from_utf8(execution.stdout).unwrap();
    assert_eq!(text, "42");
    let mut input = vec![message];
    input.extend(output.clone());
    input.push(json!({"type":"function_call_output","call_id":CALL,"output":text}));
    let followup = client
        .post(&url)
        .json(&json!({"model":"client-test","stream":stream,"tools":tools,"input":input}))
        .send()
        .await
        .unwrap();
    assert_eq!(followup.status(), 200);
    assert!(completed(&followup.text().await.unwrap(), stream)
        .to_string()
        .contains("OPAQUE_NATIVE_DONE_42"));
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert_eq!(fallback_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    handle.shutdown().await;
    primary_task.abort();
    fallback_task.abort();
}

#[tokio::test]
async fn relay_serialized_tool_complete_json_and_sse_round_trip() {
    for stream in [false, true] {
        round_trip(stream, Mode::Complete).await;
    }
}
#[tokio::test]
async fn relay_serialized_tool_native_invalid_json_and_sse_correction() {
    for stream in [false, true] {
        round_trip(stream, Mode::InvalidNative).await;
    }
}
#[tokio::test]
async fn relay_serialized_tool_half_thinking_json_and_sse_preserves_body() {
    for stream in [false, true] {
        round_trip(stream, Mode::HalfThinking).await;
    }
}
#[tokio::test]
async fn relay_serialized_tool_namespace_json_and_sse_round_trip() {
    for stream in [false, true] {
        round_trip(stream, Mode::Namespace).await;
    }
}
#[tokio::test]
async fn relay_serialized_tool_partial_sibling_json_and_sse_recovery() {
    for stream in [false, true] {
        partial(stream, true).await;
    }
}
#[tokio::test]
async fn relay_serialized_tool_partial_sibling_json_and_sse_exhaustion() {
    for stream in [false, true] {
        partial(stream, false).await;
    }
}
#[tokio::test]
async fn relay_serialized_tool_opaque_carriers_json_and_sse_preserved() {
    for stream in [false, true] {
        opaque_counterexample(stream).await;
    }
}
