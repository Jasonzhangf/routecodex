// feature_id: v3.config_mgmt_core
// Config Core 管理面黑盒测试：route 视图 roundtrip、provider 文件写读、
// 原子替换 + 备份 + revision、校验失败不落盘。
use routecodex_v3_config::{compile_v3_config_05_manifest, V3Config02AuthoringParsed};
use routecodex_v3_config_mgmt::{
    apply_route_group_view_to_authoring, list_provider_ids, new_default_pool_view,
    new_forwarder_with_target, read_provider_file, route_groups_from_authoring,
    upsert_forwarder, write_provider_file, ConfigMgmtStore, RevisionStore,
    V2_PROVIDER_CONFIG_FILE_NAME,
};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_home() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rcc-config-mgmt-test-{}-{}",
        std::process::id(),
        TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&dir).expect("create temp home");
    dir
}

fn base_authoring() -> V3Config02AuthoringParsed {
    let raw = r#"
version = 3

[providers.p1]
enabled = true
type = "openai_chat"
base_url = "http://127.0.0.1:9999/v1"
default_model = "m1"

[providers.p1.auth]
type = "apikey"
entries = [{ alias = "key1", env = "TEST_KEY_P1" }]

[providers.p1.models."m1"]
supports_streaming = true

[providers.p2]
enabled = true
type = "openai_chat"
base_url = "http://127.0.0.1:9998/v1"
default_model = "m2"

[providers.p2.auth]
type = "apikey"
entries = [{ alias = "key1", env = "TEST_KEY_P2" }]

[providers.p2.models."m2"]
supports_streaming = true

[servers.routecodex_v3_4444]
enabled = true
bind = "127.0.0.1"
port = 4444
routing_group = "routecodex_v3_4444"
endpoints = ["openai_chat", "responses", "anthropic"]

[route_groups.routecodex_v3_4444.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "p1", model = "m1", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "p2", model = "m2", priority = 2 },
]
"#;
    routecodex_v3_config::parse_v3_config_02_authoring(raw).expect("parse authoring")
}

fn write_config(home: &PathBuf, raw: &str) -> PathBuf {
    let path = home.join("config.v3.toml");
    fs::write(&path, raw).expect("write config");
    path
}

#[test]
fn route_view_roundtrip_preserves_pool_semantics() {
    let home = temp_home();
    let path = write_config(&home, &toml::to_string(&base_authoring()).unwrap());
    let store = ConfigMgmtStore::new(&path);
    let authoring = store.read_authoring().expect("read authoring");

    let groups = route_groups_from_authoring(&authoring);
    assert_eq!(groups.len(), 1, "one routing group");
    let group = &groups[0];
    assert_eq!(group.ports.len(), 1);
    let port = &group.ports[0];
    assert_eq!(port.port, 4444);
    assert_eq!(port.pools.len(), 1);
    let pool = &port.pools[0];
    assert_eq!(pool.name, "default");
    assert_eq!(pool.tiers.len(), 2, "two priority tiers");
    assert_eq!(pool.tiers[0].priority, 1);
    assert_eq!(pool.tiers[0].members.len(), 1);
    assert_eq!(
        pool.tiers[0].members[0].provider.as_deref(),
        Some("p1")
    );
    assert_eq!(pool.tiers[1].priority, 2);
    assert_eq!(
        pool.tiers[1].members[0].provider.as_deref(),
        Some("p2")
    );

    let mut mutated = authoring.clone();
    apply_route_group_view_to_authoring(&mut mutated, group);
    let reparsed = parse_authoring(&toml::to_string(&mutated).unwrap());
    let repool = reparsed
        .route_groups
        .get("routecodex_v3_4444")
        .unwrap()
        .pools
        .get("default")
        .unwrap();
    assert_eq!(repool.targets.len(), 2, "targets preserved after roundtrip");
    assert_eq!(repool.targets[0].priority, Some(1));
    assert_eq!(repool.targets[1].priority, Some(2));
    assert_eq!(repool.targets[0].provider.as_deref(), Some("p1"));
    assert_eq!(repool.targets[0].key.as_deref(), Some("key1"));
}

fn parse_authoring(raw: &str) -> V3Config02AuthoringParsed {
    routecodex_v3_config::parse_v3_config_02_authoring(raw).expect("parse authoring")
}

#[test]
fn weighted_tier_members_keep_weights() {
    let authoring = parse_authoring(
        r#"
version = 2

[servers.s1]
enabled = true
bind = "127.0.0.1"
port = 8080
routing_group = "g1"
endpoints = ["/v1/chat/completions"]

[route_groups.g1.pools.default]
selection = { strategy = "weighted" }
targets = [
  { kind = "provider_model", provider = "p1", model = "m1", priority = 1, weight = 70 },
  { kind = "provider_model", provider = "p2", model = "m2", priority = 1, weight = 30 },
]
"#,
    );
    let groups = route_groups_from_authoring(&authoring);
    let pool = &groups[0].ports[0].pools[0];
    assert_eq!(pool.selection_strategy, routecodex_v3_config::V3SelectionStrategy::Weighted);
    assert_eq!(pool.tiers.len(), 1, "same priority merges into one tier");
    let members = &pool.tiers[0].members;
    assert_eq!(members.len(), 2);
    assert_eq!(members[0].weight, Some(70));
    assert_eq!(members[1].weight, Some(30));
}

#[test]
fn provider_file_write_then_read_roundtrip() {
    let home = temp_home();
    let config = routecodex_v3_config::V2ProviderConfigFile {
        version: Some("2.0.0".into()),
        provider_id: Some("test-provider".into()),
        provider: routecodex_v3_config::V2ProviderConfig {
            id: "test-provider".into(),
            enabled: Some(true),
            provider_type: "openai".into(),
            base_url: "http://127.0.0.1:9999/v1".into(),
            default_model: "model-a".into(),
            auth: routecodex_v3_config::V2ProviderAuthConfig {
                api_key: None,
                env: Some("TEST_PROVIDER_KEY".into()),
                token_file: None,
                entries: None,
            },
            responses: None,
            concurrency: None,
            compatibility_profile: None,
            models: Default::default(),
            v3: None,
            timeout: None,
            sse_first_frame_timeout_ms: None,
        },
    };
    let path = write_provider_file(&home, "test-provider", &config).expect("write provider");
    assert_eq!(path.file_name().unwrap().to_str().unwrap(), V2_PROVIDER_CONFIG_FILE_NAME);

    let ids = list_provider_ids(&home).expect("list provider ids");
    assert_eq!(ids, vec!["test-provider".to_string()]);

    let entry = read_provider_file(&home, "test-provider").expect("read provider");
    assert_eq!(entry.config.provider.id, "test-provider");
    assert_eq!(entry.config.provider.provider_type, "openai");
    assert_eq!(entry.config.provider.auth.env.as_deref(), Some("TEST_PROVIDER_KEY"));
}

#[test]
fn commit_with_backup_creates_backup_and_revision() {
    let home = temp_home();
    let path = write_config(&home, &toml::to_string(&base_authoring()).unwrap());
    let store = ConfigMgmtStore::new(&path);
    let authoring = store.read_authoring().expect("read authoring");

    let mut mutated = authoring.clone();
    {
        let mut groups = route_groups_from_authoring(&mutated);
        let mut extra = new_default_pool_view("extra");
        extra.match_rule = Some(routecodex_v3_config::V3RoutePoolMatchAuthoringConfig {
            precedence: Some(10),
            entry_protocol: Some("responses".into()),
            models: Vec::new(),
            required_capabilities: Vec::new(),
            min_input_tokens: None,
            max_input_tokens: None,
        });
        extra.tiers.push(routecodex_v3_config_mgmt::RouteTierView {
            priority: 1,
            members: vec![routecodex_v3_config_mgmt::RouteMemberView {
                kind: routecodex_v3_config::V3RouteTargetKind::ProviderModel,
                id: None,
                provider: Some("p1".into()),
                model: Some("m1".into()),
                key: Some("key1".into()),
                priority: 1,
                weight: None,
            }],
        });
        groups[0].ports[0].pools.push(extra);
        apply_route_group_view_to_authoring(&mut mutated, &groups[0]);
    }

    let outcome = store
        .commit_with_backup(&mutated, "route.pool.add", "test-reason")
        .expect("commit");
    let backup = outcome.backup.expect("backup created");
    assert!(backup.exists(), "backup file exists: {}", backup.display());
    assert!(
        backup.file_name().unwrap().to_str().unwrap().contains("config.v3.toml.bak-"),
        "backup follows naming convention: {}",
        backup.display()
    );

    let revisions = store.revision_store().list().expect("list revisions");
    assert_eq!(revisions.len(), 1);
    assert_eq!(revisions[0].seq, 1);
    assert_eq!(revisions[0].action, "route.pool.add");
    assert_eq!(revisions[0].reason, "test-reason");
    assert_eq!(revisions[0].result, "committed");

    let reread = store.read_authoring().expect("reread after commit");
    assert!(
        reread.route_groups["routecodex_v3_4444"].pools.contains_key("extra"),
        "new pool visible after commit"
    );
    compile_v3_config_05_manifest(reread.clone()).expect("committed config compiles");
}

#[test]
fn invalid_commit_fails_without_touching_file() {
    let home = temp_home();
    let path = write_config(&home, &toml::to_string(&base_authoring()).unwrap());
    let store = ConfigMgmtStore::new(&path);
    let before = fs::read_to_string(&path).unwrap();

    let mut broken = store.read_authoring().expect("read authoring");
    broken.servers.insert(
        "broken".into(),
        routecodex_v3_config::V3ServerAuthoringConfig {
            enabled: true,
            bind: "127.0.0.1".into(),
            port: 0,
            routing_group: "missing-group".into(),
            endpoints: vec![],
            features: Default::default(),
            execution: None,
            expose_models: vec![],
        },
    );
    broken
        .route_groups
        .get_mut("routecodex_v3_4444")
        .unwrap()
        .pools
        .get_mut("default")
        .unwrap()
        .targets
        .push(routecodex_v3_config::V3RoutePoolTargetAuthoringConfig {
            kind: routecodex_v3_config::V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some("ghost-provider".into()),
            model: Some("m9".into()),
            key: None,
            priority: Some(9),
            weight: None,
        });
    let result = store.commit_with_backup(&broken, "route.pool.add", "broken");
    assert!(result.is_err(), "invalid config must fail validation");
    let after = fs::read_to_string(&path).unwrap();
    assert_eq!(before, after, "file untouched on failed validation");
    assert_eq!(
        store.revision_store().list().unwrap().len(),
        0,
        "no revision recorded for failed commit"
    );
}

#[test]
fn forwarder_build_and_upsert() {
    let mut authoring = base_authoring();
    let forwarder = new_forwarder_with_target("glm-5.2", "p1", "m1", Some("key1"), 1, None);
    upsert_forwarder(&mut authoring, "fwd.test", forwarder.clone());
    assert!(authoring.forwarders.contains_key("fwd.test"));
    let fwd = &authoring.forwarders["fwd.test"];
    assert_eq!(fwd.model, "glm-5.2");
    assert_eq!(fwd.targets.len(), 1);
    assert_eq!(fwd.targets[0].provider.as_deref(), Some("p1"));
    compile_v3_config_05_manifest(authoring.clone()).expect("authoring with forwarder compiles");
}

#[test]
fn revision_store_roundtrip_and_monotonic_seq() {
    let home = temp_home();
    let store = RevisionStore::new(home.join("state").join("config-revisions.json"));
    let first = store.append("a1", "config.v3.toml", "r1", None, "hash1", "committed").unwrap();
    let second = store.append("a2", "config.v3.toml", "r2", None, "hash2", "committed").unwrap();
    assert_eq!(first.seq, 1);
    assert_eq!(second.seq, 2);
    let listed = store.list().unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].seq, 1);
    assert_eq!(listed[1].action, "a2");
    assert_eq!(listed[1].source_sha256, "hash2");
}
