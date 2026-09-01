use routecodex_v4_node_container::{
    ExecutionEpochBundle, ExecutionEpochIdentity, ExecutionEpochNode, NodeContainer, PlanBindings,
    ZERO_BASE_MANIFEST_HASH,
};
use routecodex_v4_runtime::SkeletonRuntime;
use routecodex_v4_standard_plugins::{compile_standard_plan, standard_descriptors};
use std::collections::HashMap;

pub fn active_runtime(contract_json: &str) -> SkeletonRuntime {
    let runtime = SkeletonRuntime::load(contract_json).expect("runtime must load contract");
    let plan = runtime.plan();
    let descriptors = standard_descriptors();
    let mut nodes = Vec::new();
    for chain in plan
        .chains
        .iter()
        .filter(|chain| {
            matches!(
                chain.chain_id.as_str(),
                "direct_request" | "direct_response" | "relay_request" | "relay_response" | "error"
            )
        })
    {
        for node in &chain.nodes {
            let plugin_ids = descriptors
                .iter()
                .filter(|descriptor| descriptor.node_selector.node_id == node.node_id)
                .filter(|descriptor| {
                    descriptor.plugin_id != "v4.std.chat_process.request_governance"
                        && descriptor.plugin_id != "v4.std.provider.wire_build"
                        && descriptor.plugin_id != "v4.std.protocol.wire_codec_proto"
                        && !descriptor.plugin_id.ends_with("_mock")
                        && !(chain.chain_id == "relay_request"
                            && descriptor.plugin_id.starts_with("v4.std.request.responses_"))
                })
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
