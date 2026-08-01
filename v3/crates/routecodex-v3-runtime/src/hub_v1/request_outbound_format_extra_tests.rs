use super::*;

#[test]
fn responses_openai_chat_field_parity_responses_wire_projects_fc_item_ids() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [
            {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_6b0251fee24f41b2b045b04e",
                    "type": "function",
                    "function": {"name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"}
                }]
            },
            {"role": "tool", "tool_call_id": "call_6b0251fee24f41b2b045b04e", "content": "ok"}
        ]
    });
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projection must succeed");
    let input = request["input"]
        .as_array()
        .expect("Responses wire input array");
    assert_eq!(input[0]["call_id"], "call_6b0251fee24f41b2b045b04e");
    let item_id = input[0]["id"].as_str().expect("function_call id");
    assert!(item_id.starts_with("fc_6b0251fee24f41b2b045b04e_"));
    assert!(item_id.len() <= 64);
    assert_eq!(input[1]["call_id"], input[0]["call_id"]);
    assert_eq!(input[1]["id"], input[0]["id"]);
}

#[test]
fn responses_openai_chat_field_parity_responses_wire_generates_collision_resistant_fc_ids() {
    let repeated_prefix = "call_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv";
    let payload = json!({
        "model": "gpt-test",
        "messages": [{
            "role": "assistant",
            "content": null,
            "tool_calls": [
                {"id": format!("{repeated_prefix}_left"), "type": "function", "function": {"name": "exec_command", "arguments": "{}"}},
                {"id": format!("{repeated_prefix}_right"), "type": "function", "function": {"name": "exec_command", "arguments": "{}"}}
            ]
        }]
    });
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projection must succeed");
    let input = request["input"]
        .as_array()
        .expect("Responses wire input array");
    assert_ne!(input[0]["id"], input[1]["id"]);
    for item in input {
        assert!(item["id"].as_str().unwrap().starts_with("fc_"));
        assert!(item["id"].as_str().unwrap().len() <= 64);
    }
}

#[test]
fn responses_openai_chat_field_parity_responses_wire_hashes_sanitized_collisions() {
    let tool_calls = [
        "call_same/value",
        "call_same:value",
        "call_same",
        "fc_same",
        "functions.same",
    ]
    .into_iter()
    .map(|id| {
        json!({"id": id, "type": "function", "function": {"name": "exec_command", "arguments": "{}"}})
    })
    .collect::<Vec<_>>();
    let payload = json!({
        "model": "gpt-test",
        "messages": [{
            "role": "assistant",
            "content": null,
            "tool_calls": tool_calls
        }]
    });
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projection must succeed");
    let input = request["input"]
        .as_array()
        .expect("Responses wire input array");
    let ids = input
        .iter()
        .map(|item| item["id"].as_str().expect("Responses item id"))
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        ids.len(),
        input.len(),
        "Responses fc_* item ids collided: {input:?}"
    );
    for item in input {
        assert!(item["id"].as_str().unwrap().starts_with("fc_same"));
    }
}

#[test]
fn responses_wire_reuses_chat_extension_responses_item_id() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call_original",
                    "type": "function",
                    "function": {"name":"lookup", "arguments":"{\"q\":\"x\"}"},
                    "routecodex_chat_extension": {"responses_item_id":"fc_original"}
                }]
            },
            {
                "role": "tool",
                "tool_call_id": "call_original",
                "content": "ok",
                "routecodex_chat_extension": {"responses_item_id":"fc_original"}
            }
        ]
    });

    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projection must preserve adjacent codec item id");
    let input = request["input"].as_array().expect("Responses input array");

    assert_eq!(input[0]["type"], "function_call");
    assert_eq!(input[0]["id"], "fc_original");
    assert_eq!(input[0]["call_id"], "call_original");
    assert_eq!(input[1]["type"], "function_call_output");
    assert_eq!(input[1]["id"], "fc_original");
    assert_eq!(input[1]["call_id"], "call_original");
}

#[test]
fn responses_openai_chat_field_parity_include_is_rejected_from_chat_wire() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "include": ["reasoning.encrypted_content"]
    });

    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("OpenAI Chat wire projection must reject unmapped Responses include");

    assert!(error.contains("UnmappedOutboundFields"), "{error}");
    assert!(error.contains("target_protocol=openai_chat"), "{error}");
    assert!(error.contains("$.include"), "{error}");
}

#[test]
fn outbound_projection_rejects_control_fields_with_precise_path() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": [{"type":"text", "text":"hello", "_debug": true}]}],
        "metadata_center": {"route": "internal"}
    });

    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("control fields must fail before provider send");

    assert!(error.contains("ControlFieldLeak"), "{error}");
    assert!(error.contains("$.metadata_center"), "{error}");
    assert!(error.contains("$.messages[0].content[0]._debug"), "{error}");
}

#[test]
fn outbound_projection_rejects_client_metadata_before_provider_capture() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "client_metadata": {"session_id":"client-owned"}
    });

    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("client_metadata has no OpenAI Chat provider-wire equivalent");

    assert!(error.contains("UnmappedOutboundFields"), "{error}");
    assert!(error.contains("$.client_metadata"), "{error}");
}

#[test]
fn openai_chat_wire_consumes_routecodex_chat_extension_before_provider_send() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call_custom",
                    "type": "function",
                    "function": {"name":"exec_command", "arguments":"{}"},
                    "routecodex_chat_extension": {"responses_tool_call_type":"custom_tool_call"}
                }]
            },
            {
                "role": "tool",
                "tool_call_id": "call_custom",
                "content": "ok",
                "routecodex_chat_extension": {"responses_tool_output_type":"custom_tool_call_output"}
            }
        ]
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("OpenAI Chat wire projection must consume internal chat extension");

    let serialized = request.to_string();
    assert!(
        !serialized.contains("routecodex_chat_extension"),
        "{serialized}"
    );
    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["arguments"],
        "{}"
    );
    assert_eq!(request["messages"][1]["tool_call_id"], "call_custom");
}

#[test]
fn outbound_projection_allows_payload_owned_underscore_fields() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "tools": [{
            "type": "function",
            "function": {
                "name":"lookup",
                "parameters": {
                    "type":"object",
                    "properties": {"_id": {"type":"string"}}
                }
            }
        }],
        "metadata": {"_tenant":"client-owned"}
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("payload-owned underscore fields are not RouteCodex control fields");

    assert_eq!(
        request["tools"][0]["function"]["parameters"]["properties"]["_id"]["type"],
        "string"
    );
    assert_eq!(request["metadata"]["_tenant"], "client-owned");
}

#[test]
fn openai_chat_wire_preserves_same_protocol_request_fields() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "audio": {"format":"wav", "voice":"alloy"},
        "modalities": ["text", "audio"],
        "prediction": {"type":"content", "content":"expected"},
        "prompt_cache_key": "cache-key",
        "prompt_cache_options": {"ttl":"24h"},
        "prompt_cache_retention": "24h",
        "service_tier": "priority",
        "store": false,
        "web_search_options": {"search_context_size":"low"}
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("same-protocol Chat fields must reach provider wire unchanged");

    for key in [
        "audio",
        "modalities",
        "prediction",
        "prompt_cache_key",
        "prompt_cache_options",
        "prompt_cache_retention",
        "service_tier",
        "store",
        "web_search_options",
    ] {
        assert_eq!(request[key], payload[key], "field {key} drifted");
    }
}
