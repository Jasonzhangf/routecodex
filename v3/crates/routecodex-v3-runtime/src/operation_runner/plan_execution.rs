use super::{run_v3_single_node_operator, OperationRunnerError, V3OperationGraph};
use crate::hub_v1::{V3HubEntryProtocol, V3HubExecutionMode};
use crate::nodes::V3Execution11ProtocolDecisionMode;
use crate::provider_failure_runtime_policy::{
    expand_v3_relay_target_candidates_from_opaque_hit,
    initiate_v3_target_pre_exhaustion_rescue_probes, step_v3_target_planning_with_admission_sync,
    V3ProviderFailureRuntimeHealth, V3SynchronousTargetAdmissionStep,
    V3SynchronousTargetPlanningInput,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_target::{
    V3Target09CandidateSetExpanded, V3Target10ConcreteProviderSelected, V3TargetCandidate,
    V3TargetExhaustion,
};
use routecodex_v3_virtual_router::V3Router07OpaqueTargetHitOnce;
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.operation.plan_execution";
const OPERATOR_VERSION: &str = "1";

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
        allowed_modes: Vec<V3HubExecutionMode>,
    },
}

pub(crate) struct V3PlanExecutionCompleted {
    pub(crate) expanded: V3Target09CandidateSetExpanded,
    pub(crate) selected: V3Target10ConcreteProviderSelected,
    pub(crate) admission: crate::provider_failure_runtime_policy::V3RuntimeProviderAdmission,
    pub(crate) request_local_excluded_candidates: BTreeSet<String>,
    pub(crate) execution_mode: V3HubExecutionMode,
}

pub(crate) enum V3PlanExecutionOutcome {
    Selected {
        execution_planned_request: Value,
        plan: V3PlanExecutionCompleted,
    },
    Exhausted {
        expanded: V3Target09CandidateSetExpanded,
        exhaustion: V3TargetExhaustion,
    },
    Failed(V3Error01SourceRaised),
    NeedPreExhaustionProbes {
        expanded: V3Target09CandidateSetExpanded,
        rescue_candidates: Vec<V3TargetCandidate>,
        request_local_excluded_candidates: BTreeSet<String>,
    },
    NeedExhaustionProbes {
        expanded: V3Target09CandidateSetExpanded,
        exhaustion: V3TargetExhaustion,
        request_local_excluded_candidates: BTreeSet<String>,
    },
}

enum PlanExecutionOperatorOutput {
    Selected {
        expanded: V3Target09CandidateSetExpanded,
        decision: crate::nodes::V3Execution11ProtocolDecision,
        admission: crate::provider_failure_runtime_policy::V3RuntimeProviderAdmission,
        request_local_excluded_candidates: BTreeSet<String>,
    },
    Exhausted {
        expanded: V3Target09CandidateSetExpanded,
        exhaustion: V3TargetExhaustion,
    },
    Failed(V3Error01SourceRaised),
    NeedPreExhaustionProbes {
        expanded: V3Target09CandidateSetExpanded,
        rescue_candidates: Vec<V3TargetCandidate>,
        request_local_excluded_candidates: BTreeSet<String>,
    },
    NeedExhaustionProbes {
        expanded: V3Target09CandidateSetExpanded,
        exhaustion: V3TargetExhaustion,
        request_local_excluded_candidates: BTreeSet<String>,
    },
}

struct PlanExecutionOperator {
    manifest: V3Config05ManifestPublished,
    target_source: V3PlanExecutionTargetSource,
    failure_session_scope: V3ProviderFailureSessionScope,
    provider_health: V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: BTreeSet<String>,
    now_ms: u64,
    deterministic_sample: u64,
    allow_exhaustion_rescue_probe: bool,
    preferred_selected: Option<V3Target10ConcreteProviderSelected>,
    mode_policy: V3PlanExecutionModePolicy,
    pre_exhaustion_probes_completed: bool,
    exhaustion_probes_completed: bool,
    side_output: Arc<Mutex<Option<PlanExecutionOperatorOutput>>>,
}

impl PlanExecutionOperator {
    fn new(
        manifest: V3Config05ManifestPublished,
        target_source: V3PlanExecutionTargetSource,
        failure_session_scope: V3ProviderFailureSessionScope,
        provider_health: V3ProviderFailureRuntimeHealth,
        request_local_excluded_candidates: BTreeSet<String>,
        now_ms: u64,
        deterministic_sample: u64,
        allow_exhaustion_rescue_probe: bool,
        preferred_selected: Option<V3Target10ConcreteProviderSelected>,
        mode_policy: V3PlanExecutionModePolicy,
        pre_exhaustion_probes_completed: bool,
        exhaustion_probes_completed: bool,
        side_output: Arc<Mutex<Option<PlanExecutionOperatorOutput>>>,
    ) -> Self {
        Self {
            manifest,
            target_source,
            failure_session_scope,
            provider_health,
            request_local_excluded_candidates,
            now_ms,
            deterministic_sample,
            allow_exhaustion_rescue_probe,
            preferred_selected,
            mode_policy,
            pre_exhaustion_probes_completed,
            exhaustion_probes_completed,
            side_output,
        }
    }

    fn decide_execution_mode(
        &self,
        selected: V3Target10ConcreteProviderSelected,
    ) -> Result<crate::nodes::V3Execution11ProtocolDecision, V3Error01SourceRaised> {
        let (entry_protocol, allowed_modes) = match &self.mode_policy {
            V3PlanExecutionModePolicy::RelayOnly { entry_protocol } => {
                (*entry_protocol, vec!["relay".to_string()])
            }
            V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol,
                allowed_modes,
            } => {
                let allowed_modes = allowed_modes
                    .iter()
                    .map(|mode| match mode {
                        V3HubExecutionMode::Direct => "direct".to_string(),
                        V3HubExecutionMode::Relay => "relay".to_string(),
                    })
                    .collect();
                (*entry_protocol, allowed_modes)
            }
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
                    Err(source) => return PlanExecutionOperatorOutput::Failed(source),
                }
            }
        };
        let step = step_v3_target_planning_with_admission_sync(V3SynchronousTargetPlanningInput {
            manifest: &self.manifest,
            expanded: expanded.clone(),
            failure_session_scope: &self.failure_session_scope,
            provider_health: &self.provider_health,
            request_local_excluded_candidates: &self.request_local_excluded_candidates,
            now_ms: self.now_ms,
            deterministic_sample: self.deterministic_sample,
            allow_exhaustion_rescue_probe: self.allow_exhaustion_rescue_probe,
            preferred_selected: self.preferred_selected.clone(),
            pre_exhaustion_probes_completed: self.pre_exhaustion_probes_completed,
            exhaustion_probes_completed: self.exhaustion_probes_completed,
        });
        match step {
            V3SynchronousTargetAdmissionStep::Selected {
                selected,
                request_local_excluded_candidates,
            } => match self.decide_execution_mode(selected.selected) {
                Ok(decision) => PlanExecutionOperatorOutput::Selected {
                    expanded,
                    decision,
                    admission: selected.admission,
                    request_local_excluded_candidates,
                },
                Err(source) => PlanExecutionOperatorOutput::Failed(source),
            },
            V3SynchronousTargetAdmissionStep::NeedPreExhaustionProbes {
                expanded,
                rescue_candidates,
                request_local_excluded_candidates,
            } => PlanExecutionOperatorOutput::NeedPreExhaustionProbes {
                expanded,
                rescue_candidates,
                request_local_excluded_candidates,
            },
            V3SynchronousTargetAdmissionStep::NeedExhaustionProbes {
                expanded,
                exhaustion,
                request_local_excluded_candidates,
            } => PlanExecutionOperatorOutput::NeedExhaustionProbes {
                expanded,
                exhaustion,
                request_local_excluded_candidates,
            },
            V3SynchronousTargetAdmissionStep::Exhausted(exhaustion) => {
                PlanExecutionOperatorOutput::Exhausted {
                    expanded,
                    exhaustion,
                }
            }
            V3SynchronousTargetAdmissionStep::Failed(source) => {
                PlanExecutionOperatorOutput::Failed(source)
            }
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
    allow_exhaustion_rescue_probe: bool,
    preferred_selected: Option<V3Target10ConcreteProviderSelected>,
    mode_policy: V3PlanExecutionModePolicy,
    pre_exhaustion_probes_completed: bool,
    exhaustion_probes_completed: bool,
) -> Result<V3PlanExecutionOutcome, OperationRunnerError> {
    let side_output = Arc::new(Mutex::new(None));
    let operator = PlanExecutionOperator::new(
        manifest,
        target_source,
        failure_session_scope,
        provider_health,
        request_local_excluded_candidates,
        now_ms,
        deterministic_sample,
        allow_exhaustion_rescue_probe,
        preferred_selected,
        mode_policy,
        pre_exhaustion_probes_completed,
        exhaustion_probes_completed,
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
    if let Some(PlanExecutionOperatorOutput::Failed(source)) = output {
        return Ok(V3PlanExecutionOutcome::Failed(source));
    }
    let execution_planned_request = runner_result?;
    let output = output.ok_or_else(|| {
        OperationRunnerError::new("plan_execution operator omitted typed side output")
    })?;
    Ok(match output {
        PlanExecutionOperatorOutput::Selected {
            expanded,
            decision,
            admission,
            request_local_excluded_candidates,
        } => V3PlanExecutionOutcome::Selected {
            execution_planned_request,
            plan: V3PlanExecutionCompleted {
                expanded,
                selected: decision.target,
                admission,
                request_local_excluded_candidates,
                execution_mode: match decision.mode {
                    V3Execution11ProtocolDecisionMode::SameProtocolDirect => {
                        V3HubExecutionMode::Direct
                    }
                    V3Execution11ProtocolDecisionMode::HubRelay => V3HubExecutionMode::Relay,
                },
            },
        },
        PlanExecutionOperatorOutput::Exhausted {
            expanded,
            exhaustion,
        } => V3PlanExecutionOutcome::Exhausted {
            expanded,
            exhaustion,
        },
        PlanExecutionOperatorOutput::Failed(source) => V3PlanExecutionOutcome::Failed(source),
        PlanExecutionOperatorOutput::NeedPreExhaustionProbes {
            expanded,
            rescue_candidates,
            request_local_excluded_candidates,
        } => V3PlanExecutionOutcome::NeedPreExhaustionProbes {
            expanded,
            rescue_candidates,
            request_local_excluded_candidates,
        },
        PlanExecutionOperatorOutput::NeedExhaustionProbes {
            expanded,
            exhaustion,
            request_local_excluded_candidates,
        } => V3PlanExecutionOutcome::NeedExhaustionProbes {
            expanded,
            exhaustion,
            request_local_excluded_candidates,
        },
    })
}

pub(crate) async fn run_v3_plan_execution_operator_with_probes(
    target_resolved_request: Value,
    manifest: &V3Config05ManifestPublished,
    target_source: V3PlanExecutionTargetSource,
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_health: &V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: &BTreeSet<String>,
    mut now_ms: u64,
    deterministic_sample: u64,
    allow_exhaustion_rescue_probe: bool,
    preferred_selected: Option<V3Target10ConcreteProviderSelected>,
    mode_policy: V3PlanExecutionModePolicy,
) -> V3PlanExecutionOutcome {
    let mut source = target_source;
    let mut preferred = preferred_selected;
    let mut request_local_excluded_candidates = request_local_excluded_candidates.clone();
    let mut pre_exhaustion_probes_completed = false;
    let mut exhaustion_probes_completed = false;
    let mut exhaustion_generation = None;
    let current_time = |code| {
        crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms().map_err(
            |error| {
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3ProviderCooldownRescueProbe",
                    code,
                    error,
                )
            },
        )
    };
    loop {
        let outcome = match run_v3_plan_execution_operator(
            target_resolved_request.clone(),
            manifest.clone(),
            source,
            failure_session_scope.clone(),
            provider_health.clone(),
            request_local_excluded_candidates.clone(),
            now_ms,
            deterministic_sample,
            allow_exhaustion_rescue_probe,
            preferred.take(),
            mode_policy.clone(),
            pre_exhaustion_probes_completed,
            exhaustion_probes_completed,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                return V3PlanExecutionOutcome::Failed(build_v3_error_01_source_raised(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3OperationRunnerPlanExecution",
                    "plan_execution_operator_failed",
                    error.message,
                ));
            }
        };
        match outcome {
            V3PlanExecutionOutcome::NeedPreExhaustionProbes {
                expanded,
                rescue_candidates,
                request_local_excluded_candidates: admitted_exclusions,
            } => {
                if let Err(source) = initiate_v3_target_pre_exhaustion_rescue_probes(
                    provider_health,
                    manifest,
                    &rescue_candidates,
                    now_ms,
                )
                .await
                {
                    return V3PlanExecutionOutcome::Failed(source);
                }
                request_local_excluded_candidates.extend(admitted_exclusions);
                exhaustion_probes_completed = false;
                exhaustion_generation = None;
                now_ms = match current_time("target_pre_exhaustion_rescue_clock_failed") {
                    Ok(now_ms) => now_ms,
                    Err(source) => return V3PlanExecutionOutcome::Failed(source),
                };
                pre_exhaustion_probes_completed = true;
                source = V3PlanExecutionTargetSource::Expanded(expanded);
            }
            V3PlanExecutionOutcome::NeedExhaustionProbes {
                expanded,
                exhaustion,
                request_local_excluded_candidates: admitted_exclusions,
            } => {
                request_local_excluded_candidates.extend(admitted_exclusions);
                pre_exhaustion_probes_completed = false;
                exhaustion_probes_completed = false;
                let generation = provider_health.target_availability_generation();
                if exhaustion_generation != Some(generation) {
                    now_ms = match current_time("target_exhaustion_rescue_clock_failed") {
                        Ok(now_ms) => now_ms,
                        Err(source) => return V3PlanExecutionOutcome::Failed(source),
                    };
                    exhaustion_generation = Some(generation);
                    source = V3PlanExecutionTargetSource::Expanded(expanded);
                    continue;
                }
                match provider_health
                    .run_exhaustion_rescue_probes(manifest, &expanded, now_ms)
                    .await
                {
                    Ok(true) => {
                        now_ms = match current_time("target_exhaustion_rescue_clock_failed") {
                            Ok(now_ms) => now_ms,
                            Err(source) => return V3PlanExecutionOutcome::Failed(source),
                        };
                        exhaustion_probes_completed = true;
                        source = V3PlanExecutionTargetSource::Expanded(expanded);
                    }
                    Ok(false) => {
                        return V3PlanExecutionOutcome::Exhausted {
                            expanded,
                            exhaustion,
                        }
                    }
                    Err(error) => {
                        return V3PlanExecutionOutcome::Failed(build_v3_error_01_source_raised(
                            V3ErrorSourceKind::RuntimeFailure,
                            "V3ProviderCooldownRescueProbe",
                            "target_exhaustion_rescue_probe_failed",
                            error,
                        ))
                    }
                }
            }
            outcome => return outcome,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use routecodex_v3_provider_responses::adaptive_concurrency::V3AdaptiveConcurrencyController;
    use routecodex_v3_target::V3TargetInterpreter;
    use serde_json::json;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::{mpsc, oneshot};

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
        let controller = V3AdaptiveConcurrencyController::process_shared();
        let controller_key =
            crate::provider_failure_runtime_policy::v3_provider_concurrency_key_parts(
                "r05_sdk_success",
                "key1",
            );
        let before = controller
            .snapshot(&controller_key)
            .map(|value| value.in_flight)
            .unwrap_or(0);
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
            false,
            None,
            V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol: V3HubEntryProtocol::Responses,
                allowed_modes: vec![V3HubExecutionMode::Direct, V3HubExecutionMode::Relay],
            },
            false,
            false,
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
                .expect("admission snapshot")
                .in_flight,
            before + 1
        );
        drop(plan);
        assert_eq!(
            controller
                .snapshot(&controller_key)
                .expect("released admission snapshot")
                .in_flight,
            before
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
            manifest.clone(),
            V3PlanExecutionTargetSource::Expanded(expanded.clone()),
            scope.clone(),
            health.clone(),
            BTreeSet::new(),
            now_ms,
            0,
            false,
            None,
            V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol: V3HubEntryProtocol::Responses,
                allowed_modes: vec![],
            },
            false,
            false,
            Arc::clone(&side_output),
        );
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
        let outcome = run_v3_plan_execution_operator(
            request,
            manifest,
            V3PlanExecutionTargetSource::Expanded(expanded),
            scope,
            health,
            BTreeSet::new(),
            now_ms,
            0,
            false,
            None,
            V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol: V3HubEntryProtocol::Responses,
                allowed_modes: vec![],
            },
            false,
            false,
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
            true,
            None,
            V3PlanExecutionModePolicy::RelayOnly {
                entry_protocol: V3HubEntryProtocol::Responses,
            },
            true,
            false,
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

    fn three_tier_probe_manifest(listener: &TcpListener) -> V3Config05ManifestPublished {
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
        let mut manifest = compile_v3_config_05_manifest(authoring).unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let cooled = manifest.providers.get_mut("r05_cooled").unwrap();
        cooled.base_url = base_url.clone();
        cooled.interfaces.get_mut("default").unwrap().base_url = base_url;
        manifest
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

    async fn serve_gated_probe(
        listener: TcpListener,
        arrivals: mpsc::UnboundedSender<()>,
        release: oneshot::Receiver<()>,
    ) {
        let (mut socket, _) = listener.accept().await.expect("probe listener accept");
        let mut request = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let read = socket.read(&mut chunk).await.expect("probe request read");
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        arrivals.send(()).expect("probe arrival observation");
        release.await.expect("probe release");
        let body = r#"{"status":"completed"}"#;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .expect("probe response write");
    }

    #[tokio::test]
    async fn plan_execution_operator_suspends_for_rescue_probes_and_resumes_without_rerouting() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("probe listener bind");
        let manifest = three_tier_probe_manifest(&listener);
        std::env::set_var("ROUTECODEX_V3_PLAN_RESUME_KEY", "test-key");
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
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
        let controller = V3AdaptiveConcurrencyController::process_shared();
        let busy_key = crate::provider_failure_runtime_policy::v3_provider_concurrency_key_parts(
            "r05_busy", "key1",
        );
        controller.ensure_initial_budget(&busy_key, 1).unwrap();
        let busy_lease = controller
            .try_acquire_business(&busy_key)
            .expect("busy lease");
        let busy_permit = Arc::new(std::sync::Mutex::new(Some(busy_lease.into_permit())));
        let cleanup_permit = busy_permit.clone();
        let cleanup = TestLeaseCleanup {
            controller: controller.clone(),
            permit: cleanup_permit,
        };

        let (arrivals_tx, mut arrivals_rx) = mpsc::unbounded_channel();
        let (release_tx, release_rx) = oneshot::channel();
        let probe_server = tokio::spawn(serve_gated_probe(listener, arrivals_tx, release_rx));

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
        let request = json!({"model": "client-model", "input": "opaque"});
        let run = tokio::spawn(async move {
            run_v3_plan_execution_operator_with_probes(
                request,
                &task_manifest,
                V3PlanExecutionTargetSource::Expanded(expanded),
                &task_scope,
                &task_health,
                &initial_exclusions,
                now_ms,
                0,
                true,
                None,
                V3PlanExecutionModePolicy::DirectEntry {
                    entry_protocol: V3HubEntryProtocol::Responses,
                    allowed_modes: vec![V3HubExecutionMode::Direct, V3HubExecutionMode::Relay],
                },
            )
            .await
        });

        tokio::time::timeout(Duration::from_secs(2), arrivals_rx.recv())
            .await
            .expect("SDK must pause for the cooled-peer probe")
            .expect("probe arrival channel");
        assert!(
            !run.is_finished(),
            "exhaustion rescue must await the gated HTTP response"
        );
        busy_permit
            .lock()
            .expect("busy permit holder")
            .take()
            .map(|permit| controller.release(permit))
            .expect("busy permit")
            .expect("release busy lease");
        release_tx.send(()).expect("release probe response");

        let outcome = tokio::time::timeout(Duration::from_secs(2), run)
            .await
            .expect("probe resume must complete")
            .expect("plan execution task");
        let V3PlanExecutionOutcome::Selected {
            execution_planned_request,
            plan,
        } = outcome
        else {
            panic!("expected selected plan after resume");
        };
        assert_eq!(
            execution_planned_request,
            json!({"model": "client-model", "input": "opaque"})
        );
        assert_eq!(
            plan.selected.candidate.provider_id, "r05_cooled",
            "the busy candidate must stay request-local excluded across pause/resume"
        );
        assert!(plan.request_local_excluded_candidates.contains(
            &crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key_parts(
                "r05_busy",
                Some("default"),
                Some("key1"),
                Some("gpt-test"),
            ),
        ));
        assert_eq!(
            controller
                .snapshot(&busy_key)
                .expect("busy snapshot")
                .in_flight,
            0
        );
        drop(plan);
        drop(cleanup);
        probe_server.await.expect("probe server");
        std::env::remove_var("ROUTECODEX_V3_PLAN_RESUME_KEY");
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
