//! routecodex-v4-server — contract-bound server diagnostic resource owner
//! (`v4.console.terminal_output`, `v4.server.request_identity`,
//! `v4.error.raw_wire_evidence`).
//!
//! Hard boundaries:
//! - console/evidence/identity are diagnostic side-channel projections; they
//!   never become control decisions and never enter provider/client payload;
//! - request identity is a deterministic serverId+localDay+sequence counter;
//! - wire evidence flushes only on terminal failure (EOF/error/drop), never
//!   on success paths.

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsoleLine {
    pub server_id: String,
    pub request_id: String,
    pub entry_protocol: String,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct V4ConsoleTerminalOutput {
    lines: Vec<ConsoleLine>,
}

impl V4ConsoleTerminalOutput {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn write(
        &mut self,
        server_id: &str,
        request_id: &str,
        entry_protocol: &str,
        severity: &str,
        message: &str,
    ) {
        self.lines.push(ConsoleLine {
            server_id: server_id.to_string(),
            request_id: request_id.to_string(),
            entry_protocol: entry_protocol.to_string(),
            severity: severity.to_string(),
            message: message.to_string(),
        });
    }

    pub fn lines(&self) -> impl Iterator<Item = &ConsoleLine> {
        self.lines.iter()
    }
}

/// Console projection facade (diagnostic-only).
#[derive(Debug, Clone, Default)]
pub struct ConsoleProjection {
    output: V4ConsoleTerminalOutput,
}

impl ConsoleProjection {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn write(
        &mut self,
        server_id: &str,
        request_id: &str,
        entry_protocol: &str,
        severity: &str,
        message: &str,
    ) {
        self.output
            .write(server_id, request_id, entry_protocol, severity, message);
    }

    pub fn lines(&self) -> impl Iterator<Item = &ConsoleLine> {
        self.output.lines()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestIdentity {
    pub request_id: String,
    pub server_id: String,
    pub local_day: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestIdentityError {
    EmptyServerId,
    SequenceOverflow,
}

impl std::fmt::Display for RequestIdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for RequestIdentityError {}

/// Deterministic server request identity counter.
#[derive(Debug, Clone, Default)]
pub struct V4RequestIdCounter {
    counters: BTreeMap<(String, String), u64>,
}

impl V4RequestIdCounter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn next_request_identity(
        &mut self,
        server_id: &str,
        local_day: &str,
    ) -> Result<RequestIdentity, RequestIdentityError> {
        if server_id.is_empty() {
            return Err(RequestIdentityError::EmptyServerId);
        }
        let key = (server_id.to_string(), local_day.to_string());
        let next = self.counters.get(&key).copied().unwrap_or(0) + 1;
        if next == 0 {
            return Err(RequestIdentityError::SequenceOverflow);
        }
        self.counters.insert(key, next);
        Ok(RequestIdentity {
            request_id: format!("{server_id}-{local_day}-{next:08}"),
            server_id: server_id.to_string(),
            local_day: local_day.to_string(),
            sequence: next,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireEvidenceRecord {
    pub entry_protocol: String,
    pub endpoint: String,
    pub port: u16,
    pub request_id: String,
    pub artifact_name: String,
    pub wire_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireEvidenceError {
    EmptyRequestId,
}

impl std::fmt::Display for WireEvidenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for WireEvidenceError {}

/// Terminal-failure wire evidence store; flush is allowed only after the
/// server frame reaches EOF/error/drop.
#[derive(Debug, Clone, Default)]
pub struct V4ErrorEvidenceFlushOnTerminalFailure {
    records: Vec<WireEvidenceRecord>,
}

impl V4ErrorEvidenceFlushOnTerminalFailure {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn flush(
        &mut self,
        entry_protocol: &str,
        endpoint: &str,
        port: u16,
        request_id: &str,
        artifact_name: &str,
        wire_bytes: &[u8],
    ) -> Result<WireEvidenceRecord, WireEvidenceError> {
        if request_id.is_empty() {
            return Err(WireEvidenceError::EmptyRequestId);
        }
        let record = WireEvidenceRecord {
            entry_protocol: entry_protocol.to_string(),
            endpoint: endpoint.to_string(),
            port,
            request_id: request_id.to_string(),
            artifact_name: artifact_name.to_string(),
            wire_bytes: wire_bytes.to_vec(),
        };
        self.records.push(record.clone());
        Ok(record)
    }

    pub fn records(&self) -> impl Iterator<Item = &WireEvidenceRecord> {
        self.records.iter()
    }
}
