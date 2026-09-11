use routecodex_v3_runtime::{
    build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04,
    build_v3_provider_resp_inbound_01_raw,
    build_v3_provider_resp_inbound_01_raw_with_compat_profile,
    build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05,
    compile_v3_hub_relay_response_hooks, V3HubContinuationCommit, V3HubContinuationOwnership,
    V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource, V3HubProviderWireProtocol,
    V3HubRelayResponseError, V3HubRelayResponseHookProfile, V3HubResponseNormalizedKind,
    V3HubResponseTerminality, V3HubServertoolResponseAction, V3HubTransportIntent,
    V3ProviderRespInbound01RawContext,
};
use serde_json::{json, Value};
use std::{fs, path::Path};

fn relay_raw(
    payload: Value,
    transport: V3HubTransportIntent,
) -> routecodex_v3_runtime::V3ProviderRespInbound01Raw {
    build_v3_provider_resp_inbound_01_raw(
        payload,
        V3HubEntryProtocol::Responses,
        V3HubProviderWireProtocol::Responses,
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        transport,
    )
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
#[test]
fn provider_resp_compat_profile_loads_before_chat_process_tool_governance() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let raw = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        json!({
            "object": "response",
            "id": "resp_minimax_tool_text",
            "status": "completed",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
                }],
                "output_text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
            }],
            "output_text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
        }),
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubContinuationOwnership::New,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        )
        .with_compatibility_profile(Some("chat:minimax")),
    );

    let resp02 = hooks
        .normalize(raw)
        .expect("provider compat profile should normalize provider-specific text tools");
    let resp03 = hooks
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .expect("chat process should harvest compat-normalized function call");
    assert_eq!(resp03.tool_call_count(), 1);
    assert_eq!(
        resp03.tool_call_kinds(),
        vec![routecodex_v3_runtime::V3HubRelayToolKind::Function]
    );
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
}
fn passthrough_profile_does_not_harvest_minimax_text_tool_calls() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let raw = relay_raw(
        json!({
            "object": "response",
            "id": "resp_minimax_passthrough_text",
            "status": "completed",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
                }]
            }]
        }),
        V3HubTransportIntent::Json,
    );

    let resp02 = hooks.normalize(raw).unwrap();
    let resp03 = hooks
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .unwrap();
    assert_eq!(resp03.tool_call_count(), 0);

    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    let serialized = serde_json::to_string(resp04.finalized_payload()).unwrap();
    assert!(serialized.contains("<function_calls>"));
}

#[test]
fn relay_hooks_normalize_govern_and_commit_one_canonical_context() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let profile = V3HubRelayResponseHookProfile::new(["servertool.exec"]);
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id": "resp_relay",
                "status": "requires_action",
                "output": [{
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "servertool.exec",
                    "arguments": "{}"
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .expect("Resp01 -> Resp02 normalization");
    assert_eq!(resp02.normalized_kind(), V3HubResponseNormalizedKind::Json);

    let resp03 = hooks
        .govern(resp02, &profile)
        .expect("Resp02 -> Resp03 Chat Process governance");
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    assert_eq!(resp03.tool_call_count(), 1);
    assert_eq!(
        resp03.servertool_action(),
        V3HubServertoolResponseAction::FollowupRequired
    );

    let resp04 = hooks
        .commit(resp03)
        .expect("Resp03 -> Resp04 continuation commit");
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    assert_eq!(resp04.canonical_context_count(), 1);
    assert!(resp04.canonical_context_shares_finalized_payload());
}

#[test]
fn terminal_response_commits_no_continuation() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({"id":"resp_done","status":"completed","output":[{"type":"output_text","text":"ok"}]}),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::Terminal);
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    assert_eq!(resp04.canonical_context_count(), 0);
}

#[test]
fn response_reasoning_summary_and_text_stay_separate_through_chat_process() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let provider_payload = json!({
        "id":"resp_reasoning_text_contract",
        "status":"completed",
        "output":[
            {
                "type":"reasoning",
                "summary":[{"type":"summary_text","text":"reasoning trace"}]
            },
            {
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"visible answer"}]
            }
        ]
    });
    let resp02 = hooks
        .normalize(relay_raw(
            provider_payload.clone(),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::Terminal);
    assert_eq!(resp03.tool_call_count(), 0);

    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    let payload = resp04.finalized_payload();
    assert_eq!(
        payload["output"][0],
        provider_payload["output"][0],
        "RespChatProcess must preserve Responses reasoning.summary as reasoning, not convert it to visible text"
    );
    assert_eq!(
        payload["output"][1]["content"][0]["text"], "visible answer",
        "RespChatProcess must preserve Responses message.output_text as visible text"
    );
    assert_eq!(
        payload["output"][0]["summary"][0]["text"], "reasoning trace",
        "Responses reasoning summary text must not be dropped before client projection"
    );
}

#[test]
fn resp03_repairs_tool_call_finish_reason_before_tool_governance() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_with_real_tool_call",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_real_exec",
                    "name":"exec_command",
                    "arguments":"{\"cmd\":\"pwd\"}"
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .unwrap();

    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    assert_eq!(resp03.tool_call_count(), 1);
    assert_eq!(
        resp03.servertool_action(),
        V3HubServertoolResponseAction::None
    );
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.finalized_payload();
    assert_eq!(payload["status"], "requires_action");
    assert_eq!(payload["finish_reason"], "tool_calls");
    assert_eq!(payload["output"][0]["call_id"], "call_real_exec");
    assert_eq!(payload["output"][0]["name"], "exec_command");
}

#[test]
fn resp04_reuses_resp03_repaired_payload_without_semantic_repair() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_repair_at_resp03",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_patch_resp03",
                    "name":"apply_patch",
                    "arguments":"{\"patch\":\"*** Begin Patch\\n*** End Patch\\n\"}"
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    let resp04 = hooks.commit(resp03).unwrap();

    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    assert!(resp04.canonical_context_shares_provider_payload());
    assert_eq!(resp04.finalized_payload()["status"], "requires_action");
    assert_eq!(resp04.finalized_payload()["finish_reason"], "tool_calls");
    assert_eq!(
        resp04.finalized_payload()["output"][0]["type"],
        "custom_tool_call"
    );
}

#[test]
fn malformed_tool_call_fails_inside_response_chat_process() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "status": "requires_action",
                "output": [{"type":"function_call","name":"servertool.exec"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    assert!(matches!(
        hooks.govern(
            resp02,
            &V3HubRelayResponseHookProfile::new(["servertool.exec"])
        ),
        Err(V3HubRelayResponseError::MalformedToolCall { .. })
    ));
}

#[test]
fn duplicate_response_tool_identity_fails_inside_response_chat_process() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "status": "requires_action",
                "output": [
                    {"type":"function_call","call_id":"dup","name":"lookup"},
                    {"type":"function_call","call_id":"dup","name":"lookup_again"}
                ]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    assert!(matches!(
        hooks.govern(resp02, &V3HubRelayResponseHookProfile::empty()),
        Err(V3HubRelayResponseError::MalformedToolCall {
            reason: "duplicate call_id/id",
            ..
        })
    ));
}

#[test]
fn missing_or_unknown_status_fails_inside_response_chat_process() {
    let hooks = compile_v3_hub_relay_response_hooks();
    for payload in [
        json!({"output": []}),
        json!({
            "status": "invented",
            "output": [{"type":"function_call","call_id":"call_1","name":"servertool.exec"}]
        }),
    ] {
        let resp02 = hooks
            .normalize(relay_raw(payload, V3HubTransportIntent::Json))
            .unwrap();
        assert!(matches!(
            hooks.govern(
                resp02,
                &V3HubRelayResponseHookProfile::new(["servertool.exec"])
            ),
            Err(V3HubRelayResponseError::MissingStatus)
                | Err(V3HubRelayResponseError::UnsupportedStatus { .. })
        ));
    }
}

#[test]
fn response_chat_process_preserves_tool_search_tool_call_without_script_conversion() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let raw = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        json!({
            "id": "resp_tool_search_passthrough",
            "status": "requires_action",
            "tools": [{"type": "tool_search", "name": "tool_search"}],
            "output": [{
                "type": "function_call",
                "call_id": "call_tool_search",
                "name": "tool_search",
                "arguments": "{\"query\":\"routecodex v3 response compat\"}"
            }]
        }),
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubContinuationOwnership::New,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        )
        .with_compatibility_profile(Some("compat:passthrough")),
    );

    let resp02 = hooks
        .normalize(raw)
        .expect("provider compat must not reject generic tool_search response shape");
    let resp03 = hooks
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .expect("RespChatProcess owns tool_search tool-call harvesting");
    assert_eq!(resp03.tool_call_count(), 1);
    assert_eq!(
        resp03.tool_call_kinds(),
        vec![routecodex_v3_runtime::V3HubRelayToolKind::Function]
    );
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);

    let resp04 = hooks.commit(resp03).expect("tool_search response commit");
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let finalized = resp04.finalized_payload();
    assert_eq!(finalized["output"][0]["name"], "tool_search");
    assert_eq!(finalized["output"][0]["call_id"], "call_tool_search");
    assert_eq!(
        finalized["output"][0]["arguments"],
        "{\"query\":\"routecodex v3 response compat\"}"
    );
    let serialized = serde_json::to_string(finalized).expect("finalized response JSON");
    assert!(!serialized.contains("exec_command"));
    assert!(!serialized.contains("Script running"));
    assert!(!serialized.contains("shell"));
}

#[test]
fn passthrough_response_chat_process_does_not_turn_shell_fence_text_into_tool_call() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let raw = relay_raw(
        json!({
            "id": "resp_shell_fence_text_only",
            "status": "completed",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "<function_calls>```bash\npwd\n```</function_calls>"
                }]
            }],
            "output_text": "<function_calls>```bash\npwd\n```</function_calls>"
        }),
        V3HubTransportIntent::Json,
    );

    let resp02 = hooks
        .normalize(raw)
        .expect("RespInbound02 accepts provider standard text response");
    let resp03 = hooks
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .expect("RespChatProcess preserves non-tool shell fence text");
    assert_eq!(resp03.tool_call_count(), 0);
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::Terminal);

    let resp04 = hooks.commit(resp03).expect("terminal response commit");
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    let serialized = serde_json::to_string(resp04.finalized_payload()).unwrap();
    assert!(serialized.contains("```bash\\npwd\\n```"));
    assert!(!serialized.contains("requires_action"));
    assert!(!serialized.contains("exec_command"));
}

#[test]
fn json_and_sse_use_the_same_single_response_exit() {
    let hooks = compile_v3_hub_relay_response_hooks();
    for transport in [V3HubTransportIntent::Json, V3HubTransportIntent::Sse] {
        let resp02 = hooks
            .normalize(relay_raw(
                json!({"id":"resp_done","status":"completed","output":[]}),
                transport,
            ))
            .unwrap();
        let resp03 = hooks
            .govern(resp02, &V3HubRelayResponseHookProfile::empty())
            .unwrap();
        let resp04 = hooks.commit(resp03).unwrap();
        let resp05 =
            build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04.into_data());
        let resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
        assert_eq!(
            resp06.response_exit_node(),
            "V3ServerRespOutbound06ClientFrame"
        );
        assert_eq!(resp06.transport_intent(), transport);
    }
}

#[test]
fn direct_response_cannot_enter_relay_response_hooks() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let direct = build_v3_provider_resp_inbound_01_raw(
        json!({"status":"completed"}),
        V3HubEntryProtocol::Responses,
        V3HubProviderWireProtocol::Responses,
        V3HubContinuationOwnership::RemoteProviderOwned,
        V3HubExecutionMode::Direct,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    assert!(matches!(
        hooks.normalize(direct),
        Err(V3HubRelayResponseError::ExecutionModeNotRelay)
    ));
}
