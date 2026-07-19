use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, compile_v3_hub_relay_request_hooks,
    V3HubContinuationLookup, V3HubContinuationOwnership, V3HubContinuationScope,
    V3HubEntryProtocol, V3HubInvocationSource, V3HubRelayRequestError, V3HubRelayRequestHookEvent,
    V3HubRequestSemanticProtocol, V3HubServertoolRequestProfile, V3HubTransportIntent,
};
use serde_json::{json, Value};
use std::{fs, path::Path};

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

fn real_5555_sample_json(sample_dir_name: &str, file_name: &str) -> Option<Value> {
    let home = std::env::var_os("HOME")?;
    for base in [
        Path::new(&home).join(".rcc/codex-samples/openai-responses/ports/5555"),
        Path::new(&home).join(".rcc/codex-samples/openai-responses/port-5555"),
    ] {
        let file = base.join(sample_dir_name).join(file_name);
        if !file.exists() {
            continue;
        }
        let content = fs::read_to_string(file).ok()?;
        return serde_json::from_str(&content).ok();
    }
    None
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
                "input":[{"type":"function_call_output","call_id":"call_stopless_reasoning","output":"{\"next_step\":\"continue with exact next step\"}"}],
                "tools":[
                    {"type":"function","name":"exec_command","description":"run command","parameters":{"type":"object","properties":{"cmd":{"type":"string"}}}},
                    {"type":"function","name":"request_user_input","description":"ask user","parameters":{"type":"object","properties":{"question":{"type":"string"}}}}
                ]
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
    let tools = governed.payload()["tools"]
        .as_array()
        .expect("stopless restore must preserve original tools and append reasoningStop");
    assert_eq!(tools.len(), 3);
    assert_eq!(tools[0]["name"], "exec_command");
    assert_eq!(tools[0]["description"], "run command");
    assert_eq!(tools[1]["name"], "request_user_input");
    assert_eq!(tools[1]["description"], "ask user");
    assert_eq!(tools[2]["name"], "reasoningStop");
    assert_eq!(
        tools
            .iter()
            .filter(|tool| tool.get("name").and_then(Value::as_str) == Some("reasoningStop"))
            .count(),
        1
    );
    let instructions = governed.payload()["instructions"].as_str().unwrap();
    assert!(instructions.contains("stopreason"));
    assert!(instructions.contains("reasoningStop"));
    let serialized = serde_json::to_string(governed.payload()).unwrap();
    assert!(!serialized.contains("call_stopless_reasoning"));
    assert!(!serialized.contains("routecodex hook run reasoningStop"));
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
fn stopless_request_hook_captures_repeat_state_from_current_cli_output() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("rcc_stopless_state"), scope())
        .with_local_context(
            "rcc_stopless_state",
            scope(),
            json!({
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_stopless_reasoning",
                    "name":"exec_command",
                    "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"no_schema\\\"}'\"}"
                }]
            }),
        );
    let governed = hooks
        .run(
            raw(json!({
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{\"ok\":true,\"continuationPrompt\":\"继续。\",\"repeatCount\":1,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\",\"repeatCount\":1,\"maxRepeats\":3}}"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();
    let state = governed
        .stopless_state()
        .expect("current CLI output must become hook-carried state");
    assert_eq!(state.repeat_count(), 1);
    assert_eq!(state.max_repeats(), 3);
    assert_eq!(state.trigger_hint(), Some("no_schema"));
    assert_eq!(
        governed.payload()["input"],
        json!([{"role":"user","content":"继续。"}])
    );
    assert_eq!(governed.tool_output_count(), 0);
}

#[test]
fn stopless_request_hook_captures_repeat_state_from_codex_transcript_output() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("rcc_stopless_state_transcript"), scope())
        .with_local_context(
            "rcc_stopless_state_transcript",
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
                    "output":"Chunk ID: abc\nOutput:\n{\"ok\":true,\"continuationPrompt\":\"继续。\",\"repeatCount\":2,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\"}}\n"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();
    let state = governed
        .stopless_state()
        .expect("Codex transcript JSON must still carry repeat state");
    assert_eq!(state.repeat_count(), 2);
    assert_eq!(state.max_repeats(), 3);
    assert_eq!(state.trigger_hint(), Some("no_schema"));
}

#[test]
fn stopless_request_hook_tool_errors_after_stopless_pair_do_not_reset_state() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "model":"gpt-5.5",
                "stream":true,
                "input":[
                    {
                        "type":"function_call",
                        "call_id":"call_stopless_reasoning",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":2,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"no_schema\\\"}' --repeat-count '2' --max-repeats '3'\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_stopless_reasoning",
                        "output":"Chunk ID: stopless\nOutput:\n{\"ok\":true,\"continuationPrompt\":\"继续。\",\"repeatCount\":2,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\",\"repeatCount\":2,\"maxRepeats\":3}}\n"
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_auto_1",
                        "name":"exec_command",
                        "arguments":"{}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_auto_1",
                        "output":"failed to parse function arguments: missing field `cmd` at line 1 column 2"
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_auto_2",
                        "name":"tools",
                        "arguments":"{}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_auto_2",
                        "output":"unsupported call: tools"
                    }
                ]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();

    let state = governed
        .stopless_state()
        .expect("tool parse/unsupported errors after a stopless pair are not progress resets");
    assert_eq!(state.repeat_count(), 2);
    assert_eq!(state.max_repeats(), 3);
    assert_eq!(state.trigger_hint(), Some("no_schema"));
    let input = governed.payload()["input"].as_array().unwrap();
    assert_eq!(input[0], json!({"role":"user","content":"继续。"}));
    assert_eq!(input.len(), 1);
    assert_eq!(input[0], json!({"role":"user","content":"继续。"}));
    assert_eq!(governed.tool_output_count(), 0);
    let serialized = serde_json::to_string(governed.payload()).unwrap();
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "Chunk ID: stopless",
        "call_auto_1",
        "call_auto_2",
        "failed to parse function arguments",
        "unsupported call: tools",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "request leaked stopless artifact or client tool error: {forbidden}"
        );
    }
}

#[test]
fn stopless_request_hook_poisoned_later_repeat_one_does_not_reset_repeat_state() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "model":"gpt-5.5",
                "stream":true,
                "input":[
                    {
                        "role":"user",
                        "content":"1. direct 是否锁住不走 stopless？\n2. 全局是否有 stopless 停止的 schema 引导？"
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_stopless_reasoning",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"no_schema\\\"}' --repeat-count '1' --max-repeats '3'\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_stopless_reasoning",
                        "output":"Chunk ID: r1\nOutput:\n{\"ok\":true,\"continuationPrompt\":\"继续。\",\"repeatCount\":1,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\",\"repeatCount\":1,\"maxRepeats\":3}}\n"
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_stopless_reasoning",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":2,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"no_schema\\\"}' --repeat-count '2' --max-repeats '3'\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_stopless_reasoning",
                        "output":"Chunk ID: r2\nOutput:\n{\"ok\":true,\"continuationPrompt\":\"继续。\",\"repeatCount\":2,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\",\"repeatCount\":2,\"maxRepeats\":3}}\n"
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_auto_1",
                        "name":"exec_command",
                        "arguments":"{}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_auto_1",
                        "output":"failed to parse function arguments: missing field `cmd` at line 1 column 2"
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_auto_1",
                        "name":"tools",
                        "arguments":"{}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_auto_1",
                        "output":"unsupported call: tools"
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_stopless_reasoning",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"no_schema\\\"}' --repeat-count '1' --max-repeats '3'\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_stopless_reasoning",
                        "output":"Chunk ID: poisoned-r1\nOutput:\n{\"ok\":true,\"continuationPrompt\":\"继续。\",\"repeatCount\":1,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\",\"repeatCount\":1,\"maxRepeats\":3}}\n"
                    }
                ]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();

    let state = governed
        .stopless_state()
        .expect("poisoned repeatCount=1 tail must not erase same-segment repeatCount=2");
    assert_eq!(state.repeat_count(), 2);
    assert_eq!(state.max_repeats(), 3);
    assert_eq!(state.trigger_hint(), Some("no_schema"));
    let input = governed.payload()["input"].as_array().unwrap();
    assert_eq!(input.len(), 2);
    assert_eq!(input[0]["role"], "user");
    assert_eq!(input[1], json!({"role":"user","content":"继续。"}));
    assert_eq!(governed.tool_output_count(), 0);
    let serialized = serde_json::to_string(governed.payload()).unwrap();
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "repeatCount",
        "call_auto_1",
        "failed to parse function arguments",
        "unsupported call: tools",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "poisoned request leaked stopless or client tool error state: {forbidden}"
        );
    }
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
        "input":[{"role":"user","content":"keep this user turn"}],
        "tools":[
            {"type":"function","name":"exec_command","description":"run command","parameters":{"type":"object"}},
            {"type":"function","name":"request_user_input","description":"ask","parameters":{"type":"object"}}
        ]
    });
    let governed = hooks
        .run(
            raw(payload.clone()),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(governed.payload()["input"], payload["input"]);
    let tools = governed.payload()["tools"]
        .as_array()
        .expect("stopless-managed request must preserve and extend provider tools");
    assert_eq!(tools.len(), 3);
    assert_eq!(tools[0]["name"], "exec_command");
    assert_eq!(tools[1]["name"], "request_user_input");
    assert_eq!(tools[2]["name"], "reasoningStop");
    assert_eq!(tools[2]["type"], "function");
    assert!(tools[2]["description"]
        .as_str()
        .unwrap()
        .contains("Use this tool when you stop, pause, or need another turn."));
    assert!(tools[2]["description"]
        .as_str()
        .unwrap()
        .contains("Provide stop schema as JSON arguments"));
    assert!(tools[2]["parameters"]["properties"]
        .as_object()
        .unwrap()
        .contains_key("stopreason"));
    assert!(!tools[2]["parameters"]["properties"]
        .as_object()
        .unwrap()
        .contains_key("simple_question"));
    assert_eq!(governed.tool_output_count(), 0);
    assert!(governed.payload()["instructions"]
        .as_str()
        .unwrap()
        .contains("stopreason"));
    assert!(governed.payload()["instructions"]
        .as_str()
        .unwrap()
        .contains("reasoningStop"));
    assert!(governed.payload()["instructions"]
        .as_str()
        .unwrap()
        .contains("最小可复制样本"));
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
fn stopless_request_hook_malformed_tools_is_fail_fast_not_silent_replaced() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let error = hooks
        .run(
            raw(json!({
                "model":"client-responses",
                "input":[{"role":"user","content":"malformed tools must not be replaced"}],
                "tools":{"type":"function","name":"exec_command"}
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .expect_err("stopless injection must fail fast instead of replacing malformed tools");
    assert!(matches!(
        error,
        V3HubRelayRequestError::MalformedStoplessToolSurface {
            field: "tools",
            reason: "tools must be an array; refusing to replace client tool surface"
        }
    ));
}

#[test]
fn stopless_request_hook_existing_instruction_is_idempotent() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "instructions":"existing stopreason contract with reasoningStop and <rcc_stop_schema>",
                "input":[{"role":"user","content":"keep"}],
                "tools":[{"type":"function","name":"reasoningStop","parameters":{"type":"object"}}]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();
    let instructions = governed.payload()["instructions"].as_str().unwrap();
    assert_eq!(
        instructions,
        "existing stopreason contract with reasoningStop and <rcc_stop_schema>"
    );
    assert_eq!(instructions.matches("stopreason").count(), 1);
    let tools = governed.payload()["tools"].as_array().expect("tools array");
    assert_eq!(
        tools
            .iter()
            .filter(|tool| tool.get("name").and_then(Value::as_str) == Some("reasoningStop"))
            .count(),
        1
    );
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
    assert_eq!(governed.payload()["input"][0]["type"], "function_call");
    assert_eq!(
        governed.payload()["input"][1]["type"],
        "function_call_output"
    );
    assert_eq!(
        governed.payload()["input"][1]["output"],
        "{\"next_step\":\"must not be rewritten\"}"
    );
    assert!(governed.payload().get("instructions").is_none());
    assert!(governed.payload().get("tools").is_none());
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
fn stopless_request_hook_disabled_profile_keeps_codex_transcript_unparsed() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "input":[
                    {
                        "type":"function_call",
                        "call_id":"call_stopless_reasoning",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{}'\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_stopless_reasoning",
                        "output":"Chunk ID: 2c3627\nOutput:\nnot json\n"
                    }
                ]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert_eq!(governed.tool_output_count(), 1);
    assert_eq!(governed.payload()["input"][0]["type"], "function_call");
    assert_eq!(
        governed.payload()["input"][1]["type"],
        "function_call_output"
    );
    assert_eq!(
        governed.payload()["input"][1]["output"],
        "Chunk ID: 2c3627\nOutput:\nnot json\n"
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
fn stopless_request_hook_accepts_cli_continuation_prompt() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("rcc_stopless_continuation_prompt"), scope())
        .with_local_context(
            "rcc_stopless_continuation_prompt",
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
                    "output":"{\"continuationPrompt\":\"继续。\"}"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(
        governed.payload()["input"],
        json!([{"role":"user","content":"继续。"}])
    );
    assert_eq!(governed.tool_output_count(), 0);
}

#[test]
fn stopless_request_hook_accepts_codex_exec_command_output_transcript() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("rcc_stopless_codex_transcript"), scope())
        .with_local_context(
            "rcc_stopless_codex_transcript",
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
                    "output":"Chunk ID: 2c3627\nWall time: 0.1169 seconds\nProcess exited with code 0\nOriginal token count: 82\nOutput:\n{\"ok\":true,\"continuationPrompt\":\"继续。\",\"input\":{\"triggerHint\":\"no_schema\"}}\n"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(
        governed.payload()["input"],
        json!([{"role":"user","content":"继续。"}])
    );
    assert_eq!(governed.tool_output_count(), 0);
}

#[test]
fn stopless_request_hook_strips_structured_shell_pair_without_removing_user_text_mentions() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "input":[
                    {
                        "role":"user",
                        "content":"请检查这段文档文字：routecodex hook run reasoningStop 只是文本，不是本轮 shell artifact。"
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_stopless_reasoning",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{}'\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_stopless_reasoning",
                        "output":"Chunk ID: text\nOutput:\n{\"ok\":true,\"continuationPrompt\":\"继续结构化清理。\",\"repeatCount\":1,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\"}}\n"
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_regular_output",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"printf ordinary\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_regular_output",
                        "output":"ordinary function_call_output must stay"
                    }
                ],
                "tools":[{"type":"function","name":"exec_command","parameters":{"type":"object"}}]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();

    let input = governed.payload()["input"].as_array().expect("input array");
    assert_no_structured_stopless_shell_artifacts(input);
    assert!(input.iter().any(|item| {
        item.get("role").and_then(Value::as_str) == Some("user")
            && item
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| content.contains("routecodex hook run reasoningStop"))
    }));
    assert!(input.iter().any(|item| {
        item.get("call_id").and_then(Value::as_str) == Some("call_regular_output")
            && item.get("type").and_then(Value::as_str) == Some("function_call_output")
    }));
    let tools = governed.payload()["tools"].as_array().expect("tools array");
    assert!(tools
        .iter()
        .any(|tool| tool.get("name").and_then(Value::as_str) == Some("exec_command")));
    assert!(tools
        .iter()
        .any(|tool| tool.get("name").and_then(Value::as_str) == Some("reasoningStop")));
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

#[test]
fn stopless_request_hook_rewrites_latest_real_5555_sample_pair_and_strips_stale_pair() {
    let sample = real_5555_sample_json(
        "openai-responses-router-gpt-5.5-20260718T175824023-567209-6198",
        "request.json",
    );
    let Some(sample) = sample else {
        return;
    };
    let input = sample["input"].as_array().expect("sample input array");
    assert!(
        input.len() >= 10,
        "real 5555 sample must have a replayable tail"
    );

    let tail: Vec<Value> = input[input.len() - 10..].to_vec();
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx_real_5555_stopless"), scope())
        .with_local_context(
            "ctx_real_5555_stopless",
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
                "model": sample.get("model").cloned().unwrap_or_else(|| json!("gpt-5.5")),
                "stream": sample.get("stream").cloned().unwrap_or_else(|| json!(true)),
                "input": tail,
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();

    let governed_input = governed.payload()["input"]
        .as_array()
        .expect("governed input array");
    assert_eq!(governed_input.len(), 7);
    assert_eq!(
        governed_input.last().unwrap(),
        &json!({"role":"user","content":"继续。"})
    );
    assert!(governed_input.iter().any(|item| {
        item.get("role").and_then(Value::as_str) == Some("user")
            && item
                .get("content")
                .map(Value::to_string)
                .is_some_and(|content| content.contains("只读审计"))
    }));
    assert!(governed_input
        .iter()
        .any(|item| item.get("type").and_then(Value::as_str) == Some("custom_tool_call_output")));
    let state = governed
        .stopless_state()
        .expect("sample replay must carry stopless state");
    assert_eq!(state.repeat_count(), 2);
    assert_eq!(state.max_repeats(), 3);
    assert_eq!(state.trigger_hint(), Some("no_schema"));
    assert!(governed.payload()["instructions"]
        .as_str()
        .expect("instructions")
        .contains("stopreason"));
    assert_no_structured_stopless_shell_artifacts(governed_input);
}

#[test]
fn stopless_request_hook_real_progress_after_stopless_pair_resets_state_and_preserves_tools() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let governed = hooks
        .run(
            raw(json!({
                "model":"gpt-5.5",
                "stream":true,
                "input":[
                    {
                        "role":"developer",
                        "content":"preserve tool catalog holder",
                        "tools":[
                            {"name":"exec_command","description":"run command"},
                            {"name":"request_user_input","description":"ask user"}
                        ]
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_stopless_reasoning",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"repeatCount\\\":2,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"no_schema\\\"}'\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_stopless_reasoning",
                        "output":"Chunk ID: stale\nOutput:\n{\"ok\":true,\"continuationPrompt\":\"继续。\",\"repeatCount\":2,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\"}}\n"
                    },
                    {"role":"user","content":"奶继续检查，我已经补了一些测试了"},
                    {
                        "type":"function_call",
                        "call_id":"call_real_exec",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"git log --oneline -10\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_real_exec",
                        "output":"2fde79946 fix(v3): preserve stopless followup context"
                    }
                ]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();

    assert!(
        governed.stopless_state().is_none(),
        "real user/tool progress after an old stopless pair must reset the consecutive stopless state"
    );
    let input = governed.payload()["input"].as_array().unwrap();
    assert_eq!(input.len(), 4);
    assert_eq!(input[0]["tools"][0]["name"], "exec_command");
    assert_eq!(input[0]["tools"][1]["name"], "request_user_input");
    assert_eq!(input[1]["role"], "user");
    assert_eq!(input[1]["content"], "奶继续检查，我已经补了一些测试了");
    assert_eq!(input[2]["call_id"], "call_real_exec");
    assert_eq!(input[3]["call_id"], "call_real_exec");
    assert_eq!(governed.tool_output_count(), 1);
    assert!(governed.payload()["instructions"]
        .as_str()
        .expect("instructions")
        .contains("stopreason"));
    let serialized = serde_json::to_string(governed.payload()).unwrap();
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "repeatCount",
        "Chunk ID: stale",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "reset-boundary request leaked stale stopless artifact: {forbidden}"
        );
    }
}
