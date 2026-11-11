use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::{V3ProviderActionGate, V3ProviderActionGateKey};

fn key(session: &str, identity: &str, family: &str) -> V3ProviderActionGateKey {
    V3ProviderActionGateKey::new(
        &V3ProviderFailureSessionScope::new("server", "group", session).unwrap(),
        identity,
        family,
    )
    .unwrap()
}

#[test]
fn non429_failure_does_not_escalate_another_identity_in_the_same_session() {
    for identity in [
        "a:default:other:model",
        "a:default:key:other",
        "a:other:key:model",
        "b:default:key:model",
    ] {
        let gate = V3ProviderActionGate::default();
        let a = key("session", "a:default:key:model", "provider_pre_cool");
        let b = key("session", identity, "provider_pre_cool");
        gate.record_failure(&a).unwrap();
        gate.record_failure(&a).unwrap();
        assert_eq!(
            gate.record_failure(&b).unwrap().minimum_delay_ms,
            1_000,
            "{identity}"
        );
        gate.record_provider_success(&b.provider_scope).unwrap();
        assert_eq!(gate.record_failure(&a).unwrap().minimum_delay_ms, 5_000);
    }
}

#[test]
fn session_success_does_not_clear_another_observation_scope() {
    let gate = V3ProviderActionGate::default();
    let a = key("a", "provider:interface:key:model", "provider_pre_cool");
    let b = key("b", "provider:interface:key:model", "provider_pre_cool");
    gate.record_failure(&a).unwrap();
    gate.record_provider_success(&b.provider_scope).unwrap();
    assert_eq!(gate.record_failure(&a).unwrap().minimum_delay_ms, 3_000);
    gate.record_provider_success(&a.provider_scope).unwrap();
    assert_eq!(gate.record_failure(&a).unwrap().minimum_delay_ms, 1_000);
}

#[test]
fn rate_limit_backoff_is_independent_for_other_auth_keys() {
    let gate = V3ProviderActionGate::default();
    let a = key("a", "provider:default:a:model", "provider_http_429");
    let b = key("b", "provider:default:b:model", "provider_http_429");
    gate.record_failure(&a).unwrap();
    gate.record_failure(&a).unwrap();
    assert_eq!(gate.record_failure(&b).unwrap().minimum_delay_ms, 1_000);
}
