use crate::operation_runner::{
    run_v3_single_node_operator, OperationRunnerError, V3OperationGraph,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_error::{
    build_v3_error_02_classified_from_v3_error_01,
    build_v3_error_02_classified_from_v3_error_01_with_provider_global_policy,
    V3Error01SourceRaised, V3Error02Classified,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.error.err02_classified";
const OPERATOR_VERSION: &str = "1";
const NODE_ID: &str = "error_err02_classified";

type Err02Output = (V3Error02Classified, Value);

pub(crate) struct Err02ClassifiedOperator {
    source: Arc<Mutex<Option<V3Error01SourceRaised>>>,
    provider_global_cooldown_ms: Option<u64>,
    provider_global_semantic_signature: Option<String>,
    side_output: Arc<Mutex<Option<Result<Err02Output, String>>>>,
}

impl Err02ClassifiedOperator {
    fn new(
        source: V3Error01SourceRaised,
        provider_global_cooldown_ms: Option<u64>,
        provider_global_semantic_signature: Option<String>,
        side_output: Arc<Mutex<Option<Result<Err02Output, String>>>>,
    ) -> Self {
        Self {
            source: Arc::new(Mutex::new(Some(source))),
            provider_global_cooldown_ms,
            provider_global_semantic_signature,
            side_output,
        }
    }

    fn classify(&self) -> Result<Err02Output, String> {
        let source = self
            .source
            .lock()
            .map_err(|_| "Err02 typed source holder is poisoned".to_string())?
            .take()
            .ok_or_else(|| "Err02 typed source was already consumed".to_string())?;
        let classified = match self.provider_global_semantic_signature.as_ref() {
            Some(semantic_signature) => {
                build_v3_error_02_classified_from_v3_error_01_with_provider_global_policy(
                    source,
                    self.provider_global_cooldown_ms,
                    semantic_signature.clone(),
                )
            }
            None if self.provider_global_cooldown_ms.is_some() => {
                return Err(
                    "Err02 provider global cooldown requires a semantic signature".to_string(),
                )
            }
            None => build_v3_error_02_classified_from_v3_error_01(source),
        };
        let payload = serde_json::to_value(&classified)
            .map_err(|error| format!("serialize Err02 classified: {error}"))?;
        Ok((classified, payload))
    }
}

impl Operator for Err02ClassifiedOperator {
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
        let classified = self.classify();
        let output = match &classified {
            Ok((_, payload)) => Ok(payload.clone()),
            Err(error) => Err(error.clone()),
        };
        *self
            .side_output
            .lock()
            .map_err(|_| "Err02 side-output holder is poisoned".to_string())? = Some(classified);
        output
    }
}

pub(crate) fn run_v3_err02_classified_operator(
    source_projection: Value,
    source: V3Error01SourceRaised,
    provider_global_cooldown_ms: Option<u64>,
    provider_global_semantic_signature: Option<String>,
) -> Result<(Value, V3Error02Classified), OperationRunnerError> {
    let side_output = Arc::new(Mutex::new(None));
    let operator = Err02ClassifiedOperator::new(
        source,
        provider_global_cooldown_ms,
        provider_global_semantic_signature,
        Arc::clone(&side_output),
    );
    let runner_result = run_v3_single_node_operator(
        V3OperationGraph::Error,
        NODE_ID,
        source_projection,
        operator,
    );
    let typed_output = side_output
        .lock()
        .map_err(|_| OperationRunnerError::new("Err02 side-output holder is poisoned"))?
        .take();
    match (runner_result, typed_output) {
        (_, Some(Err(error))) => Err(OperationRunnerError::new(error)),
        (Err(error), _) => Err(error),
        (Ok(_), Some(Ok((classified, payload)))) => Ok((payload, classified)),
        (Ok(_), None) => Err(OperationRunnerError::new(
            "Err02 completed without typed classified output",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operation_runner::operators::err01_source_raised::{
        run_v3_err01_source_raised_operator, V3Err01SourceInput,
    };
    use routecodex_v3_error::{
        V3ErrorSourceKind, V3ExternalErrorKind, V3ExternalErrorLink, V3InternalErrorCode,
    };
    use serde_json::json;

    #[test]
    fn provider_classification_preserves_original_chain_and_global_policy() {
        let external_error = V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(429),
            code: Some("rate_limit_exceeded".to_string()),
            provider_id: Some("provider-a".to_string()),
            upstream_request_id: Some("upstream-request-02".to_string()),
            message: Some("retry later".to_string()),
        };
        let (source_projection, source) = run_v3_err01_source_raised_operator(
            json!({"raw_status": 429}),
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_http_429",
            "upstream rate limit",
            V3Err01SourceInput::External(external_error),
        )
        .expect("Err01 must produce the provider source");
        let (payload, classified) = run_v3_err02_classified_operator(
            source_projection.clone(),
            source.clone(),
            Some(5_000),
            Some("recoverable_upstream:429".to_string()),
        )
        .expect("Err02 must execute the global policy builder");

        assert_eq!(payload, serde_json::to_value(&classified).unwrap());
        assert_eq!(payload["source"], source_projection);
        assert_eq!(classified.source, source);
        assert_eq!(classified.class, "provider_failure");
        assert_eq!(
            classified.terminal_state,
            "non_terminal_if_candidates_remain"
        );
        assert_eq!(classified.provider_global_cooldown_ms, Some(5_000));
        assert_eq!(
            classified.provider_global_semantic_signature.as_deref(),
            Some("recoverable_upstream:429")
        );
        assert_eq!(payload["provider_global_cooldown_ms"], 5_000);
        assert_eq!(
            payload["provider_global_semantic_signature"],
            "recoverable_upstream:429"
        );
    }

    #[test]
    fn non_provider_classification_is_distinct_and_retains_internal_source() {
        let (source_projection, source) = run_v3_err01_source_raised_operator(
            json!({"raw_stage": "wire"}),
            V3ErrorSourceKind::RuntimeFailure,
            "V3Provider12ResponsesWirePayload",
            "provider_wire_projection_failed",
            "wire projection failed",
            V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
        )
        .expect("Err01 must produce the runtime source");
        let (payload, classified) =
            run_v3_err02_classified_operator(source_projection.clone(), source.clone(), None, None)
                .expect("Err02 must execute the base classification builder");

        assert_eq!(payload, serde_json::to_value(&classified).unwrap());
        assert_eq!(payload["source"], source_projection);
        assert_eq!(classified.source, source);
        assert_eq!(classified.class, "runtime_failure");
        assert_eq!(classified.terminal_state, "already_terminal");
        assert_ne!(classified.class, "provider_failure");
        assert_eq!(
            classified
                .source
                .internal_error
                .as_ref()
                .map(|internal| internal.internal_code),
            Some("500-150")
        );
        assert!(classified.provider_global_cooldown_ms.is_none());
        assert!(classified.provider_global_semantic_signature.is_none());
        assert!(payload.get("provider_global_cooldown_ms").is_none());
        assert!(payload.get("provider_global_semantic_signature").is_none());
    }
}
