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
        provider_status: Some(status),
        policy_error_type,
        policy_error_message,
        provider_id: provider_id.to_string(),
        source_stage: "V3ProviderReqOutbound09TransportRequest",
        observability,
        terminal_projection: None,
        terminal_disposition: None,
        error_operator_fault: None,
        matched_policy: None,
    }
}

pub(crate) fn provider_runtime_failure(
    error: V3ProviderError,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    if let V3ProviderError::InternalTransport { lane, .. } = &error {
        let source_stage = match lane {
            routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Request => {
                "V3ProviderReqOutbound09TransportRequest"
            }
            routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Response => {
                "V3ProviderRespInbound01Raw"
            }
        };
        let source = crate::hooks::build_v3_provider_error_source(source_stage, error);
        let source_message = source.message.clone();
        let (status, policy_error_message, terminal_projection, error_operator_fault) =
            match crate::provider_failure_runtime_policy::project_v3_relay_error_source(
                source,
                V3ErrorActionScope::None,
                0,
                None,
            ) {
                Ok(projected) => (
                    projected.status,
                    projected.error_detail.clone(),
                    Some(projected),
                    None,
                ),
                Err(fault) => (599, source_message, None, Some(fault)),
            };
        return V3ResponsesRelayProviderFailure {
            status,
            // Internal transport handoff failure: no upstream HTTP response exists.
            provider_status: None,
            policy_error_type: "provider_internal_transport_error".to_string(),
            policy_error_message,
            provider_id: provider_id.to_string(),
            source_stage,
            observability,
            terminal_projection,
            terminal_disposition: Some(
                routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse,
            ),
            error_operator_fault,
            matched_policy: None,
        };
    }
    let (terminal_projection, error_operator_fault) =
        if matches!(&error, V3ProviderError::ClientDisconnect { .. }) {
            match project_v3_client_disconnect(
                provider_id,
                provider_runtime_failure_stage(&error),
                error.to_string(),
            ) {
                Ok(projected) => (Some(projected), None),
                Err(fault) => (None, Some(fault)),
            }
        } else {
            (None, None)
        };
    let policy_error_message = error.to_string();
    // transport 响应头挂起由错误处理中心按「transport 阶段 + 专属类别码」判定为
    // 瞬态（health-neutral 同 provider 重试 3 次）；其余 transport 错误保持原策略。
    let policy_error_type = if matches!(
        &error,
        V3ProviderError::Transport { reason, .. }
            if reason == V3_RELAY_TRANSPORT_HANG_REASON
                || routecodex_v3_error::is_v3_provider_response_header_timeout_reason(reason)
    ) {
        V3_TRANSIENT_TRANSPORT_HANG_CODE.to_string()
    } else {
        // Category comes from the typed provider error so a transport failure and
        // a provider response-body failure stay distinct instead of collapsing
        // into one catch-all code that no lane can interpret.
        crate::hooks::source_code_for_external_provider_error(&error)
    };
    let status = if terminal_projection.is_some() {
        499
    } else {
        match &error {
            V3ProviderError::HttpStatus { response } => response.status,
            _ => 502,
        }
    };
    // `status` above is the internal typed marker (502 for a network failure); a
    // provider terminal never projects it onto the client, so it is evidence only.
    // `provider_status` carries only a real upstream HTTP status: a transport or
    // other response-less failure must stay `None` so it cannot be mistaken for a
    // genuine upstream HTTP 502.
    let provider_status = match &error {
        V3ProviderError::HttpStatus { response } => Some(response.status),
        _ => None,
    };
    V3ResponsesRelayProviderFailure {
        status,
        provider_status,
        policy_error_type,
        policy_error_message: policy_error_message.clone(),
        provider_id: provider_id.to_string(),
        source_stage: provider_runtime_failure_stage(&error),
        observability,
        terminal_projection,
        terminal_disposition: None,
        error_operator_fault,
        matched_policy: None,
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
            // Synthesized stream-semantic status (see `provider_semantic_failure`).
            provider_status: None,
            policy_error_type: code.clone(),
            policy_error_message: message.clone(),
            provider_id: provider_id.to_string(),
            source_stage: "V3ProviderRespInbound01Raw",
            observability,
            terminal_projection: None,
            terminal_disposition: None,
            error_operator_fault: None,
            matched_policy: None,
        },
        V3ResponsesRelayRuntimeError::ProviderJson(reason) => {
            provider_response_codec_relay_failure(reason.to_string(), provider_id, observability)
        }
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(reason) => {
            provider_response_codec_relay_failure(reason, provider_id, observability)
        }
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
        // Internal response codec failure: the 502 is the client projection, not
        // an upstream HTTP status.
        provider_status: None,
        policy_error_type: "provider_response_event_codec_failure".to_string(),
        policy_error_message: format!("provider response event codec failed: {reason}"),
        provider_id: provider_id.to_string(),
        source_stage: "V3ProviderRespInbound01Raw",
        observability,
        terminal_projection: None,
        terminal_disposition: None,
        error_operator_fault: None,
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
        // Request-stage compat/wire failures happen before any upstream response.
        provider_status: None,
        policy_error_type: error_type.to_string(),
        policy_error_message: message.clone(),
        provider_id: provider_id.to_string(),
        source_stage,
        observability,
        terminal_projection,
        terminal_disposition: None,
        error_operator_fault: None,
        matched_policy: None,
    })
}

pub(crate) fn terminalize_v3_responses_relay_provider_failure(
    mut failure: V3ResponsesRelayProviderFailure,
    last_external_http: Option<routecodex_v3_error::V3ExternalHttpWitness>,
) -> V3ResponsesRelayProviderFailure {
    if failure.terminal_projection.is_some() {
        return failure;
    }
    let terminal_disposition = match last_external_http {
        Some(witness) => routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness),
        None => routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse,
    };
    failure
        .terminal_disposition
        .get_or_insert(terminal_disposition);
    if failure.error_operator_fault.is_some() {
        return failure;
    }
    let source = routecodex_v3_error::build_v3_error_01_source_raised(
        routecodex_v3_error::V3ErrorSourceKind::ProviderFailure,
        failure.source_stage,
        &failure.policy_error_type,
        &failure.policy_error_message,
    );
    match crate::provider_failure_runtime_policy::project_v3_relay_error_source(
        source,
        V3ErrorActionScope::ProviderInstance {
            provider_id: failure.provider_id.clone(),
        },
        0,
        None,
    ) {
        Ok(projected) => failure.terminal_projection = Some(projected),
        Err(fault) => failure.error_operator_fault = Some(fault),
    }
    failure
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
                // Internal response-hook codec failure: no upstream HTTP status.
                provider_status: None,
                policy_error_type: "provider_response_event_codec_failure".to_string(),
                policy_error_message: message,
                provider_id: provider_id.to_string(),
                source_stage: "V3HubRespChatProcess03Governed",
                observability,
                terminal_projection: None,
                terminal_disposition: None,
                error_operator_fault: None,
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
    provider_failure_output_with_observation(failure, trace, None)
}

pub(crate) fn provider_failure_output_with_observation(
    failure: V3ResponsesRelayProviderFailure,
    mut trace: Vec<&'static str>,
    stream_observation: Option<V3RuntimeStreamObservation>,
) -> V3ResponsesRelayRuntimeOutput {
    if let Some(fault) = failure.error_operator_fault {
        return V3ResponsesRelayRuntimeOutput {
            status: 599,
            terminal_disposition: Some(
                failure
                    .terminal_disposition
                    .unwrap_or(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse),
            ),
            client_body: V3ResponsesRelayClientBody::Json(Value::Null),
            node_trace: trace,
            error_chain: None,
            observability: failure.observability,
            diagnostic_source: Some(fault.policy_failure),
            diagnostic_cause: fault.original_source,
            stream_observation,
            finalized_response: None,
            provider_snapshots: None,
            protocol_direct_handoff: None,
        };
    }
    let projected = failure
        .terminal_projection
        .expect("terminal Responses provider failure must carry typed Error06 projection");
    trace.push("V3Error06ClientProjected");
    let mut observability = failure.observability;
    if let Some(observability) = observability.as_mut() {
        observability.response_status = Some("error".to_string());
        if observability.provider_status.is_none() {
            // Only a real upstream HTTP status may fill this side channel; the
            // client-facing projection status must never be mirrored into it.
            observability.provider_status = failure.provider_status;
        }
        if observability.provider_id.is_none() && failure.provider_id != "none" {
            observability.provider_id = Some(failure.provider_id);
        }
    }
    V3ResponsesRelayRuntimeOutput {
        status: projected.status,
        terminal_disposition: failure.terminal_disposition,
        client_body: V3ResponsesRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        observability,
        diagnostic_source: Some(projected.diagnostic_source),
        diagnostic_cause: None,
        stream_observation,
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
    let projected = crate::provider_failure_runtime_policy::project_v3_relay_error_source(
        source,
        V3ErrorActionScope::ProviderInstance {
            provider_id: provider_id.to_string(),
        },
        candidates_remaining,
        Some(status),
    );
    if let Some(observability) = observability.as_mut() {
        observability.response_status = Some("error".to_string());
        // `status` is the internal projection status (598/599/400/500), not an
        // upstream HTTP status, so it must not populate `provider_status`. Keep
        // whatever real upstream status the lane already observed.
        if observability.provider_id.is_none() && provider_id != "none" {
            observability.provider_id = Some(provider_id.to_string());
        }
    }
    local_error_output_from_projection(projected, trace, observability)
}

fn local_error_output_from_projection(
    projected: Result<
        routecodex_v3_error::V3Error06ClientProjected,
        crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
    >,
    mut trace: Vec<&'static str>,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayRuntimeOutput {
    let projected = match projected {
        Ok(projected) => projected,
        Err(fault) => {
            return V3ResponsesRelayRuntimeOutput {
                status: 599,
                terminal_disposition: Some(
                    routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse,
                ),
                client_body: V3ResponsesRelayClientBody::Json(Value::Null),
                node_trace: trace,
                error_chain: None,
                observability,
                diagnostic_source: Some(fault.policy_failure),
                diagnostic_cause: fault.original_source,
                stream_observation: None,
                finalized_response: None,
                provider_snapshots: None,
                protocol_direct_handoff: None,
            }
        }
    };
    trace.extend(V3_ERROR_CHAIN_NODE_IDS);
    V3ResponsesRelayRuntimeOutput {
        status: projected.status,
        terminal_disposition: None,
        client_body: V3ResponsesRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        observability,
        diagnostic_source: Some(projected.diagnostic_source),
        diagnostic_cause: None,
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
    fn internal_transport_projection_preserves_response_source() {
        let expected_source = crate::hooks::build_v3_provider_error_source(
            "V3ProviderRespInbound01Raw",
            V3ProviderError::InternalTransport {
                request_id: "req-internal-sdk".to_string(),
                provider_id: "goaichat".to_string(),
                lane: routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Response,
                reason: "provider frame sequence mismatch".to_string(),
            },
        );
        let success = provider_runtime_failure(
            V3ProviderError::InternalTransport {
                request_id: "req-internal-sdk".to_string(),
                provider_id: "goaichat".to_string(),
                lane: routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Response,
                reason: "provider frame sequence mismatch".to_string(),
            },
            "goaichat",
            None,
        );
        let projected = success
            .terminal_projection
            .as_ref()
            .expect("successful InternalTransport must carry Error06");
        assert_eq!(
            projected.chain,
            routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS
        );
        assert_eq!(projected.diagnostic_source, expected_source);
        assert_eq!(success.source_stage, "V3ProviderRespInbound01Raw");
        assert_eq!(success.policy_error_message, expected_source.message);
        assert_eq!(
            success.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
        );
        assert!(success.error_operator_fault.is_none());
    }

    #[test]
    fn local_error_sdk_fault_survives_consumer() {
        let source = routecodex_v3_error::build_v3_error_01_source_raised(
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure,
            "V3Error06ClientProjected",
            "local_error_sdk_fault_source",
            "local error SDK operation failed",
        );
        let expected_source = source.clone();
        let error = crate::operation_runner::run_v3_error_02_to_05_decision_operators(
            Value::Null,
            source.clone(),
            V3ErrorActionScope::None,
            0,
            false,
            false,
            None,
        )
        .expect_err("Value::Null must fail through the real Error02 decision operator");
        let fault = crate::provider_failure_runtime_policy::finish_v3_relay_error_projection(
            source.clone(),
            Err(error),
        )
        .expect_err("the real OperationRunnerError must become a typed relay fault");
        let policy_failure = fault.policy_failure.clone();
        let original_source = fault
            .original_source
            .clone()
            .expect("the relay fault must preserve its original source");
        let trace = vec!["V3RuntimeRequestStarted"];

        let output = local_error_output_from_projection(Err(fault), trace.clone(), None);

        assert_eq!(output.status, 599);
        assert_eq!(
            output.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
        );
        assert!(matches!(
            &output.client_body,
            V3ResponsesRelayClientBody::Json(value) if value.is_null()
        ));
        assert!(output.error_chain.is_none());
        assert_eq!(output.node_trace, trace);
        assert!(!output.node_trace.contains(&"V3Error06ClientProjected"));
        assert_eq!(output.diagnostic_source, Some(policy_failure.clone()));
        assert_eq!(output.diagnostic_cause, Some(original_source.clone()));
        assert_eq!(original_source, expected_source);
        assert_eq!(
            policy_failure.source_kind,
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(policy_failure.code, "relay_error_operator_sdk_failure");
    }

    #[test]
    fn relay_error_operator_fault_projects_internal_599_without_client_error() {
        let witness = routecodex_v3_error::V3ExternalHttpWitness::new(
            429,
            vec![("retry-after".to_string(), b"7".to_vec())],
            br#"{"error":{"type":"rate_limit_error"}}"#.to_vec(),
        )
        .with_body_read_failure("provider body truncated");
        let source = routecodex_v3_error::build_v3_error_01_source_raised(
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure,
            "V3Error06ClientProjected",
            "relay_error_projection_nonterminal",
            "Error06 SDK completed without a terminal client projection",
        );
        let fault = crate::provider_failure_runtime_policy::finish_v3_relay_error_projection(
            source.clone(),
            Ok(None),
        )
        .expect_err("Ok(None) must produce a typed operator fault");
        let diagnostic_source = fault.policy_failure.clone();
        let diagnostic_cause = fault
            .original_source
            .clone()
            .expect("the real source must remain the fault cause");

        let output = provider_failure_output(
            V3ResponsesRelayProviderFailure {
                status: 502,
                provider_status: None,
                policy_error_type: "relay_error_projection_nonterminal".to_string(),
                policy_error_message: "Error06 SDK completed without a terminal client projection"
                    .to_string(),
                provider_id: "provider-a".to_string(),
                source_stage: "V3Error06ClientProjected",
                observability: None,
                terminal_projection: None,
                terminal_disposition: Some(
                    routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(
                        witness.clone(),
                    ),
                ),
                error_operator_fault: Some(fault),
                matched_policy: None,
            },
            vec!["V3ProviderRespInbound01Raw"],
            0,
        );

        assert_eq!(output.status, 599);
        assert_eq!(
            output.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness))
        );
        assert!(matches!(
            &output.client_body,
            V3ResponsesRelayClientBody::Json(value) if value.is_null()
        ));
        assert!(output.error_chain.is_none());
        assert!(!output.node_trace.contains(&"V3Error06ClientProjected"));
        assert_eq!(output.diagnostic_source, Some(diagnostic_source.clone()));
        assert_eq!(output.diagnostic_cause, Some(diagnostic_cause.clone()));
        assert_eq!(
            diagnostic_source.source_kind,
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(diagnostic_source.code, "relay_error_projection_nonterminal");
        assert_eq!(diagnostic_cause, source);
    }

    #[test]
    fn terminalizer_preserves_sdk_fault_witness_without_erasing_existing_disposition() {
        let witness = routecodex_v3_error::V3ExternalHttpWitness::new(
            200,
            vec![("content-type".to_string(), b"application/json".to_vec())],
            br#"{"status":"completed"}"#.to_vec(),
        )
        .with_body_read_failure("provider body failed after the 200 head");
        let source = routecodex_v3_error::build_v3_error_01_source_raised(
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure,
            "V3Error06ClientProjected",
            "relay_error_projection_nonterminal",
            "Error06 SDK completed without a terminal client projection",
        );
        let fault = crate::provider_failure_runtime_policy::finish_v3_relay_error_projection(
            source,
            Ok(None),
        )
        .expect_err("Ok(None) must produce a typed operator fault");
        let failure = V3ResponsesRelayProviderFailure {
            status: 502,
            provider_status: Some(200),
            policy_error_type: "relay_error_projection_nonterminal".to_string(),
            policy_error_message: "Error06 SDK completed without a terminal client projection"
                .to_string(),
            provider_id: "provider-a".to_string(),
            source_stage: "V3Error06ClientProjected",
            observability: None,
            terminal_projection: None,
            terminal_disposition: None,
            error_operator_fault: Some(fault.clone()),
            matched_policy: None,
        };

        let terminalized =
            terminalize_v3_responses_relay_provider_failure(failure, Some(witness.clone()));

        assert!(terminalized.terminal_projection.is_none());
        assert_eq!(
            terminalized.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness))
        );
        assert_eq!(terminalized.error_operator_fault, Some(fault.clone()));

        let existing = routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse;
        let authored = terminalize_v3_responses_relay_provider_failure(
            V3ResponsesRelayProviderFailure {
                status: 502,
                provider_status: None,
                policy_error_type: "relay_error_projection_nonterminal".to_string(),
                policy_error_message: "authored disposition".to_string(),
                provider_id: "provider-a".to_string(),
                source_stage: "V3Error06ClientProjected",
                observability: None,
                terminal_projection: None,
                terminal_disposition: Some(existing.clone()),
                error_operator_fault: Some(fault),
                matched_policy: None,
            },
            Some(routecodex_v3_error::V3ExternalHttpWitness::new(
                429,
                vec![],
                b"rate limited".to_vec(),
            )),
        );
        assert_eq!(authored.terminal_disposition, Some(existing));
    }

    #[test]
    fn exhausted_received_http_200_codec_failure_never_projects_error06_to_client() {
        let mut failure = provider_response_hook_failure(
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "invalid Anthropic response meaning".to_string(),
            ),
            "provider-1",
            None,
        );
        assert_eq!(failure.status, 502);
        failure = terminalize_v3_responses_relay_provider_failure(failure, None);
        assert_eq!(
            failure.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
        );
        let output = provider_failure_output(failure, vec!["V3ProviderRespInbound01Raw"], 0);
        // The provider-derived Error06 body must never become the client response;
        // the exhausted terminal keeps the typed no-response disposition so the
        // Server terminates the client boundary instead.
        assert_eq!(
            output.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
        );
    }

    #[test]
    fn provider_429_projects_internal_502_with_full_external_http_witness() {
        let witness = routecodex_v3_error::V3ExternalHttpWitness::new(
            429,
            vec![("retry-after".to_string(), b"7".to_vec())],
            br#"{"error":{"type":"rate_limit_error"}}"#.to_vec(),
        )
        .with_body_read_failure("provider body truncated");
        let failure = terminalize_v3_responses_relay_provider_failure(
            provider_http_failure(
                429,
                br#"{"error":{"type":"rate_limit_error"}}"#,
                "provider-a",
                None,
            ),
            Some(witness.clone()),
        );
        let output =
            provider_failure_output(failure, vec!["V3ProviderReqOutbound09TransportRequest"], 0);

        assert_eq!(output.status, 502);
        assert_eq!(
            output.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness))
        );
        assert!(matches!(
            &output.client_body,
            V3ResponsesRelayClientBody::Json(value) if value.get("error").is_some()
        ));
        assert_eq!(
            output
                .observability
                .as_ref()
                .and_then(|observability| observability.provider_status),
            None
        );
    }

    #[test]
    fn exhausted_failure_without_received_http_preserves_no_response() {
        let failure = terminalize_v3_responses_relay_provider_failure(
            provider_runtime_failure(
                V3ProviderError::Transport {
                    request_id: "req-no-response".to_string(),
                    provider_id: "provider-1".to_string(),
                    reason: "connection closed before response headers".to_string(),
                },
                "provider-1",
                None,
            ),
            None,
        );
        let output = provider_failure_output(failure, vec!["V3ProviderRespInbound01Raw"], 0);
        assert_eq!(
            output.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
        );
    }

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
            V3ResponsesRelayRuntimeError::ExecutionControlResponse(
                "client replay byte budget exhausted".to_string(),
            ),
            V3ResponsesRelayRuntimeError::RuntimeTiming(
                "request residence deadline elapsed".to_string(),
            ),
        ];

        for error in cases {
            let returned = provider_response_stream_failure(error, "req-local", "provider-1")
                .expect_err("local response failure must stay outside provider attribution");
            assert!(matches!(
                returned,
                V3ResponsesRelayRuntimeError::ExecutionControl(_)
                    | V3ResponsesRelayRuntimeError::ExecutionControlResponse(_)
                    | V3ResponsesRelayRuntimeError::RuntimeTiming(_)
            ));
        }
    }

    #[test]
    fn local_response_failures_never_enter_provider_relay_policy() {
        for error in [
            V3ResponsesRelayRuntimeError::ExecutionControl(
                "process-global attempt store exhausted".to_string(),
            ),
            V3ResponsesRelayRuntimeError::ExecutionControlResponse(
                "client replay byte budget exhausted".to_string(),
            ),
        ] {
            let returned = match provider_response_stream_relay_failure(
                error,
                "req-local",
                "provider-1",
                None,
            ) {
                Err(error) => error,
                Ok(_) => panic!(
                    "local resource exhaustion must not produce provider failure policy input"
                ),
            };

            assert!(matches!(
                returned,
                V3ResponsesRelayRuntimeError::ExecutionControl(_)
                    | V3ResponsesRelayRuntimeError::ExecutionControlResponse(_)
            ));
        }
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

    #[test]
    fn sse_header_wait_timeout_is_health_neutral_relay_hang() {
        let error = V3ProviderError::Transport {
            request_id: "req-sse-header-wait-policy".into(),
            provider_id: "provider-1".into(),
            reason: format!(
                "{} (30000ms)",
                routecodex_v3_error::V3_PROVIDER_RESPONSE_HEADER_TIMEOUT_REASON_PREFIX
            ),
        };
        let failure = provider_runtime_failure(error, "provider-1", None);
        assert_eq!(
            failure.policy_error_type,
            V3_TRANSIENT_TRANSPORT_HANG_CODE.to_string(),
            "SSE first-frame header wait timeout must project as the health-neutral transient hang"
        );
        assert_eq!(failure.status, 502);
    }

    /// Regression: a network transport failure received no HTTP response, so the
    /// upstream-status side channel must stay `None` while the client-facing
    /// projection stays 502. A genuine upstream HTTP failure keeps its real status.
    #[test]
    fn relay_category_comes_from_the_typed_provider_error() {
        let transport = provider_runtime_failure(
            V3ProviderError::Transport {
                request_id: "req-typed-transport".to_string(),
                provider_id: "goaichat".to_string(),
                reason: "connection closed before response headers".to_string(),
            },
            "goaichat",
            None,
        );
        assert_eq!(transport.policy_error_type, "provider_transport_error");

        let response_body = provider_runtime_failure(
            V3ProviderError::ResponseBody {
                request_id: "req-typed-body".to_string(),
                provider_id: "goaichat".to_string(),
                reason: "provider JSON response decode failed: expected value".to_string(),
            },
            "goaichat",
            None,
        );
        // A complete-body decode failure is not a network event; the typed code
        // must survive so the display layer cannot label it `network`.
        assert_eq!(
            response_body.policy_error_type,
            "provider_response_body_error"
        );
    }

    #[test]
    fn transport_failure_has_no_upstream_status_while_http_failure_keeps_its_own() {
        let transport_failure = provider_runtime_failure(
            V3ProviderError::Transport {
                request_id: "req-transport-no-response".to_string(),
                provider_id: "goaichat".to_string(),
                reason: "connection closed before response headers".to_string(),
            },
            "goaichat",
            Some(V3RuntimeObservability::default()),
        );
        // Client-visible projection is unchanged: a network failure still projects 502.
        assert_eq!(transport_failure.status, 502);
        let transport_output = provider_failure_output(
            terminalize_v3_responses_relay_provider_failure(transport_failure, None),
            vec!["V3ProviderRespInbound01Raw"],
            0,
        );
        assert_eq!(transport_output.status, 502);
        assert_eq!(
            transport_output
                .observability
                .expect("provider failure keeps observability")
                .provider_status,
            None,
            "a network transport failure has no upstream HTTP status and must not record the projected 502"
        );

        let http_failure = provider_runtime_failure(
            V3ProviderError::HttpStatus {
                response: Box::new(routecodex_v3_provider_responses::V3ProviderHttpFailure {
                    request_id: "req-http-502".to_string(),
                    provider_id: "goaichat".to_string(),
                    status: 502,
                    headers: Vec::new(),
                    body: br#"{"error":{"type":"server_error"}}"#.to_vec(),
                    body_read_failure: None,
                }),
            },
            "goaichat",
            Some(V3RuntimeObservability::default()),
        );
        assert_eq!(http_failure.status, 502);
        let http_output = provider_failure_output(
            terminalize_v3_responses_relay_provider_failure(http_failure, None),
            vec!["V3ProviderReqOutbound09TransportRequest"],
            0,
        );
        assert_eq!(
            http_output
                .observability
                .expect("provider failure keeps observability")
                .provider_status,
            Some(502),
            "a real upstream HTTP 502 keeps its own status"
        );
    }
}
