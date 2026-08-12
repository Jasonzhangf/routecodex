use super::*;

pub(crate) fn reap_inactive_runtime_files(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    let status_path = instance_dir.join("status.json");
    let status = if status_path.exists() {
        let status: V3ManagedStatusRecord = read_json(&status_path)?;
        if status.instance_id != expected.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap status for a different instance".to_string(),
            ));
        }
        Some(status)
    } else {
        None
    };
    let terminal_status = status.as_ref().is_some_and(|status| {
        matches!(
            status.state,
            V3ManagedRunState::Stopped | V3ManagedRunState::Failed
        )
    });
    let stale_unreachable_runtime_status = if status.as_ref().is_some_and(|status| {
        !matches!(
            status.state,
            V3ManagedRunState::Stopped | V3ManagedRunState::Failed
        )
    }) {
        owned_unreachable_runtime_state_is_reapable(instance_dir, expected)?
    } else {
        false
    };
    let declaration_path = instance_dir.join("instance.json");
    if declaration_path.exists() {
        let declaration: V3ManagedInstanceDeclaration = read_json(&declaration_path)?;
        if declaration != *expected
            && !((terminal_status || stale_unreachable_runtime_status)
                && same_instance_declaration_except_executable_path(&declaration, expected))
        {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap state for a different instance declaration".to_string(),
            ));
        }
    }
    if let Some(status) = status {
        if !matches!(
            status.state,
            V3ManagedRunState::Stopped | V3ManagedRunState::Failed
        ) && !stale_unreachable_runtime_status
        {
            return Err(V3LifecycleError::IdentityMismatch(format!(
                "refusing to reap non-terminal managed state {:?}",
                status.state
            )));
        }
    } else if instance_dir.join("pid.cache").exists() || instance_dir.join("control.json").exists()
    {
        return Err(V3LifecycleError::IdentityMismatch(
            "refusing to reap runtime caches without a terminal status record".to_string(),
        ));
    }
    let control_path = instance_dir.join("control.json");
    if control_path.exists() {
        let control: V3ManagedControlRecord = read_json(&control_path)?;
        if control.instance_id != expected.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap control record for a different instance".to_string(),
            ));
        }
        let socket_path = PathBuf::from(control.socket_path);
        if socket_path != managed_control_socket_path(&expected.instance_id) {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap non-canonical managed control socket path".to_string(),
            ));
        }
        if socket_path.exists() {
            fs::remove_file(socket_path)?;
        }
    }
    for file in ["pid.cache", "control.json"] {
        let path = instance_dir.join(file);
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

pub(crate) fn restart_recovery_state_is_stale_owned_unreachable(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    let status_path = instance_dir.join("status.json");
    if !status_path.exists() {
        return Ok(false);
    }
    let status: V3ManagedStatusRecord = read_json(&status_path)?;
    if status.instance_id != expected.instance_id {
        return Err(V3LifecycleError::IdentityMismatch(
            "refusing restart recovery for a different instance status".to_string(),
        ));
    }
    if matches!(
        status.state,
        V3ManagedRunState::Stopped | V3ManagedRunState::Failed
    ) {
        return Ok(false);
    }
    owned_unreachable_runtime_state_is_reapable(instance_dir, expected)
}

pub(crate) fn owned_unreachable_runtime_state_is_reapable(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<bool, V3LifecycleError> {
    let pid_path = instance_dir.join("pid.cache");
    let cached_pid = if pid_path.exists() {
        let pid: V3ManagedPidCache = read_json(&pid_path)?;
        if pid.instance_id != expected.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap pid cache for a different instance".to_string(),
            ));
        }
        Some(pid)
    } else {
        None
    };

    let control_path = instance_dir.join("control.json");
    if control_path.exists() {
        let control: V3ManagedControlRecord = read_json(&control_path)?;
        if control.instance_id != expected.instance_id {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap control record for a different instance".to_string(),
            ));
        }
        let socket_path = PathBuf::from(&control.socket_path);
        if socket_path != managed_control_socket_path(&expected.instance_id) {
            return Err(V3LifecycleError::IdentityMismatch(
                "refusing to reap non-canonical managed control socket path".to_string(),
            ));
        }
        if socket_path.exists() && cached_pid.as_ref().is_some_and(|pid| pid_is_alive(pid.pid)) {
            return Ok(false);
        }
        if let Some(pid) = cached_pid.as_ref() {
            if pid.start_nonce != control.start_nonce {
                return Err(V3LifecycleError::IdentityMismatch(
                    "refusing to reap pid/control cache with mismatched nonce".to_string(),
                ));
            }
        }
    }

    for listener in &expected.listeners {
        if !listener_address_is_available(&listener.bind, listener.port) {
            return Ok(false);
        }
    }
    Ok(true)
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
