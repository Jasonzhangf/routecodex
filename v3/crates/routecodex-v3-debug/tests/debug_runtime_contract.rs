#![allow(clippy::default_constructed_unit_structs)]

use routecodex_v3_debug::{
    V3DebugBoundedTextCapture, V3DebugRuntime, V3DebugRuntimeConfig, V3DryRunFixture,
    V3RedactionPolicy,
};
use serde_json::json;
use std::collections::BTreeSet;
use std::fs;
use std::sync::Arc;
use std::thread;

#[test]
fn records_ordered_events_preserves_verbatim_payload_and_does_not_retain_node_payloads_by_default()
{
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: None,
        snapshots_enabled: false,
        snapshot_stages: None,
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
    assert!(serialized.contains("sk-hidden"));
    assert!(serialized.contains("secret-token"));
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
        snapshot_stages: None,
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
    assert!(serde_json::to_string(&snapshots)
        .unwrap()
        .contains("sk-nope"));
    runtime.release_snapshot_session(&scope, &session).unwrap();
    assert!(runtime.snapshots().unwrap().is_empty());
}

#[test]
fn debug_side_channel_preserves_large_history_arrays_verbatim() {
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: None,
        snapshots_enabled: false,
        snapshot_stages: None,
        dry_run_enabled: true,
        raw_request_retention: 1,
        raw_response_retention: 1,
        event_retention: 8,
        redaction: V3RedactionPolicy::default(),
    })
    .unwrap();
    let input = (0..240)
        .map(|index| {
            json!({
                "type": "message",
                "role": "user",
                "content": format!("history item {index} {}", "x".repeat(1_600))
            })
        })
        .collect::<Vec<_>>();
    let redacted = runtime.project_payload_verbatim(json!({
        "input": input,
        "model": "gpt-5.5"
    }));
    let serialized = serde_json::to_string(&redacted).unwrap();
    assert!(
        serialized.contains("history item 239"),
        "debug side-channel snapshot must preserve real payload items verbatim"
    );
    assert!(!serialized.contains("ROUTECODEX_DEBUG_OMITTED_ARRAY_ITEMS"));
}

#[test]
fn debug_side_channel_preserves_nested_artifacts_verbatim() {
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: None,
        snapshots_enabled: false,
        snapshot_stages: None,
        dry_run_enabled: true,
        raw_request_retention: 1,
        raw_response_retention: 1,
        event_retention: 8,
        redaction: V3RedactionPolicy::default(),
    })
    .unwrap();
    let nested = (0..48)
        .map(|outer| {
            json!({
                format!("wide_key_{outer}_{}", "k".repeat(512)): (0..48)
                    .map(|inner| json!({"content": format!("nested {outer}-{inner} {}", "z".repeat(1_900))}))
                    .collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    let redacted = runtime.project_payload_verbatim(json!({
        "input": nested,
        "model": "gpt-5.5"
    }));
    let serialized = serde_json::to_string(&redacted).unwrap();
    assert!(
        serialized.contains("nested 47-47"),
        "debug side-channel payload must preserve nested artifacts verbatim"
    );
    assert!(!serialized.contains("ROUTECODEX_DEBUG_PAYLOAD_BUDGET_EXHAUSTED"));
    assert!(!serialized.contains("ROUTECODEX_DEBUG_SERIALIZED_PAYLOAD_BUDGET_EXCEEDED"));
}

#[test]
fn debug_side_channel_preserves_sensitive_wide_objects_without_placeholder_drops() {
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: None,
        snapshots_enabled: false,
        snapshot_stages: None,
        dry_run_enabled: true,
        raw_request_retention: 1,
        raw_response_retention: 1,
        event_retention: 8,
        redaction: V3RedactionPolicy::default(),
    })
    .unwrap();
    let input = (0..32)
        .map(|outer| {
            (0..64)
                .map(|inner| {
                    (
                        format!(
                            "authorization_{outer}_{inner}_{}",
                            "sensitive_key_padding_".repeat(5)
                        ),
                        json!("Bearer must-not-survive"),
                    )
                })
                .collect::<serde_json::Map<_, _>>()
        })
        .map(serde_json::Value::Object)
        .collect::<Vec<_>>();

    let redacted = runtime.project_payload_verbatim(json!({"input": input}));
    let serialized = serde_json::to_vec(&redacted).unwrap();

    assert!(String::from_utf8_lossy(&serialized).contains("must-not-survive"));
    assert!(!String::from_utf8_lossy(&serialized).contains("ROUTECODEX_DEBUG_"));
}

#[test]
fn debug_stream_capture_preserves_full_text_verbatim() {
    let mut capture = V3DebugBoundedTextCapture::new();
    let first = b"event: response.output_text.delta\ndata: {\"delta\":\"first\"}\n\n";
    capture.append(first);
    let tail = vec![b'x'; 96 * 1024];
    capture.append(&tail);

    let rendered = capture.rendered_text();
    assert!(rendered.starts_with(std::str::from_utf8(first).unwrap()));
    assert_eq!(rendered.len(), first.len() + tail.len());
    assert!(!rendered.contains("ROUTECODEX_DEBUG_STREAM_TRUNCATED"));
    assert_eq!(capture.total_bytes(), first.len() + tail.len());
}

#[test]
fn debug_side_channel_preserves_media_and_oversized_strings_verbatim() {
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: None,
        snapshots_enabled: false,
        snapshot_stages: None,
        dry_run_enabled: true,
        raw_request_retention: 1,
        raw_response_retention: 1,
        event_retention: 8,
        redaction: V3RedactionPolicy::default(),
    })
    .unwrap();
    let image_payload = format!("data:image/png;base64,{}", "A".repeat(16_000));
    let long_text = "debug long text ".repeat(1_200);
    let redacted = runtime.project_payload_verbatim(json!({
        "input": [
            {"type": "input_text", "text": long_text.clone()},
            {"type": "input_image", "image_url": image_payload.clone()},
            {"type": "message", "content": [{"type": "image_url", "image_url": {"url": "https://example.test/image.png"}}]}
        ],
        "metadata": {"authorization": "Bearer side-channel-secret"}
    }));
    let serialized = serde_json::to_string(&redacted).unwrap();
    assert!(!serialized.contains("ROUTECODEX_DEBUG_TRUNCATED_STRING"));
    assert!(!serialized.contains("ROUTECODEX_DEBUG_MEDIA_PLACEHOLDER"));
    assert!(
        serialized.contains(&long_text),
        "long text must be preserved verbatim"
    );
    assert!(
        serialized.contains(&image_payload),
        "media payload must be preserved verbatim"
    );
    assert!(serialized.contains("side-channel-secret"));
}

#[test]
fn dry_run_fixture_registry_tracks_no_network_terminal_effect() {
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: None,
        snapshots_enabled: true,
        snapshot_stages: None,
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
    let serialized = serde_json::to_string(&plan).unwrap();
    assert!(
        !serialized.contains("V3Server03HttpRequestRaw")
            && !serialized.contains("V3ResponsesDirect11Policy"),
        "Debug may plan a replay but must not own the business lifecycle topology"
    );
}

#[test]
fn file_sink_writes_verbatim_json_and_sink_open_failure_is_explicit() {
    let path = std::env::temp_dir().join(format!(
        "routecodex-v3-debug-{}-{}.jsonl",
        std::process::id(),
        1
    ));
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: Some(path.display().to_string()),
        snapshots_enabled: false,
        snapshot_stages: None,
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
    assert!(written.contains("sk-file-secret"));
    fs::remove_file(path).unwrap();

    let error = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_file: Some("/dev/null/routecodex-v3-debug.jsonl".to_string()),
        ..V3DebugRuntimeConfig::default()
    })
    .unwrap_err();
    assert!(error.to_string().contains("debug sink failed"));
}

#[test]
fn file_sink_creates_parent_dirs_and_appends_human_console_lines() {
    let path =
        std::env::temp_dir().join(format!("routecodex-v3-debug-parent-{}", std::process::id()));
    let file = path.join("nested").join("debug.jsonl");
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: Some(file.display().to_string()),
        snapshots_enabled: false,
        snapshot_stages: None,
        dry_run_enabled: false,
        raw_request_retention: 0,
        raw_response_retention: 0,
        event_retention: 4,
        redaction: V3RedactionPolicy::default(),
    })
    .unwrap();
    runtime
        .append_human_console_line("[5555] ▶ [/v1/responses] request req-1 started")
        .unwrap();
    let redacted = runtime.project_payload_verbatim(serde_json::json!({
        "input": "visible",
        "authorization": "Bearer side-channel-secret"
    }));
    assert_eq!(redacted["input"], "visible");
    assert_eq!(redacted["authorization"], "Bearer side-channel-secret");
    let written = fs::read_to_string(&file).unwrap();
    assert!(written.contains("request req-1 started"));
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn file_sink_recreates_parent_dir_after_runtime_start() {
    let path = std::env::temp_dir().join(format!(
        "routecodex-v3-debug-recreate-parent-{}",
        std::process::id()
    ));
    let file = path.join("nested").join("debug.jsonl");
    let runtime = V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: false,
        log_file: Some(file.display().to_string()),
        snapshots_enabled: false,
        snapshot_stages: None,
        dry_run_enabled: false,
        raw_request_retention: 0,
        raw_response_retention: 0,
        event_retention: 4,
        redaction: V3RedactionPolicy::default(),
    })
    .unwrap();
    fs::remove_dir_all(&path).unwrap();

    let scope = runtime.start_trace("srv", "req", "exec").unwrap();
    runtime
        .record_node_event(&scope, "V3DebugEventLedgerRecorded", "recreated", None)
        .unwrap();
    runtime
        .append_human_console_line("[5555] recreated sink parent")
        .unwrap();

    let written = fs::read_to_string(&file).unwrap();
    assert!(written.contains("V3DebugEventLedgerRecorded"));
    assert!(written.contains("recreated sink parent"));
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn retention_and_concurrent_event_order_are_bounded_and_unique() {
    let runtime = Arc::new(
        V3DebugRuntime::new(V3DebugRuntimeConfig {
            log_console: false,
            log_file: None,
            snapshots_enabled: false,
            snapshot_stages: None,
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
        snapshot_stages: None,
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
