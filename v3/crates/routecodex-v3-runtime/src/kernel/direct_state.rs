use std::sync::atomic::{AtomicU8, Ordering};

/// Facts the Direct execution hands to the bounded refill decision.
///
/// The tool-call list comes from the single shared structural extractor in the
/// Chat Process owner. `has_source_summary` is captured from the raw provider
/// attempt (JSON snapshot or raw SSE frames) before any RCC synthesis.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct V3ResponsesDirectRefillFacts {
    pub(crate) tool_calls: Vec<crate::hub_v1::V3HubResponseToolCall>,
    pub(crate) has_source_summary: bool,
    pub(crate) response_completed: bool,
}

/// Internal per-execution signal used by the Direct bounded refill loop.
///
/// Mirrors the Relay refill signal: it carries only the Chat Process
/// disposition and is never projected into a business payload. The Direct
/// output struct stays unchanged so its many construction sites keep working.
#[derive(Clone, Default)]
pub(crate) struct V3ResponsesDirectRefillSignal {
    value: std::sync::Arc<AtomicU8>,
}

impl V3ResponsesDirectRefillSignal {
    const NONE: u8 = 0;
    const DELIVER: u8 = 1;
    const REQUEST_REFILL: u8 = 2;

    pub(crate) fn set(&self, disposition: crate::hub_v1::V3ChatProcessRefillDisposition) {
        let value = match disposition {
            crate::hub_v1::V3ChatProcessRefillDisposition::Deliver => Self::DELIVER,
            crate::hub_v1::V3ChatProcessRefillDisposition::RequestRefill => Self::REQUEST_REFILL,
        };
        self.value.store(value, Ordering::Release);
    }

    pub(crate) fn take(&self) -> Option<crate::hub_v1::V3ChatProcessRefillDisposition> {
        match self.value.swap(Self::NONE, Ordering::AcqRel) {
            Self::DELIVER => Some(crate::hub_v1::V3ChatProcessRefillDisposition::Deliver),
            Self::REQUEST_REFILL => {
                Some(crate::hub_v1::V3ChatProcessRefillDisposition::RequestRefill)
            }
            _ => None,
        }
    }

    /// Publish the one shared disposition for this Direct execution.
    pub(crate) fn publish(
        &self,
        facts: &V3ResponsesDirectRefillFacts,
        refill_used: u32,
    ) -> crate::hub_v1::V3ChatProcessRefillDisposition {
        let disposition = crate::hub_v1::decide_v3_chat_process_refill(
            &facts.tool_calls,
            facts.has_source_summary,
            facts.response_completed,
            refill_used,
            crate::hub_v1::v3_chat_process_refill_max_consecutive(),
        );
        self.set(disposition);
        disposition
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum V3DirectDebugNodePublication {
    Runtime,
    ServerCloseout,
}

pub struct V3ResponsesDirectRuntimeSharedState {
    provider_health: V3ProviderFailureRuntimeHealth,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
    client_frame_sink: Option<crate::nodes::V3CommittedClientFrameSink>,
    debug_node_publication: V3DirectDebugNodePublication,
}

impl V3ResponsesDirectRuntimeSharedState {
    pub fn new<H>(provider_health: H) -> Self
    where
        H: Into<V3ProviderFailureRuntimeHealth>,
    {
        Self {
            provider_health: provider_health.into(),
            provider_failure_event_sink: None,
            route_selection_event_sink: None,
            client_frame_sink: None,
            debug_node_publication: V3DirectDebugNodePublication::Runtime,
        }
    }

    /// The Server composes nested protocol outcomes before publishing their
    /// execution nodes. Raw request/response capture remains owned by Debug.
    pub fn defer_debug_node_publication_to_server(mut self) -> Self {
        self.debug_node_publication = V3DirectDebugNodePublication::ServerCloseout;
        self
    }

    pub fn with_client_frame_sink(
        mut self,
        sink: Option<crate::nodes::V3CommittedClientFrameSink>,
    ) -> Self {
        self.client_frame_sink = sink;
        self
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
    initial_request_local_busy_candidates: BTreeSet<String>,
    initial_route_policy_scope: Option<crate::route_policy::V3RoutePolicyScope>,
    initial_route_policy_pending: Option<crate::route_policy::V3RoutePolicyPendingGuard>,
    observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
    request_execution_control: Option<V3RequestExecutionControl>,
    // Node trace the protocol plan already executed for this request; the
    // kernel splices it in instead of re-running Router05..Target09.
    initial_plan_trace: Option<Vec<&'static str>>,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
    client_frame_sink: Option<crate::nodes::V3CommittedClientFrameSink>,
}

impl V3ResponsesDirectRuntimeCoreState {
    fn new() -> Self {
        Self {
            now_epoch_ms: 0,
            provider_health: None,
            provider_health_neutral: false,
            allow_exhaustion_rescue_probe: true,
            initial_selected_target: None,
            initial_protocol_decision: None,
            initial_expanded: None,
            initial_request_local_excluded_candidates: BTreeSet::new(),
            initial_request_local_busy_candidates: BTreeSet::new(),
            initial_route_policy_scope: None,
            initial_route_policy_pending: None,
            observability_accumulator: None,
            request_execution_control: None,
            initial_plan_trace: None,
            provider_failure_event_sink: None,
            route_selection_event_sink: None,
            client_frame_sink: None,
        }
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
        self.initial_request_local_busy_candidates =
            plan.request_local_busy_candidates.clone();
        self.initial_route_policy_scope = plan._route_policy_scope.clone();
        self.initial_route_policy_pending = plan._route_policy_pending.clone();
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

    fn with_client_frame_sink(
        mut self,
        sink: Option<crate::nodes::V3CommittedClientFrameSink>,
    ) -> Self {
        self.client_frame_sink = sink;
        self
    }
}

#[derive(Debug)]
pub struct V3ResponsesDirectRuntimeOutput {
    pub client_payload: V3Resp15ClientPayload,
    pub terminal_disposition: Option<V3ProviderTerminalDisposition>,
    pub diagnostic_source: Option<routecodex_v3_error::V3Error01SourceRaised>,
    pub diagnostic_cause: Option<routecodex_v3_error::V3Error01SourceRaised>,
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
    pub request_local_busy_candidates: BTreeSet<String>,
    pub route_policy_pending: Option<crate::route_policy::V3RoutePolicyPendingGuard>,
    pub route_policy_scope: Option<crate::route_policy::V3RoutePolicyScope>,
    pub node_trace: Vec<&'static str>,
    pub provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
    pub observability_accumulator: V3RuntimeObservabilityAccumulator,
    pub request_execution_control: V3RequestExecutionControl,
}

impl V3ResponsesProtocolRelayHandoff {
    pub fn relay_runtime_seeds(&self) -> crate::V3ResponsesRelayRuntimeSeeds {
        crate::V3ResponsesRelayRuntimeSeeds {
            route_policy_pending: self.route_policy_pending.clone(),
            route_policy_scope: self.route_policy_scope.clone(),
            observability_accumulator: Some(self.observability_accumulator.clone()),
            request_execution_control: Some(self.request_execution_control.clone()),
            request_local_busy_candidates: self.request_local_busy_candidates.clone(),
            ..Default::default()
        }
    }
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
    pub request_local_busy_candidates: BTreeSet<String>,
    pub _route_policy_pending: Option<crate::route_policy::V3RoutePolicyPendingGuard>,
    pub _route_policy_scope: Option<crate::route_policy::V3RoutePolicyScope>,
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

    pub fn relay_runtime_seeds(&self) -> crate::V3ResponsesRelayRuntimeSeeds {
        crate::V3ResponsesRelayRuntimeSeeds {
            route_policy_pending: self._route_policy_pending.clone(),
            route_policy_scope: self._route_policy_scope.clone(),
            request_local_busy_candidates: self.request_local_busy_candidates.clone(),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone)]
pub struct V3ResponsesProtocolExecutionPlanFailure {
    pub source: V3Error01SourceRaised,
    pub node_trace: Vec<&'static str>,
    pub error_operator_fault: Option<crate::V3RelayErrorOperatorFault>,
}

pub(crate) fn protocol_plan_operator_fault(
    fault: crate::V3RelayErrorOperatorFault,
    node_trace: Vec<&'static str>,
) -> V3ResponsesProtocolExecutionPlanFailure {
    V3ResponsesProtocolExecutionPlanFailure {
        source: *fault.policy_failure.clone(),
        node_trace,
        error_operator_fault: Some(fault),
    }
}

pub fn project_v3_protocol_execution_plan_failure(
    failure: V3ResponsesProtocolExecutionPlanFailure,
) -> Result<V3Error06ClientProjected, crate::V3RelayErrorOperatorFault> {
    if let Some(fault) = failure.error_operator_fault {
        return Err(fault);
    }
    crate::provider_failure_runtime_policy::project_v3_relay_error_source(
        failure.source,
        V3ErrorActionScope::None,
        0,
        None,
    )
}
