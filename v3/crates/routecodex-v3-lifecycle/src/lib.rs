#![cfg_attr(test, allow(unused_variables, clippy::zombie_processes))]

use routecodex_v3_config::{
    load_v3_config_snapshot_from_path, V3AdminWebuiManifest, V3Config05ManifestPublished,
};
use routecodex_v3_server::{
    spawn_v3_server_aggregate_for_managed_startup, V3ActiveKeyControlExecHandoff,
    V3ServerAggregateHandle,
};
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

mod active_key_startup;
use active_key_startup::*;
mod control_plane;
use control_plane::*;
mod exec_restart;
use exec_restart::*;
mod foreground;
use foreground::*;
mod fs_locks;
use fs_locks::*;
mod pid_scan;
use pid_scan::*;
mod reap;
use reap::*;
mod hooks_sidecar;
use hooks_sidecar::*;
mod restart_plan;
use restart_plan::*;

const SCHEMA_VERSION: u16 = 1;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
const START_TAKEOVER_POLL: Duration = Duration::from_millis(150);
const DEFAULT_START_GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_START_FORCE_KILL_TIMEOUT: Duration = Duration::from_secs(3);
const RESTART_PLAN_FILE: &str = "restart.plan.json";
const FRONT_HANDOFF_FILE: &str = "front-handoff.json";
const PROVIDER_HANDOFF_FILE: &str = "provider-handoff.json";

#[derive(Debug, Error)]
pub enum V3LifecycleError {
    #[error("{source}; signals already delivered: {delivered}")]
    PartialSignal {
        #[source]
        source: Box<V3LifecycleError>,
        delivered: String,
    },
    #[error("managed lifecycle validation failed: {0}")]
    Validation(String),
    #[error("managed lifecycle IO failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    ActiveKeyControlCleanup(#[source] routecodex_v3_server::V3ActiveKeyControlCleanupFailure),
    #[error("managed lifecycle config failed: {0}")]
    Config(#[from] routecodex_v3_config::V3ConfigError),
    #[error("managed hooks control validation failed: {0}")]
    HooksControlValidation(String),
    #[error("managed hooks sidecar startup cancelled")]
    HooksSidecarStartCancelled,
    #[error("{0}")]
    HooksOptionalUnavailable(String),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_control: Option<V3RetainedControlGeneration>,
    pub schema_version: u16,
    pub instance_id: String,
    pub pid: u32,
    pub start_nonce: String,
    pub started_at_epoch_ms: u64,
    #[serde(default)]
    pub process_start_token: Option<String>,
}

/// Native exec preserves PID and process-start token. This link distinguishes
/// the predecessor nonce from the current nonce in the same PID cache.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3RetainedControlGeneration {
    target: V3ManagedInstanceDeclaration,
    instance_id: String,
    start_nonce: String,
    started_at_epoch_ms: u64,
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
    RestartPhase {
        phase: &'static str,
        elapsed: Duration,
    },
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target_declaration: Option<V3ManagedInstanceDeclaration>,
    snapshots: bool,
    #[serde(default, skip_serializing_if = "bool_is_false")]
    snapshot_direct: bool,
    snapshot_stages: Option<String>,
    #[serde(default, skip_serializing_if = "bool_is_false")]
    sse_dump: bool,
}

fn bool_is_false(value: &bool) -> bool {
    !*value
}

fn apply_v3_runtime_fd_limit(configured: Option<u64>) -> Result<(), V3LifecycleError> {
    let Some(limit) = configured else {
        return Ok(());
    };
    if limit == 0 {
        return Err(V3LifecycleError::Validation(
            "runtime fd_limit must be non-zero".to_string(),
        ));
    }
    let mut current = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, current.as_mut_ptr()) } != 0 {
        return Err(V3LifecycleError::Io(std::io::Error::last_os_error()));
    }
    let current = unsafe { current.assume_init() };
    let hard = current.rlim_max;
    let target = if hard == libc::RLIM_INFINITY {
        limit as libc::rlim_t
    } else {
        limit.min(hard as u64) as libc::rlim_t
    };
    if current.rlim_cur == target {
        return Ok(());
    }
    let next = libc::rlimit {
        rlim_cur: target,
        rlim_max: hard,
    };
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &next) } != 0 {
        return Err(V3LifecycleError::Io(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct ControlRestartPlan {
    control_instance_id: String,
    control_start_nonce: String,
    declaration: V3ManagedInstanceDeclaration,
    executable_path: PathBuf,
    snapshots: bool,
    snapshot_direct: bool,
    snapshot_stages: Option<String>,
    sse_dump: bool,
}

const EXEC_RESTART_OWNER_ENV: &str = "ROUTECODEX_V3_EXEC_RESTART_OWNER";
const EXEC_RESTART_DECLARATION_FILE: &str = "exec-restart-declaration.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecRestartOwner {
    instance_id: String,
    start_nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_key_controls: Option<V3ActiveKeyControlExecHandoff>,
}

#[derive(Debug, Clone)]
pub struct V3ManagedLifecycle {
    config_path: PathBuf,
    state_root: PathBuf,
    force_snapshots: bool,
    force_snapshot_direct: bool,
    force_snapshot_stages: Option<String>,
    force_console: bool,
    force_sse_dump: bool,
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
            force_sse_dump: false,
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
            force_sse_dump: false,
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

    pub fn with_sse_dump_enabled(mut self, enabled: bool) -> Self {
        self.force_sse_dump = enabled;
        self
    }

    pub fn declaration(
        &self,
        executable_path: impl AsRef<Path>,
    ) -> Result<(V3ManagedInstanceDeclaration, V3Config05ManifestPublished), V3LifecycleError> {
        let (declaration, manifest, _) = self.declaration_with_runtime(executable_path)?;
        Ok((declaration, manifest))
    }

    fn declaration_with_runtime(
        &self,
        executable_path: impl AsRef<Path>,
    ) -> Result<
        (
            V3ManagedInstanceDeclaration,
            V3Config05ManifestPublished,
            Option<u64>,
        ),
        V3LifecycleError,
    > {
        let snapshot = load_v3_config_snapshot_from_path(&self.config_path)?;
        let runtime_fd_limit = snapshot.runtime.fd_limit;
        let config_path = snapshot.canonical_path;
        let admin_webui = snapshot.admin_webui;
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
        let mut listeners = listeners;
        if let Some(admin) = admin_webui.as_ref().filter(|admin| admin.enabled) {
            listeners.push(V3ManagedListenerDeclaration {
                server_id: "admin_webui".to_string(),
                bind: admin.bind.clone(),
                port: admin.port,
            });
        }
        if !listeners.iter().any(is_business_listener_declaration) {
            return Err(V3LifecycleError::Validation(
                "managed instance has no enabled business listeners".to_string(),
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
            runtime_fd_limit,
        ))
    }

    fn apply_snapshot_authorization_to_manifest(&self, manifest: &mut V3Config05ManifestPublished) {
        // Preserve explicit config authorization; absent authorization already
        // compiles to false. Explicit lifecycle flags may still opt in below.
        if self.force_snapshots {
            manifest.debug.codex_samples = true;
            manifest.debug.snapshots = true;
            manifest.debug.snapshot_direct = true;
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
        retire_abandoned_previous_release_transfer(&instance_dir, &declaration).await?;
        release_listener_set_for_start(&self.state_root, &instance_dir, &declaration).await?;
        wait_for_stopping_instance(&instance_dir, &declaration, timeout).await?;
        recover_exited_front_control_handoff(&instance_dir, &declaration).await?;
        reap_inactive_runtime_files(&instance_dir, &declaration)?;
        self.launch_managed_child(executable_path.as_ref(), &declaration, timeout)
            .await
    }

    fn prepare_fresh_launch(
        instance_dir: &Path,
        declaration: &V3ManagedInstanceDeclaration,
    ) -> Result<(), V3LifecycleError> {
        write_json_atomic(&instance_dir.join("instance.json"), declaration)?;
        write_status(
            instance_dir,
            &declaration.instance_id,
            V3ManagedRunState::Stopped,
            None,
        )
    }

    async fn launch_managed_child(
        &self,
        executable_path: &Path,
        declaration: &V3ManagedInstanceDeclaration,
        timeout: Duration,
    ) -> Result<V3ManagedStatusRecord, V3LifecycleError> {
        let instance_dir = self.instance_dir(&declaration.instance_id);
        Self::prepare_fresh_launch(&instance_dir, declaration)?;
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
        if self.force_sse_dump {
            command.arg("--sse-dump");
        }
        let log_path = instance_dir.join("server.log");
        let stdout = private_log_file(&log_path)?;
        let stderr = stdout.try_clone()?;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .process_group(0);
        let mut child = command.spawn()?;
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
            let exit = child.try_wait()?;
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
            if let Some(exit) = exit {
                return Err(V3LifecycleError::Validation(format!(
                    "managed child {} exited before readiness: {exit}",
                    child.id()
                )));
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
            retire_abandoned_previous_release_transfer(&instance_dir, &declaration).await?;
        }
        if let Ok(status) = self.query_live(&declaration).await {
            if matches!(
                status.state,
                V3ManagedRunState::Starting | V3ManagedRunState::Running
            ) {
                self.stop(executable_path.as_ref(), Duration::from_secs(15))
                    .await?;
            }
        }
        {
            let _lock = match acquire_operation_lock(&instance_dir, "start") {
                Ok(lock) => lock,
                Err(error @ V3LifecycleError::OperationLocked(_)) => {
                    if let Ok(status) = self.query_live(&declaration).await {
                        if matches!(
                            status.state,
                            V3ManagedRunState::Starting | V3ManagedRunState::Running
                        ) {
                            return Ok(());
                        }
                    }
                    return Err(error);
                }
                Err(error) => return Err(error),
            };
            release_listener_set_for_start(&self.state_root, &instance_dir, &declaration).await?;
            wait_for_stopping_instance(&instance_dir, &declaration, Duration::from_secs(15))
                .await?;
            recover_exited_front_control_handoff(&instance_dir, &declaration).await?;
            reap_inactive_runtime_files(&instance_dir, &declaration)?;
            Self::prepare_fresh_launch(&instance_dir, &declaration)?;
        }
        exec_foreground_start(executable_path.as_ref(), &declaration, self)
    }

    pub async fn status(
        &self,
        executable_path: impl AsRef<Path>,
    ) -> Result<V3ManagedStatusRecord, V3LifecycleError> {
        let (declaration, _) = self.declaration(executable_path)?;
        let live_error = match self.query_live(&declaration).await {
            Ok(status) => return Ok(status),
            Err(error) => error,
        };
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
                // A persisted terminal state for the derived identity is historical residue
                // when the config changed on disk: an older identity under the same config
                // path and listener set may still be live. Never let a stale terminal mask
                // a live drifted runtime; if no live instance is discovered, keep the
                // persisted terminal as the truthful status.
                if let Some(live) = self
                    .discover_live_instance_under_config_drift(&declaration)
                    .await
                {
                    return Ok(live);
                }
                return Ok(status);
            }
            return Err(live_error);
        }
        // The published declaration is part of the instance identity: both the config path
        // and the config content digest feed `instance_id`. Editing the config on disk while
        // the managed runtime keeps serving therefore moves the identity derived from that
        // config away from the identity the live runtime published. Reporting `stopped` for a
        // runtime that is still serving clients is a false stop, so look for the runtime that
        // is actually alive under this config path before synthesizing a stopped record.
        if let Some(status) = self
            .discover_live_instance_under_config_drift(&declaration)
            .await
        {
            return Ok(status);
        }
        Ok(V3ManagedStatusRecord {
            schema_version: SCHEMA_VERSION,
            instance_id: declaration.instance_id,
            state: V3ManagedRunState::Stopped,
            updated_at_epoch_ms: epoch_ms(),
            detail: Some(format!(
                "no managed runtime state; query_live failed: {live_error}"
            )),
        })
    }

    /// Find the managed runtime that is actually serving this config path after the config
    /// content changed on disk, so its published identity no longer matches the identity
    /// derived from the current config.
    ///
    /// Candidate narrowing stays file-only and cheap: a candidate must share the canonical
    /// config path and publish the exact same listener set. In the real state root that
    /// leaves a handful of candidates instead of every historical instance directory, so the
    /// read-only control probe never reaches an unrelated runtime. Liveness is decided only by
    /// the control channel; a persisted `status.json` state is historical residue and is never
    /// treated as evidence of a live instance.
    async fn discover_live_instance_under_config_drift(
        &self,
        declaration: &V3ManagedInstanceDeclaration,
    ) -> Option<V3ManagedStatusRecord> {
        let mut candidates: Vec<V3ManagedInstanceDeclaration> = Vec::new();
        let entries = fs::read_dir(self.state_root.join("instances")).ok()?;
        for entry in entries.flatten() {
            let instance_dir = entry.path();
            if !instance_dir.is_dir() {
                continue;
            }
            let published: V3ManagedInstanceDeclaration =
                match read_json(&instance_dir.join("instance.json")) {
                    Ok(published) => published,
                    Err(_) => continue,
                };
            if published.instance_id == declaration.instance_id {
                continue;
            }
            if published.config_path != declaration.config_path {
                continue;
            }
            if !same_managed_listener_set(&published.listeners, &declaration.listeners) {
                continue;
            }
            candidates.push(published);
        }
        candidates.sort_by(|left, right| left.instance_id.cmp(&right.instance_id));
        let mut live: Vec<(V3ManagedInstanceDeclaration, V3ManagedStatusRecord)> = Vec::new();
        for published in candidates {
            let status = match self.query_live(&published).await {
                Ok(status) => status,
                Err(_) => continue,
            };
            if !matches!(
                status.state,
                V3ManagedRunState::Starting
                    | V3ManagedRunState::Running
                    | V3ManagedRunState::Stopping
            ) {
                continue;
            }
            live.push((published, status));
        }
        let (published, mut status) = live.first()?.clone();
        let live_ids = live
            .iter()
            .map(|(_, status)| status.instance_id.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let note = format!(
            "config changed on disk; live managed instance {} keeps its published declaration \
             (published config digest {} vs current {}); live candidates for this config path \
             and listener set: {}",
            status.instance_id, published.config_digest, declaration.config_digest, live_ids
        );
        let prior = status.detail.take();
        status.detail = Some(match prior {
            Some(prior) if !prior.is_empty() => format!("{prior}; {note}"),
            _ => note,
        });
        Some(status)
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
        let mut owners = find_live_published_owners(&self.state_root, |published| {
            published.config_path == declaration.config_path
                && same_managed_listener_set(&published.listeners, &declaration.listeners)
        })?;
        if owners.len() > 1 {
            // A legacy PID record can name a live PID without proving that it
            // still owns the recorded control endpoint. Resolve conflicts
            // through the actual control channel before sending Stop.
            let mut responsive = Vec::new();
            for (path, published) in owners {
                if self.query_live(&published).await.is_ok() {
                    responsive.push((path, published));
                }
            }
            if responsive.len() != 1 {
                return Err(V3LifecycleError::IdentityMismatch(
                    "cannot resolve one responsive owner for the stop scope".into(),
                ));
            }
            owners = responsive;
        }
        let (instance_dir, declaration, _owner_lock) = match owners.pop() {
            Some((path, published)) if path != instance_dir => {
                let lock = acquire_operation_lock(&path, "stop")?;
                (path, published, Some(lock))
            }
            Some((path, published)) => (path, published, None),
            None => (instance_dir, declaration, None),
        };
        let response = match send_control(&instance_dir, &declaration, ControlOperation::Stop).await
        {
            Ok(response) => response,
            Err(error @ (V3LifecycleError::NotRunning(_) | V3LifecycleError::Timeout(_))) => {
                if listener_set_is_available(&declaration.listeners) {
                    let path = instance_dir.join("status.json");
                    if regular_handoff_exists(&path)? {
                        let status: V3ManagedStatusRecord = read_json(&path)?;
                        if status.state == V3ManagedRunState::Stopping
                            && restart_recovery_state_is_stale_owned_unreachable(
                                &instance_dir,
                                &declaration,
                            )?
                        {
                            return Err(incomplete_stop_publication());
                        }
                    }
                    return Err(error);
                }
                return self
                    .force_stop_after_graceful_timeout(&instance_dir, &declaration)
                    .await;
            }
            Err(error) => return Err(error),
        };
        if !response.accepted {
            if response.state == V3ManagedRunState::Stopping {
                require_no_pending_shutdown(&instance_dir, &declaration).await?;
            }
            return Err(V3LifecycleError::IdentityMismatch(response.message));
        }
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let status_path = instance_dir.join("status.json");
            if status_path.exists() {
                let status: V3ManagedStatusRecord = read_json(&status_path)?;
                if status.schema_version != SCHEMA_VERSION
                    || status.instance_id != declaration.instance_id
                {
                    return Err(V3LifecycleError::IdentityMismatch(
                        "managed stop status differs from the authenticated instance".into(),
                    ));
                }
                if status.state == V3ManagedRunState::Stopped {
                    let pending = regular_handoff_exists(&instance_dir.join(RESTART_PLAN_FILE))
                        .map_err(|error| {
                            V3LifecycleError::Validation(format!(
                                "managed runtime stopped with incomplete cleanup: {error}"
                            ))
                        })?;
                    let retiring_cache = regular_handoff_exists(&instance_dir.join("pid.cache"))?
                        && !regular_handoff_exists(&instance_dir.join(FRONT_HANDOFF_FILE))?;
                    if !pending && !retiring_cache {
                        return Ok(status);
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return Err(V3LifecycleError::Validation(append_status_detail(
                            status.detail.as_deref(),
                            "managed runtime stopped with generation cleanup incomplete".into(),
                        )));
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                // An authenticated Stop may have closed business and then
                // failed to publish Stopped. Only a remaining listener needs force.
                let cache = instance_dir.join("pid.cache");
                if listener_set_is_available(&declaration.listeners)
                    || (regular_handoff_exists(&cache)?
                        && managed_generation_has_exited(&read_json(&cache)?)?)
                {
                    require_no_pending_shutdown(&instance_dir, &declaration).await?;
                    return Err(incomplete_stop_publication());
                }
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
        require_no_pending_shutdown(instance_dir, declaration).await?;
        let hooks_cleanup_detail = hooks_sidecar_cleanup_incomplete_detail(instance_dir);
        let force_timeout = env_duration_ms(
            &[
                "ROUTECODEX_V3_KILL_TIMEOUT_MS",
                "RCC_V3_KILL_TIMEOUT_MS",
                "ROUTECODEX_KILL_TIMEOUT_MS",
            ],
            DEFAULT_START_FORCE_KILL_TIMEOUT,
        );
        let mut release = ForcedRelease::default();
        force_release_scoped_listener_set_after_graceful_timeout(
            &self.state_root,
            instance_dir,
            declaration,
            force_timeout,
            &mut release,
        )
        .await
        .map_err(|e| with_signal_effects(e, &release.signals))?;
        let effects = |e| with_signal_effects(e, &release.signals);
        let custody = forced_stop_custody(instance_dir, declaration, &release).map_err(effects)?;
        if let ForcedStopCustody::ExistingStopped(mut baseline) = custody {
            baseline.detail = Some(append_status_detail(
                hooks_cleanup_detail.as_deref(),
                "scoped listeners already released without signal delivery".into(),
            ));
            return Ok(baseline);
        }
        let mut detail = append_status_detail(
            hooks_cleanup_detail.as_deref(),
            "forced scoped listener shutdown after graceful stop timeout".into(),
        );
        if matches!(custody, ForcedStopCustody::Retained) {
            detail =
                append_status_detail(Some(&detail), "pending active-key control cleanup".into());
        }
        write_status(
            instance_dir,
            &declaration.instance_id,
            V3ManagedRunState::Stopped,
            Some(detail),
        )
        .map_err(effects)?;
        cleanup_forced_stopped_runtime_state(instance_dir, declaration, custody)
            .map_err(effects)?;
        read_json(&instance_dir.join("status.json")).map_err(effects)
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
        // One declared budget covers owner lookup, control preparation/ACK and
        // replacement observation. Ordinary Status keeps its separate budget.
        let started_at = tokio::time::Instant::now();
        let deadline = started_at + timeout;
        let trace = |observe: &mut F, phase| {
            observe(V3ManagedLifecycleObservation::RestartPhase {
                phase,
                elapsed: started_at.elapsed(),
            });
        };
        trace(&mut observe, "loading declaration");
        let (declaration, manifest) = self.declaration(executable_path.as_ref())?;
        let declaration_ready_at = tokio::time::Instant::now();
        let instance_dir = self.instance_dir(&declaration.instance_id);
        trace(&mut observe, "locking target instance");
        ensure_private_dir(&instance_dir)?;
        let _lock = acquire_operation_lock(&instance_dir, "restart")?;
        let exited_handoff =
            exited_restart_handoff_requires_reconciliation(&instance_dir, &declaration)?;
        let (control_instance_dir, control_declaration, _previous_owner_lock) = if !exited_handoff
            && instance_has_control_truth(&instance_dir)
        {
            (instance_dir.clone(), declaration.clone(), None)
        } else {
            trace(&mut observe, "finding previous owner");
            // Partial local generation evidence cannot authorize a transfer from a peer.
            let previous_owner = if exited_handoff
                || !restart_can_select_previous_owner(&instance_dir, &declaration)?
            {
                None
            } else {
                find_live_previous_owner_for_restart(&self.state_root, &declaration)?
            };
            let Some((previous_instance_dir, previous_declaration)) = previous_owner else {
                let stopped = !exited_handoff
                    && restart_terminal_bootstrap_is_verified(&instance_dir, &declaration)?;
                if stopped || exited_handoff {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(V3LifecycleError::Timeout(format!(
                            "restart {} before bootstrapping stopped owner",
                            declaration.instance_id
                        )));
                    }
                    validate_auth_handles(&manifest)?;
                    let recovery =
                        recover_exited_front_control_handoff(&instance_dir, &declaration).await?;
                    if exited_handoff && !matches!(recovery, ExitedHandoffRecovery::Recovered) {
                        return Err(V3LifecycleError::IdentityMismatch(
                            "exited restart handoff disappeared before recovery".into(),
                        ));
                    }
                    reap_inactive_runtime_files(&instance_dir, &declaration)?;
                    return tokio::time::timeout_at(
                        deadline,
                        self.launch_managed_child(
                            executable_path.as_ref(),
                            &declaration,
                            deadline.saturating_duration_since(tokio::time::Instant::now()),
                        ),
                    )
                    .await
                    .map_err(|_| {
                        V3LifecycleError::Timeout(format!(
                            "restart {} waiting for bootstrapped owner",
                            declaration.instance_id
                        ))
                    })?;
                }
                return Err(V3LifecycleError::NotRunning(
                    declaration.instance_id.clone(),
                ));
            };
            trace(&mut observe, "locking previous owner");
            let previous_owner_lock = acquire_operation_lock(&previous_instance_dir, "restart")?;
            (
                previous_instance_dir,
                previous_declaration,
                Some(previous_owner_lock),
            )
        };
        if tokio::time::Instant::now() >= deadline {
            return Err(V3LifecycleError::Timeout(format!(
                "restart {} before control exchange (declaration {:?}, owner lookup and locks {:?})",
                declaration.instance_id,
                declaration_ready_at.duration_since(started_at),
                declaration_ready_at.elapsed()
            )));
        }
        observe(V3ManagedLifecycleObservation::RestartTargetResolved {
            instance_id: declaration.instance_id.clone(),
            control_instance_id: control_declaration.instance_id.clone(),
            listeners: declaration.listeners.clone(),
        });
        let previous_start_nonce = read_pid_cache_start_nonce(&control_instance_dir)?;
        trace(&mut observe, "validating provider credentials");
        validate_auth_handles(&manifest)?;
        let status_path = control_instance_dir.join("status.json");
        let dead_control = if control_instance_dir == instance_dir {
            let cache: V3ManagedPidCache = read_json(&instance_dir.join("pid.cache"))?;
            let terminal = regular_handoff_exists(&status_path)?
                && matches!(
                    read_json::<V3ManagedStatusRecord>(&status_path)?.state,
                    V3ManagedRunState::Stopped | V3ManagedRunState::Failed
                );
            if terminal || !pid_is_alive(cache.pid) {
                if !restart_recovery_state_is_stale_owned_unreachable(&instance_dir, &declaration)?
                {
                    return Err(V3LifecycleError::NotRunning(
                        declaration.instance_id.clone(),
                    ));
                }
                true
            } else {
                false
            }
        } else {
            false
        };
        trace(&mut observe, "preparing previous release transfer");
        let mut transfer = prepare_previous_release_restart_transfer(
            &control_instance_dir,
            &control_declaration,
            &instance_dir,
            &declaration,
        )?;
        trace(
            &mut observe,
            "sending restart control and waiting for acceptance",
        );
        let exchange = if dead_control {
            // Probe the verified endpoint without replacing or removing its plan.
            tokio::time::timeout_at(
                deadline,
                send_control_without_timeout(
                    &instance_dir,
                    &declaration,
                    ControlOperation::Restart,
                    None,
                ),
            )
            .await
            .map_err(|_| {
                V3LifecycleError::Timeout(format!("control challenge {}", declaration.instance_id))
            })?
        } else {
            send_restart_control(
                &control_instance_dir,
                &control_declaration,
                &declaration,
                self.force_snapshots,
                self.force_snapshot_direct,
                self.force_snapshot_stages.clone(),
                self.force_sse_dump,
                transfer.as_mut(),
                deadline,
            )
            .await
        };
        let response = match exchange {
            Ok(response) => response,
            Err(error @ V3LifecycleError::NotRunning(_)) => {
                if let Some(transfer) = transfer.as_mut() {
                    transfer.reject();
                }
                if !restart_recovery_state_is_stale_owned_unreachable(&instance_dir, &declaration)?
                {
                    return Err(error);
                }
                validate_auth_handles(&manifest)?;
                recover_exited_front_control_handoff(&instance_dir, &declaration).await?;
                reap_inactive_runtime_files(&instance_dir, &declaration)?;
                trace(&mut observe, "launching recovered owner");
                return tokio::time::timeout_at(
                    deadline,
                    self.launch_managed_child(
                        executable_path.as_ref(),
                        &declaration,
                        deadline.saturating_duration_since(tokio::time::Instant::now()),
                    ),
                )
                .await
                .map_err(|_| {
                    V3LifecycleError::Timeout(format!(
                        "restart {} waiting for recovered owner",
                        declaration.instance_id
                    ))
                })?;
            }
            Err(error) => return Err(error),
        };
        if !response.accepted {
            if let Some(transfer) = transfer.as_mut() {
                transfer.reject();
            }
            return Err(V3LifecycleError::IdentityMismatch(response.message));
        }
        observe(V3ManagedLifecycleObservation::RestartControlAccepted {
            instance_id: response.instance_id.clone(),
            state: response.state.clone(),
            message: response.message.clone(),
        });
        trace(&mut observe, "waiting for replacement");
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
        let mut restart_transition_observed = false;
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(V3LifecycleError::Timeout(format!(
                    "restart {} waiting for replacement after control accepted",
                    declaration.instance_id
                )));
            }
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
            if let Ok(Ok(status)) =
                tokio::time::timeout_at(deadline, self.query_live(&declaration)).await
            {
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
            tokio::time::sleep_until(
                deadline.min(tokio::time::Instant::now() + Duration::from_millis(50)),
            )
            .await;
        }
    }

    pub async fn run_managed_child(
        &self,
        executable_path: impl AsRef<Path>,
    ) -> Result<(), V3LifecycleError> {
        let (declaration, manifest, runtime_fd_limit) =
            self.declaration_with_runtime(&executable_path)?;
        validate_auth_handles(&manifest)?;
        self.run_managed_child_with_declaration(
            executable_path,
            declaration,
            manifest,
            runtime_fd_limit,
        )
        .await
    }

    async fn run_managed_child_with_declaration(
        &self,
        _executable_path: impl AsRef<Path>,
        declaration: V3ManagedInstanceDeclaration,
        manifest: V3Config05ManifestPublished,
        runtime_fd_limit: Option<u64>,
    ) -> Result<(), V3LifecycleError> {
        if self.force_sse_dump {
            std::env::set_var("ROUTECODEX_V3_SSE_DUMP", "1");
        }
        validate_auth_handles(&manifest)?;
        apply_v3_runtime_fd_limit(runtime_fd_limit)?;
        let instance_dir = self.instance_dir(&declaration.instance_id);
        ensure_private_dir(&instance_dir)?;
        let handoff_path = instance_dir.join(FRONT_HANDOFF_FILE);
        let mut exec_owner = std::env::var_os(EXEC_RESTART_OWNER_ENV)
            .map(|owner| serde_json::from_str::<ExecRestartOwner>(&owner.to_string_lossy()))
            .transpose()?;
        std::env::remove_var(EXEC_RESTART_OWNER_ENV);
        let verified_handoff = if let Some(owner) = exec_owner.as_mut() {
            Some(verify_exec_front_control_handoff(
                &self.instance_dir(&owner.instance_id),
                &instance_dir,
                &declaration,
                owner,
            )?)
        } else {
            normalize_previous_release_handoff(&instance_dir, &declaration, true)?
        };
        let start_nonce = new_start_nonce(&declaration.instance_id);
        let pid = V3ManagedPidCache {
            retained_control: verified_handoff
                .as_ref()
                .map(ManagedFrontControlHandoff::link),
            schema_version: SCHEMA_VERSION,
            instance_id: declaration.instance_id.clone(),
            pid: std::process::id(),
            start_nonce: start_nonce.clone(),
            started_at_epoch_ms: epoch_ms(),
            process_start_token: Some(process_start_token(std::process::id())?.ok_or_else(
                || {
                    V3LifecycleError::Validation(
                        "managed child process start token unavailable".into(),
                    )
                },
            )?),
        };
        let is_exact_exec = verified_handoff.is_some();
        let mut startup = None;
        let socket_path = managed_control_socket_path(&declaration.instance_id);
        let mut owned_socket = false;
        let mut fresh_publications = Vec::new();
        let mut full_fresh_publication = false;
        let mut aggregate = None;
        let started = async {
            let exec_cleanup_detail = if let Some(handoff) = verified_handoff {
                if let Some(owner) = exec_owner {
                    adopt_exec_restart_declaration_change(
                        &self.state_root,
                        &instance_dir,
                        &declaration,
                        &owner,
                        &pid,
                    )?;
                } else {
                    adopt_previous_release_restart_declaration_change(
                        &instance_dir,
                        &declaration,
                        &handoff,
                        &pid,
                    )?;
                }
                // Only a completed adoption transfers endpoint disposition to
                // this startup. An interrupted transition needs both generations.
                startup = Some(handoff.into_startup(handoff_path.clone()));
                V3HooksSidecarSupervisor::cleanup_exec_owner(&instance_dir).await
            } else {
                None
            };
            verify_published_declaration(&instance_dir, &declaration)?;
            let startup_detail =
                read_pending_startup_detail(&instance_dir, &declaration.instance_id)?;
            let startup_detail = exec_cleanup_detail
                .map(|detail| append_status_detail(startup_detail.as_deref(), detail))
                .or(startup_detail);
            remove_restart_plan_for_previous_control_identity(&instance_dir, &start_nonce)?;
            if socket_path.exists() {
                return Err(V3LifecycleError::IdentityMismatch(format!(
                    "control socket already exists without a verified stopped cleanup: {}",
                    socket_path.display()
                )));
            }
            let listener = UnixListener::bind(&socket_path)?;
            owned_socket = true;
            if !is_exact_exec {
                fresh_publications.push(socket_path.clone());
            }
            fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))?;
            if !is_exact_exec {
                write_json_atomic(&instance_dir.join("pid.cache"), &pid)?;
                fresh_publications.push(instance_dir.join("pid.cache"));
            }
            write_json_atomic(
                &instance_dir.join("control.json"),
                &V3ManagedControlRecord {
                    schema_version: SCHEMA_VERSION,
                    instance_id: declaration.instance_id.clone(),
                    socket_path: socket_path.display().to_string(),
                    start_nonce: start_nonce.clone(),
                },
            )?;
            if !is_exact_exec {
                full_fresh_publication = true;
                write_status(
                    &instance_dir,
                    &declaration.instance_id,
                    V3ManagedRunState::Starting,
                    None,
                )?;
                fresh_publications.clear();
                full_fresh_publication = false;
            }
            let admin_webui = declaration
                .listeners
                .iter()
                .find(|listener| listener.server_id == "admin_webui")
                .map(|listener| V3AdminWebuiManifest {
                    enabled: true,
                    bind: listener.bind.clone(),
                    port: listener.port,
                });
            // Selection persistence and listener controls use the declared config
            // even when this managed instance has no Admin listener.
            let admin_config_path = Some(PathBuf::from(&declaration.config_path));
            if startup.is_none() {
                startup = Some(
                    ManagedFrontControlHandoff {
                        declaration: declaration.clone(),
                        origin: pid,
                        checkpoints: legacy_front_checkpoints(&handoff_path)?,
                        controls: V3ActiveKeyControlExecHandoff::default(),
                    }
                    .into_startup(handoff_path.clone()),
                );
            }
            aggregate = Some(
                spawn_v3_server_aggregate_for_managed_startup(
                    manifest,
                    admin_webui,
                    admin_config_path,
                    Some(instance_dir.join("hooks-sidecar.sock")),
                    startup.as_ref(),
                )
                .await?,
            );
            let provider_handoff_path = instance_dir.join(PROVIDER_HANDOFF_FILE);
            if provider_handoff_path.exists() {
                let checkpoints: Vec<
                    routecodex_v3_provider_responses::V3ProviderTransportCheckpoint,
                > = read_json(&provider_handoff_path)?;
                routecodex_v3_runtime::restore_default_provider_transport_handoff_checkpoints(
                    &checkpoints,
                )
                .map_err(V3LifecycleError::Validation)?;
                fs::remove_file(provider_handoff_path)?;
            }
            Ok::<_, V3LifecycleError>((listener, startup_detail))
        }
        .await;
        let (listener, startup_detail) = match started {
            Ok(started) => started,
            Err(error) => {
                if let Some(handle) = aggregate.take() {
                    return control_plane::fail_published_runtime(
                        &instance_dir,
                        &declaration.instance_id,
                        Some(handle),
                        None,
                        Some((&socket_path, &declaration, &start_nonce)),
                        error,
                    )
                    .await;
                }
                let mut detail = error.to_string();
                if full_fresh_publication {
                    if let Err(failure) =
                        close_failed_startup_control_files(&instance_dir, &socket_path)
                            .and_then(|()| remove_settled_pid_cache(&instance_dir))
                    {
                        eprintln!("managed startup cleanup failed after {error}: {failure}");
                    }
                } else if !fresh_publications.is_empty() {
                    // Starting did not become durable. The existing Stopped
                    // baseline permits retry after this child's partial writes.
                    for path in fresh_publications.into_iter().rev() {
                        if let Err(failure) = fs::remove_file(&path) {
                            eprintln!(
                                "managed startup cleanup of {} failed after {error}: {failure}",
                                path.display()
                            );
                            break;
                        }
                    }
                } else if owned_socket || is_exact_exec {
                    let controls = match startup.as_ref() {
                        Some(startup) => {
                            match finish_failed_front_control_handoff(&instance_dir, startup).await
                            {
                                Ok(report) => report,
                                Err(failure) => {
                                    detail = append_status_detail(Some(&detail), format!("active-key startup custody cleanup failed: {failure}; pending active-key control cleanup"));
                                    None
                                }
                            }
                        }
                        None => {
                            if is_exact_exec {
                                detail = append_status_detail(Some(&detail), "interrupted declaration transition; pending active-key control cleanup".into());
                            }
                            None
                        }
                    };
                    if let Some(report) = controls.as_ref().filter(|report| !report.is_empty()) {
                        detail = append_status_detail(Some(&detail), report.to_string());
                    }
                    control_plane::publish_failed_outcome(
                        &instance_dir,
                        &declaration.instance_id,
                        &detail,
                        controls.as_ref(),
                        owned_socket.then_some((
                            socket_path.as_path(),
                            &declaration,
                            start_nonce.as_str(),
                        )),
                        "startup",
                    );
                }
                return Err(error);
            }
        };
        let handle = aggregate.expect("successful managed startup returns its aggregate");
        let startup_detail = handle
            .active_key_control_startup_details()
            .iter()
            .fold(startup_detail, |previous, detail| {
                Some(append_status_detail(previous.as_deref(), detail.clone()))
            });
        let handle = Some(handle);
        let mut hooks_sidecar =
            V3HooksSidecarSupervisor::spawn(instance_dir.clone(), declaration.instance_id.clone());
        let ready = async {
            let hooks_sidecar_detail = hooks_sidecar
                .wait_for_readiness_or_timeout(HOOKS_READINESS_ADMISSION_TIMEOUT)
                .await?
                .unwrap_or_else(|| Some("hooks sidecar readiness pending".to_string()));
            let running_detail = hooks_sidecar_detail
                .map(|detail| append_status_detail(startup_detail.as_deref(), detail))
                .or_else(|| startup_detail.clone());
            write_status(
                &instance_dir,
                &declaration.instance_id,
                V3ManagedRunState::Running,
                running_detail,
            )?;
            persist_retained_front_control_handoff(
                &instance_dir,
                &declaration,
                handle
                    .as_ref()
                    .and_then(V3ServerAggregateHandle::exact_active_key_custody),
            )
        }
        .await;
        if let Err(error) = ready {
            return control_plane::fail_published_runtime(
                &instance_dir,
                &declaration.instance_id,
                handle,
                Some(hooks_sidecar),
                Some((&socket_path, &declaration, &start_nonce)),
                error,
            )
            .await;
        }
        hooks_sidecar.spawn_readiness_detail_publisher(
            instance_dir.clone(),
            declaration.instance_id.clone(),
            start_nonce.clone(),
            startup_detail,
        );
        return control_plane::run_managed_control_loop(
            &instance_dir,
            &declaration,
            &socket_path,
            start_nonce,
            listener,
            handle,
            hooks_sidecar,
            self.force_console,
        )
        .await;
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
        let detail = control_plane::read_live_status_detail(&instance_dir, &response.instance_id)?;
        Ok(V3ManagedStatusRecord {
            schema_version: SCHEMA_VERSION,
            instance_id: response.instance_id,
            state: response.state,
            updated_at_epoch_ms: epoch_ms(),
            detail,
        })
    }
}

fn same_managed_listener_set(
    left: &[V3ManagedListenerDeclaration],
    right: &[V3ManagedListenerDeclaration],
) -> bool {
    fn normalize(listeners: &[V3ManagedListenerDeclaration]) -> Vec<(&str, &str, u16)> {
        let mut normalized = listeners
            .iter()
            .map(|listener| {
                (
                    listener.server_id.as_str(),
                    listener.bind.as_str(),
                    listener.port,
                )
            })
            .collect::<Vec<_>>();
        normalized.sort();
        normalized
    }
    normalize(left) == normalize(right)
}

fn managed_config_is_ephemeral(config_path: &Path) -> bool {
    let canonical_config =
        fs::canonicalize(config_path).unwrap_or_else(|_| config_path.to_path_buf());
    // A managed child config is ephemeral when it lives under a process temp
    // root. Check the caller's TMPDIR (std::env::temp_dir) plus the fixed
    // system temp roots, because Codex-managed orphans were observed under
    // both `/private/var/folders/.../T/...` and `/private/tmp/...`.
    let mut temp_roots = vec![std::env::temp_dir()];
    temp_roots.push(PathBuf::from("/tmp"));
    temp_roots.push(PathBuf::from("/var/tmp"));
    #[cfg(target_os = "macos")]
    {
        // The caller can override TMPDIR while a managed child still
        // references a config in the system per-user temp root.
        temp_roots.push(PathBuf::from("/var/folders"));
        temp_roots.push(PathBuf::from("/private/var/folders"));
    }
    temp_roots.into_iter().any(|temp_dir| {
        let canonical_temp = fs::canonicalize(&temp_dir).unwrap_or_else(|_| temp_dir.clone());
        config_path.starts_with(&temp_dir)
            || canonical_config.starts_with(&temp_dir)
            || config_path.starts_with(&canonical_temp)
            || canonical_config.starts_with(&canonical_temp)
    })
}
fn control_release_ports(
    request: &ControlRequest,
    current: &V3ManagedInstanceDeclaration,
    retained_ports: impl Iterator<Item = u16>,
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
    let allowed_ports = business_listener_declarations(&current.listeners)
        .into_iter()
        .map(|listener| listener.port)
        .chain(retained_ports)
        .collect::<BTreeSet<_>>();
    let release_ports = ports.iter().copied().collect::<BTreeSet<_>>();
    let unknown_ports = release_ports
        .difference(&allowed_ports)
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

async fn wait_for_stopping_instance(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    timeout: Duration,
) -> Result<(), V3LifecycleError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let status_path = instance_dir.join("status.json");
        if !status_path.exists() {
            return Ok(());
        }
        let status: V3ManagedStatusRecord = read_json(&status_path)?;
        if status.instance_id != declaration.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "managed status differs from start declaration".to_string(),
            ));
        }
        if status.state != V3ManagedRunState::Stopping {
            return Ok(());
        }
        if restart_recovery_state_is_stale_owned_unreachable(instance_dir, declaration)? {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(V3LifecycleError::Timeout(format!(
                "stop {} did not reach a terminal state before start",
                declaration.instance_id
            )));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
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
    require_no_pending_shutdown(instance_dir, declaration).await?;

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
    guard_managed_listener_pids(state_root, declaration, &terminate_pids, &occupied_ports)?;
    let mut terminate_pids = BTreeSet::from_iter(terminate_pids.iter().copied());
    terminate_pids.extend(instance_residual_pids_for_listener_set(
        state_root,
        &declaration.listeners,
    )?);
    let terminate_pids = terminate_pids.into_iter().collect::<Vec<_>>();
    // Start observes the released ports. Signal outcomes only describe partial effects.
    let mut outcomes = Vec::new();
    let result = async {
        signal_explicit_listener_pids(
            &terminate_pids,
            V3LifecycleSignal::Terminate,
            &mut outcomes,
        )?;
        if wait_for_listener_set_available(&declaration.listeners, graceful_timeout).await {
            return Ok(());
        }

        let occupied_ports = occupied_listener_ports(&declaration.listeners);
        let kill_pids = explicit_listener_pids_for_ports(&occupied_ports)?;
        guard_managed_listener_pids(state_root, declaration, &kill_pids, &occupied_ports)?;
        let mut kill_pids = BTreeSet::from_iter(kill_pids.iter().copied());
        kill_pids.extend(instance_residual_pids_for_listener_set(
            state_root,
            &declaration.listeners,
        )?);
        let kill_pids = kill_pids.into_iter().collect::<Vec<_>>();
        signal_explicit_listener_pids(&kill_pids, V3LifecycleSignal::Kill, &mut outcomes)?;
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
    .await;
    result.map_err(|e| with_signal_effects(e, &outcomes))
}

#[derive(Clone, PartialEq, Eq)]
struct ForcedGeneration {
    declaration: V3ManagedInstanceDeclaration,
    cache: V3ManagedPidCache,
    control: V3ManagedControlRecord,
}

impl ForcedGeneration {
    fn check_cache(&self, dir: &Path) -> Result<(), V3LifecycleError> {
        if !regular_handoff_exists(&dir.join("instance.json"))?
            || !regular_handoff_exists(&dir.join("pid.cache"))?
            || read_json::<V3ManagedInstanceDeclaration>(&dir.join("instance.json"))?
                != self.declaration
            || read_json::<V3ManagedPidCache>(&dir.join("pid.cache"))? != self.cache
        {
            return Err(incomplete_stop_publication());
        }
        Ok(())
    }

    fn check_current(&self, dir: &Path) -> Result<(), V3LifecycleError> {
        self.check_cache(dir)?;
        if !regular_handoff_exists(&dir.join("control.json"))?
            || read_json::<V3ManagedControlRecord>(&dir.join("control.json"))? != self.control
        {
            return Err(incomplete_stop_publication());
        }
        Ok(())
    }
}

#[derive(Default)]
struct ForcedRelease {
    signals: Vec<SignalOutcome>,
    generation: Option<(SignalOutcome, ForcedGeneration)>,
}

impl ForcedRelease {
    fn dispatch(
        &mut self,
        dir: &Path,
        declaration: &V3ManagedInstanceDeclaration,
        pid: u32,
        signal: V3LifecycleSignal,
    ) -> Result<(), V3LifecycleError> {
        let witness = scoped_signal_generation(dir, declaration, pid)?;
        if let Some((_, previous)) = &self.generation {
            if (previous.cache.pid == pid || witness.is_some())
                && witness.as_ref() != Some(previous)
            {
                return Err(incomplete_stop_publication());
            }
        }
        let outcome = signal_explicit_pid(pid, signal)?;
        if let Some(witness) =
            witness.filter(|_| outcome.disposition == SignalDisposition::Delivered)
        {
            self.generation = Some((outcome, witness));
        }
        self.signals.push(outcome);
        Ok(())
    }
}

async fn force_release_scoped_listener_set_after_graceful_timeout(
    state_root: &Path,
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    timeout: Duration,
    release: &mut ForcedRelease,
) -> Result<(), V3LifecycleError> {
    let listeners = &declaration.listeners;
    for signal in [V3LifecycleSignal::Terminate, V3LifecycleSignal::Kill] {
        let ports = occupied_listener_ports(listeners);
        let pids = explicit_listener_pids_for_ports(&ports)?;
        guard_managed_listener_pids(state_root, declaration, &pids, &ports)?;
        for pid in pids {
            release.dispatch(instance_dir, declaration, pid, signal)?;
        }
        if wait_for_listener_set_available(listeners, timeout).await {
            return Ok(());
        }
    }
    let remaining = explicit_listener_pids_for_ports(&occupied_listener_ports(listeners))?;
    Err(V3LifecycleError::Timeout(format!(
        "force stop listener set remaining_pids={}",
        format_pid_list(&remaining)
    )))
}

fn scoped_signal_generation(
    dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    pid: u32,
) -> Result<Option<ForcedGeneration>, V3LifecycleError> {
    if !regular_handoff_exists(&dir.join("pid.cache"))? {
        return Ok(None);
    }
    let cache: V3ManagedPidCache = read_json(&dir.join("pid.cache"))?;
    if cache.pid != pid {
        return Ok(None);
    }
    if !regular_handoff_exists(&dir.join("instance.json"))?
        || !regular_handoff_exists(&dir.join("control.json"))?
    {
        return Err(incomplete_stop_publication());
    }
    let published = read_json(&dir.join("instance.json"))?;
    let control = read_json(&dir.join("control.json"))?;
    if !managed_control_matches_declaration(declaration, &published, &cache, &control)
        || cache
            .retained_control
            .as_ref()
            .is_some_and(|link| link.target != published)
        || cache.start_nonce.is_empty()
        || cache
            .process_start_token
            .as_deref()
            .is_none_or(str::is_empty)
        || process_start_token(pid)? != cache.process_start_token
    {
        return Err(incomplete_stop_publication());
    }
    Ok(Some(ForcedGeneration {
        declaration: published,
        cache,
        control,
    }))
}

fn positive_zombie_row(pid: u32, bytes: &[u8]) -> bool {
    let Ok(output) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut lines = output.trim().lines();
    let Some(row) = lines.next() else {
        return false;
    };
    let mut fields = row.split_ascii_whitespace();
    pid != 0
        && fields.next() == Some(pid.to_string().as_str())
        && fields.next() == Some("Z")
        && fields.next().is_none()
        && lines.next().is_none()
}

fn original_generation_exited(cache: &V3ManagedPidCache) -> Result<bool, V3LifecycleError> {
    if managed_generation_has_exited(cache)? {
        return Ok(true);
    }
    // PID reuse itself requires the witnessed original process to have exited.
    // The signal receipt establishes dispatch, not causation.
    let output = Command::new("/bin/ps")
        .args(["-p", &cache.pid.to_string(), "-o", "pid=", "-o", "state="])
        .output()?;
    Ok(output.status.success() && positive_zombie_row(cache.pid, &output.stdout))
}

fn incomplete_stop_publication() -> V3LifecycleError {
    V3LifecycleError::Validation("managed stop terminal publication incomplete".into())
}

enum ForcedStopCustody {
    ExistingStopped(V3ManagedStatusRecord),
    BareDelivered,
    Ordinary(Box<ForcedGeneration>),
    Retained,
}

fn forced_stop_custody(
    dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    release: &ForcedRelease,
) -> Result<ForcedStopCustody, V3LifecycleError> {
    let status_path = dir.join("status.json");
    let status = if regular_handoff_exists(&status_path)? {
        let status: V3ManagedStatusRecord = read_json(&status_path)?;
        if status.schema_version != SCHEMA_VERSION || status.instance_id != declaration.instance_id
        {
            return Err(incomplete_stop_publication());
        }
        Some(status)
    } else {
        None
    };

    if !listener_set_is_available(&declaration.listeners) {
        return Err(incomplete_stop_publication());
    }
    if let Some((delivery, witness)) = &release.generation {
        if witness.declaration != *declaration
            || status.is_none()
            || delivery.pid != witness.cache.pid
            || delivery.disposition != SignalDisposition::Delivered
            || !original_generation_exited(&witness.cache)?
        {
            return Err(incomplete_stop_publication());
        }
        witness.check_current(dir)?;
        verified_inactive_socket(declaration)?;
        if verified_forced_stop_front(dir, declaration, witness)? {
            return Ok(ForcedStopCustody::Retained);
        }
        require_no_forced_transition(dir)?;
        verify_generation_restart_plan(dir, &witness.cache, declaration)?;
        return Ok(ForcedStopCustody::Ordinary(Box::new(witness.clone())));
    }

    require_no_forced_transition(dir)?;
    for leaf in ["pid.cache", "control.json", RESTART_PLAN_FILE] {
        if regular_handoff_exists(&dir.join(leaf))? {
            return Err(incomplete_stop_publication());
        }
    }
    if verified_inactive_socket(declaration)? {
        return Err(incomplete_stop_publication());
    }
    let published = regular_handoff_exists(&dir.join("instance.json"))?;
    if published {
        if !restart_can_select_previous_owner(dir, declaration)? {
            return Err(incomplete_stop_publication());
        }
    } else if status
        .as_ref()
        .is_some_and(|s| s.state != V3ManagedRunState::Stopped)
    {
        return Err(incomplete_stop_publication());
    }
    if release
        .signals
        .iter()
        .any(|s| s.disposition == SignalDisposition::Delivered)
    {
        return Ok(ForcedStopCustody::BareDelivered);
    }
    status
        .filter(|s| published && s.state == V3ManagedRunState::Stopped)
        .map(ForcedStopCustody::ExistingStopped)
        .ok_or_else(incomplete_stop_publication)
}

fn require_no_forced_transition(dir: &Path) -> Result<(), V3LifecycleError> {
    for leaf in [
        FRONT_HANDOFF_FILE,
        PROVIDER_HANDOFF_FILE,
        EXEC_RESTART_DECLARATION_FILE,
        exec_restart::PREVIOUS_RELEASE_RESTART_FILE,
    ] {
        if regular_handoff_exists(&dir.join(leaf))? {
            return Err(incomplete_stop_publication());
        }
    }
    Ok(())
}

fn require_settled_forced_plan(dir: &Path) -> Result<(), V3LifecycleError> {
    require_no_forced_transition(dir)?;
    if regular_handoff_exists(&dir.join(RESTART_PLAN_FILE))? {
        return Err(incomplete_stop_publication());
    }
    Ok(())
}

fn verified_inactive_socket(
    declaration: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    use std::os::unix::fs::FileTypeExt;
    let socket = managed_control_socket_path(&declaration.instance_id);
    match fs::symlink_metadata(&socket) {
        Ok(meta) if meta.file_type().is_socket() => {
            match std::os::unix::net::UnixStream::connect(&socket) {
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => Ok(true),
                Err(error) => Err(error.into()),
                Ok(_) => Err(incomplete_stop_publication()),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
        Ok(_) => Err(incomplete_stop_publication()),
    }
}

fn cleanup_forced_stopped_runtime_state(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    custody: ForcedStopCustody,
) -> Result<(), V3LifecycleError> {
    if let ForcedStopCustody::Ordinary(ref witness) = custody {
        witness.check_current(instance_dir)?;
        require_no_forced_transition(instance_dir)?;
        remove_verified_generation_plan(instance_dir, &witness.cache, declaration)?;
        witness.check_current(instance_dir)?;
        require_settled_forced_plan(instance_dir)?;
        if verified_inactive_socket(declaration)? {
            fs::remove_file(managed_control_socket_path(&declaration.instance_id))?;
        }
        witness.check_current(instance_dir)?;
        require_settled_forced_plan(instance_dir)?;
        if verified_inactive_socket(declaration)? {
            return Err(incomplete_stop_publication());
        }
        fs::remove_file(instance_dir.join("control.json"))?;
    }
    let hooks_sidecar_path = instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    if regular_handoff_exists(&hooks_sidecar_path)?
        && !hooks_sidecar_process_group_is_alive(instance_dir)?
    {
        fs::remove_file(&hooks_sidecar_path)?;
    }
    if let ForcedStopCustody::Ordinary(witness) = custody {
        witness.check_cache(instance_dir)?;
        require_settled_forced_plan(instance_dir)?;
        if regular_handoff_exists(&instance_dir.join("control.json"))?
            || verified_inactive_socket(declaration)?
        {
            return Err(incomplete_stop_publication());
        }
        fs::remove_file(instance_dir.join("pid.cache"))?;
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
        let release_ports = business_listener_declarations(&published.listeners)
            .into_iter()
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
        match response {
            Ok(response) if !response.accepted => {
                return Err(V3LifecycleError::Validation(response.message));
            }
            Ok(_) => {
                if wait_for_listener_set_available(listeners, timeout).await {
                    return Ok(());
                }
                require_no_pending_shutdown(&path, &published).await?;
            }
            Err(error @ V3LifecycleError::Timeout(_)) => return Err(error),
            Err(_) => {}
        }
    }
    Ok(())
}

async fn require_no_pending_shutdown(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    let pending = send_control(instance_dir, declaration, ControlOperation::Status)
        .await
        .is_ok_and(|response| {
            response.accepted
                && response.schema_version == SCHEMA_VERSION
                && response.instance_id == declaration.instance_id
                && response.state == V3ManagedRunState::Stopping
        });
    if pending {
        return Err(V3LifecycleError::Timeout(
            "shutdown is still pending; original owner retained until persistence and writer exit complete".into(),
        ));
    }
    Ok(())
}
#[cfg(test)]
mod internal_hooksd_tests;
#[cfg(test)]
mod tests;
