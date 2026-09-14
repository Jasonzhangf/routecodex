use super::*;
use serde_json::Value;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::process::Stdio;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::process::{Child, Command as TokioCommand};

const HOOKS_INSTALL_RECORD_ENV: &str = "ROUTECODEX_HOOKS_INSTALL_RECORD";
const HOOKS_INSTALL_RECORD_RELATIVE: &str = ".codex/routecodex-hooks/install.json";
pub(crate) const HOOKS_SIDECAR_PROCESS_FILE: &str = "hooks-sidecar.pid";
const SIDECAR_START_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct V3HooksSidecarProcessRecord {
    schema_version: u16,
    process_group_id: libc::pid_t,
    leader_pid: u32,
    leader_start_token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

pub(crate) struct V3HooksSidecarProcess {
    child: Child,
    group_leader: Option<Child>,
    process_group_id: libc::pid_t,
    leader_pid: u32,
    leader_start_token: String,
    process_record_path: PathBuf,
    degraded_detail: Option<String>,
    socket_cleanup: Option<CodexAppSocketCleanup>,
}

pub(crate) async fn start_configured_hooks_sidecar(
    instance_dir: &Path,
) -> Result<Option<V3HooksSidecarProcess>, V3LifecycleError> {
    let Some(record_path) = hooks_install_record_path().map_err(optional_hooks_error)? else {
        return Ok(None);
    };
    let record_bytes =
        fs::read(&record_path).map_err(|error| optional_hooks_error(error.into()))?;
    let record: Value = serde_json::from_slice(&record_bytes)
        .map_err(|error| optional_hooks_error(error.into()))?;
    if record.get("supervisor_enabled").and_then(Value::as_bool) != Some(true) {
        return Ok(None);
    }
    let process_record_path = instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    if process_record_path.exists() {
        if hooks_sidecar_process_group_is_alive(instance_dir)? {
            return Err(V3LifecycleError::HooksControlValidation(
                "hooks sidecar process group from a previous run is still alive".to_string(),
            ));
        }
        fs::remove_file(&process_record_path)?;
    }
    let wrapper = required_record_path(&record, "supervisor_wrapper", &record_path)
        .map_err(optional_hooks_error)?;
    let daemon_config = required_record_path(&record, "daemon_config", &record_path)
        .map_err(optional_hooks_error)?;
    let mut socket_cleanup = prepare_codexapp_socket_cleanup(&record, &daemon_config, &record_path)
        .map_err(optionalize_hooks_setup_error)?;
    let sidecar_stderr = stderr_capture(instance_dir).map_err(optional_hooks_error)?;
    let codexapp_binary =
        codexapp_binary_from_record(&record, &record_path).map_err(optional_hooks_error)?;
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
                socket_cleanup,
            )
            .await;
        }
    };
    let mut sidecar_command = TokioCommand::new(&wrapper);
    sidecar_command
        .arg("--config")
        .arg(&daemon_config)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // d7cb31f：sidecar stderr 落到实例目录诊断文件，退出原因可追溯
        //（此前 Stdio::null 吞掉了 codexapp AddrInUse 等全部失败原因）。
        .stderr(sidecar_stderr)
        // d7cb31f：supervisor 需要 internal codexapp 可执行文件路径；
        // lifecycle 从 install record 的 bin_directory 解析并注入，
        // 不再依赖外部 shell 预先导出 ROUTECODEX_V3_CODEXAPP_BINARY。
        .env("ROUTECODEX_V3_CODEXAPP_BINARY", codexapp_binary)
        // Join the lifecycle-owned process group; the anchor remains the
        // persisted identity even if this wrapper exits early.
        .process_group(process_group_id);
    let mut child = match sidecar_command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let startup = V3LifecycleError::Validation(format!(
                "hooks sidecar failed to spawn {}: {error}",
                wrapper.display()
            ));
            return finish_sidecar_start_failure(
                optional_hooks_error(startup),
                None,
                group_leader,
                process_group_id,
                leader_pid,
                &leader_start_token,
                &process_record_path,
                socket_cleanup,
            )
            .await;
        }
    };
    if let Err(error) = write_json_atomic(
        &process_record_path,
        &V3HooksSidecarProcessRecord {
            schema_version: SCHEMA_VERSION,
            process_group_id,
            leader_pid,
            leader_start_token: leader_start_token.clone(),
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
            socket_cleanup,
        )
        .await;
    };
    let mut reader = tokio::io::BufReader::new(stdout);
    let readiness = match tokio::time::timeout(
        SIDECAR_START_TIMEOUT,
        read_sidecar_readiness(&mut reader),
    )
    .await
    {
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
                socket_cleanup,
            )
            .await;
        }
        Err(_) => {
            return finish_sidecar_start_failure(
                optional_hooks_error(V3LifecycleError::Timeout(
                    "hooks sidecar readiness".to_string(),
                )),
                Some(child),
                group_leader,
                process_group_id,
                leader_pid,
                &leader_start_token,
                &process_record_path,
                socket_cleanup,
            )
            .await;
        }
    };
    if readiness.get("protocol").and_then(Value::as_str) != Some("routecodex-hooks-supervisor/v1")
        || readiness.get("ready").and_then(Value::as_bool) != Some(true)
    {
        return finish_sidecar_start_failure(
            optional_hooks_error(V3LifecycleError::Validation(
                "hooks sidecar returned an invalid readiness record".to_string(),
            )),
            Some(child),
            group_leader,
            process_group_id,
            leader_pid,
            &leader_start_token,
            &process_record_path,
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
            socket_cleanup,
        )
        .await;
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
        degraded_detail: None,
        socket_cleanup,
    }))
}

pub(crate) async fn start_managed_hooks_sidecar(
    instance_dir: &Path,
) -> Result<(Option<V3HooksSidecarProcess>, Option<String>), V3LifecycleError> {
    match start_configured_hooks_sidecar(instance_dir).await {
        Ok(sidecar) => {
            let detail = sidecar
                .as_ref()
                .and_then(|sidecar| sidecar.degraded_detail.clone());
            Ok((sidecar, detail))
        }
        Err(ref error @ V3LifecycleError::HooksControlValidation(ref message))
            if message.contains("identity mismatch")
                || message.contains("identity no longer matches") =>
        {
            Ok((None, Some(format!("hooks sidecar unavailable: {error}"))))
        }
        Err(error @ V3LifecycleError::HooksOptionalUnavailable(_)) => {
            // Hooks are an optional integration. A broken hook supervisor
            // must not tear down the RouteCodex lifecycle control plane that
            // was already published by the caller. Keep the exact failure as
            // a running-status detail; the server remains usable and the
            // operator can restart hooks independently.
            Ok((None, Some(format!("hooks sidecar unavailable: {error}"))))
        }
        Err(error) => Err(error),
    }
}

fn optional_hooks_error(error: V3LifecycleError) -> V3LifecycleError {
    V3LifecycleError::HooksOptionalUnavailable(error.to_string())
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
    mut socket_cleanup: Option<CodexAppSocketCleanup>,
) -> Result<Option<V3HooksSidecarProcess>, V3LifecycleError> {
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
            let record_cleanup = fs::remove_file(process_record_path)
                .ok()
                .or_else(|| (!process_record_path.exists()).then_some(()));
            let socket_cleanup = socket_cleanup.as_ref().map(cleanup_codexapp_socket);
            if record_cleanup.is_some() && socket_cleanup.as_ref().is_none_or(Result::is_ok) {
                return Err(startup);
            }
            let mut detail = startup.to_string();
            if record_cleanup.is_none() {
                detail.push_str(&format!(
                    "; hooks sidecar process record cleanup failed: {}",
                    process_record_path.display()
                ));
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
        if self.process_record_path.exists() {
            fs::remove_file(&self.process_record_path)?;
        }
        Ok(())
    }
}

async fn read_sidecar_readiness(
    stdout: &mut (impl AsyncBufRead + Unpin),
) -> Result<Value, V3LifecycleError> {
    let mut line = String::new();
    let read = stdout.read_line(&mut line).await?;
    if read == 0 {
        return Err(V3LifecycleError::Validation(
            "hooks sidecar exited before readiness".to_string(),
        ));
    }
    let line = line.trim_end_matches(['\r', '\n']);
    if line.is_empty() {
        return Err(V3LifecycleError::Validation(
            "hooks sidecar emitted an empty readiness record".to_string(),
        ));
    }
    Ok(serde_json::from_str(line)?)
}

async fn terminate_sidecar(
    mut child: Option<&mut Child>,
    group_leader: &mut Child,
    process_group_id: libc::pid_t,
    leader_pid: u32,
    leader_start_token: &str,
) -> Result<(), V3LifecycleError> {
    if process_group_id <= 0 {
        return Err(V3LifecycleError::Validation(
            "hooks sidecar process group id is invalid".to_string(),
        ));
    }
    let mut leader_reaped = group_leader.try_wait()?.is_some();
    validate_active_process_group_identity(
        group_leader,
        process_group_id,
        leader_pid,
        leader_start_token,
        &mut leader_reaped,
    )?;
    signal_process_group(process_group_id, libc::SIGTERM)?;
    if wait_for_sidecar_graceful_shutdown(
        &mut child,
        group_leader,
        process_group_id,
        leader_pid,
        leader_start_token,
        &mut leader_reaped,
    )
    .await?
    {
        return Ok(());
    }

    validate_active_process_group_identity(
        group_leader,
        process_group_id,
        leader_pid,
        leader_start_token,
        &mut leader_reaped,
    )?;
    signal_process_group(process_group_id, libc::SIGKILL)?;
    if wait_for_process_group_shutdown(
        &mut child,
        group_leader,
        process_group_id,
        &mut leader_reaped,
    )
    .await?
    {
        return Ok(());
    }
    Err(V3LifecycleError::Timeout(format!(
        "hooks sidecar forced stop process group {process_group_id}"
    )))
}

fn signal_process(process_id: u32, signal: libc::c_int) -> Result<(), V3LifecycleError> {
    let result = unsafe { libc::kill(process_id as libc::pid_t, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(V3LifecycleError::Io(error))
}

async fn wait_for_sidecar_graceful_shutdown(
    child: &mut Option<&mut Child>,
    group_leader: &mut Child,
    process_group_id: libc::pid_t,
    leader_pid: u32,
    leader_start_token: &str,
    leader_reaped: &mut bool,
) -> Result<bool, V3LifecycleError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut child_reaped = child.is_none();
    loop {
        if !child_reaped {
            if let Some(wrapper) = child.as_deref_mut() {
                if wrapper.try_wait()?.is_some() {
                    child_reaped = true;
                }
            }
        }
        if !*leader_reaped && group_leader.try_wait()?.is_some() {
            *leader_reaped = true;
        }
        if *leader_reaped {
            return Ok(!process_group_exists(process_group_id)?);
        }
        if child_reaped && process_group_contains_only_leader(process_group_id, leader_pid)? {
            validate_active_process_group_identity(
                group_leader,
                process_group_id,
                leader_pid,
                leader_start_token,
                leader_reaped,
            )?;
            signal_process(leader_pid, libc::SIGUSR1)?;
            return wait_for_process_group_shutdown(
                child,
                group_leader,
                process_group_id,
                leader_reaped,
            )
            .await;
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn process_group_contains_only_leader(
    process_group_id: libc::pid_t,
    leader_pid: u32,
) -> Result<bool, V3LifecycleError> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,pgid="])
        .output()
        .map_err(|error| {
            V3LifecycleError::Validation(format!(
                "cannot inspect hooks sidecar process group {process_group_id}: {error}"
            ))
        })?;
    if !output.status.success() {
        return Err(V3LifecycleError::Validation(format!(
            "cannot inspect hooks sidecar process group {process_group_id}: ps exited with {}",
            output.status
        )));
    }
    let mut found_leader = false;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let Some(pid) = fields.next() else {
            continue;
        };
        let Some(pgid) = fields.next() else {
            return Err(V3LifecycleError::Validation(
                "cannot parse hooks sidecar process-group inspection output".to_string(),
            ));
        };
        let pid: u32 = pid.parse().map_err(|_| {
            V3LifecycleError::Validation(
                "cannot parse hooks sidecar process-group member PID".to_string(),
            )
        })?;
        let pgid: libc::pid_t = pgid.parse().map_err(|_| {
            V3LifecycleError::Validation(
                "cannot parse hooks sidecar process-group member PGID".to_string(),
            )
        })?;
        if pgid != process_group_id {
            continue;
        }
        if pid == leader_pid {
            found_leader = true;
        } else {
            return Ok(false);
        }
    }
    Ok(found_leader)
}

#[cfg(test)]
async fn terminate_sidecar_for_test(
    child: &mut Child,
    process_group_id: libc::pid_t,
    leader_pid: u32,
    leader_start_token: &str,
) -> Result<(), V3LifecycleError> {
    if process_group_id <= 0 {
        return Err(V3LifecycleError::Validation(
            "hooks sidecar process group id is invalid".to_string(),
        ));
    }
    let mut child_reaped = child.try_wait()?.is_some();
    validate_active_process_group_identity_for_test(
        child,
        process_group_id,
        leader_pid,
        leader_start_token,
        &mut child_reaped,
    )?;
    signal_process_group(process_group_id, libc::SIGTERM)?;
    if wait_for_process_group_shutdown_for_test(child, process_group_id, &mut child_reaped).await? {
        return Ok(());
    }
    validate_active_process_group_identity_for_test(
        child,
        process_group_id,
        leader_pid,
        leader_start_token,
        &mut child_reaped,
    )?;
    signal_process_group(process_group_id, libc::SIGKILL)?;
    if wait_for_process_group_shutdown_for_test(child, process_group_id, &mut child_reaped).await? {
        return Ok(());
    }
    Err(V3LifecycleError::Timeout(format!(
        "hooks sidecar forced stop process group {process_group_id}"
    )))
}

fn signal_process_group(
    process_group_id: libc::pid_t,
    signal: libc::c_int,
) -> Result<(), V3LifecycleError> {
    let result = unsafe { libc::kill(-process_group_id, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(V3LifecycleError::Io(error))
}

fn process_group_exists(process_group_id: libc::pid_t) -> Result<bool, V3LifecycleError> {
    let result = unsafe { libc::kill(-process_group_id, 0) };
    if result == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    if error.raw_os_error() == Some(libc::EPERM) {
        return Ok(true);
    }
    Err(V3LifecycleError::Io(error))
}

fn validate_process_group_identity(
    process_group_id: libc::pid_t,
    leader_pid: u32,
    leader_start_token: &str,
) -> Result<(), V3LifecycleError> {
    if leader_pid == 0 || leader_start_token.is_empty() {
        return Err(V3LifecycleError::HooksControlValidation(
            "hooks sidecar process-group identity is incomplete".to_string(),
        ));
    }
    if process_start_token(leader_pid)?.as_deref() != Some(leader_start_token) {
        return Err(V3LifecycleError::HooksControlValidation(format!(
            "hooks sidecar process-group identity no longer matches leader PID {leader_pid}"
        )));
    }
    if unsafe { libc::getpgid(leader_pid as libc::pid_t) } != process_group_id {
        return Err(V3LifecycleError::HooksControlValidation(format!(
            "hooks sidecar leader PID {leader_pid} is not in process group {process_group_id}"
        )));
    }
    Ok(())
}

fn validate_active_process_group_identity(
    group_leader: &mut Child,
    process_group_id: libc::pid_t,
    leader_pid: u32,
    leader_start_token: &str,
    leader_reaped: &mut bool,
) -> Result<(), V3LifecycleError> {
    let identity =
        validate_process_group_identity(process_group_id, leader_pid, leader_start_token);
    match identity {
        Ok(()) => Ok(()),
        Err(error) => {
            if !*leader_reaped && group_leader.try_wait()?.is_some() {
                *leader_reaped = true;
            }
            if !*leader_reaped {
                // A token probe can fail before the process record is
                // persisted. The exact anchor Child plus a matching PGID is
                // sufficient for this one in-memory startup cleanup attempt.
                if leader_start_token.is_empty()
                    && unsafe { libc::getpgid(leader_pid as libc::pid_t) } == process_group_id
                {
                    return Ok(());
                }
                return Err(error);
            }
            // Once the exact anchor has been reaped, a live numeric PGID may
            // belong to an unrelated process group. Only a fully vanished
            // group is safe to treat as already cleaned up.
            if process_group_exists(process_group_id)? {
                return Err(error);
            }
            Ok(())
        }
    }
}

#[cfg(test)]
fn validate_active_process_group_identity_for_test(
    child: &mut Child,
    process_group_id: libc::pid_t,
    leader_pid: u32,
    leader_start_token: &str,
    child_reaped: &mut bool,
) -> Result<(), V3LifecycleError> {
    let identity =
        validate_process_group_identity(process_group_id, leader_pid, leader_start_token);
    match identity {
        Ok(()) => Ok(()),
        Err(error) => {
            // The leader can exit between the initial try_wait and the
            // identity probe. Re-check the exact in-memory Child handle
            // before using the captured process-group identity.
            if !*child_reaped && child.try_wait()?.is_some() {
                *child_reaped = true;
            }
            if !*child_reaped {
                // A start-token probe can fail before the process record is
                // persisted. While the exact Child handle still reports the
                // leader alive, its captured PID plus PGID is sufficient for
                // this one in-memory cleanup attempt; a persisted record
                // never uses this path and still requires the token.
                if leader_start_token.is_empty()
                    && unsafe { libc::getpgid(leader_pid as libc::pid_t) } == process_group_id
                {
                    return Ok(());
                }
                return Err(error);
            }
            // The in-memory Child handle proves this is the group whose leader
            // just exited during this cleanup attempt. Do not probe the
            // reaped leader PID with kill(0): on macOS it can remain
            // observable briefly even though the Child handle has already
            // reaped that exact process. A stale persisted record never takes
            // this branch; it must retain the strict leader-token check above.
            let _ = process_group_exists(process_group_id)?;
            Ok(())
        }
    }
}

pub(crate) fn hooks_sidecar_process_group_is_alive(
    instance_dir: &Path,
) -> Result<bool, V3LifecycleError> {
    let path = instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    if !path.exists() {
        return Ok(false);
    }
    let record: V3HooksSidecarProcessRecord = read_json(&path).map_err(|error| {
        V3LifecycleError::HooksControlValidation(format!(
            "invalid hooks sidecar process record: {}; {error}",
            path.display()
        ))
    })?;
    if record.schema_version != SCHEMA_VERSION || record.process_group_id <= 0 {
        return Err(V3LifecycleError::HooksControlValidation(format!(
            "invalid hooks sidecar process record: {}",
            path.display()
        )));
    }
    // A dead group makes the persisted record stale. Check this before the
    // leader token: the leader may have exited and its PID may now be absent,
    // which is safe to reap. If the group still exists, retain the strict
    // leader-token and PGID checks so a reused PGID cannot be signaled.
    if !process_group_exists(record.process_group_id)? {
        return Ok(false);
    }
    validate_process_group_identity(
        record.process_group_id,
        record.leader_pid,
        &record.leader_start_token,
    )?;
    Ok(true)
}

async fn wait_for_process_group_shutdown(
    child: &mut Option<&mut Child>,
    group_leader: &mut Child,
    process_group_id: libc::pid_t,
    leader_reaped: &mut bool,
) -> Result<bool, V3LifecycleError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut child_reaped = child.is_none();
    loop {
        if !child_reaped {
            if let Some(wrapper) = child.as_deref_mut() {
                if wrapper.try_wait()?.is_some() {
                    child_reaped = true;
                }
            }
        }
        if !*leader_reaped && group_leader.try_wait()?.is_some() {
            *leader_reaped = true;
        }
        if child_reaped && *leader_reaped && !process_group_exists(process_group_id)? {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(test)]
async fn wait_for_process_group_shutdown_for_test(
    child: &mut Child,
    process_group_id: libc::pid_t,
    child_reaped: &mut bool,
) -> Result<bool, V3LifecycleError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if !*child_reaped && child.try_wait()?.is_some() {
            *child_reaped = true;
        }
        if *child_reaped && !process_group_exists(process_group_id)? {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn hooks_install_record_path() -> Result<Option<PathBuf>, V3LifecycleError> {
    let path = match std::env::var_os(HOOKS_INSTALL_RECORD_ENV) {
        Some(path) => PathBuf::from(path),
        None => {
            let Some(home) = std::env::var_os("HOME") else {
                return Ok(None);
            };
            PathBuf::from(home).join(HOOKS_INSTALL_RECORD_RELATIVE)
        }
    };
    if path.exists() {
        Ok(Some(fs::canonicalize(path)?))
    } else {
        Ok(None)
    }
}

fn required_record_path(
    record: &Value,
    field: &str,
    record_path: &Path,
) -> Result<PathBuf, V3LifecycleError> {
    let value = record.get(field).and_then(Value::as_str).ok_or_else(|| {
        V3LifecycleError::Validation(format!(
            "hooks install record {} is missing {field}",
            record_path.display()
        ))
    })?;
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record {field} must be absolute"
        )));
    }
    if !path.exists() {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record {field} does not exist: {}",
            path.display()
        )));
    }
    Ok(path)
}

// d7cb31f：sidecar 失败时清理 codexapp unix socket——残留 socket 会让
// 后续所有 restart 因 AddrInUse 失败（孤儿进程终止后 socket 文件仍在）。
fn prepare_codexapp_socket_cleanup(
    record: &Value,
    daemon_config: &Path,
    record_path: &Path,
) -> Result<Option<CodexAppSocketCleanup>, V3LifecycleError> {
    let Some(socket) = routecodex_v3_config::read_v3_daemon_codexapp_socket(daemon_config)? else {
        return Ok(None);
    };
    let path = PathBuf::from(socket);
    if !path.is_absolute() {
        return Err(V3LifecycleError::Validation(
            "hooks daemon codexapp.socket must be absolute".to_string(),
        ));
    }
    let install_root = required_record_path(record, "install_root", record_path)?;
    validate_install_owned_socket_path(&path, &install_root)?;
    let pre_start_identity = match fs::symlink_metadata(&path) {
        Ok(metadata) => Some(codexapp_socket_identity(&metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(V3LifecycleError::Io(error)),
    };
    Ok(Some(CodexAppSocketCleanup {
        path,
        install_root,
        pre_start_identity,
        startup_identity: None,
    }))
}

fn cleanup_codexapp_socket(cleanup: &CodexAppSocketCleanup) -> Result<(), V3LifecycleError> {
    validate_install_owned_socket_path(&cleanup.path, &cleanup.install_root)?;
    let metadata = match fs::symlink_metadata(&cleanup.path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(V3LifecycleError::Io(error)),
    };
    let identity = codexapp_socket_identity(&metadata);
    if cleanup.pre_start_identity == Some(identity) {
        // The startup attempt did not replace the previous/shared entry.
        return Ok(());
    }
    if !identity.is_socket {
        return Err(V3LifecycleError::Validation(format!(
            "refusing to remove non-socket codexapp path: {}",
            cleanup.path.display()
        )));
    }
    if cleanup.startup_identity != Some(identity) {
        return Err(V3LifecycleError::Validation(format!(
            "refusing to remove codexapp socket with unverified startup identity: {}",
            cleanup.path.display()
        )));
    }
    fs::remove_file(&cleanup.path)?;
    Ok(())
}

fn record_codexapp_socket_startup_identity(
    cleanup: &mut Option<CodexAppSocketCleanup>,
) -> Result<(), V3LifecycleError> {
    let Some(cleanup) = cleanup.as_mut() else {
        return Ok(());
    };
    cleanup.startup_identity = match fs::symlink_metadata(&cleanup.path) {
        Ok(metadata) => Some(codexapp_socket_identity(&metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(V3LifecycleError::Io(error)),
    };
    Ok(())
}

fn codexapp_socket_identity(metadata: &fs::Metadata) -> CodexAppSocketIdentity {
    CodexAppSocketIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        is_socket: metadata.file_type().is_socket(),
    }
}

fn validate_install_owned_socket_path(
    socket_path: &Path,
    install_root: &Path,
) -> Result<(), V3LifecycleError> {
    let canonical_root = fs::canonicalize(install_root)?;
    let parent = socket_path.parent().ok_or_else(|| {
        V3LifecycleError::Validation(format!(
            "codexapp socket has no parent directory: {}",
            socket_path.display()
        ))
    })?;
    let canonical_parent = fs::canonicalize(parent)?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(V3LifecycleError::Validation(format!(
            "codexapp socket is outside hooks install root: {}",
            socket_path.display()
        )));
    }
    Ok(())
}

// d7cb31f：internal codexapp 可执行文件路径由 lifecycle 从 install record
// 解析并注入 supervisor，不再依赖外部 shell 导出 ROUTECODEX_V3_CODEXAPP_BINARY。
fn codexapp_binary_from_record(
    record: &Value,
    record_path: &Path,
) -> Result<std::path::PathBuf, V3LifecycleError> {
    let _install_root = required_record_path(record, "install_root", record_path)?;
    let bin_directory = record
        .get("bin_directory")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            V3LifecycleError::Validation(format!(
                "hooks install record {} has no bin_directory",
                record_path.display()
            ))
        })?;
    let bin_directory = std::path::Path::new(bin_directory);
    if !bin_directory.is_absolute() {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record bin_directory must be absolute"
        )));
    }
    let canonical_bin_directory = fs::canonicalize(bin_directory).map_err(|error| {
        V3LifecycleError::Validation(format!(
            "hooks install record bin_directory {} cannot be resolved: {error}",
            bin_directory.display()
        ))
    })?;
    if !canonical_bin_directory.is_dir() {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record bin_directory is not a directory: {}",
            bin_directory.display()
        )));
    }
    let candidate = canonical_bin_directory.join("rccv3-codexapp");
    let canonical_candidate = fs::canonicalize(&candidate).map_err(|error| {
        V3LifecycleError::Validation(format!(
            "hooks install record {} requires installed internal codexapp binary at {}: {error}",
            record_path.display(),
            candidate.display()
        ))
    })?;
    if !canonical_candidate.starts_with(&canonical_bin_directory) || !canonical_candidate.is_file()
    {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record {} requires internal codexapp binary inside bin_directory at {}",
            record_path.display(),
            canonical_candidate.display()
        )));
    }
    Ok(canonical_candidate)
}

// d7cb31f：sidecar stderr 落到实例目录诊断文件，退出原因可追溯。
fn stderr_capture(instance_dir: &Path) -> Result<Stdio, V3LifecycleError> {
    let path = instance_dir.join("hooks-sidecar.stderr.log");
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| {
            V3LifecycleError::Validation(format!(
                "hooks sidecar stderr capture {} unavailable: {error}",
                path.display()
            ))
        })?;
    Ok(Stdio::from(file))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;
    use tempfile::TempDir;

    #[cfg(unix)]
    static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[tokio::test]
    #[cfg(unix)]
    async fn ready_hooks_sidecar_stop_removes_only_startup_owned_codexapp_socket() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let root = TempDir::new_in("/tmp").unwrap();
        let instance_dir = root.path().join("instance");
        let record_path = root.path().join("install.json");
        let daemon_config = root.path().join("hooksd.json");
        let supervisor_wrapper = root.path().join("supervisor-wrapper");
        let bin_directory = root.path().join("bin");
        let socket_path = root.path().join("codexapp.sock");
        fs::create_dir(&instance_dir).unwrap();
        fs::create_dir(&bin_directory).unwrap();
        fs::write(bin_directory.join("rccv3-codexapp"), "").unwrap();
        fs::write(
            &daemon_config,
            serde_json::json!({"codexapp": {"socket": socket_path}}).to_string(),
        )
        .unwrap();
        fs::write(
            &supervisor_wrapper,
            format!(
                "#!/bin/sh\nexec node -e 'const net=require(\"net\"); const server=net.createServer(); server.listen(process.argv[1], () => {{ process.stdout.write(JSON.stringify({{protocol: \"routecodex-hooks-supervisor/v1\", ready: true}})+\"\\n\"); }}); setInterval(() => {{}}, 1000);' '{}'\n",
                socket_path.display()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&supervisor_wrapper).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&supervisor_wrapper, permissions).unwrap();
        fs::write(
            &record_path,
            serde_json::json!({
                "supervisor_enabled": true,
                "supervisor_wrapper": supervisor_wrapper,
                "daemon_config": daemon_config,
                "bin_directory": bin_directory,
                "install_root": root.path(),
            })
            .to_string(),
        )
        .unwrap();
        std::env::set_var(HOOKS_INSTALL_RECORD_ENV, &record_path);

        let sidecar = start_configured_hooks_sidecar(&instance_dir)
            .await
            .unwrap()
            .expect("enabled test sidecar must start");
        assert!(socket_path.exists());

        sidecar.stop().await.unwrap();

        assert!(!socket_path.exists());
        std::env::remove_var(HOOKS_INSTALL_RECORD_ENV);
    }

    #[test]
    #[cfg(unix)]
    fn replaced_codexapp_socket_is_removed_but_original_identity_is_preserved() {
        let root = TempDir::new_in("/tmp").unwrap();
        let socket_path = root.path().join("codexapp.sock");
        let original = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
        let pre_start_identity =
            codexapp_socket_identity(&fs::symlink_metadata(&socket_path).unwrap());
        drop(original);
        fs::remove_file(&socket_path).unwrap();
        let replacement = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
        let startup_identity =
            codexapp_socket_identity(&fs::symlink_metadata(&socket_path).unwrap());
        assert_ne!(pre_start_identity, startup_identity);

        cleanup_codexapp_socket(&CodexAppSocketCleanup {
            path: socket_path.clone(),
            install_root: root.path().to_path_buf(),
            pre_start_identity: Some(pre_start_identity),
            startup_identity: Some(startup_identity),
        })
        .unwrap();

        drop(replacement);
        assert!(!socket_path.exists());
    }

    #[test]
    #[cfg(unix)]
    fn codexapp_binary_from_record_accepts_installer_bin_directory_and_rejects_escape() {
        let root = TempDir::new_in("/tmp").unwrap();
        let install_root = root.path().join("install");
        let inside_bin = install_root.join("bin");
        let outside_bin = root.path().join("outside-bin");
        fs::create_dir_all(&inside_bin).unwrap();
        fs::create_dir_all(&outside_bin).unwrap();
        fs::write(inside_bin.join("rccv3-codexapp"), "").unwrap();
        fs::write(outside_bin.join("rccv3-codexapp"), "").unwrap();
        let record_path = root.path().join("install.json");
        let install_root_value = serde_json::json!(install_root);

        let relative = serde_json::json!({
            "install_root": install_root_value,
            "bin_directory": "install/bin"
        });
        let relative_error = codexapp_binary_from_record(&relative, &record_path)
            .expect_err("relative bin directory must be rejected");
        assert!(relative_error
            .to_string()
            .contains("bin_directory must be absolute"));

        let installer_layout = serde_json::json!({
            "install_root": install_root,
            "bin_directory": outside_bin
        });
        let resolved = codexapp_binary_from_record(&installer_layout, &record_path).unwrap();
        assert_eq!(
            resolved,
            fs::canonicalize(outside_bin.join("rccv3-codexapp")).unwrap()
        );

        let symlink_bin = root.path().join("symlink-bin");
        let escaped_binary = root.path().join("escaped-rccv3-codexapp");
        fs::create_dir_all(&symlink_bin).unwrap();
        fs::write(&escaped_binary, "").unwrap();
        std::os::unix::fs::symlink(&escaped_binary, symlink_bin.join("rccv3-codexapp")).unwrap();
        let escaped = serde_json::json!({
            "install_root": root.path(),
            "bin_directory": symlink_bin
        });
        let escaped_error = codexapp_binary_from_record(&escaped, &record_path)
            .expect_err("codexapp symlink must not escape the declared bin directory");
        assert!(escaped_error.to_string().contains("inside bin_directory"));
    }

    #[test]
    #[cfg(unix)]
    fn dead_persisted_hooks_group_is_reapable_after_leader_exit() {
        let root = TempDir::new().unwrap();
        let instance_dir = root.path().join("instance");
        fs::create_dir(&instance_dir).unwrap();
        let mut child = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let process_group_id = child.id() as libc::pid_t;
        let leader_start_token = process_start_token(process_group_id as u32)
            .unwrap()
            .unwrap();
        assert_eq!(unsafe { libc::kill(-process_group_id, libc::SIGKILL) }, 0);
        child.wait().unwrap();
        fs::write(
            instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE),
            serde_json::json!({
                "schema_version": SCHEMA_VERSION,
                "process_group_id": process_group_id,
                "leader_pid": process_group_id,
                "leader_start_token": leader_start_token,
            })
            .to_string(),
        )
        .unwrap();

        assert!(!hooks_sidecar_process_group_is_alive(&instance_dir).unwrap());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn active_cleanup_uses_child_handle_when_start_token_is_missing() {
        let mut group_leader = TokioCommand::new("/bin/sh")
            .arg("-c")
            .arg("trap '' TERM INT; trap 'exit 0' USR1; read -r line")
            .stdin(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let process_group_id = group_leader.id().unwrap() as libc::pid_t;
        let mut child = TokioCommand::new("/bin/sh")
            .arg("-c")
            .arg("while :; do /bin/sleep 60; done")
            .process_group(process_group_id)
            .spawn()
            .unwrap();

        terminate_sidecar(
            Some(&mut child),
            &mut group_leader,
            process_group_id,
            process_group_id as u32,
            "",
        )
        .await
        .unwrap();

        assert_eq!(unsafe { libc::kill(-process_group_id, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn anchor_identity_mismatch_never_signals_live_process_group() {
        let mut group_leader = TokioCommand::new("/bin/sh")
            .arg("-c")
            .arg("trap '' TERM INT; trap 'exit 0' USR1; read -r line")
            .stdin(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let process_group_id = group_leader.id().unwrap() as libc::pid_t;
        let leader_start_token = process_start_token(process_group_id as u32)
            .unwrap()
            .unwrap();
        let mut child = TokioCommand::new("/bin/sh")
            .arg("-c")
            .arg("while :; do /bin/sleep 60; done")
            .process_group(process_group_id)
            .spawn()
            .unwrap();

        let error = terminate_sidecar(
            Some(&mut child),
            &mut group_leader,
            process_group_id,
            process_group_id as u32,
            "not-the-anchor-token",
        )
        .await
        .unwrap_err();
        assert!(matches!(error, V3LifecycleError::HooksControlValidation(_)));
        assert_eq!(unsafe { libc::kill(-process_group_id, 0) }, 0);

        terminate_sidecar(
            Some(&mut child),
            &mut group_leader,
            process_group_id,
            process_group_id as u32,
            &leader_start_token,
        )
        .await
        .unwrap();
    }
}
