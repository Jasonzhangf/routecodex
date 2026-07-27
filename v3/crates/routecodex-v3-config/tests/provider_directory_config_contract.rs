// feature_id: v3.provider_directory_config_compat
use routecodex_v3_config::V3ConfigStore;
use std::fs;
use std::path::{Path, PathBuf};

fn temp_root(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "routecodex-v3-provider-directory-{label}-{}-{}",
        std::process::id(),
        std::thread::current().name().unwrap_or("test")
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

fn write_token(root: &Path, provider_id: &str) -> PathBuf {
    let path = root.join("secrets").join(format!("{provider_id}.token"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "test-secret-not-for-projection\n").unwrap();
    path
}

fn write_provider(
    root: &Path,
    provider_id: &str,
    provider_type: &str,
    model: &str,
    token_file: &Path,
    extra: &str,
) -> PathBuf {
    let path = root
        .join("provider")
        .join(provider_id)
        .join("config.v2.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        format!(
            r#"version = "2.0.0"
providerId = "{provider_id}"

[provider]
id = "{provider_id}"
enabled = true
type = "{provider_type}"
baseURL = "https://{provider_id}.invalid/v1"
defaultModel = "{model}"
compatibilityProfile = "chat:test"

[provider.auth]
type = "apikey"
entries = [{{ alias = "key1", tokenFile = "{}" }}]

[provider.concurrency]
maxInFlight = 3
acquireTimeoutMs = 60000
staleLeaseMs = 300000

[provider.models."{model}"]
wireName = "{model}"
aliases = ["{model}-alias"]
capabilities = ["text", "thinking", "tools"]
supportsStreaming = true
supportsThinking = true
thinking = "medium"
maxTokens = 64000
maxContextTokens = 200000

[provider.v3]
health = {{ enabled = true, failure_threshold = 3, cooldown_ms = 900000 }}
provider_request_cleanup = {{ historical_fields = ["reasoning.encrypted_content"] }}
features = {{ directory_owned = true }}
{extra}
"#,
            token_file.display()
        ),
    )
    .unwrap();
    path
}

fn directory_root_config(primary_provider: &str, model: &str) -> String {
    format!(
        r#"version = 3

[servers.primary]
bind = "127.0.0.1"
port = 4555
routing_group = "primary"
endpoints = ["responses"]

[forwarders."fwd.model"]
model = "client-model"
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "{primary_provider}", model = "{model}", key = "key1", priority = 1 }}]

[route_groups.primary.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "fwd.model", priority = 1 }}]
"#
    )
}

#[test]
fn native_v3_root_loads_referenced_provider_files() {
    let root = temp_root("loads");
    let token = write_token(&root, "external");
    write_provider(&root, "external", "responses", "gpt-test", &token, "");
    let config_path = root.join("config.v3.toml");
    fs::write(&config_path, directory_root_config("external", "gpt-test")).unwrap();

    let snapshot = V3ConfigStore::new(&config_path)
        .load_snapshot_with_source_identity()
        .unwrap();
    let provider = &snapshot.manifest.providers["external"];
    assert_eq!(snapshot.manifest.providers.len(), 1);
    assert_eq!(provider.models["gpt-test"].wire_name, "gpt-test");
    assert_eq!(provider.models["gpt-test"].aliases, ["gpt-test-alias"]);
    assert_eq!(provider.compatibility_profile.as_deref(), Some("chat:test"));
    assert_eq!(provider.health.as_ref().unwrap().cooldown_ms, 900000);
    assert_eq!(
        provider.provider_request_cleanup.historical_fields,
        ["reasoning.encrypted_content"]
    );
    assert_eq!(provider.features.get("directory_owned"), Some(&true));
    let debug = format!("{snapshot:?}");
    assert!(!debug.contains("test-secret-not-for-projection"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn provider_only_source_change_changes_snapshot_identity_and_manifest() {
    let root = temp_root("identity");
    let token = write_token(&root, "external");
    let provider_path = write_provider(&root, "external", "responses", "gpt-test", &token, "");
    let config_path = root.join("config.v3.toml");
    fs::write(&config_path, directory_root_config("external", "gpt-test")).unwrap();
    let store = V3ConfigStore::new(&config_path);
    let first = store.load_snapshot_with_source_identity().unwrap();

    let changed = fs::read_to_string(&provider_path)
        .unwrap()
        .replace("maxContextTokens = 200000", "maxContextTokens = 300000");
    fs::write(&provider_path, changed).unwrap();
    let second = store.load_snapshot_with_source_identity().unwrap();

    assert_ne!(first.source_sha256, second.source_sha256);
    assert_eq!(
        second.manifest.providers["external"].models["gpt-test"].max_context_tokens,
        Some(300000)
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn direct_route_provider_target_is_discovered_without_forwarder() {
    let root = temp_root("direct-target");
    let token = write_token(&root, "direct-provider");
    write_provider(
        &root,
        "direct-provider",
        "openai",
        "direct-model",
        &token,
        "",
    );
    let config_path = root.join("config.v3.toml");
    fs::write(
        &config_path,
        r#"version = 3

[servers.primary]
bind = "127.0.0.1"
port = 4556
routing_group = "primary"
endpoints = ["responses"]

[route_groups.primary.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "direct-provider", model = "direct-model", key = "key1", priority = 1 }]
"#,
    )
    .unwrap();

    let manifest = V3ConfigStore::new(&config_path).load_snapshot().unwrap();
    assert!(manifest.providers.contains_key("direct-provider"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_referenced_provider_file_fails_before_manifest_publication() {
    let root = temp_root("missing");
    let config_path = root.join("config.v3.toml");
    fs::write(&config_path, directory_root_config("missing", "gpt-test")).unwrap();

    let error = V3ConfigStore::new(&config_path)
        .load_snapshot()
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("provider/missing/config.v2.toml"),
        "unexpected error: {error}"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn partial_inline_and_directory_provider_sources_are_rejected() {
    let root = temp_root("mixed");
    let token = write_token(&root, "external");
    write_provider(&root, "external", "responses", "gpt-test", &token, "");
    let config_path = root.join("config.v3.toml");
    let root_config = format!(
        r#"{}

[providers.inline]
type = "responses"
base_url = "https://inline.invalid/v1"
default_model = "gpt-test"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "INLINE_KEY" }}] }}
responses = {{ process = "chat", streaming = "always" }}

[providers.inline.models."gpt-test"]
wire_name = "gpt-test"
capabilities = ["text"]
supports_streaming = true
"#,
        directory_root_config("external", "gpt-test")
    );
    fs::write(&config_path, root_config).unwrap();

    let error = V3ConfigStore::new(&config_path)
        .load_snapshot()
        .unwrap_err();
    assert!(
        error.to_string().contains("cannot mix inline providers"),
        "unexpected error: {error}"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn provider_directory_identity_mismatch_is_rejected() {
    let root = temp_root("identity-mismatch");
    let token = write_token(&root, "external");
    let path = write_provider(&root, "external", "responses", "gpt-test", &token, "");
    let raw = fs::read_to_string(&path)
        .unwrap()
        .replace("providerId = \"external\"", "providerId = \"wrong\"");
    fs::write(&path, raw).unwrap();
    let config_path = root.join("config.v3.toml");
    fs::write(&config_path, directory_root_config("external", "gpt-test")).unwrap();

    let error = V3ConfigStore::new(&config_path)
        .load_snapshot()
        .unwrap_err();
    assert!(error.to_string().contains("identity mismatch"));
    fs::remove_dir_all(root).unwrap();
}
