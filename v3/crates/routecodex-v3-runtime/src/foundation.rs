use routecodex_v3_debug::{V3DebugError, V3DebugRuntime, V3DryRunFixture};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_02_classified_from_v3_error_01,
    build_v3_error_03_target_local_action_from_v3_error_02,
    build_v3_error_04_target_exhaustion_decision_from_v3_error_03,
    build_v3_error_05_execution_decision_from_v3_error_04,
    build_v3_error_06_client_projected_from_v3_error_05, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorSourceKind,
};
use serde_json::{json, Value};

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

pub fn execute_v3_foundation_dry_run_runtime(
    fixture: V3DryRunFixture,
    debug: &V3DebugRuntime,
) -> V3FoundationRuntimeOutput {
    if let Err(error) = debug.register_dry_run_fixture(fixture.clone()) {
        return project_v3_debug_failure("V3DryRunFixtureRegistered", error);
    }
    let plan = match debug.build_dry_run_execution_plan(&fixture.fixture_id) {
        Ok(plan) => plan,
        Err(error) => return project_v3_debug_failure("V3DryRunExecutionPlanned", error),
    };
    let request_id = format!("dry-run-{}", fixture.fixture_id);
    let execution_id = format!("dry-run-exec-{}", fixture.fixture_id);
    let scope = match debug.start_trace(&fixture.server_id, &request_id, &execution_id) {
        Ok(scope) => scope,
        Err(error) => return project_v3_debug_failure("V3Debug01TraceContextStarted", error),
    };
    if let Err(error) = debug.capture_raw_request(&scope, fixture.request_payload) {
        return project_v3_debug_failure("V3Debug02RawRequestCaptured", error);
    }
    let session_id = match debug.start_snapshot_session(&scope, "dry-run") {
        Ok(session_id) => session_id,
        Err(error) => return project_v3_debug_failure("V3SnapshotSessionStarted", error),
    };
    for node_id in &plan.node_ids {
        if let Err(error) = debug.record_node_event(
            &scope,
            *node_id,
            "dry_run",
            Some(json!({"terminal_effect": plan.terminal_effect})),
        ) {
            let _ = debug.release_snapshot_session(&scope, &session_id);
            return project_v3_debug_failure("V3Debug01NodeEventRegistered", error);
        }
        if let Err(error) = debug.record_snapshot(
            &scope,
            &session_id,
            *node_id,
            json!({"node_id": node_id, "dry_run": true}),
        ) {
            let _ = debug.release_snapshot_session(&scope, &session_id);
            return project_v3_debug_failure("V3SnapshotNodeCaptured", error);
        }
    }
    let response_payload = debug.redact_projection(fixture.response_payload.clone());
    if let Err(error) = debug.capture_raw_response(&scope, fixture.response_payload) {
        let _ = debug.release_snapshot_session(&scope, &session_id);
        return project_v3_debug_failure("V3Debug03RawResponseCaptured", error);
    }
    let transient_snapshots = match debug.snapshots() {
        Ok(snapshots) => snapshots
            .into_iter()
            .filter(|snapshot| snapshot.session_id == session_id)
            .collect::<Vec<_>>(),
        Err(error) => {
            let _ = debug.release_snapshot_session(&scope, &session_id);
            return project_v3_debug_failure("V3SnapshotProjectionRead", error);
        }
    };
    if let Err(error) = debug.release_snapshot_session(&scope, &session_id) {
        return project_v3_debug_failure("V3SnapshotSessionReleased", error);
    }
    let body = json!({
        "dry_run": {
            "fixture_id": fixture.fixture_id,
            "server_id": fixture.server_id,
            "method": fixture.method,
            "path": fixture.path,
            "terminal_effect": plan.terminal_effect,
            "stopped_before_provider_send": true,
            "node_ids": plan.node_ids,
            "snapshots": transient_snapshots,
            "response_payload": response_payload
        }
    });
    V3FoundationRuntimeOutput {
        status: 200,
        body,
        debug_node: "V3DryRunNoNetworkTerminalEffect",
        error_node: "none",
        error_chain: vec![],
        node_trace: vec![
            "V3Server03HttpRequestRaw",
            "V3Debug01TraceContextStarted",
            "V3Debug02RawRequestCaptured",
            "V3DryRunNoNetworkTerminalEffect",
            "V3Debug03RawResponseCaptured",
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
