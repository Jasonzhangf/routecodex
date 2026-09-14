use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::{
    V3ProviderAvailabilityReader, V3ProviderCooldownCoordinator, V3ProviderCooldownFailureClass,
    V3ProviderCooldownObservation, V3ProviderHealthStore, V3ProviderSessionAvailabilityReader,
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
    let mut coordinator = V3ProviderCooldownCoordinator::new(seeded_path.clone(), 5 * 60 * 60_000);
    coordinator
        .record_failure(
            "p",
            Some("k"),
            Some("m"),
            V3ProviderCooldownFailureClass::Semantic,
            1_000,
            V3ProviderCooldownObservation::default(),
        )
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
        V3ProviderCooldownCoordinator::load(fresh_path, 5 * 60 * 60_000)
            .unwrap()
            .persisted_entries()
            .is_empty(),
        "disabled provider must not persist a cooldown"
    );
}

#[test]
fn restart_loads_cooldown_and_startup_probe_is_the_only_recovery_path() {
    let path =
        std::env::temp_dir().join(format!("routecodex-cooldown-{}.json", std::process::id()));
    let mut first = V3ProviderCooldownCoordinator::new(path.clone(), 5 * 60 * 60_000);
    first
        .record_failure(
            "p",
            Some("k"),
            Some("m"),
            V3ProviderCooldownFailureClass::Quota,
            1_000,
            V3ProviderCooldownObservation::default(),
        )
        .unwrap();
    let mut restarted = V3ProviderCooldownCoordinator::load(path, 5 * 60 * 60_000).unwrap();
    assert!(!restarted.availability("p", Some("k"), Some("m"), 2_000));
    restarted.reset_probe_schedule_for_startup().unwrap();
    assert!(!restarted.availability("p", Some("k"), Some("m"), 2_000));
    let permit = restarted.acquire_due_probe(2_000).unwrap();
    restarted.apply_probe_failure(permit, 2_001).unwrap();
    assert!(!restarted.availability("p", Some("k"), Some("m"), 2_002));
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
    first
        .flush_persistence()
        .expect("cooldown persistence must be durable before restart");
    drop(first);
    let restored =
        V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path.clone());
    let scope = V3ProviderFailureSessionScope::new("s", "g", "session").unwrap();
    let reader = V3ProviderSessionAvailabilityReader::new(restored.clone(), scope.clone());
    let projection = reader.availability("p", Some("k"), Some("m"), 2_000);
    assert!(!projection.available);
    assert!(projection
        .blocked_scopes
        .contains(&"provider_cooldown_probe_pending".to_string()));

    let startup_probe = restored
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .expect("restored cooldown must expose a startup probe");
    restored
        .complete_provider_cooldown_probe_failure_at_generation(
            "p",
            Some("k"),
            Some("m"),
            2_001,
            Some(startup_probe.expected_generation()),
        )
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
        .complete_provider_cooldown_probe_success_at_generation(
            "p",
            Some("k"),
            Some("m"),
            62_002,
            Some(recovery_probe.expected_generation()),
        )
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
fn failed_probe_uses_thirty_second_second_probe_cadence() {
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
    assert!(store
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .is_some());
    store
        .complete_provider_cooldown_probe_failure("p", Some("k"), Some("m"), 2_000)
        .unwrap();
    assert!(store
        .provider_cooldown_probe_keys_due(31_999)
        .unwrap()
        .is_empty());
    assert_eq!(
        store.provider_cooldown_probe_keys_due(32_000).unwrap(),
        vec![("p".into(), Some("k".into()), Some("m".into()))]
    );
}
