use crate::{validation, V3ConfigError};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3MemoryRawCaptureAuthoringConfig {
    #[serde(default = "default_false")]
    pub enabled: bool,
    pub project_root: Option<String>,
    #[serde(default = "default_output_contract")]
    pub output_contract: String,
    #[serde(default = "default_host_id_prefix")]
    pub host_id_prefix: String,
}

impl Default for V3MemoryRawCaptureAuthoringConfig {
    fn default() -> Self {
        Self {
            enabled: default_false(),
            project_root: None,
            output_contract: default_output_contract(),
            host_id_prefix: default_host_id_prefix(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3MemoryRawCaptureManifest {
    pub enabled: bool,
    pub project_root: std::path::PathBuf,
    pub output_contract: String,
    pub host_id_prefix: String,
}

impl Default for V3MemoryRawCaptureManifest {
    fn default() -> Self {
        Self {
            enabled: false,
            project_root: std::path::PathBuf::new(),
            output_contract: default_output_contract(),
            host_id_prefix: default_host_id_prefix(),
        }
    }
}

pub(crate) fn compile_memory_raw_capture(
    authoring: V3MemoryRawCaptureAuthoringConfig,
) -> Result<V3MemoryRawCaptureManifest, V3ConfigError> {
    if !authoring.enabled {
        return Ok(V3MemoryRawCaptureManifest {
            enabled: false,
            project_root: std::path::PathBuf::new(),
            output_contract: authoring.output_contract,
            host_id_prefix: authoring.host_id_prefix,
        });
    }
    if authoring.output_contract.trim() != "responses.output_text" {
        return Err(validation(
            "memory_raw_capture output_contract must be responses.output_text",
        ));
    }
    let Some(root) = authoring
        .project_root
        .filter(|root| !root.trim().is_empty())
    else {
        return Err(validation(
            "memory_raw_capture project_root is required when enabled",
        ));
    };
    let root = std::path::PathBuf::from(root.trim());
    if !root.is_absolute() {
        return Err(validation(
            "memory_raw_capture project_root must be an absolute path",
        ));
    }
    Ok(V3MemoryRawCaptureManifest {
        enabled: true,
        project_root: root,
        output_contract: authoring.output_contract,
        host_id_prefix: if authoring.host_id_prefix.trim().is_empty() {
            default_host_id_prefix()
        } else {
            authoring.host_id_prefix
        },
    })
}

fn default_false() -> bool {
    false
}
fn default_output_contract() -> String {
    "responses.output_text".to_owned()
}
fn default_host_id_prefix() -> String {
    "rcc-memory-host-".to_owned()
}
