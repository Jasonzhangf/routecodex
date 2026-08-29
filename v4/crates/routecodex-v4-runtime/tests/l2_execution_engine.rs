use routecodex_v4_runtime::{ExecutionEngine, NodeExecutionFrame, NodeOutcome};
use routecodex_v4_plugin_contract::{NativePlugin, PluginConfig, PluginContext, PluginFailure, PluginIdentity, PluginOutcome};
use std::sync::Arc;

#[test]
fn engine_preserves_adjacent_output_and_terminal_boundary() {
    let engine = ExecutionEngine::new(vec![
        routecodex_v4_runtime::ExecutionNode::continue_with("first", |frame| {
            NodeOutcome::Continue {
                data: serde_json::json!({"value": frame.data["value"].as_i64().unwrap() + 1}),
                control: frame.control,
            }
        }),
        routecodex_v4_runtime::ExecutionNode::terminal("second", |frame| {
            NodeOutcome::Terminal {
                response: serde_json::json!({"value": frame.data["value"]}),
            }
        }),
    ]);
    let frame = NodeExecutionFrame::new(serde_json::json!({"value": 1}), serde_json::json!({}));
    let lease = test_lease();
    let outcome = engine.execute("entry", frame, lease).expect("terminal outcome");
    assert_eq!(outcome, NodeOutcome::Terminal { response: serde_json::json!({"value": 2}) });
}

#[test]
fn engine_rejects_execution_without_a_declared_path() {
    let engine = ExecutionEngine::new(Vec::new());
    let frame = NodeExecutionFrame::new(serde_json::json!({}), serde_json::json!({}));
    let error = engine.execute("missing", frame, test_lease()).expect_err("missing entrypoint must fail");
    assert!(error.to_string().contains("entrypoint"));
}

#[test]
fn branch_follows_only_a_declared_edge_and_failure_stops() {
    let engine = ExecutionEngine::new(vec![
        routecodex_v4_runtime::ExecutionNode::new("first", |_| NodeOutcome::Branch {
            edge_id: "ok".into(),
            data: serde_json::json!({"value": 7}),
            control: serde_json::json!({}),
        }).with_edge("ok", "terminal"),
        routecodex_v4_runtime::ExecutionNode::new("terminal", |frame| NodeOutcome::Terminal {
            response: serde_json::json!({"value": frame.data["value"]}),
        }),
    ]);
    let outcome = engine
        .execute("first", NodeExecutionFrame::new(serde_json::json!({}), serde_json::json!({})), test_lease())
        .unwrap();
    assert_eq!(outcome, NodeOutcome::Terminal { response: serde_json::json!({"value": 7}) });

    let failure_engine = ExecutionEngine::new(vec![routecodex_v4_runtime::ExecutionNode::new("first", |_| {
        NodeOutcome::Failure { error: serde_json::json!({"code": "boom"}) }
    }), routecodex_v4_runtime::ExecutionNode::new("unreachable", |_| {
        panic!("failure must stop the path")
    })]);
    assert!(matches!(failure_engine.execute("first", NodeExecutionFrame::new(serde_json::json!({}), serde_json::json!({})), test_lease()).unwrap(), NodeOutcome::Failure { .. }));
}

struct TerminalPlugin {
    identity: PluginIdentity,
    outcome: Result<PluginOutcome, PluginFailure>,
}

impl NativePlugin for TerminalPlugin {
    fn identity(&self) -> &PluginIdentity { &self.identity }
    fn execute(&self, _context: &PluginContext, _config: &PluginConfig) -> Result<PluginOutcome, PluginFailure> { self.outcome.clone() }
}

#[test]
fn native_plugin_outcome_and_failure_are_projected_without_payload_control() {
    let identity = PluginIdentity::try_new("test.plugin", "1", "sha256:test").unwrap();
    let terminal = routecodex_v4_runtime::ExecutionNode::native(
        "native-terminal",
        Arc::new(TerminalPlugin { identity: identity.clone(), outcome: Ok(PluginOutcome::Terminal) }),
        PluginContext::new("native-terminal", "scope"),
        PluginConfig::empty(),
    );
    let outcome = ExecutionEngine::new(vec![terminal]).execute(
        "entry",
        NodeExecutionFrame::new(serde_json::json!({"answer": 1}), serde_json::json!({"route": "typed"})),
        test_lease(),
    ).unwrap();
    assert_eq!(outcome, NodeOutcome::Terminal { response: serde_json::json!({"answer": 1}) });

    let failure = routecodex_v4_runtime::ExecutionNode::native(
        "native-failure",
        Arc::new(TerminalPlugin { identity, outcome: Err(PluginFailure::Execution("boom".into())) }),
        PluginContext::new("native-failure", "scope"),
        PluginConfig::empty(),
    );
    assert!(matches!(ExecutionEngine::new(vec![failure]).execute(
        "entry",
        NodeExecutionFrame::new(serde_json::json!({}), serde_json::json!({"internal": true})),
        test_lease(),
    ).unwrap(), NodeOutcome::Failure { .. }));
}

#[test]
fn lease_admission_is_pinned_and_disposed_epoch_is_rejected() {
    let plan = routecodex_v4_plugin_plan::NodePluginPlan {
        node_id: "epoch-test".into(), position: 1, role_id: "test".into(), chain: "request".into(),
        entries: vec![], selection_groups: vec![], hash: String::new(),
    };
    let hash = plan.plan_hash();
    let mut container = routecodex_v4_node_container::NodeContainer::declare(
        "epoch-test", routecodex_v4_plugin_plan::NodePluginPlan { hash: hash.clone(), ..plan },
        routecodex_v4_node_container::PlanBindings { graph_hash: hash.clone(), manifest_hash: hash.clone(), loaded_plan_hash: hash },
    ).unwrap();
    container.context_created().unwrap(); container.plugins_mounted().unwrap(); container.publish().unwrap();
    let epoch = routecodex_v4_node_container::ExecutionEpochBundle::new(container,
        routecodex_v4_node_container::ExecutionEpochIdentity { plan_epoch: 1, manifest_hash: "manifest".into(), execution_identity: "epoch-test".into() }).unwrap();
    let store = routecodex_v4_node_container::ActiveEpochStore::new(epoch);
    let lease = store.admit().unwrap();
    assert_eq!(lease.snapshot().plan_epoch, 1);
    let replacement = test_lease();
    drop(replacement);
    let published = store.active_snapshot().unwrap();
    assert_eq!(published.plan_epoch, 1);
    drop(lease);
    assert_eq!(store.active_snapshot().unwrap().state, routecodex_v4_node_container::ExecutionEpochState::Active);
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
        routecodex_v4_plugin_plan::NodePluginPlan { hash: hash.clone(), ..plan },
        routecodex_v4_node_container::PlanBindings {
            graph_hash: hash.clone(),
            manifest_hash: hash.clone(),
            loaded_plan_hash: hash,
        },
    ).unwrap();
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
    ).unwrap();
    routecodex_v4_node_container::ActiveEpochStore::new(epoch).admit().unwrap()
}
