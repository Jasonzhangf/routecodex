impl V3ProviderHealthStore {
    pub fn record_provider_failure_in_session(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, V3ProviderHealthError> {
        self.record_provider_failure_in_session_with_policy(
            failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            reason,
            None,
            now_ms,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_provider_failure_in_session_with_policy(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        failure_fingerprint: Option<V3ProviderErrorFingerprint>,
        now_ms: u64,
        policy_override: Option<V3ProviderFailurePolicy>,
    ) -> Result<V3ProviderFailureRecord, V3ProviderHealthError> {
        self.record_provider_failure_in_session_with_policy_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            reason,
            failure_fingerprint,
            now_ms,
            policy_override,
        )
    }
}
