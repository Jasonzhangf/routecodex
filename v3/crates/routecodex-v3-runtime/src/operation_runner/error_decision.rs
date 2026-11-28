use super::operators::{
    execute_v3_operation_runner_error_err06_client_projected, Err02ClassifiedOperator,
    Err05ExecutionDecisionOperator, V3Error03TargetLocalActionOperator,
    V3Error04TargetExhaustionOperator,
};
use super::run_precompiled_error_02_to_05;
use super::OperationRunnerError;
use pipeline_runtime::Operator;
use routecodex_v3_error::{
    V3Error01SourceRaised, V3Error02Classified, V3Error03TargetLocalAction,
    V3Error04TargetExhaustionDecision, V3Error05ExecutionDecision,
    V3Error05RecoveryAdmissionWitness, V3Error06ClientProjected, V3ErrorActionScope,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

pub(crate) fn run_v3_error_02_to_05_decision_operators(
    source_projection: Value,
    source: V3Error01SourceRaised,
    scope: V3ErrorActionScope,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
    recovery: Option<V3Error05RecoveryAdmissionWitness>,
) -> Result<(Value, V3Error05ExecutionDecision), OperationRunnerError> {
    run_v3_error_02_to_05_decision_operators_with_target_recovery(
        source_projection,
        source,
        scope,
        route_pool_remaining_after_exclusion,
        default_pool_available,
        same_provider_retry_available,
        recovery,
        false,
    )
}

pub(crate) fn run_v3_error_02_to_05_decision_operators_with_target_recovery(
    source_projection: Value,
    source: V3Error01SourceRaised,
    scope: V3ErrorActionScope,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
    recovery: Option<V3Error05RecoveryAdmissionWitness>,
    target_recovery_pending: bool,
) -> Result<(Value, V3Error05ExecutionDecision), OperationRunnerError> {
    let err02_output = Arc::new(Mutex::new(None));
    let err03_output = Arc::new(Mutex::new(None));
    let err04_output = Arc::new(Mutex::new(None));
    let err05_output = Arc::new(Mutex::new(None));

    // Err03 and Err04 need the typed outputs produced by the preceding
    // precompiled node. Their identities are fixed by the canonical graph, so
    // the side outputs are bound before the single slice execution starts.
    let classified = source.clone();
    let classified = routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01(classified);
    let action = routecodex_v3_error::build_v3_error_03_target_local_action_from_v3_error_02(
        classified.clone(),
        scope.clone(),
        route_pool_remaining_after_exclusion,
    );
    let exhaustion =
        routecodex_v3_error::build_v3_error_04_target_exhaustion_decision_with_target_recovery(
            action.clone(),
            route_pool_remaining_after_exclusion,
            default_pool_available,
            same_provider_retry_available,
            target_recovery_pending,
        );
    let operators: Vec<Box<dyn Operator>> = vec![
        Box::new(Err02ClassifiedOperator::new(
            source,
            None,
            Arc::clone(&err02_output),
        )),
        Box::new(V3Error03TargetLocalActionOperator::new(
            classified,
            scope,
            route_pool_remaining_after_exclusion,
            Arc::clone(&err03_output),
        )),
        Box::new(V3Error04TargetExhaustionOperator::new(
            action,
            route_pool_remaining_after_exclusion,
            default_pool_available,
            same_provider_retry_available,
            target_recovery_pending,
            Arc::clone(&err04_output),
        )),
        Box::new(Err05ExecutionDecisionOperator::new(
            exhaustion.clone(),
            recovery,
            Arc::clone(&err05_output),
        )),
    ];
    let projection = run_precompiled_error_02_to_05(source_projection, operators)?;

    let err02 = err02_output
        .lock()
        .map_err(|_| OperationRunnerError::new("Err02 side-output holder is poisoned"))?
        .take()
        .ok_or_else(|| OperationRunnerError::new("Err02 omitted its typed output"))?
        .map_err(OperationRunnerError::new)?;
    let err03 = err03_output
        .lock()
        .map_err(|_| OperationRunnerError::new("Err03 side-output holder is poisoned"))?
        .take()
        .ok_or_else(|| OperationRunnerError::new("Err03 omitted its typed output"))?;
    let err04 = err04_output
        .lock()
        .map_err(|_| OperationRunnerError::new("Err04 side-output holder is poisoned"))?
        .take()
        .ok_or_else(|| OperationRunnerError::new("Err04 omitted its typed output"))?;
    let err05 = err05_output
        .lock()
        .map_err(|_| OperationRunnerError::new("Err05 side-output holder is poisoned"))?
        .take()
        .ok_or_else(|| OperationRunnerError::new("Err05 omitted its typed output"))?;
    let _: (
        V3Error02Classified,
        V3Error03TargetLocalAction,
        V3Error04TargetExhaustionDecision,
    ) = (err02, err03, err04);
    Ok((projection, err05))
}

pub(crate) fn run_v3_error_06_terminal_projection_operator(
    decision_projection: Value,
    decision: V3Error05ExecutionDecision,
) -> Result<Option<(Value, V3Error06ClientProjected)>, OperationRunnerError> {
    let Ok(terminal) = decision.try_into_terminal() else {
        return Ok(None);
    };
    execute_v3_operation_runner_error_err06_client_projected(decision_projection, terminal)
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operation_runner::operators::{
        run_v3_err01_source_raised_operator, V3Err01SourceInput,
    };
    use routecodex_v3_error::{
        V3Error05ExecutionAction, V3ErrorActionScope, V3ErrorSourceKind, V3ExternalErrorKind,
        V3ExternalErrorLink, V3ProviderFailureSessionScope,
    };
    use serde_json::json;

    fn provider_source() -> (Value, V3Error01SourceRaised) {
        run_v3_err01_source_raised_operator(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderRespInbound01Raw",
            "provider_transport_failure",
            "provider transport failed",
            V3Err01SourceInput::External(V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: None,
                code: Some("provider_transport_failure".to_string()),
                provider_id: Some("provider-a".to_string()),
                upstream_request_id: None,
                message: Some("provider transport failed".to_string()),
            }),
        )
        .expect("Err01 fixture must execute through the canonical SDK node")
    }

    fn provider_scope() -> V3ErrorActionScope {
        V3ErrorActionScope::ProviderKeyModel {
            provider_id: "provider-a".to_string(),
            auth_alias: "key-a".to_string(),
            model_id: "model-a".to_string(),
        }
    }

    #[test]
    fn composition_preserves_recovery_witness_and_availability_flags() {
        let (source_projection, source) = provider_source();
        let failure_scope =
            V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a").unwrap();
        let witness = V3Error05RecoveryAdmissionWitness::new(
            failure_scope,
            "provider-a:key-a:model-a",
            "provider_transport_failure",
            19,
        )
        .unwrap();

        let (projection, decision) = run_v3_error_02_to_05_decision_operators(
            source_projection,
            source,
            provider_scope(),
            1,
            false,
            false,
            Some(witness.clone()),
        )
        .expect("Error02 through Error05 must compose through canonical SDK nodes");

        assert_eq!(projection, serde_json::to_value(&decision).unwrap());
        let V3Error05ExecutionAction::Reselect = decision.action else {
            panic!("candidate capacity must produce target-local reselection");
        };
        assert!(decision.action.recovery_witness().is_none());
        assert_eq!(decision.exhaustion.route_pool_remaining_after_exclusion, 1);
        assert!(!decision.exhaustion.default_pool_available);
        assert!(!decision.exhaustion.same_provider_retry_available);
    }

    #[test]
    fn cooled_target_handoff_keeps_zero_available_without_fabricating_provider_admission() {
        let (projection, source) = provider_source();
        let original_source = source.clone();
        let (_, decision) = run_v3_error_02_to_05_decision_operators_with_target_recovery(
            projection,
            source,
            provider_scope(),
            0,
            false,
            false,
            None,
            true,
        )
        .unwrap();
        assert_eq!(
            decision.exhaustion.local_action.classified.source,
            original_source
        );
        assert_eq!(decision.exhaustion.route_pool_remaining_after_exclusion, 0);
        assert!(!decision.exhaustion.default_pool_available);
        assert!(!decision.exhaustion.same_provider_retry_available);
        assert!(decision.exhaustion.target_recovery_pending);
        assert!(!decision.exhaustion.target_exhausted);
        assert_eq!(decision.action, V3Error05ExecutionAction::ReevaluateTarget);
        assert!(decision.action.recovery_witness().is_none());
        assert!(decision.try_into_terminal().is_err());
    }

    #[test]
    fn terminal_composition_requires_the_existing_terminal_proof() {
        let (source_projection, source) = provider_source();
        let (decision_projection, decision) = run_v3_error_02_to_05_decision_operators(
            source_projection,
            source,
            provider_scope(),
            0,
            false,
            false,
            None,
        )
        .expect("terminal composition must execute through canonical SDK nodes");
        assert_eq!(decision.action, V3Error05ExecutionAction::ProjectTerminal);
        assert!(decision.clone().try_into_terminal().is_ok());

        let (projection, projected) =
            run_v3_error_06_terminal_projection_operator(decision_projection, decision)
                .expect("validated terminal proof must execute Error06")
                .expect("terminal proof must produce an internal projection");
        assert_eq!(projection, serde_json::to_value(&projected).unwrap());
        assert_eq!(projected.status, 502);
    }

    #[test]
    fn nonterminal_composition_does_not_enter_error_06() {
        let (source_projection, source) = provider_source();
        let failure_scope =
            V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a").unwrap();
        let witness = V3Error05RecoveryAdmissionWitness::new(
            failure_scope,
            "provider-a:key-a:model-a",
            "provider_transport_failure",
            23,
        )
        .unwrap();
        let (decision_projection, decision) = run_v3_error_02_to_05_decision_operators(
            source_projection,
            source,
            provider_scope(),
            1,
            false,
            false,
            Some(witness),
        )
        .expect("recoverable composition must execute through canonical SDK nodes");

        assert!(
            run_v3_error_06_terminal_projection_operator(decision_projection, decision)
                .expect("nonterminal proof failure is not an SDK failure")
                .is_none()
        );
    }

    #[test]
    fn canonical_sdk_failure_is_returned_without_typed_reconstruction() {
        let (_, source) = provider_source();
        let error = run_v3_error_02_to_05_decision_operators(
            json!(null),
            source,
            provider_scope(),
            1,
            false,
            false,
            None,
        )
        .expect_err("the canonical Error02 input contract must reject a non-object value");

        assert!(!error.message.is_empty());
    }
}
