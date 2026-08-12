use super::*;

pub(crate) fn validate_auth_handles(manifest: &V3Config05ManifestPublished) -> Result<(), V3LifecycleError> {
    for provider in manifest
        .providers
        .values()
        .filter(|provider| provider.enabled)
    {
        for entry in &provider.auth.entries {
            // Support three auth handle shapes:
            // 1. env: read from environment variable (checked at runtime)
            // 2. token_file: read from file (file must be non-empty)
            // 3. api_key: inline literal (always valid, no runtime check needed)
            match (&entry.env, &entry.token_file, &entry.api_key) {
                (Some(name), None, None) => {
                    if std::env::var_os(name).is_none() {
                        return Err(V3LifecycleError::Validation(format!(
                            "provider {} auth {} environment handle {} is unavailable",
                            provider.id, entry.alias, name
                        )));
                    }
                }
                (None, Some(path), None) => {
                    let mut file = File::open(path).map_err(|error| {
                        V3LifecycleError::Validation(format!(
                            "provider {} auth {} token-file handle is unreadable: {error}",
                            provider.id, entry.alias
                        ))
                    })?;
                    let mut one = [0_u8; 1];
                    if file.read(&mut one)? == 0 {
                        return Err(V3LifecycleError::Validation(format!(
                            "provider {} auth {} token-file handle is empty",
                            provider.id, entry.alias
                        )));
                    }
                }
                // api_key: inline literal is always valid, no runtime check needed
                (None, None, Some(_)) => {}
                // Explicit empty entries are invalid
                (None, None, None) => {
                    return Err(V3LifecycleError::Validation(format!(
                        "provider {} auth {} has no auth handle (env, token_file, or api_key)",
                        provider.id, entry.alias
                    )))
                }
                // Mixed handles are invalid
                _ => {
                    return Err(V3LifecycleError::Validation(format!(
                        "provider {} auth {} has invalid handle shape (mutually exclusive)",
                        provider.id, entry.alias
                    )))
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn verify_published_declaration(
    instance_dir: &Path,
    expected: &V3ManagedInstanceDeclaration,
) -> Result<(), V3LifecycleError> {
    let path = instance_dir.join("instance.json");
    if !path.exists() {
        return Err(V3LifecycleError::NotRunning(expected.instance_id.clone()));
    }
    let actual: V3ManagedInstanceDeclaration = read_json(&path)?;
    if actual != *expected {
        return Err(V3LifecycleError::IdentityMismatch(
            "published instance declaration differs from current config/executable".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn acquire_operation_lock(
    instance_dir: &Path,
    operation: &str,
) -> Result<OperationLock, V3LifecycleError> {
    ensure_private_dir(instance_dir)?;
    let path = instance_dir.join("lifecycle.lock");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                V3LifecycleError::OperationLocked(operation.to_string())
            } else {
                V3LifecycleError::Io(error)
            }
        })?;
    writeln!(file, "operation={operation} pid={}", std::process::id())?;
    Ok(OperationLock { path })
}

pub(crate) fn ensure_private_dir(path: &Path) -> Result<(), V3LifecycleError> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

pub(crate) fn private_log_file(path: &Path) -> Result<File, V3LifecycleError> {
    Ok(OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)?)
}

pub(crate) fn write_status(
    instance_dir: &Path,
    instance_id: &str,
    state: V3ManagedRunState,
    detail: Option<String>,
) -> Result<(), V3LifecycleError> {
    write_json_atomic(
        &instance_dir.join("status.json"),
        &V3ManagedStatusRecord {
            schema_version: SCHEMA_VERSION,
            instance_id: instance_id.to_string(),
            state,
            updated_at_epoch_ms: epoch_ms(),
            detail,
        },
    )
}

pub(crate) fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), V3LifecycleError> {
    let parent = path.parent().ok_or_else(|| {
        V3LifecycleError::Validation(format!("state path has no parent: {}", path.display()))
    })?;
    ensure_private_dir(parent)?;
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temp, path)?;
    Ok(())
}

pub(crate) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, V3LifecycleError> {
    Ok(serde_json::from_reader(File::open(path)?)?)
}

