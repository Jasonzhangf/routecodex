use crate::operation_runner::{
    run_v3_single_node_operator, OperationRunnerError, V3OperationGraph,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_error::{
    build_v3_error_04_target_exhaustion_decision_with_provider_availability,
    V3Error03TargetLocalAction, V3Error04TargetExhaustionDecision,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.error.err04_target_exhaustion";
const OPERATOR_VERSION: &str = "1";
const NODE_ID: &str = "error_err04_target_exhaustion";

struct V3Error04TargetExhaustionOperator {
    local_action: V3Error03TargetLocalAction,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
    side_output: Arc<Mutex<Option<V3Error04TargetExhaustionDecision>>>,
}

impl V3Error04TargetExhaustionOperator {
    fn new(
        local_action: V3Error03TargetLocalAction,
        route_pool_remaining_after_exclusion: usize,
        default_pool_available: bool,
        same_provider_retry_available: bool,
        side_output: Arc<Mutex<Option<V3Error04TargetExhaustionDecision>>>,
    ) -> Self {
        Self {
            local_action,
            route_pool_remaining_after_exclusion,
            default_pool_available,
            same_provider_retry_available,
            side_output,
        }
    }
}

impl Operator for V3Error04TargetExhaustionOperator {
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
        let result = build_v3_error_04_target_exhaustion_decision_with_provider_availability(
            self.local_action.clone(),
            self.route_pool_remaining_after_exclusion,
            self.default_pool_available,
            self.same_provider_retry_available,
        );
        let projection = serde_json::to_value(&result).map_err(|error| error.to_string())?;
        let mut holder = self
            .side_output
            .lock()
            .map_err(|_| "Error04 side-output holder is poisoned".to_string())?;
        *holder = Some(result);
        Ok(projection)
    }
}

pub(crate) fn run_v3_error_04_target_exhaustion_operator(
    input: Value,
    local_action: V3Error03TargetLocalAction,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
) -> Result<(Value, V3Error04TargetExhaustionDecision), OperationRunnerError> {
    let side_output = Arc::new(Mutex::new(None));
    let output = run_v3_single_node_operator(
        V3OperationGraph::Error,
        NODE_ID,
        input,
        V3Error04TargetExhaustionOperator::new(
            local_action,
            route_pool_remaining_after_exclusion,
            default_pool_available,
            same_provider_retry_available,
            Arc::clone(&side_output),
        ),
    )?;
    let typed = side_output
        .lock()
        .map_err(|_| OperationRunnerError::new("Error04 side-output holder is poisoned"))?
        .take()
        .ok_or_else(|| OperationRunnerError::new("Error04 produced no typed result"))?;
    Ok((output, typed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_error::{
        build_v3_error_01_source_raised, build_v3_error_02_classified_from_v3_error_01,
        build_v3_error_03_target_local_action_from_v3_error_02, V3ErrorActionScope,
        V3ErrorSourceKind,
    };

    fn provider_action(candidates_remaining: usize) -> V3Error03TargetLocalAction {
        let classified =
            build_v3_error_02_classified_from_v3_error_01(build_v3_error_01_source_raised(
                V3ErrorSourceKind::ProviderFailure,
                "V3Error04OperatorTest",
                "provider_http_503",
                "test provider failure",
            ));
        build_v3_error_03_target_local_action_from_v3_error_02(
            classified,
            V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "auth-a".to_string(),
                model_id: "model-a".to_string(),
            },
            candidates_remaining,
        )
    }

    fn client_disconnect_action() -> V3Error03TargetLocalAction {
        let classified =
            build_v3_error_02_classified_from_v3_error_01(build_v3_error_01_source_raised(
                V3ErrorSourceKind::ClientDisconnect,
                "V3Error04OperatorTest",
                "client_disconnect",
                "test client disconnect",
            ));
        build_v3_error_03_target_local_action_from_v3_error_02(
            classified,
            V3ErrorActionScope::None,
            0,
        )
    }

    #[test]
    fn provider_failure_exhaustion_tracks_route_pool_and_default_availability() {
        let action = provider_action(1);

        let (projection, typed) = run_v3_error_04_target_exhaustion_operator(
            serde_json::json!({"local_action": {"action": {"reason": "provider_http_503"}}}),
            action.clone(),
            1,
            false,
            false,
        )
        .unwrap();
        assert!(!typed.target_exhausted);
        assert_eq!(projection["target_exhausted"], false);
        assert_eq!(projection["route_pool_remaining_after_exclusion"], 1);
        assert_eq!(projection["default_pool_available"], false);
        assert_eq!(projection["same_provider_retry_available"], false);

        let (exhausted_projection, exhausted) = run_v3_error_04_target_exhaustion_operator(
            serde_json::json!({"local_action": {"action": {"reason": "provider_http_503"}}}),
            action.clone(),
            0,
            false,
            false,
        )
        .unwrap();
        assert!(exhausted.target_exhausted);
        assert_eq!(exhausted_projection["target_exhausted"], true);

        let (default_pool_projection, default_pool) = run_v3_error_04_target_exhaustion_operator(
            serde_json::json!({"local_action": {"action": {"reason": "provider_http_503"}}}),
            action,
            0,
            true,
            true,
        )
        .unwrap();
        assert!(!default_pool.target_exhausted);
        assert!(default_pool.default_pool_available);
        assert!(default_pool.same_provider_retry_available);
        assert_eq!(default_pool_projection["target_exhausted"], false);
        assert_eq!(default_pool_projection["default_pool_available"], true);
        assert_eq!(
            default_pool_projection["same_provider_retry_available"],
            true
        );
    }

    #[test]
    fn non_provider_exhaustion_preserves_original_chain() {
        let action = client_disconnect_action();
        let (projection, typed) = run_v3_error_04_target_exhaustion_operator(
            serde_json::json!({"local_action": {"action": {"reason": "client_disconnect"}}}),
            action,
            3,
            true,
            false,
        )
        .unwrap();

        assert!(typed.target_exhausted);
        assert_eq!(
            typed.local_action.classified.source.source_kind,
            V3ErrorSourceKind::ClientDisconnect
        );
        assert_eq!(typed.local_action.action.reason, "client_disconnect");
        assert_eq!(projection["target_exhausted"], true);
        assert_eq!(
            projection["local_action"]["classified"]["source"]["source_kind"],
            "client_disconnect"
        );
        assert_eq!(
            projection["local_action"]["action"]["reason"],
            "client_disconnect"
        );
    }
}
