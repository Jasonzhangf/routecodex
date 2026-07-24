use super::*;
use crate::provider_failure_runtime_policy::{
    V3ProviderFailureRuntimeHealth, V3RelayProviderFailureDecision,
    V3RelayProviderFailurePolicyContext, V3RelayProviderFailurePolicyState,
    V3RelayProviderFailureRetryPolicy, resolve_v3_relay_target,
    run_v3_relay_provider_failure_policy, v3_relay_provider_policy_now_epoch_ms,
    v3_relay_provider_target_selection_sample,
};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    V3_ERROR_CHAIN_NODE_IDS, V3ErrorActionScope, V3ErrorSourceKind,
    build_v3_error_01_source_raised, build_v3_error_02_classified_from_v3_error_01,
    build_v3_error_03_target_local_action_from_v3_error_02,
    build_v3_error_04_target_exhaustion_decision_from_v3_error_03,
    build_v3_error_05_execution_decision_from_v3_error_04,
    build_v3_error_06_client_projected_from_v3_error_05,
};
use routecodex_v3_provider_responses::{
    ReqwestResponsesTransport, ResponsesTransport, V3ProviderAuthHandle,
    V3ProviderAuthSecretHandle, V3ProviderError, V3ProviderResponseBody, V3ResponsesProviderTarget,
    V3ResponsesStreamIntent, V3Transport13ResponsesHttpRequest,
    build_v3_transport_13_responses_http_request_from_parts,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::pin::Pin;

pub type V3GeminiRelayClientStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Vec<u8>, String>> + Send>>;

pub enum V3GeminiRelayClientBody {
    Json(Value),
    Sse(V3GeminiRelayClientStream),
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3GeminiRelayRuntimeInput {
    pub server_id: String,
    pub request_id: String,
    pub endpoint_path: String,
    pub payload: Value,
}

pub struct V3GeminiRelayRuntimeOutput {
    pub status: u16,
    pub client_body: V3GeminiRelayClientBody,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
}

impl std::fmt::Debug for V3GeminiRelayRuntimeOutput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("V3GeminiRelayRuntimeOutput")
            .field("status", &self.status)
            .field(
                "client_body",
                &match self.client_body {
                    V3GeminiRelayClientBody::Json(_) => "json",
                    V3GeminiRelayClientBody::Sse(_) => "sse",
                },
            )
            .field("node_trace", &self.node_trace)
            .field("error_chain", &self.error_chain)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum V3GeminiRelayRuntimeError {
    #[error(transparent)]
    Request(#[from] V3HubRelayRequestError),
    #[error(transparent)]
    Response(#[from] V3HubRelayResponseError),
    #[error(transparent)]
    Codec(#[from] V3GeminiCodecError),
    #[error("V3 Hub static hook registry failed: {0}")]
    StaticRegistry(String),
    #[error("V3 Gemini target resolution failed: {0}")]
    Target(String),
    #[error("V3 Gemini provider contract failed: {0}")]
    Provider(#[from] V3ProviderError),
    #[error("V3 Gemini provider compat failed: {0}")]
    ProviderCompat(#[from] V3ProviderCompatError),
    #[error("V3 Gemini JSON provider body is malformed: {0}")]
    ProviderJson(#[from] serde_json::Error),
    #[error("V3 Gemini structured SSE projection failed: {0}")]
    StructuredSse(String),
    #[error("V3 Gemini endpoint path is malformed: {0}")]
    EndpointPath(String),
}

pub async fn execute_v3_gemini_relay_runtime_with_default_transport(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
) -> Result<V3GeminiRelayRuntimeOutput, V3GeminiRelayRuntimeError> {
    execute_v3_gemini_relay_runtime(manifest, input, &ReqwestResponsesTransport::default()).await
}

pub async fn execute_v3_gemini_relay_runtime_with_default_transport_provider_health(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
    provider_health: V3ProviderFailureRuntimeHealth,
) -> Result<V3GeminiRelayRuntimeOutput, V3GeminiRelayRuntimeError> {
    execute_v3_gemini_relay_runtime_with_provider_health(
        manifest,
        input,
        &ReqwestResponsesTransport::default(),
        provider_health,
    )
    .await
}

pub async fn execute_v3_gemini_relay_runtime<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
    transport: &T,
) -> Result<V3GeminiRelayRuntimeOutput, V3GeminiRelayRuntimeError> {
    execute_v3_gemini_relay_runtime_with_provider_health(
        manifest,
        input,
        transport,
        V3ProviderFailureRuntimeHealth::from_manifest(manifest),
    )
    .await
}

pub async fn execute_v3_gemini_relay_runtime_with_provider_health<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
) -> Result<V3GeminiRelayRuntimeOutput, V3GeminiRelayRuntimeError> {
    execute_v3_gemini_relay_runtime_inner(
        manifest,
        input,
        transport,
        provider_health,
        V3RelayProviderFailureRetryPolicy::default(),
    )
    .await
}

async fn execute_v3_gemini_relay_runtime_inner<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3RelayProviderFailureRetryPolicy,
) -> Result<V3GeminiRelayRuntimeOutput, V3GeminiRelayRuntimeError> {
    compile_v3_hub_v1_static_registry()
        .map_err(|error| V3GeminiRelayRuntimeError::StaticRegistry(error.to_string()))?;
    let mut trace = Vec::with_capacity(17);
    let transport_intent = if input.payload.get("stream").and_then(Value::as_bool) == Some(true) {
        V3HubTransportIntent::Sse
    } else {
        V3HubTransportIntent::Json
    };
    let requested_model = gemini_model_from_endpoint_path(&input.endpoint_path)?;
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        input.payload,
        V3HubEntryProtocol::Gemini,
        V3HubInvocationSource::Client,
        transport_intent,
    );
    trace.push("V3HubReqInbound01ClientRaw");
    validate_v3_gemini_client_input_payload(&req01.payload.0, V3HubEntryProtocol::Gemini)?;
    let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01);
    trace.push("V3HubReqInbound02Normalized");
    let lookup = V3HubContinuationLookup::new(
        None,
        V3HubContinuationScope::new(
            V3HubEntryProtocol::Gemini,
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
    let routing_payload = gemini_routing_payload(
        &req05.previous.previous.previous.previous.payload.0,
        &requested_model,
    );
    let mut failed_candidates = BTreeSet::new();
    let mut pending_provider_failure: Option<V3GeminiRelayProviderFailure> = None;
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let deterministic_sample = v3_relay_provider_target_selection_sample(&input.request_id);
    let failure_context = V3RelayProviderFailurePolicyContext {
        manifest,
        server_id: &input.server_id,
        entry_kind: "gemini",
        endpoint_path: &input.endpoint_path,
        route_facts_body: &routing_payload,
        provider_health: &provider_health,
        retry_policy,
        deterministic_sample,
    };
    loop {
        let selected = if let Some(selected) = retry_selected.take() {
            selected
        } else {
            match resolve_v3_relay_target(
                manifest,
                &input.server_id,
                "gemini",
                &input.endpoint_path,
                &routing_payload,
                &failed_candidates,
                &provider_health,
                v3_relay_provider_policy_now_epoch_ms()
                    .map_err(V3GeminiRelayRuntimeError::Target)?,
                deterministic_sample,
            ) {
                Ok(selected) => selected,
                Err(error) => {
                    if let Some(failure) = pending_provider_failure.take() {
                        return Ok(provider_failure_output(failure, trace));
                    }
                    return Err(V3GeminiRelayRuntimeError::Target(error));
                }
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
            V3HubProviderWireProtocol::Gemini,
        );
        trace.push("V3HubReqOutbound07ProviderSemantic");
        let target = provider_target(manifest, req07.selected_target())?;
        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)?;
        trace.push("ProviderReqCompat06ProviderCompat");
        let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
        let req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
        let provider_semantic = req09.into_provider_semantic_payload();
        trace.push("V3ProviderReqOutbound08WirePayload");
        let transport_request = build_v3_gemini_transport_09(
            &input.request_id,
            target,
            transport_intent,
            provider_semantic,
        )?;
        trace.push("V3ProviderReqOutbound09TransportRequest");
        let provider_raw = match transport.send(transport_request).await {
            Ok(raw) => raw,
            Err(V3ProviderError::HttpStatus { response }) => {
                let failure = provider_http_failure(
                    response.status,
                    &response.body,
                    &selected_target_provider_id,
                );
                if let Some(failure) = handle_provider_failure(
                    &failure_context,
                    selected,
                    failure,
                    &mut failed_candidates,
                    &mut same_candidate_retries,
                    &mut retry_selected,
                    &mut pending_provider_failure,
                    &mut trace,
                )
                .await?
                {
                    return Ok(provider_failure_output(failure, trace));
                }
                continue;
            }
            Err(error) => {
                let failure = provider_runtime_failure(error, &selected_target_provider_id);
                if let Some(failure) = handle_provider_failure(
                    &failure_context,
                    selected,
                    failure,
                    &mut failed_candidates,
                    &mut same_candidate_retries,
                    &mut retry_selected,
                    &mut pending_provider_failure,
                    &mut trace,
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
                        if let Some(failure) = handle_provider_failure(
                            &failure_context,
                            selected,
                            failure,
                            &mut failed_candidates,
                            &mut same_candidate_retries,
                            &mut retry_selected,
                            &mut pending_provider_failure,
                            &mut trace,
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
                        if let Some(failure) = handle_provider_failure(
                            &failure_context,
                            selected,
                            failure,
                            &mut failed_candidates,
                            &mut same_candidate_retries,
                            &mut retry_selected,
                            &mut pending_provider_failure,
                            &mut trace,
                        )
                        .await?
                        {
                            return Ok(provider_failure_output(failure, trace));
                        }
                        continue;
                    }
                };
                provider_health
                    .record_provider_success(
                        &selected_target_provider_id,
                        Some(&selected_target_auth_alias),
                        Some(&selected_target_model_id),
                        v3_relay_provider_policy_now_epoch_ms()
                            .map_err(V3GeminiRelayRuntimeError::Target)?,
                    )
                    .map_err(|error| V3GeminiRelayRuntimeError::Target(error.to_string()))?;
                return Ok(V3GeminiRelayRuntimeOutput {
                    status: 200,
                    client_body: V3GeminiRelayClientBody::Json(client_response),
                    node_trace: trace,
                    error_chain: None,
                });
            }
            V3ProviderResponseBody::Sse(stream) => {
                push_sse_response_chain_trace(&mut trace);
                return Ok(V3GeminiRelayRuntimeOutput {
                    status: 200,
                    client_body: V3GeminiRelayClientBody::Sse(project_sse_stream(
                        stream,
                        selected_target_compatibility_profile,
                    )),
                    node_trace: trace,
                    error_chain: None,
                });
            }
        }
    }
}

fn build_v3_gemini_transport_09(
    request_id: &str,
    target: V3ResponsesProviderTarget,
    transport_intent: V3HubTransportIntent,
    body: Value,
) -> Result<V3Transport13ResponsesHttpRequest, V3GeminiRelayRuntimeError> {
    let stream_intent = match transport_intent {
        V3HubTransportIntent::Json => V3ResponsesStreamIntent::Json,
        V3HubTransportIntent::Sse => V3ResponsesStreamIntent::Sse,
    };
    let url_text = format!(
        "{}/models/{}/generateContent",
        target.base_url.trim_end_matches('/'),
        target.wire_model
    );
    build_v3_transport_13_responses_http_request_from_parts(
        request_id,
        target.provider_id,
        url_text,
        target.auth,
        stream_intent,
        body,
    )
    .map_err(|error| V3GeminiRelayRuntimeError::Target(error.to_string()))
}

pub fn project_v3_gemini_relay_runtime_failure(
    error: V3GeminiRelayRuntimeError,
) -> V3GeminiRelayRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3HubRuntime",
        "gemini_relay_runtime_error",
        error.to_string(),
    );
    error_output(
        source,
        500,
        json!({"error":{"code":"runtime_error","message":error.to_string()}}),
        "none",
        Vec::new(),
    )
}

fn project_json_response(
    provider_value: Value,
    transport_intent: V3HubTransportIntent,
    trace: &mut Vec<&'static str>,
    compatibility_profile: Option<&str>,
) -> Result<Value, V3GeminiRelayRuntimeError> {
    validate_v3_gemini_provider_response_payload(
        &provider_value,
        V3HubProviderWireProtocol::Gemini,
    )?;
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        provider_value,
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::Gemini,
            V3HubProviderWireProtocol::Gemini,
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

struct V3GeminiSseState {
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    decoder: routecodex_v3_sse::SseIncrementalDecoder,
    pending: VecDeque<Result<Vec<u8>, String>>,
    terminal: bool,
    done: bool,
    compatibility_profile: Option<String>,
}

fn project_sse_stream(
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    compatibility_profile: Option<String>,
) -> V3GeminiRelayClientStream {
    use futures_util::StreamExt;
    let state = V3GeminiSseState {
        provider,
        decoder: routecodex_v3_sse::SseIncrementalDecoder::new(
            routecodex_v3_sse::SseTransportLimits::default(),
        ),
        pending: VecDeque::new(),
        terminal: false,
        done: false,
        compatibility_profile,
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
                    if !state.terminal {
                        return Some((
                            Err("Gemini SSE ended without terminal finishReason".to_string()),
                            state,
                        ));
                    }
                    return None;
                };
                let result = chunk
                    .map_err(|error| error.to_string())
                    .and_then(|chunk| {
                        let raw = routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(&chunk);
                        state.decoder.push(raw).map_err(|error| error.to_string())
                    })
                    .and_then(|frames| enqueue_sse_client_chunks(&mut state, frames));
                if let Err(error) = result {
                    state.done = true;
                    return Some((Err(error), state));
                }
            }
        },
    ))
}

fn enqueue_sse_client_chunks(
    state: &mut V3GeminiSseState,
    frames: Vec<routecodex_v3_sse::SseTransportIn03ValidatedFrameStream>,
) -> Result<(), String> {
    for frame in frames {
        let mut data = None;
        for field in frame.frame().fields() {
            if let routecodex_v3_sse::SseField::Named { name, value } = field {
                if name == "data" {
                    data = Some(value.clone());
                }
            }
        }
        let Some(data) = data else { continue };
        if state.terminal {
            return Err("Gemini SSE emitted a frame after terminal finishReason".into());
        }
        let payload: Value = serde_json::from_str(&data).map_err(|error| error.to_string())?;
        let client_payload =
            project_sse_event_payload(payload, state.compatibility_profile.as_deref())?;
        state.terminal = gemini_payload_has_terminal_finish_reason(&client_payload);
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

fn gemini_payload_has_terminal_finish_reason(payload: &Value) -> bool {
    payload
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|candidate| {
            candidate
                .get("finishReason")
                .is_some_and(|value| !value.is_null())
        })
}

fn server_routing_group<'a>(
    manifest: &'a V3Config05ManifestPublished,
    server_id: &str,
) -> Result<&'a str, V3GeminiRelayRuntimeError> {
    manifest
        .servers
        .get(server_id)
        .map(|server| server.routing_group.as_str())
        .ok_or_else(|| V3GeminiRelayRuntimeError::Target(format!("server {server_id} missing")))
}

fn provider_target(
    manifest: &V3Config05ManifestPublished,
    selected: &routecodex_v3_target::V3TargetCandidate,
) -> Result<V3ResponsesProviderTarget, V3GeminiRelayRuntimeError> {
    if selected.provider_type != "gemini" {
        return Err(V3GeminiRelayRuntimeError::Target(format!(
            "no compatible Gemini provider target: selected provider {} has protocol {}",
            selected.provider_id, selected.provider_type
        )));
    }
    let provider = manifest
        .providers
        .get(&selected.provider_id)
        .ok_or_else(|| {
            V3GeminiRelayRuntimeError::Target("selected provider missing".to_string())
        })?;
    let auth = provider
        .auth
        .entries
        .iter()
        .find(|entry| entry.alias == selected.auth_alias)
        .ok_or_else(|| {
            V3GeminiRelayRuntimeError::Target("selected auth handle missing".to_string())
        })?;
    let secret = match (&auth.env, &auth.token_file) {
        (Some(env), None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path)) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        _ => {
            return Err(V3GeminiRelayRuntimeError::Target(
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
    })
}

struct V3GeminiRelayProviderFailure {
    status: u16,
    client_response: Value,
    provider_id: String,
}

async fn handle_provider_failure(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    failure: V3GeminiRelayProviderFailure,
    failed_candidates: &mut BTreeSet<String>,
    same_candidate_retries: &mut BTreeMap<String, usize>,
    retry_selected: &mut Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    pending_provider_failure: &mut Option<V3GeminiRelayProviderFailure>,
    trace: &mut Vec<&'static str>,
) -> Result<Option<V3GeminiRelayProviderFailure>, V3GeminiRelayRuntimeError> {
    let result = run_v3_relay_provider_failure_policy(
        context,
        selected,
        failure.status,
        failure_error_type(&failure),
        provider_failure_message(&failure),
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates,
            same_candidate_retries,
            trace,
        },
    )
    .await
    .map_err(V3GeminiRelayRuntimeError::Target)?;
    match result.decision {
        V3RelayProviderFailureDecision::Reselect => {
            *pending_provider_failure = Some(failure);
            Ok(None)
        }
        V3RelayProviderFailureDecision::RetrySame(selected) => {
            *retry_selected = Some(selected);
            Ok(None)
        }
        V3RelayProviderFailureDecision::ProjectTerminal => Ok(Some(failure)),
    }
}

fn provider_http_failure(
    status: u16,
    body: &[u8],
    provider_id: &str,
) -> V3GeminiRelayProviderFailure {
    let body = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(error) => json!({
            "error": {
                "code": "provider_error_body_malformed",
                "message": format!("provider returned HTTP {status} with malformed JSON error body: {error}")
            }
        }),
    };
    V3GeminiRelayProviderFailure {
        status,
        client_response: body,
        provider_id: provider_id.to_string(),
    }
}

fn provider_runtime_failure(
    error: V3ProviderError,
    provider_id: &str,
) -> V3GeminiRelayProviderFailure {
    V3GeminiRelayProviderFailure {
        status: 502,
        client_response: json!({"error":{"code":"provider_error","message":error.to_string()}}),
        provider_id: provider_id.to_string(),
    }
}

fn failure_error_type(failure: &V3GeminiRelayProviderFailure) -> Option<String> {
    failure
        .client_response
        .pointer("/error/status")
        .and_then(Value::as_str)
        .or_else(|| {
            failure
                .client_response
                .pointer("/error/code")
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn provider_failure_message(failure: &V3GeminiRelayProviderFailure) -> String {
    failure
        .client_response
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| {
            failure
                .client_response
                .pointer("/error/status")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            failure
                .client_response
                .pointer("/error/code")
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("provider returned HTTP {}", failure.status))
}

fn provider_failure_output(
    failure: V3GeminiRelayProviderFailure,
    trace: Vec<&'static str>,
) -> V3GeminiRelayRuntimeOutput {
    let message = provider_failure_message(&failure);
    let code = failure
        .client_response
        .pointer("/error/code")
        .and_then(Value::as_str)
        .or_else(|| {
            failure
                .client_response
                .pointer("/error/status")
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if failure.status == 502 {
                "provider_transport_error".to_string()
            } else {
                format!("provider_http_{}", failure.status)
            }
        });
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        code,
        message,
    );
    error_output(
        source,
        failure.status,
        failure.client_response,
        &failure.provider_id,
        trace,
    )
}

fn error_output(
    source: routecodex_v3_error::V3Error01SourceRaised,
    status: u16,
    client_response: Value,
    provider_id: &str,
    mut trace: Vec<&'static str>,
) -> V3GeminiRelayRuntimeOutput {
    let _ = client_response;
    let classified = build_v3_error_02_classified_from_v3_error_01(source);
    let local = build_v3_error_03_target_local_action_from_v3_error_02(
        classified,
        V3ErrorActionScope::ProviderInstance {
            provider_id: provider_id.to_string(),
        },
        0,
    );
    let exhausted = build_v3_error_04_target_exhaustion_decision_from_v3_error_03(local, 0);
    let decision = build_v3_error_05_execution_decision_from_v3_error_04(exhausted);
    let projected = build_v3_error_06_client_projected_from_v3_error_05(decision);
    trace.extend(V3_ERROR_CHAIN_NODE_IDS);
    let client_status = if status >= 400 {
        status
    } else {
        projected.status
    };
    V3GeminiRelayRuntimeOutput {
        status: client_status,
        client_body: V3GeminiRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
    }
}

fn gemini_model_from_endpoint_path(
    endpoint_path: &str,
) -> Result<String, V3GeminiRelayRuntimeError> {
    let model = endpoint_path
        .strip_prefix("/v1beta/models/")
        .and_then(|value| value.strip_suffix("/generateContent"))
        .filter(|value| !value.is_empty() && !value.contains('/'))
        .ok_or_else(|| V3GeminiRelayRuntimeError::EndpointPath(endpoint_path.to_string()))?;
    Ok(model.to_string())
}

fn gemini_routing_payload(body: &Value, requested_model: &str) -> Value {
    let mut routing_body = body.clone();
    if let Some(object) = routing_body.as_object_mut() {
        object.insert(
            "model".to_string(),
            Value::String(requested_model.to_string()),
        );
    }
    routing_body
}
