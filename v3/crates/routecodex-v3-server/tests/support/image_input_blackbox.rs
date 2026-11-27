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
    /// No multimodal pool, but the default model explicitly supports vision.
    DefaultVision,
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
    DefaultVision,
}

/// The `request` fixture places images inside the current user run only when
/// `tool` is false. The tool fixture ends with text-only user turns, so its
/// tool-output images belong to an earlier turn and cannot classify the
/// current request.
fn expected_route(pool: PoolState, tool: bool) -> Expect {
    let current_turn_image = !tool;
    match pool {
        PoolState::MultimodalAbsent => Expect::Text,
        PoolState::DefaultVision => Expect::DefaultVision,
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
        PoolState::MultimodalDisabled => Expect::Text,
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
    let accepts_default: fn(&Value) -> bool = if expect == Expect::DefaultVision {
        |_| true
    } else {
        |body| {
            let mut images = Vec::new();
            image_references(body, &mut images);
            images.is_empty()
        }
    };
    let (text_url, mut text_rx, text_shutdown) = start_controlled_terminal_upstream_with_body_when(
        StatusCode::OK,
        "application/json",
        text_response,
        accepts_default,
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
    if !matches!(pool, PoolState::MultimodalAbsent | PoolState::DefaultVision) {
        vision
            .models
            .get_mut("test")
            .unwrap()
            .capabilities
            .push("vision".into());
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
    if matches!(pool, PoolState::DefaultVision) {
        text.models
            .get_mut("test")
            .unwrap()
            .capabilities
            .push("vision".into());
    }
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
    if !matches!(pool, PoolState::MultimodalAbsent | PoolState::DefaultVision) {
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
        if matches!(
            pool,
            PoolState::MultimodalAvailable | PoolState::MultimodalDisabled
        ) {
            let mut text_target = default_pool
                .targets
                .iter()
                .find(|target| target.provider.as_deref() == Some("fallback"))
                .unwrap()
                .clone();
            text_target.priority = Some(100);
            targets.insert(0, text_target);
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
            if (part.get("file_id").is_some()
                && !(expect == Expect::Text && part["type"] == "input_image"))
                || part["type"] == "vendor_part"
            {
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
    if expect == Expect::Text {
        assert!(
            images.is_empty(),
            "text-only default must receive placeholders"
        );
        assert!(wire_text.contains("[Image]"));
        return;
    }
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
fn vision_default_provider_receives_original_images() {
    run_blackbox_test(async {
        let _guard = TEST_LOCK.lock().await;
        for protocol in ["openai_chat", "responses", "anthropic"] {
            run_case("/v1/responses", true, PoolState::DefaultVision, protocol).await;
        }
    });
}

#[tokio::test]
async fn completed_image_in_same_session_becomes_a_history_placeholder() {
    let _guard = TEST_LOCK.lock().await;
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    for direct in [false, true] {
        for stream in [false, true] {
            run_completed_image_history_case(direct, stream).await;
        }
    }
}

async fn run_completed_image_history_case(direct: bool, stream: bool) {
    let response = json!({
        "id":"resp_image_success","object":"response","status":"completed",
        "output":[{"type":"message","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":"image accepted"}]}]
    });
    let (content_type, body) = if stream {
        let terminal = json!({"type":"response.completed","response":response});
        (
            "text/event-stream",
            format!("event: response.completed\ndata: {terminal}\n\ndata: [DONE]\n\n").into_bytes(),
        )
    } else {
        ("application/json", serde_json::to_vec(&response).unwrap())
    };
    let (provider_url, mut captures, shutdown) = start_controlled_terminal_upstream_with_body_when(
        StatusCode::OK,
        content_type,
        body.clone(),
        |request| {
            let wire = request.to_string();
            if request["input"]
                .as_array()
                .and_then(|items| items.last())
                .is_some_and(|item| item.to_string().contains("reject this attempt"))
            {
                return false;
            }
            if wire.contains("accept only text") {
                let mut references = Vec::new();
                image_references(request, &mut references);
                return references.is_empty();
            }
            true
        },
    )
    .await;
    let (fallback_url, mut fallback_captures, fallback_shutdown) =
        start_controlled_terminal_upstream_with_body_when(
            StatusCode::OK,
            content_type,
            body.clone(),
            |request| {
                let mut references = Vec::new();
                image_references(request, &mut references);
                references.is_empty()
            },
        )
        .await;
    let (thinking_url, mut thinking_captures, thinking_shutdown) =
        start_controlled_terminal_upstream_with_body_when(
            StatusCode::OK,
            content_type,
            body,
            |request| {
                let mut references = Vec::new();
                image_references(request, &mut references);
                references.is_empty()
            },
        )
        .await;
    let mut manifest = if direct {
        responses_direct_binding_provider_protocol_manifest(
            free_port(),
            free_port(),
            "responses",
            &provider_url,
            r#""direct""#,
        )
    } else {
        responses_relay_provider_protocol_manifest(
            free_port(),
            free_port(),
            &provider_url,
            "responses",
            None,
        )
    };
    manifest
        .providers
        .values_mut()
        .next()
        .unwrap()
        .models
        .values_mut()
        .next()
        .unwrap()
        .capabilities
        .push("vision".into());
    let mut fallback = manifest.providers.values().next().unwrap().clone();
    fallback.id = "text_fallback".into();
    fallback.base_url = fallback_url.clone();
    fallback.interfaces.get_mut("default").unwrap().base_url = fallback_url;
    fallback
        .models
        .values_mut()
        .next()
        .unwrap()
        .capabilities
        .retain(|capability| capability != "vision");
    let mut thinking = fallback.clone();
    thinking.id = "history_thinking".into();
    thinking.base_url = thinking_url.clone();
    thinking.interfaces.get_mut("default").unwrap().base_url = thinking_url;
    manifest.providers.insert(thinking.id.clone(), thinking);
    manifest.providers.insert(fallback.id.clone(), fallback);
    let group = manifest.route_groups.get_mut("default").unwrap();
    group.pools.remove("client_test");
    let targets = &mut group.pools.get_mut("default").unwrap().targets;
    targets[0].priority = Some(2);
    let mut fallback_target = targets[0].clone();
    fallback_target.provider = Some("text_fallback".into());
    fallback_target.priority = Some(1);
    targets.push(fallback_target);
    let mut thinking_pool = group.pools["default"].clone();
    thinking_pool.id = "thinking".into();
    thinking_pool.match_rule = Some(routecodex_v3_config::V3RoutePoolMatchManifest {
        precedence: 10,
        entry_protocol: None,
        models: Vec::new(),
        required_capabilities: Vec::new(),
        min_input_tokens: None,
        max_input_tokens: None,
    });
    thinking_pool.targets.truncate(1);
    thinking_pool.targets[0].provider = Some("history_thinking".into());
    group.pools.insert("thinking".into(), thinking_pool);
    manifest.debug.snapshots = false;
    std::env::set_var("V3_P6_TEST_KEY", "image-history-control-key");
    std::env::set_var("V3_PROTOCOL_DECISION_KEY", "image-history-control-key");
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::new();
    let image = json!({"type":"message","id":"msg_history_test","role":"user",
        "content":[{"type":"input_text","text":"inspect image"},{"type":"input_image","image_url":PNG}]
    });
    let followup = json!({"type":"message","role":"user",
        "content":[{"type":"input_text","text":"continue in text"}]});
    let strict_followup = json!({"type":"message","role":"user",
        "content":[{"type":"input_text","text":"accept only text"}]});
    let prior_answer = json!({"type":"message","role":"assistant",
        "content":[{"type":"output_text","text":"image accepted"}]});
    let failed_image = json!({"role":"user",
        "content":[{"type":"input_text","text":"reject this attempt"},{"type":"input_image","image_url":PNG}]});
    // Keep the failed image in history, while the controlled provider rejects
    // the original current-turn request only.
    for (listener, session, input, expected_references) in [
        (
            0,
            Some("cold-image-history"),
            json!([image, prior_answer, followup]),
            vec![PNG],
        ),
        (
            0,
            Some("completed-image-history"),
            json!([image]),
            vec![PNG],
        ),
        (
            0,
            Some("completed-image-history"),
            json!([image, prior_answer, strict_followup]),
            vec![],
        ),
        (
            0,
            Some("completed-image-history"),
            json!([image, prior_answer, {"role":"user","content":[{"type":"input_image","image_url":PNG}]}]),
            vec![PNG],
        ),
        (
            1,
            Some("completed-image-history"),
            json!([image, prior_answer, followup]),
            vec![PNG],
        ),
        (
            0,
            Some("unrelated-image-history"),
            json!([image, prior_answer, followup]),
            vec![PNG],
        ),
        (0, None, json!([image, prior_answer, followup]), vec![PNG]),
        (
            0,
            Some("failed-image-history"),
            json!([failed_image]),
            vec![PNG],
        ),
        (
            0,
            Some("failed-image-history"),
            json!([failed_image, prior_answer, followup]),
            vec![PNG],
        ),
    ] {
        let url = format!("http://{}/v1/responses", server.listeners[listener].addr);
        let mut request = client
            .post(url)
            .json(&json!({"model":"test","stream":stream,"input":input}));
        if let Some(session) = session {
            request = request.header("session_id", session);
        }
        let switches_to_text_fallback = input == json!([failed_image]);
        let thinking_expected = expected_references.is_empty();
        let response = request
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .unwrap();
        let status = response.status();
        let response = response.text().await.unwrap();
        assert_eq!(
            status,
            StatusCode::OK,
            "direct={direct} stream={stream}: {response}"
        );
        assert!(response.contains("image accepted"), "{response}");
        let wire = if thinking_expected {
            thinking_captures.try_recv().unwrap().body
        } else {
            assert!(
                thinking_captures.try_recv().is_err(),
                "thinking must never receive an unrecorded historical image"
            );
            captures.try_recv().unwrap().body
        };
        let mut references = Vec::new();
        image_references(&wire, &mut references);
        assert_eq!(
            references, expected_references,
            "direct={direct} stream={stream} session={session:?}"
        );
        if expected_references.is_empty() {
            assert!(wire.to_string().contains("[Image]"));
        }
        assert!(
            captures.try_recv().is_err(),
            "request must use a single upstream attempt"
        );
        if switches_to_text_fallback {
            let fallback = fallback_captures.try_recv().unwrap().body;
            assert!(fallback.to_string().contains("[Image]"));
        }
        assert!(
            fallback_captures.try_recv().is_err(),
            "unexpected text fallback attempt"
        );
    }
    if stream {
        let mut request = format!("ws://{}/v1/responses", server.listeners[0].addr)
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "openai-beta",
            HeaderValue::from_static("responses_websockets=2026-02-06"),
        );
        request
            .headers_mut()
            .insert("session_id", HeaderValue::from_static("ws-image-history"));
        let (mut socket, _) = connect_async(request).await.unwrap();
        for (input, expected_references) in [
            (json!([image]), vec![PNG]),
            (json!([image, prior_answer, strict_followup]), vec![]),
        ] {
            socket
                .send(Message::Text(
                    json!({"type":"response.create","model":"test","stream":true,"input":input})
                        .to_string(),
                ))
                .await
                .unwrap();
            loop {
                let frame = timeout(Duration::from_secs(5), socket.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                let event: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
                assert_ne!(event["type"], "error", "{event}");
                if event["type"] == "response.completed" {
                    assert!(event.to_string().contains("image accepted"));
                    break;
                }
            }
            let mut references = Vec::new();
            let wire = if expected_references.is_empty() {
                thinking_captures.try_recv().unwrap().body
            } else {
                captures.try_recv().unwrap().body
            };
            image_references(&wire, &mut references);
            assert_eq!(references, expected_references, "WebSocket direct={direct}");
            assert!(
                fallback_captures.try_recv().is_err(),
                "WebSocket must succeed on the first attempt"
            );
        }
        socket.close(None).await.unwrap();
    }
    if !stream {
        let mut tool_input = json!([
            {"role":"user","content":"Use the image tool"},
            {"type":"function_call","name":"read_image","call_id":"call_receipt_image","arguments":"{}"},
            {"type":"function_call_output","call_id":"call_receipt_image","output":[
                {"type":"input_image","image_url":PNG},
                {"type":"input_text","text":"paired tool payload"}
            ]}
        ]);
        if direct {
            tool_input[2]["output"].as_array_mut().unwrap().insert(
                1,
                json!({"type":"input_image","file_id":"file-history-receipt"}),
            );
        } else {
            // Exercise JSON-encoded native paired media as well as native arrays.
            tool_input[2]["output"] = json!(tool_input[2]["output"].to_string());
        }
        let mut next = tool_input.as_array().unwrap().clone();
        next.push(prior_answer.clone());
        next.push(followup.clone());
        let url = format!("http://{}/v1/responses", server.listeners[0].addr);
        for (input, first) in [(tool_input, true), (json!(next), false)] {
            let reply = client
                .post(&url)
                .header("session_id", "paired-tool-image-history")
                .json(&json!({"model":"test","input":input,"stream":false}))
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .unwrap();
            assert_eq!(reply.status(), StatusCode::OK);
            assert!(reply.text().await.unwrap().contains("image accepted"));
            let wire = if first {
                captures.try_recv().unwrap().body
            } else {
                thinking_captures
                    .try_recv()
                    .unwrap_or_else(|error| {
                        panic!(
                            "direct={direct}, thinking: {error}, default: {:?}",
                            captures.try_recv().map(|capture| capture.body)
                        )
                    })
                    .body
            };
            let items = wire["input"].as_array().unwrap();
            let call = items
                .iter()
                .find(|item| {
                    item["type"] == "function_call" && item["call_id"] == "call_receipt_image"
                })
                .unwrap();
            assert_eq!(call["name"], "read_image");
            let output = items
                .iter()
                .find(|item| {
                    item["type"] == "function_call_output" && item["call_id"] == call["call_id"]
                })
                .unwrap();
            if first && !direct {
                assert!(
                    output["output"].is_array(),
                    "paired media must reach vision wire as structured parts: {output}"
                );
            }
            let output = output["output"].to_string();
            assert!(output.contains("paired tool payload"));
            assert_eq!(
                output.contains("file-history-receipt"),
                first && direct,
                "direct={direct}: {output}"
            );
            assert_eq!(output.contains(PNG), first, "direct={direct}: {output}");
            assert_eq!(
                output.matches("[Image]").count(),
                if first { 0 } else { 1 + usize::from(direct) }
            );
        }
    }
    if direct && !stream {
        let tool_text = json!([
            {"type":"input_image","image_url":OTHER},
            {"type":"input_image","file_id":"file-opaque-tool-text"}
        ])
        .to_string();
        let url = format!("http://{}/v1/responses", server.listeners[0].addr);
        let first = client.post(&url)
            .header("session_id", "opaque-tool-text")
            .json(&json!({"model":"test","stream":false,"input":[
                {"role":"user","content":"Return the description as text"},
                {"type":"function_call","name":"describe","call_id":"call_opaque_image","arguments":"{}"},
                {"type":"function_call_output","call_id":"call_opaque_image","output":tool_text}
            ]}))
            .timeout(Duration::from_secs(10)).send().await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert!(first.text().await.unwrap().contains("image accepted"));
        let first_wire = captures.try_recv().unwrap().body;
        assert_eq!(first_wire["input"][2]["output"], tool_text);
        let next = client
            .post(&url)
            .header("session_id", "opaque-tool-text")
            .json(&json!({"model":"test","stream":false,"input":[
                {"role":"user","content":[{"type":"input_image","image_url":OTHER},
                    {"type":"input_image","file_id":"file-opaque-tool-text"}]},
                prior_answer, followup
            ]}))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .unwrap();
        assert_eq!(next.status(), StatusCode::OK);
        assert!(next.text().await.unwrap().contains("image accepted"));
        assert!(
            thinking_captures.try_recv().is_err(),
            "successful tool text is not an image receipt"
        );
        let wire = captures.try_recv().unwrap().body;
        assert_eq!(wire["input"][0]["content"][0]["image_url"], OTHER);
        assert_eq!(
            wire["input"][0]["content"][1]["file_id"],
            "file-opaque-tool-text"
        );
    }
    server.shutdown().await;
    let _ = shutdown.send(());
    let _ = fallback_shutdown.send(());
    let _ = thinking_shutdown.send(());
    std::env::remove_var("V3_P6_TEST_KEY");
    std::env::remove_var("V3_PROTOCOL_DECISION_KEY");
}

#[tokio::test]
async fn gemini_tool_result_images_follow_the_selected_model_vision_contract() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_P6_TEST_KEY", "image-history-gemini-fixture");
    let completion = serde_json::to_vec(&json!({
        "candidates":[{"content":{"role":"model","parts":[{"text":"gemini image result accepted"}]},
            "finishReason":"STOP"}]
    }))
    .unwrap();
    let image_data = PNG.split_once(',').unwrap().1;
    for vision in [false, true] {
        let accepts = if vision {
            (|_: &Value| true) as fn(&Value) -> bool
        } else {
            |body: &Value| !body.to_string().contains(PNG.split_once(',').unwrap().1)
        };
        let (upstream_url, mut captures, shutdown) =
            start_controlled_terminal_upstream_with_body_when(
                StatusCode::OK,
                "application/json",
                completion.clone(),
                accepts,
            )
            .await;
        let upstream_beta = format!("{}/v1beta", upstream_url.trim_end_matches("/v1"));
        let mut manifest = responses_relay_provider_protocol_manifest(
            free_port(),
            free_port(),
            &upstream_beta,
            "gemini",
            None,
        );
        for listener in manifest.servers.values_mut() {
            listener.endpoints.push("gemini".into());
        }
        if vision {
            manifest
                .providers
                .get_mut("test")
                .unwrap()
                .models
                .get_mut("test")
                .unwrap()
                .capabilities
                .push("vision".into());
        }
        manifest
            .route_groups
            .get_mut("default")
            .unwrap()
            .pools
            .remove("client_test");
        manifest.debug.snapshots = false;
        let server = spawn_v3_server_aggregate(manifest).await.unwrap();
        let url = format!("http://{}/v1/responses", server.listeners[0].addr);
        let initial = json!([
            {"role":"user","content":"Read the image"},
            {"type":"function_call","name":"read_image","call_id":"call_gemini_image","arguments":"{}"},
            {"type":"function_call_output","call_id":"call_gemini_image","output":[
                {"type":"input_image","image_url":PNG},
                {"type":"input_text","text":"tool companion text"}
            ]}
        ]);
        let mut followup = initial.as_array().unwrap().clone();
        followup.push(json!({"role":"user","content":"Continue with text"}));
        let client = reqwest::Client::new();
        for (input, first) in [(initial, true), (json!(followup), false)] {
            let reply = client
                .post(&url)
                .header("session_id", "gemini-image-history")
                .json(&json!({"model":"test","input":input,"stream":false}))
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .unwrap();
            assert_eq!(reply.status(), StatusCode::OK);
            assert!(reply
                .text()
                .await
                .unwrap()
                .contains("gemini image result accepted"));
            let wire = captures.try_recv().unwrap().body;
            assert!(contains_opaque_value(
                &wire,
                &json!({"functionCall":{"name":"read_image","id":"call_gemini_image","args":{}}})
            ));
            let result = wire["contents"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|content| content["parts"].as_array().into_iter().flatten())
                .find_map(|part| part.get("functionResponse"))
                .unwrap();
            assert_eq!(result["id"], "call_gemini_image");
            assert_eq!(result["name"], "read_image");
            let output = result["response"]["output"].to_string();
            assert!(output.contains("tool companion text"));
            assert_eq!(output.contains(image_data), first && vision, "{output}");
            assert_eq!(output.contains("[Image]"), !first || !vision, "{output}");
            assert!(captures.try_recv().is_err());
        }
        if !vision {
            let native = json!({"contents":[
                {"role":"user","parts":[{"text":"Read the image"}]},
                {"role":"model","parts":[{"functionCall":{"name":"read_image","id":"call_native_image","args":{}}}]},
                {"role":"user","parts":[{"functionResponse":{
                    "name":"read_image","id":"call_native_image","response":{"output":"native companion text"},
                    "parts":[{"inlineData":{"mimeType":"image/png","data":image_data}}]
                }}]}
            ]});
            let reply = client
                .post(format!(
                    "http://{}/v1beta/models/test:generateContent",
                    server.listeners[0].addr
                ))
                .json(&native)
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .unwrap();
            assert_eq!(reply.status(), StatusCode::OK);
            let wire = captures.try_recv().unwrap().body;
            let wire_text = wire.to_string();
            assert!(wire_text.contains("[Image]"));
            assert!(!wire_text.contains(image_data));
            assert!(contains_opaque_value(
                &wire,
                &json!({
                    "id":"call_native_image","name":"read_image","response":{"output":"native companion text"}
                })
            ));
        }
        server.shutdown().await;
        let _ = shutdown.send(());
    }
    std::env::remove_var("V3_P6_TEST_KEY");
}

#[tokio::test]
async fn history_receipts_require_complete_success_and_stay_stable_during_retry() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_P6_TEST_KEY", "image-history-concurrent-fixture");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = listener.local_addr().unwrap();
    let (captured, mut captures) = mpsc::unbounded_channel();
    let release_retry = Arc::new(Semaphore::new(0));
    let (stop_tx, stop_rx) = oneshot::channel();
    let app = Router::new().route(
        "/:provider/v1/responses",
        post({
            let release_retry = release_retry.clone();
            move |axum::extract::Path(provider): axum::extract::Path<String>,
                  axum::Json(body): axum::Json<Value>| {
                let captured = captured.clone();
                let release_retry = release_retry.clone();
                async move {
                    let text = body.to_string();
                    captured.send((provider.clone(), body)).unwrap();
                    if text.contains("delay-before-reselection") && provider == "primary" {
                        release_retry.acquire().await.unwrap().forget();
                        return (StatusCode::BAD_REQUEST, axum::Json(json!({"error":{"message":"retry fixture"}})));
                    }
                    if text.contains("terminal-fixture-http-error") {
                        return (StatusCode::BAD_REQUEST, axum::Json(json!({"error":{"message":"terminal fixture"}})));
                    }
                    if text.contains("terminal-fixture-empty-business") {
                        return (StatusCode::OK, axum::Json(json!({"id":"empty","object":"response","status":"completed","output":[]})));
                    }
                    (StatusCode::OK, axum::Json(json!({
                        "id":"ok","object":"response","status":"completed",
                        "output":[{"type":"message","role":"assistant","status":"completed",
                            "content":[{"type":"output_text","text":"receipt fixture ok"}]}]
                    })))
                }
            }
        }),
    );
    let upstream_task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await
            .unwrap();
    });
    let mut manifest = responses_relay_provider_protocol_manifest(
        free_port(),
        free_port(),
        &format!("http://{upstream}/primary/v1"),
        "responses",
        Some(&format!("http://{upstream}/secondary/v1")),
    );
    for provider in manifest.providers.values_mut() {
        provider
            .models
            .get_mut("test")
            .unwrap()
            .capabilities
            .push("vision".into());
    }
    manifest
        .route_groups
        .get_mut("default")
        .unwrap()
        .pools
        .remove("client_test");
    manifest.debug.snapshots = false;
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", server.listeners[0].addr);
    let client = reqwest::Client::new();
    let send = |session: &'static str, input: Value| {
        client
            .post(&endpoint)
            .header("session_id", session)
            .json(&json!({"model":"test","stream":false,"input":input}))
            .timeout(Duration::from_secs(8))
            .send()
    };
    let photo = json!({"role":"user","content":[{"type":"input_image","image_url":PNG}]});
    let followup = |marker| {
        json!([photo,
            {"role":"assistant","content":[{"type":"output_text","text":"fixture history"}]},
            {"role":"user","content":marker}
        ])
    };
    for (session, marker) in [
        ("terminal-http-error", "terminal-fixture-http-error"),
        ("terminal-business-error", "terminal-fixture-empty-business"),
    ] {
        if let Ok(response) = send(session, followup(marker)).await {
            assert!(!response.status().is_success());
        }
        let mut count = 0;
        while let Ok((_, body)) = captures.try_recv() {
            assert!(body.to_string().contains(PNG));
            count += 1;
        }
        assert!(count > 0);
        let reply = send(session, followup("recover after failure"))
            .await
            .unwrap();
        assert_eq!(reply.status(), StatusCode::OK);
        assert!(captures.try_recv().unwrap().1.to_string().contains(PNG));
    }

    let pending = tokio::spawn(send(
        "overlapping-image-history",
        followup("delay-before-reselection"),
    ));
    let (provider, first_attempt) = timeout(Duration::from_secs(4), captures.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(provider, "primary");
    assert!(first_attempt.to_string().contains(PNG));
    let successful = send("overlapping-image-history", json!([photo]))
        .await
        .unwrap();
    assert_eq!(successful.status(), StatusCode::OK);
    assert!(captures.try_recv().unwrap().1.to_string().contains(PNG));
    release_retry.add_permits(1);
    assert_eq!(pending.await.unwrap().unwrap().status(), StatusCode::OK);
    let (provider, retried) = captures.try_recv().unwrap();
    assert_eq!(provider, "secondary");
    assert!(retried.to_string().contains(PNG));

    let settled = send("overlapping-image-history", followup("read after both"))
        .await
        .unwrap();
    assert_eq!(settled.status(), StatusCode::OK);
    let (_, wire) = captures.try_recv().unwrap();
    assert!(wire.to_string().contains("[Image]"));
    assert!(!wire.to_string().contains(PNG));
    server.shutdown().await;
    let _ = stop_tx.send(());
    upstream_task.await.unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
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
fn disabled_multimodal_pool_continues_to_declared_default() {
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
    vision.capabilities.push("vision".into());
    vision.wire_name = "vision-wire".into();
    let text = manifest.providers.get_mut("fallback").unwrap();
    text.provider_type = "openai_chat".into();
    text.interfaces.get_mut("default").unwrap().provider_type = "openai_chat".into();
    text.models.get_mut("test").unwrap().wire_name = "text-wire".into();
    let group = manifest.route_groups.get_mut("default").unwrap();
    group.pools.remove("client_test");
    let default_pool = group.pools.get("default").unwrap().clone();
    let mut multimodal_pool = default_pool.clone();
    multimodal_pool.id = "multimodal".into();
    multimodal_pool.match_rule = Some(routecodex_v3_config::V3RoutePoolMatchManifest {
        precedence: 100,
        entry_protocol: None,
        models: Vec::new(),
        required_capabilities: vec!["multimodal".into()],
        min_input_tokens: None,
        max_input_tokens: None,
    });
    multimodal_pool.targets = vec![pool_target("test")];
    group.pools.insert("multimodal".into(), multimodal_pool);
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
    let has_image = match &content {
        Value::Array(parts) => parts.iter().any(|part| {
            part.get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.contains("image"))
        }),
        Value::Object(row)
            if row.get("type").and_then(Value::as_str) == Some("function_call_output") =>
        {
            let mut refs = Vec::new();
            image_references(&content, &mut refs);
            !refs.is_empty()
        }
        _ => false,
    };
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
        assert!(
            refs.is_empty(),
            "text-only default must receive placeholders"
        );
        assert!(wire.to_string().contains("[Image]"));
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

#[tokio::test]
async fn paired_historical_inline_image_tool_result_projects_to_text_placeholder() {
    let _guard = TEST_LOCK.lock().await;
    assert_isolated_image_boundary(
        "/v1/responses",
        json!({
            "type":"function_call_output",
            "call_id":"bare_data",
            "output":"data:image/png;base64,AAAA"
        }),
        true,
    )
    .await;
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

async fn run_consecutive_user_turn_image_case(path: &str) {
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
    // A vision-capable search candidate is still outside the image route.
    manifest
        .providers
        .get_mut("test")
        .unwrap()
        .models
        .get_mut("test")
        .unwrap()
        .capabilities
        .push("vision".into());
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
        .push("vision".into());
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

    let image_body = vision_rx
        .try_recv()
        .map(|capture| capture.body)
        .unwrap_or_else(|_| {
            panic!("the multimodal pool must be selected for consecutive user image input: {path}")
        });
    assert!(
        search_rx.try_recv().is_err(),
        "the web_search pool must not receive image requests: {path}"
    );
    assert!(
        think_rx.try_recv().is_err(),
        "thinking must not shadow hosted search for consecutive user turns: {path}"
    );
    assert!(
        default_rx.try_recv().is_err(),
        "default must not be consulted while the multimodal target succeeds: {path}"
    );
    let wire_text = image_body.to_string();
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
    image_references(&image_body, &mut refs);
    assert!(
        refs.iter().any(|reference| reference == CONSECUTIVE_IMAGE),
        "current-turn image must reach the vision provider: {path} {wire_text}"
    );
}

#[tokio::test]
async fn consecutive_user_turns_with_search_and_images_select_multimodal() {
    let _guard = TEST_LOCK.lock().await;
    for path in [
        "/v1/responses",
        "/v1/chat/completions",
        "/v1beta/models/test:generateContent",
    ] {
        run_consecutive_user_turn_image_case(path).await;
    }
}

async fn run_thinking_pool_history_size_case(
    path: &str,
    history_text: &str,
    current_text: &str,
    expect_thinking: bool,
    read_command: Option<&str>,
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
    let mut body = if path == "/v1/responses" {
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
    if let Some(command) = read_command {
        body["input"].as_array_mut().unwrap().extend([
            json!({"type":"function_call","name":"exec_command","call_id":"read_file",
                   "arguments":json!({"cmd":command}).to_string()}),
            json!({"type":"function_call_output","call_id":"read_file","output":"read completed"}),
        ]);
    }

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
        run_thinking_pool_history_size_case(path, "short history", "hello", true, None).await;
        let long_history = "history filler sentence about the current turn. ".repeat(240);
        run_thinking_pool_history_size_case(path, &long_history, "hello", true, None).await;
    }
    let path = "/v1beta/models/test:generateContent";
    run_thinking_pool_history_size_case(path, &"old history ".repeat(3000), "hello", true, None)
        .await;
    run_thinking_pool_history_size_case(
        path,
        "short history",
        &"current request ".repeat(2000),
        false,
        None,
    )
    .await;
}

#[tokio::test]
async fn file_read_tool_continuation_selects_thinking() {
    let _guard = TEST_LOCK.lock().await;
    run_thinking_pool_history_size_case(
        "/v1/responses",
        "previous answer",
        "read this file",
        true,
        Some("cat< src/lib.rs | rg -n route"),
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
