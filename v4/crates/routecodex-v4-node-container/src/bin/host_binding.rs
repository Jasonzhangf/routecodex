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
    code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Default)]
struct HostBindingRuntime {
    container: Option<NodeContainer>,
    guards: Vec<NodeExecutionGuard>,
}

impl HostBindingRuntime {
    fn handle(&mut self, request: HostRequest) -> HostResponse {
        let request_id = request.request_id().to_string();
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
            Err(error) => failure(
                request_id,
                error_code(&error),
                error.to_string(),
                self.container.as_ref(),
            ),
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

fn error_code(error: &NodeContainerError) -> &'static str {
    match error {
        NodeContainerError::PlanHashMismatch => "plan_hash_mismatch",
        NodeContainerError::BindingMismatch => "binding_mismatch",
        NodeContainerError::InFlightExecutions(_) => "in_flight",
        NodeContainerError::InvalidState { .. } => "invalid_state",
        NodeContainerError::HostLifecycle(_) => "host_lifecycle",
        NodeContainerError::Bridge(_) => "bridge_error",
    }
}

fn success(request_id: String, container: Option<&NodeContainer>) -> HostResponse {
    HostResponse {
        ok: true,
        request_id,
        state: container.map(|value| state_name(value.state())),
        in_flight: container.map(NodeContainer::in_flight),
        code: None,
        error: None,
    }
}

fn failure(
    request_id: String,
    code: &'static str,
    error: String,
    container: Option<&NodeContainer>,
) -> HostResponse {
    HostResponse {
        ok: false,
        request_id,
        state: container.map(|value| state_name(value.state())),
        in_flight: container.map(NodeContainer::in_flight),
        code: Some(code),
        error: Some(error),
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
        let request_id = serde_json::from_str::<HostRequestIdentity>(&line)
            .ok()
            .and_then(|identity| identity.request_id)
            .unwrap_or_else(|| "invalid-request".to_string());
        let response = match HostRequest::parse(&line) {
            Ok(request) => runtime.handle(request),
            Err(error) => failure(
                request_id,
                "protocol_error",
                error,
                runtime.container.as_ref(),
            ),
        };
        write_response(&mut stdout, &response)?;
    }
    Ok(())
}
