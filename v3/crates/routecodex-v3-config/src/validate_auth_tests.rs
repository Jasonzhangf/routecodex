use crate::types::*;
use crate::validate::compile_auth;
use std::fs;

fn authoring_with(entry: V3ProviderAuthEntryAuthoringConfig) -> V3ProviderAuthAuthoringConfig {
    V3ProviderAuthAuthoringConfig {
        auth_type: V3ProviderAuthType::ApiKey,
        selection: V3SelectionPolicy::default(),
        entries: vec![entry],
    }
}

#[test]
fn compile_auth_validates_secret_file_key_at_config_time() {
    let dir = std::env::temp_dir().join(format!(
        "rcc-secret-test-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("secrets.conf");
    fs::write(&file, "opencode-go.key1 = \"sk-one\"\n").unwrap();
    let file_str = file.display().to_string();

    let ok = compile_auth(
        "p",
        authoring_with(V3ProviderAuthEntryAuthoringConfig {
            alias: "key1".to_string(),
            env: None,
            token_file: None,
            api_key: None,
            priority: None,
            weight: None,
            secret_file: Some(file_str.clone()),
            secret_key: Some("opencode-go.key1".to_string()),
        }),
    )
    .unwrap();
    assert_eq!(
        ok.entries[0].secret_file.as_deref(),
        Some(file_str.as_str())
    );
    assert_eq!(
        ok.entries[0].secret_key.as_deref(),
        Some("opencode-go.key1")
    );

    let err = compile_auth(
        "p",
        authoring_with(V3ProviderAuthEntryAuthoringConfig {
            alias: "key1".to_string(),
            env: None,
            token_file: None,
            api_key: None,
            priority: None,
            weight: None,
            secret_file: Some(file_str),
            secret_key: Some("missing.key".to_string()),
        }),
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("secret_file validation failed"),
        "{err}"
    );

    let pair_err = compile_auth(
        "p",
        authoring_with(V3ProviderAuthEntryAuthoringConfig {
            alias: "key1".to_string(),
            env: None,
            token_file: None,
            api_key: None,
            priority: None,
            weight: None,
            secret_file: Some("x".to_string()),
            secret_key: None,
        }),
    )
    .unwrap_err();
    assert!(
        pair_err.to_string().contains("declared together"),
        "{pair_err}"
    );
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn compile_auth_rejects_round_robin_strategy() {
    let mut authoring = authoring_with(V3ProviderAuthEntryAuthoringConfig {
        alias: "key1".to_string(),
        priority: None,
        weight: None,
        env: Some("PROVIDER_KEY".to_string()),
        token_file: None,
        api_key: None,
        secret_file: None,
        secret_key: None,
    });
    authoring.selection.strategy = V3SelectionStrategy::RoundRobin;
    let error = compile_auth("p", authoring).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("only supports priority or weighted"),
        "{error}"
    );
}

#[test]
fn compile_auth_rejects_invalid_priority_and_weight() {
    let error = compile_auth(
        "p",
        authoring_with(V3ProviderAuthEntryAuthoringConfig {
            alias: "key1".to_string(),
            priority: Some(-1),
            weight: None,
            env: Some("PROVIDER_KEY".to_string()),
            token_file: None,
            api_key: None,
            secret_file: None,
            secret_key: None,
        }),
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("priority cannot be negative"),
        "{error}"
    );

    let error = compile_auth(
        "p",
        authoring_with(V3ProviderAuthEntryAuthoringConfig {
            alias: "key1".to_string(),
            priority: None,
            weight: Some(0),
            env: Some("PROVIDER_KEY".to_string()),
            token_file: None,
            api_key: None,
            secret_file: None,
            secret_key: None,
        }),
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("weight must be positive"),
        "{error}"
    );
}
