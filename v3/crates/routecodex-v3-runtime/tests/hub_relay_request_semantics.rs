use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, compile_v3_hub_relay_request_hooks, V3HubEntryProtocol,
    V3HubInvocationSource, V3HubRelayRequestError, V3HubRelayRequestHookEvent,
    V3HubRequestSemanticProtocol, V3HubServertoolRequestProfile, V3HubTransportIntent,
};
use serde_json::{json, Value};

fn raw(payload: serde_json::Value) -> routecodex_v3_runtime::V3HubReqInbound01ClientRaw {
    raw_for(payload, V3HubEntryProtocol::Responses)
}

fn raw_for(
    payload: serde_json::Value,
    entry_protocol: V3HubEntryProtocol,
) -> routecodex_v3_runtime::V3HubReqInbound01ClientRaw {
    build_v3_hub_req_inbound_01_client_raw(
        payload,
        entry_protocol,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    )
}

fn entry_invocation() -> routecodex_v3_runtime::operation_runner::RequestInvocationContext {
    entry_invocation_for(V3HubEntryProtocol::Responses)
}

fn entry_invocation_for(
    protocol: V3HubEntryProtocol,
) -> routecodex_v3_runtime::operation_runner::RequestInvocationContext {
    let key = match protocol {
        V3HubEntryProtocol::Responses => "responses",
        V3HubEntryProtocol::Anthropic => "anthropic",
        V3HubEntryProtocol::Gemini => "gemini",
        V3HubEntryProtocol::OpenAiChat => "openai_chat",
    };
    let handle = routecodex_v3_runtime::operation_runner::V3RequestContextHandle::new(
        format!("hub-relay-request-semantics-{key}"),
        key.to_string(),
    );
    routecodex_v3_runtime::operation_runner::RequestInvocationContext::new(
        handle,
        "entry".to_string(),
        "attempt".to_string(),
        routecodex_v3_runtime::operation_runner::RequestOriginKind::ClientEntry,
    )
}

fn serialized_contains_tool_type(payload: &Value, tool_type: &str) -> bool {
    serde_json::to_string(payload)
        .unwrap()
        .contains(&format!("\"type\":\"{tool_type}\""))
}

#[test]
fn new_request_is_lossless_and_runs_every_entry_exit_hook() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let payload = json!({"model":"client-alias","messages":[{"role":"user","content":"hi"}],"metadata":{"client":"kept"}});
    let governed = hooks
        .run(
            raw_for(payload.clone(), V3HubEntryProtocol::OpenAiChat),
            &V3HubServertoolRequestProfile::disabled(),
            &entry_invocation_for(V3HubEntryProtocol::OpenAiChat),
        )
        .unwrap();
    // The SDK keeps one canonical representation and adds an inverse-association
    // record for the original client value; assert losslessness of the business
    // fields instead of byte equality with the pre-normalization payload.
    assert_eq!(governed.payload()["model"], payload["model"]);
    assert_eq!(governed.payload()["messages"], payload["messages"]);
    assert_eq!(governed.payload()["metadata"], payload["metadata"]);
    assert_eq!(
        governed.semantic_protocol(),
        V3HubRequestSemanticProtocol::Chat
    );
    assert_eq!(
        governed.hook_events(),
        &[
            V3HubRelayRequestHookEvent::Req01Entry,
            V3HubRelayRequestHookEvent::Req01Exit,
            V3HubRelayRequestHookEvent::Req02Entry,
            V3HubRelayRequestHookEvent::Req02Exit,
            V3HubRelayRequestHookEvent::Req04Entry,
            V3HubRelayRequestHookEvent::Req04ProtocolToolIdentityGoverned,
            V3HubRelayRequestHookEvent::Req04ToolGoverned,
            V3HubRelayRequestHookEvent::ServertoolOptionalNoop,
            V3HubRelayRequestHookEvent::Req04Exit,
        ]
    );
}

#[test]
fn responses_req_inbound02_keeps_named_unpaired_tool_output_through_req04_governance() {
    // Live P0 shape (bug f29d7db): the standalone Codex notification output must
    // survive ReqInbound02 canonicalization and Req04 tool governance untouched.
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "model":"gpt-5.5",
                "input":[
                    {
                        "type":"message",
                        "role":"user",
                        "content":[{"type":"input_text","text":"continue"}]
                    },
                    {
                        "type":"function_call_output",
                        "id":"fco_01a0c969-72fc-7530-9f23-0181a8b116e3",
                        "name":"send_message_to_thread",
                        "namespace":"codex_tui",
                        "output":"<codex_delegation>cross-thread notification</codex_delegation>"
                    }
                ]
            })),
            &V3HubServertoolRequestProfile::disabled(),
            &entry_invocation(),
        )
        .expect("named unpaired tool output must pass ReqInbound02 and Req04 governance");

    let payload = governed.payload();
    let messages = payload["messages"]
        .as_array()
        .expect("Chat canonical messages");
    assert!(
        messages
            .iter()
            .all(|message| message.get("tool_call_id").is_none()),
        "no fabricated tool_call_id may appear for an unpaired output: {payload}"
    );
    let carrier = messages
        .iter()
        .find(|message| {
            message["routecodex_chat_extension"]["responses_tool_output_name"].is_string()
        })
        .unwrap_or_else(|| panic!("named unpaired output must survive Req04: {payload}"));
    let extension = &carrier["routecodex_chat_extension"];
    assert_eq!(
        extension["responses_tool_output_name"],
        "send_message_to_thread"
    );
    assert_eq!(extension["responses_tool_output_namespace"], "codex_tui");
    assert!(
        carrier["content"]
            .as_str()
            .is_some_and(|content| content.contains("cross-thread notification")),
        "the exact output text must survive governance: {payload}"
    );
}

#[test]
fn responses_req_inbound02_canonicalizes_payload_to_chat_and_preserves_tool_search_before_req04() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "model":"gpt-5.5",
                "instructions":"You are precise.",
                "tools":[{"type":"tool_search","name":"tool_search"}],
                "input":[
                    {
                        "type":"additional_tools",
                        "tools":[{"type":"web_search_preview","name":"web_search"}]
                    },
                    {
                        "type":"message",
                        "role":"user",
                        "content":[{"type":"input_text","text":"search then answer"}]
                    }
                ]
            })),
            &V3HubServertoolRequestProfile::disabled(),
            &entry_invocation(),
        )
        .unwrap();

    let payload = governed.payload();
    assert!(
        payload.get("messages").and_then(Value::as_array).is_some(),
        "ReqInbound02 must carry Chat canonical messages before Req04: {payload}"
    );
    assert!(
        payload.get("input").is_none(),
        "ReqInbound02 must not leave Responses input as the live request payload after Chat canonicalization: {payload}"
    );
    assert_eq!(payload["messages"][0]["role"], "system");
    assert!(
        payload["messages"]
            .as_array()
            .expect("canonical Chat messages")
            .iter()
            .any(|message| {
                message["role"] == "user"
                    && message["content"].as_array().is_some_and(|parts| {
                        parts
                            .iter()
                            .any(|part| part["text"] == "search then answer")
                    })
            }),
        "canonical user message must carry the input_text content: {payload}"
    );
    assert!(
        serialized_contains_tool_type(payload, "tool_search"),
        "tool_search must survive inbound as a Chat canonical tool surface: {payload}"
    );
    assert!(
        serialized_contains_tool_type(payload, "web_search_preview"),
        "additional_tools web search must survive inbound without shell/script conversion: {payload}"
    );
    let serialized = serde_json::to_string(payload).unwrap();
    assert!(!serialized.contains("\"type\":\"function\""));
    assert!(!serialized.contains("\"name\":\"exec\""));
    assert!(!serialized.contains("\"name\":\"script\""));
}

#[test]
fn responses_relay_req04_injects_memory_guidance_once_before_tool_governance() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let profile = V3HubServertoolRequestProfile::enabled([]).with_memory_raw_capture_enabled(true);
    let governed = hooks
        .run(
            raw(json!({
                "model":"gpt-5.5",
                "instructions":"Base instructions.",
                "input":[{"role":"user","content":"hello"}]
            })),
            &profile,
            &entry_invocation(),
        )
        .unwrap();

    let payload = governed.payload();
    let guidance = routecodex_v3_agent_memory::memory_raw_capture_guidance_text();
    assert_eq!(payload["instructions"], guidance);
    assert_eq!(payload["messages"][0]["role"], "system");
    assert_eq!(payload["messages"][0]["content"], "Base instructions.");
}

#[test]
fn responses_relay_memory_guidance_preserves_nonchat_instructions() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let profile = V3HubServertoolRequestProfile::enabled([]).with_memory_raw_capture_enabled(true);
    let governed = hooks
        .run(
            raw(json!({
                "model":"gpt-5.5",
                "messages":[{"role":"user","content":"hello"}],
                "instructions": 7
            })),
            &profile,
            &entry_invocation(),
        )
        .expect("lossless non-Chat instructions must not block registered memory guidance");
    assert_eq!(
        governed.payload()["instructions"],
        routecodex_v3_agent_memory::memory_raw_capture_guidance_text()
    );
}

#[test]
fn req04_preserves_malformed_shell_like_function_call_and_parse_error_output() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "model":"gpt-5.5",
                "input":[
                    {
                        "type":"function_call",
                        "call_id":"call_bad",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"cat missing\"}{\"cmd\":\"pwd\"}"
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_good",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"pwd\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_bad",
                        "output":"failed to parse function arguments: trailing characters at line 1 column 22"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_good",
                        "output":"ok"
                    },
                    {
                        "type":"message",
                        "role":"user",
                        "content":[{"type":"input_text","text":"continue"}]
                    }
                ]
            })),
            &V3HubServertoolRequestProfile::disabled(),
            &entry_invocation(),
        )
        .unwrap();

    assert_eq!(governed.tool_output_count(), 2);
    assert!(governed.payload().get("input").is_none());
    let messages = governed.payload()["messages"].as_array().unwrap();
    assert!(
        messages.iter().any(|message| message
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|call| call.get("id").and_then(Value::as_str) == Some("call_bad"))),
        "non-injected malformed shell-like call history must remain provider-visible as Chat tool_calls: {messages:?}"
    );
    assert!(
        messages.iter().any(
            |message| message.get("role").and_then(Value::as_str) == Some("tool")
                && message.get("tool_call_id").and_then(Value::as_str) == Some("call_bad")
        ),
        "non-injected parse-error output must remain paired with its Chat tool call: {messages:?}"
    );
    assert!(
        messages.iter().any(|message| message
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|call| call.get("id").and_then(Value::as_str) == Some("call_good"))),
        "valid shell-like function_call must remain provider-visible as Chat tool_calls: {messages:?}"
    );
    assert!(
        messages.iter().any(|message| message.get("role").and_then(Value::as_str) == Some("tool")
            && message.get("tool_call_id").and_then(Value::as_str) == Some("call_good")),
        "valid shell-like function_call_output must remain provider-visible as Chat tool result: {messages:?}"
    );
}

#[test]
fn openai_chat_tool_identity_is_governed_at_req04_after_normalization() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let valid = json!({
        "messages":[
            {"role":"user","content":"lookup"},
            {"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},
            {"role":"tool","tool_call_id":"call_1","content":"ok"}
        ]
    });
    let governed = hooks
        .run(
            raw_for(valid, V3HubEntryProtocol::OpenAiChat),
            &V3HubServertoolRequestProfile::disabled(),
            &entry_invocation_for(V3HubEntryProtocol::OpenAiChat),
        )
        .unwrap();
    let events = governed.hook_events();
    let identity = events
        .iter()
        .position(|e| *e == V3HubRelayRequestHookEvent::Req04ProtocolToolIdentityGoverned)
        .unwrap();
    let tool_governed = events
        .iter()
        .position(|e| *e == V3HubRelayRequestHookEvent::Req04ToolGoverned)
        .unwrap();
    assert!(identity < tool_governed);

    for representable in [
        json!({"messages":[{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"x","arguments":"{}"}}]}]}),
        json!({"messages":[{"role":"assistant","tool_calls":[{"id":"dup","type":"function","function":{"name":"x","arguments":"{}"}},{"id":"dup","type":"function","function":{"name":"y","arguments":"{}"}}]}]}),
    ] {
        assert_governed_inverse_preserves(representable, V3HubEntryProtocol::OpenAiChat);
    }
    assert!(matches!(
        hooks.run(
            raw_for(
                json!({"messages":[{"role":"tool","tool_call_id":"orphan","content":"x"}]}),
                V3HubEntryProtocol::OpenAiChat
            ),
            &V3HubServertoolRequestProfile::disabled(),
            &entry_invocation_for(V3HubEntryProtocol::OpenAiChat),
        ),
        Err(V3HubRelayRequestError::OrphanToolOutput { .. })
    ));
}

#[test]
fn gemini_function_response_identity_is_governed_at_req04_after_normalization() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let valid = json!({
        "contents":[
            {"role":"user","parts":[{"text":"lookup"}]},
            {"role":"model","parts":[{"functionCall":{"name":"lookup","args":{"city":"Tokyo"}}}]},
            {"role":"user","parts":[{"functionResponse":{"name":"lookup","response":{"forecast":"sunny"}}}]}
        ]
    });
    let governed = hooks
        .run(
            raw_for(valid, V3HubEntryProtocol::Gemini),
            &V3HubServertoolRequestProfile::disabled(),
            &entry_invocation_for(V3HubEntryProtocol::Gemini),
        )
        .unwrap();
    assert!(governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04ProtocolToolIdentityGoverned));

    for representable in [
        json!({"contents":[{"role":"user","parts":[{"functionResponse":{"response":{"x":1}}}]}]}),
        json!({"contents":[{"role":"user","parts":[{"functionResponse":{"name":"","response":{"x":1}}}]}]}),
        json!({"contents":[{"role":"user","parts":[{"functionResponse":{"name":"orphan","response":{"x":1}}}]}]}),
    ] {
        assert_governed_inverse_preserves(representable, V3HubEntryProtocol::Gemini);
    }
}

#[test]
fn protocol_tool_identity_governance_consumes_normalized_messages_for_every_entry() {
    // Responses supports this declared Chat-compatible history alias. It must
    // reach the same pairing operation as the other normalized protocols.
    assert_governed_inverse_preserves(
        json!({
            "messages":[
                {"role":"assistant","tool_calls":[{"id":"shape_only","type":"function","function":{"name":"lookup","arguments":"{}"}}]},
                {"role":"tool","tool_call_id":"shape_only","content":"preserve"}
            ]
        }),
        V3HubEntryProtocol::Responses,
    );
}

fn assert_governed_inverse_preserves(payload: Value, protocol: V3HubEntryProtocol) {
    use routecodex_v3_runtime::operation_runner::{
        project_canonical_direct_request, CurrentFieldAssociations,
    };
    let invocation = entry_invocation_for(protocol);
    let governed = compile_v3_hub_relay_request_hooks()
        .run(
            raw_for(payload.clone(), protocol),
            &V3HubServertoolRequestProfile::disabled(),
            &invocation,
        )
        .expect("representable history must pass canonical governance");
    assert!(governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04ProtocolToolIdentityGoverned));
    let pair = invocation.request_handle().original_pair().unwrap();
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    let projected = project_canonical_direct_request(
        governed.payload(),
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
    )
    .unwrap();
    assert_eq!(
        projected.payload, payload,
        "canonical governance must preserve the original history"
    );
}

#[test]
fn apply_patch_guidance_is_not_injected_into_payload_at_req04() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "model":"client-responses",
                "input":[{"role":"user","content":"Patch a file"}],
                "tools":[{
                    "type":"custom",
                    "name":"apply_patch",
                    "format":{"type":"grammar","syntax":"lark","definition":"start: patch"}
                }]
            })),
            &V3HubServertoolRequestProfile::disabled(),
            &entry_invocation(),
        )
        .unwrap();

    assert!(governed.payload().get("instructions").is_none());
}

#[test]
fn apply_patch_guidance_text_is_preserved_at_req04() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "model":"client-responses",
                "instructions":"Existing\n\n[Codex Tool Guidance]\nUse apply_patch.",
                "input":[{"role":"user","content":"Patch a file"}],
                "tools":[{"type":"custom","name":"apply_patch","format":"freeform"}]
            })),
            &V3HubServertoolRequestProfile::disabled(),
            &entry_invocation(),
        )
        .unwrap();
    assert!(serde_json::to_string(governed.payload())
        .unwrap()
        .contains("[Codex Tool Guidance]"));

    let without_apply_patch = hooks
        .run(
            raw(json!({
                "model":"client-responses",
                "input":[{"role":"user","content":"Lookup"}],
                "tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}]
            })),
            &V3HubServertoolRequestProfile::disabled(),
            &entry_invocation(),
        )
        .unwrap();
    assert!(without_apply_patch.payload().get("instructions").is_none());
}

#[test]
fn opaque_tool_output_is_preserved_and_required_hook_failure_is_explicit() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let opaque = json!({"input":[{"type":"function_call_output","output":"missing call id"}]});
    assert_governed_inverse_preserves(opaque, V3HubEntryProtocol::Responses);

    assert!(matches!(
        hooks.run(
            raw(json!({"input":[{"role":"user","content":"continue"}]})),
            &V3HubServertoolRequestProfile::required_failure("req04.required"),
            &entry_invocation(),
        ),
        Err(V3HubRelayRequestError::RequiredHookFailed { .. })
    ));
}
