//! routecodex-v4-cordis-bridge — typed bridge between the real Cordis host
//! (Node/TS side) and the Rust plan executor.
//!
//! The bridge is transport-neutral: it owns the typed message schema and the
//! per-node execution engine (plan hash verify -> ordered typed handles ->
//! effect write guards -> parallel read-only diagnostics). Hard boundaries:
//! - no generic metadata carrier: data / control / diagnostics are separate
//!   typed fields and never merged into business payload or control state;
//! - the executor never scans plugin directories, never re-orders plugins and
//!   never infers dependencies; it consumes only the compiled NodePluginPlan;
//! - diagnostic-only entries run concurrently and can never touch data or
//!   control (the write guards reject any mutation).

use routecodex_v4_plugin_contract::{PluginEffect, ResourceRegistry};
use routecodex_v4_plugin_plan::{
    compile_node_plan, AuthoringPlugin, NodePluginPlan, PlanError,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One typed diagnostic fact published by a plugin (side-channel only).
#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticFact {
    pub kind: String,
    pub plugin_id: String,
    pub message: String,
}

/// Typed per-node execution input. Data and control stay in separate fields;
/// no synthetic metadata blob is accepted.
#[derive(Debug, Clone, Deserialize)]
pub struct NodeExecutionInput {
    pub data: Value,
    pub control: Value,
}

/// Typed per-node execution output.
#[derive(Debug, Clone, Serialize)]
pub struct NodeExecutionOutput {
    pub data: Value,
    pub control: Value,
    pub diagnostics: Vec<DiagnosticFact>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeError {
    PlanHashMismatch,
    UnregisteredHandle(String),
    HandleError {
        plugin_id: String,
        message: String,
    },
    EffectViolation {
        plugin_id: String,
        message: String,
    },
    Compile(PlanError),
    Protocol(String),
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PlanHashMismatch => {
                write!(formatter, "plan hash mismatch: compiled plan drifted")
            }
            Self::UnregisteredHandle(plugin_id) => {
                write!(formatter, "unregistered native handle for plugin {plugin_id}")
            }
            Self::HandleError { plugin_id, message } => {
                write!(formatter, "plugin {plugin_id} handle failed: {message}")
            }
            Self::EffectViolation { plugin_id, message } => {
                write!(formatter, "plugin {plugin_id} effect violation: {message}")
            }
            Self::Compile(error) => write!(formatter, "plan compile failed: {error}"),
            Self::Protocol(message) => write!(formatter, "protocol error: {message}"),
        }
    }
}

impl std::error::Error for BridgeError {}

/// Mutable execution state for one node dispatch. The write guards are the
/// runtime enforcement of the plugin effect contract.
#[derive(Clone)]
struct ExecState {
    data: Value,
    control: Value,
    diagnostics: Vec<DiagnosticFact>,
}

/// Typed handle context handed to one plugin for one dispatch.
pub struct ExecCtx<'a> {
    state: &'a mut ExecState,
    effect: PluginEffect,
    plugin_id: &'a str,
}

impl ExecCtx<'_> {
    pub fn read_data(&self) -> &Value {
        &self.state.data
    }

    pub fn read_control(&self) -> &Value {
        &self.state.control
    }

    pub fn emit(&mut self, kind: &str, message: impl Into<String>) {
        self.state.diagnostics.push(DiagnosticFact {
            kind: kind.to_string(),
            plugin_id: self.plugin_id.to_string(),
            message: message.into(),
        });
    }

    pub fn write_data(&mut self, value: Value) -> Result<(), BridgeError> {
        if !matches!(self.effect, PluginEffect::Semantic) {
            return Err(BridgeError::EffectViolation {
                plugin_id: self.plugin_id.to_string(),
                message: format!("effect {:?} cannot write normal data", self.effect),
            });
        }
        self.state.data = value;
        Ok(())
    }

    pub fn write_control(&mut self, value: Value) -> Result<(), BridgeError> {
        if !matches!(
            self.effect,
            PluginEffect::Semantic | PluginEffect::ControlOnly
        ) {
            return Err(BridgeError::EffectViolation {
                plugin_id: self.plugin_id.to_string(),
                message: format!("effect {:?} cannot write control", self.effect),
            });
        }
        self.state.control = value;
        Ok(())
    }
}

/// A typed native handle registered for one plugin id. Handles are the only
/// business code the executor runs; identity/order/permissions come from the
/// compiled plan.
pub trait PluginHandle: Send + Sync {
    fn execute(&self, ctx: &mut ExecCtx<'_>, config: &Value) -> Result<(), String>;
}

/// Registry of typed handles visible to one NodeContainer.
pub trait HandleRegistry: Send + Sync {
    fn get(&self, plugin_id: &str) -> Option<&dyn PluginHandle>;

    fn contains(&self, plugin_id: &str) -> bool {
        self.get(plugin_id).is_some()
    }
}

/// Execute one compiled node plan: verify the hash, run serial entries in
/// plan order through typed handles, then run diagnostic-only entries
/// concurrently as read-only observers.
pub fn execute_plan(
    plan: &NodePluginPlan,
    input: NodeExecutionInput,
    registry: &dyn HandleRegistry,
) -> Result<NodeExecutionOutput, BridgeError> {
    if !plan.verify() {
        return Err(BridgeError::PlanHashMismatch);
    }
    for entry in &plan.entries {
        if !registry.contains(&entry.plugin_id) {
            return Err(BridgeError::UnregisteredHandle(entry.plugin_id.clone()));
        }
    }
    let mut state = ExecState {
        data: input.data,
        control: input.control,
        diagnostics: Vec::new(),
    };
    for entry in &plan.entries {
        if matches!(entry.effect, PluginEffect::DiagnosticOnly) {
            continue;
        }
        let handle = registry
            .get(&entry.plugin_id)
            .ok_or_else(|| BridgeError::UnregisteredHandle(entry.plugin_id.clone()))?;
        let mut ctx = ExecCtx {
            state: &mut state,
            effect: entry.effect,
            plugin_id: &entry.plugin_id,
        };
        handle
            .execute(&mut ctx, &Value::Null)
            .map_err(|message| BridgeError::HandleError {
                plugin_id: entry.plugin_id.clone(),
                message,
            })?;
    }

    // Diagnostic-only entries: read-only concurrent observers with a private
    // sink; they cannot mutate data/control by construction.
    let snapshot = ExecState {
        data: state.data.clone(),
        control: state.control.clone(),
        diagnostics: Vec::new(),
    };
    let sink: std::sync::Mutex<
        Vec<(usize, Result<Vec<DiagnosticFact>, BridgeError>)>,
    > = std::sync::Mutex::new(Vec::new());
    let sink = std::sync::Arc::new(sink);
    std::thread::scope(|scope| {
        for (index, entry) in plan
            .entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| matches!(entry.effect, PluginEffect::DiagnosticOnly))
        {
            let snapshot = &snapshot;
            let sink = std::sync::Arc::clone(&sink);
            let plugin_id = entry.plugin_id.clone();
            scope.spawn(move || {
                let result = match registry.get(&plugin_id) {
                    Some(handle) => {
                        let mut scratch = snapshot.clone();
                        let mut ctx = ExecCtx {
                            state: &mut scratch,
                            effect: PluginEffect::DiagnosticOnly,
                            plugin_id: &plugin_id,
                        };
                        match handle.execute(&mut ctx, &Value::Null) {
                            Ok(()) => Ok(ctx.state.diagnostics.clone()),
                            Err(message) => Err(BridgeError::HandleError {
                                plugin_id: plugin_id.clone(),
                                message,
                            }),
                        }
                    }
                    None => Err(BridgeError::UnregisteredHandle(plugin_id.clone())),
                };
                sink.lock()
                    .expect("diagnostic sink lock")
                    .push((index, result));
            });
        }
    });
    let mut outcomes = sink.lock().expect("diagnostic sink lock");
    outcomes.sort_by_key(|(index, _)| *index);
    for (_, result) in outcomes.drain(..) {
        state.diagnostics.append(&mut result?);
    }

    Ok(NodeExecutionOutput {
        data: state.data,
        control: state.control,
        diagnostics: state.diagnostics,
    })
}

/// Compile one node's immutable plan through the single Rust plan compiler.
/// `container_services` are NodeContainer host services (never plugin-owned).
pub fn compile_node(
    node_id: &str,
    role_id: &str,
    chain: &str,
    position: u32,
    authoring: &[AuthoringPlugin],
    allowed_reads: &[String],
    allowed_writes: &[String],
    resources: &ResourceRegistry,
    container_services: &[String],
) -> Result<NodePluginPlan, BridgeError> {
    compile_node_plan(
        node_id,
        role_id,
        chain,
        position,
        authoring,
        allowed_reads,
        allowed_writes,
        resources,
        container_services,
    )
    .map_err(BridgeError::Compile)
}

// ---------------------------------------------------------------------------
// Transport message schema (line JSON / NAPI worker share the same types)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct NodeSpec {
    pub node_id: String,
    pub role_id: String,
    pub chain: String,
    pub position: u32,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BridgeRequest {
    Ping { request_id: String },
    CompileNode {
        request_id: String,
        node: NodeSpec,
        authoring: Vec<AuthoringPlugin>,
        allowed_reads: Vec<String>,
        allowed_writes: Vec<String>,
        resources: ResourceRegistry,
        container_services: Vec<String>,
    },
    ExecuteNode {
        request_id: String,
        plan: NodePluginPlan,
        input: NodeExecutionInput,
    },
}

#[derive(Debug, Serialize)]
pub struct BridgeResponse {
    pub ok: bool,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<NodePluginPlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<NodeExecutionOutput>,
}

fn fail(request_id: String, kind: &str, error: String) -> BridgeResponse {
    BridgeResponse {
        ok: false,
        request_id,
        kind: Some(kind.to_string()),
        error: Some(error),
        plan: None,
        output: None,
    }
}

/// Dispatch one typed request to a stateless response. `registry` is only
/// required for execute requests; a `None` registry fails fast.
pub fn dispatch(
    request: &BridgeRequest,
    registry: Option<&dyn HandleRegistry>,
) -> BridgeResponse {
    match request {
        BridgeRequest::Ping { request_id } => BridgeResponse {
            ok: true,
            request_id: request_id.clone(),
            kind: None,
            error: None,
            plan: None,
            output: None,
        },
        BridgeRequest::CompileNode {
            request_id,
            node,
            authoring,
            allowed_reads,
            allowed_writes,
            resources,
            container_services,
        } => match compile_node(
            &node.node_id,
            &node.role_id,
            &node.chain,
            node.position,
            authoring,
            allowed_reads,
            allowed_writes,
            resources,
            container_services,
        ) {
            Ok(plan) => BridgeResponse {
                ok: true,
                request_id: request_id.clone(),
                kind: None,
                error: None,
                plan: Some(plan),
                output: None,
            },
            Err(error) => fail(request_id.clone(), "plan_error", error.to_string()),
        },
        BridgeRequest::ExecuteNode {
            request_id,
            plan,
            input,
        } => {
            let Some(registry) = registry else {
                return fail(
                    request_id.clone(),
                    "no_handle_registry",
                    "execute requires a typed handle registry".to_string(),
                );
            };
            match execute_plan(plan, input.clone(), registry) {
                Ok(output) => BridgeResponse {
                    ok: true,
                    request_id: request_id.clone(),
                    kind: None,
                    error: None,
                    plan: None,
                    output: Some(output),
                },
                Err(BridgeError::PlanHashMismatch) => fail(
                    request_id.clone(),
                    "hash_mismatch",
                    BridgeError::PlanHashMismatch.to_string(),
                ),
                Err(error) => fail(request_id.clone(), "execute_error", error.to_string()),
            }
        }
    }
}
