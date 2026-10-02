// feature_id: v3.webui_request_observability
// Runtime cooldown projection passthrough. `cooldown_pool` forwards each enabled
// listener's own `/_routecodex/health/cooldown-pool` projection, and
// `remove_cooldown`, `add_cooldown` and `probe_cooldown` each delegate one
// manual action to the listener that owns that cooldown. No handler keeps or
// invents provider health state: the runtime process remains the only owner of
// cooldown truth.

use super::configured_ports;
use crate::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(super) async fn cooldown_pool(State(state): axum::extract::State<AppState>) -> Response {
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
pub(super) struct RemoveCooldownRequest {
    port: u16,
    provider_id: String,
    #[serde(default)]
    auth_alias: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
    kind: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct AddCooldownRequest {
    port: u16,
    provider_id: String,
    #[serde(default)]
    auth_alias: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
    kind: String,
    duration_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct ProbeCooldownRequest {
    port: u16,
    provider_id: String,
    #[serde(default)]
    auth_alias: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
}

/// Shared transport for every manual cooldown action: keep the requested port
/// inside the listeners this admin actually serves, then POST the action to the
/// listener that owns the cooldown and project its body back verbatim. A
/// listener 4xx is passed through unchanged because the listener owns the manual
/// cooldown bounds, so its rejection is the operator's real answer; only a
/// listener-side (non-4xx) failure becomes BAD_GATEWAY. Either way the caller
/// sees the runtime's own body instead of a rewritten one.
async fn forward_cooldown_action<T: Serialize>(
    state: &AppState,
    port: u16,
    action: &str,
    payload: &T,
) -> Response {
    let ports = match configured_ports(state) {
        Ok(ports) => ports,
        Err(error) => {
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": error }))).into_response()
        }
    };
    if !ports.contains(&port) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("port {port} is not configured") })),
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
    let url = format!("http://127.0.0.1:{port}/_routecodex/health/cooldown-pool{action}");
    let response =
        match client.post(url).json(payload).send().await {
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
                Json(json!({ "error": format!("cooldown listener response invalid: {error}") })),
            )
                .into_response()
        }
    };
    if !status.is_success() {
        // The listener is the sole owner of the manual-cooldown bounds (the 24 h
        // duration limit in particular), so its 4xx verdict is the operator's real
        // answer and must survive the proxy unchanged. Relabelling it BAD_GATEWAY
        // would report an operator input mistake as a listener fault. Only a
        // listener-side failure is a gateway fault.
        let projected = if status.is_client_error() {
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY)
        } else {
            StatusCode::BAD_GATEWAY
        };
        return (projected, Json(body)).into_response();
    }
    Json(body).into_response()
}

pub(super) async fn remove_cooldown(
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
    forward_cooldown_action(&state, request.port, "", &request).await
}

/// Manual add. The admin only decides what it can decide locally: an empty
/// identity, and a `kind` that is not a manual kind (`session` is a valid
/// *release* kind, so it cannot be forwarded as an add). The whole duration
/// bound, zero included, belongs to the listener that owns the cooldown ladder;
/// restating even the zero half here would replace the listener's precise
/// "duration_ms 0 is outside 1..=86400000" with a generic message.
pub(super) async fn add_cooldown(
    State(state): axum::extract::State<AppState>,
    Json(request): Json<AddCooldownRequest>,
) -> Response {
    if request.provider_id.trim().is_empty()
        || !matches!(request.kind.as_str(), "auth_key" | "probe")
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid manual cooldown request" })),
        )
            .into_response();
    }
    let payload = json!({
        "provider_id": request.provider_id,
        "auth_alias": request.auth_alias,
        "model_id": request.model_id,
        "kind": request.kind,
        "duration_ms": request.duration_ms,
    });
    forward_cooldown_action(&state, request.port, "/add", &payload).await
}

/// Manual probe. This only makes the next probe due; the listener decides
/// whether a probe entry exists, and a miss is a successful `scheduled: false`.
pub(super) async fn probe_cooldown(
    State(state): axum::extract::State<AppState>,
    Json(request): Json<ProbeCooldownRequest>,
) -> Response {
    if request.provider_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid manual cooldown probe request" })),
        )
            .into_response();
    }
    let payload = json!({
        "provider_id": request.provider_id,
        "auth_alias": request.auth_alias,
        "model_id": request.model_id,
    });
    forward_cooldown_action(&state, request.port, "/probe", &payload).await
}
