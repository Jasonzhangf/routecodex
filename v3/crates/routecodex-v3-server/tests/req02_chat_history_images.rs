use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair, V3RequestContextHandle,
};
use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, build_v3_hub_req_inbound_02_from_canonical,
    compile_v3_hub_relay_request_hooks, V3HubEntryProtocol, V3HubInvocationSource,
    V3HubServertoolRequestProfile, V3HubTransportIntent,
};
use serde_json::{json, Value};

struct ProtocolCase {
    name: &'static str,
    protocol: &'static str,
    entry_protocol: V3HubEntryProtocol,
    raw: Value,
}

fn protocol_cases() -> Vec<ProtocolCase> {
    vec![
        ProtocolCase {
            name: "openai_chat",
            protocol: "openai-chat",
            entry_protocol: V3HubEntryProtocol::OpenAiChat,
            raw: json!({
                "model": "chat-model",
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "history"},
                            {
                                "type": "image_url",
                                "image_url": {"url": "data:image/png;base64,AAAA"},
                                "vendor": {"history": true}
                            }
                        ]
                    },
                    {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [
                            {
                                "id": "call_exec",
                                "type": "function",
                                "function": {
                                    "name": "exec_command",
                                    "arguments": "{\"cmd\":\"pwd\"}"
                                }
                            },
                            {
                                "id": "call_patch",
                                "type": "function",
                                "function": {
                                    "name": "apply_patch",
                                    "arguments": "*** Begin Patch\\n*** End Patch"
                                }
                            },
                            {
                                "id": "call_mcp",
                                "type": "function",
                                "function": {
                                    "name": "mcp__demo.lookup",
                                    "arguments": "{\"query\":\"canonical\",\"options\":{\"limit\":1}}"
                                }
                            }
                        ]
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "call_exec",
                        "content": "normal tool result",
                        "vendor": {"keep": "tool"}
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "call_patch",
                        "content": "Done!",
                        "vendor": {"keep": "patch"}
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "call_mcp",
                        "content": "{\"items\":[{\"name\":\"canonical\"}]}",
                        "vendor": {"keep": "mcp"}
                    },
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "current"},
                            {
                                "type": "image_url",
                                "image_url": {"url": "data:image/png;base64,BBBB"},
                                "vendor": {"current": true}
                            }
                        ]
                    }
                ]
            }),
        },
        ProtocolCase {
            name: "responses",
            protocol: "responses",
            entry_protocol: V3HubEntryProtocol::Responses,
            raw: json!({
                "model": "responses-model",
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": "history"},
                            {
                                "type": "input_image",
                                "image_url": "data:image/png;base64,AAAA",
                                "vendor": {"history": true}
                            }
                        ]
                    },
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "ack"}]
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": "current"},
                            {
                                "type": "input_image",
                                "image_url": "data:image/png;base64,BBBB",
                                "vendor": {"current": true}
                            }
                        ]
                    }
                ]
            }),
        },
        ProtocolCase {
            name: "anthropic",
            protocol: "anthropic",
            entry_protocol: V3HubEntryProtocol::Anthropic,
            raw: json!({
                "model": "claude",
                "max_tokens": 64,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "history"},
                            {
                                "type": "image",
                                "source": {
                                    "type": "url",
                                    "url": "https://example.test/history.png"
                                },
                                "vendor": {"history": true}
                            }
                        ]
                    },
                    {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "ack"}]
                    },
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "current"},
                            {
                                "type": "image",
                                "source": {
                                    "type": "url",
                                    "url": "https://example.test/current.png"
                                },
                                "vendor": {"current": true}
                            }
                        ]
                    }
                ]
            }),
        },
        ProtocolCase {
            name: "gemini",
            protocol: "gemini",
            entry_protocol: V3HubEntryProtocol::Gemini,
            raw: json!({
                "model": "gemini-client-model",
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {"text": "history"},
                            {
                                "inlineData": {
                                    "mimeType": "image/png",
                                    "data": "aGVsbG8="
                                },
                                "vendor": {"history": true}
                            }
                        ]
                    },
                    {
                        "role": "model",
                        "parts": [{"text": "ack"}]
                    },
                    {
                        "role": "user",
                        "parts": [
                            {"text": "current"},
                            {
                                "inlineData": {
                                    "mimeType": "image/webp",
                                    "data": "UklGRg=="
                                },
                                "vendor": {"current": true}
                            }
                        ]
                    }
                ]
            }),
        },
    ]
}

fn run_public_case(
    case: &ProtocolCase,
) -> (
    Value,
    RequestScopedContextPair,
    V3HubEntryProtocol,
    V3HubTransportIntent,
    Value,
) {
    let handle = V3RequestContextHandle::new(
        format!("req02-chat-history-{}", case.name),
        case.protocol.to_string(),
    );
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("invocation-{}", case.name),
        format!("attempt-{}", case.name),
        RequestOriginKind::ClientEntry,
    );
    let captured =
        execute_v3_operation_runner_request_capture_client_json(case.raw.clone()).unwrap();
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public operation runner must normalize the original protocol payload");
    let pair_before = handle
        .original_pair()
        .expect("raw entry publishes typed pair");

    let hub_input = build_v3_hub_req_inbound_01_client_raw(
        case.raw.clone(),
        case.entry_protocol,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let normalized = build_v3_hub_req_inbound_02_from_canonical(hub_input, canonical.clone());

    assert_eq!(
        normalized.payload(),
        &canonical,
        "canonical constructor must consume the SDK output without re-normalizing or cleaning it"
    );
    assert_eq!(normalized.entry_protocol(), case.entry_protocol);
    assert_eq!(normalized.transport_intent(), V3HubTransportIntent::Json);
    assert_eq!(
        handle.original_pair().unwrap(),
        pair_before,
        "canonical consumption must not replace the request-scoped typed pair"
    );

    let governed = compile_v3_hub_relay_request_hooks()
        .run_from_normalized(normalized, &V3HubServertoolRequestProfile::disabled())
        .expect("public Req04 consumer must accept the canonical constructor output");
    (
        canonical,
        pair_before,
        case.entry_protocol,
        V3HubTransportIntent::Json,
        governed.payload().clone(),
    )
}

fn last_user_index(messages: &[Value]) -> usize {
    messages
        .iter()
        .rposition(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .expect("canonical messages must contain a user turn")
}

#[test]
fn canonical_consumer_cleans_only_history_images_at_public_req04() {
    for case in protocol_cases() {
        let (canonical, pair, entry_protocol, transport_intent, governed) = run_public_case(&case);
        let canonical_messages = canonical["messages"].as_array().unwrap();
        let governed_messages = governed["messages"].as_array().unwrap();
        let last_user = last_user_index(canonical_messages);

        assert_eq!(entry_protocol, case.entry_protocol);
        assert_eq!(transport_intent, V3HubTransportIntent::Json);
        assert_eq!(pair.inverse_context.entry_protocol, case.protocol);
        assert_eq!(
            governed_messages[last_user]["content"], canonical_messages[last_user]["content"],
            "{} current-turn content must remain complete",
            case.name
        );
        assert!(
            !serde_json::to_string(&governed_messages[last_user]["content"])
                .unwrap()
                .contains("[Image]"),
            "{} current-turn image must not be replaced",
            case.name
        );
        assert_ne!(
            governed_messages[0]["content"], canonical_messages[0]["content"],
            "{} history image must be replaced by Chat Process",
            case.name
        );
        assert!(
            !serde_json::to_string(&governed_messages[0]["content"])
                .unwrap()
                .contains("AAAA"),
            "{} history image bytes must not survive Chat Process",
            case.name
        );

        if case.name == "openai_chat" {
            let canonical_calls = canonical_messages
                .iter()
                .find_map(|message| message.get("tool_calls"))
                .unwrap()
                .clone();
            let governed_calls = governed_messages
                .iter()
                .find_map(|message| message.get("tool_calls"))
                .unwrap()
                .clone();
            assert_eq!(
                governed_calls, canonical_calls,
                "exec/apply_patch/MCP tool arguments must remain byte-for-byte unchanged"
            );

            let canonical_tool_results = canonical_messages
                .iter()
                .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
                .cloned()
                .collect::<Vec<_>>();
            let governed_tool_results = governed_messages
                .iter()
                .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
                .cloned()
                .collect::<Vec<_>>();
            assert_eq!(
                governed_tool_results, canonical_tool_results,
                "ordinary tool results and unknown siblings must remain unchanged"
            );
        }
    }
}
