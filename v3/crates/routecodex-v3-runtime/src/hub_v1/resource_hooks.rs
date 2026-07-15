use routecodex_v3_config::{
    V3Config05ManifestPublished, V3HubFixedNode, V3HubHookManifest, V3HubHookPhase,
    V3HubHookProfile, V3HubHookRequirement, V3HubResourceManifest, V3HubV1Manifest,
};
use std::collections::BTreeMap;

pub const V3_HUB_V1_NODE_HOOK_COUNT: usize = V3HubFixedNode::ALL.len() * 2;

type V3HubStaticHookCallback =
    for<'hook> fn(&'hook V3HubHookManifest) -> Result<V3HubHookEvent<'hook>, V3HubHookError<'hook>>;

#[derive(Debug, Clone, Copy)]
pub struct V3HubStaticHookSpec {
    pub node: V3HubFixedNode,
    pub phase: V3HubHookPhase,
    callback: V3HubStaticHookCallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubHookImplementation {
    NotImplemented,
    DisabledNoop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubHookEvent<'hook> {
    DisabledNoop { hook_id: &'hook str },
}

#[derive(Debug, Clone, Copy)]
pub struct V3HubHookDeclaration<'manifest> {
    manifest: &'manifest V3HubHookManifest,
    spec: &'static V3HubStaticHookSpec,
}

impl PartialEq for V3HubHookDeclaration<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.manifest == other.manifest
            && self.spec.node == other.spec.node
            && self.spec.phase == other.spec.phase
    }
}

impl Eq for V3HubHookDeclaration<'_> {}

impl<'manifest> V3HubHookDeclaration<'manifest> {
    pub fn manifest(&self) -> &'manifest V3HubHookManifest {
        self.manifest
    }

    pub fn implementation(&self) -> V3HubHookImplementation {
        if self.manifest.requirement == V3HubHookRequirement::Optional && !self.manifest.enabled {
            V3HubHookImplementation::DisabledNoop
        } else {
            V3HubHookImplementation::NotImplemented
        }
    }

    pub fn invoke(&self) -> Result<V3HubHookEvent<'manifest>, V3HubHookError<'manifest>> {
        if self.implementation() == V3HubHookImplementation::DisabledNoop {
            return Ok(V3HubHookEvent::DisabledNoop {
                hook_id: &self.manifest.hook_id,
            });
        }
        (self.spec.callback)(self.manifest)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("hub_v1 hook is not implemented: {hook_id}")]
pub struct V3HubHookError<'hook> {
    pub hook_id: &'hook str,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3HubStartupError {
    #[error("Hub v1 declaration is missing from V3Config05ManifestPublished")]
    MissingHubManifest,
    #[error("missing hook for {node:?} {phase:?}")]
    MissingHook {
        node: V3HubFixedNode,
        phase: V3HubHookPhase,
    },
    #[error("duplicate hook for {node:?} {phase:?}")]
    DuplicateHook {
        node: V3HubFixedNode,
        phase: V3HubHookPhase,
    },
    #[error("unknown hook {hook_id}")]
    UnknownHook { hook_id: String },
    #[error("hook {hook_id} is incompatible with {node:?} {phase:?}")]
    IncompatibleHook {
        hook_id: String,
        node: V3HubFixedNode,
        phase: V3HubHookPhase,
    },
    #[error("configured Hub v1 manifest is invalid: {reason}")]
    ConfiguredManifest { reason: String },
}

fn not_implemented_static_hook<'hook>(
    hook: &'hook V3HubHookManifest,
) -> Result<V3HubHookEvent<'hook>, V3HubHookError<'hook>> {
    Err(V3HubHookError {
        hook_id: &hook.hook_id,
    })
}

const fn static_hook(node: V3HubFixedNode, phase: V3HubHookPhase) -> V3HubStaticHookSpec {
    V3HubStaticHookSpec {
        node,
        phase,
        callback: not_implemented_static_hook,
    }
}

static V3_HUB_V1_STATIC_NODE_HOOKS: [V3HubStaticHookSpec; V3_HUB_V1_NODE_HOOK_COUNT] = [
    static_hook(
        V3HubFixedNode::V3HubReqInbound01ClientRaw,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3HubReqInbound01ClientRaw,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3HubReqInbound02Normalized,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3HubReqInbound02Normalized,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3HubReqContinuation03Classified,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3HubReqContinuation03Classified,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3HubReqChatProcess04Governed,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3HubReqChatProcess04Governed,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3HubReqExecution05Planned,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3HubReqExecution05Planned,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3HubReqTarget06Resolved,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3HubReqTarget06Resolved,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3HubReqOutbound07ProviderSemantic,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3HubReqOutbound07ProviderSemantic,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3ProviderReqOutbound08WirePayload,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3ProviderReqOutbound08WirePayload,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3ProviderReqOutbound09TransportRequest,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3ProviderReqOutbound09TransportRequest,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3ProviderRespInbound01Raw,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3ProviderRespInbound01Raw,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3HubRespInbound02Normalized,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3HubRespInbound02Normalized,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3HubRespChatProcess03Governed,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3HubRespChatProcess03Governed,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3HubRespContinuation04Committed,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3HubRespContinuation04Committed,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3HubRespOutbound05ClientSemantic,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3HubRespOutbound05ClientSemantic,
        V3HubHookPhase::Exit,
    ),
    static_hook(
        V3HubFixedNode::V3ServerRespOutbound06ClientFrame,
        V3HubHookPhase::Entry,
    ),
    static_hook(
        V3HubFixedNode::V3ServerRespOutbound06ClientFrame,
        V3HubHookPhase::Exit,
    ),
];

#[derive(Debug, Clone, Copy)]
pub struct V3HubStaticHookCatalog {
    specs: &'static [V3HubStaticHookSpec],
}

impl V3HubStaticHookCatalog {
    pub fn manifest(&self) -> &'static [V3HubStaticHookSpec] {
        self.specs
    }

    pub fn hook(
        &self,
        node: V3HubFixedNode,
        phase: V3HubHookPhase,
    ) -> Option<&'static V3HubStaticHookSpec> {
        self.specs
            .iter()
            .find(|spec| spec.node == node && spec.phase == phase)
    }
}

pub fn compile_v3_hub_v1_static_registry() -> Result<V3HubStaticHookCatalog, V3HubStartupError> {
    for node in V3HubFixedNode::ALL {
        for phase in V3HubHookPhase::ALL {
            let count = V3_HUB_V1_STATIC_NODE_HOOKS
                .iter()
                .filter(|spec| spec.node == node && spec.phase == phase)
                .count();
            if count == 0 {
                return Err(V3HubStartupError::MissingHook { node, phase });
            }
            if count != 1 {
                return Err(V3HubStartupError::DuplicateHook { node, phase });
            }
        }
    }
    Ok(V3HubStaticHookCatalog {
        specs: &V3_HUB_V1_STATIC_NODE_HOOKS,
    })
}

#[derive(Debug)]
pub struct V3HubStaticHookRegistry<'manifest> {
    hook_set_id: &'manifest str,
    hooks: Vec<V3HubHookDeclaration<'manifest>>,
    resources: &'manifest BTreeMap<String, V3HubResourceManifest>,
}

impl<'manifest> V3HubStaticHookRegistry<'manifest> {
    pub fn hook_set_id(&self) -> &'manifest str {
        self.hook_set_id
    }

    pub fn manifest(&self) -> &[V3HubHookDeclaration<'manifest>] {
        &self.hooks
    }

    pub fn resources(&self) -> &'manifest BTreeMap<String, V3HubResourceManifest> {
        self.resources
    }

    pub fn resource(&self, resource_id: &str) -> Option<&'manifest V3HubResourceManifest> {
        self.resources.get(resource_id)
    }

    pub fn hook(
        &self,
        node: V3HubFixedNode,
        phase: V3HubHookPhase,
    ) -> Option<&V3HubHookDeclaration<'manifest>> {
        self.hooks
            .iter()
            .find(|hook| hook.spec.node == node && hook.spec.phase == phase)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct V3HubCurrentNodeBorrowedView<'node, T> {
    node: V3HubFixedNode,
    value: &'node T,
}

impl<'node, T> V3HubCurrentNodeBorrowedView<'node, T> {
    pub fn node(&self) -> V3HubFixedNode {
        self.node
    }

    pub fn value(&self) -> &'node T {
        self.value
    }
}

pub fn borrow_v3_hub_current_node<'node, T>(
    node: V3HubFixedNode,
    value: &'node T,
) -> V3HubCurrentNodeBorrowedView<'node, T> {
    V3HubCurrentNodeBorrowedView { node, value }
}

pub fn validate_v3_hub_v1_hook_manifest(
    manifest: &V3HubV1Manifest,
) -> Result<(), V3HubStartupError> {
    let catalog = compile_v3_hub_v1_static_registry()?;
    let mut slots = BTreeMap::new();
    let mut previous_order: Option<(i32, u32, &str)> = None;
    for hook in &manifest.hooks {
        let expected_id = format!(
            "hub_v1.{}.{}.not_implemented",
            hook.node.node_id(),
            hook.phase.as_str()
        );
        if hook.hook_id != expected_id {
            return Err(V3HubStartupError::UnknownHook {
                hook_id: hook.hook_id.clone(),
            });
        }
        if catalog.hook(hook.node, hook.phase).is_none() {
            return Err(V3HubStartupError::IncompatibleHook {
                hook_id: hook.hook_id.clone(),
                node: hook.node,
                phase: hook.phase,
            });
        }
        if slots.insert((hook.node, hook.phase), ()).is_some() {
            return Err(V3HubStartupError::DuplicateHook {
                node: hook.node,
                phase: hook.phase,
            });
        }
        let current_order = (hook.priority, hook.order, hook.hook_id.as_str());
        if previous_order.is_some_and(|previous| previous > current_order) {
            return Err(V3HubStartupError::ConfiguredManifest {
                reason: "hooks are not ordered by priority, order, hook_id".to_string(),
            });
        }
        previous_order = Some(current_order);
        if hook.requirement == V3HubHookRequirement::Required && !hook.enabled {
            return Err(V3HubStartupError::ConfiguredManifest {
                reason: format!("required hook {} is disabled", hook.hook_id),
            });
        }
        for resource_id in hook
            .allowed_resources
            .iter()
            .chain(&hook.forbidden_resources)
        {
            if !manifest.resources.contains_key(resource_id) {
                return Err(V3HubStartupError::ConfiguredManifest {
                    reason: format!(
                        "hook {} references unknown resource {resource_id}",
                        hook.hook_id
                    ),
                });
            }
        }
        if hook
            .allowed_resources
            .iter()
            .any(|resource| hook.forbidden_resources.contains(resource))
        {
            return Err(V3HubStartupError::ConfiguredManifest {
                reason: format!("hook {} has conflicting resource access", hook.hook_id),
            });
        }
        if hook.profile == Some(V3HubHookProfile::Servertool)
            && !matches!(
                hook.node,
                V3HubFixedNode::V3HubReqChatProcess04Governed
                    | V3HubFixedNode::V3HubRespChatProcess03Governed
            )
        {
            return Err(V3HubStartupError::ConfiguredManifest {
                reason: format!(
                    "servertool profile is incompatible with node {}",
                    hook.node.node_id()
                ),
            });
        }
    }
    for node in V3HubFixedNode::ALL {
        for phase in V3HubHookPhase::ALL {
            if !slots.contains_key(&(node, phase)) {
                return Err(V3HubStartupError::MissingHook { node, phase });
            }
        }
    }
    for resource in manifest.resources.values() {
        if resource.may_enter_provider_body || resource.may_enter_client_body {
            return Err(V3HubStartupError::ConfiguredManifest {
                reason: format!(
                    "side-channel resource {} may not enter provider/client normal payload",
                    resource.resource_id
                ),
            });
        }
    }
    Ok(())
}

pub fn compile_v3_hub_v1_static_registry_from_config<'manifest>(
    published: &'manifest V3Config05ManifestPublished,
) -> Result<V3HubStaticHookRegistry<'manifest>, V3HubStartupError> {
    let manifest = published
        .hub_v1
        .as_ref()
        .ok_or(V3HubStartupError::MissingHubManifest)?;
    if manifest.skeleton != "hub_v1" {
        return Err(V3HubStartupError::ConfiguredManifest {
            reason: "skeleton must be hub_v1".to_string(),
        });
    }
    if manifest.hook_set_id.trim().is_empty() {
        return Err(V3HubStartupError::ConfiguredManifest {
            reason: "hook_set_id must be declared".to_string(),
        });
    }
    if manifest.entry_protocols.iter().map(String::as_str).ne([
        "responses",
        "anthropic",
        "gemini",
        "openai_chat",
    ]) {
        return Err(V3HubStartupError::ConfiguredManifest {
            reason: "entry protocol set does not match compiled static registry".to_string(),
        });
    }
    validate_v3_hub_v1_hook_manifest(manifest)?;
    let catalog = compile_v3_hub_v1_static_registry()?;
    let hooks = manifest
        .hooks
        .iter()
        .map(|hook| V3HubHookDeclaration {
            manifest: hook,
            spec: catalog
                .hook(hook.node, hook.phase)
                .expect("validated static hook slot"),
        })
        .collect();
    Ok(V3HubStaticHookRegistry {
        hook_set_id: &manifest.hook_set_id,
        hooks,
        resources: &manifest.resources,
    })
}
