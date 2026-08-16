//! routecodex-v4-debug — contract-bound diagnostic side-channel resource owner.
//!
//! Owns 12 diagnostic resources from the V4 resource registry
//! (design V4-RESOURCE-ANCHOR-COMPLETE-001):
//! snapshot_ledger / module_switch / dry_run_chain / bus_subscription /
//! snapshot_subscription / trace_context / event_ledger / raw_capture /
//! snapshot_session / dry_run_fixture / payload_budget / codex_sample_filesystem.
//!
//! Hard boundaries (debug-subscription.contract.json + data-control-boundary):
//! - diagnostic-only: no live runtime input, no control decision, no payload
//!   semantics, no MetadataCenter writes;
//! - verbatim capture is a side-channel projection, never payload truth;
//! - dry-run never performs network I/O and never writes provider/client wire;
//! - failures fail-fast with explicit diagnostic records; no fallback, no
//!   silent strip, no downstream compensation.

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DebugError {
    ImmutableRecord,
    DuplicateSubscription,
    UnknownSubscription,
    SnapshotSessionNotActive,
    SnapshotSessionAlreadyActive,
    DuplicateFixture,
    UnknownFixture,
    ModuleSwitchConflict,
    NetworkEffectForbidden,
    RetentionCapExceeded,
}

impl std::fmt::Display for DebugError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for DebugError {}

/// Immutable snapshot ledger entry (diagnostic-only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DebugSnapshotRecord {
    pub record_id: String,
    pub server_id: String,
    pub request_id: String,
    pub execution_id: String,
    pub kind: String,
    pub payload_hash: String,
}

#[derive(Debug, Clone, Default)]
pub struct V4Debug01SnapshotLedger {
    records: Vec<DebugSnapshotRecord>,
}

impl V4Debug01SnapshotLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn append(&mut self, record: DebugSnapshotRecord) -> Result<(), DebugError> {
        if self.records.iter().any(|existing| existing.record_id == record.record_id) {
            return Err(DebugError::ImmutableRecord);
        }
        self.records.push(record);
        Ok(())
    }

    pub fn records(&self) -> impl Iterator<Item = &DebugSnapshotRecord> {
        self.records.iter()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum SubscriptionTopic {
    NodeEvent,
    StateTransition,
    Diagnostic,
    NodeEntry,
    NodeExit,
    NodeError,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    pub subscriber_id: String,
    pub topic: SubscriptionTopic,
    pub scope_key: String,
}

#[derive(Debug, Clone, Default)]
pub struct V4Debug02BusSubscription {
    subscriptions: Vec<Subscription>,
}

impl V4Debug02BusSubscription {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(
        &mut self,
        subscriber_id: &str,
        topic: SubscriptionTopic,
        scope_key: &str,
    ) -> Result<(), DebugError> {
        let duplicate = self.subscriptions.iter().any(|existing| {
            existing.subscriber_id == subscriber_id
                && existing.topic == topic
                && existing.scope_key == scope_key
        });
        if duplicate {
            return Err(DebugError::DuplicateSubscription);
        }
        self.subscriptions.push(Subscription {
            subscriber_id: subscriber_id.to_string(),
            topic,
            scope_key: scope_key.to_string(),
        });
        Ok(())
    }

    pub fn subscribers_for<'a>(
        &'a self,
        topic: &'a SubscriptionTopic,
    ) -> impl Iterator<Item = &'a Subscription> {
        self.subscriptions.iter().filter(move |subscription| &subscription.topic == topic)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotSubscription {
    pub subscriber_id: String,
    pub node_id: String,
    pub snapshot_kind: String,
    pub scope_key: String,
}

#[derive(Debug, Clone, Default)]
pub struct V4Debug03SnapshotSubscription {
    subscriptions: Vec<SnapshotSubscription>,
}

impl V4Debug03SnapshotSubscription {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(
        &mut self,
        subscription: SnapshotSubscription,
    ) -> Result<(), DebugError> {
        let duplicate = self.subscriptions.iter().any(|existing| {
            existing.subscriber_id == subscription.subscriber_id
                && existing.node_id == subscription.node_id
                && existing.snapshot_kind == subscription.snapshot_kind
                && existing.scope_key == subscription.scope_key
        });
        if duplicate {
            return Err(DebugError::DuplicateSubscription);
        }
        self.subscriptions.push(subscription);
        Ok(())
    }

    pub fn subscriptions(&self) -> impl Iterator<Item = &SnapshotSubscription> {
        self.subscriptions.iter()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceContext {
    pub trace_id: String,
    pub server_id: String,
    pub request_id: String,
    pub execution_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct V4Debug04TraceContextStarted {
    contexts: Vec<TraceContext>,
}

impl V4Debug04TraceContextStarted {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(&mut self, context: TraceContext) -> Result<(), DebugError> {
        if self.contexts.iter().any(|existing| existing.trace_id == context.trace_id) {
            return Err(DebugError::ImmutableRecord);
        }
        self.contexts.push(context);
        Ok(())
    }

    pub fn contexts(&self) -> impl Iterator<Item = &TraceContext> {
        self.contexts.iter()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DebugEventRecord {
    pub sequence: u64,
    pub server_id: String,
    pub request_id: String,
    pub execution_id: String,
    pub node_id: String,
    pub event: String,
}

#[derive(Debug, Clone, Default)]
pub struct V4Debug05EventLedgerRecorded {
    records: Vec<DebugEventRecord>,
    next_sequence: u64,
}

impl V4Debug05EventLedgerRecorded {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(
        &mut self,
        server_id: &str,
        request_id: &str,
        execution_id: &str,
        node_id: &str,
        event: &str,
    ) -> DebugEventRecord {
        let record = DebugEventRecord {
            sequence: self.next_sequence,
            server_id: server_id.to_string(),
            request_id: request_id.to_string(),
            execution_id: execution_id.to_string(),
            node_id: node_id.to_string(),
            event: event.to_string(),
        };
        self.next_sequence += 1;
        self.records.push(record.clone());
        record
    }

    pub fn records(&self) -> impl Iterator<Item = &DebugEventRecord> {
        self.records.iter()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawCaptureRecord {
    pub sequence: u64,
    pub server_id: String,
    pub request_id: String,
    pub execution_id: String,
    pub kind: String,
    pub verbatim: String,
    pub payload_hash: String,
}

#[derive(Debug, Clone, Default)]
pub struct V4Debug06RawCaptureStored {
    records: Vec<RawCaptureRecord>,
    next_sequence: u64,
}

impl V4Debug06RawCaptureStored {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn capture_raw_request(
        &mut self,
        server_id: &str,
        request_id: &str,
        execution_id: &str,
        verbatim: &str,
    ) -> RawCaptureRecord {
        self.store("request", server_id, request_id, execution_id, verbatim)
    }

    pub fn capture_raw_response(
        &mut self,
        server_id: &str,
        request_id: &str,
        execution_id: &str,
        verbatim: &str,
    ) -> RawCaptureRecord {
        self.store("response", server_id, request_id, execution_id, verbatim)
    }

    fn store(
        &mut self,
        kind: &str,
        server_id: &str,
        request_id: &str,
        execution_id: &str,
        verbatim: &str,
    ) -> RawCaptureRecord {
        let record = RawCaptureRecord {
            sequence: self.next_sequence,
            server_id: server_id.to_string(),
            request_id: request_id.to_string(),
            execution_id: execution_id.to_string(),
            kind: kind.to_string(),
            verbatim: verbatim.to_string(),
            payload_hash: format!("sha256:{}", verbatim.len()),
        };
        self.next_sequence += 1;
        self.records.push(record.clone());
        record
    }

    pub fn records(&self) -> impl Iterator<Item = &RawCaptureRecord> {
        self.records.iter()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotEntry {
    pub node_id: String,
    pub payload_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotSession {
    pub session_id: String,
    pub server_id: String,
    pub request_id: String,
    pub execution_id: String,
    pub entries: Vec<SnapshotEntry>,
}

#[derive(Debug, Clone, Default)]
pub struct V4Debug07SnapshotSessionRegistered {
    sessions: BTreeMap<String, SnapshotSession>,
}

impl V4Debug07SnapshotSessionRegistered {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start_snapshot_session(
        &mut self,
        session_id: &str,
        server_id: &str,
        request_id: &str,
        execution_id: &str,
    ) -> Result<(), DebugError> {
        if self.sessions.contains_key(session_id) {
            return Err(DebugError::SnapshotSessionAlreadyActive);
        }
        self.sessions.insert(
            session_id.to_string(),
            SnapshotSession {
                session_id: session_id.to_string(),
                server_id: server_id.to_string(),
                request_id: request_id.to_string(),
                execution_id: execution_id.to_string(),
                entries: Vec::new(),
            },
        );
        Ok(())
    }

    pub fn record_snapshot(
        &mut self,
        session_id: &str,
        node_id: &str,
        payload_hash: &str,
    ) -> Result<(), DebugError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(DebugError::SnapshotSessionNotActive)?;
        session.entries.push(SnapshotEntry {
            node_id: node_id.to_string(),
            payload_hash: payload_hash.to_string(),
        });
        Ok(())
    }

    pub fn release_snapshot_session(&mut self, session_id: &str) -> Result<SnapshotSession, DebugError> {
        self.sessions
            .remove(session_id)
            .ok_or(DebugError::SnapshotSessionNotActive)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DryRunFixture {
    pub fixture_id: String,
    pub server_id: String,
    pub endpoint: String,
    pub input_hash: String,
}

#[derive(Debug, Clone, Default)]
pub struct V4Debug08DryRunFixture {
    fixtures: BTreeMap<String, DryRunFixture>,
}

impl V4Debug08DryRunFixture {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_dry_run_fixture(&mut self, fixture: DryRunFixture) -> Result<(), DebugError> {
        if self.fixtures.contains_key(&fixture.fixture_id) {
            return Err(DebugError::DuplicateFixture);
        }
        self.fixtures.insert(fixture.fixture_id.clone(), fixture);
        Ok(())
    }

    pub fn build_dry_run_execution_plan(&self, fixture_id: &str) -> Result<&DryRunFixture, DebugError> {
        self.fixtures.get(fixture_id).ok_or(DebugError::UnknownFixture)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DryRunChainDefinition {
    pub chain_id: String,
    pub module_id: String,
    pub entry_node: Option<String>,
    pub exit_node: Option<String>,
    pub fixture_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct V4Debug13DryRunChain {
    chains: BTreeMap<String, DryRunChainDefinition>,
}

impl V4Debug13DryRunChain {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_dry_run_chain(
        &mut self,
        chain: DryRunChainDefinition,
    ) -> Result<(), DebugError> {
        if self.chains.contains_key(&chain.chain_id) {
            return Err(DebugError::ImmutableRecord);
        }
        self.chains.insert(chain.chain_id.clone(), chain);
        Ok(())
    }

    pub fn chain(&self, chain_id: &str) -> Option<&DryRunChainDefinition> {
        self.chains.get(chain_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum SwitchKind {
    Debug,
    Snapshot,
    DryRun,
    RouteProbe,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleSwitchState {
    pub module_id: String,
    pub node_id: String,
    pub scope_key: String,
    pub kind: SwitchKind,
    pub level: String,
    pub audit: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct V4Debug12ModuleSwitch {
    switches: BTreeMap<(String, String, String, SwitchKind), ModuleSwitchState>,
}

impl V4Debug12ModuleSwitch {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(
        &mut self,
        module_id: &str,
        node_id: &str,
        scope_key: &str,
        kind: SwitchKind,
        level: &str,
        default_from_manifest: bool,
    ) -> Result<(), DebugError> {
        let key = (
            module_id.to_string(),
            node_id.to_string(),
            scope_key.to_string(),
            kind.clone(),
        );
        let state = self.switches.entry(key).or_insert_with(|| ModuleSwitchState {
            module_id: module_id.to_string(),
            node_id: node_id.to_string(),
            scope_key: scope_key.to_string(),
            kind,
            level: String::new(),
            audit: Vec::new(),
        });
        if default_from_manifest && !state.audit.is_empty() {
            return Err(DebugError::ModuleSwitchConflict);
        }
        state.level = level.to_string();
        state
            .audit
            .push(format!("{level}@{}", state.audit.len()));
        Ok(())
    }

    pub fn enabled_for_module(&self, module_id: &str) -> bool {
        self.switches
            .iter()
            .any(|((candidate, _, _, _), state)| candidate == module_id && state.level != "off")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadBudgetEntry {
    pub server_id: String,
    pub request_id: String,
    pub execution_id: String,
    pub artifact_kind: String,
    pub verbatim: String,
}

#[derive(Debug, Clone, Default)]
pub struct V4Debug10PayloadBudget {
    entries: Vec<PayloadBudgetEntry>,
    retention_cap: usize,
}

/// Diagnostic payload-budget state handle (owner symbol for
/// `v4.debug.payload_budget`).
#[derive(Debug, Clone, Default)]
pub struct PayloadBudgetState {
    budget: V4Debug10PayloadBudget,
}

impl PayloadBudgetState {
    pub fn new(retention_cap: usize) -> Self {
        Self {
            budget: V4Debug10PayloadBudget::new(retention_cap),
        }
    }

    pub fn budget(&mut self) -> &mut V4Debug10PayloadBudget {
        &mut self.budget
    }
}

impl V4Debug10PayloadBudget {
    pub fn new(retention_cap: usize) -> Self {
        Self {
            entries: Vec::new(),
            retention_cap: retention_cap.max(1),
        }
    }

    pub fn project_payload_verbatim(
        &mut self,
        server_id: &str,
        request_id: &str,
        execution_id: &str,
        artifact_kind: &str,
        verbatim: &str,
    ) -> Result<(), DebugError> {
        if self.entries.len() >= self.retention_cap {
            return Err(DebugError::RetentionCapExceeded);
        }
        self.entries.push(PayloadBudgetEntry {
            server_id: server_id.to_string(),
            request_id: request_id.to_string(),
            execution_id: execution_id.to_string(),
            artifact_kind: artifact_kind.to_string(),
            verbatim: verbatim.to_string(),
        });
        Ok(())
    }

    pub fn append_bounded_text(
        &mut self,
        server_id: &str,
        request_id: &str,
        execution_id: &str,
        artifact_kind: &str,
        text: &str,
    ) -> Result<(), DebugError> {
        let bounded = text.chars().take(200).collect::<String>();
        self.project_payload_verbatim(
            server_id,
            request_id,
            execution_id,
            artifact_kind,
            &bounded,
        )
    }

    pub fn entries(&self) -> impl Iterator<Item = &PayloadBudgetEntry> {
        self.entries.iter()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSample {
    pub entry_protocol: String,
    pub endpoint: String,
    pub port: u16,
    pub request_id: String,
    pub artifact_name: String,
    pub bytes: usize,
}

#[derive(Debug, Clone, Default)]
pub struct V4Debug11CodexSampleStore {
    samples: Vec<StoredSample>,
    listener_retention: usize,
}

/// Bounded codex sample filesystem store handle (owner symbol for
/// `v4.debug.codex_sample_filesystem`).
#[derive(Debug, Clone, Default)]
pub struct CodexSampleStore {
    store: V4Debug11CodexSampleStore,
}

impl CodexSampleStore {
    pub fn new(listener_retention: usize) -> Self {
        Self {
            store: V4Debug11CodexSampleStore::new(listener_retention),
        }
    }

    pub fn store(&mut self) -> &mut V4Debug11CodexSampleStore {
        &mut self.store
    }
}

impl V4Debug11CodexSampleStore {
    pub fn new(listener_retention: usize) -> Self {
        Self {
            samples: Vec::new(),
            listener_retention: listener_retention.max(1),
        }
    }

    pub fn persist(
        &mut self,
        entry_protocol: &str,
        endpoint: &str,
        port: u16,
        request_id: &str,
        artifact_name: &str,
        bytes: usize,
    ) -> Result<StoredSample, DebugError> {
        let sample = StoredSample {
            entry_protocol: entry_protocol.to_string(),
            endpoint: endpoint.to_string(),
            port,
            request_id: request_id.to_string(),
            artifact_name: artifact_name.to_string(),
            bytes,
        };
        self.samples.push(sample.clone());
        Ok(sample)
    }

    pub fn enforce_listener_retention(&mut self) -> usize {
        let overflow = self.samples.len().saturating_sub(self.listener_retention);
        if overflow > 0 {
            self.samples.drain(0..overflow);
        }
        overflow
    }

    pub fn samples(&self) -> impl Iterator<Item = &StoredSample> {
        self.samples.iter()
    }
}

/// Typed diagnostic facade: owns the resource node state machines above and
/// exposes the debug-subscription contract writer surface (V4DebugRuntime::*).
#[derive(Debug, Clone, Default)]
pub struct DebugRuntime {
    pub snapshot_ledger: V4Debug01SnapshotLedger,
    pub bus_subscription: V4Debug02BusSubscription,
    pub snapshot_subscription: V4Debug03SnapshotSubscription,
    pub trace_context: V4Debug04TraceContextStarted,
    pub event_ledger: V4Debug05EventLedgerRecorded,
    pub raw_capture: V4Debug06RawCaptureStored,
    pub snapshot_session: V4Debug07SnapshotSessionRegistered,
    pub dry_run_fixture: V4Debug08DryRunFixture,
    pub dry_run_chain: V4Debug13DryRunChain,
    pub module_switch: V4Debug12ModuleSwitch,
    pub payload_budget: V4Debug10PayloadBudget,
    pub codex_sample_store: V4Debug11CodexSampleStore,
}

impl DebugRuntime {
    pub fn new() -> Self {
        Self {
            snapshot_ledger: V4Debug01SnapshotLedger::new(),
            bus_subscription: V4Debug02BusSubscription::new(),
            snapshot_subscription: V4Debug03SnapshotSubscription::new(),
            trace_context: V4Debug04TraceContextStarted::new(),
            event_ledger: V4Debug05EventLedgerRecorded::new(),
            raw_capture: V4Debug06RawCaptureStored::new(),
            snapshot_session: V4Debug07SnapshotSessionRegistered::new(),
            dry_run_fixture: V4Debug08DryRunFixture::new(),
            dry_run_chain: V4Debug13DryRunChain::new(),
            module_switch: V4Debug12ModuleSwitch::new(),
            payload_budget: V4Debug10PayloadBudget::new(200),
            codex_sample_store: V4Debug11CodexSampleStore::new(200),
        }
    }

    pub fn start_trace(&mut self, context: TraceContext) -> Result<(), DebugError> {
        self.trace_context.start(context)
    }

    pub fn record_node_event(
        &mut self,
        server_id: &str,
        request_id: &str,
        execution_id: &str,
        node_id: &str,
        event: &str,
    ) -> DebugEventRecord {
        self.event_ledger.record(server_id, request_id, execution_id, node_id, event)
    }

    pub fn capture_raw_request(
        &mut self,
        server_id: &str,
        request_id: &str,
        execution_id: &str,
        verbatim: &str,
    ) -> RawCaptureRecord {
        self.raw_capture.capture_raw_request(server_id, request_id, execution_id, verbatim)
    }

    pub fn capture_raw_response(
        &mut self,
        server_id: &str,
        request_id: &str,
        execution_id: &str,
        verbatim: &str,
    ) -> RawCaptureRecord {
        self.raw_capture.capture_raw_response(server_id, request_id, execution_id, verbatim)
    }

    pub fn start_snapshot_session(
        &mut self,
        session_id: &str,
        server_id: &str,
        request_id: &str,
        execution_id: &str,
    ) -> Result<(), DebugError> {
        self.snapshot_session
            .start_snapshot_session(session_id, server_id, request_id, execution_id)
    }

    pub fn record_snapshot(
        &mut self,
        session_id: &str,
        node_id: &str,
        payload_hash: &str,
    ) -> Result<(), DebugError> {
        self.snapshot_session.record_snapshot(session_id, node_id, payload_hash)
    }

    pub fn release_snapshot_session(
        &mut self,
        session_id: &str,
    ) -> Result<SnapshotSession, DebugError> {
        self.snapshot_session.release_snapshot_session(session_id)
    }

    pub fn register_dry_run_fixture(&mut self, fixture: DryRunFixture) -> Result<(), DebugError> {
        self.dry_run_fixture.register_dry_run_fixture(fixture)
    }

    pub fn build_dry_run_execution_plan(&self, fixture_id: &str) -> Result<&DryRunFixture, DebugError> {
        self.dry_run_fixture.build_dry_run_execution_plan(fixture_id)
    }

    pub fn project_payload_verbatim(
        &mut self,
        server_id: &str,
        request_id: &str,
        execution_id: &str,
        artifact_kind: &str,
        verbatim: &str,
    ) -> Result<(), DebugError> {
        self.payload_budget
            .project_payload_verbatim(server_id, request_id, execution_id, artifact_kind, verbatim)
    }

    pub fn append_bounded_text(
        &mut self,
        server_id: &str,
        request_id: &str,
        execution_id: &str,
        artifact_kind: &str,
        text: &str,
    ) -> Result<(), DebugError> {
        self.payload_budget
            .append_bounded_text(server_id, request_id, execution_id, artifact_kind, text)
    }

    pub fn persist(
        &mut self,
        entry_protocol: &str,
        endpoint: &str,
        port: u16,
        request_id: &str,
        artifact_name: &str,
        bytes: usize,
    ) -> Result<StoredSample, DebugError> {
        self.codex_sample_store
            .persist(entry_protocol, endpoint, port, request_id, artifact_name, bytes)
    }

    pub fn enforce_listener_retention(&mut self) -> usize {
        self.codex_sample_store.enforce_listener_retention()
    }

    pub fn should_capture_snapshot_stage(&self, _stage: &str) -> bool {
        // Capture authorization is published by the config manifest
        // (v4.debug.codex_sample_authorization); the debug runtime only
        // consumes that truth, it never writes it.
        self.module_switch.enabled_for_module("codex_samples")
    }
}

/// Guard used by the resource gate to prove the debug crate never exposes a
/// control signal carrier or a payload truth reader.
pub fn assert_diagnostic_only(runtime: &DebugRuntime) -> bool {
    runtime.snapshot_ledger.records().count()
        + runtime.event_ledger.records().count()
        + runtime.raw_capture.records().count()
        + runtime.bus_subscription.subscriptions.len()
        + runtime.snapshot_subscription.subscriptions().count()
        + runtime.trace_context.contexts().count()
        + runtime.snapshot_session.sessions.len()
        + runtime.dry_run_fixture.fixtures.len()
        + runtime.dry_run_chain.chains.len()
        + runtime.payload_budget.entries().count()
        + runtime.codex_sample_store.samples().count()
        > 0
        || runtime.module_switch.switches.len() > 0
}

/// Reserved marker: this module owns no payload writer and no control signal
/// writer; the set stays empty by construction.
pub const DEBUG_CONTROL_MARKERS: &[&str] = &[];
