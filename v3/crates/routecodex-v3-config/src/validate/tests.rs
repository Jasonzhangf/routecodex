use super::*;
use std::fs;

#[test]
fn config_compilation_does_not_authorize_codex_samples() {
    let manifest = compile_debug(V3DebugAuthoringConfig {
        codex_samples: None,
        ..V3DebugAuthoringConfig::default()
    })
    .unwrap();
    assert!(!manifest.codex_samples);
}

fn authoring_with(entry: V3ProviderAuthEntryAuthoringConfig) -> V3ProviderAuthAuthoringConfig {
    V3ProviderAuthAuthoringConfig {
        auth_type: V3ProviderAuthType::ApiKey,
        entries: vec![entry],
    }
}

#[test]
fn compile_auth_validates_secret_file_key_at_config_time() {
    let dir = std::env::temp_dir().join(format!("rcc-secret-test-{}", std::process::id()));
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
