use super::*;
use serde_json::Value;

pub(super) fn required_record_path(
    record: &Value,
    field: &str,
    record_path: &Path,
) -> Result<PathBuf, V3LifecycleError> {
    let value = record.get(field).and_then(Value::as_str).ok_or_else(|| {
        V3LifecycleError::Validation(format!(
            "hooks install record {} is missing {field}",
            record_path.display()
        ))
    })?;
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record {field} must be absolute"
        )));
    }
    if !path.exists() {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record {field} does not exist: {}",
            path.display()
        )));
    }
    Ok(path)
}

pub(super) fn optional_record_path(
    record: &Value,
    field: &str,
) -> Result<Option<PathBuf>, V3LifecycleError> {
    let Some(value) = record.get(field).and_then(Value::as_str) else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record {field} must be absolute"
        )));
    }
    if !path.exists() {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record {field} does not exist: {}",
            path.display()
        )));
    }
    Ok(Some(path))
}

pub(super) fn codexapp_binary_from_record(
    record: &Value,
    record_path: &Path,
) -> Result<PathBuf, V3LifecycleError> {
    let _install_root = required_record_path(record, "install_root", record_path)?;
    let bin_directory = record
        .get("bin_directory")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            V3LifecycleError::Validation(format!(
                "hooks install record {} has no bin_directory",
                record_path.display()
            ))
        })?;
    let bin_directory = Path::new(bin_directory);
    if !bin_directory.is_absolute() {
        return Err(V3LifecycleError::Validation(
            "hooks install record bin_directory must be absolute".to_string(),
        ));
    }
    let canonical_bin_directory = fs::canonicalize(bin_directory).map_err(|error| {
        V3LifecycleError::Validation(format!(
            "hooks install record bin_directory {} cannot be resolved: {error}",
            bin_directory.display()
        ))
    })?;
    if !canonical_bin_directory.is_dir() {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record bin_directory is not a directory: {}",
            bin_directory.display()
        )));
    }
    let candidate = canonical_bin_directory.join("rccv3-codexapp");
    let canonical_candidate = fs::canonicalize(&candidate).map_err(|error| {
        V3LifecycleError::Validation(format!(
            "hooks install record {} requires installed internal codexapp binary at {}: {error}",
            record_path.display(),
            candidate.display()
        ))
    })?;
    if !canonical_candidate.starts_with(&canonical_bin_directory) || !canonical_candidate.is_file()
    {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record {} requires internal codexapp binary inside bin_directory at {}",
            record_path.display(),
            canonical_candidate.display()
        )));
    }
    Ok(canonical_candidate)
}

pub(super) fn internal_hooksd_binary_from_record(
    record: &Value,
    record_path: &Path,
) -> Result<PathBuf, V3LifecycleError> {
    let _install_root = required_record_path(record, "install_root", record_path)?;
    let bin_directory = record
        .get("bin_directory")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            V3LifecycleError::Validation(format!(
                "hooks install record {} has no bin_directory",
                record_path.display()
            ))
        })?;
    let bin_directory = Path::new(bin_directory);
    if !bin_directory.is_absolute() {
        return Err(V3LifecycleError::Validation(
            "hooks install record bin_directory must be absolute".to_string(),
        ));
    }
    let canonical_bin_directory = fs::canonicalize(bin_directory).map_err(|error| {
        V3LifecycleError::Validation(format!(
            "hooks install record bin_directory {} cannot be resolved: {error}",
            bin_directory.display()
        ))
    })?;
    let candidate = canonical_bin_directory.join("rccv3-hooksd");
    let canonical_candidate = fs::canonicalize(&candidate).map_err(|error| {
        V3LifecycleError::Validation(format!(
            "hooks install record {} requires installed internal hooksd binary at {}: {error}",
            record_path.display(),
            candidate.display()
        ))
    })?;
    if !canonical_candidate.starts_with(&canonical_bin_directory) || !canonical_candidate.is_file()
    {
        return Err(V3LifecycleError::Validation(format!(
            "hooks install record {} requires internal hooksd binary inside bin_directory at {}",
            record_path.display(),
            canonical_candidate.display()
        )));
    }
    Ok(canonical_candidate)
}
