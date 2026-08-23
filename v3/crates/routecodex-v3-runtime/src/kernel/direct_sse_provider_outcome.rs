use super::*;
use crate::hub_v1::{
    classify_v3_provider_sse_json_data, V3HubProviderWireProtocol,
    V3ProviderResponsesJsonFrameOutcome,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub(super) struct V3DirectSseProviderAttempt {
    pub(super) stream: V3ClientSseStream,
    pub(super) terminal_validated: bool,
}

pub(super) type V3DirectSseProviderHandoff = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Option<V3ClientSseStream>> + Send>> + Send + Sync,
>;

fn direct_sse_frame_commits_client_stream(frame: &[u8]) -> bool {
    let text = String::from_utf8_lossy(frame);
    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            return true;
        };
        let Some(kind) = value.get("type").and_then(serde_json::Value::as_str) else {
            return true;
        };
        if !matches!(
            kind,
            "response.created" | "response.in_progress" | "message_start"
        ) {
            return true;
        }
    }
    false
}
pub(super) struct V3DirectSseProviderOutcome {
    pub(super) provider_health: V3ProviderFailureRuntimeHealth,
    pub(super) failure_session_scope: V3ProviderFailureSessionScope,
    pub(super) provider_id: String,
    pub(super) auth_alias: String,
    pub(super) model_id: String,
    pub(super) provider_protocol: V3HubProviderWireProtocol,
    pub(super) terminal: bool,
    pub(super) seen_done: bool,
    pub(super) recorded: bool,
    pub(super) provider_health_neutral: bool,
    pub(super) _provider_action_permit: Option<V3ProviderActionPermit>,
}

impl V3DirectSseProviderOutcome {
    pub(super) fn observe_chunk(
        &mut self,
        chunk: &[u8],
        decoder: &mut SseIncrementalDecoder,
    ) -> Result<(), V3Error01SourceRaised> {
        let frames = decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
            .map_err(|error| {
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "provider_response_sse_transport_invalid",
                    error.to_string(),
                )
            })?;
        for frame in frames {
            self.observe_frame(frame.frame().fields())?;
        }
        Ok(())
    }

    pub(super) fn observe_frame(
        &mut self,
        fields: &[SseField],
    ) -> Result<(), V3Error01SourceRaised> {
        let raw_data = collect_v3_provider_sse_json_data(fields);
        if is_v3_provider_sse_keepalive_text(&raw_data) {
            return Ok(());
        }
        let data =
            normalize_v3_provider_sse_json_data_for_event_name(self.provider_protocol, fields)
                .map_err(|message| {
                    build_v3_error_01_source_raised(
                        V3ErrorSourceKind::ProviderFailure,
                        "V3ProviderResp14Raw",
                        "provider_response_sse_event_invalid",
                        message,
                    )
                })?;
        if is_v3_provider_sse_keepalive_text(&data) {
            return Ok(());
        }
        let parsed = classify_v3_provider_sse_json_data(self.provider_protocol, &data).map_err(
            |message| {
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "provider_response_sse_event_invalid",
                    message,
                )
            },
        )?;
        let Some(outcome) = parsed else {
            if data.trim() == "[DONE]" {
                self.seen_done = true;
            }
            return Ok(());
        };
        match outcome {
            V3ProviderResponsesJsonFrameOutcome::Failure { code, message } => {
                return Err(build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    code,
                    message,
                ));
            }
            V3ProviderResponsesJsonFrameOutcome::Terminal
            | V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput => self.terminal = true,
            V3ProviderResponsesJsonFrameOutcome::ContinueBuffering => {}
            V3ProviderResponsesJsonFrameOutcome::StartClientStream => {}
        }
        Ok(())
    }

    pub(super) async fn record_failure(
        &mut self,
        source: &V3Error01SourceRaised,
    ) -> Result<(), String> {
        if self.recorded || !matches!(source.source_kind, V3ErrorSourceKind::ProviderFailure) {
            return Ok(());
        }
        if self.provider_health_neutral {
            self.recorded = true;
            return Ok(());
        }
        drop(self._provider_action_permit.take());
        self.provider_health
            .record_post_commit_provider_stream_failure_from_source(
                &self.failure_session_scope,
                &self.provider_id,
                Some(&self.auth_alias),
                Some(&self.model_id),
                source,
            )?;
        self.recorded = true;
        Ok(())
    }

    pub(super) fn record_success(&mut self) -> Result<(), String> {
        if self.recorded {
            return Ok(());
        }
        if self.provider_health_neutral {
            self.recorded = true;
            return Ok(());
        }
        self.provider_health
            .record_provider_success_in_failure_scope(
                &self.failure_session_scope,
                &self.provider_id,
                Some(&self.auth_alias),
                Some(&self.model_id),
                v3_relay_provider_policy_now_epoch_ms()?,
            )?;
        self.recorded = true;
        Ok(())
    }
}

pub(super) fn wrap_direct_sse_provider_outcome_stream(
    source: V3ClientSseStream,
    provider_outcome: V3DirectSseProviderOutcome,
    runtime_timing: V3RuntimeTimingState,
    stream_observation: V3RuntimeStreamObservation,
) -> V3ClientSseStream {
    wrap_direct_sse_provider_outcome_stream_with_terminal_commit(
        source,
        provider_outcome,
        runtime_timing,
        stream_observation,
        None,
        None,
    )
}

pub(super) fn wrap_direct_sse_provider_outcome_stream_with_terminal_commit(
    source: V3ClientSseStream,
    provider_outcome: V3DirectSseProviderOutcome,
    runtime_timing: V3RuntimeTimingState,
    stream_observation: V3RuntimeStreamObservation,
    route_policy_terminal_commit: Option<Arc<dyn Fn() -> Result<(), String> + Send + Sync>>,
    handoff: Option<V3DirectSseProviderHandoff>,
) -> V3ClientSseStream {
    struct StreamState {
        source: V3ClientSseStream,
        decoder: SseIncrementalDecoder,
        provider_outcome: V3DirectSseProviderOutcome,
        runtime_timing: V3RuntimeTimingState,
        stream_observation: V3RuntimeStreamObservation,
        route_policy_terminal_commit: Option<Arc<dyn Fn() -> Result<(), String> + Send + Sync>>,
        handoff: Option<V3DirectSseProviderHandoff>,
        handoff_active: bool,
        handoff_emitted_frame: bool,
        source_exhausted: bool,
        client_committed: bool,
        done: bool,
    }

    Box::pin(stream::unfold(
        StreamState {
            source,
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            provider_outcome,
            runtime_timing,
            stream_observation,
            route_policy_terminal_commit,
            handoff,
            handoff_active: false,
            handoff_emitted_frame: false,
            source_exhausted: false,
            client_committed: false,
            done: false,
        },
        |mut state| async move {
            if state.done {
                return None;
            }
            loop {
                let next = if state.source_exhausted {
                    None
                } else {
                    match state.source.next().await {
                        Some(item) => Some(item),
                        None => {
                            state.source_exhausted = true;
                            None
                        }
                    }
                };
                match next {
                    Some(Ok(chunk)) => {
                        if state.handoff_active {
                            state.client_committed |=
                                direct_sse_frame_commits_client_stream(&chunk);
                            state.handoff_emitted_frame = true;
                            return Some((Ok(chunk), state));
                        }
                        return match state
                            .provider_outcome
                            .observe_chunk(&chunk, &mut state.decoder)
                        {
                            Ok(()) => {
                                state.client_committed |=
                                    direct_sse_frame_commits_client_stream(&chunk);
                                Some((Ok(chunk), state))
                            }
                            Err(source) => {
                                let result = state
                                    .provider_outcome
                                    .record_failure(&source)
                                    .await
                                    .map_err(|error| {
                                        runtime_source("V3ProviderActionGateAdmission", error)
                                    });
                                if let Err(error) = result {
                                    state.done = true;
                                    return Some((Err(error), state));
                                }
                                if !state.client_committed {
                                    if let Some(handoff) = state.handoff.take() {
                                        if let Some(next_stream) =
                                            handoff(source.message.clone()).await
                                        {
                                            state.source = next_stream;
                                            state.handoff_active = true;
                                            state.handoff_emitted_frame = false;
                                            state.source_exhausted = false;
                                            continue;
                                        }
                                    }
                                }
                                state.done = true;
                                return Some((Err(source), state));
                            }
                        };
                    }
                    Some(Err(source)) => {
                        let result = state
                            .provider_outcome
                            .record_failure(&source)
                            .await
                            .map_err(|error| {
                                runtime_source("V3ProviderActionGateAdmission", error)
                            });
                        if let Err(error) = result {
                            state.done = true;
                            return Some((Err(error), state));
                        }
                        if !state.client_committed {
                            if let Some(handoff) = state.handoff.take() {
                                if let Some(next_stream) = handoff(source.message.clone()).await {
                                    state.source = next_stream;
                                    state.handoff_active = true;
                                    state.handoff_emitted_frame = false;
                                    state.source_exhausted = false;
                                    continue;
                                }
                            }
                        }
                        state.done = true;
                        return Some((Err(source), state));
                    }
                    None => {
                        if state.handoff_active && !state.handoff_emitted_frame {
                            state.done = true;
                            return Some((
                                Err(build_v3_error_01_source_raised(
                                    V3ErrorSourceKind::ProviderFailure,
                                    "V3ProviderResp14Raw",
                                    "provider_sse_handoff_empty_stream",
                                    "provider handoff stream ended without a frame",
                                )),
                                state,
                            ));
                        }
                        if state.handoff_active {
                            state.done = true;
                            return None;
                        }
                        if state.provider_outcome.terminal
                            && !state.provider_outcome.seen_done
                            && matches!(
                                state.provider_outcome.provider_protocol,
                                V3HubProviderWireProtocol::Responses
                                    | V3HubProviderWireProtocol::OpenAiChat
                            )
                        {
                            state.provider_outcome.seen_done = true;
                            return Some((Ok(b"data: [DONE]\n\n".to_vec()), state));
                        }
                        let decoder = std::mem::replace(
                            &mut state.decoder,
                            SseIncrementalDecoder::new(SseTransportLimits::default()),
                        );
                        if let Err(error) = decoder.finish() {
                            let source = build_v3_error_01_source_raised(
                                V3ErrorSourceKind::ProviderFailure,
                                "V3ProviderResp14Raw",
                                "provider_response_sse_transport_invalid",
                                error.to_string(),
                            );
                            let result = state
                                .provider_outcome
                                .record_failure(&source)
                                .await
                                .map_err(|error| {
                                    runtime_source("V3ProviderActionGateAdmission", error)
                                });
                            if let Err(error) = result {
                                state.done = true;
                                return Some((Err(error), state));
                            }
                            if !state.client_committed {
                                if let Some(handoff) = state.handoff.take() {
                                    if let Some(next_stream) = handoff(source.message.clone()).await
                                    {
                                        state.source = next_stream;
                                        state.handoff_active = true;
                                        state.handoff_emitted_frame = false;
                                        state.source_exhausted = false;
                                        continue;
                                    }
                                }
                            }
                            state.done = true;
                            return Some((Err(source), state));
                        }
                        if !state.provider_outcome.terminal {
                            let terminal_name = match state.provider_outcome.provider_protocol {
                                V3HubProviderWireProtocol::Responses => "response.completed",
                                V3HubProviderWireProtocol::Anthropic => "message_stop",
                                V3HubProviderWireProtocol::OpenAiChat => "finish_reason",
                                V3HubProviderWireProtocol::Gemini => "turn_complete",
                            };
                            let source = build_v3_error_01_source_raised(
                                V3ErrorSourceKind::ProviderFailure,
                                "V3ProviderResp14Raw",
                                "provider_response_sse_terminal_missing",
                                if state.provider_outcome.seen_done {
                                    format!(
                                        "provider {:?} SSE emitted [DONE] without {terminal_name}",
                                        state.provider_outcome.provider_protocol
                                    )
                                } else {
                                    format!(
                                        "provider {:?} SSE ended without {terminal_name}",
                                        state.provider_outcome.provider_protocol
                                    )
                                },
                            );
                            let result = state
                                .provider_outcome
                                .record_failure(&source)
                                .await
                                .map_err(|error| {
                                    runtime_source("V3ProviderActionGateAdmission", error)
                                });
                            if let Err(error) = result {
                                state.done = true;
                                return Some((Err(error), state));
                            }
                            if !state.client_committed {
                                if let Some(handoff) = state.handoff.take() {
                                    if let Some(next_stream) = handoff(source.message.clone()).await
                                    {
                                        state.source = next_stream;
                                        state.handoff_active = true;
                                        state.handoff_emitted_frame = false;
                                        state.source_exhausted = false;
                                        continue;
                                    }
                                }
                            }
                            state.done = true;
                            return Some((Err(source), state));
                        }
                        state.done = true;
                        if let Err(error) = state.provider_outcome.record_success() {
                            return Some((
                                Err(runtime_source("V3ProviderHealthStateMutated", error)),
                                state,
                            ));
                        }
                        let timing = match state.runtime_timing.finish_runtime() {
                            Ok(timing) => timing,
                            Err(error) => {
                                return Some((
                                    Err(runtime_source("V3RuntimeTimingTerminal", error)),
                                    state,
                                ));
                            }
                        };
                        return match state.stream_observation.record_timing(timing) {
                            Ok(()) => match state
                                .route_policy_terminal_commit
                                .as_ref()
                                .map(|commit| commit())
                            {
                                Some(Err(error)) => Some((
                                    Err(runtime_source("V3Router06RoutePoolResolved", error)),
                                    state,
                                )),
                                _ => None,
                            },
                            Err(error) => {
                                Some((Err(runtime_source("V3RuntimeTimingTerminal", error)), state))
                            }
                        };
                    }
                }
            }
        },
    ))
}

/// Runtime-owned Direct Broker handoff for a stream that has already crossed
/// the provider outcome parser. This wrapper only consumes typed Error01 and
/// swaps in the next runtime-owned attempt; it never manufactures a client
/// frame or treats provider failure as EOF.
pub(super) fn wrap_direct_sse_provider_handoff_stream<F, Fut>(
    source: V3ClientSseStream,
    handoff: F,
    handoff_budget: Option<usize>,
) -> V3ClientSseStream
where
    F: Fn(String) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = Option<V3DirectSseProviderAttempt>> + Send + 'static,
{
    Box::pin(stream::unfold(
        // The first provider attempt is already part of the handoff contract:
        // an EOF without a terminal event must be treated as a provider
        // failure and offered to the next attempt, never as client success.
        // The initial source is already wrapped by the typed provider outcome
        // codec. Replacement attempts carry the same validation bit explicitly.
        (source, handoff, handoff_budget, true, false, false, true),
        |(
            mut source,
            handoff,
            mut handoff_budget,
            mut handoff_active,
            mut handoff_emitted_frame,
            mut handoff_client_committed,
            mut handoff_terminal_validated,
        )| async move {
            loop {
                match source.next().await {
                    Some(Ok(frame)) => {
                        if handoff_active {
                            handoff_emitted_frame = true;
                            handoff_client_committed |=
                                direct_sse_frame_commits_client_stream(&frame);
                        }
                        return Some((
                            Ok(frame),
                            (
                                source,
                                handoff,
                                handoff_budget,
                                handoff_active,
                                handoff_emitted_frame,
                                handoff_client_committed,
                                handoff_terminal_validated,
                            ),
                        ));
                    }
                    Some(Err(error))
                        if !handoff_client_committed
                            && handoff_budget.is_none_or(|budget| budget > 0) =>
                    {
                        let Some(next) = handoff.clone()(error.message.clone()).await else {
                            return Some((
                                Err(error),
                                (
                                    Box::pin(stream::empty()),
                                    handoff,
                                    Some(0),
                                    false,
                                    handoff_emitted_frame,
                                    handoff_client_committed,
                                    handoff_terminal_validated,
                                ),
                            ));
                        };
                        source = next.stream;
                        if let Some(budget) = handoff_budget.as_mut() {
                            *budget = budget.saturating_sub(1);
                        }
                        handoff_active = true;
                        handoff_emitted_frame = false;
                        handoff_client_committed = false;
                        handoff_terminal_validated = next.terminal_validated;
                    }
                    Some(Err(error)) => {
                        return Some((
                            Err(error),
                            (
                                Box::pin(stream::empty()),
                                handoff,
                                Some(0),
                                false,
                                handoff_emitted_frame,
                                handoff_client_committed,
                                handoff_terminal_validated,
                            ),
                        ));
                    }
                    None if handoff_active && handoff_terminal_validated => return None,
                    None if handoff_active => {
                        return Some((
                            Err(build_v3_error_01_source_raised(
                                V3ErrorSourceKind::ProviderFailure,
                                "V3ProviderResp14Raw",
                                "provider_sse_handoff_terminal_missing",
                                "provider handoff stream ended without codec-validated terminal event",
                            )),
                            (
                                Box::pin(stream::empty()),
                                handoff,
                                Some(0),
                                false,
                                handoff_emitted_frame,
                                handoff_client_committed,
                                handoff_terminal_validated,
                            ),
                        ));
                    }
                    None => return None,
                }
            }
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::{wrap_direct_sse_provider_handoff_stream, V3DirectSseProviderAttempt};
    use crate::nodes::V3ClientSseStream;
    use futures_util::StreamExt;
    use routecodex_v3_error::{build_v3_error_01_source_raised, V3ErrorSourceKind};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn provider_failure() -> routecodex_v3_error::V3Error01SourceRaised {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_sse_stream",
            "provider stream failed after the response was admitted",
        )
    }

    #[tokio::test]
    async fn provider_failure_before_terminal_is_handed_off_without_client_error() {
        let handoff_calls = Arc::new(AtomicUsize::new(0));
        let calls = handoff_calls.clone();
        let source: V3ClientSseStream =
            Box::pin(futures_util::stream::iter(vec![Err(provider_failure())]));
        let stream = wrap_direct_sse_provider_handoff_stream(
            source,
            move |_message| {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Some(V3DirectSseProviderAttempt {
                        stream: Box::pin(futures_util::stream::iter(vec![Ok(
                            b"data: {\"type\":\"response.completed\"}\n\ndata: [DONE]\n\n".to_vec(),
                        )])) as V3ClientSseStream,
                        terminal_validated: true,
                    })
                }
            },
            None,
        );

        let frames = stream.collect::<Vec<_>>().await;
        assert_eq!(handoff_calls.load(Ordering::SeqCst), 1);
        assert!(frames.iter().all(Result::is_ok));
        assert!(frames
            .iter()
            .flatten()
            .any(|frame| frame.as_slice() == b"data: [DONE]\n\n"));
    }

    #[tokio::test]
    async fn codec_validated_initial_attempt_ends_cleanly() {
        let handoff_calls = Arc::new(AtomicUsize::new(0));
        let calls = handoff_calls.clone();
        let source: V3ClientSseStream = Box::pin(futures_util::stream::iter(vec![Ok(
            b"data: {\"type\":\"response.completed\"}\n\ndata: [DONE]\n\n".to_vec(),
        )]));
        let stream = wrap_direct_sse_provider_handoff_stream(
            source,
            move |_message| {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    None::<V3DirectSseProviderAttempt>
                }
            },
            None,
        );

        let frames = stream.collect::<Vec<_>>().await;
        assert_eq!(handoff_calls.load(Ordering::SeqCst), 0);
        assert_eq!(frames.len(), 1);
        assert!(frames[0].is_ok());
    }

    #[tokio::test]
    async fn provider_failure_after_handoff_is_exposed_only_when_handoff_is_exhausted() {
        let source: V3ClientSseStream =
            Box::pin(futures_util::stream::iter(vec![Err(provider_failure())]));
        let stream = wrap_direct_sse_provider_handoff_stream(
            source,
            |_message| async { None::<V3DirectSseProviderAttempt> },
            None,
        );

        let frames = stream.collect::<Vec<_>>().await;
        assert_eq!(frames.len(), 1);
        assert!(frames[0].is_err());
    }
}
