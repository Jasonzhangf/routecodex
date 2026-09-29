use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_target::{V3TargetInterpreter, V3TargetWebSearchRouteEligibility};
use routecodex_v3_virtual_router::{V3Router05RequestClassified, V3VirtualRouter};
use serde_json::Value;
use std::collections::BTreeSet;

use crate::provider_failure_runtime_policy::{
    V3ProviderFailureRuntimeHealth, V3SessionGlobalSchedulingReader,
};

pub(crate) fn web_search_route_eligible_for_classified_request(
    manifest: &V3Config05ManifestPublished,
    classified: V3Router05RequestClassified,
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_health: &V3ProviderFailureRuntimeHealth,
    now_ms: u64,
    deterministic_sample: u64,
) -> Result<V3TargetWebSearchRouteEligibility, String> {
    let declaration = V3VirtualRouter::process_shared()
        .resolve_web_search_route_declaration(manifest, classified)
        .map_err(|error| error.to_string())?;
    let session_availability = provider_health.session_bound_availability(failure_session_scope);
    let excluded = BTreeSet::new();
    let scheduling = V3SessionGlobalSchedulingReader {
        session: &session_availability,
        global: provider_health,
        excluded: &excluded,
    };
    V3TargetInterpreter::default()
        .resolve_web_search_route_eligibility(
            manifest,
            declaration,
            &scheduling,
            now_ms,
            deterministic_sample,
        )
        .map_err(|error| error.to_string())
}

pub(crate) fn web_search_route_eligible_for_entry_request(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    endpoint_path: &str,
    entry_kind: &str,
    body: &Value,
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_health: &V3ProviderFailureRuntimeHealth,
    now_ms: u64,
    deterministic_sample: u64,
) -> Result<V3TargetWebSearchRouteEligibility, String> {
    let facts = crate::build_v3_router_request_facts_for_entry_with_manifest(
        body,
        entry_kind,
        crate::configured_v3_longcontext_threshold_tokens(manifest, server_id),
        manifest,
    );
    let classified = V3VirtualRouter::process_shared()
        .classify_request_with_facts(manifest, server_id, endpoint_path, facts)
        .map_err(|error| error.to_string())?;
    web_search_route_eligible_for_classified_request(
        manifest,
        classified,
        failure_session_scope,
        provider_health,
        now_ms,
        deterministic_sample,
    )
}
