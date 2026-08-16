//! L2 regression for `routecodex-v4-admin`.
//!
//! Positive: typed commands drive the full candidate lifecycle through
//! publish and query returns the read-only runtime snapshot.
//! Negative: empty actor is rejected.

use routecodex_v4_admin::{
    execute, query, AdminCommand, AdminError, AdminQuery, AdminResponse, CreateCandidateCommand,
    PublishCommand, TransitionCommand,
};
use routecodex_v4_plugin_contract::{
    NodePluginDescriptor, NodeSelector, PluginEffect, PluginKind, PluginPhase, ResourceAxis,
    ResourceEntry, ResourceRegistry,
};
use routecodex_v4_plugin_manager::{NullLifecyclePort, PluginManager};
use routecodex_v4_plugin_plan::{compile_node_plan, AuthoringPlugin, NodePluginPlan, PlanError};

fn resource_registry() -> ResourceRegistry {
    ResourceRegistry {
        resources: vec![ResourceEntry {
            resource_id: "v4.request.normal_payload".to_string(),
            axis: ResourceAxis::Data,
        }],
    }
}

fn allowed_reads() -> Vec<String> {
    vec!["v4.request.normal_payload".to_string()]
}

fn allowed_writes() -> Vec<String> {
    vec!["v4.request.normal_payload".to_string()]
}

fn authoring(plugin_id: &str) -> AuthoringPlugin {
    AuthoringPlugin {
        descriptor: NodePluginDescriptor {
            plugin_id: plugin_id.to_string(),
            version: "0.1.0".to_string(),
            owner: "track-b-test".to_string(),
            artifact_hash: "a".repeat(64),
            contract_hash: "b".repeat(64),
            kind: PluginKind::Operator,
            effect: PluginEffect::Semantic,
            phase: PluginPhase::Semantic,
            order: 100,
            before: vec![],
            after: vec![],
            depends_on: vec![],
            selection_group: None,
            node_selector: NodeSelector {
                role_id: "request_inbound".to_string(),
            },
            services_provided: vec![],
            inject: vec![],
            reads: vec!["v4.request.normal_payload".to_string()],
            writes: vec!["v4.request.normal_payload".to_string()],
        },
        enabled: true,
    }
}

fn compile_plan(plugin_id: &str) -> Result<NodePluginPlan, PlanError> {
    compile_node_plan(
        "v4.request.inbound.normalized",
        "request_inbound",
        "request",
        1,
        &[authoring(plugin_id)],
        &allowed_reads(),
        &allowed_writes(),
        &resource_registry(),
        &[],
    )
}

#[test]
fn admin_full_lifecycle_and_readonly_query() {
    let plan = compile_plan("admin-plugin").expect("compile");
    let hash = plan.hash.clone();
    let mut manager = PluginManager::new("admin-actor", NullLifecyclePort::default());

    let created = execute(
        &mut manager,
        AdminCommand::CreateCandidate(CreateCandidateCommand {
            actor: "admin-actor".to_string(),
            candidate_id: "cand-admin".to_string(),
            plan,
            graph_hash: hash.clone(),
            manifest_hash: hash.clone(),
            node_ids: vec!["v4.request.inbound.normalized".to_string()],
        }),
    )
    .expect("create");
    assert!(matches!(created, AdminResponse::Ok { .. }));

    for command in [
        AdminCommand::Compile(TransitionCommand {
            actor: "admin-actor".to_string(),
            candidate_id: "cand-admin".to_string(),
        }),
        AdminCommand::Validate(TransitionCommand {
            actor: "admin-actor".to_string(),
            candidate_id: "cand-admin".to_string(),
        }),
        AdminCommand::MarkSmokePassed(TransitionCommand {
            actor: "admin-actor".to_string(),
            candidate_id: "cand-admin".to_string(),
        }),
    ] {
        assert!(matches!(
            execute(&mut manager, command).expect("transition"),
            AdminResponse::Ok { .. }
        ));
    }

    let published = execute(
        &mut manager,
        AdminCommand::Publish(PublishCommand {
            actor: "admin-actor".to_string(),
            candidate_id: "cand-admin".to_string(),
            expected_base_hash: None,
        }),
    )
    .expect("publish");
    assert!(matches!(published, AdminResponse::Published { .. }));

    let response = query(&mut manager, AdminQuery::InspectRuntime);
    let AdminResponse::Runtime(snapshot) = response else {
        panic!("expected runtime snapshot");
    };
    assert_eq!(
        snapshot.active.as_ref().expect("active").candidate_id,
        "cand-admin"
    );
    assert_eq!(snapshot.container_lifecycle.mounted_node_ids.len(), 1);
    assert!(!snapshot.audit.is_empty());
    assert_eq!(snapshot.active_pointer_kind, "node_plugin_chain");
}

#[test]
fn empty_actor_is_rejected() {
    let plan = compile_plan("admin-plugin-2").expect("compile");
    let hash = plan.hash.clone();
    let mut manager = PluginManager::new("admin-actor", NullLifecyclePort::default());
    let err = execute(
        &mut manager,
        AdminCommand::CreateCandidate(CreateCandidateCommand {
            actor: String::new(),
            candidate_id: "cand-nobody".to_string(),
            plan,
            graph_hash: hash.clone(),
            manifest_hash: hash,
            node_ids: vec!["v4.request.inbound.normalized".to_string()],
        }),
    )
    .expect_err("empty actor rejected");
    assert!(matches!(err, AdminError::UnauthorizedActor));
}
