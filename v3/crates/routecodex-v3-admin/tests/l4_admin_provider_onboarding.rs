// feature_id: v3.admin_api_integration
// Provider onboarding / probe / patrol 黑盒集成测试。
//
// 覆盖：候选校验不落盘、无效候选永不写入、create/update 的 revision 字段正确、
// 被引用 provider 拒删、未引用 provider 删除 + 备份、probe evidence 不泄漏 secret、
// 批量导入 partial success + 可重试失败集、上游模型发现使用真实 auth、
// 路由绑定写入 revision、patrol 计划与结果历史落盘。
use routecodex_v3_admin::{router, AppState};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_home() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rcc-admin-onboarding-{}-{}",
        std::process::id(),
        TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).expect("temp home");
    dir
}

fn provider_toml(id: &str, base_url: &str, api_key: &str, model: &str) -> String {
    format!(
        r#"
version = "2.0.0"
providerId = "{id}"

[provider]
id = "{id}"
enabled = true
type = "openai_chat"
baseURL = "{base_url}"
defaultModel = "{model}"

[provider.auth]
type = "apikey"
apiKey = "{api_key}"

[provider.models."{model}"]
supportsStreaming = true
"#
    )
}

fn provider_json(id: &str, base_url: &str, api_key: &str, model: &str) -> Value {
    json!({
        "version": "2.0.0",
        "providerId": id,
        "provider": {
            "id": id,
            "enabled": true,
            "type": "openai_chat",
            "baseURL": base_url,
            "defaultModel": model,
            "auth": { "apiKey": api_key },
            "models": { model: { "supportsStreaming": true } }
        }
    })
}

fn write_provider(home: &Path, id: &str, body: &str) {
    let dir = home.join("provider").join(id);
    std::fs::create_dir_all(&dir).expect("provider dir");
    std::fs::write(dir.join("config.v2.toml"), body).expect("provider file");
}

/// p1/m1 被两个 listener 的默认路由引用；p2 存在但未被引用。
fn write_init_config(home: &Path) -> PathBuf {
    write_provider(
        home,
        "p1",
        &provider_toml("p1", "http://127.0.0.1:9999/v1", "sk-test", "m1"),
    );
    let path = home.join("config.toml");
    std::fs::write(
        &path,
        r#"version = 3

[servers.routecodex_v3_4444]
bind = "127.0.0.1"
port = 4444
[servers.routecodex_v3_4444.routes.default]
tiers = [[{ use = "p1/m1" }]]
"#,
    )
    .expect("user config");
    path
}

fn admin_token(home: &Path) -> String {
    std::fs::read_to_string(home.join("state").join("admin-token"))
        .expect("admin token provisioned")
        .trim()
        .to_string()
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("http client")
}

async fn bind_test_server() -> (String, AppState, PathBuf) {
    let home = temp_home();
    let config_path = write_init_config(&home);
    let state = AppState::new(config_path);
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let address = listener.local_addr().expect("addr");
    let base = format!("http://{address}");
    let app = router(state.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (base, state, home)
}

fn revisions(home: &Path) -> Vec<Value> {
    let path = home.join("state").join("config-revisions.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.get("revisions").cloned())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn provider_file(home: &Path, id: &str) -> PathBuf {
    home.join("provider").join(id).join("config.v2.toml")
}

// ---------------------------------------------------------------------------
// mock upstream
// ---------------------------------------------------------------------------

fn content_length(request: &str) -> Option<usize> {
    request.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("content-length") {
            value.trim().parse::<usize>().ok()
        } else {
            None
        }
    })
}

/// 单次/多次连接的 mock 上游：记录完整请求文本，返回 `body_for(request)`。
async fn spawn_mock_upstream<F>(
    status: u16,
    connections: usize,
    body_for: F,
) -> (String, Arc<Mutex<Vec<String>>>)
where
    F: Fn(&str) -> String + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("mock bind");
    let address = listener.local_addr().expect("mock addr");
    let captured = Arc::new(Mutex::new(Vec::new()));
    let captured_server = Arc::clone(&captured);
    let body_for = Arc::new(body_for);
    tokio::spawn(async move {
        for _ in 0..connections {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let mut raw = Vec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                let n = match stream.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                raw.extend_from_slice(&buffer[..n]);
                if raw.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let head = String::from_utf8_lossy(&raw).to_string();
            if let Some(length) = content_length(&head) {
                let header_end = raw
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|index| index + 4)
                    .unwrap_or(raw.len());
                while raw.len() < header_end + length {
                    let n = match stream.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    raw.extend_from_slice(&buffer[..n]);
                }
            }
            let request = String::from_utf8_lossy(&raw).to_string();
            captured_server.lock().unwrap().push(request.clone());
            let body = body_for(&request);
            let reason = if (200..300).contains(&status) {
                "OK"
            } else {
                "Unauthorized"
            };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
    });
    (format!("http://{address}"), captured)
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn validate_writes_nothing_and_reports_compiled_contract() {
    let (base, _state, home) = bind_test_server().await;
    let token = admin_token(&home);
    let response = http_client()
        .post(format!("{base}/api/providers/validate"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({ "config": provider_json("p9", "http://127.0.0.1:9999/v1", "sk-x", "m9") }))
        .send()
        .await
        .expect("validate response");
    assert!(response.status().is_success(), "validate must be 200");
    let payload: Value = response.json().await.expect("validate json");
    assert_eq!(
        payload.get("ok").and_then(Value::as_bool),
        Some(true),
        "{payload}"
    );
    assert_eq!(
        payload.get("normalized_type").and_then(Value::as_str),
        Some("openai_chat"),
        "normalized type comes from the real compile chain: {payload}"
    );
    assert_eq!(
        payload
            .get("models")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(1)
    );
    assert!(
        !home.join("provider").join("p9").exists(),
        "validate must never create provider files"
    );
    assert!(
        revisions(&home).is_empty(),
        "validate must not append a revision"
    );
}

#[tokio::test]
async fn create_rejects_invalid_candidate_without_writing() {
    let (base, _state, home) = bind_test_server().await;
    let token = admin_token(&home);
    let mut candidate = provider_json("p9", "http://127.0.0.1:9999/v1", "sk-x", "m9");
    // defaultModel 不在 models 表内：候选契约必须拒绝。
    candidate["provider"]["defaultModel"] = json!("missing-model");
    let response = http_client()
        .post(format!("{base}/api/providers"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({ "config": candidate }))
        .send()
        .await
        .expect("create response");
    assert_eq!(response.status().as_u16(), 422);
    let payload: Value = response.json().await.expect("create json");
    assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
    let errors = payload
        .get("errors")
        .and_then(Value::as_array)
        .expect("field errors");
    assert!(
        errors.iter().any(|error| error
            .get("field")
            .and_then(Value::as_str)
            .is_some_and(|field| field == "default_model")),
        "field-level error must locate default_model: {payload}"
    );
    assert!(
        !provider_file(&home, "p9").exists(),
        "invalid candidate must never be written"
    );
    assert!(
        revisions(&home).is_empty(),
        "no revision for a rejected create"
    );
}

#[tokio::test]
async fn create_then_update_records_correct_revisions() {
    let (base, _state, home) = bind_test_server().await;
    let token = admin_token(&home);
    let candidate = provider_json("p9", "http://127.0.0.1:9999/v1", "sk-x", "m9");
    let response = http_client()
        .post(format!("{base}/api/providers"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({ "config": candidate, "reason": "onboard p9" }))
        .send()
        .await
        .expect("create response");
    assert_eq!(response.status().as_u16(), 200);
    let created: Value = response.json().await.expect("create json");
    assert_eq!(created.get("created").and_then(Value::as_bool), Some(true));
    assert_eq!(
        created.get("source_sha256").and_then(Value::as_str),
        Some("absent"),
        "first create replaces nothing: {created}"
    );
    assert!(created.get("backup").map(Value::is_null).unwrap_or(true));
    let first_bytes = std::fs::read(provider_file(&home, "p9")).expect("provider file written");

    let updated = provider_json("p9", "http://127.0.0.1:9998/v1", "sk-y", "m9");
    let response = http_client()
        .put(format!("{base}/api/providers/p9"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({ "config": updated, "reason": "retarget p9" }))
        .send()
        .await
        .expect("update response");
    assert_eq!(response.status().as_u16(), 200);
    let updated_body: Value = response.json().await.expect("update json");
    assert_eq!(
        updated_body.get("created").and_then(Value::as_bool),
        Some(false)
    );
    let expected_sha = {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(&first_bytes))
    };
    assert_eq!(
        updated_body.get("source_sha256").and_then(Value::as_str),
        Some(expected_sha.as_str()),
        "update must record the replaced content hash, not a literal: {updated_body}"
    );
    let backup = updated_body
        .get("backup")
        .and_then(Value::as_str)
        .expect("update must produce a backup");
    assert!(
        Path::new(backup).is_file(),
        "backup file exists at {backup}"
    );

    let log = revisions(&home);
    assert_eq!(log.len(), 2, "one revision per write: {log:?}");
    assert_eq!(
        log[0].get("action").and_then(Value::as_str),
        Some("provider.create")
    );
    assert_eq!(
        log[0].get("target").and_then(Value::as_str),
        Some("provider/p9/config.v2.toml")
    );
    assert_eq!(
        log[0].get("source_sha256").and_then(Value::as_str),
        Some("absent")
    );
    assert_eq!(
        log[1].get("action").and_then(Value::as_str),
        Some("provider.update")
    );
    assert_eq!(
        log[1].get("source_sha256").and_then(Value::as_str),
        Some(expected_sha.as_str())
    );
    assert!(
        log[1].get("backup").and_then(Value::as_str).is_some(),
        "update revision records the backup path"
    );
    assert_eq!(
        log[1].get("reason").and_then(Value::as_str),
        Some("retarget p9")
    );
}

#[tokio::test]
async fn delete_refuses_referenced_provider_with_reference_list() {
    let (base, _state, home) = bind_test_server().await;
    let token = admin_token(&home);
    let response = http_client()
        .delete(format!("{base}/api/providers/p1"))
        .header("x-routecodex-admin-token", &token)
        .send()
        .await
        .expect("delete response");
    assert_eq!(
        response.status().as_u16(),
        409,
        "referenced provider must be refused"
    );
    let payload: Value = response.json().await.expect("delete json");
    assert_eq!(
        payload.get("error_code").and_then(Value::as_str),
        Some("provider_referenced")
    );
    let references = payload
        .get("references")
        .and_then(Value::as_array)
        .expect("references list");
    assert!(
        !references.is_empty(),
        "reference list must be present: {payload}"
    );
    assert!(
        provider_file(&home, "p1").is_file(),
        "refused delete keeps the file"
    );
    assert!(
        revisions(&home).is_empty(),
        "refused delete appends no revision"
    );
}

#[tokio::test]
async fn delete_removes_unreferenced_provider_with_backup() {
    let (base, _state, home) = bind_test_server().await;
    let token = admin_token(&home);
    write_provider(
        &home,
        "p2",
        &provider_toml("p2", "http://127.0.0.1:9997/v1", "sk-p2", "m2"),
    );
    let response = http_client()
        .delete(format!("{base}/api/providers/p2"))
        .header("x-routecodex-admin-token", &token)
        .send()
        .await
        .expect("delete response");
    assert_eq!(response.status().as_u16(), 200);
    let payload: Value = response.json().await.expect("delete json");
    let backup = payload
        .get("backup")
        .and_then(Value::as_str)
        .expect("delete records a backup");
    assert!(Path::new(backup).is_file(), "backup survives the delete");
    assert!(
        !home.join("provider").join("p2").exists(),
        "provider directory removed"
    );
    let log = revisions(&home);
    assert_eq!(log.len(), 1);
    assert_eq!(
        log[0].get("action").and_then(Value::as_str),
        Some("provider.delete")
    );
    assert!(log[0]
        .get("source_sha256")
        .and_then(Value::as_str)
        .is_some_and(|sha| sha != "absent"));
}

#[tokio::test]
async fn probe_stream_never_leaks_secret_material() {
    const SECRET: &str = "sk-probe-secret-abc123";
    let (upstream, captured) = spawn_mock_upstream(401, 4, |request| {
        let echoed = request
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("authorization:"))
            .unwrap_or("authorization: missing")
            .trim()
            .to_string();
        json!({ "error": { "message": format!("bad key {echoed}") } }).to_string()
    })
    .await;
    let (base, _state, home) = bind_test_server().await;
    let token = admin_token(&home);
    let response = http_client()
        .post(format!("{base}/api/providers/probe"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "config": provider_json("p9", &format!("{upstream}/v1"), SECRET, "m9"),
        }))
        .send()
        .await
        .expect("probe response");
    assert_eq!(response.status().as_u16(), 200, "probe streams over SSE");
    let body = response.text().await.expect("probe stream body");
    assert!(
        body.contains("stage_started"),
        "SSE stage events present: {body}"
    );
    assert!(
        body.contains("probe_complete"),
        "SSE terminal event present"
    );
    assert!(
        body.contains("provider_http_status"),
        "L2 must report the real upstream status: {body}"
    );
    assert!(
        !body.contains(SECRET),
        "probe evidence must never contain the resolved secret: {body}"
    );
    assert!(
        body.contains("[redacted]"),
        "redaction marker must be visible in the evidence: {body}"
    );
    let captured = captured.lock().unwrap().clone();
    assert!(
        captured.iter().any(|request| request
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-probe-secret-abc123")),
        "L2 must send the real auth header: {captured:?}"
    );
}

#[tokio::test]
async fn import_partial_success_reports_retryable_failures() {
    let (base, _state, home) = bind_test_server().await;
    let token = admin_token(&home);
    let good = provider_toml("p7", "http://127.0.0.1:9996/v1", "sk-p7", "m7");
    let bad = "this is not toml = = =";
    let text = format!("{good}\n---\n{bad}\n");
    let response = http_client()
        .post(format!("{base}/api/providers/import"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({ "text": text, "dry_run": false }))
        .send()
        .await
        .expect("import response");
    assert_eq!(response.status().as_u16(), 200);
    let payload: Value = response.json().await.expect("import json");
    assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(payload.get("written").and_then(Value::as_u64), Some(1));
    assert_eq!(payload.get("failed").and_then(Value::as_u64), Some(1));
    let items = payload
        .get("items")
        .and_then(Value::as_array)
        .expect("items");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(items[0].get("written").and_then(Value::as_bool), Some(true));
    assert_eq!(items[1].get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        items[1].get("retryable").and_then(Value::as_bool),
        Some(true)
    );
    assert!(
        items[1]
            .get("parse_error")
            .and_then(Value::as_str)
            .is_some(),
        "failed item carries the parse error: {}",
        items[1]
    );
    let retry_text = payload
        .get("retry")
        .and_then(|retry| retry.get("text"))
        .and_then(Value::as_str)
        .expect("retryable failure set text");
    assert!(
        retry_text.contains(bad),
        "retry text is the failed document itself"
    );
    assert!(
        provider_file(&home, "p7").is_file(),
        "valid item is written"
    );
    assert_eq!(
        revisions(&home).len(),
        1,
        "one revision for the written item"
    );

    // dry_run 校验：不写入，但报告同样的失败集。
    let dry = http_client()
        .post(format!("{base}/api/providers/import"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({ "text": retry_text, "dry_run": true }))
        .send()
        .await
        .expect("dry-run response");
    let dry_payload: Value = dry.json().await.expect("dry-run json");
    assert_eq!(
        dry_payload.get("dry_run").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(dry_payload.get("written").and_then(Value::as_u64), Some(0));
    assert_eq!(dry_payload.get("failed").and_then(Value::as_u64), Some(1));
}

#[tokio::test]
async fn discover_returns_upstream_models_and_uses_real_auth() {
    const SECRET: &str = "sk-discover-secret-xyz";
    let (upstream, captured) = spawn_mock_upstream(200, 1, |_| {
        json!({ "data": [{ "id": "upstream-a" }, { "id": "upstream-b" }] }).to_string()
    })
    .await;
    let (base, _state, home) = bind_test_server().await;
    let token = admin_token(&home);
    let response = http_client()
        .post(format!("{base}/api/providers/discover"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "config": provider_json("p9", &format!("{upstream}/v1"), SECRET, "m9"),
        }))
        .send()
        .await
        .expect("discover response");
    assert_eq!(response.status().as_u16(), 200);
    let payload: Value = response.json().await.expect("discover json");
    assert_eq!(
        payload
            .get("models")
            .and_then(Value::as_array)
            .map(|models| models.iter().filter_map(Value::as_str).collect::<Vec<_>>()),
        Some(vec!["upstream-a", "upstream-b"]),
        "discovery returns the real upstream list: {payload}"
    );
    assert!(
        !payload.to_string().contains(SECRET),
        "discovery response must never echo the secret: {payload}"
    );
    let captured = captured.lock().unwrap().clone();
    let request = captured.first().expect("one discovery request");
    assert!(
        request.starts_with("GET /v1/models HTTP/1.1"),
        "openai_chat discovery must GET {{base_url}}/models: {request}"
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-discover-secret-xyz"),
        "discovery must use the real resolved credential: {request}"
    );
}

#[tokio::test]
async fn discover_reports_upstream_failure_instead_of_guessing() {
    let (upstream, _captured) =
        spawn_mock_upstream(500, 1, |_| json!({ "error": "boom" }).to_string()).await;
    let (base, _state, home) = bind_test_server().await;
    let token = admin_token(&home);
    let response = http_client()
        .post(format!("{base}/api/providers/discover"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "config": provider_json("p9", &format!("{upstream}/v1"), "sk-x", "m9"),
        }))
        .send()
        .await
        .expect("discover response");
    assert_eq!(response.status().as_u16(), 502);
    let payload: Value = response.json().await.expect("discover json");
    assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
    assert!(
        payload.get("models").is_none(),
        "failure must not fabricate a model list: {payload}"
    );
    assert!(
        payload
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|error| error.contains("500")),
        "explicit failure carries the upstream status: {payload}"
    );
}

#[tokio::test]
async fn bind_route_records_revision_and_blocks_delete() {
    let (base, _state, home) = bind_test_server().await;
    let token = admin_token(&home);
    write_provider(
        &home,
        "p2",
        &provider_toml("p2", "http://127.0.0.1:9995/v1", "sk-p2", "m2"),
    );
    let response = http_client()
        .post(format!("{base}/api/providers/routes/bind"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "provider_id": "p2",
            "server_id": "routecodex_v3_4444",
            "pool": "default",
            "tier": 1,
        }))
        .send()
        .await
        .expect("bind response");
    assert_eq!(response.status().as_u16(), 200);
    let payload: Value = response.json().await.expect("bind json");
    assert_eq!(payload.get("written").and_then(Value::as_bool), Some(true));
    assert_eq!(
        payload.get("use_ref").and_then(Value::as_str),
        Some("p2/m2")
    );
    assert!(
        payload
            .get("compiled_providers")
            .and_then(Value::as_array)
            .is_some_and(|providers| providers
                .iter()
                .any(|provider| provider.as_str() == Some("p2"))),
        "the bound provider must exist in the compiled manifest: {payload}"
    );
    let log = revisions(&home);
    assert_eq!(log.len(), 1);
    assert_eq!(
        log[0].get("action").and_then(Value::as_str),
        Some("route.bind")
    );

    // 幂等：同一 member 再绑一次不写第二份。
    let again = http_client()
        .post(format!("{base}/api/providers/routes/bind"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "provider_id": "p2",
            "server_id": "routecodex_v3_4444",
            "pool": "default",
            "tier": 1,
        }))
        .send()
        .await
        .expect("second bind response");
    let again_payload: Value = again.json().await.expect("second bind json");
    assert_eq!(
        again_payload.get("already_bound").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        revisions(&home).len(),
        1,
        "idempotent bind adds no revision"
    );

    let delete = http_client()
        .delete(format!("{base}/api/providers/p2"))
        .header("x-routecodex-admin-token", &token)
        .send()
        .await
        .expect("delete response");
    assert_eq!(
        delete.status().as_u16(),
        409,
        "a bound provider must be refused by delete"
    );
}

#[tokio::test]
async fn bind_failures_are_explicit_and_members_are_replaced_in_place() {
    let (base, _state, home) = bind_test_server().await;
    let token = admin_token(&home);
    write_provider(
        &home,
        "p2",
        &provider_toml("p2", "http://127.0.0.1:9995/v1", "sk-p2", "m2"),
    );
    let client = http_client();

    // 未知 server：显式失败并列出已知 server id。
    let unknown = client
        .post(format!("{base}/api/providers/routes/bind"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "provider_id": "p2",
            "server_id": "not-a-server",
            "pool": "default",
        }))
        .send()
        .await
        .expect("unknown server response");
    assert_eq!(unknown.status().as_u16(), 404);
    let unknown_payload: Value = unknown.json().await.expect("unknown server json");
    assert_eq!(
        unknown_payload.get("error_code").and_then(Value::as_str),
        Some("unknown_server")
    );
    assert!(
        unknown_payload
            .get("known_servers")
            .and_then(Value::as_array)
            .is_some_and(|servers| servers
                .iter()
                .any(|server| server.as_str() == Some("routecodex_v3_4444"))),
        "failure must list the known server ids: {unknown_payload}"
    );

    // 未声明的 model：显式失败，绝不猜测写入。
    let ghost = client
        .post(format!("{base}/api/providers/routes/bind"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "provider_id": "p2",
            "server_id": "routecodex_v3_4444",
            "pool": "default",
            "model": "ghost-model",
        }))
        .send()
        .await
        .expect("undeclared model response");
    assert_eq!(ghost.status().as_u16(), 422);
    let ghost_payload: Value = ghost.json().await.expect("undeclared model json");
    assert_eq!(
        ghost_payload.get("error_code").and_then(Value::as_str),
        Some("model_not_declared")
    );
    assert!(
        ghost_payload
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|error| error.contains("m2")),
        "failure must list the declared models: {ghost_payload}"
    );
    assert!(revisions(&home).is_empty(), "rejected binds write nothing");

    // 非标准 pool：真实编译链显式拒绝，绝不静默建 pool 或改写路由。
    let nonstandard = client
        .post(format!("{base}/api/providers/routes/bind"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "provider_id": "p2",
            "server_id": "routecodex_v3_4444",
            "pool": "fresh-pool",
        }))
        .send()
        .await
        .expect("non-standard pool response");
    assert_eq!(nonstandard.status().as_u16(), 422);
    let nonstandard_payload: Value = nonstandard.json().await.expect("non-standard pool json");
    assert_eq!(
        nonstandard_payload
            .get("error_code")
            .and_then(Value::as_str),
        Some("route_compile_failed")
    );
    assert!(
        nonstandard_payload
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|error| error.contains("fresh-pool")),
        "the compile chain must name the rejected pool: {nonstandard_payload}"
    );
    assert!(
        revisions(&home).is_empty(),
        "a rejected pool must not be written"
    );

    // 标准但缺失的 pool：pool_created=true（只有真的不存在时才为真），tier_created=true。
    let created = client
        .post(format!("{base}/api/providers/routes/bind"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "provider_id": "p2",
            "server_id": "routecodex_v3_4444",
            "pool": "compact",
            "reason": "bind p2 into compact pool",
        }))
        .send()
        .await
        .expect("created pool response");
    let created_status = created.status().as_u16();
    let created_payload: Value = created.json().await.expect("created pool json");
    assert_eq!(
        created_status, 200,
        "binding into a missing standard pool must succeed: {created_payload}"
    );
    assert_eq!(
        created_payload.get("pool_created").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        created_payload.get("tier_created").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        created_payload.get("replaced").and_then(Value::as_bool),
        Some(false)
    );
    let log = revisions(&home);
    assert_eq!(log.len(), 1);
    assert_eq!(
        log[0].get("reason").and_then(Value::as_str),
        Some("bind p2 into compact pool"),
        "the caller reason must be recorded in the revision entry"
    );

    // 已存在的 default pool + 新 tier：pool_created=false，tier_created=true。
    let first = client
        .post(format!("{base}/api/providers/routes/bind"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "provider_id": "p2",
            "server_id": "routecodex_v3_4444",
            "pool": "default",
            "tier": 1,
            "reason": "bind p2 into default pool",
        }))
        .send()
        .await
        .expect("first bind response");
    let first_status = first.status().as_u16();
    let first_payload: Value = first.json().await.expect("first bind json");
    assert_eq!(
        first_status, 200,
        "first bind must succeed: {first_payload}"
    );
    assert_eq!(
        first_payload.get("pool_created").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        first_payload.get("tier_created").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        first_payload.get("replaced").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        first_payload
            .get("member")
            .and_then(|member| member.get("use_ref"))
            .and_then(Value::as_str),
        Some("p2/m2")
    );
    let log = revisions(&home);
    assert_eq!(log.len(), 2);
    assert_eq!(
        log[1].get("reason").and_then(Value::as_str),
        Some("bind p2 into default pool"),
        "the caller reason must be recorded in the revision entry"
    );

    // 同 use_ref 但不同 weight：原地替换，不追加重复成员。
    let second = client
        .post(format!("{base}/api/providers/routes/bind"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "provider_id": "p2",
            "server_id": "routecodex_v3_4444",
            "pool": "default",
            "tier": 1,
            "weight": 3,
        }))
        .send()
        .await
        .expect("second bind response");
    let second_payload: Value = second.json().await.expect("second bind json");
    assert_eq!(
        second_payload.get("replaced").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        second_payload.get("pool_created").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        second_payload.get("tier_created").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        second_payload
            .get("member")
            .and_then(|member| member.get("weight"))
            .and_then(Value::as_u64),
        Some(3)
    );
    let group = second_payload
        .get("servers")
        .and_then(Value::as_array)
        .and_then(|servers| {
            servers.iter().find(|server| {
                server.get("server_id").and_then(Value::as_str) == Some("routecodex_v3_4444")
            })
        })
        .expect("bound server view");
    let members = group
        .get("pools")
        .and_then(Value::as_array)
        .and_then(|pools| {
            pools
                .iter()
                .find(|pool| pool.get("name").and_then(Value::as_str) == Some("default"))
        })
        .and_then(|pool| pool.get("tiers"))
        .and_then(Value::as_array)
        .and_then(|tiers| tiers.get(1))
        .and_then(|tier| tier.get("members"))
        .and_then(Value::as_array)
        .expect("tier members");
    assert_eq!(
        members.len(),
        1,
        "re-binding the same use_ref must replace in place, not append: {members:?}"
    );
    assert_eq!(
        members[0].get("use").and_then(Value::as_str),
        Some("p2/m2"),
        "the view serializes the member reference as `use`: {members:?}"
    );
    assert_eq!(members[0].get("weight").and_then(Value::as_u64), Some(3));

    // 完全相同的绑定：already_bound，不写第二份。
    let third = client
        .post(format!("{base}/api/providers/routes/bind"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "provider_id": "p2",
            "server_id": "routecodex_v3_4444",
            "pool": "default",
            "tier": 1,
            "weight": 3,
        }))
        .send()
        .await
        .expect("third bind response");
    let third_payload: Value = third.json().await.expect("third bind json");
    assert_eq!(
        third_payload.get("already_bound").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        third_payload.get("written").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        revisions(&home).len(),
        3,
        "an identical re-bind adds no revision"
    );
}

#[tokio::test]
async fn patrol_plan_roundtrip_persists_results_history() {
    let (base, _state, home) = bind_test_server().await;
    let token = admin_token(&home);

    let missing = http_client()
        .get(format!("{base}/api/providers/p1/patrol"))
        .send()
        .await
        .expect("plan response");
    let missing_payload: Value = missing.json().await.expect("plan json");
    assert_eq!(
        missing_payload.get("stored").and_then(Value::as_bool),
        Some(false),
        "unconfigured provider returns the default (disabled) plan"
    );
    assert_eq!(
        missing_payload
            .get("plan")
            .and_then(|plan| plan.get("enabled"))
            .and_then(Value::as_bool),
        Some(false)
    );

    let invalid = http_client()
        .put(format!("{base}/api/providers/p1/patrol"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "enabled": true,
            "interval_secs": 0,
            "stages": ["l1_contract"],
        }))
        .send()
        .await
        .expect("invalid plan response");
    assert_eq!(
        invalid.status().as_u16(),
        400,
        "enabled plan needs an interval"
    );

    let put = http_client()
        .put(format!("{base}/api/providers/p1/patrol"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "enabled": false,
            "interval_secs": 300,
            "stages": ["l1_contract"],
        }))
        .send()
        .await
        .expect("put plan response");
    assert_eq!(put.status().as_u16(), 200);
    let put_payload: Value = put.json().await.expect("put plan json");
    assert_eq!(
        put_payload.get("stored").and_then(Value::as_bool),
        Some(true)
    );

    let get = http_client()
        .get(format!("{base}/api/providers/p1/patrol"))
        .send()
        .await
        .expect("get plan response");
    let get_payload: Value = get.json().await.expect("get plan json");
    assert_eq!(
        get_payload.get("stored").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        get_payload
            .get("plan")
            .and_then(|plan| plan.get("interval_secs"))
            .and_then(Value::as_u64),
        Some(300)
    );

    let run = http_client()
        .post(format!("{base}/api/providers/p1/patrol/run"))
        .header("x-routecodex-admin-token", &token)
        .send()
        .await
        .expect("patrol run response");
    assert_eq!(run.status().as_u16(), 200);
    let run_payload: Value = run.json().await.expect("patrol run json");
    assert_eq!(
        run_payload.get("ok").and_then(Value::as_bool),
        Some(true),
        "{run_payload}"
    );
    let result = run_payload.get("result").expect("patrol result");
    assert_eq!(
        result.get("trigger").and_then(Value::as_str),
        Some("manual")
    );
    assert_eq!(
        result.get("source").and_then(Value::as_str),
        Some("admin_provider_patrol"),
        "patrol results must be labelled as admin diagnostics, not runtime health"
    );
    assert_eq!(
        result.get("stages").and_then(Value::as_array).map(Vec::len),
        Some(1),
        "only the planned stage runs"
    );

    let history_path = home.join("state").join("provider-patrol.jsonl");
    assert!(
        history_path.is_file(),
        "patrol history persists to provider-patrol.jsonl"
    );
    let history = std::fs::read_to_string(&history_path).expect("history readable");
    assert_eq!(history.lines().count(), 1, "one line per patrol run");

    let results = http_client()
        .get(format!("{base}/api/providers/p1/patrol/results"))
        .send()
        .await
        .expect("results response");
    let results_payload: Value = results.json().await.expect("results json");
    assert_eq!(
        results_payload.get("count").and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        results_payload
            .get("results")
            .and_then(Value::as_array)
            .and_then(|results| results.first())
            .and_then(|result| result.get("trigger"))
            .and_then(Value::as_str),
        Some("manual")
    );

    let status = http_client()
        .get(format!("{base}/api/providers/patrol/status"))
        .send()
        .await
        .expect("status response");
    let status_payload: Value = status.json().await.expect("status json");
    assert_eq!(
        status_payload.get("plan_count").and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        status_payload.get("enabled_count").and_then(Value::as_u64),
        Some(0)
    );
    assert!(status_payload
        .get("next_tick_ms")
        .and_then(Value::as_u64)
        .is_some());

    let deleted = http_client()
        .delete(format!("{base}/api/providers/p1/patrol"))
        .header("x-routecodex-admin-token", &token)
        .send()
        .await
        .expect("delete plan response");
    let deleted_payload: Value = deleted.json().await.expect("delete plan json");
    assert_eq!(
        deleted_payload.get("removed").and_then(Value::as_bool),
        Some(true)
    );
}

#[tokio::test]
async fn providers_page_and_modules_are_served_with_the_onboarding_surfaces() {
    let (base, _state, _home) = bind_test_server().await;
    let page = http_client()
        .get(format!("{base}/providers.html"))
        .send()
        .await
        .expect("providers page response");
    assert!(page.status().is_success());
    let body = page.text().await.expect("providers page body");
    for id in [
        "summary-cards",
        "providers-panel",
        "health-donut",
        "add-provider-btn",
        "wizard-panel",
        "wizard-steps",
        "wizard-summary",
        "wizard-body",
        "wizard-actions",
        "probe-panel",
        "probe-target",
        "probe-host",
        "patrol-panel",
        "patrol-provider",
        "patrol-plan",
        "patrol-status",
        "patrol-history",
        "import-panel",
        "import-text",
        "import-preview-btn",
        "import-run-btn",
        "import-summary",
        "import-results",
    ] {
        assert!(
            body.contains(&format!("id=\"{id}\"")),
            "served providers page must expose #{id}"
        );
    }
    assert!(
        body.contains(r#"<script type="module" src="/app/views/providers.js"></script>"#),
        "providers page wires its view through the module entry"
    );
    for path in [
        "/app/core.js",
        "/app/shell.js",
        "/app/form.js",
        "/app/probe.js",
        "/app/views/providers.js",
    ] {
        let module = http_client()
            .get(format!("{base}{path}"))
            .send()
            .await
            .expect("module response");
        assert!(
            module.status().is_success(),
            "{path} must be served to the providers page"
        );
    }
}

#[tokio::test]
async fn patrol_loop_runs_due_plans_and_records_scheduled_results() {
    let (base, state, home) = bind_test_server().await;
    let token = admin_token(&home);

    let put = http_client()
        .put(format!("{base}/api/providers/p1/patrol"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "enabled": true,
            "interval_secs": 1,
            "stages": ["l1_contract"],
        }))
        .send()
        .await
        .expect("put due plan response");
    assert_eq!(put.status().as_u16(), 200);

    // 后台 tick 的真正入口：到期计划必须被执行，而不是只被持久化。
    state.patrol.run_due(&state).await;

    let history_path = home.join("state").join("provider-patrol.jsonl");
    let history = std::fs::read_to_string(&history_path).expect("scheduled run persisted");
    let lines = history.lines().collect::<Vec<_>>();
    assert_eq!(
        lines.len(),
        1,
        "the due plan must run exactly once per tick"
    );
    let entry: Value = serde_json::from_str(lines[0]).expect("patrol history line is json");
    assert_eq!(
        entry.get("trigger").and_then(Value::as_str),
        Some("scheduled"),
        "the background loop records scheduled runs: {entry}"
    );
    assert_eq!(entry.get("provider_id").and_then(Value::as_str), Some("p1"));
    assert_eq!(
        entry.get("source").and_then(Value::as_str),
        Some("admin_provider_patrol"),
        "advisory patrol must stay labelled as an admin diagnostic"
    );

    // 同一 tick 内不会重复执行：last-run 已推进。
    state.patrol.run_due(&state).await;
    let history = std::fs::read_to_string(&history_path).expect("history readable");
    assert_eq!(
        history.lines().count(),
        1,
        "a plan that just ran is not due again immediately"
    );
}

// ---------------------------------------------------------------------------
// POST /api/providers/:id/health-test — authenticated ad-hoc diagnostic
// ---------------------------------------------------------------------------

#[tokio::test]
async fn health_test_authenticates_with_the_configured_provider_credential() {
    const SECRET: &str = "sk-health-secret-xyz";
    let (upstream, captured) =
        spawn_mock_upstream(200, 1, |_| json!({ "data": [{ "id": "m1" }] }).to_string()).await;
    let (base, _state, home) = bind_test_server().await;
    write_provider(
        &home,
        "p1",
        &provider_toml("p1", &format!("{upstream}/v1"), SECRET, "m1"),
    );
    let response = http_client()
        .post(format!("{base}/api/providers/p1/health-test"))
        .header("x-routecodex-admin-token", admin_token(&home))
        .send()
        .await
        .expect("health-test response");
    assert_eq!(response.status().as_u16(), 200);
    let payload: Value = response.json().await.expect("health-test json");
    assert_eq!(
        payload.get("ok").and_then(Value::as_bool),
        Some(true),
        "an authenticated diagnostic against a healthy upstream succeeds: {payload}"
    );
    assert_eq!(
        payload.get("auth_mode").and_then(Value::as_str),
        Some("provider_auth_handle"),
        "the diagnostic must declare that it used the provider credential: {payload}"
    );
    assert!(
        !payload.to_string().contains(SECRET),
        "the diagnostic must never echo the secret: {payload}"
    );
    let captured = captured.lock().unwrap().clone();
    let request = captured
        .first()
        .expect("the diagnostic must actually reach the upstream");
    assert!(
        request.starts_with("GET /v1/models HTTP/1.1"),
        "health-test uses the same discovery entry as /api/providers/discover: {request}"
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains(&format!("authorization: bearer {SECRET}")),
        "health-test must send the provider's configured credential: {request}"
    );
}

#[tokio::test]
async fn health_test_reports_the_real_upstream_status_for_a_rejected_credential() {
    let (upstream, captured) = spawn_mock_upstream(401, 1, |_| {
        json!({ "error": { "message": "invalid api key" } }).to_string()
    })
    .await;
    let (base, _state, home) = bind_test_server().await;
    write_provider(
        &home,
        "p1",
        &provider_toml(
            "p1",
            &format!("{upstream}/v1"),
            "sk-rejected-credential",
            "m1",
        ),
    );
    let response = http_client()
        .post(format!("{base}/api/providers/p1/health-test"))
        .header("x-routecodex-admin-token", admin_token(&home))
        .send()
        .await
        .expect("health-test response");
    assert_eq!(
        response.status().as_u16(),
        200,
        "the diagnostic endpoint answers; the verdict is inline"
    );
    let payload: Value = response.json().await.expect("health-test json");
    assert_eq!(
        payload.get("ok").and_then(Value::as_bool),
        Some(false),
        "a rejected credential is an honest failure: {payload}"
    );
    assert_eq!(
        payload.get("status").and_then(Value::as_u64),
        Some(401),
        "the real upstream status must be reported: {payload}"
    );
    assert!(
        payload
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|error| error.contains("401")),
        "the failure must name the upstream status: {payload}"
    );
    assert_eq!(
        payload.get("auth_mode").and_then(Value::as_str),
        Some("provider_auth_handle"),
        "the credential was sent, which is what makes the 401 a credential verdict: {payload}"
    );
    let captured = captured.lock().unwrap().clone();
    let request = captured.first().expect("one upstream call");
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-rejected-credential"),
        "the rejected credential must still have been sent: {request}"
    );
}

#[tokio::test]
async fn health_test_reports_a_missing_credential_explicitly() {
    let (base, _state, home) = bind_test_server().await;
    // 未设置的环境变量占位符在编译期非空、运行时解析为空 → “无凭据”。
    // 因此不会发出任何上游调用（base URL 不可达也无所谓）。
    write_provider(
        &home,
        "p1",
        &provider_toml(
            "p1",
            "http://127.0.0.1:9/v1",
            "${RCCV3_SMOKE_MISSING_CREDENTIAL}",
            "m1",
        ),
    );
    let response = http_client()
        .post(format!("{base}/api/providers/p1/health-test"))
        .header("x-routecodex-admin-token", admin_token(&home))
        .send()
        .await
        .expect("health-test response");
    assert_eq!(response.status().as_u16(), 200);
    let payload: Value = response.json().await.expect("health-test json");
    assert_eq!(
        payload.get("ok").and_then(Value::as_bool),
        Some(false),
        "a provider with no credential cannot pass an authenticated diagnostic: {payload}"
    );
    assert_eq!(
        payload.get("auth_mode").and_then(Value::as_str),
        Some("no_credential"),
        "the diagnostic must say the credential was missing: {payload}"
    );
    assert!(
        payload
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|error| error.contains("no credential")),
        "the failure must be an explicit no-credential diagnostic, not a bare 401: {payload}"
    );
    assert!(
        payload.get("status").is_some_and(Value::is_null),
        "no upstream call happened, so there is no upstream status: {payload}"
    );
}
