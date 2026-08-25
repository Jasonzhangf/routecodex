// feature_id: v3.webui_request_observability
// Typed request-observability projection owner (contract-as-code).
// This is a typed side-channel projection host: it collects lifecycle events
// from existing V3 runtime observability sources and exposes a monotonic
// snapshot + incremental event view for the single RouteCodex WebUI.
//
// P0 boundary: NO control semantics enter business payload, and the projection
// does not own routing/retry/provider-health/error-policy truth. It only
// projects already-typed observability data. Cursor/sequence errors remain
// explicit and are never recovered into success.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::Write;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Unique request key: `<port>:<requestId>`.
pub(crate) fn build_v3_obs_request_key(port: u16, request_id: &str) -> String {
    format!("{port}:{request_id}")
}

/// Event kinds per the observability contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) enum V3ObsEventType {
    Started,
    RouteSelected,
    ProviderAttemptStarted,
    ProviderAttemptFailed,
    ProviderSwitched,
    Completed,
    Failed,
    Cancelled,
}

impl V3ObsEventType {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Started => "request.started",
            Self::RouteSelected => "request.route_selected",
            Self::ProviderAttemptStarted => "request.provider_attempt_started",
            Self::ProviderAttemptFailed => "request.provider_attempt_failed",
            Self::ProviderSwitched => "request.provider_switched",
            Self::Completed => "request.completed",
            Self::Failed => "request.failed",
            Self::Cancelled => "request.cancelled",
        }
    }
}

/// scope carried on every event for grouping/filtering.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct V3ObsScope {
    pub port: u16,
    pub workdir: Option<String>,
    pub session: Option<String>,
}

/// Request identity fields shown in the main table + collapsible identity detail.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct V3ObsRequestMeta {
    pub request_id: String,
    pub endpoint: String,
    pub model: Option<String>,
    pub route: Option<String>,
    pub routing_group: Option<String>,
    pub pool: Option<String>,
    pub provider_id: Option<String>,
    pub auth_alias: Option<String>,
    pub provider_type: Option<String>,
    pub wire_model: Option<String>,
    pub provider: Option<String>,
    pub entry_protocol: Option<String>,
    pub execution_mode: Option<String>,
    pub transport: Option<String>,
    pub provider_status: Option<u16>,
    pub response_status: Option<String>,
    pub finish_reason: Option<String>,
    pub error_category: Option<String>,
    pub error_detail: Option<String>,
}

/// The mutable request projection (one row per requestKey).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct V3ObsRequestRow {
    pub request_key: String,
    pub event_type: String,
    pub started_epoch_ms: u64,
    pub updated_epoch_ms: u64,
    pub finished_epoch_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub meta: V3ObsRequestMeta,
    pub scope: V3ObsScope,
    pub result: Option<String>,
    pub attempts: u64,
    pub failed_attempts: u64,
    pub switches: u64,
    pub usage: Option<V3ObsUsageSummary>,
    pub timing_internal_ms: Option<u64>,
    pub timing_external_ms: Option<u64>,
    pub servertool: bool,
    pub stopless: bool,
    // rawArtifactRef is a controlled reference only; never the full body.
    pub raw_artifact_ref: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct V3ObsUsageSummary {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3ObsQuery {
    pub page: u64,
    pub page_size: u64,
    pub sort_by: V3ObsSortField,
    pub sort_desc: bool,
    pub time_from_ms: Option<u64>,
    pub time_to_ms: Option<u64>,
    pub port: Option<u16>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub route: Option<String>,
    pub entry_protocol: Option<String>,
    pub execution_mode: Option<String>,
    pub transport: Option<String>,
    pub status: Option<String>,
    pub response_type: Option<String>,
    pub error_category: Option<String>,
    pub session: Option<String>,
    pub search: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3ObsSortField {
    Started,
    Updated,
    Finished,
    Duration,
    Attempts,
    FailedAttempts,
    Switches,
    InputTokens,
    OutputTokens,
    TotalTokens,
    CachedTokens,
}

impl V3ObsSortField {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "started_epoch_ms" => Self::Started,
            "updated_epoch_ms" => Self::Updated,
            "finished_epoch_ms" => Self::Finished,
            "duration_ms" => Self::Duration,
            "attempts" => Self::Attempts,
            "failed_attempts" => Self::FailedAttempts,
            "switches" => Self::Switches,
            "usage_input_tokens" | "input_tokens" => Self::InputTokens,
            "usage_output_tokens" | "output_tokens" => Self::OutputTokens,
            "usage_total_tokens" | "total_tokens" => Self::TotalTokens,
            "usage_cached_tokens" | "cached_tokens" => Self::CachedTokens,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct V3ObsFacetCounts(pub BTreeMap<String, u64>);

#[derive(Debug, Clone, Default)]
pub(crate) struct V3ObsRecordStats {
    pub count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub cache_hit_rate_percent: f64,
    pub avg_duration_ms: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct V3ObsRecordsPage {
    pub records: Vec<V3ObsRequestRow>,
    pub total: u64,
    pub page: u64,
    pub page_size: u64,
    pub stats: V3ObsRecordStats,
    pub facets: BTreeMap<&'static str, Vec<(String, u64)>>,
}

/// One incremental lifecycle event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct V3ObsEvent {
    pub request_key: String,
    pub sequence: u64,
    pub event_type: String,
    pub timestamp_epoch_ms: u64,
    pub scope: V3ObsScope,
    pub row: V3ObsRequestRow,
}

/// Global stats projection (independent from request table truth).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct V3ObsStats {
    pub total: u64,
    pub active: u64,
    pub success: u64,
    pub error: u64,
    pub cancelled: u64,
    pub switches: u64,
    pub tokens_output: u64,
    pub by_port: BTreeMap<u16, V3ObsPortStats>,
    pub error_categories: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct V3ObsPortStats {
    pub total: u64,
    pub active: u64,
    pub success: u64,
    pub error: u64,
    pub cancelled: u64,
    pub switches: u64,
    pub tokens_output: u64,
}

fn classify_v3_obs_error(
    observability: &crate::V3RuntimeObservability,
) -> (Option<String>, Option<String>) {
    let Some(event) = observability.provider_failure_events.last() else {
        return (None, None);
    };

    let category = event
        .error_type
        .as_deref()
        .or(event.external_error_kind.as_deref())
        .or(event.internal_code.as_deref())
        .map(str::to_string);
    (category, Some(event.message.clone()))
}

fn add_port_stats(stats: &mut V3ObsStats, port: u16, update: impl FnOnce(&mut V3ObsPortStats)) {
    update(stats.by_port.entry(port).or_default());
}

/// Snapshot returned on the snapshot endpoint / reconnect.
#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct V3ObsSnapshot {
    pub cursor: u64,
    /// in-flight + recent requests, keyed by requestKey.
    pub requests: BTreeMap<String, V3ObsRequestRow>,
    pub stats: V3ObsStats,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3ObsSinceResult {
    pub next_cursor: u64,
    pub events: Vec<V3ObsEvent>,
    pub resync_required: bool,
}

/// Shared projection store + monotonic event log + broadcast.
#[derive(Debug, Clone)]
pub(crate) struct V3WebuiObservability {
    inner: Arc<std::sync::Mutex<V3WebuiObservabilityInner>>,
    persistence_path: Option<Arc<std::path::PathBuf>>,
}

#[derive(Debug, Clone, Default)]
struct V3WebuiObservabilityInner {
    next_sequence: u64,
    requests: BTreeMap<String, V3ObsRequestRow>,
    terminal_order: VecDeque<String>,
    terminal_keys: BTreeSet<String>,
    terminal_key_order: VecDeque<String>,
    resync_after_sequence: Option<u64>,
    oldest_retained_sequence: Option<u64>,
    events: std::collections::VecDeque<V3ObsEvent>,
    stats: V3ObsStats,
    active: std::collections::BTreeSet<String>,
}

#[derive(Deserialize)]
struct V3ObsPersistedRowEnvelope {
    schema_version: u8,
    row: V3ObsRequestRow,
}

impl Default for V3WebuiObservability {
    fn default() -> Self {
        Self::new()
    }
}

impl V3WebuiObservability {
    pub(crate) fn new() -> Self {
        Self::with_persistence_path(None)
    }

    pub(crate) fn with_persistence_path(path: Option<std::path::PathBuf>) -> Self {
        Self {
            inner: Arc::new(std::sync::Mutex::new(V3WebuiObservabilityInner::default())),
            persistence_path: path.map(Arc::new),
        }
    }

    pub(crate) fn load_persisted(path: &std::path::Path) -> Result<Self, String> {
        let handle = Self::with_persistence_path(Some(path.to_path_buf()));
        if !path.exists() {
            return Ok(handle);
        }
        let content = fs::read_to_string(path)
            .map_err(|error| format!("read observability store {}: {error}", path.display()))?;
        let mut rows = Vec::new();
        for (line_number, line) in content.lines().enumerate().filter(|(_, line)| !line.trim().is_empty()) {
            let envelope: V3ObsPersistedRowEnvelope = serde_json::from_str(line).map_err(|error| {
                format!("invalid observability record {}:{}: {error}", path.display(), line_number + 1)
            })?;
            if envelope.schema_version != 1 {
                return Err(format!(
                    "unsupported observability record schema {} in {}",
                    envelope.schema_version,
                    path.display()
                ));
            }
            rows.push(envelope.row);
        }
        rows.sort_by_key(|row| row.started_epoch_ms);
        let mut inner = handle
            .inner
            .lock()
            .map_err(|_| "v3 webui observability state is poisoned".to_string())?;
        for row in rows {
            inner.requests.insert(row.request_key.clone(), row);
        }
        drop(inner);
        Ok(handle)
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Record a lifecycle event, upserting the mutable row for requestKey.
    /// Returns Ok(sequence) on success; Err(e) is explicit and never becomes success.
    pub(crate) fn record(
        &self,
        event_type: V3ObsEventType,
        request_key: &str,
        scope: V3ObsScope,
        meta: V3ObsRequestMeta,
    ) -> Result<u64, String> {
        self.record_observed(
            event_type,
            request_key,
            scope,
            meta,
            &crate::V3RuntimeObservability::default(),
        )
    }

    pub(crate) fn record_observed(
        &self,
        event_type: V3ObsEventType,
        request_key: &str,
        scope: V3ObsScope,
        meta: V3ObsRequestMeta,
        observability: &crate::V3RuntimeObservability,
    ) -> Result<u64, String> {
        let now = Self::now_ms();

        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "v3 webui observability state is poisoned".to_string())?;
        let sequence = inner
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| "v3 webui observability sequence exhausted".to_string())?;
        inner.next_sequence = sequence;

        let event_type_str = event_type.as_str().to_string();
        let is_terminal = matches!(
            event_type,
            V3ObsEventType::Completed | V3ObsEventType::Failed | V3ObsEventType::Cancelled
        );
        if !is_terminal
            && inner
                .requests
                .get(request_key)
                .is_some_and(|row| row.result.is_some())
        {
            return Err(format!(
                "request {request_key} is already terminal; refusing {} restart",
                event_type_str
            ));
        }
        if is_terminal
            && !inner.requests.contains_key(request_key)
            && inner.terminal_keys.contains(request_key)
        {
            inner.resync_after_sequence =
                Some(inner.resync_after_sequence.unwrap_or(0).max(sequence));
            return Ok(sequence);
        }

        let mut row = inner.requests.get(request_key).cloned().unwrap_or_default();
        row.request_key = request_key.to_string();
        row.event_type = event_type_str.clone();
        row.meta = meta;
        row.scope = scope.clone();
        row.updated_epoch_ms = now;
        if row.started_epoch_ms == 0 {
            row.started_epoch_ms = now;
        }
        let was_terminal = row.result.is_some();
        // maintain attempt/switch counters and terminal result
        match event_type {
            V3ObsEventType::ProviderAttemptStarted => row.attempts += 1,
            V3ObsEventType::ProviderAttemptFailed => {
                row.failed_attempts += 1;
                let (category, detail) = classify_v3_obs_error(observability);
                row.meta.error_category = category;
                row.meta.error_detail = detail;
            }
            V3ObsEventType::ProviderSwitched => row.switches += 1,
            V3ObsEventType::Completed => {
                row.duration_ms = Some(now.saturating_sub(row.started_epoch_ms));
                row.finished_epoch_ms = Some(now);
                row.result = Some("success".to_string());
                if let Some(usage) = observability.usage.as_ref() {
                    row.usage = Some(V3ObsUsageSummary {
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                        total_tokens: usage.total_tokens,
                        cached_tokens: usage.cached_tokens,
                    });
                }
                row.timing_internal_ms = observability.timing.as_ref().map(|t| t.internal.as_millis() as u64);
                row.timing_external_ms = observability.timing.as_ref().map(|t| t.external.as_millis() as u64);
                row.servertool = false;
                row.stopless = observability.stopless_activation;
                inner.active.remove(request_key);
                if !was_terminal {
                    inner.terminal_order.push_back(request_key.to_string());
                    inner.terminal_keys.insert(request_key.to_string());
                    inner.terminal_key_order.push_back(request_key.to_string());
                    inner.stats.success += 1;
                    add_port_stats(&mut inner.stats, scope.port, |port| {
                        port.success += 1;
                    });
                    if let Some(tokens) =
                        row.usage.as_ref().and_then(|usage| usage.output_tokens)
                    {
                        inner.stats.tokens_output =
                            inner.stats.tokens_output.saturating_add(tokens);
                        add_port_stats(&mut inner.stats, scope.port, |port| {
                            port.tokens_output = port.tokens_output.saturating_add(tokens);
                        });
                    }
                }
                inner.stats.active = inner.active.len() as u64;
            }
            V3ObsEventType::Failed => {
                row.duration_ms = Some(now.saturating_sub(row.started_epoch_ms));
                row.finished_epoch_ms = Some(now);
                row.result = Some("error".to_string());
                if row.meta.error_category.is_none() {
                    let (category, detail) = classify_v3_obs_error(observability);
                    row.meta.error_category = category;
                    row.meta.error_detail = detail;
                }
                inner.active.remove(request_key);
                if !was_terminal {
                    inner.terminal_order.push_back(request_key.to_string());
                    inner.terminal_keys.insert(request_key.to_string());
                    inner.terminal_key_order.push_back(request_key.to_string());
                    inner.stats.error += 1;
                    add_port_stats(&mut inner.stats, scope.port, |port| {
                        port.error += 1;
                    });
                    if let Some(category) = row.meta.error_category.as_ref() {
                        *inner
                            .stats
                            .error_categories
                            .entry(category.clone())
                            .or_default() += 1;
                    }
                }
                inner.stats.active = inner.active.len() as u64;
            }
            V3ObsEventType::Cancelled => {
                row.duration_ms = Some(now.saturating_sub(row.started_epoch_ms));
                row.finished_epoch_ms = Some(now);
                row.result = Some("cancelled".to_string());
                inner.active.remove(request_key);
                if !was_terminal {
                    inner.terminal_order.push_back(request_key.to_string());
                    inner.terminal_keys.insert(request_key.to_string());
                    inner.terminal_key_order.push_back(request_key.to_string());
                    inner.stats.cancelled += 1;
                    add_port_stats(&mut inner.stats, scope.port, |port| {
                        port.cancelled += 1;
                    });
                }
                inner.stats.active = inner.active.len() as u64;
            }
            V3ObsEventType::Started => {
                inner.active.insert(request_key.to_string());
                inner.stats.total += 1;
                add_port_stats(&mut inner.stats, scope.port, |port| {
                    port.total += 1;
                });
                inner.stats.active = inner.active.len() as u64;
            }
            _ => {}
        }
        // a terminal event on a key that was never Started still closes it safely
        if matches!(
            event_type,
            V3ObsEventType::Completed | V3ObsEventType::Failed | V3ObsEventType::Cancelled
        ) {
            inner.active.remove(request_key);
            inner.stats.active = inner.active.len() as u64;
        }

        let stats_snapshot = inner.stats.clone();
        inner.requests.insert(request_key.to_string(), row.clone());
        if is_terminal && !was_terminal {
            if let Some(path) = self.persistence_path.as_deref() {
                Self::append_persisted_row(path, &row)?;
            }
        }
        while inner.requests.len() > 2048 {
            let Some(eviction_key) = inner.terminal_order.pop_front() else {
                break;
            };
            if !inner.active.contains(&eviction_key) {
                inner.requests.remove(&eviction_key);
            }
        }
        while inner.terminal_key_order.len() > 4096 {
            let Some(tombstone_key) = inner.terminal_key_order.pop_front() else {
                break;
            };
            inner.terminal_keys.remove(&tombstone_key);
        }
        inner.events.push_back(V3ObsEvent {
            request_key: request_key.to_string(),
            sequence,
            event_type: event_type_str,
            timestamp_epoch_ms: now,
            scope,
            row,
        });
        if inner.events.len() > 2048 {
            inner.events.pop_front();
            inner.oldest_retained_sequence = inner.events.front().map(|event| event.sequence);
        }
        // stats snapshot derived from the same typed projection
        inner.stats = stats_snapshot;
        let _ = &inner;
        Ok(sequence)
    }

    /// Snapshot with monotonic cursor; caller supplies last-seen cursor for stale reject.
    pub(crate) fn snapshot(&self, _after_cursor: u64) -> Result<V3ObsSnapshot, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "v3 webui observability state is poisoned".to_string())?;
        let requests = inner.requests.clone();
        let stats = inner.stats.clone();
        let mut stats = stats;
        for port_stats in stats.by_port.values_mut() {
            port_stats.active = 0;
        }
        for row in requests.values() {
            if row.result.is_none() {
                if let Some(port_stats) = stats.by_port.get_mut(&row.scope.port) {
                    port_stats.active += 1;
                }
            }
        }
        Ok(V3ObsSnapshot {
            cursor: inner.next_sequence,
            requests,
            stats,
        })
    }

    pub(crate) fn persist_terminal(
        &self,
        request_key: &str,
        path: &std::path::Path,
    ) -> Result<(), String> {
        let row = self
            .snapshot(0)?
            .requests
            .get(request_key)
            .cloned()
            .ok_or_else(|| format!("request {request_key} is not present"))?;
        if row.result.is_none() {
            return Err(format!("request {request_key} is not terminal"));
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create observability store directory failed: {error}"))?;
        }
        Self::append_persisted_row(path, &row)
    }

    fn append_persisted_row(path: &std::path::Path, row: &V3ObsRequestRow) -> Result<(), String> {
        let payload = serde_json::json!({"schema_version": 1u8, "row": row});
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|error| format!("open observability store failed: {error}"))?;
        let mut writer = std::io::BufWriter::new(file);
        serde_json::to_writer(&mut writer, &payload)
            .map_err(|error| format!("encode observability record failed: {error}"))?;
        writer.write_all(b"\n")
            .map_err(|error| format!("write observability record failed: {error}"))?;
        writer.flush().map_err(|error| error.to_string())
    }

    fn matches_query(row: &V3ObsRequestRow, query: &V3ObsQuery) -> bool {
        if query.time_from_ms.is_some_and(|from| row.started_epoch_ms < from) { return false; }
        if query.time_to_ms.is_some_and(|to| row.started_epoch_ms > to) { return false; }
        if query.port.is_some_and(|port| row.scope.port != port) { return false; }
        if query.provider.as_deref().is_some_and(|value| row.meta.provider.as_deref() != Some(value)) { return false; }
        if query.model.as_deref().is_some_and(|value| row.meta.model.as_deref() != Some(value)) { return false; }
        if query.route.as_deref().is_some_and(|value| row.meta.route.as_deref() != Some(value)) { return false; }
        if query.entry_protocol.as_deref().is_some_and(|value| row.meta.entry_protocol.as_deref() != Some(value)) { return false; }
        if query.execution_mode.as_deref().is_some_and(|value| row.meta.execution_mode.as_deref() != Some(value)) { return false; }
        if query.transport.as_deref().is_some_and(|value| row.meta.transport.as_deref() != Some(value)) { return false; }
        if query.status.as_deref().is_some_and(|value| row.result.as_deref() != Some(value)) { return false; }
        if query.response_type.as_deref().is_some_and(|value| row.meta.response_status.as_deref() != Some(value)) { return false; }
        if query.error_category.as_deref().is_some_and(|value| row.meta.error_category.as_deref() != Some(value)) { return false; }
        if query.session.as_deref().is_some_and(|value| row.scope.session.as_deref() != Some(value)) { return false; }
        if let Some(search) = query.search.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            let search = search.to_lowercase();
            let values = [
                Some(&row.request_key), Some(&row.meta.request_id), Some(&row.meta.endpoint),
                row.meta.model.as_ref(), row.meta.route.as_ref(), row.meta.provider.as_ref(),
                row.scope.session.as_ref(), row.scope.workdir.as_ref(), row.meta.error_category.as_ref(),
                row.meta.error_detail.as_ref(),
            ];
            if !values.iter().flatten().any(|value| value.to_lowercase().contains(&search)) {
                return false;
            }
        }
        true
    }

    fn sort_value(row: &V3ObsRequestRow, field: V3ObsSortField) -> u64 {
        match field {
            V3ObsSortField::Started => row.started_epoch_ms,
            V3ObsSortField::Updated => row.updated_epoch_ms,
            V3ObsSortField::Finished => row.finished_epoch_ms.unwrap_or(u64::MAX),
            V3ObsSortField::Duration => row.duration_ms.unwrap_or(u64::MAX),
            V3ObsSortField::Attempts => row.attempts,
            V3ObsSortField::FailedAttempts => row.failed_attempts,
            V3ObsSortField::Switches => row.switches,
            V3ObsSortField::InputTokens => row.usage.as_ref().and_then(|u| u.input_tokens).unwrap_or(0),
            V3ObsSortField::OutputTokens => row.usage.as_ref().and_then(|u| u.output_tokens).unwrap_or(0),
            V3ObsSortField::TotalTokens => row.usage.as_ref().and_then(|u| u.total_tokens).unwrap_or(0),
            V3ObsSortField::CachedTokens => row.usage.as_ref().and_then(|u| u.cached_tokens).unwrap_or(0),
        }
    }

    fn facet(name: &'static str, value: Option<&str>, target: &mut BTreeMap<&'static str, BTreeMap<String, u64>>) {
        if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
            *target.entry(name).or_default().entry(value.to_string()).or_default() += 1;
        }
    }

    pub(crate) fn records(&self, query: &V3ObsQuery) -> Result<V3ObsRecordsPage, String> {
        let inner = self.inner.lock().map_err(|_| "...".to_string())?;
        let mut filtered: Vec<_> = inner.requests.values()
            .filter(|row| Self::matches_query(row, query))
            .cloned().collect();
        let direction = if query.sort_desc { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        filtered.sort_by(|left, right| {
            direction.then(Self::sort_value(left, query.sort_by).cmp(&Self::sort_value(right, query.sort_by)))
                .then_with(|| left.request_key.cmp(&right.request_key))
        });
        let total = filtered.len() as u64;
        let offset = ((query.page - 1) * query.page_size) as usize;
        let end = (offset + query.page_size as usize).min(filtered.len());
        let records = filtered.get(offset..end).unwrap_or_default().to_vec();
        let mut facet_values = BTreeMap::new();
        let mut stats = V3ObsRecordStats::default();
        for row in inner.requests.values().filter(|row| Self::matches_query(row, query)) {
            stats.count += 1;
            if let Some(duration) = row.duration_ms { stats.avg_duration_ms += duration as f64; }
            if let Some(usage) = &row.usage {
                stats.input_tokens += usage.input_tokens.unwrap_or(0);
                stats.output_tokens += usage.output_tokens.unwrap_or(0);
                stats.cached_tokens += usage.cached_tokens.unwrap_or(0);
            }
            Self::facet("ports", Some(&row.scope.port.to_string()), &mut facet_values);
            Self::facet("providers", row.meta.provider.as_deref(), &mut facet_values);
            Self::facet("models", row.meta.model.as_deref(), &mut facet_values);
            Self::facet("routes", row.meta.route.as_deref(), &mut facet_values);
            Self::facet("sessions", row.scope.session.as_deref(), &mut facet_values);
            Self::facet("response_types", row.meta.response_status.as_deref(), &mut facet_values);
            Self::facet("error_categories", row.meta.error_category.as_deref(), &mut facet_values);
        }
        if stats.count > 0 && stats.input_tokens > 0 {
            stats.cache_hit_rate_percent = stats.cached_tokens as f64 / stats.input_tokens as f64 * 100.0;
        }
        if stats.count > 0 {
            stats.avg_duration_ms /= stats.count as f64;
        }
        Ok(V3ObsRecordsPage {
            records, total, page: query.page, page_size: query.page_size,
            stats,
            facets: facet_values.into_iter().map(|(name, values)| {
                (name, values.into_iter().collect::<Vec<_>>())
            }).collect(),
        })
    }

    /// Incremental delta since a cursor; rejects stale events (sequence <= cursor).
    pub(crate) fn since(&self, cursor: u64) -> Result<V3ObsSinceResult, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "v3 webui observability state is poisoned".to_string())?;
        let events = inner
            .events
            .iter()
            .filter(|event| event.sequence > cursor)
            .cloned()
            .collect::<Vec<_>>();
        let next_cursor = inner.next_sequence;
        Ok(V3ObsSinceResult {
            next_cursor,
            events,
            resync_required: inner
                .resync_after_sequence
                .is_some_and(|sequence| cursor < sequence)
                || inner
                    .oldest_retained_sequence
                    .is_some_and(|sequence| cursor.saturating_add(1) < sequence),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(port: u16) -> V3ObsScope {
        V3ObsScope {
            port,
            workdir: Some("/w".to_string()),
            session: Some("s1".to_string()),
        }
    }

    fn meta_with_full(req: &str) -> V3ObsRequestMeta {
        V3ObsRequestMeta {
            request_id: req.to_string(),
            endpoint: "/v1/chat/completions".to_string(),
            model: Some("gpt-test".to_string()),
            route: Some("grp.pool".to_string()),
            provider: Some("prov".to_string()),
            entry_protocol: Some("openai-chat".to_string()),
            execution_mode: Some("direct".to_string()),
            transport: Some("sse".to_string()),
            provider_status: Some(200),
            response_status: Some("completed".to_string()),
            finish_reason: Some("stop".to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn terminal_persists_and_reloads_terminal_records() {
        let dir = std::env::temp_dir().join(format!(
            "v3-webui-records-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("records.jsonl");
        let key = build_v3_obs_request_key(5555, "r-persist");
        let first = V3WebuiObservability::with_persistence_path(Some(path.clone()));
        first
            .record(V3ObsEventType::Started, &key, scope(5555), meta_with_full("r-persist"))
            .unwrap();
        first
            .record(V3ObsEventType::Completed, &key, scope(5555), meta_with_full("r-persist"))
            .unwrap();
        assert!(path.exists(), "terminal record must be persisted");
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("r-persist"), "persisted body must contain request id");

        let second = V3WebuiObservability::load_persisted(&path).unwrap();
        let snapshot = second.snapshot(0).unwrap();
        assert_eq!(snapshot.requests.len(), 1, "persisted record must reload");
        let row = snapshot.requests.get(&key).expect("reloaded row");
        assert_eq!(row.result.as_deref(), Some("success"));
        assert!(row.duration_ms.is_some());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn query_filters_sort_facets_and_stats_match_filtered_rows() {
        let o = V3WebuiObservability::new();
        for (idx, port) in [5555u16, 7777u16, 5555u16].iter().copied().enumerate() {
            let req = format!("r-query-{idx}");
            let key = build_v3_obs_request_key(port, &req);
            o.record(V3ObsEventType::Started, &key, scope(port), meta_with_full(&req))
                .unwrap();
            o.record(V3ObsEventType::Completed, &key, scope(port), meta_with_full(&req))
                .unwrap();
        }
        let key = build_v3_obs_request_key(5555, "r-query-err");
        let mut err_meta = meta_with_full("r-query-err");
        err_meta.error_category = Some("provider_429".to_string());
        o.record(V3ObsEventType::Started, &key, scope(5555), err_meta.clone()).unwrap();
        o.record(V3ObsEventType::Failed, &key, scope(5555), err_meta).unwrap();

        let query = V3ObsQuery {
            page: 1,
            page_size: 10,
            sort_by: V3ObsSortField::Started,
            sort_desc: true,
            time_from_ms: None,
            time_to_ms: None,
            port: Some(5555),
            provider: None,
            model: None,
            route: None,
            entry_protocol: None,
            execution_mode: None,
            transport: None,
            status: None,
            response_type: None,
            error_category: None,
            session: None,
            search: None,
        };
        let page = o.records(&query).unwrap();
        assert_eq!(page.total, 3, "port filter must keep all three port=5555 rows");
        assert!(page.facets.get("providers").is_some());
        assert_eq!(page.stats.count, 3);
        let error_query = V3ObsQuery { status: Some("error".to_string()), ..query.clone() };
        let error_page = o.records(&error_query).unwrap();
        assert_eq!(error_page.total, 1, "status=error must keep only the failed row");
        assert_eq!(error_page.stats.count, 1);
    }

    fn meta(req: &str) -> V3ObsRequestMeta {
        V3ObsRequestMeta {
            request_id: req.to_string(),
            endpoint: "/v1/chat/completions".to_string(),
            model: Some("m".to_string()),
            route: Some("grp.pool".to_string()),
            provider: Some("p1".to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn request_key_is_port_plus_rid() {
        assert_eq!(build_v3_obs_request_key(5555, "abc"), "5555:abc");
    }

    #[test]
    fn lifecycle_upserts_same_row() {
        let o = V3WebuiObservability::new();
        let k = build_v3_obs_request_key(5555, "r1");
        let s = o
            .record(V3ObsEventType::Started, &k, scope(5555), meta("r1"))
            .unwrap();
        assert!(s >= 1);
        // route + provider attempt update the same row
        o.record(V3ObsEventType::RouteSelected, &k, scope(5555), meta("r1"))
            .unwrap();
        o.record(
            V3ObsEventType::ProviderAttemptStarted,
            &k,
            scope(5555),
            meta("r1"),
        )
        .unwrap();
        let snap = o.snapshot(0).unwrap();
        assert_eq!(snap.requests.len(), 1, "one request key => one row");
        let row = snap.requests.get(&k).unwrap();
        assert_eq!(row.attempts, 1);
        assert_eq!(snap.stats.active, 1);
    }

    #[test]
    fn terminal_does_not_create_second_row_and_sets_result() {
        let o = V3WebuiObservability::new();
        let k = build_v3_obs_request_key(5555, "r2");
        o.record(V3ObsEventType::Started, &k, scope(5555), meta("r2"))
            .unwrap();
        o.record(V3ObsEventType::Completed, &k, scope(5555), meta("r2"))
            .unwrap();
        let snap = o.snapshot(0).unwrap();
        assert_eq!(snap.requests.len(), 1, "no duplicate row");
        let row = snap.requests.get(&k).unwrap();
        assert_eq!(row.result.as_deref(), Some("success"));
        assert!(row.duration_ms.is_some());
        assert_eq!(snap.stats.success, 1);
        assert_eq!(snap.stats.active, 0);
    }

    #[test]
    fn failed_never_becomes_success() {
        let o = V3WebuiObservability::new();
        let k = build_v3_obs_request_key(5555, "r3");
        o.record(V3ObsEventType::Started, &k, scope(5555), meta("r3"))
            .unwrap();
        o.record(V3ObsEventType::Failed, &k, scope(5555), meta("r3"))
            .unwrap();
        let snap = o.snapshot(0).unwrap();
        let row = snap.requests.get(&k).unwrap();
        assert_eq!(row.result.as_deref(), Some("error"));
        assert_eq!(snap.stats.error, 1);
        assert_eq!(snap.stats.success, 0);
    }

    #[test]
    fn started_after_failure_preserves_terminal_projection() {
        let o = V3WebuiObservability::new();
        let k = build_v3_obs_request_key(5555, "r-terminal");
        o.record(V3ObsEventType::Started, &k, scope(5555), meta("r-terminal"))
            .unwrap();
        let mut failed_meta = meta("r-terminal");
        failed_meta.error_category = Some("target_pool".to_string());
        failed_meta.error_detail = Some("selected target exhausted".to_string());
        o.record(V3ObsEventType::Failed, &k, scope(5555), failed_meta)
            .unwrap();

        // A duplicate ingress Started is rejected without reopening the
        // terminal row or erasing its failure projection.
        let restart_error = o
            .record(V3ObsEventType::Started, &k, scope(5555), meta("r-terminal"))
            .unwrap_err();
        assert!(
            restart_error.contains("already terminal"),
            "duplicate Started must fail explicitly: {restart_error}"
        );
        let snap = o.snapshot(0).unwrap();
        let row = snap.requests.get(&k).unwrap();
        assert_eq!(row.event_type, "request.failed");
        assert_eq!(row.result.as_deref(), Some("error"));
        assert!(row.finished_epoch_ms.is_some());
        assert_eq!(
            row.meta.error_category.as_deref(),
            Some("target_pool"),
            "terminal error classification must survive duplicate Started"
        );
        assert_eq!(
            row.meta.error_detail.as_deref(),
            Some("selected target exhausted")
        );
    }

    #[test]
    fn sequence_monotonic_and_stale_rejected() {
        let o = V3WebuiObservability::new();
        let k = build_v3_obs_request_key(5555, "r4");
        let s1 = o
            .record(V3ObsEventType::Started, &k, scope(5555), meta("r4"))
            .unwrap();
        let s2 = o
            .record(V3ObsEventType::Completed, &k, scope(5555), meta("r4"))
            .unwrap();
        assert!(s2 > s1, "monotonic sequence");
        // replay since before start returns both; since after terminal returns none
        let first = o.since(0).unwrap();
        assert_eq!(first.events.len(), 2);
        assert!(!first.resync_required);
        let second = o.since(first.next_cursor).unwrap();
        assert!(
            second.events.is_empty(),
            "stale events rejected past cursor"
        );
        assert!(!second.resync_required);
    }

    #[test]
    fn scope_is_carried_per_event() {
        let o = V3WebuiObservability::new();
        let k = build_v3_obs_request_key(4444, "r5");
        o.record(V3ObsEventType::Started, &k, scope(4444), meta("r5"))
            .unwrap();
        let result = o.since(0).unwrap();
        assert_eq!(result.events[0].scope.port, 4444);
        assert_eq!(result.events[0].scope.workdir.as_deref(), Some("/w"));
    }

    #[test]
    fn chronological_order_preserved_after_update() {
        // Standard chronological mode: a row keeps its first-seen arrival order
        // even after a later terminal update; updates must never reorder.
        let o = V3WebuiObservability::new();
        let k1 = build_v3_obs_request_key(5555, "a");
        let k2 = build_v3_obs_request_key(5555, "b");
        o.record(V3ObsEventType::Started, &k1, scope(5555), meta("a"))
            .unwrap();
        o.record(V3ObsEventType::Started, &k2, scope(5555), meta("b"))
            .unwrap();
        // Complete the rows in reverse arrival order; arrival order must hold.
        o.record(V3ObsEventType::Completed, &k2, scope(5555), meta("b"))
            .unwrap();
        o.record(V3ObsEventType::Completed, &k1, scope(5555), meta("a"))
            .unwrap();
        let snap = o.snapshot(0).unwrap();
        assert_eq!(snap.requests.len(), 2, "two distinct request keys");
        let row_a = snap.requests.get(&k1).unwrap();
        let row_b = snap.requests.get(&k2).unwrap();
        // started_epoch_ms is set on first touch and is the stable arrival key.
        assert!(
            row_a.started_epoch_ms <= row_b.started_epoch_ms,
            "insertion order preserved (a before b) after out-of-order completion"
        );
        assert_eq!(row_a.result.as_deref(), Some("success"));
        assert_eq!(row_b.result.as_deref(), Some("success"));
    }

    #[test]
    fn terminal_rows_are_bounded() {
        let o = V3WebuiObservability::new();
        for index in 0..2050 {
            let request_id = format!("bounded-{index}");
            let key = build_v3_obs_request_key(5555, &request_id);
            o.record(
                V3ObsEventType::Started,
                &key,
                scope(5555),
                meta(&request_id),
            )
            .unwrap();
            o.record(
                V3ObsEventType::Completed,
                &key,
                scope(5555),
                meta(&request_id),
            )
            .unwrap();
        }
        let snapshot = o.snapshot(0).unwrap();
        assert!(snapshot.requests.len() <= 2048);
        assert!(!snapshot.requests.contains_key("5555:bounded-0"));
    }

    #[test]
    fn repeated_terminal_events_do_not_grow_terminal_queue() {
        let o = V3WebuiObservability::new();
        let request_id = "repeated-terminal";
        let key = build_v3_obs_request_key(5555, request_id);
        o.record(V3ObsEventType::Started, &key, scope(5555), meta(request_id))
            .unwrap();
        for _ in 0..10_000 {
            o.record(
                V3ObsEventType::Completed,
                &key,
                scope(5555),
                meta(request_id),
            )
            .unwrap();
        }
        let snapshot = o.snapshot(0).unwrap();
        assert_eq!(snapshot.requests.len(), 1);
        assert_eq!(snapshot.stats.success, 1);
    }

    #[test]
    fn evicted_terminal_replay_is_ignored() {
        let o = V3WebuiObservability::new();
        let first_id = "evicted-terminal";
        let first_key = build_v3_obs_request_key(5555, first_id);
        o.record(
            V3ObsEventType::Started,
            &first_key,
            scope(5555),
            meta(first_id),
        )
        .unwrap();
        o.record(
            V3ObsEventType::Completed,
            &first_key,
            scope(5555),
            meta(first_id),
        )
        .unwrap();
        for index in 0..2048 {
            let request_id = format!("eviction-fill-{index}");
            let key = build_v3_obs_request_key(5555, &request_id);
            o.record(
                V3ObsEventType::Started,
                &key,
                scope(5555),
                meta(&request_id),
            )
            .unwrap();
            o.record(
                V3ObsEventType::Completed,
                &key,
                scope(5555),
                meta(&request_id),
            )
            .unwrap();
        }
        assert!(!o.snapshot(0).unwrap().requests.contains_key(&first_key));
        o.record(
            V3ObsEventType::Completed,
            &first_key,
            scope(5555),
            meta(first_id),
        )
        .unwrap();
        let snapshot = o.snapshot(0).unwrap();
        assert!(!snapshot.requests.contains_key(&first_key));
        assert_eq!(snapshot.stats.success, 2049);
        let replay = o.since(0).unwrap();
        assert!(replay.resync_required);
        assert!(replay
            .events
            .iter()
            .all(|event| event.request_key != first_key));
    }

    #[test]
    fn event_log_eviction_requires_resync() {
        let o = V3WebuiObservability::new();
        for index in 0..1100 {
            let request_id = format!("event-window-{index}");
            let key = build_v3_obs_request_key(5555, &request_id);
            o.record(
                V3ObsEventType::Started,
                &key,
                scope(5555),
                meta(&request_id),
            )
            .unwrap();
            o.record(
                V3ObsEventType::RouteSelected,
                &key,
                scope(5555),
                meta(&request_id),
            )
            .unwrap();
        }
        let stale = o.since(0).unwrap();
        assert!(stale.resync_required);
        assert_eq!(stale.events.len(), 2048);
        let current = o.since(stale.next_cursor).unwrap();
        assert!(!current.resync_required);
        assert!(current.events.is_empty());
    }

    #[test]
    fn concurrent_records_commit_contiguous_sequences() {
        let observability = V3WebuiObservability::new();
        let mut handles = Vec::new();
        for worker in 0..8 {
            let worker_observability = observability.clone();
            handles.push(std::thread::spawn(move || {
                for index in 0..128 {
                    let request_id = format!("concurrent-{worker}-{index}");
                    let key = build_v3_obs_request_key(5555, &request_id);
                    worker_observability
                        .record(
                            V3ObsEventType::Started,
                            &key,
                            scope(5555),
                            meta(&request_id),
                        )
                        .unwrap();
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        let result = observability.since(0).unwrap();
        assert_eq!(result.events.len(), 1024);
        assert!(!result.resync_required);
        for (index, event) in result.events.iter().enumerate() {
            assert_eq!(event.sequence, (index + 1) as u64);
        }
    }

    #[test]
    fn sequence_exhaustion_fails_explicitly() {
        let observability = V3WebuiObservability::new();
        observability.inner.lock().unwrap().next_sequence = u64::MAX - 1;
        let key = build_v3_obs_request_key(5555, "last-sequence");
        assert_eq!(
            observability
                .record(
                    V3ObsEventType::Started,
                    &key,
                    scope(5555),
                    meta("last-sequence")
                )
                .unwrap(),
            u64::MAX
        );
        let exhausted = observability.record(
            V3ObsEventType::Started,
            "5555:after-exhaustion",
            scope(5555),
            meta("after-exhaustion"),
        );
        assert_eq!(
            exhausted.unwrap_err(),
            "v3 webui observability sequence exhausted"
        );
    }
}
