use super::*;
use std::sync::Mutex;

struct CaptureSelectedProvider {
    provider_ids: Mutex<Vec<String>>,
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
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_now_epoch_ms(now + 10)
            .with_provider_health(provider_health)
            .with_initial_plan(&plan),
        &manifest,
        V3Server03HttpRequestRaw {
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
