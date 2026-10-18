use super::operators::{
    execute_v3_operation_runner_error_err05_execution_decision,
    execute_v3_operation_runner_error_err06_client_projected, run_v3_err02_classified_operator,
    run_v3_error_03_target_local_action_operator, run_v3_error_04_target_exhaustion_operator,
};
use super::OperationRunnerError;
use routecodex_v3_error::{
    V3Error01SourceRaised, V3Error05ExecutionDecision, V3Error05RecoveryAdmissionWitness,
    V3Error06ClientProjected, V3ErrorActionScope,
};
use serde_json::Value;

pub(crate) fn run_v3_error_02_to_05_decision_operators(
    source_projection: Value,
    source: V3Error01SourceRaised,
    scope: V3ErrorActionScope,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
    recovery: Option<V3Error05RecoveryAdmissionWitness>,
) -> Result<(Value, V3Error05ExecutionDecision), OperationRunnerError> {
    let (classified_projection, classified) =
        run_v3_err02_classified_operator(source_projection, source, None)?;
    let (action_projection, action) = run_v3_error_03_target_local_action_operator(
        classified_projection,
        classified,
        scope,
        route_pool_remaining_after_exclusion,
    )?;
    let (exhaustion_projection, exhaustion) = run_v3_error_04_target_exhaustion_operator(
        action_projection,
        action,
        route_pool_remaining_after_exclusion,
        default_pool_available,
        same_provider_retry_available,
    )?;
    execute_v3_operation_runner_error_err05_execution_decision(
        exhaustion_projection,
        exhaustion,
        recovery,
    )
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
        let V3Error05ExecutionAction::WaitThenReselect { recovery } = decision.action else {
            panic!("candidate capacity must produce target-local reselection");
        };
        assert_eq!(recovery, witness);
        assert_eq!(decision.exhaustion.route_pool_remaining_after_exclusion, 1);
        assert!(!decision.exhaustion.default_pool_available);
        assert!(!decision.exhaustion.same_provider_retry_available);
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
