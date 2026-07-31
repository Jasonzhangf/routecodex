use super::*;
use crate::provider_action_gate::{V3ProviderActionPermit, V3ProviderActionRecoveryTransition};
use crate::provider_failure_runtime_policy::{
    project_v3_client_disconnect, provider_runtime_failure_stage, resolve_v3_relay_target,
    run_v3_relay_provider_failure_policy, v3_relay_provider_policy_now_epoch_ms,
    v3_relay_provider_target_selection_sample, V3ProviderFailureRuntimeHealth,
    V3RelayProviderFailurePolicyContext, V3RelayProviderFailurePolicyState,
    V3RelayProviderFailureRetryPolicy, V3RelayProviderTargetResolutionInput,
};
use crate::{
    V3LocalContinuationError, V3LocalContinuationResp04SaveInput, V3LocalContinuationScopeKey,
    V3LocalContinuationStore, V3LocalContinuationTerminalOutcome,
};
use futures_util::StreamExt;
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error05ExecutionAction, V3Error05RecoveryAdmissionWitness,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
    V3ProviderFailureSessionScope, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    build_v3_anthropic_provider_request_header, build_v3_provider_12_responses_wire_payload,
    build_v3_transport_13_responses_http_request_from_v3_provider_12,
    is_v3_anthropic_provider_request_header_name, ReqwestResponsesTransport, ResponsesTransport,
    V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderError, V3ProviderResponseBody,
    V3ProviderSseStream, V3ResponsesProviderTarget,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, MutexGuard};

const V3_ANTHROPIC_LOCAL_CONTINUATION_TTL_MS: u64 = 30 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq)]
pub struct V3AnthropicRelayRuntimeInput {
    pub server_id: String,
    pub failure_session_scope: V3ProviderFailureSessionScope,
    pub request_id: String,
    pub payload: Value,
}

impl From<String> for V3AnthropicRelayRuntimeError {
    fn from(value: String) -> Self {
        Self::Target(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3AnthropicRelayClientHeader {
    pub name: String,
    pub value: String,
}

impl V3AnthropicRelayClientHeader {
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
        }
    }

    pub fn is_provider_protocol_header_name(name: &str) -> bool {
        is_v3_anthropic_provider_request_header_name(name)
    }

    pub fn provider_protocol(name: impl Into<String>, value: impl Into<String>) -> Option<Self> {
        build_v3_anthropic_provider_request_header(name, value).map(|header| Self {
            name: header.name().to_string(),
            value: header.value().to_string(),
        })
    }
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

pub async fn execute_v3_anthropic_relay_runtime_with_default_transport_provider_health(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    provider_health: V3ProviderFailureRuntimeHealth,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_with_client_headers_provider_health(
        manifest,
        input,
        &ReqwestResponsesTransport::default(),
        Vec::new(),
        provider_health,
    )
    .await
}

pub async fn execute_v3_anthropic_relay_runtime_with_default_transport_and_client_headers(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    client_headers: Vec<V3AnthropicRelayClientHeader>,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_with_client_headers(
        manifest,
        input,
        &ReqwestResponsesTransport::default(),
        client_headers,
    )
    .await
}

pub async fn execute_v3_anthropic_relay_runtime_with_default_transport_client_headers_provider_health(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    client_headers: Vec<V3AnthropicRelayClientHeader>,
    provider_health: V3ProviderFailureRuntimeHealth,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_with_client_headers_provider_health(
        manifest,
        input,
        &ReqwestResponsesTransport::default(),
        client_headers,
        provider_health,
    )
    .await
}

pub async fn execute_v3_anthropic_relay_dry_run_runtime(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_anthropic_relay_dry_run_runtime_with_client_headers(manifest, input, Vec::new())
        .await
}

pub async fn execute_v3_anthropic_relay_dry_run_runtime_with_client_headers(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    client_headers: Vec<V3AnthropicRelayClientHeader>,
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
        client_headers,
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
    execute_v3_anthropic_relay_runtime_with_client_headers(manifest, input, transport, Vec::new())
        .await
}

pub async fn execute_v3_anthropic_relay_runtime_with_client_headers<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    transport: &T,
    client_headers: Vec<V3AnthropicRelayClientHeader>,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_with_client_headers_provider_health(
        manifest,
        input,
        transport,
        client_headers,
        V3ProviderFailureRuntimeHealth::from_manifest(manifest),
    )
    .await
}

pub async fn execute_v3_anthropic_relay_runtime_with_client_headers_provider_health<
    T: ResponsesTransport,
>(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    transport: &T,
    client_headers: Vec<V3AnthropicRelayClientHeader>,
    provider_health: V3ProviderFailureRuntimeHealth,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_inner(
        manifest,
        input,
        transport,
        client_headers,
        None,
        V3HubRelayResponseHookProfile::empty(),
        provider_health,
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
        Vec::new(),
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
    client_headers: Vec<V3AnthropicRelayClientHeader>,
    local: Option<V3AnthropicRelayLocalContinuationExecution<'_>>,
    response_hook_profile: V3HubRelayResponseHookProfile,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3RelayProviderFailureRetryPolicy,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    compile_v3_hub_v1_static_registry()
        .map_err(|error| V3AnthropicRelayRuntimeError::StaticRegistry(error.to_string()))?;
    let mut trace = Vec::with_capacity(17);
    let provider_header_overrides =
        anthropic_relay_client_headers_as_provider_request_headers(&client_headers);
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
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut pending_provider_action_recovery = None;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let deterministic_sample = v3_relay_provider_target_selection_sample(&input.request_id);
    let failure_context = V3RelayProviderFailurePolicyContext {
        manifest,
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
                Err(error) => return Err(V3AnthropicRelayRuntimeError::Target(error)),
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
        let transport_request = match provider_wire_protocol {
            V3HubProviderWireProtocol::Responses => {
                match build_v3_transport_13_responses_http_request_from_v3_provider_12(wire) {
                    Ok(request) => request,
                    Err(error) => handle_provider_request_failure!(
                        "V3ProviderReqOutbound09TransportRequest",
                        "provider_transport_request_error",
                        error
                    ),
                }
            }
            V3HubProviderWireProtocol::Anthropic => {
                match build_v3_anthropic_messages_transport_request_from_v3_provider_08_with_provider_headers(
                    wire,
                    provider_header_overrides.clone(),
                ) {
                    Ok(request) => request,
                    Err(error) => handle_provider_request_failure!(
                        "V3ProviderReqOutbound09TransportRequest",
                        "provider_transport_request_error",
                        error
                    ),
                }
            }
            other => {
                return Err(V3AnthropicRelayRuntimeError::Target(format!(
                    "Anthropic Relay does not support provider transport protocol {other:?}"
                )));
            }
        };
        trace.push("V3ProviderReqOutbound09TransportRequest");
        let mut _provider_action_permit: Option<V3ProviderActionPermit> = None;
        if let Some(recovery) = pending_provider_action_recovery.take() {
            match provider_health
                .wait_for_error05_recovery(&recovery, &selected)
                .await
                .map_err(V3AnthropicRelayRuntimeError::Target)?
            {
                V3ProviderActionRecoveryTransition::Admitted(mut admission) => {
                    _provider_action_permit = admission.take_permit();
                    trace.push("V3ProviderActionGateAdmission");
                }
                V3ProviderActionRecoveryTransition::Superseded(ticket) => {
                    pending_provider_action_recovery = Some(
                        ticket
                            .recovery_witness()
                            .map_err(V3AnthropicRelayRuntimeError::Target)?,
                    );
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
                V3ProviderActionRecoveryTransition::ReleasedBySuccess(ticket) => {
                    pending_provider_action_recovery = Some(
                        ticket
                            .recovery_witness()
                            .map_err(V3AnthropicRelayRuntimeError::Target)?,
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
                drop(_provider_action_permit.take());
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
                drop(_provider_action_permit.take());
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
            V3ProviderResponseBody::Sse(stream) => {
                let chunks = match collect_v3_anthropic_relay_provider_sse_chunks(stream).await {
                    Ok(chunks) => chunks,
                    Err(error) => {
                        let failure = provider_runtime_failure(error, &selected_target_provider_id);
                        drop(_provider_action_permit.take());
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
                let resp01 = build_v3_provider_resp_inbound_01_raw_from_sse_chunks(
                    chunks,
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
                    match closeout_anthropic_relay_sse_response(
                        resp01,
                        &response_hook_profile,
                        trace.as_mut(),
                        local.as_ref(),
                        &requested_local_ids,
                        |finalized| {
                            let client_events =
                                project_v3_responses_json_as_anthropic_events(finalized)?;
                            Ok(project_v3_anthropic_events_after_resp04(client_events))
                        },
                    )
                    .await
                    {
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
                            drop(_provider_action_permit.take());
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
                record_provider_success_after_resp04(
                    &provider_health,
                    &input.failure_session_scope,
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
                        drop(_provider_action_permit.take());
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
                                drop(_provider_action_permit.take());
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
                                Ok(project_v3_anthropic_events_after_resp04(client_events))
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
                            drop(_provider_action_permit.take());
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
                record_provider_success_after_resp04(
                    &provider_health,
                    &input.failure_session_scope,
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

fn anthropic_relay_client_headers_as_provider_request_headers(
    client_headers: &[V3AnthropicRelayClientHeader],
) -> Vec<routecodex_v3_provider_responses::V3ProviderRequestHeader> {
    client_headers
        .iter()
        .filter_map(|header| {
            build_v3_anthropic_provider_request_header(&header.name, header.value.trim())
        })
        .collect()
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

async fn collect_v3_anthropic_relay_provider_sse_chunks(
    mut stream: V3ProviderSseStream,
) -> Result<Vec<Vec<u8>>, V3ProviderError> {
    let mut chunks = Vec::new();
    while let Some(chunk) = stream.next().await {
        chunks.push(chunk?);
    }
    Ok(chunks)
}

async fn closeout_anthropic_relay_sse_response<F>(
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
    let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01_sse(resp01).await?;
    trace.push("ProviderRespCompat02ProviderCompat");
    let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat);
    trace.push("V3HubRespInbound02Normalized");
    closeout_anthropic_relay_normalized_response(
        resp02,
        response_hook_profile,
        trace,
        local,
        requested_local_ids,
        project_client_response,
    )
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
    closeout_anthropic_relay_normalized_response(
        resp02,
        response_hook_profile,
        trace,
        local,
        requested_local_ids,
        project_client_response,
    )
}

fn closeout_anthropic_relay_normalized_response<F>(
    resp02: V3HubRespInbound02Normalized,
    response_hook_profile: &V3HubRelayResponseHookProfile,
    trace: &mut Vec<&'static str>,
    local: Option<&V3AnthropicRelayLocalContinuationExecution<'_>>,
    requested_local_ids: &[String],
    project_client_response: F,
) -> Result<(Value, bool), V3AnthropicRelayRuntimeError>
where
    F: FnOnce(&Value) -> Result<Value, V3AnthropicRelayRuntimeError>,
{
    let hooks = compile_v3_hub_relay_response_hooks();
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
    let client_payload = project_client_response(resp04.finalized_payload())?;
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload(
        resp04,
        client_payload,
    );
    trace.push("V3HubRespOutbound05ClientSemantic");
    let resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    trace.push("V3ServerRespOutbound06ClientFrame");
    let client_response = resp06.into_client_payload();
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
    let secret = match (&auth.env, &auth.token_file, &auth.api_key) {
        (Some(env), None, None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path), None) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        (None, None, Some(value)) => V3ProviderAuthSecretHandle::ApiKey(value.clone()),
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
        provider_request_cleanup: selected.provider_request_cleanup.clone(),
    })
}

struct V3AnthropicRelayProviderFailure {
    status: u16,
    client_response: Value,
    source_stage: &'static str,
    terminal_projection: Option<routecodex_v3_error::V3Error06ClientProjected>,
}

async fn handle_provider_failure(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    mut failure: V3AnthropicRelayProviderFailure,
    state: &mut V3RelayProviderFailurePolicyState<'_>,
    retry_selected: &mut Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    pending_recovery: &mut Option<V3Error05RecoveryAdmissionWitness>,
) -> Result<Option<V3AnthropicRelayProviderFailure>, V3AnthropicRelayRuntimeError> {
    if failure.terminal_projection.is_some() {
        return Ok(Some(failure));
    }
    let result = run_v3_relay_provider_failure_policy(
        context,
        selected,
        failure.source_stage,
        failure.status,
        failure_error_type(&failure),
        provider_failure_message(&failure),
        state,
    )
    .await
    .map_err(V3AnthropicRelayRuntimeError::Target)?;
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
            Err(V3AnthropicRelayRuntimeError::Target(
                "provider failure entered a non-provider Error05 lane".to_string(),
            ))
        }
    }
}

fn provider_http_failure(
    status: u16,
    body: &[u8],
    _provider_id: &str,
) -> V3AnthropicRelayProviderFailure {
    V3AnthropicRelayProviderFailure {
        status,
        client_response: project_v3_responses_error_as_anthropic_error(body),
        source_stage: "V3ProviderReqOutbound09TransportRequest",
        terminal_projection: None,
    }
}

fn provider_request_failure(
    source_stage: &'static str,
    error_type: &'static str,
    error: impl std::fmt::Display,
) -> V3AnthropicRelayProviderFailure {
    V3AnthropicRelayProviderFailure {
        status: 502,
        client_response: json!({"type":"error","error":{"type":error_type,"message":error.to_string()}}),
        source_stage,
        terminal_projection: None,
    }
}

fn provider_runtime_failure(
    error: V3ProviderError,
    provider_id: &str,
) -> V3AnthropicRelayProviderFailure {
    let terminal_projection =
        matches!(&error, V3ProviderError::ClientDisconnect { .. }).then(|| {
            project_v3_client_disconnect(
                provider_id,
                provider_runtime_failure_stage(&error),
                error.to_string(),
            )
        });
    V3AnthropicRelayProviderFailure {
        status: if terminal_projection.is_some() {
            499
        } else {
            502
        },
        client_response: json!({"type":"error","error":{"type":"provider_error","message":error.to_string()}}),
        source_stage: provider_runtime_failure_stage(&error),
        terminal_projection,
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
    mut trace: Vec<&'static str>,
) -> V3AnthropicRelayRuntimeOutput {
    let projected = failure
        .terminal_projection
        .expect("terminal Anthropic provider failure must carry typed Error06 projection");
    trace.push("V3Error06ClientProjected");
    V3AnthropicRelayRuntimeOutput {
        status: projected.status,
        client_response: projected.body,
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        servertool_followup_required: false,
    }
}

fn record_provider_success_after_resp04(
    provider_health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_id: &str,
    auth_alias: &str,
    model_id: &str,
) -> Result<(), V3AnthropicRelayRuntimeError> {
    provider_health
        .record_provider_success_in_failure_scope(
            failure_session_scope,
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
