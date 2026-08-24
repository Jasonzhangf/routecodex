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
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

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
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct V3ObsScope {
    pub port: u16,
    pub workdir: Option<String>,
    pub session: Option<String>,
}

/// Request identity fields shown in the main table + collapsible identity detail.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct V3ObsRequestMeta {
    pub request_id: String,
    pub endpoint: String,
    pub model: Option<String>,
    pub route: Option<String>,
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
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
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
    pub tokens_output: Option<u64>,
    // rawArtifactRef is a controlled reference only; never the full body.
    pub raw_artifact_ref: Option<String>,
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

impl Default for V3WebuiObservability {
    fn default() -> Self {
        Self::new()
    }
}

impl V3WebuiObservability {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(std::sync::Mutex::new(V3WebuiObservabilityInner::default())),
        }
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
                    row.tokens_output = usage.output_tokens;
                }
                inner.active.remove(request_key);
                if !was_terminal {
                    inner.terminal_order.push_back(request_key.to_string());
                    inner.terminal_keys.insert(request_key.to_string());
                    inner.terminal_key_order.push_back(request_key.to_string());
                    inner.stats.success += 1;
                    add_port_stats(&mut inner.stats, scope.port, |port| {
                        port.success += 1;
                    });
                    if let Some(tokens) = row.tokens_output {
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
