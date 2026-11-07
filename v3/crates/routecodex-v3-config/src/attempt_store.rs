use crate::V3ConfigError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3AttemptStorePolicyAuthoringConfig {
    #[serde(default = "default_residence_timeout_ms")]
    pub residence_timeout_ms: u64,
}

impl Default for V3AttemptStorePolicyAuthoringConfig {
    fn default() -> Self {
        Self {
            residence_timeout_ms: default_residence_timeout_ms(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3AttemptStorePolicyManifest {
    pub residence_timeout_ms: u64,
}

pub(crate) fn compile_attempt_store_policy(
    server_id: &str,
    authoring: V3AttemptStorePolicyAuthoringConfig,
) -> Result<V3AttemptStorePolicyManifest, V3ConfigError> {
    if authoring.residence_timeout_ms == 0 {
        return Err(V3ConfigError::Validation(format!(
            "hub_v1 server {server_id} attempt_store residence_timeout_ms must be non-zero"
        )));
    }

    Ok(V3AttemptStorePolicyManifest {
        residence_timeout_ms: authoring.residence_timeout_ms,
    })
}

fn default_residence_timeout_ms() -> u64 {
    600_000
}
