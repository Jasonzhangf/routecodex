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
const RESTART_PLAN_FILE: &str = "restart.plan.json";

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
    Restart,
    ReleasePorts,
    Stop,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControlRequest {
    schema_version: u16,
    instance_id: String,
    start_nonce: String,
    operation: ControlOperation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ports: Option<Vec<u16>>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct V3ManagedRestartPlanRecord {
    schema_version: u16,
    instance_id: String,
    start_nonce: String,
    executable_path: String,
    snapshots: bool,
    snapshot_stages: Option<String>,
}

#[derive(Debug, Clone)]
struct ControlRestartPlan {
    declaration: V3ManagedInstanceDeclaration,
    executable_path: PathBuf,
    snapshots: bool,
    snapshot_stages: Option<String>,
}

#[derive(Debug, Clone)]
pub struct V3ManagedLifecycle {
    config_path: PathBuf,
    state_root: PathBuf,
    force_snapshots: bool,
    force_snapshot_stages: Option<String>,
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
            force_snapshot_stages: None,
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
            force_snapshot_stages: None,
            force_console: false,
        }
    }

    pub fn with_snapshots_enabled(mut self, enabled: bool) -> Self {
        self.force_snapshots = enabled;
        self
    }

    pub fn with_snapshot_stages(mut self, stages: Option<String>) -> Self {
        self.force_snapshot_stages = stages
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if self.force_snapshot_stages.is_some() {
            self.force_snapshots = true;
        }
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
        if let Some(stages) = self.force_snapshot_stages.as_ref() {
            manifest.debug.snapshots = true;
            manifest.debug.snapshot_stages = Some(stages.clone());
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
        release_listener_set_for_start(&self.state_root, &instance_dir, &declaration).await?;
        reap_inactive_runtime_files(&instance_dir, &declaration)?;
        write_json_atomic(&instance_dir.join("instance.json"), &declaration)?;
        write_status(
            &instance_dir,
            &declaration.instance_id,
            V3ManagedRunState::Starting,
            None,
        )?;
        self.spawn_managed_child_after_state_published(
            executable_path.as_ref(),
            &declaration,
            timeout,
        )
        .await
    }

    async fn spawn_managed_child_after_state_published(
        &self,
        executable_path: &Path,
        declaration: &V3ManagedInstanceDeclaration,
        timeout: Duration,
    ) -> Result<V3ManagedStatusRecord, V3LifecycleError> {
        let instance_dir = self.instance_dir(&declaration.instance_id);
        let log_path = instance_dir.join("server.log");
        let stdout = private_log_file(&log_path)?;
        let stderr = stdout.try_clone()?;
        let mut command = Command::new(executable_path);
        command
            .arg("server")
            .arg("run-managed-child")
            .arg("--config")
            .arg(&declaration.config_path);
        if self.force_snapshots {
            command.arg("--snap");
        }
        if let Some(stages) = self.force_snapshot_stages.as_ref() {
            command.arg("--snap-stages").arg(stages);
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
            if let Ok(status) = self.query_live(declaration).await {
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
            release_listener_set_for_start(&self.state_root, &instance_dir, &declaration).await?;
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
        let (declaration, manifest) = self.declaration(executable_path.as_ref())?;
        let instance_dir = self.instance_dir(&declaration.instance_id);
        ensure_private_dir(&instance_dir)?;
        let _lock = acquire_operation_lock(&instance_dir, "restart")?;
        let (control_instance_dir, mut control_declaration, _previous_owner_lock) =
            if instance_has_control_truth(&instance_dir) {
                (instance_dir.clone(), declaration.clone(), None)
            } else {
                let previous_owner =
                    find_live_previous_owner_for_restart(&self.state_root, &declaration)?;
                let Some((previous_instance_dir, previous_declaration)) = previous_owner else {
                    return Err(V3LifecycleError::NotRunning(
                        declaration.instance_id.clone(),
                    ));
                };
                let previous_owner_lock =
                    acquire_operation_lock(&previous_instance_dir, "restart")?;
                (
                    previous_instance_dir,
                    previous_declaration,
                    Some(previous_owner_lock),
                )
            };
        control_declaration.executable_path = declaration.executable_path.clone();
        let response = match send_restart_control(
            &control_instance_dir,
            &control_declaration,
            self.force_snapshots,
            self.force_snapshot_stages.clone(),
        )
        .await
        {
            Ok(response) => response,
            Err(error @ V3LifecycleError::NotRunning(_)) => {
                if !restart_recovery_state_is_stale_owned_unreachable(&instance_dir, &declaration)?
                {
                    return Err(error);
                }
                validate_auth_handles(&manifest)?;
                reap_inactive_runtime_files(&instance_dir, &declaration)?;
                write_json_atomic(&instance_dir.join("instance.json"), &declaration)?;
                write_status(
                    &instance_dir,
                    &declaration.instance_id,
                    V3ManagedRunState::Starting,
                    Some("restart recovered stale owned runtime".to_string()),
                )?;
                return self
                    .spawn_managed_child_after_state_published(
                        executable_path.as_ref(),
                        &declaration,
                        timeout,
                    )
                    .await;
            }
            Err(error) => return Err(error),
        };
        if !response.accepted {
            return Err(V3LifecycleError::IdentityMismatch(response.message));
        }
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Ok(status) = self.query_live(&declaration).await {
                if status.state == V3ManagedRunState::Running {
                    return Ok(status);
                }
            }
            let status_path = instance_dir.join("status.json");
            if status_path.exists() {
                let status: V3ManagedStatusRecord = read_json(&status_path)?;
                if status.state == V3ManagedRunState::Failed {
                    return Err(V3LifecycleError::Validation(status.detail.unwrap_or_else(
                        || "managed child failed during restart".to_string(),
                    )));
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(V3LifecycleError::Timeout(format!(
                    "restart {}",
                    declaration.instance_id
                )));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
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
        if let Err(error) = verify_published_declaration(&instance_dir, &declaration) {
            if !adopt_exec_restart_declaration_change(
                &self.state_root,
                &instance_dir,
                &declaration,
            )? {
                return Err(error);
            }
            verify_published_declaration(&instance_dir, &declaration)?;
        }
        let start_nonce = new_start_nonce(&declaration.instance_id);
        let socket_path = managed_control_socket_path(&declaration.instance_id);
        remove_restart_plan_for_previous_control_identity(&instance_dir, &start_nonce)?;
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
            let valid_identity = request.schema_version == SCHEMA_VERSION
                && request.instance_id == declaration.instance_id
                && request.start_nonce == start_nonce;
            let restart_plan = if valid_identity {
                match control_restart_plan(&instance_dir, &request, &declaration) {
                    Ok(plan) => plan,
                    Err(message) => {
                        let response = ControlResponse {
                            schema_version: SCHEMA_VERSION,
                            instance_id: declaration.instance_id.clone(),
                            accepted: false,
                            state: V3ManagedRunState::Running,
                            message,
                        };
                        stream.write_all(&serde_json::to_vec(&response)?).await?;
                        stream.write_all(b"\n").await?;
                        stream.flush().await?;
                        continue;
                    }
                }
            } else {
                None
            };
            let release_ports = if valid_identity {
                match control_release_ports(&request, &declaration) {
                    Ok(ports) => ports,
                    Err(message) => {
                        let response = ControlResponse {
                            schema_version: SCHEMA_VERSION,
                            instance_id: declaration.instance_id.clone(),
                            accepted: false,
                            state: V3ManagedRunState::Running,
                            message,
                        };
                        stream.write_all(&serde_json::to_vec(&response)?).await?;
                        stream.write_all(b"\n").await?;
                        stream.flush().await?;
                        continue;
                    }
                }
            } else {
                None
            };
            let valid = valid_identity;
            let should_stop = valid && request.operation == ControlOperation::Stop;
            let should_restart = valid && request.operation == ControlOperation::Restart;
            let should_release_ports = valid && request.operation == ControlOperation::ReleasePorts;
            let state = if should_stop {
                V3ManagedRunState::Stopping
            } else if should_restart {
                V3ManagedRunState::Starting
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
            if should_release_ports {
                let release_ports = release_ports.ok_or_else(|| {
                    V3LifecycleError::Validation(
                        "release-ports control request did not carry a port set".to_string(),
                    )
                })?;
                let aggregate_handle = handle.as_mut().ok_or_else(|| {
                    V3LifecycleError::Validation(
                        "managed runtime handle was already consumed".to_string(),
                    )
                })?;
                let released = aggregate_handle
                    .shutdown_listener_ports(&release_ports)
                    .await;
                let released_set: BTreeSet<u16> = released.into_iter().collect();
                if !aggregate_handle.has_active_listener() {
                    write_status(
                        &instance_dir,
                        &declaration.instance_id,
                        V3ManagedRunState::Stopping,
                        Some(format!(
                            "released final listener ports {}; managed foreground exiting",
                            format_u16_set(&released_set)
                        )),
                    )?;
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
                write_status(
                    &instance_dir,
                    &declaration.instance_id,
                    V3ManagedRunState::Running,
                    Some(format!(
                        "released listener ports {}",
                        format_u16_set(&released_set)
                    )),
                )?;
                continue;
            }
            if should_restart {
                let restart_plan = restart_plan.ok_or_else(|| {
                    V3LifecycleError::Validation(
                        "restart control request did not carry an executable plan".to_string(),
                    )
                })?;
                let handle = handle.take().ok_or_else(|| {
                    V3LifecycleError::Validation(
                        "managed runtime handle was already consumed".to_string(),
                    )
                })?;
                return restart_managed_runtime_in_place(
                    &instance_dir,
                    &socket_path,
                    handle,
                    restart_plan,
                    self.force_console,
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

async fn restart_managed_runtime_in_place(
    instance_dir: &Path,
    socket_path: &Path,
    handle: V3ServerAggregateHandle,
    restart_plan: ControlRestartPlan,
    console: bool,
) -> Result<(), V3LifecycleError> {
    let declaration = &restart_plan.declaration;
    write_status(
        instance_dir,
        &declaration.instance_id,
        V3ManagedRunState::Starting,
        Some("exec restart accepted".to_string()),
    )?;
    let _ = fs::remove_file(instance_dir.join(RESTART_PLAN_FILE));
    handle.shutdown().await;
    write_json_atomic(&instance_dir.join("instance.json"), declaration)?;
    let _ = fs::remove_file(instance_dir.join("control.json"));
    let _ = fs::remove_file(socket_path);
    let mut command = Command::new(&restart_plan.executable_path);
    command
        .arg("server")
        .arg("run-managed-child")
        .arg("--config")
        .arg(&declaration.config_path);
    if restart_plan.snapshots {
        command.arg("--snap");
    }
    if let Some(stages) = restart_plan.snapshot_stages.as_deref() {
        command.arg("--snap-stages").arg(stages);
    }
    if console {
        command.arg("--console");
    }
    let error = command.exec();
    let _ = write_status(
        instance_dir,
        &declaration.instance_id,
        V3ManagedRunState::Failed,
        Some(format!("exec restart failed: {error}")),
    );
    Err(V3LifecycleError::Io(error))
}

async fn send_control(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    operation: ControlOperation,
) -> Result<ControlResponse, V3LifecycleError> {
    send_control_with_ports(instance_dir, declaration, operation, None).await
}

async fn send_release_ports_control(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    ports: Vec<u16>,
) -> Result<ControlResponse, V3LifecycleError> {
    send_control_with_ports(
        instance_dir,
        declaration,
        ControlOperation::ReleasePorts,
        Some(ports),
    )
    .await
}

async fn send_control_with_ports(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    operation: ControlOperation,
    ports: Option<Vec<u16>>,
) -> Result<ControlResponse, V3LifecycleError> {
    tokio::time::timeout(
        CONTROL_TIMEOUT,
        send_control_without_timeout(instance_dir, declaration, operation, ports),
    )
    .await
    .map_err(|_| {
        V3LifecycleError::Timeout(format!("control challenge {}", declaration.instance_id))
    })?
}

async fn send_restart_control(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    snapshots: bool,
    snapshot_stages: Option<String>,
) -> Result<ControlResponse, V3LifecycleError> {
    let published: V3ManagedInstanceDeclaration = read_json(&instance_dir.join("instance.json"))?;
    let needs_restart_plan = published.executable_path != declaration.executable_path
        || snapshots
        || snapshot_stages
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty());
    let control: V3ManagedControlRecord = read_json(&instance_dir.join("control.json"))?;
    if needs_restart_plan {
        write_json_atomic(
            &instance_dir.join(RESTART_PLAN_FILE),
            &V3ManagedRestartPlanRecord {
                schema_version: SCHEMA_VERSION,
                instance_id: declaration.instance_id.clone(),
                start_nonce: control.start_nonce.clone(),
                executable_path: declaration.executable_path.clone(),
                snapshots,
                snapshot_stages,
            },
        )?;
    } else {
        let _ = fs::remove_file(instance_dir.join(RESTART_PLAN_FILE));
    }
    tokio::time::timeout(
        CONTROL_TIMEOUT,
        send_control_without_timeout(instance_dir, declaration, ControlOperation::Restart, None),
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
    ports: Option<Vec<u16>>,
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
        ports,
    };
    stream.write_all(&serde_json::to_vec(&request)?).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).await?;
    Ok(serde_json::from_str(&line)?)
}

fn instance_has_control_truth(instance_dir: &Path) -> bool {
    instance_dir.join("instance.json").exists()
        && instance_dir.join("pid.cache").exists()
        && instance_dir.join("control.json").exists()
}

fn find_live_previous_owner_for_restart(
    state_root: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<Option<(PathBuf, V3ManagedInstanceDeclaration)>, V3LifecycleError> {
    let candidates = find_previous_owner_candidates_for_restart(state_root, expected)?;
    match candidates.as_slice() {
        [] => Ok(None),
        [(instance_dir, declaration)] => Ok(Some((instance_dir.clone(), declaration.clone()))),
        _ => Err(V3LifecycleError::IdentityMismatch(format!(
            "multiple live previous managed owners match restart declaration {}",
            expected.instance_id
        ))),
    }
}

fn find_previous_owner_candidates_for_restart(
    state_root: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<Vec<(PathBuf, V3ManagedInstanceDeclaration)>, V3LifecycleError> {
    let instances_root = state_root.join("instances");
    if !instances_root.exists() {
        return Ok(Vec::new());
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(instances_root)? {
        let instance_dir = entry?.path();
        if !instance_dir.is_dir() {
            continue;
        }
        let declaration_path = instance_dir.join("instance.json");
        if !declaration_path.exists() {
            continue;
        }
        let Ok(published) = read_json::<V3ManagedInstanceDeclaration>(&declaration_path) else {
            continue;
        };
        if !previous_owner_matches_restart_declaration(&published, expected) {
            continue;
        }
        if !previous_owner_has_live_control_truth(&instance_dir, &published)? {
            continue;
        }
        candidates.push((instance_dir, published));
    }
    candidates.sort_by(|(_, left), (_, right)| left.instance_id.cmp(&right.instance_id));
    Ok(candidates)
}

fn previous_owner_matches_restart_declaration(
    published: &V3ManagedInstanceDeclaration,
    expected: &V3ManagedInstanceDeclaration,
) -> bool {
    published.instance_id != expected.instance_id
        && published.config_path == expected.config_path
        && listener_sets_overlap(&published.listeners, &expected.listeners)
}

fn previous_owner_has_live_control_truth(
    instance_dir: &Path,
    published: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    if !instance_has_control_truth(instance_dir) {
        return Ok(false);
    }
    let pid: V3ManagedPidCache = read_json(&instance_dir.join("pid.cache"))?;
    let control: V3ManagedControlRecord = read_json(&instance_dir.join("control.json"))?;
    if pid.instance_id != published.instance_id
        || control.instance_id != published.instance_id
        || pid.start_nonce != control.start_nonce
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "previous restart owner pid/control cache does not match declaration".to_string(),
        ));
    }
    if !pid_is_alive(pid.pid) {
        return Ok(false);
    }
    let socket_path = PathBuf::from(&control.socket_path);
    if socket_path != managed_control_socket_path(&published.instance_id) || !socket_path.exists() {
        return Ok(false);
    }
    let status_path = instance_dir.join("status.json");
    if status_path.exists() {
        let status: V3ManagedStatusRecord = read_json(&status_path)?;
        if status.instance_id != published.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "previous restart owner status does not match declaration".to_string(),
            ));
        }
        if matches!(
            status.state,
            V3ManagedRunState::Stopped | V3ManagedRunState::Failed
        ) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn adopt_exec_restart_declaration_change(
    state_root: &Path,
    current_instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    if current_instance_dir.join("instance.json").exists() {
        return Ok(false);
    }
    let candidates = find_exec_restart_adoption_candidates(state_root, expected)?;
    let (previous_instance_dir, previous_declaration) = match candidates.as_slice() {
        [] => return Ok(false),
        [(instance_dir, declaration)] => (instance_dir.clone(), declaration.clone()),
        _ => {
            return Err(V3LifecycleError::IdentityMismatch(format!(
                "multiple exec restart adoption candidates match declaration {}",
                expected.instance_id
            )))
        }
    };
    ensure_private_dir(current_instance_dir)?;
    write_json_atomic(&current_instance_dir.join("instance.json"), expected)?;
    write_status(
        current_instance_dir,
        &expected.instance_id,
        V3ManagedRunState::Starting,
        Some(format!(
            "exec restart adopted changed declaration from {}",
            previous_declaration.instance_id
        )),
    )?;
    cleanup_previous_exec_restart_owner(&previous_instance_dir, &previous_declaration, expected)?;
    Ok(true)
}

fn find_exec_restart_adoption_candidates(
    state_root: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<Vec<(PathBuf, V3ManagedInstanceDeclaration)>, V3LifecycleError> {
    let instances_root = state_root.join("instances");
    if !instances_root.exists() {
        return Ok(Vec::new());
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(instances_root)? {
        let instance_dir = entry?.path();
        if !instance_dir.is_dir() {
            continue;
        }
        let declaration_path = instance_dir.join("instance.json");
        if !declaration_path.exists() {
            continue;
        }
        let Ok(published) = read_json::<V3ManagedInstanceDeclaration>(&declaration_path) else {
            continue;
        };
        if !previous_owner_matches_restart_declaration(&published, expected) {
            continue;
        }
        if !exec_restart_adoption_candidate_matches_current_process(&instance_dir, &published)? {
            continue;
        }
        candidates.push((instance_dir, published));
    }
    candidates.sort_by(|(_, left), (_, right)| left.instance_id.cmp(&right.instance_id));
    Ok(candidates)
}

fn exec_restart_adoption_candidate_matches_current_process(
    instance_dir: &Path,
    published: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    let pid_path = instance_dir.join("pid.cache");
    if !pid_path.exists() {
        return Ok(false);
    }
    let pid: V3ManagedPidCache = read_json(&pid_path)?;
    if pid.instance_id != published.instance_id || pid.pid != std::process::id() {
        return Ok(false);
    }
    let status_path = instance_dir.join("status.json");
    if !status_path.exists() {
        return Ok(false);
    }
    let status: V3ManagedStatusRecord = read_json(&status_path)?;
    if status.instance_id != published.instance_id || status.state != V3ManagedRunState::Starting {
        return Ok(false);
    }
    let control_path = instance_dir.join("control.json");
    if control_path.exists() {
        let control: V3ManagedControlRecord = read_json(&control_path)?;
        if control.instance_id != published.instance_id || control.start_nonce != pid.start_nonce {
            return Err(V3LifecycleError::IdentityMismatch(
                "exec restart adoption candidate pid/control cache does not match".to_string(),
            ));
        }
        if Path::new(&control.socket_path)
            != managed_control_socket_path(&published.instance_id).as_path()
        {
            return Err(V3LifecycleError::IdentityMismatch(
                "exec restart adoption candidate has non-canonical control socket".to_string(),
            ));
        }
    }
    Ok(true)
}

fn cleanup_previous_exec_restart_owner(
    previous_instance_dir: &Path,
    previous: &V3ManagedInstanceDeclaration,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    let control_path = previous_instance_dir.join("control.json");
    if control_path.exists() {
        let control: V3ManagedControlRecord = read_json(&control_path)?;
        if control.instance_id != previous.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to cleanup previous restart owner control for a different instance"
                    .to_string(),
            ));
        }
        let socket_path = PathBuf::from(&control.socket_path);
        if socket_path != managed_control_socket_path(&previous.instance_id) {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to cleanup previous restart owner non-canonical socket".to_string(),
            ));
        }
        if socket_path.exists() {
            fs::remove_file(socket_path)?;
        }
        fs::remove_file(control_path)?;
    }
    for file in ["pid.cache", RESTART_PLAN_FILE] {
        let path = previous_instance_dir.join(file);
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    write_status(
        previous_instance_dir,
        &previous.instance_id,
        V3ManagedRunState::Stopped,
        Some(format!(
            "exec restart transferred managed ownership to {}",
            expected.instance_id
        )),
    )?;
    Ok(())
}

fn listener_sets_overlap(
    left: &[V3ManagedListenerDeclaration],
    right: &[V3ManagedListenerDeclaration],
) -> bool {
    let right_ports = right
        .iter()
        .map(|listener| listener.port)
        .collect::<BTreeSet<_>>();
    left.iter()
        .any(|listener| right_ports.contains(&listener.port))
}

fn control_restart_plan(
    instance_dir: &Path,
    request: &ControlRequest,
    current: &V3ManagedInstanceDeclaration,
) -> Result<Option<ControlRestartPlan>, String> {
    if request.operation != ControlOperation::Restart {
        return Ok(None);
    }
    let plan_path = instance_dir.join(RESTART_PLAN_FILE);
    let record = if plan_path.exists() {
        let record: V3ManagedRestartPlanRecord = read_json(&plan_path)
            .map_err(|error| format!("restart plan record is unreadable: {error}"))?;
        if record.schema_version != SCHEMA_VERSION
            || record.instance_id != request.instance_id
            || record.start_nonce != request.start_nonce
        {
            return Err("restart plan record does not match current control identity".to_string());
        }
        Some(record)
    } else {
        None
    };
    let executable_path = record
        .as_ref()
        .map(|record| record.executable_path.as_str())
        .unwrap_or(current.executable_path.as_str());
    let executable_path = fs::canonicalize(executable_path).map_err(|error| {
        format!("restart executable path is not a readable executable: {error}")
    })?;
    let mut declaration = current.clone();
    declaration.executable_path = executable_path.display().to_string();
    if !same_instance_declaration_except_executable_path(current, &declaration) {
        return Err(
            "restart executable request changed fields outside executable provenance".to_string(),
        );
    }
    let snapshot_stages = record
        .as_ref()
        .and_then(|record| record.snapshot_stages.as_ref())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let snapshots = record.as_ref().is_some_and(|record| record.snapshots);
    Ok(Some(ControlRestartPlan {
        declaration,
        executable_path,
        snapshots: snapshots || snapshot_stages.is_some(),
        snapshot_stages,
    }))
}

fn control_release_ports(
    request: &ControlRequest,
    current: &V3ManagedInstanceDeclaration,
) -> Result<Option<BTreeSet<u16>>, String> {
    if request.operation != ControlOperation::ReleasePorts {
        return Ok(None);
    }
    let ports = request
        .ports
        .as_ref()
        .ok_or_else(|| "release-ports control request is missing ports".to_string())?;
    if ports.is_empty() {
        return Err("release-ports control request has an empty port set".to_string());
    }
    let declared_ports = current
        .listeners
        .iter()
        .map(|listener| listener.port)
        .collect::<BTreeSet<_>>();
    let release_ports = ports.iter().copied().collect::<BTreeSet<_>>();
    let unknown_ports = release_ports
        .difference(&declared_ports)
        .copied()
        .collect::<BTreeSet<_>>();
    if !unknown_ports.is_empty() {
        return Err(format!(
            "release-ports control request referenced undeclared listener ports {}",
            format_u16_set(&unknown_ports)
        ));
    }
    Ok(Some(release_ports))
}

fn remove_restart_plan_for_previous_control_identity(
    instance_dir: &Path,
    start_nonce: &str,
) -> Result<(), V3LifecycleError> {
    let path = instance_dir.join(RESTART_PLAN_FILE);
    if !path.exists() {
        return Ok(());
    }
    let record: V3ManagedRestartPlanRecord = read_json(&path)?;
    if record.start_nonce != start_nonce {
        fs::remove_file(path)?;
    }
    Ok(())
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
    state_root: &Path,
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

    release_foreign_managed_listener_ports_for_start(
        state_root,
        &declaration.instance_id,
        &declaration.listeners,
        graceful_timeout,
    )
    .await?;
    if wait_for_listener_set_available(&declaration.listeners, graceful_timeout).await {
        return Ok(());
    }

    let occupied_ports = occupied_listener_ports(&declaration.listeners);
    let terminate_pids = explicit_listener_pids_for_ports(&occupied_ports)?;
    guard_explicit_listener_pids_are_scoped_to_target_ports(&terminate_pids, &occupied_ports)?;
    signal_explicit_listener_pids(&terminate_pids, V3LifecycleSignal::Terminate)?;
    if wait_for_listener_set_available(&declaration.listeners, graceful_timeout).await {
        return Ok(());
    }

    let occupied_ports = occupied_listener_ports(&declaration.listeners);
    let kill_pids = explicit_listener_pids_for_ports(&occupied_ports)?;
    guard_explicit_listener_pids_are_scoped_to_target_ports(&kill_pids, &occupied_ports)?;
    signal_explicit_listener_pids(&kill_pids, V3LifecycleSignal::Kill)?;
    if wait_for_listener_set_available(&declaration.listeners, force_timeout).await {
        return Ok(());
    }

    let occupied_ports = occupied_listener_ports(&declaration.listeners);
    let remaining = explicit_listener_pids_for_ports(&occupied_ports)?;
    Err(V3LifecycleError::Timeout(format!(
        "free managed listener set for start {} remaining_pids={}",
        declaration.instance_id,
        format_pid_list(&remaining)
    )))
}

async fn release_foreign_managed_listener_ports_for_start(
    state_root: &Path,
    current_instance_id: &str,
    listeners: &[V3ManagedListenerDeclaration],
    timeout: Duration,
) -> Result<(), V3LifecycleError> {
    let target_ports = occupied_listener_ports(listeners);
    if target_ports.is_empty() {
        return Ok(());
    }
    let instances_root = state_root.join("instances");
    if !instances_root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&instances_root)? {
        let path = entry?.path();
        if !path.is_dir() {
            continue;
        }
        let declaration_path = path.join("instance.json");
        if !declaration_path.exists() {
            continue;
        }
        let Ok(published) = read_json::<V3ManagedInstanceDeclaration>(&declaration_path) else {
            continue;
        };
        if published.instance_id == current_instance_id {
            continue;
        }
        let release_ports = published
            .listeners
            .iter()
            .map(|listener| listener.port)
            .filter(|port| target_ports.contains(port))
            .collect::<BTreeSet<_>>();
        if release_ports.is_empty() {
            continue;
        }
        let response = send_release_ports_control(
            &path,
            &published,
            release_ports.iter().copied().collect::<Vec<_>>(),
        )
        .await;
        if response.as_ref().is_ok_and(|response| response.accepted)
            && wait_for_listener_set_available(listeners, timeout).await
        {
            return Ok(());
        }
    }
    Ok(())
}

fn listener_set_is_available(listeners: &[V3ManagedListenerDeclaration]) -> bool {
    listeners
        .iter()
        .all(|listener| listener_address_is_available(&listener.bind, listener.port))
}

fn occupied_listener_ports(listeners: &[V3ManagedListenerDeclaration]) -> BTreeSet<u16> {
    listeners
        .iter()
        .filter(|listener| !listener_address_is_available(&listener.bind, listener.port))
        .map(|listener| listener.port)
        .collect()
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

fn explicit_listener_pids_for_ports(ports: &BTreeSet<u16>) -> Result<Vec<u32>, V3LifecycleError> {
    let mut pids = BTreeSet::new();
    for port in ports {
        for pid in listening_pids_for_port(*port)? {
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

fn guard_explicit_listener_pids_are_scoped_to_target_ports(
    pids: &[u32],
    target_ports: &BTreeSet<u16>,
) -> Result<(), V3LifecycleError> {
    for pid in pids {
        let listening_ports = listening_ports_for_pid(*pid)?;
        let extra_ports = listening_ports
            .difference(target_ports)
            .copied()
            .collect::<BTreeSet<_>>();
        if !extra_ports.is_empty() {
            return Err(V3LifecycleError::Validation(format!(
                "refusing to signal listener PID {pid} because it also owns non-target listener ports {}; target_ports={}",
                format_u16_set(&extra_ports),
                format_u16_set(target_ports)
            )));
        }
    }
    Ok(())
}

fn listening_ports_for_pid(pid: u32) -> Result<BTreeSet<u16>, V3LifecycleError> {
    let pid_arg = pid.to_string();
    let output = Command::new("lsof")
        .args(["-nP", "-a", "-p", &pid_arg, "-iTCP", "-sTCP:LISTEN", "-Fn"])
        .output()
        .map_err(|error| {
            V3LifecycleError::Validation(format!(
                "failed to discover listener ports for PID {pid}: {error}"
            ))
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() && stdout.trim().is_empty() {
        return Ok(BTreeSet::new());
    }
    if !output.status.success() {
        return Err(V3LifecycleError::Validation(format!(
            "failed to discover listener ports for PID {pid}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let mut ports = BTreeSet::new();
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('n'))
    {
        let Some(port) = line
            .rsplit(':')
            .next()
            .and_then(|candidate| candidate.parse::<u16>().ok())
        else {
            continue;
        };
        ports.insert(port);
    }
    Ok(ports)
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

fn format_u16_set(values: &BTreeSet<u16>) -> String {
    if values.is_empty() {
        return "none".to_string();
    }
    values
        .iter()
        .map(u16::to_string)
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

fn restart_recovery_state_is_stale_owned_unreachable(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    let status_path = instance_dir.join("status.json");
    if !status_path.exists() {
        return Ok(false);
    }
    let status: V3ManagedStatusRecord = read_json(&status_path)?;
    if status.instance_id != expected.instance_id {
        return Err(V3LifecycleError::IdentityMismatch(
            "refusing restart recovery for a different instance status".to_string(),
        ));
    }
    if matches!(
        status.state,
        V3ManagedRunState::Stopped | V3ManagedRunState::Failed
    ) {
        return Ok(false);
    }
    owned_unreachable_runtime_state_is_reapable(instance_dir, expected)
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
        fixture_with_port(root, 45499)
    }

    fn fixture_with_port(root: &TempDir, port: u16) -> (PathBuf, PathBuf, PathBuf) {
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
                port
            ),
        )
        .unwrap();
        (config, executable, state)
    }

    fn managed_test_declaration(
        instance_id: &str,
        config_path: &Path,
        config_digest: &str,
        executable_path: &str,
        port: u16,
    ) -> V3ManagedInstanceDeclaration {
        V3ManagedInstanceDeclaration {
            schema_version: SCHEMA_VERSION,
            instance_id: instance_id.to_string(),
            config_path: config_path.display().to_string(),
            config_digest: config_digest.to_string(),
            executable_path: executable_path.to_string(),
            listeners: vec![V3ManagedListenerDeclaration {
                server_id: "responses_v3_5555".to_string(),
                bind: "0.0.0.0".to_string(),
                port,
            }],
        }
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
    fn restart_control_operation_is_explicit_protocol() {
        let request = ControlRequest {
            schema_version: SCHEMA_VERSION,
            instance_id: "v3-test".to_string(),
            start_nonce: "nonce".to_string(),
            operation: ControlOperation::Restart,
            ports: None,
        };
        let plan = V3ManagedRestartPlanRecord {
            schema_version: SCHEMA_VERSION,
            instance_id: "v3-test".to_string(),
            start_nonce: "nonce".to_string(),
            executable_path: "/tmp/rccv3-next".to_string(),
            snapshots: true,
            snapshot_stages: Some("provider-request".to_string()),
        };

        let rendered = serde_json::to_string(&request).unwrap();
        let rendered_plan = serde_json::to_string(&plan).unwrap();

        assert!(rendered.contains("\"operation\":\"restart\""));
        assert!(!rendered.contains("/tmp/rccv3-next"));
        assert!(rendered_plan.contains("\"executable_path\":\"/tmp/rccv3-next\""));
        assert!(rendered_plan.contains("\"snapshots\":true"));
        assert!(rendered_plan.contains("\"snapshot_stages\":\"provider-request\""));
    }

    #[test]
    fn managed_child_reentry_removes_restart_plan_from_previous_control_identity() {
        let root = TempDir::new().unwrap();
        let instance_dir = root.path().join("instance");
        ensure_private_dir(&instance_dir).unwrap();
        write_json_atomic(
            &instance_dir.join(RESTART_PLAN_FILE),
            &V3ManagedRestartPlanRecord {
                schema_version: SCHEMA_VERSION,
                instance_id: "v3-test".to_string(),
                start_nonce: "previous-nonce".to_string(),
                executable_path: "/tmp/rccv3-next".to_string(),
                snapshots: true,
                snapshot_stages: None,
            },
        )
        .unwrap();

        remove_restart_plan_for_previous_control_identity(&instance_dir, "fresh-nonce").unwrap();

        assert!(
            !instance_dir.join(RESTART_PLAN_FILE).exists(),
            "a successfully re-entered managed child must not retain the consumed restart plan"
        );
    }

    #[test]
    fn restart_without_current_instance_state_fails_without_bootstrap() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
        let root = TempDir::new().unwrap();
        let port_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = port_listener.local_addr().unwrap().port();
        drop(port_listener);
        let (config, executable, state) = fixture_with_port(&root, port);
        let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
        let (declaration, _) = lifecycle.declaration(&executable).unwrap();
        let instance_dir = state.join("instances").join(&declaration.instance_id);

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let error = runtime
            .block_on(lifecycle.restart(&executable, Duration::from_millis(1)))
            .unwrap_err();

        assert!(
            matches!(&error, V3LifecycleError::NotRunning(instance_id) if instance_id == &declaration.instance_id),
            "restart without live managed truth must fail explicitly instead of bootstrapping a detached runtime, got {error}"
        );
        assert!(
            !instance_dir.join("instance.json").exists(),
            "restart without live managed truth must not publish instance state"
        );
        assert!(
            !instance_dir.join("status.json").exists(),
            "restart without live managed truth must not publish startup status"
        );
    }

    #[test]
    fn restart_discovers_live_previous_owner_when_config_digest_changed() {
        let root = TempDir::new().unwrap();
        let state = root.path().join("state");
        let config_path = root.path().join("config.v3.toml");
        let old = managed_test_declaration(
            "v3-previous-digest-owner",
            &config_path,
            "old-digest",
            "/tmp/old-rccv3",
            45551,
        );
        let expected = managed_test_declaration(
            "v3-current-digest-owner",
            &config_path,
            "new-digest",
            "/tmp/new-rccv3",
            45551,
        );
        let old_dir = state.join("instances").join(&old.instance_id);
        ensure_private_dir(&old_dir).unwrap();
        write_json_atomic(&old_dir.join("instance.json"), &old).unwrap();
        write_status(&old_dir, &old.instance_id, V3ManagedRunState::Running, None).unwrap();
        let socket_path = managed_control_socket_path(&old.instance_id);
        fs::write(&socket_path, b"live previous owner socket marker").unwrap();
        write_json_atomic(
            &old_dir.join("pid.cache"),
            &V3ManagedPidCache {
                schema_version: SCHEMA_VERSION,
                instance_id: old.instance_id.clone(),
                pid: std::process::id(),
                start_nonce: "previous-owner".to_string(),
                started_at_epoch_ms: 1,
            },
        )
        .unwrap();
        write_json_atomic(
            &old_dir.join("control.json"),
            &V3ManagedControlRecord {
                schema_version: SCHEMA_VERSION,
                instance_id: old.instance_id.clone(),
                socket_path: socket_path.display().to_string(),
                start_nonce: "previous-owner".to_string(),
            },
        )
        .unwrap();

        let owner = find_live_previous_owner_for_restart(&state, &expected)
            .unwrap()
            .expect("changed-digest restart must find the previous live owner");

        assert_eq!(owner.1.instance_id, old.instance_id);
        let _ = fs::remove_file(socket_path);
    }

    #[test]
    fn exec_restart_reentry_adopts_changed_declaration_from_previous_owner() {
        let root = TempDir::new().unwrap();
        let state = root.path().join("state");
        let config_path = root.path().join("config.v3.toml");
        let old = managed_test_declaration(
            "v3-previous-exec-owner",
            &config_path,
            "old-digest",
            "/tmp/old-rccv3",
            45552,
        );
        let expected = managed_test_declaration(
            "v3-current-exec-owner",
            &config_path,
            "new-digest",
            "/tmp/new-rccv3",
            45552,
        );
        let old_dir = state.join("instances").join(&old.instance_id);
        let expected_dir = state.join("instances").join(&expected.instance_id);
        ensure_private_dir(&old_dir).unwrap();
        write_json_atomic(&old_dir.join("instance.json"), &old).unwrap();
        write_status(
            &old_dir,
            &old.instance_id,
            V3ManagedRunState::Starting,
            Some("exec restart accepted".to_string()),
        )
        .unwrap();
        write_json_atomic(
            &old_dir.join("pid.cache"),
            &V3ManagedPidCache {
                schema_version: SCHEMA_VERSION,
                instance_id: old.instance_id.clone(),
                pid: std::process::id(),
                start_nonce: "previous-exec-owner".to_string(),
                started_at_epoch_ms: 1,
            },
        )
        .unwrap();

        assert!(
            adopt_exec_restart_declaration_change(&state, &expected_dir, &expected).unwrap(),
            "exec-reentered child must adopt the current declaration"
        );

        let adopted: V3ManagedInstanceDeclaration =
            read_json(&expected_dir.join("instance.json")).unwrap();
        let adopted_status: V3ManagedStatusRecord =
            read_json(&expected_dir.join("status.json")).unwrap();
        let old_status: V3ManagedStatusRecord = read_json(&old_dir.join("status.json")).unwrap();
        assert_eq!(adopted, expected);
        assert_eq!(adopted_status.state, V3ManagedRunState::Starting);
        assert_eq!(old_status.state, V3ManagedRunState::Stopped);
        assert!(!old_dir.join("pid.cache").exists());
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
