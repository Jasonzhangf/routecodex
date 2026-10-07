use super::*;

const PREVIOUS_RELEASE_RESTART_FILE: &str = "previous-release-restart.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct PreviousReleaseRestartTransfer {
    schema_version: u16,
    previous: V3ManagedInstanceDeclaration,
    pid: V3ManagedPidCache,
    target: V3ManagedInstanceDeclaration,
}

pub(crate) struct PreviousReleaseRestartGuard {
    path: PathBuf,
    transfer: PreviousReleaseRestartTransfer,
    cleanup: bool,
}

impl PreviousReleaseRestartGuard {
    pub(crate) fn retain_until_adoption(&mut self) {
        self.cleanup = false;
    }

    pub(crate) fn reject(&mut self) {
        self.cleanup = true;
    }
}

impl Drop for PreviousReleaseRestartGuard {
    fn drop(&mut self) {
        if !self.cleanup || !self.path.exists() {
            return;
        }
        let result = (|| -> Result<(), V3LifecycleError> {
            let current: PreviousReleaseRestartTransfer = read_json(&self.path)?;
            if current != self.transfer {
                return Err(V3LifecycleError::IdentityMismatch(
                    "restart transfer changed; retaining unrelated intent".into(),
                ));
            }
            fs::remove_file(&self.path)?;
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!(
                "restart transfer cleanup failed at {}: {error}",
                self.path.display()
            );
        }
    }
}

pub(crate) fn prepare_previous_release_restart_transfer(
    previous_dir: &Path,
    previous: &V3ManagedInstanceDeclaration,
    target_dir: &Path,
    target: &V3ManagedInstanceDeclaration,
) -> Result<Option<PreviousReleaseRestartGuard>, V3LifecycleError> {
    V3HooksSidecarSupervisor::ensure_exec_target_available(previous_dir, target_dir)?;
    if previous.instance_id == target.instance_id {
        return Ok(None);
    }
    if !listener_sets_exactly_match(&previous.listeners, &target.listeners) {
        return Err(V3LifecycleError::IdentityMismatch(
            "previous-release restart requires the exact managed listener set".into(),
        ));
    }
    let published: V3ManagedInstanceDeclaration = read_json(&previous_dir.join("instance.json"))?;
    let pid: V3ManagedPidCache = read_json(&previous_dir.join("pid.cache"))?;
    let control: V3ManagedControlRecord = read_json(&previous_dir.join("control.json"))?;
    if &published != previous
        || pid.schema_version != SCHEMA_VERSION
        || control.schema_version != SCHEMA_VERSION
        || pid.instance_id != previous.instance_id
        || control.instance_id != previous.instance_id
        || pid.start_nonce != control.start_nonce
        || Path::new(&control.socket_path) != managed_control_socket_path(&previous.instance_id)
        || !Path::new(&control.socket_path).exists()
        || pid.process_start_token.is_none()
        || process_start_token(pid.pid)? != pid.process_start_token
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "previous-release transfer does not match the live managed process".into(),
        ));
    }
    let transfer = PreviousReleaseRestartTransfer {
        schema_version: SCHEMA_VERSION,
        previous: previous.clone(),
        pid,
        target: target.clone(),
    };
    let path = target_dir.join(PREVIOUS_RELEASE_RESTART_FILE);
    let bytes = serde_json::to_vec(&transfer)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        if let Err(cleanup) = fs::remove_file(&path) {
            eprintln!("restart transfer partial-write cleanup failed: {cleanup}");
        }
        return Err(error.into());
    }
    Ok(Some(PreviousReleaseRestartGuard {
        path,
        transfer,
        cleanup: true,
    }))
}

pub(crate) fn bind_previous_release_restart_transfer(
    previous_dir: &Path,
    plan: &ControlRestartPlan,
) -> Result<Option<PreviousReleaseRestartGuard>, V3LifecycleError> {
    let target_dir = previous_dir
        .parent()
        .ok_or_else(|| V3LifecycleError::Validation("managed owner has no instances root".into()))?
        .join(&plan.declaration.instance_id);
    let path = target_dir.join(PREVIOUS_RELEASE_RESTART_FILE);
    if !path.try_exists()? {
        return Ok(None);
    }
    let transfer: PreviousReleaseRestartTransfer = read_json(&path)?;
    let published: V3ManagedInstanceDeclaration = read_json(&previous_dir.join("instance.json"))?;
    let pid: V3ManagedPidCache = read_json(&previous_dir.join("pid.cache"))?;
    if transfer.schema_version != SCHEMA_VERSION
        || transfer.previous != published
        || transfer.target != plan.declaration
        || transfer.pid != pid
        || pid.pid != std::process::id()
        || pid.start_nonce != plan.control_start_nonce
        || published.instance_id != plan.control_instance_id
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "restart transfer does not match the accepted owner-bound plan".into(),
        ));
    }
    Ok(Some(PreviousReleaseRestartGuard {
        path,
        transfer,
        cleanup: true,
    }))
}

pub(crate) fn adopt_previous_release_restart_declaration_change(
    state_root: &Path,
    current_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    let path = current_dir.join(PREVIOUS_RELEASE_RESTART_FILE);
    if !path.try_exists()? {
        return Ok(false);
    }
    let transfer: PreviousReleaseRestartTransfer = read_json(&path)?;
    let previous_dir = state_root
        .join("instances")
        .join(&transfer.previous.instance_id);
    let published: V3ManagedInstanceDeclaration = read_json(&previous_dir.join("instance.json"))?;
    let pid: V3ManagedPidCache = read_json(&previous_dir.join("pid.cache"))?;
    let status: V3ManagedStatusRecord = read_json(&previous_dir.join("status.json"))?;
    if transfer.schema_version != SCHEMA_VERSION
        || &transfer.target != expected
        || transfer.previous != published
        || transfer.pid != pid
        || pid.pid != std::process::id()
        || pid.process_start_token.is_none()
        || process_start_token(pid.pid)? != pid.process_start_token
        || published.instance_id == expected.instance_id
        || pid.instance_id != published.instance_id
        || status.instance_id != published.instance_id
        || status.state != V3ManagedRunState::Starting
        || !listener_sets_exactly_match(&published.listeners, &expected.listeners)
        || previous_dir.join("control.json").try_exists()?
        || managed_control_socket_path(&published.instance_id).try_exists()?
        || current_dir.join("pid.cache").try_exists()?
        || current_dir.join("control.json").try_exists()?
        || current_dir
            .join(EXEC_RESTART_DECLARATION_FILE)
            .try_exists()?
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "previous-release exec transfer does not match the exact replacement process".into(),
        ));
    }
    let _: Vec<serde_json::Value> = read_json(&previous_dir.join(FRONT_HANDOFF_FILE))?;
    let _: Vec<routecodex_v3_provider_responses::V3ProviderTransportCheckpoint> =
        read_json(&previous_dir.join(PROVIDER_HANDOFF_FILE))?;
    for file in [FRONT_HANDOFF_FILE, PROVIDER_HANDOFF_FILE] {
        if current_dir.join(file).try_exists()? {
            return Err(V3LifecycleError::IdentityMismatch(
                "previous-release target handoff already exists".into(),
            ));
        }
    }
    finish_exec_restart_adoption(&previous_dir, current_dir, &published, expected, None)?;
    fs::remove_file(path)?;
    Ok(true)
}

fn listener_sets_overlap(
    left: &[V3ManagedListenerDeclaration],
    right: &[V3ManagedListenerDeclaration],
) -> bool {
    let right_ports = right
        .iter()
        .map(|listener| listener.port)
        .collect::<BTreeSet<_>>();
    left.iter()
        .any(|listener| right_ports.contains(&listener.port))
}

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
        && ((published.config_path == expected.config_path
            && listener_sets_overlap(&published.listeners, &expected.listeners))
            || listener_sets_exactly_match(&published.listeners, &expected.listeners))
}

fn listener_sets_exactly_match(
    left: &[V3ManagedListenerDeclaration],
    right: &[V3ManagedListenerDeclaration],
) -> bool {
    let declarations = |listeners: &[V3ManagedListenerDeclaration]| {
        listeners
            .iter()
            .map(|listener| {
                (
                    listener.server_id.clone(),
                    listener.bind.clone(),
                    listener.port,
                )
            })
            .collect::<BTreeSet<_>>()
    };
    declarations(left) == declarations(right)
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
    owner: &ExecRestartOwner,
) -> Result<PathBuf, V3LifecycleError> {
    let previous_instance_dir = state_root.join("instances").join(&owner.instance_id);
    let previous_declaration: V3ManagedInstanceDeclaration =
        read_json(&previous_instance_dir.join("instance.json"))?;
    let pid: V3ManagedPidCache = read_json(&previous_instance_dir.join("pid.cache"))?;
    let control: V3ManagedControlRecord = read_json(&previous_instance_dir.join("control.json"))?;
    if previous_declaration.instance_id != owner.instance_id
        || pid.instance_id != owner.instance_id
        || control.instance_id != owner.instance_id
        || pid.pid != std::process::id()
        || pid.start_nonce != owner.start_nonce
        || control.start_nonce != owner.start_nonce
        || Path::new(&control.socket_path) != managed_control_socket_path(&owner.instance_id)
        || !(same_instance_declaration_except_executable_path(&previous_declaration, expected)
            || previous_owner_matches_restart_declaration(&previous_declaration, expected))
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "exec restart exact old owner does not match current process and target".into(),
        ));
    }
    let staged_declaration = current_instance_dir.join(EXEC_RESTART_DECLARATION_FILE);
    let staged: V3ManagedInstanceDeclaration = read_json(&staged_declaration)?;
    if &staged != expected {
        return Err(V3LifecycleError::IdentityMismatch(
            "prepared restart declaration does not match replacement image".into(),
        ));
    }
    finish_exec_restart_adoption(
        &previous_instance_dir,
        current_instance_dir,
        &previous_declaration,
        expected,
        Some(&staged_declaration),
    )?;
    let transfer_path = current_instance_dir.join(PREVIOUS_RELEASE_RESTART_FILE);
    if transfer_path.try_exists()? {
        let transfer: PreviousReleaseRestartTransfer = read_json(&transfer_path)?;
        if transfer.previous != previous_declaration
            || transfer.pid != pid
            || &transfer.target != expected
        {
            return Err(V3LifecycleError::IdentityMismatch(
                "current exec transfer changed".into(),
            ));
        }
        fs::remove_file(transfer_path)?;
    }
    Ok(previous_instance_dir)
}

fn finish_exec_restart_adoption(
    previous_instance_dir: &Path,
    current_instance_dir: &Path,
    previous_declaration: &V3ManagedInstanceDeclaration,
    expected: &V3ManagedInstanceDeclaration,
    staged_declaration: Option<&Path>,
) -> Result<(), V3LifecycleError> {
    ensure_private_dir(current_instance_dir)?;
    V3HooksSidecarSupervisor::retain_exec_owner(previous_instance_dir, current_instance_dir)?;
    if previous_instance_dir != current_instance_dir {
        for file in [FRONT_HANDOFF_FILE, PROVIDER_HANDOFF_FILE] {
            fs::rename(
                previous_instance_dir.join(file),
                current_instance_dir.join(file),
            )?;
        }
    }
    if let Some(staged_declaration) = staged_declaration {
        fs::rename(
            staged_declaration,
            current_instance_dir.join("instance.json"),
        )?;
    } else {
        write_json_atomic(&current_instance_dir.join("instance.json"), expected)?;
    }
    write_status(
        current_instance_dir,
        &expected.instance_id,
        V3ManagedRunState::Starting,
        Some(format!(
            "exec restart adopted changed declaration from {}",
            previous_declaration.instance_id
        )),
    )?;
    if previous_instance_dir != current_instance_dir {
        cleanup_previous_exec_restart_owner(previous_instance_dir, previous_declaration, expected)?;
    } else {
        fs::remove_file(managed_control_socket_path(
            &previous_declaration.instance_id,
        ))?;
        fs::remove_file(previous_instance_dir.join("control.json"))?;
    }
    Ok(())
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
