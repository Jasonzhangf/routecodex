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
use std::path::Path;

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

/// Enforce the global request-directory limit across every endpoint and port.
///
/// Every filesystem failure below is per-entry housekeeping, so it is recorded
/// and skipped rather than propagated: a vanished or unreadable sample
/// directory must not stop the aggregate server from binding its listeners.
pub(crate) fn enforce_v3_codex_sample_global_retention(
    samples_root: &Path,
    protected_request_dir: Option<&Path>,
    retention: usize,
) -> Result<(), String> {
    let mut endpoint_dirs = match fs::read_dir(samples_root) {
        Ok(endpoint_dirs) => endpoint_dirs,
        Err(error) => {
            record_v3_codex_sample_retention_skip(samples_root, &error);
            return Ok(());
        }
    };
    let mut request_dirs = Vec::new();
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
                match request_dir
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                {
                    Ok(modified) => request_dirs.push((request_dir, modified)),
                    Err(error) => {
                        record_v3_codex_sample_retention_skip(&request_dir.path(), &error);
                    }
                }
            }
        }
    }
    if request_dirs.len() <= retention {
        return Ok(());
    }
    request_dirs.sort_by(|left, right| {
        left.1
            .cmp(&right.1)
            .then_with(|| left.0.file_name().cmp(&right.0.file_name()))
    });
    let excess = request_dirs.len() - retention;
    let removable = request_dirs
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
