//! L2 NodeContainer blackbox for the M5 standard plugin library.
//!
//! Positive: a compiled standard plan with three-way hash bindings declares,
//! publishes and executes through `NodeContainer` with
//! `StandardHandleRegistry`; typed output carries data + control +
//! diagnostics; lifecycle reaches disposed. Control/error/diagnostic facts
//! stay in typed side channels and never enter normal data. Negative: plan
//! hash drift, unregistered handles and execute-before-publish fail fast.

use routecodex_v4_cordis_bridge::{BridgeError, NodeExecutionInput};
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_plugin_plan::{compile_node_plan, PlanError};
use routecodex_v4_standard_plugins::{
    compile_standard_plan, standard_authoring, standard_container_services,
    standard_node_allowed_reads, standard_node_allowed_writes, standard_resource_registry,
    StandardHandleRegistry,
};
use serde_json::{json, Value};

fn plan_bindings(plan: &routecodex_v4_plugin_plan::NodePluginPlan) -> PlanBindings {
    let hash = plan.plan_hash();
    PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash,
    }
}

fn chat_process_plan() -> routecodex_v4_plugin_plan::NodePluginPlan {
    compile_standard_plan(
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
    .expect("chat-process plan compiles")
}

fn publish_container(mut container: NodeContainer) -> NodeContainer {
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    container
}

fn request_data() -> Value {
    json!({
        "requestId": "req-1",
        "messages": [{"role": "user", "content": "hello"}]
    })
}

#[test]
fn positive_blackbox_execute_standard_plan_through_node_container() {
    let plan = chat_process_plan();
    let hash = plan.plan_hash();
    let bindings = plan_bindings(&plan);
    let mut container = NodeContainer::declare("V4HubReqChatProcess03Governed", plan, bindings)
        .expect("three-way hash binding passes");
    container = publish_container(container);

    let registry = StandardHandleRegistry::new();
    let output = container
        .execute_with_plan_hash(
            &hash,
            NodeExecutionInput {
                data: request_data(),
                control: json!({}),
                information: json!({}),
            },
            &registry,
        )
        .expect("standard plan executes through typed bridge");

    // Data carries the deterministic governance marker only; control markers
    // stay in the control side channel.
    let data = output.data.as_object().expect("data is object");
    assert_eq!(data["governance"], json!("request_governance"));
    assert!(data.get("control").is_none(), "control never enters data");
    assert!(
        data.get("metadata_center").is_none(),
        "metadata center never enters data"
    );
    assert!(
        data.get("error_chain").is_none(),
        "error chain never enters data"
    );
    assert!(
        data.get("diagnostics").is_none(),
        "diagnostics never enter data"
    );

    assert_eq!(
        output.control,
        json!({}),
        "control side channel stays typed"
    );

    let kinds: Vec<&str> = output
        .diagnostics
        .iter()
        .map(|fact| fact.kind.as_str())
        .collect();
    assert!(
        kinds.iter().any(|kind| *kind == "node.debug_observe"),
        "debug fact present: {kinds:?}"
    );
    assert!(
        kinds.iter().any(|kind| *kind == "node.timing"),
        "timing fact present: {kinds:?}"
    );
    assert!(
        kinds.iter().any(|kind| *kind == "node.snapshot"),
        "snapshot fact present: {kinds:?}"
    );

    container.drain().expect("no in-flight executions");
    container.dispose().expect("dispose from draining");
}

#[test]
fn positive_error_plugin_writes_typed_error_side_channel_only() {
    let plan = compile_standard_plan(
        "V4Error01SourceRaised",
        "error_source",
        "error",
        1,
        &["v4.std.error.typed_intake"],
    )
    .expect("error-source plan compiles");
    let hash = plan.plan_hash();
    let mut container =
        NodeContainer::declare("V4Error01SourceRaised", plan.clone(), plan_bindings(&plan))
            .expect("binding passes");
    container = publish_container(container);

    let registry = StandardHandleRegistry::new();
    let output = container
        .execute_with_plan_hash(
            &hash,
            NodeExecutionInput {
                data: request_data(),
                control: json!({
                    "error_chain": {"code": "provider_failure"}
                }),
                information: json!({}),
            },
            &registry,
        )
        .expect("error intake executes");

    let control = output.control.as_object().expect("control is object");
    let chain = control
        .get("error_chain")
        .expect("typed error intake recorded in error chain");
    assert_eq!(chain["stage"], "source_raised");
    assert_eq!(chain["kind"], "keyless_mock");
    assert!(
        output
            .data
            .as_object()
            .unwrap()
            .get("error_chain")
            .is_none(),
        "error chain never enters normal data"
    );

    container.drain().unwrap();
    container.dispose().unwrap();
}

#[test]
fn positive_response_governance_preserves_response_data() {
    let plan = compile_standard_plan(
        "V4HubRespChatProcess04Governed",
        "response_chat_process",
        "response",
        4,
        &["v4.std.chat_process.response_governance"],
    )
    .expect("response plan compiles");
    let hash = plan.plan_hash();
    let mut container = NodeContainer::declare(
        "V4HubRespChatProcess04Governed",
        plan.clone(),
        plan_bindings(&plan),
    )
    .expect("binding passes");
    container = publish_container(container);

    let registry = StandardHandleRegistry::new();
    let input = request_data();
    let output = container
        .execute_with_plan_hash(
            &hash,
            NodeExecutionInput {
                data: input.clone(),
                control: json!({}),
                information: json!({}),
            },
            &registry,
        )
        .expect("response governance executes");

    assert_eq!(output.data, input);
    assert_eq!(output.control, json!({}));
    assert_eq!(output.diagnostics[0].kind, "response_governance");

    container.drain().unwrap();
    container.dispose().unwrap();
}

#[test]
fn negative_execute_rejects_plan_hash_drift() {
    let plan = chat_process_plan();
    let mut container = NodeContainer::declare(
        "V4HubReqChatProcess03Governed",
        plan.clone(),
        plan_bindings(&plan),
    )
    .expect("binding passes");
    container = publish_container(container);
    let registry = StandardHandleRegistry::new();
    let error = container
        .execute_with_plan_hash(
            "0".repeat(64).as_str(),
            NodeExecutionInput {
                data: request_data(),
                control: json!({}),
                information: json!({}),
            },
            &registry,
        )
        .expect_err("caller-named hash drift must fail fast");
    assert!(matches!(error, NodeContainerError::PlanHashMismatch));
}

#[test]
fn negative_scope_consume_rejects_non_object_control() {
    let plan = compile_standard_plan(
        "V4MetadataCenter01ScopeRegistry",
        "control_center",
        "control",
        0,
        &["v4.std.control.scope_consume"],
    )
    .expect("scope plan compiles");
    let hash = plan.plan_hash();
    let mut container = NodeContainer::declare(
        "V4MetadataCenter01ScopeRegistry",
        plan.clone(),
        plan_bindings(&plan),
    )
    .expect("binding passes");
    container = publish_container(container);
    let registry = StandardHandleRegistry::new();
    let error = container
        .execute_with_plan_hash(
            &hash,
            NodeExecutionInput {
                data: json!({}),
                control: json!("scalar"),
                information: json!({}),
            },
            &registry,
        )
        .expect_err("non-object control must surface as typed bridge failure");
    assert!(
        matches!(
            error,
            NodeContainerError::Bridge(BridgeError::ResourceAccessViolation { .. })
        ),
        "expected typed ResourceAccessViolation, got {error:?}"
    );
    container.drain().unwrap();
    container.dispose().unwrap();
}

#[test]
fn positive_scope_consume_records_object_control_carrier() {
    let plan = compile_standard_plan(
        "V4MetadataCenter01ScopeRegistry",
        "control_center",
        "control",
        0,
        &["v4.std.control.scope_consume"],
    )
    .expect("scope plan compiles");
    let hash = plan.plan_hash();
    let mut container = NodeContainer::declare(
        "V4MetadataCenter01ScopeRegistry",
        plan.clone(),
        plan_bindings(&plan),
    )
    .expect("binding passes");
    container = publish_container(container);
    let registry = StandardHandleRegistry::new();
    let output = container
        .execute_with_plan_hash(
            &hash,
            NodeExecutionInput {
                data: json!({}),
                control: json!({
                    "metadata_center": {"scope_id": "scope-1"},
                    "error_chain": {"stage": "source_raised"},
                    "route_facts": {"selected": false}
                }),
                information: json!({}),
            },
            &registry,
        )
        .expect("scope carrier executes on typed object control");
    let control = output.control.as_object().expect("control is object");
    assert_eq!(control["metadata_center"]["scope"]["consumed"], json!(true));
    assert_eq!(
        control["error_chain"],
        json!({"stage": "source_raised"}),
        "metadata-only handle cannot overwrite the error resource"
    );
    assert_eq!(
        control["route_facts"],
        json!({"selected": false}),
        "metadata-only handle cannot overwrite route facts"
    );
    container.drain().unwrap();
    container.dispose().unwrap();
}

#[test]
fn negative_error_intake_rejects_non_object_control() {
    let plan = compile_standard_plan(
        "V4Error01SourceRaised",
        "error_source",
        "error",
        1,
        &["v4.std.error.typed_intake"],
    )
    .expect("error plan compiles");
    let hash = plan.plan_hash();
    let mut container =
        NodeContainer::declare("V4Error01SourceRaised", plan.clone(), plan_bindings(&plan))
            .expect("binding passes");
    container = publish_container(container);
    let registry = StandardHandleRegistry::new();
    let error = container
        .execute_with_plan_hash(
            &hash,
            NodeExecutionInput {
                data: json!({}),
                control: json!([1, 2, 3]),
                information: json!({}),
            },
            &registry,
        )
        .expect_err("non-object control must fail typed error intake");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::ResourceAccessViolation { .. })
    ));
    container.drain().unwrap();
    container.dispose().unwrap();
}

fn assert_missing_control_resource_fails(
    node_id: &str,
    role_id: &str,
    chain: &str,
    position: u32,
    plugin_id: &str,
    resource_name: &str,
) {
    let plan = compile_standard_plan(node_id, role_id, chain, position, &[plugin_id])
        .expect("standard plan compiles");
    let hash = plan.plan_hash();
    let mut container = NodeContainer::declare(node_id, plan.clone(), plan_bindings(&plan))
        .expect("binding passes");
    container = publish_container(container);
    let registry = StandardHandleRegistry::new();
    let error = container
        .execute_with_plan_hash(
            &hash,
            NodeExecutionInput {
                data: json!({}),
                control: json!({}),
                information: json!({}),
            },
            &registry,
        )
        .expect_err("missing typed control resource must fail fast");
    assert!(
        matches!(
            &error,
            NodeContainerError::Bridge(BridgeError::HandleError { message, .. })
                if message.contains(resource_name)
                    && message.contains("requires existing typed")
        ),
        "expected explicit missing {resource_name} failure, got {error:?}"
    );
    container.drain().unwrap();
    container.dispose().unwrap();
}

#[test]
fn negative_scope_consume_rejects_missing_metadata_center() {
    assert_missing_control_resource_fails(
        "V4MetadataCenter01ScopeRegistry",
        "control_center",
        "control",
        0,
        "v4.std.control.scope_consume",
        "metadata center",
    );
}

#[test]
fn negative_payload_cycle_record_rejects_missing_payload_cycle() {
    assert_missing_control_resource_fails(
        "V4PayloadCycleRegistry",
        "control_center",
        "control",
        0,
        "v4.std.control.payload_cycle_record",
        "payload cycle",
    );
}

#[test]
fn negative_error_intake_rejects_missing_error_chain() {
    assert_missing_control_resource_fails(
        "V4Error01SourceRaised",
        "error_source",
        "error",
        1,
        "v4.std.error.typed_intake",
        "error chain",
    );
}

#[test]
fn negative_error_projection_rejects_missing_error_chain() {
    assert_missing_control_resource_fails(
        "V4Error06ClientProjected",
        "error_projection",
        "error",
        6,
        "v4.std.error.projection_adapter",
        "error chain",
    );
}

#[test]
fn negative_unregistered_handle_fails_fast() {
    let mut authoring = standard_authoring(&["v4.std.chat_process.request_governance"])
        .expect("standard authoring succeeds for known id");
    authoring[0].descriptor.plugin_id = "v4.real.product.plugin".to_string();
    let plan = compile_node_plan(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        "request",
        3,
        &authoring,
        &standard_node_allowed_reads("V4HubReqChatProcess03Governed"),
        &standard_node_allowed_writes("V4HubReqChatProcess03Governed"),
        &standard_resource_registry(),
        &standard_container_services(),
    )
    .expect("plan with unknown plugin id compiles");
    let hash = plan.plan_hash();
    let mut container = NodeContainer::declare(
        "V4HubReqChatProcess03Governed",
        plan,
        PlanBindings {
            graph_hash: hash.clone(),
            manifest_hash: hash.clone(),
            loaded_plan_hash: hash.clone(),
        },
    )
    .expect("binding passes");
    container = publish_container(container);
    let registry = StandardHandleRegistry::new();
    let error = container
        .execute_with_plan_hash(
            &hash,
            NodeExecutionInput {
                data: request_data(),
                control: json!({}),
                information: json!({}),
            },
            &registry,
        )
        .expect_err("unknown plugin id must fail as unregistered handle");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::UnregisteredHandle(_))
    ));
}

#[test]
fn negative_execute_before_publish_is_rejected() {
    let plan = chat_process_plan();
    let mut container = NodeContainer::declare(
        "V4HubReqChatProcess03Governed",
        plan.clone(),
        plan_bindings(&plan),
    )
    .expect("binding passes");
    container.context_created().unwrap();
    let registry = StandardHandleRegistry::new();
    let error = container
        .execute(
            NodeExecutionInput {
                data: request_data(),
                control: json!({}),
                information: json!({}),
            },
            &registry,
        )
        .expect_err("execute before publish must fail");
    assert!(matches!(error, NodeContainerError::InvalidState { .. }));
}

#[test]
fn negative_effect_violation_diagnostic_write_data_is_rejected() {
    // A diagnostic-only plan entry whose handle tries to write normal data is
    // rejected by the typed bridge write guard — never silently stripped.
    let mut authoring = standard_authoring(&["v4.std.diagnostic.debug_observe"])
        .expect("standard authoring succeeds for known id");
    authoring[0].descriptor.writes = vec!["v4.debug.event_ledger".to_string()];
    let error = compile_node_plan(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        "request",
        3,
        &authoring,
        &standard_node_allowed_reads("V4HubReqChatProcess03Governed"),
        &standard_node_allowed_writes("V4HubReqChatProcess03Governed"),
        &standard_resource_registry(),
        &standard_container_services(),
    )
    .expect_err("diagnostic plugin declaring a write must fail contract validation");
    assert!(matches!(error, PlanError::InvalidPlugin { .. }));
}
