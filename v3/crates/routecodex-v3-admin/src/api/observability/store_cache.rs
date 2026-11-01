//! Incremental read cache for the per-listener observability JSONL stores.
//!
//! Every WebUI surface needs the persisted rows, and the stores are append-only
//! between retention rewrites, so one process-wide cache decodes only the bytes
//! appended since the previous read and folds the query projection once for all
//! concurrent pollers. Extracted from `observability.rs` to keep that file under
//! the module-size limit; behavior is unchanged.

use super::{project_query_rows, QueryRow, SourceRow};
use crate::AppState;
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

pub(super) fn configured_ports(state: &AppState) -> Result<Vec<u16>, String> {
    Ok(observability_store_paths(state)?
        .into_iter()
        .map(|(port, _)| port)
        .collect())
}

/// Configured listener ports paired with their per-listener JSONL store path.
///
/// Server and Admin derive the path from the shared config helper using the
/// authoring debug log file truth. The authoring truth is read once here: a
/// per-port `read_authoring()` recompiled the whole provider directory for
/// every listener on every observability read.
///
/// Empty when the authoring config enables no listener.
fn observability_store_sources(state: &AppState) -> Result<Vec<(u16, PathBuf)>, String> {
    let authoring = state
        .store
        .read_authoring()
        .map_err(|error| format!("observability config read failed: {error}"))?;
    let mut ports = authoring
        .servers
        .values()
        .filter(|server| server.enabled)
        .map(|server| server.port)
        .collect::<Vec<_>>();
    ports.sort_unstable();
    ports.dedup();
    let debug_log = authoring.debug.log_file.as_deref();
    Ok(ports
        .into_iter()
        .map(|port| {
            (
                port,
                routecodex_v3_config::v3_webui_observability_store_path(
                    &state.config_path,
                    debug_log,
                    port,
                ),
            )
        })
        .collect())
}

/// `observability_store_sources` for the query surfaces, which have always
/// reported a config with no enabled listener as an error rather than as an
/// empty history.
fn observability_store_paths(state: &AppState) -> Result<Vec<(u16, PathBuf)>, String> {
    let sources = observability_store_sources(state)?;
    if sources.is_empty() {
        return Err("observability has no enabled listener source".to_string());
    }
    Ok(sources)
}

/// Incremental reader position and decoded rows for one listener store.
///
/// The store is append-only between retention rewrites, so a reader that keeps
/// the last consumed byte offset decodes only newly appended records instead of
/// the whole history on every WebUI poll.
#[derive(Default)]
struct V3ObsPortCache {
    dev: u64,
    ino: u64,
    len: u64,
    modified: Option<SystemTime>,
    /// Inode change time. `modified` can be set back to its previous value from
    /// userspace, so a same-length in-place rewrite with a restored mtime would
    /// otherwise look unchanged; ctime cannot be set that way.
    ctime: i64,
    ctime_nsec: i64,
    offset: u64,
    line: usize,
    present: bool,
    rows: Vec<SourceRow>,
    max_seq: u64,
}

/// Process-wide observability read cache.
///
/// `projected` is the folded query projection of `ports` in configured listener
/// order, refolded whenever any port's content changed or the configured path
/// list changed, so a burst of polling endpoints and SSE clients shares one fold
/// instead of each re-reading and re-projecting the whole history.
#[derive(Default)]
struct V3ObsStoreCache {
    ports: BTreeMap<PathBuf, V3ObsPortCache>,
    projected_paths: Vec<PathBuf>,
    projected: Option<Arc<Vec<QueryRow>>>,
}

fn v3_obs_store_cache() -> &'static Mutex<V3ObsStoreCache> {
    static CACHE: OnceLock<Mutex<V3ObsStoreCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(V3ObsStoreCache::default()))
}

fn v3_obs_cache_guard() -> std::sync::MutexGuard<'static, V3ObsStoreCache> {
    v3_obs_store_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

/// Refreshes one listener store cache entry from disk.
///
/// Returns whether this port's cached rows changed, so the caller refolds the
/// shared projection exactly when it must. An absent store file is an empty
/// history for that listener, not an error; a store that exists but cannot be
/// read or decoded is an explicit error and never becomes an empty result.
///
/// The entry is committed only after every newly read row decoded, so a
/// rejected row can never advance the reader past bytes it never decoded: the
/// same error is reported again on the next poll, and the reader position is
/// reset so the next attempt rebuilds from the start instead of resuming into a
/// prefix this reader can no longer vouch for.
fn refresh_v3_obs_port_cache(
    port: u16,
    path: &PathBuf,
    entry: &mut V3ObsPortCache,
) -> Result<bool, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Only a port that still held rows is a change; a store that was
            // already absent stays absent without invalidating the projection.
            let changed = entry.present;
            *entry = V3ObsPortCache::default();
            return Ok(changed);
        }
        Err(error) => {
            return Err(format!("observability store {port} unavailable: {error}"));
        }
    };
    let (dev, ino, len) = (metadata.dev(), metadata.ino(), metadata.len());
    let modified = metadata.modified().ok();
    let (ctime, ctime_nsec) = (metadata.ctime(), metadata.ctime_nsec());
    // Nothing changed since the last refresh: no decode, no re-fold.
    if entry.present
        && entry.dev == dev
        && entry.ino == ino
        && entry.len == len
        && entry.modified == modified
        && entry.ctime == ctime
        && entry.ctime_nsec == ctime_nsec
    {
        return Ok(false);
    }
    // The store contract permits only append-in-place or atomic replacement, so
    // the cache resumes only for the same device/inode with a strictly larger
    // file that already has a consumed prefix. A replaced inode, a shrunk file,
    // or a same-length file rewritten in place rebuilds this port from scratch.
    let append_only = entry.present
        && entry.dev == dev
        && entry.ino == ino
        && len > entry.len
        && len > entry.offset
        && entry.offset > 0;
    let start_offset = if append_only { entry.offset } else { 0 };
    let start_line = if append_only { entry.line } else { 0 };
    let mut decoded = Vec::new();
    let mut next_offset = start_offset;
    let mut next_line = start_line;
    if len > start_offset {
        let read = match routecodex_v3_debug::v3_webui_observability_read_raw_rows_from(
            path,
            start_offset,
            start_line,
        ) {
            Ok(read) => read,
            Err(error) => {
                reset_v3_obs_reader_position(entry);
                return Err(format!("observability store {port} unavailable: {error}"));
            }
        };
        next_offset = read.next_offset;
        next_line = read.next_line_number;
        for value in read.rows {
            let row = match serde_json::from_value::<SourceRow>(value) {
                Ok(row) => row,
                Err(error) => {
                    reset_v3_obs_reader_position(entry);
                    return Err(format!(
                        "decode observability store {port} row failed: {error}"
                    ));
                }
            };
            decoded.push(row);
        }
    }
    // Commit only now. The whole tail lands at once, so a rejected row can never
    // leave the cache holding rows its offset has not consumed, and a failed
    // read can never advance the identity past bytes that were never decoded.
    if !append_only {
        entry.rows.clear();
        entry.max_seq = 0;
    }
    for row in decoded {
        entry.max_seq = entry.max_seq.max(row.updated_epoch_ms);
        entry.rows.push(row);
    }
    entry.offset = next_offset;
    entry.line = next_line;
    entry.dev = dev;
    entry.ino = ino;
    entry.len = len;
    entry.modified = modified;
    entry.ctime = ctime;
    entry.ctime_nsec = ctime_nsec;
    entry.present = true;
    Ok(true)
}

/// Forgets the reader position after a refresh failed.
///
/// The entry keeps the identity of the last successful refresh, so the failure
/// is reported again on the next poll instead of being papered over. The offset
/// and line must not survive it, though: they describe a file this reader can no
/// longer vouch for, and resuming from a stale offset would silently skip the
/// prefix of whatever the path holds next — including rows the reader never saw.
fn reset_v3_obs_reader_position(entry: &mut V3ObsPortCache) {
    entry.offset = 0;
    entry.line = 0;
}

/// Refreshes one port and drops the shared fold when that port's rows changed.
///
/// The projection is shared by every consumer, so whichever one happens to
/// observe an append has to invalidate it. Refreshing the port without doing so
/// would let a later `read_v3_obs_projection` find the port already up to date,
/// conclude nothing changed, and serve the fold built before the append.
fn refresh_v3_obs_store(
    cache: &mut V3ObsStoreCache,
    port: u16,
    path: &PathBuf,
) -> Result<(), String> {
    let changed = {
        let entry = cache.ports.entry(path.clone()).or_default();
        refresh_v3_obs_port_cache(port, path, entry)?
    };
    if changed {
        cache.projected = None;
    }
    Ok(())
}

/// Visits the decoded raw rows of every configured listener store through the
/// same incremental cache the records, detail and SSE paths use.
///
/// The dashboard aggregates with the `request_key` folding of
/// `v3_webui_observability_read_rows` rather than the query projection, so it
/// needs the raw per-store rows; it shares the decoded row cache instead of
/// re-reading whole stores through a second reader.
pub(crate) fn visit_v3_obs_stores(
    state: &AppState,
    mut visit: impl FnMut(u16, &[SourceRow]),
) -> Result<(), String> {
    // A config that enables no listener has no store to visit. The overview has
    // always aggregated that as an empty history instead of failing.
    let ports = observability_store_sources(state)?;
    let mut cache = v3_obs_cache_guard();
    for (port, path) in &ports {
        refresh_v3_obs_store(&mut cache, *port, path)?;
    }
    cache
        .ports
        .retain(|path, _| ports.iter().any(|(_, known)| known == path));
    for (port, path) in &ports {
        if let Some(entry) = cache.ports.get(path) {
            visit(*port, &entry.rows);
        }
    }
    Ok(())
}

/// Folded query projection of every persisted observability row.
pub(super) struct V3ObsProjection {
    pub(super) rows: Arc<Vec<QueryRow>>,
    /// Highest `updated_epoch_ms` across every cached row.
    pub(super) max_seq: u64,
}

/// Reads the folded projection of every configured listener store.
///
/// Only records appended since the previous read are decoded; the fold itself
/// is reused until a store's content changes or the configured path list
/// changes. The cache lock also single-flights the concurrent polls of every
/// open WebUI tab.
pub(super) fn read_v3_obs_projection(
    state: &AppState,
) -> Result<V3ObsProjection, (StatusCode, Value)> {
    let ports = observability_store_paths(state)
        .map_err(|error| (StatusCode::BAD_GATEWAY, json!({ "error": error })))?;
    let mut cache = v3_obs_cache_guard();
    let mut projected_paths = Vec::with_capacity(ports.len());
    let mut max_seq = 0u64;
    for (port, path) in &ports {
        if let Err(error) = refresh_v3_obs_store(&mut cache, *port, path) {
            return Err((StatusCode::BAD_GATEWAY, json!({ "error": error })));
        }
        if let Some(entry) = cache.ports.get(path) {
            if entry.present {
                max_seq = max_seq.max(entry.max_seq);
            }
        }
        projected_paths.push(path.clone());
    }
    cache
        .ports
        .retain(|path, _| ports.iter().any(|(_, known)| known == path));
    if cache.projected.is_none() || cache.projected_paths != projected_paths {
        let folded = project_query_rows(
            ports
                .iter()
                .filter_map(|(_, path)| cache.ports.get(path))
                .flat_map(|entry| entry.rows.iter()),
        );
        cache.projected = Some(Arc::new(folded));
        cache.projected_paths = projected_paths;
    }
    Ok(V3ObsProjection {
        rows: Arc::clone(
            cache
                .projected
                .as_ref()
                .expect("projection is cached by the branch above"),
        ),
        max_seq,
    })
}

/// Every persisted lifecycle row of one request, in configured listener order.
pub(super) fn read_v3_obs_rows_for_request_key(
    state: &AppState,
    request_key: &str,
) -> Result<Vec<SourceRow>, (StatusCode, Value)> {
    let ports = observability_store_paths(state)
        .map_err(|error| (StatusCode::BAD_GATEWAY, json!({ "error": error })))?;
    let mut cache = v3_obs_cache_guard();
    for (port, path) in &ports {
        if let Err(error) = refresh_v3_obs_store(&mut cache, *port, path) {
            return Err((StatusCode::BAD_GATEWAY, json!({ "error": error })));
        }
    }
    // Drop entries for ports the config no longer lists, so a removed listener
    // does not keep a decoded store resident.
    cache
        .ports
        .retain(|path, _| ports.iter().any(|(_, known)| known == path));
    let mut matching = Vec::new();
    for (_, path) in &ports {
        if let Some(entry) = cache.ports.get(path) {
            matching.extend(
                entry
                    .rows
                    .iter()
                    .filter(|row| row.request_key == request_key)
                    .cloned(),
            );
        }
    }
    Ok(matching)
}
