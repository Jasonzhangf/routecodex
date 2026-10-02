// feature_id: v3.admin_api_integration
// Provider model authoring 黑盒集成测试。
//
// 覆盖：E1 模型 CRUD（add/replace/remove/defaultModel 往返 + 全部错误码 + 被拒候选零写入）、
// E2 发现响应（models 形状不变 + entries 结构化能力，且只有一次上游请求）、
// E3 能力测试（通过 / 不通过 / 不可便宜证明，且绝不写 provider 文件）。
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
        "rcc-admin-models-{}-{}",
        std::process::id(),
        TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).expect("temp home");
    dir
}

fn provider_toml(
    id: &str,
    base_url: &str,
    api_key: &str,
    models: &[&str],
    default_model: &str,
) -> String {
    let mut body = format!(
        r#"
version = "2.0.0"
providerId = "{id}"

[provider]
id = "{id}"
enabled = true
type = "openai_chat"
baseURL = "{base_url}"
defaultModel = "{default_model}"

[provider.auth]
type = "apikey"
apiKey = "{api_key}"
"#
    );
    for model in models {
        body.push_str(&format!(
            "\n[provider.models.\"{model}\"]\nsupportsStreaming = true\n"
        ));
    }
    body
}

fn write_provider(home: &Path, id: &str, body: &str) {
    let dir = home.join("provider").join(id);
    std::fs::create_dir_all(&dir).expect("provider dir");
    std::fs::write(dir.join("config.v2.toml"), body).expect("provider file");
}

fn provider_file(home: &Path, id: &str) -> PathBuf {
    home.join("provider").join(id).join("config.v2.toml")
}

fn write_init_config(home: &Path, provider_base_url: &str) -> PathBuf {
    write_provider(
        home,
        "p1",
        &provider_toml("p1", provider_base_url, "sk-test", &["m1", "m2"], "m1"),
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

async fn bind_test_server(provider_base_url: &str) -> (String, AppState, PathBuf) {
    let home = temp_home();
    let config_path = write_init_config(&home, provider_base_url);
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

/// mock 上游：记录完整请求文本，按请求返回 `(status, body)`。
async fn spawn_upstream<F>(connections: usize, respond: F) -> (String, Arc<Mutex<Vec<String>>>)
where
    F: Fn(&str) -> (u16, String) + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("mock bind");
    let address = listener.local_addr().expect("mock addr");
    let captured = Arc::new(Mutex::new(Vec::new()));
    let captured_server = Arc::clone(&captured);
    let respond = Arc::new(respond);
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
            let (status, body) = respond(&request);
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

async fn post_models(base: &str, token: &str, id: &str, body: Value) -> (u16, Value) {
    let response = http_client()
        .post(format!("{base}/api/providers/{id}/models"))
        .header("x-routecodex-admin-token", token)
        .json(&body)
        .send()
        .await
        .expect("model mutation response");
    let status = response.status().as_u16();
    let payload: Value = response.json().await.expect("model mutation json");
    (status, payload)
}

fn model_names(payload: &Value) -> Vec<String> {
    payload
        .get("models")
        .and_then(Value::as_object)
        .map(|models| models.keys().cloned().collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// E1 - model CRUD
// ---------------------------------------------------------------------------

#[tokio::test]
async fn model_mutation_roundtrip_against_temp_config_dir() {
    let (base, _state, home) = bind_test_server("http://127.0.0.1:9999/v1").await;
    let token = admin_token(&home);

    let (status, payload) = post_models(
        &base,
        &token,
        "p1",
        json!({
            "add": { "m3": { "capabilities": ["text"], "supportsStreaming": true } },
            "reason": "webui test add",
        }),
    )
    .await;
    assert_eq!(status, 200, "add must succeed: {payload}");
    assert_eq!(model_names(&payload), vec!["m1", "m2", "m3"]);
    assert_eq!(
        payload.get("defaultModel").and_then(Value::as_str),
        Some("m1")
    );
    assert!(
        payload
            .get("backup")
            .and_then(Value::as_str)
            .is_some_and(|path| path.contains("provider-update")),
        "existing provider file must be backed up before replacement: {payload}"
    );
    assert!(
        payload
            .get("revision_seq")
            .and_then(Value::as_u64)
            .is_some_and(|seq| seq >= 1),
        "mutation must append a revision: {payload}"
    );
    let written = std::fs::read_to_string(provider_file(&home, "p1")).expect("provider file");
    assert!(
        written.contains("[provider.models.m3]"),
        "added model must land in the provider file: {written}"
    );

    let (status, payload) = post_models(&base, &token, "p1", json!({ "remove": ["m3"] })).await;
    assert_eq!(status, 200, "remove must succeed: {payload}");
    assert_eq!(model_names(&payload), vec!["m1", "m2"]);

    let (status, payload) = post_models(
        &base,
        &token,
        "p1",
        json!({ "add": { "m4": {} }, "defaultModel": "m4" }),
    )
    .await;
    assert_eq!(status, 200, "default change must succeed: {payload}");
    assert_eq!(
        payload.get("defaultModel").and_then(Value::as_str),
        Some("m4"),
        "response carries the resulting defaultModel: {payload}"
    );

    // 编辑形态 1：同一次请求里先删后加同名条目。
    let (status, payload) = post_models(
        &base,
        &token,
        "p1",
        json!({
            "remove": ["m1"],
            "add": { "m1": { "capabilities": ["text", "tools"] } },
        }),
    )
    .await;
    assert_eq!(status, 200, "remove+add of one name is an edit: {payload}");
    assert_eq!(
        payload["models"]["m1"]["capabilities"],
        json!(["text", "tools"]),
        "edit must persist the new capabilities: {payload}"
    );
    let written = std::fs::read_to_string(provider_file(&home, "p1")).expect("provider file");
    assert!(
        written.contains("\"tools\""),
        "edit must reach the provider file: {written}"
    );

    // 编辑形态 2：add + 顶层 replace 授权覆盖。
    let (status, payload) = post_models(
        &base,
        &token,
        "p1",
        json!({
            "add": { "m1": { "capabilities": ["text"] } },
            "replace": ["m1"],
        }),
    )
    .await;
    assert_eq!(status, 200, "replace authorizes overwrite: {payload}");
    assert_eq!(
        payload["models"]["m1"]["capabilities"],
        json!(["text"]),
        "replace must overwrite the authored entry: {payload}"
    );
}

#[tokio::test]
async fn model_mutation_error_codes_and_rejected_candidate_writes_nothing() {
    let (base, _state, home) = bind_test_server("http://127.0.0.1:9999/v1").await;
    let token = admin_token(&home);
    let path = provider_file(&home, "p1");
    let before = std::fs::read(&path).expect("provider file bytes");

    let (status, payload) = post_models(&base, &token, "p1", json!({ "reason": "noop" })).await;
    assert_eq!(status, 400, "no mutation: {payload}");
    assert_eq!(
        payload.get("error_code").and_then(Value::as_str),
        Some("no_model_mutation")
    );

    let (status, payload) = post_models(&base, &token, "p1", json!({ "add": { "m1": {} } })).await;
    assert_eq!(status, 409, "existing name without replace: {payload}");
    assert_eq!(
        payload.get("error_code").and_then(Value::as_str),
        Some("model_exists")
    );

    let (status, payload) = post_models(&base, &token, "p1", json!({ "remove": ["nope"] })).await;
    assert_eq!(status, 404, "unknown removal: {payload}");
    assert_eq!(
        payload.get("error_code").and_then(Value::as_str),
        Some("model_not_found")
    );

    let (status, payload) = post_models(&base, &token, "p1", json!({ "remove": ["m1"] })).await;
    assert_eq!(status, 409, "removing the default model: {payload}");
    assert_eq!(
        payload.get("error_code").and_then(Value::as_str),
        Some("default_model_in_use")
    );

    let (status, payload) = post_models(
        &base,
        &token,
        "p1",
        json!({ "remove": ["m1", "m2"], "defaultModel": "m3" }),
    )
    .await;
    assert_eq!(status, 409, "empty model map with a default: {payload}");
    assert_eq!(
        payload.get("error_code").and_then(Value::as_str),
        Some("default_model_requires_model")
    );

    // 被真实编译链拒绝的候选：defaultModel 指向不存在的 model。
    let (status, payload) = post_models(
        &base,
        &token,
        "p1",
        json!({ "add": { "m5": {} }, "defaultModel": "not-a-model" }),
    )
    .await;
    assert_eq!(status, 422, "invalid candidate: {payload}");
    assert_eq!(
        payload.get("error_code").and_then(Value::as_str),
        Some("candidate_invalid")
    );

    let after = std::fs::read(&path).expect("provider file bytes");
    assert_eq!(
        before, after,
        "every rejected request must leave the provider file byte-identical"
    );
}

#[tokio::test]
async fn model_mutation_reports_unknown_provider() {
    let (base, _state, home) = bind_test_server("http://127.0.0.1:9999/v1").await;
    let token = admin_token(&home);
    let (status, payload) = post_models(&base, &token, "nope", json!({ "remove": ["m1"] })).await;
    assert_eq!(status, 404, "unknown provider: {payload}");
    assert_eq!(
        payload.get("error_code").and_then(Value::as_str),
        Some("provider_not_found")
    );
}

// ---------------------------------------------------------------------------
// E2 - structured discovery
// ---------------------------------------------------------------------------

#[tokio::test]
async fn discover_keeps_models_shape_and_adds_structured_entries() {
    let (upstream, captured) = spawn_upstream(1, |_| {
        (
            200,
            json!({
                "data": [
                    {
                        "id": "m-detected",
                        "supported_parameters": ["tools", "reasoning_effort", "temperature"],
                        "context_length": 128000,
                        "max_output_tokens": 8192,
                    },
                    { "id": "m-plain" },
                    {
                        "id": "m-image",
                        "architecture": { "input_modalities": ["text", "image"] },
                    },
                ],
            })
            .to_string(),
        )
    })
    .await;
    let (base, _state, home) = bind_test_server("http://127.0.0.1:9999/v1").await;
    let token = admin_token(&home);
    let response = http_client()
        .post(format!("{base}/api/providers/discover"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({ "id": "p1", "config": {
            "version": "2.0.0",
            "providerId": "p1",
            "provider": {
                "id": "p1",
                "enabled": true,
                "type": "openai_chat",
                "baseURL": format!("{upstream}/v1"),
                "defaultModel": "m1",
                "auth": { "apiKey": "sk-discover" },
                "models": { "m1": { "supportsStreaming": true } }
            }
        }}))
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
        Some(vec!["m-detected", "m-plain", "m-image"]),
        "compatibility view stays an array of names: {payload}"
    );
    let entries = payload
        .get("entries")
        .and_then(Value::as_array)
        .expect("entries array");
    assert_eq!(
        entries.len(),
        3,
        "one entry per discovered model: {payload}"
    );

    let detected = &entries[0];
    assert_eq!(
        detected.get("name").and_then(Value::as_str),
        Some("m-detected")
    );
    assert_eq!(
        detected.get("source").and_then(Value::as_str),
        Some("detected")
    );
    assert_eq!(
        detected.get("maxTokens").and_then(Value::as_u64),
        Some(8192)
    );
    assert_eq!(
        detected.get("maxContextTokens").and_then(Value::as_u64),
        Some(128000)
    );
    let capabilities = detected
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    assert!(capabilities.contains(&"tools"), "{detected}");
    assert!(capabilities.contains(&"reasoning"), "{detected}");
    assert!(
        !capabilities
            .iter()
            .any(|capability| *capability == "temperature"),
        "sampling parameters are not capabilities: {detected}"
    );

    let plain = &entries[1];
    assert_eq!(plain.get("source").and_then(Value::as_str), Some("default"));
    assert_eq!(
        plain
            .get("capabilities")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(0),
        "a provider that returns only ids yields no guessed capability: {plain}"
    );
    assert!(
        plain.get("maxTokens").is_none() && plain.get("maxContextTokens").is_none(),
        "unclaimed limits stay absent instead of being invented: {plain}"
    );

    let image = &entries[2];
    let image_capabilities = image
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    assert!(image_capabilities.contains(&"vision"), "{image}");
    assert!(image_capabilities.contains(&"multimodal"), "{image}");

    let captured = captured.lock().unwrap().clone();
    assert_eq!(
        captured.len(),
        1,
        "structured entries must come from the same single discovery request"
    );
    assert!(
        captured[0].starts_with("GET /v1/models HTTP/1.1"),
        "{}",
        captured[0]
    );
}

// ---------------------------------------------------------------------------
// E3 - capability test
// ---------------------------------------------------------------------------

#[tokio::test]
async fn capability_test_reports_pass_fail_and_not_testable_without_writing_config() {
    let (upstream, captured) = spawn_upstream(3, |request| {
        if request.contains("probe_ping") {
            return (
                200,
                json!({
                    "choices": [{
                        "message": {
                            "role": "assistant",
                            "content": null,
                            "tool_calls": [{
                                "id": "call_1",
                                "type": "function",
                                "function": { "name": "probe_ping", "arguments": "{}" },
                            }],
                        },
                        "finish_reason": "tool_calls",
                    }],
                })
                .to_string(),
            );
        }
        (
            200,
            json!({
                "choices": [{
                    "message": { "role": "assistant", "content": "ok" },
                    "finish_reason": "stop",
                }],
            })
            .to_string(),
        )
    })
    .await;
    let (base, _state, home) = bind_test_server(&upstream).await;
    let token = admin_token(&home);
    let path = provider_file(&home, "p1");
    let before = std::fs::read(&path).expect("provider file bytes");

    let response = http_client()
        .post(format!("{base}/api/providers/p1/models/capability-test"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "model": "m1",
            "capabilities": ["text", "tools", "thinking", "longcontext"],
            "reason": "webui manual tick",
        }))
        .send()
        .await
        .expect("capability test response");
    assert_eq!(response.status().as_u16(), 200);
    let payload: Value = response.json().await.expect("capability test json");
    assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
    let results = payload
        .get("results")
        .and_then(Value::as_array)
        .expect("results array");
    assert_eq!(results.len(), 4, "{payload}");

    let by_capability = |name: &str| {
        results
            .iter()
            .find(|result| result.get("capability").and_then(Value::as_str) == Some(name))
            .unwrap_or_else(|| panic!("missing result for {name}: {payload}"))
            .clone()
    };
    let text = by_capability("text");
    assert_eq!(text.get("tested").and_then(Value::as_bool), Some(true));
    assert_eq!(
        text.get("passed").and_then(Value::as_bool),
        Some(true),
        "{text}"
    );
    assert!(
        text.get("evidence")
            .and_then(|evidence| evidence.get("status"))
            .and_then(Value::as_u64)
            .is_some(),
        "evidence carries the real provider status: {text}"
    );

    let tools = by_capability("tools");
    assert_eq!(tools.get("tested").and_then(Value::as_bool), Some(true));
    assert_eq!(
        tools.get("passed").and_then(Value::as_bool),
        Some(true),
        "{tools}"
    );

    let thinking = by_capability("thinking");
    assert_eq!(thinking.get("tested").and_then(Value::as_bool), Some(true));
    assert_eq!(
        thinking.get("passed").and_then(Value::as_bool),
        Some(false),
        "a request without reasoning output is a failing capability: {thinking}"
    );

    let longcontext = by_capability("longcontext");
    assert_eq!(
        longcontext.get("tested").and_then(Value::as_bool),
        Some(false),
        "longcontext is not cheaply provable: {longcontext}"
    );
    assert_eq!(
        longcontext.get("passed").and_then(Value::as_bool),
        Some(false)
    );
    assert!(
        longcontext
            .get("detail")
            .and_then(Value::as_str)
            .is_some_and(|detail| !detail.is_empty()),
        "an untested capability carries its reason: {longcontext}"
    );

    let captured = captured.lock().unwrap().clone();
    assert_eq!(
        captured.len(),
        3,
        "exactly the three testable capabilities send a provider request: {captured:?}"
    );
    assert!(
        captured
            .iter()
            .any(|request| request.contains("probe_ping")),
        "the tools test sends a real tool definition: {captured:?}"
    );

    let after = std::fs::read(&path).expect("provider file bytes");
    assert_eq!(
        before, after,
        "the capability test is read-only with respect to config"
    );
}

#[tokio::test]
async fn capability_test_reports_a_missing_tool_call_as_failure() {
    let (upstream, captured) = spawn_upstream(1, |_| {
        (
            200,
            json!({
                "choices": [{
                    "message": { "role": "assistant", "content": "no tool for you" },
                    "finish_reason": "stop",
                }],
            })
            .to_string(),
        )
    })
    .await;
    let (base, _state, home) = bind_test_server(&upstream).await;
    let token = admin_token(&home);
    let response = http_client()
        .post(format!("{base}/api/providers/p1/models/capability-test"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({ "model": "m1", "capabilities": ["tools"] }))
        .send()
        .await
        .expect("capability test response");
    assert_eq!(response.status().as_u16(), 200);
    let payload: Value = response.json().await.expect("capability test json");
    let result = &payload["results"][0];
    assert_eq!(result.get("tested").and_then(Value::as_bool), Some(true));
    assert_eq!(
        result.get("passed").and_then(Value::as_bool),
        Some(false),
        "a completion without a tool call is not a tool capability: {payload}"
    );
    assert_eq!(captured.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn capability_test_reports_upstream_rejection_explicitly() {
    let (upstream, _captured) =
        spawn_upstream(1, |_| (401, json!({ "error": "bad key" }).to_string())).await;
    let (base, _state, home) = bind_test_server(&upstream).await;
    let token = admin_token(&home);
    let response = http_client()
        .post(format!("{base}/api/providers/p1/models/capability-test"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({ "model": "m1", "capabilities": ["text"] }))
        .send()
        .await
        .expect("capability test response");
    assert_eq!(response.status().as_u16(), 200);
    let payload: Value = response.json().await.expect("capability test json");
    let result = &payload["results"][0];
    assert_eq!(result.get("tested").and_then(Value::as_bool), Some(true));
    assert_eq!(result.get("passed").and_then(Value::as_bool), Some(false));
    assert_eq!(
        result
            .get("evidence")
            .and_then(|evidence| evidence.get("status"))
            .and_then(Value::as_u64),
        Some(401),
        "the real upstream status is reported, not hidden: {payload}"
    );
    let _ = upstream;
}

#[tokio::test]
async fn capability_test_requires_a_configured_model() {
    let (base, _state, home) = bind_test_server("http://127.0.0.1:9999/v1").await;
    let token = admin_token(&home);
    let response = http_client()
        .post(format!("{base}/api/providers/p1/models/capability-test"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({ "model": "not-configured", "capabilities": ["text"] }))
        .send()
        .await
        .expect("capability test response");
    assert_eq!(response.status().as_u16(), 422);
    let payload: Value = response.json().await.expect("capability test json");
    assert_eq!(
        payload.get("error_code").and_then(Value::as_str),
        Some("probe_target_unavailable"),
        "{payload}"
    );
}

#[tokio::test]
async fn model_routes_require_the_admin_token() {
    let (base, _state, _home) = bind_test_server("http://127.0.0.1:9999/v1").await;
    let response = http_client()
        .post(format!("{base}/api/providers/p1/models"))
        .json(&json!({ "remove": ["m1"] }))
        .send()
        .await
        .expect("unauthenticated response");
    assert_eq!(response.status().as_u16(), 401);
}
