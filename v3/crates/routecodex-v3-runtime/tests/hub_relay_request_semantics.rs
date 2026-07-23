use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, compile_v3_hub_relay_request_hooks,
    V3HubContinuationLookup, V3HubContinuationOwnership, V3HubContinuationScope,
    V3HubEntryProtocol, V3HubInvocationSource, V3HubRelayRequestError, V3HubRelayRequestHookEvent,
    V3HubRequestSemanticProtocol, V3HubServertoolRequestProfile, V3HubTransportIntent,
    V3StoplessCenterNextRequestPolicy, V3StoplessCenterState, V3StoplessCenterSteering,
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
            &V3HubContinuationLookup::new(None, scope_for(V3HubEntryProtocol::OpenAiChat)),
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
            V3HubRelayRequestHookEvent::Req04ProtocolToolIdentityGoverned,
            V3HubRelayRequestHookEvent::Req04ToolGoverned,
            V3HubRelayRequestHookEvent::Req04HistoryGoverned,
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
            &V3HubContinuationLookup::new(None, scope()),
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
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();

    assert_eq!(governed.tool_output_count(), 2);
    let input = governed.payload()["input"].as_array().unwrap();
    assert!(
        input
            .iter()
            .any(|item| item.get("call_id").and_then(Value::as_str) == Some("call_bad")),
        "non-injected malformed shell-like call history must remain provider-visible so client/model feedback continuity is preserved: {input:?}"
    );
    assert!(
        input
            .iter()
            .any(
                |item| item.get("type").and_then(Value::as_str) == Some("function_call_output")
                    && item.get("call_id").and_then(Value::as_str) == Some("call_bad")
            ),
        "non-injected parse-error output must remain paired with its call: {input:?}"
    );
    assert!(
        input.iter().any(
            |item| item.get("type").and_then(Value::as_str) == Some("function_call")
                && item.get("call_id").and_then(Value::as_str) == Some("call_good")
        ),
        "valid shell-like function_call must remain provider-visible: {input:?}"
    );
    assert!(
        input
            .iter()
            .any(
                |item| item.get("type").and_then(Value::as_str) == Some("function_call_output")
                    && item.get("call_id").and_then(Value::as_str) == Some("call_good")
            ),
        "valid shell-like function_call_output must remain provider-visible: {input:?}"
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
            &V3HubServertoolRequestProfile::stopless_reasoning_stop()
                .with_stopless_center_state(V3StoplessCenterState::new(
                    1,
                    3,
                    V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
                ))
                .with_stopless_transition_context("req-stopless-request-state", 42_424),
        )
        .unwrap();

    let input = governed.payload()["input"].as_array().unwrap();
    assert_eq!(input.len(), 2);
    assert_eq!(input[0], json!({"role":"user","content":"完成当前目标"}));
    assert_eq!(input[1].get("role").and_then(Value::as_str), Some("user"));
    assert_full_stopless_continuation_prompt(
        input[1]
            .get("content")
            .and_then(Value::as_str)
            .expect("stopless continuation prompt"),
    );
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
    assert_full_stopless_system_guidance(governed.payload()["instructions"].as_str().unwrap());
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
        Some(
            &V3StoplessCenterState::new(
                1,
                3,
                V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
            )
            .provider_turn_in_flight(Some("req-stopless-request-state"), Some(42_424))
        )
    );
}

#[test]
fn stopless_request_hook_guidance_varies_by_stopless_center_policy() {
    let first = run_stopless_noop_with_state(V3StoplessCenterState::new(
        1,
        3,
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
    ));
    let second = run_stopless_noop_with_state(V3StoplessCenterState::new(
        2,
        3,
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
    ));
    let needs_evidence = run_stopless_noop_with_state(V3StoplessCenterState::new(
        1,
        3,
        V3StoplessCenterSteering::ReasoningStopNeedsEvidence,
    ));

    let first_prompt = last_user_content(first.payload());
    let second_prompt = last_user_content(second.payload());
    let evidence_prompt = last_user_content(needs_evidence.payload());
    let second_payload = serde_json::to_string(second.payload()).unwrap();

    assert_full_stopless_continuation_prompt(&first_prompt);
    assert_ne!(
        first_prompt, second_prompt,
        "second consecutive stop must not reuse a one-size hardcoded continuation prompt"
    );
    assert!(
        !second_prompt.contains("连续第")
            && !second_prompt.contains("最多")
            && second_prompt.contains("最小可验证工具动作")
            && second_prompt.contains("工具动作"),
        "stronger policy prompt must vary by policy without exposing internal counters or no-op mechanism: {second_prompt}"
    );
    for forbidden in ["连续第", "最多", "续轮上限", "连续 stop 次数"] {
        assert!(
            !second_payload.contains(forbidden),
            "provider-facing stopless guidance must not expose internal state token {forbidden}: {second_payload}"
        );
    }
    assert!(
        evidence_prompt.contains("证据不足")
            && evidence_prompt.contains("具体证据")
            && evidence_prompt.contains("reasoningStop"),
        "needs-evidence policy prompt must ask for terminal evidence: {evidence_prompt}"
    );
    assert_eq!(
        second.stopless_state().unwrap().next_request_policy(),
        V3StoplessCenterNextRequestPolicy::ContinueWithStrongerInstruction
    );
    assert_eq!(
        needs_evidence
            .stopless_state()
            .unwrap()
            .next_request_policy(),
        V3StoplessCenterNextRequestPolicy::AskForCompletionEvidence
    );
}

fn run_stopless_noop_with_state(
    state: V3StoplessCenterState,
) -> routecodex_v3_runtime::V3HubRelayRequestOutcome {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx-stopless-center"), scope())
        .with_local_context(
            "ctx-stopless-center",
            scope(),
            stopless_noop_local_context(),
        );
    hooks
        .run(
            raw(json!({
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":""
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop()
                .with_stopless_center_state(state),
        )
        .unwrap()
}

fn last_user_content(payload: &Value) -> String {
    payload["input"]
        .as_array()
        .expect("input array")
        .iter()
        .rev()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|item| item.get("content"))
        .and_then(Value::as_str)
        .expect("last user content")
        .to_string()
}

fn assert_full_stopless_continuation_prompt(prompt: &str) {
    for required in [
        "继续当前目标",
        "基于已经恢复的完整上下文",
        "上一轮明确写出的下一步",
        "已有结论",
        "未完成事项",
        "继续执行",
        "本轮必须调用最相关工具",
        "不要只总结",
        "目标确实完成并有证据",
        "reasoningStop",
        "阻塞",
        "needs_user_input",
        "既未完成也未阻塞，继续工作",
    ] {
        assert!(
            prompt.contains(required),
            "stopless continuation prompt missing transparent guideline token {required}: {prompt}"
        );
    }
    for forbidden in [
        "no-op",
        "CLI",
        "client tool round",
        "客户端工具轮",
        "routecodex hook run reasoningStop",
        "上一轮 reasoningStop CLI",
        "不是工具结果",
        "finish_reason=stop",
        "RouteCodex stopless continuation",
    ] {
        assert!(
            !prompt.contains(forbidden),
            "provider-visible continuation prompt leaked black-box bridge mechanism {forbidden}: {prompt}"
        );
    }
}

fn assert_full_stopless_system_guidance(instructions: &str) {
    for required in [
        "当前轮推进准则",
        "当前轮",
        "继续当前目标",
        "基于已有上下文",
        "继续执行",
        "本轮必须调用最相关工具",
        "完成证据",
        "阻塞证据",
        "reasoningStop",
        "不要只输出分析",
    ] {
        assert!(
            instructions.contains(required),
            "stopless system guidance missing full guideline token {required}: {instructions}"
        );
    }
    for forbidden in [
        "no-op",
        "CLI",
        "client tool round",
        "客户端工具轮",
        "routecodex hook run reasoningStop",
    ] {
        assert!(
            !instructions.contains(forbidden),
            "provider-visible system guidance leaked black-box bridge mechanism {forbidden}: {instructions}"
        );
    }
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

    let input = governed.payload()["input"].as_array().unwrap();
    assert_eq!(input.len(), 2);
    assert_eq!(input[0], json!({"role":"user","content":"完成当前目标"}));
    assert_eq!(input[1].get("role").and_then(Value::as_str), Some("user"));
    assert_full_stopless_continuation_prompt(
        input[1]
            .get("content")
            .and_then(Value::as_str)
            .expect("stopless continuation prompt without state"),
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
fn stopless_request_hook_injects_full_guidance_and_exactly_one_internal_tool() {
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

    assert!(governed.payload()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(
            |message| message.get("role").and_then(Value::as_str) == Some("user")
                && message.get("content").and_then(Value::as_str) == Some("继续做")
        ));
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
    assert!(governed.payload()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(
            |message| message.get("role").and_then(Value::as_str) == Some("system")
                && message
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|content| content.contains("base instruction"))
        ));
    assert_full_stopless_system_guidance(instructions);
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
            "full guidance kept old schema/control wording {forbidden}: {instructions}"
        );
    }
}

#[test]
fn stopless_request_hook_preserves_original_instruction_and_adds_action_delta() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let payload = json!({
        "input":[{"role":"user","content":"keep the original task text"}],
        "tools":[{"type":"function","name":"exec","description":"original tool"}],
        "tool_choice":"auto",
        "instructions":"original client instruction"
    });
    let governed = hooks
        .run(
            raw(payload.clone()),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();

    let instructions = governed
        .payload()
        .get("instructions")
        .and_then(Value::as_str)
        .expect("original instructions plus stopless delta");
    assert!(
        instructions.starts_with("当前轮推进准则"),
        "stopless must add only the current-turn delta to the runtime guidance field after canonicalization: {instructions}"
    );
    assert_eq!(
        instructions.matches("当前轮推进准则").count(),
        1,
        "stopless current-turn delta must be appended exactly once: {instructions}"
    );
    assert!(
        governed.payload()["messages"]
            .as_array()
            .expect("canonical messages")
            .iter()
            .any(|message| {
                message.get("role").and_then(Value::as_str) == Some("system")
                    && message.get("content").and_then(Value::as_str)
                        == Some("original client instruction")
            }),
        "canonical system message must preserve the original instruction unchanged while stopless adds a separate current-turn delta: {}",
        governed.payload()
    );
    let serialized = serde_json::to_string(governed.payload()).unwrap();
    assert!(
        serialized.contains("original client instruction"),
        "stopless must preserve the original client instruction while adding its delta: {serialized}"
    );
    assert_full_stopless_system_guidance(instructions);
    let tools = governed.payload()["tools"]
        .as_array()
        .expect("provider tools");
    assert_eq!(tools[0], payload["tools"][0]);
    assert_eq!(
        tools
            .iter()
            .filter(|tool| tool.get("name").and_then(Value::as_str) == Some("reasoningStop"))
            .count(),
        1,
        "stopless request must append exactly one reasoningStop schema"
    );
    assert_eq!(
        governed.payload()["tool_choice"],
        json!("required"),
        "stopless must require a tool decision; otherwise provider can ignore the schema and emit repeated natural stop"
    );
    for forbidden in [
        "routecodex hook run reasoningStop",
        "call_stopless_reasoning",
        "repeatCount",
        "schemaFeedback",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "provider request leaked bridge/control artifact {forbidden}: {serialized}"
        );
    }
}

#[test]
fn stopless_request_hook_removes_stale_generated_system_guidance_before_reinjecting_current_delta()
{
    let hooks = compile_v3_hub_relay_request_hooks();
    let stale_guidance = "当前轮推进准则（当前轮继续推进准则，仅用于当前轮，不改变原用户目标或系统指令优先级）：\n- 继续当前目标。\n- 停止时使用 reasoningStop。";
    let governed = hooks
        .run(
            raw(json!({
                "input":[
                    {
                        "role":"system",
                        "content": format!("restored real system prefix\n\n{stale_guidance}")
                    },
                    {
                        "role":"system",
                        "content": stale_guidance
                    },
                    {"role":"user","content":"继续目标"},
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
                ],
                "tools":[{"type":"function","name":"exec","description":"original tool"}],
                "tool_choice":"auto"
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();

    let serialized = serde_json::to_string(governed.payload()).unwrap();
    assert_eq!(
        serialized.matches("当前轮推进准则").count(),
        1,
        "restored generated system guidance is current-turn only and must not accumulate: {serialized}"
    );
    assert!(
        serialized.contains("restored real system prefix"),
        "real restored system prefix must be preserved while removing stale stopless suffix: {serialized}"
    );
    assert!(
        !serialized.contains("停止时使用 reasoningStop"),
        "stale generated stopless guidance must be removed from restored history: {serialized}"
    );
    assert_eq!(
        governed.payload()["tool_choice"],
        json!("required"),
        "current managed turn still requires a provider-visible tool decision"
    );
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

    assert!(governed.payload().get("input").is_none());
    assert_eq!(governed.payload()["messages"][0]["role"], "user");
    assert_eq!(
        governed.payload()["messages"][0]["content"],
        "keep codex tool declarations"
    );
    let tools = governed.payload()["tools"].as_array().unwrap();
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
