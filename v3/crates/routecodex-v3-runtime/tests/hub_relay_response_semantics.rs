use routecodex_v3_runtime::{
    build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04,
    build_v3_provider_resp_inbound_01_raw,
    build_v3_provider_resp_inbound_01_raw_with_compat_profile,
    build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05,
    compile_v3_hub_relay_response_hooks, V3HubContinuationCommit, V3HubContinuationOwnership,
    V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource, V3HubProviderWireProtocol,
    V3HubRelayResponseError, V3HubRelayResponseHookProfile, V3HubResponseNormalizedKind,
    V3HubResponseTerminality, V3HubServertoolResponseAction, V3HubTransportIntent,
    V3StoplessHookState,
};
use serde_json::{json, Value};
use std::{fs, path::Path};

fn stopless_cli_input_from_arguments(arguments: &str) -> Value {
    let parsed: Value = serde_json::from_str(arguments).expect("arguments must be JSON");
    let cmd = parsed["cmd"].as_str().expect("cmd is required");
    let marker = "--input-json '";
    let start = cmd.find(marker).expect("input-json marker") + marker.len();
    let rest = &cmd[start..];
    let end = rest.find('\'').expect("input-json closing quote");
    serde_json::from_str(&rest[..end]).expect("input-json must be JSON")
}

fn stopless_projected_call(payload: &Value) -> &Value {
    payload["output"]
        .as_array()
        .expect("output array")
        .iter()
        .find(|item| item["call_id"] == json!("call_stopless_reasoning"))
        .expect("projected stopless exec_command call")
}

fn stopless_projected_arguments(payload: &Value) -> &str {
    stopless_projected_call(payload)["arguments"]
        .as_str()
        .expect("projected stopless arguments")
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
    assert_eq!(payload["output"][0]["text"], "I should stop without schema");
    let arguments = stopless_projected_arguments(payload);
    assert!(arguments.contains("routecodex hook run reasoningStop"));
    let call = stopless_projected_call(payload);
    assert_eq!(call["name"], "exec_command");
    assert_eq!(call["call_id"], "call_stopless_reasoning");
    let cli_input = stopless_cli_input_from_arguments(arguments);
    assert_eq!(cli_input["repeatCount"], json!(1));
    assert_eq!(cli_input["maxRepeats"], json!(3));
    assert_eq!(cli_input["triggerHint"], json!("no_schema"));
    assert!(!arguments.contains("status-control"));
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
    let arguments = stopless_projected_arguments(payload);
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
    let payload = resp04.finalized_payload();
    assert_eq!(payload["status"], "completed");
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
                "output":[{"type":"output_text","text":"{\"stopreason\":2,\"current_goal\":\"finish proof\",\"reason\":\"still working\",\"next_step\":\"continue the proof\"}"}]
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
    let arguments = stopless_projected_arguments(payload);
    let cli_input = stopless_cli_input_from_arguments(arguments);
    assert_eq!(cli_input["repeatCount"], json!(1));
    assert_eq!(cli_input["maxRepeats"], json!(3));
    assert_eq!(cli_input["triggerHint"], json!("non_terminal_schema"));
}

#[test]
fn stopless_response_hook_advances_consecutive_non_terminal_schema_repeat_count() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_non_terminal_budget",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"{\"stopreason\":2,\"current_goal\":\"finish proof\",\"reason\":\"still working\",\"next_step\":\"continue the proof\"}"}]
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
                    Some("non_terminal_schema".to_string()),
                )),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    assert_eq!(resp03.tool_call_count(), 1);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let payload = resp04.canonical_context_payload().unwrap();
    assert_eq!(payload["status"], "requires_action");
    let arguments = stopless_projected_arguments(payload);
    let cli_input = stopless_cli_input_from_arguments(arguments);
    assert_eq!(
        cli_input["repeatCount"],
        json!(2),
        "second consecutive stopreason=2 must advance the stop budget: {arguments}"
    );
    assert_eq!(cli_input["triggerHint"], json!("non_terminal_schema"));
}

#[test]
fn stopless_response_hook_does_not_project_third_consecutive_non_terminal_schema() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_non_terminal_budget_exhausted",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"{\"stopreason\":2,\"current_goal\":\"finish proof\",\"reason\":\"still working\",\"next_step\":\"continue the proof\"}"}]
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
    let serialized = serde_json::to_string(resp04.finalized_payload()).unwrap();
    assert!(!serialized.contains("call_stopless_reasoning"));
    assert!(!serialized.contains("routecodex hook run reasoningStop"));
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
    let arguments = stopless_projected_arguments(payload);
    let cli_input = stopless_cli_input_from_arguments(arguments);
    assert_eq!(cli_input["repeatCount"], json!(1));
    assert_eq!(cli_input["maxRepeats"], json!(3));
    assert_eq!(cli_input["triggerHint"], json!("invalid_schema"));
}

#[test]
fn stopless_response_hook_normalizes_schema_continue_alias_to_v2_trigger_hint() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_schema_continue_alias",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"{\"stopreason\":2,\"current_goal\":\"finish proof\",\"reason\":\"still working\",\"next_step\":\"continue the proof\",\"triggerHint\":\"schema_continue\"}"}]
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
    let arguments = stopless_projected_arguments(payload);
    let cli_input = stopless_cli_input_from_arguments(arguments);
    assert_eq!(cli_input["repeatCount"], json!(1));
    assert_eq!(cli_input["maxRepeats"], json!(3));
    assert_eq!(cli_input["triggerHint"], json!("non_terminal_schema"));
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
    let payload = resp04.finalized_payload();
    assert_eq!(payload["status"], "completed");
    let serialized = serde_json::to_string(payload).unwrap();
    assert!(serialized.contains("not numeric"));
    assert!(!serialized.contains("stopreason"));
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
                "output":[{"type":"output_text","text":"done {\"stopreason\":0,\"has_evidence\":1,\"evidence\":\"ok\"}"}]
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
    let visible = resp04.finalized_payload()["output"][0]["text"]
        .as_str()
        .expect("terminal visible text");
    assert_eq!(visible, "done");
    assert!(!visible.contains("stopreason"));
}

#[test]
fn stopless_budget_exhausted_terminal_schema_strips_control_json() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_budget_exhausted_terminal_schema",
                "object":"response",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{
                        "type":"output_text",
                        "text":"```json\n{\"stopreason\":0,\"current_goal\":\"验证 V3 stopless 连续两轮恢复\",\"reason\":\"已完成两轮停止检查恢复验证\",\"has_evidence\":1,\"evidence\":\"5555 live submit_tool_outputs\",\"next_step\":\"\",\"next_suggested_path\":\"\",\"learned\":\"summary must be markdown\"}\n```"
                    }]
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty()
                .with_stopless_reasoning_stop()
                .with_stopless_request_state(V3StoplessHookState::new(
                    2,
                    3,
                    Some("non_terminal_schema".to_string()),
                )),
        )
        .unwrap();
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    let visible = resp04.finalized_payload()["output"][0]["content"][0]["text"]
        .as_str()
        .expect("visible budget-exhausted text");
    assert!(visible.contains("## 完成内容"));
    assert!(visible.contains("已完成两轮停止检查恢复验证"));
    assert!(!visible.contains("stopreason"));
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
    let arguments = stopless_projected_arguments(payload);
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
fn stopless_response_hook_intercepts_reasoning_stop_tool_call_before_client_projection() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_reasoning_stop_tool",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_model_reasoning_stop",
                    "name":"reasoningStop",
                    "arguments":"{\"stopreason\":2,\"current_goal\":\"finish proof\",\"next_step\":\"continue proof\"}"
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
    let call = stopless_projected_call(payload);
    assert_eq!(call["name"], "exec_command");
    let arguments = stopless_projected_arguments(payload);
    assert!(arguments.contains("routecodex hook run reasoningStop"));
    let cli_input = stopless_cli_input_from_arguments(arguments);
    assert_eq!(cli_input["stopreason"], json!(2));
    assert_eq!(cli_input["next_step"], json!("continue proof"));
    let serialized = serde_json::to_string(payload).unwrap();
    assert!(!serialized.contains("\"name\":\"reasoningStop\""));
    assert!(!serialized.contains("call_model_reasoning_stop"));
}

#[test]
fn stopless_response_hook_terminal_reasoning_stop_tool_call_returns_visible_stop() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_reasoning_stop_terminal",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_model_reasoning_stop_terminal",
                    "name":"reasoningStop",
                    "arguments":"{\"stopreason\":0,\"reason\":\"done\",\"current_goal\":\"finish proof\",\"has_evidence\":1,\"evidence\":\"live proof\",\"issue_cause\":\"goal satisfied\",\"excluded_factors\":\"none\",\"diagnostic_order\":\"fixture -> gate\",\"done_steps\":\"proved terminal\",\"next_step\":\"\",\"needs_user_input\":false}"
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
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::Terminal);
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    let payload = resp04.finalized_payload();
    assert_eq!(payload["status"], "completed");
    let serialized = serde_json::to_string(payload).unwrap();
    assert!(serialized.contains("live proof"));
    assert!(!serialized.contains("\"name\":\"reasoningStop\""));
    assert!(!serialized.contains("call_model_reasoning_stop_terminal"));
}

#[test]
fn stopless_response_hook_budget_exhausted_reasoning_stop_tool_call_cleans_client_boundary() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "id":"resp_stopless_reasoning_stop_budget_exhausted",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_model_reasoning_stop_invalid",
                    "name":"reasoningStop",
                    "arguments":"{\"stopreason\":\"2\",\"reason\":\"stopreason must be numeric\",\"next_step\":\"retry with numeric stopreason\"}"
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty()
                .with_stopless_reasoning_stop()
                .with_stopless_request_state(V3StoplessHookState::new(
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
    let payload = resp04.finalized_payload();
    assert_eq!(payload["status"], "completed");
    let serialized = serde_json::to_string(payload).unwrap();
    assert!(serialized.contains("stopreason must be numeric"));
    for forbidden in [
        "\"name\":\"reasoningStop\"",
        "\"name\":\"exec_command\"",
        "call_model_reasoning_stop_invalid",
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "budget-exhausted client response leaked stopless control artifact: {forbidden}"
        );
    }
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
    assert_eq!(stopless_projected_call(payload)["name"], "exec_command");
}

#[test]
fn stopless_response_hook_empty_output_projects_no_schema_cli() {
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
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    assert_eq!(resp03.tool_call_count(), 1);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let payload = resp04.canonical_context_payload().unwrap();
    assert_eq!(payload["status"], "requires_action");
    assert_eq!(stopless_projected_call(payload)["name"], "exec_command");
    let cli_input = stopless_cli_input_from_arguments(stopless_projected_arguments(payload));
    assert_eq!(cli_input["repeatCount"], json!(1));
    assert_eq!(cli_input["maxRepeats"], json!(3));
    assert_eq!(cli_input["triggerHint"], json!("no_schema"));
}

#[test]
fn stopless_response_hook_missing_output_projects_no_schema_cli() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "object":"response",
                "id":"resp_stopless_missing_output",
                "status":"completed",
                "finish_reason":"stop"
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
    assert_eq!(stopless_projected_call(payload)["name"], "exec_command");
    let cli_input = stopless_cli_input_from_arguments(stopless_projected_arguments(payload));
    assert_eq!(cli_input["triggerHint"], json!("no_schema"));
}

#[test]
fn stopless_response_hook_does_not_project_empty_tool_calls_completed_response() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "object":"response",
                "id":"resp_tool_calls_empty_output",
                "status":"completed",
                "finish_reason":"tool_calls",
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
    assert_eq!(resp04.finalized_payload()["status"], "completed");
    assert_eq!(
        resp04.finalized_payload()["finish_reason"],
        json!("tool_calls")
    );
}

#[test]
fn stopless_response_hook_budget_exhausted_missing_output_passes_through_without_synthetic_text() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(
            json!({
                "object":"response",
                "id":"resp_stopless_budget_missing_output",
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
            &V3HubRelayResponseHookProfile::empty()
                .with_stopless_reasoning_stop()
                .with_stopless_request_state(V3StoplessHookState::new(
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
    let payload = resp04.finalized_payload();
    assert_eq!(payload["status"], "completed");
    assert_eq!(payload["output"], json!([]));
    assert!(!serde_json::to_string(payload)
        .unwrap()
        .contains("自动续轮已停止"));
}

#[test]
fn stopless_response_hook_budget_exhausted_does_not_intercept_tool_call_response() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let provider_payload = json!({
        "object":"response",
        "id":"resp_stopless_budget_malformed_tool_call",
        "status":"completed",
        "finish_reason":"stop",
        "output":[{
            "type":"function_call",
            "id":"fc_auto_1",
            "call_id":"call_auto_1",
            "name":"exec_command",
            "arguments":"{}"
        }]
    });
    let resp02 = hooks
        .normalize(relay_raw(
            provider_payload.clone(),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty()
                .with_stopless_reasoning_stop()
                .with_stopless_request_state(V3StoplessHookState::new(
                    2,
                    3,
                    Some("no_schema".to_string()),
                )),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    assert_eq!(resp03.tool_call_count(), 1);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let payload = resp04.finalized_payload();
    assert_eq!(payload, &provider_payload);
    let serialized = serde_json::to_string(payload).unwrap();
    assert!(!serialized.contains("自动续轮已停止"));
    assert!(!serialized.contains("call_stopless_reasoning"));
    assert!(!serialized.contains("reasoningStop"));
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

#[test]
fn stopless_real_5555_sample_5973_reports_activation_true_and_requires_action() {
    let sample = real_5555_sample_json(
        "openai-responses-router-gpt-5.5-20260718T171347967-566984-5973",
        "response.json",
    );
    let Some(sample) = sample else {
        return;
    };
    let obs = sample["observability"]
        .as_object()
        .expect("sample observability object");
    assert_eq!(obs.get("stopless_activation"), Some(&json!(true)));
    assert_eq!(obs.get("response_status"), Some(&json!("requires_action")));
    assert_eq!(obs.get("finish_reason"), Some(&json!("tool_calls")));
    assert_eq!(obs.get("model_id"), Some(&json!("glm-5.2")));
    assert_eq!(
        obs.get("target_path"),
        Some(&json!([
            "pool:default",
            "forwarder:fwd.glm.glm-5.2",
            "provider:orangeai"
        ]))
    );
}

#[test]
fn stopless_real_5555_sample_6272_reports_activation_false_and_terminal_stop() {
    let sample = real_5555_sample_json(
        "openai-responses-router-gpt-5.5-20260718T180101332-567283-6272",
        "response.json",
    );
    let Some(sample) = sample else {
        return;
    };
    let obs = sample["observability"]
        .as_object()
        .expect("sample observability object");
    assert_eq!(obs.get("stopless_activation"), Some(&json!(false)));
    assert_eq!(obs.get("response_status"), Some(&json!("completed")));
    assert_eq!(obs.get("finish_reason"), Some(&json!("stop")));
    assert_eq!(obs.get("model_id"), Some(&json!("glm-5.2")));
}
