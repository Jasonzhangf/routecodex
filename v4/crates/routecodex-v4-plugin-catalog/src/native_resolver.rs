use std::collections::HashMap;

use routecodex_v4_plugin_contract::{NativePlugin, PluginIdentity};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolverError {
    DuplicateIdentity(PluginIdentity),
    UnknownIdentity(PluginIdentity),
}

impl std::fmt::Display for ResolverError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuplicateIdentity(identity) => write!(
                formatter,
                "native plugin identity already registered: {}@{}+{}",
                identity.plugin_id, identity.version, identity.artifact_hash
            ),
            Self::UnknownIdentity(identity) => write!(
                formatter,
                "native plugin identity is not registered: {}@{}+{}",
                identity.plugin_id, identity.version, identity.artifact_hash
            ),
        }
    }
}

impl std::error::Error for ResolverError {}

#[derive(Default)]
pub struct NativePluginResolver {
    implementations: HashMap<PluginIdentity, Box<dyn NativePlugin>>,
}

impl NativePluginResolver {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, plugin: Box<dyn NativePlugin>) -> Result<(), ResolverError> {
        let identity = plugin.identity().clone();
        if self.implementations.contains_key(&identity) {
            return Err(ResolverError::DuplicateIdentity(identity));
        }
        self.implementations.insert(identity, plugin);
        Ok(())
    }

    pub fn resolve(&self, identity: &PluginIdentity) -> Result<&dyn NativePlugin, ResolverError> {
        self.implementations
            .get(identity)
            .map(|plugin| plugin.as_ref())
            .ok_or_else(|| ResolverError::UnknownIdentity(identity.clone()))
    }
}
