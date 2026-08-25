use routecodex_v4_config::{compile_product_config, compile_runtime_config, compile_runtime_config_file, RuntimeConfigError};
use std::path::Path;

fn config(extra: &str) -> String {
    format!(
        r#"
version = 4

[runtime]
id = "rccv4"

[[listeners]]
id = "primary"
address = "127.0.0.1:61234"

[[providers]]
provider_id = "cc-sol"
config_path = "providers/cc-sol.toml"
protocol = "responses"
wire_model = "gpt-5.6-sol"
priority = 1
entry_models = ["gpt-5.5", "gpt-5.6-sol"]

[[routes]]
id = "default"
models = ["gpt-5.5", "gpt-5.6-sol"]
targets = ["cc-sol"]
{extra}
"#
    )
}

#[test]
fn compiles_deterministic_secret_free_runtime_manifest() {
    let first = compile_runtime_config(&config(""), Some(Path::new("/tmp/v4"))).expect("compile");
    let second = compile_runtime_config(&config(""), Some(Path::new("/tmp/v4"))).expect("compile");
    assert_eq!(first, second);
    assert_eq!(first.runtime_identity, "rccv4");
    assert_eq!(first.listeners[0].address, "127.0.0.1:61234");
    assert_eq!(first.providers[0].wire_model, "gpt-5.6-sol");
    assert_eq!(first.providers[0].config_path, "/tmp/v4/providers/cc-sol.toml");
    assert!(first.verify().is_ok());
    let json = String::from_utf8(first.to_json().expect("json")).expect("utf8");
    assert!(!json.contains("api_key"));
    assert!(!json.contains("secret"));
}

#[test]
fn manifest_digest_drift_fails_fast() {
    let mut manifest = compile_runtime_config(&config(""), Some(Path::new("/tmp/v4"))).expect("compile");
    manifest.listeners[0].address = "127.0.0.1:61235".to_string();
    assert!(matches!(manifest.verify(), Err(RuntimeConfigError::DigestDrift { .. })));
}

#[test]
fn unknown_or_secret_authoring_fields_fail_fast() {
    assert!(matches!(
        compile_runtime_config(&config("\nunknown = true"), None),
        Err(RuntimeConfigError::Parse(_))
    ));
    let secret = config("").replace(
        "entry_models = [\"gpt-5.5\", \"gpt-5.6-sol\"]",
        "entry_models = [\"gpt-5.5\", \"gpt-5.6-sol\"]\napi_key = \"forbidden\"",
    );
    assert!(matches!(
        compile_runtime_config(&secret, None),
        Err(RuntimeConfigError::Parse(_))
    ));
}

#[test]
fn unknown_route_target_and_unserved_model_fail_fast() {
    let unknown = config("").replace("targets = [\"cc-sol\"]", "targets = [\"missing\"]");
    assert!(matches!(
        compile_runtime_config(&unknown, None),
        Err(RuntimeConfigError::RouteTargetUnknown { .. })
    ));
    let unserved = config("").replace(
        "models = [\"gpt-5.5\", \"gpt-5.6-sol\"]\ntargets",
        "models = [\"gpt-unknown\"]\ntargets",
    );
    assert!(matches!(
        compile_runtime_config(&unserved, None),
        Err(RuntimeConfigError::RouteModelUnserved { .. })
    ));
}

fn v3_7777_product_fixture(extra: &str) -> String {
    format!(
        r#"
version = 4

[runtime]
id = "rccv4"

[[listeners]]
id = "primary"
address = "127.0.0.1:5520"

[[providers]]
provider_id = "minimax_responses"
config_path = "provider/minimax_responses/config.v2.toml"
protocol = "responses"
wire_model = "MiniMax-M3"
priority = 1
entry_models = ["MiniMax-M3"]

[[routes]]
id = "default"
models = ["MiniMax-M3"]
targets = ["minimax_responses"]

[product]
source = "v3-baseline:responses_v3_7777"

[[product.providers]]
provider_id = "opencode-go"
protocol = "responses"
config_path = "provider/opencode-go/config.v2.toml"

[[product.providers.models]]
model_id = "deepseek-v4-flash"
wire_name = "deepseek-v4-flash"
capabilities = ["reasoning", "tools"]

[[product.providers.auth_handles]]
alias = "key1"
source = "token_file:/Volumes/extension/.rcc/secrets/v3/opencode-go.conf#opencode.key1"

[[product.providers]]
provider_id = "minimax_anthropic"
protocol = "anthropic"
config_path = "provider/minimax_anthropic/config.v2.toml"

[[product.providers.models]]
model_id = "MiniMax-M3"
wire_name = "MiniMax-M3"
capabilities = ["multimodal", "reasoning", "tools", "web_search"]

[[product.route_groups]]
route_group_id = "responses_v3_7777"

[[product.route_groups.pools]]
pool_id = "default"
selection = "priority"
entry_protocol = "responses"
required_capabilities = ["reasoning"]

[[product.route_groups.pools.targets]]
provider_id = "opencode-go"
model_id = "deepseek-v4-flash"
priority = 1
weight = 1

[[product.route_groups.pools.targets]]
provider_id = "minimax_anthropic"
model_id = "MiniMax-M3"
priority = 2
weight = 1

[[product.error_policies]]
policy_id = "account_http_401_two_errors"
match_status = 401
reason_code = "provider_account_http_401"

[[product.error_policies.actions]]
step = "wait_retry"
retry_mode = "reselect_before_client_projection"
max_attempts = 2
backoff_ms = 1000

[[product.error_policies.actions]]
step = "project"
status = 502
{extra}
"#
    )
}

#[test]
// This is the first V3-7777 parity fixture. It is intentionally kept separate
// from the flat canary route so the next router/provider slices can consume the
// product declarations without changing the current V4 live path.
fn product_config_import_is_deterministic_and_secret_free() {
    let first = compile_runtime_config(&v3_7777_product_fixture(""), Some(Path::new("/tmp/v4")))
        .expect("compile product fixture");
    let second = compile_runtime_config(&v3_7777_product_fixture(""), Some(Path::new("/tmp/v4")))
        .expect("compile product fixture");
    assert_eq!(first, second);
    let product = first.product.as_ref().expect("product declarations");
    assert_eq!(product.route_groups[0].route_group_id, "responses_v3_7777");
    assert_eq!(product.providers.len(), 2);
    assert_eq!(product.error_policies[0].policy_id, "account_http_401_two_errors");
    let json = String::from_utf8(first.to_json().expect("json")).expect("utf8");
    assert!(!json.contains("sk-"));
    assert!(json.contains("token_file:/Volumes/extension/.rcc/secrets/v3/opencode-go.conf#opencode.key1"));
}

#[test]
fn product_config_rejects_inline_secret_and_unknown_target() {
    let inline_secret = v3_7777_product_fixture("").replace(
        "source = \"token_file:/Volumes/extension/.rcc/secrets/v3/opencode-go.conf#opencode.key1\"",
        "source = \"sk-inline-secret\"",
    );
    assert!(matches!(
        compile_runtime_config(&inline_secret, None),
        Err(RuntimeConfigError::ProductAuthHandleInvalid)
    ));
    let unknown_target = v3_7777_product_fixture("").replace(
        "provider_id = \"minimax_anthropic\"\nmodel_id = \"MiniMax-M3\"",
        "provider_id = \"missing\"\nmodel_id = \"MiniMax-M3\"",
    );
    assert!(matches!(
        compile_runtime_config(&unknown_target, None),
        Err(RuntimeConfigError::ProductTargetUnknown)
    ));
}

#[test]
fn v3_7777_fixture_preserves_all_route_pools_and_targets() {
    let product = compile_product_config(
        include_str!("../../../tests/resources/config/v3-responses-7777-product.toml"),
        Some(Path::new("/tmp/v4")),
    )
    .expect("compile 7777 product fixture");
    assert_eq!(product.source, "v3-baseline:responses_v3_7777");
    assert_eq!(product.providers.len(), 6);
    assert_eq!(
        product
            .providers
            .iter()
            .map(|provider| provider.provider_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "cc-sol",
            "glmrelay_anthropic",
            "minimax_anthropic",
            "modrouter_anthropic",
            "opencode-go",
            "opencode-go-zen",
        ]
    );
    assert_eq!(product.route_groups.len(), 1);
    assert_eq!(product.route_groups[0].pools.len(), 10);
    assert_eq!(
        product.route_groups[0]
            .pools
            .iter()
            .map(|pool| pool.pool_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "anthropic_entry",
            "coding",
            "default",
            "longcontext",
            "multimodal",
            "ox_alpha_direct",
            "search",
            "thinking",
            "tools",
            "web_search",
        ]
    );
    let target_count: usize = product.route_groups[0]
        .pools
        .iter()
        .map(|pool| pool.targets.len())
        .sum();
    assert_eq!(target_count, 43);
    assert_eq!(product.route_groups[0].pools[0].pool_id, "anthropic_entry");
    assert_eq!(product.route_groups[0].pools[0].precedence, Some(100));
    let longcontext = product.route_groups[0]
        .pools
        .iter()
        .find(|pool| pool.pool_id == "longcontext")
        .expect("longcontext pool");
    assert_eq!(longcontext.min_input_tokens, Some(180000));
    assert_eq!(product.default_error_path.len(), 3);
    assert_eq!(product.error_policies.len(), 4);
    assert_eq!(
        product.error_policies[0].policy_id,
        "account_http_401_two_errors"
    );
    assert_eq!(
        product.error_policies[2].match_content_contains_any,
        vec!["system cpu overloaded"]
    );
}

#[test]
fn live_authoring_consumes_product_config_path_into_manifest() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/resources/config/v4-live-product-runtime.toml");
    let manifest = compile_runtime_config_file(&path).expect("compile live product authoring");
    let product = manifest.product.as_ref().expect("product manifest consumer");
    let baseline = compile_product_config(
        include_str!("../../../tests/resources/config/v3-responses-7777-product.toml"),
        Some(
            std::fs::canonicalize(&path)
                .expect("canonical fixture path")
                .parent()
                .expect("fixture directory"),
        ),
    )
    .expect("compile baseline product");
    assert_eq!(product, &baseline, "live manifest product differs from normalized baseline");
    assert_eq!(product.source, "v3-baseline:responses_v3_7777");
    assert_eq!(manifest.listeners[0].address, "127.0.0.1:5520");
    assert_eq!(product.providers.len(), 6);
    assert!(product
        .providers
        .iter()
        .all(|provider| Path::new(&provider.config_path).is_absolute()));
    assert!(manifest.verify().is_ok());
}
