//! routecodex-v4-runtime — minimal skeleton runtime vertical slice (Phase 4).
//!
//! Owns:
//! - `NodeContainer` + `NodePluginPlan` compiled from the immutable
//!   `SkeletonPlan` (owned by routecodex-v4-skeleton);
//! - the typed carrier (`ExecutionContext` with data/control/information/
//!   diagnostic views; Phase 7: MetadataCenter is owned by `control_view`);
//! - a static plugin registry (no dynamic plugin discovery);
//! - request/response chain execution for the minimal slice.
//!
//! Hard boundaries:
//! - error chain and config chain plugins are owned by routecodex-v4-error /
//!   routecodex-v4-config; the runtime never executes them inline
//!   (`external_owner_violation` fail-fast);
//! - faults route into `routecodex_v4_error::ErrorChain` via
//!   `project_runtime_fault` (01 -> 02 -> 03 -> 04 -> 05 -> 06, terminal);
//! - no fallback, no silent strip, no payload reconstruction of control state;
//! - control fields never enter provider/client wire.

use routecodex_v4_base_node::Scope;
use routecodex_v4_control::MetadataCenter;
use routecodex_v4_error::{
    ClientProjection, DecisionAction, ErrorCenter, ErrorChain, ErrorChainError, ExecutionDecision,
    RetryPolicy,
};
use routecodex_v4_skeleton::SkeletonPlan;
use std::cell::RefCell;
use std::collections::HashSet;
use std::fmt;

/// Plugin effect kinds, mirroring `node-plugin.contract.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginKind {
    Admission,
    Control,
    Semantic,
    Validation,
    Projection,
    Observation,
    Debug,
    Operator,
}

/// Typed runtime fault. Never contains business payload content; carries only
/// stage/code/node identity (error-chain contract).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeFault {
    pub code: String,
    pub message: String,
    pub node_id: Option<String>,
}

impl RuntimeFault {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            node_id: None,
        }
    }

    pub fn with_node(mut self, node_id: &str) -> Self {
        self.node_id = Some(node_id.to_string());
        self
    }
}

impl fmt::Display for RuntimeFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.node_id {
            Some(node) => write!(formatter, "{} at {}: {}", self.code, node, self.message),
            None => write!(formatter, "{}: {}", self.code, self.message),
        }
    }
}

/// Execution binding (Gate 4): a request entering the skeleton stays bound to
/// skeleton_version + manifest_hash + plan_epoch + plan_hash for the whole run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionBinding {
    pub skeleton_version: String,
    pub manifest_hash: String,
    pub plan_epoch: u64,
    pub plan_hash: String,
}

pub fn execution_binding(plan: &SkeletonPlan) -> ExecutionBinding {
    ExecutionBinding {
        skeleton_version: plan.skeleton_version.clone(),
        manifest_hash: plan.manifest_hash.clone(),
        plan_epoch: plan.plan_epoch,
        plan_hash: plan.plan_hash.clone(),
    }
}

/// Data plane view: only business request/response semantics.
#[derive(Debug, Clone, Default)]
pub struct DataView {
    pub raw_entry: Option<String>,
    pub normalized_request: Option<String>,
    pub provider_semantic: Option<String>,
    pub provider_wire: Option<String>,
    pub provider_raw: Option<String>,
    pub parsed_response: Option<String>,
    pub client_semantic: Option<String>,
    pub client_frame: Option<String>,
}

/// Control plane view: typed side-channel only; never projected into payload.
/// Phase 7: `MetadataCenter` is the `control_view` owner, bound to the
/// request closed-loop scope.
#[derive(Debug, Clone)]
pub struct ControlView {
    pub continuation_scope: Option<String>,
    pub governance_applied: bool,
    pub execution_plan: Option<String>,
    pub route_facts: Option<String>,
    pub target_selection: Option<String>,
    pub continuation_committed: bool,
    pub metadata: MetadataCenter,
}

/// Information plane view: protocol facts that may legitimately shape
/// projection (entry protocol, endpoint, model).
#[derive(Debug, Clone, Default)]
pub struct InformationView {
    pub protocol: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
}

/// Diagnostic view: execution trace, observability only, never live-path input.
#[derive(Debug, Clone, Default)]
pub struct DiagnosticView {
    pub trace: Vec<String>,
}

/// Typed carrier per request closed loop. Never global, never shared across
/// request ids.
pub struct ExecutionContext {
    request_id: String,
    binding: ExecutionBinding,
    scope: Scope,
    pub data: DataView,
    pub control: ControlView,
    pub information: InformationView,
    pub diagnostic: DiagnosticView,
}

impl ExecutionContext {
    pub fn new(request_id: &str, binding: ExecutionBinding) -> Self {
        // Minimal slice: request_id is the isolation key; pipeline/port/session
        // dimensions are wired by the runtime host in later phases. The scope
        // stays request-bound so control state never crosses closed loops.
        let scope = Scope::new(request_id, "v4-skeleton", 0, "", "");
        Self {
            request_id: request_id.to_string(),
            binding,
            scope: scope.clone(),
            data: DataView::default(),
            control: ControlView {
                continuation_scope: None,
                governance_applied: false,
                execution_plan: None,
                route_facts: None,
                target_selection: None,
                continuation_committed: false,
                metadata: MetadataCenter::new(scope),
            },
            information: InformationView::default(),
            diagnostic: DiagnosticView::default(),
        }
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn binding(&self) -> &ExecutionBinding {
        &self.binding
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    pub fn binding_mut(&mut self) -> &mut ExecutionBinding {
        &mut self.binding
    }

    pub fn record_trace(&mut self, entry: impl Into<String>) {
        self.diagnostic.trace.push(entry.into());
    }
}

/// Reserved control markers that must never appear in provider/client wire.
const RESERVED_CONTROL_MARKERS: &[&str] = &[
    "continuation_scope",
    "route_facts",
    "plan_hash",
    "governance_applied",
];

/// Plane isolation check: provider wire / client frame must never carry
/// control-state fields.
pub fn assert_no_control_leak(ctx: &ExecutionContext) -> Result<(), RuntimeFault> {
    for marker in RESERVED_CONTROL_MARKERS {
        if let Some(wire) = &ctx.data.provider_wire {
            if wire.contains(marker) {
                return Err(RuntimeFault::new(
                    "control_leak",
                    format!("provider wire carries control marker {marker}"),
                ));
            }
        }
        if let Some(frame) = &ctx.data.client_frame {
            if frame.contains(marker) {
                return Err(RuntimeFault::new(
                    "control_leak",
                    format!("client frame carries control marker {marker}"),
                ));
            }
        }
    }
    Ok(())
}

/// Static plugin capability boundary. Plugins are node-local: they only touch
/// their declared view through `ExecutionContext`; no next_node effect exists.
pub trait NodePlugin: Send + Sync {
    fn plugin_id(&self) -> &'static str;
    fn kind(&self) -> PluginKind;
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault>;
}

struct ProtocolParse;
impl NodePlugin for ProtocolParse {
    fn plugin_id(&self) -> &'static str {
        "protocol_parse"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Semantic
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        let raw = ctx
            .data
            .raw_entry
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("protocol_parse", "raw entry missing"))?;
        let protocol = if raw.starts_with("chat:") {
            "chat"
        } else if raw.starts_with("responses:") {
            "responses"
        } else {
            "unknown"
        };
        ctx.information.protocol = Some(protocol.to_string());
        Ok(())
    }
}

struct Normalize;
impl NodePlugin for Normalize {
    fn plugin_id(&self) -> &'static str {
        "normalize"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Semantic
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        let protocol = ctx
            .information
            .protocol
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("normalize", "protocol not parsed"))?;
        ctx.data.normalized_request = Some(format!("normalized:{protocol}:{}", ctx.request_id()));
        Ok(())
    }
}

struct InputValidate;
impl NodePlugin for InputValidate {
    fn plugin_id(&self) -> &'static str {
        "input_validate"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Validation
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        let raw = ctx
            .data
            .raw_entry
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("input_validate", "raw entry missing"))?;
        if !(raw.starts_with("chat:") || raw.starts_with("responses:")) {
            return Err(RuntimeFault::new(
                "input_validate",
                format!("invalid entry protocol {raw:?}"),
            ));
        }
        if ctx.data.normalized_request.is_none() {
            return Err(RuntimeFault::new(
                "input_validate",
                "normalized request missing",
            ));
        }
        Ok(())
    }
}

struct ContinuationClassify;
impl NodePlugin for ContinuationClassify {
    fn plugin_id(&self) -> &'static str {
        "continuation_classify"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Control
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        // Classification only: lock entry protocol + continuation owner +
        // session scope. Never restores history or rebuilds context here
        // (immutable interval contract).
        let protocol = ctx.information.protocol.as_deref().unwrap_or("unknown");
        let owner = if protocol == "responses" {
            "direct"
        } else {
            "none"
        };
        ctx.control.continuation_scope = Some(format!(
            "scope:{protocol}:{owner}:session-{}",
            ctx.request_id()
        ));
        Ok(())
    }
}

struct Governance;
impl NodePlugin for Governance {
    fn plugin_id(&self) -> &'static str {
        "governance"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Control
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        ctx.control.governance_applied = true;
        Ok(())
    }
}

struct ExecutionPlan;
impl NodePlugin for ExecutionPlan {
    fn plugin_id(&self) -> &'static str {
        "execution_plan"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Control
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        ctx.control.execution_plan = Some(format!("plan:{}", ctx.binding().plan_hash));
        // Router facts and target selection are typed, opaque control facts;
        // they are never projected into payload and never mutated here.
        ctx.control.route_facts = Some(format!("facts:{}:classified", ctx.binding().plan_hash));
        ctx.control.target_selection = Some(format!("opaque:{}:selected", ctx.binding().plan_hash));
        Ok(())
    }
}

struct SemanticProjection;
impl NodePlugin for SemanticProjection {
    fn plugin_id(&self) -> &'static str {
        "semantic_projection"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Projection
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        let normalized = ctx.data.normalized_request.as_deref().ok_or_else(|| {
            RuntimeFault::new("semantic_projection", "normalized request missing")
        })?;
        let model = ctx.information.model.as_deref().unwrap_or("mock");
        ctx.data.provider_semantic = Some(format!("semantic:{model}:{normalized}"));
        Ok(())
    }
}

struct WireBuild;
impl NodePlugin for WireBuild {
    fn plugin_id(&self) -> &'static str {
        "wire_build"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Semantic
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        let semantic = ctx
            .data
            .provider_semantic
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("wire_build", "provider semantic missing"))?;
        ctx.data.provider_wire = Some(format!("wire:{semantic}"));
        assert_no_control_leak(ctx)
    }
}

struct OutputValidate;
impl NodePlugin for OutputValidate {
    fn plugin_id(&self) -> &'static str {
        "output_validate"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Validation
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        if ctx.data.provider_wire.is_none() {
            return Err(RuntimeFault::new(
                "output_validate",
                "provider wire missing",
            ));
        }
        assert_no_control_leak(ctx)
    }
}

struct RawParse;
impl NodePlugin for RawParse {
    fn plugin_id(&self) -> &'static str {
        "raw_parse"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Semantic
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        let raw = ctx
            .data
            .provider_raw
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("raw_parse", "provider raw missing"))?;
        if !raw.trim_start().starts_with('{') {
            return Err(RuntimeFault::new(
                "raw_parse",
                "malformed provider frame (must be a JSON object)",
            ));
        }
        Ok(())
    }
}

struct ProtocolDecode;
impl NodePlugin for ProtocolDecode {
    fn plugin_id(&self) -> &'static str {
        "protocol_decode"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Semantic
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        let raw = ctx
            .data
            .provider_raw
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("protocol_decode", "provider raw missing"))?;
        ctx.data.parsed_response = Some(format!("parsed:{raw}"));
        Ok(())
    }
}

struct ResponseGovernance;
impl NodePlugin for ResponseGovernance {
    fn plugin_id(&self) -> &'static str {
        "response_governance"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Control
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        ctx.control.governance_applied = true;
        Ok(())
    }
}

struct ToolHarvest;
impl NodePlugin for ToolHarvest {
    fn plugin_id(&self) -> &'static str {
        "tool_harvest"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Semantic
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        // Harvest is semantic: extracted tool facts are observed and carried;
        // they are never stripped and never silently dropped.
        let parsed = ctx
            .data
            .parsed_response
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("tool_harvest", "parsed response missing"))?;
        let tools = parsed.matches("\"tool_calls\"").count();
        if tools > 0 {
            ctx.diagnostic
                .trace
                .push(format!("harvested_tools:{tools}"));
        }
        Ok(())
    }
}

struct ContinuationCommit;
impl NodePlugin for ContinuationCommit {
    fn plugin_id(&self) -> &'static str {
        "continuation_commit"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Control
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        // Continuation truth saved at chat process exit; the interval between
        // this commit and the next request restore is immutable.
        ctx.control.continuation_committed = true;
        Ok(())
    }
}

struct ClientSemanticProjection;
impl NodePlugin for ClientSemanticProjection {
    fn plugin_id(&self) -> &'static str {
        "client_semantic_projection"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Projection
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        let parsed = ctx.data.parsed_response.as_deref().ok_or_else(|| {
            RuntimeFault::new("client_semantic_projection", "parsed response missing")
        })?;
        ctx.data.client_semantic = Some(format!("client:{parsed}"));
        Ok(())
    }
}

struct FrameBuild;
impl NodePlugin for FrameBuild {
    fn plugin_id(&self) -> &'static str {
        "frame_build"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Projection
    }
    fn execute(&self, ctx: &mut ExecutionContext) -> Result<(), RuntimeFault> {
        let semantic = ctx
            .data
            .client_semantic
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("frame_build", "client semantic missing"))?;
        ctx.data.client_frame = Some(format!("frame:{semantic}"));
        assert_no_control_leak(ctx)
    }
}

/// Static plugin registry: every request/response plugin is declared here.
/// Dynamic plugin discovery is forbidden.
pub static PLUGIN_REGISTRY: &[&dyn NodePlugin] = &[
    &ProtocolParse,
    &Normalize,
    &InputValidate,
    &ContinuationClassify,
    &Governance,
    &ExecutionPlan,
    &SemanticProjection,
    &WireBuild,
    &OutputValidate,
    &RawParse,
    &ProtocolDecode,
    &ResponseGovernance,
    &ToolHarvest,
    &ContinuationCommit,
    &ClientSemanticProjection,
    &FrameBuild,
];

/// Chain plugins owned by other crates. The runtime never executes them; a
/// plan containing them is compiled into `PluginRef::External` and executing
/// such a node fails fast (`external_owner_violation`).
pub const EXTERNAL_CHAIN_PLUGINS: &[(&str, &str)] = &[
    ("error_source_capture", "routecodex-v4-error"),
    ("error_classify", "routecodex-v4-error"),
    ("error_policy_apply", "routecodex-v4-error"),
    ("execution_decision", "routecodex-v4-error"),
    ("client_projection", "routecodex-v4-error"),
    ("config_parse", "routecodex-v4-config"),
    ("config_validate", "routecodex-v4-config"),
    ("registry_build", "routecodex-v4-config"),
    ("manifest_publish", "routecodex-v4-config"),
];

fn resolve_local_plugin(plugin_id: &str) -> Option<&'static dyn NodePlugin> {
    PLUGIN_REGISTRY
        .iter()
        .copied()
        .find(|plugin| plugin.plugin_id() == plugin_id)
}

fn resolve_plugin(plugin_id: &str) -> Result<PluginRef, RuntimeFault> {
    if let Some((id, owner)) = EXTERNAL_CHAIN_PLUGINS
        .iter()
        .copied()
        .find(|(candidate, _)| *candidate == plugin_id)
    {
        return Ok(PluginRef::External {
            plugin_id: id,
            owner,
        });
    }
    resolve_local_plugin(plugin_id)
        .map(PluginRef::Local)
        .ok_or_else(|| {
            RuntimeFault::new(
                "unknown_plugin",
                format!("plugin {plugin_id} is not in the static registry"),
            )
        })
}

/// Resolved plugin slot: either a local static plugin or an externally owned
/// chain plugin (error/config owner).
#[derive(Clone, Copy)]
pub enum PluginRef {
    Local(&'static dyn NodePlugin),
    External {
        plugin_id: &'static str,
        owner: &'static str,
    },
}

impl fmt::Debug for PluginRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Local(plugin) => write!(formatter, "Local({})", plugin.plugin_id()),
            Self::External { plugin_id, owner } => {
                write!(formatter, "External({plugin_id}@{owner})")
            }
        }
    }
}

/// One compiled skeleton node with its resolved plugin slots.
#[derive(Debug)]
pub struct NodeContainer {
    pub node_id: String,
    pub chain: String,
    pub position: u32,
    pub role_id: String,
    pub terminal: bool,
    pub kernel: bool,
    pub plugins: Vec<PluginRef>,
}

/// Immutable compiled plugin plan: the runtime-consumable form of the skeleton.
#[derive(Debug)]
pub struct NodePluginPlan {
    chains: Vec<(String, Vec<NodeContainer>)>,
}

impl NodePluginPlan {
    /// Compile the skeleton plan into per-chain node containers. Fails fast on
    /// unknown plugins and non-consecutive positions (topology is already
    /// hash-locked by `SkeletonPlan::from_contract_json`; this is the second
    /// gate at the runtime boundary).
    pub fn build(plan: &SkeletonPlan) -> Result<Self, RuntimeFault> {
        let mut chains = Vec::with_capacity(plan.chains.len());
        for chain in &plan.chains {
            let nodes: Vec<NodeContainer> = chain
                .nodes
                .iter()
                .map(|slot| -> Result<NodeContainer, RuntimeFault> {
                    Ok(NodeContainer {
                        node_id: slot.node_id.clone(),
                        chain: slot.chain.clone(),
                        position: slot.position,
                        role_id: slot.role_id.clone(),
                        terminal: slot.terminal,
                        kernel: slot.kernel,
                        plugins: slot
                            .plugins
                            .iter()
                            .map(|binding| resolve_plugin(&binding.plugin_id))
                            .collect::<Result<Vec<_>, _>>()?,
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut positions: Vec<u32> = nodes.iter().map(|node| node.position).collect();
            positions.sort_unstable();
            for window in positions.windows(2) {
                if window[1] != window[0] + 1 {
                    return Err(RuntimeFault::new(
                        "non_adjacent_chain",
                        format!("chain {} positions are not consecutive", chain.chain_id),
                    ));
                }
            }
            chains.push((chain.chain_id.clone(), nodes));
        }
        Ok(Self { chains })
    }

    pub fn chain(&self, chain_id: &str) -> Result<&[NodeContainer], RuntimeFault> {
        self.chains
            .iter()
            .find(|(id, _)| id == chain_id)
            .map(|(_, nodes)| nodes.as_slice())
            .ok_or_else(|| RuntimeFault::new("unknown_chain", format!("chain {chain_id} missing")))
    }
}

/// Result of one chain execution: bound identity + produced wire + control
/// facts + diagnostic trace.
#[derive(Debug, Clone)]
pub struct ExecutionReport {
    pub request_id: String,
    pub binding: ExecutionBinding,
    pub provider_wire: Option<String>,
    pub client_frame: Option<String>,
    pub continuation_scope: Option<String>,
    pub continuation_committed: bool,
    pub trace: Vec<String>,
}

/// Skeleton runtime: loads the hash-locked immutable plan, compiles the plugin
/// plan, and executes chains with per-request scope isolation.
pub struct SkeletonRuntime {
    plan: SkeletonPlan,
    containers: NodePluginPlan,
    active_requests: RefCell<HashSet<String>>,
}

impl SkeletonRuntime {
    pub fn load(contract_json: &str) -> Result<Self, RuntimeFault> {
        let plan = SkeletonPlan::from_contract_json(contract_json)
            .map_err(|error| RuntimeFault::new("plan_invalid", error.to_string()))?;
        let containers = NodePluginPlan::build(&plan)?;
        Ok(Self {
            plan,
            containers,
            active_requests: RefCell::new(HashSet::new()),
        })
    }

    pub fn plan(&self) -> &SkeletonPlan {
        &self.plan
    }

    /// Scope claim: a request id may only have one active closed loop.
    /// Cross-request reuse fails fast (Phase 7 scope isolation).
    pub fn claim(&self, request_id: &str) -> Result<(), RuntimeFault> {
        let mut active = self.active_requests.borrow_mut();
        if !active.insert(request_id.to_string()) {
            return Err(RuntimeFault::new(
                "cross_request_reuse",
                format!("request_id {request_id} already active in this runtime"),
            ));
        }
        Ok(())
    }

    pub fn release(&self, request_id: &str) {
        self.active_requests.borrow_mut().remove(request_id);
    }

    /// Minimal request slice: ReqInbound -> ReqProcess -> ReqOutbound.
    pub fn execute_request(
        &self,
        raw_entry: &str,
        request_id: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.claim(request_id)?;
        let result = self.run_chain("request", request_id, |ctx| {
            ctx.data.raw_entry = Some(raw_entry.to_string());
            ctx.information.model = Some("mock-provider".to_string());
        });
        self.release(request_id);
        result
    }

    /// Minimal response slice with a mock provider frame:
    /// MockProviderResponse -> RespProcess -> ClientProjection.
    pub fn execute_mock_response(
        &self,
        provider_raw: &str,
        request_id: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.claim(request_id)?;
        let result = self.run_chain("response", request_id, |ctx| {
            ctx.data.provider_raw = Some(provider_raw.to_string());
        });
        self.release(request_id);
        result
    }

    /// Generic chain execution. External-owned chains (error/config) must not
    /// be executed here; invoking them fails fast.
    pub fn execute_chain(
        &self,
        chain_id: &str,
        request_id: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.claim(request_id)?;
        let result = self.run_chain(chain_id, request_id, |_| {});
        self.release(request_id);
        result
    }

    fn run_chain(
        &self,
        chain_id: &str,
        request_id: &str,
        seed: impl FnOnce(&mut ExecutionContext),
    ) -> Result<ExecutionReport, RuntimeFault> {
        let nodes = self.containers.chain(chain_id)?;
        let mut ctx = ExecutionContext::new(request_id, execution_binding(&self.plan));
        seed(&mut ctx);
        for node in nodes {
            let binding_before = ctx.binding().clone();
            for plugin in &node.plugins {
                match plugin {
                    PluginRef::Local(plugin) => plugin
                        .execute(&mut ctx)
                        .map_err(|fault| fault.with_node(&node.node_id))?,
                    PluginRef::External { plugin_id, owner } => {
                        return Err(RuntimeFault::new(
                            "external_owner_violation",
                            format!(
                                "plugin {plugin_id} owned by {owner} must not execute inside the skeleton runtime; route through its owner"
                            ),
                        )
                        .with_node(&node.node_id));
                    }
                }
            }
            if ctx.binding() != &binding_before {
                return Err(RuntimeFault::new(
                    "binding_drift",
                    format!("execution binding changed at {}", node.node_id),
                )
                .with_node(&node.node_id));
            }
            ctx.record_trace(node.node_id.clone());
        }
        Ok(ExecutionReport {
            request_id: request_id.to_string(),
            binding: ctx.binding().clone(),
            provider_wire: ctx.data.provider_wire.clone(),
            client_frame: ctx.data.client_frame.clone(),
            continuation_scope: ctx.control.continuation_scope.clone(),
            continuation_committed: ctx.control.continuation_committed,
            trace: ctx.diagnostic.trace.clone(),
        })
    }
}

/// Route a runtime fault through the single error chain owner
/// (`routecodex-v4-error`): raise -> capture -> classify (witness) -> policy ->
/// decision -> terminal client projection. No fallback, no silent strip.
pub fn project_runtime_fault(
    chain: &mut ErrorChain,
    fault: RuntimeFault,
) -> Result<ClientProjection, ErrorChainError> {
    let scope = chain.scope().clone();
    let mut center = ErrorCenter::new(scope);
    let node = fault.node_id.as_deref().unwrap_or("unknown");
    chain.raise(
        &fault.code,
        Some("sha256:execution-fault"),
        Some(&format!("node:{node}")),
    )?;
    let captured = chain.capture()?;
    let witness = center.classify(captured)?;
    chain.classify(witness)?;
    chain.apply_policy(RetryPolicy {
        policy_id: "policy.no-retry.terminal".to_string(),
        provider_scope: "all".to_string(),
        matcher: "runtime-fault".to_string(),
        action_class: "terminal".to_string(),
        reason_code: fault.code.clone(),
    })?;
    chain.decide(ExecutionDecision {
        decision_id: "decision.terminal".to_string(),
        action: DecisionAction::Terminal,
        reason_code: fault.code.clone(),
    })?;
    chain.project(&fault.message)
}
