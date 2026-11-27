use axum::{
    body::Body, extract::State, http::HeaderMap, response::Response, routing::post, Json, Router,
};
use routecodex_v3_server::{spawn_v3_server_aggregate_with_admin, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

#[path = "fa22072_test_home.rs"]
mod test_home;
static LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

struct Upstream {
    fail_a: bool,
    calls: Mutex<Vec<(String, Value)>>,
}
async fn upstream(
    State(state): State<Arc<Upstream>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let alias = headers["authorization"]
        .to_str()
        .unwrap()
        .strip_prefix("Bearer control-fixture-")
        .unwrap();
    state.calls.lock().unwrap().push((alias.to_string(), body));
    if state.fail_a && alias == "A" {
        return Response::builder()
            .status(500)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"message":"controlled A delivery failure","type":"server_error"}})
                    .to_string(),
            ))
            .unwrap();
    }
    Json(
        json!({"id":"r-control","object":"response","status":"completed","model":"wire",
        "output":[{"id":"m-control","type":"message","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":alias,"annotations":[]}]}],
        "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}),
    )
    .into_response()
}
use axum::response::IntoResponse;

pub fn assigned_ipv4() -> Option<IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap()
}
async fn response(request: reqwest::RequestBuilder) -> Result<(u16, Value), String> {
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;
    let body = serde_json::from_str(&body).unwrap_or(Value::String(body));
    Ok((status, body))
}
async fn closed(address: SocketAddr) -> bool {
    tokio::time::timeout(Duration::from_secs(5), async {
        while tokio::net::TcpStream::connect(address).await.is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok()
}
fn read_control_bytes(paths: &routecodex_v3_config::V3ActiveKeyControlPaths) -> Option<Vec<u8>> {
    match paths.read() {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => panic!("read control record {}: {error}", paths.record.display()),
    }
}
async fn read_control_bytes_until(
    paths: &routecodex_v3_config::V3ActiveKeyControlPaths,
) -> Option<Vec<u8>> {
    match paths
        .read_until(tokio::time::Instant::now() + Duration::from_secs(2))
        .await
    {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => panic!("read control record {}: {error}", paths.record.display()),
    }
}
pub struct Fixture {
    _refill_override: RefillOverride,
    handle: Option<V3ServerAggregateHandle>,
    upstream_task: tokio::task::JoinHandle<()>,
    admin_task: tokio::task::JoinHandle<()>,
    upstream_addr: SocketAddr,
    business: SocketAddr,
    control: Option<SocketAddr>,
    admin: SocketAddr,
    token: String,
    server_id: String,
    group: String,
    record_path: PathBuf,
    record_root: PathBuf,
    config_path: PathBuf,
    manifest: routecodex_v3_config::V3Config05ManifestPublished,
    calls: Arc<Upstream>,
}
struct RefillOverride;
impl Drop for RefillOverride {
    fn drop(&mut self) {
        routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(None);
    }
}
pub enum Close {
    Shutdown,
    Drop,
    Exec,
}
impl Fixture {
    async fn start(bind: IpAddr, fail_publish: bool) -> Self {
        Self::start_with_bind_text(bind, &bind.to_string(), fail_publish).await
    }
    async fn start_with_bind_text(bind: IpAddr, bind_text: &str, fail_publish: bool) -> Self {
        Self::start_named(bind, bind_text, fail_publish, "config.toml", "selected").await
    }
    async fn start_named(
        bind: IpAddr,
        bind_text: &str,
        fail_publish: bool,
        config_name: &str,
        server_id: &str,
    ) -> Self {
        Self::start_named_with_peer(
            bind,
            bind_text,
            fail_publish,
            config_name,
            server_id,
            None,
            None,
        )
        .await
    }
    pub async fn start_named_with_peer(
        bind: IpAddr,
        bind_text: &str,
        fail_publish: bool,
        config_name: &str,
        server_id: &str,
        requested_port: Option<u16>,
        peer: Option<(&str, u16)>,
    ) -> Self {
        routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
        let refill_override = RefillOverride;
        let canonical_dir = PathBuf::from(std::env::var_os("HOME").unwrap()).join(".rcc");
        let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        let reservation =
            tokio::net::TcpListener::bind(SocketAddr::new(bind, requested_port.unwrap_or(0)))
                .await
                .unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let root = if config_name == "config.toml" {
            canonical_dir.clone()
        } else {
            canonical_dir.join(format!("authoring-{port}"))
        };
        std::fs::create_dir_all(root.join("provider/controlled")).unwrap();
        assert!(![4444, 7777].contains(&port));
        for alias in ["A", "B"] {
            std::fs::write(
                root.join(format!("{alias}.token")),
                format!("control-fixture-{alias}"),
            )
            .unwrap();
        }
        std::fs::write(
            root.join("provider/controlled/config.v2.toml"),
            format!(
                r#"version = "2.0.0"
providerId = "controlled"
[provider]
id = "controlled"
enabled = true
type = "responses"
baseURL = "http://{upstream_addr}/v1"
defaultModel = "wire"
[provider.auth]
type = "apikey"
entries = [{{alias="A",tokenFile="{}"}},{{alias="B",tokenFile="{}"}}]
[provider.models.wire]
wireName = "wire"
capabilities = ["text"]
supportsStreaming = true
"#,
                root.join("A.token").display(),
                root.join("B.token").display()
            ),
        )
        .unwrap();
        let canonical_config = canonical_dir.join(config_name);
        let config = root.join("config.toml");
        let peer_source = peer.map(|(id, port)| format!(r#"
[servers."{id}"]
bind = "{bind_text}"
port = {port}
[servers."{id}".routes.default]
selection = {{ strategy = "active_queue" }}
active_keys = {{members=[{{provider="controlled",alias="A"}},{{provider="controlled",alias="B"}}],retries=3,on_failure="hold"}}
tiers = [[{{use="controlled/wire"}}]]
"#)).unwrap_or_default();
        std::fs::write(&canonical_config,format!(r#"version = 3
[servers."{server_id}"]
bind = "{bind_text}"
port = {port}
[servers."{server_id}".routes.default]
selection = {{ strategy = "active_queue" }}
active_keys = {{members=[{{provider="controlled",alias="A"}},{{provider="controlled",alias="B"}}],retries=3,on_failure="hold"}}
tiers = [[{{use="controlled/wire"}}]]
{peer_source}
"#)).unwrap();
        if config != canonical_config && !config.exists() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(&canonical_config, &config).unwrap();
            #[cfg(windows)]
            std::os::windows::fs::symlink_file(&canonical_config, &config).unwrap();
        }
        let state = routecodex_v3_admin::AppState::new(config.clone());
        let mut manifest = state
            .store
            .validate(&state.store.read_authoring().unwrap())
            .unwrap();
        let group = manifest.servers[server_id].routing_group.clone();
        manifest.servers.retain(|id, _| id == server_id);
        let calls = Arc::new(Upstream {
            fail_a: !fail_publish,
            calls: Mutex::new(Vec::new()),
        });
        let app = Router::new()
            .route("/v1/responses", post(upstream))
            .with_state(calls.clone());
        let upstream_task =
            tokio::spawn(async move { axum::serve(upstream_listener, app).await.unwrap() });
        let paths = routecodex_v3_config::v3_active_key_control_paths(&config, server_id).unwrap();
        if fail_publish {
            paths
                .with_write(|tx| tx.publish(b"foreign endpoint record", || {}))
                .unwrap();
        }
        let handle =
            spawn_v3_server_aggregate_with_admin(manifest.clone(), None, Some(config.clone()))
                .await
                .unwrap();
        assert_eq!(
            handle.listeners.len(),
            1,
            "companion must not enter business listener list"
        );
        let actual = handle.listeners[0].addr;
        let destination_ip = if actual.ip().is_unspecified() {
            if actual.is_ipv4() {
                IpAddr::V4(Ipv4Addr::LOCALHOST)
            } else {
                "::1".parse().unwrap()
            }
        } else {
            actual.ip()
        };
        let business = SocketAddr::new(destination_ip, actual.port());
        let control = read_control_bytes_until(&paths)
            .await
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(|record| {
                record["server_id"] == server_id && record["business_addr"] == actual.to_string()
            })
            .map(|record| record["control_addr"].as_str().unwrap().parse().unwrap());
        let token = std::fs::read_to_string(root.join("state/admin-token"))
            .unwrap()
            .trim()
            .to_string();
        let admin_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let admin = admin_listener.local_addr().unwrap();
        let admin_task = tokio::spawn(async move {
            axum::serve(admin_listener, routecodex_v3_admin::router(state))
                .await
                .unwrap()
        });
        Self {
            _refill_override: refill_override,
            handle: Some(handle),
            upstream_task,
            admin_task,
            upstream_addr,
            business,
            control,
            admin,
            token,
            server_id: server_id.to_string(),
            group,
            record_path: paths.record,
            record_root: paths.root,
            config_path: config,
            manifest,
            calls,
        }
    }
    fn record_paths(&self) -> routecodex_v3_config::V3ActiveKeyControlPaths {
        routecodex_v3_config::v3_active_key_control_paths(&self.config_path, &self.server_id)
            .unwrap()
    }
    pub async fn business(&self) -> Result<(u16, Value), String> {
        response(
            client()
                .post(format!("http://{}/v1/responses", self.business))
                .header("x-session-id", "control-address-fixture")
                .json(&json!({"model":"client","input":"ordinary text"})),
        )
        .await
    }
    pub async fn status(&self) -> Result<(u16, Value), String> {
        response(client().get(format!(
            "http://{}/api/routes/active-keys?server_id={}",
            self.admin, self.server_id
        )))
        .await
    }
    pub async fn release(&self, pool: &str) -> Result<(u16, Value), String> {
        response(client().post(format!("http://{}/api/routes/active-keys/release", self.admin))
            .header("x-routecodex-admin-token", &self.token)
            .json(&json!({"server_id":self.server_id,"routing_group_id":self.group,"pool_id":pool,"provider_id":"controlled","interface_id":"default","model_id":"wire","auth_alias":"A"}))).await
    }
    async fn reload(&mut self) {
        let old_control = self.control;
        assert!(self.handle.take().unwrap().shutdown().await.is_empty());
        assert!(closed(self.business).await);
        if let Some(address) = old_control {
            assert!(closed(address).await);
        }
        assert!(read_control_bytes_until(&self.record_paths())
            .await
            .is_none());
        self.admin_task.abort();
        let _ = (&mut self.admin_task).await;
        assert!(closed(self.admin).await);
        self.handle = Some(
            spawn_v3_server_aggregate_with_admin(
                self.manifest.clone(),
                None,
                Some(self.config_path.clone()),
            )
            .await
            .unwrap(),
        );
        let record: Value = serde_json::from_slice(
            &read_control_bytes_until(&self.record_paths())
                .await
                .unwrap(),
        )
        .unwrap();
        self.control = Some(record["control_addr"].as_str().unwrap().parse().unwrap());
        let state = routecodex_v3_admin::AppState::new(self.config_path.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        self.admin = listener.local_addr().unwrap();
        self.admin_task = tokio::spawn(async move {
            axum::serve(listener, routecodex_v3_admin::router(state))
                .await
                .unwrap()
        });
    }
    pub async fn finish(mut self, how: Close) -> (bool, bool) {
        let handle = self.handle.take().unwrap();
        match how {
            Close::Shutdown => assert!(handle.shutdown().await.is_empty()),
            Close::Drop => drop(handle),
            Close::Exec => {
                let report = handle.prepare_for_exec().await;
                assert!(report.control_cleanup_failures.is_empty());
                assert!(report.codex_sample_persist_failures.is_empty());
                drop(report);
            }
        }
        self.finish_resources().await
    }
    async fn finish_resources(mut self) -> (bool, bool) {
        let record_paths = self.record_paths();
        self.admin_task.abort();
        self.upstream_task.abort();
        let _ = self.admin_task.await;
        let _ = self.upstream_task.await;
        let mut released = closed(self.business).await
            && closed(self.admin).await
            && closed(self.upstream_addr).await;
        if let Some(control) = self.control {
            released &= closed(control).await;
        }
        (
            released,
            read_control_bytes_until(&record_paths).await.is_none(),
        )
    }
}
