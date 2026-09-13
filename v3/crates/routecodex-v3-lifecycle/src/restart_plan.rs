use super::*;

pub(super) fn control_restart_plan(
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
    let mut declaration = record
        .as_ref()
        .and_then(|record| record.target_declaration.clone())
        .unwrap_or_else(|| current.clone());
    declaration.executable_path = executable_path.display().to_string();
    let valid_declaration = if declaration.instance_id == current.instance_id {
        same_instance_declaration_except_executable_path(current, &declaration)
    } else {
        previous_owner_matches_restart_declaration(current, &declaration)
    };
    if !valid_declaration {
        return Err(
            "restart target declaration does not match the current managed owner".to_string(),
        );
    }
    let snapshot_stages = record
        .as_ref()
        .and_then(|record| record.snapshot_stages.as_ref())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let snapshots = record.as_ref().is_some_and(|record| record.snapshots);
    let snapshot_direct = record.as_ref().is_some_and(|record| record.snapshot_direct);
    let sse_dump = record.as_ref().is_some_and(|record| record.sse_dump);
    Ok(Some(ControlRestartPlan {
        control_instance_id: current.instance_id.clone(),
        declaration,
        executable_path,
        snapshots: snapshots || snapshot_stages.is_some(),
        snapshot_direct,
        snapshot_stages,
        sse_dump,
    }))
}

pub(super) fn remove_restart_plan_for_previous_control_identity(
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
