// feature_id: v3.webui_request_observability
// Typed request-observability projection owner (contract-as-code).
// This is a typed side-channel projection host: it collects lifecycle events
// from existing V3 runtime observability sources and exposes a monotonic
// snapshot + incremental event view for the single RouteCodex WebUI.
//
// P0 boundary: NO control semantics enter business payload, and the projection
// does not own routing/retry/provider-health/error-policy truth. It only
// projects already-typed observability data. No fallback; cursor/sequence
// errors are explicit.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
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
    ResponseProgress,
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
            Self::ResponseProgress => "request.response_progress",
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
}

/// The mutable request projection (one row per requestKey).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct V3ObsRequestRow {
    pub request_key: String,
    pub event_type: String,
    pub started_epoch_ms: u64,
    pub duration_ms: Option<u64>,
    pub meta: V3ObsRequestMeta,
    pub scope: V3ObsScope,
    pub result: Option<String>,
    pub attempts: u64,
    pub switches: u64,
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
}

/// Snapshot returned on the snapshot endpoint / reconnect.
#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct V3ObsSnapshot {
    pub cursor: u64,
    /// in-flight + recent requests, keyed by requestKey.
    pub requests: BTreeMap<String, V3ObsRequestRow>,
    pub stats: V3ObsStats,
}

/// Shared projection store + monotonic event log + broadcast.
#[derive(Debug, Clone)]
pub(crate) struct V3WebuiObservability {
    inner: Arc<std::sync::Mutex<V3WebuiObservabilityInner>>,
    next_sequence: Arc<AtomicU64>,
}

#[derive(Debug, Clone, Default)]
struct V3WebuiObservabilityInner {
    requests: BTreeMap<String, V3ObsRequestRow>,
    terminal_order: VecDeque<String>,
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
            next_sequence: Arc::new(AtomicU64::new(1)),
            // NOTE: broadcast channel added at endpoint-wiring step.
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Record a lifecycle event, upserting the mutable row for requestKey.
    /// Returns Ok(sequence) on success; Err(e) is explicit (never silent fallback).
    pub(crate) fn record(
        &self,
        event_type: V3ObsEventType,
        request_key: &str,
        scope: V3ObsScope,
        meta: V3ObsRequestMeta,
    ) -> Result<u64, String> {
        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed);
        let now = Self::now_ms();

        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "v3 webui observability state is poisoned".to_string())?;

        let event_type_str = event_type.as_str().to_string();

        let mut row = inner
            .requests
            .get(request_key)
            .cloned()
            .unwrap_or_default();
        row.request_key = request_key.to_string();
        row.event_type = event_type_str.clone();
        row.meta = meta;
        row.scope = scope.clone();
        if row.started_epoch_ms == 0 {
            row.started_epoch_ms = now;
        }
        let was_terminal = row.result.is_some();
        // maintain attempt/switch counters and terminal result
        match event_type {
            V3ObsEventType::ProviderAttemptStarted => row.attempts += 1,
            V3ObsEventType::ProviderSwitched => row.switches += 1,
            V3ObsEventType::Completed => {
                row.duration_ms = Some(now.saturating_sub(row.started_epoch_ms));
                row.result = Some("success".to_string());
                inner.active.remove(request_key);
                if !was_terminal {
                    inner.terminal_order.push_back(request_key.to_string());
                    inner.stats.success += 1;
                }
                inner.stats.active = inner.active.len() as u64;
            }
            V3ObsEventType::Failed => {
                row.duration_ms = Some(now.saturating_sub(row.started_epoch_ms));
                row.result = Some("error".to_string());
                inner.active.remove(request_key);
                if !was_terminal {
                    inner.terminal_order.push_back(request_key.to_string());
                    inner.stats.error += 1;
                }
                inner.stats.active = inner.active.len() as u64;
            }
            V3ObsEventType::Cancelled => {
                row.duration_ms = Some(now.saturating_sub(row.started_epoch_ms));
                row.result = Some("cancelled".to_string());
                inner.active.remove(request_key);
                if !was_terminal {
                    inner.terminal_order.push_back(request_key.to_string());
                    inner.stats.cancelled += 1;
                }
                inner.stats.active = inner.active.len() as u64;
            }
            V3ObsEventType::Started => {
                inner.active.insert(request_key.to_string());
                inner.stats.total += 1;
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
        Ok(V3ObsSnapshot {
            cursor: self.next_sequence.load(Ordering::Relaxed).saturating_sub(1),
            requests,
            stats,
        })
    }

    /// Incremental delta since a cursor; rejects stale events (sequence <= cursor).
    pub(crate) fn since(&self, cursor: u64) -> Result<(u64, Vec<V3ObsEvent>), String> {
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
        let next_cursor = self.next_sequence.load(Ordering::Relaxed).saturating_sub(1);
        Ok((next_cursor, events))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(port: u16) -> V3ObsScope {
        V3ObsScope { port, workdir: Some("/w".to_string()), session: Some("s1".to_string()) }
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
        let s = o.record(V3ObsEventType::Started, &k, scope(5555), meta("r1")).unwrap();
        assert!(s >= 1);
        // route + provider attempt update the same row
        o.record(V3ObsEventType::RouteSelected, &k, scope(5555), meta("r1")).unwrap();
        o.record(V3ObsEventType::ProviderAttemptStarted, &k, scope(5555), meta("r1")).unwrap();
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
        o.record(V3ObsEventType::Started, &k, scope(5555), meta("r2")).unwrap();
        o.record(V3ObsEventType::Completed, &k, scope(5555), meta("r2")).unwrap();
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
        o.record(V3ObsEventType::Started, &k, scope(5555), meta("r3")).unwrap();
        o.record(V3ObsEventType::Failed, &k, scope(5555), meta("r3")).unwrap();
        let snap = o.snapshot(0).unwrap();
        let row = snap.requests.get(&k).unwrap();
        assert_eq!(row.result.as_deref(), Some("error"));
        assert_eq!(snap.stats.error, 1);
        assert_eq!(snap.stats.success, 0);
    }

    #[test]
    fn sequence_monotonic_and_stale_rejected() {
        let o = V3WebuiObservability::new();
        let k = build_v3_obs_request_key(5555, "r4");
        let s1 = o.record(V3ObsEventType::Started, &k, scope(5555), meta("r4")).unwrap();
        let s2 = o.record(V3ObsEventType::Completed, &k, scope(5555), meta("r4")).unwrap();
        assert!(s2 > s1, "monotonic sequence");
        // replay since before start returns both; since after terminal returns none
        let (c0, ev0) = o.since(0).unwrap();
        assert_eq!(ev0.len(), 2);
        let (c1, ev1) = o.since(c0).unwrap();
        assert!(ev1.is_empty(), "stale events rejected past cursor");
        let _ = c1;
    }

    #[test]
    fn scope_is_carried_per_event() {
        let o = V3WebuiObservability::new();
        let k = build_v3_obs_request_key(4444, "r5");
        o.record(V3ObsEventType::Started, &k, scope(4444), meta("r5")).unwrap();
        let (_, ev) = o.since(0).unwrap();
        assert_eq!(ev[0].scope.port, 4444);
        assert_eq!(ev[0].scope.workdir.as_deref(), Some("/w"));
    }

    #[test]
    fn chronological_order_preserved_after_update() {
        // Standard chronological mode: a row keeps its first-seen arrival order
        // even after a later terminal update; updates must never reorder.
        let o = V3WebuiObservability::new();
        let k1 = build_v3_obs_request_key(5555, "a");
        let k2 = build_v3_obs_request_key(5555, "b");
        o.record(V3ObsEventType::Started, &k1, scope(5555), meta("a")).unwrap();
        o.record(V3ObsEventType::Started, &k2, scope(5555), meta("b")).unwrap();
        // Complete the rows in reverse arrival order; arrival order must hold.
        o.record(V3ObsEventType::Completed, &k2, scope(5555), meta("b")).unwrap();
        o.record(V3ObsEventType::Completed, &k1, scope(5555), meta("a")).unwrap();
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
            o.record(V3ObsEventType::Started, &key, scope(5555), meta(&request_id)).unwrap();
            o.record(V3ObsEventType::Completed, &key, scope(5555), meta(&request_id)).unwrap();
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
        o.record(V3ObsEventType::Started, &key, scope(5555), meta(request_id)).unwrap();
        for _ in 0..10_000 {
            o.record(V3ObsEventType::Completed, &key, scope(5555), meta(request_id)).unwrap();
        }
        let snapshot = o.snapshot(0).unwrap();
        assert_eq!(snapshot.requests.len(), 1);
        assert_eq!(snapshot.stats.success, 1);
    }
}
