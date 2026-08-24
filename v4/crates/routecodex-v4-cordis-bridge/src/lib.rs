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
use routecodex_v4_plugin_plan::{compile_node_plan, AuthoringPlugin, NodePluginPlan, PlanError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeSessionOperation {
    Bind,
    Release,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeEntryProtocol {
    Responses,
    Chat,
}

impl ScopeEntryProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::Chat => "chat",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeContinuationOwner {
    Direct,
    Relay,
}

impl ScopeContinuationOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Relay => "relay",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub struct ScopeSessionCommand {
    pub entry_protocol: ScopeEntryProtocol,
    pub continuation_owner: ScopeContinuationOwner,
    pub pipeline_id: String,
    pub port: u16,
    pub session_scope: String,
    pub conversation_scope: String,
    pub request_id: String,
    pub full_input_hash: String,
    pub operation: ScopeSessionOperation,
    pub sequence: u64,
}

impl ScopeSessionCommand {
    pub fn parse(value: &Value) -> Result<Self, BridgeError> {
        let parsed: Self = serde_json::from_value(value.clone()).map_err(|error| {
            BridgeError::Protocol(format!("invalid scope_command control value: {error}"))
        })?;
        if parsed.pipeline_id.trim().is_empty()
            || parsed.session_scope.trim().is_empty()
            || parsed.conversation_scope.trim().is_empty()
            || parsed.request_id.trim().is_empty()
            || parsed.full_input_hash.trim().is_empty()
            || parsed.port == 0
        {
            return Err(BridgeError::Protocol(
                "invalid scope_command control value: required fields are empty".to_string(),
            ));
        }
        Ok(parsed)
    }
}

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
#[serde(deny_unknown_fields)]
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
    ResourceAccessViolation {
        plugin_id: String,
        resource_id: String,
        operation: &'static str,
    },
    Compile(PlanError),
    Protocol(String),
}

/// Source-side Cordis mount/publication candidate.  It proves graph,
/// manifest, and loaded-plan identity before any runtime publication occurs;
/// this type deliberately has no active-pointer or request-admission handle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CordisMountCandidate {
    pub node_id: String,
    pub plan: NodePluginPlan,
    pub cordis_graph_hash: String,
    pub manifest_hash: String,
    pub loaded_plan_hash: String,
}

impl CordisMountCandidate {
    pub fn verify(&self) -> bool {
        self.plan.verify()
            && !self.cordis_graph_hash.is_empty()
            && self.cordis_graph_hash == self.manifest_hash
            && self.manifest_hash == self.loaded_plan_hash
            && self.loaded_plan_hash == self.plan.hash
    }
}

/// Build a deterministic mount candidate without mutating Cordis or the
/// ActiveExecutionEpoch.  Publication is owned by the lifecycle/container
/// lane after this candidate is independently verified.
pub fn mount_candidate(
    node_id: &str,
    plan: NodePluginPlan,
    cordis_graph_hash: &str,
    manifest_hash: &str,
    loaded_plan_hash: &str,
) -> Result<CordisMountCandidate, BridgeError> {
    if node_id.trim().is_empty()
        || cordis_graph_hash.trim().is_empty()
        || manifest_hash.trim().is_empty()
        || loaded_plan_hash.trim().is_empty()
    {
        return Err(BridgeError::Protocol(
            "mount candidate identity fields must be non-empty".to_string(),
        ));
    }
    let candidate = CordisMountCandidate {
        node_id: node_id.to_string(),
        plan,
        cordis_graph_hash: cordis_graph_hash.to_string(),
        manifest_hash: manifest_hash.to_string(),
        loaded_plan_hash: loaded_plan_hash.to_string(),
    };
    if !candidate.verify() {
        return Err(BridgeError::PlanHashMismatch);
    }
    Ok(candidate)
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PlanHashMismatch => {
                write!(formatter, "plan hash mismatch: compiled plan drifted")
            }
            Self::UnregisteredHandle(plugin_id) => {
                write!(
                    formatter,
                    "unregistered native handle for plugin {plugin_id}"
                )
            }
            Self::HandleError { plugin_id, message } => {
                write!(formatter, "plugin {plugin_id} handle failed: {message}")
            }
            Self::EffectViolation { plugin_id, message } => {
                write!(formatter, "plugin {plugin_id} effect violation: {message}")
            }
            Self::ResourceAccessViolation {
                plugin_id,
                resource_id,
                operation,
            } => write!(
                formatter,
                "plugin {plugin_id} cannot {operation} undeclared control resource {resource_id}"
            ),
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
    reads: &'a [String],
    writes: &'a [String],
    resource_violation: Option<BridgeError>,
}

impl ExecCtx<'_> {
    pub fn read_data(&self) -> &Value {
        &self.state.data
    }

    pub fn read_control_resource(
        &mut self,
        resource_id: &str,
    ) -> Result<Option<&Value>, BridgeError> {
        if !self
            .reads
            .iter()
            .any(|declared_id| declared_id == resource_id)
        {
            return Err(self.deny_resource_access(resource_id, "read"));
        }
        let Some(key) = control_resource_key(resource_id) else {
            return Err(self.deny_resource_access(resource_id, "read"));
        };
        if !self.state.control.is_object() {
            return Err(self.deny_resource_access(resource_id, "read from non-object carrier"));
        }
        let control = self
            .state
            .control
            .as_object()
            .expect("control object checked before read");
        let value = control.get(key);
        if resource_id == "v4.control.scope_command" {
            if let Some(value) = value {
                ScopeSessionCommand::parse(value)?;
            }
        }
        Ok(value)
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

    pub fn write_control_resource(
        &mut self,
        resource_id: &str,
        value: Value,
    ) -> Result<(), BridgeError> {
        if !matches!(
            self.effect,
            PluginEffect::Semantic | PluginEffect::ControlOnly
        ) {
            return Err(BridgeError::EffectViolation {
                plugin_id: self.plugin_id.to_string(),
                message: format!("effect {:?} cannot write control", self.effect),
            });
        }
        if !self
            .writes
            .iter()
            .any(|declared_id| declared_id == resource_id)
        {
            return Err(self.deny_resource_access(resource_id, "write"));
        }
        let Some(key) = control_resource_key(resource_id) else {
            return Err(self.deny_resource_access(resource_id, "write"));
        };
        if !self.state.control.is_object() {
            return Err(self.deny_resource_access(resource_id, "write to non-object carrier"));
        }
        let control = self
            .state
            .control
            .as_object_mut()
            .expect("control object checked before mutation");
        if resource_id == "v4.control.scope_command" {
            ScopeSessionCommand::parse(&value)?;
        }
        control.insert(key.to_string(), value);
        Ok(())
    }

    fn deny_resource_access(&mut self, resource_id: &str, operation: &'static str) -> BridgeError {
        let error = BridgeError::ResourceAccessViolation {
            plugin_id: self.plugin_id.to_string(),
            resource_id: resource_id.to_string(),
            operation,
        };
        if self.resource_violation.is_none() {
            self.resource_violation = Some(error.clone());
        }
        error
    }

    fn take_resource_violation(&mut self) -> Option<BridgeError> {
        self.resource_violation.take()
    }
}

fn control_resource_key(resource_id: &str) -> Option<&'static str> {
    match resource_id {
        "v4.control.metadata_center" => Some("metadata_center"),
        "v4.lifecycle.payload_cycle" => Some("payload_cycle"),
        "v4.control.error_chain" => Some("error_chain"),
        "v4.control.route_facts" => Some("route_facts"),
        "v4.control.target_selection" => Some("target_selection"),
        "v4.control.scope_command" => Some("scope_command"),
        _ => None,
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
            reads: &entry.reads,
            writes: &entry.writes,
            resource_violation: None,
        };
        let result = handle.execute(&mut ctx, &Value::Null);
        if let Some(error) = ctx.take_resource_violation() {
            return Err(error);
        }
        result.map_err(|message| BridgeError::HandleError {
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
    let sink: std::sync::Mutex<Vec<(usize, Result<Vec<DiagnosticFact>, BridgeError>)>> =
        std::sync::Mutex::new(Vec::new());
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
                            reads: &entry.reads,
                            writes: &entry.writes,
                            resource_violation: None,
                        };
                        let result = handle.execute(&mut ctx, &Value::Null);
                        if let Some(error) = ctx.take_resource_violation() {
                            Err(error)
                        } else {
                            match result {
                                Ok(()) => Ok(ctx.state.diagnostics.clone()),
                                Err(message) => Err(BridgeError::HandleError {
                                    plugin_id: plugin_id.clone(),
                                    message,
                                }),
                            }
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
    Ping {
        request_id: String,
    },
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
pub fn dispatch(request: &BridgeRequest, registry: Option<&dyn HandleRegistry>) -> BridgeResponse {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scope_session_command_requires_complete_typed_shape() {
        let value = ScopeSessionCommand::parse(&json!({
            "entry_protocol": "responses",
            "continuation_owner": "direct",
            "pipeline_id": "pipeline-1",
            "port": 5555,
            "session_scope": "session-1",
            "conversation_scope": "conversation-1",
            "request_id": "request-1",
            "full_input_hash": "sha256:full-input",
            "operation": "bind",
            "sequence": 1
        }))
        .expect("complete scope command parses");
        assert_eq!(value.continuation_owner, ScopeContinuationOwner::Direct);
        assert_eq!(value.operation, ScopeSessionOperation::Bind);

        assert!(matches!(
            ScopeSessionCommand::parse(&json!({
                "entry_protocol": "responses",
                "continuation_owner": "direct"
            })),
            Err(BridgeError::Protocol(_))
        ));

        assert!(matches!(
            ScopeSessionCommand::parse(&json!({
                "entry_protocol": "responses",
                "continuation_owner": "direct",
                "pipeline_id": "pipeline-1",
                "port": 5555,
                "session_scope": "session-1",
                "conversation_scope": "conversation-1",
                "request_id": "request-1",
                "full_input_hash": "sha256:full-input",
                "operation": "replace",
                "sequence": 1
            })),
            Err(BridgeError::Protocol(_))
        ));

        assert!(matches!(
            ScopeSessionCommand::parse(&json!({
                "entry_protocol": "anthropic",
                "continuation_owner": "direct",
                "pipeline_id": "pipeline-1",
                "port": 5555,
                "session_scope": "session-1",
                "conversation_scope": "conversation-1",
                "request_id": "request-1",
                "full_input_hash": "sha256:full-input",
                "operation": "bind",
                "sequence": 1
            })),
            Err(BridgeError::Protocol(_))
        ));

        let relay = ScopeSessionCommand::parse(&json!({
            "entry_protocol": "chat",
            "continuation_owner": "relay",
            "pipeline_id": "pipeline-1",
            "port": 5555,
            "session_scope": "session-1",
            "conversation_scope": "conversation-1",
            "request_id": "request-1",
            "full_input_hash": "sha256:full-input",
            "operation": "bind",
            "sequence": 1
        }))
        .expect("chat relay scope command parses");
        assert_eq!(relay.entry_protocol, ScopeEntryProtocol::Chat);
        assert_eq!(relay.continuation_owner, ScopeContinuationOwner::Relay);
    }

    #[test]
    fn mount_candidate_requires_three_way_identity_match() {
        let mut plan = NodePluginPlan {
            node_id: "V4HubReqChatProcess04Governed".to_string(),
            position: 4,
            role_id: "request_chat_process".to_string(),
            chain: "request".to_string(),
            entries: vec![],
            selection_groups: vec![],
            hash: String::new(),
        };
        plan.hash = plan.plan_hash();
        let candidate = mount_candidate(
            &plan.node_id,
            plan.clone(),
            &plan.hash,
            &plan.hash,
            &plan.hash,
        )
        .expect("matching mount identity must compile");
        assert!(candidate.verify());
    }

    #[test]
    fn mount_candidate_rejects_graph_or_plan_drift() {
        let mut plan = NodePluginPlan {
            node_id: "V4HubReqChatProcess04Governed".to_string(),
            position: 4,
            role_id: "request_chat_process".to_string(),
            chain: "request".to_string(),
            entries: vec![],
            selection_groups: vec![],
            hash: String::new(),
        };
        plan.hash = plan.plan_hash();
        assert!(matches!(
            mount_candidate(&plan.node_id, plan.clone(), "graph-drift", &plan.hash, &plan.hash),
            Err(BridgeError::PlanHashMismatch)
        ));
        let mut drifted = plan.clone();
        drifted.node_id = "V4HubRespChatProcess03Governed".to_string();
        assert!(!drifted.verify());
    }
}
