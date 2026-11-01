use super::*;

#[tokio::test]
async fn issue44cc3af_stream_direct_raw_prefix_cap_is_local() {
    assert_raw_source_cap(false, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_raw_prefix_cap_is_local() {
    assert_raw_source_cap(true, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_direct_raw_progress_cap_is_local() {
    assert_raw_source_cap(false, true).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_raw_progress_cap_is_local() {
    assert_raw_source_cap(true, true).await;
}

#[tokio::test]
async fn issue44cc3af_stream_chat_raw_prefix_cap_is_local() {
    assert_raw_source_cap_for_entry(true, false, Some(true)).await;
}

#[tokio::test]
async fn issue44cc3af_json_chat_raw_prefix_cap_is_local() {
    assert_raw_source_cap_for_entry(true, false, Some(false)).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_discarded_comments_do_not_accumulate_capacity() {
    assert_raw_source_cap_with_retention(true, true, None, RawRetention::DiscardedComments).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_tool_arguments_cap_is_local() {
    assert_raw_source_cap_with_retention(true, true, None, RawRetention::ToolArguments).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_tool_argument_replacement_releases_capacity() {
    assert_raw_source_cap_with_retention(true, true, None, RawRetention::ToolReplacement).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_reasoning_retention_cap_is_local() {
    assert_raw_source_cap_with_retention(true, true, None, RawRetention::ReasoningText).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_opaque_item_retention_cap_is_local() {
    assert_raw_source_cap_with_retention(true, true, None, RawRetention::OpaqueItems).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_reasoning_part_retention_cap_is_local() {
    assert_raw_source_cap_with_retention(true, true, None, RawRetention::ReasoningParts).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_message_part_retention_cap_is_local() {
    assert_raw_source_cap_with_retention(true, true, None, RawRetention::MessageParts).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_response_container_retention_cap_is_local() {
    assert_raw_source_cap_with_retention(true, true, None, RawRetention::ContainerSnapshots).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_reasoning_part_replacement_releases_capacity() {
    assert_raw_source_cap_with_retention(true, true, None, RawRetention::ReasoningPartReplacement).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_reasoning_part_replacement_with_text_releases_capacity() {
    assert_raw_source_cap_with_retention(true, true, None, RawRetention::ReasoningPartReplacementWithText).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_container_replacement_releases_capacity() {
    assert_raw_source_cap_with_retention(true, true, None, RawRetention::ContainerReplacement).await;
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RawRetention { OutputText, DiscardedComments, ToolArguments, ToolReplacement, ReasoningText, OpaqueItems, ReasoningParts, MessageParts, ContainerSnapshots, ReasoningPartReplacement, ReasoningPartReplacementWithText, ContainerReplacement }

async fn assert_raw_source_cap(relay: bool, after_progress: bool) {
    assert_raw_source_cap_for_entry(relay, after_progress, None).await;
}

async fn assert_raw_source_cap_for_entry(relay: bool, after_progress: bool, chat_client: Option<bool>) {
    assert_raw_source_cap_with_retention(relay, after_progress, chat_client, RawRetention::OutputText).await;
}

async fn assert_raw_source_cap_with_retention(relay: bool, after_progress: bool, chat_client: Option<bool>, retention: RawRetention) {
    let discarded_comments = retention == RawRetention::DiscardedComments;
    let tool_replacement = retention == RawRetention::ToolReplacement;
    let retained_tool = matches!(retention, RawRetention::ToolArguments | RawRetention::ToolReplacement);
    let reasoning_replacement = matches!(retention, RawRetention::ReasoningPartReplacement | RawRetention::ReasoningPartReplacementWithText);
    let container_replacement = retention == RawRetention::ContainerReplacement;
    let completes = discarded_comments || tool_replacement || reasoning_replacement || container_replacement;
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-raw-cap");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mode = if relay { V3EntryProtocolExecutionMode::Relay } else { V3EntryProtocolExecutionMode::Direct };
    let mut manifest = concurrency_switch_manifest_with_mode(
        &format!("http://{}/v1", first.local_addr().unwrap()),
        &format!("http://{}/v1", second.local_addr().unwrap()), mode);
    for server in manifest.servers.values_mut() {
        if chat_client.is_some() {
            server.endpoints = vec!["openai_chat".into()];
        }
        let limits = &mut server.execution.as_mut().unwrap().attempt_store;
        limits.attempt_max_bytes = 4096;
        limits.request_max_bytes = 65536;
        limits.process_max_bytes = 1048576;
    }
    if chat_client.is_some() {
        let binding = manifest.hub_v1.as_mut().unwrap().entry_protocol_bindings.iter_mut()
            .find(|binding| binding.entry_protocol == "openai_chat").unwrap();
        binding.execution_mode = V3EntryProtocolExecutionMode::Relay;
        binding.runtime_owner_symbol = Some("execute_v3_openai_chat_relay_runtime_with_default_transport".into());
        binding.runtime_owner_path = Some("v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs".into());
    }
    if !relay {
        for provider in manifest.providers.values_mut() {
            provider.responses.as_mut().unwrap().process = "direct".into();
            for interface in provider.interfaces.values_mut() {
                interface.responses.as_mut().unwrap().process = "direct".into();
            }
        }
    }
    let a_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let b_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let first_app = Router::new().fallback_service(post({
        let calls = a_calls.clone();
        move || {
            let attempt = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                if attempt > 0 {
                    let event = json!({"type":"response.completed","response":{"id":"capacity-followup","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"LOCAL_CAPACITY_FOLLOWUP_OK"}]}]}});
                    return Response::builder().header("content-type", "text/event-stream")
                        .body(Body::from(format!("event: response.completed\ndata: {event}\n\ndata: [DONE]\n\n"))).unwrap();
                }
                let mut chunks = Vec::new();
                if retained_tool {
                    let event = json!({"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"raw-A","call_id":"callA","name":"capacity_tool","arguments":""}});
                    chunks.push(format!("event: response.output_item.added\ndata: {event}\n\n"));
                } else if matches!(retention, RawRetention::ReasoningText | RawRetention::ReasoningParts | RawRetention::ReasoningPartReplacement | RawRetention::ReasoningPartReplacementWithText) {
                    let event = json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"raw-A","summary":[]}});
                    chunks.push(format!("event: response.output_item.added\ndata: {event}\n\n"));
                    chunks.push("event: response.reasoning_summary_text.delta\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"item_id\":\"raw-A\",\"output_index\":0,\"summary_index\":0,\"delta\":\"first thought\"}\n\n".to_string());
                } else if retention == RawRetention::MessageParts {
                    let event = json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"raw-A","role":"assistant","content":[]}});
                    chunks.push(format!("event: response.output_item.added\ndata: {event}\n\n"));
                    chunks.push("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"raw-A\",\"output_index\":0,\"content_index\":0,\"delta\":\"first word\"}\n\n".to_string());
                } else if after_progress {
                    chunks.push("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"raw-A\",\"output_index\":0,\"content_index\":0,\"delta\":\"first word\"}\n\n".to_string());
                }
                let payloads = if discarded_comments {
                    vec!["x".repeat(1000); 8]
                } else if retained_tool || matches!(retention, RawRetention::ReasoningText | RawRetention::OpaqueItems | RawRetention::ReasoningParts | RawRetention::MessageParts | RawRetention::ContainerSnapshots | RawRetention::ReasoningPartReplacement | RawRetention::ReasoningPartReplacementWithText | RawRetention::ContainerReplacement) {
                    vec!["x".repeat(1000); 6]
                } else { vec!["x".repeat(3000), "y".repeat(3000)] };
                for (index, text) in payloads.into_iter().enumerate() {
                    if matches!(retention, RawRetention::ContainerSnapshots | RawRetention::ContainerReplacement) {
                        let event = json!({"type":"response.in_progress","response":{"id":"raw-A","status":"in_progress","instructions":text,"output":[]}});
                        chunks.push(format!("event: response.in_progress\ndata: {event}\n\n"));
                        if container_replacement {
                            let event = json!({"type":"response.in_progress","response":{"id":"raw-A","status":"in_progress","instructions":"r","output":[]}});
                            chunks.push(format!("event: response.in_progress\ndata: {event}\n\n"));
                        }
                    } else if retention == RawRetention::MessageParts {
                        let event = json!({"type":"response.content_part.added","item_id":"raw-A","output_index":0,"part":{"type":"output_text","index":index,"text":text,"opaque_part_field":"kept"}});
                        chunks.push(format!("event: response.content_part.added\ndata: {event}\n\n"));
                    } else if matches!(retention, RawRetention::ReasoningParts | RawRetention::ReasoningPartReplacement | RawRetention::ReasoningPartReplacementWithText) {
                        let event = json!({"type":"response.reasoning_summary_part.added","item_id":"raw-A","output_index":0,"summary_index":if reasoning_replacement {0} else {index},"part":{"type":"summary_text","text":text,"opaque_part_field":"kept"}});
                        chunks.push(format!("event: response.reasoning_summary_part.added\ndata: {event}\n\n"));
                        if reasoning_replacement {
                            let event = json!({"type":"response.reasoning_summary_part.done","item_id":"raw-A","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":"r","opaque_part_field":"kept"}});
                            chunks.push(format!("event: response.reasoning_summary_part.done\ndata: {event}\n\n"));
                        }
                    } else if retention == RawRetention::ReasoningText {
                        let event = json!({"type":"response.reasoning_summary_text.delta","item_id":"raw-A","output_index":0,"summary_index":0,"delta":text});
                        chunks.push(format!("event: response.reasoning_summary_text.delta\ndata: {event}\n\n"));
                    } else if retention == RawRetention::OpaqueItems {
                        let event = json!({"type":"response.output_item.added","output_index":index,"item":{"type":"web_search_call","id":format!("opaque-{index}"),"status":"in_progress","opaque_provider_field":text}});
                        chunks.push(format!("event: response.output_item.added\ndata: {event}\n\n"));
                    } else if retained_tool {
                        let event = json!({"type":"response.function_call_arguments.delta","item_id":"raw-A","output_index":0,"delta":text});
                        chunks.push(format!("event: response.function_call_arguments.delta\ndata: {event}\n\n"));
                        if tool_replacement {
                            let event = json!({"type":"response.function_call_arguments.done","item_id":"raw-A","output_index":0,"arguments":"{}"});
                            chunks.push(format!("event: response.function_call_arguments.done\ndata: {event}\n\n"));
                        }
                    } else if after_progress && !discarded_comments {
                        let event = json!({"type":"response.output_text.delta","item_id":"raw-A","output_index":0,"content_index":0,"delta":text});
                        chunks.push(format!("event: response.output_text.delta\ndata: {event}\n\n"));
                    } else {
                        chunks.push(format!(": RAW_CAP_NOISE{text}\n\n"));
                    }
                }
                let event = if tool_replacement {
                    json!({"type":"response.completed","response":{"id":"raw-A","status":"completed","output":[{"type":"function_call","id":"raw-A","call_id":"callA","name":"capacity_tool","arguments":"{}"}]}})
                } else if reasoning_replacement {
                    let mut output = vec![json!({"type":"reasoning","id":"raw-A","summary":[{"type":"summary_text","text":"r","opaque_part_field":"kept"}]})];
                    if retention == RawRetention::ReasoningPartReplacementWithText {
                        output.push(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"CONTROL_TEXT"}]}));
                    }
                    json!({"type":"response.completed","response":{"id":"raw-A","status":"completed","output":output}})
                } else { json!({"type":"response.completed","response":{"id":"raw-A","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"UNBOUNDED_RAW_A_COMPLETED"}]}]}}) };
                if !after_progress || completes {
                    chunks.push(format!("event: response.completed\ndata: {event}\n\ndata: [DONE]\n\n"));
                }
                let stream = futures_util::stream::iter(chunks).then(move |chunk| async move {
                    if retention != RawRetention::OutputText { sleep(Duration::from_millis(20)).await; }
                    Ok::<_, std::io::Error>(axum::body::Bytes::from(chunk))
                });
                let stream: std::pin::Pin<Box<dyn futures_util::Stream<Item=Result<axum::body::Bytes,std::io::Error>> + Send>> = if after_progress && !completes {
                    Box::pin(stream.chain(futures_util::stream::pending()))
                } else { Box::pin(stream) };
                Response::builder().header("content-type", "text/event-stream").body(Body::from_stream(stream)).unwrap()
            }
        }
    }));
    let second_app = Router::new().fallback_service(post({
        let calls = b_calls.clone();
        move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async {
                let event = json!({"type":"response.completed","response":{"id":"raw-B","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"UNTRIED_B_MUST_NOT_RUN"}]}]}});
                Response::builder().header("content-type", "text/event-stream").body(Body::from(format!("event: response.completed\ndata: {event}\n\ndata: [DONE]\n\n"))).unwrap()
            }
        }
    }));
    let first_task = tokio::spawn(async move { axum::serve(first, first_app).await.unwrap() });
    let second_task = tokio::spawn(async move { axum::serve(second, second_app).await.unwrap() });
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::builder().timeout(Duration::from_secs(4)).build().unwrap();
    let started = std::time::Instant::now();
    let (endpoint, payload) = match chat_client {
        Some(stream) => ("/v1/chat/completions", json!({"model":"client-test","messages":[{"role":"user","content":"enforce declared raw byte cap"}],"stream":stream})),
        None => ("/v1/responses", json!({"model":"client-test","input":"enforce declared raw byte cap","stream":true})),
    };
    let response = client.post(format!("{base}{endpoint}"))
        .json(&payload)
        .send().await;
    let mut body = Vec::new();
    let mut broken = false;
    match response {
        Ok(response) => {
            let mut stream = response.bytes_stream();
            while let Some(frame) = stream.next().await {
                match frame { Ok(frame) => body.extend_from_slice(&frame), Err(_) => { broken = true; break; } }
            }
        }
        // A JSON client has no accepted SSE channel. Request-local transport
        // termination is detected while receiving HTTP headers instead.
        Err(_) if chat_client == Some(false) => broken = true,
        Err(error) => panic!("SSE transport must first be accepted: {error}"),
    }
    let elapsed = started.elapsed();
    let cooled = concurrency_cooldown_entries(&client, &base).await;
    let resumed = if matches!(retention, RawRetention::ReasoningText | RawRetention::OpaqueItems | RawRetention::ReasoningParts | RawRetention::MessageParts | RawRetention::ContainerSnapshots) {
        Some(client.post(format!("{base}{endpoint}")).json(&payload).send().await.unwrap().text().await.unwrap())
    } else { None };
    handle.shutdown().await;
    first_task.abort();
    second_task.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    let body = String::from_utf8_lossy(&body);
    assert!(elapsed < Duration::from_secs(2), "local capacity must terminate while receiving data, before client timeout: {elapsed:?}");
    if tool_replacement {
        let terminal = body.lines().filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|event| event["type"] == "response.completed").expect("valid replacement sequence must complete");
        assert!(!broken);
        assert_eq!(terminal["response"]["output"][0]["name"], "capacity_tool");
        assert_eq!(terminal["response"]["output"][0]["call_id"], "callA");
        assert_eq!(terminal["response"]["output"][0]["arguments"], "{}");
    } else if reasoning_replacement {
        let terminal = body.lines().filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|event| event["type"] == "response.completed").expect("reasoning replacement must complete");
        assert!(!broken);
        let reasoning = terminal["response"]["output"].as_array().unwrap().iter()
            .find(|item| item["type"] == "reasoning").unwrap_or_else(|| panic!("reasoning business content must remain visible: {terminal}"));
        assert_eq!(reasoning["summary"][0]["text"], "r", "{terminal}");
        assert_eq!(reasoning["summary"][0]["opaque_part_field"], "kept", "{terminal}");
    } else if discarded_comments || container_replacement {
        assert!(!broken && body.contains("response.completed") && body.contains("UNBOUNDED_RAW_A_COMPLETED"), "discarded postsemantic comments must not accumulate a wire-traffic charge: {body}");
    } else {
        assert!(broken && !body.contains("response.completed") && !body.contains("UNBOUNDED_RAW_A_COMPLETED") && !body.contains("UNTRIED_B_MUST_NOT_RUN"), "raw source cap must terminate only this request without client payload, relay={relay} after_progress={after_progress}: {body}");
    }
    if let Some(resumed) = &resumed {
        assert!(resumed.contains("response.completed") && resumed.contains("LOCAL_CAPACITY_FOLLOWUP_OK"), "capacity failure must release admission for the next request: {resumed}");
    }
    assert_eq!(a_calls.load(std::sync::atomic::Ordering::SeqCst), if resumed.is_some() { 2 } else { 1 });
    assert_eq!(b_calls.load(std::sync::atomic::Ordering::SeqCst), 0, "local capacity must not reselect B");
    assert!(cooled.is_empty(), "local capacity must not mutate provider health: {cooled:?}");
}

#[tokio::test]
async fn issue44cc3af_stream_chat_relay_progress_outlives_stream_timers() {
    assert_chat_relay_progress("openai_chat", true, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_chat_json_progress_outlives_stream_timers() {
    assert_chat_relay_progress("openai_chat", false, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_messages_progress_outlives_stream_timers() {
    assert_chat_relay_progress("anthropic", true, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_native_chat_progress_outlives_stream_timers() {
    assert_chat_relay_progress("openai_chat", true, true).await;
}

async fn assert_chat_relay_progress(entry_protocol: &'static str, client_stream: bool, direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-chat-progress");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let mut manifest = concurrency_switch_manifest(&url, &url);
    for server in manifest.servers.values_mut() {
        server.endpoints = vec![entry_protocol.into()];
        server
            .execution
            .as_mut()
            .unwrap()
            .attempt_store
            .residence_timeout_ms = if direct || entry_protocol == "anthropic" { 1000 } else { 150 };
    }
    let binding = manifest
        .hub_v1
        .as_mut()
        .unwrap()
        .entry_protocol_bindings
        .iter_mut()
        .find(|b| b.entry_protocol == "openai_chat")
        .unwrap();
    if !direct {
    binding.execution_mode = V3EntryProtocolExecutionMode::Relay;
    binding.runtime_owner_symbol =
        Some("execute_v3_openai_chat_relay_runtime_with_default_transport".into());
    binding.runtime_owner_path =
        Some("v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs".into());
    }
    for provider in manifest.providers.values_mut() {
        provider.provider_type = "openai_chat".into();
        provider.request_timeout_ms = 5000;
        provider.sse_first_frame_timeout_ms = Some(150);
        if direct {
            provider.responses.as_mut().unwrap().process = "direct".into();
        }
        for interface in provider.interfaces.values_mut() {
            interface.provider_type = "openai_chat".into();
            if direct {
                interface.responses.as_mut().unwrap().process = "direct".into();
            }
        }
    }
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let app = Router::new().fallback_service(post({
        let calls = calls.clone();
        move |axum::Json(body): axum::Json<Value>| {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                assert_eq!(body["stream"], true, "fixture requires declared provider streaming=always");
                let stream = futures_util::stream::once(async {
                    Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"data: {\"id\":\"generic\",\"object\":\"chat.completion.chunk\",\"model\":\"wire-test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"first word\"},\"finish_reason\":null}]}\n\n"))
                }).chain(futures_util::stream::once(async move {
                    sleep(Duration::from_millis(if direct || entry_protocol == "anthropic" { 1400 } else { 400 })).await;
                    Ok(axum::body::Bytes::from_static(b"data: {\"id\":\"generic\",\"object\":\"chat.completion.chunk\",\"model\":\"wire-test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" complete generic tail\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))
                }));
                Response::builder().header("content-type", "text/event-stream").body(Body::from_stream(stream)).unwrap()
            }
        }
    }));
    let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let sent = reqwest::Client::builder().timeout(Duration::from_secs(4)).build().unwrap()
        .post(format!("http://{}{}", handle.listeners[0].addr, if entry_protocol == "anthropic" { "/v1/messages" } else { "/v1/chat/completions" }))
        .json(&json!({"model":"client-test","messages":[{"role":"user","content":"sustained generic progress"}],"max_tokens":32,"stream":client_stream}))
        .send().await;
    let result = match sent { Ok(response) => response.text().await, Err(error) => Err(error) };
    if result.is_err() {
        for endpoint in ["openai-chat", "openai-responses"] {
            if let Ok(entries) = fs::read_dir(_home.codex_samples_root_for(endpoint, handle.listeners[0].addr.port())) {
                for entry in entries.flatten() {
                    if let Ok(raw) = fs::read_to_string(entry.path().join("provider-failed-attempts.json")) {
                        eprintln!("generic failure evidence: {raw}");
                    }
                }
            }
        }
    }
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    assert!(result.is_ok(), "generic Relay must not truncate progressing SSE, client_stream={client_stream}: {result:?}");
    let body = result.unwrap();
    assert!(body.contains("complete generic tail"), "{body}");
    assert!(
        if client_stream {
            body.contains(if entry_protocol == "anthropic" { "message_stop" } else { "[DONE]" })
        } else {
            serde_json::from_str::<Value>(&body).unwrap()["choices"][0]["finish_reason"] == "stop"
        },
        "{body}"
    );
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn issue44cc3af_stream_direct_failed_prefix_never_reaches_client() {
    assert_failed_prefix_recovers(false, false, false, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_failed_prefix_never_reaches_client() {
    assert_failed_prefix_recovers(true, false, false, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_direct_progress_does_not_renew_recovery_budget() {
    assert_failed_prefix_recovers(false, true, false, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_progress_does_not_renew_recovery_budget() {
    assert_failed_prefix_recovers(true, true, false, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_direct_envelope_is_not_first_semantic_output() {
    assert_failed_prefix_recovers(false, false, true, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_envelope_is_not_first_semantic_output() {
    assert_failed_prefix_recovers(true, false, true, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_signature_is_not_first_semantic_output() {
    assert_failed_prefix_recovers(true, false, true, true).await;
}

async fn assert_failed_prefix_recovers(
    relay: bool,
    expired_budget: bool,
    presemantic: bool,
    signature: bool,
) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-failed-prefix");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mode = if relay {
        V3EntryProtocolExecutionMode::Relay
    } else {
        V3EntryProtocolExecutionMode::Direct
    };
    let mut manifest = concurrency_switch_manifest_with_mode(
        &format!("http://{}/v1", first.local_addr().unwrap()),
        &format!("http://{}/v1", second.local_addr().unwrap()),
        mode,
    );
    if expired_budget {
        for server in manifest.servers.values_mut() {
            server
                .execution
                .as_mut()
                .unwrap()
                .attempt_store
                .residence_timeout_ms = 150;
        }
    }
    if presemantic {
        for provider in manifest.providers.values_mut() {
            provider.sse_first_frame_timeout_ms = Some(150);
        }
    }
    if relay {
        for provider in manifest.providers.values_mut() {
            provider.provider_type = if signature {
                "anthropic"
            } else {
                "openai_chat"
            }
            .into();
            provider.responses = None;
            for interface in provider.interfaces.values_mut() {
                interface.provider_type = if signature {
                    "anthropic"
                } else {
                    "openai_chat"
                }
                .into();
                interface.responses = None;
            }
        }
    } else {
        for provider in manifest.providers.values_mut() {
            provider.responses.as_mut().unwrap().process = "direct".into();
            for interface in provider.interfaces.values_mut() {
                interface.responses.as_mut().unwrap().process = "direct".into();
            }
        }
    }
    let first_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let first_app = Router::new().fallback_service(post({
        let calls = first_calls.clone();
        move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                let prefix = if signature {
                    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"silent-A\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"wire-test\",\"content\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"opaque-signature-only\"}}\n\n"
                } else if presemantic && relay {
                    ": keepalive\n\ndata: {\"id\":\"silent-A\",\"object\":\"chat.completion.chunk\",\"model\":\"wire-test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\n"
                } else if presemantic {
                    ": keepalive\n\nevent: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"silent-A\",\"status\":\"in_progress\",\"output\":[]}}\n\n"
                } else if relay {
                    "data: {\"id\":\"failed-A\",\"object\":\"chat.completion.chunk\",\"model\":\"wire-test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"FAILED_A_MUST_STAY_INTERNAL\"},\"finish_reason\":null}]}\n\n"
                } else {
                    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"failed-A\",\"output_index\":0,\"content_index\":0,\"delta\":\"FAILED_A_MUST_STAY_INTERNAL\"}\n\n"
                };
                let stream = futures_util::stream::once(async move {
                    Ok::<_, std::io::Error>(axum::body::Bytes::from(prefix))
                }).chain(futures_util::stream::once(async move {
                    if presemantic {
                        std::future::pending::<()>().await;
                    }
                    sleep(Duration::from_millis(200)).await;
                    Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "controlled A body interruption"))
                }));
                Response::builder().header("content-type", "text/event-stream").body(Body::from_stream(stream)).unwrap()
            }
        }
    }));
    let second_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let second_app = Router::new().fallback_service(post({
        let calls = second_calls.clone();
        move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                if signature {
                    Response::builder().header("content-type", "application/json").body(Body::from(json!({"id":"healthy-B","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":"HEALTHY_B_COMPLETE"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}).to_string())).unwrap()
                } else if relay {
                    Response::builder().header("content-type", "application/json").body(Body::from(json!({"id":"healthy-B","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"HEALTHY_B_COMPLETE"},"finish_reason":"stop"}]}).to_string())).unwrap()
                } else {
                    let event = json!({"type":"response.completed","response":{"id":"healthy-B","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"HEALTHY_B_COMPLETE"}]}]}});
                    Response::builder().header("content-type", "text/event-stream").body(Body::from(format!("event: response.completed\ndata: {event}\n\ndata: [DONE]\n\n"))).unwrap()
                }
            }
        }
    }));
    let first_task = tokio::spawn(async move { axum::serve(first, first_app).await.unwrap() });
    let second_task = tokio::spawn(async move { axum::serve(second, second_app).await.unwrap() });
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let response = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap()
        .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
        .json(&json!({"model":"client-test","input":"failed attempt must recover atomically","stream":true}))
        .send().await.unwrap();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    let mut failure = None;
    while let Some(frame) = stream.next().await {
        match frame {
            Ok(frame) => bytes.extend_from_slice(&frame),
            Err(error) => {
                failure = Some(error.to_string());
                break;
            }
        }
    }
    handle.shutdown().await;
    first_task.abort();
    second_task.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    let body = String::from_utf8_lossy(&bytes);
    assert!(
        !body.contains("FAILED_A_MUST_STAY_INTERNAL"),
        "failed A leaked before full-attempt seal, relay={relay}, error={failure:?}: {body}"
    );
    if expired_budget {
        assert!(
            failure.is_some()
                && !body.contains("HEALTHY_B_COMPLETE")
                && !body.contains("response.completed"),
            "semantic progress must not renew an expired recovery budget, relay={relay}: {body}"
        );
    } else {
        assert!(
        failure.is_none()
            && body.contains("HEALTHY_B_COMPLETE")
            && body.contains("response.completed"),
        "healthy B must complete after typed A failure, relay={relay}, error={failure:?}: {body}"
    );
    }
    assert_eq!(first_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        second_calls.load(std::sync::atomic::Ordering::SeqCst),
        usize::from(!expired_budget)
    );
}

#[tokio::test]
async fn issue44cc3af_stream_direct_progress_outlives_http_total_timeout() {
    assert_progress_outlives_timeout(false, false, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_progress_outlives_http_total_timeout() {
    assert_progress_outlives_timeout(true, false, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_direct_progress_outlives_residence_timeout() {
    assert_progress_outlives_timeout(false, true, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_progress_outlives_residence_timeout() {
    assert_progress_outlives_timeout(true, true, false).await;
}

#[tokio::test]
async fn issue44cc3af_stream_direct_progress_outlives_idle_timeout() {
    assert_progress_outlives_timeout(false, false, true).await;
}

#[tokio::test]
async fn issue44cc3af_stream_relay_progress_outlives_idle_timeout() {
    assert_progress_outlives_timeout(true, false, true).await;
}

async fn assert_progress_outlives_timeout(relay: bool, residence: bool, idle: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-stream-progress");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let mode = if relay {
        V3EntryProtocolExecutionMode::Relay
    } else {
        V3EntryProtocolExecutionMode::Direct
    };
    let mut manifest = concurrency_switch_manifest_with_mode(&url, &url, mode);
    for provider in manifest.providers.values_mut() {
        provider.request_timeout_ms = if residence || idle { 5000 } else { 150 };
        provider.sse_first_frame_timeout_ms = Some(if idle { 150 } else { 1000 });
        if relay {
            provider.provider_type = "openai_chat".into();
            provider.responses = None;
            for interface in provider.interfaces.values_mut() {
                interface.provider_type = "openai_chat".into();
                interface.responses = None;
            }
        } else {
            provider.responses.as_mut().unwrap().process = "direct".into();
            for interface in provider.interfaces.values_mut() {
                interface.responses.as_mut().unwrap().process = "direct".into();
            }
        }
    }
    if residence {
        for server in manifest.servers.values_mut() {
            server
                .execution
                .as_mut()
                .unwrap()
                .attempt_store
                .residence_timeout_ms = 150;
        }
    }
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let app = Router::new().fallback_service(post({
        let calls = calls.clone();
        move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                let (tx, rx) = mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(4);
                tokio::spawn(async move {
                    let first = if relay {
                        "data: {\"id\":\"slow\",\"object\":\"chat.completion.chunk\",\"model\":\"wire-test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"preserved first word\"},\"finish_reason\":null}]}\n\n".to_string()
                    } else {
                        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg-slow\",\"output_index\":0,\"content_index\":0,\"delta\":\"preserved first word\"}\n\n".to_string()
                    };
                    if tx.send(Ok(axum::body::Bytes::from(first))).await.is_err() { return; }
                    sleep(Duration::from_millis(400)).await;
                    let terminal = if relay {
                        "data: {\"id\":\"slow\",\"object\":\"chat.completion.chunk\",\"model\":\"wire-test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" and complete tail\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".to_string()
                    } else {
                        let event = json!({"type":"response.completed","response":{"id":"slow","status":"completed","output":[{"type":"message","id":"msg-slow","role":"assistant","content":[{"type":"output_text","text":"preserved first word and complete tail"}]}]}});
                        format!("event: response.completed\ndata: {event}\n\ndata: [DONE]\n\n")
                    };
                    let _ = tx.send(Ok(axum::body::Bytes::from(terminal))).await;
                });
                let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|frame| (frame, rx)) });
                Response::builder().header("content-type", "text/event-stream").body(Body::from_stream(stream)).unwrap()
            }
        }
    }));
    let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let result = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap()
        .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
        .json(&json!({"model":"client-test","input":"sustained progress","stream":true}))
        .send()
        .await
        .unwrap()
        .text()
        .await;
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    assert!(result.is_ok(), "active semantic stream must outlive local total timers, relay={relay} residence={residence}: {result:?}");
    let body = result.unwrap();
    assert!(
        body.contains("complete tail") && body.contains("response.completed"),
        "complete original business result required: {body}"
    );
    assert_eq!(
        calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "no replacement provider may mask an aborted healthy stream"
    );
}
