// feature_id: v3.webui_request_observability
// SSE live tail over the same persisted JSONL store the polling endpoint reads.
//
// `seq` is the row's `updated_epoch_ms`; with no cursor the stream starts at the
// current high-water mark carried by the initial heartbeat. An idle store still
// emits one heartbeat per poll so a client can tell "no new rows" from "stream
// died". A mid-stream store read failure is reported on a heartbeat payload and
// never as a raw `event: error`, which EventSource would treat as a connection
// failure.

use super::store_cache::read_v3_obs_projection;
use super::{query_params, QueryRow};
use crate::AppState;
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use futures_util::{stream, StreamExt};
use serde_json::json;
use std::collections::VecDeque;
use std::convert::Infallible;
use std::time::Duration;

/// Poll cadence of the SSE live tail over the same JSONL store.
const V3_OBS_STREAM_POLL_MS: u64 = 1000;

struct V3ObsStreamState {
    state: AppState,
    /// Highest `seq` already delivered. `seq` is the row's `updated_epoch_ms`.
    cursor: Option<u64>,
    pending: VecDeque<QueryRow>,
}

/// Rows strictly after `cursor`, oldest first, from the same folded projection
/// `/api/observability/records` serves so the live stream and the polling path
/// agree.
fn select_v3_obs_stream_rows(rows: &[QueryRow], cursor: Option<u64>) -> Vec<QueryRow> {
    let mut query_rows: Vec<QueryRow> = match cursor {
        Some(cursor) => rows
            .iter()
            .filter(|row| row.updated_epoch_ms > cursor)
            .cloned()
            .collect(),
        None => rows.to_vec(),
    };
    query_rows.sort_by_key(|row| row.updated_epoch_ms);
    query_rows
}

/// `GET /api/observability/stream?cursor=<seq>` — SSE live tail over the same
/// JSONL store. Polling stays available; this is the live path.
///
/// `seq` is the row's `updated_epoch_ms`. With no `cursor` the stream tails from
/// the current high-water mark (the initial heartbeat carries it) so a first
/// connect does not replay the whole store. An idle store still produces one
/// `event: heartbeat` per poll, so a live client can tell "no new rows" from
/// "stream died".
pub(super) async fn stream(State(state): State<AppState>, raw_query: RawQuery) -> Response {
    let params = query_params(&raw_query);
    let cursor = match params
        .get("cursor")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => match value.parse::<u64>() {
            Ok(cursor) => cursor,
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "cursor must be a non-negative integer" })),
                )
                    .into_response()
            }
        },
        None => {
            let probe_state = state.clone();
            match tokio::task::spawn_blocking(move || {
                read_v3_obs_projection(&probe_state).map(|projection| projection.max_seq)
            })
            .await
            {
                Ok(Ok(seq)) => seq,
                Ok(Err((_, body))) => return (StatusCode::BAD_GATEWAY, Json(body)).into_response(),
                Err(error) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({
                            "error": format!("observability stream read task failed: {error}")
                        })),
                    )
                        .into_response()
                }
            }
        }
    };
    let initial_seq = cursor;
    let stream_state = V3ObsStreamState {
        state,
        cursor: Some(cursor),
        pending: VecDeque::new(),
    };
    let events = stream::once(async move {
        Ok::<Event, Infallible>(
            Event::default()
                .event("heartbeat")
                .data(json!({ "seq": initial_seq }).to_string()),
        )
    })
    .chain(stream::unfold(
        stream_state,
        |mut stream_state| async move {
            loop {
                if let Some(row) = stream_state.pending.pop_front() {
                    let seq = row.updated_epoch_ms;
                    stream_state.cursor = Some(seq);
                    let event = Event::default()
                        .id(seq.to_string())
                        .event("row")
                        .data(json!({ "seq": seq, "row": row }).to_string());
                    return Some((Ok::<Event, Infallible>(event), stream_state));
                }
                tokio::time::sleep(Duration::from_millis(V3_OBS_STREAM_POLL_MS)).await;
                let poll_state = stream_state.state.clone();
                let poll_cursor = stream_state.cursor;
                let fetched = tokio::task::spawn_blocking(move || {
                    read_v3_obs_projection(&poll_state).map(|projection| {
                        // The store cannot hold a row the cursor has not already
                        // passed when its high-water mark has not moved, so an
                        // unchanged store never re-scans the projection.
                        if projection.max_seq <= poll_cursor.unwrap_or(0) {
                            Vec::new()
                        } else {
                            select_v3_obs_stream_rows(&projection.rows, poll_cursor)
                        }
                    })
                })
                .await;
                match fetched {
                    Ok(Ok(rows)) => {
                        if rows.is_empty() {
                            // Idle heartbeat. The SSE comment keep-alive is not
                            // surfaced as an event by EventSource, so the client
                            // would otherwise see silence between rows and could
                            // mistake an idle store for a dead stream.
                            let seq = stream_state.cursor.unwrap_or(0);
                            return Some((
                                Ok(Event::default()
                                    .event("heartbeat")
                                    .data(json!({ "seq": seq }).to_string())),
                                stream_state,
                            ));
                        }
                        stream_state.pending.extend(rows);
                    }
                    // A store read failure is surfaced on the heartbeat payload
                    // instead of a raw `event: error`, which EventSource would
                    // treat as a connection failure. The next tick retries.
                    Ok(Err((_, body))) => {
                        let seq = stream_state.cursor.unwrap_or(0);
                        return Some((
                            Ok(Event::default()
                                .event("heartbeat")
                                .data(json!({ "seq": seq, "error": body }).to_string())),
                            stream_state,
                        ));
                    }
                    Err(error) => {
                        let seq = stream_state.cursor.unwrap_or(0);
                        return Some((
                            Ok(Event::default().event("heartbeat").data(
                                json!({
                                    "seq": seq,
                                    "error": format!("observability stream read task failed: {error}")
                                })
                                .to_string(),
                            )),
                            stream_state,
                        ));
                    }
                }
            }
        },
    ));
    Sse::new(events)
        .keep_alive(KeepAlive::default())
        .into_response()
}
