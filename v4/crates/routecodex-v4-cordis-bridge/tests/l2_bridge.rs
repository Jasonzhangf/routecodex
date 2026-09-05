//! L2 regression for the Cordis bridge (M3): typed handle dispatch, plan-hash
//! verification and effect write guards. Positive and negative pairs cover:
//! - serial execution in compiled plan order (diagnostic observers run
//!   concurrently and read-only);
//! - control-only plugins may write control but never normal data;
//! - a tampered plan hash is rejected before any handle runs;
//! - an unregistered handle fails fast;
//! - read-only / diagnostic handles cannot write normal data (guard enforced,
//!   no silent leak).

use std::collections::HashMap;

use routecodex_v4_cordis_bridge::{
    compile_node, execute_plan, BridgeError, ExecCtx, HandleRegistry, NodeExecutionInput,
    PluginHandle, ScopeContinuationOwner, ScopeSessionCommand, ScopeSessionOperation,
};
use routecodex_v4_plugin_contract::{
    NodePluginDescriptor, NodeSelector, PluginEffect, PluginKind, PluginPhase, ResourceAxis,
    ResourceEntry, ResourceRegistry,
};
use routecodex_v4_plugin_plan::AuthoringPlugin;
use serde_json::{json, Value};

fn registry() -> ResourceRegistry {
    ResourceRegistry {
        resources: vec![
            ResourceEntry {
                resource_id: "v4.request.normal_payload".to_string(),
                axis: ResourceAxis::Data,
            },
            ResourceEntry {
                resource_id: "v4.control.metadata_center".to_string(),
                axis: ResourceAxis::Control,
            },
            ResourceEntry {
                resource_id: "v4.control.error_chain".to_string(),
                axis: ResourceAxis::Control,
            },
            ResourceEntry {
                resource_id: "v4.control.route_facts".to_string(),
                axis: ResourceAxis::Control,
            },
            ResourceEntry {
                resource_id: "v4.control.scope_command".to_string(),
                axis: ResourceAxis::Control,
            },
            ResourceEntry {
                resource_id: "v4.debug.event_ledger".to_string(),
                axis: ResourceAxis::Diagnostic,
            },
        ],
    }
}

fn allowed_reads() -> Vec<String> {
    vec![
        "v4.request.normal_payload".to_string(),
        "v4.control.metadata_center".to_string(),
        "v4.control.error_chain".to_string(),
        "v4.control.route_facts".to_string(),
        "v4.control.scope_command".to_string(),
        "v4.debug.event_ledger".to_string(),
    ]
}

fn allowed_writes() -> Vec<String> {
    vec![
        "v4.request.normal_payload".to_string(),
        "v4.control.metadata_center".to_string(),
        "v4.control.error_chain".to_string(),
        "v4.control.route_facts".to_string(),
        "v4.control.scope_command".to_string(),
    ]
}

fn authoring_plugin(
    plugin_id: &str,
    kind: PluginKind,
    effect: PluginEffect,
    phase: PluginPhase,
    order: u32,
    reads: Vec<String>,
    writes: Vec<String>,
) -> AuthoringPlugin {
    AuthoringPlugin {
        descriptor: NodePluginDescriptor {
            plugin_id: plugin_id.to_string(),
            version: "0.1.0".to_string(),
            owner: "routecodex-v4-cordis-bridge".to_string(),
            artifact_hash: "a".repeat(64),
            contract_hash: "b".repeat(64),
            kind,
            effect,
            phase,
            order,
            before: vec![],
            after: vec![],
            depends_on: vec![],
            selection_group: None,
            node_selector: NodeSelector {
                role_id: "request_chat_process".to_string(),
                node_id: "V4HubReqChatProcess03Governed".to_string(),
                position: 3,
            },
            services_provided: vec![],
            inject: vec![],
            reads,
            writes,
        },
        enabled: true,
    }
}

fn compile_one_node(authoring: &[AuthoringPlugin]) -> routecodex_v4_plugin_plan::NodePluginPlan {
    compile_node(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        "request",
        3,
        authoring,
        &allowed_reads(),
        &allowed_writes(),
        &registry(),
        &[],
    )
    .expect("node plan compiles")
}

/// Semantic operator that appends its id to the normal-data array.
struct StepHandle {
    id: &'static str,
}

impl PluginHandle for StepHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        let mut data = ctx.read_data().clone();
        let steps = data
            .as_array_mut()
            .ok_or_else(|| "node data must be an array".to_string())?;
        steps.push(Value::String(self.id.to_string()));
        ctx.write_data(data).map_err(|error| error.to_string())
    }
}

/// Control-only plugin: write_data must be rejected by the guard, while its
/// declared control resource remains writable.
struct ControlHandle;

impl PluginHandle for ControlHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        if ctx.write_data(json!({"leak": true})).is_ok() {
            return Err("control-only plugin must not write normal data".to_string());
        }
        let mut metadata = ctx
            .read_control_resource("v4.control.metadata_center")
            .map_err(|error| error.to_string())?
            .cloned()
            .unwrap_or_else(|| json!({}));
        let object = metadata
            .as_object_mut()
            .ok_or_else(|| "metadata center must be an object".to_string())?;
        object.insert(
            "written_by".to_string(),
            Value::String("control".to_string()),
        );
        ctx.write_control_resource("v4.control.metadata_center", metadata)
            .map_err(|error| error.to_string())
    }
}

/// Diagnostic-only observer: emits a fact, must never touch normal data.
struct ObserveHandle;

impl PluginHandle for ObserveHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        ctx.emit("node.observed", "observer saw node");
        if ctx.write_data(json!(1)).is_ok() {
            return Err("diagnostic-only plugin must not write normal data".to_string());
        }
        Ok(())
    }
}

/// Read-only validator whose handle tries to leak a write; the guard must
/// reject it so the node output stays unchanged.
struct LeakyHandle;

impl PluginHandle for LeakyHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        if ctx.write_data(json!(1)).is_ok() {
            return Err("read-only plugin must not write normal data".to_string());
        }
        Ok(())
    }
}

struct MetadataIsolationHandle;

impl PluginHandle for MetadataIsolationHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        let _ = ctx.read_control_resource("v4.control.error_chain");
        let _ = ctx.write_control_resource("v4.control.route_facts", json!({"leaked": true}));
        Ok(())
    }
}

struct ErrorIsolationHandle;

impl PluginHandle for ErrorIsolationHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        let _ = ctx.read_control_resource("v4.control.metadata_center");
        let _ = ctx.write_control_resource("v4.control.metadata_center", json!({"leaked": true}));
        Ok(())
    }
}

struct ErrorWriteHandle;

impl PluginHandle for ErrorWriteHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        let mut error_chain = ctx
            .read_control_resource("v4.control.error_chain")
            .map_err(|error| error.to_string())?
            .cloned()
            .unwrap_or_else(|| json!({}));
        error_chain
            .as_object_mut()
            .ok_or_else(|| "error chain must be an object".to_string())?
            .insert("updated".to_string(), json!(true));
        ctx.write_control_resource("v4.control.error_chain", error_chain)
            .map_err(|error| error.to_string())
    }
}

struct ScopeRoundtripHandle;

impl PluginHandle for ScopeRoundtripHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        let value = json!({
            "entry_protocol": "responses",
            "continuation_owner": "direct",
            "pipeline_id": "pipeline-1",
            "port": 5555,
            "session_scope": "session-1",
            "conversation_scope": "conversation-1",
            "request_id": "request-1",
            "full_input_hash": "sha256:full-input",
            "operation": "bind",
            "sequence": 1
        });
        ctx.write_control_resource("v4.control.scope_command", value)
            .map_err(|error| error.to_string())?;
        ctx.read_control_resource("v4.control.scope_command")
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "scope command slot missing after write".to_string())?;
        Ok(())
    }
}

struct UndeclaredScopeHandle;

impl PluginHandle for UndeclaredScopeHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        let _ = ctx.read_control_resource("v4.control.scope_command");
        let _ = ctx.write_control_resource("v4.control.scope_command", json!({}));
        Ok(())
    }
}

struct MapRegistry {
    handles: HashMap<String, Box<dyn PluginHandle>>,
}

impl MapRegistry {
    fn new() -> Self {
        Self {
            handles: HashMap::new(),
        }
    }

    fn register(mut self, plugin_id: &str, handle: impl PluginHandle + 'static) -> Self {
        self.handles.insert(plugin_id.to_string(), Box::new(handle));
        self
    }
}

impl HandleRegistry for MapRegistry {
    fn get(&self, plugin_id: &str) -> Option<&dyn PluginHandle> {
        self.handles.get(plugin_id).map(|boxed| boxed.as_ref())
    }
}

fn input(data: Value, control: Value) -> NodeExecutionInput {
    NodeExecutionInput {
        data,
        control,
        information: json!({}),
        transport: None,
    }
}

#[test]
fn positive_execution_input_accepts_typed_data_and_control() {
    let decoded: NodeExecutionInput = serde_json::from_value(json!({
        "data": {"steps": []},
        "control": {},
        "information": {},
    }))
    .expect("typed execution input decodes");
    assert_eq!(decoded.data, json!({"steps": []}));
    assert_eq!(decoded.control, json!({}));
}

#[test]
fn negative_execution_input_rejects_undeclared_fields() {
    let error = serde_json::from_value::<NodeExecutionInput>(json!({
        "data": {},
        "control": {},
        "information": {},
        "extra": true,
    }))
    .unwrap_err();
    assert!(error.to_string().contains("unknown field `extra`"));
}

#[test]
fn ordered_serial_execution_in_plan_order_with_read_only_observer() {
    let authoring = vec![
        authoring_plugin(
            "v4.request.a",
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Semantic,
            300,
            vec!["v4.request.normal_payload".to_string()],
            vec!["v4.request.normal_payload".to_string()],
        ),
        authoring_plugin(
            "v4.request.b",
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Semantic,
            400,
            vec!["v4.request.normal_payload".to_string()],
            vec!["v4.request.normal_payload".to_string()],
        ),
        authoring_plugin(
            "v4.request.observe",
            PluginKind::Observer,
            PluginEffect::DiagnosticOnly,
            PluginPhase::Observation,
            900,
            vec!["v4.debug.event_ledger".to_string()],
            vec![],
        ),
    ];
    let plan = compile_one_node(&authoring);
    let registry = MapRegistry::new()
        .register("v4.request.a", StepHandle { id: "a" })
        .register("v4.request.b", StepHandle { id: "b" })
        .register("v4.request.observe", ObserveHandle);

    let output =
        execute_plan(&plan, input(json!([]), json!({})), &registry).expect("node executes");
    assert_eq!(output.data, json!(["a", "b"]));
    assert_eq!(output.control, json!({}));
    assert!(output
        .diagnostics
        .iter()
        .any(|fact| fact.kind == "node.observed"));
    let executed = output
        .diagnostics
        .iter()
        .filter(|fact| fact.kind == "plugin.executed")
        .map(|fact| fact.plugin_id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(executed, vec!["v4.request.a", "v4.request.b"]);
}

#[test]
fn control_only_plugin_writes_control_never_normal_data() {
    let authoring = vec![authoring_plugin(
        "v4.request.control",
        PluginKind::Control,
        PluginEffect::ControlOnly,
        PluginPhase::Control,
        100,
        vec!["v4.control.metadata_center".to_string()],
        vec!["v4.control.metadata_center".to_string()],
    )];
    let plan = compile_one_node(&authoring);
    let registry = MapRegistry::new().register("v4.request.control", ControlHandle);
    let input_data = json!({"unchanged": true});

    let output = execute_plan(&plan, input(input_data.clone(), json!({})), &registry)
        .expect("node executes");
    assert_eq!(output.data, input_data);
    assert_eq!(
        output.control,
        json!({"metadata_center": {"written_by": "control"}})
    );
}

#[test]
fn metadata_only_plugin_cannot_read_error_or_overwrite_route_facts() {
    let authoring = vec![authoring_plugin(
        "v4.request.metadata",
        PluginKind::Control,
        PluginEffect::ControlOnly,
        PluginPhase::Control,
        100,
        vec!["v4.control.metadata_center".to_string()],
        vec!["v4.control.metadata_center".to_string()],
    )];
    let plan = compile_one_node(&authoring);
    let registry = MapRegistry::new().register("v4.request.metadata", MetadataIsolationHandle);
    let error = execute_plan(&plan, input(json!({}), json!({})), &registry)
        .expect_err("caught handle errors cannot bypass resource capabilities");
    assert_eq!(
        error,
        BridgeError::ResourceAccessViolation {
            plugin_id: "v4.request.metadata".to_string(),
            resource_id: "v4.control.error_chain".to_string(),
            operation: "read",
        }
    );
}

#[test]
fn error_only_plugin_cannot_read_or_overwrite_metadata_center() {
    let authoring = vec![authoring_plugin(
        "v4.request.error",
        PluginKind::Control,
        PluginEffect::ControlOnly,
        PluginPhase::Control,
        100,
        vec!["v4.control.error_chain".to_string()],
        vec!["v4.control.error_chain".to_string()],
    )];
    let plan = compile_one_node(&authoring);
    let registry = MapRegistry::new().register("v4.request.error", ErrorIsolationHandle);
    let error = execute_plan(&plan, input(json!({}), json!({})), &registry)
        .expect_err("caught handle errors cannot bypass resource capabilities");
    assert_eq!(
        error,
        BridgeError::ResourceAccessViolation {
            plugin_id: "v4.request.error".to_string(),
            resource_id: "v4.control.metadata_center".to_string(),
            operation: "read",
        }
    );
}

#[test]
fn error_only_plugin_preserves_metadata_center() {
    let authoring = vec![authoring_plugin(
        "v4.request.error",
        PluginKind::Control,
        PluginEffect::ControlOnly,
        PluginPhase::Control,
        100,
        vec!["v4.control.error_chain".to_string()],
        vec!["v4.control.error_chain".to_string()],
    )];
    let plan = compile_one_node(&authoring);
    let registry = MapRegistry::new().register("v4.request.error", ErrorWriteHandle);
    let control = json!({
        "metadata_center": {"scope": "request"},
        "error_chain": {"stage": "source_raised"}
    });

    let output = execute_plan(&plan, input(json!({}), control), &registry)
        .expect("declared error access remains resource scoped");
    assert_eq!(output.control["error_chain"]["updated"], json!(true));
    assert_eq!(
        output.control["metadata_center"],
        json!({"scope": "request"})
    );
}

#[test]
fn scope_command_typed_roundtrip_uses_dedicated_control_slot() {
    let authoring = vec![authoring_plugin(
        "v4.request.scope",
        PluginKind::Control,
        PluginEffect::ControlOnly,
        PluginPhase::Control,
        100,
        vec!["v4.control.scope_command".to_string()],
        vec!["v4.control.scope_command".to_string()],
    )];
    let plan = compile_one_node(&authoring);
    let handles = MapRegistry::new().register("v4.request.scope", ScopeRoundtripHandle);
    let output = execute_plan(
        &plan,
        input(json!({"unchanged": true}), json!({})),
        &handles,
    )
    .expect("typed scope command roundtrip succeeds");
    let scope = ScopeSessionCommand::parse(&output.control["scope_command"])
        .expect("scope command slot remains typed");
    assert_eq!(scope.operation, ScopeSessionOperation::Bind);
    assert_eq!(scope.continuation_owner, ScopeContinuationOwner::Direct);
    assert_eq!(output.data, json!({"unchanged": true}));
}

#[test]
fn scope_command_rejects_unknown_field_and_invalid_operation() {
    let base = json!({
        "entry_protocol": "responses",
        "continuation_owner": "direct",
        "pipeline_id": "pipeline-1",
        "port": 5555,
        "session_scope": "session-1",
        "conversation_scope": "conversation-1",
        "request_id": "request-1",
        "full_input_hash": "sha256:full-input",
        "operation": "bind",
        "sequence": 1
    });
    let mut unknown = base.clone();
    unknown["payload_hint"] = json!(true);
    assert!(matches!(
        ScopeSessionCommand::parse(&unknown),
        Err(BridgeError::Protocol(_))
    ));
    let mut invalid_operation = base;
    invalid_operation["operation"] = json!("replace");
    assert!(matches!(
        ScopeSessionCommand::parse(&invalid_operation),
        Err(BridgeError::Protocol(_))
    ));
}

#[test]
fn undeclared_scope_command_read_write_fails_fast() {
    let authoring = vec![authoring_plugin(
        "v4.request.scope_undeclared",
        PluginKind::Control,
        PluginEffect::ControlOnly,
        PluginPhase::Control,
        100,
        vec!["v4.control.metadata_center".to_string()],
        vec!["v4.control.metadata_center".to_string()],
    )];
    let plan = compile_one_node(&authoring);
    let handles = MapRegistry::new().register("v4.request.scope_undeclared", UndeclaredScopeHandle);
    let error = execute_plan(&plan, input(json!({}), json!({})), &handles)
        .expect_err("undeclared scope access must fail");
    assert_eq!(
        error,
        BridgeError::ResourceAccessViolation {
            plugin_id: "v4.request.scope_undeclared".to_string(),
            resource_id: "v4.control.scope_command".to_string(),
            operation: "read",
        }
    );
}

#[test]
fn tampered_plan_hash_is_rejected_before_handles_run() {
    let authoring = vec![authoring_plugin(
        "v4.request.a",
        PluginKind::Operator,
        PluginEffect::Semantic,
        PluginPhase::Semantic,
        300,
        vec!["v4.request.normal_payload".to_string()],
        vec!["v4.request.normal_payload".to_string()],
    )];
    let mut plan = compile_one_node(&authoring);
    plan.hash = "0".repeat(64);
    let registry = MapRegistry::new().register("v4.request.a", StepHandle { id: "a" });

    let error = execute_plan(&plan, input(json!([]), json!({})), &registry).unwrap_err();
    assert_eq!(error, BridgeError::PlanHashMismatch);
}

#[test]
fn unregistered_handle_fails_fast() {
    let authoring = vec![authoring_plugin(
        "v4.request.ghost",
        PluginKind::Validator,
        PluginEffect::ReadOnly,
        PluginPhase::Validation,
        800,
        vec!["v4.request.normal_payload".to_string()],
        vec![],
    )];
    let plan = compile_one_node(&authoring);
    let registry = MapRegistry::new();

    let error = execute_plan(&plan, input(json!({}), json!({})), &registry).unwrap_err();
    assert_eq!(
        error,
        BridgeError::UnregisteredHandle("v4.request.ghost".to_string())
    );
}

#[test]
fn read_only_handle_cannot_write_normal_data() {
    let authoring = vec![authoring_plugin(
        "v4.request.validate",
        PluginKind::Validator,
        PluginEffect::ReadOnly,
        PluginPhase::Validation,
        800,
        vec!["v4.request.normal_payload".to_string()],
        vec![],
    )];
    let plan = compile_one_node(&authoring);
    let registry = MapRegistry::new().register("v4.request.validate", LeakyHandle);
    let input_data = json!({"stable": true});

    let output = execute_plan(&plan, input(input_data.clone(), json!({})), &registry)
        .expect("node executes without leak");
    assert_eq!(output.data, input_data);
    assert!(output.diagnostics.iter().any(|fact| {
        fact.kind == "plugin.executed" && fact.plugin_id == "v4.request.validate"
    }));
}
