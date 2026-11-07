use super::{run_v3_single_node_operator, OperationRunnerError, V3OperationGraph};
use crate::hub_v1::{V3HubEntryProtocol, V3HubExecutionMode};
use crate::nodes::V3Execution11ProtocolDecisionMode;
use crate::provider_failure_runtime_policy::{
    expand_v3_relay_target_candidates_from_opaque_hit,
    select_v3_target_with_session_then_global,
    V3ProviderFailureRuntimeHealth,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_provider_responses::V3ProviderAvailabilityReader;
use routecodex_v3_target::{
    V3Target09CandidateSetExpanded, V3Target10ConcreteProviderSelected, V3TargetCandidate,
    V3TargetExhaustion, V3TargetInterpreter,
};
use routecodex_v3_virtual_router::V3Router07OpaqueTargetHitOnce;
use serde_json::Value;
use std::collections::BTreeSet;
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
    },
    Exhausted {
        expanded: V3Target09CandidateSetExpanded,
        exhaustion: V3TargetExhaustion,
        source: Option<V3Error01SourceRaised>,
        request_local_excluded_candidates: BTreeSet<String>,
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
        let selected = if let Some(selected) = &self.preferred_selected {
            selected.clone()
        } else {
            match select_v3_target_with_session_then_global(
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
                Err(exhaustion) => {
                    return PlanExecutionOperatorOutput::Exhausted {
                        expanded,
                        exhaustion,
                        source: None,
                        request_local_excluded_candidates: self
                            .request_local_excluded_candidates
                            .clone(),
                    }
                }
            }
        };
        match self.decide_execution_mode(selected) {
                Ok(decision) if matches!(self.phase, V3PlanExecutionPhase::PreplanWithoutAdmission) => PlanExecutionOperatorOutput::Preplanned {
                    expanded,
                    decision,
                    request_local_excluded_candidates: self
                        .request_local_excluded_candidates
                        .clone(),
                },
                Ok(decision) => PlanExecutionOperatorOutput::Selected {
                    expanded,
                    decision,
                    request_local_excluded_candidates: self.request_local_excluded_candidates.clone(),
                },
                Err(Ok(source)) => PlanExecutionOperatorOutput::Failed(source),
                Err(Err(fault)) => PlanExecutionOperatorOutput::OperatorFault(fault),
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
                } => V3PlanExecutionOutcome::Selected {
                    execution_planned_request,
                    plan: V3PlanExecutionCompleted {
                        expanded,
                        selected: decision.target.clone(),
                        request_local_excluded_candidates,
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
                } => V3PlanExecutionOutcome::Exhausted {
                    expanded,
                    exhaustion,
                    source,
                    request_local_excluded_candidates,
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
        Some(
            PlanExecutionOperatorOutput::Selected { .. },
        ) => Err(V3PlanExecutionStop::Failed(
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
    deadline: std::time::Instant,
    planning: impl std::future::Future<
        Output = Result<(Value, V3PlanExecutionCompleted), V3PlanExecutionStop>,
    >,
) -> Result<(Value, V3PlanExecutionCompleted), V3PlanExecutionStop> {
    tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), planning)
        .await
        .unwrap_or_else(|_| {
            Err(V3PlanExecutionStop::Failed(
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3OperationRunnerPlanExecution",
                    "request_residence_deadline_exceeded",
                    "target planning exceeded the request residence deadline",
                ),
            ))
        })
}

#[inline(never)]
pub(crate) fn run_v3_plan_execution<'a>(
    target_resolved_request: Value,
    manifest: &'a V3Config05ManifestPublished,
    target_source: V3PlanExecutionTargetSource,
    failure_session_scope: &'a V3ProviderFailureSessionScope,
    provider_health: &'a V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: &'a BTreeSet<String>,
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
    Box::pin(run_v3_plan_execution_unboxed(
        target_resolved_request,
        manifest,
        target_source,
        failure_session_scope,
        provider_health,
        request_local_excluded_candidates,
        now_ms,
        deterministic_sample,
        preferred_selected,
        mode_policy,
    ))
}

async fn run_v3_plan_execution_unboxed(
    target_resolved_request: Value,
    manifest: &V3Config05ManifestPublished,
    target_source: V3PlanExecutionTargetSource,
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_health: &V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: &BTreeSet<String>,
    now_ms: u64,
    deterministic_sample: u64,
    preferred_selected: Option<V3Target10ConcreteProviderSelected>,
    mode_policy: V3PlanExecutionModePolicy,
) -> Result<(Value, V3PlanExecutionCompleted), V3PlanExecutionStop> {
    let outcome = run_v3_plan_execution_operator(
        target_resolved_request,
        manifest.clone(),
        target_source,
        failure_session_scope.clone(),
        provider_health.clone(),
        request_local_excluded_candidates.clone(),
        now_ms,
        deterministic_sample,
        preferred_selected,
        mode_policy,
    )
    .map_err(|error| V3PlanExecutionStop::Failed(build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3OperationRunnerPlanExecution",
        "plan_execution_operator_failed",
        error.message,
    )))?;
    match outcome {
        V3PlanExecutionOutcome::Selected { execution_planned_request, plan } => {
            Ok((execution_planned_request, plan))
        }
        V3PlanExecutionOutcome::Exhausted { expanded, exhaustion, source, .. } => {
            Err(V3PlanExecutionStop::Exhausted { expanded, exhaustion, source })
        }
        V3PlanExecutionOutcome::Failed(source) => Err(V3PlanExecutionStop::Failed(source)),
        V3PlanExecutionOutcome::OperatorFault(fault) => Err(V3PlanExecutionStop::OperatorFault(fault)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use routecodex_v3_provider_responses::adaptive_concurrency::V3AdaptiveConcurrencyController;
    use routecodex_v3_target::V3TargetInterpreter;
    use serde_json::json;

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
    fn plan_execution_selects_and_decides_mode_without_business_admission() {
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
        let controller = V3AdaptiveConcurrencyController::process_shared();
        let controller_key =
            crate::provider_failure_runtime_policy::v3_provider_concurrency_key_parts(
                "r05_sdk_success",
                "key1",
            );
        let before = controller
            .snapshot(&controller_key)
            .map(|value| value.in_flight);
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
        assert_eq!(
            controller
                .snapshot(&controller_key)
                .map(|value| value.in_flight),
            before
        );
        drop(plan);
        assert_eq!(
            controller
                .snapshot(&controller_key)
                .map(|value| value.in_flight),
            before
        );
    }

    #[test]
    fn captured_selection_is_consumed_without_second_health_decision() {
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
        health.store().record_provider_cooldown_failure_for_interface(
            &preferred.candidate.provider_id, &preferred.candidate.interface_id,
            Some(&preferred.candidate.auth_alias), Some(&preferred.candidate.model_id),
            "lifecycle changed after this request selected", 0, 5000,
        ).unwrap();
        let selected = run_v3_plan_execution_operator(
            request,
            manifest,
            V3PlanExecutionTargetSource::Expanded(expanded),
            scope,
            health,
            BTreeSet::new(),
            0,
            0,
            Some(preferred.clone()),
            mode,
        )
        .unwrap();
        let V3PlanExecutionOutcome::Selected { plan, .. } = selected else {
            panic!("a captured selection must reach transport without another health decision");
        };
        assert_eq!(plan.selected.candidate, preferred.candidate);
    }

    #[test]
    fn health_recovery_does_not_clear_request_exclusion() {
        let provider_id = "r05_shape_excluded_recovery";
        let manifest = test_manifest(provider_id);
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope = V3ProviderFailureSessionScope::new(
            "test",
            "default",
            "shape-excluded-recovery",
        )
        .unwrap();
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
        let key = crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key(
            &expanded.candidates[0],
        );
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .unwrap();
        assert!(V3TargetInterpreter::candidate_admitted(
            &expanded.candidates[0],
            now_ms
        ));

        // Reuse the existing health owner recovery path: a previously failed
        // exact identity completes its matching cooldown probe successfully.
        let action =
            routecodex_v3_provider_responses::V3ProviderFailureAction::recoverable("transport");
        for _ in 0..3 {
            health
                .record_provider_key_failure_action(
                    provider_id,
                    Some("key1"),
                    Some("gpt-test"),
                    &action,
                    now_ms,
                )
                .unwrap();
        }
        let store = health.store();
        let permit = store
            .acquire_provider_cooldown_rescue_probe_for_interface(
                provider_id,
                "default",
                Some("key1"),
                Some("gpt-test"),
            )
            .unwrap()
            .unwrap();
        store.complete_provider_cooldown_probe_success_with_permit(&permit, now_ms).unwrap();
        let availability = health.session_bound_availability(&scope);
        assert!(availability.availability_for_interface(
            provider_id, "default", Some("key1"), Some("gpt-test"), now_ms,
        ).available, "matching typed probe success must restore the same identity");
        let excluded = BTreeSet::from([key]);
        let result = select_v3_target_with_session_then_global(
            &V3TargetInterpreter::default(), expanded, &scope, &availability,
            &health, &excluded, now_ms, 0,
        );
        assert!(
            result.is_err(),
            "matching recovery must not release a request-local exclusion: {result:?}"
        );
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
    fn preplan_and_execution_ignore_occupied_provider_capacity() {
        let mut manifest = test_manifest("r05_preplan_capacity");
        manifest
            .providers
            .get_mut("r05_preplan_capacity")
            .unwrap()
            .concurrency = Some(routecodex_v3_config::V3ProviderConcurrencyAuthoringConfig {
            max_in_flight: 1,
            acquire_timeout_ms: 1000,
            stale_lease_ms: 30_000,
        });
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "r05-preplan-capacity")
            .expect("session scope");
        let request = json!({"model": "client-model", "input": "opaque"});
        let (hit, expanded) = preplan_test_input(&manifest, &scope, &request);
        let controller = V3AdaptiveConcurrencyController::process_shared();
        let provider_key =
            crate::provider_failure_runtime_policy::v3_provider_concurrency_key_parts(
                "r05_preplan_capacity",
                "key1",
            );
        controller
            .ensure_initial_budget(&provider_key, 1)
            .expect("initial budget");
        let identity =
            routecodex_v3_provider_responses::adaptive_concurrency::V3ConcurrencyIdentityScope {
                interface_id: "default".into(),
                model_id: "gpt-test".into(),
            };
        let occupied = controller
            .try_acquire_business_scoped(&provider_key, Some(&identity))
            .expect("occupy sole provider permit");
        let cleanup = TestLeaseCleanup {
            controller: controller.clone(),
            permit: Arc::new(std::sync::Mutex::new(Some(occupied.into_permit()))),
        };
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
        assert_eq!(
            controller
                .snapshot(&provider_key)
                .expect("occupied snapshot")
                .in_flight,
            1
        );

        let admission = run_v3_plan_execution_operator(
            request,
            manifest,
            V3PlanExecutionTargetSource::Expanded(expanded),
            scope,
            health,
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
            panic!("occupied capacity must not block execution selection");
        };
        assert_eq!(plan.selected.candidate.provider_id, "r05_preplan_capacity");
        assert_eq!(
            controller
                .snapshot(&provider_key)
                .expect("post-admission snapshot")
                .in_flight,
            1
        );
        drop(cleanup);
        assert_eq!(
            controller
                .snapshot(&provider_key)
                .expect("released snapshot")
                .in_flight,
            0
        );
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
    fn pre_exhaustion_resume_uses_the_callers_nonzero_selection_sample() {
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

    struct TestLeaseCleanup {
        controller: V3AdaptiveConcurrencyController,
        permit:
            Arc<std::sync::Mutex<Option<routecodex_v3_provider_responses::adaptive_concurrency::V3AdaptiveConcurrencyPermit>>>,
    }

    impl Drop for TestLeaseCleanup {
        fn drop(&mut self) {
            if let Some(permit) = self.permit.lock().expect("cleanup permit holder").take() {
                self.controller
                    .release(permit)
                    .expect("cleanup release busy lease");
            }
        }
    }
}
