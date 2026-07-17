use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, compile_v3_hub_relay_request_hooks,
    V3HubContinuationLookup, V3HubContinuationOwnership, V3HubContinuationScope,
    V3HubEntryProtocol, V3HubInvocationSource, V3HubRelayRequestError, V3HubRelayRequestHookEvent,
    V3HubRequestSemanticProtocol, V3HubServertoolRequestProfile, V3HubTransportIntent,
};
use serde_json::json;

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

#[test]
fn stopless_request_hook_rewrites_cli_result_after_restore_before_tool_governance() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("rcc_stopless"), scope()).with_local_context(
        "rcc_stopless",
        scope(),
        json!({
            "status":"requires_action",
            "output":[{"type":"function_call","call_id":"call_stopless_reasoning","name":"exec_command","arguments":"{}"}]
        }),
    );
    let governed = hooks
        .run(
            raw(json!({
                "input":[{"type":"function_call_output","call_id":"call_stopless_reasoning","output":"{\"next_step\":\"continue with exact next step\"}"}]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();
    assert!(governed.restored_local_context());
    assert_eq!(governed.tool_output_count(), 0);
    assert_eq!(governed.payload()["input"][0]["role"], "user");
    assert_eq!(
        governed.payload()["input"][0]["content"],
        "continue with exact next step"
    );
    assert!(governed.payload()["instructions"]
        .as_str()
        .unwrap()
        .contains("stopreason"));
    let events = governed.hook_events();
    let restore = events
        .iter()
        .position(|e| *e == V3HubRelayRequestHookEvent::Req04LocalContextRestored)
        .unwrap();
    let parsed = events
        .iter()
        .position(|e| *e == V3HubRelayRequestHookEvent::Req04StoplessResultParsed)
        .unwrap();
    let rewrite = events
        .iter()
        .position(|e| *e == V3HubRelayRequestHookEvent::Req04StoplessTextRewritten)
        .unwrap();
    let injected = events
        .iter()
        .position(|e| *e == V3HubRelayRequestHookEvent::Req04StoplessToolInjected)
        .unwrap();
    let tool_governed = events
        .iter()
        .position(|e| *e == V3HubRelayRequestHookEvent::Req04ToolGoverned)
        .unwrap();
    assert!(restore < rewrite);
    assert!(restore < parsed);
    assert!(parsed < rewrite);
    assert!(rewrite < injected);
    assert!(injected < tool_governed);
    assert!(rewrite < tool_governed);
}

#[test]
fn stopless_request_hook_malformed_cli_output_is_fail_fast() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("rcc_stopless"), scope()).with_local_context(
        "rcc_stopless",
        scope(),
        json!({
            "status":"requires_action",
            "output":[{"type":"function_call","call_id":"call_stopless_reasoning","name":"exec_command","arguments":"{}"}]
        }),
    );
    assert!(matches!(
        hooks.run(
            raw(json!({
                "input":[{"type":"function_call_output","call_id":"call_stopless_reasoning","output":"not json"}]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        ),
        Err(V3HubRelayRequestError::MalformedStoplessCliOutput { .. })
    ));
}

#[test]
fn stopless_request_hook_without_cli_output_injects_schema_and_preserves_input() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let payload = json!({
        "input":[{"role":"user","content":"keep this user turn"}]
    });
    let governed = hooks
        .run(
            raw(payload.clone()),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(governed.payload()["input"], payload["input"]);
    assert_eq!(governed.tool_output_count(), 0);
    assert!(governed.payload()["instructions"]
        .as_str()
        .unwrap()
        .contains("stopreason"));
    assert!(governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04StoplessToolInjected));
    assert!(!governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04StoplessResultParsed));
    assert!(!governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04StoplessTextRewritten));
}

#[test]
fn stopless_request_hook_existing_instruction_is_idempotent() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "instructions":"existing stopreason contract",
                "input":[{"role":"user","content":"keep"}]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();
    let instructions = governed.payload()["instructions"].as_str().unwrap();
    assert_eq!(instructions, "existing stopreason contract");
    assert_eq!(instructions.matches("stopreason").count(), 1);
}

#[test]
fn stopless_request_hook_is_disabled_without_stopless_profile() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("rcc_stopless_disabled"), scope())
        .with_local_context(
            "rcc_stopless_disabled",
            scope(),
            json!({
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_stopless_reasoning",
                    "name":"exec_command",
                    "arguments":"{}"
                }]
            }),
        );
    let governed = hooks
        .run(
            raw(json!({
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{\"next_step\":\"must not be rewritten\"}"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert_eq!(governed.tool_output_count(), 1);
    assert_eq!(
        governed.payload()["input"][0]["type"],
        "function_call_output"
    );
    assert_eq!(
        governed.payload()["input"][0]["output"],
        "{\"next_step\":\"must not be rewritten\"}"
    );
    assert!(governed.payload().get("instructions").is_none());
    assert!(!governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04StoplessResultParsed));
    assert!(!governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04StoplessTextRewritten));
    assert!(!governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04StoplessToolInjected));
}

#[test]
fn stopless_request_hook_missing_next_step_uses_default_prompt() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("rcc_stopless_default"), scope())
        .with_local_context(
            "rcc_stopless_default",
            scope(),
            json!({
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_stopless_reasoning",
                    "name":"exec_command",
                    "arguments":"{}"
                }]
            }),
        );
    let governed = hooks
        .run(
            raw(json!({
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{}"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(
        governed.payload()["input"],
        json!([{"role":"user","content":"Continue from the previous stopless hook result."}])
    );
    assert_eq!(governed.tool_output_count(), 0);
}

#[test]
fn stopless_request_hook_output_string_is_required() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("rcc_stopless_bad_output"), scope())
        .with_local_context(
            "rcc_stopless_bad_output",
            scope(),
            json!({
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_stopless_reasoning",
                    "name":"exec_command",
                    "arguments":"{}"
                }]
            }),
        );
    assert!(matches!(
        hooks.run(
            raw(json!({
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        ),
        Err(V3HubRelayRequestError::MalformedStoplessCliOutput {
            reason: "output string is required",
            ..
        })
    ));
}
