// feature_id: v3.admin_api_integration
// Deploy vertical 黑盒集成测试：environment 只读投影、doctor 自检、受管 restart 委派、
// 本地 admin token 准入（Host/Origin/token）。
use routecodex_v3_admin::{router, AppState};
use routecodex_v3_config_mgmt::ConfigMgmtStore;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);
/// PATH is process-global: the two restart-resolution tests must not interleave.
static PATH_LOCK: Mutex<()> = Mutex::new(());

fn temp_home(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rcc-admin-deploy-{label}-{}-{}",
        std::process::id(),
        TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).expect("temp home");
    dir
}

fn write_provider(home: &Path, provider_id: &str) {
    let provider_dir = home.join("provider").join(provider_id);
    std::fs::create_dir_all(&provider_dir).expect("provider dir");
    std::fs::write(
        provider_dir.join("config.v2.toml"),
        format!(
            r#"
version = "2.0.0"
providerId = "{provider_id}"

[provider]
id = "{provider_id}"
enabled = true
type = "openai_chat"
baseURL = "http://127.0.0.1:1/v1"
defaultModel = "m1"

[provider.auth]
type = "apikey"
apiKey = "sk-test"

[provider.models."m1"]
supportsStreaming = true
"#
        ),
    )
    .expect("provider file");
}

/// One user config with a single server on `port` (routing to the p1/m1 provider).
fn write_config(home: &Path, server_id: &str, bind: &str, port: u16) -> PathBuf {
    write_provider(home, "p1");
    let path = home.join("config.toml");
    std::fs::write(
        &path,
        format!(
            r#"version = 3

[servers.{server_id}]
bind = "{bind}"
port = {port}
[servers.{server_id}.routes.default]
tiers = [[{{ use = "p1/m1" }}]]
"#
        ),
    )
    .expect("user config");
    ConfigMgmtStore::new(&path)
        .read_authoring()
        .expect("fixture config compiles");
    path
}

struct TestServer {
    base: String,
    address: std::net::SocketAddr,
    state: AppState,
    home: PathBuf,
}

async fn bind_test_server(config_path: PathBuf, home: PathBuf) -> TestServer {
    bind_test_server_with_state(AppState::new(config_path), home).await
}

/// Same harness, but with a caller-supplied state so the "token could not be provisioned"
/// branch (`admin_token: None`) is reachable from a black-box test.
async fn bind_test_server_with_state(state: AppState, home: PathBuf) -> TestServer {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test listener");
    let address = listener.local_addr().expect("local addr");
    let base = format!("http://{address}");
    let router = router(state.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    TestServer {
        base,
        address,
        state,
        home,
    }
}

fn admin_token(home: &Path) -> String {
    std::fs::read_to_string(home.join("state").join("admin-token"))
        .expect("admin token provisioned under <config_dir>/state/admin-token")
        .trim()
        .to_string()
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| panic!("http client"))
}

/// Raw HTTP/1.1 request so the `Host` header can be forged exactly.
async fn raw_request(address: std::net::SocketAddr, request: &str) -> (u16, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("connect test server");
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut buffer = Vec::new();
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        stream.read_to_end(&mut buffer),
    )
    .await;
    let text = String::from_utf8_lossy(&buffer).to_string();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    (status, text)
}

async fn spawn_fake_health(build_version: &str) -> u16 {
    let version = build_version.to_string();
    let app = axum::Router::new().route(
        "/health",
        axum::routing::get(move || {
            let version = version.clone();
            async move {
                axum::Json(serde_json::json!({
                    "status": "ok",
                    "version": 3,
                    "build_version": version,
                    "manifest_version": 1,
                    "server_id": "fake",
                    "bind": "127.0.0.1",
                    "port": 0,
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake health listener");
    let port = listener.local_addr().expect("fake health addr").port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    port
}

fn doctor_item<'a>(report: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
    report
        .get("items")
        .and_then(|items| items.as_array())
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(|value| value.as_str()) == Some(id))
        })
        .unwrap_or_else(|| panic!("doctor item {id} missing in {report}"))
}

// ---------------------------------------------------------------------------
// Environment projection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn environment_returns_served_config_path() {
    let home = temp_home("environment");
    let port = spawn_fake_health("whatever").await;
    let config_path = write_config(&home, "routecodex_v3_env", "127.0.0.1", port);
    let server = bind_test_server(config_path.clone(), home).await;

    let response = http_client()
        .get(format!("{}/api/environment", server.base))
        .send()
        .await
        .expect("environment response");
    assert!(response.status().is_success());
    let body: serde_json::Value = response.json().await.expect("environment json");

    assert_eq!(
        body["config"]["path"].as_str(),
        Some(config_path.display().to_string().as_str()),
        "environment must project the served config path"
    );
    assert!(
        body["config"]["error"].is_null(),
        "fixture config must compile: {body}"
    );
    assert_eq!(body["config"]["server_count"].as_u64(), Some(1));
    assert_eq!(body["config"]["provider_count"].as_u64(), Some(1));
    assert!(
        body["config"]["sha256"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64),
        "config sha256 must be projected: {body}"
    );
    let binary_path = body["binary"]["path"].as_str().unwrap_or_default();
    assert!(
        Path::new(binary_path).is_absolute(),
        "installed binary path must be absolute: {binary_path}"
    );
    assert!(
        body["binary"]["sha256"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64),
        "installed binary sha256 must be projected: {body}"
    );
    assert!(
        body["binary"]["version"].as_str().is_some(),
        "installed binary version must be projected from the build truth: {body}"
    );
    assert_eq!(body["admin"]["port"].as_u64(), Some(8777));
    let listeners = body["listeners"].as_array().expect("listeners array");
    assert_eq!(listeners.len(), 1);
    assert_eq!(listeners[0]["port"].as_u64(), Some(port as u64));
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

#[tokio::test]
async fn doctor_fails_on_constructed_build_version_drift() {
    let home = temp_home("doctor-drift");
    let port = spawn_fake_health("0.0.0-drift").await;
    let config_path = write_config(&home, "routecodex_v3_drift", "127.0.0.1", port);
    let server = bind_test_server(config_path, home).await;

    let response = http_client()
        .post(format!("{}/api/environment/doctor", server.base))
        .header("x-routecodex-admin-token", admin_token(&server.home))
        .send()
        .await
        .expect("doctor response");
    assert!(response.status().is_success());
    let report: serde_json::Value = response.json().await.expect("doctor json");

    let item = doctor_item(&report, "listener.routecodex_v3_drift.build_version");
    assert_eq!(
        item["status"].as_str(),
        Some("fail"),
        "drifted build_version must fail: {report}"
    );
    assert!(
        item["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("0.0.0-drift")),
        "drift detail must name the observed build_version: {item}"
    );
    assert_eq!(report["status"].as_str(), Some("fail"));
}

#[tokio::test]
async fn doctor_fails_on_constructed_admin_port_conflict() {
    let home = temp_home("doctor-port");
    // 0.0.0.0:8777 passes the config compile (the admin listener is 127.0.0.1:8777, a
    // different bind:port string) yet collides on the port; doctor must catch it.
    let config_path = write_config(&home, "routecodex_v3_conflict", "0.0.0.0", 8777);
    let server = bind_test_server(config_path, home).await;

    let response = http_client()
        .post(format!("{}/api/environment/doctor", server.base))
        .header("x-routecodex-admin-token", admin_token(&server.home))
        .send()
        .await
        .expect("doctor response");
    assert!(response.status().is_success());
    let report: serde_json::Value = response.json().await.expect("doctor json");

    assert!(
        report["items"].as_array().is_some_and(|items| items
            .iter()
            .all(|item| item["id"] != "config.compile" || item["status"] == "pass")),
        "the conflicting config must still compile so the port check is the signal: {report}"
    );
    let item = doctor_item(&report, "admin.port_conflict");
    assert_eq!(
        item["status"].as_str(),
        Some("fail"),
        "admin port collision must fail: {report}"
    );
    assert!(
        item["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("routecodex_v3_conflict")),
        "conflict detail must name the colliding server: {item}"
    );
}

#[tokio::test]
async fn doctor_reports_provisioned_admin_token() {
    let home = temp_home("doctor-token");
    let port = spawn_fake_health("whatever").await;
    let config_path = write_config(&home, "routecodex_v3_token", "127.0.0.1", port);
    let server = bind_test_server(config_path, home).await;

    let response = http_client()
        .post(format!("{}/api/environment/doctor", server.base))
        .header("x-routecodex-admin-token", admin_token(&server.home))
        .send()
        .await
        .expect("doctor response");
    let report: serde_json::Value = response.json().await.expect("doctor json");
    assert_eq!(
        doctor_item(&report, "admin.token")["status"].as_str(),
        Some("pass")
    );
    let token_path = server.home.join("state").join("admin-token");
    assert!(token_path.is_file(), "token file must exist");
    let mode = std::fs::metadata(&token_path)
        .expect("token metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "token file must be 0600");
}

// ---------------------------------------------------------------------------
// Runtime restart delegation
// ---------------------------------------------------------------------------

struct PathGuard {
    previous: Option<std::ffi::OsString>,
}

impl PathGuard {
    fn set(dir: &Path) -> Self {
        let previous = std::env::var_os("PATH");
        std::env::set_var("PATH", dir.as_os_str());
        Self { previous }
    }
}

impl Drop for PathGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }
    }
}

fn write_fake_cli(dir: &Path, args_record: &Path) -> PathBuf {
    let cli = dir.join("rccv3");
    std::fs::write(
        &cli,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\necho \"fake-rccv3 $@\"\nexit 0\n",
            args_record.display()
        ),
    )
    .expect("fake cli");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).expect("chmod cli");
    }
    cli
}

#[tokio::test]
async fn restart_reports_missing_executable_explicitly() {
    let _path_lock = PATH_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let home = temp_home("restart-missing");
    let port = spawn_fake_health("whatever").await;
    let config_path = write_config(&home, "routecodex_v3_missing", "127.0.0.1", port);
    let server = bind_test_server(config_path, home).await;

    let empty_path_dir = temp_home("restart-empty-path");
    let _path_guard = PathGuard::set(&empty_path_dir);
    let response = http_client()
        .post(format!("{}/api/runtime/restart", server.base))
        .header("x-routecodex-admin-token", admin_token(&server.home))
        .send()
        .await
        .expect("restart response");
    let status = response.status();
    let body: serde_json::Value = response.json().await.expect("restart json");
    assert!(
        status.is_success(),
        "restart must return the structured result, got {status}: {body}"
    );
    assert_eq!(
        body["ok"].as_bool(),
        Some(false),
        "a missing lifecycle CLI must never report success: {body}"
    );
    assert!(
        body["executable"].is_null(),
        "no executable was resolved: {body}"
    );
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|error| error.contains("was not found")),
        "missing executable must be reported explicitly: {body}"
    );
    assert!(body["exit_code"].is_null(), "no command ran: {body}");
}

#[tokio::test]
async fn restart_runs_resolved_cli_for_served_config() {
    let _path_lock = PATH_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let home = temp_home("restart-run");
    let port = spawn_fake_health("whatever").await;
    let config_path = write_config(&home, "routecodex_v3_restart", "127.0.0.1", port);
    let server = bind_test_server(config_path.clone(), home).await;

    let cli_dir = temp_home("restart-cli");
    let args_record = cli_dir.join("args.txt");
    let cli = write_fake_cli(&cli_dir, &args_record);
    let _path_guard = PathGuard::set(&cli_dir);

    let response = http_client()
        .post(format!("{}/api/runtime/restart", server.base))
        .header("x-routecodex-admin-token", admin_token(&server.home))
        .send()
        .await
        .expect("restart response");
    assert!(response.status().is_success());
    let body: serde_json::Value = response.json().await.expect("restart json");
    assert_eq!(body["ok"].as_bool(), Some(true), "restart body: {body}");
    assert_eq!(body["exit_code"].as_i64(), Some(0));
    assert_eq!(
        body["executable"].as_str(),
        Some(cli.display().to_string().as_str())
    );
    let stdout = body["stdout_tail"].as_str().unwrap_or_default();
    assert!(
        stdout.contains("fake-rccv3"),
        "raw stdout tail must be returned: {body}"
    );
    let recorded = std::fs::read_to_string(&args_record).expect("recorded args");
    let args: Vec<&str> = recorded.lines().collect();
    assert_eq!(args.first().copied(), Some("restart"));
    assert_eq!(args.get(1).copied(), Some("-c"));
    assert_eq!(
        args.get(2).copied(),
        Some(config_path.display().to_string().as_str()),
        "restart must target the served config path"
    );
}

/// `POST /api/reload` must restart the runtime for the SERVED config path
/// (`rccv3 restart -c <config>`), not the default-config instance.
#[tokio::test]
async fn reload_runs_resolved_cli_with_served_config_path() {
    let _path_lock = PATH_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let home = temp_home("reload-run");
    let port = spawn_fake_health("whatever").await;
    let config_path = write_config(&home, "routecodex_v3_reload", "127.0.0.1", port);
    let server = bind_test_server(config_path.clone(), home).await;

    let cli_dir = temp_home("reload-cli");
    let args_record = cli_dir.join("args.txt");
    write_fake_cli(&cli_dir, &args_record);
    let _path_guard = PathGuard::set(&cli_dir);

    let response = http_client()
        .post(format!("{}/api/reload", server.base))
        .header("x-routecodex-admin-token", admin_token(&server.home))
        .send()
        .await
        .expect("reload response");
    let status = response.status();
    let body: serde_json::Value = response.json().await.expect("reload json");
    assert!(
        status.is_success(),
        "reload must succeed with the resolved lifecycle CLI, got {status}: {body}"
    );
    assert_eq!(body["ok"].as_bool(), Some(true), "reload body: {body}");

    let recorded = std::fs::read_to_string(&args_record).expect("recorded args");
    let args: Vec<&str> = recorded.lines().collect();
    assert_eq!(args.first().copied(), Some("restart"));
    assert_eq!(args.get(1).copied(), Some("-c"));
    assert_eq!(
        args.get(2).copied(),
        Some(config_path.display().to_string().as_str()),
        "reload must restart the served config path, not the default config"
    );
    assert!(
        body["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains(&config_path.display().to_string())),
        "the reload detail must name the served config path: {body}"
    );
}

// ---------------------------------------------------------------------------
// Local admin token admission
// ---------------------------------------------------------------------------
#[tokio::test]
async fn mutating_request_without_token_is_rejected() {
    let home = temp_home("token-missing");
    let port = spawn_fake_health("whatever").await;
    let config_path = write_config(&home, "routecodex_v3_noauth", "127.0.0.1", port);
    let server = bind_test_server(config_path, home).await;

    // A01: the gate is method-based, not path-based — POST, PUT and DELETE each require the
    // header, and `POST /api/environment/doctor` is a read-shaped operation that is still a
    // POST and therefore still gated.
    for (method, path) in [
        ("POST", "/api/runtime/restart"),
        ("POST", "/api/environment/doctor"),
        ("PUT", "/api/routes"),
        ("DELETE", "/api/providers/p1"),
    ] {
        let response = http_client()
            .request(
                reqwest::Method::from_bytes(method.as_bytes()).expect("http method"),
                format!("{}{path}", server.base),
            )
            .send()
            .await
            .expect("token-less mutating response");
        assert_eq!(
            response.status().as_u16(),
            401,
            "{method} {path} without the admin token must be 401, got {}",
            response.status()
        );
    }

    let wrong_token = http_client()
        .post(format!("{}/api/runtime/restart", server.base))
        .header("x-routecodex-admin-token", "not-the-token")
        .send()
        .await
        .expect("wrong-token response");
    assert!(
        matches!(wrong_token.status().as_u16(), 401 | 403),
        "a wrong admin token must be rejected, got {}",
        wrong_token.status()
    );
}

/// The same methods pass the gate once the correct token is present. The handlers may still
/// reject the request on its own merits; only the auth gate is asserted here.
#[tokio::test]
async fn every_mutating_method_passes_the_gate_with_the_token() {
    let home = temp_home("methods-token");
    let port = spawn_fake_health("whatever").await;
    let config_path = write_config(&home, "routecodex_v3_methods", "127.0.0.1", port);
    let server = bind_test_server(config_path, home).await;
    let token = admin_token(&server.home);

    for (method, path) in [
        ("POST", "/api/environment/doctor"),
        ("PUT", "/api/routes"),
        ("DELETE", "/api/providers/p1"),
    ] {
        let response = http_client()
            .request(
                reqwest::Method::from_bytes(method.as_bytes()).expect("http method"),
                format!("{}{path}", server.base),
            )
            .header("x-routecodex-admin-token", &token)
            .send()
            .await
            .expect("token-bearing mutating response");
        assert!(
            !matches!(response.status().as_u16(), 401 | 403 | 503),
            "{method} {path} with the admin token must pass the auth gate, got {}",
            response.status()
        );
    }
}

/// When the local admin token could not be provisioned the deployment must fail closed:
/// read-only projections stay reachable, `/api/admin/session` refuses to hand out a token,
/// and every mutating endpoint answers 503 instead of running unauthenticated.
#[tokio::test]
async fn unavailable_admin_token_fails_closed_with_503() {
    let home = temp_home("token-unavailable");
    let port = spawn_fake_health("whatever").await;
    let config_path = write_config(&home, "routecodex_v3_tokenless", "127.0.0.1", port);
    let state = AppState {
        store: ConfigMgmtStore::new(&config_path),
        patrol: std::sync::Arc::new(routecodex_v3_admin::provider_patrol::PatrolRuntime::new(
            config_path.clone(),
        )),
        config_path,
        admin_token: None,
        started_at_epoch_ms: 0,
    };
    let server = bind_test_server_with_state(state, home).await;

    let environment = http_client()
        .get(format!("{}/api/environment", server.base))
        .send()
        .await
        .expect("environment response");
    assert!(
        environment.status().is_success(),
        "read-only projections stay reachable without a token, got {}",
        environment.status()
    );

    let session = http_client()
        .get(format!("{}/api/admin/session", server.base))
        .send()
        .await
        .expect("session response");
    assert_eq!(
        session.status().as_u16(),
        503,
        "session must not hand out a token that was never provisioned"
    );
    let session: serde_json::Value = session.json().await.expect("session json");
    assert_eq!(
        session["error_code"].as_str(),
        Some("admin_token_unavailable"),
        "explicit failure code: {session}"
    );

    for path in ["/api/runtime/restart", "/api/environment/doctor"] {
        let response = http_client()
            .post(format!("{}{path}", server.base))
            .header("x-routecodex-admin-token", "any-token")
            .send()
            .await
            .expect("fail-closed response");
        assert_eq!(
            response.status().as_u16(),
            503,
            "{path} must fail closed when no token exists, got {}",
            response.status()
        );
        let body: serde_json::Value = response.json().await.expect("fail-closed json");
        assert_eq!(
            body["error_code"].as_str(),
            Some("admin_token_unavailable"),
            "explicit failure code for {path}: {body}"
        );
    }
}

#[tokio::test]
async fn mutating_request_with_token_succeeds() {
    let home = temp_home("token-ok");
    let port = spawn_fake_health("whatever").await;
    let config_path = write_config(&home, "routecodex_v3_auth", "127.0.0.1", port);
    let server = bind_test_server(config_path, home).await;

    let session = http_client()
        .get(format!("{}/api/admin/session", server.base))
        .send()
        .await
        .expect("session response");
    assert!(session.status().is_success());
    let session: serde_json::Value = session.json().await.expect("session json");
    let token = session["token"]
        .as_str()
        .expect("session token")
        .to_string();
    assert_eq!(token, admin_token(&server.home));
    assert_eq!(server.state.admin_token.as_deref(), Some(token.as_str()));

    let response = http_client()
        .post(format!("{}/api/environment/doctor", server.base))
        .header("x-routecodex-admin-token", &token)
        .send()
        .await
        .expect("authorized doctor response");
    assert!(
        response.status().is_success(),
        "the same mutating request with the token must succeed, got {}",
        response.status()
    );
    let report: serde_json::Value = response.json().await.expect("doctor json");
    assert!(report["items"]
        .as_array()
        .is_some_and(|items| !items.is_empty()));
}

#[tokio::test]
async fn non_loopback_host_is_rejected_for_every_method() {
    let home = temp_home("host-check");
    let port = spawn_fake_health("whatever").await;
    let config_path = write_config(&home, "routecodex_v3_host", "127.0.0.1", port);
    let server = bind_test_server(config_path, home).await;
    let token = admin_token(&server.home);

    // A01: `Host: evil.test` is rejected on every method, even with a valid token present.
    for (method, path, body) in [
        ("GET", "/api/environment", ""),
        ("POST", "/api/runtime/restart", "Content-Length: 0\r\n"),
        ("PUT", "/api/routes", "Content-Length: 0\r\n"),
        ("DELETE", "/api/providers/p1", ""),
    ] {
        let (status, response) = raw_request(
            server.address,
            &format!(
                "{method} {path} HTTP/1.1\r\nHost: evil.test\r\nx-routecodex-admin-token: {token}\r\n{body}Connection: close\r\n\r\n"
            ),
        )
        .await;
        assert_eq!(
            status, 403,
            "non-loopback Host on {method} {path} must be 403: {response}"
        );
    }

    // A01: a cross-site Origin is rejected on a loopback Host for read and mutating methods.
    for (method, path) in [("GET", "/api/environment"), ("DELETE", "/api/providers/p1")] {
        let (status, response) = raw_request(
            server.address,
            &format!(
                "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: http://evil.test\r\nx-routecodex-admin-token: {token}\r\nConnection: close\r\n\r\n",
                server.address.port()
            ),
        )
        .await;
        assert_eq!(
            status, 403,
            "cross-site Origin on {method} {path} must be 403: {response}"
        );
    }
}

#[test]
fn lifecycle_executable_resolution_reports_missing() {
    let dir = temp_home("resolve-missing");
    assert!(
        routecodex_v3_admin::api::deploy::resolve_lifecycle_executable_in(
            Some(&dir),
            Some(std::ffi::OsStr::new(""))
        )
        .is_none(),
        "an empty sibling dir and an empty PATH must resolve to no executable"
    );
    let cli = dir.join("rccv3");
    std::fs::write(&cli, "#!/bin/sh\nexit 0\n").expect("cli");
    assert_eq!(
        routecodex_v3_admin::api::deploy::resolve_lifecycle_executable_in(Some(&dir), None),
        Some(cli)
    );
}
