use routecodex_v4_base_node::{
    BaseNode, ControlDirection, ControlRecord, DebugSwitchKind, DebugSwitchLevel, HookEffect,
    HookKind, NodeError, NodeIdentity, Scope, SnapshotKind,
};

fn identity() -> NodeIdentity {
    NodeIdentity::new(
        "V4HubReqChatProcess04Governed",
        "request",
        "v4-hub-1",
        4,
        "routecodex-v4-runtime",
    )
}

fn scope(request_id: &str) -> Scope {
    Scope::new(
        request_id,
        "pipeline-1",
        5555,
        "session-1",
        "conversation-1",
    )
}

#[test]
fn base_node_control_in_out_record() {
    let mut node = BaseNode::new(identity());
    let sc = scope("req-1");
    let in_record = node
        .control_in("continuation.restore", sc.clone(), Some("hash-a"))
        .unwrap();
    assert_eq!(in_record.direction, ControlDirection::In);
    assert_eq!(in_record.sequence, 1);

    let out_record = node
        .control_out("continuation.restore", sc.clone(), Some("hash-a"))
        .unwrap();
    assert_eq!(out_record.direction, ControlDirection::Out);
    assert_eq!(out_record.sequence, 2);

    let records: Vec<&ControlRecord> = node.records().collect();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].control_key, "continuation.restore");
    assert_eq!(records[1].scope, sc);
}

#[test]
fn base_node_control_out_without_in_record_is_red() {
    let mut node = BaseNode::new(identity());
    let sc = scope("req-red-1");
    let err = node
        .control_out("continuation.restore", sc, Some("hash-a"))
        .unwrap_err();
    assert!(matches!(err, NodeError::NoMatchingInRecord));
}

#[test]
fn base_node_debug_subscription_read_only() {
    let mut node = BaseNode::new(identity());
    let sub = node.subscribe_debug("node_event").unwrap();
    assert!(sub.read_only);
    assert!(!sub.decision_plane);
    assert!(!sub.payload_carrier);

    let before = node.records().count();
    let _observe = sub.topic();
    assert_eq!(node.records().count(), before);
}

#[test]
fn base_node_snapshot_subscription_diagnostic() {
    let mut node = BaseNode::new(identity());
    let sub = node.subscribe_snapshot(SnapshotKind::NodeEntry).unwrap();
    assert!(sub.diagnostic_only);
    assert!(!sub.live_input);
    assert!(node.subscribe_snapshot(SnapshotKind::NodeError).is_ok());
    assert!(node.subscribe_snapshot(SnapshotKind::NodeExit).is_ok());
}

#[test]
fn base_node_statistics_observability_only() {
    let mut node = BaseNode::new(identity());
    let records_before = node.records().count();
    node.record_statistic("operator_hits", 1).unwrap();
    node.record_statistic("operator_hits", 2).unwrap();
    assert_eq!(node.records().count(), records_before);
    let stats = node.snapshot_statistics();
    assert_eq!(stats.counter("operator_hits"), Some(3));
}

#[test]
fn base_node_debug_switch_diagnostic_only() {
    let mut node = BaseNode::new(identity());
    let audit = node
        .set_debug_switch(DebugSwitchKind::Debug, DebugSwitchLevel::Trace, "developer")
        .unwrap();
    assert_eq!(audit.actor, "developer");
    assert_eq!(audit.level, DebugSwitchLevel::Trace);
    assert_eq!(node.records().count(), 0);
    assert_eq!(node.debug_enabled_for(DebugSwitchLevel::Trace), true);
    assert_eq!(node.debug_enabled_for(DebugSwitchLevel::Off), false);
}

#[test]
fn base_node_debug_switch_audit_required() {
    let mut node = BaseNode::new(identity());
    let err = node
        .set_debug_switch(DebugSwitchKind::Debug, DebugSwitchLevel::Debug, "")
        .unwrap_err();
    assert!(matches!(err, NodeError::AuditActorRequired));
}

#[test]
fn base_node_dry_run_support() {
    let mut node = BaseNode::new(identity());
    node.declare_dry_run(
        "V4Config01AuthoringFileSource",
        "V4Config05ManifestPublished",
    )
    .unwrap();
    assert!(node.supports_dry_run());
    let result = node
        .execute_dry_run("fixture-config-1", |_identity, fixture| {
            assert_eq!(fixture, "fixture-config-1");
            Ok("dry-run-ok".to_string())
        })
        .unwrap();
    assert_eq!(result, "dry-run-ok");
}

#[test]
fn base_node_no_business_logic() {
    let node = BaseNode::new(identity());
    let id = node.identity();
    assert_eq!(id.node_id(), "V4HubReqChatProcess04Governed");
    assert_eq!(id.chain_version(), "v4-hub-1");
    assert_eq!(id.position(), 4);
    assert_eq!(node.operator_count(), 0);
}

#[test]
fn base_node_error_intake_typed() {
    let mut node = BaseNode::new(identity());
    let sc = scope("req-err-1");
    let intake = node
        .report_error(
            "chat_process",
            "E_PROVIDER_UPSTREAM",
            sc.clone(),
            Some("hash-abc"),
            Some("provider_timeout"),
        )
        .unwrap();
    assert_eq!(intake.stage, "chat_process");
    assert_eq!(intake.code, "E_PROVIDER_UPSTREAM");
    assert_eq!(intake.payload_hash.as_deref(), Some("hash-abc"));
    assert_eq!(intake.typed_context.as_deref(), Some("provider_timeout"));
    assert_eq!(intake.scope, sc);

    // error intake must not produce control records and must not affect business path
    assert_eq!(node.records().count(), 0);
    assert_eq!(node.error_intakes().count(), 1);
}

#[test]
fn base_node_hook_queue_contract() {
    let mut node = BaseNode::new(identity());
    node.declare_hook(
        "hook.chatprocess04.entry.servertool",
        HookKind::Entry,
        1,
        "routecodex-v4-servertool",
        HookEffect::ControlOnly,
    )
    .unwrap();
    node.declare_hook(
        "hook.chatprocess04.exit.record",
        HookKind::Exit,
        1,
        "routecodex-v4-control",
        HookEffect::ReadOnly,
    )
    .unwrap();

    // entry hooks run before operator, exit hooks after: declared, ordered, machine-owned
    let entry: Vec<_> = node.hooks_for(HookKind::Entry);
    let exit: Vec<_> = node.hooks_for(HookKind::Exit);
    assert_eq!(entry.len(), 1);
    assert_eq!(entry[0].hook_id, "hook.chatprocess04.entry.servertool");
    assert_eq!(entry[0].effect, HookEffect::ControlOnly);
    assert_eq!(exit.len(), 1);
    assert_eq!(exit[0].hook_id, "hook.chatprocess04.exit.record");
    assert_eq!(exit[0].effect, HookEffect::ReadOnly);

    // duplicate position on the same kind is red
    let err = node
        .declare_hook(
            "hook.chatprocess04.entry.dup",
            HookKind::Entry,
            1,
            "routecodex-v4-runtime",
            HookEffect::Semantic,
        )
        .unwrap_err();
    assert!(matches!(err, NodeError::DuplicateHookPosition));
}

#[test]
fn base_node_public_api_blackbox_regression() {
    let mut node = BaseNode::new(identity());
    let sc = scope("req-blackbox-1");

    node.subscribe_debug("node_event").unwrap();
    node.subscribe_snapshot(SnapshotKind::NodeExit).unwrap();
    node.control_in("route.selected", sc.clone(), Some("route-hash"))
        .unwrap();
    node.control_out("route.selected", sc, Some("route-hash"))
        .unwrap();

    assert_eq!(node.identity().node_id(), "V4HubReqChatProcess04Governed");
    assert_eq!(node.records().count(), 2);
    assert_eq!(node.operator_count(), 0);
    assert_eq!(node.error_intakes().count(), 0);
}
