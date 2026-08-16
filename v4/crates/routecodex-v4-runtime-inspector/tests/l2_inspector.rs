//! L2 regression for `routecodex-v4-runtime-inspector`.
//!
//! Positive: snapshot projects active/candidate/failed/lifecycle/audit
//! without payload fields.
//! Negative: a failed candidate is never surfaced as active.

use routecodex_v4_plugin_contract::{
    NodePluginDescriptor, NodeSelector, PluginEffect, PluginKind, PluginPhase, ResourceAxis,
    ResourceEntry, ResourceRegistry,
};
use routecodex_v4_plugin_manager::{CandidateId, NullLifecyclePort, PluginManager};
use routecodex_v4_plugin_plan::{compile_node_plan, AuthoringPlugin, NodePluginPlan, PlanError};
use routecodex_v4_runtime_inspector::snapshot;

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
fn snapshot_projects_management_state_only() {
    let plan = compile_plan("inspector-plugin").expect("compile");
    let hash = plan.hash.clone();
    let manager = PluginManager::new("inspector-actor", NullLifecyclePort::default());
    manager
        .create_candidate(
            CandidateId("cand-i".to_string()),
            plan,
            hash.clone(),
            hash,
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect("create");
    manager.compile("cand-i").expect("compile");
    manager.validate("cand-i").expect("validate");
    manager.mark_smoke_passed("cand-i").expect("smoke");
    manager.publish("cand-i", None).expect("publish");

    let snap = snapshot(&manager);
    assert_eq!(snap.active.as_ref().expect("active").candidate_id, "cand-i");
    assert_eq!(snap.candidates.len(), 1);
    assert!(snap.failed.is_empty());
    assert_eq!(snap.container_lifecycle.mounted_node_ids.len(), 1);
    assert!(!snap.audit.is_empty());

    let text = serde_json::to_string(&snap).expect("serializable");
    for forbidden in [
        "normal_payload",
        "metadata_center",
        "secret",
        "native_handle",
    ] {
        assert!(
            !text.contains(forbidden),
            "inspector projection leaked {forbidden}"
        );
    }
}

#[test]
fn failed_candidate_never_appears_as_active() {
    let plan = compile_plan("inspector-plugin-2").expect("compile");
    let hash = plan.hash.clone();
    let manager = PluginManager::new("inspector-actor", NullLifecyclePort::default());
    manager
        .create_candidate(
            CandidateId("cand-f".to_string()),
            plan,
            hash.clone(),
            hash,
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect("create");
    manager
        .mark_failed("cand-f", "typed error")
        .expect("mark failed");
    let snap = snapshot(&manager);
    assert!(snap.active.is_none());
    assert_eq!(snap.failed.len(), 1);
    assert_eq!(snap.failed[0].id, "cand-f");
}
