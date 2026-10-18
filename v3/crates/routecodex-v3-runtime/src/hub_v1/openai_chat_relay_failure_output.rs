use super::*;

pub(super) fn provider_failure_output(
    failure: V3RelayProviderFailure,
    mut trace: Vec<&'static str>,
    provider_failure_attempts: Vec<V3RuntimeProviderFailureObservation>,
) -> V3OpenAiChatRelayRuntimeOutput {
    if let Some(fault) = failure.error_operator_fault {
        return V3OpenAiChatRelayRuntimeOutput {
            status: 499,
            terminal_disposition: Some(
                routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse,
            ),
            client_body: V3OpenAiChatRelayClientBody::Json(Value::Null),
            node_trace: trace,
            error_chain: None,
            error_class: None,
            error_detail: None,
            observability: None,
            stream_observation: None,
            provider_snapshots: None,
            provider_failure_attempts,
            diagnostic_source: Some(fault.policy_failure),
            diagnostic_cause: fault.original_source,
        };
    }
    let projected = failure
        .terminal_projection
        .expect("terminal OpenAI Chat provider failure must carry typed Error06 projection");
    let error_class = projected.error_class;
    let error_detail = projected.error_detail.clone();
    trace.push("V3Error06ClientProjected");
    V3OpenAiChatRelayRuntimeOutput {
        status: projected.status,
        terminal_disposition: failure.terminal_disposition,
        client_body: V3OpenAiChatRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        error_class: Some(error_class),
        error_detail: Some(error_detail),
        observability: None,
        stream_observation: None,
        provider_snapshots: None,
        provider_failure_attempts,
        diagnostic_source: Some(projected.diagnostic_source),
        diagnostic_cause: None,
    }
}

pub(super) fn error_output(
    source: routecodex_v3_error::V3Error01SourceRaised,
    status: u16,
    provider_id: &str,
    mut trace: Vec<&'static str>,
) -> V3OpenAiChatRelayRuntimeOutput {
    let (projected, trace) = crate::hub_v1::error_output(source, status, provider_id, trace);
    let error_class = projected.error_class;
    let error_detail = projected.error_detail.clone();
    V3OpenAiChatRelayRuntimeOutput {
        status: projected.status,
        terminal_disposition: None,
        client_body: V3OpenAiChatRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        error_class: Some(error_class),
        error_detail: Some(error_detail),
        provider_failure_attempts: Vec::new(),
        diagnostic_source: Some(projected.diagnostic_source),
        diagnostic_cause: None,
        observability: None,
        stream_observation: None,
        provider_snapshots: None,
    }
}
