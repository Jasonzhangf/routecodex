//! Native Gemini Direct codec.
//!
//! Gemini keeps the selected wire model in the provider URL. The request body
//! remains the native Gemini payload; stream intent comes from the client
//! endpoint action and is carried by the typed provider wire intent.

use crate::direct_response_hooks::V3DirectResponseCompatContext;
use crate::kernel::direct_request_key_hooks::{
    apply_v3_direct_request_key_hook, V3DirectRequestKeyHookCatalog, V3DirectRequestProtocol,
};
use crate::kernel::v3_direct_protocol_codec::V3DirectResponseProjectionFuture;
use crate::nodes::V3Server03HttpRequestRaw;
use crate::operation_runner::V3Err01SourceInput;
use crate::provider_failure_runtime_policy::raise_v3_source_via_err01;
use crate::{V3DirectProtocolCodec, V3ToolThinkingTurnContext};
use routecodex_v3_error::{V3ErrorSourceKind, V3InternalErrorCode};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    v3_provider_auth_secret_handle_from_declaration_fields, V3Provider12ResponsesWirePayload,
    V3ProviderAuthHandle, V3ProviderResp14Raw, V3ResponsesProviderTarget, V3ResponsesStreamIntent,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_target::V3Target10ConcreteProviderSelected;
use serde_json::Value;

const GEMINI_STREAM_GENERATE_CONTENT: &str = "streamGenerateContent";

#[derive(Debug, Clone, PartialEq)]
pub struct V3Req04StandardizedGemini {
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
    pub tool_thinking_turn_context: V3ToolThinkingTurnContext,
    pub endpoint_model: String,
    pub requested_stream: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3GeminiDirect11Policy {
    pub target: V3Target10ConcreteProviderSelected,
    pub request_id: String,
    pub request_body: Value,
    pub requested_stream: bool,
}

pub struct V3GeminiDirectCodec;

impl V3DirectProtocolCodec for V3GeminiDirectCodec {
    type Standardized = V3Req04StandardizedGemini;
    type Policy = V3GeminiDirect11Policy;
    type Control = ();

    const ENTRY_PROTOCOL: &'static str = "gemini";
    const HUB_ENTRY_PROTOCOL: crate::hub_v1::V3HubEntryProtocol =
        crate::hub_v1::V3HubEntryProtocol::Gemini;
    const STANDARDIZED_STAGE: &'static str = "V3Req04StandardizedGemini";
    const POLICY_STAGE: &'static str = "V3GeminiDirect11Policy";

    fn build_standardized(raw: V3Server03HttpRequestRaw) -> Result<Self::Standardized, String> {
        let (endpoint_model, requested_stream) = gemini_endpoint_binding(&raw.path)?;
        let mut body = raw.body;
        let object = body
            .as_object_mut()
            .ok_or_else(|| "Gemini request payload must be a JSON object".to_string())?;
        object
            .entry("model".to_string())
            .or_insert_with(|| Value::String(endpoint_model.clone()));
        Ok(V3Req04StandardizedGemini {
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
            tool_thinking_turn_context: V3ToolThinkingTurnContext::disabled(),
            endpoint_model,
            requested_stream,
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

    fn tool_thinking_turn_context(standardized: &Self::Standardized) -> &V3ToolThinkingTurnContext {
        &standardized.tool_thinking_turn_context
    }

    fn policy_target(policy: &Self::Policy) -> &V3Target10ConcreteProviderSelected {
        &policy.target
    }

    fn run_route(
        selected: V3Target10ConcreteProviderSelected,
        standardized: &Self::Standardized,
    ) -> Self::Policy {
        V3GeminiDirect11Policy {
            target: selected,
            request_id: standardized.request_id.clone(),
            request_body: standardized.body.clone(),
            requested_stream: standardized.requested_stream,
        }
    }

    fn run_request_projection(
        policy: &Self::Policy,
        request_key_catalog: &V3DirectRequestKeyHookCatalog,
        _drop_context: &crate::projection_drop_log::V3ProjectionDropContext,
    ) -> crate::shared::V3DirectSourceResult<V3Provider12ResponsesWirePayload> {
        let candidate = &policy.target.candidate;
        let wire_body = crate::selected_provider_model_binding::bind_v3_selected_provider_model(
            policy.request_body.clone(),
            candidate,
        )
        .map(crate::selected_provider_model_binding::V3SelectedProviderModelBinding::into_payload)
        .map_err(|reason| {
            raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Req04StandardizedGemini",
                "selected_provider_model_binding_failed",
                reason,
                V3Err01SourceInput::Internal(V3InternalErrorCode::V3Req04StandardizedResponses),
            )
            .map(|(_, source)| source)
        })?;
        let wire_body = apply_gemini_request_key_hook(wire_body, request_key_catalog)?;
        let profile = crate::hub_v1::V3ProviderCompatProfileId::from_config(
            candidate.compatibility_profile.as_deref(),
        );
        let (wire_body, _) = crate::hub_v1::apply_v3_provider_req_compat_to_provider_payload(
            wire_body,
            candidate,
            crate::hub_v1::V3HubProviderWireProtocol::Gemini,
            &profile,
        )
        .map_err(|error| {
            raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Req04StandardizedGemini",
                "gemini_direct_provider_compat_failed",
                error.to_string(),
                V3Err01SourceInput::Internal(V3InternalErrorCode::V3Req04StandardizedResponses),
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
                "V3Req04StandardizedGemini",
                "provider_auth_handle_missing",
                reason,
                V3Err01SourceInput::Internal(V3InternalErrorCode::V3Req04StandardizedResponses),
            )
            .map(|(_, source)| source)
        })?;
        let target = V3ResponsesProviderTarget {
            provider_id: candidate.provider_id.clone(),
            interface_id: candidate.interface_id.clone(),
            provider_type: candidate.provider_type.clone(),
            base_url: candidate.base_url.clone(),
            canonical_model_id: candidate.model_id.clone(),
            wire_model: candidate.wire_model.clone(),
            compatibility_profile: candidate.compatibility_profile.clone(),
            headers: candidate.headers.clone(),
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
        build_v3_provider_12_responses_wire_payload(policy.request_id.clone(), target, wire_body)
            .map(|wire| {
                wire.with_stream_intent(if policy.requested_stream {
                    V3ResponsesStreamIntent::Sse
                } else {
                    V3ResponsesStreamIntent::Json
                })
            })
            .map_err(|error| {
                crate::hooks::build_v3_provider_error_source(
                    "V3Provider12ResponsesWirePayload",
                    error,
                )
            })
    }

    fn run_provider_transport(
        wire: V3Provider12ResponsesWirePayload,
    ) -> crate::shared::V3DirectSourceResult<V3Transport13ResponsesHttpRequest> {
        crate::hub_v1::build_v3_provider_transport_request_for_protocol(
            crate::hub_v1::V3HubProviderWireProtocol::Gemini,
            wire,
        )
        .map_err(|error| {
            raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Req04StandardizedGemini",
                "gemini_direct_provider_transport_error",
                error,
                V3Err01SourceInput::Internal(V3InternalErrorCode::V3Req04StandardizedResponses),
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
    ) -> V3DirectResponseProjectionFuture {
        crate::hooks::chat_direct_response_projection_hook(raw, context)
    }

    fn prepare_before_send(
        _control: &mut Self::Control,
        manifest: &routecodex_v3_config::V3Config05ManifestPublished,
        server_id: &str,
        standardized: &mut Self::Standardized,
        _request_id: &str,
        _now_epoch_ms: u64,
        _trace: &mut Vec<&'static str>,
    ) -> crate::shared::V3DirectSourceResult<bool> {
        let enabled = crate::hub_v1::v3_tool_thinking_enabled_for_server(manifest, server_id);
        if standardized.tool_thinking_turn_context.enabled_flag() {
            return Ok(true);
        }
        standardized.tool_thinking_turn_context =
            crate::hub_v1::compile_v3_tool_thinking_turn_context_at_req04(
                &mut standardized.body,
                0,
                enabled,
            )
            .map_err(|error| {
                raise_v3_source_via_err01(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3Req04StandardizedGemini",
                    "direct_tool_thinking_req04_injection_failed",
                    error.to_string(),
                    V3Err01SourceInput::Internal(V3InternalErrorCode::V3Req04StandardizedResponses),
                )
                .map(|(_, source)| source)
            })?;
        Ok(standardized.tool_thinking_turn_context.enabled_flag())
    }

    fn failure_session_scope(
        _control: &Self::Control,
        standardized: &Self::Standardized,
    ) -> routecodex_v3_error::V3ProviderFailureSessionScope {
        standardized.failure_session_scope.clone()
    }
}

fn apply_gemini_request_key_hook(
    body: Value,
    catalog: &V3DirectRequestKeyHookCatalog,
) -> crate::shared::V3DirectSourceResult<Value> {
    let mut catalog = *catalog;
    apply_v3_direct_request_key_hook(body, V3DirectRequestProtocol::Gemini, &mut catalog).map_err(
        |error| {
            raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Req04StandardizedGemini",
                "direct_request_key_hook_failed",
                error,
                V3Err01SourceInput::Internal(V3InternalErrorCode::V3Req04StandardizedResponses),
            )
            .map(|(_, source)| source)
        },
    )
}

fn gemini_endpoint_binding(path: &str) -> Result<(String, bool), String> {
    let path = path.split('?').next().unwrap_or(path);
    let model =
        crate::hub_v1::gemini_model_from_endpoint_path(path).map_err(|error| error.to_string())?;
    Ok((model, path.ends_with(GEMINI_STREAM_GENERATE_CONTENT)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{
        V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
    };
    use routecodex_v3_target::{V3Target10ConcreteProviderSelected, V3TargetCandidate};
    use routecodex_v3_virtual_router::{
        V3Router07OpaqueTargetHitOnce, V3Router07OpaqueTargetPlanEntry,
    };
    use serde_json::json;
    use std::collections::BTreeSet;

    #[test]
    fn native_standardization_preserves_history_images_and_unknown_parts() {
        let body = json!({"contents":[
            {"role":"user","parts":[{"inline_data":{"mime_type":"image/png","data":"AAAA"},"opaque":{"keep":1}}]},
            {"role":"model","parts":[{"text":"seen"}]},
            {"role":"user","parts":[{"inline_data":{"mime_type":"image/png","data":"BBBB"}}]}
        ],"unknown":{"keep":[false,17]}});
        let raw = crate::nodes::build_v3_server_03_http_request_raw(
            "server".into(),
            routecodex_v3_error::V3ProviderFailureSessionScope::new("server", "default", "request")
                .unwrap(),
            "request".into(),
            "execution".into(),
            "POST".into(),
            "/v1beta/models/gemini:generateContent".into(),
            body.clone(),
        );
        let standardized = V3GeminiDirectCodec::build_standardized(raw).unwrap();
        assert_eq!(standardized.body["contents"], body["contents"]);
        assert_eq!(standardized.body["unknown"], body["unknown"]);
    }

    #[test]
    fn endpoint_binding_preserves_json_and_sse_actions() {
        assert_eq!(
            gemini_endpoint_binding("/v1beta/models/gemini-3/generateContent").unwrap(),
            ("gemini-3".to_string(), false)
        );
        assert_eq!(
            gemini_endpoint_binding("/v1beta/models/gemini-3:generateContent").unwrap(),
            ("gemini-3".to_string(), false)
        );
        assert_eq!(
            gemini_endpoint_binding("/v1beta/models/gemini-3:streamGenerateContent?alt=sse")
                .unwrap(),
            ("gemini-3".to_string(), true)
        );
    }

    #[test]
    fn direct_projection_uses_typed_stream_intent_without_stream_body_injection() {
        let policy = policy(true);
        let wire = <V3GeminiDirectCodec as V3DirectProtocolCodec>::run_request_projection(
            &policy,
            &crate::kernel::direct_request_key_hooks::default_v3_direct_request_key_hook_catalog(),
            &crate::projection_drop_log::V3ProjectionDropContext::disabled(),
        )
        .expect("Gemini request projection must build");

        assert_eq!(wire.stream_intent(), V3ResponsesStreamIntent::Sse);
        assert_eq!(wire.body()["model"], "gemini-wire");
        assert!(wire.body().get("stream").is_none());

        let transport =
            <V3GeminiDirectCodec as V3DirectProtocolCodec>::run_provider_transport(wire)
                .expect("Gemini transport must build");
        let projection = transport.provider_request_projection();
        assert_eq!(projection["streamIntent"], "sse");
        assert_eq!(
            projection["url"],
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-wire:streamGenerateContent?alt=sse"
        );
        assert!(projection["body"].get("model").is_none());
        assert!(projection["body"].get("stream").is_none());
    }

    fn policy(requested_stream: bool) -> V3GeminiDirect11Policy {
        V3GeminiDirect11Policy {
            target: V3Target10ConcreteProviderSelected {
                route: V3Router07OpaqueTargetHitOnce {
                    server_id: "gemini-direct".to_string(),
                    routing_group_id: "gemini-direct".to_string(),
                    pool_id: "default".to_string(),
                    route_classification_reason: "gemini-direct-test".to_string(),
                    target_index: 0,
                    target_kind: routecodex_v3_config::V3RouteTargetKind::ProviderModel,
                    target_id: None,
                    target_plan: Vec::<V3Router07OpaqueTargetPlanEntry>::new(),
                    request_client_model: Some("gemini-client".to_string()),
                    request_capabilities: BTreeSet::from(["text".to_string()]),
                    request_input_tokens: 1,
                    hit_count: 1,
                },
                candidate: V3TargetCandidate {
                    provider_id: "gemini-provider".to_string(),
                    provider_type: "Gemini".to_string(),
                    interface_id: "default".to_string(),
                    auth_alias: "primary".to_string(),
                    model_id: "gemini-canonical".to_string(),
                    wire_model: "gemini-wire".to_string(),
                    visible_model_ids: vec!["gemini-client".to_string()],
                    model_capabilities: vec!["text".to_string()],
                    web_search_execution_mode: V3WebSearchExecutionMode::None,
                    model_availability: None,
                    max_context_tokens: None,
                    max_tokens: None,
                    context_token_estimate_scale_bps: 10_000,
                    base_url: "https://generativelanguage.googleapis.com/v1beta".to_string(),
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
                    headers: Default::default(),
                    env_name: None,
                    token_file: None,
                    secret_file: None,
                    secret_key: None,
                    api_key: Some("test-key".to_string()),
                    oauth_declaration: None,
                    required_capabilities: Vec::new(),
                    priority: 0,
                    weight: 1,
                    pool_ids: vec!["default".to_string()],
                    default_pool_member: true,
                    path: vec!["gemini-provider".to_string()],
                },
                distinct_identity_count: 1,
                candidate_count: 1,
                unavailable_candidates: Vec::new(),
                attempts: 0,
                default_floor_protected: false,
            },
            request_id: "request-gemini".to_string(),
            request_body: json!({
                "contents": [{"role": "user", "parts": [{"text": "hello"}]}],
                "tools": [{"functionDeclarations": [{"name": "lookup"}]}]
            }),
            requested_stream,
        }
    }
}
