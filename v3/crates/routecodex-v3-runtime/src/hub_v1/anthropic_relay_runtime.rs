use super::*;
use crate::provider_action_gate::{V3ProviderActionPermit, V3ProviderActionRecoveryTransition};
use crate::provider_failure_runtime_policy::{
    project_v3_client_disconnect, provider_runtime_failure_stage,
    resolve_v3_relay_target_outcome, resolve_v3_relay_target_outcome_with_rescue,
    run_v3_relay_provider_failure_policy, v3_relay_provider_policy_now_epoch_ms,
    v3_relay_provider_target_selection_sample,
    V3ProviderFailureRuntimeHealth, V3RelayProviderFailurePolicyContext,
    V3RelayProviderFailurePolicyState, V3RelayProviderFailureRetryPolicy,
    V3RelayProviderTargetResolution, V3RelayProviderTargetResolutionInput,
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

#[derive(Debug, Clone)]
pub struct V3AnthropicRelayRuntimeOutput {
    pub status: u16,
    pub client_response: Value,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
    pub servertool_followup_required: bool,
    pub observability: Option<V3RuntimeObservability>,
    pub stream_observation: Option<V3RuntimeStreamObservation>,
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
    #[error("V3 Relay requested direct provider model not found: {0}")]
    ModelNotFound(String),
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
    #[error(
        "V3 Anthropic web_search Mode B intercepted a websearch call but the chat-entry response \
         has no result projection path yet; refusing silent strip"
    )]
    WebSearchInterceptedUnprojected,
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
        V3RelayProviderFailureRetryPolicy::from_manifest(manifest),
        false,
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
        V3RelayProviderFailureRetryPolicy::from_manifest(manifest),
        true,
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
        V3RelayProviderFailureRetryPolicy::from_manifest(manifest),
        true,
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
    allow_exhaustion_rescue_probe: bool,
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
    // Mode B 判定用请求声明的 model 的编译期 mode（Req04 在 route 之前，
    // 无法感知最终 selected target；Resp03 侧再用 selected target mode 校验）。
    let request_web_search_execution_mode = {
        let model = input
            .payload
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        match model {
            Some(model) => resolve_web_search_mode_and_backend(manifest, model).0,
            None => routecodex_v3_config::V3WebSearchExecutionMode::None,
        }
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
        let request_hook_profile =
            if request_web_search_execution_mode.is_metadata_center_local_search() {
                // Mode B：Req04 需在工具面含标准 web_search 声明时激活 websearch
                // ServerTool 实例（LocalToolSurfaceActive），供 Resp03 同轮拦截。
                V3HubServertoolRequestProfile::enabled(["servertool.request"])
                    .with_web_search_execution_mode(request_web_search_execution_mode)
            } else {
                V3HubServertoolRequestProfile::disabled()
            };
        compile_v3_hub_relay_request_hooks().run_from_normalized(
            req02,
            &lookup,
            &request_hook_profile,
        )?
    };
    trace.push("V3HubReqContinuation03Classified");
    trace.push("V3HubReqChatProcess04Governed");
    let request_web_search_state = request_outcome.web_search_state().cloned();
    let mut response_hook_profile = response_hook_profile;
    if request_web_search_execution_mode.is_metadata_center_local_search() {
        response_hook_profile =
            response_hook_profile.with_web_search_execution_mode(request_web_search_execution_mode);
        if let Some(state) = request_web_search_state.as_ref() {
            response_hook_profile =
                response_hook_profile.with_web_search_center_state(state.clone());
        }
    }
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
    // 统一 relay timing（与 relay_runtime_core 同语义）：只写入 typed
    // observability，不进入 payload。
    let runtime_timing = crate::runtime_timing::V3RuntimeTimingState::start();
    loop {
        let selected = if let Some(selected) = retry_selected.take() {
            selected
        } else {
            let target_resolution_input = V3RelayProviderTargetResolutionInput {
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
                };
            let target_resolution = if allow_exhaustion_rescue_probe {
                resolve_v3_relay_target_outcome_with_rescue(target_resolution_input).await
            } else {
                resolve_v3_relay_target_outcome(target_resolution_input)
            };
            match target_resolution {
                V3RelayProviderTargetResolution::Selected(selected) => selected,
                V3RelayProviderTargetResolution::Failed(source)
                    if source.source_kind == V3ErrorSourceKind::ModelNotFound =>
                {
                    return Err(V3AnthropicRelayRuntimeError::ModelNotFound(
                        source.message.clone(),
                    ))
                }
                V3RelayProviderTargetResolution::Failed(source) => {
                    return Err(V3AnthropicRelayRuntimeError::Target(format!(
                        "{}: {}",
                        source.code, source.message
                    )))
                }
                V3RelayProviderTargetResolution::Exhausted {
                    attempted_candidates,
                } => {
                    return Err(V3AnthropicRelayRuntimeError::Target(format!(
                        "selected target exhausted after {attempted_candidates:?}"
                    )))
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
        // VR 路由决策时算好的"保留响应密文"标记：仅 gpt 模型 + 单一 provider 候选时
        // 保留（Codex 客户端需要官方密文重建 reasoning 历史），其余 Resp03 一律剥离。
        // 该标记写入响应侧 profile，响应侧只消费此结果，不重复判定。
        response_hook_profile = response_hook_profile.clone().with_retain_response_cipher(
            is_v3_retain_response_cipher(
                selected.route.target_plan.len(),
                &selected.candidate.model_id,
            ),
        );
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05.clone(),
            V3HubTargetResolution::Routed,
            selected.candidate.clone(),
        );
        trace.push("V3HubReqTarget06Resolved");
        let req07 =
            build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_wire_protocol);
        trace.push("V3HubReqOutbound07ProviderSemantic");
        let target = provider_target(manifest, req07.selected_target(), None)?;
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
                V3ProviderActionRecoveryTransition::Consumed(_) => {
                    pending_provider_action_recovery = None;
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateConsumedReevaluation");
                    continue;
                }
            }
        }
        if let Err(timing_error) = runtime_timing.start_external() {
            return Err(V3AnthropicRelayRuntimeError::Target(timing_error));
        }
        let transport_result = match tokio::time::timeout(
            V3_RELAY_TRANSPORT_RESPONSE_TIMEOUT,
            transport.send(transport_request),
        )
        .await
        {
            Err(_) => Err(V3ProviderError::Transport {
                request_id: input.request_id.clone(),
                provider_id: selected_target_provider_id.clone(),
                reason: "provider transport did not return response headers within timeout"
                    .to_string(),
            }),
            Ok(result) => result,
        };
        let provider_raw = match transport_result {
            Ok(raw) => raw,
            Err(V3ProviderError::HttpStatus { response }) => {
                let failure = provider_http_failure(
                    response.status,
                    &response.body,
                    &selected_target_provider_id,
                );
                let _ = runtime_timing.finish_external();
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
                let _ = runtime_timing.finish_external();
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
        if let Err(timing_error) = runtime_timing.finish_external() {
            return Err(V3AnthropicRelayRuntimeError::Target(timing_error));
        }
        let provider_status = provider_raw.status();
        match provider_raw.into_body() {
            V3ProviderResponseBody::Sse(stream) => {
                let chunks = match collect_v3_anthropic_relay_provider_sse_chunks(
                    crate::hub_v1::relay_runtime_core::guard_v3_provider_sse_idle(
                        &input.request_id,
                        &selected_target_provider_id,
                        stream,
                        crate::hub_v1::relay_runtime_core::V3_RELAY_SSE_STREAM_IDLE_TIMEOUT,
                    ),
                )
                .await
                {
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
                            // 治理层拦截（web_search Mode B 已剥离但 chat 类入口
                            // 无投影路径）：不是 provider 响应失败，禁止进入
                            // provider failure 重试/降级链，直接 fail-fast。
                            if let V3AnthropicRelayRuntimeError::WebSearchInterceptedUnprojected =
                                &error
                            {
                                return Err(error);
                            }
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
                let mut observability =
                    crate::hub_v1::relay_runtime_shared::build_v3_relay_observability(
                        "anthropic",
                        &selected,
                        if transport_intent == V3HubTransportIntent::Sse {
                            "sse"
                        } else {
                            "json"
                        },
                    );
                observability.provider_status = Some(provider_status);
                observability.response_status = Some("completed".to_string());
                observability.finish_reason = read_v3_runtime_finish_reason(&client_response)
                    .or_else(|| extract_v3_anthropic_relay_finish_reason(&client_response));
                observability.usage = extract_v3_anthropic_relay_usage_summary(&client_response);
                observability.timing =
                    Some(runtime_timing.finish_runtime().map_err(|timing_error| {
                        V3AnthropicRelayRuntimeError::Target(timing_error)
                    })?);
                return Ok(V3AnthropicRelayRuntimeOutput {
                    status: 200,
                    client_response,
                    node_trace: trace,
                    error_chain: None,
                    servertool_followup_required,
                    observability: Some(observability),
                    stream_observation: None,
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
                            // 治理层拦截（web_search Mode B 已剥离但 chat 类入口
                            // 无投影路径）：不是 provider 响应失败，禁止进入
                            // provider failure 重试/降级链，直接 fail-fast。
                            if let V3AnthropicRelayRuntimeError::WebSearchInterceptedUnprojected =
                                &error
                            {
                                return Err(error);
                            }
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
                let mut observability =
                    crate::hub_v1::relay_runtime_shared::build_v3_relay_observability(
                        "anthropic",
                        &selected,
                        if transport_intent == V3HubTransportIntent::Sse {
                            "sse"
                        } else {
                            "json"
                        },
                    );
                observability.provider_status = Some(provider_status);
                observability.response_status = Some("completed".to_string());
                observability.finish_reason = read_v3_runtime_finish_reason(&client_response)
                    .or_else(|| extract_v3_anthropic_relay_finish_reason(&client_response));
                observability.usage = extract_v3_anthropic_relay_usage_summary(&client_response);
                observability.timing =
                    Some(runtime_timing.finish_runtime().map_err(|timing_error| {
                        V3AnthropicRelayRuntimeError::Target(timing_error)
                    })?);
                return Ok(V3AnthropicRelayRuntimeOutput {
                    status: 200,
                    client_response,
                    node_trace: trace,
                    error_chain: None,
                    servertool_followup_required,
                    observability: Some(observability),
                    stream_observation: None,
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
    let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat)
        .map_err(|error| V3AnthropicRelayRuntimeError::Target(error))?;
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
    // 在 resp02 被 govern move 前克隆归一化 payload（含原始 tool_use——
    // Mode B hosted web_search 透传分支需要未剥离的 web_search tool_use）。
    let resp02_payload = resp02.provider_raw().payload.0.clone();
    let resp03 = hooks.govern(resp02, response_hook_profile)?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp04 = hooks.commit(resp03)?;
    trace.push("V3HubRespContinuation04Committed");
    let servertool_followup_required =
        resp04.previous.servertool_action() == V3HubServertoolResponseAction::FollowupRequired;
    // Mode B 拦截：websearch call 已由 Resp03 剥离（web_search_transition 存在）。
    // 区分两种形状：
    // - hosted `web_search`（anthropic wire server tool `web_search_20250305`，
    //   模型调用 name=web_search）——标准 Anthropic 工具调用协议，透传 tool_use
    //   给客户端（claude code 等）执行搜索并回传结果；
    // - 本地 `websearch`（function name=websearch，无客户端投影路径）——
    //   禁止静默剥离，fail-fast。
    if resp04.web_search_transition().is_some() {
        // 区分两种形状：
        // - hosted `web_search`（anthropic wire server tool `web_search_20250305`，
        //   模型调用 name=web_search）——标准 Anthropic 工具调用协议，透传 tool_use
        //   给客户端（claude code 等）执行搜索并回传结果；
        // - 本地 `websearch`（function name=websearch，无客户端投影路径）——
        //   禁止静默剥离，fail-fast。
        let is_hosted_web_search = first_local_websearch_tool_call(&resp02_payload)?
            .as_ref()
            .is_some_and(|call| call.name.eq_ignore_ascii_case("web_search"));
        if !is_hosted_web_search {
            return Err(V3AnthropicRelayRuntimeError::WebSearchInterceptedUnprojected);
        }
        let client_payload = project_client_response(resp02_payload.as_ref())?;
        return Ok((client_payload, servertool_followup_required));
    }
    commit_or_release_local_continuation(
        local,
        requested_local_ids,
        resp04.finalized_payload(),
        resp04.action(),
    )?;
    let client_payload = project_client_response(resp04.finalized_payload())?;
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload(
        resp04.into_data(),
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
    let canonical_context =
        build_v3_relay_local_response_continuation_context_at_resp04(canonical_response)?;
    for context_id in context_ids {
        store.commit_at_resp04(V3LocalContinuationResp04SaveInput::new(
            context_id,
            local.scope.local_key(),
            canonical_context.clone(),
            V3LocalContinuationTerminalOutcome::NonTerminal,
            local.now_epoch_ms,
            expires_at_epoch_ms,
        ))?;
    }
    Ok(())
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

// Anthropic relay 失败投影与 usage/finish_reason 提取 helper 保持文件尺寸
// 门限（v3.module_decomposition <=1500）：逻辑仍属于 anthropic relay runtime
// owner，include! 到同一模块，无独立模块边界。
include!("anthropic_relay_runtime_helpers.rs");
