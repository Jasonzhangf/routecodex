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
    error_output_from_projection(projected, trace)
}

fn error_output_from_projection(
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
                diagnostic_source: Some(fault.policy_failure),
                diagnostic_cause: fault.original_source,
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
        let policy_failure = fault.policy_failure.clone();
        let original_source = fault
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
        let diagnostic_source = fault.policy_failure.clone();
        let diagnostic_cause = fault
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

        let output = provider_failure_output(
            V3RelayProviderFailure {
                status: 502,
                provider_status: None,
                client_response: Value::Null,
                source_stage: "V3Error06ClientProjected",
                terminal_projection: None,
                terminal_disposition: None,
                error_operator_fault: Some(fault),
                error_type_fn: |_| None,
                error_message_fn: |_| "unused".to_string(),
            },
            vec!["V3ProviderRespInbound01Raw"],
            attempts.clone(),
        );

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
        assert_eq!(output.diagnostic_source, Some(diagnostic_source.clone()));
        assert_eq!(output.diagnostic_cause, Some(diagnostic_cause.clone()));
        assert_eq!(
            diagnostic_source.source_kind,
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(diagnostic_source.code, "relay_error_projection_nonterminal");
        assert_eq!(diagnostic_cause, source);
        assert_eq!(output.provider_failure_attempts, attempts);
    }
}
