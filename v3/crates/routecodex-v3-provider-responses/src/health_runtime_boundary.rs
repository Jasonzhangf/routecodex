use crate::health::{V3ProviderFailureRecord, V3ProviderHealthError, V3ProviderHealthStore};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct V3ProviderFailurePolicy {
    pub failure_threshold: u32,
    pub cooldown_ms: u64,
    pub until_restart: bool,
}

impl Default for V3ProviderFailurePolicy {
    fn default() -> Self {
        Self {
            failure_threshold: 3,
            cooldown_ms: 900_000,
            until_restart: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderFailureRuntimeInput {
    pub failure_session_scope: V3ProviderFailureSessionScope,
    pub provider_id: String,
    pub auth_alias: Option<String>,
    pub model_id: Option<String>,
    pub reason: Option<String>,
    pub now_ms: u64,
}

impl V3ProviderHealthStore {
    pub fn record_failure_from_runtime_typed(
        &self,
        input: V3ProviderFailureRuntimeInput,
    ) -> Result<V3ProviderFailureRecord, V3ProviderHealthError> {
        self.record_provider_failure_in_session(
            &input.failure_session_scope,
            &input.provider_id,
            input.auth_alias.as_deref(),
            input.model_id.as_deref(),
            input.reason.as_deref(),
            input.now_ms,
        )
    }
}
