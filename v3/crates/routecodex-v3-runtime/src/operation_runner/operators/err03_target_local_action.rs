use crate::operation_runner::{
    run_v3_single_node_operator, OperationRunnerError, V3OperationGraph,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_error::{
    build_v3_error_03_target_local_action_from_v3_error_02, V3Error02Classified,
    V3Error03TargetLocalAction, V3ErrorActionScope,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.error.err03_target_local_action";
const OPERATOR_VERSION: &str = "1";
const NODE_ID: &str = "error_err03_target_local_action";

struct V3Error03TargetLocalActionOperator {
    classified: V3Error02Classified,
    scope: V3ErrorActionScope,
    candidates_remaining: usize,
    side_output: Arc<Mutex<Option<V3Error03TargetLocalAction>>>,
}

impl V3Error03TargetLocalActionOperator {
    fn new(
        classified: V3Error02Classified,
        scope: V3ErrorActionScope,
        candidates_remaining: usize,
        side_output: Arc<Mutex<Option<V3Error03TargetLocalAction>>>,
    ) -> Self {
        Self {
            classified,
            scope,
            candidates_remaining,
            side_output,
        }
    }
}

impl Operator for V3Error03TargetLocalActionOperator {
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

    fn execute(&self, _input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let result = build_v3_error_03_target_local_action_from_v3_error_02(
            self.classified.clone(),
            self.scope.clone(),
            self.candidates_remaining,
        );
        let projection = serde_json::to_value(&result).map_err(|error| error.to_string())?;
        let mut holder = self
            .side_output
            .lock()
            .map_err(|_| "Error03 side-output holder is poisoned".to_string())?;
        *holder = Some(result);
        Ok(projection)
    }
}

pub(crate) fn run_v3_error_03_target_local_action_operator(
    input: Value,
    classified: V3Error02Classified,
    scope: V3ErrorActionScope,
    candidates_remaining: usize,
) -> Result<(Value, V3Error03TargetLocalAction), OperationRunnerError> {
    let side_output = Arc::new(Mutex::new(None));
    let output = run_v3_single_node_operator(
        V3OperationGraph::Error,
        NODE_ID,
        input,
        V3Error03TargetLocalActionOperator::new(
            classified,
            scope,
            candidates_remaining,
            Arc::clone(&side_output),
        ),
    )?;
    let typed = side_output
        .lock()
        .map_err(|_| OperationRunnerError::new("Error03 side-output holder is poisoned"))?
        .take()
        .ok_or_else(|| OperationRunnerError::new("Error03 produced no typed result"))?;
    Ok((output, typed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_error::{
        build_v3_error_01_source_raised, build_v3_error_02_classified_from_v3_error_01,
        V3ErrorSourceKind,
    };

    fn classified(source_kind: V3ErrorSourceKind, code: &str) -> V3Error02Classified {
        build_v3_error_02_classified_from_v3_error_01(build_v3_error_01_source_raised(
            source_kind,
            "V3Error03OperatorTest",
            code,
            "test source",
        ))
    }

    fn provider_scope() -> V3ErrorActionScope {
        V3ErrorActionScope::ProviderKeyModel {
            provider_id: "provider-a".to_string(),
            auth_alias: "auth-a".to_string(),
            model_id: "model-a".to_string(),
        }
    }

    #[test]
    fn provider_failure_action_tracks_candidate_budget() {
        let code = "provider_http_500";
        let classified = classified(V3ErrorSourceKind::ProviderFailure, code);
        let classified_input = serde_json::to_value(&classified).unwrap();
        let (projection, typed) = run_v3_error_03_target_local_action_operator(
            classified_input.clone(),
            classified.clone(),
            provider_scope(),
            2,
        )
        .unwrap();

        assert!(typed.action.retry_eligible);
        assert!(typed.action.health_affecting);
        assert_eq!(typed.action.exhaustion_effect, "target_local_reselect");
        assert_eq!(projection["action"]["retry_eligible"], true);
        assert_eq!(projection["action"]["health_affecting"], true);
        assert_eq!(
            projection["action"]["exhaustion_effect"],
            "target_local_reselect"
        );

        let (exhausted_projection, exhausted) = run_v3_error_03_target_local_action_operator(
            classified_input,
            classified,
            provider_scope(),
            0,
        )
        .unwrap();

        assert!(!exhausted.action.retry_eligible);
        assert!(exhausted.action.health_affecting);
        assert_eq!(exhausted.action.exhaustion_effect, "target_pool_exhausted");
        assert_eq!(exhausted_projection["action"]["retry_eligible"], false);
        assert_eq!(
            exhausted_projection["action"]["exhaustion_effect"],
            "target_pool_exhausted"
        );
    }

    #[test]
    fn non_provider_and_client_disconnect_actions_stay_health_neutral() {
        for (source_kind, code, expected_effect) in [
            (
                V3ErrorSourceKind::RuntimeFailure,
                "runtime_failure",
                "project_client_error",
            ),
            (
                V3ErrorSourceKind::ClientDisconnect,
                "client_disconnect",
                "health_neutral_client_disconnect",
            ),
        ] {
            let classified = classified(source_kind, code);
            let classified_input = serde_json::to_value(&classified).unwrap();
            let (projection, typed) = run_v3_error_03_target_local_action_operator(
                classified_input,
                classified,
                provider_scope(),
                1,
            )
            .unwrap();

            assert!(!typed.action.retry_eligible);
            assert!(!typed.action.health_affecting);
            assert_eq!(typed.action.exhaustion_effect, expected_effect);
            assert_eq!(projection["action"]["retry_eligible"], false);
            assert_eq!(projection["action"]["health_affecting"], false);
            assert_eq!(projection["action"]["exhaustion_effect"], expected_effect);
        }
    }

    #[test]
    fn provider_failure_projection_preserves_exact_scope_and_reason() {
        let code = "provider_stream_failed";
        let classified = classified(V3ErrorSourceKind::ProviderFailure, code);
        let classified_input = serde_json::to_value(&classified).unwrap();
        let scope = provider_scope();
        let (projection, typed) = run_v3_error_03_target_local_action_operator(
            classified_input,
            classified,
            scope.clone(),
            1,
        )
        .unwrap();

        assert_eq!(typed.action.reason, code);
        assert_eq!(typed.action.scope, scope);
        assert_eq!(projection["action"]["reason"], code);
        assert_eq!(projection["action"]["scope"]["scope"], "provider_key_model");
        assert_eq!(projection["action"]["scope"]["provider_id"], "provider-a");
        assert_eq!(projection["action"]["scope"]["auth_alias"], "auth-a");
        assert_eq!(projection["action"]["scope"]["model_id"], "model-a");
    }
}
