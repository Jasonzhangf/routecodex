use axum::{http::StatusCode, routing::post, Json, Router};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::time::sleep;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

struct Server {
    child: Child,
    port: u16,
    log: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            self.child.kill().unwrap();
        }
        self.child.wait().unwrap();
    }
}

fn start(root: &Path, index: usize, upstream: &str) -> Server {
    let port = test_ports::free_port();
    let instance = root.join(format!("i-{index}"));
    fs::create_dir_all(&instance).unwrap();
    let config = instance.join("config.retention.toml");
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("test");
    fs::write(&config, format!(r#"
version = 3
{declaration}
[servers.test]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}
[providers.peer]
type = "responses"
base_url = "{upstream}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_RETENTION_BLACKBOX_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000, probe_interval_ms = 1800000 }}
[providers.peer.models.test]
wire_name = "test"
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "peer", model = "test", key = "key", priority = 1 }}]
[debug]
log_console = false
codex_samples = true
"#)).unwrap();
    let log = instance.join("cli.log");
    let stderr = fs::File::create(&log).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .args(["server", "start", "--foreground", "--snapall", "--config"])
        .arg(config)
        .env("HOME", root.join("home"))
        .env("ROUTECODEX_V3_STATE_DIR", instance.join("state"))
        .env(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            instance.join("counter.json"),
        )
        .env("TMPDIR", &instance)
        .env("TMP", &instance)
        .env("TEMP", &instance)
        .env("V3_RETENTION_BLACKBOX_KEY", "external-peer")
        .stdout(Stdio::null())
        .stderr(stderr)
        .spawn()
        .unwrap();
    Server { child, port, log }
}

async fn healthy(client: &reqwest::Client, server: &mut Server) {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        assert!(
            server.child.try_wait().unwrap().is_none(),
            "CLI exited before health: {}",
            fs::read_to_string(&server.log).unwrap()
        );
        if let Ok(response) = client
            .get(format!("http://127.0.0.1:{}/health", server.port))
            .send()
            .await
        {
            if response.status().is_success() {
                assert_eq!(response.json::<Value>().await.unwrap()["port"], server.port);
                return;
            }
        }
        assert!(Instant::now() < deadline, "CLI did not become healthy");
        sleep(Duration::from_millis(25)).await;
    }
}

fn request_dirs(root: &Path) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for endpoint in fs::read_dir(root).unwrap() {
        let ports = endpoint.unwrap().path().join("ports");
        if !ports.is_dir() {
            continue;
        }
        for port in fs::read_dir(ports).unwrap() {
            for request in fs::read_dir(port.unwrap().path()).unwrap() {
                directories.push(request.unwrap().path());
            }
        }
    }
    directories
}

fn retention_router() -> Router {
    Router::new().route(
        "/v1/responses",
        post(|Json(body): Json<Value>| async move {
            let input = body["input"].as_str().unwrap_or_default();
            if input.contains("retention-provider-400") {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":{"message":"retention-provider-400-body"}})),
                )
            } else if input.contains("retention-provider-502") {
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({"error":{"message":"retention-provider-502-body"}})),
                )
            } else {
                (
                    StatusCode::OK,
                    Json(json!({"id":"resp_retention","object":"response","status":"completed",
                        "model":"test","output":[{"id":"msg_retention","type":"message","role":"assistant",
                        "content":[{"type":"output_text","text":"retention-ok"}]}],
                        "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}})),
                )
            }
        }),
    )
}

async fn retention_request(client: &reqwest::Client, port: u16, input: &str) -> reqwest::Response {
    client
        .post(format!("http://127.0.0.1:{port}/v1/responses"))
        .json(&json!({"model":"peer.test","stream":false,"input":input}))
        .send()
        .await
        .unwrap()
}

fn retention_kind(request_dir: &Path) -> Option<String> {
    let marker = fs::read_to_string(request_dir.join(".retention.json")).ok()?;
    serde_json::from_str::<Value>(&marker).ok()?["kind"]
        .as_str()
        .map(str::to_string)
}

fn find_request_contains(
    samples: &Path,
    port: u16,
    file_name: &str,
    artifact_marker: &str,
) -> Option<PathBuf> {
    let port_name = port.to_string();
    request_dirs(samples).into_iter().find(|request_dir| {
        let Some(parent) = request_dir.parent() else {
            return false;
        };
        if parent.file_name().and_then(|name| name.to_str()) != Some(port_name.as_str()) {
            return false;
        }
        fs::read_to_string(request_dir.join(file_name))
            .is_ok_and(|artifact| artifact.contains(artifact_marker))
    })
}

fn assert_failed_attempt_artifact(
    request_dir: &Path,
    request_id: &str,
    provider_status: u16,
    payload_marker: &str,
) {
    assert!(request_dir.is_dir(), "failure ID disappeared: {request_id}");
    assert_eq!(retention_kind(request_dir).as_deref(), Some("failure"));
    let text = fs::read_to_string(request_dir.join("provider-failed-attempts.json")).unwrap();
    let payload: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        payload["object"],
        "routecodex.v3.provider_failed_attempt_evidence"
    );
    assert_eq!(
        payload["request_id"],
        request_dir.file_name().unwrap().to_str().unwrap()
    );
    let expected_body = json!({
        "error": { "message": format!("retention-provider-{provider_status}-body") }
    });
    let attempt = payload["attempts"]
        .as_array()
        .and_then(|attempts| {
            attempts.iter().find(|attempt| {
                attempt["provider_status"] == provider_status
                    && attempt["failed_attempt_evidence"]["provider_response"]["status"]
                        == provider_status
            })
        })
        .expect("matching failed attempt evidence");
    let body_bytes = attempt["failed_attempt_evidence"]["provider_response"]["body"]["bytes"]
        .as_array()
        .expect("provider response bytes")
        .iter()
        .map(|byte| byte.as_u64().expect("provider response byte") as u8)
        .collect::<Vec<_>>();
    assert_eq!(
        serde_json::from_slice::<Value>(&body_bytes).unwrap(),
        expected_body
    );
    assert!(fs::read_to_string(request_dir.join("request.json"))
        .unwrap()
        .contains(payload_marker));
}

fn write_floor_failure(request_dir: &Path) {
    fs::create_dir_all(request_dir).unwrap();
    let nanoseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    fs::write(
        request_dir.join(".retention.json"),
        format!(r#"{{"kind":"failure","first_persisted_unix_ns":{nanoseconds}}}"#),
    )
    .unwrap();
    fs::write(
        request_dir.join("provider-failed-attempts.json"),
        "{\"fixture\":\"in-floor\"}\n",
    )
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shared_sample_retention_parallel_cli_startup_blackbox() {
    let root = tempfile::Builder::new()
        .prefix("sr-")
        .tempdir_in("/tmp")
        .unwrap();
    let samples = root.path().join("home/.rcc/codex-samples");
    let old = samples.join("openai-responses/ports/1");
    for index in 0..500 {
        let dir = old.join(format!("old-{index:04}"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("request.json"), "{}\n").unwrap();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/v1", listener.local_addr().unwrap());
    let router = Router::new().route(
        "/v1/responses",
        post(|Json(body): Json<Value>| async move {
            assert!(body["input"].to_string().contains("retention-client-"));
            Json(
                json!({"id":"resp_retention","object":"response","status":"completed",
            "model":"test","output":[{"id":"msg_retention","type":"message","role":"assistant",
            "content":[{"type":"output_text","text":"retention-ok"}]}],
            "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}),
            )
        }),
    );
    let peer = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    // Launch every real CLI before waiting: the regression is shared filesystem
    // contention, and serializing these processes would hide it.
    let mut servers: Vec<_> = (0..6).map(|i| start(root.path(), i, &upstream)).collect();
    for server in &mut servers {
        healthy(&client, server).await;
    }
    let requests = servers.iter().enumerate().map(|(index, server)| {
        client.post(format!("http://127.0.0.1:{}/v1/responses", server.port))
            .json(&json!({"model":"peer.test","stream":false,"input":format!("retention-client-{index}")}))
            .send()
    }).collect::<Vec<_>>();
    // Join independent public requests without serializing the upstream writes.
    let tasks: Vec<_> = requests.into_iter().map(tokio::spawn).collect();
    for task in tasks {
        let response = task.await.unwrap().unwrap();
        assert!(response.status().is_success());
        assert_eq!(
            response.json::<Value>().await.unwrap()["output"][0]["content"][0]["text"],
            "retention-ok"
        );
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let dirs = request_dirs(&samples);
        let complete = (0..6).all(|index| {
            dirs.iter().any(|dir| {
                fs::read_to_string(dir.join("request.json"))
                    .ok()
                    .is_some_and(|text| text.contains(&format!("retention-client-{index}")))
            })
        });
        if complete {
            let success_dirs = dirs
                .iter()
                .filter(|dir| retention_kind(dir).as_deref() != Some("failure"))
                .count();
            if success_dirs <= 100 {
                break;
            }
        }
        assert!(
            Instant::now() < deadline,
            "public request samples were not preserved: {dirs:?}"
        );
        sleep(Duration::from_millis(25)).await;
    }
    drop(servers);
    peer.abort();
    let _ = peer.await;
}

#[tokio::test]
async fn shared_sample_retention_invalid_lock_is_explicit_blackbox() {
    let root = tempfile::Builder::new()
        .prefix("sr-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::create_dir_all(root.path().join("home/.rcc/codex-samples/.retention.lock")).unwrap();
    let mut server = start(root.path(), 0, "http://127.0.0.1:1/v1");
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(status) = server.child.try_wait().unwrap() {
            assert!(!status.success());
            let error = fs::read_to_string(&server.log).unwrap();
            assert!(
                error.contains(".retention.lock"),
                "missing file-qualified error: {error}"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "invalid sample lock was silently accepted"
        );
        sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn shared_sample_retention_floor_preserves_exact_failure_ids_beyond_success_budget() {
    let root = tempfile::Builder::new()
        .prefix("sr-floor-")
        .tempdir_in("/tmp")
        .unwrap();
    let samples = root.path().join("home/.rcc/codex-samples");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/v1", listener.local_addr().unwrap());
    let peer =
        tokio::spawn(async move { axum::serve(listener, retention_router()).await.unwrap() });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let mut server = start(root.path(), 0, &upstream);
    healthy(&client, &mut server).await;

    let response = retention_request(&client, server.port, "retention-provider-400").await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = retention_request(&client, server.port, "retention-provider-502").await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);

    let deadline = Instant::now() + Duration::from_secs(10);
    let failures = loop {
        let failure_400 = find_request_contains(
            &samples,
            server.port,
            "provider-failed-attempts.json",
            "retention-provider-400",
        );
        let failure_502 = find_request_contains(
            &samples,
            server.port,
            "provider-failed-attempts.json",
            "retention-provider-502",
        );
        if let (Some(failure_400), Some(failure_502)) = (failure_400, failure_502) {
            break (failure_400, failure_502);
        }
        assert!(
            Instant::now() < deadline,
            "provider failures were not persisted"
        );
        sleep(Duration::from_millis(25)).await;
    };
    let failure_400_id = failures
        .0
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let failure_502_id = failures
        .1
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();

    for index in 0..105 {
        let request_id = format!("retention-success-{index:03}");
        let response = retention_request(&client, server.port, &request_id).await;
        assert_eq!(response.status(), StatusCode::OK);
        let deadline = Instant::now() + Duration::from_secs(10);
        while find_request_contains(&samples, server.port, "request.json", &request_id).is_none() {
            assert!(
                Instant::now() < deadline,
                "success sample was not persisted: {request_id}"
            );
            sleep(Duration::from_millis(25)).await;
        }
    }

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let directories = request_dirs(&samples);
        let success_count = directories
            .iter()
            .filter(|directory| retention_kind(directory).as_deref() == Some("success"))
            .count();
        let latest_success = find_request_contains(
            &samples,
            server.port,
            "request.json",
            "retention-success-104",
        )
        .is_some_and(|request_dir| retention_kind(&request_dir).as_deref() == Some("success"));
        if latest_success && success_count == 100 {
            assert_failed_attempt_artifact(
                &failures.0,
                &failure_400_id,
                400,
                "retention-provider-400",
            );
            assert_failed_attempt_artifact(
                &failures.1,
                &failure_502_id,
                502,
                "retention-provider-502",
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "success retention did not settle: {success_count} success directories"
        );
        sleep(Duration::from_millis(25)).await;
    }

    drop(server);
    peer.abort();
    let _ = peer.await;
}

#[tokio::test]
async fn shared_sample_retention_saturated_failure_reserve_skips_only_diagnostic() {
    let root = tempfile::Builder::new()
        .prefix("sr-reserve-")
        .tempdir_in("/tmp")
        .unwrap();
    let samples = root.path().join("home/.rcc/codex-samples");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/v1", listener.local_addr().unwrap());
    let peer =
        tokio::spawn(async move { axum::serve(listener, retention_router()).await.unwrap() });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let mut server = start(root.path(), 0, &upstream);
    healthy(&client, &mut server).await;

    let port_root = samples
        .join("openai-responses/ports")
        .join(server.port.to_string());
    for index in 0..256 {
        write_floor_failure(&port_root.join(format!("reserve-floor-{index:03}")));
    }

    let response = retention_request(&client, server.port, "retention-provider-502").await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);

    let deadline = Instant::now() + Duration::from_secs(10);
    let overflow_request = loop {
        if let Some(request_dir) = find_request_contains(
            &samples,
            server.port,
            "request.json",
            "retention-provider-502",
        ) {
            break request_dir;
        }
        assert!(
            Instant::now() < deadline,
            "overflow request was not persisted"
        );
        sleep(Duration::from_millis(25)).await;
    };

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let log = fs::read_to_string(&server.log).unwrap();
        if log.contains("diagnostic overflow: 256-directory failure reserve full")
            && log.contains("request=openai-responses-")
            && log.contains("file=provider-failed-attempts.json")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "overflow diagnostic was not reported"
        );
        sleep(Duration::from_millis(25)).await;
    }
    assert!(!overflow_request
        .join("provider-failed-attempts.json")
        .exists());

    let floor_failures = request_dirs(&samples)
        .iter()
        .filter(|directory| retention_kind(directory).as_deref() == Some("failure"))
        .count();
    assert_eq!(floor_failures, 256);

    let response =
        retention_request(&client, server.port, "retention-success-after-overflow").await;
    assert_eq!(response.status(), StatusCode::OK);

    drop(server);
    peer.abort();
    let _ = peer.await;
}
