use super::{run_v3_single_node_operator, OperationRunnerError, V3OperationGraph};
use crate::hub_v1::{V3HubEntryProtocol, V3HubExecutionMode};
use crate::nodes::V3Execution11ProtocolDecisionMode;
use crate::provider_failure_runtime_policy::{
    expand_v3_relay_target_candidates_from_opaque_hit, select_v3_target_with_session_then_global,
    V3ProviderFailureRuntimeHealth,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_target::{
    V3Target09CandidateSetExpanded, V3Target10ConcreteProviderSelected, V3TargetExhaustion,
    V3TargetInterpreter,
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
        // Selection remains immediate and never waits. Declared candidates are
        // not excluded by local capacity state; a real Provider failure switches
        // to the next declared candidate on the following iteration.
        let selected = match self.preferred_selected.clone().filter(|preferred| {
            !self.request_local_excluded_candidates.contains(
                &crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key(
                    &preferred.candidate,
                ),
            )
        }) {
            Some(preferred) => preferred,
            None => match select_v3_target_with_session_then_global(
                &V3TargetInterpreter::default(),
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
            },
        };
        let decision = match self.decide_execution_mode(selected) {
            Ok(decision) => decision,
            Err(Ok(source)) => return PlanExecutionOperatorOutput::Failed(source),
            Err(Err(fault)) => return PlanExecutionOperatorOutput::OperatorFault(fault),
        };
        match self.phase {
            V3PlanExecutionPhase::PreplanWithoutAdmission => {
                PlanExecutionOperatorOutput::Preplanned {
                    expanded,
                    decision,
                    request_local_excluded_candidates: self
                        .request_local_excluded_candidates
                        .clone(),
                }
            }
            V3PlanExecutionPhase::AdmitAtExecution => PlanExecutionOperatorOutput::Selected {
                expanded,
                decision,
                request_local_excluded_candidates: self.request_local_excluded_candidates.clone(),
            },
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

/// Runtime planning entrypoint used by the Direct and Relay kernels.
///
/// Selection is immediate and nonblocking. Declared candidates are not
/// excluded by local capacity state; no recovery, probe or Deferred wait exists
/// on the request path. The request budget is retained only for the original
/// residence deadline.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_v3_plan_execution_operator_with_probes<'a>(
    _attempt_budget: crate::execution_control::V3AttemptBudget,
    target_resolved_request: Value,
    manifest: &'a V3Config05ManifestPublished,
    target_source: V3PlanExecutionTargetSource,
    failure_session_scope: &'a V3ProviderFailureSessionScope,
    provider_health: &'a V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: &'a BTreeSet<String>,
    request_local_busy_candidates: &'a BTreeSet<String>,
    now_ms: u64,
    deterministic_sample: u64,
    _allow_exhaustion_rescue_probe: bool,
    mut preferred_selected: Option<V3Target10ConcreteProviderSelected>,
    mode_policy: V3PlanExecutionModePolicy,
) -> std::pin::Pin<
    Box<
        impl std::future::Future<
                Output = Result<(Value, V3PlanExecutionCompleted), V3PlanExecutionStop>,
            > + Send
            + 'a,
    >,
> {
    Box::pin(async move {
        let _ = request_local_busy_candidates;
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
        .map_err(|error| {
            V3PlanExecutionStop::Failed(build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3OperationRunnerPlanExecution",
                "plan_execution_operator_failed",
                error.message,
            ))
        })?;
        match outcome {
            V3PlanExecutionOutcome::Selected {
                execution_planned_request,
                plan,
            } => Ok((execution_planned_request, plan)),
            V3PlanExecutionOutcome::Exhausted {
                expanded,
                exhaustion,
                source,
                ..
            } => Err(V3PlanExecutionStop::Exhausted {
                expanded,
                exhaustion,
                source,
            }),
            V3PlanExecutionOutcome::Failed(source) => Err(V3PlanExecutionStop::Failed(source)),
            V3PlanExecutionOutcome::OperatorFault(fault) => {
                Err(V3PlanExecutionStop::OperatorFault(fault))
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use serde_json::json;
    use std::time::Duration;

    fn candidate_key(candidate: &routecodex_v3_target::V3TargetCandidate) -> String {
        crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key(candidate)
    }

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

    /// Build one pool that declares `provider_ids` in descending priority so
    /// the first declared id is selected first (larger priority wins).
    fn multi_provider_manifest(provider_ids: &[&str]) -> V3Config05ManifestPublished {
        let declared = provider_ids.len();
        let mut authoring = String::from(
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
"#,
        );
        for id in provider_ids {
            authoring.push_str(&format!(
                r#"
[providers.{id}]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "gpt-test"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "ROUTECODEX_V3_PLAN_EXECUTION_TEST_KEY" }}] }}
[providers.{id}.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text"]
"#
            ));
        }
        authoring.push_str(
            r#"
[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [
"#,
        );
        for (index, id) in provider_ids.iter().enumerate() {
            authoring.push_str(&format!(
                "  {{ kind = \"provider_model\", provider = \"{id}\", model = \"gpt-test\", key = \"key1\", priority = {} }},\n",
                declared - index
            ));
        }
        authoring.push_str("]\n");
        let authoring = parse_v3_config_02_authoring(&authoring).unwrap();
        compile_v3_config_05_manifest(authoring).unwrap()
    }

    /// Build one pool whose providers all share the same priority, so the
    /// request-derived deterministic sample is the only selection tiebreaker.
    fn equal_priority_manifest(provider_ids: &[&str]) -> V3Config05ManifestPublished {
        let mut authoring = String::from(
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
"#,
        );
        for id in provider_ids {
            authoring.push_str(&format!(
                r#"
[providers.{id}]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "gpt-test"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "ROUTECODEX_V3_PLAN_EXECUTION_TEST_KEY" }}] }}
[providers.{id}.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text"]
"#
            ));
        }
        authoring.push_str(
            r#"
[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [
"#,
        );
        for id in provider_ids {
            authoring.push_str(&format!(
                "  {{ kind = \"provider_model\", provider = \"{id}\", model = \"gpt-test\", key = \"key1\", priority = 1 }},\n",
            ));
        }
        authoring.push_str("]\n");
        let authoring = parse_v3_config_02_authoring(&authoring).unwrap();
        compile_v3_config_05_manifest(authoring).unwrap()
    }

    fn direct_policy() -> V3PlanExecutionModePolicy {
        V3PlanExecutionModePolicy::DirectEntry {
            entry_protocol: V3HubEntryProtocol::Responses,
            allowed_modes: vec!["direct".to_string(), "relay".to_string()],
        }
    }

    fn relay_policy() -> V3PlanExecutionModePolicy {
        V3PlanExecutionModePolicy::RelayOnly {
            entry_protocol: V3HubEntryProtocol::Responses,
        }
    }

    fn opaque_hit(
        manifest: &V3Config05ManifestPublished,
        request: &Value,
    ) -> V3Router07OpaqueTargetHitOnce {
        crate::provider_failure_runtime_policy::resolve_v3_relay_opaque_target_once(
            manifest,
            "test",
            "responses",
            "/v1/responses",
            request,
            0,
        )
        .expect("opaque hit")
    }

    fn expanded_from_hit(
        manifest: &V3Config05ManifestPublished,
        hit: V3Router07OpaqueTargetHitOnce,
    ) -> V3Target09CandidateSetExpanded {
        expand_v3_relay_target_candidates_from_opaque_hit(manifest, hit, 0)
            .expect("expanded candidates")
    }

    #[test]
    fn plan_execution_operator_selects_and_decides_mode_without_admission() {
        let manifest = test_manifest("r05_sdk_success");
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "plan-execution")
            .expect("session scope");
        let hit = opaque_hit(
            &manifest,
            &json!({"model": "client-model", "input": "opaque"}),
        );
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
            now_ms,
            0,
            None,
            direct_policy(),
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
        assert!(plan.request_local_excluded_candidates.is_empty());
    }

    #[test]
    fn immediate_selection_reaches_tenth_declared_candidate_direct() {
        immediate_selection_reaches_tenth_declared_candidate(
            direct_policy(),
            V3HubExecutionMode::Direct,
        );
    }

    #[test]
    fn immediate_selection_reaches_tenth_declared_candidate_relay() {
        immediate_selection_reaches_tenth_declared_candidate(
            relay_policy(),
            V3HubExecutionMode::Relay,
        );
    }

    fn immediate_selection_reaches_tenth_declared_candidate(
        mode_policy: V3PlanExecutionModePolicy,
        expected_mode: V3HubExecutionMode,
    ) {
        let provider_ids: Vec<String> = (1..=10)
            .map(|index| format!("e37891a_p{index:02}"))
            .collect();
        let provider_refs: Vec<&str> = provider_ids.iter().map(String::as_str).collect();
        let manifest = multi_provider_manifest(&provider_refs);
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope =
            V3ProviderFailureSessionScope::new("test", "default", "ten-candidates").unwrap();
        let request = json!({"model": "client-model", "input": "opaque"});
        let hit = opaque_hit(&manifest, &request);
        let expanded = expanded_from_hit(&manifest, hit);
        assert_eq!(expanded.candidates.len(), 10);
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .expect("clock");
        let mut excluded = BTreeSet::new();
        for (index, expected) in provider_ids.iter().enumerate() {
            let outcome = run_v3_plan_execution_operator(
                request.clone(),
                manifest.clone(),
                V3PlanExecutionTargetSource::Expanded(expanded.clone()),
                scope.clone(),
                health.clone(),
                excluded.clone(),
                now_ms,
                0,
                None,
                mode_policy.clone(),
            )
            .unwrap_or_else(|error| {
                panic!("candidate {index} ({expected}) must be reachable: {error:?}")
            });
            let V3PlanExecutionOutcome::Selected { plan, .. } = outcome else {
                panic!("candidate {index} ({expected}) must be selected, not exhausted");
            };
            assert_eq!(
                &plan.selected.candidate.provider_id, expected,
                "declared candidate order must follow the pool priority order"
            );
            assert_eq!(plan.execution_mode, expected_mode);
            excluded.insert(candidate_key(&plan.selected.candidate));
        }
    }

    #[test]
    fn cooldown_only_exhaustion_returns_without_waiting_for_probes() {
        let provider_ids = ["e37891a_cool_a", "e37891a_cool_b", "e37891a_cool_c"];
        let manifest = multi_provider_manifest(&provider_ids);
        let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
        let scope =
            V3ProviderFailureSessionScope::new("test", "default", "cooled-exhaustion").unwrap();
        let request = json!({"model": "client-model", "input": "opaque"});
        let hit = opaque_hit(&manifest, &request);
        let expanded = expanded_from_hit(&manifest, hit);
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .expect("clock");
        let failure =
            routecodex_v3_provider_responses::V3ProviderFailureAction::recoverable("transport");
        for id in provider_ids {
            for _ in 0..3 {
                health
                    .record_provider_key_failure_action(
                        id,
                        Some("key1"),
                        Some("gpt-test"),
                        &failure,
                        now_ms,
                    )
                    .expect("cooldown setup");
            }
        }
        let budget =
            crate::execution_control::V3AttemptBudget::from_manifest(&manifest, "test").unwrap();
        let selection = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(async move {
                tokio::time::timeout(
                    Duration::from_millis(500),
                    run_v3_plan_execution_operator_with_probes(
                        budget,
                        request,
                        &manifest,
                        V3PlanExecutionTargetSource::Expanded(expanded),
                        &scope,
                        &health,
                        &BTreeSet::new(),
                        &BTreeSet::new(),
                        now_ms,
                        0,
                        true,
                        None,
                        direct_policy(),
                    ),
                )
                .await
            });
        let selection = selection.expect(
            "cooldown-only exhaustion must return immediately instead of awaiting rescue probes",
        );
        assert!(
            matches!(selection, Err(V3PlanExecutionStop::Exhausted { .. })),
            "all-cooled candidates must produce a typed exhaustion, not a probe wait"
        );
    }

    #[test]
    fn held_preceding_probe_does_not_block_healthy_candidate_selection() {
        let mut manifest = test_manifest("r05_held_cooled");
        let mut healthy = manifest.providers["r05_held_cooled"].clone();
        healthy.id = "r05_healthy_sibling".to_string();
        manifest
            .providers
            .insert("r05_healthy_sibling".to_string(), healthy);
        let forwarder = manifest.forwarders.get_mut("responses").unwrap();
        let mut healthy_target = forwarder.targets[0].clone();
        healthy_target.provider = Some("r05_healthy_sibling".to_string());
        healthy_target.priority = Some(2);
        forwarder.targets.push(healthy_target);

        let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
        let scope =
            V3ProviderFailureSessionScope::new("test", "default", "held-preceding-probe").unwrap();
        let request = json!({"model": "client-model", "input": "opaque"});
        let hit = opaque_hit(&manifest, &request);
        let expanded = expanded_from_hit(&manifest, hit);
        assert_eq!(expanded.candidates.len(), 2);
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .unwrap();
        let failure =
            routecodex_v3_provider_responses::V3ProviderFailureAction::recoverable("transport");
        for _ in 0..3 {
            health
                .record_provider_key_failure_action(
                    "r05_held_cooled",
                    Some("key1"),
                    Some("gpt-test"),
                    &failure,
                    now_ms,
                )
                .unwrap();
        }
        let held_permit = health
            .store()
            .acquire_provider_cooldown_rescue_probe_for_interface(
                "r05_held_cooled",
                "default",
                Some("key1"),
                Some("gpt-test"),
            )
            .unwrap()
            .expect("the test must own the cooled identity probe permit");
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
            direct_policy(),
        )
        .unwrap();
        let V3PlanExecutionOutcome::Selected { plan, .. } = outcome else {
            panic!("a held preceding probe must not replace the healthy candidate");
        };
        assert_eq!(plan.selected.candidate.provider_id, "r05_healthy_sibling");
        drop(held_permit);
    }

    #[test]
    fn preferred_candidate_still_respects_request_local_exclusion() {
        let manifest = test_manifest("preferred_exclusion");
        let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
        let scope =
            V3ProviderFailureSessionScope::new("test", "default", "preferred-exclusion").unwrap();
        let request = json!({"model": "client-model", "input": "opaque"});
        let hit = opaque_hit(&manifest, &request);
        let expanded = expanded_from_hit(&manifest, hit);
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .unwrap();
        let first = run_v3_plan_execution_operator(
            request.clone(),
            manifest.clone(),
            V3PlanExecutionTargetSource::Expanded(expanded.clone()),
            scope.clone(),
            health.clone(),
            BTreeSet::new(),
            now_ms,
            0,
            None,
            direct_policy(),
        )
        .unwrap();
        let V3PlanExecutionOutcome::Selected { plan, .. } = first else {
            panic!("the first pass must select the only candidate");
        };
        let preferred = plan.selected.clone();
        drop(plan);
        let exclusion = BTreeSet::from([candidate_key(&preferred.candidate)]);
        let masked = run_v3_plan_execution_operator(
            request,
            manifest,
            V3PlanExecutionTargetSource::Expanded(expanded),
            scope,
            health,
            exclusion,
            now_ms,
            0,
            Some(preferred),
            direct_policy(),
        )
        .unwrap();
        assert!(
            matches!(masked, V3PlanExecutionOutcome::Exhausted { .. }),
            "an excluded preferred candidate must not be reselected"
        );
    }

    #[test]
    fn preplan_uses_the_request_derived_nonzero_selection_sample() {
        let manifest = equal_priority_manifest(&["r05_sample_a", "r05_sample_b"]);
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope = V3ProviderFailureSessionScope::new("test", "default", "r05-preplan-sample")
            .expect("session scope");
        let request = json!({"model": "client-model", "input": "opaque"});
        let hit = opaque_hit(&manifest, &request);
        let expanded = expanded_from_hit(&manifest, hit.clone());
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
            direct_policy(),
        )
        .unwrap_or_else(|stop| {
            panic!(
                "nonzero preplan failed: {}",
                match stop {
                    V3PlanExecutionStop::Exhausted { .. } => "target exhaustion",
                    V3PlanExecutionStop::Failed(_) => "execution failed",
                    V3PlanExecutionStop::OperatorFault(_) => "operator fault",
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
        let hit = opaque_hit(&manifest, &request);
        let expanded = expanded_from_hit(&manifest, hit);
        let now_ms =
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()
                .unwrap();
        let disallowed_policy = V3PlanExecutionModePolicy::DirectEntry {
            entry_protocol: V3HubEntryProtocol::Responses,
            allowed_modes: vec![],
        };
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
            disallowed_policy.clone(),
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
            disallowed_policy.clone(),
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
            disallowed_policy,
        )
        .unwrap();
        let V3PlanExecutionOutcome::Failed(source) = outcome else {
            panic!("caller must receive the original typed failure");
        };
        assert_eq!(source, expected);
    }
}
