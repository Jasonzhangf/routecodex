use crate::direct_response_hooks::V3DirectResponseCompatContext;
use crate::kernel::direct_request_key_hooks::{
    apply_v3_direct_request_key_hook, default_v3_direct_request_key_hook_catalog,
    V3DirectRequestKeyEdits, V3DirectRequestKeyHookCatalog, V3DirectRequestKeyKind,
    V3DirectRequestKeyMount, V3DirectRequestKeyView, V3DirectRequestProtocol,
};
use crate::kernel::V3DirectSseTypedHookCatalog;
use crate::nodes::{
    build_v3_responses_direct_11_policy_from_v3_target_10, V3ChatDirect11Policy,
    V3Req04StandardizedResponses, V3ResponsesDirect11Policy,
};
use crate::shared::{
    project_provider_raw_to_client_payload_with_plan_and_projection_and_observation_context,
    V3ProviderAttemptBody, V3ProviderResponseProjection,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    build_v3_error_01_source_raised_internal, V3Error01SourceRaised, V3Error05ExecutionDecision,
    V3Error05RecoveryAdmissionWitness, V3ErrorActionScope, V3ErrorHandlingCenter,
    V3ErrorHandlingCenterInput, V3ErrorSourceKind, V3ExternalErrorKind, V3ExternalErrorLink,
    V3InternalErrorCode,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload, V3Provider12ResponsesWirePayload,
    V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderError, V3ProviderResp14Raw,
    V3ResponsesProviderTarget, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_target::V3Target10ConcreteProviderSelected;
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;

fn apply_v3_direct_request_key_hook_with_catalog(
    body: Value,
    protocol: V3DirectRequestProtocol,
    catalog: &V3DirectRequestKeyHookCatalog,
) -> Result<Value, V3Error01SourceRaised> {
    let mut catalog = *catalog;
    apply_v3_direct_request_key_hook(body, protocol, &mut catalog).map_err(|error| {
        build_v3_error_01_source_raised_internal(
            V3ErrorSourceKind::RuntimeFailure,
            "V3DirectRequestKeyHook",
            "direct_request_key_hook_failed",
            error,
            V3InternalErrorCode::V3Provider12ResponsesWirePayload,
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HookPoint {
    Route,
    RequestProjection,
    ProviderTransport,
    ResponseProjection,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V3RegisteredHook {
    pub hook_id: &'static str,
    pub hook_point: V3HookPoint,
    pub input_node: &'static str,
    pub output_node: &'static str,
}

type RouteHook = fn(
    V3Target10ConcreteProviderSelected,
    &V3Req04StandardizedResponses,
) -> V3ResponsesDirect11Policy;
type RequestProjectionHook = fn(
    &V3ResponsesDirect11Policy,
    &V3DirectRequestKeyHookCatalog,
) -> Result<V3Provider12ResponsesWirePayload, V3Error01SourceRaised>;
type ProviderTransportHook = fn(
    V3Provider12ResponsesWirePayload,
)
    -> Result<V3Transport13ResponsesHttpRequest, V3Error01SourceRaised>;
type ResponseProjectionFuture = Pin<
    Box<dyn Future<Output = Result<V3ProviderResponseProjection, V3Error01SourceRaised>> + Send>,
>;
type ContextualResponseProjectionHook =
    fn(V3ProviderResp14Raw, V3DirectResponseCompatContext) -> ResponseProjectionFuture;
type ErrorHook = fn(
    V3Error01SourceRaised,
    V3ErrorActionScope,
    usize,
    bool,
    bool,
    Option<V3Error05RecoveryAdmissionWitness>,
) -> V3Error05ExecutionDecision;

#[derive(Clone, Copy)]
pub struct V3HookRegistry {
    hooks: &'static [V3RegisteredHook],
    route: RouteHook,
    request_projection: RequestProjectionHook,
    request_key_catalog: V3DirectRequestKeyHookCatalog,
    direct_sse_typed_hooks: V3DirectSseTypedHookCatalog,
    provider_transport: ProviderTransportHook,
    contextual_response_projection: ContextualResponseProjectionHook,
    error: ErrorHook,
}

impl std::fmt::Debug for V3HookRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("V3HookRegistry")
            .field("hooks", &self.hooks)
            .finish()
    }
}

impl V3HookRegistry {
    pub fn hooks(&self) -> &'static [V3RegisteredHook] {
        self.hooks
    }

    pub fn require_hook(&self, hook_id: &str) -> bool {
        self.hooks.iter().any(|hook| hook.hook_id == hook_id)
    }

    pub fn run_route(
        &self,
        selected: V3Target10ConcreteProviderSelected,
        standardized: &V3Req04StandardizedResponses,
    ) -> V3ResponsesDirect11Policy {
        (self.route)(selected, standardized)
    }

    pub fn run_request_projection(
        &self,
        policy: &V3ResponsesDirect11Policy,
    ) -> Result<V3Provider12ResponsesWirePayload, V3Error01SourceRaised> {
        (self.request_projection)(policy, &self.request_key_catalog)
    }

    pub(crate) fn request_key_catalog(&self) -> &V3DirectRequestKeyHookCatalog {
        &self.request_key_catalog
    }

    pub(crate) fn direct_sse_typed_hooks(&self) -> V3DirectSseTypedHookCatalog {
        self.direct_sse_typed_hooks
    }

    pub fn run_provider_transport(
        &self,
        wire: V3Provider12ResponsesWirePayload,
    ) -> Result<V3Transport13ResponsesHttpRequest, V3Error01SourceRaised> {
        (self.provider_transport)(wire)
    }

    pub async fn run_response_projection_with_context(
        &self,
        raw: V3ProviderResp14Raw,
        context: V3DirectResponseCompatContext,
    ) -> Result<V3ProviderResponseProjection, V3Error01SourceRaised> {
        (self.contextual_response_projection)(raw, context).await
    }

    pub fn run_error(
        &self,
        source: V3Error01SourceRaised,
        scope: V3ErrorActionScope,
        candidates_remaining: usize,
        default_pool_available: bool,
        same_provider_retry_available: bool,
        recovery: Option<V3Error05RecoveryAdmissionWitness>,
    ) -> V3Error05ExecutionDecision {
        (self.error)(
            source,
            scope,
            candidates_remaining,
            default_pool_available,
            same_provider_retry_available,
            recovery,
        )
    }
}

pub fn register_responses_direct_hooks() -> V3HookRegistry {
    let catalog = default_v3_direct_request_key_hook_catalog();
    register_responses_direct_hooks_with_key_catalog(&catalog)
}

pub(crate) fn register_responses_direct_hooks_with_key_catalog(
    request_key_catalog: &V3DirectRequestKeyHookCatalog,
) -> V3HookRegistry {
    static HOOKS: &[V3RegisteredHook] = &[
        V3RegisteredHook {
            hook_id: "ResponsesDirectRouteHook",
            hook_point: V3HookPoint::Route,
            input_node: "V3Target10ConcreteProviderSelected",
            output_node: "V3ResponsesDirect11Policy",
        },
        V3RegisteredHook {
            hook_id: "ResponsesDirectRequestProjectionHook",
            hook_point: V3HookPoint::RequestProjection,
            input_node: "V3ResponsesDirect11Policy",
            output_node: "V3Provider12ResponsesWirePayload",
        },
        V3RegisteredHook {
            hook_id: "ResponsesDirectSystemPromptKeyHook",
            hook_point: V3HookPoint::RequestProjection,
            input_node: "V3Provider12ResponsesWirePayload",
            output_node: "V3Provider12ResponsesWirePayload",
        },
        V3RegisteredHook {
            hook_id: "ResponsesDirectDeveloperPromptKeyHook",
            hook_point: V3HookPoint::RequestProjection,
            input_node: "V3Provider12ResponsesWirePayload",
            output_node: "V3Provider12ResponsesWirePayload",
        },
        V3RegisteredHook {
            hook_id: "ResponsesDirectToolsKeyHook",
            hook_point: V3HookPoint::RequestProjection,
            input_node: "V3Provider12ResponsesWirePayload",
            output_node: "V3Provider12ResponsesWirePayload",
        },
        V3RegisteredHook {
            hook_id: "ResponsesDirectProviderTransportHook",
            hook_point: V3HookPoint::ProviderTransport,
            input_node: "V3Provider12ResponsesWirePayload",
            output_node: "V3Transport13ResponsesHttpRequest",
        },
        V3RegisteredHook {
            hook_id: "ResponsesDirectResponseProjectionHook",
            hook_point: V3HookPoint::ResponseProjection,
            input_node: "V3ProviderResp14Raw",
            output_node: "V3DirectResp14ProviderProjectionPrepared",
        },
        V3RegisteredHook {
            hook_id: "ResponsesDirectErrorHook",
            hook_point: V3HookPoint::Error,
            input_node: "V3Error01SourceRaised",
            output_node: "V3Error05ExecutionDecision",
        },
    ];
    let direct_sse_typed_hooks =
        V3DirectSseTypedHookCatalog::new().with_toolreason(apply_responses_toolreason_sse_hook);
    V3HookRegistry {
        hooks: HOOKS,
        route: responses_direct_route_hook,
        request_projection: responses_direct_request_projection_hook_with_key_catalog,
        request_key_catalog: *request_key_catalog,
        direct_sse_typed_hooks,
        provider_transport: responses_direct_provider_transport_hook,
        contextual_response_projection: responses_direct_response_projection_hook_with_context,
        error: responses_direct_error_hook,
    }
}

pub(crate) fn apply_responses_toolreason_sse_hook(
    value: &mut serde_json::Value,
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    session_id: Option<&str>,
    request_id: Option<&str>,
    expected_model_id: Option<&str>,
    argument_buffers: &mut Vec<String>,
    projection_authorized: &mut bool,
    stream_observation: Option<&crate::hub_v1::V3RuntimeStreamObservation>,
) -> Result<(), String> {
    apply_toolreason_sse_hook_with_stream_observation(
        value,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        session_id,
        request_id,
        expected_model_id,
        argument_buffers,
        Some(projection_authorized),
        stream_observation,
    )
}

pub(crate) fn apply_relay_toolreason_sse_hook(
    value: &mut serde_json::Value,
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    session_id: Option<&str>,
    request_id: Option<&str>,
    expected_model_id: Option<&str>,
    argument_buffers: &mut Vec<String>,
    projection_authorized: Option<&mut bool>,
) {
    let result = apply_toolreason_sse_hook_with_stream_observation(
        value,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        session_id,
        request_id,
        expected_model_id,
        argument_buffers,
        projection_authorized,
        None,
    );
    debug_assert!(result.is_ok());
}

fn apply_toolreason_sse_hook_with_stream_observation(
    value: &mut serde_json::Value,
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    session_id: Option<&str>,
    request_id: Option<&str>,
    expected_model_id: Option<&str>,
    argument_buffers: &mut Vec<String>,
    mut projection_authorized: Option<&mut bool>,
    stream_observation: Option<&crate::hub_v1::V3RuntimeStreamObservation>,
) -> Result<(), String> {
    crate::hub_v1::strip_v3_tool_thinking_request_artifacts_at_resp03(value);
    if projection_authorized.is_some()
        && crate::hub_v1::v3_toolreason_projection_authorized_at_resp03(value, expected_model_id)
    {
        if let Some(authorized) = projection_authorized.as_deref_mut() {
            *authorized = true;
        }
    }
    let mut observation_error = None;
    crate::hub_v1::map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers_expected_model_and_stream_observation(
        value,
        true,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        session_id,
        request_id,
        Some(argument_buffers),
        expected_model_id,
        stream_observation,
        &mut observation_error,
    );
    if let Some(error) = observation_error {
        return Err(error);
    }
    if pending_reasons.iter().any(Option::is_some) {
        if let Some(authorized) = projection_authorized.as_deref_mut() {
            *authorized = true;
        }
    }
    Ok(())
}

fn responses_direct_route_hook(
    selected: V3Target10ConcreteProviderSelected,
    standardized: &V3Req04StandardizedResponses,
) -> V3ResponsesDirect11Policy {
    build_v3_responses_direct_11_policy_from_v3_target_10(selected, standardized)
}

pub(crate) fn responses_direct_request_projection_hook(
    policy: &V3ResponsesDirect11Policy,
) -> Result<V3Provider12ResponsesWirePayload, V3Error01SourceRaised> {
    let catalog = default_v3_direct_request_key_hook_catalog();
    responses_direct_request_projection_hook_with_key_catalog(policy, &catalog)
}

pub(crate) fn responses_direct_request_projection_hook_with_key_catalog(
    policy: &V3ResponsesDirect11Policy,
    key_catalog: &V3DirectRequestKeyHookCatalog,
) -> Result<V3Provider12ResponsesWirePayload, V3Error01SourceRaised> {
    let candidate = &policy.target.candidate;
    let provider_protocol = crate::hub_v1::provider_wire_protocol_for_selected_candidate(candidate)
        .map_err(|error| {
            build_v3_error_01_source_raised_internal(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ResponsesDirect11Policy",
                "responses_provider_protocol_resolution_failed",
                error,
                V3InternalErrorCode::V3Provider12ResponsesWirePayload,
            )
        })?;
    let request_body = crate::selected_provider_model_binding::bind_v3_selected_provider_model(
        policy.request_body.clone(),
        candidate,
    )
    .map(crate::selected_provider_model_binding::V3SelectedProviderModelBinding::into_payload)
    .map_err(|reason| {
        build_v3_error_01_source_raised_internal(
            V3ErrorSourceKind::RuntimeFailure,
            "V3ResponsesDirect11Policy",
            "selected_provider_model_binding_failed",
            reason,
            V3InternalErrorCode::V3Provider12ResponsesWirePayload,
        )
    })?;
    let mut request_body = match provider_protocol {
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat => {
            crate::hub_v1::build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(
                &request_body,
            )
            .and_then(|canonical| {
                crate::hub_v1::build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
            })
            .map_err(|error| {
                build_v3_error_01_source_raised_internal(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3ResponsesDirect11Policy",
                    "responses_openai_chat_wire_projection_failed",
                    error,
                    V3InternalErrorCode::V3Provider12ResponsesWirePayload,
                )
            })?
        }
        crate::hub_v1::V3HubProviderWireProtocol::Anthropic => {
            return Err(build_v3_error_01_source_raised_internal(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ResponsesDirect11Policy",
                "responses_direct_cross_protocol_projection_unsupported",
                "Responses direct does not have a response-side Anthropic projection contract",
                V3InternalErrorCode::V3Provider12ResponsesWirePayload,
            ));
        }
        _ => request_body,
    };
    if provider_protocol == crate::hub_v1::V3HubProviderWireProtocol::Responses {
        crate::hub_v1::normalize_v3_openai_responses_provider_request_payload(&mut request_body);
    }
    let direct_request_protocol = match provider_protocol {
        crate::hub_v1::V3HubProviderWireProtocol::Responses => V3DirectRequestProtocol::Responses,
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat => V3DirectRequestProtocol::OpenAiChat,
        crate::hub_v1::V3HubProviderWireProtocol::Anthropic => {
            return Err(build_v3_error_01_source_raised_internal(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ResponsesDirect11Policy",
                "responses_direct_request_key_protocol_unsupported",
                "Responses direct request key hooks do not support Anthropic projection",
                V3InternalErrorCode::V3Provider12ResponsesWirePayload,
            ));
        }
        _ => {
            return Err(build_v3_error_01_source_raised_internal(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ResponsesDirect11Policy",
                "responses_direct_request_key_protocol_unsupported",
                "Responses direct request key hooks require a registered provider protocol",
                V3InternalErrorCode::V3Provider12ResponsesWirePayload,
            ));
        }
    };
    request_body = apply_v3_direct_request_key_hook_with_catalog(
        request_body,
        direct_request_protocol,
        key_catalog,
    )?;
    let profile = crate::hub_v1::V3ProviderCompatProfileId::from_config(
        candidate.compatibility_profile.as_deref(),
    );
    request_body = crate::hub_v1::apply_v3_provider_req_compat_to_provider_payload(
        request_body,
        candidate,
        provider_protocol,
        &profile,
    )
    .map_err(|error| {
        build_v3_error_01_source_raised_internal(
            V3ErrorSourceKind::RuntimeFailure,
            "V3ResponsesDirect11Policy",
            "responses_direct_provider_compat_failed",
            format!("{}", error),
            V3InternalErrorCode::V3Provider12ResponsesWirePayload,
        )
    })?;
    let secret = match (
        &candidate.env_name,
        &candidate.token_file,
        &candidate.secret_file,
        &candidate.secret_key,
        &candidate.api_key,
    ) {
        (Some(name), None, None, None, None) => {
            V3ProviderAuthSecretHandle::Environment(name.clone())
        }
        (None, Some(path), None, None, None) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        (None, None, Some(path), Some(key), None) => V3ProviderAuthSecretHandle::SecretFile {
            path: path.clone(),
            key: key.clone(),
        },
        (None, None, None, None, Some(value)) => V3ProviderAuthSecretHandle::ApiKey(value.clone()),
        _ => {
            return Err(build_v3_error_01_source_raised_internal(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Provider12ResponsesWirePayload",
                "provider_auth_handle_missing",
                format!(
                    "provider {} selected without auth handle",
                    candidate.provider_id
                ),
                V3InternalErrorCode::V3Provider12ResponsesWirePayload,
            ))
        }
    };
    build_v3_provider_12_responses_wire_payload(
        policy.request_id.clone(),
        V3ResponsesProviderTarget {
            provider_id: candidate.provider_id.clone(),
            provider_type: candidate.provider_type.clone(),
            base_url: candidate.base_url.clone(),
            canonical_model_id: candidate.model_id.clone(),
            wire_model: candidate.wire_model.clone(),
            compatibility_profile: candidate.compatibility_profile.clone(),
            sse_first_frame_timeout_ms: candidate.sse_first_frame_timeout_ms,
            auth: V3ProviderAuthHandle {
                alias: candidate.auth_alias.clone(),
                secret,
            },
            responses_transport: candidate.responses_transport,
            websocket_v2_url: candidate.websocket_v2_url.clone(),
            provider_request_cleanup: candidate.provider_request_cleanup.clone(),
            request_timeout_ms: candidate.request_timeout_ms,
            initial_concurrency_budget: candidate.initial_concurrency_budget,
        },
        request_body,
    )
    .map_err(provider_error_source("V3Provider12ResponsesWirePayload"))
}

pub(crate) fn responses_direct_provider_transport_hook(
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, V3Error01SourceRaised> {
    let provider_protocol = crate::hub_v1::provider_wire_protocol_for_provider_type(
        wire.target().provider_id.as_str(),
        wire.target().provider_type.as_str(),
    )
    .map_err(|error| {
        build_v3_error_01_source_raised_internal(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Transport13ResponsesHttpRequest",
            "responses_provider_protocol_resolution_failed",
            error,
            V3InternalErrorCode::V3Transport13ResponsesHttpRequest,
        )
    })?;
    crate::hub_v1::build_v3_provider_transport_request_for_protocol(provider_protocol, wire)
        .map_err(|error| {
            build_v3_error_01_source_raised_internal(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Transport13ResponsesHttpRequest",
                "responses_provider_transport_error",
                error,
                V3InternalErrorCode::V3Transport13ResponsesHttpRequest,
            )
        })
}

pub(crate) fn responses_direct_response_projection_hook_with_context(
    raw: V3ProviderResp14Raw,
    context: V3DirectResponseCompatContext,
) -> ResponseProjectionFuture {
    Box::pin(async move {
        let request_id = raw.request_id().to_owned();
        let plan = context.compile_plan().map_err(|error| {
            build_v3_error_01_source_raised_internal(
                V3ErrorSourceKind::RuntimeFailure,
                "V3DirectResp14ProviderCompat",
                "direct_response_compat_plan_compile_failed",
                error,
                V3InternalErrorCode::V3DirectResp14ProviderProjectionPrepared,
            )
        })?;
        let mut projection = project_provider_raw_to_client_payload_with_plan_and_projection_and_observation_context(
            raw,
            &plan,
            context.tool_thinking_enabled,
            context.toolreason_client_projection,
            context.toolreason_observation_session_id.as_deref(),
        )
        .await?;
        if context.tool_thinking_enabled {
            if let V3ProviderAttemptBody::Json(payload) = &mut projection.attempt_payload.body {
                crate::hub_v1::map_v3_toolreason_to_reasoning_content_at_resp03_with_expected_model_and_context(
                    payload,
                    true,
                    context.toolreason_client_projection,
                    Some(context.canonical_model_id.as_str()),
                    crate::hub_v1::V3ToolreasonObservationContext {
                        session_id: context.toolreason_observation_session_id.as_deref(),
                        request_id: Some(request_id.as_str()),
                    },
                );
                if let Some(names) = context
                    .tool_thinking_turn_context
                    .original_custom_tool_names()
                {
                    crate::hub_v1::restore_v3_tool_thinking_custom_calls_in_payload_at_resp03(
                        payload, names,
                    );
                }
            }
        }
        Ok(projection)
    })
}

pub(crate) fn chat_direct_response_projection_hook(
    raw: V3ProviderResp14Raw,
    context: V3DirectResponseCompatContext,
) -> ResponseProjectionFuture {
    Box::pin(async move {
        let request_id = raw.request_id().to_owned();
        let plan = context.compile_plan().map_err(|error| {
            build_v3_error_01_source_raised_internal(
                V3ErrorSourceKind::RuntimeFailure,
                "V3DirectResp14ProviderCompat",
                "direct_response_compat_plan_compile_failed",
                error,
                V3InternalErrorCode::V3DirectResp14ProviderProjectionPrepared,
            )
        })?;
        let mut projection = project_provider_raw_to_client_payload_with_plan_and_projection_and_observation_context(
            raw,
            &plan,
            context.tool_thinking_enabled,
            context.toolreason_client_projection,
            context.toolreason_observation_session_id.as_deref(),
        )
        .await?;
        if context.tool_thinking_enabled {
            if let V3ProviderAttemptBody::Json(payload) = &mut projection.attempt_payload.body {
                crate::hub_v1::map_v3_toolreason_to_reasoning_content_at_resp03_with_expected_model_and_context(
                    payload,
                    true,
                    context.toolreason_client_projection,
                    Some(context.canonical_model_id.as_str()),
                    crate::hub_v1::V3ToolreasonObservationContext {
                        session_id: context.toolreason_observation_session_id.as_deref(),
                        request_id: Some(request_id.as_str()),
                    },
                );
                if let Some(names) = context
                    .tool_thinking_turn_context
                    .original_custom_tool_names()
                {
                    crate::hub_v1::restore_v3_tool_thinking_custom_calls_in_payload_at_resp03(
                        payload, names,
                    );
                }
            }
        }
        Ok(projection)
    })
}

fn provider_error_source(
    stage: &'static str,
) -> impl FnOnce(V3ProviderError) -> V3Error01SourceRaised {
    move |error| build_v3_provider_error_source(stage, error)
}

pub(crate) fn chat_direct_request_projection_hook(
    policy: &V3ChatDirect11Policy,
) -> Result<V3Provider12ResponsesWirePayload, V3Error01SourceRaised> {
    let catalog = default_v3_direct_request_key_hook_catalog();
    chat_direct_request_projection_hook_with_key_catalog(policy, &catalog)
}

pub(crate) fn chat_direct_request_projection_hook_with_key_catalog(
    policy: &V3ChatDirect11Policy,
    key_catalog: &V3DirectRequestKeyHookCatalog,
) -> Result<V3Provider12ResponsesWirePayload, V3Error01SourceRaised> {
    let candidate = &policy.target.candidate;
    let request_body = crate::selected_provider_model_binding::bind_v3_selected_provider_model(
        policy.request_body.clone(),
        candidate,
    )
    .map(crate::selected_provider_model_binding::V3SelectedProviderModelBinding::into_payload)
    .map_err(|reason| {
        build_v3_error_01_source_raised_internal(
            V3ErrorSourceKind::RuntimeFailure,
            "V3ChatDirect11Policy",
            "selected_provider_model_binding_failed",
            reason,
            V3InternalErrorCode::V3Provider12ResponsesWirePayload,
        )
    })?;
    let mut wire_body =
        crate::hub_v1::build_v3_openai_chat_standard_request_from_chat_canonical(&request_body)
            .map_err(|error| {
                build_v3_error_01_source_raised_internal(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3ChatDirect11Policy",
                    "chat_wire_projection_failed",
                    error,
                    V3InternalErrorCode::V3Provider12ResponsesWirePayload,
                )
            })?;
    wire_body = apply_v3_direct_request_key_hook_with_catalog(
        wire_body,
        V3DirectRequestProtocol::OpenAiChat,
        key_catalog,
    )?;
    let secret = match (
        &candidate.env_name,
        &candidate.token_file,
        &candidate.secret_file,
        &candidate.secret_key,
        &candidate.api_key,
    ) {
        (Some(name), None, None, None, None) => {
            V3ProviderAuthSecretHandle::Environment(name.clone())
        }
        (None, Some(path), None, None, None) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        (None, None, Some(path), Some(key), None) => V3ProviderAuthSecretHandle::SecretFile {
            path: path.clone(),
            key: key.clone(),
        },
        (None, None, None, None, Some(value)) => V3ProviderAuthSecretHandle::ApiKey(value.clone()),
        _ => {
            return Err(build_v3_error_01_source_raised_internal(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Provider12ResponsesWirePayload",
                "provider_auth_handle_missing",
                format!(
                    "provider {} selected without auth handle",
                    candidate.provider_id
                ),
                V3InternalErrorCode::V3Provider12ResponsesWirePayload,
            ))
        }
    };
    build_v3_provider_12_responses_wire_payload(
        policy.request_id.clone(),
        V3ResponsesProviderTarget {
            provider_id: candidate.provider_id.clone(),
            provider_type: candidate.provider_type.clone(),
            base_url: candidate.base_url.clone(),
            canonical_model_id: candidate.model_id.clone(),
            wire_model: candidate.wire_model.clone(),
            compatibility_profile: candidate.compatibility_profile.clone(),
            sse_first_frame_timeout_ms: candidate.sse_first_frame_timeout_ms,
            auth: V3ProviderAuthHandle {
                alias: candidate.auth_alias.clone(),
                secret,
            },
            responses_transport: candidate.responses_transport,
            websocket_v2_url: candidate.websocket_v2_url.clone(),
            provider_request_cleanup: candidate.provider_request_cleanup.clone(),
            request_timeout_ms: candidate.request_timeout_ms,
            initial_concurrency_budget: candidate.initial_concurrency_budget,
        },
        wire_body,
    )
    .map_err(provider_error_source("V3Provider12ResponsesWirePayload"))
}

pub(crate) fn chat_direct_provider_transport_hook(
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, V3Error01SourceRaised> {
    crate::hub_v1::build_v3_provider_transport_request_for_protocol(
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        wire,
    )
    .map_err(|error| {
        build_v3_error_01_source_raised_internal(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Transport13ResponsesHttpRequest",
            "chat_provider_transport_error",
            error,
            internal_error_code_for_stage("V3Transport13ResponsesHttpRequest"),
        )
    })
}

pub(crate) fn build_v3_provider_error_source(
    stage: &'static str,
    error: V3ProviderError,
) -> V3Error01SourceRaised {
    let message = error.to_string();
    match error {
        V3ProviderError::InvalidWireBody { .. }
        | V3ProviderError::InvalidStreamIntent { .. }
        | V3ProviderError::InvalidDataImage { .. } => build_v3_error_01_source_raised(
            V3ErrorSourceKind::InvalidRequest,
            stage,
            "invalid_provider_request_payload",
            message,
        ),
        V3ProviderError::ProviderModelBindingMismatch { .. } => {
            build_v3_error_01_source_raised_internal(
                V3ErrorSourceKind::RuntimeFailure,
                stage,
                "provider_model_binding_mismatch",
                message,
                internal_error_code_for_stage(stage),
            )
        }
        V3ProviderError::ControlFieldInWireBody { .. } => build_v3_error_01_source_raised_internal(
            V3ErrorSourceKind::RuntimeFailure,
            stage,
            "provider_wire_control_field_leaked",
            message,
            internal_error_code_for_stage(stage),
        ),
        V3ProviderError::InvalidBaseUrl { .. }
        | V3ProviderError::MissingAuthSecret { .. }
        | V3ProviderError::AuthSecretRead { .. } => build_v3_error_01_source_raised_internal(
            V3ErrorSourceKind::RuntimeFailure,
            stage,
            "provider_local_runtime_error",
            message,
            internal_error_code_for_stage(stage),
        ),
        V3ProviderError::ClientDisconnect { .. } => build_v3_error_01_source_raised(
            V3ErrorSourceKind::ClientDisconnect,
            stage,
            "client_disconnect",
            message,
        ),
        error => {
            let external_error = external_link_for_provider_error(&error);
            let code = source_code_for_external_provider_error(&error);
            build_v3_error_01_source_raised_external(
                V3ErrorSourceKind::ProviderFailure,
                stage,
                code,
                message,
                external_error,
            )
        }
    }
}

fn source_code_for_external_provider_error(error: &V3ProviderError) -> String {
    match error {
        V3ProviderError::HttpStatus { response } => format!("provider_http_{}", response.status),
        V3ProviderError::Transport { .. } | V3ProviderError::WebSocketTransport { .. } => {
            "provider_transport_error".to_string()
        }
        V3ProviderError::WebSocketProtocol { .. } => {
            "provider_websocket_protocol_error".to_string()
        }
        V3ProviderError::WebSocketProviderEvent { code, status, .. } => code
            .clone()
            .or_else(|| status.map(|value| format!("provider_http_{value}")))
            .unwrap_or_else(|| "provider_websocket_event_error".to_string()),
        V3ProviderError::UnexpectedContentType { .. } => {
            "provider_content_type_unexpected".to_string()
        }
        V3ProviderError::ResponseBody { .. } => "provider_response_body_error".to_string(),
        V3ProviderError::MalformedSse { .. } => "provider_malformed_sse".to_string(),
        V3ProviderError::InvalidWireBody { .. }
        | V3ProviderError::ProviderModelBindingMismatch { .. }
        | V3ProviderError::ControlFieldInWireBody { .. }
        | V3ProviderError::InvalidStreamIntent { .. }
        | V3ProviderError::InvalidDataImage { .. }
        | V3ProviderError::InvalidBaseUrl { .. }
        | V3ProviderError::MissingAuthSecret { .. }
        | V3ProviderError::AuthSecretRead { .. }
        | V3ProviderError::NamespaceToolFlattenFailed { .. }
        | V3ProviderError::FunctionToolShapeFailed { .. }
        | V3ProviderError::ClientDisconnect { .. } => "provider_responses_error".to_string(),
    }
}

fn internal_error_code_for_stage(stage: &str) -> V3InternalErrorCode {
    match stage {
        "V3Provider12ResponsesWirePayload" => V3InternalErrorCode::V3Provider12ResponsesWirePayload,
        "V3Transport13ResponsesHttpRequest" => {
            V3InternalErrorCode::V3Transport13ResponsesHttpRequest
        }
        "V3ProviderResp14Raw" => V3InternalErrorCode::V3ProviderResp14Raw,
        _ => V3InternalErrorCode::V3StaticHookRegistry,
    }
}

fn external_link_for_provider_error(error: &V3ProviderError) -> V3ExternalErrorLink {
    match error {
        V3ProviderError::HttpStatus { response } => V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(response.status),
            code: Some(format!("HTTP_{}", response.status)),
            provider_id: Some(response.provider_id.clone()),
            upstream_request_id: upstream_request_id_from_headers(&response.headers),
            message: Some(format!("provider returned HTTP {}", response.status)),
        },
        V3ProviderError::Transport {
            provider_id,
            reason,
            ..
        }
        | V3ProviderError::WebSocketTransport {
            provider_id,
            reason,
            ..
        } => V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Transport,
            status: None,
            code: Some("TRANSPORT_ERROR".to_string()),
            provider_id: Some(provider_id.clone()),
            upstream_request_id: None,
            message: Some(reason.clone()),
        },
        V3ProviderError::WebSocketProtocol {
            provider_id,
            reason,
            ..
        } => V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: None,
            code: Some("WEBSOCKET_PROTOCOL_ERROR".to_string()),
            provider_id: Some(provider_id.clone()),
            upstream_request_id: None,
            message: Some(reason.clone()),
        },
        V3ProviderError::WebSocketProviderEvent {
            provider_id,
            status,
            code,
            message,
            ..
        } => V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: *status,
            code: code
                .clone()
                .or_else(|| status.map(|value| format!("HTTP_{value}"))),
            provider_id: Some(provider_id.clone()),
            upstream_request_id: None,
            message: Some(message.clone()),
        },
        V3ProviderError::UnexpectedContentType {
            provider_id,
            expected,
            content_type,
            ..
        } => V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: None,
            code: Some("UNEXPECTED_CONTENT_TYPE".to_string()),
            provider_id: Some(provider_id.clone()),
            upstream_request_id: None,
            message: Some(format!(
                "expected {expected} content-type, got {:?}",
                content_type
            )),
        },
        V3ProviderError::ResponseBody {
            provider_id,
            reason,
            ..
        } => V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: None,
            code: Some("PROVIDER_RESPONSE_BODY".to_string()),
            provider_id: Some(provider_id.clone()),
            upstream_request_id: None,
            message: Some(reason.clone()),
        },
        V3ProviderError::MalformedSse {
            provider_id,
            reason,
            ..
        } => V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: None,
            code: Some("PROVIDER_MALFORMED_SSE".to_string()),
            provider_id: Some(provider_id.clone()),
            upstream_request_id: None,
            message: Some(reason.clone()),
        },
        V3ProviderError::InvalidWireBody { .. }
        | V3ProviderError::ProviderModelBindingMismatch { .. }
        | V3ProviderError::ControlFieldInWireBody { .. }
        | V3ProviderError::InvalidStreamIntent { .. }
        | V3ProviderError::InvalidDataImage { .. }
        | V3ProviderError::InvalidBaseUrl { .. }
        | V3ProviderError::MissingAuthSecret { .. }
        | V3ProviderError::AuthSecretRead { .. }
        | V3ProviderError::NamespaceToolFlattenFailed { .. }
        | V3ProviderError::FunctionToolShapeFailed { .. }
        | V3ProviderError::ClientDisconnect { .. } => V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: None,
            code: Some("PROVIDER_RESPONSES_ERROR".to_string()),
            provider_id: None,
            upstream_request_id: None,
            message: Some(error.to_string()),
        },
    }
}

fn upstream_request_id_from_headers(
    headers: &[routecodex_v3_provider_responses::V3ProviderResponseHeader],
) -> Option<String> {
    headers
        .iter()
        .find(|header| {
            matches!(
                header.name.to_ascii_lowercase().as_str(),
                "x-request-id" | "request-id" | "openai-request-id" | "x-openai-request-id"
            )
        })
        .and_then(|header| std::str::from_utf8(&header.value).ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn responses_direct_error_hook(
    source: V3Error01SourceRaised,
    scope: V3ErrorActionScope,
    candidates_remaining: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
    recovery: Option<V3Error05RecoveryAdmissionWitness>,
) -> V3Error05ExecutionDecision {
    V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source,
            action_scope: scope,
            candidates_remaining,
            source_status: None,
        },
        default_pool_available,
        same_provider_retry_available,
        recovery,
    )
}

#[cfg(test)]
#[path = "hooks_tests.rs"]
mod tests;
#[test]
fn relay_sse_runtime_does_not_own_toolreason_parser() {
    let source = include_str!("hub_v1/openai_chat_relay_runtime.rs");
    assert!(!source.contains("map_v3_toolreason_stream_event_at_resp03"));
    let sse_source = include_str!("hub_v1/openai_chat_relay_runtime_sse.rs");
    assert!(!sse_source.contains("map_v3_toolreason_stream_event_at_resp03"));
}
