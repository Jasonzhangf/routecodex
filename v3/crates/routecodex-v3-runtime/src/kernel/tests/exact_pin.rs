use super::*;

#[tokio::test]
async fn previous_response_id_is_rejected_without_router_or_provider_reentry() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct NoSendTransport {
        sends: AtomicUsize,
    }

    #[async_trait]
    impl ResponsesTransport for NoSendTransport {
        async fn send(
            &self,
            _request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            self.sends.fetch_add(1, Ordering::SeqCst);
            panic!("retired continuation must never enter provider transport")
        }
    }

    let manifest = test_manifest();
    let transport = NoSendTransport {
        sends: AtomicUsize::new(0),
    };

    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::new(),
        &manifest,
        V3Server03HttpRequestRaw {
            request_purpose: V3RequestPurpose::Conversation,
            port: None,
            pipeline_id: None,
            server_id: "test".to_string(),
            failure_session_scope: test_failure_session_scope("test"),
            request_id: "req-retired-continuation".to_string(),
            execution_id: "exec-retired-continuation".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            body: json!({
                "model":"client-model",
                "previous_response_id":"resp_retired",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_revision_mismatch",
                    "output":"ok"
                }]
            }),
        },
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert_eq!(transport.sends.load(Ordering::SeqCst), 0);
    match output.client_payload.body {
        V3ClientBody::Json(value) => {
            assert_eq!(value["error"]["code"], "v3_route_target_runtime_failure");
            assert_eq!(
                value["error"]["message"],
                "Responses continuation is retired: previous_response_id is unsupported"
            );
        }
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) | V3ClientBody::CommittedSse(_) => {
            panic!("retired continuation must project JSON error")
        }
    }
    assert!(!output.node_trace.contains(&"V3Router07OpaqueTargetHitOnce"));
}
