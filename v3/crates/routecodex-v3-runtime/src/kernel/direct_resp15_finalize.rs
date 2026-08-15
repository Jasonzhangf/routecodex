use crate::runtime_timing::V3RuntimeTimingSummary;
use crate::shared::V3ProviderResponseProjection;
fn finalize_v3_direct_resp15_output(
    provider_health: &V3ProviderFailureRuntimeHealth,
    direct_failure_session_scope: &V3ProviderFailureSessionScope,
    policy: &V3ResponsesDirect11Policy,
    now_epoch_ms: u64,
    provider_health_neutral: bool,
    trace: &mut Vec<&'static str>,
    hook_registry: &V3HookRegistry,
    runtime_timing: V3RuntimeTimingSummary,
    accumulator: &V3RuntimeObservabilityAccumulator,
    send_attempts: usize,
    response_projection: V3ProviderResponseProjection,
    provider_status: u16,
    provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
    direct_stopless_projected: bool,
) -> V3ResponsesDirectRuntimeOutput {
    if !provider_health_neutral {
        if let Err(source) = record_v3_direct_provider_success(
            provider_health,
            direct_failure_session_scope,
            &policy.target,
            now_epoch_ms,
        ) {
            return error_output(source, std::mem::take(trace), hook_registry);
        }
    }
    trace.push("V3DirectResp15ClientPayloadReady");
    trace.push("V3Resp15ClientPayload");
    let mut observability = build_v3_direct_runtime_observability(
        &policy.target,
        "responses",
        v3_direct_client_transport_label(&response_projection.client_payload),
        Some(provider_status),
        "completed",
        provider_failure_events,
        direct_stopless_projected,
    );
    observability.attempts = Some(total_attempts(accumulator, send_attempts));
    observability.timing = Some(runtime_timing);

    V3ResponsesDirectRuntimeOutput {
        observability: Some(observability),
        stream_observation: None,
        client_payload: response_projection.client_payload,
        node_trace: std::mem::take(trace),
        error_chain: None,
        protocol_relay_handoff: None,
    }
}

fn finalize_v3_direct_resp15_streaming_output(
    policy: &V3ResponsesDirect11Policy,
    provider_status: u16,
    provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
    direct_stopless_active: bool,
    accumulator: &V3RuntimeObservabilityAccumulator,
    send_attempts: usize,
    response_projection: V3ProviderResponseProjection,
    stream_observation: V3RuntimeStreamObservation,
    trace: &mut Vec<&'static str>,
) -> V3ResponsesDirectRuntimeOutput {
    trace.push("V3DirectResp15ClientPayloadReady");
    trace.push("V3Resp15ClientPayload");
    let mut observability = build_v3_direct_runtime_observability(
        &policy.target,
        "responses",
        v3_direct_client_transport_label(&response_projection.client_payload),
        Some(provider_status),
        "streaming",
        provider_failure_events,
        direct_stopless_active,
    );
    observability.attempts = Some(total_attempts(accumulator, send_attempts));
    V3ResponsesDirectRuntimeOutput {
        observability: Some(observability),
        stream_observation: Some(stream_observation),
        client_payload: response_projection.client_payload,
        node_trace: std::mem::take(trace),
        error_chain: None,
        protocol_relay_handoff: None,
    }
}

fn wrap_v3_direct_sse_provider_stream_for_outcome(
    client_body: &mut V3ClientBody,
    provider_health: V3ProviderFailureRuntimeHealth,
    direct_failure_session_scope: &V3ProviderFailureSessionScope,
    policy: &V3ResponsesDirect11Policy,
    provider_health_neutral: bool,
    provider_action_permit: &mut Option<V3ProviderActionPermit>,
    runtime_timing: V3RuntimeTimingState,
    stream_observation: V3RuntimeStreamObservation,
) {
    let body = std::mem::replace(client_body, V3ClientBody::Bytes(Vec::new()));
    *client_body = match body {
        V3ClientBody::Sse(stream) => V3ClientBody::Sse(wrap_direct_sse_provider_outcome_stream(
            stream,
            V3DirectSseProviderOutcome {
                provider_health,
                failure_session_scope: direct_failure_session_scope.clone(),
                provider_id: policy.target.candidate.provider_id.clone(),
                auth_alias: policy.target.candidate.auth_alias.clone(),
                model_id: policy.target.candidate.model_id.clone(),
                terminal: false,
                seen_done: false,
                recorded: false,
                provider_health_neutral,
                _provider_action_permit: provider_action_permit.take(),
            },
            runtime_timing,
            stream_observation,
        )),
        other => other,
    };
}

fn wrap_v3_direct_sse_remote_stream_for_outcome(
    client_body: &mut V3ClientBody,
    continuation_state: V3ResponsesDirectContinuationState,
    scope: &V3ResponsesDirectContinuationScope,
    previous_response_id: Option<String>,
    selected_pin: V3RemoteContinuationPin,
    selected_capability_revision: String,
    now_epoch_ms: u64,
    state: V3SseRemoteContinuationObservationState,
) {
    let body = std::mem::replace(client_body, V3ClientBody::Bytes(Vec::new()));
    *client_body = match body {
        V3ClientBody::Sse(stream) => {
            let policy = V3DirectSseRemoteContinuationPolicy {
                state: continuation_state,
                scope_key: scope.key.clone(),
                previous_response_id,
                selected_pin,
                selected_capability_revision,
                now_epoch_ms,
                committed_pending: false,
            };
            V3ClientBody::Sse(wrap_direct_sse_remote_continuation_stream(
                stream, state, policy,
            ))
        }
        other => other,
    };
}
