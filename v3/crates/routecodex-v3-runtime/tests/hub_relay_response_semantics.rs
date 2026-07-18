use routecodex_v3_runtime::{
    build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04,
    build_v3_provider_resp_inbound_01_raw,
    build_v3_provider_resp_inbound_01_raw_with_compat_profile,
    build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05,
    compile_v3_hub_relay_response_hooks, V3HubContinuationCommit, V3HubContinuationOwnership,
    V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource, V3HubProviderWireProtocol,
    V3HubRelayResponseError, V3HubRelayResponseHookProfile, V3HubResponseNormalizedKind,
    V3HubResponseTerminality, V3HubServertoolResponseAction, V3HubTransportIntent,
};
use serde_json::{json, Value};

fn stopless_cli_input_from_arguments(arguments: &str) -> Value {
    let parsed: Value = serde_json::from_str(arguments).expect("arguments must be JSON");
    let cmd = parsed["cmd"].as_str().expect("cmd is required");
    let marker = "--input-json '";
    let start = cmd.find(marker).expect("input-json marker") + marker.len();
    let rest = &cmd[start..];
    let end = rest.find('\'').expect("input-json closing quote");
    serde_json::from_str(&rest[..end]).expect("input-json must be JSON")
}

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

#[test]
fn minimax_profile_is_loaded_at_resp02_before_chat_process_governance() {
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
        V3HubEntryProtocol::Responses,
        V3HubProviderWireProtocol::Responses,
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
        Some("chat:minimax"),
    );

    let resp02 = hooks.normalize(raw).unwrap();
    let resp03 = hooks
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .unwrap();
    assert_eq!(resp03.tool_call_count(), 1);

    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let payload = resp04.finalized_payload();
    assert_eq!(payload["output"][0]["type"], "function_call");
    assert_eq!(payload["output"][0]["name"], "exec_command");
    assert_eq!(payload["output"][0]["arguments"], "{\"cmd\":\"pwd\"}");
    let serialized = serde_json::to_string(payload).unwrap();
    assert!(!serialized.contains("<function_calls>"));
    assert!(!serialized.contains("</function_calls>"));
}

#[test]
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
fn stopless_response_hook_projects_cli_before_continuation_commit() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_missing_schema",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"I should stop without schema"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    assert_eq!(resp03.tool_call_count(), 1);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let payload = resp04.canonical_context_payload().unwrap();
    assert_eq!(payload["status"], "requires_action");
    assert_eq!(payload["output"][0]["name"], "exec_command");
    assert_eq!(payload["output"][0]["call_id"], "call_stopless_reasoning");
    assert!(payload["output"][0]["arguments"]
        .as_str()
        .unwrap()
        .contains("routecodex hook run reasoningStop"));
    let cli_input =
        stopless_cli_input_from_arguments(payload["output"][0]["arguments"].as_str().unwrap());
    assert_eq!(cli_input["repeatCount"], json!(1));
    assert_eq!(cli_input["maxRepeats"], json!(3));
    assert_eq!(cli_input["triggerHint"], json!("no_schema"));
    assert!(!payload["output"][0]["arguments"]
        .as_str()
        .unwrap()
        .contains("status-control"));
}

#[test]
fn stopless_response_hook_projects_next_repeat_count_from_request_state() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_missing_schema_second_round",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"still missing schema"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty()
                .with_stopless_reasoning_stop()
                .with_stopless_request_state(routecodex_v3_runtime::V3StoplessHookState::new(
                    1,
                    3,
                    Some("no_schema".to_string()),
                )),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.canonical_context_payload().unwrap();
    let arguments = payload["output"][0]["arguments"].as_str().unwrap();
    let cli_input = stopless_cli_input_from_arguments(arguments);
    assert_eq!(
        cli_input["repeatCount"],
        json!(2),
        "second no_schema projection must advance repeatCount: {arguments}"
    );
    assert_eq!(cli_input["maxRepeats"], json!(3));
    assert_eq!(cli_input["triggerHint"], json!("no_schema"));
}

#[test]
fn stopless_response_hook_does_not_project_no_schema_after_repeat_budget() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_missing_schema_budget",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"third missing schema should pass through"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty()
                .with_stopless_reasoning_stop()
                .with_stopless_request_state(routecodex_v3_runtime::V3StoplessHookState::new(
                    2,
                    3,
                    Some("no_schema".to_string()),
                )),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::Terminal);
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    assert_eq!(resp04.finalized_payload()["status"], "completed");
}

#[test]
fn stopless_response_hook_stopreason_two_uses_v2_non_terminal_trigger_hint() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_non_terminal_trigger",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"{\"stopreason\":2,\"reason\":\"still working\",\"next_step\":\"continue the proof\"}"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.canonical_context_payload().unwrap();
    let arguments = payload["output"][0]["arguments"].as_str().unwrap();
    let cli_input = stopless_cli_input_from_arguments(arguments);
    assert_eq!(cli_input["repeatCount"], json!(1));
    assert_eq!(cli_input["maxRepeats"], json!(3));
    assert_eq!(cli_input["triggerHint"], json!("non_terminal_schema"));
}

#[test]
fn stopless_response_hook_does_not_project_non_terminal_schema_after_repeat_budget() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_non_terminal_budget",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"{\"stopreason\":2,\"reason\":\"still working\",\"next_step\":\"continue the proof\"}"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty()
                .with_stopless_reasoning_stop()
                .with_stopless_request_state(routecodex_v3_runtime::V3StoplessHookState::new(
                    2,
                    3,
                    Some("non_terminal_schema".to_string()),
                )),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::Terminal);
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    assert_eq!(resp04.finalized_payload()["status"], "completed");
}

#[test]
fn stopless_response_hook_invalid_schema_uses_v2_trigger_hint() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_invalid_trigger",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"{\"stopreason\":\"bad\",\"reason\":\"not numeric\"}"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.canonical_context_payload().unwrap();
    let arguments = payload["output"][0]["arguments"].as_str().unwrap();
    let cli_input = stopless_cli_input_from_arguments(arguments);
    assert_eq!(cli_input["repeatCount"], json!(1));
    assert_eq!(cli_input["maxRepeats"], json!(3));
    assert_eq!(cli_input["triggerHint"], json!("invalid_schema"));
}

#[test]
fn stopless_response_hook_does_not_project_invalid_schema_after_repeat_budget() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_invalid_budget",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"{\"stopreason\":\"bad\",\"reason\":\"not numeric\"}"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty()
                .with_stopless_reasoning_stop()
                .with_stopless_request_state(routecodex_v3_runtime::V3StoplessHookState::new(
                    2,
                    3,
                    Some("invalid_schema".to_string()),
                )),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::Terminal);
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    assert_eq!(resp04.finalized_payload()["status"], "completed");
}

#[test]
fn stopless_terminal_schema_does_not_project_cli() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_terminal",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"done {\"stopreason\":0,\"has_evidence\":1,\"evidence\":[\"ok\"]}"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::Terminal);
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
}

#[test]
fn stopless_response_hook_disabled_keeps_completed_text_terminal() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_disabled",
                "status":"completed",
                "output":[{"type":"output_text","text":"no stop schema"}]
            }),
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
    assert_eq!(resp04.finalized_payload()["status"], "completed");
    assert_eq!(
        resp04.finalized_payload()["output"][0]["text"],
        "no stop schema"
    );
}

#[test]
fn stopless_response_hook_requires_stop_finish_reason() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_no_finish_stop",
                "status":"completed",
                "output":[{"type":"output_text","text":"ordinary completed text without stop schema"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::Terminal);
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    assert_eq!(resp04.finalized_payload()["status"], "completed");
    assert_eq!(
        resp04.finalized_payload()["output"][0]["text"],
        "ordinary completed text without stop schema"
    );
}

#[test]
fn stopless_response_hook_stopreason_two_does_not_require_finish_reason() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_continue_without_finish",
                "status":"completed",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{
                        "type":"output_text",
                        "text":"```json\n{\"stopreason\":2,\"reason\":\"第一轮还没做完\",\"next_step\":\"等待 stop_message_auto 工具结果后继续第二轮验证\"}\n```"
                    }]
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    assert_eq!(resp03.tool_call_count(), 1);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let payload = resp04.canonical_context_payload().unwrap();
    assert_eq!(payload["output"][0]["call_id"], "call_stopless_reasoning");
    let arguments = payload["output"][0]["arguments"].as_str().unwrap();
    assert!(arguments.contains("routecodex hook run reasoningStop"));
    assert!(
        arguments
            .contains("\\\"next_step\\\":\\\"等待 stop_message_auto 工具结果后继续第二轮验证\\\""),
        "stopreason=2 next_step must reach the CLI status/control input: {arguments}"
    );
    assert!(
        !arguments.contains("--input-json '{}'"),
        "stopreason=2 must not be downgraded to missing-schema CLI input: {arguments}"
    );
    assert!(
        stopless_cli_input_from_arguments(arguments)["repeatCount"] == json!(1),
        "stopreason=2 CLI input must still carry the hook repeat state: {arguments}"
    );
}

#[test]
fn stopless_response_hook_ignores_non_completed_status() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_existing_action",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_existing",
                    "name":"exec_command",
                    "arguments":"{\"cmd\":\"existing command\"}"
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    assert_eq!(resp03.tool_call_count(), 1);
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.canonical_context_payload().unwrap();
    assert_eq!(payload["output"][0]["call_id"], "call_existing");
    assert_eq!(
        payload["output"][0]["arguments"],
        "{\"cmd\":\"existing command\"}"
    );
}

#[test]
fn stopless_response_hook_stopreason_two_projects_cli_for_next_turn() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_continue",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{
                    "type":"output_text",
                    "text":"{\"stopreason\":2,\"next_step\":\"continue the task\"}"
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    assert_eq!(resp03.tool_call_count(), 1);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let payload = resp04.canonical_context_payload().unwrap();
    assert_eq!(payload["output"][0]["name"], "exec_command");
    assert_eq!(payload["output"][0]["call_id"], "call_stopless_reasoning");
}

#[test]
fn stopless_response_hook_empty_output_does_not_project_cli() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_empty",
                "status":"completed",
                "finish_reason":"stop",
                "output":[]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::Terminal);
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
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
        let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
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
