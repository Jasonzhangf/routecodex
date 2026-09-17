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
    if let Some(handle) = handle {
        let _ = tokio::time::timeout(Duration::from_secs(2), handle.shutdown()).await;
    }
    let hooks_cleanup_detail = hooks_sidecar
        .stop()
        .await
        .err()
        .map(|error| format!("hooks sidecar cleanup failed: {error}"));
    let hooks_record_detail = hooks_sidecar_cleanup_incomplete_detail(instance_dir);
    let cleanup_detail = match hooks_cleanup_detail.as_deref() {
        Some(cleanup) => cleanup.to_string(),
        None => hooks_record_detail.unwrap_or_else(|| "managed runtime failure".to_string()),
    };
    let detail = append_status_detail(Some(&primary_error.to_string()), cleanup_detail);
    if let Err(status_error) = write_status(
        instance_dir,
        instance_id,
        V3ManagedRunState::Failed,
        Some(detail),
    ) {
        eprintln!(
            "managed runtime failure status write failed after {primary_error}: {status_error}"
        );
    }
    Err(primary_error)
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
    instance_id: &str,
    socket_path: &Path,
    handle: V3ServerAggregateHandle,
    hooks_sidecar: V3HooksSidecarSupervisor,
) -> Result<(), V3LifecycleError> {
    write_status(instance_dir, instance_id, V3ManagedRunState::Stopping, None)?;
    handle.shutdown().await;
    let hooks_cleanup_detail = hooks_sidecar
        .stop()
        .await
        .err()
        .map(|error| format!("hooks sidecar shutdown failed: {error}"));
    write_status(
        instance_dir,
        instance_id,
        V3ManagedRunState::Stopped,
        hooks_cleanup_detail,
    )?;
    let _ = fs::remove_file(instance_dir.join("pid.cache"));
    let _ = fs::remove_file(instance_dir.join("control.json"));
    let _ = fs::remove_file(socket_path);
    Ok(())
}

pub(crate) async fn restart_managed_runtime_in_place(
    instance_dir: &Path,
    socket_path: &Path,
    handle: V3ServerAggregateHandle,
    hooks_sidecar: V3HooksSidecarSupervisor,
    restart_plan: ControlRestartPlan,
    console: bool,
) -> Result<(), V3LifecycleError> {
    let declaration = &restart_plan.declaration;
    write_status(
        instance_dir,
        &restart_plan.control_instance_id,
        V3ManagedRunState::Starting,
        Some("exec restart accepted".to_string()),
    )?;
    let provider_checkpoints =
        routecodex_v3_runtime::default_provider_transport_handoff_checkpoints();
    let checkpoints = handle.prepare_for_exec().await;
    write_json_atomic(&instance_dir.join(FRONT_HANDOFF_FILE), &checkpoints)?;
    write_json_atomic(
        &instance_dir.join(PROVIDER_HANDOFF_FILE),
        &provider_checkpoints,
    )?;
    let hooks_cleanup_detail = hooks_sidecar
        .stop()
        .await
        .err()
        .map(|error| format!("hooks sidecar shutdown failed: {error}"));
    if let Some(error) = hooks_cleanup_detail.as_deref() {
        write_status(
            instance_dir,
            &restart_plan.control_instance_id,
            V3ManagedRunState::Starting,
            Some(append_status_detail(
                Some("exec restart accepted"),
                error.to_string(),
            )),
        )?;
    } else {
        let _ = fs::remove_file(instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE));
    }
    let _ = fs::remove_file(instance_dir.join(RESTART_PLAN_FILE));
    if restart_plan.control_instance_id == declaration.instance_id {
        write_json_atomic(&instance_dir.join("instance.json"), declaration)?;
    }
    let _ = fs::remove_file(instance_dir.join("control.json"));
    let _ = fs::remove_file(socket_path);
    let mut command = Command::new(&restart_plan.executable_path);
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
    let error = command.exec();
    let detail = match hooks_cleanup_detail {
        Some(hooks_cleanup_detail) => {
            format!("exec restart failed: {error}; {hooks_cleanup_detail}")
        }
        None => format!("exec restart failed: {error}"),
    };
    let _ = write_status(
        instance_dir,
        &restart_plan.control_instance_id,
        V3ManagedRunState::Failed,
        Some(detail),
    );
    Err(V3LifecycleError::Io(error))
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
    let mut handle = handle;
    loop {
        #[cfg(unix)]
        let accepted = match tokio::select! {
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
                return shutdown_managed_runtime(instance_dir, &declaration.instance_id, socket_path, handle, hooks_sidecar).await;
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
                return shutdown_managed_runtime(instance_dir, &declaration.instance_id, socket_path, handle, hooks_sidecar).await;
            }
            accepted = listener.accept() => accepted.map_err(V3LifecycleError::from),
        } {
            Ok(accepted) => accepted,
            Err(error) => {
                return fail_managed_runtime_with_hooks_cleanup(
                    instance_dir,
                    &declaration.instance_id,
                    handle.take(),
                    hooks_sidecar,
                    error,
                )
                .await;
            }
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
                return shutdown_managed_runtime(instance_dir, &declaration.instance_id, socket_path, handle, hooks_sidecar).await;
            }
            accepted = listener.accept() => accepted.map_err(V3LifecycleError::from),
        } {
            Ok(accepted) => accepted,
            Err(error) => {
                return fail_managed_runtime_with_hooks_cleanup(
                    instance_dir,
                    &declaration.instance_id,
                    handle.take(),
                    hooks_sidecar,
                    error,
                )
                .await;
            }
        };
        let (mut stream, _) = accepted;
        let mut line = String::new();
        match tokio::time::timeout(
            CONTROL_TIMEOUT,
            BufReader::new(&mut stream).read_line(&mut line),
        )
        .await
        {
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
            match control_release_ports(&request, declaration) {
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
            return shutdown_managed_runtime(
                instance_dir,
                &declaration.instance_id,
                socket_path,
                handle,
                hooks_sidecar,
            )
            .await;
        }
        if should_release_ports {
            let Some(release_ports) = release_ports else {
                return fail_managed_runtime_with_hooks_cleanup(
                    instance_dir,
                    &declaration.instance_id,
                    handle.take(),
                    hooks_sidecar,
                    V3LifecycleError::Validation(
                        "release-ports control request did not carry a port set".to_string(),
                    ),
                )
                .await;
            };
            let Some(aggregate_handle) = handle.as_mut() else {
                return fail_managed_runtime_with_hooks_cleanup(
                    instance_dir,
                    &declaration.instance_id,
                    handle.take(),
                    hooks_sidecar,
                    V3LifecycleError::Validation(
                        "managed runtime handle was already consumed".to_string(),
                    ),
                )
                .await;
            };
            let released = aggregate_handle
                .shutdown_listener_ports(&release_ports)
                .await;
            let released_set: BTreeSet<u16> = released.into_iter().collect();
            if !aggregate_handle.has_active_listener() {
                if let Err(error) = write_status(
                    instance_dir,
                    &declaration.instance_id,
                    V3ManagedRunState::Stopping,
                    Some(format!(
                        "released final listener ports {}; managed foreground exiting",
                        format_u16_set(&released_set)
                    )),
                ) {
                    return fail_managed_runtime_with_hooks_cleanup(
                        instance_dir,
                        &declaration.instance_id,
                        handle.take(),
                        hooks_sidecar,
                        error,
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
                return shutdown_managed_runtime(
                    instance_dir,
                    &declaration.instance_id,
                    socket_path,
                    handle,
                    hooks_sidecar,
                )
                .await;
            }
            let current_detail =
                match read_live_status_detail(instance_dir, &declaration.instance_id) {
                    Ok(detail) => detail,
                    Err(error) => {
                        return fail_managed_runtime_with_hooks_cleanup(
                            instance_dir,
                            &declaration.instance_id,
                            handle.take(),
                            hooks_sidecar,
                            error,
                        )
                        .await;
                    }
                };
            if let Err(error) = write_status(
                instance_dir,
                &declaration.instance_id,
                V3ManagedRunState::Running,
                Some(append_status_detail(
                    current_detail.as_deref(),
                    format!("released listener ports {}", format_u16_set(&released_set)),
                )),
            ) {
                return fail_managed_runtime_with_hooks_cleanup(
                    instance_dir,
                    &declaration.instance_id,
                    handle.take(),
                    hooks_sidecar,
                    error,
                )
                .await;
            }
            continue;
        }
        if should_restart {
            let Some(restart_plan) = restart_plan else {
                return fail_managed_runtime_with_hooks_cleanup(
                    instance_dir,
                    &declaration.instance_id,
                    handle.take(),
                    hooks_sidecar,
                    V3LifecycleError::Validation(
                        "restart control request did not carry an executable plan".to_string(),
                    ),
                )
                .await;
            };
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
            return restart_managed_runtime_in_place(
                instance_dir,
                socket_path,
                handle,
                hooks_sidecar,
                restart_plan,
                force_console,
            )
            .await;
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
) -> Result<ControlResponse, V3LifecycleError> {
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
    tokio::time::timeout(
        CONTROL_TIMEOUT,
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

pub(crate) fn listener_set_is_available(listeners: &[V3ManagedListenerDeclaration]) -> bool {
    listeners
        .iter()
        .all(|listener| listener_address_is_available(&listener.bind, listener.port))
}

pub(crate) fn occupied_listener_ports(listeners: &[V3ManagedListenerDeclaration]) -> BTreeSet<u16> {
    listeners
        .iter()
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
