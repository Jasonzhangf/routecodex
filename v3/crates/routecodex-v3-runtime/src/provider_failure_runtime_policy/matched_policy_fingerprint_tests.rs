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
        assert_eq!(record.state, "pre_cool_observation");
        assert_eq!(
            record.failure_count, 0,
            "class {class} health counters wait for the qualified observation"
        );
        assert_eq!(record.cooldown_until_ms, None);
    }
    complete_due_precool_failures(&health, 101).await;
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
        Some(5_101),
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
