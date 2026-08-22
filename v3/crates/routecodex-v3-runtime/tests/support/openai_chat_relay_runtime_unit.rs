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
    async fn responses_sse_incomplete_terminates_chat_stream_with_done() {
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
            outcome,
        );
        let mut chunks = Vec::new();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => chunks.push(bytes),
                Err(error) => {
                    panic!("response.incomplete must not error the chat stream: {error}")
                }
            }
        }
        let joined_bytes = chunks.concat();
        let joined = String::from_utf8_lossy(&joined_bytes);
        assert!(
            joined.contains(r#""finish_reason":"length""#),
            "incomplete must project terminal finish_reason=length: {joined}"
        );
        assert!(
            joined.contains("data: [DONE]"),
            "incomplete terminal must close the chat SSE stream with [DONE]: {joined}"
        );
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
}
