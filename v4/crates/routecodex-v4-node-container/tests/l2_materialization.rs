use routecodex_v4_cordis_bridge::{ExecCtx, HandleRegistry, PluginHandle};
use routecodex_v4_node_container::{materialize_execution_epoch_bundle, MaterializationError};
use routecodex_v4_plugin_contract::{PluginEffect, PluginKind, PluginPhase};
use routecodex_v4_plugin_plan::{NodePluginPlan, PlanEntry};
use serde_json::{json, Value};

const GRAPH_HASH: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const MANIFEST_HASH: &str =
    "sha256:2222222222222222222222222222222222222222222222222222222222222222";

struct NoopHandle;

impl PluginHandle for NoopHandle {
    fn execute(&self, _ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        Ok(())
    }
}

struct Registry;

impl HandleRegistry for Registry {
    fn get(&self, plugin_id: &str) -> Option<&dyn PluginHandle> {
        static HANDLE: NoopHandle = NoopHandle;
        (plugin_id == "noop").then_some(&HANDLE)
    }
}

fn plan(node_id: &str, chain: &str, position: u32) -> NodePluginPlan {
    let plan = NodePluginPlan {
        node_id: node_id.into(),
        position,
        role_id: format!("{chain}_role"),
        chain: chain.into(),
        entries: vec![PlanEntry {
            plugin_id: "noop".into(),
            version: "1".into(),
            kind: PluginKind::Operator,
            effect: PluginEffect::ReadOnly,
            phase: PluginPhase::Validation,
            order: 1,
            selection_group: None,
            reads: vec!["v4.request.normal_payload".into()],
            writes: vec![],
        }],
        selection_groups: vec![],
        hash: String::new(),
    };
    let hash = plan.plan_hash();
    NodePluginPlan { hash, ..plan }
}

fn candidate() -> Value {
    let direct_request = plan("direct-request-1", "direct_request", 1);
    let direct_response = plan("direct-response-1", "direct_response", 1);
    let relay_request = plan("relay-request-1", "relay_request", 1);
    let relay_response = plan("relay-response-1", "relay_response", 1);
    let error = plan("error-1", "error", 1);
    json!({
        "schema_version": 1,
        "candidate_id": "candidate-1",
        "epoch_id": "epoch-1",
        "plan_epoch": 1,
        "manifest_hash": MANIFEST_HASH,
        "graph_hash": GRAPH_HASH,
        "plugin_artifact_set_hash": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        "entrypoints": {
            "direct_request": "direct-request-1",
            "direct_response": "direct-response-1",
            "relay_request": "relay-request-1",
            "relay_response": "relay-response-1",
            "error": "error-1"
        },
        "pipelines": {
            "direct_request": ["direct-request-1"],
            "direct_response": ["direct-response-1"],
            "relay_request": ["relay-request-1"],
            "relay_response": ["relay-response-1"],
            "error": ["error-1"]
        },
        "nodes": [
            {"node_id": "direct-request-1", "plan_hash": direct_request.hash, "input_resource": "direct.request.in", "output_resource": "direct.request.out", "allowed_edges": {}, "plan": direct_request},
            {"node_id": "direct-response-1", "plan_hash": direct_response.hash, "input_resource": "direct.response.in", "output_resource": "direct.response.out", "allowed_edges": {}, "plan": direct_response},
            {"node_id": "relay-request-1", "plan_hash": relay_request.hash, "input_resource": "relay.request.in", "output_resource": "relay.request.out", "allowed_edges": {}, "plan": relay_request},
            {"node_id": "relay-response-1", "plan_hash": relay_response.hash, "input_resource": "relay.response.in", "output_resource": "relay.response.out", "allowed_edges": {}, "plan": relay_response},
            {"node_id": "error-1", "plan_hash": error.hash, "input_resource": "error.in", "output_resource": "error.out", "allowed_edges": {}, "plan": error}
        ],
        "policies": {}
    })
}

#[test]
fn exact_compiled_candidate_materializes_in_cordis_order() {
    let bundle =
        materialize_execution_epoch_bundle(&candidate(), GRAPH_HASH, MANIFEST_HASH, &Registry)
            .expect("exact Cordis candidate materializes");
    let lease = bundle.admit().expect("materialized bundle admits");
    assert_eq!(lease.entrypoint("direct_request").unwrap(), "direct-request-1");
    assert_eq!(lease.entrypoint("direct_response").unwrap(), "direct-response-1");
    assert_eq!(lease.entrypoint("relay_request").unwrap(), "relay-request-1");
    assert_eq!(lease.entrypoint("relay_response").unwrap(), "relay-response-1");
    assert_eq!(lease.entrypoint("error").unwrap(), "error-1");
}

#[test]
fn missing_plan_hash_drift_and_unknown_handle_fail_fast() {
    let mut missing = candidate();
    missing["nodes"][0].as_object_mut().unwrap().remove("plan");
    assert!(matches!(
        materialize_execution_epoch_bundle(&missing, GRAPH_HASH, MANIFEST_HASH, &Registry),
        Err(MaterializationError::Parse(_))
    ));

    let mut drift = candidate();
    drift["nodes"][0]["plan_hash"] = json!(MANIFEST_HASH);
    assert!(matches!(
        materialize_execution_epoch_bundle(&drift, GRAPH_HASH, MANIFEST_HASH, &Registry),
        Err(MaterializationError::PlanHashMismatch(_))
    ));

    let mut unknown = candidate();
    unknown["nodes"][0]["plan"]["entries"][0]["plugin_id"] = json!("missing");
    let plan: NodePluginPlan = serde_json::from_value(unknown["nodes"][0]["plan"].clone()).unwrap();
    unknown["nodes"][0]["plan"]["hash"] = json!(plan.plan_hash());
    unknown["nodes"][0]["plan_hash"] = unknown["nodes"][0]["plan"]["hash"].clone();
    assert!(matches!(
        materialize_execution_epoch_bundle(&unknown, GRAPH_HASH, MANIFEST_HASH, &Registry),
        Err(MaterializationError::UnknownHandle(_))
    ));
}

#[test]
fn pipeline_order_and_external_identity_drift_fail_fast() {
    let mut reordered = candidate();
    reordered["pipelines"]["direct_request"] = json!(["relay-request-1"]);
    assert!(matches!(
        materialize_execution_epoch_bundle(&reordered, GRAPH_HASH, MANIFEST_HASH, &Registry),
        Err(MaterializationError::PipelineMismatch(_))
    ));
    assert!(matches!(
        materialize_execution_epoch_bundle(&candidate(), MANIFEST_HASH, MANIFEST_HASH, &Registry),
        Err(MaterializationError::GraphHashMismatch)
    ));
}
