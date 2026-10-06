use super::*;

pub(super) fn provider_failure_output(
    failure: V3RelayProviderFailure,
    mut trace: Vec<&'static str>,
) -> V3OpenAiChatRelayRuntimeOutput {
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
    }
}

pub(super) fn error_output(
    source: routecodex_v3_error::V3Error01SourceRaised,
    status: u16,
    provider_id: &str,
    mut trace: Vec<&'static str>,
) -> V3OpenAiChatRelayRuntimeOutput {
    let (projected, trace, terminal_disposition) = if matches!(
        &source.source_kind,
        routecodex_v3_error::V3ErrorSourceKind::ProviderFailure
            | routecodex_v3_error::V3ErrorSourceKind::ProviderLocalFailure
    ) {
        let (projected, disposition) =
            crate::hub_v1::relay_runtime_shared::project_unscoped_provider_failure(source);
        trace.extend(routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS);
        (projected, trace, Some(disposition))
    } else {
        let (projected, trace) = crate::hub_v1::error_output(source, status, provider_id, trace);
        (projected, trace, None)
    };
    let error_class = projected.error_class;
    let error_detail = projected.error_detail.clone();
    V3OpenAiChatRelayRuntimeOutput {
        status: projected.status,
        terminal_disposition,
        client_body: V3OpenAiChatRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        error_class: Some(error_class),
        error_detail: Some(error_detail),
        observability: None,
        stream_observation: None,
        provider_snapshots: None,
    }
}
