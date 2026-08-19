//! routecodex-v4-provider — contract-bound provider availability resource
//! owner (`v4.control.availability`, V4Availability01SessionScoped).
//!
//! Hard boundaries:
//! - availability is session-scoped; process-global cooldown truth is
//!   forbidden;
//! - the router may read availability but never writes it; failures are
//!   recorded by the provider runtime owner only;
//! - availability never enters provider/client payload.

use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Deserialize)]
struct ProviderFile {
    #[serde(rename = "providerId")]
    provider_id: String,
    provider: ProviderSection,
}

#[derive(Debug, Clone, Deserialize)]
struct ProviderSection {
    #[serde(rename = "baseURL")]
    base_url: String,
    #[serde(rename = "defaultModel")]
    default_model: String,
    #[serde(rename = "type")]
    protocol: String,
    #[serde(default)]
    models: BTreeMap<String, ModelSection>,
    auth: AuthSection,
}

#[derive(Debug, Clone, Deserialize)]
struct ModelSection {
    #[serde(rename = "wireName")]
    wire_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct AuthSection {
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
    #[serde(default)]
    entries: Vec<AuthEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct AuthEntry {
    alias: Option<String>,
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
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
    pub models: Vec<ProviderModel>,
    auth: ProviderAuthHandle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProviderAuthHandle {
    InlineKey {
        value: String,
        alias: Option<String>,
    },
    TokenFile {
        path: String,
        alias: Option<String>,
    },
    SecretFileKey {
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

/// Provider-owned real transport stream. The runtime owns semantic frame
/// validation and the server owns client chunk emission.
pub struct ProviderResponseStream {
    child: std::process::Child,
    buffer: Vec<u8>,
    status: u16,
    content_type: String,
}

impl ProviderResponseStream {
    pub fn status(&self) -> u16 {
        self.status
    }

    pub fn content_type(&self) -> &str {
        &self.content_type
    }

    pub fn read_chunk(&mut self, chunk: &mut [u8]) -> Result<usize, ProviderTransportError> {
        if !self.buffer.is_empty() {
            let count = self.buffer.len().min(chunk.len());
            chunk[..count].copy_from_slice(&self.buffer[..count]);
            self.buffer.drain(..count);
            return Ok(count);
        }
        self.child
            .stdout
            .as_mut()
            .ok_or_else(|| ProviderTransportError {
                code: "provider_stream_no_stdout".to_string(),
                message: "provider stream lost stdout".to_string(),
                status: None,
            })?
            .read(chunk)
            .map_err(|error| ProviderTransportError {
                code: "provider_stream_read".to_string(),
                message: error.to_string(),
                status: None,
            })
    }

    pub fn wait(&mut self) -> Result<(), ProviderTransportError> {
        let status = self.child.wait().map_err(|error| ProviderTransportError {
            code: "provider_transport_wait".to_string(),
            message: error.to_string(),
            status: None,
        })?;
        if status.success() {
            Ok(())
        } else {
            Err(ProviderTransportError {
                code: "provider_transport_failed".to_string(),
                message: format!("provider transport exited with {status}"),
                status: None,
            })
        }
    }
}

impl Drop for ProviderResponseStream {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderTransportError {
    pub code: String,
    pub message: String,
    pub status: Option<u16>,
}

const FORBIDDEN_WIRE_FIELDS: [&str; 10] = [
    "route_facts",
    "target_selection",
    "execution_mode",
    "provider_id",
    "config_path",
    "retry",
    "health",
    "debug",
    "error_chain",
    "manifest_digest",
];

/// Provider-owned Node 06 compatibility projection. Direct Responses keeps
/// the same protocol shape. Relay is admitted only for an explicitly mapped
/// Responses-to-Responses edge; every other protocol pair fails closed.
pub fn project_provider_compat(
    semantic: &Value,
    entry_protocol: &str,
    provider_protocol: &str,
    execution_mode: &str,
) -> Result<Value, ProviderTransportError> {
    if !semantic.is_object() {
        return Err(ProviderTransportError {
            code: "provider_semantic_invalid".to_string(),
            message: "provider semantic request must be an object".to_string(),
            status: None,
        });
    }
    match (execution_mode, entry_protocol, provider_protocol) {
        ("direct", "responses", "responses") | ("relay", "responses", "responses") => {
            validate_provider_wire_payload(semantic)?;
            Ok(semantic.clone())
        }
        ("direct", _, _) => Err(ProviderTransportError {
            code: "provider_direct_protocol_mismatch".to_string(),
            message: format!(
                "direct requires identical entry/provider protocol, got {entry_protocol}->{provider_protocol}"
            ),
            status: None,
        }),
        ("relay", _, _) => Err(ProviderTransportError {
            code: "provider_compat_unmapped".to_string(),
            message: format!(
                "relay compatibility edge {entry_protocol}->{provider_protocol} is not registered"
            ),
            status: None,
        }),
        (mode, _, _) => Err(ProviderTransportError {
            code: "provider_execution_mode_invalid".to_string(),
            message: format!("unsupported execution mode {mode}"),
            status: None,
        }),
    }
}

/// Node 07 provider wire boundary: validates normal provider data and rejects
/// RouteCodex control resources instead of silently stripping them.
pub fn validate_provider_wire_payload(wire: &Value) -> Result<(), ProviderTransportError> {
    let object = wire.as_object().ok_or_else(|| ProviderTransportError {
        code: "provider_wire_invalid".to_string(),
        message: "provider wire request must be an object".to_string(),
        status: None,
    })?;
    if let Some(field) = FORBIDDEN_WIRE_FIELDS
        .iter()
        .find(|field| object.contains_key(**field))
    {
        return Err(ProviderTransportError {
            code: "provider_wire_control_leak".to_string(),
            message: format!("control field {field} reached provider wire boundary"),
            status: None,
        });
    }
    Ok(())
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
        if let Some(value) = entry
            .api_key
            .clone()
            .filter(|value| !value.trim().is_empty())
        {
            ProviderAuthHandle::InlineKey {
                value,
                alias: entry.alias.clone(),
            }
        } else if let (Some(path), Some(key)) =
            (entry.secret_file.clone(), entry.secret_key.clone())
        {
            ProviderAuthHandle::SecretFileKey {
                path,
                key,
                alias: entry.alias.clone(),
            }
        } else if let Some(path) = entry.token_file.clone() {
            ProviderAuthHandle::TokenFile {
                path,
                alias: entry.alias.clone(),
            }
        } else {
            return Err(ProviderTransportError {
                code: "provider_auth_handle_missing".to_string(),
                message: "provider auth entry has no inline key, token file, or secret file key"
                    .to_string(),
                status: None,
            });
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
        models,
        auth,
    })
}

pub fn resolve_model(
    profile: &ProviderProfile,
    requested: &str,
) -> Result<String, ProviderTransportError> {
    profile
        .models
        .iter()
        .find(|model| model.id == requested)
        .map(|model| model.wire_name.clone())
        .ok_or_else(|| ProviderTransportError {
            code: "provider_model_unknown".to_string(),
            message: format!(
                "model {requested} is not declared by {}",
                profile.provider_id
            ),
            status: None,
        })
}

pub fn send_responses(
    profile_path: &str,
    model: &str,
    input: &Value,
    stream: bool,
) -> Result<ProviderRawResponse, ProviderTransportError> {
    let profile = load_profile(profile_path)?;
    let wire_model = resolve_model(&profile, model)?;
    if profile.protocol != "responses" {
        return Err(ProviderTransportError {
            code: "provider_protocol_unsupported".to_string(),
            message: format!(
                "provider protocol {} cannot serve Responses",
                profile.protocol
            ),
            status: None,
        });
    }
    let key = materialize_auth(&profile.auth)?;
    let mut body = input.clone();
    let object = body.as_object_mut().ok_or_else(|| ProviderTransportError {
        code: "provider_request_invalid".to_string(),
        message: "Responses request must be a JSON object".to_string(),
        status: None,
    })?;
    object.insert("model".to_string(), Value::String(wire_model));
    object.insert("stream".to_string(), Value::Bool(stream));
    let endpoint = format!("{}/responses", profile.base_url.trim_end_matches('/'));
    let script = "curl --silent --show-error --location --max-time 300 --request POST --header 'content-type: application/json' --header \"authorization: Bearer $RCCV4_API_KEY\" --data-binary @- --write-out '\n__RCCV4_STATUS__:%{http_code}\n__RCCV4_TYPE__:%{content_type}\n' \"$1\"";
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", script, "rccv4-curl", &endpoint])
        .env("RCCV4_API_KEY", key)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| ProviderTransportError {
        code: "provider_transport_spawn".to_string(),
        message: error.to_string(),
        status: None,
    })?;
    let payload = serde_json::to_vec(&body).map_err(|error| ProviderTransportError {
        code: "provider_request_encode".to_string(),
        message: error.to_string(),
        status: None,
    })?;
    child
        .stdin
        .take()
        .expect("curl stdin configured")
        .write_all(&payload)
        .map_err(|error| ProviderTransportError {
            code: "provider_transport_write".to_string(),
            message: error.to_string(),
            status: None,
        })?;
    let output = child
        .wait_with_output()
        .map_err(|error| ProviderTransportError {
            code: "provider_transport_wait".to_string(),
            message: error.to_string(),
            status: None,
        })?;
    if !output.status.success() {
        return Err(ProviderTransportError {
            code: "provider_transport_failed".to_string(),
            message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            status: None,
        });
    }
    parse_curl_response(&output.stdout)
}

pub fn send_responses_streaming(
    profile_path: &str,
    model: &str,
    input: &Value,
) -> Result<ProviderResponseStream, ProviderTransportError> {
    let profile = load_profile(profile_path)?;
    let wire_model = resolve_model(&profile, model)?;
    if profile.protocol != "responses" {
        return Err(ProviderTransportError {
            code: "provider_protocol_unsupported".to_string(),
            message: format!(
                "provider protocol {} cannot serve Responses",
                profile.protocol
            ),
            status: None,
        });
    }
    let key = materialize_auth(&profile.auth)?;
    let mut body = input.clone();
    let object = body.as_object_mut().ok_or_else(|| ProviderTransportError {
        code: "provider_request_invalid".to_string(),
        message: "Responses request must be a JSON object".to_string(),
        status: None,
    })?;
    object.insert("model".to_string(), Value::String(wire_model));
    object.insert("stream".to_string(), Value::Bool(true));
    let endpoint = format!("{}/responses", profile.base_url.trim_end_matches('/'));
    let script = "curl --silent --show-error --no-buffer --include --location --max-time 300 --request POST --header 'content-type: application/json' --header \"authorization: Bearer $RCCV4_API_KEY\" --data-binary @- \"$1\"";
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", script, "rccv4-curl", &endpoint])
        .env("RCCV4_API_KEY", key)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| ProviderTransportError {
        code: "provider_transport_spawn".to_string(),
        message: error.to_string(),
        status: None,
    })?;
    let payload = serde_json::to_vec(&body).map_err(|error| ProviderTransportError {
        code: "provider_request_encode".to_string(),
        message: error.to_string(),
        status: None,
    })?;
    child
        .stdin
        .take()
        .expect("curl stdin configured")
        .write_all(&payload)
        .map_err(|error| ProviderTransportError {
            code: "provider_transport_write".to_string(),
            message: error.to_string(),
            status: None,
        })?;
    let mut stream = ProviderResponseStream {
        child,
        buffer: Vec::new(),
        status: 0,
        content_type: String::new(),
    };
    parse_provider_stream_header(&mut stream)?;
    Ok(stream)
}

/// Parse the upstream HTTP header prefix from the provider stream and return
/// the number of bytes consumed. Only one informational/final response block
/// may be consumed by a stream; later blocks fail fast.
fn parse_provider_stream_header(
    stream: &mut ProviderResponseStream,
) -> Result<(), ProviderTransportError> {
    let mut head = [0u8; 8192];
    let mut bytes = Vec::new();
    loop {
        let Some((end, status, content_type)) = http_header_at(&bytes) else {
            if bytes.len() > 64 * 1024 {
                return Err(ProviderTransportError {
                    code: "provider_response_headers_too_large".to_string(),
                    message: "provider HTTP headers exceeded 64 KiB".to_string(),
                    status: None,
                });
            }
            let count = stream
                .child
                .stdout
                .as_mut()
                .ok_or_else(|| ProviderTransportError {
                    code: "provider_stream_no_stdout".to_string(),
                    message: "provider stream lost stdout".to_string(),
                    status: None,
                })?
                .read(&mut head)
                .map_err(|error| ProviderTransportError {
                    code: "provider_stream_header_read".to_string(),
                    message: error.to_string(),
                    status: None,
                })?;
            if count == 0 {
                return Err(ProviderTransportError {
                    code: "provider_stream_no_header".to_string(),
                    message: "provider stream ended before HTTP headers".to_string(),
                    status: None,
                });
            }
            bytes.extend_from_slice(&head[..count]);
            continue;
        };
        if status == 100 {
            bytes.drain(..end);
            continue;
        }
        stream.buffer.extend_from_slice(&bytes[end..]);
        stream.status = status;
        stream.content_type = content_type;
        return Ok(());
    }
}

fn http_header_at(bytes: &[u8]) -> Option<(usize, u16, String)> {
    // HTTP/1.1 uses CRLF CRLF. HTTP/2 over curl --include may emit simple LF
    // terminators instead. Accept both forms so the header parser covers the
    // real upstream shape that curl describes for HTTP/2 responses.
    let end = if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
        position + 4
    } else {
        let position = bytes.windows(2).position(|window| window == b"\n\n")?;
        position + 2
    };
    let head = std::str::from_utf8(&bytes[..end]).ok()?;
    let first = head.lines().next()?;
    let status = first.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    let content_type = head
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
        .filter(|(name, _)| name == "content-type")
        .map(|(_, value)| value)
        .unwrap_or_default();
    Some((end, status, content_type))
}

fn materialize_auth(handle: &ProviderAuthHandle) -> Result<String, ProviderTransportError> {
    match handle {
        ProviderAuthHandle::InlineKey { value, alias } => {
            if value.trim().is_empty() {
                return Err(ProviderTransportError {
                    code: "provider_auth_empty".to_string(),
                    message: format!(
                        "provider auth handle {} resolved to an empty secret",
                        alias.as_deref().unwrap_or("default")
                    ),
                    status: None,
                });
            }
            Ok(value.clone())
        }
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
        ProviderAuthHandle::SecretFileKey { path, key, alias } => {
            let raw = std::fs::read_to_string(path).map_err(|error| ProviderTransportError {
                code: "provider_auth_read".to_string(),
                message: format!(
                    "auth handle {}: {error}",
                    alias.as_deref().unwrap_or("default")
                ),
                status: None,
            })?;
            let secrets: toml::Value =
                toml::from_str(&raw).map_err(|error| ProviderTransportError {
                    code: "provider_auth_parse".to_string(),
                    message: format!(
                        "auth handle {}: {error}",
                        alias.as_deref().unwrap_or("default")
                    ),
                    status: None,
                })?;
            let value = key
                .split('.')
                .try_fold(&secrets, |value, segment| value.get(segment))
                .and_then(toml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ProviderTransportError {
                    code: "provider_auth_empty".to_string(),
                    message: format!(
                        "provider auth handle {} key {key} is missing or empty",
                        alias.as_deref().unwrap_or("default")
                    ),
                    status: None,
                })?;
            Ok(value.to_string())
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
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ProviderTransportError {
                    code: "provider_auth_empty".to_string(),
                    message: "provider auth apiKey is missing or empty".to_string(),
                    status: None,
                })
        }
    }
}

fn parse_curl_response(output: &[u8]) -> Result<ProviderRawResponse, ProviderTransportError> {
    let marker = b"\n__RCCV4_STATUS__:";
    let marker_start = output
        .windows(marker.len())
        .position(|window| window == marker)
        .ok_or_else(|| ProviderTransportError {
            code: "provider_response_parse".to_string(),
            message: "curl status marker missing".to_string(),
            status: None,
        })?;
    let body = output[..marker_start].to_vec();
    let metadata = String::from_utf8_lossy(&output[marker_start + 1..]);
    let status = metadata
        .lines()
        .find_map(|line| line.strip_prefix("__RCCV4_STATUS__:")?.parse().ok())
        .ok_or_else(|| ProviderTransportError {
            code: "provider_response_parse".to_string(),
            message: "provider status missing".to_string(),
            status: None,
        })?;
    let content_type = metadata
        .lines()
        .find_map(|line| line.strip_prefix("__RCCV4_TYPE__:"))
        .unwrap_or_default()
        .to_string();
    Ok(ProviderRawResponse {
        status,
        content_type,
        body,
    })
}

#[cfg(test)]
mod auth_tests {
    use super::{materialize_auth, ProviderAuthHandle};

    fn secret_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("rccv4-provider-{name}-{}", std::process::id()))
    }

    #[test]
    fn dotted_secret_key_resolves_and_empty_secret_fails() {
        let path = secret_path("nested-secret.toml");
        std::fs::write(
            &path,
            "[minimax]\nkey1 = \"test-only-secret\"\nempty = \"\"\n",
        )
        .expect("test secret fixture writes");
        let nested = ProviderAuthHandle::SecretFileKey {
            path: path.display().to_string(),
            key: "minimax.key1".to_string(),
            alias: Some("test".to_string()),
        };
        assert_eq!(materialize_auth(&nested).unwrap(), "test-only-secret");
        let empty = ProviderAuthHandle::SecretFileKey {
            path: path.display().to_string(),
            key: "minimax.empty".to_string(),
            alias: Some("test".to_string()),
        };
        assert_eq!(
            materialize_auth(&empty).unwrap_err().code,
            "provider_auth_empty"
        );
        std::fs::remove_file(path).expect("test fixture cleanup");
    }
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
}
