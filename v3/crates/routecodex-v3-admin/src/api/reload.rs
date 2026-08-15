// feature_id: v3.admin_reload
// Reload API：修订历史查询与 reload 触发。
// reload = 配置校验通过后触发全局受管 restart（exec 重启，所有 listener 聚合）。
// 失败保持旧配置：commit 阶段已保证"校验失败不落盘 + 写前备份 + 修订记录"，
// 本端点只负责把已提交的新配置加载到 runtime，并返回明确结果。
use crate::AppState;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use std::process::Command;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/revisions", get(list_revisions))
        .route("/api/reload", post(reload))
}

async fn list_revisions(
    State(state): State<AppState>,
) -> Json<Vec<routecodex_v3_config_mgmt::ConfigRevision>> {
    let revisions = state
        .store
        .revision_store()
        .list()
        .unwrap_or_default()
        .into_iter()
        .rev()
        .collect();
    Json(revisions)
}

#[derive(Debug, Clone, Serialize)]
pub struct ReloadResult {
    pub ok: bool,
    pub detail: String,
    pub stdout_tail: Option<String>,
    pub stderr_tail: Option<String>,
}

async fn reload(
    State(state): State<AppState>,
) -> Result<Json<ReloadResult>, (axum::http::StatusCode, String)> {
    let authoring = state
        .store
        .read_authoring()
        .map_err(|error| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    state
        .store
        .validate(&authoring)
        .map_err(|error| (axum::http::StatusCode::BAD_REQUEST, error.to_string()))?;

    let output = tokio::task::spawn_blocking(|| {
        Command::new("routecodex")
            .arg("restart")
            .output()
    })
    .await
    .map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("reload task failed: {error}"),
        )
    })?
    .map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to invoke `routecodex restart`: {error}"),
        )
    })?;

    if output.status.success() {
        state
            .store
            .revision_store()
            .append(
                "reload",
                "runtime",
                "webui reload",
                None,
                "runtime",
                "restarted",
            )
            .map_err(|error| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    error.to_string(),
                )
            })?;
        Ok(Json(ReloadResult {
            ok: true,
            detail: "config committed and runtime restarted with new snapshot".to_string(),
            stdout_tail: tail_of(&output.stdout),
            stderr_tail: tail_of(&output.stderr),
        }))
    } else {
        Err((
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!(
                "`routecodex restart` failed (exit {:?}): {}",
                output.status.code(),
                tail_of(&output.stderr).unwrap_or_default()
            ),
        ))
    }
}

fn tail_of(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let tail: Vec<&str> = text.lines().rev().take(8).collect();
    Some(tail.iter().rev().cloned().collect::<Vec<_>>().join("\n"))
}
