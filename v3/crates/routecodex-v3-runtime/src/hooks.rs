use crate::nodes::{
    build_v3_responses_direct_11_policy_from_v3_target_10, V3Req04StandardizedResponses,
    V3ResponsesDirect11Policy,
};
use crate::shared::{project_provider_raw_to_client_payload, V3ProviderResponseProjection};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    build_v3_transport_13_responses_http_request_from_v3_provider_12,
    V3Provider12ResponsesWirePayload, V3ProviderAuthHandle, V3ProviderAuthSecretHandle,
    V3ProviderError, V3ProviderResp14Raw, V3ResponsesProviderTarget,
    V3Transport13ResponsesHttpRequest,
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
type ErrorHook = fn(V3Error01SourceRaised, V3ErrorActionScope, usize) -> V3Error06ClientProjected;

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
    ) -> V3Error06ClientProjected {
        (self.error)(source, scope, candidates_remaining)
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
            output_node: "V3Error06ClientProjected",
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

fn responses_direct_request_projection_hook(
    policy: &V3ResponsesDirect11Policy,
) -> Result<V3Provider12ResponsesWirePayload, V3Error01SourceRaised> {
    let candidate = &policy.target.candidate;
    let secret = match (&candidate.env_name, &candidate.token_file) {
        (Some(name), None) => V3ProviderAuthSecretHandle::Environment(name.clone()),
        (None, Some(path)) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        (Some(name), Some(_)) => V3ProviderAuthSecretHandle::Environment(name.clone()),
        (None, None) => {
            return Err(build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Provider12ResponsesWirePayload",
                "provider_auth_handle_missing",
                format!(
                    "provider {} selected without auth handle",
                    candidate.provider_id
                ),
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
            auth: V3ProviderAuthHandle {
                alias: candidate.auth_alias.clone(),
                secret,
            },
            responses_transport: candidate.responses_transport,
            websocket_v2_url: candidate.websocket_v2_url.clone(),
        },
        policy.request_body.clone(),
    )
    .map_err(provider_error_source("V3Provider12ResponsesWirePayload"))
}

fn responses_direct_provider_transport_hook(
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, V3Error01SourceRaised> {
    build_v3_transport_13_responses_http_request_from_v3_provider_12(wire)
        .map_err(provider_error_source("V3Transport13ResponsesHttpRequest"))
}

fn responses_direct_response_projection_hook(raw: V3ProviderResp14Raw) -> ResponseProjectionFuture {
    Box::pin(project_provider_raw_to_client_payload(raw))
}

fn provider_error_source(
    stage: &'static str,
) -> impl FnOnce(V3ProviderError) -> V3Error01SourceRaised {
    move |error| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            stage,
            "provider_responses_error",
            error.to_string(),
        )
    }
}

fn responses_direct_error_hook(
    source: V3Error01SourceRaised,
    scope: V3ErrorActionScope,
    candidates_remaining: usize,
) -> V3Error06ClientProjected {
    V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source,
        action_scope: scope,
        candidates_remaining,
        source_status: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(result.is_err());
    }
}
