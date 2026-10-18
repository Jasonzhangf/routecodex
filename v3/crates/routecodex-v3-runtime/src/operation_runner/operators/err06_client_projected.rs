use crate::operation_runner::{
    run_v3_single_node_operator, OperationRunnerError, V3OperationGraph,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_error::{
    build_v3_error_06_client_projected_from_v3_error_05, V3Error05TerminalDecision,
    V3Error06ClientProjected,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.error.err06_client_projected";
const OPERATOR_VERSION: &str = "1";
const NODE_ID: &str = "error_err06_client_projected";

struct Err06ClientProjectedOperator {
    terminal: Mutex<Option<V3Error05TerminalDecision>>,
    output: Arc<Mutex<Option<V3Error06ClientProjected>>>,
}

impl Operator for Err06ClientProjectedOperator {
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
        let terminal = self
            .terminal
            .lock()
            .map_err(|_| "Error06 terminal holder is poisoned".to_string())?
            .take()
            .ok_or_else(|| "Error06 terminal proof was already consumed".to_string())?;
        let projected = build_v3_error_06_client_projected_from_v3_error_05(terminal);
        let output = serde_json::to_value(&projected)
            .map_err(|error| format!("Error06 projection serialization failed: {error}"))?;
        *self
            .output
            .lock()
            .map_err(|_| "Error06 output holder is poisoned".to_string())? = Some(projected);
        Ok(output)
    }
}

pub(crate) fn execute_v3_operation_runner_error_err06_client_projected(
    input: Value,
    terminal: V3Error05TerminalDecision,
) -> Result<(Value, V3Error06ClientProjected), OperationRunnerError> {
    let output = Arc::new(Mutex::new(None));
    let runner_result = run_v3_single_node_operator(
        V3OperationGraph::Error,
        NODE_ID,
        input,
        Err06ClientProjectedOperator {
            terminal: Mutex::new(Some(terminal)),
            output: Arc::clone(&output),
        },
    );
    let typed_output = output
        .lock()
        .map_err(|_| OperationRunnerError::new("Error06 output holder is poisoned"))?
        .take();
    match (runner_result, typed_output) {
        (Ok(projection), Some(projected)) => Ok((projection, projected)),
        (Err(error), _) => Err(error),
        (Ok(_), None) => Err(OperationRunnerError::new(
            "Error06 operator completed without typed output",
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
        build_v3_error_05_execution_decision_from_v3_error_04, V3Error05ExecutionDecision,
        V3ErrorActionScope, V3ErrorSourceKind,
    };

    fn terminal(
        source_kind: V3ErrorSourceKind,
        code: &str,
        message: &str,
        candidates_remaining: usize,
    ) -> (V3Error05ExecutionDecision, V3Error05TerminalDecision) {
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
        let exhaustion = build_v3_error_04_target_exhaustion_decision_with_provider_availability(
            action,
            candidates_remaining,
            false,
            false,
        );
        let decision = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion, None);
        let terminal = decision
            .clone()
            .try_into_terminal()
            .expect("fixture must satisfy the existing terminal proof");
        (decision, terminal)
    }

    #[test]
    fn provider_terminal_serializes_the_original_internal_result() {
        let (decision, terminal) = terminal(
            V3ErrorSourceKind::ProviderFailure,
            "provider_http_502",
            "provider returned an upstream 502",
            0,
        );
        let upstream_projection = serde_json::to_value(&decision).unwrap();
        let (projection, projected) =
            execute_v3_operation_runner_error_err06_client_projected(upstream_projection, terminal)
                .expect("provider terminal must execute through the canonical SDK node");

        assert_eq!(projection, serde_json::to_value(&projected).unwrap());
        assert_eq!(projected.status, 502);
        assert_eq!(projected.error_class, "provider_failure");
        assert_eq!(projected.body["error"]["code"], "network_error");
        assert_eq!(
            projected.chain,
            routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS
        );
    }

    #[test]
    fn non_provider_terminal_serializes_the_original_internal_result() {
        let (decision, terminal) = terminal(
            V3ErrorSourceKind::InvalidRequest,
            "invalid_request_schema",
            "request schema is invalid",
            0,
        );
        let upstream_projection = serde_json::to_value(&decision).unwrap();
        let (projection, projected) =
            execute_v3_operation_runner_error_err06_client_projected(upstream_projection, terminal)
                .expect("non-provider terminal must execute through the canonical SDK node");

        assert_eq!(projection, serde_json::to_value(&projected).unwrap());
        assert_eq!(projected.status, 400);
        assert_eq!(projected.error_class, "client_input");
        assert_eq!(projected.body["error"]["code"], "invalid_request_schema");
        assert_eq!(
            projected.diagnostic_source.source_kind,
            V3ErrorSourceKind::InvalidRequest
        );
        assert_eq!(
            projected.chain,
            routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS
        );
    }
}
