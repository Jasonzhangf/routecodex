// feature_id: v3.webui_request_observability
// Whitelisted debug-sample artifact drill-down for the WebUI.
//
// Only the five known artifact file names can ever be read back, and the
// canonicalized path must stay inside the debug samples root, so this is never a
// general purpose file reader. `dir_exists:false` and `artifact_not_found` are
// honest "nothing was captured" answers, never fabricated paths or silent empty
// successes.

use super::query_params;
use axum::body::Body;
use axum::extract::RawQuery;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

/// The only artifact file names the admin may read back. Anything else is
/// rejected before a path is even built, so this endpoint is never a general
/// purpose file reader.
const V3_OBS_ARTIFACT_FILES: [&str; 5] = [
    "request.json",
    "response.json",
    "provider-request.json",
    "provider-response.json",
    "error.json",
];
/// Hard cap for one artifact read. Larger artifacts are reported as
/// `artifact_too_large` rather than truncated or silently dropped.
const V3_OBS_ARTIFACT_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// Locate the debug sample directory for one request.
///
/// The layout (`<samples_root>/<endpointDir>/ports/<port>/<requestId>`) is owned
/// by `routecodex_v3_debug`; this only finds the endpoint directory that
/// actually contains the request. `Ok(None)` means no directory exists: absence
/// of an artifact is not proof that a stage succeeded, and no path is fabricated.
pub(super) fn resolve_v3_obs_sample_dir(
    port: u16,
    request_id: &str,
) -> Result<Option<PathBuf>, String> {
    let root = routecodex_v3_debug::resolve_v3_codex_samples_root()?;
    if !root.is_dir() {
        return Ok(None);
    }
    let encoded = routecodex_v3_debug::encode_v3_codex_sample_path_segment(request_id);
    let mut endpoint_dirs: Vec<PathBuf> = std::fs::read_dir(&root)
        .map_err(|error| format!("read debug samples root {} failed: {error}", root.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    endpoint_dirs.sort();
    for endpoint_dir in endpoint_dirs {
        let candidate = endpoint_dir
            .join("ports")
            .join(port.to_string())
            .join(&encoded);
        if candidate.is_dir() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// List the artifacts that actually exist for one request. Only the five
/// whitelisted file names can ever be reported.
pub(super) fn list_v3_obs_artifacts(dir: &std::path::Path) -> Vec<Value> {
    V3_OBS_ARTIFACT_FILES
        .iter()
        .filter_map(|file| {
            let metadata = std::fs::metadata(dir.join(file)).ok()?;
            metadata
                .is_file()
                .then(|| json!({ "file": file, "size_bytes": metadata.len() }))
        })
        .collect()
}

fn observability_port_param(params: &HashMap<String, String>) -> Result<u16, String> {
    params
        .get("port")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "port is required".to_string())?
        .parse::<u16>()
        .map_err(|_| "port must be a u16".to_string())
}

fn observability_request_id_param(params: &HashMap<String, String>) -> Result<String, String> {
    params
        .get("request_id")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "request_id is required".to_string())
}

/// `GET /api/observability/artifacts?port=&request_id=` — list artifact file
/// names and sizes for one request. `dir_exists:false` is an honest "no sample
/// directory was captured", never a fabricated path or a silent empty success.
pub(super) async fn artifacts(raw_query: RawQuery) -> Response {
    let params = query_params(&raw_query);
    let port = match observability_port_param(&params) {
        Ok(port) => port,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
        }
    };
    let request_id = match observability_request_id_param(&params) {
        Ok(request_id) => request_id,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
        }
    };
    let dir = match resolve_v3_obs_sample_dir(port, &request_id) {
        Ok(dir) => dir,
        Err(error) => {
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": error }))).into_response()
        }
    };
    let files = dir
        .as_deref()
        .map(list_v3_obs_artifacts)
        .unwrap_or_default();
    Json(json!({
        "port": port,
        "request_id": request_id,
        "dir_exists": dir.is_some(),
        "files": files,
    }))
    .into_response()
}

/// `GET /api/observability/artifacts/content?port=&request_id=&file=` — read one
/// whitelisted artifact. The `file` name is checked against the fixed allowlist
/// before any path is built, and the canonicalized result must stay inside the
/// debug samples root. This is not a general purpose file reader.
pub(super) async fn artifact_content(raw_query: RawQuery) -> Response {
    let params = query_params(&raw_query);
    let port = match observability_port_param(&params) {
        Ok(port) => port,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
        }
    };
    let request_id = match observability_request_id_param(&params) {
        Ok(request_id) => request_id,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
        }
    };
    let file = match params
        .get("file")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| V3_OBS_ARTIFACT_FILES.contains(value))
    {
        Some(file) => file.to_string(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "file_not_allowed" })),
            )
                .into_response()
        }
    };
    let dir = match resolve_v3_obs_sample_dir(port, &request_id) {
        Ok(Some(dir)) => dir,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "artifact_not_found" })),
            )
                .into_response()
        }
        Err(error) => {
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": error }))).into_response()
        }
    };
    let samples_root = match routecodex_v3_debug::resolve_v3_codex_samples_root() {
        Ok(root) => root,
        Err(error) => {
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": error }))).into_response()
        }
    };
    let canonical_root = match samples_root.canonicalize() {
        Ok(root) => root,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": format!(
                        "debug samples root {} unavailable: {error}",
                        samples_root.display()
                    )
                })),
            )
                .into_response()
        }
    };
    let resolved = match dir.join(&file).canonicalize() {
        Ok(resolved) => resolved,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "artifact_not_found" })),
            )
                .into_response()
        }
    };
    if !resolved.starts_with(&canonical_root) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "file_not_allowed" })),
        )
            .into_response();
    }
    let metadata = match std::fs::metadata(&resolved) {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "artifact_not_found" })),
            )
                .into_response()
        }
    };
    if metadata.len() > V3_OBS_ARTIFACT_MAX_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": "artifact_too_large" })),
        )
            .into_response();
    }
    let bytes = match std::fs::read(&resolved) {
        Ok(bytes) => bytes,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "artifact_not_found" })),
            )
                .into_response()
        }
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .expect("artifact response builds")
}
