use routecodex_v3_config::{V3Config05ManifestPublished, V3ConfigStore};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

const SCHEMA_VERSION: u16 = 1;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
const START_TAKEOVER_POLL: Duration = Duration::from_millis(150);
const DEFAULT_START_GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_START_FORCE_KILL_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Error)]
pub enum V3LifecycleError {
    #[error("managed lifecycle validation failed: {0}")]
    Validation(String),
    #[error("managed lifecycle IO failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("managed lifecycle config failed: {0}")]
    Config(#[from] routecodex_v3_config::V3ConfigError),
    #[error("managed lifecycle state JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("managed lifecycle operation is already locked for {0}")]
    OperationLocked(String),
    #[error("managed instance is already running: {0}")]
    AlreadyRunning(String),
    #[error("managed instance is not running: {0}")]
    NotRunning(String),
    #[error("managed instance identity mismatch: {0}")]
    IdentityMismatch(String),
    #[error("managed lifecycle control timed out: {0}")]
    Timeout(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3ManagedListenerDeclaration {
    pub server_id: String,
    pub bind: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3ManagedInstanceDeclaration {
    pub schema_version: u16,
    pub instance_id: String,
    pub config_path: String,
    pub config_digest: String,
    pub executable_path: String,
    pub listeners: Vec<V3ManagedListenerDeclaration>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3ManagedPidCache {
    pub schema_version: u16,
    pub instance_id: String,
    pub pid: u32,
    pub start_nonce: String,
    pub started_at_epoch_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3ManagedRunState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3ManagedStatusRecord {
    pub schema_version: u16,
    pub instance_id: String,
    pub state: V3ManagedRunState,
    pub updated_at_epoch_ms: u64,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3ManagedControlRecord {
    pub schema_version: u16,
    pub instance_id: String,
    pub socket_path: String,
    pub start_nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ControlOperation {
    Status,
    Stop,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControlRequest {
    schema_version: u16,
    instance_id: String,
    start_nonce: String,
    operation: ControlOperation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControlResponse {
    schema_version: u16,
    instance_id: String,
    accepted: bool,
    state: V3ManagedRunState,
    message: String,
}

#[derive(Debug, Clone)]
pub struct V3ManagedLifecycle {
    config_path: PathBuf,
    state_root: PathBuf,
    force_snapshots: bool,
    force_console: bool,
}

#[derive(Debug)]
struct OperationLock {
    path: PathBuf,
}

impl Drop for OperationLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

impl V3ManagedLifecycle {
    pub fn new(config_path: impl Into<PathBuf>) -> Result<Self, V3LifecycleError> {
        let state_root = match std::env::var_os("ROUTECODEX_V3_STATE_DIR") {
            Some(path) => PathBuf::from(path),
            None => {
                let home = std::env::var_os("HOME").ok_or_else(|| {
                    V3LifecycleError::Validation("HOME is required for managed state".to_string())
                })?;
                PathBuf::from(home)
                    .join(".rcc")
                    .join("state")
                    .join("v3-runtime")
            }
        };
        Ok(Self {
            config_path: config_path.into(),
            state_root,
            force_snapshots: false,
            force_console: false,
        })
    }

    pub fn with_state_root(
        config_path: impl Into<PathBuf>,
        state_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            config_path: config_path.into(),
            state_root: state_root.into(),
            force_snapshots: false,
            force_console: false,
        }
    }

    pub fn with_snapshots_enabled(mut self, enabled: bool) -> Self {
        self.force_snapshots = enabled;
        self
    }

    pub fn with_console_enabled(mut self, enabled: bool) -> Self {
        self.force_console = enabled;
        self
    }

    pub fn declaration(
        &self,
        executable_path: impl AsRef<Path>,
    ) -> Result<(V3ManagedInstanceDeclaration, V3Config05ManifestPublished), V3LifecycleError> {
        let snapshot =
            V3ConfigStore::new(&self.config_path).load_snapshot_with_source_identity()?;
        let config_path = snapshot.canonical_path;
        let executable_path = fs::canonicalize(executable_path)?;
        let config_digest = snapshot.source_sha256;
        let mut identity = Sha256::new();
        identity.update(config_path.as_os_str().as_encoded_bytes());
        identity.update([0]);
        identity.update(config_digest.as_bytes());
        let instance_id = format!("v3-{}", &format!("{:x}", identity.finalize())[..20]);
        let mut manifest = snapshot.manifest;
        if self.force_snapshots {
            manifest.debug.snapshots = true;
        }
        if self.force_console {
            manifest.debug.log_console = true;
        }
        let listeners = manifest
            .servers
            .values()
            .filter(|server| server.enabled)
            .map(|server| V3ManagedListenerDeclaration {
                server_id: server.id.clone(),
                bind: server.bind.clone(),
                port: server.port,
            })
            .collect::<Vec<_>>();
        if listeners.is_empty() {
            return Err(V3LifecycleError::Validation(
                "managed instance has no enabled listeners".to_string(),
            ));
        }
        if self.force_console && manifest.debug.log_file.is_none() {
            if let Some(port) = listeners.first().map(|listener| listener.port) {
                if let Some(home) = std::env::var_os("HOME") {
                    manifest.debug.log_file = Some(
                        PathBuf::from(home)
                            .join(".rcc")
                            .join("logs")
                            .join(format!("server-{port}.log"))
                            .display()
                            .to_string(),
                    );
                }
            }
        }
        Ok((
            V3ManagedInstanceDeclaration {
                schema_version: SCHEMA_VERSION,
                instance_id,
                config_path: config_path.display().to_string(),
                config_digest,
                executable_path: executable_path.display().to_string(),
                listeners,
            },
            manifest,
        ))
    }

    pub async fn start(
        &self,
        executable_path: impl AsRef<Path>,
        timeout: Duration,
    ) -> Result<V3ManagedStatusRecord, V3LifecycleError> {
        let (declaration, manifest) = self.declaration(executable_path.as_ref())?;
        validate_auth_handles(&manifest)?;
        let instance_dir = self.instance_dir(&declaration.instance_id);
        ensure_private_dir(&instance_dir)?;
        let _lock = acquire_operation_lock(&instance_dir, "start")?;
        release_listener_set_for_start(&instance_dir, &declaration).await?;
        reap_inactive_runtime_files(&instance_dir, &declaration)?;
        write_json_atomic(&instance_dir.join("instance.json"), &declaration)?;
        write_status(
            &instance_dir,
            &declaration.instance_id,
            V3ManagedRunState::Starting,
            None,
        )?;
        let log_path = instance_dir.join("server.log");
        let stdout = private_log_file(&log_path)?;
        let stderr = stdout.try_clone()?;
        let mut command = Command::new(executable_path.as_ref());
        command
            .arg("server")
            .arg("run-managed-child")
            .arg("--config")
            .arg(&declaration.config_path);
        if self.force_snapshots {
            command.arg("--snap");
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .process_group(0);
        let child = command.spawn()?;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(V3LifecycleError::Timeout(format!(
                    "start {} pid {}",
                    declaration.instance_id,
                    child.id()
                )));
            }
            if let Ok(status) = self.query_live(&declaration).await {
                if status.state == V3ManagedRunState::Running {
                    return Ok(status);
                }
            }
            let status_path = instance_dir.join("status.json");
            if status_path.exists() {
                let status: V3ManagedStatusRecord = read_json(&status_path)?;
                if status.state == V3ManagedRunState::Failed {
                    return Err(V3LifecycleError::Validation(
                        status
                            .detail
                            .unwrap_or_else(|| "managed child failed".to_string()),
                    ));
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    pub async fn start_foreground(
        &self,
        executable_path: impl AsRef<Path>,
    ) -> Result<(), V3LifecycleError> {
        let (declaration, manifest) = self.declaration(executable_path.as_ref())?;
        validate_auth_handles(&manifest)?;
        let instance_dir = self.instance_dir(&declaration.instance_id);
        ensure_private_dir(&instance_dir)?;
        {
            let _lock = acquire_operation_lock(&instance_dir, "start")?;
            release_listener_set_for_start(&instance_dir, &declaration).await?;
            reap_inactive_runtime_files(&instance_dir, &declaration)?;
            write_json_atomic(&instance_dir.join("instance.json"), &declaration)?;
            write_status(
                &instance_dir,
                &declaration.instance_id,
                V3ManagedRunState::Starting,
                None,
            )?;
        }
        self.run_managed_child_with_declaration(executable_path, declaration, manifest)
            .await
    }

    pub async fn status(
        &self,
        executable_path: impl AsRef<Path>,
    ) -> Result<V3ManagedStatusRecord, V3LifecycleError> {
        let (declaration, _) = self.declaration(executable_path)?;
        self.query_live(&declaration).await.or_else(|error| {
            let path = self
                .instance_dir(&declaration.instance_id)
                .join("status.json");
            if path.exists() {
                let status: V3ManagedStatusRecord = read_json(&path)?;
                if status.instance_id != declaration.instance_id {
                    return Err(V3LifecycleError::IdentityMismatch(
                        "status instance id differs from config identity".to_string(),
                    ));
                }
                if matches!(
                    status.state,
                    V3ManagedRunState::Stopped | V3ManagedRunState::Failed
                ) {
                    Ok(status)
                } else {
                    Err(error)
                }
            } else {
                let _ = error;
                Ok(V3ManagedStatusRecord {
                    schema_version: SCHEMA_VERSION,
                    instance_id: declaration.instance_id,
                    state: V3ManagedRunState::Stopped,
                    updated_at_epoch_ms: epoch_ms(),
                    detail: Some("no managed runtime state".to_string()),
                })
            }
        })
    }

    pub async fn stop(
        &self,
        executable_path: impl AsRef<Path>,
        timeout: Duration,
    ) -> Result<V3ManagedStatusRecord, V3LifecycleError> {
        let (declaration, _) = self.declaration(executable_path)?;
        let instance_dir = self.instance_dir(&declaration.instance_id);
        let _lock = acquire_operation_lock(&instance_dir, "stop")?;
        let response = send_control(&instance_dir, &declaration, ControlOperation::Stop).await?;
        if !response.accepted {
            return Err(V3LifecycleError::IdentityMismatch(response.message));
        }
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let status_path = instance_dir.join("status.json");
            if status_path.exists() {
                let status: V3ManagedStatusRecord = read_json(&status_path)?;
                if status.state == V3ManagedRunState::Stopped {
                    return Ok(status);
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(V3LifecycleError::Timeout(format!(
                    "stop {}",
                    declaration.instance_id
                )));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    pub async fn restart(
        &self,
        executable_path: impl AsRef<Path> + Clone,
        timeout: Duration,
    ) -> Result<V3ManagedStatusRecord, V3LifecycleError> {
        self.stop(executable_path.clone(), timeout).await?;
        self.start(executable_path, timeout).await
    }

    pub async fn run_managed_child(
        &self,
        executable_path: impl AsRef<Path>,
    ) -> Result<(), V3LifecycleError> {
        let (declaration, manifest) = self.declaration(&executable_path)?;
        validate_auth_handles(&manifest)?;
        self.run_managed_child_with_declaration(executable_path, declaration, manifest)
            .await
    }

    async fn run_managed_child_with_declaration(
        &self,
        _executable_path: impl AsRef<Path>,
        declaration: V3ManagedInstanceDeclaration,
        manifest: V3Config05ManifestPublished,
    ) -> Result<(), V3LifecycleError> {
        validate_auth_handles(&manifest)?;
        let instance_dir = self.instance_dir(&declaration.instance_id);
        ensure_private_dir(&instance_dir)?;
        verify_published_declaration(&instance_dir, &declaration)?;
        let start_nonce = new_start_nonce(&declaration.instance_id);
        let socket_path = managed_control_socket_path(&declaration.instance_id);
        if socket_path.exists() {
            return Err(V3LifecycleError::IdentityMismatch(format!(
                "control socket already exists without a verified stopped cleanup: {}",
                socket_path.display()
            )));
        }
        let listener = UnixListener::bind(&socket_path)?;
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))?;
        write_json_atomic(
            &instance_dir.join("pid.cache"),
            &V3ManagedPidCache {
                schema_version: SCHEMA_VERSION,
                instance_id: declaration.instance_id.clone(),
                pid: std::process::id(),
                start_nonce: start_nonce.clone(),
                started_at_epoch_ms: epoch_ms(),
            },
        )?;
        write_json_atomic(
            &instance_dir.join("control.json"),
            &V3ManagedControlRecord {
                schema_version: SCHEMA_VERSION,
                instance_id: declaration.instance_id.clone(),
                socket_path: socket_path.display().to_string(),
                start_nonce: start_nonce.clone(),
            },
        )?;
        let handle = match spawn_v3_server_aggregate(manifest).await {
            Ok(handle) => handle,
            Err(error) => {
                write_status(
                    &instance_dir,
                    &declaration.instance_id,
                    V3ManagedRunState::Failed,
                    Some(error.to_string()),
                )?;
                let _ = fs::remove_file(instance_dir.join("pid.cache"));
                let _ = fs::remove_file(instance_dir.join("control.json"));
                let _ = fs::remove_file(&socket_path);
                return Err(error.into());
            }
        };
        let mut handle = Some(handle);
        write_status(
            &instance_dir,
            &declaration.instance_id,
            V3ManagedRunState::Running,
            None,
        )?;
        let mut ctrl_c = Box::pin(tokio::signal::ctrl_c());
        loop {
            let (mut stream, _) = tokio::select! {
                signal = &mut ctrl_c => {
                    if let Err(error) = signal {
                        write_status(
                            &instance_dir,
                            &declaration.instance_id,
                            V3ManagedRunState::Failed,
                            Some(format!("ctrl_c handler failed: {error}")),
                        )?;
                        return Err(error.into());
                    }
                    let handle = handle.take().ok_or_else(|| {
                        V3LifecycleError::Validation("managed runtime handle was already consumed".to_string())
                    })?;
                    return shutdown_managed_runtime(&instance_dir, &declaration.instance_id, &socket_path, handle).await;
                }
                accepted = listener.accept() => accepted?,
            };
            let mut line = String::new();
            BufReader::new(&mut stream).read_line(&mut line).await?;
            let request: ControlRequest = serde_json::from_str(&line)?;
            let valid = request.schema_version == SCHEMA_VERSION
                && request.instance_id == declaration.instance_id
                && request.start_nonce == start_nonce;
            let should_stop = valid && request.operation == ControlOperation::Stop;
            let state = if should_stop {
                V3ManagedRunState::Stopping
            } else {
                V3ManagedRunState::Running
            };
            let response = ControlResponse {
                schema_version: SCHEMA_VERSION,
                instance_id: declaration.instance_id.clone(),
                accepted: valid,
                state: state.clone(),
                message: if valid {
                    "identity verified".to_string()
                } else {
                    "instance id or start nonce mismatch".to_string()
                },
            };
            stream.write_all(&serde_json::to_vec(&response)?).await?;
            stream.write_all(b"\n").await?;
            stream.flush().await?;
            if should_stop {
                let handle = handle.take().ok_or_else(|| {
                    V3LifecycleError::Validation(
                        "managed runtime handle was already consumed".to_string(),
                    )
                })?;
                return shutdown_managed_runtime(
                    &instance_dir,
                    &declaration.instance_id,
                    &socket_path,
                    handle,
                )
                .await;
            }
        }
    }

    fn instance_dir(&self, instance_id: &str) -> PathBuf {
        self.state_root.join("instances").join(instance_id)
    }

    async fn query_live(
        &self,
        declaration: &V3ManagedInstanceDeclaration,
    ) -> Result<V3ManagedStatusRecord, V3LifecycleError> {
        let instance_dir = self.instance_dir(&declaration.instance_id);
        verify_published_declaration(&instance_dir, declaration)?;
        let response = send_control(&instance_dir, declaration, ControlOperation::Status).await?;
        if !response.accepted {
            return Err(V3LifecycleError::IdentityMismatch(response.message));
        }
        Ok(V3ManagedStatusRecord {
            schema_version: SCHEMA_VERSION,
            instance_id: response.instance_id,
            state: response.state,
            updated_at_epoch_ms: epoch_ms(),
            detail: None,
        })
    }
}

async fn shutdown_managed_runtime(
    instance_dir: &Path,
    instance_id: &str,
    socket_path: &Path,
    handle: V3ServerAggregateHandle,
) -> Result<(), V3LifecycleError> {
    write_status(instance_dir, instance_id, V3ManagedRunState::Stopping, None)?;
    handle.shutdown().await;
    write_status(instance_dir, instance_id, V3ManagedRunState::Stopped, None)?;
    let _ = fs::remove_file(instance_dir.join("pid.cache"));
    let _ = fs::remove_file(instance_dir.join("control.json"));
    let _ = fs::remove_file(socket_path);
    Ok(())
}

async fn send_control(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    operation: ControlOperation,
) -> Result<ControlResponse, V3LifecycleError> {
    tokio::time::timeout(
        CONTROL_TIMEOUT,
        send_control_without_timeout(instance_dir, declaration, operation),
    )
    .await
    .map_err(|_| {
        V3LifecycleError::Timeout(format!("control challenge {}", declaration.instance_id))
    })?
}

async fn send_control_without_timeout(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    operation: ControlOperation,
) -> Result<ControlResponse, V3LifecycleError> {
    if !instance_dir.join("pid.cache").exists() || !instance_dir.join("control.json").exists() {
        return Err(V3LifecycleError::NotRunning(
            declaration.instance_id.clone(),
        ));
    }
    let pid: V3ManagedPidCache = read_json(&instance_dir.join("pid.cache"))?;
    let control: V3ManagedControlRecord = read_json(&instance_dir.join("control.json"))?;
    if pid.instance_id != declaration.instance_id
        || control.instance_id != declaration.instance_id
        || pid.start_nonce != control.start_nonce
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "pid/control cache does not match declaration".to_string(),
        ));
    }
    let mut stream = UnixStream::connect(&control.socket_path)
        .await
        .map_err(|_| V3LifecycleError::NotRunning(declaration.instance_id.clone()))?;
    let request = ControlRequest {
        schema_version: SCHEMA_VERSION,
        instance_id: declaration.instance_id.clone(),
        start_nonce: control.start_nonce,
        operation,
    };
    stream.write_all(&serde_json::to_vec(&request)?).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).await?;
    Ok(serde_json::from_str(&line)?)
}

fn validate_auth_handles(manifest: &V3Config05ManifestPublished) -> Result<(), V3LifecycleError> {
    for provider in manifest
        .providers
        .values()
        .filter(|provider| provider.enabled)
    {
        for entry in &provider.auth.entries {
            match (&entry.env, &entry.token_file) {
                (Some(name), None) => {
                    if std::env::var_os(name).is_none() {
                        return Err(V3LifecycleError::Validation(format!(
                            "provider {} auth {} environment handle {} is unavailable",
                            provider.id, entry.alias, name
                        )));
                    }
                }
                (None, Some(path)) => {
                    let mut file = File::open(path).map_err(|error| {
                        V3LifecycleError::Validation(format!(
                            "provider {} auth {} token-file handle is unreadable: {error}",
                            provider.id, entry.alias
                        ))
                    })?;
                    let mut one = [0_u8; 1];
                    if file.read(&mut one)? == 0 {
                        return Err(V3LifecycleError::Validation(format!(
                            "provider {} auth {} token-file handle is empty",
                            provider.id, entry.alias
                        )));
                    }
                }
                _ => {
                    return Err(V3LifecycleError::Validation(format!(
                        "provider {} auth {} has invalid handle shape",
                        provider.id, entry.alias
                    )))
                }
            }
        }
    }
    Ok(())
}

fn verify_published_declaration(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    let path = instance_dir.join("instance.json");
    if !path.exists() {
        return Err(V3LifecycleError::NotRunning(expected.instance_id.clone()));
    }
    let actual: V3ManagedInstanceDeclaration = read_json(&path)?;
    if actual != *expected {
        return Err(V3LifecycleError::IdentityMismatch(
            "published instance declaration differs from current config/executable".to_string(),
        ));
    }
    Ok(())
}

fn acquire_operation_lock(
    instance_dir: &Path,
    operation: &str,
) -> Result<OperationLock, V3LifecycleError> {
    ensure_private_dir(instance_dir)?;
    let path = instance_dir.join("lifecycle.lock");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                V3LifecycleError::OperationLocked(operation.to_string())
            } else {
                V3LifecycleError::Io(error)
            }
        })?;
    writeln!(file, "operation={operation} pid={}", std::process::id())?;
    Ok(OperationLock { path })
}

fn ensure_private_dir(path: &Path) -> Result<(), V3LifecycleError> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn private_log_file(path: &Path) -> Result<File, V3LifecycleError> {
    Ok(OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)?)
}

fn write_status(
    instance_dir: &Path,
    instance_id: &str,
    state: V3ManagedRunState,
    detail: Option<String>,
) -> Result<(), V3LifecycleError> {
    write_json_atomic(
        &instance_dir.join("status.json"),
        &V3ManagedStatusRecord {
            schema_version: SCHEMA_VERSION,
            instance_id: instance_id.to_string(),
            state,
            updated_at_epoch_ms: epoch_ms(),
            detail,
        },
    )
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), V3LifecycleError> {
    let parent = path.parent().ok_or_else(|| {
        V3LifecycleError::Validation(format!("state path has no parent: {}", path.display()))
    })?;
    ensure_private_dir(parent)?;
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temp, path)?;
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, V3LifecycleError> {
    Ok(serde_json::from_reader(File::open(path)?)?)
}

async fn release_listener_set_for_start(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    if listener_set_is_available(&declaration.listeners) {
        return Ok(());
    }

    let graceful_timeout = env_duration_ms(
        &[
            "ROUTECODEX_V3_STOP_TIMEOUT_MS",
            "RCC_V3_STOP_TIMEOUT_MS",
            "ROUTECODEX_STOP_TIMEOUT_MS",
        ],
        DEFAULT_START_GRACEFUL_STOP_TIMEOUT,
    );
    let force_timeout = env_duration_ms(
        &[
            "ROUTECODEX_V3_KILL_TIMEOUT_MS",
            "RCC_V3_KILL_TIMEOUT_MS",
            "ROUTECODEX_KILL_TIMEOUT_MS",
        ],
        DEFAULT_START_FORCE_KILL_TIMEOUT,
    );

    let _ = send_control(instance_dir, declaration, ControlOperation::Stop).await;
    if wait_for_listener_set_available(&declaration.listeners, graceful_timeout).await {
        return Ok(());
    }

    let terminate_pids = explicit_listener_pids(&declaration.listeners)?;
    signal_explicit_listener_pids(&terminate_pids, V3LifecycleSignal::Terminate)?;
    if wait_for_listener_set_available(&declaration.listeners, graceful_timeout).await {
        return Ok(());
    }

    let kill_pids = explicit_listener_pids(&declaration.listeners)?;
    signal_explicit_listener_pids(&kill_pids, V3LifecycleSignal::Kill)?;
    if wait_for_listener_set_available(&declaration.listeners, force_timeout).await {
        return Ok(());
    }

    let remaining = explicit_listener_pids(&declaration.listeners)?;
    Err(V3LifecycleError::Timeout(format!(
        "free managed listener set for start {} remaining_pids={}",
        declaration.instance_id,
        format_pid_list(&remaining)
    )))
}

fn listener_set_is_available(listeners: &[V3ManagedListenerDeclaration]) -> bool {
    listeners
        .iter()
        .all(|listener| listener_address_is_available(&listener.bind, listener.port))
}

async fn wait_for_listener_set_available(
    listeners: &[V3ManagedListenerDeclaration],
    timeout: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if listener_set_is_available(listeners) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return listener_set_is_available(listeners);
        }
        tokio::time::sleep(START_TAKEOVER_POLL).await;
    }
}

fn explicit_listener_pids(
    listeners: &[V3ManagedListenerDeclaration],
) -> Result<Vec<u32>, V3LifecycleError> {
    let mut pids = BTreeSet::new();
    for listener in listeners {
        for pid in listening_pids_for_port(listener.port)? {
            if pid != std::process::id() {
                pids.insert(pid);
            }
        }
    }
    Ok(pids.into_iter().collect())
}

fn listening_pids_for_port(port: u16) -> Result<Vec<u32>, V3LifecycleError> {
    let output = Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
        .map_err(|error| {
            V3LifecycleError::Validation(format!(
                "failed to discover explicit listener PID for port {port}: {error}"
            ))
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() && stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    if !output.status.success() {
        return Err(V3LifecycleError::Validation(format!(
            "failed to discover explicit listener PID for port {port}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let mut pids = Vec::new();
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let pid = line.parse::<u32>().map_err(|error| {
            V3LifecycleError::Validation(format!(
                "lsof returned non-numeric listener PID for port {port}: {line}: {error}"
            ))
        })?;
        if pid > 0 {
            pids.push(pid);
        }
    }
    Ok(pids)
}

#[derive(Debug, Clone, Copy)]
enum V3LifecycleSignal {
    Terminate,
    Kill,
}

fn signal_explicit_listener_pids(
    pids: &[u32],
    signal: V3LifecycleSignal,
) -> Result<(), V3LifecycleError> {
    for pid in pids {
        signal_explicit_pid(*pid, signal)?;
    }
    Ok(())
}

fn signal_explicit_pid(pid: u32, signal: V3LifecycleSignal) -> Result<(), V3LifecycleError> {
    if pid == 0 || pid == std::process::id() {
        return Ok(());
    }
    let raw_signal = match signal {
        V3LifecycleSignal::Terminate => libc::SIGTERM,
        V3LifecycleSignal::Kill => libc::SIGKILL,
    };
    let result = unsafe { libc::kill(pid as libc::pid_t, raw_signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(V3LifecycleError::Io(error))
}

fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if result == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn format_pid_list(pids: &[u32]) -> String {
    if pids.is_empty() {
        return "none".to_string();
    }
    pids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn reap_inactive_runtime_files(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    let status_path = instance_dir.join("status.json");
    let status = if status_path.exists() {
        let status: V3ManagedStatusRecord = read_json(&status_path)?;
        if status.instance_id != expected.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap status for a different instance".to_string(),
            ));
        }
        Some(status)
    } else {
        None
    };
    let terminal_status = status.as_ref().is_some_and(|status| {
        matches!(
            status.state,
            V3ManagedRunState::Stopped | V3ManagedRunState::Failed
        )
    });
    let stale_unreachable_runtime_status = if status.as_ref().is_some_and(|status| {
        !matches!(
            status.state,
            V3ManagedRunState::Stopped | V3ManagedRunState::Failed
        )
    }) {
        owned_unreachable_runtime_state_is_reapable(instance_dir, expected)?
    } else {
        false
    };
    let declaration_path = instance_dir.join("instance.json");
    if declaration_path.exists() {
        let declaration: V3ManagedInstanceDeclaration = read_json(&declaration_path)?;
        if declaration != *expected
            && !((terminal_status || stale_unreachable_runtime_status)
                && same_instance_declaration_except_executable_path(&declaration, expected))
        {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap state for a different instance declaration".to_string(),
            ));
        }
    }
    if let Some(status) = status {
        if !matches!(
            status.state,
            V3ManagedRunState::Stopped | V3ManagedRunState::Failed
        ) && !stale_unreachable_runtime_status
        {
            return Err(V3LifecycleError::IdentityMismatch(format!(
                "refusing to reap non-terminal managed state {:?}",
                status.state
            )));
        }
    } else if instance_dir.join("pid.cache").exists() || instance_dir.join("control.json").exists()
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "refusing to reap runtime caches without a terminal status record".to_string(),
        ));
    }
    let control_path = instance_dir.join("control.json");
    if control_path.exists() {
        let control: V3ManagedControlRecord = read_json(&control_path)?;
        if control.instance_id != expected.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap control record for a different instance".to_string(),
            ));
        }
        let socket_path = PathBuf::from(control.socket_path);
        if socket_path != managed_control_socket_path(&expected.instance_id) {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap non-canonical managed control socket path".to_string(),
            ));
        }
        if socket_path.exists() {
            fs::remove_file(socket_path)?;
        }
    }
    for file in ["pid.cache", "control.json"] {
        let path = instance_dir.join(file);
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn owned_unreachable_runtime_state_is_reapable(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    let pid_path = instance_dir.join("pid.cache");
    let cached_pid = if pid_path.exists() {
        let pid: V3ManagedPidCache = read_json(&pid_path)?;
        if pid.instance_id != expected.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap pid cache for a different instance".to_string(),
            ));
        }
        Some(pid)
    } else {
        None
    };

    let control_path = instance_dir.join("control.json");
    if control_path.exists() {
        let control: V3ManagedControlRecord = read_json(&control_path)?;
        if control.instance_id != expected.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap control record for a different instance".to_string(),
            ));
        }
        let socket_path = PathBuf::from(&control.socket_path);
        if socket_path != managed_control_socket_path(&expected.instance_id) {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap non-canonical managed control socket path".to_string(),
            ));
        }
        if socket_path.exists() && cached_pid.as_ref().is_some_and(|pid| pid_is_alive(pid.pid)) {
            return Ok(false);
        }
        if let Some(pid) = cached_pid.as_ref() {
            if pid.start_nonce != control.start_nonce {
                return Err(V3LifecycleError::IdentityMismatch(
                    "refusing to reap pid/control cache with mismatched nonce".to_string(),
                ));
            }
        }
    }

    for listener in &expected.listeners {
        if !listener_address_is_available(&listener.bind, listener.port) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn listener_address_is_available(bind: &str, port: u16) -> bool {
    std::net::TcpListener::bind((bind, port)).is_ok()
}

fn same_instance_declaration_except_executable_path(
    stored: &V3ManagedInstanceDeclaration,
    expected: &V3ManagedInstanceDeclaration,
) -> bool {
    stored.schema_version == expected.schema_version
        && stored.instance_id == expected.instance_id
        && stored.config_path == expected.config_path
        && stored.config_digest == expected.config_digest
        && stored.listeners == expected.listeners
}

fn managed_control_socket_path(instance_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!("routecodex-{instance_id}.sock"))
}

fn new_start_nonce(instance_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(instance_id.as_bytes());
    digest.update(std::process::id().to_le_bytes());
    digest.update(epoch_ms().to_le_bytes());
    format!("{:x}", digest.finalize())
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn env_duration_ms(names: &[&str], default: Duration) -> Duration {
    for name in names {
        let Some(raw) = std::env::var_os(name) else {
            continue;
        };
        let Some(raw) = raw.to_str() else {
            continue;
        };
        let Ok(parsed) = raw.trim().parse::<u64>() else {
            continue;
        };
        return Duration::from_millis(parsed);
    }
    default
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::TempDir;

    static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn fixture(root: &TempDir) -> (PathBuf, PathBuf, PathBuf) {
        let config = root.path().join("config.v3.toml");
        let executable = std::env::current_exe().unwrap();
        let state = root.path().join("state");
        fs::write(
            &config,
            format!(
                r#"version = 3
[servers.test]
bind = "127.0.0.1"
port = {}
routing_group = "default"
endpoints = ["responses"]
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_LIFECYCLE_TEST_KEY" }}] }}
[providers.test.models.test]
wire_name = "test"
capabilities = ["text"]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#,
                45499
            ),
        )
        .unwrap();
        (config, executable, state)
    }

    #[test]
    fn deterministic_identity_and_unknown_state_fields_fail() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
        let root = TempDir::new().unwrap();
        let (config, executable, state) = fixture(&root);
        let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
        let (first, _) = lifecycle.declaration(&executable).unwrap();
        let (second, _) = lifecycle.declaration(&executable).unwrap();
        assert_eq!(first, second);
        let instance_dir = state.join("instances").join(&first.instance_id);
        ensure_private_dir(&instance_dir).unwrap();
        fs::write(
            instance_dir.join("status.json"),
            format!(
                r#"{{"schema_version":1,"instance_id":"{}","state":"running","updated_at_epoch_ms":1,"detail":null,"secret":"forbidden"}}"#,
                first.instance_id
            ),
        )
        .unwrap();
        let error = read_json::<V3ManagedStatusRecord>(&instance_dir.join("status.json"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("unknown field"));
    }

    #[test]
    fn operation_lock_is_exclusive_and_auth_handle_is_required() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let root = TempDir::new().unwrap();
        let (config, executable, state) = fixture(&root);
        std::env::remove_var("V3_LIFECYCLE_TEST_KEY");
        let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
        let (_, manifest) = lifecycle.declaration(&executable).unwrap();
        assert!(validate_auth_handles(&manifest).is_err());
        std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
        let (declaration, _) = lifecycle.declaration(&executable).unwrap();
        let instance_dir = state.join("instances").join(declaration.instance_id);
        let first = acquire_operation_lock(&instance_dir, "first").unwrap();
        assert!(matches!(
            acquire_operation_lock(&instance_dir, "second"),
            Err(V3LifecycleError::OperationLocked(_))
        ));
        drop(first);
        acquire_operation_lock(&instance_dir, "third").unwrap();
    }

    #[test]
    fn state_projection_never_contains_resolved_secret() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret-value");
        let root = TempDir::new().unwrap();
        let (config, executable, state) = fixture(&root);
        let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
        let (declaration, _) = lifecycle.declaration(&executable).unwrap();
        let rendered = serde_json::to_string(&declaration).unwrap();
        assert!(!rendered.contains("controlled-secret-value"));
        assert!(!rendered.contains("V3_LIFECYCLE_TEST_KEY"));
    }

    #[test]
    fn published_declaration_mismatch_is_rejected_without_reaping() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
        let root = TempDir::new().unwrap();
        let (config, executable, state) = fixture(&root);
        let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
        let (declaration, _) = lifecycle.declaration(&executable).unwrap();
        let instance_dir = state.join("instances").join(&declaration.instance_id);
        ensure_private_dir(&instance_dir).unwrap();
        let mut wrong = declaration.clone();
        wrong.config_digest = "wrong-digest".to_string();
        write_json_atomic(&instance_dir.join("instance.json"), &wrong).unwrap();
        assert!(matches!(
            verify_published_declaration(&instance_dir, &declaration),
            Err(V3LifecycleError::IdentityMismatch(_))
        ));
        assert!(matches!(
            reap_inactive_runtime_files(&instance_dir, &declaration),
            Err(V3LifecycleError::IdentityMismatch(_))
        ));
        assert!(instance_dir.join("instance.json").exists());
    }

    #[test]
    fn terminal_state_allows_reaping_stale_release_executable_path_for_same_config_identity() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
        let root = TempDir::new().unwrap();
        let (config, executable, state) = fixture(&root);
        let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
        let (declaration, _) = lifecycle.declaration(&executable).unwrap();
        let instance_dir = state.join("instances").join(&declaration.instance_id);
        ensure_private_dir(&instance_dir).unwrap();
        let mut old_release = declaration.clone();
        old_release.executable_path = root
            .path()
            .join("old-release")
            .join("routecodex-v3")
            .display()
            .to_string();
        write_json_atomic(&instance_dir.join("instance.json"), &old_release).unwrap();
        write_status(
            &instance_dir,
            &declaration.instance_id,
            V3ManagedRunState::Stopped,
            Some("old release path removed after install".to_string()),
        )
        .unwrap();

        reap_inactive_runtime_files(&instance_dir, &declaration).unwrap();
        assert!(instance_dir.join("instance.json").exists());
        assert!(instance_dir.join("status.json").exists());
    }

    #[test]
    fn non_terminal_runtime_state_is_never_reaped_after_control_probe_failure() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
        let root = TempDir::new().unwrap();
        let (config, executable, state) = fixture(&root);
        let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
        let (declaration, _) = lifecycle.declaration(&executable).unwrap();
        let instance_dir = state.join("instances").join(&declaration.instance_id);
        ensure_private_dir(&instance_dir).unwrap();
        write_json_atomic(&instance_dir.join("instance.json"), &declaration).unwrap();
        write_status(
            &instance_dir,
            &declaration.instance_id,
            V3ManagedRunState::Running,
            Some("control probe temporarily unavailable".to_string()),
        )
        .unwrap();
        let occupied = std::net::TcpListener::bind(("127.0.0.1", 45499)).unwrap();
        write_json_atomic(
            &instance_dir.join("pid.cache"),
            &V3ManagedPidCache {
                schema_version: SCHEMA_VERSION,
                instance_id: declaration.instance_id.clone(),
                pid: 42,
                start_nonce: "active-release".to_string(),
                started_at_epoch_ms: 1,
            },
        )
        .unwrap();

        assert!(matches!(
            reap_inactive_runtime_files(&instance_dir, &declaration),
            Err(V3LifecycleError::IdentityMismatch(_))
        ));
        assert!(instance_dir.join("pid.cache").exists());
        assert!(instance_dir.join("status.json").exists());
        drop(occupied);
    }

    #[test]
    fn stale_running_state_allows_release_snapshot_executable_rollover_when_control_is_gone() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
        let root = TempDir::new().unwrap();
        let (config, executable, state) = fixture(&root);
        let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
        let (published, _) = lifecycle.declaration(&executable).unwrap();
        let instance_dir = state.join("instances").join(&published.instance_id);
        ensure_private_dir(&instance_dir).unwrap();

        let next_release = root.path().join("next-release-rccv3");
        fs::write(&next_release, b"next release executable identity").unwrap();
        let mut expected = published.clone();
        expected.executable_path = fs::canonicalize(&next_release)
            .unwrap()
            .display()
            .to_string();

        write_json_atomic(&instance_dir.join("instance.json"), &published).unwrap();
        write_status(
            &instance_dir,
            &published.instance_id,
            V3ManagedRunState::Running,
            Some("previous release lost pid and control socket after install rollover".to_string()),
        )
        .unwrap();
        write_json_atomic(
            &instance_dir.join("pid.cache"),
            &V3ManagedPidCache {
                schema_version: SCHEMA_VERSION,
                instance_id: published.instance_id.clone(),
                pid: 42,
                start_nonce: "previous-release".to_string(),
                started_at_epoch_ms: 1,
            },
        )
        .unwrap();
        let socket_path = managed_control_socket_path(&published.instance_id);
        assert!(!socket_path.exists());
        write_json_atomic(
            &instance_dir.join("control.json"),
            &V3ManagedControlRecord {
                schema_version: SCHEMA_VERSION,
                instance_id: published.instance_id.clone(),
                socket_path: socket_path.display().to_string(),
                start_nonce: "previous-release".to_string(),
            },
        )
        .unwrap();

        reap_inactive_runtime_files(&instance_dir, &expected).unwrap();

        assert!(!instance_dir.join("pid.cache").exists());
        assert!(!instance_dir.join("control.json").exists());
        assert!(!socket_path.exists());
    }

    #[test]
    fn foreign_control_record_is_never_reaped_from_terminal_state() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
        let root = TempDir::new().unwrap();
        let (config, executable, state) = fixture(&root);
        let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
        let (declaration, _) = lifecycle.declaration(&executable).unwrap();
        let instance_dir = state.join("instances").join(&declaration.instance_id);
        ensure_private_dir(&instance_dir).unwrap();
        write_json_atomic(&instance_dir.join("instance.json"), &declaration).unwrap();
        write_status(
            &instance_dir,
            &declaration.instance_id,
            V3ManagedRunState::Stopped,
            Some("terminal cleanup permitted only for owned control truth".to_string()),
        )
        .unwrap();
        let foreign_instance_id = format!("{}-foreign", declaration.instance_id);
        let foreign_socket = managed_control_socket_path(&foreign_instance_id);
        fs::write(&foreign_socket, b"foreign-control-socket-marker").unwrap();
        write_json_atomic(
            &instance_dir.join("control.json"),
            &V3ManagedControlRecord {
                schema_version: SCHEMA_VERSION,
                instance_id: foreign_instance_id,
                socket_path: foreign_socket.display().to_string(),
                start_nonce: "foreign".to_string(),
            },
        )
        .unwrap();

        assert!(matches!(
            reap_inactive_runtime_files(&instance_dir, &declaration),
            Err(V3LifecycleError::IdentityMismatch(_))
        ));
        assert!(foreign_socket.exists());
        let _ = fs::remove_file(foreign_socket);
    }

    #[test]
    fn stopped_instance_state_allows_release_snapshot_executable_rollover() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
        let root = TempDir::new().unwrap();
        let (config, executable, state) = fixture(&root);
        let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
        let (published, _) = lifecycle.declaration(&executable).unwrap();
        let instance_dir = state.join("instances").join(&published.instance_id);
        ensure_private_dir(&instance_dir).unwrap();

        let next_release = root.path().join("next-release-routecodex-v3");
        fs::write(&next_release, b"next release executable identity").unwrap();
        let mut expected = published.clone();
        expected.executable_path = fs::canonicalize(&next_release)
            .unwrap()
            .display()
            .to_string();

        write_json_atomic(&instance_dir.join("instance.json"), &published).unwrap();
        write_status(
            &instance_dir,
            &published.instance_id,
            V3ManagedRunState::Stopped,
            Some("previous release stopped cleanly".to_string()),
        )
        .unwrap();
        write_json_atomic(
            &instance_dir.join("pid.cache"),
            &V3ManagedPidCache {
                schema_version: SCHEMA_VERSION,
                instance_id: published.instance_id.clone(),
                pid: 42,
                start_nonce: "previous-release".to_string(),
                started_at_epoch_ms: 1,
            },
        )
        .unwrap();
        let socket_path = managed_control_socket_path(&published.instance_id);
        fs::write(&socket_path, b"stale owned control socket").unwrap();
        write_json_atomic(
            &instance_dir.join("control.json"),
            &V3ManagedControlRecord {
                schema_version: SCHEMA_VERSION,
                instance_id: published.instance_id.clone(),
                socket_path: socket_path.display().to_string(),
                start_nonce: "previous-release".to_string(),
            },
        )
        .unwrap();

        reap_inactive_runtime_files(&instance_dir, &expected).unwrap();

        assert!(!instance_dir.join("pid.cache").exists());
        assert!(!instance_dir.join("control.json").exists());
        assert!(!socket_path.exists());
    }

    #[test]
    fn running_instance_state_rejects_release_snapshot_executable_rollover() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
        let root = TempDir::new().unwrap();
        let (config, executable, state) = fixture(&root);
        let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
        let (published, _) = lifecycle.declaration(&executable).unwrap();
        let instance_dir = state.join("instances").join(&published.instance_id);
        ensure_private_dir(&instance_dir).unwrap();

        let mut expected = published.clone();
        expected.executable_path = root
            .path()
            .join("active-release-must-not-be-taken-over")
            .display()
            .to_string();
        write_json_atomic(&instance_dir.join("instance.json"), &published).unwrap();
        write_status(
            &instance_dir,
            &published.instance_id,
            V3ManagedRunState::Running,
            Some("active previous release".to_string()),
        )
        .unwrap();
        let occupied =
            std::net::TcpListener::bind(("127.0.0.1", published.listeners[0].port)).unwrap();
        write_json_atomic(
            &instance_dir.join("pid.cache"),
            &V3ManagedPidCache {
                schema_version: SCHEMA_VERSION,
                instance_id: published.instance_id.clone(),
                pid: 42,
                start_nonce: "active-release".to_string(),
                started_at_epoch_ms: 1,
            },
        )
        .unwrap();

        assert!(matches!(
            reap_inactive_runtime_files(&instance_dir, &expected),
            Err(V3LifecycleError::IdentityMismatch(_))
        ));
        assert!(instance_dir.join("pid.cache").exists());
        assert!(instance_dir.join("instance.json").exists());
        drop(occupied);
    }
}
