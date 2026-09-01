use super::*;

pub(crate) fn exec_foreground_start(
    executable_path: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    lifecycle: &V3ManagedLifecycle,
    instance_dir: &Path,
) -> Result<(), V3LifecycleError> {
    let mut command = build_foreground_exec_command(executable_path, declaration, lifecycle);
    let error = command.exec();
    let _ = write_status(
        instance_dir,
        &declaration.instance_id,
        V3ManagedRunState::Failed,
        Some(format!("exec start failed: {error}")),
    );
    Err(V3LifecycleError::Io(error))
}

pub(crate) fn build_foreground_exec_command(
    executable_path: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    lifecycle: &V3ManagedLifecycle,
) -> Command {
    let mut command = Command::new(executable_path);
    command
        .arg("server")
        .arg("run-managed-child")
        .arg("--config")
        .arg(&declaration.config_path);
    if lifecycle.force_snapshot_direct {
        command.arg("--snapall");
    } else if lifecycle.force_snapshots {
        command.arg("--snap");
    }
    if let Some(stages) = lifecycle.force_snapshot_stages.as_deref() {
        command.arg("--snap-stages").arg(stages);
    }
    if lifecycle.force_console {
        command.arg("--console");
    }
    if lifecycle.force_sse_dump {
        command.arg("--sse-dump");
    }
    command
}
