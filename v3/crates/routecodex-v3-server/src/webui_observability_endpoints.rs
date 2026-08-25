// feature_id: v3.webui_request_observability
// Loopback-only projection of the server-owned typed observability carrier.

use crate::V3ListenerState;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::StatusCode;
use axum::response::{sse::Event, IntoResponse, Json, Response};
use futures_util::stream;
use serde::Deserialize;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Deserialize)]
pub(crate) struct EventsQuery {
    pub cursor: Option<u64>,
    #[serde(rename = "once")]
    once: Option<bool>,
}

fn loopback_guard(
    _state: &V3ListenerState,
    path: &'static str,
    remote: SocketAddr,
) -> Option<Response> {
    if remote.ip().is_loopback() {
        return None;
    }
    Some(
        (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": format!("observability endpoint {path} is loopback-only"),
            })),
        )
            .into_response(),
    )
}

pub(crate) async fn observability_snapshot(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Some(response) = loopback_guard(&state, "/_routecodex/observability/snapshot", remote) {
        return response;
    }
    match state.webui_observability.snapshot(0) {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
    }
}

fn observability_event_envelope(
    handle: &crate::webui_observability::V3WebuiObservability,
    cursor: u64,
) -> Result<serde_json::Value, String> {
    if !handle
        .snapshot(cursor)
        .is_ok_and(|snapshot| snapshot.cursor >= cursor)
    {
        return Err("observability cursor unavailable".to_string());
    }
    let result = handle.since(cursor)?;
    let stats = handle.snapshot(0)?.stats;
    Ok(serde_json::json!({
        "kind": "events",
        "cursor": result.next_cursor,
        "events": result.events,
        "resync_required": result.resync_required,
        "stats": stats,
    }))
}

pub(crate) async fn observability_events(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<EventsQuery>,
) -> Response {
    if let Some(response) = loopback_guard(&state, "/_routecodex/observability/events", remote) {
        return response;
    }
    let cursor = query.cursor.unwrap_or(0);
    let handle = state.webui_observability.clone();
    if query.once.unwrap_or(false) {
        return match observability_event_envelope(&handle, cursor) {
            Ok(payload) => Json(payload).into_response(),
            Err(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"kind": "error", "error": error})),
            )
                .into_response(),
        };
    }
    let body = stream::once(async move {
        let payload = observability_event_envelope(&handle, cursor)
            .unwrap_or_else(|error| serde_json::json!({"kind": "error", "error": error}));
        Ok::<_, Infallible>(Event::default().data(payload.to_string()))
    });
    axum::response::Sse::new(body)
        .keep_alive(axum::response::sse::KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

/// feature_id: v3.server_internal_observability_projection
/// GET /_routecodex/health/cooldown-pool — returns current cooldown entries for this listener.
pub(crate) async fn cooldown_pool(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Some(response) = loopback_guard(&state, "/_routecodex/health/cooldown-pool", remote) {
        return response;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let store = state.provider_health.store();
    let entries = store.cooldown_entries(now_ms);
    Json(serde_json::json!({
        "port": state.server.port,
        "server_id": state.server.id,
        "now_ms": now_ms,
        "entries": entries,
    }))
        .into_response()
}
