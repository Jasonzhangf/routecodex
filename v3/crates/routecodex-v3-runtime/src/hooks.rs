use crate::nodes::{
    build_v3_responses_direct_11_policy_from_v3_target_10, V3ChatDirect11Policy,
    V3Req04StandardizedResponses, V3ResponsesDirect11Policy,
};
use crate::shared::{project_provider_raw_to_client_payload, V3ProviderResponseProjection};
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
use std::future::Future;
use std::pin::Pin;

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
) -> Result<V3Provider12ResponsesWirePayload, V3Error01SourceRaised>;
type ProviderTransportHook = fn(
    V3Provider12ResponsesWirePayload,
)
    -> Result<V3Transport13ResponsesHttpRequest, V3Error01SourceRaised>;
type ResponseProjectionFuture = Pin<
    Box<dyn Future<Output = Result<V3ProviderResponseProjection, V3Error01SourceRaised>> + Send>,
>;
type ResponseProjectionHook = fn(V3ProviderResp14Raw) -> ResponseProjectionFuture;
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
    provider_transport: ProviderTransportHook,
    response_projection: ResponseProjectionHook,
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
        (self.request_projection)(policy)
    }

    pub fn run_provider_transport(
        &self,
        wire: V3Provider12ResponsesWirePayload,
    ) -> Result<V3Transport13ResponsesHttpRequest, V3Error01SourceRaised> {
        (self.provider_transport)(wire)
    }

    pub async fn run_response_projection(
        &self,
        raw: V3ProviderResp14Raw,
    ) -> Result<V3ProviderResponseProjection, V3Error01SourceRaised> {
        (self.response_projection)(raw).await
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
    V3HookRegistry {
        hooks: HOOKS,
        route: responses_direct_route_hook,
        request_projection: responses_direct_request_projection_hook,
        provider_transport: responses_direct_provider_transport_hook,
        response_projection: responses_direct_response_projection_hook,
        error: responses_direct_error_hook,
    }
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
    let reasoning_effort_explicit =
        crate::hub_v1::provider_req_compat_reasoning_effort_explicit(&policy.request_body);
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
    let profile = crate::hub_v1::V3ProviderCompatProfileId::from_config(
        candidate.compatibility_profile.as_deref(),
    );
    request_body = crate::hub_v1::apply_v3_provider_req_compat_to_provider_payload(
        request_body,
        candidate,
        provider_protocol,
        &profile,
        reasoning_effort_explicit,
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
    if request_body.get("previous_response_id").is_some() {
        return Err(build_v3_error_01_source_raised_internal(
            V3ErrorSourceKind::RuntimeFailure,
            "V3ResponsesDirect11Policy",
            "direct_continuation_payload_source_violation",
            "Direct continuation locator must come from typed protocol context",
            V3InternalErrorCode::V3Provider12ResponsesWirePayload,
        ));
    }
    if let Some(previous_response_id) = &policy.previous_response_id {
        request_body
            .as_object_mut()
            .ok_or_else(|| {
                build_v3_error_01_source_raised_internal(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3ResponsesDirect11Policy",
                    "direct_continuation_wire_payload_not_object",
                    "Direct Responses provider wire payload must be an object",
                    V3InternalErrorCode::V3Provider12ResponsesWirePayload,
                )
            })?
            .insert(
                "previous_response_id".to_string(),
                serde_json::Value::String(previous_response_id.clone()),
            );
    }
    let secret = match (
        &candidate.env_name,
        &candidate.token_file,
        &candidate.secret_file,
        &candidate.secret_key,
        &candidate.api_key,
    ) {
        (Some(name), None, None, None, None) => V3ProviderAuthSecretHandle::Environment(name.clone()),
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

fn responses_direct_response_projection_hook(raw: V3ProviderResp14Raw) -> ResponseProjectionFuture {
    Box::pin(project_provider_raw_to_client_payload(raw))
}

fn provider_error_source(
    stage: &'static str,
) -> impl FnOnce(V3ProviderError) -> V3Error01SourceRaised {
    move |error| build_v3_provider_error_source(stage, error)
}

pub(crate) fn chat_direct_request_projection_hook(
    policy: &V3ChatDirect11Policy,
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
    let wire_body =
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
    let secret = match (
        &candidate.env_name,
        &candidate.token_file,
        &candidate.secret_file,
        &candidate.secret_key,
        &candidate.api_key,
    ) {
        (Some(name), None, None, None, None) => V3ProviderAuthSecretHandle::Environment(name.clone()),
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
            previous_response_id: None,
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
            .run_response_projection(V3ProviderResp14Raw::from_json(
                "req",
                "test",
                200,
                vec![routecodex_v3_provider_responses::V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                b"not-json".to_vec(),
            ))
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
