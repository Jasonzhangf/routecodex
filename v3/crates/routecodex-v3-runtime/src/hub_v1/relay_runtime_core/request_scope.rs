/// Adapter-facing origin. Runtime selects the invocation origin from this
/// typed entry, never from business payload shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum V3RelayEntryOrigin {
    ClientEntry,
    DirectRelayHandoff,
}

impl V3RelayEntryOrigin {
    pub(crate) fn request_origin_kind(self) -> RequestOriginKind {
        match self {
            Self::ClientEntry => RequestOriginKind::ClientEntry,
            Self::DirectRelayHandoff => RequestOriginKind::DirectRelayHandoff,
        }
    }
}

/// The request entry owns normalization origin and captured-target reuse.
/// Direct moves its selected target and candidates to this shared scope.
pub struct V3RelayRuntimeEntry {
    pub(crate) origin: V3RelayEntryOrigin,
    pub(crate) selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    pub(crate) expanded: Option<routecodex_v3_target::V3Target09CandidateSetExpanded>,
    pub(crate) request_local_excluded_candidates: BTreeSet<String>,
    pub(crate) observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
}

impl V3RelayRuntimeEntry {
    pub fn client_entry() -> Self {
        Self {
            origin: V3RelayEntryOrigin::ClientEntry,
            selected_target: None,
            expanded: None,
            request_local_excluded_candidates: BTreeSet::new(),
            observability_accumulator: None,
        }
    }

    pub fn direct_relay_handoff(
        selected_target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
        expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
        request_local_excluded_candidates: BTreeSet<String>,
        observability_accumulator: V3RuntimeObservabilityAccumulator,
    ) -> Self {
        Self {
            origin: V3RelayEntryOrigin::DirectRelayHandoff,
            selected_target: Some(selected_target),
            expanded: Some(expanded),
            request_local_excluded_candidates,
            observability_accumulator: Some(observability_accumulator),
        }
    }
}

/// relay 统一主循环骨架。
///
/// 生命周期（VR 重试 loop / provider action recovery / 错误策略循环）只在本函数；
/// 骨架上的逻辑（共享辅助、codec 方法）不持有生命周期。
pub async fn execute_v3_relay_runtime_core<C, T>(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    failure_session_scope: V3ProviderFailureSessionScope,
    request_id: &str,
    endpoint_path: &str,
    execution_mode: V3HubExecutionMode,
    payload: Value,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3RelayProviderFailureRetryPolicy,
    provider_header_overrides: Vec<V3ProviderRequestHeader>,
    allow_exhaustion_rescue_probe: bool,
    entry: V3RelayRuntimeEntry,
    initial_request_execution_control: Option<V3RequestExecutionControl>,
    route_policy_pending: Option<crate::route_policy::V3RoutePolicyPendingGuard>,
) -> Result<C::Output, V3RelayCoreError>
where
    C: V3RelayProtocolCodec,
    T: ResponsesTransport,
{
    // REQ02 request scope is created at the first real request identity, before
    // any request normalization or planning, and travels with this future.
    let request_execution_control = match initial_request_execution_control {
        Some(control) => control,
        None => V3RequestExecutionControl::new(
            manifest,
            server_id,
            request_id,
            match C::ENTRY_PROTOCOL {
                V3HubEntryProtocol::Responses => "responses",
                V3HubEntryProtocol::Anthropic => "anthropic",
                V3HubEntryProtocol::Gemini => "gemini",
                V3HubEntryProtocol::OpenAiChat => "openai_chat",
            },
        )
        .map_err(|error| {
            V3RelayCoreError::Target(format!(
                "V3ExecutionAttemptBudget rejected relay request: {error}"
            ))
        })?,
    };
    let finalizer = request_execution_control
        .take_request_finalizer()
        .map_err(|error| {
            V3RelayCoreError::Target(format!(
                "V3ExecutionAttemptBudget rejected relay request: {error}"
            ))
        })?;
    let output = execute_v3_relay_runtime_resident::<C, T>(
        manifest,
        server_id,
        failure_session_scope,
        request_id,
        endpoint_path,
        execution_mode,
        payload,
        transport,
        provider_health,
        retry_policy,
        provider_header_overrides,
        allow_exhaustion_rescue_probe,
        entry,
        request_execution_control,
        route_policy_pending,
    )
    .await?;
    Ok(C::finish_request_scope(output, finalizer))
}
