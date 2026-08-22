use std::time::{SystemTime, UNIX_EPOCH};

use routecodex_v4_base_node::Scope;

/// Fixed single-direction error chain stages. Position is contract:
/// `01 -> 02 -> 03 -> 04 -> 05 -> 06`, no reorder, no skip, no reentry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ErrorStage {
    SourceRaised = 1,
    HostCaptured = 2,
    RuntimeClassified = 3,
    RouterPolicyApplied = 4,
    ExecutionDecision = 5,
    ClientProjected = 6,
}

impl ErrorStage {
    pub fn next(self) -> Option<ErrorStage> {
        match self {
            ErrorStage::SourceRaised => Some(ErrorStage::HostCaptured),
            ErrorStage::HostCaptured => Some(ErrorStage::RuntimeClassified),
            ErrorStage::RuntimeClassified => Some(ErrorStage::RouterPolicyApplied),
            ErrorStage::RouterPolicyApplied => Some(ErrorStage::ExecutionDecision),
            ErrorStage::ExecutionDecision => Some(ErrorStage::ClientProjected),
            ErrorStage::ClientProjected => None,
        }
    }
}

/// Immutable typed error fact. It carries only `payload_hash` + `typed_context`;
/// business payload content is never read or retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorFact {
    pub fact_id: String,
    pub stage: ErrorStage,
    pub code: String,
    pub scope: Scope,
    pub payload_hash: Option<String>,
    pub typed_context: Option<String>,
    pub sequence: u64,
    pub timestamp_ms: u128,
}

impl ErrorFact {
    /// RED-04: control/error state must never be reconstructed from payload.
    /// Always fails fast.
    pub fn try_reconstruct_from_payload(
        _payload_hash: &str,
        _scope: Scope,
    ) -> Result<Self, ErrorChainError> {
        Err(ErrorChainError::ControlNotReconstructibleFromPayload)
    }
}

/// Typed passive retry policy contract. Consumed by execution decision only;
/// there is no provider-local retry or cooldown-persistence execution API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryPolicy {
    pub policy_id: String,
    pub provider_scope: String,
    pub matcher: String,
    pub action_class: String,
    pub reason_code: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionAction {
    Retry,
    Cooldown,
    Reroute,
    Terminal,
}

/// Typed execution decision produced by the VR-owned policy application;
/// consumed only by the client projection stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionDecision {
    pub decision_id: String,
    pub action: DecisionAction,
    pub reason_code: String,
}

/// The only error value allowed to reach the client: `code` + `message` only.
/// Internal control fields (scope / stage / hash / category) never appear here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientProjection {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorChainRecord {
    pub record_id: String,
    pub from: Option<ErrorStage>,
    pub to: ErrorStage,
    pub fact_id: String,
    pub code: String,
    pub scope: Scope,
    pub payload_hash: Option<String>,
    pub typed_context: Option<String>,
    pub detail: Option<String>,
    pub sequence: u64,
    pub record_sequence: u64,
    pub timestamp_ms: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCategory {
    Retryable,
    Fatal,
    ClientError,
    Unknown,
}

/// Immutable classify + audit record produced by the ErrorCenter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifyAuditRecord {
    pub record_id: String,
    pub fact_id: String,
    pub category: ErrorCategory,
    pub code: String,
    pub scope: Scope,
    pub payload_hash: Option<String>,
    pub typed_context: Option<String>,
    pub sequence: u64,
    pub timestamp_ms: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorChainError {
    NoActiveFact,
    AlreadyActive,
    AlreadyTerminal,
    NonAdjacentTransition,
    MessageOnlyProjectionForbidden,
    ScopeMismatch,
    AlreadyClassified,
    ControlNotReconstructibleFromPayload,
}

/// Single-direction error chain with fixed adjacent stage transitions.
#[derive(Debug, Clone)]
pub struct ErrorChain {
    scope: Scope,
    fact: Option<ErrorFact>,
    records: Vec<ErrorChainRecord>,
    next_sequence: u64,
}

impl ErrorChain {
    pub fn new(scope: Scope) -> Self {
        Self {
            scope,
            fact: None,
            records: Vec::new(),
            next_sequence: 0,
        }
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    /// `V4Error01SourceRaised`. First operation only; raise twice is red.
    pub fn raise(
        &mut self,
        code: &str,
        payload_hash: Option<&str>,
        typed_context: Option<&str>,
    ) -> Result<ErrorFact, ErrorChainError> {
        if self.is_terminal() {
            return Err(ErrorChainError::AlreadyTerminal);
        }
        if self.fact.is_some() {
            return Err(ErrorChainError::AlreadyActive);
        }
        self.next_sequence += 1;
        let fact = ErrorFact {
            fact_id: format!("err-{}", self.next_sequence),
            stage: ErrorStage::SourceRaised,
            code: code.to_string(),
            scope: self.scope.clone(),
            payload_hash: payload_hash.map(|h| h.to_string()),
            typed_context: typed_context.map(|c| c.to_string()),
            sequence: self.next_sequence,
            timestamp_ms: now_ms(),
        };
        self.append_record(None, fact.clone(), None);
        self.fact = Some(fact.clone());
        Ok(fact)
    }

    /// `01 -> 02`. Only from SourceRaised.
    pub fn capture(&mut self) -> Result<ErrorFact, ErrorChainError> {
        self.transition(ErrorStage::SourceRaised, None)
    }

    /// `02 -> 03`. Only from HostCaptured.
    pub fn classify(&mut self) -> Result<ErrorFact, ErrorChainError> {
        self.transition(ErrorStage::HostCaptured, None)
    }

    /// `03 -> 04`. Only from RuntimeClassified; policy is typed and passive.
    pub fn apply_policy(&mut self, policy: RetryPolicy) -> Result<ErrorFact, ErrorChainError> {
        let detail = Some(policy.policy_id);
        self.transition(ErrorStage::RuntimeClassified, detail)
    }

    /// `04 -> 05`. Only from RouterPolicyApplied; duplicate decision is red.
    pub fn decide(&mut self, decision: ExecutionDecision) -> Result<ErrorFact, ErrorChainError> {
        let detail = Some(format!("{}:{:?}", decision.decision_id, decision.action));
        self.transition(ErrorStage::RouterPolicyApplied, detail)
    }

    /// `05 -> 06` terminal. Message-only projection before ExecutionDecision is red.
    pub fn project(&mut self, message: &str) -> Result<ClientProjection, ErrorChainError> {
        if self.is_terminal() {
            return Err(ErrorChainError::AlreadyTerminal);
        }
        let fact = self.fact.clone().ok_or(ErrorChainError::NoActiveFact)?;
        if fact.stage != ErrorStage::ExecutionDecision {
            return Err(ErrorChainError::MessageOnlyProjectionForbidden);
        }
        let code = fact.code.clone();
        let mut projected = fact;
        projected.stage = ErrorStage::ClientProjected;
        self.append_record(Some(ErrorStage::ExecutionDecision), projected.clone(), None);
        self.fact = Some(projected);
        Ok(ClientProjection {
            code,
            message: message.to_string(),
        })
    }

    /// Read-only diagnostic audit stream; never a live-path input.
    pub fn records(&self) -> impl Iterator<Item = &ErrorChainRecord> {
        self.records.iter()
    }

    pub fn current_stage(&self) -> Option<ErrorStage> {
        self.fact.as_ref().map(|f| f.stage)
    }

    pub fn is_terminal(&self) -> bool {
        self.current_stage() == Some(ErrorStage::ClientProjected)
    }

    fn transition(
        &mut self,
        expected: ErrorStage,
        detail: Option<String>,
    ) -> Result<ErrorFact, ErrorChainError> {
        if self.is_terminal() {
            return Err(ErrorChainError::AlreadyTerminal);
        }
        let fact = self.fact.clone().ok_or(ErrorChainError::NoActiveFact)?;
        if fact.stage != expected {
            return Err(ErrorChainError::NonAdjacentTransition);
        }
        let to = expected
            .next()
            .ok_or(ErrorChainError::NonAdjacentTransition)?;
        let mut advanced = fact;
        advanced.stage = to;
        self.append_record(Some(expected), advanced.clone(), detail);
        self.fact = Some(advanced.clone());
        Ok(advanced)
    }

    fn append_record(&mut self, from: Option<ErrorStage>, fact: ErrorFact, detail: Option<String>) {
        let record_sequence = self.records.len() as u64 + 1;
        self.records.push(ErrorChainRecord {
            record_id: format!("rec-{}-{}", record_sequence, fact.stage as u8),
            from,
            to: fact.stage,
            fact_id: fact.fact_id.clone(),
            code: fact.code.clone(),
            scope: fact.scope.clone(),
            payload_hash: fact.payload_hash.clone(),
            typed_context: fact.typed_context.clone(),
            detail,
            sequence: fact.sequence,
            record_sequence,
            timestamp_ms: fact.timestamp_ms,
        });
    }
}

/// Intake / classify / audit-only error center. It never routes, never retries,
/// never writes payload, and never re-reads business payload.
#[derive(Debug, Clone)]
pub struct ErrorCenter {
    scope: Scope,
    records: Vec<ClassifyAuditRecord>,
    next_sequence: u64,
}

impl ErrorCenter {
    pub fn new(scope: Scope) -> Self {
        Self {
            scope,
            records: Vec::new(),
            next_sequence: 0,
        }
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    /// Classify a typed error fact and append an immutable audit record.
    /// Cross-scope fact and duplicate fact_id are red.
    pub fn classify(&mut self, fact: ErrorFact) -> Result<ClassifyAuditRecord, ErrorChainError> {
        if fact.scope != self.scope {
            return Err(ErrorChainError::ScopeMismatch);
        }
        if self.records.iter().any(|r| r.fact_id == fact.fact_id) {
            return Err(ErrorChainError::AlreadyClassified);
        }
        self.next_sequence += 1;
        let record = ClassifyAuditRecord {
            record_id: format!("ca-{}", self.next_sequence),
            fact_id: fact.fact_id.clone(),
            category: classify_code(&fact.code),
            code: fact.code.clone(),
            scope: fact.scope.clone(),
            payload_hash: fact.payload_hash.clone(),
            typed_context: fact.typed_context.clone(),
            sequence: self.next_sequence,
            timestamp_ms: now_ms(),
        };
        self.records.push(record.clone());
        Ok(record)
    }

    pub fn records(&self) -> impl Iterator<Item = &ClassifyAuditRecord> {
        self.records.iter()
    }

    pub fn audit_count(&self) -> usize {
        self.records.len()
    }
}

fn classify_code(code: &str) -> ErrorCategory {
    match code {
        "timeout" | "rate_limit" | "5xx" => ErrorCategory::Retryable,
        "4xx" | "invalid_request" => ErrorCategory::ClientError,
        "fatal" => ErrorCategory::Fatal,
        _ => ErrorCategory::Unknown,
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
