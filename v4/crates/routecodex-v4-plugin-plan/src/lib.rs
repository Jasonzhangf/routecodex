//! V4 NodePluginPlan — deterministic compilation of one node's ordered plugin
//! plan. Pure compiler: phase partial order -> before/after DAG -> order ->
//! stable identity; selection groups resolve to exactly one active variant;
//! resource and service boundaries are validated before publication.
//!
//! Hard boundaries:
//! - never executes plugins and never decides control flow across nodes;
//! - the compiled plan is immutable; plan_hash binds the canonical plan body;
//! - Cordis graph hash, compiled Manifest plan hash and the Rust loaded plan
//!   hash must match before publish or execute (checked by the host layer).

use std::collections::{HashMap, HashSet, VecDeque};

use routecodex_v4_plugin_contract::{
    canonical_json, validate_descriptor, NodePluginDescriptor, PluginEffect, PluginKind,
    PluginPhase, ResourceRegistry,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthoringPlugin {
    pub descriptor: NodePluginDescriptor,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanEntry {
    pub plugin_id: String,
    pub version: String,
    pub kind: PluginKind,
    pub effect: PluginEffect,
    pub phase: PluginPhase,
    pub order: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_group: Option<String>,
    pub reads: Vec<String>,
    pub writes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectionGroup {
    pub group_id: String,
    pub active_plugin: String,
    pub variants: Vec<String>,
}

/// Compiled immutable plan for one node. `hash` covers the canonical JSON of
/// the plan body with the `hash` field removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodePluginPlan {
    pub node_id: String,
    pub position: u32,
    pub role_id: String,
    pub chain: String,
    pub entries: Vec<PlanEntry>,
    pub selection_groups: Vec<SelectionGroup>,
    pub hash: String,
}

impl NodePluginPlan {
    /// Deterministic canonical plan hash. Stable for the same semantic plan
    /// regardless of authoring order or map iteration order.
    pub fn plan_hash(&self) -> String {
        let mut value = serde_json::to_value(self).expect("plan is serializable");
        if let Some(object) = value.as_object_mut() {
            object.remove("hash");
        }
        let mut hasher = Sha256::new();
        hasher.update(canonical_json(&value).as_bytes());
        hex(&hasher.finalize())
    }

    /// Recompute and compare the stored hash. Returns false on drift.
    pub fn verify(&self) -> bool {
        self.hash == self.plan_hash()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    InvalidPlugin {
        plugin_id: String,
        reason: String,
    },
    MissingDependency {
        plugin_id: String,
        dependency: String,
    },
    VersionConflict {
        plugin_id: String,
        dependency: String,
        requirement: String,
        found: String,
    },
    DependencyCycle {
        plugin_id: String,
        dependency: String,
    },
    OrderingCycle,
    Tie {
        plugin_id: String,
        other: String,
        phase: String,
        order: u32,
    },
    PhaseOrderConflict {
        plugin_id: String,
        target: String,
    },
    ZeroSelection(String),
    MultiSelection {
        group_id: String,
        active: Vec<String>,
    },
    UnauthorizedRead {
        plugin_id: String,
        resource_id: String,
    },
    UnauthorizedWrite {
        plugin_id: String,
        resource_id: String,
    },
    CrossNodeService {
        plugin_id: String,
        service: String,
    },
    UnregisteredOperator(String),
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPlugin {
                plugin_id,
                reason,
            } => write!(formatter, "plugin {plugin_id}: {reason}"),
            Self::MissingDependency {
                plugin_id,
                dependency,
            } => write!(formatter, "plugin {plugin_id} missing dependency {dependency}"),
            Self::VersionConflict {
                plugin_id,
                dependency,
                requirement,
                found,
            } => write!(
                formatter,
                "plugin {plugin_id} dependency {dependency} requires {requirement}, found {found}"
            ),
            Self::DependencyCycle {
                plugin_id,
                dependency,
            } => write!(formatter, "dependency cycle {plugin_id} <-> {dependency}"),
            Self::OrderingCycle => write!(formatter, "before/after ordering cycle"),
            Self::Tie {
                plugin_id,
                other,
                phase,
                order,
            } => write!(
                formatter,
                "order tie between {plugin_id} and {other} in phase {phase} at order {order} without declared relation"
            ),
            Self::PhaseOrderConflict {
                plugin_id,
                target,
            } => write!(
                formatter,
                "plugin {plugin_id} declares relation to {target} violating phase partial order"
            ),
            Self::ZeroSelection(group) => write!(formatter, "selection group {group} has zero active variants"),
            Self::MultiSelection {
                group_id,
                active,
            } => write!(
                formatter,
                "selection group {group_id} has multiple active variants: {}",
                active.join(",")
            ),
            Self::UnauthorizedRead {
                plugin_id,
                resource_id,
            } => write!(formatter, "plugin {plugin_id} reads unauthorized resource {resource_id}"),
            Self::UnauthorizedWrite {
                plugin_id,
                resource_id,
            } => write!(formatter, "plugin {plugin_id} writes unauthorized resource {resource_id}"),
            Self::CrossNodeService {
                plugin_id,
                service,
            } => write!(
                formatter,
                "plugin {plugin_id} injects service {service} not provided inside this node"
            ),
            Self::UnregisteredOperator(plugin_id) => {
                write!(formatter, "plugin {plugin_id} is not a registered operator")
            }
        }
    }
}

impl std::error::Error for PlanError {}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn phase_index(phase: PluginPhase) -> u8 {
    match phase {
        PluginPhase::Admission => 0,
        PluginPhase::Control => 1,
        PluginPhase::Semantic => 2,
        PluginPhase::Validation => 3,
        PluginPhase::Projection => 4,
        PluginPhase::Observation => 5,
    }
}

fn version_satisfies(found: &str, requirement: &str) -> bool {
    let requirement = requirement.trim();
    if let Some(min) = requirement.strip_prefix(">=") {
        compare_versions(found, min.trim()).is_ge()
    } else if let Some(min) = requirement.strip_prefix(">") {
        compare_versions(found, min.trim()).is_gt()
    } else {
        found == requirement
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VersionOrder {
    Lt,
    Eq,
    Gt,
}

impl VersionOrder {
    fn is_ge(self) -> bool {
        matches!(self, VersionOrder::Eq | VersionOrder::Gt)
    }

    fn is_gt(self) -> bool {
        matches!(self, VersionOrder::Gt)
    }
}

fn compare_versions(left: &str, right: &str) -> VersionOrder {
    let parse = |value: &str| -> Vec<u32> {
        value
            .split(|ch: char| !ch.is_ascii_digit())
            .filter_map(|part| part.parse::<u32>().ok())
            .collect()
    };
    let l = parse(left);
    let r = parse(right);
    for (a, b) in l.iter().zip(r.iter()) {
        if a < b {
            return VersionOrder::Lt;
        }
        if a > b {
            return VersionOrder::Gt;
        }
    }
    match l.len().cmp(&r.len()) {
        std::cmp::Ordering::Less => VersionOrder::Lt,
        std::cmp::Ordering::Greater => VersionOrder::Gt,
        std::cmp::Ordering::Equal => VersionOrder::Eq,
    }
}

fn topological_order<'a>(
    plugins: &'a [&'a NodePluginDescriptor],
) -> Result<Vec<&'a NodePluginDescriptor>, PlanError> {
    let ids: HashSet<&str> = plugins.iter().map(|plugin| plugin.plugin_id.as_str()).collect();
    let mut edges: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    for plugin in plugins {
        in_degree.insert(plugin.plugin_id.as_str(), 0usize);
        edges.insert(plugin.plugin_id.as_str(), Vec::new());
    }
    for plugin in plugins {
        for target in &plugin.before {
            if !ids.contains(target.as_str()) {
                return Err(PlanError::MissingDependency {
                    plugin_id: plugin.plugin_id.clone(),
                    dependency: target.clone(),
                });
            }
            let source_phase = phase_index(plugin.phase);
            let target_phase = phase_index(
                plugins
                    .iter()
                    .find(|candidate| candidate.plugin_id == *target)
                    .expect("target checked above")
                    .phase,
            );
            if target_phase < source_phase {
                return Err(PlanError::PhaseOrderConflict {
                    plugin_id: plugin.plugin_id.clone(),
                    target: target.clone(),
                });
            }
            edges
                .get_mut(plugin.plugin_id.as_str())
                .expect("edge entry exists")
                .push(target.as_str());
            *in_degree.get_mut(target.as_str()).expect("target entry exists") += 1;
        }
        for target in &plugin.after {
            if !ids.contains(target.as_str()) {
                return Err(PlanError::MissingDependency {
                    plugin_id: plugin.plugin_id.clone(),
                    dependency: target.clone(),
                });
            }
            let source_phase = phase_index(plugin.phase);
            let target_phase = phase_index(
                plugins
                    .iter()
                    .find(|candidate| candidate.plugin_id == *target)
                    .expect("target checked above")
                    .phase,
            );
            if target_phase > source_phase {
                return Err(PlanError::PhaseOrderConflict {
                    plugin_id: plugin.plugin_id.clone(),
                    target: target.clone(),
                });
            }
            edges
                .get_mut(target.as_str())
                .expect("target entry exists")
                .push(plugin.plugin_id.as_str());
            *in_degree.get_mut(plugin.plugin_id.as_str()).expect("plugin entry exists") += 1;
        }
    }

    let mut queue: VecDeque<&NodePluginDescriptor> = plugins
        .iter()
        .copied()
        .filter(|plugin| in_degree[plugin.plugin_id.as_str()] == 0)
        .collect();
    let mut ordered = Vec::new();
    let mut remaining: HashMap<&str, usize> = in_degree.clone();
    while !queue.is_empty() {
        queue.make_contiguous().sort_by(|a, b| {
            let phase_cmp = phase_index(a.phase).cmp(&phase_index(b.phase));
            phase_cmp
                .then(a.order.cmp(&b.order))
                .then(a.plugin_id.cmp(&b.plugin_id))
                .then(a.version.cmp(&b.version))
        });
        let plugin = queue.pop_front().expect("queue is non-empty");
        ordered.push(plugin);
        for target in &edges[plugin.plugin_id.as_str()] {
            let degree = remaining.get_mut(target).expect("target tracked");
            *degree -= 1;
            if *degree == 0 {
                let descriptor = plugins
                    .iter()
                    .copied()
                    .find(|candidate| candidate.plugin_id == *target)
                    .expect("target descriptor exists");
                queue.push_back(descriptor);
            }
        }
    }
    if ordered.len() != plugins.len() {
        return Err(PlanError::OrderingCycle);
    }
    Ok(ordered)
}

fn check_ties(plugins: &[&NodePluginDescriptor]) -> Result<(), PlanError> {
    for (index, left) in plugins.iter().enumerate() {
        for right in plugins.iter().skip(index + 1) {
            if left.phase != right.phase || left.order != right.order {
                continue;
            }
            let related = reachable(left, right, plugins) || reachable(right, left, plugins);
            if !related {
                return Err(PlanError::Tie {
                    plugin_id: left.plugin_id.clone(),
                    other: right.plugin_id.clone(),
                    phase: format!("{:?}", left.phase),
                    order: left.order,
                });
            }
        }
    }
    Ok(())
}

fn reachable<'a>(
    from: &'a NodePluginDescriptor,
    to: &'a NodePluginDescriptor,
    plugins: &'a [&'a NodePluginDescriptor],
) -> bool {
    let ids: HashSet<&str> = plugins.iter().map(|plugin| plugin.plugin_id.as_str()).collect();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for plugin in plugins {
        adjacency.insert(plugin.plugin_id.as_str(), Vec::new());
        for target in &plugin.before {
            if ids.contains(target.as_str()) {
                adjacency
                    .get_mut(plugin.plugin_id.as_str())
                    .expect("entry exists")
                    .push(target.as_str());
            }
        }
        for target in &plugin.after {
            if ids.contains(target.as_str()) {
                adjacency
                    .get_mut(target.as_str())
                    .expect("entry exists")
                    .push(plugin.plugin_id.as_str());
            }
        }
    }
    let mut queue = VecDeque::new();
    let mut visited = HashSet::new();
    queue.push_back(from.plugin_id.as_str());
    visited.insert(from.plugin_id.as_str());
    while let Some(current) = queue.pop_front() {
        if current == to.plugin_id {
            return true;
        }
        for next in &adjacency[current] {
            if visited.insert(next) {
                queue.push_back(next);
            }
        }
    }
    false
}

/// Compile one node's immutable plugin plan. `allowed_reads` / `allowed_writes`
/// are the node-scoped resource permissions; `resources` is the global registry
/// used for axis and effect validation.
pub fn compile_node_plan(
    node_id: &str,
    role_id: &str,
    chain: &str,
    position: u32,
    authoring: &[AuthoringPlugin],
    allowed_reads: &[String],
    allowed_writes: &[String],
    resources: &ResourceRegistry,
) -> Result<NodePluginPlan, PlanError> {
    let node_roles = vec![role_id.to_string()];
    for plugin in authoring {
        validate_descriptor(&plugin.descriptor, &node_roles, resources).map_err(|error| {
            PlanError::InvalidPlugin {
                plugin_id: plugin.descriptor.plugin_id.clone(),
                reason: error.to_string(),
            }
        })?;
    }

    let declared_groups: HashSet<&str> = authoring
        .iter()
        .filter_map(|plugin| plugin.descriptor.selection_group.as_deref())
        .collect();
    let mut group_active: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut group_variants: HashMap<&str, Vec<String>> = HashMap::new();
    for plugin in authoring {
        if let Some(group) = plugin.descriptor.selection_group.as_deref() {
            group_variants
                .entry(group)
                .or_default()
                .push(plugin.descriptor.plugin_id.clone());
            if plugin.enabled {
                group_active.entry(group).or_default().push(&plugin.descriptor.plugin_id);
            }
        }
    }
    let mut selection_groups = Vec::new();
    for group in declared_groups {
        let active = group_active.get(group).cloned().unwrap_or_default();
        if active.is_empty() {
            return Err(PlanError::ZeroSelection(group.to_string()));
        }
        if active.len() > 1 {
            return Err(PlanError::MultiSelection {
                group_id: group.to_string(),
                active: active.into_iter().map(String::from).collect(),
            });
        }
        selection_groups.push(SelectionGroup {
            group_id: group.to_string(),
            active_plugin: active[0].to_string(),
            variants: group_variants.get(group).cloned().unwrap_or_default(),
        });
    }

    let enabled: Vec<&NodePluginDescriptor> = authoring
        .iter()
        .filter(|plugin| plugin.enabled)
        .map(|plugin| &plugin.descriptor)
        .collect();
    if enabled.is_empty() {
        return Err(PlanError::UnregisteredOperator(node_id.to_string()));
    }
    let enabled_ids: HashSet<&str> = enabled
        .iter()
        .map(|plugin| plugin.plugin_id.as_str())
        .collect();

    for plugin in &enabled {
        for dependency in &plugin.depends_on {
            let target = enabled
                .iter()
                .find(|candidate| candidate.plugin_id == dependency.plugin_id)
                .ok_or_else(|| PlanError::MissingDependency {
                    plugin_id: plugin.plugin_id.clone(),
                    dependency: dependency.plugin_id.clone(),
                })?;
            if !version_satisfies(&target.version, &dependency.version_req) {
                return Err(PlanError::VersionConflict {
                    plugin_id: plugin.plugin_id.clone(),
                    dependency: dependency.plugin_id.clone(),
                    requirement: dependency.version_req.clone(),
                    found: target.version.clone(),
                });
            }
        }
    }

    let provided_services: HashSet<&str> = enabled
        .iter()
        .flat_map(|plugin| plugin.services_provided.iter().map(String::as_str))
        .collect();
    for plugin in &enabled {
        for service in &plugin.inject {
            if !provided_services.contains(service.as_str()) {
                return Err(PlanError::CrossNodeService {
                    plugin_id: plugin.plugin_id.clone(),
                    service: service.clone(),
                });
            }
        }
        for resource in &plugin.reads {
            if !allowed_reads.iter().any(|allowed| allowed == resource) {
                return Err(PlanError::UnauthorizedRead {
                    plugin_id: plugin.plugin_id.clone(),
                    resource_id: resource.clone(),
                });
            }
        }
        for resource in &plugin.writes {
            if !allowed_writes.iter().any(|allowed| allowed == resource) {
                return Err(PlanError::UnauthorizedWrite {
                    plugin_id: plugin.plugin_id.clone(),
                    resource_id: resource.clone(),
                });
            }
        }
    }

    check_ties(&enabled)?;
    let ordered = topological_order(&enabled)?;

    let entries: Vec<PlanEntry> = ordered
        .into_iter()
        .map(|plugin| PlanEntry {
            plugin_id: plugin.plugin_id.clone(),
            version: plugin.version.clone(),
            kind: plugin.kind,
            effect: plugin.effect,
            phase: plugin.phase,
            order: plugin.order,
            selection_group: plugin.selection_group.clone(),
            reads: plugin.reads.clone(),
            writes: plugin.writes.clone(),
        })
        .collect();

    let plan = NodePluginPlan {
        node_id: node_id.to_string(),
        position,
        role_id: role_id.to_string(),
        chain: chain.to_string(),
        entries,
        selection_groups,
        hash: String::new(),
    };
    let mut final_plan = plan;
    final_plan.hash = final_plan.plan_hash();
    let _ = enabled_ids;
    Ok(final_plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v4_plugin_contract::{
        NodeSelector, ResourceAxis, ResourceEntry,
    };

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
                    resource_id: "v4.debug.event_ledger".to_string(),
                    axis: ResourceAxis::Diagnostic,
                },
                ResourceEntry {
                    resource_id: "v4.response.normal_payload".to_string(),
                    axis: ResourceAxis::Data,
                },
            ],
        }
    }

    fn authoring_plugin(
        plugin_id: &str,
        phase: PluginPhase,
        order: u32,
        enabled: bool,
    ) -> AuthoringPlugin {
        AuthoringPlugin {
            descriptor: NodePluginDescriptor {
                plugin_id: plugin_id.to_string(),
                version: "0.1.0".to_string(),
                owner: "routecodex-v4-plugin-contract".to_string(),
                artifact_hash: "a".repeat(64),
                contract_hash: "b".repeat(64),
                kind: PluginKind::Operator,
                effect: PluginEffect::Semantic,
                phase,
                order,
                before: vec![],
                after: vec![],
                depends_on: vec![],
                selection_group: None,
                node_selector: NodeSelector {
                    role_id: "request_chat_process".to_string(),
                },
                services_provided: vec![],
                inject: vec![],
                reads: vec!["v4.request.normal_payload".to_string()],
                writes: vec!["v4.request.normal_payload".to_string()],
            },
            enabled,
        }
    }

    fn allowed_reads() -> Vec<String> {
        vec![
            "v4.request.normal_payload".to_string(),
            "v4.control.metadata_center".to_string(),
            "v4.debug.event_ledger".to_string(),
        ]
    }

    fn allowed_writes() -> Vec<String> {
        vec![
            "v4.request.normal_payload".to_string(),
            "v4.control.metadata_center".to_string(),
        ]
    }

    #[test]
    fn ordered_multi_operator_plan_compiles() {
        let authoring = vec![
            authoring_plugin("v4.request.a", PluginPhase::Semantic, 300, true),
            authoring_plugin("v4.request.b", PluginPhase::Semantic, 400, true),
            authoring_plugin("v4.request.c", PluginPhase::Admission, 10, true),
        ];
        let plan = compile_node_plan(
            "V4HubReqChatProcess04Governed",
            "request_chat_process",
            "request",
            4,
            &authoring,
            &allowed_reads(),
            &allowed_writes(),
            &registry(),
        )
        .expect("plan compiles");
        let ids: Vec<&str> = plan.entries.iter().map(|entry| entry.plugin_id.as_str()).collect();
        assert_eq!(ids, vec!["v4.request.c", "v4.request.a", "v4.request.b"]);
        assert!(plan.verify());
    }

    #[test]
    fn different_nodes_can_have_different_orders() {
        let node_a = vec![
            authoring_plugin("v4.request.a", PluginPhase::Semantic, 300, true),
            authoring_plugin("v4.request.b", PluginPhase::Semantic, 400, true),
        ];
        let node_b = vec![
            authoring_plugin("v4.request.b", PluginPhase::Semantic, 300, true),
            authoring_plugin("v4.request.a", PluginPhase::Semantic, 400, true),
        ];
        let plan_a = compile_node_plan("node_a", "request_chat_process", "request", 1, &node_a, &allowed_reads(), &allowed_writes(), &registry()).unwrap();
        let plan_b = compile_node_plan("node_b", "request_chat_process", "request", 2, &node_b, &allowed_reads(), &allowed_writes(), &registry()).unwrap();
        let ids_a: Vec<&str> = plan_a.entries.iter().map(|entry| entry.plugin_id.as_str()).collect();
        let ids_b: Vec<&str> = plan_b.entries.iter().map(|entry| entry.plugin_id.as_str()).collect();
        assert_eq!(ids_a, vec!["v4.request.a", "v4.request.b"]);
        assert_eq!(ids_b, vec!["v4.request.b", "v4.request.a"]);
        assert_ne!(plan_a.hash, plan_b.hash);
    }

    #[test]
    fn same_semantics_different_authoring_order_same_hash() {
        let mut first = vec![
            authoring_plugin("v4.request.a", PluginPhase::Semantic, 300, true),
            authoring_plugin("v4.request.b", PluginPhase::Semantic, 400, true),
            authoring_plugin("v4.request.c", PluginPhase::Admission, 10, true),
        ];
        let mut second = first.clone();
        second.reverse();
        let plan_a = compile_node_plan("node", "request_chat_process", "request", 1, &first, &allowed_reads(), &allowed_writes(), &registry()).unwrap();
        let plan_b = compile_node_plan("node", "request_chat_process", "request", 1, &second, &allowed_reads(), &allowed_writes(), &registry()).unwrap();
        assert_eq!(plan_a.hash, plan_b.hash);
        first.clear();
        let _ = &mut first;
    }

    #[test]
    fn selection_group_exactly_one_active() {
        let mut codec_a = authoring_plugin("v4.codec.a", PluginPhase::Semantic, 200, true);
        codec_a.descriptor.selection_group = Some("provider_wire_codec".to_string());
        let mut codec_b = authoring_plugin("v4.codec.b", PluginPhase::Semantic, 200, true);
        codec_b.descriptor.selection_group = Some("provider_wire_codec".to_string());
        codec_b.enabled = false;
        let mut validator = authoring_plugin("v4.request.validate", PluginPhase::Validation, 800, true);
        validator.descriptor.kind = PluginKind::Validator;
        validator.descriptor.effect = PluginEffect::ReadOnly;
        validator.descriptor.writes = vec![];
        let authoring = vec![codec_a, codec_b, validator];
        let plan = compile_node_plan("node", "request_chat_process", "request", 6, &authoring, &allowed_reads(), &allowed_writes(), &registry()).unwrap();
        assert_eq!(plan.selection_groups.len(), 1);
        assert_eq!(plan.selection_groups[0].active_plugin, "v4.codec.a");
        assert_eq!(plan.selection_groups[0].variants, vec!["v4.codec.a", "v4.codec.b"]);
        let ids: Vec<&str> = plan.entries.iter().map(|entry| entry.plugin_id.as_str()).collect();
        assert_eq!(ids, vec!["v4.codec.a", "v4.request.validate"]);
    }

    #[test]
    fn selection_group_zero_active_rejected() {
        let mut codec_a = authoring_plugin("v4.codec.a", PluginPhase::Semantic, 200, false);
        codec_a.descriptor.selection_group = Some("provider_wire_codec".to_string());
        let error = compile_node_plan("node", "request_chat_process", "request", 6, &[codec_a], &allowed_reads(), &allowed_writes(), &registry()).unwrap_err();
        assert!(matches!(error, PlanError::ZeroSelection(_)));
    }

    #[test]
    fn selection_group_multi_active_rejected() {
        let mut codec_a = authoring_plugin("v4.codec.a", PluginPhase::Semantic, 200, true);
        codec_a.descriptor.selection_group = Some("provider_wire_codec".to_string());
        let mut codec_b = authoring_plugin("v4.codec.b", PluginPhase::Semantic, 200, true);
        codec_b.descriptor.selection_group = Some("provider_wire_codec".to_string());
        let error = compile_node_plan("node", "request_chat_process", "request", 6, &[codec_a, codec_b], &allowed_reads(), &allowed_writes(), &registry()).unwrap_err();
        assert!(matches!(error, PlanError::MultiSelection { .. }));
    }

    #[test]
    fn before_after_cycle_rejected() {
        let mut a = authoring_plugin("v4.request.a", PluginPhase::Semantic, 300, true);
        a.descriptor.before = vec!["v4.request.b".to_string()];
        let mut b = authoring_plugin("v4.request.b", PluginPhase::Semantic, 300, true);
        b.descriptor.before = vec!["v4.request.a".to_string()];
        let error = compile_node_plan("node", "request_chat_process", "request", 4, &[a, b], &allowed_reads(), &allowed_writes(), &registry()).unwrap_err();
        assert!(matches!(error, PlanError::OrderingCycle));
    }

    #[test]
    fn same_phase_same_order_tie_rejected() {
        let a = authoring_plugin("v4.request.a", PluginPhase::Semantic, 300, true);
        let b = authoring_plugin("v4.request.b", PluginPhase::Semantic, 300, true);
        let error = compile_node_plan("node", "request_chat_process", "request", 4, &[a, b], &allowed_reads(), &allowed_writes(), &registry()).unwrap_err();
        assert!(matches!(error, PlanError::Tie { .. }));
    }

    #[test]
    fn missing_before_dependency_rejected() {
        let mut a = authoring_plugin("v4.request.a", PluginPhase::Semantic, 300, true);
        a.descriptor.before = vec!["v4.request.ghost".to_string()];
        let error = compile_node_plan("node", "request_chat_process", "request", 4, &[a], &allowed_reads(), &allowed_writes(), &registry()).unwrap_err();
        assert!(matches!(error, PlanError::MissingDependency { .. }));
    }

    #[test]
    fn version_conflict_rejected() {
        let mut consumer = authoring_plugin("v4.request.consumer", PluginPhase::Semantic, 300, true);
        consumer.descriptor.depends_on = vec![
            routecodex_v4_plugin_contract::DependencySpec {
                plugin_id: "v4.request.provider".to_string(),
                version_req: ">=0.2.0".to_string(),
            },
        ];
        let provider = authoring_plugin("v4.request.provider", PluginPhase::Semantic, 200, true);
        let error = compile_node_plan("node", "request_chat_process", "request", 4, &[consumer, provider], &allowed_reads(), &allowed_writes(), &registry()).unwrap_err();
        assert!(matches!(error, PlanError::VersionConflict { .. }));
    }

    #[test]
    fn unauthorized_write_rejected() {
        let mut a = authoring_plugin("v4.request.a", PluginPhase::Semantic, 300, true);
        a.descriptor.writes = vec!["v4.response.normal_payload".to_string()];
        let error = compile_node_plan("node", "request_chat_process", "request", 4, &[a], &allowed_reads(), &allowed_writes(), &registry()).unwrap_err();
        assert!(matches!(error, PlanError::UnauthorizedWrite { .. }));
    }

    #[test]
    fn cross_node_service_inject_rejected() {
        let mut a = authoring_plugin("v4.request.a", PluginPhase::Semantic, 300, true);
        a.descriptor.inject = vec!["nodeBPrivate".to_string()];
        let error = compile_node_plan("node", "request_chat_process", "request", 4, &[a], &allowed_reads(), &allowed_writes(), &registry()).unwrap_err();
        assert!(matches!(error, PlanError::CrossNodeService { .. }));
    }

    #[test]
    fn diagnostic_parallel_plugin_is_read_only_ok() {
        let mut observer = authoring_plugin("v4.request.observe", PluginPhase::Observation, 900, true);
        observer.descriptor.kind = PluginKind::Observer;
        observer.descriptor.effect = PluginEffect::DiagnosticOnly;
        observer.descriptor.reads = vec!["v4.debug.event_ledger".to_string()];
        observer.descriptor.writes = vec![];
        let plan = compile_node_plan("node", "request_chat_process", "request", 4, &[observer], &allowed_reads(), &allowed_writes(), &registry()).unwrap();
        assert_eq!(plan.entries.len(), 1);
        assert!(plan.verify());
    }

    #[test]
    fn phase_order_conflict_rejected() {
        let mut a = authoring_plugin("v4.request.a", PluginPhase::Projection, 300, true);
        a.descriptor.before = vec!["v4.request.b".to_string()];
        let b = authoring_plugin("v4.request.b", PluginPhase::Semantic, 300, true);
        let error = compile_node_plan("node", "request_chat_process", "request", 4, &[a, b], &allowed_reads(), &allowed_writes(), &registry()).unwrap_err();
        assert!(matches!(error, PlanError::PhaseOrderConflict { .. }));
    }
}
