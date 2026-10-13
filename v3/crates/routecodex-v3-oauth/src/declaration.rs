use serde::{Deserialize, Serialize};
use std::fmt;

/// Explicit source of OAuth credential material. Codex auth.json is the only
/// source implemented in this slice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum V3OAuthSource {
    CodexAuthJson { path: String },
}

/// Explicit storage mode for refreshed credential material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum V3OAuthStore {
    Memory,
    File { path: String },
}

/// Typed OAuth declaration carried from Config through Target to Provider auth
/// resolution. The declaration contains control-plane handles only.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3OAuthDeclaration {
    pub oauth_source: V3OAuthSource,
    pub refresh_endpoint: String,
    pub client_id: String,
    #[serde(default = "default_refresh_before_seconds")]
    pub refresh_before_seconds: u64,
    pub oauth_store: V3OAuthStore,
}

pub const fn default_refresh_before_seconds() -> u64 {
    300
}

impl fmt::Debug for V3OAuthDeclaration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("V3OAuthDeclaration")
            .field("oauth_source", &self.oauth_source)
            .field("refresh_endpoint", &"[REDACTED]")
            .field("client_id", &"[REDACTED]")
            .field("refresh_before_seconds", &self.refresh_before_seconds)
            .field("oauth_store", &self.oauth_store)
            .finish()
    }
}
