impl V3ProviderSchedulingReader for V3ProviderHealthStore {
    fn scheduling_projection_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> V3ProviderSchedulingProjection {
        self.scheduling_projection_for_key_with_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            priority,
            base_weight,
            now_ms,
        )
        .unwrap_or_else(|_| V3ProviderSchedulingProjection {
            provider_id: provider_id.to_string(),
            interface_id: interface_id.to_string(),
            auth_alias: auth_alias.to_string(),
            model_id: model_id.to_string(),
            priority,
            effective_priority: priority,
            score_milli: 0,
            base_weight,
            effective_weight_milli: 0,
            available: false,
            blocked_scopes: vec!["provider_key_health_projection_failed".to_string()],
            score_generation: 0,
        })
    }

    fn scheduling_projection(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> V3ProviderSchedulingProjection {
        self.scheduling_projection_for_key(
            provider_id,
            auth_alias,
            model_id,
            priority,
            base_weight,
            now_ms,
        )
        .unwrap_or_else(|_| V3ProviderSchedulingProjection {
            provider_id: provider_id.to_string(),
            interface_id: "default".to_string(),
            auth_alias: auth_alias.to_string(),
            model_id: model_id.to_string(),
            priority,
            effective_priority: priority,
            score_milli: 0,
            base_weight,
            effective_weight_milli: 0,
            available: false,
            blocked_scopes: vec!["provider_key_health_projection_failed".to_string()],
            score_generation: 0,
        })
    }
}

fn key_health_projection(
    state: &V3ProviderHealthState,
    key: &V3ProviderCooldownProbeKey,
    now_ms: u64,
) -> V3ProviderKeyHealthProjection {
    let history = state.adaptive_history.get(key);
    let probe = state.provider_cooldown_probes.get(key);
    // Diagnostics must agree with selection: both read the same helper. The
    // reported deadline is the real hold window for a rate-limit hold or an
    // advisory probe, otherwise the probe cadence.
    let cooldown = probe.is_some_and(|probe| probe_state_blocks_availability(probe, now_ms));
    let cooldown_until_ms = probe.and_then(|probe| {
        if probe.cooldown_cause
            == Some(crate::global_cooldown::V3ProviderCooldownFailureClass::RateLimit)
            || probe.advisory_probe
        {
            probe.blocked_until_ms
        } else {
            probe.next_probe_at_ms.or(probe.blocked_until_ms)
        }
    });
    V3ProviderKeyHealthProjection {
        provider_id: key.provider_id.clone(),
        interface_id: key.interface_id.clone(),
        auth_alias: key.auth_alias.clone().unwrap_or_default(),
        model_id: key.model_id.clone().unwrap_or_default(),
        score_milli: history.map_or(100, |history| history.score_milli),
        failure_streak: history.map_or(0, |history| history.failure_streak),
        success_streak: history.map_or(0, |history| history.success_streak),
        cooldown,
        cooldown_until_ms,
        available: !cooldown && cooldown_until_ms.is_none_or(|deadline| deadline <= now_ms),
        score_generation: history.map_or(0, |history| history.score_generation),
    }
}

fn record_health_delta(history: &mut V3ProviderAdaptiveHistory, delta: i32) {
    history.score_milli =
        (i64::from(history.score_milli) + i64::from(delta)).clamp(0, 150) as u32;
}

/// A probe excludes the identity only while the real cooldown window is open.
/// A 429 rate-limit hold is bounded: it stops blocking once `blocked_until_ms`
/// passes, so the identity is released automatically even without a probe. An
/// advisory probe's scheduling state (active, pending, in-flight) is never an
/// availability decision: upstream stays selectable and the probe remains the
/// recovery path, so a probe failure cannot lock the provider out.
fn probe_state_blocks_availability(probe: &V3ProviderCooldownProbeState, now_ms: u64) -> bool {
    if probe.cooldown_cause == Some(crate::global_cooldown::V3ProviderCooldownFailureClass::RateLimit)
        || probe.advisory_probe
    {
        return probe
            .blocked_until_ms
            .is_some_and(|blocked_until_ms| blocked_until_ms > now_ms);
    }
    probe.active_probe.is_some()
        || probe.next_probe_at_ms.is_some()
        || probe
            .blocked_until_ms
            .is_some_and(|blocked_until_ms| blocked_until_ms > now_ms)
}

fn provider_failure_session_scope_label(key: &V3ProviderFailureSessionKey) -> String {
    format!(
        "provider_failure_session:{}:{}:{}:{}",
        key.server_id, key.routing_group, key.session_id, key.provider_runtime_identity
    )
}

fn remove_expired_session_state(state: &mut V3ProviderHealthState, now_ms: u64) {
    const SESSION_STATE_IDLE_TTL_MS: u64 = 30 * 60_000;
    state
        .cooldowns
        .retain(|_, cooldown| cooldown.until_ms.is_none_or(|until_ms| until_ms > now_ms));
    // provider 级冷却探针状态独立于 session 冷却：冷却期、待探期、探针
    // 执行中都保留，只有 `complete_provider_cooldown_probe_success` 清除。
    state.provider_cooldown_probes.retain(|_, probe_state| {
        probe_state.active_probe.is_some()
            || probe_state.next_probe_at_ms.is_some()
            || probe_state
                .blocked_until_ms
                .is_some_and(|blocked_until_ms| blocked_until_ms > now_ms)
    });
    // provider 级冷却：冷却期（until 未过期）与待探期（next_probe_at 已设）
    // 都保留——冷却到期不自动恢复，必须后台 probe 通过；无探针的过期条目
    // 视为异常态清理。
    state.consecutive_failures.retain(|_, failure| {
        failure
            .last_failure_at_ms
            .saturating_add(SESSION_STATE_IDLE_TTL_MS)
            > now_ms
    });
}

fn availability_scope_keys(
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> Vec<String> {
    let mut keys = vec![format!("provider_instance:{provider_id}")];
    if let Some(auth_alias) = auth_alias {
        keys.push(format!(
            "auth_key:{provider_id}:{interface_id}:{auth_alias}"
        ));
        if interface_id == "default" {
            keys.push(format!("auth_key:{provider_id}:{auth_alias}"));
        }
    }
    if let Some(model_id) = model_id {
        keys.push(format!(
            "canonical_model:{provider_id}:{interface_id}:{model_id}"
        ));
        if interface_id == "default" {
            keys.push(format!("canonical_model:{provider_id}:{model_id}"));
        }
    }
    if auth_alias.is_some() || model_id.is_some() {
        keys.push(provider_key_scope_label(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        ));
        if interface_id == "default" {
            keys.push(format!(
                "provider_key:{}",
                provider_key_label_legacy(provider_id, auth_alias, model_id)
            ));
        }
    }
    keys
}

fn provider_key_label_legacy(
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> String {
    format!(
        "{}:{}:{}",
        provider_id,
        auth_alias.unwrap_or("-"),
        model_id.unwrap_or("-")
    )
}

fn provider_key_scope_label(
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> String {
    format!(
        "provider_key:{}",
        provider_key_label(provider_id, interface_id, auth_alias, model_id)
    )
}

fn provider_key_label(
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> String {
    format!(
        "{}:{}:{}:{}",
        provider_id,
        interface_id,
        auth_alias.unwrap_or("-"),
        model_id.unwrap_or("-")
    )
}

fn provider_failure_session_key_for_interface(
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> V3ProviderFailureSessionKey {
    V3ProviderFailureSessionKey {
        server_id: failure_session_scope.server_id().to_string(),
        routing_group: failure_session_scope.routing_group().to_string(),
        session_id: failure_session_scope.session_id().to_string(),
        provider_id: provider_id.to_string(),
        interface_id: interface_id.to_string(),
        auth_alias: auth_alias.map(str::to_string),
        model_id: model_id.map(str::to_string),
        provider_runtime_identity: provider_key_label(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        ),
    }
}

fn upsert_provider_cooldown_probe(
    state: &mut V3ProviderHealthState,
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
    now_ms: u64,
    blocked_until_ms: u64,
) {
    upsert_provider_cooldown_probe_with_interval(
        state,
        provider_id,
        interface_id,
        auth_alias,
        model_id,
        now_ms,
        blocked_until_ms,
        V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS,
        false,
        state
            .failure_policies
            .get(provider_id)
            .is_some_and(|policy| policy.advisory_probe),
    );
}

fn record_adaptive_failure(
    state: &mut V3ProviderHealthState,
    key: &V3ProviderCooldownProbeKey,
) -> u64 {
    let history = state.adaptive_history.entry(key.clone()).or_default();
    history.attempts = history.attempts.saturating_add(1);
    history.failures = history.failures.saturating_add(1);
    adaptive_probe_interval_ms(
        history.attempts,
        history.failures,
        history.recovery_ewma_ms,
        history.probe_failure_count,
    )
}

fn record_adaptive_success(
    state: &mut V3ProviderHealthState,
    key: &V3ProviderCooldownProbeKey,
    now_ms: u64,
) {
    let recovery_ms = state
        .provider_cooldown_probes
        .get(key)
        .map(|probe| now_ms.saturating_sub(probe.cooldown_started_at_ms));
    let history = state.adaptive_history.entry(key.clone()).or_default();
    // A successful request closes the current failure-rate window. The next
    // provider failure must start at the first 5s cooldown step.
    history.attempts = 0;
    history.failures = 0;
    history.failure_streak = 0;
    history.failure_fingerprint = None;
    if let Some(recovery_ms) = recovery_ms {
        history.recovery_ewma_ms = Some(match history.recovery_ewma_ms {
            Some(previous) => previous.saturating_mul(4).saturating_add(recovery_ms) / 5,
            None => recovery_ms,
        });
    }
    history.probe_failure_count = 0;
}

fn complete_provider_probe_success_at_generation(
    state: &mut V3ProviderHealthState,
    key: &V3ProviderCooldownProbeKey,
    now_ms: u64,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    let current_generation = state
        .adaptive_history
        .get(key)
        .map_or(0, |history| history.score_generation);
    if let Some(expected_generation) = expected_generation {
        if expected_generation != current_generation {
            return Ok(());
        }
    }

    record_adaptive_success(state, key, now_ms);
    if let Some(history) = state.adaptive_history.get_mut(key) {
        history.failure_streak = 0;
        history.success_streak = 1;
        history.attempts = 0;
        history.failures = 0;
        history.score_milli = 100;
        history.last_success_at_ms = Some(now_ms);
        history.probe_failure_count = 0;
        history.score_generation = history.score_generation.saturating_add(1);
    }

    state.provider_cooldown_probes.remove(key);
    state.auth_key_cooldowns.remove(key);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn upsert_provider_cooldown_probe_with_interval(
    state: &mut V3ProviderHealthState,
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
    now_ms: u64,
    blocked_until_ms: u64,
    probe_interval_ms: u64,
    long_probe_backoff: bool,
    advisory_probe: bool,
) {
    // 已有 probe 在途时保留 in-flight 标记：并发失败 re-upsert 不得清掉
    // 单飞锁，否则会并发启动第二个 probe。
    let existing = state
        .provider_cooldown_probes
        .get(&provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        ));
    let active_probe = existing.and_then(|probe_state| probe_state.active_probe);
    let existing_probe_failure_count =
        existing.map_or(0, |probe_state| probe_state.probe_failure_count);
    let existing_probe_interval_ms = existing.map(|probe_state| probe_state.probe_interval_ms);
    let existing_blocked_until_ms = existing.and_then(|probe_state| probe_state.blocked_until_ms);
    let max_probe_interval_ms = existing
        .and_then(|probe_state| probe_state.max_probe_interval_ms)
        .or_else(|| {
            state
                .failure_policies
                .get(provider_id)
                .and_then(|policy| policy.max_probe_interval_ms)
        });
    let probe_interval_ms = existing_probe_interval_ms.unwrap_or(probe_interval_ms);
    let probe_interval_ms = probe_interval_ms.clamp(1, MAX_PROBE_INTERVAL_MS);
    let probe_interval_ms = max_probe_interval_ms
        .map(|maximum| probe_interval_ms.min(maximum))
        .unwrap_or(probe_interval_ms);
    let blocked_until_ms = existing_blocked_until_ms
        .map(|existing| existing.max(blocked_until_ms))
        .unwrap_or(blocked_until_ms);
    let rescue_probe_attempted =
        existing.is_some_and(|probe_state| probe_state.rescue_probe_attempted);
    state.provider_cooldown_probes.insert(
        provider_cooldown_probe_key_for_interface(provider_id, interface_id, auth_alias, model_id),
        V3ProviderCooldownProbeState {
            // A new failure owns the cooldown state it creates. The 429 caller
            // re-stamps `RateLimit` right after this upsert, so inheriting a
            // previous cause here would let a later non-429 failure keep the
            // bounded rate-limit marker and lose its probe-owned window.
            cooldown_cause: None,
            blocked_until_ms: Some(blocked_until_ms),
            next_probe_at_ms: Some(now_ms.saturating_add(probe_interval_ms.max(1))),
            probe_interval_ms,
            max_probe_interval_ms,
            probe_failure_count: existing_probe_failure_count,
            long_probe_backoff,
            observed_attempts: 0,
            observed_failures: 0,
            recovery_ewma_ms: existing.and_then(|probe_state| probe_state.recovery_ewma_ms),
            cooldown_started_at_ms: now_ms,
            active_probe,
            probe_model_id: model_id.map(str::to_string),
            rescue_probe_attempted,
            advisory_probe,
        },
    );
}

fn scope_label(scope: &V3ErrorActionScope) -> String {
    match scope {
        V3ErrorActionScope::None => "none".to_string(),
        V3ErrorActionScope::ProviderInstance { provider_id } => {
            format!("provider_instance:{provider_id}")
        }
        V3ErrorActionScope::ProviderKeyModel {
            provider_id,
            auth_alias,
            model_id,
        } => provider_key_scope_label(provider_id, "default", Some(auth_alias), Some(model_id)),
    }
}
