use super::*;
use routecodex_v3_error::V3_TRANSIENT_TRANSPORT_HANG_CODE;
use serde_json::{json, Value};

/// relay transport 挂起判定的固定 reason：与 `responses_relay_runtime_inner.rs`
/// 的响应头等待超时构造保持一致，作为「瞬态挂起」的单一真源。
pub(crate) const V3_RELAY_TRANSPORT_HANG_REASON: &str =
    "provider transport did not return response headers within timeout";

pub(crate) fn server_routing_group(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> Result<String, V3ResponsesRelayRuntimeError> {
    manifest
        .servers
        .get(server_id)
        .map(|server| server.routing_group.clone())
        .ok_or_else(|| V3ResponsesRelayRuntimeError::Target("server missing".to_string()))
}

pub(crate) fn allowed_execution_modes_for_relay_server(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> Result<Vec<String>, V3ResponsesRelayRuntimeError> {
    let server = manifest.servers.get(server_id).ok_or_else(|| {
        V3ResponsesRelayRuntimeError::Target(format!("server {server_id} missing"))
    })?;
    Ok(server
        .execution
        .as_ref()
        .map(|execution| execution.allowed_modes.clone())
        .unwrap_or_else(|| vec!["relay".to_string()]))
}

pub(crate) fn provider_http_failure(
    status: u16,
    body: &[u8],
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    let body = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(error) => json!({
            "error": {
                "type": "provider_error",
                "message": format!("provider returned HTTP {status} with malformed JSON error body: {error}")
            }
        }),
    };
    let policy_error_type = v3_provider_failure_error_type_from_body(&body);
    let policy_error_message = v3_provider_failure_message_from_body(&body);
    V3ResponsesRelayProviderFailure {
        status,
        policy_error_type,
        policy_error_message,
        provider_id: provider_id.to_string(),
        source_stage: "V3ProviderReqOutbound09TransportRequest",
        observability,
        terminal_projection: None,
    }
}

pub(crate) fn provider_runtime_failure(
    error: V3ProviderError,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    let terminal_projection =
        matches!(&error, V3ProviderError::ClientDisconnect { .. }).then(|| {
            project_v3_client_disconnect(
                provider_id,
                provider_runtime_failure_stage(&error),
                error.to_string(),
            )
        });
    let policy_error_message = error.to_string();
    // transport 响应头挂起由错误处理中心按「transport 阶段 + 专属类别码」判定为
    // 瞬态（health-neutral 同 provider 重试 3 次）；其余 transport 错误保持原策略。
    let policy_error_type = if matches!(
        &error,
        V3ProviderError::Transport { reason, .. }
            if reason == V3_RELAY_TRANSPORT_HANG_REASON
    ) {
        V3_TRANSIENT_TRANSPORT_HANG_CODE.to_string()
    } else {
        "provider_runtime_error".to_string()
    };
    V3ResponsesRelayProviderFailure {
        status: if terminal_projection.is_some() {
            499
        } else {
            502
        },
        policy_error_type,
        policy_error_message: policy_error_message.clone(),
        provider_id: provider_id.to_string(),
        source_stage: provider_runtime_failure_stage(&error),
        observability,
        terminal_projection,
    }
}

pub(crate) fn provider_semantic_failure(
    status: u16,
    error: responses_relay_diagnostics::V3ProviderSemanticErrorProjection,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    let policy_error_type = error.code.clone();
    let policy_error_message = error.message.clone();
    V3ResponsesRelayProviderFailure {
        status,
        policy_error_type,
        policy_error_message,
        provider_id: provider_id.to_string(),
        source_stage: "V3ProviderRespInbound01Raw",
        observability,
        terminal_projection: None,
    }
}

pub(crate) fn provider_response_stream_relay_failure(
    error: V3ResponsesRelayRuntimeError,
    request_id: &str,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    match error {
        V3ResponsesRelayRuntimeError::ProviderResponseSemanticFailure {
            status,
            code,
            message,
        } => V3ResponsesRelayProviderFailure {
            status,
            policy_error_type: code.clone(),
            policy_error_message: message.clone(),
            provider_id: provider_id.to_string(),
            source_stage: "V3ProviderRespInbound01Raw",
            observability,
            terminal_projection: None,
        },
        other => provider_runtime_failure(
            provider_response_stream_failure(other, request_id, provider_id),
            provider_id,
            observability,
        ),
    }
}

pub(crate) fn provider_request_relay_failure(
    error: V3ResponsesRelayRuntimeError,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> Result<V3ResponsesRelayProviderFailure, V3ResponsesRelayRuntimeError> {
    let (source_stage, error_type, message) = match error {
        V3ResponsesRelayRuntimeError::ProviderCompat(error) => (
            "ProviderReqCompat06ProviderCompat",
            "provider_request_compat_error",
            format!("V3 Responses Relay provider compat failed: {error}"),
        ),
        V3ResponsesRelayRuntimeError::ProviderWireEncoding(message) => (
            "V3ProviderReqOutbound08WirePayload",
            "provider_request_wire_error",
            format!("V3 Responses Relay provider wire encoding failed: {message}"),
        ),
        V3ResponsesRelayRuntimeError::Provider(error) => (
            "V3ProviderReqOutbound08WirePayload",
            "provider_request_wire_error",
            error.to_string(),
        ),
        other => return Err(other),
    };
    Ok(V3ResponsesRelayProviderFailure {
        status: 502,
        policy_error_type: error_type.to_string(),
        policy_error_message: message.clone(),
        provider_id: provider_id.to_string(),
        source_stage,
        observability,
        terminal_projection: None,
    })
}

pub(crate) fn provider_response_stream_failure(
    error: V3ResponsesRelayRuntimeError,
    request_id: &str,
    provider_id: &str,
) -> V3ProviderError {
    match error {
        V3ResponsesRelayRuntimeError::Provider(error) => error,
        V3ResponsesRelayRuntimeError::ProviderSseTransport(reason) => {
            V3ProviderError::MalformedSse {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                reason: format!("provider SSE transport failed: {reason}"),
            }
        }
        other => V3ProviderError::ResponseBody {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: format!("provider response event codec failed: {other}"),
        },
    }
}

pub(crate) fn is_v3_responses_provider_response_failure(error: &V3ResponsesRelayRuntimeError) -> bool {
    matches!(
        error,
        V3ResponsesRelayRuntimeError::Provider(_)
            | V3ResponsesRelayRuntimeError::ProviderJson(_)
            | V3ResponsesRelayRuntimeError::ProviderSseTransport(_)
            | V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(_)
            | V3ResponsesRelayRuntimeError::ProviderResponseSemanticFailure { .. }
            | V3ResponsesRelayRuntimeError::Response(
                V3HubRelayResponseError::ProviderResponseNotObject
                    | V3HubRelayResponseError::SideChannelLeaked { .. }
                    | V3HubRelayResponseError::ProviderResponseOutputNotArray
                    | V3HubRelayResponseError::MalformedToolCall { .. }
                    | V3HubRelayResponseError::MissingStatus
                    | V3HubRelayResponseError::UnsupportedStatus { .. }
                    | V3HubRelayResponseError::ProviderProtocolResponseMalformed { .. }
                    | V3HubRelayResponseError::ProviderCompatFailed { .. }
            )
    )
}

pub(crate) fn provider_response_hook_failure(
    error: V3ResponsesRelayRuntimeError,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    match error {
        V3ResponsesRelayRuntimeError::Provider(error) => {
            provider_runtime_failure(error, provider_id, observability)
        }
        other => {
            let message = format!("provider response event codec failed: {other}");
            V3ResponsesRelayProviderFailure {
                status: 502,
                policy_error_type: "provider_response_event_codec_failure".to_string(),
                policy_error_message: message.clone(),
                provider_id: provider_id.to_string(),
                source_stage: "V3HubRespChatProcess03Governed",
                observability,
                terminal_projection: None,
            }
        }
    }
}

pub(crate) fn provider_failure_output(
    failure: V3ResponsesRelayProviderFailure,
    mut trace: Vec<&'static str>,
    _candidates_remaining: usize,
) -> V3ResponsesRelayRuntimeOutput {
    let projected = failure
        .terminal_projection
        .expect("terminal Responses provider failure must carry typed Error06 projection");
    trace.push("V3Error06ClientProjected");
    let mut observability = failure.observability;
    if let Some(observability) = observability.as_mut() {
        observability.response_status = Some("error".to_string());
        if observability.provider_status.is_none() {
            observability.provider_status = Some(failure.status);
        }
        if observability.provider_id.is_none() && failure.provider_id != "none" {
            observability.provider_id = Some(failure.provider_id);
        }
    }
    V3ResponsesRelayRuntimeOutput {
        status: projected.status,
        client_body: V3ResponsesRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        observability,
        stream_observation: None,
        finalized_response: None,
        provider_snapshots: None,
        protocol_direct_handoff: None,
    }
}

pub(crate) fn error_output(
    source: routecodex_v3_error::V3Error01SourceRaised,
    status: u16,
    provider_id: &str,
    mut trace: Vec<&'static str>,
    mut observability: Option<V3RuntimeObservability>,
    candidates_remaining: usize,
) -> V3ResponsesRelayRuntimeOutput {
    let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source,
        action_scope: V3ErrorActionScope::ProviderInstance {
            provider_id: provider_id.to_string(),
        },
        candidates_remaining,
        source_status: Some(status),
    });
    trace.extend(V3_ERROR_CHAIN_NODE_IDS);
    if let Some(observability) = observability.as_mut() {
        observability.response_status = Some("error".to_string());
        if observability.provider_status.is_none() {
            observability.provider_status = Some(status);
        }
        if observability.provider_id.is_none() && provider_id != "none" {
            observability.provider_id = Some(provider_id.to_string());
        }
    }
    V3ResponsesRelayRuntimeOutput {
        status: projected.status,
        client_body: V3ResponsesRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        observability,
        stream_observation: None,
        finalized_response: None,
        provider_snapshots: None,
        protocol_direct_handoff: None,
    }
}
