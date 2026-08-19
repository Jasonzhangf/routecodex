use futures_util::poll;
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::V3ProviderHealthStore;
use std::task::Poll;
use std::time::Duration;

#[tokio::test]
async fn reupserted_rescue_probe_preserves_waiter_and_single_generation() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            "first failure",
            100,
            900_000,
        )
        .unwrap();
    assert!(store
        .try_acquire_provider_cooldown_rescue_probe("provider-a", Some("key-a"), Some("gpt-5.5"),)
        .unwrap());

    let completion = store.wait_for_provider_cooldown_probe_completion(
        "provider-a",
        Some("key-a"),
        Some("gpt-5.5"),
    );
    tokio::pin!(completion);
    assert!(matches!(poll!(&mut completion), Poll::Pending));

    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            "concurrent failure",
            200,
            900_000,
        )
        .unwrap();
    store
        .complete_provider_cooldown_probe_failure("provider-a", Some("key-a"), Some("gpt-5.5"), 300)
        .unwrap();

    assert!(
        !store
            .try_acquire_provider_cooldown_rescue_probe(
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
            )
            .unwrap(),
        "the same cooldown generation must not acquire a second rescue probe",
    );
    tokio::time::timeout(Duration::from_millis(100), &mut completion)
        .await
        .expect("probe completion must wake the pre-existing waiter")
        .unwrap();
}

#[tokio::test]
async fn successful_probe_wakes_waiter_before_removing_probe_state() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            "first failure",
            100,
            900_000,
        )
        .unwrap();
    assert!(store
        .try_acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
        .unwrap());

    let completion = store.wait_for_provider_cooldown_probe_completion(
        "provider-a",
        Some("key-a"),
        Some("gpt-5.5"),
    );
    tokio::pin!(completion);
    assert!(matches!(poll!(&mut completion), Poll::Pending));

    store
        .complete_provider_cooldown_probe_success("provider-a", Some("key-a"), Some("gpt-5.5"))
        .unwrap();
    tokio::time::timeout(Duration::from_millis(100), &mut completion)
        .await
        .expect("successful probe completion must wake the pre-existing waiter")
        .unwrap();
}

#[test]
fn session_cooldown_revive_is_denied_before_deadline() {
    let store = V3ProviderHealthStore::default();
    let scope = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a").unwrap();
    for now_ms in 100..103 {
        store
            .record_provider_failure_in_session(
                &scope,
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                Some("controlled failure"),
                now_ms,
            )
            .unwrap();
    }

    assert!(!store
        .try_acquire_cross_session_revive(
            &scope,
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            900_101,
        )
        .unwrap());
    assert!(
        !store
            .availability_for_session(
                &scope,
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                900_101,
            )
            .available
    );
}

#[test]
fn expired_session_cooldown_revives_once_and_clears_failure_generation() {
    let store = V3ProviderHealthStore::default();
    let scope = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a").unwrap();
    for now_ms in 100..103 {
        store
            .record_provider_failure_in_session(
                &scope,
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                Some("controlled failure"),
                now_ms,
            )
            .unwrap();
    }

    assert!(store
        .try_acquire_cross_session_revive(
            &scope,
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            900_102,
        )
        .unwrap());
    assert!(
        store
            .availability_for_session(
                &scope,
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                900_102,
            )
            .available
    );
    assert!(!store
        .try_acquire_cross_session_revive(
            &scope,
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            900_103,
        )
        .unwrap());

    let next = store
        .record_provider_failure_in_session(
            &scope,
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            Some("fresh generation"),
            900_104,
        )
        .unwrap();
    assert_eq!(next.failure_count, 1);
    assert_eq!(next.state, "healthy");
}
