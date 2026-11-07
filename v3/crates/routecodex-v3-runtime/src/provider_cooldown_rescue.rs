pub(crate) fn v3_provider_concurrency_key_parts(provider_id: &str, auth_alias: &str) -> String {
    format!("{provider_id}:{auth_alias}")
}

impl V3ProviderFailureRuntimeHealth {
    pub(crate) fn target_availability_generation(&self) -> u64 {
        self.store.availability_generation()
    }

    pub(crate) async fn wait_for_target_availability_change(
        &self,
        observed_generation: u64,
    ) -> Result<u64, String> {
        self.store
            .wait_for_availability_change(observed_generation)
            .await
            .map_err(|error| error.to_string())
    }
}
