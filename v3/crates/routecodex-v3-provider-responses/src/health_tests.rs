use super::*;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};

fn session(session_id: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("server-a", "group-a", session_id).unwrap()
}

#[test]
fn manifest_disabled_provider_is_projected_as_unavailable_by_provider_owner() {
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.disabled]
enabled = false
type = "responses"
base_url = "http://disabled.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
[providers.disabled.models.m]
[providers.enabled]
type = "responses"
base_url = "http://enabled.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
[providers.enabled.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "enabled", model = "m", key = "k", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap();
    let availability = V3ProviderAvailabilityRegistry::from_manifest(&manifest);
    assert!(
        !availability
            .availability("disabled", Some("k"), Some("m"), 0)
            .available
    );
    assert!(
        availability
            .availability("enabled", Some("k"), Some("m"), 0)
            .available
    );
}

#[test]
fn three_failures_cool_the_same_provider_key_across_sessions() {
    let store = V3ProviderHealthStore::default();
    for now_ms in 100..103 {
        store
            .record_provider_failure_in_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                Some("controlled failure"),
                now_ms,
            )
            .unwrap();
    }
    assert!(
        !store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                103,
            )
            .available
    );
    assert!(
        !store
            .availability_for_session(
                &session("session-b"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                103,
            )
            .available
    );
}

#[test]
fn operator_can_remove_auth_key_cooldown_and_probe_state() {
    let store = V3ProviderHealthStore::default();
    for now_ms in 100..103 {
        store
            .record_provider_failure_in_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                Some("controlled failure"),
                now_ms,
            )
            .unwrap();
    }
    assert!(store
        .cooldown_entries(103)
        .iter()
        .any(|entry| entry.kind == "auth_key"));
    assert!(store
        .remove_cooldown_entry("provider-a", Some("key-a"), Some("gpt-5.5"), "auth_key")
        .unwrap());
    assert!(!store
        .cooldown_entries(103)
        .iter()
        .any(|entry| entry.kind == "auth_key"));
    assert!(
        store
            .availability("provider-a", Some("key-a"), Some("gpt-5.5"), 103)
            .available
    );
}

#[test]
fn failures_in_other_session_share_provider_key_cooldown() {
    let store = V3ProviderHealthStore::default();
    for (index, session_id) in ["session-a", "session-a", "session-a", "session-b"]
        .into_iter()
        .enumerate()
    {
        let record = store
            .record_provider_failure_in_session(
                &session(session_id),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                Some("controlled failure"),
                100 + index as u64,
            )
            .unwrap();
        assert_eq!(
            record.state,
            if index >= 2 { "cooldown" } else { "healthy" }
        );
        assert_eq!(
            record.failure_count,
            if index == 3 { 3 } else { (index + 1) as u32 }
        );
    }
    for (key, available) in [("key-a", false), ("key-b", true)] {
        assert_eq!(
            store
                .availability_for_session(
                    &session("session-b"),
                    "provider-a",
                    Some(key),
                    Some("gpt-5.5"),
                    105,
                )
                .available,
            available
        );
    }
}

#[test]
fn auth_key_policy_cools_key_across_sessions_without_blocking_sibling_keys() {
    let store = V3ProviderHealthStore::default();
    let policy = V3ProviderFailurePolicy {
        failure_threshold: 2,
        cooldown_ms: 3_600_000,
        probe_interval_ms: 3_600_000,
        until_restart: false,
        cooldown_scope: V3ProviderFailureCooldownScope::AuthKey,
    };
    let first = store
        .record_provider_failure_in_session_with_policy(
            &session("session-a"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            Some("HTTP_401"),
            100,
            Some(policy),
        )
        .unwrap();
    assert_eq!(first.failure_count, 1);
    let second = store
        .record_provider_failure_in_session_with_policy(
            &session("session-b"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            Some("HTTP_401"),
            101,
            Some(policy),
        )
        .unwrap();
    assert_eq!(second.state, "cooldown");
    assert_eq!(second.cooldown_until_ms, Some(30_101));
    assert!(store
        .provider_cooldown_probe_keys_due(30_100)
        .unwrap()
        .is_empty());
    assert_eq!(
        store.provider_cooldown_probe_keys_due(30_101).unwrap(),
        vec![(
            "provider-a".to_string(),
            Some("key-a".to_string()),
            Some("gpt-5.5".to_string()),
        )]
    );
    assert!(
        !store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                102,
            )
            .available
    );
    assert!(
        store
            .availability_for_session(
                &session("session-c"),
                "provider-a",
                Some("key-a"),
                Some("other-model"),
                102,
            )
            .available
    );
    assert!(
        store
            .availability_for_session(
                &session("session-c"),
                "provider-a",
                Some("key-b"),
                Some("gpt-5.5"),
                102,
            )
            .available
    );
    store
        .complete_provider_cooldown_probe_success("provider-a", Some("key-a"), Some("gpt-5.5"))
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                180_102,
            )
            .available
    );
}

#[test]
fn success_in_one_session_clears_sibling_session_cooldown_for_exact_key_model() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_transient_bypass_in_session(
            &session("session-a"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            Some("controlled transient failure"),
            100,
        )
        .unwrap();
    assert!(
        !store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                103,
            )
            .available
    );
    // session-b 的真实成功恢复同一 provider:key:model 的 session 冷却。
    store
        .record_provider_success_in_session(
            &session("session-b"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            104,
        )
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                105,
            )
            .available,
        "sibling session success must recover the exact provider key/model"
    );
    assert!(
        store
            .availability_for_session(
                &session("session-b"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                105,
            )
            .available,
        "the successful session must remain available"
    );
    assert!(
        store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                106,
            )
            .available,
        "a different model must not be changed by this recovery"
    );
}

#[test]
fn success_in_any_session_does_not_recover_provider_cooldown_without_probe() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            "post-commit stream failure",
            100,
            10,
        )
        .unwrap();
    // 未到期的 provider cooldown 不得由业务成功清除。
    store
        .record_provider_success_in_session(
            &session("session-a"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            105,
        )
        .unwrap();
    assert!(
        !store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                105,
            )
            .available,
        "a real success must not recover provider cooldown without probe success"
    );

    store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
        .unwrap()
        .expect("pending provider cooldown must acquire a probe");
    store
        .complete_provider_cooldown_probe_success_at(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            106,
        )
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                107,
            )
            .available,
        "successful probe must recover the exact provider key/model"
    );
}

#[test]
fn cooldown_reupsert_preserves_in_flight_probe_single_flight() {
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
        .provider_cooldown_probe_keys_due(100 + 900_000 + 1)
        .unwrap()
        .contains(&(
            "provider-a".to_string(),
            Some("key-a".to_string()),
            Some("gpt-5.5".to_string())
        )));
    assert!(
        store
            .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
            .unwrap()
            .is_some(),
        "probe must be acquirable once"
    );
    // 探针在途时并发失败 re-upsert：不得清掉 in-flight 单飞锁。
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
    assert!(
        !store
            .provider_cooldown_probe_keys_due(200 + 900_000 + 1)
            .unwrap()
            .contains(&(
                "provider-a".to_string(),
                Some("key-a".to_string()),
                Some("gpt-5.5".to_string())
            )),
        "in-flight probe must not be re-enqueued by re-upsert"
    );
    assert!(
        !store
            .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
            .unwrap()
            .is_some(),
        "second concurrent probe acquisition must be denied"
    );
}

#[test]
fn failure_count_is_provider_key_scoped_for_default_policy() {
    let store = V3ProviderHealthStore::default();
    for (index, session_id) in ["session-a", "session-b", "session-b"]
        .into_iter()
        .enumerate()
    {
        let record = store
            .record_provider_failure_in_session(
                &session(session_id),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                None,
                100,
            )
            .unwrap();
        assert_eq!(
            record.state,
            if index >= 2 { "cooldown" } else { "healthy" }
        );
        assert_eq!(record.failure_count, (index + 1) as u32);
    }
    for (key, available) in [("key-a", false), ("key-b", true)] {
        assert_eq!(
            store
                .availability_for_session(
                    &session("session-a"),
                    "provider-a",
                    Some(key),
                    Some("gpt-5.5"),
                    101,
                )
                .available,
            available
        );
    }
}

#[test]
fn session_transient_bypass_isolated_between_models_while_active() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_transient_bypass_in_session(
            &session("session-a"),
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            Some("transient exhaustion"),
            100,
        )
        .unwrap();
    assert!(
        !store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                100,
            )
            .available
    );
    assert!(
        store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-b"),
                100,
            )
            .available
    );
}

#[test]
fn quota_concurrency_and_diagnostics_are_provider_owned_inputs() {
    let store = V3ProviderHealthStore::default();
    store
        .update_quota_state(
            &V3ErrorActionScope::CanonicalModel {
                provider_id: "provider-a".to_string(),
                model_id: "gpt-5.5".to_string(),
            },
            0,
            Some(1_000),
        )
        .unwrap();
    assert!(
        !store
            .availability("provider-a", Some("key-a"), Some("gpt-5.5"), 101)
            .available
    );
    assert!(
        store
            .availability("provider-a", Some("key-a"), Some("other-model"), 101)
            .available
    );
    store.update_concurrency_state("provider-b", 2, 2).unwrap();
    assert!(
        !store
            .availability("provider-b", Some("key-a"), Some("gpt-5.5"), 101)
            .available
    );
    assert!(
        store
            .availability("third", Some("key-a"), Some("gpt-5.5"), 101)
            .available
    );
    assert_eq!(
        explain_provider_health_reasons(&store, "provider-a", Some("key-a"), Some("gpt-5.5"), 101,),
        vec!["quota:canonical_model:provider-a:gpt-5.5:exhausted"]
    );
}
