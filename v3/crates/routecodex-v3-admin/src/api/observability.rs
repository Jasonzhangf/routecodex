// feature_id: v3.webui_request_observability
// Aggregates per-listener persisted JSONL projections for the single WebUI.
//
// This module keeps the shared record/store core: the typed query projection and
// its row helpers, the record list and record detail handlers, and their unit
// tests. The cooldown passthrough, the whitelisted artifact drill-down and the
// SSE live tail live in the `observability` submodules. Every route they serve
// is still declared in the single route table below, which `api/mod.rs` merges
// behind the router-wide admin token layer.

mod artifacts;
mod cooldown;
mod stream;

use self::artifacts::{
    artifact_content, artifacts, list_v3_obs_artifacts, resolve_v3_obs_sample_dir,
};
use self::cooldown::{add_cooldown, cooldown_pool, probe_cooldown, remove_cooldown};
use self::stream::stream;
use crate::AppState;
use axum::extract::{Path as AxumPath, RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use routecodex_v3_runtime::hub_v1::usage_normalization::{
    split_v3_canonical_usage_cache, V3CanonicalUsageCache,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

/// The six typed Error chain nodes, in canonical order. The detail endpoint
/// always reports all six; nodes the store did not observe are `not_reached`.
const V3_OBS_ERROR_CHAIN_NODES: [&str; 6] = [
    "V3Error01SourceRaised",
    "V3Error02Classified",
    "V3Error03TargetLocalAction",
    "V3Error04TargetExhaustionDecision",
    "V3Error05ExecutionDecision",
    "V3Error06ClientProjected",
];

pub(crate) fn routes() -> axum::Router<crate::AppState> {
    axum::Router::new()
        .route("/api/observability/records", axum::routing::get(records))
        .route(
            "/api/observability/records/:request_key",
            axum::routing::get(record_detail),
        )
        .route(
            "/api/observability/artifacts",
            axum::routing::get(artifacts),
        )
        .route(
            "/api/observability/artifacts/content",
            axum::routing::get(artifact_content),
        )
        .route("/api/observability/stream", axum::routing::get(stream))
        .route(
            "/api/observability/cooldown-pool",
            axum::routing::get(cooldown_pool).post(remove_cooldown),
        )
        .route(
            "/api/observability/cooldown-pool/add",
            axum::routing::post(add_cooldown),
        )
        .route(
            "/api/observability/cooldown-pool/probe",
            axum::routing::post(probe_cooldown),
        )
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
    provider_id: Option<String>,
    model: Option<String>,
    endpoint: Option<String>,
    route: Option<String>,
    entry_protocol: Option<String>,
    execution_mode: Option<String>,
    transport: Option<String>,
    status: Option<String>,
    response_type: Option<String>,
    error_category: Option<String>,
    error_status_code: Option<String>,
    error_origin: Option<String>,
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
    /// Projection of this row's own `error_category`, filled by
    /// `project_query_rows`; `null` for rows that carry no error result.
    #[serde(default)]
    error_origin: Option<String>,
    attempts: u64,
    failed_attempts: u64,
    switches: u64,
    usage: Option<serde_json::Value>,
    timing_internal_ms: Option<u64>,
    timing_external_ms: Option<u64>,
    #[serde(default)]
    servertool: bool,
    raw_artifact_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RecordsResponse {
    records: Vec<QueryRow>,
    total: u64,
    page: u64,
    page_size: u64,
    stats: serde_json::Value,
    facets: BTreeMap<String, serde_json::Value>,
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
                "provider_id" => query.provider_id = Some(value.to_string()),
                "model" => query.model = Some(value.to_string()),
                "endpoint" => query.endpoint = Some(value.to_string()),
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
                "error_origin" => {
                    if !matches!(value, "upstream" | "local" | "unknown") {
                        return Err(format!("invalid error_origin: {value}"));
                    }
                    query.error_origin = Some(value.to_string());
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
            .provider_id
            .as_deref()
            .is_some_and(|value| meta_value("provider_id") != Some(value))
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
            .endpoint
            .as_deref()
            .is_some_and(|value| meta_value("endpoint") != Some(value))
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
        // AND-combines with `error_status_code`. Origin is defined only for rows
        // that carry an error result, so this never selects a row whose own
        // `error_origin` is null (success, active, cancelled).
        if self
            .error_origin
            .as_deref()
            .is_some_and(|origin| row_error_origin_opt(row) != Some(origin))
        {
            return false;
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
        // A provider failure that received no upstream HTTP response has no
        // numeric HTTP status. Render it as a distinct `network` label instead of
        // falling through to the 599 internal-response-lane default.
        "provider_transport_error"
        | "provider_runtime_error"
        | "provider_response_header_timeout"
        | "provider_websocket_protocol_error"
        | "provider_websocket_event_error" => Some("network".to_string()),
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
    // Use the same projection as the `error_status_codes` facet so filtering by
    // that label matches the facet, including the `network` label for a
    // response-less provider failure.
    Some(row_status_code(row))
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
    for row in query_rows.iter_mut() {
        row.error_origin = row_error_origin_opt(row).map(str::to_string);
    }
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
        error_origin: None,
        attempts: row.attempts,
        failed_attempts: row.failed_attempts,
        switches: row.switches,
        usage: row.usage,
        timing_internal_ms: row.timing_internal_ms,
        timing_external_ms: row.timing_external_ms,
        servertool: row.servertool,
        raw_artifact_ref: row.raw_artifact_ref,
    }
}

/// Classifies a failure row from the typed `error_category`, never from the
/// status: `provider_status` is the *projected client* status, so a network
/// failure also shows up as `502` there, while `error_category` is the only field
/// that separates "the provider rejected us" from "we failed to get an answer".
///
/// The rule is deliberately **positive for `upstream` and open for `local`**: the
/// category set is open-ended, so a closed allowlist of local categories would
/// silently misclassify every category added later. `provider_http_<code>` with a
/// non-numeric `<code>` is therefore `local`, not `upstream`.
fn row_error_origin(row: &QueryRow) -> &'static str {
    let Some(category) = row.meta.get("error_category").and_then(Value::as_str) else {
        return "unknown";
    };
    let category = category.trim();
    if category.is_empty() {
        return "unknown";
    }
    match category.strip_prefix("provider_http_") {
        Some(code) if code.parse::<u16>().is_ok() => "upstream",
        _ => "local",
    }
}

/// Origin-bearing rows are exactly the rows that carry an error result. A
/// success, active, or cancelled row has no origin: its serialized
/// `error_origin` is `null` and no `error_origin` filter selects it.
fn row_error_origin_opt(row: &QueryRow) -> Option<&'static str> {
    match row.result.as_deref() {
        Some("error") | Some("failed-attempt") => Some(row_error_origin(row)),
        _ => None,
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

/// Splits one `error_status_codes` bucket by origin; fed from the same places, so
/// the three origin counts sum to `error_status_codes[s]` for every status `s`.
fn facet_add_status_origin(
    status_origins: &mut BTreeMap<String, BTreeMap<String, u64>>,
    label: String,
    origin: &'static str,
) {
    *status_origins
        .entry(label)
        .or_default()
        .entry(origin.to_string())
        .or_default() += 1;
}

fn usage_value(row: &QueryRow, key: &str) -> u64 {
    row.usage
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn usage_value_opt(row: &QueryRow, key: &str) -> Option<u64> {
    row.usage
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
}

fn row_input_value(row: &QueryRow) -> u64 {
    usage_value(row, "input_tokens")
}

fn row_output_value(row: &QueryRow) -> u64 {
    usage_value(row, "output_tokens")
}

fn row_cached_value(row: &QueryRow) -> Option<u64> {
    usage_value_opt(row, "cached_tokens")
}

fn row_cache_read_value(row: &QueryRow) -> Option<u64> {
    usage_value_opt(row, "cache_read_input_tokens")
}

fn row_cache_creation_value(row: &QueryRow) -> Option<u64> {
    usage_value_opt(row, "cache_creation_input_tokens")
}

fn row_total_value(row: &QueryRow) -> u64 {
    usage_value(row, "total_tokens")
}

/// Row usage -> canonical cache split via the shared truth source.
///
/// OpenAI/Responses/Gemini rows carry `cached_tokens` as a sub-count of an
/// input that already includes cache; Anthropic/MiniMax/glm rows carry
/// `cache_read_input_tokens` / `cache_creation_input_tokens` as independent
/// counts that must be added to the uncached input.
fn row_canonical_usage_cache(row: &QueryRow) -> V3CanonicalUsageCache {
    split_v3_canonical_usage_cache(
        Some(row_input_value(row)),
        row_cached_value(row),
        row_cache_read_value(row),
        row_cache_creation_value(row),
    )
}

/// Cache-hit numerator: the canonical cached sub-count, i.e. the cache read
/// count under Anthropic/MiniMax/glm semantics.
fn row_cache_hit_numerator(row: &QueryRow) -> u64 {
    row_canonical_usage_cache(row).cached_tokens.unwrap_or(0)
}

/// Cache-hit denominator: the canonical effective input, i.e. input + read +
/// creation under Anthropic/MiniMax/glm semantics.
fn row_effective_input(row: &QueryRow) -> u64 {
    row_canonical_usage_cache(row).effective_input_tokens
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

/// Read every persisted observability row across the configured listeners.
///
/// A store file that does not exist is "no traffic recorded yet" and is skipped;
/// a store file that exists but cannot be read or decoded is an explicit failure
/// and never becomes an empty result.
fn read_observability_rows(state: &AppState) -> Result<Vec<SourceRow>, (StatusCode, Value)> {
    let ports = configured_ports(state)
        .map_err(|error| (StatusCode::BAD_GATEWAY, json!({ "error": error })))?;
    let mut rows = Vec::new();
    for port in ports {
        let path = observability_store_path(state, port).map_err(|error| {
            (
                StatusCode::BAD_GATEWAY,
                json!({ "error": format!("observability store path {port} unavailable: {error}") }),
            )
        })?;
        let values = match routecodex_v3_debug::v3_webui_observability_read_raw_rows(&path) {
            Ok(values) => values,
            Err(error) => {
                if path.exists() {
                    return Err((
                        StatusCode::BAD_GATEWAY,
                        json!({ "error": format!("observability store {port} unavailable: {error}") }),
                    ));
                }
                continue;
            }
        };
        for value in values {
            let row = serde_json::from_value::<SourceRow>(value).map_err(|error| {
                (
                    StatusCode::BAD_GATEWAY,
                    json!({
                        "error": format!("decode observability store {port} row failed: {error}")
                    }),
                )
            })?;
            rows.push(row);
        }
    }
    Ok(rows)
}

fn query_params(raw_query: &RawQuery) -> HashMap<String, String> {
    raw_query
        .0
        .as_deref()
        .map(parse_query_params)
        .unwrap_or_default()
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
    let rows = match read_observability_rows(&state) {
        Ok(rows) => rows,
        Err((status, body)) => return (status, Json(body)).into_response(),
    };
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
    let mut page_rows: Vec<QueryRow> = if offset < filtered.len() {
        filtered[offset..end].to_vec()
    } else {
        Vec::new()
    };
    // Same read-time resolution as the detail endpoint: the listener records
    // `raw_artifact_ref` before the asynchronous sample writer has created the
    // directory, so a listed row re-checks the filesystem instead of reporting
    // a permanent null for a request that really did capture artifacts.
    for row in page_rows.iter_mut() {
        if row.raw_artifact_ref.is_none() {
            row.raw_artifact_ref = resolve_v3_obs_row_artifact_ref(row);
        }
    }
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
        "cache_read_input_tokens":0u64,
        "cache_creation_input_tokens":0u64,
        "total_tokens":0u64,
        "cache_hit_rate_percent":0f64,
        "avg_duration_ms":0f64,
        "provider_failure_count":0u64,
        "by_provider": {}
    });
    let mut facets: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    // `error_status_origins` splits each `error_status_codes` bucket by origin and
    // `error_origins` is its rollup over error rows; both are seeded so a fixture
    // with no failure row still reports explicit zero counts.
    let mut status_origins: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    facets.insert(
        "error_origins".to_string(),
        ["upstream", "local", "unknown"]
            .into_iter()
            .map(|origin| (origin.to_string(), 0u64))
            .collect(),
    );
    let count = filtered.len() as f64;
    let mut input = 0;
    let mut output = 0;
    let mut cached = 0;
    let mut stats_cache_read = 0;
    let mut stats_cache_creation = 0;
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
            let row_cached = row_cached_value(row).unwrap_or(0);
            // Canonical hit count: OpenAI `cached_tokens` sub-count, otherwise
            // Anthropic `cache_read_input_tokens`.
            let row_cache_read = row_cache_hit_numerator(row);
            let row_cache_creation = row_cache_creation_value(row).unwrap_or(0);
            input += row_input;
            output += row_output;
            cached += row_cached;
            stats_cache_read += row_cache_read;
            stats_cache_creation += row_cache_creation;
            total_token_count += row_total_value(row);
            let row_effective = row_effective_input(row);
            // Anthropic/MiniMax/glm-5.3 split: cache_read is the only hit
            // contribution; cache_creation is creation (write) and must not
            // inflate the hit count. We still clamp to the effective input
            // to keep legacy OpenAI rows <= 100% on accumulation.
            hit_against_effective += row_cache_hit_numerator(row).min(row_effective);
            effective_input_total += row_effective;
            if let Some(duration) = row.duration_ms {
                durations += duration;
                with_duration += 1;
            }
        }
        if row.result.as_deref() == Some("failed-attempt") {
            facet_add_status_code_label(&mut facets, "error_status_codes", row_status_code(row));
            facet_add_status_origin(
                &mut status_origins,
                row_status_code(row),
                row_error_origin(row),
            );
            facet_add(&mut facets, "error_origins", Some(row_error_origin(row)));
        }
        if matches!(
            row.result.as_deref(),
            Some("error") | Some("failed-attempt")
        ) {
            let category = row
                .meta
                .get("error_category")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            facet_add(&mut facets, "error_categories", Some(category));
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
            "endpoints",
            row.meta.get("endpoint").and_then(Value::as_str),
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
        // Entry protocol facet: the UI protocol filter must be populated from the
        // same field the `entry_protocol` query parameter filters on.
        facet_add(
            &mut facets,
            "entry_protocols",
            row.meta.get("entry_protocol").and_then(Value::as_str),
        );
        if row.result.as_deref() == Some("error") {
            facet_add_status_code_label(&mut facets, "error_status_codes", row_status_code(row));
            facet_add_status_origin(
                &mut status_origins,
                row_status_code(row),
                row_error_origin(row),
            );
            facet_add(&mut facets, "error_origins", Some(row_error_origin(row)));
        } else if row.result.as_deref() == Some("cancelled") {
            facet_add_status_code_label(&mut facets, "error_status_codes", "499".to_string());
            // Mirrors the pre-existing 499 bucket so `error_status_origins` stays a
            // strict refinement of `error_status_codes`. A cancellation carries no
            // category, so it lands in `unknown` — but it is NOT counted in
            // `error_origins`, which must not report a cancellation as an error.
            facet_add_status_origin(
                &mut status_origins,
                "499".to_string(),
                row_error_origin(row),
            );
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
    let mut by_provider: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for row in &filtered {
        let is_success = usage_is_countable(row.result.as_deref());
        let provider_key = row
            .meta
            .get("provider_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                row.meta
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "unknown".to_string());
        let item = by_provider.entry(provider_key).or_insert_with(|| {
            json!({
                "total": 0u64,
                "active": 0u64,
                "success": 0u64,
                "error": 0u64,
                "provider_failures": 0u64,
                "cancelled": 0u64,
                "input_tokens": 0u64,
                "output_tokens": 0u64,
                "total_tokens": 0u64
            })
        });
        item["total"] = json!(item["total"].as_u64().unwrap_or(0) + 1);
        if is_success {
            item["input_tokens"] =
                json!(item["input_tokens"].as_u64().unwrap_or(0) + row_input_value(row));
            item["output_tokens"] =
                json!(item["output_tokens"].as_u64().unwrap_or(0) + row_output_value(row));
            item["total_tokens"] =
                json!(item["total_tokens"].as_u64().unwrap_or(0) + row_total_value(row));
        }
        match row.result.as_deref() {
            Some("success") => {
                item["success"] = json!(item["success"].as_u64().unwrap_or(0) + 1);
            }
            Some("error") => {
                item["error"] = json!(item["error"].as_u64().unwrap_or(0) + 1);
                if !attempt_keys.contains(&row.request_key) && row.failed_attempts > 0 {
                    item["provider_failures"] =
                        json!(item["provider_failures"].as_u64().unwrap_or(0) + 1);
                }
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
    stats["by_provider"] = json!(by_provider);
    stats["input_tokens"] = json!(input);
    stats["output_tokens"] = json!(output);
    stats["cached_tokens"] = json!(cached);
    stats["cache_read_input_tokens"] = json!(stats_cache_read);
    stats["cache_creation_input_tokens"] = json!(stats_cache_creation);
    stats["total_tokens"] = json!(total_token_count);
    if effective_input_total > 0 {
        stats["cache_hit_rate_percent"] =
            json!((hit_against_effective as f64 / effective_input_total as f64) * 100f64);
    }
    if with_duration > 0 {
        stats["avg_duration_ms"] = json!(durations as f64 / with_duration as f64);
    }
    let mut facets: BTreeMap<String, serde_json::Value> = facets
        .into_iter()
        .map(|(name, counts)| (name, json!(counts)))
        .collect();
    facets.insert("error_status_origins".to_string(), json!(status_origins));
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

/// Per-request detail: the current row, every provider attempt row, the typed
/// Error01..Error06 chain, the typed health action, and the debug artifact list.
async fn record_detail(
    State(state): State<AppState>,
    AxumPath(request_key): AxumPath<String>,
) -> Response {
    let rows = match read_observability_rows(&state) {
        Ok(rows) => rows,
        Err((status, body)) => return (status, Json(body)).into_response(),
    };
    let mut matching: Vec<SourceRow> = rows
        .into_iter()
        .filter(|row| row.request_key == request_key)
        .collect();
    if matching.is_empty() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "request_not_found" })),
        )
            .into_response();
    }
    matching.sort_by_key(|row| row.updated_epoch_ms);
    let port = matching[0].scope.port;
    let request_id = matching
        .iter()
        .rev()
        .find_map(|row| row.meta.get("request_id").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let attempts: Vec<QueryRow> = matching
        .iter()
        .filter(|row| is_provider_attempt_failure(row))
        .cloned()
        .map(to_attempt_query_row)
        .collect();
    let mut row = matching
        .iter()
        .rev()
        .find(|row| !is_provider_attempt_failure(row))
        .cloned()
        .map(to_query_row)
        .unwrap_or_else(|| {
            to_attempt_query_row(
                matching
                    .last()
                    .cloned()
                    .expect("matching rows are non-empty"),
            )
        });
    let observed_error = row
        .meta
        .get("observed_error")
        .filter(|value| !value.is_null())
        .cloned();
    let error_chain = build_v3_obs_error_chain(observed_error.as_ref());
    let health_action = observed_error
        .as_ref()
        .and_then(|value| value.get("health_action"))
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or(Value::Null);
    let observed_error_source = observed_error
        .as_ref()
        .and_then(|value| value.get("source"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let sample_dir = if request_id.is_empty() {
        None
    } else {
        match resolve_v3_obs_sample_dir(port, &request_id) {
            Ok(dir) => dir,
            Err(error) => {
                return (StatusCode::BAD_GATEWAY, Json(json!({ "error": error }))).into_response()
            }
        }
    };
    let artifacts = match sample_dir.as_deref() {
        Some(dir) => list_v3_obs_artifacts(dir),
        None => Vec::new(),
    };
    // The listener writes `raw_artifact_ref` when it records the row, but the
    // debug sample writer persists asynchronously, so that write can lose the
    // race with the files on disk. The filesystem is the truth here: resolve at
    // read time, and keep `None` when no directory exists rather than
    // fabricating a path.
    if row.raw_artifact_ref.is_none() {
        row.raw_artifact_ref = sample_dir.as_ref().map(|dir| dir.display().to_string());
    }
    Json(json!({
        "row": row,
        "attempts": attempts,
        "error_chain": error_chain,
        "health_action": health_action,
        "artifacts": artifacts,
        "observed_error_source": observed_error_source,
    }))
    .into_response()
}

/// Project the stored typed chain onto the fixed six-node contract. All six
/// nodes are always reported in canonical order; a node the store did not
/// observe is `not_reached` with a null code. Nothing is invented for a node
/// that was not observed, and no node is omitted.
fn build_v3_obs_error_chain(observed_error: Option<&Value>) -> Vec<Value> {
    let stored = observed_error
        .and_then(|value| value.get("chain"))
        .and_then(Value::as_array);
    V3_OBS_ERROR_CHAIN_NODES
        .iter()
        .enumerate()
        .map(|(index, node)| {
            let entry = stored.and_then(|chain| {
                chain
                    .iter()
                    .find(|entry| entry.get("node").and_then(Value::as_str) == Some(*node))
            });
            let state = match entry {
                Some(_) if index == 0 => "raised",
                Some(_) => "observed",
                None => "not_reached",
            };
            let code = entry
                .and_then(|entry| entry.get("code"))
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(Value::Null);
            json!({ "node": node, "state": state, "code": code })
        })
        .collect()
}

/// Read-time artifact reference for one listed row.
///
/// `raw_artifact_ref` is recorded by the listener, but the debug sample writer
/// persists asynchronously, so that value can be `None` for a request whose
/// artifacts exist a moment later. Re-resolving against the filesystem keeps the
/// list consistent with the detail endpoint. A missing directory stays `None`;
/// no path is invented. A resolution failure (no `HOME`, unreadable root) is
/// reported as "no artifact reference", never as an error, because the list is
/// a catalog view and one unavailable samples root must not fail it.
fn resolve_v3_obs_row_artifact_ref(row: &QueryRow) -> Option<String> {
    let request_id = row.meta.get("request_id").and_then(Value::as_str)?;
    if request_id.trim().is_empty() {
        return None;
    }
    resolve_v3_obs_sample_dir(row.scope.port, request_id)
        .ok()
        .flatten()
        .map(|dir| dir.display().to_string())
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
#[path = "observability_tests.rs"]
mod tests;
