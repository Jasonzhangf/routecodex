use super::*;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};

fn account_threshold_manifest() -> V3Config05ManifestPublished {
    let source = r#"
version = 3

[[error.provider_error_action_policy]]
policy_id = "account_http_401_two_errors"
[error.provider_error_action_policy.match]
http_status = 401
[[error.provider_error_action_policy.path]]
step = "wait_retry"
retry_mode = "reselect_before_client_projection"
max_attempts = 2
backoff_ms = 1000
[[error.provider_error_action_policy.path]]
step = "cooldown"
scope = "auth_key"
duration_ms = 18000000
[[error.provider_error_action_policy.path]]
step = "project"
status = 502
reason_code = "provider_account_http_401"
message_mode = "code_only"

[[error.provider_error_action_policy]]
policy_id = "account_http_403_two_errors"
[error.provider_error_action_policy.match]
http_status = 403
[[error.provider_error_action_policy.path]]
step = "wait_retry"
retry_mode = "reselect_before_client_projection"
max_attempts = 2
backoff_ms = 1000
[[error.provider_error_action_policy.path]]
step = "cooldown"
scope = "auth_key"
duration_ms = 900000
[[error.provider_error_action_policy.path]]
step = "project"
status = 502
reason_code = "provider_account_http_403"
message_mode = "code_only"

[servers.account_threshold]
bind = "127.0.0.1"
port = 5555
routing_group = "account_threshold"
endpoints = ["responses"]
[providers.primary]
type = "responses"
base_url = "http://primary.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "PRIMARY_KEY" }] }
[providers.primary.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text"]
[route_groups.account_threshold.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }]
"#;
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(source).expect("account threshold authoring"),
    )
    .expect("account threshold manifest")
}

#[test]
fn runtime_policy_blocks_account_errors_after_two_consecutive_failures() {
    let manifest = account_threshold_manifest();
    for status in [401, 403] {
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let session = test_provider_failure_scope(
            "account_threshold",
            "account_threshold",
            &format!("account-threshold-{status}"),
        )
        .unwrap();
        health
            .store()
            .scheduling_projection("primary", "key1", "gpt-test", 100, 1, 99)
            .expect("initial health projection");
        for index in 0..2 {
            let record = health
                .record_provider_failure_record_with_policy(
                    None,
                    &manifest,
                    &session,
                    "primary",
                    Some("responses"),
                    Some("key1"),
                    Some("gpt-test"),
                    Some("account failure"),
                    "V3ProviderRespInbound01Raw",
                    status,
                    Some("provider_http_error"),
                    "account failure",
                    100 + index,
                )
                .unwrap();
            assert_eq!(record.state, "healthy");
        }
        assert!(
            !health
                .store()
                .scheduling_projection("primary", "key1", "gpt-test", 100, 1, 200)
                .expect("health projection")
                .available
        );
    }

    let other_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(
        "account_threshold",
        "account_threshold",
        "ordinary-threshold-session",
    )
    .unwrap();
    other_health
        .store()
        .scheduling_projection("primary", "key1", "gpt-test", 100, 1, 199)
        .expect("initial health projection");
    for index in 0..3 {
        let record = other_health
            .record_provider_failure_record_with_policy(
                None,
                &manifest,
                &session,
                "primary",
                Some("responses"),
                Some("key1"),
                Some("gpt-test"),
                Some("ordinary failure"),
                "V3ProviderRespInbound01Raw",
                500,
                Some("provider_http_error"),
                "ordinary failure",
                200 + index,
            )
            .unwrap();
        assert_eq!(record.state, "healthy");
    }
    assert!(
        !other_health
            .store()
            .scheduling_projection("primary", "key1", "gpt-test", 100, 1, 300)
            .expect("health projection")
            .available
    );
}

#[test]
fn account_http_401_policy_blocks_auth_key_after_two_failures_in_runtime_bridge() {
    let manifest = account_threshold_manifest();
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(
        "account_threshold",
        "account_threshold",
        "401-two-strike-runtime-bridge",
    )
    .expect("failure session scope");
    let policy = find_matching_provider_error_policy(
        &manifest,
        "primary",
        Some("responses"),
        Some("gpt-test"),
        401,
        Some("provider_http_error"),
        "account failure",
    )
    .expect("matched 401 policy");

    let first = health
        .record_provider_failure_record_with_policy(
            Some(policy),
            &manifest,
            &session,
            "primary",
            Some("responses"),
            Some("key1"),
            Some("gpt-test"),
            Some("account failure"),
            "V3ProviderRespInbound01Raw",
            401,
            Some("provider_http_error"),
            "account failure",
            100,
        )
        .expect("first 401 should be recorded by the runtime policy bridge");
    assert_eq!(first.state, "healthy");
    assert!(
        health
            .store()
            .scheduling_projection("primary", "key1", "gpt-test", 1, 1, 100)
            .expect("first-401 scheduling projection")
            .available,
        "first 401 must not block the key before the configured two-strike threshold"
    );

    let second = health
        .record_provider_failure_record_with_policy(
            Some(policy),
            &manifest,
            &session,
            "primary",
            Some("responses"),
            Some("key1"),
            Some("gpt-test"),
            Some("account failure"),
            "V3ProviderRespInbound01Raw",
            401,
            Some("provider_http_error"),
            "account failure",
            101,
        )
        .expect("second 401 should be recorded by the runtime policy bridge");
    assert_eq!(second.state, "cooldown");
    assert_eq!(second.failure_count, 2);
    assert_eq!(second.cooldown_until_ms, Some(18_000_101));
    assert_eq!(
        health
            .store()
            .provider_cooldown_probe_keys_due(18_000_100)
            .expect("probe interval query"),
        Vec::new()
    );
    assert_eq!(
        health
            .store()
            .provider_cooldown_probe_keys_due(18_000_101)
            .expect("probe interval query"),
        vec![("primary".to_string(), Some("key1".to_string()), None,)]
    );
    assert!(
        !health
            .store()
            .scheduling_projection("primary", "key1", "gpt-test", 1, 1, 102)
            .expect("second-401 scheduling projection")
            .available,
        "401 auth key must be unavailable to scheduling after two failures"
    );
    assert!(
        !health
            .store()
            .scheduling_projection("primary", "key1", "gpt-other", 1, 1, 102)
            .expect("sibling-model scheduling projection")
            .available,
        "401 auth key cooldown must block another model under the same provider/auth alias"
    );
    assert!(
        !health
            .store()
            .availability_for_session(&session, "primary", Some("key1"), Some("gpt-other"), 102,)
            .available,
        "401 auth key cooldown must block another model in session availability"
    );
    assert!(
        !health
            .store()
            .scheduling_projection("primary", "key1", "gpt-test", 1, 1, 18_000_100)
            .expect("before-first-auth-probe scheduling projection")
            .available,
        "401 auth key must remain blocked until the first configured probe is due"
    );

    let availability = health.store().availability_for_session(
        &session,
        "primary",
        Some("key1"),
        Some("gpt-test"),
        102,
    );
    assert!(
        !availability.available,
        "401 auth key must be blocked after two failures: {availability:?}"
    );
    assert!(availability
        .blocked_scopes
        .iter()
        .any(|scope| scope.contains("auth_key:primary:key1")));
    assert_eq!(
        health
            .store()
            .provider_cooldown_probe_keys_due(18_000_101)
            .expect("provider cooldown probe query"),
        vec![("primary".to_string(), Some("key1".to_string()), None,)]
    );
}

#[test]
fn account_http_403_policy_blocks_auth_key_after_two_failures_in_runtime_bridge() {
    let manifest = account_threshold_manifest();
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(
        "account_threshold",
        "account_threshold",
        "403-two-strike-runtime-bridge",
    )
    .expect("failure session scope");
    let policy = find_matching_provider_error_policy(
        &manifest,
        "primary",
        Some("responses"),
        Some("gpt-test"),
        403,
        Some("provider_http_error"),
        "account failure",
    )
    .expect("matched 403 policy");

    for now_ms in [100, 101] {
        let record = health
            .record_provider_failure_record_with_policy(
                Some(policy),
                &manifest,
                &session,
                "primary",
                Some("responses"),
                Some("key1"),
                Some("gpt-test"),
                Some("account failure"),
                "V3ProviderRespInbound01Raw",
                403,
                Some("provider_http_error"),
                "account failure",
                now_ms,
            )
            .expect("403 should be recorded by the runtime policy bridge");
        assert_eq!(record.failure_count, (now_ms - 99) as u32);
        assert_eq!(
            record.state,
            if now_ms == 101 { "cooldown" } else { "healthy" }
        );
    }
    assert_eq!(
        health
            .store()
            .scheduling_projection("primary", "key1", "gpt-test", 1, 1, 900_100)
            .expect("403 pre-probe scheduling projection")
            .available,
        false
    );
    assert_eq!(
        health
            .store()
            .provider_cooldown_probe_keys_due(900_101)
            .expect("403 probe due query"),
        vec![("primary".to_string(), Some("key1".to_string()), None,)]
    );
}
