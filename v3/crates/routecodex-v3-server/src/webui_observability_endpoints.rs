// feature_id: v3.webui_request_observability
// Loopback-only listener control endpoints that remain after observability
// moved to per-listener JSONL files. Admin reads files directly.

use crate::V3ListenerState;
use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use std::net::SocketAddr;
use std::sync::Arc;

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
