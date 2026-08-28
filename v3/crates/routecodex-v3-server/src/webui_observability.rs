// feature_id: v3.webui_request_observability
// Typed request-observability projection owner (contract-as-code).
// This is a typed side-channel projection host: it merges lifecycle events
// from existing V3 runtime observability sources into one row per request and
// appends that row to the per-listener JSONL store. Admin reads the same store
// directly; there is no loopback snapshot/event transport.
//
// P0 boundary: NO control semantics enter business payload, and the projection
// does not own routing/retry/provider-health/error-policy truth. It only
// projects already-typed observability data. Store IO errors remain explicit
// and are never recovered into success.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Unique request key: `<port>:<requestId>`.
pub(crate) fn build_v3_obs_request_key(port: u16, request_id: &str) -> String {
    format!("{port}:{request_id}")
}

/// Single server-side ingress for the typed request-observability projection.
/// Console/runtime/Error06 callers must not call V3WebuiObservability methods directly.
pub(crate) fn record_v3_observability_event(
    observability: &V3WebuiObservability,
    event_type: V3ObsEventType,
    request_key: &str,
    scope: V3ObsScope,
    meta: V3ObsRequestMeta,
    runtime_observability: &crate::V3RuntimeObservability,
) -> Result<u64, String> {
    observability.record_observed(event_type, request_key, scope, meta, runtime_observability)
}

/// Record the terminal Error06 projection for the WebUI request ledger.
/// This is the single error-to-WebUI projection owner; callers provide only
/// the already-projected client status/body and request scope.
pub(crate) fn record_v3_webui_error_projection(
    observability: &V3WebuiObservability,
    port: u16,
    request_id: &str,
    endpoint: &str,
    entry_protocol: &str,
    project_path: Option<&str>,
    session: Option<&str>,
    status: u16,
    body: Option<&Value>,
) -> Result<u64, String> {
    let (error_category, error_detail) = body
        .map(crate::v3_error_body_code_message)
        .map(|(code, message)| (code, message))
        .unwrap_or_else(|| (format!("http_{status}"), format!("HTTP status {status}")));
    let request_key = build_v3_obs_request_key(port, request_id);
    let scope = V3ObsScope {
        port,
        workdir: project_path.map(str::to_string),
        session: session.map(str::to_string),
    };
    let meta = V3ObsRequestMeta {
        request_id: request_id.to_string(),
        endpoint: endpoint.to_string(),
        entry_protocol: Some(entry_protocol.to_string()),
        provider_status: Some(status),
        response_status: Some("error".to_string()),
        finish_reason: Some("error".to_string()),
        route: Some("-".to_string()),
        error_category: Some(error_category),
        error_detail: Some(error_detail),
        ..Default::default()
    };
    record_v3_observability_event(
        observability,
        V3ObsEventType::Failed,
        &request_key,
        scope,
        meta,
        &crate::V3RuntimeObservability::default(),
    )
}

fn merge_v3_obs_request_meta(
    previous: V3ObsRequestMeta,
    incoming: V3ObsRequestMeta,
) -> V3ObsRequestMeta {
    let route = incoming
        .route
        .filter(|value| !value.trim().is_empty() && value != "-")
        .or(previous.route);
    V3ObsRequestMeta {
        request_id: if incoming.request_id.is_empty() {
            previous.request_id
        } else {
            incoming.request_id
        },
        endpoint: if incoming.endpoint.is_empty() {
            previous.endpoint
        } else {
            incoming.endpoint
        },
        model: incoming.model.or(previous.model),
        route,
        route_reason: incoming.route_reason.or(previous.route_reason),
        routing_group: incoming.routing_group.or(previous.routing_group),
        pool: incoming.pool.or(previous.pool),
        provider_id: incoming.provider_id.or(previous.provider_id),
        auth_alias: incoming.auth_alias.or(previous.auth_alias),
        provider_type: incoming.provider_type.or(previous.provider_type),
        wire_model: incoming.wire_model.or(previous.wire_model),
        provider: incoming.provider.or(previous.provider),
        entry_protocol: incoming.entry_protocol.or(previous.entry_protocol),
        execution_mode: incoming.execution_mode.or(previous.execution_mode),
        transport: incoming.transport.or(previous.transport),
        provider_status: incoming.provider_status.or(previous.provider_status),
        response_status: incoming.response_status.or(previous.response_status),
        finish_reason: incoming.finish_reason.or(previous.finish_reason),
        error_category: incoming.error_category.or(previous.error_category),
        error_detail: incoming.error_detail.or(previous.error_detail),
    }
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
    pub route_reason: Option<String>,
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

/// Shared per-listener projection state. The mutable map is only an
/// in-process cache used to merge lifecycle fields and enforce terminal
/// immutability; every accepted event is also appended to the JSONL store.
#[derive(Debug, Clone)]
pub(crate) struct V3WebuiObservability {
    inner: Arc<std::sync::Mutex<V3WebuiObservabilityInner>>,
    persistence_path: Option<Arc<std::path::PathBuf>>,
}

#[derive(Debug, Clone, Default)]
struct V3WebuiObservabilityInner {
    requests: BTreeMap<String, V3ObsRequestRow>,
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
        let values = routecodex_v3_config::v3_webui_observability_read_rows(path)
            .map_err(|error| format!("read observability store {}: {error}", path.display()))?;
        let mut inner = handle
            .inner
            .lock()
            .map_err(|_| "v3 webui observability state is poisoned".to_string())?;
        for value in values {
            let row: V3ObsRequestRow = serde_json::from_value(value).map_err(|error| {
                format!("decode observability record {}: {error}", path.display())
            })?;
            inner.requests.insert(row.request_key.clone(), row);
        }
        drop(inner);
        Ok(handle)
    }

    pub(crate) fn persistence_path(&self) -> Option<PathBuf> {
        self.persistence_path.as_deref().cloned()
    }

    #[cfg(test)]
    pub(crate) fn rows(&self) -> Result<BTreeMap<String, V3ObsRequestRow>, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "v3 webui observability state is poisoned".to_string())?;
        Ok(inner.requests.clone())
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Record a lifecycle event, upserting the mutable row for requestKey.
    /// Returns Ok(sequence) on success; Err(e) is explicit and never becomes success.
    #[cfg(test)]
    pub(crate) fn record(
        &self,
        event_type: V3ObsEventType,
        request_key: &str,
        scope: V3ObsScope,
        meta: V3ObsRequestMeta,
    ) -> Result<u64, String> {
        record_v3_observability_event(
            self,
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
        let terminal_event_after_terminal_row = is_terminal
            && inner
                .requests
                .get(request_key)
                .is_some_and(|row| row.result.is_some());
        if terminal_event_after_terminal_row {
            return Ok(0);
        }

        let mut row = inner.requests.get(request_key).cloned().unwrap_or_default();
        row.request_key = request_key.to_string();
        row.event_type = event_type_str.clone();
        row.meta = merge_v3_obs_request_meta(row.meta, meta);
        row.scope.port = scope.port;
        if scope.workdir.is_some() {
            row.scope.workdir = scope.workdir.clone();
        }
        if scope.session.is_some() {
            row.scope.session = scope.session.clone();
        }
        row.updated_epoch_ms = now;
        if row.started_epoch_ms == 0 {
            row.started_epoch_ms = now;
        }
        // maintain attempt/switch counters and terminal result
        match event_type {
            V3ObsEventType::ProviderAttemptStarted => row.attempts += 1,
            V3ObsEventType::ProviderAttemptFailed => {
                row.failed_attempts += 1;
            }
            V3ObsEventType::ProviderSwitched => row.switches += 1,
            V3ObsEventType::Completed => {
                row.duration_ms = Some(now.saturating_sub(row.started_epoch_ms));
                row.finished_epoch_ms = Some(now);
                row.result = Some(
                    if observability
                        .usage
                        .as_ref()
                        .is_some_and(v3_runtime_usage_is_zero_issue)
                    {
                        "issue"
                    } else {
                        "success"
                    }
                    .to_string(),
                );
                if let Some(usage) = observability.usage.as_ref() {
                    row.usage = Some(V3ObsUsageSummary {
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                        total_tokens: usage.total_tokens,
                        cached_tokens: usage.cached_tokens,
                    });
                }
                row.timing_internal_ms = observability
                    .timing
                    .as_ref()
                    .map(|t| t.internal.as_millis() as u64);
                row.timing_external_ms = observability
                    .timing
                    .as_ref()
                    .map(|t| t.external.as_millis() as u64);
                row.servertool = false;
                row.stopless = observability.stopless_activation;
                // Preserve the most recent provider-failure category for completed-but-recovered rows
                // so the UI/facets keep the last attempt's error category even when the meta
                // projection is otherwise rebuilt from a fresh payload here.
            }
            V3ObsEventType::Failed => {
                row.duration_ms = Some(now.saturating_sub(row.started_epoch_ms));
                row.finished_epoch_ms = Some(now);
                row.result = Some("error".to_string());
            }
            V3ObsEventType::Cancelled => {
                row.duration_ms = Some(now.saturating_sub(row.started_epoch_ms));
                row.finished_epoch_ms = Some(now);
                row.result = Some("cancelled".to_string());
            }
            V3ObsEventType::Started => {}
            _ => {}
        }
        if let Some(path) = self.persistence_path.as_deref() {
            Self::append_persisted_row(path, &row)?;
        }
        inner.requests.insert(request_key.to_string(), row);
        Ok(1)
    }

    pub(crate) fn append_persisted_row(
        path: &std::path::Path,
        row: &V3ObsRequestRow,
    ) -> Result<(), String> {
        let row = serde_json::to_value(row)
            .map_err(|error| format!("encode observability record failed: {error}"))?;
        routecodex_v3_config::v3_webui_observability_append_row(path, &row)
            .map_err(|error| format!("write observability store failed: {error}"))
    }
}

fn v3_runtime_usage_is_zero_issue(usage: &crate::V3RuntimeUsageSummary) -> bool {
    usage.input_tokens == Some(0)
        && usage.output_tokens == Some(0)
        && usage.total_tokens == Some(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(
        observability: &V3WebuiObservability,
        event_type: V3ObsEventType,
        key: &str,
        scope: V3ObsScope,
        meta: V3ObsRequestMeta,
    ) -> Result<u64, String> {
        record_v3_observability_event(
            observability,
            event_type,
            key,
            scope,
            meta,
            &crate::V3RuntimeObservability::default(),
        )
    }

    fn record_observed(
        observability: &V3WebuiObservability,
        event_type: V3ObsEventType,
        key: &str,
        scope: V3ObsScope,
        meta: V3ObsRequestMeta,
        observed: &crate::V3RuntimeObservability,
    ) -> Result<u64, String> {
        record_v3_observability_event(observability, event_type, key, scope, meta, observed)
    }

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
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("records.jsonl");
        let key = build_v3_obs_request_key(5555, "r-persist");
        let first = V3WebuiObservability::with_persistence_path(Some(path.clone()));
        record(
            &first,
            V3ObsEventType::Started,
            &key,
            scope(5555),
            meta_with_full("r-persist"),
        )
        .unwrap();
        record(
            &first,
            V3ObsEventType::Completed,
            &key,
            scope(5555),
            meta_with_full("r-persist"),
        )
        .unwrap();
        assert!(path.exists(), "terminal record must be persisted");
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(
            body.contains("r-persist"),
            "persisted body must contain request id"
        );

        let second = V3WebuiObservability::load_persisted(&path).unwrap();
        let rows = second.rows().unwrap();
        assert_eq!(rows.len(), 1, "persisted record must reload");
        let row = rows.get(&key).expect("reloaded row");
        assert_eq!(row.result.as_deref(), Some("success"));
        assert!(row.duration_ms.is_some());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn completed_zero_usage_is_marked_as_issue() {
        let observability = V3WebuiObservability::new();
        let key = build_v3_obs_request_key(5555, "r-zero-usage");
        let runtime = crate::V3RuntimeObservability {
            usage: Some(crate::V3RuntimeUsageSummary {
                input_tokens: Some(0),
                output_tokens: Some(0),
                total_tokens: Some(0),
                cached_tokens: None,
            }),
            ..Default::default()
        };
        record_observed(
            &observability,
            V3ObsEventType::Completed,
            &key,
            scope(5555),
            meta_with_full("r-zero-usage"),
            &runtime,
        )
        .unwrap();
        assert_eq!(
            observability.rows().unwrap()[&key].result.as_deref(),
            Some("issue")
        );
    }

    #[test]
    fn provider_attempt_failure_survives_completed_meta_rebuild() {
        let o = V3WebuiObservability::new();
        let key = build_v3_obs_request_key(5555, "r-failure-then-success");
        record(
            &o,
            V3ObsEventType::Started,
            &key,
            scope(5555),
            meta_with_full("r-failure-then-success"),
        )
        .unwrap();

        let mut failure_event = crate::V3RuntimeProviderFailureObservation::default();
        failure_event.error_type = Some("provider_http_502".to_string());
        failure_event.message = "provider returned HTTP 502".to_string();
        let mut obs = crate::V3RuntimeObservability::default();
        obs.provider_failure_events = vec![failure_event];

        let mut failed_meta = meta_with_full("r-failure-then-success");
        failed_meta.error_category = Some("provider_http_502".to_string());
        failed_meta.error_detail = Some("provider returned HTTP 502".to_string());
        record_observed(
            &o,
            V3ObsEventType::ProviderAttemptFailed,
            &key,
            scope(5555),
            failed_meta,
            &obs,
        )
        .unwrap();

        // Completed rebuilds meta from the fresh payload; the category must survive.
        record_observed(
            &o,
            V3ObsEventType::Completed,
            &key,
            scope(5555),
            meta_with_full("r-failure-then-success"),
            &obs,
        )
        .unwrap();
        let rows = o.rows().unwrap();
        let row = rows.get(&key).expect("row");
        assert_eq!(
            row.meta.error_category.as_deref(),
            Some("provider_http_502"),
            "error_category must survive Completed meta rebuild"
        );
        assert!(row.failed_attempts >= 1);
    }

    #[test]
    fn terminal_provider_attempt_failure_is_persisted_in_row() {
        let o = V3WebuiObservability::new();
        let key = build_v3_obs_request_key(5555, "r-failure-terminal");
        record(
            &o,
            V3ObsEventType::Started,
            &key,
            scope(5555),
            meta_with_full("r-failure-terminal"),
        )
        .unwrap();

        let mut failure_event = crate::V3RuntimeProviderFailureObservation::default();
        failure_event.error_type = Some("provider_http_503".to_string());
        failure_event.message = "provider returned HTTP 503".to_string();
        let mut obs = crate::V3RuntimeObservability::default();
        obs.provider_failure_events = vec![failure_event];

        let mut failed_meta = meta_with_full("r-failure-terminal");
        failed_meta.error_category = Some("provider_http_503".to_string());
        failed_meta.error_detail = Some("provider returned HTTP 503".to_string());
        record_observed(
            &o,
            V3ObsEventType::ProviderAttemptFailed,
            &key,
            scope(5555),
            failed_meta.clone(),
            &obs,
        )
        .unwrap();
        record_observed(
            &o,
            V3ObsEventType::Failed,
            &key,
            scope(5555),
            failed_meta,
            &obs,
        )
        .unwrap();

        let rows = o.rows().unwrap();
        let row = rows.get(&key).expect("failed row");
        assert_eq!(row.result.as_deref(), Some("error"));
        assert_eq!(row.failed_attempts, 1);
        assert_eq!(
            row.meta.error_category.as_deref(),
            Some("provider_http_503")
        );
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
        let s = record(&o, V3ObsEventType::Started, &k, scope(5555), meta("r1")).unwrap();
        assert!(s >= 1);
        // route + provider attempt update the same row
        record(
            &o,
            V3ObsEventType::RouteSelected,
            &k,
            scope(5555),
            meta("r1"),
        )
        .unwrap();
        record(
            &o,
            V3ObsEventType::ProviderAttemptStarted,
            &k,
            scope(5555),
            meta("r1"),
        )
        .unwrap();
        let rows = o.rows().unwrap();
        assert_eq!(rows.len(), 1, "one request key => one row");
        let row = rows.get(&k).unwrap();
        assert_eq!(row.attempts, 1);
    }

    #[test]
    fn failed_never_becomes_success() {
        let o = V3WebuiObservability::new();
        let k = build_v3_obs_request_key(5555, "r3");
        record(&o, V3ObsEventType::Started, &k, scope(5555), meta("r3")).unwrap();
        record(&o, V3ObsEventType::Failed, &k, scope(5555), meta("r3")).unwrap();
        let rows = o.rows().unwrap();
        let row = rows.get(&k).unwrap();
        assert_eq!(row.result.as_deref(), Some("error"));
    }

    #[test]
    fn failed_terminal_cannot_become_completed_or_cancelled() {
        let o = V3WebuiObservability::new();
        let key = build_v3_obs_request_key(5555, "r-error-terminal");
        let mut failed_meta = meta_with_full("r-error-terminal");
        failed_meta.error_category = Some("provider_http_429".to_string());
        failed_meta.error_detail = Some("rate limited".to_string());

        record(
            &o,
            V3ObsEventType::Started,
            &key,
            scope(5555),
            failed_meta.clone(),
        )
        .unwrap();
        record(&o, V3ObsEventType::Failed, &key, scope(5555), failed_meta).unwrap();
        record(
            &o,
            V3ObsEventType::Completed,
            &key,
            scope(5555),
            meta_with_full("r-error-terminal"),
        )
        .unwrap();
        record(
            &o,
            V3ObsEventType::Cancelled,
            &key,
            scope(5555),
            meta_with_full("r-error-terminal"),
        )
        .unwrap();

        let rows = o.rows().unwrap();
        let row = rows.get(&key).expect("failed row");
        assert_eq!(row.event_type, "request.failed");
        assert_eq!(row.result.as_deref(), Some("error"));
        assert_eq!(
            row.meta.error_category.as_deref(),
            Some("provider_http_429")
        );
    }
}
