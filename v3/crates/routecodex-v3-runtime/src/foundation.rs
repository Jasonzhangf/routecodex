use crate::nodes::{
    build_v3_req_04_standardized_responses_from_v3_server_03,
    build_v3_router_request_facts_from_v3_req_04, V3Server03HttpRequestRaw,
};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_debug::{V3DebugError, V3DebugRuntime};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_02_classified_from_v3_error_01,
    build_v3_error_03_target_local_action_from_v3_error_02,
    build_v3_error_04_target_exhaustion_decision_from_v3_error_03,
    build_v3_error_05_execution_decision_from_v3_error_04,
    build_v3_error_06_client_projected_from_v3_error_05, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorSourceKind,
};
use routecodex_v3_provider_responses::{
    V3ProviderAvailabilityReader, V3ProviderAvailabilityRegistry,
};
use routecodex_v3_target::V3TargetInterpreter;
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct V3P5Runtime<R = V3ProviderAvailabilityRegistry> {
    manifest: Arc<V3Config05ManifestPublished>,
    availability: R,
}

impl V3P5Runtime<V3ProviderAvailabilityRegistry> {
    pub fn new(manifest: Arc<V3Config05ManifestPublished>) -> Self {
        let availability = V3ProviderAvailabilityRegistry::from_manifest(&manifest);
        Self::with_availability(manifest, availability)
    }
}

impl<R: V3ProviderAvailabilityReader> V3P5Runtime<R> {
    pub fn with_availability(manifest: Arc<V3Config05ManifestPublished>, availability: R) -> Self {
        Self {
            manifest,
            availability,
        }
    }

    pub fn execute(
        &self,
        input: V3Server03HttpRequestRaw,
        debug: &V3DebugRuntime,
    ) -> V3FoundationRuntimeOutput {
        execute_v3_p5_routing_runtime(input, &self.manifest, &self.availability, debug)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3FoundationRuntimeInput {
    pub server_id: String,
    pub request_id: String,
    pub execution_id: String,
    pub method: String,
    pub path: String,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3FoundationRuntimeOutput {
    pub status: u16,
    pub body: Value,
    pub debug_node: &'static str,
    pub error_node: &'static str,
    pub error_chain: Vec<&'static str>,
    pub node_trace: Vec<&'static str>,
    pub stopped_before_provider_send: bool,
}

pub fn execute_v3_p5_routing_runtime<R: V3ProviderAvailabilityReader>(
    raw: V3Server03HttpRequestRaw,
    manifest: &V3Config05ManifestPublished,
    availability: &R,
    debug: &V3DebugRuntime,
) -> V3FoundationRuntimeOutput {
    let scope = match debug.start_trace(&raw.server_id, &raw.request_id, &raw.execution_id) {
        Ok(scope) => scope,
        Err(error) => return project_v3_debug_failure("V3Debug01TraceContextStarted", error),
    };
    if let Err(error) = debug.capture_raw_request(&scope, raw.body.clone()) {
        return project_v3_debug_failure("V3Debug02RawRequestCaptured", error);
    }
    if let Err(error) = debug.record_node_event(
        &scope,
        "V3Server03HttpRequestRaw",
        "entered",
        Some(json!({"server_id": raw.server_id, "method": raw.method, "path": raw.path})),
    ) {
        return project_v3_debug_failure("V3Server03HttpRequestRaw", error);
    }
    let standardized = build_v3_req_04_standardized_responses_from_v3_server_03(raw);
    if let Err(error) = debug.record_node_event(
        &scope,
        "V3Req04StandardizedResponses",
        "standardized",
        Some(json!({
            "server_id": standardized.protocol_context.server_id,
            "endpoint": standardized.protocol_context.endpoint,
            "method": standardized.protocol_context.method
        })),
    ) {
        return project_v3_debug_failure("V3Req04StandardizedResponses", error);
    }
    let router = V3VirtualRouter::default();
    let routing_facts = build_v3_router_request_facts_from_v3_req_04(&standardized);
    let classified = match router.classify_request_with_facts(
        manifest,
        &standardized.protocol_context.server_id,
        &standardized.protocol_context.endpoint,
        routing_facts,
    ) {
        Ok(node) => node,
        Err(error) => {
            return project_p5_failure(
                "V3Router05RequestClassified",
                "route_classification_failed",
                error.to_string(),
            )
        }
    };
    if let Err(error) = debug.record_node_event(&scope, "V3Router05RequestClassified", "classified", Some(json!({"server_id": classified.server_id, "routing_group_id": classified.routing_group_id, "endpoint": classified.endpoint}))) {
        return project_v3_debug_failure("V3Router05RequestClassified", error);
    }
    let plan = match router.resolve_route_pool_plan(manifest, classified) {
        Ok(node) => node,
        Err(error) => {
            return project_p5_failure(
                "V3Router06RoutePoolResolved",
                "selection_plan_unavailable",
                error.to_string(),
            )
        }
    };
    if let Err(error) = debug.record_node_event(&scope, "V3Router06RoutePoolResolved", "resolved", Some(json!({"routing_group_id": plan.routing_group_id(), "tier_count": plan.tier_count(), "candidate_count": plan.candidate_count()}))) {
        return project_v3_debug_failure("V3Router06RoutePoolResolved", error);
    }
    let hit = match router.hit_opaque_target_plan_once(plan, 0) {
        Ok(node) => node,
        Err(error) => {
            return project_p5_failure(
                "V3Router07OpaqueTargetHitOnce",
                "opaque_target_hit_failed",
                error.to_string(),
            )
        }
    };
    if let Err(error) = debug.record_node_event(&scope, "V3Router07OpaqueTargetHitOnce", "hit_once", Some(json!({"routing_group_id": hit.routing_group_id, "pool_id": hit.pool_id, "target_index": hit.target_index, "target_kind": format!("{:?}", hit.target_kind), "target_id": hit.target_id, "hit_count": hit.hit_count}))) {
        return project_v3_debug_failure("V3Router07OpaqueTargetHitOnce", error);
    }
    let target = V3TargetInterpreter::default();
    let kind = target.classify_kind(hit);
    if let Err(error) = debug.record_node_event(
        &scope,
        "V3Target08KindClassified",
        "classified",
        Some(json!({"target_kind": format!("{:?}", kind.route.target_kind)})),
    ) {
        return project_v3_debug_failure("V3Target08KindClassified", error);
    }
    let expanded = match target.expand_candidates(manifest, kind, 0) {
        Ok(node) => node,
        Err(error) => {
            return project_p5_failure(
                "V3Target09CandidateSetExpanded",
                "target_expansion_failed",
                error.to_string(),
            )
        }
    };
    if let Err(error) = debug.record_node_event(&scope, "V3Target09CandidateSetExpanded", "expanded", Some(json!({"candidate_count": expanded.candidates.len(), "route_target_index": expanded.route.target_index}))) {
        return project_v3_debug_failure("V3Target09CandidateSetExpanded", error);
    }
    match target.select_available(expanded, availability, 0) {
        Ok(selected) => {
            for candidate in &selected.unavailable_candidates {
                if let Err(error) = debug.record_node_event(
                    &scope,
                    "V3TargetAvailabilitySkipped",
                    "unavailable",
                    Some(json!({"candidate": candidate})),
                ) {
                    return project_v3_debug_failure("V3TargetAvailabilitySkipped", error);
                }
            }
            if selected.attempts > 1 {
                if let Err(error) = debug.record_node_event(
                    &scope,
                    "V3TargetLocalReselected",
                    "reselected",
                    Some(json!({
                        "attempts": selected.attempts,
                        "router_hit_count": selected.route.hit_count
                    })),
                ) {
                    return project_v3_debug_failure("V3TargetLocalReselected", error);
                }
            }
            if let Err(error) = debug.record_node_event(&scope, "V3Target10ConcreteProviderSelected", "selected", Some(json!({"provider_id": selected.candidate.provider_id, "auth_alias": selected.candidate.auth_alias, "model_id": selected.candidate.model_id, "attempts": selected.attempts, "unavailable_candidates": selected.unavailable_candidates, "router_hit_count": selected.route.hit_count, "stopped_before_provider_send": true}))) {
                return project_v3_debug_failure("V3Target10ConcreteProviderSelected", error);
            }
            V3FoundationRuntimeOutput {
                status: 200,
                body: json!({"p5_routing": {"routing_group_id": selected.route.routing_group_id, "pool_id": selected.route.pool_id, "router_hit_count": selected.route.hit_count, "provider_id": selected.candidate.provider_id, "auth_alias": selected.candidate.auth_alias, "model_id": selected.candidate.model_id, "attempts": selected.attempts, "stopped_before_provider_send": true, "next_node": "V3ResponsesDirect11Policy"}}),
                debug_node: "V3Target10ConcreteProviderSelected",
                error_node: "none",
                error_chain: vec![],
                node_trace: vec![
                    "V3Server03HttpRequestRaw",
                    "V3Req04StandardizedResponses",
                    "V3Router05RequestClassified",
                    "V3Router06RoutePoolResolved",
                    "V3Router07OpaqueTargetHitOnce",
                    "V3Target08KindClassified",
                    "V3Target09CandidateSetExpanded",
                    "V3Target10ConcreteProviderSelected",
                ],
                stopped_before_provider_send: true,
            }
        }
        Err(exhausted) => {
            for candidate in &exhausted.attempted_candidates {
                if let Err(error) = debug.record_node_event(
                    &scope,
                    "V3TargetAvailabilitySkipped",
                    "unavailable",
                    Some(json!({"candidate": candidate})),
                ) {
                    return project_v3_debug_failure("V3TargetAvailabilitySkipped", error);
                }
            }
            if let Err(error) = debug.record_node_event(
                &scope,
                "V3TargetPoolExhausted",
                "exhausted",
                Some(json!({
                    "attempted_candidates": exhausted.attempted_candidates.len(),
                    "router_hit_count": exhausted.route.hit_count
                })),
            ) {
                return project_v3_debug_failure("V3TargetPoolExhausted", error);
            }
            project_p5_failure(
                "V3Target10ConcreteProviderSelected",
                "selected_target_exhausted",
                format!(
                    "all {} candidates unavailable",
                    exhausted.attempted_candidates.len()
                ),
            )
        }
    }
}

fn project_p5_failure(
    source_stage: &'static str,
    code: &'static str,
    message: String,
) -> V3FoundationRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::TargetPoolExhausted,
        source_stage,
        code,
        message,
    );
    let classified = build_v3_error_02_classified_from_v3_error_01(source);
    let action = build_v3_error_03_target_local_action_from_v3_error_02(
        classified,
        V3ErrorActionScope::None,
        0,
    );
    let exhaustion = build_v3_error_04_target_exhaustion_decision_from_v3_error_03(action, 0);
    let execution = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion);
    let projected = build_v3_error_06_client_projected_from_v3_error_05(execution);
    V3FoundationRuntimeOutput {
        status: projected.status,
        body: projected.body,
        debug_node: source_stage,
        error_node: projected.chain[5],
        error_chain: projected.chain.to_vec(),
        node_trace: projected.chain.to_vec(),
        stopped_before_provider_send: true,
    }
}

pub fn execute_v3_foundation_pending_runtime(
    input: V3FoundationRuntimeInput,
    debug: &V3DebugRuntime,
) -> V3FoundationRuntimeOutput {
    let scope = match debug.start_trace(&input.server_id, &input.request_id, &input.execution_id) {
        Ok(scope) => scope,
        Err(error) => return project_v3_debug_failure("V3Debug01TraceContextStarted", error),
    };
    if let Err(error) = debug.capture_raw_request(&scope, input.payload.clone()) {
        return project_v3_debug_failure("V3Debug02RawRequestCaptured", error);
    }
    if let Err(error) = debug.record_node_event(
        &scope,
        "V3Server03HttpRequestRaw",
        "entered",
        Some(json!({
            "method": input.method,
            "path": input.path,
            "payload_retained": false
        })),
    ) {
        return project_v3_debug_failure("V3Debug01NodeEventRegistered", error);
    }
    if let Err(error) = debug.record_node_event(
        &scope,
        "V3Debug01NodeEventRegistered",
        "registered",
        Some(json!({"server_id": input.server_id, "path": input.path})),
    ) {
        return project_v3_debug_failure("V3Debug01NodeEventRegistered", error);
    }
    let projected = build_pending_projection(&input);
    if let Err(error) = debug.record_node_event(
        &scope,
        "V3Error06ClientProjected",
        "projected",
        Some(projected.body.clone()),
    ) {
        return project_v3_debug_failure("V3Error06ClientProjected", error);
    }
    V3FoundationRuntimeOutput {
        status: projected.status,
        body: projected.body,
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: projected.chain[5],
        error_chain: projected.chain.to_vec(),
        node_trace: vec![
            "V3Server03HttpRequestRaw",
            "V3Debug01TraceContextStarted",
            "V3Debug02RawRequestCaptured",
            "V3Debug01NodeEventRegistered",
            "V3Error01SourceRaised",
            "V3Error02Classified",
            "V3Error03TargetLocalAction",
            "V3Error04TargetExhaustionDecision",
            "V3Error05ExecutionDecision",
            "V3Error06ClientProjected",
            "V3Server16HttpFrame",
        ],
        stopped_before_provider_send: true,
    }
}

pub fn project_v3_debug_failure(
    source_stage: &'static str,
    error: V3DebugError,
) -> V3FoundationRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        source_stage,
        "v3_debug_failure",
        error.to_string(),
    );
    let classified = build_v3_error_02_classified_from_v3_error_01(source);
    let action = build_v3_error_03_target_local_action_from_v3_error_02(
        classified,
        V3ErrorActionScope::None,
        0,
    );
    let exhaustion = build_v3_error_04_target_exhaustion_decision_from_v3_error_03(action, 0);
    let execution = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion);
    let projected = build_v3_error_06_client_projected_from_v3_error_05(execution);
    V3FoundationRuntimeOutput {
        status: projected.status,
        body: projected.body,
        debug_node: source_stage,
        error_node: projected.chain[5],
        error_chain: projected.chain.to_vec(),
        node_trace: projected.chain.to_vec(),
        stopped_before_provider_send: true,
    }
}

fn build_pending_projection(input: &V3FoundationRuntimeInput) -> V3Error06ClientProjected {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::PendingEndpoint,
        "V3Server03HttpRequestRaw",
        "not_implemented",
        format!(
            "V3 endpoint node is registered but not implemented: {} {} on {}",
            input.method, input.path, input.server_id
        ),
    );
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
    use routecodex_v3_debug::{V3DebugRuntimeConfig, V3RedactionPolicy};
    use std::fs;

    #[test]
    fn pending_runtime_emits_debug_and_six_error_nodes_without_provider_send() {
        let debug = V3DebugRuntime::new(V3DebugRuntimeConfig {
            log_console: false,
            log_file: None,
            snapshots_enabled: false,
            snapshot_stages: None,
            dry_run_enabled: true,
            raw_request_retention: 1,
            raw_response_retention: 1,
            event_retention: 16,
            redaction: V3RedactionPolicy::default(),
        })
        .unwrap();
        let output = execute_v3_foundation_pending_runtime(
            V3FoundationRuntimeInput {
                server_id: "srv".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                payload: json!({"input":"hello"}),
            },
            &debug,
        );
        assert_eq!(output.status, 501);
        assert!(output.stopped_before_provider_send);
        assert_eq!(output.error_chain.len(), 6);
        assert_eq!(debug.status().unwrap().raw_request_count, 1);
    }

    #[test]
    fn pending_runtime_surfaces_post_startup_debug_sink_failure_through_error_chain() {
        let directory =
            std::env::temp_dir().join(format!("routecodex-v3-runtime-sink-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let log_file = directory.join("debug.jsonl");
        let debug = V3DebugRuntime::new(V3DebugRuntimeConfig {
            log_console: false,
            log_file: Some(log_file.to_string_lossy().into_owned()),
            snapshots_enabled: false,
            snapshot_stages: None,
            dry_run_enabled: true,
            raw_request_retention: 1,
            raw_response_retention: 1,
            event_retention: 16,
            redaction: V3RedactionPolicy::default(),
        })
        .unwrap();
        fs::remove_file(&log_file).unwrap();
        fs::remove_dir(&directory).unwrap();

        let output = execute_v3_foundation_pending_runtime(
            V3FoundationRuntimeInput {
                server_id: "srv".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                payload: json!({"input":"hello"}),
            },
            &debug,
        );
        assert_eq!(output.status, 500);
        assert_eq!(output.error_chain.len(), 6);
        assert_eq!(output.body["error"]["code"], "v3_debug_failure");
        assert!(output.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("debug sink failed"));
        assert!(output.stopped_before_provider_send);
    }
}
