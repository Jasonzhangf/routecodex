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

mod control_plane;
use control_plane::*;
mod exec_restart;
use exec_restart::*;
mod fs_locks;
use fs_locks::*;
mod pid_scan;
use pid_scan::*;
mod reap;
use reap::*;

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
    #[error("NotRunning: managed instance is not running: {0}")]
    NotRunning(String),
    #[error("IdentityMismatch: managed instance identity mismatch: {0}")]
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3ManagedLifecycleObservation {
    RestartTargetResolved {
        instance_id: String,
        control_instance_id: String,
        listeners: Vec<V3ManagedListenerDeclaration>,
    },
    RestartControlAccepted {
        instance_id: String,
        state: V3ManagedRunState,
        message: String,
    },
    RestartStatusObserved {
        status: V3ManagedStatusRecord,
    },
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
    #[serde(default, skip_serializing_if = "bool_is_false")]
    snapshot_direct: bool,
    snapshot_stages: Option<String>,
}

fn bool_is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone)]
struct ControlRestartPlan {
    declaration: V3ManagedInstanceDeclaration,
    executable_path: PathBuf,
    snapshots: bool,
    snapshot_direct: bool,
    snapshot_stages: Option<String>,
}

#[derive(Debug, Clone)]
pub struct V3ManagedLifecycle {
    config_path: PathBuf,
    state_root: PathBuf,
    force_snapshots: bool,
    force_snapshot_direct: bool,
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
                    .join("runtime-lifecycle")
                    .join("v3")
            }
        };
        Ok(Self {
            config_path: config_path.into(),
            state_root,
            force_snapshots: false,
            force_snapshot_direct: false,
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
            force_snapshot_direct: false,
            force_snapshot_stages: None,
            force_console: false,
        }
    }

    pub fn with_snapshots_enabled(mut self, enabled: bool) -> Self {
        self.force_snapshots = enabled;
        self
    }

    pub fn with_direct_snapshots_enabled(mut self, enabled: bool) -> Self {
        self.force_snapshot_direct = enabled;
        if enabled {
            self.force_snapshots = true;
        }
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
        self.apply_snapshot_authorization_to_manifest(&mut manifest);
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
        if (self.force_console || self.force_snapshots || self.force_snapshot_stages.is_some())
            && manifest.debug.log_file.is_none()
        {
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

    fn apply_snapshot_authorization_to_manifest(&self, manifest: &mut V3Config05ManifestPublished) {
        // Codex samples are a lifecycle opt-in. Configured debug snapshots remain
        // available for diagnostics, but sample persistence requires an explicit
        // lifecycle snapshot flag.
        if !self.force_snapshots
            && !self.force_snapshot_direct
            && self.force_snapshot_stages.is_none()
        {
            manifest.debug.codex_samples = false;
        }
        if self.force_snapshots {
            manifest.debug.codex_samples = true;
            manifest.debug.snapshots = true;
            manifest.debug.snapshot_direct = false;
            // 显式 --snap：全量样本（成功+错误），关闭 internal 默认只落错误样本。
            manifest.debug.full_codex_sampling = true;
        }
        if self.force_snapshot_direct {
            manifest.debug.snapshot_direct = true;
        }
        if let Some(stages) = self.force_snapshot_stages.as_ref() {
            manifest.debug.snapshots = true;
            manifest.debug.codex_samples = true;
            manifest.debug.snapshot_stages = Some(stages.clone());
            // 显式 --snap-stages：全量样本，关闭只落错误样本模式。
            manifest.debug.full_codex_sampling = true;
        }
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
        let mut command = Command::new(executable_path);
        command
            .arg("server")
            .arg("run-managed-child")
            .arg("--config")
            .arg(&declaration.config_path);
        if self.force_snapshot_direct {
            command.arg("--snapall");
        } else if self.force_snapshots {
            command.arg("--snap");
        }
        if let Some(stages) = self.force_snapshot_stages.as_ref() {
            command.arg("--snap-stages").arg(stages);
        }
        if self.force_console {
            command.arg("--console");
        }
        let log_path = instance_dir.join("server.log");
        let stdout = private_log_file(&log_path)?;
        let stderr = stdout.try_clone()?;
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
                Ok(V3ManagedStatusRecord {
                    schema_version: SCHEMA_VERSION,
                    instance_id: declaration.instance_id,
                    state: V3ManagedRunState::Stopped,
                    updated_at_epoch_ms: epoch_ms(),
                    detail: Some(format!("no managed runtime state; query_live failed: {error}")),
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
        ensure_private_dir(&instance_dir)?;
        let _lock = acquire_operation_lock(&instance_dir, "stop")?;
        let response = match send_control(&instance_dir, &declaration, ControlOperation::Stop).await
        {
            Ok(response) => response,
            Err(error @ (V3LifecycleError::NotRunning(_) | V3LifecycleError::Timeout(_))) => {
                if listener_set_is_available(&declaration.listeners) {
                    return Err(error);
                }
                return self
                    .force_stop_after_graceful_timeout(&instance_dir, &declaration)
                    .await;
            }
            Err(error) => return Err(error),
        };
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
                return self
                    .force_stop_after_graceful_timeout(&instance_dir, &declaration)
                    .await;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn force_stop_after_graceful_timeout(
        &self,
        instance_dir: &Path,
        declaration: &V3ManagedInstanceDeclaration,
    ) -> Result<V3ManagedStatusRecord, V3LifecycleError> {
        let force_timeout = env_duration_ms(
            &[
                "ROUTECODEX_V3_KILL_TIMEOUT_MS",
                "RCC_V3_KILL_TIMEOUT_MS",
                "ROUTECODEX_KILL_TIMEOUT_MS",
            ],
            DEFAULT_START_FORCE_KILL_TIMEOUT,
        );
        write_status(
            instance_dir,
            &declaration.instance_id,
            V3ManagedRunState::Stopping,
            Some("graceful stop timed out; forcing scoped listener shutdown".to_string()),
        )?;
        force_release_scoped_listener_set_after_graceful_timeout(
            &declaration.listeners,
            force_timeout,
        )
        .await?;
        cleanup_forced_stopped_runtime_state(instance_dir, declaration)?;
        write_status(
            instance_dir,
            &declaration.instance_id,
            V3ManagedRunState::Stopped,
            Some("forced scoped listener shutdown after graceful stop timeout".to_string()),
        )?;
        Ok(V3ManagedStatusRecord {
            schema_version: SCHEMA_VERSION,
            instance_id: declaration.instance_id.clone(),
            state: V3ManagedRunState::Stopped,
            updated_at_epoch_ms: epoch_ms(),
            detail: Some("forced scoped listener shutdown after graceful stop timeout".to_string()),
        })
    }

    pub async fn restart(
        &self,
        executable_path: impl AsRef<Path> + Clone,
        timeout: Duration,
    ) -> Result<V3ManagedStatusRecord, V3LifecycleError> {
        self.restart_with_observer(executable_path, timeout, |_| {})
            .await
    }

    pub async fn restart_with_observer<F>(
        &self,
        executable_path: impl AsRef<Path> + Clone,
        timeout: Duration,
        mut observe: F,
    ) -> Result<V3ManagedStatusRecord, V3LifecycleError>
    where
        F: FnMut(V3ManagedLifecycleObservation),
    {
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
        observe(V3ManagedLifecycleObservation::RestartTargetResolved {
            instance_id: declaration.instance_id.clone(),
            control_instance_id: control_declaration.instance_id.clone(),
            listeners: declaration.listeners.clone(),
        });
        let previous_start_nonce = read_pid_cache_start_nonce(&control_instance_dir)?;
        let response = match send_restart_control(
            &control_instance_dir,
            &control_declaration,
            self.force_snapshots,
            self.force_snapshot_direct,
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
                observe(V3ManagedLifecycleObservation::RestartStatusObserved {
                    status: V3ManagedStatusRecord {
                        schema_version: SCHEMA_VERSION,
                        instance_id: declaration.instance_id.clone(),
                        state: V3ManagedRunState::Starting,
                        updated_at_epoch_ms: epoch_ms(),
                        detail: Some("restart recovered stale owned runtime".to_string()),
                    },
                });
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
        observe(V3ManagedLifecycleObservation::RestartControlAccepted {
            instance_id: response.instance_id.clone(),
            state: response.state.clone(),
            message: response.message.clone(),
        });
        let mut last_observed_status = None;
        observe_status_if_changed(
            &mut observe,
            &mut last_observed_status,
            &V3ManagedStatusRecord {
                schema_version: SCHEMA_VERSION,
                instance_id: response.instance_id.clone(),
                state: response.state,
                updated_at_epoch_ms: epoch_ms(),
                detail: Some("control accepted".to_string()),
            },
        );
        let deadline = tokio::time::Instant::now() + timeout;
        let mut restart_transition_observed = false;
        loop {
            let status_path = instance_dir.join("status.json");
            if status_path.exists() {
                let status: V3ManagedStatusRecord = read_json(&status_path)?;
                if status.state != V3ManagedRunState::Running {
                    restart_transition_observed = true;
                    observe_status_if_changed(&mut observe, &mut last_observed_status, &status);
                }
                if status.state == V3ManagedRunState::Failed {
                    return Err(V3LifecycleError::Validation(status.detail.unwrap_or_else(
                        || "managed child failed during restart".to_string(),
                    )));
                }
            }
            if let Ok(status) = self.query_live(&declaration).await {
                if status.state == V3ManagedRunState::Running {
                    let nonce_changed = pid_cache_start_nonce_changed(
                        &instance_dir,
                        previous_start_nonce.as_deref(),
                    )?;
                    if restart_transition_observed || nonce_changed {
                        observe_status_if_changed(&mut observe, &mut last_observed_status, &status);
                        return Ok(status);
                    }
                } else {
                    restart_transition_observed = true;
                    observe_status_if_changed(&mut observe, &mut last_observed_status, &status);
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
        #[cfg(unix)]
        let mut interrupt_signal =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
        #[cfg(unix)]
        let mut terminate_signal =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        #[cfg(not(unix))]
        let mut ctrl_c = Box::pin(tokio::signal::ctrl_c());
        loop {
            #[cfg(unix)]
            let accepted = tokio::select! {
                _ = interrupt_signal.recv() => {
                    let handle = handle.take().ok_or_else(|| {
                        V3LifecycleError::Validation("managed runtime handle was already consumed".to_string())
                    })?;
                    return shutdown_managed_runtime(&instance_dir, &declaration.instance_id, &socket_path, handle).await;
                }
                _ = terminate_signal.recv() => {
                    let handle = handle.take().ok_or_else(|| {
                        V3LifecycleError::Validation("managed runtime handle was already consumed".to_string())
                    })?;
                    return shutdown_managed_runtime(&instance_dir, &declaration.instance_id, &socket_path, handle).await;
                }
                accepted = listener.accept() => accepted?,
            };
            #[cfg(not(unix))]
            let accepted = tokio::select! {
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
            let (mut stream, _) = accepted;
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
    let snapshot_direct = record.as_ref().is_some_and(|record| record.snapshot_direct);
    Ok(Some(ControlRestartPlan {
        declaration,
        executable_path,
        snapshots: snapshots || snapshot_stages.is_some(),
        snapshot_direct,
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

async fn force_release_scoped_listener_set_after_graceful_timeout(
    listeners: &[V3ManagedListenerDeclaration],
    timeout: Duration,
) -> Result<(), V3LifecycleError> {
    let occupied_ports = occupied_listener_ports(listeners);
    let terminate_pids = explicit_listener_pids_for_ports(&occupied_ports)?;
    guard_explicit_listener_pids_are_scoped_to_target_ports(&terminate_pids, &occupied_ports)?;
    signal_explicit_listener_pids(&terminate_pids, V3LifecycleSignal::Terminate)?;
    if wait_for_listener_set_available(listeners, timeout).await {
        return Ok(());
    }

    let occupied_ports = occupied_listener_ports(listeners);
    let kill_pids = explicit_listener_pids_for_ports(&occupied_ports)?;
    guard_explicit_listener_pids_are_scoped_to_target_ports(&kill_pids, &occupied_ports)?;
    signal_explicit_listener_pids(&kill_pids, V3LifecycleSignal::Kill)?;
    if wait_for_listener_set_available(listeners, timeout).await {
        return Ok(());
    }

    let occupied_ports = occupied_listener_ports(listeners);
    let remaining = explicit_listener_pids_for_ports(&occupied_ports)?;
    Err(V3LifecycleError::Timeout(format!(
        "force stop listener set remaining_pids={}",
        format_pid_list(&remaining)
    )))
}

fn cleanup_forced_stopped_runtime_state(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    let control_path = instance_dir.join("control.json");
    if control_path.exists() {
        let control: V3ManagedControlRecord = read_json(&control_path)?;
        if control.instance_id != declaration.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to cleanup forced-stop control for a different instance".to_string(),
            ));
        }
        let socket_path = PathBuf::from(&control.socket_path);
        if socket_path != managed_control_socket_path(&declaration.instance_id) {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to cleanup non-canonical forced-stop control socket".to_string(),
            ));
        }
        let _ = fs::remove_file(socket_path);
        fs::remove_file(control_path)?;
    }
    let pid_path = instance_dir.join("pid.cache");
    if pid_path.exists() {
        let pid: V3ManagedPidCache = read_json(&pid_path)?;
        if pid.instance_id != declaration.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to cleanup forced-stop pid cache for a different instance".to_string(),
            ));
        }
        fs::remove_file(pid_path)?;
    }
    Ok(())
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



#[cfg(test)]
mod tests;
