// feature_id: v3.webui_request_observability
// Aggregates loopback-only typed listener projections for the single WebUI.

use crate::AppState;
use axum::extract::Query;
use axum::extract::RawQuery;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SOURCE_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) fn routes() -> axum::Router<crate::AppState> {
    axum::Router::new()
        .route("/api/observability/poll", axum::routing::get(poll))
        .route("/api/observability/records", axum::routing::get(records))
}

#[derive(Debug, Deserialize)]
pub(crate) struct PollQuery {
    pub sources: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub(crate) struct SourceScope {
    pub port: u16,
    #[serde(default)]
    pub workdir: Option<String>,
    #[serde(default)]
    pub session: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct SourceRow {
    pub request_key: String,
    pub event_type: String,
    pub started_epoch_ms: u64,
    pub updated_epoch_ms: u64,
    #[serde(default)]
    pub finished_epoch_ms: Option<u64>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    pub meta: serde_json::Value,
    pub scope: SourceScope,
    #[serde(default)]
    pub result: Option<String>,
    pub attempts: u64,
    #[serde(default)]
    pub failed_attempts: u64,
    pub switches: u64,
    #[serde(default)]
    pub usage: Option<serde_json::Value>,
    #[serde(default)]
    pub timing_internal_ms: Option<u64>,
    #[serde(default)]
    pub timing_external_ms: Option<u64>,
    #[serde(default)]
    pub servertool: bool,
    #[serde(default)]
    pub stopless: bool,
    #[serde(default)]
    pub tokens_output: Option<u64>,
    #[serde(default)]
    pub raw_artifact_ref: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct PortStats {
    #[serde(default)]
    pub total: u64,
    #[serde(default)]
    pub active: u64,
    #[serde(default)]
    pub success: u64,
    #[serde(default)]
    pub error: u64,
    #[serde(default)]
    pub cancelled: u64,
    #[serde(default)]
    pub switches: u64,
    #[serde(default)]
    pub tokens_output: u64,
    #[serde(default)]
    pub provider_failures: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct SourceStats {
    #[serde(default)]
    pub total: u64,
    #[serde(default)]
    pub active: u64,
    #[serde(default)]
    pub success: u64,
    #[serde(default)]
    pub error: u64,
    #[serde(default)]
    pub cancelled: u64,
    #[serde(default)]
    pub switches: u64,
    #[serde(default)]
    pub tokens_output: u64,
    /// Aggregate provider-attempt failures (including those that ultimately recovered via switch).
    #[serde(default)]
    pub provider_failures: u64,
    #[serde(default)]
    pub provider_failure_categories: BTreeMap<String, u64>,
    #[serde(default)]
    pub by_port: BTreeMap<u16, PortStats>,
    #[serde(default)]
    pub error_categories: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct SourceSnapshot {
    cursor: u64,
    requests: BTreeMap<String, SourceRow>,
    stats: SourceStats,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct SourceEvent {
    sequence: u64,
    timestamp_epoch_ms: u64,
    row: SourceRow,
}

#[derive(Debug, Clone, Deserialize)]
struct SourceEventEnvelope {
    kind: String,
    #[serde(default)]
    cursor: Option<u64>,
    #[serde(default)]
    resync_required: bool,
    #[serde(default)]
    events: Vec<SourceEvent>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AggregatePoll {
    pub requests: BTreeMap<String, SourceRow>,
    pub stats: SourceStats,
    pub sources: Vec<SourceCursor>,
    pub recent_events: Vec<SourceEvent>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RecordQuery {
    page: u64,
    page_size: u64,
    sort_by: String,
    sort_desc: bool,
    time_from_ms: Option<u64>,
    time_to_ms: Option<u64>,
    port: Option<u16>,
    provider: Option<String>,
    model: Option<String>,
    route: Option<String>,
    entry_protocol: Option<String>,
    execution_mode: Option<String>,
    transport: Option<String>,
    status: Option<String>,
    response_type: Option<String>,
    error_category: Option<String>,
    session: Option<String>,
    search: Option<String>,
    range: String,
    timezone_offset_minutes: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct QueryRow {
    request_key: String,
    event_type: String,
    started_epoch_ms: u64,
    updated_epoch_ms: u64,
    finished_epoch_ms: Option<u64>,
    duration_ms: Option<u64>,
    meta: serde_json::Value,
    scope: SourceScope,
    result: Option<String>,
    attempts: u64,
    failed_attempts: u64,
    switches: u64,
    usage: Option<serde_json::Value>,
    timing_internal_ms: Option<u64>,
    timing_external_ms: Option<u64>,
    #[serde(default)]
    servertool: bool,
    #[serde(default)]
    stopless: bool,
    raw_artifact_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RecordsResponse {
    records: Vec<QueryRow>,
    total: u64,
    page: u64,
    page_size: u64,
    stats: serde_json::Value,
    facets: BTreeMap<String, BTreeMap<String, u64>>,
    timeseries: Vec<TimeseriesBucket>,
}

use super::timeseries::{local_day_start, system_epoch_ms, TimeseriesBucket};

impl RecordQuery {
    fn from_params(
        params: &std::collections::HashMap<String, String>,
        timezone_offset_minutes: i32,
    ) -> Result<Self, String> {
        let mut query = Self {
            page: 1,
            page_size: 50,
            sort_by: "started_epoch_ms".to_string(),
            sort_desc: true,
            timezone_offset_minutes,
            ..Self::default()
        };
        for (key, value) in params {
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            match key.as_str() {
                "page" => {
                    query.page = value
                        .parse()
                        .map_err(|_| format!("invalid page: {value}"))?
                }
                "page_size" => {
                    query.page_size = value
                        .parse()
                        .map_err(|_| format!("invalid page_size: {value}"))?
                }
                "range" => {
                    if !matches!(value, "today" | "week" | "all") {
                        return Err(format!("invalid range: {value}"));
                    }
                    query.range = value.to_string();
                }
                "sort_by" => {
                    if !matches!(
                        value,
                        "started_epoch_ms"
                            | "updated_epoch_ms"
                            | "finished_epoch_ms"
                            | "duration_ms"
                            | "attempts"
                            | "failed_attempts"
                            | "switches"
                            | "usage_input_tokens"
                            | "usage_output_tokens"
                            | "usage_total_tokens"
                            | "usage_cached_tokens"
                            | "result"
                            | "scope.port"
                            | "meta.entry_protocol"
                            | "meta.endpoint"
                            | "meta.route_reason"
                            | "meta.provider"
                            | "meta.finish_reason"
                            | "timing_internal_ms"
                    ) {
                        return Err(format!("invalid sort field: {value}"));
                    }
                    query.sort_by = value.to_string();
                }
                "sort_order" => {
                    query.sort_desc = match value {
                        "asc" => false,
                        "desc" => true,
                        _ => return Err(format!("invalid sort order: {value}")),
                    }
                }
                "time_from_ms" => {
                    query.time_from_ms = Some(
                        value
                            .parse()
                            .map_err(|_| format!("invalid time_from_ms: {value}"))?,
                    )
                }
                "time_to_ms" => {
                    query.time_to_ms = Some(
                        value
                            .parse()
                            .map_err(|_| format!("invalid time_to_ms: {value}"))?,
                    )
                }
                "port" => {
                    query.port = Some(
                        value
                            .parse()
                            .map_err(|_| format!("invalid port: {value}"))?,
                    )
                }
                "provider" => query.provider = Some(value.to_string()),
                "model" => query.model = Some(value.to_string()),
                "route" => query.route = Some(value.to_string()),
                "entry_protocol" => query.entry_protocol = Some(value.to_string()),
                "execution_mode" => query.execution_mode = Some(value.to_string()),
                "transport" => query.transport = Some(value.to_string()),
                "status" => query.status = Some(value.to_string()),
                "response_type" => query.response_type = Some(value.to_string()),
                "error_category" => query.error_category = Some(value.to_string()),
                "session" => query.session = Some(value.to_string()),
                "search" => query.search = Some(value.to_string()),
                "timezone_offset_minutes" => {
                    query.timezone_offset_minutes = value
                        .parse()
                        .map_err(|_| format!("invalid timezone_offset_minutes: {value}"))?
                }
                _ => {}
            }
        }
        if query.page == 0 || query.page_size == 0 || query.page_size > 300 {
            return Err("page and page_size must be between 1..300".to_string());
        }
        if matches!(query.range.as_str(), "today" | "week") {
            let now_ms = system_epoch_ms()?;
            let today_start = local_day_start(now_ms, query.timezone_offset_minutes);
            query.time_from_ms = Some(match query.range.as_str() {
                "today" => today_start,
                _ => today_start.saturating_sub(6 * 24 * 60 * 60 * 1000),
            });
        }
        Ok(query)
    }

    fn matches(&self, row: &QueryRow) -> bool {
        if self
            .time_from_ms
            .is_some_and(|from| row.started_epoch_ms < from)
        {
            return false;
        }
        if self.time_to_ms.is_some_and(|to| row.started_epoch_ms > to) {
            return false;
        }
        if self.port.is_some_and(|port| row.scope.port != port) {
            return false;
        }
        let meta_value = |name: &str| row.meta.get(name).and_then(serde_json::Value::as_str);
        if self
            .provider
            .as_deref()
            .is_some_and(|value| meta_value("provider") != Some(value))
        {
            return false;
        }
        if self
            .model
            .as_deref()
            .is_some_and(|value| meta_value("model") != Some(value))
        {
            return false;
        }
        if self
            .route
            .as_deref()
            .is_some_and(|value| meta_value("route") != Some(value))
        {
            return false;
        }
        if self
            .entry_protocol
            .as_deref()
            .is_some_and(|value| meta_value("entry_protocol") != Some(value))
        {
            return false;
        }
        if self
            .execution_mode
            .as_deref()
            .is_some_and(|value| meta_value("execution_mode") != Some(value))
        {
            return false;
        }
        if self
            .transport
            .as_deref()
            .is_some_and(|value| meta_value("transport") != Some(value))
        {
            return false;
        }
        if self
            .response_type
            .as_deref()
            .is_some_and(|value| meta_value("response_status") != Some(value))
        {
            return false;
        }
        if self
            .error_category
            .as_deref()
            .is_some_and(|value| meta_value("error_category") != Some(value))
        {
            return false;
        }
        if self
            .session
            .as_deref()
            .is_some_and(|value| row.scope.session.as_deref() != Some(value))
        {
            return false;
        }
        if let Some(status) = &self.status {
            if status == "active" {
                if row.result.is_some() {
                    return false;
                }
            } else if row.result.as_deref() != Some(status) {
                return false;
            }
        }
        if let Some(search) = self
            .search
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let search = search.to_lowercase();
            let haystacks = [
                Some(row.request_key.clone()),
                row.meta
                    .get("request_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                row.meta
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                row.meta
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                row.meta
                    .get("error_detail")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                row.scope.workdir.clone(),
                row.scope.session.clone(),
            ];
            if !haystacks
                .iter()
                .flatten()
                .any(|value| value.to_lowercase().contains(&search))
            {
                return false;
            }
        }
        true
    }

    fn sort_key(&self, row: &QueryRow) -> (String, u64) {
        let usage_number = |field: &str| -> u64 {
            row.usage
                .as_ref()
                .and_then(|usage| usage.get(field))
                .and_then(Value::as_u64)
                .unwrap_or(0)
        };
        let meta_text = |name: &str| -> String {
            row.meta
                .get(name)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let numeric = |value: u64| -> String { format!("{value:020}") };
        let primary = match self.sort_by.as_str() {
            "result" => row.result.clone().unwrap_or_default(),
            "scope.port" => numeric(row.scope.port as u64),
            "meta.entry_protocol" => meta_text("entry_protocol"),
            "meta.endpoint" => meta_text("endpoint"),
            "meta.route_reason" => meta_text("route_reason"),
            "meta.provider" => meta_text("provider"),
            "meta.finish_reason" => meta_text("finish_reason"),
            "updated_epoch_ms" => numeric(row.updated_epoch_ms),
            "finished_epoch_ms" => numeric(row.finished_epoch_ms.unwrap_or(u64::MAX)),
            "duration_ms" => numeric(row.duration_ms.unwrap_or(u64::MAX)),
            "timing_internal_ms" => numeric(row.timing_internal_ms.unwrap_or(0)),
            "attempts" => numeric(row.attempts),
            "failed_attempts" => numeric(row.failed_attempts),
            "switches" => numeric(row.switches),
            "usage_input_tokens" => numeric(usage_number("input_tokens")),
            "usage_output_tokens" => numeric(usage_number("output_tokens")),
            "usage_total_tokens" => numeric(usage_number("total_tokens")),
            "usage_cached_tokens" => numeric(usage_number("cached_tokens")),
            _ => numeric(row.started_epoch_ms),
        };
        (primary, row.updated_epoch_ms)
    }
}

fn facet_add(
    facets: &mut BTreeMap<String, BTreeMap<String, u64>>,
    name: &str,
    value: Option<&str>,
) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        *facets
            .entry(name.to_string())
            .or_default()
            .entry(value.to_string())
            .or_default() += 1;
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SourceCursor {
    port: u16,
    cursor: u64,
}

fn configured_ports(state: &AppState) -> Result<Vec<u16>, String> {
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
    if ports.is_empty() {
        return Err("observability has no enabled listener source".to_string());
    }
    Ok(ports)
}

fn requested_ports(state: &AppState, query: &PollQuery) -> Result<BTreeMap<u16, u64>, String> {
    let configured = configured_ports(state)?;
    let mut cursors = configured.iter().copied().map(|port| (port, 0)).collect();
    let Some(raw) = query.sources.as_deref().filter(|value| !value.is_empty()) else {
        return Ok(cursors);
    };
    for item in raw.split(',') {
        let (port, cursor) = item
            .split_once(':')
            .ok_or_else(|| format!("invalid source cursor {item:?}"))?;
        let port = port
            .parse::<u16>()
            .map_err(|_| format!("invalid source cursor port {port:?}"))?;
        let cursor = cursor
            .parse::<u64>()
            .map_err(|_| format!("invalid source cursor sequence {cursor:?}"))?;
        if !configured.contains(&port) {
            return Err(format!("source cursor port {port} is not configured"));
        }
        cursors.insert(port, cursor);
    }
    Ok(cursors)
}

async fn fetch_snapshot(client: &reqwest::Client, port: u16) -> Result<SourceSnapshot, String> {
    let response = tokio::time::timeout(
        SOURCE_TIMEOUT,
        client
            .get(format!(
                "http://127.0.0.1:{port}/_routecodex/observability/snapshot"
            ))
            .send(),
    )
    .await
    .map_err(|_| "source request timed out".to_string())?
    .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("source returned HTTP {}", response.status()));
    }
    response
        .json()
        .await
        .map_err(|error| format!("invalid snapshot schema: {error}"))
}

async fn fetch_events(
    client: &reqwest::Client,
    port: u16,
    cursor: u64,
) -> Result<SourceEventEnvelope, String> {
    let response = tokio::time::timeout(
        SOURCE_TIMEOUT,
        client
            .get(format!(
                "http://127.0.0.1:{port}/_routecodex/observability/events?cursor={cursor}&once=true"
            ))
            .send(),
    )
    .await
    .map_err(|_| "source event request timed out".to_string())?
    .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "source event endpoint returned HTTP {}",
            response.status()
        ));
    }
    response
        .json()
        .await
        .map_err(|error| format!("invalid source event schema: {error}"))
}

fn merge_stats(target: &mut SourceStats, source: &SourceStats) {
    target.total += source.total;
    target.active += source.active;
    target.success += source.success;
    target.error += source.error;
    target.cancelled += source.cancelled;
    target.switches += source.switches;
    target.tokens_output += source.tokens_output;
    target.provider_failures += source.provider_failures;
    for (port, stats) in &source.by_port {
        let target_port = target.by_port.entry(*port).or_default();
        target_port.total += stats.total;
        target_port.active += stats.active;
        target_port.success += stats.success;
        target_port.error += stats.error;
        target_port.cancelled += stats.cancelled;
        target_port.switches += stats.switches;
        target_port.tokens_output += stats.tokens_output;
        target_port.provider_failures += stats.provider_failures;
    }
    for (category, count) in &source.error_categories {
        *target.error_categories.entry(category.clone()).or_default() += count;
    }
    for (category, count) in &source.provider_failure_categories {
        *target
            .provider_failure_categories
            .entry(category.clone())
            .or_default() += count;
    }
}

async fn records(
    axum::extract::State(state): axum::extract::State<AppState>,
    raw_query: RawQuery,
) -> Response {
    let params: std::collections::HashMap<String, String> = raw_query
        .0
        .map(|query| parse_query_params(&query))
        .unwrap_or_default();
    let timezone_offset_minutes = params
        .get("timezone_offset_minutes")
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(0);
    let query = match RecordQuery::from_params(&params, timezone_offset_minutes) {
        Ok(query) => query,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
        }
    };
    let ports = match configured_ports(&state) {
        Ok(ports) => ports,
        Err(error) => {
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": error }))).into_response()
        }
    };
    let client = reqwest::Client::new();
    let mut rows = Vec::new();
    for port in ports {
        match fetch_snapshot(&client, port).await {
            Ok(snapshot) => {
                for (_key, row) in snapshot.requests {
                    rows.push(row);
                }
            }
            Err(error) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({
                        "error": format!("observability source {port} unavailable: {error}")
                    })),
                )
                    .into_response();
            }
        }
    }
    let rows: Vec<QueryRow> = match rows
        .into_iter()
        .map(|row| {
            let value = serde_json::to_value(row)
                .map_err(|error| format!("encode observability source row failed: {error}"))?;
            serde_json::from_value(value)
                .map_err(|error| format!("decode observability source row failed: {error}"))
        })
        .collect()
    {
        Ok(rows) => rows,
        Err(error) => {
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": error }))).into_response()
        }
    };
    let mut filtered: Vec<QueryRow> = rows.into_iter().filter(|row| query.matches(row)).collect();
    let timeseries_rows: Vec<super::timeseries::TimeseriesRow<'_>> = filtered
        .iter()
        .map(|row| super::timeseries::TimeseriesRow {
            started_epoch_ms: row.started_epoch_ms,
            usage: row.usage.as_ref(),
        })
        .collect();
    let timeseries = match super::timeseries::build_timeseries(
        &timeseries_rows,
        &query.range,
        query.timezone_offset_minutes,
    ) {
        Ok(timeseries) => timeseries,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error })),
            )
                .into_response()
        }
    };
    filtered.sort_by_cached_key(|row| {
        let key = query.sort_key(row);
        std::cmp::Reverse(key)
    });
    let total = filtered.len() as u64;
    let offset = ((query.page - 1) * query.page_size) as usize;
    let end = (offset + query.page_size as usize).min(filtered.len());
    let page_rows: &[QueryRow] = if offset < filtered.len() {
        &filtered[offset..end]
    } else {
        &[]
    };
    let mut stats = json!({
        "count":0u64,
        "success_count":0u64,
        "error_count":0u64,
        "cancelled_count":0u64,
        "active_count":0u64,
        "switch_count":0u64,
        "input_tokens":0u64,
        "output_tokens":0u64,
        "cached_tokens":0u64,
        "total_tokens":0u64,
        "cache_hit_rate_percent":0f64,
        "avg_duration_ms":0f64,
        "provider_failure_count":0u64
    });
    let mut facets = BTreeMap::new();
    let count = filtered.len() as f64;
    let mut input = 0;
    let mut output = 0;
    let mut cached = 0;
    let mut cached_against_input = 0;
    let mut durations = 0u64;
    let mut with_duration = 0u64;
    let mut total_token_count = 0;
    for row in &filtered {
        input += row
            .usage
            .as_ref()
            .and_then(|u| u.get("input_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        output += row
            .usage
            .as_ref()
            .and_then(|u| u.get("output_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        cached += row
            .usage
            .as_ref()
            .and_then(|u| u.get("cached_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        total_token_count += row
            .usage
            .as_ref()
            .and_then(|u| u.get("total_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let row_input = row
            .usage
            .as_ref()
            .and_then(|u| u.get("input_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let row_cached = row
            .usage
            .as_ref()
            .and_then(|u| u.get("cached_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        cached_against_input += row_cached.min(row_input);
        match row.result.as_deref() {
            Some("success") => { stats["success_count"] = json!(stats["success_count"].as_u64().unwrap_or(0) + 1); }
            Some("error") => { stats["error_count"] = json!(stats["error_count"].as_u64().unwrap_or(0) + 1); }
            Some("cancelled") => { stats["cancelled_count"] = json!(stats["cancelled_count"].as_u64().unwrap_or(0) + 1); }
            _ => { stats["active_count"] = json!(stats["active_count"].as_u64().unwrap_or(0) + 1); }
        }
        stats["switch_count"] = json!(stats["switch_count"].as_u64().unwrap_or(0) + row.switches);
        let failed_attempts = row.failed_attempts;
        if failed_attempts > 0 {
            stats["provider_failure_count"] = json!(
                stats["provider_failure_count"].as_u64().unwrap_or(0) + failed_attempts
            );
        }
        if let Some(duration) = row.duration_ms {
            durations += duration;
            with_duration += 1;
        }
        facet_add(&mut facets, "ports", Some(&row.scope.port.to_string()));
        facet_add(
            &mut facets,
            "providers",
            row.meta.get("provider").and_then(Value::as_str),
        );
        facet_add(
            &mut facets,
            "models",
            row.meta.get("model").and_then(Value::as_str),
        );
        facet_add(
            &mut facets,
            "routes",
            row.meta.get("route").and_then(Value::as_str),
        );
        facet_add(&mut facets, "sessions", row.scope.session.as_deref());
        facet_add(
            &mut facets,
            "response_types",
            row.meta.get("response_status").and_then(Value::as_str),
        );
        facet_add(
            &mut facets,
            "error_categories",
            row.meta.get("error_category").and_then(Value::as_str),
        );
        if row.failed_attempts > 0 {
            facet_add(
                &mut facets,
                "provider_failure_categories",
                row.meta.get("error_category").and_then(Value::as_str),
            );
        }
    }
    stats["count"] = json!(count as u64);
    stats["input_tokens"] = json!(input);
    stats["output_tokens"] = json!(output);
    stats["cached_tokens"] = json!(cached);
    stats["total_tokens"] = json!(total_token_count);
    if input > 0 {
        // Clamp per-row cached to its input so cross-row accumulation never exceeds 100%.
        stats["cache_hit_rate_percent"] =
            json!((cached_against_input as f64 / input as f64) * 100f64);
    }
    if with_duration > 0 {
        stats["avg_duration_ms"] = json!(durations as f64 / with_duration as f64);
    }
    Json(RecordsResponse {
        records: page_rows.to_vec(),
        total,
        page: query.page,
        page_size: query.page_size,
        stats,
        facets,
        timeseries,
    })
    .into_response()
}

fn parse_query_params(raw: &str) -> std::collections::HashMap<String, String> {
    raw.split('&')
        .filter(|part| !part.is_empty())
        .map(|part| match part.split_once('=') {
            Some((key, value)) => (urldecode_component(key), urldecode_component(value)),
            None => (urldecode_component(part), String::new()),
        })
        .collect()
}

fn urldecode_component(value: &str) -> String {
    let mut bytes = Vec::new();
    let source = value.as_bytes();
    let mut index = 0;
    while index < source.len() {
        match source[index] {
            b'+' => bytes.push(b' '),
            b'%' if index + 2 < source.len() => {
                if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                    bytes.push(byte);
                    index += 2;
                } else {
                    bytes.push(source[index]);
                }
            }
            byte => bytes.push(byte),
        }
        index += 1;
    }
    String::from_utf8(bytes).unwrap_or_else(|_| value.to_string())
}

pub(crate) async fn poll(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<PollQuery>,
) -> Response {
    let cursors = match requested_ports(&state, &query) {
        Ok(cursors) => cursors,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": error})),
            )
                .into_response();
        }
    };
    let client = reqwest::Client::new();
    let mut aggregate = AggregatePoll {
        requests: BTreeMap::new(),
        stats: SourceStats::default(),
        sources: Vec::new(),
        recent_events: Vec::new(),
    };
    for (port, cursor) in cursors {
        let snapshot_result = fetch_snapshot(&client, port).await;
        let snapshot = match snapshot_result {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({
                        "error": format!("observability source {port} unavailable: {error}")
                    })),
                )
                    .into_response();
            }
        };
        let event_cursor = if cursor == 0 { snapshot.cursor } else { cursor };
        let events_result = fetch_events(&client, port, event_cursor).await;
        merge_stats(&mut aggregate.stats, &snapshot.stats);
        aggregate.requests.extend(snapshot.requests);
        aggregate.sources.push(SourceCursor {
            port,
            cursor: snapshot.cursor,
        });
        match events_result {
            Ok(envelope) if envelope.kind == "events" => {
                if envelope.resync_required {
                    return (
                        StatusCode::CONFLICT,
                        Json(serde_json::json!({
                            "error": "resync_required",
                            "detail": format!(
                                "observability source {port} evicted events below cursor {event_cursor}; caller must re-poll from cursor 0"
                            ),
                            "port": port,
                            "resync_required": true
                        })),
                    )
                        .into_response();
                }
                if let Some(cursor) = envelope.cursor {
                    if let Some(source) = aggregate.sources.last_mut() {
                        source.cursor = source.cursor.max(cursor);
                    }
                }
                aggregate.recent_events.extend(envelope.events);
            }
            Ok(envelope) => {
                let reason = envelope
                    .error
                    .unwrap_or_else(|| "unexpected event kind".to_string());
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({
                        "error": format!("observability source {port} schema invalid: {reason}")
                    })),
                )
                    .into_response();
            }
            Err(error) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({
                        "error": format!("observability source {port} events unavailable: {error}")
                    })),
                )
                    .into_response();
            }
        }
    }
    aggregate.recent_events.sort_by_key(|event| event.sequence);
    aggregate.recent_events.reverse();
    aggregate.recent_events.truncate(256);
    Json(aggregate).into_response()
}
