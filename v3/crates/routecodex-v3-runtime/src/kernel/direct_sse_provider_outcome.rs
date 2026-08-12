use super::*;
use crate::hub_v1::{
    classify_v3_provider_generic_sse_json_data, V3ProviderResponsesJsonFrameOutcome,
};
pub(super) struct V3DirectSseProviderOutcome {
    pub(super) provider_health: V3ProviderFailureRuntimeHealth,
    pub(super) failure_session_scope: V3ProviderFailureSessionScope,
    pub(super) provider_id: String,
    pub(super) auth_alias: String,
    pub(super) model_id: String,
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
        let mut data = String::new();
        for field in fields {
            let SseField::Named { name, value } = field else {
                continue;
            };
            if name == "data" {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value);
            }
        }
        let parsed = classify_v3_provider_generic_sse_json_data(&data).map_err(|message| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                "provider_response_sse_event_invalid",
                message,
            )
        })?;
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
            V3ProviderResponsesJsonFrameOutcome::Terminal => self.terminal = true,
            V3ProviderResponsesJsonFrameOutcome::ContinueBuffering
            | V3ProviderResponsesJsonFrameOutcome::StartClientStream => {}
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
            .record_post_commit_provider_stream_failure(
                &self.failure_session_scope,
                &self.provider_id,
                Some(&self.auth_alias),
                Some(&self.model_id),
                &source.code,
                &source.message,
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
    struct StreamState {
        source: V3ClientSseStream,
        decoder: SseIncrementalDecoder,
        provider_outcome: V3DirectSseProviderOutcome,
        runtime_timing: V3RuntimeTimingState,
        stream_observation: V3RuntimeStreamObservation,
        done: bool,
    }

    Box::pin(stream::unfold(
        StreamState {
            source,
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            provider_outcome,
            runtime_timing,
            stream_observation,
            done: false,
        },
        |mut state| async move {
            if state.done {
                return None;
            }
            match state.source.next().await {
                Some(Ok(chunk)) => {
                    match state
                        .provider_outcome
                        .observe_chunk(&chunk, &mut state.decoder)
                    {
                        Ok(()) => Some((Ok(chunk), state)),
                        Err(source) => {
                            state.done = true;
                            let result = state
                                .provider_outcome
                                .record_failure(&source)
                                .await
                                .map_err(|error| {
                                    runtime_source("V3ProviderActionGateAdmission", error)
                                })
                                .and(Err(source));
                            Some((result, state))
                        }
                    }
                }
                Some(Err(source)) => {
                    state.done = true;
                    let result = state
                        .provider_outcome
                        .record_failure(&source)
                        .await
                        .map_err(|error| runtime_source("V3ProviderActionGateAdmission", error))
                        .and(Err(source));
                    Some((result, state))
                }
                None => {
                    state.done = true;
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
                            .map_err(|error| runtime_source("V3ProviderActionGateAdmission", error))
                            .and(Err(source));
                        return Some((result, state));
                    }
                    if !state.provider_outcome.terminal {
                        let source = build_v3_error_01_source_raised(
                            V3ErrorSourceKind::ProviderFailure,
                            "V3ProviderResp14Raw",
                            "provider_response_sse_terminal_missing",
                            if state.provider_outcome.seen_done {
                                "provider Responses SSE emitted [DONE] without response.completed"
                            } else {
                                "provider Responses SSE ended without response.completed"
                            },
                        );
                        let result = state
                            .provider_outcome
                            .record_failure(&source)
                            .await
                            .map_err(|error| runtime_source("V3ProviderActionGateAdmission", error))
                            .and(Err(source));
                        return Some((result, state));
                    }
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
                    match state.stream_observation.record_timing(timing) {
                        Ok(()) => None,
                        Err(error) => {
                            Some((Err(runtime_source("V3RuntimeTimingTerminal", error)), state))
                        }
                    }
                }
            }
        },
    ))
}
