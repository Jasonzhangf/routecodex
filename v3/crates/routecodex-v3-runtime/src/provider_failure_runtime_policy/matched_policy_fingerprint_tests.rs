use super::*;

// 匹配到的 policy 分支会把失败写入 session 策略账本。它必须沿用 failure_action
// 的完整身份指纹（带 source.code 兜底），而不是只认 HTTP 状态码。指纹保留
// typed 证据；同一个完整身份的 recoverable 连续计数仍然共享。
#[tokio::test]
async fn matched_policy_bridge_shares_identity_streak_across_distinct_no_status_classes() {
    let scope = "matched_policy_fingerprint";
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["responses"]
[providers.first]
type = "responses"
base_url = "http://first.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "FIRST_KEY" }] }
[providers.first.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text", "tools"]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 1 }
]
[[error.provider_error_action_policy]]
policy_id = "no_status_match"
scope = { provider_type = "responses", model_id = "gpt-test" }
match = { http_status = 200 }
[[error.provider_error_action_policy.path]]
step = "cooldown"
scope = "auth_key"
duration_ms = 5000
[[error.provider_error_action_policy.path]]
step = "project"
reason_code = "matched_class"
public_code = "E_MATCHED_CLASS"
"#
    .replace("__SCOPE__", scope);
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("matched-policy authoring"),
    )
    .expect("matched-policy manifest");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let scope_handle = test_provider_failure_scope(scope, scope, "matched-policy-fingerprint")
        .expect("failure session scope");
    let policy = manifest
        .error
        .provider_error_action_policy
        .iter()
        .find(|policy| policy.policy_id == "no_status_match")
        .expect("matched-policy fixture must expose its directive");
    // 400 无全局分类指纹：两类不同的 provider 本地错误都只能靠 source.code
    // 区分。指纹必须保留 typed 证据，但不得把同一身份的连续计数拆开。
    let classes = ["invalid_request_a", "invalid_request_b"];
    for index in 0..10 {
        let class = classes[index % classes.len()];
        let record = health
            .record_provider_failure_record_with_policy(
                Some(policy),
                &manifest,
                &scope_handle,
                "first",
                Some("responses"),
                Some("key1"),
                Some("gpt-test"),
                Some("matched policy failure"),
                "V3ProviderRespInbound01Raw",
                400,
                Some(class),
                "matched class failure",
                100 + index as u64,
            )
            .expect("ordinary provider policy failure must remain distinct from a Source01 fault");
        assert_eq!(
            record.failure_count,
            index as u32 + 1,
            "class {class} must count the actual failure once"
        );
        assert_eq!(record.cooldown_until_ms, (index == 9).then_some(3_600_109));
    }
    assert!(
        !health
            .store()
            .availability_for_session(&scope_handle, "first", Some("key1"), Some("gpt-test"), 101)
            .available,
        "ten mixed no-status observations on one identity must commit cooldown"
    );
    assert_eq!(
        health
            .store()
            .provider_cooldown_probe_next_deadline_ms("first", Some("key1"), Some("gpt-test"))
            .expect("matched-policy probe deadline"),
        Some(5_109),
        "cooldown owns the first five-second probe cadence"
    );
    assert!(
        health
            .availability("first", Some("key1"), Some("other-model"), 101)
            .available,
        "the cooldown must not leak to another model"
    );
    assert!(
        health
            .availability("first", Some("key2"), Some("gpt-test"), 101)
            .available,
        "the cooldown must not leak to another key"
    );
}

#[test]
fn internal_xingchiapi_transport_connection_closed_policy_cools_at_third_failure_and_recovers_on_success(
) {
    let source = r#"
version = 3
[servers.xingchi_repeat]
bind = "127.0.0.1"
port = 5556
routing_group = "xingchi_repeat"
endpoints = ["responses"]
[providers.xingchiapi]
type = "responses"
base_url = "http://xingchi.invalid/v1"
default_model = "gpt-6.1-sol"
auth = { type = "api_key", entries = [{ alias = "key10", env = "XINGCHI_TEST_KEY" }] }
[providers.xingchiapi.models."gpt-6.1-sol"]
wire_name = "gpt-6.1-sol"
capabilities = ["text", "tools"]
[route_groups.xingchi_repeat.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "xingchiapi", model = "gpt-6.1-sol", key = "key10", priority = 1 }
]
"#;
    let mut authoring = parse_v3_config_02_authoring(source).expect("authoring");
    authoring.error = routecodex_v3_config::internal::v3_internal_user_config_authoring().error;
    let manifest = compile_v3_config_05_manifest(authoring).expect("manifest");
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope("xingchi_repeat", "xingchi_repeat", "s1").unwrap();
    let msg = "provider xingchiapi transport failed for request r1: error sending request for url (https://api.xingchiapi.com/v1/responses): client error (SendRequest): connection closed before message completed";
    let err_source = build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3Transport13ResponsesHttpRequest",
        "provider_transport_error",
        msg,
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Transport,
            status: None,
            code: Some("TRANSPORT_ERROR".to_string()),
            provider_id: Some("xingchiapi".to_string()),
            upstream_request_id: None,
            message: Some(msg.to_string()),
        },
    );

    let http_500 = build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        "HTTP_500",
        "upstream http 500",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(500),
            code: Some("HTTP_500".to_string()),
            provider_id: Some("xingchiapi".to_string()),
            upstream_request_id: None,
            message: Some("upstream http 500".to_string()),
        },
    );

    // Mixed sequence: 1x connection_closed, interrupted by 2x HTTP 500, then 1x connection_closed
    // must NOT reach the 3-failure threshold by sharing HTTP 500's streak.
    let pre = health
        .record_provider_failure_record_from_source_with_policy_for_interface(
            Some(&manifest),
            &scope,
            "xingchiapi",
            "default",
            Some("responses"),
            Some("key10"),
            Some("gpt-6.1-sol"),
            &err_source,
            502,
            50,
        )
        .unwrap();
    assert_eq!(pre.failure_count, 1);
    for step in 0..2_u64 {
        let mixed = health
            .record_provider_failure_record_from_source_with_policy_for_interface(
                Some(&manifest),
                &scope,
                "xingchiapi",
                "default",
                Some("responses"),
                Some("key10"),
                Some("gpt-6.1-sol"),
                &http_500,
                500,
                60 + step,
            )
            .unwrap();
        assert_eq!(mixed.state, "provider_failure_observed");
        assert!(mixed.cooldown_until_ms.is_none());
    }

    for idx in 0..3_u64 {
        let rec = health
            .record_provider_failure_record_from_source_with_policy_for_interface(
                Some(&manifest),
                &scope,
                "xingchiapi",
                "default",
                Some("responses"),
                Some("key10"),
                Some("gpt-6.1-sol"),
                &err_source,
                502,
                100 + idx,
            )
            .unwrap();
        assert_eq!(rec.failure_count, (idx + 1) as u32);
        if idx < 2 {
            assert_eq!(rec.state, "provider_failure_observed");
            assert!(rec.cooldown_until_ms.is_none());
        } else {
            assert_eq!(rec.state, "cooldown");
            assert_eq!(
                rec.cooldown_until_ms,
                Some(102 + 5_000),
                "internal.toml declares duration_ms=5000 for xingchiapi_transport_connection_closed"
            );
        }
    }
    assert!(
        !health
            .availability_for_interface(
                "xingchiapi",
                "default",
                Some("key10"),
                Some("gpt-6.1-sol"),
                5_101,
            )
            .available,
        "identity must remain cooled right before declared 5000ms expiry"
    );
    let routecodex_v3_provider_responses::V3ProviderBusinessRecoveryAcquisition::Acquired(permit) =
        health
            .store()
            .acquire_provider_business_recovery_trial_for_interface(
                "xingchiapi",
                "default",
                Some("key10"),
                Some("gpt-6.1-sol"),
                5_103,
            )
            .expect("trial check")
    else {
        panic!("trial should open immediately after declared 5000ms cooldown expiry");
    };
    health
        .store()
        .complete_provider_business_recovery_success_with_permit(&permit, 5_110)
        .expect("business recovery clear");
    assert!(
        health
            .availability_for_interface(
                "xingchiapi",
                "default",
                Some("key10"),
                Some("gpt-6.1-sol"),
                5_110,
            )
            .available
    );
}
