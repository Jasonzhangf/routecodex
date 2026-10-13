//! Corrected client-source Error chain (reviewed graph `v3.operation_runner.error`).
//!
//! The Server submits the real client transport cause and identity; the typed
//! Error owner constructs every fixed node and returns the internal typed
//! outcome. The chain is health-neutral by construction and never authorizes a
//! client error / end / status / notification / `[DONE]` / fabricated success.

use crate::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_internal,
    V3Error01SourceRaised, V3ErrorSourceKind, V3InternalErrorCode,
};
use serde::Serialize;

/// Corrected client-source Error chain identities from the reviewed lifecycle
/// manifest (`error_sequence`). The legacy [`crate::V3_ERROR_CHAIN_NODE_IDS`]
/// names stay the projection identity for every other lane; the client-source
/// lane executes the reviewed six nodes, whose second node is the real typed
/// `HostCaptured` context reader instead of the legacy `Classified` node.
pub const V3_CLIENT_SOURCE_ERROR_CHAIN_NODE_IDS: [&str; 6] = [
    "ErrorErr01SourceRaised",
    "ErrorErr02HostCaptured",
    "ErrorErr03RuntimeClassified",
    "ErrorErr04RouterPolicyApplied",
    "ErrorErr05ExecutionDecision",
    "ErrorErr06ClientProjected",
];

/// The real client transport operation observed by the Server/SSE transport
/// owner. It preserves the write/flush/EOF/reset/read/cancellation/channel-loss
/// distinction the corrected Error chain must carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum V3ClientTransportOperation {
    Write,
    Flush,
    PeerEof,
    PeerReset,
    ReadError,
    Cancellation,
    InternalChannelLoss,
}

impl V3ClientTransportOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Write => "write",
            Self::Flush => "flush",
            Self::PeerEof => "peer_eof",
            Self::PeerReset => "peer_reset",
            Self::ReadError => "read_error",
            Self::Cancellation => "cancellation",
            Self::InternalChannelLoss => "internal_channel_loss",
        }
    }
}

/// Server-submitted client transport failure input.
///
/// The Server is the only owner of the real socket I/O observation; it submits
/// the original operation plus the raw OS cause and the connection / request /
/// attempt identity to the typed Error source API. The Server never constructs a
/// typed Error decision itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ClientTransportFailure {
    pub operation: V3ClientTransportOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub io_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_cause: Option<String>,
    pub connection_id: u64,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
}

/// `ErrorErr02HostCaptured`: the typed request/connection context read by the
/// fixed second node. It reads only the declared typed request/connection
/// resource submitted with the source; a provider/model/key identity never
/// appears on a client or internal-response source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3Error02HostCaptured {
    pub source: V3Error01SourceRaised,
    pub operation: V3ClientTransportOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub io_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_cause: Option<String>,
    pub connection_id: u64,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
}

/// Build `ErrorErr01SourceRaised` from the Server-submitted client transport
/// failure. Socket I/O failures keep the existing `ClientDisconnect` source
/// kind; a committed client body dropped before completion with no captured I/O
/// keeps the distinct `ClientCancellation` origin. Both are health neutral and
/// never mutate provider health.
pub fn build_v3_error_01_source_raised_for_client_transport(
    failure: &V3ClientTransportFailure,
) -> V3Error01SourceRaised {
    let mut message = format!("client transport {} failed", failure.operation.as_str());
    if let Some(cause) = failure.os_cause.as_deref() {
        message.push_str(&format!(": {cause}"));
    }
    match failure.operation {
        V3ClientTransportOperation::InternalChannelLoss => {
            build_v3_error_01_source_raised_internal(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ServerClientTransportBoundary",
                "internal_response_channel_loss",
                message,
                V3InternalErrorCode::V3Server16HttpFrame,
            )
        }
        V3ClientTransportOperation::Write
        | V3ClientTransportOperation::Flush
        | V3ClientTransportOperation::PeerEof
        | V3ClientTransportOperation::PeerReset
        | V3ClientTransportOperation::ReadError => build_v3_error_01_source_raised(
            V3ErrorSourceKind::ClientDisconnect,
            "V3ServerClientTransportBoundary",
            "client_transport_failure",
            message,
        ),
        V3ClientTransportOperation::Cancellation => build_v3_error_01_source_raised(
            V3ErrorSourceKind::ClientCancellation,
            "V3ServerClientTransportBoundary",
            "client_body_cancellation",
            message,
        ),
    }
}

/// Build `ErrorErr02HostCaptured` by reading the typed request/connection
/// context the Server submitted with the client transport failure.
pub fn build_v3_error_02_host_captured_from_client_transport(
    source: V3Error01SourceRaised,
    failure: &V3ClientTransportFailure,
) -> V3Error02HostCaptured {
    V3Error02HostCaptured {
        source,
        operation: failure.operation,
        io_kind: failure.io_kind.clone(),
        os_cause: failure.os_cause.clone(),
        connection_id: failure.connection_id,
        request_id: failure.request_id.clone(),
        attempt_id: failure.attempt_id.clone(),
    }
}
