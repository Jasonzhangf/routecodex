// Transport request metadata, split from transport.rs to satisfy
// verify:v3-file-size. Semantics unchanged; the parent re-exports the public
// header type and imports the private carrier and name-normalization helper.

use super::V3Transport13ResponsesRequest;
use routecodex_v3_config::V3ProviderAuthType;
use std::fmt;

/// Explicit Provider business-wire auth carrier. It carries no secret; the
/// selected secret is still resolved at the HTTP send boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) enum V3ProviderHttpAuthCarrier {
    #[default]
    ExistingBearer,
    GeminiApiKey,
}

impl V3Transport13ResponsesRequest {
    pub fn with_gemini_auth_kind(mut self, auth_kind: &V3ProviderAuthType) -> Self {
        self.auth_carrier = match auth_kind {
            V3ProviderAuthType::ApiKey => V3ProviderHttpAuthCarrier::GeminiApiKey,
            V3ProviderAuthType::OAuth | V3ProviderAuthType::TokenFile => {
                V3ProviderHttpAuthCarrier::ExistingBearer
            }
        };
        self
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct V3ProviderRequestHeader {
    pub(super) name: String,
    pub(super) value: String,
}

impl fmt::Debug for V3ProviderRequestHeader {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("V3ProviderRequestHeader")
            .field("name", &self.name)
            .field("value", &"[REDACTED]")
            .finish()
    }
}

impl V3ProviderRequestHeader {
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: normalize_provider_header_name(name.into()),
            value: value.into(),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn value(&self) -> &str {
        &self.value
    }
}

pub(super) fn normalize_provider_header_name(name: String) -> String {
    name.trim().to_ascii_lowercase()
}
