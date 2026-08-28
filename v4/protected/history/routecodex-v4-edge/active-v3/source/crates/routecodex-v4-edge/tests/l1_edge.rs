use routecodex_v4_edge::{
    validate_edge, Axis, EdgeError, EdgeKind, EdgeSpec, NodeRef, ResourceRef, ScopeRegistry,
};

fn nodes() -> Vec<NodeRef> {
    vec![
        NodeRef::new(
            "V4HubReqInbound03Normalized",
            "request",
            "v4-hub-1",
            3,
            true,
        ),
        NodeRef::new(
            "V4HubReqChatProcess04Governed",
            "request",
            "v4-hub-1",
            4,
            true,
        ),
        NodeRef::new(
            "V4HubReqOutbound05ProviderSemantic",
            "request",
            "v4-hub-1",
            5,
            true,
        ),
        NodeRef::new(
            "V4Config01AuthoringFileSource",
            "config",
            "v4-config-1",
            1,
            false,
        ),
        NodeRef::new(
            "V4Config02AuthoringParsed",
            "config",
            "v4-config-1",
            2,
            false,
        ),
        NodeRef::new(
            "V4Config03SchemaValidated",
            "config",
            "v4-config-1",
            3,
            false,
        ),
    ]
}

fn resources() -> Vec<ResourceRef> {
    vec![
        ResourceRef::new("v4.request.normal_payload", Axis::Data),
        ResourceRef::new("v4.control.side_channel", Axis::Control),
        ResourceRef::new("v4.config.authoring", Axis::Information),
        ResourceRef::new("v4.config.parsed", Axis::Information),
        ResourceRef::new("v4.debug.bus_subscription", Axis::Control),
        ResourceRef::new("v4.control.error_center", Axis::Control),
    ]
}

fn data_edge(from: &str, to: &str, data_in: &str, data_out: &str) -> EdgeSpec {
    EdgeSpec::data_flow("edge.1", "request", "v4-hub-1", from, to, data_in, data_out)
}

#[test]
fn edge_data_flow_adjacent_only() {
    let edge = data_edge(
        "V4HubReqInbound03Normalized",
        "V4HubReqChatProcess04Governed",
        "v4.request.normal_payload",
        "v4.request.normal_payload",
    );
    assert!(validate_edge(
        &edge,
        &nodes(),
        &resources(),
        &[],
        &mut ScopeRegistry::new()
    )
    .is_ok());

    let non_adjacent = data_edge(
        "V4HubReqInbound03Normalized",
        "V4HubReqOutbound05ProviderSemantic",
        "v4.request.normal_payload",
        "v4.request.normal_payload",
    );
    let err = validate_edge(
        &non_adjacent,
        &nodes(),
        &resources(),
        &[],
        &mut ScopeRegistry::new(),
    )
    .unwrap_err();
    assert!(matches!(err, EdgeError::NonAdjacentEdge));
}

#[test]
fn edge_data_flow_resource_axis() {
    let edge = data_edge(
        "V4HubReqInbound03Normalized",
        "V4HubReqChatProcess04Governed",
        "v4.request.normal_payload",
        "v4.request.normal_payload",
    );
    assert!(validate_edge(
        &edge,
        &nodes(),
        &resources(),
        &[],
        &mut ScopeRegistry::new()
    )
    .is_ok());

    let control_on_data = data_edge(
        "V4HubReqInbound03Normalized",
        "V4HubReqChatProcess04Governed",
        "v4.control.side_channel",
        "v4.request.normal_payload",
    );
    let err = validate_edge(
        &control_on_data,
        &nodes(),
        &resources(),
        &[],
        &mut ScopeRegistry::new(),
    )
    .unwrap_err();
    assert!(matches!(err, EdgeError::ResourceAxisMismatch));
}

#[test]
fn edge_information_flow_adjacent_only() {
    let adjacent = EdgeSpec::information_flow(
        "edge.info.1",
        "config",
        "v4-config-1",
        "V4Config01AuthoringFileSource",
        "V4Config02AuthoringParsed",
        "v4.config.authoring",
        "v4.config.parsed",
    );
    assert!(validate_edge(
        &adjacent,
        &nodes(),
        &resources(),
        &[],
        &mut ScopeRegistry::new()
    )
    .is_ok());

    let non_adjacent = EdgeSpec::information_flow(
        "edge.info.bad",
        "config",
        "v4-config-1",
        "V4Config01AuthoringFileSource",
        "V4Config03SchemaValidated",
        "v4.config.authoring",
        "v4.config.parsed",
    );
    let err = validate_edge(
        &non_adjacent,
        &nodes(),
        &resources(),
        &[],
        &mut ScopeRegistry::new(),
    )
    .unwrap_err();
    assert!(matches!(err, EdgeError::NonAdjacentEdge));
}

#[test]
fn edge_information_flow_resource_axis() {
    let mut scopes = ScopeRegistry::new();
    let edge = EdgeSpec::information_flow(
        "edge.info.2",
        "config",
        "v4-config-1",
        "V4Config01AuthoringFileSource",
        "V4Config02AuthoringParsed",
        "v4.config.authoring",
        "v4.config.parsed",
    );
    assert!(validate_edge(&edge, &nodes(), &resources(), &[], &mut scopes).is_ok());

    let bad = EdgeSpec::information_flow(
        "edge.info.bad",
        "config",
        "v4-config-1",
        "V4Config01AuthoringFileSource",
        "V4Config02AuthoringParsed",
        "v4.request.normal_payload",
        "v4.config.parsed",
    );
    let err = validate_edge(&bad, &nodes(), &resources(), &[], &mut scopes).unwrap_err();
    assert!(matches!(err, EdgeError::ResourceAxisMismatch));
}

#[test]
fn edge_control_flow_record_required() {
    let mut scopes = ScopeRegistry::new();
    let edge = EdgeSpec::control_flow(
        "edge.ctrl.1",
        "request",
        "v4-hub-1",
        "V4HubReqChatProcess04Governed",
        "v4.control.side_channel",
        "register",
        "continuation.restore",
        vec!["requestId".to_string()],
        true,
    );
    assert!(validate_edge(&edge, &nodes(), &resources(), &[], &mut scopes).is_ok());

    let bad = EdgeSpec::control_flow(
        "edge.ctrl.bad",
        "request",
        "v4-hub-1",
        "V4HubReqChatProcess04Governed",
        "v4.control.side_channel",
        "register",
        "continuation.restore",
        vec!["requestId".to_string()],
        false,
    );
    let err = validate_edge(&bad, &nodes(), &resources(), &[], &mut scopes).unwrap_err();
    assert!(matches!(err, EdgeError::ControlRecordRequired));
}

#[test]
fn edge_control_flow_scope_isolation() {
    let mut scopes = ScopeRegistry::new();
    let register = EdgeSpec::control_flow(
        "edge.ctrl.reg",
        "request",
        "v4-hub-1",
        "V4HubReqChatProcess04Governed",
        "v4.control.side_channel",
        "register",
        "continuation.restore",
        vec!["req-A".to_string()],
        true,
    );
    validate_edge(&register, &nodes(), &resources(), &[], &mut scopes).unwrap();

    let consume = EdgeSpec::control_flow(
        "edge.ctrl.consume",
        "request",
        "v4-hub-1",
        "V4HubReqChatProcess04Governed",
        "v4.control.side_channel",
        "consume",
        "continuation.restore",
        vec!["req-A".to_string()],
        true,
    );
    assert!(validate_edge(&consume, &nodes(), &resources(), &[], &mut scopes).is_ok());

    let cross_scope = EdgeSpec::control_flow(
        "edge.ctrl.cross",
        "request",
        "v4-hub-1",
        "V4HubReqChatProcess04Governed",
        "v4.control.side_channel",
        "consume",
        "continuation.restore",
        vec!["req-B".to_string()],
        true,
    );
    let err = validate_edge(&cross_scope, &nodes(), &resources(), &[], &mut scopes).unwrap_err();
    assert!(matches!(err, EdgeError::ScopeMismatch));
}

#[test]
fn edge_debug_subscription_read_only() {
    let edge = EdgeSpec::debug_subscription(
        "edge.debug.1",
        "request",
        "v4-hub-1",
        "V4HubReqChatProcess04Governed",
        "v4.debug.bus_subscription",
        "node_event",
        true,
    );
    assert!(validate_edge(
        &edge,
        &nodes(),
        &resources(),
        &[],
        &mut ScopeRegistry::new()
    )
    .is_ok());

    let bad = EdgeSpec::debug_subscription(
        "edge.debug.bad",
        "request",
        "v4-hub-1",
        "V4HubReqChatProcess04Governed",
        "v4.debug.bus_subscription",
        "node_event",
        false,
    );
    let err =
        validate_edge(&bad, &nodes(), &resources(), &[], &mut ScopeRegistry::new()).unwrap_err();
    assert!(matches!(err, EdgeError::DebugSubscriptionNotReadOnly));
}

#[test]
fn edge_error_intake_typed() {
    let mut scopes = ScopeRegistry::new();
    let edge = EdgeSpec::error_intake(
        "edge.err.1",
        "request",
        "v4-hub-1",
        "V4HubReqChatProcess04Governed",
        "v4.control.error_center",
        "chat_process",
        true,
        true,
        true,
    );
    assert!(validate_edge(&edge, &nodes(), &resources(), &[], &mut scopes).is_ok());

    let no_hash = EdgeSpec::error_intake(
        "edge.err.nohash",
        "request",
        "v4-hub-1",
        "V4HubReqChatProcess04Governed",
        "v4.control.error_center",
        "chat_process",
        false,
        true,
        true,
    );
    let err = validate_edge(&no_hash, &nodes(), &resources(), &[], &mut scopes).unwrap_err();
    assert!(matches!(err, EdgeError::ErrorIntakeUnTyped));

    let wrong_target = EdgeSpec::error_intake(
        "edge.err.target",
        "request",
        "v4-hub-1",
        "V4HubReqChatProcess04Governed",
        "v4.control.side_channel",
        "chat_process",
        true,
        true,
        true,
    );
    let err = validate_edge(&wrong_target, &nodes(), &resources(), &[], &mut scopes).unwrap_err();
    assert!(matches!(err, EdgeError::ErrorIntakeWrongTarget));
}

#[test]
fn edge_forbidden_edges() {
    let forbidden = vec![(
        "V4HubReqChatProcess04Governed".to_string(),
        "v4.control.error_center".to_string(),
    )];
    let mut scopes = ScopeRegistry::new();
    let edge = data_edge(
        "V4HubReqInbound03Normalized",
        "V4HubReqChatProcess04Governed",
        "v4.request.normal_payload",
        "v4.request.normal_payload",
    );
    assert!(validate_edge(&edge, &nodes(), &resources(), &forbidden, &mut scopes).is_ok());

    let hit = EdgeSpec::control_flow(
        "edge.err.forbidden",
        "request",
        "v4-hub-1",
        "V4HubReqChatProcess04Governed",
        "v4.control.error_center",
        "register",
        "error.intake",
        vec!["req-A".to_string()],
        true,
    );
    let err = validate_edge(&hit, &nodes(), &resources(), &forbidden, &mut scopes).unwrap_err();
    assert!(matches!(err, EdgeError::ForbiddenEdge));
}

#[test]
fn edge_unknown_node_or_resource_is_red() {
    let edge = data_edge(
        "V4UnknownNode",
        "V4HubReqChatProcess04Governed",
        "v4.request.normal_payload",
        "v4.request.normal_payload",
    );
    let err = validate_edge(
        &edge,
        &nodes(),
        &resources(),
        &[],
        &mut ScopeRegistry::new(),
    )
    .unwrap_err();
    assert!(matches!(err, EdgeError::UnknownNode));

    let bad_resource = data_edge(
        "V4HubReqInbound03Normalized",
        "V4HubReqChatProcess04Governed",
        "v4.unknown.resource",
        "v4.request.normal_payload",
    );
    let err = validate_edge(
        &bad_resource,
        &nodes(),
        &resources(),
        &[],
        &mut ScopeRegistry::new(),
    )
    .unwrap_err();
    assert!(matches!(err, EdgeError::UnknownResource));
}

#[test]
fn edge_kind_enum_covers_contract() {
    let kinds = vec![
        EdgeKind::DataFlow,
        EdgeKind::InformationFlow,
        EdgeKind::ControlFlow,
        EdgeKind::DebugSubscription,
        EdgeKind::ErrorIntake,
    ];
    assert_eq!(kinds.len(), 5);
}
