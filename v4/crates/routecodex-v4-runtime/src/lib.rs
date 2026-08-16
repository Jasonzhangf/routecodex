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
use std::collections::HashMap;
use std::collections::HashSet;
use std::fmt;

mod control_resources;

pub use control_resources::*;
// Single source of truth: `PluginKind` is owned by routecodex-v4-plugin-contract
// (v4/contracts/node-plugin.contract.json kinds). The runtime never defines a
// second plugin-kind taxonomy; it only re-exports the contract type.
pub use routecodex_v4_plugin_contract::PluginKind;

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

/// Typed continuation facts. Selection may only use these facts; provider id,
/// model prefix and payload-shape guessing are forbidden by contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContinuationFacts {
    pub entry_protocol: String,
    pub provider_wire_protocol: String,
    pub continuation_owner: String,
    pub execution_mode: String,
}

impl ContinuationFacts {
    pub fn new(
        entry_protocol: &str,
        provider_wire_protocol: &str,
        continuation_owner: &str,
        execution_mode: &str,
    ) -> Self {
        Self {
            entry_protocol: entry_protocol.to_string(),
            provider_wire_protocol: provider_wire_protocol.to_string(),
            continuation_owner: continuation_owner.to_string(),
            execution_mode: execution_mode.to_string(),
        }
    }
}

/// Relay / Direct operator decision derived only from typed facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayOperator {
    Relay,
    Direct,
}

/// Select the relay/direct operator from typed facts only. Same-protocol
/// responses + direct owner selects Direct; non-responses entry + relay owner
/// selects Relay. Any contradictory pair (responses + relay, chat + direct)
/// fails fast: there is no fallback and no provider-specific selection.
pub fn select_relay_operator(facts: &ContinuationFacts) -> Result<RelayOperator, RuntimeFault> {
    if facts.entry_protocol == "responses" && facts.continuation_owner == "direct" {
        Ok(RelayOperator::Direct)
    } else if facts.entry_protocol != "responses" && facts.continuation_owner == "relay" {
        Ok(RelayOperator::Relay)
    } else {
        Err(RuntimeFault::new(
            "relay_operator_select",
            format!(
                "no typed-facts match (entry={} owner={}); provider-specific selection is forbidden",
                facts.entry_protocol, facts.continuation_owner
            ),
        ))
    }
}

/// Three-key continuation restore key: entry protocol + continuation owner +
/// session/conversation (+ port/group). Session-only restore is impossible by
/// construction because the key always carries all three dimensions.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ContinuationKey {
    pub entry_protocol: String,
    pub continuation_owner: String,
    pub port: u16,
    pub session_scope: String,
    pub conversation_scope: String,
}

impl ContinuationKey {
    pub fn new(
        entry_protocol: &str,
        continuation_owner: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
    ) -> Self {
        Self {
            entry_protocol: entry_protocol.to_string(),
            continuation_owner: continuation_owner.to_string(),
            port,
            session_scope: session_scope.to_string(),
            conversation_scope: conversation_scope.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeError {
    AlreadyBound,
    NotBound,
    OwnerMismatch,
    EntryProtocolMismatch,
    PortMismatch,
    SessionMismatch,
    ConversationMismatch,
    CrossRequestReuse,
    FullInputMissing,
    ImmutableIntervalViolation,
    RestoreAfterRelease,
}

impl fmt::Display for ScopeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::AlreadyBound => "continuation key already bound",
            Self::NotBound => "continuation key not bound",
            Self::OwnerMismatch => "continuation owner mismatch (direct/relay cross-continuation)",
            Self::EntryProtocolMismatch => "entry protocol mismatch (chat/messages hit responses continuation)",
            Self::PortMismatch => "port/group mismatch",
            Self::SessionMismatch => "session scope mismatch",
            Self::ConversationMismatch => "conversation scope mismatch",
            Self::CrossRequestReuse => "cross-request reuse of continuation binding",
            Self::FullInputMissing => "full input missing for continuation restore",
            Self::ImmutableIntervalViolation => "continuation restored more than once (immutable interval)",
            Self::RestoreAfterRelease => "continuation restored after release",
        };
        write!(formatter, "{message}")
    }
}

/// One bound continuation scope with immutable three-key isolation. The
/// binding is created only at response chat process commit and consumed only
/// at the next request chat process restore.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeBinding {
    pub key: ContinuationKey,
    pub request_id: String,
    pub full_input_hash: Option<String>,
    pub restored: bool,
    pub released: bool,
}

/// Immutable audit record for scope bind/restore/release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeRecord {
    pub record_id: String,
    pub key: ContinuationKey,
    pub operation: String,
    pub request_id: String,
    pub sequence: u64,
}

/// Scope session registry: bind (save at resp chat process), restore (three-key
/// at next req chat process), release. Cross-request reuse, owner mismatch,
/// entry-protocol mismatch and session-only restore fail fast.
#[derive(Debug, Default)]
pub struct ScopeRegistry {
    bindings: HashMap<ContinuationKey, ScopeBinding>,
    records: Vec<ScopeRecord>,
    next_sequence: u64,
}

impl ScopeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn bind(
        &mut self,
        key: ContinuationKey,
        request_id: &str,
        full_input_hash: Option<&str>,
    ) -> Result<ScopeRecord, ScopeError> {
        if self.bindings.contains_key(&key) {
            return Err(ScopeError::AlreadyBound);
        }
        let full_input_hash = match full_input_hash {
            Some(hash) => Some(hash.to_string()),
            None => return Err(ScopeError::FullInputMissing),
        };
        self.bindings.insert(
            key.clone(),
            ScopeBinding {
                key: key.clone(),
                request_id: request_id.to_string(),
                full_input_hash,
                restored: false,
                released: false,
            },
        );
        Ok(self.append_record(key, "bind", request_id))
    }

    /// Three-key restore. The key must match entry protocol + owner + session/
    /// conversation(+port/group) exactly; a binding found on the same
    /// session trio with a different owner or entry protocol returns the
    /// explicit isolation error. Full input is mandatory.
    pub fn restore(
        &mut self,
        key: &ContinuationKey,
        request_id: &str,
        full_input_hash: Option<&str>,
    ) -> Result<&ScopeBinding, ScopeError> {
        if let Some(binding) = self.bindings.get(key) {
            if binding.released {
                return Err(ScopeError::RestoreAfterRelease);
            }
            if binding.restored {
                return Err(ScopeError::ImmutableIntervalViolation);
            }
            if full_input_hash.is_none() {
                return Err(ScopeError::FullInputMissing);
            }
            self.bindings
                .get_mut(key)
                .expect("binding exists")
                .restored = true;
            self.append_record(key.clone(), "restore", request_id);
            return Ok(self.bindings.get(key).expect("binding exists"));
        }
        // Explicit isolation diagnostics: same session trio, different
        // entry/owner dimensions.
        for (bound_key, binding) in &self.bindings {
            if bound_key.port == key.port
                && bound_key.session_scope == key.session_scope
                && bound_key.conversation_scope == key.conversation_scope
            {
                if bound_key.continuation_owner != key.continuation_owner {
                    return Err(ScopeError::OwnerMismatch);
                }
                if bound_key.entry_protocol != key.entry_protocol {
                    return Err(ScopeError::EntryProtocolMismatch);
                }
                let _ = binding;
            }
        }
        Err(ScopeError::NotBound)
    }

    pub fn release(
        &mut self,
        key: &ContinuationKey,
        request_id: &str,
    ) -> Result<ScopeRecord, ScopeError> {
        {
            let binding = self
                .bindings
                .get_mut(key)
                .ok_or(ScopeError::NotBound)?;
            if binding.released {
                return Err(ScopeError::RestoreAfterRelease);
            }
            binding.released = true;
        }
        Ok(self.append_record(key.clone(), "release", request_id))
    }

    pub fn is_bound(&self, key: &ContinuationKey) -> bool {
        self.bindings.contains_key(key)
    }

    /// Whether any binding exists on the same port/session/conversation trio.
    /// Used to distinguish a fresh turn (no binding at all) from a three-key
    /// isolation violation (binding exists but entry/owner mismatch).
    pub fn session_trio_bound(&self, port: u16, session_scope: &str, conversation_scope: &str) -> bool {
        self.bindings.keys().any(|key| {
            key.port == port
                && key.session_scope == session_scope
                && key.conversation_scope == conversation_scope
        })
    }

    pub fn records(&self) -> impl Iterator<Item = &ScopeRecord> {
        self.records.iter()
    }

    fn append_record(
        &mut self,
        key: ContinuationKey,
        operation: &str,
        request_id: &str,
    ) -> ScopeRecord {
        self.next_sequence += 1;
        let record = ScopeRecord {
            record_id: format!("scope-{}", self.next_sequence),
            key,
            operation: operation.to_string(),
            request_id: request_id.to_string(),
            sequence: self.next_sequence,
        };
        self.records.push(record.clone());
        record
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadCycleState {
    Open,
    SuccessTerminal,
    ErrorTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadCycleError {
    OpenTwice,
    CloseWithoutOpen,
    AlreadyTerminal,
    MergeAfterTerminal,
}

impl fmt::Display for PayloadCycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::OpenTwice => "payload cycle opened twice for one request",
            Self::CloseWithoutOpen => "payload cycle closed without open",
            Self::AlreadyTerminal => "payload cycle already terminal",
            Self::MergeAfterTerminal => "retry merge after terminal payload cycle",
        };
        write!(formatter, "{message}")
    }
}

/// Original request payload lifecycle registry. switch/cooldown/reroute merge
/// into the same cycle; the cycle terminates only on client-entry success or
/// error terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadCycle {
    pub request_id: String,
    pub original_request_hash: String,
    pub state: PayloadCycleState,
    pub attempts: u64,
}

#[derive(Debug, Default)]
pub struct PayloadCycleRegistry {
    cycles: HashMap<String, PayloadCycle>,
}

impl PayloadCycleRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(
        &mut self,
        request_id: &str,
        original_request_hash: &str,
    ) -> Result<&PayloadCycle, PayloadCycleError> {
        if self.cycles.contains_key(request_id) {
            return Err(PayloadCycleError::OpenTwice);
        }
        self.cycles.insert(
            request_id.to_string(),
            PayloadCycle {
                request_id: request_id.to_string(),
                original_request_hash: original_request_hash.to_string(),
                state: PayloadCycleState::Open,
                attempts: 1,
            },
        );
        Ok(self.cycles.get(request_id).expect("cycle inserted"))
    }

    pub fn merge_retry(&mut self, request_id: &str) -> Result<&PayloadCycle, PayloadCycleError> {
        let cycle = self
            .cycles
            .get_mut(request_id)
            .ok_or(PayloadCycleError::CloseWithoutOpen)?;
        if cycle.state != PayloadCycleState::Open {
            return Err(PayloadCycleError::MergeAfterTerminal);
        }
        cycle.attempts += 1;
        Ok(cycle)
    }

    pub fn close_success(
        &mut self,
        request_id: &str,
    ) -> Result<&PayloadCycle, PayloadCycleError> {
        let cycle = self
            .cycles
            .get_mut(request_id)
            .ok_or(PayloadCycleError::CloseWithoutOpen)?;
        if cycle.state != PayloadCycleState::Open {
            return Err(PayloadCycleError::AlreadyTerminal);
        }
        cycle.state = PayloadCycleState::SuccessTerminal;
        Ok(cycle)
    }

    pub fn close_error(&mut self, request_id: &str) -> Result<&PayloadCycle, PayloadCycleError> {
        let cycle = self
            .cycles
            .get_mut(request_id)
            .ok_or(PayloadCycleError::CloseWithoutOpen)?;
        if cycle.state != PayloadCycleState::Open {
            return Err(PayloadCycleError::AlreadyTerminal);
        }
        cycle.state = PayloadCycleState::ErrorTerminal;
        Ok(cycle)
    }

    pub fn get(&self, request_id: &str) -> Option<&PayloadCycle> {
        self.cycles.get(request_id)
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
    pub continuation_owner: Option<String>,
    pub execution_mode: Option<String>,
    pub relay_operator_selected: bool,
    pub governance_applied: bool,
    pub execution_plan: Option<String>,
    pub route_facts: Option<String>,
    pub target_selection: Option<String>,
    pub route_exit: Option<String>,
    pub continuation_committed: bool,
    pub continuation_restored: bool,
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
    port: u16,
    session_scope: String,
    conversation_scope: String,
    pub data: DataView,
    pub control: ControlView,
    pub information: InformationView,
    pub diagnostic: DiagnosticView,
}

impl ExecutionContext {
    pub fn new(request_id: &str, binding: ExecutionBinding) -> Self {
        // Default request-bound scope; hosts with real session/conversation
        // dimensions use `with_scope` so continuation restore can bind the
        // three keys (entry protocol + owner + session/conversation(+port)).
        Self::with_scope(request_id, binding, 0, "", "")
    }

    /// Scoped constructor for real port/session/conversation dimensions. The
    /// scope stays closed-loop bound so control state never crosses requests.
    pub fn with_scope(
        request_id: &str,
        binding: ExecutionBinding,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
    ) -> Self {
        let scope = Scope::new(
            request_id,
            "v4-skeleton",
            port,
            session_scope,
            conversation_scope,
        );
        Self {
            request_id: request_id.to_string(),
            binding,
            scope: scope.clone(),
            port,
            session_scope: session_scope.to_string(),
            conversation_scope: conversation_scope.to_string(),
            data: DataView::default(),
            control: ControlView {
                continuation_scope: None,
                continuation_owner: None,
                execution_mode: None,
                relay_operator_selected: false,
                governance_applied: false,
                execution_plan: None,
                route_facts: None,
                target_selection: None,
                route_exit: None,
                continuation_committed: false,
                continuation_restored: false,
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

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn session_scope(&self) -> &str {
        &self.session_scope
    }

    pub fn conversation_scope(&self) -> &str {
        &self.conversation_scope
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
    "continuation_owner",
    "execution_mode",
    "relay_operator",
    "continuation_restored",
    "route_facts",
    "route_exit",
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
pub struct RuntimeRegistries<'a> {
    pub scope: &'a mut ScopeRegistry,
    pub payload_cycle: &'a mut PayloadCycleRegistry,
}

pub trait NodePlugin: Send + Sync {
    fn plugin_id(&self) -> &'static str;
    fn kind(&self) -> PluginKind;
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault>;
}

struct ProtocolParse;
impl NodePlugin for ProtocolParse {
    fn plugin_id(&self) -> &'static str {
        "protocol_parse"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
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
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
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
        PluginKind::Validator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
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
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        // Classification only: lock typed facts (entry protocol, provider wire
        // protocol, continuation owner, execution mode). Never restores
        // history or rebuilds context here (immutable interval contract).
        let protocol = ctx.information.protocol.as_deref().unwrap_or("unknown");
        let owner = match protocol {
            "responses" => "direct",
            "chat" | "messages" | "anthropic" | "gemini" => "relay",
            _ => "none",
        };
        let execution_mode = match owner {
            "relay" => "relay",
            "direct" => "direct",
            _ => "none",
        };
        ctx.control.continuation_owner = Some(owner.to_string());
        ctx.control.execution_mode = Some(execution_mode.to_string());
        let facts = ContinuationFacts::new(protocol, "hub", owner, execution_mode);
        if select_relay_operator(&facts)? == RelayOperator::Relay {
            ctx.control.relay_operator_selected = true;
        }
        ctx.control.continuation_scope = Some(format!(
            "scope:{protocol}:{owner}:port-{}:session-{}:conversation-{}",
            ctx.port(),
            ctx.session_scope(),
            ctx.conversation_scope()
        ));
        Ok(())
    }
}

struct ContinuationRestore;
impl NodePlugin for ContinuationRestore {
    fn plugin_id(&self) -> &'static str {
        "continuation_restore"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Control
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        // Restore is the request-side endpoint of the immutable interval:
        // resp_chatprocess save -> (no semantic transformation) ->
        // req_chatprocess restore. Three keys are required and full input is
        // mandatory; missing owner or missing binding is not a fallback.
        let owner = ctx.control.continuation_owner.as_deref().unwrap_or("none");
        let protocol = ctx.information.protocol.as_deref().unwrap_or("unknown");
        if owner == "none" {
            return Ok(());
        }
        let key = ContinuationKey::new(
            protocol,
            owner,
            ctx.port(),
            ctx.session_scope(),
            ctx.conversation_scope(),
        );
        let full_input = ctx
            .data
            .normalized_request
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("full_input_missing", "continuation restore requires full input"))?;
        if registries.scope.is_bound(&key) {
            registries
                .scope
                .restore(&key, ctx.request_id(), Some(&format!("sha256:{full_input}")))
                .map_err(|error| RuntimeFault::new("continuation_restore", error.to_string()))?;
            ctx.control.continuation_restored = true;
        } else if registries
            .scope
            .session_trio_bound(ctx.port(), ctx.session_scope(), ctx.conversation_scope())
        {
            // A continuation exists for this session trio but the requested
            // three keys do not match: fail fast with the exact isolation
            // error instead of silently starting a fresh turn.
            registries
                .scope
                .restore(&key, ctx.request_id(), Some(&format!("sha256:{full_input}")))
                .map_err(|error| RuntimeFault::new("continuation_restore", error.to_string()))?;
            ctx.control.continuation_restored = true;
        }
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
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
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
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        ctx.control.execution_plan = Some(format!("plan:{}", ctx.binding().plan_hash));
        // Router facts, target selection and route exit are typed, opaque
        // control facts; they are never projected into payload and never
        // mutated here.
        ctx.control.route_facts = Some(format!("facts:{}:classified", ctx.binding().plan_hash));
        ctx.control.target_selection = Some(format!("opaque:{}:selected", ctx.binding().plan_hash));
        // Route exit is bound to the typed-facts operator decision (relay or
        // direct); it is never a hardcoded value and never derived from
        // provider id / model / payload shape.
        ctx.control.route_exit = Some(if ctx.control.relay_operator_selected {
            "relay_policy_bound".to_string()
        } else {
            "direct_policy_bound".to_string()
        });
        Ok(())
    }
}

struct SemanticProjection;
impl NodePlugin for SemanticProjection {
    fn plugin_id(&self) -> &'static str {
        "semantic_projection"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
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
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
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
        PluginKind::Validator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
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
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
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
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
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
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
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
        PluginKind::Observer
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
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
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        // Continuation truth saved at chat process exit (unique save point);
        // the interval between this commit and the next request restore is
        // immutable. A response without a continuation owner (e.g. a plain
        // mock frame) commits the checkpoint with no binding: nothing to save.
        ctx.control.continuation_committed = true;
        let Some(owner) = ctx.control.continuation_owner.as_deref() else {
            return Ok(());
        };
        if owner == "none" {
            return Ok(());
        }
        let protocol = ctx.information.protocol.as_deref().unwrap_or("unknown");
        let key = ContinuationKey::new(
            protocol,
            owner,
            ctx.port(),
            ctx.session_scope(),
            ctx.conversation_scope(),
        );
        let payload_hash = ctx
            .data
            .parsed_response
            .as_deref()
            .map(|payload| format!("sha256:{payload}"))
            .ok_or_else(|| RuntimeFault::new("continuation_commit", "response payload missing"))?;
        registries
            .scope
            .bind(key, ctx.request_id(), Some(&payload_hash))
            .map_err(|error| RuntimeFault::new("continuation_commit", error.to_string()))?;
        Ok(())
    }
}

struct ClientSemanticProjection;
impl NodePlugin for ClientSemanticProjection {
    fn plugin_id(&self) -> &'static str {
        "client_semantic_projection"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
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
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
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
    &ContinuationRestore,
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
    pub continuation_owner: Option<String>,
    pub execution_mode: Option<String>,
    pub relay_operator_selected: bool,
    pub route_exit: Option<String>,
    pub continuation_committed: bool,
    pub continuation_restored: bool,
    pub trace: Vec<String>,
}

/// Skeleton runtime: loads the hash-locked immutable plan, compiles the plugin
/// plan, and executes chains with per-request scope isolation.
pub struct SkeletonRuntime {
    plan: SkeletonPlan,
    containers: NodePluginPlan,
    active_requests: RefCell<HashSet<String>>,
    scopes: RefCell<ScopeRegistry>,
    payload_cycles: RefCell<PayloadCycleRegistry>,
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
            scopes: RefCell::new(ScopeRegistry::new()),
            payload_cycles: RefCell::new(PayloadCycleRegistry::new()),
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

    /// Fixed request slice: server entry -> Hub governance -> provider boundary.
    pub fn execute_request(
        &self,
        raw_entry: &str,
        request_id: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.execute_request_scoped(raw_entry, request_id, 0, "", "")
    }

    /// Request slice with explicit port/session/conversation dimensions so the
    /// continuation restore key can carry the full three-key scope.
    pub fn execute_request_scoped(
        &self,
        raw_entry: &str,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.claim(request_id)?;
        let result = self.run_chain("request", request_id, port, session_scope, conversation_scope, |ctx| {
            ctx.data.raw_entry = Some(raw_entry.to_string());
            ctx.information.model = Some("mock-provider".to_string());
        });
        self.release(request_id);
        result
    }

    /// Fixed response slice with a mock provider frame:
    /// provider boundary -> Hub governance -> server projection.
    pub fn execute_mock_response(
        &self,
        provider_raw: &str,
        request_id: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.execute_mock_response_scoped(provider_raw, request_id, 0, "", "", "chat", "none")
    }

    /// Response slice with continuation facts so commit can bind the three-key
    /// save (entry protocol + owner + session/conversation(+port/group)).
    pub fn execute_mock_response_scoped(
        &self,
        provider_raw: &str,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
        entry_protocol: &str,
        continuation_owner: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.claim(request_id)?;
        let result = self.run_chain("response", request_id, port, session_scope, conversation_scope, |ctx| {
            ctx.data.provider_raw = Some(provider_raw.to_string());
            ctx.information.protocol = Some(entry_protocol.to_string());
            ctx.control.continuation_owner = Some(continuation_owner.to_string());
            ctx.control.execution_mode = Some(if continuation_owner == "relay" {
                "relay".to_string()
            } else {
                "direct".to_string()
            });
        });
        self.release(request_id);
        result
    }

    /// Open a payload cycle (request_sent) for a request id.
    pub fn open_payload_cycle(
        &self,
        request_id: &str,
        original_request_hash: &str,
    ) -> Result<(), RuntimeFault> {
        self.payload_cycles
            .borrow_mut()
            .open(request_id, original_request_hash)
            .map(|_| ())
            .map_err(|error| RuntimeFault::new("payload_cycle", error.to_string()))
    }

    /// Merge a retry into the same payload cycle.
    pub fn merge_payload_cycle(&self, request_id: &str) -> Result<(), RuntimeFault> {
        self.payload_cycles
            .borrow_mut()
            .merge_retry(request_id)
            .map(|_| ())
            .map_err(|error| RuntimeFault::new("payload_cycle", error.to_string()))
    }

    /// Close a payload cycle as success terminal.
    pub fn close_payload_cycle_success(&self, request_id: &str) -> Result<(), RuntimeFault> {
        self.payload_cycles
            .borrow_mut()
            .close_success(request_id)
            .map(|_| ())
            .map_err(|error| RuntimeFault::new("payload_cycle", error.to_string()))
    }

    /// Close a payload cycle as error terminal.
    pub fn close_payload_cycle_error(&self, request_id: &str) -> Result<(), RuntimeFault> {
        self.payload_cycles
            .borrow_mut()
            .close_error(request_id)
            .map(|_| ())
            .map_err(|error| RuntimeFault::new("payload_cycle", error.to_string()))
    }

    /// Generic chain execution. External-owned chains (error/config) must not
    /// be executed here; invoking them fails fast.
    pub fn execute_chain(
        &self,
        chain_id: &str,
        request_id: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.claim(request_id)?;
        let result = self.run_chain(chain_id, request_id, 0, "", "", |_| {});
        self.release(request_id);
        result
    }

    fn run_chain(
        &self,
        chain_id: &str,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
        seed: impl FnOnce(&mut ExecutionContext),
    ) -> Result<ExecutionReport, RuntimeFault> {
        let nodes = self.containers.chain(chain_id)?;
        let mut ctx = ExecutionContext::with_scope(
            request_id,
            execution_binding(&self.plan),
            port,
            session_scope,
            conversation_scope,
        );
        let mut scopes = self.scopes.borrow_mut();
        let mut payload_cycles = self.payload_cycles.borrow_mut();
        let mut registries = RuntimeRegistries {
            scope: &mut scopes,
            payload_cycle: &mut payload_cycles,
        };
        seed(&mut ctx);
        for node in nodes {
            let binding_before = ctx.binding().clone();
            for plugin in &node.plugins {
                match plugin {
                    PluginRef::Local(plugin) => plugin
                        .execute(&mut ctx, &mut registries)
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
            continuation_owner: ctx.control.continuation_owner.clone(),
            execution_mode: ctx.control.execution_mode.clone(),
            relay_operator_selected: ctx.control.relay_operator_selected,
            route_exit: ctx.control.route_exit.clone(),
            continuation_committed: ctx.control.continuation_committed,
            continuation_restored: ctx.control.continuation_restored,
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
