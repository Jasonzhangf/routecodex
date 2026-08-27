// feature_id: v3.webui_request_observability
// Aggregates per-listener persisted JSONL projections for the single WebUI.

use crate::AppState;
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

pub(crate) fn routes() -> axum::Router<crate::AppState> {
    axum::Router::new()
        .route("/api/observability/records", axum::routing::get(records))
        .route(
            "/api/observability/cooldown-pool",
            axum::routing::get(cooldown_pool).post(remove_cooldown),
        )
}

async fn cooldown_pool(State(state): axum::extract::State<AppState>) -> Response {
    let ports = match configured_ports(&state) {
        Ok(ports) => ports,
        Err(error) => {
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": error }))).into_response()
        }
    };
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("cooldown client build failed: {error}") })),
            )
                .into_response()
        }
    };
    let mut listeners = Vec::new();
    for port in ports {
        let url = format!("http://127.0.0.1:{port}/_routecodex/health/cooldown-pool");
        let response = match client.get(&url).send().await {
            Ok(response) => response,
            Err(error) => return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("cooldown listener {port} unavailable: {error}") })),
            )
                .into_response(),
        };
        let status = response.status();
        let body = match response.json::<Value>().await {
            Ok(body) => body,
            Err(error) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": format!("cooldown listener {port} invalid response: {error}") })),
                )
                    .into_response()
            }
        };
        if !status.is_success() {
            return (StatusCode::BAD_GATEWAY, Json(body)).into_response();
        }
        listeners.push(body);
    }
    Json(json!({ "listeners": listeners })).into_response()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct RemoveCooldownRequest {
    port: u16,
    provider_id: String,
    #[serde(default)]
    auth_alias: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
    kind: String,
}

async fn remove_cooldown(
    State(state): axum::extract::State<AppState>,
    Json(request): Json<RemoveCooldownRequest>,
) -> Response {
    if request.provider_id.trim().is_empty()
        || !matches!(request.kind.as_str(), "session" | "auth_key" | "probe")
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid cooldown removal request" })),
        )
            .into_response();
    }
    let ports = match configured_ports(&state) {
        Ok(ports) => ports,
        Err(error) => {
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": error }))).into_response()
        }
    };
    if !ports.contains(&request.port) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("port {} is not configured", request.port) })),
        )
            .into_response();
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("cooldown client build failed: {error}") })),
            )
                .into_response()
        }
    };
    let url = format!(
        "http://127.0.0.1:{}/_routecodex/health/cooldown-pool",
        request.port
    );
    let response = match client.post(url).json(&request).send().await {
        Ok(response) => response,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("cooldown listener {} unavailable: {error}", request.port) })),
            )
                .into_response()
        }
    };
    let status = response.status();
    let body = match response.json::<Value>().await {
        Ok(body) => body,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("cooldown listener response invalid: {error}") })),
            )
                .into_response()
        }
    };
    if !status.is_success() {
        return (StatusCode::BAD_GATEWAY, Json(body)).into_response();
    }
    Json(body).into_response()
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
    error_status_code: Option<String>,
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

use super::timeseries::{local_day_start, system_epoch_ms, usage_is_countable, TimeseriesBucket};

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
                    if !matches!(value, "today" | "week" | "month" | "all") {
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
                "error_status_code" => {
                    if value != "unknown" && value.parse::<u16>().is_err() {
                        return Err(format!("invalid error_status_code: {value}"));
                    }
                    query.error_status_code = Some(value.to_string());
                }
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
        if matches!(query.range.as_str(), "today" | "week" | "month") {
            let now_ms = system_epoch_ms()?;
            let today_start = local_day_start(now_ms, query.timezone_offset_minutes);
            query.time_from_ms = Some(match query.range.as_str() {
                "today" => today_start,
                "week" => today_start.saturating_sub(6 * 24 * 60 * 60 * 1000),
                "month" => today_start.saturating_sub(29 * 24 * 60 * 60 * 1000),
                _ => unreachable!("range is restricted to today, week, or month"),
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
            if status == "retrying" {
                if row.result.as_deref() != Some("failed-attempt") {
                    return false;
                }
            } else if status == "active" {
                if row.result.is_some() {
                    return false;
                }
            } else if status == "error" {
                if !matches!(
                    row.result.as_deref(),
                    Some("error") | Some("failed-attempt")
                ) {
                    return false;
                }
            } else if row.result.as_deref() != Some(status) {
                return false;
            }
        }
        if let Some(status_code) = self.error_status_code.as_deref() {
            let attempt_matches = row.result.as_deref() == Some("failed-attempt")
                && attempt_status_code(row) == Some(status_code.to_string());
            let terminal_matches =
                row.result.as_deref() == Some("error") && row_status_code(row) == status_code;
            if !attempt_matches && !terminal_matches {
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

fn status_code_label(value: Option<&Value>) -> String {
    value
        .and_then(|value| {
            value
                .as_u64()
                .and_then(|number| u16::try_from(number).ok())
                .map(|number| number.to_string())
                .or_else(|| {
                    value
                        .as_str()?
                        .parse::<u16>()
                        .ok()
                        .map(|number| number.to_string())
                })
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn error_category_status_code(category: Option<&str>) -> Option<String> {
    let category = category?.trim();
    if let Some(code) = category.strip_prefix("provider_http_") {
        if code.parse::<u16>().is_ok() {
            return Some(code.to_string());
        }
    }
    match category {
        "malformed_json" | "content_type_required" | "content_type_unsupported" => {
            Some("400".to_string())
        }
        "internal_request_lane" | "v3_debug_failure" | "debug_sink" => Some("598".to_string()),
        "internal_response_lane"
        | "provider_response_sse_event_invalid"
        | "provider_response_body_error"
        | "provider_stream_handoff_runtime_failed" => Some("599".to_string()),
        _ => None,
    }
}

fn is_provider_attempt_failure(row: &SourceRow) -> bool {
    row.event_type == "request.provider_attempt_failed"
}

fn attempt_status_code(row: &QueryRow) -> Option<String> {
    if row.result.as_deref() != Some("failed-attempt")
        || row.event_type != "request.provider_attempt_failed"
    {
        return None;
    }
    Some(status_code_label(row.meta.get("provider_status")))
}

/// Projects the raw lifecycle stream into the WebUI query surface.
///
/// The latest row per request remains the terminal request row. Every
/// `provider_attempt_failed` row is additionally kept as a separate
/// `failed-attempt` query row with its original status/category/detail, so a
/// retry that eventually succeeds does not hide the non-normal attempt.
fn project_query_rows(rows: Vec<SourceRow>) -> Vec<QueryRow> {
    let mut latest: BTreeMap<String, SourceRow> = BTreeMap::new();
    let mut attempt_rows: Vec<SourceRow> = Vec::new();
    for row in rows {
        if is_provider_attempt_failure(&row) {
            attempt_rows.push(row);
        } else {
            latest.insert(row.request_key.clone(), row);
        }
    }

    let mut query_rows = Vec::with_capacity(latest.len() + attempt_rows.len());
    for row in latest.into_values() {
        query_rows.push(to_query_row(row));
    }
    query_rows.extend(
        attempt_rows
            .into_iter()
            .map(|row| to_attempt_query_row(row))
            .collect::<Vec<_>>(),
    );
    query_rows
}

fn to_query_row(row: SourceRow) -> QueryRow {
    let value = serde_json::to_value(row).expect("source row serializes");
    serde_json::from_value(value).expect("query row shape is compatible")
}

fn to_attempt_query_row(row: SourceRow) -> QueryRow {
    QueryRow {
        request_key: row.request_key,
        event_type: row.event_type,
        started_epoch_ms: row.started_epoch_ms,
        updated_epoch_ms: row.updated_epoch_ms,
        finished_epoch_ms: row.finished_epoch_ms,
        duration_ms: row.duration_ms,
        meta: row.meta,
        scope: row.scope,
        result: Some("failed-attempt".to_string()),
        attempts: row.attempts,
        failed_attempts: row.failed_attempts,
        switches: row.switches,
        usage: row.usage,
        timing_internal_ms: row.timing_internal_ms,
        timing_external_ms: row.timing_external_ms,
        servertool: row.servertool,
        stopless: row.stopless,
        raw_artifact_ref: row.raw_artifact_ref,
    }
}

fn row_status_code(row: &QueryRow) -> String {
    let provider_status = status_code_label(row.meta.get("provider_status"));
    if provider_status != "unknown" {
        return provider_status;
    }
    error_category_status_code(row.meta.get("error_category").and_then(Value::as_str))
        .unwrap_or_else(|| "599".to_string())
}

fn facet_add_status_code_label(
    facets: &mut BTreeMap<String, BTreeMap<String, u64>>,
    name: &str,
    label: String,
) {
    *facets
        .entry(name.to_string())
        .or_default()
        .entry(label)
        .or_default() += 1;
}

fn usage_value(row: &QueryRow, key: &str) -> u64 {
    row.usage
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn row_input_value(row: &QueryRow) -> u64 {
    usage_value(row, "input_tokens")
}

fn row_output_value(row: &QueryRow) -> u64 {
    usage_value(row, "output_tokens")
}

fn row_cached_value(row: &QueryRow) -> u64 {
    usage_value(row, "cached_tokens")
}

fn row_total_value(row: &QueryRow) -> u64 {
    usage_value(row, "total_tokens")
}

// Effective input tokens for cache-hit calculation.
//
// OpenAI/Responses and Anthropic both report `cached_tokens` as a sub-count of
// `input_tokens` (cached prompt tokens or cache_read_input_tokens). The raw
// provider `input_tokens` already includes the cache-read increment, so the
// cache hit is cached / raw_input. When the upstream reports a smaller raw
// input than cache (legacy non-normalized shape), fall back to cached so the
// hit rate never exceeds 100%.
fn row_effective_input(row: &QueryRow) -> u64 {
    row_input_value(row).max(row_cached_value(row))
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

/// Per-listener JSONL store path. Server and Admin derive the same path from
/// the shared config helper using the authoring debug log file truth.
fn observability_store_path(state: &AppState, port: u16) -> Result<PathBuf, String> {
    let authoring = state
        .store
        .read_authoring()
        .map_err(|error| format!("observability config read failed: {error}"))?;
    let debug_log = authoring.debug.log_file.as_deref();
    Ok(routecodex_v3_config::v3_webui_observability_store_path(
        &state.config_path,
        debug_log,
        port,
    ))
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
    let mut rows = Vec::new();
    for port in ports {
        let path = match observability_store_path(&state, port) {
            Ok(path) => path,
            Err(error) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({
                        "error": format!("observability store path {port} unavailable: {error}")
                    })),
                )
                    .into_response();
            }
        };
        let values = match routecodex_v3_config::v3_webui_observability_read_raw_rows(&path) {
            Ok(values) => values,
            Err(error) => {
                if path.exists() {
                    return (
                        StatusCode::BAD_GATEWAY,
                        Json(json!({
                            "error": format!("observability store {port} unavailable: {error}")
                        })),
                    )
                        .into_response();
                }
                continue;
            }
        };
        for value in values {
            match serde_json::from_value::<SourceRow>(value) {
                Ok(row) => rows.push(row),
                Err(error) => {
                    return (
                        StatusCode::BAD_GATEWAY,
                        Json(json!({
                            "error": format!("decode observability store {port} row failed: {error}")
                        })),
                    )
                        .into_response();
                }
            }
        }
    }
    let rows = project_query_rows(rows);
    let mut filtered: Vec<QueryRow> = rows.into_iter().filter(|row| query.matches(row)).collect();
    let timeseries_rows: Vec<super::timeseries::TimeseriesRow<'_>> = filtered
        .iter()
        .map(|row| super::timeseries::TimeseriesRow {
            started_epoch_ms: row.started_epoch_ms,
            usage: row.usage.as_ref(),
            result: row.result.as_deref(),
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
    let mut durations = 0u64;
    let mut with_duration = 0u64;
    let mut total_token_count = 0;
    let mut hit_against_effective = 0u64;
    let mut effective_input_total = 0u64;
    let mut attempt_keys = HashSet::new();
    for row in &filtered {
        if row.result.as_deref() == Some("failed-attempt") {
            attempt_keys.insert(row.request_key.clone());
        }
    }
    for row in &filtered {
        // Only successful terminal responses contribute usage, cache, and duration.
        // Failed, cancelled, and still-running rows remain visible in counts/facets.
        let is_success = usage_is_countable(row.result.as_deref());
        if is_success {
            let row_input = row_input_value(row);
            let row_output = row_output_value(row);
            let row_cached = row_cached_value(row);
            input += row_input;
            output += row_output;
            cached += row_cached;
            total_token_count += row_total_value(row);
            let row_effective = row_effective_input(row);
            hit_against_effective += row_cached.min(row_effective);
            effective_input_total += row_effective;
            if let Some(duration) = row.duration_ms {
                durations += duration;
                with_duration += 1;
            }
        }
        if row.result.as_deref() == Some("failed-attempt") {
            facet_add_status_code_label(&mut facets, "error_status_codes", row_status_code(row));
        }
        match row.result.as_deref() {
            Some("success") => {
                stats["success_count"] = json!(stats["success_count"].as_u64().unwrap_or(0) + 1);
            }
            Some("error") => {
                stats["error_count"] = json!(stats["error_count"].as_u64().unwrap_or(0) + 1);
                if !attempt_keys.contains(&row.request_key) && row.failed_attempts > 0 {
                    stats["provider_failure_count"] =
                        json!(stats["provider_failure_count"].as_u64().unwrap_or(0) + 1);
                }
            }
            Some("cancelled") => {
                stats["cancelled_count"] =
                    json!(stats["cancelled_count"].as_u64().unwrap_or(0) + 1);
            }
            Some("failed-attempt") => {
                stats["error_count"] = json!(stats["error_count"].as_u64().unwrap_or(0) + 1);
                stats["provider_failure_count"] =
                    json!(stats["provider_failure_count"].as_u64().unwrap_or(0) + 1);
            }
            _ => {
                stats["active_count"] = json!(stats["active_count"].as_u64().unwrap_or(0) + 1);
            }
        }
        stats["switch_count"] = json!(stats["switch_count"].as_u64().unwrap_or(0) + row.switches);
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
        if row.result.as_deref() == Some("error") {
            facet_add_status_code_label(&mut facets, "error_status_codes", row_status_code(row));
        } else if row.result.as_deref() == Some("cancelled") {
            facet_add_status_code_label(&mut facets, "error_status_codes", "499".to_string());
        }
    }
    stats["count"] = json!(count as u64);
    let mut by_port: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for row in &filtered {
        let port = row.scope.port.to_string();
        let item = by_port.entry(port).or_insert_with(|| {
            json!({
                "total": 0u64,
                "active": 0u64,
                "success": 0u64,
                "error": 0u64,
                "provider_failures": 0u64,
                "cancelled": 0u64
            })
        });
        item["total"] = json!(item["total"].as_u64().unwrap_or(0) + 1);
        match row.result.as_deref() {
            Some("success") => {
                item["success"] = json!(item["success"].as_u64().unwrap_or(0) + 1);
            }
            Some("error") => {
                item["error"] = json!(item["error"].as_u64().unwrap_or(0) + 1);
            }
            Some("cancelled") => {
                item["cancelled"] = json!(item["cancelled"].as_u64().unwrap_or(0) + 1);
            }
            Some("failed-attempt") => {
                item["error"] = json!(item["error"].as_u64().unwrap_or(0) + 1);
                item["provider_failures"] =
                    json!(item["provider_failures"].as_u64().unwrap_or(0) + 1);
            }
            _ => {
                item["active"] = json!(item["active"].as_u64().unwrap_or(0) + 1);
            }
        }
    }
    stats["by_port"] = json!(by_port);
    stats["input_tokens"] = json!(input);
    stats["output_tokens"] = json!(output);
    stats["cached_tokens"] = json!(cached);
    stats["total_tokens"] = json!(total_token_count);
    if effective_input_total > 0 {
        // Per-row cached is clamped to row_effective_input (= max(input, cached))
        // so cross-row accumulation stays <=100% across the filtered set.
        stats["cache_hit_rate_percent"] =
            json!((hit_against_effective as f64 / effective_input_total as f64) * 100f64);
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

#[cfg(test)]
mod tests {
    use super::error_category_status_code;

    #[test]
    fn error_categories_always_have_numbered_status_projection() {
        assert_eq!(
            error_category_status_code(Some("malformed_json")),
            Some("400".to_string())
        );
        assert_eq!(
            error_category_status_code(Some("provider_response_sse_event_invalid")),
            Some("599".to_string())
        );
        assert_eq!(
            error_category_status_code(Some("v3_debug_failure")),
            Some("598".to_string())
        );
        assert_eq!(error_category_status_code(Some("unclassified")), None);
    }
}
