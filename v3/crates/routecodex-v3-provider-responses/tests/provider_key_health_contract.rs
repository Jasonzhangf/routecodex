use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::{
    build_v3_provider_global_error_fingerprint, build_v3_provider_global_failure_policy,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_provider_responses::{
    V3ProviderAvailabilityReader, V3ProviderCooldownCoordinator, V3ProviderFailureAction,
    V3ProviderFailureCooldownScope, V3ProviderFailurePolicy, V3ProviderHealthStore,
    V3ProviderKeyHealthProjection, V3ProviderKeyHealthStore, V3ProviderPrecoolObservationOutcome,
    V3ProviderProbePurpose, V3ProviderRateLimitProbeDisposition, V3ProviderRecoveryKind,
    V3ProviderSchedulingProjection,
};

fn real_http_provider_action(status: u16, code: &str) -> V3ProviderFailureAction {
    let message = format!("controlled {status}");
    let classified = routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01(
        routecodex_v3_error::build_v3_error_01_source_raised_external(
            routecodex_v3_error::V3ErrorSourceKind::ProviderFailure,
            "V3ProviderReqOutbound09TransportRequest",
            code,
            message.clone(),
            routecodex_v3_error::V3ExternalErrorLink {
                kind: routecodex_v3_error::V3ExternalErrorKind::Provider,
                status: Some(status),
                code: Some(code.into()),
                provider_id: Some("p".into()),
                upstream_request_id: None,
                message: Some(message),
            },
        ),
    );
    routecodex_v3_error::build_v3_provider_failure_action_from_v3_error_02(&classified)
}

fn real_http_429_action() -> V3ProviderFailureAction {
    real_http_provider_action(429, "rate_limit_error")
}

fn record_mixed_failures(
    store: &V3ProviderKeyHealthStore,
    provider_id: &str,
    interface_id: &str,
    auth_alias: &str,
    model_id: &str,
    start_ms: u64,
    count: usize,
) -> V3ProviderKeyHealthProjection {
    let statuses = [
        (500, "provider_http_500"),
        (429, "rate_limit_error"),
        (502, "provider_http_502"),
    ];
    let mut projection = None;
    for index in 0..count {
        let (status, code) = statuses[index % statuses.len()];
        projection = Some(
            store
                .record_provider_failure_action_for_interface(
                    provider_id,
                    interface_id,
                    auth_alias,
                    model_id,
                    &real_http_provider_action(status, code),
                    start_ms + index as u64,
                )
                .unwrap(),
        );
    }
    projection.expect("at least one failure must be recorded")
}

#[test]
fn recoverable_429_is_counted_for_exact_identity() {
    let store = V3ProviderKeyHealthStore::default();
    assert_eq!(
        build_v3_provider_global_failure_policy(429)
            .expect("429 shares the recoverable policy")
            .failure_threshold,
        10
    );
    let action = real_http_429_action();
    assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
    for time in 100..109 {
        let state = store
            .record_provider_failure_action("p", "a", "m", &action, time)
            .unwrap();
        assert!(state.available);
        assert!(!state.cooldown);
        assert_eq!(state.failure_streak, (time - 99) as u32);
    }
    assert_eq!(
        store
            .record_provider_failure_action("p", "a", "m", &action, 109)
            .unwrap()
            .cooldown_until_ms,
        Some(15_109)
    );
    // A repeated 429 on the same identity never blocks a sibling identity.
    for (provider, key, model) in [("p", "b", "m"), ("p", "a", "n"), ("q", "a", "m")] {
        let state = store
            .scheduling_projection(provider, key, model, 1, 1, 110)
            .unwrap();
        assert!(state.available, "sibling {provider}.{model}.{key}");
    }
    store
        .record_provider_key_success("p", "a", "m", 125)
        .unwrap();
    store
        .record_provider_failure_action("p", "a", "m", &action, 126)
        .unwrap();
    assert!(
        !store
            .scheduling_projection("p", "a", "m", 1, 1, 126)
            .unwrap()
            .available
    );
    assert!(store
        .acquire_provider_cooldown_probe("p", Some("a"), Some("m"))
        .unwrap()
        .is_none());
    assert!(
        store
            .scheduling_projection("p", "a", "m", 1, 1, 15_109)
            .unwrap()
            .available
    );
    let after_success = store
        .record_provider_failure_action("p", "a", "m", &action, 121_000)
        .unwrap();
    assert!(after_success.available);
    assert_eq!(after_success.failure_streak, 2);
}

#[test]
fn concurrent_429s_count_once_without_sliding_the_short_deadline() {
    let store = V3ProviderHealthStore::default();
    let action = real_http_429_action();
    for time in 1_000..1_010 {
        store
            .record_provider_failure_action("p", "k", "m", &action, time)
            .unwrap();
    }
    std::thread::scope(|workers| {
        for time in 2_000..2_008 {
            let store = &store;
            let action = &action;
            workers.spawn(move || {
                let observed = store
                    .record_provider_failure_action("p", "k", "m", action, time)
                    .unwrap();
                assert_eq!(observed.cooldown_until_ms, Some(16_009));
            });
        }
    });
    let short = store.cooldown_entries(2_008);
    assert_eq!(short.len(), 1);
    assert_eq!(short[0].failure_count, Some(18));
    assert!(
        store
            .scheduling_projection("p", "k", "m", 1, 1, 16_009)
            .unwrap()
            .available
    );
    let sustained = store
        .record_provider_failure_action("p", "k", "m", &action, 121_001)
        .unwrap();
    assert_eq!(sustained.failure_streak, 19);
    assert_eq!(sustained.cooldown_until_ms, Some(3_721_001));
}

#[test]
fn two_429_observations_spanning_two_minutes_do_not_cool() {
    let store = V3ProviderHealthStore::default();
    let action = real_http_429_action();
    let first = store
        .record_provider_failure_action_for_interface("p", "responses", "k", "m", &action, 1000)
        .unwrap();
    let second = store
        .record_provider_failure_action_for_interface("p", "responses", "k", "m", &action, 121000)
        .unwrap();
    assert!(first.available && second.available);
    assert_eq!(second.failure_streak, 2);
    assert!(!second.cooldown);
    assert!(
        store
            .scheduling_projection_for_key_with_interface(
                "p",
                "responses",
                "sibling",
                "m",
                1,
                1,
                121000
            )
            .unwrap()
            .available
    );
}

#[test]
fn tenth_mixed_failure_commits_one_hour_and_requires_owned_business_trial() {
    let store = V3ProviderHealthStore::default();
    let committed = record_mixed_failures(&store, "p", "responses", "k", "m", 1000, 10);
    assert_eq!(committed.failure_streak, 10);
    assert_eq!(committed.cooldown_until_ms, Some(3_601_009));
    store
        .record_provider_key_success_for_interface("p", "responses", "k", "m", 3_601_010)
        .unwrap();
    assert!(
        store
            .scheduling_projection_for_key_with_interface(
                "p",
                "responses",
                "k",
                "m",
                1,
                1,
                3_601_010
            )
            .unwrap()
            .available,
        "an expired episode is eligible, but ordinary success does not remove it"
    );
    assert!(!store.cooldown_entries(3_601_010).is_empty());
    let routecodex_v3_provider_responses::V3ProviderBusinessRecoveryAcquisition::Acquired(trial) =
        store
            .acquire_provider_business_recovery_trial_for_interface(
                "p",
                "responses",
                Some("k"),
                Some("m"),
                3_601_010,
            )
            .unwrap()
    else {
        panic!("the expired episode must grant a business recovery trial");
    };
    assert!(
        !store
            .availability_for_interface("p", "responses", Some("k"), Some("m"), 3_601_010)
            .available
    );
    assert!(store
        .complete_provider_business_recovery_success_with_permit(&trial, 3_601_011)
        .unwrap());
    assert!(
        store
            .availability_for_interface("p", "responses", Some("k"), Some("m"), 3_601_011)
            .available,
        "the current owned business success clears the hour lock"
    );
    assert!(store.cooldown_entries(3_601_011).is_empty());
}

#[test]
fn early_qualified_success_cannot_shorten_429_minimum() {
    let store = V3ProviderHealthStore::default();
    let cooled = record_mixed_failures(&store, "p", "responses", "k", "m", 1_000, 10);
    assert_eq!(cooled.cooldown_until_ms, Some(3_601_009));

    // A matching business success resets only the unresolved streak; it
    // cannot shorten the committed one-hour minimum.
    store
        .record_provider_key_success_for_interface("p", "responses", "k", "m", 2_000)
        .unwrap();
    let probe = store
        .acquire_provider_cooldown_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .unwrap()
        .expect("cooldown owns the physical probe slot");
    store
        .complete_provider_cooldown_probe_success_with_permit(&probe, 2_000)
        .unwrap();
    assert!(
        !store
            .availability_for_interface("p", "responses", Some("k"), Some("m"), 2_001)
            .available,
        "an early qualified probe success cannot shorten the 429 minimum"
    );
    assert!(
        !store
            .availability_for_interface("p", "responses", Some("k"), Some("m"), 3_601_008)
            .available,
        "the minimum must remain exclusive until its boundary"
    );

    let probe = store
        .acquire_provider_cooldown_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .unwrap()
        .expect("minimum expiry leaves the current physical probe available");
    store
        .complete_provider_cooldown_probe_success_with_permit(&probe, 3_601_009)
        .unwrap();
    assert!(
        store
            .availability_for_interface("p", "responses", Some("k"), Some("m"), 3_601_009)
            .available,
        "a current qualified probe restores at the minimum boundary"
    );
}

#[test]
fn probe_http_503_changes_only_probe_cadence() {
    let store = V3ProviderHealthStore::default();
    record_mixed_failures(&store, "p", "responses", "k", "m", 1_000, 10);
    let permit = store
        .acquire_provider_cooldown_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .unwrap()
        .expect("hour lock owns the physical probe slot");
    let action_503 = real_http_provider_action(503, "service_unavailable");
    assert_eq!(
        store
            .record_provider_rate_limit_probe_status_with_permit(
                &permit,
                503,
                &action_503,
                3_601_001,
            )
            .unwrap(),
        V3ProviderRateLimitProbeDisposition::Retained,
        "a non-2xx probe failure must remain a probe-failure outcome"
    );
    assert!(
        !store
            .availability_for_interface("p", "responses", Some("k"), Some("m"), 3_601_002)
            .available,
        "a 503 probe result must not publish a healthy interval"
    );
    assert!(
        store
            .has_provider_cooldown_probe_pending_for_interface(
                "p",
                "responses",
                Some("k"),
                Some("m"),
            )
            .unwrap(),
        "the provider remains excluded while its typed failure path owns recovery"
    );
    assert!(
        store
            .availability_for_interface("p", "responses", Some("sibling"), Some("m"), 3_601_002)
            .available,
        "a sibling identity is not affected"
    );
    // A failed probe changes cadence only; business success still cannot
    // release the committed cooldown.
    store
        .record_provider_key_success_for_interface("p", "responses", "k", "m", 3_601_002)
        .unwrap();
    assert!(
        !store
            .availability_for_interface("p", "responses", Some("k"), Some("m"), 3_601_003)
            .available,
        "a 503 probe result must not release the shared lock through business success"
    );
    assert!(store
        .provider_cooldown_probe_keys_due(3_611_000)
        .unwrap()
        .is_empty());
    let current = store
        .acquire_provider_cooldown_probe_if_due_for_interface(
            "p",
            "responses",
            Some("k"),
            Some("m"),
            3_611_001,
        )
        .unwrap()
        .expect("the failed probe advances only its cadence");
    store
        .complete_provider_cooldown_probe_success_with_permit(&current, 3_611_001)
        .unwrap();
    assert!(
        store
            .availability_for_interface("p", "responses", Some("k"), Some("m"), 3_611_001)
            .available
    );
}

#[test]
fn stale_probe_permit_cannot_clear_429_lock() {
    let store = V3ProviderHealthStore::default();
    let action_429 = real_http_429_action();
    record_mixed_failures(&store, "p", "responses", "k", "m", 1_000, 10);
    let stale = store
        .acquire_provider_cooldown_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .unwrap()
        .expect("hour lock owns the physical probe slot");
    store
        .record_provider_failure_action_for_interface(
            "p",
            "responses",
            "k",
            "m",
            &action_429,
            3_602_000,
        )
        .unwrap();
    let action_503 = real_http_provider_action(503, "service_unavailable");
    assert_eq!(
        store
            .record_provider_rate_limit_probe_status_with_permit(
                &stale,
                503,
                &action_503,
                3_602_001,
            )
            .unwrap(),
        V3ProviderRateLimitProbeDisposition::Superseded,
        "a stale acquisition cannot reclassify or clear the current 429 state"
    );
    store
        .record_provider_key_success_for_interface("p", "responses", "k", "m", 3_602_002)
        .unwrap();
    assert!(
        !store
            .availability_for_interface("p", "responses", Some("k"), Some("m"), 3_602_003)
            .available,
        "the current hour lock survives a stale permit and business success"
    );
    store.cancel_provider_cooldown_probe(&stale).unwrap();
    let current = store
        .acquire_provider_cooldown_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .unwrap()
        .expect("stale completion releases the physical probe slot");
    store
        .complete_provider_cooldown_probe_success_with_permit(&current, 3_601_009)
        .unwrap();
    assert!(
        store
            .availability_for_interface("p", "responses", Some("k"), Some("m"), 3_601_009)
            .available,
        "only the current qualified probe clears the remaining lock"
    );
}

#[test]
fn sustained_429_lock_and_minimum_round_trip_scoped_persistence() {
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.p]
type = "responses"
base_url = "http://provider.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "k", priority = 1 }]
"#,
        )
        .expect("parse manifest authoring"),
    )
    .expect("compile manifest");
    let path = std::env::temp_dir().join(format!(
        "routecodex-429-window-scoped-persistence-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let store = V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path.clone());
    let action = real_http_429_action();
    for now in 1_000..1_009 {
        store
            .record_provider_failure_action_for_interface("p", "default", "k", "m", &action, now)
            .unwrap();
    }
    store
        .flush_persistence()
        .expect("flush partial 429 episode");
    drop(store);
    let store = V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path.clone());
    let tenth = store
        .record_provider_failure_action("p", "k", "m", &action, 121_000)
        .unwrap();
    assert_eq!(tenth.cooldown_until_ms, Some(136_000));
    store.flush_persistence().expect("flush short 429 cooldown");
    drop(store);
    let store = V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path.clone());
    assert!(
        !store
            .scheduling_projection("p", "k", "m", 1, 1, 135_999)
            .unwrap()
            .available
    );
    assert!(
        store
            .scheduling_projection("p", "k", "m", 1, 1, 136_000)
            .unwrap()
            .available
    );
    assert!(store
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .is_none());
    store
        .record_provider_failure_action("p", "k", "m", &action, 136_000)
        .unwrap();
    store.flush_persistence().expect("flush scoped persistence");
    drop(store);
    let episodes = V3ProviderCooldownCoordinator::load(path.clone())
        .unwrap()
        .persisted_rate_limit_episodes();
    assert_eq!(episodes.len(), 1);
    let (key, episode) = &episodes[0];
    assert_eq!(key.provider_id, "p");
    assert_eq!(key.interface_id, "default");
    assert_eq!(key.auth_alias.as_deref(), Some("k"));
    assert_eq!(key.model_id.as_deref(), Some("m"));
    assert_eq!(episode.failure_count, 11);
    assert_eq!(episode.real_429_count, 11);
    assert_eq!(episode.first_429_at_ms, Some(1_000));
    assert_eq!(episode.last_429_at_ms, Some(136_000));
    let hour_end = 3_736_000;
    assert_eq!(episode.not_before_ms, Some(hour_end));
    assert!(episode.probe_required);

    let restored =
        V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path.clone());
    assert!(
        restored
            .has_provider_cooldown_probe_pending_for_interface(
                "p", "default", Some("k"), Some("m"),
            )
            .unwrap(),
        "the restored exclusion keeps a probe schedule without restoring an active permit"
    );
    restored
        .record_provider_key_success_for_interface("p", "default", "k", "m", hour_end - 2)
        .unwrap();
    assert!(
        !restored
            .availability_for_interface("p", "default", Some("k"), Some("m"), hour_end - 1)
            .available,
        "the persisted hour lock survives a business success"
    );
    let probe = restored
        .acquire_provider_cooldown_probe_for_interface("p", "default", Some("k"), Some("m"))
        .unwrap()
        .expect("the restored lock exposes a fresh current probe");
    restored
        .complete_provider_cooldown_probe_success_with_permit(&probe, hour_end)
        .unwrap();
    assert!(
        restored
            .availability_for_interface("p", "default", Some("k"), Some("m"), hour_end)
            .available,
        "only the restored current qualified probe clears the persisted lock"
    );
    restored.flush_persistence().unwrap();
    drop(restored);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn health_projection_without_history_uses_contract_default_score() {
    let store = V3ProviderKeyHealthStore::default();
    let projection = store
        .scheduling_projection("provider-a", "key-a", "model-a", 100, 1, 100)
        .expect("initial projection");
    assert_eq!(projection.score_milli, 100);
}

#[test]
fn matching_business_success_resets_only_its_subthreshold_streak() {
    use routecodex_v3_provider_responses::V3ProviderAvailabilityReader;
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("provider_transport_error");
    for (interface, key, model) in [
        ("default", "a", "m"),
        ("default", "b", "m"),
        ("default", "a", "other"),
        ("chat", "a", "m"),
    ] {
        let failure = store
            .record_provider_failure_action_for_interface("p", interface, key, model, &action, 100)
            .unwrap();
        assert!(failure.available);
        assert!(!failure.cooldown);
    }
    let recovered = store
        .record_provider_key_success_for_interface("p", "default", "a", "m", 101)
        .unwrap();
    assert!(
        recovered.available && !recovered.cooldown,
        "matching real business success must reset only its exact subthreshold streak: {recovered:?}"
    );
    assert_eq!(recovered.failure_streak, 0);
    for (interface, key, model) in [
        ("default", "b", "m"),
        ("default", "a", "other"),
        ("chat", "a", "m"),
    ] {
        assert!(
            store
                .availability_for_interface("p", interface, Some(key), Some(model), 101)
                .available,
            "a different identity keeps its own subthreshold streak: {interface}/{key}/{model}"
        );
    }
}

#[test]
fn hs01_configured_and_unseen_identities_start_at_score_100() {
    let unseen = V3ProviderKeyHealthStore::default();
    let unseen_projection = unseen
        .scheduling_projection("provider-a", "key-a", "model-a", 3, 2, 100)
        .expect("unseen identity projection");
    assert_eq!(unseen_projection.priority, 3);
    assert_eq!(unseen_projection.effective_priority, 3);
    assert_eq!(unseen_projection.score_milli, 100);
    assert_eq!(unseen_projection.effective_weight_milli, 200);

    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.p]
type = "responses"
base_url = "http://provider.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "a", env = "KEY" }] }
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "a", priority = 1 }]
"#,
        )
        .expect("parse manifest authoring"),
    )
    .expect("compile manifest");
    let configured = V3ProviderHealthStore::from_manifest_without_persistence(&manifest);
    let configured_projection = configured
        .scheduling_projection("p", "a", "m", 1, 3, 100)
        .expect("configured identity projection");
    assert_eq!(configured_projection.priority, 1);
    assert_eq!(configured_projection.effective_priority, 1);
    assert_eq!(configured_projection.score_milli, 100);
    assert_eq!(configured_projection.effective_weight_milli, 300);
}

#[test]
fn hs02_score_is_clamped_per_event_without_hidden_credit() {
    let store = V3ProviderKeyHealthStore::default();
    for now_ms in 0..100 {
        store
            .record_provider_key_success("p", "k", "m", now_ms)
            .expect("success");
    }
    assert_eq!(
        store
            .scheduling_projection("p", "k", "m", 100, 1, 100)
            .expect("capped projection")
            .score_milli,
        150
    );

    store
        .record_provider_failure_action(
            "p",
            "k",
            "m",
            &V3ProviderFailureAction::recoverable("transport"),
            100,
        )
        .expect("deduction after saturation");
    assert_eq!(
        store
            .scheduling_projection("p", "k", "m", 100, 1, 100)
            .expect("post-deduction projection")
            .score_milli,
        145
    );

    let exhausted = V3ProviderKeyHealthStore::default();
    let failure = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 0..21 {
        exhausted
            .record_provider_failure_action("p", "k", "m", &failure, now_ms)
            .expect("failure");
    }
    assert_eq!(
        exhausted
            .scheduling_projection("p", "k", "m", 100, 1, 21)
            .expect("exhausted projection")
            .score_milli,
        0
    );
}

#[test]
fn hs03_zero_score_does_not_independently_cool_exact_key() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction {
        recovery: V3ProviderRecoveryKind::RecoverableCounted,
        scope: routecodex_v3_provider_responses::V3ProviderHealthScope::GlobalProviderKey,
        score_delta_milli: -100,
        failure_threshold: 1,
        cooldown_ms: 5_000,
        long_probe_backoff: false,
        advisory_probe: false,
        class_code: "transport".to_string(),
        failure_fingerprint: None,
    };

    let zero = store
        .record_provider_failure_action("p", "k", "m", &action, 100)
        .expect("zero-score failure");
    assert_eq!(zero.score_milli, 0);
    assert!(!zero.cooldown);
    assert!(zero.available);
    for (provider, key, model) in [("p", "sibling-key", "m"), ("p", "k", "sibling-model")] {
        let sibling = store
            .scheduling_projection(provider, key, model, 100, 1, 100)
            .expect("sibling projection");
        assert_eq!(sibling.score_milli, 100);
        assert!(sibling.available);
    }

    for now_ms in 101..109 {
        store
            .record_provider_failure_action("p", "k", "m", &action, now_ms)
            .expect("shared threshold failure");
    }
    let committed = store
        .record_provider_failure_action("p", "k", "m", &action, 109)
        .expect("tenth shared failure");
    assert!(committed.cooldown);
    assert!(!committed.available);
    assert_eq!(committed.cooldown_until_ms, Some(3_600_109));
}

#[test]
fn thresholded_failures_require_consecutive_streak_with_neutral_baseline() {
    // The neutral baseline is 100 for every configured priority. A thresholded
    // recoverable failure must still wait for `failure_threshold` consecutive
    // failures instead of cooling down after one transient error.
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.p]
type = "responses"
base_url = "http://provider.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "a", env = "KEY" }] }
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "a", priority = 1 }]
"#,
        )
        .expect("parse manifest authoring"),
    )
    .expect("compile manifest");
    let store = V3ProviderHealthStore::from_manifest_without_persistence(&manifest);
    let action = V3ProviderFailureAction::recoverable("provider_502");

    let first = store
        .record_provider_failure_action("p", "a", "m", &action, 100)
        .expect("first recoverable failure");
    assert_eq!(first.score_milli, 95);
    assert!(
        !first.cooldown,
        "one thresholded failure must not cool down a low-priority key"
    );
    assert!(first.available);
    assert!(store
        .provider_cooldown_probe_keys(100, false)
        .expect("probe keys after first failure")
        .is_empty());
    let first_scheduling = store
        .scheduling_projection("p", "a", "m", 1, 1, 100)
        .expect("first scheduling projection");
    assert!(
        first_scheduling.available,
        "a reduced score without a cooldown must remain schedulable"
    );
    assert_eq!(first_scheduling.score_milli, 95);
    assert_eq!(first_scheduling.effective_weight_milli, 95);
    assert!(first_scheduling.blocked_scopes.is_empty());

    for now_ms in 101..109 {
        store
            .record_provider_failure_action("p", "a", "m", &action, now_ms)
            .expect("shared threshold failure");
    }
    let tenth = store
        .record_provider_failure_action("p", "a", "m", &action, 109)
        .expect("tenth recoverable failure");
    assert!(
        tenth.cooldown,
        "the shared threshold must cool the key down"
    );
    assert!(!tenth.available);
    let tenth_scheduling = store
        .scheduling_projection("p", "a", "m", 1, 1, 109)
        .expect("tenth scheduling projection");
    assert!(!tenth_scheduling.available);
    assert_eq!(
        tenth_scheduling.blocked_scopes,
        vec!["provider_key_health_cooldown".to_string()]
    );
}

#[test]
fn recoverable_failure_cools_after_repeat_without_changing_score_contract() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");

    let first = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 100)
        .expect("first failure");
    assert_eq!(first.score_milli, 95);
    assert_eq!(first.success_streak, 0);
    assert!(first.available);
    assert!(!first.cooldown);
    for now_ms in 101..109 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("shared threshold failure");
    }
    let first_committed = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 109)
        .expect("tenth failure");
    assert!(first_committed.cooldown);
    assert_eq!(first_committed.cooldown_until_ms, Some(3_600_109));
    let first_probe = store
        .provider_cooldown_probe_keys_due(5_108)
        .expect("probe due query");
    assert!(first_probe.is_empty(), "probe must wait for its cadence");
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(5_109)
            .expect("probe due query"),
        vec![(
            "provider-a".into(),
            Some("key-a".into()),
            Some("model-a".into())
        )]
    );
    let probe = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("probe acquisition")
        .expect("current probe permit");
    store
        .complete_provider_cooldown_probe_success_with_permit(&probe, 3_600_109)
        .expect("probe success must restore exact identity");
    let second = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 3_600_110)
        .expect("repeated failure");
    assert_eq!(second.score_milli, 95);
    assert!(second.available);
    assert!(!second.cooldown);
    assert_eq!(second.failure_streak, 1);
}

#[test]
fn dynamic_probe_ladder_starts_at_5s_after_the_first_cooldown() {
    let store = V3ProviderHealthStore::default();
    let session = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
        .expect("session scope");
    let policy = V3ProviderFailurePolicy {
        cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
        ..Default::default()
    };
    for now_ms in 100..109 {
        store
            .record_provider_failure_in_session_with_policy(
                &session,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                Some("transport"),
                None,
                now_ms,
                Some(policy),
            )
            .expect("same-key failure");
    }
    store
        .record_provider_failure_in_session_with_policy(
            &session,
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            Some("transport"),
            None,
            109,
            Some(policy),
        )
        .expect("tenth same-key failure");

    assert!(store
        .provider_cooldown_probe_keys_due(5_108)
        .expect("probe due query")
        .is_empty());
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(5_109)
            .expect("probe due query"),
        vec![(
            "provider-a".into(),
            Some("key-a".into()),
            Some("model-a".into()),
        )]
    );
}

#[test]
fn mixed_recoverable_fingerprints_do_not_share_an_identity() {
    // The complete provider identity owns one shared recoverable streak.
    // Fingerprints remain evidence only, while model remains an identity
    // boundary.
    let store = V3ProviderHealthStore::default();
    let session = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
        .expect("session scope");
    let policy = V3ProviderFailurePolicy {
        cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
        ..Default::default()
    };
    let fingerprint = |status: u16| {
        build_v3_provider_global_error_fingerprint(status)
            .expect("classification")
            .expect("fingerprint")
    };
    let record = |model_id: &'static str, status: u16, now_ms: u64| {
        store
            .record_provider_failure_in_session_with_policy(
                &session,
                "provider-a",
                Some("key-a"),
                Some(model_id),
                Some("transport"),
                Some(fingerprint(status)),
                now_ms,
                Some(policy),
            )
            .expect("recoverable failure")
    };
    // Different statuses on different identities remain isolated.
    record("model-a", 500, 100);
    record("model-b", 502, 101);
    record("model-c", 503, 102);
    for model_id in ["model-a", "model-b", "model-c"] {
        assert!(
            store
                .availability_for_session(
                    &session,
                    "provider-a",
                    Some("key-a"),
                    Some(model_id),
                    102,
                )
                .available,
            "{model_id} must stay available: distinct recoverable fingerprints must not sum into a cooldown"
        );
    }
    assert!(
        store
            .provider_cooldown_probe_keys_due(102)
            .expect("probe due query")
            .is_empty(),
        "no exact identity cooldown probe may be scheduled before three same-fingerprint failures"
    );
    for index in 0..7 {
        record("model-a", [500, 502, 503][index % 3], 200 + index as u64);
    }
    for (model_id, expected) in [("model-a", true), ("model-b", true), ("model-c", true)] {
        assert_eq!(
            store
                .availability_for_session(
                    &session,
                    "provider-a",
                    Some("key-a"),
                    Some(model_id),
                    206,
                )
                .available,
            expected,
            "exact provider+key+model identity isolation: model={model_id}"
        );
    }
    record("model-a", 500, 207);
    record("model-a", 502, 208);
    record("model-a", 503, 209);
    assert!(
        !store
            .availability_for_session(&session, "provider-a", Some("key-a"), Some("model-a"), 209,)
            .available
    );
    assert!(
        store
            .availability_for_session(&session, "provider-a", Some("key-a"), Some("model-b"), 209,)
            .available
    );
}

#[test]
fn session_scoped_recoverable_failures_do_not_create_global_key_cooldown() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable_session("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("session-scoped failure");
    }

    let projection = store
        .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, 120)
        .expect("session-scoped projection");
    assert_eq!(projection.score_milli, 0);
    assert!(projection.available);
    assert_eq!(projection.blocked_scopes, Vec::<String>::new());
    assert!(store
        .provider_cooldown_probe_keys(120, false)
        .expect("session-scoped actions must not create a global probe")
        .is_empty());
}

#[test]
fn disabled_health_does_not_record_global_failure_actions() {
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.p]
type = "responses"
base_url = "http://provider.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
health = { enabled = false, failure_threshold = 1, cooldown_ms = 1 }
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "k", priority = 1 }]
"#,
        )
        .expect("parse manifest authoring"),
    )
    .expect("compile manifest");
    let store = V3ProviderHealthStore::from_manifest_without_persistence(&manifest);

    for (reason, now_ms) in [("provider_429", 100), ("provider_502", 101)] {
        let projection = store
            .record_provider_failure_action(
                "p",
                "k",
                "m",
                &V3ProviderFailureAction::recoverable(reason),
                now_ms,
            )
            .expect("disabled health failure action");
        assert_eq!(projection.score_milli, 100);
        assert_eq!(projection.failure_streak, 0);
        assert!(!projection.cooldown);
        assert!(projection.available);
    }

    let projection = store
        .scheduling_projection("p", "k", "m", 1, 1, 102)
        .expect("disabled health projection");
    assert_eq!(projection.score_milli, 100);
    assert!(projection.available);
    assert!(store
        .provider_cooldown_probe_keys(102, false)
        .expect("disabled health probe keys")
        .is_empty());
}

#[test]
fn matching_business_success_resets_streak_but_not_committed_cooldown() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..110 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("failure");
    }

    // A validated matching business success resets the unresolved streak but
    // cannot release the committed one-hour minimum.
    let revived = store
        .record_provider_key_success("provider-a", "key-a", "model-a", 120)
        .expect("success revival");
    assert!(
        !revived.available,
        "matching business success must not release an active committed cooldown"
    );
    assert!(revived.cooldown);
    assert_eq!(revived.failure_streak, 0);
    assert_eq!(revived.success_streak, 1);
    assert_eq!(revived.score_milli, 51);

    let probe = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("probe acquisition")
        .expect("current probe permit");
    store
        .complete_provider_cooldown_probe_success_with_permit(&probe, 3_600_109)
        .expect("probe success");
    let probe_recovered = store
        .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, 3_600_109)
        .expect("probe recovery projection");
    assert!(probe_recovered.available);
    let post_probe_success = store
        .record_provider_key_success("provider-a", "key-a", "model-a", 122)
        .expect("post-probe success");
    assert_eq!(post_probe_success.score_milli, 101);
}

#[test]
fn health_score_accumulates_each_event_without_a_rolling_window() {
    let store = V3ProviderHealthStore::default();
    let failure = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 0..20 {
        store
            .record_provider_failure_action("p", "k", "m", &failure, now_ms)
            .expect("failure");
    }
    let before = store
        .scheduling_projection("p", "k", "m", 100, 1, 20)
        .expect("projection");
    assert_eq!(before.score_milli, 0);
    let success = store
        .record_provider_key_success("p", "k", "m", 21)
        .expect("success");
    // No rolling window exists: the success applies its +1 delta directly to
    // the clamped score, independently of releasing the exact cooldown.
    assert_eq!(success.score_milli, 1);
    assert_eq!(success.failure_streak, 0);
    for now_ms in 22..171 {
        store
            .record_provider_key_success("p", "k", "m", now_ms)
            .expect("success");
    }
    let after = store
        .scheduling_projection("p", "k", "m", 100, 1, 171)
        .expect("projection");
    assert_eq!(after.score_milli, 150);
}

#[test]
fn health_score_ignores_configured_priority_as_its_baseline() {
    let store = V3ProviderHealthStore::default();
    let failure = V3ProviderFailureAction::recoverable("provider_502");
    let initial = store
        .scheduling_projection("p", "k", "m", 80, 1, 100)
        .expect("initial projection");
    assert_eq!(initial.score_milli, 100);

    store
        .record_provider_failure_action("p", "k", "m", &failure, 101)
        .expect("recoverable failure");
    let after_failure = store
        .scheduling_projection("p", "k", "m", 80, 1, 102)
        .expect("projection after failure");
    assert_eq!(after_failure.score_milli, 95);
}

#[test]
fn two_502_failures_enter_cooldown() {
    let store = V3ProviderHealthStore::default();
    store
        .scheduling_projection("p", "k", "m", 100, 1, 100)
        .expect("initial projection");
    let action = V3ProviderFailureAction::recoverable("provider_502");

    let first = store
        .record_provider_failure_action("p", "k", "m", &action, 101)
        .expect("first 502 failure");
    assert!(!first.cooldown);
    assert!(first.available);
    assert_eq!(
        store
            .scheduling_projection("p", "k", "m", 100, 1, 102)
            .unwrap()
            .score_milli,
        95
    );

    for now_ms in 102..110 {
        store
            .record_provider_failure_action("p", "k", "m", &action, now_ms)
            .expect("shared threshold failure");
    }
    let tenth = store
        .record_provider_failure_action("p", "k", "m", &action, 110)
        .expect("tenth 502 failure");
    assert!(tenth.cooldown);
    assert_eq!(tenth.cooldown_until_ms, Some(3_600_110));
}

#[test]
fn successful_calls_cap_health_at_150() {
    let store = V3ProviderHealthStore::default();
    for now_ms in 0..100 {
        store
            .record_provider_key_success("p", "k", "m", now_ms)
            .expect("success");
    }
    assert_eq!(
        store
            .scheduling_projection("p", "k", "m", 100, 1, 100)
            .unwrap()
            .score_milli,
        150
    );
}

#[test]
fn success_streak_increments_and_failure_resets_it() {
    let store = V3ProviderKeyHealthStore::default();
    let first = store
        .record_provider_key_success("provider-a", "key-a", "model-a", 100)
        .unwrap();
    let second = store
        .record_provider_key_success("provider-a", "key-a", "model-a", 101)
        .unwrap();
    assert_eq!(first.success_streak, 1);
    assert_eq!(second.success_streak, 2);

    let failure = store
        .record_provider_failure_action(
            "provider-a",
            "key-a",
            "model-a",
            &V3ProviderFailureAction::recoverable("transport"),
            102,
        )
        .unwrap();
    assert_eq!(failure.success_streak, 0);
}

#[test]
fn health_score_does_not_change_configured_priority_or_weight() {
    let healthy = V3ProviderSchedulingProjection::new(
        "provider-a",
        "default",
        "key-a",
        "model-a",
        1,
        1000,
        100,
    );
    let degraded = V3ProviderSchedulingProjection::new(
        "provider-b",
        "default",
        "key-b",
        "model-b",
        1,
        500,
        100,
    );
    let lower_priority = V3ProviderSchedulingProjection::new(
        "provider-c",
        "default",
        "key-c",
        "model-c",
        2,
        1000,
        100,
    );

    assert_eq!(
        healthy.effective_weight_milli,
        degraded.effective_weight_milli
    );
    assert_eq!(healthy.priority, degraded.priority);
    assert_eq!(healthy.effective_priority, degraded.effective_priority);
    assert!(lower_priority.priority > healthy.priority);
    assert!(lower_priority.effective_priority > healthy.effective_priority);
}

#[test]
fn health_score_preserves_configured_priority() {
    let healthy = V3ProviderSchedulingProjection::new(
        "provider-a",
        "default",
        "key-a",
        "model-a",
        10,
        1_020,
        1,
    );
    let degraded = V3ProviderSchedulingProjection::new(
        "provider-b",
        "default",
        "key-b",
        "model-b",
        10,
        900,
        1,
    );

    assert_eq!(healthy.effective_priority, 10);
    assert_eq!(degraded.effective_priority, 10);
}

#[test]
fn health_score_controls_weight_without_changing_priority_bucket() {
    let store = V3ProviderHealthStore::default();
    store
        .scheduling_projection("provider-a", "key-a", "model-a", 100, 1, 100)
        .expect("initial projection");
    store
        .record_provider_failure_action(
            "provider-a",
            "key-a",
            "model-a",
            &V3ProviderFailureAction::recoverable("provider_502"),
            101,
        )
        .expect("recoverable failure");
    let degraded = store
        .scheduling_projection("provider-a", "key-a", "model-a", 100, 1, 102)
        .expect("degraded projection");
    assert_eq!(degraded.effective_priority, 100);
    assert_eq!(degraded.score_milli, 95);
    assert_eq!(degraded.effective_weight_milli, 95);
}

#[test]
fn extreme_positive_health_score_preserves_configured_priority() {
    let projection = V3ProviderSchedulingProjection::new(
        "provider-a",
        "default",
        "key-a",
        "model-a",
        10,
        5_000,
        1,
    );

    assert_eq!(projection.effective_priority, 10);
}

#[test]
fn odd_configured_priorities_are_not_health_adjusted() {
    let priority_one = V3ProviderSchedulingProjection::new(
        "provider-a",
        "default",
        "key-a",
        "model-a",
        1,
        5_000,
        1,
    );
    let priority_three = V3ProviderSchedulingProjection::new(
        "provider-b",
        "default",
        "key-b",
        "model-b",
        3,
        5_000,
        1,
    );

    assert_eq!(priority_one.effective_priority, 1);
    assert_eq!(priority_three.effective_priority, 3);
}

#[test]
fn zero_configured_priority_is_not_health_adjusted() {
    let projection = V3ProviderSchedulingProjection::new(
        "provider-a",
        "default",
        "key-a",
        "model-a",
        0,
        5_000,
        1,
    );

    assert_eq!(projection.effective_priority, 0);
}

#[test]
fn score_zero_keeps_a_positive_minimum_scheduling_weight() {
    let projection =
        V3ProviderSchedulingProjection::new("provider-a", "default", "key-a", "model-a", 1, 0, 7);
    assert_eq!(projection.effective_weight_milli, 7);
    assert!(projection.available);
}

#[test]
fn transient_failure_preserves_configured_priority_recovery_path() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    let failed = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 100)
        .expect("failure");

    assert_eq!(failed.score_milli, 95);
    let scheduling = store
        .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, 100)
        .expect("scheduling projection");
    assert_eq!(scheduling.effective_priority, 1);
}

#[test]
fn health_neutral_action_does_not_change_score_or_cooldown() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction {
        recovery: V3ProviderRecoveryKind::HealthNeutralTransient,
        ..V3ProviderFailureAction::recoverable("sse_stall")
    };
    let result = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 100)
        .expect("health neutral");
    assert_eq!(result.score_milli, 100);
    assert_eq!(result.score_generation, 0);
    assert!(!result.cooldown);
    assert!(result.available);
}

#[test]
fn cooldown_expiry_only_opens_probe_and_probe_failure_reschedules() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("failure");
    }
    let expired = store
        .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, 900_103)
        .expect("projection");
    assert!(!expired.available);
    let rescheduled = store
        .complete_probe_failure("provider-a", "key-a", "model-a", 900_104, 900_000)
        .expect("probe failure");
    assert!(rescheduled.cooldown);
    assert!(!rescheduled.available);
}

#[test]
fn recoverable_key_probe_is_single_flight_and_global_probe_is_not_duplicated() {
    let store = V3ProviderKeyHealthStore::default();
    let recoverable = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &recoverable, now_ms)
            .expect("recoverable failure");
    }
    let irrecoverable = V3ProviderFailureAction {
        recovery: V3ProviderRecoveryKind::IrrecoverableGlobalCooldown,
        scope: routecodex_v3_provider_responses::V3ProviderHealthScope::GlobalProviderKey,
        score_delta_milli: -20,
        failure_threshold: 0,
        cooldown_ms: 60_000,
        long_probe_backoff: false,
        advisory_probe: false,
        class_code: "invalid_api_key".to_string(),
        failure_fingerprint: None,
    };
    store
        .record_provider_failure_action("provider-b", "key-b", "model-b", &irrecoverable, 100)
        .expect("irrecoverable failure");
    let globally_blocked = store
        .scheduling_projection("provider-b", "key-b", "model-b", 1, 1, 100)
        .expect("global cooldown projection");
    assert!(!globally_blocked.available);
    let global_probe = store
        .acquire_provider_cooldown_probe("provider-b", Some("key-b"), Some("model-b"))
        .expect("global probe acquisition")
        .expect("global probe permit");
    assert!(store
        .complete_provider_cooldown_probe_success_if_current_with_permit(&global_probe, 3_600_100)
        .expect("global probe success"));
    let globally_recovered = store
        .scheduling_projection("provider-b", "key-b", "model-b", 1, 1, 3_600_100)
        .expect("global recovery projection");
    assert!(globally_recovered.available);

    let startup_keys = store
        .provider_cooldown_probe_keys(0, true)
        .expect("startup probe candidates");
    assert_eq!(
        startup_keys,
        vec![(
            "provider-a".into(),
            Some("key-a".into()),
            Some("model-a".into())
        )]
    );
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("probe acquisition")
        .expect("first probe owns key");
    assert!(store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("single-flight check")
        .is_none());
    store
        .complete_provider_cooldown_probe_success_with_permit(&permit, 104)
        .expect("probe success");
}

#[test]
fn stale_probe_generation_cannot_clear_newer_failure_state() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("failure");
    }
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("probe acquisition")
        .expect("probe permit");
    store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 103)
        .expect("newer failure");
    store
        .complete_provider_cooldown_probe_success_with_permit(&permit, 104)
        .expect("stale probe completion is ignored without clearing newer state");
    assert!(store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("stale completion releases single-flight permit")
        .is_some());
}

#[test]
fn stale_failed_probe_cannot_mutate_newer_failure_state() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("failure");
    }
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("probe acquisition")
        .expect("probe permit");
    let newer = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 103)
        .expect("newer failure");

    store
        .complete_provider_cooldown_probe_failure_with_permit(&permit, 104)
        .expect("stale failed-probe completion is ignored without mutating newer state");
    let after = store
        .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, 104)
        .expect("projection after stale failed probe");
    assert_eq!(after.score_milli, newer.score_milli);
    assert_eq!(after.score_generation, newer.score_generation);
    assert!(store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("stale completion releases single-flight permit")
        .is_some());
}

#[test]
fn account_error_reaches_cooldown_at_zero() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction {
        recovery: V3ProviderRecoveryKind::IrrecoverableGlobalCooldown,
        scope: routecodex_v3_provider_responses::V3ProviderHealthScope::GlobalProviderKey,
        score_delta_milli: -20,
        failure_threshold: 0,
        cooldown_ms: 60_000,
        long_probe_backoff: false,
        advisory_probe: false,
        class_code: "invalid_api_key".to_string(),
        failure_fingerprint: None,
    };
    for now_ms in 100..105 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("account failure");
    }
    let result = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 105)
        .expect("account failure");
    assert!(result.cooldown);
    assert!(!result.available);
    assert_eq!(result.score_milli, 0);
}

#[test]
fn score_and_cooldown_are_isolated_per_provider_key_and_model() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("failure");
    }

    let unaffected_auth_key = store
        .scheduling_projection("provider-a", "key-b", "model-a", 1, 1, 900_103)
        .expect("unaffected auth key");
    let same_key_different_model = store
        .scheduling_projection("provider-a", "key-a", "model-b", 1, 1, 900_103)
        .expect("same key on another model");
    let cooled_key = store
        .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, 900_103)
        .expect("cooled key");

    assert!(unaffected_auth_key.available);
    assert!(same_key_different_model.available);
    assert_eq!(same_key_different_model.score_milli, 100);
    assert!(!cooled_key.available);
}

#[test]
fn tenth_mixed_failure_only_commits_the_hour_for_non_429() {
    // Different recoverable fingerprints share one complete-identity streak.
    let store = V3ProviderKeyHealthStore::default();
    for (offset, status, expected_streak) in [(0, 429_u16, 1), (1, 500, 2), (2, 502, 3)] {
        let action = real_http_provider_action(status, "provider_http_error");
        let projection = store
            .record_provider_failure_action(
                "provider-a",
                "key-a",
                "model-a",
                &action,
                100 + offset as u64,
            )
            .expect("recoverable failure");
        assert_eq!(
            projection.failure_streak, expected_streak,
            "status={status}"
        );
        assert!(
            !projection.cooldown,
            "a different fingerprint must not extend the streak: status={status}"
        );
        assert!(projection.cooldown_until_ms.is_none(), "status={status}");
        assert!(projection.available, "status={status}");
    }

    record_mixed_failures(&store, "provider-a", "default", "key-a", "model-a", 200, 6);
    let tenth = store
        .record_provider_failure_action(
            "provider-a",
            "key-a",
            "model-a",
            &real_http_429_action(),
            206,
        )
        .unwrap();
    assert_eq!(tenth.failure_streak, 10);
    assert!(tenth.available);
    let committed = store
        .record_provider_failure_action(
            "provider-a",
            "key-a",
            "model-a",
            &real_http_provider_action(500, "provider_http_500"),
            207,
        )
        .unwrap();
    assert_eq!(committed.failure_streak, 11);
    assert!(committed.cooldown);
    assert!(!committed.available);
}

// 生产 builder 身份回归：5xx 保留真实上游状态，500 与 502 不能共用一条
// 连续失败序列；没有上游状态的失败落到失败类别，不同类别同样不同源。
#[test]
fn production_failure_actions_share_5xx_and_class_identity_streak() {
    let store = V3ProviderKeyHealthStore::default();
    let server_error = build_v3_provider_global_error_fingerprint(500)
        .expect("500 fingerprint classification")
        .expect("500 must reach global health");
    let gateway_error = build_v3_provider_global_error_fingerprint(502)
        .expect("502 fingerprint classification")
        .expect("502 must reach global health");
    assert_ne!(server_error, gateway_error);

    let mut action = V3ProviderFailureAction::recoverable("provider_http_error");
    for (offset, status) in [0_u64, 1, 2].into_iter().zip([500_u16, 502, 500]) {
        action.failure_fingerprint = Some(
            build_v3_provider_global_error_fingerprint(status)
                .expect("fingerprint classification")
                .expect("status must reach global health"),
        );
        let projection = store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, offset)
            .expect("alternating 5xx failure");
        assert_eq!(projection.failure_streak, offset as u32 + 1);
        assert!(!projection.cooldown, "alternating 500/502 must never cool");
    }

    // 类别回退身份：本地 decode 失败与 request compat 失败没有上游状态，但
    // 类别不同，不能合并成一条 streak。
    let sse_decode = V3ProviderFailureAction::recoverable("provider.sse_decode");
    let compat = V3ProviderFailureAction::recoverable("provider_request_compat_error");
    assert_ne!(sse_decode.failure_fingerprint, compat.failure_fingerprint);
    assert_eq!(
        sse_decode.failure_fingerprint.as_ref().unwrap().http_status,
        0
    );
    for (offset, action) in [(10_u64, &sse_decode), (11, &compat), (12, &sse_decode)] {
        let projection = store
            .record_provider_failure_action("provider-b", "key-b", "model-b", action, offset)
            .expect("mixed-class failure");
        assert_eq!(projection.failure_streak, offset as u32 - 9);
        assert!(!projection.cooldown);
    }
}

#[test]
fn provider_health_cooldown_is_isolated_between_interfaces() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action_for_interface(
                "provider-a",
                "responses",
                "key-a",
                "model-a",
                &action,
                now_ms,
            )
            .expect("interface failure");
    }

    let cooled_interface = store
        .scheduling_projection_for_key_with_interface(
            "provider-a",
            "responses",
            "key-a",
            "model-a",
            1,
            1,
            900_103,
        )
        .expect("cooled interface projection");
    let sibling_interface = store
        .scheduling_projection_for_key_with_interface(
            "provider-a",
            "chat",
            "key-a",
            "model-a",
            1,
            1,
            900_103,
        )
        .expect("sibling interface projection");

    assert!(!cooled_interface.available);
    assert!(sibling_interface.available);
    assert_eq!(sibling_interface.score_milli, 100);
}

#[test]
fn precool_observation_acquires_without_cooldown_score_or_fake_blocked_until() {
    let store = V3ProviderHealthStore::default();
    let permit = store
        .acquire_provider_precool_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .expect("acquire precool observation");
    let permit = permit.expect("healthy identity yields an observation permit");
    assert_eq!(permit.purpose(), V3ProviderProbePurpose::PrecoolObservation);
    assert!(store
        .provider_precool_observation_permit_is_current(&permit)
        .expect("current check"));
    // No cooldown entry, no schedule, no auth hold is created by observation.
    assert!(store
        .provider_cooldown_probe_keys_due(1_000_000)
        .expect("due keys")
        .is_empty());
    assert!(
        store
            .scheduling_projection_for_key_with_interface("p", "responses", "k", "m", 1, 1, 100)
            .expect("projection")
            .available
    );
    assert_eq!(
        store
            .scheduling_projection_for_key_with_interface("p", "responses", "k", "m", 1, 1, 100)
            .expect("projection")
            .score_milli,
        100,
        "observation must not change the score"
    );
    // A clean observation completion publishes only probe recovery. It cannot
    // fabricate a business receipt, score change or cooldown.
    assert_eq!(
        store
            .complete_provider_precool_observation_with_permit(&permit)
            .expect("complete observation"),
        V3ProviderPrecoolObservationOutcome::Completed
    );
    assert!(!store
        .provider_precool_observation_permit_is_current(&permit)
        .expect("permit closed"));
    let after = store
        .scheduling_projection_for_key_with_interface("p", "responses", "k", "m", 1, 1, 101)
        .expect("after projection");
    assert!(after.available);
    assert_eq!(after.score_milli, 100);
    assert_eq!(after.score_generation, 0);
    // A later real business success publishes its own normal +1 increment.
    assert_eq!(
        store
            .record_provider_key_success_for_interface("p", "responses", "k", "m", 101)
            .expect("success")
            .score_generation,
        1,
        "one real success counts once"
    );
}

#[test]
fn precool_observation_is_mutually_exclusive_with_cooldown_and_across_purposes() {
    let store = V3ProviderHealthStore::default();
    assert!(store
        .acquire_provider_precool_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .expect("first observation")
        .is_some());
    // Only one physical probe slot per complete identity.
    assert!(store
        .acquire_provider_precool_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .expect("second observation")
        .is_none());
    // A cooled identity cannot also open an observation, and vice versa.
    let mut action = V3ProviderFailureAction::recoverable("transport");
    action.failure_threshold = 1;
    store
        .record_provider_failure_action_for_interface("p", "responses", "k", "m", &action, 100)
        .expect("cool identity");
    // The held observation keeps the physical slot, so the cooldown probe for
    // the same complete identity cannot also claim it.
    assert!(store
        .acquire_provider_cooldown_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .expect("cooldown probe while observing")
        .is_none());
    assert!(store
        .acquire_provider_precool_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .expect("observation during cooldown")
        .is_none());
    // A sibling interface never conflicts with the held observation.
    assert!(store
        .acquire_provider_precool_probe_for_interface("p", "chat", Some("k"), Some("m"))
        .expect("sibling observation")
        .is_some());
}

#[test]
fn cancelled_precool_observation_releases_capacity_without_cooling() {
    let store = V3ProviderHealthStore::default();
    let permit = store
        .acquire_provider_precool_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .expect("acquire observation")
        .expect("permit");
    store
        .cancel_provider_cooldown_probe(&permit)
        .expect("cancel observation");
    assert!(!store
        .provider_precool_observation_permit_is_current(&permit)
        .expect("cancelled permit is not current"));
    assert!(store
        .provider_cooldown_probe_keys_due(1_000_000)
        .expect("due keys")
        .is_empty());
    let projection = store
        .scheduling_projection_for_key_with_interface("p", "responses", "k", "m", 1, 1, 200)
        .expect("projection after cancellation");
    assert!(projection.available);
    assert_eq!(projection.score_milli, 100);
    // The released slot is immediately usable by a fresh owner.
    assert!(store
        .acquire_provider_precool_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .expect("reacquire")
        .is_some());
}

#[test]
fn precool_observation_sibling_independence_and_stale_generation_protection() {
    let store = V3ProviderHealthStore::default();
    let a = store
        .acquire_provider_precool_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .expect("acquire a")
        .expect("permit a");
    let b = store
        .acquire_provider_precool_probe_for_interface("p", "responses", Some("k"), Some("n"))
        .expect("acquire b")
        .expect("permit b");
    assert!(store
        .provider_precool_observation_permit_is_current(&a)
        .expect("a current"));
    assert!(store
        .provider_precool_observation_permit_is_current(&b)
        .expect("b current"));
    // A real business success for A publishes a new availability generation and
    // invalidates A's held observation, but B keeps its slot.
    store
        .record_provider_key_success_for_interface("p", "responses", "k", "m", 200)
        .expect("success a");
    assert!(!store
        .provider_precool_observation_permit_is_current(&a)
        .expect("a superseded by success"));
    assert!(store
        .provider_precool_observation_permit_is_current(&b)
        .expect("b still current"));
    // Late completion of A cannot publish recovery; B still closes cleanly.
    assert_eq!(
        store
            .complete_provider_precool_observation_with_permit(&a)
            .expect("complete stale a"),
        V3ProviderPrecoolObservationOutcome::Superseded
    );
    assert_eq!(
        store
            .complete_provider_precool_observation_with_permit(&b)
            .expect("complete b"),
        V3ProviderPrecoolObservationOutcome::Completed
    );
    assert!(!store
        .provider_precool_observation_permit_is_current(&b)
        .expect("b closed"));
}

#[test]
fn precool_observation_replacement_cannot_be_released_by_older_permit() {
    let store = V3ProviderHealthStore::default();
    let a = store
        .acquire_provider_precool_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .expect("acquire a")
        .expect("permit a");
    // Cancel A; a fresh observation reuses the same identity.
    store.cancel_provider_cooldown_probe(&a).expect("cancel a");
    let b = store
        .acquire_provider_precool_probe_for_interface("p", "responses", Some("k"), Some("m"))
        .expect("acquire b")
        .expect("permit b");
    // The older permit is no longer authoritative and must not touch the slot.
    assert_eq!(
        store
            .complete_provider_precool_observation_with_permit(&a)
            .expect("complete stale a"),
        V3ProviderPrecoolObservationOutcome::Superseded
    );
    assert!(store
        .provider_precool_observation_permit_is_current(&b)
        .expect("b still owns the slot"));
    // Mixing purposes is rejected rather than fabricating recovery.
    assert!(matches!(
        store.complete_provider_cooldown_probe_success_with_permit(&b, 300),
        Err(routecodex_v3_provider_responses::V3ProviderHealthError::ProbePurposeMismatch)
    ));
}

#[test]
fn configured_advisory_probe_keeps_cadence_but_not_the_committed_minimum() {
    // Advisory probe scheduling does not change the shared lock. It only keeps
    // failed recovery probes at their base cadence.
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.p]
type = "responses"
base_url = "http://provider.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
health = { enabled = true, failure_threshold = 1, cooldown_ms = 5000, advisory_probe = true }
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "k", priority = 1 }]
"#,
        )
        .expect("parse manifest authoring"),
    )
    .expect("compile manifest");
    let store = V3ProviderHealthStore::from_manifest_without_persistence(&manifest);
    assert!(
        store
            .configured_failure_policy("p")
            .expect("configured policy")
            .advisory_probe,
        "health.advisory_probe must reach the runtime failure policy"
    );
    let action = V3ProviderFailureAction::recoverable("provider_failure");
    for now_ms in 100..109 {
        store
            .record_provider_failure_action("p", "k", "m", &action, now_ms)
            .expect("business failure");
    }
    let failed = store
        .record_provider_failure_action("p", "k", "m", &action, 109)
        .expect("tenth business failure");
    assert!(failed.cooldown);
    assert!(
        !failed.available,
        "advisory cannot bypass the shared minimum"
    );
    assert_eq!(failed.cooldown_until_ms, Some(3_600_109));
    assert!(
        store
            .record_provider_key_success("p", "k", "m", 3_600_110)
            .expect("business success")
            .available,
        "an expired non-429 cooldown is eligible for a business recovery trial"
    );

    let failed_probe = store
        .acquire_provider_cooldown_probe_if_due("p", Some("k"), Some("m"), 5_109)
        .expect("first advisory probe")
        .expect("first advisory probe permit");
    store
        .complete_provider_cooldown_probe_failure_with_permit(&failed_probe, 5_109)
        .expect("advisory probe failure");
    assert!(store
        .provider_cooldown_probe_keys_due(10_108)
        .expect("advisory probe not yet due")
        .is_empty());
    assert!(
        store
            .provider_cooldown_probe_keys_due(10_109)
            .expect("advisory probe due")
            .iter()
            .any(|(provider, alias, model)| provider == "p"
                && alias.as_deref() == Some("k")
                && model.as_deref() == Some("m")),
        "a failed advisory probe keeps the base cadence"
    );

    let current = store
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .expect("current probe")
        .expect("current probe permit");
    assert!(store
        .complete_provider_cooldown_probe_success_if_current_with_permit(&current, 3_600_110)
        .expect("current probe success"));
    assert!(
        store
            .scheduling_projection("p", "k", "m", 1, 1, 3_600_110)
            .unwrap()
            .available,
        "a current qualifying probe restores the exact identity"
    );
}

#[test]
fn a_later_non_rate_limit_failure_does_not_relabel_a_subthreshold_streak() {
    // Two 429 observations do not create an elapsed-time lock.
    let store = V3ProviderKeyHealthStore::default();
    let rate_limit = real_http_429_action();
    store
        .record_provider_failure_action("p", "a", "m", &rate_limit, 1_000)
        .unwrap();
    let held = store
        .record_provider_failure_action("p", "a", "m", &rate_limit, 121_000)
        .unwrap();
    assert!(
        held.available,
        "two 429 observations must keep the identity routable"
    );
    assert_eq!(held.failure_streak, 2);

    // A later 5xx on the same identity keeps the probe-owned cooldown.
    let mut upstream = V3ProviderFailureAction::recoverable("recoverable_upstream");
    upstream.recovery = V3ProviderRecoveryKind::RecoverableCounted;
    upstream.failure_threshold = 1;
    upstream.cooldown_ms = 5_000;
    upstream.failure_fingerprint = build_v3_provider_global_error_fingerprint(500).unwrap();
    let later = store
        .record_provider_failure_action("p", "a", "m", &upstream, 122_000)
        .unwrap();
    assert!(
        later.available,
        "a third mixed failure is still below the threshold"
    );
    assert_eq!(later.failure_streak, 3);
    assert!(later.cooldown_until_ms.is_none());

    // No lock exists, so elapsed time must not create one.
    let far_future = 122_000 + 3_600_000;
    let still_cooled = store
        .scheduling_projection("p", "a", "m", 1, 1, far_future)
        .unwrap();
    assert!(
        still_cooled.available,
        "a subthreshold streak must remain routable"
    );
}

#[test]
fn committed_shared_episode_agrees_in_every_projection() {
    let store = V3ProviderKeyHealthStore::default();
    let held = store
        .record_provider_failure_action("p", "a", "m", &real_http_429_action(), 1_000)
        .unwrap();
    assert!(held.available);
    let held = record_mixed_failures(&store, "p", "default", "a", "m", 1_001, 9);
    assert_eq!(
        held.cooldown_until_ms,
        Some(3_601_009),
        "the reported deadline must be the tenth failure plus one hour"
    );
    let scope = V3ProviderFailureSessionScope::new("s", "g", "session").unwrap();
    for time in [3_601_010, 9_000_000] {
        assert!(
            store
                .scheduling_projection("p", "a", "m", 1, 1, time)
                .unwrap()
                .available
        );
        assert!(
            store
                .availability_for_interface("p", "default", Some("a"), Some("m"), time)
                .available
        );
        assert!(
            store
                .availability_for_session(&scope, "p", Some("a"), Some("m"), time)
                .available
        );
        assert!(
            store
                .record_provider_key_success("p", "a", "m", time)
                .unwrap()
                .available
        );
    }
    let permit = store
        .acquire_provider_cooldown_probe("p", Some("a"), Some("m"))
        .unwrap()
        .unwrap();
    assert!(store
        .complete_provider_cooldown_probe_success_if_current_with_permit(&permit, 9_000_001)
        .unwrap());
    assert!(
        store
            .scheduling_projection("p", "a", "m", 1, 1, 9_000_001)
            .unwrap()
            .available
    );
    assert!(
        store
            .availability_for_session(&scope, "p", Some("a"), Some("m"), 9_000_001)
            .available
    );
}

#[test]
fn a_429_during_an_outstanding_cooldown_preserves_the_committed_restriction() {
    let store = V3ProviderKeyHealthStore::default();
    let committed = record_mixed_failures(&store, "p", "default", "a", "m", 1_000, 10);
    assert!(committed.cooldown);
    assert_eq!(committed.cooldown_until_ms, Some(3_601_009));

    let rate_limit = real_http_429_action();
    store
        .record_provider_failure_action("p", "a", "m", &rate_limit, 2_000)
        .expect("429 during the committed cooldown");

    // A later 429 cannot remove the existing committed lock.
    assert!(
        !store
            .scheduling_projection("p", "a", "m", 1, 1, 2_000 + 59_999)
            .expect("projection inside the rate-limit window")
            .available,
        "the committed restriction still owns availability"
    );
    let after_window = 3_601_010;
    assert!(
        store
            .scheduling_projection("p", "a", "m", 1, 1, after_window)
            .expect("projection after the rate-limit window")
            .available,
        "the expired non-429 episode is eligible for a business recovery trial"
    );

    let permit = store
        .acquire_provider_cooldown_probe("p", Some("a"), Some("m"))
        .expect("current probe")
        .expect("current probe permit");
    assert!(store
        .complete_provider_cooldown_probe_success_if_current_with_permit(&permit, after_window)
        .expect("current probe success"));
    assert!(
        store
            .scheduling_projection("p", "a", "m", 1, 1, after_window)
            .expect("projection after recovery")
            .available
    );
}
