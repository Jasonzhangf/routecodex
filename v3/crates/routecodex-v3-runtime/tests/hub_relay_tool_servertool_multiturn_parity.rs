use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw,
    build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04,
    build_v3_provider_resp_inbound_01_raw,
    build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05,
    compile_v3_hub_relay_request_hooks, compile_v3_hub_relay_response_hooks,
    V3HubContinuationCommit, V3HubContinuationLookup, V3HubContinuationOwnership,
    V3HubContinuationScope, V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource,
    V3HubProviderWireProtocol, V3HubRelayRequestError, V3HubRelayRequestHookEvent,
    V3HubRelayResponseError, V3HubRelayResponseHookProfile, V3HubRelayToolKind,
    V3HubServertoolRequestProfile, V3HubServertoolResponseAction, V3HubTransportIntent,
    V3StoplessCenterState, V3StoplessCenterSteering,
};
use serde_json::{json, Value};

fn scope() -> V3HubContinuationScope {
    scope_for(V3HubEntryProtocol::Responses)
}

fn scope_for(entry_protocol: V3HubEntryProtocol) -> V3HubContinuationScope {
    V3HubContinuationScope::new(
        entry_protocol,
        "server-tool-parity",
        "relay-tool-parity",
        "session-tool-parity",
    )
}

fn raw_request(payload: Value) -> routecodex_v3_runtime::V3HubReqInbound01ClientRaw {
    raw_request_for(
        payload,
        V3HubEntryProtocol::Responses,
        V3HubTransportIntent::Json,
    )
}

fn raw_request_for(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    transport_intent: V3HubTransportIntent,
) -> routecodex_v3_runtime::V3HubReqInbound01ClientRaw {
    build_v3_hub_req_inbound_01_client_raw(
        payload,
        entry_protocol,
        V3HubInvocationSource::Client,
        transport_intent,
    )
}

fn relay_response(
    payload: Value,
    transport: V3HubTransportIntent,
) -> routecodex_v3_runtime::V3ProviderRespInbound01Raw {
    relay_response_for(payload, V3HubEntryProtocol::Responses, transport)
}

fn relay_response_for(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    transport: V3HubTransportIntent,
) -> routecodex_v3_runtime::V3ProviderRespInbound01Raw {
    build_v3_provider_resp_inbound_01_raw(
        payload,
        entry_protocol,
        provider_protocol_for_entry(entry_protocol),
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        transport,
    )
}

fn active_stopless_response_profile(
    consecutive_stop_count: u32,
    request_id: &'static str,
) -> V3HubRelayResponseHookProfile {
    V3HubRelayResponseHookProfile::empty()
        .with_stopless_reasoning_stop()
        .with_stopless_transition_context(request_id, 88_000)
        .with_stopless_center_state(
            V3StoplessCenterState::new(
                consecutive_stop_count,
                3,
                V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
            )
            .provider_turn_in_flight(Some(request_id), Some(88_000)),
        )
}

fn web_search_response_profile() -> V3HubRelayResponseHookProfile {
    V3HubRelayResponseHookProfile::empty().with_servertool_name("web_search")
}

fn provider_protocol_for_entry(entry_protocol: V3HubEntryProtocol) -> V3HubProviderWireProtocol {
    match entry_protocol {
        V3HubEntryProtocol::Responses => V3HubProviderWireProtocol::Responses,
        V3HubEntryProtocol::Anthropic => V3HubProviderWireProtocol::Responses,
        V3HubEntryProtocol::Gemini => V3HubProviderWireProtocol::Gemini,
        V3HubEntryProtocol::OpenAiChat => V3HubProviderWireProtocol::OpenAiChat,
    }
}

fn restored_multitool_context() -> Value {
    json!({
        "id": "resp_tool_parity",
        "status": "requires_action",
        "output": [
            {"type":"function_call","call_id":"call_function","name":"lookup","arguments":"{}"},
            {"type":"custom_tool_call","call_id":"call_custom","name":"custom.render","input":"{}"},
            {"type":"function_call","call_id":"call_servertool","name":"servertool.exec","arguments":"{}"},
            {"type":"function_call","call_id":"call_apply_patch","name":"apply_patch","arguments":"{}"},
            {"type":"function_call","call_id":"call_mcp","name":"mcp.read_file","arguments":"{}"},
            {"type":"function_call","call_id":"call_native","name":"native.exec_command","arguments":"{}"}
        ]
    })
}

fn restored_multitool_chat_context() -> Value {
    json!({
        "messages": [
            {"role":"assistant","tool_calls":[
                {"id":"call_function","type":"function","function":{"name":"lookup","arguments":"{}"}},
                {"id":"call_custom","type":"function","function":{"name":"custom.render","arguments":"{}"},"routecodex_chat_extension":{"responses_tool_call_type":"custom_tool_call"}},
                {"id":"call_servertool","type":"function","function":{"name":"servertool.exec","arguments":"{}"}},
                {"id":"call_apply_patch","type":"function","function":{"name":"apply_patch","arguments":"{}"}},
                {"id":"call_mcp","type":"function","function":{"name":"mcp.read_file","arguments":"{}"}},
                {"id":"call_native","type":"function","function":{"name":"native.exec_command","arguments":"{}"}}
            ]}
        ]
    })
}

fn restored_multitool_provider_response_for_entry(entry_protocol: V3HubEntryProtocol) -> Value {
    match provider_protocol_for_entry(entry_protocol) {
        V3HubProviderWireProtocol::Responses => restored_multitool_context(),
        V3HubProviderWireProtocol::OpenAiChat => json!({
            "id": "chatcmpl_tool_parity",
            "object": "chat.completion",
            "choices": [{
                "index": 0,
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "tool_calls": [
                        {"id":"call_function","type":"function","function":{"name":"lookup","arguments":"{}"}},
                        {"id":"call_custom","type":"function","function":{"name":"custom.render","arguments":"{}"}},
                        {"id":"call_servertool","type":"function","function":{"name":"servertool.exec","arguments":"{}"}},
                        {"id":"call_apply_patch","type":"function","function":{"name":"apply_patch","arguments":"{}"}},
                        {"id":"call_mcp","type":"function","function":{"name":"mcp.read_file","arguments":"{}"}},
                        {"id":"call_native","type":"function","function":{"name":"native.exec_command","arguments":"{}"}}
                    ]
                }
            }]
        }),
        V3HubProviderWireProtocol::Gemini => json!({
            "candidates": [{
                "finishReason": "STOP",
                "content": {
                    "parts": [
                        {"functionCall":{"name":"lookup","args":{}}},
                        {"functionCall":{"name":"custom.render","args":{}}},
                        {"functionCall":{"name":"servertool.exec","args":{}}},
                        {"functionCall":{"name":"apply_patch","args":{}}},
                        {"functionCall":{"name":"mcp.read_file","args":{}}},
                        {"functionCall":{"name":"native.exec_command","args":{}}}
                    ]
                }
            }]
        }),
        V3HubProviderWireProtocol::Anthropic => {
            unreachable!("relay matrix maps Anthropic entry to Responses provider wire")
        }
    }
}

fn expected_multitool_response_kinds_for_entry(
    entry_protocol: V3HubEntryProtocol,
) -> Vec<V3HubRelayToolKind> {
    match provider_protocol_for_entry(entry_protocol) {
        V3HubProviderWireProtocol::Responses => vec![
            V3HubRelayToolKind::Function,
            V3HubRelayToolKind::Custom,
            V3HubRelayToolKind::Servertool,
            V3HubRelayToolKind::ApplyPatch,
            V3HubRelayToolKind::Mcp,
            V3HubRelayToolKind::Native,
        ],
        V3HubProviderWireProtocol::OpenAiChat | V3HubProviderWireProtocol::Gemini => vec![
            V3HubRelayToolKind::Function,
            V3HubRelayToolKind::Function,
            V3HubRelayToolKind::Servertool,
            V3HubRelayToolKind::ApplyPatch,
            V3HubRelayToolKind::Mcp,
            V3HubRelayToolKind::Native,
        ],
        V3HubProviderWireProtocol::Anthropic => {
            unreachable!("relay matrix maps Anthropic entry to Responses provider wire")
        }
    }
}

fn current_tool_round_payload() -> Value {
    json!({
        "input": [
            {"type":"function_call","call_id":"call_current","name":"lookup","arguments":"{}"},
            {"type":"function_call_output","call_id":"call_current","output":"current ok"}
        ]
    })
}

fn restored_tool_output_payload_for_entry(entry: V3HubEntryProtocol) -> Value {
    match entry {
        V3HubEntryProtocol::Responses => json!({
            "input":[{
                "type":"function_call_output",
                "call_id":"call_function",
                "output":"restored ok"
            }]
        }),
        V3HubEntryProtocol::Anthropic => json!({
            "messages":[{
                "role":"user",
                "content":[{
                    "type":"tool_result",
                    "tool_use_id":"call_function",
                    "content":"restored ok"
                }]
            }]
        }),
        V3HubEntryProtocol::OpenAiChat | V3HubEntryProtocol::Gemini => json!({
            "messages":[{
                "role":"tool",
                "tool_call_id":"call_function",
                "content":"restored ok"
            }]
        }),
    }
}

#[test]
fn protocol_transport_continuation_matrix_uses_one_chat_process_governance_path() {
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let entries = [
        V3HubEntryProtocol::Responses,
        V3HubEntryProtocol::Anthropic,
        V3HubEntryProtocol::OpenAiChat,
        V3HubEntryProtocol::Gemini,
    ];
    let transports = [V3HubTransportIntent::Json, V3HubTransportIntent::Sse];

    for entry in entries {
        for transport in transports {
            let matrix_scope = scope_for(entry);
            let new_outcome = request_hooks
                .run(
                    raw_request_for(current_tool_round_payload(), entry, transport),
                    &V3HubContinuationLookup::new(None, matrix_scope.clone()),
                    &V3HubServertoolRequestProfile::disabled(),
                )
                .expect("new/current-history tool output must be governed at Req04");
            assert_eq!(new_outcome.continuation(), V3HubContinuationOwnership::New);
            assert_eq!(new_outcome.tool_output_count(), 1);

            let local_lookup =
                V3HubContinuationLookup::new(Some("ctx_tool_parity"), matrix_scope.clone())
                    .with_local_context(
                        "ctx_tool_parity",
                        matrix_scope.clone(),
                        restored_multitool_chat_context(),
                    );
            let local_outcome = request_hooks
                .run(
                    raw_request_for(
                        restored_tool_output_payload_for_entry(entry),
                        entry,
                        transport,
                    ),
                    &local_lookup,
                    &V3HubServertoolRequestProfile::enabled(["servertool.request"]),
                )
                .expect("restored continuation tool output must be governed at Req04");
            assert_eq!(
                local_outcome.continuation(),
                V3HubContinuationOwnership::RouteCodexLocalOwned
            );
            assert!(local_outcome.restored_local_context());
            assert_eq!(local_outcome.tool_output_count(), 1);

            let remote_lookup =
                V3HubContinuationLookup::new(Some("remote_tool_parity"), matrix_scope.clone())
                    .with_remote_binding("remote_tool_parity", matrix_scope);
            let remote_outcome = request_hooks
                .run(
                    raw_request_for(
                        json!({"input":[{"role":"user","content":"continue"}]}),
                        entry,
                        transport,
                    ),
                    &remote_lookup,
                    &V3HubServertoolRequestProfile::disabled(),
                )
                .expect("remote continuation classification must not local-restore relay history");
            assert_eq!(
                remote_outcome.continuation(),
                V3HubContinuationOwnership::RemoteProviderOwned
            );
            assert!(!remote_outcome.restored_local_context());

            let resp02 = response_hooks
                .normalize(relay_response_for(
                    restored_multitool_provider_response_for_entry(entry),
                    entry,
                    transport,
                ))
                .expect("entry/transport response normalizes before Resp03");
            let resp03 = response_hooks
                .govern(
                    resp02,
                    &V3HubRelayResponseHookProfile::new(["servertool.exec"]),
                )
                .expect("entry/transport response tool harvest is governed at Resp03");
            assert_eq!(
                resp03.tool_call_kinds(),
                expected_multitool_response_kinds_for_entry(entry)
            );
        }
    }
}

#[test]
fn request_governance_matches_function_custom_servertool_and_internal_tool_outputs_to_restored_context(
) {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx_tool_parity"), scope()).with_local_context(
        "ctx_tool_parity",
        scope(),
        restored_multitool_chat_context(),
    );
    let outcome = hooks
        .run(
            raw_request(json!({
                "input": [
                    {"type":"function_call_output","call_id":"call_function","output":"function ok"},
                    {"type":"custom_tool_call_output","call_id":"call_custom","output":"custom ok"},
                    {"type":"function_call_output","call_id":"call_servertool","output":"servertool ok"},
                    {"type":"function_call_output","call_id":"call_apply_patch","output":"patch ok"},
                    {"type":"function_call_output","call_id":"call_mcp","output":"mcp ok"},
                    {"type":"function_call_output","call_id":"call_native","output":"native ok"}
                ]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::enabled(["servertool.request"]),
        )
        .expect("Req04 tool governance accepts only outputs backed by restored tool calls");

    assert!(outcome.restored_local_context());
    assert_eq!(outcome.tool_output_count(), 6);
}

#[test]
fn apply_patch_response_is_projected_to_freeform_custom_tool_before_commit() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let patch = "*** Begin Patch\n*** Update File: src/main.rs\n@@\n-old\n+new\n*** End Patch";
    let resp02 = hooks
        .normalize(relay_response(
            json!({
                "id":"resp_apply_patch",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_apply_patch_freeform",
                    "name":"apply_patch",
                    "arguments": serde_json::to_string(&json!({"patch": patch})).unwrap()
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .unwrap();
    assert_eq!(
        resp03.tool_call_kinds(),
        vec![V3HubRelayToolKind::ApplyPatch]
    );
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.canonical_context_payload().unwrap();
    assert_eq!(payload["output"][0]["type"], "custom_tool_call");
    assert_eq!(payload["output"][0]["name"], "apply_patch");
    assert_eq!(payload["output"][0]["call_id"], "call_apply_patch_freeform");
    assert_eq!(payload["output"][0]["input"], patch);
    assert!(payload["output"][0].get("arguments").is_none());
}

#[test]
fn apply_patch_tool_output_error_is_normalized_and_kept_as_next_turn_tool_output() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx_apply_patch"), scope()).with_local_context(
        "ctx_apply_patch",
        scope(),
        json!({
            "messages": [{
                "role": "assistant",
                "tool_calls": [{
                    "id": "call_apply_patch_freeform",
                    "type": "function",
                    "function": {
                        "name": "apply_patch",
                        "arguments": "*** Begin Patch\n*** Update File: src/main.rs\n@@\n-old\n+new\n*** End Patch"
                    }
                }]
            }]
        }),
    );
    let outcome = hooks
        .run(
            raw_request(json!({
                "input":[{
                    "type":"custom_tool_call_output",
                    "call_id":"call_apply_patch_freeform",
                    "output":"apply_patch verification failed: invalid patch for /tmp/codex-patch-test/new.txt"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
    )
        .unwrap();
    assert_eq!(outcome.tool_output_count(), 1);
    let output = chat_tool_output_content(outcome.payload(), "call_apply_patch_freeform").unwrap();
    assert!(output.starts_with("APPLY_PATCH_ERROR: apply_patch did not apply"));
    assert!(output.contains("Retry with apply_patch only"));
    assert!(output.contains("workspace-relative"));
    assert!(!output.contains("/tmp/codex-patch-test"));
}

#[test]
fn apply_patch_legacy_function_call_accepts_custom_output_after_client_projection() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx_apply_patch_legacy"), scope())
        .with_local_context(
            "ctx_apply_patch_legacy",
            scope(),
            json!({
                "messages": [{
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_apply_patch_legacy",
                        "type": "function",
                        "function": {"name": "apply_patch", "arguments": "{}"}
                    }]
                }]
            }),
        );
    let outcome = hooks
        .run(
            raw_request(json!({
                "input":[{
                    "type":"custom_tool_call_output",
                    "call_id":"call_apply_patch_legacy",
                    "output":"aborted"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert_eq!(outcome.tool_output_count(), 1);
    assert!(
        chat_tool_output_content(outcome.payload(), "call_apply_patch_legacy")
            .unwrap()
            .starts_with("APPLY_PATCH_ERROR:")
    );
}

fn stopless_noop_context(messages: Value, _output: Value) -> Value {
    json!({
        "messages": messages
    })
}

fn chat_tool_output_content<'a>(payload: &'a Value, call_id: &str) -> Option<&'a str> {
    payload["messages"]
        .as_array()?
        .iter()
        .find(|message| {
            message.get("role").and_then(Value::as_str) == Some("tool")
                && message.get("tool_call_id").and_then(Value::as_str) == Some(call_id)
        })
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
}

#[test]
fn stopless_hook_blackbox_projects_noop_cli_then_consumes_runtime_control_state() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_blackbox_stopless_noop",
                "object":"response",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"blackbox visible natural stop"}]}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &active_stopless_response_profile(0, "req-blackbox-stopless-noop"),
        )
        .unwrap();
    let resp04 = response_hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    assert_eq!(resp04.control_transition().unwrap().natural_stop_count(), 1);
    assert!(resp04.canonical_context_payload().is_none());
    let response_payload = serde_json::to_string(resp04.finalized_payload()).unwrap();
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
    ] {
        assert!(
            !response_payload.contains(forbidden),
            "response payload leaked StoplessCenter control {forbidden}: {response_payload}"
        );
    }

    let request_hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx-blackbox-stopless"), scope())
        .with_local_context(
            "ctx-blackbox-stopless",
            scope(),
            stopless_noop_context(
                json!([
                    {"role":"user","content":"original task"},
                    {"role":"assistant","content":"blackbox visible natural stop"},
                    {
                        "role":"assistant",
                        "tool_calls":[{
                            "id":"call_stopless_reasoning",
                            "type":"function",
                            "function":{
                                "name":"exec_command",
                                "arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"
                            }
                        }]
                    }
                ]),
                json!([]),
            ),
        );
    let governed = request_hooks
        .run(
            raw_request(json!({
                "input":[{"type":"function_call_output","call_id":"call_stopless_reasoning","output":""}],
                "tools":[{"type":"function","name":"exec","description":"original"}]
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
    let messages = governed.payload()["messages"]
        .as_array()
        .expect("provider messages");
    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages[0],
        json!({"role":"user","content":"original task"})
    );
    assert_eq!(
        messages[1].get("content").and_then(Value::as_str),
        Some("blackbox visible natural stop")
    );
    let serialized = serde_json::to_string(governed.payload()).unwrap();
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "--input-json",
        "repeatCount",
        "schemaFeedback",
        "<rcc_stop_schema>",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "provider request leaked stopless shell/control {forbidden}: {serialized}"
        );
    }
    assert!(governed.payload().get("instructions").is_none());
    let tool_names = governed.payload()["tools"]
        .as_array()
        .expect("provider tools")
        .iter()
        .map(|tool| tool.get("name").and_then(Value::as_str).unwrap_or_default())
        .collect::<Vec<_>>();
    assert!(
        tool_names.contains(&"exec"),
        "stopless Req04 must preserve the original client tool surface: {tool_names:?}"
    );
    assert_eq!(
        tool_names
            .iter()
            .filter(|tool_name| **tool_name == "reasoningStop")
            .count(),
        0
    );
}

#[test]
fn stopless_hook_blackbox_preserves_additional_tools_surface() {
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx-stopless-additional-tools"), scope())
        .with_local_context(
            "ctx-stopless-additional-tools",
            scope(),
            stopless_noop_context(
                json!([
                    {"role":"user","content":"original task"},
                    {
                        "role":"assistant",
                        "tool_calls":[{
                            "id":"call_stopless_reasoning",
                            "type":"function",
                            "function":{
                                "name":"exec_command",
                                "arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"
                            }
                        }]
                    }
                ]),
                json!([]),
            ),
        );
    let governed = request_hooks
        .run(
            raw_request(json!({
                "input":[
                    {
                        "type":"additional_tools",
                        "tools":[{"type":"function","name":"exec","description":"original embedded tool"}]
                    },
                    {"type":"function_call_output","call_id":"call_stopless_reasoning","output":""}
                ]
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

    assert!(
        governed.payload().get("input").is_none(),
        "ReqInbound must normalize additional_tools into the Chat tool surface"
    );
    let tools = governed.payload()["tools"]
        .as_array()
        .expect("provider tools");
    let tool_names = tools
        .iter()
        .map(|tool| tool.get("name").and_then(Value::as_str).unwrap_or_default())
        .collect::<Vec<_>>();
    assert!(
        tool_names.contains(&"exec"),
        "stopless Req04 must preserve embedded client tools: {tool_names:?}"
    );
    assert_eq!(
        tool_names
            .iter()
            .filter(|tool_name| **tool_name == "reasoningStop")
            .count(),
        0
    );
}

#[test]
fn stopless_hook_blackbox_preserves_unrelated_tool_history_while_stripping_stopless_pair() {
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let context = stopless_noop_context(
        json!([
            {"role":"user","content":"original task"},
            {
                "role":"assistant",
                "tool_calls":[{
                    "id":"call_unrelated",
                    "type":"function",
                    "function":{"name":"lookup","arguments":"{}"}
                }]
            },
            {"role":"tool","tool_call_id":"call_unrelated","content":"ok"},
            {"role":"assistant","content":"visible stop"},
            {
                "role":"assistant",
                "tool_calls":[{
                    "id":"call_stopless_reasoning",
                    "type":"function",
                    "function":{
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"
                    }
                }]
            }
        ]),
        json!([{"type":"function_call","call_id":"call_stopless_reasoning","name":"exec_command","arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"}]),
    );
    let lookup = V3HubContinuationLookup::new(Some("ctx-stopless-history"), scope())
        .with_local_context("ctx-stopless-history", scope(), context);
    let governed = request_hooks
        .run(
            raw_request(json!({
                "input":[{"type":"function_call_output","call_id":"call_stopless_reasoning","output":""}]
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
    let serialized = serde_json::to_string(governed.payload()).unwrap();
    assert!(serialized.contains("call_unrelated"));
    assert!(!serialized.contains("call_stopless_reasoning"));
    assert!(!serialized.contains("routecodex hook run reasoningStop"));
}

#[test]
fn stopless_hook_blackbox_terminal_reasoning_stop_skips_cli_roundtrip() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_blackbox_stopless_terminal",
                "object":"response",
                "status":"requires_action",
                "instructions":"client-visible instruction\n\n当前轮推进准则（当前轮继续推进准则，仅用于当前轮，不改变原用户目标或系统指令优先级）：\n- only internal stopless guidance",
                "tools":[{
                    "type":"function",
                    "name":"reasoningStop",
                    "parameters":{"type":"object"}
                }],
                "tool_choice":"required",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_model_reasoning_stop_terminal",
                    "name":"reasoningStop",
                    "arguments":"{\"stopreason\":0,\"evidence\":\"blackbox proof\"}"
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &active_stopless_response_profile(0, "req-blackbox-stopless-terminal"),
        )
        .unwrap();
    assert_eq!(
        resp03.terminality(),
        routecodex_v3_runtime::V3HubResponseTerminality::Terminal
    );
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = response_hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    let serialized = serde_json::to_string(resp04.finalized_payload()).unwrap();
    assert!(serialized.contains("blackbox proof"));
    assert!(serialized.contains("client-visible instruction"));
    assert!(!serialized.contains("当前轮推进准则"));
    assert!(resp04.finalized_payload().get("tool_choice").is_none());
    assert!(resp04.finalized_payload().get("tools").is_none());
    assert!(!serialized.contains("call_stopless_reasoning"));
    assert!(!serialized.contains("routecodex hook run reasoningStop"));
    assert!(!serialized.contains("reasoningStop"));
}

#[test]
fn stopless_hook_blackbox_natural_stop_strips_internal_control_echo_before_followup() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_blackbox_stopless_summary_clean",
                "object":"response",
                "status":"completed",
                "finish_reason":"stop",
                "instructions":"original client instruction\n\n当前轮推进准则（当前轮继续推进准则，仅用于当前轮，不改变原用户目标或系统指令优先级）：\n- internal guidance",
                "tools":[{
                    "type":"function",
                    "name":"reasoningStop",
                    "parameters":{"type":"object"}
                }],
                "tool_choice":"required",
                "output":[{
                    "type":"reasoning",
                    "summary":[{"type":"summary_text","text":"summary proof"}]
                },{
                    "type":"message",
                    "content":[{"type":"output_text","text":"visible answer"}]
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &active_stopless_response_profile(0, "req-blackbox-stopless-summary-clean"),
        )
        .unwrap();
    assert_eq!(
        resp03.terminality(),
        routecodex_v3_runtime::V3HubResponseTerminality::NonTerminal
    );
    let resp04 = response_hooks.commit(resp03).unwrap();
    assert!(resp04.control_transition().is_some());
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    let serialized = serde_json::to_string(resp04.finalized_payload()).unwrap();
    assert!(serialized.contains("summary proof"));
    assert!(serialized.contains("visible answer"));
    assert!(serialized.contains("original client instruction"));
    assert!(!serialized.contains("当前轮推进准则"));
    assert!(resp04.finalized_payload().get("tool_choice").is_none());
    assert!(resp04.finalized_payload().get("tools").is_none());
    assert!(!serialized.contains("call_stopless_reasoning"));
    assert!(!serialized.contains("routecodex hook run reasoningStop"));
    assert!(!serialized.contains("reasoningStop"));
}

#[test]
fn stopless_guard_terminal_strips_raw_stop_schema_text_without_cli_roundtrip() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_blackbox_stopless_guard_schema_text",
                "object":"response",
                "status":"completed",
                "finish_reason":"end_turn",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"{\"stopreason\":2,\"current_goal\":\"live guard\",\"reason\":\"not done\",\"evidence\":\"\",\"next_step\":\"PHASE_NEXT\",\"needs_user_input\":false}"}]
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &active_stopless_response_profile(3, "req-blackbox-stopless-guard-schema"),
        )
        .unwrap();
    assert_eq!(
        resp03.terminality(),
        routecodex_v3_runtime::V3HubResponseTerminality::Terminal
    );
    assert_eq!(
        resp03.servertool_action(),
        V3HubServertoolResponseAction::None
    );
    let resp04 = response_hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    let serialized = serde_json::to_string(resp04.finalized_payload()).unwrap();
    for forbidden in [
        "stopreason",
        "current_goal",
        "next_step",
        "PHASE_NEXT",
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "guard terminal must not leak raw stop schema/control marker {forbidden}: {serialized}"
        );
    }
}

#[test]
fn stopless_shaped_business_text_is_preserved_without_current_turn_activation() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let control_shaped_text = "{\"stopreason\":2,\"current_goal\":\"business data\",\"reason\":\"record\",\"evidence\":\"visible\",\"next_step\":\"none\",\"needs_user_input\":false}";
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_business_json",
                "object":"response",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":control_shaped_text}]
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .unwrap();
    let resp04 = response_hooks.commit(resp03).unwrap();

    assert_eq!(
        resp04.finalized_payload()["output"][0]["content"][0]["text"],
        control_shaped_text
    );
}

#[test]
fn malformed_current_turn_reasoning_stop_arguments_fail_without_guessing_control_state() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_malformed_reasoning_stop",
                "object":"response",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_malformed_reasoning_stop",
                    "name":"reasoningStop",
                    "arguments":"{not-json"
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let error = response_hooks
        .govern(
            resp02,
            &active_stopless_response_profile(0, "req-malformed-reasoning-stop"),
        )
        .expect_err("malformed current-turn reasoningStop arguments must fail explicitly");

    assert!(matches!(
        error,
        V3HubRelayResponseError::MalformedToolCall {
            reason: "reasoningStop tool call arguments must be valid JSON",
            ..
        }
    ));
}

#[test]
fn stopless_hook_blackbox_disabled_request_profile_keeps_cli_result_as_tool_output() {
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx-stopless-disabled"), scope())
        .with_local_context(
            "ctx-stopless-disabled",
            scope(),
            stopless_noop_context(
                json!([
                    {"role":"user","content":"original task"},
                    {
                        "role":"assistant",
                        "tool_calls":[{
                            "id":"call_stopless_reasoning",
                            "type":"function",
                            "function":{"name":"exec_command","arguments":"{}"}
                        }]
                    }
                ]),
                json!([]),
            ),
        );
    let governed = request_hooks
        .run(
            raw_request(json!({
                "input":[{"type":"function_call_output","call_id":"call_stopless_reasoning","output":""}]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert_eq!(governed.tool_output_count(), 1);
    assert!(governed.payload().get("instructions").is_none());
    assert!(governed.payload().get("tools").is_none());
}

#[test]
fn stopless_hook_blackbox_noop_cli_without_runtime_control_state_is_preserved() {
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx-stopless-missing-state"), scope())
        .with_local_context(
            "ctx-stopless-missing-state",
            scope(),
            json!({
                "messages":[
                    {"role":"user","content":"original task"},
                    {
                        "role":"assistant",
                        "tool_calls":[{
                            "id":"call_stopless_reasoning",
                            "type":"function",
                            "function":{
                                "name":"exec_command",
                                "arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"
                            }
                        }]
                    }
                ]
            }),
        );
    let governed = request_hooks
        .run(
            raw_request(json!({
                "input":[{"type":"function_call_output","call_id":"call_stopless_reasoning","output":""}]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();
    assert!(governed.stopless_state().is_none());
    let serialized = serde_json::to_string(governed.payload()).unwrap();
    assert!(serialized.contains("call_stopless_reasoning"));
    assert!(serialized.contains("routecodex hook run reasoningStop"));
    assert!(!governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04StoplessResultParsed));
}

#[test]
fn request_governance_rejects_orphan_output_wrong_kind_and_missing_call_id() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx_tool_parity"), scope()).with_local_context(
        "ctx_tool_parity",
        scope(),
        restored_multitool_chat_context(),
    );

    assert!(matches!(
        hooks.run(
            raw_request(
                json!({"input":[{"type":"function_call_output","call_id":"missing","output":"x"}]})
            ),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        ),
        Err(V3HubRelayRequestError::OrphanToolOutput { .. })
    ));

    assert!(matches!(
        hooks.run(
            raw_request(json!({"input":[{"type":"function_call_output","call_id":"call_function","output":"x"}]})),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        ),
        Err(V3HubRelayRequestError::OrphanToolOutput { .. })
    ));

    assert!(matches!(
        hooks.run(
            raw_request(json!({"input":[{"type":"function_call_output","call_id":"call_custom","output":"x"}]})),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        ),
        Err(V3HubRelayRequestError::ToolOutputKindMismatch { .. })
    ));

    assert!(matches!(
        hooks.run(
            raw_request(
                json!({"input":[{"type":"custom_tool_call_output","output":"missing id"}]})
            ),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        ),
        Err(V3HubRelayRequestError::ReqInboundInvalid { .. })
    ));
}

#[test]
fn attachment_history_is_preserved_without_placeholder_cleanup() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let outcome = hooks
        .run(
            raw_request(json!({
                "input": [
                    {"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,HISTORY"}]},
                    {"type":"function_call","call_id":"call_inline","name":"vision_lookup","arguments":"{}"},
                    {"type":"function_call_output","call_id":"call_inline","output":"before data:image/png;base64,HISTORY_INLINE after"},
                    {"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,CURRENT"}]}
                ]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        )
        .expect("Req04 attachment history governance");
    let serialized = serde_json::to_string(outcome.payload()).unwrap();

    assert!(serialized.contains("HISTORY"));
    assert!(serialized.contains("data:image/png;base64,CURRENT"));
}

#[test]
fn attachment_history_missing_resource_is_preserved_as_client_data() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let outcome = hooks
        .run(
            raw_request(json!({
                "input": [
                    {"role":"user","content":[{"type":"input_image"}]},
                    {"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,CURRENT"}]}
                ]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        )
        .expect("missing attachment metadata must not trigger history cleanup");
    let serialized = serde_json::to_string(outcome.payload()).unwrap();
    assert!(serialized.contains("image_url"));
    assert!(serialized.contains("data:image/png;base64,CURRENT"));
}

#[test]
fn response_governance_classifies_function_custom_servertool_and_internal_tools_before_commit() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(
            restored_multitool_context(),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::new(["servertool.exec"]),
        )
        .unwrap();
    assert_eq!(
        resp03.tool_call_kinds(),
        vec![
            V3HubRelayToolKind::Function,
            V3HubRelayToolKind::Custom,
            V3HubRelayToolKind::Servertool,
            V3HubRelayToolKind::ApplyPatch,
            V3HubRelayToolKind::Mcp,
            V3HubRelayToolKind::Native,
        ]
    );
    assert_eq!(
        resp03.servertool_action(),
        V3HubServertoolResponseAction::FollowupRequired
    );

    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    assert_eq!(
        resp04.canonical_tool_call_kinds(),
        vec![
            V3HubRelayToolKind::Function,
            V3HubRelayToolKind::Custom,
            V3HubRelayToolKind::Servertool,
            V3HubRelayToolKind::ApplyPatch,
            V3HubRelayToolKind::Mcp,
            V3HubRelayToolKind::Native,
        ]
    );
}

#[test]
fn response_governance_projects_web_search_to_client_exec_with_original_call_id() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(
            json!({
                "id":"resp_web_search_servertool",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_web_search_original",
                    "name":"web_search",
                    "arguments":"{\"query\":\"RouteCodex docs\",\"search_content_types\":[\"text\",\"image\"]}"
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();

    let resp03 = hooks
        .govern(resp02, &web_search_response_profile())
        .unwrap();
    assert_eq!(
        resp03.servertool_action(),
        V3HubServertoolResponseAction::None
    );
    assert_eq!(resp03.tool_call_count(), 1);
    assert_eq!(resp03.tool_call_kinds(), vec![V3HubRelayToolKind::Function]);
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.finalized_payload();
    assert_eq!(payload["output"][0]["call_id"], "call_web_search_original");
    assert_eq!(payload["output"][0]["name"], "exec_command");
    let arguments: Value = serde_json::from_str(
        payload["output"][0]["arguments"]
            .as_str()
            .expect("exec_command arguments"),
    )
    .unwrap();
    let command = arguments["cmd"].as_str().expect("cmd");
    assert!(command.starts_with("routecodex servertool run web_search --input-json "));
    assert!(command.contains("RouteCodex docs"));
    assert!(command.contains("search_content_types"));
    assert!(command.contains("image"));
    let serialized = payload.to_string();
    assert!(!serialized.contains("routeHint"));
    assert!(!serialized.contains("flowId"));
}

#[test]
fn response_governance_leaves_unregistered_function_call_untouched() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(
            json!({
                "id":"resp_regular_function",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_regular",
                    "name":"lookup",
                    "arguments":"{\"key\":\"value\"}"
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();

    let resp03 = hooks
        .govern(resp02, &web_search_response_profile())
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.finalized_payload();
    assert_eq!(payload["output"][0]["call_id"], "call_regular");
    assert_eq!(payload["output"][0]["name"], "lookup");
    assert_eq!(payload["output"][0]["arguments"], "{\"key\":\"value\"}");
}

#[test]
fn responses_sse_arbitrary_chunks_preserve_delta_order_and_terminal_tool_order() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(
            json!({
                "id":"resp_sse_transport_only",
                "status":"requires_action",
                "output":[
                    {"type":"reasoning","summary":[{"type":"summary_text","text":"think"}]},
                    {"type":"function_call","call_id":"call_sse","name":"lookup","arguments":"{\"q\":\"x\"}"}
                ]
            }),
            V3HubTransportIntent::Sse,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .unwrap();
    assert_eq!(resp03.tool_call_kinds(), vec![V3HubRelayToolKind::Function]);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.finalized_payload()["output"][0]["type"], "reasoning");
    assert_eq!(
        resp04.finalized_payload()["output"][1]["call_id"],
        "call_sse"
    );
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04.into_data());
    let resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    assert_eq!(
        resp06.response_exit_node(),
        "V3ServerRespOutbound06ClientFrame"
    );
    assert_eq!(resp06.transport_intent(), V3HubTransportIntent::Sse);
}

#[test]
fn provider_and_client_payloads_reject_routecodex_control_leakage() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp01 = relay_response(
        json!({
            "id":"resp_leak",
            "status":"completed",
            "metadata_center":{"continuation_owner":"relay"},
            "output":[]
        }),
        V3HubTransportIntent::Json,
    );
    assert!(matches!(
        hooks.normalize(resp01),
        Err(V3HubRelayResponseError::SideChannelLeaked { .. })
    ));

    assert!(matches!(
        compile_v3_hub_relay_request_hooks().run(
            raw_request(json!({
                "input":[{"role":"user","content":"continue"}],
                "routecodex_internal":{"debug":true}
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        ),
        Err(V3HubRelayRequestError::SideChannelLeaked { .. })
    ));
}
