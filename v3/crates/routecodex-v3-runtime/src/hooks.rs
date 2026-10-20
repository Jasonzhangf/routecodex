use crate::direct_response_hooks::{
    normalize_v3_direct_complete_json_response, rewrite_v3_direct_complete_response_attempt,
    V3DirectResponseCompatContext, V3DirectResponseHookFailure,
};
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
use crate::operation_runner::V3Err01SourceInput;
use crate::projection_drop_log::V3ProjectionDropContext;
use crate::provider_failure_runtime_policy::raise_v3_source_via_err01;
use crate::shared::{
    project_provider_raw_to_client_payload_for_complete_response_hooks,
    project_provider_raw_to_client_payload_with_plan_and_projection_and_observation_context,
    V3DirectSourceError, V3DirectSourceResult, V3ProviderAttemptBody, V3ProviderResponseProjection,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3Error05ExecutionDecision,
    V3Error05RecoveryAdmissionWitness, V3ErrorActionScope, V3ErrorSourceKind, V3ExternalErrorKind,
    V3ExternalErrorLink, V3InternalErrorCode,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    v3_provider_auth_secret_handle_from_declaration_fields, V3Provider12ResponsesWirePayload,
    V3ProviderAuthHandle, V3ProviderError, V3ProviderResp14Raw, V3ResponsesProviderTarget,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_target::V3Target10ConcreteProviderSelected;
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;

fn apply_v3_direct_request_key_hook_with_catalog(
    body: Value,
    protocol: V3DirectRequestProtocol,
    catalog: &V3DirectRequestKeyHookCatalog,
) -> V3DirectSourceResult<Value> {
    let mut catalog = *catalog;
    apply_v3_direct_request_key_hook(body, protocol, &mut catalog).map_err(|error| {
        raise_v3_source_via_err01(
            V3ErrorSourceKind::RuntimeFailure,
            "V3DirectRequestKeyHook",
            "direct_request_key_hook_failed",
            error,
            V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
        )
        .map(|(_, source)| source)
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
) -> V3DirectSourceResult<V3Provider12ResponsesWirePayload>;
type ProviderTransportHook =
    fn(V3Provider12ResponsesWirePayload) -> V3DirectSourceResult<V3Transport13ResponsesHttpRequest>;
type ResponseProjectionFuture =
    Pin<Box<dyn Future<Output = V3DirectSourceResult<V3ProviderResponseProjection>> + Send>>;
type ContextualResponseProjectionHook =
    fn(V3ProviderResp14Raw, V3DirectResponseCompatContext) -> ResponseProjectionFuture;
type CompleteResponseSseHook =
    fn(
        &[Vec<u8>],
        &crate::direct_response_hooks::V3DirectDsmlContext,
    ) -> Result<Option<(Vec<Vec<u8>>, usize)>, V3DirectResponseHookFailure>;
type CompleteResponseJsonHook = fn(
    &mut Value,
    &crate::direct_response_hooks::V3DirectDsmlContext,
) -> Result<(), V3DirectResponseHookFailure>;
type ErrorHook = fn(
    V3Error01SourceRaised,
    V3ErrorActionScope,
    usize,
    bool,
    bool,
    Option<V3Error05RecoveryAdmissionWitness>,
) -> Result<
    (Value, V3Error05ExecutionDecision),
    crate::operation_runner::OperationRunnerError,
>;

#[derive(Clone, Copy)]
pub struct V3HookRegistry {
    hooks: &'static [V3RegisteredHook],
    route: RouteHook,
    request_projection: RequestProjectionHook,
    request_key_catalog: V3DirectRequestKeyHookCatalog,
    direct_sse_typed_hooks: V3DirectSseTypedHookCatalog,
    provider_transport: ProviderTransportHook,
    contextual_response_projection: ContextualResponseProjectionHook,
    complete_response_json: CompleteResponseJsonHook,
    complete_response_sse: CompleteResponseSseHook,
    error: ErrorHook,
}

#[derive(Debug)]
pub(crate) enum V3DirectCompleteResponseError {
    Normalization(V3DirectResponseHookFailure),
    Store(crate::execution_control::V3AttemptStoreError),
}

impl From<crate::execution_control::V3AttemptStoreError> for V3DirectCompleteResponseError {
    fn from(error: crate::execution_control::V3AttemptStoreError) -> Self {
        Self::Store(error)
    }
}

pub(crate) fn direct_complete_response_error_source(
    error: V3DirectCompleteResponseError,
) -> V3DirectSourceError {
    match error {
        V3DirectCompleteResponseError::Normalization(failure) => {
            direct_complete_response_hook_failure_source(failure)
        }
        V3DirectCompleteResponseError::Store(error) => crate::shared::direct_plain_error(
            V3ErrorSourceKind::RuntimeFailure,
            "V3DirectResp14ProviderProjectionPrepared",
            "direct_response_hook_store",
            error.to_string(),
        ),
    }
}

pub(crate) fn direct_complete_response_hook_failure_source(
    failure: V3DirectResponseHookFailure,
) -> V3DirectSourceError {
    match failure {
        V3DirectResponseHookFailure::UnharvestableToolMarkup => {
            crate::shared::direct_internal_error(
                V3ErrorSourceKind::RuntimeFailure,
                "V3DirectResp14ProviderProjectionPrepared",
                "direct_tool_markup_unharvestable",
                "direct response contains tool markup that cannot be harvested into a native call",
                V3InternalErrorCode::V3DirectResp14UnharvestableToolMarkup,
            )
        }
    }
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
    pub(crate) fn project_complete_direct_json(
        &self,
        payload: &mut Value,
        context: &crate::direct_response_hooks::V3DirectDsmlContext,
    ) -> Result<(), V3DirectCompleteResponseError> {
        (self.complete_response_json)(payload, context)
            .map_err(V3DirectCompleteResponseError::Normalization)
    }

    pub(crate) fn project_complete_direct_sse(
        &self,
        builder: &mut crate::execution_control::V3CommittedClientSseBuilder,
        context: &crate::direct_response_hooks::V3DirectDsmlContext,
    ) -> Result<(), V3DirectCompleteResponseError> {
        builder.rewrite_complete_attempt(|frames| {
            (self.complete_response_sse)(frames, context)
                .map_err(V3DirectCompleteResponseError::Normalization)
        })
    }
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
    ) -> V3DirectSourceResult<V3Provider12ResponsesWirePayload> {
        (self.request_projection)(policy, &self.request_key_catalog)
    }

    /// 携带 stage-3 丢弃上下文（请求身份 + 客户端原始 payload + 丢弃日志）的投影入口。
    pub(crate) fn run_request_projection_with_drop_context(
        &self,
        policy: &V3ResponsesDirect11Policy,
        drop_context: &V3ProjectionDropContext,
    ) -> V3DirectSourceResult<V3Provider12ResponsesWirePayload> {
        responses_direct_request_projection_hook_with_key_catalog_and_drop_context(
            policy,
            &self.request_key_catalog,
            drop_context,
        )
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
    ) -> V3DirectSourceResult<V3Transport13ResponsesHttpRequest> {
        (self.provider_transport)(wire)
    }

    pub async fn run_response_projection_with_context(
        &self,
        raw: V3ProviderResp14Raw,
        context: V3DirectResponseCompatContext,
    ) -> V3DirectSourceResult<V3ProviderResponseProjection> {
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
    ) -> Result<(Value, V3Error05ExecutionDecision), crate::operation_runner::OperationRunnerError>
    {
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
            hook_id: "ResponsesDirectSerializedToolsHook",
            hook_point: V3HookPoint::ResponseProjection,
            input_node: "V3DirectResp14ProviderProjectionPrepared",
            output_node: "V3DirectResp14ProviderProjectionPrepared",
        },
        V3RegisteredHook {
            hook_id: "ResponsesDirectErrorHook",
            hook_point: V3HookPoint::Error,
            input_node: "V3Error01SourceRaised",
            output_node: "V3Error05ExecutionDecision",
        },
    ];
    // Toolreason is retired from the production client SSE path. Tests may
    // still register the helper explicitly, but runtime never intercepts it.
    let direct_sse_typed_hooks = V3DirectSseTypedHookCatalog::new();
    V3HookRegistry {
        hooks: HOOKS,
        route: responses_direct_route_hook,
        request_projection: responses_direct_request_projection_hook_with_key_catalog,
        request_key_catalog: *request_key_catalog,
        direct_sse_typed_hooks,
        provider_transport: responses_direct_provider_transport_hook,
        contextual_response_projection: responses_direct_response_projection_hook_with_context,
        complete_response_json: normalize_v3_direct_complete_json_response,
        complete_response_sse: rewrite_v3_direct_complete_response_attempt,
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
) -> V3DirectSourceResult<V3Provider12ResponsesWirePayload> {
    let catalog = default_v3_direct_request_key_hook_catalog();
    responses_direct_request_projection_hook_with_key_catalog(policy, &catalog)
}

pub(crate) fn responses_direct_request_projection_hook_with_key_catalog(
    policy: &V3ResponsesDirect11Policy,
    key_catalog: &V3DirectRequestKeyHookCatalog,
) -> V3DirectSourceResult<V3Provider12ResponsesWirePayload> {
    responses_direct_request_projection_hook_with_key_catalog_and_drop_context(
        policy,
        key_catalog,
        &V3ProjectionDropContext::disabled(),
    )
}

pub(crate) fn responses_direct_request_projection_hook_with_key_catalog_and_drop_context(
    policy: &V3ResponsesDirect11Policy,
    key_catalog: &V3DirectRequestKeyHookCatalog,
    drop_context: &V3ProjectionDropContext,
) -> V3DirectSourceResult<V3Provider12ResponsesWirePayload> {
    let candidate = &policy.target.candidate;
    let provider_protocol = crate::hub_v1::provider_wire_protocol_for_selected_candidate(candidate)
        .map_err(|error| {
            raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ResponsesDirect11Policy",
                "responses_provider_protocol_resolution_failed",
                error,
                V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
            )
            .map(|(_, source)| source)
        })?;
    // A Responses provider entry must always use the Responses wire protocol,
    // even if a forwarder/compat target initially resolves it to OpenAI Chat.
    // cc-sol returns HTTP 400 for Chat-shaped messages on /v1/responses.
    let provider_protocol = if candidate.provider_type.trim() == "responses" {
        crate::hub_v1::V3HubProviderWireProtocol::Responses
    } else {
        provider_protocol
    };
    let request_body = crate::selected_provider_model_binding::bind_v3_selected_provider_model(
        policy.request_body.clone(),
        candidate,
    )
    .map(crate::selected_provider_model_binding::V3SelectedProviderModelBinding::into_payload)
    .map_err(|reason| {
        raise_v3_source_via_err01(
            V3ErrorSourceKind::RuntimeFailure,
            "V3ResponsesDirect11Policy",
            "selected_provider_model_binding_failed",
            reason,
            V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
        )
        .map(|(_, source)| source)
    })?;
    let mut request_body = match provider_protocol {
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat => {
            let (wire_body, mut projection_drops) =
                crate::hub_v1::build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(
                    &request_body,
                )
                .and_then(|canonical| {
                    crate::hub_v1::build_v3_openai_chat_standard_request_from_chat_canonical_recording(
                        &canonical,
                        drop_context,
                    )
                })
                .map_err(|error| {
                    raise_v3_source_via_err01(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3ResponsesDirect11Policy",
                        "responses_openai_chat_wire_projection_failed",
                        error,
                        V3Err01SourceInput::Internal(
                            V3InternalErrorCode::V3Provider12ResponsesWirePayload,
                        ),
                    )
                    .map(|(_, source)| source)
                })?;
            drop_context.restamp_and_emit(&mut projection_drops);
            wire_body
        }
        crate::hub_v1::V3HubProviderWireProtocol::Anthropic => {
            return Err(raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ResponsesDirect11Policy",
                "responses_direct_cross_protocol_projection_unsupported",
                "Responses direct does not have a response-side Anthropic projection contract",
                V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
            )
            .map(|(_, source)| source));
        }
        crate::hub_v1::V3HubProviderWireProtocol::Responses
            if request_body.get("messages").is_some() =>
        {
            let (wire_body, mut projection_drops) =
                crate::hub_v1::build_v3_openai_responses_standard_request_for_selected_target_with_drops(
                    &request_body,
                    candidate
                        .model_capabilities
                        .iter()
                        .any(|capability| capability == "web_search"),
                )
                .map_err(|error| {
                    raise_v3_source_via_err01(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3ResponsesDirect11Policy",
                        "responses_provider_request_projection_failed",
                        error,
                        V3Err01SourceInput::Internal(
                            V3InternalErrorCode::V3Provider12ResponsesWirePayload,
                        ),
                    )
                    .map(|(_, source)| source)
                })?;
            drop_context.restamp_and_emit(&mut projection_drops);
            wire_body
        }
        _ => request_body,
    };
    if provider_protocol == crate::hub_v1::V3HubProviderWireProtocol::Responses {
        crate::hub_v1::normalize_v3_openai_responses_provider_request_payload(&mut request_body)
            .map_err(|error| {
                raise_v3_source_via_err01(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3ResponsesDirect11Policy",
                    "responses_provider_request_projection_failed",
                    error,
                    V3Err01SourceInput::Internal(
                        V3InternalErrorCode::V3Provider12ResponsesWirePayload,
                    ),
                )
                .map(|(_, source)| source)
            })?;
        crate::hub_v1::project_openai_responses_hosted_web_search_for_selected_target(
            &mut request_body,
            candidate
                .model_capabilities
                .iter()
                .any(|capability| capability == "web_search"),
        );
    }
    let direct_request_protocol = match provider_protocol {
        crate::hub_v1::V3HubProviderWireProtocol::Responses => V3DirectRequestProtocol::Responses,
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat => V3DirectRequestProtocol::OpenAiChat,
        crate::hub_v1::V3HubProviderWireProtocol::Anthropic => {
            return Err(raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ResponsesDirect11Policy",
                "responses_direct_request_key_protocol_unsupported",
                "Responses direct request key hooks do not support Anthropic projection",
                V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
            )
            .map(|(_, source)| source));
        }
        _ => {
            return Err(raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ResponsesDirect11Policy",
                "responses_direct_request_key_protocol_unsupported",
                "Responses direct request key hooks require a registered provider protocol",
                V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
            )
            .map(|(_, source)| source));
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
    let namespace_registry =
        provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry::from_request(
            &request_body,
            &crate::hub_v1::provider_protocol_compat_id(provider_protocol),
        )
        .and_then(|registry| {
            registry.project_request(
                &mut request_body,
                &crate::hub_v1::provider_protocol_compat_id(provider_protocol),
            )?;
            Ok(registry)
        })
        .map_err(|error| {
            raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ResponsesDirect11Policy",
                "namespace_projection_failed",
                error,
                V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
            )
            .map(|(_, source)| source)
        })?;
    let (compat_body, custom_tool_function_binding) =
        crate::hub_v1::apply_v3_provider_req_compat_to_provider_payload(
            request_body,
            candidate,
            provider_protocol,
            &profile,
        )
        .map_err(|error| {
            raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ResponsesDirect11Policy",
                "responses_direct_provider_compat_failed",
                format!("{}", error),
                V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
            )
            .map(|(_, source)| source)
        })?;
    request_body = compat_body;
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
    routecodex_v3_provider_responses::wire::build_v3_provider_12_responses_wire_payload_with_registry(
        policy.request_id.clone(),
        V3ResponsesProviderTarget {
            provider_id: candidate.provider_id.clone(),
            interface_id: candidate.interface_id.clone(),
            provider_type: candidate.provider_type.clone(),
            base_url: candidate.base_url.clone(),
            canonical_model_id: candidate.model_id.clone(),
            wire_model: candidate.wire_model.clone(),
            compatibility_profile: candidate.compatibility_profile.clone(),
            headers: candidate.headers.clone(),
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
            concurrency_acquire_timeout_ms: candidate.concurrency_acquire_timeout_ms,
        },
        request_body,
        namespace_registry,
    )
    .map(|wire| wire.with_custom_tool_function_binding(custom_tool_function_binding))
    .map_err(provider_error_source("V3Provider12ResponsesWirePayload"))
}

pub(crate) fn responses_direct_provider_transport_hook(
    wire: V3Provider12ResponsesWirePayload,
) -> V3DirectSourceResult<V3Transport13ResponsesHttpRequest> {
    let provider_protocol = crate::hub_v1::provider_wire_protocol_for_provider_type(
        wire.target().provider_id.as_str(),
        wire.target().provider_type.as_str(),
    )
    .map_err(|error| {
        raise_v3_source_via_err01(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Transport13ResponsesHttpRequest",
            "responses_provider_protocol_resolution_failed",
            error,
            V3Err01SourceInput::Internal(V3InternalErrorCode::V3Transport13ResponsesHttpRequest),
        )
        .map(|(_, source)| source)
    })?;
    crate::hub_v1::build_v3_provider_transport_request_for_protocol(provider_protocol, wire)
        .map_err(|error| {
            raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Transport13ResponsesHttpRequest",
                "responses_provider_transport_error",
                error,
                V3Err01SourceInput::Internal(
                    V3InternalErrorCode::V3Transport13ResponsesHttpRequest,
                ),
            )
            .map(|(_, source)| source)
        })
}

pub(crate) fn responses_direct_response_projection_hook_with_context(
    raw: V3ProviderResp14Raw,
    context: V3DirectResponseCompatContext,
) -> ResponseProjectionFuture {
    Box::pin(async move {
        let request_id = raw.request_id().to_owned();
        let plan = context.compile_plan().map_err(|error| {
            raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3DirectResp14ProviderCompat",
                "direct_response_compat_plan_compile_failed",
                error,
                V3Err01SourceInput::Internal(
                    V3InternalErrorCode::V3DirectResp14ProviderProjectionPrepared,
                ),
            )
            .map(|(_, source)| source)
        })?;
        let mut projection = project_provider_raw_to_client_payload_for_complete_response_hooks(
            raw,
            &plan,
            context.tool_thinking_enabled,
            context.toolreason_client_projection,
            context.toolreason_observation_session_id.as_deref(),
        )
        .await?;
        if let V3ProviderAttemptBody::Json(payload) = &mut projection.attempt_payload.body {
            crate::hub_v1::restore_v3_responses_namespace_identities(
                payload,
                &context.namespace_tool_identities,
            );
        }
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
            raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                "V3DirectResp14ProviderCompat",
                "direct_response_compat_plan_compile_failed",
                error,
                V3Err01SourceInput::Internal(
                    V3InternalErrorCode::V3DirectResp14ProviderProjectionPrepared,
                ),
            )
            .map(|(_, source)| source)
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
) -> impl FnOnce(V3ProviderError) -> crate::shared::V3DirectSourceError {
    move |error| build_v3_provider_error_source(stage, error)
}

pub(crate) fn chat_direct_request_projection_hook(
    policy: &V3ChatDirect11Policy,
) -> V3DirectSourceResult<V3Provider12ResponsesWirePayload> {
    let catalog = default_v3_direct_request_key_hook_catalog();
    chat_direct_request_projection_hook_with_key_catalog(policy, &catalog)
}

pub(crate) fn chat_direct_request_projection_hook_with_key_catalog(
    policy: &V3ChatDirect11Policy,
    key_catalog: &V3DirectRequestKeyHookCatalog,
) -> V3DirectSourceResult<V3Provider12ResponsesWirePayload> {
    chat_direct_request_projection_hook_with_key_catalog_and_drop_context(
        policy,
        key_catalog,
        &V3ProjectionDropContext::disabled(),
    )
}

pub(crate) fn chat_direct_request_projection_hook_with_key_catalog_and_drop_context(
    policy: &V3ChatDirect11Policy,
    key_catalog: &V3DirectRequestKeyHookCatalog,
    drop_context: &V3ProjectionDropContext,
) -> V3DirectSourceResult<V3Provider12ResponsesWirePayload> {
    let candidate = &policy.target.candidate;
    let request_body = crate::selected_provider_model_binding::bind_v3_selected_provider_model(
        policy.request_body.clone(),
        candidate,
    )
    .map(crate::selected_provider_model_binding::V3SelectedProviderModelBinding::into_payload)
    .map_err(|reason| {
        raise_v3_source_via_err01(
            V3ErrorSourceKind::RuntimeFailure,
            "V3ChatDirect11Policy",
            "selected_provider_model_binding_failed",
            reason,
            V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
        )
        .map(|(_, source)| source)
    })?;
    let hosted_web_search_declared = request_body
        .get("tools")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|tools| {
            tools.iter().any(|tool| {
                matches!(
                    tool.get("type").and_then(serde_json::Value::as_str),
                    Some("web_search" | "web_search_preview" | "web_search_20250305")
                )
            })
        });
    let projected = if hosted_web_search_declared {
        crate::hub_v1::build_v3_openai_chat_standard_request_for_selected_web_search_mode_recording(
            &request_body,
            candidate.web_search_execution_mode,
            candidate
                .model_capabilities
                .iter()
                .any(|capability| capability == "web_search"),
            drop_context,
        )
    } else {
        crate::hub_v1::build_v3_openai_chat_standard_request_from_chat_canonical_recording(
            &request_body,
            drop_context,
        )
    };
    let (mut wire_body, mut projection_drops) = projected.map_err(|error| {
        raise_v3_source_via_err01(
            V3ErrorSourceKind::RuntimeFailure,
            "V3ChatDirect11Policy",
            "chat_wire_projection_failed",
            error,
            V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
        )
        .map(|(_, source)| source)
    })?;
    drop_context.restamp_and_emit(&mut projection_drops);
    wire_body = apply_v3_direct_request_key_hook_with_catalog(
        wire_body,
        V3DirectRequestProtocol::OpenAiChat,
        key_catalog,
    )?;
    // Provider-private request compat (chat:*) has exactly one owner: the
    // provider request compat stage. The Responses Direct hook already reaches
    // it; the chat Direct hook must reach the same owner or chat-wire providers
    // silently lose their declared request adjustments (for example
    // `chat:glm-unsupported-prompt-cache-key-verbosity` dropping
    // prompt_cache_key/verbosity, and `chat:glm` request compat). This is not a
    // second implementation; the owner is invoked once here.
    let profile = crate::hub_v1::V3ProviderCompatProfileId::from_config(
        candidate.compatibility_profile.as_deref(),
    );
    let (compat_body, _) = crate::hub_v1::apply_v3_provider_req_compat_to_provider_payload(
        wire_body,
        candidate,
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        &profile,
    )
    .map_err(|error| {
        raise_v3_source_via_err01(
            V3ErrorSourceKind::RuntimeFailure,
            "V3ChatDirect11Policy",
            "chat_direct_provider_compat_failed",
            error.to_string(),
            V3Err01SourceInput::Internal(V3InternalErrorCode::V3Provider12ResponsesWirePayload),
        )
        .map(|(_, source)| source)
    })?;
    wire_body = compat_body;
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
    build_v3_provider_12_responses_wire_payload(
        policy.request_id.clone(),
        V3ResponsesProviderTarget {
            provider_id: candidate.provider_id.clone(),
            interface_id: candidate.interface_id.clone(),
            provider_type: candidate.provider_type.clone(),
            base_url: candidate.base_url.clone(),
            canonical_model_id: candidate.model_id.clone(),
            wire_model: candidate.wire_model.clone(),
            compatibility_profile: candidate.compatibility_profile.clone(),
            headers: candidate.headers.clone(),
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
            concurrency_acquire_timeout_ms: candidate.concurrency_acquire_timeout_ms,
        },
        wire_body,
    )
    .map_err(provider_error_source("V3Provider12ResponsesWirePayload"))
}

pub(crate) fn chat_direct_provider_transport_hook(
    wire: V3Provider12ResponsesWirePayload,
) -> V3DirectSourceResult<V3Transport13ResponsesHttpRequest> {
    crate::hub_v1::build_v3_provider_transport_request_for_protocol(
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        wire,
    )
    .map_err(|error| {
        raise_v3_source_via_err01(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Transport13ResponsesHttpRequest",
            "chat_provider_transport_error",
            error,
            V3Err01SourceInput::Internal(internal_error_code_for_stage(
                "V3Transport13ResponsesHttpRequest",
            )),
        )
        .map(|(_, source)| source)
    })
}

pub(crate) fn build_v3_provider_error_source(
    stage: &'static str,
    error: V3ProviderError,
) -> crate::shared::V3DirectSourceError {
    let message = error.to_string();
    match error {
        V3ProviderError::InvalidWireBody { .. }
        | V3ProviderError::InvalidStreamIntent { .. }
        | V3ProviderError::InvalidDataImage { .. }
        | V3ProviderError::NamespaceToolFlattenFailed { .. }
        | V3ProviderError::FunctionToolShapeFailed { .. } => crate::shared::direct_plain_error(
            V3ErrorSourceKind::InvalidRequest,
            stage,
            "invalid_provider_request_payload",
            message,
        ),
        V3ProviderError::ProviderModelBindingMismatch { .. } => crate::shared::direct_source_error(
            V3ErrorSourceKind::RuntimeFailure,
            stage,
            "provider_model_binding_mismatch",
            message,
            crate::operation_runner::V3Err01SourceInput::Internal(internal_error_code_for_stage(
                stage,
            )),
        ),
        V3ProviderError::InvalidBaseUrl { .. }
        | V3ProviderError::MissingAuthSecret { .. }
        | V3ProviderError::AuthSecretRead { .. }
        | V3ProviderError::OAuthCredential { .. } => crate::shared::direct_source_error(
            V3ErrorSourceKind::RuntimeFailure,
            stage,
            "provider_local_runtime_error",
            message,
            crate::operation_runner::V3Err01SourceInput::Internal(internal_error_code_for_stage(
                stage,
            )),
        ),
        V3ProviderError::InternalTransport { lane, .. } => {
            let stage = match lane {
                routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Request => {
                    "V3Transport13ResponsesHttpRequest"
                }
                routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Response => {
                    "V3ProviderResp14Raw"
                }
            };
            crate::shared::direct_source_error(
                V3ErrorSourceKind::RuntimeFailure,
                stage,
                "provider_internal_transport_error",
                message,
                crate::operation_runner::V3Err01SourceInput::Internal(
                    internal_error_code_for_stage(stage),
                ),
            )
        }
        V3ProviderError::ConcurrencyBusy { .. } => crate::shared::direct_plain_error(
            V3ErrorSourceKind::TargetPoolExhausted,
            stage,
            "provider_concurrency_busy",
            message,
        ),
        V3ProviderError::ClientDisconnect { .. } => crate::shared::direct_plain_error(
            V3ErrorSourceKind::ClientDisconnect,
            stage,
            "client_disconnect",
            message,
        ),
        error => {
            let external_error = external_link_for_provider_error(&error);
            let code = source_code_for_external_provider_error(&error);
            crate::shared::direct_external_error(
                V3ErrorSourceKind::ProviderFailure,
                stage,
                code,
                message,
                external_error,
            )
        }
    }
}

pub(crate) fn source_code_for_external_provider_error(error: &V3ProviderError) -> String {
    match error {
        V3ProviderError::HttpStatus { response } => format!("provider_http_{}", response.status),
        V3ProviderError::Transport { .. }
        | V3ProviderError::WebSocketTransport { .. }
        | V3ProviderError::ResponseBodyUnreadable { .. } => "provider_transport_error".to_string(),
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
        | V3ProviderError::InvalidStreamIntent { .. }
        | V3ProviderError::InvalidDataImage { .. }
        | V3ProviderError::InternalTransport { .. }
        | V3ProviderError::InvalidBaseUrl { .. }
        | V3ProviderError::MissingAuthSecret { .. }
        | V3ProviderError::AuthSecretRead { .. }
        | V3ProviderError::OAuthCredential { .. }
        | V3ProviderError::NamespaceToolFlattenFailed { .. }
        | V3ProviderError::FunctionToolShapeFailed { .. }
        | V3ProviderError::ConcurrencyBusy { .. }
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
        }
        | V3ProviderError::ResponseBodyUnreadable {
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
        V3ProviderError::OAuthCredential {
            provider_id,
            reason,
            ..
        } => V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: None,
            code: Some("PROVIDER_OAUTH_CREDENTIAL".to_string()),
            provider_id: Some(provider_id.clone()),
            upstream_request_id: None,
            message: Some(reason.to_string()),
        },
        V3ProviderError::InvalidWireBody { .. }
        | V3ProviderError::ProviderModelBindingMismatch { .. }
        | V3ProviderError::InvalidStreamIntent { .. }
        | V3ProviderError::InvalidDataImage { .. }
        | V3ProviderError::InternalTransport { .. }
        | V3ProviderError::InvalidBaseUrl { .. }
        | V3ProviderError::MissingAuthSecret { .. }
        | V3ProviderError::AuthSecretRead { .. }
        | V3ProviderError::NamespaceToolFlattenFailed { .. }
        | V3ProviderError::FunctionToolShapeFailed { .. }
        | V3ProviderError::ConcurrencyBusy { .. }
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
) -> Result<(Value, V3Error05ExecutionDecision), crate::operation_runner::OperationRunnerError> {
    let source_projection = serde_json::to_value(&source).map_err(|error| {
        crate::operation_runner::OperationRunnerError {
            message: format!("serialize raised Error01 source: {error}"),
        }
    })?;
    crate::operation_runner::run_v3_error_02_to_05_decision_operators(
        source_projection,
        source,
        scope,
        candidates_remaining,
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
