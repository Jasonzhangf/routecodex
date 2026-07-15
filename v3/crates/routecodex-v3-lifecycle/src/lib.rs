use routecodex_v3_config::{V3Config05ManifestPublished, V3ConfigStore};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
        })
    }

    pub fn with_state_root(
        config_path: impl Into<PathBuf>,
        state_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            config_path: config_path.into(),
            state_root: state_root.into(),
        }
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
        let manifest = snapshot.manifest;
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
        if let Ok(status) = self.query_live(&declaration).await {
            if status.state == V3ManagedRunState::Running {
                return Err(V3LifecycleError::AlreadyRunning(declaration.instance_id));
            }
        }
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
            .arg(&declaration.config_path)
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
        let (declaration, manifest) = self.declaration(executable_path)?;
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
        let handle = match spawn_v3_server_aggregate(manifest).await {
            Ok(handle) => handle,
            Err(error) => {
                write_status(
                    &instance_dir,
                    &declaration.instance_id,
                    V3ManagedRunState::Failed,
                    Some(error.to_string()),
                )?;
                return Err(error.into());
            }
        };
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
        write_status(
            &instance_dir,
            &declaration.instance_id,
            V3ManagedRunState::Running,
            None,
        )?;
        loop {
            let (mut stream, _) = listener.accept().await?;
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
                write_status(
                    &instance_dir,
                    &declaration.instance_id,
                    V3ManagedRunState::Stopping,
                    None,
                )?;
                handle.shutdown().await;
                write_status(
                    &instance_dir,
                    &declaration.instance_id,
                    V3ManagedRunState::Stopped,
                    None,
                )?;
                let _ = fs::remove_file(instance_dir.join("pid.cache"));
                let _ = fs::remove_file(instance_dir.join("control.json"));
                let _ = fs::remove_file(&socket_path);
                return Ok(());
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

fn reap_inactive_runtime_files(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    let declaration_path = instance_dir.join("instance.json");
    if declaration_path.exists() {
        let declaration: V3ManagedInstanceDeclaration = read_json(&declaration_path)?;
        if declaration != *expected {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap state for a different instance declaration".to_string(),
            ));
        }
    }
    let status_path = instance_dir.join("status.json");
    if status_path.exists() {
        let status: V3ManagedStatusRecord = read_json(&status_path)?;
        if status.instance_id != expected.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap status for a different instance".to_string(),
            ));
        }
        if !matches!(
            status.state,
            V3ManagedRunState::Stopped | V3ManagedRunState::Failed
        ) {
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
        let socket_path = PathBuf::from(control.socket_path);
        if socket_path == managed_control_socket_path(&control.instance_id) && socket_path.exists()
        {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

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
    fn non_terminal_runtime_state_is_never_reaped_after_control_probe_failure() {
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
        fs::write(instance_dir.join("pid.cache"), b"preserve-active-cache").unwrap();

        assert!(matches!(
            reap_inactive_runtime_files(&instance_dir, &declaration),
            Err(V3LifecycleError::IdentityMismatch(_))
        ));
        assert!(instance_dir.join("pid.cache").exists());
        assert!(instance_dir.join("status.json").exists());
    }
}
