// Manifest-scoped provider timeout wrapper, included by the resident Relay owner.
// The published timeout values themselves are owned by `relay_runtime_shared`;
// this file only binds them to the published provider manifest.

pub(crate) use super::relay_runtime_shared::{
    v3_provider_sse_idle_timeout, v3_relay_transport_response_timeout_from_ms,
};

pub(crate) fn v3_relay_transport_response_timeout(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
) -> std::time::Duration {
    v3_relay_transport_response_timeout_from_ms(
        manifest
            .providers
            .get(provider_id)
            .map(|p| p.request_timeout_ms),
    )
}

#[cfg(test)]
mod response_header_timeout_contract_tests {
    use super::*;

    #[test]
    fn relay_transport_header_timeout_reads_provider_request_timeout() {
        assert_eq!(
            v3_relay_transport_response_timeout_from_ms(Some(900_000)),
            std::time::Duration::from_millis(900_000)
        );
    }

    #[test]
    fn relay_transport_header_timeout_defaults_and_zero_use_default_timeout() {
        assert_eq!(
            v3_relay_transport_response_timeout_from_ms(None),
            std::time::Duration::from_millis(300_000)
        );
        assert_eq!(
            v3_relay_transport_response_timeout_from_ms(Some(0)),
            std::time::Duration::from_millis(300_000)
        );
    }
}
