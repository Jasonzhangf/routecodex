use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct V3ProviderErrorFingerprint {
    pub reason_code: String,
    pub provider_code: String,
    pub http_status: u16,
    pub semantic_signature: String,
}

impl V3ProviderErrorFingerprint {
    pub fn new(
        reason_code: impl Into<String>,
        provider_code: impl Into<String>,
        http_status: u16,
        semantic_signature: impl Into<String>,
    ) -> Result<Self, String> {
        let fingerprint = Self {
            reason_code: reason_code.into(),
            provider_code: provider_code.into(),
            http_status,
            semantic_signature: semantic_signature.into(),
        };
        if fingerprint.reason_code.trim().is_empty()
            || fingerprint.provider_code.trim().is_empty()
            || fingerprint.semantic_signature.trim().is_empty()
        {
            return Err("provider error fingerprint fields must be non-empty".to_string());
        }
        Ok(fingerprint)
    }
}

