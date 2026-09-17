use super::*;

pub(super) fn remove_file_if_present(path: &Path) -> Result<(), V3LifecycleError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn remove_file_if_identity_matches(
    path: &Path,
    identity: CodexAppSocketIdentity,
) -> Result<(), V3LifecycleError> {
    if !identity.is_socket {
        // A persisted record can only authorize removal of a socket. A
        // non-socket identity must never turn a metadata match into a file
        // deletion.
        return Ok(());
    }
    let current = match fs::symlink_metadata(path) {
        Ok(metadata) => codexapp_socket_identity(&metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !current.is_socket || current != identity {
        return Ok(());
    }
    remove_file_if_present(path)
}

pub(super) async fn read_sidecar_readiness(
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

pub(super) async fn terminate_sidecar(
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
pub(super) async fn terminate_sidecar_for_test(
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

pub(crate) fn hooks_sidecar_cleanup_incomplete_detail(instance_dir: &Path) -> Option<String> {
    let path = instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    if !path.exists() {
        return None;
    }
    match hooks_sidecar_process_group_is_alive(instance_dir) {
        Ok(true) => Some(
            "hooks sidecar cleanup incomplete: owned process group remains alive; process record preserved"
                .to_string(),
        ),
        Ok(false) => None,
        Err(error) => Some(format!(
            "hooks sidecar cleanup incomplete: {error}; process record preserved"
        )),
    }
}

// Bounded synchronous cleanup used when the supervisor task does not finish
// its own stop in time. It re-reads the persisted identity and refuses to
// signal a group that no longer matches, so a reused PGID can never be killed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ForcedSidecarCleanup {
    RecordRemoved,
    RecordPreserved,
}

pub(super) async fn force_terminate_sidecar_by_record(
    instance_dir: &Path,
) -> Result<ForcedSidecarCleanup, V3LifecycleError> {
    let path = instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    if !path.exists() {
        return Ok(ForcedSidecarCleanup::RecordRemoved);
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
    if !process_group_exists(record.process_group_id)? {
        return finish_forced_sidecar_cleanup(instance_dir, &path, &record);
    }
    validate_process_group_identity(
        record.process_group_id,
        record.leader_pid,
        &record.leader_start_token,
    )?;
    signal_process_group(record.process_group_id, libc::SIGKILL)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if !process_group_exists(record.process_group_id)? {
            return finish_forced_sidecar_cleanup(instance_dir, &path, &record);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(V3LifecycleError::Timeout(format!(
                "hooks sidecar forced stop process group {}",
                record.process_group_id
            )));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// The persisted record is the only identity source once the supervisor task is
// gone, so the internal control socket must be removed with that identity
// before the record is deleted. The dead-group fast path runs the same cleanup
// as the post-SIGKILL path; otherwise a sidecar that exited first would leave
// `hooks-sidecar.sock` behind with no record to verify it on the next start.
fn finish_forced_sidecar_cleanup(
    instance_dir: &Path,
    record_path: &Path,
    record: &V3HooksSidecarProcessRecord,
) -> Result<ForcedSidecarCleanup, V3LifecycleError> {
    let control_socket = instance_dir.join("hooks-sidecar.sock");
    match record.control_socket_identity {
        Some(identity) => remove_file_if_identity_matches(&control_socket, identity)?,
        None if control_socket_exists_as_socket(&control_socket)? => {
            // The process record was persisted before the startup owner could
            // store the control-socket identity. Deleting the record here
            // would orphan a socket that can no longer be verified, so keep
            // the record: the startup owner or the next lifecycle owner
            // completes the identity-checked cleanup.
            return Ok(ForcedSidecarCleanup::RecordPreserved);
        }
        None => {}
    }
    if let Some(cleanup) = record.codexapp_socket_cleanup.as_ref() {
        cleanup_codexapp_socket(&cleanup.into())?;
    }
    remove_file_if_present(record_path)?;
    Ok(ForcedSidecarCleanup::RecordRemoved)
}

fn control_socket_exists_as_socket(path: &Path) -> Result<bool, V3LifecycleError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_socket()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn remove_control_socket_if_present(path: &Path) -> Result<(), V3LifecycleError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_socket() => remove_file_if_present(path),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
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

pub(super) fn hooks_install_record_path() -> Result<Option<PathBuf>, V3LifecycleError> {
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

// d7cb31f：sidecar 失败时清理 codexapp unix socket——残留 socket 会让
// 后续所有 restart 因 AddrInUse 失败（孤儿进程终止后 socket 文件仍在）。
pub(super) fn prepare_codexapp_socket_cleanup(
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

pub(super) fn cleanup_codexapp_socket(
    cleanup: &CodexAppSocketCleanup,
) -> Result<(), V3LifecycleError> {
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

pub(super) fn record_codexapp_socket_startup_identity(
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

pub(super) fn codexapp_socket_identity(metadata: &fs::Metadata) -> CodexAppSocketIdentity {
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

// d7cb31f：sidecar stderr 落到实例目录诊断文件，退出原因可追溯。
pub(super) fn stderr_capture(instance_dir: &Path) -> Result<Stdio, V3LifecycleError> {
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
