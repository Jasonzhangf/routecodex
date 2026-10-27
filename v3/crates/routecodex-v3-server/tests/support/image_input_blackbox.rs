use super::*;
use futures_util::FutureExt;

fn run_blackbox_test<F>(future: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_stack_size(128 * 1024 * 1024)
        .enable_all()
        .build()
        .expect("image input blackbox runtime");
    runtime.block_on(async move {
        tokio::spawn(future)
            .await
            .expect("image input blackbox task");
    });
}

const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const OTHER: &str = "https://example.test/latest-second.png";
const OLD: &str = "https://example.test/old-history.png";

fn contains_opaque_value(value: &Value, expected: &Value) -> bool {
    value == expected
        || value
            .as_object()
            .zip(expected.as_object())
            .is_some_and(|(actual, expected)| {
                expected
                    .iter()
                    .all(|(key, value)| actual.get(key) == Some(value))
            })
        || match value {
            Value::Object(row) => row
                .values()
                .any(|child| contains_opaque_value(child, expected)),
            Value::Array(items) => items
                .iter()
                .any(|child| contains_opaque_value(child, expected)),
            Value::String(text) => serde_json::from_str::<Value>(text)
                .ok()
                .filter(|parsed| parsed.is_object() || parsed.is_array())
                .is_some_and(|parsed| contains_opaque_value(&parsed, expected)),
            _ => false,
        }
}
fn image_references(value: &Value, output: &mut Vec<String>) {
    match value {
        // Tool results may be serialized as a JSON string on some wire
        // projections; inspect the decoded parts so a preserved image is still
        // observed instead of silently skipped.
        Value::String(text) => {
            if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                if parsed.is_array() || parsed.is_object() {
                    image_references(&parsed, output);
                }
            }
        }
        Value::Object(row) => {
            let type_value = row.get("type").and_then(Value::as_str);
            match type_value {
                Some("image_url") => {
                    // Chat shape: {"type":"image_url","image_url":{"url":..}}.
                    let reference = row
                        .get("image_url")
                        .and_then(|image| image.get("url").or(Some(image)))
                        .and_then(Value::as_str)
                        .or_else(|| row.get("image_url").and_then(Value::as_str))
                        .expect("Chat image part must retain a real source URL");
                    output.push(reference.to_string());
                }
                Some("input_image" | "output_image") => {
                    if let Some(reference) = reference_from_part(row) {
                        output.push(reference);
                    }
                }
                Some("image") => {
                    let source = &row["source"];
                    output.push(if source["type"] == "base64" {
                        format!(
                            "data:{};base64,{}",
                            source["media_type"].as_str().unwrap(),
                            source["data"].as_str().unwrap()
                        )
                    } else {
                        source["url"].as_str().unwrap().to_string()
                    });
                }
                // A typeless part can still carry an image payload via
                // `image_url`/`data` (e.g. typeless tool-output image parts).
                // Only treat clearly image-bearing payloads as references so
                // ordinary business text stays text.
                None => {
                    if let Some(url) = row.get("image_url").and_then(Value::as_str) {
                        output.push(url.to_string());
                    } else if let Some(data) = row.get("data").and_then(Value::as_str) {
                        if data.starts_with("data:image/") {
                            output.push(data.to_string());
                        } else if row.get("media_type").and_then(Value::as_str).is_some() {
                            output.push(format!(
                                "data:{};base64,{data}",
                                row["media_type"].as_str().unwrap()
                            ));
                        }
                    }
                }
                // Declared text parts must stay text; only an explicit
                // `image_url` field is a reference.
                Some("input_text" | "output_text" | "text") => {
                    if let Some(url) = row.get("image_url").and_then(Value::as_str) {
                        output.push(url.to_string());
                    }
                }
                _ => {}
            }
            for child in row.values() {
                image_references(child, output);
            }
        }
        Value::Array(items) => {
            for item in items {
                image_references(item, output);
            }
        }
        _ => {}
    }
}

fn reference_from_part(row: &serde_json::Map<String, Value>) -> Option<String> {
    if let Some(url) = row.get("image_url").and_then(Value::as_str) {
        return Some(url.to_string());
    }
    if let Some(url) = row.get("file_url").and_then(Value::as_str) {
        return Some(url.to_string());
    }
    let data = row.get("data").and_then(Value::as_str)?;
    Some(
        if data.starts_with("data:") || !row.contains_key("media_type") {
            data.to_string()
        } else {
            format!(
                "data:{};base64,{data}",
                row["media_type"].as_str().unwrap_or("image/png")
            )
        },
    )
}

/// Classification pool layouts exercised through the public chat, Responses and
/// Anthropic entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PoolState {
    /// One explicit, non-empty `multimodal` pool with a vision target.
    MultimodalAvailable,
    /// The optional `multimodal` pool is not configured at all.
    MultimodalAbsent,
    /// The `multimodal` pool is configured but its vision provider is disabled.
    MultimodalDisabled,
    /// The `multimodal` pool holds two vision tiers with different declared
    /// priorities: tier one returns 502 and tier two succeeds.
    MultimodalTierRecovery,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Expect {
    Vision,
    SecondVision,
    Text,
    Exhaustion,
}

/// The `request` fixture places images inside the current user run only when
/// `tool` is false. The tool fixture ends with text-only user turns, so its
/// tool-output images belong to an earlier turn and cannot classify the
/// current request.
fn expected_route(pool: PoolState, tool: bool) -> Expect {
    let current_turn_image = !tool;
    match pool {
        PoolState::MultimodalAbsent => Expect::Text,
        PoolState::MultimodalAvailable => {
            if current_turn_image {
                Expect::Vision
            } else {
                Expect::Text
            }
        }
        PoolState::MultimodalTierRecovery => {
            if current_turn_image {
                Expect::SecondVision
            } else {
                Expect::Text
            }
        }
        PoolState::MultimodalDisabled => {
            if current_turn_image {
                Expect::Exhaustion
            } else {
                Expect::Text
            }
        }
    }
}

fn request(path: &str, tool: bool, image_only: bool) -> Value {
    let mut images = json!([
        {"type":"input_text","text":"latest-image-text"},
        {"type":"input_image","image_url":PNG},
        {"type":"input_image","image_url":OTHER}
    ]);
    let mut chat_images = json!([
        {"type":"text","text":"latest-image-text"},
        {"type":"image_url","image_url":{"url":PNG}},
        {"type":"image_url","image_url":{"url":OTHER}}
    ]);
    if image_only {
        images.as_array_mut().unwrap().remove(0);
        chat_images.as_array_mut().unwrap().remove(0);
    }
    match path {
        "/v1/responses" => {
            let mut input = vec![
                json!({"role":"user","content":[{"type":"input_image","image_url":OLD}]}),
                json!({"type":"function_call","call_id":"call_old","name":"read_old","arguments":"{}"}),
                json!({"type":"function_call_output","call_id":"call_old","output":" \tdata:image/png;base64,PADDED\n "}),
                json!({"role":"user","content":[{"type":"input_text","text":"describe the latest image; source mentions data:image/png;base64,example","data":"ordinary-business-data"}]}),
            ];
            if tool {
                input.push(json!({"type":"function_call","call_id":"call_image","name":"read_image","arguments":"{}"}));
                input.push(json!({"type":"function_call","call_id":"call_text","name":"read_text","arguments":"{}"}));
                input.push(
                    json!({"type":"function_call_output","call_id":"call_image","output":images}),
                );
                input.push(json!({"type":"function_call_output","call_id":"call_text","output":"data:image/png;base64,example is a parallel-text-result code literal"}));
            }
            input.push(json!({"role":"user","content":"Current time reminder; source mentions data:image/png;base64,example"}));
            input.push(json!({"role":"user","content":[{"type":"input_text","text":"data:image/png;base64,example is documentation text"}]}));
            input.push(json!({"role":"user","content":"data:image/png;base64,example is ordinary message text"}));
            if !tool {
                input.push(json!({"role":"user","content":images}));
            }
            json!({"model":"test","stream":false,"input":input})
        }
        "/v1/chat/completions" => {
            let mut messages = vec![
                json!({"role":"user","content":[{"type":"image_url","image_url":{"url":OLD}}]}),
                json!({"role":"assistant","content":null,"tool_calls":[{"id":"call_old","type":"function","function":{"name":"read_old","arguments":"{}"}}]}),
                json!({"role":"tool","tool_call_id":"call_old","content":" \tdata:image/png;base64,PADDED\n "}),
                json!({"role":"user","content":[{"type":"text","text":"describe the latest image; source mentions data:image/png;base64,example","data":"ordinary-business-data"}]}),
            ];
            if tool {
                messages.push(json!({"role":"assistant","content":null,"tool_calls":[{"id":"call_image","type":"function","function":{"name":"read_image","arguments":"{}"}},{"id":"call_text","type":"function","function":{"name":"read_text","arguments":"{}"}}]}));
                messages
                    .push(json!({"role":"tool","tool_call_id":"call_image","content":chat_images}));
                messages.push(json!({"role":"tool","tool_call_id":"call_text","content":"data:image/png;base64,example is a parallel-text-result code literal"}));
            }
            messages.push(json!({"role":"user","content":"{\"data\":\"ordinary-business-json\",\"text\":\"Current time reminder; source mentions data:image/png;base64,example\"}"}));
            messages.push(json!({"role":"user","content":[{"type":"text","text":"data:image/png;base64,example is documentation text"}]}));
            messages.push(json!({"role":"user","content":"data:image/png;base64,example is ordinary message text"}));
            if !tool {
                messages.push(json!({"role":"user","content":chat_images}));
            }
            json!({"model":"test","stream":false,"messages":messages})
        }
        "/v1/messages" => {
            let mut images = json!([
                {"type":"text","text":"latest-image-text"},
                {"type":"image","source":{"type":"base64","media_type":"image/png","data":PNG.split_once(',').unwrap().1}},
                {"type":"image","source":{"type":"url","url":OTHER}}
            ]);
            if image_only {
                images.as_array_mut().unwrap().remove(0);
            }
            let mut messages = vec![
                json!({"role":"user","content":[{"type":"image","source":{"type":"url","url":OLD}}]}),
                json!({"role":"assistant","content":[{"type":"tool_use","id":"call_old","name":"read_old","input":{}}]}),
                json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"call_old","content":" \tdata:image/png;base64,PADDED\n "}]}),
                json!({"role":"user","content":[{"type":"text","text":"describe the latest image; source mentions data:image/png;base64,example","data":"ordinary-business-data"}]}),
            ];
            if tool {
                messages.push(json!({"role":"assistant","content":[{"type":"tool_use","id":"call_image","name":"read_image","input":{}},{"type":"tool_use","id":"call_text","name":"read_text","input":{}}]}));
                messages.push(json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"call_image","content":images},{"type":"tool_result","tool_use_id":"call_text","content":"data:image/png;base64,example is a parallel-text-result code literal"}]}));
            }
            messages.push(json!({"role":"user","content":"Current time reminder; source mentions data:image/png;base64,example"}));
            messages.push(json!({"role":"user","content":[{"type":"text","text":"data:image/png;base64,example is documentation text"}]}));
            messages.push(json!({"role":"user","content":"data:image/png;base64,example is ordinary message text"}));
            if !tool {
                messages.push(json!({"role":"user","content":images}));
            }
            json!({"model":"test","stream":false,"max_tokens":128,"messages":messages})
        }
        _ => unreachable!(),
    }
}

async fn run_case(path: &str, tool: bool, pool: PoolState, protocol: &str) {
    run_case_shape(path, tool, pool, protocol, false, None).await;
    run_case_shape(path, tool, pool, protocol, true, None).await;
}

async fn assert_incomplete_blackbox_transport(
    result: Result<reqwest::Response, reqwest::Error>,
    started: std::time::Instant,
    context: &str,
) {
    match result {
        Err(error) => {
            let elapsed = started.elapsed();
            assert!(
                !error.is_timeout(),
                "{context}: an unfinished client wait is not a transport break: {error}"
            );
            assert!(
                !error.is_connect(),
                "{context}: the test listener was reachable, so connect failure is not exhaustion: {error}"
            );
            assert!(
                error.status().is_none(),
                "{context}: a client HTTP response is not a transport break: {error}"
            );
            assert!(
                elapsed < Duration::from_secs(15),
                "{context}: exhaustion must terminate before the client wait expires: {elapsed:?}"
            );
        }
        Ok(mut response) => {
            assert_eq!(
                response.status(),
                StatusCode::OK,
                "{context}: exhaustion must not generate a client HTTP error"
            );
            let mut body = Vec::new();
            let terminal = loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                    Ok(None) => panic!(
                        "{context}: exhaustion completed the client transport normally: {}",
                        String::from_utf8_lossy(&body)
                    ),
                    Err(error) => break error,
                }
            };
            let elapsed = started.elapsed();
            assert!(
                !terminal.is_timeout(),
                "{context}: an unfinished client wait is not a transport break: {terminal}"
            );
            assert!(
                !terminal.is_connect(),
                "{context}: the test listener was reachable, so connect failure is not exhaustion: {terminal}"
            );
            assert!(
                terminal.status().is_none(),
                "{context}: a client HTTP response is not a transport break: {terminal}"
            );
            let body = String::from_utf8_lossy(&body);
            assert!(
                body.trim().is_empty(),
                "{context}: exhaustion must not project a success or error payload: {body}"
            );
            assert!(
                elapsed < Duration::from_secs(15),
                "{context}: exhaustion must terminate before the client wait expires: {elapsed:?}"
            );
        }
    }
}

async fn run_case_shape(
    path: &str,
    tool: bool,
    pool: PoolState,
    protocol: &str,
    image_only: bool,
    tool_output: Option<Value>,
) {
    // These cases count upstream attempts, so the Chat Process continuation
    // must not add an extra execution.
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let expect = expected_route(pool, tool);
    // External HTTP providers capture the complete request. Exhausted image
    // pools use an explicit declared unavailable provider, preserving the real
    // multimodal capability declaration.
    let completion = json!({
        "id":"chat_image_ok","object":"chat.completion","model":"image-wire",
        "choices":[{"index":0,"message":{"role":"assistant","content":"image-blackbox-ok"},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24}
    });
    let response = serde_json::to_vec(&match protocol {
        "responses" => json!({"id":"resp_image_ok","object":"response","status":"completed","model":"vision-wire","output":[{"id":"msg_image_ok","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"image-blackbox-ok","annotations":[]}]}],"usage":{"input_tokens":20,"output_tokens":4,"total_tokens":24}}),
        "anthropic" => json!({"id":"msg_image_ok","type":"message","role":"assistant","model":"vision-wire","content":[{"type":"text","text":"image-blackbox-ok"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":20,"output_tokens":4}}),
        _ => completion.clone(),
    }).unwrap();
    let text_response = response.clone();
    let (vision_url, mut vision_rx, vision_shutdown) =
        start_controlled_terminal_upstream_with_body(
            if matches!(pool, PoolState::MultimodalTierRecovery) {
                StatusCode::BAD_GATEWAY
            } else {
                StatusCode::OK
            },
            "application/json",
            if matches!(pool, PoolState::MultimodalTierRecovery) {
                serde_json::to_vec(&json!({"error":{"message":"controlled vision failure"}}))
                    .unwrap()
            } else {
                response.clone()
            },
        )
        .await;
    let (second_url, mut second_rx, second_shutdown) =
        start_controlled_terminal_upstream_with_body(
            StatusCode::OK,
            "application/json",
            response.clone(),
        )
        .await;
    let (text_url, mut text_rx, text_shutdown) = start_controlled_terminal_upstream_with_body(
        StatusCode::OK,
        "application/json",
        text_response,
    )
    .await;
    let mut manifest = responses_relay_provider_protocol_manifest(
        free_port(),
        free_port(),
        &vision_url,
        protocol,
        Some(&text_url),
    );
    for server in manifest.servers.values_mut() {
        server.endpoints = vec!["responses".into(), "openai_chat".into(), "anthropic".into()];
        // Bound the request residence deadline so a genuinely exhausted pool
        // terminates at the public entry inside the test window.
        if let Some(execution) = server.execution.as_mut() {
            execution.attempt_store.residence_timeout_ms = 8_000;
        }
    }
    let vision = manifest.providers.get_mut("test").unwrap();
    if protocol == "anthropic" {
        vision.base_url = vision_url.trim_end_matches("/v1").to_string();
        vision.interfaces.get_mut("default").unwrap().base_url = vision.base_url.clone();
    }
    vision.models.get_mut("test").unwrap().wire_name = "vision-wire".into();
    if !matches!(pool, PoolState::MultimodalAbsent) {
        vision
            .models
            .get_mut("test")
            .unwrap()
            .capabilities
            .push("multimodal".into());
    }
    if matches!(pool, PoolState::MultimodalDisabled) {
        vision.enabled = false;
    }
    let text = manifest.providers.get_mut("fallback").unwrap();
    text.provider_type = protocol.into();
    text.interfaces.get_mut("default").unwrap().provider_type = protocol.into();
    if protocol == "anthropic" {
        text.base_url = text_url.trim_end_matches("/v1").to_string();
        text.interfaces.get_mut("default").unwrap().base_url = text.base_url.clone();
    }
    text.models.get_mut("test").unwrap().wire_name = "text-wire".into();
    // A second vision provider used only by the same-pool tier-recovery case.
    let mut second = manifest.providers.get("test").unwrap().clone();
    second.id = "second".into();
    second.enabled = true;
    second.base_url = if protocol == "anthropic" {
        second_url.trim_end_matches("/v1").to_string()
    } else {
        second_url.clone()
    };
    second.interfaces.get_mut("default").unwrap().base_url = second.base_url.clone();
    second.models.get_mut("test").unwrap().wire_name = "second-wire".into();
    manifest.providers.insert("second".into(), second);
    let group = manifest.route_groups.get_mut("default").unwrap();
    group.pools.remove("client_test");
    let default_pool = group.pools.get("default").unwrap().clone();
    if !matches!(pool, PoolState::MultimodalAbsent) {
        let mut mixed = default_pool.clone();
        mixed.id = "multimodal".into();
        mixed.match_rule = Some(routecodex_v3_config::V3RoutePoolMatchManifest {
            precedence: 100,
            entry_protocol: None,
            models: Vec::new(),
            required_capabilities: vec!["multimodal".into()],
            min_input_tokens: None,
            max_input_tokens: None,
        });
        let mut targets: Vec<_> = default_pool
            .targets
            .iter()
            .filter(|target| target.provider.as_deref() == Some("test"))
            .cloned()
            .collect();
        for target in &mut targets {
            target.priority = Some(2);
        }
        if matches!(pool, PoolState::MultimodalTierRecovery) {
            let mut second_target = targets[0].clone();
            second_target.provider = Some("second".into());
            second_target.priority = Some(1);
            targets.push(second_target);
        }
        mixed.targets = targets;
        group.pools.insert("multimodal".into(), mixed);
    }
    group
        .pools
        .get_mut("default")
        .unwrap()
        .targets
        .retain(|target| target.provider.as_deref() == Some("fallback"));
    manifest.debug.snapshots = false;
    manifest.debug.dry_run = false;
    std::env::set_var("V3_P6_TEST_KEY", "local-image-fixture");
    let mut body = request(path, tool, image_only);
    if let Some(output) = &tool_output {
        body["input"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|item| item["type"] == "function_call_output" && item["call_id"] == "call_image")
            .unwrap()["output"] = output.clone();
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let request_started = std::time::Instant::now();
    let result = reqwest::Client::new()
        .post(format!("http://{}{path}", handle.listeners[0].addr))
        .json(&body)
        .timeout(Duration::from_secs(20))
        .send()
        .await;
    // Shut down owned listeners even when an assertion below finds a regression.
    handle.shutdown().await;
    let _ = vision_shutdown.send(());
    let _ = second_shutdown.send(());
    let _ = text_shutdown.send(());
    let drain = |rx: &mut mpsc::UnboundedReceiver<ProviderCapture>| {
        let mut bodies = Vec::new();
        while let Ok(capture) = rx.try_recv() {
            bodies.push(capture.body);
        }
        bodies
    };
    if expect == Expect::Exhaustion {
        // The selected pool's only candidate is disabled. The request must end
        // without a fabricated success, without the provider error payload and
        // without consulting the default pool.
        assert_incomplete_blackbox_transport(
            result,
            request_started,
            &format!("{path} tool={tool} protocol={protocol}"),
        )
        .await;
        assert!(
            drain(&mut vision_rx).is_empty(),
            "a disabled candidate must not reach the network"
        );
        assert!(
            drain(&mut second_rx).is_empty(),
            "no second candidate may run for a disabled single candidate"
        );
        assert!(
            drain(&mut text_rx).is_empty(),
            "the default pool must not be consulted after the selected pool exhausts"
        );
        return;
    }
    let result = result.unwrap_or_else(|error| {
        panic!("{path} tool={tool} pool={pool:?} protocol={protocol}: {error}")
    });
    let status = result.status();
    let client = result.text().await.unwrap();
    assert_eq!(
        status,
        StatusCode::OK,
        "{path} tool={tool} pool={pool:?}: {client}"
    );
    assert!(client.contains("image-blackbox-ok"), "{client}");
    let mut vision_attempts = drain(&mut vision_rx);
    let mut second_attempts = drain(&mut second_rx);
    let mut text_attempts = drain(&mut text_rx);
    let wire = match expect {
        Expect::Vision => {
            assert!(
                text_attempts.is_empty(),
                "default pool must stay unused when the multimodal pool matches: {path} tool={tool} protocol={protocol}"
            );
            assert!(
                second_attempts.is_empty(),
                "single-candidate multimodal pool must not touch the second tier"
            );
            assert_eq!(
                vision_attempts.len(),
                1,
                "exactly one vision attempt: {path} tool={tool} protocol={protocol}"
            );
            let body = vision_attempts.remove(0);
            assert_eq!(body["model"], "vision-wire");
            body
        }
        Expect::SecondVision => {
            assert!(
                text_attempts.is_empty(),
                "default pool must stay unused during same-pool tier recovery: {path} {protocol}"
            );
            assert_eq!(
                vision_attempts.len(),
                1,
                "exactly the first vision tier must be attempted before the second: {path} {protocol}"
            );
            let first = &vision_attempts[0];
            assert_eq!(
                first["model"], "vision-wire",
                "the higher-priority vision tier must run first: {path} {protocol}"
            );
            let mut first_refs = Vec::new();
            image_references(first, &mut first_refs);
            for expected in [OLD, PNG, OTHER] {
                assert!(
                    first_refs.iter().any(|image| image == expected),
                    "the failed first vision tier must still receive the current-turn image bytes and preserved history: {expected} {path} {protocol}"
                );
            }
            assert_eq!(
                second_attempts.len(),
                1,
                "exactly the lower-priority vision tier must recover the request: {path} {protocol}"
            );
            let body = second_attempts.remove(0);
            assert_eq!(body["model"], "second-wire");
            body
        }
        _ => {
            assert!(
                vision_attempts.is_empty(),
                "an earlier-turn image must not reach the multimodal provider: {path} tool={tool} protocol={protocol}"
            );
            assert!(
                second_attempts.is_empty(),
                "an earlier-turn image must not reach the second vision tier"
            );
            assert_eq!(
                text_attempts.len(),
                1,
                "exactly one default-pool attempt: {path} tool={tool} protocol={protocol}"
            );
            let body = text_attempts.remove(0);
            assert_eq!(body["model"], "text-wire");
            body
        }
    };
    let wire_text = wire.to_string();
    if let Some(output) = &tool_output {
        let parsed = output
            .as_str()
            .map(|text| serde_json::from_str::<Value>(text).unwrap());
        let parts = parsed.as_ref().unwrap_or(output).as_array().unwrap();
        for part in parts {
            if part.get("file_id").is_some() || part["type"] == "vendor_part" {
                assert!(
                    contains_opaque_value(&wire, part),
                    "complete opaque tool output must survive {protocol}: {part}"
                );
            }
            for field in ["vendor_image", "vendor_text"] {
                if let Some(extra) = part.get(field) {
                    assert!(
                        contains_opaque_value(&wire, &json!({field:extra})),
                        "complete extra field must survive {protocol}: {field}"
                    );
                }
            }
        }
    }
    assert!(
        wire_text.contains("source mentions data:image/png;base64,example"),
        "ordinary source literals must survive image cleanup"
    );
    assert!(wire_text.contains("data:image/png;base64,example is documentation text") && wire_text.contains("data:image/png;base64,example is ordinary message text"), "declared and native message text must remain text even when it starts with an image literal");
    assert!(
        wire_text.contains("describe the latest image"),
        "ordinary text parts with data fields must survive image cleanup"
    );
    if !image_only {
        assert!(
            wire_text.contains("latest-image-text"),
            "image-adjacent text must survive"
        );
    }
    assert!(
        wire_text.contains("Current time reminder"),
        "reminder must survive"
    );
    if tool {
        assert!(
            wire_text.contains("call_image"),
            "tool identity must survive"
        );
        assert!(wire_text.contains("read_image"), "tool name must survive");
        assert!(
            wire_text.contains("call_text") && wire_text.contains("parallel-text-result"),
            "parallel tool result must survive"
        );
        if protocol == "openai_chat" {
            let messages = wire["messages"].as_array().unwrap();
            let first = messages
                .iter()
                .position(|message| message["tool_call_id"] == "call_image")
                .unwrap();
            assert_eq!(messages[first + 1]["tool_call_id"], "call_text", "all parallel tool results must precede the adjacent image user message: {wire_text}");
            assert_eq!(messages[first + 2]["role"], "user");
        }
    }
    let mut images = Vec::new();
    image_references(&wire, &mut images);
    assert!(
        !wire_text.contains("[Image]"),
        "history and current images must reach the selected provider intact, not as placeholders: {path} tool={tool} protocol={protocol} {wire_text}"
    );
    for expected in [OLD, PNG, OTHER] {
        assert!(
            images.iter().any(|image| image == expected),
            "complete original image {expected} must reach the selected provider: {path} tool={tool} protocol={protocol} {wire_text}"
        );
    }
}

#[test]
fn current_turn_images_route_to_multimodal_pool_not_default() {
    run_blackbox_test(async {
        let _guard = TEST_LOCK.lock().await;
        for path in ["/v1/chat/completions", "/v1/responses", "/v1/messages"] {
            for tool in [false, true] {
                for protocol in ["openai_chat", "responses", "anthropic"] {
                    run_case(path, tool, PoolState::MultimodalAvailable, protocol).await;
                }
            }
        }
    });
}

#[test]
fn earlier_turn_image_routes_to_default_pool_without_multimodal() {
    run_blackbox_test(async {
        let _guard = TEST_LOCK.lock().await;
        for path in ["/v1/chat/completions", "/v1/responses", "/v1/messages"] {
            for tool in [false, true] {
                for protocol in ["openai_chat", "responses", "anthropic"] {
                    run_case(path, tool, PoolState::MultimodalAbsent, protocol).await;
                }
            }
        }
    });
}

#[test]
fn single_multimodal_pool_recovers_within_pool_not_cross_pool() {
    run_blackbox_test(async {
        let _guard = TEST_LOCK.lock().await;
        for path in ["/v1/chat/completions", "/v1/responses", "/v1/messages"] {
            for tool in [false, true] {
                for protocol in ["openai_chat", "responses", "anthropic"] {
                    run_case(path, tool, PoolState::MultimodalTierRecovery, protocol).await;
                }
            }
        }
    });
}

#[test]
fn disabled_multimodal_pool_exhausts_without_default_fallback() {
    run_blackbox_test(async {
        let _guard = TEST_LOCK.lock().await;
        for path in ["/v1/chat/completions", "/v1/responses", "/v1/messages"] {
            for tool in [false, true] {
                for protocol in ["openai_chat", "responses", "anthropic"] {
                    run_case(path, tool, PoolState::MultimodalDisabled, protocol).await;
                }
            }
        }
    });
}

async fn assert_isolated_image_boundary(path: &str, content: Value, earlier_image: bool) {
    // These cases count upstream attempts, so the Chat Process continuation
    // must not add an extra execution.
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let completion = serde_json::to_vec(&json!({
        "id":"chat_boundary","object":"chat.completion","model":"boundary-wire",
        "choices":[{"index":0,"message":{"role":"assistant","content":"boundary-ok"},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24}
    })).unwrap();
    let (vision_url, mut vision_rx, vision_shutdown) =
        start_controlled_terminal_upstream_with_body(
            StatusCode::OK,
            "application/json",
            completion.clone(),
        )
        .await;
    let (text_url, mut text_rx, text_shutdown) = start_controlled_terminal_upstream_with_body(
        StatusCode::OK,
        "application/json",
        completion,
    )
    .await;
    let mut manifest = responses_relay_provider_protocol_manifest(
        free_port(),
        free_port(),
        &vision_url,
        "openai_chat",
        Some(&text_url),
    );
    for server in manifest.servers.values_mut() {
        server.endpoints = vec!["responses".into(), "openai_chat".into(), "anthropic".into()];
    }
    let vision = manifest
        .providers
        .get_mut("test")
        .unwrap()
        .models
        .get_mut("test")
        .unwrap();
    vision.capabilities.push("multimodal".into());
    vision.wire_name = "vision-wire".into();
    let text = manifest.providers.get_mut("fallback").unwrap();
    text.provider_type = "openai_chat".into();
    text.interfaces.get_mut("default").unwrap().provider_type = "openai_chat".into();
    text.models.get_mut("test").unwrap().wire_name = "text-wire".into();
    let group = manifest.route_groups.get_mut("default").unwrap();
    group.pools.remove("client_test");
    group
        .pools
        .get_mut("default")
        .unwrap()
        .targets
        .retain(|target| target.provider.as_deref() == Some("fallback"));
    manifest.debug.snapshots = false;
    manifest.debug.dry_run = false;
    std::env::set_var("V3_P6_TEST_KEY", "local-image-boundary-fixture");
    let field = if path == "/v1/responses" {
        "input"
    } else {
        "messages"
    };
    let mut body = json!({"model":"test","stream":false,"max_tokens":128});
    let mut messages = if content["type"] == "function_call_output" {
        vec![
            json!({"role":"user","content":"describe the tool image"}),
            json!({"type":"function_call","call_id":"bare_data","name":"read_image","arguments":"{}"}),
            content.clone(),
        ]
    } else {
        vec![json!({"role":"user","content":content})]
    };
    if earlier_image {
        messages.push(json!({"role":"assistant","content":"previous answer"}));
        messages.push(json!({"role":"user","content":"a later ordinary text-only user turn"}));
    }
    body[field] = Value::Array(messages);
    let original = body.to_string();
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let addr = handle.listeners[0].addr;
    let result = reqwest::Client::new()
        .post(format!("http://{addr}{path}"))
        .json(&body)
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    handle.shutdown().await;
    let _ = vision_shutdown.send(());
    let _ = text_shutdown.send(());
    let response =
        result.unwrap_or_else(|error| panic!("{path} earlier_image={earlier_image}: {error}"));
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.text().await.unwrap().contains("boundary-ok"));
    let mut content_refs = Vec::new();
    image_references(&content, &mut content_refs);
    let has_image =
        !content_refs.is_empty() || content["type"].as_str() == Some("function_call_output");
    let (wire, expected_model) = if earlier_image || !has_image {
        assert!(
            vision_rx.try_recv().is_err(),
            "text-only current content must not select vision: {path} earlier_image={earlier_image} {original}"
        );
        let body = text_rx.try_recv().expect("text request").body;
        assert!(
            text_rx.try_recv().is_err(),
            "exactly one text attempt: {path} earlier_image={earlier_image}"
        );
        (body, "text-wire")
    } else {
        assert!(
            text_rx.try_recv().is_err(),
            "current-turn image must not select the text provider: {path} {original}"
        );
        let body = vision_rx.try_recv().expect("vision request").body;
        assert!(
            vision_rx.try_recv().is_err(),
            "exactly one vision attempt: {path}"
        );
        (body, "vision-wire")
    };
    assert!(
        vision_rx.try_recv().is_err() && text_rx.try_recv().is_err(),
        "the chosen receiver must be the only attempted provider: {path}"
    );
    assert_eq!(wire["model"], expected_model);
    let mut refs = Vec::new();
    image_references(&wire, &mut refs);
    if earlier_image {
        assert_eq!(
            refs,
            vec![PNG],
            "earlier-turn image must stay in forwarded history: {path}"
        );
        assert!(wire
            .to_string()
            .contains("a later ordinary text-only user turn"));
    } else if has_image {
        assert_eq!(refs, vec![PNG]);
        assert!(
            !wire.to_string().contains("[Image]"),
            "the sole/latest image must not be cleaned"
        );
    } else {
        assert!(
            wire.to_string().contains("data:image/"),
            "literal text must remain on wire"
        );
    }
}

#[tokio::test]
async fn isolated_image_literals_remain_text_and_select_text_route() {
    let _guard = TEST_LOCK.lock().await;
    for path in ["/v1/chat/completions", "/v1/responses", "/v1/messages"] {
        for text in [
            "data:image/png;base64,example is ordinary message text",
            "data:image/png;base64,example",
            "{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,example\"}}",
        ] {
            assert_isolated_image_boundary(path, json!(text), false).await;
        }
        let kind = if path == "/v1/responses" {
            "input_text"
        } else {
            "text"
        };
        for text in [
            "data:image/png;base64,example",
            "data:image/png;base64,example is documentation text",
        ] {
            assert_isolated_image_boundary(path, json!([{"type":kind,"text":text}]), false).await;
        }
    }
}

#[tokio::test]
async fn earlier_turn_image_stays_in_history_and_selects_default() {
    let _guard = TEST_LOCK.lock().await;
    for path in ["/v1/chat/completions", "/v1/responses", "/v1/messages"] {
        let content = match path {
            "/v1/responses" => json!([{"type":"input_image","image_url":PNG}]),
            "/v1/messages" => json!([{"type":"image","source":{"type":"url","url":PNG}}]),
            _ => json!([{"type":"image_url","image_url":{"url":PNG}}]),
        };
        assert_isolated_image_boundary(path, content, true).await;
    }
}

const CONSECUTIVE_IMAGE: &str = "https://example.test/consecutive-turn.png";

fn chat_completion_bytes(model: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "id": "chat_finding_ok",
        "object": "chat.completion",
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "finding-ok"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 20, "completion_tokens": 4, "total_tokens": 24}
    }))
    .unwrap()
}

fn pool_target(provider: &str) -> routecodex_v3_config::V3RoutePoolTargetManifest {
    routecodex_v3_config::V3RoutePoolTargetManifest {
        kind: routecodex_v3_config::V3RouteTargetKind::ProviderModel,
        id: None,
        provider: Some(provider.to_string()),
        model: Some("test".to_string()),
        key: Some("key".to_string()),
        interface: None,
        priority: Some(1),
        weight: Some(1),
    }
}

async fn run_consecutive_user_turn_search_case(path: &str) {
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let completion = chat_completion_bytes("search-wire");
    let (search_url, mut search_rx, search_shutdown) =
        start_controlled_terminal_upstream_with_body(
            StatusCode::OK,
            "application/json",
            completion.clone(),
        )
        .await;
    let (vision_url, mut vision_rx, vision_shutdown) =
        start_controlled_terminal_upstream_with_body(
            StatusCode::OK,
            "application/json",
            completion.clone(),
        )
        .await;
    let (think_url, mut think_rx, think_shutdown) = start_controlled_terminal_upstream_with_body(
        StatusCode::OK,
        "application/json",
        completion.clone(),
    )
    .await;
    let (default_url, mut default_rx, default_shutdown) =
        start_controlled_terminal_upstream_with_body(
            StatusCode::OK,
            "application/json",
            completion.clone(),
        )
        .await;

    let mut manifest = responses_relay_provider_protocol_manifest(
        free_port(),
        free_port(),
        &search_url,
        "openai_chat",
        Some(&default_url),
    );
    for server in manifest.servers.values_mut() {
        server.endpoints = vec![
            "responses".into(),
            "openai_chat".into(),
            "anthropic".into(),
            "gemini".into(),
        ];
        if let Some(execution) = server.execution.as_mut() {
            execution.attempt_store.residence_timeout_ms = 8_000;
        }
    }
    manifest
        .providers
        .get_mut("test")
        .unwrap()
        .models
        .get_mut("test")
        .unwrap()
        .wire_name = "search-wire".into();
    manifest
        .providers
        .get_mut("test")
        .unwrap()
        .models
        .get_mut("test")
        .unwrap()
        .capabilities
        .push("web_search".into());
    // The selected web_search candidate still has to preserve the current-turn
    // image bytes, so this fixture's search provider is multimodal-capable too.
    manifest
        .providers
        .get_mut("test")
        .unwrap()
        .models
        .get_mut("test")
        .unwrap()
        .capabilities
        .push("multimodal".into());
    let fallback = manifest.providers.get_mut("fallback").unwrap();
    fallback.provider_type = "openai_chat".into();
    fallback
        .interfaces
        .get_mut("default")
        .unwrap()
        .provider_type = "openai_chat".into();
    fallback.models.get_mut("test").unwrap().wire_name = "text-wire".into();

    let mut vision = manifest.providers.get("test").unwrap().clone();
    vision.id = "vision".into();
    vision.base_url = vision_url.clone();
    vision.interfaces.get_mut("default").unwrap().base_url = vision_url.clone();
    vision.models.get_mut("test").unwrap().wire_name = "vision-wire".into();
    vision
        .models
        .get_mut("test")
        .unwrap()
        .capabilities
        .push("multimodal".into());
    manifest.providers.insert("vision".into(), vision);

    let mut think = manifest.providers.get("test").unwrap().clone();
    think.id = "think".into();
    think.base_url = think_url.clone();
    think.interfaces.get_mut("default").unwrap().base_url = think_url.clone();
    think.models.get_mut("test").unwrap().wire_name = "thinking-wire".into();
    manifest.providers.insert("think".into(), think);

    let group = manifest.route_groups.get_mut("default").unwrap();
    group.pools.remove("client_test");
    let default_pool = group.pools.get("default").unwrap().clone();
    let mut web_search_pool = default_pool.clone();
    web_search_pool.id = "web_search".into();
    web_search_pool.match_rule = Some(routecodex_v3_config::V3RoutePoolMatchManifest {
        precedence: 30,
        entry_protocol: None,
        models: Vec::new(),
        required_capabilities: vec!["web_search".into()],
        min_input_tokens: None,
        max_input_tokens: None,
    });
    web_search_pool.targets = vec![pool_target("test")];
    group.pools.insert("web_search".into(), web_search_pool);

    let mut multimodal_pool = default_pool.clone();
    multimodal_pool.id = "multimodal".into();
    multimodal_pool.match_rule = Some(routecodex_v3_config::V3RoutePoolMatchManifest {
        precedence: 20,
        entry_protocol: None,
        models: Vec::new(),
        required_capabilities: vec!["multimodal".into()],
        min_input_tokens: None,
        max_input_tokens: None,
    });
    multimodal_pool.targets = vec![pool_target("vision")];
    group.pools.insert("multimodal".into(), multimodal_pool);

    let mut thinking_pool = default_pool.clone();
    thinking_pool.id = "thinking".into();
    thinking_pool.match_rule = Some(routecodex_v3_config::V3RoutePoolMatchManifest {
        precedence: 10,
        entry_protocol: None,
        models: Vec::new(),
        required_capabilities: Vec::new(),
        min_input_tokens: None,
        max_input_tokens: None,
    });
    thinking_pool.targets = vec![pool_target("think")];
    group.pools.insert("thinking".into(), thinking_pool);
    group
        .pools
        .get_mut("default")
        .unwrap()
        .targets
        .retain(|target| target.provider.as_deref() == Some("fallback"));

    std::env::set_var("V3_P6_TEST_KEY", "local-consecutive-turn-fixture");
    let body = if path == "/v1/responses" {
        json!({
            "model": "test",
            "stream": false,
            "input": [
                {"role": "user", "content": [
                    {"type": "input_text", "text": "请搜索今天的新闻"},
                    {"type": "input_image", "image_url": CONSECUTIVE_IMAGE}
                ]},
                {"role": "user", "content": [
                    {"type": "input_text", "text": "并结合这张图回答"}
                ]}
            ]
        })
    } else if path.contains("generateContent") {
        json!({
            "contents": [
                {"role": "user", "parts": [
                    {"text": "请搜索今天的新闻"},
                    {"fileData": {"mimeType": "image/png", "fileUri": CONSECUTIVE_IMAGE}}
                ]},
                {"role": "user", "parts": [{"text": "并结合这张图回答"}]}
            ]
        })
    } else {
        json!({
            "model": "test",
            "stream": false,
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "请搜索今天的新闻"},
                    {"type": "image_url", "image_url": {"url": CONSECUTIVE_IMAGE}}
                ]},
                {"role": "user", "content": [
                    {"type": "text", "text": "并结合这张图回答"}
                ]}
            ]
        })
    };

    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let result = reqwest::Client::new()
        .post(format!("http://{}{path}", handle.listeners[0].addr))
        .json(&body)
        .timeout(Duration::from_secs(20))
        .send()
        .await;
    handle.shutdown().await;
    let _ = search_shutdown.send(());
    let _ = vision_shutdown.send(());
    let _ = think_shutdown.send(());
    let _ = default_shutdown.send(());
    let response = result.unwrap_or_else(|error| panic!("{path}: {error}"));
    assert_eq!(response.status(), StatusCode::OK, "{path}");
    assert!(
        response.text().await.unwrap().contains("finding-ok"),
        "{path}"
    );

    let search_body = search_rx
        .try_recv()
        .map(|capture| capture.body)
        .unwrap_or_else(|_| {
            panic!(
                "the web_search pool must be selected for consecutive user search intent: {path}"
            )
        });
    assert!(
        vision_rx.try_recv().is_err(),
        "multimodal must not shadow hosted search for consecutive user turns: {path}"
    );
    assert!(
        think_rx.try_recv().is_err(),
        "thinking must not shadow hosted search for consecutive user turns: {path}"
    );
    assert!(
        default_rx.try_recv().is_err(),
        "default must not be consulted when web_search matches: {path}"
    );
    let wire_text = search_body.to_string();
    assert!(
        wire_text.contains("请搜索今天的新闻"),
        "first user text must survive: {path}"
    );
    assert!(
        wire_text.contains("并结合这张图回答"),
        "second user text must survive: {path}"
    );
    assert!(
        !wire_text.contains("[Image]"),
        "current-turn image must not be placeholderized: {path}"
    );
    let mut refs = Vec::new();
    image_references(&search_body, &mut refs);
    assert!(
        refs.iter().any(|reference| reference == CONSECUTIVE_IMAGE),
        "current-turn image must reach the search provider: {path} {wire_text}"
    );
}

#[tokio::test]
async fn responses_and_chat_consecutive_user_turns_select_search_and_preserve_images() {
    let _guard = TEST_LOCK.lock().await;
    for path in [
        "/v1/responses",
        "/v1/chat/completions",
        "/v1beta/models/test:generateContent",
    ] {
        run_consecutive_user_turn_search_case(path).await;
    }
}

async fn run_thinking_pool_history_size_case(
    path: &str,
    history_text: &str,
    current_text: &str,
    expect_thinking: bool,
) {
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let gemini = path.contains("generateContent");
    let completion = if gemini {
        serde_json::to_vec(&json!({"candidates":[{"content":{"role":"model","parts":[{"text":"finding-ok"}]},"finishReason":"STOP"}]})).unwrap()
    } else {
        chat_completion_bytes("thinking-wire")
    };
    let (thinking_url, mut thinking_rx, thinking_shutdown) =
        start_controlled_terminal_upstream_with_body(
            StatusCode::OK,
            "application/json",
            completion.clone(),
        )
        .await;
    let (default_url, mut default_rx, default_shutdown) =
        start_controlled_terminal_upstream_with_body(
            StatusCode::OK,
            "application/json",
            completion.clone(),
        )
        .await;
    let mut manifest = responses_relay_provider_protocol_manifest(
        free_port(),
        free_port(),
        &thinking_url,
        if gemini { "gemini" } else { "openai_chat" },
        Some(&default_url),
    );
    if gemini {
        let binding = manifest
            .hub_v1
            .as_mut()
            .unwrap()
            .entry_protocol_bindings
            .iter_mut()
            .find(|binding| binding.entry_protocol == "gemini")
            .unwrap();
        binding.execution_mode = routecodex_v3_config::V3EntryProtocolExecutionMode::Direct;
        binding.runtime_owner_symbol = Some("execute_v3_gemini_direct_server_outcome".into());
        binding.runtime_owner_path = Some("v3/crates/routecodex-v3-server/src/executors.rs".into());
    }
    for server in manifest.servers.values_mut() {
        server.endpoints = vec![
            "responses".into(),
            "openai_chat".into(),
            "anthropic".into(),
            "gemini".into(),
        ];
        if let Some(execution) = server.execution.as_mut() {
            execution.attempt_store.residence_timeout_ms = 8_000;
        }
    }
    manifest
        .providers
        .get_mut("test")
        .unwrap()
        .models
        .get_mut("test")
        .unwrap()
        .wire_name = "thinking-wire".into();
    if gemini {
        let provider = manifest.providers.get_mut("test").unwrap();
        provider.base_url = format!("{}/v1beta", thinking_url.trim_end_matches("/v1"));
        provider.interfaces.get_mut("default").unwrap().base_url = provider.base_url.clone();
    }
    let fallback = manifest.providers.get_mut("fallback").unwrap();
    fallback.provider_type = if gemini { "gemini" } else { "openai_chat" }.into();
    fallback
        .interfaces
        .get_mut("default")
        .unwrap()
        .provider_type = if gemini { "gemini" } else { "openai_chat" }.into();
    if gemini {
        fallback.base_url = format!("{}/v1beta", default_url.trim_end_matches("/v1"));
        fallback.interfaces.get_mut("default").unwrap().base_url = fallback.base_url.clone();
    }
    fallback.models.get_mut("test").unwrap().wire_name = "text-wire".into();

    let group = manifest.route_groups.get_mut("default").unwrap();
    group.pools.remove("client_test");
    let default_pool = group.pools.get("default").unwrap().clone();
    let mut thinking_pool = default_pool.clone();
    thinking_pool.id = "thinking".into();
    thinking_pool.match_rule = Some(routecodex_v3_config::V3RoutePoolMatchManifest {
        precedence: 10,
        entry_protocol: None,
        models: Vec::new(),
        required_capabilities: Vec::new(),
        min_input_tokens: None,
        max_input_tokens: Some(100),
    });
    thinking_pool.targets = vec![pool_target("test")];
    group.pools.insert("thinking".into(), thinking_pool);
    group
        .pools
        .get_mut("default")
        .unwrap()
        .targets
        .retain(|target| target.provider.as_deref() == Some("fallback"));

    std::env::set_var("V3_P6_TEST_KEY", "local-thinking-history-fixture");
    let body = if path == "/v1/responses" {
        json!({
            "model": "test",
            "stream": false,
            "input": [
                {"role": "user", "content": "history question"},
                {"role": "assistant", "content": history_text},
                {"role": "user", "content": current_text}
            ]
        })
    } else if gemini {
        json!({"contents": [
            {"role":"user","parts":[{"text":"history question"}]},
            {"role":"model","parts":[{"text":history_text}]},
            {"role":"user","parts":[{"text":current_text}]},
            {"role":"user","parts":[{"text":"followup"}]}
        ]})
    } else {
        json!({
            "model": "test",
            "stream": false,
            "messages": [
                {"role": "user", "content": "history question"},
                {"role": "assistant", "content": history_text},
                {"role": "user", "content": current_text}
            ]
        })
    };

    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let result = reqwest::Client::new()
        .post(format!("http://{}{path}", handle.listeners[0].addr))
        .json(&body)
        .timeout(Duration::from_secs(20))
        .send()
        .await;
    let response = result.unwrap_or_else(|error| {
        panic!(
            "{path}: {error}; thinking upstream reached={}, default upstream reached={}",
            thinking_rx.try_recv().is_ok(),
            default_rx.try_recv().is_ok()
        )
    });
    assert_eq!(response.status(), StatusCode::OK, "{path}");
    assert!(
        response.text().await.unwrap().contains("finding-ok"),
        "{path}"
    );
    handle.shutdown().await;
    let _ = thinking_shutdown.send(());
    let _ = default_shutdown.send(());

    if !expect_thinking {
        assert!(
            thinking_rx.try_recv().is_err(),
            "long current turn must not select thinking: {path}"
        );
        let captured = default_rx
            .try_recv()
            .expect("long current turn must select default");
        let wire_text = captured.body.to_string();
        assert!(
            wire_text.contains(current_text),
            "current turn must reach provider: {path}"
        );
        assert!(
            wire_text.contains(history_text),
            "history must reach provider: {path}"
        );
        assert!(
            wire_text.contains("followup"),
            "consecutive user must reach provider: {path}"
        );
        return;
    }
    let thinking_body = thinking_rx
        .try_recv()
        .map(|capture| capture.body)
        .unwrap_or_else(|_| {
            panic!("the thinking pool must be selected for current-turn text: {path}")
        });
    assert!(
        default_rx.try_recv().is_err(),
        "history size must not push the current-turn text request to default: {path}"
    );
    if !gemini {
        assert_eq!(thinking_body["model"], "thinking-wire", "{path}");
    }
    let wire_text = thinking_body.to_string();
    assert!(
        wire_text.contains(current_text),
        "current-turn text must survive: {path}"
    );
    assert!(
        wire_text.contains(history_text),
        "complete history must still reach the selected provider: {path}"
    );
}

#[tokio::test]
async fn thinking_pool_token_threshold_uses_current_turn_not_history_size() {
    let _guard = TEST_LOCK.lock().await;
    for path in ["/v1/responses", "/v1/chat/completions"] {
        run_thinking_pool_history_size_case(path, "short history", "hello", true).await;
        let long_history = "history filler sentence about the current turn. ".repeat(240);
        run_thinking_pool_history_size_case(path, &long_history, "hello", true).await;
    }
    let path = "/v1beta/models/test:generateContent";
    run_thinking_pool_history_size_case(path, &"old history ".repeat(3000), "hello", true).await;
    run_thinking_pool_history_size_case(
        path,
        "short history",
        &"current request ".repeat(2000),
        false,
    )
    .await;
}

#[tokio::test]
async fn vision_transport_failure_exhausts_before_default_image_passage() {
    let _guard = TEST_LOCK.lock().await;
    for path in ["/v1/chat/completions", "/v1/responses", "/v1/messages"] {
        for tool in [false, true] {
            run_case(path, tool, PoolState::MultimodalTierRecovery, "openai_chat").await;
        }
    }
}

#[tokio::test]
async fn responses_tool_image_sources_and_opaque_parts_survive_protocol_projection() {
    let _guard = TEST_LOCK.lock().await;
    let variants = [
        json!([{"type":"input_text","text":"latest-image-text"},{"type":"input_image","file_url":PNG},{"type":"input_image","image_url":OTHER}]),
        json!([{"type":"input_text","text":"latest-image-text"},{"type":"input_image","data":PNG},{"type":"input_image","image_url":OTHER}]),
        json!([{"type":"input_text","text":"latest-image-text"},{"type":"input_image","media_type":"image/png","data":PNG.split_once(',').unwrap().1},{"type":"input_image","image_url":OTHER}]),
        json!([{"type":"input_text","text":"latest-image-text"},{"type":"input_image","image_url":PNG},{"type":"input_image","image_url":OTHER},{"type":"input_image","file_id":"file-latest-opaque"}]),
        json!([{"type":"input_text","text":"latest-image-text"},{"type":"input_image","image_url":PNG},{"type":"input_image","image_url":OTHER},{"type":"input_file","file_id":"file-opaque-pdf"},{"type":"vendor_part","value":{"message":"opaque-tool-payload","count":7}}]),
        json!([{"type":"input_text","text":"latest-image-text"},{"detail":"original","image_url":PNG},{"type":"input_image","image_url":OTHER}]),
        json!([{"type":"input_text","text":"latest-image-text","vendor_text":{"tag":"text-extra","count":9}},{"type":"input_image","image_url":PNG,"vendor_image":{"tag":"image-extra","count":7}},{"type":"input_image","image_url":OTHER}]),
        json!([{"type":"input_text","text":"latest-image-text"},{"data":PNG},{"type":"input_image","image_url":OTHER}]),
    ];
    let mut failures = Vec::new();
    for (variant, output) in variants.into_iter().enumerate() {
        for encoded in [false, true] {
            let output = if encoded {
                json!(output.to_string())
            } else {
                output.clone()
            };
            for protocol in ["openai_chat", "responses", "anthropic"] {
                if std::panic::AssertUnwindSafe(run_case_shape(
                    "/v1/responses",
                    true,
                    PoolState::MultimodalAvailable,
                    protocol,
                    false,
                    Some(output.clone()),
                ))
                .catch_unwind()
                .await
                .is_err()
                {
                    failures.push((variant, encoded, protocol));
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "tool source projection failures: {failures:?}"
    );
}

#[tokio::test]
async fn typeless_data_tool_image_alone_selects_vision() {
    let _guard = TEST_LOCK.lock().await;
    assert_isolated_image_boundary(
        "/v1/responses",
        json!({"type":"function_call_output","call_id":"bare_data","output":[{"data":PNG}]}),
        false,
    )
    .await;
}
