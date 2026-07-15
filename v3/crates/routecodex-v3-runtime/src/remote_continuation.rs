use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum V3RemoteContinuationEntryProtocol {
    Responses,
    ChatCompletions,
    Messages,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum V3RemoteContinuationOwner {
    Direct,
    Relay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3RemoteProviderAvailability {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3RemoteContinuationScopeKey {
    pub entry_protocol: V3RemoteContinuationEntryProtocol,
    pub entry_endpoint: String,
    pub session_id: String,
    pub conversation_id: String,
    pub port: u16,
    pub routing_group: String,
}

impl V3RemoteContinuationScopeKey {
    pub fn responses(
        entry_endpoint: impl Into<String>,
        session_id: impl Into<String>,
        conversation_id: impl Into<String>,
        port: u16,
        routing_group: impl Into<String>,
    ) -> Self {
        Self {
            entry_protocol: V3RemoteContinuationEntryProtocol::Responses,
            entry_endpoint: entry_endpoint.into(),
            session_id: session_id.into(),
            conversation_id: conversation_id.into(),
            port,
            routing_group: routing_group.into(),
        }
    }

    pub fn with_entry_protocol(mut self, protocol: V3RemoteContinuationEntryProtocol) -> Self {
        self.entry_protocol = protocol;
        self
    }

    pub fn with_port_group(mut self, port: u16, routing_group: impl Into<String>) -> Self {
        self.port = port;
        self.routing_group = routing_group.into();
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3RemoteContinuationPin {
    pub provider_id: String,
    pub model_id: String,
    pub auth_handle_id: String,
}

impl V3RemoteContinuationPin {
    pub fn new(
        provider_id: impl Into<String>,
        model_id: impl Into<String>,
        auth_handle_id: impl Into<String>,
    ) -> Self {
        Self {
            provider_id: provider_id.into(),
            model_id: model_id.into(),
            auth_handle_id: auth_handle_id.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3RemoteContinuationLocator {
    remote_response_id: String,
    owner: V3RemoteContinuationOwner,
    scope_key: V3RemoteContinuationScopeKey,
    pin: V3RemoteContinuationPin,
    capability_revision: String,
    committed_at_epoch_ms: u64,
    expires_at_epoch_ms: u64,
}

impl V3RemoteContinuationLocator {
    pub fn new_direct(
        remote_response_id: impl Into<String>,
        scope_key: V3RemoteContinuationScopeKey,
        pin: V3RemoteContinuationPin,
        capability_revision: impl Into<String>,
        committed_at_epoch_ms: u64,
        expires_at_epoch_ms: u64,
    ) -> Self {
        Self {
            remote_response_id: remote_response_id.into(),
            owner: V3RemoteContinuationOwner::Direct,
            scope_key,
            pin,
            capability_revision: capability_revision.into(),
            committed_at_epoch_ms,
            expires_at_epoch_ms,
        }
    }

    pub fn is_expired_at(&self, now_epoch_ms: u64) -> bool {
        now_epoch_ms >= self.expires_at_epoch_ms
    }

    pub fn remote_response_id(&self) -> &str {
        &self.remote_response_id
    }

    pub fn owner(&self) -> V3RemoteContinuationOwner {
        self.owner
    }

    pub fn scope_key(&self) -> &V3RemoteContinuationScopeKey {
        &self.scope_key
    }

    pub fn pin(&self) -> &V3RemoteContinuationPin {
        &self.pin
    }

    pub fn capability_revision(&self) -> &str {
        &self.capability_revision
    }

    pub fn committed_at_epoch_ms(&self) -> u64 {
        self.committed_at_epoch_ms
    }

    pub fn expires_at_epoch_ms(&self) -> u64 {
        self.expires_at_epoch_ms
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RemoteContinuationLoadRequest {
    pub remote_response_id: String,
    pub owner: V3RemoteContinuationOwner,
    pub scope_key: V3RemoteContinuationScopeKey,
    pub pin: V3RemoteContinuationPin,
    pub provider_availability: V3RemoteProviderAvailability,
    pub now_epoch_ms: u64,
}

impl V3RemoteContinuationLoadRequest {
    pub fn direct(
        remote_response_id: impl Into<String>,
        scope_key: V3RemoteContinuationScopeKey,
        pin: V3RemoteContinuationPin,
        provider_availability: V3RemoteProviderAvailability,
        now_epoch_ms: u64,
    ) -> Self {
        Self {
            remote_response_id: remote_response_id.into(),
            owner: V3RemoteContinuationOwner::Direct,
            scope_key,
            pin,
            provider_availability,
            now_epoch_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RemoteContinuationCommitInput {
    pub locator: V3RemoteContinuationLocator,
}

impl V3RemoteContinuationCommitInput {
    pub fn locator_only(locator: V3RemoteContinuationLocator) -> Self {
        Self { locator }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3RemoteContinuationError {
    #[error("remote continuation not found: {remote_response_id}")]
    NotFound { remote_response_id: String },
    #[error("remote continuation owner mismatch: expected direct owner")]
    OwnerMismatch,
    #[error("remote continuation entry protocol mismatch: locator is Responses-only")]
    EntryProtocolMismatch,
    #[error("remote continuation scope mismatch: {remote_response_id}")]
    ScopeMismatch { remote_response_id: String },
    #[error("remote continuation provider/model/auth pin mismatch: {remote_response_id}")]
    PinMismatch { remote_response_id: String },
    #[error("remote continuation expired: {remote_response_id}")]
    Expired { remote_response_id: String },
    #[error("remote continuation provider unavailable: {provider_id}/{model_id}")]
    ProviderUnavailable {
        provider_id: String,
        model_id: String,
    },
    #[error("remote continuation expiry must be later than commit time: {remote_response_id}")]
    InvalidExpiry { remote_response_id: String },
    #[error("remote continuation is already committed: {remote_response_id}")]
    AlreadyCommitted { remote_response_id: String },
    #[error("remote continuation codec error: {message}")]
    Codec { message: String },
}

#[derive(Debug, Default)]
pub struct V3RemoteContinuationStore {
    locators: BTreeMap<String, V3RemoteContinuationLocator>,
}

impl V3RemoteContinuationStore {
    pub fn commit(
        &mut self,
        input: V3RemoteContinuationCommitInput,
    ) -> Result<(), V3RemoteContinuationError> {
        if input.locator.owner != V3RemoteContinuationOwner::Direct {
            return Err(V3RemoteContinuationError::OwnerMismatch);
        }
        if input.locator.scope_key.entry_protocol != V3RemoteContinuationEntryProtocol::Responses {
            return Err(V3RemoteContinuationError::EntryProtocolMismatch);
        }
        if input.locator.expires_at_epoch_ms <= input.locator.committed_at_epoch_ms {
            return Err(V3RemoteContinuationError::InvalidExpiry {
                remote_response_id: input.locator.remote_response_id,
            });
        }
        if self
            .locators
            .contains_key(&input.locator.remote_response_id)
        {
            return Err(V3RemoteContinuationError::AlreadyCommitted {
                remote_response_id: input.locator.remote_response_id,
            });
        }
        self.locators
            .insert(input.locator.remote_response_id.clone(), input.locator);
        Ok(())
    }

    pub fn load(
        &self,
        request: &V3RemoteContinuationLoadRequest,
    ) -> Result<&V3RemoteContinuationLocator, V3RemoteContinuationError> {
        if request.owner != V3RemoteContinuationOwner::Direct {
            return Err(V3RemoteContinuationError::OwnerMismatch);
        }
        if request.scope_key.entry_protocol != V3RemoteContinuationEntryProtocol::Responses {
            return Err(V3RemoteContinuationError::EntryProtocolMismatch);
        }
        let locator = self
            .locators
            .get(&request.remote_response_id)
            .ok_or_else(|| V3RemoteContinuationError::NotFound {
                remote_response_id: request.remote_response_id.clone(),
            })?;
        if locator.owner != V3RemoteContinuationOwner::Direct {
            return Err(V3RemoteContinuationError::OwnerMismatch);
        }
        if locator.scope_key.entry_protocol != request.scope_key.entry_protocol {
            return Err(V3RemoteContinuationError::EntryProtocolMismatch);
        }
        if locator.scope_key != request.scope_key {
            return Err(V3RemoteContinuationError::ScopeMismatch {
                remote_response_id: request.remote_response_id.clone(),
            });
        }
        if locator.pin != request.pin {
            return Err(V3RemoteContinuationError::PinMismatch {
                remote_response_id: request.remote_response_id.clone(),
            });
        }
        if locator.is_expired_at(request.now_epoch_ms) {
            return Err(V3RemoteContinuationError::Expired {
                remote_response_id: request.remote_response_id.clone(),
            });
        }
        if request.provider_availability == V3RemoteProviderAvailability::Unavailable {
            return Err(V3RemoteContinuationError::ProviderUnavailable {
                provider_id: locator.pin.provider_id.clone(),
                model_id: locator.pin.model_id.clone(),
            });
        }
        Ok(locator)
    }

    pub fn release(&mut self, remote_response_id: &str) -> bool {
        self.locators.remove(remote_response_id).is_some()
    }

    pub fn len(&self) -> usize {
        self.locators.len()
    }

    pub fn is_empty(&self) -> bool {
        self.locators.is_empty()
    }
}

pub fn encode_v3_remote_continuation_locator(
    locator: &V3RemoteContinuationLocator,
) -> Result<String, V3RemoteContinuationError> {
    serde_json::to_string(locator).map_err(|err| V3RemoteContinuationError::Codec {
        message: err.to_string(),
    })
}

pub fn decode_v3_remote_continuation_locator(
    encoded: &str,
) -> Result<V3RemoteContinuationLocator, V3RemoteContinuationError> {
    serde_json::from_str(encoded).map_err(|err| V3RemoteContinuationError::Codec {
        message: err.to_string(),
    })
}
