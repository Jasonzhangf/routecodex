use std::io::{self, BufRead, Write};

use routecodex_v4_node_container::{
    NodeContainer, NodeContainerError, NodeContainerState, NodeExecutionGuard, PlanBindings,
};
use routecodex_v4_plugin_plan::NodePluginPlan;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum HostRequest {
    Declare {
        request_id: String,
        node_id: String,
        plan: NodePluginPlan,
        bindings: PlanBindingsWire,
    },
    ContextCreated {
        request_id: String,
    },
    PluginsMounted {
        request_id: String,
    },
    Publish {
        request_id: String,
    },
    EnterExecution {
        request_id: String,
    },
    ExitExecution {
        request_id: String,
    },
    Drain {
        request_id: String,
    },
    Fail {
        request_id: String,
    },
    Dispose {
        request_id: String,
    },
    Status {
        request_id: String,
    },
}

#[derive(Debug, Deserialize)]
struct HostRequestIdentity {
    request_id: Option<String>,
    node_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HostRequestPlanProbe<'a> {
    #[serde(borrow)]
    plan: Option<&'a RawValue>,
}

impl HostRequest {
    fn parse(input: &str) -> Result<Self, String> {
        let probe: HostRequestPlanProbe<'_> =
            serde_json::from_str(input).map_err(|error| error.to_string())?;
        if let Some(raw_plan) = probe.plan {
            let mut plan_deserializer = serde_json::Deserializer::from_str(raw_plan.get());
            let mut unknown_plan_field = None;
            let _: NodePluginPlan = serde_ignored::deserialize(&mut plan_deserializer, |path| {
                if unknown_plan_field.is_none() {
                    unknown_plan_field = Some(path.to_string());
                }
            })
            .map_err(|error| error.to_string())?;
            plan_deserializer.end().map_err(|error| error.to_string())?;
            if let Some(path) = unknown_plan_field {
                return Err(format!("unknown lifecycle plan field {path}"));
            }
        }
        serde_json::from_str(input).map_err(|error| error.to_string())
    }

    fn request_id(&self) -> &str {
        match self {
            Self::Declare { request_id, .. }
            | Self::ContextCreated { request_id }
            | Self::PluginsMounted { request_id }
            | Self::Publish { request_id }
            | Self::EnterExecution { request_id }
            | Self::ExitExecution { request_id }
            | Self::Drain { request_id }
            | Self::Fail { request_id }
            | Self::Dispose { request_id }
            | Self::Status { request_id } => request_id,
        }
    }

    fn operation(&self) -> LifecycleOperation {
        match self {
            Self::Declare { .. } => LifecycleOperation::Declare,
            Self::ContextCreated { .. } => LifecycleOperation::ContextCreated,
            Self::PluginsMounted { .. } => LifecycleOperation::PluginsMounted,
            Self::Publish { .. } => LifecycleOperation::Publish,
            Self::EnterExecution { .. } => LifecycleOperation::EnterExecution,
            Self::ExitExecution { .. } => LifecycleOperation::ExitExecution,
            Self::Drain { .. } => LifecycleOperation::Drain,
            Self::Fail { .. } => LifecycleOperation::Fail,
            Self::Dispose { .. } => LifecycleOperation::Dispose,
            Self::Status { .. } => LifecycleOperation::Status,
        }
    }

    fn node_id_hint(&self) -> Option<&str> {
        match self {
            Self::Declare { node_id, .. } => Some(node_id),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanBindingsWire {
    graph_hash: String,
    manifest_hash: String,
    loaded_plan_hash: String,
}

impl From<PlanBindingsWire> for PlanBindings {
    fn from(value: PlanBindingsWire) -> Self {
        Self {
            graph_hash: value.graph_hash,
            manifest_hash: value.manifest_hash,
            loaded_plan_hash: value.loaded_plan_hash,
        }
    }
}

#[derive(Debug, Serialize)]
struct HostResponse {
    ok: bool,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    in_flight: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<LifecycleFailureFact>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum LifecycleOperation {
    ProtocolDecode,
    Declare,
    ContextCreated,
    PluginsMounted,
    Publish,
    EnterExecution,
    ExitExecution,
    Drain,
    Fail,
    Dispose,
    Status,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum LifecycleFailureCode {
    ProtocolError,
    PlanHashMismatch,
    BindingMismatch,
    InFlight,
    InvalidState,
    HostLifecycle,
    BridgeError,
}

/// Typed control-plane failure fact for the lifecycle port. This is distinct
/// from the product request/response Error01-06 chain.
#[derive(Debug, Clone, Serialize)]
pub struct LifecycleFailureFact {
    resource_id: &'static str,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    node_id: Option<String>,
    operation: LifecycleOperation,
    code: LifecycleFailureCode,
    message: String,
}

#[derive(Default)]
struct HostBindingRuntime {
    container: Option<NodeContainer>,
    guards: Vec<NodeExecutionGuard>,
}

impl HostBindingRuntime {
    fn handle(&mut self, request: HostRequest) -> HostResponse {
        let request_id = request.request_id().to_string();
        let operation = request.operation();
        let node_id = request.node_id_hint().map(str::to_string).or_else(|| {
            self.container
                .as_ref()
                .map(|container| container.node_id().to_string())
        });
        let result: Result<(), NodeContainerError> = (|| match request {
            HostRequest::Declare {
                node_id,
                plan,
                bindings,
                ..
            } => {
                if self.container.is_some() {
                    Err(NodeContainerError::HostLifecycle(
                        "container already declared".to_string(),
                    ))
                } else {
                    NodeContainer::declare(node_id, plan, bindings.into()).map(|container| {
                        self.container = Some(container);
                    })
                }
            }
            HostRequest::ContextCreated { .. } => self.container_mut()?.context_created(),
            HostRequest::PluginsMounted { .. } => self.container_mut()?.plugins_mounted(),
            HostRequest::Publish { .. } => self.container_mut()?.publish(),
            HostRequest::EnterExecution { .. } => {
                let guard = self.container_ref()?.enter_execution()?;
                self.guards.push(guard);
                Ok(())
            }
            HostRequest::ExitExecution { .. } => {
                let guard = self.guards.pop().ok_or_else(|| {
                    NodeContainerError::HostLifecycle("no in-flight execution to exit".to_string())
                })?;
                drop(guard);
                Ok(())
            }
            HostRequest::Drain { .. } => self.container_mut()?.drain(),
            HostRequest::Fail { .. } => self.container_mut()?.fail(),
            HostRequest::Dispose { .. } => self.container_mut()?.dispose(),
            HostRequest::Status { .. } => self.container_ref().map(|_| ()),
        })();
        match result {
            Ok(()) => success(request_id, self.container.as_ref()),
            Err(error) => {
                let failure =
                    LifecycleFailureFact::from_error(request_id, node_id, operation, &error);
                failure_response(failure, self.container.as_ref())
            }
        }
    }

    fn container_ref(&self) -> Result<&NodeContainer, NodeContainerError> {
        self.container.as_ref().ok_or_else(|| {
            NodeContainerError::HostLifecycle("container is not declared".to_string())
        })
    }

    fn container_mut(&mut self) -> Result<&mut NodeContainer, NodeContainerError> {
        self.container.as_mut().ok_or_else(|| {
            NodeContainerError::HostLifecycle("container is not declared".to_string())
        })
    }
}

fn state_name(state: NodeContainerState) -> &'static str {
    match state {
        NodeContainerState::Declared => "declared",
        NodeContainerState::ContextCreated => "context_created",
        NodeContainerState::PluginsMounted => "plugins_mounted",
        NodeContainerState::Accepting => "accepting",
        NodeContainerState::Draining => "draining",
        NodeContainerState::Disposed => "disposed",
        NodeContainerState::Failed => "failed",
    }
}

impl LifecycleFailureFact {
    fn protocol(request_id: String, node_id: Option<String>, message: String) -> Self {
        Self {
            resource_id: "v4.node_container.lifecycle_failure",
            request_id,
            node_id,
            operation: LifecycleOperation::ProtocolDecode,
            code: LifecycleFailureCode::ProtocolError,
            message,
        }
    }

    fn from_error(
        request_id: String,
        node_id: Option<String>,
        operation: LifecycleOperation,
        error: &NodeContainerError,
    ) -> Self {
        let code = match error {
            NodeContainerError::PlanHashMismatch => LifecycleFailureCode::PlanHashMismatch,
            NodeContainerError::BindingMismatch => LifecycleFailureCode::BindingMismatch,
            NodeContainerError::InFlightExecutions(_) => LifecycleFailureCode::InFlight,
            NodeContainerError::InvalidState { .. } => LifecycleFailureCode::InvalidState,
            NodeContainerError::HostLifecycle(_) => LifecycleFailureCode::HostLifecycle,
            NodeContainerError::Bridge(_) => LifecycleFailureCode::BridgeError,
        };
        Self {
            resource_id: "v4.node_container.lifecycle_failure",
            request_id,
            node_id,
            operation,
            code,
            message: error.to_string(),
        }
    }
}

fn success(request_id: String, container: Option<&NodeContainer>) -> HostResponse {
    HostResponse {
        ok: true,
        request_id,
        state: container.map(|value| state_name(value.state())),
        in_flight: container.map(NodeContainer::in_flight),
        failure: None,
    }
}

fn failure_response(
    failure: LifecycleFailureFact,
    container: Option<&NodeContainer>,
) -> HostResponse {
    HostResponse {
        ok: false,
        request_id: failure.request_id.clone(),
        state: container.map(|value| state_name(value.state())),
        in_flight: container.map(NodeContainer::in_flight),
        failure: Some(failure),
    }
}

fn write_response(stdout: &mut impl Write, response: &HostResponse) -> io::Result<()> {
    serde_json::to_writer(&mut *stdout, response)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut runtime = HostBindingRuntime::default();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let identity = serde_json::from_str::<HostRequestIdentity>(&line).ok();
        let request_id = identity
            .as_ref()
            .and_then(|value| value.request_id.clone())
            .unwrap_or_else(|| "invalid-request".to_string());
        let node_id = identity.and_then(|value| value.node_id);
        let response = match HostRequest::parse(&line) {
            Ok(request) => runtime.handle(request),
            Err(error) => {
                let failure = LifecycleFailureFact::protocol(
                    request_id,
                    runtime
                        .container
                        .as_ref()
                        .map(|container| container.node_id().to_string())
                        .or(node_id),
                    error,
                );
                failure_response(failure, runtime.container.as_ref())
            }
        };
        write_response(&mut stdout, &response)?;
    }
    Ok(())
}
