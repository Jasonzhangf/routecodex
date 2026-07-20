use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, compile_v3_hub_relay_request_hooks,
    V3HubContinuationLookup, V3HubContinuationOwnership, V3HubContinuationScope,
    V3HubEntryProtocol, V3HubInvocationSource, V3HubRelayRequestError, V3HubRelayRequestHookEvent,
    V3HubRequestSemanticProtocol, V3HubServertoolRequestProfile, V3HubTransportIntent,
    V3StoplessCenterState, V3StoplessCenterSteering,
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

fn scope() -> V3HubContinuationScope {
    scope_for(V3HubEntryProtocol::Responses)
}

fn scope_for(entry_protocol: V3HubEntryProtocol) -> V3HubContinuationScope {
    V3HubContinuationScope::new(entry_protocol, "server-a", "group-a", "session-a")
}
fn is_structured_stopless_shell_artifact(item: &Value) -> bool {
    if item.get("call_id").and_then(Value::as_str) == Some("call_stopless_reasoning") {
        return true;
    }
    if !matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call" | "tool_call")
    ) {
        return false;
    }
    item.get("arguments")
        .or_else(|| item.get("input"))
        .and_then(Value::as_str)
        .is_some_and(|arguments| arguments.contains("routecodex hook run reasoningStop"))
}

fn assert_no_structured_stopless_shell_artifacts(input: &[Value]) {
    for item in input {
        assert!(
            !is_structured_stopless_shell_artifact(item),
            "provider-visible request kept structured stopless shell artifact: {item}"
        );
    }
}
#[test]
fn new_request_is_lossless_and_runs_every_entry_exit_hook() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let payload = json!({"model":"client-alias","input":[{"role":"user","content":"hi"}],"metadata":{"client":"kept"}});
    let governed = hooks
        .run(
            raw(payload.clone()),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert_eq!(governed.payload(), &payload);
    assert_eq!(
        governed.semantic_protocol(),
        V3HubRequestSemanticProtocol::Chat
    );
    assert_eq!(governed.continuation(), V3HubContinuationOwnership::New);
    assert!(!governed.restored_local_context());
    assert_eq!(
        governed.hook_events(),
        &[
            V3HubRelayRequestHookEvent::Req01Entry,
            V3HubRelayRequestHookEvent::Req01Exit,
            V3HubRelayRequestHookEvent::Req02Entry,
            V3HubRelayRequestHookEvent::Req02Exit,
            V3HubRelayRequestHookEvent::Req03Entry,
            V3HubRelayRequestHookEvent::Req03Exit,
            V3HubRelayRequestHookEvent::Req04Entry,
            V3HubRelayRequestHookEvent::Req04ToolGoverned,
            V3HubRelayRequestHookEvent::Req04HistoryGoverned,
            V3HubRelayRequestHookEvent::ServertoolOptionalNoop,
            V3HubRelayRequestHookEvent::Req04Exit,
        ]
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
            &V3HubContinuationLookup::new(None, scope_for(V3HubEntryProtocol::OpenAiChat)),
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
                &V3HubContinuationLookup::new(None, scope_for(V3HubEntryProtocol::OpenAiChat)),
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
            &V3HubContinuationLookup::new(None, scope_for(V3HubEntryProtocol::Gemini)),
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
                &V3HubContinuationLookup::new(None, scope_for(V3HubEntryProtocol::Gemini)),
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
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert!(!governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04ProtocolToolIdentityGoverned));
}

#[test]
fn apply_patch_guidance_is_injected_once_at_req04_for_responses_requests() {
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
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();

    let instructions = governed.payload()["instructions"].as_str().unwrap();
    assert_eq!(instructions.matches("[Codex Tool Guidance]").count(), 1);
    assert!(instructions.contains("apply_patch"));
    assert!(instructions.contains("*** Begin Patch"));
    assert!(instructions.contains("*** End Patch"));
    assert!(instructions.contains("workspace-relative"));
    assert!(instructions.contains("Do not use absolute paths"));
    assert!(instructions.contains("Do not switch to exec_command or shell writes"));
}

#[test]
fn apply_patch_guidance_is_idempotent_and_skips_requests_without_apply_patch_tool() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "model":"client-responses",
                "instructions":"Existing\n\n[Codex Tool Guidance]\nUse apply_patch.",
                "input":[{"role":"user","content":"Patch a file"}],
                "tools":[{"type":"custom","name":"apply_patch","format":"freeform"}]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    let instructions = governed.payload()["instructions"].as_str().unwrap();
    assert_eq!(instructions.matches("[Codex Tool Guidance]").count(), 1);

    let without_apply_patch = hooks
        .run(
            raw(json!({
                "model":"client-responses",
                "input":[{"role":"user","content":"Lookup"}],
                "tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert!(without_apply_patch.payload().get("instructions").is_none());
}

#[test]
fn remote_binding_is_classified_without_local_restore() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("resp_remote"), scope())
        .with_remote_binding("resp_remote", scope());
    let governed = hooks
        .run(
            raw(json!({"input":[]})),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert_eq!(
        governed.continuation(),
        V3HubContinuationOwnership::RemoteProviderOwned
    );
    assert!(!governed.restored_local_context());
}

#[test]
fn local_context_restores_at_req04_before_servertool_governance() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("rcc_local"), scope()).with_local_context(
        "rcc_local",
        scope(),
        json!({
            "input":[{"role":"assistant","content":"prior"}],
            "output":[{"type":"function_call","call_id":"c1","name":"lookup","arguments":"{}"}]
        }),
    );
    let governed = hooks
        .run(
            raw(json!({"input":[{"type":"function_call_output","call_id":"c1","output":"ok"}]})),
            &lookup,
            &V3HubServertoolRequestProfile::enabled(["servertool.request"]),
        )
        .unwrap();
    assert_eq!(
        governed.continuation(),
        V3HubContinuationOwnership::RouteCodexLocalOwned
    );
    assert!(governed.restored_local_context());
    assert_eq!(
        governed.local_context().unwrap()["input"][0]["content"],
        "prior"
    );
    let events = governed.hook_events();
    let restore = events
        .iter()
        .position(|e| *e == V3HubRelayRequestHookEvent::Req04LocalContextRestored)
        .unwrap();
    let servertool = events
        .iter()
        .position(|e| *e == V3HubRelayRequestHookEvent::Req04ServertoolGoverned)
        .unwrap();
    assert!(restore < servertool);
}

#[test]
fn classification_is_fail_fast_for_missing_or_cross_scope_binding() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let missing = V3HubContinuationLookup::new(Some("missing"), scope());
    assert!(matches!(
        hooks.run(
            raw(json!({})),
            &missing,
            &V3HubServertoolRequestProfile::disabled()
        ),
        Err(V3HubRelayRequestError::ContinuationNotFound { .. })
    ));

    let other_scope = V3HubContinuationScope::new(
        V3HubEntryProtocol::Responses,
        "server-b",
        "group-a",
        "session-a",
    );
    let mismatch = V3HubContinuationLookup::new(Some("rcc_local"), scope()).with_local_context(
        "rcc_local",
        other_scope,
        json!({"input":[]}),
    );
    assert!(matches!(
        hooks.run(
            raw(json!({})),
            &mismatch,
            &V3HubServertoolRequestProfile::disabled()
        ),
        Err(V3HubRelayRequestError::ContinuationScopeMismatch { .. })
    ));
}

#[test]
fn classification_rejects_dual_local_and_remote_owners() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("duplicate"), scope())
        .with_local_context("duplicate", scope(), json!({"input":[]}))
        .with_remote_binding("duplicate", scope());
    assert!(matches!(
        hooks.run(
            raw(json!({})),
            &lookup,
            &V3HubServertoolRequestProfile::disabled()
        ),
        Err(V3HubRelayRequestError::AmbiguousContinuationOwnership { .. })
    ));
}

#[test]
fn malformed_tool_output_and_required_hook_failure_are_explicit() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let malformed = json!({"input":[{"type":"function_call_output","output":"missing call id"}]});
    assert!(matches!(
        hooks.run(
            raw(malformed),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled()
        ),
        Err(V3HubRelayRequestError::MalformedToolOutput { .. })
    ));

    assert!(matches!(
        hooks.run(
            raw(json!({})),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::required_failure("req04.required")
        ),
        Err(V3HubRelayRequestError::RequiredHookFailed { .. })
    ));
}

fn stopless_noop_local_context() -> Value {
    json!({
        "input": [
            {"role":"user","content":"完成当前目标"},
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"自然停下的可见文本"}]},
            {
                "type":"function_call",
                "call_id":"call_stopless_reasoning",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"
            }
        ],
        "output": [{
            "type":"function_call",
            "call_id":"call_stopless_reasoning",
            "name":"exec_command",
            "arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"
        }]
    })
}

#[test]
fn stopless_request_hook_consumes_noop_cli_from_runtime_control_not_stdout() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx-stopless-center"), scope())
        .with_local_context(
            "ctx-stopless-center",
            scope(),
            stopless_noop_local_context(),
        );
    let governed = hooks
        .run(
            raw(json!({
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":""
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop().with_stopless_center_state(
                V3StoplessCenterState::new(
                    1,
                    3,
                    V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
                ),
            ),
        )
        .unwrap();

    assert_eq!(
        governed.payload()["input"],
        json!([{"role":"user","content":"完成当前目标"}])
    );
    let input = governed.payload()["input"].as_array().unwrap();
    assert_no_structured_stopless_shell_artifacts(input);
    let serialized = serde_json::to_string(governed.payload()).unwrap();
    for forbidden in [
        "--input-json",
        "repeatCount",
        "maxRepeats",
        "triggerHint",
        "schemaFeedback",
        "continuationPrompt",
        "next_step",
        "<rcc_stop_schema>",
        "stop schema",
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "Chunk ID",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "provider request leaked old stopless state {forbidden}: {serialized}"
        );
    }
    assert!(governed.payload()["instructions"]
        .as_str()
        .unwrap()
        .contains("继续完成当前目标"));
    assert!(governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04StoplessResultParsed));
    assert!(governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04StoplessTextRewritten));
    assert!(governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04StoplessToolInjected));
    assert_eq!(
        governed.stopless_state(),
        Some(&V3StoplessCenterState::new(
            1,
            3,
            V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
        ))
    );
}

#[test]
fn stopless_request_hook_consumes_noop_cli_without_continuation_state() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "input":[
                    {"role":"user","content":"完成当前目标"},
                    {"type":"message","role":"assistant","content":[{"type":"output_text","text":"自然停下的可见文本"}]},
                    {
                        "type":"function_call",
                        "call_id":"call_stopless_reasoning",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"
                    },
                    {
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":""
                    }
                ]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();

    assert_eq!(
        governed.payload()["input"],
        json!([{"role":"user","content":"完成当前目标"}])
    );
    let serialized = serde_json::to_string(governed.payload()).unwrap();
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "Chunk ID",
        "__routecodex_stopless_center",
        "stoplessCenter",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "provider request leaked stopless CLI/control artifact {forbidden}: {serialized}"
        );
    }
    assert!(governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04StoplessResultParsed));
}

#[test]
fn stopless_request_hook_injects_short_guidance_and_exactly_one_internal_tool() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let payload = json!({
        "input":[{"role":"user","content":"继续做"}],
        "tools":[{"type":"function","name":"exec","description":"original tool"}],
        "instructions":"base instruction"
    });
    let governed = hooks
        .run(
            raw(payload.clone()),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();

    assert_eq!(governed.payload()["input"], payload["input"]);
    let tools = governed.payload()["tools"].as_array().unwrap();
    assert_eq!(tools[0], payload["tools"][0]);
    assert_eq!(
        tools
            .iter()
            .filter(|tool| tool.get("name").and_then(Value::as_str) == Some("reasoningStop"))
            .count(),
        1,
        "managed relay must append exactly one internal reasoningStop"
    );
    let instructions = governed.payload()["instructions"].as_str().unwrap();
    assert!(instructions.contains("base instruction"));
    assert!(instructions.contains("继续完成当前目标"));
    for forbidden in [
        "<rcc_stop_schema>",
        "schemaFeedback",
        "repeatCount",
        "maxRepeats",
        "triggerHint",
        "next_step",
        "stop schema",
    ] {
        assert!(
            !instructions.contains(forbidden),
            "short guidance kept old schema/control wording {forbidden}: {instructions}"
        );
    }
}

#[test]
fn stopless_request_hook_injects_into_additional_tools_without_rebuilding_shape() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let original_tools = json!([
        {"type":"function","name":"exec","description":"run javascript"},
        {"type":"function","name":"wait","description":"wait for exec"},
        {"type":"function","name":"request_user_input","description":"ask user"}
    ]);
    let payload = json!({
        "input":[
            {
                "type":"additional_tools",
                "role":"developer",
                "tools": original_tools.clone()
            },
            {"role":"user","content":"keep codex tool declarations"}
        ]
    });
    let governed = hooks
        .run(
            raw(payload.clone()),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();

    assert!(governed.payload().get("tools").is_none());
    assert_eq!(governed.payload()["input"][1], payload["input"][1]);
    let tools = governed.payload()["input"][0]["tools"].as_array().unwrap();
    assert_eq!(
        &tools[..original_tools.as_array().unwrap().len()],
        original_tools.as_array().unwrap().as_slice(),
        "stopless must preserve original Codex additional_tools definitions in place"
    );
    assert_eq!(
        tools
            .iter()
            .filter(|tool| tool.get("name").and_then(Value::as_str) == Some("reasoningStop"))
            .count(),
        1,
        "stopless must append exactly one internal reasoningStop tool"
    );
}

#[test]
fn stopless_request_hook_malformed_tools_is_fail_fast_not_silent_replaced() {
    let hooks = compile_v3_hub_relay_request_hooks();
    assert!(matches!(
        hooks.run(
            raw(json!({
                "input":[{"role":"user","content":"bad tools"}],
                "tools":"not an array"
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        ),
        Err(V3HubRelayRequestError::MalformedStoplessToolSurface { .. })
    ));
}

#[test]
fn stopless_request_hook_is_disabled_without_stopless_profile() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("rcc_stopless_disabled"), scope())
        .with_local_context(
            "rcc_stopless_disabled",
            scope(),
            stopless_noop_local_context(),
        );
    let governed = hooks
        .run(
            raw(json!({
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":""
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert_eq!(governed.tool_output_count(), 1);
    assert!(governed.payload().get("instructions").is_none());
    assert!(governed.payload().get("tools").is_none());
    assert!(!governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04StoplessResultParsed));
    assert!(!governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04StoplessToolInjected));
}
