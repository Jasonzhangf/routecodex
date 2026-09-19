use crate::hub_v1::{
    V3ServerToolCenter, V3ServerToolCenterKey, V3ServerToolInstanceState, V3ServerToolName,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesDirectServerToolScope {
    entry_endpoint: String,
    session_id: String,
    conversation_id: String,
    port: u16,
    routing_group: String,
}

impl V3ResponsesDirectServerToolScope {
    pub fn new(
        endpoint: impl Into<String>,
        session_id: impl Into<String>,
        conversation_id: impl Into<String>,
        port: u16,
        routing_group: impl Into<String>,
    ) -> Self {
        Self {
            entry_endpoint: endpoint.into(),
            session_id: session_id.into(),
            conversation_id: conversation_id.into(),
            port,
            routing_group: routing_group.into(),
        }
    }

    fn has_client_session_scope(&self) -> bool {
        let session_id = self.session_id.trim();
        let conversation_id = self.conversation_id.trim();
        if session_id.is_empty() || conversation_id.is_empty() {
            return false;
        }
        !(session_id == conversation_id && session_id.starts_with("request:"))
    }

    pub fn web_search_hook_scope(
        &self,
    ) -> servertool_core::web_search_contract::WebSearchHookScope {
        servertool_core::web_search_contract::WebSearchHookScope {
            entry_endpoint: self.entry_endpoint.clone(),
            session_id: self.session_id.clone(),
            conversation_id: self.conversation_id.clone(),
            port: self.port,
            routing_group: self.routing_group.clone(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct V3ResponsesDirectServerToolState {
    center: V3ServerToolCenter,
}

impl V3ResponsesDirectServerToolState {
    fn web_search_center_key(
        scope: &V3ResponsesDirectServerToolScope,
    ) -> V3ServerToolCenterKey {
        V3ServerToolCenterKey {
            tool_name: V3ServerToolName::WebSearch,
            scope_key: format!(
                "{:?}|{}|{}|{}|{}|{}",
                crate::hub_v1::V3HubEntryProtocol::Responses,
                scope.entry_endpoint,
                scope.port,
                scope.routing_group,
                scope.session_id,
                scope.conversation_id
            ),
        }
    }

    pub fn web_search_load_for_scope(
        &self,
        scope: &V3ResponsesDirectServerToolScope,
    ) -> Result<Option<V3WebSearchCenterState>, String> {
        match self
            .center
            .load(&Self::web_search_center_key(scope))
            .map_err(|error| error.to_string())?
        {
            Some(V3ServerToolInstanceState::WebSearch(state)) => Ok(Some(state)),
            Some(_) => Err("cross-tool direct web search load rejected".to_string()),
            None => Ok(None),
        }
    }

    pub fn web_search_store_for_scope(
        &self,
        scope: &V3ResponsesDirectServerToolScope,
        state: V3WebSearchCenterState,
        written_by: V3ServerToolCenterWriteOrigin,
        reason: Option<&str>,
        request_id: Option<&str>,
    ) -> Result<(), String> {
        self.center
            .store(
                Self::web_search_center_key(scope),
                V3ServerToolInstanceState::WebSearch(state),
                written_by,
                reason,
                request_id,
            )
            .map_err(|error| error.to_string())
    }

    pub fn web_search_clear_for_scope(
        &self,
        scope: &V3ResponsesDirectServerToolScope,
        written_by: V3ServerToolCenterWriteOrigin,
        reason: Option<&str>,
        request_id: Option<&str>,
    ) -> Result<(), String> {
        self.center
            .clear(
                &Self::web_search_center_key(scope),
                written_by,
                reason,
                request_id,
            )
            .map_err(|error| error.to_string())
    }

    pub fn len(&self) -> Result<usize, String> {
        self.center.len().map_err(|error| error.to_string())
    }

    pub fn is_empty(&self) -> Result<bool, String> {
        self.center.is_empty().map_err(|error| error.to_string())
    }
}

pub struct V3ResponsesDirectRuntimeSharedState<'a> {
    pub server_tool_state: &'a V3ResponsesDirectServerToolState,
    provider_health: V3ProviderFailureRuntimeHealth,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
}

impl<'a> V3ResponsesDirectRuntimeSharedState<'a> {
    pub fn new<H>(
        server_tool_state: &'a V3ResponsesDirectServerToolState,
        provider_health: H,
    ) -> Self
    where
        H: Into<V3ProviderFailureRuntimeHealth>,
    {
        Self {
            server_tool_state,
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
struct V3ResponsesDirectRuntimeCoreState {
    server_tool_state: Option<Arc<V3ResponsesDirectServerToolState>>,
    server_tool_scope: Option<V3ResponsesDirectServerToolScope>,
    now_epoch_ms: u64,
    provider_health: Option<V3ProviderFailureRuntimeHealth>,
    provider_health_neutral: bool,
    allow_exhaustion_rescue_probe: bool,
    initial_selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    initial_protocol_decision: Option<V3Execution11ProtocolDecision>,
    // Candidate set from the Server-side protocol plan; always set together
    // with initial_selected_target so in-Target reselection keeps working
    // when routing was preplanned.
    initial_expanded: Option<routecodex_v3_target::V3Target09CandidateSetExpanded>,
    initial_request_local_excluded_candidates: BTreeSet<String>,
    observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
    request_execution_control: Option<V3RequestExecutionControl>,
    // Node trace the protocol plan already executed for this request; the
    // kernel splices it in instead of re-running Router05..Target09.
    initial_plan_trace: Option<Vec<&'static str>>,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
}

impl V3ResponsesDirectRuntimeCoreState {
    fn new() -> Self {
        Self {
            server_tool_state: None,
            server_tool_scope: None,
            now_epoch_ms: 0,
            provider_health: None,
            provider_health_neutral: false,
            allow_exhaustion_rescue_probe: true,
            initial_selected_target: None,
            initial_protocol_decision: None,
            initial_expanded: None,
            initial_request_local_excluded_candidates: BTreeSet::new(),
            observability_accumulator: None,
            request_execution_control: None,
            initial_plan_trace: None,
            provider_failure_event_sink: None,
            route_selection_event_sink: None,
        }
    }

    fn with_server_tool_state(
        mut self,
        server_tool_state: &V3ResponsesDirectServerToolState,
        server_tool_scope: V3ResponsesDirectServerToolScope,
    ) -> Self {
        self.server_tool_state = Some(Arc::new(server_tool_state.clone()));
        self.server_tool_scope = Some(server_tool_scope);
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

    fn with_exhaustion_rescue_probe_disabled(mut self) -> Self {
        self.allow_exhaustion_rescue_probe = false;
        self
    }

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
        self.initial_protocol_decision = Some(plan.decision.clone());
        self.initial_expanded = Some(plan.expanded.clone());
        self.initial_request_local_excluded_candidates =
            plan.request_local_excluded_candidates.clone();
        self.initial_plan_trace = Some(plan.routing_trace_segment());
        self
    }

    fn with_observability_accumulator(
        mut self,
        accumulator: Option<V3RuntimeObservabilityAccumulator>,
    ) -> Self {
        self.observability_accumulator = accumulator;
        self
    }

    fn with_request_execution_control(
        mut self,
        control: Option<V3RequestExecutionControl>,
    ) -> Self {
        self.request_execution_control = control;
        self
    }
}

#[derive(Debug)]
pub struct V3ResponsesDirectRuntimeOutput {
    pub client_payload: V3Resp15ClientPayload,
    pub provider_request_snapshot: Option<serde_json::Value>,
    pub provider_response_snapshot: Option<serde_json::Value>,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
    pub observability: Option<V3RuntimeObservability>,
    pub stream_observation: Option<V3RuntimeStreamObservation>,
    pub protocol_relay_handoff: Option<V3ResponsesProtocolRelayHandoff>,
}

#[derive(Debug)]
pub struct V3ResponsesProtocolRelayHandoff {
    pub target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    pub expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
    pub request_local_excluded_candidates: BTreeSet<String>,
    pub node_trace: Vec<&'static str>,
    pub provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
    pub observability_accumulator: V3RuntimeObservabilityAccumulator,
    pub request_execution_control: V3RequestExecutionControl,
}

#[derive(Debug, Clone)]
pub struct V3ResponsesProtocolExecutionPlan {
    pub decision: V3Execution11ProtocolDecision,
    pub node_trace: Vec<&'static str>,
    // Candidate set expanded at Target09 during planning; carried so the
    // kernel can reselect inside the Target on provider failure without
    // re-entering the Router (Router re-entry after Target10 is forbidden).
    pub expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
    // Candidate keys whose protocol decision matches the initial `decision.mode`;
    // initial Relay entry may use this as an admission set, but provider-failure
    // reselection must not treat it as a Direct/Relay protocol lock.
    pub protocol_candidate_keys: BTreeSet<String>,
    // Request-local candidates already failed before this plan/handoff was
    // consumed. This keeps Direct/Relay handoffs on one Error01-06 attempt set
    // without storing control state in the normal request payload.
    pub request_local_excluded_candidates: BTreeSet<String>,
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
