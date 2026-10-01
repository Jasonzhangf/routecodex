//! E2E for review blocker B1: the scheduled provider patrol (定时巡检) must
//! actually tick in the real in-process topology.
//!
//! `[admin_webui] enabled = true` is part of the base config and the managed
//! lifecycle spawns this aggregate in-process, so the aggregate + admin listener
//! is the shipping entry. This test starts exactly that entry, configures a
//! short-interval plan over the real admin HTTP surface, and then only reads
//! history back over HTTP. It never calls `PatrolRuntime::run_due`, and it holds
//! no handle on the admin `AppState`, so a `trigger: "scheduled"` row can only
//! have been produced by the background tick loop started from the shipping
//! entry. Acceptance B01/B02: a short-interval plan produces a new scheduled row
//! within at most two periods.

use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_server::spawn_v3_server_aggregate_with_admin;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const PROVIDER_ID: &str = "test";
const PLAN_INTERVAL_SECS: u64 = 1;

fn temp_home(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rcc-patrol-scheduler-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

fn config_source(server_port: u16, admin_port: u16) -> String {
    format!(
        r#"
version = 3

[servers.main]
bind = "127.0.0.1"
port = {server_port}
routing_group = "default"
endpoints = ["responses"]

[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_PATROL_SCHEDULER_TEST_KEY" }}] }}

[providers.test.models.test]

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]

[admin_webui]
enabled = true
bind = "127.0.0.1"
port = {admin_port}
"#
    )
}

/// The authoring file the patrol path reads through ConfigMgmt
/// (`<config_dir>/provider/<id>/config.v2.toml`).
fn write_provider_file(home: &Path, id: &str) {
    let dir = home.join("provider").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("config.v2.toml"),
        format!(
            r#"
version = "2.0.0"
providerId = "{id}"

[provider]
id = "{id}"
enabled = true
type = "openai_chat"
baseURL = "http://127.0.0.1:9/v1"
defaultModel = "test"

[provider.auth]
type = "apikey"
apiKey = "sk-patrol-scheduler-e2e"

[provider.models."test"]
supportsStreaming = true
"#
        ),
    )
    .unwrap();
}

fn admin_token(home: &Path) -> String {
    std::fs::read_to_string(home.join("state").join("admin-token"))
        .expect("the admin entry provisions a local admin token")
        .trim()
        .to_string()
}

async fn patrol_rows(base: &str, token: &str) -> Vec<Value> {
    let response = reqwest::Client::new()
        .get(format!(
            "{base}/api/providers/{PROVIDER_ID}/patrol/results?limit=10"
        ))
        .header("x-routecodex-admin-token", token)
        .send()
        .await
        .expect("patrol results response");
    assert_eq!(response.status().as_u16(), 200);
    let body: Value = response.json().await.expect("patrol results json");
    body.get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

async fn wait_for_scheduled_rows(
    base: &str,
    token: &str,
    wanted: usize,
    deadline: Duration,
) -> Vec<Value> {
    let started = Instant::now();
    loop {
        let rows = patrol_rows(base, token).await;
        let scheduled = rows
            .iter()
            .filter(|row| row.get("trigger").and_then(Value::as_str) == Some("scheduled"))
            .cloned()
            .collect::<Vec<_>>();
        if scheduled.len() >= wanted {
            return scheduled;
        }
        assert!(
            started.elapsed() < deadline,
            "expected {wanted} scheduled patrol row(s) within {deadline:?}, saw {}: {rows:?}",
            scheduled.len()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn scheduled_patrol_ticks_in_the_in_process_admin_entry() {
    std::env::set_var("V3_PATROL_SCHEDULER_TEST_KEY", "controlled-secret");
    let home = temp_home("managed");
    let previous_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &home);
    let config_path = home.join("config.v3.toml");
    let server_port = free_port();
    let admin_port = free_port();
    std::fs::write(&config_path, config_source(server_port, admin_port)).unwrap();
    write_provider_file(&home, PROVIDER_ID);

    let snapshot = V3ConfigStore::new(&config_path)
        .load_snapshot_with_source_identity()
        .unwrap();
    let manifest = snapshot.manifest;
    let admin_webui = snapshot.admin_webui;
    assert!(
        admin_webui.is_some(),
        "admin WebUI is enabled in this config"
    );

    // The real shipping entry: the aggregate server, in-process, with the admin
    // WebUI listener enabled. No direct `run_due` call exists anywhere below.
    let handle = spawn_v3_server_aggregate_with_admin(manifest, admin_webui, Some(config_path))
        .await
        .unwrap();
    let admin_listener = handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == "admin_webui")
        .expect("aggregate handle exposes the admin listener");
    let base = format!("http://{}", admin_listener.addr);
    let token = admin_token(&home);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();

    // The in-process entry must have started the process-wide scheduler. This is
    // the DAG edge blocker B1 said had no producer.
    let status: Value = client
        .get(format!("{base}/api/providers/patrol/status"))
        .header("x-routecodex-admin-token", &token)
        .send()
        .await
        .expect("patrol status response")
        .json()
        .await
        .expect("patrol status json");
    assert_eq!(
        status.get("loop_started").and_then(Value::as_bool),
        Some(true),
        "the in-process admin entry must start the patrol tick loop: {status}"
    );

    // Exactly one scheduler per process: a second starter in the same process
    // (for example the standalone `rccv3-admin` binary embedding the same config)
    // must be refused instead of ticking the same plan file twice.
    let second_starter = std::sync::Arc::new(routecodex_v3_admin::AppState::new(
        home.join("config.v3.toml"),
    ));
    second_starter.spawn_background();
    assert!(
        !second_starter.patrol.loop_started(),
        "a second starter must not add a second scheduler for the same process"
    );
    assert_eq!(
        routecodex_v3_admin::provider_patrol::patrol_loop_owner(),
        Some(home.join("state").join("provider-patrol-plans.json")),
        "the process-wide loop owns exactly this plans file"
    );

    // Short-interval plan over the real admin HTTP surface.
    let put = client
        .put(format!("{base}/api/providers/{PROVIDER_ID}/patrol"))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "enabled": true,
            "interval_secs": PLAN_INTERVAL_SECS,
            "stages": ["l1_contract"],
        }))
        .send()
        .await
        .expect("put patrol plan response");
    assert_eq!(put.status().as_u16(), 200, "plan must be accepted");

    // B01/B02: a new scheduled row appears within at most two periods, and the
    // tick repeats (a second row) without any manual trigger.
    let two_periods = Duration::from_secs(2 * PLAN_INTERVAL_SECS);
    let scheduled = wait_for_scheduled_rows(&base, &token, 1, two_periods).await;
    let first = scheduled[0].clone();
    println!("scheduled patrol row: {first}");
    assert_eq!(
        first.get("provider_id").and_then(Value::as_str),
        Some(PROVIDER_ID)
    );
    assert_eq!(
        first.get("source").and_then(Value::as_str),
        Some("admin_provider_patrol"),
        "scheduled runs stay labelled as admin-side diagnostics"
    );
    assert!(
        first
            .get("stages")
            .and_then(Value::as_array)
            .is_some_and(|stages| !stages.is_empty()),
        "a scheduled run records the stages it executed: {first}"
    );

    let scheduled = wait_for_scheduled_rows(&base, &token, 2, two_periods).await;
    let second = scheduled
        .iter()
        .max_by_key(|row| {
            row.get("started_at_epoch_ms")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        })
        .expect("second scheduled row")
        .clone();
    println!("second scheduled patrol row: {second}");
    let first_started = first
        .get("started_at_epoch_ms")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let second_started = second
        .get("started_at_epoch_ms")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    assert!(
        second_started >= first_started,
        "scheduled rows are ordered by start time: {first_started} then {second_started}"
    );

    // History is the on-disk truth the WebUI reads, not just an in-memory list.
    let history_path = home.join("state").join("provider-patrol.jsonl");
    let history = std::fs::read_to_string(&history_path).expect("scheduled runs persisted");
    let lines = history
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    assert!(
        lines.len() >= 2,
        "the tick loop keeps appending scheduled rows: {history}"
    );
    for line in &lines {
        let entry: Value = serde_json::from_str(line).expect("patrol history line is json");
        assert_eq!(
            entry.get("trigger").and_then(Value::as_str),
            Some("scheduled"),
            "only the background scheduler may write these rows: {entry}"
        );
    }

    // The advisory tick loop must not hold shutdown open. The aggregate handle
    // completes while the scheduler task is still alive (it is dropped with the
    // runtime instead of being awaited), and both ports are released.
    handle.shutdown().await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        std::net::TcpListener::bind(("127.0.0.1", admin_port)).is_ok(),
        "admin port is released even while the advisory patrol loop is alive"
    );
    assert!(
        std::net::TcpListener::bind(("127.0.0.1", server_port)).is_ok(),
        "server port is released even while the advisory patrol loop is alive"
    );

    if let Some(previous_home) = previous_home {
        std::env::set_var("HOME", previous_home);
    } else {
        std::env::remove_var("HOME");
    }
    let _ = std::fs::remove_dir_all(&home);
}
