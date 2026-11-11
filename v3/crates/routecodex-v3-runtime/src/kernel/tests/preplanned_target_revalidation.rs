use super::*;
use std::sync::Mutex;

struct CaptureSelectedProvider {
    provider_ids: Mutex<Vec<String>>,
}

fn unavailable_protocol_admission_fixture(
    routing_group: &str,
) -> (
    V3Config05ManifestPublished,
    V3ProviderFailureRuntimeHealth,
    V3Server03HttpRequestRaw,
    u64,
) {
    let manifest = scoped_test_manifest(reselection_manifest(), routing_group);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let session = test_failure_session_scope_for(routing_group, "all-unavailable");
    let now =
        crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms().unwrap();
    for provider in ["first", "second"] {
        for offset in 0..3 {
            health
                .record_provider_failure_record(
                    &session,
                    provider,
                    Some("key"),
                    Some("test"),
                    Some("controlled unavailable identity"),
                    now + offset,
                )
                .unwrap();
        }
    }
    let raw = crate::nodes::build_v3_server_03_http_request_raw(
        "test".to_string(),
        session,
        "req-finite-admission".to_string(),
        "exec-finite-admission".to_string(),
        "POST".to_string(),
        "/v1/responses".to_string(),
        json!({"model":"client-model","input":"hello"}),
    );
    (manifest, health, raw, now)
}

#[tokio::test]
async fn protocol_admission_returns_immediately_when_all_candidates_unavailable() {
    let (manifest, health, raw, now) =
        unavailable_protocol_admission_fixture("e37891a_finite_protocol_admission");
    let failure = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        health.clone(),
        now,
    )
    .expect_err("both declared candidates must actually be unavailable");
    assert!(failure.recovery_candidates.is_some());
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(100),
        plan_v3_responses_protocol_execution_with_recovery(&manifest, raw, health, now),
    )
    .await;
    assert!(
        result.is_ok(),
        "protocol admission must return before waiting for recovery"
    );
    assert!(result.unwrap().is_err(), "selection must expose typed unavailability without a Deferred wait");
}

#[async_trait]
impl ResponsesTransport for CaptureSelectedProvider {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.provider_ids
            .lock()
            .expect("provider capture lock")
            .push(request.provider_id().to_string());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            br#"{"id":"resp_second","output_text":"ok"}"#.to_vec(),
        ))
    }
}

#[tokio::test]
async fn direct_kernel_revalidates_preplanned_target_against_session_alternative() {
    let routing_group = "preplanned_target_session_race";
    let manifest = scoped_test_manifest(reselection_manifest(), routing_group);
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_failure_session_scope_for(routing_group, "session-race");
    let now = 1_500_000;
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        V3Server03HttpRequestRaw {
            request_purpose: V3RequestPurpose::Conversation,
            port: Some(7777),
            pipeline_id: Some("test-pipeline:session-race".to_string()),
            server_id: "test".to_string(),
            failure_session_scope: session.clone(),
            request_id: "req-preplanned-race".to_string(),
            execution_id: "exec-preplanned-race".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            body: json!({"model":"client-model","input":"hello"}),
        },
        provider_health.clone(),
        now,
    )
    .expect("initial protocol plan");
    assert_eq!(plan.decision.target.candidate.provider_id, "first");

    for offset in 0..3 {
        provider_health
            .record_provider_failure_record(
                &session,
                "first",
                Some("key"),
                Some("test"),
                Some("controlled pre-send session cooldown"),
                now + offset + 1,
            )
            .expect("pre-send session failure");
    }

    let transport = CaptureSelectedProvider {
        provider_ids: Mutex::new(Vec::new()),
    };
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::new()
            .with_now_epoch_ms(now + 10)
            .with_provider_health(provider_health)
            .with_initial_plan(&plan),
        &manifest,
        V3Server03HttpRequestRaw {
            request_purpose: V3RequestPurpose::Conversation,
            port: Some(7777),
            pipeline_id: Some("test-pipeline:session-race".to_string()),
            server_id: "test".to_string(),
            failure_session_scope: session,
            request_id: "req-preplanned-race".to_string(),
            execution_id: "exec-preplanned-race".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            body: json!({"model":"client-model","input":"hello"}),
        },
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert_eq!(output.client_payload.status, 200, "{output:?}");
    assert_eq!(
        *transport
            .provider_ids
            .lock()
            .expect("provider capture lock"),
        vec!["second"],
        "cooled preplanned provider must not reach transport"
    );
}
