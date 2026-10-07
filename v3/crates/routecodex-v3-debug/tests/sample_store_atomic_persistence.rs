use routecodex_v3_debug::{V3CodexSamplePersistJob, V3CodexSampleStore};
use serde_json::json;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

const CHILD_MODE_ENV: &str = "S21_ATOMIC_PERSIST_CHILD_MODE";
const CHILD_EXE_ENV: &str = "S21_ATOMIC_PERSIST_CHILD_EXE";
const REQUEST_ID: &str = "s21-atomic-request";
const FILE_NAME: &str = "request.json";
const ENDPOINT: &str = "/v1/responses";

static NEXT_HOME_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static HOME_LOCK: Mutex<()> = Mutex::new(());

struct IsolatedHome {
    base: PathBuf,
    previous_home: Option<std::ffi::OsString>,
    _home_guard: MutexGuard<'static, ()>,
}

impl IsolatedHome {
    fn new() -> Self {
        let home_guard = HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let sequence = NEXT_HOME_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "s21-sample-atomic-persistence-{}-{sequence}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let home = base.join("home");
        fs::create_dir_all(&home).unwrap();
        let previous_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &home);
        Self {
            base,
            previous_home,
            _home_guard: home_guard,
        }
    }

    fn root(&self) -> PathBuf {
        self.base.join("home").join(".rcc").join("codex-samples")
    }

    fn request_dir(&self) -> PathBuf {
        self.root()
            .join("openai-responses")
            .join("ports")
            .join("10000")
            .join(REQUEST_ID)
    }

    fn sample_path(&self) -> PathBuf {
        self.request_dir().join(FILE_NAME)
    }
}

impl Drop for IsolatedHome {
    fn drop(&mut self) {
        if let Some(previous) = self.previous_home.take() {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn large_payload() -> serde_json::Value {
    json!({
        "marker": "replacement-must-not-publish-partial-json",
        "padding": "x".repeat(16 * 1024),
    })
}

fn spawn_child_under_file_size_limit(home: &IsolatedHome, mode: &str) -> std::process::Output {
    let executable = std::env::current_exe().expect("integration test executable");
    Command::new("/bin/sh")
        .arg("-c")
        .arg(
            "ulimit -f 1 || exit 125; trap '' XFSZ; exec \"$S21_ATOMIC_PERSIST_CHILD_EXE\" \
             --exact s21_atomic_persistence_child_helper --nocapture",
        )
        .env("HOME", home.base.join("home"))
        .env(CHILD_MODE_ENV, mode)
        .env(CHILD_EXE_ENV, executable)
        .output()
        .expect("run fault-injected child")
}

fn assert_no_owned_temp(request_dir: &Path) {
    let names = fs::read_dir(request_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(
        names.iter().all(|name| !name.contains(".tmp-")),
        "owned temporary file was not removed: {names:?}"
    );
}

#[test]
fn s21_atomic_persistence_child_helper() {
    let Ok(mode) = std::env::var(CHILD_MODE_ENV) else {
        return;
    };
    std::env::var(CHILD_EXE_ENV).expect("child executable marker");
    match mode.as_str() {
        "direct" => {
            let store = V3CodexSampleStore::new(true, 100, false);
            let result = store.persist(
                10000,
                "responses",
                ENDPOINT,
                REQUEST_ID,
                FILE_NAME,
                &large_payload(),
                false,
                None,
            );
            println!("S21_CHILD_DIRECT_RESULT={result:?}");
        }
        "async" => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            let failures = runtime.block_on(async {
                let store = Arc::new(V3CodexSampleStore::new(true, 100, false));
                let mut handle = store.start_persist_worker().unwrap();
                store
                    .enqueue_persist(V3CodexSamplePersistJob {
                        port: 10000,
                        entry_protocol: "responses".to_string(),
                        endpoint: ENDPOINT.to_string(),
                        request_id: REQUEST_ID.to_string(),
                        file_name: FILE_NAME.to_string(),
                        payload: Arc::new(large_payload()),
                        force: false,
                        status: None,
                    })
                    .unwrap();
                handle.shutdown().await
            });
            println!("S21_CHILD_ASYNC_FAILURES={}", failures.len());
            if let Some(failure) = failures.first() {
                println!("S21_CHILD_ASYNC_REASON={}", failure.reason);
            }
        }
        unexpected => panic!("unexpected child mode: {unexpected}"),
    }
}

#[test]
fn partial_persist_failure_preserves_complete_old_json_and_owned_temp() {
    let home = IsolatedHome::new();
    let store = V3CodexSampleStore::new(true, 100, false);
    let old_payload = json!({"marker": "old-complete-sample", "value": 41});
    store
        .persist(
            10000,
            "responses",
            ENDPOINT,
            REQUEST_ID,
            FILE_NAME,
            &old_payload,
            false,
            None,
        )
        .unwrap();
    let path = home.sample_path();
    let old_bytes = fs::read(&path).unwrap();

    let output = spawn_child_under_file_size_limit(&home, "direct");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "fault-injected child did not execute: status={:?}\nstdout={stdout}\nstderr={stderr}",
        output.status
    );
    assert!(
        stdout.contains("S21_CHILD_DIRECT_RESULT=Err"),
        "partial write must return an explicit error:\nstdout={stdout}\nstderr={stderr}"
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        old_bytes,
        "partial replacement changed the complete old sample"
    );
    assert_no_owned_temp(&home.request_dir());
}

#[test]
fn async_worker_failure_keeps_complete_old_json_and_reports_shutdown_failure() {
    let home = IsolatedHome::new();
    let store = V3CodexSampleStore::new(true, 100, false);
    let old_payload = json!({"marker": "old-complete-sample", "value": 42});
    store
        .persist(
            10000,
            "responses",
            ENDPOINT,
            REQUEST_ID,
            FILE_NAME,
            &old_payload,
            false,
            None,
        )
        .unwrap();
    let path = home.sample_path();
    let old_bytes = fs::read(&path).unwrap();

    let output = spawn_child_under_file_size_limit(&home, "async");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "fault-injected child did not execute: status={:?}\nstdout={stdout}\nstderr={stderr}",
        output.status
    );
    assert!(
        stdout.contains("S21_CHILD_ASYNC_FAILURES=1"),
        "worker shutdown must expose the write failure:\nstdout={stdout}\nstderr={stderr}"
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        old_bytes,
        "async partial replacement changed the complete old sample"
    );
    assert_no_owned_temp(&home.request_dir());
}

#[test]
fn distinct_provider_attempts_merge_once_and_preserve_private_file_mode() {
    let home = IsolatedHome::new();
    let store = V3CodexSampleStore::new(true, 100, false);
    let first = json!({
        "object": "routecodex.v3.provider_request_snapshots",
        "stage": "provider-request",
        "attempts": [{"attempt": 1, "request": {"providerId": "opencode-go"}}]
    });
    let second = json!({
        "object": "routecodex.v3.provider_request_snapshots",
        "stage": "provider-request",
        "attempts": [{"attempt": 2, "request": {"providerId": "opencode-go-zen"}}]
    });

    for payload in [&first, &second, &second] {
        store
            .persist(
                10000,
                "responses",
                ENDPOINT,
                REQUEST_ID,
                "provider-request.json",
                payload,
                false,
                None,
            )
            .unwrap();
    }

    let path = home.request_dir().join("provider-request.json");
    let persisted: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["attempts"].as_array().unwrap().len(), 2);
    assert_eq!(persisted["attempts"][0]["attempt"], 1);
    assert_eq!(persisted["attempts"][1]["attempt"], 2);
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn corrupt_existing_json_fails_without_overwriting_the_corrupt_bytes() {
    let home = IsolatedHome::new();
    fs::create_dir_all(home.request_dir()).unwrap();
    let path = home.request_dir().join("provider-request.json");
    let corrupt = b"{\"object\":\"routecodex.v3.provider_request_snapshots\"";
    fs::write(&path, corrupt).unwrap();

    let store = V3CodexSampleStore::new(true, 100, false);
    let error = store
        .persist(
            10000,
            "responses",
            ENDPOINT,
            REQUEST_ID,
            "provider-request.json",
            &json!({
                "object": "routecodex.v3.provider_request_snapshots",
                "stage": "provider-request",
                "attempts": [{"attempt": 1, "request": {"providerId": "opencode-go"}}]
            }),
            false,
            None,
        )
        .expect_err("corrupt old JSON must fail explicitly");
    assert!(!error.is_empty(), "corrupt JSON error must be explicit");
    assert_eq!(fs::read(&path).unwrap(), corrupt);
    assert_no_owned_temp(&home.request_dir());
}
