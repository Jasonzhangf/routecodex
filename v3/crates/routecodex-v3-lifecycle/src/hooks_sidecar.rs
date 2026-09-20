use super::*;
use routecodex_v3_hooks::{
    hooks_unavailable, HooksUnavailableReason, PROTOCOL as RCC_HOOKS_SIDECAR_PROTOCOL,
};
use serde_json::Value;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::pin::Pin;
use std::process::Stdio;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::{Child, Command as TokioCommand};

mod hooks_install;
use hooks_install::*;
mod process;
use process::*;
pub(crate) use process::{
    hooks_sidecar_cleanup_incomplete_detail, hooks_sidecar_process_group_is_alive,
};

const HOOKS_INSTALL_RECORD_ENV: &str = "ROUTECODEX_HOOKS_INSTALL_RECORD";
const HOOKS_INSTALL_RECORD_RELATIVE: &str = ".codex/routecodex-hooks/install.json";
pub(crate) const HOOKS_SIDECAR_PROCESS_FILE: &str = "hooks-sidecar.pid";
const SIDECAR_START_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const HOOKS_READINESS_ADMISSION_TIMEOUT: Duration = Duration::from_secs(1);
// Hooks are optional. Bound the wait for the supervisor task so a broken
// sidecar cleanup can never hold the main lifecycle open indefinitely.
const SIDECAR_STOP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct V3HooksSidecarProcessRecord {
    schema_version: u16,
    process_group_id: libc::pid_t,
    leader_pid: u32,
    leader_start_token: String,
    #[serde(default)]
    control_socket_identity: Option<CodexAppSocketIdentity>,
    #[serde(default)]
    codexapp_socket_cleanup: Option<PersistedCodexAppSocketCleanup>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedCodexAppSocketCleanup {
    path: PathBuf,
    install_root: PathBuf,
    #[serde(default)]
    pre_start_identity: Option<CodexAppSocketIdentity>,
    #[serde(default)]
    startup_identity: Option<CodexAppSocketIdentity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct CodexAppSocketIdentity {
    device: u64,
    inode: u64,
    is_socket: bool,
}

#[derive(Debug)]
struct CodexAppSocketCleanup {
    path: PathBuf,
    install_root: PathBuf,
    pre_start_identity: Option<CodexAppSocketIdentity>,
    startup_identity: Option<CodexAppSocketIdentity>,
}

impl From<&CodexAppSocketCleanup> for PersistedCodexAppSocketCleanup {
    fn from(cleanup: &CodexAppSocketCleanup) -> Self {
        Self {
            path: cleanup.path.clone(),
            install_root: cleanup.install_root.clone(),
            pre_start_identity: cleanup.pre_start_identity,
            startup_identity: cleanup.startup_identity,
        }
    }
}

impl From<&PersistedCodexAppSocketCleanup> for CodexAppSocketCleanup {
    fn from(cleanup: &PersistedCodexAppSocketCleanup) -> Self {
        Self {
            path: cleanup.path.clone(),
            install_root: cleanup.install_root.clone(),
            pre_start_identity: cleanup.pre_start_identity,
            startup_identity: cleanup.startup_identity,
        }
    }
}

pub(crate) struct V3HooksSidecarProcess {
    child: Child,
    group_leader: Option<Child>,
    process_group_id: libc::pid_t,
    leader_pid: u32,
    leader_start_token: String,
    process_record_path: PathBuf,
    control_socket_path: Option<PathBuf>,
    control_socket_identity: Option<CodexAppSocketIdentity>,
    degraded_detail: Option<String>,
    socket_cleanup: Option<CodexAppSocketCleanup>,
}

pub(crate) struct V3HooksSidecarSupervisor {
    instance_dir: PathBuf,
    stop_tx: Option<tokio::sync::watch::Sender<bool>>,
    readiness_rx: Option<Pin<Box<tokio::sync::oneshot::Receiver<Option<String>>>>>,
    done_rx: tokio::sync::oneshot::Receiver<Result<(), V3LifecycleError>>,
    task: tokio::task::JoinHandle<()>,
}

impl V3HooksSidecarSupervisor {
    pub(crate) fn spawn(instance_dir: PathBuf, instance_id: String) -> Self {
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let supervisor_stop_rx = stop_rx.clone();
        let (readiness_tx, readiness_rx) = tokio::sync::oneshot::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let task_instance_dir = instance_dir.clone();
        let task = tokio::spawn(async move {
            let result = run_managed_hooks_sidecar(
                task_instance_dir,
                instance_id,
                stop_rx,
                supervisor_stop_rx,
                readiness_tx,
            )
            .await;
            let _ = done_tx.send(result);
        });
        Self {
            instance_dir,
            stop_tx: Some(stop_tx),
            readiness_rx: Some(Box::pin(readiness_rx)),
            done_rx,
            task,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_startup(
        _instance_dir: PathBuf,
        startup: tokio::task::JoinHandle<Result<Option<V3HooksSidecarProcess>, V3LifecycleError>>,
    ) -> Self {
        let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let result = match startup.await {
                Ok(Ok(Some(sidecar))) => {
                    wait_for_sidecar_stop(&mut stop_rx).await;
                    sidecar.stop().await
                }
                Ok(Ok(None)) => Ok(()),
                Ok(Err(error)) => Err(error),
                Err(error) => Err(V3LifecycleError::Validation(format!(
                    "hooks sidecar startup task failed: {error}"
                ))),
            };
            let _ = done_tx.send(result);
        });
        Self {
            instance_dir: _instance_dir,
            stop_tx: Some(stop_tx),
            readiness_rx: None,
            done_rx,
            task,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_readiness_for_test(
        instance_dir: PathBuf,
        readiness_rx: tokio::sync::oneshot::Receiver<Option<String>>,
    ) -> Self {
        let (stop_tx, _stop_rx) = tokio::sync::watch::channel(false);
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = done_tx.send(Ok(()));
        });
        Self {
            instance_dir,
            stop_tx: Some(stop_tx),
            readiness_rx: Some(Box::pin(readiness_rx)),
            done_rx,
            task,
        }
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_readiness(&mut self) -> Result<Option<String>, V3LifecycleError> {
        let mut readiness_rx = self.readiness_rx.take().ok_or_else(|| {
            V3LifecycleError::Validation(
                "hooks sidecar readiness is unavailable for this supervisor".to_string(),
            )
        })?;
        readiness_rx.as_mut().await.map_err(|_| {
            V3LifecycleError::Validation(
                "hooks sidecar supervisor exited before publishing readiness".to_string(),
            )
        })
    }

    pub(crate) async fn wait_for_readiness_or_timeout(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<Option<String>>, V3LifecycleError> {
        let mut readiness_rx = self.readiness_rx.take().ok_or_else(|| {
            V3LifecycleError::Validation(
                "hooks sidecar readiness is unavailable for this supervisor".to_string(),
            )
        })?;
        let readiness = tokio::select! {
            readiness = readiness_rx.as_mut() => match readiness {
                Ok(detail) => Some(detail),
                Err(_) => {
                    return Err(V3LifecycleError::Validation(
                        "hooks sidecar supervisor exited before publishing readiness".to_string(),
                    ));
                }
            },
            _ = tokio::time::sleep(timeout) => None,
        };
        match readiness {
            Some(detail) => Ok(Some(detail)),
            None => {
                self.readiness_rx = Some(readiness_rx);
                Ok(None)
            }
        }
    }

    pub(crate) fn spawn_readiness_detail_publisher(
        &mut self,
        instance_dir: PathBuf,
        instance_id: String,
    ) {
        let Some(mut readiness_rx) = self.readiness_rx.take() else {
            return;
        };
        tokio::spawn(async move {
            let detail = match readiness_rx.as_mut().await {
                Ok(detail) => detail,
                Err(_) => Some(format!(
                    "hooks sidecar unavailable: {}: hooks sidecar supervisor exited before publishing readiness",
                    hooks_unavailable(HooksUnavailableReason::Crashed)
                )),
            };
            if let Err(error) = write_running_status_if_current_detail(
                &instance_dir,
                &instance_id,
                Some("hooks sidecar readiness pending"),
                detail,
            ) {
                eprintln!("hooks sidecar readiness status write failed: {error}");
            }
        });
    }

    pub(crate) async fn stop(mut self) -> Result<(), V3LifecycleError> {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(true);
        }
        match tokio::time::timeout(SIDECAR_STOP_TIMEOUT, self.done_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => Err(V3LifecycleError::Validation(format!(
                "hooks sidecar supervisor failed: {error}"
            ))),
            // The main lifecycle must stay bounded. Force-kill the persisted,
            // identity-checked process group here so a later exec cannot orphan
            // it; the still-running supervisor task observes the dead group and
            // completes its own cleanup, and dropping its JoinHandle detaches
            // it without dropping the owned Child handles.
            Err(_) => {
                let cleanup = force_terminate_sidecar_by_record(&self.instance_dir).await;
                drop(self.task);
                match cleanup {
                    Ok(ForcedSidecarCleanup::RecordRemoved) => Err(V3LifecycleError::Timeout(
                        "hooks sidecar supervisor stop".to_string(),
                    )),
                    Ok(ForcedSidecarCleanup::RecordPreserved) => Err(V3LifecycleError::Validation(
                        "hooks sidecar supervisor stop timed out; process record preserved because control-socket identity is unavailable"
                            .to_string(),
                    )),
                    Err(cleanup_error) => Err(V3LifecycleError::Validation(format!(
                        "hooks sidecar supervisor stop timed out; forced cleanup failed: {cleanup_error}"
                    ))),
                }
            }
        }
    }
}

async fn run_managed_hooks_sidecar(
    instance_dir: PathBuf,
    instance_id: String,
    mut startup_stop_rx: tokio::sync::watch::Receiver<bool>,
    mut supervisor_stop_rx: tokio::sync::watch::Receiver<bool>,
    readiness_tx: tokio::sync::oneshot::Sender<Option<String>>,
) -> Result<(), V3LifecycleError> {
    match start_managed_hooks_sidecar_cancelable(&instance_dir, Some(&mut startup_stop_rx)).await {
        Ok((Some(mut sidecar), detail)) => {
            let _ = readiness_tx.send(detail);
            if let Some(control_socket_path) = sidecar.control_socket_path.as_deref() {
                let control_socket_identity = sidecar.control_socket_identity;
                tokio::select! {
                    _ = wait_for_sidecar_stop(&mut supervisor_stop_rx) => sidecar.stop().await,
                    status = sidecar.child.wait() => {
                        if *supervisor_stop_rx.borrow() {
                            return sidecar.stop().await;
                        }
                        let exit = status.map_err(V3LifecycleError::Io)?;
                        degrade_after_sidecar_exit(&instance_dir, &instance_id, sidecar, exit).await
                    }
                    _ = wait_for_sidecar_control_loss(control_socket_path, control_socket_identity) => {
                        if *supervisor_stop_rx.borrow() {
                            return sidecar.stop().await;
                        }
                        degrade_after_sidecar_control_loss(&instance_dir, &instance_id, sidecar).await
                    }
                }
            } else {
                tokio::select! {
                    _ = wait_for_sidecar_stop(&mut supervisor_stop_rx) => sidecar.stop().await,
                    status = sidecar.child.wait() => {
                        if *supervisor_stop_rx.borrow() {
                            return sidecar.stop().await;
                        }
                        let exit = status.map_err(V3LifecycleError::Io)?;
                        degrade_after_sidecar_exit(&instance_dir, &instance_id, sidecar, exit).await
                    }
                }
            }
        }
        Ok((None, detail)) => {
            let _ = readiness_tx.send(detail);
            Ok(())
        }
        Err(V3LifecycleError::HooksSidecarStartCancelled) => {
            let _ = readiness_tx.send(None);
            Ok(())
        }
        Err(error) => {
            if *supervisor_stop_rx.borrow() {
                let _ = readiness_tx.send(None);
                return Err(error);
            }
            let detail = Some(format!("hooks sidecar unavailable: {error}"));
            let _ = readiness_tx.send(detail);
            Ok(())
        }
    }
}

async fn degrade_after_sidecar_exit(
    instance_dir: &Path,
    instance_id: &str,
    sidecar: V3HooksSidecarProcess,
    exit: std::process::ExitStatus,
) -> Result<(), V3LifecycleError> {
    let detail = Some(format!(
        "hooks sidecar unavailable: {}: hooks sidecar exited after readiness: {exit}",
        hooks_unavailable(HooksUnavailableReason::Crashed)
    ));
    let cleanup_result = sidecar.stop().await;
    let status_result = write_hooks_running_status(instance_dir, instance_id, detail);
    match (status_result, cleanup_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(status_error), Ok(())) => Err(status_error),
        (Ok(()), Err(cleanup_error)) => Err(cleanup_error),
        (Err(status_error), Err(cleanup_error)) => Err(V3LifecycleError::Validation(format!(
            "{status_error}; hooks sidecar cleanup failed: {cleanup_error}"
        ))),
    }
}

async fn degrade_after_sidecar_control_loss(
    instance_dir: &Path,
    instance_id: &str,
    sidecar: V3HooksSidecarProcess,
) -> Result<(), V3LifecycleError> {
    let detail = Some(format!(
        "hooks sidecar unavailable: {}: hooks sidecar control socket became unavailable after readiness",
        hooks_unavailable(HooksUnavailableReason::Crashed)
    ));
    let cleanup_result = sidecar.stop().await;
    let status_result = write_hooks_running_status(instance_dir, instance_id, detail);
    match (status_result, cleanup_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(status_error), Ok(())) => Err(status_error),
        (Ok(()), Err(cleanup_error)) => Err(cleanup_error),
        (Err(status_error), Err(cleanup_error)) => Err(V3LifecycleError::Validation(format!(
            "{status_error}; hooks sidecar cleanup failed: {cleanup_error}"
        ))),
    }
}

async fn wait_for_sidecar_control_loss(
    path: &Path,
    expected_identity: Option<CodexAppSocketIdentity>,
) {
    let mut interval = tokio::time::interval(Duration::from_millis(250));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if !sidecar_control_health(path, expected_identity).await {
            return;
        }
    }
}

async fn sidecar_control_health(
    path: &Path,
    expected_identity: Option<CodexAppSocketIdentity>,
) -> bool {
    if !sidecar_control_socket_identity_matches(path, expected_identity) {
        return false;
    }
    // Every probe failure is control loss. The supervisor must publish an
    // explicit degraded state instead of ending silently with a probe error.
    let mut stream = match UnixStream::connect(path).await {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    if stream
        .write_all(b"{\"method\":\"health\"}\n")
        .await
        .is_err()
    {
        return false;
    }
    let mut reader = tokio::io::BufReader::new(stream);
    let mut line = String::new();
    let read = match tokio::time::timeout(Duration::from_secs(1), reader.read_line(&mut line)).await
    {
        Ok(Ok(read)) => read,
        _ => return false,
    };
    if read == 0 {
        return false;
    }
    let response: routecodex_v3_hooks::ControlResponse = match serde_json::from_str(line.trim_end())
    {
        Ok(response) => response,
        Err(_) => return false,
    };
    response.protocol == RCC_HOOKS_SIDECAR_PROTOCOL
        && response.ok
        && response
            .result
            .as_ref()
            .and_then(|result| result["status"].as_str())
            == Some("ok")
}

fn sidecar_control_socket_identity_matches(
    path: &Path,
    expected_identity: Option<CodexAppSocketIdentity>,
) -> bool {
    let Some(expected_identity) = expected_identity else {
        return false;
    };
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    let current_identity = codexapp_socket_identity(&metadata);
    current_identity.is_socket && current_identity == expected_identity
}

async fn wait_for_sidecar_stop(stop_rx: &mut tokio::sync::watch::Receiver<bool>) {
    if *stop_rx.borrow() {
        return;
    }
    while stop_rx.changed().await.is_ok() {
        if *stop_rx.borrow() {
            return;
        }
    }
}

fn sidecar_cancellation_requested(cancel_rx: Option<&tokio::sync::watch::Receiver<bool>>) -> bool {
    cancel_rx.is_some_and(|cancel_rx| *cancel_rx.borrow())
}

async fn wait_for_sidecar_cancellation(cancel_rx: Option<&mut tokio::sync::watch::Receiver<bool>>) {
    let Some(cancel_rx) = cancel_rx else {
        std::future::pending::<()>().await;
        return;
    };
    if *cancel_rx.borrow() {
        return;
    }
    while cancel_rx.changed().await.is_ok() {
        if *cancel_rx.borrow() {
            return;
        }
    }
}

fn write_hooks_running_status(
    instance_dir: &Path,
    instance_id: &str,
    detail: Option<String>,
) -> Result<(), V3LifecycleError> {
    write_running_status_if_current(instance_dir, instance_id, detail)
}

pub(crate) async fn start_configured_hooks_sidecar(
    instance_dir: &Path,
) -> Result<Option<V3HooksSidecarProcess>, V3LifecycleError> {
    start_configured_hooks_sidecar_with_timeout(instance_dir, SIDECAR_START_TIMEOUT).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HooksRuntimeMode {
    InternalHooksd,
    LegacySupervisor,
}

fn hooks_runtime_mode(
    record: &Value,
    record_path: &Path,
) -> Result<HooksRuntimeMode, V3LifecycleError> {
    let mode = record
        .get("hooks_runtime")
        .and_then(Value::as_str)
        .unwrap_or("internal_hooksd");
    match mode {
        "internal_hooksd" => Ok(HooksRuntimeMode::InternalHooksd),
        // The legacy external supervisor is reachable only through an explicit
        // install-record declaration; runtime selection must not be inferred
        // from which binary happens to exist in the bin directory.
        "legacy_supervisor" => Ok(HooksRuntimeMode::LegacySupervisor),
        other => Err(V3LifecycleError::Validation(format!(
            "hooks install record {} declares unsupported hooks_runtime {other}",
            record_path.display()
        ))),
    }
}

pub(crate) async fn start_configured_hooks_sidecar_with_timeout(
    instance_dir: &Path,
    start_timeout: Duration,
) -> Result<Option<V3HooksSidecarProcess>, V3LifecycleError> {
    start_configured_hooks_sidecar_with_timeout_and_cancel(instance_dir, start_timeout, None).await
}

async fn start_configured_hooks_sidecar_with_timeout_and_cancel(
    instance_dir: &Path,
    start_timeout: Duration,
    mut cancel_rx: Option<&mut tokio::sync::watch::Receiver<bool>>,
) -> Result<Option<V3HooksSidecarProcess>, V3LifecycleError> {
    let Some(record_path) = hooks_install_record_path()
        .map_err(|error| optional_hooks_error_reason(HooksUnavailableReason::Missing, error))?
    else {
        return Ok(None);
    };
    let record_bytes = match fs::read(&record_path) {
        Ok(record_bytes) => record_bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(optional_hooks_error_reason(
                HooksUnavailableReason::Missing,
                error.into(),
            ));
        }
    };
    let record: Value = serde_json::from_slice(&record_bytes).map_err(|error| {
        optional_hooks_error_reason(HooksUnavailableReason::InvalidReadiness, error.into())
    })?;
    if record.get("supervisor_enabled").and_then(Value::as_bool) != Some(true) {
        return Ok(None);
    }
    if sidecar_cancellation_requested(cancel_rx.as_deref()) {
        return Err(V3LifecycleError::HooksSidecarStartCancelled);
    }
    let process_record_path = instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    let mut stale_process_group_confirmed_dead = false;
    let mut stale_control_socket_identity = None;
    if process_record_path.exists() {
        if hooks_sidecar_process_group_is_alive(instance_dir)? {
            return Err(optional_hooks_error(
                V3LifecycleError::HooksControlValidation(
                    "hooks sidecar process group from a previous run is still alive".to_string(),
                ),
            ));
        }
        let stale_record = read_json::<V3HooksSidecarProcessRecord>(&process_record_path).ok();
        if let Some(cleanup) = stale_record
            .as_ref()
            .and_then(|record| record.codexapp_socket_cleanup.as_ref())
        {
            cleanup_codexapp_socket(&cleanup.into())?;
        }
        stale_control_socket_identity =
            stale_record.and_then(|record| record.control_socket_identity);
        fs::remove_file(&process_record_path)?;
        stale_process_group_confirmed_dead = true;
    }
    let runtime_mode = hooks_runtime_mode(&record, &record_path)
        .map_err(|error| optional_hooks_error_reason(HooksUnavailableReason::Missing, error))?;
    let internal_hooksd = match runtime_mode {
        HooksRuntimeMode::InternalHooksd => Some(
            internal_hooksd_binary_from_record(&record, &record_path).map_err(|error| {
                optional_hooks_error_reason(HooksUnavailableReason::Missing, error)
            })?,
        ),
        HooksRuntimeMode::LegacySupervisor => None,
    };
    let wrapper = if internal_hooksd.is_none() {
        Some(
            required_record_path(&record, "supervisor_wrapper", &record_path).map_err(|error| {
                optional_hooks_error_reason(HooksUnavailableReason::Missing, error)
            })?,
        )
    } else {
        None
    };
    let daemon_config = if internal_hooksd.is_none() {
        Some(
            required_record_path(&record, "daemon_config", &record_path).map_err(|error| {
                optional_hooks_error_reason(HooksUnavailableReason::Missing, error)
            })?,
        )
    } else {
        None
    };
    let mut socket_cleanup = match internal_hooksd.as_ref() {
        Some(_) => None,
        None => {
            let daemon_config = daemon_config
                .as_deref()
                .expect("external sidecar has daemon config");
            prepare_codexapp_socket_cleanup(&record, daemon_config, &record_path)
                .map_err(optionalize_hooks_setup_error)?
        }
    };
    let sidecar_stderr = stderr_capture(instance_dir).map_err(optional_hooks_error)?;
    let codexapp_binary = if internal_hooksd.is_none() {
        Some(
            codexapp_binary_from_record(&record, &record_path).map_err(|error| {
                optional_hooks_error_reason(HooksUnavailableReason::Missing, error)
            })?,
        )
    } else {
        None
    };
    let control_socket = instance_dir.join("hooks-sidecar.sock");
    if internal_hooksd.is_some() && stale_process_group_confirmed_dead {
        // Stale-socket cleanup belongs to the lifecycle owner, which has just
        // verified the persisted process-group identity: a record that exists
        // and is still alive already returned above, and an unverifiable
        // record propagates before this point. The new sidecar has not been
        // spawned yet, so any leftover socket in this owned instance directory
        // is stale; remove it by recorded identity when available, otherwise
        // only after confirming the path is still a socket.
        match stale_control_socket_identity {
            Some(identity) => remove_file_if_identity_matches(&control_socket, identity)?,
            None => remove_control_socket_if_present(&control_socket)?,
        }
    }
    let appserver_socket = if internal_hooksd.is_some() {
        optional_record_path(&record, "appserver_socket").map_err(optional_hooks_error)?
    } else {
        None
    };
    let tui_appserver_socket = if internal_hooksd.is_some() {
        optional_record_path(&record, "tui_appserver_socket").map_err(optional_hooks_error)?
    } else {
        None
    };
    let desktop_appserver_socket = if internal_hooksd.is_some() {
        optional_record_path(&record, "desktop_appserver_socket").map_err(optional_hooks_error)?
    } else {
        None
    };
    let handlers_config = if internal_hooksd.is_some() {
        optional_record_path(&record, "hooks_handlers_config").map_err(optional_hooks_error)?
    } else {
        None
    };
    // Keep a lifecycle-owned process as the process-group leader. The
    // supervisor wrapper may exit before readiness while its descendants
    // remain alive; the anchor keeps the group identity verifiable until the
    // lifecycle explicitly stops it.
    let mut group_leader = TokioCommand::new("/bin/sh")
        .arg("-c")
        .arg("trap '' TERM INT; trap 'exit 0' USR1; read -r line")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            optional_hooks_error(V3LifecycleError::Validation(format!(
                "hooks sidecar process-group owner failed to spawn: {error}"
            )))
        })?;
    let Some(process_group_id) = group_leader.id().map(|pid| pid as libc::pid_t) else {
        let _ = group_leader.kill().await;
        let _ = group_leader.wait().await;
        return Err(optional_hooks_error(V3LifecycleError::Validation(
            "hooks sidecar process-group owner did not expose a process id".to_string(),
        )));
    };
    let leader_pid = process_group_id as u32;
    if sidecar_cancellation_requested(cancel_rx.as_deref()) {
        return finish_sidecar_start_failure(
            V3LifecycleError::HooksSidecarStartCancelled,
            None,
            group_leader,
            process_group_id,
            leader_pid,
            "",
            &process_record_path,
            internal_hooksd.as_ref().map(|_| control_socket.as_path()),
            socket_cleanup,
        )
        .await;
    }
    let leader_start_token = match process_start_token(leader_pid) {
        Ok(Some(token)) => token,
        Ok(None) => {
            return finish_sidecar_start_failure(
                optional_hooks_error(V3LifecycleError::Validation(
                    "hooks sidecar leader process start token unavailable".to_string(),
                )),
                None,
                group_leader,
                process_group_id,
                leader_pid,
                "",
                &process_record_path,
                internal_hooksd.as_ref().map(|_| control_socket.as_path()),
                socket_cleanup,
            )
            .await;
        }
        Err(error) => {
            return finish_sidecar_start_failure(
                error,
                None,
                group_leader,
                process_group_id,
                leader_pid,
                "",
                &process_record_path,
                internal_hooksd.as_ref().map(|_| control_socket.as_path()),
                socket_cleanup,
            )
            .await;
        }
    };
    let mut sidecar_command = if let Some(binary) = internal_hooksd.as_deref() {
        let mut command = TokioCommand::new(binary);
        command.arg("--socket").arg(&control_socket);
        if let Some(socket) = appserver_socket.as_deref() {
            command.arg("--appserver-socket").arg(socket);
        }
        if let Some(socket) = tui_appserver_socket.as_deref() {
            command.arg("--tui-appserver-socket").arg(socket);
        }
        if let Some(socket) = desktop_appserver_socket.as_deref() {
            command.arg("--desktop-appserver-socket").arg(socket);
        }
        if let Some(config) = handlers_config.as_deref() {
            command.arg("--handlers-config").arg(config);
        }
        command
            .arg("--state-file")
            .arg(instance_dir.join("hooks-sidecar-state.json"));
        command
    } else {
        let wrapper = wrapper
            .as_deref()
            .expect("external sidecar has supervisor wrapper");
        let daemon_config = daemon_config
            .as_deref()
            .expect("external sidecar has daemon config");
        let codexapp_binary = codexapp_binary
            .as_deref()
            .expect("external sidecar has codexapp binary");
        let mut command = TokioCommand::new(wrapper);
        command.arg("--config").arg(daemon_config);
        // d7cb31f：supervisor 需要 internal codexapp 可执行文件路径；
        // lifecycle 从 install record 的 bin_directory 解析并注入，
        // 不再依赖外部 shell 预先导出 ROUTECODEX_V3_CODEXAPP_BINARY。
        command.env("ROUTECODEX_V3_CODEXAPP_BINARY", codexapp_binary);
        command
    };
    sidecar_command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // d7cb31f：sidecar stderr 落到实例目录诊断文件，退出原因可追溯
        //（此前 Stdio::null 吞掉了 codexapp AddrInUse 等全部失败原因）。
        .stderr(sidecar_stderr)
        // Join the lifecycle-owned process group; the anchor remains the
        // persisted identity even if this wrapper exits early.
        .process_group(process_group_id)
        .kill_on_drop(true);
    let command_label = internal_hooksd
        .as_ref()
        .or(wrapper.as_ref())
        .expect("hooks sidecar has an internal binary or supervisor wrapper");
    let mut child = match sidecar_command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let startup = V3LifecycleError::Validation(format!(
                "hooks sidecar failed to spawn {}: {error}",
                command_label.display()
            ));
            return finish_sidecar_start_failure(
                optional_hooks_error(startup),
                None,
                group_leader,
                process_group_id,
                leader_pid,
                &leader_start_token,
                &process_record_path,
                internal_hooksd.as_ref().map(|_| control_socket.as_path()),
                socket_cleanup,
            )
            .await;
        }
    };
    if sidecar_cancellation_requested(cancel_rx.as_deref()) {
        return finish_sidecar_start_failure(
            V3LifecycleError::HooksSidecarStartCancelled,
            Some(child),
            group_leader,
            process_group_id,
            leader_pid,
            &leader_start_token,
            &process_record_path,
            internal_hooksd.as_ref().map(|_| control_socket.as_path()),
            socket_cleanup,
        )
        .await;
    }
    if let Err(error) = write_json_atomic(
        &process_record_path,
        &V3HooksSidecarProcessRecord {
            schema_version: SCHEMA_VERSION,
            process_group_id,
            leader_pid,
            leader_start_token: leader_start_token.clone(),
            control_socket_identity: None,
            codexapp_socket_cleanup: socket_cleanup.as_ref().map(Into::into),
        },
    ) {
        return finish_sidecar_start_failure(
            optional_hooks_error(error),
            Some(child),
            group_leader,
            process_group_id,
            leader_pid,
            &leader_start_token,
            &process_record_path,
            internal_hooksd.as_ref().map(|_| control_socket.as_path()),
            socket_cleanup,
        )
        .await;
    }
    let Some(stdout) = child.stdout.take() else {
        return finish_sidecar_start_failure(
            optional_hooks_error(V3LifecycleError::Validation(
                "hooks sidecar did not expose readiness stdout".to_string(),
            )),
            Some(child),
            group_leader,
            process_group_id,
            leader_pid,
            &leader_start_token,
            &process_record_path,
            internal_hooksd.as_ref().map(|_| control_socket.as_path()),
            socket_cleanup,
        )
        .await;
    };
    let mut reader = tokio::io::BufReader::new(stdout);
    let readiness = tokio::select! {
        _ = wait_for_sidecar_cancellation(cancel_rx.as_mut().map(|cancel_rx| &mut **cancel_rx)) => {
            return finish_sidecar_start_failure(
                V3LifecycleError::HooksSidecarStartCancelled,
                Some(child),
                group_leader,
                process_group_id,
                leader_pid,
                &leader_start_token,
                &process_record_path,
                internal_hooksd.as_ref().map(|_| control_socket.as_path()),
                socket_cleanup,
            )
            .await;
        }
        readiness = tokio::time::timeout(start_timeout, read_sidecar_readiness(&mut reader)) => {
            match readiness {
            Ok(Ok(readiness)) => readiness,
            Ok(Err(error)) => {
                return finish_sidecar_start_failure(
                    optional_hooks_error(error),
                    Some(child),
                    group_leader,
                    process_group_id,
                    leader_pid,
                    &leader_start_token,
                    &process_record_path,
                    internal_hooksd.as_ref().map(|_| control_socket.as_path()),
                    socket_cleanup,
                )
                .await;
            }
            Err(_) => {
                return finish_sidecar_start_failure(
                    optional_hooks_error_reason(
                        HooksUnavailableReason::Timeout,
                        V3LifecycleError::Timeout("hooks sidecar readiness".to_string()),
                    ),
                    Some(child),
                    group_leader,
                    process_group_id,
                    leader_pid,
                    &leader_start_token,
                    &process_record_path,
                    internal_hooksd.as_ref().map(|_| control_socket.as_path()),
                    socket_cleanup,
                )
                .await;
            }
            }
        }
    };
    if sidecar_cancellation_requested(cancel_rx.as_deref()) {
        // Readiness can arrive in the same poll as the supervisor stop. A
        // stop-requested startup must not adopt the sidecar or rewrite the
        // process record after the bounded stop path may have already removed
        // it; fall through to the in-memory failure cleanup instead.
        return finish_sidecar_start_failure(
            V3LifecycleError::HooksSidecarStartCancelled,
            Some(child),
            group_leader,
            process_group_id,
            leader_pid,
            &leader_start_token,
            &process_record_path,
            internal_hooksd.as_ref().map(|_| control_socket.as_path()),
            socket_cleanup,
        )
        .await;
    }
    let readiness_protocol = readiness.get("protocol").and_then(Value::as_str);
    if (readiness_protocol != Some("routecodex-hooks-supervisor/v1")
        && readiness_protocol != Some(RCC_HOOKS_SIDECAR_PROTOCOL))
        || readiness.get("ready").and_then(Value::as_bool) != Some(true)
    {
        return finish_sidecar_start_failure(
            optional_hooks_error_reason(
                HooksUnavailableReason::InvalidReadiness,
                V3LifecycleError::Validation(format!(
                    "hooks sidecar returned an invalid readiness record: {readiness}"
                )),
            ),
            Some(child),
            group_leader,
            process_group_id,
            leader_pid,
            &leader_start_token,
            &process_record_path,
            internal_hooksd.as_ref().map(|_| control_socket.as_path()),
            socket_cleanup,
        )
        .await;
    }
    if let Err(error) = record_codexapp_socket_startup_identity(&mut socket_cleanup) {
        return finish_sidecar_start_failure(
            optional_hooks_error(error),
            Some(child),
            group_leader,
            process_group_id,
            leader_pid,
            &leader_start_token,
            &process_record_path,
            internal_hooksd.as_ref().map(|_| control_socket.as_path()),
            socket_cleanup,
        )
        .await;
    }
    let control_socket_identity = internal_hooksd.as_ref().and_then(|_| {
        fs::symlink_metadata(&control_socket)
            .ok()
            .map(|metadata| codexapp_socket_identity(&metadata))
    });
    if internal_hooksd.is_some() {
        let mut record: V3HooksSidecarProcessRecord = match read_json(&process_record_path) {
            Ok(record) => record,
            Err(error) => {
                return finish_sidecar_start_failure(
                    optional_hooks_error(error),
                    Some(child),
                    group_leader,
                    process_group_id,
                    leader_pid,
                    &leader_start_token,
                    &process_record_path,
                    Some(control_socket.as_path()),
                    socket_cleanup,
                )
                .await;
            }
        };
        record.control_socket_identity = control_socket_identity;
        if let Err(error) = write_json_atomic(&process_record_path, &record) {
            return finish_sidecar_start_failure(
                optional_hooks_error(error),
                Some(child),
                group_leader,
                process_group_id,
                leader_pid,
                &leader_start_token,
                &process_record_path,
                Some(control_socket.as_path()),
                socket_cleanup,
            )
            .await;
        }
    }
    if internal_hooksd.is_none() {
        let mut record: V3HooksSidecarProcessRecord = match read_json(&process_record_path) {
            Ok(record) => record,
            Err(error) => {
                return finish_sidecar_start_failure(
                    optional_hooks_error(error),
                    Some(child),
                    group_leader,
                    process_group_id,
                    leader_pid,
                    &leader_start_token,
                    &process_record_path,
                    internal_hooksd.as_ref().map(|_| control_socket.as_path()),
                    socket_cleanup,
                )
                .await;
            }
        };
        record.codexapp_socket_cleanup = socket_cleanup.as_ref().map(Into::into);
        if let Err(error) = write_json_atomic(&process_record_path, &record) {
            return finish_sidecar_start_failure(
                optional_hooks_error(error),
                Some(child),
                group_leader,
                process_group_id,
                leader_pid,
                &leader_start_token,
                &process_record_path,
                internal_hooksd.as_ref().map(|_| control_socket.as_path()),
                socket_cleanup,
            )
            .await;
        }
    }
    tokio::spawn(async move {
        let mut lines = reader.lines();
        while lines.next_line().await.ok().flatten().is_some() {}
    });
    Ok(Some(V3HooksSidecarProcess {
        child,
        group_leader: Some(group_leader),
        process_group_id,
        leader_pid,
        leader_start_token,
        process_record_path,
        control_socket_path: internal_hooksd.as_ref().map(|_| control_socket.clone()),
        control_socket_identity,
        degraded_detail: None,
        socket_cleanup,
    }))
}

pub(crate) async fn start_managed_hooks_sidecar(
    instance_dir: &Path,
) -> Result<(Option<V3HooksSidecarProcess>, Option<String>), V3LifecycleError> {
    start_managed_hooks_sidecar_cancelable(instance_dir, None).await
}

async fn start_managed_hooks_sidecar_cancelable(
    instance_dir: &Path,
    cancel_rx: Option<&mut tokio::sync::watch::Receiver<bool>>,
) -> Result<(Option<V3HooksSidecarProcess>, Option<String>), V3LifecycleError> {
    match start_configured_hooks_sidecar_with_timeout_and_cancel(
        instance_dir,
        SIDECAR_START_TIMEOUT,
        cancel_rx,
    )
    .await
    {
        Ok(sidecar) => {
            let detail = sidecar
                .as_ref()
                .and_then(|sidecar| sidecar.degraded_detail.clone());
            Ok((sidecar, detail))
        }
        Err(V3LifecycleError::HooksSidecarStartCancelled) => {
            Err(V3LifecycleError::HooksSidecarStartCancelled)
        }
        Err(error @ V3LifecycleError::HooksOptionalUnavailable(_)) => {
            // Hooks are an optional integration. A broken hook supervisor
            // must not tear down the RouteCodex lifecycle control plane that
            // was already published by the caller. Keep the exact failure as
            // a running-status detail; the server remains usable and the
            // operator can restart hooks independently.
            Ok((None, Some(format!("hooks sidecar unavailable: {error}"))))
        }
        Err(error @ V3LifecycleError::HooksControlValidation(_)) => {
            // A stale or identity-mismatched hooks process record is a
            // hooks-sidecar problem, not a RouteCodex problem. The identity
            // check still refuses to signal a foreign process group; startup
            // degrades to `hooks_unavailable` instead of aborting the server.
            Ok((
                None,
                Some(format!(
                    "hooks sidecar unavailable: {}",
                    optional_hooks_error(error)
                )),
            ))
        }
        Err(error) => Err(error),
    }
}

fn optional_hooks_error(error: V3LifecycleError) -> V3LifecycleError {
    optional_hooks_error_reason(HooksUnavailableReason::Crashed, error)
}

fn optional_hooks_error_reason(
    reason: HooksUnavailableReason,
    error: V3LifecycleError,
) -> V3LifecycleError {
    V3LifecycleError::HooksOptionalUnavailable(format!("{}: {error}", hooks_unavailable(reason)))
}

fn optionalize_hooks_setup_error(error: V3LifecycleError) -> V3LifecycleError {
    match error {
        V3LifecycleError::HooksOptionalUnavailable(_) => error,
        error => optional_hooks_error(error),
    }
}

#[allow(clippy::too_many_arguments)]
async fn finish_sidecar_start_failure(
    startup: V3LifecycleError,
    mut child: Option<Child>,
    mut group_leader: Child,
    process_group_id: libc::pid_t,
    leader_pid: u32,
    leader_start_token: &str,
    process_record_path: &Path,
    control_socket_path: Option<&Path>,
    mut socket_cleanup: Option<CodexAppSocketCleanup>,
) -> Result<Option<V3HooksSidecarProcess>, V3LifecycleError> {
    let control_socket_identity = control_socket_path.and_then(|path| {
        fs::symlink_metadata(path)
            .ok()
            .map(|metadata| codexapp_socket_identity(&metadata))
    });
    if let Some(cleanup) = socket_cleanup.as_mut() {
        cleanup.startup_identity = match fs::symlink_metadata(&cleanup.path) {
            Ok(metadata) => Some(codexapp_socket_identity(&metadata)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => None,
        };
    }
    let termination = terminate_sidecar(
        child.as_mut(),
        &mut group_leader,
        process_group_id,
        leader_pid,
        leader_start_token,
    )
    .await;
    match termination {
        Ok(()) => {
            let mut cleanup_failure = None;
            if let Err(error) = remove_file_if_present(process_record_path) {
                cleanup_failure = Some(format!(
                    "hooks sidecar process record cleanup failed: {}; {error}",
                    process_record_path.display()
                ));
            }
            if let Some(control_socket_path) = control_socket_path {
                if let Some(identity) = control_socket_identity {
                    if let Err(error) = remove_file_if_identity_matches(control_socket_path, identity) {
                        let detail = format!(
                            "hooks sidecar control socket cleanup failed: {}; {error}",
                            control_socket_path.display()
                        );
                        cleanup_failure = Some(match cleanup_failure {
                            Some(existing) => format!("{existing}; {detail}"),
                            None => detail,
                        });
                    }
                } else if let Err(error) = remove_control_socket_if_present(control_socket_path) {
                    let detail = format!(
                        "hooks sidecar control socket cleanup failed: {}; {error}",
                        control_socket_path.display()
                    );
                    cleanup_failure = Some(match cleanup_failure {
                        Some(existing) => format!("{existing}; {detail}"),
                        None => detail,
                    });
                }
            }
            let socket_cleanup = socket_cleanup.as_ref().map(cleanup_codexapp_socket);
            if cleanup_failure.is_none() && socket_cleanup.as_ref().is_none_or(Result::is_ok) {
                return Err(startup);
            }
            let mut detail = startup.to_string();
            if let Some(cleanup_failure) = cleanup_failure {
                detail.push_str(&format!("; {cleanup_failure}"));
            }
            if let Some(Err(error)) = socket_cleanup {
                detail.push_str(&format!("; codexapp socket cleanup failed: {error}"));
            }
            Err(V3LifecycleError::Validation(detail))
        }
        Err(cleanup) => match child {
            Some(child) => Ok(Some(V3HooksSidecarProcess {
                child,
                group_leader: Some(group_leader),
                process_group_id,
                leader_pid,
                leader_start_token: leader_start_token.to_string(),
                process_record_path: process_record_path.to_path_buf(),
                control_socket_path: None,
                control_socket_identity: None,
                degraded_detail: Some(format!(
                    "hooks sidecar unavailable: {startup}; cleanup: {cleanup}"
                )),
                socket_cleanup,
            })),
            None => Err(V3LifecycleError::Validation(format!(
                "{startup}; hooks sidecar process-group owner cleanup failed before wrapper spawn: {cleanup}"
            ))),
        },
    }
}

impl V3HooksSidecarProcess {
    #[cfg(test)]
    pub(crate) fn for_test(
        child: Child,
        process_group_id: libc::pid_t,
        process_record_path: PathBuf,
    ) -> Self {
        Self {
            child,
            group_leader: None,
            process_group_id,
            leader_pid: process_group_id as u32,
            leader_start_token: process_start_token(process_group_id as u32)
                .ok()
                .flatten()
                .unwrap_or_default(),
            process_record_path,
            control_socket_path: None,
            control_socket_identity: None,
            degraded_detail: None,
            socket_cleanup: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test_with_owned_socket_cleanup(
        child: Child,
        process_group_id: libc::pid_t,
        process_record_path: PathBuf,
        socket_path: PathBuf,
        install_root: PathBuf,
    ) -> Self {
        let startup_identity = fs::symlink_metadata(&socket_path)
            .map(|metadata| codexapp_socket_identity(&metadata))
            .expect("test socket must exist");
        Self {
            child,
            group_leader: None,
            process_group_id,
            leader_pid: process_group_id as u32,
            leader_start_token: process_start_token(process_group_id as u32)
                .ok()
                .flatten()
                .unwrap_or_default(),
            process_record_path,
            control_socket_path: None,
            control_socket_identity: None,
            degraded_detail: Some("initial termination failed".to_string()),
            socket_cleanup: Some(CodexAppSocketCleanup {
                path: socket_path,
                install_root,
                pre_start_identity: None,
                startup_identity: Some(startup_identity),
            }),
        }
    }

    pub(crate) async fn stop(mut self) -> Result<(), V3LifecycleError> {
        if let Some(group_leader) = self.group_leader.as_mut() {
            terminate_sidecar(
                Some(&mut self.child),
                group_leader,
                self.process_group_id,
                self.leader_pid,
                &self.leader_start_token,
            )
            .await?;
        } else {
            // Test-only constructors model the pre-anchor process shape. The
            // production start path always stores the lifecycle-owned anchor.
            #[cfg(test)]
            terminate_sidecar_for_test(
                &mut self.child,
                self.process_group_id,
                self.leader_pid,
                &self.leader_start_token,
            )
            .await?;
            #[cfg(not(test))]
            return Err(V3LifecycleError::HooksControlValidation(
                "hooks sidecar has no lifecycle-owned process-group owner".to_string(),
            ));
        }
        if let Some(cleanup) = self.socket_cleanup.as_ref() {
            cleanup_codexapp_socket(cleanup)?;
        }
        if let Some(control_socket_path) = self.control_socket_path.as_ref() {
            match self.control_socket_identity {
                Some(identity) => remove_file_if_identity_matches(control_socket_path, identity)?,
                None => remove_control_socket_if_present(control_socket_path)?,
            }
        }
        if self.process_record_path.exists() {
            fs::remove_file(&self.process_record_path)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
