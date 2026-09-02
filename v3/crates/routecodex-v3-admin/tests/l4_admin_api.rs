// feature_id: v3.admin_api_integration
// Admin REST API 黑盒集成测试：使用 axum 自带 test server 拉起 in-process
// 服务，覆盖 Dashboard / Routes / Providers / Revisions / Reload 端点。
use routecodex_v3_admin::{router, AppState, ProviderHealthEntry};
use routecodex_v3_config_mgmt::ConfigMgmtStore;
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
    let path = home.join("config.toml");
    std::fs::write(
        &path,
        r#"version = 3

[servers.routecodex_v3_4444]
bind = "127.0.0.1"
port = 4444
[servers.routecodex_v3_4444.routes.default]
tiers = [[{ use = "p1/m1" }]]

[servers.responses_v3_7777]
bind = "127.0.0.1"
port = 7777
[servers.responses_v3_7777.routes.default]
tiers = [[{ use = "p1/m1" }]]
"#,
    )
    .expect("user config");
    ConfigMgmtStore::new(&path)
        .read_authoring()
        .expect("compiled user config fixture");
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

fn observability_source_row() -> serde_json::Value {
    serde_json::json!({
        "request_key": "4444:req-source",
        "event_type": "request.failed",
        "started_epoch_ms": 1,
        "updated_epoch_ms": 3,
        "finished_epoch_ms": 2,
        "duration_ms": 1,
        "meta": {
            "request_id": "req-source",
            "endpoint": "/v1/chat/completions",
            "provider_status": 429,
            "error_category": "provider_http_429",
            "error_detail": "upstream rate limited"
        },
        "scope": {"port": 4444},
        "result": "error",
        "attempts": 2,
        "failed_attempts": 1,
        "switches": 1,
        "tokens_output": 7
    })
}

fn write_observability_store(home: &std::path::Path) {
    let store_path = home
        .join("logs")
        .join("server-v3-4444.request-records.jsonl");
    let line = serde_json::json!({
        "schema_version": 1,
        "row": observability_source_row()
    });
    std::fs::create_dir_all(store_path.parent().unwrap()).expect("logs dir");
    std::fs::write(store_path, format!("{line}\n")).expect("observability store");
}

fn write_observability_rows(home: &std::path::Path, rows: &[serde_json::Value]) {
    let store_path = home
        .join("logs")
        .join("server-v3-4444.request-records.jsonl");
    std::fs::create_dir_all(store_path.parent().unwrap()).expect("logs dir");
    let content = rows
        .iter()
        .map(|row| {
            serde_json::json!({
                "schema_version": 1,
                "row": row
            })
            .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(store_path, format!("{content}\n")).expect("observability store");
}

fn observability_row_with_result(request_key: &str, result: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "request_key": request_key,
        "event_type": "request.completed",
        "started_epoch_ms": 1,
        "updated_epoch_ms": 3,
        "finished_epoch_ms": 2,
        "duration_ms": 10,
        "meta": {},
        "scope": {"port": 4444},
        "result": result,
        "attempts": 1,
        "failed_attempts": 0,
        "switches": 0,
        "usage": {
            "input_tokens": 100,
            "output_tokens": 20,
            "cached_tokens": 50,
            "total_tokens": 120
        }
    })
}

fn observability_attempt_row(request_key: &str, provider_status: u16) -> serde_json::Value {
    observability_attempt_row_with_failed(request_key, provider_status, 1)
}

fn observability_attempt_row_with_failed(
    request_key: &str,
    provider_status: u16,
    failed_attempts: u64,
) -> serde_json::Value {
    serde_json::json!({
        "request_key": request_key,
        "event_type": "request.provider_attempt_failed",
        "started_epoch_ms": 1,
        "updated_epoch_ms": 2,
        "finished_epoch_ms": null,
        "duration_ms": null,
        "meta": {
            "request_id": request_key.split(':').last().unwrap_or(request_key),
            "endpoint": "/v1/chat/completions",
            "provider_status": provider_status,
            "error_category": format!("provider_http_{provider_status}"),
            "error_detail": format!("provider returned HTTP {provider_status}"),
            "provider": "p1",
            "model": "m1",
            "route_reason": "default:first-try"
        },
        "scope": {"port": 4444},
        "result": null,
        "attempts": 0,
        "failed_attempts": failed_attempts,
        "switches": 0,
        "usage": null
    })
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
    let groups = body
        .get("servers")
        .and_then(|v| v.as_array())
        .expect("groups array");
    assert!(!groups.is_empty(), "groups populated from user config");
    let pools = groups[0]
        .get("pools")
        .and_then(|v| v.as_array())
        .expect("pools");
    let tiers = pools[0]
        .get("tiers")
        .and_then(|v| v.as_array())
        .expect("tiers");
    let members = tiers[0]
        .get("members")
        .and_then(|v| v.as_array())
        .expect("members");
    assert_eq!(
        members[0].get("use").and_then(|v| v.as_str()),
        Some("p1/m1")
    );
}

#[tokio::test]
async fn routes_validate_rejects_invalid_target() {
    let (base, _state, _home) = bind_test_server().await;
    let body = serde_json::json!({
        "servers": [{
            "server_id": "routecodex_v3_4444", "port": 4444,
            "pools": [{
                "name": "default",
                "tiers": [{
                    "members": [{"use": "ghost/m9", "weight": null}]
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

    let zero_weight = serde_json::json!({
        "servers": [{
            "server_id": "routecodex_v3_4444", "port": 4444,
            "pools": [{
                "name": "default",
                "tiers": [{
                    "members": [{"use": "p1/m1", "weight": 0}]
                }]
            }]
        }],
        "reason": "validate zero weight"
    });
    let response = http_client()
        .post(format!("{base}/api/routes/validate"))
        .json(&zero_weight)
        .send()
        .await
        .expect("zero-weight validation response");
    assert!(response.status().is_success());
    let payload: serde_json::Value = response.json().await.expect("zero-weight validation json");
    assert_eq!(
        payload.get("ok").and_then(|value| value.as_bool()),
        Some(false),
        "programmatic route selection must retain parser weight invariants: {payload}"
    );
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
    let requests = http_client()
        .get(format!("{base}/requests.html"))
        .send()
        .await
        .expect("requests page response");
    assert!(requests.status().is_success());
    let requests_body = requests.text().await.expect("requests page body");
    assert!(
        requests_body.contains("Persistent request records"),
        "requests page rendered"
    );
    let routes = http_client()
        .get(format!("{base}/routes.html"))
        .send()
        .await
        .expect("routes page response");
    assert!(routes.status().is_success());
    let routes_body = routes.text().await.expect("routes page body");
    assert!(routes_body.contains("Choose what runs first"));
    assert!(routes_body.contains("Tier 1 is tried first"));
    assert_eq!(routes_body.matches("id=\"save-btn\"").count(), 1);
    assert!(!routes_body.contains("Cooldown pool"));
    assert!(routes_body.contains("load();"));
    assert!(routes_body.contains("aria-live=\"polite\""));
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

#[tokio::test]
async fn observability_records_group_terminal_errors_by_raw_status_code() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_store(&home);

    let response = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10"
        ))
        .send()
        .await
        .expect("records response");
    let response_status = response.status();
    let response_body = response.text().await.expect("records body");
    assert!(
        response_status.is_success(),
        "records request failed: {response_status} {response_body}"
    );
    let body: serde_json::Value = serde_json::from_str(&response_body).expect("records json");

    assert_eq!(body["facets"]["error_status_codes"]["429"], 1);
    assert!(
        body["facets"]["error_status_codes"]["provider_http_429"].is_null(),
        "semantic error category must never be exposed as a status-code facet: {body}"
    );

    let filtered = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&status=error&error_status_code=429"
        ))
        .send()
        .await
        .expect("filtered records response");
    assert!(filtered.status().is_success());
    let filtered_body: serde_json::Value = filtered.json().await.expect("filtered json");
    assert_eq!(filtered_body["total"], 1);
    assert_eq!(
        filtered_body["records"][0]["request_key"],
        "4444:req-source"
    );
}

#[tokio::test]
async fn observability_stats_exclude_non_success_usage_but_keep_request_counts() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(
        &home,
        &[
            observability_row_with_result("4444:success", Some("success")),
            observability_row_with_result("4444:error", Some("error")),
            observability_row_with_result("4444:cancelled", Some("cancelled")),
            observability_row_with_result("4444:active", None),
        ],
    );

    let response = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&range=all"
        ))
        .send()
        .await
        .expect("records response");
    let response_status = response.status();
    let response_body = response.text().await.expect("records body");
    assert!(
        response_status.is_success(),
        "records request failed: {response_status} {response_body}"
    );
    let body: serde_json::Value = serde_json::from_str(&response_body).expect("records json");
    let stats = &body["stats"];
    assert_eq!(stats["count"], 4);
    assert_eq!(stats["success_count"], 1);
    assert_eq!(stats["error_count"], 1);
    assert_eq!(stats["cancelled_count"], 1);
    assert_eq!(stats["active_count"], 1);
    assert_eq!(stats["input_tokens"], 100);
    assert_eq!(stats["output_tokens"], 20);
    assert_eq!(stats["cached_tokens"], 50);
    assert_eq!(stats["total_tokens"], 120);
    assert_eq!(stats["cache_hit_rate_percent"], 50.0);
    assert_eq!(stats["avg_duration_ms"], 10.0);
    assert_eq!(stats["by_port"]["4444"]["total"], 4);
    assert_eq!(stats["by_port"]["4444"]["success"], 1);
    assert_eq!(stats["by_port"]["4444"]["error"], 1);
    assert_eq!(stats["by_port"]["4444"]["provider_failures"], 0);
    assert_eq!(stats["by_port"]["4444"]["cancelled"], 1);
    assert_eq!(stats["by_port"]["4444"]["active"], 1);

    let timeseries = &body["timeseries"];
    assert_eq!(timeseries[0]["count"], 4);
    assert_eq!(timeseries[0]["input_tokens"], 100);
    assert_eq!(timeseries[0]["output_tokens"], 20);
    assert_eq!(timeseries[0]["cached_tokens"], 50);
    assert_eq!(timeseries[0]["total_tokens"], 120);
}

#[tokio::test]
async fn observability_keeps_provider_attempt_failures_visible_after_success() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(
        &home,
        &[
            observability_row_with_result("4444:recovered", Some("success")),
            observability_attempt_row("4444:recovered", 502),
            observability_attempt_row_with_failed("4444:recovered", 503, 2),
            observability_attempt_row_with_failed("4444:terminal", 429, 3),
        ],
    );

    let response = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&range=all"
        ))
        .send()
        .await
        .expect("records response");
    assert!(response.status().is_success());
    let body: serde_json::Value = response.json().await.expect("records json");

    assert_eq!(body["facets"]["error_status_codes"]["502"], 1);
    assert_eq!(body["facets"]["error_status_codes"]["503"], 1);
    assert_eq!(body["facets"]["error_status_codes"]["429"], 1);
    assert_eq!(body["stats"]["provider_failure_count"], 3);
    assert_eq!(body["stats"]["success_count"], 1);
    assert_eq!(body["stats"]["error_count"], 3);
    assert_eq!(body["stats"]["by_port"]["4444"]["total"], 4);
    assert_eq!(body["stats"]["by_port"]["4444"]["success"], 1);
    assert_eq!(body["stats"]["by_port"]["4444"]["error"], 3);
    assert_eq!(body["stats"]["by_port"]["4444"]["provider_failures"], 3);

    let filtered = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&status=retrying&error_status_code=502"
        ))
        .send()
        .await
        .expect("attempt filtered response");
    assert!(filtered.status().is_success());
    let filtered_body: serde_json::Value = filtered.json().await.expect("filtered json");
    assert_eq!(filtered_body["total"], 1);
    assert_eq!(
        filtered_body["records"][0]["event_type"],
        "request.provider_attempt_failed"
    );
    assert_eq!(filtered_body["records"][0]["result"], "failed-attempt");
    assert_eq!(filtered_body["records"][0]["meta"]["provider_status"], 502);

    let error_filtered = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&status=error&error_status_code=502"
        ))
        .send()
        .await
        .expect("error filtered response");
    assert!(error_filtered.status().is_success());
    let error_filtered_body: serde_json::Value = error_filtered.json().await.expect("error json");
    assert_eq!(error_filtered_body["total"], 1);
    assert_eq!(
        error_filtered_body["records"][0]["result"],
        "failed-attempt"
    );
}
