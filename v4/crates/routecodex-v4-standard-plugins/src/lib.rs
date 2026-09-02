//! V4 standard plugin library — M5 keyless deterministic baseline.
//!
//! This crate owns the immutable standard plugin descriptors, deterministic
//! artifact/contract bytes, catalog registration and typed handle registry
//! for the V4 NodeContainer bridge. Every plugin is keyless and
//! behavior-minimal; it never claims real product migration, real provider
//! semantics or real credentials.
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
use routecodex_v4_skeleton::SkeletonPlan;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub mod chat_process;
pub mod chat_to_responses;
pub mod boundary;
pub mod contracts;
pub mod control;
pub mod diagnostic;
pub mod error;
pub mod model_hooks;
pub mod protocol;
pub mod provider;
pub mod request_governance;
pub mod request_normalize;
pub mod request_plugins;
pub mod response_decode;
pub mod response_fault;
pub mod response_governance;
pub mod response_inbound;
pub mod response_outbound;
pub mod responses_wire_build;
pub mod routing;
pub mod sse_transport;

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
                resource_id: "v4.response.provider_raw".to_string(),
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
                resource_id: "v4.response.client_object".to_string(),
                axis: ResourceAxis::Data,
            },
            ResourceEntry {
                resource_id: "v4.direct.request.client_payload".to_string(),
                axis: ResourceAxis::Data,
            },
            ResourceEntry {
                resource_id: "v4.direct.request.provider_wire".to_string(),
                axis: ResourceAxis::Data,
            },
            ResourceEntry {
                resource_id: "v4.direct.response.provider_raw".to_string(),
                axis: ResourceAxis::Data,
            },
            ResourceEntry {
                resource_id: "v4.direct.response.client_payload".to_string(),
                axis: ResourceAxis::Data,
            },
            ResourceEntry {
                resource_id: "v4.information.entry_protocol".to_string(),
                axis: ResourceAxis::Information,
            },
            ResourceEntry {
                resource_id: "v4.information.execution_lane".to_string(),
                axis: ResourceAxis::Information,
            },
            ResourceEntry {
                resource_id: "v4.information.client_protocol".to_string(),
                axis: ResourceAxis::Information,
            },
            ResourceEntry {
                resource_id: "v4.information.provider_protocol".to_string(),
                axis: ResourceAxis::Information,
            },
            ResourceEntry {
                resource_id: "v4.information.stream_terminal".to_string(),
                axis: ResourceAxis::Information,
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
        "v4.request.normal_payload".to_string(),
        "v4.request.provider_semantic".to_string(),
        "v4.request.provider_wire_payload".to_string(),
        "v4.response.provider_raw".to_string(),
        "v4.response.normal_payload".to_string(),
        "v4.response.provider_raw".to_string(),
        "v4.response.client_wire_payload".to_string(),
        "v4.direct.request.client_payload".to_string(),
        "v4.direct.request.provider_wire".to_string(),
        "v4.direct.response.provider_raw".to_string(),
        "v4.direct.response.client_payload".to_string(),
        "v4.information.execution_lane".to_string(),
        "v4.information.client_protocol".to_string(),
        "v4.information.provider_protocol".to_string(),
        "v4.information.stream_terminal".to_string(),
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
        "v4.request.normal_payload".to_string(),
        "v4.request.provider_semantic".to_string(),
        "v4.request.provider_wire_payload".to_string(),
        "v4.response.normal_payload".to_string(),
        "v4.response.client_wire_payload".to_string(),
        "v4.response.client_object".to_string(),
        "v4.direct.request.provider_wire".to_string(),
        "v4.direct.response.client_payload".to_string(),
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
        "V4Error02HostCaptured" | "V4Error03RuntimeClassified" | "V4Error04RouterPolicyApplied"
        | "V4Error05ExecutionDecision" => vec!["v4.control.error_chain".to_string()],
        "V4ProviderRespInbound01Raw" => vec!["v4.response.provider_raw".to_string()],
        "V4ServerReqInbound01ClientRaw" => vec!["v4.request.normal_payload".to_string()],
        "V4DirectReq03ProviderWire" => {
            vec!["v4.direct.request.provider_wire".to_string()]
        }
        "V4DirectReq01ClientProtocol" => vec!["v4.direct.request.client_payload".to_string()],
        "V4DirectResp01ProviderRaw" => vec!["v4.direct.response.provider_raw".to_string()],
        "V4DirectResp03ClientProtocol" => vec![
            "v4.direct.response.client_payload".to_string(),
            "v4.information.client_protocol".to_string(),
            "v4.information.provider_protocol".to_string(),
            "v4.information.entry_protocol".to_string(),
            "v4.information.stream_terminal".to_string(),
        ],
        "V4DirectReq02RelayContainer" => vec![
            "v4.direct.request.client_payload".to_string(),
            "v4.information.client_protocol".to_string(),
            "v4.information.provider_protocol".to_string(),
        ],
        "V4DirectResp02RelayContainer" => vec![
            "v4.direct.response.provider_raw".to_string(),
            "v4.information.client_protocol".to_string(),
            "v4.information.provider_protocol".to_string(),
        ],
        "V4HubReqOutbound06ProviderSemantic" => vec![
            "v4.request.normal_payload".to_string(),
            "v4.information.client_protocol".to_string(),
            "v4.information.provider_protocol".to_string(),
        ],
        "V4HubReqInbound02Normalized" => vec!["v4.request.normal_payload".to_string()],
        "V4HubReqChatProcess03Governed" => vec!["v4.request.normal_payload".to_string()],
        "V4HubRespInbound03Normalized" => vec!["v4.response.provider_raw".to_string()],
        "V4ProviderRespCompat02ProviderCompat" => vec![
            "v4.response.provider_raw".to_string(),
            "v4.information.provider_protocol".to_string(),
        ],
        "V4HubRespChatProcess04Governed" => vec!["v4.response.normal_payload".to_string()],
        "V4HubRespOutbound05ClientSemantic" => vec![
            "v4.response.normal_payload".to_string(),
            "v4.information.client_protocol".to_string(),
            "v4.information.provider_protocol".to_string(),
        ],
        "V4ProviderReqCompat07ProviderCompat" => vec![
            "v4.request.provider_semantic".to_string(),
            "v4.information.client_protocol".to_string(),
            "v4.information.provider_protocol".to_string(),
        ],
        "V4ProviderReqOutbound08WirePayload" => vec![
            "v4.request.provider_semantic".to_string(),
            "v4.request.provider_wire_payload".to_string(),
            "v4.information.client_protocol".to_string(),
            "v4.information.provider_protocol".to_string(),
        ],
        "V4ProviderReqOutbound09TransportRequest" => vec![
            "v4.request.provider_wire_payload".to_string(),
            "v4.config.manifest".to_string(),
            "v4.secret.provider_auth_handle".to_string(),
        ],
        "V4ServerRespOutbound06ClientFrame" => vec![
            "v4.response.client_wire_payload".to_string(),
            "v4.information.entry_protocol".to_string(),
            "v4.information.stream_terminal".to_string(),
        ],
        "V4MetadataCenter01ScopeRegistry" => vec!["v4.control.metadata_center".to_string()],
        "V4PayloadCycleRegistry" => vec!["v4.lifecycle.payload_cycle".to_string()],
        "V4Error01SourceRaised" => vec!["v4.control.error_chain".to_string()],
        "V4Error06ClientProjected" => vec!["v4.control.error_chain".to_string()],
        "V4HubReqExecution04Planned" => Vec::new(),
        "V4HubReqTarget05Resolved" => vec!["v4.control.route_facts".to_string()],
        "V4Router05RequestClassified" => vec!["v4.control.route_facts".to_string()],
        "V4Router06SelectionPlan" => vec!["v4.control.target_selection".to_string()],
        _ => Vec::new(),
    }
}

/// Node-scoped writes for a registered active node. This is the typed
/// adjacent transition surface: normal payload may become provider semantic,
/// provider semantic may become provider wire, and control/error/diagnostic
/// facts never enter a normal data or wire resource.
pub fn standard_node_allowed_writes(node_id: &str) -> Vec<String> {
    match node_id {
        "V4Error02HostCaptured" | "V4Error03RuntimeClassified" | "V4Error04RouterPolicyApplied"
        | "V4Error05ExecutionDecision" => vec!["v4.control.error_chain".to_string()],
        "V4DirectReq02RelayContainer" => vec!["v4.direct.request.provider_wire".to_string()],
        "V4DirectResp02RelayContainer" => vec!["v4.direct.response.client_payload".to_string()],
        "V4HubReqOutbound06ProviderSemantic" => vec!["v4.request.provider_semantic".to_string()],
        "V4HubReqInbound02Normalized" => Vec::new(),
        "V4ProviderRespInbound01Raw" => vec!["v4.response.provider_raw".to_string()],
        "V4DirectResp01ProviderRaw" => vec!["v4.direct.response.provider_raw".to_string()],
        "V4HubReqChatProcess03Governed" => vec!["v4.request.normal_payload".to_string()],
        "V4HubRespInbound03Normalized" => vec!["v4.response.normal_payload".to_string()],
        "V4ProviderRespCompat02ProviderCompat" => vec!["v4.response.provider_raw".to_string()],
        "V4HubRespChatProcess04Governed" => vec![
            "v4.response.normal_payload".to_string(),
            "v4.control.metadata_center".to_string(),
        ],
        "V4HubRespOutbound05ClientSemantic" => vec!["v4.response.client_wire_payload".to_string()],
        "V4ProviderReqCompat07ProviderCompat" | "V4ProviderReqOutbound08WirePayload" => {
            vec!["v4.request.provider_wire_payload".to_string()]
        }
        "V4ServerRespOutbound06ClientFrame" => vec!["v4.response.client_object".to_string()],
        "V4MetadataCenter01ScopeRegistry" => vec!["v4.control.metadata_center".to_string()],
        "V4PayloadCycleRegistry" => vec!["v4.lifecycle.payload_cycle".to_string()],
        "V4Error01SourceRaised" => vec!["v4.control.error_chain".to_string()],
        "V4Error06ClientProjected" => vec!["v4.control.error_chain".to_string()],
        "V4HubReqExecution04Planned" => vec!["v4.control.route_facts".to_string()],
        "V4HubReqTarget05Resolved" => vec!["v4.control.target_selection".to_string()],
        "V4Router05RequestClassified" | "V4Router06SelectionPlan" => Vec::new(),
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
    let mut codec = plugin(
        "v4.std.provider.wire_build",
        PluginCategory::Provider,
        "V4ProviderReqOutbound08WirePayload",
        "request_outbound",
        Some(8),
        PluginKind::Operator,
        PluginEffect::Semantic,
        PluginPhase::Semantic,
        200,
        vec![
            "v4.request.provider_semantic",
            "v4.information.client_protocol",
            "v4.information.provider_protocol",
        ],
        vec!["v4.request.provider_wire_payload"],
    );
    codec.descriptor.selection_group = Some("provider_wire_codec".to_string());

    let mut plugins = vec![
        plugin(
            "v4.std.contract.input_validate",
            PluginCategory::Contracts,
            "V4HubReqInbound02Normalized",
            "request_inbound",
            Some(2),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Admission,
            10,
            vec!["v4.request.normal_payload"],
            vec![],
        ),
        plugin(
            "v4.std.contract.output_validate",
            PluginCategory::Contracts,
            "V4HubRespOutbound05ClientSemantic",
            "response_outbound",
            Some(5),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Validation,
            800,
            vec!["v4.response.normal_payload"],
            vec![],
        ),
        plugin(
            "v4.std.diagnostic.debug_observe",
            PluginCategory::Diagnostic,
            "V4HubReqChatProcess03Governed",
            "request_chat_process",
            Some(3),
            PluginKind::Debug,
            PluginEffect::DiagnosticOnly,
            PluginPhase::Observation,
            900,
            vec!["v4.request.normal_payload"],
            vec![],
        ),
        plugin(
            "v4.std.diagnostic.timing",
            PluginCategory::Diagnostic,
            "V4HubReqChatProcess03Governed",
            "request_chat_process",
            Some(3),
            PluginKind::Observer,
            PluginEffect::DiagnosticOnly,
            PluginPhase::Observation,
            901,
            vec![],
            vec![],
        ),
        plugin(
            "v4.std.diagnostic.snapshot_record",
            PluginCategory::Diagnostic,
            "V4HubReqChatProcess03Governed",
            "request_chat_process",
            Some(3),
            PluginKind::Snapshot,
            PluginEffect::DiagnosticOnly,
            PluginPhase::Observation,
            902,
            vec![],
            vec![],
        ),
        plugin(
            "v4.std.diagnostic.request_payload_console_render",
            PluginCategory::Diagnostic,
            "V4HubReqChatProcess03Governed",
            "request_chat_process",
            Some(3),
            PluginKind::Observer,
            PluginEffect::DiagnosticOnly,
            PluginPhase::Observation,
            903,
            vec!["v4.request.normal_payload"],
            vec![],
        ),
        plugin(
            "v4.std.diagnostic.response_payload_console_render",
            PluginCategory::Diagnostic,
            "V4HubRespChatProcess04Governed",
            "response_chat_process",
            Some(4),
            PluginKind::Observer,
            PluginEffect::DiagnosticOnly,
            PluginPhase::Observation,
            903,
            vec!["v4.response.normal_payload"],
            vec![],
        ),
        plugin(
            "v4.std.diagnostic.direct_request_payload_console_render",
            PluginCategory::Diagnostic,
            "V4DirectReq01ClientProtocol",
            "request_inbound",
            Some(1),
            PluginKind::Observer,
            PluginEffect::DiagnosticOnly,
            PluginPhase::Observation,
            903,
            vec!["v4.direct.request.client_payload"],
            vec![],
        ),
        plugin(
            "v4.std.diagnostic.direct_response_payload_console_render",
            PluginCategory::Diagnostic,
            "V4DirectResp01ProviderRaw",
            "response_inbound",
            Some(1),
            PluginKind::Observer,
            PluginEffect::DiagnosticOnly,
            PluginPhase::Observation,
            903,
            vec!["v4.direct.response.provider_raw"],
            vec![],
        ),
        plugin(
            "v4.std.control.scope_consume",
            PluginCategory::Control,
            "V4MetadataCenter01ScopeRegistry",
            "control_center",
            Some(1),
            PluginKind::Control,
            PluginEffect::ControlOnly,
            PluginPhase::Control,
            100,
            vec!["v4.control.metadata_center"],
            vec!["v4.control.metadata_center"],
        ),
        plugin(
            "v4.std.control.payload_cycle_record",
            PluginCategory::Control,
            "V4PayloadCycleRegistry",
            "control_center",
            Some(2),
            PluginKind::Control,
            PluginEffect::ControlOnly,
            PluginPhase::Control,
            100,
            vec!["v4.lifecycle.payload_cycle"],
            vec!["v4.lifecycle.payload_cycle"],
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
        plugin(
            "v4.std.error.projection_adapter",
            PluginCategory::Error,
            "V4Error06ClientProjected",
            "error_projection",
            Some(6),
            PluginKind::Operator,
            PluginEffect::ControlOnly,
            PluginPhase::Projection,
            500,
            vec!["v4.control.error_chain"],
            vec!["v4.control.error_chain"],
        ),
        plugin(
            "v4.std.error.host_capture",
            PluginCategory::Error,
            "V4Error02HostCaptured",
            "error_source",
            Some(2),
            PluginKind::Operator,
            PluginEffect::ControlOnly,
            PluginPhase::Semantic,
            310,
            vec!["v4.control.error_chain"],
            vec!["v4.control.error_chain"],
        ),
        plugin(
            "v4.std.error.runtime_classify",
            PluginCategory::Error,
            "V4Error03RuntimeClassified",
            "error_classify",
            Some(3),
            PluginKind::Operator,
            PluginEffect::ControlOnly,
            PluginPhase::Semantic,
            320,
            vec!["v4.control.error_chain"],
            vec!["v4.control.error_chain"],
        ),
        plugin(
            "v4.std.error.router_policy",
            PluginCategory::Error,
            "V4Error04RouterPolicyApplied",
            "error_policy",
            Some(4),
            PluginKind::Operator,
            PluginEffect::ControlOnly,
            PluginPhase::Semantic,
            330,
            vec!["v4.control.error_chain"],
            vec!["v4.control.error_chain"],
        ),
        plugin(
            "v4.std.error.execution_decision",
            PluginCategory::Error,
            "V4Error05ExecutionDecision",
            "error_decision",
            Some(5),
            PluginKind::Operator,
            PluginEffect::ControlOnly,
            PluginPhase::Semantic,
            340,
            vec!["v4.control.error_chain"],
            vec!["v4.control.error_chain"],
        ),
        codec,
        plugin(
            "v4.std.chat_process.response_governance",
            PluginCategory::ChatProcess,
            "V4HubRespChatProcess04Governed",
            "response_chat_process",
            Some(4),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Semantic,
            300,
            vec!["v4.response.normal_payload"],
            vec![],
        ),
        plugin(
            "v4.std.chat_process.tool_harvest",
            PluginCategory::ChatProcess,
            "V4HubRespChatProcess04Governed",
            "response_chat_process",
            Some(4),
            PluginKind::Observer,
            PluginEffect::ReadOnly,
            PluginPhase::Semantic,
            350,
            vec!["v4.response.normal_payload"],
            vec![],
        ),
        plugin(
            "v4.std.routing.route_facts_producer",
            PluginCategory::Routing,
            "V4HubReqExecution04Planned",
            "request_execution",
            Some(4),
            PluginKind::Operator,
            PluginEffect::ControlOnly,
            PluginPhase::Semantic,
            300,
            vec![],
            vec!["v4.control.route_facts"],
        ),
        plugin(
            "v4.std.routing.route_facts_consumer",
            PluginCategory::Routing,
            "V4HubReqTarget05Resolved",
            "request_execution",
            Some(5),
            PluginKind::Operator,
            PluginEffect::ControlOnly,
            PluginPhase::Semantic,
            350,
            vec!["v4.control.route_facts"],
            vec!["v4.control.target_selection"],
        ),
        plugin(
            "v4.std.provider.capability_mock",
            PluginCategory::Provider,
            "V4ProviderReqOutbound09TransportRequest",
            "request_outbound",
            Some(9),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Semantic,
            210,
            vec!["v4.config.manifest"],
            vec![],
        ),
        plugin(
            "v4.std.provider.auth_handle_mock",
            PluginCategory::Provider,
            "V4ProviderReqOutbound09TransportRequest",
            "request_outbound",
            Some(9),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Semantic,
            220,
            vec!["v4.secret.provider_auth_handle"],
            vec![],
        ),
        plugin(
            "v4.std.provider.wire_mock",
            PluginCategory::Provider,
            "V4HubReqOutbound06ProviderSemantic",
            "request_outbound",
            Some(6),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Projection,
            500,
            vec!["v4.request.normal_payload"],
            vec!["v4.request.provider_semantic"],
        ),
        plugin(
            "v4.std.provider.transport_mock",
            PluginCategory::Provider,
            "V4ProviderReqOutbound09TransportRequest",
            "request_outbound",
            Some(9),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Projection,
            550,
            vec!["v4.request.provider_wire_payload"],
            vec![],
        ),
        plugin(
            "v4.std.provider.transport_validate",
            PluginCategory::Provider,
            "V4ProviderReqOutbound09TransportRequest",
            "request_outbound",
            Some(9),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Validation,
            800,
            vec!["v4.request.provider_wire_payload"],
            vec![],
        ),
    ];
    plugins.extend(response_inbound::protocol_decode_descriptors());
    plugins.extend(response_outbound::response_outbound_descriptors());
    plugins.extend(request_plugins::descriptors());
    plugins.extend(model_hooks::descriptors());
    plugins
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductionExecutionPlans {
    pub plans: Vec<NodePluginPlan>,
    pub artifact_set_hash: String,
}

/// Compile the six production execution lanes from the canonical skeleton.
/// SSE remains outside this JSON semantic graph; mock and superseded plugin
/// variants are never eligible for publication.
pub fn compile_production_execution_plans(
    skeleton: &SkeletonPlan,
) -> Result<ProductionExecutionPlans, routecodex_v4_plugin_plan::PlanError> {
    const PRODUCTION_CHAINS: [&str; 6] = [
        "direct_request",
        "direct_response",
        "relay_request",
        "relay_response",
        "error",
        "control",
    ];
    const EXCLUDED_PLUGINS: [&str; 5] = [
        "v4.std.provider.capability_mock",
        "v4.std.provider.auth_handle_mock",
        "v4.std.provider.wire_mock",
        "v4.std.provider.transport_mock",
        "v4.std.protocol.wire_codec_proto",
    ];

    let plugins = standard_plugins();
    let mut plans = Vec::new();
    let mut artifact_hashes = Vec::new();
    for chain_id in PRODUCTION_CHAINS {
        let chain = skeleton
            .chains
            .iter()
            .find(|chain| chain.chain_id == chain_id)
            .ok_or_else(
                || routecodex_v4_plugin_plan::PlanError::NodeContractInvalid {
                    reason: format!("missing production chain {chain_id}"),
                },
            )?;
        for node in &chain.nodes {
            let selected = plugins
                .iter()
                .filter(|plugin| plugin.descriptor.node_selector.node_id == node.node_id)
                .filter(|plugin| !EXCLUDED_PLUGINS.contains(&plugin.plugin_id.as_str()))
                .collect::<Vec<_>>();
            let plan = if selected.is_empty() {
                return Err(routecodex_v4_plugin_plan::PlanError::NodeContractInvalid {
                    reason: format!(
                        "production node {} on {} has no standard plugin binding",
                        node.node_id, chain_id
                    ),
                });
            } else {
                let authoring = selected
                    .iter()
                    .map(|plugin| AuthoringPlugin {
                        descriptor: plugin.descriptor.clone(),
                        enabled: true,
                    })
                    .collect::<Vec<_>>();
                compile_node_plan(
                    &node.node_id,
                    &node.role_id,
                    chain_id,
                    node.position,
                    &authoring,
                    &standard_node_allowed_reads(&node.node_id),
                    &standard_node_allowed_writes(&node.node_id),
                    &standard_resource_registry(),
                    &standard_container_services(),
                )?
            };
            artifact_hashes.extend(
                selected
                    .iter()
                    .map(|plugin| plugin.descriptor.artifact_hash.clone()),
            );
            plans.push(plan);
        }
    }
    artifact_hashes.sort();
    artifact_hashes.dedup();
    let encoded =
        serde_json::to_vec(&artifact_hashes).expect("standard artifact hash set is serializable");
    Ok(ProductionExecutionPlans {
        plans,
        artifact_set_hash: format!("sha256:{}", sha256_hex(&encoded)),
    })
}

struct StandardHandle {
    execute_fn: fn(&mut ExecCtx<'_>) -> Result<(), String>,
}

impl PluginHandle for StandardHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        (self.execute_fn)(ctx)
    }
}

fn validate_input(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let data = ctx.read_data();
    let object = data
        .as_object()
        .ok_or_else(|| "input validator requires an object".to_string())?;
    boundary::reject_control_fields(object)?;
    ctx.emit("node.input_validated", "standard input validator");
    Ok(())
}

fn validate_output(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let data = ctx.read_data();
    let object = data
        .as_object()
        .ok_or_else(|| "output validator requires an object".to_string())?;
    boundary::reject_response_control_fields(object)?;
    ctx.emit("node.output_validated", "standard output validator");
    Ok(())
}

fn debug_observe(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    ctx.emit("node.debug_observe", "debug observation emitted");
    Ok(())
}

fn timing(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    ctx.emit("node.timing", "timing observation emitted");
    Ok(())
}

fn snapshot_record(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    ctx.emit("node.snapshot", "snapshot observation emitted");
    Ok(())
}

fn request_payload_console(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    chat_process_payload_console(ctx, "request")
}

fn response_payload_console(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    chat_process_payload_console(ctx, "response")
}

fn chat_process_payload_console(ctx: &mut ExecCtx<'_>, direction: &str) -> Result<(), String> {
    let line = diagnostic::format_chat_process_payload(direction, ctx.read_data())?;
    ctx.emit("console.payload_ready", line);
    Ok(())
}

fn scope_consume(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let mut metadata = ctx
        .read_control_resource("v4.control.metadata_center")
        .map_err(|error| error.to_string())?
        .cloned()
        .ok_or_else(|| {
            "scope_consume requires existing typed metadata center resource".to_string()
        })?;
    let object = metadata
        .as_object_mut()
        .ok_or_else(|| "scope_consume requires typed metadata object".to_string())?;
    object.insert("scope".to_string(), json!({"consumed": true}));
    ctx.write_control_resource("v4.control.metadata_center", metadata)
        .map_err(|error| error.to_string())
}

fn payload_cycle_record(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let mut payload_cycle = ctx
        .read_control_resource("v4.lifecycle.payload_cycle")
        .map_err(|error| error.to_string())?
        .cloned()
        .ok_or_else(|| {
            "payload_cycle_record requires existing typed payload cycle resource".to_string()
        })?;
    let object = payload_cycle
        .as_object_mut()
        .ok_or_else(|| "payload_cycle_record requires typed cycle object".to_string())?;
    object.insert("recorded".to_string(), json!(true));
    ctx.write_control_resource("v4.lifecycle.payload_cycle", payload_cycle)
        .map_err(|error| error.to_string())
}

pub(crate) fn error_intake(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let mut error_chain = ctx
        .read_control_resource("v4.control.error_chain")
        .map_err(|error| error.to_string())?
        .cloned()
        .ok_or_else(|| "error_intake requires existing typed error chain resource".to_string())?;
    let object = error_chain
        .as_object_mut()
        .ok_or_else(|| "error_intake requires typed error object".to_string())?;
    require_required_string(object, "code", "error chain")?;
    object.insert("stage".to_string(), json!("source_raised"));
    object.insert("kind".to_string(), json!("keyless_mock"));
    ctx.write_control_resource("v4.control.error_chain", error_chain)
        .map_err(|error| error.to_string())
}

fn error_stage(ctx: &mut ExecCtx<'_>, stage: &str) -> Result<(), String> {
    let mut chain = ctx
        .read_control_resource("v4.control.error_chain")
        .map_err(|error| error.to_string())?
        .cloned()
        .ok_or_else(|| format!("error stage {stage} requires typed error chain"))?;
    let object = chain
        .as_object_mut()
        .ok_or_else(|| format!("error stage {stage} requires typed error object"))?;
    require_required_string(object, "code", "error chain")?;
    object.insert("stage".to_string(), json!(stage));
    ctx.write_control_resource("v4.control.error_chain", chain)
        .map_err(|error| error.to_string())
}

fn require_required_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
    owner: &str,
) -> Result<(), String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|_| ())
        .ok_or_else(|| format!("{owner} requires non-empty string {key}"))
}

fn error_host_capture(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    error_stage(ctx, "host_captured")
}

fn error_runtime_classify(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    error_stage(ctx, "runtime_classified")
}

fn error_router_policy(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    error_stage(ctx, "router_policy_applied")
}

fn error_execution_decision(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    error_stage(ctx, "execution_decision")
}

fn error_projection(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let mut error_chain = ctx
        .read_control_resource("v4.control.error_chain")
        .map_err(|error| error.to_string())?
        .cloned()
        .ok_or_else(|| {
            "error_projection requires existing typed error chain resource".to_string()
        })?;
    let object = error_chain
        .as_object_mut()
        .ok_or_else(|| "error_projection requires typed error object".to_string())?;
    object.insert("error_projection".to_string(), json!({"projected": true}));
    ctx.write_control_resource("v4.control.error_chain", error_chain)
        .map_err(|error| error.to_string())
}

pub(crate) fn response_governance(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    ctx.read_data()
        .as_object()
        .ok_or_else(|| "response governance requires an object".to_string())?;
    ctx.emit("response_governance", "response payload governed");
    Ok(())
}

pub(crate) fn tool_harvest(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let object = ctx
        .read_data()
        .as_object()
        .ok_or_else(|| "tool harvest requires an object".to_string())?;

    let mut calls = Vec::new();
    collect_tool_calls(object.get("tool_calls"), &mut calls)?;
    if let Some(choices) = object.get("choices").and_then(Value::as_array) {
        for choice in choices {
            collect_tool_calls(
                choice
                    .get("message")
                    .and_then(|message| message.get("tool_calls")),
                &mut calls,
            )?;
        }
    }

    let mut outputs = Vec::new();
    collect_tool_outputs(object.get("tool_outputs"), &mut outputs)?;
    if let Some(choices) = object.get("choices").and_then(Value::as_array) {
        for choice in choices {
            collect_tool_outputs(
                choice
                    .get("message")
                    .and_then(|message| message.get("tool_outputs")),
                &mut outputs,
            )?;
        }
    }

    ctx.emit(
        "tool_harvest_count",
        format!("tool_calls={} tool_outputs={}", calls.len(), outputs.len()),
    );
    Ok(())
}

fn collect_tool_calls(value: Option<&Value>, calls: &mut Vec<String>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    let Some(items) = value.as_array() else {
        return Err("tool_calls must be an array".to_string());
    };
    for item in items {
        let Some(item) = item.as_object() else {
            return Err("tool call must be an object".to_string());
        };
        let id = required_string(item, "id")?;
        let function = item
            .get("function")
            .and_then(Value::as_object)
            .ok_or_else(|| "tool call function must be an object".to_string())?;
        required_string(function, "name")?;
        if function.get("arguments").is_none() {
            return Err("tool call arguments are required".to_string());
        }
        if calls.contains(&id) {
            return Err(format!("duplicate tool call id {id}"));
        }
        calls.push(id);
    }
    Ok(())
}

fn collect_tool_outputs(value: Option<&Value>, outputs: &mut Vec<String>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    let Some(items) = value.as_array() else {
        return Err("tool_outputs must be an array".to_string());
    };
    for item in items {
        let Some(item) = item.as_object() else {
            return Err("tool output must be an object".to_string());
        };
        let call_id = required_string(item, "call_id")?;
        if item.get("output").is_none() {
            return Err("tool output is required".to_string());
        }
        if outputs.contains(&call_id) {
            return Err(format!("duplicate tool output call_id {call_id}"));
        }
        outputs.push(call_id);
    }
    Ok(())
}

fn required_string(object: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} must be a non-empty string"))
}

fn route_facts_produce(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    ctx.write_control_resource("v4.control.route_facts", json!({"keyless": true}))
        .map_err(|error| error.to_string())
}

fn route_facts_consume(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    if ctx
        .read_control_resource("v4.control.route_facts")
        .map_err(|error| error.to_string())?
        .is_none()
    {
        return Err("route facts consumer requires typed route facts".to_string());
    }
    ctx.write_control_resource(
        "v4.control.target_selection",
        json!({"selected": "keyless_mock"}),
    )
    .map_err(|error| error.to_string())
}

fn capability_mock(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    ctx.emit(
        "node.provider_capability_validated",
        "keyless provider capability validated",
    );
    Ok(())
}

fn auth_handle_mock(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    ctx.emit(
        "node.provider_auth_handle_validated",
        "keyless auth handle shape validated",
    );
    Ok(())
}

fn wire_mock(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let mut data = ctx.read_data().clone();
    let object = data
        .as_object_mut()
        .ok_or_else(|| "wire mock requires object payload".to_string())?;
    object.insert("wire".to_string(), json!({"mock": true}));
    ctx.write_data(data).map_err(|error| error.to_string())
}

fn transport_mock(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    if !ctx.read_data().is_object() {
        return Err("transport validator requires provider wire object".to_string());
    }
    ctx.emit(
        "node.provider_transport_validated",
        "provider wire transport boundary validated",
    );
    Ok(())
}

/// Registry of typed handles for every standard plugin. One immutable handle
/// per plugin id; unknown ids fail fast through the bridge.
pub struct StandardHandleRegistry {
    handles: HashMap<&'static str, StandardHandle>,
}

impl StandardHandleRegistry {
    pub fn new() -> Self {
        let mut handles = HashMap::new();
        for (id, execute_fn) in [
            (
                "v4.std.contract.input_validate",
                validate_input as fn(&mut ExecCtx<'_>) -> Result<(), String>,
            ),
            ("v4.std.contract.output_validate", validate_output),
            ("v4.std.diagnostic.debug_observe", debug_observe),
            ("v4.std.diagnostic.timing", timing),
            ("v4.std.diagnostic.snapshot_record", snapshot_record),
            (
                "v4.std.diagnostic.request_payload_console_render",
                request_payload_console,
            ),
            (
                "v4.std.diagnostic.response_payload_console_render",
                response_payload_console,
            ),
            (
                "v4.std.diagnostic.direct_request_payload_console_render",
                request_payload_console,
            ),
            (
                "v4.std.diagnostic.direct_response_payload_console_render",
                response_payload_console,
            ),
            ("v4.std.control.scope_consume", scope_consume),
            ("v4.std.control.payload_cycle_record", payload_cycle_record),
            ("v4.std.error.typed_intake", error_intake),
            ("v4.std.error.projection_adapter", error_projection),
            ("v4.std.error.host_capture", error_host_capture),
            ("v4.std.error.runtime_classify", error_runtime_classify),
            ("v4.std.error.router_policy", error_router_policy),
            ("v4.std.error.execution_decision", error_execution_decision),
            (
                "v4.std.provider.wire_build",
                request_plugins::wire_build,
            ),
            (
                "v4.std.chat_process.response_governance",
                response_governance,
            ),
            ("v4.std.chat_process.tool_harvest", tool_harvest),
            ("v4.std.routing.route_facts_producer", route_facts_produce),
            ("v4.std.routing.route_facts_consumer", route_facts_consume),
            ("v4.std.provider.capability_mock", capability_mock),
            ("v4.std.provider.auth_handle_mock", auth_handle_mock),
            ("v4.std.provider.wire_mock", wire_mock),
            ("v4.std.provider.transport_mock", transport_mock),
            ("v4.std.provider.transport_validate", transport_mock),
        ] {
            handles.insert(id, StandardHandle { execute_fn });
        }
        for (id, execute_fn) in response_inbound::response_inbound_handles() {
            handles.insert(id, StandardHandle { execute_fn });
        }
        for (id, execute_fn) in response_outbound::response_outbound_handles() {
            handles.insert(id, StandardHandle { execute_fn });
        }
        for (id, execute_fn) in request_plugins::handles() {
            handles.insert(id, StandardHandle { execute_fn });
        }
        for (id, execute_fn) in model_hooks::handles() {
            handles.insert(id, StandardHandle { execute_fn });
        }
        Self { handles }
    }

    pub fn get_handle(&self, plugin_id: &str) -> Option<&dyn PluginHandle> {
        self.handles
            .get(plugin_id)
            .map(|handle| handle as &dyn PluginHandle)
    }

    /// Encode a client-visible SSE error through the response-outbound
    /// plugin owner. Runtime orchestration must not call the codec directly.
    pub fn encode_client_error_sse(
        &self,
        entry_protocol: &str,
        message: &str,
    ) -> Result<Vec<u8>, String> {
        response_outbound::encode_client_error_sse_frame(entry_protocol, message)
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
            "v4.std.contract.input_validate",
            "v4.std.contract.output_validate",
            "v4.std.diagnostic.debug_observe",
            "v4.std.diagnostic.request_payload_console_render",
            "v4.std.diagnostic.response_payload_console_render",
            "v4.std.diagnostic.direct_request_payload_console_render",
            "v4.std.diagnostic.direct_response_payload_console_render",
            "v4.std.diagnostic.timing",
            "v4.std.diagnostic.snapshot_record",
            "v4.std.direct.request.wire_validate",
            "v4.std.direct.response.client_validate",
            "v4.std.control.scope_consume",
            "v4.std.control.payload_cycle_record",
            "v4.std.error.typed_intake",
            "v4.std.error.projection_adapter",
            "v4.std.error.host_capture",
            "v4.std.error.runtime_classify",
            "v4.std.error.router_policy",
            "v4.std.error.execution_decision",
            "v4.std.provider.wire_build",
            "v4.std.chat_process.request_governance",
            "v4.std.chat_process.response_governance",
            "v4.std.chat_process.tool_harvest",
            "v4.std.routing.route_facts_producer",
            "v4.std.routing.route_facts_consumer",
            "v4.std.provider.capability_mock",
            "v4.std.provider.auth_handle_mock",
            "v4.std.provider.wire_mock",
            "v4.std.provider.transport_mock",
            "v4.std.provider.transport_validate",
            "v4.std.response.protocol_decode",
            "v4.std.response.frame_build",
            "v4.std.response.provider_compat",
            "v4.std.response.provider_raw_validate",
            "v4.std.response.sse_frame_boundary",
            "v4.std.direct.response.sse_frame_boundary",
            "v4.std.request.responses_normalize",
            "v4.std.request.protocol_parse",
            "v4.std.request.responses_wire_build",
            "v4.hook.direct.request",
            "v4.hook.relay.request",
            "v4.hook.direct.response",
            "v4.hook.relay.response",
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

    #[test]
    fn production_compilation_has_no_empty_node_plans() {
        let skeleton = SkeletonPlan::from_contract_json(include_str!(
            "../../../contracts/skeleton-plan.contract.json"
        ))
        .expect("canonical skeleton contract must parse");
        let compiled = compile_production_execution_plans(&skeleton)
            .expect("every production node must have a real standard plugin binding");
        assert!(compiled.plans.iter().all(|plan| !plan.entries.is_empty()));
        let expected_nodes = skeleton
            .chains
            .iter()
            .filter(|chain| chain.chain_id != "config")
            .map(|chain| chain.nodes.len())
            .sum::<usize>();
        assert_eq!(compiled.plans.len(), expected_nodes);
        assert!(compiled
            .plans
            .iter()
            .all(|plan| plan.entries.iter().all(|entry| !entry.plugin_id.is_empty())));
    }
}
