// feature_id: v3.webui_request_observability
// Runtime cooldown projection passthrough. `cooldown_pool` forwards each enabled
// listener's own `/_routecodex/health/cooldown-pool` projection and
// `remove_cooldown` delegates one removal to the listener that owns that
// cooldown. Neither handler keeps or invents provider health state: the runtime
// process remains the only owner of cooldown truth.

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
