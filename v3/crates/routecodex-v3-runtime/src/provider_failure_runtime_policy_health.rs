impl V3ProviderFailureRuntimeHealth {
    pub(crate) fn from_manifest_for_listener(manifest: &V3Config05ManifestPublished, port: u16) -> Self {
        Self {
            store: V3ProviderHealthStore::from_manifest_for_listener(manifest, port),
            action_gate: V3ProviderActionGate::default(),
            probe_owner: Default::default(),
            transition_lock: Default::default(),
        }
    }

    pub fn from_manifest_for_tests(manifest: &V3Config05ManifestPublished) -> Self {
        let store = V3ProviderHealthStore::from_manifest_without_persistence(manifest);
        Self {
            store,
            action_gate: V3ProviderActionGate::process_shared(),
            probe_owner: Default::default(),
            transition_lock: Default::default(),
        }
    }

    pub fn from_manifest_for_isolated_tests(manifest: &V3Config05ManifestPublished) -> Self {
        let store = V3ProviderHealthStore::from_manifest_without_persistence(manifest);
        Self {
            store,
            action_gate: V3ProviderActionGate::default(),
            probe_owner: Default::default(),
            transition_lock: Default::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        Self::from_manifest_for_isolated_tests(manifest)
    }

    #[cfg(not(test))]
    pub(crate) fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        let store = V3ProviderHealthStore::from_manifest(manifest);
        Self {
            store,
            action_gate: V3ProviderActionGate::process_shared(),
            probe_owner: Default::default(),
            transition_lock: Default::default(),
        }
    }

    /// Serialize the last-routable decision with the corresponding health write.
    /// Both execution modes must use this boundary before excluding a candidate.
    pub(crate) fn record_candidate_failure(
        &self,
        scope: &V3ProviderFailureSessionScope,
        selected: &V3Target10ConcreteProviderSelected,
        candidates: &[routecodex_v3_target::V3TargetCandidate],
        excluded: &std::collections::BTreeSet<String>,
        now_ms: u64,
        reason: Option<&str>,
        record: impl FnOnce() -> Result<V3ProviderFailureRecord, String>,
    ) -> Result<(bool, V3ProviderFailureRecord), String> {
        let _transition = self
            .transition_lock
            .lock()
            .map_err(|_| "provider health transition lock poisoned".to_string())?;
        let current = v3_relay_provider_candidate_key(&selected.candidate);
        let has_alternative = candidates.iter().any(|candidate| {
            let key = v3_relay_provider_candidate_key(candidate);
            key != current
                && !excluded.contains(&key)
                && self
                    .store
                    .availability_for_session_for_interface(
                        scope,
                        &candidate.provider_id,
                        &candidate.interface_id,
                        Some(&candidate.auth_alias),
                        Some(&candidate.model_id),
                        now_ms,
                    )
                    .available
        });
        if has_alternative {
            record().map(|record| (false, record))
        } else {
            self.record_provider_failure_in_session_without_health_cooldown_for_interface(
                scope,
                &selected.candidate.provider_id,
                &selected.candidate.interface_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                reason,
                now_ms,
            )
            .map(|record| (true, record))
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
        if matches!(
            action.recovery,
            V3ProviderRecoveryKind::NotProviderHealth
                | V3ProviderRecoveryKind::HealthNeutralTransient
        ) {
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
            let permit = match self.store.acquire_provider_cooldown_probe_for_interface(
                &provider_id,
                &interface_id,
                auth_alias.as_deref(),
                model_id.as_deref(),
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
            if let Err(error) =
                complete_v3_provider_health_probe(&cancellation, result, completion_now_ms)
            {
                probe_errors.push(error);
            }
            drop(cancellation);
            while in_flight.len() < V3_PROVIDER_HEALTH_PROBE_MAX_CONCURRENCY {
                let Some((provider_id, interface_id, auth_alias, model_id)) = pending_keys.next()
                else {
                    break;
                };
                let permit = match self.store.acquire_provider_cooldown_probe_for_interface(
                    &provider_id,
                    &interface_id,
                    auth_alias.as_deref(),
                    model_id.as_deref(),
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
        let classified = build_v3_error_02_classified_from_v3_error_01(source.clone());
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
        self.record_provider_failure_record_with_action_for_interface(
            failure_session_scope,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            Some(&source.message),
            now_ms,
            &action,
        )
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
    ) -> Result<V3ProviderFailureRecord, String> {
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
    ) -> Result<V3ProviderFailureRecord, String> {
        let code = error_type.unwrap_or("provider_failure").to_string();
        let source = build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            source_stage,
            code.clone(),
            message,
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(status),
                code: Some(code),
                provider_id: Some(provider_id.to_string()),
                upstream_request_id: None,
                message: Some(message.to_string()),
            },
        );
        let classified = build_v3_error_02_classified_from_v3_error_01(source.clone());
        let failure_action = build_v3_provider_failure_action_from_v3_error_02(&classified);
        if let Some(policy) = matched_policy_directive
            .map(|policy| {
                provider_failure_policy_from_error_policy_directive(
                    policy,
                    status,
                    failure_action.recovery,
                )
            })
            .transpose()?
            .flatten()
        {
            return self
                .store
                .record_provider_failure_in_session_with_policy_for_interface(
                    failure_session_scope,
                    provider_id,
                    interface_id,
                    auth_alias,
                    model_id,
                    reason,
                    failure_action.failure_fingerprint.clone(),
                    now_ms,
                    Some(policy),
                )
                .map_err(|error| error.to_string());
        }
        // 统一错误模型：任何 provider 失败（含 400/invalid_request）都按
        // internal 全局策略表盖章阈值后计入全局健康；连续达到阈值即进入
        // 全局冷却，由后台探活或真实成功恢复，不再按状态码豁免。
        let action = apply_v3_internal_provider_failure_policy(
            build_v3_provider_failure_action_from_v3_error_02(&classified),
            source_stage,
            status,
            error_type.unwrap_or("provider_failure"),
        );
        let projection = self.record_provider_key_failure_action_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            &action,
            now_ms,
        )?;
        let session_record = self
            .record_provider_failure_in_session_without_health_cooldown_for_interface(
                failure_session_scope,
                provider_id,
                interface_id,
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
            Some(&projection.interface_id),
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
        self.store
            .record_provider_success_in_session_for_interface(
                failure_session_scope,
                provider_id,
                interface_id,
                auth_alias,
                model_id,
                now_ms,
            )
            .map_err(|error| error.to_string())?;
        if let (Some(auth_alias), Some(model_id)) = (auth_alias, model_id) {
            self.store.record_provider_key_success_for_interface(
                provider_id,
                interface_id,
                auth_alias,
                model_id,
                now_ms,
            )?;
        }
        self.action_gate
            .record_provider_success(&V3ProviderActionProviderScope::new(
                failure_session_scope,
                v3_relay_provider_candidate_key_parts(
                    provider_id,
                    Some(interface_id),
                    auth_alias,
                    model_id,
                ),
            )?)
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

    pub(crate) fn record_provider_action_failure_in_scope(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
    ) -> Result<V3ProviderActionFailureRecorded, String> {
        self.record_provider_action_failure_in_scope_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            error_family,
        )
    }

    pub(crate) fn record_provider_action_failure_in_scope_for_interface(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
    ) -> Result<V3ProviderActionFailureRecorded, String> {
        self.record_provider_action_failure_in_scope_with_minimum_delay_for_interface(
            failure_session_scope,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            error_family,
            0,
        )
    }

    pub(crate) fn record_provider_action_failure_in_scope_with_minimum_delay(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
        minimum_delay_ms: u64,
    ) -> Result<V3ProviderActionFailureRecorded, String> {
        self.record_provider_action_failure_in_scope_with_minimum_delay_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            error_family,
            minimum_delay_ms,
        )
    }

    pub(crate) fn record_provider_action_failure_in_scope_with_minimum_delay_for_interface(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
        minimum_delay_ms: u64,
    ) -> Result<V3ProviderActionFailureRecorded, String> {
        self.action_gate.record_failure_with_minimum_delay(
            &V3ProviderActionGateKey::new(
                failure_session_scope,
                v3_relay_provider_candidate_key_parts(
                    provider_id,
                    Some(interface_id),
                    auth_alias,
                    model_id,
                ),
                error_family,
            )?,
            minimum_delay_ms,
        )
    }

    pub(crate) fn record_terminal_provider_projection_in_scope(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
    ) -> Result<V3ProviderActionAdmission, String> {
        self.record_terminal_provider_projection_in_scope_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            error_family,
        )
    }

    pub(crate) fn record_terminal_provider_projection_in_scope_for_interface(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
    ) -> Result<V3ProviderActionAdmission, String> {
        self.action_gate
            .record_failure_and_commit_terminal_projection(V3ProviderActionGateKey::new(
                failure_session_scope,
                v3_relay_provider_candidate_key_parts(
                    provider_id,
                    Some(interface_id),
                    auth_alias,
                    model_id,
                ),
                error_family,
            )?)
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
        self.record_provider_action_failure_in_scope_for_interface(
            failure_session_scope,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            _error_family,
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
        let classified = build_v3_error_02_classified_from_v3_error_01(source.clone());
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
        self.record_provider_action_failure_in_scope_for_interface(
            failure_session_scope,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            &source.code,
        )?;
        Ok(())
    }

    pub(crate) async fn wait_for_error05_recovery(
        &self,
        witness: &V3Error05RecoveryAdmissionWitness,
        selected: &V3Target10ConcreteProviderSelected,
        deadline: std::time::Instant,
    ) -> Result<V3ProviderActionRecoveryTransition, String> {
        let provider_scope = V3ProviderActionProviderScope::new(
            witness.failure_session_scope(),
            v3_relay_provider_candidate_key_parts(
                &selected.candidate.provider_id,
                Some(&selected.candidate.interface_id),
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
            ),
        )?;
        tokio::time::timeout_at(
            deadline.into(),
            self.action_gate
                .wait_for_recovery_witness(witness, provider_scope),
        )
        .await
        .map_err(|_| {
            "request residence deadline exceeded while waiting for provider recovery".to_string()
        })?
    }

    pub(crate) fn recovery_for_selected_provider(
        &self,
        scope: &V3ProviderFailureSessionScope,
        selected: &V3Target10ConcreteProviderSelected,
    ) -> Result<Option<V3Error05RecoveryAdmissionWitness>, String> {
        self.action_gate
            .active_recovery_witness(&V3ProviderActionProviderScope::new(
                scope,
                v3_relay_provider_candidate_key(&selected.candidate),
            )?)
    }

    pub(crate) async fn wait_for_exact_selected_provider_action(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        selected: &V3Target10ConcreteProviderSelected,
    ) -> Result<Option<V3ProviderActionAdmission>, String> {
        self.action_gate
            .wait_for_exact_provider_action(&V3ProviderActionProviderScope::new(
                failure_session_scope,
                v3_relay_provider_candidate_key_parts(
                    &selected.candidate.provider_id,
                    Some(&selected.candidate.interface_id),
                    Some(&selected.candidate.auth_alias),
                    Some(&selected.candidate.model_id),
                ),
            )?)
            .await
    }

    pub(crate) fn store(&self) -> V3ProviderHealthStore {
        self.store.clone()
    }

    pub(crate) fn session_bound_availability(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
    ) -> V3SessionGlobalAvailabilityReader {
        V3SessionGlobalAvailabilityReader {
            session: V3ProviderSessionAvailabilityReader::new(
                self.store.clone(),
                failure_session_scope.clone(),
            ),
        }
    }
}
