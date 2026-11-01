use crate::{validation, V3ConfigError};
use serde::{Deserialize, Serialize};

/// Runtime process resource limits. These are process-local OS limits, not
/// business payload or control truth; they only bound how many file
/// descriptors the managed runtime process may hold.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3RuntimeAuthoringConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fd_limit: Option<u64>,
}

impl V3RuntimeAuthoringConfig {
    pub fn is_default(&self) -> bool {
        self.fd_limit.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RuntimeManifest {
    pub fd_limit: Option<u64>,
}

impl Default for V3RuntimeManifest {
    fn default() -> Self {
        Self { fd_limit: None }
    }
}

pub(crate) fn compile_runtime(
    authoring: V3RuntimeAuthoringConfig,
) -> Result<V3RuntimeManifest, V3ConfigError> {
    if authoring.fd_limit == Some(0) {
        return Err(validation("runtime fd_limit must be non-zero"));
    }
    Ok(V3RuntimeManifest {
        fd_limit: authoring.fd_limit,
    })
}
