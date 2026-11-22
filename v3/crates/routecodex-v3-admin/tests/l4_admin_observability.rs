// feature_id: v3.admin_observability_detail
// Admin observability detail / artifact / live-stream black-box integration
// test. Exercises the real axum router over HTTP against a hand-written JSONL
// observability store and a constructed debug sample directory.
use futures_util::StreamExt;
use routecodex_v3_admin::{router, AppState};
use routecodex_v3_config_mgmt::ConfigMgmtStore;
use serde_json::{json, Value};
#[cfg(unix)]
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static TEST_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static SAMPLES_HOME: OnceLock<PathBuf> = OnceLock::new();

/// The artifact endpoints resolve `~/.rcc/codex-samples` from the process `HOME`,
/// so this test binary pins `HOME` to one temp directory. Every test uses its own
/// request id, so the shared samples root stays isolated per test.
fn samples_home() -> &'static PathBuf {
    SAMPLES_HOME.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!(
            "rcc-admin-observability-home-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("samples home");
        std::env::set_var("HOME", &dir);
        dir
    })
}

fn temp_config_home() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rcc-admin-observability-{}-{}",
        std::process::id(),
        TEST_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).expect("temp config home");
    dir
}

fn write_init_config(home: &Path) -> PathBuf {
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

async fn bind_test_server() -> (String, AppState, PathBuf) {
    let home = temp_config_home();
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

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| panic!("http client"))
}

fn write_observability_rows(home: &Path, rows: &[Value]) {
    write_observability_rows_for_port(home, 4444, rows);
}

fn write_observability_rows_for_port(home: &Path, port: u16, rows: &[Value]) {
    let store_path = home
        .join("logs")
        .join(format!("server-v3-{port}.request-records.jsonl"));
    std::fs::create_dir_all(store_path.parent().expect("logs dir")).expect("logs dir");
    let content = rows
        .iter()
        .map(|row| json!({ "schema_version": 1, "row": row }).to_string())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(store_path, format!("{content}\n")).expect("observability store");
}

fn write_provider_usage_facts(home: &Path, port: u16, facts: &[Value], coverage: &[Value]) {
    let store_path = home
        .join("logs")
        .join(format!("server-v3-{port}.request-records.jsonl"));
    let facts_path = routecodex_v3_debug::v3_provider_usage_facts_path(&store_path);
    let coverage_path = routecodex_v3_debug::v3_provider_usage_coverage_path(&store_path);
    let fact_lines = facts
        .iter()
        .map(|fact| json!({ "schema_version": 1, "fact": fact }).to_string())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&facts_path, format!("{fact_lines}\n")).expect("provider usage facts");
    std::fs::write(
        &coverage_path,
        serde_json::to_vec(coverage).expect("coverage json"),
    )
    .expect("provider usage coverage");
}

fn provider_usage_success_row(
    request_key: &str,
    port: u16,
    started_epoch_ms: u64,
    provider_id: &str,
    usage: Value,
) -> Value {
    json!({
        "request_key": request_key,
        "event_type": "request.completed",
        "started_epoch_ms": started_epoch_ms,
        "updated_epoch_ms": started_epoch_ms + 100,
        "finished_epoch_ms": started_epoch_ms + 100,
        "duration_ms": 100,
        "meta": {
            "request_id": format!("{provider_id}-request"),
            "endpoint": "/v1/responses",
            "entry_protocol": "responses",
            "provider": provider_id,
            "provider_id": provider_id,
            "model": "m1"
        },
        "scope": {"port": port},
        "result": "success",
        "attempts": 1,
        "failed_attempts": 0,
        "switches": 0,
        "usage": usage
    })
}

fn provider_usage_failed_attempt_row(
    request_key: &str,
    port: u16,
    started_epoch_ms: u64,
    provider_id: &str,
) -> Value {
    json!({
        "request_key": request_key,
        "event_type": "request.provider_attempt_failed",
        "started_epoch_ms": started_epoch_ms,
        "updated_epoch_ms": started_epoch_ms + 10,
        "finished_epoch_ms": null,
        "duration_ms": null,
        "meta": {
            "request_id": format!("{provider_id}-request"),
            "endpoint": "/v1/responses",
            "entry_protocol": "responses",
            "provider": provider_id,
            "provider_id": provider_id,
            "model": "m1",
            "provider_status": 500,
            "error_category": "provider_http_500",
            "error_detail": "provider attempt failed",
            "attempt_index": started_epoch_ms / 100
        },
        "scope": {"port": port},
        "result": null,
        "attempts": 0,
        "failed_attempts": 1,
        "switches": 0,
        "usage": null
    })
}

/// A failing provider attempt carrying the full observed typed error truth:
/// error class, the six chain nodes, internal code, external error code/status,
/// upstream request id, health action, failure count, cooldown and the next
/// provider key.
fn provider_attempt_failure_row(request_id: &str) -> Value {
    json!({
        "request_key": format!("4444:{request_id}"),
        "event_type": "request.provider_attempt_failed",
        "started_epoch_ms": 1,
        "updated_epoch_ms": 2,
        "finished_epoch_ms": null,
        "duration_ms": null,
        "meta": {
            "request_id": request_id,
            "endpoint": "/v1/responses",
            "entry_protocol": "responses",
            "provider_status": 502,
            "error_category": "provider_http_502",
            "error_detail": "provider returned HTTP 502",
            "provider": "p1",
            "provider_id": "p1",
            "model": "m1",
            "observed_error": {
                "source": "provider_attempt_failure",
                "error_class": "provider_transport_failure",
                "chain": [
                    {"node": "V3Error01SourceRaised", "state": "raised", "code": "provider_transport_failure"},
                    {"node": "V3Error02Classified", "state": "classified", "code": "provider_transport_failure"},
                    {"node": "V3Error03TargetLocalAction", "state": "action_planned", "code": null},
                    {"node": "V3Error04TargetExhaustionDecision", "state": "exhaustion_decided", "code": null},
                    {"node": "V3Error05ExecutionDecision", "state": "execution_decided", "code": null},
                    {"node": "V3Error06ClientProjected", "state": "projected", "code": "502"}
                ],
                "internal_code": "V3_INTERNAL_UPSTREAM_TRANSPORT",
                "external_error_kind": "transport",
                "external_error_code": "UPSTREAM_TRANSPORT_ERROR",
                "external_error_status": 502,
                "upstream_request_id": "upstream-req-77",
                "health_action": {
                    "scope": "provider_key",
                    "scope_target": "p1[key].m1",
                    "reason": "provider_transport_failure",
                    "duration_ms": 5000,
                    "retry_eligible": true,
                    "health_affecting": true,
                    "exhaustion_effect": "cooldown"
                },
                "health_state": "cooldown",
                "action": "switch_provider",
                "failure_count": 3,
                "cooldown_until_ms": 903000,
                "next_provider_key": "p2[key].m1",
                "wait_ms": 250,
                "attempt_index": 1
            }
        },
        "scope": {"port": 4444},
        "result": null,
        "attempts": 1,
        "failed_attempts": 1,
        "switches": 0,
        "usage": null,
        "raw_artifact_ref": null
    })
}

/// `<HOME>/.rcc/codex-samples/openai-responses/ports/4444/<request id>`.
fn sample_request_dir(request_id: &str) -> PathBuf {
    samples_home()
        .join(".rcc")
        .join("codex-samples")
        .join("openai-responses")
        .join("ports")
        .join("4444")
        .join(request_id)
}

async fn get_json(url: &str) -> (reqwest::StatusCode, Value) {
    let response = http_client().get(url).send().await.expect("http response");
    let status = response.status();
    let body = response.json::<Value>().await.expect("json body");
    (status, body)
}

/// Tolerant SSE frame parser: axum writes `event:`/`data:` lines separated by a
/// blank line, with an optional space after the colon.
fn parse_sse_frames(buffer: &str) -> Vec<(String, String)> {
    buffer
        .split("\n\n")
        .filter_map(|frame| {
            let mut event = None;
            let mut data = None;
            for line in frame.lines() {
                if let Some(rest) = line.strip_prefix("event:") {
                    event = Some(rest.trim().to_string());
                } else if let Some(rest) = line.strip_prefix("data:") {
                    data = Some(rest.trim().to_string());
                }
            }
            Some((event?, data?))
        })
        .collect()
}

#[tokio::test]
async fn observability_detail_returns_row_attempts_chain_health_action_and_cooldown() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(&home, &[provider_attempt_failure_row("req-detail")]);

    let (status, body) =
        get_json(&format!("{base}/api/observability/records/4444:req-detail")).await;
    assert_eq!(status, reqwest::StatusCode::OK, "detail body: {body}");

    let row = &body["row"];
    assert_eq!(row["request_key"], "4444:req-detail");
    assert_eq!(row["result"], "failed-attempt");
    let observed = &row["meta"]["observed_error"];
    assert_eq!(observed["source"], "provider_attempt_failure");
    assert_eq!(observed["error_class"], "provider_transport_failure");
    assert_eq!(observed["internal_code"], "V3_INTERNAL_UPSTREAM_TRANSPORT");
    assert_eq!(observed["external_error_kind"], "transport");
    assert_eq!(observed["external_error_code"], "UPSTREAM_TRANSPORT_ERROR");
    assert_eq!(observed["external_error_status"], 502);
    assert_eq!(observed["upstream_request_id"], "upstream-req-77");
    assert_eq!(observed["health_state"], "cooldown");
    assert_eq!(observed["action"], "switch_provider");
    assert_eq!(observed["failure_count"], 3);
    assert_eq!(observed["cooldown_until_ms"], 903000);
    assert_eq!(observed["next_provider_key"], "p2[key].m1");
    assert_eq!(observed["wait_ms"], 250);
    assert_eq!(observed["attempt_index"], 1);

    let attempts = body["attempts"].as_array().expect("attempts array");
    assert_eq!(attempts.len(), 1, "one failing provider attempt");
    assert_eq!(attempts[0]["result"], "failed-attempt");
    assert_eq!(attempts[0]["meta"]["provider_status"], 502);
    assert_eq!(
        attempts[0]["meta"]["observed_error"]["error_class"],
        "provider_transport_failure"
    );
    assert_eq!(
        attempts[0]["meta"]["observed_error"]["cooldown_until_ms"],
        903000
    );

    // The chain always carries all six nodes in canonical order, with the stored
    // per-node state and code preserved.
    let chain = body["error_chain"].as_array().expect("error chain array");
    assert_eq!(chain.len(), 6, "all six typed Error nodes must be present");
    let nodes = chain
        .iter()
        .map(|node| node["node"].as_str().unwrap_or_default().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        nodes,
        vec![
            "V3Error01SourceRaised",
            "V3Error02Classified",
            "V3Error03TargetLocalAction",
            "V3Error04TargetExhaustionDecision",
            "V3Error05ExecutionDecision",
            "V3Error06ClientProjected",
        ]
    );
    assert_eq!(chain[0]["state"], "raised");
    assert_eq!(chain[0]["code"], "provider_transport_failure");
    assert_eq!(chain[1]["state"], "observed");
    assert_eq!(chain[1]["code"], "provider_transport_failure");
    assert_eq!(chain[2]["code"], Value::Null);
    assert_eq!(chain[5]["state"], "observed");
    assert_eq!(chain[5]["code"], "502");

    let action = &body["health_action"];
    assert_eq!(action["scope"], "provider_key");
    assert_eq!(action["scope_target"], "p1[key].m1");
    assert_eq!(action["reason"], "provider_transport_failure");
    assert_eq!(action["duration_ms"], 5000);
    assert_eq!(action["retry_eligible"], true);
    assert_eq!(action["health_affecting"], true);
    assert_eq!(action["exhaustion_effect"], "cooldown");

    assert_eq!(body["observed_error_source"], "provider_attempt_failure");
    // No sample directory was captured for this request: an empty list, not a
    // fabricated artifact.
    assert!(body["artifacts"]
        .as_array()
        .expect("artifacts array")
        .is_empty());
}

#[tokio::test]
async fn observability_detail_reports_unobserved_nodes_as_not_reached() {
    let (base, _state, home) = bind_test_server().await;
    let mut row = provider_attempt_failure_row("req-no-chain");
    row["meta"]["observed_error"] = json!({
        "source": "provider_attempt_failure",
        "external_error_code": "UPSTREAM_TRANSPORT_ERROR",
        "failure_count": 1
    });
    write_observability_rows(&home, &[row]);

    let (status, body) = get_json(&format!(
        "{base}/api/observability/records/4444:req-no-chain"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "detail body: {body}");

    let chain = body["error_chain"].as_array().expect("error chain array");
    assert_eq!(chain.len(), 6, "unobserved nodes are still reported");
    for node in chain {
        assert_eq!(node["state"], "not_reached");
        assert_eq!(node["code"], Value::Null);
    }
    assert_eq!(body["health_action"], Value::Null);
    assert_eq!(body["observed_error_source"], "provider_attempt_failure");
}

#[tokio::test]
async fn observability_detail_returns_request_not_found_for_an_unknown_key() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(&home, &[provider_attempt_failure_row("req-known")]);

    let (status, body) = get_json(&format!(
        "{base}/api/observability/records/4444:req-unknown"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "request_not_found");
}

#[tokio::test]
async fn observability_artifacts_list_real_files_and_report_absence_honestly() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(&home, &[provider_attempt_failure_row("req-artifacts")]);

    // Absent directory: `dir_exists:false` and an empty list, never a fabricated
    // path or a silent empty success.
    let (status, body) = get_json(&format!(
        "{base}/api/observability/artifacts?port=4444&request_id=req-artifacts"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "artifacts body: {body}");
    assert_eq!(body["dir_exists"], false);
    assert_eq!(body["port"], 4444);
    assert_eq!(body["request_id"], "req-artifacts");
    assert!(body["files"].as_array().expect("files array").is_empty());

    let dir = sample_request_dir("req-artifacts");
    std::fs::create_dir_all(&dir).expect("sample dir");
    std::fs::write(dir.join("request.json"), br#"{"hello":"world"}"#).expect("request.json");
    std::fs::write(dir.join("provider-response.json"), b"provider-body")
        .expect("provider-response.json");
    // Not on the allowlist: it must never be reported.
    std::fs::write(dir.join("notes.txt"), b"private").expect("notes.txt");

    let (status, body) = get_json(&format!(
        "{base}/api/observability/artifacts?port=4444&request_id=req-artifacts"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "artifacts body: {body}");
    assert_eq!(body["dir_exists"], true);
    let files = body["files"].as_array().expect("files array");
    assert_eq!(files.len(), 2, "only allowlisted artifacts: {files:?}");
    let mut names = files
        .iter()
        .map(|file| file["file"].as_str().unwrap_or_default().to_string())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, vec!["provider-response.json", "request.json"]);
    let request_file = files
        .iter()
        .find(|file| file["file"] == "request.json")
        .expect("request.json listed");
    assert_eq!(request_file["size_bytes"], 17);
    let provider_file = files
        .iter()
        .find(|file| file["file"] == "provider-response.json")
        .expect("provider-response.json listed");
    assert_eq!(provider_file["size_bytes"], 13);

    // The detail endpoint reports the same artifacts for the same request.
    let (status, detail) = get_json(&format!(
        "{base}/api/observability/records/4444:req-artifacts"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "detail body: {detail}");
    assert_eq!(
        detail["artifacts"]
            .as_array()
            .expect("detail artifacts")
            .len(),
        2
    );

    // One artifact, exactly the requested one.
    let response = http_client()
        .get(format!("{base}/api/observability/artifacts/content"))
        .query(&[
            ("port", "4444"),
            ("request_id", "req-artifacts"),
            ("file", "request.json"),
        ])
        .send()
        .await
        .expect("artifact content response");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/json")
    );
    assert_eq!(
        response.text().await.expect("artifact text"),
        r#"{"hello":"world"}"#
    );

    // Missing parameters are client errors.
    let (status, body) = get_json(&format!(
        "{base}/api/observability/artifacts?request_id=req-artifacts"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::BAD_REQUEST);
    assert!(body["error"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn observability_artifact_content_rejects_unknown_names_and_traversal() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(&home, &[provider_attempt_failure_row("req-guard")]);

    let dir = sample_request_dir("req-guard");
    std::fs::create_dir_all(&dir).expect("sample dir");
    std::fs::write(dir.join("request.json"), b"{}").expect("request.json");
    // A sibling secret that a path traversal would reach if the guard were missing.
    let secret = samples_home().join("secret.txt");
    std::fs::write(&secret, b"top-secret").expect("secret file");

    for file in [
        "../../secret.txt",
        "..%2F..%2Fsecret.txt",
        "../request.json",
        "secrets.json",
        "request.json.bak",
        "provider-request.json/../../secret.txt",
        "",
        " ",
    ] {
        let response = http_client()
            .get(format!("{base}/api/observability/artifacts/content"))
            .query(&[
                ("port", "4444"),
                ("request_id", "req-guard"),
                ("file", file),
            ])
            .send()
            .await
            .expect("artifact content response");
        assert_eq!(
            response.status(),
            reqwest::StatusCode::BAD_REQUEST,
            "file={file:?} must be rejected before any path is built"
        );
        let body = response.json::<Value>().await.expect("json body");
        assert_eq!(body["error"], "file_not_allowed", "file={file:?}");
    }

    // Allowlisted but not present on disk.
    let (status, body) = get_json(&format!(
        "{base}/api/observability/artifacts/content?port=4444&request_id=req-guard&file=error.json"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "artifact_not_found");

    // Allowlisted file, but no sample directory for this request.
    let (status, body) = get_json(&format!(
        "{base}/api/observability/artifacts/content?port=4444&request_id=req-none&file=request.json"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "artifact_not_found");

    // The secret must still be unreadable through every rejected spelling.
    assert_eq!(
        std::fs::read(&secret).expect("secret intact"),
        b"top-secret".to_vec()
    );

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_file(&secret);
}

#[tokio::test]
async fn observability_artifact_content_reports_oversized_artifacts() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(&home, &[provider_attempt_failure_row("req-large")]);

    let dir = sample_request_dir("req-large");
    std::fs::create_dir_all(&dir).expect("sample dir");
    // Sparse file: 33 MiB of length without 33 MiB of disk.
    let oversized = std::fs::File::create(dir.join("response.json")).expect("oversized artifact");
    oversized
        .set_len(33 * 1024 * 1024)
        .expect("set artifact length");
    drop(oversized);

    let (status, body) = get_json(&format!(
        "{base}/api/observability/artifacts/content?port=4444&request_id=req-large&file=response.json"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["error"], "artifact_too_large");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn observability_stream_replays_rows_after_a_cursor_and_resumes_past_it() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(&home, &[provider_attempt_failure_row("req-stream")]);

    let response = http_client()
        .get(format!("{base}/api/observability/stream"))
        .query(&[("cursor", "0")])
        .send()
        .await
        .expect("stream response");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("text/event-stream")
    );

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if parse_sse_frames(&buffer)
            .iter()
            .any(|(event, _)| event == "row")
        {
            break;
        }
        let chunk = tokio::time::timeout_at(deadline, stream.next())
            .await
            .expect("the stream must emit a row event before the deadline")
            .expect("stream chunk")
            .expect("stream bytes");
        buffer.push_str(&String::from_utf8_lossy(&chunk));
    }
    drop(stream);

    let frames = parse_sse_frames(&buffer);
    assert!(
        frames.iter().any(|(event, _)| event == "heartbeat"),
        "the stream opens with a heartbeat carrying the cursor: {frames:?}"
    );
    let row_payload = frames
        .iter()
        .find(|(event, _)| event == "row")
        .map(|(_, data)| serde_json::from_str::<Value>(data).expect("row payload json"))
        .expect("row event");
    assert_eq!(row_payload["seq"], 2);
    assert_eq!(row_payload["row"]["request_key"], "4444:req-stream");
    assert_eq!(
        row_payload["row"]["meta"]["observed_error"]["error_class"],
        "provider_transport_failure"
    );

    // Resuming after the delivered seq must not replay it.
    let response = http_client()
        .get(format!("{base}/api/observability/stream"))
        .query(&[("cursor", "2")])
        .send()
        .await
        .expect("resume stream response");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    // Two heartbeats: the opening one plus a further idle tick, which proves an
    // idle store still signals liveness instead of going silent.
    while parse_sse_frames(&buffer).len() < 2 {
        let chunk = tokio::time::timeout_at(deadline, stream.next())
            .await
            .expect("an idle stream must keep emitting heartbeats")
            .expect("stream chunk")
            .expect("stream bytes");
        buffer.push_str(&String::from_utf8_lossy(&chunk));
    }
    drop(stream);
    let frames = parse_sse_frames(&buffer);
    assert!(
        frames.iter().all(|(event, _)| event == "heartbeat"),
        "resuming after seq 2 must not replay the row: {frames:?}"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&frames[0].1).expect("heartbeat json")["seq"],
        2
    );

    // A malformed cursor is a client error, not a silent reset to zero.
    let (status, body) = get_json(&format!("{base}/api/observability/stream?cursor=abc")).await;
    assert_eq!(status, reqwest::StatusCode::BAD_REQUEST);
    assert!(body["error"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
}

#[tokio::test]
async fn observability_records_expose_the_entry_protocol_facet() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(&home, &[provider_attempt_failure_row("req-facet")]);

    let (status, body) = get_json(&format!("{base}/api/observability/records")).await;
    assert_eq!(status, reqwest::StatusCode::OK, "records body: {body}");
    assert_eq!(
        body["facets"]["entry_protocols"]["responses"], 1,
        "the Protocol filter must be populated from the field it filters on"
    );
    // The pre-existing facets keep their meaning: a 502 provider attempt still
    // groups under its real external status code.
    assert_eq!(body["facets"]["error_status_codes"]["502"], 1);
}

fn network_facet_fixture_rows() -> Vec<Value> {
    let terminal_network = json!({
        "request_key": "4444:terminal-network",
        "event_type": "request.failed",
        "started_epoch_ms": 1,
        "updated_epoch_ms": 100,
        "finished_epoch_ms": 100,
        "duration_ms": 1,
        "meta": {
            "request_id": "terminal-network",
            "endpoint": "/v1/responses",
            "entry_protocol": "responses",
            "provider_status": null,
            "error_category": "provider_transport_error",
            "error_detail": "provider transport failed before a response"
        },
        "scope": {"port": 4444},
        "result": "error",
        "attempts": 1,
        "failed_attempts": 1,
        "switches": 0,
        "usage": null
    });

    let attempt_network = json!({
        "request_key": "4444:attempt-network",
        "event_type": "request.provider_attempt_failed",
        "started_epoch_ms": 2,
        "updated_epoch_ms": 80,
        "finished_epoch_ms": null,
        "duration_ms": null,
        "meta": {
            "request_id": "attempt-network",
            "endpoint": "/v1/responses",
            "entry_protocol": "responses",
            "provider_status": null,
            "error_category": "provider_transport_error",
            "error_detail": "provider attempt transport failed",
            "provider": "p1",
            "model": "m1",
            "route_reason": "default:first-try"
        },
        "scope": {"port": 4444},
        "result": null,
        "attempts": 0,
        "failed_attempts": 1,
        "switches": 0,
        "usage": null
    });

    let upstream = json!({
        "request_key": "4444:upstream-429",
        "event_type": "request.failed",
        "started_epoch_ms": 3,
        "updated_epoch_ms": 40,
        "finished_epoch_ms": 40,
        "duration_ms": 1,
        "meta": {
            "request_id": "upstream-429",
            "endpoint": "/v1/responses",
            "entry_protocol": "responses",
            "provider_status": 429,
            "error_category": "provider_http_429",
            "error_detail": "upstream rate limited"
        },
        "scope": {"port": 4444},
        "result": "error",
        "attempts": 1,
        "failed_attempts": 1,
        "switches": 0,
        "usage": null
    });

    let control =
        |request_key: &str, result: &str, started_epoch_ms: u64, updated_epoch_ms: u64| {
            json!({
                "request_key": request_key,
                "event_type": "request.completed",
                "started_epoch_ms": started_epoch_ms,
                "updated_epoch_ms": updated_epoch_ms,
                "finished_epoch_ms": updated_epoch_ms,
                "duration_ms": 1,
                "meta": {
                    "request_id": request_key.split(':').next_back().unwrap_or(request_key),
                    "endpoint": "/v1/responses",
                    "entry_protocol": "responses"
                },
                "scope": {"port": 4444},
                "result": result,
                "attempts": 1,
                "failed_attempts": 0,
                "switches": 0,
                "usage": null
            })
        };

    vec![
        terminal_network,
        attempt_network,
        upstream,
        control("4444:success", "success", 4, 30),
        control("4444:cancelled", "cancelled", 5, 20),
    ]
}

fn collect_sort_options(html: &str) -> Vec<String> {
    let select_start = html
        .find("id=\"sort-field\"")
        .expect("requests.html must contain the sort-field select");
    let select = &html[select_start..];
    let select_end = select
        .find("</select>")
        .expect("sort-field select must close");
    select[..select_end]
        .split("value=\"")
        .skip(1)
        .filter_map(|rest| rest.split('"').next())
        .map(str::to_string)
        .collect()
}

#[tokio::test]
async fn observability_records_accept_declared_network_facet_label_from_frontend() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows(&home, &network_facet_fixture_rows());
    let fixture_paths = [
        home.join("config.toml"),
        home.join("provider/p1/config.v2.toml"),
        home.join("state/admin-token"),
        home.join("logs/server-v3-4444.request-records.jsonl"),
    ];
    let fixture_before: Vec<_> = fixture_paths
        .iter()
        .map(|path| std::fs::read(path).expect("fixture file"))
        .collect();

    let initial: Value = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&range=all"
        ))
        .send()
        .await
        .expect("initial records response")
        .json()
        .await
        .expect("initial records json");
    assert_eq!(initial["facets"]["error_status_codes"]["network"], 2);
    assert_eq!(initial["facets"]["error_status_codes"]["429"], 1);

    let harness = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../admin-webui/records-network-facet-smoke.mjs");
    let output = tokio::process::Command::new("node")
        .arg(&harness)
        .arg(&base)
        .output()
        .await
        .expect("frontend records-network consumer");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "actual usage.js loadErrors/buildQueryParams/drilldown must round-trip through the real router: {stdout}\n{stderr}"
    );
    assert!(
        stdout.contains("records-network-facet smoke passed"),
        "frontend consumer did not report its pass marker: {stdout}"
    );

    let rejected = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&status=error&error_status_code=network&error_origin=local"
        ))
        .send()
        .await
        .expect("network records response");
    let rejected_status = rejected.status();
    let rejected_body = rejected.text().await.expect("network records body");
    assert_eq!(
        rejected_status,
        reqwest::StatusCode::OK,
        "the backend-generated network facet must round-trip through the public records query: {rejected_body}"
    );
    let filtered: Value = serde_json::from_str(&rejected_body).expect("network records json");
    assert_eq!(filtered["total"], 2);
    assert_eq!(
        filtered["records"][0]["request_key"],
        "4444:attempt-network"
    );
    assert_eq!(
        filtered["records"][1]["request_key"],
        "4444:terminal-network"
    );

    let illegal_status = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&error_status_code=bogus"
        ))
        .send()
        .await
        .expect("illegal status response");
    assert_eq!(illegal_status.status(), reqwest::StatusCode::BAD_REQUEST);
    let illegal_body: Value = illegal_status.json().await.expect("illegal status json");
    assert_eq!(illegal_body["error"], "invalid error_status_code: bogus");

    let illegal_sort = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&sort_by=error_origin"
        ))
        .send()
        .await
        .expect("illegal sort response");
    assert_eq!(illegal_sort.status(), reqwest::StatusCode::BAD_REQUEST);
    let illegal_sort_body: Value = illegal_sort.json().await.expect("illegal sort json");
    assert_eq!(
        illegal_sort_body["error"],
        "invalid sort field: error_origin"
    );

    let requests_html = http_client()
        .get(format!("{base}/requests.html"))
        .send()
        .await
        .expect("requests html response")
        .text()
        .await
        .expect("requests html body");
    let sort_options = collect_sort_options(&requests_html);
    assert!(!sort_options.is_empty(), "requests.html sort options");
    for option in &sort_options {
        let response = http_client()
            .get(format!(
                "{base}/api/observability/records?page=1&page_size=10&range=all&sort_by={option}&sort_order=asc"
            ))
            .send()
            .await
            .unwrap_or_else(|error| panic!("sort option {option} request failed: {error}"));
        assert_eq!(
            response.status(),
            reqwest::StatusCode::OK,
            "served sort option {option} must remain legal"
        );
    }

    let updated: Value = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&range=all&sort_by=updated_epoch_ms&sort_order=desc"
        ))
        .send()
        .await
        .expect("updated sort response")
        .json()
        .await
        .expect("updated sort json");
    let updated_keys: Vec<&str> = updated["records"]
        .as_array()
        .expect("updated records array")
        .iter()
        .map(|row| row["request_key"].as_str().expect("request key"))
        .collect();
    assert_eq!(
        updated_keys,
        vec![
            "4444:terminal-network",
            "4444:attempt-network",
            "4444:upstream-429",
            "4444:success",
            "4444:cancelled",
        ]
    );

    let retrying: Value = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&range=all&status=retrying&error_status_code=network"
        ))
        .send()
        .await
        .expect("retrying network response")
        .json()
        .await
        .expect("retrying network json");
    assert_eq!(retrying["total"], 1);
    assert_eq!(
        retrying["records"][0]["request_key"],
        "4444:attempt-network"
    );

    for (path, before) in fixture_paths.iter().zip(fixture_before) {
        assert_eq!(
            std::fs::read(path).expect("fixture file"),
            before,
            "GET changed {}",
            path.display()
        );
    }
}

fn provider_usage_fixture() -> (Value, Value, Value, Value, Value) {
    let p1_monday = provider_usage_success_row(
        "shared",
        4444,
        100,
        "p1",
        json!({
            "input_tokens": 1000,
            "output_tokens": 100,
            "input_tokens_details": {"cached_tokens": 550},
            "total_tokens": 1100
        }),
    );
    // Same request key as p1 but a different listener: the logical-request
    // identity is (port, request_key), so this is a separate request.
    let p2_monday_terminal = provider_usage_success_row(
        "shared",
        7777,
        200,
        "p2",
        json!({
            "input_tokens": 100,
            "output_tokens": 10,
            "cache_creation_input_tokens": 20,
            "total_tokens": 110
        }),
    );
    // Two attempts with one stable sequence; only the last attempt belongs to
    // the successful request provider p2.
    let p1_failed = provider_usage_failed_attempt_row("retry", 7777, 300, "p1");
    let p2_failed = provider_usage_failed_attempt_row("retry", 7777, 400, "p2");
    let terminal = provider_usage_success_row(
        "retry",
        7777,
        500,
        "p2",
        json!({
            "input_tokens": 100,
            "output_tokens": 10,
            "total_tokens": 110
        }),
    );
    let unwrapped = provider_usage_success_row(
        "degenerate",
        7777,
        700,
        "p1",
        json!({"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}),
    );
    (
        p1_monday,
        p2_monday_terminal,
        json!([p1_failed, p2_failed]),
        terminal,
        unwrapped,
    )
}

#[tokio::test]
async fn provider_usage_contract_aggregates_ports_attempts_and_calendar_periods() {
    let (p1_monday, p2_monday_terminal, retrying, terminal, unwrapped) = provider_usage_fixture();
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows_for_port(
        &home,
        4444,
        &[
            p1_monday.clone(),
            provider_usage_success_row(
                "old",
                4444,
                1_000,
                "p1",
                json!({"input_tokens": 9_999, "output_tokens": 9_999, "total_tokens": 19_998}),
            ),
        ],
    );
    let mut p2_rows = vec![p2_monday_terminal.clone(), unwrapped.clone()];
    for failed in retrying.as_array().expect("failed attempts") {
        p2_rows.push(failed.clone());
    }
    p2_rows.push(terminal.clone());
    write_observability_rows_for_port(&home, 7777, &p2_rows);

    let (status, body) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%2C7777%5D&view=requests&calendar_period=custom&timezone=UTC&from=0&to=600&grain=day"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "provider usage body: {body}"
    );
    let usage = &body["provider_usage"];
    let summary = &usage["summary"];
    assert_eq!(summary["request_count"], 3);
    assert_eq!(summary["failed_attempt_count"], 2);
    assert_eq!(summary["effective_input_tokens"], 1220);
    assert_eq!(summary["output_tokens"], 120);
    assert_eq!(summary["reported_total_tokens"], 1320);
    assert_eq!(summary["cache_read_tokens"], 550);
    assert_eq!(summary["cache_write_tokens"], 20);
    let cache_hit_rate = summary["cache_hit_rate_percent"]
        .as_f64()
        .expect("numeric cache hit rate");
    assert!(
        (cache_hit_rate - 55.0).abs() < 1e-9,
        "cache hit rate must be 55%: {cache_hit_rate}"
    );
    assert_eq!(summary["usage_record_count"], 3);
    assert_eq!(summary["cache_read_missing_count"], 2);
    assert_eq!(summary["cache_comparable_count"], 1);
    assert_eq!(body["records"].as_array().expect("records").len(), 3);
    assert_eq!(body["total"], 3, "pagination only limits detail rows");
    assert_eq!(usage["range"]["timezone"], "UTC");
    assert_eq!(usage["range"]["grain"], "day");
    assert_eq!(usage["range"]["resolved_from_ms"], 0);
    assert_eq!(usage["range"]["resolved_to_ms"], 600);
    assert_eq!(usage["coverage"]["retained_from_ms"], 100);
    assert_eq!(usage["coverage"]["partial"], true);

    let by_provider = usage["by_provider"].as_array().expect("by_provider");
    let p1 = by_provider
        .iter()
        .find(|item| item["provider_id"] == "p1")
        .expect("p1 usage");
    let p2 = by_provider
        .iter()
        .find(|item| item["provider_id"] == "p2")
        .expect("p2 usage");
    assert_eq!(p1["request_count"], 1);
    assert_eq!(p1["failed_attempt_count"], 1);
    assert_eq!(p2["request_count"], 2);
    assert_eq!(p2["failed_attempt_count"], 1);
    assert_eq!(p2["effective_input_tokens"], 220);
    assert_eq!(p2["reported_total_tokens"], 220);
    assert_eq!(p2["cache_hit_rate_percent"], Value::Null);
    assert_eq!(p2["cache_comparable_count"], 0);
    let timeseries = usage["timeseries"].as_array().expect("timeseries");
    assert_eq!(timeseries.len(), 1);
    let timeseries_hit_rate = timeseries[0]["cache_hit_rate_percent"]
        .as_f64()
        .expect("numeric timeseries cache hit rate");
    assert!(
        (timeseries_hit_rate - 55.0).abs() < 1e-9,
        "timeseries cache hit rate must be 55%: {timeseries_hit_rate}"
    );

    // Failed attempts remain detail rows. The successful logical action is
    // separate from its two failed attempts in the unified summary.
    let (status, attempts) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B7777%5D&view=attempts&calendar_period=custom&timezone=UTC&from=300&to=600&grain=day"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "attempts body: {attempts}");
    assert_eq!(attempts["total"], 2);
    assert_eq!(attempts["provider_usage"]["summary"]["request_count"], 1);
    assert_eq!(
        attempts["provider_usage"]["summary"]["failed_attempt_count"],
        2
    );
    assert!(attempts["records"]
        .as_array()
        .expect("records")
        .iter()
        .any(|row| { row["meta"]["attempt_index"] == 3 && row["meta"]["provider_id"] == "p1" }));
    assert!(attempts["records"]
        .as_array()
        .expect("records")
        .iter()
        .any(|row| { row["meta"]["attempt_index"] == 4 && row["meta"]["provider_id"] == "p2" }));

    for (view, ports, from, expected) in [
        ("requests", "%5B4444%2C7777%5D", 0, &body),
        ("attempts", "%5B7777%5D", 300, &attempts),
    ] {
        let (status, details) = get_json(&format!(
            "{base}/api/observability/records?page=1&page_size=10&ports={ports}&view={view}&calendar_period=custom&timezone=UTC&from={from}&to=600&grain=day&include_provider_usage=false"
        ))
        .await;
        assert_eq!(status, reqwest::StatusCode::OK);
        assert!(details.get("provider_usage").is_none());
        assert_eq!(details["listener_ports"], json!([4444, 7777]));
        assert!(
            details["facets"]["provider_ids"]["p1"]
                .as_u64()
                .unwrap_or(0)
                > 0
        );
        for field in ["records", "total", "stats", "facets", "timeseries"] {
            assert_eq!(details[field], expected[field], "{view} {field}");
        }
    }

    // The OR within dimensions and AND across dimensions are both observable.
    let (status, filtered) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%2C7777%5D&provider_ids=%5B%22p2%22%5D&view=all&calendar_period=custom&timezone=UTC&from=0&to=600"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "ports OR body: {filtered}");
    assert_eq!(filtered["total"], 3);
    assert!(filtered["records"]
        .as_array()
        .expect("records")
        .iter()
        .all(|row| row["scope"]["port"] == 7777));

    // A valid empty view is distinguishishable from a read failure and from a
    // bad natural-calendar parameter.
    let (status, empty) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&calendar_period=custom&timezone=UTC&from=300&to=600"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "empty page body: {empty}");
    assert_eq!(empty["total"], 0);
    assert!(empty["records"].as_array().expect("records").is_empty());
    assert_eq!(empty["provider_usage"]["summary"]["request_count"], 0);
    let (status, _bad_timezone) = get_json(&format!(
        "{base}/api/observability/records?calendar_period=day&timezone=Mars%2FOlympus"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::BAD_REQUEST);

    let (read_failure_base, _read_failure_state, read_failure_home) = bind_test_server().await;
    let read_failure_store = read_failure_home
        .join("logs")
        .join("server-v3-4444.request-records.jsonl");
    std::fs::create_dir_all(read_failure_store.parent().expect("logs dir")).expect("logs dir");
    std::fs::write(&read_failure_store, "{not-json}\n").expect("malformed observability store");
    let (status, read_failure) = get_json(&format!(
        "{read_failure_base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&view=requests&calendar_period=custom&timezone=UTC&from=0&to=600"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::BAD_GATEWAY,
        "read failure body: {read_failure}"
    );
    assert!(read_failure["error"]
        .as_str()
        .is_some_and(|error| !error.is_empty()));

    // A single-listener request key is not globally unique.
    let (status, p2_only) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B7777%5D&calendar_period=custom&timezone=UTC&from=0&to=600"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "p2 only body: {p2_only}");
    assert_eq!(p2_only["provider_usage"]["summary"]["request_count"], 2);
    let (status, p1_only) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&calendar_period=custom&timezone=UTC&from=0&to=600"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "p1 only body: {p1_only}");
    assert_eq!(p1_only["provider_usage"]["summary"]["request_count"], 1);
    let p1_record = &p1_only["records"][0];
    assert_eq!(
        p1_record["usage_normalized"]["effective_input_tokens"],
        p1_record["usage"]["input_tokens"]
    );
    assert_eq!(p1_record["usage_normalized"]["cache_read_tokens"], 550);
    assert_eq!(
        p1_record["usage_normalized"]["cache_hit_rate_percent"],
        Value::Null
    );
    let (status, legacy_inclusive) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&time_from_ms=100&time_to_ms=100"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "legacy inclusive body: {legacy_inclusive}"
    );
    assert_eq!(legacy_inclusive["total"], 1);
    assert_eq!(legacy_inclusive["stats"]["count"], 1);
    assert!(legacy_inclusive.get("provider_usage").is_none());

    let (status, paged) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=1&ports=%5B4444%2C7777%5D&view=requests&calendar_period=custom&timezone=UTC&from=0&to=600"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "paged body: {paged}");
    assert_eq!(paged["records"].as_array().expect("records").len(), 1);
    assert_eq!(paged["total"], 3, "pagination only limits detail rows");
    assert_eq!(paged["provider_usage"]["summary"]["request_count"], 3);
}

#[tokio::test]
async fn provider_usage_calendar_week_uses_anchor_date_and_half_open_bounds() {
    let (base, _state, home) = bind_test_server().await;
    // 1970-01-08 00:00 UTC is Thursday. Its week is Monday 1970-01-05
    // (epoch day 4) through the exclusive next Monday 1970-01-12 (epoch day 11).
    write_observability_rows_for_port(
        &home,
        4444,
        &[
            provider_usage_success_row(
                "previous-thursday",
                4444,
                0,
                "p1",
                json!({"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}),
            ),
            provider_usage_success_row(
                "monday",
                4444,
                4 * 86_400_000,
                "p1",
                json!({"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}),
            ),
            provider_usage_success_row(
                "next-sunday",
                4444,
                10 * 86_400_000,
                "p1",
                json!({"input_tokens": 20, "output_tokens": 2, "total_tokens": 22}),
            ),
            provider_usage_success_row(
                "next-monday",
                4444,
                11 * 86_400_000,
                "p1",
                json!({"input_tokens": 999, "output_tokens": 9, "total_tokens": 1008}),
            ),
        ],
    );
    let (status, body) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&view=all&calendar_period=week&timezone=UTC&anchor_date=1970-01-08&grain=day"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "week body: {body}");
    assert_eq!(
        body["provider_usage"]["summary"]["request_count"], 2,
        "week body: {body}"
    );
    assert_eq!(body["total"], 2);
    assert_eq!(
        body["stats"]["count"], 2,
        "old stats use the same natural-period bounds"
    );
    assert!(
        !body["timeseries"]
            .as_array()
            .expect("legacy timeseries")
            .iter()
            .any(|bucket| {
                bucket["date"] == "1970-01-12"
                    || bucket["date"]
                        .as_str()
                        .is_some_and(|date| date > "1970-01-11")
            }),
        "legacy timeseries must not include the exclusive next week: {body}"
    );
    assert_eq!(
        body["provider_usage"]["summary"]["effective_input_tokens"],
        30
    );
    assert_eq!(
        body["provider_usage"]["summary"]["reported_total_tokens"],
        33
    );
    assert_eq!(
        body["provider_usage"]["range"]["resolved_from_ms"],
        4 * 86_400_000
    );
    assert_eq!(
        body["provider_usage"]["range"]["resolved_to_ms"],
        11 * 86_400_000
    );

    let (status, half_open) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&view=all&calendar_period=custom&timezone=UTC&from=0&to=0"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "half-open body: {half_open}"
    );
    assert_eq!(half_open["provider_usage"]["summary"]["request_count"], 0);
    assert_eq!(half_open["total"], 0);
}

#[tokio::test]
async fn provider_usage_calendar_month_is_half_open_in_the_named_timezone() {
    let (base, _state, home) = bind_test_server().await;
    // UTC January 2026 is [1767225600000, 1769904000000).
    write_observability_rows_for_port(
        &home,
        4444,
        &[
            provider_usage_success_row(
                "before",
                4444,
                1_767_225_599_999,
                "p1",
                json!({"input_tokens": 999, "output_tokens": 9, "total_tokens": 1008}),
            ),
            provider_usage_success_row(
                "start",
                4444,
                1_767_225_600_000,
                "p1",
                json!({"input_tokens": 20, "output_tokens": 2, "total_tokens": 22}),
            ),
            provider_usage_success_row(
                "before-end",
                4444,
                1_769_903_999_999,
                "p1",
                json!({"input_tokens": 30, "output_tokens": 3, "total_tokens": 33}),
            ),
            provider_usage_success_row(
                "end",
                4444,
                1_769_904_000_000,
                "p1",
                json!({"input_tokens": 999, "output_tokens": 9, "total_tokens": 1008}),
            ),
        ],
    );
    let (status, body) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&view=requests&calendar_period=month&timezone=UTC&anchor_date=2026-01-15&grain=day"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "month body: {body}");
    assert_eq!(body["total"], 2);
    assert_eq!(body["provider_usage"]["summary"]["request_count"], 2);
    assert_eq!(
        body["provider_usage"]["summary"]["effective_input_tokens"],
        50
    );
    assert_eq!(
        body["provider_usage"]["range"]["resolved_from_ms"],
        1_767_225_600_000u64
    );
    assert_eq!(
        body["provider_usage"]["range"]["resolved_to_ms"],
        1_769_904_000_000u64
    );
}

#[tokio::test]
async fn provider_usage_dst_day_is_half_open_in_the_named_timezone() {
    let (base, _state, home) = bind_test_server().await;
    // America/New_York 2026-03-08 starts at 05:00Z and ends at the 2026-03-09
    // 04:00Z local midnight. The day is 23 hours because DST starts at 02:00.
    write_observability_rows_for_port(
        &home,
        4444,
        &[
            provider_usage_success_row(
                "before",
                4444,
                1_772_945_999_999,
                "p1",
                json!({"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}),
            ),
            provider_usage_success_row(
                "start",
                4444,
                1_772_946_000_000,
                "p1",
                json!({"input_tokens": 20, "output_tokens": 2, "total_tokens": 22}),
            ),
            provider_usage_success_row(
                "before-end",
                4444,
                1_773_028_799_999,
                "p1",
                json!({"input_tokens": 30, "output_tokens": 3, "total_tokens": 33}),
            ),
            provider_usage_success_row(
                "end",
                4444,
                1_773_028_800_000,
                "p1",
                json!({"input_tokens": 999, "output_tokens": 9, "total_tokens": 1008}),
            ),
        ],
    );
    let (status, body) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&view=requests&calendar_period=day&timezone=America%2FNew_York&anchor_date=2026-03-08&grain=hour"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "DST body: {body}");
    assert_eq!(body["provider_usage"]["summary"]["request_count"], 2);
    assert_eq!(
        body["provider_usage"]["summary"]["effective_input_tokens"],
        50
    );
    assert_eq!(
        body["provider_usage"]["range"]["resolved_from_ms"],
        1_772_946_000_000u64
    );
    assert_eq!(
        body["provider_usage"]["range"]["resolved_to_ms"],
        1_773_028_800_000u64
    );
}

/// The shipped usage view keeps the existing table bounds in
/// `time_from_ms` / `time_to_ms` while also sending the new calendar query.
/// A custom usage range must still honor those legacy parameter names.
#[tokio::test]
async fn provider_usage_custom_range_accepts_legacy_time_bounds() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows_for_port(
        &home,
        4444,
        &[
            provider_usage_success_row(
                "inside",
                4444,
                100,
                "p1",
                json!({"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}),
            ),
            provider_usage_success_row(
                "outside",
                4444,
                200,
                "p1",
                json!({"input_tokens": 20, "output_tokens": 2, "total_tokens": 22}),
            ),
        ],
    );
    let (status, body) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&view=requests&calendar_period=custom&timezone=UTC&time_from_ms=100&time_to_ms=200&grain=day"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "usage body: {body}");
    assert_eq!(body["total"], 1, "legacy custom bounds filter detail rows");
    assert_eq!(body["provider_usage"]["summary"]["request_count"], 1);
    assert_eq!(
        body["provider_usage"]["summary"]["effective_input_tokens"],
        10
    );
    assert_eq!(body["provider_usage"]["range"]["resolved_from_ms"], 100);
    assert_eq!(body["provider_usage"]["range"]["resolved_to_ms"], 200);
}

#[tokio::test]
async fn provider_usage_facts_remain_the_statistics_source_when_detail_is_truncated() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows_for_port(
        &home,
        4444,
        &[provider_usage_success_row(
            "retained-only",
            4444,
            500,
            "p-retained",
            json!({"input_tokens": 999, "output_tokens": 9, "total_tokens": 1008}),
        )],
    );
    write_provider_usage_facts(
        &home,
        4444,
        &[
            json!({
                "listener_id": 4444,
                "request_key": "4444:durable-only",
                "request_started_epoch_ms": 100,
                "result": "success",
                "provider_id": "p-durable",
                "usage": {"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:cache-explicit-zero",
                "request_started_epoch_ms": 200,
                "result": "success",
                "provider_id": "p-cache",
                "usage": {
                    "input_tokens": 20,
                    "cache_read_input_tokens": 0,
                    "output_tokens": 2,
                    "total_tokens": 22
                }
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:cache-read-only",
                "request_started_epoch_ms": 300,
                "result": "success",
                "provider_id": "p-cache",
                "usage": {"cache_read_input_tokens": 100, "total_tokens": 100}
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:total-only",
                "request_started_epoch_ms": 400,
                "result": "success",
                "provider_id": "p-total",
                "usage": {"total_tokens": 7}
            }),
        ],
        &[json!({
            "listener_id": 4444,
            "statistics_started_epoch_ms": 100,
            "detail_started_epoch_ms": 500,
            "detail_incomplete": true,
            "gaps": ["incomplete_detail_tail"]
        })],
    );

    let (status, body) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&calendar_period=custom&timezone=UTC&from=0&to=600"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "facts body: {body}");
    assert_eq!(body["total"], 1, "detail remains the retained row only");
    assert_eq!(body["records"][0]["request_key"], "retained-only");
    let summary = &body["provider_usage"]["summary"];
    assert_eq!(summary["request_count"], 4);
    assert_eq!(summary["effective_input_tokens"], 30);
    assert_eq!(summary["reported_effective_input_tokens"], 30);
    assert_eq!(summary["reported_total_tokens"], 140);
    assert_eq!(summary["cache_read_tokens"], 100);
    assert_eq!(summary["cache_read_missing_count"], 2);
    assert_eq!(summary["cache_read_explicit_zero_count"], 1);
    assert_eq!(summary["effective_input_missing_count"], 2);
    assert_eq!(summary["cache_comparable_count"], 1);
    assert_eq!(summary["cache_comparable_read_tokens"], 0);
    assert_eq!(summary["cache_comparable_effective_input_tokens"], 20);
    assert_eq!(summary["cache_hit_rate_percent"], 0.0);
    assert_eq!(summary["usage_record_count"], 4);
    assert_eq!(
        body["provider_usage"]["by_provider"]
            .as_array()
            .expect("by provider")
            .iter()
            .find(|item| item["provider_id"] == "p-durable")
            .expect("durable provider")["request_count"],
        1
    );
    assert!(body["provider_usage"]["by_provider"]
        .as_array()
        .expect("by provider")
        .iter()
        .all(|item| item["provider_id"] != "p-retained"));
    assert_eq!(
        body["provider_usage"]["coverage"]["source"],
        "durable_facts"
    );
    assert_eq!(
        body["provider_usage"]["coverage"]["statistics_started_epoch_ms"],
        100
    );
    assert_eq!(
        body["provider_usage"]["coverage"]["detail_started_epoch_ms"],
        500
    );
    assert_eq!(body["provider_usage"]["coverage"]["partial"], true);
}

#[tokio::test]
async fn provider_usage_detail_start_follows_selected_scope_not_global_rows_or_pages() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows_for_port(
        &home,
        4444,
        &[
            provider_usage_success_row(
                "early-other-provider",
                4444,
                60_000,
                "p-early",
                json!({"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}),
            ),
            provider_usage_success_row(
                "scope-first",
                4444,
                300_000,
                "p-scope",
                json!({"input_tokens": 20, "output_tokens": 2, "total_tokens": 22}),
            ),
            provider_usage_success_row(
                "scope-second",
                4444,
                310_000,
                "p-scope",
                json!({"input_tokens": 30, "output_tokens": 3, "total_tokens": 33}),
            ),
        ],
    );
    write_observability_rows_for_port(
        &home,
        7777,
        &[provider_usage_success_row(
            "unrelated-listener",
            7777,
            6_000,
            "p-unrelated",
            json!({"input_tokens": 40, "output_tokens": 4, "total_tokens": 44}),
        )],
    );
    write_provider_usage_facts(
        &home,
        4444,
        &[json!({
            "listener_id": 4444,
            "request_key": "4444:scope-durable",
            "request_started_epoch_ms": 200_000,
            "result": "success",
            "provider_id": "p-scope",
            "usage": {"input_tokens": 50, "output_tokens": 5, "total_tokens": 55}
        })],
        &[json!({
            "listener_id": 4444,
            "statistics_started_epoch_ms": 0,
            "detail_started_epoch_ms": 60_000,
            "detail_incomplete": true,
            "gaps": ["detail_rotated"]
        })],
    );
    write_provider_usage_facts(
        &home,
        7777,
        &[json!({
            "listener_id": 7777,
            "request_key": "7777:unrelated-durable",
            "request_started_epoch_ms": 5_000,
            "result": "success",
            "provider_id": "p-unrelated",
            "usage": {"input_tokens": 40, "output_tokens": 4, "total_tokens": 44}
        })],
        &[json!({
            "listener_id": 7777,
            "statistics_started_epoch_ms": 0,
            "detail_started_epoch_ms": 6_000,
            "detail_incomplete": false,
            "gaps": []
        })],
    );

    let base_query =
        "view=requests&calendar_period=custom&timezone=UTC&from=0&to=400000&sort_order=asc";
    let (status, port_only) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&port=4444&{base_query}"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "port body: {port_only}");
    assert_eq!(
        port_only["provider_usage"]["coverage"]["detail_started_epoch_ms"],
        60_000
    );
    assert_eq!(
        port_only["provider_usage"]["coverage"]["retained_from_ms"],
        60_000
    );

    let scoped_url =
        format!("{base}/api/observability/records?port=4444&provider_id=p-scope&{base_query}");
    let (status, scoped_page_one) = get_json(&format!("{scoped_url}&page=1&page_size=1")).await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "scoped page one: {scoped_page_one}"
    );
    assert_eq!(scoped_page_one["total"], 2);
    assert_eq!(
        scoped_page_one["provider_usage"]["summary"]["request_count"],
        1
    );
    assert_eq!(
        scoped_page_one["provider_usage"]["coverage"]["source"],
        "durable_facts"
    );
    assert_eq!(
        scoped_page_one["provider_usage"]["coverage"]["detail_started_epoch_ms"],
        300_000
    );
    assert_eq!(
        scoped_page_one["provider_usage"]["coverage"]["retained_from_ms"],
        300_000
    );

    let (status, scoped_page_two) = get_json(&format!("{scoped_url}&page=2&page_size=1")).await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "scoped page two: {scoped_page_two}"
    );
    assert_eq!(scoped_page_two["total"], 2);
    assert_eq!(
        scoped_page_two["provider_usage"]["coverage"]["detail_started_epoch_ms"], 300_000,
        "pagination must not change coverage"
    );

    let (status, empty_window) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=1&port=4444&provider_id=p-scope&view=requests&calendar_period=custom&timezone=UTC&from=350000&to=400000"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "empty scoped window: {empty_window}"
    );
    assert_eq!(empty_window["total"], 0);
    assert_eq!(
        empty_window["provider_usage"]["coverage"]["detail_started_epoch_ms"], 300_000,
        "the selected time window must not erase the Provider's retained detail start"
    );
    assert_eq!(
        empty_window["provider_usage"]["coverage"]["retained_from_ms"],
        300_000
    );

    let (status, absent_provider) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=1&port=4444&provider_id=p-absent&view=requests&calendar_period=custom&timezone=UTC&from=350000&to=400000"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "absent scoped provider: {absent_provider}"
    );
    assert_eq!(absent_provider["total"], 0);
    assert_eq!(
        absent_provider["provider_usage"]["coverage"]["detail_started_epoch_ms"],
        Value::Null,
        "an absent Provider/port intersection has no observed retained detail"
    );
    assert_eq!(
        absent_provider["provider_usage"]["coverage"]["retained_from_ms"],
        Value::Null
    );
}

#[tokio::test]
async fn provider_usage_terminal_error_counts_once_and_usage_stays_success_only() {
    let (base, _state, home) = bind_test_server().await;
    let mut rows = Vec::with_capacity(222);
    let mut facts = Vec::with_capacity(222);

    for index in 0..221 {
        let started = index as u64 * 1_000;
        let usage = json!({
            "input_tokens": 10,
            "output_tokens": 1,
            "total_tokens": 11
        });
        rows.push(provider_usage_success_row(
            &format!("success-{index}"),
            4444,
            started,
            "p-success",
            usage.clone(),
        ));
        facts.push(json!({
            "listener_id": 4444,
            "request_key": format!("4444:success-{index}"),
            "request_started_epoch_ms": started,
            "result": "success",
            "provider_id": "p-success",
            "usage": usage
        }));
    }

    let terminal_error = json!({
        "request_key": "terminal-error",
        "event_type": "request.failed",
        "started_epoch_ms": 222_000,
        "updated_epoch_ms": 222_100,
        "finished_epoch_ms": 222_100,
        "duration_ms": 100,
        "meta": {
            "request_id": "terminal-error",
            "endpoint": "/v1/responses",
            "entry_protocol": "responses",
            "provider": "p-failed",
            "provider_id": "p-failed",
            "model": "m1",
            "error_category": "provider_transport_error",
            "error_detail": "provider response ended without a business result"
        },
        "scope": {"port": 4444},
        "result": "error",
        "attempts": 1,
        "failed_attempts": 0,
        "switches": 0,
        "usage": {"input_tokens": 999, "output_tokens": 99, "total_tokens": 1098}
    });
    rows.push(terminal_error);
    facts.push(json!({
        "listener_id": 4444,
        "request_key": "4444:terminal-error",
        "request_started_epoch_ms": 222_000,
        "result": "error",
        "provider_id": "p-failed"
    }));
    write_observability_rows_for_port(&home, 4444, &rows);
    write_provider_usage_facts(
        &home,
        4444,
        &facts,
        &[json!({
            "listener_id": 4444,
            "statistics_started_epoch_ms": 0,
            "detail_started_epoch_ms": 0,
            "detail_incomplete": false,
            "gaps": []
        })],
    );

    let (status, body) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=300&ports=%5B4444%5D&view=requests&calendar_period=custom&timezone=UTC&from=0&to=223000"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "ledger body: {body}");
    assert_eq!(body["total"], 222, "every logical request must be visible");
    let summary = &body["provider_usage"]["summary"];
    assert_eq!(summary["request_count"], 222);
    assert_eq!(summary["failed_attempt_count"], 0);
    assert_eq!(summary["usage_record_count"], 221);
    assert_eq!(summary["effective_input_tokens"], 2_210);
    assert_eq!(summary["reported_total_tokens"], 2_431);
    assert_eq!(
        summary["cache_read_missing_count"], 221,
        "failed usage is never counted as successful usage"
    );
    let failed = body["provider_usage"]["by_provider"]
        .as_array()
        .expect("by provider")
        .iter()
        .find(|item| item["provider_id"] == "p-failed")
        .expect("failed terminal provider");
    assert_eq!(failed["request_count"], 1);
    assert_eq!(failed["usage_record_count"], 0);
    assert_eq!(failed["effective_input_tokens"], 0);
    assert_eq!(failed["reported_total_tokens"], Value::Null);
}

#[tokio::test]
async fn provider_usage_cache_comparability_and_total_only_usage_are_explicit() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows_for_port(
        &home,
        4444,
        &[provider_usage_success_row(
            "detail-anchor",
            4444,
            10,
            "p-retained",
            json!({"input_tokens": 999, "output_tokens": 99, "total_tokens": 1098}),
        )],
    );
    write_provider_usage_facts(
        &home,
        4444,
        &[
            json!({
                "listener_id": 4444,
                "request_key": "4444:comparable",
                "request_started_epoch_ms": 100,
                "result": "success",
                "provider_id": "p1",
                "usage": {
                    "input_tokens": 100,
                    "input_tokens_details": {"cached_tokens": 40},
                    "total_tokens": 140
                }
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:cache-zero",
                "request_started_epoch_ms": 200,
                "result": "success",
                "provider_id": "p1",
                "usage": {
                    "input_tokens": 50,
                    "cache_read_input_tokens": 0,
                    "total_tokens": 50
                }
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:cache-without-input",
                "request_started_epoch_ms": 300,
                "result": "success",
                "provider_id": "p1",
                "usage": {
                    "input_tokens_details": {"cached_tokens": 30},
                    "total_tokens": 30
                }
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:no-cache",
                "request_started_epoch_ms": 400,
                "result": "success",
                "provider_id": "p1",
                "usage": {"input_tokens": 10, "total_tokens": 11}
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:total-only",
                "request_started_epoch_ms": 500,
                "result": "success",
                "provider_id": "p1",
                "usage": {"total_tokens": 7}
            }),
        ],
        &[json!({
            "listener_id": 4444,
            "statistics_started_epoch_ms": 0,
            "detail_started_epoch_ms": 0,
            "detail_incomplete": false,
            "gaps": []
        })],
    );

    let (status, body) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&view=requests&calendar_period=custom&timezone=UTC&from=0&to=1000"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "cache accounting body: {body}"
    );
    let summary = &body["provider_usage"]["summary"];
    assert_eq!(summary["request_count"], 5);
    assert_eq!(summary["usage_record_count"], 5);
    assert_eq!(summary["effective_input_tokens"], 160);
    assert_eq!(summary["reported_effective_input_tokens"], 160);
    assert_eq!(summary["reported_total_tokens"], 238);
    assert_eq!(summary["cache_read_tokens"], 70);
    assert_eq!(summary["cache_read_missing_count"], 2);
    assert_eq!(summary["cache_read_explicit_zero_count"], 1);
    assert_eq!(summary["effective_input_missing_count"], 2);
    assert_eq!(summary["cache_comparable_count"], 2);
    assert_eq!(summary["cache_comparable_read_tokens"], 40);
    assert_eq!(summary["cache_comparable_effective_input_tokens"], 150);
    let hit_rate = summary["cache_hit_rate_percent"]
        .as_f64()
        .expect("numeric cache hit rate");
    assert!(
        (hit_rate - (80.0 / 3.0)).abs() < 1e-9,
        "only comparable records enter the hit-rate denominator: {hit_rate}"
    );
    assert_eq!(
        body["provider_usage"]["coverage"]["source"],
        "durable_facts"
    );
}

#[tokio::test]
async fn provider_usage_separates_terminal_cancel_unattributed_active_and_attempts() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows_for_port(
        &home,
        4444,
        &[provider_usage_success_row(
            "retained-anchor",
            4444,
            10,
            "p-retained",
            json!({"input_tokens": 999, "output_tokens": 99, "total_tokens": 1098}),
        )],
    );
    write_provider_usage_facts(
        &home,
        4444,
        &[
            json!({
                "listener_id": 4444,
                "request_key": "4444:success",
                "request_started_epoch_ms": 100,
                "result": "success",
                "provider_id": "p-success",
                "usage": {"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:terminal-error",
                "request_started_epoch_ms": 200,
                "result": "error",
                "provider_id": "p-error",
                "usage": {"input_tokens": 200, "output_tokens": 20, "total_tokens": 220}
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:cancelled",
                "request_started_epoch_ms": 300,
                "result": "cancelled",
                "provider_id": "p-cancel",
                "usage": {"input_tokens": 300, "output_tokens": 30, "total_tokens": 330}
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:unattributed-error",
                "request_started_epoch_ms": 400,
                "result": "error",
                "usage": {"input_tokens": 400, "output_tokens": 40, "total_tokens": 440}
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:active",
                "request_started_epoch_ms": 500,
                "result": "active",
                "provider_id": "p-active",
                "usage": {"input_tokens": 500, "output_tokens": 50, "total_tokens": 550}
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:retry",
                "attempt_ordinal": 1,
                "request_started_epoch_ms": 600,
                "result": "failed_attempt",
                "provider_id": "p-fail"
            }),
        ],
        &[json!({
            "listener_id": 4444,
            "statistics_started_epoch_ms": 0,
            "detail_started_epoch_ms": 0,
            "detail_incomplete": false,
            "gaps": []
        })],
    );

    let (status, body) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&view=requests&calendar_period=custom&timezone=UTC&from=0&to=1000"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "terminal status body: {body}"
    );
    let summary = &body["provider_usage"]["summary"];
    assert_eq!(summary["request_count"], 4);
    assert_eq!(summary["success_count"], 1);
    assert_eq!(summary["error_count"], 2);
    assert_eq!(summary["cancelled_count"], 1);
    assert_eq!(summary["active_count"], 1);
    assert_eq!(summary["unattributed_request_count"], 1);
    assert_eq!(summary["failed_attempt_count"], 1);
    assert_eq!(summary["usage_record_count"], 1);
    assert_eq!(summary["effective_input_tokens"], 10);
    assert_eq!(summary["reported_total_tokens"], 11);

    let providers = body["provider_usage"]["by_provider"]
        .as_array()
        .expect("by provider");
    let provider = |id: &str| {
        providers
            .iter()
            .find(|item| item["provider_id"] == id)
            .unwrap_or_else(|| panic!("provider {id}: {providers:?}"))
    };
    assert_eq!(provider("p-error")["request_count"], 1);
    assert_eq!(provider("p-cancel")["cancelled_count"], 1);
    assert_eq!(provider("p-active")["request_count"], 0);
    assert_eq!(provider("p-active")["active_count"], 1);
    assert_eq!(provider("p-fail")["request_count"], 0);
    assert_eq!(provider("p-fail")["failed_attempt_count"], 1);
    assert_eq!(provider("p-success")["usage_record_count"], 1);
    let unattributed = providers
        .iter()
        .find(|item| item["provider_id"].is_null())
        .expect("unattributed provider bucket");
    assert_eq!(unattributed["request_count"], 1);
    assert_eq!(unattributed["error_count"], 1);
    assert_eq!(unattributed["unattributed_request_count"], 1);
    assert_eq!(unattributed["usage_record_count"], 0);
    assert_eq!(unattributed["effective_input_tokens"], 0);
}

#[tokio::test]
async fn provider_usage_ports_limit_fact_reads_and_isolate_corruption() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows_for_port(
        &home,
        4444,
        &[provider_usage_success_row(
            "port-4444",
            4444,
            100,
            "p1",
            json!({"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}),
        )],
    );
    write_observability_rows_for_port(
        &home,
        7777,
        &[provider_usage_success_row(
            "port-7777",
            7777,
            100,
            "p2",
            json!({"input_tokens": 20, "output_tokens": 2, "total_tokens": 22}),
        )],
    );
    let corrupt_store = home
        .join("logs")
        .join("server-v3-7777.request-records.jsonl");
    std::fs::create_dir_all(routecodex_v3_debug::v3_provider_usage_facts_path(
        &corrupt_store,
    ))
    .expect("unreadable unused listener facts");

    let (status, selected) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&view=requests&calendar_period=custom&timezone=UTC&from=0&to=200"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "selected ports: {selected}"
    );
    assert_eq!(selected["provider_usage"]["summary"]["request_count"], 1);
    assert_eq!(
        selected["provider_usage"]["by_provider"][0]["provider_id"],
        "p1"
    );

    let (status, all_ports) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%2C7777%5D&view=requests&calendar_period=custom&timezone=UTC&from=0&to=200"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::BAD_GATEWAY,
        "selected corrupt facts must fail explicitly: {all_ports}"
    );
    assert!(all_ports["error"]
        .as_str()
        .is_some_and(|error| error.contains("listener 7777")));

    let (status, legacy) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&time_from_ms=0&time_to_ms=200"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "legacy records: {legacy}");
    assert_eq!(
        legacy["total"], 2,
        "legacy query keeps both retained listeners"
    );
    assert!(
        legacy.get("provider_usage").is_none(),
        "legacy shape must not read or return provider usage: {legacy}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn provider_usage_fact_read_does_not_block_legacy_records() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows_for_port(
        &home,
        4444,
        &[provider_usage_success_row(
            "retained",
            4444,
            100,
            "p-retained",
            json!({"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}),
        )],
    );
    let store_path = home
        .join("logs")
        .join("server-v3-4444.request-records.jsonl");
    let facts_path = routecodex_v3_debug::v3_provider_usage_facts_path(&store_path);
    let fifo = std::process::Command::new("mkfifo")
        .arg(&facts_path)
        .status()
        .expect("run mkfifo");
    assert!(fifo.success(), "mkfifo must create the fact-read blocker");

    let usage_url = format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&view=requests&calendar_period=custom&timezone=UTC&from=0&to=200"
    );
    let details_url = format!("{usage_url}&include_provider_usage=false");
    let usage_task = tokio::spawn(async move { get_json(&usage_url).await });
    let writer_path = facts_path.clone();
    let writer_task = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        tokio::task::spawn_blocking(move || {
            let fact = json!({
                "schema_version": 1,
                "fact": {
                    "listener_id": 4444,
                    "request_key": "4444:fifo",
                    "request_started_epoch_ms": 100,
                    "result": "success",
                    "provider_id": "p-fact",
                    "usage": {
                        "input_tokens": 20,
                        "output_tokens": 2,
                        "total_tokens": 22
                    }
                }
            });
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .open(&writer_path)
                .expect("open usage facts fifo");
            writeln!(file, "{fact}").expect("write usage fact");
        })
        .await
        .expect("write task");
    });

    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let legacy_url = format!("{base}/api/observability/records?page=1&page_size=10");
    let ((status, legacy), (details_status, details)) =
        tokio::time::timeout(std::time::Duration::from_millis(700), async {
            tokio::join!(get_json(&legacy_url), get_json(&details_url))
        })
        .await
        .expect("records must not wait for the blocked provider-usage fact read");
    assert_eq!(status, reqwest::StatusCode::OK, "legacy body: {legacy}");
    assert_eq!(legacy["total"], 1);
    assert!(legacy.get("provider_usage").is_none());
    assert_eq!(
        details_status,
        reqwest::StatusCode::OK,
        "details body: {details}"
    );
    assert_eq!(details["records"], legacy["records"]);
    assert_eq!(details["total"], 1);
    assert!(details.get("provider_usage").is_none());

    writer_task.await.expect("writer task");
    let (status, usage) = usage_task.await.expect("usage request");
    assert_eq!(status, reqwest::StatusCode::OK, "usage body: {usage}");
    assert_eq!(usage["provider_usage"]["summary"]["request_count"], 1);
    assert_eq!(
        usage["provider_usage"]["by_provider"][0]["provider_id"],
        "p-fact"
    );
}

#[tokio::test]
async fn provider_usage_missing_fact_listener_is_explicit() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows_for_port(
        &home,
        4444,
        &[provider_usage_success_row(
            "available-port",
            4444,
            100,
            "p1",
            json!({"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}),
        )],
    );
    write_observability_rows_for_port(
        &home,
        7777,
        &[provider_usage_success_row(
            "missing-facts-port",
            7777,
            100,
            "p2",
            json!({"input_tokens": 20, "output_tokens": 2, "total_tokens": 22}),
        )],
    );
    write_provider_usage_facts(
        &home,
        4444,
        &[json!({
            "listener_id": 4444,
            "request_key": "4444:available-port",
            "request_started_epoch_ms": 100,
            "result": "success",
            "provider_id": "p1",
            "usage": {"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}
        })],
        &[json!({
            "listener_id": 4444,
            "statistics_started_epoch_ms": 100,
            "detail_started_epoch_ms": 100,
            "detail_incomplete": false,
            "gaps": []
        })],
    );

    let (status, body) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%2C7777%5D&view=requests&calendar_period=custom&timezone=UTC&from=0&to=200"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "mixed available/missing facts must remain queryable: {body}"
    );
    assert_eq!(body["total"], 2, "retained detail keeps both listeners");
    assert_eq!(body["provider_usage"]["summary"]["request_count"], 1);
    assert_eq!(
        body["provider_usage"]["coverage"]["source"],
        "durable_facts"
    );
    assert_eq!(body["provider_usage"]["coverage"]["complete"], false);
    assert_eq!(body["provider_usage"]["coverage"]["partial"], true);
    let listeners = body["provider_usage"]["coverage"]["listeners"]
        .as_array()
        .expect("listener coverage");
    let available = listeners
        .iter()
        .find(|listener| listener["listener_id"] == 4444)
        .expect("available listener coverage");
    assert_eq!(available["statistics_started_epoch_ms"], 100);
    assert_eq!(available["detail_incomplete"], false);
    let missing = listeners
        .iter()
        .find(|listener| listener["listener_id"] == 7777)
        .expect("missing listener coverage");
    assert_eq!(missing["statistics_started_epoch_ms"], Value::Null);
    assert_eq!(missing["detail_started_epoch_ms"], Value::Null);
    assert_eq!(missing["detail_incomplete"], true);
    assert!(missing["gaps"]
        .as_array()
        .expect("missing listener gaps")
        .contains(&json!("provider_usage_facts_unavailable")));

    let (status, legacy) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&time_from_ms=0&time_to_ms=200"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "legacy records: {legacy}");
    assert_eq!(legacy["total"], 2);
    assert!(legacy.get("provider_usage").is_none());
}

#[tokio::test]
async fn provider_usage_retained_scope_is_explicit_for_detail_only_filter() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows_for_port(
        &home,
        4444,
        &[
            provider_usage_success_row(
                "durable-and-retained",
                4444,
                100,
                "p1",
                json!({"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}),
            ),
            provider_usage_success_row(
                "detail-error",
                4444,
                200,
                "p2",
                json!({"input_tokens": 20, "output_tokens": 2, "total_tokens": 22}),
            ),
        ],
    );
    let store_path = home
        .join("logs")
        .join("server-v3-4444.request-records.jsonl");
    std::fs::create_dir_all(routecodex_v3_debug::v3_provider_usage_facts_path(
        &store_path,
    ))
    .expect("unreadable unused durable facts");
    let (status, body) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&status=error&view=requests&calendar_period=custom&timezone=UTC&from=0&to=600"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "detail-only filters must not read durable facts: {body}"
    );
    assert_eq!(
        body["provider_usage"]["coverage"]["source"],
        "retained_detail"
    );
    assert_eq!(body["provider_usage"]["coverage"]["complete"], false);
}

#[tokio::test]
async fn provider_usage_absent_fact_listener_declares_retained_scope() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows_for_port(
        &home,
        4444,
        &[provider_usage_success_row(
            "retained-only",
            4444,
            100,
            "p-retained",
            json!({"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}),
        )],
    );
    let (status, body) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&view=requests&calendar_period=custom&timezone=UTC&from=0&to=600"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "no-facts listener body: {body}"
    );
    assert_eq!(body["total"], 1);
    assert_eq!(body["provider_usage"]["summary"]["request_count"], 1);
    assert_eq!(body["provider_usage"]["summary"]["usage_record_count"], 1);
    assert_eq!(
        body["provider_usage"]["coverage"]["source"],
        "retained_detail"
    );
    assert_eq!(
        body["provider_usage"]["coverage"]["detail_started_epoch_ms"],
        100
    );
    assert_eq!(body["provider_usage"]["coverage"]["partial"], true);
    let listener = &body["provider_usage"]["coverage"]["listeners"][0];
    assert_eq!(listener["listener_id"], 4444);
    assert_eq!(listener["statistics_started_epoch_ms"], 100);
    assert_eq!(listener["detail_incomplete"], false);
    assert!(listener["gaps"]
        .as_array()
        .expect("listener gaps")
        .contains(&json!("retained_scope_only")));
}

#[tokio::test]
async fn provider_usage_sticky_capacity_keeps_saved_facts_and_only_affects_its_listener() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows_for_port(
        &home,
        4444,
        &[
            provider_usage_success_row(
                "affected-retained",
                4444,
                150,
                "p-affected",
                json!({"input_tokens": 900, "output_tokens": 90, "total_tokens": 990}),
            ),
            provider_usage_success_row(
                "affected-rejected",
                4444,
                175,
                "p-affected",
                json!({"input_tokens": 800, "output_tokens": 80, "total_tokens": 880}),
            ),
        ],
    );
    write_observability_rows_for_port(
        &home,
        7777,
        &[provider_usage_success_row(
            "complete-retained",
            7777,
            250,
            "p-complete",
            json!({"input_tokens": 200, "output_tokens": 20, "total_tokens": 220}),
        )],
    );
    write_provider_usage_facts(
        &home,
        4444,
        &[json!({
            "listener_id": 4444,
            "request_key": "4444:affected-saved",
            "request_started_epoch_ms": 100,
            "result": "success",
            "provider_id": "p-affected",
            "usage": {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110}
        })],
        &[json!({
            "listener_id": 4444,
            "statistics_started_epoch_ms": 100,
            "detail_started_epoch_ms": 100,
            "detail_incomplete": true,
            "gaps": ["provider_usage_fact_capacity_keys"]
        })],
    );
    write_provider_usage_facts(
        &home,
        7777,
        &[json!({
            "listener_id": 7777,
            "request_key": "7777:complete-saved",
            "request_started_epoch_ms": 200,
            "result": "success",
            "provider_id": "p-complete",
            "usage": {"input_tokens": 20, "output_tokens": 2, "total_tokens": 22}
        })],
        &[json!({
            "listener_id": 7777,
            "statistics_started_epoch_ms": 200,
            "detail_started_epoch_ms": 200,
            "detail_incomplete": false,
            "gaps": []
        })],
    );

    let (status, body) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%2C7777%5D&view=requests&calendar_period=custom&timezone=UTC&from=100&to=400"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "capacity body: {body}");
    let usage = &body["provider_usage"];
    assert_eq!(usage["coverage"]["source"], "durable_facts");
    assert_eq!(usage["coverage"]["complete"], false);
    assert_eq!(usage["coverage"]["partial"], true);
    assert_eq!(usage["summary"]["request_count"], 2);
    assert_eq!(usage["summary"]["effective_input_tokens"], 120);
    assert_eq!(usage["summary"]["output_tokens"], 12);
    assert_eq!(usage["summary"]["reported_total_tokens"], 132);
    assert!(usage["by_provider"]
        .as_array()
        .expect("by provider")
        .iter()
        .all(|provider| provider["provider_id"] != "p-retained"));

    let listeners = usage["coverage"]["listeners"]
        .as_array()
        .expect("listener coverage");
    let affected = listeners
        .iter()
        .find(|listener| listener["listener_id"] == 4444)
        .expect("affected listener coverage");
    assert_eq!(affected["statistics_started_epoch_ms"], 100);
    assert_eq!(affected["detail_incomplete"], true);
    assert!(affected["gaps"]
        .as_array()
        .expect("affected gaps")
        .contains(&json!("provider_usage_fact_capacity_keys")));
    let unaffected = listeners
        .iter()
        .find(|listener| listener["listener_id"] == 7777)
        .expect("unaffected listener coverage");
    assert_eq!(unaffected["detail_incomplete"], false);
    assert_eq!(unaffected["gaps"], json!([]));

    let (status, affected_query) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&port=4444&provider_id=p-affected&view=requests&calendar_period=custom&timezone=UTC&from=100&to=400"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "affected exact query: {affected_query}"
    );
    assert_eq!(
        affected_query["provider_usage"]["summary"]["request_count"],
        1
    );
    assert_eq!(
        affected_query["provider_usage"]["summary"]["effective_input_tokens"],
        100
    );
    assert_eq!(
        affected_query["provider_usage"]["summary"]["reported_total_tokens"],
        110
    );
    assert_eq!(
        affected_query["provider_usage"]["coverage"]["source"],
        "durable_facts"
    );
    assert_eq!(
        affected_query["provider_usage"]["coverage"]["partial"],
        true
    );

    let (status, unaffected_query) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&port=7777&provider_id=p-complete&view=requests&calendar_period=custom&timezone=UTC&from=200&to=400"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "unaffected exact query: {unaffected_query}"
    );
    assert_eq!(
        unaffected_query["provider_usage"]["summary"]["request_count"],
        1
    );
    assert_eq!(
        unaffected_query["provider_usage"]["summary"]["effective_input_tokens"],
        20
    );
    assert_eq!(
        unaffected_query["provider_usage"]["coverage"]["complete"],
        true
    );
    assert_eq!(
        unaffected_query["provider_usage"]["coverage"]["listeners"][0]["detail_incomplete"],
        false
    );
}

#[tokio::test]
async fn provider_usage_exact_ids_and_retained_scope_are_explicit() {
    let (base, _state, home) = bind_test_server().await;
    write_observability_rows_for_port(
        &home,
        4444,
        &[
            provider_usage_success_row(
                "retained-p1",
                4444,
                100,
                "p1",
                json!({"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}),
            ),
            provider_usage_success_row(
                "retained-p10",
                4444,
                200,
                "p10",
                json!({"input_tokens": 20, "output_tokens": 2, "total_tokens": 22}),
            ),
        ],
    );
    write_provider_usage_facts(
        &home,
        4444,
        &[
            json!({
                "listener_id": 4444,
                "request_key": "4444:durable-p1",
                "request_started_epoch_ms": 100,
                "result": "success",
                "provider_id": "p1",
                "usage": {"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:durable-p10",
                "request_started_epoch_ms": 200,
                "result": "success",
                "provider_id": "p10",
                "usage": {"input_tokens": 20, "output_tokens": 2, "total_tokens": 22}
            }),
        ],
        &[json!({
            "listener_id": 4444,
            "statistics_started_epoch_ms": 100,
            "detail_started_epoch_ms": 100,
            "detail_incomplete": true,
            "gaps": ["retained_detail_available"]
        })],
    );
    let (status, exact_provider) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B4444%5D&provider_ids=%5B%22p1%22%5D&view=requests&calendar_period=custom&timezone=UTC&from=0&to=600"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "provider body: {exact_provider}"
    );
    assert_eq!(exact_provider["total"], 1);
    assert_eq!(
        exact_provider["provider_usage"]["summary"]["request_count"], 1,
        "provider IDs match exactly and p1 must not select p10"
    );
    assert_eq!(
        exact_provider["provider_usage"]["coverage"]["source"],
        "durable_facts"
    );

    let (status, exact_ports) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&ports=%5B444%5D&view=requests&calendar_period=custom&timezone=UTC&from=0&to=600"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(exact_ports["provider_usage"]["summary"]["request_count"], 0);
    assert_eq!(exact_ports["provider_usage"]["by_provider"], json!([]));
}

#[tokio::test]
async fn provider_usage_legacy_display_identity_stays_retained_and_intersects_exact_id() {
    let (base, _state, home) = bind_test_server().await;
    let mut display_id_a = provider_usage_success_row(
        "display-id-a",
        4444,
        100,
        "id-a",
        json!({"input_tokens": 100, "output_tokens": 10, "total_tokens": 110}),
    );
    display_id_a["meta"]["provider"] = json!("Display Provider");
    let mut display_id_b = provider_usage_success_row(
        "display-id-b",
        4444,
        200,
        "id-b",
        json!({"input_tokens": 20, "output_tokens": 2, "total_tokens": 22}),
    );
    display_id_b["meta"]["provider"] = json!("Display Provider");
    let mut other_id_a = provider_usage_success_row(
        "other-id-a",
        4444,
        300,
        "id-a",
        json!({"input_tokens": 30, "output_tokens": 3, "total_tokens": 33}),
    );
    other_id_a["meta"]["provider"] = json!("Other Provider");
    let mut other_id_b = provider_usage_success_row(
        "other-id-b",
        4444,
        400,
        "id-b",
        json!({"input_tokens": 40, "output_tokens": 4, "total_tokens": 44}),
    );
    other_id_b["meta"]["provider"] = json!("Other Provider");
    write_observability_rows_for_port(
        &home,
        4444,
        &[display_id_a, display_id_b, other_id_a, other_id_b],
    );
    write_provider_usage_facts(
        &home,
        4444,
        &[
            json!({
                "listener_id": 4444,
                "request_key": "4444:display-id-a",
                "request_started_epoch_ms": 100,
                "result": "success",
                "provider_id": "id-a",
                "usage": {"input_tokens": 101, "output_tokens": 11, "total_tokens": 112}
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:display-id-b",
                "request_started_epoch_ms": 200,
                "result": "success",
                "provider_id": "id-b",
                "usage": {"input_tokens": 21, "output_tokens": 2, "total_tokens": 23}
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:other-id-a",
                "request_started_epoch_ms": 300,
                "result": "success",
                "provider_id": "id-a",
                "usage": {"input_tokens": 31, "output_tokens": 3, "total_tokens": 34}
            }),
            json!({
                "listener_id": 4444,
                "request_key": "4444:other-id-b",
                "request_started_epoch_ms": 400,
                "result": "success",
                "provider_id": "id-b",
                "usage": {"input_tokens": 41, "output_tokens": 4, "total_tokens": 45}
            }),
        ],
        &[json!({
            "listener_id": 4444,
            "statistics_started_epoch_ms": 100,
            "detail_started_epoch_ms": 100,
            "detail_incomplete": true,
            "gaps": ["retained_detail_available"]
        })],
    );

    let (status, legacy) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&provider=Display%20Provider&view=requests&calendar_period=custom&timezone=UTC&from=0&to=600&grain=day"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "legacy body: {legacy}");
    let legacy_keys: Vec<&str> = legacy["records"]
        .as_array()
        .expect("legacy records")
        .iter()
        .map(|row| row["request_key"].as_str().expect("request key"))
        .collect();
    assert_eq!(legacy_keys, vec!["display-id-b", "display-id-a"]);
    assert_eq!(legacy["total"], 2);
    assert_eq!(legacy["records"][0]["meta"]["provider"], "Display Provider");
    assert_eq!(legacy["records"][0]["meta"]["provider_id"], "id-b");
    let legacy_usage = &legacy["provider_usage"];
    assert_eq!(legacy_usage["summary"]["request_count"], 2);
    assert_eq!(legacy_usage["summary"]["effective_input_tokens"], 120);
    assert_eq!(legacy_usage["summary"]["output_tokens"], 12);
    assert_eq!(legacy_usage["summary"]["reported_total_tokens"], 132);
    assert_eq!(legacy_usage["timeseries"][0]["request_count"], 2);
    assert_eq!(legacy_usage["timeseries"][0]["effective_input_tokens"], 120);
    assert_eq!(legacy_usage["coverage"]["source"], "retained_detail");
    assert_eq!(legacy_usage["coverage"]["complete"], false);
    assert_eq!(legacy_usage["coverage"]["partial"], true);
    assert!(legacy_usage["coverage"]["listeners"][0]["gaps"]
        .as_array()
        .expect("legacy listener gaps")
        .contains(&json!("retained_scope_only")));

    let (status, intersected) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&provider=Display%20Provider&provider_id=id-a&view=requests&calendar_period=custom&timezone=UTC&from=0&to=600&grain=day"
    ))
    .await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "intersection body: {intersected}"
    );
    assert_eq!(intersected["total"], 1);
    assert_eq!(intersected["records"][0]["request_key"], "display-id-a");
    assert_eq!(
        intersected["provider_usage"]["summary"]["effective_input_tokens"],
        100
    );
    assert_eq!(
        intersected["provider_usage"]["coverage"]["source"],
        "retained_detail"
    );

    let (status, exact_id) = get_json(&format!(
        "{base}/api/observability/records?page=1&page_size=10&provider_id=id-a&view=requests&calendar_period=custom&timezone=UTC&from=0&to=600&grain=day"
    ))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "exact body: {exact_id}");
    assert_eq!(exact_id["total"], 2);
    let exact_keys: Vec<&str> = exact_id["records"]
        .as_array()
        .expect("exact records")
        .iter()
        .map(|row| row["request_key"].as_str().expect("request key"))
        .collect();
    assert_eq!(exact_keys, vec!["other-id-a", "display-id-a"]);
    assert_eq!(
        exact_id["provider_usage"]["summary"]["effective_input_tokens"],
        132
    );
    assert_eq!(exact_id["provider_usage"]["summary"]["output_tokens"], 14);
    assert_eq!(
        exact_id["provider_usage"]["summary"]["reported_total_tokens"],
        146
    );
    assert_eq!(
        exact_id["provider_usage"]["coverage"]["source"],
        "durable_facts"
    );
}

/// Local request conversion failure and real upstream HTTP 400 must stay
/// distinct on the public records API and in the actual WebUI status rendering.
/// The local row keeps a legacy carrier `provider_status=400`; the typed
/// `internal_request_lane` category must win so it renders as 598/local and
/// never shows up as a second 400/local row.
#[tokio::test]
async fn observability_local_conversion_and_upstream_400_remain_distinct() {
    let (base, _state, home) = bind_test_server().await;
    let local = json!({
        "request_key": "4444:local-conversion-400",
        "event_type": "request.failed",
        "started_epoch_ms": 1,
        "updated_epoch_ms": 40,
        "finished_epoch_ms": 40,
        "duration_ms": 1,
        "meta": {
            "request_id": "local-conversion-400",
            "endpoint": "/v1/responses",
            "entry_protocol": "responses",
            "provider_status": 400,
            "error_category": "internal_request_lane",
            "error_detail": "local request conversion failed",
            "observed_error": {"source": "error06_projection_not_exposed"}
        },
        "scope": {"port": 4444},
        "result": "error",
        "attempts": 1,
        "failed_attempts": 1,
        "switches": 0,
        "usage": null
    });
    let upstream = json!({
        "request_key": "4444:upstream-http-400",
        "event_type": "request.failed",
        "started_epoch_ms": 2,
        "updated_epoch_ms": 30,
        "finished_epoch_ms": 30,
        "duration_ms": 1,
        "meta": {
            "request_id": "upstream-http-400",
            "endpoint": "/v1/responses",
            "entry_protocol": "responses",
            "provider_status": 400,
            "error_category": "provider_http_400",
            "error_detail": "upstream rejected request shape",
            "observed_error": {"source": "provider_attempt_failure"}
        },
        "scope": {"port": 4444},
        "result": "error",
        "attempts": 1,
        "failed_attempts": 1,
        "switches": 0,
        "usage": null
    });
    let success = json!({
        "request_key": "4444:success-control",
        "event_type": "request.completed",
        "started_epoch_ms": 3,
        "updated_epoch_ms": 20,
        "finished_epoch_ms": 20,
        "duration_ms": 1,
        "meta": {
            "request_id": "success-control",
            "endpoint": "/v1/responses",
            "entry_protocol": "responses"
        },
        "scope": {"port": 4444},
        "result": "success",
        "attempts": 1,
        "failed_attempts": 0,
        "switches": 0,
        "usage": null
    });
    write_observability_rows(&home, &[local, upstream, success]);

    let harness = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../admin-webui/records-status-origin-smoke.mjs");
    let output = tokio::process::Command::new("node")
        .arg(&harness)
        .arg(&base)
        .output()
        .await
        .expect("frontend status-origin consumer");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "actual usage.js statusText/drilldown must round-trip the local/upstream 400 split: {stdout}\n{stderr}"
    );
    assert!(
        stdout.contains("records-status-origin smoke passed"),
        "frontend consumer did not report its pass marker: {stdout}"
    );

    let initial: Value = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&range=all"
        ))
        .send()
        .await
        .expect("initial records response")
        .json()
        .await
        .expect("initial records json");
    assert_eq!(
        initial["facets"]["error_status_codes"]["598"], 1,
        "local conversion must keep its typed 598: {initial}"
    );
    assert_eq!(
        initial["facets"]["error_status_codes"]["400"], 1,
        "only the real upstream 400 contributes the 400 facet: {initial}"
    );
    assert_eq!(
        initial["facets"]["error_status_origins"]["598"]["local"], 1,
        "598 local facet: {initial}"
    );
    assert_eq!(
        initial["facets"]["error_status_origins"]["400"]["upstream"], 1,
        "400 upstream facet: {initial}"
    );
    assert!(
        initial["facets"]["error_status_origins"]["400"]["local"].is_null(),
        "legacy provider_status=400 must not create a local 400 row: {initial}"
    );

    let local_filtered: Value = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&status=error&error_status_code=598&error_origin=local"
        ))
        .send()
        .await
        .expect("local conversion response")
        .json()
        .await
        .expect("local conversion json");
    assert_eq!(local_filtered["total"], 1);
    assert_eq!(
        local_filtered["records"][0]["request_key"],
        "4444:local-conversion-400"
    );
    assert_eq!(local_filtered["records"][0]["error_origin"], "local");

    let upstream_filtered: Value = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=10&status=error&error_status_code=400&error_origin=upstream"
        ))
        .send()
        .await
        .expect("upstream 400 response")
        .json()
        .await
        .expect("upstream 400 json");
    assert_eq!(upstream_filtered["total"], 1);
    assert_eq!(
        upstream_filtered["records"][0]["request_key"],
        "4444:upstream-http-400"
    );
    assert_eq!(upstream_filtered["records"][0]["error_origin"], "upstream");
}

/// A retained error row can carry a legacy `provider_status=200` without a
/// typed terminal code. Its error result and original metadata stay intact, but
/// the Admin API and shipped WebUI must render the unavailable status as
/// `unknown`. Typed Error06 state wins when it contains a real 4xx/5xx code.
#[tokio::test]
async fn observability_error_row_terminal_status_never_uses_success_carrier() {
    let (base, _state, home) = bind_test_server().await;
    let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/e56edd5_terminal_http_200_row.json");
    let retained: Value =
        serde_json::from_slice(&std::fs::read(&fixture).expect("retained e56edd5 fixture"))
            .expect("retained e56edd5 json");

    let success = json!({
        "request_key": "4444:success-control",
        "event_type": "request.completed",
        "started_epoch_ms": 1,
        "updated_epoch_ms": 2,
        "finished_epoch_ms": 2,
        "duration_ms": 1,
        "meta": {
            "request_id": "success-control",
            "endpoint": "/v1/responses",
            "entry_protocol": "responses",
            "provider_status": 200,
            "finish_reason": "stop"
        },
        "scope": {"port": 4444},
        "result": "success",
        "attempts": 1,
        "failed_attempts": 0,
        "switches": 0,
        "usage": null
    });
    let upstream502 = provider_attempt_failure_row("upstream-http-502");
    let typed599 = json!({
        "request_key": "4444:typed-error06-599",
        "event_type": "request.failed",
        "started_epoch_ms": 3,
        "updated_epoch_ms": 4,
        "finished_epoch_ms": 4,
        "duration_ms": 1,
        "meta": {
            "request_id": "typed-error06-599",
            "endpoint": "/v1/responses",
            "entry_protocol": "responses",
            "provider_status": 200,
            "error_category": "http_200",
            "observed_error": {
                "source": "error06_projection",
                "chain": [
                    {"node": "V3Error06ClientProjected", "state": "projected", "code": "599"}
                ]
            }
        },
        "scope": {"port": 4444},
        "result": "error",
        "attempts": 1,
        "failed_attempts": 1,
        "switches": 0,
        "usage": null
    });
    let conflict599 = json!({
        "request_key": "4444:typed-conflict-599",
        "event_type": "request.failed",
        "started_epoch_ms": 5,
        "updated_epoch_ms": 6,
        "finished_epoch_ms": 6,
        "duration_ms": 1,
        "meta": {
            "request_id": "typed-conflict-599",
            "endpoint": "/v1/responses",
            "entry_protocol": "responses",
            "provider_status": 200,
            "error_category": "internal_request_lane",
            "observed_error": {
                "source": "error06_projection",
                "chain": [
                    {"node": "V3Error06ClientProjected", "state": "projected", "code": "599"}
                ]
            }
        },
        "scope": {"port": 4444},
        "result": "error",
        "attempts": 1,
        "failed_attempts": 1,
        "switches": 0,
        "usage": null
    });
    let no_status = json!({
        "request_key": "4444:error-no-status",
        "event_type": "request.failed",
        "started_epoch_ms": 7,
        "updated_epoch_ms": 8,
        "finished_epoch_ms": 8,
        "duration_ms": 1,
        "meta": {
            "request_id": "error-no-status",
            "endpoint": "/v1/responses",
            "entry_protocol": "responses"
        },
        "scope": {"port": 4444},
        "result": "error",
        "attempts": 0,
        "failed_attempts": 0,
        "switches": 0,
        "usage": null
    });
    let typed200 = json!({
        "request_key": "4444:error06-200",
        "event_type": "request.failed",
        "started_epoch_ms": 9,
        "updated_epoch_ms": 10,
        "finished_epoch_ms": 10,
        "duration_ms": 1,
        "meta": {
            "request_id": "error06-200",
            "endpoint": "/v1/responses",
            "entry_protocol": "responses",
            "provider_status": 200,
            "observed_error": {
                "source": "error06_projection",
                "chain": [
                    {"node": "V3Error06ClientProjected", "state": "projected", "code": "200"}
                ]
            }
        },
        "scope": {"port": 4444},
        "result": "error",
        "attempts": 1,
        "failed_attempts": 1,
        "switches": 0,
        "usage": null
    });

    write_observability_rows(
        &home,
        &[
            retained.clone(),
            success,
            upstream502,
            typed599,
            conflict599,
            no_status,
            typed200,
        ],
    );
    let store_path = home
        .join("logs")
        .join("server-v3-4444.request-records.jsonl");
    let before = std::fs::read(&store_path).expect("store before GET");

    let harness = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../admin-webui/records-error-terminal-status-smoke.mjs");
    let output = tokio::process::Command::new("node")
        .arg(&harness)
        .arg(&base)
        .output()
        .await
        .expect("frontend terminal-status consumer");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let initial: Value = http_client()
        .get(format!(
            "{base}/api/observability/records?page=1&page_size=100&range=all"
        ))
        .send()
        .await
        .expect("initial records response")
        .json()
        .await
        .expect("initial records json");
    let retained_api = initial["records"]
        .as_array()
        .expect("records array")
        .iter()
        .find(|row| row["request_key"] == retained["request_key"])
        .expect("retained row returned by records API");
    assert_eq!(
        retained_api["meta"], retained["meta"],
        "records API changed the retained provider/error metadata: {initial}"
    );
    assert_eq!(retained_api["result"], "error");
    assert_eq!(retained_api["error_origin"], "local");

    let after = std::fs::read(&store_path).expect("store after GET");
    assert_eq!(
        before, after,
        "GET /api/observability/records changed the store"
    );

    assert!(
        output.status.success(),
        "actual served usage.js must render the terminal-status scenarios correctly: {stdout}\n{stderr}"
    );
    assert!(
        stdout.contains("records-error-terminal-status smoke passed"),
        "frontend consumer did not report its pass marker: {stdout}"
    );
}

// ---------------------------------------------------------------------------
// Manual cooldown actions (add / probe).
//
// The admin router is a passthrough: the listener owns every cooldown decision.
// These tests therefore stay on the admin side of the boundary and never let a
// request reach a listener, so they cannot mutate a live runtime on the
// fixture's 4444/7777 ports. Every case is rejected before the forward.
// ---------------------------------------------------------------------------

/// The token `AppState::new` provisions under `<config_dir>/state/admin-token`.
fn admin_token(home: &Path) -> String {
    std::fs::read_to_string(home.join("state").join("admin-token"))
        .expect("admin token provisioned under <config_dir>/state/admin-token")
        .trim()
        .to_string()
}

/// POST carrying the admin token every mutating admin route requires.
async fn post_json_with_token(
    url: &str,
    token: &str,
    body: &Value,
) -> (reqwest::StatusCode, Value) {
    let response = http_client()
        .post(url)
        .header("x-routecodex-admin-token", token)
        .json(body)
        .send()
        .await
        .expect("http response");
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    (status, body)
}

async fn status_of(request: reqwest::RequestBuilder) -> reqwest::StatusCode {
    request.send().await.expect("http response").status()
}

/// A validation rejection proves the handler ran: auth let the request through
/// and the route exists. 401/403/503 would mean we never reached it.
fn assert_reached_handler(status: reqwest::StatusCode, body: &Value) {
    assert!(
        !matches!(
            status,
            reqwest::StatusCode::UNAUTHORIZED
                | reqwest::StatusCode::FORBIDDEN
                | reqwest::StatusCode::SERVICE_UNAVAILABLE
                | reqwest::StatusCode::NOT_FOUND
                | reqwest::StatusCode::METHOD_NOT_ALLOWED
        ),
        "request must reach the cooldown handler past auth and routing, got {status}: {body}"
    );
}

#[tokio::test]
async fn cooldown_add_rejects_session_kind() {
    let (base, _state, home) = bind_test_server().await;
    let (status, body) = post_json_with_token(
        &format!("{base}/api/observability/cooldown-pool/add"),
        &admin_token(&home),
        &json!({
            "port": 4444,
            "provider_id": "p1",
            "auth_alias": "k1",
            "model_id": "m1",
            "kind": "session",
            "duration_ms": 60000,
        }),
    )
    .await;
    assert_reached_handler(status, &body);
    assert_eq!(
        status,
        reqwest::StatusCode::BAD_REQUEST,
        "a manual add may not name a session cooldown: {body}"
    );
}

#[tokio::test]
async fn cooldown_add_rejects_unconfigured_port() {
    let (base, _state, home) = bind_test_server().await;
    let (status, body) = post_json_with_token(
        &format!("{base}/api/observability/cooldown-pool/add"),
        &admin_token(&home),
        &json!({
            "port": 9999,
            "provider_id": "p1",
            "auth_alias": "k1",
            "model_id": "m1",
            "kind": "auth_key",
            "duration_ms": 60000,
        }),
    )
    .await;
    assert_reached_handler(status, &body);
    assert_eq!(
        status,
        reqwest::StatusCode::BAD_REQUEST,
        "9999 is not one of the configured listeners: {body}"
    );
}

#[tokio::test]
async fn cooldown_add_rejects_empty_provider_id() {
    let (base, _state, home) = bind_test_server().await;
    let (status, body) = post_json_with_token(
        &format!("{base}/api/observability/cooldown-pool/add"),
        &admin_token(&home),
        &json!({
            "port": 4444,
            "provider_id": "   ",
            "kind": "probe",
            "duration_ms": 60000,
        }),
    )
    .await;
    assert_reached_handler(status, &body);
    assert_eq!(
        status,
        reqwest::StatusCode::BAD_REQUEST,
        "a cooldown must name the provider it belongs to: {body}"
    );
}

#[tokio::test]
async fn cooldown_probe_rejects_unconfigured_port() {
    let (base, _state, home) = bind_test_server().await;
    let (status, body) = post_json_with_token(
        &format!("{base}/api/observability/cooldown-pool/probe"),
        &admin_token(&home),
        &json!({
            "port": 9999,
            "provider_id": "p1",
            "auth_alias": "k1",
            "model_id": "m1",
        }),
    )
    .await;
    assert_reached_handler(status, &body);
    assert_eq!(
        status,
        reqwest::StatusCode::BAD_REQUEST,
        "9999 is not one of the configured listeners: {body}"
    );
}

#[tokio::test]
async fn cooldown_manual_action_routes_are_registered_behind_admin_auth() {
    let (base, _state, home) = bind_test_server().await;
    let add_url = format!("{base}/api/observability/cooldown-pool/add");
    let probe_url = format!("{base}/api/observability/cooldown-pool/probe");

    // Both paths are POST-only: a GET reaches the route table and is refused by
    // the method, not by a missing path.
    assert_eq!(
        status_of(http_client().get(&add_url)).await,
        reqwest::StatusCode::METHOD_NOT_ALLOWED,
        "POST /api/observability/cooldown-pool/add must be registered"
    );
    assert_eq!(
        status_of(http_client().get(&probe_url)).await,
        reqwest::StatusCode::METHOD_NOT_ALLOWED,
        "POST /api/observability/cooldown-pool/probe must be registered"
    );

    // Without the token the shared admin middleware fails closed before the
    // handler, which is what makes the token-bearing cases above meaningful.
    let (status, body) = {
        let response = http_client()
            .post(&add_url)
            .json(&json!({ "port": 9999, "provider_id": "p1", "kind": "probe", "duration_ms": 1 }))
            .send()
            .await
            .expect("http response");
        let status = response.status();
        let body = response.json::<Value>().await.unwrap_or(Value::Null);
        (status, body)
    };
    assert_eq!(
        status,
        reqwest::StatusCode::UNAUTHORIZED,
        "a mutating cooldown action must require the admin token: {body}"
    );

    // With the token the same rejected body reaches validation on both routes.
    for (url, body) in [
        (
            &add_url,
            json!({ "port": 9999, "provider_id": "p1", "kind": "probe", "duration_ms": 1 }),
        ),
        (&probe_url, json!({ "port": 9999, "provider_id": "p1" })),
    ] {
        let (status, body) = post_json_with_token(url, &admin_token(&home), &body).await;
        assert_reached_handler(status, &body);
        assert_eq!(status, reqwest::StatusCode::BAD_REQUEST, "body: {body}");
    }
}
