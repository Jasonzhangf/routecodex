use super::*;

pub(crate) const PREVIOUS_RELEASE_RESTART_FILE: &str = "previous-release-restart.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct PreviousReleaseRestartTransfer {
    schema_version: u16,
    previous: V3ManagedInstanceDeclaration,
    pid: V3ManagedPidCache,
    target: V3ManagedInstanceDeclaration,
}

pub(crate) async fn retire_abandoned_previous_release_transfer(
    current_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    let path = current_dir.join(PREVIOUS_RELEASE_RESTART_FILE);
    let Some((transfer, previous_dir)) = previous_transfer(current_dir, expected)? else {
        return Ok(());
    };
    if pid_is_alive(transfer.pid.pid) || process_start_token(transfer.pid.pid)?.is_some() {
        return Err(V3LifecycleError::IdentityMismatch(
            "previous-release transfer still has a live or changed owner".into(),
        ));
    }
    if interrupted_legacy_transfer(current_dir, expected)?.is_some()
        || has_exact_front_control_handoff(current_dir)?
    {
        recover_exited_front_control_handoff(current_dir, expected).await?;
        return Ok(());
    }
    let _lock = acquire_operation_lock(&previous_dir, "recover-control")?;
    // A dead transfer with no prepared handoffs is the pre-adoption interval.
    // Never retire it in isolation if a checkpoint still needs disposition.
    for file in [FRONT_HANDOFF_FILE, PROVIDER_HANDOFF_FILE] {
        if exclusive_handoff_location(&previous_dir, current_dir, file)?.is_some() {
            return Err(V3LifecycleError::IdentityMismatch(
                "previous-release handoff requires verified reconciliation".into(),
            ));
        }
    }
    let target_pid_path = current_dir.join("pid.cache");
    if target_pid_path.try_exists()? {
        let target_pid: V3ManagedPidCache = read_json(&target_pid_path)?;
        if target_pid.instance_id != expected.instance_id || pid_is_alive(target_pid.pid) {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to retire transfer while target ownership is live or conflicting".into(),
            ));
        }
    }
    let target_control_path = current_dir.join("control.json");
    if target_control_path.try_exists()? {
        let control: V3ManagedControlRecord = read_json(&target_control_path)?;
        if control.instance_id != expected.instance_id
            || Path::new(&control.socket_path) != managed_control_socket_path(&control.instance_id)
            || Path::new(&control.socket_path).try_exists()?
        {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to retire transfer while target control is live or conflicting".into(),
            ));
        }
    }
    let previous_path = previous_dir.join("instance.json");
    if read_json::<V3ManagedInstanceDeclaration>(&previous_path)? != transfer.previous {
        return Err(V3LifecycleError::IdentityMismatch(
            "previous declaration differs from abandoned transfer".into(),
        ));
    }
    let pid_path = previous_dir.join("pid.cache");
    if read_json::<V3ManagedPidCache>(&pid_path)? != transfer.pid {
        return Err(V3LifecycleError::IdentityMismatch(
            "previous PID record differs from abandoned transfer".into(),
        ));
    }
    let control_path = previous_dir.join("control.json");
    if control_path.try_exists()? {
        let control: V3ManagedControlRecord = read_json(&control_path)?;
        if control.schema_version != SCHEMA_VERSION
            || control.instance_id != transfer.previous.instance_id
            || control.start_nonce != transfer.pid.start_nonce
            || Path::new(&control.socket_path) != managed_control_socket_path(&control.instance_id)
        {
            return Err(V3LifecycleError::IdentityMismatch(
                "previous control record differs from abandoned transfer".into(),
            ));
        }
    }
    if pid_is_alive(transfer.pid.pid)
        || process_start_token(transfer.pid.pid)?.is_some()
        || read_json::<PreviousReleaseRestartTransfer>(&path)? != transfer
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "previous-release transfer still has a live or changed owner".into(),
        ));
    }
    fs::remove_file(path)?;
    Ok(())
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
    if !managed_control_matches_declaration(previous, &published, &pid, &control)
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

fn previous_transfer(
    dir: &Path,
    target: &V3ManagedInstanceDeclaration,
) -> Result<Option<(PreviousReleaseRestartTransfer, PathBuf)>, V3LifecycleError> {
    let path = dir.join(PREVIOUS_RELEASE_RESTART_FILE);
    if !regular_handoff_exists(&path)? {
        return Ok(None);
    }
    let transfer: PreviousReleaseRestartTransfer = read_json(&path)?;
    let id = &transfer.previous.instance_id;
    if transfer.schema_version != SCHEMA_VERSION
        || transfer.previous.schema_version != SCHEMA_VERSION
        || transfer.target != *target
        || id == &target.instance_id
        || Path::new(id).file_name() != Some(std::ffi::OsStr::new(id))
        || transfer.pid.schema_version != SCHEMA_VERSION
        || transfer.pid.instance_id != *id
        || transfer.pid.pid == 0
        || transfer.pid.start_nonce.is_empty()
        || transfer
            .pid
            .process_start_token
            .as_deref()
            .is_none_or(str::is_empty)
        || !listener_sets_exactly_match(&transfer.previous.listeners, &target.listeners)
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "invalid previous-release transfer".into(),
        ));
    }
    let previous = dir.with_file_name(id);
    Ok(Some((transfer, previous)))
}

// This selector cannot authorize a write. Native staged handoffs already
// select exact recovery and keep their own independent verification.
pub(crate) fn interrupted_legacy_transfer(
    dir: &Path,
    target: &V3ManagedInstanceDeclaration,
) -> Result<Option<PathBuf>, V3LifecycleError> {
    let Some((transfer, previous)) = previous_transfer(dir, target)? else {
        return Ok(None);
    };
    if pid_is_alive(transfer.pid.pid)
        || regular_handoff_exists(&dir.join(EXEC_RESTART_DECLARATION_FILE))?
    {
        return Ok(None);
    }
    if has_exact_front_control_handoff(dir)?
        && regular_handoff_exists(&dir.join("pid.cache"))?
        && regular_handoff_exists(&dir.join("instance.json"))?
    {
        return Ok(None);
    }
    for owner in [dir, previous.as_path()] {
        for file in [FRONT_HANDOFF_FILE, PROVIDER_HANDOFF_FILE] {
            if regular_handoff_exists(&owner.join(file))? {
                return Ok(Some(previous.clone()));
            }
        }
    }
    Ok(None)
}

pub(crate) fn normalize_previous_release_handoff(
    dir: &Path,
    target: &V3ManagedInstanceDeclaration,
    live_exec: bool,
) -> Result<Option<ManagedFrontControlHandoff>, V3LifecycleError> {
    let Some((transfer, previous)) = previous_transfer(dir, target)? else {
        return Ok(None);
    };
    let origin = transfer.pid;
    let status: V3ManagedStatusRecord = read_json(&previous.join("status.json"))?;
    let token = process_start_token(origin.pid)?;
    let right_process = if live_exec {
        origin.pid == std::process::id() && token == origin.process_start_token
    } else {
        !pid_is_alive(origin.pid) && token.is_none()
    };
    if !right_process
        || read_json::<V3ManagedInstanceDeclaration>(&previous.join("instance.json"))?
            != transfer.previous
        || read_json::<V3ManagedPidCache>(&previous.join("pid.cache"))? != origin
        || status.instance_id != origin.instance_id
        || status.state != V3ManagedRunState::Starting
        || (live_exec
            && (regular_handoff_exists(&previous.join("control.json"))?
                || managed_control_socket_path(&origin.instance_id).try_exists()?))
        || regular_handoff_exists(&dir.join("control.json"))?
        || regular_handoff_exists(&dir.join(EXEC_RESTART_DECLARATION_FILE))?
        || (regular_handoff_exists(&dir.join("instance.json"))?
            && read_json::<V3ManagedInstanceDeclaration>(&dir.join("instance.json"))? != *target)
        || (regular_handoff_exists(&dir.join("status.json"))?
            && read_json::<V3ManagedStatusRecord>(&dir.join("status.json"))?.instance_id
                != target.instance_id)
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "previous-release exec transfer does not match the exact replacement process".into(),
        ));
    }
    let front =
        exclusive_handoff_location(&previous, dir, FRONT_HANDOFF_FILE)?.ok_or_else(|| {
            V3LifecycleError::IdentityMismatch("missing previous-release front".into())
        })?;
    let provider =
        exclusive_handoff_location(&previous, dir, PROVIDER_HANDOFF_FILE)?.ok_or_else(|| {
            V3LifecycleError::IdentityMismatch(
                "missing previous-release provider checkpoint".into(),
            )
        })?;
    validate_transition_records(&previous, &transfer.previous, &origin, target)?;
    if (live_exec && (front.parent() != Some(&previous) || provider.parent() != Some(&previous)))
        || (front.parent() == Some(&previous) && provider.parent() != Some(&previous))
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "previous-release target handoff already exists".into(),
        ));
    }
    // Before adoption both arrays belong to the old handler. A partial fresh
    // invocation may already have normalized the target front.
    if live_exec {
        let _: Vec<routecodex_v3_provider_responses::V3ProviderTransportCheckpoint> =
            read_json(&provider)?;
    }
    let target_front = dir.join(FRONT_HANDOFF_FILE);
    let handoff = if front == target_front && has_exact_front_control_handoff(dir)? {
        let existing: ManagedFrontControlHandoff = read_json(&front)?;
        if existing.origin != origin
            || existing.declaration != *target
            || !existing.controls.is_empty()
        {
            return Err(V3LifecycleError::IdentityMismatch(
                "previous-release front identity differs".into(),
            ));
        }
        existing
    } else {
        ManagedFrontControlHandoff {
            declaration: target.clone(),
            origin,
            checkpoints: read_json(&front)?,
            controls: Default::default(),
        }
    };
    let cache = dir.join("pid.cache");
    if regular_handoff_exists(&cache)?
        && (live_exec
            || !cache_authorizes_control_origin(&read_json(&cache)?, &handoff.origin, target))
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "previous-release target PID cache differs".into(),
        ));
    }
    if front != target_front {
        fs::rename(front, &target_front)?;
    }
    write_json_atomic(&target_front, &handoff)?;
    if !live_exec {
        write_json_atomic(&dir.join("instance.json"), target)?;
        if !regular_handoff_exists(&cache)? {
            let successor = V3ManagedPidCache {
                instance_id: target.instance_id.clone(),
                retained_control: Some(handoff.link()),
                ..handoff.origin.clone()
            };
            write_json_atomic(&cache, &successor)?;
        }
    }
    Ok(Some(handoff))
}

pub(crate) fn adopt_previous_release_restart_declaration_change(
    current_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
    handoff: &ManagedFrontControlHandoff,
    successor: &V3ManagedPidCache,
) -> Result<(), V3LifecycleError> {
    let previous = current_dir.with_file_name(&handoff.origin.instance_id);
    let published = read_json(&previous.join("instance.json"))?;
    write_json_atomic(&current_dir.join("pid.cache"), successor)?;
    finish_exec_restart_adoption(
        &previous,
        current_dir,
        &published,
        &handoff.origin,
        expected,
        None,
    )
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
    let candidates = find_live_published_owners(state_root, |published| {
        previous_owner_matches_restart_declaration(published, expected)
    })?;
    match candidates.as_slice() {
        [] => Ok(None),
        [(instance_dir, declaration)] => Ok(Some((instance_dir.clone(), declaration.clone()))),
        _ => Err(V3LifecycleError::IdentityMismatch(format!(
            "multiple live previous managed owners match restart declaration {}",
            expected.instance_id
        ))),
    }
}

pub(crate) fn find_live_published_owners(
    state_root: &Path,
    matches: impl Fn(&V3ManagedInstanceDeclaration) -> bool,
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
        if !matches(&published) {
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
    if let Some(recorded_token) = &pid.process_start_token {
        if process_start_token(pid.pid)?.as_ref() != Some(recorded_token) {
            return Ok(false);
        }
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
    successor: &V3ManagedPidCache,
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
    validate_transition_records(
        &previous_instance_dir,
        &previous_declaration,
        &pid,
        expected,
    )?;
    if previous_instance_dir != current_instance_dir
        && regular_handoff_exists(&current_instance_dir.join("pid.cache"))?
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "restart target already has a PID cache".into(),
        ));
    }
    write_json_atomic(&current_instance_dir.join("pid.cache"), successor)?;
    finish_exec_restart_adoption(
        &previous_instance_dir,
        current_instance_dir,
        &previous_declaration,
        &pid,
        expected,
        Some(&staged_declaration),
    )?;
    Ok(previous_instance_dir)
}

pub(crate) fn close_verified_restart_transfer(
    dir: &Path,
    previous: &V3ManagedInstanceDeclaration,
    pid: &V3ManagedPidCache,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    if let Some(path) = verify_restart_transfer(dir, previous, pid, expected)? {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub(crate) fn verify_restart_transfer(
    current_instance_dir: &Path,
    previous: &V3ManagedInstanceDeclaration,
    pid: &V3ManagedPidCache,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<Option<PathBuf>, V3LifecycleError> {
    let transfer_path = current_instance_dir.join(PREVIOUS_RELEASE_RESTART_FILE);
    match fs::symlink_metadata(&transfer_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(metadata) if !metadata.is_file() => Err(V3LifecycleError::IdentityMismatch(
            "current exec transfer is not a regular file".into(),
        )),
        Ok(_) => {
            let transfer: PreviousReleaseRestartTransfer = read_json(&transfer_path)?;
            if transfer.schema_version != SCHEMA_VERSION
                || &transfer.previous != previous
                || &transfer.pid != pid
                || &transfer.target != expected
            {
                return Err(V3LifecycleError::IdentityMismatch(
                    "current exec transfer changed".into(),
                ));
            }
            Ok(Some(transfer_path))
        }
    }
}

fn finish_exec_restart_adoption(
    previous_instance_dir: &Path,
    current_instance_dir: &Path,
    previous_declaration: &V3ManagedInstanceDeclaration,
    previous_pid: &V3ManagedPidCache,
    expected: &V3ManagedInstanceDeclaration,
    staged_declaration: Option<&Path>,
) -> Result<(), V3LifecycleError> {
    ensure_private_dir(current_instance_dir)?;
    V3HooksSidecarSupervisor::retain_exec_owner(previous_instance_dir, current_instance_dir)?;
    if previous_instance_dir != current_instance_dir {
        if exclusive_handoff_location(
            previous_instance_dir,
            current_instance_dir,
            PROVIDER_HANDOFF_FILE,
        )? != Some(previous_instance_dir.join(PROVIDER_HANDOFF_FILE))
        {
            return Err(V3LifecycleError::IdentityMismatch(
                "provider handoff must be at the verified predecessor".into(),
            ));
        }
        fs::rename(
            previous_instance_dir.join(PROVIDER_HANDOFF_FILE),
            current_instance_dir.join(PROVIDER_HANDOFF_FILE),
        )?;
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
    close_verified_restart_transfer(
        current_instance_dir,
        previous_declaration,
        previous_pid,
        expected,
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
    } else {
        reap_unowned_managed_control_socket(previous_instance_dir, previous)?;
    }
    let front = previous_instance_dir.join(FRONT_HANDOFF_FILE);
    if regular_handoff_exists(&front)? {
        fs::remove_file(front)?;
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
    for file in [RESTART_PLAN_FILE, "pid.cache"] {
        let path = previous_instance_dir.join(file);
        if regular_handoff_exists(&path)? {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}
