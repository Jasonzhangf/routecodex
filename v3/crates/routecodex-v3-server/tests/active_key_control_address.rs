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

#[path = "support/fa22072_test_home.rs"]
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

fn assigned_ipv4() -> Option<IpAddr> {
    // UDP connect selects a local route without sending a datagram.
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
struct Fixture {
    _refill_override: RefillOverride,
    handle: Option<V3ServerAggregateHandle>,
    upstream_task: tokio::task::JoinHandle<()>,
    admin_task: tokio::task::JoinHandle<()>,
    upstream_addr: SocketAddr,
    business: SocketAddr,
    control: Option<SocketAddr>,
    admin: SocketAddr,
    token: String,
    group: String,
    record_path: PathBuf,
    calls: Arc<Upstream>,
}
struct RefillOverride;
impl Drop for RefillOverride {
    fn drop(&mut self) {
        routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(None);
    }
}
enum Close {
    Shutdown,
    Drop,
    Exec,
}
impl Fixture {
    async fn start(bind: IpAddr, fail_publish: bool) -> Self {
        // This suite measures selection controls. Bounded refill has separate
        // public coverage and otherwise adds a declared second provider call.
        routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
        let refill_override = RefillOverride;
        let root = PathBuf::from(std::env::var_os("HOME").unwrap()).join(".rcc");
        std::fs::create_dir_all(root.join("provider/controlled")).unwrap();
        let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        let reservation = tokio::net::TcpListener::bind(SocketAddr::new(bind, 0))
            .await
            .unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
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
        let config = root.join("config.toml");
        std::fs::write(&config,format!(r#"version = 3
[servers.selected]
bind = "{bind}"
port = {port}
[servers.selected.routes.default]
selection = {{ strategy = "active_queue" }}
active_keys = {{members=[{{provider="controlled",alias="A"}},{{provider="controlled",alias="B"}}],retries=3,on_failure="hold"}}
tiers = [[{{use="controlled/wire"}}]]
"#)).unwrap();
        let state = routecodex_v3_admin::AppState::new(config.clone());
        let manifest = state
            .store
            .validate(&state.store.read_authoring().unwrap())
            .unwrap();
        let group = manifest.servers["selected"].routing_group.clone();
        let calls = Arc::new(Upstream {
            fail_a: !fail_publish,
            calls: Mutex::new(Vec::new()),
        });
        let app = Router::new()
            .route("/v1/responses", post(upstream))
            .with_state(calls.clone());
        let upstream_task =
            tokio::spawn(async move { axum::serve(upstream_listener, app).await.unwrap() });
        let record_path = root.join("active-key-control-config.toml-selected.json");
        if fail_publish {
            std::fs::write(&record_path, b"foreign endpoint record").unwrap();
        }
        let handle = spawn_v3_server_aggregate_with_admin(manifest, None, Some(config.clone()))
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
        let control = if fail_publish {
            None
        } else {
            let record: Value =
                serde_json::from_slice(&std::fs::read(&record_path).unwrap()).unwrap();
            assert_eq!(record["business_addr"], actual.to_string());
            Some(record["control_addr"].as_str().unwrap().parse().unwrap())
        };
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
            group,
            record_path,
            calls,
        }
    }
    async fn business(&self) -> Result<(u16, Value), String> {
        response(
            client()
                .post(format!("http://{}/v1/responses", self.business))
                .header("x-session-id", "control-address-fixture")
                .json(&json!({"model":"client","input":"ordinary text"})),
        )
        .await
    }
    async fn status(&self) -> Result<(u16, Value), String> {
        response(client().get(format!(
            "http://{}/api/routes/active-keys?server_id=selected",
            self.admin
        )))
        .await
    }
    async fn release(&self, pool: &str) -> Result<(u16, Value), String> {
        response(client().post(format!("http://{}/api/routes/active-keys/release",self.admin))
            .header("x-routecodex-admin-token",&self.token).json(&json!({"server_id":"selected",
            "routing_group_id":self.group,"pool_id":pool,"provider_id":"controlled","interface_id":"default","model_id":"wire","auth_alias":"A"}))).await
    }
    async fn finish(mut self, how: Close) -> (bool, bool) {
        let handle = self.handle.take().unwrap();
        match how {
            Close::Shutdown => {
                assert!(handle.shutdown().await.is_empty());
            }
            Close::Drop => drop(handle),
            Close::Exec => {
                drop(handle.prepare_for_exec().await);
            }
        }
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
        (released, !self.record_path.exists())
    }
}

#[tokio::test]
async fn real_admin_status_and_exact_release_follow_the_selected_listener_control() {
    let _home = LOCK.lock().await;
    let mut binds = vec![
        "0.0.0.0".parse::<IpAddr>().unwrap(),
        "::1".parse().unwrap(),
        "::".parse().unwrap(),
    ];
    if let Some(ip) = assigned_ipv4() {
        binds.push(ip);
    } else {
        panic!("assigned non-loopback address is required for companion acceptance");
    }
    for bind in binds {
        let fixture = Fixture::start(bind, false).await;
        let business = fixture.business().await;
        let status = fixture.status().await;
        let rejected = fixture.release("wrong-pool").await;
        let still_held = fixture.status().await;
        let released = fixture.release("default").await;
        let after = fixture.status().await;
        let next = fixture.business().await;
        let companion = fixture.control.unwrap();
        let companion_only = if !bind.is_loopback() && !bind.is_unspecified() {
            Some((
                response(client().get(format!("http://{companion}/v1/models"))).await,
                response(client().get(format!(
                    "http://{}/_routecodex/selection/active-keys",
                    fixture.business
                )))
                .await,
            ))
        } else {
            None
        };
        let all_calls = fixture.calls.calls.lock().unwrap().clone();
        let calls = all_calls
            .iter()
            .map(|(alias, _)| alias.clone())
            .collect::<Vec<_>>();
        let cleanup = fixture.finish(Close::Shutdown).await;
        assert_eq!(
            cleanup,
            (true, true),
            "owned sockets and endpoint record must close for {bind}"
        );
        let business = business.unwrap();
        assert_eq!(business.0, 200);
        assert_eq!(business.1["output"][0]["content"][0]["text"], "B");
        assert_eq!(status.unwrap().1["pools"][0]["held"][0]["auth_alias"], "A");
        assert_eq!(rejected.unwrap().0, 404);
        assert_eq!(
            still_held.unwrap().1["pools"][0]["held"][0]["auth_alias"],
            "A"
        );
        assert_eq!(released.unwrap().1["released"], true);
        assert_eq!(after.unwrap().1["pools"][0]["held"], json!([]));
        let next = next.unwrap();
        assert_eq!(next.0, 200);
        assert_eq!(next.1["output"][0]["content"][0]["text"], "B");
        assert_eq!(
            calls,
            ["A", "A", "A", "A", "B", "B"],
            "actual controlled wire bodies: {all_calls:?}"
        );
        if let Some((models, remote)) = companion_only {
            assert_eq!(
                models.unwrap().0,
                404,
                "companion exposes no business endpoint"
            );
            assert_eq!(
                remote.unwrap().0,
                403,
                "business LAN peer cannot invoke loopback controls"
            );
            assert!(companion.ip().is_loopback());
            eprintln!("VERIFIED assigned LAN bind={bind} companion={companion}; actual Admin release and cleanup");
        } else {
            eprintln!("VERIFIED exact/wildcard bind={bind} control={companion}; actual Admin release and cleanup");
        }
    }
}

#[tokio::test]
async fn control_publication_failure_keeps_business_and_preserves_the_foreign_record() {
    let _home = LOCK.lock().await;
    let bind = assigned_ipv4().expect("assigned non-loopback address");
    let fixture = Fixture::start(bind, true).await;
    let path = fixture.record_path.clone();
    let business = fixture.business().await;
    let unavailable = fixture.status().await;
    let cleanup = fixture.finish(Close::Shutdown).await;
    let preserved = std::fs::read(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    assert_eq!(cleanup, (true, false));
    let business = business.unwrap();
    assert_eq!(
        business.0, 200,
        "control I/O failure must not stop business forwarding"
    );
    assert_eq!(business.1["output"][0]["content"][0]["text"], "A");
    assert_ne!(
        unavailable.unwrap().0,
        200,
        "invalid/foreign record must remain an explicit control error"
    );
    assert_eq!(preserved, b"foreign endpoint record");
}

#[tokio::test]
async fn drop_and_exec_close_the_owned_companion_and_record() {
    let _home = LOCK.lock().await;
    let bind = assigned_ipv4().expect("assigned non-loopback address");
    for how in [Close::Drop, Close::Exec] {
        let fixture = Fixture::start(bind, false).await;
        let status = fixture.status().await;
        let cleanup = fixture.finish(how).await;
        assert_eq!(status.unwrap().0, 200);
        assert_eq!(cleanup, (true, true));
    }
}
