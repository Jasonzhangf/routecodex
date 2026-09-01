use super::*;

#[test]
fn response_execution_control_failure_projects_local_599() {
    let output = project_v3_responses_relay_runtime_failure(
        V3ResponsesRelayRuntimeError::ExecutionControlResponse(
            "request-local replay bytes exhausted".to_string(),
        ),
        None,
    );

    assert_eq!(output.status, 599);
    let body = match &output.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => {
            panic!("response execution-control failure must project as JSON")
        }
    };
    assert_eq!(
        body["error"]["code"],
        "responses_relay_response_execution_control_error"
    );
    assert_ne!(body["error"]["code"], "provider_response_sse_event_invalid");
}

#[test]
fn relay_runtime_failure_propagates_supplied_observability() {
    let mut observability = V3RuntimeObservability::default();
    observability.entry_protocol = "responses".to_string();
    observability.execution_mode = "relay".to_string();
    observability.transport = "json".to_string();
    observability.routing_group_id = Some("group-a".to_string());
    observability.pool_id = Some("pool-a".to_string());
    observability.provider_id = Some("provider-x".to_string());
    observability.provider_key = Some("provider-x:key1:model-y".to_string());
    observability.model_id = Some("model-y".to_string());
    observability.wire_model = Some("model-y".to_string());
    observability.provider_type = Some("openai_responses".to_string());
    observability.attempts = Some(1);
    observability.response_status = Some("error".to_string());
    observability.provider_status = Some(598);

    let output = project_v3_responses_relay_runtime_failure(
        V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(
            "red-test propagation".to_string(),
        ),
        Some(observability.clone()),
    );
    assert_eq!(output.status, 598);
    let propagated = output
        .observability
        .as_ref()
        .expect("explicit observability must be retained through relay failure projection");
    assert_eq!(propagated.entry_protocol, observability.entry_protocol);
    assert_eq!(propagated.routing_group_id, observability.routing_group_id);
    assert_eq!(propagated.provider_id, observability.provider_id);
    assert_eq!(propagated.provider_key, observability.provider_key);
    assert_eq!(propagated.model_id, observability.model_id);
    assert_eq!(propagated.wire_model, observability.wire_model);
    assert_eq!(propagated.provider_status, observability.provider_status);
    assert_eq!(
        propagated.response_status.as_deref(),
        Some("error"),
        "responses_relay_failures::error_output must overwrite response_status to 'error'"
    );
    let body = match &output.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => {
            panic!("runtime failure must project as JSON")
        }
    };
    assert_eq!(body["error"]["code"], "responses_relay_runtime_error");
    assert_eq!(
        body["error"]["message"],
        "web_search local search hop failed: red-test propagation"
    );
    assert!(
        body["error"].get("stage").is_none()
            && body["error"].get("class").is_none()
            && body["error"].get("decision").is_none()
            && body["error"].get("target_exhausted").is_none()
            && body["error"].get("candidates_remaining").is_none()
            && body["error"].get("error_node").is_none(),
        "Error06 body must not carry control-plane fields even when observability is supplied: {}",
        body["error"]
    );

    let none_output = project_v3_responses_relay_runtime_failure(
        V3ResponsesRelayRuntimeError::WebSearchDispatchFailed("no-obs".to_string()),
        None,
    );
    assert!(
        none_output.observability.is_none(),
        "no observability input must keep output.observability None to preserve previous behavior"
    );
}
