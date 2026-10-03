use super::{is_provider_attempt_failure, project_query_rows, QueryRow, SourceRow};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Store-file identity used to decide whether a cached projection is current.
/// `len` catches appends and truncation; `inode`/`device` catch the atomic
/// temp-file rename the store's retention compaction performs. The store
/// contract permits only append-in-place or atomic replacement, so a same-inode
/// length increase is the complete append signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StoreFileIdentity {
    len: u64,
    inode: u64,
    device: u64,
    modified: Option<std::time::SystemTime>,
}

fn store_file_identity(path: &Path) -> Option<StoreFileIdentity> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(StoreFileIdentity {
            len: metadata.len(),
            inode: metadata.ino(),
            device: metadata.dev(),
            modified,
        })
    }
    #[cfg(not(unix))]
    {
        Some(StoreFileIdentity {
            len: metadata.len(),
            inode: 0,
            device: 0,
            modified,
        })
    }
}

/// Incremental, identity-keyed cache for the polled records projection.
///
/// `records` is polled by the WebUI several times per refresh: the list, the
/// attempts tab, and the per-error-status filters all hit the same handler.
/// Re-reading and re-decoding the whole append-only JSONL on every request made
/// the admin server the top CPU consumer. This cache decodes only the bytes
/// appended since the previous read and rebuilds the typed projection only when
/// a port file actually changed.
#[derive(Debug, Default)]
pub struct RecordsProjectionCache {
    inner: Mutex<RecordsProjectionState>,
}

#[derive(Debug, Default)]
struct RecordsProjectionState {
    ports: Vec<PortProjectionState>,
    projected: Arc<Vec<QueryRow>>,
}

#[derive(Debug, Default)]
struct PortProjectionState {
    path: PathBuf,
    identity: Option<StoreFileIdentity>,
    offset: u64,
    line_number: usize,
    /// Latest non-attempt row per request_key, exactly like `project_query_rows`.
    latest: BTreeMap<String, SourceRow>,
    /// Every provider-attempt row, in file order.
    attempts: Vec<SourceRow>,
}

impl RecordsProjectionCache {
    pub(super) fn project(&self, paths: &[PathBuf]) -> Result<Arc<Vec<QueryRow>>, String> {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.refresh(paths)? {
            state.projected = Arc::new(rebuild_query_rows(&state.ports));
        }
        Ok(Arc::clone(&state.projected))
    }
}

impl RecordsProjectionState {
    /// Refresh every port from its store file. Returns whether any port content
    /// changed, so the caller only re-projects when it must.
    fn refresh(&mut self, paths: &[PathBuf]) -> Result<bool, String> {
        let same_ports = self.ports.len() == paths.len()
            && self
                .ports
                .iter()
                .zip(paths)
                .all(|(port, path)| &port.path == path);
        if !same_ports {
            self.ports = paths
                .iter()
                .map(|path| PortProjectionState {
                    path: path.clone(),
                    ..PortProjectionState::default()
                })
                .collect();
        }
        let mut changed = !same_ports;
        for (port, path) in self.ports.iter_mut().zip(paths) {
            changed |= refresh_port_projection(port, path)?;
        }
        Ok(changed)
    }
}

fn refresh_port_projection(port: &mut PortProjectionState, path: &Path) -> Result<bool, String> {
    let identity = store_file_identity(path);
    if port.identity == identity {
        return Ok(false);
    }
    // Resume only when the store owner's mutation contract proves an append:
    // same inode/device and a strictly larger file. Any same-length or truncated
    // state is a replacement/rewrite and rebuilds this port from scratch. A
    // same-inode length increase that rewrites earlier bytes violates the store
    // contract and is not representable as an append.
    let append_only = matches!(
        (port.identity, identity),
        (Some(previous), Some(current))
            if previous.device == current.device
                && previous.inode == current.inode
                && current.len > previous.len
                && current.len > port.offset
    ) && port.offset > 0;
    if !append_only {
        port.latest.clear();
        port.attempts.clear();
        port.offset = 0;
        port.line_number = 0;
    }
    let read = routecodex_v3_debug::v3_webui_observability_read_raw_rows_from(
        path,
        port.offset,
        port.line_number,
    )
    .map_err(|error| {
        format!(
            "observability store {} unavailable: {error}",
            path.display()
        )
    })?;
    for value in read.rows {
        let row = serde_json::from_value::<SourceRow>(value).map_err(|error| {
            format!(
                "decode observability store {} row failed: {error}",
                path.display()
            )
        })?;
        if is_provider_attempt_failure(&row) {
            port.attempts.push(row);
        } else {
            port.latest.insert(row.request_key.clone(), row);
        }
    }
    port.offset = read.next_offset;
    port.line_number = read.next_line_number;
    port.identity = identity;
    Ok(true)
}

/// Fold the per-port incremental state back into the exact projection
/// `project_query_rows` produces from a full read: the latest non-attempt row
/// per request_key plus every provider-attempt row.
fn rebuild_query_rows(ports: &[PortProjectionState]) -> Vec<QueryRow> {
    let mut rows = Vec::new();
    for port in ports {
        rows.extend(port.latest.values().cloned());
    }
    for port in ports {
        rows.extend(port.attempts.iter().cloned());
    }
    project_query_rows(rows)
}
