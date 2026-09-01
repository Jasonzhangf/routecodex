//! L2 deterministic plan compilation for the M5 standard plugin library.
//!
//! Positive: per-node authoring over different category plugin sets compiles
//! into distinct deterministic `NodePluginPlan`s; the same semantics compiled
//! from different authoring order produce the same plan hash; every compiled
//! plan verifies. Negative: a protocol selection group with two active
//! variants is rejected, an order tie without a declared relation is
//! rejected, an unauthorized write is rejected and a missing before-target is
//! rejected.

use routecodex_v4_plugin_contract::PluginPhase;
use routecodex_v4_plugin_plan::{compile_node_plan, PlanError};
use routecodex_v4_standard_plugins::{
    compile_standard_plan, standard_authoring, standard_container_services,
    standard_node_allowed_reads, standard_node_allowed_writes, standard_resource_registry,
    PluginCategory,
};

fn compile_authoring(
    node_id: &str,
    role_id: &str,
    chain: &str,
    position: u32,
    authoring: &[routecodex_v4_plugin_plan::AuthoringPlugin],
) -> Result<routecodex_v4_plugin_plan::NodePluginPlan, PlanError> {
    compile_node_plan(
        node_id,
        role_id,
        chain,
        position,
        authoring,
        &standard_node_allowed_reads(node_id),
        &standard_node_allowed_writes(node_id),
        &standard_resource_registry(),
        &standard_container_services(),
    )
}

#[test]
fn positive_different_nodes_compile_distinct_deterministic_plans() {
    let chat_process = compile_standard_plan(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        "request",
        3,
        &[
            "v4.std.chat_process.request_governance",
            "v4.std.diagnostic.debug_observe",
            "v4.std.diagnostic.timing",
            "v4.std.diagnostic.snapshot_record",
        ],
    )
    .expect("chat-process plan compiles");

    let outbound = compile_standard_plan(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        "request",
        7,
        &["v4.std.provider.wire_build"],
    )
    .expect("outbound plan compiles");

    assert!(chat_process.verify());
    assert!(outbound.verify());
    assert_ne!(chat_process.hash, outbound.hash);
    let chat_ids: Vec<&str> = chat_process
        .entries
        .iter()
        .map(|entry| entry.plugin_id.as_str())
        .collect();
    assert_eq!(chat_ids[0], "v4.std.chat_process.request_governance");
}

#[test]
fn positive_same_semantics_different_authoring_order_same_hash() {
    let ids = [
        "v4.std.chat_process.request_governance",
        "v4.std.diagnostic.debug_observe",
        "v4.std.diagnostic.timing",
    ];
    let first = compile_standard_plan(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        "request",
        3,
        &ids,
    )
    .expect("plan a compiles");
    let reversed: Vec<&str> = ids.iter().copied().rev().collect();
    let second = compile_standard_plan(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        "request",
        3,
        &reversed,
    )
    .expect("plan b compiles");
    assert_eq!(first.hash, second.hash, "same semantics -> same plan hash");
}

#[test]
fn positive_every_category_has_registered_plugins() {
    let plugins = routecodex_v4_standard_plugins::standard_plugins();
    for category in [
        PluginCategory::Contracts,
        PluginCategory::Diagnostic,
        PluginCategory::Control,
        PluginCategory::Error,
        PluginCategory::Protocol,
        PluginCategory::ChatProcess,
        PluginCategory::Routing,
        PluginCategory::Provider,
    ] {
        let count = plugins
            .iter()
            .filter(|plugin| plugin.category == category)
            .count();
        assert!(count >= 1, "category {category:?} must ship plugins");
    }
}

#[test]
fn positive_response_chat_process_plan_compiles() {
    let response = compile_standard_plan(
        "V4HubRespChatProcess04Governed",
        "response_chat_process",
        "response",
        4,
        &["v4.std.chat_process.response_governance"],
    )
    .expect("response chat-process plan compiles");

    assert!(response.verify());
    assert_eq!(response.entries.len(), 1);
    assert_eq!(
        response.entries[0].plugin_id,
        "v4.std.chat_process.response_governance"
    );
}

#[test]
fn positive_responses_direct_console_observers_are_bound() {
    let request = compile_standard_plan(
        "V4DirectReq01ClientProtocol",
        "request_inbound",
        "direct_request",
        1,
        &["v4.std.diagnostic.direct_request_payload_console_render"],
    )
    .expect("direct Responses request console plan compiles");
    let response = compile_standard_plan(
        "V4DirectResp01ProviderRaw",
        "response_inbound",
        "direct_response",
        1,
        &["v4.std.diagnostic.direct_response_payload_console_render"],
    )
    .expect("direct Responses response console plan compiles");
    assert!(request.verify());
    assert!(response.verify());
    assert_eq!(request.entries[0].plugin_id, "v4.std.diagnostic.direct_request_payload_console_render");
    assert_eq!(response.entries[0].plugin_id, "v4.std.diagnostic.direct_response_payload_console_render");
}

#[test]
fn negative_selection_group_multi_active_rejected() {
    let mut authoring = standard_authoring(&["v4.std.provider.wire_build"])
        .expect("standard authoring succeeds for known id");
    // Clone the same selection-group variant under a second plugin id so the
    // plan compiler sees two active variants in one group.
    let mut alt = authoring[0].clone();
    alt.descriptor.plugin_id = "v4.std.provider.wire_build_alt".to_string();
    authoring.push(alt);
    let error = compile_authoring(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        "request",
        7,
        &authoring,
    )
    .expect_err("two active selection variants must fail");
    assert!(matches!(error, PlanError::MultiSelection { .. }));
}

#[test]
fn negative_order_tie_without_relation_rejected() {
    let mut authoring = standard_authoring(&[
        "v4.std.chat_process.request_governance",
        "v4.std.diagnostic.debug_observe",
    ])
    .expect("standard authoring succeeds for known ids");
    // Force the same phase + order without a before/after relation.
    authoring[0].descriptor.phase = PluginPhase::Observation;
    authoring[0].descriptor.order = 900;
    let error = compile_authoring(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        "request",
        3,
        &authoring,
    )
    .expect_err("tie must fail");
    assert!(matches!(error, PlanError::Tie { .. }));
}

#[test]
fn negative_unauthorized_write_rejected() {
    let mut authoring = standard_authoring(&["v4.std.chat_process.request_governance"])
        .expect("standard authoring succeeds for known id");
    authoring[0].descriptor.writes = vec!["v4.response.client_wire_payload".to_string()];
    let error = compile_authoring(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        "request",
        3,
        &authoring,
    )
    .expect_err("unauthorized write must fail");
    assert!(matches!(error, PlanError::UnauthorizedWrite { .. }));
}

#[test]
fn negative_missing_before_target_rejected() {
    let mut authoring = standard_authoring(&["v4.std.chat_process.request_governance"])
        .expect("standard authoring succeeds for known id");
    authoring[0].descriptor.before = vec!["v4.std.ghost.plugin".to_string()];
    let error = compile_authoring(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        "request",
        3,
        &authoring,
    )
    .expect_err("missing before target must fail");
    assert!(matches!(error, PlanError::MissingDependency { .. }));
}

#[test]
fn negative_unknown_node_id_rejected() {
    let mut authoring = standard_authoring(&["v4.std.provider.wire_build"])
        .expect("standard authoring succeeds for known id");
    authoring[0].descriptor.node_selector.node_id =
        "V4ProviderReqOutbound06WirePayload".to_string();
    let error = compile_authoring(
        "V4ProviderReqOutbound06WirePayload",
        "request_outbound",
        "request",
        6,
        &authoring,
    )
    .expect_err("retired node id must fail");
    assert!(matches!(error, PlanError::UnknownNode { .. }));
}

#[test]
fn negative_active_node_role_mismatch_rejected() {
    let authoring = standard_authoring(&["v4.std.provider.wire_build"])
        .expect("standard authoring succeeds for known id");
    let error = compile_authoring(
        "V4ProviderReqCompat07ProviderCompat",
        "request_chat_process",
        "request",
        7,
        &authoring,
    )
    .expect_err("active node role mismatch must fail");
    assert!(matches!(error, PlanError::NodeRoleMismatch { .. }));
}

#[test]
fn negative_active_node_position_mismatch_rejected() {
    let authoring = standard_authoring(&["v4.std.provider.wire_build"])
        .expect("standard authoring succeeds for known id");
    let error = compile_authoring(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        "request",
        6,
        &authoring,
    )
    .expect_err("active node position mismatch must fail");
    assert!(matches!(
        error,
        PlanError::NodeSelectorPositionMismatch { .. }
    ));
}

#[test]
fn negative_unknown_plugin_id_returns_typed_plan_error() {
    let error = compile_standard_plan(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        "request",
        3,
        &["v4.std.ghost.plugin"],
    )
    .expect_err("unknown standard plugin id must surface as typed plan error");
    assert!(matches!(error, PlanError::UnregisteredOperator(_)));
}

#[test]
fn negative_non_adjacent_provider_semantic_reversal_rejected() {
    let mut authoring = standard_authoring(&["v4.std.provider.wire_build"])
        .expect("standard authoring succeeds for known id");
    authoring[0].descriptor.writes = vec!["v4.request.normal_payload".to_string()];
    let error = compile_authoring(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        "request",
        7,
        &authoring,
    )
    .expect_err("provider semantic must not reverse into normal payload");
    assert!(matches!(error, PlanError::UnauthorizedWrite { .. }));
}
