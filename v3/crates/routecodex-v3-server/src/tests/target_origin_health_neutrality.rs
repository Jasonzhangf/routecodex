use super::*;
use futures_util::FutureExt;
use std::collections::BTreeMap;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[path = "../../../routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod fixture;

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn manifest(
    home: &std::path::Path,
    upstream: std::net::SocketAddr,
    port_a: u16,
    port_b: u16,
) -> V3Config05ManifestPublished {
    let source = format!(
        r#"
version=3
{}
[servers.a]
bind="127.0.0.1"
port={port_a}
routing_group="default"
endpoints=["responses"]
[servers.b]
bind="127.0.0.1"
port={port_b}
routing_group="default"
endpoints=["responses"]
{}
{}
[providers.test]
enabled=false
type="responses"
base_url="http://{upstream}/v1"
default_model="test"
auth={{type="api_key",entries=[{{alias="key",env="TARGET_ORIGIN_HEALTH_KEY"}}]}}
health={{enabled=true,failure_threshold=1,cooldown_ms=5000}}
responses={{process="chat",streaming="always"}}
[providers.test.models.test]
wire_name="wire-test"
aliases=["client-test"]
capabilities=["text","tools","vision"]
supports_streaming=true
supports_thinking=true
thinking="optional"
max_tokens=4096
max_context_tokens=128000
[debug]
log_console=false
log_file={}
snapshots=false
dry_run=false
[route_groups.default.pools.default]
selection={{strategy="priority"}}
targets=[{{kind="provider_model",provider="test",model="test",key="key",priority=1}}]
"#,
        fixture::hub_v1_test_declaration(),
        fixture::hub_v1_server_execution("a"),
        fixture::hub_v1_server_execution("b"),
        serde_json::to_string(&home.join("debug.log").to_string_lossy()).unwrap(),
    );
    routecodex_v3_config::compile_v3_config_05_manifest(
        routecodex_v3_config::parse_v3_config_02_authoring(&source).unwrap(),
    )
    .unwrap()
}

fn persistence_files(home: &std::path::Path) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    let directory = home.join(".rcc/state");
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return files,
        Err(error) => panic!("cannot read isolated health persistence: {error}"),
    };
    for entry in entries {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_str().unwrap();
        if name.starts_with("provider-cooldowns") && name.ends_with(".json") {
            files.insert(name.to_owned(), std::fs::read(&path).unwrap());
        }
    }
    files
}

fn compiled_provider_interface_id(manifest: &V3Config05ManifestPublished) -> String {
    let provider = manifest.providers.get("test").unwrap();
    let mut interfaces = provider.interfaces.keys();
    let interface_id = interfaces
        .next()
        .expect("the fixture provider must compile one interface")
        .clone();
    assert!(
        interfaces.next().is_none(),
        "the fixture must compile exactly one provider interface"
    );
    interface_id
}

fn assert_zero_response_bytes(wire: &[u8], context: &str) {
    assert!(
        wire.is_empty(),
        "{context} must close without any response bytes, including a partial HTTP head: {:?}",
        String::from_utf8_lossy(wire)
    );
}

struct ExactHealthChildOutcome {
    failure: Option<String>,
    receipt_hold: Option<Box<dyn std::any::Any>>,
}

fn capture_assertion_message(panic: Box<dyn std::any::Any + Send>) -> String {
    panic_message(panic.as_ref())
}

fn run_exact_health_child_wrapper() {
    let case = std::env::var(EXACT_HEALTH_CHILD_CASE_ENV)
        .expect("the parent must supply the exact-health child case");
    let directory = PathBuf::from(
        std::env::var_os(EXACT_HEALTH_CHILD_DIR_ENV)
            .expect("the parent must supply the exact-health child directory"),
    );
    let home = PathBuf::from(
        std::env::var_os(EXACT_HEALTH_CHILD_HOME_ENV)
            .expect("the parent must supply the exact-health child HOME"),
    );
    assert!(
        std::env::var_os("TARGET_ORIGIN_EXACT_HEALTH_CHILD_NESTED").is_none(),
        "the exact-health child must not spawn recursively"
    );
    record_exact_health(&directory, "case", &case);
    record_exact_health(&directory, "child_pid", std::process::id());
    if case == "early_exit_without_address" {
        record_exact_health(&directory, "child_exit_before_address_record", true);
        panic!("intentional child exit before recording an address");
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build the owned exact-health child runtime");
    let outcome = runtime.block_on(run_exact_health_child_case(&case, &directory, &home));
    if let Some(hold) = outcome.receipt_hold {
        record_exact_health(&directory, "stage", "runtime_drop_with_held_receipt");
        record_exact_health(&directory, "runtime_drop_begin", true);
        drop(runtime);
        record_exact_health(&directory, "runtime_drop_completed_unexpectedly", true);
        drop(hold);
    } else {
        drop(runtime);
    }
    if let Some(failure) = outcome.failure {
        record_exact_health(&directory, "child_outcome", "failed");
        panic!("{failure}");
    }
    record_exact_health(&directory, "child_outcome", "passed");
}

async fn stall_exact_health_aggregate_shutdown(
    handle: V3ServerAggregateHandle,
    directory: &Path,
) -> Box<dyn std::any::Any> {
    let store = handle
        .provider_health
        .first()
        .expect("the aggregate must retain provider health stores")
        .store();
    let hold = Arc::new(
        store
            .hold_next_persistence_flush_receipt_for_test()
            .expect("arm the aggregate shutdown persistence receipt hold"),
    );
    record_exact_health(directory, "persistence_hold_armed", "aggregate_shutdown");
    let wait_hold = Arc::clone(&hold);
    let hold_observer = tokio::task::spawn_blocking(move || {
        wait_hold.wait_until_receipt_is_held(EXACT_HEALTH_CLOSEOUT_TIMEOUT)
    });
    let shutdown = tokio::time::timeout(
        EXACT_HEALTH_CLOSEOUT_TIMEOUT,
        std::panic::AssertUnwindSafe(handle.shutdown()).catch_unwind(),
    )
    .await;
    match tokio::time::timeout(Duration::from_secs(1), hold_observer).await {
        Ok(Ok(Ok(()))) => {
            record_exact_health(directory, "persistence_hold_reached", "aggregate_shutdown")
        }
        Ok(Ok(Err(error))) => record_exact_health(directory, "persistence_hold_not_reached", error),
        Ok(Err(error)) => record_exact_health(directory, "persistence_hold_observer_failed", error),
        Err(_) => record_exact_health(directory, "persistence_hold_observer_timeout", true),
    }
    match shutdown {
        Ok(Ok(failures)) => record_exact_health(
            directory,
            "aggregate_shutdown_returned_unexpectedly",
            format!("{failures:?}"),
        ),
        Ok(Err(panic)) => record_exact_health(
            directory,
            "aggregate_shutdown_panicked",
            capture_assertion_message(panic),
        ),
        Err(_) => {
            record_exact_health(directory, "cleanup_timeout", "aggregate_shutdown");
        }
    }
    Box::new(hold)
}

async fn run_exact_health_child_case(
    case: &str,
    directory: &Path,
    home: &Path,
) -> ExactHealthChildOutcome {
    std::fs::create_dir_all(home).expect("create the child-owned exact-health HOME");
    let mut env = ExactHealthEnvGuard::new(home);
    let diagnostic_path = home.join("debug.log");
    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind the owned exact-health upstream");
    let upstream_addr = upstream_listener
        .local_addr()
        .expect("read the owned upstream address");
    record_exact_health(directory, "upstream_address", upstream_addr);
    let connections = Arc::new(AtomicUsize::new(0));
    let (shutdown, shutdown_rx) = oneshot::channel();
    let upstream_task = tokio::spawn(run_exact_health_upstream(
        upstream_listener,
        shutdown_rx,
        Arc::clone(&connections),
    ));
    let mut assertion_failure = None;
    let mut cleanup_failure_errors = Vec::new();
    for populated in [false, true] {
        let published = manifest(home, upstream_addr, free_port(), free_port());
        let interface_id = compiled_provider_interface_id(&published);
        record_exact_health(
            directory,
            "provider_identity",
            format!("provider=test interface={interface_id} key=key model=test"),
        );
        let handle = spawn_v3_server_aggregate(published)
            .await
            .expect("start the exact-health aggregate");
        let listener_addresses = handle
            .listeners
            .iter()
            .map(|listener| listener.addr)
            .collect::<Vec<_>>();
        for address in &listener_addresses {
            record_exact_health(directory, "listener_address", address);
        }
        let stores = handle
            .provider_health
            .iter()
            .map(|health| health.store())
            .collect::<Vec<_>>();
        record_exact_health(directory, "aggregate_store_count", stores.len());
        if case == "direct_flush_stall" {
            let store = &stores[0];
            let hold = store
                .hold_next_persistence_flush_receipt_for_test()
                .expect("arm the direct flush persistence receipt hold");
            record_exact_health(directory, "persistence_hold_armed", "direct_baseline_flush");
            let flush_store = store.clone();
            let flush_directory = directory.to_path_buf();
            std::thread::spawn(move || {
                let result = flush_store.flush_persistence();
                record_exact_health(
                    &flush_directory,
                    "direct_flush_returned_unexpectedly",
                    format!("{result:?}"),
                );
            });
            hold.wait_until_receipt_is_held(Duration::from_secs(5))
                .expect("the existing direct flush writer must reach the held receipt");
            record_exact_health(
                directory,
                "persistence_hold_reached",
                "direct_baseline_flush",
            );
            record_exact_health(directory, "stage", "direct_baseline_flush_pending");
            loop {
                std::thread::park();
            }
        }
        let phase = std::panic::AssertUnwindSafe(async {
            assert_eq!(stores.len(), 2);
            if populated {
                for store in &stores {
                    assert_eq!(
                        store
                            .scheduling_projection_for_key_with_interface(
                                "test",
                                &interface_id,
                                "key",
                                "test",
                                1,
                                1,
                                11,
                            )
                            .unwrap()
                            .score_generation,
                        0
                    );
                    let projection = store
                        .record_provider_key_success_for_interface(
                            "test",
                            &interface_id,
                            "key",
                            "test",
                            11,
                        )
                        .unwrap();
                    assert_eq!(projection.success_streak, 1);
                    assert_eq!(projection.score_generation, 1);
                    assert_eq!(
                        store
                            .scheduling_projection_for_key_with_interface(
                                "test",
                                &interface_id,
                                "key",
                                "test",
                                1,
                                1,
                                11,
                            )
                            .unwrap()
                            .score_generation,
                        1
                    );
                }
            }
            for store in &stores {
                store.flush_persistence().unwrap();
            }
            let persisted = persistence_files(home);
            let mut diagnostic_offset = std::fs::read_to_string(&diagnostic_path)
                .unwrap_or_default()
                .len();
            let connections_before = connections.load(Ordering::SeqCst);
            assert_eq!(
                connections_before, 0,
                "upstream ingress before public requests"
            );
            for listener in &handle.listeners {
                for streaming in [false, true] {
                    let client = reqwest::Client::new();
                    let observed =
                        std::panic::AssertUnwindSafe(stores[0].assert_health_unchanged_during(
                            &stores,
                            consume_failure(&client, listener.addr, streaming),
                        ))
                        .catch_unwind()
                        .await;
                    if let Err(panic) = observed {
                        std::panic::resume_unwind(panic);
                    }
                    for store in &stores {
                        assert!(
                            store.cooldown_entries(u64::MAX).is_empty(),
                            "populated={populated} streaming={streaming}"
                        );
                        assert_eq!(store.persistence_alarm(), None);
                    }
                    assert_eq!(
                        connections.load(Ordering::SeqCst),
                        connections_before,
                        "populated={populated} streaming={streaming}"
                    );
                    let diagnostic = std::fs::read_to_string(&diagnostic_path).unwrap();
                    assert_terminal(&diagnostic[diagnostic_offset..], listener.addr.port(), 1);
                    diagnostic_offset = diagnostic.len();
                    for store in &stores {
                        store.flush_persistence().unwrap();
                    }
                    assert_eq!(
                        persistence_files(home),
                        persisted,
                        "populated={populated} streaming={streaming}"
                    );
                }
            }
            for store in &stores {
                store.flush_persistence().unwrap();
            }
            assert_eq!(persistence_files(home), persisted, "populated={populated}");
        })
        .catch_unwind()
        .await;
        let context = format!("exact-health populated={populated}");
        if let Err(panic) = phase {
            let message = capture_assertion_message(panic);
            record_exact_health(directory, "original_assertion", &message);
            let cleanup_errors =
                close_exact_health_aggregate(handle, listener_addresses, &context).await;
            record_exact_health(
                directory,
                "phase_cleanup_errors",
                format!("{cleanup_errors:?}"),
            );
            cleanup_failure_errors.extend(cleanup_errors);
            assertion_failure = Some(message);
            break;
        }
        record_exact_health(directory, "phase_business_outcome", "passed");
        if populated && case == "assertion_shutdown_stall" {
            let assertion = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                assert!(
                    false,
                    "intentional exact-health assertion before stalled shutdown"
                );
            }))
            .expect_err("the intentional assertion must fail");
            let message = capture_assertion_message(assertion);
            record_exact_health(directory, "original_assertion", &message);
            record_exact_health(directory, "assertion_recorded_before_cleanup", true);
            record_exact_health(directory, "business_assertions", "passed");
            let receipt_hold = stall_exact_health_aggregate_shutdown(handle, directory).await;
            let restore_errors = env.restore();
            record_exact_health(
                directory,
                "env_restore_errors",
                format!("{restore_errors:?}"),
            );
            return ExactHealthChildOutcome {
                failure: None,
                receipt_hold: Some(receipt_hold),
            };
        }
        if populated && case == "cleanup_only_stall" {
            record_exact_health(directory, "business_assertions", "passed");
            let receipt_hold = stall_exact_health_aggregate_shutdown(handle, directory).await;
            let restore_errors = env.restore();
            record_exact_health(
                directory,
                "env_restore_errors",
                format!("{restore_errors:?}"),
            );
            return ExactHealthChildOutcome {
                failure: None,
                receipt_hold: Some(receipt_hold),
            };
        }
        let mut cleanup_errors =
            close_exact_health_aggregate(handle, listener_addresses, &context).await;
        if matches!(
            case,
            "returned_cleanup_failure" | "returned_cleanup_with_late_ingress"
        ) && populated
        {
            cleanup_errors.push("intentional returned cleanup failure".to_string());
        }
        record_exact_health(
            directory,
            "phase_cleanup_errors",
            format!("{cleanup_errors:?}"),
        );
        if !cleanup_errors.is_empty() {
            cleanup_failure_errors.extend(cleanup_errors);
            break;
        }
    }
    // Both aggregate phases have joined and released before this closeout
    // arrival. No producer can open another connection after shutdown.
    let late_arrival = if matches!(
        case,
        "late_upstream_arrival" | "returned_cleanup_with_late_ingress"
    ) {
        let socket = tokio::net::TcpStream::connect(upstream_addr)
            .await
            .expect("connect the intentional closeout arrival");
        record_exact_health(directory, "late_upstream_arrival", upstream_addr);
        Some(socket)
    } else {
        None
    };
    let closeout_errors =
        close_exact_health_upstream(shutdown, upstream_task, upstream_addr, case).await;
    let final_upstream_count = connections.load(Ordering::SeqCst);
    record_exact_health(directory, "final_upstream_count", final_upstream_count);
    if let Some(mut socket) = late_arrival {
        let mut byte = [0_u8; 1];
        let rejected = matches!(
            tokio::time::timeout(Duration::from_secs(2), socket.read(&mut byte)).await,
            Ok(Ok(0))
        );
        record_exact_health(directory, "late_upstream_arrival_rejected", rejected);
    }
    let restore_errors = env.restore();
    record_exact_health(
        directory,
        "env_restore_errors",
        format!("{restore_errors:?}"),
    );
    let final_ingress =
        std::panic::catch_unwind(|| assert_final_upstream_count(final_upstream_count));
    if let Err(panic) = final_ingress {
        let message = capture_assertion_message(panic);
        record_exact_health(directory, "final_ingress_assertion", &message);
        if assertion_failure.is_none() {
            record_exact_health(directory, "original_assertion", &message);
            assertion_failure = Some(message);
        }
    }
    let mut cleanup_errors = cleanup_failure_errors;
    cleanup_errors.extend(closeout_errors);
    cleanup_errors.extend(restore_errors);
    if !cleanup_errors.is_empty() {
        record_exact_health(directory, "cleanup_errors", format!("{cleanup_errors:?}"));
    }
    if assertion_failure.is_none() {
        record_exact_health(directory, "business_assertions", "passed");
    }
    if case == "legal_parent_assertion_failure" && assertion_failure.is_none() {
        let message = "intentional legal parent outcome failure";
        record_exact_health(directory, "original_assertion", message);
        assertion_failure = Some(message.to_string());
    }
    ExactHealthChildOutcome {
        failure: assertion_failure.or_else(|| {
            (!cleanup_errors.is_empty())
                .then(|| format!("exact-health cleanup failed: {cleanup_errors:?}"))
        }),
        receipt_hold: None,
    }
}

async fn bounded_raw_json_request(addr: std::net::SocketAddr) -> Vec<u8> {
    let body = serde_json::to_vec(&json!({"model":"client-test","input":"hello"})).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut socket = tokio::net::TcpStream::connect(addr)
            .await
            .expect("raw JSON client must connect");
        socket
            .write_all(
                format!(
                    "POST /v1/responses HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .expect("raw JSON client must write the request head");
        socket
            .write_all(&body)
            .await
            .expect("raw JSON client must write the request body");
        let mut wire = Vec::new();
        socket
            .read_to_end(&mut wire)
            .await
            .expect("raw JSON client must observe transport close");
        wire
    })
    .await
    .expect("raw JSON transport must terminate promptly")
}

async fn consume_failure(client: &reqwest::Client, addr: std::net::SocketAddr, streaming: bool) {
    if streaming {
        let endpoint = format!("http://{addr}/v1/responses");
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            client
                .post(&endpoint)
                .json(&json!({"model":"client-test","input":"hello","stream":true}))
                .send(),
        )
        .await
        .expect("request must terminate without reaching a transport timeout");
        let mut response = response.expect("SSE must have a transport response head");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut bytes = Vec::new();
        loop {
            match tokio::time::timeout_at(deadline, response.chunk())
                .await
                .expect("SSE must terminate")
            {
                Ok(Some(chunk)) => bytes.extend_from_slice(&chunk),
                Err(error) => {
                    assert!(!error.is_timeout(), "{error}");
                    break;
                }
                Ok(None) => panic!("SSE must abort rather than return clean EOF"),
            }
        }
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with(':'), "{text}");
        assert!(
            text.lines()
                .all(|line| line.is_empty() || line.starts_with(':')),
            "SSE must contain transport comments only: {text}"
        );
    } else {
        let wire = bounded_raw_json_request(addr).await;
        assert_zero_response_bytes(&wire, "raw JSON Target09 request");
    }
}

fn assert_terminal(diagnostic: &str, port: u16, expected: usize) {
    let lines = diagnostic
        .lines()
        .filter(|line| line.contains("v3 model transport terminal"))
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), expected, "{diagnostic}");
    let terminal = format!(
        "[{port}] v3 model transport terminal source_kind=RuntimeFailure source_stage=V3Target09CandidateSetExpanded code=target_resolution_candidate_expansion_failed message=provider test is absent or disabled"
    );
    assert!(lines.iter().all(|line| **line == terminal), "{diagnostic}");
}

const EXACT_HEALTH_CLOSEOUT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const EXACT_HEALTH_RELEASE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const EXACT_HEALTH_CHILD_CASE_ENV: &str = "TARGET_ORIGIN_EXACT_HEALTH_CHILD_CASE";
const EXACT_HEALTH_CHILD_DIR_ENV: &str = "TARGET_ORIGIN_EXACT_HEALTH_CHILD_DIR";
const EXACT_HEALTH_CHILD_HOME_ENV: &str = "TARGET_ORIGIN_EXACT_HEALTH_CHILD_HOME";
const EXACT_HEALTH_CHILD_TEST: &str =
    "tests::target_origin_health_neutrality::target_origin_exact_health_child";
const EXACT_HEALTH_LEGAL_CHILD_DEADLINE: Duration = Duration::from_secs(120);
const EXACT_HEALTH_STALL_CHILD_DEADLINE: Duration = Duration::from_secs(12);
const EXACT_HEALTH_CHILD_REAP_TIMEOUT: Duration = Duration::from_secs(5);

struct ExactHealthEnvGuard {
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    installed: bool,
}

impl ExactHealthEnvGuard {
    fn new(home: &std::path::Path) -> Self {
        let previous = vec![
            ("HOME", std::env::var_os("HOME")),
            (
                "TARGET_ORIGIN_HEALTH_KEY",
                std::env::var_os("TARGET_ORIGIN_HEALTH_KEY"),
            ),
            (
                "ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE",
                std::env::var_os("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE"),
            ),
        ];
        std::env::set_var("HOME", home);
        std::env::set_var("TARGET_ORIGIN_HEALTH_KEY", "test-only");
        std::env::remove_var("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE");
        Self {
            previous,
            installed: true,
        }
    }

    fn restore(&mut self) -> Vec<String> {
        let mut errors = Vec::new();
        for (name, value) in &self.previous {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        self.installed = false;
        for (name, value) in &self.previous {
            if std::env::var_os(name).as_ref() != value.as_ref() {
                errors.push(format!("{name} was not restored"));
            }
        }
        errors
    }
}

impl Drop for ExactHealthEnvGuard {
    fn drop(&mut self) {
        if self.installed {
            let _ = self.restore();
        }
    }
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| {
            panic
                .downcast_ref::<&str>()
                .map(|message| message.to_string())
        })
        .unwrap_or_else(|| "non-string panic payload".to_string())
}

fn wait_for_accept_ready_blocking(
    listener: &tokio::net::TcpListener,
    wait: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + wait;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!("listener was not accept-ready within {wait:?}"));
        }
        let mut descriptor = libc::pollfd {
            fd: listener.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe {
            libc::poll(
                &mut descriptor,
                1,
                remaining.as_millis().min(i32::MAX as u128) as i32,
            )
        };
        if result > 0 {
            if descriptor.revents & libc::POLLIN != 0 {
                return Ok(());
            }
            return Err(format!(
                "listener poll returned unexpected events={}",
                descriptor.revents
            ));
        }
        if result < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(format!("listener readiness poll failed: {error}"));
            }
        }
    }
}

fn record_exact_health(directory: &Path, key: &str, value: impl std::fmt::Display) {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("records.log"))
        .expect("open exact-health child record");
    std::io::Write::write_fmt(&mut file, format_args!("{key}={value}\n"))
        .expect("write exact-health child record");
    file.sync_all().expect("sync exact-health child record");
}

fn exact_health_records(directory: &Path) -> Vec<String> {
    std::fs::read_to_string(directory.join("records.log"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn exact_health_record_value<'a>(records: &'a [String], key: &str) -> Option<&'a str> {
    records.iter().find_map(|record| {
        let (record_key, value) = record.split_once('=')?;
        (record_key == key).then_some(value)
    })
}

fn exact_health_record_contains(records: &[String], expected: &str) -> bool {
    records.iter().any(|record| record == expected)
}

fn assert_final_upstream_count(count: usize) {
    assert_eq!(
        count, 0,
        "disabled provider received upstream arrivals before shutdown"
    );
}

fn exact_health_recorded_addresses(records: &[String]) -> Vec<std::net::SocketAddr> {
    let mut addresses = Vec::new();
    for record in records {
        let Some((key, value)) = record.split_once('=') else {
            continue;
        };
        if key != "listener_address" && key != "upstream_address" {
            continue;
        }
        let address = value.parse().unwrap_or_else(|error| {
            panic!("invalid recorded exact-health address {value:?}: {error}")
        });
        if !addresses.contains(&address) {
            addresses.push(address);
        }
    }
    addresses
}

fn wait_for_exact_health_address_released_blocking(
    address: std::net::SocketAddr,
    wait: Duration,
    context: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + wait;
    loop {
        match std::net::TcpListener::bind(address) {
            Ok(listener) => {
                drop(listener);
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "{context} address {address} was not released within {wait:?}"
                    ));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(format!("{context} address {address}: {error}")),
        }
    }
}

fn remove_exact_health_home(home: &Path) -> Vec<String> {
    let mut errors = Vec::new();
    match std::fs::remove_dir_all(home) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => errors.push(format!("remove exact-health HOME {home:?}: {error}")),
    }
    if home.exists() {
        errors.push(format!("exact-health HOME remains at {home:?}"));
    }
    errors
}

#[derive(Debug)]
struct ExactHealthSupervisedRun {
    case: &'static str,
    child_pid: u32,
    child_success: bool,
    child_exit: Option<ExitStatus>,
    forced_termination: bool,
    reaped: bool,
    records: Vec<String>,
    child_stdout: String,
    child_stderr: String,
    cleanup_errors: Vec<String>,
    home_absent: bool,
    case_directory_absent: bool,
    case_directory: PathBuf,
}

fn supervise_exact_health_child(
    case: &'static str,
    deadline: Duration,
) -> ExactHealthSupervisedRun {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after the Unix epoch")
        .as_nanos();
    let case_directory = std::env::temp_dir().join(format!(
        "target-origin-exact-health-supervisor-{}-{nonce}-{case}",
        std::process::id()
    ));
    let home = case_directory.join("home");
    eprintln!("exact-health owned case={case} directory={case_directory:?} home={home:?}");
    std::fs::create_dir_all(&home).expect("create parent-owned exact-health HOME");
    std::fs::write(case_directory.join("records.log"), [])
        .expect("create exact-health child record file");
    let stdout_path = case_directory.join("child.stdout.log");
    let stderr_path = case_directory.join("child.stderr.log");
    let stdout = std::fs::File::create(&stdout_path).expect("create child stdout log");
    let stderr = std::fs::File::create(&stderr_path).expect("create child stderr log");
    let mut child = Command::new(std::env::current_exe().expect("locate test executable"))
        .args([
            "--exact",
            EXACT_HEALTH_CHILD_TEST,
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(EXACT_HEALTH_CHILD_CASE_ENV, case)
        .env(EXACT_HEALTH_CHILD_DIR_ENV, &case_directory)
        .env(EXACT_HEALTH_CHILD_HOME_ENV, &home)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .expect("spawn one owned exact-health child");
    let child_pid = child.id();
    record_exact_health(&case_directory, "supervisor_child_pid", child_pid);
    let started_at = Instant::now();
    let deadline_at = started_at + deadline;
    record_exact_health(
        &case_directory,
        "supervisor_deadline_ms",
        deadline.as_millis(),
    );
    let mut forced_termination = false;
    let mut supervision_errors = Vec::new();
    let child_exit = 'supervise: loop {
        match child.try_wait() {
            Ok(Some(status)) => break 'supervise Some(status),
            Ok(None) => {}
            Err(error) => {
                supervision_errors.push(format!("poll child PID {child_pid}: {error}"));
            }
        }
        if Instant::now() >= deadline_at {
            forced_termination = true;
            record_exact_health(&case_directory, "supervisor_deadline_reached", case);
            if let Err(error) = child.kill() {
                supervision_errors.push(format!("terminate child PID {child_pid}: {error}"));
            }
            record_exact_health(
                &case_directory,
                "supervisor_child_terminate_requested",
                child_pid,
            );
            let reap_deadline = Instant::now() + EXACT_HEALTH_CHILD_REAP_TIMEOUT;
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => break 'supervise Some(status),
                    Ok(None) => {}
                    Err(error) => {
                        supervision_errors.push(format!("reap child PID {child_pid}: {error}"));
                        break 'supervise None;
                    }
                }
                if Instant::now() >= reap_deadline {
                    break 'supervise None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let reaped = child_exit.is_some();
    if !reaped {
        record_exact_health(&case_directory, "supervisor_child_reap_timeout", child_pid);
    } else if let Some(status) = child_exit.as_ref() {
        record_exact_health(&case_directory, "supervisor_child_exit", status);
    }
    let records = exact_health_records(&case_directory);
    let mut cleanup_errors = supervision_errors;
    if reaped {
        for address in exact_health_recorded_addresses(&records) {
            match wait_for_exact_health_address_released_blocking(
                address,
                EXACT_HEALTH_RELEASE_TIMEOUT,
                case,
            ) {
                Ok(()) => {
                    record_exact_health(&case_directory, "parent_address_released", address);
                    eprintln!("exact-health child={case} address={address} released=true");
                }
                Err(error) => cleanup_errors.push(error),
            }
        }
        if exact_health_recorded_addresses(&records).is_empty() {
            cleanup_errors.push(format!("exact-health child={case} recorded no addresses"));
        }
        cleanup_errors.extend(remove_exact_health_home(&home));
    } else {
        cleanup_errors.push(format!(
            "child PID {child_pid} was not reaped; retained {case_directory:?}"
        ));
    }
    let child_success = child_exit.is_some_and(|status| status.success());
    let home_absent = reaped && !home.exists();
    record_exact_health(&case_directory, "parent_home_absent", home_absent);
    record_exact_health(
        &case_directory,
        "supervisor_elapsed_ms",
        started_at.elapsed().as_millis(),
    );
    let records = exact_health_records(&case_directory);
    let child_stdout = std::fs::read_to_string(stdout_path).unwrap_or_default();
    let child_stderr = std::fs::read_to_string(stderr_path).unwrap_or_default();
    let case_directory_absent = if reaped {
        cleanup_errors.extend(remove_exact_health_case_directory(&case_directory));
        !case_directory.exists()
    } else {
        false
    };
    eprintln!(
        "exact-health supervisor case={case} pid={child_pid} exit={child_exit:?} forced={forced_termination} reaped={reaped} home_absent={home_absent} case_directory_absent={case_directory_absent} cleanup={cleanup_errors:?}"
    );
    eprintln!("exact-health child stdout:\n{child_stdout}");
    eprintln!("exact-health child stderr:\n{child_stderr}");
    eprintln!("exact-health records:\n{}", records.join("\n"));
    ExactHealthSupervisedRun {
        case,
        child_pid,
        child_success,
        child_exit,
        forced_termination,
        reaped,
        records,
        child_stdout,
        child_stderr,
        cleanup_errors,
        home_absent,
        case_directory_absent,
        case_directory,
    }
}

fn exact_health_failure(run: &ExactHealthSupervisedRun) -> Option<String> {
    // The business assertion is primary even when cleanup or reaping fails.
    let child_cleanup = run
        .records
        .iter()
        .filter(|record| {
            let Some((key, value)) = record.split_once('=') else {
                return false;
            };
            matches!(
                key,
                "phase_cleanup_errors"
                    | "cleanup_errors"
                    | "cleanup_timeout"
                    | "env_restore_errors"
            ) && value != "[]"
        })
        .collect::<Vec<_>>();
    let secondary = format!(
        "case={} pid={} forced={} reaped={} cleanup={:?} child_cleanup={child_cleanup:?}",
        run.case, run.child_pid, run.forced_termination, run.reaped, run.cleanup_errors,
    );
    if let Some(original) = exact_health_record_value(&run.records, "original_assertion") {
        return Some(format!("{original}; {secondary}"));
    }
    if let Some(cleanup) = exact_health_record_value(&run.records, "cleanup_errors") {
        return Some(format!("cleanup failed: {cleanup}; {secondary}"));
    }
    if let Some(cleanup) = exact_health_record_value(&run.records, "cleanup_timeout") {
        return Some(format!("cleanup failed: {cleanup}; {secondary}"));
    }
    if !run.cleanup_errors.is_empty() {
        return Some(format!(
            "cleanup failed: {}; {secondary}",
            run.cleanup_errors.join("; ")
        ));
    }
    if !run.child_success || run.forced_termination {
        return Some(format!(
            "pending stage={}; {secondary}",
            run.records
                .iter()
                .rev()
                .find_map(|record| record.strip_prefix("stage="))
                .unwrap_or("child execution")
        ));
    }
    None
}

fn assert_exact_health_run_clean(run: &ExactHealthSupervisedRun) {
    assert!(
        run.reaped,
        "case={} child={} exit={:?} was not reaped; stdout={} stderr={} retained={:?}",
        run.case,
        run.child_pid,
        run.child_exit,
        run.child_stdout,
        run.child_stderr,
        run.case_directory
    );
    assert!(
        run.cleanup_errors.is_empty(),
        "case={} child={} home_absent={} cleanup failed: {:?}; records={:?}; stdout={} stderr={} retained={:?}",
        run.case,
        run.child_pid,
        run.home_absent,
        run.cleanup_errors,
        run.records,
        run.child_stdout,
        run.child_stderr,
        run.case_directory
    );
    assert!(
        run.home_absent,
        "case={} child={} parent-owned HOME remains; records={:?}; retained={:?}",
        run.case, run.child_pid, run.records, run.case_directory
    );
    assert!(
        exact_health_record_contains(&run.records, "parent_home_absent=true"),
        "case={} child={} parent HOME release was not captured; records={:?}",
        run.case,
        run.child_pid,
        run.records
    );
    for address in exact_health_recorded_addresses(&run.records) {
        assert!(
            exact_health_record_contains(
                &run.records,
                &format!("parent_address_released={address}")
            ),
            "case={} child={} address {address} release was not captured; records={:?}",
            run.case,
            run.child_pid,
            run.records
        );
    }
    assert!(
        run.case_directory_absent,
        "case={} child={} case directory remains; cleanup={:?}; retained={:?}",
        run.case, run.child_pid, run.cleanup_errors, run.case_directory
    );
}

fn remove_exact_health_case_directory(case_directory: &Path) -> Vec<String> {
    let mut errors = Vec::new();
    match std::fs::remove_dir_all(case_directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => errors.push(format!(
            "remove supervised exact-health directory {case_directory:?}: {error}"
        )),
    }
    if case_directory.exists() {
        errors.push(format!(
            "supervised exact-health directory remains at {case_directory:?}"
        ));
    }
    errors
}

async fn wait_for_exact_health_address_released(
    address: std::net::SocketAddr,
    wait: std::time::Duration,
    context: &str,
) -> Result<(), String> {
    tokio::time::timeout(wait, async {
        loop {
            match tokio::net::TcpListener::bind(address).await {
                Ok(listener) => {
                    drop(listener);
                    return Ok(());
                }
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                Err(error) => return Err(format!("{context} address {address}: {error}")),
            }
        }
    })
    .await
    .unwrap_or_else(|_| {
        Err(format!(
            "{context} address {address} was not released within {wait:?}"
        ))
    })
}

async fn close_exact_health_aggregate(
    handle: V3ServerAggregateHandle,
    addresses: Vec<std::net::SocketAddr>,
    context: &str,
) -> Vec<String> {
    let mut errors = Vec::new();
    let shutdown = tokio::time::timeout(
        EXACT_HEALTH_CLOSEOUT_TIMEOUT,
        std::panic::AssertUnwindSafe(handle.shutdown()).catch_unwind(),
    )
    .await;
    match shutdown {
        Ok(Ok(failures)) => {
            errors.extend(
                failures
                    .into_iter()
                    .map(|failure| format!("{context} aggregate shutdown failure: {failure:?}")),
            );
        }
        Ok(Err(panic)) => errors.push(format!(
            "{context} aggregate shutdown panicked: {}",
            panic_message(panic.as_ref())
        )),
        Err(_) => errors.push(format!(
            "{context} aggregate shutdown exceeded {EXACT_HEALTH_CLOSEOUT_TIMEOUT:?}"
        )),
    }
    for address in addresses {
        match wait_for_exact_health_address_released(address, EXACT_HEALTH_RELEASE_TIMEOUT, context)
            .await
        {
            Ok(()) => eprintln!("{context} aggregate address={address} released=true"),
            Err(error) => errors.push(error),
        }
    }
    errors
}

async fn reject_upstream_connection(mut socket: tokio::net::TcpStream, seen: &AtomicUsize) {
    seen.fetch_add(1, Ordering::SeqCst);
    let _ = socket.shutdown().await;
}

async fn run_exact_health_upstream(
    listener: tokio::net::TcpListener,
    mut shutdown_rx: oneshot::Receiver<()>,
    seen: Arc<AtomicUsize>,
) -> Result<(), String> {
    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown_rx => break,
            accepted = listener.accept() => {
                let (socket, _) = accepted.map_err(|error| format!("upstream accept failed: {error}"))?;
                reject_upstream_connection(socket, &seen).await;
            }
        }
    }
    // Producers have stopped before shutdown is sent. Drain the actual OS
    // backlog, not Tokio readiness (which may not yet have been delivered).
    let listener = listener
        .into_std()
        .map_err(|error| format!("upstream closeout listener conversion failed: {error}"))?;
    let deadline = Instant::now() + EXACT_HEALTH_CLOSEOUT_TIMEOUT;
    loop {
        match listener.accept() {
            Ok((socket, _)) => {
                seen.fetch_add(1, Ordering::SeqCst);
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(format!("upstream closeout accept failed: {error}")),
        }
        if Instant::now() >= deadline {
            return Err("upstream closeout backlog drain exceeded its deadline".to_string());
        }
    }
    drop(listener);
    Ok(())
}

async fn close_exact_health_upstream(
    shutdown: oneshot::Sender<()>,
    mut task: tokio::task::JoinHandle<Result<(), String>>,
    address: std::net::SocketAddr,
    context: &str,
) -> Vec<String> {
    let mut errors = Vec::new();
    if shutdown.send(()).is_err() {
        errors.push(format!("{context} upstream shutdown receiver was lost"));
    }
    match tokio::time::timeout(EXACT_HEALTH_CLOSEOUT_TIMEOUT, &mut task).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(error))) => errors.push(format!("{context} upstream task failed: {error}")),
        Ok(Err(error)) => errors.push(format!("{context} upstream join failed: {error}")),
        Err(_) => {
            task.abort();
            match tokio::time::timeout(EXACT_HEALTH_CLOSEOUT_TIMEOUT, task).await {
                Ok(Ok(Ok(()))) => errors.push(format!(
                    "{context} upstream shutdown exceeded {EXACT_HEALTH_CLOSEOUT_TIMEOUT:?}; aborted task joined"
                )),
                Ok(Ok(Err(error))) => errors.push(format!(
                    "{context} upstream shutdown timed out and aborted task failed: {error}"
                )),
                Ok(Err(error)) => errors.push(format!(
                    "{context} upstream shutdown timed out and aborted task join failed: {error}"
                )),
                Err(_) => errors.push(format!(
                    "{context} aborted upstream task did not join within {EXACT_HEALTH_CLOSEOUT_TIMEOUT:?}"
                )),
            }
        }
    }
    if let Err(error) =
        wait_for_exact_health_address_released(address, EXACT_HEALTH_RELEASE_TIMEOUT, context).await
    {
        errors.push(error);
    } else {
        eprintln!("{context} upstream address={address} released=true");
    }
    errors
}

fn resume_first_exact_health_panic(
    result: Result<(), Box<dyn std::any::Any + Send>>,
    cleanup_errors: Vec<String>,
    context: &str,
) {
    if let Err(panic) = result {
        if !cleanup_errors.is_empty() {
            eprintln!(
                "{context}: cleanup also failed while preserving original assertion: {cleanup_errors:?}"
            );
        }
        std::panic::resume_unwind(panic);
    }
    assert!(
        cleanup_errors.is_empty(),
        "{context} cleanup failed: {cleanup_errors:?}"
    );
}

#[tokio::test]
async fn partial_http_head_fails_zero_byte_wire_assertion() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 1024];
        socket.read(&mut request).await.unwrap();
        socket.write_all(b"HTTP/1.1 200 OK\r\n").await.unwrap();
        socket.shutdown().await.unwrap();
    });
    let wire = bounded_raw_json_request(address).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .expect("partial-head upstream must shut down")
        .unwrap();
    assert!(std::net::TcpListener::bind(address).is_ok());
    let panic = std::panic::catch_unwind(|| {
        assert_zero_response_bytes(&wire, "partial JSON head");
    })
    .unwrap_err();
    let message = panic
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| {
            panic
                .downcast_ref::<&str>()
                .map(|message| message.to_string())
        })
        .unwrap();
    assert!(
        message.contains("must close without any response bytes"),
        "{message}"
    );
}

#[test]
fn target_origin_json_and_sse_leave_exact_aggregate_health_and_persistence_unchanged() {
    let run = supervise_exact_health_child("legal", EXACT_HEALTH_LEGAL_CHILD_DEADLINE);
    let failure = exact_health_failure(&run);
    assert!(
        failure.is_none(),
        "{}; child stderr={}",
        failure.unwrap_or_default(),
        run.child_stderr
    );
    assert_exact_health_run_clean(&run);
    assert!(run.child_success, "legal child must exit normally: {run:?}");
    assert!(
        !run.forced_termination,
        "legal child must not require the parent deadline"
    );
    assert!(exact_health_record_contains(
        &run.records,
        "child_outcome=passed"
    ));
    assert_eq!(
        exact_health_record_value(&run.records, "final_upstream_count"),
        Some("0")
    );
}

#[test]
fn failed_legal_parent_outcome_finalizes_case_before_wrapper_assertion() {
    let run = supervise_exact_health_child(
        "legal_parent_assertion_failure",
        EXACT_HEALTH_LEGAL_CHILD_DEADLINE,
    );
    assert_exact_health_run_clean(&run);
    let failure = exact_health_failure(&run).expect("the intentional outcome must fail");
    assert!(
        failure.starts_with("intentional legal parent outcome failure;"),
        "{failure}"
    );
    let wrapper_assertion = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert!(exact_health_failure(&run).is_none());
    }));
    assert!(wrapper_assertion.is_err());
    assert!(run.case_directory_absent);
}

#[test]
fn returned_cleanup_failure_is_classified_and_released() {
    let run = supervise_exact_health_child(
        "returned_cleanup_failure",
        EXACT_HEALTH_LEGAL_CHILD_DEADLINE,
    );
    assert_exact_health_run_clean(&run);
    let failure = exact_health_failure(&run).expect("the returned cleanup failure must fail");
    assert!(
        failure.starts_with("cleanup failed: [\"intentional returned cleanup failure\"];"),
        "{failure}"
    );
    assert!(exact_health_record_value(&run.records, "original_assertion").is_none());
    assert_eq!(
        run.records
            .iter()
            .filter(|record| record.as_str() == "phase_business_outcome=passed")
            .count(),
        2
    );
    assert!(exact_health_record_contains(
        &run.records,
        "phase_cleanup_errors=[\"intentional returned cleanup failure\"]"
    ));
    assert!(!run.forced_termination);
    assert!(run.case_directory_absent);
}

#[test]
fn reaped_early_exit_without_address_finalizes_case_directory() {
    let run = supervise_exact_health_child(
        "early_exit_without_address",
        EXACT_HEALTH_LEGAL_CHILD_DEADLINE,
    );
    assert!(run.reaped, "{run:?}");
    assert!(!run.forced_termination, "{run:?}");
    assert!(!run.child_success, "{run:?}");
    assert!(exact_health_recorded_addresses(&run.records).is_empty());
    assert!(exact_health_record_contains(
        &run.records,
        "child_exit_before_address_record=true"
    ));
    assert!(
        run.cleanup_errors
            .iter()
            .any(|error| error.contains("recorded no addresses")),
        "{run:?}"
    );
    assert!(run.home_absent, "{run:?}");
    assert!(
        run.child_stderr
            .contains("intentional child exit before recording an address")
    );
    assert!(
        exact_health_failure(&run)
            .expect("the no-address failure must remain explicit")
            .contains("recorded no addresses")
    );
    assert!(run.case_directory_absent, "{run:?}");
}

#[test]
fn returned_cleanup_and_late_ingress_keep_genuine_assertion_primary() {
    let run = supervise_exact_health_child(
        "returned_cleanup_with_late_ingress",
        EXACT_HEALTH_LEGAL_CHILD_DEADLINE,
    );
    assert_exact_health_run_clean(&run);
    assert!(!run.forced_termination, "{run:?}");
    assert!(!run.child_success, "{run:?}");
    assert_eq!(
        exact_health_record_value(&run.records, "final_upstream_count"),
        Some("1")
    );
    assert!(exact_health_record_contains(
        &run.records,
        "late_upstream_arrival_rejected=true"
    ));
    assert!(exact_health_record_contains(
        &run.records,
        "phase_cleanup_errors=[\"intentional returned cleanup failure\"]"
    ));
    assert!(exact_health_record_contains(
        &run.records,
        "cleanup_errors=[\"intentional returned cleanup failure\"]"
    ));
    let failure = exact_health_failure(&run).expect("both injected failures must be reported");
    assert!(!failure.starts_with("cleanup failed:"), "{failure}");
    assert!(
        failure.contains("disabled provider received upstream arrivals"),
        "{failure}"
    );
    assert!(
        failure.contains("intentional returned cleanup failure"),
        "{failure}"
    );
    assert_eq!(
        exact_health_record_value(&run.records, "original_assertion"),
        exact_health_record_value(&run.records, "final_ingress_assertion")
    );
    assert!(run.case_directory_absent);
}

#[test]
#[ignore]
fn target_origin_exact_health_child() {
    run_exact_health_child_wrapper();
}

#[test]
fn direct_persistence_flush_stall_is_terminated_reaped_and_released() {
    let run = supervise_exact_health_child("direct_flush_stall", EXACT_HEALTH_STALL_CHILD_DEADLINE);
    assert_exact_health_run_clean(&run);
    assert!(run.forced_termination);
    assert!(!run.child_success);
    assert!(exact_health_record_contains(
        &run.records,
        "persistence_hold_armed=direct_baseline_flush"
    ));
    assert!(exact_health_record_contains(
        &run.records,
        "persistence_hold_reached=direct_baseline_flush"
    ));
    assert!(exact_health_record_contains(
        &run.records,
        "stage=direct_baseline_flush_pending"
    ));
    assert!(
        exact_health_failure(&run)
            .unwrap()
            .starts_with("pending stage=direct_baseline_flush_pending;")
    );
    assert!(exact_health_record_value(&run.records, "business_assertions").is_none());
    assert!(
        exact_health_record_value(&run.records, "direct_flush_returned_unexpectedly").is_none()
    );
}

#[test]
fn assertion_survives_shutdown_persistence_stall_and_child_release() {
    let run = supervise_exact_health_child(
        "assertion_shutdown_stall",
        EXACT_HEALTH_STALL_CHILD_DEADLINE,
    );
    assert_exact_health_run_clean(&run);
    assert!(run.forced_termination);
    assert!(!run.child_success);
    assert_eq!(
        exact_health_record_value(&run.records, "original_assertion"),
        Some("intentional exact-health assertion before stalled shutdown")
    );
    assert!(exact_health_record_contains(
        &run.records,
        "assertion_recorded_before_cleanup=true"
    ));
    assert!(exact_health_record_contains(
        &run.records,
        "cleanup_timeout=aggregate_shutdown"
    ));
    assert!(exact_health_record_contains(
        &run.records,
        "persistence_hold_reached=aggregate_shutdown"
    ));
    assert!(exact_health_record_contains(
        &run.records,
        "runtime_drop_begin=true"
    ));
    assert!(
        exact_health_record_value(&run.records, "runtime_drop_completed_unexpectedly").is_none()
    );
    assert!(
        exact_health_failure(&run)
            .unwrap()
            .starts_with("intentional exact-health assertion before stalled shutdown;")
    );
}

#[test]
fn cleanup_only_shutdown_persistence_stall_is_bounded_and_released() {
    let run = supervise_exact_health_child("cleanup_only_stall", EXACT_HEALTH_STALL_CHILD_DEADLINE);
    assert_exact_health_run_clean(&run);
    assert!(run.forced_termination);
    assert!(!run.child_success);
    assert!(exact_health_record_value(&run.records, "original_assertion").is_none());
    assert!(exact_health_record_contains(
        &run.records,
        "business_assertions=passed"
    ));
    assert!(exact_health_record_contains(
        &run.records,
        "cleanup_timeout=aggregate_shutdown"
    ));
    assert!(exact_health_record_contains(
        &run.records,
        "persistence_hold_reached=aggregate_shutdown"
    ));
    assert!(exact_health_record_contains(
        &run.records,
        "runtime_drop_begin=true"
    ));
    assert!(
        exact_health_record_value(&run.records, "runtime_drop_completed_unexpectedly").is_none()
    );
    assert!(
        exact_health_failure(&run)
            .unwrap()
            .starts_with("cleanup failed: aggregate_shutdown;")
    );
}

#[test]
fn late_upstream_arrival_fails_final_zero_count_after_join_and_releases_child() {
    let run =
        supervise_exact_health_child("late_upstream_arrival", EXACT_HEALTH_LEGAL_CHILD_DEADLINE);
    assert_exact_health_run_clean(&run);
    assert!(!run.forced_termination);
    assert!(!run.child_success);
    assert_eq!(
        exact_health_record_value(&run.records, "final_upstream_count"),
        Some("1")
    );
    assert!(exact_health_record_contains(
        &run.records,
        "late_upstream_arrival_rejected=true"
    ));
    assert!(
        exact_health_failure(&run)
            .unwrap()
            .contains("disabled provider received upstream arrivals")
    );
}

#[tokio::test]
async fn queued_upstream_arrival_during_ready_shutdown_is_counted_and_released() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
    wait_for_accept_ready_blocking(&listener, Duration::from_secs(5))
        .expect("queued upstream arrival must become accept-ready");
    let connections = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&connections);
    let (shutdown, shutdown_rx) = oneshot::channel();
    shutdown.send(()).unwrap();
    let task = tokio::spawn(run_exact_health_upstream(listener, shutdown_rx, seen));
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("ready-shutdown closeout must be bounded")
        .expect("upstream task must join");
    assert_eq!(result, Ok(()));
    assert_eq!(
        connections.load(Ordering::SeqCst),
        1,
        "a queued arrival must win the biased closeout drain"
    );
    let mut byte = [0_u8; 1];
    match tokio::time::timeout(Duration::from_secs(5), client.read(&mut byte)).await {
        Ok(Ok(0)) => {}
        Ok(Ok(read)) => panic!("upstream closeout returned {read} bytes"),
        Ok(Err(error))
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
            ) => {}
        Ok(Err(error)) => panic!("queued upstream arrival was not cleanly rejected: {error}"),
        Err(_) => panic!("queued upstream arrival remained open during closeout"),
    }
    eprintln!("ready-shutdown queued arrival address={address} count=1 rejected=true");
    wait_for_exact_health_address_released(
        address,
        EXACT_HEALTH_RELEASE_TIMEOUT,
        "ready-shutdown queued arrival",
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn exact_health_cleanup_failure_preserves_assertion_and_restores_environment() {
    let _lock = TEST_HOME_LOCK.lock().unwrap();
    let home = std::env::temp_dir().join(format!(
        "target-origin-health-neutrality-cleanup-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let original_key = std::env::var_os("TARGET_ORIGIN_HEALTH_KEY");
    let original_state = std::env::var_os("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE");
    let original_home = std::env::var_os("HOME");
    let mut env = ExactHealthEnvGuard::new(&home);
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_address = upstream.local_addr().unwrap();
    let (shutdown, shutdown_rx) = oneshot::channel();
    let upstream_task = tokio::spawn(run_exact_health_upstream(
        upstream,
        shutdown_rx,
        Arc::new(AtomicUsize::new(0)),
    ));
    let handle =
        spawn_v3_server_aggregate(manifest(&home, upstream_address, free_port(), free_port()))
            .await
            .unwrap();
    let addresses = handle
        .listeners
        .iter()
        .map(|listener| listener.addr)
        .collect();

    let assertion = std::panic::AssertUnwindSafe(async {
        assert!(false, "intentional exact-health assertion failure");
    })
    .catch_unwind()
    .await;

    let held_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let held_address = held_listener.local_addr().unwrap();
    let closeout_error = wait_for_exact_health_address_released(
        held_address,
        std::time::Duration::from_millis(100),
        "intentional exact-health cleanup counterexample",
    )
    .await
    .expect_err("an intentionally held address must produce a bounded closeout failure");
    drop(held_listener);
    wait_for_exact_health_address_released(
        held_address,
        EXACT_HEALTH_RELEASE_TIMEOUT,
        "intentional exact-health cleanup counterexample",
    )
    .await
    .unwrap();

    let mut cleanup_errors =
        close_exact_health_aggregate(handle, addresses, "exact-health assertion counterexample")
            .await;
    cleanup_errors.extend(
        close_exact_health_upstream(
            shutdown,
            upstream_task,
            upstream_address,
            "exact-health assertion counterexample",
        )
        .await,
    );
    let real_resources_released = cleanup_errors.is_empty();
    cleanup_errors.extend(env.restore());
    cleanup_errors.extend(remove_exact_health_home(&home));
    cleanup_errors.push(closeout_error);
    let preserved = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        resume_first_exact_health_panic(
            assertion,
            cleanup_errors,
            "exact-health cleanup counterexample",
        )
    }));
    let panic = preserved.expect_err("the original assertion panic must be resumed");
    assert!(panic_message(panic.as_ref()).contains("intentional exact-health assertion failure"));
    assert_eq!(std::env::var_os("HOME"), original_home);
    assert_eq!(std::env::var_os("TARGET_ORIGIN_HEALTH_KEY"), original_key);
    assert_eq!(
        std::env::var_os("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE"),
        original_state
    );
    assert!(!home.exists(), "cleanup counterexample HOME must be absent");
    assert!(
        real_resources_released,
        "real fixture resources must release"
    );
    eprintln!(
        "exact-health assertion counterexample: original_panic_preserved=true env_restored=true home_removed=true held_address={held_address} released=true bounded_closeout_failure=true"
    );

    let cleanup_only = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        resume_first_exact_health_panic(
            Ok(()),
            vec!["intentional cleanup-only failure".to_string()],
            "exact-health cleanup-only counterexample",
        )
    }));
    let panic = cleanup_only.expect_err("cleanup-only failure must fail the test");
    assert!(panic_message(panic.as_ref()).contains("cleanup failed"));
}
