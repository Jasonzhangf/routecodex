use super::*;
use routecodex_v3_config::{
    V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3RouteTargetKind,
};
use routecodex_v3_provider_responses::{V3ProviderHttpFailure, V3ProviderResponseHeader};
use routecodex_v3_target::{V3Target10ConcreteProviderSelected, V3TargetCandidate};
use routecodex_v3_virtual_router::V3Router07OpaqueTargetHitOnce;
use serde_json::json;
use std::collections::BTreeSet;

fn request_key_notify(_view: &V3DirectRequestKeyView) {}

fn direct_system_wire_mount(
    _view: &V3DirectRequestKeyView,
    edits: &mut V3DirectRequestKeyEdits,
) -> Result<(), String> {
    edits.system_append = Some("direct system hook".to_owned());
    Ok(())
}

fn direct_tools_wire_mount(
    _view: &V3DirectRequestKeyView,
    edits: &mut V3DirectRequestKeyEdits,
) -> Result<(), String> {
    edits.tool_description_append = Some("direct tools hook".to_owned());
    Ok(())
}

fn direct_developer_wire_mount(
    _view: &V3DirectRequestKeyView,
    edits: &mut V3DirectRequestKeyEdits,
) -> Result<(), String> {
    edits.developer_append = Some("direct developer hook".to_owned());
    Ok(())
}

fn direct_policy_with_models(
    client_model: &str,
    canonical_model: &str,
    wire_model: &str,
) -> V3ResponsesDirect11Policy {
    V3ResponsesDirect11Policy {
        target: V3Target10ConcreteProviderSelected {
            route: V3Router07OpaqueTargetHitOnce {
                server_id: "direct-model-binding".to_string(),
                routing_group_id: "direct-model-binding".to_string(),
                pool_id: "default".to_string(),
                route_classification_reason: "direct:model-binding".to_string(),
                target_index: 0,
                target_kind: V3RouteTargetKind::ProviderModel,
                target_id: None,
                target_plan: Vec::new(),
                request_client_model: Some(client_model.to_string()),
                request_capabilities: BTreeSet::from(["text".to_string()]),
                request_input_tokens: 1,
                hit_count: 1,
            },
            candidate: V3TargetCandidate {
                provider_id: "selected-provider".to_string(),
                provider_type: "responses".to_string(),
                auth_alias: "primary".to_string(),
                model_id: canonical_model.to_string(),
                wire_model: wire_model.to_string(),
                visible_model_ids: vec![client_model.to_string()],
                model_capabilities: vec!["text".to_string()],
                web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode::None,
                max_context_tokens: None,
                context_token_estimate_scale_bps: 10_000,
                base_url: "https://provider.invalid/v1".to_string(),
                responses_process: None,
                responses_transport: V3ResponsesTransportKind::Http,
                websocket_v2_url: None,
                provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
                request_timeout_ms: 300_000,
                priority: 0,
                weight: 1,
                sse_first_frame_timeout_ms: None,
                initial_concurrency_budget: 8,
                compatibility_profile: None,
                env_name: Some("TEST_KEY".to_string()),
                token_file: None,
                secret_file: None,
                secret_key: None,
                api_key: None,
                required_capabilities: Vec::new(),
                pool_ids: vec!["default".to_string()],
                default_pool_member: true,
                path: vec!["selected-provider".to_string()],
            },
            unavailable_candidates: Vec::new(),
            attempts: 1,
            default_floor_protected: false,
        },
        request_id: "req-direct-model-binding".to_string(),
        request_body: json!({"model": client_model, "input": "hello"}),
    }
}

#[test]
fn responses_direct_static_hooks_are_registered() {
    let registry = register_responses_direct_hooks();
    for hook in [
        "ResponsesDirectRouteHook",
        "ResponsesDirectRequestProjectionHook",
        "ResponsesDirectProviderTransportHook",
        "ResponsesDirectResponseProjectionHook",
        "ResponsesDirectErrorHook",
    ] {
        assert!(registry.require_hook(hook), "{hook}");
    }
}

#[test]
fn direct_request_projection_binds_selected_wire_model_before_provider_wire() {
    let registry = register_responses_direct_hooks();
    let policy = direct_policy_with_models(
        "client-route-alias",
        "canonical-provider-model",
        "provider-wire-model",
    );

    let wire = registry
        .run_request_projection(&policy)
        .expect("route-selected direct model must bind before Provider12");

    assert_eq!(wire.body()["model"], "provider-wire-model");
    assert_ne!(wire.body()["model"], "client-route-alias");
}

#[test]
fn direct_responses_projection_normalizes_non_assistant_text_parts() {
    let mut policy = direct_policy_with_models(
        "client-route-alias",
        "canonical-provider-model",
        "provider-wire-model",
    );
    policy.request_body = json!({
        "model": "client-route-alias",
        "input": [{
            "type": "message",
            "role": "system",
            "content": [{"type": "text", "text": "system guidance"}]
        }]
    });

    let wire = responses_direct_request_projection_hook(&policy)
        .expect("Direct Responses projection must normalize provider content types");
    assert_eq!(wire.body()["input"][0]["content"][0]["type"], "input_text");
}

#[test]
fn direct_hook_registry_mounts_request_key_catalog_at_runtime() {
    let mut policy = direct_policy_with_models(
        "client-route-alias",
        "canonical-provider-model",
        "provider-wire-model",
    );
    policy.request_body = json!({
        "model":"client-route-alias",
        "instructions":"base system",
        "input":"hello",
        "tools":[]
    });
    let catalog = V3DirectRequestKeyHookCatalog::new(
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::System,
            notify: request_key_notify,
            rewrite: direct_system_wire_mount,
        },
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::Developer,
            notify: request_key_notify,
            rewrite: |_, _| Ok(()),
        },
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::Tools,
            notify: request_key_notify,
            rewrite: |_, _| Ok(()),
        },
    );
    let registry = register_responses_direct_hooks_with_key_catalog(&catalog);
    let wire = registry
        .run_request_projection(&policy)
        .expect("registered request key catalog must be consumed by Direct");
    assert!(wire.body()["instructions"]
        .as_str()
        .unwrap()
        .contains("direct system hook"));
    assert_eq!(wire.body()["model"], "provider-wire-model");
    assert!(wire.body().get("metadata").is_none());
}

#[test]
fn direct_request_key_catalog_effect_reaches_responses_provider_wire_body() {
    let mut policy = direct_policy_with_models(
        "client-route-alias",
        "canonical-provider-model",
        "provider-wire-model",
    );
    policy.request_body = json!({
        "model":"client-route-alias",
        "instructions":"base system",
        "input":"hello",
        "tools":[{"type":"function","name":"lookup","description":"base tool","parameters":{"type":"object"}}]
    });
    let catalog = V3DirectRequestKeyHookCatalog::new(
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::System,
            notify: request_key_notify,
            rewrite: direct_system_wire_mount,
        },
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::Developer,
            notify: request_key_notify,
            rewrite: |_, _| Ok(()),
        },
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::Tools,
            notify: request_key_notify,
            rewrite: direct_tools_wire_mount,
        },
    );
    let wire = responses_direct_request_projection_hook_with_key_catalog(&policy, &catalog)
        .expect("typed Direct request key catalog must project to provider wire");
    assert!(wire.body()["instructions"]
        .as_str()
        .unwrap()
        .contains("direct system hook"));
    assert!(wire.body()["tools"][0]["description"]
        .as_str()
        .unwrap()
        .contains("direct tools hook"));
    assert_eq!(wire.body()["model"], "provider-wire-model");
    assert!(wire.body().get("metadata").is_none());
}

#[test]
fn direct_responses_projection_applies_selected_target_image_session_compat() {
    let mut policy = direct_policy_with_models(
        "client-route-alias",
        "canonical-provider-model",
        "provider-wire-model",
    );
    policy.request_body = json!({
        "model": "client-route-alias",
        "input": [{
            "type": "input_image",
            "image_url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        }]
    });
    let catalog = default_v3_direct_request_key_hook_catalog();
    let wire = responses_direct_request_projection_hook_with_key_catalog(&policy, &catalog)
        .expect("Direct request projection must use the selected target compat owner");
    assert_eq!(
        wire.body()["input"][0],
        json!({"type": "input_text", "text": "[Image]"})
    );
}

#[test]
fn direct_request_key_catalog_effect_reaches_chat_provider_wire_body() {
    let base = direct_policy_with_models(
        "client-route-alias",
        "canonical-provider-model",
        "provider-wire-model",
    );
    let policy = V3ChatDirect11Policy {
        target: base.target,
        request_id: base.request_id,
        request_body: json!({
            "model":"client-route-alias",
            "messages":[
                {"role":"system","content":"base system"},
                {"role":"developer","content":"base developer"},
                {"role":"user","content":"hello"}
            ],
            "tools":[{"type":"function","function":{"name":"lookup","description":"base tool","parameters":{"type":"object"}}}]
        }),
    };
    let catalog = V3DirectRequestKeyHookCatalog::new(
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::System,
            notify: request_key_notify,
            rewrite: direct_system_wire_mount,
        },
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::Developer,
            notify: request_key_notify,
            rewrite: direct_developer_wire_mount,
        },
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::Tools,
            notify: request_key_notify,
            rewrite: direct_tools_wire_mount,
        },
    );
    let wire = chat_direct_request_projection_hook_with_key_catalog(&policy, &catalog)
        .expect("typed Direct Chat request key catalog must project to provider wire");
    let messages = wire.body()["messages"].as_array().unwrap();
    assert!(messages.iter().any(|message| {
        message["role"] == "system"
            && message["content"]
                .as_str()
                .is_some_and(|content| content.contains("direct system hook"))
    }));
    assert!(messages.iter().any(|message| {
        message["role"] == "developer"
            && message["content"]
                .as_str()
                .is_some_and(|content| content.contains("direct developer hook"))
    }));
    assert!(wire.body()["tools"][0]["function"]["description"]
        .as_str()
        .unwrap()
        .contains("direct tools hook"));
    assert_eq!(wire.body()["model"], "provider-wire-model");
    assert!(wire.body().get("metadata").is_none());
}

#[test]
fn chat_direct_codec_consumes_the_registered_key_catalog() {
    let base = direct_policy_with_models(
        "client-route-alias",
        "canonical-provider-model",
        "provider-wire-model",
    );
    let policy = V3ChatDirect11Policy {
        target: base.target,
        request_id: base.request_id,
        request_body: json!({
            "model":"client-route-alias",
            "messages":[{"role":"system","content":"base system"}],
            "tools":[]
        }),
    };
    let catalog = V3DirectRequestKeyHookCatalog::new(
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::System,
            notify: request_key_notify,
            rewrite: direct_system_wire_mount,
        },
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::Developer,
            notify: request_key_notify,
            rewrite: |_, _| Ok(()),
        },
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::Tools,
            notify: request_key_notify,
            rewrite: |_, _| Ok(()),
        },
    );
    let wire = <crate::kernel::V3ChatDirectCodec as crate::kernel::V3DirectProtocolCodec>::run_request_projection(
            &policy,
            &catalog,
        )
        .expect("Chat codec must consume the adjacent typed key catalog");
    assert!(wire.body()["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("direct system hook"));
    assert_eq!(wire.body()["model"], "provider-wire-model");
}

#[test]
fn responses_direct_openai_chat_target_uses_chat_transport_contract() {
    let registry = register_responses_direct_hooks();
    let mut policy = direct_policy_with_models(
        "client-route-alias",
        "deepseek-v4-flash",
        "deepseek-v4-flash",
    );
    policy.target.candidate.provider_type = "openai_chat".to_string();
    policy.request_body = json!({
        "model": "client-route-alias",
        "input": "hello",
        "reasoning": {"effort": "high"},
        "tools": [
            {"type": "function", "name": "reasoningStop"},
            {"type": "namespace", "name": "multi_agent_v1", "tools": [
                {"type": "function", "name": "spawn_agent", "parameters": {"type": "object"}}
            ]}
        ],
        "tool_choice": "required"
    });

    let wire = registry
        .run_request_projection(&policy)
        .expect("direct OpenAI Chat target must build provider wire");
    assert!(wire.body().get("input").is_none());
    assert_eq!(wire.body()["messages"][0]["role"], "user");
    assert_eq!(wire.body()["messages"][0]["content"], "hello");
    assert!(
        wire.body().get("tool_choice").is_none(),
        "direct DeepSeek thinking wire must apply ProviderReqCompat06: {}",
        wire.body()
    );
    assert_eq!(wire.body()["tools"][1]["type"], "function");
    assert_eq!(wire.body()["tools"][1]["function"]["name"], "spawn_agent");
    let transport = registry
        .run_provider_transport(wire)
        .expect("direct OpenAI Chat target must use Chat transport");
    assert!(transport.url().ends_with("/chat/completions"));
}

#[test]
fn responses_direct_responses_target_applies_deepseek_thinking_compat() {
    let registry = register_responses_direct_hooks();
    let mut policy = direct_policy_with_models(
        "client-route-alias",
        "deepseek-v4-flash",
        "deepseek-v4-flash",
    );
    policy.request_body = json!({
        "model": "client-route-alias",
        "input": "hello",
        "reasoning": {"effort": "high"},
        "tools": [{"type": "function", "name": "reasoningStop"}],
        "tool_choice": "required"
    });

    let wire = registry
        .run_request_projection(&policy)
        .expect("direct Responses target must build provider wire");
    assert!(
        wire.body().get("tool_choice").is_none(),
        "direct Responses DeepSeek thinking wire must apply ProviderReqCompat06: {}",
        wire.body()
    );
}

#[test]
fn provider_model_binding_mismatch_is_internal_not_provider_failure() {
    let source = provider_error_source("V3Provider12ResponsesWirePayload")(
        V3ProviderError::ProviderModelBindingMismatch {
            request_id: "req-model-mismatch".to_string(),
            provider_id: "selected-provider".to_string(),
            expected_model: "provider-wire-model".to_string(),
            actual_model: Some("client-route-alias".to_string()),
        },
    );

    assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
    assert_eq!(source.code, "provider_model_binding_mismatch");
    assert!(source.external_error.is_none());
    let internal = source.internal_error.expect("internal contract identity");
    assert_eq!(internal.internal_code, "500-150");
    assert_eq!(internal.node_id, "V3Provider12ResponsesWirePayload");
}

#[tokio::test]
async fn malformed_json_response_is_explicit_error() {
    let registry = register_responses_direct_hooks();
    let result = registry
        .run_response_projection_with_context(
            V3ProviderResp14Raw::from_json(
                "req",
                "test",
                200,
                vec![routecodex_v3_provider_responses::V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                b"not-json".to_vec(),
            ),
            V3DirectResponseCompatContext {
                provider_protocol: crate::hub_v1::V3HubProviderWireProtocol::Responses,
                canonical_model_id: "test-model".to_string(),
                model_capabilities: vec!["text".to_string()],
                compatibility_profile: None,
                tool_thinking_enabled: false,
                toolreason_client_projection: true,
                toolreason_observation_session_id: Some("session-test".to_string()),
                tool_thinking_turn_context: crate::hub_v1::V3ToolThinkingTurnContext::disabled(),
                runtime_timing: crate::runtime_timing::V3RuntimeTimingState::start(),
            },
        )
        .await;
    let source = result.expect_err("malformed provider JSON must be an explicit error");
    assert_eq!(source.source_kind, V3ErrorSourceKind::ProviderFailure);
    assert!(source.internal_error.is_none());
    let external = source
        .external_error
        .expect("malformed provider JSON is external provider identity");
    assert_eq!(external.provider_id.as_deref(), Some("test"));
    assert_eq!(
        external.code.as_deref(),
        Some("PROVIDER_RESPONSE_JSON_INVALID")
    );
}

#[test]
fn provider_http_status_source_is_external_provider_identity_without_internal_code() {
    let source =
        provider_error_source("V3Transport13ResponsesHttpRequest")(V3ProviderError::HttpStatus {
            response: Box::new(V3ProviderHttpFailure {
                request_id: "req".to_string(),
                provider_id: "asxs-grok".to_string(),
                status: 429,
                headers: vec![V3ProviderResponseHeader {
                    name: "x-request-id".to_string(),
                    value: b"upstream-req".to_vec(),
                }],
                body: b"{\"error\":{\"code\":\"rate_limit\"}}".to_vec(),
                body_read_failure: None,
            }),
        });

    assert_eq!(source.source_kind, V3ErrorSourceKind::ProviderFailure);
    assert!(source.internal_error.is_none());
    let external = source.external_error.expect("external provider link");
    assert_eq!(external.status, Some(429));
    assert_eq!(external.provider_id.as_deref(), Some("asxs-grok"));
    assert_eq!(external.code.as_deref(), Some("HTTP_429"));
}

#[test]
fn provider_transport_source_is_external_transport_identity_without_internal_code() {
    let source =
        provider_error_source("V3Transport13ResponsesHttpRequest")(V3ProviderError::Transport {
            request_id: "req".to_string(),
            provider_id: "asxs-grok".to_string(),
            reason: "error sending request for url".to_string(),
        });

    assert_eq!(source.source_kind, V3ErrorSourceKind::ProviderFailure);
    assert!(source.internal_error.is_none());
    let external = source.external_error.expect("external transport link");
    assert_eq!(external.kind, V3ExternalErrorKind::Transport);
    assert_eq!(external.status, None);
    assert_eq!(external.provider_id.as_deref(), Some("asxs-grok"));
    assert_eq!(external.code.as_deref(), Some("TRANSPORT_ERROR"));
}

#[test]
fn provider_local_auth_secret_failure_is_internal_runtime_identity() {
    let source = provider_error_source("V3Transport13ResponsesHttpRequest")(
        V3ProviderError::MissingAuthSecret {
            request_id: "req".to_string(),
            provider_id: "cc".to_string(),
            auth_alias: "key1".to_string(),
        },
    );

    assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
    assert!(source.external_error.is_none());
    let internal = source.internal_error.expect("internal auth/runtime code");
    assert_eq!(internal.internal_code, "500-160");
    assert_eq!(internal.node_id, "V3Transport13ResponsesHttpRequest");
}

#[test]
fn malformed_current_image_source_is_client_input_without_internal_or_external_identity() {
    let source = provider_error_source("V3Provider12ResponsesWirePayload")(
        V3ProviderError::InvalidDataImage {
            request_id: "req".to_string(),
            media_type: "image/png".to_string(),
            reason: "base64 decode failed".to_string(),
        },
    );

    assert_eq!(source.source_kind, V3ErrorSourceKind::InvalidRequest);
    assert_eq!(source.code, "invalid_provider_request_payload");
    assert!(source.internal_error.is_none());
    assert!(source.external_error.is_none());
}

#[test]
fn control_field_leak_source_is_internal_wire_boundary_violation() {
    let source = provider_error_source("V3Provider12ResponsesWirePayload")(
        V3ProviderError::ControlFieldInWireBody {
            request_id: "req".to_string(),
            field: "metadata",
        },
    );

    assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
    assert!(source.external_error.is_none());
    let internal = source.internal_error.expect("internal wire boundary code");
    assert_eq!(internal.internal_code, "500-150");
    assert_eq!(internal.node_id, "V3Provider12ResponsesWirePayload");
}
