use super::*;

pub(super) fn provider_failure_output(
    failure: V3RelayProviderFailure,
    mut trace: Vec<&'static str>,
    provider_failure_attempts: Vec<V3RuntimeProviderFailureObservation>,
) -> V3OpenAiChatRelayRuntimeOutput {
    if let Some(fault) = failure.error_operator_fault {
        return V3OpenAiChatRelayRuntimeOutput {
            status: 599,
            terminal_disposition: Some(
                failure
                    .terminal_disposition
                    .unwrap_or(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse),
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
            diagnostic_source: Some(*fault.policy_failure),
            diagnostic_cause: fault.original_source.map(|source| *source),
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
    trace: Vec<&'static str>,
) -> V3OpenAiChatRelayRuntimeOutput {
    let (projected, trace) = crate::hub_v1::error_output(source, status, provider_id, trace);
    error_output_from_projection(projected, trace)
}

pub(super) fn error_output_from_projection(
    projected: Result<
        routecodex_v3_error::V3Error06ClientProjected,
        crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
    >,
    trace: Vec<&'static str>,
) -> V3OpenAiChatRelayRuntimeOutput {
    let projected = match projected {
        Ok(projected) => projected,
        Err(fault) => {
            return V3OpenAiChatRelayRuntimeOutput {
                status: 599,
                terminal_disposition: Some(
                    routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse,
                ),
                client_body: V3OpenAiChatRelayClientBody::Json(Value::Null),
                node_trace: trace,
                error_chain: None,
                error_class: None,
                error_detail: None,
                provider_failure_attempts: Vec::new(),
                diagnostic_source: Some(*fault.policy_failure),
                diagnostic_cause: fault.original_source.map(|source| *source),
                observability: None,
                stream_observation: None,
                provider_snapshots: None,
            }
        }
    };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_error_sdk_fault_survives_consumer() {
        let source = routecodex_v3_error::build_v3_error_01_source_raised(
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure,
            "V3Error06ClientProjected",
            "local_error_sdk_fault",
            "local Error SDK fault must survive the consumer",
        );
        let error = crate::operation_runner::run_v3_error_02_to_05_decision_operators(
            Value::Null,
            source.clone(),
            routecodex_v3_error::V3ErrorActionScope::None,
            0,
            false,
            false,
            None,
        )
        .expect_err("a non-object source projection must expose the real SDK fault");
        let fault = crate::provider_failure_runtime_policy::finish_v3_relay_error_projection(
            source.clone(),
            Err(error),
        )
        .expect_err("an SDK fault must not become a fabricated Error06");
        let policy_failure = *fault.policy_failure.clone();
        let original_source = *fault
            .original_source
            .clone()
            .expect("the original source must remain the fault cause");
        let output = error_output_from_projection(Err(fault), vec!["RelayFailureObserved"]);

        assert_eq!(output.status, 599);
        assert_eq!(
            output.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
        );
        assert!(matches!(
            &output.client_body,
            V3OpenAiChatRelayClientBody::Json(value) if value.is_null()
        ));
        assert!(output.error_chain.is_none());
        assert_eq!(output.node_trace, vec!["RelayFailureObserved"]);
        assert!(!output.node_trace.contains(&"V3Error06ClientProjected"));
        assert_eq!(output.diagnostic_source, Some(policy_failure.clone()));
        assert_eq!(output.diagnostic_cause, Some(original_source.clone()));
        assert_eq!(
            policy_failure.source_kind,
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(policy_failure.source_stage, "V3Error06ClientProjected");
        assert_eq!(policy_failure.code, "relay_error_operator_sdk_failure");
        assert_eq!(original_source, source);
    }

    #[test]
    fn provider_compat_source_fault_short_circuits_with_original_cause() {
        let error = V3ProviderCompatError::new_payload_boundary(
            "response",
            "passthrough".to_string(),
            "ProviderCompatPayloadBoundaryViolation field=metadata value=control".to_string(),
        );
        let source = crate::hub_v1::provider_compat_boundary_source(
            "ProviderRespCompat02ProviderCompat",
            &error,
        )
        .expect("compat boundary source must execute Error01 successfully");
        let fault = crate::provider_failure_runtime_policy::finish_v3_relay_error_projection(
            source.clone(),
            Ok(None),
        )
        .expect_err("missing terminal Error06 is a typed SDK fault");
        let diagnostic_source = *fault.policy_failure.clone();
        let diagnostic_cause = *fault
            .original_source
            .clone()
            .expect("the SDK fault keeps its original compat source");

        let output =
            error_output_from_projection(Err(fault), vec!["ProviderRespCompat02ProviderCompat"]);

        assert_eq!(output.status, 599);
        assert_eq!(
            output.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
        );
        assert!(matches!(
            &output.client_body,
            V3OpenAiChatRelayClientBody::Json(value) if value.is_null()
        ));
        assert!(output.error_chain.is_none());
        assert!(!output.node_trace.contains(&"V3Error06ClientProjected"));
        assert_eq!(output.diagnostic_source, Some(diagnostic_source));
        assert_eq!(output.diagnostic_cause, Some(diagnostic_cause.clone()));
        assert_eq!(diagnostic_cause, source);
    }

    #[test]
    fn relay_error_operator_fault_projects_internal_599_without_client_error() {
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
        let diagnostic_source = *fault.policy_failure.clone();
        let diagnostic_cause = *fault
            .original_source
            .clone()
            .expect("the real source must remain the fault cause");
        let attempts = vec![
            V3RuntimeProviderFailureObservation {
                provider_id: "provider-a".to_string(),
                status: 502,
                message: "attempt-a".to_string(),
                ..Default::default()
            },
            V3RuntimeProviderFailureObservation {
                provider_id: "provider-b".to_string(),
                status: 503,
                message: "attempt-b".to_string(),
                ..Default::default()
            },
        ];

        let headers = vec![("content-type".to_string(), b"application/json".to_vec())];
        let body = br#"{"error":{"message":"rate limited"}}"#.to_vec();
        let witness =
            routecodex_v3_error::V3ExternalHttpWitness::new(429, headers.clone(), body.clone())
                .with_body_read_failure("provider body truncated");
        let outputs = [
            provider_failure_output(
                V3RelayProviderFailure {
                    status: 502,
                    provider_status: None,
                    provider_body_read_failure: None,
                    client_response: Value::Null,
                    source_stage: "V3Error06ClientProjected",
                    terminal_projection: None,
                    terminal_disposition: None,
                    error_operator_fault: Some(fault.clone()),
                    failed_attempt_evidence: None,
                    error_type_fn: |_| None,
                    error_message_fn: |_| "unused".to_string(),
                },
                vec!["V3ProviderRespInbound01Raw"],
                attempts.clone(),
            ),
            provider_failure_output(
                V3RelayProviderFailure {
                    status: 502,
                    provider_status: None,
                    provider_body_read_failure: None,
                    client_response: Value::Null,
                    source_stage: "V3Error06ClientProjected",
                    terminal_projection: None,
                    terminal_disposition: Some(
                        routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(
                            witness.clone(),
                        ),
                    ),
                    error_operator_fault: Some(fault),
                    failed_attempt_evidence: None,
                    error_type_fn: |_| None,
                    error_message_fn: |_| "unused".to_string(),
                },
                vec!["V3ProviderRespInbound01Raw"],
                attempts.clone(),
            ),
        ];

        for output in &outputs {
            assert_eq!(output.status, 599);
            assert!(matches!(
                &output.client_body,
                V3OpenAiChatRelayClientBody::Json(value) if value.is_null()
            ));
            assert!(output.error_chain.is_none());
            assert!(!output.node_trace.contains(&"V3Error06ClientProjected"));
            assert_eq!(output.diagnostic_source, Some(diagnostic_source.clone()));
            assert_eq!(output.diagnostic_cause, Some(diagnostic_cause.clone()));
            assert_eq!(output.provider_failure_attempts, attempts);
        }
        assert_eq!(
            outputs[0].terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
        );
        match outputs[1].terminal_disposition.as_ref() {
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness)) => {
                assert_eq!(witness.status(), 429);
                assert_eq!(witness.headers(), headers.as_slice());
                assert_eq!(witness.body(), body.as_slice());
                assert_eq!(witness.body_read_failure(), Some("provider body truncated"));
            }
            other => panic!("expected external HTTP witness, got {other:?}"),
        }
        assert_eq!(
            diagnostic_source.source_kind,
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(diagnostic_source.code, "relay_error_projection_nonterminal");
        assert_eq!(diagnostic_cause, source);
    }
}
