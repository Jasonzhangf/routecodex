use super::*;

impl V3ProviderFailureRuntimeHealth {
    /// The single provider health/action/session recorder shared by the legacy
    /// wire-only caller (real external source, real status) and the typed local
    /// caller (already-classified source, no external status).
    pub(crate) fn record_provider_failure_record_for_source_with_policy(
        &self,
        matched_policy_directive: Option<&V3ProviderErrorActionPolicyManifest>,
        source: &V3Error01SourceRaised,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        // A local typed failure has no external HTTP status; the shared health
        // ladder keys off the typed source, not a synthesized status.
        self.record_provider_failure_record_for_source_with_policy_status(
            matched_policy_directive,
            source,
            failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            reason,
            0,
            now_ms,
        )
    }

    /// Shared core: `policy_status` is the real upstream HTTP status for the
    /// legacy external caller and `0` for an already-classified local source.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn record_provider_failure_record_for_source_with_policy_status(
        &self,
        matched_policy_directive: Option<&V3ProviderErrorActionPolicyManifest>,
        source: &V3Error01SourceRaised,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        policy_status: u16,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        let classified = build_v3_error_02_classified_from_v3_error_01(source.clone());
        if let Some(policy) = matched_policy_directive
            .map(|policy| {
                provider_failure_policy_from_error_policy_directive(policy, policy_status)
            })
            .transpose()?
            .flatten()
        {
            return self
                .store
                .record_provider_failure_in_session_with_policy(
                    failure_session_scope,
                    provider_id,
                    auth_alias,
                    model_id,
                    reason,
                    now_ms,
                    Some(policy),
                )
                .map_err(|error| error.to_string());
        }
        let action = apply_v3_internal_provider_failure_policy(
            build_v3_provider_failure_action_from_v3_error_02(&classified),
            source.source_stage,
            policy_status,
            &source.code,
        );
        let projection = self.record_provider_key_failure_action(
            provider_id,
            auth_alias,
            model_id,
            &action,
            now_ms,
        )?;
        let session_record = self.record_provider_failure_in_session_without_health_cooldown(
            failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            reason,
            now_ms,
        )?;
        let Some(projection) = projection else {
            return Ok(session_record);
        };
        let provider_key = v3_relay_provider_candidate_key_parts(
            &projection.provider_id,
            Some(&projection.auth_alias),
            Some(&projection.model_id),
        );
        Ok(V3ProviderFailureRecord {
            scope_label: session_record.scope_label,
            provider_key,
            state: if projection.cooldown {
                "cooldown".to_string()
            } else {
                "healthy".to_string()
            },
            failure_count: projection.failure_streak,
            cooldown_until_ms: projection.cooldown_until_ms,
            reason: session_record.reason,
        })
    }
}
