mod store;
mod types;
mod validate;

pub use store::{default_v3_config_path, V3ConfigLoadedSnapshot, V3ConfigStore, V3ConfigWritePlan};
pub use types::*;

use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum V3ConfigError {
    #[error("config io failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("config parse failed: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("config serialization failed: {0}")]
    Serialize(#[from] toml::ser::Error),
    #[error("config validation failed: {0}")]
    Validation(String),
}

pub(crate) fn read_v3_config_01_file_source(
    path: impl AsRef<Path>,
) -> Result<V3Config01FileSource, V3ConfigError> {
    let path = path.as_ref().to_path_buf();
    let raw_toml = std::fs::read_to_string(&path)?;
    Ok(V3Config01FileSource { path, raw_toml })
}

pub fn parse_v3_config_02_authoring(raw: &str) -> Result<V3Config02AuthoringParsed, V3ConfigError> {
    Ok(toml::from_str(raw)?)
}

pub fn validate_v3_config_03_schema_from_v3_config_02(
    authoring: V3Config02AuthoringParsed,
) -> Result<V3Config03SchemaValidated, V3ConfigError> {
    validate::validate_schema(authoring)
}

pub fn build_v3_config_04_resource_registry_from_v3_config_03(
    validated: V3Config03SchemaValidated,
) -> Result<V3Config04ResourceRegistryBuilt, V3ConfigError> {
    validate::build_resource_registry(validated)
}

pub fn publish_v3_config_05_manifest_from_v3_config_04(
    registry: V3Config04ResourceRegistryBuilt,
) -> Result<V3Config05ManifestPublished, V3ConfigError> {
    validate::publish_manifest(registry)
}

pub fn compile_v3_config_05_manifest(
    authoring: V3Config02AuthoringParsed,
) -> Result<V3Config05ManifestPublished, V3ConfigError> {
    publish_v3_config_05_manifest_from_v3_config_04(
        build_v3_config_04_resource_registry_from_v3_config_03(
            validate_v3_config_03_schema_from_v3_config_02(authoring)?,
        )?,
    )
}

pub fn looks_like_secret_literal(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("sk-")
        || trimmed.starts_with("Bearer ")
        || trimmed.contains("api_key=")
        || trimmed.contains("OPENAI_API_KEY=")
        || trimmed.len() > 128
}

pub(crate) fn validation(message: impl Into<String>) -> V3ConfigError {
    V3ConfigError::Validation(message.into())
}
