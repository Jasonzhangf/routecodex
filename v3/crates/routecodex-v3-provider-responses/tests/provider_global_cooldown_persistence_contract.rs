use routecodex_v3_provider_responses::{
    V3ProviderCooldownCoordinator, V3ProviderCooldownFailureClass, V3ProviderCooldownObservation,
};

fn key() -> (&'static str, Option<&'static str>, Option<&'static str>) {
    ("provider-a", Some("key-a"), Some("model-a"))
}

fn path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("routecodex-{name}-{}.json", std::process::id()))
}

#[test]
fn persisted_cooldown_requires_startup_probe_success_to_restore() {
    let path = path("startup");
    let mut coordinator = V3ProviderCooldownCoordinator::new(path.clone(), 5 * 60 * 60_000);
    coordinator
        .record_failure(
            key().0,
            key().1,
            key().2,
            V3ProviderCooldownFailureClass::Quota,
            1_000,
            V3ProviderCooldownObservation::default(),
        )
        .unwrap();
    coordinator.persist().unwrap();

    let mut restored = V3ProviderCooldownCoordinator::load(path, 2_000).unwrap();
    assert!(!restored.availability(key().0, key().1, key().2, 2_000));
    let permit = restored.acquire_startup_probe(2_000).unwrap().unwrap();
    restored
        .apply_probe_success(permit, 2_001)
        .expect("successful startup probe restores the key");
    assert!(restored.availability(key().0, key().1, key().2, 2_002));
}

#[test]
fn reset_is_corrected_and_bounded_by_provider_maximum() {
    let path = path("reset");
    let mut coordinator = V3ProviderCooldownCoordinator::new(path, 5 * 60 * 60_000);
    coordinator
        .record_failure(
            key().0,
            key().1,
            key().2,
            V3ProviderCooldownFailureClass::RateLimit,
            1_000,
            V3ProviderCooldownObservation {
                reset_at_ms: Some(10 * 60 * 60_000),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        coordinator.max_deadline_ms(key().0, key().1, key().2),
        Some(1_000 + 3 * 60_000)
    );
}

#[test]
fn probe_failure_keeps_provider_unavailable_and_business_success_cannot_clear_it() {
    let mut coordinator = V3ProviderCooldownCoordinator::new(path("failure"), 5 * 60 * 60_000);
    coordinator
        .record_failure(
            key().0,
            key().1,
            key().2,
            V3ProviderCooldownFailureClass::Auth,
            1_000,
            V3ProviderCooldownObservation::default(),
        )
        .unwrap();
    let permit = coordinator.acquire_startup_probe(1_001).unwrap().unwrap();
    coordinator.apply_probe_failure(permit, 1_002).unwrap();
    assert!(!coordinator.availability(key().0, key().1, key().2, 1_003));
}

#[test]
fn due_probe_is_only_released_after_success() {
    let path = path("due");
    let mut coordinator = V3ProviderCooldownCoordinator::new(path, 5 * 60 * 60_000);
    coordinator
        .record_failure(
            key().0,
            key().1,
            key().2,
            V3ProviderCooldownFailureClass::Quota,
            1_000,
            V3ProviderCooldownObservation {
                retry_after_ms: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(coordinator
        .acquire_due_probe(1_000 + 3 * 60_000 - 1)
        .unwrap()
        .is_none());
    let permit = coordinator
        .acquire_due_probe(1_000 + 3 * 60_000)
        .unwrap()
        .unwrap();
    coordinator
        .apply_probe_failure(permit, 1_000 + 3 * 60_000)
        .unwrap();
    assert!(coordinator
        .acquire_due_probe(1_000 + 3 * 60_000 + 5 * 60_000 - 1)
        .unwrap()
        .is_none());
    let permit = coordinator
        .acquire_due_probe(1_000 + 3 * 60_000 + 5 * 60_000)
        .unwrap()
        .unwrap();
    coordinator
        .apply_probe_success(permit, 1_000 + 3 * 60_000 + 5 * 60_000)
        .unwrap();
    assert!(coordinator.availability(
        key().0,
        key().1,
        key().2,
        1_000 + 3 * 60_000 + 5 * 60_000 + 1
    ));
}

#[test]
fn failed_probes_follow_dynamic_backoff_and_cap_at_five_hours() {
    let mut coordinator = V3ProviderCooldownCoordinator::new(path("backoff"), 24 * 60 * 60_000);
    coordinator
        .record_failure(
            key().0,
            key().1,
            key().2,
            V3ProviderCooldownFailureClass::Transport,
            0,
            V3ProviderCooldownObservation::default(),
        )
        .unwrap();
    let delays = [
        3 * 60_000,
        5 * 60_000,
        15 * 60_000,
        60 * 60_000,
        3 * 60 * 60_000,
        5 * 60 * 60_000,
    ];
    let mut now = 0;
    for delay in delays {
        now += delay;
        let permit = coordinator.acquire_due_probe(now).unwrap().unwrap();
        coordinator.apply_probe_failure(permit, now).unwrap();
    }
    assert!(coordinator
        .acquire_due_probe(now + 5 * 60 * 60_000 - 1)
        .unwrap()
        .is_none());
    assert!(coordinator
        .acquire_due_probe(now + 5 * 60 * 60_000)
        .unwrap()
        .is_some());
}
