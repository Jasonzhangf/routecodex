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
