use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw,
    build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04,
    build_v3_provider_resp_inbound_01_raw,
    build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05,
    compile_v3_hub_relay_request_hooks, compile_v3_hub_relay_response_hooks,
    V3HubAttachmentHistoryPolicy, V3HubContinuationCommit, V3HubContinuationLookup,
    V3HubContinuationOwnership, V3HubContinuationScope, V3HubEntryProtocol, V3HubExecutionMode,
    V3HubInvocationSource, V3HubProviderWireProtocol, V3HubRelayRequestError,
    V3HubRelayResponseError, V3HubRelayResponseHookProfile, V3HubRelayToolKind,
    V3HubServertoolRequestProfile, V3HubServertoolResponseAction, V3HubTransportIntent,
};
use serde_json::{json, Value};

const HISTORICAL_IMAGE_PLACEHOLDER: &str = "[routecodex historical media released]";

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

fn stopless_projected_call(payload: &Value) -> &Value {
    payload["output"]
        .as_array()
        .expect("stopless projected output")
        .iter()
        .find(|item| item["call_id"] == json!("call_stopless_reasoning"))
        .expect("projected stopless exec_command call")
}

fn assert_no_schema_feedback_user_prompt(item: &Value) {
    assert_eq!(item.get("role").and_then(Value::as_str), Some("user"));
    let content = item
        .get("content")
        .and_then(Value::as_str)
        .expect("no_schema feedback prompt");
    assert!(
        content.contains("缺少 stop schema"),
        "no_schema prompt must explain the missing stop schema: {content}"
    );
    assert!(
        content.contains("stopreason") && content.contains("<rcc_stop_schema>"),
        "no_schema prompt must carry schema guidance: {content}"
    );
    assert!(
        !content.trim().eq("继续。"),
        "no_schema prompt must not collapse to legacy continue text"
    );
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
                .run_with_attachment_history_policy(
                    raw_request_for(current_tool_round_payload(), entry, transport),
                    &V3HubContinuationLookup::new(None, matrix_scope.clone()),
                    &V3HubServertoolRequestProfile::disabled(),
                    V3HubAttachmentHistoryPolicy::Preserve,
                )
                .expect("new/current-history tool output must be governed at Req04");
            assert_eq!(new_outcome.continuation(), V3HubContinuationOwnership::New);
            assert_eq!(new_outcome.tool_output_count(), 1);

            let local_lookup =
                V3HubContinuationLookup::new(Some("ctx_tool_parity"), matrix_scope.clone())
                    .with_local_context(
                        "ctx_tool_parity",
                        matrix_scope.clone(),
                        restored_multitool_context(),
                    );
            let local_outcome = request_hooks
                .run_with_attachment_history_policy(
                    raw_request_for(
                        json!({"input":[{"type":"function_call_output","call_id":"call_function","output":"restored ok"}]}),
                        entry,
                        transport,
                    ),
                    &local_lookup,
                    &V3HubServertoolRequestProfile::enabled(["servertool.request"]),
                    V3HubAttachmentHistoryPolicy::Preserve,
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
                    raw_request_for(json!({"input":[]}), entry, transport),
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
        restored_multitool_context(),
    );
    let outcome = hooks
        .run_with_attachment_history_policy(
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
            V3HubAttachmentHistoryPolicy::Preserve,
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
            "id": "resp_apply_patch",
            "status": "requires_action",
            "output": [{
                "type": "custom_tool_call",
                "call_id": "call_apply_patch_freeform",
                "name": "apply_patch",
                "input": "*** Begin Patch\n*** Update File: src/main.rs\n@@\n-old\n+new\n*** End Patch"
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
    let output = outcome.payload()["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["call_id"] == "call_apply_patch_freeform" && item.get("output").is_some())
        .and_then(|item| item["output"].as_str())
        .unwrap();
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
                "id": "resp_apply_patch_legacy",
                "status": "requires_action",
                "output": [{
                    "type": "function_call",
                    "call_id": "call_apply_patch_legacy",
                    "name": "apply_patch",
                    "arguments": "{}"
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
    assert!(outcome.payload()["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["call_id"] == "call_apply_patch_legacy" && item.get("output").is_some())
        .and_then(|item| item["output"].as_str())
        .unwrap()
        .starts_with("APPLY_PATCH_ERROR:"));
}

#[test]
fn stopless_hook_blackbox_projects_cli_then_rewrites_next_request_inside_chat_process() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_stopless_blackbox",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"stopping without schema"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    let resp04 = response_hooks.commit(resp03).unwrap();
    let projected = resp04.canonical_context_payload().unwrap().clone();
    let projected_call = stopless_projected_call(&projected);
    assert_eq!(projected_call["name"], "exec_command");
    assert_eq!(projected_call["call_id"], "call_stopless_reasoning");
    assert!(projected_call["arguments"]
        .as_str()
        .unwrap()
        .contains("routecodex hook run reasoningStop"));

    let lookup = V3HubContinuationLookup::new(Some("ctx_stopless_blackbox"), scope())
        .with_local_context("ctx_stopless_blackbox", scope(), projected);
    let outcome = request_hooks
        .run(
            raw_request(json!({
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{\"next_step\":\"blackbox next request text\"}"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(outcome.tool_output_count(), 0);
    assert_eq!(
        outcome.payload()["input"],
        json!([{"role":"user","content":"blackbox next request text"}])
    );
    assert!(outcome.payload()["instructions"]
        .as_str()
        .unwrap()
        .contains("stopreason"));
    let serialized = serde_json::to_string(outcome.payload()).unwrap();
    for forbidden in [
        "function_call_output",
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "rewritten request leaked stopless CLI artifact: {forbidden}"
        );
    }
}

#[test]
fn stopless_hook_blackbox_rewrites_codex_transcript_from_full_history() {
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let mut input = Vec::new();
    for index in 0..240 {
        input.push(json!({
            "type":"function_call",
            "call_id":format!("call_unrelated_{index}"),
            "name":"exec_command",
            "arguments":"{}"
        }));
        input.push(json!({
            "type":"function_call_output",
            "call_id":format!("call_unrelated_{index}"),
            "output":"ok"
        }));
    }
    input.push(json!({
        "type":"function_call",
        "call_id":"call_stopless_reasoning",
        "name":"exec_command",
        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{}'\"}"
    }));
    input.push(json!({
        "type":"function_call_output",
        "call_id":"call_stopless_reasoning",
        "output":"Chunk ID: 2c3627\nWall time: 0.1169 seconds\nProcess exited with code 0\nOriginal token count: 82\nOutput:\n{\"ok\":true,\"kind\":\"stop_message_auto\",\"continuationPrompt\":\"继续。\",\"input\":{\"triggerHint\":\"no_schema\"}}\n"
    }));

    let outcome = request_hooks
        .run(
            raw_request(json!({
                "model":"gpt-5.5",
                "input":input,
                "stream":true
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();

    assert_eq!(outcome.tool_output_count(), 240);
    let input = outcome.payload()["input"].as_array().expect("input array");
    assert_eq!(input.len(), 481);
    assert_eq!(input.first().unwrap()["call_id"], "call_unrelated_0");
    assert_no_schema_feedback_user_prompt(input.last().unwrap());
    assert!(outcome.payload()["instructions"]
        .as_str()
        .unwrap()
        .contains("stopreason"));
    let serialized = serde_json::to_string(outcome.payload()).unwrap();
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "Chunk ID:",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "rewritten full-history request leaked stopless CLI artifact: {forbidden}"
        );
    }
}

#[test]
fn stopless_hook_blackbox_strips_accumulated_cli_projection_messages_from_full_history() {
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let input = vec![
        json!({"role":"user","content":"先保留的真实用户问题"}),
        json!({
            "type":"message",
            "role":"assistant",
            "status":"completed",
            "content":[{"type":"output_text","text":"old visible stop text one"}]
        }),
        json!({
            "type":"function_call",
            "call_id":"call_stopless_reasoning",
            "name":"exec_command",
            "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"no_schema\\\"}'\"}"
        }),
        json!({
            "type":"function_call_output",
            "call_id":"call_stopless_reasoning",
            "output":"Chunk ID: old-one\nOutput:\n{\"ok\":true,\"kind\":\"stop_message_auto\",\"continuationPrompt\":\"old prompt one\",\"repeatCount\":1,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\"}}\n"
        }),
        json!({
            "type":"function_call",
            "call_id":"call_bad_local_tool",
            "name":"exec_command",
            "arguments":"{}"
        }),
        json!({
            "type":"function_call_output",
            "call_id":"call_bad_local_tool",
            "output":"failed to parse function arguments: missing field `cmd` at line 1 column 2"
        }),
        json!({"role":"user","content":"1. direct 是否锁住不走 stopless？\n2. 全局是否有 stopless 停止的 schema 引导？"}),
        json!({
            "type":"message",
            "role":"assistant",
            "status":"completed",
            "content":[{"type":"output_text","text":"latest visible stop text repeat one"}]
        }),
        json!({
            "type":"function_call",
            "call_id":"call_stopless_reasoning",
            "name":"exec_command",
            "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"no_schema\\\"}' --repeat-count '1' --max-repeats '3'\"}"
        }),
        json!({
            "type":"function_call_output",
            "call_id":"call_stopless_reasoning",
            "output":"Chunk ID: latest-one\nOutput:\n{\"ok\":true,\"kind\":\"stop_message_auto\",\"continuationPrompt\":\"latest prompt one\",\"repeatCount\":1,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\"}}\n"
        }),
        json!({
            "type":"message",
            "role":"assistant",
            "status":"completed",
            "content":[{"type":"output_text","text":"latest visible stop text repeat two"}]
        }),
        json!({
            "type":"function_call",
            "call_id":"call_stopless_reasoning",
            "name":"exec_command",
            "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":2,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"no_schema\\\"}' --repeat-count '2' --max-repeats '3'\"}"
        }),
        json!({
            "type":"function_call_output",
            "call_id":"call_stopless_reasoning",
            "output":"Chunk ID: latest-two\nOutput:\n{\"ok\":true,\"kind\":\"stop_message_auto\",\"continuationPrompt\":\"latest repeat two prompt\",\"repeatCount\":2,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\"}}\n"
        }),
    ];

    let outcome = request_hooks
        .run(
            raw_request(json!({
                "model":"gpt-5.5",
                "input":input,
                "stream":true
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();

    assert_eq!(
        outcome.stopless_state().map(|state| state.repeat_count()),
        Some(2),
        "request-side hook must use the latest active stopless evidence instead of resetting the loop"
    );
    let output = outcome.payload()["input"].as_array().expect("input array");
    assert!(
        output
            .iter()
            .any(|item| item["content"] == json!("1. direct 是否锁住不走 stopless？\n2. 全局是否有 stopless 停止的 schema 引导？")),
        "real user reset-boundary text must stay in the provider-visible request"
    );
    assert_no_schema_feedback_user_prompt(output.last().unwrap());
    let serialized = serde_json::to_string(outcome.payload()).unwrap();
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "Chunk ID:",
        "old prompt one",
        "latest prompt one",
        "latest repeat two prompt",
        "old visible stop text one",
        "latest visible stop text repeat one",
        "latest visible stop text repeat two",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "rewritten full-history request leaked accumulated stopless CLI projection artifact: {forbidden}"
        );
    }
}

#[test]
fn stopless_hook_blackbox_real_progress_after_cli_resets_repeat_budget() {
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let request_outcome = request_hooks
        .run(
            raw_request(json!({
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
                        "output":"Chunk ID: stale\nWall time: 0.1 seconds\nOutput:\n{\"ok\":true,\"kind\":\"stop_message_auto\",\"continuationPrompt\":\"继续。\",\"repeatCount\":2,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\"}}\n"
                    },
                    {"role":"user","content":"继续检查"},
                    {
                        "type":"function_call",
                        "call_id":"call_real_exec",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"git log --oneline -10\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_real_exec",
                        "output":"real tool progress"
                    }
                ]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();

    assert!(
        request_outcome.stopless_state().is_none(),
        "stale stopless shell output followed by real progress must not carry repeatCount=2"
    );
    let serialized_request = serde_json::to_string(request_outcome.payload()).unwrap();
    assert!(serialized_request.contains("call_real_exec"));
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
    ] {
        assert!(
            !serialized_request.contains(forbidden),
            "request side leaked stale stopless history after reset boundary: {forbidden}"
        );
    }

    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_stopless_after_real_progress",
                "object":"response",
                "status":"completed",
                "output":[{"type":"output_text","text":"好继续检查，我已经补了一些测试了"}]
            }),
            V3HubTransportIntent::Sse,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.tool_call_count(), 1);
    let resp04 = response_hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let projected = resp04.canonical_context_payload().unwrap();
    assert_eq!(projected["status"], "requires_action");
    let projected_call = stopless_projected_call(projected);
    assert_eq!(projected_call["call_id"], "call_stopless_reasoning");
    let arguments = projected_call["arguments"].as_str().unwrap();
    assert!(
        arguments.contains("\\\"repeatCount\\\":1"),
        "reset state must make the next missing-schema stop project round 1, not pass through budget: {arguments}"
    );
}

#[test]
fn stopless_hook_blackbox_terminal_schema_does_not_enter_cli_roundtrip() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_stopless_terminal_blackbox",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{
                    "type":"output_text",
                    "text":"{\"stopreason\":0,\"reason\":\"done\",\"has_evidence\":1,\"evidence\":\"done\"}"
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = response_hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    assert_eq!(resp04.canonical_context_count(), 0);
    let visible = resp04.finalized_payload()["output"][0]["text"]
        .as_str()
        .expect("terminal visible text");
    assert!(visible.contains("## 完成内容"));
    assert!(visible.contains("done"));
    assert!(!visible.contains("stopreason"));
}

#[test]
fn stopless_hook_blackbox_disabled_request_profile_keeps_cli_result_as_tool_output() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_stopless_disabled_request_blackbox",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"missing stop schema"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    let resp04 = response_hooks.commit(resp03).unwrap();
    let projected = resp04.canonical_context_payload().unwrap().clone();

    let lookup = V3HubContinuationLookup::new(Some("ctx_stopless_disabled_request"), scope())
        .with_local_context("ctx_stopless_disabled_request", scope(), projected);
    let outcome = request_hooks
        .run(
            raw_request(json!({
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{\"next_step\":\"must remain a tool output\"}"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert_eq!(outcome.tool_output_count(), 1);
    let input = outcome.payload()["input"].as_array().expect("input array");
    assert!(input.iter().any(|item| {
        item.get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|part| part.get("text").and_then(Value::as_str) == Some("missing stop schema"))
    }));
    let kept_call = input
        .iter()
        .find(|item| {
            item["call_id"] == "call_stopless_reasoning" && item["type"] == "function_call"
        })
        .expect("disabled request profile must keep stopless call as normal tool history");
    assert_eq!(kept_call["name"], "exec_command");
    let kept_output = input
        .iter()
        .find(|item| {
            item["call_id"] == "call_stopless_reasoning" && item["type"] == "function_call_output"
        })
        .expect("disabled request profile must keep stopless output as normal tool output");
    assert_eq!(
        kept_output["output"],
        "{\"next_step\":\"must remain a tool output\"}"
    );
    assert!(outcome.payload().get("instructions").is_none());
}

#[test]
fn stopless_hook_blackbox_malformed_cli_result_fails_before_next_turn_governance() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_stopless_malformed_blackbox",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"missing stop schema"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    let resp04 = response_hooks.commit(resp03).unwrap();
    let projected = resp04.canonical_context_payload().unwrap().clone();

    let lookup = V3HubContinuationLookup::new(Some("ctx_stopless_malformed"), scope())
        .with_local_context("ctx_stopless_malformed", scope(), projected);
    assert!(matches!(
        request_hooks.run(
            raw_request(json!({
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"not json"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        ),
        Err(V3HubRelayRequestError::MalformedStoplessCliOutput {
            reason: "output must be JSON",
            ..
        })
    ));
}

#[test]
fn request_governance_rejects_orphan_output_wrong_kind_and_missing_call_id() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx_tool_parity"), scope()).with_local_context(
        "ctx_tool_parity",
        scope(),
        restored_multitool_context(),
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
        Err(V3HubRelayRequestError::MalformedToolOutput { .. })
    ));
}

#[test]
fn attachment_history_placeholder_releases_only_historical_media_and_preserves_current_payload() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let outcome = hooks
        .run_with_attachment_history_policy(
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
            V3HubAttachmentHistoryPolicy::Placeholder {
                placeholder: HISTORICAL_IMAGE_PLACEHOLDER,
            },
        )
        .expect("Req04 attachment history governance");
    let serialized = serde_json::to_string(outcome.payload()).unwrap();

    assert!(!serialized.contains("HISTORY"));
    assert!(serialized.contains(HISTORICAL_IMAGE_PLACEHOLDER));
    assert!(serialized.contains("data:image/png;base64,CURRENT"));
}

#[test]
fn attachment_history_missing_resource_fails_without_trimming_current_request() {
    let hooks = compile_v3_hub_relay_request_hooks();
    assert!(matches!(
        hooks.run_with_attachment_history_policy(
            raw_request(json!({
                "input": [
                    {"role":"user","content":[{"type":"input_image"}]},
                    {"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,CURRENT"}]}
                ]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
            V3HubAttachmentHistoryPolicy::Placeholder {
                placeholder: HISTORICAL_IMAGE_PLACEHOLDER,
            },
        ),
        Err(V3HubRelayRequestError::AttachmentResourceMissing { .. })
    ));
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
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
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
            raw_request(json!({"input":[],"routecodex_internal":{"debug":true}})),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        ),
        Err(V3HubRelayRequestError::SideChannelLeaked { .. })
    ));
}
