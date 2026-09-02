use routecodex_v4_cordis_bridge::{ExecCtx, HandleRegistry, PluginHandle};
use routecodex_v4_runtime::{ExecutionEngine, NodeExecutionFrame, NodeOutcome};

#[test]
fn engine_executes_exact_lease_order_and_preserves_adjacent_frame() {
    let lease = ordered_test_lease();
    let outcome = ExecutionEngine::execute_pinned_node(
        "request",
        NodeExecutionFrame::new(
            serde_json::json!({"value": 1}),
            serde_json::json!({"route_facts": {"group": "thinking"}}),
        ),
        &lease,
        &IncrementRegistry,
    )
    .expect("lease-bound chain executes");
    assert_eq!(
        outcome,
        NodeOutcome::Continue {
            data: serde_json::json!({"value": 3}),
            control: serde_json::json!({"route_facts": {"group": "thinking"}}),
            information: serde_json::json!({}),
            events: vec![
                routecodex_v4_cordis_bridge::DiagnosticFact {
                    kind: "plugin.executed".into(),
                    plugin_id: "increment".into(),
                    message: "typed handle executed".into(),
                },
                routecodex_v4_cordis_bridge::DiagnosticFact {
                    kind: "plugin.executed".into(),
                    plugin_id: "increment".into(),
                    message: "typed handle executed".into(),
                },
            ],
        }
    );
}

#[test]
fn engine_rejects_execution_without_a_declared_path() {
    let lease = test_lease();
    let error = ExecutionEngine::execute_pinned_node(
        "missing",
        NodeExecutionFrame::new(serde_json::json!({}), serde_json::json!({})),
        &lease,
        &EmptyRegistry,
    )
    .expect_err("missing entrypoint must fail");
    assert!(error.to_string().contains("chain"));
}

#[test]
fn pinned_bridge_abi_preserves_typed_data_and_control() {
    let plan = routecodex_v4_plugin_plan::NodePluginPlan {
        node_id: "bridge-node".into(),
        position: 1,
        role_id: "test".into(),
        chain: "request".into(),
        entries: vec![],
        selection_groups: vec![],
        hash: String::new(),
    };
    let hash = plan.plan_hash();
    let mut container = routecodex_v4_node_container::NodeContainer::declare(
        "bridge-node",
        routecodex_v4_plugin_plan::NodePluginPlan {
            hash: hash.clone(),
            ..plan
        },
        routecodex_v4_node_container::PlanBindings {
            graph_hash: hash.clone(),
            manifest_hash: hash.clone(),
            loaded_plan_hash: hash,
        },
    )
    .unwrap();
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    let epoch = routecodex_v4_node_container::ExecutionEpochBundle::new(
        container,
        routecodex_v4_node_container::ExecutionEpochIdentity {
            plan_epoch: 1,
            manifest_hash: "manifest".into(),
            execution_identity: "bridge-node".into(),
        },
    )
    .unwrap();
    let lease = routecodex_v4_node_container::ActiveEpochStore::new(epoch)
        .admit()
        .unwrap();
    let outcome = ExecutionEngine::execute_pinned_node(
        "request",
        NodeExecutionFrame::new(
            serde_json::json!({"answer": 1}),
            serde_json::json!({"route": "typed"}),
        ),
        &lease,
        &EmptyRegistry,
    )
    .unwrap();
    assert_eq!(
        outcome,
        NodeOutcome::Continue {
            data: serde_json::json!({"answer": 1}),
            control: serde_json::json!({"route": "typed"}),
            information: serde_json::json!({}),
            events: vec![],
        }
    );
}

struct EmptyRegistry;

impl HandleRegistry for EmptyRegistry {
    fn get(&self, _plugin_id: &str) -> Option<&dyn PluginHandle> {
        None
    }
}

struct IncrementHandle;

impl PluginHandle for IncrementHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &serde_json::Value) -> Result<(), String> {
        let value = ctx.read_data()["value"]
            .as_i64()
            .ok_or_else(|| "value must be an integer".to_string())?;
        ctx.write_data(serde_json::json!({"value": value + 1}))
            .map_err(|error| error.to_string())
    }
}

struct IncrementRegistry;

impl HandleRegistry for IncrementRegistry {
    fn get(&self, plugin_id: &str) -> Option<&dyn PluginHandle> {
        static HANDLE: IncrementHandle = IncrementHandle;
        (plugin_id == "increment").then_some(&HANDLE)
    }
}

fn ordered_test_lease() -> routecodex_v4_node_container::EpochLease {
    use std::collections::HashMap;

    let first = accepting_container("first", 1, "increment");
    let second = accepting_container("second", 2, "increment");
    let epoch = routecodex_v4_node_container::ExecutionEpochBundle::from_ordered_nodes(
        vec![
            routecodex_v4_node_container::ExecutionEpochNode::new(first, HashMap::new()),
            routecodex_v4_node_container::ExecutionEpochNode::new(second, HashMap::new()),
        ],
        routecodex_v4_node_container::ExecutionEpochIdentity {
            plan_epoch: 1,
            manifest_hash: "manifest".into(),
            execution_identity: "ordered-test".into(),
        },
    )
    .unwrap();
    routecodex_v4_node_container::ActiveEpochStore::new(epoch)
        .admit()
        .unwrap()
}

fn accepting_container(
    node_id: &str,
    position: u32,
    plugin_id: &str,
) -> routecodex_v4_node_container::NodeContainer {
    let plan = routecodex_v4_plugin_plan::NodePluginPlan {
        node_id: node_id.into(),
        position,
        role_id: "test".into(),
        chain: "request".into(),
        entries: vec![routecodex_v4_plugin_plan::PlanEntry {
            plugin_id: plugin_id.into(),
            version: "1".into(),
            kind: routecodex_v4_plugin_contract::PluginKind::Operator,
            effect: routecodex_v4_plugin_contract::PluginEffect::Semantic,
            phase: routecodex_v4_plugin_contract::PluginPhase::Semantic,
            order: 1,
            selection_group: None,
            reads: vec!["v4.request.normal_payload".into()],
            writes: vec!["v4.request.normal_payload".into()],
        }],
        selection_groups: vec![],
        hash: String::new(),
    };
    let hash = plan.plan_hash();
    let mut container = routecodex_v4_node_container::NodeContainer::declare(
        node_id,
        routecodex_v4_plugin_plan::NodePluginPlan {
            hash: hash.clone(),
            ..plan
        },
        routecodex_v4_node_container::PlanBindings {
            graph_hash: hash.clone(),
            manifest_hash: hash.clone(),
            loaded_plan_hash: hash,
        },
    )
    .unwrap();
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    container
}

#[test]
fn lease_admission_is_pinned_and_disposed_epoch_is_rejected() {
    let plan = routecodex_v4_plugin_plan::NodePluginPlan {
        node_id: "epoch-test".into(),
        position: 1,
        role_id: "test".into(),
        chain: "request".into(),
        entries: vec![],
        selection_groups: vec![],
        hash: String::new(),
    };
    let hash = plan.plan_hash();
    let mut container = routecodex_v4_node_container::NodeContainer::declare(
        "epoch-test",
        routecodex_v4_plugin_plan::NodePluginPlan {
            hash: hash.clone(),
            ..plan
        },
        routecodex_v4_node_container::PlanBindings {
            graph_hash: hash.clone(),
            manifest_hash: hash.clone(),
            loaded_plan_hash: hash,
        },
    )
    .unwrap();
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    let epoch = routecodex_v4_node_container::ExecutionEpochBundle::new(
        container,
        routecodex_v4_node_container::ExecutionEpochIdentity {
            plan_epoch: 1,
            manifest_hash: "manifest".into(),
            execution_identity: "epoch-test".into(),
        },
    )
    .unwrap();
    let store = routecodex_v4_node_container::ActiveEpochStore::new(epoch);
    let lease = store.admit().unwrap();
    assert_eq!(lease.snapshot().plan_epoch, 1);
    let replacement = test_lease();
    drop(replacement);
    let published = store.active_snapshot().unwrap();
    assert_eq!(published.plan_epoch, 1);
    drop(lease);
    assert_eq!(
        store.active_snapshot().unwrap().state,
        routecodex_v4_node_container::ExecutionEpochState::Active
    );
}

fn test_lease() -> routecodex_v4_node_container::EpochLease {
    let plan = routecodex_v4_plugin_plan::NodePluginPlan {
        node_id: "engine-test".into(),
        position: 1,
        role_id: "test".into(),
        chain: "request".into(),
        entries: vec![],
        selection_groups: vec![],
        hash: String::new(),
    };
    let hash = plan.plan_hash();
    let mut container = routecodex_v4_node_container::NodeContainer::declare(
        "engine-test",
        routecodex_v4_plugin_plan::NodePluginPlan {
            hash: hash.clone(),
            ..plan
        },
        routecodex_v4_node_container::PlanBindings {
            graph_hash: hash.clone(),
            manifest_hash: hash.clone(),
            loaded_plan_hash: hash,
        },
    )
    .unwrap();
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    let epoch = routecodex_v4_node_container::ExecutionEpochBundle::new(
        container,
        routecodex_v4_node_container::ExecutionEpochIdentity {
            plan_epoch: 1,
            manifest_hash: "manifest".into(),
            execution_identity: "engine-test".into(),
        },
    )
    .unwrap();
    routecodex_v4_node_container::ActiveEpochStore::new(epoch)
        .admit()
        .unwrap()
}
