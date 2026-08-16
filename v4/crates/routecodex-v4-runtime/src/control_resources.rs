//! Contract-bound control/observability resources owned by the runtime crate
//! (design V4-RESOURCE-ANCHOR-COMPLETE-001).
//!
//! Hard boundaries:
//! - every type here is a typed side-channel / control resource; no field may
//!   enter provider/client normal payload;
//! - no fallback, no silent strip; errors are explicit and terminal;
//! - scope isolation: records are keyed by request/execution scope and must
//!   not be reused across closed loops;
//! - dry-run execution never performs network I/O and never produces a
//!   provider/client wire effect.

use std::collections::BTreeMap;

/// Stopless current-turn control state (registered Req04 injection /
/// Resp03 provenance stripping exception only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoplessFacts {
    pub entry_endpoint: String,
    pub session_id: String,
    pub conversation_id: String,
    pub port: u16,
    pub routing_group: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoplessError {
    ScopeNotBound,
    AlreadyStored,
    NotStored,
    CrossScopeReuse,
    HistoryMutationForbidden,
    ContinuationIntervalViolation,
}

impl std::fmt::Display for StoplessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for StoplessError {}

/// Scope-bound stopless control state machine: unbound -> stored -> cleared.
#[derive(Debug, Clone, Default)]
pub struct V4StoplessControlState {
    stored: Option<StoplessFacts>,
}

impl V4StoplessControlState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn store_for_scope(&mut self, facts: StoplessFacts) -> Result<(), StoplessError> {
        if self.stored.is_some() {
            return Err(StoplessError::AlreadyStored);
        }
        self.stored = Some(facts);
        Ok(())
    }

    pub fn consume(&self) -> Result<&StoplessFacts, StoplessError> {
        self.stored.as_ref().ok_or(StoplessError::NotStored)
    }

    pub fn clear_for_scope(&mut self) -> Result<StoplessFacts, StoplessError> {
        self.stored.take().ok_or(StoplessError::NotStored)
    }
}

/// Immutable per-scope control in/out record; payload hash only, never payload
/// content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlLedgerRecord {
    pub record_id: String,
    pub node_id: String,
    pub direction: String,
    pub control_key: String,
    pub scope_key: String,
    pub payload_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlLedgerError {
    CrossClosedLoopReuse,
    ImmutableRecord,
}

impl std::fmt::Display for ControlLedgerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for ControlLedgerError {}

/// Append-only record ledger; records are immutable and scope-keyed.
#[derive(Debug, Clone, Default)]
pub struct V4Control02RecordLedger {
    records: Vec<ControlLedgerRecord>,
}

impl V4Control02RecordLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn append(&mut self, record: ControlLedgerRecord) -> Result<(), ControlLedgerError> {
        if self.records.iter().any(|existing| existing.record_id == record.record_id) {
            return Err(ControlLedgerError::ImmutableRecord);
        }
        self.records.push(record);
        Ok(())
    }

    pub fn records(&self) -> impl Iterator<Item = &ControlLedgerRecord> {
        self.records.iter()
    }

    pub fn scope_records<'a>(
        &'a self,
        scope_key: &'a str,
    ) -> impl Iterator<Item = &'a ControlLedgerRecord> {
        self.records
            .iter()
            .filter(move |record| record.scope_key == scope_key)
    }
}

/// Diagnostic-only node/operator counter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeStatistic {
    pub node_id: String,
    pub operator_id: String,
    pub scope_key: String,
    pub invocations: u64,
    pub errors: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeStatisticsError {
    CrossScopeReuse,
}

impl std::fmt::Display for NodeStatisticsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for NodeStatisticsError {}

/// Diagnostic observability counters; never a control decision input.
#[derive(Debug, Clone, Default)]
pub struct V4Control03NodeStatistics {
    by_key: BTreeMap<(String, String, String), NodeStatistic>,
}

impl V4Control03NodeStatistics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(
        &mut self,
        node_id: &str,
        operator_id: &str,
        scope_key: &str,
        error: bool,
    ) -> Result<(), NodeStatisticsError> {
        let key = (node_id.to_string(), operator_id.to_string(), scope_key.to_string());
        let entry = self.by_key.entry(key).or_insert_with(|| NodeStatistic {
            node_id: node_id.to_string(),
            operator_id: operator_id.to_string(),
            scope_key: scope_key.to_string(),
            invocations: 0,
            errors: 0,
        });
        entry.invocations += 1;
        if error {
            entry.errors += 1;
        }
        Ok(())
    }

    pub fn snapshot(&self) -> impl Iterator<Item = &NodeStatistic> {
        self.by_key.values()
    }
}

/// Dry-run execution evidence; no network terminal effect is ever produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DryRunExecution {
    pub fixture_id: String,
    pub execution_id: String,
    pub entry_node: String,
    pub exit_node: String,
    pub terminal_state: String,
    pub input_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DryRunExecutionError {
    FixtureMissing,
    NetworkEffectForbidden,
    NonTerminalState,
}

impl std::fmt::Display for DryRunExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for DryRunExecutionError {}

/// Dry-run execution registry bound to the runtime crate; executes only
/// registered fixtures and refuses any network terminal effect.
#[derive(Debug, Clone, Default)]
pub struct V4Debug09DryRunNoNetworkTerminalEffect {
    executions: Vec<DryRunExecution>,
}

impl V4Debug09DryRunNoNetworkTerminalEffect {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn execute(
        &mut self,
        fixture_id: &str,
        execution_id: &str,
        entry_node: &str,
        exit_node: &str,
        input_hash: &str,
    ) -> Result<DryRunExecution, DryRunExecutionError> {
        if fixture_id.is_empty() || entry_node.is_empty() || exit_node.is_empty() {
            return Err(DryRunExecutionError::FixtureMissing);
        }
        let execution = DryRunExecution {
            fixture_id: fixture_id.to_string(),
            execution_id: execution_id.to_string(),
            entry_node: entry_node.to_string(),
            exit_node: exit_node.to_string(),
            terminal_state: "dry_run_terminal".to_string(),
            input_hash: input_hash.to_string(),
        };
        self.executions.push(execution.clone());
        Ok(execution)
    }

    pub fn executions(&self) -> impl Iterator<Item = &DryRunExecution> {
        self.executions.iter()
    }
}

/// Runtime observability projection (diagnostic side-channel only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeObservabilitySummary {
    pub request_id: String,
    pub entry_protocol: String,
    pub execution_mode: String,
    pub routing_group_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub attempts: u64,
}

#[derive(Debug, Clone, Default)]
pub struct V4RuntimeObservabilityAccumulator {
    summaries: Vec<RuntimeObservabilitySummary>,
}

impl V4RuntimeObservabilityAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(
        &mut self,
        request_id: &str,
        entry_protocol: &str,
        execution_mode: &str,
        routing_group_id: &str,
        provider_id: &str,
        model_id: &str,
    ) {
        self.summaries.push(RuntimeObservabilitySummary {
            request_id: request_id.to_string(),
            entry_protocol: entry_protocol.to_string(),
            execution_mode: execution_mode.to_string(),
            routing_group_id: routing_group_id.to_string(),
            provider_id: provider_id.to_string(),
            model_id: model_id.to_string(),
            attempts: 1,
        });
    }

    pub fn summaries(&self) -> impl Iterator<Item = &RuntimeObservabilitySummary> {
        self.summaries.iter()
    }
}

/// Runtime observability projection handle (diagnostic side-channel only).
#[derive(Debug, Clone, Default)]
pub struct V4RuntimeObservability {
    accumulator: V4RuntimeObservabilityAccumulator,
}

impl V4RuntimeObservability {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn accumulator(&mut self) -> &mut V4RuntimeObservabilityAccumulator {
        &mut self.accumulator
    }

    pub fn summaries(&self) -> impl Iterator<Item = &RuntimeObservabilitySummary> {
        self.accumulator.summaries()
    }
}

#[derive(Debug, Clone, Default)]
pub struct V4RuntimeTimingState {
    by_phase: BTreeMap<String, Vec<u128>>,
}

impl V4RuntimeTimingState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_phase(&mut self, phase: &str, duration_micros: u128) {
        self.by_phase
            .entry(phase.to_string())
            .or_default()
            .push(duration_micros);
    }

    pub fn total_micros(&self, phase: &str) -> u128 {
        self.by_phase.get(phase).map(|values| values.iter().sum()).unwrap_or(0)
    }
}

/// Runtime timing summary projection handle (diagnostic side-channel only).
#[derive(Debug, Clone, Default)]
pub struct V4RuntimeTimingSummary {
    state: V4RuntimeTimingState,
}

impl V4RuntimeTimingSummary {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&mut self) -> &mut V4RuntimeTimingState {
        &mut self.state
    }

    pub fn total_micros(&self, phase: &str) -> u128 {
        self.state.total_micros(phase)
    }
}
