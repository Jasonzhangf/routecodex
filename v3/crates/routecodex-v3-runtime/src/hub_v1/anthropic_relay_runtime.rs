use super::*;
use crate::provider_failure_runtime_policy::{
    resolve_v3_relay_target, run_v3_relay_provider_failure_policy,
    v3_relay_provider_policy_now_epoch_ms, v3_relay_provider_target_selection_sample,
    V3ProviderFailureRuntimeHealth, V3RelayProviderFailureDecision,
    V3RelayProviderFailurePolicyContext, V3RelayProviderFailurePolicyState,
    V3RelayProviderFailureRetryPolicy, V3RelayProviderTargetResolutionInput,
};
use crate::{
    V3LocalContinuationError, V3LocalContinuationResp04SaveInput, V3LocalContinuationScopeKey,
    V3LocalContinuationStore, V3LocalContinuationTerminalOutcome,
};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3ErrorActionScope, V3ErrorHandlingCenter,
    V3ErrorHandlingCenterInput, V3ErrorSourceKind, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    build_v3_transport_13_responses_http_request_from_v3_provider_12, ReqwestResponsesTransport,
    ResponsesTransport, V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderError,
    V3ProviderResponseBody, V3ResponsesProviderTarget,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, MutexGuard};

const V3_ANTHROPIC_LOCAL_CONTINUATION_TTL_MS: u64 = 30 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq)]
pub struct V3AnthropicRelayRuntimeInput {
    pub server_id: String,
    pub request_id: String,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3AnthropicRelayRuntimeOutput {
    pub status: u16,
    pub client_response: Value,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
    pub servertool_followup_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3AnthropicRelayLocalContinuationScope {
    entry_endpoint: String,
    session_id: String,
    conversation_id: String,
    port: u16,
    routing_group: String,
}

impl V3AnthropicRelayLocalContinuationScope {
    pub fn anthropic(
        entry_endpoint: impl Into<String>,
        session_id: impl Into<String>,
        conversation_id: impl Into<String>,
        port: u16,
        routing_group: impl Into<String>,
    ) -> Self {
        Self {
            entry_endpoint: entry_endpoint.into(),
            session_id: session_id.into(),
            conversation_id: conversation_id.into(),
            port,
            routing_group: routing_group.into(),
        }
    }

    fn local_key(&self) -> V3LocalContinuationScopeKey {
        V3LocalContinuationScopeKey::anthropic(
            self.entry_endpoint.clone(),
            self.session_id.clone(),
            self.conversation_id.clone(),
            self.port,
            self.routing_group.clone(),
        )
    }

    fn hub_scope(&self, server_id: &str) -> V3HubContinuationScope {
        V3HubContinuationScope::new(
            V3HubEntryProtocol::Anthropic,
            server_id,
            self.routing_group.clone(),
            self.session_id.clone(),
        )
    }
}

#[derive(Debug, Default)]
pub struct V3AnthropicRelayLocalContinuationState {
    store: Mutex<V3LocalContinuationStore>,
}

impl V3AnthropicRelayLocalContinuationState {
    pub fn len(&self) -> Result<usize, V3AnthropicRelayRuntimeError> {
        Ok(self.lock_store()?.len())
    }

    pub fn is_empty(&self) -> Result<bool, V3AnthropicRelayRuntimeError> {
        Ok(self.lock_store()?.is_empty())
    }

    fn lock_store(
        &self,
    ) -> Result<MutexGuard<'_, V3LocalContinuationStore>, V3AnthropicRelayRuntimeError> {
        self.store
            .lock()
            .map_err(|_| V3AnthropicRelayRuntimeError::LocalContinuationStatePoisoned)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum V3AnthropicRelayRuntimeError {
    #[error(transparent)]
    Protocol(#[from] V3AnthropicRelayProtocolHookError),
    #[error(transparent)]
    Request(#[from] V3HubRelayRequestError),
    #[error(transparent)]
    Response(#[from] V3HubRelayResponseError),
    #[error(transparent)]
    Codec(#[from] V3AnthropicCodecError),
    #[error("V3 Hub static hook registry failed: {0}")]
    StaticRegistry(String),
    #[error("V3 Relay target resolution failed: {0}")]
    Target(String),
    #[error("V3 Relay provider contract failed: {0}")]
    Provider(#[from] V3ProviderError),
    #[error("V3 Relay provider compat failed: {0}")]
    ProviderCompat(#[from] V3ProviderCompatError),
    #[error("V3 Relay JSON provider body is malformed: {0}")]
    ProviderJson(#[from] serde_json::Error),
    #[error("V3 Relay structured SSE projection failed: {0}")]
    StructuredSse(String),
    #[error(transparent)]
    LocalContinuation(#[from] V3LocalContinuationError),
    #[error("V3 Anthropic local continuation scope routing group does not match server")]
    LocalContinuationScopeMismatch,
    #[error("V3 Anthropic local continuation clock overflow")]
    LocalContinuationClockOverflow,
    #[error("V3 Anthropic local continuation state lock is poisoned")]
    LocalContinuationStatePoisoned,
}

pub async fn execute_v3_anthropic_relay_runtime_with_default_transport(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime(manifest, input, &ReqwestResponsesTransport::default()).await
}

pub async fn execute_v3_anthropic_relay_dry_run_runtime(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
) -> crate::V3FoundationRuntimeOutput {
    let captured_provider_request = Arc::new(Mutex::new(None));
    let transport = V3ProviderRequestDryRunNoNetworkTransport::new(
        json!({
            "id": format!("dry_run_{}", input.request_id),
            "object": "response",
            "status": "completed",
            "output_text": "routecodex provider-request dry-run stopped before provider send",
            "output": [{
                "type": "output_text",
                "text": "routecodex provider-request dry-run stopped before provider send"
            }]
        }),
        Arc::clone(&captured_provider_request),
    );
    let mut output = match execute_v3_anthropic_relay_runtime_inner(
        manifest,
        input,
        &transport,
        None,
        V3HubRelayResponseHookProfile::empty(),
        V3ProviderFailureRuntimeHealth::from_manifest(manifest),
        V3RelayProviderFailureRetryPolicy::default(),
    )
    .await
    {
        Ok(output) => output,
        Err(error) => project_v3_anthropic_relay_runtime_failure(error),
    };
    if let Some(index) = output
        .node_trace
        .iter()
        .position(|node| *node == "V3ProviderReqOutbound09TransportRequest")
    {
        output
            .node_trace
            .insert(index + 1, "V3DryRunNoNetworkTerminalEffect");
    }
    output.node_trace.push("V3Server16HttpFrame");
    let provider_request = captured_provider_request
        .lock()
        .ok()
        .and_then(|captured| captured.clone())
        .unwrap_or(Value::Null);
    let dry_run_status = if provider_request.is_null() {
        output.status
    } else {
        200
    };
    crate::V3FoundationRuntimeOutput {
        status: dry_run_status,
        body: json!({
            "object": "routecodex.pipeline_dry_run",
            "kind": "provider_request",
            "dryRun": true,
            "evidence": {
                "stoppedBeforeProviderSend": true,
                "providerNetworkSend": false,
                "stoppedBeforeNetworkSend": true,
                "providerRequestCaptured": !provider_request.is_null()
            },
            "providerRequest": provider_request,
            "dry_run": {
                "probe_id": "anthropic_relay_provider_request",
                "server_id": "anthropic_relay",
                "method": "POST",
                "path": "/v1/messages",
                "terminal_effect": "no_network_send",
                "provider_pipeline_executed": true,
                "provider_network_send": false,
                "stopped_before_network_send": true,
                "stopped_before_provider_send": true,
                "provider_request": provider_request,
                "node_ids": output.node_trace,
                "snapshots": [],
                "response_payload": output.client_response
            }
        }),
        debug_node: "V3DryRunNoNetworkTerminalEffect",
        error_node: output
            .error_chain
            .as_ref()
            .map_or("none", |_| "V3Error06ClientProjected"),
        error_chain: output.error_chain.unwrap_or_default(),
        node_trace: output.node_trace,
        stopped_before_provider_send: true,
    }
}

pub async fn execute_v3_anthropic_relay_runtime<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    transport: &T,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_inner(
        manifest,
        input,
        transport,
        None,
        V3HubRelayResponseHookProfile::empty(),
        V3ProviderFailureRuntimeHealth::from_manifest(manifest),
        V3RelayProviderFailureRetryPolicy::default(),
    )
    .await
}

pub async fn execute_v3_anthropic_relay_runtime_with_local_continuation<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    transport: &T,
    state: &V3AnthropicRelayLocalContinuationState,
    scope: V3AnthropicRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_with_local_continuation_and_servertool_profile(
        manifest,
        input,
        transport,
        state,
        scope,
        now_epoch_ms,
        std::iter::empty::<&'static str>(),
    )
    .await
}

pub async fn execute_v3_anthropic_relay_runtime_with_local_continuation_and_servertool_profile<
    T,
    I,
    S,
>(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    transport: &T,
    state: &V3AnthropicRelayLocalContinuationState,
    scope: V3AnthropicRelayLocalContinuationScope,
    now_epoch_ms: u64,
    servertool_names: I,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError>
where
    T: ResponsesTransport,
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    execute_v3_anthropic_relay_runtime_inner(
        manifest,
        input,
        transport,
        Some(V3AnthropicRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
        }),
        V3HubRelayResponseHookProfile::new(servertool_names),
        V3ProviderFailureRuntimeHealth::from_manifest(manifest),
        V3RelayProviderFailureRetryPolicy::default(),
    )
    .await
}

struct V3AnthropicRelayLocalContinuationExecution<'state> {
    state: &'state V3AnthropicRelayLocalContinuationState,
    scope: V3AnthropicRelayLocalContinuationScope,
    now_epoch_ms: u64,
}

async fn execute_v3_anthropic_relay_runtime_inner<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    transport: &T,
    local: Option<V3AnthropicRelayLocalContinuationExecution<'_>>,
    response_hook_profile: V3HubRelayResponseHookProfile,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3RelayProviderFailureRetryPolicy,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    compile_v3_hub_v1_static_registry()
        .map_err(|error| V3AnthropicRelayRuntimeError::StaticRegistry(error.to_string()))?;
    let mut trace = Vec::with_capacity(17);
    let transport_intent = if input.payload.get("stream").and_then(Value::as_bool) == Some(true) {
        V3HubTransportIntent::Sse
    } else {
        V3HubTransportIntent::Json
    };
    let requested_local_ids = find_anthropic_tool_result_ids(&input.payload)?;
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        input.payload,
        V3HubEntryProtocol::Anthropic,
        V3HubInvocationSource::Client,
        transport_intent,
    );
    trace.push("V3HubReqInbound01ClientRaw");
    let req02 = run_v3_anthropic_relay_runtime_req_inbound(req01)?;
    trace.push("V3HubReqInbound02Normalized");
    let base_hub_scope = V3HubContinuationScope::new(
        V3HubEntryProtocol::Anthropic,
        &input.server_id,
        server_routing_group(manifest, &input.server_id)?,
        &input.request_id,
    );
    let request_outcome = {
        let local_store_guard =
            if let (Some(local), Some(_)) = (local.as_ref(), requested_local_ids.first()) {
                Some(local.state.lock_store()?)
            } else {
                None
            };
        let lookup = if let (Some(local), Some(context_id)) =
            (local.as_ref(), requested_local_ids.first())
        {
            if local.scope.routing_group != server_routing_group(manifest, &input.server_id)? {
                return Err(V3AnthropicRelayRuntimeError::LocalContinuationScopeMismatch);
            }
            let store = local_store_guard
                .as_deref()
                .ok_or(V3AnthropicRelayRuntimeError::LocalContinuationStatePoisoned)?;
            V3HubContinuationLookup::new(Some(context_id), local.scope.hub_scope(&input.server_id))
                .with_local_context_from_req04_store(
                    context_id,
                    local.scope.hub_scope(&input.server_id),
                    store,
                    local.scope.local_key(),
                    local.now_epoch_ms,
                    &requested_local_ids[1..],
                )?
        } else {
            V3HubContinuationLookup::new(None, base_hub_scope)
        };
        compile_v3_hub_relay_request_hooks().run_from_normalized(
            req02,
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        )?
    };
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
    let mut pending_provider_failure: Option<V3AnthropicRelayProviderFailure> = None;
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let deterministic_sample = v3_relay_provider_target_selection_sample(&input.request_id);
    let failure_context = V3RelayProviderFailurePolicyContext {
        manifest,
        server_id: &input.server_id,
        entry_kind: "anthropic",
        endpoint_path: "/v1/messages",
        route_facts_body: &route_facts_body,
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
                entry_kind: "anthropic",
                endpoint_path: "/v1/messages",
                body: &route_facts_body,
                request_local_excluded_candidates: &failed_candidates,
                provider_health: &provider_health,
                now_ms: v3_relay_provider_policy_now_epoch_ms()
                    .map_err(V3AnthropicRelayRuntimeError::Target)?,
                deterministic_sample,
            }) {
                Ok(selected) => selected,
                Err(error) => {
                    if let Some(failure) = pending_provider_failure.take() {
                        return Ok(provider_failure_output(failure, trace));
                    }
                    return Err(V3AnthropicRelayRuntimeError::Target(error));
                }
            }
        };
        let provider_wire_protocol = provider_wire_protocol_for_provider_type(
            &selected.candidate.provider_id,
            &selected.candidate.provider_type,
        )
        .map_err(V3AnthropicRelayRuntimeError::Target)?;
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
        let req07 =
            build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_wire_protocol);
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
        let transport_request = match provider_wire_protocol {
            V3HubProviderWireProtocol::Responses => {
                build_v3_transport_13_responses_http_request_from_v3_provider_12(wire)?
            }
            V3HubProviderWireProtocol::Anthropic => {
                build_v3_anthropic_messages_transport_request_from_v3_provider_08(wire)
                    .map_err(V3AnthropicRelayRuntimeError::Target)?
            }
            other => {
                return Err(V3AnthropicRelayRuntimeError::Target(format!(
                    "Anthropic Relay does not support provider transport protocol {other:?}"
                )));
            }
        };
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
                    &mut V3RelayProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        same_candidate_retries: &mut same_candidate_retries,
                        trace: &mut trace,
                    },
                    &mut retry_selected,
                    &mut pending_provider_failure,
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
                    &mut V3RelayProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        same_candidate_retries: &mut same_candidate_retries,
                        trace: &mut trace,
                    },
                    &mut retry_selected,
                    &mut pending_provider_failure,
                )
                .await?
                {
                    return Ok(provider_failure_output(failure, trace));
                }
                continue;
            }
        };
        match provider_raw.into_body() {
            V3ProviderResponseBody::Sse(stream) => {
                if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                    let stream_observation = V3RuntimeStreamObservation::default();
                    let canonical_response =
                        match super::responses_relay_runtime::build_v3_hub_resp_inbound_02_from_anthropic_provider_stream_events(
                            stream,
                            &stream_observation,
                        )
                        .await
                        {
                            Ok(response) => response,
                            Err(error) => {
                                let failure = provider_runtime_failure(
                                    V3ProviderError::ResponseBody {
                                        request_id: input.request_id.clone(),
                                        provider_id: selected_target_provider_id.clone(),
                                        reason: format!(
                                            "provider Anthropic SSE response event codec failed: {error}"
                                        ),
                                    },
                                    &selected_target_provider_id,
                                );
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
                                    &mut pending_provider_failure,
                                )
                                .await?
                                {
                                    return Ok(provider_failure_output(failure, trace));
                                }
                                continue;
                            }
                        };
                    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
                        canonical_response,
                        V3ProviderRespInbound01RawContext::new(
                            V3HubEntryProtocol::Anthropic,
                            V3HubProviderWireProtocol::Responses,
                            V3HubContinuationOwnership::New,
                            V3HubExecutionMode::Relay,
                            V3HubInvocationSource::Client,
                            V3HubTransportIntent::Sse,
                        )
                        .with_compatibility_profile(
                            selected_target_compatibility_profile.as_deref(),
                        ),
                    );
                    let (client_response, servertool_followup_required) =
                        match closeout_anthropic_relay_response(
                            resp01,
                            &response_hook_profile,
                            trace.as_mut(),
                            local.as_ref(),
                            &requested_local_ids,
                            |finalized| {
                                let client_events =
                                    project_v3_responses_json_as_anthropic_events(finalized)?;
                                Ok(V3AnthropicRelaySseProjection::project_after_resp04(
                                    client_events,
                                ))
                            },
                        ) {
                            Ok(closeout) => closeout,
                            Err(error) => {
                                let failure = provider_runtime_failure(
                                    V3ProviderError::ResponseBody {
                                        request_id: input.request_id.clone(),
                                        provider_id: selected_target_provider_id.clone(),
                                        reason: format!(
                                            "provider response governance failed: {error}"
                                        ),
                                    },
                                    &selected_target_provider_id,
                                );
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
                                    &mut pending_provider_failure,
                                )
                                .await?
                                {
                                    return Ok(provider_failure_output(failure, trace));
                                }
                                continue;
                            }
                        };
                    record_provider_success_after_resp04(
                        &provider_health,
                        &selected_target_provider_id,
                        &selected_target_auth_alias,
                        &selected_target_model_id,
                    )?;
                    return Ok(V3AnthropicRelayRuntimeOutput {
                        status: 200,
                        client_response,
                        node_trace: trace,
                        error_chain: None,
                        servertool_followup_required,
                    });
                }
                let projection = match project_v3_responses_sse_as_anthropic_events(stream).await {
                    Ok(projection) => projection,
                    Err(error) => {
                        let failure = provider_runtime_failure(
                            V3ProviderError::ResponseBody {
                                request_id: input.request_id.clone(),
                                provider_id: selected_target_provider_id.clone(),
                                reason: format!(
                                    "provider Responses SSE projection failed: {error}"
                                ),
                            },
                            &selected_target_provider_id,
                        );
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
                            &mut pending_provider_failure,
                        )
                        .await?
                        {
                            return Ok(provider_failure_output(failure, trace));
                        }
                        continue;
                    }
                };
                let (canonical_response, client_events) = projection.into_parts();
                let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
                    canonical_response,
                    V3ProviderRespInbound01RawContext::new(
                        V3HubEntryProtocol::Anthropic,
                        provider_wire_protocol,
                        V3HubContinuationOwnership::New,
                        V3HubExecutionMode::Relay,
                        V3HubInvocationSource::Client,
                        V3HubTransportIntent::Sse,
                    )
                    .with_compatibility_profile(selected_target_compatibility_profile.as_deref()),
                );
                let (client_response, servertool_followup_required) =
                    match closeout_anthropic_relay_response(
                        resp01,
                        &response_hook_profile,
                        trace.as_mut(),
                        local.as_ref(),
                        &requested_local_ids,
                        move |_| {
                            Ok(V3AnthropicRelaySseProjection::project_after_resp04(
                                client_events,
                            ))
                        },
                    ) {
                        Ok(closeout) => closeout,
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
                                &mut V3RelayProviderFailurePolicyState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    trace: &mut trace,
                                },
                                &mut retry_selected,
                                &mut pending_provider_failure,
                            )
                            .await?
                            {
                                return Ok(provider_failure_output(failure, trace));
                            }
                            continue;
                        }
                    };
                record_provider_success_after_resp04(
                    &provider_health,
                    &selected_target_provider_id,
                    &selected_target_auth_alias,
                    &selected_target_model_id,
                )?;
                return Ok(V3AnthropicRelayRuntimeOutput {
                    status: 200,
                    client_response,
                    node_trace: trace,
                    error_chain: None,
                    servertool_followup_required,
                });
            }
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
                            &mut V3RelayProviderFailurePolicyState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                trace: &mut trace,
                            },
                            &mut retry_selected,
                            &mut pending_provider_failure,
                        )
                        .await?
                        {
                            return Ok(provider_failure_output(failure, trace));
                        }
                        continue;
                    }
                };
                let hook_provider_value =
                    if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                        match project_v3_anthropic_message_as_responses_response(&provider_value) {
                            Ok(value) => value,
                            Err(error) => {
                                let failure = provider_runtime_failure(
                                    V3ProviderError::ResponseBody {
                                        request_id: input.request_id.clone(),
                                        provider_id: selected_target_provider_id.clone(),
                                        reason: format!(
                                            "provider Anthropic JSON response codec failed: {error}"
                                        ),
                                    },
                                    &selected_target_provider_id,
                                );
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
                                    &mut pending_provider_failure,
                                )
                                .await?
                                {
                                    return Ok(provider_failure_output(failure, trace));
                                }
                                continue;
                            }
                        }
                    } else {
                        provider_value
                    };
                let hook_provider_protocol =
                    if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                        V3HubProviderWireProtocol::Responses
                    } else {
                        provider_wire_protocol
                    };
                let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
                    hook_provider_value,
                    V3ProviderRespInbound01RawContext::new(
                        V3HubEntryProtocol::Anthropic,
                        hook_provider_protocol,
                        V3HubContinuationOwnership::New,
                        V3HubExecutionMode::Relay,
                        V3HubInvocationSource::Client,
                        transport_intent,
                    )
                    .with_compatibility_profile(selected_target_compatibility_profile.as_deref()),
                );
                let (client_response, servertool_followup_required) =
                    match closeout_anthropic_relay_response(
                        resp01,
                        &response_hook_profile,
                        trace.as_mut(),
                        local.as_ref(),
                        &requested_local_ids,
                        |finalized| {
                            if transport_intent == V3HubTransportIntent::Sse {
                                let client_events =
                                    project_v3_responses_json_as_anthropic_events(finalized)?;
                                Ok(V3AnthropicRelaySseProjection::project_after_resp04(
                                    client_events,
                                ))
                            } else {
                                Ok(project_v3_responses_json_as_anthropic_message(finalized)?)
                            }
                        },
                    ) {
                        Ok(closeout) => closeout,
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
                                &mut V3RelayProviderFailurePolicyState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    trace: &mut trace,
                                },
                                &mut retry_selected,
                                &mut pending_provider_failure,
                            )
                            .await?
                            {
                                return Ok(provider_failure_output(failure, trace));
                            }
                            continue;
                        }
                    };
                record_provider_success_after_resp04(
                    &provider_health,
                    &selected_target_provider_id,
                    &selected_target_auth_alias,
                    &selected_target_model_id,
                )?;
                return Ok(V3AnthropicRelayRuntimeOutput {
                    status: 200,
                    client_response,
                    node_trace: trace,
                    error_chain: None,
                    servertool_followup_required,
                });
            }
        }
    }
}

fn find_anthropic_tool_result_ids(
    payload: &Value,
) -> Result<Vec<String>, V3AnthropicRelayRuntimeError> {
    let mut ids = Vec::new();
    for part in payload
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|message| message.get("content").and_then(Value::as_array))
        .flatten()
    {
        if part.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let id = part
            .get("tool_use_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| V3LocalContinuationError::Codec {
                message: "Anthropic tool_result requires tool_use_id".to_string(),
            })?;
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_owned());
        }
    }
    Ok(ids)
}

fn closeout_anthropic_relay_response<F>(
    resp01: V3ProviderRespInbound01Raw,
    response_hook_profile: &V3HubRelayResponseHookProfile,
    trace: &mut Vec<&'static str>,
    local: Option<&V3AnthropicRelayLocalContinuationExecution<'_>>,
    requested_local_ids: &[String],
    project_client_response: F,
) -> Result<(Value, bool), V3AnthropicRelayRuntimeError>
where
    F: FnOnce(&Value) -> Result<Value, V3AnthropicRelayRuntimeError>,
{
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks.normalize(resp01)?;
    trace.push("ProviderRespCompat02ProviderCompat");
    trace.push("V3HubRespInbound02Normalized");
    let resp03 = hooks.govern(resp02, response_hook_profile)?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp04 = hooks.commit(resp03)?;
    trace.push("V3HubRespContinuation04Committed");
    let servertool_followup_required =
        resp04.previous.servertool_action() == V3HubServertoolResponseAction::FollowupRequired;
    commit_or_release_local_continuation(
        local,
        requested_local_ids,
        resp04.finalized_payload(),
        resp04.action(),
    )?;
    let client_response = project_client_response(resp04.finalized_payload())?;
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
    trace.push("V3HubRespOutbound05ClientSemantic");
    let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    trace.push("V3ServerRespOutbound06ClientFrame");
    Ok((client_response, servertool_followup_required))
}

fn commit_or_release_local_continuation(
    local: Option<&V3AnthropicRelayLocalContinuationExecution<'_>>,
    restored_context_ids: &[String],
    canonical_response: &Value,
    action: V3HubContinuationCommit,
) -> Result<(), V3AnthropicRelayRuntimeError> {
    let Some(local) = local else {
        return Ok(());
    };
    let mut store = local.state.lock_store()?;
    for context_id in restored_context_ids {
        store.release_in_scope(&local.scope.local_key(), context_id);
    }
    if action != V3HubContinuationCommit::LocalContext {
        return Ok(());
    }
    let context_ids = canonical_response
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("function_call" | "custom_tool_call" | "tool_call")
            )
        })
        .map(|item| {
            item.get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| V3LocalContinuationError::Codec {
                    message: "Resp04 local context has a tool call without id".to_string(),
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if context_ids.is_empty() {
        return Err(V3LocalContinuationError::Codec {
            message: "Resp04 local context has no tool call id".to_string(),
        }
        .into());
    }
    if let Some(duplicate) = context_ids
        .iter()
        .find(|id| store.contains_in_scope(&local.scope.local_key(), id))
    {
        return Err(V3LocalContinuationError::AlreadyCommitted {
            context_id: duplicate.clone(),
        }
        .into());
    }
    let expires_at_epoch_ms = local
        .now_epoch_ms
        .checked_add(V3_ANTHROPIC_LOCAL_CONTINUATION_TTL_MS)
        .ok_or(V3AnthropicRelayRuntimeError::LocalContinuationClockOverflow)?;
    for context_id in context_ids {
        store.commit_at_resp04(V3LocalContinuationResp04SaveInput::new(
            context_id,
            local.scope.local_key(),
            canonical_response.clone(),
            V3LocalContinuationTerminalOutcome::NonTerminal,
            local.now_epoch_ms,
            expires_at_epoch_ms,
        ))?;
    }
    Ok(())
}

pub fn project_v3_anthropic_relay_runtime_failure(
    error: V3AnthropicRelayRuntimeError,
) -> V3AnthropicRelayRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3HubRuntime",
        "anthropic_relay_runtime_error",
        error.to_string(),
    );
    error_output(
        source,
        500,
        json!({"type":"error","error":{"type":"runtime_error","message":error.to_string()}}),
        "none",
        Vec::new(),
    )
}

fn server_routing_group<'a>(
    manifest: &'a V3Config05ManifestPublished,
    server_id: &str,
) -> Result<&'a str, V3AnthropicRelayRuntimeError> {
    manifest
        .servers
        .get(server_id)
        .map(|server| server.routing_group.as_str())
        .ok_or_else(|| V3AnthropicRelayRuntimeError::Target(format!("server {server_id} missing")))
}

fn provider_target(
    manifest: &V3Config05ManifestPublished,
    selected: &routecodex_v3_target::V3TargetCandidate,
) -> Result<V3ResponsesProviderTarget, V3AnthropicRelayRuntimeError> {
    let provider = manifest
        .providers
        .get(&selected.provider_id)
        .ok_or_else(|| {
            V3AnthropicRelayRuntimeError::Target("selected provider missing".to_string())
        })?;
    let auth = provider
        .auth
        .entries
        .iter()
        .find(|entry| entry.alias == selected.auth_alias)
        .ok_or_else(|| {
            V3AnthropicRelayRuntimeError::Target("selected auth handle missing".to_string())
        })?;
    let secret = match (&auth.env, &auth.token_file) {
        (Some(env), None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path)) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        _ => {
            return Err(V3AnthropicRelayRuntimeError::Target(
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

struct V3AnthropicRelayProviderFailure {
    status: u16,
    client_response: Value,
    provider_id: String,
}

async fn handle_provider_failure(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    failure: V3AnthropicRelayProviderFailure,
    state: &mut V3RelayProviderFailurePolicyState<'_>,
    retry_selected: &mut Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    pending_provider_failure: &mut Option<V3AnthropicRelayProviderFailure>,
) -> Result<Option<V3AnthropicRelayProviderFailure>, V3AnthropicRelayRuntimeError> {
    let result = run_v3_relay_provider_failure_policy(
        context,
        selected,
        failure.status,
        failure_error_type(&failure),
        provider_failure_message(&failure),
        state,
    )
    .await
    .map_err(V3AnthropicRelayRuntimeError::Target)?;
    match result.decision {
        V3RelayProviderFailureDecision::Reselect => {
            *pending_provider_failure = Some(failure);
            Ok(None)
        }
        V3RelayProviderFailureDecision::RetrySame(selected) => {
            *retry_selected = Some(*selected);
            Ok(None)
        }
        V3RelayProviderFailureDecision::ProjectTerminal => Ok(Some(failure)),
    }
}

fn provider_http_failure(
    status: u16,
    body: &[u8],
    provider_id: &str,
) -> V3AnthropicRelayProviderFailure {
    V3AnthropicRelayProviderFailure {
        status,
        client_response: project_v3_responses_error_as_anthropic_error(body),
        provider_id: provider_id.to_string(),
    }
}

fn provider_runtime_failure(
    error: V3ProviderError,
    provider_id: &str,
) -> V3AnthropicRelayProviderFailure {
    V3AnthropicRelayProviderFailure {
        status: 502,
        client_response: json!({"type":"error","error":{"type":"provider_error","message":error.to_string()}}),
        provider_id: provider_id.to_string(),
    }
}

fn failure_error_type(failure: &V3AnthropicRelayProviderFailure) -> Option<String> {
    failure
        .client_response
        .pointer("/error/type")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn provider_failure_message(failure: &V3AnthropicRelayProviderFailure) -> String {
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
    failure: V3AnthropicRelayProviderFailure,
    trace: Vec<&'static str>,
) -> V3AnthropicRelayRuntimeOutput {
    let message = provider_failure_message(&failure);
    let code = failure
        .client_response
        .pointer("/error/type")
        .and_then(Value::as_str)
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

fn record_provider_success_after_resp04(
    provider_health: &V3ProviderFailureRuntimeHealth,
    provider_id: &str,
    auth_alias: &str,
    model_id: &str,
) -> Result<(), V3AnthropicRelayRuntimeError> {
    provider_health
        .record_provider_success(
            provider_id,
            Some(auth_alias),
            Some(model_id),
            v3_relay_provider_policy_now_epoch_ms()
                .map_err(V3AnthropicRelayRuntimeError::Target)?,
        )
        .map_err(|error| V3AnthropicRelayRuntimeError::Target(error.to_string()))
}

fn error_output(
    source: routecodex_v3_error::V3Error01SourceRaised,
    status: u16,
    client_response: Value,
    provider_id: &str,
    mut trace: Vec<&'static str>,
) -> V3AnthropicRelayRuntimeOutput {
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
    V3AnthropicRelayRuntimeOutput {
        status: projected.status,
        client_response: projected.body,
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        servertool_followup_required: false,
    }
}
