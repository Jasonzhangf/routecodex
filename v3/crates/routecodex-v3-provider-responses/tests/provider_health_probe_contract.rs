use routecodex_v3_provider_responses::V3ProviderHealthStore;

#[test]
fn failed_cooldown_probe_does_not_mutate_transport_health_history() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            "transport failure",
            100,
            900_000,
        )
        .expect("record provider failure");
    let before = store
        .scheduling_projection("provider-a", "key-a", "gpt-5.5", 1, 1, 100)
        .expect("health projection before probe");
    store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
        .expect("acquire probe")
        .expect("probe permit");
    store
        .complete_provider_cooldown_probe_failure("provider-a", Some("key-a"), Some("gpt-5.5"), 200)
        .expect("complete probe failure");
    let after = store
        .scheduling_projection("provider-a", "key-a", "gpt-5.5", 1, 1, 200)
        .expect("health projection after probe");
    assert_eq!(after.score_milli, before.score_milli);
    assert_eq!(after.score_generation, before.score_generation);
}
