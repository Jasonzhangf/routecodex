// ---------------------------------------------------------------------------
// Gemini 请求 canonicalization 的 standard outbound consumer 证据。
//
// Gemini 客户端 payload 经 `build_v3_chat_canonical_request_from_gemini_payload`
// 无损归一化为 canonical Chat 后，standard outbound builder（OpenAI Chat /
// Responses / Anthropic）必须直接消费该形状，不再需要 Gemini->X 成对 converter。
//
// 本片段由 `request_outbound_format_extra_tests.rs` 经同作用域 `include!` 展开，
// 沿用其 `use super::*` 与私有 helper 可见性。
// ---------------------------------------------------------------------------

fn gemini_text_only_request() -> serde_json::Value {
    json!({
        "model": "gemini-2.5-pro",
        "contents": [
            {"role": "user", "parts": [{"text": "hello"}]},
            {"role": "model", "parts": [{"text": "hi"}]}
        ],
        "generationConfig": {"maxOutputTokens": 64, "temperature": 0.2},
        "tools": [{
            "functionDeclarations": [{
                "name": "lookup",
                "description": "Look up a city",
                "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}
            }]
        }],
        "toolConfig": {"functionCallingConfig": {"mode": "AUTO"}}
    })
}

#[test]
fn gemini_explicit_thinking_budgets_reach_anthropic_standard_consumer() {
    for budget in [0, 4096] {
        let source = json!({
            "contents":[{"role":"user","parts":[{"text":"thinking control"}]}],
            "generationConfig":{"maxOutputTokens":8192,"thinkingConfig":{"thinkingBudget":budget}},
            "stream":false
        });
        let canonical = crate::hub_v1::build_v3_chat_canonical_request_from_gemini_payload(&source)
            .expect("Gemini source normalizes");
        let standard = build_v3_anthropic_provider_request_source_from_chat_canonical(
            &canonical, V3HubEntryProtocol::Gemini).expect("standard source projection");
        let wire = crate::hub_v1::encode_v3_responses_semantic_as_anthropic_request(standard)
            .expect("mapped Gemini thinking reaches the existing Anthropic consumer");
        assert_eq!(wire["max_tokens"], 8192);
        assert_eq!(wire["messages"][0]["content"][0]["text"], "thinking control");
        assert_eq!(wire["thinking"], if budget == 0 {
            json!({"type":"disabled"})
        } else {
            json!({"type":"enabled","budget_tokens":budget})
        });
    }
}

#[test]
fn gemini_thinking_anthropic_preserves_native_residual() {
    let source = json!({
        "contents":[{"role":"user","parts":[{"text":"thinking control"}]}],
        "generationConfig":{"maxOutputTokens":8192,"thinkingConfig":{"thinkingBudget":4096},
            "vendor":{"nested":[1,null,{"opaque":true}]}},
        "vendor_root":{"complete":["keep",false]},"stream":false
    });
    let canonical = crate::hub_v1::build_v3_chat_canonical_request_from_gemini_payload(&source).unwrap();
    let mut expected = canonical["routecodex_chat_extension"]["gemini_native_fields"].clone();
    for record in expected.as_array_mut().unwrap() {
        if record["kind"] == "request" {
            record["fields"].as_object_mut().unwrap().remove("stream");
        }
    }
    let standard = build_v3_anthropic_provider_request_source_from_chat_canonical(
        &canonical, V3HubEntryProtocol::Gemini).unwrap();
    let wire = crate::hub_v1::encode_v3_responses_semantic_as_anthropic_request(standard).unwrap();
    assert_eq!(wire["thinking"], json!({"type":"enabled","budget_tokens":4096}));
    assert_eq!(wire["routecodex_chat_extension"]["gemini_native_fields"], expected);
    assert_eq!(wire["stream"], false);
}

#[test]
fn gemini_tool_media_lift_preserves_json_text_and_complete_result_group() {
    let response = json!({"output":"read it","details":{"pages":[1,2],"complete":true}});
    let source = json!({"contents":[
        {"role":"model","parts":[
            {"functionCall":{"id":"c1","name":"read","args":{}}},
            {"functionCall":{"id":"c2","name":"check","args":{}}}
        ]},
        {"role":"user","parts":[
            {"functionResponse":{"id":"c1","name":"read","response":response,"parts":[
                {"inlineData":{"mimeType":"application/pdf","data":"UERG"}},
                {"fileData":{"mimeType":"image/png","fileUri":"https://x/y.png"}}
            ]}},
            {"functionResponse":{"id":"c2","name":"check","response":{"ok":true},"parts":[
                {"inlineData":{"mimeType":"image/jpeg","data":"/9j/"}}
            ]}}
        ]},
        {"role":"user","parts":[{"text":"continue"}]}
    ]});
    let canonical = crate::hub_v1::build_v3_chat_canonical_request_from_gemini_payload(&source).unwrap();
    let wire = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical).unwrap();
    let messages = wire["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 5);
    assert_eq!(messages[0]["tool_calls"][0]["id"], "c1");
    assert_eq!(messages[0]["tool_calls"][1]["id"], "c2");
    assert_eq!(messages[1]["tool_call_id"], "c1");
    assert_eq!(messages[1]["content"], serde_json::to_string(&response).unwrap());
    assert_eq!(messages[2]["tool_call_id"], "c2");
    assert_eq!(messages[2]["content"], r#"{"ok":true}"#);
    assert_eq!(messages[3], json!({"role":"user","content":[
        {"type":"file","file":{"file_data":"data:application/pdf;base64,UERG"}},
        {"type":"image_url","image_url":{"url":"https://x/y.png"}},
        {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,/9j/"}}
    ]}));
    assert_eq!(canonical_text(&messages[4]["content"]), "continue");
}

#[test]
fn chat_native_tool_media_lift_keeps_source_text_array_shape() {
    let source = json!({"messages":[{"role":"tool","tool_call_id":"c1","content":[
        {"type":"text","text":"{\"output\":\"read it\"}"},
        {"type":"file","file":{"file_data":"data:application/pdf;base64,UERG"}}
    ]}]});
    let wire = build_v3_openai_chat_standard_request_from_chat_canonical(&source).unwrap();
    assert_eq!(wire["messages"][0]["content"], json!([
        {"type":"text","text":"{\"output\":\"read it\"}"}
    ]));
    assert_eq!(wire["messages"][1]["role"], "user");
}

#[test]
fn gemini_root_carrier_preserves_residual_without_replaying_source_tools() {
    let source = json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}],
        "vendor_root":{"nested":[1,null]},"tools":[{"functionDeclarations":[{
            "name":"original","parameters":{"type":"object"},"vendor":{"keep":[true,false]}
        }]}]});
    let mut canonical = crate::hub_v1::build_v3_chat_canonical_request_from_gemini_payload(&source).unwrap();
    let residual = canonical["routecodex_chat_extension"].clone();
    canonical["tools"][0]["function"]["name"] = json!("governed");
    canonical["tools"][0]["function"]["parameters"] = json!({"const":"governed"});
    let wire = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical).unwrap();
    assert_eq!(wire["tools"][0]["function"]["name"], "governed");
    assert_eq!(wire["tools"][0]["function"]["parameters"], json!({"const":"governed"}));
    assert_eq!(wire["routecodex_chat_extension"], residual);
}

#[test]
fn gemini_root_carrier_never_restores_a_removed_declaration() {
    let source = json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}],
        "tools":[{"functionDeclarations":[{"name":"removed","parameters":{"type":"object"}}]}]});
    let mut canonical = crate::hub_v1::build_v3_chat_canonical_request_from_gemini_payload(&source).unwrap();
    canonical.as_object_mut().unwrap().remove("tools");
    let wire = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical).unwrap();
    assert!(wire.get("tools").is_none_or(|tools| tools.as_array().is_some_and(Vec::is_empty)));
}

fn gemini_canonical(source: &serde_json::Value) -> serde_json::Value {
    crate::hub_v1::build_v3_chat_canonical_request_from_gemini_payload(source)
        .expect("Gemini payload must canonicalize into Chat")
}

/// Canonical Chat content 现在按 native part 边界保存为有序对象数组。本 helper 只在
/// 断言“文本已到达目标 wire”时抽取 text parts；part 边界本身由
/// `gemini_native_text_boundaries_do_not_collide` 单独锁定，不在这里按字符串合并。
fn canonical_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        other => panic!("unexpected canonical content shape: {other}"),
    }
}

#[test]
fn gemini_text_request_is_consumed_by_every_standard_outbound_builder() {
    let canonical = gemini_canonical(&gemini_text_only_request());
    println!("[gemini-canonical][text] canonical={canonical}");
    assert_eq!(canonical["messages"][0]["role"], "user");
    let user_parts = canonical["messages"][0]["content"]
        .as_array()
        .expect("mapped native text parts must stay an ordered canonical array");
    assert_eq!(user_parts.len(), 1, "single native text part keeps one canonical object");
    assert_eq!(user_parts[0]["type"], "text");
    assert_eq!(user_parts[0]["text"], "hello");
    assert_eq!(canonical["messages"][1]["role"], "assistant");
    let assistant_parts = canonical["messages"][1]["content"]
        .as_array()
        .expect("mapped native text parts must stay an ordered canonical array");
    assert_eq!(assistant_parts.len(), 1);
    assert_eq!(assistant_parts[0]["text"], "hi");
    assert!(canonical.get("contents").is_none());

    let chat = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("standard OpenAI Chat builder must consume Gemini canonical");
    println!("[gemini-canonical][openai_chat] wire={chat}");
    assert_eq!(canonical_text(&chat["messages"][0]["content"]), "hello");
    assert_eq!(chat["messages"][0]["role"], "user");
    assert_eq!(chat["messages"][1]["role"], "assistant");
    assert_eq!(chat["tools"][0]["function"]["name"], "lookup");
    assert_eq!(chat["tools"][0]["function"]["parameters"]["properties"]["city"]["type"], "string");
    assert_eq!(chat["tool_choice"], "auto");
    assert_eq!(chat["model"], "gemini-2.5-pro");
    assert_eq!(chat["max_completion_tokens"], 64);

    let responses = build_v3_openai_responses_standard_request_from_chat_canonical(&canonical)
        .expect("standard Responses builder must consume Gemini canonical");
    println!("[gemini-canonical][responses] wire={responses}");
    assert_eq!(responses["input"][0]["role"], "user");
    assert_eq!(responses["input"][0]["content"][0]["text"], "hello");

    // Gemini entry 曾在 Anthropic 出站被本地拒绝；归一化后必须复用标准 Anthropic
    // projection，不再因 entry protocol 产生成对 converter 或本地 502。
    let anthropic_entry = build_v3_anthropic_provider_request_source_from_chat_canonical(
        &canonical,
        V3HubEntryProtocol::Gemini,
    )
    .expect("Gemini entry Anthropic projection must not reject canonical Chat messages");
    println!("[gemini-canonical][anthropic_entry] wire={anthropic_entry}");
    assert_eq!(anthropic_entry["messages"][0]["role"], "user");
    assert_eq!(canonical_text(&anthropic_entry["messages"][0]["content"]), "hello");
    assert!(anthropic_entry["tools"].as_array().is_some());

    let anthropic = crate::hub_v1::encode_v3_responses_semantic_as_anthropic_request(canonical)
        .expect("standard Anthropic builder must consume Gemini canonical");
    println!("[gemini-canonical][anthropic] wire={anthropic}");
    assert_eq!(anthropic["messages"][0]["role"], "user");
    assert_eq!(anthropic["messages"][0]["content"][0]["text"], "hello");
    assert_eq!(anthropic["tools"][0]["name"], "lookup");
}

#[test]
fn gemini_openai_chat_singleton_plain_text_consumes_part_carrier_without_folding() {
    let canonical = gemini_canonical(&json!({
        "contents": [{"role": "user", "parts": [{"text": "hello"}]}]
    }));
    assert!(
        canonical["messages"][0]["content"][0]
            .pointer("/routecodex_chat_extension/gemini_native_fields")
            .is_some(),
        "test precondition: canonical text part must carry Gemini source association"
    );

    let chat = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("standard OpenAI Chat builder must consume the Gemini text association");
    println!("[gemini-canonical][openai_chat][singleton-array] wire={chat}");

    assert_eq!(chat["messages"][0]["content"], json!([{"type":"text","text":"hello"}]));
    assert!(
        !chat.to_string().contains("gemini_native_fields"),
        "Gemini source association must not leak to provider Chat wire: {chat}"
    );
}

#[test]
fn gemini_openai_chat_part_carrier_consumption_preserves_residuals_and_other_extensions() {
    let mut canonical = gemini_canonical(&json!({
        "contents": [{
            "role": "model",
            "parts": [{"text": "thinking out loud", "thought": true, "thoughtSignature": "sig-1"}]
        }]
    }));
    canonical["messages"][0]["content"][0]["routecodex_chat_extension"]["custom_member"] =
        json!({"keep": true});

    let chat = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("standard OpenAI Chat builder must consume only the known Gemini carrier");
    println!("[gemini-canonical][openai_chat][residual] wire={chat}");
    let part = &chat["messages"][0]["content"][0];

    assert_eq!(part["type"], "text");
    assert_eq!(part["text"], "thinking out loud");
    assert_eq!(part["thought"], true);
    assert_eq!(part["thoughtSignature"], "sig-1");
    assert_eq!(part["routecodex_chat_extension"]["custom_member"], json!({"keep": true}));
    assert!(
        part.pointer("/routecodex_chat_extension/gemini_native_fields")
            .is_none(),
        "known Gemini carrier must be consumed from the content part: {part}"
    );
    assert!(
        !chat.to_string().contains("gemini_native_fields"),
        "internal bindings and source positions must not leak to provider Chat wire: {chat}"
    );
}

#[test]
fn gemini_openai_chat_multiple_and_media_parts_remain_ordered_arrays() {
    let canonical = gemini_canonical(&json!({
        "contents": [{
            "role": "user",
            "parts": [
                {"text": "first", "thought": true},
                {"text": "second"},
                {"inlineData": {
                    "mimeType": "image/png",
                    "data": "iVBORw0KGgo=",
                    "mediaMetadata": {"keep": 1}
                }}
            ]
        }]
    }));

    let chat = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("standard OpenAI Chat builder must preserve multi-part Gemini content");
    println!("[gemini-canonical][openai_chat][multiple] wire={chat}");
    let parts = chat["messages"][0]["content"]
        .as_array()
        .expect("multiple Gemini parts must remain an ordered array");

    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0]["text"], "first");
    assert_eq!(parts[0]["thought"], true);
    assert_eq!(parts[1]["text"], "second");
    assert_eq!(parts[2]["type"], "image_url");
    assert_eq!(
        parts[2]["inlineData"],
        json!({"mediaMetadata": {"keep": 1}})
    );
    assert!(
        !chat.to_string().contains("gemini_native_fields"),
        "Gemini source associations must not leak from any part: {chat}"
    );
}

#[test]
fn responses_origin_content_arrays_without_gemini_carrier_remain_arrays() {
    let canonical = json!({
        "model": "gpt-test",
        "messages": [{
            "role": "user",
            "content": [{"type": "input_text", "text": "hello"}]
        }]
    });

    let chat = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("standard OpenAI Chat builder must preserve Responses-origin arrays");
    println!("[gemini-canonical][openai_chat][responses-array] wire={chat}");

    assert_eq!(
        chat["messages"][0]["content"],
        json!([{"type": "text", "text": "hello"}])
    );
}

#[test]
fn gemini_function_response_media_reaches_chat_tool_history_and_followup_user_message() {
    let source = json!({
        "contents": [
            {"role": "user", "parts": [{"text": "describe the frame"}]},
            {"role": "model", "parts": [{"functionCall": {"id": "call_462432", "name": "view_file", "args": {"AbsolutePath": "/path/to/frame.jpg"}}}]},
            {"role": "user", "parts": [{"functionResponse": {"id": "call_462432", "name": "view_file", "response": {"output": "entire content"}, "parts": [{"inlineData": {"mimeType": "image/jpeg", "data": "/9j/4AAQSkZJRgABAQ"}}]}}]}
        ]
    });
    let canonical = gemini_canonical(&source);
    println!("[gemini-canonical][media] canonical={canonical}");
    let prompt_parts = canonical["messages"][0]["content"]
        .as_array()
        .expect("mapped native text parts must stay an ordered canonical array");
    assert_eq!(prompt_parts.len(), 1);
    assert_eq!(prompt_parts[0]["text"], "describe the frame");
    assert_eq!(canonical["messages"][1]["tool_calls"][0]["id"], "call_462432");
    assert_eq!(canonical["messages"][1]["tool_calls"][0]["function"]["name"], "view_file");
    let canonical_tool_content = canonical["messages"][2]["content"]
        .as_array()
        .expect("functionResponse with media must stay an ordered part array");
    assert_eq!(canonical_tool_content[0]["type"], "text");
    assert_eq!(canonical_tool_content[1]["type"], "image_url");
    assert_eq!(
        canonical_tool_content[1]["image_url"]["url"],
        "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ"
    );

    let chat = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("standard OpenAI Chat builder must consume Gemini canonical tool history");
    println!("[gemini-canonical][media][openai_chat] wire={chat}");
    let chat_messages = chat["messages"].as_array().expect("Chat wire messages");
    let tool_message = chat_messages
        .iter()
        .find(|message| message["role"] == "tool")
        .expect("tool result must survive canonicalization");
    assert_eq!(tool_message["tool_call_id"], "call_462432");
    // Chat tool 结果只承载文本；代表媒体移入紧随其后的 user 消息，不丢失位置。
    assert_eq!(tool_message["content"], r#"{"output":"entire content"}"#);
    let followup = chat_messages
        .last()
        .expect("media tool result must be followed by a user message");
    assert_eq!(followup["role"], "user");
    assert_eq!(followup["content"][0]["type"], "image_url");
    assert_eq!(
        followup["content"][0]["image_url"]["url"],
        "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ"
    );

    let responses = build_v3_openai_responses_standard_request_from_chat_canonical(&canonical)
        .expect("standard Responses builder must consume Gemini canonical tool history");
    println!("[gemini-canonical][media][responses] wire={responses}");
    let responses_input = responses["input"].as_array().expect("Responses input");
    assert!(responses_input
        .iter()
        .any(|item| item["type"] == "function_call" && item["name"] == "view_file"));
    assert!(responses_input
        .iter()
        .any(|item| item["type"] == "function_call_output" && item["call_id"] == "call_462432"));
}

#[test]
fn gemini_pdf_inline_data_maps_to_canonical_file_part_without_fabricated_media() {
    let source = json!({
        "contents": [{
            "role": "user",
            "parts": [{"inlineData": {"mimeType": "application/pdf", "data": "UERG"}}]
        }]
    });
    let canonical = gemini_canonical(&source);
    println!("[gemini-canonical][pdf] canonical={canonical}");
    let parts = canonical["messages"][0]["content"]
        .as_array()
        .expect("PDF inlineData must become an ordered canonical part array");
    assert_eq!(
        parts[0]["type"],
        "file",
        "PDF inlineData must map to the agreed canonical File part"
    );
    assert_eq!(
        parts[0]["file"],
        json!({"file_data":"data:application/pdf;base64,UERG"}),
        "PDF bytes and MIME must survive as the agreed canonical File part"
    );
    assert!(
        parts[0]["routecodex_chat_extension"]["gemini_native_fields"][0]["bindings"]
            .as_array()
            .is_some_and(|bindings| !bindings.is_empty()),
        "the mapped File part must keep its explicit native source association"
    );
    assert!(
        parts[0].get("filename").is_none()
            && parts[0].pointer("/file/file_id").is_none()
            && parts[0].get("signature").is_none()
            && parts[0].get("mediaDescription").is_none(),
        "no source-absent media fields may be fabricated: {parts:?}"
    );
}

#[test]
fn gemini_function_response_nested_pdf_png_and_jpeg_preserve_order_pairs_and_args() {
    let source = json!({
        "contents": [
            {"role": "user", "parts": [{"text": "inspect both attachments"}]},
            {"role": "model", "parts": [{"functionCall": {"id": "c1", "name": "read", "args": {"AbsolutePath": "/tmp/a.pdf", "pages": [1, 2]}}}]},
            {"role": "user", "parts": [{"functionResponse": {
                "id": "c1",
                "name": "read",
                "response": {"output": "page one"},
                "parts": [
                    {"inlineData": {"mimeType": "application/pdf", "data": "UERG"}},
                    {"fileData": {"mimeType": "image/png", "fileUri": "https://x/y.png"}},
                    {"inlineData": {"mimeType": "image/jpeg", "data": "/9j/4AAQSkZJRgABAQ"}}
                ]
            }}]}
        ]
    });
    let canonical = gemini_canonical(&source);
    println!("[gemini-canonical][nested-media] canonical={canonical}");
    let prompt_parts = canonical["messages"][0]["content"]
        .as_array()
        .expect("mapped native text parts must stay an ordered canonical array");
    assert_eq!(prompt_parts.len(), 1);
    assert_eq!(prompt_parts[0]["text"], "inspect both attachments");
    assert_eq!(canonical["messages"][1]["tool_calls"][0]["id"], "c1");
    assert_eq!(canonical["messages"][1]["tool_calls"][0]["function"]["name"], "read");
    let args = canonical["messages"][1]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .expect("functionCall args must remain the complete serialized JSON");
    assert!(args.contains("\"AbsolutePath\":\"/tmp/a.pdf\""), "full args lost: {args}");
    assert!(args.contains("\"pages\":[1,2]"), "full args lost: {args}");
    assert_eq!(canonical["messages"][2]["role"], "tool");
    assert_eq!(canonical["messages"][2]["tool_call_id"], "c1");
    let parts = canonical["messages"][2]["content"]
        .as_array()
        .expect("nested functionResponse parts must stay an ordered part array");
    // response 文本与 nested media 保持 native 顺序；每个 mapped part 携带自己的
    // source association record（nested_part_index 指向原 functionResponse.parts[]）。
    assert_eq!(parts.len(), 4, "result text + 3 nested media parts must keep order: {parts:?}");
    assert_eq!(parts[0]["type"], "text");
    assert_eq!(parts[0]["text"], "{\"output\":\"page one\"}");
    assert_eq!(parts[1]["type"], "file");
    assert_eq!(parts[1]["file"]["file_data"], "data:application/pdf;base64,UERG");
    assert_eq!(parts[2]["type"], "image_url");
    assert_eq!(parts[2]["image_url"]["url"], "https://x/y.png");
    assert_eq!(parts[3]["type"], "image_url");
    assert_eq!(parts[3]["image_url"]["url"], "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ");
    for (index, expected_nested) in [(1usize, 0i32), (2, 1), (3, 2)] {
        assert_eq!(
            parts[index]["routecodex_chat_extension"]["gemini_native_fields"][0]["nested_part_index"],
            json!(expected_nested),
            "nested media part {index} must keep its original nested_part_index"
        );
    }
}

#[test]
fn gemini_generation_config_unrepresentable_fields_are_preserved_in_registered_extension() {
    let source = json!({
        "contents": [{"role": "user", "parts": [{"text": "draw"}]}],
        "generationConfig": {
            "temperature": 0.2,
            "candidateCount": 2,
            "mediaResolution": "MEDIA_RESOLUTION_HIGH",
            "imageConfig": {"aspectRatio": "16:9"},
            "responseMimeType": "application/json",
            "responseSchema": {"type": "object"},
            "responseModalities": ["TEXT"],
            "responseFormat": {
                "text": {"mimeType": "text/plain"},
                "image": {"mimeType": "image/png"},
                "audio": {"mimeType": "audio/mp3"}
            },
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Puck"}}}
        }
    });
    let canonical = gemini_canonical(&source);
    println!("[gemini-canonical][generation-config] canonical={canonical}");
    assert_eq!(canonical["temperature"], 0.2, "declared scalar mapping must stay");
    let extension = canonical.get("generation").expect(
        "unrepresentable generationConfig fields must be preserved in the registered generation extension",
    );
    assert_eq!(extension["candidateCount"], 2);
    assert_eq!(extension["mediaResolution"], "MEDIA_RESOLUTION_HIGH");
    assert_eq!(extension["imageConfig"], json!({"aspectRatio": "16:9"}));
    assert_eq!(extension["responseMimeType"], "application/json");
    assert_eq!(extension["responseSchema"], json!({"type": "object"}));
    assert_eq!(extension["responseModalities"], json!(["TEXT"]));
    assert_eq!(
        extension["responseFormat"],
        json!({
            "text": {"mimeType": "text/plain"},
            "image": {"mimeType": "image/png"},
            "audio": {"mimeType": "audio/mp3"}
        })
    );
    assert_eq!(
        extension["speechConfig"],
        json!({"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Puck"}}})
    );
    assert!(
        extension.get("temperature").is_none()
            && extension.get("maxOutputTokens").is_none()
            && extension.get("thinkingConfig").is_none(),
        "fully represented generation fields must not be duplicated in the extension: {extension}"
    );
}

#[test]
fn gemini_thinking_config_maps_to_consumed_canonical_reasoning_fields() {
    let source = json!({
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "generationConfig": {
            "maxOutputTokens": 8192,
            "thinkingConfig": {
                "includeThoughts": true,
                "thinkingBudget": 4096,
                "thinkingLevel": "HIGH"
            }
        }
    });
    let canonical = gemini_canonical(&source);
    println!("[gemini-canonical][thinking] canonical={canonical}");
    assert_eq!(canonical["max_completion_tokens"], 8192);
    assert_eq!(canonical["reasoning_include_thoughts"], true);
    assert_eq!(canonical["reasoning_budget_tokens"], 4096);
    assert_eq!(canonical["reasoning_thinking_mode"], "enabled");
    // thinkingLevel 归一化为 `reasoning_effort`：这是三个 standard builder 真实
    // 消费的 canonical 字段；不得写入无 consumer 的 `reasoning_level`。
    assert_eq!(canonical["reasoning_effort"], "high");
    assert!(
        canonical.get("reasoning_level").is_none(),
        "reasoning_level has no standard outbound consumer: {canonical}"
    );

    let chat = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("standard OpenAI Chat builder must consume Gemini thinking canonical");
    println!("[gemini-canonical][thinking][openai_chat] wire={chat}");
    assert_eq!(chat["reasoning_effort"], "high");

    let responses = build_v3_openai_responses_standard_request_from_chat_canonical(&canonical)
        .expect("standard Responses builder must consume Gemini thinking canonical");
    println!("[gemini-canonical][thinking][responses] wire={responses}");
    assert_eq!(responses["reasoning"]["effort"], "high");
    assert!(
        responses["reasoning"].get("budget_tokens").is_none(),
        "numeric budget has no Responses consumer and must drop: {responses}"
    );

    let anthropic = crate::hub_v1::encode_v3_responses_semantic_as_anthropic_request(canonical)
        .expect("standard Anthropic builder must consume Gemini thinking canonical");
    println!("[gemini-canonical][thinking][anthropic] wire={anthropic}");
    assert_eq!(anthropic["output_config"]["effort"], "high");
}

// ---------------------------------------------------------------------------
// 新增 RED -> GREEN：未知 part/MIME、known part siblings、no-id 工具结果、
// generation mapped/residual 互补。
// ---------------------------------------------------------------------------

#[test]
fn gemini_unknown_part_and_unregistered_inline_mime_are_preserved_without_refusal() {
    let source = json!({
        "contents": [{
            "role": "user",
            "parts": [
                {"text": "before"},
                {"executableCode": {"language": "PYTHON", "code": "print(1)"}},
                {"inlineData": {"mimeType": "application/octet-stream", "data": "AAEC"}},
                {"after_unknown": {"nested": [1, 2]}}
            ]
        }]
    });
    // 旧实现会对未登记 part/MIME 返回 missing-registration Err；现在必须成功归一化。
    let canonical = gemini_canonical(&source);
    println!("[gemini-canonical][unknown] canonical={canonical}");
    let mapped_parts = canonical["messages"][0]["content"]
        .as_array()
        .expect("the single mapped text part must stay an ordered canonical array");
    assert_eq!(mapped_parts.len(), 1);
    assert_eq!(mapped_parts[0]["text"], "before");
    let records = canonical["messages"][0]["routecodex_chat_extension"]["gemini_native_fields"]
        .as_array()
        .expect("unknown native parts must be preserved as structured extension records");
    // records[0] 是 content 容器 record（content_index + role_present，无 part_index）；
    // 之后的 opaque part records 才带 part_index。
    assert_eq!(records[0]["content_index"], 0);
    assert_eq!(records[0]["role_present"], true);
    assert!(
        records[0].get("part_index").is_none(),
        "container record must not fake a part_index"
    );
    let part_records: Vec<&serde_json::Value> = records
        .iter()
        .filter(|record| record.get("part_index").is_some())
        .collect();
    assert_eq!(part_records.len(), 3, "three unmapped native parts stay as records");
    assert_eq!(part_records[0]["part_index"], 1);
    assert_eq!(
        part_records[0]["fields"]["executableCode"],
        json!({"language": "PYTHON", "code": "print(1)"})
    );
    assert_eq!(part_records[1]["part_index"], 2);
    assert_eq!(
        part_records[1]["fields"]["inlineData"],
        json!({"mimeType": "application/octet-stream", "data": "AAEC"})
    );
    assert_eq!(part_records[2]["part_index"], 3);
    assert_eq!(part_records[2]["fields"]["after_unknown"], json!({"nested": [1, 2]}));
    // 未知 part 不得被合成为 opaque 文本。
    assert!(
        !canonical.to_string().contains("\"text\":\"{"),
        "unknown native part must not be serialized as opaque text: {canonical}"
    );
}

#[test]
fn gemini_known_part_siblings_are_preserved_in_native_extension_records() {
    let source = json!({
        "contents": [{
            "role": "model",
            "parts": [
                {"text": "thinking out loud", "thought": true, "thoughtSignature": "sig-1"},
                {"functionCall": {"id": "c1", "name": "lookup", "args": {"city": "Tokyo"}, "partMetadata": {"k": "v"}}}
            ]
        }]
    });
    let canonical = gemini_canonical(&source);
    println!("[gemini-canonical][sibling] canonical={canonical}");
    let message = &canonical["messages"][0];
    assert_eq!(message["role"], "assistant");
    let content_parts = message["content"]
        .as_array()
        .expect("mapped native text part must stay an ordered canonical array");
    assert_eq!(content_parts.len(), 1);
    assert_eq!(content_parts[0]["text"], "thinking out loud");
    assert_eq!(message["tool_calls"][0]["id"], "c1");
    assert_eq!(message["tool_calls"][0]["function"]["name"], "lookup");
    // mapped record 附着在其 canonical 对象上：text part 的 record 挂在 content[0]，
    // functionCall 的 record 挂在 tool_calls[0]；message 级只留 content 容器 record。
    let text_record = &content_parts[0]["routecodex_chat_extension"]["gemini_native_fields"][0];
    assert_eq!(text_record["part_index"], 0);
    assert_eq!(
        text_record["fields"],
        json!({"thought": true, "thoughtSignature": "sig-1"})
    );
    let call_record =
        &message["tool_calls"][0]["routecodex_chat_extension"]["gemini_native_fields"][0];
    assert_eq!(call_record["part_index"], 1);
    assert_eq!(
        call_record["fields"],
        json!({"functionCall": {"partMetadata": {"k": "v"}}})
    );
}

#[test]
fn gemini_function_response_without_id_keeps_missing_id_without_role_user_repair() {
    let source = json!({
        "contents": [{
            "role": "user",
            "parts": [{"functionResponse": {"name": "lookup", "response": {"forecast": "sunny"}}}]
        }]
    });
    let canonical = gemini_canonical(&source);
    println!("[gemini-canonical][no-id] canonical={canonical}");
    let message = &canonical["messages"][0];
    assert_eq!(
        message["role"], "tool",
        "no-id functionResponse must not be repaired to user role"
    );
    assert!(
        message.get("tool_call_id").is_none(),
        "missing native id must remain missing, never fabricated"
    );
    // 单一 response part 保持常见字符串形状，且值类型由完整 JSON 文本保留。
    assert_eq!(message["content"], "{\"forecast\":\"sunny\"}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            message["content"].as_str().expect("json text content")
        )
        .expect("valid JSON text"),
        json!({"forecast": "sunny"}),
        "the single response must stay a JSON object, not a bare string"
    );
    let records = message["routecodex_chat_extension"]["gemini_native_fields"]
        .as_array()
        .expect("no-id functionResponse must keep explicit source association");
    assert_eq!(
        records[0]["fields"]["functionResponse"],
        json!({"name": "lookup"})
    );
    assert!(
        !canonical.to_string().contains("gemini_function_response_name"),
        "no-id functionResponse must not be repaired via a name carrier: {canonical}"
    );
}

#[test]
fn gemini_generation_residual_is_complement_of_mapped_scalars() {
    let source = json!({
        "contents": [{"role": "user", "parts": [{"text": "go"}]}],
        "generationConfig": {
            "temperature": 0.5,
            "topP": 0.9,
            "seed": 7,
            "candidateCount": 3,
            "responseMimeType": "text/plain",
            "thinkingConfig": {"thinkingBudget": 2048, "thinkingLevel": "LOW", "customFlag": true}
        }
    });
    let canonical = gemini_canonical(&source);
    println!("[gemini-canonical][generation-complement] canonical={canonical}");
    assert_eq!(canonical["temperature"], 0.5);
    assert_eq!(canonical["top_p"], 0.9);
    assert_eq!(canonical["seed"], 7);
    assert_eq!(canonical["reasoning_budget_tokens"], 2048);
    assert_eq!(canonical["reasoning_effort"], "low");
    let generation = canonical
        .get("generation")
        .expect("unmapped generation members must be retained");
    assert_eq!(generation["candidateCount"], 3);
    assert_eq!(generation["responseMimeType"], "text/plain");
    // mapped scalar 与 thinkingConfig 已映射子字段不重复；未映射 sibling 保留。
    assert!(generation.get("temperature").is_none());
    assert!(generation.get("topP").is_none());
    assert!(generation.get("seed").is_none());
    assert_eq!(generation["thinkingConfig"], json!({"customFlag": true}));
}

// ---------------------------------------------------------------------------
// 冻结 association-plan-r5 P1 反例：两个 distinct native 输入不得碰撞成同一个
// canonical 输出。RED 必须经真实 public builder 触发。
// ---------------------------------------------------------------------------

#[test]
fn gemini_native_text_boundaries_do_not_collide() {
    let executable_code = json!({"language": "PYTHON", "code": "print(1)"});
    let input_a = json!({
        "contents": [{
            "role": "user",
            "parts": [
                {"text": "ab"},
                {"executableCode": executable_code.clone()},
                {"text": "c"}
            ]
        }]
    });
    let input_b = json!({
        "contents": [{
            "role": "user",
            "parts": [
                {"text": "a"},
                {"executableCode": executable_code.clone()},
                {"text": "bc"}
            ]
        }]
    });
    let canonical_a = gemini_canonical(&input_a);
    let canonical_b = gemini_canonical(&input_b);
    println!("[gemini-collision][text][A] canonical={canonical_a}");
    println!("[gemini-collision][text][B] canonical={canonical_b}");
    assert_ne!(
        canonical_a, canonical_b,
        "native text boundaries must not collapse into one canonical value"
    );
    let parts_a = canonical_a["messages"][0]["content"]
        .as_array()
        .expect("mapped native text parts must stay separate canonical objects");
    assert_eq!(parts_a.len(), 2, "text boundaries lost: {parts_a:?}");
    assert_eq!(parts_a[0]["text"], "ab");
    assert_eq!(parts_a[1]["text"], "c");
    assert_eq!(
        parts_a[0]["routecodex_chat_extension"]["gemini_native_fields"][0]["part_index"], 0,
        "the first mapped text part must keep its source part_index"
    );
    assert_eq!(
        parts_a[1]["routecodex_chat_extension"]["gemini_native_fields"][0]["part_index"], 2,
        "the second mapped text part must keep its source part_index"
    );
    let parts_b = canonical_b["messages"][0]["content"]
        .as_array()
        .expect("mapped native text parts must stay separate canonical objects");
    assert_eq!(parts_b.len(), 2);
    assert_eq!(parts_b[0]["text"], "a");
    assert_eq!(parts_b[1]["text"], "bc");
    // 未映射 opaque part 以原 source coordinates 留在所属 message carrier。
    let records_a = canonical_a["messages"][0]["routecodex_chat_extension"]
        ["gemini_native_fields"]
        .as_array()
        .expect("opaque native part must keep a source-associated record");
    assert!(
        records_a.iter().any(|record| {
            record["part_index"] == 1 && record["fields"]["executableCode"] == executable_code
        }),
        "opaque executableCode must stay associated at part_index 1: {records_a:?}"
    );
}

#[test]
fn gemini_native_args_json_value_types_do_not_collide() {
    let string_args = gemini_canonical(&json!({
        "contents": [{
            "role": "model",
            "parts": [{"functionCall": {"name": "f", "args": "1"}}]
        }]
    }));
    let number_args = gemini_canonical(&json!({
        "contents": [{
            "role": "model",
            "parts": [{"functionCall": {"name": "f", "args": 1}}]
        }]
    }));
    println!("[gemini-collision][args][string] canonical={string_args}");
    println!("[gemini-collision][args][number] canonical={number_args}");
    let string_arguments = string_args["messages"][0]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .expect("native string args must become a complete JSON text");
    let number_arguments = number_args["messages"][0]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .expect("native number args must become a complete JSON text");
    assert_ne!(
        string_arguments, number_arguments,
        "native string args and native number args must not collapse to one canonical value"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(string_arguments).expect("valid JSON text"),
        json!("1"),
        "native string args must decode back to a JSON string"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(number_arguments).expect("valid JSON text"),
        json!(1),
        "native number args must decode back to a JSON number"
    );
}

#[test]
fn gemini_native_request_inverse_preserves_associations_and_governed_text() {
    let source = json!({
        "model": "gemini-2.5-pro",
        "contents": [{
            "role": "user",
            "parts": [{
                "text": "before governance",
                "thoughtSignature": "sig-native"
            }]
        }],
        "safetySettings": [{
            "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
            "threshold": "BLOCK_NONE"
        }],
        "cachedContent": "cachedContents/example",
        "tools": [{
            "functionDeclarations": [{
                "name": "lookup",
                "description": "Look up a city",
                "parametersJsonSchema": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}}
                },
                "declarationMetadata": {"strict": true}
            }]
        }],
        "toolConfig": {
            "functionCallingConfig": {
                "mode": "AUTO",
                "allowedFunctionNames": ["lookup"],
                "callingMetadata": {"keep": 1}
            },
            "toolConfigMetadata": {"keep": 2}
        },
        "generationConfig": {
            "temperature": 0.2,
            "topK": 5,
            "candidateCount": 2,
            "generationMetadata": {"keep": 3},
            "thinkingConfig": {
                "thinkingBudget": 0,
                "thinkingMetadata": {"keep": 4}
            }
        }
    });
    let mut canonical = gemini_canonical(&source);
    canonical["messages"][0]["content"][0]["text"] = json!("after governance");

    project_gemini_compatible_fields(&mut canonical)
        .expect("native Gemini inverse must consume canonical associations");
    println!("[gemini-native-roundtrip] wire={canonical}");

    assert_eq!(canonical["contents"][0]["parts"][0]["text"], "after governance");
    assert_eq!(
        canonical["contents"][0]["parts"][0]["thoughtSignature"],
        "sig-native"
    );
    assert_eq!(canonical["safetySettings"], source["safetySettings"]);
    assert_eq!(canonical["cachedContent"], "cachedContents/example");
    assert_eq!(
        canonical["tools"][0]["functionDeclarations"][0]["declarationMetadata"],
        json!({"strict": true})
    );
    assert_eq!(
        canonical["tools"][0]["functionDeclarations"][0]["parametersJsonSchema"],
        source["tools"][0]["functionDeclarations"][0]["parametersJsonSchema"]
    );
    assert_eq!(
        canonical["toolConfig"]["functionCallingConfig"]["mode"],
        "AUTO"
    );
    assert_eq!(
        canonical["toolConfig"]["functionCallingConfig"]["allowedFunctionNames"],
        json!(["lookup"])
    );
    assert_eq!(
        canonical["toolConfig"]["functionCallingConfig"]["callingMetadata"],
        json!({"keep": 1})
    );
    assert_eq!(
        canonical["toolConfig"]["toolConfigMetadata"],
        json!({"keep": 2})
    );
    assert_eq!(canonical["generationConfig"]["temperature"], 0.2);
    assert_eq!(canonical["generationConfig"]["topK"], 5);
    assert_eq!(canonical["generationConfig"]["candidateCount"], 2);
    assert_eq!(
        canonical["generationConfig"]["generationMetadata"],
        json!({"keep": 3})
    );
    assert_eq!(
        canonical["generationConfig"]["thinkingConfig"]["thinkingBudget"],
        0
    );
    assert_eq!(
        canonical["generationConfig"]["thinkingConfig"]["thinkingMetadata"],
        json!({"keep": 4})
    );
    assert!(
        !canonical.to_string().contains("routecodex_chat_extension"),
        "associations must be consumed instead of copied to the provider wire: {canonical}"
    );
}
