use std::collections::HashMap;

use routecodex_v4_base_node::NodeIdentity;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    Data,
    Information,
    Control,
}

#[derive(Debug, Clone)]
pub struct NodeRef {
    identity: NodeIdentity,
    data_plane: bool,
}

impl NodeRef {
    pub fn new(
        node_id: &str,
        chain: &str,
        chain_version: &str,
        position: u32,
        data_plane: bool,
    ) -> Self {
        Self {
            identity: NodeIdentity::new(node_id, chain, chain_version, position, "v4"),
            data_plane,
        }
    }

    pub fn from_identity(identity: NodeIdentity, data_plane: bool) -> Self {
        Self {
            identity,
            data_plane,
        }
    }

    pub fn node_id(&self) -> &str {
        self.identity.node_id()
    }

    pub fn chain(&self) -> &str {
        self.identity.chain()
    }

    pub fn chain_version(&self) -> &str {
        self.identity.chain_version()
    }

    pub fn position(&self) -> u32 {
        self.identity.position()
    }

    pub fn identity(&self) -> &NodeIdentity {
        &self.identity
    }

    fn matches(&self, node_id: &str, chain: &str, chain_version: &str) -> bool {
        self.identity.node_id() == node_id
            && self.identity.chain() == chain
            && self.identity.chain_version() == chain_version
    }
}

#[derive(Debug, Clone)]
pub struct ResourceRef {
    resource_id: String,
    axis: Axis,
}

impl ResourceRef {
    pub fn new(resource_id: &str, axis: Axis) -> Self {
        Self {
            resource_id: resource_id.to_string(),
            axis,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeKind {
    DataFlow,
    InformationFlow,
    ControlFlow,
    DebugSubscription,
    ErrorIntake,
}

#[derive(Debug, Clone)]
pub struct EdgeSpec {
    pub edge_id: String,
    pub kind: EdgeKind,
    pub chain: String,
    pub chain_version: String,
    pub from: String,
    pub to: String,
    pub data_in: Option<String>,
    pub data_out: Option<String>,
    pub info_in: Option<String>,
    pub info_out: Option<String>,
    pub operation: Option<String>,
    pub control_key: Option<String>,
    pub scope_keys: Vec<String>,
    pub record_required: bool,
    pub topic: Option<String>,
    pub read_only: bool,
    pub error_stage: Option<String>,
    pub payload_hash: bool,
    pub typed_context: bool,
}

impl EdgeSpec {
    pub fn data_flow(
        edge_id: &str,
        chain: &str,
        chain_version: &str,
        from: &str,
        to: &str,
        data_in: &str,
        data_out: &str,
    ) -> Self {
        Self {
            edge_id: edge_id.to_string(),
            kind: EdgeKind::DataFlow,
            chain: chain.to_string(),
            chain_version: chain_version.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            data_in: Some(data_in.to_string()),
            data_out: Some(data_out.to_string()),
            info_in: None,
            info_out: None,
            operation: None,
            control_key: None,
            scope_keys: Vec::new(),
            record_required: false,
            topic: None,
            read_only: false,
            error_stage: None,
            payload_hash: false,
            typed_context: false,
        }
    }

    pub fn information_flow(
        edge_id: &str,
        chain: &str,
        chain_version: &str,
        from: &str,
        to: &str,
        info_in: &str,
        info_out: &str,
    ) -> Self {
        Self {
            edge_id: edge_id.to_string(),
            kind: EdgeKind::InformationFlow,
            chain: chain.to_string(),
            chain_version: chain_version.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            data_in: None,
            data_out: None,
            info_in: Some(info_in.to_string()),
            info_out: Some(info_out.to_string()),
            operation: None,
            control_key: None,
            scope_keys: Vec::new(),
            record_required: false,
            topic: None,
            read_only: false,
            error_stage: None,
            payload_hash: false,
            typed_context: false,
        }
    }

    pub fn control_flow(
        edge_id: &str,
        chain: &str,
        chain_version: &str,
        from: &str,
        to: &str,
        operation: &str,
        control_key: &str,
        scope_keys: Vec<String>,
        record_required: bool,
    ) -> Self {
        Self {
            edge_id: edge_id.to_string(),
            kind: EdgeKind::ControlFlow,
            chain: chain.to_string(),
            chain_version: chain_version.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            data_in: None,
            data_out: None,
            info_in: None,
            info_out: None,
            operation: Some(operation.to_string()),
            control_key: Some(control_key.to_string()),
            scope_keys,
            record_required,
            topic: None,
            read_only: false,
            error_stage: None,
            payload_hash: false,
            typed_context: false,
        }
    }

    pub fn debug_subscription(
        edge_id: &str,
        chain: &str,
        chain_version: &str,
        from: &str,
        to: &str,
        topic: &str,
        read_only: bool,
    ) -> Self {
        Self {
            edge_id: edge_id.to_string(),
            kind: EdgeKind::DebugSubscription,
            chain: chain.to_string(),
            chain_version: chain_version.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            data_in: None,
            data_out: None,
            info_in: None,
            info_out: None,
            operation: None,
            control_key: None,
            scope_keys: Vec::new(),
            record_required: false,
            topic: Some(topic.to_string()),
            read_only,
            error_stage: None,
            payload_hash: false,
            typed_context: false,
        }
    }

    pub fn error_intake(
        edge_id: &str,
        chain: &str,
        chain_version: &str,
        from: &str,
        to: &str,
        error_stage: &str,
        payload_hash: bool,
        typed_context: bool,
        record_required: bool,
    ) -> Self {
        Self {
            edge_id: edge_id.to_string(),
            kind: EdgeKind::ErrorIntake,
            chain: chain.to_string(),
            chain_version: chain_version.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            data_in: None,
            data_out: None,
            info_in: None,
            info_out: None,
            operation: None,
            control_key: None,
            scope_keys: Vec::new(),
            record_required,
            topic: None,
            read_only: false,
            error_stage: Some(error_stage.to_string()),
            payload_hash,
            typed_context,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EdgeError {
    UnknownNode,
    UnknownResource,
    NonAdjacentEdge,
    ResourceAxisMismatch,
    ControlRecordRequired,
    ScopeMismatch,
    DebugSubscriptionNotReadOnly,
    ErrorIntakeUnTyped,
    ErrorIntakeWrongTarget,
    ForbiddenEdge,
}

#[derive(Debug, Default)]
pub struct ScopeRegistry {
    registered: HashMap<String, String>,
}

impl ScopeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn scope_identity(scope_keys: &[String]) -> String {
        scope_keys.join("|")
    }
}

pub fn validate_edge(
    edge: &EdgeSpec,
    nodes: &[NodeRef],
    resources: &[ResourceRef],
    forbidden: &[(String, String)],
    scopes: &mut ScopeRegistry,
) -> Result<(), EdgeError> {
    if forbidden
        .iter()
        .any(|(from, to)| from == &edge.from && to == &edge.to)
    {
        return Err(EdgeError::ForbiddenEdge);
    }

    let from_node = nodes
        .iter()
        .find(|n| n.matches(&edge.from, &edge.chain, &edge.chain_version))
        .ok_or(EdgeError::UnknownNode)?;

    let resource_axis = |resource_id: &str| -> Result<Axis, EdgeError> {
        resources
            .iter()
            .find(|r| r.resource_id == resource_id)
            .map(|r| r.axis)
            .ok_or(EdgeError::UnknownResource)
    };

    match edge.kind {
        EdgeKind::DataFlow => {
            let to_node = nodes
                .iter()
                .find(|n| n.matches(&edge.to, &edge.chain, &edge.chain_version))
                .ok_or(EdgeError::UnknownNode)?;
            if from_node.position().abs_diff(to_node.position()) != 1 {
                return Err(EdgeError::NonAdjacentEdge);
            }
            for resource_id in [edge.data_in.as_deref(), edge.data_out.as_deref()] {
                if let Some(id) = resource_id {
                    if resource_axis(id)? != Axis::Data {
                        return Err(EdgeError::ResourceAxisMismatch);
                    }
                }
            }
            Ok(())
        }
        EdgeKind::InformationFlow => {
            let to_node = nodes
                .iter()
                .find(|n| n.matches(&edge.to, &edge.chain, &edge.chain_version))
                .ok_or(EdgeError::UnknownNode)?;
            if from_node.data_plane || to_node.data_plane {
                return Err(EdgeError::ResourceAxisMismatch);
            }
            if from_node.position().abs_diff(to_node.position()) != 1 {
                return Err(EdgeError::NonAdjacentEdge);
            }
            for resource_id in [edge.info_in.as_deref(), edge.info_out.as_deref()] {
                if let Some(id) = resource_id {
                    if resource_axis(id)? != Axis::Information {
                        return Err(EdgeError::ResourceAxisMismatch);
                    }
                }
            }
            Ok(())
        }
        EdgeKind::ControlFlow => {
            if !edge.record_required {
                return Err(EdgeError::ControlRecordRequired);
            }
            let _axis = resource_axis(&edge.to)?;
            let key = edge.control_key.clone().unwrap_or_default();
            let scope_id = ScopeRegistry::scope_identity(&edge.scope_keys);
            match edge.operation.as_deref() {
                Some("register") => {
                    scopes.registered.insert(key, scope_id);
                    Ok(())
                }
                Some("consume") => match scopes.registered.get(&key) {
                    Some(registered) if *registered == scope_id => Ok(()),
                    _ => Err(EdgeError::ScopeMismatch),
                },
                Some("release") => {
                    scopes.registered.remove(&key);
                    Ok(())
                }
                _ => Err(EdgeError::ControlRecordRequired),
            }
        }
        EdgeKind::DebugSubscription => {
            if !edge.read_only {
                return Err(EdgeError::DebugSubscriptionNotReadOnly);
            }
            let _axis = resource_axis(&edge.to)?;
            Ok(())
        }
        EdgeKind::ErrorIntake => {
            if edge.to != "v4.control.error_center" {
                return Err(EdgeError::ErrorIntakeWrongTarget);
            }
            if !edge.payload_hash || !edge.typed_context || !edge.record_required {
                return Err(EdgeError::ErrorIntakeUnTyped);
            }
            let _axis = resource_axis(&edge.to)?;
            Ok(())
        }
    }
}

/// Edge consumes the frozen BaseNode identity contract as its node reference truth.
pub fn node_identity_contract(node: &NodeRef) -> &NodeIdentity {
    node.identity()
}
