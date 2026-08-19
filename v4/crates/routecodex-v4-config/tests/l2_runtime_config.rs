use routecodex_v4_config::{compile_runtime_config, RuntimeConfigError};
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
