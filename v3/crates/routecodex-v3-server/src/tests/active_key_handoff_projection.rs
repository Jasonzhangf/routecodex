//! Real HTTP receipts at the Server's opposite-mode handoff boundary.
use super::*;
use routecodex_v3_target::V3ActiveKeyEpisode;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::hub_v1_fixture as fixture;

fn error_body() -> String {
    json!({"error":{"message":"ordinary controlled upstream failure alias=A status=503","type":"server_error"}}).to_string()
}

fn handoff_manifest(
    port: u16,
    upstream: SocketAddr,
    relay_first: bool,
) -> V3Config05ManifestPublished {
    let (first, last) = if relay_first {
        ("openai_chat", "responses")
    } else {
        ("responses", "openai_chat")
    };
    let source = format!(
        r#"
version=3
{declaration}
[servers.active_public]
bind="127.0.0.1"
port={port}
routing_group="active_public"
endpoints=["responses"]
{execution}
[providers.first]
type="{first}"
base_url="http://{upstream}/v1"
default_model="wire"
auth={{type="api_key",entries=[{{alias="A",env="HANDOFF_PROJECTION_A"}}]}}
[providers.first.models.wire]
wire_name="wire"
capabilities=["text","tools"]
[providers.last]
type="{last}"
base_url="http://{upstream}/v1"
default_model="wire"
auth={{type="api_key",entries=[{{alias="B",env="HANDOFF_PROJECTION_B"}}]}}
[providers.last.models.wire]
wire_name="wire"
capabilities=["text","tools"]
[route_groups.active_public.pools.default]
selection={{strategy="active_queue"}}
active_keys={{members=[{{provider="first",alias="A"}},{{provider="last",alias="B"}}],retries=0,on_failure="hold"}}
targets=[{{kind="provider_model",provider="first",model="wire",key="A",priority=2}},{{kind="provider_model",provider="last",model="wire",key="B",priority=1}}]
[debug]
log_console=false
codex_samples=false
"#,
        declaration = fixture::hub_v1_test_declaration(),
        execution = fixture::hub_v1_server_execution("active_public"),
    );
    routecodex_v3_config::compile_v3_config_05_manifest(
        routecodex_v3_config::parse_v3_config_02_authoring(&source).unwrap(),
    )
    .unwrap()
}

struct OwnedFixture {
    handle: Option<V3ServerAggregateHandle>,
    upstream_task: Option<tokio::task::JoinHandle<()>>,
    previous_env: Vec<(&'static str, Option<std::ffi::OsString>)>,
    home: PathBuf,
}

impl OwnedFixture {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!(
            "handoff-projection-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&home).unwrap();
        let previous_env = ["HOME", "HANDOFF_PROJECTION_A", "HANDOFF_PROJECTION_B"]
            .into_iter()
            .map(|name| (name, std::env::var_os(name)))
            .collect();
        std::env::set_var("HOME", &home);
        std::env::set_var("HANDOFF_PROJECTION_A", "handoff-projection-A");
        std::env::set_var("HANDOFF_PROJECTION_B", "handoff-projection-B");
        Self {
            handle: None,
            upstream_task: None,
            previous_env,
            home,
        }
    }
}

impl Drop for OwnedFixture {
    fn drop(&mut self) {
        drop(self.handle.take());
        if let Some(task) = self.upstream_task.take() {
            task.abort();
        }
        for (name, previous) in &self.previous_env {
            match previous {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        fs::remove_dir_all(&self.home).expect("remove owned fixture home");
        assert!(!self.home.exists());
        eprintln!(
            "handoff-projection home absent=true path={}",
            self.home.display()
        );
    }
}

async fn held_successor_projects_exact_http(relay_first: bool) {
    let _lock = TEST_HOME_LOCK.lock().await;
    let mut owned = OwnedFixture::new();
    let calls = Arc::new(Mutex::new(Vec::<String>::new()));
    let observed_calls = calls.clone();
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    assert!(![4444, 7777].contains(&upstream_addr.port()));
    let app = Router::new().fallback(post(move |headers: HeaderMap| {
        let calls = observed_calls.clone();
        async move {
            let alias = headers
                .get("authorization")
                .unwrap()
                .to_str()
                .unwrap()
                .strip_prefix("Bearer handoff-projection-")
                .unwrap()
                .to_owned();
            calls.lock().unwrap().push(alias);
            Response::builder()
                .status(503)
                .header("content-type", "application/json")
                .body(Body::from(error_body()))
                .unwrap()
        }
    }));
    owned.upstream_task = Some(tokio::spawn(async move {
        axum::serve(upstream, app).await.unwrap();
    }));
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    assert!(![4444, 7777].contains(&port));
    drop(reservation);
    let handle = spawn_v3_server_aggregate(handoff_manifest(port, upstream_addr, relay_first))
        .await
        .unwrap();
    let server_addr = handle.listeners[0].addr;
    let observed = Arc::new(AtomicUsize::new(0));
    let observer_count = observed.clone();
    *handle.responses_handoff_observer.0.lock().unwrap() =
        Some(Arc::new(move |selected, mode, keys| {
            assert_eq!(selected.candidate.auth_alias, "B");
            assert_eq!(selected.candidate.provider_id, "last");
            assert_eq!(
                mode,
                if relay_first {
                    V3EntryProtocolExecutionMode::Direct
                } else {
                    V3EntryProtocolExecutionMode::Relay
                }
            );
            assert_eq!(observer_count.fetch_add(1, Ordering::SeqCst), 0);
            let witness = selected
                .active_selection
                .as_ref()
                .expect("actual Target selection witness");
            assert!(!keys
                .snapshot(&witness.scope)
                .unwrap()
                .held
                .contains(&witness.identity));
            for n in 1..=4 {
                let mut sibling = V3ActiveKeyEpisode::new(witness.clone());
                sibling.begin_attempt().unwrap();
                let result = keys.record_delivery_failure(&mut sibling).unwrap();
                assert!(result.applied);
                assert_eq!(result.consecutive_failures, n);
                assert_eq!(result.transitioned, n == 4);
            }
            assert!(keys
                .snapshot(&witness.scope)
                .unwrap()
                .held
                .contains(&witness.identity));
            eprintln!(
                "handoff-projection selected=B destination={mode:?} fourth_failure_held=true"
            );
        }));
    owned.handle = Some(handle);
    let result = async {
        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap()
            .post(format!("http://{server_addr}/v1/responses"))
            .header("x-session-id", "held-successor")
            .json(&json!({"model":"client","input":"handoff"}))
            .send()
            .await?;
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.bytes().await?;
        Ok::<_, reqwest::Error>((status, headers, body))
    }
    .await;
    let actual_calls = calls.lock().unwrap().clone();
    let shutdown = owned.handle.take().unwrap().shutdown().await;
    let task = owned.upstream_task.take().unwrap();
    task.abort();
    let _ = task.await;
    // Observe owned listener closure; no elapsed-time trigger or arbitrary sleep.
    for addr in [server_addr, upstream_addr] {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(listener) = std::net::TcpListener::bind(addr) {
                    drop(listener);
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("owned port released");
    }
    eprintln!("handoff-projection ports closed server={server_addr} upstream={upstream_addr}; calls={actual_calls:?}");
    drop(owned);
    assert!(shutdown.is_empty(), "{shutdown:?}");
    assert_eq!(observed.load(Ordering::SeqCst), 1);
    assert_eq!(actual_calls, ["A"]);
    let (status, headers, body) = result.expect("real Server HTTP response");
    assert_eq!(status.as_u16(), 503);
    assert_eq!(headers.get("content-type").unwrap(), "application/json");
    assert_eq!(
        body.as_ref(),
        error_body().as_bytes(),
        "complete A body, no appended payload"
    );
    eprintln!("handoff-projection client status=503 content-type=application/json exact_A_body=true appended_payload=false");
}

#[tokio::test]
async fn relay_direct_held_successor_projects_exact_http_through_server() {
    held_successor_projects_exact_http(true).await;
}

#[tokio::test]
async fn direct_relay_held_successor_projects_exact_http_through_server() {
    held_successor_projects_exact_http(false).await;
}
