// feature_id: v3.admin_routes
// Routes API：分层树（Port -> Pool -> Tier -> Member）读取、校验与提交。
use crate::AppState;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use routecodex_v3_config_mgmt::{
    apply_user_route_group_view, user_route_groups_from_selection, UserRouteGroupView,
};
use serde::Serialize;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/routes", get(get_routes).put(put_routes))
        .route("/api/routes/validate", post(validate_routes))
}

async fn get_routes(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let selection = state.store.read_user_routing().map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            error.to_string(),
        )
    })?;
    let groups = user_route_groups_from_selection(&selection);
    Ok(Json(serde_json::json!({ "groups": groups })))
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct RoutesUpdateRequest {
    pub groups: Vec<UserRouteGroupView>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoutesUpdateResult {
    pub ok: bool,
    pub backup: Option<String>,
    pub revision_seq: u64,
    pub groups: Vec<UserRouteGroupView>,
}

async fn put_routes(
    State(state): State<AppState>,
    Json(request): Json<RoutesUpdateRequest>,
) -> Result<Json<RoutesUpdateResult>, (axum::http::StatusCode, String)> {
    let mut selection = state.store.read_user_routing().map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            error.to_string(),
        )
    })?;
    for group in &request.groups {
        apply_user_route_group_view(&mut selection, group)
            .map_err(|error| (axum::http::StatusCode::BAD_REQUEST, error))?;
    }
    let outcome = state
        .store
        .commit_user_routing_with_backup(
            &selection,
            "route.update",
            request.reason.as_deref().unwrap_or("webui routes update"),
        )
        .map_err(|error| (axum::http::StatusCode::BAD_REQUEST, error.to_string()))?;
    let groups = user_route_groups_from_selection(&selection);
    Ok(Json(RoutesUpdateResult {
        ok: true,
        backup: outcome
            .backup
            .as_ref()
            .map(|path| path.display().to_string()),
        revision_seq: outcome.revision.seq,
        groups,
    }))
}

#[derive(Debug, Clone, Serialize)]
pub struct RoutesValidateResult {
    pub ok: bool,
    pub error: Option<String>,
    pub groups: Vec<UserRouteGroupView>,
}

async fn validate_routes(
    State(state): State<AppState>,
    Json(request): Json<RoutesUpdateRequest>,
) -> Json<RoutesValidateResult> {
    let mut selection = match state.store.read_user_routing() {
        Ok(selection) => selection,
        Err(error) => {
            return Json(RoutesValidateResult {
                ok: false,
                error: Some(error.to_string()),
                groups: Vec::new(),
            });
        }
    };
    for group in &request.groups {
        if let Err(error) = apply_user_route_group_view(&mut selection, group) {
            return Json(RoutesValidateResult {
                ok: false,
                error: Some(error),
                groups: Vec::new(),
            });
        }
    }
    match state.store.validate_user_routing(selection.clone()) {
        Ok(_) => Json(RoutesValidateResult {
            ok: true,
            error: None,
            groups: user_route_groups_from_selection(&selection),
        }),
        Err(error) => Json(RoutesValidateResult {
            ok: false,
            error: Some(error.to_string()),
            groups: Vec::new(),
        }),
    }
}
