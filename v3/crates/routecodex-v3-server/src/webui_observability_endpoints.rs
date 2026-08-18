// feature_id: v3.webui_request_observability
// Typed request-observability HTTP endpoints for the single RouteCodex WebUI.
// These project the typed V3WebuiObservability snapshot/event/stats to the page.
// P0: typed side-channel only; explicit errors for cursor/schema/sequence; no silent fallback.

use crate::webui_observability::{V3ObsSnapshot, V3ObsStats};
use crate::V3ListenerState;
use axum::extract::{Query, State};
use axum::response::{sse::{Event, KeepAlive, Sse}, IntoResponse, Json, Response};
use axum::http::StatusCode;
use futures_util::stream;
use serde::Deserialize;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Deserialize)]
pub(crate) struct SnapshotQuery {
    pub after: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct EventsQuery {
    pub cursor: Option<u64>,
}

pub(crate) async fn observability_snapshot(
    State(state): State<Arc<V3ListenerState>>,
    Query(query): Query<SnapshotQuery>,
) -> Response {
    let after = query.after.unwrap_or(0);
    match state.webui_observability.snapshot(after) {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
    }
}

pub(crate) async fn observability_stats(
    State(state): State<Arc<V3ListenerState>>,
) -> Response {
    match state.webui_observability.snapshot(0) {
        Ok(snapshot) => Json(snapshot.stats).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
    }
}

/// SSE stream: sends the current snapshot once (cursor/sequence), then
/// incremental events since the provided (or newest) cursor on an interval poll.
/// Stale events (sequence <= cursor) are rejected by since(...).
pub(crate) async fn observability_events(
    State(state): State<Arc<V3ListenerState>>,
    Query(query): Query<EventsQuery>,
) -> Sse<impl stream::Stream<Item = Result<Event, Infallible>>> {
    let start_cursor = query.cursor.unwrap_or(0);
    let handle = state.webui_observability.clone();
    let stream = stream::unfold(
        (start_cursor, false),
        move |(mut cursor, mut sent_snapshot)| {
            let handle = handle.clone();
            async move {
                let payload = if !sent_snapshot {
                    sent_snapshot = true;
                    match handle.snapshot(0) {
                        Ok(snap) => {
                            cursor = snap.cursor.max(cursor);
                            serde_json::json!({ "kind": "snapshot", "snapshot": &snap }).to_string()
                        }
                        Err(error) => {
                            serde_json::json!({ "kind": "error", "error": error }).to_string()
                        }
                    }
                } else {
                    match handle.since(cursor) {
                        Ok((new_cursor, events)) => {
                            cursor = new_cursor.max(cursor);
                            let stats: V3ObsStats = match handle.snapshot(0) {
                                Ok(snap) => snap.stats,
                                Err(_) => V3ObsStats::default(),
                            };
                            serde_json::json!({
                                "kind": "events",
                                "cursor": new_cursor,
                                "events": &events,
                                "stats": &stats,
                            })
                            .to_string()
                        }
                        Err(error) => {
                            serde_json::json!({ "kind": "error", "error": error }).to_string()
                        }
                    }
                };
                // poll every 500ms to pick up new events; SSE keep-alive is also set
                tokio::time::sleep(Duration::from_millis(500)).await;
                Some((Ok::<_, Infallible>(Event::default().data(payload)), (cursor, sent_snapshot)))
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}
