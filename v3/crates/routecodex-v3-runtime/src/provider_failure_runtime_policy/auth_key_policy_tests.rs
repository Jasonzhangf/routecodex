use super::*;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};

static PRECOOL_OBSERVATION_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
max_attempts = 1
backoff_ms = 0
[[error.provider_error_action_policy.path]]
step = "cooldown"
scope = "auth_key"
duration_ms = 5000
[[error.provider_error_action_policy.path]]
step = "project"
reason_code = "provider_account_http_401"

[[error.provider_error_action_policy]]
policy_id = "account_http_403_two_errors"
[error.provider_error_action_policy.match]
http_status = 403
[[error.provider_error_action_policy.path]]
step = "wait_retry"
retry_mode = "reselect_before_client_projection"
max_attempts = 1
backoff_ms = 0
[[error.provider_error_action_policy.path]]
step = "cooldown"
scope = "auth_key"
duration_ms = 5000
[[error.provider_error_action_policy.path]]
step = "project"
reason_code = "provider_account_http_403"

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

fn observed_cooldown_until_ms(
    health: &V3ProviderFailureRuntimeHealth,
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
    now_ms: u64,
) -> Option<u64> {
    health
        .store()
        .cooldown_entries(now_ms)
        .into_iter()
        .find(|entry| {
            entry.provider_id == provider_id
                && entry.interface_id == interface_id
                && entry.auth_alias.as_deref() == auth_alias
                && entry.model_id.as_deref() == model_id
        })
        .and_then(|entry| entry.until_ms)
}

fn account_http_source(status: u16) -> V3Error01SourceRaised {
    routecodex_v3_error::build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        format!("provider_http_{status}"),
        "account failure",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(status),
            code: Some(format!("HTTP_{status}")),
            provider_id: Some("primary".into()),
            upstream_request_id: None,
            message: Some("account failure".into()),
        },
    )
}

#[tokio::test]
async fn runtime_policy_blocks_account_errors_immediately_and_recoverable_after_threshold() {
    let _guard = PRECOOL_OBSERVATION_TEST_LOCK.lock().await;
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
                .expect(
                    "ordinary provider policy failure must remain distinct from a Source01 fault",
                );
            assert_eq!(record.state, "pre_cool_observation");
            assert_eq!(record.failure_count, 0);
            assert_eq!(record.cooldown_until_ms, None);
        }
        complete_due_precool_failures(&health, 101).await;
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
    for index in 0..10 {
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
                200 + index as u64,
            )
            .expect("ordinary provider policy failure must remain distinct from a Source01 fault");
        assert_eq!(record.state, "pre_cool_observation");
        assert_eq!(record.failure_count, 0);
        assert_eq!(record.cooldown_until_ms, None);
    }
    complete_due_precool_failures(&other_health, 202).await;
    assert!(
        !other_health
            .store()
            .scheduling_projection("primary", "key1", "gpt-test", 100, 1, 300)
            .expect("health projection")
            .available,
        "ten committed observations must start the one-hour cooldown"
    );
}

#[tokio::test]
async fn account_http_401_policy_blocks_auth_key_on_first_failure_in_runtime_bridge() {
    let _guard = PRECOOL_OBSERVATION_TEST_LOCK.lock().await;
    let manifest = account_threshold_manifest();
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(
        "account_threshold",
        "account_threshold",
        "401-observed-http-runtime-bridge",
    )
    .expect("failure session scope");
    find_matching_provider_error_policy(
        &manifest,
        session.routing_group(),
        "primary",
        Some("responses"),
        Some("gpt-test"),
        401,
        Some("provider_http_error"),
        "account failure",
    )
    .expect("matched 401 policy");

    let first = health
        .record_provider_failure_record_from_source(
            &session,
            "primary",
            Some("key1"),
            Some("gpt-test"),
            &account_http_source(401),
            100,
        )
        .expect("the bridge must accept the captured HTTP 401 source");
    assert_eq!(first.state, "cooldown");
    assert_eq!(first.failure_count, 1);
    assert_eq!(first.cooldown_until_ms, Some(3_600_100));
    assert!(
        !health
            .store()
            .scheduling_projection("primary", "key1", "gpt-test", 1, 1, 102)
            .expect("observed 401 scheduling projection")
            .available,
        "the policy bridge must expose the confirmed 401 block after observation"
    );
    assert_eq!(
        health
            .store()
            .provider_cooldown_probe_next_deadline_ms("primary", Some("key1"), Some("gpt-test"),)
            .expect("401 probe deadline"),
        Some(5_100),
        "the first probe remains scheduled five seconds after observation"
    );
    assert!(
        observed_cooldown_until_ms(
            &health,
            "primary",
            "default",
            Some("key1"),
            Some("gpt-test"),
            10_100,
        )
        .is_some(),
        "the policy bridge must retain a committed cooldown for the exact identity"
    );
    assert!(health
        .store()
        .provider_cooldown_probe_keys_due(5_099)
        .expect("probe not due before initial five seconds")
        .is_empty());
    assert_eq!(
        health
            .store()
            .provider_cooldown_probe_keys_due(5_100)
            .expect("probe interval query"),
        vec![(
            "primary".to_string(),
            Some("key1".to_string()),
            Some("gpt-test".to_string()),
        )]
    );
    assert!(
        !health
            .store()
            .scheduling_projection("primary", "key1", "gpt-test", 1, 1, 102)
            .expect("second-401 scheduling projection")
            .available,
        "the exact identity stays unavailable after the observed failure"
    );
    assert!(
        health
            .store()
            .scheduling_projection("primary", "key1", "gpt-other", 1, 1, 102)
            .expect("sibling-model scheduling projection")
            .available,
        "401 must leave another model under the same key available"
    );
    assert!(
        health
            .store()
            .availability_for_session(&session, "primary", Some("key1"), Some("gpt-other"), 102,)
            .available,
        "401 must leave another model available in the session"
    );
    assert!(
        !health
            .store()
            .scheduling_projection("primary", "key1", "gpt-test", 1, 1, 5_100)
            .expect("before-first-auth-probe scheduling projection")
            .available,
        "401 auth key must remain blocked while its recovery owner is pending"
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
        "401 auth key must be blocked after one failure: {availability:?}"
    );
    assert!(availability
        .blocked_scopes
        .iter()
        .any(|scope| scope == "provider_cooldown_probe_pending"));
    assert_eq!(
        health
            .store()
            .provider_cooldown_probe_keys_due(5_100)
            .expect("provider cooldown probe query"),
        vec![(
            "primary".to_string(),
            Some("key1".to_string()),
            Some("gpt-test".to_string()),
        )]
    );
}

#[tokio::test]
async fn account_http_403_policy_blocks_auth_key_on_first_failure_in_runtime_bridge() {
    let _guard = PRECOOL_OBSERVATION_TEST_LOCK.lock().await;
    let manifest = account_threshold_manifest();
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(
        "account_threshold",
        "account_threshold",
        "403-observed-http-runtime-bridge",
    )
    .expect("failure session scope");
    find_matching_provider_error_policy(
        &manifest,
        session.routing_group(),
        "primary",
        Some("responses"),
        Some("gpt-test"),
        403,
        Some("provider_http_error"),
        "account failure",
    )
    .expect("matched 403 policy");

    let record = health
        .record_provider_failure_record_from_source(
            &session,
            "primary",
            Some("key1"),
            Some("gpt-test"),
            &account_http_source(403),
            100,
        )
        .expect("the bridge must accept the captured HTTP 403 source");
    assert_eq!(record.state, "cooldown");
    assert_eq!(record.failure_count, 1);
    assert_eq!(record.cooldown_until_ms, Some(3_600_100));
    assert_eq!(
        observed_cooldown_until_ms(
            &health,
            "primary",
            "default",
            Some("key1"),
            Some("gpt-test"),
            10_100,
        ),
        Some(3_600_100),
        "confirmed 403 must retain the exact one-hour cooldown"
    );
    assert_eq!(
        health
            .store()
            .scheduling_projection("primary", "key1", "gpt-test", 1, 1, 10_101)
            .expect("403 pre-probe scheduling projection")
            .available,
        false
    );
    assert_eq!(
        health
            .store()
            .provider_cooldown_probe_keys_due(5_100)
            .expect("403 probe due query"),
        vec![(
            "primary".to_string(),
            Some("key1".to_string()),
            Some("gpt-test".to_string()),
        )]
    );
}

#[tokio::test]
async fn anthropic_response_body_decode_failure_cools_only_failed_model_after_ten() {
    let _guard = PRECOOL_OBSERVATION_TEST_LOCK.lock().await;
    let mut authoring = parse_v3_config_02_authoring(
        r#"
version = 3
[servers.test]
bind = "127.0.0.1"
port = 5555
routing_group = "test"
endpoints = ["responses"]
[providers.cc-anthropic]
type = "anthropic"
base_url = "http://anthropic.invalid/v1"
default_model = "opus-5"
auth = { type = "api_key", entries = [{ alias = "key1", env = "ANTHROPIC_KEY" }] }
[providers.cc-anthropic.models.opus-5]
wire_name = "claude-opus-5"
capabilities = ["text", "tools", "reasoning"]
[providers.cc-anthropic.models.sonnet-5]
wire_name = "claude-sonnet-5"
capabilities = ["text", "tools", "reasoning"]
[route_groups.test.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "cc-anthropic", model = "opus-5", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "cc-anthropic", model = "sonnet-5", key = "key1", priority = 1 },
]
"#,
    )
    .expect("test provider authoring");
    authoring.error = routecodex_v3_config::internal::v3_internal_user_config_authoring().error;
    let manifest = compile_v3_config_05_manifest(authoring)
        .expect("internal provider failure policy must compile");
    let policy = find_matching_provider_error_policy(
        &manifest,
        "gateway_priority_4444",
        "cc-anthropic",
        Some("anthropic"),
        Some("opus-5"),
        502,
        Some("provider_runtime_error"),
        "provider cc-anthropic response body failed: error decoding response body",
    )
    .expect("Anthropic response body decode policy must match");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(
        "routecodex_v3_4444",
        "gateway_priority_4444",
        "anthropic-body-decode-policy",
    )
    .expect("failure session scope");

    for attempt in 0..10 {
        let now_ms = 100 + attempt as u64;
        let record = health
            .record_provider_failure_record_with_policy(
                Some(policy),
                &manifest,
                &session,
                "cc-anthropic",
                Some("anthropic"),
                Some("key1"),
                Some("opus-5"),
                Some("error decoding response body"),
                "V3ProviderRespInbound01Raw",
                502,
                Some("provider_runtime_error"),
                "provider cc-anthropic response body failed: error decoding response body",
                now_ms,
            )
            .expect("Anthropic body decode failure must be recorded");
        assert_eq!(record.state, "pre_cool_observation");
        assert_eq!(record.failure_count, 0);
        assert_eq!(record.cooldown_until_ms, None);
    }
    complete_due_precool_failures(&health, 101).await;
    for attempt in 0..2 {
        let model_available = health
            .store()
            .scheduling_projection("cc-anthropic", "key1", "opus-5", 100, 1, 101)
            .expect("Anthropic scheduling projection")
            .available;
        assert_eq!(
            model_available,
            false,
            "ten observed response-body decode failures cool only the failed identity; attempt={attempt}"
        );
        assert!(
            health
                .store()
                .scheduling_projection("cc-anthropic", "key1", "sonnet-5", 100, 1, 101)
                .expect("sibling model scheduling projection")
                .available,
            "the sibling model must stay available on every attempt"
        );
    }
}
