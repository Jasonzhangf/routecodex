use serde::Deserialize;
use std::fmt;

/// Refreshed credential values. This type intentionally has no public token
/// fields and redacts every secret from Debug output.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct V3OAuthCredential {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_at: Option<i64>,
}

impl V3OAuthCredential {
    pub fn new(
        access_token: impl Into<String>,
        refresh_token: Option<String>,
        id_token: Option<String>,
        expires_at: Option<i64>,
    ) -> Self {
        Self {
            access_token: access_token.into(),
            refresh_token,
            id_token,
            expires_at,
        }
    }

    pub fn access_token(&self) -> &str {
        &self.access_token
    }

    pub fn refresh_token(&self) -> Option<&str> {
        self.refresh_token.as_deref()
    }

    pub fn id_token(&self) -> Option<&str> {
        self.id_token.as_deref()
    }

    pub fn expires_at(&self) -> Option<i64> {
        self.expires_at
    }

    pub fn has_access_token(&self) -> bool {
        !self.access_token.is_empty()
    }
}

impl fmt::Debug for V3OAuthCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("V3OAuthCredential")
            .field(
                "access_token",
                &self.access_token.is_empty().then_some("[REDACTED]"),
            )
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("id_token", &self.id_token.as_ref().map(|_| "[REDACTED]"))
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CodexAuthJson {
    #[serde(default)]
    pub auth_mode: Option<String>,
    pub tokens: CodexAuthTokens,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CodexAuthTokens {
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

/// Refresh endpoint response. Token values remain private to the resolver and
/// are redacted if this type ever appears in Debug output.
#[derive(Clone, Default, PartialEq, Eq, Deserialize)]
pub struct V3OAuthRefreshResponse {
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
}

impl fmt::Debug for V3OAuthRefreshResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("V3OAuthRefreshResponse")
            .field(
                "access_token",
                &self.access_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("id_token", &self.id_token.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}
