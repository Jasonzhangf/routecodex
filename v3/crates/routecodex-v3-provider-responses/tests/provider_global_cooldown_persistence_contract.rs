use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::{
    V3ProviderAvailabilityReader, V3ProviderCooldownCoordinator, V3ProviderCooldownFailureClass,
    V3ProviderCooldownObservation, V3ProviderHealthStore, V3ProviderSessionAvailabilityReader,
};

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
    let permit = restarted.acquire_startup_probe().unwrap();
    restarted.apply_probe_failure(permit, 2_001).unwrap();
    assert!(!restarted.availability("p", Some("k"), Some("m"), 2_002));
}

#[test]
fn health_store_loads_persisted_provider_probe_before_listener_ready() {
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
    drop(first);
    let restored = V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path);
    let scope = V3ProviderFailureSessionScope::new("s", "g", "session").unwrap();
    let projection = V3ProviderSessionAvailabilityReader::new(restored, scope).availability(
        "p",
        Some("k"),
        Some("m"),
        2_000,
    );
    assert!(!projection.available);
}
