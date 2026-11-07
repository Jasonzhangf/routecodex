use super::*;

// 匹配到的 policy 分支会把失败写入 session 策略账本。它必须沿用 failure_action
// 的完整身份指纹（带 source.code 兜底），而不是只认 HTTP 状态码的全局指纹：
// 缺状态码时两类不同的 provider 本地错误会塌进同一个 None 桶，累加到三次冷却。
#[tokio::test]
async fn matched_policy_bridge_does_not_merge_distinct_no_status_classes() {
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
    // 区分。若桥接只传状态码指纹，两者会塌进同一个桶并累加到共享的
    // 连续失败阈值。先各记一次并完成观察：分开计数时 A 类 streak 只有 1，
    // 决不能提前冷却；若合并则两条记录加观察会直接凑满阈值。
    let classes = ["invalid_request_a", "invalid_request_b"];
    let find_cooldown_until = |health: &V3ProviderFailureRuntimeHealth, now_ms: u64| {
        health
            .store()
            .cooldown_entries(now_ms)
            .into_iter()
            .find(|entry| {
                entry.provider_id == "first"
                    && entry.interface_id == "default"
                    && entry.auth_alias.as_deref() == Some("key1")
                    && entry.model_id.as_deref() == Some("gpt-test")
            })
            .and_then(|entry| entry.until_ms)
    };
    // Each class fails twice with its qualified observation completing in
    // between. Counted separately, neither fingerprint reaches the shared
    // consecutive threshold (3); a bridge that collapsed both classes into one
    // status-only fingerprint would hold a streak of four and must commit the
    // cooldown.
    let mut step = 0u64;
    for round in 0..2u64 {
        for class in classes {
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
                    100 + step,
                )
                .expect("ordinary provider policy failure must remain distinct from a Source01 fault");
            // v31: the record is counted immediately, but each distinct
            // no-status class is its own fingerprint, so alternating classes
            // always restart the consecutive series at one.
            assert_eq!(record.state, "pre_cool_observation");
            assert_eq!(
                record.failure_count, 1,
                "class {class} starts its own consecutive-failure series"
            );
            assert_eq!(record.cooldown_until_ms, None);
            complete_due_precool_failures(&health, 101 + step).await;
            step += 1;
        }
    }
    assert_eq!(
        find_cooldown_until(&health, 20_000),
        None,
        "distinct no-status classes must not merge into one consecutive streak"
    );
    assert!(
        health
            .store()
            .availability_for_session(&scope_handle, "first", Some("key1"), Some("gpt-test"), 20_000)
            .available,
        "below the shared threshold the identity must stay routable"
    );
    assert!(
        health
            .availability("first", Some("key1"), Some("other-model"), 101)
            .available
    );
    assert!(
        health
            .availability("first", Some("key2"), Some("gpt-test"), 101)
            .available
    );
}
