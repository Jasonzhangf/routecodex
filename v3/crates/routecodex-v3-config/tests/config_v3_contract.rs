use routecodex_v3_config::{
    compile_v3_config_05_manifest, default_v3_config_path, parse_v3_config_02_authoring,
    V3ConfigStore, V3RouteTargetKind, V3SelectionStrategy,
};
use std::fs;

const FULL_CONFIG: &str = r#"
version = 3

[features]
responses_direct = true
debug_events = true

[debug]
log_console = true
log_file = "/tmp/routecodex-v3.log"
snapshots = true
dry_run = true
retention = { raw_requests = 10, raw_responses = 10 }

[error.policies.provider_unavailable]
action = "target_local_reselect"
cooldown_ms = 1000
max_attempts = 3

[servers.primary]
bind = "127.0.0.1"
port = 4444
routing_group = "primary"
endpoints = ["responses"]

[servers.secondary]
bind = "127.0.0.1"
port = 4445
routing_group = "secondary"
endpoints = ["responses"]

[providers.cc]
type = "responses"
base_url = "https://api.anyint.ai/openai/v1"
default_model = "gpt-5.5"
auth = { type = "api_key", entries = [{ alias = "key1", env = "CC_API_KEY" }] }
responses = { process = "chat", streaming = "always" }
concurrency = { max_in_flight = 8, acquire_timeout_ms = 60000, stale_lease_ms = 300000 }

[providers.cc.models."gpt-5.5"]
wire_name = "gpt-5.5"
aliases = ["gpt-5.6"]
capabilities = ["text", "reasoning", "tools"]
supports_streaming = true
supports_thinking = true
thinking = "low"
max_tokens = 64000
max_context_tokens = 200000

[providers.asxs]
type = "responses"
base_url = "https://api.asxs.top/v1"
default_model = "gpt-5.5"
auth = { type = "api_key", entries = [
  { alias = "crsa", env = "ASXS_CRSA_API_KEY" },
  { alias = "crsb", env = "ASXS_CRSB_API_KEY" }
] }
responses = { process = "chat", streaming = "always" }

[providers.asxs.models."gpt-5.5"]
wire_name = "gpt-5.5"
aliases = ["gpt-5.6"]
capabilities = ["text", "reasoning", "tools"]
supports_streaming = true
supports_thinking = true

[forwarders."fwd.gpt-5.6"]
model = "gpt-5.6"
aliases = ["gpt-latest"]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "cc", model = "gpt-5.5", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "asxs", model = "gpt-5.5", key = "crsa", priority = 2 }
]

[forwarders."nested.gpt-5.6"]
model = "gpt-5.6"
selection = { strategy = "round_robin" }
targets = [{ kind = "forwarder", id = "fwd.gpt-5.6" }]

[route_groups.primary.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "fwd.gpt-5.6", priority = 1 }]

[route_groups.primary.pools.search]
selection = { strategy = "weighted" }
targets = [
  { kind = "provider_model", provider = "cc", model = "gpt-5.5", weight = 70 },
  { kind = "provider_model", provider = "asxs", model = "gpt-5.5", weight = 30 }
]

[route_groups.secondary.pools.default]
selection = { strategy = "round_robin" }
targets = [
  { kind = "provider_model", provider = "cc", model = "gpt-5.5" },
  { kind = "provider_model", provider = "asxs", model = "gpt-5.5" }
]
"#;

#[test]
fn parses_full_config_v3_without_interpreting_targets() {
    let authoring = parse_v3_config_02_authoring(FULL_CONFIG).unwrap();
    let manifest = compile_v3_config_05_manifest(authoring).unwrap();

    assert_eq!(manifest.version, 3);
    assert_eq!(manifest.servers.len(), 2);
    assert_eq!(manifest.servers["primary"].port, 4444);
    assert_eq!(manifest.servers["secondary"].port, 4445);
    assert_eq!(manifest.providers.len(), 2);
    assert_eq!(
        manifest.providers["cc"].models["gpt-5.5"].wire_name,
        "gpt-5.5"
    );
    assert_eq!(
        manifest.providers["cc"].models["gpt-5.5"].aliases,
        vec!["gpt-5.6"]
    );
    assert_eq!(manifest.providers["asxs"].auth.entries.len(), 2);

    let forwarder = &manifest.forwarders["fwd.gpt-5.6"];
    assert_eq!(forwarder.selection.strategy, V3SelectionStrategy::Priority);
    assert_eq!(forwarder.targets.len(), 2);
    assert_eq!(forwarder.targets[0].provider.as_deref(), Some("cc"));
    assert_eq!(
        manifest.forwarders["nested.gpt-5.6"].targets[0]
            .id
            .as_deref(),
        Some("fwd.gpt-5.6")
    );
    assert!(manifest.debug.dry_run);
    assert_eq!(
        manifest.error.policies["provider_unavailable"].max_attempts,
        Some(3)
    );

    let route_target = &manifest.route_groups["primary"].pools["default"].targets[0];
    assert_eq!(route_target.kind, V3RouteTargetKind::Forwarder);
    assert_eq!(route_target.id.as_deref(), Some("fwd.gpt-5.6"));
    assert!(
        route_target.provider.is_none(),
        "config compiler must not interpret a forwarder into a provider"
    );
}

#[test]
fn rejects_recursive_forwarder_cycle() {
    let invalid = FULL_CONFIG.replace(
        "targets = [{ kind = \"forwarder\", id = \"fwd.gpt-5.6\" }]",
        "targets = [{ kind = \"forwarder\", id = \"nested.gpt-5.6\" }]",
    );
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&invalid).unwrap()).unwrap_err();
    assert!(error.to_string().contains("contains cycle"));
}

#[test]
fn rejects_unknown_auth_alias_and_ambiguous_model_alias() {
    let bad_key = FULL_CONFIG.replace("key = \"key1\"", "key = \"missing\"");
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&bad_key).unwrap()).unwrap_err();
    assert!(error.to_string().contains("unknown auth alias missing"));

    let ambiguous = FULL_CONFIG.replace("aliases = [\"gpt-5.6\"]", "aliases = [\"gpt-5.5\"]");
    let error = compile_v3_config_05_manifest(parse_v3_config_02_authoring(&ambiguous).unwrap())
        .unwrap_err();
    assert!(error.to_string().contains("ambiguous model name gpt-5.5"));
}

#[test]
fn published_manifest_is_declaration_only_and_deterministic() {
    let first =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(FULL_CONFIG).unwrap()).unwrap();
    let second =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(FULL_CONFIG).unwrap()).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.servers.len(), 2);
}

#[test]
fn rejects_duplicate_listener_empty_default_and_no_enabled_server() {
    let duplicate = FULL_CONFIG.replace("port = 4445", "port = 4444");
    let error = compile_v3_config_05_manifest(parse_v3_config_02_authoring(&duplicate).unwrap())
        .unwrap_err();
    assert!(error.to_string().contains("share listen address"));

    let empty_default = FULL_CONFIG.replace(
        "targets = [{ kind = \"forwarder\", id = \"fwd.gpt-5.6\", priority = 1 }]",
        "targets = []",
    );
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&empty_default).unwrap())
            .unwrap_err();
    assert!(error.to_string().contains("default pool is empty"));

    let disabled = FULL_CONFIG
        .replace(
            "[servers.primary]\n",
            "[servers.primary]\nenabled = false\n",
        )
        .replace(
            "[servers.secondary]\n",
            "[servers.secondary]\nenabled = false\n",
        );
    let error = compile_v3_config_05_manifest(parse_v3_config_02_authoring(&disabled).unwrap())
        .unwrap_err();
    assert!(error.to_string().contains("at least one enabled server"));
}

#[test]
fn rejects_invalid_auth_handle_shapes_and_unknown_forwarder() {
    let empty_env = FULL_CONFIG.replace("env = \"CC_API_KEY\"", "env = \"\"");
    let error = compile_v3_config_05_manifest(parse_v3_config_02_authoring(&empty_env).unwrap())
        .unwrap_err();
    assert!(error.to_string().contains("secret handle name"));

    let unknown = FULL_CONFIG.replace(
        "id = \"fwd.gpt-5.6\", priority",
        "id = \"missing.forwarder\", priority",
    );
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&unknown).unwrap()).unwrap_err();
    assert!(error
        .to_string()
        .contains("unknown forwarder missing.forwarder"));
}

#[test]
fn requires_default_pool_for_every_route_group() {
    let invalid = FULL_CONFIG.replace(
        "[route_groups.secondary.pools.default]",
        "[route_groups.secondary.pools.coding]",
    );
    let authoring = parse_v3_config_02_authoring(&invalid).unwrap();
    let error = compile_v3_config_05_manifest(authoring).unwrap_err();
    assert!(error.to_string().contains("must define default pool"));
}

#[test]
fn rejects_unknown_fields_and_secret_literals() {
    let unknown = FULL_CONFIG.replace(
        "routing_group = \"primary\"",
        "routing_group = \"primary\"\nunknown_server_field = true",
    );
    assert!(parse_v3_config_02_authoring(&unknown).is_err());

    let secret = FULL_CONFIG.replace("env = \"CC_API_KEY\"", "env = \"sk-secret-value\"");
    let authoring = parse_v3_config_02_authoring(&secret).unwrap();
    assert!(compile_v3_config_05_manifest(authoring).is_err());
}

#[test]
fn validates_provider_model_and_forwarder_references() {
    let invalid = FULL_CONFIG.replace(
        "provider = \"cc\", model = \"gpt-5.5\", key = \"key1\"",
        "provider = \"cc\", model = \"alias-only\", key = \"key1\"",
    );
    let authoring = parse_v3_config_02_authoring(&invalid).unwrap();
    let error = compile_v3_config_05_manifest(authoring).unwrap_err();
    assert!(error
        .to_string()
        .contains("does not declare canonical model alias-only"));
}

#[test]
fn config_store_is_the_single_read_write_interface() {
    let root =
        std::env::temp_dir().join(format!("routecodex-v3-config-store-{}", std::process::id()));
    let path = root.join("config.v3.toml");
    let store = V3ConfigStore::new(&path);
    let authoring = parse_v3_config_02_authoring(FULL_CONFIG).unwrap();
    let plan = store.plan_write(&authoring).unwrap();
    store.commit_write_atomic(plan).unwrap();

    let snapshot = store.load_snapshot().unwrap();
    assert_eq!(snapshot.servers["primary"].port, 4444);
    assert_eq!(store.path(), path);
    assert!(!path
        .with_extension(format!("toml.tmp-{}", std::process::id()))
        .exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn default_path_is_config_v3_toml() {
    assert_eq!(
        default_v3_config_path("/tmp/home"),
        std::path::PathBuf::from("/tmp/home/.rcc/config.v3.toml")
    );
}
