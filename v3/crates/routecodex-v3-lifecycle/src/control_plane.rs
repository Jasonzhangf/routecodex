use super::*;

pub(crate) fn read_live_status_detail(
    instance_dir: &Path,
    instance_id: &str,
) -> Result<Option<String>, V3LifecycleError> {
    let status_path = instance_dir.join("status.json");
    if !status_path.exists() {
        return Ok(None);
    }
    let status: V3ManagedStatusRecord = read_json(&status_path)?;
    if status.instance_id != instance_id {
        return Err(V3LifecycleError::IdentityMismatch(
            "status instance id differs from live control identity".to_string(),
        ));
    }
    Ok(status.detail)
}

pub(crate) fn read_pending_startup_detail(
    instance_dir: &Path,
    instance_id: &str,
) -> Result<Option<String>, V3LifecycleError> {
    let status_path = instance_dir.join("status.json");
    if !status_path.exists() {
        return Ok(None);
    }
    let status: V3ManagedStatusRecord = read_json(&status_path)?;
    if status.instance_id != instance_id {
        return Err(V3LifecycleError::IdentityMismatch(
            "startup status instance id differs from managed child identity".to_string(),
        ));
    }
    if status.state != V3ManagedRunState::Starting {
        return Ok(None);
    }
    let Some(detail) = status.detail else {
        return Ok(None);
    };
    if detail == "exec restart accepted" {
        return Ok(None);
    }
    Ok(Some(
        detail
            .strip_prefix("exec restart accepted; ")
            .unwrap_or(&detail)
            .to_string(),
    ))
}

pub(crate) fn append_status_detail(base: Option<&str>, update: String) -> String {
    match base {
        Some(base) if !base.is_empty() => format!("{base}; {update}"),
        _ => update,
    }
}

pub(crate) fn is_control_client_disconnect(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::UnexpectedEof
            | std::io::ErrorKind::ConnectionReset
    )
}

/// Backoff between retries of a transient control-socket accept failure.
///
/// The delay bounds the retry rate so a persistent transient condition (for
/// example fd exhaustion) cannot spin the control loop hot, while the operator
/// channel and the managed runtime stay alive.
const CONTROL_ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(50);

/// A transient accept failure ends only the affected accept.
///
/// The control socket is the operator channel, so per-accept errno such as
/// EINTR, EMFILE/ENFILE, ECONNABORTED, EPROTO, or ENETDOWN must not escalate
/// into a managed-runtime failure. Anything else (for example the listener fd
/// is gone or is no longer a socket) stays fatal.
pub(crate) fn control_accept_error_is_transient(error: &V3LifecycleError) -> bool {
    let V3LifecycleError::Io(error) = error else {
        return false;
    };
    if matches!(
        error.kind(),
        std::io::ErrorKind::Interrupted | std::io::ErrorKind::ConnectionAborted
    ) {
        return true;
    }
    #[cfg(unix)]
    if matches!(
        error.raw_os_error(),
        Some(libc::EMFILE) | Some(libc::ENFILE) | Some(libc::EPROTO) | Some(libc::ENETDOWN)
    ) {
        return true;
    }
    false
}

/// Outcome of one control-socket accept failure.
enum ControlAcceptFailure {
    /// The accept was transient; the loop must keep serving.
    Transient,
    /// The failure ends the managed runtime.
    Fatal(V3LifecycleError),
}

/// Classify one control-socket accept failure and bound the retry rate.
///
/// The unix and non-unix listeners share this decision, so a transient errno
/// cannot stay fatal on one platform while it is retried on the other.
async fn classify_control_accept_failure(error: V3LifecycleError) -> ControlAcceptFailure {
    if !control_accept_error_is_transient(&error) {
        return ControlAcceptFailure::Fatal(error);
    }
    // One transient accept failure ends only this accept: the control socket
    // keeps serving and the managed runtime stays Running.
    eprintln!("managed control accept failed; retrying: {error}");
    tokio::time::sleep(CONTROL_ACCEPT_RETRY_DELAY).await;
    ControlAcceptFailure::Transient
}

pub(crate) async fn write_control_response(
    stream: &mut UnixStream,
    response: &ControlResponse,
) -> Result<bool, V3LifecycleError> {
    let payload = serde_json::to_vec(response)?;
    for bytes in [payload.as_slice(), b"\n"] {
        if let Err(error) = stream.write_all(bytes).await {
            if is_control_client_disconnect(&error) {
                return Ok(false);
            }
            return Err(error.into());
        }
    }
    if let Err(error) = stream.flush().await {
        if is_control_client_disconnect(&error) {
            return Ok(false);
        }
        return Err(error.into());
    }
    Ok(true)
}

pub(crate) async fn fail_managed_runtime_with_hooks_cleanup(
    instance_dir: &Path,
    instance_id: &str,
    handle: Option<V3ServerAggregateHandle>,
    hooks_sidecar: V3HooksSidecarSupervisor,
    primary_error: V3LifecycleError,
) -> Result<(), V3LifecycleError> {
    fail_published_runtime(
        instance_dir,
        instance_id,
        handle,
        Some(hooks_sidecar),
        None,
        primary_error,
    )
    .await
}

pub(crate) async fn fail_published_runtime(
    instance_dir: &Path,
    instance_id: &str,
    handle: Option<V3ServerAggregateHandle>,
    hooks_sidecar: Option<V3HooksSidecarSupervisor>,
    startup_socket: Option<(&Path, &V3ManagedInstanceDeclaration, &str)>,
    primary_error: V3LifecycleError,
) -> Result<(), V3LifecycleError> {
    let mut detail = primary_error.to_string();
    let mut controls = None;
    if let Some(handle) = handle {
        let (report, drain) = close_failed_aggregate(handle).await;
        if !report.is_empty() {
            detail = append_status_detail(Some(&detail), report.to_string());
        }
        if let Some(drain) = drain {
            detail = append_status_detail(Some(&detail), drain);
        }
        controls = Some(report);
    }
    if let Some(sidecar) = hooks_sidecar {
        let cleanup = sidecar
            .stop()
            .await
            .err()
            .map(|error| format!("hooks sidecar cleanup failed: {error}"))
            .or_else(|| hooks_sidecar_cleanup_incomplete_detail(instance_dir))
            .unwrap_or_else(|| "managed runtime failure".to_string());
        detail = append_status_detail(Some(&detail), cleanup);
    }
    publish_failed_outcome(
        instance_dir,
        instance_id,
        &detail,
        controls.as_ref(),
        startup_socket,
        "runtime",
    );
    Err(primary_error)
}

pub(crate) fn publish_failed_outcome(
    instance_dir: &Path,
    instance_id: &str,
    detail: &str,
    controls: Option<&routecodex_v3_server::V3ServerCloseReport>,
    startup_socket: Option<(&Path, &V3ManagedInstanceDeclaration, &str)>,
    phase: &str,
) {
    let publish = |detail: &str| {
        write_status(
            instance_dir,
            instance_id,
            V3ManagedRunState::Failed,
            Some(detail.to_owned()),
        )
        .inspect_err(|error| {
            eprintln!("managed {phase} failure status write failed after {detail}: {error}")
        })
    };
    // A successor can exit with Starting still durable. Formal restart needs
    // the write-ahead artifact and independent generation even for resolved leaves.
    if publish(detail).is_ok() {
        if let Some((path, declaration, nonce)) = startup_socket {
            if let Err(error) = settle_terminal_restart_plan(instance_dir, declaration, nonce)
                .and_then(|()| close_failed_startup_control_files(instance_dir, path))
            {
                let _ = publish(&append_status_detail(
                    Some(detail),
                    format!("managed control cleanup failed: {error}"),
                ));
                return;
            }
        }
        // Even resolved endpoints still witness the failed attempt while a
        // checkpoint awaits disposition by verified exited-owner recovery.
        let checkpoint_absent = fs::symlink_metadata(instance_dir.join(PROVIDER_HANDOFF_FILE))
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
        if let Some(error) = controls
            .filter(|report| checkpoint_absent || report.pending_controls.is_some())
            .and_then(|report| terminal_control_settlement_error(instance_dir, instance_id, report))
        {
            let _ = publish(&append_status_detail(Some(detail), error));
        }
        if startup_socket.is_some() {
            if let Err(error) = remove_settled_pid_cache(instance_dir) {
                let _ = publish(&append_status_detail(
                    Some(detail),
                    format!("managed cache cleanup failed: {error}"),
                ));
            }
        }
    }
}

pub(crate) async fn close_failed_aggregate(
    mut handle: V3ServerAggregateHandle,
) -> (routecodex_v3_server::V3ServerCloseReport, Option<String>) {
    let report = handle.close_active_key_controls().await;
    let drain = match tokio::time::timeout(Duration::from_secs(2), handle.shutdown()).await {
        Ok(report) if !report.is_empty() => Some(report.to_string()),
        Ok(_) => None,
        Err(_) => Some("managed failure persistence shutdown timed out".to_string()),
    };
    (report, drain)
}

fn settle_terminal_controls(
    instance_dir: &Path,
    instance_id: &str,
    report: &routecodex_v3_server::V3ServerCloseReport,
) -> Option<String> {
    let detail = (!report.is_empty()).then(|| report.to_string());
    terminal_control_settlement_error(instance_dir, instance_id, report)
        .map(|error| append_status_detail(detail.as_deref(), error))
        .or(detail)
}

fn terminal_control_settlement_error(
    instance_dir: &Path,
    instance_id: &str,
    report: &routecodex_v3_server::V3ServerCloseReport,
) -> Option<String> {
    let result = (|| -> Result<(), V3LifecycleError> {
        if !instance_dir.join(FRONT_HANDOFF_FILE).try_exists()? {
            return Ok(());
        }
        let cache: V3ManagedPidCache = read_json(&instance_dir.join("pid.cache"))?;
        if let Some(prior) =
            read_live_retained_front_control_handoff(instance_dir, instance_id, &cache.start_nonce)?
        {
            persist_retained_front_control_handoff(
                instance_dir,
                &prior.declaration,
                report.pending_controls.clone(),
            )?;
        }
        Ok(())
    })();
    result.err().map(|error| {
        format!("active-key terminal custody retained after disposition write failed: {error}")
    })
}

pub(crate) fn observe_status_if_changed<F>(
    observe: &mut F,
    last_observed_status: &mut Option<(V3ManagedRunState, Option<String>)>,
    status: &V3ManagedStatusRecord,
) where
    F: FnMut(V3ManagedLifecycleObservation),
{
    let current = (status.state.clone(), status.detail.clone());
    if last_observed_status.as_ref() == Some(&current) {
        return;
    }
    *last_observed_status = Some(current);
    observe(V3ManagedLifecycleObservation::RestartStatusObserved {
        status: status.clone(),
    });
}

pub(crate) async fn shutdown_managed_runtime(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    start_nonce: &str,
    socket_path: &Path,
    handle: V3ServerAggregateHandle,
    hooks_sidecar: V3HooksSidecarSupervisor,
) -> Result<(), V3LifecycleError> {
    let instance_id = &declaration.instance_id;
    write_status(instance_dir, instance_id, V3ManagedRunState::Stopping, None)?;
    let server_close = handle.shutdown().await;
    let close_detail = settle_terminal_controls(instance_dir, instance_id, &server_close);
    let hooks_cleanup_detail = hooks_sidecar
        .stop()
        .await
        .err()
        .map(|error| format!("hooks sidecar shutdown failed: {error}"));
    let detail = close_detail
        .map(|close| append_status_detail(hooks_cleanup_detail.as_deref(), close))
        .or(hooks_cleanup_detail);
    write_status(
        instance_dir,
        instance_id,
        V3ManagedRunState::Stopped,
        detail.clone(),
    )?;
    settle_terminal_restart_plan(instance_dir, declaration, start_nonce)
        .and_then(|()| close_failed_startup_control_files(instance_dir, socket_path))
        .and_then(|()| remove_settled_pid_cache(instance_dir))
        .inspect_err(|error| {
            let detail = append_status_detail(
                detail.as_deref(),
                format!("managed terminal cleanup failed: {error}"),
            );
            if let Err(status_error) = write_status(
                instance_dir,
                instance_id,
                V3ManagedRunState::Stopped,
                Some(detail),
            ) {
                eprintln!(
                    "managed stopped cleanup status write failed after {error}: {status_error}"
                );
            }
        })
}

async fn wait_for_control_peer_before_exec(stream: &UnixStream) -> Result<(), V3LifecycleError> {
    let mut byte = [0_u8; 1];
    loop {
        stream.readable().await.map_err(V3LifecycleError::Io)?;
        match stream.try_read(&mut byte) {
            Ok(0) => {
                return Err(V3LifecycleError::Validation(
                    "restart control client disconnected before exec; original owner retained"
                        .into(),
                ))
            }
            Ok(_) => {
                return Err(V3LifecycleError::Validation(
                    "unexpected restart control input before exec".into(),
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error.into()),
        }
    }
}

// Keep the one shutdown future alive after a client's deadline. Only status
// observation is accepted while persistence and writer exit are unresolved.
async fn observe_managed_shutdown(
    shutdown: impl std::future::Future<Output = Result<(), V3LifecycleError>>,
    listener: &UnixListener,
    declaration: &V3ManagedInstanceDeclaration,
    start_nonce: &str,
) -> Result<(), V3LifecycleError> {
    tokio::pin!(shutdown);
    let mut frames = tokio::task::JoinSet::new();
    loop {
        let accepted = tokio::select! {
            result = &mut shutdown => return result,
            accepted = next_control_frame(listener, &mut frames) => accepted,
        };
        let (mut stream, line, read) = match accepted {
            Ok(frame) => frame,
            Err(error) => {
                eprintln!("managed stopping control accept failed: {error}");
                // The shutdown owner must still reach its real terminal result.
                return shutdown.await;
            }
        };
        if !matches!(read, Ok(Ok(n)) if n > 0) {
            continue;
        }
        let valid_status = serde_json::from_str::<ControlRequest>(&line)
            .map(|request| {
                request.schema_version == SCHEMA_VERSION
                    && request.instance_id == declaration.instance_id
                    && request.start_nonce == start_nonce
                    && request.operation == ControlOperation::Status
            })
            .unwrap_or(false);
        let response = ControlResponse {
            schema_version: SCHEMA_VERSION,
            instance_id: declaration.instance_id.clone(),
            accepted: valid_status,
            state: V3ManagedRunState::Stopping,
            message: "shutdown is still pending; persistence and writer exit must finish before completion"
                .into(),
        };
        // A slow observer must not stop the owned shutdown from progressing.
        tokio::select! {
            result = &mut shutdown => return result,
            _ = write_control_response(&mut stream, &response) => {},
        }
    }
}

pub(crate) async fn restart_managed_runtime_in_place(
    instance_dir: &Path,
    handle: &V3ServerAggregateHandle,
    restart_plan: ControlRestartPlan,
    console: bool,
    stream: &UnixStream,
) -> Result<(), V3LifecycleError> {
    let declaration = &restart_plan.declaration;
    let instances_root = instance_dir.parent().ok_or_else(|| {
        V3LifecycleError::Validation("managed instance has no instances directory".into())
    })?;
    let target_dir = instances_root.join(&declaration.instance_id);
    V3HooksSidecarSupervisor::ensure_exec_target_available(instance_dir, &target_dir)?;
    let _transfer = bind_previous_release_restart_transfer(instance_dir, &restart_plan)?;
    let mut preparation = tokio::select! {
        preparation = handle.prepare_exec_attempt() => {
            preparation.map_err(V3LifecycleError::Validation)?
        }
        cancellation = wait_for_control_peer_before_exec(stream) => {
            return cancellation;
        }
    };
    let exec_owner = serde_json::to_string(&ExecRestartOwner {
        instance_id: restart_plan.control_instance_id.clone(),
        start_nonce: restart_plan.control_start_nonce.clone(),
        active_key_controls: None,
    })?;
    let controls = preparation
        .active_key_control_handoff
        .take()
        .unwrap_or_default();
    let source_front = instance_dir.join(FRONT_HANDOFF_FILE);
    let prior_front = read_live_retained_front_control_handoff(
        instance_dir,
        &restart_plan.control_instance_id,
        &restart_plan.control_start_nonce,
    )?;
    let front_path = target_dir.join(FRONT_HANDOFF_FILE);
    let provider_path = instance_dir.join(PROVIDER_HANDOFF_FILE);
    ensure_private_dir(&target_dir)?;
    let staged_declaration = target_dir.join(EXEC_RESTART_DECLARATION_FILE);
    let target_declaration = target_dir.join("instance.json");
    if target_declaration.try_exists()? && !fs::metadata(&target_declaration)?.is_file() {
        return Err(V3LifecycleError::Validation(
            "restart target declaration path is not a file".into(),
        ));
    }
    for path in [&provider_path, &staged_declaration] {
        if path.try_exists()? {
            return Err(V3LifecycleError::Validation(format!(
                "restart handoff already exists; original owner retained: {}",
                path.display()
            )));
        }
    }
    if target_dir != instance_dir {
        for file in [FRONT_HANDOFF_FILE, PROVIDER_HANDOFF_FILE] {
            let path = target_dir.join(file);
            if path.try_exists()? {
                return Err(V3LifecycleError::Validation(format!(
                    "restart target handoff already exists: {}",
                    path.display()
                )));
            }
        }
    }
    let mut created = Vec::new();
    let attempt = (|| -> Result<(), V3LifecycleError> {
        write_json_atomic(&staged_declaration, declaration)?;
        created.push(staged_declaration.clone());
        write_json_atomic(
            &front_path,
            &ManagedFrontControlHandoff {
                declaration: declaration.clone(),
                origin: read_json(&instance_dir.join("pid.cache"))?,
                checkpoints: std::mem::take(&mut preparation.front_checkpoints),
                controls,
            },
        )?;
        created.push(front_path.clone());
        write_json_atomic(
            &provider_path,
            &routecodex_v3_runtime::default_provider_transport_handoff_checkpoints(),
        )?;
        created.push(provider_path.clone());
        Ok(())
    })();
    let reject = |error| {
        cleanup_rejected_restart_handoff(
            created,
            prior_front
                .as_ref()
                .filter(|_| source_front == front_path)
                .map(|prior| (front_path.as_path(), prior)),
            error,
        )
    };
    if let Err(error) = attempt {
        return Err(reject(error));
    }
    let mut command = Command::new(&restart_plan.executable_path);
    command.env(EXEC_RESTART_OWNER_ENV, exec_owner);
    command
        .arg("server")
        .arg("run-managed-child")
        .arg("--config")
        .arg(&declaration.config_path);
    if restart_plan.snapshot_direct {
        command.arg("--snapall");
    } else if restart_plan.snapshots {
        command.arg("--snap");
    }
    if let Some(stages) = restart_plan.snapshot_stages.as_deref() {
        command.arg("--snap-stages").arg(stages);
    }
    if console {
        command.arg("--console");
    }
    if restart_plan.sse_dump {
        command.arg("--sse-dump");
    }
    let mut peer_byte = [0_u8; 1];
    match stream.try_read(&mut peer_byte) {
        Ok(0) => {
            return Err(reject(V3LifecycleError::Validation(
                "restart control client disconnected before exec; original owner retained".into(),
            )))
        }
        Ok(_) => {
            return Err(reject(V3LifecycleError::Validation(
                "unexpected restart control input before exec".into(),
            )))
        }
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
        Err(error) => return Err(reject(error.into())),
    }
    let error = command.exec();
    drop(preparation);
    Err(reject(V3LifecycleError::Io(error)))
}

fn cleanup_rejected_restart_handoff(
    created: Vec<PathBuf>,
    restore_front: Option<(&Path, &ManagedFrontControlHandoff)>,
    error: V3LifecycleError,
) -> V3LifecycleError {
    let mut detail = format!("exec restart rejected; original owner retained: {error}");
    for path in created {
        let cleanup = match restore_front {
            Some((front, previous)) if front == path => write_json_atomic(&path, previous),
            _ => fs::remove_file(&path).map_err(V3LifecycleError::from),
        };
        if let Err(cleanup_error) = cleanup {
            detail.push_str(&format!(
                "; retained handoff {}: {cleanup_error}",
                path.display()
            ));
        }
    }
    V3LifecycleError::Validation(detail)
}

// Collect framing concurrently; authenticated lifecycle operations remain serialized
// by run_managed_control_loop. An unfinished peer must not hold the accept loop.
type ControlFrame = (
    UnixStream,
    String,
    Result<std::io::Result<usize>, tokio::time::error::Elapsed>,
);

async fn next_control_frame(
    listener: &UnixListener,
    frames: &mut tokio::task::JoinSet<ControlFrame>,
) -> Result<ControlFrame, V3LifecycleError> {
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (mut stream, _) = accepted?;
                frames.spawn(async move {
                    let mut line = String::new();
                    let read = tokio::time::timeout(
                        CONTROL_TIMEOUT,
                        BufReader::new(&mut stream).read_line(&mut line),
                    ).await;
                    (stream, line, read)
                });
            }
            frame = frames.join_next(), if !frames.is_empty() => {
                return frame.expect("nonempty control framing tasks").map_err(|error| {
                    V3LifecycleError::Validation(format!("control framing task failed: {error}"))
                });
            }
        }
    }
}

pub(crate) async fn run_managed_control_loop(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    socket_path: &Path,
    start_nonce: String,
    listener: UnixListener,
    handle: Option<V3ServerAggregateHandle>,
    hooks_sidecar: V3HooksSidecarSupervisor,
    force_console: bool,
) -> Result<(), V3LifecycleError> {
    #[cfg(unix)]
    let mut interrupt_signal =
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()) {
            Ok(signal) => signal,
            Err(error) => {
                return fail_managed_runtime_with_hooks_cleanup(
                    instance_dir,
                    &declaration.instance_id,
                    handle,
                    hooks_sidecar,
                    error.into(),
                )
                .await;
            }
        };
    #[cfg(unix)]
    let mut terminate_signal =
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(signal) => signal,
            Err(error) => {
                return fail_managed_runtime_with_hooks_cleanup(
                    instance_dir,
                    &declaration.instance_id,
                    handle,
                    hooks_sidecar,
                    error.into(),
                )
                .await;
            }
        };
    #[cfg(not(unix))]
    let mut ctrl_c = Box::pin(tokio::signal::ctrl_c());
    #[cfg(unix)]
    let ephemeral_config_path = managed_config_is_ephemeral(Path::new(&declaration.config_path))
        .then(|| PathBuf::from(&declaration.config_path));
    #[cfg(unix)]
    let orphan_watchdog = async {
        let Some(config_path) = ephemeral_config_path else {
            std::future::pending::<()>().await;
            return;
        };
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if !config_path.exists() {
                return;
            }
        }
    };
    #[cfg(unix)]
    tokio::pin!(orphan_watchdog);
    let mut handle = handle;
    let mut frames = tokio::task::JoinSet::new();
    let shutdown = |handle, hooks_sidecar| {
        observe_managed_shutdown(
            shutdown_managed_runtime(
                instance_dir,
                declaration,
                &start_nonce,
                socket_path,
                handle,
                hooks_sidecar,
            ),
            &listener,
            declaration,
            &start_nonce,
        )
    };
    loop {
        #[cfg(unix)]
        let accepted = match tokio::select! {
            _ = &mut orphan_watchdog => {
                let Some(handle) = handle.take() else {
                    return fail_managed_runtime_with_hooks_cleanup(
                        instance_dir,
                        &declaration.instance_id,
                        None,
                        hooks_sidecar,
                        V3LifecycleError::Validation(
                            "managed runtime handle was already consumed".to_string(),
                        ),
                    )
                    .await;
                };
                return shutdown(handle, hooks_sidecar).await;
            }
            _ = interrupt_signal.recv() => {
                let Some(handle) = handle.take() else {
                    return fail_managed_runtime_with_hooks_cleanup(
                        instance_dir,
                        &declaration.instance_id,
                        None,
                        hooks_sidecar,
                        V3LifecycleError::Validation(
                            "managed runtime handle was already consumed".to_string(),
                        ),
                    )
                    .await;
                };
                return shutdown(handle, hooks_sidecar).await;
            }
            _ = terminate_signal.recv() => {
                let Some(handle) = handle.take() else {
                    return fail_managed_runtime_with_hooks_cleanup(
                        instance_dir,
                        &declaration.instance_id,
                        None,
                        hooks_sidecar,
                        V3LifecycleError::Validation(
                            "managed runtime handle was already consumed".to_string(),
                        ),
                    )
                    .await;
                };
                return shutdown(handle, hooks_sidecar).await;
            }
            accepted = next_control_frame(&listener, &mut frames) => accepted,
        } {
            Ok(accepted) => accepted,
            Err(error) => match classify_control_accept_failure(error).await {
                ControlAcceptFailure::Transient => continue,
                ControlAcceptFailure::Fatal(error) => {
                    return fail_managed_runtime_with_hooks_cleanup(
                        instance_dir,
                        &declaration.instance_id,
                        handle.take(),
                        hooks_sidecar,
                        error,
                    )
                    .await;
                }
            },
        };
        #[cfg(not(unix))]
        let accepted = match tokio::select! {
            signal = &mut ctrl_c => {
                if let Err(error) = signal {
                    return fail_managed_runtime_with_hooks_cleanup(
                        instance_dir,
                        &declaration.instance_id,
                        handle.take(),
                        hooks_sidecar,
                        error.into(),
                    )
                    .await;
                }
                let Some(handle) = handle.take() else {
                    return fail_managed_runtime_with_hooks_cleanup(
                        instance_dir,
                        &declaration.instance_id,
                        None,
                        hooks_sidecar,
                        V3LifecycleError::Validation(
                            "managed runtime handle was already consumed".to_string(),
                        ),
                    )
                    .await;
                };
                return shutdown(handle, hooks_sidecar).await;
            }
            accepted = next_control_frame(&listener, &mut frames) => accepted,
        } {
            Ok(accepted) => accepted,
            Err(error) => match classify_control_accept_failure(error).await {
                ControlAcceptFailure::Transient => continue,
                ControlAcceptFailure::Fatal(error) => {
                    return fail_managed_runtime_with_hooks_cleanup(
                        instance_dir,
                        &declaration.instance_id,
                        handle.take(),
                        hooks_sidecar,
                        error,
                    )
                    .await;
                }
            },
        };
        let (mut stream, line, read) = accepted;
        match read {
            Err(_) => continue,
            Ok(Ok(0)) => continue,
            Ok(Ok(_)) => {}
            Ok(Err(error)) if is_control_client_disconnect(&error) => continue,
            Ok(Err(error)) => {
                return fail_managed_runtime_with_hooks_cleanup(
                    instance_dir,
                    &declaration.instance_id,
                    handle.take(),
                    hooks_sidecar,
                    error.into(),
                )
                .await;
            }
        }
        let request: ControlRequest = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                let response = ControlResponse {
                    schema_version: SCHEMA_VERSION,
                    instance_id: declaration.instance_id.clone(),
                    accepted: false,
                    state: V3ManagedRunState::Running,
                    message: format!("invalid control request JSON: {error}"),
                };
                if let Err(response_error) = write_control_response(&mut stream, &response).await {
                    eprintln!("managed control response write failed: {response_error}");
                }
                continue;
            }
        };
        let valid_identity = request.schema_version == SCHEMA_VERSION
            && request.instance_id == declaration.instance_id
            && request.start_nonce == start_nonce;
        let restart_plan = if valid_identity {
            match control_restart_plan(instance_dir, &request, declaration) {
                Ok(plan) => plan,
                Err(message) => {
                    let response = ControlResponse {
                        schema_version: SCHEMA_VERSION,
                        instance_id: declaration.instance_id.clone(),
                        accepted: false,
                        state: V3ManagedRunState::Running,
                        message,
                    };
                    if let Err(response_error) =
                        write_control_response(&mut stream, &response).await
                    {
                        eprintln!("managed control response write failed: {response_error}");
                    }
                    continue;
                }
            }
        } else {
            None
        };
        let release_ports = if valid_identity {
            let retained_ports = handle
                .iter()
                .flat_map(V3ServerAggregateHandle::retained_active_key_cleanup_ports);
            match control_release_ports(&request, declaration, retained_ports) {
                Ok(ports) => ports,
                Err(message) => {
                    let response = ControlResponse {
                        schema_version: SCHEMA_VERSION,
                        instance_id: declaration.instance_id.clone(),
                        accepted: false,
                        state: V3ManagedRunState::Running,
                        message,
                    };
                    if let Err(response_error) =
                        write_control_response(&mut stream, &response).await
                    {
                        eprintln!("managed control response write failed: {response_error}");
                    }
                    continue;
                }
            }
        } else {
            None
        };
        let valid = valid_identity;
        let should_stop = valid && request.operation == ControlOperation::Stop;
        let should_restart = valid && request.operation == ControlOperation::Restart;
        if should_restart {
            let result = match (handle.as_ref(), restart_plan) {
                (Some(handle), Some(plan)) => {
                    restart_managed_runtime_in_place(
                        instance_dir,
                        handle,
                        plan,
                        force_console,
                        &stream,
                    )
                    .await
                }
                _ => Err(V3LifecycleError::Validation(
                    "restart runtime handle or plan is unavailable".into(),
                )),
            };
            if let Err(error) = result {
                eprintln!("managed restart rejected: {error}");
                let response = ControlResponse {
                    schema_version: SCHEMA_VERSION,
                    instance_id: declaration.instance_id.clone(),
                    accepted: false,
                    state: V3ManagedRunState::Running,
                    message: error.to_string(),
                };
                if let Err(error) = write_control_response(&mut stream, &response).await {
                    eprintln!("managed restart rejection write failed: {error}");
                }
            }
            continue;
        }
        if let Some(release_ports) = release_ports {
            let Some(aggregate_handle) = handle.as_mut() else {
                return fail_managed_runtime_with_hooks_cleanup(
                    instance_dir,
                    &declaration.instance_id,
                    None,
                    hooks_sidecar,
                    V3LifecycleError::Validation(
                        "managed runtime handle was already consumed".to_string(),
                    ),
                )
                .await;
            };
            let report = aggregate_handle
                .shutdown_listener_ports(&release_ports)
                .await;
            let custody_error = read_live_retained_front_control_handoff(
                instance_dir,
                &declaration.instance_id,
                &start_nonce,
            )
            .and_then(|_| {
                persist_retained_front_control_handoff(
                    instance_dir,
                    declaration,
                    aggregate_handle.exact_active_key_custody(),
                )
            })
            .err();
            let released_set = report.released_ports.into_iter().collect();
            let released = format_u16_set(&released_set);
            let cleanup_complete =
                report.control_cleanup_failures.is_empty() && custody_error.is_none();
            let final_listener = aggregate_handle.listener_release_is_complete();
            let state = if final_listener {
                V3ManagedRunState::Stopping
            } else {
                V3ManagedRunState::Running
            };
            let mut message = if final_listener {
                format!("released final listener ports {released}; managed foreground exiting")
            } else {
                format!("released listener ports {released}")
            };
            if !report.control_cleanup_failures.is_empty() {
                let pending = report
                    .control_cleanup_failures
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("; ");
                message.push_str(&format!("; pending control cleanup: {pending}"));
            }
            if let Some(error) = custody_error {
                message.push_str(&format!(
                    "; active-key control custody persistence failed: {error}"
                ));
            }
            let status_result = (|| {
                let previous = if final_listener {
                    None
                } else {
                    read_live_status_detail(instance_dir, &declaration.instance_id)?
                };
                write_status(
                    instance_dir,
                    &declaration.instance_id,
                    state.clone(),
                    Some(append_status_detail(previous.as_deref(), message.clone())),
                )
            })();
            if let Err(error) = status_result {
                if cleanup_complete {
                    return fail_managed_runtime_with_hooks_cleanup(
                        instance_dir,
                        &declaration.instance_id,
                        handle.take(),
                        hooks_sidecar,
                        error,
                    )
                    .await;
                }
                message.push_str(&format!("; managed release status write failed: {error}"));
            }
            let response = ControlResponse {
                schema_version: SCHEMA_VERSION,
                instance_id: declaration.instance_id.clone(),
                accepted: cleanup_complete,
                state,
                message,
            };
            if let Err(error) = write_control_response(&mut stream, &response).await {
                eprintln!("managed ReleasePorts response write failed: {error}");
            }
            if final_listener {
                return shutdown(
                    handle.take().expect("managed release owns its handle"),
                    hooks_sidecar,
                )
                .await;
            }
            continue;
        }
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
        if let Err(response_error) = write_control_response(&mut stream, &response).await {
            eprintln!("managed control response write failed: {response_error}");
            continue;
        }
        if should_stop {
            let Some(handle) = handle.take() else {
                return fail_managed_runtime_with_hooks_cleanup(
                    instance_dir,
                    &declaration.instance_id,
                    None,
                    hooks_sidecar,
                    V3LifecycleError::Validation(
                        "managed runtime handle was already consumed".to_string(),
                    ),
                )
                .await;
            };
            return shutdown(handle, hooks_sidecar).await;
        }
    }
}

pub(crate) async fn send_control(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    operation: ControlOperation,
) -> Result<ControlResponse, V3LifecycleError> {
    send_control_with_ports(instance_dir, declaration, operation, None).await
}

pub(crate) async fn send_release_ports_control(
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

pub(crate) async fn send_control_with_ports(
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

pub(crate) async fn send_restart_control(
    instance_dir: &Path,
    control_declaration: &V3ManagedInstanceDeclaration,
    target_declaration: &V3ManagedInstanceDeclaration,
    snapshots: bool,
    snapshot_direct: bool,
    snapshot_stages: Option<String>,
    sse_dump: bool,
    transfer: Option<&mut PreviousReleaseRestartGuard>,
    deadline: tokio::time::Instant,
) -> Result<ControlResponse, V3LifecycleError> {
    if tokio::time::Instant::now() >= deadline {
        return Err(V3LifecycleError::Timeout(format!(
            "control challenge {}",
            control_declaration.instance_id
        )));
    }
    let published: V3ManagedInstanceDeclaration = read_json(&instance_dir.join("instance.json"))?;
    let target_change =
        !same_instance_declaration_except_executable_path(&published, target_declaration);
    let needs_restart_plan = published.executable_path != target_declaration.executable_path
        || target_change
        || snapshots
        || snapshot_direct
        || snapshot_stages
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())
        || sse_dump;
    let control: V3ManagedControlRecord = read_json(&instance_dir.join("control.json"))?;
    if needs_restart_plan {
        write_json_atomic(
            &instance_dir.join(RESTART_PLAN_FILE),
            &V3ManagedRestartPlanRecord {
                schema_version: SCHEMA_VERSION,
                instance_id: control_declaration.instance_id.clone(),
                start_nonce: control.start_nonce.clone(),
                executable_path: target_declaration.executable_path.clone(),
                target_declaration: target_change.then(|| target_declaration.clone()),
                snapshots,
                snapshot_direct,
                snapshot_stages,
                sse_dump,
            },
        )?;
    } else {
        let _ = fs::remove_file(instance_dir.join(RESTART_PLAN_FILE));
    }
    if let Some(transfer) = transfer {
        transfer.retain_until_adoption();
    }
    tokio::time::timeout_at(
        deadline,
        send_control_without_timeout(
            instance_dir,
            control_declaration,
            ControlOperation::Restart,
            None,
        ),
    )
    .await
    .map_err(|_| {
        V3LifecycleError::Timeout(format!(
            "control challenge {}",
            control_declaration.instance_id
        ))
    })?
}

pub(crate) async fn send_control_without_timeout(
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
        operation: operation.clone(),
        ports,
    };
    stream.write_all(&serde_json::to_vec(&request)?).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    let mut line = String::new();
    let received = BufReader::new(stream).read_line(&mut line).await?;
    if received == 0 && operation == ControlOperation::Restart {
        return Ok(ControlResponse {
            schema_version: SCHEMA_VERSION,
            instance_id: declaration.instance_id.clone(),
            accepted: true,
            state: V3ManagedRunState::Starting,
            message: "restart transport closed; awaiting exact replacement identity".into(),
        });
    }
    Ok(serde_json::from_str(&line)?)
}

pub(crate) fn is_business_listener_declaration(listener: &V3ManagedListenerDeclaration) -> bool {
    listener.server_id != "admin_webui"
}

pub(crate) fn business_listener_declarations(
    listeners: &[V3ManagedListenerDeclaration],
) -> Vec<V3ManagedListenerDeclaration> {
    listeners
        .iter()
        .filter(|listener| is_business_listener_declaration(listener))
        .cloned()
        .collect()
}

pub(crate) fn listener_set_is_available(listeners: &[V3ManagedListenerDeclaration]) -> bool {
    listeners
        .iter()
        .filter(|listener| is_business_listener_declaration(listener))
        .all(|listener| listener_address_is_available(&listener.bind, listener.port))
}

pub(crate) fn occupied_listener_ports(listeners: &[V3ManagedListenerDeclaration]) -> BTreeSet<u16> {
    listeners
        .iter()
        .filter(|listener| is_business_listener_declaration(listener))
        .filter(|listener| !listener_address_is_available(&listener.bind, listener.port))
        .map(|listener| listener.port)
        .collect()
}

pub(crate) async fn wait_for_listener_set_available(
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
