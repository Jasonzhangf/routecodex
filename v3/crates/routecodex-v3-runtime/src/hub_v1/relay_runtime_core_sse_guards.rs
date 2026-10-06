//! Relay SSE guard helpers physically split from `relay_runtime_core`.
//!
//! Owner-preserving move of `guard_v3_provider_sse_attempt_deadline`,
//! `guard_v3_provider_sse_idle`, and `observe_v3_provider_sse`. Bodies,
//! signatures, typed arguments, and effective visibility are unchanged; the
//! parent re-exports the crate-visible guards so callers keep the
//! `crate::hub_v1::relay_runtime_core::*` paths.

use crate::hub_v1::V3RuntimeStreamObservation;
use futures_util::StreamExt;
use routecodex_v3_provider_responses::V3ProviderError;

/// Relay SSE idle guard: a configured window applies between every two frames.
pub(crate) fn guard_v3_provider_sse_attempt_deadline(
    request_id: &str,
    provider_id: &str,
    stream: routecodex_v3_provider_responses::V3ProviderSseStream,
    deadline: std::time::Instant,
) -> routecodex_v3_provider_responses::V3ProviderSseStream {
    let request_id = request_id.to_string();
    let provider_id = provider_id.to_string();
    Box::pin(futures_util::stream::unfold(
        (stream, false),
        move |(mut stream, timed_out)| {
            let request_id = request_id.clone();
            let provider_id = provider_id.clone();
            async move {
                if timed_out {
                    return None;
                }
                if std::time::Instant::now() >= deadline {
                    return Some((
                        Err(V3ProviderError::Transport {
                            request_id,
                            provider_id,
                            reason: "provider SSE attempt exceeded the request residence deadline before a semantic terminal".to_string(),
                        }),
                        (stream, true),
                    ));
                }
                match tokio::time::timeout_at(
                    tokio::time::Instant::from_std(deadline),
                    stream.next(),
                )
                .await
                {
                    Ok(Some(chunk)) => Some((chunk, (stream, false))),
                    Ok(None) => None,
                    Err(_) => Some((
                        Err(V3ProviderError::Transport {
                            request_id,
                            provider_id,
                            reason: "provider SSE attempt exceeded the request residence deadline before a semantic terminal".to_string(),
                        }),
                        (stream, true),
                    )),
                }
            }
        },
    ))
}

pub(crate) fn guard_v3_provider_sse_idle(
    request_id: &str,
    provider_id: &str,
    stream: routecodex_v3_provider_responses::V3ProviderSseStream,
    idle_timeout: std::time::Duration,
) -> routecodex_v3_provider_responses::V3ProviderSseStream {
    use futures_util::StreamExt;
    let request_id = request_id.to_string();
    let provider_id = provider_id.to_string();
    Box::pin(futures_util::stream::unfold(
        (stream, false),
        move |(mut stream, timed_out)| {
            let request_id = request_id.clone();
            let provider_id = provider_id.clone();
            async move {
                if timed_out {
                    return None;
                }
                match tokio::time::timeout(idle_timeout, stream.next()).await {
                    Ok(Some(Ok(chunk))) => Some((Ok(chunk), (stream, false))),
                    Ok(Some(Err(error))) => Some((Err(error), (stream, false))),
                    Ok(None) => None,
                    Err(_) => Some((
                        Err(V3ProviderError::Transport {
                            request_id: request_id.clone(),
                            provider_id: provider_id.clone(),
                            reason: format!(
                                "provider SSE stream idle timeout (no frame within {}ms)",
                                idle_timeout.as_millis()
                            ),
                        }),
                        (stream, true),
                    )),
                }
            }
        },
    ))
}

pub(super) fn observe_v3_provider_sse(
    stream: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: V3RuntimeStreamObservation,
) -> routecodex_v3_provider_responses::V3ProviderSseStream {
    use futures_util::StreamExt;
    Box::pin(stream.map(move |item| {
        if let Ok(chunk) = &item {
            if let Err(error) = observation.record_provider_raw_sse_chunk(chunk) {
                // This is runtime observation state, not provider health. Keep
                // the failure on the typed side-channel while preserving the
                // provider/client bytes and their protocol semantics.
                if let Err(receipt_error) = observation.record_observation_error(&format!(
                    "provider_raw_sse_observation_failed: {error}"
                )) {
                    eprintln!(
                        "V3 runtime observation failure could not be recorded: {receipt_error}; original: {error}"
                    );
                }
            }
        }
        item
    }))
}
