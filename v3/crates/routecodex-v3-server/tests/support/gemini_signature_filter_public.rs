use super::*;

pub(super) fn blocked_response(body: &Value, uri: &Uri) -> Response<Body> {
    let mut blocked = json!({"promptFeedback":{"blockReason":"SAFETY","safetyRatings":[{"category":"HARM_CATEGORY_DANGEROUS_CONTENT","probability":"HIGH"}]},"usageMetadata":{"promptTokenCount":7,"totalTokenCount":7}});
    if request_marker(body).contains("empty candidates") {
        blocked["candidates"] = json!([]);
    }
    if uri.path().contains(":streamGenerateContent") {
        stream_frame(blocked)
    } else {
        ok_json(blocked)
    }
}

fn stream_frame(frame: Value) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(format!("data: {frame}\n\n")))
        .unwrap()
}

pub(super) fn stream_followup() -> Response<Body> {
    stream_frame(
        json!({"candidates":[{"index":0,"content":{"parts":[{"text":"namespace follow up"}]},"finishReason":"STOP"}]}),
    )
}

pub(super) fn check_history_signature(body: &Value, part: &Value, violations: &mut Vec<String>) {
    let call = &part["functionCall"];
    // This fixture's malformed-business controls are intentionally unsigned.
    // Their exact call IDs distinguish them from the signed consumer flow.
    if matches!(
        call["id"].as_str(),
        Some("malformed_function" | "malformed_custom")
    ) {
        if part.get("thoughtSignature").is_some() {
            violations.push(format!(
                "unsigned malformed call borrowed a signature: {part}"
            ));
        }
        return;
    }
    for (description, name) in declared_wire_names(body) {
        if call["name"] == name {
            if let Some(expected) = signature(&description) {
                if part["thoughtSignature"] != expected {
                    violations.push(format!(
                        "signed history must retain exact part signature for {name}: {part}"
                    ));
                }
            } else if part.get("thoughtSignature").is_some() {
                violations.push(format!("unsigned call borrowed a signature: {part}"));
            }
        }
    }
}

pub(super) fn signature(description: &str) -> Option<&'static str> {
    match description {
        FUNCTION_DESCRIPTION => Some("opaque/function/+=="),
        CUSTOM_DESCRIPTION => Some("opaque/custom/+=="),
        _ => None,
    }
}

fn terminal(status: StatusCode, text: &str, stream: bool) -> Value {
    assert_eq!(status, StatusCode::OK);
    if stream {
        sse_events(text)
            .into_iter()
            .find_map(|event| {
                matches!(
                    event["type"].as_str(),
                    Some("response.completed" | "response.incomplete")
                )
                .then(|| event["response"].clone())
            })
            .unwrap_or_else(|| panic!("missing business terminal: {text}"))
    } else {
        parsed(status, text).unwrap()
    }
}

async fn signed_round_trip(stream: bool) {
    let (base, mut captures, shutdown) = spawn_upstream(Target::Gemini).await;
    let handle =
        spawn_v3_server_aggregate(manifest(Target::Gemini, test_ports::free_port(), &base))
            .await
            .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = http_client();
    let mut initial = first_turn_request(Target::Gemini);
    initial["stream"] = json!(stream);
    let (result, wire) = request(&client, &endpoint, &initial, &mut captures, "SIGNED_FIRST").await;
    assert!(captured_violations(&wire.unwrap()).is_empty());
    let (status, text) = result.unwrap();
    eprintln!("EVIDENCE_SIGNED_CLIENT stream={stream} {text}");
    let response = terminal(status, &text, stream);
    let calls: Vec<Value> = output_items(&response)
        .unwrap()
        .into_iter()
        .filter(|item| {
            matches!(
                item["type"].as_str(),
                Some("function_call" | "custom_tool_call")
            )
        })
        .collect();
    assert_eq!(calls.len(), 2);
    for call in &calls {
        let (description, namespace, leaf) = if call["type"] == "function_call" {
            (FUNCTION_DESCRIPTION, ORDINARY_NAMESPACE, FUNCTION_LEAF)
        } else {
            (CUSTOM_DESCRIPTION, NESTED_NAMESPACE, CUSTOM_LEAF)
        };
        assert_eq!(call["namespace"], namespace);
        assert_eq!(call["name"], leaf);
        assert_eq!(
            call["thought_signature"],
            signature(description).unwrap(),
            "signature lost: {call}"
        );
        if stream {
            let items: Vec<Value> = sse_events(&text)
                .into_iter()
                .filter(|event| {
                    matches!(
                        event["type"].as_str(),
                        Some("response.output_item.added" | "response.output_item.done")
                    )
                })
                .filter_map(|event| event.get("item").cloned())
                .filter(|item| item["call_id"] == call["call_id"])
                .collect();
            assert_eq!(items.len(), 2, "added and done items must retain signature");
            for item in items {
                assert_eq!(item["thought_signature"], call["thought_signature"]);
            }
        }
    }
    let mut input = vec![json!({"role":"user","content":"follow up signed calls"})];
    input.extend(calls.iter().cloned());
    input.extend(calls.iter().map(|call| json!({"type":if call["type"] == "custom_tool_call" {"custom_tool_call_output"} else {"function_call_output"},"call_id":call["call_id"],"output":execute_consumer(call)})));
    let followup = json!({"model":Target::Gemini.client_model(),"stream":stream,"tools":client_tools(),"input":input});
    let (result, wire) = request(
        &client,
        &endpoint,
        &followup,
        &mut captures,
        "SIGNED_FOLLOWUP",
    )
    .await;
    let wire = wire.unwrap();
    assert_eq!(
        captured_violations(&wire),
        Vec::<String>::new(),
        "strict upstream rejected follow-up: {wire}"
    );
    let (status, text) = result.unwrap();
    let response = terminal(status, &text, stream);
    assert_eq!(response["status"], "completed");
    assert!(response["output"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["content"][0]["text"] == "namespace follow up"));
    assert!(
        captures.try_recv().is_err(),
        "no provider recovery or duplicate attempts"
    );
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn gemini_signed_namespace_json_consumer_followup() {
    let _lock = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("signed-json");
    signed_round_trip(false).await;
}

#[tokio::test]
async fn gemini_signed_namespace_sse_consumer_followup() {
    let _lock = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("signed-sse");
    signed_round_trip(true).await;
}

async fn prompt_block(stream: bool, empty: bool) {
    let (base, mut captures, shutdown) = spawn_upstream(Target::Gemini).await;
    let handle =
        spawn_v3_server_aggregate(manifest(Target::Gemini, test_ports::free_port(), &base))
            .await
            .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let request_body = json!({"model":Target::Gemini.client_model(),"stream":stream,"input":if empty {"prompt block empty candidates"} else {"prompt block omitted candidates"}});
    let (result, wire) = request(
        &http_client(),
        &endpoint,
        &request_body,
        &mut captures,
        "PROMPT_BLOCK",
    )
    .await;
    assert!(captured_violations(&wire.unwrap()).is_empty());
    let (status, text) = result.unwrap();
    eprintln!("EVIDENCE_PROMPT_BLOCK stream={stream} empty={empty} {text}");
    let response = terminal(status, &text, stream);
    assert_eq!(response["status"], "incomplete");
    assert_eq!(response["incomplete_details"]["reason"], "content_filter");
    assert_eq!(
        response["promptFeedback"],
        json!({"blockReason":"SAFETY","safetyRatings":[{"category":"HARM_CATEGORY_DANGEROUS_CONTENT","probability":"HIGH"}]})
    );
    assert_eq!(response["usage"]["promptTokenCount"], 7);
    assert_eq!(response["usage"]["total_tokens"], 7);
    assert_eq!(response["output"], json!([]));
    assert!(
        captures.try_recv().is_err(),
        "prompt block must not enter provider recovery"
    );
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn gemini_prompt_block_json_omitted_candidates() {
    let _lock = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("block-json-omitted");
    prompt_block(false, false).await;
}
#[tokio::test]
async fn gemini_prompt_block_json_empty_candidates() {
    let _lock = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("block-json-empty");
    prompt_block(false, true).await;
}
#[tokio::test]
async fn gemini_prompt_block_sse_omitted_candidates() {
    let _lock = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("block-sse-omitted");
    prompt_block(true, false).await;
}
#[tokio::test]
async fn gemini_prompt_block_sse_empty_candidates() {
    let _lock = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("block-sse-empty");
    prompt_block(true, true).await;
}
