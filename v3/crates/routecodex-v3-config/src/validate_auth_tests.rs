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
            oauth_source: None,
            refresh_endpoint: None,
            client_id: None,
            refresh_before_seconds: None,
            oauth_store: None,
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
            oauth_source: None,
            refresh_endpoint: None,
            client_id: None,
            refresh_before_seconds: None,
            oauth_store: None,
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
            oauth_source: None,
            refresh_endpoint: None,
            client_id: None,
            refresh_before_seconds: None,
            oauth_store: None,
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
        oauth_source: None,
        refresh_endpoint: None,
        client_id: None,
        refresh_before_seconds: None,
        oauth_store: None,
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
            oauth_source: None,
            refresh_endpoint: None,
            client_id: None,
            refresh_before_seconds: None,
            oauth_store: None,
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
            oauth_source: None,
            refresh_endpoint: None,
            client_id: None,
            refresh_before_seconds: None,
            oauth_store: None,
        }),
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("weight must be positive"),
        "{error}"
    );
}

fn oauth_authoring(entry: V3ProviderAuthEntryAuthoringConfig) -> V3ProviderAuthAuthoringConfig {
    V3ProviderAuthAuthoringConfig {
        auth_type: V3ProviderAuthType::OAuth,
        selection: V3SelectionPolicy::default(),
        entries: vec![entry],
    }
}

fn oauth_entry(
    source_path: &str,
    store: routecodex_v3_oauth::V3OAuthStore,
) -> V3ProviderAuthEntryAuthoringConfig {
    V3ProviderAuthEntryAuthoringConfig {
        alias: "oauth-key".to_string(),
        priority: None,
        weight: None,
        env: None,
        token_file: None,
        api_key: None,
        secret_file: None,
        secret_key: None,
        oauth_source: Some(routecodex_v3_oauth::V3OAuthSource::CodexAuthJson {
            path: source_path.to_string(),
        }),
        refresh_endpoint: Some("https://token.example/refresh".to_string()),
        client_id: Some("client-secret-sentinel".to_string()),
        refresh_before_seconds: None,
        oauth_store: Some(store),
    }
}

#[test]
fn compile_auth_emits_oauth_declaration_and_default_refresh_window() {
    let manifest = compile_auth(
        "p",
        oauth_authoring(oauth_entry(
            "/tmp/codex-auth.json",
            routecodex_v3_oauth::V3OAuthStore::Memory,
        )),
    )
    .unwrap();

    let declaration = manifest.entries[0]
        .oauth_declaration
        .as_ref()
        .expect("oauth declaration");
    assert_eq!(
        declaration.refresh_endpoint,
        "https://token.example/refresh"
    );
    assert_eq!(declaration.client_id, "client-secret-sentinel");
    assert_eq!(
        declaration.refresh_before_seconds,
        routecodex_v3_oauth::default_refresh_before_seconds()
    );
    assert_eq!(
        declaration.oauth_source,
        routecodex_v3_oauth::V3OAuthSource::CodexAuthJson {
            path: "/tmp/codex-auth.json".to_string(),
        }
    );
    assert_eq!(
        declaration.oauth_store,
        routecodex_v3_oauth::V3OAuthStore::Memory
    );
}

#[test]
fn compile_auth_rejects_oauth_mixed_with_legacy_source() {
    let mut entry = oauth_entry(
        "/tmp/codex-auth.json",
        routecodex_v3_oauth::V3OAuthStore::Memory,
    );
    entry.env = Some("PROVIDER_KEY".to_string());

    let error = compile_auth("p", oauth_authoring(entry)).unwrap_err();
    assert!(error.to_string().contains("OAuth must not mix"), "{error}");
}

#[test]
fn compile_auth_rejects_oauth_fields_without_oauth_type() {
    let error = compile_auth(
        "p",
        authoring_with(oauth_entry(
            "/tmp/codex-auth.json",
            routecodex_v3_oauth::V3OAuthStore::Memory,
        )),
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("declares OAuth fields without auth.type = oauth"),
        "{error}"
    );
}

#[test]
fn compile_auth_rejects_incomplete_oauth_declaration() {
    let mut entry = oauth_entry(
        "/tmp/codex-auth.json",
        routecodex_v3_oauth::V3OAuthStore::Memory,
    );
    entry.client_id = None;

    let error = compile_auth("p", oauth_authoring(entry)).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("must declare oauth_source, refresh_endpoint, client_id, and oauth_store"),
        "{error}"
    );
}

#[test]
fn compile_auth_rejects_invalid_oauth_refresh_endpoint() {
    let mut entry = oauth_entry(
        "/tmp/codex-auth.json",
        routecodex_v3_oauth::V3OAuthStore::Memory,
    );
    entry.refresh_endpoint = Some("ftp://token.example/refresh".to_string());

    let error = compile_auth("p", oauth_authoring(entry)).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("refresh_endpoint must be an absolute http(s) URL"),
        "{error}"
    );
}

#[test]
fn compile_auth_rejects_oauth_store_source_same_path() {
    let path = "/tmp/codex-auth.json";
    let error = compile_auth(
        "p",
        oauth_authoring(oauth_entry(
            path,
            routecodex_v3_oauth::V3OAuthStore::File {
                path: path.to_string(),
            },
        )),
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("oauth_store must not be the oauth_source file"),
        "{error}"
    );
}

#[test]
fn oauth_authoring_debug_redacts_client_and_endpoint() {
    let entry = oauth_entry(
        "/tmp/codex-auth.json",
        routecodex_v3_oauth::V3OAuthStore::Memory,
    );
    let debug = format!("{entry:?}");

    assert!(!debug.contains("client-secret-sentinel"));
    assert!(!debug.contains("https://token.example/refresh"));
    assert!(debug.contains("[REDACTED]"));
}

#[test]
fn compile_auth_rejects_blank_oauth_client_id() {
    let mut entry = oauth_entry(
        "/tmp/codex-auth.json",
        routecodex_v3_oauth::V3OAuthStore::Memory,
    );
    entry.client_id = Some("   ".to_string());

    let error = compile_auth("p", oauth_authoring(entry)).unwrap_err();
    assert!(
        error.to_string().contains("client_id must not be empty"),
        "{error}"
    );
}

#[test]
fn compile_auth_rejects_blank_oauth_paths() {
    let mut source_blank = oauth_entry("   ", routecodex_v3_oauth::V3OAuthStore::Memory);
    source_blank.oauth_source = Some(routecodex_v3_oauth::V3OAuthSource::CodexAuthJson {
        path: "   ".to_string(),
    });
    let source_error = compile_auth("p", oauth_authoring(source_blank)).unwrap_err();
    assert!(
        source_error
            .to_string()
            .contains("oauth_source path must not be empty"),
        "{source_error}"
    );

    let store_blank = oauth_entry(
        "/tmp/codex-auth.json",
        routecodex_v3_oauth::V3OAuthStore::File {
            path: "   ".to_string(),
        },
    );
    let store_error = compile_auth("p", oauth_authoring(store_blank)).unwrap_err();
    assert!(
        store_error
            .to_string()
            .contains("oauth_store path must not be empty"),
        "{store_error}"
    );
}

#[test]
fn compile_auth_rejects_oauth_refresh_endpoint_without_host() {
    for endpoint in ["https://", "http://", "https://token.example/refresh path"] {
        let mut entry = oauth_entry(
            "/tmp/codex-auth.json",
            routecodex_v3_oauth::V3OAuthStore::Memory,
        );
        entry.refresh_endpoint = Some(endpoint.to_string());
        let error = compile_auth("p", oauth_authoring(entry)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("refresh_endpoint must be an absolute http(s) URL"),
            "{endpoint}: {error}"
        );
    }
}

#[test]
fn oauth_authoring_accepts_the_documented_oauth_literal() {
    let parsed: V3ProviderAuthAuthoringConfig = toml::from_str(
        r#"
type = "oauth"
[[entries]]
alias = "oauth-key"
oauth_source = { kind = "codex_auth_json", path = "/tmp/codex-auth.json" }
refresh_endpoint = "https://token.example/refresh"
client_id = "client-id"
oauth_store = { kind = "memory" }
"#,
    )
    .unwrap();
    assert_eq!(parsed.auth_type, V3ProviderAuthType::OAuth);
    assert_eq!(parsed.entries.len(), 1);
}
