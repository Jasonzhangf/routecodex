use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::{
    build_v3_provider_global_error_fingerprint, V3ProviderErrorFingerprint,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_provider_responses::{
    V3ProviderAvailabilityReader, V3ProviderFailureAction, V3ProviderFailureCooldownScope,
    V3ProviderFailurePolicy, V3ProviderHealthStore, V3ProviderKeyHealthStore,
    V3ProviderPrecoolObservationOutcome,
    V3ProviderProbePurpose, V3ProviderRecoveryKind, V3ProviderSchedulingProjection,
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

#[test]
fn early_429_uses_the_ordinary_recoverable_health_path() {
    let store = V3ProviderKeyHealthStore::default();
    let action = real_http_429_action();
    assert_eq!(
        action.recovery,
        V3ProviderRecoveryKind::RecoverableCounted
    );
    assert_eq!(
        action.failure_threshold,
        routecodex_v3_error::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD,
        "HTTP 429 shares the ordinary recoverable consecutive threshold"
    );
    // Below the consecutive threshold the identity keeps its store-level
    // visibility; the precool observation owner (runtime) defers it.
    let first = store
        .record_provider_failure_action("p", "a", "m", &action, 100)
        .unwrap();
    assert_eq!(first.failure_streak, 1);
    assert!(!first.cooldown);
    assert!(first.available);
    let second = store
        .record_provider_failure_action("p", "a", "m", &action, 101)
        .unwrap();
    assert_eq!(second.failure_streak, 2);
    assert!(!second.cooldown);
    assert!(second.available);
    // The third consecutive 429 commits the ordinary v29 cooldown minimum.
    let third = store
        .record_provider_failure_action("p", "a", "m", &action, 102)
        .unwrap();
    assert_eq!(third.failure_streak, 3);
    assert!(third.cooldown);
    assert!(!third.available);
    assert_eq!(third.cooldown_until_ms, Some(10_102));

    // Ordinary failure isolation still protects sibling identities.
    for (provider, key, model) in [("p", "b", "m"), ("p", "a", "n"), ("q", "a", "m")] {
        let state = store
            .scheduling_projection(provider, key, model, 1, 1, 110)
            .unwrap();
        assert!(state.available, "sibling {provider}.{model}.{key}");
    }
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
fn matching_business_success_recovers_only_its_non429_cooldown() {
    use routecodex_v3_provider_responses::V3ProviderAvailabilityReader;
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("provider_transport_error");
    for (interface, key, model) in [
        ("default", "a", "m"),
        ("default", "b", "m"),
        ("default", "a", "other"),
        ("chat", "a", "m"),
    ] {
        for now_ms in 100..=102 {
            let projection = store
                .record_provider_failure_action_for_interface(
                    "p", interface, key, model, &action, now_ms,
                )
                .unwrap();
            assert_eq!(
                projection.cooldown,
                now_ms == 102,
                "the third consecutive failure commits the v29 cooldown for {interface}/{key}/{model}"
            );
        }
    }
    let recovered = store
        .record_provider_key_success_for_interface("p", "default", "a", "m", 103)
        .unwrap();
    assert!(
        recovered.available && !recovered.cooldown,
        "matching real business success must recover the exact non429 identity: {recovered:?}"
    );
    assert_eq!(recovered.failure_streak, 0);
    for (interface, key, model) in [
        ("default", "b", "m"),
        ("default", "a", "other"),
        ("chat", "a", "m"),
    ] {
        assert!(
            !store
                .availability_for_interface("p", interface, Some(key), Some(model), 103)
                .available,
            "different identity must stay cooled: {interface}/{key}/{model}"
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
fn hs03_zero_score_cools_exact_key_and_valid_probe_restores_100() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction {
        recovery: V3ProviderRecoveryKind::RecoverableCounted,
        scope: routecodex_v3_provider_responses::V3ProviderHealthScope::GlobalProviderKey,
        score_delta_milli: -100,
        failure_threshold: 100,
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
    assert!(zero.cooldown);
    assert!(!zero.available);
    assert!(
        !store
            .scheduling_projection("p", "k", "m", 100, 1, 100)
            .expect("cooled projection")
            .available
    );
    for (provider, key, model) in [("p", "sibling-key", "m"), ("p", "k", "sibling-model")] {
        let sibling = store
            .scheduling_projection(provider, key, model, 100, 1, 100)
            .expect("sibling projection");
        assert_eq!(sibling.score_milli, 100);
        assert!(sibling.available);
    }

    let failed_probe = store
        .complete_probe_failure("p", "k", "m", 101, 5_000)
        .expect("failed probe");
    assert_eq!(failed_probe.score_milli, 0);
    assert!(failed_probe.cooldown);
    assert!(!failed_probe.available);

    let recovered = store
        .complete_probe_success("p", "k", "m", 102)
        .expect("successful probe");
    assert_eq!(recovered.score_milli, 100);
    assert!(!recovered.cooldown);
    assert!(recovered.available);
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
    let mut action = V3ProviderFailureAction::recoverable("provider_502");
    action.failure_threshold = 3;

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

    store
        .record_provider_failure_action("p", "a", "m", &action, 101)
        .expect("second recoverable failure");
    let third = store
        .record_provider_failure_action("p", "a", "m", &action, 102)
        .expect("third recoverable failure");
    assert!(third.cooldown, "threshold must still cool the key down");
    assert!(!third.available);
    let third_scheduling = store
        .scheduling_projection("p", "a", "m", 1, 1, 102)
        .expect("third scheduling projection");
    assert!(!third_scheduling.available);
    assert_eq!(
        third_scheduling.blocked_scopes,
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
    assert!(first.available, "a fresh streak stays below the threshold");
    assert!(!first.cooldown);
    store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 101)
        .expect("second failure");
    let third = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 102)
        .expect("third failure");
    assert_eq!(third.score_milli, 85);
    assert!(!third.available);
    assert!(third.cooldown, "the third consecutive failure must cool the key down");
    assert_eq!(third.cooldown_until_ms, Some(10_102));
    let first_probe = store
        .provider_cooldown_probe_keys_due(10_101)
        .expect("probe due query");
    assert!(first_probe.is_empty(), "the probe respects the 10s cooldown minimum");
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(10_102)
            .expect("probe due query"),
        vec![(
            "provider-a".into(),
            Some("key-a".into()),
            Some("model-a".into())
        )]
    );
    store
        .complete_probe_success("provider-a", "key-a", "model-a", 10_103)
        .expect("probe success must restore exact identity");
    let fourth = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 104)
        .expect("failure after probe success");
    assert_eq!(fourth.score_milli, 95);
    assert!(fourth.available, "the streak restarts below the threshold");
    assert!(!fourth.cooldown);
}

#[test]
fn dynamic_probe_ladder_first_probe_waits_for_the_cooldown_minimum() {
    let store = V3ProviderHealthStore::default();
    let session = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
        .expect("session scope");
    let policy = V3ProviderFailurePolicy {
        failure_threshold: 1,
        cooldown_ms: 60_000,
        probe_interval_ms: 60_000,
        max_probe_interval_ms: None,
        long_probe_backoff: false,
        until_restart: false,
        advisory_probe: false,
        cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
    };
    for now_ms in 100..=100 {
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

    // v31 fixes the ladder duration: a declared 60s does not extend the
    // 10s floor for three consecutive failures.
    assert!(store
        .provider_cooldown_probe_keys_due(10_099)
        .expect("probe due query")
        .is_empty());
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(10_100)
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
    // exact provider key model failure identity is `(provider, auth_alias, model)`:
    // 1) 不同指纹必须各自重启连续计数，混合指纹永远不得相加触发冷却；
    // 2) 同一 auth alias 下不同 model 各持独立身份，同指纹也不会跨模型叠加。
    let store = V3ProviderHealthStore::default();
    let session = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
        .expect("session scope");
    let policy = V3ProviderFailurePolicy {
        failure_threshold: 3,
        cooldown_ms: 5_000,
        probe_interval_ms: 5_000,
        max_probe_interval_ms: None,
        long_probe_backoff: false,
        until_restart: false,
        advisory_probe: false,
        cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
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
    // 500 / 502 / 503 各一次：每次换指纹都重启连续计数，三次都是"第 1 次"，
    // 不得凑成一次 exact identity 冷却。
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
    // 同一 500 指纹、三个不同模型各一次：每个 provider+key+model 都独立计
    // 数；随后只让 model-a 达到阈值，其他模型必须保持可用。
    record("model-a", 500, 200);
    record("model-b", 500, 201);
    record("model-c", 500, 202);
    record("model-a", 500, 203);
    for (model_id, expected) in [("model-a", false), ("model-b", true), ("model-c", true)] {
        assert_eq!(
            store
                .availability_for_session(
                    &session,
                    "provider-a",
                    Some("key-a"),
                    Some(model_id),
                    203,
                )
                .available,
            expected,
            "exact provider+key+model identity isolation: model={model_id}"
        );
    }
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
fn matching_business_success_releases_cooldown_and_preserves_score_accounting() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("failure");
    }

    // A validated matching business success restores routing immediately while
    // applying its normal +1 score delta rather than a probe's reset to 100.
    let revived = store
        .record_provider_key_success("provider-a", "key-a", "model-a", 120)
        .expect("success revival");
    assert!(
        revived.available,
        "matching business success must restore its exact identity"
    );
    assert!(!revived.cooldown);
    assert_eq!(revived.failure_streak, 0);
    assert_eq!(revived.success_streak, 1);
    assert_eq!(revived.score_milli, 1);

    let probe_recovered = store
        .complete_probe_success("provider-a", "key-a", "model-a", 121)
        .expect("probe success stays available");
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
fn three_502_failures_enter_cooldown() {
    let store = V3ProviderHealthStore::default();
    store
        .scheduling_projection("p", "k", "m", 100, 1, 100)
        .expect("initial projection");
    let action = V3ProviderFailureAction::recoverable("provider_502");

    let first = store
        .record_provider_failure_action("p", "k", "m", &action, 101)
        .expect("first 502 failure");
    assert!(
        !first.cooldown,
        "a single recoverable 502 stays in precool observation below the threshold"
    );
    assert_eq!(
        store
            .scheduling_projection("p", "k", "m", 100, 1, 102)
            .unwrap()
            .score_milli,
        95
    );

    let second = store
        .record_provider_failure_action("p", "k", "m", &action, 102)
        .expect("second 502 failure");
    assert!(!second.cooldown, "two consecutive failures stay below the threshold");
    let third = store
        .record_provider_failure_action("p", "k", "m", &action, 103)
        .expect("third 502 failure");
    assert!(third.cooldown);
    assert_eq!(third.cooldown_until_ms, Some(10_103));
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
    let globally_recovered = store
        .complete_probe_success("provider-b", "key-b", "model-b", 101)
        .expect("global probe success");
    assert!(globally_recovered.available);
    assert!(!globally_recovered.cooldown);

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

fn typed_failure_fingerprint(status: u16) -> V3ProviderErrorFingerprint {
    V3ProviderErrorFingerprint::new(
        "recoverable_upstream",
        "recoverable_upstream",
        status,
        "recoverable_upstream",
    )
    .expect("typed fingerprint")
}

#[test]
fn different_recoverable_fingerprints_do_not_add_up_to_one_cooldown() {
    // Three *same* errors are required: recoverable failures with different typed
    // fingerprints each start their own consecutive-failure streak and must never
    // be summed into one cooldown.
    let store = V3ProviderKeyHealthStore::default();
    let mut action = V3ProviderFailureAction::recoverable("provider_http_error");
    action.failure_threshold = 3;

    // HTTP 429 and every other recoverable status use the same counted path;
    // different typed fingerprints still each start their own streak.
    for (offset, status, expected_streak) in [(0, 429_u16, 1), (1, 500, 1), (2, 502, 1)] {
        action.failure_fingerprint = Some(typed_failure_fingerprint(status));
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

    // The same fingerprint three times in a row still cools the exact identity.
    action.failure_fingerprint = Some(typed_failure_fingerprint(503));
    for now_ms in 200..202 {
        let projection = store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("same-fingerprint failure");
        assert!(!projection.cooldown, "now_ms={now_ms}");
        assert!(projection.available, "now_ms={now_ms}");
    }
    let third = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 202)
        .expect("third same-fingerprint failure");
    assert_eq!(third.failure_streak, 3);
    assert!(third.cooldown, "three same-fingerprint failures must cool");
    assert!(!third.available);
}

// 生产 builder 身份回归：5xx 保留真实上游状态，500 与 502 不能共用一条
// 连续失败序列；没有上游状态的失败落到失败类别，不同类别同样不同源。
#[test]
fn production_failure_actions_keep_distinct_5xx_and_class_identities() {
    let store = V3ProviderKeyHealthStore::default();
    let server_error = build_v3_provider_global_error_fingerprint(500)
        .expect("500 fingerprint classification")
        .expect("500 must reach global health");
    let gateway_error = build_v3_provider_global_error_fingerprint(502)
        .expect("502 fingerprint classification")
        .expect("502 must reach global health");
    assert_ne!(server_error, gateway_error);

    let mut action = V3ProviderFailureAction::recoverable("provider_http_error");
    action.failure_threshold = 3;
    for (offset, status) in [0_u64, 1, 2].into_iter().zip([500_u16, 502, 500]) {
        action.failure_fingerprint = Some(
            build_v3_provider_global_error_fingerprint(status)
                .expect("fingerprint classification")
                .expect("status must reach global health"),
        );
        let projection = store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, offset)
            .expect("alternating 5xx failure");
        assert_eq!(
            projection.failure_streak, 1,
            "alternating 500/502 must restart the streak: offset={offset}"
        );
        assert!(!projection.cooldown, "alternating 500/502 must never cool");
    }

    // 类别回退身份：本地 decode 失败与 request compat 失败没有上游状态，但
    // 类别不同，不能合并成一条 streak。
    let mut sse_decode = V3ProviderFailureAction::recoverable("provider.sse_decode");
    let mut compat = V3ProviderFailureAction::recoverable("provider_request_compat_error");
    sse_decode.failure_threshold = 3;
    compat.failure_threshold = 3;
    assert_ne!(sse_decode.failure_fingerprint, compat.failure_fingerprint);
    assert_eq!(
        sse_decode.failure_fingerprint.as_ref().unwrap().http_status,
        0
    );
    for (offset, action) in [(10_u64, &sse_decode), (11, &compat), (12, &sse_decode)] {
        let projection = store
            .record_provider_failure_action("provider-b", "key-b", "model-b", action, offset)
            .expect("mixed-class failure");
        assert_eq!(
            projection.failure_streak, 1,
            "mixed classes must restart the streak"
        );
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
fn configured_advisory_probe_never_blocks_availability_or_advances_the_ladder() {
    // A provider that declares `health.advisory_probe = true` keeps the recovery
    // probe advisory for every business failure of that provider: a pending,
    // in-flight or failed probe never removes the exact identity from formal
    // selection, and probe failures never advance the health ladder. The hold
    // window is the only exclusion; it releases by expiry or real success.
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
    // The store stamps the configured advisory flag onto the business-failure
    // action even though the classified action itself carries no such flag.
    let mut action = V3ProviderFailureAction::recoverable("provider_failure");
    action.failure_threshold = 1;
    action.cooldown_ms = 5_000;

    let failed = store
        .record_provider_failure_action("p", "k", "m", &action, 100)
        .expect("business failure");
    assert!(failed.cooldown);
    assert!(!failed.available, "the bounded hold window still excludes");

    // The hold window expires without a probe, so the identity comes back on its
    // own; an advisory probe is never the availability owner. The v29 cooldown
    // floor is the first ladder step for a threshold-1 hold.
    let after_window = store
        .scheduling_projection("p", "k", "m", 1, 1, 101 + 10_000)
        .expect("post-window projection");
    assert!(
        after_window.available,
        "an expired advisory hold must release the exact identity"
    );

    // Repeated advisory probe failures must not escalate the ladder: the probe
    // keeps the base 5s cadence instead of stepping toward the 30m ceiling.
    for now_ms in [6_000, 11_000, 16_000, 21_000] {
        store
            .complete_probe_failure("p", "k", "m", now_ms, 5_000)
            .expect("advisory probe failure");
        assert!(
            store
                .provider_cooldown_probe_keys_due(now_ms + 5_000 - 1)
                .expect("advisory probe not yet due")
                .iter()
                .all(|(provider, _, _)| provider != "p"),
            "an advisory probe must keep the base 5s cadence after {now_ms}"
        );
        assert!(
            store
                .provider_cooldown_probe_keys_due(now_ms + 5_000)
                .expect("advisory probe due")
                .iter()
                .any(|(provider, alias, model)| provider == "p"
                    && alias.as_deref() == Some("k")
                    && model.as_deref() == Some("m")),
            "an advisory probe must stay due at the base cadence after {now_ms}"
        );
    }
    let still_available = store
        .scheduling_projection("p", "k", "m", 1, 1, 30_000)
        .expect("advisory projection after probe failures");
    assert!(
        still_available.available,
        "advisory probe failures must never lock the provider out"
    );
}

#[test]
fn stream_failure_commits_visibility_only_from_the_consecutive_ladder() {
    use routecodex_v3_provider_responses::V3ProviderAvailabilityReader;
    let store = V3ProviderHealthStore::default();
    let record = |provider: &str, key: &str, model: &str, now_ms: u64| {
        store
            .record_provider_stream_failure_in_provider_scope_for_interface(
                provider,
                "default",
                Some(key),
                Some(model),
                "post_commit_stream_break",
                now_ms,
            )
            .expect("post-commit stream failure");
    };
    // A post-commit stream break is an ordinary recoverable failure: below the
    // consecutive ladder it records only the streak and never changes pool
    // visibility.
    for now_ms in [100_u64, 101] {
        record("p", "k", "m", now_ms);
        assert!(
            store
                .availability_for_interface("p", "default", Some("k"), Some("m"), now_ms)
                .available,
            "a stream failure below the consecutive ladder must not cool the identity"
        );
        assert!(
            store.cooldown_entries(now_ms).is_empty(),
            "a stream failure below the consecutive ladder must not create a cooldown-pool entry"
        );
        assert!(
            store
                .provider_cooldown_probe_keys_due(9_999)
                .expect("probe due query")
                .is_empty(),
            "no recovery probe may be due before the ten-second floor"
        );
    }
    // The exact identity's siblings are untouched.
    for (key, model) in [("sibling-key", "m"), ("k", "sibling-model")] {
        assert!(
            store
                .availability_for_interface("p", "default", Some(key), Some(model), 101)
                .available,
            "unrelated {key}/{model} identity must stay visible"
        );
    }
    // The third consecutive failure commits the v31 ten-second floor.
    record("p", "k", "m", 102);
    assert!(
        !store
            .availability_for_interface("p", "default", Some("k"), Some("m"), 102)
            .available
    );
    let entries = store.cooldown_entries(102);
    let probe = entries
        .iter()
        .find(|entry| entry.kind == "probe")
        .expect("the third consecutive failure must create a cooldown-pool entry");
    assert_eq!(probe.until_ms, Some(10_102));
    assert!(
        store
            .provider_cooldown_probe_keys_due(10_101)
            .expect("probe due query")
            .is_empty(),
        "the recovery probe waits for the committed ten-second floor"
    );
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(10_102)
            .expect("probe due query"),
        vec![("p".into(), Some("k".into()), Some("m".into()))]
    );
    // A declared success resets the consecutive count ...
    store
        .record_provider_key_success_for_interface("p", "default", "k", "m", 10_103)
        .expect("business success");
    assert!(
        store
            .availability_for_interface("p", "default", Some("k"), Some("m"), 10_103)
            .available
    );
    // ... so the next stream break starts a fresh streak below the threshold.
    record("p", "k", "m", 10_104);
    assert!(
        store
            .availability_for_interface("p", "default", Some("k"), Some("m"), 10_104)
            .available,
        "a declared success must restart the consecutive count below the threshold"
    );
    assert!(store.cooldown_entries(10_104).is_empty());
}

#[test]
fn stream_failure_consecutive_ladder_steps_are_ten_thirty_and_one_hour() {
    let store = V3ProviderHealthStore::default();
    let steps = [
        (100_u64, None),
        (101, None),
        (102, Some(10_102)),
        (103, Some(10_103)),
        (104, Some(30_104)),
        (105, Some(30_105)),
        (106, Some(30_106)),
        (107, Some(30_107)),
        (108, Some(30_108)),
        (109, Some(3_600_109)),
    ];
    for (now_ms, expected_until) in steps {
        store
            .record_provider_stream_failure_in_provider_scope_for_interface(
                "p",
                "default",
                Some("k"),
                Some("m"),
                "post_commit_stream_break",
                now_ms,
            )
            .expect("post-commit stream failure");
        let until_ms = store
            .cooldown_entries(now_ms)
            .iter()
            .find(|entry| entry.kind == "probe")
            .and_then(|entry| entry.until_ms);
        assert_eq!(
            until_ms, expected_until,
            "the committed cooldown must follow the consecutive ladder at {now_ms}"
        );
    }
    // Streak 3 -> 10s, 5 -> 30s, 10 -> 1h: the one-hour step is the floor for
    // the recovery probe.
    assert!(
        store
            .provider_cooldown_probe_keys_due(3_600_108)
            .expect("probe due query")
            .is_empty()
    );
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(3_600_109)
            .expect("probe due query"),
        vec![("p".into(), Some("k".into()), Some("m".into()))]
    );
}

/// v31 request-failure counting contract. `record_provider_failure_action_for_interface`
/// is the counted path a recorded recoverable REQUEST failure must use: every
/// record bumps the exact identity's consecutive streak, the identity stays
/// VISIBLE below the threshold (only the ladder may change visibility), and the
/// ladder commits exactly one cooldown row at 3 -> 10s, 5 -> 30s, 10 -> 1h. A
/// declared success resets the counter, and sibling key/model identities are
/// never touched.
#[test]
fn request_failure_action_path_counts_only_from_the_consecutive_ladder() {
    use routecodex_v3_provider_responses::V3ProviderAvailabilityReader;
    let store = V3ProviderHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("provider_transport_error");
    for (expected_streak, now_ms) in [(1_u32, 100_u64), (2, 101)] {
        let projection = store
            .record_provider_failure_action_for_interface("p", "default", "k", "m", &action, now_ms)
            .expect("recorded recoverable request failure");
        assert_eq!(
            projection.failure_streak, expected_streak,
            "each recorded request failure advances the exact identity streak"
        );
        assert!(
            !projection.cooldown,
            "below the ladder a recorded request failure must not commit a cooldown"
        );
        assert_eq!(projection.cooldown_until_ms, None);
        assert!(projection.available);
        assert!(
            store.cooldown_entries(now_ms).is_empty(),
            "no cooldown-pool row exists below the ladder"
        );
        for (sibling_key, sibling_model) in [("other-key", "m"), ("k", "other-model")] {
            assert!(
                store
                    .availability_for_interface(
                        "p",
                        "default",
                        Some(sibling_key),
                        Some(sibling_model),
                        now_ms,
                    )
                    .available,
                "below the ladder the failure must not touch {sibling_key}/{sibling_model}"
            );
        }
    }

    // The third consecutive recorded request failure commits exactly one
    // 10s-floor row, and that row is the probe's own deadline.
    let third = store
        .record_provider_failure_action_for_interface("p", "default", "k", "m", &action, 102)
        .expect("third recorded recoverable request failure");
    assert_eq!(third.failure_streak, 3);
    assert!(third.cooldown);
    assert_eq!(third.cooldown_until_ms, Some(10_102));
    let committed = store.cooldown_entries(102);
    assert_eq!(
        committed.len(),
        1,
        "exactly one committed row at the third record: {committed:?}"
    );
    assert_eq!(committed[0].kind, "probe");
    assert_eq!(committed[0].interface_id, "default");
    assert_eq!(committed[0].auth_alias.as_deref(), Some("k"));
    assert_eq!(committed[0].model_id.as_deref(), Some("m"));
    assert_eq!(committed[0].until_ms, Some(10_102));
    assert!(
        !store
            .availability_for_interface("p", "default", Some("k"), Some("m"), 102)
            .available
    );
    for (sibling_key, sibling_model) in [("other-key", "m"), ("k", "other-model")] {
        assert!(
            store
                .availability_for_interface(
                    "p",
                    "default",
                    Some(sibling_key),
                    Some(sibling_model),
                    102,
                )
                .available,
            "a committed cooldown must not exclude {sibling_key}/{sibling_model}"
        );
    }
    assert!(store
        .provider_cooldown_probe_keys_due(10_101)
        .expect("probe due query")
        .is_empty());
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(10_102)
            .expect("probe due query"),
        vec![("p".into(), Some("k".into()), Some("m".into()))]
    );

    // Ladder crossings on the same recorded-request-failure path: 4 stays on
    // the 10s step, 5 -> 30s, and 10 -> 1h.
    for (now_ms, expected_until) in [
        (103_u64, 10_103_u64),
        (104, 30_104),
        (105, 30_105),
        (106, 30_106),
        (107, 30_107),
        (108, 30_108),
        (109, 3_600_109),
    ] {
        store
            .record_provider_failure_action_for_interface("p", "default", "k", "m", &action, now_ms)
            .expect("recorded recoverable request failure");
        let until_ms = store
            .cooldown_entries(now_ms)
            .iter()
            .find(|entry| entry.kind == "probe")
            .and_then(|entry| entry.until_ms);
        assert_eq!(
            until_ms,
            Some(expected_until),
            "the consecutive ladder must decide the committed cooldown at {now_ms}"
        );
    }

    // A declared success resets the counter and clears the committed row.
    let recovered = store
        .record_provider_key_success_for_interface("p", "default", "k", "m", 3_600_110)
        .expect("declared provider success");
    assert!(recovered.available);
    assert_eq!(recovered.failure_streak, 0);
    assert!(store.cooldown_entries(3_600_110).is_empty());
    // The next recorded request failure starts the ladder over at one.
    let after_reset = store
        .record_provider_failure_action_for_interface("p", "default", "k", "m", &action, 3_600_111)
        .expect("recorded recoverable request failure after success");
    assert_eq!(after_reset.failure_streak, 1);
    assert!(!after_reset.cooldown);
    assert!(store.cooldown_entries(3_600_111).is_empty());
}

/// v31 fixes the consecutive ladder durations (3 -> 10s, 5 -> 30s, 10 -> 1h):
/// a declared policy duration can neither undercut NOR extend them. Only the
/// MANUAL/admin entry keeps its exact declared duration.
#[test]
fn declared_policy_duration_neither_undercuts_nor_extends_the_fixed_ladder() {
    let store = V3ProviderHealthStore::default();
    let session = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
        .expect("session scope");
    let policy = |cooldown_ms: u64| V3ProviderFailurePolicy {
        failure_threshold: 3,
        cooldown_ms,
        probe_interval_ms: 5_000,
        max_probe_interval_ms: None,
        long_probe_backoff: false,
        until_restart: false,
        advisory_probe: false,
        cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
    };
    let fingerprint = build_v3_provider_global_error_fingerprint(429).expect("classification");
    let record = |model_id: &'static str, declared_ms: u64, now_ms: u64| {
        store
            .record_provider_failure_in_session_with_policy(
                &session,
                "provider-a",
                Some("key-a"),
                Some(model_id),
                Some("transport"),
                fingerprint.clone(),
                now_ms,
                Some(policy(declared_ms)),
            )
            .expect("recoverable failure")
    };
    let committed_span = |model_id: &'static str, now_ms: u64| {
        let until = store
            .cooldown_entries(now_ms)
            .into_iter()
            .find(|entry| entry.model_id.as_deref() == Some(model_id))
            .and_then(|entry| entry.until_ms)
            .unwrap_or_else(|| panic!("{model_id} must have a committed cooldown row"));
        until - now_ms
    };

    // 1) A declared 5000 SHORTER than the ladder may not undercut the 10s
    //    commit at three consecutive failures.
    for now_ms in [100_u64, 101] {
        let below = record("declared-short", 5_000, now_ms);
        assert!(
            below.cooldown_until_ms.is_none(),
            "below-threshold failures stay visible and commit nothing"
        );
    }
    record("declared-short", 5_000, 102);
    assert_eq!(
        committed_span("declared-short", 102),
        10_000,
        "a declared 5000 must not undercut the fixed v31 10s step"
    );

    // 2) The same declared 5000 at the five-failure step commits the 30s step.
    for now_ms in [200_u64, 201, 202, 203] {
        record("declared-short-five", 5_000, now_ms);
    }
    record("declared-short-five", 5_000, 204);
    assert_eq!(
        committed_span("declared-short-five", 204),
        30_000,
        "a declared 5000 must not undercut the fixed v31 30s step"
    );

    // 3) A declared duration LONGER than the ladder does not extend it: the
    //    v31 ladder duration is fixed, not a configurable minimum.
    for now_ms in [300_u64, 301] {
        let below = record("declared-long", 60_000, now_ms);
        assert!(below.cooldown_until_ms.is_none());
    }
    record("declared-long", 60_000, 302);
    assert_eq!(
        committed_span("declared-long", 302),
        10_000,
        "the v31 10s ladder step is fixed; a declared 60s does not extend it"
    );

    // 4) MANUAL/admin cooldowns keep their exact declared duration; the fixed
    //    ladder is an automatic-path rule and does not rewrite operator intent.
    let manual_until = store
        .add_cooldown_entry_for_interface(
            "provider-a",
            "default",
            Some("manual-key"),
            Some("manual-model"),
            "probe",
            5_000,
            400,
        )
        .expect("manual cooldown");
    assert_eq!(
        manual_until - 400,
        5_000,
        "a manual/admin cooldown must keep its exact declared duration"
    );
    let manual = store
        .cooldown_entries(400)
        .into_iter()
        .find(|entry| entry.model_id.as_deref() == Some("manual-model"))
        .expect("manual cooldown must be projected");
    assert_eq!(manual.until_ms, Some(5_400));
    assert_eq!(manual.remaining_ms, Some(5_000));

    // Each identity above owns its own row: the ladder never leaks across
    // sibling models.
    let models: Vec<_> = store
        .cooldown_entries(400)
        .into_iter()
        .filter_map(|entry| entry.model_id)
        .collect();
    for expected in ["declared-short", "declared-short-five", "declared-long"] {
        assert!(
            models.iter().any(|model| model == expected),
            "{expected} must own a committed row: {models:?}"
        );
    }
}

/// Regression guard for the multi-candidate manual/admin cooldown defect
/// (`issue86b45e0_last_provider_policy::i86_multi_last_eligible_stays_routable`).
///
/// An accepted operator cooldown must hide the exact complete
/// provider/interface/auth-key/model identity from multi-candidate selection,
/// while the single-candidate terminal exception stays a target-side decision
/// (the store never decides it). This test discriminates the two candidate
/// causes reported for that defect by probing EVERY plausible identity spelling
/// the runtime could pass for the same logical model:
///
///   - `wire-a`  (the wire name the `/cooldown-pool/add` body carries)
///   - `internal-a` (an internal model id that differs from the wire name)
///
/// It also pins the manual row's projection shape so the row can never be
/// mistaken for an automatic ladder row.
#[test]
fn manual_cooldown_hides_only_the_exact_identity_it_was_added_for() {
    let store = V3ProviderKeyHealthStore::default();
    let add_until = store
        .add_cooldown_entry_for_interface("a", "default", Some("key"), Some("wire-a"), "probe",
            60_000,
            1_000,
        )
        .expect("operator cooldown is accepted");
    assert_eq!(add_until, 61_000, "manual duration is exact");

    // The projected row must be present and carry the exact declared duration.
    let entries = store.cooldown_entries(1_000);
    let row = entries
        .iter()
        .find(|entry| entry.model_id.as_deref() == Some("wire-a"))
        .expect("the manual row must be projected into the cooldown pool");
    assert_eq!(row.provider_id, "a");
    assert_eq!(row.interface_id, "default");
    assert_eq!(row.auth_alias.as_deref(), Some("key"));
    assert_eq!(row.until_ms, Some(61_000));
    assert_eq!(row.remaining_ms, Some(60_000));

    // (1) The spelling the operator body used MUST be blocked.
    let wire = store.availability_for_interface("a", "default", Some("key"), Some("wire-a"), 1_000);
    assert!(
        !wire.available,
        "the exact identity the operator cooled must be unavailable: {wire:?}"
    );
    assert!(
        wire.blocked_scopes.iter().any(|scope| scope.contains("cooldown")),
        "the manual block must be visible as a cooldown scope: {wire:?}"
    );

    // (2) A different internal model id is a DIFFERENT identity: the manual row
    //     must not leak to it (P0 identity independence).
    let internal =
        store.availability_for_interface("a", "default", Some("key"), Some("internal-a"), 1_000);
    assert!(
        internal.available,
        "a manual cooldown must not exclude a sibling model identity: {internal:?}"
    );

    // (3) Sibling auth keys and other providers stay visible too.
    for (provider, alias, model) in [
        ("a", "other-key", "wire-a"),
        ("b", "key", "wire-a"),
    ] {
        let sibling = store.availability_for_interface(
            provider,
            "default",
            Some(alias),
            Some(model),
            1_000,
        );
        assert!(
            sibling.available,
            "manual cooldown must not leak to {provider}/{alias}/{model}: {sibling:?}"
        );
    }

    // (4) Expiry alone does not restore routing: the identity stays a cooldown
    //     substate (due probe) until a successful probe removes the row.
    let due = store.availability_for_interface("a", "default", Some("key"), Some("wire-a"), 61_000);
    assert!(
        !due.available,
        "expiry alone must not hide an excluded identity, it becomes a due probe: {due:?}"
    );
    let due_row = store
        .cooldown_entries(61_000)
        .into_iter()
        .find(|entry| entry.model_id.as_deref() == Some("wire-a"))
        .expect("the expired manual row remains a cooldown substate");
    assert_eq!(due_row.until_ms, Some(61_000));
    assert!(
        due_row.remaining_ms.is_none_or(|remaining| remaining <= 0),
        "the expired row reports no positive remaining time: {due_row:?}"
    );
}
