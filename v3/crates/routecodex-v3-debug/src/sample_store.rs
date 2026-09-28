use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

/// Error snapshots are retained by request-id directory.  A request may have
/// client request/response plus provider request/response files, but those four
/// files are one evidence record and must consume one retention slot.
pub const V3_CODEX_SAMPLE_REQUEST_RETENTION: usize = 100;

enum V3CodexSamplePersistQueueMessage {
    Persist(V3CodexSamplePersistJob),
    Barrier {
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
}

pub struct V3CodexSampleStore {
    enabled: bool,
    retention: usize,
    /// 只落错误样本（force=true 的 error evidence）；由 server 从 internal 默认值
    /// 与 `--snap` 运行时授权（full_codex_sampling）组合传入。
    error_samples_only: bool,
    persistence_guard: Mutex<()>,
    enqueue: RwLock<Option<tokio::sync::mpsc::UnboundedSender<V3CodexSamplePersistQueueMessage>>>,
    persist_failures: Mutex<Vec<V3CodexSamplePersistFailure>>,
}

pub struct V3CodexSamplePersistHandle {
    stop: Option<tokio::sync::mpsc::UnboundedSender<V3CodexSamplePersistQueueMessage>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    store: Arc<V3CodexSampleStore>,
}

impl std::fmt::Debug for V3CodexSamplePersistHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("V3CodexSamplePersistHandle")
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct V3CodexSamplePersistJob {
    pub port: u16,
    pub entry_protocol: String,
    pub endpoint: String,
    pub request_id: String,
    pub file_name: String,
    pub payload: Arc<Value>,
    pub force: bool,
    pub status: Option<u16>,
}

impl Default for V3CodexSamplePersistJob {
    fn default() -> Self {
        Self {
            port: 10000,
            entry_protocol: "responses".to_string(),
            endpoint: "/v1/responses".to_string(),
            request_id: "req-test".to_string(),
            file_name: "request.json".to_string(),
            payload: Arc::new(Value::Object(Map::new())),
            force: false,
            status: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct V3CodexSamplePersistFailure {
    pub request_id: String,
    pub file_name: String,
    pub reason: String,
}

impl V3CodexSamplePersistHandle {
    /// Wait until every accepted persistence job ahead of this barrier finishes.
    pub async fn wait_until_idle(&self) -> Result<(), String> {
        let sender = self
            .store
            .enqueue
            .read()
            .map_err(|error| format!("codex sample persist queue lock poisoned: {error}"))?
            .clone()
            .or_else(|| self.stop.as_ref().cloned())
            .ok_or_else(|| "codex sample persist worker is not running".to_string())?;
        let (reply, result) = tokio::sync::oneshot::channel();
        sender
            .send(V3CodexSamplePersistQueueMessage::Barrier { reply })
            .map_err(|_| "codex sample persist queue unavailable".to_string())?;
        result
            .await
            .map_err(|error| format!("codex sample persist barrier failed: {error}"))?
    }

    /// Await worker termination before listener shutdown.
    pub async fn shutdown(&mut self) {
        self.store
            .enqueue
            .write()
            .unwrap_or_else(|error| {
                eprintln!("codex sample persist queue lock poisoned during shutdown: {error}");
                error.into_inner()
            })
            .take();
        self.stop.take();
        let task = self
            .task
            .lock()
            .unwrap_or_else(|error| {
                eprintln!("codex sample persist task lock poisoned: {error}");
                error.into_inner()
            })
            .take();
        if let Some(task) = task.as_ref() {
            while !task.is_finished() {
                tokio::task::yield_now().await;
            }
        }
        if let Some(task) = task {
            if let Err(error) = task.await {
                eprintln!("codex sample persist worker task failed: {error}");
            }
        }
    }

    pub fn persist_failures(&self) -> Vec<V3CodexSamplePersistFailure> {
        self.store.persist_failures()
    }
}

impl V3CodexSampleStore {
    pub fn new(enabled: bool, retention: usize, error_samples_only: bool) -> Self {
        Self {
            enabled,
            retention,
            error_samples_only,
            persistence_guard: Mutex::new(()),
            enqueue: RwLock::new(None),
            persist_failures: Mutex::new(Vec::new()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn retention(&self) -> usize {
        self.retention
    }

    #[allow(clippy::too_many_arguments)]
    pub fn persist(
        &self,
        port: u16,
        entry_protocol: &str,
        endpoint: &str,
        request_id: &str,
        file_name: &str,
        payload: &Value,
        force: bool,
        status: Option<u16>,
    ) -> Result<(), String> {
        if !self.enabled && !force {
            return Ok(());
        }
        if !force && self.error_samples_only {
            return Ok(());
        }
        // 账号/配额类错误状态不落盘（401/402/403/429/503 等）。
        if force {
            if let Some(status) = status {
                if routecodex_v3_config::internal::v3_error_sample_skip_statuses().contains(&status)
                {
                    return Ok(());
                }
            }
        }
        let _persistence_guard = self
            .persistence_guard
            .lock()
            .map_err(|error| format!("codex sample persistence lock poisoned: {error}"))?;
        let samples_root = resolve_v3_codex_samples_root()?;
        let port_root = samples_root
            .join(format_v3_codex_sample_endpoint_dir(
                entry_protocol,
                endpoint,
            ))
            .join("ports")
            .join(port.to_string());
        let dir = port_root.join(encode_v3_codex_sample_path_segment(request_id));
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        // 样本含敏感请求/错误载荷：目录 0700、文件 0600（不依赖 umask）。
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        let path = dir.join(file_name);
        let payload = merge_provider_snapshot_attempts(&path, file_name, payload)?;
        let mut file = fs::File::create(&path).map_err(|error| error.to_string())?;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        serde_json::to_writer_pretty(&mut file, &payload).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        enforce_v3_codex_sample_global_retention(&samples_root, Some(&dir), self.retention)?;
        Ok(())
    }

    pub fn enforce_retention(&self) -> Result<(), String> {
        let samples_root = resolve_v3_codex_samples_root()?;
        if !samples_root.exists() {
            return Ok(());
        }
        enforce_v3_codex_sample_global_retention(&samples_root, None, self.retention)
    }

    pub fn enforce_listener_retention(&self, _port: u16) -> Result<(), String> {
        self.enforce_retention()
    }

    pub fn persist_failures(&self) -> Vec<V3CodexSamplePersistFailure> {
        let mut failures = self.persist_failures.lock().unwrap_or_else(|error| {
            eprintln!("codex sample persist failure ledger lock poisoned: {error}");
            error.into_inner()
        });
        std::mem::take(&mut failures)
    }

    /// Spawn the single async owner for sample persistence.
    pub fn start_persist_worker(self: &Arc<Self>) -> tokio::io::Result<V3CodexSamplePersistHandle> {
        let mut enqueue = self.enqueue.write().map_err(|error| {
            tokio::io::Error::other(format!("codex sample persist queue lock poisoned: {error}"))
        })?;
        if enqueue.is_some() {
            return Err(tokio::io::Error::new(
                tokio::io::ErrorKind::AlreadyExists,
                "codex sample persist worker already started",
            ));
        }
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let stop_tx = tx.clone();
        let worker_store = Arc::clone(self);
        *enqueue = Some(tx.clone());
        drop(enqueue);
        let task = tokio::spawn(run_v3_codex_sample_persist_worker(worker_store, rx));

        Ok(V3CodexSamplePersistHandle {
            stop: Some(stop_tx),
            task: Mutex::new(Some(task)),
            store: Arc::clone(self),
        })
    }

    /// Hot-path enqueue owner. This intentionally stores payload by shared ownership.
    pub fn enqueue_persist(self: &Arc<Self>, job: V3CodexSamplePersistJob) -> Result<(), String> {
        let enqueue = self
            .enqueue
            .read()
            .map_err(|error| format!("codex sample persist queue lock poisoned: {error}"))?
            .clone()
            .ok_or_else(|| "codex sample persist worker is not running".to_string())?;
        enqueue
            .send(V3CodexSamplePersistQueueMessage::Persist(job))
            .map_err(|_| "codex sample persist queue unavailable".to_string())
    }
}

async fn run_v3_codex_sample_persist_worker(
    store: Arc<V3CodexSampleStore>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<V3CodexSamplePersistQueueMessage>,
) {
    while let Some(message) = rx.recv().await {
        match message {
            V3CodexSamplePersistQueueMessage::Persist(job) => {
                persist_v3_codex_sample_persist_job(Arc::clone(&store), job).await;
            }
            V3CodexSamplePersistQueueMessage::Barrier { reply } => {
                let failures = store.persist_failures();
                let result = if failures.is_empty() {
                    Ok(())
                } else {
                    Err(failures
                        .into_iter()
                        .map(|failure| {
                            format!(
                                "request={} file={} reason={}",
                                failure.request_id, failure.file_name, failure.reason
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("; "))
                };
                let _ = reply.send(result);
            }
        }
    }
}

async fn persist_v3_codex_sample_persist_job(
    store: Arc<V3CodexSampleStore>,
    job: V3CodexSamplePersistJob,
) {
    let failure_request_id = job.request_id.clone();
    let failure_file_name = job.file_name.clone();
    let io_failure_store = Arc::clone(&store);
    let join_failure_store = Arc::clone(&store);
    let join_failure_request_id = job.request_id.clone();
    let join_failure_file_name = job.file_name.clone();
    tokio::task::spawn_blocking(move || {
        let result = store.persist(
            job.port,
            &job.entry_protocol,
            &job.endpoint,
            &job.request_id,
            &job.file_name,
            &job.payload,
            job.force,
            job.status,
        );
        if let Err(error) = result {
            record_v3_codex_sample_persist_failure(
                &io_failure_store,
                failure_request_id,
                failure_file_name,
                error,
            );
        }
    })
    .await
    .unwrap_or_else(|error| {
        record_v3_codex_sample_persist_failure(
            &join_failure_store,
            join_failure_request_id,
            join_failure_file_name,
            format!("codex sample persist worker join failed: {error}"),
        );
    })
}

fn record_v3_codex_sample_persist_failure(
    store: &Arc<V3CodexSampleStore>,
    request_id: String,
    file_name: String,
    reason: String,
) {
    eprintln!("codex sample persist failed: request={request_id} file={file_name} reason={reason}");
    let mut failures = store.persist_failures.lock().unwrap_or_else(|error| {
        eprintln!("codex sample persist failure ledger lock poisoned: {error}");
        error.into_inner()
    });
    failures.push(V3CodexSamplePersistFailure {
        request_id,
        file_name,
        reason,
    });
}

fn merge_provider_snapshot_attempts(
    path: &Path,
    file_name: &str,
    incoming: &Value,
) -> Result<Value, String> {
    let is_provider_snapshot = matches!(
        file_name,
        "provider-request.json" | "provider-response.json"
    );
    if !is_provider_snapshot || !incoming.is_object() || !path.is_file() {
        return Ok(incoming.clone());
    }
    let existing_text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut existing: Value =
        serde_json::from_str(&existing_text).map_err(|error| error.to_string())?;
    let (Some(existing_object), Some(incoming_object)) =
        (existing.as_object_mut(), incoming.as_object())
    else {
        return Ok(incoming.clone());
    };
    if existing_object.get("object") != incoming_object.get("object")
        || existing_object.get("stage") != incoming_object.get("stage")
        || existing_object
            .get("attempts")
            .and_then(Value::as_array)
            .is_none()
        || incoming_object
            .get("attempts")
            .and_then(Value::as_array)
            .is_none()
    {
        return Ok(incoming.clone());
    }
    let existing_attempts = existing_object
        .get_mut("attempts")
        .and_then(Value::as_array_mut)
        .expect("provider snapshot attempts validated above");
    for attempt in incoming_object
        .get("attempts")
        .and_then(Value::as_array)
        .expect("provider snapshot attempts validated above")
    {
        if !existing_attempts.iter().any(|known| known == attempt) {
            existing_attempts.push(attempt.clone());
        }
    }
    Ok(existing)
}

fn resolve_v3_codex_samples_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "codex sample filesystem requires HOME".to_string())?;
    if home.to_string_lossy().trim().is_empty() {
        return Err("codex sample filesystem requires non-empty HOME".to_string());
    }
    Ok(PathBuf::from(home).join(".rcc").join("codex-samples"))
}

fn format_v3_codex_sample_endpoint_dir(entry_protocol: &str, endpoint: &str) -> String {
    match (entry_protocol, endpoint) {
        ("responses", "/v1/responses") => "openai-responses".to_string(),
        ("openai_chat", "/v1/chat/completions") => "openai-chat-completions".to_string(),
        ("anthropic", "/v1/messages") => "anthropic-messages".to_string(),
        ("gemini", _) => "gemini-generate-content".to_string(),
        _ => encode_v3_codex_sample_path_segment(
            endpoint.trim_start_matches('/').replace('/', "-").as_str(),
        ),
    }
}

fn encode_v3_codex_sample_path_segment(value: &str) -> String {
    let path_safe = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if path_safe.is_empty() {
        "unknown".to_string()
    } else {
        path_safe
    }
}

fn enforce_v3_codex_sample_global_retention(
    samples_root: &Path,
    protected_request_dir: Option<&Path>,
    retention: usize,
) -> Result<(), String> {
    let endpoint_dirs = fs::read_dir(samples_root)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut request_dirs = Vec::new();
    for endpoint_dir in endpoint_dirs {
        if !endpoint_dir
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let ports_dir = endpoint_dir.path().join("ports");
        if !ports_dir.is_dir() {
            continue;
        }
        for port_dir in fs::read_dir(ports_dir)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
        {
            if !port_dir
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                continue;
            }
            for request_dir in fs::read_dir(port_dir.path())
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
            {
                if !request_dir
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_dir()
                {
                    continue;
                }
                let modified = request_dir
                    .metadata()
                    .map_err(|error| error.to_string())?
                    .modified()
                    .map_err(|error| error.to_string())?;
                request_dirs.push((request_dir, modified));
            }
        }
    }
    if request_dirs.len() <= retention {
        return Ok(());
    }
    request_dirs.sort_by(|left, right| {
        left.1
            .cmp(&right.1)
            .then_with(|| left.0.file_name().cmp(&right.0.file_name()))
    });
    let excess = request_dirs.len() - retention;
    let removable = request_dirs
        .into_iter()
        .filter(|(entry, _)| {
            protected_request_dir.is_none_or(|protected| entry.path() != protected)
        })
        .take(excess)
        .collect::<Vec<_>>();
    if removable.len() != excess {
        return Err(format!(
            "codex sample retention cannot preserve current request while removing {excess} directories"
        ));
    }
    for (entry, _) in removable {
        fs::remove_dir_all(entry.path()).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs::Permissions;

    static TEST_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_test_home(f: impl FnOnce(&std::path::Path)) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let _guard = TEST_HOME_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let seq = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "v3-codex-sample-store-test-{}-{}",
            std::process::id(),
            seq
        ));
        let _ = fs::remove_dir_all(&base);
        let home = base.join("home");
        fs::create_dir_all(&home).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &home);
        f(&base);
        if let Some(previous) = previous {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = fs::remove_dir_all(&base);
    }

    fn with_test_home_async<F, Fut>(f: F)
    where
        F: Send + 'static + FnOnce(&std::path::Path) -> Fut,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let _guard = TEST_HOME_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let seq = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "v3-codex-sample-store-async-test-{}-{}",
            std::process::id(),
            seq
        ));
        let _ = fs::remove_dir_all(&base);
        let home = base.join("home");
        fs::create_dir_all(&home).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &home);
        let previous_home = previous;
        let cleanup_base = base.clone();
        std::thread::spawn(move || tokio::runtime::Runtime::new().unwrap().block_on(f(&base)))
            .join()
            .unwrap();
        if let Some(previous) = previous_home {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = fs::remove_dir_all(cleanup_base);
    }

    fn sample_dir(home_base: &std::path::Path) -> std::path::PathBuf {
        home_base
            .join("home")
            .join(".rcc")
            .join("codex-samples")
            .join("openai-responses")
            .join("ports")
            .join("10000")
    }

    #[test]
    fn persist_writes_verbatim_sample_when_enabled() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(true, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
            let payload = json!({"model": "deepseek-v4-flash", "input": [{"role": "user", "content": "hello"}]});
            store
                .persist(
                    10000,
                    "responses",
                    "/v1/responses",
                    "req-1",
                    "request.json",
                    &payload,
                    false,
                    None,
                )
                .unwrap();
            let path = sample_dir(home_base).join("req-1").join("request.json");
            let written = fs::read_to_string(&path).unwrap();
            assert!(written.contains("deepseek-v4-flash"));
            assert!(written.contains("hello"));
            assert!(!written.contains("ROUTECODEX_DEBUG"));
        });
    }

    #[test]
    fn persist_merges_distinct_provider_snapshot_attempts_without_duplicates() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(true, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
            let first = json!({
                "object": "routecodex.v3.provider_request_snapshots",
                "stage": "provider-request",
                "attempts": [{"attempt": 1, "request": {"providerId": "opencode-go"}}]
            });
            let second = json!({
                "object": "routecodex.v3.provider_request_snapshots",
                "stage": "provider-request",
                "attempts": [{"attempt": 1, "request": {"providerId": "opencode-go-zen"}}]
            });
            store
                .persist(
                    10000,
                    "responses",
                    "/v1/responses",
                    "req-merge",
                    "provider-request.json",
                    &first,
                    false,
                    None,
                )
                .unwrap();
            store
                .persist(
                    10000,
                    "responses",
                    "/v1/responses",
                    "req-merge",
                    "provider-request.json",
                    &second,
                    false,
                    None,
                )
                .unwrap();
            store
                .persist(
                    10000,
                    "responses",
                    "/v1/responses",
                    "req-merge",
                    "provider-request.json",
                    &second,
                    false,
                    None,
                )
                .unwrap();
            let path = sample_dir(home_base)
                .join("req-merge")
                .join("provider-request.json");
            let written: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
            assert_eq!(written["attempts"].as_array().unwrap().len(), 2);
            assert_eq!(
                written["attempts"][0]["request"]["providerId"],
                "opencode-go"
            );
            assert_eq!(
                written["attempts"][1]["request"]["providerId"],
                "opencode-go-zen"
            );
        });
    }

    #[test]
    fn persist_skips_when_disabled_without_force() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(false, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
            store
                .persist(
                    10000,
                    "responses",
                    "/v1/responses",
                    "req-1",
                    "request.json",
                    &json!({"a": 1}),
                    false,
                    None,
                )
                .unwrap();
            assert!(!sample_dir(home_base).join("req-1").exists());
        });
    }

    #[test]
    fn persist_forces_error_evidence_when_disabled() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(false, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
            store
                .persist(
                    10000,
                    "responses",
                    "/v1/responses",
                    "req-1",
                    "error.json",
                    &json!({"status": 502}),
                    true,
                    Some(502),
                )
                .unwrap();
            let path = sample_dir(home_base).join("req-1").join("error.json");
            let written = fs::read_to_string(&path).unwrap();
            assert!(written.contains("502"));
        });
    }

    #[test]
    fn persist_skips_error_sample_for_skipped_status_even_when_forced() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(false, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
            store
                .persist(
                    10000,
                    "responses",
                    "/v1/responses",
                    "req-1",
                    "error.json",
                    &json!({"status": 503}),
                    true,
                    Some(503),
                )
                .unwrap();
            assert!(
                !sample_dir(home_base).join("req-1").exists(),
                "skipped account/quota error status must not be persisted"
            );
            store
                .persist(
                    10000,
                    "responses",
                    "/v1/responses",
                    "req-2",
                    "error.json",
                    &json!({"status": 502}),
                    true,
                    Some(502),
                )
                .unwrap();
            assert!(
                sample_dir(home_base)
                    .join("req-2")
                    .join("error.json")
                    .exists(),
                "non-skipped error status must still be persisted"
            );
        });
    }

    #[test]
    fn persist_skips_normal_sample_when_error_samples_only() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(true, V3_CODEX_SAMPLE_REQUEST_RETENTION, true);
            store
                .persist(
                    10000,
                    "responses",
                    "/v1/responses",
                    "req-1",
                    "request.json",
                    &json!({"a": 1}),
                    false,
                    None,
                )
                .unwrap();
            assert!(
                !sample_dir(home_base).join("req-1").exists(),
                "normal sample must not be persisted when error_samples_only"
            );
            store
                .persist(
                    10000,
                    "responses",
                    "/v1/responses",
                    "req-2",
                    "error.json",
                    &json!({"status": 500}),
                    true,
                    Some(500),
                )
                .unwrap();
            assert!(
                sample_dir(home_base)
                    .join("req-2")
                    .join("error.json")
                    .exists(),
                "error evidence must still be persisted when error_samples_only"
            );
            store
                .persist(
                    10000,
                    "responses",
                    "/v1/responses",
                    "req-3",
                    "error.json",
                    &json!({"status": 400}),
                    true,
                    Some(400),
                )
                .unwrap();
            assert!(
                sample_dir(home_base)
                    .join("req-3")
                    .join("error.json")
                    .exists(),
                "provider 400 error evidence must be persisted"
            );
        });
    }

    #[test]
    fn retention_caps_samples_at_configured_limit() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(true, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
            for index in 0..=V3_CODEX_SAMPLE_REQUEST_RETENTION {
                store
                    .persist(
                        10000,
                        "responses",
                        "/v1/responses",
                        &format!("req-{index}"),
                        "request.json",
                        &json!({"n": index}),
                        true,
                        Some(502),
                    )
                    .unwrap();
            }
            let dirs = fs::read_dir(sample_dir(home_base)).unwrap().count();
            assert_eq!(dirs, V3_CODEX_SAMPLE_REQUEST_RETENTION);
        });
    }

    #[test]
    fn retention_caps_samples_across_endpoints_and_ports() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(true, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
            for index in 0..=V3_CODEX_SAMPLE_REQUEST_RETENTION {
                let (protocol, endpoint, port) = if index % 2 == 0 {
                    ("responses", "/v1/responses", 10000)
                } else {
                    ("openai_chat", "/v1/chat/completions", 5520)
                };
                store
                    .persist(
                        port,
                        protocol,
                        endpoint,
                        &format!("req-{index}"),
                        "request.json",
                        &json!({"n": index}),
                        true,
                        Some(502),
                    )
                    .unwrap();
            }
            let root = home_base.join("home").join(".rcc").join("codex-samples");
            let total_dirs = fs::read_dir(&root)
                .unwrap()
                .flat_map(|endpoint| {
                    let ports = endpoint.unwrap().path().join("ports");
                    fs::read_dir(ports)
                        .unwrap()
                        .flat_map(|port| fs::read_dir(port.unwrap().path()).unwrap())
                        .collect::<Vec<_>>()
                })
                .count();
            assert_eq!(total_dirs, V3_CODEX_SAMPLE_REQUEST_RETENTION);
        });
    }

    #[test]
    fn endpoint_dir_mapping_is_stable() {
        assert_eq!(
            format_v3_codex_sample_endpoint_dir("responses", "/v1/responses"),
            "openai-responses"
        );
        assert_eq!(
            format_v3_codex_sample_endpoint_dir("openai_chat", "/v1/chat/completions"),
            "openai-chat-completions"
        );
        assert_eq!(
            format_v3_codex_sample_endpoint_dir("anthropic", "/v1/messages"),
            "anthropic-messages"
        );
        assert_eq!(
            format_v3_codex_sample_endpoint_dir(
                "gemini",
                "/v1beta/models/gemini-2.0-flash:generateContent"
            ),
            "gemini-generate-content"
        );
    }

    #[test]
    fn unknown_request_id_encodes_to_unknown() {
        assert_eq!(encode_v3_codex_sample_path_segment("///"), "unknown");
        assert_eq!(
            encode_v3_codex_sample_path_segment(
                "router-gpt-5.6-sol-20260810T223407524-738231-8043"
            ),
            "router-gpt-5.6-sol-20260810T223407524-738231-8043"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn persist_async_worker_writes_without_business_thread_file_io() {
        with_test_home_async(|home_base| {
            let home_base = home_base.to_path_buf();
            Box::pin(async move {
                let store = Arc::new(V3CodexSampleStore::new(
                    true,
                    V3_CODEX_SAMPLE_REQUEST_RETENTION,
                    false,
                ));
                let mut handle = store
                    .start_persist_worker()
                    .expect("persist worker should start");
                store
                    .enqueue_persist(V3CodexSamplePersistJob {
                        port: 10000,
                        entry_protocol: "responses".to_string(),
                        endpoint: "/v1/responses".to_string(),
                        request_id: "req-async".to_string(),
                        file_name: "request.json".to_string(),
                        payload: Arc::new(json!({"hello": "async"})),
                        force: false,
                        status: None,
                    })
                    .expect("queued sample should be accepted");
                let _ = store.enqueue_persist(V3CodexSamplePersistJob {
                    port: 10000,
                    entry_protocol: "responses".to_string(),
                    endpoint: "/v1/responses".to_string(),
                    request_id: "req-after-stop".to_string(),
                    file_name: "request.json".to_string(),
                    payload: Arc::new(json!({"hello": "after-stop"})),
                    force: false,
                    status: None,
                });
                handle.shutdown().await;
                let path = sample_dir(&home_base)
                    .join("req-async")
                    .join("request.json");
                assert!(fs::read_to_string(path).unwrap().contains("async"));
                let after_stop_path = sample_dir(&home_base)
                    .join("req-after-stop")
                    .join("request.json");
                assert!(
                    fs::read_to_string(after_stop_path)
                        .unwrap()
                        .contains("after-stop"),
                    "accepted jobs must drain after stop"
                );
            })
        })
    }

    #[tokio::test(flavor = "current_thread")]
    async fn persist_async_worker_records_explicit_failure_terminal() {
        with_test_home_async(|home_base| {
            let home_base = home_base.to_path_buf();
            Box::pin(async move {
                let store = Arc::new(V3CodexSampleStore::new(
                    true,
                    V3_CODEX_SAMPLE_REQUEST_RETENTION,
                    false,
                ));
                fs::create_dir_all(sample_dir(&home_base)).unwrap();
                fs::set_permissions(sample_dir(&home_base), Permissions::from_mode(0o555)).unwrap();
                let mut handle = store
                    .start_persist_worker()
                    .expect("persist worker should start");
                store
                    .enqueue_persist(V3CodexSamplePersistJob {
                        port: 10000,
                        entry_protocol: "responses".to_string(),
                        endpoint: "/v1/responses".to_string(),
                        request_id: "req-fail".to_string(),
                        file_name: "request.json".to_string(),
                        payload: Arc::new(json!({"hello": "failure"})),
                        force: false,
                        status: None,
                    })
                    .expect("queued sample should be accepted");
                handle.shutdown().await;
                let failures = handle.persist_failures();
                assert_eq!(
                    failures.len(),
                    1,
                    "persist worker failure terminal must not be silent"
                );
                assert_eq!(
                    failures[0].request_id, "req-fail",
                    "persist failure terminal must identify the request"
                );
                let failure_reason = failures[0].reason.to_ascii_lowercase();
                assert!(
                    failure_reason.contains("create")
                        || failure_reason.contains("permission denied")
                );
                let _ = fs::set_permissions(sample_dir(&home_base), Permissions::from_mode(0o755));
            })
        })
    }
}
