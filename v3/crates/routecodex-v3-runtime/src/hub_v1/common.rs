use routecodex_v3_config::V3Config05ManifestPublished;
use serde_json::Value;
use std::sync::Arc;

pub(crate) fn v3_tool_thinking_enabled_for_server(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> bool {
    v3_feature_enabled_for_server(manifest, server_id, "tool_thinking", false)
}

pub(crate) fn v3_feature_enabled_for_server(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    feature: &str,
    default_enabled: bool,
) -> bool {
    let global_enabled = manifest
        .features
        .get(feature)
        .copied()
        .unwrap_or(default_enabled);
    manifest
        .servers
        .get(server_id)
        .and_then(|server| server.features.get(feature).copied())
        .unwrap_or(global_enabled)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum V3HubEntryProtocol {
    Responses,
    Anthropic,
    Gemini,
    OpenAiChat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubRequestSemanticProtocol {
    Chat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubExecutionMode {
    Direct,
    Relay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubProviderWireProtocol {
    Responses,
    Anthropic,
    Gemini,
    OpenAiChat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubTargetResolution {
    Routed,
    Pinned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubInvocationSource {
    Client,
    /// A Runtime-launched bounded Chat Process refill execution. The original
    /// client execution stays `Client`; only an actually launched continuation
    /// carries this typed origin.
    Refill,
    DryRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubTransportIntent {
    Json,
    Sse,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct V3HubOpaquePayload(pub(crate) Arc<Value>);

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct V3HubResponsePayload(pub(crate) Arc<Value>);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3ProviderCompatProfileId {
    Passthrough,
    Profile(String),
}

impl V3ProviderCompatProfileId {
    pub(crate) fn from_config(profile: Option<&str>) -> Self {
        match profile.map(str::trim).filter(|profile| !profile.is_empty()) {
            Some(profile) if profile.eq_ignore_ascii_case("compat:passthrough") => {
                Self::Passthrough
            }
            Some(profile) => Self::Profile(profile.to_string()),
            None => Self::Passthrough,
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Passthrough => "compat:passthrough",
            Self::Profile(profile) => profile.as_str(),
        }
    }

    pub(crate) fn as_optional_string(&self) -> Option<String> {
        match self {
            Self::Passthrough => None,
            Self::Profile(profile) => Some(profile.clone()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubResponseNormalizedKind {
    Json,
    Sse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubResponseTerminality {
    Terminal,
    NonTerminal,
}

/// Chat Process per-complete-execution outcome for bounded automatic refill.
/// Deliver ends the automatic chain; RequestRefill asks Runtime to launch one
/// more normal request-mainline execution when the request-local budget allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ChatProcessRefillDisposition {
    Deliver,
    RequestRefill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum V3HubRelayToolKind {
    Function,
    Custom,
    ApplyPatch,
    Mcp,
    Native,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3HubResponseToolCall {
    pub(crate) call_id: String,
    pub(crate) name: String,
    pub(crate) kind: V3HubRelayToolKind,
}
