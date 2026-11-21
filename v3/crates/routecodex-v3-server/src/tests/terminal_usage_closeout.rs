//! Public HTTP closeout checks for the aggregate-owned Provider usage writer.
use super::*;

#[path = "../../../routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod fixture;

const TERMINAL_USAGE_KEY_ENV: &str = "TERMINAL_USAGE_CLOSEOUT_KEY";

async fn terminal_usage_upstream_response() -> axum::response::Response<axum::body::Body> {
    axum::response::Response::builder()
        .status(axum::http::StatusCode::OK)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(
            json!({
                "id": "resp_terminal_usage_closeout",
                "object": "response",
                "status": "completed",
                "model": "wire-terminal-usage",
                "output": [{
                    "id": "msg_terminal_usage_closeout",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{
                        "type": "output_text",
                        "text": "terminal-usage-closeout-ok",
                        "annotations": []
                    }]
                }],
                "output_text": "terminal-usage-closeout-ok",
                "usage": {
                    "input_tokens": 7,
                    "output_tokens": 3,
                    "total_tokens": 10
                }
            })
            .to_string(),
        ))
        .unwrap()
}

fn isolated_home(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "terminal-usage-closeout-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ))
}

fn terminal_usage_manifest(
    port: u16,
    upstream: std::net::SocketAddr,
) -> V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3
{}

[servers.owned]
bind = "127.0.0.1"
port = {port}
routing_group = "owned"
endpoints = ["responses"]
{}

[providers.terminal]
type = "responses"
base_url = "http://{upstream}/v1"
default_model = "model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{TERMINAL_USAGE_KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 60000 }}
responses = {{ process = "direct", streaming = "always" }}
[providers.terminal.models.model]
wire_name = "wire-terminal-usage"
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.owned.pools.default]
targets = [{{ kind = "provider_model", provider = "terminal", model = "model", key = "key", priority = 1 }}]

[debug]
log_console = false
codex_samples = false
"#,
        fixture::hub_v1_test_declaration(),
        fixture::hub_v1_server_execution("owned"),
    );
    routecodex_v3_config::compile_v3_config_05_manifest(
        routecodex_v3_config::parse_v3_config_02_authoring(&source).unwrap(),
    )
    .unwrap()
}

fn terminal_usage_files(port: u16, home: &std::path::Path) -> Vec<std::path::PathBuf> {
    let config = routecodex_v3_config::default_v3_config_path(home);
    let records = routecodex_v3_config::v3_webui_observability_store_path(&config, None, port);
    vec![
        records.clone(),
        routecodex_v3_debug::v3_provider_usage_facts_path(&records),
        routecodex_v3_debug::v3_provider_usage_coverage_path(&records),
        routecodex_v3_debug::v3_provider_usage_generation_path(&records),
    ]
}

fn file_lengths(paths: &[std::path::PathBuf]) -> Vec<Option<u64>> {
    paths
        .iter()
        .map(|path| std::fs::metadata(path).ok().map(|metadata| metadata.len()))
        .collect()
}

async fn run_terminal_usage_closeout(use_prepare_for_exec: bool) {
    let _home_lock = super::TEST_HOME_LOCK.lock().unwrap();
    let home = isolated_home(if use_prepare_for_exec {
        "prepare-for-exec"
    } else {
        "shutdown"
    });
    std::fs::create_dir_all(&home).unwrap();
    let _home = TestHomeGuard::set(&home);
    std::env::set_var(TERMINAL_USAGE_KEY_ENV, "terminal-usage-key");

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move {
        let app = axum::Router::new().route(
            "/v1/responses",
            axum::routing::post(terminal_usage_upstream_response),
        );
        axum::serve(upstream, app).await.unwrap();
    });
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let handle = spawn_v3_server_aggregate(terminal_usage_manifest(port, upstream_addr))
        .await
        .unwrap();
    let retained_writer = handle.observability_writers[0].clone();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let response = reqwest::Client::new()
        .post(&endpoint)
        .json(&json!({
            "model": "client-auto",
            "input": "terminal-usage-closeout",
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "terminal usage request failed: {}",
        response.status()
    );
    let response = response.json::<Value>().await.unwrap();
    assert_eq!(response["usage"]["input_tokens"], 7);
    assert_eq!(response["usage"]["output_tokens"], 3);
    assert_eq!(response["usage"]["total_tokens"], 10);

    if use_prepare_for_exec {
        drop(handle.prepare_for_exec().await);
    } else {
        let failures = handle.shutdown().await;
        assert!(failures.is_empty(), "sample failures: {failures:?}");
    }

    let config = routecodex_v3_config::default_v3_config_path(&home);
    let records = routecodex_v3_config::v3_webui_observability_store_path(&config, None, port);
    let usage = routecodex_v3_debug::v3_webui_observability_read_provider_usage(&records)
        .expect("usage facts must be readable at the terminal return boundary");
    assert_eq!(
        usage.facts.len(),
        1,
        "the terminal request must have one durable fact"
    );
    let fact = &usage.facts[0];
    assert_eq!(fact.listener_id, port);
    assert_eq!(fact.provider_id.as_deref(), Some("terminal"));
    assert_eq!(fact.usage.as_ref().unwrap()["input_tokens"], 7);
    assert_eq!(fact.usage.as_ref().unwrap()["output_tokens"], 3);
    let generation = routecodex_v3_debug::v3_provider_usage_read_generation(&records)
        .expect("generation must be readable at the terminal return boundary");
    assert!(
        !generation.open,
        "the consuming terminal API must close the writer generation before returning"
    );
    assert!(
        generation.last_normal_end_epoch_ms.is_some(),
        "a normal terminal close must record its generation end"
    );

    let files = terminal_usage_files(port, &home);
    let before = file_lengths(&files);
    retained_writer
        .record_observed(
            V3ObsEventType::Completed,
            &build_v3_obs_request_key(port, "post-terminal-closeout"),
            V3ObsScope {
                port,
                ..Default::default()
            },
            V3ObsRequestMeta {
                request_id: "post-terminal-closeout".to_string(),
                endpoint: "/v1/responses".to_string(),
                provider_id: Some("terminal".to_string()),
                provider: Some("terminal".to_string()),
                ..Default::default()
            },
            &crate::V3RuntimeObservability::default(),
        )
        .expect("a post-terminal write must not block");
    assert_eq!(
        file_lengths(&files),
        before,
        "a retained clone must not write or reopen files after terminal close"
    );

    std::fs::remove_dir_all(&home).unwrap();
    assert!(
        !home.exists(),
        "the terminal return boundary must allow one-shot directory deletion"
    );
    drop(retained_writer);
    assert!(
        !home.exists(),
        "releasing the retained clone must not reopen the deleted store"
    );
    std::env::remove_var(TERMINAL_USAGE_KEY_ENV);
    upstream_task.abort();
    let _ = upstream_task.await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminal_usage_writer_closes_before_aggregate_returns() {
    run_terminal_usage_closeout(false).await;
    run_terminal_usage_closeout(true).await;
}

#[test]
fn terminal_writer_close_internal_boundaries() {
    crate::webui_observability::tests::terminal_close_waits_for_queued_work_before_closing_generation();
    crate::webui_observability::tests::terminal_close_returns_pending_write_failure_after_joining_the_writer();
}
