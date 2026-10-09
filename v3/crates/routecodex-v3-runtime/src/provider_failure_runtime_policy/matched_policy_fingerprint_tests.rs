use super::*;

// 匹配到的 policy 分支会把失败写入 session 策略账本。它必须沿用 failure_action
// 的完整身份指纹（带 source.code 兜底），而不是只认 HTTP 状态码的全局指纹：
// 缺状态码时两类不同的 provider 本地错误会塌进同一个 None 桶，累加到三次冷却。
#[test]
fn matched_policy_bridge_does_not_merge_distinct_no_status_classes() {
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
status = 400
reason_code = "matched_class"
public_code = "E_MATCHED_CLASS"
message_mode = "code_only"
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
    // 区分。若桥接只传状态码指纹，两者会塌进同一个桶并累加到三次冷却。
    let classes = ["invalid_request_a", "invalid_request_b"];
    for (index, class) in classes.iter().enumerate() {
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
                Some(*class),
                "matched class failure",
                100 + index as u64,
            )
            .expect("matched-policy failure should record");
        assert_eq!(
            record.failure_count, 1,
            "class {class} must start its own streak instead of inheriting the other class' count"
        );
        let available = health
            .store()
            .availability_for_session(
                &scope_handle,
                "first",
                Some("key1"),
                Some("gpt-test"),
                100 + index as u64,
            )
            .available;
        assert!(
            !available,
            "threshold one blocks only this complete identity"
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
}
