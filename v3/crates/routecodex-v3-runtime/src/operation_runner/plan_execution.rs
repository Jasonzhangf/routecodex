use super::{run_v3_single_node_operator, OperationRunnerError, V3OperationGraph};
use crate::hub_v1::{V3HubEntryProtocol, V3HubExecutionMode};
use crate::nodes::V3Execution11ProtocolDecisionMode;
use crate::provider_failure_runtime_policy::{
    expand_v3_relay_target_candidates_from_opaque_hit, select_v3_target_with_session_then_global,
    step_v3_target_selection_sync, V3ProviderFailureRuntimeHealth,
    V3SynchronousTargetSelectionStep, V3SynchronousTargetPlanningInput,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_provider_responses::V3ProviderAvailabilityReader;
use routecodex_v3_target::{
    V3Target09CandidateSetExpanded, V3Target10ConcreteProviderSelected, V3TargetExhaustion,
    V3TargetInterpreter,
};
use routecodex_v3_virtual_router::V3Router07OpaqueTargetHitOnce;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.operation.plan_execution";
const OPERATOR_VERSION: &str = "1";

#[derive(Clone)]
pub(crate) enum V3PlanExecutionTargetSource {
    OpaqueHit(V3Router07OpaqueTargetHitOnce),
    Expanded(V3Target09CandidateSetExpanded),
}

#[derive(Clone)]
pub(crate) enum V3PlanExecutionModePolicy {
    RelayOnly {
        entry_protocol: V3HubEntryProtocol,
    },
    DirectEntry {
        entry_protocol: V3HubEntryProtocol,
        allowed_modes: Vec<String>,
    },
}

#[derive(Clone, Copy)]
enum V3PlanExecutionPhase {
    AdmitAtExecution,
    PreplanWithoutAdmission,
}

pub(crate) struct V3PlanExecutionCompleted {
    pub(crate) expanded: V3Target09CandidateSetExpanded,
    pub(crate) selected: V3Target10ConcreteProviderSelected,
    pub(crate) request_local_excluded_candidates: BTreeSet<String>,
    pub(crate) request_local_busy_candidates: BTreeSet<String>,
    pub(crate) execution_mode: V3HubExecutionMode,
    pub(crate) protocol_decision: crate::nodes::V3Execution11ProtocolDecision,
}

pub(crate) enum V3PlanExecutionStop {
    Exhausted {
        expanded: V3Target09CandidateSetExpanded,
        exhaustion: V3TargetExhaustion,
        source: Option<V3Error01SourceRaised>,
    },
    Failed(V3Error01SourceRaised),
    OperatorFault(crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault),
}

pub(crate) enum V3PlanExecutionOutcome {
    Selected {
        execution_planned_request: Value,
        plan: V3PlanExecutionCompleted,
    },
    Exhausted {
        expanded: V3Target09CandidateSetExpanded,
        exhaustion: V3TargetExhaustion,
        source: Option<V3Error01SourceRaised>,
        request_local_excluded_candidates: BTreeSet<String>,
        request_local_busy_candidates: BTreeSet<String>,
    },
    Failed(V3Error01SourceRaised),
    OperatorFault(crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault),
}

enum PlanExecutionOperatorOutput {
    Preplanned {
        expanded: V3Target09CandidateSetExpanded,
        decision: crate::nodes::V3Execution11ProtocolDecision,
        request_local_excluded_candidates: BTreeSet<String>,
    },
    Selected {
        expanded: V3Target09CandidateSetExpanded,
        decision: crate::nodes::V3Execution11ProtocolDecision,
        request_local_excluded_candidates: BTreeSet<String>,
        request_local_busy_candidates: BTreeSet<String>,
    },
    Exhausted {
        expanded: V3Target09CandidateSetExpanded,
        exhaustion: V3TargetExhaustion,
        source: Option<V3Error01SourceRaised>,
        request_local_excluded_candidates: BTreeSet<String>,
        request_local_busy_candidates: BTreeSet<String>,
    },
    Failed(V3Error01SourceRaised),
    OperatorFault(crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault),
}

struct PlanExecutionOperator {
    phase: V3PlanExecutionPhase,
    manifest: V3Config05ManifestPublished,
    target_source: V3PlanExecutionTargetSource,
    failure_session_scope: V3ProviderFailureSessionScope,
    provider_health: V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: BTreeSet<String>,
    request_local_busy_candidates: BTreeSet<String>,
    now_ms: u64,
    deterministic_sample: u64,
    preferred_selected: Option<V3Target10ConcreteProviderSelected>,
    mode_policy: V3PlanExecutionModePolicy,
    side_output: Arc<Mutex<Option<PlanExecutionOperatorOutput>>>,
}

impl PlanExecutionOperator {
    fn new(
        phase: V3PlanExecutionPhase,
        manifest: V3Config05ManifestPublished,
        target_source: V3PlanExecutionTargetSource,
        failure_session_scope: V3ProviderFailureSessionScope,
        provider_health: V3ProviderFailureRuntimeHealth,
        request_local_excluded_candidates: BTreeSet<String>,
        request_local_busy_candidates: BTreeSet<String>,
        now_ms: u64,
        deterministic_sample: u64,
        preferred_selected: Option<V3Target10ConcreteProviderSelected>,
        mode_policy: V3PlanExecutionModePolicy,
        side_output: Arc<Mutex<Option<PlanExecutionOperatorOutput>>>,
    ) -> Self {
        Self {
            phase,
            manifest,
            target_source,
            failure_session_scope,
            provider_health,
            request_local_excluded_candidates,
            request_local_busy_candidates,
            now_ms,
            deterministic_sample,
            preferred_selected,
            mode_policy,
            side_output,
        }
    }

    fn decide_execution_mode(
        &self,
        selected: V3Target10ConcreteProviderSelected,
    ) -> crate::shared::V3DirectSourceResult<crate::nodes::V3Execution11ProtocolDecision> {
        let (entry_protocol, allowed_modes) = match &self.mode_policy {
            V3PlanExecutionModePolicy::RelayOnly { entry_protocol } => {
                (*entry_protocol, vec!["relay".to_string()])
            }
            V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol,
                allowed_modes,
            } => (*entry_protocol, allowed_modes.clone()),
        };
        let entry_protocol = match entry_protocol {
            V3HubEntryProtocol::Responses => "responses",
            V3HubEntryProtocol::Anthropic => "anthropic_messages",
            V3HubEntryProtocol::Gemini => "gemini",
            V3HubEntryProtocol::OpenAiChat => "openai_chat",
        };
        crate::nodes::build_v3_execution_11_protocol_decision_from_v3_target_10(
            selected,
            entry_protocol,
            &allowed_modes,
        )
        .map_err(crate::nodes::raise_v3_execution_11_protocol_decision_failure)
    }

    fn execute_plan(&self) -> PlanExecutionOperatorOutput {
        let expanded = match &self.target_source {
            V3PlanExecutionTargetSource::Expanded(expanded) => expanded.clone(),
            V3PlanExecutionTargetSource::OpaqueHit(hit) => {
                match expand_v3_relay_target_candidates_from_opaque_hit(
                    &self.manifest,
                    hit.clone(),
                    self.deterministic_sample,
                ) {
                    Ok(expanded) => expanded,
                    Err(Ok(source)) => return PlanExecutionOperatorOutput::Failed(source),
                    Err(Err(fault)) => return PlanExecutionOperatorOutput::OperatorFault(fault),
                }
            }
        };
        if matches!(self.phase, V3PlanExecutionPhase::PreplanWithoutAdmission) {
            let selected = match select_v3_target_with_session_then_global(
                &routecodex_v3_target::V3TargetInterpreter::default(),
                expanded.clone(),
                &self.failure_session_scope,
                &self
                    .provider_health
                    .session_bound_availability(&self.failure_session_scope),
                &self.provider_health,
                &self.request_local_excluded_candidates,
                self.now_ms,
                self.deterministic_sample,
            ) {
                Ok(selected) => selected,
                Err(routecodex_v3_target::V3TargetSelectionError::Exhausted(exhaustion)) => {
                    return PlanExecutionOperatorOutput::Exhausted {
                        expanded,
                        exhaustion,
                        source: None,
                        request_local_excluded_candidates: self
                            .request_local_excluded_candidates
                            .clone(),
                        request_local_busy_candidates: self.request_local_busy_candidates.clone(),
                    }
                }
                Err(error @ routecodex_v3_target::V3TargetSelectionError::Health { .. }) => {
                    return PlanExecutionOperatorOutput::Failed(build_v3_error_01_source_raised(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3ProviderHealthRead",
                        "provider_health_read_failed",
                        error.to_string(),
                    ));
                }
            };
            return match self.decide_execution_mode(selected) {
                Ok(decision) => PlanExecutionOperatorOutput::Preplanned {
                    expanded,
                    decision,
                    request_local_excluded_candidates: self
                        .request_local_excluded_candidates
                        .clone(),
                },
                Err(Ok(source)) => PlanExecutionOperatorOutput::Failed(source),
                Err(Err(fault)) => PlanExecutionOperatorOutput::OperatorFault(fault),
            };
        }
        let step = step_v3_target_selection_sync(V3SynchronousTargetPlanningInput {
            expanded: expanded.clone(),
            failure_session_scope: &self.failure_session_scope,
            provider_health: &self.provider_health,
            request_local_excluded_candidates: &self.request_local_excluded_candidates,
            request_local_busy_candidates: &self.request_local_busy_candidates,
            now_ms: self.now_ms,
            deterministic_sample: self.deterministic_sample,
            preferred_selected: self.preferred_selected.clone(),
        });
        match step {
            V3SynchronousTargetSelectionStep::Selected {
                selected,
                request_local_excluded_candidates,
                request_local_busy_candidates,
            } => match self.decide_execution_mode(selected) {
                Ok(decision) => PlanExecutionOperatorOutput::Selected {
                    expanded,
                    decision,
                    request_local_excluded_candidates,
                    request_local_busy_candidates,
                },
                Err(Ok(source)) => PlanExecutionOperatorOutput::Failed(source),
                Err(Err(fault)) => PlanExecutionOperatorOutput::OperatorFault(fault),
            },
            V3SynchronousTargetSelectionStep::Exhausted {
                exhaustion,
                source,
                request_local_excluded_candidates,
                request_local_busy_candidates,
            } => PlanExecutionOperatorOutput::Exhausted {
                expanded,
                exhaustion,
                source,
                request_local_excluded_candidates,
                request_local_busy_candidates,
            },
            V3SynchronousTargetSelectionStep::Failed(source) => PlanExecutionOperatorOutput::Failed(source),
        }
    }
}

impl Operator for PlanExecutionOperator {
    fn name(&self) -> &'static str {
        OPERATOR_NAME
    }

    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let output = self.execute_plan();
        let failure = match &output {
            PlanExecutionOperatorOutput::Failed(source) => Some(source.message.clone()),
            PlanExecutionOperatorOutput::OperatorFault(fault) => {
                Some(fault.policy_failure.message.clone())
            }
            _ => None,
        };
        let mut holder = self
            .side_output
            .lock()
            .map_err(|_| "plan_execution typed side-output holder is poisoned".to_string())?;
        *holder = Some(output);
        match failure {
            Some(message) => Err(message),
            None => Ok(input),
        }
    }
}

pub(crate) fn run_v3_plan_execution_operator(
    target_resolved_request: Value,
    manifest: V3Config05ManifestPublished,
    target_source: V3PlanExecutionTargetSource,
    failure_session_scope: V3ProviderFailureSessionScope,
    provider_health: V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: BTreeSet<String>,
    request_local_busy_candidates: BTreeSet<String>,
    now_ms: u64,
    deterministic_sample: u64,
    preferred_selected: Option<V3Target10ConcreteProviderSelected>,
    mode_policy: V3PlanExecutionModePolicy,
) -> Result<V3PlanExecutionOutcome, OperationRunnerError> {
    let side_output = Arc::new(Mutex::new(None));
    let operator = PlanExecutionOperator::new(
        V3PlanExecutionPhase::AdmitAtExecution,
        manifest,
        target_source,
        failure_session_scope,
        provider_health,
        request_local_excluded_candidates,
        request_local_busy_candidates,
        now_ms,
        deterministic_sample,
        preferred_selected,
        mode_policy,
        side_output.clone(),
    );
    let runner_result = run_v3_single_node_operator(
        V3OperationGraph::Request,
        "plan_execution",
        target_resolved_request,
        operator,
    );
    let output = side_output
        .lock()
        .map_err(|_| {
            OperationRunnerError::new("plan_execution typed side-output holder is poisoned")
        })?
        .take();
    match output {
        Some(PlanExecutionOperatorOutput::Failed(source)) => {
            return Ok(V3PlanExecutionOutcome::Failed(source))
        }
        Some(PlanExecutionOperatorOutput::OperatorFault(fault)) => {
            return Ok(V3PlanExecutionOutcome::OperatorFault(fault))
        }
        output => {
            let output = output.ok_or_else(|| {
                OperationRunnerError::new("plan_execution operator omitted typed side output")
            })?;
            let execution_planned_request = runner_result?;
            Ok(match output {
                PlanExecutionOperatorOutput::Preplanned { .. } => {
                    return Err(OperationRunnerError::new(
                        "admitting plan_execution operator returned a preplanned output",
                    ))
                }
                PlanExecutionOperatorOutput::Selected {
                    expanded,
                    decision,
                    request_local_excluded_candidates,
                    request_local_busy_candidates,
                } => V3PlanExecutionOutcome::Selected {
                    execution_planned_request,
                    plan: V3PlanExecutionCompleted {
                        expanded,
                        selected: decision.target.clone(),
                        request_local_excluded_candidates,
                        request_local_busy_candidates,
                        execution_mode: match decision.mode {
                            V3Execution11ProtocolDecisionMode::SameProtocolDirect => {
                                V3HubExecutionMode::Direct
                            }
                            V3Execution11ProtocolDecisionMode::HubRelay => {
                                V3HubExecutionMode::Relay
                            }
                        },
                        protocol_decision: decision,
                    },
                },
                PlanExecutionOperatorOutput::Exhausted {
                    expanded,
                    exhaustion,
                    source,
                    request_local_excluded_candidates,
                    request_local_busy_candidates,
                } => V3PlanExecutionOutcome::Exhausted {
                    expanded,
                    exhaustion,
                    source,
                    request_local_excluded_candidates,
                    request_local_busy_candidates,
                },
                PlanExecutionOperatorOutput::Failed(source) => {
                    V3PlanExecutionOutcome::Failed(source)
                }
                PlanExecutionOperatorOutput::OperatorFault(fault) => {
                    V3PlanExecutionOutcome::OperatorFault(fault)
                }
            })
        }
    }
}

pub(crate) struct V3PlanExecutionPreplan {
    pub(crate) expanded: V3Target09CandidateSetExpanded,
    pub(crate) protocol_decision: crate::nodes::V3Execution11ProtocolDecision,
    pub(crate) request_local_excluded_candidates: BTreeSet<String>,
}

pub(crate) fn run_v3_plan_execution_preplan_operator(
    target_resolved_request: Value,
    manifest: V3Config05ManifestPublished,
    target_source: V3PlanExecutionTargetSource,
    failure_session_scope: V3ProviderFailureSessionScope,
    provider_health: V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: BTreeSet<String>,
    now_ms: u64,
    deterministic_sample: u64,
    mode_policy: V3PlanExecutionModePolicy,
) -> Result<V3PlanExecutionPreplan, V3PlanExecutionStop> {
    let side_output = Arc::new(Mutex::new(None));
    let operator = PlanExecutionOperator::new(
        V3PlanExecutionPhase::PreplanWithoutAdmission,
        manifest,
        target_source,
        failure_session_scope,
        provider_health,
        request_local_excluded_candidates,
        BTreeSet::new(),
        now_ms,
        deterministic_sample,
        None,
        mode_policy,
        side_output.clone(),
    );
    let runner_result = run_v3_single_node_operator(
        V3OperationGraph::Request,
        "plan_execution",
        target_resolved_request,
        operator,
    );
    let output = side_output
        .lock()
        .map_err(|_| {
            V3PlanExecutionStop::Failed(build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3OperationRunnerPlanExecution",
                "plan_execution_operator_failed",
                "plan_execution typed side-output holder is poisoned",
            ))
        })?
        .take();
    // Preplanning publishes typed control only. The actual request later
    // consumes the SDK payload output in the admitting execution path.
    match runner_result {
        Ok(_) => {}
        Err(error) => {
            return Err(match output {
                Some(PlanExecutionOperatorOutput::Failed(source)) => {
                    V3PlanExecutionStop::Failed(source)
                }
                Some(PlanExecutionOperatorOutput::OperatorFault(fault)) => {
                    V3PlanExecutionStop::OperatorFault(fault)
                }
                _ => V3PlanExecutionStop::Failed(build_v3_error_01_source_raised(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3OperationRunnerPlanExecution",
                    "plan_execution_operator_failed",
                    error.message,
                )),
            });
        }
    }
    match output {
        Some(PlanExecutionOperatorOutput::Preplanned {
            expanded,
            decision,
            request_local_excluded_candidates,
        }) => Ok(V3PlanExecutionPreplan {
            expanded,
            protocol_decision: decision,
            request_local_excluded_candidates,
        }),
        Some(PlanExecutionOperatorOutput::Exhausted {
            expanded,
            exhaustion,
            source,
            ..
        }) => Err(V3PlanExecutionStop::Exhausted {
            expanded,
            exhaustion,
            source,
        }),
        Some(PlanExecutionOperatorOutput::Failed(source)) => {
            Err(V3PlanExecutionStop::Failed(source))
        }
        Some(PlanExecutionOperatorOutput::OperatorFault(fault)) => {
            Err(V3PlanExecutionStop::OperatorFault(fault))
        }
        Some(PlanExecutionOperatorOutput::Selected { .. }) => Err(V3PlanExecutionStop::Failed(
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3OperationRunnerPlanExecution",
                "plan_execution_operator_failed",
                "preplanning plan_execution operator returned an admitting output",
            ),
        )),
        None => Err(V3PlanExecutionStop::Failed(
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3OperationRunnerPlanExecution",
                "plan_execution_operator_failed",
                "plan_execution operator omitted typed side output",
            ),
        )),
    }
}

pub(crate) async fn await_v3_plan_execution_with_deadline(
    _deadline: std::time::Instant,
    planning: impl std::future::Future<
        Output = Result<(Value, V3PlanExecutionCompleted), V3PlanExecutionStop>,
    >,
) -> Result<(Value, V3PlanExecutionCompleted), V3PlanExecutionStop> {
    // Planning includes cancellation-aware pool recovery. The original
    // deadline still bounds acquisition and probe work inside that owner; it
    // cannot by itself terminate an accepted request while recovery remains.
    planning.await
}

#[inline(never)]
pub(crate) fn run_v3_plan_execution_operator_with_recovery<'a>(
    attempt_budget: crate::execution_control::V3AttemptBudget,
    target_resolved_request: Value,
    manifest: &'a V3Config05ManifestPublished,
    target_source: V3PlanExecutionTargetSource,
    failure_session_scope: &'a V3ProviderFailureSessionScope,
    provider_health: &'a V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: &'a BTreeSet<String>,
    request_local_busy_candidates: &'a BTreeSet<String>,
    now_ms: u64,
    deterministic_sample: u64,
    preferred_selected: Option<V3Target10ConcreteProviderSelected>,
    mode_policy: V3PlanExecutionModePolicy,
) -> std::pin::Pin<
    Box<
        impl std::future::Future<
                Output = Result<(Value, V3PlanExecutionCompleted), V3PlanExecutionStop>,
            > + Send
            + 'a,
    >,
> {
    Box::pin(run_v3_plan_execution_with_recovery_unboxed(
        attempt_budget,
        target_resolved_request,
        manifest,
        target_source,
        failure_session_scope,
        provider_health,
        request_local_excluded_candidates,
        request_local_busy_candidates,
        now_ms,
        deterministic_sample,
        preferred_selected,
        mode_policy,
    ))
}

async fn run_v3_plan_execution_with_recovery_unboxed(
    attempt_budget: crate::execution_control::V3AttemptBudget,
    target_resolved_request: Value,
    manifest: &V3Config05ManifestPublished,
    target_source: V3PlanExecutionTargetSource,
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_health: &V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: &BTreeSet<String>,
    request_local_busy_candidates: &BTreeSet<String>,
    mut now_ms: u64,
    deterministic_sample: u64,
    preferred_selected: Option<V3Target10ConcreteProviderSelected>,
    mode_policy: V3PlanExecutionModePolicy,
) -> Result<(Value, V3PlanExecutionCompleted), V3PlanExecutionStop> {
    let mut source = target_source;
    let mut preferred = preferred_selected;
    let mut request_local_excluded_candidates = request_local_excluded_candidates.clone();
    let mut request_local_busy_candidates = request_local_busy_candidates.clone();
    let current_time = |code| {
        crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms().map_err(
            |error| {
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3TargetRecoveryWait",
                    code,
                    error,
                )
            },
        )
    };
    loop {
        let scan_attempted = attempt_budget
            .request_candidate_attempts()
            .map_err(|error| {
                V3PlanExecutionStop::Failed(build_v3_error_01_source_raised(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3RequestExecutionControl",
                    "request_candidate_scan_read_failed",
                    error.to_string(),
                ))
            })?;
        let effective_excluded: BTreeSet<String> = request_local_excluded_candidates
            .union(&scan_attempted)
            .cloned()
            .collect();
        let outcome = match run_v3_plan_execution_operator(
            target_resolved_request.clone(),
            manifest.clone(),
            source,
            failure_session_scope.clone(),
            provider_health.clone(),
            effective_excluded,
            request_local_busy_candidates.clone(),
            now_ms,
            deterministic_sample,
            preferred.take(),
            mode_policy.clone(),
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                return Err(V3PlanExecutionStop::Failed(
                    build_v3_error_01_source_raised(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3OperationRunnerPlanExecution",
                        "plan_execution_operator_failed",
                        error.message,
                    ),
                ));
            }
        };
        match outcome {
            V3PlanExecutionOutcome::Selected {
                execution_planned_request,
                mut plan,
            } => {
                plan.request_local_excluded_candidates = request_local_excluded_candidates.clone();
                return Ok((execution_planned_request, plan));
            }
            V3PlanExecutionOutcome::Exhausted {
                expanded,
                exhaustion,
                source: failure_source,
                request_local_excluded_candidates: _,
                request_local_busy_candidates: admitted_busy,
            } => {
                request_local_busy_candidates = admitted_busy;
                let waited = wait_for_target_recovery(
                    &expanded,
                    provider_health,
                    failure_session_scope,
                    &mut request_local_excluded_candidates,
                    &mut request_local_busy_candidates,
                    now_ms,
                    &attempt_budget,
                )
                .await
                .map_err(V3PlanExecutionStop::Failed)?;
                if waited {
                    now_ms = current_time("target_recovery_wait_clock_failed")
                        .map_err(V3PlanExecutionStop::Failed)?;
                    source = V3PlanExecutionTargetSource::Expanded(expanded);
                    continue;
                }
                return Err(V3PlanExecutionStop::Exhausted {
                    expanded,
                    exhaustion,
                    source: failure_source,
                });
            }
            V3PlanExecutionOutcome::Failed(source) => {
                return Err(V3PlanExecutionStop::Failed(source));
            }
            V3PlanExecutionOutcome::OperatorFault(fault) => {
                return Err(V3PlanExecutionStop::OperatorFault(fault));
            }
        }
    }
}

pub(crate) async fn wait_for_target_recovery(
    expanded: &V3Target09CandidateSetExpanded,
    health: &V3ProviderFailureRuntimeHealth,
    scope: &V3ProviderFailureSessionScope,
    excluded: &mut BTreeSet<String>,
    busy: &mut BTreeSet<String>,
    now_ms: u64,
    attempt_budget: &crate::execution_control::V3AttemptBudget,
) -> Result<bool, V3Error01SourceRaised> {
    let permanent: BTreeSet<String> = excluded.difference(busy).cloned().collect();
    let mut current_ms = now_ms;
    loop {
        let observed_generation = health.target_availability_generation();
        let availability = health.session_bound_availability(scope);
        let revisions = attempt_budget
            .request_candidate_recovery_revisions()
            .map_err(|error| {
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3RequestExecutionControl",
                    "request_candidate_scan_read_failed",
                    error.to_string(),
                )
            })?;
        let recovered = attempted_candidates_recovered(
            expanded, &revisions, &permanent, health, scope, current_ms,
        )?;
        if !recovered.is_empty() {
            attempt_budget.clear_recovered_request_candidates(&recovered).map_err(|error| {
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::RuntimeFailure, "V3RequestExecutionControl",
                    "request_candidate_scan_write_failed", error.to_string(),
                )
            })?;
            for key in &recovered {
                excluded.remove(key);
                busy.remove(key);
            }
        }
        for candidate in &expanded.candidates {
            let key = crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key(candidate);
            if !permanent.contains(&key)
                && (!revisions.contains_key(&key) || recovered.contains(&key))
                && V3TargetInterpreter::candidate_admitted_for_request(
                candidate,
                current_ms,
                expanded.route.request_input_tokens,
            )
                && candidate_health_available(&availability, candidate, current_ms)?
            {
                excluded.remove(&key);
                busy.remove(&key);
                return Ok(true);
            }
        }
        let Some(due_at) = attempt_budget.current_target_recovery_deadline(std::time::Instant::now()) else {
            return Ok(false);
        };
        let now = std::time::Instant::now();
        if now >= due_at {
            attempt_budget.advance_target_recovery_step_if_due(now);
            *excluded = permanent.clone();
            busy.clear();
            return Ok(true);
        }
        tokio::select! {
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(due_at)) => {}
            changed = health.wait_for_target_availability_change(observed_generation) => {
                changed.map_err(|error| build_v3_error_01_source_raised(
                    V3ErrorSourceKind::RuntimeFailure, "V3TargetRecoveryWait",
                    "target_availability_wait_failed", error))?;
            }
        }
        current_ms = crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
            .map_err(|error| build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure, "V3TargetRecoveryWait",
                "target_recovery_wait_clock_failed", error))?;
    }
}

fn candidate_health_available<R: V3ProviderAvailabilityReader>(
    availability: &R,
    candidate: &routecodex_v3_target::V3TargetCandidate,
    now_ms: u64,
) -> Result<bool, V3Error01SourceRaised> {
    availability.availability_for_interface(
        &candidate.provider_id, &candidate.interface_id, Some(&candidate.auth_alias),
        Some(&candidate.model_id), now_ms,
    ).map(|projection| projection.available).map_err(|error| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure, "V3ProviderHealthRead", "provider_health_read_failed",
            format!("{}/{}/{}/{}: {error}", candidate.provider_id, candidate.interface_id, candidate.auth_alias, candidate.model_id),
        )
    })
}

fn attempted_candidates_recovered(
    expanded: &V3Target09CandidateSetExpanded,
    baseline: &BTreeMap<String, u64>,
    permanent: &BTreeSet<String>,
    health: &V3ProviderFailureRuntimeHealth,
    scope: &V3ProviderFailureSessionScope,
    now_ms: u64,
) -> Result<BTreeSet<String>, V3Error01SourceRaised> {
    let availability = health.session_bound_availability(scope);
    let store = health.store();
    let mut recovered = BTreeSet::new();
    for candidate in &expanded.candidates {
        let key =
            crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key(candidate);
        let Some(recovery_revision) = baseline.get(&key).filter(|_| !permanent.contains(&key)) else {
            continue;
        };
        if !V3TargetInterpreter::candidate_admitted_for_request(candidate, now_ms, expanded.route.request_input_tokens)
            || !candidate_health_available(&availability, candidate, now_ms)? {
            continue;
        }
        let current_revision = store
            .recovery_success_revision_for_interface(
                &candidate.provider_id,
                &candidate.interface_id,
                &candidate.auth_alias,
                &candidate.model_id,
            )
            .map_err(|error| {
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3TargetRecoveryWait",
                    "target_recovery_health_read_failed",
                    error,
                )
            })?;
        if current_revision > *recovery_revision {
            recovered.insert(key);
        }
    }
    Ok(recovered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use routecodex_v3_target::V3TargetInterpreter;
    use serde_json::json;
    use std::time::Duration;

    fn test_manifest(provider_id: &str) -> V3Config05ManifestPublished {
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3
[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client"]
allowed_transports = ["json", "sse"]
[providers.__PROVIDER__]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "ROUTECODEX_V3_PLAN_EXECUTION_TEST_KEY" }] }
[providers.__PROVIDER__.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text"]
[forwarders.responses]
model = "client-model"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "__PROVIDER__", model = "gpt-test", key = "key1", priority = 1 }]
[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#.replace("__PROVIDER__", provider_id).as_str(),
        )
        .unwrap();
        compile_v3_config_05_manifest(authoring).unwrap()
    }

    #[test]
    fn plan_execution_operator_expands_selects_admits_and_decides_mode_inside_sdk() {
        let manifest = test_manifest("r05_sdk_success");
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "plan-execution")
            .expect("session scope");
        let hit = crate::provider_failure_runtime_policy::resolve_v3_relay_opaque_target_once(
            &manifest,
            "test",
            "responses",
            "/v1/responses",
            &json!({"model": "client-model", "input": "opaque"}),
            0,
        )
        .expect("opaque hit");
        let request = json!({"model": "client-model", "input": "opaque"});
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .expect("clock");
        let outcome = run_v3_plan_execution_operator(
            request.clone(),
            manifest,
            V3PlanExecutionTargetSource::OpaqueHit(hit),
            scope,
            health,
            BTreeSet::new(),
            BTreeSet::new(),
            now_ms,
            0,
            None,
            V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol: V3HubEntryProtocol::Responses,
                allowed_modes: vec!["direct".to_string(), "relay".to_string()],
            },
        )
        .expect("operator run");
        let V3PlanExecutionOutcome::Selected {
            execution_planned_request,
            plan,
        } = outcome
        else {
            panic!("expected selected plan");
        };
        assert_eq!(execution_planned_request, request);
        assert!(!plan.expanded.candidates.is_empty());
        assert!(plan.selected.candidate_count > 0);
        assert_eq!(plan.selected.candidate.provider_id, "r05_sdk_success");
        assert_eq!(plan.execution_mode, V3HubExecutionMode::Direct);
    }

    #[test]
    fn preferred_candidate_cannot_bypass_current_busy_scan_mask() {
        let manifest = test_manifest("preferred_busy_mask");
        let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
        let scope =
            V3ProviderFailureSessionScope::new("test", "default", "preferred-busy").unwrap();
        let request = json!({"model":"client-model","input":"opaque"});
        let hit = crate::provider_failure_runtime_policy::resolve_v3_relay_opaque_target_once(
            &manifest,
            "test",
            "responses",
            "/v1/responses",
            &request,
            0,
        )
        .unwrap();
        let expanded =
            expand_v3_relay_target_candidates_from_opaque_hit(&manifest, hit, 0).unwrap();
        let mode = V3PlanExecutionModePolicy::DirectEntry {
            entry_protocol: V3HubEntryProtocol::Responses,
            allowed_modes: vec!["direct".into(), "relay".into()],
        };
        let first = run_v3_plan_execution_operator(
            request.clone(),
            manifest.clone(),
            V3PlanExecutionTargetSource::Expanded(expanded.clone()),
            scope.clone(),
            health.clone(),
            BTreeSet::new(),
            BTreeSet::new(),
            0,
            0,
            None,
            mode.clone(),
        )
        .unwrap();
        let V3PlanExecutionOutcome::Selected { plan, .. } = first else {
            panic!("the unmasked candidate must be selectable");
        };
        let preferred = plan.selected.clone();
        drop(plan);
        let mask = BTreeSet::from([
            crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key(
                &preferred.candidate,
            ),
        ]);
        let masked = run_v3_plan_execution_operator(
            request,
            manifest,
            V3PlanExecutionTargetSource::Expanded(expanded),
            scope,
            health,
            mask.clone(),
            mask,
            0,
            0,
            Some(preferred),
            mode,
        )
        .unwrap();
        assert!(
            matches!(masked, V3PlanExecutionOutcome::Exhausted { .. }),
            "a preferred candidate must not escape its current exhausted-scan mask"
        );
    }

    #[tokio::test]
    async fn healthy_candidate_must_not_wait_behind_a_stale_busy_mask() {
        let manifest = test_manifest("r05_stale_busy");
        let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "stale-busy").unwrap();
        let request = json!({"model":"client-model","input":"opaque"});
        let (_, expanded) = preplan_test_input(&manifest, &scope, &request);
        let key = crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key(&expanded.candidates[0]);
        let mut excluded = BTreeSet::from([key.clone()]);
        let mut busy = BTreeSet::from([key]);
        let budget = crate::execution_control::V3AttemptBudget::from_manifest(&manifest, "test").unwrap();
        let now_ms = crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms().unwrap();
        let reselect = tokio::time::timeout(Duration::from_millis(100), wait_for_target_recovery(
            &expanded, &health, &scope, &mut excluded, &mut busy, now_ms, &budget,
        )).await.expect("healthy provider must not wait").unwrap();
        assert!(reselect);
        assert!(excluded.is_empty() && busy.is_empty());
    }

    #[test]
    fn only_matching_success_releases_a_recoverable_attempt() {
        let manifest = test_manifest("r05_revision_scope");
        let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "revision-scope").unwrap();
        let (_, expanded) = preplan_test_input(&manifest, &scope, &json!({"model":"client-model","input":"opaque"}));
        let candidate = &expanded.candidates[0];
        let key = crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key(candidate);
        let baseline = BTreeMap::from([(key.clone(), 0)]);
        let now_ms = crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms().unwrap();
        health.store().record_provider_key_success_for_interface(
            &candidate.provider_id, &candidate.interface_id, "unrelated-key", &candidate.model_id, now_ms,
        ).unwrap();
        assert!(attempted_candidates_recovered(&expanded, &baseline, &BTreeSet::new(), &health, &scope, now_ms).unwrap().is_empty());
        health.store().record_provider_key_success_for_interface(
            &candidate.provider_id, &candidate.interface_id, &candidate.auth_alias, &candidate.model_id, now_ms,
        ).unwrap();
        assert_eq!(attempted_candidates_recovered(&expanded, &baseline, &BTreeSet::new(), &health, &scope, now_ms).unwrap(), BTreeSet::from([key.clone()]));
        assert!(attempted_candidates_recovered(&expanded, &baseline, &BTreeSet::from([key]), &health, &scope, now_ms).unwrap().is_empty());
    }

    #[tokio::test]
    async fn target_recovery_does_not_reselect_ineligible_candidate() {
        let manifest = test_manifest("r05_ineligible_recovery");
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "ineligible").unwrap();
        let request = json!({"model":"client-model", "input":"opaque"});
        let (_, mut expanded) = preplan_test_input(&manifest, &scope, &request);
        expanded.route.request_input_tokens = 2_000;
        expanded.candidates[0].max_context_tokens = Some(1_000);
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .unwrap();
        assert!(!V3TargetInterpreter::candidate_admitted_for_request(
            &expanded.candidates[0],
            now_ms,
            expanded.route.request_input_tokens,
        ));
        let budget =
            crate::execution_control::V3AttemptBudget::from_manifest(&manifest, "test").unwrap();
        let mut excluded = BTreeSet::new();
        let mut busy = BTreeSet::new();
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            wait_for_target_recovery(
                &expanded,
                &health,
                &scope,
                &mut excluded,
                &mut busy,
                now_ms,
                &budget,
            ),
        )
        .await;
        assert!(
            result.is_err(),
            "an ineligible candidate must not immediately trigger reselection"
        );
    }

    #[tokio::test]
    async fn selected_target_does_not_mutate_request_scan_before_send() {
        let manifest = test_manifest("baseline_capture");
        let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "baseline").unwrap();
        let request = json!({"model":"client-model","input":"opaque"});
        let (_, expanded) = preplan_test_input(&manifest, &scope, &request);
        let candidate = expanded.candidates[0].clone();
        let budget =
            crate::execution_control::V3AttemptBudget::from_manifest(&manifest, "test").unwrap();
        let (_, plan) = run_v3_plan_execution_operator_with_recovery(
            budget.clone(),
            request,
            &manifest,
            V3PlanExecutionTargetSource::Expanded(expanded),
            &scope,
            &health,
            &BTreeSet::new(),
            &BTreeSet::new(),
            1,
            0,
            None,
            V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol: V3HubEntryProtocol::Responses,
                allowed_modes: vec!["direct".into(), "relay".into()],
            },
        )
        .await
        .ok()
        .expect("healthy target must be selected");
        assert_eq!(plan.selected.candidate.provider_id, candidate.provider_id);
        assert!(
            budget.request_candidate_attempts().unwrap().is_empty(),
            "selection alone is not a real wire attempt"
        );
    }

    #[tokio::test]
    async fn target_recovery_reselects_if_health_restored_before_wait_registration() {
        let manifest = test_manifest("r05_recovered_before_wait");
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope =
            V3ProviderFailureSessionScope::new("test", "default", "recovered-wait").unwrap();
        let hit = crate::provider_failure_runtime_policy::resolve_v3_relay_opaque_target_once(
            &manifest,
            "test",
            "responses",
            "/v1/responses",
            &json!({"model":"client-model","input":"opaque"}),
            0,
        )
        .unwrap();
        let expanded =
            expand_v3_relay_target_candidates_from_opaque_hit(&manifest, hit, 0).unwrap();
        let budget =
            crate::execution_control::V3AttemptBudget::from_manifest(&manifest, "test").unwrap();
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .unwrap();
        let reselect = wait_for_target_recovery(
            &expanded,
            &health,
            &scope,
            &mut BTreeSet::new(),
            &mut BTreeSet::new(),
            now_ms,
            &budget,
        )
        .await
        .unwrap();
        assert!(reselect, "a stale exhaustion decision must not reject a candidate that is healthy before wait registration");
    }

    #[tokio::test]
    async fn target_recovery_health_signal_wakes_without_a_capacity_release() {
        let provider_id = "r05_health_signal_only";
        let manifest = test_manifest(provider_id);
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "health-signal").unwrap();
        let hit = crate::provider_failure_runtime_policy::resolve_v3_relay_opaque_target_once(
            &manifest,
            "test",
            "responses",
            "/v1/responses",
            &json!({"model":"client-model","input":"opaque"}),
            0,
        )
        .unwrap();
        let expanded =
            expand_v3_relay_target_candidates_from_opaque_hit(&manifest, hit, 0).unwrap();
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .unwrap();
        let store = health.store();
        store
            .record_provider_cooldown_failure_for_interface(
                provider_id,
                "default",
                Some("key1"),
                Some("gpt-test"),
                "test cooldown awaiting a matching health probe",
                now_ms,
                60_000,
            )
            .unwrap();
        let permit = store
            .acquire_provider_cooldown_rescue_probe_for_interface(
                provider_id,
                "default",
                Some("key1"),
                Some("gpt-test"),
            )
            .unwrap()
            .unwrap();
        let budget =
            crate::execution_control::V3AttemptBudget::from_manifest(&manifest, "test").unwrap();
        let mut waiting = tokio::spawn(async move {
            wait_for_target_recovery(
                &expanded,
                &health,
                &scope,
                &mut BTreeSet::new(),
                &mut BTreeSet::new(),
                now_ms,
                &budget,
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        store
            .complete_provider_cooldown_probe_success_with_permit(&permit, now_ms)
            .unwrap();
        let result = tokio::time::timeout(Duration::from_millis(200), &mut waiting).await;
        if result.is_err() {
            waiting.abort();
        }
        assert!(result
            .expect("typed health recovery must wake independently of capacity")
            .unwrap()
            .unwrap());
    }

    fn preplan_test_input(
        manifest: &V3Config05ManifestPublished,
        scope: &V3ProviderFailureSessionScope,
        request: &Value,
    ) -> (
        V3Router07OpaqueTargetHitOnce,
        V3Target09CandidateSetExpanded,
    ) {
        let hit = crate::provider_failure_runtime_policy::resolve_v3_relay_opaque_target_once(
            manifest,
            "test",
            "responses",
            "/v1/responses",
            request,
            0,
        )
        .expect("opaque hit");
        let expanded = expand_v3_relay_target_candidates_from_opaque_hit(manifest, hit.clone(), 0)
            .expect("expanded candidates");
        let _ = scope;
        (hit, expanded)
    }

    #[test]
    fn preplan_and_admission_do_not_acquire_provider_capacity() {
        // Planning owns no provider lease: both the preplan scan and the
        // admitting scan must select the only healthy target without observing
        // any request-local capacity exclusion.
        let manifest = test_manifest("r05_preplan_capacity");
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "r05-preplan-capacity")
            .expect("session scope");
        let request = json!({"model": "client-model", "input": "opaque"});
        let (hit, expanded) = preplan_test_input(&manifest, &scope, &request);
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .expect("clock");
        let preplan = run_v3_plan_execution_preplan_operator(
            request.clone(),
            manifest.clone(),
            V3PlanExecutionTargetSource::OpaqueHit(hit),
            scope.clone(),
            health.clone(),
            BTreeSet::new(),
            now_ms,
            0,
            V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol: V3HubEntryProtocol::Responses,
                allowed_modes: vec!["direct".to_string(), "relay".to_string()],
            },
        )
        .unwrap_or_else(|stop| {
            panic!(
                "preplan must not acquire provider capacity: {}",
                match stop {
                    V3PlanExecutionStop::Exhausted { exhaustion, .. } => {
                        format!("exhausted: {exhaustion:?}")
                    }
                    V3PlanExecutionStop::Failed(source) => format!("failed: {source:?}"),
                    V3PlanExecutionStop::OperatorFault(fault) => {
                        format!("operator fault: {fault:?}")
                    }
                }
            )
        });
        assert_eq!(
            preplan.protocol_decision.target.candidate.provider_id,
            "r05_preplan_capacity"
        );
        assert!(preplan.request_local_excluded_candidates.is_empty());

        let admission = run_v3_plan_execution_operator(
            request,
            manifest,
            V3PlanExecutionTargetSource::Expanded(expanded),
            scope,
            health,
            BTreeSet::new(),
            BTreeSet::new(),
            now_ms,
            0,
            None,
            V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol: V3HubEntryProtocol::Responses,
                allowed_modes: vec!["direct".to_string(), "relay".to_string()],
            },
        )
        .expect("admission path run");
        let V3PlanExecutionOutcome::Selected { plan, .. } = admission else {
            panic!("planning must admit the healthy target without a capacity gate");
        };
        assert_eq!(plan.selected.candidate.provider_id, "r05_preplan_capacity");
        assert!(plan.request_local_excluded_candidates.is_empty());
        assert!(plan.request_local_busy_candidates.is_empty());
    }

    #[test]
    fn preplan_uses_the_request_derived_nonzero_selection_sample() {
        let mut manifest = test_manifest("r05_preplan_sample_a");
        let mut second_provider = manifest.providers["r05_preplan_sample_a"].clone();
        second_provider.id = "r05_preplan_sample_b".into();
        manifest
            .providers
            .insert("r05_preplan_sample_b".into(), second_provider);
        let forwarder = manifest.forwarders.get_mut("responses").unwrap();
        let mut second_target = forwarder.targets[0].clone();
        second_target.provider = Some("r05_preplan_sample_b".into());
        forwarder.targets.push(second_target);
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "r05-preplan-sample")
            .expect("session scope");
        let request = json!({"model": "client-model", "input": "opaque"});
        let (hit, expanded) = preplan_test_input(&manifest, &scope, &request);
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .expect("clock");
        let deterministic_sample =
            crate::provider_failure_runtime_policy::v3_relay_provider_target_selection_sample(
                "r05-nonzero-sample",
            );
        assert_ne!(deterministic_sample, 0);
        let select = |sample| {
            select_v3_target_with_session_then_global(
                &V3TargetInterpreter::default(),
                expanded.clone(),
                &scope,
                &health.session_bound_availability(&scope),
                &health,
                &BTreeSet::new(),
                now_ms,
                sample,
            )
            .expect("selection")
        };
        let zero = select(0).candidate.provider_id;
        let expected = select(deterministic_sample).candidate.provider_id;
        assert_ne!(expected, zero, "fixture must distinguish sample zero");
        let preplan = run_v3_plan_execution_preplan_operator(
            request,
            manifest,
            V3PlanExecutionTargetSource::OpaqueHit(hit),
            scope,
            health,
            BTreeSet::new(),
            now_ms,
            deterministic_sample,
            V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol: V3HubEntryProtocol::Responses,
                allowed_modes: vec!["direct".to_string(), "relay".to_string()],
            },
        )
        .unwrap_or_else(|stop| {
            panic!(
                "nonzero preplan failed: {}",
                match stop {
                    V3PlanExecutionStop::Exhausted { exhaustion, .. } => {
                        format!("exhausted: {exhaustion:?}")
                    }
                    V3PlanExecutionStop::Failed(source) => format!("failed: {source:?}"),
                    V3PlanExecutionStop::OperatorFault(fault) => {
                        format!("operator fault: {fault:?}")
                    }
                }
            )
        });
        assert_eq!(
            preplan.protocol_decision.target.candidate.provider_id,
            expected
        );
    }

    #[test]
    fn typed_planning_failure_is_sdk_error_and_keeps_original_source() {
        let manifest = test_manifest("r05_sdk_failure");
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope =
            V3ProviderFailureSessionScope::new("test", "default", "r05-sdk-failure").unwrap();
        let request = json!({"model": "client-model", "input": "opaque"});
        let hit = crate::provider_failure_runtime_policy::resolve_v3_relay_opaque_target_once(
            &manifest,
            "test",
            "responses",
            "/v1/responses",
            &request,
            0,
        )
        .unwrap();
        let expanded =
            expand_v3_relay_target_candidates_from_opaque_hit(&manifest, hit, 0).unwrap();
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .unwrap();
        let side_output = Arc::new(Mutex::new(None));
        let operator = PlanExecutionOperator::new(
            V3PlanExecutionPhase::AdmitAtExecution,
            manifest.clone(),
            V3PlanExecutionTargetSource::Expanded(expanded.clone()),
            scope.clone(),
            health.clone(),
            BTreeSet::new(),
            BTreeSet::new(),
            now_ms,
            0,
            None,
            V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol: V3HubEntryProtocol::Responses,
                allowed_modes: vec![],
            },
            Arc::clone(&side_output),
        );
        let err01_before = crate::operation_runner::operators::err01_execution_count_for_test();
        assert!(
            run_v3_single_node_operator(
                V3OperationGraph::Request,
                "plan_execution",
                request.clone(),
                operator,
            )
            .is_err(),
            "a typed planning failure must not be an SDK success"
        );
        assert_eq!(
            crate::operation_runner::operators::err01_execution_count_for_test() - err01_before,
            1,
            "a real protocol decision failure must execute Error01 once"
        );
        let Some(PlanExecutionOperatorOutput::Failed(source)) = side_output.lock().unwrap().take()
        else {
            panic!("SDK failure must retain the original typed source");
        };
        let expected = build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Execution11ProtocolDecision",
            "protocol_same_execution_mode_not_allowed",
            "same protocol selected target requires direct or relay mode but neither is allowed",
        );
        assert_eq!(source, expected);
        let before_preplan = crate::operation_runner::operators::err01_execution_count_for_test();
        let preplan = run_v3_plan_execution_preplan_operator(
            request.clone(),
            manifest.clone(),
            V3PlanExecutionTargetSource::Expanded(expanded.clone()),
            scope.clone(),
            health.clone(),
            BTreeSet::new(),
            now_ms,
            0,
            V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol: V3HubEntryProtocol::Responses,
                allowed_modes: vec![],
            },
        );
        let Err(V3PlanExecutionStop::Failed(preplan_source)) = preplan else {
            panic!("preplanning must retain the original typed failure");
        };
        assert_eq!(preplan_source, expected);
        assert_eq!(
            crate::operation_runner::operators::err01_execution_count_for_test() - before_preplan,
            1,
        );
        let outcome = run_v3_plan_execution_operator(
            request,
            manifest,
            V3PlanExecutionTargetSource::Expanded(expanded),
            scope,
            health,
            BTreeSet::new(),
            BTreeSet::new(),
            now_ms,
            0,
            None,
            V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol: V3HubEntryProtocol::Responses,
                allowed_modes: vec![],
            },
        )
        .unwrap();
        let V3PlanExecutionOutcome::Failed(source) = outcome else {
            panic!("caller must receive the original typed failure");
        };
        assert_eq!(source, expected);
    }

    #[test]
    fn planning_uses_the_callers_nonzero_selection_sample() {
        let mut manifest = test_manifest("r05_sample_a");
        let mut second_provider = manifest.providers["r05_sample_a"].clone();
        second_provider.id = "r05_sample_b".into();
        manifest
            .providers
            .insert("r05_sample_b".into(), second_provider);
        let forwarder = manifest.forwarders.get_mut("responses").unwrap();
        let mut second_target = forwarder.targets[0].clone();
        second_target.provider = Some("r05_sample_b".into());
        forwarder.targets.push(second_target);
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "r05-sample").unwrap();
        let request = json!({"model": "client-model", "input": "opaque"});
        let hit = crate::provider_failure_runtime_policy::resolve_v3_relay_opaque_target_once(
            &manifest,
            "test",
            "responses",
            "/v1/responses",
            &request,
            0,
        )
        .unwrap();
        let expanded =
            expand_v3_relay_target_candidates_from_opaque_hit(&manifest, hit, 0).unwrap();
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .unwrap();
        let select = |sample| {
            crate::provider_failure_runtime_policy::select_v3_target_with_session_then_global(
                &V3TargetInterpreter::default(),
                expanded.clone(),
                &scope,
                &health.session_bound_availability(&scope),
                &health,
                &BTreeSet::new(),
                now_ms,
                sample,
            )
            .unwrap()
        };
        let zero = select(0).candidate.provider_id;
        let (sample, expected) = [1, 100, 1_000, 10_000, u64::MAX]
            .into_iter()
            .find_map(|sample| {
                let selected = select(sample);
                (selected.candidate.provider_id != zero).then_some((sample, selected))
            })
            .expect("fixture must distinguish the caller sample from zero");
        let outcome = run_v3_plan_execution_operator(
            request.clone(),
            manifest,
            V3PlanExecutionTargetSource::Expanded(expanded),
            scope,
            health,
            BTreeSet::new(),
            BTreeSet::new(),
            now_ms,
            sample,
            None,
            V3PlanExecutionModePolicy::RelayOnly {
                entry_protocol: V3HubEntryProtocol::Responses,
            },
        )
        .unwrap();
        let V3PlanExecutionOutcome::Selected {
            execution_planned_request,
            plan,
        } = outcome
        else {
            panic!("post-probe planning must return the selected candidate");
        };
        assert_eq!(execution_planned_request, request);
        assert_eq!(
            plan.selected.candidate.provider_id,
            expected.candidate.provider_id
        );
        assert_ne!(plan.selected.candidate.provider_id, zero);
    }

    fn three_tier_probe_manifest() -> V3Config05ManifestPublished {
        let authoring = parse_v3_config_02_authoring(&format!(
            r#"
version = 3
[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
endpoints = ["responses"]
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client"]
allowed_transports = ["json", "sse"]
[providers.r05_busy]
type = "responses"
base_url = "http://127.0.0.1:1/v1"
default_model = "gpt-test"
concurrency = {{ max_in_flight = 1, acquire_timeout_ms = 60000, stale_lease_ms = 300000 }}
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "ROUTECODEX_V3_PLAN_RESUME_KEY" }}] }}
[providers.r05_busy.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text"]
[providers.r05_cooled]
type = "responses"
base_url = "http://127.0.0.1:1/v1"
default_model = "gpt-test"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "ROUTECODEX_V3_PLAN_RESUME_KEY" }}] }}
[providers.r05_cooled.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text"]
[providers.r05_later]
type = "responses"
base_url = "http://127.0.0.1:1/v1"
default_model = "gpt-test"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "ROUTECODEX_V3_PLAN_RESUME_KEY" }}] }}
[providers.r05_later.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text"]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "r05_busy", model = "gpt-test", key = "key1", priority = 1 }},
  {{ kind = "provider_model", provider = "r05_cooled", model = "gpt-test", key = "key1", priority = 2 }},
  {{ kind = "provider_model", provider = "r05_later", model = "gpt-test", key = "key1", priority = 3 }},
]
"#
        ))
        .unwrap();
        compile_v3_config_05_manifest(authoring).unwrap()
    }

    fn three_tier_expanded(
        manifest: &V3Config05ManifestPublished,
        health: &V3ProviderFailureRuntimeHealth,
    ) -> V3Target09CandidateSetExpanded {
        let body = json!({"model": "client-model", "input": "opaque"});
        let hit = crate::provider_failure_runtime_policy::resolve_v3_relay_opaque_target_once(
            manifest,
            "test",
            "responses",
            "/v1/responses",
            &body,
            0,
        )
        .expect("opaque hit");
        let mut expanded =
            crate::provider_failure_runtime_policy::expand_v3_relay_target_candidates_from_opaque_hit(
                manifest,
                hit,
                0,
            )
            .expect("expanded candidates");
        assert_eq!(expanded.candidates.len(), 3);
        let target_kind = expanded
            .route
            .target_plan
            .first()
            .expect("opaque route target plan")
            .target_kind
            .clone();
        expanded.route.target_plan = ["r05_busy", "r05_cooled", "r05_later"]
            .iter()
            .enumerate()
            .map(|(tier_index, provider_id)| {
                routecodex_v3_virtual_router::V3Router07OpaqueTargetPlanEntry {
                    tier_index,
                    pool_id: format!("tier{tier_index}"),
                    target_index: 0,
                    target_kind: target_kind.clone(),
                    target_id: None,
                    interface: None,
                    priority: 1,
                    weight: 1,
                    session_sticky: false,
                    direct_provider_model: Some((
                        (*provider_id).to_string(),
                        "gpt-test".to_string(),
                    )),
                }
            })
            .collect();
        for (tier_index, provider_id) in ["r05_busy", "r05_cooled", "r05_later"].iter().enumerate()
        {
            let candidate = expanded
                .candidates
                .iter_mut()
                .find(|candidate| candidate.provider_id == *provider_id)
                .expect("tier candidate");
            candidate.pool_ids = vec![format!("tier{tier_index}")];
        }
        assert_eq!(
            V3TargetInterpreter::default()
                .select_available(expanded.clone(), health, 0)
                .expect("priority selection")
                .candidate
                .provider_id,
            "r05_busy"
        );
        expanded
    }

    #[tokio::test]
    async fn plan_execution_operator_selects_healthy_tier_without_starting_probe() {
        let manifest = three_tier_probe_manifest();
        std::env::set_var("ROUTECODEX_V3_PLAN_RESUME_KEY", "test-key");
        let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "plan-execution-resume")
            .expect("session scope");
        let expanded = three_tier_expanded(&manifest, &health);
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .unwrap();
        let failure =
            routecodex_v3_provider_responses::V3ProviderFailureAction::recoverable("transport");
        for _ in 0..3 {
            health
                .record_provider_key_failure_action(
                    "r05_cooled",
                    Some("key1"),
                    Some("gpt-test"),
                    &failure,
                    now_ms,
                )
                .expect("cooldown setup");
        }
        let task_manifest = manifest.clone();
        let task_scope = scope.clone();
        let task_health = health.clone();
        let initial_exclusions = BTreeSet::from([
            crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key(
                expanded
                    .candidates
                    .iter()
                    .find(|candidate| candidate.provider_id == "r05_later")
                    .expect("later candidate"),
            ),
        ]);
        let healthy_identity =
            crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key_parts(
                "r05_busy",
                Some("default"),
                Some("key1"),
                Some("gpt-test"),
            );
        let request = json!({"model": "client-model", "input": "opaque"});
        let outcome = tokio::time::timeout(Duration::from_millis(500), async move {
            run_v3_plan_execution_operator_with_recovery(
                crate::execution_control::V3AttemptBudget::process_default(),
                request,
                &task_manifest,
                V3PlanExecutionTargetSource::Expanded(expanded),
                &task_scope,
                &task_health,
                &initial_exclusions,
                &BTreeSet::new(),
                now_ms,
                0,
                None,
                V3PlanExecutionModePolicy::DirectEntry {
                    entry_protocol: V3HubEntryProtocol::Responses,
                    allowed_modes: vec!["direct".to_string(), "relay".to_string()],
                },
            )
            .await
        })
        .await
        .expect("healthy business selection must not wait for a probe");
        let Ok((execution_planned_request, plan)) = outcome else {
            panic!("expected selected plan after resume");
        };
        assert_eq!(
            execution_planned_request,
            json!({"model": "client-model", "input": "opaque"})
        );
        assert_eq!(
            plan.selected.candidate.provider_id, "r05_busy",
            "a rescue probe must not reroute the healthy selected tier"
        );
        assert!(
            plan.request_local_busy_candidates.is_empty(),
            "planning records no provider capacity as request-local busy"
        );
        assert!(
            plan.request_local_excluded_candidates.contains(
                &crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key_parts(
                    "r05_later",
                    Some("default"),
                    Some("key1"),
                    Some("gpt-test"),
                )
            ),
            "a physical probe must never release permanent request-local exclusions"
        );
        assert!(!plan
            .request_local_excluded_candidates
            .contains(&healthy_identity));
        std::env::remove_var("ROUTECODEX_V3_PLAN_RESUME_KEY");
    }

    #[tokio::test]
    async fn no_probe_work_ignores_legacy_busy_mask_for_business_selection() {
        let mut manifest = test_manifest("probe_no_work_busy");
        manifest
            .servers
            .get_mut("test")
            .unwrap()
            .execution
            .as_mut()
            .unwrap()
            .attempt_store
            .residence_timeout_ms = 300;
        let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "no-probe-work").unwrap();
        let request = json!({"model":"client-model","input":"opaque"});
        let (_, expanded) = preplan_test_input(&manifest, &scope, &request);
        let busy = BTreeSet::from([
            crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key(
                &expanded.candidates[0],
            ),
        ]);
        let budget =
            crate::execution_control::V3AttemptBudget::from_manifest(&manifest, "test").unwrap();
        let outcome = tokio::time::timeout(
            Duration::from_millis(200),
            run_v3_plan_execution_operator_with_recovery(
                budget.clone(),
                request,
                &manifest,
                V3PlanExecutionTargetSource::Expanded(expanded),
                &scope,
                &health,
                &BTreeSet::new(),
                &busy,
                0,
                0,
                None,
                V3PlanExecutionModePolicy::DirectEntry {
                    entry_protocol: V3HubEntryProtocol::Responses,
                    allowed_modes: vec!["direct".into(), "relay".into()],
                },
            ),
        )
        .await
        .expect("legacy busy metadata must not delay business selection");
        assert!(
            matches!(outcome, Ok((_, _))),
            "business planning must not treat a shared busy mask as admission control"
        );
        assert_eq!(budget.transport_attempts(), 0);
    }
}
