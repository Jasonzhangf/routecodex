use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::hub_v1::{
    execute_v3_responses_relay_runtime_with_local_continuation, V3ResponsesRelayClientBody,
    V3ResponsesRelayLocalContinuationScope, V3ResponsesRelayLocalContinuationState,
    V3ResponsesRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const GLM_ANTHROPIC_CONFIG: &str =
    include_str!("../../../tests/resources/glm-anthropic-request-outbound-config.toml");

struct GlmAnthropicWireCaptureTransport {
    projection: Arc<Mutex<Option<Value>>>,
}

#[async_trait]
impl ResponsesTransport for GlmAnthropicWireCaptureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        *self.projection.lock().expect("projection lock") =
            Some(request.provider_request_projection());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id": "msg_glm_anthropic_compat",
                "type": "message",
                "role": "assistant",
                "model": "glm-5.2",
                "content": [{"type": "text", "text": "standard anthropic accepted"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 11, "output_tokens": 3}
            }))
            .expect("GLM Anthropic response fixture"),
        ))
    }
}

#[tokio::test]
async fn responses_chat_anthropic_glm_compat_uses_configured_anthropic_target_and_standard_wire() {
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(GLM_ANTHROPIC_CONFIG).expect("GLM config must parse"),
    )
    .expect("GLM config must compile");

    let forwarder = &manifest.forwarders["fwd.v3.glm-5.2"];
    assert_eq!(forwarder.targets.len(), 1);
    assert_eq!(
        forwarder.targets[0].provider.as_deref(),
        Some("glmrelay_anthropic")
    );
    assert!(
        forwarder
            .targets
            .iter()
            .all(|target| target.provider.as_deref() != Some("glmrelay_openai")),
        "GLM Responses forwarder must not route the Anthropic standard mapping through OpenAI"
    );
    assert_eq!(
        manifest.providers["glmrelay_anthropic"]
            .compatibility_profile
            .as_deref(),
        Some("chat:glm")
    );

    let projection = Arc::new(Mutex::new(None));
    let state = V3ResponsesRelayLocalContinuationState::default();
    let output = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "glm_test".to_string(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "glm_test",
                "glm_test",
                concat!(module_path!(), ":", line!()),
            )
            .expect("GLM failure scope"),
            request_id: "req-glm-anthropic-outbound-compat".to_string(),
            payload: json!({
                "model": "glm-5.2",
                "input": [{
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Search, read one file, and reason carefully."}]
                }],
                "reasoning": {"effort": "high", "summary": "detailed"},
                "tools": [
                    {"type": "web_search"},
                    {
                        "type": "function",
                        "name": "read_file",
                        "description": "Read one file",
                        "parameters": {
                            "type": "object",
                            "properties": {"path": {"type": "string"}},
                            "required": ["path"]
                        }
                    }
                ],
                "tool_choice": "auto",
                "stream": false
            }),
        },
        &GlmAnthropicWireCaptureTransport {
            projection: projection.clone(),
        },
        &state,
        V3ResponsesRelayLocalContinuationScope::responses(
            "/v1/responses",
            "session-glm-anthropic-outbound-compat",
            "conversation-glm-anthropic-outbound-compat",
            15555,
            "glm_test",
        ),
        12_000,
    )
    .await
    .expect("Responses relay must reach GLM through Anthropic outbound");

    assert_eq!(output.status, 200);
    match output.client_body {
        V3ResponsesRelayClientBody::Json(value) => {
            assert_eq!(value["usage"]["input_tokens"], 11);
            assert_eq!(value["usage"]["output_tokens"], 3);
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("JSON response expected"),
    }

    let projection = projection
        .lock()
        .expect("projection lock")
        .clone()
        .expect("provider request projection");
    assert_eq!(projection["providerId"], "glmrelay_anthropic");
    assert_eq!(
        projection["url"],
        "https://glm-relayapi.top/v1/messages?beta=true"
    );
    let body = &projection["body"];
    assert_eq!(body["model"], "glm-5.2");
    assert_eq!(body["thinking"]["type"], "adaptive");
    assert_eq!(body["output_config"]["effort"], "high");
    assert!(body["messages"].is_array());
    assert!(body["tools"]
        .as_array()
        .expect("Anthropic tools")
        .iter()
        .any(|tool| tool["type"] == "web_search_20250305" && tool["name"] == "web_search"));
    assert!(body["tools"]
        .as_array()
        .expect("Anthropic tools")
        .iter()
        .any(|tool| tool["name"] == "read_file" && tool["input_schema"].is_object()));
    for forbidden in [
        "input",
        "reasoning",
        "reasoning_effort",
        "web_search_options",
        "applied_profile",
        "native_applied",
    ] {
        assert!(
            body.get(forbidden).is_none(),
            "provider wire leaked non-Anthropic or typed-control field: {forbidden}"
        );
    }
}
