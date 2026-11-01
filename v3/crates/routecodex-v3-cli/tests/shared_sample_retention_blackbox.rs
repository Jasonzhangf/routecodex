use axum::{routing::post, Json, Router};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
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
            assert!(
                dirs.len() <= 100,
                "global sample retention exceeded: {}",
                dirs.len()
            );
            break;
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
