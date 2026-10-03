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
    offset: u64,
    line: usize,
    present: bool,
    rows: Vec<SourceRow>,
    max_seq: u64,
}

/// Process-wide observability read cache.
///
/// `projected` is the folded query projection of `ports` in configured listener
/// order, keyed by the store identities it was folded from, so a burst of
/// polling endpoints and SSE clients shares one fold instead of each re-reading
/// and re-projecting the whole history.
#[derive(Default)]
struct V3ObsStoreCache {
    ports: BTreeMap<PathBuf, V3ObsPortCache>,
    projected_from: Vec<(PathBuf, u64, u64, u64)>,
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
/// Returns `false` when the store file does not exist yet ("no traffic recorded
/// for this listener"). A store that exists but cannot be read or decoded is an
/// explicit error and never becomes an empty result.
fn refresh_v3_obs_port_cache(
    port: u16,
    path: &PathBuf,
    entry: &mut V3ObsPortCache,
) -> Result<bool, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            *entry = V3ObsPortCache::default();
            return Ok(false);
        }
        Err(error) => {
            return Err(format!("observability store {port} unavailable: {error}"));
        }
    };
    let (dev, ino, len) = (metadata.dev(), metadata.ino(), metadata.len());
    // A retention rewrite renames a fresh file into place, so the identity
    // change is the reset signal; a shrunk file covers an in-place truncation.
    if !entry.present || entry.dev != dev || entry.ino != ino || len < entry.offset {
        *entry = V3ObsPortCache {
            dev,
            ino,
            present: true,
            ..V3ObsPortCache::default()
        };
    }
    if len > entry.offset {
        let tail = routecodex_v3_debug::v3_webui_observability_read_raw_rows_from(
            path,
            entry.offset,
            entry.line,
        )
        .map_err(|error| format!("observability store {port} unavailable: {error}"))?;
        let mut decoded = Vec::with_capacity(tail.rows.len());
        for value in tail.rows {
            let row = serde_json::from_value::<SourceRow>(value).map_err(|error| {
                format!("decode observability store {port} row failed: {error}")
            })?;
            decoded.push(row);
        }
        // The whole tail is committed at once: a rejected row must not leave the
        // cache holding rows the offset has not consumed, which would re-append
        // them on every later poll.
        for row in decoded {
            entry.max_seq = entry.max_seq.max(row.updated_epoch_ms);
            entry.rows.push(row);
        }
        entry.offset = tail.next_offset;
        entry.line = tail.next_line_number;
    }
    Ok(true)
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
        let entry = cache.ports.entry(path.clone()).or_default();
        refresh_v3_obs_port_cache(*port, path, entry)?;
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
/// is reused until a store identity changes. The cache lock also single-flights
/// the concurrent polls of every open WebUI tab.
pub(super) fn read_v3_obs_projection(
    state: &AppState,
) -> Result<V3ObsProjection, (StatusCode, Value)> {
    let ports = observability_store_paths(state)
        .map_err(|error| (StatusCode::BAD_GATEWAY, json!({ "error": error })))?;
    let mut cache = v3_obs_cache_guard();
    let mut identity = Vec::with_capacity(ports.len());
    let mut max_seq = 0u64;
    for (port, path) in &ports {
        let entry = cache.ports.entry(path.clone()).or_default();
        match refresh_v3_obs_port_cache(*port, path, entry) {
            Ok(true) => max_seq = max_seq.max(entry.max_seq),
            Ok(false) => {}
            Err(error) => return Err((StatusCode::BAD_GATEWAY, json!({ "error": error }))),
        }
        identity.push((path.clone(), entry.dev, entry.ino, entry.offset));
    }
    cache
        .ports
        .retain(|path, _| ports.iter().any(|(_, known)| known == path));
    if cache.projected.is_none() || cache.projected_from != identity {
        let folded = project_query_rows(
            ports
                .iter()
                .filter_map(|(_, path)| cache.ports.get(path))
                .flat_map(|entry| entry.rows.iter()),
        );
        cache.projected = Some(Arc::new(folded));
        cache.projected_from = identity;
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
    let mut matching = Vec::new();
    for (port, path) in &ports {
        let entry = cache.ports.entry(path.clone()).or_default();
        if let Err(error) = refresh_v3_obs_port_cache(*port, path, entry) {
            return Err((StatusCode::BAD_GATEWAY, json!({ "error": error })));
        }
        matching.extend(
            entry
                .rows
                .iter()
                .filter(|row| row.request_key == request_key)
                .cloned(),
        );
    }
    Ok(matching)
}
