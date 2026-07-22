use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, build_v3_provider_resp_inbound_01_raw,
    compile_v3_hub_relay_request_hooks, compile_v3_hub_relay_response_hooks,
    execute_v3_responses_relay_runtime, V3HubContinuationLookup, V3HubContinuationOwnership,
    V3HubContinuationScope, V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource,
    V3HubProviderWireProtocol, V3HubRelayRequestHookEvent, V3HubRelayResponseHookProfile,
    V3HubServertoolRequestProfile, V3HubTransportIntent, V3ResponsesRelayClientBody,
    V3ResponsesRelayRuntimeInput, V3StoplessCenterNextRequestPolicy, V3StoplessCenterPhase,
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

fn stopless_call(payload: &Value) -> &Value {
    payload
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|item| item.get("call_id").and_then(Value::as_str) == Some("call_stopless_reasoning"))
        .expect("stopless no-op call")
}

fn stopless_cmd(payload: &Value) -> String {
    let arguments = stopless_call(payload)
        .get("arguments")
        .and_then(Value::as_str)
        .expect("stopless call arguments");
    serde_json::from_str::<Value>(arguments)
        .expect("stopless arguments JSON")
        .get("cmd")
        .and_then(Value::as_str)
        .expect("stopless cmd")
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

fn continuation_prompt_for_state(state: V3StoplessCenterState) -> String {
    let restored_context = json!({
        "input": [
            {"role":"user","content":"完成当前目标"},
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"上一轮可见文本"}]},
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
    });
    let lookup = V3HubContinuationLookup::new(Some("ctx-stopless-policy"), scope())
        .with_local_context("ctx-stopless-policy", scope(), restored_context);
    let outcome = compile_v3_hub_relay_request_hooks()
        .run(
            raw_request(json!({
                "model":"gpt-5.5",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"ignored stdout"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop()
                .with_stopless_center_state(state)
                .with_stopless_transition_context("req-stopless-policy", 55_555),
        )
        .unwrap();
    outcome.payload()["input"]
        .as_array()
        .expect("provider input")
        .last()
        .and_then(|item| item.get("content"))
        .and_then(Value::as_str)
        .expect("provider continuation prompt")
        .to_string()
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

    let observed = first.clone().cli_noop_observed(Some("req-2"), Some(20));
    assert_eq!(observed.phase(), V3StoplessCenterPhase::CliNoopObserved);
    assert_eq!(observed.last_request_id(), Some("req-2"));
    assert_eq!(observed.updated_at(), 20);
    assert_eq!(
        observed.last_transition_reason(),
        Some("req04_stopless_noop_observed")
    );

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
fn request_guidance_changes_by_state_without_exposing_internal_status() {
    let default_prompt = continuation_prompt_for_state(V3StoplessCenterState::new(
        1,
        3,
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
    ));
    let stronger_prompt = continuation_prompt_for_state(V3StoplessCenterState::new(
        2,
        3,
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
    ));
    let evidence_prompt = continuation_prompt_for_state(V3StoplessCenterState::new(
        1,
        3,
        V3StoplessCenterSteering::ReasoningStopNeedsEvidence,
    ));
    let blocked_prompt = continuation_prompt_for_state(V3StoplessCenterState::new(
        1,
        3,
        V3StoplessCenterSteering::Blocked,
    ));

    assert_full_stopless_continuation_prompt(&default_prompt);
    assert_full_stopless_continuation_prompt(&stronger_prompt);
    assert_full_stopless_continuation_prompt(&evidence_prompt);
    assert!(
        stronger_prompt.contains("最小可验证工具动作"),
        "second consecutive stop policy must strengthen task-progress guidance: {stronger_prompt}"
    );
    assert!(
        evidence_prompt.contains("证据不足"),
        "needs-evidence policy must ask for completion/blocked evidence without exposing internals: {evidence_prompt}"
    );
    assert!(
        blocked_prompt.contains("等待下一条真实用户输入"),
        "blocked/wait-user policy must avoid another continuation loop: {blocked_prompt}"
    );
    assert_ne!(default_prompt, stronger_prompt);
    assert_ne!(default_prompt, evidence_prompt);
    assert_ne!(stronger_prompt, evidence_prompt);
    for prompt in [
        default_prompt.as_str(),
        stronger_prompt.as_str(),
        evidence_prompt.as_str(),
        blocked_prompt.as_str(),
    ] {
        for forbidden in [
            "no-op",
            "CLI",
            "client tool round",
            "routecodex hook run reasoningStop",
            "finish_reason=stop",
            "连续 stop 次数",
            "续轮上限",
            "guard",
            "budget",
            "这是连续第",
            "最多",
        ] {
            assert!(
                !prompt.contains(forbidden),
                "state-specific provider prompt leaked internal status {forbidden}: {prompt}"
            );
        }
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
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.finalized_payload();
    let state = resp04
        .stopless_center_state()
        .expect("natural stop must update StoplessCenter");

    assert_eq!(payload["status"], "requires_action");
    assert_eq!(stopless_cmd(payload), "routecodex hook run reasoningStop");
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
    assert_eq!(state.last_request_id(), None);
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
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();

    assert_eq!(resp04.finalized_payload()["status"], "requires_action");
    assert_eq!(
        stopless_cmd(resp04.finalized_payload()),
        "routecodex hook run reasoningStop",
        "Anthropic end_turn is a natural-stop finish reason in stopless relay"
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
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();

    assert_eq!(
        resp04.finalized_payload()["status"],
        "requires_action",
        "assistant text/fence must be treated as natural stop unless reasoningStop updated StoplessCenter"
    );
    assert_eq!(
        stopless_cmd(resp04.finalized_payload()),
        "routecodex hook run reasoningStop"
    );
}

#[test]
fn request_consumes_noop_cli_and_uses_runtime_control_not_stdout() {
    let restored_context = json!({
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
    });
    let lookup = V3HubContinuationLookup::new(Some("ctx-stopless-center"), scope())
        .with_local_context("ctx-stopless-center", scope(), restored_context);
    let outcome = compile_v3_hub_relay_request_hooks()
        .run(
            raw_request(json!({
                "model":"gpt-5.5",
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
                .with_stopless_transition_context("req-stopless-req04-state", 12_345),
        )
        .unwrap();
    let payload = outcome.payload();
    let serialized = serde_json::to_string(payload).unwrap();
    let state = outcome
        .stopless_state()
        .expect("Req04 must keep StoplessCenter state active for the provider turn");

    let input = payload["input"].as_array().expect("provider input");
    assert_eq!(input.len(), 2);
    assert_eq!(input[0], json!({"role":"user","content":"完成当前目标"}));
    assert_eq!(input[1].get("role").and_then(Value::as_str), Some("user"));
    assert_full_stopless_continuation_prompt(
        input[1]
            .get("content")
            .and_then(Value::as_str)
            .expect("stopless continuation prompt"),
    );
    assert!(
        payload["instructions"]
            .as_str()
            .unwrap_or_default()
            .contains("当前轮推进准则"),
        "StoplessCenter steering must be a full provider-facing transparent guideline in instructions: {serialized}"
    );
    assert_eq!(state.phase(), V3StoplessCenterPhase::ProviderTurnInFlight);
    assert_eq!(state.consecutive_stop_count(), 1);
    assert_eq!(state.last_request_id(), Some("req-stopless-req04-state"));
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
            .windows(7)
            .any(|window| window
                == [
                    V3HubRelayRequestHookEvent::Req04LocalContextRestored,
                    V3HubRelayRequestHookEvent::Req04StoplessControlLoaded,
                    V3HubRelayRequestHookEvent::Req04StoplessCliNoopObserved,
                    V3HubRelayRequestHookEvent::Req04StoplessResultParsed,
                    V3HubRelayRequestHookEvent::Req04StoplessTextRewritten,
                    V3HubRelayRequestHookEvent::Req04StoplessGuidancePrepared,
                    V3HubRelayRequestHookEvent::Req04StoplessToolInjected,
                ]),
        "Req04 stopless edge order must be restore -> control load -> no-op observed -> strip/rewrite -> guidance prepared -> tool inject: {events:?}"
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
