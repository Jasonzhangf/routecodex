use super::*;

pub(crate) fn instance_has_control_truth(instance_dir: &Path) -> bool {
    instance_dir.join("instance.json").exists()
        && instance_dir.join("pid.cache").exists()
        && instance_dir.join("control.json").exists()
}

pub(crate) fn read_pid_cache_start_nonce(
    instance_dir: &Path,
) -> Result<Option<String>, V3LifecycleError> {
    let pid_path = instance_dir.join("pid.cache");
    if !pid_path.exists() {
        return Ok(None);
    }
    let pid: V3ManagedPidCache = read_json(&pid_path)?;
    Ok(Some(pid.start_nonce))
}

pub(crate) fn pid_cache_start_nonce_changed(
    instance_dir: &Path,
    previous: Option<&str>,
) -> Result<bool, V3LifecycleError> {
    let Some(current) = read_pid_cache_start_nonce(instance_dir)? else {
        return Ok(false);
    };
    Ok(previous.is_none_or(|previous| previous != current))
}

pub(crate) fn find_live_previous_owner_for_restart(
    state_root: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<Option<(PathBuf, V3ManagedInstanceDeclaration)>, V3LifecycleError> {
    let candidates = find_previous_owner_candidates_for_restart(state_root, expected)?;
    match candidates.as_slice() {
        [] => Ok(None),
        [(instance_dir, declaration)] => Ok(Some((instance_dir.clone(), declaration.clone()))),
        _ => Err(V3LifecycleError::IdentityMismatch(format!(
            "multiple live previous managed owners match restart declaration {}",
            expected.instance_id
        ))),
    }
}

pub(crate) fn find_previous_owner_candidates_for_restart(
    state_root: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<Vec<(PathBuf, V3ManagedInstanceDeclaration)>, V3LifecycleError> {
    let instances_root = state_root.join("instances");
    if !instances_root.exists() {
        return Ok(Vec::new());
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(instances_root)? {
        let instance_dir = entry?.path();
        if !instance_dir.is_dir() {
            continue;
        }
        let declaration_path = instance_dir.join("instance.json");
        if !declaration_path.exists() {
            continue;
        }
        let Ok(published) = read_json::<V3ManagedInstanceDeclaration>(&declaration_path) else {
            continue;
        };
        if !previous_owner_matches_restart_declaration(&published, expected) {
            continue;
        }
        if !previous_owner_has_live_control_truth(&instance_dir, &published)? {
            continue;
        }
        candidates.push((instance_dir, published));
    }
    candidates.sort_by(|(_, left), (_, right)| left.instance_id.cmp(&right.instance_id));
    Ok(candidates)
}

pub(crate) fn previous_owner_matches_restart_declaration(
    published: &V3ManagedInstanceDeclaration,
    expected: &V3ManagedInstanceDeclaration,
) -> bool {
    published.instance_id != expected.instance_id
        && published.config_path == expected.config_path
        && listener_sets_overlap(&published.listeners, &expected.listeners)
}

pub(crate) fn previous_owner_has_live_control_truth(
    instance_dir: &Path,
    published: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    if !instance_has_control_truth(instance_dir) {
        return Ok(false);
    }
    let pid: V3ManagedPidCache = read_json(&instance_dir.join("pid.cache"))?;
    let control: V3ManagedControlRecord = read_json(&instance_dir.join("control.json"))?;
    if pid.instance_id != published.instance_id
        || control.instance_id != published.instance_id
        || pid.start_nonce != control.start_nonce
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "previous restart owner pid/control cache does not match declaration".to_string(),
        ));
    }
    if !pid_is_alive(pid.pid) {
        return Ok(false);
    }
    let socket_path = PathBuf::from(&control.socket_path);
    if socket_path != managed_control_socket_path(&published.instance_id) || !socket_path.exists() {
        return Ok(false);
    }
    let status_path = instance_dir.join("status.json");
    if status_path.exists() {
        let status: V3ManagedStatusRecord = read_json(&status_path)?;
        if status.instance_id != published.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "previous restart owner status does not match declaration".to_string(),
            ));
        }
        if matches!(
            status.state,
            V3ManagedRunState::Stopped | V3ManagedRunState::Failed
        ) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn adopt_exec_restart_declaration_change(
    state_root: &Path,
    current_instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    if current_instance_dir.join("instance.json").exists() {
        return Ok(false);
    }
    let candidates = find_exec_restart_adoption_candidates(state_root, expected)?;
    let (previous_instance_dir, previous_declaration) = match candidates.as_slice() {
        [] => return Ok(false),
        [(instance_dir, declaration)] => (instance_dir.clone(), declaration.clone()),
        _ => {
            return Err(V3LifecycleError::IdentityMismatch(format!(
                "multiple exec restart adoption candidates match declaration {}",
                expected.instance_id
            )))
        }
    };
    ensure_private_dir(current_instance_dir)?;
    write_json_atomic(&current_instance_dir.join("instance.json"), expected)?;
    write_status(
        current_instance_dir,
        &expected.instance_id,
        V3ManagedRunState::Starting,
        Some(format!(
            "exec restart adopted changed declaration from {}",
            previous_declaration.instance_id
        )),
    )?;
    cleanup_previous_exec_restart_owner(&previous_instance_dir, &previous_declaration, expected)?;
    Ok(true)
}

pub(crate) fn find_exec_restart_adoption_candidates(
    state_root: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<Vec<(PathBuf, V3ManagedInstanceDeclaration)>, V3LifecycleError> {
    let instances_root = state_root.join("instances");
    if !instances_root.exists() {
        return Ok(Vec::new());
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(instances_root)? {
        let instance_dir = entry?.path();
        if !instance_dir.is_dir() {
            continue;
        }
        let declaration_path = instance_dir.join("instance.json");
        if !declaration_path.exists() {
            continue;
        }
        let Ok(published) = read_json::<V3ManagedInstanceDeclaration>(&declaration_path) else {
            continue;
        };
        if !previous_owner_matches_restart_declaration(&published, expected) {
            continue;
        }
        if !exec_restart_adoption_candidate_matches_current_process(&instance_dir, &published)? {
            continue;
        }
        candidates.push((instance_dir, published));
    }
    candidates.sort_by(|(_, left), (_, right)| left.instance_id.cmp(&right.instance_id));
    Ok(candidates)
}

pub(crate) fn exec_restart_adoption_candidate_matches_current_process(
    instance_dir: &Path,
    published: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    let pid_path = instance_dir.join("pid.cache");
    if !pid_path.exists() {
        return Ok(false);
    }
    let pid: V3ManagedPidCache = read_json(&pid_path)?;
    if pid.instance_id != published.instance_id || pid.pid != std::process::id() {
        return Ok(false);
    }
    let status_path = instance_dir.join("status.json");
    if !status_path.exists() {
        return Ok(false);
    }
    let status: V3ManagedStatusRecord = read_json(&status_path)?;
    if status.instance_id != published.instance_id || status.state != V3ManagedRunState::Starting {
        return Ok(false);
    }
    let control_path = instance_dir.join("control.json");
    if control_path.exists() {
        let control: V3ManagedControlRecord = read_json(&control_path)?;
        if control.instance_id != published.instance_id || control.start_nonce != pid.start_nonce {
            return Err(V3LifecycleError::IdentityMismatch(
                "exec restart adoption candidate pid/control cache does not match".to_string(),
            ));
        }
        if Path::new(&control.socket_path)
            != managed_control_socket_path(&published.instance_id).as_path()
        {
            return Err(V3LifecycleError::IdentityMismatch(
                "exec restart adoption candidate has non-canonical control socket".to_string(),
            ));
        }
    }
    Ok(true)
}

pub(crate) fn cleanup_previous_exec_restart_owner(
    previous_instance_dir: &Path,
    previous: &V3ManagedInstanceDeclaration,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    let control_path = previous_instance_dir.join("control.json");
    if control_path.exists() {
        let control: V3ManagedControlRecord = read_json(&control_path)?;
        if control.instance_id != previous.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to cleanup previous restart owner control for a different instance"
                    .to_string(),
            ));
        }
        let socket_path = PathBuf::from(&control.socket_path);
        if socket_path != managed_control_socket_path(&previous.instance_id) {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to cleanup previous restart owner non-canonical socket".to_string(),
            ));
        }
        if socket_path.exists() {
            fs::remove_file(socket_path)?;
        }
        fs::remove_file(control_path)?;
    }
    for file in ["pid.cache", RESTART_PLAN_FILE] {
        let path = previous_instance_dir.join(file);
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    write_status(
        previous_instance_dir,
        &previous.instance_id,
        V3ManagedRunState::Stopped,
        Some(format!(
            "exec restart transferred managed ownership to {}",
            expected.instance_id
        )),
    )?;
    Ok(())
}
