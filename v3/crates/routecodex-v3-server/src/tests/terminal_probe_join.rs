//! Public listener control and aggregate lifecycle consumer; retained typed
//! handles let the test check permit release at the exact return boundary.
use super::*;
use tokio::sync::Semaphore;

#[path = "../../../routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod fixture;

#[tokio::test]
async fn id9_terminal_join_releases_both_listener_probe_permits() {
    let _lock = TEST_HOME_LOCK.lock().await;
    let directory = std::env::temp_dir().join(format!("id9-terminal-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    struct RestoreHome(Option<std::ffi::OsString>, std::path::PathBuf);
    impl Drop for RestoreHome {
        fn drop(&mut self) {
            match self.0.take() {
                Some(home) => std::env::set_var("HOME", home),
                None => std::env::remove_var("HOME"),
            }
            let _ = std::fs::remove_dir_all(&self.1);
        }
    }
    let _home = RestoreHome(std::env::var_os("HOME"), directory.clone());
    std::env::set_var("HOME", &directory);
    std::env::set_var("ID9_TERMINAL_TEST_KEY", "test-only");
    let entered = Arc::new(Semaphore::new(0));
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let signal = entered.clone();
    let upstream_task = tokio::spawn(async move {
        let app = axum::Router::new().route(
            "/v1/responses",
            axum::routing::post(move || {
                let signal = signal.clone();
                async move {
                    signal.add_permits(1);
                    std::future::pending::<String>().await
                }
            }),
        );
        axum::serve(upstream, app).await.unwrap();
    });
    for terminal_exec in [false, true] {
        let mut servers = String::new();
        for id in ["a", "b"] {
            let port = std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            servers.push_str(&format!("\n[servers.{id}]\nbind=\"127.0.0.1\"\nport={port}\nrouting_group=\"test\"\nendpoints=[\"responses\"]\n{}\n", fixture::hub_v1_server_execution(id)));
        }
        let source = format!(
            r#"
version=3
{}
{servers}
[providers.test]
type="responses"
base_url="http://{upstream_addr}/v1"
default_model="main"
auth={{type="api_key",entries=[{{alias="key",env="ID9_TERMINAL_TEST_KEY"}}]}}
health={{enabled=true,failure_threshold=1,cooldown_ms=60000,probe_interval_ms=60000}}
[providers.test.models.main]
wire_name="main"
[forwarders.responses]
model="main"
targets=[{{kind="provider_model",provider="test",model="main",key="key",priority=1}}]
[route_groups.test.pools.default]
targets=[{{kind="forwarder",id="responses",priority=1}}]
[debug]
log_console=false
codex_samples=false
"#,
            fixture::hub_v1_test_declaration()
        );
        let manifest = routecodex_v3_config::compile_v3_config_05_manifest(
            routecodex_v3_config::parse_v3_config_02_authoring(&source).unwrap(),
        )
        .unwrap();
        let handle = spawn_v3_server_aggregate(manifest.clone()).await.unwrap();
        let healths = handle.provider_health.clone();
        let client = reqwest::Client::new();
        for listener in &handle.listeners {
            let base = format!("http://{}/_routecodex/health/cooldown-pool", listener.addr);
            assert!(client.post(format!("{base}/add")).json(&json!({"provider_id":"test","interface_id":"default","auth_alias":"key","model_id":"main","kind":"probe","duration_ms":600000})).send().await.unwrap().status().is_success());
            assert!(client.post(format!("{base}/probe")).json(&json!({"provider_id":"test","interface_id":"default","auth_alias":"key","model_id":"main"})).send().await.unwrap().status().is_success());
        }
        tokio::time::timeout(Duration::from_secs(5), entered.acquire_many(2))
            .await
            .unwrap()
            .unwrap()
            .forget();
        for health in &healths {
            assert!(
                serde_json::to_value(health.store().cooldown_entries(u64::MAX))
                    .unwrap()
                    .to_string()
                    .contains("probing")
            );
        }
        if terminal_exec {
            drop(handle.prepare_for_exec().await);
        } else {
            handle.shutdown().await;
        }
        // No yield here: join must release each pending permit before returning.
        for health in &healths {
            let entries = serde_json::to_value(health.store().cooldown_entries(u64::MAX)).unwrap();
            assert!(!entries.to_string().contains("probing"), "terminal_exec={terminal_exec}: probe permit remains acquired after terminal join: {entries}");
            let (_sender, receiver) = oneshot::channel();
            let registration = health
                .runtime_health()
                .aggregate_provider_probe_lifecycle_resume(Arc::new(manifest.clone()), receiver);
            assert!(
                registration.is_ok(),
                "terminal join must release scheduler registration"
            );
            drop(registration);
        }
    }
    upstream_task.abort();
    let _ = upstream_task.await;
    std::env::remove_var("ID9_TERMINAL_TEST_KEY");
}
