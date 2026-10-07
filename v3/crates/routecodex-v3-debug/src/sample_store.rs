use serde_json::{Map, Value};
use std::fs;
use std::io::{BufWriter, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use crate::sample_retention::enforce_v3_codex_sample_global_retention;

/// Error snapshots are retained by request-id directory.  A request may have
/// client request/response plus provider request/response files, but those four
/// files are one evidence record and must consume one retention slot.
pub const V3_CODEX_SAMPLE_REQUEST_RETENTION: usize = 100;
const V3_CODEX_SAMPLE_PERSIST_QUEUE_BYTE_BUDGET: u32 = 64 * 1024 * 1024;
/// Fixed allocation cost of one queued persistence job (channel slot, job
/// metadata, and Arc/Value overhead). Charging it to the byte budget keeps the
/// total queued memory bounded even when every payload serializes to a few bytes.
const V3_CODEX_SAMPLE_PERSIST_JOB_OVERHEAD_BYTES: u32 = 4096;
const V3_CODEX_SAMPLE_PERSIST_FAILURE_LIMIT: usize = 256;
static V3_CODEX_SAMPLE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

enum V3CodexSamplePersistQueueMessage {
    Persist {
        job: V3CodexSamplePersistJob,
        _payload_permit: tokio::sync::OwnedSemaphorePermit,
    },
    Barrier {
        reply: tokio::sync::oneshot::Sender<Vec<V3CodexSamplePersistFailure>>,
    },
}

#[derive(Default)]
struct V3CodexSamplePersistAdmission {
    sender: Option<tokio::sync::mpsc::UnboundedSender<V3CodexSamplePersistQueueMessage>>,
    quiesced: bool,
}

pub struct V3CodexSampleExecGuard {
    store: Arc<V3CodexSampleStore>,
}

impl std::fmt::Debug for V3CodexSampleExecGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("V3CodexSampleExecGuard")
            .finish_non_exhaustive()
    }
}

impl Drop for V3CodexSampleExecGuard {
    fn drop(&mut self) {
        self.store
            .enqueue
            .write()
            .unwrap_or_else(|error| {
                eprintln!("codex sample persist queue lock poisoned during exec recovery: {error}");
                error.into_inner()
            })
            .quiesced = false;
    }
}

impl V3CodexSampleExecGuard {
    pub fn persist_failures(&self) -> Vec<V3CodexSamplePersistFailure> {
        self.store.persist_failure_snapshot()
    }
}

#[derive(Default)]
struct V3CodexSamplePersistFailureLedger {
    failures: Vec<V3CodexSamplePersistFailure>,
    additional_failures: usize,
}

pub struct V3CodexSampleStore {
    enabled: bool,
    retention: usize,
    /// 只落错误样本（force=true 的 error evidence）；由 server 从 internal 默认值
    /// 与 `--snap` 运行时授权（full_codex_sampling）组合传入。
    error_samples_only: bool,
    enqueue: RwLock<V3CodexSamplePersistAdmission>,
    queued_payload_bytes: Arc<tokio::sync::Semaphore>,
    persist_failures: Mutex<V3CodexSamplePersistFailureLedger>,
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

impl std::fmt::Display for V3CodexSamplePersistFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "request={} file={} reason={}",
            self.request_id, self.file_name, self.reason
        )
    }
}

impl V3CodexSamplePersistHandle {
    /// Wait until every accepted persistence job ahead of this barrier finishes.
    pub async fn wait_until_idle(&self) -> Result<(), String> {
        let failures = self.wait_for_drain().await?;
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures
                .into_iter()
                .map(|failure| failure.to_string())
                .collect::<Vec<_>>()
                .join("; "))
        }
    }

    pub async fn quiesce_for_exec(&self) -> Result<V3CodexSampleExecGuard, String> {
        let guard = {
            let mut admission =
                self.store.enqueue.write().map_err(|error| {
                    format!("codex sample persist queue lock poisoned: {error}")
                })?;
            let sender = admission
                .sender
                .as_ref()
                .ok_or_else(|| "codex sample persist worker is not running".to_string())?;
            if sender.is_closed() {
                return Err("codex sample persist queue unavailable".to_string());
            }
            if admission.quiesced {
                return Err("codex sample exec preparation already active".to_string());
            }
            admission.quiesced = true;
            V3CodexSampleExecGuard {
                store: Arc::clone(&self.store),
            }
        };
        self.wait_for_drain().await?;
        Ok(guard)
    }

    async fn wait_for_drain(&self) -> Result<Vec<V3CodexSamplePersistFailure>, String> {
        let sender = self
            .store
            .enqueue
            .read()
            .map_err(|error| format!("codex sample persist queue lock poisoned: {error}"))?
            .sender
            .clone()
            .or_else(|| self.stop.as_ref().cloned())
            .ok_or_else(|| "codex sample persist worker is not running".to_string())?;
        let (reply, result) = tokio::sync::oneshot::channel();
        sender
            .send(V3CodexSamplePersistQueueMessage::Barrier { reply })
            .map_err(|_| "codex sample persist queue unavailable".to_string())?;
        result
            .await
            .map_err(|error| format!("codex sample persist barrier failed: {error}"))
    }

    /// Await worker termination and return failures not already reported by a barrier.
    pub async fn shutdown(&mut self) -> Vec<V3CodexSamplePersistFailure> {
        self.store
            .enqueue
            .write()
            .unwrap_or_else(|error| {
                eprintln!("codex sample persist queue lock poisoned during shutdown: {error}");
                error.into_inner()
            })
            .sender
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
        if let Some(task) = task {
            // Awaiting the handle is the wait. Polling `is_finished` with
            // `yield_now` kept the task runnable and burned a whole core for
            // the duration of the shutdown drain.
            if let Err(error) = task.await {
                eprintln!("codex sample persist worker task failed: {error}");
            }
        }
        self.store.persist_failures()
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
            enqueue: RwLock::new(V3CodexSamplePersistAdmission::default()),
            queued_payload_bytes: Arc::new(tokio::sync::Semaphore::new(
                V3_CODEX_SAMPLE_PERSIST_QUEUE_BYTE_BUDGET as usize,
            )),
            persist_failures: Mutex::new(V3CodexSamplePersistFailureLedger::default()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn retention(&self) -> usize {
        self.retention
    }

    fn should_persist(&self, force: bool, status: Option<u16>) -> bool {
        if !force {
            return self.enabled && !self.error_samples_only;
        }
        !status.is_some_and(|status| {
            routecodex_v3_config::internal::v3_error_sample_skip_statuses().contains(&status)
        })
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
        if !self.should_persist(force, status) {
            return Ok(());
        }
        let samples_root = resolve_v3_codex_samples_root()?;
        let _filesystem_guard = lock_v3_codex_sample_filesystem(&samples_root)?;
        let dir = v3_codex_sample_request_dir(port, entry_protocol, endpoint, request_id)?;
        let is_new_request_dir = !dir.is_dir();
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        // 样本含敏感请求/错误载荷：目录 0700、文件 0600（不依赖 umask）。
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        let path = dir.join(file_name);
        let payload = merge_provider_snapshot_attempts(&path, file_name, payload)?;
        write_v3_codex_sample_atomically(&path, &payload)?;
        // Retention counts request directories, so the full-tree sweep only needs
        // to run when this write created one. Re-scanning the whole samples root
        // for every file of a request multiplied the Debug worker cost by the
        // per-request file count.
        if is_new_request_dir {
            enforce_v3_codex_sample_global_retention(&samples_root, Some(&dir), self.retention)?;
        }
        Ok(())
    }

    pub fn enforce_retention(&self) -> Result<(), String> {
        let samples_root = resolve_v3_codex_samples_root()?;
        if !samples_root.exists() {
            return Ok(());
        }
        let _filesystem_guard = lock_v3_codex_sample_filesystem(&samples_root)?;
        enforce_v3_codex_sample_global_retention(&samples_root, None, self.retention)
    }

    pub fn enforce_listener_retention(&self, _port: u16) -> Result<(), String> {
        self.enforce_retention()
    }

    pub fn persist_failures(&self) -> Vec<V3CodexSamplePersistFailure> {
        let mut ledger = self.persist_failures.lock().unwrap_or_else(|error| {
            eprintln!("codex sample persist failure ledger lock poisoned: {error}");
            error.into_inner()
        });
        ledger.take()
    }

    fn persist_failure_snapshot(&self) -> Vec<V3CodexSamplePersistFailure> {
        self.persist_failures
            .lock()
            .unwrap_or_else(|error| {
                eprintln!("codex sample persist failure ledger lock poisoned: {error}");
                error.into_inner()
            })
            .snapshot()
    }

    /// Spawn the single async owner for sample persistence.
    pub fn start_persist_worker(self: &Arc<Self>) -> tokio::io::Result<V3CodexSamplePersistHandle> {
        let mut enqueue = self.enqueue.write().map_err(|error| {
            tokio::io::Error::other(format!("codex sample persist queue lock poisoned: {error}"))
        })?;
        if enqueue.sender.is_some() || enqueue.quiesced {
            return Err(tokio::io::Error::new(
                tokio::io::ErrorKind::AlreadyExists,
                "codex sample persist worker already started",
            ));
        }
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let stop_tx = tx.clone();
        let worker_store = Arc::clone(self);
        enqueue.sender = Some(tx.clone());
        drop(enqueue);
        let task = tokio::spawn(run_v3_codex_sample_persist_worker(worker_store, rx));

        Ok(V3CodexSamplePersistHandle {
            stop: Some(stop_tx),
            task: Mutex::new(Some(task)),
            store: Arc::clone(self),
        })
    }

    /// Hot-path enqueue owner. A rejected diagnostic write is reported out of band so it
    /// cannot turn a passable business request into a server error.
    pub fn enqueue_persist(self: &Arc<Self>, job: V3CodexSamplePersistJob) -> Result<(), String> {
        if !self.should_persist(job.force, job.status) {
            return Ok(());
        }
        let failure_request_id = job.request_id.clone();
        let failure_file_name = job.file_name.clone();
        let enqueue = match self.enqueue.read() {
            Ok(enqueue) => enqueue,
            Err(error) => {
                record_v3_codex_sample_persist_failure(
                    self,
                    failure_request_id,
                    failure_file_name,
                    format!("codex sample persist queue lock poisoned: {error}"),
                );
                return Ok(());
            }
        };
        if enqueue.quiesced {
            record_v3_codex_sample_persist_failure(
                self,
                failure_request_id,
                failure_file_name,
                "codex sample refused during exec preparation".to_string(),
            );
            return Ok(());
        }
        let Some(sender) = enqueue.sender.as_ref() else {
            record_v3_codex_sample_persist_failure(
                self,
                failure_request_id,
                failure_file_name,
                "codex sample persist worker is not running".to_string(),
            );
            return Ok(());
        };
        let payload_size = match serialized_v3_codex_sample_payload_size(&job.payload) {
            Ok(payload_size) => payload_size,
            Err(error) => {
                record_v3_codex_sample_persist_failure(
                    self,
                    failure_request_id,
                    failure_file_name,
                    format!("codex sample payload size could not be measured: {error}"),
                );
                return Ok(());
            }
        };
        let payload_size_with_overhead =
            payload_size.saturating_add(u64::from(V3_CODEX_SAMPLE_PERSIST_JOB_OVERHEAD_BYTES));
        let payload_permits = match u32::try_from(payload_size_with_overhead) {
            Ok(payload_permits) => payload_permits,
            Err(_) => {
                record_v3_codex_sample_persist_failure(
                    self,
                    failure_request_id,
                    failure_file_name,
                    "payload exceeds 64 MiB persistence budget".to_string(),
                );
                return Ok(());
            }
        };
        let payload_permit =
            match Arc::clone(&self.queued_payload_bytes).try_acquire_many_owned(payload_permits) {
                Ok(payload_permit) => payload_permit,
                Err(_) => {
                    record_v3_codex_sample_persist_failure(
                        self,
                        failure_request_id,
                        failure_file_name,
                        "payload exceeds 64 MiB persistence budget".to_string(),
                    );
                    return Ok(());
                }
            };
        let message = V3CodexSamplePersistQueueMessage::Persist {
            job,
            _payload_permit: payload_permit,
        };
        match sender.send(message) {
            Ok(()) => Ok(()),
            Err(tokio::sync::mpsc::error::SendError(
                V3CodexSamplePersistQueueMessage::Persist { job, .. },
            )) => {
                record_v3_codex_sample_persist_failure(
                    self,
                    job.request_id,
                    job.file_name,
                    "codex sample persist queue unavailable".to_string(),
                );
                Ok(())
            }
            Err(_) => unreachable!("sample persistence barriers use the queued send path"),
        }
    }
}

fn write_v3_codex_sample_atomically(target: &Path, payload: &Value) -> Result<(), String> {
    let parent = target.parent().ok_or("sample target has no parent")?;
    let target_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("sample target has no file name")?;
    let sequence = V3_CODEX_SAMPLE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp_path = parent.join(format!(
        ".{target_name}.tmp-{}-{sequence}",
        std::process::id()
    ));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp_path)
        .map_err(|error| format!("create sample temp: {error}"))?;
    let result = (|| -> Result<(), String> {
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, payload)
            .map_err(|error| format!("write {}: {error}", temp_path.display()))?;
        writer
            .write_all(b"\n")
            .map_err(|error| format!("write {}: {error}", temp_path.display()))?;
        writer
            .flush()
            .map_err(|error| format!("flush {}: {error}", temp_path.display()))?;
        drop(writer);
        fs::rename(&temp_path, target).map_err(|error| {
            format!(
                "publish {} to {}: {error}",
                temp_path.display(),
                target.display()
            )
        })
    })();
    match result {
        Ok(()) => Ok(()),
        Err(error) => match fs::remove_file(&temp_path) {
            Ok(()) => Err(error),
            Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => {
                Err(error)
            }
            Err(cleanup_error) => Err(format!(
                "{error}; cleanup sample temp {} failed: {cleanup_error}",
                temp_path.display()
            )),
        },
    }
}
fn serialized_v3_codex_sample_payload_size(payload: &Value) -> serde_json::Result<u64> {
    struct CountingWriter(u64);

    impl Write for CountingWriter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(buffer.len() as u64);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut writer = CountingWriter(0);
    serde_json::to_writer(&mut writer, payload)?;
    Ok(writer.0)
}

async fn run_v3_codex_sample_persist_worker(
    store: Arc<V3CodexSampleStore>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<V3CodexSamplePersistQueueMessage>,
) {
    while let Some(message) = rx.recv().await {
        match message {
            V3CodexSamplePersistQueueMessage::Persist {
                job,
                _payload_permit,
            } => {
                persist_v3_codex_sample_persist_job(Arc::clone(&store), job).await;
            }
            V3CodexSamplePersistQueueMessage::Barrier { reply } => {
                let _ = reply.send(store.persist_failure_snapshot());
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
    let mut failures = store.persist_failures.lock().unwrap_or_else(|error| {
        eprintln!("codex sample persist failure ledger lock poisoned: {error}");
        error.into_inner()
    });
    let failure = V3CodexSamplePersistFailure {
        request_id,
        file_name,
        reason,
    };
    if failures.record(failure.clone()) {
        eprintln!("codex sample persist failed: {failure}");
    }
}

impl V3CodexSamplePersistFailureLedger {
    fn record(&mut self, failure: V3CodexSamplePersistFailure) -> bool {
        if self.failures.len() < V3_CODEX_SAMPLE_PERSIST_FAILURE_LIMIT {
            self.failures.push(failure);
            true
        } else {
            self.additional_failures = self.additional_failures.saturating_add(1);
            false
        }
    }

    fn snapshot(&self) -> Vec<V3CodexSamplePersistFailure> {
        let mut failures = self.failures.clone();
        if self.additional_failures > 0 {
            failures.push(V3CodexSamplePersistFailure {
                request_id: "multiple".to_string(),
                file_name: "multiple".to_string(),
                reason: format!(
                    "{} additional codex sample persistence failures omitted",
                    self.additional_failures
                ),
            });
        }
        failures
    }

    fn take(&mut self) -> Vec<V3CodexSamplePersistFailure> {
        let mut failures = std::mem::take(&mut self.failures);
        let additional_failures = std::mem::take(&mut self.additional_failures);
        if additional_failures > 0 {
            failures.push(V3CodexSamplePersistFailure {
                request_id: "multiple".to_string(),
                file_name: "multiple".to_string(),
                reason: format!(
                    "{additional_failures} additional codex sample persistence failures omitted"
                ),
            });
        }
        failures
    }
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

/// Single owner of the debug sample root: `<HOME>/.rcc/codex-samples`.
/// The runtime sample writer, the server observability projection and the admin
/// artifact reader all resolve artifact locations through this function so the
/// layout never gets a second implementation.
pub fn resolve_v3_codex_samples_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "codex sample filesystem requires HOME".to_string())?;
    if home.to_string_lossy().trim().is_empty() {
        return Err("codex sample filesystem requires non-empty HOME".to_string());
    }
    Ok(PathBuf::from(home).join(".rcc").join("codex-samples"))
}

/// Single owner of the `<endpointDir>` mapping used below the samples root.
pub fn format_v3_codex_sample_endpoint_dir(entry_protocol: &str, endpoint: &str) -> String {
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

/// Single owner of the per-request sample directory segment encoding.
pub fn encode_v3_codex_sample_path_segment(value: &str) -> String {
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

/// Single owner of the per-request debug sample directory:
/// `<samples_root>/<endpointDir>/ports/<port>/<encoded request id>`.
///
/// Callers must treat a missing directory as "no artifact captured", never as
/// proof that the request succeeded or failed.
pub fn v3_codex_sample_request_dir(
    port: u16,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
) -> Result<PathBuf, String> {
    Ok(v3_codex_sample_request_dir_in(
        &resolve_v3_codex_samples_root()?,
        port,
        entry_protocol,
        endpoint,
        request_id,
    ))
}

/// Same layout, with the samples root supplied by the caller. Only the root
/// lookup is environment dependent, so this is the form pure callers and tests
/// use.
pub fn v3_codex_sample_request_dir_in(
    samples_root: &Path,
    port: u16,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
) -> PathBuf {
    samples_root
        .join(format_v3_codex_sample_endpoint_dir(
            entry_protocol,
            endpoint,
        ))
        .join("ports")
        .join(port.to_string())
        .join(encode_v3_codex_sample_path_segment(request_id))
}

// Startup retention and persistence share this directory across stores and
// processes. Keep the lock inode outside the request directories that retention
// removes; closing the File releases the lock on every success/error path.
fn lock_v3_codex_sample_filesystem(samples_root: &Path) -> Result<fs::File, String> {
    fs::create_dir_all(samples_root).map_err(|error| error.to_string())?;
    let path = samples_root.join(".retention.lock");
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&path)
        .map_err(|error| format!("codex sample filesystem lock {}: {error}", path.display()))?;
    file.lock()
        .map_err(|error| format!("codex sample filesystem lock {}: {error}", path.display()))?;
    Ok(file)
}

#[cfg(test)]
mod tests;
