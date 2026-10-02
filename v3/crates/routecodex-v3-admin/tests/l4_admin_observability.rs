// feature_id: v3.admin_observability_detail
// Admin observability detail / artifact / live-stream black-box integration
// test. Exercises the real axum router over HTTP against a hand-written JSONL
// observability store and a constructed debug sample directory.
use futures_util::StreamExt;
use routecodex_v3_admin::{router, AppState};
use routecodex_v3_config_mgmt::ConfigMgmtStore;
use serde_json::{json, Value};
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
    let store_path = home
        .join("logs")
        .join("server-v3-4444.request-records.jsonl");
    std::fs::create_dir_all(store_path.parent().expect("logs dir")).expect("logs dir");
    let content = rows
        .iter()
        .map(|row| json!({ "schema_version": 1, "row": row }).to_string())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(store_path, format!("{content}\n")).expect("observability store");
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
