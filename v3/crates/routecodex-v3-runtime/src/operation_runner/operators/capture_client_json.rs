use pipeline_runtime::{Operator, OperatorContext, ValueType};
use serde_json::Value;

const OPERATOR_NAME: &str = "routecodex.v3.operation.capture_client_json";
const OPERATOR_VERSION: &str = "1";

pub struct CaptureClientJsonOperator;

pub(super) fn capture_v3_operation_runner_client_json(input: Value) -> Value {
    input
}

impl Operator for CaptureClientJsonOperator {
    fn name(&self) -> &'static str {
        OPERATOR_NAME
    }

    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }

    fn input_type(&self) -> ValueType {
        ValueType::Any
    }

    fn output_type(&self) -> ValueType {
        ValueType::Any
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        Ok(capture_v3_operation_runner_client_json(input))
    }
}
