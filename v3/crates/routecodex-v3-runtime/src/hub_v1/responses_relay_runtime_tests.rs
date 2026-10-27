use super::*;
use crate::execution_control::V3AttemptStoreError;
use futures_util::stream;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use serde_json::json;

#[test]
fn execution_control_payload_architecture_terminal_read_isolated_from_diagnostics_lock() {
    let observation = V3RuntimeStreamObservation::default();
    observation
        .record_provider_event_json(&json!({
            "type": "response.completed",
            "response": {"status": "completed"}
        }))
        .expect("record terminal before diagnostic failure");
    observation.poison_diagnostics_for_test();

    assert_eq!(
        observation
            .semantic_terminal()
            .expect("terminal control must not depend on diagnostic lock"),
        Some(V3RuntimeSemanticTerminal::Success)
    );
}

pub(super) fn anthropic_then_openai_chat_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]

[providers.anthropic_first]
type = "anthropic"
base_url = "http://anthropic.invalid/v1"
default_model = "claude-test"
auth = { type = "api_key", entries = [{ alias = "key", env = "ANTHROPIC_FIRST_KEY" }] }
[providers.anthropic_first.models.claude-test]
wire_name = "claude-test"
capabilities = ["text", "tools"]

[providers.openai_second]
type = "openai_chat"
base_url = "http://openai.invalid/v1"
default_model = "chat-test"
auth = { type = "api_key", entries = [{ alias = "key", env = "OPENAI_SECOND_KEY" }] }
[providers.openai_second.models.chat-test]
wire_name = "chat-test"
capabilities = ["text", "tools"]

[forwarders.mixed]
model = "client-model"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "anthropic_first", model = "claude-test", key = "key", priority = 1 },
  { kind = "provider_model", provider = "openai_second", model = "chat-test", key = "key", priority = 2 }
]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "mixed", priority = 1 }]
"#,
        )
        .expect("mixed protocol authoring");
    compile_v3_config_05_manifest(authoring).expect("mixed protocol manifest")
}

fn anthropic_relay_then_responses_direct_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
        r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]

[providers.relay_first]
type = "anthropic"
base_url = "http://relay.invalid/v1"
default_model = "claude-test"
auth = { type = "api_key", entries = [{ alias = "key", env = "RELAY_FIRST_KEY" }] }
[providers.relay_first.models.claude-test]
wire_name = "claude-test"
capabilities = ["text", "tools"]

[providers.direct_second]
type = "responses"
base_url = "http://direct.invalid/v1"
default_model = "responses-test"
auth = { type = "api_key", entries = [{ alias = "key", env = "DIRECT_SECOND_KEY" }] }
[providers.direct_second.models.responses-test]
wire_name = "responses-test"
capabilities = ["text", "tools"]

[forwarders.mixed]
model = "client-model"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "relay_first", model = "claude-test", key = "key", priority = 2 },
  { kind = "provider_model", provider = "direct_second", model = "responses-test", key = "key", priority = 1 }
]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "mixed", priority = 1 }]
"#,
    )
    .expect("Relay-to-Direct authoring");
    compile_v3_config_05_manifest(authoring).expect("Relay-to-Direct manifest")
}

struct RelayFailsBeforeDirectHandoffTransport {
    provider_ids: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl ResponsesTransport for RelayFailsBeforeDirectHandoffTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.provider_ids
            .lock()
            .expect("provider id recorder")
            .push(request.provider_id().to_string());
        if request.provider_id() == "relay_first" {
            return Err(V3ProviderError::Transport {
                request_id: request.request_id().to_string(),
                provider_id: request.provider_id().to_string(),
                reason: "controlled Relay failure before Direct reselection".to_string(),
            });
        }
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            br#"{"id":"resp_direct_second","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"unexpected relay execution"}]}]}"#.to_vec(),
        ))
    }
}

#[tokio::test]
async fn execution_control_payload_architecture_relay_reselection_returns_typed_direct_handoff() {
    std::env::set_var("RELAY_FIRST_KEY", "relay-secret");
    std::env::set_var("DIRECT_SECOND_KEY", "direct-secret");
    let manifest = anthropic_relay_then_responses_direct_manifest();
    let transport = RelayFailsBeforeDirectHandoffTransport {
        provider_ids: Mutex::new(Vec::new()),
    };

    let output = execute_v3_responses_relay_runtime_inner(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "test".to_string(),
            failure_session_scope: V3ProviderFailureSessionScope::new(
                "test",
                "default",
                "relay-to-direct-handoff-session",
            )
            .expect("session scope"),
            request_id: "req-relay-to-direct-handoff".to_string(),
            payload: json!({"model": "client-model", "input": "hello"}),
        },
        &transport,
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        V3ResponsesRelayRetryPolicy::default(),
        false,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        V3ResponsesRelayRuntimeSeeds::default(),
    )
    .await
    .expect("Relay failure must return a typed Direct handoff");

    let handoff = output
        .protocol_direct_handoff
        .expect("Relay reselection must stop before sending the Direct target");
    assert_eq!(
        handoff.plan.decision.mode,
        crate::nodes::V3Execution11ProtocolDecisionMode::SameProtocolDirect
    );
    assert_eq!(
        handoff
            .request_execution_control
            .attempt_budget()
            .transport_attempts(),
        1
    );
    assert_eq!(
        transport
            .provider_ids
            .lock()
            .expect("provider ids")
            .as_slice(),
        &["relay_first".to_string()]
    );
}

struct RecordingChatTransport {
    provider_ids: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl ResponsesTransport for RecordingChatTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.provider_ids
            .lock()
            .expect("provider id recorder")
            .push(request.provider_id().to_string());
        let response = if request.provider_id() == "openai_second" {
            br#"{"id":"chatcmpl_static_projection","object":"chat.completion","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}"#.to_vec()
        } else {
            br#"{"id":"msg_static_projection","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#.to_vec()
        };
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            response,
        ))
    }
}

#[tokio::test]
async fn target_protocol_unmapped_field_recovers_through_next_provider() {
    std::env::set_var("ANTHROPIC_FIRST_KEY", "anthropic-secret");
    std::env::set_var("OPENAI_SECOND_KEY", "openai-secret");
    let mut manifest = anthropic_then_openai_chat_manifest();
    manifest.forwarders.get_mut("mixed").unwrap().targets[0].priority = Some(3);
    let session_scope =
        V3ProviderFailureSessionScope::new("test", "default", "protocol-incompatible-session")
            .expect("session scope");
    let transport = RecordingChatTransport {
        provider_ids: Mutex::new(Vec::new()),
    };

    let output = execute_v3_responses_relay_runtime_inner(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "test".to_string(),
            failure_session_scope: session_scope,
            request_id: "req-unmapped-field-no-switch".to_string(),
            payload: json!({
                "model": "client-model",
                "input": "hello",
                "store": true
            }),
        },
        &transport,
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        V3ResponsesRelayRetryPolicy::default(),
        false,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        V3ResponsesRelayRuntimeSeeds::default(),
    )
    .await
    .expect("unmapped target field must enter provider recovery");

    assert_eq!(output.status, 200);
    assert!(output
        .node_trace
        .iter()
        .any(|node| *node == "V3TargetLocalReselected"));
    assert_eq!(
        *transport.provider_ids.lock().expect("provider ids"),
        vec!["openai_second"]
    );
}

#[tokio::test]
async fn execution_control_payload_architecture_responses_relay_handoff_does_not_reset_attempt_budget(
) {
    std::env::set_var("ANTHROPIC_FIRST_KEY", "anthropic-secret");
    std::env::set_var("OPENAI_SECOND_KEY", "openai-secret");
    let mut manifest = anthropic_then_openai_chat_manifest();
    manifest
        .servers
        .get_mut("test")
        .and_then(|server| server.execution.as_mut())
        .expect("test server execution policy")
        .attempt_store
        .request_max_attempts = 1;
    manifest
        .servers
        .get_mut("test")
        .unwrap()
        .execution
        .as_mut()
        .unwrap()
        .attempt_store
        .residence_timeout_ms = 300;
    let request_execution_control =
        crate::nodes::V3RequestExecutionControl::from_manifest(&manifest, "test")
            .expect("request execution control");
    request_execution_control
        .attempt_budget()
        .admit_transport_attempt()
        .expect("Direct attempt before Relay handoff");
    let rejection = request_execution_control
        .attempt_budget()
        .admit_transport_attempt();
    assert!(
        matches!(&rejection, Err(V3AttemptStoreError::TransportAttemptsExhausted(message))
        if message.contains("limit 1")),
        "the original attempt ceiling applies before handoff: {rejection:?}"
    );
    let transport = RecordingChatTransport {
        provider_ids: Mutex::new(Vec::new()),
    };

    let error = execute_v3_responses_relay_runtime_inner(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "test".to_string(),
            failure_session_scope: V3ProviderFailureSessionScope::new(
                "test",
                "default",
                "shared-attempt-budget-session",
            )
            .expect("session scope"),
            request_id: "req-shared-attempt-budget".to_string(),
            payload: json!({
                "model": "client-model",
                "input": "hello",
                "store": true
            }),
        },
        &transport,
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        V3ResponsesRelayRetryPolicy::default(),
        false,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        V3ResponsesRelayRuntimeSeeds {
            request_execution_control: Some(request_execution_control.clone()),
            ..Default::default()
        },
    )
    .await
    .expect_err("the configured attempt ceiling must reject the exhausted handoff");

    assert!(matches!(
        error,
        V3ResponsesRelayRuntimeError::ExecutionControl(message)
            if message.contains("transport attempt limit 1 exhausted")
    ));
    assert_eq!(
        transport.provider_ids.lock().expect("provider ids").len(),
        0,
        "the configured ceiling must prevent an additional transport attempt"
    );
    assert_eq!(
        request_execution_control.transport_attempts(),
        1,
        "the handoff must retain the first attempt and reject the second"
    );
    let rejection = request_execution_control
        .attempt_budget()
        .admit_transport_attempt();
    assert!(matches!(&rejection, Err(V3AttemptStoreError::ResidenceDeadlineExceeded(_))),
        "after pending reaches the original residence deadline it takes precedence over the exhausted attempt ceiling: {rejection:?}");
}

#[test]
fn execution_control_payload_architecture_responses_replay_exhaustion_stays_local() {
    let mut manifest = anthropic_then_openai_chat_manifest();
    let attempt_store = &mut manifest
        .servers
        .get_mut("test")
        .and_then(|server| server.execution.as_mut())
        .expect("test server execution policy")
        .attempt_store;
    attempt_store.attempt_max_bytes = 4_096;
    attempt_store.request_max_bytes = 1;
    attempt_store.process_max_bytes = 4_096;
    let request_execution_control =
        crate::nodes::V3RequestExecutionControl::from_manifest(&manifest, "test")
            .expect("request execution control");

    let error = match project_v3_responses_relay_client_body(
        V3HubTransportIntent::Sse,
        json!({"id": "resp-local-resource", "status": "completed", "output": []}),
        false,
        request_execution_control.attempt_budget(),
    ) {
        Err(error) => error,
        Ok(_) => panic!("client replay must reject the request-local byte ceiling"),
    };

    assert!(matches!(
        error,
        V3ResponsesRelayRuntimeError::ExecutionControlResponse(_)
    ));
    assert!(
        !is_v3_responses_provider_response_failure(&error),
        "local replay exhaustion must not enter provider retry or health policy"
    );
}

#[test]
fn missing_execution_block_preserves_relay_mode() {
    let authoring = parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"

[providers.relay]
type = "openai_chat"
base_url = "http://relay.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "RELAY_KEY" }] }
[providers.relay.models.test]
wire_name = "wire-relay"

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "relay", model = "test", key = "key", priority = 1 }]
"#,
        )
        .expect("relay-only authoring");
    let manifest = compile_v3_config_05_manifest(authoring).expect("relay-only manifest");

    assert_eq!(
        allowed_execution_modes_for_relay_server(&manifest, "test").unwrap(),
        vec!["relay".to_string()]
    );
}

#[test]
fn relay_local_tool_output_consumes_call_id_aliases() {
    let payload = json!({
        "input": [{
            "type": "function_call_output",
            "call_id": "call_relay_owned",
            "output": "done"
        }]
    });
    let ids = find_responses_tool_output_ids(&payload).expect("tool output ids");

    assert_eq!(ids.consumed_ids, vec!["call_relay_owned"]);
}

#[test]
fn duplicate_native_provider_tool_identities_preserve_complete_payloads() {
    let hooks = compile_v3_hub_relay_response_hooks();
    for (protocol, payload) in [
        (
            V3HubProviderWireProtocol::OpenAiChat,
            json!({
                "id":"chat_duplicate_calls",
                "choices":[{
                    "message":{
                        "role":"assistant",
                        "tool_calls":[
                            {"type":"function","id":"dup","function":{"name":"lookup","arguments":"{\"query\":\"first\",\"items\":[1,2]}"}},
                            {"type":"function","id":"dup","function":{"name":"lookup_again","arguments":"{\"query\":\"second\",\"items\":[3,4]}"}}
                        ]
                    },
                    "finish_reason":"tool_calls"
                }]
            }),
        ),
        (
            V3HubProviderWireProtocol::Gemini,
            json!({
                "candidates":[{
                    "content":{
                        "role":"model",
                        "parts":[
                            {"functionCall":{"name":"lookup","args":{"query":"first","items":[1,2]}}},
                            {"functionCall":{"name":"lookup","args":{"query":"second","items":[3,4]}}}
                        ]
                    },
                    "finishReason":"STOP"
                }]
            }),
        ),
    ] {
        let raw = build_v3_provider_resp_inbound_01_raw(
            payload.clone(),
            V3HubEntryProtocol::Responses,
            protocol,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let normalized = hooks.normalize(raw).expect("serialized provider response");
        let governed = hooks
            .govern(normalized, &V3HubRelayResponseHookProfile::empty())
            .expect("duplicate identities must not create a provider failure");
        assert_eq!(governed.tool_call_count(), 2);
        assert_eq!(governed.finalized_payload(), &payload);
    }
}

#[test]
fn provider_response_failure_classifier_keeps_provider_and_local_hook_errors_separate() {
    let malformed_tool =
        V3ResponsesRelayRuntimeError::Response(V3HubRelayResponseError::MalformedToolCall {
            index: 5,
            reason: "missing call_id/id",
        });
    assert!(is_v3_responses_provider_response_failure(&malformed_tool));
    let resp03_failure = provider_response_hook_failure(malformed_tool, "controlled", None);
    assert_eq!(
        resp03_failure.source_stage,
        "V3HubRespChatProcess03Governed"
    );
    assert_eq!(
        resp03_failure.policy_error_type,
        "provider_response_event_codec_failure"
    );
    assert!(
        resp03_failure
            .policy_error_message
            .contains("missing call_id/id"),
        "{}",
        resp03_failure.policy_error_message
    );

    let provider_raw_failure = provider_response_hook_failure(
        V3ResponsesRelayRuntimeError::Provider(V3ProviderError::ResponseBody {
            request_id: "req-provider-raw".to_string(),
            provider_id: "controlled".to_string(),
            reason: "controlled provider response body failure".to_string(),
        }),
        "controlled",
        None,
    );
    assert_eq!(
        provider_raw_failure.source_stage,
        "V3ProviderRespInbound01Raw"
    );
    assert!(is_v3_responses_provider_response_failure(
        &V3ResponsesRelayRuntimeError::Response(
            V3HubRelayResponseError::ProviderProtocolResponseMalformed {
                protocol: "responses",
                reason: "output must preserve provider tool identity",
            }
        )
    ));
    assert!(!is_v3_responses_provider_response_failure(
        &V3ResponsesRelayRuntimeError::Response(V3HubRelayResponseError::ExecutionModeNotRelay)
    ));
}

#[test]
fn anthropic_provider_signature_delta_without_string_fails_explicitly() {
    let mut state = anthropic_sse_tree::V3AnthropicSseReducerState::default();
    state
        .apply_event(&json!({
            "type":"message_start",
            "message":{
                "id":"msg_signature",
                "type":"message",
                "role":"assistant",
                "content":[],
                "usage":{"input_tokens":1}
            }
        }))
        .expect("message_start");
    state
        .apply_event(&json!({
            "type":"content_block_start",
            "index":0,
            "content_block":{"type":"thinking","thinking":""}
        }))
        .expect("thinking start");

    let error = state
        .apply_event(&json!({
            "type":"content_block_delta",
            "index":0,
            "delta":{"type":"signature_delta","signature":null}
        }))
        .expect_err("malformed signature_delta must not disappear");

    assert!(error
        .to_string()
        .contains("Anthropic signature_delta requires signature"));
}

#[test]
fn target_selection_sample_is_stable_per_request_and_spans_weighted_buckets() {
    let request_id = "openai-responses-router-gpt-5.5-20260722T143237284-597520-4987";
    assert_eq!(
        v3_relay_provider_target_selection_sample(request_id),
        v3_relay_provider_target_selection_sample(request_id)
    );

    let buckets = (0..32)
        .map(|index| v3_relay_provider_target_selection_sample(&format!("weighted-lb-{index}")) % 2)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        buckets,
        BTreeSet::from([0, 1]),
        "request-id sampling must not pin a two-target weighted pool to one provider"
    );
}

#[tokio::test]
async fn responses_relay_routes_current_user_thinking_after_chat_canonicalization() {
    std::env::set_var("GLM_TEST_KEY", "secret-key");
    std::env::set_var("MINIMAX_TEST_KEY", "secret-key");
    let authoring = parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 5555
routing_group = "g"
endpoints = ["responses"]
[servers.s.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]

[providers.glm]
type = "openai_chat"
base_url = "https://glm.example/v1"
default_model = "glm-5.2"
auth = { type = "api_key", entries = [{ alias = "key1", env = "GLM_TEST_KEY" }] }
[providers.glm.models."glm-5.2"]
capabilities = ["text", "reasoning", "tools"]

[providers.minimax]
type = "openai_chat"
base_url = "https://minimax.example/v1"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MINIMAX_TEST_KEY" }] }
[providers.minimax.models."MiniMax-M3"]
capabilities = ["text", "tools"]

[route_groups.g.pools.thinking]
selection = { strategy = "priority" }
match = { precedence = 1, entry_protocol = "responses" }
targets = [{ kind = "provider_model", provider = "glm", model = "glm-5.2", key = "key1", priority = 1 }]

[route_groups.g.pools.default]
selection = { strategy = "weighted" }
targets = [{ kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key1", weight = 1 }]
"#,
        )
        .expect("config authoring");
    let manifest = compile_v3_config_05_manifest(authoring).expect("manifest");
    let output = execute_v3_responses_relay_dry_run_runtime(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: "s".to_string(),
                failure_session_scope: V3ProviderFailureSessionScope::new(
                    "s",
                    "g",
                    "session-responses-relay-test",
                )
                .expect("test failure session scope"),
                request_id: "req_reasoning_original_surface_route".to_string(),
                payload: json!({
                    "model": "gpt-5.5",
                    "input": [{"type":"message","role":"user","content":"please explain the reasoning step by step"}],
                    "reasoning": {"effort": "high"},
                    "stream": true
                }),
            },
        )
        .await;

    assert_eq!(output.status, 200);
    assert_eq!(output.body["evidence"]["providerNetworkSend"], false);
    assert_eq!(output.body["providerRequest"]["providerId"], "glm");
    assert_eq!(output.body["providerRequest"]["body"]["model"], "glm-5.2");
    std::env::remove_var("GLM_TEST_KEY");
    std::env::remove_var("MINIMAX_TEST_KEY");
}

#[tokio::test]
async fn responses_relay_unknown_direct_provider_model_falls_back_to_default_pool() {
    std::env::set_var("MINIMAX_TEST_KEY", "secret-key");
    let authoring = parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 5555
routing_group = "g"
endpoints = ["responses"]
[servers.s.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]

[providers.minimax]
type = "openai_chat"
base_url = "https://minimax.example/v1"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MINIMAX_TEST_KEY" }] }
[providers.minimax.models."MiniMax-M3"]
capabilities = ["text", "tools"]

[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key1", priority = 1 }]
"#,
        )
        .expect("config authoring");
    let manifest = compile_v3_config_05_manifest(authoring).expect("manifest");
    let output = execute_v3_responses_relay_dry_run_runtime(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: "s".to_string(),
                failure_session_scope: V3ProviderFailureSessionScope::new(
                    "s",
                    "g",
                    "session-responses-relay-404",
                )
                .expect("test failure session scope"),
                request_id: "req_unknown_direct_provider_model".to_string(),
                payload: json!({
                    "model": "minimax.unknown-model",
                    "input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}],
                    "stream": false
                }),
            },
        )
        .await;

    // `minimax.unknown-model` names an enabled provider but no model that provider declares,
    // so it is not a listed direct target: it takes the normal classification path into the
    // `default` pool instead of failing.
    assert_eq!(output.status, 200);
    assert_eq!(output.body["evidence"]["providerNetworkSend"], false);
    assert_eq!(output.body["providerRequest"]["providerId"], "minimax");
    assert_eq!(
        output.body["providerRequest"]["body"]["model"],
        "MiniMax-M3"
    );
    std::env::remove_var("MINIMAX_TEST_KEY");
}

#[test]
fn openai_chat_tool_search_function_call_projects_to_responses_tool_search_call() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id":"chatcmpl_tool_search_call",
            "choices":[{
                "message":{
                    "role":"assistant",
                    "content":"",
                    "tool_calls":[{
                        "id":"call_search_tools",
                        "type":"function",
                        "function":{
                            "name":"tool_search",
                            "arguments":"{\"query\":\"ssh-manager\",\"limit\":8}"
                        }
                    }]
                },
                "finish_reason":"tool_calls"
            }]
        }),
        &json!({
            "tools":[{
                "type":"tool_search",
                "execution":"client",
                "parameters":{"type":"object"}
            }]
        }),
    )
    .expect("OpenAI Chat function tool_search must project back to Responses tool_search_call");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "tool_search_call");
    assert_eq!(response["output"][0]["call_id"], "call_search_tools");
    assert_eq!(response["output"][0]["execution"], "client");
    assert_eq!(response["output"][0]["arguments"]["query"], "ssh-manager");
    assert_eq!(response["output"][0]["arguments"]["limit"], 8);
    assert!(
        !serde_json::to_string(&response)
            .unwrap()
            .contains("function_call"),
        "tool_search must not return to Codex as a generic function_call: {response}"
    );
}

/// The shared eligibility owner must keep the Chat inverse aligned with the
/// Anthropic one: only a client-executed declaration grants the native kind.
/// Server execution and omitted execution stay ordinary function calls.
#[test]
fn openai_chat_non_client_tool_search_function_call_keeps_ordinary_kind() {
    for declaration in [
        json!({"type":"tool_search","execution":"server","parameters":{"type":"object"}}),
        json!({"type":"tool_search","parameters":{"type":"object"}}),
    ] {
        let response = build_v3_responses_provider_response_from_openai_chat_payload(
            &json!({
                "id":"chatcmpl_tool_search_call",
                "choices":[{
                    "message":{
                        "role":"assistant",
                        "content":"",
                        "tool_calls":[{
                            "id":"call_search_tools",
                            "type":"function",
                            "function":{
                                "name":"tool_search",
                                "arguments":"{\"query\":\"ssh-manager\",\"limit\":8}"
                            }
                        }]
                    },
                    "finish_reason":"tool_calls"
                }]
            }),
            &json!({"tools":[declaration]}),
        )
        .expect("a non-client tool_search call must still project to the Responses client");

        assert_eq!(response["status"], "completed");
        assert_eq!(response["output"][0]["type"], "function_call");
        assert_eq!(response["output"][0]["name"], "tool_search");
        assert_eq!(response["output"][0]["call_id"], "call_search_tools");
        assert_eq!(
            response["output"][0]["arguments"], "{\"query\":\"ssh-manager\",\"limit\":8}",
            "original arguments must stay verbatim"
        );
        assert!(
            response["output"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["type"] != "tool_search_call"),
            "a non-client declaration must not gain client-native authority: {response}"
        );
    }
}

#[test]
fn openai_chat_declared_namespace_function_call_restores_namespace_for_responses_client() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({"id":"chatcmpl_mcpx_workspace","choices":[{
            "message":{"role":"assistant","content":"","tool_calls":[{
                "id":"call_mcpx_workspace","type":"function",
                "function":{"name":"mcp__mcpx__workspace","arguments":"{}"}
            }]},"finish_reason":"tool_calls"
        }]}),
        &json!({"tools":[{"type":"namespace","name":"mcp__mcpx","tools":[
            {"type":"function","name":"workspace","parameters":{"type":"object"}}
        ]}]}),
    )
    .expect("declared namespace function call must restore namespace for Responses client");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "function_call");
    assert_eq!(response["output"][0]["namespace"], "mcp__mcpx");
    assert_eq!(response["output"][0]["name"], "workspace");
    assert_eq!(response["output"][0]["call_id"], "call_mcpx_workspace");
    let followup = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model":"deepseek-v4.1-flash",
        "messages":[
            {"role":"user","content":"list workspaces"},
            {"role":"assistant","tool_calls":[{"id":"call_mcpx_workspace","type":"function","function":{"name":"mcp__mcpx__workspace","arguments":"{}"}}]},
            {"role":"tool","tool_call_id":"call_mcpx_workspace","content":"workspace result"}
        ],
        "tools":[{"type":"namespace","name":"mcp__mcpx","tools":[
            {"type":"function","name":"workspace","parameters":{"type":"object"}}
        ]}]
    }))
    .expect("the declared MCP namespace must accept the client tool result");
    assert_eq!(followup["tools"].as_array().unwrap().len(), 1);
    assert_eq!(
        followup["messages"][1]["tool_calls"][0]["id"],
        followup["messages"][2]["tool_call_id"]
    );
}

#[test]
fn openai_chat_web_search_function_call_remains_pending_local_servertool_call() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id":"chatcmpl_web_search_call",
            "choices":[{
                "message":{
                    "role":"assistant",
                    "content":"",
                    "tool_calls":[{
                        "id":"call_web_search",
                        "type":"function",
                        "function":{
                            "name":"web_search",
                            "arguments":"{\"query\":\"RouteCodex docs\"}"
                        }
                    }]
                },
                "finish_reason":"tool_calls"
            }]
        }),
        &json!({"tools":[{"type":"function","function":{"name":"web_search"}}]}),
    )
    .expect(
        "OpenAI Chat function web_search must remain pending for Resp03 ServerTool interception",
    );

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "function_call");
    assert_eq!(response["output"][0]["call_id"], "call_web_search");
    assert_eq!(response["output"][0]["name"], "web_search");
    assert_eq!(
        response["output"][0]["arguments"],
        "{\"query\":\"RouteCodex docs\"}"
    );
    assert!(response["output"][0].get("status").is_none());
}

#[test]
fn usage_summary_counts_cache_reads_but_not_cache_writes() {
    let summary = extract_v3_runtime_usage_summary(&json!({
        "usage": {
            "input_tokens": 59_842,
            "input_tokens_details": {
                "cached_read_tokens": 41_984,
                "cached_write_tokens": 7,
                "cache_write_tokens": 11
            },
            "output_tokens": 822,
            "total_tokens": 60_664
        }
    }))
    .expect("usage summary");
    assert_eq!(summary.input_tokens, Some(59_842));
    assert_eq!(summary.cache_read_input_tokens, Some(41_984));
    assert_eq!(summary.cache_creation_input_tokens, Some(7));
    assert_eq!(summary.cached_tokens, None);
}

#[test]
fn usage_summary_derives_total_when_anthropic_omits_it() {
    let summary = extract_v3_runtime_usage_summary(&json!({
        "usage": {
            "input_tokens": 10,
            "output_tokens": 2
        }
    }))
    .expect("Anthropic usage summary");

    assert_eq!(summary.input_tokens, Some(10));
    assert_eq!(summary.output_tokens, Some(2));
    assert_eq!(summary.total_tokens, Some(12));
}

#[test]
fn usage_summary_omits_derived_total_on_u64_overflow() {
    let summary = extract_v3_runtime_usage_summary(&json!({
        "usage": {
            "input_tokens": u64::MAX,
            "output_tokens": 1
        }
    }))
    .expect("Anthropic usage summary");

    assert_eq!(summary.input_tokens, Some(u64::MAX));
    assert_eq!(summary.output_tokens, Some(1));
    assert_eq!(summary.total_tokens, None);
}

#[test]
fn usage_summary_accepts_integer_valued_floats_and_rejects_fractions() {
    let summary = extract_v3_runtime_usage_summary(&json!({
        "usage": {
            "input_tokens": 59_842.0,
            "output_tokens": 822.0,
            "total_tokens": 60_664.0,
            "input_tokens_details": {
                "cached_tokens": 41_984.0
            }
        }
    }))
    .expect("integer-valued float usage summary");
    assert_eq!(summary.input_tokens, Some(59_842));
    assert_eq!(summary.output_tokens, Some(822));
    assert_eq!(summary.total_tokens, Some(60_664));
    assert_eq!(summary.cached_tokens, Some(41_984));

    let fractional = extract_v3_runtime_usage_summary(&json!({
        "usage": {
            "input_tokens": 1.5,
            "output_tokens": 2.25
        }
    }));
    assert!(
        fractional.is_none(),
        "fractional usage must not be silently truncated to integer tokens"
    );
}

#[test]
fn usage_summary_preserves_glm_anthropic_top_level_cache_fields() {
    let summary = extract_v3_runtime_usage_summary(&json!({
        "model": "glm-5.3",
        "usage": {
            "input_tokens": 1_000,
            "output_tokens": 20,
            "total_tokens": 1_020,
            "cache_read_input_tokens": 700,
            "cache_creation_input_tokens": 200
        }
    }))
    .expect("GLM usage summary");

    assert_eq!(summary.input_tokens, Some(1_000));
    assert_eq!(summary.output_tokens, Some(20));
    assert_eq!(summary.total_tokens, Some(1_020));
    assert_eq!(summary.cache_read_input_tokens, Some(700));
    assert_eq!(summary.cache_creation_input_tokens, Some(200));
    assert_eq!(summary.cached_tokens, None);
}

#[test]
fn usage_summary_preserves_minimax_anthropic_top_level_cache_fields() {
    let summary = extract_v3_runtime_usage_summary(&json!({
        "model": "MiniMax-M3",
        "usage": {
            "input_tokens": 2_000,
            "output_tokens": 40,
            "total_tokens": 2_040,
            "cache_read_input_tokens": 1_400,
            "cache_creation_input_tokens": 300
        }
    }))
    .expect("MiniMax usage summary");

    assert_eq!(summary.input_tokens, Some(2_000));
    assert_eq!(summary.output_tokens, Some(40));
    assert_eq!(summary.total_tokens, Some(2_040));
    assert_eq!(summary.cache_read_input_tokens, Some(1_400));
    assert_eq!(summary.cache_creation_input_tokens, Some(300));
    assert_eq!(summary.cached_tokens, None);
}

#[test]
fn openai_chat_zero_usage_diagnostic_text_preserves_business_output() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_zero_output_diagnostic",
            "model": "glm-5.2",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "upstream returned zero output tokens, input_tokens=76100",
                    "reasoning_content": "Let me rethink this one step at a time."
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "input_tokens": 0,
                "output_tokens": 0
            }
        }),
        &json!({
            "tools": [{"type":"function","function":{"name":"exec_command"}}]
        }),
    )
    .expect("diagnostic-looking content is provider business output");
    assert_eq!(response["status"], "completed");
    assert_eq!(
        response["output_text"],
        "upstream returned zero output tokens, input_tokens=76100"
    );
}

#[tokio::test]
async fn openai_chat_zero_usage_stream_preserves_business_output() {
    let observation = V3RuntimeStreamObservation::default();
    let raw_sse = concat!(
            "data: {\"id\":\"chatcmpl_zero_output_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784812451,\"model\":\"glm-5.2\",\"choices\":[{\"delta\":{\"reasoning_content\":\"Let me rethink this one step at a time.\\n\",\"role\":\"assistant\"},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n",
            "data: {\"id\":\"chatcmpl_zero_output_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784812451,\"model\":\"glm-5.2\",\"choices\":[{\"delta\":{\"content\":\"upstream returned zero output tokens, input_tokens=76100\",\"role\":\"assistant\"},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n",
            "data: {\"id\":\"chatcmpl_zero_output_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784812451,\"model\":\"glm-5.2\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\",\"index\":0}],\"usage\":null}\n\n",
            "data: {\"id\":\"chatcmpl_zero_output_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784812451,\"model\":\"glm-5.2\",\"choices\":[],\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":0,\"total_tokens\":0,\"input_tokens\":0,\"output_tokens\":0,\"completion_tokens_details\":{\"reasoning_tokens\":0}}}\n\n",
            "data: [DONE]\n\n",
        );
    let provider = Box::pin(stream::iter(vec![Ok(raw_sse.as_bytes().to_vec())]));
    let provider_payload = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
        provider,
        &observation,
    )
    .await
    .expect("stream diagnostic materializes before semantic projection");

    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &provider_payload,
        &json!({
            "tools": [{"type":"function","function":{"name":"exec_command"}}]
        }),
    )
    .expect("diagnostic-looking stream content is business output");
    assert_eq!(response["status"], "completed");
    assert_eq!(
        response["output_text"],
        "upstream returned zero output tokens, input_tokens=76100"
    );
    assert_eq!(
        observation
            .snapshot()
            .expect("stream observation")
            .finish_reason
            .as_deref(),
        Some("stop")
    );
}

#[tokio::test]
async fn openai_chat_reasoning_only_stop_stream_preserves_reasoning() {
    let observation = V3RuntimeStreamObservation::default();
    let raw_sse = concat!(
        "data: {\"id\":\"chatcmpl_reasoning_only\",\"object\":\"chat.completion.chunk\",\"created\":1784812451,\"model\":\"grok-4.6\",\"choices\":[{\"delta\":{\"reasoning_content\":\"internal reasoning only\",\"role\":\"assistant\"},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n",
        "data: {\"id\":\"chatcmpl_reasoning_only\",\"object\":\"chat.completion.chunk\",\"created\":1784812451,\"model\":\"grok-4.6\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\",\"index\":0}],\"usage\":null}\n\n",
        "data: {\"id\":\"chatcmpl_reasoning_only\",\"object\":\"chat.completion.chunk\",\"created\":1784812451,\"model\":\"grok-4.6\",\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":30,\"total_tokens\":42,\"input_tokens\":12,\"output_tokens\":30}}\n\n",
        "data: [DONE]\n\n",
    );
    let provider = Box::pin(stream::iter(vec![Ok(raw_sse.as_bytes().to_vec())]));
    let provider_payload = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
        provider,
        &observation,
    )
    .await
    .expect("reasoning-only terminal stream must materialize before semantic validation");

    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &provider_payload,
        &json!({
            "tools": [{"type":"function","function":{"name":"exec_command"}}]
        }),
    )
    .expect("reasoning-only output is representable");
    assert_eq!(response["status"], "completed");
    assert_eq!(
        response["output"][0]["content"][0]["text"],
        "internal reasoning only"
    );
}

#[test]
fn openai_chat_visible_zero_output_text_with_real_usage_remains_success() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_visible_text",
            "model": "glm-5.2",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "upstream returned zero output tokens is only quoted text here"
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 9,
                "total_tokens": 21
            }
        }),
        &json!({"tools":[]}),
    )
    .expect("visible content with real usage must stay a valid response");

    assert_eq!(response["status"], "completed");
    assert_eq!(
        response["output"][0]["text"],
        "upstream returned zero output tokens is only quoted text here"
    );
}

#[test]
fn openai_chat_zero_usage_overload_text_preserves_business_output() {
    let provider_payload = json!({
        "id": "chatcmpl_overload_diagnostic",
        "model": "glm-5.2",
        "choices": [{
            "message": {
                "role": "assistant",
                "content": "mac超负荷运载，应该是挂了"
            },
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}
    });
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &provider_payload,
        &json!({"tools": [{"type":"function","function":{"name":"exec_command"}}]}),
    )
    .expect("overload-looking text is business output");
    assert_eq!(response["status"], "completed");
    assert_eq!(response["output_text"], "mac超负荷运载，应该是挂了");
}

#[tokio::test]
async fn openai_chat_zero_usage_overload_stream_preserves_business_output() {
    let observation = V3RuntimeStreamObservation::default();
    let raw_sse = concat!(
            "data: {\"id\":\"chatcmpl_overload_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784865608,\"model\":\"glm-5.2\",\"choices\":[{\"delta\":{\"reasoning_content\":\"checking\\n\",\"role\":\"assistant\"},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n",
            "data: {\"id\":\"chatcmpl_overload_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784865638,\"model\":\"glm-5.2\",\"choices\":[{\"delta\":{\"content\":\"mac超负荷运载，应该是挂了\",\"role\":\"assistant\"},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n",
            "data: {\"id\":\"chatcmpl_overload_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784865638,\"model\":\"glm-5.2\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\",\"index\":0}],\"usage\":null}\n\n",
            "data: {\"id\":\"chatcmpl_overload_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784865638,\"model\":\"glm-5.2\",\"choices\":[],\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":0,\"total_tokens\":0,\"input_tokens\":0,\"output_tokens\":0}}\n\n",
            "data: [DONE]\n\n",
        );
    let provider = Box::pin(stream::iter(vec![Ok(raw_sse.as_bytes().to_vec())]));
    let provider_payload = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
        provider,
        &observation,
    )
    .await
    .expect("stream diagnostic materializes before semantic policy");

    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &provider_payload,
        &json!({"tools": [{"type":"function","function":{"name":"exec_command"}}]}),
    )
    .expect("overload-looking stream content is business output");
    assert_eq!(response["status"], "completed");
    assert_eq!(response["output_text"], "mac超负荷运载，应该是挂了");
}

#[test]
fn openai_chat_invalid_field_type_text_preserves_business_output() {
    let provider_payload = json!({
        "id": "chatcmpl_invalid_field_type",
        "model": "glm-5.2",
        "choices": [{
            "message": {
                "role": "assistant",
                "content": "field Tools[8].Type invalid, should be set"
            },
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 12, "completion_tokens": 1, "total_tokens": 13}
    });
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &provider_payload,
        &json!({"tools":[]}),
    )
    .expect("error-looking text is business output");
    assert_eq!(response["status"], "completed");
    assert_eq!(
        response["output_text"],
        "field Tools[8].Type invalid, should be set"
    );
}

#[test]
fn openai_chat_overload_text_with_real_usage_remains_success() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_overload_visible_text",
            "model": "glm-5.2",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "mac超负荷运载，应该是挂了"
                },
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens":12,"completion_tokens":9,"total_tokens":21}
        }),
        &json!({"tools": []}),
    )
    .expect("visible overload-looking content with real usage stays model output");

    assert_eq!(response["status"], "completed");
}

#[test]
fn openai_chat_provider_reasoning_content_projects_replay_content_before_tool_call() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_reasoning_content",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "Need inspect before running the tool.",
                    "tool_calls": [{
                        "id": "call_reasoning_exec",
                        "type": "custom",
                        "custom": {
                            "name": "exec",
                            "input": "pwd"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        &json!({
            "tools": [{"type":"custom","name":"exec"}]
        }),
    )
    .expect("OpenAI Chat response must project reasoning to Responses");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "reasoning");
    assert_eq!(
            response["output"][0]["summary"][0]["text"], "Need inspect before running the tool.",
            "OpenAI Chat reasoning_content must become replay-safe Responses reasoning.summary before tool calls"
        );
    assert_eq!(
        response["output"][0]["content"][0]["text"], "Need inspect before running the tool.",
        "OpenAI Chat reasoning_content must also populate replay-safe Responses reasoning.content"
    );
    assert_eq!(response["output"][1]["type"], "custom_tool_call");
    assert_eq!(response["output"][1]["call_id"], "call_reasoning_exec");
}

#[test]
fn openai_chat_custom_tool_response_round_trips_to_responses_custom_call() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_apply_patch",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call_apply_patch",
                        "type": "custom",
                        "custom": {
                            "name": "apply_patch",
                            "input": "*** Begin Patch\n*** End Patch"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        &json!({
            "tools": [{
                "type":"custom",
                "name":"apply_patch",
                "format":{"type":"grammar","syntax":"lark","definition":"start: patch"}
            }]
        }),
    )
    .expect("Chat function projection must reverse to the declared Responses custom tool");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["name"], "apply_patch");
    assert_eq!(
        response["output"][0]["input"],
        "*** Begin Patch\n*** End Patch"
    );
}

#[test]
fn openai_chat_function_tool_call_with_custom_declared_name_round_trips_as_custom_call() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_apply_patch_flattened",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call_apply_patch_2",
                        "type": "function",
                        "function": {
                            "name": "apply_patch",
                            "arguments": "{\"input\":\"*** Begin Patch\\n*** End Patch\",\"reason\":\"修改目标文件\",\"goal_alignment_confidence\":100,\"model_id\":\"gpt-test\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        &json!({
            "tools": [{"type":"custom","name":"apply_patch"}]
        }),
    )
    .expect("flattened function tool_call must reverse to the declared Responses custom tool");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["name"], "apply_patch");
    assert_eq!(
        response["output"][0]["input"],
        "*** Begin Patch\n*** End Patch"
    );
}

#[test]
fn openai_chat_provider_structured_reasoning_keeps_summary_encrypted_and_replay_content() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_structured_reasoning",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "visible answer",
                    "reasoning": {
                        "summary": [{"type":"summary_text","text":"safe summary"}],
                        "content": [{"type":"reasoning_text","text":"private chain"}],
                        "encrypted_content": "enc-opaque"
                    }
                },
                "finish_reason": "stop"
            }]
        }),
        &json!({"tools":[]}),
    )
    .expect("OpenAI Chat structured reasoning must project to Responses");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "reasoning");
    assert_eq!(response["output"][0]["summary"][0]["text"], "safe summary");
    assert_eq!(response["output"][0]["encrypted_content"], "enc-opaque");
    assert_eq!(
        response["output"][0]["content"][0]["text"], "safe summary",
        "Responses reasoning item must carry replay-safe plaintext content"
    );
    assert_eq!(response["output"][1]["type"], "output_text");
    assert_eq!(response["output"][1]["text"], "visible answer");
    assert!(
        !response.to_string().contains("private chain"),
        "private reasoning.content must not be serialized into the client payload: {response}"
    );
}

#[test]
fn openai_chat_provider_usage_normalizes_to_hub_canonical_token_names() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_usage_shape",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 11,
                "prompt_tokens_details": {"cached_tokens": 5},
                "completion_tokens": 7,
                "completion_tokens_details": {"reasoning_tokens": 2},
                "total_tokens": 18
            }
        }),
        &json!({"tools":[]}),
    )
    .expect("OpenAI Chat response must project to Responses");

    assert_eq!(response["usage"]["input_tokens"], 11);
    assert_eq!(
        response["usage"]["input_tokens_details"]["cached_tokens"],
        5
    );
    assert_eq!(response["usage"]["output_tokens"], 7);
    assert_eq!(
        response["usage"]["output_tokens_details"]["reasoning_tokens"],
        2
    );
    assert_eq!(response["usage"]["total_tokens"], 18);
    assert!(
            response["usage"].get("prompt_tokens").is_none(),
            "Hub canonical response usage must not expose OpenAI Chat provider-wire prompt_tokens: {response}"
        );
    assert!(
            response["usage"].get("completion_tokens").is_none(),
            "Hub canonical response usage must not expose OpenAI Chat provider-wire completion_tokens: {response}"
        );
}

fn committed_hook_failure_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
        r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]

[providers.openai_first]
type = "openai_chat"
base_url = "http://openai-first.invalid/v1"
default_model = "chat-test"
auth = { type = "api_key", entries = [{ alias = "key", env = "COMMITTED_FIRST_KEY" }] }
[providers.openai_first.models.chat-test]
wire_name = "chat-test"
capabilities = ["text"]

[providers.openai_second]
type = "openai_chat"
base_url = "http://openai-second.invalid/v1"
default_model = "chat-test"
auth = { type = "api_key", entries = [{ alias = "key", env = "COMMITTED_SECOND_KEY" }] }
[providers.openai_second.models.chat-test]
wire_name = "chat-test"
capabilities = ["text"]

[forwarders.mixed]
model = "client-model"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "openai_first", model = "chat-test", key = "key", priority = 1 },
  { kind = "provider_model", provider = "openai_second", model = "chat-test", key = "key", priority = 2 }
]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "mixed", priority = 1 }]
"#,
    )
    .expect("committed hook failure authoring");
    compile_v3_config_05_manifest(authoring).expect("committed hook failure manifest")
}

struct CommittedHookFailureTransport {
    provider_ids: Mutex<Vec<String>>,
}

enum CommittedRoundReply {
    SseFirst,
    Json(Vec<u8>),
}

struct CommittedRoundTransport {
    provider_ids: Mutex<Vec<String>>,
    reply: CommittedRoundReply,
}

#[async_trait::async_trait]
impl ResponsesTransport for CommittedRoundTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.provider_ids
            .lock()
            .expect("provider id recorder")
            .push(request.provider_id().to_string());
        match &self.reply {
            CommittedRoundReply::SseFirst => {
                let provider: routecodex_v3_provider_responses::V3ProviderSseStream =
                    Box::pin(stream::iter(vec![
                        Ok(b"data: {\"id\":\"chatcmpl_committed_refill\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"chat-test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"first\"}}]}\n\n".to_vec()),
                        Ok(b"data: {\"id\":\"chatcmpl_committed_refill\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"chat-test\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n".to_vec()),
                        Ok(b"data: [DONE]\n\n".to_vec()),
                    ]));
                Ok(V3ProviderResp14Raw::from_sse(
                    request.request_id().to_string(),
                    request.provider_id().to_string(),
                    200,
                    vec![V3ProviderResponseHeader {
                        name: "content-type".to_string(),
                        value: b"text/event-stream".to_vec(),
                    }],
                    provider,
                ))
            }
            CommittedRoundReply::Json(body) => Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                body.clone(),
            )),
        }
    }
}

fn committed_round_input(request_id: &str) -> V3ResponsesRelayRuntimeInput {
    V3ResponsesRelayRuntimeInput {
        server_id: "test".to_string(),
        failure_session_scope: V3ProviderFailureSessionScope::new(
            "test",
            "default",
            "committed-cross-round-session",
        )
        .expect("session scope"),
        request_id: request_id.to_string(),
        payload: json!({"model": "client-model", "stream": true, "input": "hello"}),
    }
}

async fn execute_committed_first_round(
    manifest: &V3Config05ManifestPublished,
    transport: &CommittedRoundTransport,
    sink: &crate::nodes::V3CommittedClientFrameSink,
    projection: &super::relay_client_frames::V3RelayClientProjectionHandle,
) -> V3ResponsesRelayRuntimeOutput {
    execute_v3_responses_relay_runtime_inner(
        manifest,
        committed_round_input("req-committed-first-round"),
        transport,
        V3ProviderFailureRuntimeHealth::from_manifest(manifest),
        V3ResponsesRelayRetryPolicy::default(),
        false,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        V3ResponsesRelayRuntimeSeeds {
            client_frame_sink: Some(sink.clone()),
            client_stream_projection: Some(projection.clone()),
            ..V3ResponsesRelayRuntimeSeeds::default()
        },
    )
    .await
    .expect("the first visible text must commit the SSE round")
}

async fn execute_committed_follow_up_round(
    manifest: &V3Config05ManifestPublished,
    transport: &CommittedRoundTransport,
    sink: &crate::nodes::V3CommittedClientFrameSink,
    projection: &super::relay_client_frames::V3RelayClientProjectionHandle,
    request_id: &str,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_inner(
        manifest,
        committed_round_input(request_id),
        transport,
        V3ProviderFailureRuntimeHealth::from_manifest(manifest),
        V3ResponsesRelayRetryPolicy::default(),
        false,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        V3ResponsesRelayRuntimeSeeds {
            client_frame_sink: Some(sink.clone()),
            client_stream_projection: Some(projection.clone()),
            ..V3ResponsesRelayRuntimeSeeds::default()
        },
    )
    .await
}

fn sse_payloads(frames: &[String]) -> Vec<serde_json::Value> {
    frames
        .iter()
        .filter_map(|frame| {
            let data = frame
                .lines()
                .filter_map(|line| line.strip_prefix("data:").map(str::trim))
                .collect::<Vec<_>>()
                .join("\n");
            (!data.is_empty())
                .then(|| serde_json::from_str(&data).ok())
                .flatten()
        })
        .collect()
}

#[async_trait::async_trait]
impl ResponsesTransport for CommittedHookFailureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.provider_ids
            .lock()
            .expect("provider id recorder")
            .push(request.provider_id().to_string());
        // First visible text commits the client channel. The response governance
        // then rejects the orphan tool-close marker, which is a response-hook
        // failure that arrives after the client already holds business frames.
        let provider: routecodex_v3_provider_responses::V3ProviderSseStream =
            Box::pin(stream::iter(vec![
                Ok(b"data: {\"id\":\"chatcmpl_committed\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"chat-test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hello\\n\"}}]}\n\n".to_vec()),
                Ok(b"data: {\"id\":\"chatcmpl_committed\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"chat-test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"</\xef\xbd\x9cDSML\xef\xbd\x9ctool_calls>\"},\"finish_reason\":\"stop\"}]}\n\n".to_vec()),
                Ok(b"data: [DONE]\n\n".to_vec()),
            ]));
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            provider,
        ))
    }
}

#[tokio::test]
async fn committed_relay_stream_ends_after_a_response_hook_failure_without_a_second_candidate() {
    std::env::set_var("COMMITTED_FIRST_KEY", "first-secret");
    std::env::set_var("COMMITTED_SECOND_KEY", "second-secret");
    let manifest = committed_hook_failure_manifest();
    let transport = CommittedHookFailureTransport {
        provider_ids: Mutex::new(Vec::new()),
    };
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let projection: super::relay_client_frames::V3RelayClientProjectionHandle =
        std::sync::Arc::new(std::sync::Mutex::new(None));

    let _output = execute_v3_responses_relay_runtime_inner(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "test".to_string(),
            failure_session_scope: V3ProviderFailureSessionScope::new(
                "test",
                "default",
                "committed-hook-failure-session",
            )
            .expect("session scope"),
            request_id: "req-committed-hook-failure".to_string(),
            payload: json!({"model": "client-model", "stream": true, "input": "hello"}),
        },
        &transport,
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        V3ResponsesRelayRetryPolicy::default(),
        false,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        V3ResponsesRelayRuntimeSeeds {
            client_frame_sink: Some(sink),
            client_stream_projection: Some(projection),
            ..V3ResponsesRelayRuntimeSeeds::default()
        },
    )
    .await
    .expect("a committed stream must end through its typed provider failure");

    // The committed channel owns the response head: no second candidate may be
    // attempted, because a second attempt would append a second response.
    assert_eq!(
        transport.provider_ids.lock().expect("provider ids").len(),
        1,
        "a failure after the first business frame must not select another candidate"
    );
    let mut frames = Vec::new();
    while let Ok(frame) = receiver.try_recv() {
        frames.push(String::from_utf8_lossy(&frame).to_string());
    }
    let heads = frames
        .iter()
        .filter(|frame| frame.contains("response.created"))
        .count();
    assert_eq!(
        heads, 1,
        "the committed stream must carry exactly one response head, got {frames:?}"
    );
}

#[tokio::test]
async fn committed_relay_sse_round_then_json_hook_failure_does_not_retry_or_add_a_head() {
    std::env::set_var("COMMITTED_FIRST_KEY", "first-secret");
    std::env::set_var("COMMITTED_SECOND_KEY", "second-secret");
    let manifest = committed_hook_failure_manifest();
    let first_transport = CommittedRoundTransport {
        provider_ids: Mutex::new(Vec::new()),
        reply: CommittedRoundReply::SseFirst,
    };
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let projection: super::relay_client_frames::V3RelayClientProjectionHandle =
        std::sync::Arc::new(std::sync::Mutex::new(None));

    let _first_output =
        execute_committed_first_round(&manifest, &first_transport, &sink, &projection).await;
    {
        let mut slot = projection.lock().expect("projection handle");
        slot.as_mut()
            .expect("committed projection")
            .close_round()
            .expect("close the committed round");
    }

    let second_transport = CommittedRoundTransport {
        provider_ids: Mutex::new(Vec::new()),
        reply: CommittedRoundReply::Json(
            json!({
                "id": "chatcmpl_committed_json_failure",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": "second\n</\u{FF5C}DSML\u{FF5C}tool_calls>"
                    }
                }]
            })
            .to_string()
            .into_bytes(),
        ),
    };
    let failure = execute_committed_follow_up_round(
        &manifest,
        &second_transport,
        &sink,
        &projection,
        "req-committed-json-hook-failure",
    )
    .await
    .expect("a committed hook failure must end through its typed provider failure");

    assert_eq!(
        second_transport
            .provider_ids
            .lock()
            .expect("provider ids")
            .len(),
        1,
        "the JSON hook failure must not retry or select another candidate"
    );
    assert!(
        failure.error_chain.is_some(),
        "the typed response hook failure must remain observable"
    );

    let mut frames = Vec::new();
    while let Ok(frame) = receiver.try_recv() {
        frames.push(String::from_utf8_lossy(&frame).to_string());
    }
    let payloads = sse_payloads(&frames);
    assert_eq!(
        payloads
            .iter()
            .filter(
                |payload| payload.get("type").and_then(serde_json::Value::as_str)
                    == Some("response.created")
            )
            .count(),
        1,
        "the cross-round failure must not append a second response head: {frames:?}"
    );
    assert!(
        !payloads.iter().any(|payload| {
            payload.get("type").and_then(serde_json::Value::as_str) == Some("response.completed")
        }),
        "the failed follow-up round must not fabricate a completed terminal: {frames:?}"
    );
}

#[tokio::test]
async fn committed_relay_sse_round_then_json_refill_keeps_terminal_business_items_once() {
    std::env::set_var("COMMITTED_FIRST_KEY", "first-secret");
    std::env::set_var("COMMITTED_SECOND_KEY", "second-secret");
    let manifest = committed_hook_failure_manifest();
    let first_transport = CommittedRoundTransport {
        provider_ids: Mutex::new(Vec::new()),
        reply: CommittedRoundReply::SseFirst,
    };
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let projection: super::relay_client_frames::V3RelayClientProjectionHandle =
        std::sync::Arc::new(std::sync::Mutex::new(None));

    let first_output =
        execute_committed_first_round(&manifest, &first_transport, &sink, &projection).await;
    let accumulated_items = collect_v3_chat_process_business_output_items(
        first_output
            .finalized_response
            .as_ref()
            .expect("first round finalized response"),
    );
    {
        let mut slot = projection.lock().expect("projection handle");
        slot.as_mut()
            .expect("committed projection")
            .close_round()
            .expect("close the committed round");
    }

    let second_transport = CommittedRoundTransport {
        provider_ids: Mutex::new(Vec::new()),
        reply: CommittedRoundReply::Json(
            json!({
                "id": "chatcmpl_committed_json_refill",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "second"}
                }]
            })
            .to_string()
            .into_bytes(),
        ),
    };
    let second_output = execute_committed_follow_up_round(
        &manifest,
        &second_transport,
        &sink,
        &projection,
        "req-committed-json-refill",
    )
    .await
    .expect("the JSON refill round must complete");
    let mut merged = second_output
        .finalized_response
        .clone()
        .expect("second round finalized response");
    merge_v3_chat_process_refill_output_items(&mut merged, &accumulated_items);

    let mut frames = Vec::new();
    while let Ok(frame) = receiver.try_recv() {
        frames.push(String::from_utf8_lossy(&frame).to_string());
    }
    let mut sealed = {
        let mut slot = projection.lock().expect("projection handle");
        slot.take()
            .expect("committed projection")
            .finish(&merged, accumulated_items.len())
            .expect("seal the merged cross-round response")
    };
    use futures_util::StreamExt;
    while let Some(frame) = sealed.next().await {
        frames.push(String::from_utf8_lossy(&frame).to_string());
    }

    let terminal = sse_payloads(&frames)
        .into_iter()
        .find(|payload| {
            payload.get("type").and_then(serde_json::Value::as_str) == Some("response.completed")
        })
        .expect("merged response terminal");
    let terminal_items = terminal
        .pointer("/response/output")
        .and_then(serde_json::Value::as_array)
        .expect("terminal output");
    let mut texts = Vec::new();
    for item in terminal_items {
        if let Some(content) = item.get("content").and_then(serde_json::Value::as_array) {
            for part in content {
                if part.get("type").and_then(serde_json::Value::as_str) == Some("output_text") {
                    texts.push(
                        part.get("text")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default(),
                    );
                }
            }
        }
    }
    assert_eq!(
        texts,
        vec!["first", "second"],
        "the terminal must keep each round's business text exactly once: {terminal}"
    );
    assert_eq!(
        second_transport
            .provider_ids
            .lock()
            .expect("provider ids")
            .len(),
        1,
        "the successful refill round must use one provider attempt"
    );
}
