fn v3_direct_retired_continuation_error(
    body: &Value,
) -> Option<crate::shared::V3DirectSourceError> {
    body.get("previous_response_id")
        .is_some_and(|value| !value.is_null())
        .then(|| {
            runtime_source(
                "V3HubReqInbound02Normalized",
                "Responses continuation is retired: previous_response_id is unsupported",
            )
        })
}

fn v3_direct_admit_pinned_target(
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    last_external_http: &Option<V3ExternalHttpWitness>,
    trace: &[&'static str],
    hook_registry: &V3HookRegistry,
) -> Result<
    (
        routecodex_v3_target::V3Target10ConcreteProviderSelected,
        Option<V3RuntimeProviderAdmission>,
    ),
    V3ResponsesDirectRuntimeOutput,
> {
    match try_admit_v3_selected_target(&selected) {
        Ok(Some(admission)) => Ok((selected, Some(admission))),
        Ok(None) => Err(
            direct_runtime_helpers_stream::target_exhausted_output_with_observability(
                crate::shared::direct_plain_error(
                    V3ErrorSourceKind::TargetPoolExhausted,
                    "V3Target10ConcreteProviderSelected",
                    "provider_concurrency_busy",
                    "pinned provider concurrency is full",
                ),
                last_external_http.clone(),
                trace.to_vec(),
                hook_registry,
                None,
            ),
        ),
        Err(reason) => Err(direct_runtime_helpers_stream::source_failure_output(
            runtime_source("V3Target10ConcreteProviderSelected", reason),
            last_external_http.clone(),
            trace.to_vec(),
            hook_registry,
        )),
    }
}

fn v3_direct_selected_available_for_send(
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    expanded: Option<&routecodex_v3_target::V3Target09CandidateSetExpanded>,
    session_availability: &impl V3ProviderAvailabilityReader,
    provider_health: &V3ProviderFailureRuntimeHealth,
    failed_candidates: &BTreeSet<String>,
    now_epoch_ms: u64,
) -> bool {
    let selected_key = candidate_key(&selected.candidate);
    let selected_projection = session_availability.availability_for_interface(
        &selected.candidate.provider_id,
        &selected.candidate.interface_id,
        Some(&selected.candidate.auth_alias),
        Some(&selected.candidate.model_id),
        now_epoch_ms,
    );
    let selected_available_in_session = selected_projection.available
        || (!failed_candidates.contains(&selected_key)
            && routecodex_v3_target::V3TargetInterpreter::ignores_single_candidate_automatic_cooldown(
                expanded.map_or(1, |target| target.candidates.len()),
                &selected_projection.blocked_scopes,
            ));
    let session_alternative_available = expanded.is_some_and(|expanded| {
        expanded.candidates.iter().any(|candidate| {
            let key = candidate_key(candidate);
            key != selected_key
                && !failed_candidates.contains(&key)
                && session_availability
                    .availability_for_interface(
                        &candidate.provider_id,
                        &candidate.interface_id,
                        Some(&candidate.auth_alias),
                        Some(&candidate.model_id),
                        now_epoch_ms,
                    )
                    .available
        })
    });
    selected_available_in_session
        || (expanded.is_some_and(|expanded| expanded.candidates.len() > 1)
            && !session_alternative_available
            && !failed_candidates.contains(&selected_key)
            && provider_health
                .availability_for_interface(
                    &selected.candidate.provider_id,
                    &selected.candidate.interface_id,
                    Some(&selected.candidate.auth_alias),
                    Some(&selected.candidate.model_id),
                    now_epoch_ms,
                )
                .available)
}

pub(crate) struct V3DirectProviderFailurePolicyResult {
    decision: V3Error05ExecutionDecision,
    retry_selected: Option<Box<routecodex_v3_target::V3Target10ConcreteProviderSelected>>,
    event: Option<V3RuntimeProviderFailureObservation>,
    /// health-neutral 瞬态失败（SSE 流内/挂起）：重试与切换不经过 provider
    /// action gate / recovery witness 等待，立即执行；由调用方据此跳过
    /// `pending_provider_action_recovery` 的 gate 等待。
    retryable_transient: bool,
}

impl V3DirectProviderFailurePolicyResult {
    fn exhaust_if_residence_expired(
        &mut self,
        budget: &V3AttemptBudget,
    ) -> Result<(), DirectPolicyFailure> {
        if std::time::Instant::now() < budget.residence_deadline()
            || self.decision.action.is_terminal()
        {
            return Ok(());
        }
        let original_source = self
            .decision
            .exhaustion
            .local_action
            .classified
            .source
            .clone();
        let action_projection = serde_json::to_value(&self.decision.exhaustion.local_action)
            .map_err(|error| {
                direct_policy_failure(&original_source, "V3Error04TargetExhaustionDecision", error)
            })?;
        let (exhaustion_projection, exhaustion) =
            crate::operation_runner::run_v3_error_04_target_exhaustion_operator(
                action_projection,
                self.decision.exhaustion.local_action.clone(),
                0,
                false,
                false,
            )
            .map_err(|error| {
                direct_policy_failure(&original_source, "V3Error04TargetExhaustionDecision", error)
            })?;
        let (_, decision) =
            crate::operation_runner::execute_v3_operation_runner_error_err05_execution_decision(
                exhaustion_projection,
                exhaustion,
                None,
            )
            .map_err(|error| {
                direct_policy_failure(&original_source, "V3Error05ExecutionDecision", error)
            })?;
        self.decision = decision;
        if let Some(event) = self.event.as_mut() {
            event.action = "terminal_no_response".to_owned();
            event.next_provider_key = None;
        }
        Ok(())
    }
}

pub(crate) struct V3DirectProviderFailurePolicyContext<
    'ctx,
    R: V3ProviderAvailabilityReader + ?Sized,
> {
    failure_session_scope: &'ctx V3ProviderFailureSessionScope,
    provider_health: &'ctx V3ProviderFailureRuntimeHealth,
    availability: &'ctx R,
    expanded: Option<&'ctx routecodex_v3_target::V3Target09CandidateSetExpanded>,
    provider_pinned: bool,
    now_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DirectPolicyFailure {
    pub(crate) original_source: V3Error01SourceRaised,
    pub(crate) policy_failure: V3Error01SourceRaised,
}

pub(crate) struct V3DirectProviderFailurePolicyState<'state> {
    failed_candidates: &'state mut BTreeSet<String>,
    same_candidate_retries: &'state mut BTreeMap<String, usize>,
    trace: &'state mut Vec<&'static str>,
}

fn direct_policy_failure(
    original_source: &V3Error01SourceRaised,
    source_stage: &'static str,
    error: impl std::fmt::Display,
) -> DirectPolicyFailure {
    DirectPolicyFailure {
        original_source: original_source.clone(),
        // A policy failure is the diagnostic leaf, not another Source01 run.
        policy_failure: build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            source_stage,
            "v3_route_target_runtime_failure",
            error.to_string(),
        ),
    }
}

fn run_v3_direct_policy_error_02_to_05_decision_from_projection(
    source_projection: serde_json::Value,
    original_source: &V3Error01SourceRaised,
    scope: V3ErrorActionScope,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
    recovery: Option<routecodex_v3_error::V3Error05RecoveryAdmissionWitness>,
) -> Result<V3Error05ExecutionDecision, DirectPolicyFailure> {
    crate::operation_runner::run_v3_error_02_to_05_decision_operators(
        source_projection,
        original_source.clone(),
        scope,
        route_pool_remaining_after_exclusion,
        default_pool_available,
        same_provider_retry_available,
        recovery,
    )
    .map(|(_decision_projection, decision)| decision)
    .map_err(|error| direct_policy_failure(original_source, "V3Error05ExecutionDecision", error))
}

fn run_v3_direct_policy_error_02_to_05_decision(
    original_source: &V3Error01SourceRaised,
    scope: V3ErrorActionScope,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
    recovery: Option<routecodex_v3_error::V3Error05RecoveryAdmissionWitness>,
) -> Result<V3Error05ExecutionDecision, DirectPolicyFailure> {
    let source_projection = serde_json::to_value(original_source)
        .map_err(|error| direct_policy_failure(original_source, "V3Error02Classified", error))?;
    run_v3_direct_policy_error_02_to_05_decision_from_projection(
        source_projection,
        original_source,
        scope,
        route_pool_remaining_after_exclusion,
        default_pool_available,
        same_provider_retry_available,
        recovery,
    )
}

fn record_v3_direct_provider_failure_record(
    provider_health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: &V3Error01SourceRaised,
    now_epoch_ms: u64,
) -> crate::shared::V3DirectSourceResult<V3ProviderFailureRecord> {
    provider_health
        .record_provider_failure_record_from_source_for_interface(
            failure_session_scope,
            &selected.candidate.provider_id,
            &selected.candidate.interface_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            source,
            now_epoch_ms,
        )
        .map_err(|error| runtime_source("V3ProviderHealthStateMutated", error))
}

fn record_v3_direct_provider_success(
    receipt: &V3AttemptSuccessReceipt,
    provider_health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    now_epoch_ms: u64,
) -> crate::shared::V3DirectSourceResult<()> {
    provider_health
        .record_provider_success_in_failure_scope_for_interface(
            receipt,
            failure_session_scope,
            &selected.candidate.provider_id,
            &selected.candidate.interface_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            now_epoch_ms,
        )
        .map_err(|error| runtime_source("V3ProviderHealthStateMutated", error))
}

#[cfg(test)]
mod external_http_witness_tests {
    use super::*;
    use crate::hub_v1::external_http_witness_from_provider_error;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use std::time::Duration;

    fn attempt_budget_with_residence_timeout_ms(residence_timeout_ms: u64) -> V3AttemptBudget {
        let source = format!(
            r#"
version = 3
[pipelines.hub_v1]
skeleton = "hub_v1"
[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{ residence_timeout_ms = {residence_timeout_ms} }}
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "TEST_KEY" }}] }}
[providers.test.models.test-model]
capabilities = ["text"]
[route_groups.default.pools.default]
targets = [{{ kind = "provider_model", provider = "test", model = "test-model", priority = 1 }}]
"#
        );
        let manifest = compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(&source).expect("residence test authoring"),
        )
        .expect("residence test manifest");
        V3AttemptBudget::from_manifest(&manifest, "test").expect("residence test budget")
    }

    fn nonterminal_policy_result() -> V3DirectProviderFailurePolicyResult {
        let source = build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderRespInbound01Raw",
            "provider_http_502",
            "provider failure with another candidate",
        );
        let witness = routecodex_v3_error::V3Error05RecoveryAdmissionWitness::new(
            V3ProviderFailureSessionScope::new("server", "group", "session")
                .expect("failure session scope"),
            "provider-a:key-a:model-a",
            "provider_http_502",
            1,
        )
        .expect("recovery witness");
        let decision = run_v3_direct_policy_error_02_to_05_decision(
            &source,
            V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "key-a".to_string(),
                model_id: "model-a".to_string(),
            },
            1,
            false,
            false,
            Some(witness),
        )
        .expect("nonterminal policy decision");
        assert!(matches!(
            decision.action,
            V3Error05ExecutionAction::WaitThenReselect { .. }
        ));
        V3DirectProviderFailurePolicyResult {
            decision,
            retry_selected: None,
            event: Some(V3RuntimeProviderFailureObservation {
                provider_key: "provider-a:key-a:model-a".to_string(),
                provider_id: "provider-a".to_string(),
                auth_alias: Some("key-a".to_string()),
                model_id: "model-a".to_string(),
                status: 502,
                action: "switch_provider".to_string(),
                next_provider_key: Some("provider-b:key-b:model-b".to_string()),
                wait_ms: Some(10),
                ..Default::default()
            }),
            retryable_transient: false,
        }
    }

    #[test]
    fn direct_retains_exact_real_http_error_including_upstream_502() {
        let response = routecodex_v3_provider_responses::V3ProviderHttpFailure {
            request_id: "request".into(),
            provider_id: "provider".into(),
            status: 429,
            headers: vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"text/html; charset=utf-8".to_vec(),
            }],
            body: b"<html>limit</html>".to_vec(),
            body_read_failure: None,
        };
        let error = V3ProviderError::HttpStatus {
            response: Box::new(response.clone()),
        };
        let witness = external_http_witness_from_provider_error(&error).unwrap();
        assert_eq!(witness.status(), 429);
        assert_eq!(witness.headers()[0].1, b"text/html; charset=utf-8");
        assert_eq!(witness.body(), response.body);
        // An upstream 502 is real evidence even though it never reaches a client.
        let upstream_502 = V3ProviderError::HttpStatus {
            response: Box::new(routecodex_v3_provider_responses::V3ProviderHttpFailure {
                status: 502,
                body: b"bad gateway".to_vec(),
                ..response
            }),
        };
        let witness = external_http_witness_from_provider_error(&upstream_502).unwrap();
        assert_eq!(witness.status(), 502);
        assert_eq!(witness.body(), b"bad gateway");
    }

    #[test]
    fn direct_policy_sdk_failure_preserves_source_and_terminal_witness() {
        let original_source = build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_http_200",
            "provider returned HTTP 200",
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(200),
                code: Some("HTTP_200".to_string()),
                provider_id: Some("provider-a".to_string()),
                upstream_request_id: None,
                message: Some("provider returned HTTP 200".to_string()),
            },
        );
        let failure = run_v3_direct_policy_error_02_to_05_decision_from_projection(
            json!(null),
            &original_source,
            V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "key-a".to_string(),
                model_id: "model-a".to_string(),
            },
            1,
            false,
            false,
            None,
        )
        .expect_err("the SDK must reject a non-object Error02 projection");

        assert_eq!(failure.original_source, original_source);
        assert_eq!(
            failure.policy_failure.source_kind,
            V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(
            failure.policy_failure.source_stage,
            "V3Error05ExecutionDecision"
        );
        assert_eq!(
            failure.policy_failure.code,
            "v3_route_target_runtime_failure"
        );
        assert!(failure.policy_failure.internal_error.is_none());
        assert!(failure.policy_failure.external_error.is_none());

        let witness = V3ExternalHttpWitness::new(
            200,
            vec![("content-type".into(), b"application/json".to_vec())],
            br#"{"id":"provider-response"}"#.to_vec(),
        );
        let policy_failure = failure.policy_failure.clone();
        let output = policy_failure_output_with_observability(
            failure.clone(),
            Some(witness.clone()),
            Vec::new(),
            None,
        );
        assert_eq!(
            output.diagnostic_source.as_ref(),
            Some(&failure.policy_failure)
        );
        assert_eq!(output.diagnostic_cause.as_ref(), Some(&original_source));
        assert_eq!(
            output.terminal_disposition,
            Some(V3ProviderTerminalDisposition::ExternalHttp(witness))
        );
        assert_eq!(output.error_chain, None);

        let no_response = policy_failure_output_with_observability(failure, None, Vec::new(), None);
        assert_eq!(
            no_response.terminal_disposition,
            Some(V3ProviderTerminalDisposition::NoResponse)
        );
        assert_eq!(
            no_response.diagnostic_source.as_ref(),
            Some(&policy_failure)
        );
        assert_eq!(
            no_response.diagnostic_cause.as_ref(),
            Some(&original_source)
        );
        assert_eq!(no_response.error_chain, None);
    }

    #[test]
    fn residence_expiry_converts_nonterminal_decision_to_terminal_no_response() {
        let mut policy_result = nonterminal_policy_result();
        let original_source = policy_result
            .decision
            .exhaustion
            .local_action
            .classified
            .source
            .clone();
        let budget = attempt_budget_with_residence_timeout_ms(1);
        std::thread::sleep(Duration::from_millis(10));

        policy_result
            .exhaust_if_residence_expired(&budget)
            .expect("residence expiry must execute SDK04 and SDK05");

        assert_eq!(
            policy_result.decision.action,
            V3Error05ExecutionAction::ProjectTerminal
        );
        assert_eq!(
            policy_result
                .decision
                .exhaustion
                .local_action
                .classified
                .source,
            original_source
        );
        let event = policy_result.event.expect("provider failure event");
        assert_eq!(event.action, "terminal_no_response");
        assert_eq!(event.next_provider_key, None);
    }

    #[test]
    fn unexpired_residence_keeps_nonterminal_decision_and_event() {
        let mut policy_result = nonterminal_policy_result();
        let original_decision = policy_result.decision.clone();
        let original_event = policy_result.event.clone();
        let budget = attempt_budget_with_residence_timeout_ms(60_000);

        policy_result
            .exhaust_if_residence_expired(&budget)
            .expect("unexpired residence must not enter the SDK");

        assert_eq!(policy_result.decision, original_decision);
        assert_eq!(policy_result.event, original_event);
    }
}

pub(crate) async fn run_v3_direct_provider_failure_policy<R: V3ProviderAvailabilityReader>(
    context: &V3DirectProviderFailurePolicyContext<'_, R>,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: V3Error01SourceRaised,
    status: u16,
    state: &mut V3DirectProviderFailurePolicyState<'_>,
) -> Result<V3DirectProviderFailurePolicyResult, DirectPolicyFailure> {
    if matches!(source.source_kind, V3ErrorSourceKind::ClientDisconnect) {
        let decision = run_v3_direct_policy_error_02_to_05_decision(
            &source,
            V3ErrorActionScope::ProviderInstance {
                provider_id: selected.candidate.provider_id.clone(),
            },
            0,
            false,
            false,
            None,
        )?;
        return Ok(V3DirectProviderFailurePolicyResult {
            decision,
            retry_selected: None,
            event: None,
            retryable_transient: false,
        });
    }
    let observed_status = source
        .external_error
        .as_ref()
        .and_then(|error| error.status)
        .filter(|external_status| *external_status >= 400)
        .unwrap_or(status);
    // A provider HTTP error that really arrived carries an upstream status and
    // must not be classified as a transport failure. Only a response-less
    // transport failure keeps the exact-identity last-candidate health effect.
    let has_completed_upstream_http_error = source
        .external_error
        .as_ref()
        .and_then(|error| error.status)
        .is_some_and(|external_status| external_status >= 400);
    let is_response_processing_failure =
        routecodex_v3_error::is_v3_recoverable_response_processing_source(&source);
    let is_health_neutral_failure = is_response_processing_failure
        || crate::provider_failure_runtime_policy::is_health_neutral_request_compat_failure(
            source.source_stage,
            source
                .external_error
                .as_ref()
                .and_then(|error| error.code.as_deref()),
        );
    // A provider transport failure has no upstream HTTP error status. It is a
    // typed provider failure, so the last-candidate terminal boundary must not
    // suppress its exact-identity health effect.
    let is_transport_failure = source.source_kind == V3ErrorSourceKind::ProviderFailure
        && source.code == "provider_transport_error"
        && !has_completed_upstream_http_error
        && observed_status == 502;
    let failed_key = candidate_key(&selected.candidate);
    let expanded_candidates = match (context.expanded, context.provider_pinned) {
        (Some(expanded), _) => Some(&expanded.candidates),
        (None, true) => None,
        (None, false) => {
            return Err(direct_policy_failure(
                &source,
                "V3Target09CandidateSetExpanded",
                "routed candidate set missing",
            ))
        }
    };
    let request_local_excluded = BTreeSet::from([failed_key.clone()]);
    state
        .failed_candidates
        .extend(request_local_excluded.clone());
    let failed_with_current = state.failed_candidates.clone();
    let mut remaining = expanded_candidates.map_or(0, |expanded_candidates| {
        remaining_available_candidates(
            expanded_candidates,
            context.availability,
            &failed_with_current,
        )
    });
    let mut next_provider_key = expanded_candidates.and_then(|expanded_candidates| {
        first_remaining_available_candidate_key(
            expanded_candidates,
            context.availability,
            &failed_with_current,
        )
    });
    if remaining == 0 {
        if let Some(candidates) = expanded_candidates {
            if candidates.len() > 1 {
                remaining = candidates
                    .iter()
                    .filter(|candidate| {
                        let key = candidate_key(candidate);
                        !failed_with_current.contains(&key)
                            && context
                                .provider_health
                                .availability_for_interface(
                                    &candidate.provider_id,
                                    &candidate.interface_id,
                                    Some(&candidate.auth_alias),
                                    Some(&candidate.model_id),
                                    context.now_epoch_ms,
                                )
                                .available
                    })
                    .count();
                if next_provider_key.is_none() {
                    next_provider_key = candidates.iter().find_map(|candidate| {
                        let key = candidate_key(candidate);
                        (!failed_with_current.contains(&key)
                            && context
                                .provider_health
                                .availability_for_interface(
                                    &candidate.provider_id,
                                    &candidate.interface_id,
                                    Some(&candidate.auth_alias),
                                    Some(&candidate.model_id),
                                    context.now_epoch_ms,
                                )
                                .available)
                            .then(|| key)
                    });
                }
            }
        }
    }
    // Health changes are allowed only after the captured target proves that
    // another eligible, untried identity can take this request.
    let health_record = if is_health_neutral_failure || (remaining == 0 && !is_transport_failure) {
        V3ProviderFailureRecord {
            scope_label: failed_key.clone(),
            provider_key: failed_key.clone(),
            state: if is_response_processing_failure {
                "request_local_response_processing"
            } else if is_health_neutral_failure {
                "request_local_provider_compat"
            } else {
                "last_candidate_terminal"
            }
            .to_string(),
            failure_count: 0,
            cooldown_until_ms: None,
            reason: (!source.message.trim().is_empty()).then(|| source.message.clone()),
        }
    } else {
        match record_v3_direct_provider_failure_record(
            context.provider_health,
            context.failure_session_scope,
            selected,
            &source,
            context.now_epoch_ms,
        ) {
            Ok(record) => record,
            Err(Ok(policy_failure)) => {
                return Err(DirectPolicyFailure {
                    original_source: source.clone(),
                    policy_failure,
                })
            }
            Err(Err(fault)) => {
                return Err(DirectPolicyFailure {
                    original_source: fault.original_source.unwrap_or_else(|| source.clone()),
                    policy_failure: fault.policy_failure,
                })
            }
        }
    };
    let provider_key_model_scope = V3ErrorActionScope::ProviderKeyModel {
        provider_id: selected.candidate.provider_id.clone(),
        auth_alias: selected.candidate.auth_alias.clone(),
        model_id: selected.candidate.model_id.clone(),
    };
    let recovery_record = if remaining > 0 && !is_health_neutral_failure {
        Some(
            context
                .provider_health
                .record_provider_action_failure_in_scope_for_interface(
                    context.failure_session_scope,
                    &selected.candidate.provider_id,
                    &selected.candidate.interface_id,
                    Some(&selected.candidate.auth_alias),
                    Some(&selected.candidate.model_id),
                    &source.code,
                )
                .map_err(|error| {
                    direct_policy_failure(&source, "V3ProviderActionGateAdmission", error)
                })?,
        )
    } else {
        None
    };
    let recovery_witness = match recovery_record.as_ref() {
        Some(record) => Some(record.recovery_witness().map_err(|error| {
            direct_policy_failure(&source, "V3ProviderActionGateAdmission", error)
        })?),
        None if remaining > 0 => Some(
            routecodex_v3_error::V3Error05RecoveryAdmissionWitness::new(
                context.failure_session_scope.clone(),
                failed_key.clone(),
                source.code.clone(),
                1,
            )
            .map_err(|error| {
                direct_policy_failure(&source, "V3ProviderActionGateAdmission", error)
            })?,
        ),
        None => None,
    };
    let decision = run_v3_direct_policy_error_02_to_05_decision(
        &source,
        provider_key_model_scope,
        remaining,
        false,
        false,
        recovery_witness,
    )?;
    state
        .trace
        .extend(V3_ERROR_CHAIN_NODE_IDS.iter().take(5).copied());
    if matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenReselect { .. }
    ) {
        state.trace.push("V3TargetLocalReselected");
        let event = Some(build_v3_direct_provider_failure_observation(
            selected,
            observed_status,
            &source,
            &health_record,
            "switch_provider",
            next_provider_key,
            Some(
                recovery_record
                    .as_ref()
                    .map_or(0, |record| record.minimum_delay_ms),
            ),
        ));
        return Ok(V3DirectProviderFailurePolicyResult {
            decision,
            retry_selected: None,
            event,
            // Candidate-scoped request/provider compatibility failures are
            // health-neutral and must reselect immediately without entering
            // the provider action gate.
            retryable_transient: is_health_neutral_failure,
        });
    }
    if matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenRetrySame { .. }
    ) {
        return Err(direct_policy_failure(
            &source,
            "V3Error05ExecutionDecision",
            "retry_same is not a production provider failure action",
        ));
    }
    if !matches!(decision.action, V3Error05ExecutionAction::ProjectTerminal) {
        return Err(direct_policy_failure(
            &source,
            "V3Error05ExecutionDecision",
            format!(
                "provider failure produced invalid Error05 action {:?}",
                decision.action
            ),
        ));
    }
    state.trace.push("V3Error06ClientProjected");
    let event = Some(build_v3_direct_provider_failure_observation(
        selected,
        observed_status,
        &source,
        &health_record,
        "terminal_default_floor_exhausted",
        None,
        None,
    ));
    Ok(V3DirectProviderFailurePolicyResult {
        decision,
        retry_selected: None,
        event,
        retryable_transient: false,
    })
}

fn build_v3_direct_provider_failure_observation(
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    status: u16,
    source: &V3Error01SourceRaised,
    health_record: &V3ProviderFailureRecord,
    action: &str,
    next_provider_key: Option<String>,
    wait_ms: Option<u64>,
) -> V3RuntimeProviderFailureObservation {
    let response_processing_failure =
        routecodex_v3_error::is_v3_recoverable_response_processing_source(source);
    let observed_status = if response_processing_failure {
        match source.internal_error.as_ref().map(|error| error.lane) {
            Some(routecodex_v3_error::V3InternalErrorLane::Request) => 598,
            _ => 599,
        }
    } else {
        source
            .external_error
            .as_ref()
            .and_then(|external| external.status)
            .filter(|external_status| *external_status >= 400)
            .unwrap_or(status)
    };
    V3RuntimeProviderFailureObservation {
        provider_key: candidate_key(&selected.candidate),
        provider_id: selected.candidate.provider_id.clone(),
        auth_alias: Some(selected.candidate.auth_alias.clone()),
        model_id: selected.candidate.model_id.clone(),
        status: observed_status,
        error_type: Some(source.code.clone()),
        external_error_kind: source
            .external_error
            .as_ref()
            .map(|external| external_kind_label(&external.kind).to_string()),
        external_error_code: source
            .external_error
            .as_ref()
            .and_then(|external| external.code.clone()),
        external_error_status: source
            .external_error
            .as_ref()
            .and_then(|external| external.status)
            .or_else(|| {
                (response_processing_failure && (200..300).contains(&status)).then_some(status)
            }),
        internal_code: source
            .internal_error
            .as_ref()
            .map(|internal| internal.internal_code.to_string()),
        upstream_request_id: source
            .external_error
            .as_ref()
            .and_then(|external| external.upstream_request_id.clone()),
        message: source.message.clone(),
        failure_count: health_record.failure_count,
        health_state: health_record.state.clone(),
        cooldown_until_ms: health_record.cooldown_until_ms,
        action: action.to_string(),
        next_provider_key,
        wait_ms,
        diagnostic_source: Some(source.clone()),
        failed_attempt_evidence: None,
    }
}

pub(crate) fn publish_v3_direct_provider_failure_event(
    sink: Option<&V3RuntimeProviderFailureEventSink>,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    entry_protocol: &str,
    transport: &str,
    status: Option<u16>,
    provider_failure_events: &[V3RuntimeProviderFailureObservation],
    event: &V3RuntimeProviderFailureObservation,
    attempts: usize,
) {
    if let Some(sink) = sink {
        let mut observability = build_v3_direct_runtime_observability(
            selected,
            entry_protocol,
            transport,
            status,
            "failed",
            provider_failure_events.to_vec(),
        );
        observability.attempts = Some(attempts);
        sink(&observability, event);
    }
}

fn external_kind_label(kind: &V3ExternalErrorKind) -> &'static str {
    match kind {
        V3ExternalErrorKind::Provider => "provider",
        V3ExternalErrorKind::Upstream => "upstream",
        V3ExternalErrorKind::Client => "client",
        V3ExternalErrorKind::Transport => "transport",
    }
}

pub(crate) fn build_v3_direct_runtime_observability(
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    entry_protocol: &str,
    transport: &str,
    provider_status: Option<u16>,
    response_status: &str,
    provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
) -> V3RuntimeObservability {
    V3RuntimeObservability {
        entry_protocol: entry_protocol.to_string(),
        execution_mode: "direct".to_string(),
        transport: transport.to_string(),
        routing_group_id: Some(selected.route.routing_group_id.clone()),
        route_classification_reason: Some(selected.route.route_classification_reason.clone()),
        pool_id: Some(selected.route.pool_id.clone()),
        provider_id: Some(selected.candidate.provider_id.clone()),
        auth_alias: Some(selected.candidate.auth_alias.clone()),
        provider_key: Some(candidate_key(&selected.candidate)),
        provider_type: Some(selected.candidate.provider_type.clone()),
        model_id: Some(selected.candidate.model_id.clone()),
        wire_model: Some(selected.candidate.wire_model.clone()),
        provider_status,
        response_status: Some(response_status.to_string()),
        finish_reason: None,
        attempts: Some(selected.attempts),
        unavailable_candidates: selected.unavailable_candidates.clone(),
        provider_failure_events,
        target_path: selected.candidate.path.clone(),
        usage: None,
        timing: None,
    }
}

fn v3_direct_client_transport_label(payload: &V3Resp15ClientPayload) -> &str {
    match &payload.body {
        V3ClientBody::Json(_) => "json",
        V3ClientBody::Bytes(_) => "bytes",
        V3ClientBody::Sse(_) => "sse",
        V3ClientBody::CommittedSse(_) => "sse",
    }
}

include!("direct_runtime_helpers_stream.rs");
include!("direct_response_thinking_compat.rs");
