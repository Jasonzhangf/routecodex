use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum V3LocalContinuationEntryProtocol {
    Responses,
    Anthropic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3LocalContinuationRestoreOwner {
    RouteCodexLocal,
    RemoteProviderDirect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum V3LocalContinuationTerminalOutcome {
    Success,
    Failure,
    NonTerminal,
    AlreadyTerminal,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3LocalContinuationScopeKey {
    entry_protocol: V3LocalContinuationEntryProtocol,
    entry_endpoint: String,
    session_id: String,
    conversation_id: String,
    port: u16,
    routing_group: String,
}

impl V3LocalContinuationScopeKey {
    pub fn responses(
        entry_endpoint: impl Into<String>,
        session_id: impl Into<String>,
        conversation_id: impl Into<String>,
        port: u16,
        routing_group: impl Into<String>,
    ) -> Self {
        Self {
            entry_protocol: V3LocalContinuationEntryProtocol::Responses,
            entry_endpoint: entry_endpoint.into(),
            session_id: session_id.into(),
            conversation_id: conversation_id.into(),
            port,
            routing_group: routing_group.into(),
        }
    }

    pub fn anthropic(
        entry_endpoint: impl Into<String>,
        session_id: impl Into<String>,
        conversation_id: impl Into<String>,
        port: u16,
        routing_group: impl Into<String>,
    ) -> Self {
        Self {
            entry_protocol: V3LocalContinuationEntryProtocol::Anthropic,
            entry_endpoint: entry_endpoint.into(),
            session_id: session_id.into(),
            conversation_id: conversation_id.into(),
            port,
            routing_group: routing_group.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3LocalContinuationImmutableRecord {
    context_id: String,
    scope: V3LocalContinuationScopeKey,
    canonical_context: Value,
    committed_at_epoch_ms: u64,
    expires_at_epoch_ms: u64,
    saved_at_boundary: V3LocalContinuationSaveBoundary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum V3LocalContinuationSaveBoundary {
    Resp04,
}

impl V3LocalContinuationImmutableRecord {
    pub fn context_id(&self) -> &str {
        &self.context_id
    }

    pub fn scope(&self) -> &V3LocalContinuationScopeKey {
        &self.scope
    }

    pub fn canonical_context(&self) -> &Value {
        &self.canonical_context
    }

    pub fn committed_at_epoch_ms(&self) -> u64 {
        self.committed_at_epoch_ms
    }

    pub fn expires_at_epoch_ms(&self) -> u64 {
        self.expires_at_epoch_ms
    }
}

#[derive(Debug)]
pub struct V3LocalContinuationResp04SaveInput {
    context_id: String,
    scope: V3LocalContinuationScopeKey,
    canonical_context: Value,
    terminal_outcome: V3LocalContinuationTerminalOutcome,
    committed_at_epoch_ms: u64,
    expires_at_epoch_ms: u64,
}

impl V3LocalContinuationResp04SaveInput {
    pub fn new(
        context_id: impl Into<String>,
        scope: V3LocalContinuationScopeKey,
        canonical_context: Value,
        terminal_outcome: V3LocalContinuationTerminalOutcome,
        committed_at_epoch_ms: u64,
        expires_at_epoch_ms: u64,
    ) -> Self {
        Self {
            context_id: context_id.into(),
            scope,
            canonical_context,
            terminal_outcome,
            committed_at_epoch_ms,
            expires_at_epoch_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3LocalContinuationReq04RestoreRequest {
    context_id: String,
    scope: V3LocalContinuationScopeKey,
    owner: V3LocalContinuationRestoreOwner,
    now_epoch_ms: u64,
}

impl V3LocalContinuationReq04RestoreRequest {
    pub fn local(
        context_id: impl Into<String>,
        scope: V3LocalContinuationScopeKey,
        now_epoch_ms: u64,
    ) -> Self {
        Self {
            context_id: context_id.into(),
            scope,
            owner: V3LocalContinuationRestoreOwner::RouteCodexLocal,
            now_epoch_ms,
        }
    }

    pub fn with_owner(mut self, owner: V3LocalContinuationRestoreOwner) -> Self {
        self.owner = owner;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3LocalContinuationResp04CommitResult {
    Stored,
    NotStored(V3LocalContinuationTerminalOutcome),
}

#[derive(Debug, PartialEq)]
pub struct V3LocalContinuationReq04Restored<'store> {
    record: &'store V3LocalContinuationImmutableRecord,
}

impl<'store> V3LocalContinuationReq04Restored<'store> {
    pub fn record(&self) -> &'store V3LocalContinuationImmutableRecord {
        self.record
    }

    pub fn canonical_context(&self) -> &'store Value {
        self.record.canonical_context()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3LocalContinuationError {
    #[error("local continuation not found: {context_id}")]
    NotFound { context_id: String },
    #[error("local continuation restore requires RouteCodex-local owner")]
    CrossOwner,
    #[error("local continuation scope mismatch: {context_id}")]
    ScopeMismatch { context_id: String },
    #[error("local continuation expired: {context_id}")]
    Expired { context_id: String },
    #[error("local continuation is already committed: {context_id}")]
    AlreadyCommitted { context_id: String },
    #[error("local continuation expiry must be later than commit time: {context_id}")]
    InvalidExpiry { context_id: String },
    #[error("local continuation codec error: {message}")]
    Codec { message: String },
}

#[derive(Debug, Default)]
pub struct V3LocalContinuationStore {
    records: BTreeMap<String, V3LocalContinuationImmutableRecord>,
}

impl V3LocalContinuationStore {
    pub fn commit_at_resp04(
        &mut self,
        input: V3LocalContinuationResp04SaveInput,
    ) -> Result<V3LocalContinuationResp04CommitResult, V3LocalContinuationError> {
        if input.terminal_outcome != V3LocalContinuationTerminalOutcome::NonTerminal {
            return Ok(V3LocalContinuationResp04CommitResult::NotStored(
                input.terminal_outcome,
            ));
        }
        if input.expires_at_epoch_ms <= input.committed_at_epoch_ms {
            return Err(V3LocalContinuationError::InvalidExpiry {
                context_id: input.context_id,
            });
        }
        if self.records.contains_key(&input.context_id) {
            return Err(V3LocalContinuationError::AlreadyCommitted {
                context_id: input.context_id,
            });
        }
        let record = V3LocalContinuationImmutableRecord {
            context_id: input.context_id,
            scope: input.scope,
            canonical_context: input.canonical_context,
            committed_at_epoch_ms: input.committed_at_epoch_ms,
            expires_at_epoch_ms: input.expires_at_epoch_ms,
            saved_at_boundary: V3LocalContinuationSaveBoundary::Resp04,
        };
        self.records.insert(record.context_id.clone(), record);
        Ok(V3LocalContinuationResp04CommitResult::Stored)
    }

    pub fn restore_at_req04(
        &self,
        request: &V3LocalContinuationReq04RestoreRequest,
    ) -> Result<V3LocalContinuationReq04Restored<'_>, V3LocalContinuationError> {
        if request.owner != V3LocalContinuationRestoreOwner::RouteCodexLocal {
            return Err(V3LocalContinuationError::CrossOwner);
        }
        let record = self.records.get(&request.context_id).ok_or_else(|| {
            V3LocalContinuationError::NotFound {
                context_id: request.context_id.clone(),
            }
        })?;
        if record.scope != request.scope {
            return Err(V3LocalContinuationError::ScopeMismatch {
                context_id: request.context_id.clone(),
            });
        }
        if request.now_epoch_ms >= record.expires_at_epoch_ms {
            return Err(V3LocalContinuationError::Expired {
                context_id: request.context_id.clone(),
            });
        }
        Ok(V3LocalContinuationReq04Restored { record })
    }

    pub fn release(&mut self, context_id: &str) -> bool {
        self.records.remove(context_id).is_some()
    }

    pub fn contains(&self, context_id: &str) -> bool {
        self.records.contains_key(context_id)
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }
}

pub fn encode_v3_local_continuation_immutable_record(
    record: &V3LocalContinuationImmutableRecord,
) -> Result<Vec<u8>, V3LocalContinuationError> {
    serde_json::to_vec(record).map_err(|error| V3LocalContinuationError::Codec {
        message: error.to_string(),
    })
}

pub fn decode_v3_local_continuation_immutable_record(
    encoded: &[u8],
) -> Result<V3LocalContinuationImmutableRecord, V3LocalContinuationError> {
    serde_json::from_slice(encoded).map_err(|error| V3LocalContinuationError::Codec {
        message: error.to_string(),
    })
}
