// feature_id: v3.webui_request_observability
// Aggregates loopback-only typed listener projections for the single WebUI.

use crate::AppState;
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;

const SOURCE_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) fn routes() -> axum::Router<crate::AppState> {
    axum::Router::new().route("/api/observability/poll", axum::routing::get(poll))
}

#[derive(Debug, Deserialize)]
pub(crate) struct PollQuery {
    pub sources: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
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
    for (port, stats) in &source.by_port {
        let target_port = target.by_port.entry(*port).or_default();
        target_port.total += stats.total;
        target_port.active += stats.active;
        target_port.success += stats.success;
        target_port.error += stats.error;
        target_port.cancelled += stats.cancelled;
        target_port.switches += stats.switches;
        target_port.tokens_output += stats.tokens_output;
    }
    for (category, count) in &source.error_categories {
        *target.error_categories.entry(category.clone()).or_default() += count;
    }
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
        let (snapshot_result, events_result) = tokio::join!(
            fetch_snapshot(&client, port),
            fetch_events(&client, port, cursor)
        );
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
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({
                            "error": format!("observability source {port} requires resync")
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
