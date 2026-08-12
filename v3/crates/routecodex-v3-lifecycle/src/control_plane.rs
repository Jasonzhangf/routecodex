use super::*;

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
) -> Result<(), V3LifecycleError> {
    write_status(instance_dir, instance_id, V3ManagedRunState::Stopping, None)?;
    handle.shutdown().await;
    write_status(instance_dir, instance_id, V3ManagedRunState::Stopped, None)?;
    let _ = fs::remove_file(instance_dir.join("pid.cache"));
    let _ = fs::remove_file(instance_dir.join("control.json"));
    let _ = fs::remove_file(socket_path);
    Ok(())
}

pub(crate) async fn restart_managed_runtime_in_place(
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
    let error = command.exec();
    let _ = write_status(
        instance_dir,
        &declaration.instance_id,
        V3ManagedRunState::Failed,
        Some(format!("exec restart failed: {error}")),
    );
    Err(V3LifecycleError::Io(error))
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
    declaration: &V3ManagedInstanceDeclaration,
    snapshots: bool,
    snapshot_direct: bool,
    snapshot_stages: Option<String>,
) -> Result<ControlResponse, V3LifecycleError> {
    let published: V3ManagedInstanceDeclaration = read_json(&instance_dir.join("instance.json"))?;
    let needs_restart_plan = published.executable_path != declaration.executable_path
        || snapshots
        || snapshot_direct
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
                snapshot_direct,
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

