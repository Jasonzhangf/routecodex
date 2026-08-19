//! V4 standard plugin library — deterministic Node 01-07 request chain.
//!
//! This crate owns the immutable standard plugin descriptors, deterministic
//! artifact/contract bytes, catalog registration and typed handle registry
//! for the V4 NodeContainer bridge. Request plugins own the adjacent protocol,
//! Chat Process, VR, provider semantic/compat, and wire validation stages;
//! credentials and transport remain provider-owned.
//!
//! Hard boundaries:
//! - control, error and diagnostic facts travel only in typed side channels;
//! - plugin failures propagate as typed bridge errors, never as fallback or
//!   silent strip;
//! - this crate never creates a second runtime/kernel and never dispatches
//!   across nodes.

use std::collections::HashMap;

use routecodex_v4_cordis_bridge::{ExecCtx, HandleRegistry, PluginHandle};
use routecodex_v4_plugin_catalog::{CatalogEntry, PluginCatalog};
use routecodex_v4_plugin_contract::{
    canonical_json, descriptor_contract_hash, NodePluginDescriptor, NodeSelector, PluginEffect,
    PluginKind, PluginPhase, ResourceAxis, ResourceEntry, ResourceRegistry,
};
use routecodex_v4_plugin_plan::{compile_node_plan, AuthoringPlugin, NodePluginPlan};
use routecodex_v4_provider::{project_provider_compat, validate_provider_wire_payload};
use routecodex_v4_router::{
    admit_entry_model, filter_candidates, select_target, ProviderCandidate, SelectedTarget,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub mod chat_process;
pub mod contracts;
pub mod control;
pub mod diagnostic;
pub mod error;
pub mod protocol;
pub mod provider;
pub mod routing;

pub const STANDARD_LIBRARY_VERSION: &str = "0.1.0";
pub const STANDARD_LIBRARY_OWNER: &str = "routecodex-v4-standard-plugins";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginCategory {
    Contracts,
    Diagnostic,
    Control,
    Error,
    Protocol,
    ChatProcess,
    Routing,
    Provider,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StandardPlugin {
    pub plugin_id: String,
    pub version: String,
    pub category: PluginCategory,
    pub descriptor: NodePluginDescriptor,
    pub artifact_bytes: Vec<u8>,
    pub contract_bytes: Vec<u8>,
}

impl StandardPlugin {
    pub fn new(
        plugin_id: impl Into<String>,
        category: PluginCategory,
        descriptor: NodePluginDescriptor,
    ) -> Self {
        let plugin_id = plugin_id.into();
        let artifact_bytes = canonical_artifact_bytes(&plugin_id);
        let contract_hash = descriptor_contract_hash(&descriptor);
        let descriptor = NodePluginDescriptor {
            contract_hash,
            ..descriptor
        };
        let contract_bytes = canonical_contract_bytes(&plugin_id, &descriptor);
        Self {
            plugin_id,
            version: STANDARD_LIBRARY_VERSION.to_string(),
            category,
            descriptor,
            artifact_bytes,
            contract_bytes,
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn canonical_artifact_bytes(plugin_id: &str) -> Vec<u8> {
    format!(
        "routecodex-v4-standard-plugins artifact v1\nplugin_id={plugin_id}\nversion={STANDARD_LIBRARY_VERSION}\nkeyless=1"
    )
    .into_bytes()
}

fn canonical_contract_bytes(_plugin_id: &str, descriptor: &NodePluginDescriptor) -> Vec<u8> {
    let mut value = serde_json::to_value(descriptor).expect("standard descriptor is serializable");
    if let Some(object) = value.as_object_mut() {
        object.remove("contract_hash");
    }
    canonical_json(&value).into_bytes()
}

fn descriptor(
    plugin_id: &str,
    node_id: &str,
    role_id: &str,
    position: Option<u32>,
    kind: PluginKind,
    effect: PluginEffect,
    phase: PluginPhase,
    order: u32,
    reads: Vec<&str>,
    writes: Vec<&str>,
) -> NodePluginDescriptor {
    NodePluginDescriptor {
        plugin_id: plugin_id.to_string(),
        version: STANDARD_LIBRARY_VERSION.to_string(),
        owner: STANDARD_LIBRARY_OWNER.to_string(),
        artifact_hash: sha256_hex(&canonical_artifact_bytes(plugin_id)),
        contract_hash: String::new(),
        kind,
        effect,
        phase,
        order,
        before: Vec::new(),
        after: Vec::new(),
        depends_on: Vec::new(),
        selection_group: None,
        node_selector: NodeSelector {
            role_id: role_id.to_string(),
            node_id: node_id.to_string(),
            position: position.unwrap_or(0),
        },
        services_provided: Vec::new(),
        inject: Vec::new(),
        reads: reads.into_iter().map(String::from).collect(),
        writes: writes.into_iter().map(String::from).collect(),
    }
}

fn plugin(
    plugin_id: &str,
    category: PluginCategory,
    node_id: &str,
    role_id: &str,
    position: Option<u32>,
    kind: PluginKind,
    effect: PluginEffect,
    phase: PluginPhase,
    order: u32,
    reads: Vec<&str>,
    writes: Vec<&str>,
) -> StandardPlugin {
    StandardPlugin::new(
        plugin_id,
        category,
        descriptor(
            plugin_id, node_id, role_id, position, kind, effect, phase, order, reads, writes,
        ),
    )
}

/// The standard resource registry used by M5 validation and compilation. It
/// is a deterministic subset of the V4 resource map with the resource axes
/// the standard keyless plugins may touch.
pub fn standard_resource_registry() -> ResourceRegistry {
    ResourceRegistry {
        resources: vec![
            ResourceEntry {
                resource_id: "v4.request.client_raw".to_string(),
                axis: ResourceAxis::Data,
            },
            ResourceEntry {
                resource_id: "v4.request.sse_frame".to_string(),
                axis: ResourceAxis::Data,
            },
            ResourceEntry {
                resource_id: "v4.request.normal_payload".to_string(),
                axis: ResourceAxis::Data,
            },
            ResourceEntry {
                resource_id: "v4.request.provider_semantic".to_string(),
                axis: ResourceAxis::Data,
            },
            ResourceEntry {
                resource_id: "v4.request.provider_wire_payload".to_string(),
                axis: ResourceAxis::Data,
            },
            ResourceEntry {
                resource_id: "v4.response.normal_payload".to_string(),
                axis: ResourceAxis::Data,
            },
            ResourceEntry {
                resource_id: "v4.response.client_wire_payload".to_string(),
                axis: ResourceAxis::Data,
            },
            ResourceEntry {
                resource_id: "v4.control.metadata_center".to_string(),
                axis: ResourceAxis::Control,
            },
            ResourceEntry {
                resource_id: "v4.control.route_facts".to_string(),
                axis: ResourceAxis::Control,
            },
            ResourceEntry {
                resource_id: "v4.control.target_selection".to_string(),
                axis: ResourceAxis::Control,
            },
            ResourceEntry {
                resource_id: "v4.control.error_chain".to_string(),
                axis: ResourceAxis::Control,
            },
            ResourceEntry {
                resource_id: "v4.lifecycle.payload_cycle".to_string(),
                axis: ResourceAxis::Control,
            },
            ResourceEntry {
                resource_id: "v4.config.manifest".to_string(),
                axis: ResourceAxis::Information,
            },
            ResourceEntry {
                resource_id: "v4.debug.event_ledger".to_string(),
                axis: ResourceAxis::Diagnostic,
            },
            ResourceEntry {
                resource_id: "v4.debug.snapshot_ledger".to_string(),
                axis: ResourceAxis::Diagnostic,
            },
            ResourceEntry {
                resource_id: "v4.debug.timing_observability".to_string(),
                axis: ResourceAxis::Diagnostic,
            },
            ResourceEntry {
                resource_id: "v4.node.statistics".to_string(),
                axis: ResourceAxis::Diagnostic,
            },
            ResourceEntry {
                resource_id: "v4.control.side_channel".to_string(),
                axis: ResourceAxis::Control,
            },
            ResourceEntry {
                resource_id: "v4.secret.provider_auth_handle".to_string(),
                axis: ResourceAxis::Information,
            },
            ResourceEntry {
                resource_id: "v4.control.stopless_state".to_string(),
                axis: ResourceAxis::Control,
            },
        ],
    }
}

/// Container-provided services available to every standard node.
pub fn standard_container_services() -> Vec<String> {
    vec![
        "nodeControl".to_string(),
        "nodeInformation".to_string(),
        "nodeDiagnostics".to_string(),
        "nodeErrors".to_string(),
    ]
}

/// Union of resources used by the standard library. This is catalog/test
/// inventory only; plan compilation always uses the exact node-scoped set.
pub fn standard_allowed_reads() -> Vec<String> {
    vec![
        "v4.request.client_raw".to_string(),
        "v4.request.sse_frame".to_string(),
        "v4.request.normal_payload".to_string(),
        "v4.request.provider_semantic".to_string(),
        "v4.request.provider_wire_payload".to_string(),
        "v4.response.normal_payload".to_string(),
        "v4.response.client_wire_payload".to_string(),
        "v4.control.metadata_center".to_string(),
        "v4.control.route_facts".to_string(),
        "v4.control.target_selection".to_string(),
        "v4.control.error_chain".to_string(),
        "v4.lifecycle.payload_cycle".to_string(),
        "v4.config.manifest".to_string(),
        "v4.debug.event_ledger".to_string(),
        "v4.debug.snapshot_ledger".to_string(),
        "v4.debug.timing_observability".to_string(),
        "v4.node.statistics".to_string(),
        "v4.control.side_channel".to_string(),
        "v4.secret.provider_auth_handle".to_string(),
        "v4.control.stopless_state".to_string(),
    ]
}

/// Union of resources written by the standard library. This is not a node
/// permission surface; `compile_standard_plan` derives that from `node_id`.
pub fn standard_allowed_writes() -> Vec<String> {
    vec![
        "v4.request.sse_frame".to_string(),
        "v4.request.normal_payload".to_string(),
        "v4.request.provider_semantic".to_string(),
        "v4.request.provider_wire_payload".to_string(),
        "v4.response.normal_payload".to_string(),
        "v4.control.metadata_center".to_string(),
        "v4.control.route_facts".to_string(),
        "v4.control.target_selection".to_string(),
        "v4.control.error_chain".to_string(),
        "v4.lifecycle.payload_cycle".to_string(),
        "v4.control.side_channel".to_string(),
    ]
}

/// Node-scoped reads for a registered active node. `compile_standard_plan`
/// uses this exact set instead of the broad standard read set, so a plugin
/// cannot read another node's data or a wire payload through the M5 surface.
pub fn standard_node_allowed_reads(node_id: &str) -> Vec<String> {
    match node_id {
        "V4ServerReqInbound01ClientRaw" => vec!["v4.request.client_raw".to_string()],
        "V4ServerSseIn02FrameBoundary" => vec!["v4.request.client_raw".to_string()],
        "V4HubReqInbound03Normalized" => vec!["v4.request.sse_frame".to_string()],
        "V4HubReqChatProcess04Governed" => vec![
            "v4.request.normal_payload".to_string(),
            "v4.control.metadata_center".to_string(),
        ],
        "V4HubRespChatProcess03Governed" => vec!["v4.response.normal_payload".to_string()],
        "V4HubRespOutbound04ClientSemantic" => vec!["v4.response.normal_payload".to_string()],
        "V4HubReqOutbound05ProviderSemantic" => vec![
            "v4.request.normal_payload".to_string(),
            "v4.control.target_selection".to_string(),
        ],
        "V4ProviderReqCompat06Compat" => vec![
            "v4.request.provider_semantic".to_string(),
            "v4.control.target_selection".to_string(),
        ],
        "V4ProviderSseOut07WireBoundary" => vec![
            "v4.request.provider_wire_payload".to_string(),
            "v4.config.manifest".to_string(),
            "v4.secret.provider_auth_handle".to_string(),
        ],
        "V4MetadataCenter01ScopeRegistry" => vec!["v4.control.metadata_center".to_string()],
        "V4PayloadCycleRegistry" => vec!["v4.lifecycle.payload_cycle".to_string()],
        "V4Error01SourceRaised" => vec!["v4.control.error_chain".to_string()],
        "V4Error06ClientProjected" => vec!["v4.control.error_chain".to_string()],
        "V4Router05RequestClassified" => vec![
            "v4.request.normal_payload".to_string(),
            "v4.control.route_facts".to_string(),
            "v4.config.manifest".to_string(),
        ],
        "V4Router06SelectionPlan" => vec![
            "v4.control.route_facts".to_string(),
            "v4.config.manifest".to_string(),
        ],
        _ => Vec::new(),
    }
}

/// Node-scoped writes for a registered active node. This is the typed
/// adjacent transition surface: normal payload may become provider semantic,
/// provider semantic may become provider wire, and control/error/diagnostic
/// facts never enter a normal data or wire resource.
pub fn standard_node_allowed_writes(node_id: &str) -> Vec<String> {
    match node_id {
        "V4ServerReqInbound01ClientRaw" => Vec::new(),
        "V4ServerSseIn02FrameBoundary" => vec!["v4.request.sse_frame".to_string()],
        "V4HubReqInbound03Normalized" => vec!["v4.request.normal_payload".to_string()],
        "V4HubReqChatProcess04Governed" => vec!["v4.control.metadata_center".to_string()],
        "V4HubRespChatProcess03Governed" => vec!["v4.response.normal_payload".to_string()],
        "V4HubRespOutbound04ClientSemantic" => Vec::new(),
        "V4HubReqOutbound05ProviderSemantic" => vec!["v4.request.provider_semantic".to_string()],
        "V4ProviderReqCompat06Compat" => vec!["v4.request.provider_wire_payload".to_string()],
        "V4ProviderSseOut07WireBoundary" => Vec::new(),
        "V4ServerRespOutbound06ClientFrame" => vec!["v4.response.client_wire_payload".to_string()],
        "V4MetadataCenter01ScopeRegistry" => vec!["v4.control.metadata_center".to_string()],
        "V4PayloadCycleRegistry" => vec!["v4.lifecycle.payload_cycle".to_string()],
        "V4Error01SourceRaised" => vec!["v4.control.error_chain".to_string()],
        "V4Error06ClientProjected" => vec!["v4.control.error_chain".to_string()],
        "V4Router05RequestClassified" => vec!["v4.control.route_facts".to_string()],
        "V4Router06SelectionPlan" => vec!["v4.control.target_selection".to_string()],
        _ => Vec::new(),
    }
}

/// All standard plugin descriptors. Every descriptor carries a valid
/// role/resource/effect/phase/order/owner and canonical hashes.
pub fn standard_descriptors() -> Vec<NodePluginDescriptor> {
    standard_plugins()
        .into_iter()
        .map(|plugin| plugin.descriptor)
        .collect()
}

/// All standard plugins registered by immutable plugin id.
pub fn standard_plugins() -> Vec<StandardPlugin> {
    vec![
        plugin(
            "v4.std.protocol.server_input",
            PluginCategory::Protocol,
            "V4ServerReqInbound01ClientRaw",
            "request_inbound",
            Some(1),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Admission,
            10,
            vec!["v4.request.client_raw"],
            vec![],
        ),
        plugin(
            "v4.std.protocol.sse_in",
            PluginCategory::Protocol,
            "V4ServerSseIn02FrameBoundary",
            "request_inbound",
            Some(2),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Semantic,
            20,
            vec!["v4.request.client_raw"],
            vec!["v4.request.sse_frame"],
        ),
        plugin(
            "v4.std.protocol.responses_inbound",
            PluginCategory::Protocol,
            "V4HubReqInbound03Normalized",
            "request_inbound",
            Some(3),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Semantic,
            30,
            vec!["v4.request.sse_frame"],
            vec!["v4.request.normal_payload"],
        ),
        plugin(
            "v4.std.chat_process.scope_restore",
            PluginCategory::ChatProcess,
            "V4HubReqChatProcess04Governed",
            "request_chat_process",
            Some(4),
            PluginKind::Control,
            PluginEffect::ControlOnly,
            PluginPhase::Control,
            100,
            vec!["v4.control.metadata_center"],
            vec!["v4.control.metadata_center"],
        ),
        plugin(
            "v4.std.chat_process.continuation_restore",
            PluginCategory::ChatProcess,
            "V4HubReqChatProcess04Governed",
            "request_chat_process",
            Some(4),
            PluginKind::Control,
            PluginEffect::ControlOnly,
            PluginPhase::Control,
            110,
            vec!["v4.control.metadata_center"],
            vec!["v4.control.metadata_center"],
        ),
        plugin(
            "v4.std.chat_process.tool_governance",
            PluginCategory::ChatProcess,
            "V4HubReqChatProcess04Governed",
            "request_chat_process",
            Some(4),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Validation,
            120,
            vec!["v4.request.normal_payload"],
            vec![],
        ),
        plugin(
            "v4.std.routing.entry_model_admission",
            PluginCategory::Routing,
            "V4Router05RequestClassified",
            "request_execution",
            Some(5),
            PluginKind::Operator,
            PluginEffect::ControlOnly,
            PluginPhase::Semantic,
            200,
            vec!["v4.request.normal_payload"],
            vec!["v4.control.route_facts"],
        ),
        plugin(
            "v4.std.routing.candidate_filter",
            PluginCategory::Routing,
            "V4Router05RequestClassified",
            "request_execution",
            Some(5),
            PluginKind::Operator,
            PluginEffect::ControlOnly,
            PluginPhase::Semantic,
            210,
            vec!["v4.control.route_facts", "v4.config.manifest"],
            vec!["v4.control.route_facts"],
        ),
        plugin(
            "v4.std.routing.target_selection",
            PluginCategory::Routing,
            "V4Router06SelectionPlan",
            "request_execution",
            Some(6),
            PluginKind::Operator,
            PluginEffect::ControlOnly,
            PluginPhase::Semantic,
            220,
            vec!["v4.control.route_facts", "v4.config.manifest"],
            vec!["v4.control.target_selection"],
        ),
        plugin(
            "v4.std.routing.model_replacement",
            PluginCategory::Routing,
            "V4HubReqOutbound05ProviderSemantic",
            "request_outbound",
            Some(5),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Projection,
            300,
            vec!["v4.request.normal_payload", "v4.control.target_selection"],
            vec!["v4.request.provider_semantic"],
        ),
        plugin(
            "v4.std.provider.compat",
            PluginCategory::Provider,
            "V4ProviderReqCompat06Compat",
            "request_outbound",
            Some(6),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Semantic,
            400,
            vec![
                "v4.request.provider_semantic",
                "v4.control.target_selection",
            ],
            vec!["v4.request.provider_wire_payload"],
        ),
        plugin(
            "v4.std.provider.wire_boundary",
            PluginCategory::Provider,
            "V4ProviderSseOut07WireBoundary",
            "request_outbound",
            Some(7),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Validation,
            500,
            vec!["v4.request.provider_wire_payload"],
            vec![],
        ),
        plugin(
            "v4.std.contract.output_validate",
            PluginCategory::Contracts,
            "V4ProviderSseOut07WireBoundary",
            "request_outbound",
            Some(7),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Validation,
            510,
            vec!["v4.request.provider_wire_payload"],
            vec![],
        ),
        plugin(
            "v4.std.diagnostic.debug_observe",
            PluginCategory::Diagnostic,
            "V4HubReqChatProcess04Governed",
            "request_chat_process",
            Some(4),
            PluginKind::Debug,
            PluginEffect::DiagnosticOnly,
            PluginPhase::Observation,
            900,
            vec!["v4.request.normal_payload"],
            vec![],
        ),
        plugin(
            "v4.std.control.scope_registry",
            PluginCategory::Control,
            "V4MetadataCenter01ScopeRegistry",
            "control_center",
            Some(0),
            PluginKind::Control,
            PluginEffect::ControlOnly,
            PluginPhase::Control,
            100,
            vec!["v4.control.metadata_center"],
            vec!["v4.control.metadata_center"],
        ),
        plugin(
            "v4.std.error.typed_intake",
            PluginCategory::Error,
            "V4Error01SourceRaised",
            "error_source",
            Some(1),
            PluginKind::Operator,
            PluginEffect::ControlOnly,
            PluginPhase::Semantic,
            300,
            vec!["v4.control.error_chain"],
            vec!["v4.control.error_chain"],
        ),
    ]
}

/// Convert one standard plugin to a catalog entry. The entry is a typed
/// identity projection; registration still validates the canonical hashes.
pub fn catalog_entry(plugin: &StandardPlugin) -> CatalogEntry {
    CatalogEntry {
        plugin_id: plugin.plugin_id.clone(),
        version: plugin.version.clone(),
        owner: plugin.descriptor.owner.clone(),
        artifact_hash: plugin.descriptor.artifact_hash.clone(),
        contract_hash: plugin.descriptor.contract_hash.clone(),
        supported_node_roles: vec![plugin.descriptor.node_selector.role_id.clone()],
        services_provided: plugin.descriptor.services_provided.clone(),
        services_injected: plugin.descriptor.inject.clone(),
        resources_read: plugin.descriptor.reads.clone(),
        resources_written: plugin.descriptor.writes.clone(),
        required_tests: vec![
            "v4_standard_plugins_l2_regression".to_string(),
            "v4_standard_plugins_test_consumer".to_string(),
        ],
        depends_on: plugin.descriptor.depends_on.clone(),
    }
}

/// Register every standard plugin into a `PluginCatalog`. Returns the number
/// of distinct entries in the catalog; re-registration is idempotent.
pub fn register_standard_library(
    catalog: &mut PluginCatalog,
) -> Result<usize, routecodex_v4_plugin_catalog::CatalogError> {
    for plugin in standard_plugins() {
        catalog.register(
            catalog_entry(&plugin),
            &plugin.artifact_bytes,
            &plugin.contract_bytes,
        )?;
    }
    Ok(catalog.snapshot().entries().len())
}

fn authoring_for(
    ids: &[&str],
) -> Result<Vec<AuthoringPlugin>, routecodex_v4_plugin_plan::PlanError> {
    let plugins = standard_plugins();
    let by_id: HashMap<&str, &StandardPlugin> = plugins
        .iter()
        .map(|plugin| (plugin.plugin_id.as_str(), plugin))
        .collect();
    let mut authoring = Vec::new();
    for id in ids {
        let plugin = by_id.get(id).ok_or_else(|| {
            routecodex_v4_plugin_plan::PlanError::UnregisteredOperator((*id).to_string())
        })?;
        authoring.push(AuthoringPlugin {
            descriptor: plugin.descriptor.clone(),
            enabled: true,
        });
    }
    Ok(authoring)
}

/// Build authoring entries for the named standard plugin ids.
pub fn standard_authoring(
    ids: &[&str],
) -> Result<Vec<AuthoringPlugin>, routecodex_v4_plugin_plan::PlanError> {
    authoring_for(ids)
}

/// Compile a deterministic standard node plan for the named plugin ids.
pub fn compile_standard_plan(
    node_id: &str,
    role_id: &str,
    chain: &str,
    position: u32,
    ids: &[&str],
) -> Result<NodePluginPlan, routecodex_v4_plugin_plan::PlanError> {
    let allowed_reads = standard_node_allowed_reads(node_id);
    let allowed_writes = standard_node_allowed_writes(node_id);
    let authoring = authoring_for(ids)?;
    compile_node_plan(
        node_id,
        role_id,
        chain,
        position,
        &authoring,
        &allowed_reads,
        &allowed_writes,
        &standard_resource_registry(),
        &standard_container_services(),
    )
}

struct NativeHandle {
    execute_fn: fn(&mut ExecCtx<'_>) -> Result<(), String>,
}

impl PluginHandle for NativeHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        (self.execute_fn)(ctx)
    }
}

fn server_input(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    if !ctx.read_data().is_string() {
        return Err("server input requires raw request bytes encoded as a string".to_string());
    }
    ctx.emit(
        "request.node01",
        "server input accepted without model inspection",
    );
    Ok(())
}

fn sse_in(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let raw = ctx
        .read_data()
        .as_str()
        .ok_or_else(|| "SSE input requires raw text".to_string())?;
    let json_text = if raw.trim_start().starts_with("data:") {
        let frames = raw
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .filter(|line| !line.is_empty() && *line != "[DONE]")
            .collect::<Vec<_>>();
        if frames.len() != 1 {
            return Err("request SSE input must contain exactly one JSON data frame".to_string());
        }
        frames[0]
    } else {
        raw
    };
    let value: Value = serde_json::from_str(json_text)
        .map_err(|error| format!("request JSON/SSE frame invalid: {error}"))?;
    ctx.write_data(value).map_err(|error| error.to_string())
}

fn responses_inbound(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    if !ctx.read_data().is_object() {
        return Err("Responses inbound requires an object".to_string());
    }
    ctx.emit(
        "request.node03",
        "Responses normalized without entry model admission",
    );
    ctx.write_data(ctx.read_data().clone())
        .map_err(|error| error.to_string())
}

fn debug_observe(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    ctx.emit("node.debug_observe", "debug observation emitted");
    Ok(())
}

fn scope_restore(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let mut metadata = ctx
        .read_control_resource("v4.control.metadata_center")
        .map_err(|error| error.to_string())?
        .cloned()
        .unwrap_or_else(|| json!({}));
    let object = metadata
        .as_object_mut()
        .ok_or_else(|| "scope_consume requires typed metadata object".to_string())?;
    object.insert("scope_restored".to_string(), json!(true));
    ctx.write_control_resource("v4.control.metadata_center", metadata)
        .map_err(|error| error.to_string())
}

fn continuation_restore(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let mut metadata = ctx
        .read_control_resource("v4.control.metadata_center")
        .map_err(|error| error.to_string())?
        .cloned()
        .unwrap_or_else(|| json!({}));
    let object = metadata
        .as_object_mut()
        .ok_or_else(|| "continuation restore requires typed metadata object".to_string())?;
    if let Some(owner) = object.get("continuation_owner").and_then(Value::as_str) {
        if !matches!(owner, "direct" | "relay") {
            return Err(format!("invalid continuation owner {owner}"));
        }
    }
    object.insert("continuation_checked".to_string(), json!(true));
    ctx.write_control_resource("v4.control.metadata_center", metadata)
        .map_err(|error| error.to_string())
}

fn tool_governance(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    if let Some(tools) = ctx.read_data().get("tools") {
        let tools = tools
            .as_array()
            .ok_or_else(|| "Responses tools must be an array".to_string())?;
        if tools.iter().any(|tool| !tool.is_object()) {
            return Err("every Responses tool must be an object".to_string());
        }
    }
    Ok(())
}

fn error_intake(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let mut error_chain = ctx
        .read_control_resource("v4.control.error_chain")
        .map_err(|error| error.to_string())?
        .cloned()
        .unwrap_or_else(|| json!({}));
    let object = error_chain
        .as_object_mut()
        .ok_or_else(|| "error_intake requires typed error object".to_string())?;
    object.insert("stage".to_string(), json!("source_raised"));
    object.insert("kind".to_string(), json!("typed_source_error"));
    ctx.write_control_resource("v4.control.error_chain", error_chain)
        .map_err(|error| error.to_string())
}

fn entry_model_admission(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let entry_model = admit_entry_model(ctx.read_data()).map_err(|error| error.to_string())?;
    ctx.write_control_resource(
        "v4.control.route_facts",
        json!({"entry_protocol": "responses", "entry_model": entry_model}),
    )
    .map_err(|error| error.to_string())
}

fn manifest_candidates(ctx: &mut ExecCtx<'_>) -> Result<Vec<ProviderCandidate>, String> {
    let manifest = ctx
        .read_control_resource("v4.config.manifest")
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "compiled config manifest is missing".to_string())?;
    serde_json::from_value(
        manifest
            .get("candidates")
            .cloned()
            .ok_or_else(|| "compiled config manifest candidates are missing".to_string())?,
    )
    .map_err(|error| format!("compiled candidate set invalid: {error}"))
}

fn candidate_filter(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let candidates = manifest_candidates(ctx)?;
    let mut route_facts = ctx
        .read_control_resource("v4.control.route_facts")
        .map_err(|error| error.to_string())?
        .cloned()
        .ok_or_else(|| "candidate filter requires route facts".to_string())?;
    let requested = route_facts.get("entry_model").and_then(Value::as_str);
    let eligible = filter_candidates(&candidates, requested)
        .map_err(|error| error.to_string())?
        .into_iter()
        .cloned()
        .collect::<Vec<_>>();
    route_facts
        .as_object_mut()
        .ok_or_else(|| "route facts must be an object".to_string())?
        .insert("eligible_candidates".to_string(), json!(eligible));
    ctx.write_control_resource("v4.control.route_facts", route_facts)
        .map_err(|error| error.to_string())
}

fn target_selection(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let candidates = manifest_candidates(ctx)?;
    let route_facts = ctx
        .read_control_resource("v4.control.route_facts")
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "target selection requires route facts".to_string())?;
    let requested = route_facts.get("entry_model").and_then(Value::as_str);
    let target = select_target(&candidates, requested).map_err(|error| error.to_string())?;
    ctx.write_control_resource(
        "v4.control.target_selection",
        serde_json::to_value(target).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn model_replacement(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let target: SelectedTarget = serde_json::from_value(
        ctx.read_control_resource("v4.control.target_selection")
            .map_err(|error| error.to_string())?
            .cloned()
            .ok_or_else(|| "model replacement requires target selection".to_string())?,
    )
    .map_err(|error| format!("target selection invalid: {error}"))?;
    let mut data = ctx.read_data().clone();
    let object = data
        .as_object_mut()
        .ok_or_else(|| "model replacement requires a request object".to_string())?;
    object.insert("model".to_string(), json!(target.model));
    ctx.write_data(data).map_err(|error| error.to_string())
}

fn provider_compat(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let target: SelectedTarget = serde_json::from_value(
        ctx.read_control_resource("v4.control.target_selection")
            .map_err(|error| error.to_string())?
            .cloned()
            .ok_or_else(|| "provider compat requires target selection".to_string())?,
    )
    .map_err(|error| format!("target selection invalid: {error}"))?;
    let wire = project_provider_compat(
        ctx.read_data(),
        "responses",
        &target.protocol,
        &target.execution_mode,
    )
    .map_err(|error| error.to_string())?;
    ctx.write_data(wire).map_err(|error| error.to_string())
}

fn wire_boundary(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    validate_provider_wire_payload(ctx.read_data()).map_err(|error| error.to_string())
}

/// Registry of typed handles for every standard plugin. One immutable handle
/// per plugin id; unknown ids fail fast through the bridge.
pub struct StandardHandleRegistry {
    handles: HashMap<&'static str, NativeHandle>,
}

impl StandardHandleRegistry {
    pub fn new() -> Self {
        let mut handles = HashMap::new();
        for (id, execute_fn) in [
            (
                "v4.std.protocol.server_input",
                server_input as fn(&mut ExecCtx<'_>) -> Result<(), String>,
            ),
            ("v4.std.protocol.sse_in", sse_in),
            ("v4.std.protocol.responses_inbound", responses_inbound),
            ("v4.std.contract.output_validate", wire_boundary),
            ("v4.std.diagnostic.debug_observe", debug_observe),
            ("v4.std.control.scope_registry", scope_restore),
            ("v4.std.error.typed_intake", error_intake),
            ("v4.std.chat_process.scope_restore", scope_restore),
            (
                "v4.std.chat_process.continuation_restore",
                continuation_restore,
            ),
            ("v4.std.chat_process.tool_governance", tool_governance),
            (
                "v4.std.routing.entry_model_admission",
                entry_model_admission,
            ),
            ("v4.std.routing.candidate_filter", candidate_filter),
            ("v4.std.routing.target_selection", target_selection),
            ("v4.std.routing.model_replacement", model_replacement),
            ("v4.std.provider.compat", provider_compat),
            ("v4.std.provider.wire_boundary", wire_boundary),
        ] {
            handles.insert(id, NativeHandle { execute_fn });
        }
        Self { handles }
    }

    pub fn get_handle(&self, plugin_id: &str) -> Option<&dyn PluginHandle> {
        self.handles
            .get(plugin_id)
            .map(|handle| handle as &dyn PluginHandle)
    }
}

impl Default for StandardHandleRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl HandleRegistry for StandardHandleRegistry {
    fn get(&self, plugin_id: &str) -> Option<&dyn PluginHandle> {
        self.get_handle(plugin_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v4_plugin_contract::validate_descriptor;

    #[test]
    fn all_descriptors_validate_against_standard_registry() {
        let resources = standard_resource_registry();
        for plugin in standard_plugins() {
            validate_descriptor(
                &plugin.descriptor,
                &[plugin.descriptor.node_selector.role_id.clone()],
                &resources,
            )
            .expect("standard descriptor must validate");
            assert_eq!(plugin.descriptor.artifact_hash.len(), 64);
            assert_eq!(plugin.descriptor.contract_hash.len(), 64);
        }
    }

    #[test]
    fn every_category_ships_at_least_one_plugin() {
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
            assert!(
                standard_plugins()
                    .iter()
                    .any(|plugin| plugin.category == category),
                "{category:?} missing"
            );
        }
    }

    #[test]
    fn standard_plugin_ids_are_exact_and_immutable() {
        let plugins = standard_plugins();
        let mut actual: Vec<&str> = plugins
            .iter()
            .map(|plugin| plugin.plugin_id.as_str())
            .collect();
        let mut expected = [
            "v4.std.contract.output_validate",
            "v4.std.diagnostic.debug_observe",
            "v4.std.control.scope_registry",
            "v4.std.error.typed_intake",
            "v4.std.protocol.server_input",
            "v4.std.protocol.sse_in",
            "v4.std.protocol.responses_inbound",
            "v4.std.chat_process.scope_restore",
            "v4.std.chat_process.continuation_restore",
            "v4.std.chat_process.tool_governance",
            "v4.std.routing.entry_model_admission",
            "v4.std.routing.candidate_filter",
            "v4.std.routing.target_selection",
            "v4.std.routing.model_replacement",
            "v4.std.provider.compat",
            "v4.std.provider.wire_boundary",
        ];
        actual.sort_unstable();
        expected.sort_unstable();
        assert_eq!(actual, expected);
    }

    #[test]
    fn registry_has_one_handle_per_standard_plugin() {
        let registry = StandardHandleRegistry::new();
        assert_eq!(registry.handles.len(), standard_plugins().len());
        for plugin in standard_plugins() {
            assert!(registry.contains(&plugin.plugin_id));
        }
    }
}
