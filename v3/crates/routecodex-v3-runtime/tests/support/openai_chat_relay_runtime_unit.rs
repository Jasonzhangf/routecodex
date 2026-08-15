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
            provider,
            None,
            V3WebSearchExecutionMode::None,
            None,
            false,
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
            provider,
            None,
            V3WebSearchExecutionMode::None,
            None,
            false,
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
