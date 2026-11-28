use super::*;

enum ReapState {
    Fresh,
    Terminal,
    Dead {
        terminal: bool,
        socket: bool,
        control: bool,
        plan: bool,
        nonce: String,
    },
    Unverified,
}

fn classify_inactive_runtime(
    dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<ReapState, V3LifecycleError> {
    use std::os::unix::fs::FileTypeExt;
    for name in [
        FRONT_HANDOFF_FILE,
        PROVIDER_HANDOFF_FILE,
        EXEC_RESTART_DECLARATION_FILE,
        exec_restart::PREVIOUS_RELEASE_RESTART_FILE,
    ] {
        if regular_handoff_exists(&dir.join(name))? {
            return Ok(ReapState::Unverified);
        }
    }
    let declaration = if regular_handoff_exists(&dir.join("instance.json"))? {
        let published = read_json(&dir.join("instance.json"))?;
        if !same_instance_declaration_except_executable_path(&published, expected) {
            return Ok(ReapState::Unverified);
        }
        Some(published)
    } else {
        None
    };
    let status = if regular_handoff_exists(&dir.join("status.json"))? {
        let status: V3ManagedStatusRecord = read_json(&dir.join("status.json"))?;
        if status.schema_version != SCHEMA_VERSION
            || status.instance_id != expected.instance_id
            || declaration.is_none()
        {
            return Ok(ReapState::Unverified);
        }
        Some(status)
    } else {
        None
    };
    let terminal = status.as_ref().is_some_and(|s| {
        matches!(
            s.state,
            V3ManagedRunState::Stopped | V3ManagedRunState::Failed
        )
    });
    let socket = match fs::symlink_metadata(managed_control_socket_path(&expected.instance_id)) {
        Ok(meta) if meta.file_type().is_socket() => true,
        Ok(_) => return Ok(ReapState::Unverified),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.into()),
    };
    let control = regular_handoff_exists(&dir.join("control.json"))?;
    if !regular_handoff_exists(&dir.join("pid.cache"))? {
        return Ok(
            if control || socket || regular_handoff_exists(&dir.join(RESTART_PLAN_FILE))? {
                ReapState::Unverified
            } else if terminal {
                ReapState::Terminal
            } else if status.is_none() && declaration.as_ref().is_none_or(|d| d == expected) {
                ReapState::Fresh
            } else {
                ReapState::Unverified
            },
        );
    }
    let Some(published) = declaration else {
        return Ok(ReapState::Unverified);
    };
    let cache: V3ManagedPidCache = read_json(&dir.join("pid.cache"))?;
    if status.is_none()
        || cache.instance_id != published.instance_id
        || cache
            .retained_control
            .as_ref()
            .is_some_and(|link| link.target != published)
        || !managed_generation_has_exited(&cache)?
        || !listener_set_is_available(&published.listeners)
    {
        return Ok(ReapState::Unverified);
    }
    if control {
        let record = read_json(&dir.join("control.json"))?;
        if !managed_control_matches_generation(&published, &cache, &record) {
            return Ok(ReapState::Unverified);
        }
    } else if socket || !terminal {
        return Ok(ReapState::Unverified);
    }
    let plan = verify_generation_restart_plan(dir, &cache, expected)?;
    if socket {
        match std::os::unix::net::UnixStream::connect(managed_control_socket_path(
            &expected.instance_id,
        )) {
            Ok(_) => return Ok(ReapState::Unverified),
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => (),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(ReapState::Dead {
        terminal,
        socket,
        control,
        plan,
        nonce: cache.start_nonce,
    })
}

pub(crate) fn is_settled_stopped_instance_dir(
    dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> bool {
    if !matches!(
        classify_inactive_runtime(dir, expected),
        Ok(ReapState::Terminal)
    ) {
        return false;
    }
    matches!(
        regular_handoff_exists(&dir.join(HOOKS_SIDECAR_PROCESS_FILE)),
        Ok(false)
    )
}

pub(crate) fn reap_inactive_runtime_files(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    match classify_inactive_runtime(instance_dir, expected)? {
        ReapState::Fresh | ReapState::Terminal => remove_exited_hooks_record(instance_dir),
        ReapState::Unverified => Err(V3LifecycleError::IdentityMismatch(
            "refusing to reap an unverified managed generation".into(),
        )),
        ReapState::Dead {
            terminal,
            socket,
            control,
            plan,
            nonce,
        } => {
            if !terminal {
                write_status(
                    instance_dir,
                    &expected.instance_id,
                    V3ManagedRunState::Stopped,
                    None,
                )?;
            }
            if socket {
                fs::remove_file(managed_control_socket_path(&expected.instance_id))?;
            }
            if control {
                fs::remove_file(instance_dir.join("control.json"))?;
            }
            if plan {
                fs::remove_file(instance_dir.join(RESTART_PLAN_FILE))?;
            }
            remove_exited_hooks_record(instance_dir)?;
            if !matches!(classify_inactive_runtime(instance_dir, expected)?,
                ReapState::Dead { terminal: true, control: false, socket: false, plan: false, nonce: remaining } if remaining == nonce)
            {
                return Err(V3LifecycleError::IdentityMismatch(
                    "managed proof changed before cache retirement".into(),
                ));
            }
            fs::remove_file(instance_dir.join("pid.cache"))?;
            Ok(())
        }
    }
}

fn remove_exited_hooks_record(dir: &Path) -> Result<(), V3LifecycleError> {
    let path = dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    if matches!(regular_handoff_exists(&path), Ok(true))
        && matches!(hooks_sidecar_process_group_is_alive(dir), Ok(false))
    {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub(super) fn restart_can_select_previous_owner(
    dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    Ok(matches!(
        classify_inactive_runtime(dir, expected)?,
        ReapState::Fresh | ReapState::Terminal
    ))
}

pub(super) fn restart_terminal_bootstrap_is_verified(
    dir: &Path,
    declaration: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    Ok(match classify_inactive_runtime(dir, declaration)? {
        ReapState::Terminal => listener_set_is_available(&declaration.listeners),
        ReapState::Dead {
            terminal: true,
            control: false,
            ..
        } => true,
        _ => false,
    })
}

pub(crate) fn restart_recovery_state_is_stale_owned_unreachable(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    Ok(matches!(
        classify_inactive_runtime(instance_dir, expected)?,
        ReapState::Dead { .. }
    ))
}

pub(crate) fn managed_control_matches_declaration(
    expected: &V3ManagedInstanceDeclaration,
    published: &V3ManagedInstanceDeclaration,
    cache: &V3ManagedPidCache,
    control: &V3ManagedControlRecord,
) -> bool {
    published == expected && managed_control_matches_generation(published, cache, control)
}

pub(super) fn managed_control_matches_generation(
    expected: &V3ManagedInstanceDeclaration,
    cache: &V3ManagedPidCache,
    control: &V3ManagedControlRecord,
) -> bool {
    cache.schema_version == SCHEMA_VERSION
        && control.schema_version == SCHEMA_VERSION
        && cache.instance_id == expected.instance_id
        && control.instance_id == expected.instance_id
        && cache.start_nonce == control.start_nonce
        && Path::new(&control.socket_path) == managed_control_socket_path(&expected.instance_id)
}

pub(crate) fn managed_generation_has_exited(
    cache: &V3ManagedPidCache,
) -> Result<bool, V3LifecycleError> {
    let Ok(pid) = libc::pid_t::try_from(cache.pid) else {
        return Ok(false);
    };
    if cache.schema_version != SCHEMA_VERSION
        || pid <= 0
        || cache.start_nonce.is_empty()
        || cache
            .process_start_token
            .as_deref()
            .is_none_or(str::is_empty)
    {
        return Ok(false);
    }
    if unsafe { libc::kill(pid, 0) } == 0 {
        return Ok(false);
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::EPERM) => Ok(false),
        Some(libc::ESRCH) => Ok(process_start_token(cache.pid)?.is_none()),
        _ => Err(error.into()),
    }
}

pub(crate) fn listener_address_is_available(bind: &str, port: u16) -> bool {
    std::net::TcpListener::bind((bind, port)).is_ok()
}

pub(crate) fn same_instance_declaration_except_executable_path(
    stored: &V3ManagedInstanceDeclaration,
    expected: &V3ManagedInstanceDeclaration,
) -> bool {
    stored.schema_version == expected.schema_version
        && stored.instance_id == expected.instance_id
        && stored.config_path == expected.config_path
        && stored.config_digest == expected.config_digest
        && stored.listeners == expected.listeners
}

pub(crate) fn managed_control_socket_path(instance_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!("routecodex-{instance_id}.sock"))
}

/// Reconcile the canonical managed control socket when the `control.json`
/// record that authorizes its cleanup was never written.
///
/// `run_managed_child_with_declaration` binds the canonical control socket
/// before it writes `pid.cache` and `control.json`. A crash in that window
/// leaves a bound socket that every `control.json`-gated path skips, and
/// `run_managed_child_with_declaration` then refuses every later start with
/// `IdentityMismatch: control socket already exists without a verified stopped
/// cleanup`, permanently blocking the instance.
///
/// Only a provably unowned socket is removed: a cached pid that is still alive
/// keeps the socket. Only exact recovery and forced stop call this helper.
/// A socket recorded in an existing `control.json` is already handled by that
/// record's own identity and nonce checks, so this is a no-op there.
pub(crate) fn reap_unowned_managed_control_socket(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    if instance_dir.join("control.json").exists() {
        return Ok(());
    }
    let socket_path = managed_control_socket_path(&expected.instance_id);
    if !socket_path.exists() {
        return Ok(());
    }
    let pid_path = instance_dir.join("pid.cache");
    if pid_path.exists() {
        let pid: V3ManagedPidCache = read_json(&pid_path)?;
        if pid.instance_id != expected.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap unowned control socket for a different instance".to_string(),
            ));
        }
        if pid_is_alive(pid.pid) {
            return Ok(());
        }
    }
    fs::remove_file(socket_path)?;
    Ok(())
}

pub(crate) fn new_start_nonce(instance_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(instance_id.as_bytes());
    digest.update(std::process::id().to_le_bytes());
    digest.update(epoch_ms().to_le_bytes());
    format!("{:x}", digest.finalize())
}

pub(crate) fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn env_duration_ms(names: &[&str], default: Duration) -> Duration {
    for name in names {
        let Some(raw) = std::env::var_os(name) else {
            continue;
        };
        let Some(raw) = raw.to_str() else {
            continue;
        };
        let Ok(parsed) = raw.trim().parse::<u64>() else {
            continue;
        };
        return Duration::from_millis(parsed);
    }
    default
}
