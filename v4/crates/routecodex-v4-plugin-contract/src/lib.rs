//! V4 NodePlugin contract — the single owner of plugin identity, kind/effect,
//! phase, node selector, resource permissions, selection-group metadata and
//! service-injection rules.
//!
//! Hard boundaries:
//! - validates descriptors against the node-graph role catalog and the
//!   resource registry only; never executes plugins;
//! - never decides routing, continuation, retry or any control semantics;
//! - never touches business payload.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CONTRACT_VERSION: &str = "v4-node-plugin-1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginKind {
    Admission,
    Control,
    Operator,
    Validator,
    Hook,
    Debug,
    Snapshot,
    Observer,
}

impl PluginKind {
    pub fn is_diagnostic(self) -> bool {
        matches!(
            self,
            PluginKind::Debug | PluginKind::Snapshot | PluginKind::Observer
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginEffect {
    ReadOnly,
    ControlOnly,
    Semantic,
    DiagnosticOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginPhase {
    Admission,
    Control,
    Semantic,
    Validation,
    Projection,
    Observation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeSelector {
    pub role_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencySpec {
    pub plugin_id: String,
    pub version_req: String,
}

/// Authoring descriptor of one NodePlugin. All identity fields are required;
/// ordering and resource fields are compiled by the plan module, never
/// interpreted at runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodePluginDescriptor {
    pub plugin_id: String,
    pub version: String,
    pub owner: String,
    pub artifact_hash: String,
    pub contract_hash: String,
    pub kind: PluginKind,
    pub effect: PluginEffect,
    pub phase: PluginPhase,
    pub order: u32,
    #[serde(default)]
    pub before: Vec<String>,
    #[serde(default)]
    pub after: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<DependencySpec>,
    #[serde(default)]
    pub selection_group: Option<String>,
    pub node_selector: NodeSelector,
    #[serde(default)]
    pub services_provided: Vec<String>,
    #[serde(default)]
    pub inject: Vec<String>,
    #[serde(default)]
    pub reads: Vec<String>,
    #[serde(default)]
    pub writes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceAxis {
    Data,
    Control,
    Information,
    Diagnostic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceEntry {
    pub resource_id: String,
    pub axis: ResourceAxis,
}

/// Immutable resource registry view consumed by contract validation. The
/// machine truth lives in the V4 resource maps; this crate only validates
/// against the registry handed to it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceRegistry {
    pub resources: Vec<ResourceEntry>,
}

impl ResourceRegistry {
    pub fn axis_of(&self, resource_id: &str) -> Option<ResourceAxis> {
        self.resources
            .iter()
            .find(|entry| entry.resource_id == resource_id)
            .map(|entry| entry.axis)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractError {
    MissingIdentity(String),
    UnknownRole(String),
    UnknownResource(String),
    UnauthorizedWrite {
        plugin_id: String,
        resource_id: String,
    },
    DiagnosticWrites {
        plugin_id: String,
        resource_id: String,
    },
    ControlWritesNormalData {
        plugin_id: String,
        resource_id: String,
    },
    EmptySelectionGroup(String),
    EmptyBefore(String),
    EmptyAfter(String),
    SelfReference {
        plugin_id: String,
        relation: String,
    },
    EmptyService(String),
    DuplicateService(String),
    NonCanonicalHash(String),
}

impl std::fmt::Display for ContractError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingIdentity(field) => write!(formatter, "missing identity field {field}"),
            Self::UnknownRole(role) => write!(formatter, "unknown node role {role}"),
            Self::UnknownResource(resource) => write!(formatter, "unknown resource {resource}"),
            Self::UnauthorizedWrite {
                plugin_id,
                resource_id,
            } => write!(
                formatter,
                "plugin {plugin_id} writes unauthorized resource {resource_id}"
            ),
            Self::DiagnosticWrites {
                plugin_id,
                resource_id,
            } => write!(
                formatter,
                "diagnostic plugin {plugin_id} writes {resource_id}"
            ),
            Self::ControlWritesNormalData {
                plugin_id,
                resource_id,
            } => write!(
                formatter,
                "control plugin {plugin_id} writes normal data resource {resource_id}"
            ),
            Self::EmptySelectionGroup(plugin_id) => {
                write!(formatter, "plugin {plugin_id} declares an empty selection group")
            }
            Self::EmptyBefore(plugin_id) => {
                write!(formatter, "plugin {plugin_id} declares an empty before entry")
            }
            Self::EmptyAfter(plugin_id) => {
                write!(formatter, "plugin {plugin_id} declares an empty after entry")
            }
            Self::SelfReference {
                plugin_id,
                relation,
            } => write!(
                formatter,
                "plugin {plugin_id} references itself in {relation}"
            ),
            Self::EmptyService(plugin_id) => {
                write!(formatter, "plugin {plugin_id} declares an empty service id")
            }
            Self::DuplicateService(plugin_id) => {
                write!(formatter, "plugin {plugin_id} declares a duplicate service")
            }
            Self::NonCanonicalHash(plugin_id) => write!(
                formatter,
                "plugin {plugin_id} contract_hash is not a canonical sha256 digest"
            ),
        }
    }
}

impl std::error::Error for ContractError {}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

/// Validate one plugin descriptor against the declared node roles and the
/// resource registry. Selection-group arity and ordering are plan concerns;
/// this function locks identity, role, resource and effect invariants only.
pub fn validate_descriptor(
    descriptor: &NodePluginDescriptor,
    node_roles: &[String],
    resources: &ResourceRegistry,
) -> Result<(), ContractError> {
    if descriptor.plugin_id.trim().is_empty() {
        return Err(ContractError::MissingIdentity("plugin_id".to_string()));
    }
    if descriptor.version.trim().is_empty() {
        return Err(ContractError::MissingIdentity("version".to_string()));
    }
    if descriptor.owner.trim().is_empty() {
        return Err(ContractError::MissingIdentity("owner".to_string()));
    }
    if descriptor.artifact_hash.trim().is_empty() {
        return Err(ContractError::MissingIdentity("artifact_hash".to_string()));
    }
    if descriptor.contract_hash.trim().is_empty() {
        return Err(ContractError::MissingIdentity("contract_hash".to_string()));
    }
    if !is_sha256_hex(&descriptor.contract_hash) {
        return Err(ContractError::NonCanonicalHash(
            descriptor.plugin_id.clone(),
        ));
    }
    if !node_roles.iter().any(|role| role == &descriptor.node_selector.role_id) {
        return Err(ContractError::UnknownRole(
            descriptor.node_selector.role_id.clone(),
        ));
    }
    for resource in descriptor.reads.iter().chain(descriptor.writes.iter()) {
        if resources.axis_of(resource).is_none() {
            return Err(ContractError::UnknownResource(resource.clone()));
        }
    }
    for resource in &descriptor.writes {
        let axis = resources
            .axis_of(resource)
            .expect("write resource was checked above");
        match descriptor.effect {
            PluginEffect::ReadOnly | PluginEffect::DiagnosticOnly => {
                return Err(ContractError::DiagnosticWrites {
                    plugin_id: descriptor.plugin_id.clone(),
                    resource_id: resource.clone(),
                });
            }
            PluginEffect::ControlOnly => {
                if !matches!(
                    axis,
                    ResourceAxis::Control | ResourceAxis::Information
                ) {
                    return Err(ContractError::ControlWritesNormalData {
                        plugin_id: descriptor.plugin_id.clone(),
                        resource_id: resource.clone(),
                    });
                }
            }
            PluginEffect::Semantic => {
                if !matches!(axis, ResourceAxis::Data | ResourceAxis::Control) {
                    return Err(ContractError::UnauthorizedWrite {
                        plugin_id: descriptor.plugin_id.clone(),
                        resource_id: resource.clone(),
                    });
                }
            }
        }
    }
    if descriptor
        .selection_group
        .as_ref()
        .is_some_and(|group| group.trim().is_empty())
    {
        return Err(ContractError::EmptySelectionGroup(
            descriptor.plugin_id.clone(),
        ));
    }
    for relation in [("before", &descriptor.before), ("after", &descriptor.after)] {
        for target in relation.1 {
            if target.trim().is_empty() {
                return Err(ContractError::EmptyBefore(descriptor.plugin_id.clone()));
            }
            if target == &descriptor.plugin_id {
                return Err(ContractError::SelfReference {
                    plugin_id: descriptor.plugin_id.clone(),
                    relation: relation.0.to_string(),
                });
            }
        }
    }
    let mut services: Vec<&String> = Vec::new();
    for service in descriptor
        .services_provided
        .iter()
        .chain(descriptor.inject.iter())
    {
        if service.trim().is_empty() {
            return Err(ContractError::EmptyService(
                descriptor.plugin_id.clone(),
            ));
        }
        if services.iter().any(|existing| existing == &service) {
            return Err(ContractError::DuplicateService(
                descriptor.plugin_id.clone(),
            ));
        }
        services.push(service);
    }
    Ok(())
}

/// Canonical JSON digest (sorted keys, fixed separators) of a descriptor with
/// the `contract_hash` field removed. Used by catalog hash checks.
pub fn descriptor_contract_hash(descriptor: &NodePluginDescriptor) -> String {
    let mut value = serde_json::to_value(descriptor).expect("descriptor is serializable");
    if let Some(object) = value.as_object_mut() {
        object.remove("contract_hash");
    }
    let mut hasher = Sha256::new();
    hasher.update(canonical_json(&value).as_bytes());
    hex(&hasher.finalize())
}

pub fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::Value::String(key.clone()).to_string(),
                        canonical_json(&map[key])
                    )
                })
                .collect();
            format!("{{{}}}", body.join(","))
        }
        serde_json::Value::Array(items) => {
            let body: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", body.join(","))
        }
        other => other.to_string(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roles() -> Vec<String> {
        vec!["request_chat_process".to_string(), "request_inbound".to_string()]
    }

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
                    resource_id: "v4.config.manifest".to_string(),
                    axis: ResourceAxis::Information,
                },
            ],
        }
    }

    fn base_descriptor() -> NodePluginDescriptor {
        NodePluginDescriptor {
            plugin_id: "v4.request.governance".to_string(),
            version: "0.1.0".to_string(),
            owner: "routecodex-v4-plugin-contract".to_string(),
            artifact_hash: "a".repeat(64),
            contract_hash: "b".repeat(64),
            kind: PluginKind::Operator,
            effect: PluginEffect::Semantic,
            phase: PluginPhase::Semantic,
            order: 300,
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
        }
    }

    #[test]
    fn valid_semantic_operator_passes() {
        let descriptor = base_descriptor();
        assert!(validate_descriptor(&descriptor, &roles(), &registry()).is_ok());
    }

    #[test]
    fn missing_owner_is_rejected() {
        let mut descriptor = base_descriptor();
        descriptor.owner = "".to_string();
        assert_eq!(
            validate_descriptor(&descriptor, &roles(), &registry()),
            Err(ContractError::MissingIdentity("owner".to_string()))
        );
    }

    #[test]
    fn unknown_role_is_rejected() {
        let mut descriptor = base_descriptor();
        descriptor.node_selector.role_id = "not_a_node_role".to_string();
        assert!(matches!(
            validate_descriptor(&descriptor, &roles(), &registry()),
            Err(ContractError::UnknownRole(_))
        ));
    }

    #[test]
    fn unknown_resource_is_rejected() {
        let mut descriptor = base_descriptor();
        descriptor.reads = vec!["v4.ghost.resource".to_string()];
        assert!(matches!(
            validate_descriptor(&descriptor, &roles(), &registry()),
            Err(ContractError::UnknownResource(_))
        ));
    }

    #[test]
    fn read_only_plugin_cannot_write() {
        let mut descriptor = base_descriptor();
        descriptor.effect = PluginEffect::ReadOnly;
        descriptor.kind = PluginKind::Validator;
        descriptor.writes = vec!["v4.request.normal_payload".to_string()];
        assert!(matches!(
            validate_descriptor(&descriptor, &roles(), &registry()),
            Err(ContractError::DiagnosticWrites { .. })
        ));
    }

    #[test]
    fn diagnostic_plugin_cannot_write() {
        let mut descriptor = base_descriptor();
        descriptor.effect = PluginEffect::DiagnosticOnly;
        descriptor.kind = PluginKind::Debug;
        descriptor.writes = vec!["v4.debug.event_ledger".to_string()];
        assert!(matches!(
            validate_descriptor(&descriptor, &roles(), &registry()),
            Err(ContractError::DiagnosticWrites { .. })
        ));
    }

    #[test]
    fn control_plugin_cannot_write_normal_data() {
        let mut descriptor = base_descriptor();
        descriptor.effect = PluginEffect::ControlOnly;
        descriptor.kind = PluginKind::Control;
        descriptor.writes = vec!["v4.request.normal_payload".to_string()];
        assert!(matches!(
            validate_descriptor(&descriptor, &roles(), &registry()),
            Err(ContractError::ControlWritesNormalData { .. })
        ));
    }

    #[test]
    fn control_plugin_can_write_control_and_information() {
        let mut descriptor = base_descriptor();
        descriptor.effect = PluginEffect::ControlOnly;
        descriptor.kind = PluginKind::Control;
        descriptor.writes = vec![
            "v4.control.metadata_center".to_string(),
            "v4.config.manifest".to_string(),
        ];
        assert!(validate_descriptor(&descriptor, &roles(), &registry()).is_ok());
    }

    #[test]
    fn semantic_plugin_cannot_write_diagnostic_or_information() {
        let mut descriptor = base_descriptor();
        descriptor.writes = vec!["v4.debug.event_ledger".to_string()];
        assert!(matches!(
            validate_descriptor(&descriptor, &roles(), &registry()),
            Err(ContractError::UnauthorizedWrite { .. })
        ));
    }

    #[test]
    fn self_reference_in_before_is_rejected() {
        let mut descriptor = base_descriptor();
        descriptor.before = vec![descriptor.plugin_id.clone()];
        assert!(matches!(
            validate_descriptor(&descriptor, &roles(), &registry()),
            Err(ContractError::SelfReference { .. })
        ));
    }

    #[test]
    fn empty_selection_group_is_rejected() {
        let mut descriptor = base_descriptor();
        descriptor.selection_group = Some("".to_string());
        assert!(matches!(
            validate_descriptor(&descriptor, &roles(), &registry()),
            Err(ContractError::EmptySelectionGroup(_))
        ));
    }

    #[test]
    fn non_canonical_contract_hash_is_rejected() {
        let mut descriptor = base_descriptor();
        descriptor.contract_hash = "not-a-digest".to_string();
        assert!(matches!(
            validate_descriptor(&descriptor, &roles(), &registry()),
            Err(ContractError::NonCanonicalHash(_))
        ));
    }

    #[test]
    fn contract_hash_is_deterministic() {
        let descriptor = base_descriptor();
        let first = descriptor_contract_hash(&descriptor);
        let second = descriptor_contract_hash(&descriptor);
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn duplicate_service_ids_are_rejected() {
        let mut descriptor = base_descriptor();
        descriptor.services_provided = vec![
            "nodeControl".to_string(),
            "nodeControl".to_string(),
        ];
        assert!(matches!(
            validate_descriptor(&descriptor, &roles(), &registry()),
            Err(ContractError::DuplicateService(_))
        ));
    }
}
