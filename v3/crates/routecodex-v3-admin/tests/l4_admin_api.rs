// feature_id: v3.admin_api_integration
// Admin REST API 黑盒集成测试：使用 axum 自带 test server 拉起 in-process
// 服务，覆盖 Dashboard / Routes / Providers / Revisions / Reload 端点。
use routecodex_v3_admin::{AppState, ProviderHealthEntry, router};
use routecodex_v3_config::{
    V3Config02AuthoringParsed, V3RoutePoolTargetAuthoringConfig, V3RouteTargetKind,
    V3SelectionPolicy, V3SelectionStrategy, V3ServerAuthoringConfig,
};
use routecodex_v3_config_mgmt::ConfigMgmtStore;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

static TEST_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn temp_home() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rcc-admin-test-{}-{}",
        std::process::id(),
        TEST_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).expect("temp home");
    dir
}

fn write_init_config(home: &PathBuf) -> PathBuf {
    let mut authoring = V3Config02AuthoringParsed {
        version: 3,
        pipelines: Default::default(),
        servers: BTreeMap::new(),
        providers: BTreeMap::new(),
        forwarders: BTreeMap::new(),
        route_groups: BTreeMap::new(),
        features: BTreeMap::new(),
        debug: Default::default(),
        error: Default::default(),
    };
    authoring.servers.insert(
        "test-server".to_string(),
        V3ServerAuthoringConfig {
            enabled: true,
            bind: "127.0.0.1".into(),
            port: 19999,
            routing_group: "test-group".into(),
            endpoints: vec!["responses".into(), "openai_chat".into(), "anthropic".into()],
            features: BTreeMap::new(),
            execution: None,
            expose_models: vec![],
        },
    );
    // 把被引用 provider 的 stub 文件写出，让 commit 校验通过
    let provider_dir = home.join("provider").join("p1");
    std::fs::create_dir_all(&provider_dir).expect("provider dir");
    std::fs::write(
        provider_dir.join("config.v2.toml"),
        r#"
version = "2.0.0"
providerId = "p1"

[provider]
id = "p1"
enabled = true
type = "openai_chat"
baseURL = "http://127.0.0.1:9999/v1"
defaultModel = "m1"

[provider.auth]
type = "apikey"
apiKey = "sk-test"

[provider.models."m1"]
supportsStreaming = true
"#,
    )
    .expect("provider file");
    let mut pool = routecodex_v3_config::V3RoutePoolAuthoringConfig {
        selection: V3SelectionPolicy {
            strategy: V3SelectionStrategy::Priority,
        },
        match_rule: None,
        targets: vec![V3RoutePoolTargetAuthoringConfig {
            kind: V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some("p1".into()),
            model: Some("m1".into()),
            key: Some("key1".into()),
            priority: Some(1),
            weight: None,
        }],
        features: BTreeMap::new(),
    };
    let _ = &mut pool;
    let mut groups = routecodex_v3_config::V3RouteGroupAuthoringConfig {
        pools: BTreeMap::new(),
        features: BTreeMap::new(),
    };
    groups.pools.insert("default".into(), pool);
    authoring.route_groups.insert("test-group".into(), groups);
    let path = home.join("config.v3.toml");
    let store = ConfigMgmtStore::new(&path);
    store
        .commit_with_backup(&authoring, "init", "test fixture")
        .expect("commit init");
    path
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| panic!("http client"))
}

async fn bind_test_server() -> (String, AppState, PathBuf) {
    let home = temp_home();
    let config_path = write_init_config(&home);
    let state = AppState::new(config_path.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test listener");
    let address = listener.local_addr().expect("local addr");
    let url = format!("http://{address}");
    let router = router(state.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (url, state, home)
}

#[tokio::test]
async fn overview_returns_runtime_state() {
    let (base, _state, _home) = bind_test_server().await;
    let response = http_client()
        .get(format!("{base}/api/overview"))
        .send()
        .await
        .expect("overview response");
    assert!(response.status().is_success());
    let body: serde_json::Value = response.json().await.expect("overview json");
    assert!(body.get("runtime").is_some(), "runtime section present");
    assert!(body.get("providers").is_some(), "providers section present");
    assert!(body.get("traffic").is_some(), "traffic section present");
}

#[tokio::test]
async fn routes_get_returns_tree() {
    let (base, _state, _home) = bind_test_server().await;
    let response = http_client()
        .get(format!("{base}/api/routes"))
        .send()
        .await
        .expect("routes response");
    assert!(response.status().is_success());
    let body: serde_json::Value = response.json().await.expect("routes json");
    let groups = body.get("groups").and_then(|v| v.as_array()).expect("groups array");
    assert!(!groups.is_empty(), "groups populated from authored config");
    let ports = groups[0].get("ports").and_then(|v| v.as_array()).expect("ports");
    let pools = ports[0].get("pools").and_then(|v| v.as_array()).expect("pools");
    let tiers = pools[0].get("tiers").and_then(|v| v.as_array()).expect("tiers");
    let members = tiers[0].get("members").and_then(|v| v.as_array()).expect("members");
    assert_eq!(members[0].get("provider").and_then(|v| v.as_str()), Some("p1"));
}

#[tokio::test]
async fn routes_validate_rejects_invalid_target() {
    let (base, _state, _home) = bind_test_server().await;
    let body = serde_json::json!({
        "groups": [{
            "group_id": "test-group",
            "ports": [{
                "server_id": "test-server",
                "port": 8080,
                "bind": "127.0.0.1",
                "enabled": true,
                "endpoints": ["responses"],
                "routing_group": "test-group",
                "pools": [{
                    "name": "default",
                    "selection_strategy": "priority",
                    "match_rule": null,
                    "tiers": [{
                        "priority": 1,
                        "members": [{
                            "kind": "provider_model",
                            "id": null,
                            "provider": "ghost",
                            "model": "m9",
                            "key": null,
                            "priority": 1,
                            "weight": null
                        }]
                    }]
                }]
            }]
        }],
        "reason": "validate invalid"
    });
    let response = http_client()
        .post(format!("{base}/api/routes/validate"))
        .json(&body)
        .send()
        .await
        .expect("validate response");
    assert!(response.status().is_success());
    let payload: serde_json::Value = response.json().await.expect("validate json");
    assert_eq!(payload.get("ok").and_then(|v| v.as_bool()), Some(false));
    assert!(payload.get("error").is_some(), "error message present");
}

#[tokio::test]
async fn providers_list_includes_one() {
    let (base, _state, home) = bind_test_server().await;
    // write one provider file under the temp config_dir/provider/p1/config.v2.toml
    let provider_dir = home.join("provider").join("p1");
    std::fs::create_dir_all(&provider_dir).expect("provider dir");
    std::fs::write(
        provider_dir.join("config.v2.toml"),
        r#"
version = "2.0.0"
providerId = "p1"

[provider]
id = "p1"
enabled = true
type = "openai_chat"
baseURL = "http://127.0.0.1:9999/v1"
defaultModel = "m1"

[provider.auth]
type = "apikey"
apiKey = "sk-test"

[provider.models."m1"]
supportsStreaming = true
"#,
    )
    .expect("write provider file");
    let response = http_client()
        .get(format!("{base}/api/providers"))
        .send()
        .await
        .expect("providers response");
    assert!(response.status().is_success());
    let body: Vec<serde_json::Value> = response.json().await.expect("providers json");
    assert!(!body.is_empty(), "at least one provider");
    assert_eq!(body[0].get("id").and_then(|v| v.as_str()), Some("p1"));
}

#[tokio::test]
async fn revisions_and_static_assets_are_served() {
    let (base, _state, _home) = bind_test_server().await;
    let revisions = http_client()
        .get(format!("{base}/api/revisions"))
        .send()
        .await
        .expect("revisions response");
    assert!(revisions.status().is_success());
    let index = http_client()
        .get(format!("{base}/"))
        .send()
        .await
        .expect("index response");
    assert!(index.status().is_success());
    let body = index.text().await.expect("index body");
    assert!(body.contains("Dashboard"), "index page rendered");
    let css = http_client()
        .get(format!("{base}/styles.css"))
        .send()
        .await
        .expect("css response");
    assert!(css.status().is_success());
}

static HEALTH_ENTRY: OnceLock<ProviderHealthEntry> = OnceLock::new();

fn sample_health() -> ProviderHealthEntry {
    HEALTH_ENTRY
        .get_or_init(|| ProviderHealthEntry {
            tested_at_epoch_ms: 1,
            ok: true,
            latency_ms: 1,
            error: None,
        })
        .clone()
}

#[tokio::test]
async fn provider_health_test_returns_record() {
    let (base, state, home) = bind_test_server().await;
    let provider_dir = home.join("provider").join("local");
    std::fs::create_dir_all(&provider_dir).expect("provider dir");
    std::fs::write(
        provider_dir.join("config.v2.toml"),
        r#"
version = "2.0.0"
providerId = "local"

[provider]
id = "local"
enabled = true
type = "openai_chat"
baseURL = "http://127.0.0.1:1/v1"
defaultModel = "m1"

[provider.auth]
type = "apikey"
apiKey = "x"

[provider.models."m1"]
supportsStreaming = true
"#,
    )
    .expect("write local provider");
    let response = http_client()
        .post(format!("{base}/api/providers/local/health-test"))
        .send()
        .await
        .expect("health response");
    assert!(response.status().is_success());
    let body: serde_json::Value = response.json().await.expect("health json");
    assert!(
        body.get("tested_at_epoch_ms").is_some(),
        "tested_at_epoch_ms present"
    );
    let cached = state.health_cache.lock().await.get("local").cloned();
    assert!(cached.is_some(), "health cached in app state");
    assert!(
        cached.unwrap().error.is_some(),
        "error message captured when endpoint unreachable"
    );
    let _ = sample_health();
}