use pipeline_runtime::{Operator, OperatorContext, ValueType};
use serde_json::Value;

use super::field_operator_library::normalize_client_request;
use crate::operation_runner::request_context_store::{
    RequestInvocationContext, RequestOriginKind, RequestScopedContextPair,
};

const OPERATOR_NAME: &str = "routecodex.v3.operation.normalize_request_losslessly";
const OPERATOR_VERSION: &str = "1";
const PUBLISHED_MANIFEST_RESOURCE: &str = "v3.config.published_manifest";
const REQUEST_ORIGIN_KIND_RESOURCE: &str = "v3.operation_runner.request_origin_kind";
const REQUEST_INVERSE_CONTEXT_RESOURCE: &str = "v3.operation_runner.request_inverse_context";
const EXPLICIT_HISTORY_PAIRING_RESOURCE: &str = "v3.operation_runner.explicit_history_pairing";
const OPERATOR_EFFECTS: &[&str] = &[
    PUBLISHED_MANIFEST_RESOURCE,
    REQUEST_ORIGIN_KIND_RESOURCE,
    REQUEST_INVERSE_CONTEXT_RESOURCE,
    EXPLICIT_HISTORY_PAIRING_RESOURCE,
];

pub(crate) struct NormalizeRequestLosslesslyOperator {
    invocation: RequestInvocationContext,
}

impl NormalizeRequestLosslesslyOperator {
    pub(crate) fn new(invocation: RequestInvocationContext) -> Self {
        Self { invocation }
    }
}

impl Operator for NormalizeRequestLosslesslyOperator {
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
        ValueType::Object
    }

    fn effects(&self) -> &'static [&'static str] {
        OPERATOR_EFFECTS
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let handle = self.invocation.request_handle();
        match self.invocation.origin_kind() {
            RequestOriginKind::ClientEntry => {
                if handle.original_pair().is_ok() {
                    return Err(
                        "request scope already has an original pair; raw entry cannot republish"
                            .to_string(),
                    );
                }
                let normalized = normalize_client_request(handle.entry_protocol(), &input)?;
                let pair = RequestScopedContextPair::from_field_json(
                    normalized.inverse_context,
                    normalized.explicit_history_pairing,
                )?;
                handle.publish_original_pair(pair)?;
                Ok(normalized.canonical_request)
            }
            RequestOriginKind::Retry
            | RequestOriginKind::InternalFollowup
            | RequestOriginKind::DirectRelayHandoff => {
                let _published_pair = handle.original_pair()?;
                Ok(input)
            }
        }
    }
}
