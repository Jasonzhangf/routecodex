use super::*;
use crate::provider_failure_runtime_policy::{
    resolve_v3_relay_target, run_v3_relay_provider_failure_policy,
    v3_relay_provider_policy_now_epoch_ms, v3_relay_provider_target_selection_sample,
    V3ProviderFailureRuntimeHealth, V3RelayProviderFailureDecision,
    V3RelayProviderFailurePolicyContext, V3RelayProviderFailurePolicyState,
    V3RelayProviderFailureRetryPolicy,
};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3ErrorActionScope, V3ErrorHandlingCenter,
    V3ErrorHandlingCenterInput, V3ErrorSourceKind, V3_ERROR_CHAIN_NODE_IDS,
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

#[derive(Debug, Clone, PartialEq)]
pub struct V3OpenAiChatRelayRuntimeInput {
    pub server_id: String,
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
    let mut pending_provider_failure: Option<V3OpenAiChatRelayProviderFailure> = None;
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let deterministic_sample = v3_relay_provider_target_selection_sample(&input.request_id);
    let failure_context = V3RelayProviderFailurePolicyContext {
        manifest,
        server_id: &input.server_id,
        entry_kind: "openai_chat",
        endpoint_path: "/v1/chat/completions",
        route_facts_body: &route_facts_body,
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
                "openai_chat",
                "/v1/chat/completions",
                &route_facts_body,
                &failed_candidates,
                &provider_health,
                v3_relay_provider_policy_now_epoch_ms()
                    .map_err(V3OpenAiChatRelayRuntimeError::Target)?,
                deterministic_sample,
            ) {
                Ok(selected) => selected,
                Err(error) => {
                    if let Some(failure) = pending_provider_failure.take() {
                        return Ok(provider_failure_output(failure, trace));
                    }
                    return Err(V3OpenAiChatRelayRuntimeError::Target(error));
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
            V3HubProviderWireProtocol::OpenAiChat,
        );
        trace.push("V3HubReqOutbound07ProviderSemantic");
        let target = provider_target(manifest, req07.selected_target())?;
        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)?;
        trace.push("ProviderReqCompat06ProviderCompat");
        let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
        let req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
        let provider_semantic = req09.into_provider_semantic_payload();
        let wire = build_v3_provider_12_responses_wire_payload(
            &input.request_id,
            target,
            provider_semantic,
        )?;
        trace.push("V3ProviderReqOutbound08WirePayload");
        let transport_request = build_v3_openai_chat_transport_09_from_v3_provider_08(wire)?;
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
}

fn project_sse_stream(
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    compatibility_profile: Option<String>,
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
                if state.seen_done {
                    return None;
                }
                let Some(chunk) = state.provider.next().await else {
                    state.done = true;
                    if !state.terminal || !state.seen_done {
                        return Some((
                            Err(
                                "OpenAI Chat SSE ended without terminal finish_reason or [DONE]"
                                    .to_string(),
                            ),
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
    state: &mut V3OpenAiChatSseState,
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
        if state.seen_done {
            return Err("OpenAI Chat SSE emitted a frame after [DONE]".into());
        }
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
    let secret = match (&auth.env, &auth.token_file) {
        (Some(env), None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path)) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
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
    })
}

struct V3OpenAiChatRelayProviderFailure {
    status: u16,
    client_response: Value,
    provider_id: String,
}

async fn handle_provider_failure(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    failure: V3OpenAiChatRelayProviderFailure,
    failed_candidates: &mut BTreeSet<String>,
    same_candidate_retries: &mut BTreeMap<String, usize>,
    retry_selected: &mut Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    pending_provider_failure: &mut Option<V3OpenAiChatRelayProviderFailure>,
    trace: &mut Vec<&'static str>,
) -> Result<Option<V3OpenAiChatRelayProviderFailure>, V3OpenAiChatRelayRuntimeError> {
    let result = run_v3_relay_provider_failure_policy(
        context,
        selected,
        failure.status,
        failure
            .client_response
            .pointer("/error/type")
            .and_then(Value::as_str)
            .map(str::to_string),
        provider_failure_message(&failure),
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates,
            same_candidate_retries,
            trace,
        },
    )
    .await
    .map_err(V3OpenAiChatRelayRuntimeError::Target)?;
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
) -> V3OpenAiChatRelayProviderFailure {
    let body = serde_json::from_slice::<Value>(body)
        .unwrap_or_else(|_| json!({"error":{"type":"provider_error","message":"provider error"}}));
    V3OpenAiChatRelayProviderFailure {
        status,
        client_response: body,
        provider_id: provider_id.to_string(),
    }
}

fn provider_runtime_failure(
    error: V3ProviderError,
    provider_id: &str,
) -> V3OpenAiChatRelayProviderFailure {
    V3OpenAiChatRelayProviderFailure {
        status: 502,
        client_response: json!({"error":{"type":"provider_error","message":error.to_string()}}),
        provider_id: provider_id.to_string(),
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
    trace: Vec<&'static str>,
) -> V3OpenAiChatRelayRuntimeOutput {
    let message = provider_failure_message(&failure);
    let code = failure
        .client_response
        .pointer("/error/code")
        .and_then(Value::as_str)
        .or_else(|| {
            failure
                .client_response
                .pointer("/error/type")
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
