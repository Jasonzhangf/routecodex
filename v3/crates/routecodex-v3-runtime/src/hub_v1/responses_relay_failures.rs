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
        matched_policy: None,
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
        matched_policy: None,
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
    let matched_policy = error.matched_policy.clone();
    V3ResponsesRelayProviderFailure {
        status,
        policy_error_type,
        policy_error_message,
        provider_id: provider_id.to_string(),
        source_stage: "V3ProviderRespInbound01Raw",
        observability,
        terminal_projection: None,
        matched_policy,
    }
}

pub(crate) fn provider_response_stream_relay_failure(
    error: V3ResponsesRelayRuntimeError,
    request_id: &str,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> Result<V3ResponsesRelayProviderFailure, V3ResponsesRelayRuntimeError> {
    Ok(match error {
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
            matched_policy: None,
        },
        V3ResponsesRelayRuntimeError::ProviderJson(reason) =>
            provider_response_codec_relay_failure(
                reason.to_string(),
                provider_id,
                observability,
            ),
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(reason) =>
            provider_response_codec_relay_failure(reason, provider_id, observability),
        other => provider_runtime_failure(
            provider_response_stream_failure(other, request_id, provider_id)?,
            provider_id,
            observability,
        ),
    })
}

fn provider_response_codec_relay_failure(
    reason: String,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    V3ResponsesRelayProviderFailure {
        status: 502,
        policy_error_type: "provider_response_event_codec_failure".to_string(),
        policy_error_message: format!("provider response event codec failed: {reason}"),
        provider_id: provider_id.to_string(),
        source_stage: "V3ProviderRespInbound01Raw",
        observability,
        terminal_projection: None,
        matched_policy: None,
    }
}

pub(crate) fn provider_request_relay_failure(
    error: V3ResponsesRelayRuntimeError,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> Result<V3ResponsesRelayProviderFailure, V3ResponsesRelayRuntimeError> {
    let (source_stage, error_type, message, terminal_projection) = match error {
        V3ResponsesRelayRuntimeError::ProviderCompat(error) => {
            let boundary = match error.classification() {
                V3ProviderCompatErrorClassification::PayloadBoundaryViolation => {
                    Some(V3ErrorHandlingCenter::project_terminal(
                        V3ErrorHandlingCenter::decide_provider(
                            V3ErrorHandlingCenterInput {
                                source: super::provider_compat_boundary_source(
                                    "ProviderReqCompat06ProviderCompat",
                                    &error,
                                ),
                                action_scope: V3ErrorActionScope::ProviderInstance {
                                    provider_id: provider_id.to_string(),
                                },
                                candidates_remaining: 0,
                                source_status: Some(400),
                            },
                            false,
                            false,
                            None,
                        ),
                    ))
                }
                V3ProviderCompatErrorClassification::RequestPayloadInvalid => {
                    Some(V3ErrorHandlingCenter::project_terminal(
                        V3ErrorHandlingCenter::decide_provider(
                            V3ErrorHandlingCenterInput {
                                source: super::provider_request_payload_source(
                                    "ProviderReqCompat06ProviderCompat",
                                    &error,
                                ),
                                action_scope: V3ErrorActionScope::ProviderInstance {
                                    provider_id: provider_id.to_string(),
                                },
                                candidates_remaining: 0,
                                source_status: Some(400),
                            },
                            false,
                            false,
                            None,
                        ),
                    ))
                }
                V3ProviderCompatErrorClassification::Other => None,
            };
            (
                "ProviderReqCompat06ProviderCompat",
                "provider_request_compat_error",
                format!("V3 Responses Relay provider compat failed: {error}"),
                boundary,
            )
        }
        V3ResponsesRelayRuntimeError::ProviderWireEncoding(message) => (
            "V3ProviderReqOutbound08WirePayload",
            "provider_request_wire_error",
            format!("V3 Responses Relay provider wire encoding failed: {message}"),
            None,
        ),
        V3ResponsesRelayRuntimeError::Provider(error) => (
            "V3ProviderReqOutbound08WirePayload",
            "provider_request_wire_error",
            error.to_string(),
            None,
        ),
        other => return Err(other),
    };
    Ok(V3ResponsesRelayProviderFailure {
        status: terminal_projection
            .as_ref()
            .map_or(502, |projection| projection.status),
        policy_error_type: error_type.to_string(),
        policy_error_message: message.clone(),
        provider_id: provider_id.to_string(),
        source_stage,
        observability,
        terminal_projection,
        matched_policy: None,
    })
}

pub(crate) fn provider_response_stream_failure(
    error: V3ResponsesRelayRuntimeError,
    request_id: &str,
    provider_id: &str,
) -> Result<V3ProviderError, V3ResponsesRelayRuntimeError> {
    Ok(match error {
        V3ResponsesRelayRuntimeError::Provider(error) => error,
        V3ResponsesRelayRuntimeError::ProviderResponseEmpty { .. } => {
            V3ProviderError::ResponseBody {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                reason:
                    "provider response body is empty: upstream declared SSE but emitted zero bytes"
                        .to_string(),
            }
        }
        V3ResponsesRelayRuntimeError::ProviderSseTransport(reason) => {
            V3ProviderError::MalformedSse {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                reason: format!("provider SSE transport failed: {reason}"),
            }
        }
        V3ResponsesRelayRuntimeError::ProviderJson(reason) => {
            provider_response_codec_error(reason.to_string(), request_id, provider_id)
        }
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(reason) => {
            provider_response_codec_error(reason, request_id, provider_id)
        }
        other => return Err(other),
    })
}

fn provider_response_codec_error(
    reason: String,
    request_id: &str,
    provider_id: &str,
) -> V3ProviderError {
    V3ProviderError::ResponseBody {
        request_id: request_id.to_string(),
        provider_id: provider_id.to_string(),
        reason: format!("provider response event codec failed: {reason}"),
    }
}

pub(crate) fn is_v3_responses_provider_response_failure(
    error: &V3ResponsesRelayRuntimeError,
) -> bool {
    matches!(
        error,
        V3ResponsesRelayRuntimeError::Provider(_)
            | V3ResponsesRelayRuntimeError::ProviderJson(_)
            | V3ResponsesRelayRuntimeError::ProviderSseTransport(_)
            | V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(_)
            | V3ResponsesRelayRuntimeError::ProviderResponseEmpty { .. }
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
                matched_policy: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_transport_error_is_promoted_to_provider_malformed_sse() {
        let failure = provider_response_stream_relay_failure(
            V3ResponsesRelayRuntimeError::ProviderSseTransport(
                "SSE stream ended before the final frame delimiter".to_owned(),
            ),
            "req-1",
            "provider-1",
            None,
        )
        .expect("provider SSE transport error attribution");
        assert_eq!(failure.source_stage, "V3ProviderRespInbound01Raw");
        assert_eq!(failure.status, 502);
        assert!(failure.policy_error_message.contains("malformed SSE"));
        let source = routecodex_v3_error::build_v3_error_01_source_raised(
            routecodex_v3_error::V3ErrorSourceKind::ProviderFailure,
            failure.source_stage,
            "provider_response_sse_unterminated_frame",
            failure.policy_error_message,
        );
        let classified = routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01(source);
        let local = routecodex_v3_error::build_v3_error_03_target_local_action_from_v3_error_02(
            classified,
            routecodex_v3_error::V3ErrorActionScope::ProviderInstance {
                provider_id: "provider-1".to_owned(),
            },
            0,
        );
        let exhaustion =
            routecodex_v3_error::build_v3_error_04_target_exhaustion_decision_with_provider_availability(
                local, 0, false, false,
            );
        let execution = routecodex_v3_error::build_v3_error_05_execution_decision_from_v3_error_04(
            exhaustion, None,
        );
        let projected = routecodex_v3_error::build_v3_error_06_client_projected_from_v3_error_05(
            execution
                .try_into_terminal()
                .expect("exhausted relay transport error must project terminally"),
        );
        assert_eq!(
            projected.chain,
            routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS
        );
        assert_ne!(
            projected.body.get("response"),
            Some(&json!({"status":"completed"}))
        );
    }

    #[test]
    fn local_response_failures_never_become_provider_failures() {
        let cases = [
            V3ResponsesRelayRuntimeError::ExecutionControl(
                "request attempt budget exhausted".to_string(),
            ),
            V3ResponsesRelayRuntimeError::RuntimeTiming(
                "request residence deadline elapsed".to_string(),
            ),
            V3ResponsesRelayRuntimeError::LocalContinuationStatePoisoned,
            V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned,
        ];

        for error in cases {
            let returned = provider_response_stream_failure(error, "req-local", "provider-1")
                .expect_err("local response failure must stay outside provider attribution");
            assert!(matches!(
                returned,
                V3ResponsesRelayRuntimeError::ExecutionControl(_)
                    | V3ResponsesRelayRuntimeError::RuntimeTiming(_)
                    | V3ResponsesRelayRuntimeError::LocalContinuationStatePoisoned
                    | V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned
            ));
        }
    }

    #[test]
    fn local_response_failures_never_enter_provider_relay_policy() {
        let returned = match provider_response_stream_relay_failure(
            V3ResponsesRelayRuntimeError::ExecutionControl(
                "process-global attempt store exhausted".to_string(),
            ),
            "req-local",
            "provider-1",
            None,
        ) {
            Err(error) => error,
            Ok(_) => panic!("local resource exhaustion must not produce provider failure policy input"),
        };

        assert!(matches!(
            returned,
            V3ResponsesRelayRuntimeError::ExecutionControl(_)
        ));
    }

    #[test]
    fn request_shape_compat_failure_enters_provider_failure_policy() {
        let profile = V3ProviderCompatProfileId::Passthrough;
        let error = classify_v3_provider_compat_error(
            "request",
            &profile,
            "Anthropic codec malformed tools[].format".to_string(),
        );
        let failure = provider_request_relay_failure(
            V3ResponsesRelayRuntimeError::ProviderCompat(error),
            "provider-1",
            None,
        )
        .expect("request compat failure must become terminal client error");
        assert_eq!(failure.status, 598);
        assert!(failure.terminal_projection.is_some());
        assert_eq!(failure.policy_error_type, "provider_request_compat_error");
    }

}
