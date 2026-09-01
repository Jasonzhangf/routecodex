use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PluginIdentity {
    pub plugin_id: String,
    pub version: String,
    pub artifact_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginIdentityError {
    MissingField(&'static str),
}

impl std::fmt::Display for PluginIdentityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let field = match self {
            Self::MissingField(field) => field,
        };
        write!(formatter, "native plugin identity missing {field}")
    }
}

impl std::error::Error for PluginIdentityError {}

impl PluginIdentity {
    pub fn try_new(
        plugin_id: impl Into<String>,
        version: impl Into<String>,
        artifact_hash: impl Into<String>,
    ) -> Result<Self, PluginIdentityError> {
        let identity = Self {
            plugin_id: plugin_id.into(),
            version: version.into(),
            artifact_hash: artifact_hash.into(),
        };
        for (value, field) in [
            (&identity.plugin_id, "plugin_id"),
            (&identity.version, "version"),
            (&identity.artifact_hash, "artifact_hash"),
        ] {
            if value.trim().is_empty() {
                return Err(PluginIdentityError::MissingField(field));
            }
        }
        Ok(identity)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginContext {
    pub node_id: String,
    pub scope_id: String,
}

impl PluginContext {
    pub fn new(node_id: impl Into<String>, scope_id: impl Into<String>) -> Self {
        Self {
            node_id: node_id.into(),
            scope_id: scope_id.into(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PluginConfig {
    values: BTreeMap<String, String>,
}

impl PluginConfig {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn values(&self) -> &BTreeMap<String, String> {
        &self.values
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginOutcome {
    Continue,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginFailure {
    InvalidContext(String),
    Execution(String),
}

pub trait NativePlugin: Send + Sync {
    fn identity(&self) -> &PluginIdentity;

    fn execute(
        &self,
        context: &PluginContext,
        config: &PluginConfig,
    ) -> Result<PluginOutcome, PluginFailure>;
}
