use crate::{
    build_v3_config_04_resource_registry_from_v3_config_03, parse_v3_config_02_authoring,
    publish_v3_config_05_manifest_from_v3_config_04, read_v3_config_01_file_source,
    validate_v3_config_03_schema_from_v3_config_02, V3Config02AuthoringParsed,
    V3Config05ManifestPublished, V3ConfigError,
};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct V3ConfigStore {
    path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ConfigWritePlan {
    pub path: PathBuf,
    pub serialized_toml: String,
}

#[derive(Debug, Clone)]
pub struct V3ConfigLoadedSnapshot {
    pub canonical_path: PathBuf,
    pub source_sha256: String,
    pub manifest: V3Config05ManifestPublished,
}

impl V3ConfigStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read_authoring(&self) -> Result<V3Config02AuthoringParsed, V3ConfigError> {
        let source = read_v3_config_01_file_source(&self.path)?;
        parse_authoring_for_store(&source.path, &source.raw_toml)
    }

    pub fn load_snapshot(&self) -> Result<V3Config05ManifestPublished, V3ConfigError> {
        Ok(self.load_snapshot_with_source_identity()?.manifest)
    }

    pub fn load_snapshot_with_source_identity(
        &self,
    ) -> Result<V3ConfigLoadedSnapshot, V3ConfigError> {
        let source = read_v3_config_01_file_source(&self.path)?;
        let canonical_path = fs::canonicalize(&source.path)?;
        let source_sha256 = format!("{:x}", Sha256::digest(source.raw_toml.as_bytes()));
        let parsed = parse_authoring_for_store(&source.path, &source.raw_toml)?;
        let validated = validate_v3_config_03_schema_from_v3_config_02(parsed)?;
        let registry = build_v3_config_04_resource_registry_from_v3_config_03(validated)?;
        let manifest = publish_v3_config_05_manifest_from_v3_config_04(registry)?;
        Ok(V3ConfigLoadedSnapshot {
            canonical_path,
            source_sha256,
            manifest,
        })
    }

    pub fn plan_write(
        &self,
        authoring: &V3Config02AuthoringParsed,
    ) -> Result<V3ConfigWritePlan, V3ConfigError> {
        let serialized_toml = toml::to_string_pretty(authoring)?;
        Ok(V3ConfigWritePlan {
            path: self.path.clone(),
            serialized_toml,
        })
    }

    pub fn commit_write_atomic(&self, plan: V3ConfigWritePlan) -> Result<(), V3ConfigError> {
        if plan.path != self.path {
            return Err(crate::validation(
                "write plan path does not match config store",
            ));
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temp_path = self
            .path
            .with_extension(format!("toml.tmp-{}", std::process::id()));
        fs::write(&temp_path, plan.serialized_toml)?;
        fs::rename(temp_path, &self.path)?;
        Ok(())
    }
}

fn parse_authoring_for_store(
    path: &Path,
    raw_toml: &str,
) -> Result<V3Config02AuthoringParsed, V3ConfigError> {
    if let Some(authoring) = crate::try_compile_v2_config_02_authoring_from_file(path, raw_toml)? {
        return Ok(authoring);
    }
    parse_v3_config_02_authoring(raw_toml)
}

pub fn default_v3_config_path(home: impl AsRef<Path>) -> PathBuf {
    home.as_ref().join(".rcc").join("config.v3.toml")
}
