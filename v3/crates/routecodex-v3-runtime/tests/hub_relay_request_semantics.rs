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
        )
        .unwrap();
    assert_eq!(governed.payload(), &payload);
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
    assert_eq!(payload["messages"][1]["role"], "user");
    assert_eq!(payload["messages"][1]["content"], "search then answer");
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
        )
        .unwrap();

    let payload = governed.payload();
    let guidance = routecodex_v3_agent_memory::memory_raw_capture_guidance_text();
    assert_eq!(payload["instructions"], guidance);
    assert_eq!(payload["messages"][0]["role"], "system");
    assert_eq!(payload["messages"][0]["content"], "Base instructions.");
}

#[test]
fn responses_relay_memory_guidance_injection_fails_fast_on_bad_instructions() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let profile = V3HubServertoolRequestProfile::enabled([]).with_memory_raw_capture_enabled(true);
    let error = hooks
        .run(
            raw(json!({
                "model":"gpt-5.5",
                "messages":[{"role":"user","content":"hello"}],
                "instructions": 7
            })),
            &profile,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        V3HubRelayRequestError::MemoryRawCaptureGuidanceInjectionFailed { reason }
            if reason.contains("instructions must be a string")
    ));
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

    for invalid in [
        json!({"messages":[{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"x","arguments":"{}"}}]}]}),
        json!({"messages":[{"role":"assistant","tool_calls":[{"id":"dup","type":"function","function":{"name":"x","arguments":"{}"}},{"id":"dup","type":"function","function":{"name":"y","arguments":"{}"}}]}]}),
        json!({"messages":[{"role":"tool","tool_call_id":"orphan","content":"x"}]}),
    ] {
        assert!(matches!(
            hooks.run(
                raw_for(invalid, V3HubEntryProtocol::OpenAiChat),
                &V3HubServertoolRequestProfile::disabled(),
            ),
            Err(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                protocol: "openai_chat",
                ..
            })
        ));
    }
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
        )
        .unwrap();
    assert!(governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04ProtocolToolIdentityGoverned));

    for invalid in [
        json!({"contents":[{"role":"user","parts":[{"functionResponse":{"response":{"x":1}}}]}]}),
        json!({"contents":[{"role":"user","parts":[{"functionResponse":{"name":"","response":{"x":1}}}]}]}),
        json!({"contents":[{"role":"user","parts":[{"functionResponse":{"name":"orphan","response":{"x":1}}}]}]}),
    ] {
        assert!(matches!(
            hooks.run(
                raw_for(invalid, V3HubEntryProtocol::Gemini),
                &V3HubServertoolRequestProfile::disabled(),
            ),
            Err(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                protocol: "gemini",
                ..
            })
        ));
    }
}

#[test]
fn protocol_tool_identity_governance_uses_entry_protocol_not_payload_shape() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "messages":[{"role":"tool","tool_call_id":"shape_only","content":"preserve"}]
            })),
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert!(!governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04ProtocolToolIdentityGoverned));
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
        )
        .unwrap();
    assert!(without_apply_patch.payload().get("instructions").is_none());
}

#[test]
fn malformed_tool_output_and_required_hook_failure_are_explicit() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let malformed = json!({"input":[{"type":"function_call_output","output":"missing call id"}]});
    assert!(matches!(
        hooks.run(raw(malformed), &V3HubServertoolRequestProfile::disabled()),
        Err(V3HubRelayRequestError::ReqInboundInvalid { .. })
    ));

    assert!(matches!(
        hooks.run(
            raw(json!({"input":[{"role":"user","content":"continue"}]})),
            &V3HubServertoolRequestProfile::required_failure("req04.required")
        ),
        Err(V3HubRelayRequestError::RequiredHookFailed { .. })
    ));
}
