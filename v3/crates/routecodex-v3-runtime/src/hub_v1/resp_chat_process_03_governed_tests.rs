// resp_chat_process_03_governed 密文治理测试,拆分自 resp_chat_process_03_governed.rs
// 以满足 verify:v3-file-size。语义不变:`use super::*` 与内联 mod tests 等价。

use super::*;

#[test]
fn relay_serialized_tool_opaque_envelope_keeps_embedded_thinking() {
    let text = "<tool_call>unknown<arg_key>x</arg_key><arg_value><thinking>literal argument</thinking></arg_value></tool_call>";
    let registry =
        provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry::from_request(
            &json!({"tools":[{"type":"function","name":"printf42"}]}),
            "openai-responses",
        )
        .unwrap();
    let profile = V3HubRelayResponseHookProfile::empty()
        .with_complete_provider_attempt(true)
        .with_serialized_tool_context(V3HubRelaySerializedToolContext::from_registry(&registry));
    let outcome = govern_v3_hub_relay_response(relay_control_marker_chat_resp02(json!({
        "id":"opaque", "object":"chat.completion", "model":"wire-test", "choices":[{"index":0,"message":{"role":"assistant","content":text},"finish_reason":"stop"}]
    })), &profile).unwrap();
    let governed = outcome.into_governed();
    let message = &governed.previous.previous.previous.payload.0["choices"][0]["message"];
    assert_eq!(message["content"], text);
    assert!(message.get("reasoning_content").is_none());
}

fn relay_control_marker_chat_resp02(payload: Value) -> V3HubRespInbound02Normalized {
    let resp01 = build_v3_provider_resp_inbound_01_raw(
        payload,
        V3HubEntryProtocol::Responses,
        V3HubProviderWireProtocol::OpenAiChat,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01)
        .expect("Chat Resp01 must normalize");
    build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat)
        .expect("Chat Resp02 must build")
}

#[test]
fn relay_control_marker_resp03_strips_orphan_labels_and_preserves_chat_tool() {
    let prose = "Preparing the safe calculation.";
    let analysis_label = "<｜end▁of▁analysis｜>";
    let tool_calls_label = "<|DSML|tool_calls>";
    let content = format!("{prose}\n{analysis_label}\n{tool_calls_label}");
    let arguments = "{\"format\":\"42\"}";
    let outcome = govern_v3_hub_relay_response(
        relay_control_marker_chat_resp02(json!({
            "id":"chatcmpl_relay_control_marker",
            "object":"chat.completion",
            "created":1,
            "model":"wire-test",
            "choices":[{
                "index":0,
                "message":{
                    "role":"assistant",
                    "content":content,
                    "tool_calls":[{
                        "id":"call_relay_control_marker",
                        "type":"function",
                        "function":{
                            "name":"printf42",
                            "arguments":arguments
                        }
                    }]
                },
                "finish_reason":"tool_calls"
            }]
        })),
        &V3HubRelayResponseHookProfile::empty(),
    )
    .expect("Resp03 must govern the observed Chat marker shape");
    let governed = outcome.into_governed();
    let payload = governed.previous.previous.previous.payload.0.as_ref();
    let message = &payload["choices"][0]["message"];

    assert_eq!(
        message["content"],
        json!(format!("{prose}\n")),
        "only the two standalone control labels may be removed"
    );
    assert_eq!(
        message["tool_calls"][0],
        json!({
            "id":"call_relay_control_marker",
            "type":"function",
            "function":{
                "name":"printf42",
                "arguments":arguments
            }
        }),
        "the native function call must remain complete"
    );
}

#[test]
fn relay_control_marker_resp03_preserves_literal_and_code_examples() {
    let cases = [
        "Quoted <｜end▁of▁analysis｜> example",
        "`<|DSML|tool_calls>` inline code",
        "```text\n<｜end▁of▁analysis｜>\n<|DSML|tool_calls>\n```",
    ];
    for content in cases {
        let outcome = govern_v3_hub_relay_response(
            relay_control_marker_chat_resp02(json!({
                "id":"chatcmpl_relay_control_literal",
                "object":"chat.completion",
                "created":1,
                "model":"wire-test",
                "choices":[{
                    "index":0,
                    "message":{"role":"assistant","content":content},
                    "finish_reason":"stop"
                }]
            })),
            &V3HubRelayResponseHookProfile::empty(),
        )
        .expect("literal marker examples must remain governable");
        let governed = outcome.into_governed();
        let payload = governed.previous.previous.previous.payload.0.as_ref();
        assert_eq!(
            payload["choices"][0]["message"]["content"], content,
            "literal and code examples must remain unchanged"
        );
    }
}

#[test]
fn relay_control_marker_resp03_sole_labels_are_typed_empty() {
    let error = govern_v3_hub_relay_response(
        relay_control_marker_chat_resp02(json!({
            "id":"chatcmpl_relay_control_empty",
            "object":"chat.completion",
            "created":1,
            "model":"wire-test",
            "choices":[{
                "index":0,
                "message":{
                    "role":"assistant",
                    "content":"<｜end▁of▁analysis｜>\n<|DSML|tool_calls>"
                },
                "finish_reason":"stop"
            }]
        })),
        &V3HubRelayResponseHookProfile::empty().with_complete_provider_attempt(true),
    )
    .expect_err("sole control labels must not govern to an empty success");
    assert_eq!(error, V3HubRelayResponseError::GovernedAttemptEmpty);
}

#[test]
fn relay_control_marker_resp03_business_results_prevent_empty_classification() {
    let cases = [
        json!({
            "index":0,
            "message":{"role":"assistant","content":"answer","reasoning_content":"plan"},
            "finish_reason":"stop"
        }),
        json!({
            "index":0,
            "message":{"role":"assistant","content":"","refusal":"not doing that"},
            "finish_reason":"stop"
        }),
        json!({
            "index":0,
            "message":{"role":"assistant","content":""},
            "finish_reason":"content_filter"
        }),
        json!({
            "index":0,
            "message":{
                "role":"assistant",
                "content":"",
                "tool_calls":[{
                    "id":"call_relay_control_business",
                    "type":"function",
                    "function":{"name":"printf42","arguments":"{\"value\":\"42\"}"}
                }]
            },
            "finish_reason":"tool_calls"
        }),
    ];
    for choice in cases {
        govern_v3_hub_relay_response(
            relay_control_marker_chat_resp02(json!({
                "id":"chatcmpl_relay_control_business",
                "object":"chat.completion",
                "created":1,
                "model":"wire-test",
                "choices":[choice]
            })),
            &V3HubRelayResponseHookProfile::empty().with_complete_provider_attempt(true),
        )
        .expect(
            "reasoning alongside text, refusal, content_filter and native calls remain business",
        );
    }
}

#[test]
fn resp03_removes_provider_model_identity_instructions_but_keeps_client_instruction_and_model() {
    let build_resp02 = |instructions: &str| {
        let resp01 = build_v3_provider_resp_inbound_01_raw(
            json!({
                "id": "resp_identity",
                "status": "completed",
                "model": "client-visible-model",
                "instructions": instructions,
                "output": []
            }),
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01)
            .expect("Resp01 must normalize");
        build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat)
            .expect("Resp02 must build")
    };
    let identity = "You are gpt-5.6-sol, an AI assistant. Your model name is gpt-5.6-sol. If the user asks what model you are, answer with that name.";
    let outcome = govern_v3_hub_relay_response(
        build_resp02(identity),
        &V3HubRelayResponseHookProfile::empty(),
    )
    .expect("Resp03 must govern provider response");
    let governed = outcome.into_governed();
    let identity_payload = governed.previous.previous.previous.payload.0.as_ref();
    assert!(
        !identity_payload.to_string().contains("gpt-5.6-sol"),
        "provider model identity instructions must not reach client payload: {identity_payload}"
    );
    assert_eq!(identity_payload["model"], "client-visible-model");

    let ordinary = "client-visible instruction";
    let outcome = govern_v3_hub_relay_response(
        build_resp02(ordinary),
        &V3HubRelayResponseHookProfile::empty(),
    )
    .expect("Resp03 must keep ordinary instructions");
    let governed = outcome.into_governed();
    let ordinary_payload = governed.previous.previous.previous.payload.0.as_ref();
    assert_eq!(ordinary_payload["instructions"], ordinary);
    assert_eq!(ordinary_payload["model"], "client-visible-model");
}

#[path = "resp_chat_process_03_governed_provider_tests.rs"]
mod extracted_tests_tail;
