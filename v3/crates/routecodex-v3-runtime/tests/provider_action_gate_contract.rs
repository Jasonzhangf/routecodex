use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::{
    V3ProviderActionGate, V3ProviderActionGateKey, V3ProviderActionGateMode,
    V3_PROVIDER_ACTION_ISOLATED_DELAY_MS, V3_PROVIDER_ACTION_MEDIUM_DELAY_MS,
    V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS,
};

fn key(error_family: &str) -> V3ProviderActionGateKey {
    V3ProviderActionGateKey::new(
        &V3ProviderFailureSessionScope::new("server", "group", "session").unwrap(),
        "provider:interface:key:model",
        error_family,
    )
    .unwrap()
}

#[test]
fn configured_backoff_is_a_minimum_for_provider_observation() {
    let recorded = V3ProviderActionGate::default()
        .record_failure_with_minimum_delay(&key("provider_pre_cool"), 7_000)
        .unwrap();
    assert_eq!(recorded.minimum_delay_ms, 7_000);
}

#[test]
fn consecutive_failures_follow_one_three_five_and_success_resets() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_pre_cool");
    for (mode, delay) in [
        (
            V3ProviderActionGateMode::Isolated,
            V3_PROVIDER_ACTION_ISOLATED_DELAY_MS,
        ),
        (
            V3ProviderActionGateMode::Medium,
            V3_PROVIDER_ACTION_MEDIUM_DELAY_MS,
        ),
        (
            V3ProviderActionGateMode::Sustained,
            V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS,
        ),
        (
            V3ProviderActionGateMode::Sustained,
            V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS,
        ),
    ] {
        let failure = gate.record_failure(&scope).unwrap();
        assert_eq!(failure.mode, mode);
        assert_eq!(failure.minimum_delay_ms, delay);
        assert_eq!(failure.recovery_ticket().key(), &scope);
        assert_eq!(failure.recovery_ticket().generation(), failure.generation);
    }
    gate.record_success(&scope).unwrap();
    let after_success = gate.record_failure(&scope).unwrap();
    assert_eq!(after_success.mode, V3ProviderActionGateMode::Isolated);
    assert_eq!(
        after_success.minimum_delay_ms,
        V3_PROVIDER_ACTION_ISOLATED_DELAY_MS
    );
}
