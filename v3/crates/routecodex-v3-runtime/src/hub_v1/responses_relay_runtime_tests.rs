use super::*;
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::build_v3_transport_13_responses_http_request_from_parts;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

struct RelayOnlyFailureTransport {
    sends: AtomicUsize,
}

#[async_trait::async_trait]
impl ResponsesTransport for RelayOnlyFailureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        assert_eq!(request.provider_id(), "relay_first");
        self.sends.fetch_add(1, Ordering::SeqCst);
        Err(V3ProviderError::Transport {
            request_id: request.request_id().to_string(),
            provider_id: request.provider_id().to_string(),
            reason: "relay target failed before direct target".to_string(),
        })
    }
}

fn relay_to_direct_reselection_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
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
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[providers.relay_first]
type = "openai_chat"
base_url = "http://relay.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "RELAY_FIRST_KEY" }] }
[providers.relay_first.models.test]
wire_name = "wire-relay-first"

[providers.direct_second]
type = "responses"
base_url = "http://direct.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "DIRECT_SECOND_KEY" }] }
[providers.direct_second.models.test]
wire_name = "wire-direct-second"

[forwarders.mixed]
model = "client-model"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "relay_first", model = "test", key = "key", priority = 1 },
  { kind = "provider_model", provider = "direct_second", model = "test", key = "key", priority = 2 }
]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "mixed", priority = 1 }]
"#,
        )
        .expect("relay-to-direct authoring");
    compile_v3_config_05_manifest(authoring).expect("relay-to-direct manifest")
}

fn anthropic_then_openai_chat_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

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
async fn target_protocol_unmapped_field_skips_invalid_wire_and_switches_provider() {
    std::env::set_var("ANTHROPIC_FIRST_KEY", "anthropic-secret");
    std::env::set_var("OPENAI_SECOND_KEY", "openai-secret");
    let manifest = anthropic_then_openai_chat_manifest();
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
        None,
        None,
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        V3ResponsesRelayRetryPolicy::default(),
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        None,
    )
    .await
    .expect("unmapped target field must skip the incompatible candidate and continue");

    assert_eq!(output.status, 200);
    assert!(
        output
            .node_trace
            .iter()
            .any(|node| *node == "V3TargetLocalReselected"),
        "target protocol projection failure must enter the typed provider-switch path"
    );
    assert_eq!(
        transport
            .provider_ids
            .lock()
            .expect("provider ids")
            .as_slice(),
        ["openai_second"],
        "the incompatible Anthropic candidate must receive no wire request"
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

#[tokio::test]
async fn relay_reselect_can_handoff_to_direct_target_after_provider_failure() {
    std::env::set_var("RELAY_FIRST_KEY", "relay-secret");
    std::env::set_var("DIRECT_SECOND_KEY", "direct-secret");
    let manifest = relay_to_direct_reselection_manifest();
    let session_scope =
        V3ProviderFailureSessionScope::new("test", "default", "relay-direct-session")
            .expect("session scope");
    let transport = RelayOnlyFailureTransport {
        sends: AtomicUsize::new(0),
    };
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        execute_v3_responses_relay_runtime_inner(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: "test".to_string(),
                failure_session_scope: session_scope,
                request_id: "req-relay-direct".to_string(),
                payload: json!({"model":"client-model","input":"hello"}),
            },
            &transport,
            None,
            None,
            V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
            V3ResponsesRelayRetryPolicy::default(),
            None,
            None,
            None,
            None,
            BTreeSet::new(),
            None,
        ),
    )
    .await
    .expect("relay failure handoff must not wait for normal cooldown")
    .expect("relay failure should hand off to Direct target");

    assert_eq!(transport.sends.load(Ordering::SeqCst), 1);
    let handoff = output
        .protocol_direct_handoff
        .expect("same-protocol reselected target must hand off to Direct");
    assert_eq!(
        handoff.plan.decision.mode,
        V3Execution11ProtocolDecisionMode::SameProtocolDirect
    );
    assert_eq!(
        handoff.plan.decision.target.candidate.provider_id,
        "direct_second"
    );
    assert_eq!(
        handoff.observability_accumulator.attempts(),
        1,
        "Relay-to-Direct handoff must carry the completed provider attempt",
    );
    assert!(handoff
        .plan
        .request_local_excluded_candidates
        .contains("relay_first:key:test"));
    assert!(handoff.node_trace.contains(&"V3TargetLocalReselected"));
    assert!(handoff.provider_failure_events.len() == 1);
    assert!(
            handoff.request_payload.get("input").is_some(),
            "Direct handoff must carry the ReqChatProcess result projected by the adjacent Responses outbound codec"
        );
    assert!(
        handoff.request_payload.get("messages").is_none(),
        "Chat canonical fields must not cross the typed Direct handoff"
    );
}

#[test]
fn relay_local_tool_output_cannot_enter_fresh_protocol_switch() {
    let payload = json!({
        "model": "client-model",
        "input": [{
            "type": "function_call_output",
            "call_id": "call_relay_owned",
            "output": "done"
        }]
    });
    let ids = find_responses_tool_output_ids(&payload).expect("tool output ids");

    assert!(!ids.restore_ids.is_empty());
    assert!(
        !responses_relay_protocol_switch_allowed(&payload, &ids),
        "Relay-owned local continuation must remain in Relay after ReqChatProcess restore"
    );
}

#[test]
fn relay_local_tool_output_consumes_previous_response_and_call_id_aliases() {
    let payload = json!({
        "previous_response_id": "resp_relay_owned",
        "input": [{
            "type": "function_call_output",
            "call_id": "call_relay_owned",
            "output": "done"
        }]
    });
    let ids = find_responses_tool_output_ids(&payload).expect("tool output ids");

    assert_eq!(ids.restore_ids, vec!["call_relay_owned"]);
    assert_eq!(
        ids.consumed_ids,
        vec!["resp_relay_owned", "call_relay_owned"]
    );
}

#[test]
fn provider_response_failure_classifier_keeps_provider_and_local_hook_errors_separate() {
    let malformed_tool =
        V3ResponsesRelayRuntimeError::Response(V3HubRelayResponseError::MalformedToolCall {
            index: 5,
            reason: "duplicate call_id/id",
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
            .contains("duplicate call_id/id"),
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
    assert!(!is_v3_responses_provider_response_failure(
        &V3ResponsesRelayRuntimeError::Response(
            V3HubRelayResponseError::StoplessProjectionFailed {
                reason: "missing local transition context",
            }
        )
    ));
}

#[test]
fn anthropic_provider_signature_delta_without_string_fails_explicitly() {
    let mut state = V3AnthropicProviderStreamState::default();
    collect_v3_anthropic_provider_stream_event(
        json!({
            "type":"message_start",
            "message":{
                "id":"msg_signature",
                "type":"message",
                "role":"assistant",
                "content":[],
                "usage":{"input_tokens":1}
            }
        }),
        &mut state,
    )
    .expect("message_start");
    collect_v3_anthropic_provider_stream_event(
        json!({
            "type":"content_block_start",
            "index":0,
            "content_block":{"type":"thinking","thinking":""}
        }),
        &mut state,
    )
    .expect("thinking start");

    let error = collect_v3_anthropic_provider_stream_event(
        json!({
            "type":"content_block_delta",
            "index":0,
            "delta":{"type":"signature_delta","signature":null}
        }),
        &mut state,
    )
    .expect_err("malformed signature_delta must not disappear");

    assert!(error
        .to_string()
        .contains("Anthropic codec malformed reasoning content"));
}

fn glmrelay_error_policy_manifest() -> V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(
                r#"
version = 3

[[error.provider_error_action_policy]]
policy_id = "glmrelay_openai_200_diagnostic_zero_usage"
[error.provider_error_action_policy.scope]
provider_id = "glmrelay_openai"
provider_type = "openai_chat"
[error.provider_error_action_policy.match]
http_status = 200
[error.provider_error_action_policy.match.sse]
finish_reason = "stop"
usage_total_tokens = 0
content_contains_any = ["mac超负荷运载，应该是挂了"]
[error.provider_error_action_policy.action]
kind = "periodic_recovery"
reason_code = "provider_diagnostic_zero_usage"
retry_mode = "reselect_before_client_projection"
cooldown_ms = 300000
disable_scope = "provider_model"

[servers.s]
bind = "127.0.0.1"
port = 5555
routing_group = "g"
endpoints = ["responses"]

[providers.glmrelay_openai]
type = "openai_chat"
base_url = "https://glm-relayapi.top/v1"
default_model = "glm-5.2"
auth = { type = "api_key", entries = [{ alias = "key1", env = "GLM_TEST_KEY" }] }

[providers.glmrelay_openai.models."glm-5.2"]
capabilities = ["text", "reasoning", "tools"]

[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "glmrelay_openai", model = "glm-5.2", key = "key1", priority = 1 }]
"#,
            )
            .expect("config authoring"),
        )
        .expect("manifest")
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
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

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
async fn responses_relay_unknown_direct_provider_model_projects_404() {
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
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

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

    assert_eq!(output.status, 404);
    assert!(
        output
            .node_trace
            .iter()
            .any(|node| *node == "V3Error06ClientProjected"),
        "404 must project through the Error chain: {:?}",
        output.node_trace
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
                "type":"function",
                "function":{
                    "name":"tool_search",
                    "parameters":{"type":"object"}
                }
            }]
        }),
    )
    .expect("OpenAI Chat function tool_search must project back to Responses tool_search_call");

    assert_eq!(response["status"], "requires_action");
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

    assert_eq!(response["status"], "requires_action");
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
    assert_eq!(summary.cached_tokens, Some(41_984));
}

#[test]
fn openai_chat_zero_output_upstream_diagnostic_is_provider_error() {
    let error = build_v3_responses_provider_response_from_openai_chat_payload(
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
    .expect_err("zero-output upstream diagnostic must be provider failure, not success");

    assert!(
        error
            .to_string()
            .contains("zero-output upstream diagnostic"),
        "wrong error: {error}"
    );
}

#[tokio::test]
async fn openai_chat_zero_output_stream_diagnostic_is_provider_error() {
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

    let error = build_v3_responses_provider_response_from_openai_chat_payload(
        &provider_payload,
        &json!({
            "tools": [{"type":"function","function":{"name":"exec_command"}}]
        }),
    )
    .expect_err("stream zero-output upstream diagnostic must not enter stopless");

    assert!(
        error
            .to_string()
            .contains("zero-output upstream diagnostic"),
        "wrong error: {error}"
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
fn openai_chat_upstream_overload_diagnostic_is_provider_error() {
    let manifest = glmrelay_error_policy_manifest();
    let error = build_v3_responses_provider_response_from_openai_chat_payload_with_manifest(
        &json!({
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
        }),
        &json!({"tools": [{"type":"function","function":{"name":"exec_command"}}]}),
        Some(&manifest),
        Some("glmrelay_openai"),
    )
    .expect_err("upstream overload diagnostic must be provider failure, not success content");

    assert!(
        error.to_string().contains("provider_diagnostic_zero_usage"),
        "wrong error: {error}"
    );
}

#[tokio::test]
async fn openai_chat_stream_overload_diagnostic_policy_is_provider_error() {
    let manifest = glmrelay_error_policy_manifest();
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

    let error = build_v3_responses_provider_response_from_openai_chat_payload_with_manifest(
        &provider_payload,
        &json!({"tools": [{"type":"function","function":{"name":"exec_command"}}]}),
        Some(&manifest),
        Some("glmrelay_openai"),
    )
    .expect_err("configured stream diagnostic must not enter stopless");

    assert!(
        error.to_string().contains("provider_diagnostic_zero_usage"),
        "wrong error: {error}"
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

    assert_eq!(response["status"], "requires_action");
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

    assert_eq!(response["status"], "requires_action");
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
                            "arguments": "{\"patch\":\"*** Begin Patch\\n*** End Patch\"}"
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

    assert_eq!(response["status"], "requires_action");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["name"], "apply_patch");
    assert_eq!(
        response["output"][0]["input"],
        "{\"patch\":\"*** Begin Patch\\n*** End Patch\"}"
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
