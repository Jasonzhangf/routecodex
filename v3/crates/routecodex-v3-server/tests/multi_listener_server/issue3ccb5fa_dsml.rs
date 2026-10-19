use super::*;

#[derive(Clone)]
struct DsmlPeer {
    path: String,
    calls: Arc<std::sync::atomic::AtomicUsize>,
    sse: bool,
    literal: bool,
}

async fn upstream(
    State(peer): State<DsmlPeer>,
    axum::Json(body): axum::Json<Value>,
) -> Response<Body> {
    let turn = peer.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(body["tools"][0]["name"], "read_image");
    let output = if turn == 0 {
        let text = format!("Before\n<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name=\"read_image\"><｜｜DSML｜｜ parameter name=\"file_path\" string=\"true\">{}</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name=\"options\" string=\"false\">[true,2,null]</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>\nAfter", peer.path);
        let text = if peer.literal {
            format!("```xml\n{text}\n```")
        } else {
            text
        };
        json!([{"id":"message_dsml","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]}])
    } else {
        assert_eq!(turn, 1, "no retry or duplicate attempt allowed");
        let input = body["input"].as_array().unwrap();
        let call = input.iter().find(|i| i["type"] == "function_call").unwrap();
        assert_eq!(call["name"], "read_image");
        assert_eq!(
            serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
            json!({"file_path":peer.path,"options":[true,2,null]})
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
    let response = json!({"id":format!("resp_dsml_{turn}"),"object":"response","model":"wire-protocol","status":"completed","output":output,"usage":{"input_tokens":1,"output_tokens":2},"provider_extension":{"keep":true}});
    if !peer.sse {
        return Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&response).unwrap()))
            .unwrap();
    }
    let mut wire = String::new();
    let mut event = |value: Value| {
        wire.push_str(&format!(
            "event: {}\ndata: {}\n\n",
            value["type"].as_str().unwrap(),
            value
        ));
    };
    event(
        json!({"type":"response.created","response":{"id":response["id"],"status":"in_progress","output":[]}}),
    );
    for (index, item) in output.as_array().unwrap().iter().enumerate() {
        event(
            json!({"type":"response.output_item.added","output_index":index,"item":{"id":item["id"],"type":"message","role":"assistant","content":[]}}),
        );
        let text = item["content"][0]["text"].as_str().unwrap();
        for ch in text.chars() {
            event(
                json!({"type":"response.output_text.delta","output_index":index,"content_index":0,"item_id":item["id"],"delta":ch.to_string()}),
            );
        }
        event(
            json!({"type":"response.output_text.done","output_index":index,"content_index":0,"item_id":item["id"],"text":text}),
        );
        event(json!({"type":"response.output_item.done","output_index":index,"item":item}));
    }
    event(json!({"type":"response.completed","response":response}));
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from(wire))
        .unwrap()
}

async fn run(sse: bool, literal: bool) {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_PROTOCOL_DECISION_KEY", "dsml-test-key");
    let fixture = std::env::temp_dir().join(format!("rcc-dsml-{}-{sse}.png", std::process::id()));
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
        literal,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .with_state(peer.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let manifest = responses_direct_binding_provider_protocol_manifest(
        free_port(),
        free_port(),
        "responses",
        &format!("http://{addr}/v1"),
        "\"direct\"",
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::new();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let tool = json!({"type":"function","name":"read_image","parameters":{"type":"object","properties":{"file_path":{"type":"string"},"options":{"type":"array"}}}});
    let first = client.post(&endpoint).json(&json!({"model":"client-test","input":"Read the owned image","tools":[tool.clone()],"stream":sse})).send().await.unwrap();
    assert_eq!(first.status(), 200);
    let wire = first.text().await.unwrap();
    let result: Value = if sse {
        if !literal {
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
    if literal {
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
    assert_eq!(calls.len(), 1, "DSML must become a native call: {result}");
    let call = calls[0];
    assert_eq!(result["provider_extension"], json!({"keep":true}));
    assert_eq!(result["usage"]["output_tokens"], 2);
    assert_eq!(output[0]["content"][0]["text"], "Before\n");
    assert_eq!(output[2]["content"][0]["text"], "\nAfter");
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
    assert_eq!(args, json!({"file_path":peer.path,"options":[true,2,null]}));
    let bytes = fs::read(args["file_path"].as_str().unwrap()).unwrap();
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    let mut input = vec![json!({"role":"user","content":"Read the owned image"})];
    input.extend(output.clone());
    input.push(json!({"type":"function_call_output","call_id":call["call_id"],"output":json!({"width":width,"height":height}).to_string()}));
    let second = client
        .post(&endpoint)
        .json(&json!({"model":"client-test","input":input,"tools":[tool],"stream":false}))
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
    run(false, false).await
}

#[tokio::test]
async fn responses_direct_dsml_sse_tool_round_trip() {
    run(true, false).await
}

#[tokio::test]
async fn responses_direct_dsml_literal_text_preserved() {
    run(false, true).await;
    run(true, true).await;
}
