use crate::operation_runner::{
    run_v3_single_node_operator, OperationRunnerError, V3OperationGraph,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    build_v3_error_01_source_raised_internal, build_v3_internal_error_envelope,
    V3Error01SourceRaised, V3ErrorSourceKind, V3ExternalErrorLink, V3InternalErrorCode,
    V3InternalErrorEnvelope,
};
use serde::Serialize;
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

#[derive(Serialize)]
struct Err01SourceFailureProjection<'a> {
    source_kind: &'a V3ErrorSourceKind,
    source_stage: &'static str,
    code: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    internal_error: Option<V3InternalErrorEnvelope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    external_error: Option<&'a V3ExternalErrorLink>,
}

fn source_failure_projection(
    source_kind: &V3ErrorSourceKind,
    source_stage: &'static str,
    code: &str,
    message: &str,
    source_input: &V3Err01SourceInput,
) -> Result<Value, String> {
    let (internal_error, external_error) = match source_input {
        V3Err01SourceInput::Plain => (None, None),
        V3Err01SourceInput::Internal(internal_code) => (
            Some(build_v3_internal_error_envelope(
                *internal_code,
                source_stage,
            )),
            None,
        ),
        V3Err01SourceInput::External(external_error) => (None, Some(external_error)),
    };
    serde_json::to_value(Err01SourceFailureProjection {
        source_kind,
        source_stage,
        code,
        message,
        internal_error,
        external_error,
    })
    .map_err(|error| format!("serialize Err01 source failure projection: {error}"))
}

pub(crate) struct Err01SourceRaisedOperator {
    source_kind: V3ErrorSourceKind,
    source_stage: &'static str,
    code: String,
    message: String,
    source_input: V3Err01SourceInput,
    side_output: Arc<Mutex<Option<Result<V3Error01SourceRaised, String>>>>,
}

impl Err01SourceRaisedOperator {
    fn new(
        source_kind: V3ErrorSourceKind,
        source_stage: &'static str,
        code: impl Into<String>,
        message: impl Into<String>,
        source_input: V3Err01SourceInput,
        side_output: Arc<Mutex<Option<Result<V3Error01SourceRaised, String>>>>,
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

    fn raise(&self) -> Result<V3Error01SourceRaised, String> {
        match &self.source_input {
            V3Err01SourceInput::Plain => Ok(build_v3_error_01_source_raised(
                self.source_kind.clone(),
                self.source_stage,
                self.code.clone(),
                self.message.clone(),
            )),
            V3Err01SourceInput::Internal(internal_code) => {
                Ok(build_v3_error_01_source_raised_internal(
                    self.source_kind.clone(),
                    self.source_stage,
                    self.code.clone(),
                    self.message.clone(),
                    *internal_code,
                ))
            }
            V3Err01SourceInput::External(external_error) => {
                Ok(build_v3_error_01_source_raised_external(
                    self.source_kind.clone(),
                    self.source_stage,
                    self.code.clone(),
                    self.message.clone(),
                    external_error.clone(),
                ))
            }
        }
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
        #[cfg(test)]
        super::ERR01_EXECUTIONS.with(|count| count.set(count.get() + 1));
        let typed = self.raise();
        let output = match &typed {
            Ok(source) => serde_json::to_value(source)
                .map_err(|error| format!("serialize Err01 source raised: {error}")),
            Err(error) => Err(error.clone()),
        };
        *self
            .side_output
            .lock()
            .map_err(|_| "Err01 side-output holder is poisoned".to_string())? = Some(typed);
        output
    }
}

pub(crate) fn run_v3_err01_source_raised_operator(
    source_kind: V3ErrorSourceKind,
    source_stage: &'static str,
    code: impl Into<String>,
    message: impl Into<String>,
    source_input: V3Err01SourceInput,
) -> Result<(Value, V3Error01SourceRaised), OperationRunnerError> {
    let code = code.into();
    let message = message.into();
    let source_failure =
        source_failure_projection(&source_kind, source_stage, &code, &message, &source_input)
            .map_err(OperationRunnerError::new)?;
    let side_output = Arc::new(Mutex::new(None));
    let operator = Err01SourceRaisedOperator::new(
        source_kind,
        source_stage,
        code,
        message,
        source_input,
        Arc::clone(&side_output),
    );
    let payload =
        run_v3_single_node_operator(V3OperationGraph::Error, NODE_ID, source_failure, operator);
    let payload = payload?;
    let typed_output = side_output
        .lock()
        .map_err(|_| OperationRunnerError::new("Err01 side-output holder is poisoned"))?
        .take()
        .ok_or_else(|| OperationRunnerError::new("Err01 completed without typed source output"))?;
    let typed_output = typed_output.map_err(OperationRunnerError::new)?;
    Ok((payload, typed_output))
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_error::{V3ExternalErrorKind, V3InternalErrorLane};

    #[test]
    fn plain_source_raising_uses_raw_parameters_at_canonical_sdk_entry() {
        let (payload, source) = run_v3_err01_source_raised_operator(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_http_502",
            "upstream returned a bad gateway",
            V3Err01SourceInput::Plain,
        )
        .expect("plain Err01 must execute through the canonical Error graph");

        assert_eq!(payload["source_kind"], "provider_failure");
        assert_eq!(payload["source_stage"], "V3ProviderResp14Raw");
        assert_eq!(payload["code"], "provider_http_502");
        assert_eq!(payload["message"], "upstream returned a bad gateway");
        assert!(payload.get("internal_error").is_none());
        assert!(payload.get("external_error").is_none());
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
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_http_429",
            "upstream rate limit",
            V3Err01SourceInput::External(external_error.clone()),
        )
        .expect("external Err01 must execute through the canonical Error graph");

        assert_eq!(source.external_error, Some(external_error));
        assert_eq!(payload["external_error"]["status"], 429);
        assert_eq!(
            payload["external_error"]["upstream_request_id"],
            "upstream-request-01"
        );
    }

    #[test]
    fn internal_source_raising_preserves_existing_internal_envelope() {
        let (payload, source) = run_v3_err01_source_raised_operator(
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
        assert_eq!(payload["internal_error"]["internal_code"], "500-150");
    }

    #[test]
    fn raw_source_parameters_change_actual_sdk_output() {
        let (first_payload, first_source) = run_v3_err01_source_raised_operator(
            V3ErrorSourceKind::InvalidRequest,
            "V3Server03HttpRequestRaw",
            "malformed_json",
            "first detail",
            V3Err01SourceInput::Plain,
        )
        .unwrap();
        let (second_payload, second_source) = run_v3_err01_source_raised_operator(
            V3ErrorSourceKind::PendingEndpoint,
            "V3Server03HttpRequestRaw",
            "endpoint_not_enabled",
            "second detail",
            V3Err01SourceInput::Plain,
        )
        .unwrap();

        assert_ne!(first_payload, second_payload);
        assert_eq!(first_source.code, "malformed_json");
        assert_eq!(first_payload["message"], "first detail");
        assert_eq!(
            second_source.source_kind,
            V3ErrorSourceKind::PendingEndpoint
        );
        assert_eq!(second_payload["source_kind"], "pending_endpoint");
        assert_eq!(second_payload["code"], "endpoint_not_enabled");
        assert_eq!(second_payload["message"], "second detail");
    }
}
