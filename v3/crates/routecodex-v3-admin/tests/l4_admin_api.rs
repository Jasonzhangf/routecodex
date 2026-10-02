// feature_id: v3.admin_api_integration
// Admin REST API 黑盒集成测试：使用 axum 自带 test server 拉起 in-process
// 服务，覆盖 Dashboard / Routes / Providers / Revisions / Reload 端点。
use routecodex_v3_admin::{router, AppState};
use routecodex_v3_config_mgmt::ConfigMgmtStore;
use std::path::PathBuf;

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

/// Local admin token provisioned by `AppState::new` for this temp config dir. Mutating
/// admin requests must carry it (one rule, no path exceptions).
fn admin_token(home: &std::path::Path) -> String {
    std::fs::read_to_string(home.join("state").join("admin-token"))
        .expect("admin token provisioned under <config_dir>/state/admin-token")
        .trim()
        .to_string()
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
    let (base, _state, home) = bind_test_server().await;
    let token = admin_token(&home);
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
        .header("x-routecodex-admin-token", &token)
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
        .header("x-routecodex-admin-token", &token)
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
    assert!(
        routes_body.contains(r#"<script type="module" src="/app/views/routes.js"></script>"#),
        "routes page wires its view through the module entry"
    );
    assert!(routes_body.contains("aria-live=\"polite\""));
    let css = http_client()
        .get(format!("{base}/styles.css"))
        .send()
        .await
        .expect("css response");
    assert!(css.status().is_success());
}

#[tokio::test]
async fn provider_health_test_returns_inline_diagnostic_without_second_health_truth() {
    let (base, _state, home) = bind_test_server().await;
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
        .header("x-routecodex-admin-token", admin_token(&home))
        .send()
        .await
        .expect("health response");
    assert!(response.status().is_success());
    let body: serde_json::Value = response.json().await.expect("health json");
    assert_eq!(body["provider_id"].as_str(), Some("local"));
    assert!(
        body.get("latency_ms").is_some(),
        "the ad-hoc diagnostic returns its measurement inline: {body}"
    );
    assert_eq!(
        body["ok"].as_bool(),
        Some(false),
        "an unreachable base URL must report a real failure: {body}"
    );
    assert!(
        body["error"].is_string(),
        "the ad-hoc diagnostic must expose the failure inline: {body}"
    );

    // No second provider-health truth: neither the list nor the detail projection may
    // expose a cached `health` field.
    let list: serde_json::Value = http_client()
        .get(format!("{base}/api/providers"))
        .send()
        .await
        .expect("providers response")
        .json()
        .await
        .expect("providers json");
    let providers = list.as_array().expect("providers array");
    assert!(!providers.is_empty(), "provider list populated");
    for provider in providers {
        assert!(
            provider.get("health").is_none(),
            "provider list must not expose a second provider-health truth: {provider}"
        );
    }
    let detail: serde_json::Value = http_client()
        .get(format!("{base}/api/providers/local"))
        .send()
        .await
        .expect("provider detail response")
        .json()
        .await
        .expect("provider detail json");
    assert!(
        detail.get("health").is_none(),
        "provider detail must not expose a second provider-health truth: {detail}"
    );
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

/// Same request row shape, with the typed error category chosen by the caller.
/// `provider_status` stays the projected client status, which is why a local
/// transport failure and a genuine upstream 502 both project `502`.
fn observability_attempt_row_with_category(
    request_key: &str,
    provider_status: u16,
    error_category: &str,
) -> serde_json::Value {
    let mut row = observability_attempt_row(request_key, provider_status);
    row["meta"]["error_category"] = serde_json::json!(error_category);
    row
}

fn find_record<'a>(body: &'a serde_json::Value, request_key: &str) -> &'a serde_json::Value {
    body["records"]
        .as_array()
        .expect("records array")
        .iter()
        .find(|row| row["request_key"] == request_key)
        .unwrap_or_else(|| panic!("record {request_key} missing from {body}"))
}

/// Acceptance criteria 2 and 5: one `502` bucket splits into the provider really
/// answering 502 versus our own transport failure, while the pre-existing
/// `error_status_codes` facet stays exactly as it was.
#[tokio::test]
async fn observability_splits_one_error_status_bucket_by_origin() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(
        &home,
        &[
            observability_attempt_row_with_category("4444:upstream", 502, "provider_http_502"),
            observability_attempt_row_with_category("4444:local", 502, "provider_transport_error"),
        ],
    );

    let body: serde_json::Value = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&range=all"
        ))
        .send()
        .await
        .expect("records response")
        .json()
        .await
        .expect("records json");

    // Unchanged: both rows still project the client status 502.
    assert_eq!(body["facets"]["error_status_codes"]["502"], 2);
    // The new facet is the direct answer to the complaint: `502` is 1 + 1, not 2.
    assert_eq!(
        body["facets"]["error_status_origins"]["502"],
        serde_json::json!({"upstream": 1, "local": 1})
    );
    assert_eq!(
        body["facets"]["error_origins"],
        serde_json::json!({"upstream": 1, "local": 1, "unknown": 0})
    );
}

/// Acceptance criterion 3: every failure row carries its own origin next to
/// `result`, and a success row carries none.
#[tokio::test]
async fn observability_rows_expose_error_origin() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(
        &home,
        &[
            observability_attempt_row_with_category("4444:upstream", 502, "provider_http_502"),
            observability_attempt_row_with_category("4444:local", 502, "provider_transport_error"),
            observability_row_with_result("4444:ok", Some("success")),
        ],
    );

    let body: serde_json::Value = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&range=all"
        ))
        .send()
        .await
        .expect("records response")
        .json()
        .await
        .expect("records json");

    assert_eq!(
        find_record(&body, "4444:upstream")["error_origin"],
        "upstream"
    );
    assert_eq!(find_record(&body, "4444:local")["error_origin"], "local");
    assert!(
        find_record(&body, "4444:ok")["error_origin"].is_null(),
        "a success row has no error origin"
    );
}

/// Acceptance criterion 5: for every status `s`, the origin counts sum to
/// `error_status_codes[s]` and `error_status_origins[s].upstream` equals the
/// number of rows whose category really is `provider_http_s`. This is what makes
/// the new facet a strict refinement of the old one rather than a second,
/// independently-computed number.
#[tokio::test]
async fn observability_status_origins_refine_status_codes_per_status() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(
        &home,
        &[
            observability_attempt_row_with_category("4444:up-502", 502, "provider_http_502"),
            observability_attempt_row_with_category(
                "4444:loc-502",
                502,
                "provider_transport_error",
            ),
            observability_attempt_row_with_category("4444:up-429", 429, "provider_http_429"),
            observability_attempt_row_with_category("4444:loc-503", 503, "api_error"),
            observability_row_with_result("4444:ok", Some("success")),
        ],
    );

    let body: serde_json::Value = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&range=all"
        ))
        .send()
        .await
        .expect("records response")
        .json()
        .await
        .expect("records json");

    let codes = body["facets"]["error_status_codes"]
        .as_object()
        .expect("error_status_codes object");
    let origins = body["facets"]["error_status_origins"]
        .as_object()
        .expect("error_status_origins object");
    assert_eq!(
        codes.keys().collect::<Vec<_>>(),
        origins.keys().collect::<Vec<_>>(),
        "the refined facet must cover exactly the statuses the old facet reports"
    );
    // The cross-check: upstream == the number of rows whose category really is
    // `provider_http_<status>` (only 502 and 429 have such a row above).
    let upstream_rows_for = |status: &str| -> u64 {
        match status {
            "502" | "429" => 1,
            _ => 0,
        }
    };
    for (status, code_count) in codes {
        let split = origins[status]
            .as_object()
            .expect("per-status origin object");
        let split_total: u64 = split.values().map(|count| count.as_u64().unwrap()).sum();
        assert_eq!(
            split_total,
            code_count.as_u64().unwrap(),
            "status {status} must split into exactly its own total"
        );
        assert_eq!(
            split
                .get("upstream")
                .and_then(|count| count.as_u64())
                .unwrap_or(0),
            upstream_rows_for(status),
            "status {status} upstream count must equal its provider_http_{status} rows"
        );
    }
    assert_eq!(
        origins["502"],
        serde_json::json!({"upstream": 1, "local": 1})
    );
    assert_eq!(origins["429"], serde_json::json!({"upstream": 1}));
    assert_eq!(origins["503"], serde_json::json!({"local": 1}));
}

/// Acceptance criterion 4: the filter selects by origin, AND-combines with
/// `error_status_code`, and rejects an unknown origin value.
#[tokio::test]
async fn observability_filters_by_error_origin() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(
        &home,
        &[
            observability_attempt_row_with_category("4444:upstream-502", 502, "provider_http_502"),
            observability_attempt_row_with_category("4444:upstream-503", 503, "provider_http_503"),
            observability_attempt_row_with_category(
                "4444:local-502",
                502,
                "provider_transport_error",
            ),
            observability_attempt_row_with_category(
                "4444:local-timeout",
                502,
                "provider_response_header_timeout",
            ),
            observability_row_with_result("4444:ok", Some("success")),
        ],
    );

    let local: serde_json::Value = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&range=all&error_origin=local"
        ))
        .send()
        .await
        .expect("local response")
        .json()
        .await
        .expect("local json");
    assert_eq!(local["total"], 2);
    for row in local["records"].as_array().expect("local records") {
        assert_eq!(row["error_origin"], "local");
    }

    let upstream_502: serde_json::Value = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&range=all&error_origin=upstream&error_status_code=502"
        ))
        .send()
        .await
        .expect("upstream 502 response")
        .json()
        .await
        .expect("upstream 502 json");
    assert_eq!(
        upstream_502["total"], 1,
        "only the genuine upstream 502, not the local failures that also project 502"
    );
    assert_eq!(
        find_record(&upstream_502, "4444:upstream-502")["error_origin"],
        "upstream"
    );

    let rejected = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&error_origin=bogus"
        ))
        .send()
        .await
        .expect("bogus origin response");
    assert_eq!(rejected.status(), 400);
    let rejected_body: serde_json::Value = rejected.json().await.expect("bogus origin json");
    assert_eq!(rejected_body["error"], "invalid error_origin: bogus");
}

/// Every browser-requestable WebUI asset must really be served by the admin router.
///
/// `api/mod.rs` serves static assets from an exhaustive allowlist - there is no `ServeDir`, no
/// wildcard and no fallback - so shipping a new view module without registering it in three
/// places (`include_str!` const, `build_router` route, `static_serve` match arm) makes the
/// browser 404 the module, the ES module graph fails to resolve, and the whole page dies.
/// That is invisible to the smoke scripts, which read files from disk: only a request through
/// the real router can see it. This walks the real `admin-webui` directory and GETs every asset.
#[tokio::test]
async fn every_webui_asset_is_served_by_the_admin_router() {
    let (base, _state, _home) = bind_test_server().await;
    let client = http_client();

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../admin-webui");
    let root = root
        .canonicalize()
        .unwrap_or_else(|error| panic!("canonicalize {}: {error}", root.display()));
    let mut assets = Vec::new();
    collect_webui_assets(&root, &root, &mut assets);
    assets.sort();

    // Guard the walk itself: an empty or tiny set would make the assertion below vacuous.
    assert!(
        assets.len() >= 15,
        "expected the real admin-webui asset set, found {}: {assets:?}",
        assets.len()
    );
    for required in [
        "providers.html",
        "app/views/providers.js",
        "app/views/provider-models.js",
        "app/core.js",
        "styles.css",
        "vendor/ambient.css",
    ] {
        assert!(
            assets.iter().any(|asset| asset == required),
            "asset walk missed {required}; found {assets:?}"
        );
    }

    for asset in &assets {
        let response = client
            .get(format!("{base}/{asset}"))
            .send()
            .await
            .unwrap_or_else(|error| panic!("GET /{asset} failed: {error}"));
        assert_eq!(
            response.status(),
            reqwest::StatusCode::OK,
            "/{asset} is a browser-requestable WebUI asset but the admin router does not serve it. \
             Register it in api/mod.rs (build_router route + static_serve match arm) and add the \
             include_str! const in lib.rs."
        );
        let body = response.text().await.expect("asset body");
        assert!(!body.is_empty(), "/{asset} was served with an empty body");
    }
}

/// Collect every file the browser could request. The rule is inverted on purpose: everything in
/// `admin-webui` must be served, and the only exclusion is an explicit one, so adding an asset
/// type the allowlist does not know about (an `.svg`, a font, a source map) fails this test
/// instead of 404ing in the browser while the test still passes.
fn collect_webui_assets(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<String>) {
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|error| panic!("read_dir {dir:?}: {error}"));
    for entry in entries {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_webui_assets(root, &path, out);
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        // Node-only smoke scripts: they run under `node`, the browser never requests them.
        if name.ends_with(".mjs") {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .expect("asset lives under admin-webui")
            .to_string_lossy()
            .replace('\\', "/");
        out.push(relative);
    }
}
