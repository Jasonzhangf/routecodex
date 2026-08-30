//! Direction-specific Direct mediation container.
//!
//! Client/provider protocol identities are typed information-plane inputs.
//! Business payload is shared and may only be changed by the mounted Direct
//! request or response hook for that direction.

use serde_json::Value;
use std::sync::Arc;

pub type SharedPayload = Arc<Value>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolId(String);

impl ProtocolId {
    pub fn new(value: impl Into<String>) -> Result<Self, DirectRelayError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(DirectRelayError::InvalidProtocol);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionLane {
    Direct,
    Relay,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectRelayInformation {
    lane: ExecutionLane,
    client_protocol: ProtocolId,
    provider_protocol: ProtocolId,
}

impl DirectRelayInformation {
    pub fn direct(
        client_protocol: ProtocolId,
        provider_protocol: ProtocolId,
    ) -> Result<Self, DirectRelayError> {
        if client_protocol != provider_protocol {
            return Err(DirectRelayError::ProtocolMismatch);
        }
        Ok(Self {
            lane: ExecutionLane::Direct,
            client_protocol,
            provider_protocol,
        })
    }

    pub fn lane(&self) -> ExecutionLane {
        self.lane
    }

    pub fn client_protocol(&self) -> &ProtocolId {
        &self.client_protocol
    }

    pub fn provider_protocol(&self) -> &ProtocolId {
        &self.provider_protocol
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectRelayError {
    InvalidProtocol,
    ProtocolMismatch,
    WrongExecutionLane,
    RequestHook(String),
    ResponseHook(String),
}

pub trait DirectRequestHook: Send + Sync {
    fn apply(&self, payload: SharedPayload) -> Result<SharedPayload, DirectRelayError>;
}

pub trait DirectResponseHook: Send + Sync {
    fn apply(&self, payload: SharedPayload) -> Result<SharedPayload, DirectRelayError>;
}

pub struct DirectRelayContainer {
    request_hooks: Vec<Arc<dyn DirectRequestHook>>,
    response_hooks: Vec<Arc<dyn DirectResponseHook>>,
}

impl DirectRelayContainer {
    pub fn new(
        request_hooks: Vec<Arc<dyn DirectRequestHook>>,
        response_hooks: Vec<Arc<dyn DirectResponseHook>>,
    ) -> Self {
        Self {
            request_hooks,
            response_hooks,
        }
    }

    pub fn execute_request(
        &self,
        information: &DirectRelayInformation,
        payload: SharedPayload,
    ) -> Result<SharedPayload, DirectRelayError> {
        Self::validate_information(information)?;
        self.request_hooks
            .iter()
            .try_fold(payload, |current, hook| hook.apply(current))
    }

    pub fn execute_response(
        &self,
        information: &DirectRelayInformation,
        payload: SharedPayload,
    ) -> Result<SharedPayload, DirectRelayError> {
        Self::validate_information(information)?;
        self.response_hooks
            .iter()
            .try_fold(payload, |current, hook| hook.apply(current))
    }

    fn validate_information(
        information: &DirectRelayInformation,
    ) -> Result<(), DirectRelayError> {
        if information.lane != ExecutionLane::Direct {
            return Err(DirectRelayError::WrongExecutionLane);
        }
        if information.client_protocol != information.provider_protocol {
            return Err(DirectRelayError::ProtocolMismatch);
        }
        Ok(())
    }
}
