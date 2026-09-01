use crate::V3ConfigError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3AttemptStorePolicyAuthoringConfig {
    #[serde(default = "default_request_max_attempts")]
    pub request_max_attempts: usize,
    #[serde(default = "default_attempt_max_bytes")]
    pub attempt_max_bytes: usize,
    #[serde(default = "default_attempt_max_frames")]
    pub attempt_max_frames: usize,
    #[serde(default = "default_request_max_bytes")]
    pub request_max_bytes: usize,
    #[serde(default = "default_process_max_bytes")]
    pub process_max_bytes: usize,
    #[serde(default = "default_residence_timeout_ms")]
    pub residence_timeout_ms: u64,
}

impl Default for V3AttemptStorePolicyAuthoringConfig {
    fn default() -> Self {
        Self {
            request_max_attempts: default_request_max_attempts(),
            attempt_max_bytes: default_attempt_max_bytes(),
            attempt_max_frames: default_attempt_max_frames(),
            request_max_bytes: default_request_max_bytes(),
            process_max_bytes: default_process_max_bytes(),
            residence_timeout_ms: default_residence_timeout_ms(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3AttemptStorePolicyManifest {
    pub request_max_attempts: usize,
    pub attempt_max_bytes: usize,
    pub attempt_max_frames: usize,
    pub request_max_bytes: usize,
    pub process_max_bytes: usize,
    pub residence_timeout_ms: u64,
}

pub(crate) fn compile_attempt_store_policy(
    server_id: &str,
    authoring: V3AttemptStorePolicyAuthoringConfig,
) -> Result<V3AttemptStorePolicyManifest, V3ConfigError> {
    if authoring.request_max_attempts == 0
        || authoring.attempt_max_bytes == 0
        || authoring.attempt_max_frames == 0
        || authoring.request_max_bytes == 0
        || authoring.process_max_bytes == 0
        || authoring.residence_timeout_ms == 0
    {
        return Err(V3ConfigError::Validation(format!(
            "hub_v1 server {server_id} attempt_store limits must be non-zero"
        )));
    }
    if authoring.attempt_max_bytes > authoring.request_max_bytes
        || authoring.request_max_bytes > authoring.process_max_bytes
    {
        return Err(V3ConfigError::Validation(format!(
            "hub_v1 server {server_id} attempt_store byte limits must satisfy attempt <= request <= process"
        )));
    }

    Ok(V3AttemptStorePolicyManifest {
        request_max_attempts: authoring.request_max_attempts,
        attempt_max_bytes: authoring.attempt_max_bytes,
        attempt_max_frames: authoring.attempt_max_frames,
        request_max_bytes: authoring.request_max_bytes,
        process_max_bytes: authoring.process_max_bytes,
        residence_timeout_ms: authoring.residence_timeout_ms,
    })
}

fn default_request_max_attempts() -> usize {
    8
}

fn default_attempt_max_bytes() -> usize {
    64 * 1024 * 1024
}

fn default_attempt_max_frames() -> usize {
    262_144
}

fn default_request_max_bytes() -> usize {
    64 * 1024 * 1024
}

fn default_process_max_bytes() -> usize {
    512 * 1024 * 1024
}

fn default_residence_timeout_ms() -> u64 {
    600_000
}
