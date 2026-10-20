use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
enum DsmlCase {
    RoundTrip,
    Literal,
    OpaqueSse,
    Nested,
    Discovered,
    Residue,
    Alternate,
    ToolCall,
    CallsResidueSse,
    UnknownComplete,
    OpaqueComplete,
    OpaqueAlternate,
    UnknownLabelOnly,
    OpaqueEmbeddedThinking,
    Minimax,
    MinimaxPartial,
    MinimaxLiteral,
    MinimaxUnknown,
    MinimaxNamespace,
}

fn opaque_tool_text(case: DsmlCase) -> Option<&'static str> {
    match case {
        DsmlCase::MinimaxLiteral => Some("```xml\n]<]minimax[>[<tool_call>]<]minimax[>[<invoke name=\"read_image\">]<]minimax[>[<file_path>literal.png]<]minimax[>[</file_path>]<]minimax[>[</invoke>]<]minimax[>[</tool_call>\n```"),
        DsmlCase::MinimaxUnknown => Some("]<]minimax[>[<tool_call>]<]minimax[>[<invoke name=\"unknown\">]<]minimax[>[<cmd>ordinary business]<]minimax[>[</cmd>]<]minimax[>[</invoke>]<]minimax[>[</tool_call>"),
        DsmlCase::UnknownComplete => Some("<tool_call>undeclared<arg_key>cmd</arg_key><arg_value>x</arg_value></tool_call>"),
        DsmlCase::OpaqueComplete => Some("<tool_call>read_image<arg_key>file_path</arg_key><arg_value>a</arg_value><arg_key>file_path</arg_key><arg_value>b</arg_value></tool_call>"),
        DsmlCase::OpaqueAlternate => Some("<|read_image\">\n<file_path>a</file_path>\n<file_path>b</file_path>\n</read_image>"),
        DsmlCase::UnknownLabelOnly => Some("<|DSML|tool_calls>\n<tool_call>undeclared<arg_key>cmd</arg_key><arg_value>x</arg_value></tool_call>"),
        DsmlCase::OpaqueEmbeddedThinking => Some("<tool_call>undeclared<arg_key>cmd</arg_key><arg_value><thinking>opaque argument</thinking></arg_value></tool_call>"),
        _ => None,
    }
}

#[derive(Clone)]
struct DsmlPeer {
    path: String,
    calls: Arc<std::sync::atomic::AtomicUsize>,
    sse: bool,
    case: DsmlCase,
}

const NESTED_NAMESPACE: &str = "mcp__mcpx.workspace";
const NESTED_LEAF: &str = "read";
const NESTED_WIRE: &str = "mcp__mcpx__workspace__read";
const DISCOVERED_NAMESPACE: &str = "search_ns";
const DISCOVERED_LEAF: &str = "found";
const DISCOVERED_WIRE: &str = "search_ns__found";

fn discovery_item() -> Value {
    json!({"type":"tool_search_output","call_id":"discovery_call_1","tools":[
        {"type":"namespace","name":"search_ns","tools":[
            {"type":"function","name":"found","parameters":{"type":"object","properties":{"file_path":{"type":"string"}}}}
        ]}
    ]})
}

fn client_tools(case: DsmlCase) -> Value {
    match case {
        DsmlCase::Nested | DsmlCase::MinimaxNamespace => {
            json!([{"type":"namespace","name":"mcp__mcpx","tools":[
                {"type":"namespace","name":"workspace","tools":[
                    {"type":"function","name":"read","parameters":{"type":"object","properties":{"file_path":{"type":"string"}}}}
                ]}
            ]}])
        }
        DsmlCase::Discovered => {
            json!([{"type":"function","name":"read_image","parameters":{"type":"object","properties":{"file_path":{"type":"string"}}}}])
        }
        DsmlCase::Alternate | DsmlCase::ToolCall | DsmlCase::CallsResidueSse => json!([{
            "type":"function",
            "name":"exec_command",
            "parameters":{
                "type":"object",
                "properties":{
                    "cmd":{"type":"string"},
                    "max_output_tokens":{"type":"integer"},
                    "yield_time_ms":{"type":"integer"}
                },
                "required":["cmd","max_output_tokens","yield_time_ms"]
            }
        }]),
        _ => {
            json!([{"type":"function","name":"read_image","parameters":{"type":"object","properties":{"file_path":{"type":"string"},"options":{"type":"array"}}}}])
        }
    }
}

fn invoke_name(case: DsmlCase) -> &'static str {
    match case {
        DsmlCase::Nested | DsmlCase::MinimaxNamespace => NESTED_WIRE,
        DsmlCase::Discovered => DISCOVERED_WIRE,
        DsmlCase::Alternate | DsmlCase::ToolCall | DsmlCase::CallsResidueSse => "exec_command",
        _ => "read_image",
    }
}

fn expected_leaf(case: DsmlCase) -> &'static str {
    match case {
        DsmlCase::Nested | DsmlCase::MinimaxNamespace => NESTED_LEAF,
        DsmlCase::Discovered => DISCOVERED_LEAF,
        DsmlCase::Alternate | DsmlCase::ToolCall | DsmlCase::CallsResidueSse => "exec_command",
        _ => "read_image",
    }
}

fn expected_namespace(case: DsmlCase) -> Option<&'static str> {
    match case {
        DsmlCase::Nested | DsmlCase::MinimaxNamespace => Some(NESTED_NAMESPACE),
        DsmlCase::Discovered => Some(DISCOVERED_NAMESPACE),
        _ => None,
    }
}

fn first_input(case: DsmlCase) -> Value {
    let mut input = vec![json!({"role":"user","content":"Read the owned image"})];
    if case == DsmlCase::Discovered {
        input.push(discovery_item());
    }
    Value::Array(input)
}

fn wire_tool_names(body: &Value) -> Vec<String> {
    body["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn assert_provider_declaration(body: &Value, case: DsmlCase) {
    let names = wire_tool_names(body);
    let expected = invoke_name(case);
    assert!(
        names.iter().any(|name| name == expected),
        "provider wire tools must declare {expected:?}, got {names:?}"
    );
}

async fn upstream(
    State(peer): State<DsmlPeer>,
    axum::Json(body): axum::Json<Value>,
) -> Response<Body> {
    let turn = peer.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    assert_provider_declaration(&body, peer.case);
    let output = if turn == 0 {
        if let Some(text) = opaque_tool_text(peer.case) {
            let mut output = json!([
                {"id":"opaque_message","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]},
                {"id":"native_sibling","type":"function_call","call_id":"native_sibling_call","name":"read_image","arguments":json!({"file_path":peer.path}).to_string(),"status":"completed"}
            ]);
            if peer.case == DsmlCase::UnknownLabelOnly {
                output.as_array_mut().unwrap().pop();
            }
            output
        } else if matches!(
            peer.case,
            DsmlCase::Minimax | DsmlCase::MinimaxPartial | DsmlCase::MinimaxNamespace
        ) {
            let invocation = format!(
                "]<]minimax[>[<invoke name=\"{}\">]<]minimax[>[<file_path>{}]<]minimax[>[</file_path>]<]minimax[>[</invoke>",
                invoke_name(peer.case), peer.path
            );
            let text = if peer.case == DsmlCase::MinimaxPartial {
                format!("FAILED_ATTEMPT_PROSE\n]<]minimax[>[<tool_call>{invocation}]<]minimax[>[<invoke name=\"read_image\">]<]minimax[>[<file_path>broken")
            } else {
                format!("Before\n]<]minimax[>[<tool_call>\n{invocation}\n{invocation}\n]<]minimax[>[</tool_call>\nAfter")
            };
            json!([{"id":"minimax_message","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]}])
        } else if peer.case == DsmlCase::Alternate {
            json!([{
                "id":"message_alternate",
                "type":"message",
                "role":"assistant",
                "status":"completed",
                "content":[{
                    "type":"output_text",
                    "text":"Continue.\n<|DSML|tool_calls>\n<|exec_command\">\n<cmd>printf 42</cmd>\n<max_output_tokens>4000</max_output_tokens>\n<yield_time_ms>30000</yield_time_ms>\n</exec_command>\n_command>",
                    "annotations":[]
                }]
            }])
        } else if peer.case == DsmlCase::ToolCall {
            json!([{
                "id":"message_tool_call",
                "type":"message",
                "role":"assistant",
                "status":"completed",
                "content":[{
                    "type":"output_text",
                    "text":"Continue.\n calls><tool_call>exec_command<arg_key>cmd</arg_key><arg_value>printf 42</arg_value></tool_call>",
                    "annotations":[]
                }]
            }])
        } else if peer.case == DsmlCase::CallsResidueSse {
            json!([
                {
                    "id":"reasoning_terminal",
                    "type":"reasoning",
                    "summary":[{"type":"summary_text","text":"bounded reasoning"}]
                },
                {
                    "id":"message_stable",
                    "type":"message",
                    "role":"assistant",
                    "status":"completed",
                    "content":[{"type":"output_text","text":" calls>","annotations":[]}]
                },
                {
                    "id":"fc_terminal",
                    "type":"function_call",
                    "call_id":"reordered_call",
                    "name":"exec_command",
                    "arguments":"{\"cmd\":\"printf 42\"}",
                    "status":"completed"
                }
            ])
        } else {
            let invoke = invoke_name(peer.case);
            let parameters = if peer.case == DsmlCase::RoundTrip {
                format!(
                "<｜｜DSML｜｜ parameter name=\"file_path\" string=\"true\">{}</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name=\"options\" string=\"false\">[true,2,null]</｜｜DSML｜｜ parameter>",
                peer.path
            )
            } else {
                format!(
                "<｜｜DSML｜｜ parameter name=\"file_path\" string=\"true\">{}</｜｜DSML｜｜ parameter>",
                peer.path
            )
            };
            let text = format!("Before\n<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name=\"{invoke}\">{parameters}</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>\nAfter");
            let text = if peer.case == DsmlCase::Residue {
                format!("<thinking>{text}\n<|end▁of▁analysis|>\n<|DSML|tool_calls>\n")
            } else if peer.case == DsmlCase::Literal {
                format!("```xml\n{text}\n```")
            } else {
                text
            };
            json!([{"id":"message_dsml","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]}])
        }
    } else {
        assert_eq!(turn, 1, "no retry or duplicate attempt allowed");
        let input = body["input"].as_array().unwrap();
        let call = input.iter().find(|i| i["type"] == "function_call").unwrap();
        let leaf = expected_leaf(peer.case);
        if matches!(peer.case, DsmlCase::Minimax | DsmlCase::MinimaxNamespace) {
            let calls: Vec<_> = input
                .iter()
                .filter(|item| item["type"] == "function_call")
                .collect();
            let results: Vec<_> = input
                .iter()
                .filter(|item| item["type"] == "function_call_output")
                .collect();
            assert_eq!(calls.len(), 2);
            assert_eq!(results.len(), 2);
            assert_ne!(calls[0]["call_id"], calls[1]["call_id"]);
            for (call, result) in calls.iter().zip(results) {
                let name = call["name"].as_str().unwrap();
                assert!(name == expected_leaf(peer.case) || name == invoke_name(peer.case));
                if name == expected_leaf(peer.case) {
                    assert_eq!(call["namespace"].as_str(), expected_namespace(peer.case));
                }
                assert_eq!(
                    serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
                    json!({"file_path":peer.path})
                );
                assert_eq!(call["call_id"], result["call_id"]);
                assert_eq!(
                    serde_json::from_str::<Value>(result["output"].as_str().unwrap()).unwrap(),
                    json!({"width":3,"height":2})
                );
            }
            return Response::builder().header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&json!({"id":"minimax_followup","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Two images are 3 by 2."}]}]})).unwrap())).unwrap();
        }
        if matches!(
            peer.case,
            DsmlCase::Alternate | DsmlCase::ToolCall | DsmlCase::CallsResidueSse
        ) {
            assert_eq!(call["name"], "exec_command");
            assert_eq!(
                serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
                if peer.case == DsmlCase::Alternate {
                    json!({
                        "cmd":"printf 42",
                        "max_output_tokens":4000,
                        "yield_time_ms":30000
                    })
                } else {
                    json!({"cmd":"printf 42"})
                }
            );
            let result = input
                .iter()
                .find(|i| i["type"] == "function_call_output")
                .unwrap();
            assert_eq!(result["call_id"], call["call_id"]);
            assert_eq!(result["output"], "42");
            return Response::builder()
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "id":"resp_alternate_followup",
                        "object":"response",
                        "status":"completed",
                        "output":[{
                        "id":"final_alternate",
                        "type":"message",
                        "role":"assistant",
                        "status":"completed",
                        "content":[{"type":"output_text","text":"Command output is 42.","annotations":[]}]
                    }]}))
                    .unwrap(),
                ))
                .unwrap();
        }
        // A follow-up history item may be sent as the restored client identity
        // or projected back to the provider wire name; both are faithful.
        let name = call["name"].as_str().unwrap_or_default();
        assert!(
            name == leaf || name == invoke_name(peer.case),
            "unexpected follow-up tool name {name:?}"
        );
        if name == leaf {
            assert_eq!(call["namespace"].as_str(), expected_namespace(peer.case));
        }
        let mut expected = json!({"file_path":peer.path});
        if peer.case == DsmlCase::RoundTrip {
            expected["options"] = json!([true, 2, null]);
        }
        assert_eq!(
            serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
            expected
        );
        let result = input
            .iter()
            .find(|i| i["type"] == "function_call_output")
            .unwrap();
        assert_eq!(result["call_id"], call["call_id"]);
        assert_eq!(
            serde_json::from_str::<Value>(result["output"].as_str().unwrap()).unwrap(),
            json!({"width":3,"height":2})
        );
        json!([{"id":"final","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Image is 3 by 2.","annotations":[]}]}])
    };
    let mut response = json!({"id":format!("resp_dsml_{turn}"),"object":"response","model":"wire-protocol","status":"completed","output":output,"usage":{"input_tokens":1,"output_tokens":2},"provider_extension":{"keep":true}});
    if peer.case == DsmlCase::OpaqueSse {
        // A large opaque value on the terminal response must survive untouched.
        response["vendor_terminal"] = json!({"business":"terminal-kept","raw":"T".repeat(4096)});
    }
    if !peer.sse {
        return Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&response).unwrap()))
            .unwrap();
    }
    let mut wire = String::new();
    let mut emit = |mut value: Value, carrier: bool| {
        if value["type"] == "response.output_text.delta" {
            value["logprobs"] = json!([]);
        }
        if let Some(part) = value.get_mut("part") {
            part["logprobs"] = json!([]);
        }
        if carrier && peer.case == DsmlCase::OpaqueSse {
            value["vendor_data"] = json!({"business":"carrier-kept","raw":"C".repeat(4096)});
        }
        wire.push_str(&format!(
            "event: {}\ndata: {}\n\n",
            value["type"].as_str().unwrap(),
            value
        ));
    };
    emit(
        json!({"type":"response.created","response":{"id":response["id"],"status":"in_progress","output":[]}}),
        false,
    );
    if peer.case == DsmlCase::CallsResidueSse {
        emit(
            json!({
                "type":"response.output_item.added",
                "output_index":0,
                "item":{"id":"reasoning_wire","type":"reasoning","summary":[]}
            }),
            true,
        );
        emit(
            json!({
                "type":"response.output_item.done",
                "output_index":0,
                "item":output[0]
            }),
            true,
        );
        emit(
            json!({
                "type":"response.output_item.added",
                "output_index":1,
                "item":{
                    "id":"fc_wire",
                    "type":"function_call",
                    "call_id":"reordered_call",
                    "name":"exec_command",
                    "arguments":"",
                    "status":"in_progress"
                }
            }),
            true,
        );
        emit(
            json!({
                "type":"response.function_call_arguments.delta",
                "output_index":1,
                "item_id":"fc_wire",
                "call_id":"reordered_call",
                "delta":"{\"cmd\":\"printf 42\"}"
            }),
            true,
        );
        emit(
            json!({
                "type":"response.function_call_arguments.done",
                "output_index":1,
                "item_id":"fc_wire",
                "call_id":"reordered_call",
                "arguments":"{\"cmd\":\"printf 42\"}"
            }),
            true,
        );
        emit(
            json!({
                "type":"response.output_item.done",
                "output_index":1,
                "item":{
                    "id":"fc_wire",
                    "type":"function_call",
                    "call_id":"reordered_call",
                    "name":"exec_command",
                    "arguments":"{\"cmd\":\"printf 42\"}",
                    "status":"completed"
                }
            }),
            true,
        );
        emit(
            json!({
                "type":"response.output_item.added",
                "output_index":2,
                "item":{"id":"message_stable","type":"message","role":"assistant","content":[]}
            }),
            true,
        );
        emit(
            json!({
                "type":"response.content_part.added",
                "output_index":2,
                "content_index":0,
                "item_id":"message_stable",
                "part":{"type":"output_text","text":"","annotations":[]}
            }),
            true,
        );
        emit(
            json!({
                "type":"response.output_text.delta",
                "output_index":2,
                "content_index":0,
                "item_id":"message_stable",
                "delta":" calls>"
            }),
            true,
        );
        emit(
            json!({
                "type":"response.output_text.done",
                "output_index":2,
                "content_index":0,
                "item_id":"message_stable",
                "text":" calls>"
            }),
            true,
        );
        emit(
            json!({
                "type":"response.content_part.done",
                "output_index":2,
                "content_index":0,
                "item_id":"message_stable",
                "part":output[1]["content"][0]
            }),
            true,
        );
        emit(
            json!({
                "type":"response.output_item.done",
                "output_index":2,
                "item":output[1]
            }),
            true,
        );
        emit(
            json!({"type":"response.completed","response":response}),
            false,
        );
        return Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(wire))
            .unwrap();
    }
    for (index, item) in output.as_array().unwrap().iter().enumerate() {
        if item["type"] == "function_call" {
            emit(
                json!({"type":"response.output_item.added","output_index":index,"item":item}),
                true,
            );
            emit(
                json!({"type":"response.function_call_arguments.delta","output_index":index,"item_id":item["id"],"delta":item["arguments"]}),
                true,
            );
            emit(
                json!({"type":"response.function_call_arguments.done","output_index":index,"item_id":item["id"],"arguments":item["arguments"]}),
                true,
            );
            emit(
                json!({"type":"response.output_item.done","output_index":index,"item":item}),
                true,
            );
            continue;
        }
        emit(
            json!({"type":"response.output_item.added","output_index":index,"item":{"id":item["id"],"type":"message","role":"assistant","content":[]}}),
            true,
        );
        let text = item["content"][0]["text"].as_str().unwrap();
        emit(
            json!({"type":"response.content_part.added","output_index":index,"content_index":0,"item_id":item["id"],"part":{"type":"output_text","text":"","annotations":[]}}),
            true,
        );
        for ch in text.chars() {
            emit(
                json!({"type":"response.output_text.delta","output_index":index,"content_index":0,"item_id":item["id"],"delta":ch.to_string()}),
                true,
            );
        }
        emit(
            json!({"type":"response.output_text.done","output_index":index,"content_index":0,"item_id":item["id"],"text":text}),
            true,
        );
        emit(
            json!({"type":"response.content_part.done","output_index":index,"content_index":0,"item_id":item["id"],"part":item["content"][0]}),
            true,
        );
        emit(
            json!({"type":"response.output_item.done","output_index":index,"item":item}),
            true,
        );
    }
    emit(
        json!({"type":"response.completed","response":response}),
        false,
    );
    if matches!(peer.case, DsmlCase::Minimax | DsmlCase::MinimaxPartial) {
        let fragments: Vec<_> = wire
            .as_bytes()
            .chunks(7)
            .map(|chunk| Ok::<_, std::io::Error>(chunk.to_vec()))
            .collect();
        return Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(futures_util::stream::iter(fragments)))
            .unwrap();
    }
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from(wire))
        .unwrap()
}

async fn run(case: DsmlCase, sse: bool) {
    run_mode(case, sse, false).await;
}

async fn run_mode(case: DsmlCase, sse: bool, relay: bool) {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_PROTOCOL_DECISION_KEY", "dsml-test-key");
    let fixture = std::env::temp_dir().join(format!(
        "rcc-dsml-{}-{}-{sse}.png",
        std::process::id(),
        case as u8
    ));
    // Valid PNG fixture: the client reads the actual file and decodes IHDR dimensions.
    let png = [
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0, 0, 0, 2, 8, 2,
        0, 0, 0, 18, 22, 241, 77, 0, 0, 0, 20, 73, 68, 65, 84, 120, 156, 99, 228, 18, 145, 99, 0,
        3, 38, 8, 197, 192, 192, 0, 0, 4, 96, 0, 64, 242, 81, 76, 125, 0, 0, 0, 0, 73, 69, 78, 68,
        174, 66, 96, 130,
    ];
    fs::write(&fixture, png).unwrap();
    let peer = DsmlPeer {
        path: fixture.to_str().unwrap().to_owned(),
        calls: Arc::default(),
        sse,
        case,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .with_state(peer.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut manifest = responses_direct_binding_provider_protocol_manifest(
        free_port(),
        free_port(),
        "responses",
        &format!("http://{addr}/v1"),
        "\"direct\", \"relay\"",
    );
    if relay {
        let provider = manifest.providers.get_mut("mixed").unwrap();
        let responses =
            serde_json::from_value(json!({"process":"chat","streaming":"always"})).unwrap();
        provider.responses = Some(responses);
        provider.interfaces.get_mut("default").unwrap().responses = provider.responses.clone();
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::new();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let tools = client_tools(case);
    let first = client
        .post(&endpoint)
        .json(&json!({"model":"client-test","input":first_input(case),"tools":tools,"stream":sse}))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);
    let wire = first.text().await.unwrap();
    let result: Value = if sse {
        if case != DsmlCase::Literal
            && case != DsmlCase::OpaqueSse
            && opaque_tool_text(case).is_none()
        {
            assert!(
                !wire.contains("DSML"),
                "converted envelope leaked in early SSE: {wire}"
            );
        }
        wire.lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .find(|v| v["type"] == "response.completed")
            .unwrap()["response"]
            .clone()
    } else {
        serde_json::from_str(&wire).unwrap()
    };
    let output = result["output"].as_array().unwrap();
    let calls: Vec<_> = output
        .iter()
        .filter(|i| i["type"] == "function_call")
        .collect();
    if matches!(case, DsmlCase::Minimax | DsmlCase::MinimaxNamespace) {
        assert_eq!(
            calls.len(),
            2,
            "f665809 complete invoke envelopes must become two native calls: {result}"
        );
        assert!(
            !wire.contains("]<]minimax[>[") && !wire.contains("<invoke"),
            "f665809 wrapper leaked: {wire}"
        );
        assert_ne!(calls[0]["call_id"], calls[1]["call_id"]);
        let mut input = first_input(case).as_array().unwrap().clone();
        input.extend(output.clone());
        for call in &calls {
            assert_eq!(call["name"], expected_leaf(case));
            assert_eq!(call["namespace"].as_str(), expected_namespace(case));
            let args: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
            assert_eq!(args, json!({"file_path":peer.path}));
            let bytes = fs::read(args["file_path"].as_str().unwrap()).unwrap();
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
            let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
            let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
            assert_eq!((width, height), (3, 2));
            input.push(json!({"type":"function_call_output","call_id":call["call_id"],"output":json!({"width":width,"height":height}).to_string()}));
        }
        let followup = client
            .post(&endpoint)
            .json(&json!({"model":"client-test","input":input,"tools":tools,"stream":false}))
            .send()
            .await
            .unwrap();
        assert_eq!(followup.status(), 200);
        assert!(followup
            .text()
            .await
            .unwrap()
            .contains("Two images are 3 by 2."));
        assert_eq!(
            peer.calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "no retry or duplicate business attempt"
        );
        handle.shutdown().await;
        task.abort();
        fs::remove_file(fixture).unwrap();
        std::env::remove_var("V3_PROTOCOL_DECISION_KEY");
        return;
    }
    if case == DsmlCase::UnknownLabelOnly {
        assert!(calls.is_empty(), "unknown text must not create a tool call");
        assert_eq!(
            output[0]["content"][0]["text"],
            opaque_tool_text(case)
                .unwrap()
                .strip_prefix("<|DSML|tool_calls>\n")
                .unwrap()
        );
        assert_eq!(peer.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        handle.shutdown().await;
        task.abort();
        fs::remove_file(fixture).unwrap();
        std::env::remove_var("V3_PROTOCOL_DECISION_KEY");
        return;
    }
    if case == DsmlCase::Literal {
        assert!(
            calls.is_empty(),
            "quoted example must never execute: {result}"
        );
        let text = output[0]["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("```xml\nBefore\n<｜｜DSML｜｜ calls>"));
        assert!(text.ends_with("\nAfter\n```"));
        assert!(text.contains(&peer.path));
        assert_eq!(peer.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        handle.shutdown().await;
        task.abort();
        fs::remove_file(fixture).unwrap();
        std::env::remove_var("V3_PROTOCOL_DECISION_KEY");
        return;
    }
    if case == DsmlCase::OpaqueSse {
        assert!(
            calls.is_empty(),
            "an event-level extension has no faithful association, so provider text must survive: {result}"
        );
        let text = output[0]["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("Before\n<｜｜DSML｜｜ calls>"));
        assert!(text.ends_with("\nAfter"));
        assert!(text.contains(&peer.path));
        assert_eq!(result["vendor_terminal"]["business"], "terminal-kept");
        assert_eq!(
            result["vendor_terminal"]["raw"].as_str().unwrap().len(),
            4096
        );
        let events: Vec<Value> = wire
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        let carriers: Vec<_> = events
            .iter()
            .filter(|v| {
                matches!(
                    v["type"].as_str(),
                    Some(
                        "response.output_item.added"
                            | "response.output_item.done"
                            | "response.content_part.added"
                            | "response.content_part.done"
                            | "response.output_text.delta"
                            | "response.output_text.done"
                    )
                )
            })
            .collect();
        assert!(!carriers.is_empty());
        for carrier in carriers {
            assert_eq!(
                carrier["vendor_data"]["business"], "carrier-kept",
                "an opaque carrier extension was dropped: {carrier}"
            );
            assert_eq!(
                carrier["vendor_data"]["raw"].as_str().unwrap().len(),
                4096,
                "an opaque carrier value changed: {carrier}"
            );
        }
        assert_eq!(peer.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        handle.shutdown().await;
        task.abort();
        fs::remove_file(fixture).unwrap();
        std::env::remove_var("V3_PROTOCOL_DECISION_KEY");
        return;
    }
    if case == DsmlCase::CallsResidueSse {
        assert_eq!(calls.len(), 1, "native call was lost: {result}");
        assert!(
            !output.iter().any(|item| item["type"] == "message"),
            "known CLOSE message survived: {result}"
        );
        assert!(
            output.iter().any(|item| item["type"] == "reasoning"),
            "native reasoning was lost: {result}"
        );
        let call = calls[0];
        assert_eq!(call["id"], "fc_terminal");
        assert_eq!(call["call_id"], "reordered_call");
        assert_eq!(
            serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
            json!({"cmd":"printf 42"})
        );
        let executed = std::process::Command::new("printf")
            .arg("42")
            .output()
            .unwrap();
        assert!(executed.status.success());
        let stdout = String::from_utf8(executed.stdout).unwrap();
        assert_eq!(stdout, "42");
        let mut input = first_input(case).as_array().unwrap().clone();
        input.extend(output.clone());
        input.push(json!({
            "type":"function_call_output",
            "call_id":call["call_id"],
            "output":stdout
        }));
        let second = client
            .post(&endpoint)
            .json(&json!({"model":"client-test","input":input,"tools":tools,"stream":false}))
            .send()
            .await
            .unwrap();
        assert_eq!(second.status(), 200);
        assert!(second
            .text()
            .await
            .unwrap()
            .contains("Command output is 42."));
        assert_eq!(peer.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        handle.shutdown().await;
        task.abort();
        fs::remove_file(fixture).unwrap();
        std::env::remove_var("V3_PROTOCOL_DECISION_KEY");
        return;
    }
    if matches!(case, DsmlCase::Alternate | DsmlCase::ToolCall) {
        let visible: String = output
            .iter()
            .filter(|item| item["type"] == "message")
            .filter_map(|item| item["content"].as_array())
            .flatten()
            .filter_map(|part| part["text"].as_str())
            .collect();
        assert_eq!(visible, "Continue.\n", "tool envelope or prefix leaked");
        assert_eq!(
            calls.len(),
            1,
            "alternate grammar must become a native call: {result}"
        );
        let call = calls[0];
        assert_eq!(call["name"], "exec_command");
        assert_eq!(output[0]["content"][0]["text"], "Continue.\n");
        assert_eq!(
            serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
            if case == DsmlCase::Alternate {
                json!({
                    "cmd":"printf 42",
                    "max_output_tokens":4000,
                    "yield_time_ms":30000
                })
            } else {
                json!({"cmd":"printf 42"})
            }
        );
        // Execute only the controlled safe fixture command. No screenshot
        // business command is ever run.
        let executed = std::process::Command::new("printf")
            .arg("42")
            .output()
            .unwrap();
        assert!(executed.status.success());
        let stdout = String::from_utf8(executed.stdout).unwrap();
        assert_eq!(stdout, "42");
        let mut input = first_input(case).as_array().unwrap().clone();
        input.extend(output.clone());
        input.push(json!({
            "type":"function_call_output",
            "call_id":call["call_id"],
            "output":stdout
        }));
        let second = client
            .post(&endpoint)
            .json(&json!({"model":"client-test","input":input,"tools":tools,"stream":false}))
            .send()
            .await
            .unwrap();
        assert_eq!(second.status(), 200);
        assert!(second
            .text()
            .await
            .unwrap()
            .contains("Command output is 42."));
        assert_eq!(peer.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        handle.shutdown().await;
        task.abort();
        fs::remove_file(fixture).unwrap();
        std::env::remove_var("V3_PROTOCOL_DECISION_KEY");
        return;
    }
    assert_eq!(calls.len(), 1, "DSML must become a native call: {result}");
    let call = calls[0];
    assert_eq!(call["name"], expected_leaf(case));
    assert_eq!(call["namespace"].as_str(), expected_namespace(case));
    assert_eq!(result["provider_extension"], json!({"keep":true}));
    assert_eq!(result["usage"]["output_tokens"], 2);
    if let Some(text) = opaque_tool_text(case) {
        assert_eq!(output[0]["content"][0]["text"], text);
        assert_eq!(call["call_id"], "native_sibling_call");
        assert_eq!(call["id"], "native_sibling");
        if sse {
            let streamed: String = wire
                .lines()
                .filter_map(|line| line.strip_prefix("data: "))
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(|event| event["type"] == "response.output_text.delta")
                .filter_map(|event| event["delta"].as_str().map(str::to_owned))
                .collect();
            assert_eq!(streamed, text, "opaque text changed in streamed deltas");
        }
    } else {
        assert_eq!(output[0]["content"][0]["text"], "Before\n");
        if case == DsmlCase::Residue {
            assert!(
                !output.iter().any(|item| item["type"] == "reasoning"),
                "half thinking beside harvested tool must remain text"
            );
            assert!(!wire.contains("<thinking>"), "half thinking marker leaked");
        }
        if case == DsmlCase::Residue {
            // The marker lines and their terminators are removed; the retained
            // prose span keeps its exact source text.
            assert_eq!(output[2]["content"][0]["text"], "\nAfter\n");
        } else {
            assert_eq!(output[2]["content"][0]["text"], "\nAfter");
        }
    }
    if sse {
        let events: Vec<Value> = wire
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        let added: Vec<_> = events
            .iter()
            .filter(|v| {
                v["type"] == "response.output_item.added" && v["item"]["type"] == "function_call"
            })
            .collect();
        assert_eq!(added.len(), 1);
        assert_eq!(added[0]["item"]["call_id"], call["call_id"]);
        assert_eq!(added[0]["item"]["id"], call["id"]);
        let delta = events
            .iter()
            .find(|v| v["type"] == "response.function_call_arguments.delta")
            .unwrap();
        assert_eq!(delta["delta"], call["arguments"]);
        assert_eq!(delta["item_id"], call["id"]);
        assert_eq!(delta["output_index"], 1);
        for event in events
            .iter()
            .filter(|v| v["type"] == "response.content_part.added")
        {
            assert_eq!(event["part"]["text"], "");
        }
    }
    let args: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
    let mut expected = json!({"file_path":peer.path});
    if case == DsmlCase::RoundTrip {
        expected["options"] = json!([true, 2, null]);
    }
    assert_eq!(args, expected);
    // The client actually executes the declared local tool: read and decode the PNG.
    let bytes = fs::read(args["file_path"].as_str().unwrap()).unwrap();
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    let mut input = first_input(case).as_array().unwrap().clone();
    input.extend(output.clone());
    input.push(json!({"type":"function_call_output","call_id":call["call_id"],"output":json!({"width":width,"height":height}).to_string()}));
    let second = client
        .post(&endpoint)
        .json(&json!({"model":"client-test","input":input,"tools":tools,"stream":false}))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), 200);
    assert!(second.text().await.unwrap().contains("Image is 3 by 2."));
    assert_eq!(peer.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    handle.shutdown().await;
    task.abort();
    fs::remove_file(fixture).unwrap();
    std::env::remove_var("V3_PROTOCOL_DECISION_KEY");
}

#[tokio::test]
async fn responses_direct_dsml_json_tool_round_trip() {
    run(DsmlCase::RoundTrip, false).await
}

#[tokio::test]
async fn responses_direct_dsml_f665809_minimax_json_round_trip() {
    run(DsmlCase::Minimax, false).await;
}

#[tokio::test]
async fn responses_direct_dsml_f665809_minimax_sse_round_trip() {
    run(DsmlCase::Minimax, true).await;
}

#[tokio::test]
async fn responses_direct_dsml_f665809_namespace_round_trip() {
    for stream in [false, true] {
        run(DsmlCase::MinimaxNamespace, stream).await;
    }
}

#[tokio::test]
async fn responses_direct_dsml_f665809_literal_and_unknown_preserve_native_pair() {
    for case in [DsmlCase::MinimaxLiteral, DsmlCase::MinimaxUnknown] {
        for stream in [false, true] {
            run(case, stream).await;
        }
    }
}

#[tokio::test]
async fn responses_direct_dsml_f665809_explicit_relay_responses_round_trip() {
    for stream in [false, true] {
        run_mode(DsmlCase::Minimax, stream, true).await;
    }
}

#[tokio::test]
async fn responses_direct_dsml_f665809_partial_attempt_exhaustion_is_transport_failure() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_PROTOCOL_DECISION_KEY", "dsml-test-key");
    for stream in [false, true] {
        let peer = DsmlPeer {
            path: "owned.png".into(),
            calls: Arc::default(),
            sse: stream,
            case: DsmlCase::MinimaxPartial,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v1/responses", post(upstream))
            .with_state(peer.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let handle =
            spawn_v3_server_aggregate(responses_direct_binding_provider_protocol_manifest(
                free_port(),
                free_port(),
                "responses",
                &format!("http://{addr}/v1"),
                "\"direct\"",
            ))
            .await
            .unwrap();
        let url = format!("http://{}/v1/responses", handle.listeners[0].addr);
        let response = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap().post(url)
            .json(&json!({"model":"client-test","input":"owned incomplete fixture","stream":stream,"tools":client_tools(DsmlCase::MinimaxPartial)})).send().await;
        match response {
            Err(error) => assert!(
                !error.is_timeout(),
                "timeout is not transport failure: {error}"
            ),
            Ok(response) => {
                use futures_util::StreamExt;
                let mut chunks = response.bytes_stream();
                let mut wire = Vec::new();
                let mut failed = false;
                while let Some(chunk) = chunks.next().await {
                    match chunk {
                        Ok(bytes) => wire.extend_from_slice(&bytes),
                        Err(error) => {
                            assert!(!error.is_timeout());
                            failed = true;
                            break;
                        }
                    }
                }
                assert!(failed, "truncated executable envelope completed silently");
                let wire = String::from_utf8_lossy(&wire);
                for forbidden in [
                    "FAILED_ATTEMPT_PROSE",
                    "minimax",
                    "function_call",
                    "response.completed",
                    "response.failed",
                    "network_error",
                ] {
                    assert!(!wire.contains(forbidden), "failed attempt leaked: {wire}");
                }
            }
        }
        assert_eq!(peer.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let health = reqwest::get(format!("http://{}/health", handle.listeners[0].addr))
            .await
            .unwrap();
        assert_eq!(health.status(), 200);
        handle.shutdown().await;
        task.abort();
    }
    std::env::remove_var("V3_PROTOCOL_DECISION_KEY");
}

#[tokio::test]
async fn responses_direct_dsml_sse_tool_round_trip() {
    run(DsmlCase::RoundTrip, true).await
}

#[tokio::test]
async fn responses_direct_dsml_literal_text_preserved() {
    run(DsmlCase::Literal, false).await;
    run(DsmlCase::Literal, true).await;
}

#[tokio::test]
async fn responses_direct_dsml_unknown_complete_tool_text_preserves_native_round_trip() {
    run(DsmlCase::UnknownComplete, false).await;
    run(DsmlCase::UnknownComplete, true).await;
}

#[tokio::test]
async fn responses_direct_dsml_opaque_complete_tool_text_preserves_native_round_trip() {
    run(DsmlCase::OpaqueComplete, false).await;
    run(DsmlCase::OpaqueComplete, true).await;
}

#[tokio::test]
async fn responses_direct_dsml_opaque_alternate_tool_text_preserves_native_round_trip() {
    run(DsmlCase::OpaqueAlternate, false).await;
    run(DsmlCase::OpaqueAlternate, true).await;
}

#[tokio::test]
async fn responses_direct_dsml_label_beside_unknown_complete_text_is_not_a_failure() {
    run(DsmlCase::UnknownLabelOnly, false).await;
    run(DsmlCase::UnknownLabelOnly, true).await;
}

#[tokio::test]
async fn responses_direct_dsml_opaque_embedded_thinking_preserves_native_round_trip() {
    run(DsmlCase::OpaqueEmbeddedThinking, false).await;
    run(DsmlCase::OpaqueEmbeddedThinking, true).await;
}

#[tokio::test]
async fn responses_direct_dsml_nested_namespace_json_tool_round_trip() {
    run(DsmlCase::Nested, false).await
}

#[tokio::test]
async fn responses_direct_dsml_nested_namespace_sse_tool_round_trip() {
    run(DsmlCase::Nested, true).await
}

#[tokio::test]
async fn responses_direct_dsml_discovered_function_json_tool_round_trip() {
    run(DsmlCase::Discovered, false).await
}

#[tokio::test]
async fn responses_direct_dsml_discovered_function_sse_tool_round_trip() {
    run(DsmlCase::Discovered, true).await
}

#[tokio::test]
async fn responses_direct_dsml_opaque_carrier_extensions_sse_preserved() {
    run(DsmlCase::OpaqueSse, true).await
}

#[tokio::test]
async fn responses_direct_dsml_residue_json_tool_round_trip() {
    run(DsmlCase::Residue, false).await
}

#[tokio::test]
async fn responses_direct_dsml_residue_sse_tool_round_trip() {
    run(DsmlCase::Residue, true).await
}

#[tokio::test]
async fn responses_direct_dsml_alternate_json_tool_round_trip() {
    run(DsmlCase::Alternate, false).await
}

#[tokio::test]
async fn responses_direct_dsml_alternate_sse_tool_round_trip() {
    run(DsmlCase::Alternate, true).await
}

#[tokio::test]
async fn responses_direct_dsml_tool_call_arg_key_value_json_tool_round_trip() {
    run(DsmlCase::ToolCall, false).await
}

#[tokio::test]
async fn responses_direct_dsml_tool_call_arg_key_value_sse_tool_round_trip() {
    run(DsmlCase::ToolCall, true).await
}

#[tokio::test]
async fn responses_direct_dsml_sse_reordered_native_calls_close_round_trip() {
    run(DsmlCase::CallsResidueSse, true).await
}
