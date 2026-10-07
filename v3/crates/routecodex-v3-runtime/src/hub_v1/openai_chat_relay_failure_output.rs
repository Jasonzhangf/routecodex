use super::*;

pub(super) fn openai_chat_provider_http_failure(
    status: u16,
    body: &[u8],
    _provider_id: &str,
) -> V3RelayProviderFailure {
    let body = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) if body.is_empty() => json!({
            "error": {
                "type": "provider_error",
                "message": format!("provider returned HTTP {status}")
            }
        }),
        Err(error) => json!({
            "error": {
                "type": "provider_error",
                "message": format!("provider returned HTTP {status} with malformed JSON error body: {error}")
            }
        }),
    };
    V3RelayProviderFailure {
        status,
        provider_status: Some(status),
        original_source: None,
        client_response: body,
        source_stage: "V3ProviderReqOutbound09TransportRequest",
        terminal_projection: None,
        terminal_disposition: None,
        error_type_fn: extract_error_type_style,
        error_message_fn: extract_message_type_style,
    }
}

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
        request_finalizer: None,
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
        request_finalizer: None,
    }
}

impl From<String> for V3OpenAiChatRelayRuntimeError {
    fn from(value: String) -> Self {
        Self::Target(value)
    }
}

pub fn project_v3_openai_chat_relay_runtime_failure(
    error: V3OpenAiChatRelayRuntimeError,
) -> V3OpenAiChatRelayRuntimeOutput {
    let request_payload_invalid = matches!(
        &error,
        V3OpenAiChatRelayRuntimeError::ProviderCompat(error)
            if error.classification() == V3ProviderCompatErrorClassification::RequestPayloadInvalid
    );
    let provider_pool_exhausted = matches!(
        &error,
        V3OpenAiChatRelayRuntimeError::ProviderPoolExhausted { .. }
    );
    let source = match error {
        V3OpenAiChatRelayRuntimeError::ProviderPoolExhausted {
            attempted_candidates,
        } => provider_pool_exhausted_source(
            "V3Target10ConcreteProviderSelected",
            &attempted_candidates,
        ),
        V3OpenAiChatRelayRuntimeError::ProviderCompat(error) => match error.classification() {
            V3ProviderCompatErrorClassification::PayloadBoundaryViolation => {
                super::provider_compat_boundary_source("ProviderRespCompat02ProviderCompat", &error)
            }
            V3ProviderCompatErrorClassification::RequestPayloadInvalid => {
                super::provider_request_payload_source("ProviderReqCompat06ProviderCompat", &error)
            }
            V3ProviderCompatErrorClassification::Other => build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3HubRuntime",
                "openai_chat_relay_runtime_error",
                error.to_string(),
            ),
        },
        V3OpenAiChatRelayRuntimeError::Provider(error) => {
            crate::hooks::build_v3_provider_error_source("V3Transport13ResponsesHttpRequest", error)
        }
        error => build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3HubRuntime",
            "openai_chat_relay_runtime_error",
            error.to_string(),
        ),
    };
    let mut output = error_output(
        source,
        if request_payload_invalid { 400 } else { 500 },
        "none",
        Vec::new(),
    );
    if provider_pool_exhausted {
        output.terminal_disposition =
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse);
    }
    output
}
