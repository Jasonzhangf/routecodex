use crate::operation_runner::{
    run_v3_single_node_operator, OperationRunnerError, V3OperationGraph,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_error::{
    build_v3_error_05_execution_decision_from_v3_error_04, V3Error04TargetExhaustionDecision,
    V3Error05ExecutionDecision, V3Error05RecoveryAdmissionWitness,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.error.err05_execution_decision";
const OPERATOR_VERSION: &str = "1";
const NODE_ID: &str = "error_err05_execution_decision";

struct Err05ExecutionDecisionOperator {
    exhaustion: Mutex<Option<V3Error04TargetExhaustionDecision>>,
    recovery: Mutex<Option<V3Error05RecoveryAdmissionWitness>>,
    output: Arc<Mutex<Option<V3Error05ExecutionDecision>>>,
}

impl Operator for Err05ExecutionDecisionOperator {
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

    fn execute(&self, _input: Value, _: &OperatorContext) -> Result<Value, String> {
        let exhaustion = self
            .exhaustion
            .lock()
            .map_err(|_| "Error05 exhaustion holder is poisoned".to_string())?
            .take()
            .ok_or_else(|| "Error05 exhaustion decision was already consumed".to_string())?;
        let recovery = self
            .recovery
            .lock()
            .map_err(|_| "Error05 recovery witness holder is poisoned".to_string())?
            .take();
        let decision = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion, recovery);
        let output = serde_json::to_value(&decision)
            .map_err(|error| format!("Error05 decision serialization failed: {error}"))?;
        *self
            .output
            .lock()
            .map_err(|_| "Error05 output holder is poisoned".to_string())? = Some(decision);
        Ok(output)
    }
}

pub(crate) fn execute_v3_operation_runner_error_err05_execution_decision(
    input: Value,
    exhaustion: V3Error04TargetExhaustionDecision,
    recovery: Option<V3Error05RecoveryAdmissionWitness>,
) -> Result<(Value, V3Error05ExecutionDecision), OperationRunnerError> {
    let output = Arc::new(Mutex::new(None));
    let runner_result = run_v3_single_node_operator(
        V3OperationGraph::Error,
        NODE_ID,
        input,
        Err05ExecutionDecisionOperator {
            exhaustion: Mutex::new(Some(exhaustion)),
            recovery: Mutex::new(recovery),
            output: Arc::clone(&output),
        },
    );
    let typed_output = output
        .lock()
        .map_err(|_| OperationRunnerError::new("Error05 output holder is poisoned"))?
        .take();
    match (runner_result, typed_output) {
        (Ok(projection), Some(decision)) => Ok((projection, decision)),
        (Err(error), _) => Err(error),
        (Ok(_), None) => Err(OperationRunnerError::new(
            "Error05 operator completed without typed output",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_error::{
        build_v3_error_01_source_raised, build_v3_error_02_classified_from_v3_error_01,
        build_v3_error_03_target_local_action_from_v3_error_02,
        build_v3_error_04_target_exhaustion_decision_with_provider_availability,
        V3Error05ExecutionAction, V3ErrorActionScope, V3ErrorSourceKind,
        V3ProviderFailureSessionScope,
    };
    fn exhaustion(
        source_kind: V3ErrorSourceKind,
        code: &str,
        message: &str,
        candidates_remaining: usize,
        default_pool_available: bool,
    ) -> V3Error04TargetExhaustionDecision {
        let scope = if source_kind == V3ErrorSourceKind::ProviderFailure {
            V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "key-a".to_string(),
                model_id: "model-a".to_string(),
            }
        } else {
            V3ErrorActionScope::None
        };
        let source =
            build_v3_error_01_source_raised(source_kind, "V3ProviderResp14Raw", code, message);
        let classified = build_v3_error_02_classified_from_v3_error_01(source);
        let action = build_v3_error_03_target_local_action_from_v3_error_02(
            classified,
            scope,
            candidates_remaining,
        );
        build_v3_error_04_target_exhaustion_decision_with_provider_availability(
            action,
            candidates_remaining,
            default_pool_available,
            false,
        )
    }

    #[test]
    fn recoverable_decision_preserves_exact_witness_and_stays_nonterminal() {
        let exhaustion = exhaustion(
            V3ErrorSourceKind::ProviderFailure,
            "provider_transport_failure",
            "provider transport failed",
            1,
            false,
        );
        let upstream_projection = serde_json::to_value(&exhaustion).unwrap();
        let scope = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
            .unwrap()
            .with_transport_handoff_scope("pipeline-a", 4444, 17)
            .unwrap();
        let witness = V3Error05RecoveryAdmissionWitness::new(
            scope,
            "provider-a:key-a:model-a",
            "provider_transport_failure",
            41,
        )
        .unwrap();

        let (projection, decision) = execute_v3_operation_runner_error_err05_execution_decision(
            upstream_projection,
            exhaustion,
            Some(witness),
        )
        .expect("recoverable Error05 must execute through the canonical SDK node");

        assert_eq!(projection, serde_json::to_value(&decision).unwrap());
        let V3Error05ExecutionAction::WaitThenReselect { recovery } = &decision.action else {
            panic!("candidate capacity must produce target-local reselection");
        };
        assert_eq!(recovery.server_id(), "server-a");
        assert_eq!(recovery.routing_group(), "group-a");
        assert_eq!(recovery.session_id(), "session-a");
        assert_eq!(
            recovery.failure_session_scope().transport_handoff_scope(),
            Some(("pipeline-a", 4444, 17))
        );
        assert_eq!(
            recovery.provider_runtime_identity(),
            "provider-a:key-a:model-a"
        );
        assert_eq!(
            recovery.normalized_error_family(),
            "provider_transport_failure"
        );
        assert_eq!(recovery.generation(), 41);
        assert!(decision.try_into_terminal().is_err());
    }

    #[test]
    fn provider_exhaustion_passes_the_existing_terminal_proof() {
        let exhaustion = exhaustion(
            V3ErrorSourceKind::ProviderFailure,
            "provider_transport_failure",
            "provider transport failed",
            0,
            false,
        );
        let upstream_projection = serde_json::to_value(&exhaustion).unwrap();
        let (projection, decision) = execute_v3_operation_runner_error_err05_execution_decision(
            upstream_projection,
            exhaustion,
            None,
        )
        .expect("provider exhaustion must execute through the canonical SDK node");

        assert_eq!(projection, serde_json::to_value(&decision).unwrap());
        assert_eq!(decision.action, V3Error05ExecutionAction::ProjectTerminal);
        assert!(decision.try_into_terminal().is_ok());
    }

    #[test]
    fn non_provider_terminal_passes_the_existing_terminal_proof() {
        let exhaustion = exhaustion(
            V3ErrorSourceKind::InvalidRequest,
            "invalid_request",
            "invalid request",
            0,
            false,
        );
        let upstream_projection = serde_json::to_value(&exhaustion).unwrap();
        let (projection, decision) = execute_v3_operation_runner_error_err05_execution_decision(
            upstream_projection,
            exhaustion,
            None,
        )
        .expect("non-provider terminal must execute through the canonical SDK node");

        assert_eq!(projection, serde_json::to_value(&decision).unwrap());
        assert_eq!(
            decision.action,
            V3Error05ExecutionAction::RejectNonProviderError
        );
        assert!(decision.try_into_terminal().is_ok());
    }

    #[test]
    fn client_disconnect_passes_the_existing_terminal_proof() {
        let exhaustion = exhaustion(
            V3ErrorSourceKind::ClientDisconnect,
            "client_disconnect",
            "client disconnected",
            0,
            false,
        );
        let upstream_projection = serde_json::to_value(&exhaustion).unwrap();
        let (projection, decision) = execute_v3_operation_runner_error_err05_execution_decision(
            upstream_projection,
            exhaustion,
            None,
        )
        .expect("client disconnect must execute through the canonical SDK node");

        assert_eq!(projection, serde_json::to_value(&decision).unwrap());
        assert_eq!(
            decision.action,
            V3Error05ExecutionAction::ClientDisconnected
        );
        assert!(decision.try_into_terminal().is_ok());
    }
}
