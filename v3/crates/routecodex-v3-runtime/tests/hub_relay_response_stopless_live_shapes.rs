use routecodex_v3_runtime::{
    build_v3_provider_resp_inbound_01_raw, compile_v3_hub_relay_response_hooks,
    V3HubContinuationCommit, V3HubContinuationOwnership, V3HubEntryProtocol, V3HubExecutionMode,
    V3HubInvocationSource, V3HubProviderWireProtocol, V3HubRelayResponseHookProfile,
    V3HubResponseTerminality, V3HubTransportIntent, V3StoplessCenterState,
    V3StoplessCenterSteering,
};
use serde_json::{json, Value};

fn stopless_projected_call(payload: &Value) -> &Value {
    payload["output"]
        .as_array()
        .expect("output array")
        .iter()
        .find(|item| item["call_id"] == json!("call_stopless_reasoning"))
        .expect("projected stopless exec_command call")
}

fn stopless_projected_cmd(payload: &Value) -> String {
    let arguments = stopless_projected_call(payload)["arguments"]
        .as_str()
        .expect("projected stopless arguments");
    serde_json::from_str::<Value>(arguments).expect("arguments JSON")["cmd"]
        .as_str()
        .expect("cmd")
        .to_string()
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
fn stopless_live_shape_natural_stop_missing_finish_reason_projects_noop_cli() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "object":"response",
            "id":"resp_live_missing_finish_reason",
            "status":"completed",
            "output":[{
                "type":"message",
                "role":"assistant",
                "status":"completed",
                "content":[{"type":"output_text","text":"我还没有完成，需要继续。"}]
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
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    assert_eq!(
        resp04.stopless_center_state().unwrap().natural_stop_count(),
        1
    );
    let payload = resp04.canonical_context_payload().unwrap();
    assert_eq!(payload["status"], "requires_action");
    assert_eq!(
        stopless_projected_cmd(payload),
        "routecodex hook run reasoningStop"
    );
    let serialized = serde_json::to_string(payload).unwrap();
    assert!(!serialized.contains("--input-json"));
    for forbidden in [
        "repeatCount",
        "triggerHint",
        "schemaFeedback",
        "next_step",
        "continuationPrompt",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "live no-op projection leaked old control {forbidden}: {serialized}"
        );
    }
}

#[test]
fn stopless_live_shape_preface_and_fenced_schema_text_is_visible_only_not_state() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let live_text = concat!(
        "{\"stopreason\":2,\"current_goal\":\"old text\",\"next_step\":\"must not drive state\"}",
        "\n\n<rcc_stop_schema>\n",
        "{\"stopreason\":0,\"evidence\":\"old fence\"}",
        "\n</rcc_stop_schema>"
    );
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "id":"resp_live_text_schema_ignored",
            "object":"response",
            "status":"completed",
            "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":live_text}]}],
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
    assert_eq!(
        stopless_projected_cmd(resp04.canonical_context_payload().unwrap()),
        "routecodex hook run reasoningStop"
    );
}

#[test]
fn stopless_live_shape_third_natural_stop_projects_noop_cli() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let live_text = "第三次自然 stop，仍应完成第三次投影。";
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "id":"resp_live_third_natural_stop",
            "model":"MiniMax-M3",
            "object":"response",
            "status":"completed",
            "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":live_text}]}],
            "output_text": live_text
        })))
        .unwrap();

    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty()
                .with_stopless_reasoning_stop()
                .with_stopless_center_state(V3StoplessCenterState::new(
                    2,
                    3,
                    V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
                )),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    assert_eq!(resp03.tool_call_count(), 1);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let serialized = serde_json::to_string(resp04.finalized_payload()).unwrap();
    assert!(serialized.contains(live_text));
    assert!(serialized.contains("call_stopless_reasoning"));
    assert!(serialized.contains("routecodex hook run reasoningStop"));
}

#[test]
fn stopless_live_shape_fourth_natural_stop_passes_original_text_without_cli() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let live_text = "第四次自然 stop，三次投影已完成，应该放行。";
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "id":"resp_live_fourth_natural_stop",
            "model":"MiniMax-M3",
            "object":"response",
            "status":"completed",
            "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":live_text}]}],
            "output_text": live_text
        })))
        .unwrap();

    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty()
                .with_stopless_reasoning_stop()
                .with_stopless_center_state(V3StoplessCenterState::new(
                    3,
                    3,
                    V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
                )),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::Terminal);
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    let serialized = serde_json::to_string(resp04.finalized_payload()).unwrap();
    assert!(serialized.contains(live_text));
    assert!(!serialized.contains("call_stopless_reasoning"));
    assert!(!serialized.contains("routecodex hook run reasoningStop"));
}

#[test]
fn stopless_live_shape_guard_schema_only_text_passes_through_without_intercept() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let control_only_text =
        r#"{"stopreason":2,"current_goal":"still running","next_step":"continue"}"#;
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "id":"resp_live_guard_schema_only",
            "model":"glm-5.2",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":control_only_text}]}],
            "output_text": control_only_text
        })))
        .unwrap();

    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty()
                .with_stopless_reasoning_stop()
                .with_stopless_center_state(V3StoplessCenterState::new(
                    3,
                    3,
                    V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
                )),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::Terminal);
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    let serialized = serde_json::to_string(resp04.finalized_payload()).unwrap();
    assert_eq!(resp04.finalized_payload()["status"], "completed");
    assert_eq!(resp04.finalized_payload()["finish_reason"], "stop");
    assert_eq!(
        resp04.finalized_payload()["output_text"],
        json!(control_only_text),
        "guard terminal must stop intercepting and pass through the provider finish_reason=stop response"
    );
    assert!(
        !serialized.contains("Stopless 已达到连续自动续轮上限"),
        "guard terminal must not expose internal stopless budget state: {serialized}"
    );
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "guard terminal must not project another no-op bridge artifact {forbidden}: {serialized}"
        );
    }
}

#[test]
fn stopless_live_shape_reasoning_stop_tool_call_is_the_only_state_source() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "id":"resp_live_reasoning_stop_continue",
            "object":"response",
            "status":"requires_action",
            "output":[{
                "type":"function_call",
                "call_id":"call_model_reasoning_stop_live",
                "name":"reasoningStop",
                "arguments":"{\"stopreason\":2,\"reason\":\"continue\"}"
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
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(
        resp04.stopless_center_state().unwrap().steering(),
        V3StoplessCenterSteering::Continue
    );
    let payload = resp04.canonical_context_payload().unwrap();
    assert_eq!(
        stopless_projected_cmd(payload),
        "routecodex hook run reasoningStop"
    );
    let serialized = serde_json::to_string(payload).unwrap();
    assert!(!serialized.contains("call_model_reasoning_stop_live"));
    assert!(!serialized.contains("\"name\":\"reasoningStop\""));
}

#[test]
fn stopless_live_shape_guard_reasoning_continue_tool_does_not_project_noop_or_diagnostic() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let visible_text = "我已经说明当前仍需继续，但这里应只透传当前可见文本。";
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "id":"resp_live_reasoning_stop_continue_guard",
            "object":"response",
            "status":"requires_action",
            "output":[
                {"type":"message","role":"assistant","content":[{"type":"output_text","text":visible_text}]},
                {
                    "type":"function_call",
                    "call_id":"call_model_reasoning_stop_live_guard",
                    "name":"reasoningStop",
                    "arguments":"{\"stopreason\":2,\"reason\":\"continue\"}"
                }
            ]
        })))
        .unwrap();

    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty()
                .with_stopless_reasoning_stop()
                .with_stopless_center_state(V3StoplessCenterState::new(
                    3,
                    3,
                    V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
                )),
        )
        .unwrap();
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::Terminal);
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    assert!(resp04.stopless_center_state().is_none());
    let payload = resp04.finalized_payload();
    assert_eq!(payload["status"], "completed");
    let serialized = serde_json::to_string(payload).unwrap();
    assert!(serialized.contains(visible_text));
    for forbidden in [
        "call_model_reasoning_stop_live_guard",
        "\"name\":\"reasoningStop\"",
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "Stopless 已达到连续自动续轮上限",
        "续轮上限",
        "连续 stop 次数",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "guard must not project no-op/internal diagnostic/tool artifact {forbidden}: {serialized}"
        );
    }
}
