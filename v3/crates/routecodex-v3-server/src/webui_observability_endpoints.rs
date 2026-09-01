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

#[derive(Debug, serde::Deserialize)]
pub(crate) struct RemoveCooldownRequest {
    pub provider_id: String,
    #[serde(default)]
    pub auth_alias: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
    pub kind: String,
}

/// POST /_routecodex/health/cooldown-pool/remove — explicit operator action.
pub(crate) async fn remove_cooldown(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(request): Json<RemoveCooldownRequest>,
) -> Response {
    if let Some(response) =
        loopback_guard(&state, "/_routecodex/health/cooldown-pool/remove", remote)
    {
        return response;
    }
    if request.provider_id.trim().is_empty()
        || !matches!(request.kind.as_str(), "session" | "auth_key" | "probe")
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid cooldown removal request" })),
        )
            .into_response();
    }
    let removed = match state.provider_health.store().remove_cooldown_entry(
        request.provider_id.trim(),
        request.auth_alias.as_deref(),
        request.model_id.as_deref(),
        &request.kind,
    ) {
        Ok(removed) => removed,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": error.to_string() })),
            )
                .into_response()
        }
    };
    Json(serde_json::json!({
        "ok": true,
        "removed": removed,
        "provider_id": request.provider_id,
        "auth_alias": request.auth_alias,
        "model_id": request.model_id,
        "kind": request.kind,
    }))
    .into_response()
}
