use super::*;

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
