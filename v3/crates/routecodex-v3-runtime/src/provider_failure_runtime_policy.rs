use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_provider_responses::{
    V3ProviderAvailabilityProjection, V3ProviderAvailabilityReader, V3ProviderHealthStore,
};

pub(crate) const V3_PROVIDER_FAILURE_MAX_CONSECUTIVE_FAILURES: usize = 3;
pub(crate) const V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET: usize =
    V3_PROVIDER_FAILURE_MAX_CONSECUTIVE_FAILURES - 1;
pub(crate) const V3_PROVIDER_FAILURE_BACKOFF_DELAY_MS: u64 = 5_000;

#[derive(Debug, Clone)]
pub struct V3ProviderFailureRuntimeHealth {
    store: V3ProviderHealthStore,
}

impl V3ProviderFailureRuntimeHealth {
    pub(crate) fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        Self {
            store: V3ProviderHealthStore::from_manifest(manifest),
        }
    }

    pub(crate) fn record_provider_failure(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<(), String> {
        self.store
            .record_provider_failure(provider_id, auth_alias, model_id, reason, now_ms)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub(crate) fn record_provider_success(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), String> {
        self.store
            .record_provider_success(provider_id, auth_alias, model_id, now_ms)
            .map_err(|error| error.to_string())
    }
}

impl From<V3ProviderHealthStore> for V3ProviderFailureRuntimeHealth {
    fn from(store: V3ProviderHealthStore) -> Self {
        Self { store }
    }
}

impl V3ProviderAvailabilityReader for V3ProviderFailureRuntimeHealth {
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        self.store
            .availability(provider_id, auth_alias, model_id, now_ms)
    }
}
