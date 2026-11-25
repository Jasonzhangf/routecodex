use routecodex_v3_debug::V3CodexSampleStore;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_HOME: AtomicU64 = AtomicU64::new(1);

struct TestHome {
    previous: Option<std::ffi::OsString>,
    root: PathBuf,
}

impl TestHome {
    fn new() -> Self {
        let sequence = NEXT_HOME.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "routecodex-sample-retention-public-{}-{sequence}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("home")).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", root.join("home"));
        Self { previous, root }
    }

    fn samples(&self) -> PathBuf {
        self.root.join("home/.rcc/codex-samples")
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.take() {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn failure_reserve_preserves_exact_errors_and_does_not_reject_business() {
    let home = TestHome::new();
    let store = V3CodexSampleStore::new(true, 100, false);
    persist_failure(&store, "public-400", 400);
    persist_failure(&store, "public-502", 502);
    for index in 0..=100 {
        persist_success(&store, index);
    }

    let samples = home.samples();
    assert_failure(&samples, "public-400", 400);
    assert_failure(&samples, "public-502", 502);

    for index in 0..254 {
        persist_reserve(&store, index);
    }
    persist_failure(&store, "public-overflow", 502);
    assert!(!samples
        .join("openai-responses/ports/10000/public-overflow")
        .exists());
    let failures = store.persist_failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].request_id, "public-overflow");
    assert_eq!(failures[0].file_name, "provider-failed-attempts.json");
    assert!(failures[0].reason.contains("failure reserve full"));

    persist_success(&store, 101);
    assert!(samples
        .join("openai-responses/ports/10000/public-success-101/request.json")
        .exists());
    assert_failure(&samples, "public-400", 400);
    assert_failure(&samples, "public-502", 502);
}

fn assert_failure(samples: &Path, request_id: &str, status: u16) {
    let path = samples
        .join("openai-responses/ports/10000")
        .join(request_id)
        .join("provider-failed-attempts.json");
    let value: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(value["request_id"], request_id);
    assert_eq!(value["status"], status);
}

fn persist_failure(store: &V3CodexSampleStore, request_id: &str, status: u16) {
    store
        .persist(
            10000,
            "responses",
            "/v1/responses",
            request_id,
            "provider-failed-attempts.json",
            &json!({"request_id": request_id, "status": status}),
            true,
            Some(status),
        )
        .unwrap();
}

fn persist_success(store: &V3CodexSampleStore, index: usize) {
    let request_id = format!("public-success-{index:03}");
    store
        .persist(
            10000,
            "responses",
            "/v1/responses",
            &request_id,
            "request.json",
            &json!({"success": index}),
            false,
            None,
        )
        .unwrap();
}

fn persist_reserve(store: &V3CodexSampleStore, index: usize) {
    let request_id = format!("public-reserve-{index:03}");
    store
        .persist(
            10000,
            "responses",
            "/v1/responses",
            &request_id,
            "provider-failed-attempts.json",
            &json!({"status": 502}),
            true,
            Some(502),
        )
        .unwrap();
}
