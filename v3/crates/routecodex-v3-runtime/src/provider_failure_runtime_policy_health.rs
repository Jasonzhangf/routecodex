fn classify_v3_provider_health_source_via_err02(
    source_projection: Value,
    source: V3Error01SourceRaised,
) -> Result<routecodex_v3_error::V3Error02Classified, V3RelayErrorOperatorFault> {
    let original_source = source.clone();
    crate::operation_runner::run_v3_err02_classified_operator(source_projection, source, None)
        .map(|(_projection, classified)| classified)
        .map_err(|error| {
            relay_error_operator_fault(
                "relay_error_operator_sdk_failure",
                error.message,
                Some(original_source),
            )
        })
}

impl V3ProviderFailureRuntimeHealth {
    pub fn from_manifest_for_tests(manifest: &V3Config05ManifestPublished) -> Self {
        let store = V3ProviderHealthStore::from_manifest_without_persistence(manifest);
        Self {
            store,
            probe_owner: Default::default(),
            observation_clock: None,
            default_same_provider_retries: V3RelayProviderFailureRetryPolicy::from_manifest(
                manifest,
            )
            .same_candidate_retries,
        }
    }

    pub fn from_manifest_for_isolated_tests(manifest: &V3Config05ManifestPublished) -> Self {
        let store = V3ProviderHealthStore::from_manifest_without_persistence(manifest);
        Self {
            store,
            probe_owner: Default::default(),
            observation_clock: None,
            default_same_provider_retries: V3RelayProviderFailureRetryPolicy::from_manifest(
                manifest,
            )
            .same_candidate_retries,
        }
    }

    /// Build the runtime health owned by one business listener.
    ///
    /// The listener owns its own store, availability generation, failure and
    /// action state, and recovery scheduler owner. A listener-scoped handle
    /// must not share the process-wide action gate, otherwise one port's
    /// failure admission would still gate another port.
    pub fn from_manifest_for_listener(
        manifest: &V3Config05ManifestPublished,
        listener: &V3ProviderHealthListenerScope,
    ) -> Self {
        let store = V3ProviderHealthStore::from_manifest_for_listener(manifest, listener);
        Self::from_listener_store(manifest, store)
    }

    fn from_listener_store(manifest: &V3Config05ManifestPublished, store: V3ProviderHealthStore) -> Self {
        Self {
            store,
            probe_owner: Default::default(),
            observation_clock: None,
            default_same_provider_retries: V3RelayProviderFailureRetryPolicy::from_manifest(
                manifest,
            )
            .same_candidate_retries,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        Self::from_manifest_for_tests(manifest)
    }

    #[cfg(not(test))]
    pub(crate) fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        let store = V3ProviderHealthStore::from_manifest(manifest);
        Self {
            store,
            probe_owner: Default::default(),
            observation_clock: None,
            default_same_provider_retries: V3RelayProviderFailureRetryPolicy::from_manifest(
                manifest,
            )
            .same_candidate_retries,
        }
    }

    pub(crate) fn record_provider_key_failure_action(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        action: &V3ProviderFailureAction,
        now_ms: u64,
    ) -> Result<Option<V3ProviderKeyHealthProjection>, String> {
        self.record_provider_key_failure_action_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
            action,
            now_ms,
        )
    }

    pub(crate) fn record_provider_key_failure_action_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        action: &V3ProviderFailureAction,
        now_ms: u64,
    ) -> Result<Option<V3ProviderKeyHealthProjection>, String> {
        let rate_limit_observation = action
            .failure_fingerprint
            .as_ref()
            .is_some_and(|fingerprint| fingerprint.http_status == 429);
        if matches!(
            action.recovery,
            V3ProviderRecoveryKind::NotProviderHealth
                | V3ProviderRecoveryKind::HealthNeutralTransient
        ) && !rate_limit_observation
        {
            return Ok(None);
        }
        let (Some(auth_alias), Some(model_id)) = (auth_alias, model_id) else {
            return Err(format!(
                "provider health action {} requires complete key identity: provider={provider_id} auth_alias={auth_alias:?} model_id={model_id:?}",
                action.class_code
            ));
        };
        self.store
            .record_provider_failure_action_for_interface(
                provider_id,
                interface_id,
                auth_alias,
                model_id,
                action,
                now_ms,
            )
            .map(Some)
    }

    pub async fn run_due_provider_health_probes<F, Fut>(
        &self,
        now_ms: u64,
        startup: bool,
        probe: F,
    ) -> Result<(), String>
    where
        F: Fn(String, String, Option<String>, Option<String>) -> Fut + Clone,
        Fut: Future<Output = Result<(), V3ProviderHealthProbeFailure>>,
    {
        let mut probe_errors = Vec::new();
        let mut pending_keys = self
            .store
            .provider_cooldown_probe_keys_with_interface(now_ms, startup)
            .map_err(|error| error.to_string())?
            .into_iter();
        let mut in_flight = FuturesUnordered::new();
        while in_flight.len() < V3_PROVIDER_HEALTH_PROBE_MAX_CONCURRENCY {
            let Some((provider_id, interface_id, auth_alias, model_id)) = pending_keys.next()
            else {
                break;
            };
            let permit = match self.store.acquire_provider_cooldown_probe_for_sweep(
                &provider_id,
                &interface_id,
                auth_alias.as_deref(),
                model_id.as_deref(),
                now_ms,
                startup,
            ) {
                Ok(Some(permit)) => permit,
                Ok(None) => continue,
                Err(error) => {
                    probe_errors.push(error.to_string());
                    break;
                }
            };
            in_flight.push(execute_provider_health_probe(
                self.store.clone(),
                permit,
                probe.clone(),
            ));
        }
        while let Some((cancellation, result)) = in_flight.next().await {
            let completion_now_ms = match SystemTime::now().duration_since(UNIX_EPOCH) {
                Ok(duration) => duration.as_millis() as u64,
                Err(error) => {
                    probe_errors.push(format!("provider probe completion clock failure: {error}"));
                    now_ms
                }
            };
            if let Err(error) = complete_v3_provider_health_probe(
                &cancellation,
                self,
                result,
                self.observation_now_ms(completion_now_ms),
            ) {
                probe_errors.push(error);
            }
            drop(cancellation);
            while in_flight.len() < V3_PROVIDER_HEALTH_PROBE_MAX_CONCURRENCY {
                let Some((provider_id, interface_id, auth_alias, model_id)) = pending_keys.next()
                else {
                    break;
                };
                let permit = match self.store.acquire_provider_cooldown_probe_for_sweep(
                    &provider_id,
                    &interface_id,
                    auth_alias.as_deref(),
                    model_id.as_deref(),
                    now_ms,
                    startup,
                ) {
                    Ok(Some(permit)) => permit,
                    Ok(None) => continue,
                    Err(error) => {
                        probe_errors.push(error.to_string());
                        break;
                    }
                };
                in_flight.push(execute_provider_health_probe(
                    self.store.clone(),
                    permit,
                    probe.clone(),
                ));
            }
        }
        if probe_errors.is_empty() {
            Ok(())
        } else {
            Err(probe_errors.join("; "))
        }
    }

    pub(crate) fn default_same_provider_retries(&self) -> usize {
        self.default_same_provider_retries
    }

    pub(crate) fn record_provider_failure_record(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.record_provider_failure_record_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            reason,
            now_ms,
        )
    }

    pub(crate) fn record_provider_failure_record_for_interface(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.store
            .record_provider_failure_in_session_with_policy_for_interface(
                failure_session_scope,
                provider_id,
                interface_id,
                auth_alias,
                model_id,
                reason,
                None,
                now_ms,
                None,
            )
            .map_err(|error| error.to_string())
    }

    pub(crate) fn record_provider_failure_record_from_source(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        source: &V3Error01SourceRaised,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.record_provider_failure_record_from_source_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            source,
            now_ms,
        )
    }

    pub(crate) fn record_provider_failure_record_from_source_for_interface(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        source: &V3Error01SourceRaised,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.record_real_provider_error_for_interface(
            provider_id, interface_id, auth_alias, model_id, source, now_ms,
        )?;
        let source_projection = serde_json::to_value(source)
            .map_err(|error| format!("serialize Err01 source raised: {error}"))?;
        let (_, classified) = crate::operation_runner::run_v3_err02_classified_operator(
            source_projection,
            source.clone(),
            None,
        )
        .map_err(|error| error.to_string())?;
        let status = source
            .external_error
            .as_ref()
            .and_then(|error| error.status)
            .unwrap_or(0);
        let action = apply_v3_internal_provider_failure_policy(
            build_v3_provider_failure_action_from_v3_error_02(&classified),
            source.source_stage,
            status,
            &source.code,
        );
        self.record_provider_health_action_immediately(
            failure_session_scope,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            Some(&source.message),
            now_ms,
            &action,
            None,
        )
    }

    pub(crate) fn record_real_provider_error_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        source: &V3Error01SourceRaised,
        now_ms: u64,
    ) -> Result<(), String> {
        let (Some(auth_alias), Some(model_id), Some(external)) =
            (auth_alias, model_id, source.external_error.as_ref()) else { return Ok(()); };
        let status = match external.kind {
            V3ExternalErrorKind::Provider | V3ExternalErrorKind::Upstream => {
                let Some(status) = external.status else { return Ok(()); };
                Some(status)
            }
            V3ExternalErrorKind::Transport => None,
            V3ExternalErrorKind::Client => return Ok(()),
        };
        self.store.record_real_provider_failure_for_interface(
            provider_id, interface_id, auth_alias, model_id, status,
            self.observation_now_ms(now_ms),
        )?;
        Ok(())
    }

    pub(crate) fn record_provider_failure_record_with_action(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
        action: &V3ProviderFailureAction,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.record_provider_failure_record_with_action_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            reason,
            now_ms,
            action,
        )
    }

    pub(crate) fn record_provider_failure_record_with_action_for_interface(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
        action: &V3ProviderFailureAction,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.record_provider_key_failure_action_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            action,
            now_ms,
        )?;
        self.record_provider_failure_in_session_without_health_cooldown_for_interface(
            failure_session_scope,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            reason,
            now_ms,
        )
    }

    pub(crate) fn record_provider_failure_in_session_without_health_cooldown(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.record_provider_failure_in_session_without_health_cooldown_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            reason,
            now_ms,
        )
    }

    pub(crate) fn record_provider_failure_in_session_without_health_cooldown_for_interface(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.store
            .record_provider_failure_in_session_with_policy_for_interface(
                failure_session_scope,
                provider_id,
                interface_id,
                auth_alias,
                model_id,
                reason,
                None,
                now_ms,
                Some(V3ProviderFailurePolicy {
                    failure_threshold: u32::MAX,
                    cooldown_ms: 1,
                    probe_interval_ms: 1,
                    max_probe_interval_ms: None,
                    long_probe_backoff: false,
                    until_restart: false,
                    advisory_probe: false,
                    cooldown_scope: V3ProviderFailureCooldownScope::Session,
                }),
            )
            .map_err(|error| error.to_string())
    }

    pub(crate) fn record_provider_failure_record_with_policy(
        &self,
        matched_policy_directive: Option<&V3ProviderErrorActionPolicyManifest>,
        _manifest: &V3Config05ManifestPublished,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        _provider_type: Option<&str>,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        source_stage: &'static str,
        status: u16,
        error_type: Option<&str>,
        message: &str,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, Result<String, V3RelayErrorOperatorFault>> {
        self.record_provider_failure_record_with_policy_for_interface(
            matched_policy_directive,
            _manifest,
            failure_session_scope,
            provider_id,
            "default",
            _provider_type,
            auth_alias,
            model_id,
            reason,
            source_stage,
            status,
            error_type,
            message,
            now_ms,
        )
    }

    pub(crate) fn record_provider_failure_record_with_policy_for_interface(
        &self,
        matched_policy_directive: Option<&V3ProviderErrorActionPolicyManifest>,
        _manifest: &V3Config05ManifestPublished,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        _provider_type: Option<&str>,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        source_stage: &'static str,
        status: u16,
        error_type: Option<&str>,
        message: &str,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, Result<String, V3RelayErrorOperatorFault>> {
        let code = error_type.unwrap_or("provider_failure").to_string();
        let (source_projection, source) = raise_v3_source_via_err01(
            V3ErrorSourceKind::ProviderFailure,
            source_stage,
            code.clone(),
            message,
            V3Err01SourceInput::External(V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(status),
                code: Some(code),
                provider_id: Some(provider_id.to_string()),
                upstream_request_id: None,
                message: Some(message.to_string()),
            }),
        )
        .map_err(Err)?;
        let classified =
            classify_v3_provider_health_source_via_err02(source_projection, source).map_err(Err)?;
        let failure_action = build_v3_provider_failure_action_from_v3_error_02(&classified);
        if let Some(policy) = matched_policy_directive
            .map(|policy| {
                provider_failure_policy_from_error_policy_directive(
                    policy,
                    status,
                    failure_action.recovery,
                )
            })
            .transpose()
            .map_err(Ok)?
            .flatten()
        {
            return self
                .record_provider_health_action_immediately(
                    failure_session_scope,
                    provider_id,
                    interface_id,
                    auth_alias,
                    model_id,
                    reason,
                    now_ms,
                    &failure_action,
                    Some(policy),
                )
                .map_err(Ok);
        }
        // 统一错误模型：任何 provider 失败（含 400/invalid_request）都按
        // internal 全局策略表盖章阈值后计入全局健康；连续达到阈值即进入
        // 全局冷却，由后台探活或真实成功恢复。早期429只做精确身份容量回压；
        // 持续429的minimum和probe-required由health Store唯一episode owner处理。
        let action = apply_v3_internal_provider_failure_policy(
            build_v3_provider_failure_action_from_v3_error_02(&classified),
            source_stage,
            status,
            error_type.unwrap_or("provider_failure"),
        );
        self.record_provider_health_action_immediately(
            failure_session_scope,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            reason,
            now_ms,
            &action,
            None,
        )
        .map_err(Ok)
    }

    pub(crate) fn record_provider_success_in_failure_scope(
        &self,
        _receipt: &crate::nodes::V3AttemptSuccessReceipt,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), String> {
        self.record_provider_success_in_failure_scope_for_interface(
            _receipt,
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            now_ms,
        )
    }

    pub(crate) fn record_provider_success_in_failure_scope_for_interface(
        &self,
        _receipt: &crate::nodes::V3AttemptSuccessReceipt,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), String> {
        let health_now_ms = self.observation_now_ms(now_ms);
        self.store
            .record_provider_success_in_session_for_interface(
                failure_session_scope,
                provider_id,
                interface_id,
                auth_alias,
                model_id,
                health_now_ms,
            )
            .map_err(|error| error.to_string())?;
        if let (Some(auth_alias), Some(model_id)) = (auth_alias, model_id) {
            self.store.record_provider_key_success_for_interface(
                provider_id,
                interface_id,
                auth_alias,
                model_id,
                health_now_ms,
            )?;
        }
        Ok(())
    }

    /// 瞬态失败（SSE 流内/挂起）耗尽 3 次尝试后的 session 级短期绕行：
    /// health-neutral（不触发 15 分钟 cooldown、不累计失败数），但同 session
    /// 后续请求短时绕开该 provider，避免反复命中；超时自动恢复。
    pub(crate) fn record_provider_transient_bypass_in_session(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.record_provider_transient_bypass_in_session_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            reason,
            now_ms,
        )
    }

    pub(crate) fn record_provider_transient_bypass_in_session_for_interface(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.store
            .record_provider_transient_bypass_in_session_for_interface(
                failure_session_scope,
                provider_id,
                interface_id,
                auth_alias,
                model_id,
                reason,
                now_ms,
            )
            .map_err(|error| error.to_string())
    }

    pub(crate) fn record_post_commit_provider_stream_failure(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        _error_family: &str,
        reason: &str,
    ) -> Result<(), String> {
        self.record_post_commit_provider_stream_failure_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            _error_family,
            reason,
        )
    }

    pub(crate) fn record_post_commit_provider_stream_failure_for_interface(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        _error_family: &str,
        reason: &str,
    ) -> Result<(), String> {
        // Post-commit SSE failures are provider-health events. They share the
        // same recoverable score/cooldown policy as pre-commit SSE failures.
        // 统一错误模型：无状态码上下文时也进入默认 provider cooldown。
        let action = apply_v3_internal_provider_failure_policy(
            V3ProviderFailureAction::recoverable(_error_family),
            "",
            0,
            _error_family,
        );
        self.record_provider_failure_record_with_action_for_interface(
            failure_session_scope,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            Some(reason),
            v3_relay_provider_policy_now_epoch_ms()?,
            &action,
        )?;
        Ok(())
    }

    pub(crate) fn record_post_commit_provider_stream_failure_from_source(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        source: &V3Error01SourceRaised,
    ) -> Result<(), String> {
        self.record_post_commit_provider_stream_failure_from_source_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            source,
        )
    }

    pub(crate) fn record_post_commit_provider_stream_failure_from_source_for_interface(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        source: &V3Error01SourceRaised,
    ) -> Result<(), String> {
        let source_projection = serde_json::to_value(source)
            .map_err(|error| format!("serialize Err01 source raised: {error}"))?;
        let (_, classified) = crate::operation_runner::run_v3_err02_classified_operator(
            source_projection,
            source.clone(),
            None,
        )
        .map_err(|error| error.to_string())?;
        let status = source
            .external_error
            .as_ref()
            .and_then(|error| error.status)
            .unwrap_or(0);
        let action = apply_v3_internal_provider_failure_policy(
            build_v3_provider_failure_action_from_v3_error_02(&classified),
            source.source_stage,
            status,
            &source.code,
        );
        if matches!(
            action.recovery,
            V3ProviderRecoveryKind::NotProviderHealth
                | V3ProviderRecoveryKind::HealthNeutralTransient
        ) {
            return Ok(());
        }
        let now_ms = v3_relay_provider_policy_now_epoch_ms()?;
        self.record_real_provider_error_for_interface(
            provider_id, interface_id, auth_alias, model_id, source, now_ms,
        )?;
        self.record_provider_failure_record_with_action_for_interface(
            failure_session_scope,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            Some(&source.message),
            now_ms,
            &action,
        )?;
        Ok(())
    }

    pub(crate) fn store(&self) -> V3ProviderHealthStore {
        self.store.clone()
    }

    pub(crate) fn session_bound_availability(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
    ) -> V3SessionGlobalAvailabilityReader {
        V3SessionGlobalAvailabilityReader {
            health: self.clone(),
            session: V3ProviderSessionAvailabilityReader::new(
                self.store.clone(),
                failure_session_scope.clone(),
            ),
        }
    }
}
