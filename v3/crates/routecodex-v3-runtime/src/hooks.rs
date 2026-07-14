use crate::nodes::{
    V3Req04StandardizedResponses, V3Resp10ClientPayload, V3ResponsesDirect06Policy,
    V3Route05SelectedTarget,
};
use crate::shared::{project_provider_raw_to_client_payload, select_default_route_target};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_02_classified_from_v3_error_01,
    build_v3_error_03_target_local_action_from_v3_error_02,
    build_v3_error_04_target_exhaustion_decision_from_v3_error_03,
    build_v3_error_05_execution_decision_from_v3_error_04,
    build_v3_error_06_client_projected_from_v3_error_05, V3Error01SourceRaised,
    V3Error06ClientProjected, V3ErrorActionScope,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_07_responses_wire_payload,
    build_v3_transport_08_responses_http_request_from_v3_provider_07,
    V3Provider07ResponsesWirePayload, V3ProviderResp09Raw, V3Transport08ResponsesHttpRequest,
};

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
    &V3Config05ManifestPublished,
    &V3Req04StandardizedResponses,
) -> Result<V3Route05SelectedTarget, V3Error01SourceRaised>;
type RequestProjectionHook = fn(&V3ResponsesDirect06Policy) -> V3Provider07ResponsesWirePayload;
type ProviderTransportHook =
    fn(V3Provider07ResponsesWirePayload) -> V3Transport08ResponsesHttpRequest;
type ResponseProjectionHook =
    fn(V3ProviderResp09Raw) -> Result<V3Resp10ClientPayload, V3Error01SourceRaised>;
type ErrorHook = fn(V3Error01SourceRaised) -> V3Error06ClientProjected;

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
        manifest: &V3Config05ManifestPublished,
        request: &V3Req04StandardizedResponses,
    ) -> Result<V3Route05SelectedTarget, V3Error01SourceRaised> {
        (self.route)(manifest, request)
    }

    pub fn run_request_projection(
        &self,
        policy: &V3ResponsesDirect06Policy,
    ) -> V3Provider07ResponsesWirePayload {
        (self.request_projection)(policy)
    }

    pub fn run_provider_transport(
        &self,
        wire: V3Provider07ResponsesWirePayload,
    ) -> V3Transport08ResponsesHttpRequest {
        (self.provider_transport)(wire)
    }

    pub fn run_response_projection(
        &self,
        raw: V3ProviderResp09Raw,
    ) -> Result<V3Resp10ClientPayload, V3Error01SourceRaised> {
        (self.response_projection)(raw)
    }

    pub fn run_error(&self, source: V3Error01SourceRaised) -> V3Error06ClientProjected {
        (self.error)(source)
    }
}

pub fn register_responses_direct_hooks() -> V3HookRegistry {
    static HOOKS: &[V3RegisteredHook] = &[
        V3RegisteredHook {
            hook_id: "ResponsesDirectRouteHook",
            hook_point: V3HookPoint::Route,
            input_node: "V3Req04StandardizedResponses",
            output_node: "V3Route05SelectedTarget",
        },
        V3RegisteredHook {
            hook_id: "ResponsesDirectRequestProjectionHook",
            hook_point: V3HookPoint::RequestProjection,
            input_node: "V3ResponsesDirect06Policy",
            output_node: "V3Provider07ResponsesWirePayload",
        },
        V3RegisteredHook {
            hook_id: "ResponsesDirectProviderTransportHook",
            hook_point: V3HookPoint::ProviderTransport,
            input_node: "V3Provider07ResponsesWirePayload",
            output_node: "V3Transport08ResponsesHttpRequest",
        },
        V3RegisteredHook {
            hook_id: "ResponsesDirectResponseProjectionHook",
            hook_point: V3HookPoint::ResponseProjection,
            input_node: "V3ProviderResp09Raw",
            output_node: "V3Resp10ClientPayload",
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
    manifest: &V3Config05ManifestPublished,
    request: &V3Req04StandardizedResponses,
) -> Result<V3Route05SelectedTarget, V3Error01SourceRaised> {
    select_default_route_target(manifest, request)
}

fn responses_direct_request_projection_hook(
    policy: &V3ResponsesDirect06Policy,
) -> V3Provider07ResponsesWirePayload {
    build_v3_provider_07_responses_wire_payload(
        policy.target.provider_id.clone(),
        policy.target.base_url.clone(),
        policy.target.model.clone(),
        policy.target.auth_env.clone(),
        policy.request_body.clone(),
    )
}

fn responses_direct_provider_transport_hook(
    wire: V3Provider07ResponsesWirePayload,
) -> V3Transport08ResponsesHttpRequest {
    build_v3_transport_08_responses_http_request_from_v3_provider_07(wire)
}

fn responses_direct_response_projection_hook(
    raw: V3ProviderResp09Raw,
) -> Result<V3Resp10ClientPayload, V3Error01SourceRaised> {
    project_provider_raw_to_client_payload(raw)
}

fn responses_direct_error_hook(source: V3Error01SourceRaised) -> V3Error06ClientProjected {
    let classified = build_v3_error_02_classified_from_v3_error_01(source);
    let action = build_v3_error_03_target_local_action_from_v3_error_02(
        classified,
        V3ErrorActionScope::None,
        0,
    );
    let exhaustion = build_v3_error_04_target_exhaustion_decision_from_v3_error_03(action, 0);
    let execution = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion);
    build_v3_error_06_client_projected_from_v3_error_05(execution)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

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
    fn malformed_json_response_is_explicit_error() {
        let registry = register_responses_direct_hooks();
        let result = registry.run_response_projection(V3ProviderResp09Raw {
            provider_id: "test".to_string(),
            status: 200,
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: b"not-json".to_vec(),
        });
        assert!(result.is_err());
    }
}
