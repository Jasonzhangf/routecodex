use crate::operation_runner::{
    run_v3_single_node_operator, OperationRunnerError, V3OperationGraph,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    build_v3_error_01_source_raised_internal, V3Error01SourceRaised, V3ErrorSourceKind,
    V3ExternalErrorLink, V3InternalErrorCode,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.error.err01_source_raised";
const OPERATOR_VERSION: &str = "1";
const NODE_ID: &str = "error_err01_source_raised";

pub(crate) enum V3Err01SourceInput {
    Plain,
    Internal(V3InternalErrorCode),
    External(V3ExternalErrorLink),
}

type Err01Output = (V3Error01SourceRaised, Value);

pub(crate) struct Err01SourceRaisedOperator {
    source_kind: V3ErrorSourceKind,
    source_stage: &'static str,
    code: String,
    message: String,
    source_input: V3Err01SourceInput,
    side_output: Arc<Mutex<Option<Result<Err01Output, String>>>>,
}

impl Err01SourceRaisedOperator {
    fn new(
        source_kind: V3ErrorSourceKind,
        source_stage: &'static str,
        code: impl Into<String>,
        message: impl Into<String>,
        source_input: V3Err01SourceInput,
        side_output: Arc<Mutex<Option<Result<Err01Output, String>>>>,
    ) -> Self {
        Self {
            source_kind,
            source_stage,
            code: code.into(),
            message: message.into(),
            source_input,
            side_output,
        }
    }

    fn raise(&self) -> Result<Err01Output, String> {
        let source = match &self.source_input {
            V3Err01SourceInput::Plain => build_v3_error_01_source_raised(
                self.source_kind.clone(),
                self.source_stage,
                self.code.clone(),
                self.message.clone(),
            ),
            V3Err01SourceInput::Internal(internal_code) => {
                build_v3_error_01_source_raised_internal(
                    self.source_kind.clone(),
                    self.source_stage,
                    self.code.clone(),
                    self.message.clone(),
                    *internal_code,
                )
            }
            V3Err01SourceInput::External(external_error) => {
                build_v3_error_01_source_raised_external(
                    self.source_kind.clone(),
                    self.source_stage,
                    self.code.clone(),
                    self.message.clone(),
                    external_error.clone(),
                )
            }
        };
        let payload = serde_json::to_value(&source)
            .map_err(|error| format!("serialize Err01 source raised: {error}"))?;
        Ok((source, payload))
    }
}

impl Operator for Err01SourceRaisedOperator {
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
        let raised = self.raise();
        let output = match &raised {
            Ok((_, payload)) => Ok(payload.clone()),
            Err(error) => Err(error.clone()),
        };
        *self
            .side_output
            .lock()
            .map_err(|_| "Err01 side-output holder is poisoned".to_string())? = Some(raised);
        output
    }
}

pub(crate) fn run_v3_err01_source_raised_operator(
    source_failure: Value,
    source_kind: V3ErrorSourceKind,
    source_stage: &'static str,
    code: impl Into<String>,
    message: impl Into<String>,
    source_input: V3Err01SourceInput,
) -> Result<(Value, V3Error01SourceRaised), OperationRunnerError> {
    let side_output = Arc::new(Mutex::new(None));
    let operator = Err01SourceRaisedOperator::new(
        source_kind,
        source_stage,
        code,
        message,
        source_input,
        Arc::clone(&side_output),
    );
    let runner_result =
        run_v3_single_node_operator(V3OperationGraph::Error, NODE_ID, source_failure, operator);
    let typed_output = side_output
        .lock()
        .map_err(|_| OperationRunnerError::new("Err01 side-output holder is poisoned"))?
        .take();
    match (runner_result, typed_output) {
        (_, Some(Err(error))) => Err(OperationRunnerError::new(error)),
        (Err(error), _) => Err(error),
        (Ok(_), Some(Ok((source, payload)))) => Ok((payload, source)),
        (Ok(_), None) => Err(OperationRunnerError::new(
            "Err01 completed without typed source output",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_error::{V3ExternalErrorKind, V3InternalErrorLane};
    use serde_json::json;

    #[test]
    fn plain_source_raising_uses_raw_parameters_at_canonical_sdk_entry() {
        let source_failure = json!({
            "provider": "upstream-a",
            "request_id": "req-raw-01"
        });
        let (payload, source) = run_v3_err01_source_raised_operator(
            source_failure,
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_http_502",
            "upstream returned a bad gateway",
            V3Err01SourceInput::Plain,
        )
        .expect("plain Err01 must execute through the canonical Error graph");

        assert_eq!(payload, serde_json::to_value(&source).unwrap());
        assert_eq!(source.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(source.source_stage, "V3ProviderResp14Raw");
        assert_eq!(source.code, "provider_http_502");
        assert_eq!(source.message, "upstream returned a bad gateway");
        assert!(source.internal_error.is_none());
        assert!(source.external_error.is_none());
    }

    #[test]
    fn external_source_raising_preserves_http_linkage() {
        let external_error = V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(429),
            code: Some("rate_limit_exceeded".to_string()),
            provider_id: Some("provider-a".to_string()),
            upstream_request_id: Some("upstream-request-01".to_string()),
            message: Some("retry later".to_string()),
        };
        let (payload, source) = run_v3_err01_source_raised_operator(
            json!({"raw_status": 429}),
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_http_429",
            "upstream rate limit",
            V3Err01SourceInput::External(external_error.clone()),
        )
        .expect("external Err01 must execute through the canonical Error graph");

        assert_eq!(source.external_error, Some(external_error));
        assert_eq!(payload, serde_json::to_value(&source).unwrap());
        assert_eq!(payload["external_error"]["status"], 429);
        assert_eq!(
            payload["external_error"]["upstream_request_id"],
            "upstream-request-01"
        );
    }

    #[test]
    fn internal_source_raising_preserves_existing_internal_envelope() {
        let (payload, source) = run_v3_err01_source_raised_operator(
            json!({"raw_stage": "wire"}),
            V3ErrorSourceKind::RuntimeFailure,
            "V3Provider12ResponsesWirePayload",
            "provider_wire_projection_failed",
            "wire projection failed",
            V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
        )
        .expect("internal Err01 must execute through the canonical Error graph");

        let internal = source
            .internal_error
            .as_ref()
            .expect("internal constructor must attach an envelope");
        assert_eq!(internal.internal_code, "500-150");
        assert_eq!(internal.lane, V3InternalErrorLane::Request);
        assert_eq!(internal.node_id, "V3Provider12ResponsesWirePayload");
        assert_eq!(internal.stage, "V3Provider12ResponsesWirePayload");
        assert_eq!(payload, serde_json::to_value(&source).unwrap());
        assert_eq!(payload["internal_error"]["internal_code"], "500-150");
    }

    #[test]
    fn raw_source_parameters_change_actual_sdk_output() {
        let (first_payload, first_source) = run_v3_err01_source_raised_operator(
            json!({"raw_failure": "same input"}),
            V3ErrorSourceKind::InvalidRequest,
            "V3Server03HttpRequestRaw",
            "malformed_json",
            "first detail",
            V3Err01SourceInput::Plain,
        )
        .unwrap();
        let (second_payload, second_source) = run_v3_err01_source_raised_operator(
            json!({"raw_failure": "same input"}),
            V3ErrorSourceKind::PendingEndpoint,
            "V3Server03HttpRequestRaw",
            "endpoint_not_enabled",
            "second detail",
            V3Err01SourceInput::Plain,
        )
        .unwrap();

        assert_ne!(first_payload, second_payload);
        assert_eq!(first_payload, serde_json::to_value(&first_source).unwrap());
        assert_eq!(
            second_payload,
            serde_json::to_value(&second_source).unwrap()
        );
        assert_eq!(second_payload["source_kind"], "pending_endpoint");
        assert_eq!(second_payload["code"], "endpoint_not_enabled");
        assert_eq!(second_payload["message"], "second detail");
    }
}
