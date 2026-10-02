// feature_id: v3.webui_request_observability
// Loopback-only listener control endpoints that remain after observability
// moved to per-listener JSONL files. Admin reads files directly.

use crate::V3ListenerState;
use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use std::net::SocketAddr;
use std::sync::Arc;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

/// feature_id: v3.server_internal_observability_projection
/// GET /_routecodex/health/cooldown-pool — returns current cooldown entries for this listener.
pub(crate) async fn cooldown_pool(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Some(response) = loopback_guard(&state, "/_routecodex/health/cooldown-pool", remote) {
        return response;
    }
    let now_ms = now_ms();
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

/// POST /_routecodex/health/cooldown-pool — explicit operator action.
pub(crate) async fn remove_cooldown(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(request): Json<RemoveCooldownRequest>,
) -> Response {
    if let Some(response) = loopback_guard(&state, "/_routecodex/health/cooldown-pool", remote) {
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

#[derive(Debug, serde::Deserialize)]
pub(crate) struct AddCooldownRequest {
    pub provider_id: String,
    #[serde(default)]
    pub auth_alias: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
    pub kind: String,
    pub duration_ms: u64,
}

/// POST /_routecodex/health/cooldown-pool/add — manual operator cooldown.
///
/// The store owns both the accepted `kind` set (`auth_key` | `probe`) and the
/// `1..=V3_COOLDOWN_MANUAL_MAX_MS` duration bound, so this handler does not
/// restate either. An `InvalidManualCooldown` from the store is the operator's
/// mistake and becomes `400`; every other store error stays `500`.
///
/// `auth_key` cools the whole provider+auth scope, so the applied model scope is
/// `None` and is reported as such rather than echoing the requested model.
pub(crate) async fn add_cooldown(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(request): Json<AddCooldownRequest>,
) -> Response {
    if let Some(response) = loopback_guard(&state, "/_routecodex/health/cooldown-pool/add", remote)
    {
        return response;
    }
    let provider_id = request.provider_id.trim().to_string();
    let until_ms = match state.provider_health.store().add_cooldown_entry(
        &provider_id,
        request.auth_alias.as_deref(),
        request.model_id.as_deref(),
        &request.kind,
        request.duration_ms,
        now_ms(),
    ) {
        Ok(until_ms) => until_ms,
        Err(error) if error.is_invalid_manual_cooldown() => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": error.to_string() })),
            )
                .into_response()
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": error.to_string() })),
            )
                .into_response()
        }
    };
    let applied_model_id = (request.kind != "auth_key")
        .then(|| request.model_id.clone())
        .flatten();
    Json(serde_json::json!({
        "ok": true,
        "applied": request.kind,
        "provider_id": provider_id,
        "auth_alias": request.auth_alias,
        "model_id": applied_model_id,
        "until_ms": until_ms,
    }))
    .into_response()
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct ProbeCooldownRequest {
    pub provider_id: String,
    #[serde(default)]
    pub auth_alias: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
}

/// POST /_routecodex/health/cooldown-pool/probe — force the recovery probe due now.
///
/// This only advances the existing probe schedule for the identity. The probe
/// itself is still executed by the runtime's own probe loop through the same
/// provider wire a scheduled probe uses, so a manual click cannot bypass the
/// ladder or run a probe the runtime would refuse. `scheduled=false` means the
/// identity has no probe state and is a successful no-op, not an error.
pub(crate) async fn probe_cooldown(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(request): Json<ProbeCooldownRequest>,
) -> Response {
    if let Some(response) =
        loopback_guard(&state, "/_routecodex/health/cooldown-pool/probe", remote)
    {
        return response;
    }
    let provider_id = request.provider_id.trim().to_string();
    if provider_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid cooldown probe request" })),
        )
            .into_response();
    }
    let scheduled = match state.provider_health.store().trigger_probe_now(
        &provider_id,
        request.auth_alias.as_deref(),
        request.model_id.as_deref(),
        now_ms(),
    ) {
        Ok(scheduled) => scheduled,
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
        "scheduled": scheduled,
        "provider_id": provider_id,
        "auth_alias": request.auth_alias,
        "model_id": request.model_id,
    }))
    .into_response()
}
