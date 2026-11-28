use super::precompiled::{run_precompiled_node, V3OperationGraph};
use super::OperationRunnerError;
use pipeline_runtime::Operator;
use serde_json::Value;

/// Runs one canonical node. Request/response edges carry business values;
/// Error edges carry error-chain projections. Live typed control stays owned
/// by the operator instance and is never reconstructed from those projections.
pub(crate) fn run_v3_single_node_operator(
    source: V3OperationGraph,
    node_id: &str,
    input: Value,
    operator: impl Operator + 'static,
) -> Result<Value, OperationRunnerError> {
    run_precompiled_node(source, node_id, input, operator)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pipeline_runtime::{OperatorContext, ValueType};
    use serde_json::json;

    struct ResponseTransform;

    impl Operator for ResponseTransform {
        fn name(&self) -> &'static str {
            "routecodex.v3.operation.adjust_provider_private_response"
        }
        fn version(&self) -> &'static str {
            "1"
        }
        fn input_type(&self) -> ValueType {
            ValueType::Object
        }
        fn output_type(&self) -> ValueType {
            ValueType::Object
        }
        fn execute(&self, mut input: Value, _: &OperatorContext) -> Result<Value, String> {
            input["observed"] = json!(true);
            Ok(input)
        }
    }

    #[test]
    fn response_entry_executes_the_registered_transform_on_its_canonical_edge() {
        let output = run_v3_single_node_operator(
            V3OperationGraph::Response,
            "adjust_provider_private_response",
            json!({"opaque": [null, {"keep": true}]}),
            ResponseTransform,
        )
        .unwrap();
        assert_eq!(
            output,
            json!({"opaque": [null, {"keep": true}], "observed": true})
        );
        let error = run_v3_single_node_operator(
            V3OperationGraph::Request,
            "adjust_provider_private_request",
            json!({}),
            ResponseTransform,
        )
        .unwrap_err();
        assert!(
            error.message.contains("prepared node expects operator"),
            "{error}"
        );
    }
}
