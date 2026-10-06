#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settlement_tail_frame_after_done_is_ignored() {
        assert!(is_v3_openai_chat_settlement_tail_frame(
            r#"{"choices":[],"cost":"0"}"#
        ));
        assert!(is_v3_openai_chat_settlement_tail_frame(r#"{"choices":[]}"#));
        assert!(is_v3_openai_chat_settlement_tail_frame(
            r#"{"type":"ping","cost":"0"}"#
        ));
    }

    #[test]
    fn semantic_frames_after_done_still_fail() {
        assert!(!is_v3_openai_chat_settlement_tail_frame("[DONE]"));
        assert!(!is_v3_openai_chat_settlement_tail_frame(
            r#"{"choices":[{"index":0,"delta":{"content":"hi"}}]}"#
        ));
        assert!(!is_v3_openai_chat_settlement_tail_frame("not json"));
    }

    #[test]
    fn responses_settlement_tail_frames_after_completed_are_benign() {
        assert!(is_v3_responses_settlement_tail_frame(
            r#"{"type":"ping","cost":"0"}"#
        ));
        assert!(is_v3_responses_settlement_tail_frame(
            r#"{"usage":{"total_tokens":1}}"#
        ));
        assert!(is_v3_responses_settlement_tail_frame(r#"{"cost":"0"}"#));
    }

    #[test]
    fn responses_semantic_frames_after_completed_still_fail() {
        assert!(!is_v3_responses_settlement_tail_frame(
            r#"{"type":"response.output_text.delta","delta":"late text"}"#
        ));
        assert!(!is_v3_responses_settlement_tail_frame(
            r#"{"type":"response.function_call_arguments.delta","delta":"late args"}"#
        ));
        assert!(!is_v3_responses_settlement_tail_frame(
            r#"{"type":"response.completed","response":{"status":"completed"}}"#
        ));
    }

    #[test]
    fn responses_transport_keepalives_are_not_semantic_events() {
        assert!(crate::hub_v1::is_v3_provider_sse_transport_keepalive_data("ping"));
        assert!(crate::hub_v1::is_v3_provider_sse_transport_keepalive_data("null"));
        assert!(crate::hub_v1::is_v3_provider_sse_transport_keepalive_data("\n  \n"));
        assert!(!crate::hub_v1::is_v3_provider_sse_transport_keepalive_data(
            r#"{"type":"response.output_text.delta","delta":"x"}"#
        ));
    }

    #[tokio::test]
    async fn responses_sse_transport_keepalive_before_output_does_not_abort_stream() {
        use futures_util::StreamExt;
        let manifest = test_relay_manifest();
        let outcome = test_relay_outcome(&manifest);
        let provider: V3ProviderSseStream = Box::pin(futures_util::stream::iter(vec![
            Ok(b"data: null\n\n".to_vec()),
            Ok(b"data: ping\n\n".to_vec()),
            Ok(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n".to_vec()),
            Ok(b"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec()),
        ]));
        let mut stream = project_responses_sse_as_openai_chat_stream(
            "test-request-id".to_string(),
            "test-session-id".to_string(),
            provider,
            None,
            V3WebSearchExecutionMode::None,
            None,
            false,
            false,
            V3RuntimeStreamObservation::default(),
            true,
            outcome,
        );
        let mut chunks = Vec::new();
        while let Some(chunk) = stream.next().await {
            chunks.push(chunk.expect("transport keepalive must not be projected as provider error"));
        }
        let joined_bytes = chunks.concat();
        let joined = String::from_utf8_lossy(&joined_bytes);
        assert!(joined.contains("hi"));
        assert!(joined.contains("data: [DONE]"));
    }

    #[tokio::test]
    async fn responses_sse_ping_tail_after_completed_does_not_error_the_stream() {
        use futures_util::StreamExt;
        let manifest = test_relay_manifest();
        let outcome = test_relay_outcome(&manifest);
        let provider: V3ProviderSseStream = Box::pin(futures_util::stream::iter(vec![
            Ok(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec()),
            Ok(b"data: {\"type\":\"ping\",\"cost\":\"0\"}\n\n".to_vec()),
        ]));
        let mut stream = project_responses_sse_as_openai_chat_stream(
            "test-request-id".to_string(),
            "test-session-id".to_string(),
            provider,
            None,
            V3WebSearchExecutionMode::None,
            None,
            false,
            false,
            V3RuntimeStreamObservation::default(),
            true,
            outcome,
        );
        let mut chunks = Vec::new();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => chunks.push(bytes),
                Err(error) => {
                    panic!("ping tail after completed must not error the stream: {error}")
                }
            }
        }
        let joined = chunks.concat();
        assert!(
            String::from_utf8_lossy(&joined).contains("data: [DONE]"),
            "chat stream must terminate with [DONE]: {}",
            String::from_utf8_lossy(&joined)
        );
    }

    #[tokio::test]
    async fn responses_sse_semantic_frame_after_completed_errors_the_stream() {
        use futures_util::StreamExt;
        let manifest = test_relay_manifest();
        let outcome = test_relay_outcome(&manifest);
        let provider: V3ProviderSseStream = Box::pin(futures_util::stream::iter(vec![
            Ok(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec()),
            Ok(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"late text\"}\n\n".to_vec()),
        ]));
        let mut stream = project_responses_sse_as_openai_chat_stream(
            "test-request-id".to_string(),
            "test-session-id".to_string(),
            provider,
            None,
            V3WebSearchExecutionMode::None,
            None,
            false,
            false,
            V3RuntimeStreamObservation::default(),
            true,
            outcome,
        );
        let mut saw_error = false;
        while let Some(chunk) = stream.next().await {
            if chunk.is_err() {
                saw_error = true;
            }
        }
        assert!(
            saw_error,
            "semantic frame after response.completed must still fail the stream"
        );
    }

    #[tokio::test]
    async fn responses_sse_incomplete_projects_length_usage_and_done() {
        use futures_util::StreamExt;
        let manifest = test_relay_manifest();
        let outcome = test_relay_outcome(&manifest);
        let provider: V3ProviderSseStream = Box::pin(futures_util::stream::iter(vec![
            Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_inc\",\"status\":\"in_progress\"}}\n\n".to_vec()),
            Ok(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec()),
            Ok(b"event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_inc\",\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15}}}\n\n".to_vec()),
        ]));
        let mut stream = project_responses_sse_as_openai_chat_stream(
            "test-request-id".to_string(),
            "test-session-id".to_string(),
            provider,
            None,
            V3WebSearchExecutionMode::None,
            None,
            false,
            false,
            V3RuntimeStreamObservation::default(),
            true,
            outcome,
        );
        let mut chunks = Vec::new();
        while let Some(chunk) = stream.next().await {
            chunks.push(chunk.expect("valid incomplete terminal must project"));
        }
        let text = String::from_utf8(chunks.concat()).unwrap();
        assert!(text.contains("\"finish_reason\":\"length\""), "{text}");
        assert!(text.contains("\"choices\":[]"), "{text}");
        assert!(text.ends_with("data: [DONE]\n\n"), "{text}");
    }

    #[tokio::test]
    async fn responses_sse_incomplete_type_without_status_projects_length() {
        use futures_util::StreamExt;
        let manifest = test_relay_manifest();
        let outcome = test_relay_outcome(&manifest);
        let provider: V3ProviderSseStream = Box::pin(futures_util::stream::iter(vec![
            Ok(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec()),
            Ok(b"event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_inc\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n".to_vec()),
        ]));
        let mut stream = project_responses_sse_as_openai_chat_stream(
            "test-request-id".to_string(),
            "test-session-id".to_string(),
            provider,
            None,
            V3WebSearchExecutionMode::None,
            None,
            false,
            false,
            V3RuntimeStreamObservation::default(),
            true,
            outcome,
        );
        let mut chunks = Vec::new();
        while let Some(chunk) = stream.next().await {
            chunks.push(chunk.expect("incomplete type with reason must project"));
        }
        let text = String::from_utf8(chunks.concat()).unwrap();
        assert!(text.contains("\"finish_reason\":\"length\""), "{text}");
        assert!(text.ends_with("data: [DONE]\n\n"), "{text}");
    }

    #[tokio::test]
    async fn responses_sse_incomplete_content_filter_projects_terminal_not_error() {
        use futures_util::StreamExt;
        let manifest = test_relay_manifest();
        let outcome = test_relay_outcome(&manifest);
        let provider: V3ProviderSseStream = Box::pin(futures_util::stream::iter(vec![
            Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_cf\",\"status\":\"in_progress\"}}\n\n".to_vec()),
            Ok(b"event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_cf\",\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"content_filter\"},\"usage\":{\"input_tokens\":10,\"output_tokens\":0,\"total_tokens\":10}}}\n\n".to_vec()),
        ]));
        let mut stream = project_responses_sse_as_openai_chat_stream(
            "test-request-id".to_string(),
            "test-session-id".to_string(),
            provider,
            None,
            V3WebSearchExecutionMode::None,
            None,
            false,
            false,
            V3RuntimeStreamObservation::default(),
            true,
            outcome,
        );
        let mut chunks = Vec::new();
        while let Some(chunk) = stream.next().await {
            chunks.push(chunk.expect(
                "a legal content_filter incomplete terminal must project as a Chat final frame, not a stream error",
            ));
        }
        let text = String::from_utf8(chunks.concat()).unwrap();
        assert!(
            text.contains("\"finish_reason\":\"content_filter\""),
            "{text}"
        );
        assert!(text.ends_with("data: [DONE]\n\n"), "{text}");
    }

    #[tokio::test]
    async fn responses_sse_mid_stream_client_disconnect_is_health_neutral() {
        use futures_util::StreamExt;
        use routecodex_v3_provider_responses::V3ProviderAvailabilityReader;
        let manifest = test_relay_manifest();
        let outcome = test_relay_outcome(&manifest);
        let provider_health = outcome.provider_health.clone();
        let provider: V3ProviderSseStream = Box::pin(futures_util::stream::iter(vec![
            Ok(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n".to_vec()),
            Err(V3ProviderError::ClientDisconnect {
                request_id: "req-1".to_string(),
                provider_id: "test".to_string(),
            }),
        ]));
        let mut stream = project_responses_sse_as_openai_chat_stream(
            "test-request-id".to_string(),
            "test-session-id".to_string(),
            provider,
            None,
            V3WebSearchExecutionMode::None,
            None,
            false,
            false,
            V3RuntimeStreamObservation::default(),
            true,
            outcome,
        );
        let mut saw_error = false;
        while let Some(chunk) = stream.next().await {
            if chunk.is_err() {
                saw_error = true;
            }
        }
        assert!(
            saw_error,
            "client disconnect mid-stream must surface as a stream error"
        );
        let availability =
            provider_health.availability("test", Some("key"), Some("model"), u64::MAX);
        assert!(
            availability.available && availability.blocked_scopes.is_empty(),
            "client disconnect must not write provider cooldown/health: {:?}",
            availability.blocked_scopes
        );
    }

    fn test_relay_outcome(
        manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    ) -> V3OpenAiChatSseProviderOutcome {
        V3OpenAiChatSseProviderOutcome {
            provider_health: V3ProviderFailureRuntimeHealth::from_manifest(manifest),
            failure_session_scope: V3ProviderFailureSessionScope::new("test", "default", "s1")
                .expect("test scope"),
            provider_id: "test".to_string(),
            auth_alias: "key".to_string(),
            model_id: "model".to_string(),
            recorded: false,
            _provider_action_permit: None,
        }
    }

    #[test]
    fn relay_resp03_projects_chat_delta_toolreason_after_canonical_conversion() {
        let mut trace = Vec::new();
        let payload = project_json_response(
            Some("req-relay-delta-projection"),
            None,
            json!({
                "object": "chat.completion.chunk",
                "id": "chatcmpl_projection",
                "model": "MiniMax-M3",
                "choices": [{
                    "index": 0,
                    "delta": {"tool_calls": [{
                        "index": 0,
                        "id": "call_projection",
                        "type": "function",
                        "function": {
                            "name": "pwd",
                            "arguments": "{\"goal_alignment_confidence\":100,\"model_id\":\"MiniMax-M3\",\"reason\":\"读取当前目录\"}"
                        }
                    }]},
                    "finish_reason": null
                }]
            }),
            V3HubProviderWireProtocol::OpenAiChat,
            &Value::Null,
            V3HubTransportIntent::Sse,
            &mut trace,
            None,
            V3WebSearchExecutionMode::None,
            None,
            false,
            true,
            "MiniMax-M3",
        )
        .expect("relay response hook must project without protocol failure");

        let arguments = payload
            .pointer("/choices/0/delta/tool_calls/0/function/arguments")
            .and_then(Value::as_str)
            .expect("native arguments remain in client delta");
        assert_eq!(arguments, "{}");
        assert_eq!(
            payload.pointer("/choices/0/delta/reasoning_content"),
            Some(&json!("调用工具 pwd：读取当前目录"))
        );
        let encoded = serde_json::to_string(&payload).expect("client payload serializes");
        assert!(!encoded.contains("goal_alignment_confidence"));
        assert!(!encoded.contains("model_id"));
        assert!(!encoded.contains("\"reason\""));
    }

    fn test_relay_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
        let authoring = routecodex_v3_config::parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"

[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = { request_max_attempts = 1, attempt_max_bytes = 67108864, attempt_max_frames = 262144, request_max_bytes = 67108864, process_max_bytes = 536870912, residence_timeout_ms = 600000 }

[providers.openai]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "ROUTECODEX_V3_TEST_KEY" }] }

[providers.openai.models.gpt-test]
supports_streaming = true
capabilities = ["text"]

[forwarders.responses]
model = "client-model"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "openai", model = "gpt-test", priority = 1 }]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#,
        )
        .expect("test manifest authoring parses");
        routecodex_v3_config::compile_v3_config_05_manifest(authoring)
            .expect("test manifest compiles")
    }

    struct ExecutionControlRejectingTransport {
        sends: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl ResponsesTransport for ExecutionControlRejectingTransport {
        async fn send(
            &self,
            _request: V3Transport13ResponsesHttpRequest,
        ) -> Result<routecodex_v3_provider_responses::V3ProviderResp14Raw, V3ProviderError> {
            self.sends
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            panic!("shared request attempt budget must reject before transport.send")
        }
    }

    #[tokio::test]
    async fn execution_control_payload_architecture_openai_chat_relay_handoff_does_not_reset_attempt_budget(
    ) {
        std::env::set_var("ROUTECODEX_V3_TEST_KEY", "test-secret");
        let manifest = test_relay_manifest();
        let request_execution_control =
            crate::nodes::V3RequestExecutionControl::from_manifest(&manifest, "test")
                .expect("request execution control");
        request_execution_control
            .attempt_budget()
            .admit_transport_attempt()
            .expect("Direct attempt before Relay handoff");
        let transport = ExecutionControlRejectingTransport {
            sends: std::sync::atomic::AtomicUsize::new(0),
        };

        let error = execute_v3_openai_chat_relay_runtime_inner(
            &manifest,
            V3OpenAiChatRelayRuntimeInput {
                server_id: "test".to_string(),
                failure_session_scope: V3ProviderFailureSessionScope::new(
                    "test",
                    "default",
                    "shared-openai-chat-attempt-budget",
                )
                .expect("session scope"),
                request_id: "req-shared-openai-chat-attempt-budget".to_string(),
                payload: json!({
                    "model": "client-model",
                    "messages": [{"role": "user", "content": "hello"}],
                    "stream": false
                }),
            },
            &transport,
            V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
            V3RelayProviderFailureRetryPolicy::default(),
            V3HubExecutionMode::Relay,
            Some(request_execution_control),
            None,
        )
        .await
        .expect_err("Relay must reject the next transport attempt from the shared budget");

        assert!(matches!(error, V3OpenAiChatRelayRuntimeError::Target(_)));
        assert_eq!(
            transport.sends.load(std::sync::atomic::Ordering::Acquire),
            0
        );
    }
}

#[cfg(test)]
mod typed_provider_transport_source_tests {
    use super::*;
    use routecodex_v3_config::V3ResponsesTransportKind;
    use routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS;
    use routecodex_v3_provider_responses::{
        V3ProviderAuthHandle, V3ProviderAuthSecretHandle,
    };
    use serde_json::json;

    fn openai_chat_transport_target(base_url: &str) -> V3ResponsesProviderTarget {
        V3ResponsesProviderTarget {
            provider_id: "openai-chat-typed-provider".to_string(),
            provider_type: "openai_chat".to_string(),
            base_url: base_url.to_string(),
            canonical_model_id: "typed-model".to_string(),
            wire_model: "typed-model".to_string(),
            compatibility_profile: None,
            headers: Default::default(),
            auth: V3ProviderAuthHandle {
                alias: "primary".to_string(),
                secret: V3ProviderAuthSecretHandle::Environment(
                    "ROUTECODEX_TYPED_TRANSPORT_TEST_KEY".to_string(),
                ),
            },
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            request_timeout_ms: 300_000,
            sse_first_frame_timeout_ms: None,
            initial_concurrency_budget: 8,
            concurrency_acquire_timeout_ms: 60_000,
        }
    }

    #[test]
    fn openai_chat_transport_construction_failure_keeps_typed_provider_source_to_public_projection()
    {
        let core_error = <V3OpenAiChatRelayCodec as V3RelayProtocolCodec>::build_transport_request(
            "req-openai-chat-typed-source",
            openai_chat_transport_target("::not-a-url::"),
            V3HubTransportIntent::Json,
            json!({"model": "typed-model", "messages": [{"role": "user", "content": "hello"}]}),
            Vec::new(),
        )
        .expect_err("invalid base URL must fail openai chat transport construction");

        let typed_provider_error = match core_error {
            V3RelayCoreError::Provider(error) => error,
            other => panic!("openai chat codec must keep the typed Provider source, got {other}"),
        };
        assert!(matches!(
            typed_provider_error,
            V3ProviderError::InvalidBaseUrl { .. }
        ));

        let runtime_error = v3_openai_chat_relay_runtime_error_from_core(
            V3RelayCoreError::Provider(typed_provider_error),
        );
        assert!(matches!(
            &runtime_error,
            V3OpenAiChatRelayRuntimeError::Provider(V3ProviderError::InvalidBaseUrl { .. })
        ));

        let output = project_v3_openai_chat_relay_runtime_failure(runtime_error);
        assert_eq!(
            output.status, 598,
            "request-stage provider construction failure must project the internal request lane"
        );
        let body = match &output.client_body {
            V3OpenAiChatRelayClientBody::Json(body) => body,
            V3OpenAiChatRelayClientBody::Sse(_) => panic!("construction failure must project JSON"),
        };
        assert_eq!(body["error"]["code"], "provider_local_runtime_error");
        assert_ne!(body["error"]["code"], "network_error");
        assert!(
            body["error"].get("external_error").is_none(),
            "no fabricated external HTTP witness: {}",
            body["error"]
        );
        assert_eq!(
            output.error_chain.as_deref(),
            Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
        );

        // stage 由公共投影内部的同一 shared mapper 决定；这里用同一 stage 常量核对
        // typed 来源 code/stage，避免从 Display 文本反解析控制事实。
        let source = crate::hooks::build_v3_provider_error_source(
            "V3Transport13ResponsesHttpRequest",
            V3ProviderError::InvalidBaseUrl {
                request_id: "req-openai-chat-typed-source".to_string(),
                provider_id: "openai-chat-typed-provider".to_string(),
                reason: "invalid url".to_string(),
            },
        );
        assert_eq!(source.source_stage, "V3Transport13ResponsesHttpRequest");
        assert_eq!(source.code, "provider_local_runtime_error");
        assert!(source.external_error.is_none());
    }
}
