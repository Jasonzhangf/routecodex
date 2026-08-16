//! routecodex-v4-debug L2 regression: 12 diagnostic resources, positive and
//! red (reverse) cases paired per contract; no control/payload semantics.

use routecodex_v4_debug::{
    assert_diagnostic_only, DebugError, DebugRuntime, DebugSnapshotRecord, DryRunChainDefinition,
    DryRunFixture, RawCaptureRecord, SnapshotSubscription, SubscriptionTopic, SwitchKind,
    TraceContext,
};

fn runtime() -> DebugRuntime {
    DebugRuntime::new()
}

#[test]
fn snapshot_ledger_immutable_positive_and_red() {
    let mut debug_runtime = runtime();
    debug_runtime
        .snapshot_ledger
        .append(DebugSnapshotRecord {
            record_id: "snap-1".to_string(),
            server_id: "srv".to_string(),
            request_id: "req-1".to_string(),
            execution_id: "exec-1".to_string(),
            kind: "request".to_string(),
            payload_hash: "sha256:abc".to_string(),
        })
        .expect("first append must succeed");
    assert_eq!(debug_runtime.snapshot_ledger.records().count(), 1);
    assert!(matches!(
        debug_runtime.snapshot_ledger.append(DebugSnapshotRecord {
            record_id: "snap-1".to_string(),
            server_id: "srv".to_string(),
            request_id: "req-1".to_string(),
            execution_id: "exec-1".to_string(),
            kind: "request".to_string(),
            payload_hash: "sha256:abc".to_string(),
        }),
        Err(DebugError::ImmutableRecord)
    ));
}

#[test]
fn trace_event_raw_capture_lifecycle() {
    let mut debug_runtime = runtime();
    debug_runtime
        .start_trace(TraceContext {
            trace_id: "trace-1".to_string(),
            server_id: "srv".to_string(),
            request_id: "req-1".to_string(),
            execution_id: "exec-1".to_string(),
        })
        .expect("trace start must succeed");
    assert_eq!(debug_runtime.trace_context.contexts().count(), 1);
    debug_runtime.record_node_event("srv", "req-1", "exec-1", "V4HubReqInbound03Normalized", "in");
    let raw: RawCaptureRecord =
        debug_runtime.capture_raw_request("srv", "req-1", "exec-1", r#"{"model":"m"}"#);
    assert_eq!(raw.kind, "request");
    assert_eq!(debug_runtime.event_ledger.records().count(), 1);
    assert_eq!(debug_runtime.raw_capture.records().count(), 1);
    assert!(matches!(
        debug_runtime.start_trace(TraceContext {
            trace_id: "trace-1".to_string(),
            server_id: "srv".to_string(),
            request_id: "req-1".to_string(),
            execution_id: "exec-1".to_string(),
        }),
        Err(DebugError::ImmutableRecord)
    ));
}

#[test]
fn subscriptions_positive_and_red() {
    let mut debug_runtime = runtime();
    debug_runtime
        .bus_subscription
        .subscribe("sub-1", SubscriptionTopic::NodeEvent, "scope-a")
        .expect("subscribe must succeed");
    assert_eq!(
        debug_runtime
            .bus_subscription
            .subscribers_for(&SubscriptionTopic::NodeEvent)
            .count(),
        1
    );
    assert!(matches!(
        debug_runtime
            .bus_subscription
            .subscribe("sub-1", SubscriptionTopic::NodeEvent, "scope-a"),
        Err(DebugError::DuplicateSubscription)
    ));
    debug_runtime
        .snapshot_subscription
        .subscribe(SnapshotSubscription {
            subscriber_id: "sub-2".to_string(),
            node_id: "V4ScopeRegistry".to_string(),
            snapshot_kind: "scope".to_string(),
            scope_key: "scope-a".to_string(),
        })
        .expect("snapshot subscribe must succeed");
    assert!(matches!(
        debug_runtime.snapshot_subscription.subscribe(SnapshotSubscription {
            subscriber_id: "sub-2".to_string(),
            node_id: "V4ScopeRegistry".to_string(),
            snapshot_kind: "scope".to_string(),
            scope_key: "scope-a".to_string(),
        }),
        Err(DebugError::DuplicateSubscription)
    ));
}

#[test]
fn snapshot_session_and_dry_run_fixture_positive_and_red() {
    let mut debug_runtime = runtime();
    debug_runtime
        .start_snapshot_session("session-1", "srv", "req-1", "exec-1")
        .expect("start must succeed");
    debug_runtime
        .record_snapshot("session-1", "V4ScopeRegistry", "sha256:abc")
        .expect("record must succeed");
    let session = debug_runtime
        .release_snapshot_session("session-1")
        .expect("release must succeed");
    assert_eq!(session.entries.len(), 1);
    assert!(matches!(
        debug_runtime.release_snapshot_session("session-1"),
        Err(DebugError::SnapshotSessionNotActive)
    ));
    assert!(matches!(
        debug_runtime.record_snapshot("session-1", "V4ScopeRegistry", "sha256:abc"),
        Err(DebugError::SnapshotSessionNotActive)
    ));

    debug_runtime
        .register_dry_run_fixture(DryRunFixture {
            fixture_id: "fixture-1".to_string(),
            server_id: "srv".to_string(),
            endpoint: "responses".to_string(),
            input_hash: "sha256:input".to_string(),
        })
        .expect("fixture register must succeed");
    assert_eq!(
        debug_runtime
            .build_dry_run_execution_plan("fixture-1")
            .expect("plan must build")
            .fixture_id,
        "fixture-1"
    );
    assert!(matches!(
        debug_runtime.build_dry_run_execution_plan("missing"),
        Err(DebugError::UnknownFixture)
    ));

    debug_runtime
        .dry_run_chain
        .register_dry_run_chain(DryRunChainDefinition {
            chain_id: "chain-1".to_string(),
            module_id: "runtime".to_string(),
            entry_node: None,
            exit_node: None,
            fixture_id: "fixture-1".to_string(),
        })
        .expect("chain register must succeed");
    assert!(debug_runtime.dry_run_chain.chain("chain-1").is_some());
}

#[test]
fn module_switch_and_payload_budget_and_sample_store() {
    let mut debug_runtime = runtime();
    debug_runtime
        .module_switch
        .set(
            "runtime",
            "V4ScopeRegistry",
            "scope-a",
            SwitchKind::Debug,
            "debug",
            true,
        )
        .expect("switch must succeed");
    assert!(debug_runtime.module_switch.enabled_for_module("runtime"));
    assert!(!debug_runtime.module_switch.enabled_for_module("config"));

    debug_runtime
        .project_payload_verbatim("srv", "req-1", "exec-1", "request", "{}")
        .expect("project must succeed");
    debug_runtime
        .append_bounded_text("srv", "req-1", "exec-1", "response", &"x".repeat(500))
        .expect("bounded text must succeed");
    assert_eq!(debug_runtime.payload_budget.entries().count(), 2);
    assert!(matches!(
        debug_runtime.persist("responses", "localhost", 5555, "req-1", "req.json", 42),
        Ok(_)
    ));
    assert_eq!(debug_runtime.codex_sample_store.samples().count(), 1);

    let mut tiny_runtime = runtime();
    tiny_runtime.payload_budget = routecodex_v4_debug::V4Debug10PayloadBudget::new(1);
    tiny_runtime.project_payload_verbatim("srv", "req-1", "exec-1", "request", "{}")
        .expect("first fits");
    assert!(matches!(
        tiny_runtime.project_payload_verbatim("srv", "req-2", "exec-2", "request", "{}"),
        Err(DebugError::RetentionCapExceeded)
    ));
    assert!(assert_diagnostic_only(&debug_runtime));
}
