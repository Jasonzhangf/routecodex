use std::collections::HashMap;
use std::io::{self, BufRead, Write};

use routecodex_v4_cordis_bridge::{
    BridgeError, ExecCtx, HandleRegistry, NodeExecutionInput, NodeExecutionOutput, PluginHandle,
};
use routecodex_v4_node_container::{
    NodeContainer, NodeContainerError, NodeContainerState, NodeExecutionGuard, PlanBindings,
};
use routecodex_v4_plugin_plan::NodePluginPlan;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Value};

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
    ExecuteNode {
        request_id: String,
        plan_hash: String,
        input: NodeExecutionInput,
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
            | Self::ExecuteNode { request_id, .. }
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
            Self::ExecuteNode { .. } => LifecycleOperation::ExecuteNode,
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
    failure: Option<HostFailureFact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<NodeExecutionOutput>,
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
    ExecuteNode,
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

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum ExecutionFailureCode {
    PlanHashMismatch,
    InvalidState,
    UnregisteredHandle,
    HandleError,
    EffectViolation,
    BridgeError,
    ProtocolError,
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

/// Typed execution failure fact for the NodeContainer execution port. It is
/// separate from lifecycle failures and from product Error01-06 because node
/// execution has no request/session/target scope on this management channel.
#[derive(Debug, Clone, Serialize)]
pub struct ExecutionFailureFact {
    resource_id: &'static str,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    node_id: Option<String>,
    operation: LifecycleOperation,
    code: ExecutionFailureCode,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
enum HostFailureFact {
    Lifecycle(LifecycleFailureFact),
    Execution(ExecutionFailureFact),
}

/// Keyless built-in typed handles for the M3 vertical slice. The real Cordis
/// plugins own lifecycle/registration identity; Rust owns these handles and
/// only runs them through the compiled plan.
struct StepEchoHandle {
    plugin_id: &'static str,
}

impl PluginHandle for StepEchoHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        let mut data = ctx.read_data().clone();
        let object = data
            .as_object_mut()
            .ok_or_else(|| "node data must be an object".to_string())?;
        let steps = object
            .entry("steps".to_string())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| "node data.steps must be an array".to_string())?;
        steps.push(Value::String(self.plugin_id.to_string()));
        ctx.write_data(data).map_err(|error| error.to_string())
    }
}

struct ControlHandle;

impl PluginHandle for ControlHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        let mut metadata = ctx
            .read_control_resource("v4.control.metadata_center")
            .map_err(|error| error.to_string())?
            .cloned()
            .unwrap_or_else(|| json!({}));
        let object = metadata
            .as_object_mut()
            .ok_or_else(|| "metadata center must be an object".to_string())?;
        object.insert(
            "written_by".to_string(),
            Value::String("control".to_string()),
        );
        ctx.write_control_resource("v4.control.metadata_center", metadata)
            .map_err(|error| error.to_string())
    }
}

struct ObserveHandle;

impl PluginHandle for ObserveHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        ctx.emit("node.observed", "observer saw node");
        Ok(())
    }
}

struct BuiltinHandleRegistry {
    handles: HashMap<String, Box<dyn PluginHandle>>,
}

impl BuiltinHandleRegistry {
    fn new() -> Self {
        let mut handles: HashMap<String, Box<dyn PluginHandle>> = HashMap::new();
        handles.insert("v4.test.control".to_string(), Box::new(ControlHandle));
        handles.insert(
            "v4.test.echo".to_string(),
            Box::new(StepEchoHandle {
                plugin_id: "v4.test.echo",
            }),
        );
        handles.insert("v4.test.observe".to_string(), Box::new(ObserveHandle));
        Self { handles }
    }
}

impl HandleRegistry for BuiltinHandleRegistry {
    fn get(&self, plugin_id: &str) -> Option<&dyn PluginHandle> {
        self.handles.get(plugin_id).map(|boxed| boxed.as_ref())
    }
}

struct HostBindingRuntime {
    container: Option<NodeContainer>,
    guards: Vec<NodeExecutionGuard>,
    registry: BuiltinHandleRegistry,
}

impl Default for HostBindingRuntime {
    fn default() -> Self {
        Self {
            container: None,
            guards: Vec::new(),
            registry: BuiltinHandleRegistry::new(),
        }
    }
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
        // Execution and lifecycle are intentionally split: ExecuteNode is the
        // only op whose success response carries a typed NodeExecutionOutput;
        // every other lifecycle success must NOT project an output so the
        // JS decoder's per-operation schema stays the only transport truth.
        let result: Result<Option<NodeExecutionOutput>, NodeContainerError> = (|| match request {
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
                    })?;
                    Ok(None)
                }
            }
            HostRequest::ContextCreated { .. } => {
                self.container_mut()?.context_created()?;
                Ok(None)
            }
            HostRequest::PluginsMounted { .. } => {
                self.container_mut()?.plugins_mounted()?;
                Ok(None)
            }
            HostRequest::Publish { .. } => {
                self.container_mut()?.publish()?;
                Ok(None)
            }
            HostRequest::EnterExecution { .. } => {
                let guard = self.container_ref()?.enter_execution()?;
                self.guards.push(guard);
                Ok(None)
            }
            HostRequest::ExitExecution { .. } => {
                let guard = self.guards.pop().ok_or_else(|| {
                    NodeContainerError::HostLifecycle("no in-flight execution to exit".to_string())
                })?;
                drop(guard);
                Ok(None)
            }
            HostRequest::Drain { .. } => {
                self.container_mut()?.drain()?;
                Ok(None)
            }
            HostRequest::Fail { .. } => {
                self.container_mut()?.fail()?;
                Ok(None)
            }
            HostRequest::Dispose { .. } => {
                self.container_mut()?.dispose()?;
                Ok(None)
            }
            HostRequest::ExecuteNode {
                plan_hash, input, ..
            } => {
                let container = self.container_ref()?;
                let output = container
                    .execute_with_plan_hash(&plan_hash, input, &self.registry)
                    .map(Some)?;
                Ok(output)
            }
            HostRequest::Status { .. } => self.container_ref().map(|_| None),
        })();
        match result {
            Ok(output) => success(request_id, output, self.container.as_ref()),
            Err(error) => {
                let failure = if matches!(operation, LifecycleOperation::ExecuteNode) {
                    HostFailureFact::Execution(ExecutionFailureFact::from_error(
                        request_id, node_id, &error,
                    ))
                } else {
                    HostFailureFact::Lifecycle(LifecycleFailureFact::from_error(
                        request_id, node_id, operation, &error,
                    ))
                };
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

fn success(
    request_id: String,
    output: Option<NodeExecutionOutput>,
    container: Option<&NodeContainer>,
) -> HostResponse {
    HostResponse {
        ok: true,
        request_id,
        state: container.map(|value| state_name(value.state())),
        in_flight: container.map(NodeContainer::in_flight),
        failure: None,
        output,
    }
}

impl HostFailureFact {
    fn request_id(&self) -> &str {
        match self {
            Self::Lifecycle(fact) => fact.request_id.as_str(),
            Self::Execution(fact) => fact.request_id.as_str(),
        }
    }
}

impl ExecutionFailureFact {
    fn from_error(request_id: String, node_id: Option<String>, error: &NodeContainerError) -> Self {
        let code = match error {
            NodeContainerError::PlanHashMismatch => ExecutionFailureCode::PlanHashMismatch,
            NodeContainerError::BindingMismatch => ExecutionFailureCode::ProtocolError,
            NodeContainerError::InFlightExecutions(_) => ExecutionFailureCode::InvalidState,
            NodeContainerError::InvalidState { .. } => ExecutionFailureCode::InvalidState,
            NodeContainerError::HostLifecycle(_) => ExecutionFailureCode::ProtocolError,
            NodeContainerError::Bridge(bridge) => match bridge {
                BridgeError::PlanHashMismatch => ExecutionFailureCode::PlanHashMismatch,
                BridgeError::UnregisteredHandle(_) => ExecutionFailureCode::UnregisteredHandle,
                BridgeError::HandleError { .. } => ExecutionFailureCode::HandleError,
                BridgeError::EffectViolation { .. }
                | BridgeError::ResourceAccessViolation { .. } => {
                    ExecutionFailureCode::EffectViolation
                }
                BridgeError::Compile(_) => ExecutionFailureCode::BridgeError,
                BridgeError::Protocol(_) => ExecutionFailureCode::ProtocolError,
            },
        };
        Self {
            resource_id: "v4.node_container.execution_failure",
            request_id,
            node_id,
            operation: LifecycleOperation::ExecuteNode,
            code,
            message: error.to_string(),
        }
    }
}

fn failure_response(failure: HostFailureFact, container: Option<&NodeContainer>) -> HostResponse {
    HostResponse {
        ok: false,
        request_id: failure.request_id().to_string(),
        state: container.map(|value| state_name(value.state())),
        in_flight: container.map(NodeContainer::in_flight),
        failure: Some(failure),
        output: None,
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
                failure_response(
                    HostFailureFact::Lifecycle(failure),
                    runtime.container.as_ref(),
                )
            }
        };
        write_response(&mut stdout, &response)?;
    }
    Ok(())
}
