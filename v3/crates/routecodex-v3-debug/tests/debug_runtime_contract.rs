use routecodex_v3_debug::{
    V3DebugRuntime, V3DebugRuntimeConfig, V3DryRunFixture, V3RedactionPolicy,
};
use serde_json::json;
use std::collections::BTreeSet;
use std::fs;
use std::sync::Arc;
use std::thread;

#[test]
fn records_ordered_events_redacts_secrets_and_does_not_retain_node_payloads_by_default() {
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: None,
        snapshots_enabled: false,
        dry_run_enabled: true,
        raw_request_retention: 1,
        raw_response_retention: 1,
        event_retention: 8,
        redaction: V3RedactionPolicy::default(),
    })
    .unwrap();
    let scope = runtime.start_trace("srv-a", "req-a", "exec-a").unwrap();
    runtime
        .capture_raw_request(
            &scope,
            json!({"Authorization":"Bearer sk-secret","input":"hello"}),
        )
        .unwrap();
    runtime
        .record_node_event(&scope, "V3Server03HttpRequestRaw", "entered", None)
        .unwrap();
    runtime
        .record_node_event(
            &scope,
            "V3ProviderSendWouldHaveHappened",
            "blocked",
            Some(json!({"api_key":"sk-hidden","nested":{"token":"secret-token"}})),
        )
        .unwrap();
    let projection = runtime.status().unwrap();
    assert_eq!(projection.event_count, 2);
    assert_eq!(projection.raw_request_count, 1);
    assert_eq!(projection.snapshot_count, 0);
    let logs = runtime.logs().unwrap();
    assert_eq!(logs[0].sequence + 1, logs[1].sequence);
    let serialized = serde_json::to_string(&logs).unwrap();
    assert!(serialized.contains("[REDACTED]"));
    assert!(!serialized.contains("sk-secret"));
    assert!(!serialized.contains("secret-token"));
    assert!(
        !serialized.contains("hello"),
        "normal events must not retain full node payloads"
    );
}

#[test]
fn snapshot_sessions_are_request_scoped_and_released() {
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: None,
        snapshots_enabled: true,
        dry_run_enabled: true,
        raw_request_retention: 0,
        raw_response_retention: 0,
        event_retention: 8,
        redaction: V3RedactionPolicy::default(),
    })
    .unwrap();
    let scope = runtime.start_trace("srv-a", "req-a", "exec-a").unwrap();
    let session = runtime.start_snapshot_session(&scope, "dry-run").unwrap();
    runtime
        .record_snapshot(
            &scope,
            &session,
            "V3Error06ClientProjected",
            json!({"token":"sk-nope"}),
        )
        .unwrap();
    let snapshots = runtime.snapshots().unwrap();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].server_id, "srv-a");
    assert!(!serde_json::to_string(&snapshots)
        .unwrap()
        .contains("sk-nope"));
    runtime.release_snapshot_session(&scope, &session).unwrap();
    assert!(runtime.snapshots().unwrap().is_empty());
}

#[test]
fn dry_run_fixture_registry_tracks_no_network_terminal_effect() {
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: None,
        snapshots_enabled: true,
        dry_run_enabled: true,
        raw_request_retention: 2,
        raw_response_retention: 2,
        event_retention: 16,
        redaction: V3RedactionPolicy::default(),
    })
    .unwrap();
    let fixture = V3DryRunFixture {
        fixture_id: "fixture-a".to_string(),
        server_id: "srv-a".to_string(),
        method: "POST".to_string(),
        path: "/v1/responses".to_string(),
        request_payload: json!({"input":"hello"}),
        response_payload: json!({"id":"fixed"}),
    };
    runtime.register_dry_run_fixture(fixture).unwrap();
    let plan = runtime.build_dry_run_execution_plan("fixture-a").unwrap();
    assert_eq!(plan.terminal_effect, "no_network_send");
    assert_eq!(plan.node_ids[0], "V3Server03HttpRequestRaw");
    assert!(plan.node_ids.contains(&"V3DryRunNoNetworkTerminalEffect"));
}

#[test]
fn file_sink_writes_redacted_json_and_sink_open_failure_is_explicit() {
    let path = std::env::temp_dir().join(format!(
        "routecodex-v3-debug-{}-{}.jsonl",
        std::process::id(),
        1
    ));
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: Some(path.display().to_string()),
        snapshots_enabled: false,
        dry_run_enabled: false,
        raw_request_retention: 0,
        raw_response_retention: 0,
        event_retention: 4,
        redaction: V3RedactionPolicy::default(),
    })
    .unwrap();
    let scope = runtime.start_trace("srv", "req", "exec").unwrap();
    runtime
        .record_node_event(
            &scope,
            "V3DebugEventLedgerRecorded",
            "file_sink",
            Some(json!({"authorization":"Bearer sk-file-secret"})),
        )
        .unwrap();
    let written = fs::read_to_string(&path).unwrap();
    assert!(written.contains("[REDACTED]"));
    assert!(!written.contains("sk-file-secret"));
    fs::remove_file(path).unwrap();

    let error = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_file: Some("/dev/null/routecodex-v3-debug.jsonl".to_string()),
        ..V3DebugRuntimeConfig::default()
    })
    .unwrap_err();
    assert!(error.to_string().contains("debug sink failed"));
}

#[test]
fn retention_and_concurrent_event_order_are_bounded_and_unique() {
    let runtime = Arc::new(
        V3DebugRuntime::new(V3DebugRuntimeConfig {
            log_console: false,
            log_file: None,
            snapshots_enabled: false,
            dry_run_enabled: false,
            raw_request_retention: 1,
            raw_response_retention: 1,
            event_retention: 32,
            redaction: V3RedactionPolicy::default(),
        })
        .unwrap(),
    );
    let mut workers = Vec::new();
    for worker in 0..4 {
        let runtime = runtime.clone();
        workers.push(thread::spawn(move || {
            let scope = runtime
                .start_trace("srv", format!("req-{worker}"), format!("exec-{worker}"))
                .unwrap();
            for event in 0..16 {
                runtime
                    .record_node_event(
                        &scope,
                        "V3DebugEventLedgerRecorded",
                        format!("event-{event}"),
                        None,
                    )
                    .unwrap();
            }
        }));
    }
    for worker in workers {
        worker.join().unwrap();
    }
    let logs = runtime.logs().unwrap();
    assert_eq!(logs.len(), 32);
    let sequences = logs
        .iter()
        .map(|event| event.sequence)
        .collect::<BTreeSet<_>>();
    assert_eq!(sequences.len(), logs.len());
}

#[test]
fn malformed_fixture_and_disabled_snapshot_fail_explicitly() {
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: None,
        snapshots_enabled: false,
        dry_run_enabled: true,
        raw_request_retention: 0,
        raw_response_retention: 0,
        event_retention: 8,
        redaction: V3RedactionPolicy::default(),
    })
    .unwrap();
    let malformed = runtime.register_dry_run_fixture(V3DryRunFixture {
        fixture_id: "".to_string(),
        server_id: "srv".to_string(),
        method: "POST".to_string(),
        path: "/v1/responses".to_string(),
        request_payload: json!({}),
        response_payload: json!({}),
    });
    assert!(malformed
        .unwrap_err()
        .to_string()
        .contains("fixture_id is empty"));
    let scope = runtime.start_trace("srv", "req", "exec").unwrap();
    assert!(runtime
        .start_snapshot_session(&scope, "disabled")
        .unwrap_err()
        .to_string()
        .contains("snapshots"));
}
