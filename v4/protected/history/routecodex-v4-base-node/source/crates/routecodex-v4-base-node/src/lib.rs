use std::collections::HashMap;

/// BaseNode identity: chain, chain_version and position are immutable contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeIdentity {
    node_id: String,
    chain: String,
    chain_version: String,
    position: u32,
    owner: String,
}

impl NodeIdentity {
    pub fn new(
        node_id: &str,
        chain: &str,
        chain_version: &str,
        position: u32,
        owner: &str,
    ) -> Self {
        Self {
            node_id: node_id.to_string(),
            chain: chain.to_string(),
            chain_version: chain_version.to_string(),
            position,
            owner: owner.to_string(),
        }
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    pub fn chain(&self) -> &str {
        &self.chain
    }

    pub fn chain_version(&self) -> &str {
        &self.chain_version
    }

    pub fn position(&self) -> u32 {
        self.position
    }

    pub fn owner(&self) -> &str {
        &self.owner
    }
}

/// Closed-loop control scope. Cross-loop reuse is forbidden.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    request_id: String,
    pipeline_id: String,
    port: u16,
    session_scope: String,
    conversation_scope: String,
}

impl Scope {
    pub fn new(
        request_id: &str,
        pipeline_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
    ) -> Self {
        Self {
            request_id: request_id.to_string(),
            pipeline_id: pipeline_id.to_string(),
            port,
            session_scope: session_scope.to_string(),
            conversation_scope: conversation_scope.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlDirection {
    In,
    Out,
}

/// Immutable control record; every control_in/control_out writes one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlRecord {
    pub record_id: String,
    pub node_id: String,
    pub direction: ControlDirection,
    pub control_key: String,
    pub scope: Scope,
    pub payload_hash: Option<String>,
    pub sequence: u64,
    pub timestamp_ms: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebugSwitchKind {
    Debug,
    Snapshot,
    DryRun,
    RouteProbe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum DebugSwitchLevel {
    Off,
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitchAuditEntry {
    pub kind: DebugSwitchKind,
    pub level: DebugSwitchLevel,
    pub actor: String,
}

#[derive(Debug, Clone)]
pub struct DebugSubscription {
    pub read_only: bool,
    pub decision_plane: bool,
    pub payload_carrier: bool,
    topic: String,
}

impl DebugSubscription {
    pub fn topic(&self) -> &str {
        &self.topic
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotKind {
    NodeEntry,
    NodeExit,
    NodeError,
}

#[derive(Debug, Clone)]
pub struct SnapshotSubscription {
    pub diagnostic_only: bool,
    pub live_input: bool,
    kind: SnapshotKind,
}

impl SnapshotSubscription {
    pub fn kind(&self) -> SnapshotKind {
        self.kind
    }
}

#[derive(Debug, Default, Clone)]
pub struct Statistics {
    counters: HashMap<String, u64>,
}

impl Statistics {
    pub fn counter(&self, name: &str) -> Option<u64> {
        self.counters.get(name).copied()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeError {
    NoMatchingInRecord,
    AuditActorRequired,
    DuplicateSubscription,
    DryRunNotDeclared,
    InvalidSnapshotKind,
    InvalidHookKind,
    InvalidHookEffect,
    DuplicateHookPosition,
    HookNotDeclared,
}

/// Immutable typed error intake record; every node error must enter through BaseNode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorIntakeRecord {
    pub intake_id: String,
    pub node_id: String,
    pub stage: String,
    pub code: String,
    pub scope: Scope,
    pub payload_hash: Option<String>,
    pub typed_context: Option<String>,
    pub sequence: u64,
    pub timestamp_ms: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookKind {
    Entry,
    Exit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEffect {
    ReadOnly,
    ControlOnly,
    Semantic,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookDeclaration {
    pub hook_id: String,
    pub kind: HookKind,
    pub position: u32,
    pub owner: String,
    pub effect: HookEffect,
}

/// BaseNode carries identity and cross-cutting capabilities only; it has no business logic.
#[derive(Debug, Clone)]
pub struct BaseNode {
    identity: NodeIdentity,
    records: Vec<ControlRecord>,
    next_sequence: u64,
    debug_subscriptions: Vec<DebugSubscription>,
    snapshot_subscriptions: Vec<SnapshotSubscription>,
    statistics: Statistics,
    switch_kind: DebugSwitchKind,
    switch_level: DebugSwitchLevel,
    audit: Vec<SwitchAuditEntry>,
    dry_run_entry: Option<String>,
    dry_run_exit: Option<String>,
    error_intakes: Vec<ErrorIntakeRecord>,
    next_intake_sequence: u64,
    hooks: Vec<HookDeclaration>,
}

impl BaseNode {
    pub fn new(identity: NodeIdentity) -> Self {
        Self {
            identity,
            records: Vec::new(),
            next_sequence: 0,
            debug_subscriptions: Vec::new(),
            snapshot_subscriptions: Vec::new(),
            statistics: Statistics::default(),
            switch_kind: DebugSwitchKind::Debug,
            switch_level: DebugSwitchLevel::Off,
            audit: Vec::new(),
            dry_run_entry: None,
            dry_run_exit: None,
            error_intakes: Vec::new(),
            next_intake_sequence: 0,
            hooks: Vec::new(),
        }
    }

    pub fn identity(&self) -> &NodeIdentity {
        &self.identity
    }

    pub fn control_in(
        &mut self,
        control_key: &str,
        scope: Scope,
        payload_hash: Option<&str>,
    ) -> Result<ControlRecord, NodeError> {
        Ok(self.append_record(ControlDirection::In, control_key, scope, payload_hash))
    }

    /// control_out requires a matching In record for the same key and scope.
    pub fn control_out(
        &mut self,
        control_key: &str,
        scope: Scope,
        payload_hash: Option<&str>,
    ) -> Result<ControlRecord, NodeError> {
        let has_in = self.records.iter().any(|r| {
            r.direction == ControlDirection::In && r.control_key == control_key && r.scope == scope
        });
        if !has_in {
            return Err(NodeError::NoMatchingInRecord);
        }
        Ok(self.append_record(ControlDirection::Out, control_key, scope, payload_hash))
    }

    fn append_record(
        &mut self,
        direction: ControlDirection,
        control_key: &str,
        scope: Scope,
        payload_hash: Option<&str>,
    ) -> ControlRecord {
        self.next_sequence += 1;
        let record = ControlRecord {
            record_id: format!("{}-{}", self.identity.node_id(), self.next_sequence),
            node_id: self.identity.node_id().to_string(),
            direction,
            control_key: control_key.to_string(),
            scope,
            payload_hash: payload_hash.map(|h| h.to_string()),
            sequence: self.next_sequence,
            timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
        };
        self.records.push(record.clone());
        record
    }

    pub fn records(&self) -> impl Iterator<Item = &ControlRecord> {
        self.records.iter()
    }

    pub fn subscribe_debug(&mut self, topic: &str) -> Result<DebugSubscription, NodeError> {
        if self.debug_subscriptions.iter().any(|s| s.topic() == topic) {
            return Err(NodeError::DuplicateSubscription);
        }
        let sub = DebugSubscription {
            read_only: true,
            decision_plane: false,
            payload_carrier: false,
            topic: topic.to_string(),
        };
        self.debug_subscriptions.push(sub.clone());
        Ok(sub)
    }

    pub fn subscribe_snapshot(
        &mut self,
        kind: SnapshotKind,
    ) -> Result<SnapshotSubscription, NodeError> {
        let sub = SnapshotSubscription {
            diagnostic_only: true,
            live_input: false,
            kind,
        };
        self.snapshot_subscriptions.push(sub.clone());
        Ok(sub)
    }

    pub fn record_statistic(&mut self, name: &str, delta: u64) -> Result<(), NodeError> {
        let counter = self
            .statistics
            .counters
            .entry(name.to_string())
            .or_insert(0);
        *counter += delta;
        Ok(())
    }

    pub fn snapshot_statistics(&self) -> &Statistics {
        &self.statistics
    }

    pub fn set_debug_switch(
        &mut self,
        kind: DebugSwitchKind,
        level: DebugSwitchLevel,
        actor: &str,
    ) -> Result<SwitchAuditEntry, NodeError> {
        if actor.is_empty() {
            return Err(NodeError::AuditActorRequired);
        }
        self.switch_kind = kind;
        self.switch_level = level;
        let entry = SwitchAuditEntry {
            kind,
            level,
            actor: actor.to_string(),
        };
        self.audit.push(entry.clone());
        Ok(entry)
    }

    pub fn debug_enabled_for(&self, level: DebugSwitchLevel) -> bool {
        self.switch_level >= level && level != DebugSwitchLevel::Off
    }

    pub fn audit_trail(&self) -> &[SwitchAuditEntry] {
        &self.audit
    }

    pub fn declare_dry_run(&mut self, entry: &str, exit: &str) -> Result<(), NodeError> {
        self.dry_run_entry = Some(entry.to_string());
        self.dry_run_exit = Some(exit.to_string());
        Ok(())
    }

    pub fn supports_dry_run(&self) -> bool {
        self.dry_run_entry.is_some() && self.dry_run_exit.is_some()
    }

    /// Typed error intake: node errors enter the error center through this channel only.
    /// The intake is immutable, recorded, fail-fast, and never participates in decisions here.
    pub fn report_error(
        &mut self,
        stage: &str,
        code: &str,
        scope: Scope,
        payload_hash: Option<&str>,
        typed_context: Option<&str>,
    ) -> Result<ErrorIntakeRecord, NodeError> {
        self.next_intake_sequence += 1;
        let record = ErrorIntakeRecord {
            intake_id: format!(
                "err-{}-{}",
                self.identity.node_id(),
                self.next_intake_sequence
            ),
            node_id: self.identity.node_id().to_string(),
            stage: stage.to_string(),
            code: code.to_string(),
            scope,
            payload_hash: payload_hash.map(|h| h.to_string()),
            typed_context: typed_context.map(|c| c.to_string()),
            sequence: self.next_intake_sequence,
            timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
        };
        self.error_intakes.push(record.clone());
        Ok(record)
    }

    pub fn error_intakes(&self) -> impl Iterator<Item = &ErrorIntakeRecord> {
        self.error_intakes.iter()
    }

    /// Machine-declared hook queue: entry hooks run before operator, exit hooks after.
    pub fn declare_hook(
        &mut self,
        hook_id: &str,
        kind: HookKind,
        position: u32,
        owner: &str,
        effect: HookEffect,
    ) -> Result<HookDeclaration, NodeError> {
        if self
            .hooks
            .iter()
            .any(|h| h.kind == kind && h.position == position)
        {
            return Err(NodeError::DuplicateHookPosition);
        }
        let hook = HookDeclaration {
            hook_id: hook_id.to_string(),
            kind,
            position,
            owner: owner.to_string(),
            effect,
        };
        self.hooks.push(hook.clone());
        Ok(hook)
    }

    /// Returns declared hooks for a phase, ordered by position.
    pub fn hooks_for(&self, kind: HookKind) -> Vec<&HookDeclaration> {
        let mut hooks: Vec<&HookDeclaration> =
            self.hooks.iter().filter(|h| h.kind == kind).collect();
        hooks.sort_by_key(|h| h.position);
        hooks
    }

    pub fn hook_count(&self) -> usize {
        self.hooks.len()
    }

    /// Dry-run executes a fixture through the declared chain without network.
    pub fn execute_dry_run<F>(&self, fixture: &str, f: F) -> Result<String, NodeError>
    where
        F: FnOnce(&NodeIdentity, &str) -> Result<String, NodeError>,
    {
        if !self.supports_dry_run() {
            return Err(NodeError::DryRunNotDeclared);
        }
        f(&self.identity, fixture)
    }

    /// BaseNode has no operators; business behavior only comes from registered operators.
    pub fn operator_count(&self) -> usize {
        0
    }
}
