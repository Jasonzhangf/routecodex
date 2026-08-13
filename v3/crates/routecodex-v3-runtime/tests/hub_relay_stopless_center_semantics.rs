use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, build_v3_provider_resp_inbound_01_raw,
    compile_v3_hub_relay_request_hooks, compile_v3_hub_relay_response_hooks,
    execute_v3_responses_relay_runtime,
    execute_v3_responses_relay_runtime_with_transport_health_and_stopless_control,
    V3HubContinuationLookup, V3HubContinuationOwnership, V3HubContinuationScope,
    V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource, V3HubProviderWireProtocol,
    V3HubRelayRequestHookEvent, V3HubRelayResponseHookProfile, V3HubServertoolRequestProfile,
    V3HubTransportIntent, V3ResponsesRelayClientBody, V3ResponsesRelayProviderHealthHandle,
    V3ResponsesRelayRuntimeInput, V3ResponsesRelayStoplessControlScope,
    V3ResponsesRelayStoplessControlState, V3StoplessCenterNextRequestPolicy, V3StoplessCenterPhase,
    V3StoplessCenterState, V3StoplessCenterSteering, V3StoplessCenterStopKind,
};
use serde_json::{json, Value};
use std::sync::Mutex;

fn relay_response(payload: Value) -> routecodex_v3_runtime::V3ProviderRespInbound01Raw {
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

fn raw_request(payload: Value) -> routecodex_v3_runtime::V3HubReqInbound01ClientRaw {
    build_v3_hub_req_inbound_01_client_raw(
        payload,
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    )
}

fn scope() -> V3HubContinuationScope {
    V3HubContinuationScope::new(
        V3HubEntryProtocol::Responses,
        "server-a",
        "group-a",
        "session-a",
    )
}

fn active_stopless_response_profile(
    consecutive_stop_count: u32,
    request_id: &'static str,
) -> V3HubRelayResponseHookProfile {
    V3HubRelayResponseHookProfile::empty()
        .with_stopless_reasoning_stop()
        .with_stopless_transition_context(request_id, 55_000)
        .with_stopless_center_state(
            V3StoplessCenterState::new(
                consecutive_stop_count,
                3,
                V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
            )
            .provider_turn_in_flight(Some(request_id), Some(55_000)),
        )
}

fn reasoning_summary_texts(payload: &Value) -> Vec<String> {
    payload
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("reasoning"))
        .flat_map(|item| {
            item.get("summary")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|entry| entry.get("text").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

#[test]
fn stopless_center_state_machine_locks_normal_and_abnormal_transitions() {
    let first = V3StoplessCenterState::new(
        1,
        3,
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
    )
    .with_last_request_id(Some("req-1"))
    .with_last_response_id(Some("resp-1"))
    .with_last_transition_reason("natural_stop_cli_projected")
    .with_updated_at(10);
    assert_eq!(first.phase(), V3StoplessCenterPhase::CliNoopProjected);
    assert_eq!(first.consecutive_stop_count(), 1);
    assert_eq!(
        first.last_stop_kind(),
        V3StoplessCenterStopKind::NaturalStop
    );
    assert!(first.need_continue());
    assert!(!first.blocked());
    assert!(!first.terminal());
    assert_eq!(
        first.next_request_policy(),
        V3StoplessCenterNextRequestPolicy::ContinueDefault
    );
    assert!(!first.schema_guidance_active());
    assert_eq!(first.schema_guidance_request_id(), None);
    assert_eq!(first.schema_guidance_contract(), None);
    assert!(!first.schema_guidance_active_for(Some("req-1")));

    let observed = first.clone().cli_noop_observed(Some("req-2"), Some(20));
    assert_eq!(observed.phase(), V3StoplessCenterPhase::CliNoopObserved);
    assert_eq!(observed.last_request_id(), Some("req-2"));
    assert_eq!(observed.updated_at(), 20);
    assert_eq!(
        observed.last_transition_reason(),
        Some("req04_stopless_noop_observed")
    );
    assert!(!observed.schema_guidance_active());
    assert_eq!(observed.schema_guidance_request_id(), None);
    assert_eq!(observed.schema_guidance_contract(), None);

    let prepared = observed
        .clone()
        .continuation_guidance_prepared(Some("req-2"), Some(21));
    assert_eq!(
        prepared.phase(),
        V3StoplessCenterPhase::ContinuationGuidancePrepared
    );
    assert_eq!(prepared.last_request_id(), Some("req-2"));
    assert_eq!(prepared.updated_at(), 21);
    assert_eq!(
        prepared.last_transition_reason(),
        Some("req04_stopless_continuation_guidance_prepared")
    );
    assert!(!prepared.schema_guidance_active());
    assert_eq!(prepared.schema_guidance_request_id(), None);
    assert_eq!(prepared.schema_guidance_contract(), None);

    let in_flight = prepared
        .clone()
        .provider_turn_in_flight(Some("req-2"), Some(22));
    assert_eq!(
        in_flight.phase(),
        V3StoplessCenterPhase::ProviderTurnInFlight
    );
    assert_eq!(in_flight.last_request_id(), Some("req-2"));
    assert_eq!(in_flight.updated_at(), 22);
    assert_eq!(
        in_flight.last_transition_reason(),
        Some("req04_stopless_guidance_prepared")
    );
    assert_eq!(in_flight.consecutive_stop_count(), 1);
    assert!(in_flight.schema_guidance_active());
    assert_eq!(in_flight.schema_guidance_request_id(), Some("req-2"));
    assert_eq!(in_flight.schema_guidance_contract(), Some("stop_schema"));
    assert!(in_flight.schema_guidance_active_for(Some("req-2")));
    assert!(!in_flight.schema_guidance_active_for(Some("req-3")));
    assert!(!in_flight.schema_guidance_active_for(None));

    let no_request_in_flight = prepared.clone().provider_turn_in_flight(None, Some(23));
    assert_eq!(
        no_request_in_flight.phase(),
        V3StoplessCenterPhase::ProviderTurnInFlight
    );
    assert!(!no_request_in_flight.schema_guidance_active());
    assert_eq!(no_request_in_flight.schema_guidance_request_id(), None);
    assert_eq!(no_request_in_flight.schema_guidance_contract(), None);

    let stronger = V3StoplessCenterState::new(
        2,
        3,
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
    );
    assert_eq!(stronger.phase(), V3StoplessCenterPhase::CliNoopProjected);
    assert_eq!(
        stronger.next_request_policy(),
        V3StoplessCenterNextRequestPolicy::ContinueWithStrongerInstruction
    );
    assert!(stronger.need_continue());
    assert!(!stronger.guard_exhausted());

    let third_projection = V3StoplessCenterState::new(
        3,
        3,
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
    );
    assert_eq!(
        third_projection.phase(),
        V3StoplessCenterPhase::CliNoopProjected
    );
    assert_eq!(
        third_projection.next_request_policy(),
        V3StoplessCenterNextRequestPolicy::ContinueWithStrongerInstruction
    );
    assert!(third_projection.need_continue());
    assert!(!third_projection.guard_exhausted());
    assert!(!third_projection.terminal());

    let needs_evidence =
        V3StoplessCenterState::new(1, 3, V3StoplessCenterSteering::ReasoningStopNeedsEvidence);
    assert_eq!(
        needs_evidence.last_stop_kind(),
        V3StoplessCenterStopKind::ReasoningNeedsEvidence
    );
    assert_eq!(
        needs_evidence.next_request_policy(),
        V3StoplessCenterNextRequestPolicy::AskForCompletionEvidence
    );
    assert!(needs_evidence.need_continue());
    assert!(!needs_evidence.terminal());

    let blocked = V3StoplessCenterState::new(1, 3, V3StoplessCenterSteering::Blocked);
    assert_eq!(blocked.phase(), V3StoplessCenterPhase::TerminalBlocked);
    assert_eq!(
        blocked.last_stop_kind(),
        V3StoplessCenterStopKind::ReasoningBlocked
    );
    assert!(blocked.blocked());
    assert!(blocked.terminal());
    assert_eq!(
        blocked.next_request_policy(),
        V3StoplessCenterNextRequestPolicy::StopForUserBlock
    );

    let guard = V3StoplessCenterState::new(
        4,
        3,
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
    );
    assert_eq!(guard.phase(), V3StoplessCenterPhase::GuardTerminal);
    assert_eq!(
        guard.last_stop_kind(),
        V3StoplessCenterStopKind::NaturalStop
    );
    assert!(guard.guard_exhausted());
    assert!(guard.terminal());
    assert!(!guard.need_continue());
    assert_eq!(
        guard.next_request_policy(),
        V3StoplessCenterNextRequestPolicy::StopForGuard
    );
}

#[test]
fn stopless_center_request_state_stays_control_only_without_provider_guidance() {
    for state in [
        V3StoplessCenterState::new(
            1,
            3,
            V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
        ),
        V3StoplessCenterState::new(
            2,
            3,
            V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
        ),
        V3StoplessCenterState::new(1, 3, V3StoplessCenterSteering::ReasoningStopNeedsEvidence),
        V3StoplessCenterState::new(1, 3, V3StoplessCenterSteering::Blocked),
    ] {
        assert!(
            !format!("{state:?}").contains("routecodex hook run reasoningStop"),
            "StoplessCenter control state must not encode provider-visible CLI guidance"
        );
    }
}

#[test]
fn natural_stop_projects_noop_cli_without_cli_state_json() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(json!({
            "id":"resp_natural_stop_noop",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"自然停下的可见文本"}]
            }]
        })))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &active_stopless_response_profile(0, "req-natural-stop-noop"),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.finalized_payload();
    let state = resp04
        .control_transition()
        .expect("natural stop must update StoplessCenter");

    assert_eq!(payload["status"], "completed");
    assert!(!serde_json::to_string(payload)
        .unwrap()
        .contains("call_stopless_reasoning"));
    assert_eq!(state.phase(), V3StoplessCenterPhase::CliNoopProjected);
    assert_eq!(state.consecutive_stop_count(), 1);
    assert_eq!(state.natural_stop_count(), 1);
    assert_eq!(state.max_stop_budget(), 3);
    assert_eq!(state.max_natural_stops(), 3);
    assert_eq!(
        state.last_stop_kind(),
        V3StoplessCenterStopKind::NaturalStop
    );
    assert!(state.need_continue());
    assert!(!state.blocked());
    assert!(!state.terminal());
    assert!(!state.guard_exhausted());
    assert_eq!(
        state.next_request_policy(),
        V3StoplessCenterNextRequestPolicy::ContinueDefault
    );
    assert_eq!(state.last_request_id(), Some("req-natural-stop-noop"));
    assert_eq!(state.last_response_id(), Some("resp_natural_stop_noop"));
    assert_eq!(
        state.last_transition_reason(),
        Some("natural_stop_cli_projected")
    );
    let serialized = serde_json::to_string(payload).unwrap();
    assert!(!serialized.contains("--input-json"));
    for forbidden in [
        "repeatCount",
        "maxRepeats",
        "triggerHint",
        "schemaFeedback",
        "<rcc_stop_schema>",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "no-op stopless projection leaked old CLI/schema state {forbidden}: {serialized}"
        );
    }
    assert!(
        serialized.contains("自然停下的可见文本"),
        "client-visible assistant text must survive natural-stop projection: {serialized}"
    );
}

#[test]
fn inactive_schema_guidance_stop_passes_without_cli_projection_or_state_write() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(json!({
            "id":"resp_inactive_stop_passthrough",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"inactive stop must pass through"}]
            }]
        })))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.finalized_payload();
    let serialized = serde_json::to_string(payload).unwrap();

    assert_eq!(payload["status"], "completed");
    assert_eq!(payload["finish_reason"], "stop");
    assert!(resp04.control_transition().is_none());
    assert!(serialized.contains("inactive stop must pass through"));
    assert!(!serialized.contains("call_stopless_reasoning"));
    assert!(!serialized.contains("routecodex hook run reasoningStop"));
}

#[test]
fn natural_stop_does_not_trust_reasoning_summary_stop_schema_as_control() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(json!({
            "id":"resp_natural_stop_with_summary",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[
                {
                    "type":"reasoning",
                    "summary":[{
                        "type":"summary_text",
                        "text":"The task is complete with evidence."
                    }],
                    "stop_schema":{
                        "finished":true,
                        "blocked":false,
                        "nextStep":""
                    }
                },
                {
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"完成。"}]
                }
            ]
        })))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &active_stopless_response_profile(0, "req-summary-next-step"),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.finalized_payload();

    assert_eq!(payload["status"], "completed");
    assert_eq!(payload["finish_reason"], "stop");
    let state = resp04
        .control_transition()
        .expect("payload stop_schema must not bypass StoplessCenter natural-stop counting");
    assert_eq!(state.consecutive_stop_count(), 1);
    assert_eq!(
        state.steering(),
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop
    );
    assert!(!serde_json::to_string(payload)
        .unwrap()
        .contains("stop_schema"));
    assert!(
        payload
            .get("output")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .all(|item| item.get("call_id").and_then(Value::as_str)
                != Some("call_stopless_reasoning")),
        "summary-complete response must not project the client-visible stopless CLI: {payload}"
    );
}

#[test]
fn third_consecutive_natural_stop_ignores_summary_stop_schema_control() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let prior_state = V3StoplessCenterState::new(
        2,
        3,
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
    );
    let resp02 = hooks
        .normalize(relay_response(json!({
            "id":"resp_third_stop_with_summary",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[
                {
                    "type":"reasoning",
                    "summary":[{
                        "type":"summary_text",
                        "text":"The repeated stop is actually a complete answer."
                    }],
                    "stop_schema":{
                        "finished":true,
                        "blocked":false
                    }
                },
                {"type":"output_text","text":"第三次停止但已完成。"}
            ]
        })))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty()
                .with_stopless_reasoning_stop()
                .with_stopless_transition_context("req-summary-third", 55_000)
                .with_stopless_center_state(
                    prior_state.provider_turn_in_flight(Some("req-summary-third"), Some(55_000)),
                ),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.finalized_payload();

    assert_eq!(payload["status"], "completed");
    let state = resp04
        .control_transition()
        .expect("payload stop_schema must not clear the StoplessCenter state");
    assert_eq!(state.consecutive_stop_count(), 3);
    assert_eq!(
        state.steering(),
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop
    );
    assert!(!serde_json::to_string(payload)
        .unwrap()
        .contains("stop_schema"));
    assert!(
        payload
            .get("output")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .all(|item| item.get("call_id").and_then(Value::as_str)
                != Some("call_stopless_reasoning")),
        "third stop with summary must not project stopless CLI: {payload}"
    );
}

#[test]
fn natural_stop_summary_next_step_cannot_seed_req04_control() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(json!({
            "id":"resp_summary_schema_next_step",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[
                {
                    "type":"reasoning",
                    "summary":[{
                        "type":"summary_text",
                        "text":"I found the next concrete action but have not run it yet."
                    }],
                    "stop_schema":{
                        "finished":false,
                        "blocked":false,
                        "nextStep":"Run cargo test for the new summary/schema stopless gate."
                    }
                },
                {"type":"output_text","text":"下一步需要跑测试。"}
            ]
        })))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &active_stopless_response_profile(0, "req-summary-blocked"),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.finalized_payload();
    let state = resp04
        .control_transition()
        .expect("natural stop must be recorded by StoplessCenter");

    assert_eq!(payload["status"], "completed");
    assert_eq!(
        state.steering(),
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop
    );
    assert_eq!(state.next_step_prompt(), None);
    assert_eq!(
        state.last_transition_reason(),
        Some("natural_stop_cli_projected")
    );

    let serialized = serde_json::to_string(payload).unwrap();
    assert!(
        !serialized.contains("stop_schema"),
        "client-visible no-op projection must not leak canonical stop_schema control field: {serialized}"
    );
}

#[test]
fn natural_stop_summary_blocked_reason_cannot_drive_control_or_rewrite_summary() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(json!({
            "id":"resp_summary_schema_blocked",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[
                {
                    "type":"reasoning",
                    "summary":[{
                        "type":"summary_text",
                        "text":"I cannot continue without the external approval."
                    }],
                    "stop_schema":{
                        "finished":false,
                        "blocked":true,
                        "blockedReason":"Need Jason approval before deleting production config."
                    }
                },
                {"type":"output_text","text":"需要确认。"}
            ]
        })))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &active_stopless_response_profile(0, "req-anthropic-end-turn"),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.finalized_payload();
    let summaries = reasoning_summary_texts(payload);

    assert_eq!(payload["status"], "completed");
    let state = resp04
        .control_transition()
        .expect("payload blocked flag must not bypass natural-stop counting");
    assert_eq!(state.consecutive_stop_count(), 1);
    assert_eq!(
        state.steering(),
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop
    );
    assert!(
        summaries
            .iter()
            .all(|text| !text.contains("Need Jason approval before deleting production config.")),
        "payload control text must not rewrite canonical reasoning summary: {summaries:?}"
    );
    assert!(!serde_json::to_string(payload)
        .unwrap()
        .contains("stop_schema"));
    assert!(
        payload
            .get("output")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .all(|item| item.get("call_id").and_then(Value::as_str)
                != Some("call_stopless_reasoning")),
        "blocked schema response must not project stopless CLI: {payload}"
    );
}

#[test]
fn anthropic_end_turn_text_stop_schema_is_natural_stop_for_stopless() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(json!({
            "id":"resp_anthropic_end_turn_stopless",
            "object":"response",
            "status":"completed",
            "finish_reason":"end_turn",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{
                    "type":"output_text",
                    "text": r#"{"stopreason":2,"current_goal":"still running","next_step":"continue"}"#
                }]
            }]
        })))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &active_stopless_response_profile(0, "req-assistant-fence"),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();

    assert_eq!(resp04.finalized_payload()["status"], "completed");
    assert!(
        !serde_json::to_string(resp04.finalized_payload())
            .unwrap()
            .contains("call_stopless_reasoning"),
        "Anthropic end_turn stopless transition must stay out of business payload"
    );
}

#[test]
fn assistant_text_stop_schema_fence_is_not_a_stopless_state_source() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(json!({
            "id":"resp_fence_ignored",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{
                    "type":"output_text",
                    "text":"旧正文 schema 不再是状态源\n<rcc_stop_schema>{\"stopreason\":0,\"has_evidence\":1,\"evidence\":\"old fence\"}</rcc_stop_schema>"
                }]
            }]
        })))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &active_stopless_response_profile(0, "req-fence-active"),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();

    assert_eq!(
        resp04.finalized_payload()["status"],
        "completed",
        "assistant text/fence must be treated as natural stop unless reasoningStop updated StoplessCenter"
    );
    assert!(!serde_json::to_string(resp04.finalized_payload())
        .unwrap()
        .contains("call_stopless_reasoning"));
}

#[test]
fn request_consumes_noop_cli_and_uses_runtime_control_not_stdout() {
    let restored_context = json!({
        "messages": [
            {"role":"user","content":"完成当前目标"},
            {"role":"assistant","content":"自然停下的可见文本"},
            {
                "role":"assistant",
                "tool_calls":[{
                    "id":"call_stopless_reasoning",
                    "type":"function",
                    "function":{"name":"exec_command","arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"}
                }]
            }
        ]
    });
    let lookup = V3HubContinuationLookup::new(Some("ctx-stopless-center"), scope())
        .with_local_context("ctx-stopless-center", scope(), restored_context);
    let outcome = compile_v3_hub_relay_request_hooks()
        .run(
            raw_request(json!({
                "model":"gpt-5.5",
                "messages":[{
                    "role":"tool",
                    "tool_call_id":"call_stopless_reasoning",
                    "content":""
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop()
                .with_stopless_center_state(V3StoplessCenterState::new(
                    1,
                    3,
                    V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
                ))
                .with_stopless_transition_context("req-stopless-req04-state", 12_345),
        )
        .unwrap();
    let payload = outcome.payload();
    let serialized = serde_json::to_string(payload).unwrap();
    let state = outcome
        .stopless_state()
        .expect("Req04 must keep StoplessCenter state active for the provider turn");

    let messages = payload["messages"].as_array().expect("provider messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0], json!({"role":"user","content":"完成当前目标"}));
    assert_eq!(
        messages[1],
        json!({"role":"assistant","content":"自然停下的可见文本"})
    );
    let guidance_system = messages.iter().find(|message| {
        message.get("role").and_then(Value::as_str) == Some("system")
    });
    assert!(
        guidance_system.is_some_and(|message| {
            message
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains("当前轮推进准则"))
        }),
        "activated Req04 must inject provider-facing stopless guidance into a current-turn system message: {serialized}"
    );
    assert!(
        payload.get("instructions").is_none(),
        "chat canonical payload carries stopless guidance in the system message, not instructions: {serialized}"
    );
    let tools = payload["tools"].as_array().unwrap();
    assert_eq!(
        tools
            .iter()
            .filter(|tool| tool.get("name").and_then(Value::as_str) == Some("reasoningStop"))
            .count(),
        1,
        "activated Req04 must inject exactly-one provider-visible reasoningStop tool: {serialized}"
    );
    assert_eq!(
        payload["tool_choice"], json!("required"),
        "activated Req04 must promote tool_choice to required: {serialized}"
    );
    assert_eq!(state.phase(), V3StoplessCenterPhase::ProviderTurnInFlight);
    assert_eq!(state.consecutive_stop_count(), 1);
    assert_eq!(state.last_request_id(), Some("req-stopless-req04-state"));
    assert!(state.schema_guidance_active());
    assert_eq!(
        state.schema_guidance_request_id(),
        Some("req-stopless-req04-state")
    );
    assert_eq!(state.schema_guidance_contract(), Some("stop_schema"));
    assert!(state.schema_guidance_active_for(Some("req-stopless-req04-state")));
    assert_eq!(state.updated_at(), 12_345);
    assert_eq!(
        state.last_transition_reason(),
        Some("req04_stopless_guidance_prepared")
    );
    assert!(state.need_continue());
    assert_eq!(
        state.next_request_policy(),
        V3StoplessCenterNextRequestPolicy::ContinueDefault
    );
    let events = outcome.hook_events();
    assert!(
        events
            .windows(4)
            .any(|window| window
                == [
                    V3HubRelayRequestHookEvent::Req04LocalContextRestored,
                    V3HubRelayRequestHookEvent::Req04StoplessControlLoaded,
                    V3HubRelayRequestHookEvent::Req04StoplessCliNoopObserved,
                    V3HubRelayRequestHookEvent::Req04StoplessResultParsed,
                ]),
        "Req04 stopless edge order must be restore -> control load -> no-op observed -> parsed: {events:?}"
    );
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "Chunk ID",
        "repeatCount",
        "schemaFeedback",
        "<rcc_stop_schema>",
        "stop schema",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "provider request leaked old stopless CLI/schema payload {forbidden}: {serialized}"
        );
    }
}

#[test]
fn non_completed_stop_with_active_state_preserves_stopless_schema() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(json!({
            "id":"resp_non_completed_stop_markers",
            "object":"response",
            "status":"requires_action",
            "finish_reason":"stop",
            "instructions":"base\n\n当前轮推进准则：继续推进任务。",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"<rcc_stop_schema>{\"stopreason\":1,\"current_goal\":\"x\",\"next_step\":\"y\"}</rcc_stop_schema>可见文本"}]
            }]
        })))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &active_stopless_response_profile(0, "req-non-completed-stop"),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.finalized_payload();
    let serialized = serde_json::to_string(payload).unwrap();
    assert!(
        !serialized.contains("<rcc_stop_schema>"),
        "client projection must consume the Stopless schema: {serialized}"
    );
    assert!(
        !serialized.contains("当前轮推进准则"),
        "non-completed stop must strip guidance echo: {serialized}"
    );
    assert!(
        serialized.contains("可见文本"),
        "visible assistant text must survive non-completed stop stripping: {serialized}"
    );
}

#[test]
fn relay_req04_thinking_mode_does_not_promote_tool_choice() {
    // deepseek-v4-flash 等 openai_chat provider 的 thinking 模式（reasoning_effort
    // 非 none）拒绝 tool_choice=required（400: Thinking mode does not support this
    // tool_choice）。stopless 激活时仍注入 guidance + exactly-one reasoningStop 工具，
    // 但 tool_choice 保持客户端原值（auto），不得提升为 required。
    let hooks = compile_v3_hub_relay_request_hooks();
    let payload = json!({
        "input":[{"role":"user","content":"继续做"}],
        "tools":[{"type":"function","name":"exec","description":"original tool"}],
        "instructions":"base instruction",
        "reasoning":{"effort":"high"}
    });
    let governed = hooks
        .run(
            raw_request(payload.clone()),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop()
                .with_stopless_center_state(V3StoplessCenterState::new(
                    1,
                    3,
                    V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
                ))
                .with_stopless_transition_context("req-inject-thinking-1", 55_000),
        )
        .unwrap();
    let serialized = serde_json::to_string(governed.payload()).unwrap();
    assert!(
        serialized.contains("当前轮推进准则"),
        "thinking mode must still inject stopless guidance: {serialized}"
    );
    let tools = governed.payload()["tools"].as_array().unwrap();
    assert_eq!(
        tools
            .iter()
            .filter(|tool| tool.get("name").and_then(Value::as_str) == Some("reasoningStop"))
            .count(),
        1,
        "thinking mode must still inject exactly-one reasoningStop tool: {serialized}"
    );
    let tool_choice = governed.payload().get("tool_choice");
    assert!(
        !tool_choice.is_some_and(|choice| {
            choice.as_str() == Some("required")
                || choice.get("type").and_then(Value::as_str) == Some("required")
        }),
        "thinking mode must NOT promote tool_choice to required (provider 400): {serialized}"
    );
    assert!(
        governed.stopless_state().is_some(),
        "thinking mode stopless activation must keep StoplessCenter state"
    );
}

#[test]
fn relay_req04_injects_stopless_contract_when_activated() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let payload = json!({
        "input":[{"role":"user","content":"继续做"}],
        "tools":[{"type":"function","name":"exec","description":"original tool"}],
        "instructions":"base instruction"
    });
    let governed = hooks
        .run(
            raw_request(payload.clone()),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::stopless_reasoning_stop()
                .with_stopless_center_state(V3StoplessCenterState::new(
                    1,
                    3,
                    V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
                ))
                .with_stopless_transition_context("req-inject-1", 55_000),
        )
        .unwrap();
    let serialized = serde_json::to_string(governed.payload()).unwrap();
    assert!(
        serialized.contains("当前轮推进准则"),
        "Req04 must inject stopless provider-facing guidance when activated: {serialized}"
    );
    let tools = governed.payload()["tools"].as_array().unwrap();
    let stopless_tool_count = tools
        .iter()
        .filter(|tool| tool.get("name").and_then(Value::as_str) == Some("reasoningStop"))
        .count();
    assert_eq!(
        stopless_tool_count, 1,
        "exactly-one provider-visible reasoningStop tool must be injected: {serialized}"
    );
    assert!(
        tools
            .iter()
            .any(|tool| tool.get("name").and_then(Value::as_str) == Some("exec")),
        "original tools must be preserved: {serialized}"
    );
    let tool_choice = governed.payload().get("tool_choice");
    assert!(
        tool_choice.is_some_and(|choice| {
            choice.as_str() == Some("required")
                || choice.get("type").and_then(Value::as_str) == Some("required")
        }),
        "tool_choice must be promoted to required for the stopless turn: {serialized}"
    );
    for forbidden in [
        "routecodex hook run reasoningStop",
        "--input-json",
        "repeatCount",
        "schemaFeedback",
        "runtime_control",
        "metadata_center",
        "__routecodex_stopless_center",
        "call_stopless_reasoning",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "stopless shell/control artifact leaked {forbidden}: {serialized}"
        );
    }
    assert!(
        governed.stopless_state().is_some(),
        "activated stopless turn must keep StoplessCenter state"
    );
}

struct CaptureJsonTransport {
    captures: Mutex<Vec<Value>>,
    response: Value,
}

#[async_trait]
impl ResponsesTransport for CaptureJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures.lock().unwrap().push(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&self.response).unwrap(),
        ))
    }
}

fn manifest_with_stopless_center(
    enabled: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&format!(
            r#"
version = 3
[features]
stopless_center = {enabled}
[servers.controlled]
bind = "127.0.0.1"
port = 5555
routing_group = "controlled"
endpoints = ["responses"]
[providers.controlled]
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "responses-wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "CONTROLLED_KEY" }}] }}
[providers.controlled.models.responses-wire-model]
wire_name = "responses-wire-model"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning"]
[route_groups.controlled.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "responses-wire-model", key = "controlled", priority = 1 }}]
"#
        ))
        .unwrap(),
    )
    .unwrap()
}

fn manifest_without_stopless_center() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 5555
routing_group = "controlled"
endpoints = ["responses"]
[providers.controlled]
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "responses-wire-model"
auth = { type = "api_key", entries = [{ alias = "controlled", env = "CONTROLLED_KEY" }] }
[providers.controlled.models.responses-wire-model]
wire_name = "responses-wire-model"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning"]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "controlled", model = "responses-wire-model", key = "controlled", priority = 1 }]
"#
        )
        .unwrap(),
    )
    .unwrap()
}

fn valid_stopless_control_scope() -> V3ResponsesRelayStoplessControlScope {
    V3ResponsesRelayStoplessControlScope::new(
        "/v1/responses",
        "session-stopless-default",
        "conversation-stopless-default",
        5555,
        "controlled",
    )
}

#[tokio::test]
async fn natural_stop_interception_sets_stopless_console_activation() {
    // 拦截语义：natural stop（missing summary/schema，active 轮）由 Resp03 续杯
    // 投影 → 控制台 stopless_activation 必须为 true（拦截时打印）；terminal、
    // inactive、guard 等放行路径保持 false（不拦截不打印）。
    let manifest = manifest_with_stopless_center(true);
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let transport = CaptureJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"resp_natural_stop_console",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"natural stop visible text"}]
            }]
        }),
    };
    let output = execute_v3_responses_relay_runtime_with_transport_health_and_stopless_control(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".to_string(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-natural-stop-console".to_string(),
            payload: json!({
                "model":"gpt-5.5",
                "input":[{"role":"user","content":"natural stop interception"}],
                "tools":[{"type":"function","name":"exec","description":"original tool"}]
            }),
        },
        &transport,
        &provider_health,
        &stopless_control,
        valid_stopless_control_scope(),
    )
    .await
    .unwrap();
    let obs = output
        .observability
        .expect("relay runtime must report observability");
    assert!(
        obs.stopless_activation,
        "natural stop interception must set stopless_activation=true (console prints on intercept)"
    );
}

#[tokio::test]
async fn thinking_relay_request_keeps_auto_tool_choice_and_preserves_effort() {
    // 12:02 线上 400 场景回归：deepseek-v4-flash thinking 模式拒绝
    // tool_choice=required。thinking 请求（reasoning.effort=high）在 stopless
    // 激活时必须保留客户端 tool_choice 原值（auto），不得提升为 required，
    // 同时仍注入 exactly-one reasoningStop 并保留 reasoning_effort。
    let manifest = manifest_with_stopless_center(true);
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let transport = CaptureJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"resp_thinking_auto_choice",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"OK"}]
            }]
        }),
    };
    let output = execute_v3_responses_relay_runtime_with_transport_health_and_stopless_control(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".to_string(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-thinking-auto-choice".to_string(),
            payload: json!({
                "model":"deepseek-v4-flash",
                "reasoning":{"effort":"high"},
                "input":[{"role":"user","content":"only reply OK"}],
                "tools":[{"type":"function","name":"exec_command","description":"run"}],
                "tool_choice":"auto"
            }),
        },
        &transport,
        &provider_health,
        &stopless_control,
        valid_stopless_control_scope(),
    )
    .await
    .unwrap();

    let V3ResponsesRelayClientBody::Json(body) = output.client_body else {
        panic!("thinking auto-choice test expects JSON body");
    };
    assert_eq!(body["status"], "completed");
    let provider_body = transport.captures.lock().unwrap().first().unwrap().clone();
    let serialized = serde_json::to_string(&provider_body).unwrap();
    let tool_choice = provider_body.get("tool_choice");
    assert!(
        !tool_choice.is_some_and(|choice| {
            choice.as_str() == Some("required")
                || choice.get("type").and_then(Value::as_str) == Some("required")
        }),
        "thinking mode must keep client tool_choice (provider 400 regression): {serialized}"
    );
    let reasoning_effort = provider_body
        .get("reasoning_effort")
        .or_else(|| provider_body.pointer("/reasoning/effort"));
    assert!(
        reasoning_effort.is_some_and(|effort| effort.as_str() == Some("high")),
        "thinking effort must be preserved in provider wire: {serialized}"
    );
    let stopless_tool_count = provider_body
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|tool| {
            tool.get("name").and_then(Value::as_str) == Some("reasoningStop")
                || tool
                    .pointer("/function/name")
                    .and_then(Value::as_str)
                    == Some("reasoningStop")
        })
        .count();
    assert_eq!(
        stopless_tool_count, 1,
        "thinking mode must still inject exactly-one reasoningStop tool: {serialized}"
    );
}

#[tokio::test]
async fn feature_toggle_false_disables_relay_stopless_injection_and_projection() {
    let manifest = manifest_with_stopless_center(false);
    let transport = CaptureJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"resp_stopless_disabled",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"natural stop should pass when disabled"}]
            }]
        }),
    };
    let output = execute_v3_responses_relay_runtime(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".to_string(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-stopless-disabled".to_string(),
            payload: json!({
                "model":"gpt-5.5",
                "input":[{"role":"user","content":"stopless disabled"}],
                "tools":[{"type":"function","name":"exec","description":"original tool"}]
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    let V3ResponsesRelayClientBody::Json(body) = output.client_body else {
        panic!("disabled stopless test expects JSON body");
    };
    assert_eq!(body["status"], "completed");
    let provider_body = transport.captures.lock().unwrap().first().unwrap().clone();
    let serialized = serde_json::to_string(&provider_body).unwrap();
    for forbidden in [
        "reasoningStop",
        "<rcc_stop_schema>",
        "call_stopless_reasoning",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "feature disabled must not inject relay stopless marker {forbidden}: {serialized}"
        );
    }
}

#[tokio::test]
async fn omitted_stopless_center_compiles_true_and_injects_guidance_and_projects_noop() {
    let manifest = manifest_without_stopless_center();
    assert_eq!(manifest.features.get("stopless_center"), Some(&true));
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let transport = CaptureJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"resp_omitted_stopless",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"omitted feature natural stop should project no-op"}]
            }]
        }),
    };
    let output = execute_v3_responses_relay_runtime_with_transport_health_and_stopless_control(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".to_string(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-omitted-stopless".to_string(),
            payload: json!({
                "model":"gpt-5.5",
                "input":[{"role":"user","content":"omitted stopless center"}],
                "tools":[{"type":"function","name":"exec","description":"original tool"}]
            }),
        },
        &transport,
        &provider_health,
        &stopless_control,
        valid_stopless_control_scope(),
    )
    .await
    .unwrap();

    let V3ResponsesRelayClientBody::Json(body) = output.client_body else {
        panic!("omitted stopless test expects JSON body");
    };
    assert_eq!(
        body["status"], "completed",
        "omitted feature default true must keep stopless control out of client payload: {body}"
    );
    let provider_body = transport.captures.lock().unwrap().first().unwrap().clone();
    let serialized = serde_json::to_string(&provider_body).unwrap();
    let stopless_tool_count = provider_body
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|tool| tool.get("name").and_then(Value::as_str) == Some("reasoningStop"))
        .count();
    assert_eq!(
        stopless_tool_count, 1,
        "omitted feature default true with client session scope must inject exactly-one reasoningStop into provider payload: {provider_body}"
    );
    assert!(
        serialized.contains("当前轮推进准则"),
        "omitted feature default true with client session scope must inject stopless provider-facing guidance: {serialized}"
    );
    assert_eq!(
        provider_body.get("tool_choice"),
        Some(&json!("required")),
        "activated stopless turn must promote tool_choice to required: {provider_body}"
    );
    assert!(!serde_json::to_string(&body)
        .unwrap()
        .contains("call_stopless_reasoning"));
}

#[tokio::test]
async fn omitted_stopless_center_without_control_scope_stays_inactive() {
    let manifest = manifest_without_stopless_center();
    assert_eq!(manifest.features.get("stopless_center"), Some(&true));
    let transport = CaptureJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"resp_omitted_stopless_without_scope",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"missing control scope must pass through"}]
            }]
        }),
    };
    let output = execute_v3_responses_relay_runtime(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".to_string(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-omitted-stopless-without-scope".to_string(),
            payload: json!({
                "model":"gpt-5.5",
                "input":[{"role":"user","content":"no client session scope"}],
                "tools":[{"type":"function","name":"exec","description":"original tool"}]
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    let V3ResponsesRelayClientBody::Json(body) = output.client_body else {
        panic!("missing control scope test expects JSON body");
    };
    assert_eq!(
        body["status"], "completed",
        "compiled default true must not activate StoplessCenter without an explicit client session scope: {body}"
    );
    let client_body = serde_json::to_string(&body).unwrap();
    assert!(client_body.contains("missing control scope must pass through"));
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
    ] {
        assert!(
            !client_body.contains(forbidden),
            "missing control scope must not project stopless artifact {forbidden}: {client_body}"
        );
    }
    let provider_body = transport.captures.lock().unwrap().first().unwrap().clone();
    let provider_request = serde_json::to_string(&provider_body).unwrap();
    for forbidden in ["reasoningStop", "当前轮推进准则"] {
        assert!(
            !provider_request.contains(forbidden),
            "missing control scope must not inject stopless provider guidance/tool {forbidden}: {provider_request}"
        );
    }
}

#[tokio::test]
async fn server_override_precedence_applies_after_compiled_global_default() {
    let mut server_disabled_manifest = manifest_without_stopless_center();
    server_disabled_manifest
        .servers
        .get_mut("controlled")
        .unwrap()
        .features
        .insert("stopless_center".to_string(), false);
    let disabled_transport = CaptureJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"resp_server_stopless_disabled",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{"type":"output_text","text":"server override disabled"}]
        }),
    };
    let disabled_provider_health =
        V3ResponsesRelayProviderHealthHandle::from_manifest(&server_disabled_manifest);
    let disabled_stopless_control = V3ResponsesRelayStoplessControlState::default();
    let disabled_scope = valid_stopless_control_scope();
    let disabled_output =
        execute_v3_responses_relay_runtime_with_transport_health_and_stopless_control(
            &server_disabled_manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: "controlled".to_string(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-server-stopless-disabled".to_string(),
                payload: json!({
                    "model":"gpt-5.5",
                    "input":[{"role":"user","content":"server override false"}]
                }),
            },
            &disabled_transport,
            &disabled_provider_health,
            &disabled_stopless_control,
            disabled_scope.clone(),
        )
        .await
        .unwrap();
    let V3ResponsesRelayClientBody::Json(disabled_body) = disabled_output.client_body else {
        panic!("server-disabled stopless test expects JSON body");
    };
    assert_eq!(disabled_body["status"], "completed");
    assert!(
        !serde_json::to_string(disabled_transport.captures.lock().unwrap().first().unwrap())
            .unwrap()
            .contains("reasoningStop")
    );
    assert!(
        disabled_stopless_control
            .load_for_scope(&disabled_scope)
            .unwrap()
            .is_none(),
        "server override false must prevent StoplessCenter control writes even with valid scope"
    );

    let mut server_enabled_manifest = manifest_with_stopless_center(false);
    server_enabled_manifest
        .servers
        .get_mut("controlled")
        .unwrap()
        .features
        .insert("stopless_center".to_string(), true);
    let enabled_provider_health =
        V3ResponsesRelayProviderHealthHandle::from_manifest(&server_enabled_manifest);
    let enabled_stopless_control = V3ResponsesRelayStoplessControlState::default();
    let enabled_transport = CaptureJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"resp_server_stopless_enabled",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{"type":"output_text","text":"server override enabled"}]
        }),
    };
    let enabled_output =
        execute_v3_responses_relay_runtime_with_transport_health_and_stopless_control(
            &server_enabled_manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: "controlled".to_string(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-server-stopless-enabled".to_string(),
                payload: json!({
                    "model":"gpt-5.5",
                    "input":[{"role":"user","content":"server override true"}]
                }),
            },
            &enabled_transport,
            &enabled_provider_health,
            &enabled_stopless_control,
            valid_stopless_control_scope(),
        )
        .await
        .unwrap();
    let V3ResponsesRelayClientBody::Json(enabled_body) = enabled_output.client_body else {
        panic!("server-enabled stopless test expects JSON body");
    };
    assert_eq!(enabled_body["status"], "completed");
    let enabled_provider_body =
        serde_json::to_string(enabled_transport.captures.lock().unwrap().first().unwrap())
            .unwrap();
    assert!(
        enabled_provider_body.contains("reasoningStop"),
        "server override true with valid scope must inject the stopless reasoningStop tool: {enabled_provider_body}"
    );
}
