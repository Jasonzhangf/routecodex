use crate::nodes::{
    build_v3_req_04_standardized_responses_from_v3_server_03,
    build_v3_router_request_facts_from_v3_req_04, V3Server03HttpRequestRaw,
};
use crate::operation_runner::V3Err01SourceInput;
use crate::provider_failure_runtime_policy::{
    project_v3_relay_error_source, raise_v3_source_via_err01, V3RelayErrorOperatorFault,
};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_debug::{V3DebugError, V3DebugRuntime};
use routecodex_v3_error::{
    v3_http_boundary_error_spec, v3_server_websocket_error_spec, V3Error01SourceRaised,
    V3Error06ClientProjected, V3ErrorActionScope, V3ErrorSourceKind, V3HttpBoundaryErrorKind,
};
use routecodex_v3_provider_responses::{
    V3ProviderAvailabilityReader, V3ProviderAvailabilityRegistry,
};
use routecodex_v3_target::{V3AvailabilitySchedulingAdapter, V3TargetInterpreter};
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
    pub diagnostic_source: Option<V3Error01SourceRaised>,
    pub diagnostic_cause: Option<V3Error01SourceRaised>,
}

pub fn project_v3_server_boundary_error_via_sdk(
    source_kind: V3ErrorSourceKind,
    source_stage: &'static str,
    code: &'static str,
    message: impl Into<String>,
    source_status: Option<u16>,
) -> Result<V3Error06ClientProjected, V3RelayErrorOperatorFault> {
    let (_source_projection, source) = raise_v3_source_via_err01(
        source_kind,
        source_stage,
        code,
        message.into(),
        V3Err01SourceInput::Plain,
    )?;
    project_v3_relay_error_source(source, V3ErrorActionScope::None, 0, source_status)
}

pub fn foundation_output_from_error_sdk_result(
    debug_node: &'static str,
    fault_node_trace: Vec<&'static str>,
    success_node_trace: Option<Vec<&'static str>>,
    result: Result<V3Error06ClientProjected, V3RelayErrorOperatorFault>,
) -> V3FoundationRuntimeOutput {
    match result {
        Ok(projected) => {
            let error_node = projected.chain[5];
            let chain = projected.chain.to_vec();
            V3FoundationRuntimeOutput {
                status: projected.status,
                body: projected.body,
                debug_node,
                error_node,
                error_chain: chain.clone(),
                node_trace: success_node_trace.unwrap_or(chain),
                stopped_before_provider_send: true,
                diagnostic_source: Some(projected.diagnostic_source),
                diagnostic_cause: None,
            }
        }
        Err(fault) => V3FoundationRuntimeOutput {
            status: 599,
            body: Value::Null,
            debug_node,
            error_node: "none",
            error_chain: Vec::new(),
            node_trace: fault_node_trace,
            stopped_before_provider_send: true,
            diagnostic_source: Some(*fault.policy_failure),
            diagnostic_cause: fault.original_source.map(|source| *source),
        },
    }
}

pub fn project_v3_http_boundary_error_via_sdk(
    kind: V3HttpBoundaryErrorKind,
    detail: impl Into<String>,
) -> Result<V3Error06ClientProjected, V3RelayErrorOperatorFault> {
    let (source_kind, source_stage, code) = v3_http_boundary_error_spec(kind);
    project_v3_server_boundary_error_via_sdk(source_kind, source_stage, code, detail, None)
}

pub fn project_v3_server_websocket_error_via_sdk(
    code: &'static str,
    detail: impl Into<String>,
) -> Result<V3Error06ClientProjected, V3RelayErrorOperatorFault> {
    let (source_kind, source_stage, source_status) = v3_server_websocket_error_spec(code);
    project_v3_server_boundary_error_via_sdk(
        source_kind,
        source_stage,
        code,
        detail,
        Some(source_status),
    )
}

/// Project an already-raised Source through the REST error SDK.
///
/// Post-commit producers own reaching a real `V3Error01SourceRaised`. Running
/// Err01 again would replace that source with a synthetic local failure.
pub fn project_v3_post_commit_sse_source_via_sdk(
    source: V3Error01SourceRaised,
    status: u16,
) -> Result<V3Error06ClientProjected, V3RelayErrorOperatorFault> {
    project_v3_relay_error_source(source, V3ErrorActionScope::None, 0, Some(status)).map(
        |mut projected| {
            projected.status = status;
            projected
        },
    )
}

pub fn project_v3_runtime_observability_contract_failure_via_sdk(
    message: impl Into<String>,
) -> Result<V3Error06ClientProjected, V3RelayErrorOperatorFault> {
    let (_source_projection, source) = raise_v3_source_via_err01(
        V3ErrorSourceKind::RuntimeFailure,
        "V3RuntimeObservability",
        "runtime_observability_contract",
        message.into(),
        V3Err01SourceInput::Plain,
    )?;
    project_v3_post_commit_sse_source_via_sdk(source, 500)
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
    let standardized = match build_v3_req_04_standardized_responses_from_v3_server_03(raw) {
        Ok(standardized) => standardized,
        Err(error) => {
            return project_p5_failure(
                "V3Req04StandardizedResponses",
                "responses_inbound_canonicalization_failed",
                error,
            )
        }
    };
    let deterministic_sample =
        crate::provider_failure_runtime_policy::v3_relay_provider_target_selection_sample(
            &standardized.request_id,
        );
    if let Err(error) = debug.record_node_event(
        &scope,
        "V3Req04StandardizedResponses",
        "standardized",
        Some(json!({
            "server_id": standardized.server_id,
            "endpoint": standardized.endpoint,
            "method": standardized.method
        })),
    ) {
        return project_v3_debug_failure("V3Req04StandardizedResponses", error);
    }
    let router = V3VirtualRouter::process_shared();
    let routing_facts = build_v3_router_request_facts_from_v3_req_04(&standardized, manifest);
    let classified = match router.classify_request_with_facts(
        manifest,
        &standardized.server_id,
        &standardized.endpoint,
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
    let expanded = match target.expand_candidates(manifest, kind, deterministic_sample) {
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
    let scheduling = V3AvailabilitySchedulingAdapter::new(availability);
    match target.select_available_with_health(expanded, &scheduling, 0, deterministic_sample) {
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
                diagnostic_source: None,
                diagnostic_cause: None,
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
    foundation_output_from_error_sdk_result(
        source_stage,
        Vec::new(),
        None,
        project_v3_server_boundary_error_via_sdk(
            V3ErrorSourceKind::TargetPoolExhausted,
            source_stage,
            code,
            message,
            None,
        ),
    )
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
    let projected = match build_pending_projection(&input) {
        Ok(projected) => projected,
        Err(fault) => {
            return foundation_output_from_error_sdk_result(
                "V3Debug01NodeEventRegistered",
                vec![
                    "V3Server03HttpRequestRaw",
                    "V3Debug01TraceContextStarted",
                    "V3Debug02RawRequestCaptured",
                    "V3Debug01NodeEventRegistered",
                ],
                None,
                Err(fault),
            )
        }
    };
    if let Err(error) = debug.record_node_event(
        &scope,
        "V3Error06ClientProjected",
        "projected",
        Some(projected.body.clone()),
    ) {
        return project_v3_debug_failure("V3Error06ClientProjected", error);
    }
    foundation_output_from_error_sdk_result(
        "V3Debug01NodeEventRegistered",
        Vec::new(),
        Some(vec![
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
        ]),
        Ok(projected),
    )
}

pub fn project_v3_debug_failure(
    source_stage: &'static str,
    error: V3DebugError,
) -> V3FoundationRuntimeOutput {
    foundation_output_from_error_sdk_result(
        source_stage,
        Vec::new(),
        None,
        project_v3_server_boundary_error_via_sdk(
            V3ErrorSourceKind::RuntimeFailure,
            source_stage,
            "v3_debug_failure",
            error.to_string(),
            None,
        ),
    )
}

fn build_pending_projection(
    input: &V3FoundationRuntimeInput,
) -> Result<V3Error06ClientProjected, V3RelayErrorOperatorFault> {
    project_v3_server_boundary_error_via_sdk(
        V3ErrorSourceKind::PendingEndpoint,
        "V3Server03HttpRequestRaw",
        "not_implemented",
        format!(
            "V3 endpoint node is registered but not implemented: {} {} on {}",
            input.method, input.path, input.server_id
        ),
        None,
    )
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
            redaction: V3RedactionPolicy,
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
        assert_eq!(
            output.diagnostic_source.as_ref().unwrap().source_kind,
            V3ErrorSourceKind::PendingEndpoint
        );
        assert!(output.diagnostic_cause.is_none());
        assert_eq!(debug.status().unwrap().raw_request_count, 1);
    }

    #[test]
    fn normal_foundation_failures_preserve_typed_sources() {
        let p5 = project_p5_failure(
            "V3Target10ConcreteProviderSelected",
            "selected_target_exhausted",
            "all candidates unavailable".to_string(),
        );
        assert_eq!(p5.status, 502);
        assert_eq!(
            p5.diagnostic_source.unwrap().source_kind,
            V3ErrorSourceKind::TargetPoolExhausted
        );

        let debug_failure = project_v3_debug_failure(
            "V3Debug01NodeEventRegistered",
            V3DebugError::MalformedFixture("typed debug failure".to_string()),
        );
        assert_eq!(debug_failure.status, 598);
        assert_eq!(
            debug_failure.diagnostic_source.unwrap().source_kind,
            V3ErrorSourceKind::RuntimeFailure
        );
        assert!(debug_failure.diagnostic_cause.is_none());
    }

    #[test]
    fn sdk_operator_fault_preserves_policy_source_and_original_cause() {
        let (_, original_source) = raise_v3_source_via_err01(
            V3ErrorSourceKind::PendingEndpoint,
            "V3Server03HttpRequestRaw",
            "not_implemented",
            "pending endpoint",
            V3Err01SourceInput::Plain,
        )
        .unwrap();
        let fault = V3RelayErrorOperatorFault {
            policy_failure: Box::new(routecodex_v3_error::build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Error06ClientProjected",
                "relay_error_operator_sdk_failure",
                "synthetic Error06 operator failure",
            )),
            original_source: Some(Box::new(original_source.clone())),
        };
        let output = foundation_output_from_error_sdk_result(
            "V3Debug01NodeEventRegistered",
            vec!["V3Server03HttpRequestRaw"],
            None,
            Err(fault),
        );

        assert_eq!(output.status, 599);
        assert_eq!(output.body, Value::Null);
        assert_eq!(output.error_node, "none");
        assert!(output.error_chain.is_empty());
        assert_eq!(
            output.diagnostic_source.as_ref().unwrap().source_kind,
            V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(
            output.diagnostic_source.as_ref().unwrap().code,
            "relay_error_operator_sdk_failure"
        );
        assert_eq!(output.diagnostic_cause, Some(original_source));
    }

    #[test]
    fn http_boundary_error_executes_canonical_error_nodes_and_preserves_fault_cause() {
        let projected = project_v3_http_boundary_error_via_sdk(
            routecodex_v3_error::V3HttpBoundaryErrorKind::MalformedJson,
            "malformed JSON request body",
        )
        .expect("normal HTTP boundary input must project through Err01..Err06");

        assert_eq!(
            projected.chain,
            [
                "V3Error01SourceRaised",
                "V3Error02Classified",
                "V3Error03TargetLocalAction",
                "V3Error04TargetExhaustionDecision",
                "V3Error05ExecutionDecision",
                "V3Error06ClientProjected",
            ]
        );
        assert_eq!(projected.status, 400);
        assert_eq!(projected.body["error"]["code"], "malformed_json");
        assert_eq!(
            projected.diagnostic_source.source_stage,
            "V3Server03HttpRequestRaw"
        );

        let (_, original_source) = raise_v3_source_via_err01(
            V3ErrorSourceKind::InvalidRequest,
            "V3Server03HttpRequestRaw",
            "malformed_json",
            "malformed JSON request body",
            V3Err01SourceInput::Plain,
        )
        .expect("fault fixture source must be canonical");
        let fault = V3RelayErrorOperatorFault {
            policy_failure: Box::new(routecodex_v3_error::build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Error06ClientProjected",
                "relay_error_operator_sdk_failure",
                "synthetic HTTP boundary Error06 failure",
            )),
            original_source: Some(Box::new(original_source.clone())),
        };
        let output = foundation_output_from_error_sdk_result(
            "V3Server03HttpRequestRaw",
            vec!["V3Server03HttpRequestRaw"],
            None,
            Err(fault),
        );

        assert_eq!(output.status, 599);
        assert_eq!(output.body, Value::Null);
        assert_eq!(output.error_node, "none");
        assert_eq!(
            output.diagnostic_source.as_ref().unwrap().source_stage,
            "V3Error06ClientProjected"
        );
        assert_eq!(output.diagnostic_cause, Some(original_source));
        assert!(
            output
                .node_trace
                .iter()
                .all(|node| *node != "V3Error01SourceRaised"),
            "the raw SDK fault must not recursively raise another Err01: {:?}",
            output.node_trace
        );
    }

    #[test]
    fn websocket_error_sdk_classification_matches_existing_parity() {
        let invalid_client_event = project_v3_server_websocket_error_via_sdk(
            "invalid_client_event",
            "client WebSocket event is missing type",
        )
        .expect("invalid client event must project through Err01..Err06");
        assert_eq!(
            invalid_client_event.chain,
            routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS
        );
        assert_eq!(invalid_client_event.status, 400);
        assert_eq!(
            invalid_client_event.diagnostic_source.source_kind,
            V3ErrorSourceKind::InvalidRequest
        );
        assert_eq!(
            invalid_client_event.diagnostic_source.source_stage,
            "V3ServerRespOutbound06ClientFrame"
        );
        assert_eq!(
            invalid_client_event.diagnostic_source.code,
            "invalid_client_event"
        );

        for code in ["invalid_request", "runtime_error"] {
            let projected =
                project_v3_server_websocket_error_via_sdk(code, "WebSocket runtime error")
                    .expect("runtime WebSocket error must project through Err01..Err06");
            assert_eq!(
                projected.chain,
                routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS
            );
            assert_eq!(projected.status, 599);
            assert_eq!(
                projected.diagnostic_source.source_kind,
                V3ErrorSourceKind::RuntimeFailure
            );
            assert_eq!(
                projected.diagnostic_source.source_stage,
                "V3ServerRespOutbound06ClientFrame"
            );
            assert_eq!(projected.diagnostic_source.code, code);
        }

        let capture = project_v3_server_boundary_error_via_sdk(
            V3ErrorSourceKind::RuntimeFailure,
            "V3OperationRunnerCaptureClientJson",
            "operation_runner_capture_client_json_failed",
            "capture client JSON failed",
            Some(598),
        )
        .expect("capture client JSON failure must project through Err01..Err06");
        assert_eq!(capture.chain, routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS);
        assert_eq!(capture.status, 598);
        assert_eq!(
            capture.diagnostic_source.source_kind,
            V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(
            capture.diagnostic_source.source_stage,
            "V3OperationRunnerCaptureClientJson"
        );
        assert_eq!(
            capture.diagnostic_source.code,
            "operation_runner_capture_client_json_failed"
        );

        let observability =
            project_v3_runtime_observability_contract_failure_via_sdk("missing required timing")
                .expect("observability contract must project through Err01..Err06");
        assert_eq!(observability.status, 500);
        assert_eq!(
            observability.chain,
            routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS
        );
        assert_eq!(
            observability.diagnostic_source.source_kind,
            V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(
            observability.diagnostic_source.source_stage,
            "V3RuntimeObservability"
        );
        assert_eq!(
            observability.diagnostic_source.code,
            "runtime_observability_contract"
        );
        assert_eq!(
            observability.diagnostic_source.message,
            "missing required timing"
        );
    }

    #[test]
    fn pending_runtime_recreates_post_startup_debug_sink_parent_directory() {
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
            redaction: V3RedactionPolicy,
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
        assert_eq!(output.status, 501);
        assert_eq!(output.body["error"]["code"], "not_implemented");
        assert!(output.stopped_before_provider_send);
        assert!(log_file.exists());
    }
}
