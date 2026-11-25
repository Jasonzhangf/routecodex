//! Startup and write-time sample retention.
//!
//! Retention is optional housekeeping over the shared sample tree, so an
//! unreadable or vanished directory must never fail the caller's mainline: the
//! affected entry is left untouched and the reason is recorded. The single
//! contract-bound retention failure is the process-shared lock, which stays
//! with its owner in [`crate::sample_store`]: uncoordinated retention would
//! prune a tree another process is writing, so that case must surface as an
//! explicit startup error instead of being skipped.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub(crate) const V3_CODEX_SAMPLE_FAILURE_RETENTION: usize = 256;
pub(crate) const V3_CODEX_SAMPLE_FAILURE_RETENTION_FLOOR: Duration = Duration::from_secs(30 * 60);
const RETENTION_MARKER: &str = ".retention.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3CodexSampleRetentionKind {
    Success { first_persisted: Option<SystemTime> },
    Failure { first_persisted: SystemTime },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3CodexSampleRetentionAdmission {
    Allowed,
    FailureReserveFull,
}

fn marker_path(request_dir: &Path) -> PathBuf {
    request_dir.join(RETENTION_MARKER)
}

pub(crate) fn write_v3_codex_sample_retention_marker(
    request_dir: &Path,
    failure: bool,
    first_persisted: SystemTime,
) -> Result<(), String> {
    let first_persisted_unix_ns = first_persisted
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let first_persisted_unix_ns = u64::try_from(first_persisted_unix_ns)
        .map_err(|_| "sample retention timestamp exceeds u64 nanoseconds".to_string())?;
    let marker = if failure {
        serde_json::json!({
            "kind": "failure",
            "first_persisted_unix_ns": first_persisted_unix_ns
        })
    } else {
        serde_json::json!({
            "kind": "success",
            "first_persisted_unix_ns": first_persisted_unix_ns
        })
    };
    fs::write(marker_path(request_dir), format!("{marker}\n")).map_err(|error| error.to_string())
}

pub(crate) fn read_v3_codex_sample_retention_kind(
    request_dir: &Path,
) -> V3CodexSampleRetentionKind {
    let Ok(text) = fs::read_to_string(marker_path(request_dir)) else {
        return V3CodexSampleRetentionKind::Success {
            first_persisted: None,
        };
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return V3CodexSampleRetentionKind::Success {
            first_persisted: None,
        };
    };
    let first_persisted = value["first_persisted_unix_ns"]
        .as_u64()
        .and_then(|nanoseconds| {
            SystemTime::UNIX_EPOCH.checked_add(Duration::from_nanos(nanoseconds))
        });
    match (value["kind"].as_str(), first_persisted) {
        (Some("failure"), Some(first_persisted)) => {
            V3CodexSampleRetentionKind::Failure { first_persisted }
        }
        (Some("success"), Some(first_persisted)) => V3CodexSampleRetentionKind::Success {
            first_persisted: Some(first_persisted),
        },
        _ => V3CodexSampleRetentionKind::Success {
            first_persisted: None,
        },
    }
}

fn sample_request_dirs(
    samples_root: &Path,
) -> Vec<(PathBuf, SystemTime, V3CodexSampleRetentionKind)> {
    let mut result = Vec::new();
    let Ok(endpoints) = fs::read_dir(samples_root) else {
        return result;
    };
    for endpoint in endpoints.flatten() {
        let Ok(ports) = fs::read_dir(endpoint.path().join("ports")) else {
            continue;
        };
        for port in ports.flatten() {
            let Ok(requests) = fs::read_dir(port.path()) else {
                continue;
            };
            for request in requests.flatten() {
                if !request.file_type().is_ok_and(|kind| kind.is_dir()) {
                    continue;
                }
                let Ok(modified) = request.metadata().and_then(|metadata| metadata.modified())
                else {
                    continue;
                };
                let path = request.path();
                result.push((
                    path.clone(),
                    modified,
                    read_v3_codex_sample_retention_kind(&path),
                ));
            }
        }
    }
    result
}

fn failure_is_expired(first_persisted: SystemTime, now: SystemTime) -> bool {
    now.duration_since(first_persisted)
        .is_ok_and(|age| age >= V3_CODEX_SAMPLE_FAILURE_RETENTION_FLOOR)
}

fn sort_failure_candidates(candidates: &mut [(PathBuf, SystemTime)]) {
    candidates.sort_by(|left, right| {
        left.1
            .cmp(&right.1)
            .then_with(|| left.0.as_os_str().cmp(right.0.as_os_str()))
    });
}

fn remove_expired_failures_at(samples_root: &Path, now: SystemTime) -> usize {
    let mut expired = sample_request_dirs(samples_root)
        .into_iter()
        .filter_map(|(path, _, kind)| match kind {
            V3CodexSampleRetentionKind::Failure { first_persisted }
                if failure_is_expired(first_persisted, now) =>
            {
                Some((path, first_persisted))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    sort_failure_candidates(&mut expired);
    let mut remaining = 0;
    for (path, _) in expired {
        if let Err(error) = fs::remove_dir_all(&path) {
            record_v3_codex_sample_retention_skip(&path, &error);
            remaining += 1;
        }
    }
    remaining
}

pub(crate) fn admit_v3_codex_sample_failure(
    samples_root: &Path,
    protected: Option<&Path>,
    now: SystemTime,
) -> Result<V3CodexSampleRetentionAdmission, String> {
    let unremovable_expired = remove_expired_failures_at(samples_root, now);
    let in_floor = sample_request_dirs(samples_root)
        .into_iter()
        .filter(|(path, _, kind)| {
            protected.is_none_or(|item| path != item)
                && matches!(
                    kind,
                    V3CodexSampleRetentionKind::Failure { first_persisted }
                        if !failure_is_expired(*first_persisted, now)
                )
        })
        .count();
    Ok(
        if in_floor + unremovable_expired >= V3_CODEX_SAMPLE_FAILURE_RETENTION {
            V3CodexSampleRetentionAdmission::FailureReserveFull
        } else {
            V3CodexSampleRetentionAdmission::Allowed
        },
    )
}

/// Record one retention entry this pass could not inspect.
fn record_v3_codex_sample_retention_skip(path: &Path, error: &dyn std::fmt::Display) {
    eprintln!("codex sample retention skipped {}: {error}", path.display());
}

/// Read the next directory entry, recording and skipping an unreadable one.
fn next_v3_codex_sample_retention_entry(
    entries: &mut fs::ReadDir,
    context: &Path,
) -> Option<fs::DirEntry> {
    loop {
        match entries.next()? {
            Ok(entry) => return Some(entry),
            Err(error) => record_v3_codex_sample_retention_skip(context, &error),
        }
    }
}

/// Whether one entry is a directory, recording and skipping a stat failure.
fn v3_codex_sample_retention_is_dir(entry: &fs::DirEntry) -> bool {
    match entry.file_type() {
        Ok(file_type) => file_type.is_dir(),
        Err(error) => {
            record_v3_codex_sample_retention_skip(&entry.path(), &error);
            false
        }
    }
}

/// Enforce the success request-directory limit and failure floor across every endpoint and port.
///
/// Every filesystem failure below is per-entry housekeeping, so it is recorded
/// and skipped rather than propagated: a vanished or unreadable sample
/// directory must not stop the aggregate server from binding its listeners.
pub(crate) fn enforce_v3_codex_sample_global_retention(
    samples_root: &Path,
    protected_request_dir: Option<&Path>,
    retention: usize,
) -> Result<(), String> {
    enforce_v3_codex_sample_global_retention_at(
        samples_root,
        protected_request_dir,
        retention,
        SystemTime::now(),
    )
}

pub(crate) fn enforce_v3_codex_sample_global_retention_at(
    samples_root: &Path,
    protected_request_dir: Option<&Path>,
    retention: usize,
    now: SystemTime,
) -> Result<(), String> {
    let mut endpoint_dirs = match fs::read_dir(samples_root) {
        Ok(endpoint_dirs) => endpoint_dirs,
        Err(error) => {
            record_v3_codex_sample_retention_skip(samples_root, &error);
            return Ok(());
        }
    };
    let mut success_dirs = Vec::new();
    let mut expired_failures = Vec::new();
    while let Some(endpoint_dir) =
        next_v3_codex_sample_retention_entry(&mut endpoint_dirs, samples_root)
    {
        if !v3_codex_sample_retention_is_dir(&endpoint_dir) {
            continue;
        }
        let ports_dir = endpoint_dir.path().join("ports");
        if !ports_dir.is_dir() {
            continue;
        }
        let mut port_dirs = match fs::read_dir(&ports_dir) {
            Ok(port_dirs) => port_dirs,
            Err(error) => {
                record_v3_codex_sample_retention_skip(&ports_dir, &error);
                continue;
            }
        };
        while let Some(port_dir) = next_v3_codex_sample_retention_entry(&mut port_dirs, &ports_dir)
        {
            let port_path = port_dir.path();
            if !v3_codex_sample_retention_is_dir(&port_dir) {
                continue;
            }
            let mut request_entries = match fs::read_dir(&port_path) {
                Ok(request_entries) => request_entries,
                Err(error) => {
                    record_v3_codex_sample_retention_skip(&port_path, &error);
                    continue;
                }
            };
            while let Some(request_dir) =
                next_v3_codex_sample_retention_entry(&mut request_entries, &port_path)
            {
                if !v3_codex_sample_retention_is_dir(&request_dir) {
                    continue;
                }
                let path = request_dir.path();
                let Ok(modified) = request_dir
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                else {
                    record_v3_codex_sample_retention_skip(&path, &"metadata unavailable");
                    continue;
                };
                match read_v3_codex_sample_retention_kind(&path) {
                    V3CodexSampleRetentionKind::Success {
                        first_persisted: Some(first_persisted),
                    } => success_dirs.push((request_dir, first_persisted)),
                    V3CodexSampleRetentionKind::Success {
                        first_persisted: None,
                    } => success_dirs.push((request_dir, modified)),
                    V3CodexSampleRetentionKind::Failure { first_persisted }
                        if failure_is_expired(first_persisted, now)
                            && protected_request_dir.is_none_or(|protected| path != protected) =>
                    {
                        expired_failures.push((path, first_persisted));
                    }
                    V3CodexSampleRetentionKind::Failure { .. } => {}
                }
            }
        }
    }
    sort_failure_candidates(&mut expired_failures);
    for (path, _) in expired_failures {
        if let Err(error) = fs::remove_dir_all(&path) {
            record_v3_codex_sample_retention_skip(&path, &error);
        }
    }
    if success_dirs.len() <= retention {
        return Ok(());
    }
    success_dirs.sort_by(|left, right| {
        left.1
            .cmp(&right.1)
            .then_with(|| left.0.file_name().cmp(&right.0.file_name()))
    });
    let excess = success_dirs.len() - retention;
    let removable = success_dirs
        .into_iter()
        .filter(|(entry, _)| {
            protected_request_dir.is_none_or(|protected| entry.path() != protected)
        })
        .take(excess)
        .collect::<Vec<_>>();
    if removable.len() != excess {
        return Err(format!(
            "codex sample retention cannot preserve current request while removing {excess} directories"
        ));
    }
    for (entry, _) in removable {
        if let Err(error) = fs::remove_dir_all(entry.path()) {
            record_v3_codex_sample_retention_skip(&entry.path(), &error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sort_failure_candidates;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime};

    #[test]
    fn expired_failure_candidates_are_oldest_first_with_path_tie_break() {
        let first = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let mut candidates = vec![
            (PathBuf::from("same-time/z"), first),
            (PathBuf::from("new"), first + Duration::from_secs(2)),
            (PathBuf::from("old"), first),
            (PathBuf::from("same-time/a"), first),
        ];
        sort_failure_candidates(&mut candidates);
        assert_eq!(
            candidates
                .into_iter()
                .map(|(path, _)| path)
                .collect::<Vec<_>>(),
            vec![
                PathBuf::from("old"),
                PathBuf::from("same-time/a"),
                PathBuf::from("same-time/z"),
                PathBuf::from("new"),
            ]
        );
    }
}
