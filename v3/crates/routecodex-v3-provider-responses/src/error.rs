use crate::raw_response::V3ProviderResponseHeader;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderHttpFailure {
    pub request_id: String,
    pub provider_id: String,
    pub status: u16,
    pub headers: Vec<V3ProviderResponseHeader>,
    pub body: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum V3ProviderError {
    #[error("Responses wire body for request {request_id} must be a JSON object")]
    InvalidWireBody { request_id: String },
    #[error("Responses stream flag for request {request_id} must be boolean")]
    InvalidStreamIntent { request_id: String },
    #[error("provider {provider_id} has an invalid Responses base URL for request {request_id}: {reason}")]
    InvalidBaseUrl {
        request_id: String,
        provider_id: String,
        reason: String,
    },
    #[error(
        "provider {provider_id} auth handle {auth_alias} has no secret for request {request_id}"
    )]
    MissingAuthSecret {
        request_id: String,
        provider_id: String,
        auth_alias: String,
    },
    #[error("provider {provider_id} auth handle {auth_alias} could not be read for request {request_id}: {reason}")]
    AuthSecretRead {
        request_id: String,
        provider_id: String,
        auth_alias: String,
        reason: String,
    },
    #[error("provider {provider_id} transport failed for request {request_id}: {reason}")]
    Transport {
        request_id: String,
        provider_id: String,
        reason: String,
    },
    #[error(
        "provider {provider_id} WebSocket transport failed for request {request_id}: {reason}"
    )]
    WebSocketTransport {
        request_id: String,
        provider_id: String,
        reason: String,
    },
    #[error("provider {provider_id} WebSocket protocol failed for request {request_id}: {reason}")]
    WebSocketProtocol {
        request_id: String,
        provider_id: String,
        reason: String,
    },
    #[error("provider {provider_id} WebSocket event failed for request {request_id} with status {status:?} code {code:?}: {message}")]
    WebSocketProviderEvent {
        request_id: String,
        provider_id: String,
        status: Option<u16>,
        code: Option<String>,
        message: String,
    },
    #[error("provider returned HTTP {status}", status = .response.status)]
    HttpStatus {
        response: Box<V3ProviderHttpFailure>,
    },
    #[error("provider {provider_id} returned content-type {content_type:?} for {expected} request {request_id}")]
    UnexpectedContentType {
        request_id: String,
        provider_id: String,
        expected: &'static str,
        content_type: Option<String>,
    },
    #[error("provider {provider_id} response body failed for request {request_id}: {reason}")]
    ResponseBody {
        request_id: String,
        provider_id: String,
        reason: String,
    },
    #[error("provider {provider_id} returned malformed SSE for request {request_id}: {reason}")]
    MalformedSse {
        request_id: String,
        provider_id: String,
        reason: String,
    },
    #[error("client disconnected during provider request {request_id} for {provider_id}")]
    ClientDisconnect {
        request_id: String,
        provider_id: String,
    },
}
