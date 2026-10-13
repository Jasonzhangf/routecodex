//! Fixed Error operators. Control stays in this execution's typed resource;
//! JSON ARCs carry scheduling tokens only, never serialized control state.
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_error::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub(crate) const STAGES: [(&str, &str); 6] = [
    (
        "error_err01_source_raised",
        "routecodex.v3.error.err01_source_raised",
    ),
    (
        "error_err02_host_captured",
        "routecodex.v3.error.err02_host_captured",
    ),
    (
        "error_err03_runtime_classified",
        "routecodex.v3.error.err03_runtime_classified",
    ),
    (
        "error_err04_router_policy_applied",
        "routecodex.v3.error.err04_router_policy_applied",
    ),
    (
        "error_err05_execution_decision",
        "routecodex.v3.error.err05_execution_decision",
    ),
    (
        "error_err06_client_projected",
        "routecodex.v3.error.err06_client_projected",
    ),
];

pub(crate) struct ClientSourceResources {
    pub failure: V3ClientTransportFailure,
    pub source: Option<V3Error01SourceRaised>,
    pub host: Option<V3Error02HostCaptured>,
    pub classified: Option<V3Error02Classified>,
    pub policy: Option<V3Error04TargetExhaustionDecision>,
    pub decision: Option<V3Error05ExecutionDecision>,
    pub outcome: Option<V3Error06ClientProjected>,
}

impl ClientSourceResources {
    pub fn new(failure: V3ClientTransportFailure) -> Self {
        Self {
            failure,
            source: None,
            host: None,
            classified: None,
            policy: None,
            decision: None,
            outcome: None,
        }
    }
}

pub(crate) struct ClientSourceErrorOperator {
    pub stage: usize,
    pub resources: Arc<Mutex<ClientSourceResources>>,
}

impl Operator for ClientSourceErrorOperator {
    fn name(&self) -> &'static str {
        STAGES[self.stage].1
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
    fn effects(&self) -> &'static [&'static str] {
        match self.stage {
            0..=3 => &["v3.error.chain"],
            4 => &["v3.error.chain", "v3.error.execution_decision"],
            5 => &["v3.error.client_projection_candidate"],
            _ => unreachable!("fixed Error stage"),
        }
    }
    fn execute(&self, _input: Value, context: &OperatorContext) -> Result<Value, String> {
        let mut resource = self.resources.lock().map_err(|error| error.to_string())?;
        if context.identity.execution_id != resource.failure.request_id
            || context.node_id != STAGES[self.stage].0
        {
            return Err("Error operator identity does not match its typed resource".into());
        }
        match self.stage {
            0 => {
                resource.source = Some(build_v3_error_01_source_raised_for_client_transport(
                    &resource.failure,
                ))
            }
            1 => {
                resource.host = Some(build_v3_error_02_host_captured_from_client_transport(
                    resource.source.clone().ok_or("missing source resource")?,
                    &resource.failure,
                ))
            }
            2 => {
                resource.classified = Some(build_v3_error_02_classified_from_v3_error_01(
                    resource
                        .host
                        .as_ref()
                        .ok_or("missing HostCaptured resource")?
                        .source
                        .clone(),
                ))
            }
            3 => {
                let action = build_v3_error_03_target_local_action_from_v3_error_02(
                    resource
                        .classified
                        .clone()
                        .ok_or("missing classified resource")?,
                    V3ErrorActionScope::None,
                    0,
                );
                resource.policy = Some(
                    build_v3_error_04_target_exhaustion_decision_with_provider_availability(
                        action, 0, false, false,
                    ),
                );
            }
            4 => {
                resource.decision = Some(build_v3_error_05_execution_decision_from_v3_error_04(
                    resource.policy.clone().ok_or("missing policy resource")?,
                    None,
                ))
            }
            5 => {
                let terminal = resource
                    .decision
                    .clone()
                    .ok_or("missing execution decision resource")?
                    .try_into_terminal()
                    .map_err(|_| "client source decision is not terminal")?;
                resource.outcome = Some(V3ErrorHandlingCenter::project_terminal_decision(terminal));
            }
            _ => unreachable!("fixed Error stage"),
        }
        Ok(json!({}))
    }
}
