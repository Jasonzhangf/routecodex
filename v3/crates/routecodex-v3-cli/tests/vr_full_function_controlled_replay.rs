use axum::{
    body::Body,
    extract::State,
    http::{Response, StatusCode},
    routing::post,
    Router,
};
use reqwest::StatusCode as ReqwestStatusCode;
use serde_json::{json, Value};
use std::{
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{mpsc, oneshot},
    time::{sleep, timeout},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

#[derive(Debug, Clone)]
struct ProviderCapture {
    body: Value,
}

#[derive(Debug, Clone)]
enum ProviderMode {
    Success,
    Failure,
}

#[derive(Clone)]
struct ProviderState {
    mode: ProviderMode,
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

struct ControlledUpstream {
    base_url: String,
    captures: mpsc::UnboundedReceiver<ProviderCapture>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl Drop for ControlledUpstream {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

struct CliProcess {
    child: Child,
}

impl Drop for CliProcess {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[tokio::test]
async fn cli_replay_proves_pool_match_default_floor_and_total_exhaustion() {
    let mut success = start_controlled_upstream(ProviderMode::Success).await;
    let mut failure_a = start_controlled_upstream(ProviderMode::Failure).await;
    let mut failure_b = start_controlled_upstream(ProviderMode::Failure).await;
    let success_port = free_port();
    let exhausted_port = free_port();
    let config_path = write_config(
        success_port,
        exhausted_port,
        &success,
        &failure_a,
        &failure_b,
    );

    let client = reqwest::Client::new();
    let mut cli = start_cli(&config_path);
    wait_for_health(&client, &mut cli, success_port, "vr_success").await;
    wait_for_health(&client, &mut cli, exhausted_port, "vr_exhausted").await;

    let default_response = client
        .post(format!("http://127.0.0.1:{success_port}/v1/responses"))
        .json(&json!({"model":"gpt-5.5","input":"default route"}))
        .send()
        .await
        .unwrap();
    assert_eq!(default_response.status(), ReqwestStatusCode::OK);
    assert_eq!(
        default_response.json::<Value>().await.unwrap(),
        json!({"id":"vr_success","output_text":"ok"})
    );
    let default_capture = next_capture(&mut success.captures, "default success").await;
    assert_eq!(default_capture.body["model"], "wire-default");
    assert_no_route_controls(&default_capture.body);
    assert_no_capture(&mut failure_a.captures, "no-match optional");

    let matched_response = client
        .post(format!("http://127.0.0.1:{success_port}/v1/responses"))
        .json(&json!({
            "model":"client-tools",
            "input":"matched optional",
            "tools":[{"type":"function","name":"run","parameters":{"type":"object"}}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(matched_response.status(), ReqwestStatusCode::OK);
    let optional_capture = next_capture(&mut failure_a.captures, "optional failure").await;
    assert_eq!(optional_capture.body["model"], "wire-optional");
    assert_no_route_controls(&optional_capture.body);
    let floor_capture = next_capture(&mut success.captures, "captured default floor").await;
    assert_eq!(floor_capture.body["model"], "wire-default");
    assert_no_route_controls(&floor_capture.body);

    let exhausted_response = client
        .post(format!("http://127.0.0.1:{exhausted_port}/v1/responses"))
        .json(&json!({
            "model":"client-tools",
            "input":"exhaust complete plan",
            "tools":[{"type":"function","name":"run","parameters":{"type":"object"}}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(exhausted_response.status(), ReqwestStatusCode::BAD_GATEWAY);
    let exhausted_body = exhausted_response.json::<Value>().await.unwrap();
    assert_eq!(exhausted_body["error"]["code"], "network_error");
    assert_eq!(exhausted_body["error"]["message"], "network error");
    let exhausted_optional = next_capture(&mut failure_a.captures, "exhaust optional").await;
    assert_eq!(exhausted_optional.body["model"], "wire-optional");
    let exhausted_default = next_capture(&mut failure_b.captures, "exhaust default").await;
    assert_eq!(exhausted_default.body["model"], "wire-exhausted");

    drop(cli);
    wait_ports_closed(&client, &[success_port, exhausted_port]).await;
    remove_owned_temp_dir(&config_path);
}

#[tokio::test]
async fn cli_replay_proves_optional_tier_success_never_touches_default_pool() {
    let mut optional = start_controlled_upstream(ProviderMode::Success).await;
    let mut default_failure = start_controlled_upstream(ProviderMode::Failure).await;
    let mut other_failure = start_controlled_upstream(ProviderMode::Failure).await;
    let optional_port = free_port();
    let default_port = free_port();
    let config_path = write_optional_success_config(
        optional_port,
        default_port,
        &optional,
        &default_failure,
        &other_failure,
    );

    let client = reqwest::Client::new();
    let mut cli = start_cli(&config_path);
    wait_for_health(&client, &mut cli, optional_port, "vr_optional_success").await;
    wait_for_health(&client, &mut cli, default_port, "vr_default_failure").await;

    let response = client
        .post(format!("http://127.0.0.1:{optional_port}/v1/responses"))
        .json(&json!({
            "model": "client-tools",
            "input": "optional tier success",
            "tools": [
                {"type": "function", "name": "run", "parameters": {"type": "object"}}
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), ReqwestStatusCode::OK);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"id": "vr_success", "output_text": "ok"})
    );

    let optional_capture = next_capture(&mut optional.captures, "optional success").await;
    assert_eq!(optional_capture.body["model"], "wire-optional");
    assert_eq!(optional_capture.body["input"], "optional tier success");
    assert!(optional_capture.body["tools"].is_array());
    assert_no_route_controls(&optional_capture.body);
    assert_no_capture(
        &mut default_failure.captures,
        "default tier untouched when optional tier succeeds",
    );
    assert_no_capture(
        &mut other_failure.captures,
        "other low tier upstream untouched",
    );

    drop(cli);
    wait_ports_closed(&client, &[optional_port, default_port]).await;
    remove_owned_temp_dir(&config_path);
}

async fn upstream_handler(State(state): State<Arc<ProviderState>>, body: String) -> Response<Body> {
    let parsed = serde_json::from_str::<Value>(&body).unwrap();
    state
        .captures
        .send(ProviderCapture { body: parsed })
        .unwrap();
    match &state.mode {
        ProviderMode::Success => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(r#"{"id":"vr_success","output_text":"ok"}"#))
            .unwrap(),
        ProviderMode::Failure => Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from(r#"{"error":"controlled_failure"}"#))
            .unwrap(),
    }
}

async fn start_controlled_upstream(mode: ProviderMode) -> ControlledUpstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(upstream_handler))
        .with_state(Arc::new(ProviderState {
            mode,
            captures: captures_tx,
        }));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    ControlledUpstream {
        base_url: format!("http://{address}/v1"),
        captures: captures_rx,
        shutdown: Some(shutdown_tx),
    }
}

fn config_root(tag: &str) -> PathBuf {
    let root = PathBuf::from("/tmp").join(format!("rcc-vr-{tag}-{}", std::process::id()));
    let run_dir = root.join(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .to_string(),
    );
    fs::create_dir_all(&run_dir).unwrap();
    run_dir
}

fn remove_owned_temp_dir(config_path: &Path) {
    if let Some(root) = config_path.parent().and_then(Path::parent) {
        if root.parent() == Some(Path::new("/tmp"))
            && root
                .file_name()
                .map(|name| name.to_string_lossy().starts_with("rcc-vr-"))
                .unwrap_or(false)
        {
            fs::remove_dir_all(root).unwrap();
        }
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn write_config(
    success_port: u16,
    exhausted_port: u16,
    success: &ControlledUpstream,
    failure_a: &ControlledUpstream,
    failure_b: &ControlledUpstream,
) -> PathBuf {
    let path = config_root("main").join("config.vr.toml");
    fs::write(
        &path,
        format!(
            r#"
version = 3

{hub_v1_declaration}

[servers.vr_success]
bind = "127.0.0.1"
port = {success_port}
routing_group = "vr_success"
endpoints = ["responses"]

{success_execution}

[servers.vr_exhausted]
bind = "127.0.0.1"
port = {exhausted_port}
routing_group = "vr_exhausted"
endpoints = ["responses"]

{exhausted_execution}

[providers.optional]
type = "responses"
base_url = "{failure_a_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "VR_OPTIONAL_KEY" }}] }}
[providers.optional.models.test]
wire_name = "wire-optional"
capabilities = ["text", "tools"]

[providers.exhaust_optional]
type = "responses"
base_url = "{failure_a_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "VR_OPTIONAL_KEY" }}] }}
[providers.exhaust_optional.models.test]
wire_name = "wire-optional"
capabilities = ["text", "tools"]

[providers.default]
type = "responses"
base_url = "{success_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "VR_DEFAULT_KEY" }}] }}
[providers.default.models.test]
wire_name = "wire-default"
capabilities = ["text", "tools"]

[providers.exhausted]
type = "responses"
base_url = "{failure_b_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "VR_EXHAUSTED_KEY" }}] }}
[providers.exhausted.models.test]
wire_name = "wire-exhausted"
capabilities = ["text", "tools"]

[route_groups.vr_success.pools.tools]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-tools"], required_capabilities = ["tools"], min_input_tokens = 1, max_input_tokens = 100 }}
targets = [{{ kind = "provider_model", provider = "optional", model = "test", key = "key", priority = 1 }}]
[route_groups.vr_success.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "default", model = "test", key = "key", priority = 1 }}]

[route_groups.vr_exhausted.pools.tools]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-tools"], required_capabilities = ["tools"], min_input_tokens = 1, max_input_tokens = 100 }}
targets = [{{ kind = "provider_model", provider = "exhaust_optional", model = "test", key = "key", priority = 1 }}]
[route_groups.vr_exhausted.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "exhausted", model = "test", key = "key", priority = 1 }}]
"#,
            success_base = success.base_url,
            failure_a_base = failure_a.base_url,
            failure_b_base = failure_b.base_url,
            hub_v1_declaration = hub_v1_test_declaration(),
            success_execution = hub_v1_server_execution("vr_success"),
            exhausted_execution = hub_v1_server_execution("vr_exhausted"),
        ),
    )
    .unwrap();
    path
}

fn write_optional_success_config(
    optional_success_port: u16,
    default_failure_port: u16,
    optional: &ControlledUpstream,
    default_failure: &ControlledUpstream,
    other_failure: &ControlledUpstream,
) -> PathBuf {
    let path = config_root("opt").join("config.vr.toml");
    fs::write(
        &path,
        format!(
            r#"
version = 3

{hub_v1_declaration}

[servers.vr_optional_success]
bind = "127.0.0.1"
port = {optional_success_port}
routing_group = "vr_optional_success"
endpoints = ["responses"]

{optional_success_execution}

[servers.vr_default_failure]
bind = "127.0.0.1"
port = {default_failure_port}
routing_group = "vr_default_failure"
endpoints = ["responses"]

{default_failure_execution}

[providers.optional]
type = "responses"
base_url = "{optional_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "VR_OPTIONAL_KEY" }}] }}
[providers.optional.models.test]
wire_name = "wire-optional"
capabilities = ["text", "tools"]

[providers.default]
type = "responses"
base_url = "{default_failure_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "VR_DEFAULT_KEY" }}] }}
[providers.default.models.test]
wire_name = "wire-default"
capabilities = ["text", "tools"]

[providers.other]
type = "responses"
base_url = "{other_failure_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "VR_EXHAUSTED_KEY" }}] }}
[providers.other.models.test]
wire_name = "wire-other"
capabilities = ["text", "tools"]

[route_groups.vr_optional_success.pools.tools]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-tools"], required_capabilities = ["tools"], min_input_tokens = 1, max_input_tokens = 100 }}
targets = [{{ kind = "provider_model", provider = "optional", model = "test", key = "key", priority = 1 }}]
[route_groups.vr_optional_success.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "default", model = "test", key = "key", priority = 1 }}]

[route_groups.vr_default_failure.pools.tools]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-tools"], required_capabilities = ["tools"], min_input_tokens = 1, max_input_tokens = 100 }}
targets = [{{ kind = "provider_model", provider = "other", model = "test", key = "key", priority = 1 }}]
[route_groups.vr_default_failure.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "default", model = "test", key = "key", priority = 1 }}]
"#,
            optional_base = optional.base_url,
            default_failure_base = default_failure.base_url,
            other_failure_base = other_failure.base_url,
            hub_v1_declaration = hub_v1_test_declaration(),
            optional_success_execution = hub_v1_server_execution("vr_optional_success"),
            default_failure_execution = hub_v1_server_execution("vr_default_failure"),
        ),
    )
    .unwrap();
    path
}

fn start_cli(config_path: &Path) -> CliProcess {
    let temp_dir = config_path
        .parent()
        .expect("config path has parent")
        .join("cli-temp");
    fs::create_dir_all(&temp_dir).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .args(["server", "start", "--foreground", "--config"])
        .arg(config_path)
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .env("VR_OPTIONAL_KEY", "optional-secret")
        .env("VR_DEFAULT_KEY", "default-secret")
        .env("VR_EXHAUSTED_KEY", "exhausted-secret")
        .env("TMPDIR", &temp_dir)
        .env("TMP", &temp_dir)
        .env("TEMP", &temp_dir)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    CliProcess { child }
}

async fn wait_for_health(
    client: &reqwest::Client,
    cli: &mut CliProcess,
    port: u16,
    server_id: &str,
) {
    for _ in 0..400 {
        assert!(cli.child.try_wait().unwrap().is_none(), "CLI exited early");
        if let Ok(response) = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .await
        {
            if response.status() == ReqwestStatusCode::OK {
                let body = response.json::<Value>().await.unwrap();
                assert_eq!(body["server_id"], server_id);
                return;
            }
        }
        sleep(Duration::from_millis(25)).await;
    }
    panic!("health did not become ready on {port}");
}

async fn next_capture(
    captures: &mut mpsc::UnboundedReceiver<ProviderCapture>,
    label: &str,
) -> ProviderCapture {
    timeout(Duration::from_secs(2), captures.recv())
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {label}"))
        .unwrap()
}

fn assert_no_capture(captures: &mut mpsc::UnboundedReceiver<ProviderCapture>, label: &str) {
    assert!(
        captures.try_recv().is_err(),
        "unexpected capture for {label}"
    );
}

fn assert_no_route_controls(body: &Value) {
    let serialized = serde_json::to_string(body).unwrap();
    for forbidden in [
        "routing_group_id",
        "pool_id",
        "target_plan",
        "router_hit_count",
        "V3Router",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
}

async fn wait_ports_closed(client: &reqwest::Client, ports: &[u16]) {
    for _ in 0..80 {
        let mut open = false;
        for port in ports {
            if client
                .get(format!("http://127.0.0.1:{port}/health"))
                .send()
                .await
                .is_ok()
            {
                open = true;
            }
        }
        if !open {
            return;
        }
        sleep(Duration::from_millis(25)).await;
    }
    panic!("V3 CLI ports remained open after exact child shutdown");
}
