use crate::direct_response_hooks::V3DirectResponseCompatContext;
use crate::hub_v1::V3AnthropicRelayClientHeader;
use crate::kernel::direct_request_key_hooks::{
    apply_v3_direct_request_key_hook, V3DirectRequestKeyHookCatalog, V3DirectRequestProtocol,
};
use crate::kernel::V3DirectProtocolCodec;
use crate::nodes::V3Server03HttpRequestRaw;
use crate::operation_runner::V3Err01SourceInput;
use crate::provider_failure_runtime_policy::raise_v3_source_via_err01;
use routecodex_v3_error::{V3ErrorSourceKind, V3InternalErrorCode};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    v3_provider_auth_secret_handle_from_declaration_fields, V3Provider12ResponsesWirePayload,
    V3ProviderAuthHandle, V3ProviderResp14Raw, V3ResponsesProviderTarget,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_target::V3Target10ConcreteProviderSelected;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq)]
pub struct V3Req04StandardizedAnthropic {
    pub body: Value,
    pub server_id: String,
    pub port: Option<u16>,
    pub pipeline_id: Option<String>,
    pub failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope,
    pub request_id: String,
    pub execution_id: String,
    pub endpoint: String,
    pub method: String,
    pub request_purpose: crate::nodes::V3RequestPurpose,
    pub tool_thinking_turn_context: crate::hub_v1::V3ToolThinkingTurnContext,
    pub client_headers: Vec<V3AnthropicRelayClientHeader>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3AnthropicDirect11Policy {
    pub target: V3Target10ConcreteProviderSelected,
    pub request_id: String,
    pub request_body: Value,
    pub client_headers: Vec<V3AnthropicRelayClientHeader>,
}

pub struct V3AnthropicDirectCodec;

impl V3DirectProtocolCodec for V3AnthropicDirectCodec {
    type Standardized = V3Req04StandardizedAnthropic;
    type Policy = V3AnthropicDirect11Policy;
    type Control = Vec<V3AnthropicRelayClientHeader>;

    const ENTRY_PROTOCOL: &'static str = "anthropic";
    const HUB_ENTRY_PROTOCOL: crate::hub_v1::V3HubEntryProtocol =
        crate::hub_v1::V3HubEntryProtocol::Anthropic;
    const STANDARDIZED_STAGE: &'static str = "V3Req04StandardizedAnthropic";
    const POLICY_STAGE: &'static str = "V3AnthropicDirect11Policy";

    fn build_standardized(raw: V3Server03HttpRequestRaw) -> Result<Self::Standardized, String> {
        let body = raw.body;
        if body.get("messages").and_then(Value::as_array).is_none() {
            return Err("Anthropic request payload must contain a messages array".to_string());
        }
        Ok(V3Req04StandardizedAnthropic {
            body,
            server_id: raw.server_id,
            port: raw.port,
            pipeline_id: raw.pipeline_id,
            failure_session_scope: raw.failure_session_scope,
            request_id: raw.request_id,
            execution_id: raw.execution_id,
            endpoint: raw.path,
            method: raw.method,
            request_purpose: raw.request_purpose,
            tool_thinking_turn_context: crate::hub_v1::V3ToolThinkingTurnContext::disabled(),
            client_headers: Vec::new(),
        })
    }

    fn server_id(standardized: &Self::Standardized) -> &str {
        &standardized.server_id
    }

    fn endpoint(standardized: &Self::Standardized) -> &str {
        &standardized.endpoint
    }

    fn request_id(standardized: &Self::Standardized) -> &str {
        &standardized.request_id
    }

    fn body(standardized: &Self::Standardized) -> &Value {
        &standardized.body
    }
    fn body_mut(standardized: &mut Self::Standardized) -> &mut Value {
        &mut standardized.body
    }

    fn tool_thinking_turn_context(
        standardized: &Self::Standardized,
    ) -> &crate::hub_v1::V3ToolThinkingTurnContext {
        &standardized.tool_thinking_turn_context
    }

    fn policy_target(policy: &Self::Policy) -> &V3Target10ConcreteProviderSelected {
        &policy.target
    }

    fn run_route(
        selected: V3Target10ConcreteProviderSelected,
        standardized: &Self::Standardized,
    ) -> Self::Policy {
        V3AnthropicDirect11Policy {
            target: selected,
            request_id: standardized.request_id.clone(),
            request_body: standardized.body.clone(),
            client_headers: standardized.client_headers.clone(),
        }
    }

    fn run_request_projection(
        policy: &Self::Policy,
        request_key_catalog: &V3DirectRequestKeyHookCatalog,
        _drop_context: &crate::projection_drop_log::V3ProjectionDropContext,
    ) -> crate::shared::V3DirectSourceResult<V3Provider12ResponsesWirePayload> {
        project_anthropic_direct_request(policy, request_key_catalog)
    }

    fn run_provider_transport(
        wire: V3Provider12ResponsesWirePayload,
    ) -> crate::shared::V3DirectSourceResult<V3Transport13ResponsesHttpRequest> {
        crate::hub_v1::build_v3_provider_transport_request_for_protocol(
            crate::hub_v1::V3HubProviderWireProtocol::Anthropic,
            wire,
        )
        .map_err(|error| {
            raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Transport13ResponsesHttpRequest",
                "anthropic_provider_transport_error",
                error,
                V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
            )
            .map(|(_, source)| source)
        })
    }

    fn provider_transport_handoff_scope(
        standardized: &Self::Standardized,
    ) -> Result<routecodex_v3_provider_responses::V3ProviderTransportHandoffScope, String> {
        Ok(
            routecodex_v3_provider_responses::V3ProviderTransportHandoffScope {
                pipeline_id: standardized.pipeline_id.clone().ok_or_else(|| {
                    "provider transport handoff pipeline_id is missing".to_string()
                })?,
                server_id: standardized.server_id.clone(),
                port: standardized
                    .port
                    .ok_or_else(|| "provider transport handoff port is missing".to_string())?,
                session_scope: format!(
                    "{}:{}:{}",
                    standardized.failure_session_scope.server_id(),
                    standardized.failure_session_scope.routing_group(),
                    standardized.failure_session_scope.session_id()
                ),
                runtime_generation: standardized
                    .failure_session_scope
                    .transport_handoff_scope()
                    .map(|(_, _, generation)| generation)
                    .ok_or_else(|| {
                        "provider transport handoff runtime_generation is missing".to_string()
                    })?,
            },
        )
    }

    fn run_response_projection(
        raw: V3ProviderResp14Raw,
        context: V3DirectResponseCompatContext,
    ) -> crate::kernel::v3_direct_protocol_codec::V3DirectResponseProjectionFuture {
        let plan = match context.compile_plan() {
            Ok(plan) => plan,
            Err(error) => {
                return Box::pin(async move {
                    Err(raise_v3_source_via_err01(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3AnthropicDirectResponseProjection",
                        "anthropic_direct_response_compat_plan_failed",
                        error,
                        V3Err01SourceInput::Internal(
                            V3InternalErrorCode::V3Provider12ResponsesWirePayload,
                        ),
                    )
                    .map(|(_, source)| source))
                });
            }
        };
        let tool_thinking_enabled = context.tool_thinking_enabled;
        Box::pin(async move {
            crate::shared::project_provider_raw_to_client_payload_with_plan_and_projection(
                raw,
                &plan,
                tool_thinking_enabled,
            )
            .await
        })
    }

    fn prepare_before_send(
        control: &mut Self::Control,
        _manifest: &routecodex_v3_config::V3Config05ManifestPublished,
        _server_id: &str,
        standardized: &mut Self::Standardized,
        _request_id: &str,
        _now_epoch_ms: u64,
        _trace: &mut Vec<&'static str>,
    ) -> crate::shared::V3DirectSourceResult<bool> {
        copy_anthropic_client_headers(control, standardized);
        Ok(standardized.tool_thinking_turn_context.enabled_flag())
    }

    fn failure_session_scope(
        _control: &Self::Control,
        standardized: &Self::Standardized,
    ) -> routecodex_v3_error::V3ProviderFailureSessionScope {
        standardized.failure_session_scope.clone()
    }
}

fn copy_anthropic_client_headers(
    control: &[V3AnthropicRelayClientHeader],
    standardized: &mut V3Req04StandardizedAnthropic,
) {
    standardized.client_headers = control.to_vec();
}

fn merge_anthropic_client_headers(
    target_headers: &mut BTreeMap<String, String>,
    client_headers: &[V3AnthropicRelayClientHeader],
) {
    let provider_declared: BTreeSet<String> = target_headers
        .keys()
        .map(|name| name.to_ascii_lowercase())
        .collect();
    for header in client_headers {
        let name = header.name.trim();
        if name.is_empty() || provider_declared.contains(&name.to_ascii_lowercase()) {
            continue;
        }
        match target_headers.get_mut(name) {
            Some(value) => {
                if !value.is_empty() {
                    value.push_str(", ");
                }
                value.push_str(header.value.trim());
            }
            None => {
                target_headers.insert(name.to_string(), header.value.clone());
            }
        }
    }
}

fn project_anthropic_direct_request(
    policy: &V3AnthropicDirect11Policy,
    request_key_catalog: &V3DirectRequestKeyHookCatalog,
) -> crate::shared::V3DirectSourceResult<V3Provider12ResponsesWirePayload> {
    let candidate = &policy.target.candidate;
    let request_body = crate::selected_provider_model_binding::bind_v3_selected_provider_model(
        policy.request_body.clone(),
        candidate,
    )
    .map(crate::selected_provider_model_binding::V3SelectedProviderModelBinding::into_payload)
    .map_err(|reason| {
        raise_v3_source_via_err01(
            V3ErrorSourceKind::RuntimeFailure,
            "V3AnthropicDirect11Policy",
            "selected_provider_model_binding_failed",
            reason,
            V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
        )
        .map(|(_, source)| source)
    })?;
    let mut catalog = *request_key_catalog;
    let request_body = apply_v3_direct_request_key_hook(
        request_body,
        V3DirectRequestProtocol::Anthropic,
        &mut catalog,
    )
    .map_err(|error| {
        raise_v3_source_via_err01(
            V3ErrorSourceKind::RuntimeFailure,
            "V3DirectRequestKeyHook",
            "anthropic_direct_request_key_hook_failed",
            error,
            V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
        )
        .map(|(_, source)| source)
    })?;
    let profile = crate::hub_v1::V3ProviderCompatProfileId::from_config(
        candidate.compatibility_profile.as_deref(),
    );
    let (request_body, _) = crate::hub_v1::apply_v3_provider_req_compat_to_provider_payload(
        request_body,
        candidate,
        crate::hub_v1::V3HubProviderWireProtocol::Anthropic,
        &profile,
    )
    .map_err(|error| {
        raise_v3_source_via_err01(
            V3ErrorSourceKind::RuntimeFailure,
            "V3AnthropicDirect11Policy",
            "anthropic_direct_provider_compat_failed",
            error.to_string(),
            V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
        )
        .map(|(_, source)| source)
    })?;
    let secret = v3_provider_auth_secret_handle_from_declaration_fields(
        candidate.oauth_declaration.as_ref(),
        candidate.env_name.as_deref(),
        candidate.token_file.as_deref(),
        candidate.secret_file.as_deref(),
        candidate.secret_key.as_deref(),
        candidate.api_key.as_deref(),
        &candidate.auth_alias,
    )
    .map_err(|reason| {
        raise_v3_source_via_err01(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Provider12ResponsesWirePayload",
            "provider_auth_handle_missing",
            reason,
            V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
        )
        .map(|(_, source)| source)
    })?;
    let mut headers = candidate.headers.clone();
    merge_anthropic_client_headers(&mut headers, &policy.client_headers);
    let target = V3ResponsesProviderTarget {
        provider_id: candidate.provider_id.clone(),
        interface_id: candidate.interface_id.clone(),
        provider_type: candidate.provider_type.clone(),
        base_url: candidate.base_url.clone(),
        canonical_model_id: candidate.model_id.clone(),
        wire_model: candidate.wire_model.clone(),
        compatibility_profile: candidate.compatibility_profile.clone(),
        headers,
        auth: V3ProviderAuthHandle {
            alias: candidate.auth_alias.clone(),
            secret,
        },
        responses_transport: candidate.responses_transport,
        websocket_v2_url: candidate.websocket_v2_url.clone(),
        provider_request_cleanup: candidate.provider_request_cleanup.clone(),
        request_timeout_ms: candidate.request_timeout_ms,
        sse_first_frame_timeout_ms: candidate.sse_first_frame_timeout_ms,
        initial_concurrency_budget: candidate.initial_concurrency_budget,
        concurrency_acquire_timeout_ms: candidate.concurrency_acquire_timeout_ms,
    };
    build_v3_provider_12_responses_wire_payload(policy.request_id.clone(), target, request_body)
        .map_err(|error| {
            raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Provider12ResponsesWirePayload",
                "anthropic_direct_provider_wire_build_failed",
                error.to_string(),
                V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
            )
            .map(|(_, source)| source)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{
        V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3RouteTargetKind,
        V3WebSearchExecutionMode,
    };
    use routecodex_v3_target::V3TargetCandidate;
    use routecodex_v3_virtual_router::V3Router07OpaqueTargetHitOnce;
    use serde_json::json;

    fn test_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
        let authoring = routecodex_v3_config::parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 7777
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct"]
allowed_invocation_sources = ["client"]
allowed_transports = ["json", "sse"]

[providers.anthropic-provider]
type = "anthropic"
base_url = "https://anthropic.invalid"
default_model = "claude-canonical"
auth = { type = "api_key", entries = [{ alias = "primary", env = "TEST_KEY" }] }
[providers.anthropic-provider.models.claude-canonical]
wire_name = "claude-wire"

[forwarders.anthropic]
model = "claude-client-alias"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "anthropic-provider", model = "claude-canonical", priority = 1 }]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "anthropic", priority = 1 }]
"#,
        )
        .expect("parse anthropic test manifest");
        routecodex_v3_config::compile_v3_config_05_manifest(authoring)
            .expect("compile anthropic test manifest")
    }

    fn failure_session_scope() -> routecodex_v3_error::V3ProviderFailureSessionScope {
        routecodex_v3_error::V3ProviderFailureSessionScope::new(
            "test",
            "anthropic-direct",
            "anthropic-direct-session",
        )
        .expect("test failure session scope")
        .with_transport_handoff_scope("test-pipeline", 7777, 1)
        .expect("test provider transport handoff scope")
    }

    fn raw_request() -> V3Server03HttpRequestRaw {
        V3Server03HttpRequestRaw {
            server_id: "test".to_string(),
            port: Some(7777),
            pipeline_id: Some("test-pipeline".to_string()),
            failure_session_scope: failure_session_scope(),
            request_id: "req-anthropic-direct".to_string(),
            execution_id: "exec-anthropic-direct".to_string(),
            method: "POST".to_string(),
            path: "/v1/messages".to_string(),
            request_purpose: crate::nodes::V3RequestPurpose::Conversation,
            body: json!({
                "model": "claude-client-alias",
                "max_tokens": 1024,
                "system": [{"type": "text", "text": "system guidance"}],
                "messages": [
                    {"role": "user", "content": [{"type": "text", "text": "hello"}]},
                    {
                        "role": "assistant",
                        "content": [{
                            "type": "tool_use",
                            "id": "toolu_1",
                            "name": "lookup",
                            "input": {"q": "needle"}
                        }]
                    },
                    {
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": "found"
                        }]
                    }
                ],
                "tools": [{
                    "name": "lookup",
                    "description": "Lookup a value",
                    "input_schema": {
                        "type": "object",
                        "properties": {"q": {"type": "string"}}
                    }
                }],
                "metadata": {"user_id": "user-1"},
                "x_future_field": {"nested": [1, 2, 3]},
                "stream": false
            }),
        }
    }

    fn selected() -> V3Target10ConcreteProviderSelected {
        V3Target10ConcreteProviderSelected {
            route: V3Router07OpaqueTargetHitOnce {
                server_id: "test".to_string(),
                routing_group_id: "default".to_string(),
                pool_id: "default".to_string(),
                route_classification_reason: "direct:test".to_string(),
                target_index: 0,
                target_kind: V3RouteTargetKind::ProviderModel,
                target_id: None,
                target_plan: Vec::new(),
                request_client_model: Some("claude-client-alias".to_string()),
                request_capabilities: BTreeSet::from(["text".to_string()]),
                request_input_tokens: 3,
                hit_count: 1,
            },
            candidate: V3TargetCandidate {
                provider_id: "anthropic-provider".to_string(),
                provider_type: "anthropic".to_string(),
                interface_id: "default".to_string(),
                auth_alias: "primary".to_string(),
                model_id: "claude-canonical".to_string(),
                wire_model: "claude-wire".to_string(),
                visible_model_ids: vec!["claude-client-alias".to_string()],
                model_capabilities: vec!["text".to_string()],
                web_search_execution_mode: V3WebSearchExecutionMode::None,
                model_availability: None,
                max_context_tokens: None,
                max_tokens: None,
                context_token_estimate_scale_bps: 10_000,
                base_url: "https://anthropic.invalid".to_string(),
                responses_process: None,
                responses_transport: V3ResponsesTransportKind::Http,
                websocket_v2_url: None,
                provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
                reasoning_effort: None,
                request_timeout_ms: 300_000,
                sse_first_frame_timeout_ms: None,
                initial_concurrency_budget: 8,
                concurrency_acquire_timeout_ms: 60_000,
                compatibility_profile: None,
                headers: BTreeMap::from([(
                    "anthropic-version".to_string(),
                    "provider-version".to_string(),
                )]),
                env_name: Some("TEST_KEY".to_string()),
                token_file: None,
                secret_file: None,
                secret_key: None,
                api_key: None,
                oauth_declaration: None,
                required_capabilities: Vec::new(),
                priority: 0,
                weight: 1,
                pool_ids: vec!["default".to_string()],
                default_pool_member: true,
                path: vec!["anthropic-provider".to_string()],
            },
            candidate_count: 1,
            unavailable_candidates: Vec::new(),
            attempts: 1,
            default_floor_protected: false,
        }
    }

    #[test]
    fn native_anthropic_standardization_preserves_history_image_payloads() {
        let mut raw = raw_request();
        raw.body["messages"] = json!([
            {"role":"user","content":[{"type":"image","source":{"type":"url","url":"data:image/png;base64,AAAA"},"opaque":{"keep":1}}]},
            {"role":"assistant","content":"seen"},
            {"role":"user","content":[{"type":"image","source":{"type":"url","url":"data:image/png;base64,BBBB"}}]}
        ]);
        let original = raw.body.clone();
        let standardized = V3AnthropicDirectCodec::build_standardized(raw).unwrap();
        assert_eq!(standardized.body, original);
    }

    #[test]
    fn native_anthropic_request_headers_tools_history_and_unknown_fields_survive() {
        let raw = raw_request();
        let original_body = raw.body.clone();
        let mut standardized =
            V3AnthropicDirectCodec::build_standardized(raw).expect("standardize anthropic");
        assert_eq!(standardized.body, original_body);
        assert_eq!(standardized.endpoint, "/v1/messages");

        let control = vec![
            V3AnthropicRelayClientHeader {
                name: "anthropic-beta".to_string(),
                value: "prompt-caching-2024-07-31".to_string(),
            },
            V3AnthropicRelayClientHeader {
                name: "anthropic-version".to_string(),
                value: "client-version".to_string(),
            },
        ];
        let mut control = control;
        let tool_thinking_enabled = V3AnthropicDirectCodec::prepare_before_send(
            &mut control,
            &test_manifest(),
            "test",
            &mut standardized,
            "req-anthropic-direct",
            1,
            &mut Vec::new(),
        )
        .expect("prepare anthropic direct request");
        assert!(
            !tool_thinking_enabled,
            "protocol headers are not a tool-thinking control flag"
        );
        assert_eq!(standardized.client_headers, control);
        let policy = V3AnthropicDirectCodec::run_route(selected(), &standardized);
        assert_eq!(policy.client_headers, control);

        let wire = project_anthropic_direct_request(
            &policy,
            &crate::kernel::direct_request_key_hooks::default_v3_direct_request_key_hook_catalog(),
        )
        .expect("project native anthropic request");

        assert_eq!(wire.body()["model"], "claude-wire");
        assert_eq!(wire.body()["system"], original_body["system"]);
        assert_eq!(wire.body()["messages"], original_body["messages"]);
        assert_eq!(wire.body()["tools"], original_body["tools"]);
        assert_eq!(wire.body()["metadata"], original_body["metadata"]);
        assert_eq!(
            wire.body()["x_future_field"],
            original_body["x_future_field"]
        );
        assert_eq!(
            wire.target().headers.get("anthropic-beta"),
            Some(&"prompt-caching-2024-07-31".to_string())
        );
        assert_eq!(
            wire.target().headers.get("anthropic-version"),
            Some(&"provider-version".to_string()),
            "provider-configured headers keep precedence"
        );

        let transport = V3AnthropicDirectCodec::run_provider_transport(wire)
            .expect("build native anthropic transport");
        assert_eq!(transport.request_id(), "req-anthropic-direct");
        assert_eq!(transport.provider_id(), "anthropic-provider");
        assert_eq!(transport.body()["model"], "claude-wire");
        assert_eq!(transport.body()["messages"], original_body["messages"]);
        assert_eq!(transport.body()["tools"], original_body["tools"]);
        assert_eq!(transport.body()["metadata"], original_body["metadata"]);
        assert_eq!(
            transport.body()["x_future_field"],
            original_body["x_future_field"]
        );
    }
}
