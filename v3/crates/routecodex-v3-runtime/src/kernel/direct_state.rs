#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesDirectContinuationScope {
    key: V3RemoteContinuationScopeKey,
}

impl V3ResponsesDirectContinuationScope {
    pub fn responses(
        endpoint: impl Into<String>,
        session_id: impl Into<String>,
        conversation_id: impl Into<String>,
        port: u16,
        routing_group: impl Into<String>,
    ) -> Self {
        Self {
            key: V3RemoteContinuationScopeKey::responses(
                endpoint,
                session_id,
                conversation_id,
                port,
                routing_group,
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesDirectStoplessControlScope {
    key: V3RemoteContinuationScopeKey,
}

impl V3ResponsesDirectStoplessControlScope {
    pub fn responses(
        endpoint: impl Into<String>,
        session_id: impl Into<String>,
        conversation_id: impl Into<String>,
        port: u16,
        routing_group: impl Into<String>,
    ) -> Self {
        Self {
            key: V3RemoteContinuationScopeKey::responses(
                endpoint,
                session_id,
                conversation_id,
                port,
                routing_group,
            ),
        }
    }

    fn has_client_session_scope(&self) -> bool {
        let session_id = self.key.session_id.trim();
        let conversation_id = self.key.conversation_id.trim();
        if session_id.is_empty() || conversation_id.is_empty() {
            return false;
        }
        !(session_id == conversation_id && session_id.starts_with("request:"))
    }
}

impl From<&V3ResponsesDirectContinuationScope> for V3ResponsesDirectStoplessControlScope {
    fn from(scope: &V3ResponsesDirectContinuationScope) -> Self {
        Self {
            key: scope.key.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct V3ResponsesDirectStoplessControlKey {
    key: V3RemoteContinuationScopeKey,
}

impl From<&V3ResponsesDirectStoplessControlScope> for V3ResponsesDirectStoplessControlKey {
    fn from(scope: &V3ResponsesDirectStoplessControlScope) -> Self {
        Self {
            key: scope.key.clone(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct V3ResponsesDirectStoplessControlState {
    store: Arc<Mutex<BTreeMap<V3ResponsesDirectStoplessControlKey, V3StoplessCenterState>>>,
}

impl V3ResponsesDirectStoplessControlState {
    pub fn load_for_scope(
        &self,
        scope: &V3ResponsesDirectStoplessControlScope,
    ) -> Result<Option<V3StoplessCenterState>, String> {
        self.store
            .lock()
            .map_err(|error| error.to_string())
            .map(|store| {
                store
                    .get(&V3ResponsesDirectStoplessControlKey::from(scope))
                    .cloned()
            })
    }

    pub fn store_for_scope(
        &self,
        scope: &V3ResponsesDirectStoplessControlScope,
        state: V3StoplessCenterState,
    ) -> Result<(), String> {
        self.store
            .lock()
            .map_err(|error| error.to_string())?
            .insert(V3ResponsesDirectStoplessControlKey::from(scope), state);
        Ok(())
    }

    pub fn clear_for_scope(
        &self,
        scope: &V3ResponsesDirectStoplessControlScope,
    ) -> Result<(), String> {
        self.store
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&V3ResponsesDirectStoplessControlKey::from(scope));
        Ok(())
    }

    pub fn len(&self) -> Result<usize, String> {
        self.store
            .lock()
            .map(|store| store.len())
            .map_err(|error| error.to_string())
    }

    pub fn is_empty(&self) -> Result<bool, String> {
        self.len().map(|len| len == 0)
    }
}

#[derive(Debug, Clone, Default)]
pub struct V3ResponsesDirectContinuationState {
    store: Arc<Mutex<V3RemoteContinuationStore>>,
}

impl V3ResponsesDirectContinuationState {
    pub fn contains(&self, response_id: &str) -> Result<bool, String> {
        self.store
            .lock()
            .map(|store| store.contains(response_id))
            .map_err(|error| error.to_string())
    }

    pub fn contains_for_req03(
        &self,
        response_id: &str,
        scope: &V3ResponsesDirectContinuationScope,
        now_epoch_ms: u64,
    ) -> Result<bool, String> {
        self.store
            .lock()
            .map_err(|error| error.to_string())
            .and_then(
                |store| match store.load_for_req03(response_id, &scope.key, now_epoch_ms) {
                    Ok(_) => Ok(true),
                    Err(
                        crate::remote_continuation::V3RemoteContinuationError::NotFound { .. }
                        | crate::remote_continuation::V3RemoteContinuationError::ScopeMismatch {
                            ..
                        }
                        | crate::remote_continuation::V3RemoteContinuationError::Expired { .. },
                    ) => Ok(false),
                    Err(error) => Err(error.to_string()),
                },
            )
    }

    #[cfg(test)]
    pub(crate) fn commit_for_req03_test(
        &self,
        response_id: &str,
        scope: &V3ResponsesDirectContinuationScope,
        now_epoch_ms: u64,
    ) -> Result<(), String> {
        let locator = V3RemoteContinuationLocator::new_direct(
            response_id,
            scope.key.clone(),
            V3RemoteContinuationPin::new("direct-provider", "gpt-5.5", "key"),
            "test-capability-revision",
            now_epoch_ms,
            now_epoch_ms + REMOTE_CONTINUATION_TTL_MS,
        );
        self.store
            .lock()
            .map_err(|error| error.to_string())?
            .commit(V3RemoteContinuationCommitInput::locator_only(locator))
            .map_err(|error| error.to_string())
    }

    pub fn len(&self) -> Result<usize, String> {
        self.store
            .lock()
            .map(|store| store.len())
            .map_err(|error| error.to_string())
    }

    pub fn is_empty(&self) -> Result<bool, String> {
        self.len().map(|len| len == 0)
    }
}

pub struct V3ResponsesDirectRuntimeSharedState<'a> {
    pub continuation_state: &'a V3ResponsesDirectContinuationState,
    pub stopless_control: &'a V3ResponsesDirectStoplessControlState,
    provider_health: V3ProviderFailureRuntimeHealth,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
}

impl<'a> V3ResponsesDirectRuntimeSharedState<'a> {
    pub fn new<H>(
        continuation_state: &'a V3ResponsesDirectContinuationState,
        stopless_control: &'a V3ResponsesDirectStoplessControlState,
        provider_health: H,
    ) -> Self
    where
        H: Into<V3ProviderFailureRuntimeHealth>,
    {
        Self {
            continuation_state,
            stopless_control,
            provider_health: provider_health.into(),
            provider_failure_event_sink: None,
            route_selection_event_sink: None,
        }
    }

    pub fn with_provider_failure_event_sink(
        mut self,
        sink: Option<V3RuntimeProviderFailureEventSink>,
    ) -> Self {
        self.provider_failure_event_sink = sink;
        self
    }

    pub fn with_route_selection_event_sink(
        mut self,
        sink: Option<V3RuntimeRouteSelectionEventSink>,
    ) -> Self {
        self.route_selection_event_sink = sink;
        self
    }
}

#[derive(Clone)]
struct V3ResponsesDirectRuntimeCoreState<'a> {
    continuation_state: Option<&'a V3ResponsesDirectContinuationState>,
    continuation_scope: Option<V3ResponsesDirectContinuationScope>,
    stopless_control: Option<&'a V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<V3ResponsesDirectStoplessControlScope>,
    now_epoch_ms: u64,
    provider_health: Option<V3ProviderFailureRuntimeHealth>,
    provider_health_neutral: bool,
    initial_selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    // Candidate set from the Server-side protocol plan; always set together
    // with initial_selected_target so in-Target reselection keeps working
    // when routing was preplanned.
    initial_expanded: Option<routecodex_v3_target::V3Target09CandidateSetExpanded>,
    // Node trace the protocol plan already executed for this request; the
    // kernel splices it in instead of re-running Router05..Target09.
    initial_plan_trace: Option<Vec<&'static str>>,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
}

impl<'a> V3ResponsesDirectRuntimeCoreState<'a> {
    fn no_continuation() -> Self {
        Self {
            continuation_state: None,
            continuation_scope: None,
            stopless_control: None,
            stopless_scope: None,
            now_epoch_ms: 0,
            provider_health: None,
            provider_health_neutral: false,
            initial_selected_target: None,
            initial_expanded: None,
            initial_plan_trace: None,
            provider_failure_event_sink: None,
            route_selection_event_sink: None,
        }
    }

    fn with_continuation(
        state: &'a V3ResponsesDirectContinuationState,
        scope: V3ResponsesDirectContinuationScope,
        now_epoch_ms: u64,
    ) -> Self {
        Self {
            continuation_state: Some(state),
            continuation_scope: Some(scope),
            stopless_control: None,
            stopless_scope: None,
            now_epoch_ms,
            provider_health: None,
            provider_health_neutral: false,
            initial_selected_target: None,
            initial_expanded: None,
            initial_plan_trace: None,
            provider_failure_event_sink: None,
            route_selection_event_sink: None,
        }
    }

    fn with_stopless_control(
        mut self,
        stopless_control: &'a V3ResponsesDirectStoplessControlState,
        stopless_scope: V3ResponsesDirectStoplessControlScope,
    ) -> Self {
        self.stopless_control = Some(stopless_control);
        self.stopless_scope = Some(stopless_scope);
        self
    }

    fn with_provider_health(mut self, provider_health: V3ProviderFailureRuntimeHealth) -> Self {
        self.provider_health = Some(provider_health);
        self
    }

    fn with_provider_health_neutral(mut self) -> Self {
        self.provider_health_neutral = true;
        self
    }

    #[cfg(test)]
    fn with_now_epoch_ms(mut self, now_epoch_ms: u64) -> Self {
        self.now_epoch_ms = now_epoch_ms;
        self
    }

    fn with_provider_failure_event_sink(
        mut self,
        sink: Option<V3RuntimeProviderFailureEventSink>,
    ) -> Self {
        self.provider_failure_event_sink = sink;
        self
    }

    fn with_route_selection_event_sink(
        mut self,
        sink: Option<V3RuntimeRouteSelectionEventSink>,
    ) -> Self {
        self.route_selection_event_sink = sink;
        self
    }

    fn with_initial_plan(mut self, plan: &V3ResponsesProtocolExecutionPlan) -> Self {
        self.initial_selected_target = Some(plan.decision.target.clone());
        self.initial_expanded = Some(plan.expanded.clone());
        self.initial_plan_trace = Some(plan.routing_trace_segment());
        self
    }
}

#[derive(Debug)]
pub struct V3ResponsesDirectRuntimeOutput {
    pub client_payload: V3Resp15ClientPayload,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
    pub observability: Option<V3RuntimeObservability>,
    pub stream_observation: Option<V3RuntimeStreamObservation>,
    pub protocol_relay_handoff: Option<V3ResponsesProtocolRelayHandoff>,
}

#[derive(Debug, Clone)]
pub struct V3ResponsesProtocolRelayHandoff {
    pub target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    pub node_trace: Vec<&'static str>,
    pub provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
}

#[derive(Debug, Clone)]
pub struct V3ResponsesProtocolExecutionPlan {
    pub decision: V3Execution11ProtocolDecision,
    pub node_trace: Vec<&'static str>,
    // Candidate set expanded at Target09 during planning; carried so the
    // kernel can reselect inside the Target on provider failure without
    // re-entering the Router (Router re-entry after Target10 is forbidden).
    pub expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
}

impl V3ResponsesProtocolExecutionPlan {
    // Routing nodes the plan already executed between Req04 and Target10.
    // The kernel splices these into its trace when starting from this plan so
    // the client-visible node trace stays identical to the unplanned path.
    fn routing_trace_segment(&self) -> Vec<&'static str> {
        self.node_trace
            .iter()
            .skip_while(|node| **node != "V3Req04StandardizedResponses")
            .skip(1)
            .take_while(|node| **node != "V3Target10ConcreteProviderSelected")
            .copied()
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct V3ResponsesProtocolExecutionPlanFailure {
    pub source: V3Error01SourceRaised,
    pub node_trace: Vec<&'static str>,
}

pub fn project_v3_protocol_execution_plan_failure(
    failure: V3ResponsesProtocolExecutionPlanFailure,
) -> V3Error06ClientProjected {
    V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source: failure.source,
        action_scope: V3ErrorActionScope::None,
        candidates_remaining: 0,
        source_status: None,
    })
}
