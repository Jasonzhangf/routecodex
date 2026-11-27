use super::*;
use routecodex_v3_server::{V3ActiveKeyControlStartup, V3RuntimeHandoffCheckpoint};

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManagedFrontControlHandoff {
    pub(crate) declaration: V3ManagedInstanceDeclaration,
    pub(crate) origin: V3ManagedPidCache,
    pub(crate) checkpoints: Vec<V3RuntimeHandoffCheckpoint>,
    pub(crate) controls: V3ActiveKeyControlExecHandoff,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum FrontHandoff {
    Legacy(Vec<V3RuntimeHandoffCheckpoint>),
    Exact(ManagedFrontControlHandoff),
}

fn read_front_handoff(path: &Path) -> Result<Option<FrontHandoff>, V3LifecycleError> {
    if !regular_handoff_exists(path)? {
        return Ok(None);
    }
    Ok(Some(read_json(path)?))
}

pub(crate) fn has_exact_front_control_handoff(
    instance_dir: &Path,
) -> Result<bool, V3LifecycleError> {
    Ok(matches!(
        read_front_handoff(&instance_dir.join(FRONT_HANDOFF_FILE))?,
        Some(FrontHandoff::Exact(_))
    ))
}

pub(super) fn verified_forced_stop_front(
    dir: &Path,
    target: &V3ManagedInstanceDeclaration,
    witness: &ForcedGeneration,
) -> Result<bool, V3LifecycleError> {
    let Some(FrontHandoff::Exact(front)) = read_front_handoff(&dir.join(FRONT_HANDOFF_FILE))?
    else {
        return Ok(false);
    };
    if front.declaration != *target
        || !cache_authorizes_control_origin(&witness.cache, &front.origin, target)
        || !regular_handoff_exists(&dir.join("pid.cache"))?
        || !regular_handoff_exists(&dir.join("instance.json"))?
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "forced stop retains unverified front custody".into(),
        ));
    }
    verify_exited_control_authority(dir, target, &front.origin, false)?;
    verify_generation_restart_plan(dir, &witness.cache, target)?;
    witness.check_current(dir)?;
    Ok(true)
}

pub(crate) fn verify_exec_front_control_handoff(
    previous_dir: &Path,
    target_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    owner: &mut ExecRestartOwner,
) -> Result<ManagedFrontControlHandoff, V3LifecycleError> {
    let path = target_dir.join(FRONT_HANDOFF_FILE);
    let (handoff, migrate) = match read_front_handoff(&path)? {
        Some(FrontHandoff::Exact(handoff)) => {
            if previous_dir != target_dir {
                read_live_retained_front_control_handoff(
                    previous_dir,
                    &owner.instance_id,
                    &owner.start_nonce,
                )?;
            }
            (handoff, false)
        }
        legacy => {
            let controls = owner.active_key_controls.take().unwrap_or_default();
            let legacy = if previous_dir == target_dir {
                legacy
            } else {
                if legacy.is_some() {
                    return Err(V3LifecycleError::IdentityMismatch(
                        "exec target front handoff already exists".into(),
                    ));
                }
                read_front_handoff(&previous_dir.join(FRONT_HANDOFF_FILE))?
            };
            let Some(FrontHandoff::Legacy(checkpoints)) = legacy else {
                return Err(V3LifecycleError::IdentityMismatch(
                    "exec control custody has no legacy front artifact".into(),
                ));
            };
            (
                ManagedFrontControlHandoff {
                    declaration: declaration.clone(),
                    origin: read_json(&previous_dir.join("pid.cache"))?,
                    checkpoints,
                    controls,
                },
                true,
            )
        }
    };
    let origin: V3ManagedPidCache = read_json(&previous_dir.join("pid.cache"))?;
    let control: V3ManagedControlRecord = read_json(&previous_dir.join("control.json"))?;
    let previous: V3ManagedInstanceDeclaration = read_json(&previous_dir.join("instance.json"))?;
    let staged: V3ManagedInstanceDeclaration =
        read_json(&target_dir.join(EXEC_RESTART_DECLARATION_FILE))?;
    if handoff.declaration != *declaration
        || staged != *declaration
        || !(same_instance_declaration_except_executable_path(&previous, declaration)
            || previous_owner_matches_restart_declaration(&previous, declaration))
        || previous.instance_id != owner.instance_id
        || handoff.origin != origin
        || origin.schema_version != SCHEMA_VERSION
        || origin.instance_id != owner.instance_id
        || origin.start_nonce != owner.start_nonce
        || origin.pid != std::process::id()
        || origin.process_start_token.is_none()
        || process_start_token(origin.pid)? != origin.process_start_token
        || control.schema_version != SCHEMA_VERSION
        || control.instance_id != owner.instance_id
        || control.start_nonce != owner.start_nonce
        || Path::new(&control.socket_path) != managed_control_socket_path(&owner.instance_id)
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "exec front control custody does not match the verified owner and target".into(),
        ));
    }
    handoff.controls.validate_managed_startup()?;
    if previous_dir != target_dir {
        if exclusive_handoff_location(previous_dir, target_dir, PROVIDER_HANDOFF_FILE)?
            != Some(previous_dir.join(PROVIDER_HANDOFF_FILE))
        {
            return Err(V3LifecycleError::IdentityMismatch(
                "provider handoff must be at the verified predecessor".into(),
            ));
        }
        validate_transition_records(previous_dir, &previous, &origin, declaration)?;
        verify_restart_transfer(target_dir, &previous, &origin, declaration)?;
    }
    // The old environment format needs to be made durable before adoption.
    if migrate {
        write_json_atomic(&path, &handoff)?;
    }
    Ok(handoff)
}

pub(crate) fn legacy_front_checkpoints(
    path: &Path,
) -> Result<Vec<V3RuntimeHandoffCheckpoint>, V3LifecycleError> {
    match read_front_handoff(path)? {
        None => Ok(Vec::new()),
        Some(FrontHandoff::Legacy(checkpoints)) => Ok(checkpoints),
        Some(FrontHandoff::Exact(_)) => Err(V3LifecycleError::IdentityMismatch(
            "managed startup requires verified ownership of the exact front handoff".into(),
        )),
    }
}

pub(crate) async fn finish_failed_front_control_handoff(
    instance_dir: &Path,
    startup: &V3ActiveKeyControlStartup,
) -> Result<Option<routecodex_v3_server::V3ServerCloseReport>, V3LifecycleError> {
    let mut controls = startup.snapshot();
    let Some(FrontHandoff::Exact(handoff)) =
        read_front_handoff(&instance_dir.join(FRONT_HANDOFF_FILE))?
    else {
        return Ok(None);
    };
    if handoff.controls != controls {
        return Err(V3LifecycleError::IdentityMismatch(
            "durable active-key startup custody changed before cleanup".into(),
        ));
    }
    let failures = controls.retire_failed_startup().await?;
    Ok(Some(routecodex_v3_server::V3ServerCloseReport {
        pending_controls: (!controls.is_empty()).then_some(controls),
        control_cleanup_failures: failures,
        ..Default::default()
    }))
}

fn remove_exact_staged_declaration(
    front_path: &Path,
    declaration: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    let path = front_path.with_file_name(EXEC_RESTART_DECLARATION_FILE);
    if path.try_exists()? {
        if read_json::<V3ManagedInstanceDeclaration>(&path)? != *declaration {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to remove a different staged restart declaration".into(),
            ));
        }
        fs::remove_file(path)?;
    }
    Ok(())
}

pub(crate) fn close_failed_startup_control_files(
    instance_dir: &Path,
    socket_path: &Path,
) -> Result<(), V3LifecycleError> {
    for path in [socket_path.to_path_buf(), instance_dir.join("control.json")] {
        match fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
    }
    Ok(())
}

pub(crate) fn remove_settled_pid_cache(instance_dir: &Path) -> Result<(), V3LifecycleError> {
    if !regular_handoff_exists(&instance_dir.join(FRONT_HANDOFF_FILE))? {
        if regular_handoff_exists(&instance_dir.join(RESTART_PLAN_FILE))? {
            return Err(V3LifecycleError::IdentityMismatch(
                "retaining managed cache for unresolved restart plan".into(),
            ));
        }
        let cache = instance_dir.join("pid.cache");
        if regular_handoff_exists(&cache)? {
            fs::remove_file(cache)?;
        }
    }
    Ok(())
}

impl ManagedFrontControlHandoff {
    pub(crate) fn link(&self) -> V3RetainedControlGeneration {
        V3RetainedControlGeneration {
            target: self.declaration.clone(),
            instance_id: self.origin.instance_id.clone(),
            start_nonce: self.origin.start_nonce.clone(),
            started_at_epoch_ms: self.origin.started_at_epoch_ms,
        }
    }

    pub(crate) fn into_startup(self, path: PathBuf) -> V3ActiveKeyControlStartup {
        V3ActiveKeyControlStartup::new(self.controls.clone(), move |controls| {
            self.persist(&path, controls).map_err(|error| match error {
                V3LifecycleError::Io(error) => error,
                error => std::io::Error::other(error),
            })
        })
    }

    fn persist(
        &self,
        path: &Path,
        controls: &V3ActiveKeyControlExecHandoff,
    ) -> Result<(), V3LifecycleError> {
        #[derive(Serialize)]
        struct FrontControlView<'a> {
            declaration: &'a V3ManagedInstanceDeclaration,
            origin: &'a V3ManagedPidCache,
            checkpoints: &'a [V3RuntimeHandoffCheckpoint],
            controls: &'a V3ActiveKeyControlExecHandoff,
        }
        write_json_atomic(
            path,
            &FrontControlView {
                declaration: &self.declaration,
                origin: &self.origin,
                checkpoints: &self.checkpoints,
                controls,
            },
        )
    }
}

pub(crate) fn persist_retained_front_control_handoff(
    instance_dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
    controls: Option<V3ActiveKeyControlExecHandoff>,
) -> Result<(), V3LifecycleError> {
    let path = instance_dir.join(FRONT_HANDOFF_FILE);
    // Front checkpoints cannot restore accepted descriptors. Live records and
    // unsettled alternatives remain actionable until Server resolves them.
    if let Some(controls) = controls {
        write_json_atomic(
            &path,
            &ManagedFrontControlHandoff {
                declaration: declaration.clone(),
                origin: read_json(&instance_dir.join("pid.cache"))?,
                checkpoints: Vec::new(),
                controls,
            },
        )
    } else {
        match fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }
}

pub(crate) fn read_live_retained_front_control_handoff(
    instance_dir: &Path,
    owner_id: &str,
    start_nonce: &str,
) -> Result<Option<ManagedFrontControlHandoff>, V3LifecycleError> {
    let path = instance_dir.join(FRONT_HANDOFF_FILE);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(V3LifecycleError::IdentityMismatch(format!(
                "restart handoff already exists; original owner retained: {}",
                path.display()
            )))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    match read_front_handoff(&path)? {
        None => Ok(None),
        Some(FrontHandoff::Exact(handoff)) => {
            let cache: V3ManagedPidCache = read_json(&instance_dir.join("pid.cache"))?;
            let declaration: V3ManagedInstanceDeclaration =
                read_json(&instance_dir.join("instance.json"))?;
            if cache_authorizes_control_origin(&cache, &handoff.origin, &declaration)
                && handoff.declaration == declaration
                && cache.pid == std::process::id()
                && cache.instance_id == owner_id
                && cache.start_nonce == start_nonce
                && cache.process_start_token.is_some()
                && process_start_token(cache.pid)? == cache.process_start_token
            {
                handoff.controls.validate_managed_startup()?;
                return Ok(Some(handoff));
            }
            Err(V3LifecycleError::IdentityMismatch(
                "existing front control custody belongs to a different managed owner".into(),
            ))
        }
        Some(FrontHandoff::Legacy(_)) => Err(V3LifecycleError::IdentityMismatch(
            "restart front handoff already exists; original owner retained".into(),
        )),
    }
}

// This selects the recovery path only. Recovery independently checks exit,
// declaration, retained origin and control before it modifies any record.
pub(crate) fn exited_restart_handoff_requires_reconciliation(
    dir: &Path,
    target: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    let path = dir.join(FRONT_HANDOFF_FILE);
    if !listener_set_is_available(&target.listeners) {
        return Ok(false);
    }
    if exec_restart::interrupted_legacy_transfer(dir, target)?.is_some() {
        return Ok(true);
    }
    Ok(
        matches!(read_front_handoff(&path)?, Some(FrontHandoff::Exact(handoff))
        if handoff.declaration == *target && !pid_is_alive(handoff.origin.pid)),
    )
}

pub(crate) enum ExitedHandoffRecovery {
    NoExactHandoff,
    Recovered,
}

pub(crate) async fn recover_exited_front_control_handoff(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<ExitedHandoffRecovery, V3LifecycleError> {
    let path = instance_dir.join(FRONT_HANDOFF_FILE);
    // Convert a legacy checkpoint only while its independent transfer and
    // predecessor generation still exist. Exact recovery owns all disposal.
    let legacy_lock = if let Some(previous) =
        exec_restart::interrupted_legacy_transfer(instance_dir, expected)?
    {
        let lock = acquire_operation_lock(&previous, "recover-control")?;
        exec_restart::normalize_previous_release_handoff(instance_dir, expected, false)?;
        Some(lock)
    } else {
        None
    };
    let mut handoff = match read_front_handoff(&path)? {
        Some(FrontHandoff::Exact(handoff)) => handoff,
        None if !regular_handoff_exists(&instance_dir.join(PROVIDER_HANDOFF_FILE))? => {
            return Ok(ExitedHandoffRecovery::NoExactHandoff);
        }
        _ => {
            return Err(V3LifecycleError::IdentityMismatch(
                "fresh startup cannot restore an unverified restart handoff".into(),
            ))
        }
    };
    let origin = &handoff.origin;
    if &handoff.declaration != expected
        || Path::new(&origin.instance_id).file_name()
            != Some(std::ffi::OsStr::new(&origin.instance_id))
        || !managed_generation_has_exited(origin)?
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "active-key startup recovery requires the exact declaration and an exited managed owner".into(),
        ));
    }
    // An interrupted directory change can leave the verified predecessor's
    // control socket and copy of the front artifact in its original directory.
    // Serialize with operations on that directory before touching its evidence.
    let previous_dir = instance_dir.with_file_name(&origin.instance_id);
    let previous_cache = previous_dir.join("pid.cache");
    let previous_control = previous_dir.join("control.json");
    let staged = instance_dir.join(EXEC_RESTART_DECLARATION_FILE);
    let transfer = instance_dir.join(exec_restart::PREVIOUS_RELEASE_RESTART_FILE);
    let unfinished =
        previous_dir != instance_dir && (staged.try_exists()? || handoff_leaf_exists(&transfer)?);
    let previous_lock = if legacy_lock.is_some() {
        legacy_lock
    } else if previous_dir != instance_dir
        && (unfinished
            || regular_handoff_exists(&previous_cache)?
            || regular_handoff_exists(&previous_control)?
            || regular_handoff_exists(&previous_dir.join(RESTART_PLAN_FILE))?
            || regular_handoff_exists(&previous_dir.join(FRONT_HANDOFF_FILE))?)
    {
        Some(acquire_operation_lock(&previous_dir, "recover-control")?)
    } else {
        None
    };
    verify_exited_control_authority(
        instance_dir,
        expected,
        origin,
        previous_dir == instance_dir || previous_lock.is_some(),
    )?;
    let status_path = instance_dir.join("status.json");
    let terminal_status = if regular_handoff_exists(&status_path)? {
        let status: V3ManagedStatusRecord = read_json(&status_path)?;
        if status.instance_id != expected.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing control recovery for a different instance status".into(),
            ));
        }
        matches!(
            status.state,
            V3ManagedRunState::Stopped | V3ManagedRunState::Failed
        )
    } else {
        false
    };
    let has_stage = regular_handoff_exists(&staged)?;
    let published_target = instance_dir.join("instance.json");
    if regular_handoff_exists(&published_target)?
        && !same_instance_declaration_except_executable_path(
            &read_json(&published_target)?,
            expected,
        )
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "published declaration differs from verified recovery target".into(),
        ));
    }
    if has_stage && read_json::<V3ManagedInstanceDeclaration>(&staged)? != *expected {
        return Err(V3LifecycleError::IdentityMismatch(
            "staged target changed before recovery closeout".into(),
        ));
    }
    // In-place adoption can already have rotated the cache nonce. The exact
    // front still binds the predecessor that supplied the local restart plan.
    let local_plan = previous_dir == instance_dir
        && verify_generation_restart_plan(instance_dir, origin, expected)?;
    let previous = if previous_lock.is_some() {
        let cache: V3ManagedPidCache = read_json(&previous_cache)?;
        let published: V3ManagedInstanceDeclaration =
            read_json(&previous_dir.join("instance.json"))?;
        if cache != *origin
            || published.instance_id != origin.instance_id
            || !previous_owner_matches_restart_declaration(&published, expected)
        {
            return Err(V3LifecycleError::IdentityMismatch(
                "locked predecessor differs from the verified restart generation".into(),
            ));
        }
        validate_transition_records(&previous_dir, &published, origin, expected)?;
        verify_restart_transfer(instance_dir, &published, origin, expected)?;
        match read_front_handoff(&previous_dir.join(FRONT_HANDOFF_FILE))? {
            Some(FrontHandoff::Exact(prior))
                if prior.declaration == published
                    && cache_authorizes_control_origin(&cache, &prior.origin, &published) =>
            {
                handoff.controls.include_verified_custody(prior.controls);
            }
            Some(FrontHandoff::Legacy(checkpoints)) if checkpoints == handoff.checkpoints => {}
            Some(_) => {
                return Err(V3LifecycleError::IdentityMismatch(
                    "previous front artifact belongs to another generation".into(),
                ))
            }
            None => {}
        }
        Some(published)
    } else {
        if previous_dir != instance_dir {
            let prior_path = previous_dir.join("instance.json");
            if regular_handoff_exists(&prior_path)? {
                let prior: V3ManagedInstanceDeclaration = read_json(&prior_path)?;
                if prior.instance_id != origin.instance_id
                    || !previous_owner_matches_restart_declaration(&prior, expected)
                {
                    return Err(V3LifecycleError::IdentityMismatch(
                        "retired predecessor declaration differs from the transition".into(),
                    ));
                }
            }
            let status = previous_dir.join("status.json");
            if regular_handoff_exists(&status)? {
                let status: V3ManagedStatusRecord = read_json(&status)?;
                if status.instance_id != origin.instance_id
                    || status.state != V3ManagedRunState::Stopped
                {
                    return Err(V3LifecycleError::IdentityMismatch(
                        "predecessor retirement is incomplete".into(),
                    ));
                }
            }
        }
        None
    };
    let provider = exclusive_handoff_location(&previous_dir, instance_dir, PROVIDER_HANDOFF_FILE)?;
    if previous.is_none()
        && provider
            .as_ref()
            .is_some_and(|p| p.parent() != Some(instance_dir))
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "unverified predecessor checkpoint".into(),
        ));
    }
    let target_control = reconcile_predecessor_control(instance_dir, expected, origin)?;
    let target_cache = instance_dir.join("pid.cache");
    if previous.is_some()
        && provider
            .as_ref()
            .is_some_and(|p| p.parent() == Some(instance_dir))
        && !cache_authorizes_control_origin(&read_json(&target_cache)?, origin, expected)
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "relocated provider handoff lacks target authority".into(),
        ));
    }
    if !regular_handoff_exists(&target_cache)? {
        let successor = V3ManagedPidCache {
            instance_id: expected.instance_id.clone(),
            retained_control: Some(handoff.link()),
            ..origin.clone()
        };
        write_json_atomic(&target_cache, &successor)?;
    }
    if has_stage {
        write_json_atomic(&instance_dir.join("instance.json"), expected)?;
    }
    if let Some(previous) = &previous {
        V3HooksSidecarSupervisor::retain_interrupted_exec_owner(&previous_dir, instance_dir)?;
        exec_restart::close_verified_restart_transfer(instance_dir, previous, origin, expected)?;
    }
    let failures = handoff
        .controls
        .retire_after_managed_exit(origin.pid)
        .await?;
    for failure in &failures {
        eprintln!("{failure}");
    }
    if !handoff.controls.is_empty() {
        handoff.persist(&path, &handoff.controls)?;
        if let Some(failure) = failures.into_iter().find(|failure| failure.pending) {
            return Err(V3LifecycleError::ActiveKeyControlCleanup(failure));
        }
        return Err(V3LifecycleError::Validation(
            "active-key control disposition remains pending".into(),
        ));
    }
    if let Some(provider) = provider {
        fs::remove_file(provider)?;
    }
    // Publish the verified target before removing a stage that would otherwise
    // send the next invocation back to an already-retired predecessor cache.
    remove_exact_staged_declaration(&path, expected)?;
    if let Some(previous) = previous {
        cleanup_previous_exec_restart_owner(&previous_dir, &previous, expected)?;
    }
    if has_stage || !terminal_status {
        write_status(
            instance_dir,
            &expected.instance_id,
            V3ManagedRunState::Failed,
            Some("interrupted managed exec control recovery completed".into()),
        )?;
    }
    if target_control {
        remove_managed_control(instance_dir, expected)?;
    } else {
        reap_unowned_managed_control_socket(instance_dir, expected)?;
    }
    if local_plan {
        fs::remove_file(instance_dir.join(RESTART_PLAN_FILE))?;
    }
    fs::remove_file(&path)?;
    Ok(ExitedHandoffRecovery::Recovered)
}

fn handoff_leaf_exists(path: &Path) -> std::io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub(crate) fn regular_handoff_exists(path: &Path) -> Result<bool, V3LifecycleError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(V3LifecycleError::IdentityMismatch(format!(
            "{} is not a regular file",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn exclusive_handoff_location(
    previous: &Path,
    target: &Path,
    file: &str,
) -> Result<Option<PathBuf>, V3LifecycleError> {
    let destination = target.join(file);
    let at_target = regular_handoff_exists(&destination)?;
    let source = previous.join(file);
    if previous != target && regular_handoff_exists(&source)? {
        if at_target {
            return Err(V3LifecycleError::IdentityMismatch(format!(
                "{file} present at both restart locations"
            )));
        }
        return Ok(Some(source));
    }
    Ok(at_target.then_some(destination))
}

pub(crate) fn validate_transition_records(
    dir: &Path,
    previous: &V3ManagedInstanceDeclaration,
    origin: &V3ManagedPidCache,
    target: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    reconcile_predecessor_control(dir, previous, origin)?;
    verify_generation_restart_plan(dir, origin, target)?;
    let status = dir.join("status.json");
    if regular_handoff_exists(&status)?
        && read_json::<V3ManagedStatusRecord>(&status)?.instance_id != origin.instance_id
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "predecessor status belongs to another instance".into(),
        ));
    }
    Ok(())
}

// The successor cache can already be durable while control.json still names
// the predecessor. Reconcile that record while both proofs remain available.
fn reconcile_predecessor_control(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
    origin: &V3ManagedPidCache,
) -> Result<bool, V3LifecycleError> {
    let path = instance_dir.join("control.json");
    if !regular_handoff_exists(&path)? {
        return Ok(false);
    }
    let cache: V3ManagedPidCache = read_json(&instance_dir.join("pid.cache"))?;
    let control: V3ManagedControlRecord = read_json(&path)?;
    let socket = managed_control_socket_path(&expected.instance_id);
    if control.schema_version != SCHEMA_VERSION
        || control.instance_id != expected.instance_id
        || Path::new(&control.socket_path) != socket
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "exited managed control differs from the verified declaration".into(),
        ));
    }
    if control.start_nonce == cache.start_nonce {
        return Ok(true);
    }
    if control.start_nonce != origin.start_nonce
        || !cache_authorizes_control_origin(&cache, origin, expected)
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "exited managed control differs from the verified retained generation".into(),
        ));
    }
    Ok(true)
}

fn remove_managed_control(
    dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    match fs::remove_file(managed_control_socket_path(&declaration.instance_id)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    fs::remove_file(dir.join("control.json"))?;
    Ok(())
}

pub(crate) fn cache_authorizes_control_origin(
    cache: &V3ManagedPidCache,
    origin: &V3ManagedPidCache,
    target: &V3ManagedInstanceDeclaration,
) -> bool {
    cache.schema_version == SCHEMA_VERSION
        && cache.instance_id == target.instance_id
        && cache.pid == origin.pid
        && cache.process_start_token == origin.process_start_token
        && (cache == origin
            || cache.retained_control.as_ref().is_some_and(|link| {
                &link.target == target
                    && link.instance_id == origin.instance_id
                    && link.start_nonce == origin.start_nonce
                    && link.started_at_epoch_ms == origin.started_at_epoch_ms
            }))
}

fn verify_exited_control_authority(
    instance_dir: &Path,
    target: &V3ManagedInstanceDeclaration,
    origin: &V3ManagedPidCache,
    predecessor_locked: bool,
) -> Result<(), V3LifecycleError> {
    let staged_path = instance_dir.join(EXEC_RESTART_DECLARATION_FILE);
    let staged = staged_path.try_exists()?
        && read_json::<V3ManagedInstanceDeclaration>(&staged_path)? == *target;
    let cache_path = instance_dir.join("pid.cache");
    if cache_path.try_exists()? {
        let cache: V3ManagedPidCache = read_json(&cache_path)?;
        let published = instance_dir.join("instance.json");
        if cache_authorizes_control_origin(&cache, origin, target)
            && ((published.try_exists()?
                && read_json::<V3ManagedInstanceDeclaration>(&published)? == *target)
                || (staged
                    && cache
                        .retained_control
                        .as_ref()
                        .is_some_and(|link| &link.target == target)))
        {
            return Ok(());
        }
        if cache != *origin {
            return Err(V3LifecycleError::IdentityMismatch(
                "target PID cache does not authorize the retained control generation".into(),
            ));
        }
    }
    if staged && predecessor_locked {
        let previous = instance_dir.with_file_name(&origin.instance_id);
        let cache: V3ManagedPidCache = read_json(&previous.join("pid.cache"))?;
        let declaration: V3ManagedInstanceDeclaration = read_json(&previous.join("instance.json"))?;
        if cache == *origin
            && declaration.instance_id == origin.instance_id
            && (same_instance_declaration_except_executable_path(&declaration, target)
                || previous_owner_matches_restart_declaration(&declaration, target))
        {
            return Ok(());
        }
    }
    Err(V3LifecycleError::IdentityMismatch(
        "no independently verified managed generation for retained control custody".into(),
    ))
}
