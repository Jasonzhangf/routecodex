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
    manifest: &V3Config05ManifestPublished,
) -> (
    tokio::time::Instant,
    Result<V3ProviderResp14Raw, V3ProviderError>,
) {
    let started = tokio::time::Instant::now();
    let request_id = request.request_id().to_string();
    let provider_id = request.provider_id().to_string();
    let provider_sse =
        request.stream_intent() == routecodex_v3_provider_responses::V3ResponsesStreamIntent::Sse;
    let first_word_timeout = if provider_sse {
        match crate::hub_v1::v3_provider_sse_first_word_timeout(manifest, &provider_id) {
            Ok(timeout) => timeout,
            Err(reason) => {
                return (
                    started,
                    Err(V3ProviderError::InternalTransport {
                        request_id,
                        provider_id,
                        lane: routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Request,
                        reason,
                    }),
                );
            }
        }
    } else {
        json_timeout
            .unwrap_or_else(|| responses_direct_transport_response_timeout(manifest, &provider_id))
    };
    let first_word_deadline = started + first_word_timeout;
    let deadline = if provider_sse {
        Some(first_word_deadline)
    } else {
        json_timeout.map(|timeout| started + timeout)
    };
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
