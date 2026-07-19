use routecodex_v3_runtime::{
    build_v3_provider_resp_inbound_01_raw, compile_v3_hub_relay_response_hooks,
    V3HubContinuationCommit, V3HubContinuationOwnership, V3HubEntryProtocol, V3HubExecutionMode,
    V3HubInvocationSource, V3HubProviderWireProtocol, V3HubRelayResponseHookProfile,
    V3HubResponseTerminality, V3HubTransportIntent, V3StoplessHookState,
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

fn stopless_projected_call(payload: &Value) -> &Value {
    payload["output"]
        .as_array()
        .expect("output array")
        .iter()
        .find(|item| item["call_id"] == json!("call_stopless_reasoning"))
        .expect("projected stopless exec_command call")
}

fn relay_raw(payload: Value) -> routecodex_v3_runtime::V3ProviderRespInbound01Raw {
    build_v3_provider_resp_inbound_01_raw(
        payload,
        V3HubEntryProtocol::Responses,
        V3HubProviderWireProtocol::Responses,
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    )
}

#[test]
fn stopless_projects_cli_for_live_responses_object_missing_finish_reason_and_schema() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "object":"response",
            "id":"resp_live_missing_schema_no_finish_reason",
            "status":"completed",
            "output":[{
                "type":"message",
                "role":"assistant",
                "status":"completed",
                "content":[{
                    "type":"output_text",
                    "text":"我还没有完成，需要继续。"
                }]
            }]
        })))
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
    let call = stopless_projected_call(payload);
    assert_eq!(call["call_id"], "call_stopless_reasoning");
    assert_eq!(call["name"], "exec_command");
    let cli_input = stopless_cli_input_from_arguments(call["arguments"].as_str().unwrap());
    assert_eq!(cli_input["repeatCount"], json!(1));
    assert_eq!(cli_input["triggerHint"], json!("no_schema"));
}

#[test]
fn stopless_projects_cli_for_live_responses_object_invalid_schema_without_finish_reason() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "object":"response",
            "id":"resp_live_invalid_schema_no_finish_reason",
            "status":"completed",
            "output":[{
                "type":"message",
                "role":"assistant",
                "status":"completed",
                "content":[{
                    "type":"output_text",
                    "text":"{\"stopreason\":\"two\",\"current_goal\":123,\"next_step\":false}"
                }]
            }]
        })))
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
    let call = stopless_projected_call(payload);
    assert_eq!(call["call_id"], "call_stopless_reasoning");
    assert_eq!(call["name"], "exec_command");
    assert!(call["arguments"]
        .as_str()
        .unwrap()
        .contains("routecodex hook run reasoningStop"));
}

#[test]
fn stopless_projects_cli_for_live_stopreason_two_after_prior_repeat_two_state() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let live_text = "{\"stopreason\":2,\"reason\":\"第二轮还没做完\",\"current_goal\":\"验证 V3 stopless 连续两轮恢复\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"继续最终核对：只输出 stop schema JSON，stopreason=0\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}";
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "id":"resp_06aae68ef572d1a1fed1702e51dbace5",
            "model":"MiniMax-M3",
            "object":"response",
            "status":"completed",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{
                    "type":"output_text",
                    "text": live_text
                }]
            }],
            "output_text": live_text,
            "usage":{
                "input_tokens":1872,
                "output_tokens":206,
                "total_tokens":2078
            }
        })))
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
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    assert_eq!(resp03.tool_call_count(), 1);

    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let payload = resp04.canonical_context_payload().unwrap();
    assert_eq!(payload["status"], "requires_action");
    let call = stopless_projected_call(payload);
    assert_eq!(call["name"], "exec_command");
    let cli_input = stopless_cli_input_from_arguments(call["arguments"].as_str().unwrap());
    assert_eq!(cli_input["repeatCount"], json!(1));
    assert_eq!(cli_input["triggerHint"], json!("non_terminal_schema"));
    assert!(
        !serde_json::to_string(payload)
            .unwrap()
            .contains("\"status\":\"completed\""),
        "valid stopreason=2 live shape must not pass through as completed"
    );
}

#[test]
fn stopless_projects_cli_for_live_stopreason_two_with_preface_and_fenced_schema() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let live_text = concat!(
        "{\"stopreason\":2,\"current_goal\":\"live schema correct reentry\",\"reason\":\"第一轮继续\",\"next_step\":\"继续最终核对\"}",
        "\n\n<rcc_stop_schema>\n",
        "{\"stopreason\":2,\"reason\":\"第一轮继续\",\"current_goal\":\"live schema correct reentry\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"继续最终核对\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}",
        "\n</rcc_stop_schema>"
    );
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "id":"resp_06aaed15e840603c236252ca67cedbf6",
            "model":"MiniMax-M3",
            "object":"response",
            "status":"completed",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{
                    "type":"output_text",
                    "text": live_text
                }]
            }],
            "output_text": live_text
        })))
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
    let call = stopless_projected_call(payload);
    assert_eq!(call["name"], "exec_command");
    let cli_input = stopless_cli_input_from_arguments(call["arguments"].as_str().unwrap());
    assert_eq!(cli_input["stopreason"], json!(2));
    assert_eq!(cli_input["triggerHint"], json!("non_terminal_schema"));
    assert!(
        !serde_json::to_string(payload)
            .unwrap()
            .contains("\"status\":\"completed\""),
        "mixed live text plus fenced stopreason=2 must not pass through as completed"
    );
}

#[test]
fn stopless_prefers_tagged_schema_over_preface_json_object() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let live_text = concat!(
        "{\"note\":\"this debug object is not the stop schema\"}",
        "\n\n<rcc_stop_schema>\n",
        "{\"stopreason\":2,\"reason\":\"tagged schema wins\",\"current_goal\":\"prove fence priority\",\"has_evidence\":0,\"evidence\":\"\",\"next_step\":\"continue from tagged schema\",\"needs_user_input\":false}",
        "\n</rcc_stop_schema>"
    );
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "id":"resp_live_tag_priority",
            "model":"MiniMax-M3",
            "object":"response",
            "status":"completed",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{
                    "type":"output_text",
                    "text": live_text
                }]
            }],
            "output_text": live_text
        })))
        .unwrap();

    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);

    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let payload = resp04.canonical_context_payload().unwrap();
    let call = stopless_projected_call(payload);
    let cli_input = stopless_cli_input_from_arguments(call["arguments"].as_str().unwrap());
    assert_eq!(cli_input["stopreason"], json!(2));
    assert_eq!(cli_input["next_step"], json!("continue from tagged schema"));
    assert_eq!(cli_input["triggerHint"], json!("non_terminal_schema"));
}

#[test]
fn stopless_balanced_scan_skips_non_schema_json_before_stopreason_object() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let live_text = concat!(
        "debug object: {\"note\":\"not schema\",\"nested\":{\"brace\":\"}\"}}",
        "\nreal schema: ",
        "{\"stopreason\":2,\"reason\":\"balanced scan found schema\",\"current_goal\":\"prove scan\",\"has_evidence\":0,\"evidence\":\"\",\"next_step\":\"continue from balanced schema\",\"needs_user_input\":false}"
    );
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "id":"resp_live_balanced_scan",
            "model":"MiniMax-M3",
            "object":"response",
            "status":"completed",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{
                    "type":"output_text",
                    "text": live_text
                }]
            }],
            "output_text": live_text
        })))
        .unwrap();

    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);

    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let payload = resp04.canonical_context_payload().unwrap();
    let call = stopless_projected_call(payload);
    let cli_input = stopless_cli_input_from_arguments(call["arguments"].as_str().unwrap());
    assert_eq!(cli_input["stopreason"], json!(2));
    assert_eq!(
        cli_input["next_step"],
        json!("continue from balanced schema")
    );
    assert_eq!(cli_input["triggerHint"], json!("non_terminal_schema"));
}
