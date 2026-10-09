use super::*;
use futures_util::FutureExt;

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
        Value::Object(row) => {
            if row.get("type").and_then(Value::as_str) == Some("image_url") {
                output.push(
                    row["image_url"]["url"]
                        .as_str()
                        .expect("Chat image part must retain a real source URL")
                        .to_string(),
                );
            }
            if row.get("type").and_then(Value::as_str) == Some("input_image") {
                if let Some(reference) = row
                    .get("image_url")
                    .or_else(|| row.get("file_url"))
                    .or_else(|| row.get("data"))
                    .and_then(Value::as_str)
                {
                    output.push(
                        if reference.starts_with("data:") || !row.contains_key("data") {
                            reference.to_string()
                        } else {
                            format!(
                                "data:{};base64,{reference}",
                                row["media_type"].as_str().unwrap()
                            )
                        },
                    );
                }
            }
            if row.get("type").and_then(Value::as_str) == Some("image") {
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

#[derive(Clone, Copy, Debug)]
enum PoolState {
    Available,
    Empty,
    Exhausted,
    MixedAvailable,
    MixedExhausted,
    DefaultVisionAvailable,
    TransportFailure,
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
            } else {
                input.push(json!({"role":"user","content":images}));
            }
            input.push(json!({"role":"user","content":"Current time reminder; source mentions data:image/png;base64,example"}));
            input.push(json!({"role":"user","content":[{"type":"input_text","text":"data:image/png;base64,example is documentation text"}]}));
            input.push(json!({"role":"user","content":"data:image/png;base64,example is ordinary message text"}));
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
            } else {
                messages.push(json!({"role":"user","content":chat_images}));
            }
            messages.push(json!({"role":"user","content":"{\"data\":\"ordinary-business-json\",\"text\":\"Current time reminder; source mentions data:image/png;base64,example\"}"}));
            messages.push(json!({"role":"user","content":[{"type":"text","text":"data:image/png;base64,example is documentation text"}]}));
            messages.push(json!({"role":"user","content":"data:image/png;base64,example is ordinary message text"}));
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
            } else {
                messages.push(json!({"role":"user","content":images}));
            }
            messages.push(json!({"role":"user","content":"Current time reminder; source mentions data:image/png;base64,example"}));
            messages.push(json!({"role":"user","content":[{"type":"text","text":"data:image/png;base64,example is documentation text"}]}));
            messages.push(json!({"role":"user","content":"data:image/png;base64,example is ordinary message text"}));
            json!({"model":"test","stream":false,"max_tokens":128,"messages":messages})
        }
        _ => unreachable!(),
    }
}

async fn run_case(path: &str, tool: bool, pool: PoolState, protocol: &str) {
    run_case_shape(path, tool, pool, protocol, false, None).await;
    if tool {
        run_case_shape(path, tool, pool, protocol, true, None).await;
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
    // External HTTP providers capture the complete request. Selection exhaustion
    // uses a real declared context limit, without changing private health state.
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
            if matches!(pool, PoolState::TransportFailure) {
                StatusCode::BAD_GATEWAY
            } else {
                StatusCode::OK
            },
            "application/json",
            if matches!(pool, PoolState::TransportFailure) {
                serde_json::to_vec(&json!({"error":{"message":"controlled vision failure"}}))
                    .unwrap()
            } else {
                response.clone()
            },
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
    }
    let vision = manifest.providers.get_mut("test").unwrap();
    if protocol == "anthropic" {
        vision.base_url = vision_url.trim_end_matches("/v1").to_string();
    }
    vision.models.get_mut("test").unwrap().wire_name = "vision-wire".into();
    if !matches!(pool, PoolState::Empty) {
        vision
            .models
            .get_mut("test")
            .unwrap()
            .capabilities
            .push("multimodal".into());
    }
    if matches!(pool, PoolState::Exhausted | PoolState::MixedExhausted) {
        vision.models.get_mut("test").unwrap().max_context_tokens = Some(1);
    }
    let text = manifest.providers.get_mut("fallback").unwrap();
    text.provider_type = protocol.into();
    if protocol == "anthropic" {
        text.base_url = text_url.trim_end_matches("/v1").to_string();
    }
    text.models.get_mut("test").unwrap().wire_name = "text-wire".into();
    let group = manifest.route_groups.get_mut("default").unwrap();
    group.pools.remove("client_test");
    if matches!(
        pool,
        PoolState::MixedAvailable | PoolState::MixedExhausted | PoolState::DefaultVisionAvailable
    ) {
        let mut mixed = group.pools["default"].clone();
        mixed.id = "multimodal".into();
        mixed.match_rule = Some(routecodex_v3_config::V3RoutePoolMatchManifest {
            precedence: 100,
            entry_protocol: None,
            models: Vec::new(),
            required_capabilities: vec!["multimodal".into()],
            min_input_tokens: None,
            max_input_tokens: None,
        });
        for target in &mut mixed.targets {
            target.priority = Some(if target.provider.as_deref() == Some("fallback") {
                3
            } else {
                2
            });
        }
        if matches!(pool, PoolState::DefaultVisionAvailable) {
            mixed
                .targets
                .retain(|target| target.provider.as_deref() == Some("fallback"));
            for target in &mut group.pools.get_mut("default").unwrap().targets {
                target.priority = Some(if target.provider.as_deref() == Some("fallback") {
                    3
                } else {
                    2
                });
            }
        }
        group.pools.insert("multimodal".into(), mixed);
    }
    if !matches!(pool, PoolState::DefaultVisionAvailable) {
        group
            .pools
            .get_mut("default")
            .unwrap()
            .targets
            .retain(|target| target.provider.as_deref() == Some("fallback"));
    }
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
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    // Shut down owned listeners even when an assertion below finds a regression.
    handle.shutdown().await;
    let _ = vision_shutdown.send(());
    let _ = text_shutdown.send(());
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
    let wire = if matches!(
        pool,
        PoolState::Available | PoolState::MixedAvailable | PoolState::DefaultVisionAvailable
    ) {
        assert!(
            text_rx.try_recv().is_err(),
            "text provider must remain unused: {path} tool={tool} protocol={protocol}"
        );
        let capture = vision_rx
            .try_recv()
            .expect("multimodal must receive the request");
        assert!(
            vision_rx.try_recv().is_err(),
            "exactly one provider attempt"
        );
        assert_eq!(capture.body["model"], "vision-wire");
        capture.body
    } else {
        if matches!(pool, PoolState::TransportFailure) {
            let attempted = vision_rx
                .try_recv()
                .expect("vision must be attempted before text projection");
            let mut refs = Vec::new();
            image_references(&attempted.body, &mut refs);
            assert_eq!(
                refs,
                vec![PNG, OTHER],
                "failed vision attempt must receive latest image bytes"
            );
        }
        assert!(
            vision_rx.try_recv().is_err(),
            "absent/exhausted multimodal has no network attempt"
        );
        let capture = text_rx
            .try_recv()
            .expect("text provider receives the exhausted/empty case");
        assert!(
            text_rx.try_recv().is_err(),
            "exactly one text provider attempt"
        );
        assert_eq!(capture.body["model"], "text-wire");
        capture.body
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
        !wire_text.contains("PADDED"),
        "earlier whitespace-padded tool image bytes must be cleaned"
    );
    assert!(
        wire_text.contains("source mentions data:image/png;base64,example"),
        "ordinary source literals must survive image cleanup"
    );
    assert!(wire_text.contains("data:image/png;base64,example is documentation text") && wire_text.contains("data:image/png;base64,example is ordinary message text"), "declared and native message text must remain text even when it starts with an image literal");
    assert!(
        wire_text.contains("describe the latest image"),
        "ordinary text parts with data fields must survive image cleanup"
    );
    assert!(
        !wire_text.contains(OLD),
        "old image must be a placeholder: {wire_text}"
    );
    assert!(
        wire_text.contains("[Image]"),
        "history image placeholder must survive"
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
        if protocol == "openai_chat"
            && matches!(
                pool,
                PoolState::Available
                    | PoolState::MixedAvailable
                    | PoolState::DefaultVisionAvailable
            )
        {
            let messages = wire["messages"].as_array().unwrap();
            let first = messages
                .iter()
                .position(|message| message["tool_call_id"] == "call_image")
                .unwrap();
            if image_only {
                assert_eq!(
                    messages[first]["content"], "",
                    "image-only tool results must keep a representable empty text result"
                );
            }
            assert_eq!(messages[first + 1]["tool_call_id"], "call_text", "all parallel tool results must precede the adjacent image user message: {wire_text}");
            assert_eq!(messages[first + 2]["role"], "user");
        }
    }
    let mut images = Vec::new();
    image_references(&wire, &mut images);
    assert_eq!(
        images,
        vec![PNG, OTHER],
        "representable latest images reach the selected provider even without a capability declaration: {protocol}"
    );
}

#[tokio::test]
async fn latest_images_chat_available() {
    let _guard = TEST_LOCK.lock().await;
    for tool in [false, true] {
        for protocol in ["openai_chat", "responses", "anthropic"] {
            run_case("/v1/chat/completions", tool, PoolState::Available, protocol).await;
        }
    }
}

#[tokio::test]
async fn latest_images_responses_available() {
    let _guard = TEST_LOCK.lock().await;
    for tool in [false, true] {
        for protocol in ["openai_chat", "responses", "anthropic"] {
            run_case("/v1/responses", tool, PoolState::Available, protocol).await;
        }
    }
}

#[tokio::test]
async fn latest_images_anthropic_available() {
    let _guard = TEST_LOCK.lock().await;
    for tool in [false, true] {
        for protocol in ["openai_chat", "responses", "anthropic"] {
            run_case("/v1/messages", tool, PoolState::Available, protocol).await;
        }
    }
}

#[tokio::test]
async fn latest_images_preserved_with_empty_or_exhausted_multimodal() {
    let _guard = TEST_LOCK.lock().await;
    for path in ["/v1/chat/completions", "/v1/responses", "/v1/messages"] {
        for tool in [false, true] {
            for pool in [PoolState::Empty, PoolState::Exhausted] {
                for protocol in ["openai_chat", "responses", "anthropic"] {
                    run_case(path, tool, pool, protocol).await;
                }
            }
        }
    }
}

#[tokio::test]
async fn mixed_multimodal_pool_skips_text_candidates_and_projects_only_after_exhaustion() {
    let _guard = TEST_LOCK.lock().await;
    for path in ["/v1/chat/completions", "/v1/responses", "/v1/messages"] {
        for tool in [false, true] {
            for protocol in ["openai_chat", "responses", "anthropic"] {
                run_case(path, tool, PoolState::MixedAvailable, protocol).await;
                run_case(path, tool, PoolState::DefaultVisionAvailable, protocol).await;
            }
            run_case(path, tool, PoolState::MixedExhausted, "openai_chat").await;
        }
    }
}

async fn assert_isolated_image_boundary(path: &str, content: Value, retain_image: bool) {
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
            content,
        ]
    } else {
        vec![json!({"role":"user","content":content})]
    };
    if retain_image {
        messages.push(json!({"role":"assistant","content":"previous answer"}));
        messages.push(json!({"role":"user","content":"a later ordinary text-only user turn"}));
    }
    body[field] = Value::Array(messages);
    let original = body.to_string();
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let result = reqwest::Client::new()
        .post(format!("http://{}{path}", handle.listeners[0].addr))
        .json(&body)
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    handle.shutdown().await;
    let _ = vision_shutdown.send(());
    let _ = text_shutdown.send(());
    let response =
        result.unwrap_or_else(|error| panic!("{path} retain_image={retain_image}: {error}"));
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.text().await.unwrap().contains("boundary-ok"));
    let wire = if retain_image {
        assert!(
            text_rx.try_recv().is_err(),
            "latest image must select vision even after assistant and text-only user"
        );
        vision_rx.try_recv().expect("vision request").body
    } else {
        assert!(
            vision_rx.try_recv().is_err(),
            "ordinary isolated text must not select vision: {original}"
        );
        text_rx.try_recv().expect("text request").body
    };
    assert!(
        vision_rx.try_recv().is_err() && text_rx.try_recv().is_err(),
        "exactly one attempt"
    );
    assert_eq!(
        wire["model"],
        if retain_image {
            "vision-wire"
        } else {
            "text-wire"
        }
    );
    let mut refs = Vec::new();
    image_references(&wire, &mut refs);
    assert_eq!(refs, if retain_image { vec![PNG] } else { Vec::new() });
    if retain_image {
        assert!(
            !wire.to_string().contains("[Image]"),
            "the sole/latest image must not be cleaned"
        );
        assert!(wire
            .to_string()
            .contains("a later ordinary text-only user turn"));
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
async fn sole_latest_image_survives_assistant_and_later_text_only_user() {
    let _guard = TEST_LOCK.lock().await;
    for path in ["/v1/chat/completions", "/v1/responses", "/v1/messages"] {
        let content = match path {
            "/v1/responses" => json!([{"type":"input_image","image_url":PNG}]),
            "/v1/messages" => {
                json!([{"type":"image","source":{"type":"base64","media_type":"image/png","data":PNG.split_once(',').unwrap().1}}])
            }
            _ => json!([{"type":"image_url","image_url":{"url":PNG}}]),
        };
        assert_isolated_image_boundary(path, content, true).await;
    }
}

#[tokio::test]
async fn vision_transport_failure_exhausts_before_default_image_passage() {
    let _guard = TEST_LOCK.lock().await;
    for path in ["/v1/chat/completions", "/v1/responses", "/v1/messages"] {
        for tool in [false, true] {
            run_case(path, tool, PoolState::TransportFailure, "openai_chat").await;
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
                    PoolState::Available,
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
        true,
    )
    .await;
}
