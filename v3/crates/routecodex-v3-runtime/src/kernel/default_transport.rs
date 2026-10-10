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

/// Direct header acquisition and subsequent SSE observation share one attempt
/// start. JSON retains the caller's existing header policy.
pub(super) fn prepare_direct_sse_attempt(
    request: &V3Transport13ResponsesHttpRequest,
    budget: &crate::nodes::V3AttemptBudget,
) {
    if request.stream_intent() == routecodex_v3_provider_responses::V3ResponsesStreamIntent::Sse {
        budget.use_sse_first_word_policy();
    }
}

pub(super) async fn send_direct_provider_headers<T: ResponsesTransport + ?Sized>(
    transport: &T,
    request: V3Transport13ResponsesHttpRequest,
    json_timeout: Option<std::time::Duration>,
) -> (
    tokio::time::Instant,
    Result<V3ProviderResp14Raw, V3ProviderError>,
) {
    let started = tokio::time::Instant::now();
    let first_word_deadline = started
        + std::time::Duration::from_millis(
            request
                .sse_first_frame_timeout_ms()
                .unwrap_or_else(routecodex_v3_config::default_provider_sse_first_frame_timeout_ms),
        );
    let deadline = if request.stream_intent()
        == routecodex_v3_provider_responses::V3ResponsesStreamIntent::Sse
    {
        Some(first_word_deadline)
    } else {
        json_timeout.map(|timeout| started + timeout)
    };
    let request_id = request.request_id().to_string();
    let provider_id = request.provider_id().to_string();
    let result = match deadline {
        Some(deadline) => tokio::time::timeout_at(deadline, transport.send(request))
            .await
            .unwrap_or_else(|_| {
                Err(V3ProviderError::Transport {
                    request_id,
                    provider_id,
                    reason: V3_DIRECT_TRANSPORT_HANG_REASON.to_string(),
                })
            }),
        None => transport.send(request).await,
    };
    (first_word_deadline, result)
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
