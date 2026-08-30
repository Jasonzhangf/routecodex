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
mod tests {
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
                    tool_thinking_turn_context: crate::hub_v1::V3ToolThinkingTurnContext::disabled(
                    ),
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
        let source = provider_error_source("V3Transport13ResponsesHttpRequest")(
            V3ProviderError::HttpStatus {
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
            },
        );

        assert_eq!(source.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert!(source.internal_error.is_none());
        let external = source.external_error.expect("external provider link");
        assert_eq!(external.status, Some(429));
        assert_eq!(external.provider_id.as_deref(), Some("asxs-grok"));
        assert_eq!(external.code.as_deref(), Some("HTTP_429"));
    }

    #[test]
    fn provider_transport_source_is_external_transport_identity_without_internal_code() {
        let source = provider_error_source("V3Transport13ResponsesHttpRequest")(
            V3ProviderError::Transport {
                request_id: "req".to_string(),
                provider_id: "asxs-grok".to_string(),
                reason: "error sending request for url".to_string(),
            },
        );

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
}
#[test]
fn relay_sse_runtime_does_not_own_toolreason_parser() {
    let source = include_str!("hub_v1/openai_chat_relay_runtime.rs");
    assert!(!source.contains("map_v3_toolreason_stream_event_at_resp03"));
    let sse_source = include_str!("hub_v1/openai_chat_relay_runtime_sse.rs");
    assert!(!sse_source.contains("map_v3_toolreason_stream_event_at_resp03"));
}
