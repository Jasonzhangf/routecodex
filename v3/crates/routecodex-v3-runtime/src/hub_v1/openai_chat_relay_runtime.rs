use super::*;
use crate::provider_action_gate::{V3ProviderActionPermit, V3ProviderActionRecoveryTransition};
use crate::provider_failure_runtime_policy::{
    project_v3_client_disconnect, provider_runtime_failure_stage, resolve_v3_relay_target,
    run_v3_relay_provider_failure_policy, v3_relay_provider_policy_now_epoch_ms,
    v3_relay_provider_target_selection_sample, V3ProviderFailureRuntimeHealth,
    V3RelayProviderFailurePolicyContext, V3RelayProviderFailurePolicyState,
    V3RelayProviderFailureRetryPolicy, V3RelayProviderTargetResolutionInput,
};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error05ExecutionAction, V3Error05RecoveryAdmissionWitness,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
    V3ProviderFailureSessionScope, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    build_v3_transport_13_responses_http_request_from_parts, ReqwestResponsesTransport,
    ResponsesTransport, V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderError,
    V3ProviderResponseBody, V3ResponsesProviderTarget, V3Transport13ResponsesHttpRequest,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::pin::Pin;

pub type V3OpenAiChatClientStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Vec<u8>, String>> + Send>>;

pub enum V3OpenAiChatRelayClientBody {
    Json(Value),
    Sse(V3OpenAiChatClientStream),
}

impl V3OpenAiChatRelayClientBody {
    pub fn is_sse(&self) -> bool {
        matches!(self, Self::Sse(_))
    }
}

impl From<String> for V3OpenAiChatRelayRuntimeError {
    fn from(value: String) -> Self {
        Self::Target(value)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3OpenAiChatRelayRuntimeInput {
    pub server_id: String,
    pub failure_session_scope: V3ProviderFailureSessionScope,
    pub request_id: String,
    pub payload: Value,
}

pub struct V3OpenAiChatRelayRuntimeOutput {
    pub status: u16,
    pub client_body: V3OpenAiChatRelayClientBody,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
}

impl std::fmt::Debug for V3OpenAiChatRelayRuntimeOutput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("V3OpenAiChatRelayRuntimeOutput")
            .field("status", &self.status)
            .field(
                "client_body",
                &match self.client_body {
                    V3OpenAiChatRelayClientBody::Json(_) => "json",
                    V3OpenAiChatRelayClientBody::Sse(_) => "sse",
                },
            )
            .field("node_trace", &self.node_trace)
            .field("error_chain", &self.error_chain)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum V3OpenAiChatRelayRuntimeError {
    #[error(transparent)]
    Request(#[from] V3HubRelayRequestError),
    #[error(transparent)]
    Response(#[from] V3HubRelayResponseError),
    #[error(transparent)]
    Codec(#[from] V3OpenAiChatCodecError),
    #[error("V3 Hub static hook registry failed: {0}")]
    StaticRegistry(String),
    #[error("V3 OpenAI Chat target resolution failed: {0}")]
    Target(String),
    #[error("V3 OpenAI Chat provider contract failed: {0}")]
    Provider(#[from] V3ProviderError),
    #[error("V3 OpenAI Chat provider compat failed: {0}")]
    ProviderCompat(#[from] V3ProviderCompatError),
    #[error("V3 OpenAI Chat JSON provider body is malformed: {0}")]
    ProviderJson(#[from] serde_json::Error),
    #[error("V3 OpenAI Chat structured SSE projection failed: {0}")]
    StructuredSse(String),
}

pub async fn execute_v3_openai_chat_relay_runtime_with_default_transport(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
) -> Result<V3OpenAiChatRelayRuntimeOutput, V3OpenAiChatRelayRuntimeError> {
    execute_v3_openai_chat_relay_runtime(manifest, input, &ReqwestResponsesTransport::default())
        .await
}

pub async fn execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
    provider_health: V3ProviderFailureRuntimeHealth,
) -> Result<V3OpenAiChatRelayRuntimeOutput, V3OpenAiChatRelayRuntimeError> {
    execute_v3_openai_chat_relay_runtime_with_provider_health(
        manifest,
        input,
        &ReqwestResponsesTransport::default(),
        provider_health,
    )
    .await
}

pub async fn execute_v3_openai_chat_relay_runtime<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
    transport: &T,
) -> Result<V3OpenAiChatRelayRuntimeOutput, V3OpenAiChatRelayRuntimeError> {
    execute_v3_openai_chat_relay_runtime_with_provider_health(
        manifest,
        input,
        transport,
        V3ProviderFailureRuntimeHealth::from_manifest(manifest),
    )
    .await
}

pub async fn execute_v3_openai_chat_relay_runtime_with_provider_health<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
) -> Result<V3OpenAiChatRelayRuntimeOutput, V3OpenAiChatRelayRuntimeError> {
    execute_v3_openai_chat_relay_runtime_inner(
        manifest,
        input,
        transport,
        provider_health,
        V3RelayProviderFailureRetryPolicy::default(),
    )
    .await
}

async fn execute_v3_openai_chat_relay_runtime_inner<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3RelayProviderFailureRetryPolicy,
) -> Result<V3OpenAiChatRelayRuntimeOutput, V3OpenAiChatRelayRuntimeError> {
    compile_v3_hub_v1_static_registry()
        .map_err(|error| V3OpenAiChatRelayRuntimeError::StaticRegistry(error.to_string()))?;
    let mut trace = Vec::with_capacity(17);
    let transport_intent = if input.payload.get("stream").and_then(Value::as_bool) == Some(true) {
        V3HubTransportIntent::Sse
    } else {
        V3HubTransportIntent::Json
    };
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        input.payload,
        V3HubEntryProtocol::OpenAiChat,
        V3HubInvocationSource::Client,
        transport_intent,
    );
    trace.push("V3HubReqInbound01ClientRaw");
    validate_v3_openai_chat_client_input_payload(&req01.payload.0, V3HubEntryProtocol::OpenAiChat)?;
    let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01);
    trace.push("V3HubReqInbound02Normalized");
    let lookup = V3HubContinuationLookup::new(
        None,
        V3HubContinuationScope::new(
            V3HubEntryProtocol::OpenAiChat,
            &input.server_id,
            server_routing_group(manifest, &input.server_id)?,
            &input.request_id,
        ),
    );
    let request_outcome = compile_v3_hub_relay_request_hooks().run_from_normalized(
        req02,
        &lookup,
        &V3HubServertoolRequestProfile::disabled(),
    )?;
    trace.push("V3HubReqContinuation03Classified");
    trace.push("V3HubReqChatProcess04Governed");
    let req04 = request_outcome.into_governed();
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    trace.push("V3HubReqExecution05Planned");
    let route_facts_body = req05.previous.previous.previous.previous.payload.0.clone();
    let mut failed_candidates = BTreeSet::new();
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut pending_provider_action_recovery = None;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let deterministic_sample = v3_relay_provider_target_selection_sample(&input.request_id);
    let failure_context = V3RelayProviderFailurePolicyContext {
        manifest,
        captured_target_09: None,
        failure_session_scope: input.failure_session_scope.clone(),
        provider_health: &provider_health,
        retry_policy,
        deterministic_sample,
    };
    loop {
        let selected = if let Some(selected) = retry_selected.take() {
            selected
        } else {
            match resolve_v3_relay_target(V3RelayProviderTargetResolutionInput {
                manifest,
                server_id: &input.server_id,
                failure_session_scope: &input.failure_session_scope,
                entry_kind: "openai_chat",
                endpoint_path: "/v1/chat/completions",
                body: &route_facts_body,
                request_local_excluded_candidates: &failed_candidates,
                provider_health: &provider_health,
                now_ms: v3_relay_provider_policy_now_epoch_ms()
                    .map_err(V3OpenAiChatRelayRuntimeError::Target)?,
                deterministic_sample,
            }) {
                Ok(selected) => selected,
                Err(error) => return Err(V3OpenAiChatRelayRuntimeError::Target(error)),
            }
        };
        let selected_target_provider_id = selected.candidate.provider_id.clone();
        let selected_target_auth_alias = selected.candidate.auth_alias.clone();
        let selected_target_model_id = selected.candidate.model_id.clone();
        let selected_target_compatibility_profile =
            selected.candidate.compatibility_profile.clone();
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05.clone(),
            V3HubTargetResolution::Routed,
            selected.candidate.clone(),
        );
        trace.push("V3HubReqTarget06Resolved");
        let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
            req06,
            V3HubProviderWireProtocol::OpenAiChat,
        );
        trace.push("V3HubReqOutbound07ProviderSemantic");
        let target = provider_target(manifest, req07.selected_target())?;
        macro_rules! handle_provider_request_failure {
            ($stage:expr, $kind:expr, $error:expr) => {{
                let terminal_failure = handle_provider_failure(
                    &failure_context,
                    selected,
                    provider_request_failure($stage, $kind, $error),
                    &mut V3RelayProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        same_candidate_retries: &mut same_candidate_retries,
                        trace: &mut trace,
                    },
                    &mut retry_selected,
                    &mut pending_provider_action_recovery,
                )
                .await?;
                if let Some(failure) = terminal_failure {
                    return Ok(provider_failure_output(failure, trace));
                }
                continue;
            }};
        }
        let req_compat = match build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07) {
            Ok(req_compat) => req_compat,
            Err(error) => handle_provider_request_failure!(
                "ProviderReqCompat06ProviderCompat",
                "provider_request_compat_error",
                error
            ),
        };
        trace.push("ProviderReqCompat06ProviderCompat");
        let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
        let req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
        let provider_semantic = req09.into_provider_semantic_payload();
        let wire = match build_v3_provider_12_responses_wire_payload(
            &input.request_id,
            target,
            provider_semantic,
        ) {
            Ok(wire) => wire,
            Err(error) => handle_provider_request_failure!(
                "V3ProviderReqOutbound08WirePayload",
                "provider_request_wire_error",
                error
            ),
        };
        trace.push("V3ProviderReqOutbound08WirePayload");
        let transport_request = match build_v3_openai_chat_transport_09_from_v3_provider_08(wire) {
            Ok(request) => request,
            Err(error) => handle_provider_request_failure!(
                "V3ProviderReqOutbound09TransportRequest",
                "provider_transport_request_error",
                error
            ),
        };
        trace.push("V3ProviderReqOutbound09TransportRequest");
        let mut provider_action_permit: Option<V3ProviderActionPermit> = None;
        if let Some(recovery) = pending_provider_action_recovery.take() {
            match provider_health
                .wait_for_error05_recovery(&recovery, &selected)
                .await
                .map_err(V3OpenAiChatRelayRuntimeError::Target)?
            {
                V3ProviderActionRecoveryTransition::Admitted(mut admission) => {
                    provider_action_permit = admission.take_permit();
                    trace.push("V3ProviderActionGateAdmission");
                }
                V3ProviderActionRecoveryTransition::Superseded(ticket) => {
                    pending_provider_action_recovery = Some(
                        ticket
                            .recovery_witness()
                            .map_err(V3OpenAiChatRelayRuntimeError::Target)?,
                    );
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
                V3ProviderActionRecoveryTransition::ReleasedBySuccess(ticket) => {
                    pending_provider_action_recovery = Some(
                        ticket
                            .recovery_witness()
                            .map_err(V3OpenAiChatRelayRuntimeError::Target)?,
                    );
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
            }
        }
        let provider_raw = match transport.send(transport_request).await {
            Ok(raw) => raw,
            Err(V3ProviderError::HttpStatus { response }) => {
                let failure = provider_http_failure(
                    response.status,
                    &response.body,
                    &selected_target_provider_id,
                );
                drop(provider_action_permit.take());
                if let Some(failure) = handle_provider_failure(
                    &failure_context,
                    selected,
                    failure,
                    &mut V3RelayProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        same_candidate_retries: &mut same_candidate_retries,
                        trace: &mut trace,
                    },
                    &mut retry_selected,
                    &mut pending_provider_action_recovery,
                )
                .await?
                {
                    return Ok(provider_failure_output(failure, trace));
                }
                continue;
            }
            Err(error) => {
                let failure = provider_runtime_failure(error, &selected_target_provider_id);
                drop(provider_action_permit.take());
                if let Some(failure) = handle_provider_failure(
                    &failure_context,
                    selected,
                    failure,
                    &mut V3RelayProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        same_candidate_retries: &mut same_candidate_retries,
                        trace: &mut trace,
                    },
                    &mut retry_selected,
                    &mut pending_provider_action_recovery,
                )
                .await?
                {
                    return Ok(provider_failure_output(failure, trace));
                }
                continue;
            }
        };
        match provider_raw.into_body() {
            V3ProviderResponseBody::Json(bytes) => {
                let provider_value: Value = match serde_json::from_slice(&bytes) {
                    Ok(value) => value,
                    Err(error) => {
                        let failure = provider_runtime_failure(
                            V3ProviderError::ResponseBody {
                                request_id: input.request_id.clone(),
                                provider_id: selected_target_provider_id.clone(),
                                reason: format!("provider JSON response decode failed: {error}"),
                            },
                            &selected_target_provider_id,
                        );
                        drop(provider_action_permit.take());
                        if let Some(failure) = handle_provider_failure(
                            &failure_context,
                            selected,
                            failure,
                            &mut V3RelayProviderFailurePolicyState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                trace: &mut trace,
                            },
                            &mut retry_selected,
                            &mut pending_provider_action_recovery,
                        )
                        .await?
                        {
                            return Ok(provider_failure_output(failure, trace));
                        }
                        continue;
                    }
                };
                let client_response = match project_json_response(
                    provider_value,
                    transport_intent,
                    &mut trace,
                    selected_target_compatibility_profile.as_deref(),
                ) {
                    Ok(client_response) => client_response,
                    Err(error) => {
                        let failure = provider_runtime_failure(
                            V3ProviderError::ResponseBody {
                                request_id: input.request_id.clone(),
                                provider_id: selected_target_provider_id.clone(),
                                reason: format!("provider response governance failed: {error}"),
                            },
                            &selected_target_provider_id,
                        );
                        drop(provider_action_permit.take());
                        if let Some(failure) = handle_provider_failure(
                            &failure_context,
                            selected,
                            failure,
                            &mut V3RelayProviderFailurePolicyState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                trace: &mut trace,
                            },
                            &mut retry_selected,
                            &mut pending_provider_action_recovery,
                        )
                        .await?
                        {
                            return Ok(provider_failure_output(failure, trace));
                        }
                        continue;
                    }
                };
                provider_health
                    .record_provider_success_in_failure_scope(
                        &failure_context.failure_session_scope,
                        &selected_target_provider_id,
                        Some(&selected_target_auth_alias),
                        Some(&selected_target_model_id),
                        v3_relay_provider_policy_now_epoch_ms()
                            .map_err(V3OpenAiChatRelayRuntimeError::Target)?,
                    )
                    .map_err(|error| V3OpenAiChatRelayRuntimeError::Target(error.to_string()))?;
                return Ok(V3OpenAiChatRelayRuntimeOutput {
                    status: 200,
                    client_body: V3OpenAiChatRelayClientBody::Json(client_response),
                    node_trace: trace,
                    error_chain: None,
                });
            }
            V3ProviderResponseBody::Sse(stream) => {
                push_sse_response_chain_trace(&mut trace);
                return Ok(V3OpenAiChatRelayRuntimeOutput {
                    status: 200,
                    client_body: V3OpenAiChatRelayClientBody::Sse(project_sse_stream(
                        stream,
                        selected_target_compatibility_profile,
                        V3OpenAiChatSseProviderOutcome {
                            provider_health: provider_health.clone(),
                            failure_session_scope: failure_context.failure_session_scope.clone(),
                            provider_id: selected_target_provider_id,
                            auth_alias: selected_target_auth_alias,
                            model_id: selected_target_model_id,
                            recorded: false,
                            _provider_action_permit: provider_action_permit.take(),
                        },
                    )),
                    node_trace: trace,
                    error_chain: None,
                });
            }
        }
    }
}

fn build_v3_openai_chat_transport_09_from_v3_provider_08(
    wire: routecodex_v3_provider_responses::V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, V3OpenAiChatRelayRuntimeError> {
    let request_id = wire.request_id().to_string();
    let target = wire.target().clone();
    let stream_intent = wire.stream_intent();
    let body = wire.body().clone();
    let url_text = format!("{}/chat/completions", target.base_url.trim_end_matches('/'));
    build_v3_transport_13_responses_http_request_from_parts(
        request_id,
        target.provider_id,
        url_text,
        target.auth,
        stream_intent,
        body,
    )
    .map_err(|error| V3OpenAiChatRelayRuntimeError::Target(error.to_string()))
}

pub fn project_v3_openai_chat_relay_runtime_failure(
    error: V3OpenAiChatRelayRuntimeError,
) -> V3OpenAiChatRelayRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3HubRuntime",
        "openai_chat_relay_runtime_error",
        error.to_string(),
    );
    error_output(
        source,
        500,
        json!({"error":{"type":"runtime_error","message":error.to_string()}}),
        "none",
        Vec::new(),
    )
}

fn project_json_response(
    provider_value: Value,
    transport_intent: V3HubTransportIntent,
    trace: &mut Vec<&'static str>,
    compatibility_profile: Option<&str>,
) -> Result<Value, V3OpenAiChatRelayRuntimeError> {
    validate_v3_openai_chat_provider_response_payload(
        &provider_value,
        V3HubProviderWireProtocol::OpenAiChat,
        transport_intent,
    )?;
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        provider_value,
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::OpenAiChat,
            V3HubProviderWireProtocol::OpenAiChat,
            V3HubContinuationOwnership::New,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            transport_intent,
        )
        .with_compatibility_profile(compatibility_profile),
    );
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks.normalize(resp01)?;
    trace.push("ProviderRespCompat02ProviderCompat");
    trace.push("V3HubRespInbound02Normalized");
    let resp03 = hooks.govern(resp02, &V3HubRelayResponseHookProfile::empty())?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp04 = hooks.commit(resp03)?;
    trace.push("V3HubRespContinuation04Committed");
    let client = resp04.finalized_payload().clone();
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
    trace.push("V3HubRespOutbound05ClientSemantic");
    let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    trace.push("V3ServerRespOutbound06ClientFrame");
    Ok(client)
}

struct V3OpenAiChatSseState {
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    decoder: routecodex_v3_sse::SseIncrementalDecoder,
    pending: VecDeque<Result<Vec<u8>, String>>,
    terminal: bool,
    seen_done: bool,
    done: bool,
    compatibility_profile: Option<String>,
    provider_outcome: V3OpenAiChatSseProviderOutcome,
}

struct V3OpenAiChatSseProviderOutcome {
    provider_health: V3ProviderFailureRuntimeHealth,
    failure_session_scope: V3ProviderFailureSessionScope,
    provider_id: String,
    auth_alias: String,
    model_id: String,
    recorded: bool,
    _provider_action_permit: Option<V3ProviderActionPermit>,
}

impl V3OpenAiChatSseProviderOutcome {
    async fn record_failure(&mut self, reason: &str) -> Result<(), String> {
        if self.recorded {
            return Ok(());
        }
        drop(self._provider_action_permit.take());
        self.provider_health
            .record_post_commit_provider_stream_failure(
                &self.failure_session_scope,
                &self.provider_id,
                Some(&self.auth_alias),
                Some(&self.model_id),
                "provider_response_protocol",
                reason,
            )?;
        self.recorded = true;
        Ok(())
    }

    fn record_success(&mut self) -> Result<(), String> {
        if self.recorded {
            return Ok(());
        }
        self.provider_health
            .record_provider_success_in_failure_scope(
                &self.failure_session_scope,
                &self.provider_id,
                Some(&self.auth_alias),
                Some(&self.model_id),
                v3_relay_provider_policy_now_epoch_ms()?,
            )?;
        self.recorded = true;
        Ok(())
    }
}

fn project_sse_stream(
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    compatibility_profile: Option<String>,
    provider_outcome: V3OpenAiChatSseProviderOutcome,
) -> V3OpenAiChatClientStream {
    use futures_util::StreamExt;
    let state = V3OpenAiChatSseState {
        provider,
        decoder: routecodex_v3_sse::SseIncrementalDecoder::new(
            routecodex_v3_sse::SseTransportLimits::default(),
        ),
        pending: VecDeque::new(),
        terminal: false,
        seen_done: false,
        done: false,
        compatibility_profile,
        provider_outcome,
    };
    Box::pin(futures_util::stream::unfold(
        state,
        |mut state| async move {
            loop {
                if let Some(item) = state.pending.pop_front() {
                    return Some((item, state));
                }
                if state.done {
                    return None;
                }
                let Some(chunk) = state.provider.next().await else {
                    state.done = true;
                    let decoder = std::mem::replace(
                        &mut state.decoder,
                        routecodex_v3_sse::SseIncrementalDecoder::new(
                            routecodex_v3_sse::SseTransportLimits::default(),
                        ),
                    );
                    if let Err(error) = decoder.finish() {
                        let error = error.to_string();
                        let result = state
                            .provider_outcome
                            .record_failure(&error)
                            .await
                            .map(|()| error)
                            .and_then(Err);
                        return Some((result, state));
                    }
                    if !state.terminal || !state.seen_done {
                        let error =
                            "OpenAI Chat SSE ended without terminal finish_reason or [DONE]"
                                .to_string();
                        let result = state
                            .provider_outcome
                            .record_failure(&error)
                            .await
                            .map(|()| error)
                            .and_then(Err);
                        return Some((result, state));
                    }
                    return match state.provider_outcome.record_success() {
                        Ok(()) => None,
                        Err(error) => Some((Err(error), state)),
                    };
                };
                let result = match chunk {
                    Err(error @ V3ProviderError::ClientDisconnect { .. }) => {
                        state.done = true;
                        return Some((Err(error.to_string()), state));
                    }
                    Err(error) => Err(error.to_string()),
                    Ok(chunk) => {
                        let raw = routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(&chunk);
                        state.decoder.push(raw).map_err(|error| error.to_string())
                    }
                }
                .and_then(|frames| enqueue_sse_client_chunks(&mut state, frames));
                if let Err(error) = result {
                    state.done = true;
                    let result = state
                        .provider_outcome
                        .record_failure(&error)
                        .await
                        .map(|()| error)
                        .and_then(Err);
                    return Some((result, state));
                }
            }
        },
    ))
}

fn enqueue_sse_client_chunks(
    state: &mut V3OpenAiChatSseState,
    frames: Vec<routecodex_v3_sse::SseTransportIn03ValidatedFrameStream>,
) -> Result<(), String> {
    for frame in frames {
        if state.seen_done && !frame.frame().fields().is_empty() {
            return Err("OpenAI Chat SSE emitted a frame after [DONE]".into());
        }
        let mut data = None;
        for field in frame.frame().fields() {
            if let routecodex_v3_sse::SseField::Named { name, value } = field {
                if name == "data" {
                    data = Some(value.clone());
                }
            }
        }
        let Some(data) = data else { continue };
        if data == "[DONE]" {
            if !state.terminal {
                return Err("OpenAI Chat SSE emitted [DONE] before terminal finish_reason".into());
            }
            state.seen_done = true;
            state.pending.push_back(Ok(b"data: [DONE]\n\n".to_vec()));
            continue;
        }
        let payload: Value = serde_json::from_str(&data).map_err(|error| error.to_string())?;
        let client_payload =
            project_sse_event_payload(payload, state.compatibility_profile.as_deref())?;
        state.terminal = openai_chat_sse_payload_has_terminal_finish_reason(&client_payload)?;
        state
            .pending
            .push_back(Ok(format!("data: {client_payload}\n\n").into_bytes()));
    }
    Ok(())
}

fn project_sse_event_payload(
    payload: Value,
    compatibility_profile: Option<&str>,
) -> Result<Value, String> {
    let mut trace = Vec::new();
    project_json_response(
        payload,
        V3HubTransportIntent::Sse,
        &mut trace,
        compatibility_profile,
    )
    .map_err(|error| error.to_string())
}

fn push_sse_response_chain_trace(trace: &mut Vec<&'static str>) {
    trace.extend([
        "V3ProviderRespInbound01Raw",
        "ProviderRespCompat02ProviderCompat",
        "V3HubRespInbound02Normalized",
        "V3HubRespChatProcess03Governed",
        "V3HubRespContinuation04Committed",
        "V3HubRespOutbound05ClientSemantic",
        "V3ServerRespOutbound06ClientFrame",
    ]);
}

fn openai_chat_sse_payload_has_terminal_finish_reason(payload: &Value) -> Result<bool, String> {
    let choices = payload
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| "OpenAI Chat SSE choices are missing".to_string())?;
    let mut terminal = false;
    for choice in choices {
        if choice
            .get("finish_reason")
            .is_some_and(|value| !value.is_null())
        {
            terminal = true;
        }
    }
    Ok(terminal)
}

fn server_routing_group<'a>(
    manifest: &'a V3Config05ManifestPublished,
    server_id: &str,
) -> Result<&'a str, V3OpenAiChatRelayRuntimeError> {
    manifest
        .servers
        .get(server_id)
        .map(|server| server.routing_group.as_str())
        .ok_or_else(|| V3OpenAiChatRelayRuntimeError::Target(format!("server {server_id} missing")))
}

fn provider_target(
    manifest: &V3Config05ManifestPublished,
    selected: &routecodex_v3_target::V3TargetCandidate,
) -> Result<V3ResponsesProviderTarget, V3OpenAiChatRelayRuntimeError> {
    let provider = manifest
        .providers
        .get(&selected.provider_id)
        .ok_or_else(|| {
            V3OpenAiChatRelayRuntimeError::Target("selected provider missing".to_string())
        })?;
    let auth = provider
        .auth
        .entries
        .iter()
        .find(|entry| entry.alias == selected.auth_alias)
        .ok_or_else(|| {
            V3OpenAiChatRelayRuntimeError::Target("selected auth handle missing".to_string())
        })?;
    let secret = match (&auth.env, &auth.token_file, &auth.api_key) {
        (Some(env), None, None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path), None) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        (None, None, Some(value)) => V3ProviderAuthSecretHandle::ApiKey(value.clone()),
        _ => {
            return Err(V3OpenAiChatRelayRuntimeError::Target(
                "selected auth handle is invalid".to_string(),
            ));
        }
    };
    Ok(V3ResponsesProviderTarget {
        provider_id: selected.provider_id.clone(),
        provider_type: selected.provider_type.clone(),
        base_url: selected.base_url.clone(),
        canonical_model_id: selected.model_id.clone(),
        wire_model: selected.wire_model.clone(),
        auth: V3ProviderAuthHandle {
            alias: selected.auth_alias.clone(),
            secret,
        },
        responses_transport: selected.responses_transport,
        websocket_v2_url: selected.websocket_v2_url.clone(),
        provider_request_cleanup: selected.provider_request_cleanup.clone(),
    })
}

struct V3OpenAiChatRelayProviderFailure {
    status: u16,
    client_response: Value,
    source_stage: &'static str,
    terminal_projection: Option<routecodex_v3_error::V3Error06ClientProjected>,
}

async fn handle_provider_failure(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    mut failure: V3OpenAiChatRelayProviderFailure,
    state: &mut V3RelayProviderFailurePolicyState<'_>,
    retry_selected: &mut Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    pending_recovery: &mut Option<V3Error05RecoveryAdmissionWitness>,
) -> Result<Option<V3OpenAiChatRelayProviderFailure>, V3OpenAiChatRelayRuntimeError> {
    if failure.terminal_projection.is_some() {
        return Ok(Some(failure));
    }
    let result = run_v3_relay_provider_failure_policy(
        context,
        selected,
        failure.source_stage,
        failure.status,
        failure
            .client_response
            .pointer("/error/type")
            .and_then(Value::as_str)
            .map(str::to_string),
        provider_failure_message(&failure),
        state,
    )
    .await
    .map_err(V3OpenAiChatRelayRuntimeError::Target)?;
    match result.decision.action {
        V3Error05ExecutionAction::WaitThenReselect { recovery } => {
            *retry_selected = result.retry_selected.map(|selected| *selected);
            if result.event.wait_ms.is_some() {
                *pending_recovery = Some(recovery);
            } else {
                *pending_recovery = None;
            }
            Ok(None)
        }
        V3Error05ExecutionAction::WaitThenRetrySame { recovery } => {
            *retry_selected = result.retry_selected.map(|selected| *selected);
            *pending_recovery = Some(recovery);
            Ok(None)
        }
        V3Error05ExecutionAction::ProjectTerminal => {
            failure.terminal_projection = result.terminal_projection;
            Ok(Some(failure))
        }
        V3Error05ExecutionAction::ClientDisconnected
        | V3Error05ExecutionAction::RejectNonProviderError => {
            Err(V3OpenAiChatRelayRuntimeError::Target(
                "provider failure entered a non-provider Error05 lane".to_string(),
            ))
        }
    }
}

fn provider_http_failure(
    status: u16,
    body: &[u8],
    _provider_id: &str,
) -> V3OpenAiChatRelayProviderFailure {
    let body = serde_json::from_slice::<Value>(body)
        .unwrap_or_else(|_| json!({"error":{"type":"provider_error","message":"provider error"}}));
    V3OpenAiChatRelayProviderFailure {
        status,
        client_response: body,
        source_stage: "V3ProviderReqOutbound09TransportRequest",
        terminal_projection: None,
    }
}

fn provider_request_failure(
    source_stage: &'static str,
    error_type: &'static str,
    error: impl std::fmt::Display,
) -> V3OpenAiChatRelayProviderFailure {
    V3OpenAiChatRelayProviderFailure {
        status: 502,
        client_response: json!({"error":{"type":error_type,"message":error.to_string()}}),
        source_stage,
        terminal_projection: None,
    }
}

fn provider_runtime_failure(
    error: V3ProviderError,
    provider_id: &str,
) -> V3OpenAiChatRelayProviderFailure {
    let terminal_projection =
        matches!(&error, V3ProviderError::ClientDisconnect { .. }).then(|| {
            project_v3_client_disconnect(
                provider_id,
                provider_runtime_failure_stage(&error),
                error.to_string(),
            )
        });
    V3OpenAiChatRelayProviderFailure {
        status: if terminal_projection.is_some() {
            499
        } else {
            502
        },
        client_response: json!({"error":{"type":"provider_error","message":error.to_string()}}),
        source_stage: provider_runtime_failure_stage(&error),
        terminal_projection,
    }
}

fn provider_failure_message(failure: &V3OpenAiChatRelayProviderFailure) -> String {
    failure
        .client_response
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| {
            failure
                .client_response
                .pointer("/error/type")
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("provider returned HTTP {}", failure.status))
}

fn provider_failure_output(
    failure: V3OpenAiChatRelayProviderFailure,
    mut trace: Vec<&'static str>,
) -> V3OpenAiChatRelayRuntimeOutput {
    let projected = failure
        .terminal_projection
        .expect("terminal OpenAI Chat provider failure must carry typed Error06 projection");
    trace.push("V3Error06ClientProjected");
    V3OpenAiChatRelayRuntimeOutput {
        status: projected.status,
        client_body: V3OpenAiChatRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
    }
}

fn error_output(
    source: routecodex_v3_error::V3Error01SourceRaised,
    status: u16,
    client_response: Value,
    provider_id: &str,
    mut trace: Vec<&'static str>,
) -> V3OpenAiChatRelayRuntimeOutput {
    let _ = client_response;
    let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source,
        action_scope: V3ErrorActionScope::ProviderInstance {
            provider_id: provider_id.to_string(),
        },
        candidates_remaining: 0,
        source_status: Some(status),
    });
    trace.extend(V3_ERROR_CHAIN_NODE_IDS);
    V3OpenAiChatRelayRuntimeOutput {
        status: projected.status,
        client_body: V3OpenAiChatRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
    }
}
