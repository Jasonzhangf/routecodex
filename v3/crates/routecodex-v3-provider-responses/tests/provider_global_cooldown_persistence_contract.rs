use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::{
    V3ProviderAvailabilityReader, V3ProviderCooldownCoordinator, V3ProviderCooldownFailureClass,
    V3ProviderCooldownKey, V3ProviderHealthStore, V3ProviderSessionAvailabilityReader,
};

fn health_disabled_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
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
health = { enabled = false, failure_threshold = 3, cooldown_ms = 900000 }
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "k", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn health_disabled_provider_ignores_persisted_cooldown_and_never_writes_one() {
    let manifest = health_disabled_manifest();
    let seeded_path = std::env::temp_dir().join(format!(
        "routecodex-health-disabled-seeded-cooldown-{}.json",
        std::process::id()
    ));
    // Seed a durable semantic cooldown for the same identity, as a real
    // runtime instance would leave behind, then load it with health disabled.
    let mut coordinator = V3ProviderCooldownCoordinator::new(seeded_path.clone());
    let persisted_until_ms = 1_000 + 5 * 60 * 60_000;
    coordinator
        .replace_entries(vec![(
            V3ProviderCooldownKey {
                provider_id: "p".into(),
                interface_id: "default".into(),
                auth_alias: Some("k".into()),
                model_id: Some("m".into()),
                failure_class: V3ProviderCooldownFailureClass::Semantic,
            },
            persisted_until_ms,
            persisted_until_ms,
        )])
        .unwrap();

    let store = V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, seeded_path);
    let scope = V3ProviderFailureSessionScope::new("s", "g", "session").unwrap();
    let reader = V3ProviderSessionAvailabilityReader::new(store.clone(), scope);
    assert!(
        reader
            .availability("p", Some("k"), Some("m"), 2_000)
            .available,
        "health.enabled=false must not inherit a persisted cooldown"
    );

    // A disabled provider must also not create a fresh durable cooldown.
    let fresh_path = std::env::temp_dir().join(format!(
        "routecodex-health-disabled-fresh-cooldown-{}.json",
        std::process::id()
    ));
    let store =
        V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, fresh_path.clone());
    store
        .record_provider_cooldown_failure("p", Some("k"), Some("m"), "timeout", 3_000, 900_000)
        .unwrap();
    store
        .flush_persistence()
        .expect("disabled provider persistence flush must succeed");
    assert!(
        V3ProviderCooldownCoordinator::load(fresh_path)
            .unwrap()
            .persisted_entries()
            .is_empty(),
        "disabled provider must not persist a cooldown"
    );
}

#[test]
fn health_store_restores_durable_cooldown_until_startup_probe_succeeds() {
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
        .unwrap(),
    )
    .unwrap();
    let path = std::env::temp_dir().join(format!(
        "routecodex-health-cooldown-{}.json",
        std::process::id()
    ));
    let first = V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path.clone());
    first
        .record_provider_cooldown_failure("p", Some("k"), Some("m"), "quota", 1_000, 10)
        .unwrap();
    let abandoned = first
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .unwrap();
    assert_eq!(
        first
            .cooldown_entries(1_000)
            .iter()
            .find(|entry| entry.kind == "probe")
            .unwrap()
            .state,
        "probing"
    );
    first
        .flush_persistence()
        .expect("cooldown persistence must be durable before restart");
    drop(first);
    drop(abandoned);
    let restored =
        V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path.clone());
    let scope = V3ProviderFailureSessionScope::new("s", "g", "session").unwrap();
    let reader = V3ProviderSessionAvailabilityReader::new(restored.clone(), scope.clone());
    let projection = reader.availability("p", Some("k"), Some("m"), 2_000);
    assert_ne!(
        restored
            .cooldown_entries(2_000)
            .iter()
            .find(|entry| entry.kind == "probe")
            .unwrap()
            .state,
        "probing",
        "durable cooldown must never reconstruct a process-local owner"
    );
    assert!(!projection.available);
    assert!(projection
        .blocked_scopes
        .contains(&"provider_cooldown_probe_pending".to_string()));

    let startup_probe = restored
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .expect("restored cooldown must expose a startup probe");
    restored
        .complete_provider_cooldown_probe_failure_with_permit(&startup_probe, 2_001)
        .unwrap();
    assert!(
        !reader
            .availability("p", Some("k"), Some("m"), 2_002)
            .available
    );

    assert_eq!(
        restored.provider_cooldown_probe_keys_due(62_001).unwrap(),
        vec![("p".into(), Some("k".into()), Some("m".into()))]
    );
    let recovery_probe = restored
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .expect("failed startup probe must remain retryable");
    restored
        .complete_provider_cooldown_probe_success_with_permit(&recovery_probe, 62_002)
        .unwrap();
    assert!(
        reader
            .availability("p", Some("k"), Some("m"), 62_003)
            .available
    );
    restored
        .flush_persistence()
        .expect("successful probe must remove the durable semantic cooldown");
    let reloaded = V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path);
    assert!(
        V3ProviderSessionAvailabilityReader::new(reloaded, scope)
            .availability("p", Some("k"), Some("m"), 62_004)
            .available,
        "successful probe must not resurrect after restart"
    );
}

#[test]
fn failed_probe_uses_ten_second_second_probe_cadence() {
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
        .unwrap(),
    )
    .unwrap();
    let path = std::env::temp_dir().join(format!(
        "routecodex-health-probe-cadence-{}.json",
        std::process::id()
    ));
    let store = V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path);
    store
        .record_provider_cooldown_failure("p", Some("k"), Some("m"), "timeout", 1_000, 1)
        .unwrap();
    let permit = store
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .unwrap();
    store
        .complete_provider_cooldown_probe_failure_with_permit(&permit, 2_000)
        .unwrap();
    assert!(store
        .provider_cooldown_probe_keys_due(11_999)
        .unwrap()
        .is_empty());
    assert_eq!(
        store.provider_cooldown_probe_keys_due(12_000).unwrap(),
        vec![("p".into(), Some("k".into()), Some("m".into()))]
    );
}

#[test]
fn restart_restores_long_probe_cadence_for_persisted_long_class() {
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
        .unwrap(),
    )
    .unwrap();
    let path = std::env::temp_dir().join(format!(
        "routecodex-restart-ordinary-long-probes-{}.json",
        std::process::id()
    ));
    let mut coordinator = V3ProviderCooldownCoordinator::new(path.clone());
    coordinator
        .replace_entries(vec![(
            V3ProviderCooldownKey {
                provider_id: "p".into(),
                interface_id: "default".into(),
                auth_alias: Some("k".into()),
                model_id: Some("m".into()),
                failure_class: V3ProviderCooldownFailureClass::ProbeLong,
            },
            61_000,
            61_000,
        )])
        .unwrap();

    let restored = V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path);
    let permit = restored
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .expect("persisted long-policy cooldown must expose a startup probe");
    assert_eq!(permit.provider_id(), "p");
    restored
        .complete_provider_cooldown_probe_failure_with_permit(&permit, 2_001)
        .unwrap();
    assert!(restored
        .provider_cooldown_probe_keys_due(11_999)
        .unwrap()
        .is_empty());
    assert!(restored
        .provider_cooldown_probe_keys_due(12_001)
        .unwrap()
        .contains(&("p".into(), Some("k".into()), Some("m".into()))));
}

#[test]
fn restart_preserves_configured_maximum_probe_interval() {
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
health = { enabled = true, failure_threshold = 3, cooldown_ms = 900000, probe_interval_ms = 120000 }
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "k", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap();
    let path = std::env::temp_dir().join(format!(
        "routecodex-restart-fast-recovery-probes-{}.json",
        std::process::id()
    ));
    let mut coordinator = V3ProviderCooldownCoordinator::new(path.clone());
    coordinator
        .replace_entries(vec![(
            V3ProviderCooldownKey {
                provider_id: "p".into(),
                interface_id: "default".into(),
                auth_alias: Some("k".into()),
                model_id: Some("m".into()),
                failure_class: V3ProviderCooldownFailureClass::ProbeLong,
            },
            61_000,
            61_000,
        )])
        .unwrap();

    let restored = V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path);
    let permit = restored
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .expect("restored cooldown must expose a startup probe");
    restored
        .complete_provider_cooldown_probe_failure_with_permit(&permit, 2_001)
        .unwrap();
    assert!(restored
        .provider_cooldown_probe_keys_due(11_999)
        .unwrap()
        .is_empty());
    assert!(restored
        .provider_cooldown_probe_keys_due(12_001)
        .unwrap()
        .contains(&("p".into(), Some("k".into()), Some("m".into()))));
    let second = restored
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .expect("second probe permit");
    restored
        .complete_provider_cooldown_probe_failure_with_permit(&second, 32_001)
        .unwrap();
    let third = restored
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .expect("third probe permit");
    restored
        .complete_provider_cooldown_probe_failure_with_permit(&third, 92_001)
        .unwrap();
    assert!(restored
        .provider_cooldown_probe_keys_due(152_000)
        .unwrap()
        .is_empty());
    assert!(restored
        .provider_cooldown_probe_keys_due(152_001)
        .unwrap()
        .contains(&("p".into(), Some("k".into()), Some("m".into()))));
}

#[test]
fn restart_resets_a_persisted_deadline_beyond_the_configured_probe_maximum() {
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
health = { enabled = true, failure_threshold = 3, cooldown_ms = 900000, probe_interval_ms = 120000 }
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "k", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap();
    let path = std::env::temp_dir().join(format!(
        "routecodex-restart-bounded-persisted-probe-{}.json",
        std::process::id()
    ));
    let mut coordinator = V3ProviderCooldownCoordinator::new(path.clone());
    coordinator
        .replace_entries(vec![(
            V3ProviderCooldownKey {
                provider_id: "p".into(),
                interface_id: "default".into(),
                auth_alias: Some("k".into()),
                model_id: Some("m".into()),
                failure_class: V3ProviderCooldownFailureClass::ProbeLong,
            },
            30 * 60_000 + 1_000,
            30 * 60_000 + 1_000,
        )])
        .unwrap();
    assert_eq!(
        coordinator.persisted_entries()[0].2,
        30 * 60_000 + 1_000,
        "fixture must persist a probe deadline beyond the configured maximum"
    );

    let restored = V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path);
    assert_eq!(
        restored.provider_cooldown_probe_keys_due(0).unwrap(),
        vec![("p".into(), Some("k".into()), Some("m".into()))],
        "restart must make the bounded recovery probe immediately eligible"
    );
    assert!(restored
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .is_some());
}

#[test]
fn persisted_429_minimum_requires_current_probe_and_stays_removed() {
    assert_persisted_429_recovery(false);
}

#[test]
fn persisted_429_hour_lock_requires_current_probe_after_reconstruction() {
    assert_persisted_429_recovery(true);
}

fn assert_persisted_429_recovery(hour: bool) {
    let mut manifest = health_disabled_manifest();
    manifest
        .providers
        .get_mut("p")
        .unwrap()
        .health
        .as_mut()
        .unwrap()
        .enabled = true;
    // Advisory probe scheduling cannot bypass a persisted mandatory hour lock.
    manifest
        .providers
        .get_mut("p")
        .unwrap()
        .health
        .as_mut()
        .unwrap()
        .advisory_probe = hour;
    let path = std::env::temp_dir().join(format!(
        "routecodex-429-window-{}-{hour}.json",
        std::process::id()
    ));
    let store = V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path.clone());
    let classified = routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01(
        routecodex_v3_error::build_v3_error_01_source_raised_external(
            routecodex_v3_error::V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_http_429",
            "real controlled429",
            routecodex_v3_error::V3ExternalErrorLink {
                kind: routecodex_v3_error::V3ExternalErrorKind::Provider,
                status: Some(429),
                code: Some("HTTP_429".into()),
                provider_id: Some("p".into()),
                upstream_request_id: None,
                message: Some("real controlled429".into()),
            },
        ),
    );
    let action =
        routecodex_v3_error::build_v3_provider_failure_action_from_v3_error_02(&classified);
    for time in [100, 120100] {
        store
            .record_provider_failure_action("p", "k", "m", &action, time)
            .unwrap();
    }
    if hour {
        store
            .record_provider_failure_action("p", "k", "m", &action, 3600100)
            .unwrap();
    }
    // An active physical acquisition is deliberately abandoned across restart.
    let abandoned = store
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .unwrap();
    store.flush_persistence().unwrap();
    drop(store);
    drop(abandoned);
    let restored =
        V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path.clone());
    assert!(
        !restored
            .scheduling_projection("p", "k", "m", 1, 1, 120101)
            .unwrap()
            .available,
        "a persisted 429 hold must block during its window"
    );
    let now = if hour { 3600101 } else { 120101 };
    assert!(
        !restored
            .record_provider_key_success("p", "k", "m", now)
            .unwrap()
            .available,
        "late business success cannot bypass a persisted minimum or required probe"
    );
    let entries = V3ProviderCooldownCoordinator::load(path.clone())
        .unwrap()
        .persisted_rate_limit_episodes();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].1.probe_required, hour);
    assert_eq!(entries[0].1.not_before_ms, Some(1920100));
    assert!(
        restored
            .cooldown_entries(now)
            .iter()
            .all(|entry| entry.state != "probing"),
        "restart cannot inherit an active physical owner"
    );
    let permit = restored
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .unwrap();
    if !hour {
        assert!(
            !restored
                .complete_provider_cooldown_probe_success_if_current_with_permit(&permit, now)
                .unwrap(),
            "even a current probe cannot shorten the minimum"
        );
    } else {
        // Keep the hourly qualification for the final completion below.
        restored.cancel_provider_cooldown_probe(&permit).unwrap();
    }
    let permit = restored
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .unwrap();
    assert!(restored
        .complete_provider_cooldown_probe_success_if_current_with_permit(&permit, now.max(1920100))
        .unwrap());
    restored.flush_persistence().unwrap();
    drop(restored);
    let restored =
        V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path.clone());
    assert!(
        restored
            .scheduling_projection("p", "k", "m", 1, 1, now.max(1920100))
            .unwrap()
            .available
    );
    drop(restored);
    std::fs::remove_file(path).unwrap();
}
