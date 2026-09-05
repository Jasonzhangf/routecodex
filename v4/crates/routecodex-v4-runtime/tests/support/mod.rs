use routecodex_v4_config::{
    RuntimeProductConfig, RuntimeProductModel, RuntimeProductPool, RuntimeProductProvider,
    RuntimeProductRouteGroup, RuntimeProductTarget,
};
use routecodex_v4_cordis_bridge::{HandleRegistry, PluginHandle};
use routecodex_v4_node_container::{
    ExecutionEpochBundle, ExecutionEpochIdentity, ExecutionEpochNode, NodeContainer, PlanBindings,
    ZERO_BASE_MANIFEST_HASH,
};
use routecodex_v4_router::{TargetSelectionHandle, DIRECT_TARGET_SELECTION_PLUGIN_ID, TARGET_SELECTION_PLUGIN_ID};
use routecodex_v4_runtime::SkeletonRuntime;
use routecodex_v4_standard_plugins::{compile_standard_plan, standard_descriptors, StandardHandleRegistry};
use std::collections::HashMap;
use std::sync::Arc;

struct TestHandleRegistry {
    standard: StandardHandleRegistry,
    target_selection: TargetSelectionHandle,
}

impl TestHandleRegistry {
    fn new() -> Self {
        Self {
            standard: StandardHandleRegistry::new(),
            target_selection: TargetSelectionHandle::new(test_product()),
        }
    }
}

impl HandleRegistry for TestHandleRegistry {
    fn get(&self, plugin_id: &str) -> Option<&dyn PluginHandle> {
        if matches!(
            plugin_id,
            TARGET_SELECTION_PLUGIN_ID | DIRECT_TARGET_SELECTION_PLUGIN_ID
        ) {
            Some(&self.target_selection)
        } else {
            self.standard.get(plugin_id)
        }
    }

    fn encode_client_error_sse(
        &self,
        entry_protocol: &str,
        message: &str,
    ) -> Result<Vec<u8>, String> {
        self.standard
            .encode_client_error_sse(entry_protocol, message)
    }
}

fn test_product() -> RuntimeProductConfig {
    let models = [
        "m",
        "gpt-wire",
        "mock-model",
        "responses-model",
        "admission-model",
    ]
    .into_iter()
    .map(|model| RuntimeProductModel {
        model_id: model.to_string(),
        wire_name: model.to_string(),
        capabilities: Vec::new(),
        aliases: Vec::new(),
    })
    .collect::<Vec<_>>();
    let targets = models
        .iter()
        .map(|model| RuntimeProductTarget {
            provider_id: "mock".to_string(),
            model_id: model.model_id.clone(),
            priority: 1,
            weight: None,
        })
        .collect::<Vec<_>>();
    RuntimeProductConfig {
        source: "v4-runtime-test-product".to_string(),
        providers: vec![RuntimeProductProvider {
            provider_id: "mock".to_string(),
            protocol: "responses".to_string(),
            config_path: "mock-provider.toml".to_string(),
            models,
            auth_handles: Vec::new(),
        }],
        route_groups: vec![RuntimeProductRouteGroup {
            route_group_id: "default".to_string(),
            pools: vec![RuntimeProductPool {
                pool_id: "default-pool".to_string(),
                selection: "priority".to_string(),
                precedence: None,
                entry_protocol: None,
                models: Vec::new(),
                min_input_tokens: None,
                required_capabilities: Vec::new(),
                targets,
            }],
        }],
        default_error_path: Vec::new(),
        error_policies: Vec::new(),
    }
}

pub fn active_runtime(contract_json: &str) -> SkeletonRuntime {
    let plan = routecodex_v4_skeleton::SkeletonPlan::from_contract_json(contract_json)
        .expect("runtime must load contract");
    let runtime = SkeletonRuntime::from_compiled_plan_with_registry(
        plan.clone(),
        Arc::new(TestHandleRegistry::new()),
    )
    .expect("runtime must validate contract");
    let plan = runtime.plan();
    let descriptors = standard_descriptors();
    let mut nodes = Vec::new();
    for chain in plan
        .chains
        .iter()
        .filter(|chain| {
            matches!(
                chain.chain_id.as_str(),
                "direct_request"
                    | "direct_response"
                    | "relay_request"
                    | "relay_response"
                    | "error"
                    | "control"
            )
        })
    {
        for node in &chain.nodes {
            let plugin_ids = descriptors
                .iter()
                .filter(|descriptor| descriptor.node_selector.node_id == node.node_id)
                .map(|descriptor| descriptor.plugin_id.as_str())
                .collect::<Vec<_>>();
            if plugin_ids.is_empty() {
                continue;
            }
            let compiled = compile_standard_plan(
                &node.node_id,
                &node.role_id,
                &chain.chain_id,
                node.position,
                &plugin_ids,
            )
            .expect("test Cordis candidate compiles");
            let hash = compiled.hash.clone();
            let mut container = NodeContainer::declare(
                &node.node_id,
                compiled,
                PlanBindings {
                    graph_hash: hash.clone(),
                    manifest_hash: hash.clone(),
                    loaded_plan_hash: hash,
                },
            )
            .expect("test Cordis candidate declares");
            container.context_created().unwrap();
            container.plugins_mounted().unwrap();
            container.publish().unwrap();
            nodes.push(ExecutionEpochNode::new(container, HashMap::new()));
        }
    }
    let bundle = ExecutionEpochBundle::from_ordered_nodes(
        nodes,
        ExecutionEpochIdentity {
            plan_epoch: plan.plan_epoch,
            manifest_hash: plan.manifest_hash.clone(),
            execution_identity: plan.plan_hash.clone(),
        },
    )
    .expect("test Cordis candidate materializes");
    runtime
        .prepare_execution_epoch(
            "test-cordis-commit",
            0,
            ZERO_BASE_MANIFEST_HASH,
            bundle,
            &plan.manifest_hash,
        )
        .expect("test Cordis candidate prepares");
    runtime
        .commit_execution_epoch("test-cordis-commit")
        .expect("test Cordis candidate commits");
    runtime
}
