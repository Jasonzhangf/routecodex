use crate::hub_v1::{
    project_v3_operation_runner_standard_provider_request, V3HubEntryProtocol,
    V3HubProviderWireProtocol, V3HubTransportIntent,
};
use crate::projection_drop_log::V3ProjectionDropRecord;
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry;
use serde_json::Value;
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.operation.project_standard_provider_request";
const OPERATOR_VERSION: &str = "1";

pub(crate) struct StandardProjectionSideOutput {
    pub(crate) drops: Vec<V3ProjectionDropRecord>,
    pub(crate) namespace_registry: NamespaceToolIdentityRegistry,
}

pub(crate) struct ProjectStandardProviderRequestOperator {
    entry_protocol: V3HubEntryProtocol,
    transport_intent: V3HubTransportIntent,
    provider_protocol: V3HubProviderWireProtocol,
    selected_target: routecodex_v3_target::V3TargetCandidate,
    side_output: Arc<Mutex<Option<StandardProjectionSideOutput>>>,
}

impl ProjectStandardProviderRequestOperator {
    pub(crate) fn new(
        entry_protocol: V3HubEntryProtocol,
        transport_intent: V3HubTransportIntent,
        provider_protocol: V3HubProviderWireProtocol,
        selected_target: routecodex_v3_target::V3TargetCandidate,
        side_output: Arc<Mutex<Option<StandardProjectionSideOutput>>>,
    ) -> Self {
        Self {
            entry_protocol,
            transport_intent,
            provider_protocol,
            selected_target,
            side_output,
        }
    }
}

impl Operator for ProjectStandardProviderRequestOperator {
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

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let projected = project_v3_operation_runner_standard_provider_request(
            &input,
            self.entry_protocol,
            self.transport_intent,
            self.provider_protocol,
            &self.selected_target,
        )?;
        let mut holder = self.side_output.lock().map_err(|_| {
            "provider standard projection side-output holder is poisoned".to_string()
        })?;
        *holder = Some(StandardProjectionSideOutput {
            drops: projected.drops,
            namespace_registry: projected.namespace_registry,
        });
        Ok(projected.payload)
    }
}
