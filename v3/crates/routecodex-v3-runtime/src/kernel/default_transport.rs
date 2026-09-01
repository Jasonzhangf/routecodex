use super::*;

/// Only the response-header timeout is eligible for health-neutral transient retry.
pub(super) const V3_DIRECT_TRANSPORT_HANG_REASON: &str =
    "provider response header timed out (suspected hang)";

pub(super) fn responses_direct_transport_response_timeout(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
) -> std::time::Duration {
    crate::hub_v1::v3_relay_transport_response_timeout(manifest, provider_id)
}

static DEFAULT_RESPONSES_TRANSPORT: OnceLock<ReqwestResponsesTransport> = OnceLock::new();

pub fn default_responses_transport() -> &'static ReqwestResponsesTransport {
    DEFAULT_RESPONSES_TRANSPORT.get_or_init(ReqwestResponsesTransport::default)
}

pub fn default_provider_transport_handoff_checkpoints(
) -> Vec<routecodex_v3_provider_responses::V3ProviderTransportCheckpoint> {
    default_responses_transport()
        .transport_handoff_broker()
        .checkpoints()
}

pub fn restore_default_provider_transport_handoff_checkpoints(
    checkpoints: &[routecodex_v3_provider_responses::V3ProviderTransportCheckpoint],
) -> Result<usize, String> {
    default_responses_transport()
        .transport_handoff_broker()
        .restore_detached(checkpoints)
}
