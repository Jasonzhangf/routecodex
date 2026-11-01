//! Current permission_error/code11128 policy through the public Responses Relay.
//! This is an equivalent controlled case, not a replay of historical #245.
//! Native hosted search, function-search history and typed health stay separate.

include!("issue245_permission_search_fixture.rs");

fn search_request(marker: &str, stream: bool) -> Value {
    json!({
        "model":"chat-wire", "stream":stream,
        "input":[
            {"role":"user", "content":marker},
            {"type":"function_call", "call_id":"call_issue245_prior_search", "name":"search_files",
                "arguments":"{\"query\":\"issue245 prior search\"}"},
            {"type":"function_call_output", "call_id":"call_issue245_prior_search",
                "output":"issue245 prior search result"}
        ],
        "tools":[{"type":"function", "name":"issue245_continuation",
            "description":"issue245 paired continuation", "parameters":{
                "type":"object", "properties":{"nonce":{"type":"string"}, "query":{"type":"string"}},
                "required":["nonce", "query"]
            }}]
    })
}

async fn successful_response(client: &reqwest::Client, base: &str, request: &Value) -> Value {
    let response = client
        .post(format!("{base}/v1/responses"))
        .json(request)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = if request["stream"] == true {
        assert!(response.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream"));
        let wire = response
            .text()
            .await
            .expect("successful SSE transfer must finish normally");
        let events: Vec<Value> = wire
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter(|data| *data != "[DONE]")
            .map(|data| serde_json::from_str(data).expect("SSE data must be JSON"))
            .collect();
        assert!(
            events
                .iter()
                .all(|event| event["type"] != "error" && event["type"] != "response.failed"),
            "{wire}"
        );
        let completed = events
            .iter()
            .find(|event| event["type"] == "response.completed")
            .expect("SSE must complete with actual business content");
        for call in completed["response"]["output"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "function_call")
        {
            let done = events
                .iter()
                .find(|event| {
                    event["type"] == "response.output_item.done"
                        && event["item"]["call_id"] == call["call_id"]
                })
                .expect("SSE must deliver the completed function item");
            assert_eq!(done["item"]["name"], call["name"]);
            let added = events
                .iter()
                .find(|event| {
                    event["type"] == "response.output_item.added"
                        && event["item"]["call_id"] == call["call_id"]
                })
                .expect("SSE must establish the tool identity");
            let arguments_done = events
                .iter()
                .find(|event| {
                    event["type"] == "response.function_call_arguments.done"
                        && event["call_id"] == call["call_id"]
                })
                .expect("SSE must deliver complete arguments");
            let mut assembled = added["item"].clone();
            assembled["arguments"] = arguments_done["arguments"].clone();
            assert_eq!(
                &assembled, call,
                "SSE item and arguments must assemble faithfully: {wire}"
            );
            assert_eq!(done["item"]["arguments"], call["arguments"]);
        }
        completed["response"].clone()
    } else {
        response.json().await.unwrap()
    };
    assert_eq!(body["status"], "completed", "{body}");
    assert!(
        body.get("error").is_none(),
        "provider errors cannot be client successes: {body}"
    );
    body
}

async fn capture(
    receiver: &mut mpsc::UnboundedReceiver<ProviderCapture>,
    upstream: &str,
) -> ProviderCapture {
    let capture = tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
        .await
        .expect("business capture must arrive")
        .unwrap();
    assert_eq!(capture.upstream, upstream, "{capture:?}");
    assert_eq!(
        capture.authorization.as_deref(),
        Some("Bearer issue245-permission-test-secret")
    );
    if upstream != "hosted" {
        assert_eq!(capture.path, "/v1/chat/completions");
        assert_eq!(capture.body["model"], "chat-wire");
        assert!(capture.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "issue245_continuation"));
        let messages = capture.body["messages"].as_array().unwrap();
        assert!(messages
            .iter()
            .any(
                |message| message["tool_calls"]
                    .as_array()
                    .is_some_and(|calls| calls.iter().any(|call| call["id"]
                        == "call_issue245_prior_search"
                        && call["function"]["name"] == "search_files"
                        && call["function"]["arguments"]
                            == "{\"query\":\"issue245 prior search\"}"))
            ));
        assert!(messages.iter().any(|message| message["role"] == "tool"
            && message["tool_call_id"] == "call_issue245_prior_search"
            && message["content"] == "issue245 prior search result"));
    }
    capture
}

async fn route_pool(client: &reqwest::Client, base: &str, request: &Value) -> String {
    let response = client
        .post(format!(
            "{base}/_routecodex/diagnostics/virtual-router/dry-run"
        ))
        .json(request)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let result: Value = response.json().await.unwrap();
    assert_eq!(result["ok"], true, "{result}");
    result["diagnostics"]["decision"]["selectedPoolId"]
        .as_str()
        .unwrap()
        .into()
}

async fn force_probe(client: &reqwest::Client, base: &str) {
    let response = client.post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
        .json(&json!({"provider_id":"denied", "interface_id":"default", "auth_alias":"key", "model_id":"chat-wire"}))
        .send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.json::<Value>().await.unwrap()["scheduled"], true);
}

async fn hosted_success(
    client: &reqwest::Client,
    base: &str,
    receiver: &mut mpsc::UnboundedReceiver<ProviderCapture>,
) {
    let request = json!({"model":"hosted-wire", "input":[
        {"type":"message", "role":"user", "content":[{"type":"input_text", "text":"ISSUE245_HOSTED_SEARCH"}]},
        {"type":"web_search", "role":"user", "query":"today news"}
    ],
        "tools":[{"type":"web_search"}], "stream":false});
    assert_eq!(route_pool(client, base, &request).await, "web_search");
    let body = successful_response(client, base, &request).await;
    assert!(body.to_string().contains("ISSUE245_HOSTED_OK"), "{body}");
    let wire = capture(receiver, "hosted").await;
    assert_eq!(wire.path, "/v1/responses");
    assert_eq!(wire.body["model"], "hosted-wire");
}

async fn issue245_witness(stream: bool) {
    // This case counts upstream attempts, so the Chat Process continuation
    // must not add an extra execution.
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    DENIED_PROBE_RECOVERS.store(false, Ordering::SeqCst);
    DENIED_PROBE_FAILURES.store(0, Ordering::SeqCst);
    DENIED_PROBE_SUCCESSES.store(0, Ordering::SeqCst);
    let _home_guard = TestHomeGuard::new("issue245-permission-search");
    std::env::set_var(KEY_ENV, "issue245-permission-test-secret");
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let (base_a, shutdown_a) = start_upstream(PROVIDER_A, sender.clone()).await;
    let (base_b, shutdown_b) = start_upstream(PROVIDER_B, sender.clone()).await;
    let (base_hosted, shutdown_hosted) = start_upstream("hosted", sender).await;
    let reserved = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let handle = spawn_v3_server_aggregate(manifest(port, &base_a, &base_b, &base_hosted))
        .await
        .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();

    // A's genuine HTTP400 must cool only A and reselect B inside the search target.
    let mut request = search_request("ISSUE245_PERMISSION_DENIED_TURN1", stream);
    assert_eq!(route_pool(&client, &base, &request).await, "search");
    let first = successful_response(&client, &base, &request).await;
    let a_wire = capture(&mut receiver, PROVIDER_A).await;
    assert_eq!(
        a_wire.body["messages"][0]["content"],
        "ISSUE245_PERMISSION_DENIED_TURN1"
    );
    capture(&mut receiver, PROVIDER_B).await;
    let call = first["output"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "function_call")
        .expect("real function call");
    assert_eq!(call["call_id"], "call_issue245_continuation");
    assert_eq!(call["name"], "issue245_continuation");
    let arguments: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(
        arguments,
        json!({"nonce":"ISSUE245_NONCE_0001", "query":"issue245 paired tool continuation"})
    );
    let result = execute_nonce_handler(&arguments);
    assert_eq!(
        result,
        "ISSUE245_TOOL_RESULT:ISSUE245_NONCE_0001:issue245 paired tool continuation"
    );
    let history = request["input"].as_array_mut().unwrap();
    history.push(json!({"type":"function_call", "call_id":call["call_id"], "name":call["name"], "arguments":call["arguments"]}));
    history
        .push(json!({"type":"function_call_output", "call_id":call["call_id"], "output":result}));
    let second = successful_response(&client, &base, &request).await;
    assert!(
        second.to_string().contains("ISSUE245_CONTINUATION_OK"),
        "{second}"
    );
    let followup = capture(&mut receiver, PROVIDER_B).await;
    let messages = followup.body["messages"].as_array().unwrap();
    assert!(messages.iter().any(
        |message| message["tool_calls"]
            .as_array()
            .is_some_and(|calls| calls
                .iter()
                .any(|call| call["id"] == "call_issue245_continuation"
                    && call["function"]["name"] == "issue245_continuation"
                    && call["function"]["arguments"] == arguments.to_string()))
    ));
    assert!(messages.iter().any(|message| message["role"] == "tool"
        && message["tool_call_id"] == "call_issue245_continuation"
        && message["content"] == result));

    let pool = cooldown_pool(&client, &base).await;
    let entry = find_entry(&pool, PROVIDER_A).expect("A's exact identity must cool");
    assert_eq!(entry["state"], "blocked");
    assert_eq!(entry["kind"], "probe");
    assert_eq!(entry["interface_id"], "default");
    let initial_deadline = entry["until_ms"].as_u64().unwrap();
    assert!(find_entry(&pool, PROVIDER_B).is_none());
    assert!(find_entry(&pool, "hosted").is_none());
    force_probe(&client, &base).await;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let pool = cooldown_pool(&client, &base).await;
            if DENIED_PROBE_FAILURES.load(Ordering::SeqCst) > 0
                && find_entry(&pool, PROVIDER_A).is_some_and(|entry| entry["state"] == "blocked")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("failed probe must settle without restoring A");

    // The original deadline has passed, but failed probes must preserve exclusion.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    tokio::time::sleep(std::time::Duration::from_millis(
        initial_deadline.saturating_sub(now) + 100,
    ))
    .await;
    let independent = search_request("ISSUE245_PERMISSION_DENIED_INDEPENDENT", stream);
    let response = successful_response(&client, &base, &independent).await;
    assert!(response["output"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["type"] == "function_call"));
    capture(&mut receiver, PROVIDER_B).await;
    assert!(find_entry(&cooldown_pool(&client, &base).await, PROVIDER_A).is_some());
    hosted_success(&client, &base, &mut receiver).await;

    // Only a successful probe of the matching exact identity restores A.
    DENIED_PROBE_RECOVERS.store(true, Ordering::SeqCst);
    force_probe(&client, &base).await;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let pool = cooldown_pool(&client, &base).await;
            if find_entry(&pool, PROVIDER_A).is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("matching successful probe must restore A");
    assert!(DENIED_PROBE_SUCCESSES.load(Ordering::SeqCst) > 0);
    successful_response(
        &client,
        &base,
        &search_request("ISSUE245_RECOVERED_BUSINESS", stream),
    )
    .await;
    capture(&mut receiver, PROVIDER_A).await;
    let pool = cooldown_pool(&client, &base).await;
    assert!(find_entry(&pool, PROVIDER_B).is_none());
    assert!(find_entry(&pool, "hosted").is_none());

    // Exhaustion closes the transfer detectably; SSE may already have its transport head.
    DENIED_PROBE_RECOVERS.store(false, Ordering::SeqCst);
    let exhausted = client
        .post(format!("{base}/v1/responses"))
        .json(&search_request("ISSUE245_EXHAUST", stream))
        .send()
        .await;
    match exhausted {
        Err(error) => assert!(
            !error.is_timeout(),
            "transport must close promptly: {error}"
        ),
        Ok(mut response) => {
            assert!(stream, "JSON exhaustion must not return any HTTP response");
            assert_eq!(response.status(), 200);
            let mut received = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => received.extend_from_slice(&chunk),
                    Ok(None) => panic!("exhausted SSE must not end as a normal empty success"),
                    Err(error) => {
                        assert!(!error.is_timeout());
                        break;
                    }
                }
            }
            let partial = String::from_utf8(received).unwrap();
            assert!(
                !partial.contains("response.completed")
                    && !partial.contains("response.failed")
                    && !partial.contains("event: error")
                    && !partial.contains("permission_error")
                    && !partial.contains("network_error"),
                "{partial}"
            );
        }
    }
    capture(&mut receiver, PROVIDER_A).await;
    capture(&mut receiver, PROVIDER_B).await;
    hosted_success(&client, &base, &mut receiver).await;
    assert!(
        receiver.try_recv().is_err(),
        "no extra business attempt may bypass cooldown"
    );

    handle.shutdown().await;
    shutdown_a.send(()).unwrap();
    shutdown_b.send(()).unwrap();
    shutdown_hosted.send(()).unwrap();
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn issue245_permission_11128_search_continuation_public_blackbox() {
    let _guard = TEST_LOCK.lock().await;
    issue245_witness(false).await;
    issue245_witness(true).await;
}
