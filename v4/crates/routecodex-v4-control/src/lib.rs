use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use routecodex_v4_base_node::Scope;

/// Typed control signal categories. Free-form JSON is forbidden by contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlSignalKind {
    Route,
    Continuation,
    Stopless,
    Error,
    Scope,
}

/// Registered event classes are diagnostic/control observations only. Decision
/// owners still return typed decisions directly; this transport cannot decide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ControlEventKind {
    Observation,
    Timing,
    NodeLifecycle,
    RouteHit,
    ProviderAttempt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryPolicy {
    Synchronous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlEvent {
    pub event_id: String,
    pub kind: ControlEventKind,
    pub producer: String,
    pub consumer: String,
    pub owner_node: String,
    pub scope: Scope,
    pub sequence: u64,
    pub causality_id: String,
    pub delivery: DeliveryPolicy,
    pub ack_required: bool,
    pub terminal: bool,
    pub release_point: String,
}

impl ControlEvent {
    #[allow(clippy::too_many_arguments)]
    pub fn diagnostic(
        event_id: &str,
        kind: ControlEventKind,
        producer: &str,
        consumer: &str,
        owner_node: &str,
        scope: Scope,
        sequence: u64,
        causality_id: &str,
        delivery: DeliveryPolicy,
        ack_required: bool,
        terminal: bool,
        release_point: &str,
    ) -> Result<Self, ControlEventError> {
        if event_id.trim().is_empty()
            || producer.trim().is_empty()
            || consumer.trim().is_empty()
            || owner_node.trim().is_empty()
            || causality_id.trim().is_empty()
            || release_point.trim().is_empty()
            || sequence == 0
        {
            return Err(ControlEventError::InvalidEnvelope);
        }
        if terminal && !ack_required {
            return Err(ControlEventError::TerminalAckRequired);
        }
        Ok(Self {
            event_id: event_id.to_string(),
            kind,
            producer: producer.to_string(),
            consumer: consumer.to_string(),
            owner_node: owner_node.to_string(),
            scope,
            sequence,
            causality_id: causality_id.to_string(),
            delivery,
            ack_required,
            terminal,
            release_point: release_point.to_string(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlEventError {
    InvalidEnvelope,
    TerminalAckRequired,
    DuplicateEvent,
    SequenceGap,
    ScopeMismatch,
    OwnerAcknowledgementRequired,
    UnknownEvent,
    WrongOwner,
    DuplicateTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EventState {
    acknowledged: bool,
    released: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ControlEventRegistry {
    kinds: std::collections::BTreeSet<ControlEventKind>,
}

impl ControlEventRegistry {
    pub fn standard() -> Self {
        Self {
            kinds: [
                ControlEventKind::Observation,
                ControlEventKind::Timing,
                ControlEventKind::NodeLifecycle,
                ControlEventKind::RouteHit,
                ControlEventKind::ProviderAttempt,
            ]
            .into_iter()
            .collect(),
        }
    }

    fn contains(&self, kind: ControlEventKind) -> bool {
        self.kinds.contains(&kind)
    }
}

/// Synchronous, scope-bound transport for observation events. It validates
/// monotonic sequence and owner acknowledgement; it never produces routing or
/// health decisions and cannot be used as a fire-and-forget decision bus.
#[derive(Debug, Clone)]
pub struct ControlEventBus {
    scope: Scope,
    registry: ControlEventRegistry,
    events: HashMap<String, (ControlEvent, EventState)>,
    next_sequence: u64,
}

impl ControlEventBus {
    pub fn new(scope: Scope, registry: ControlEventRegistry) -> Self {
        Self {
            scope,
            registry,
            events: HashMap::new(),
            next_sequence: 0,
        }
    }

    pub fn publish(&mut self, event: ControlEvent) -> Result<(), ControlEventError> {
        if !self.registry.contains(event.kind) {
            return Err(ControlEventError::UnknownEvent);
        }
        if event.scope != self.scope {
            return Err(ControlEventError::ScopeMismatch);
        }
        if self.events.contains_key(&event.event_id) {
            return Err(ControlEventError::DuplicateEvent);
        }
        if event.sequence != self.next_sequence + 1 {
            return Err(ControlEventError::SequenceGap);
        }
        self.next_sequence = event.sequence;
        self.events.insert(
            event.event_id.clone(),
            (event, EventState { acknowledged: false, released: false }),
        );
        Ok(())
    }

    pub fn ack(&mut self, event_id: &str, owner: &str) -> Result<(), ControlEventError> {
        let (event, state) = self
            .events
            .get_mut(event_id)
            .ok_or(ControlEventError::UnknownEvent)?;
        if event.consumer != owner && event.owner_node != owner {
            return Err(ControlEventError::WrongOwner);
        }
        if event.terminal && state.acknowledged {
            return Err(ControlEventError::DuplicateTerminal);
        }
        state.acknowledged = true;
        Ok(())
    }

    pub fn release(&mut self, event_id: &str) -> Result<(), ControlEventError> {
        let (_, state) = self
            .events
            .get_mut(event_id)
            .ok_or(ControlEventError::UnknownEvent)?;
        if !state.acknowledged {
            return Err(ControlEventError::OwnerAcknowledgementRequired);
        }
        if state.released {
            return Err(ControlEventError::DuplicateTerminal);
        }
        state.released = true;
        Ok(())
    }

    pub fn events(&self) -> impl Iterator<Item = &ControlEvent> {
        self.events.values().map(|(event, _)| event)
    }
}

/// A typed control signal bound to a closed-loop scope.
///
/// The type carries no generic JSON value: only `kind`, typed key, value hash
/// and optional payload hash. It must never be serialized into a business
/// request/response payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlSignal {
    pub kind: ControlSignalKind,
    pub key: String,
    pub value_hash: String,
    pub scope: Scope,
    pub payload_hash: Option<String>,
}

impl ControlSignal {
    pub fn new(
        kind: ControlSignalKind,
        key: &str,
        value_hash: &str,
        scope: Scope,
        payload_hash: Option<&str>,
    ) -> Self {
        Self {
            kind,
            key: key.to_string(),
            value_hash: value_hash.to_string(),
            scope,
            payload_hash: payload_hash.map(|h| h.to_string()),
        }
    }

    /// RED-09: client protocol metadata (`metadata` / `client_metadata` / `x-*`)
    /// can never become a control signal. Always fails fast.
    pub fn try_from_protocol_metadata(_key: &str, _value: &str) -> Result<Self, ControlError> {
        Err(ControlError::ProtocolMetadataNotControl)
    }

    /// RED-04: control state must never be reconstructed from payload.
    /// Always fails fast.
    pub fn try_reconstruct_from_payload(
        _payload_hash: &str,
        _scope: Scope,
    ) -> Result<Self, ControlError> {
        Err(ControlError::ControlNotReconstructibleFromPayload)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataOperation {
    Register,
    Consume,
    Release,
}

/// Immutable audit record for every successful register / consume / release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataRecord {
    pub record_id: String,
    pub control_key: String,
    pub operation: MetadataOperation,
    pub scope: Scope,
    pub signal: ControlSignal,
    pub sequence: u64,
    pub timestamp_ms: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlState {
    Registered,
    Released,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlError {
    AlreadyRegistered,
    NotRegistered,
    AlreadyReleased,
    ConsumeAfterRelease,
    ScopeMismatch,
    ControlIntoPayload,
    ProtocolMetadataNotControl,
    ControlNotReconstructibleFromPayload,
}

/// Scope-bound register / consume / release state machine with immutable audit.
///
/// One instance owns one `LoopScope`; cross-loop reuse of control signals is a
/// contract violation and fails fast at the owning boundary.
#[derive(Debug, Clone)]
pub struct MetadataCenter {
    scope: Scope,
    signals: HashMap<String, (ControlSignal, ControlState)>,
    records: Vec<MetadataRecord>,
    next_sequence: u64,
}

impl MetadataCenter {
    pub fn new(scope: Scope) -> Self {
        Self {
            scope,
            signals: HashMap::new(),
            records: Vec::new(),
            next_sequence: 0,
        }
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    /// `unregistered -> registered`. Duplicate register or cross-scope signal is red.
    pub fn register(&mut self, signal: ControlSignal) -> Result<MetadataRecord, ControlError> {
        if self.signals.contains_key(&signal.key) {
            return Err(ControlError::AlreadyRegistered);
        }
        if signal.scope != self.scope {
            return Err(ControlError::ScopeMismatch);
        }
        self.signals.insert(
            signal.key.clone(),
            (signal.clone(), ControlState::Registered),
        );
        Ok(self.append_record(MetadataOperation::Register, signal))
    }

    /// `registered -> registered` (consume does not change state), writes audit.
    /// Unregistered consume / consume-after-release is red.
    pub fn consume(&mut self, control_key: &str) -> Result<&ControlSignal, ControlError> {
        let state = self
            .signals
            .get(control_key)
            .map(|(signal, state)| (signal.clone(), *state));
        let (signal, state) = match state {
            None => return Err(ControlError::NotRegistered),
            Some(pair) => pair,
        };
        match state {
            ControlState::Released => return Err(ControlError::ConsumeAfterRelease),
            ControlState::Registered => {
                self.append_record(MetadataOperation::Consume, signal);
            }
        }
        match self.signals.get(control_key) {
            Some((signal, ControlState::Registered)) => Ok(signal),
            _ => unreachable!("consume validated above"),
        }
    }

    /// `registered -> released`, writes audit. Unregistered / double release is red.
    pub fn release(&mut self, control_key: &str) -> Result<MetadataRecord, ControlError> {
        let state = self
            .signals
            .get(control_key)
            .map(|(signal, state)| (signal.clone(), *state));
        let (signal, state) = match state {
            None => return Err(ControlError::NotRegistered),
            Some(pair) => pair,
        };
        match state {
            ControlState::Released => return Err(ControlError::AlreadyReleased),
            ControlState::Registered => {
                self.signals.insert(
                    control_key.to_string(),
                    (signal.clone(), ControlState::Released),
                );
                Ok(self.append_record(MetadataOperation::Release, signal))
            }
        }
    }

    /// Read-only diagnostic audit stream; never a live-path input.
    pub fn records(&self) -> impl Iterator<Item = &MetadataRecord> {
        self.records.iter()
    }

    pub fn is_registered(&self, control_key: &str) -> bool {
        matches!(
            self.signals.get(control_key),
            Some((_, ControlState::Registered))
        )
    }

    pub fn is_released(&self, control_key: &str) -> bool {
        matches!(
            self.signals.get(control_key),
            Some((_, ControlState::Released))
        )
    }

    fn append_record(
        &mut self,
        operation: MetadataOperation,
        signal: ControlSignal,
    ) -> MetadataRecord {
        self.next_sequence += 1;
        let record = MetadataRecord {
            record_id: format!("mc-{}", self.next_sequence),
            control_key: signal.key.clone(),
            operation,
            scope: signal.scope.clone(),
            signal,
            sequence: self.next_sequence,
            timestamp_ms: now_ms(),
        };
        self.records.push(record.clone());
        record
    }
}

/// Immutable owning-boundary audit entry for a failed control->payload write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadLeakRecord {
    pub record_id: String,
    pub control_key: String,
    pub kind: ControlSignalKind,
    pub scope: Scope,
    pub sequence: u64,
    pub timestamp_ms: u128,
}

/// RED-02/03/05: owning-boundary gate between control plane and normal payload.
///
/// `write_control` always fails fast and records the leak attempt; there is no
/// fallback, no silent strip and no compensation path.
#[derive(Debug, Default)]
pub struct PayloadGate {
    leak_attempts: Vec<PayloadLeakRecord>,
    next_sequence: u64,
}

impl PayloadGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn write_control(&mut self, signal: &ControlSignal) -> Result<(), ControlError> {
        self.next_sequence += 1;
        self.leak_attempts.push(PayloadLeakRecord {
            record_id: format!("leak-{}", self.next_sequence),
            control_key: signal.key.clone(),
            kind: signal.kind,
            scope: signal.scope.clone(),
            sequence: self.next_sequence,
            timestamp_ms: now_ms(),
        });
        Err(ControlError::ControlIntoPayload)
    }

    /// Read-only diagnostic query of recorded leak attempts.
    pub fn leak_attempts(&self) -> impl Iterator<Item = &PayloadLeakRecord> {
        self.leak_attempts.iter()
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
