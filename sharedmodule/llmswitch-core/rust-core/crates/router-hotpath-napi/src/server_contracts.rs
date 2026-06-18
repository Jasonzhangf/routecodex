//! Server Runtime module help contracts.
//! Phase Server-A: read-only online help for server adapter / direct passthrough /
//! response projection / error projection modules.
//!
//! No live behavior changes.
// feature_id: server.rust_contract_surface

use serde::Serialize;
use serde_json::{json, Value};

const CONTRACT_VERSION: &str = "2026-06-03.server-module-help.v1";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerModuleHelp {
    module_id: &'static str,
    version: &'static str,
    owner_module: &'static str,
    owner_builder: Option<&'static str>,
    phase: &'static str,
    description: &'static str,
    /// Fields allowed from client request body.metadata into pipeline metadata carrier.
    allowed_request_metadata_fields: &'static [&'static str],
    /// Fields that must NEVER enter pipeline metadata carrier.
    forbidden_metadata_fields: &'static [&'static str],
    /// Top-level fields forbidden from appearing in provider wire / SDK options / direct body.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    forbidden_provider_exits: Vec<&'static str>,
    /// Top-level fields forbidden from appearing in client response body / SSE frame.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    forbidden_client_exits: Vec<&'static str>,
    /// Carriers that must NOT enter provider wire / SDK options / direct body / client response.
    forbidden_carriers: &'static [&'static str],
    /// Effects this module may produce.
    effects: &'static [&'static str],
    /// Paths that must NOT be read from or written to in this module.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    forbidden_paths: Vec<&'static str>,
    /// Names of red tests that lock this module's boundaries.
    red_tests: &'static [&'static str],
    /// Debug query flow for this module.
    debug_flow: &'static str,
    /// Short help text.
    help: &'static str,
}

fn server_module_helps() -> Vec<ServerModuleHelp> {
    vec![
        ServerModuleHelp {
            module_id: "server.req_adapter",
            version: CONTRACT_VERSION,
            owner_module: "src/server/handlers/*.ts  /  server adapter",
            owner_builder: None,
            phase: "server.req_inbound",
            description: "Server adapter layer: parses HTTP request, captures client request body, headers, and path; binds request/session/conversation identity into pipeline metadata carrier. Does NOT build provider wire, NOT route, NOT apply tool governance.",
            allowed_request_metadata_fields: &["clientRequestId", "userAgent", "clientOriginator", "requestSource", "experimentFlag", "appVersion"],
            forbidden_metadata_fields: &[
                "routeHint",
                "__routeHint",
                "routingDecision",
                "__shadowCompareForcedProviderKey",
                "__routecodexRetryProviderKey",
                "providerKey",
                "__rt",
                "__rt.*",
                "snapshot.*",
                "snapshotId",
                "upstreamRequestId",
            ],
            forbidden_provider_exits: vec![
                "metadata",
                "metaCarrier",
                "runtimeMetadata",
                "provider.body.metadata",
                "provider.options.metadata",
                "provider.sdkOptions.metadata",
                "direct.body.metadata",
            ],
            forbidden_client_exits: vec![],
            forbidden_carriers: &[
                "metadata",
                "metaCarrier",
                "runtimeMetadata",
                "errorCarrier",
                "classifiedError",
                "__rt",
                "snapshot",
            ],
            effects: &[
                "capture_client_headers",
                "bind_request_identity",
                "bind_session_conversation_scope",
                "forward_clean_body_to_pipeline",
            ],
            forbidden_paths: vec![
                "metadata.routeHint",
                "metadata.providerKey",
                "metadata.__rt",
            ],
            red_tests: &[
                "server_req_adapter_metadata_forbidden_fields.red",
                "server_req_adapter_provider_exits.red",
            ],
            debug_flow: "1. Query describeServerModuleHelp('server.req_adapter'). 2. Inspect handler source: src/server/handlers/*.  3. Verify allowed fields in metadata carrier vs forbidden fields fail-fast.",
            help: "Server request adapter: captures client request facts and session scope into pipeline metadata. Only clientRequestId/userAgent/clientOriginator/requestSource/experimentFlag/appVersion may enter metadata carrier. Route/provider/runtime control fields must fail-fast, not silently delete.",
        },
        ServerModuleHelp {
            module_id: "server.direct_passthrough",
            version: CONTRACT_VERSION,
            owner_module: "src/server/runtime/http-server/direct-passthrough-payload.ts",
            owner_builder: Some("build_direct_passthrough_payload"),
            phase: "server.direct",
            description: "Direct passthrough: clones client body to provider wire verbatim. Enforces that body has no internal metadata fields. Provider wire body must be identical to client body; no injection of route/provider/runtime metadata into provider request.",
            allowed_request_metadata_fields: &[],
            forbidden_metadata_fields: &["metadata", "metaCarrier", "__rt", "__raw_request_body"],
            forbidden_provider_exits: vec![
                "metadata",
                "body.metadata",
                "body.__rt",
                "options.metadata",
                "options.__rt",
            ],
            forbidden_client_exits: vec![],
            forbidden_carriers: &[
                "metadata",
                "metaCarrier",
                "runtimeMetadata",
                "errorCarrier",
                "classifiedError",
                "__rt",
                "snapshot",
            ],
            effects: &["clone_body_verbatim", "fail_fast_on_internal_metadata"],
            forbidden_paths: vec![
                "body.metadata",
                "body.__rt",
                "options.metadata",
                "options.__rt",
            ],
            red_tests: &[
                "server_direct_passthrough_metadata_guard.red",
                "server_direct_body_clone_equivalence.red",
            ],
            debug_flow: "1. Query describeServerModuleHelp('server.direct_passthrough'). 2. Inspect direct-passthrough-payload.ts source. 3. Verify body.metadata presence triggers error, not silent deletion.",
            help: "Direct passthrough: provider wire must be byte-for-byte client body. Any internal metadata in body causes fail-fast, not deletion. No route/provider control fields in provider body.",
        },
        ServerModuleHelp {
            module_id: "server.response_projection",
            version: CONTRACT_VERSION,
            owner_module: "src/server/handlers/handler-response-utils.ts  /  src/server/runtime/http-server/executor/*.ts",
            owner_builder: None,
            phase: "server.resp_outbound",
            description: "Response projection: builds client HTTP response body and SSE frames from Hub pipeline response. Must NOT inject internal metadata, Meta* carriers, Error* carriers, or Snapshot* carriers into client body. Success payload = only protocol-defined fields.",
            allowed_request_metadata_fields: &[],
            forbidden_metadata_fields: &["metadata", "metaCarrier", "__rt", "errorCarrier"],
            forbidden_provider_exits: vec![],
            forbidden_client_exits: vec![
                "metadata",
                "metaCarrier",
                "runtimeMetadata",
                "errorCarrier",
                "__rt",
                "snapshot",
                "__raw_request_body",
            ],
            forbidden_carriers: &[
                "metadata",
                "metaCarrier",
                "runtimeMetadata",
                "errorCarrier",
                "classifiedError",
                "__rt",
                "snapshot",
            ],
            effects: &["project_response_to_client_protocol", "build_sse_frames"],
            forbidden_paths: vec![
                "response.metadata",
                "response.__rt",
                "sse_frame.data.metadata",
                "sse_frame.data.__rt",
            ],
            red_tests: &[
                "server_response_projection_internal_metadata.red",
                "server_sse_frame_metadata_guard.red",
            ],
            debug_flow: "1. Query describeServerModuleHelp('server.response_projection'). 2. Inspect handler-response-utils.ts and executor response projection code. 3. Search client response body for internal metadata fields.",
            help: "Response projection: client body/SSE frame must contain only protocol-defined fields. Any internal metadata/metaCarrier/__rt/errorCarrier/snapshot in client response causes fail-fast, not silent deletion.",
        },
        ServerModuleHelp {
            module_id: "server.error_projection",
            version: CONTRACT_VERSION,
            owner_module: "src/server/runtime/http-server/http-error-mapper.ts  /  src/server/handlers/*.ts",
            owner_builder: None,
            phase: "server.error_outbound",
            description: "Error projection: maps pipeline/runtime errors to client-visible HTTP error responses. Must consume ErrorErr06ClientProjected carrier only. Internal auth details, request context, or runtime metadata must NOT appear in public error body.",
            allowed_request_metadata_fields: &[],
            forbidden_metadata_fields: &["metadata", "metaCarrier", "__rt", "errorCarrier"],
            forbidden_provider_exits: vec![],
            forbidden_client_exits: vec![
                "metadata",
                "metaCarrier",
                "runtimeMetadata",
                "errorCarrier",
                "__rt",
                "snapshot",
                "internalDetails",
                "upstreamRequestId",
                "providerStack",
            ],
            forbidden_carriers: &[
                "metadata",
                "metaCarrier",
                "runtimeMetadata",
                "errorCarrier",
                "classifiedError",
                "__rt",
                "snapshot",
            ],
            effects: &["map_pipeline_error_to_http_response"],
            forbidden_paths: vec![
                "error.metadata",
                "error.internalDetails",
                "error.upstreamRequestId",
            ],
            red_tests: &[
                "server_error_projection_internal_metadata.red",
                "server_error_public_body_surface.red",
            ],
            debug_flow: "1. Query describeServerModuleHelp('server.error_projection'). 2. Inspect http-error-mapper.ts source. 3. Verify public error body contains no internal metadata/auth details.",
            help: "Error projection: public error body must contain only client-safe error code and message. No internal auth details, request context, or runtime metadata in public error response.",
        },
        ServerModuleHelp {
            module_id: "server.error_action_queue",
            version: CONTRACT_VERSION,
            owner_module: "src/server/runtime/http-server/executor/request-executor-error-action-queue.ts",
            owner_builder: Some("describeErrorActionQueueContract"),
            phase: "server.error_action",
            description: "Unified error action queue for all host-side storm prevention waits. It records category/scope events, emits queue hooks, and performs blocking waits through one gate. Delay policy is fixed 1000ms -> 2000ms -> 3000ms cycle. It does not classify errors, mutate provider health, or project client errors.",
            allowed_request_metadata_fields: &[],
            forbidden_metadata_fields: &["metadata", "metaCarrier", "__rt", "errorCarrier"],
            forbidden_provider_exits: vec![],
            forbidden_client_exits: vec![],
            forbidden_carriers: &[
                "metadata",
                "metaCarrier",
                "runtimeMetadata",
                "errorCarrier",
                "classifiedError",
                "__rt",
                "snapshot",
            ],
            effects: &[
                "record_error_action_backoff",
                "emit_error_action_hook",
                "blocking_wait_1s_2s_3s_cycle",
                "enforce_fixed_waiter_cap",
            ],
            forbidden_paths: vec![
                "provider.health",
                "virtual_router.selection",
                "client.response",
                "provider.request",
            ],
            red_tests: &[
                "request_executor_error_action_queue_fixed_cycle.red",
                "provider_traffic_governor_unified_queue.red",
                "server_module_help_error_action_queue.red",
            ],
            debug_flow: "1. Query describeServerModuleHelp('server.error_action_queue'). 2. Inspect request-executor-error-action-queue.ts contract. 3. Verify category/scope hook events and 1s/2s/3s blocking wait behavior in focused tests.",
            help: "Error action queue: all error-storm waits use one fixed blocking queue: 1s -> 2s -> 3s -> repeat. Supported categories are global_error, session_storm, provider_recoverable, provider_transport, provider_traffic_saturated, and servertool_followup. No per-call/env backoff configuration, no local soft-wait loops.",
        },
    ]
}

/// Top-level server contracts descriptor (mirrors describe_hub_pipeline_contracts).
pub(crate) fn describe_server_contracts() -> Value {
    json!({
        "contractVersion": CONTRACT_VERSION,
        "modules": server_module_helps(),
    })
}

/// Single module help query (mirrors describe_pipeline_contract).
pub(crate) fn describe_server_module_help(module_id: &str) -> Option<Value> {
    server_module_helps()
        .into_iter()
        .find(|m| m.module_id == module_id)
        .map(|m| {
            json!({
                "contractVersion": CONTRACT_VERSION,
                "module": m,
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_five_server_modules() {
        let output = describe_server_contracts();
        assert_eq!(output["contractVersion"], CONTRACT_VERSION);
        assert_eq!(output["modules"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn describes_single_module_help() {
        let output = describe_server_module_help("server.direct_passthrough").unwrap();
        assert_eq!(output["module"]["moduleId"], "server.direct_passthrough");
        assert!(!output["module"]["forbiddenProviderExits"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn unknown_module_returns_none() {
        assert!(describe_server_module_help("server.unknown").is_none());
    }

    #[test]
    fn all_modules_have_red_tests() {
        let modules = server_module_helps();
        for m in modules {
            assert!(
                !m.red_tests.is_empty(),
                "module {} must have at least one red test",
                m.module_id
            );
        }
    }

    #[test]
    fn all_modules_forbid_internal_carriers() {
        let modules = server_module_helps();
        let expected: &[&str] = &[
            "metadata",
            "metaCarrier",
            "runtimeMetadata",
            "errorCarrier",
            "classifiedError",
            "__rt",
            "snapshot",
        ];
        for m in modules {
            assert_eq!(
                m.forbidden_carriers, expected,
                "module {} must forbid all internal carriers",
                m.module_id
            );
        }
    }

    #[test]
    fn req_adapter_allows_client_identity_only() {
        let m = server_module_helps()
            .into_iter()
            .find(|m| m.module_id == "server.req_adapter")
            .unwrap();
        assert!(m
            .allowed_request_metadata_fields
            .contains(&"clientRequestId"));
        assert!(!m.allowed_request_metadata_fields.contains(&"routeHint"));
        assert!(!m.allowed_request_metadata_fields.contains(&"providerKey"));
        // Lock sync with handler-utils PIPELINE_METADATA_ALLOWED_CLIENT_FIELDS:
        assert!(m.allowed_request_metadata_fields.contains(&"requestSource"));
        assert!(m
            .allowed_request_metadata_fields
            .contains(&"experimentFlag"));
        assert!(m.allowed_request_metadata_fields.contains(&"appVersion"));
    }
}
