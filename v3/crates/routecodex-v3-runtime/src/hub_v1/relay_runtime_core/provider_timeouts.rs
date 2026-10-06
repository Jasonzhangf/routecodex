// Published provider timeout accessors, included by the resident Relay owner.
// Timeout policy and stream lifecycle remain in their existing owners.

pub(crate) fn v3_relay_transport_response_timeout_from_ms(
    request_timeout_ms: Option<u64>,
) -> std::time::Duration {
    std::time::Duration::from_millis(request_timeout_ms.filter(|&ms| ms > 0).unwrap_or(300_000))
}

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

/// The published provider SSE timeout intentionally covers both the first frame
/// and the maximum inter-frame idle interval for relay streams.
pub(crate) fn v3_provider_sse_idle_timeout(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
) -> Result<std::time::Duration, String> {
    manifest.providers.get(provider_id).and_then(|provider| provider.sse_first_frame_timeout_ms)
        .filter(|timeout_ms| *timeout_ms > 0).map(std::time::Duration::from_millis)
        .ok_or_else(|| {
            format!(
                "published provider SSE first-frame/inter-frame timeout is missing for provider {provider_id}"
            )
        })
}
