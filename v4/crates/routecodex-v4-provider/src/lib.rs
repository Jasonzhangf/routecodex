//! routecodex-v4-provider — contract-bound provider availability resource
//! owner (`v4.control.availability`, V4Availability01SessionScoped).
//!
//! Hard boundaries:
//! - availability is session-scoped; process-global cooldown truth is
//!   forbidden;
//! - the router may read availability but never writes it; failures are
//!   recorded by the provider runtime owner only;
//! - availability never enters provider/client payload.

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Read;
use std::pin::Pin;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ProviderFile {
    #[serde(rename = "providerId")]
    provider_id: String,
    provider: ProviderSection,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ProviderSection {
    #[serde(rename = "baseURL")]
    base_url: String,
    #[serde(rename = "defaultModel")]
    default_model: String,
    #[serde(rename = "type")]
    protocol: String,
    #[serde(default)]
    models: BTreeMap<String, ModelSection>,
    #[serde(
        rename = "responsesContinuation",
        default = "default_responses_continuation"
    )]
    responses_continuation: String,
    auth: AuthSection,
}

fn default_responses_continuation() -> String {
    "direct".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ModelSection {
    #[serde(rename = "wireName")]
    wire_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct AuthSection {
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
    env: Option<String>,
    #[serde(default)]
    entries: Vec<AuthEntry>,
    #[serde(rename = "secretFile")]
    secret_file: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct AuthEntry {
    alias: Option<String>,
    #[serde(rename = "tokenFile")]
    token_file: Option<String>,
    #[serde(rename = "secretFile")]
    secret_file: Option<String>,
    #[serde(rename = "secretKey")]
    secret_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderModel {
    pub id: String,
    pub wire_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderProfile {
    pub provider_id: String,
    pub base_url: String,
    pub default_model: String,
    pub protocol: String,
    pub responses_continuation: String,
    pub models: Vec<ProviderModel>,
    auth: ProviderAuthHandle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProviderAuthHandle {
    TokenFile {
        path: String,
        alias: Option<String>,
    },
    Env {
        name: String,
    },
    SecretFile {
        path: String,
        key: String,
        alias: Option<String>,
    },
    ConfigInline {
        config_path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRawResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

const NATIVE_MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const NATIVE_MAX_CHUNK_BYTES: usize = 64 * 1024;

/// Async provider transport owner. It owns HTTP connection pooling and wire
/// bytes only; routing, retry, continuation, and client projection remain
/// typed runtime side-channel concerns.
#[derive(Clone)]
pub struct NativeProviderTransport {
    client: reqwest::Client,
    deadline: Duration,
    max_buffer_bytes: usize,
}

impl NativeProviderTransport {
    pub fn new(
        deadline: Duration,
        max_buffer_bytes: usize,
    ) -> Result<Self, ProviderTransportError> {
        if deadline.is_zero() {
            return Err(ProviderTransportError {
                code: "provider_deadline_invalid".into(),
                message: "deadline must be positive".into(),
                status: None,
            });
        }
        if max_buffer_bytes == 0 || max_buffer_bytes > NATIVE_MAX_RESPONSE_BYTES {
            return Err(ProviderTransportError {
                code: "provider_buffer_limit_invalid".into(),
                message: format!("buffer must be 1..={NATIVE_MAX_RESPONSE_BYTES} bytes"),
                status: None,
            });
        }
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(16)
            .build()
            .map_err(|error| ProviderTransportError {
                code: "provider_client_build".into(),
                message: error.to_string(),
                status: None,
            })?;
        Ok(Self {
            client,
            deadline,
            max_buffer_bytes,
        })
    }

    pub async fn send_json(
        &self,
        profile_path: &str,
        endpoint_suffix: &str,
        input: &Value,
        cancellation: CancellationToken,
    ) -> Result<ProviderRawResponse, ProviderTransportError> {
        if input.get("metadata").is_some() {
            return Err(ProviderTransportError {
                code: "provider_control_payload_leak".into(),
                message: "internal metadata cannot enter provider wire payload".into(),
                status: None,
            });
        }
        let profile = load_profile(profile_path)?;
        let key = materialize_auth(&profile.auth)?;
        let body = serde_json::to_vec(input).map_err(|error| ProviderTransportError {
            code: "provider_request_encode".into(),
            message: error.to_string(),
            status: None,
        })?;
        let response = self
            .send_request(&profile, endpoint_suffix, key, body, cancellation.clone())
            .await?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let bytes = self
            .read_bounded_body(response, status, cancellation)
            .await?;
        Ok(ProviderRawResponse {
            status,
            content_type,
            body: bytes,
        })
    }

    pub async fn send_streaming(
        &self,
        profile_path: &str,
        endpoint_suffix: &str,
        input: &Value,
        cancellation: CancellationToken,
    ) -> Result<NativeProviderResponseStream, ProviderTransportError> {
        if input.get("metadata").is_some() {
            return Err(ProviderTransportError {
                code: "provider_control_payload_leak".into(),
                message: "internal metadata cannot enter provider wire payload".into(),
                status: None,
            });
        }
        let profile = load_profile(profile_path)?;
        let key = materialize_auth(&profile.auth)?;
        let body = serde_json::to_vec(input).map_err(|error| ProviderTransportError {
            code: "provider_request_encode".into(),
            message: error.to_string(),
            status: None,
        })?;
        let response = self
            .send_request(&profile, endpoint_suffix, key, body, cancellation.clone())
            .await?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        Ok(NativeProviderResponseStream {
            body: Box::pin(response.bytes_stream()),
            pending: Bytes::new(),
            seen: 0,
            max_buffer_bytes: self.max_buffer_bytes,
            deadline: Instant::now() + self.deadline,
            cancellation,
            status,
            content_type,
        })
    }

    async fn send_request(
        &self,
        profile: &ProviderProfile,
        endpoint_suffix: &str,
        key: String,
        body: Vec<u8>,
        cancellation: CancellationToken,
    ) -> Result<reqwest::Response, ProviderTransportError> {
        let endpoint = format!(
            "{}/{}",
            profile.base_url.trim_end_matches('/'),
            endpoint_suffix.trim_start_matches('/')
        );
        let mut request = self
            .client
            .post(endpoint)
            .header(reqwest::header::CONTENT_TYPE, "application/json");
        request = if profile.protocol == "anthropic" {
            request
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
        } else {
            request.bearer_auth(key)
        };
        tokio::time::timeout(self.deadline, async { tokio::select! { _ = cancellation.cancelled() => Err(ProviderTransportError { code: "provider_transport_cancelled".into(), message: "provider request cancelled".into(), status: None }), result = request.body(body).send() => result.map_err(|error| ProviderTransportError { code: "provider_transport_send".into(), message: error.to_string(), status: None }) } }).await.map_err(|_| ProviderTransportError { code: "provider_deadline_exceeded".into(), message: "provider request deadline exceeded".into(), status: None })?
    }

    async fn read_bounded_body(
        &self,
        response: reqwest::Response,
        status: u16,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, ProviderTransportError> {
        let deadline = Instant::now() + self.deadline;
        let mut body = response.bytes_stream();
        let mut output = Vec::new();
        loop {
            let item = tokio::time::timeout_at(deadline.into(), async {
                tokio::select! {
                    _ = cancellation.cancelled() => Err(ProviderTransportError {
                        code: "provider_transport_cancelled".into(),
                        message: "provider response read cancelled".into(),
                        status: Some(status),
                    }),
                    item = body.next() => Ok(item),
                }
            })
            .await
            .map_err(|_| ProviderTransportError {
                code: "provider_deadline_exceeded".into(),
                message: "provider response deadline exceeded".into(),
                status: Some(status),
            })??;
            let Some(item) = item else { break };
            let bytes = item.map_err(|error| ProviderTransportError {
                code: "provider_response_read".into(),
                message: error.to_string(),
                status: Some(status),
            })?;
            if output.len().saturating_add(bytes.len()) > self.max_buffer_bytes {
                return Err(ProviderTransportError {
                    code: "provider_response_buffer_limit".into(),
                    message: "provider response exceeded bounded buffer".into(),
                    status: Some(status),
                });
            }
            output.extend_from_slice(&bytes);
        }
        Ok(output)
    }
}

pub struct NativeProviderResponseStream {
    body: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
    pending: Bytes,
    seen: usize,
    max_buffer_bytes: usize,
    deadline: Instant,
    cancellation: CancellationToken,
    status: u16,
    content_type: String,
}

impl NativeProviderResponseStream {
    pub fn status(&self) -> u16 {
        self.status
    }
    pub fn content_type(&self) -> &str {
        &self.content_type
    }

    pub async fn next_chunk(&mut self) -> Result<Option<Bytes>, ProviderTransportError> {
        if !self.pending.is_empty() {
            return Ok(Some(std::mem::take(&mut self.pending)));
        }
        if Instant::now() >= self.deadline {
            return Err(ProviderTransportError {
                code: "provider_deadline_exceeded".into(),
                message: "provider stream deadline exceeded".into(),
                status: Some(self.status),
            });
        }
        let next = tokio::time::timeout_at(self.deadline.into(), async {
            tokio::select! {
                _ = self.cancellation.cancelled() => Err(ProviderTransportError { code: "provider_transport_cancelled".into(), message: "provider stream cancelled".into(), status: Some(self.status) }),
                item = self.body.next() => Ok(item),
            }
        }).await.map_err(|_| ProviderTransportError { code: "provider_deadline_exceeded".into(), message: "provider stream deadline exceeded".into(), status: Some(self.status) })??;
        let Some(item) = next else {
            return Ok(None);
        };
        let bytes = item.map_err(|error| ProviderTransportError {
            code: "provider_response_read".into(),
            message: error.to_string(),
            status: Some(self.status),
        })?;
        self.seen = self.seen.saturating_add(bytes.len());
        if self.seen > self.max_buffer_bytes {
            return Err(ProviderTransportError {
                code: "provider_response_buffer_limit".into(),
                message: "provider stream exceeded bounded buffer".into(),
                status: Some(self.status),
            });
        }
        let split_at = bytes.len().min(NATIVE_MAX_CHUNK_BYTES);
        let mut bytes = bytes;
        let remainder = bytes.split_off(split_at);
        self.pending = remainder;
        Ok(Some(bytes))
    }
}

pub const PROVIDER_BOUND_RAW_EVIDENCE_OWNER: &str =
    "routecodex-v4-provider::ProviderBoundRawEvidence";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderBoundRawEvidence {
    pub request_id: String,
    pub provider_request: Vec<u8>,
    pub provider_response: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderBoundRawEvidenceBindingError {
    MissingOwner,
    InvalidOwner { owner: String },
    MissingRequestId,
    MissingProviderRequest,
    MissingProviderResponse,
}

/// Contract-only binding point for future live provider capture.
///
/// M00 may validate ownership and identity only. M08 supplies transport bytes
/// and decides when a capture is made; no transport, retry, or payload logic
/// belongs here.
pub struct ProviderBoundRawEvidenceOwnerContract;

impl ProviderBoundRawEvidenceOwnerContract {
    pub fn bind(
        owner: &str,
        request_id: &str,
        provider_request: &[u8],
        provider_response: &[u8],
    ) -> Result<ProviderBoundRawEvidence, ProviderBoundRawEvidenceBindingError> {
        if owner.trim().is_empty() {
            return Err(ProviderBoundRawEvidenceBindingError::MissingOwner);
        }
        if owner != PROVIDER_BOUND_RAW_EVIDENCE_OWNER {
            return Err(ProviderBoundRawEvidenceBindingError::InvalidOwner {
                owner: owner.to_string(),
            });
        }
        if request_id.trim().is_empty() {
            return Err(ProviderBoundRawEvidenceBindingError::MissingRequestId);
        }
        if provider_request.is_empty() {
            return Err(ProviderBoundRawEvidenceBindingError::MissingProviderRequest);
        }
        if provider_response.is_empty() {
            return Err(ProviderBoundRawEvidenceBindingError::MissingProviderResponse);
        }
        Ok(ProviderBoundRawEvidence {
            request_id: request_id.to_string(),
            provider_request: provider_request.to_vec(),
            provider_response: provider_response.to_vec(),
        })
    }
}

/// Provider-owned real transport stream. The runtime owns semantic frame
/// validation and the server owns client chunk emission.
#[derive(Debug)]
pub struct ProviderResponseStream {
    response: reqwest::blocking::Response,
    buffer: Vec<u8>,
    status: u16,
    content_type: String,
    protocol: String,
}

impl ProviderResponseStream {
    pub fn status(&self) -> u16 {
        self.status
    }

    pub fn content_type(&self) -> &str {
        &self.content_type
    }

    pub fn protocol(&self) -> &str {
        &self.protocol
    }

    pub fn read_chunk(&mut self, chunk: &mut [u8]) -> Result<usize, ProviderTransportError> {
        if !self.buffer.is_empty() {
            let count = self.buffer.len().min(chunk.len());
            chunk[..count].copy_from_slice(&self.buffer[..count]);
            self.buffer.drain(..count);
            return Ok(count);
        }
        self.response
            .read(chunk)
            .map_err(|error| ProviderTransportError {
                code: "provider_stream_read".to_string(),
                message: error.to_string(),
                status: None,
            })
    }

    pub fn wait(&mut self) -> Result<(), ProviderTransportError> {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderTransportError {
    pub code: String,
    pub message: String,
    pub status: Option<u16>,
}

impl std::fmt::Display for ProviderTransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ProviderTransportError {}

pub fn load_profile(path: &str) -> Result<ProviderProfile, ProviderTransportError> {
    let raw = std::fs::read_to_string(path).map_err(|error| ProviderTransportError {
        code: "provider_config_read".to_string(),
        message: format!("{path}: {error}"),
        status: None,
    })?;
    let file: ProviderFile = toml::from_str(&raw).map_err(|error| ProviderTransportError {
        code: "provider_config_parse".to_string(),
        message: error.to_string(),
        status: None,
    })?;
    let auth = if let Some(entry) = file.provider.auth.entries.first() {
        match (&entry.token_file, &entry.secret_file, &entry.secret_key) {
            (Some(path), None, None) => ProviderAuthHandle::TokenFile {
                path: path.clone(),
                alias: entry.alias.clone(),
            },
            (None, Some(path), Some(key)) if !key.trim().is_empty() => {
                ProviderAuthHandle::SecretFile {
                    path: path.clone(),
                    key: key.clone(),
                    alias: entry.alias.clone(),
                }
            }
            _ => {
                return Err(ProviderTransportError {
                    code: "provider_auth_handle_invalid".to_string(),
                    message: "auth entry requires exactly tokenFile, or secretFile plus secretKey"
                        .to_string(),
                    status: None,
                })
            }
        }
    } else if let Some(path) = &file.provider.auth.secret_file {
        ProviderAuthHandle::SecretFile {
            path: path.clone(),
            key: format!("{}.key1", file.provider_id),
            alias: Some("key1".to_string()),
        }
    } else if !file
        .provider
        .auth
        .env
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        ProviderAuthHandle::Env {
            name: file.provider.auth.env.clone().expect("checked non-empty"),
        }
    } else if !file
        .provider
        .auth
        .api_key
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        ProviderAuthHandle::ConfigInline {
            config_path: path.to_string(),
        }
    } else {
        return Err(ProviderTransportError {
            code: "provider_auth_missing".to_string(),
            message: "provider auth has no token handle".to_string(),
            status: None,
        });
    };
    let models = file
        .provider
        .models
        .into_iter()
        .map(|(id, model)| ProviderModel {
            wire_name: model.wire_name.unwrap_or_else(|| id.clone()),
            id,
        })
        .collect();
    Ok(ProviderProfile {
        provider_id: file.provider_id,
        base_url: file.provider.base_url,
        default_model: file.provider.default_model,
        protocol: file.provider.protocol,
        // V4 has no local continuation owner. Provider profiles may carry the
        // retired V3 hint, but runtime semantics are always provider-owned
        // Direct and never inferred from that legacy field.
        responses_continuation: "direct".to_string(),
        models,
        auth,
    })
}

/// Validate that the compiled product auth identity is present in the
/// provider-owned profile before transport materializes any secret.  The
/// alias is control-plane state and never enters a provider/client payload.
pub fn validate_auth_alias(
    profile_path: &str,
    expected_alias: Option<&str>,
) -> Result<(), ProviderTransportError> {
    let profile = load_profile(profile_path)?;
    let actual_alias = match &profile.auth {
        ProviderAuthHandle::TokenFile { alias, .. }
        | ProviderAuthHandle::SecretFile { alias, .. } => alias.as_deref(),
        ProviderAuthHandle::Env { .. } | ProviderAuthHandle::ConfigInline { .. } => None,
    };
    if expected_alias.is_some() && actual_alias != expected_alias {
        return Err(ProviderTransportError {
            code: "provider_auth_alias_mismatch".to_string(),
            message: format!(
                "compiled auth alias {:?} does not match provider profile alias {:?}",
                expected_alias, actual_alias
            ),
            status: None,
        });
    }
    Ok(())
}

fn send_wire_request(
    profile_path: &str,
    input: &Value,
    protocol: &str,
    endpoint_suffix: &str,
) -> Result<ProviderRawResponse, ProviderTransportError> {
    let profile = load_profile(profile_path)?;
    if profile.protocol != protocol {
        return Err(ProviderTransportError {
            code: "provider_protocol_mismatch".to_string(),
            message: format!(
                "profile protocol {} does not match {protocol}",
                profile.protocol
            ),
            status: None,
        });
    }
    let payload = serde_json::to_vec(input).map_err(|error| ProviderTransportError {
        code: "provider_request_encode".to_string(),
        message: error.to_string(),
        status: None,
    })?;
    let key = materialize_auth(&profile.auth)?;
    let endpoint = format!(
        "{}/{}",
        profile.base_url.trim_end_matches('/'),
        endpoint_suffix
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| ProviderTransportError {
            code: "provider_client_build".into(),
            message: error.to_string(),
            status: None,
        })?;
    let mut request = client
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    request = if protocol == "anthropic" {
        request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
    } else {
        request.bearer_auth(key)
    };
    let response = request
        .body(payload)
        .send()
        .map_err(|error| ProviderTransportError {
            code: "provider_transport_send".into(),
            message: error.to_string(),
            status: None,
        })?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = response.bytes().map_err(|error| ProviderTransportError {
        code: "provider_response_read".into(),
        message: error.to_string(),
        status: Some(status),
    })?;
    Ok(ProviderRawResponse {
        status,
        content_type,
        body: body.to_vec(),
    })
}

/// Provider-owned transport dispatch. Runtime orchestration passes the typed
/// protocol selection; protocol-specific endpoint and auth behavior remains
/// entirely in this crate.
pub fn send_protocol(
    protocol: &str,
    profile_path: &str,
    input: &Value,
    stream: bool,
) -> Result<ProviderTransportResult, ProviderTransportError> {
    match (protocol, stream) {
        // Wire shaping belongs to the request NodePluginPlan. The transport
        // owner sends that already-built body byte-for-byte; it must not
        // inject model/stream fields or perform protocol projection here.
        ("responses", false) => send_wire_request(profile_path, input, "responses", "responses")
            .map(ProviderTransportResult::Response),
        ("responses", true) => {
            send_wire_streaming(profile_path, input, "responses", "responses")
                .map(ProviderTransportResult::Stream)
        }
        ("openai" | "chat", false) => send_wire_request(profile_path, input, "openai", "chat/completions")
            .map(ProviderTransportResult::Response),
        ("anthropic", false) => send_wire_request(profile_path, input, "anthropic", "messages")
            .map(ProviderTransportResult::Response),
        ("openai" | "chat", true) => send_wire_streaming(profile_path, input, "openai", "chat/completions")
            .map(ProviderTransportResult::Stream),
        ("anthropic", true) => send_wire_streaming(profile_path, input, "anthropic", "messages")
            .map(ProviderTransportResult::Stream),
        (other, _) => Err(ProviderTransportError {
            code: "provider_protocol_unsupported".to_string(),
            message: format!("provider protocol {other} has no transport owner"),
            status: None,
        }),
    }
}

#[derive(Debug)]
pub enum ProviderTransportResult {
    Response(ProviderRawResponse),
    Stream(ProviderResponseStream),
}

/// Typed provider transport request.  Only provider wire data crosses this
/// boundary; routing and lifecycle controls remain in the runtime side
/// channel.  The request owns its values so a transport execution cannot
/// retain references into runtime orchestration state.
#[derive(Debug)]
pub struct ProviderTransportRequest {
    pub protocol: String,
    pub profile_path: String,
    pub auth_alias: Option<String>,
    pub wire_model: String,
    pub wire_body: Value,
    pub stream: bool,
}

impl ProviderTransportRequest {
    pub fn new(
        protocol: &str,
        profile_path: &str,
        auth_alias: Option<&str>,
        wire_model: &str,
        wire_body: Value,
        stream: bool,
    ) -> Result<Self, ProviderTransportError> {
        if protocol.trim().is_empty() {
            return Err(ProviderTransportError {
                code: "provider_protocol_missing".to_string(),
                message: "provider protocol is required".to_string(),
                status: None,
            });
        }
        if profile_path.trim().is_empty() {
            return Err(ProviderTransportError {
                code: "provider_config_missing".to_string(),
                message: "provider profile path is required".to_string(),
                status: None,
            });
        }
        if wire_model.trim().is_empty() {
            return Err(ProviderTransportError {
                code: "provider_model_missing".to_string(),
                message: "provider wire model is required".to_string(),
                status: None,
            });
        }
        if !wire_body.is_object() {
            return Err(ProviderTransportError {
                code: "provider_request_invalid".to_string(),
                message: "provider wire body must be a JSON object".to_string(),
                status: None,
            });
        }
        if wire_body.get("metadata").is_some() {
            return Err(ProviderTransportError {
                code: "provider_control_payload_leak".to_string(),
                message: "internal metadata cannot enter provider typed boundary".to_string(),
                status: None,
            });
        }
        Ok(Self {
            protocol: protocol.to_string(),
            profile_path: profile_path.to_string(),
            auth_alias: auth_alias.map(str::to_string),
            wire_model: wire_model.to_string(),
            wire_body,
            stream,
        })
    }
}

/// Sole provider transport port used by production runtime orchestration.
/// Protocol support is checked before profile/auth I/O so an invalid
/// protocol cannot accidentally expose configuration details.
pub struct ProviderTransportPort;

impl ProviderTransportPort {
    pub fn execute(
        request: ProviderTransportRequest,
    ) -> Result<ProviderTransportResult, ProviderTransportError> {
        if !matches!(request.protocol.as_str(), "responses" | "openai" | "chat" | "anthropic")
        {
            return Err(ProviderTransportError {
                code: "provider_protocol_unsupported".to_string(),
                message: format!(
                    "provider protocol {} has no transport owner",
                    request.protocol
                ),
                status: None,
            });
        }
        validate_auth_alias(&request.profile_path, request.auth_alias.as_deref())?;
        send_protocol(
            &request.protocol,
            &request.profile_path,
            &request.wire_body,
            request.stream,
        )
    }
}

fn send_wire_streaming(
    profile_path: &str,
    input: &Value,
    protocol: &str,
    endpoint_suffix: &str,
) -> Result<ProviderResponseStream, ProviderTransportError> {
    let profile = load_profile(profile_path)?;
    if profile.protocol != protocol {
        return Err(ProviderTransportError {
            code: "provider_protocol_mismatch".to_string(),
            message: format!(
                "profile protocol {} does not match {protocol}",
                profile.protocol
            ),
            status: None,
        });
    }
    let endpoint = format!(
        "{}/{}",
        profile.base_url.trim_end_matches('/'),
        endpoint_suffix
    );
    let payload = serde_json::to_vec(input).map_err(|error| ProviderTransportError {
        code: "provider_request_encode".to_string(),
        message: error.to_string(),
        status: None,
    })?;
    let key = materialize_auth(&profile.auth)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| ProviderTransportError {
            code: "provider_client_build".into(),
            message: error.to_string(),
            status: None,
        })?;
    let mut request = client
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    request = if protocol == "anthropic" {
        request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
    } else {
        request.bearer_auth(key)
    };
    let response = request
        .body(payload)
        .send()
        .map_err(|error| ProviderTransportError {
            code: "provider_transport_send".into(),
            message: error.to_string(),
            status: None,
        })?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let stream = ProviderResponseStream {
        response,
        buffer: Vec::new(),
        status,
        content_type,
        protocol: protocol.to_string(),
    };
    Ok(stream)
}

pub fn send_openai_chat_streaming(
    profile_path: &str,
    input: &Value,
) -> Result<ProviderResponseStream, ProviderTransportError> {
    send_wire_streaming(profile_path, input, "openai", "chat/completions")
}

pub fn send_anthropic_messages_streaming(
    profile_path: &str,
    input: &Value,
) -> Result<ProviderResponseStream, ProviderTransportError> {
    send_wire_streaming(profile_path, input, "anthropic", "messages")
}

fn materialize_auth(handle: &ProviderAuthHandle) -> Result<String, ProviderTransportError> {
    match handle {
        ProviderAuthHandle::TokenFile { path, alias } => {
            let key = std::fs::read_to_string(path).map_err(|error| ProviderTransportError {
                code: "provider_auth_read".to_string(),
                message: format!(
                    "auth handle {}: {error}",
                    alias.as_deref().unwrap_or("default")
                ),
                status: None,
            })?;
            let key = key.trim().to_string();
            if key.is_empty() {
                return Err(ProviderTransportError {
                    code: "provider_auth_empty".to_string(),
                    message: "provider auth handle resolved to an empty secret".to_string(),
                    status: None,
                });
            }
            Ok(key)
        }
        ProviderAuthHandle::Env { name } => {
            let key = std::env::var(name).map_err(|error| ProviderTransportError {
                code: "provider_auth_env".to_string(),
                message: format!("auth environment {name}: {error}"),
                status: None,
            })?;
            if key.trim().is_empty() {
                return Err(ProviderTransportError {
                    code: "provider_auth_empty".to_string(),
                    message: format!("auth environment {name} is empty"),
                    status: None,
                });
            }
            Ok(key)
        }
        ProviderAuthHandle::SecretFile { path, key, alias } => {
            let raw = std::fs::read_to_string(path).map_err(|error| ProviderTransportError {
                code: "provider_auth_read".to_string(),
                message: format!(
                    "auth handle {}: {error}",
                    alias.as_deref().unwrap_or("default")
                ),
                status: None,
            })?;
            let secret = if let Ok(document) = toml::from_str::<toml::Value>(&raw) {
                key.split('.')
                    .try_fold(&document, |value, segment| value.get(segment))
                    .and_then(toml::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
            } else {
                raw.lines().find_map(|line| {
                    let (candidate, value) = line.split_once('=')?;
                    if candidate.trim() != key {
                        return None;
                    }
                    let value = value.trim().trim_matches('"').trim_matches('\'');
                    (!value.is_empty()).then(|| value.to_string())
                })
            };
            secret.ok_or_else(|| ProviderTransportError {
                code: "provider_auth_key_missing".to_string(),
                message: format!(
                    "auth handle {} key is missing",
                    alias.as_deref().unwrap_or("default")
                ),
                status: None,
            })
        }
        ProviderAuthHandle::ConfigInline { config_path } => {
            let raw =
                std::fs::read_to_string(config_path).map_err(|error| ProviderTransportError {
                    code: "provider_config_read".to_string(),
                    message: error.to_string(),
                    status: None,
                })?;
            let file: ProviderFile =
                toml::from_str(&raw).map_err(|error| ProviderTransportError {
                    code: "provider_config_parse".to_string(),
                    message: error.to_string(),
                    status: None,
                })?;
            file.provider
                .auth
                .api_key
                .ok_or_else(|| ProviderTransportError {
                    code: "provider_auth_missing".to_string(),
                    message: "provider auth apiKey is missing".to_string(),
                    status: None,
                })
        }
    }
}

pub fn verify_profile_auth(profile: &ProviderProfile) -> Result<(), ProviderTransportError> {
    materialize_auth(&profile.auth).map(|_| ())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderInitAuth {
    Inline(String),
    Env(String),
    TokenFile(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderInitOptions {
    pub provider_id: String,
    pub base_url: String,
    pub model: String,
    pub auth: ProviderInitAuth,
}

pub fn write_provider_profile(
    config_directory: &std::path::Path,
    options: &ProviderInitOptions,
    force: bool,
) -> Result<std::path::PathBuf, ProviderTransportError> {
    if options.provider_id.trim().is_empty()
        || !options
            .provider_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        || options.base_url.trim().is_empty()
        || options.model.trim().is_empty()
    {
        return Err(ProviderTransportError {
            code: "provider_init_invalid".to_string(),
            message: "provider id, base URL, and model must be valid and non-empty".to_string(),
            status: None,
        });
    }
    let directory = config_directory.join("provider").join(&options.provider_id);
    std::fs::create_dir_all(&directory).map_err(|error| ProviderTransportError {
        code: "provider_init_write".to_string(),
        message: error.to_string(),
        status: None,
    })?;
    let path = directory.join("config.v2.toml");
    if path.exists() && !force {
        return Err(ProviderTransportError {
            code: "provider_init_exists".to_string(),
            message: path.display().to_string(),
            status: None,
        });
    }
    let (api_key, env, entries) = match &options.auth {
        ProviderInitAuth::Inline(value) => (Some(value.clone()), None, Vec::new()),
        ProviderInitAuth::Env(name) => (None, Some(name.clone()), Vec::new()),
        ProviderInitAuth::TokenFile(path) => (
            None,
            None,
            vec![AuthEntry {
                alias: Some("primary".to_string()),
                token_file: Some(path.clone()),
                secret_file: None,
                secret_key: None,
            }],
        ),
    };
    let file = ProviderFile {
        provider_id: options.provider_id.clone(),
        provider: ProviderSection {
            base_url: options.base_url.clone(),
            default_model: options.model.clone(),
            protocol: "responses".to_string(),
            models: BTreeMap::from([(
                options.model.clone(),
                ModelSection {
                    wire_name: Some(options.model.clone()),
                },
            )]),
            responses_continuation: default_responses_continuation(),
            auth: AuthSection {
                api_key,
                env,
                entries,
                secret_file: None,
            },
        },
    };
    let mut bytes = toml::to_string_pretty(&file)
        .map_err(|error| ProviderTransportError {
            code: "provider_init_encode".to_string(),
            message: error.to_string(),
            status: None,
        })?
        .into_bytes();
    bytes.push(b'\n');
    let temporary = directory.join(format!(".config.v2.{}.tmp", std::process::id()));
    std::fs::write(&temporary, bytes).map_err(|error| ProviderTransportError {
        code: "provider_init_write".to_string(),
        message: error.to_string(),
        status: None,
    })?;
    std::fs::rename(&temporary, &path).map_err(|error| ProviderTransportError {
        code: "provider_init_write".to_string(),
        message: error.to_string(),
        status: None,
    })?;
    Ok(path)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AvailabilityState {
    Healthy,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvailabilityRecord {
    pub server_id: String,
    pub routing_group: String,
    pub session_id: String,
    pub provider_runtime_identity: String,
    pub state: AvailabilityState,
    pub consecutive_errors: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AvailabilityError {
    ScopeAlreadyClosed,
    UnknownSession,
}

impl std::fmt::Display for AvailabilityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for AvailabilityError {}

/// Session-scoped availability registry; keys are full scope identities and
/// records are never shared across sessions or closed loops.
#[derive(Debug, Clone, Default)]
pub struct V4Availability01SessionScoped {
    records: BTreeMap<(String, String, String, String), AvailabilityRecord>,
}

impl V4Availability01SessionScoped {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(
        &mut self,
        server_id: &str,
        routing_group: &str,
        session_id: &str,
        provider_runtime_identity: &str,
        state: AvailabilityState,
        consecutive_errors: u64,
    ) -> Result<(), AvailabilityError> {
        let key = (
            server_id.to_string(),
            routing_group.to_string(),
            session_id.to_string(),
            provider_runtime_identity.to_string(),
        );
        self.records.insert(
            key,
            AvailabilityRecord {
                server_id: server_id.to_string(),
                routing_group: routing_group.to_string(),
                session_id: session_id.to_string(),
                provider_runtime_identity: provider_runtime_identity.to_string(),
                state,
                consecutive_errors,
            },
        );
        Ok(())
    }

    pub fn get(
        &self,
        server_id: &str,
        routing_group: &str,
        session_id: &str,
        provider_runtime_identity: &str,
    ) -> Option<&AvailabilityRecord> {
        self.records.get(&(
            server_id.to_string(),
            routing_group.to_string(),
            session_id.to_string(),
            provider_runtime_identity.to_string(),
        ))
    }

    pub fn records(&self) -> impl Iterator<Item = &AvailabilityRecord> {
        self.records.values()
    }

    pub fn mark_failure(
        &mut self,
        server_id: &str,
        routing_group: &str,
        session_id: &str,
        provider_runtime_identity: &str,
        cooldown: bool,
        consecutive_errors: u64,
    ) -> Result<(), AvailabilityError> {
        self.record(
            server_id,
            routing_group,
            session_id,
            provider_runtime_identity,
            if cooldown {
                AvailabilityState::Unavailable
            } else {
                AvailabilityState::Degraded
            },
            consecutive_errors,
        )
    }

    /// Record one provider failure for an optional route group.  The
    /// availability resource owns consecutive-error counting and cooldown
    /// projection so request orchestration cannot maintain a second copy of
    /// provider health state.
    pub fn record_failure_for(
        &mut self,
        server_id: &str,
        routing_group: Option<&str>,
        session_id: &str,
        provider_runtime_identity: &str,
        cooldown_policy: bool,
        failure_threshold: u64,
    ) -> Result<(), AvailabilityError> {
        let Some(routing_group) = routing_group else {
            return Ok(());
        };
        let previous = self
            .get(
                server_id,
                routing_group,
                session_id,
                provider_runtime_identity,
            )
            .map(|record| record.consecutive_errors)
            .unwrap_or(0);
        let consecutive_errors = previous.saturating_add(1);
        let cooldown = cooldown_policy && consecutive_errors >= failure_threshold;
        self.mark_failure(
            server_id,
            routing_group,
            session_id,
            provider_runtime_identity,
            cooldown,
            consecutive_errors,
        )
    }

    pub fn mark_success(
        &mut self,
        server_id: &str,
        routing_group: &str,
        session_id: &str,
        provider_runtime_identity: &str,
    ) -> Result<(), AvailabilityError> {
        self.record(
            server_id,
            routing_group,
            session_id,
            provider_runtime_identity,
            AvailabilityState::Healthy,
            0,
        )
    }

    pub fn is_eligible(
        &self,
        server_id: &str,
        routing_group: &str,
        session_id: &str,
        provider_runtime_identity: &str,
    ) -> bool {
        self.get(
            server_id,
            routing_group,
            session_id,
            provider_runtime_identity,
        )
        .map_or(true, |record| {
            record.state != AvailabilityState::Unavailable
        })
    }
}
