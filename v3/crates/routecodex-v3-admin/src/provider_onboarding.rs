// feature_id: v3.admin_api
//! Provider onboarding: candidate validation, create/update/delete, upstream model
//! discovery, route binding, and bulk import.
//!
//! All writes go through Config Core (`routecodex-v3-config-mgmt`) and record a
//! revision. The admin never re-implements provider semantics: protocol
//! normalization, auth handles, and the model table all come from the real compile
//! chain, and credential resolution stays inside `routecodex-v3-provider-responses`.

use crate::api::providers::{collect_provider_references, config_dir};
use crate::AppState;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::routing::{post, put};
use axum::{Json, Router};
use routecodex_v3_config::V2ProviderConfigFile;
use routecodex_v3_config_mgmt::provider::{
    compile_provider_candidate_manifest, delete_provider_directory,
    parse_provider_config_documents, provider_file_source_sha256, read_provider_file,
    validate_provider_candidate, write_provider_file_with_backup, ProviderCandidateValidation,
    ProviderFieldError, V2_PROVIDER_CONFIG_FILE_NAME,
};
use routecodex_v3_config_mgmt::{bind_user_route_member, user_route_groups_from_selection};
use routecodex_v3_provider_responses::discover_v3_provider_models;
use routecodex_v3_runtime::build_v3_provider_global_probe_target;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/providers/validate", post(validate_provider))
        .route("/api/providers", post(create_provider))
        .route("/api/providers/discover", post(discover_models))
        .route("/api/providers/import", post(import_providers))
        .route("/api/providers/routes/bind", post(bind_provider_to_route))
        .route(
            "/api/providers/:id",
            put(update_provider).delete(delete_provider),
        )
}

type ApiError = (StatusCode, Json<Value>);

fn api_error(status: StatusCode, code: &str, message: impl Into<String>) -> ApiError {
    (
        status,
        Json(json!({
            "ok": false,
            "error_code": code,
            "error": message.into(),
        })),
    )
}

fn candidate_invalid_error(validation: &ProviderCandidateValidation) -> ApiError {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({
            "ok": false,
            "error_code": "candidate_invalid",
            "provider_id": validation.provider_id,
            "provider_type": validation.provider_type,
            "errors": validation.errors,
            "compile_error": validation.compile_error,
        })),
    )
}

fn candidate_id(config: &V2ProviderConfigFile) -> Result<String, ApiError> {
    let id = config.provider.id.trim().to_string();
    if id.is_empty() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "provider_id_required",
            "config.provider.id is required",
        ));
    }
    Ok(id)
}

// ---------------------------------------------------------------------------
// POST /api/providers/validate
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct CandidateRequest {
    pub config: V2ProviderConfigFile,
}

/// 只校验、不落盘：返回字段级错误 + 真实编译链结果（协议归一、模型表、默认模型）。
async fn validate_provider(
    Json(request): Json<CandidateRequest>,
) -> Result<Json<ProviderCandidateValidation>, ApiError> {
    let id = candidate_id(&request.config)?;
    Ok(Json(validate_provider_candidate(&id, &request.config)))
}

// ---------------------------------------------------------------------------
// POST /api/providers (create) / PUT /api/providers/:id (update)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct WriteProviderRequest {
    pub config: V2ProviderConfigFile,
    #[serde(default)]
    pub reason: Option<String>,
}

async fn create_provider(
    State(state): State<AppState>,
    Json(request): Json<WriteProviderRequest>,
) -> Result<Json<Value>, ApiError> {
    let id = candidate_id(&request.config)?;
    write_provider(&state, &id, request)
}

async fn update_provider(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<WriteProviderRequest>,
) -> Result<Json<Value>, ApiError> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "provider_id_required",
            "provider id path segment is required",
        ));
    }
    write_provider(&state, &id, request)
}

/// 校验通过才落盘；写入前记录被替换内容的 sha256，替换前生成备份，写入后追加 revision。
fn write_provider(
    state: &AppState,
    id: &str,
    request: WriteProviderRequest,
) -> Result<Json<Value>, ApiError> {
    let config_dir = config_dir(state);
    let existed = read_provider_file(&config_dir, id).is_ok();
    let validation = validate_provider_candidate(id, &request.config);
    if !validation.ok {
        return Err(candidate_invalid_error(&validation));
    }
    let source_sha256 = provider_file_source_sha256(&config_dir, id);
    let (path, backup) = write_provider_file_with_backup(&config_dir, id, &request.config)
        .map_err(|error| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "provider_write_failed",
                error,
            )
        })?;
    let action = if existed {
        "provider.update"
    } else {
        "provider.create"
    };
    let reason = request.reason.unwrap_or_else(|| {
        if existed {
            "webui provider update".to_string()
        } else {
            "webui provider create".to_string()
        }
    });
    let revision = state
        .store
        .revision_store()
        .append(
            action,
            &format!("provider/{id}/{V2_PROVIDER_CONFIG_FILE_NAME}"),
            &reason,
            backup.as_deref(),
            &source_sha256,
            "committed",
        )
        .map_err(|error| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "revision_append_failed",
                error.to_string(),
            )
        })?;
    Ok(Json(json!({
        "ok": true,
        "provider_id": id,
        "created": !existed,
        "normalized_type": validation.normalized_type,
        "models": validation.models,
        "path": path.display().to_string(),
        "backup": backup.map(|path| path.display().to_string()),
        "source_sha256": source_sha256,
        "revision_seq": revision.seq,
    })))
}

// ---------------------------------------------------------------------------
// DELETE /api/providers/:id
// ---------------------------------------------------------------------------

/// 仍被路由/forwarder 引用的 provider 拒绝删除（409，列出全部引用位置）。
async fn delete_provider(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let config_dir = config_dir(&state);
    if read_provider_file(&config_dir, &id).is_err() {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "provider_not_found",
            format!("provider {id} not found"),
        ));
    }
    let authoring = state.store.read_authoring().map_err(|error| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "authoring_read_failed",
            error.to_string(),
        )
    })?;
    let (references, forwarder_references) = collect_provider_references(&authoring, &id);
    if !references.is_empty() || !forwarder_references.is_empty() {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({
                "ok": false,
                "error_code": "provider_referenced",
                "provider_id": id,
                "error": format!(
                    "provider {id} is still referenced by route configuration; unbind it first"
                ),
                "references": references,
                "forwarder_references": forwarder_references,
            })),
        ));
    }
    let source_sha256 = provider_file_source_sha256(&config_dir, &id);
    let removed = delete_provider_directory(&config_dir, &id).map_err(|error| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "provider_delete_failed",
            error,
        )
    })?;
    let Some((directory, backup)) = removed else {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "provider_not_found",
            format!("provider {id} not found"),
        ));
    };
    let revision = state
        .store
        .revision_store()
        .append(
            "provider.delete",
            &format!("provider/{id}/{V2_PROVIDER_CONFIG_FILE_NAME}"),
            "webui provider delete",
            Some(&backup),
            &source_sha256,
            "committed",
        )
        .map_err(|error| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "revision_append_failed",
                error.to_string(),
            )
        })?;
    Ok(Json(json!({
        "ok": true,
        "provider_id": id,
        "directory": directory.display().to_string(),
        "backup": backup.display().to_string(),
        "source_sha256": source_sha256,
        "revision_seq": revision.seq,
    })))
}

// ---------------------------------------------------------------------------
// POST /api/providers/discover
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct DiscoverModelsRequest {
    /// 已存在的 provider id（从磁盘读取配置）。
    #[serde(default)]
    pub id: Option<String>,
    /// 未落盘的候选 provider 配置。
    #[serde(default)]
    pub config: Option<V2ProviderConfigFile>,
    #[serde(default)]
    pub auth_alias: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// 上游模型发现：只返回上游真实返回的模型名，不猜测、不落盘。
///
/// 凭据解析发生在 `routecodex-v3-provider-responses` 内部；本 handler 只把
/// 编译链产出的 auth handle 传进去，并把 auth alias（非 secret）作为证据返回。
async fn discover_models(
    State(state): State<AppState>,
    Json(request): Json<DiscoverModelsRequest>,
) -> Result<Json<Value>, ApiError> {
    let config_dir = config_dir(&state);
    let (id, config) = match (&request.id, &request.config) {
        (Some(id), None) => {
            let entry = read_provider_file(&config_dir, id.trim())
                .map_err(|error| api_error(StatusCode::NOT_FOUND, "provider_not_found", error))?;
            (id.trim().to_string(), entry.config)
        }
        (None, Some(config)) => (candidate_id(config)?, config.clone()),
        (Some(id), Some(config)) => {
            let candidate = candidate_id(config)?;
            if candidate != id.trim() {
                return Err(api_error(
                    StatusCode::BAD_REQUEST,
                    "provider_id_mismatch",
                    format!(
                        "`id` provider {:?} does not match config.provider.id {:?}",
                        id, candidate
                    ),
                ));
            }
            (candidate, config.clone())
        }
        (None, None) => {
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                "provider_reference_required",
                "provide either `id` (existing provider) or `config` (candidate)",
            ))
        }
    };
    let validation = validate_provider_candidate(&id, &config);
    if !validation.ok {
        return Err(candidate_invalid_error(&validation));
    }
    let manifest = compile_provider_candidate_manifest(&id, &config).map_err(|error| {
        api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "candidate_compile_failed",
            error,
        )
    })?;
    let target = build_v3_provider_global_probe_target(
        &manifest,
        &id,
        request.auth_alias.as_deref(),
        request.model.as_deref(),
    )
    .map_err(|error| {
        api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "probe_target_unavailable",
            error,
        )
    })?;
    let provider_type = target.provider_type.clone();
    let base_url = target.base_url.clone();
    let auth_alias = target.auth.alias.clone();
    match discover_v3_provider_models(&id, &provider_type, &base_url, &target.auth).await {
        Ok(models) => Ok(Json(json!({
            "ok": true,
            "provider_id": id,
            "provider_type": provider_type,
            "base_url": base_url,
            "auth_alias": auth_alias,
            "count": models.len(),
            "models": models,
        }))),
        Err(error) => Err(api_error(
            StatusCode::BAD_GATEWAY,
            "model_discovery_failed",
            error.to_string(),
        )),
    }
}

// ---------------------------------------------------------------------------
// POST /api/providers/import
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct ImportProvidersRequest {
    /// 一个或多个 provider 文件文本；独占一行的 `---` 分隔多个文档。
    pub text: String,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportItemResult {
    pub index: usize,
    pub provider_id: Option<String>,
    pub ok: bool,
    /// 失败项是否可重试；原文通过响应的 `retry.text` 原样返回，可直接再次提交。
    pub retryable: bool,
    pub errors: Vec<ProviderFieldError>,
    pub parse_error: Option<String>,
    pub compile_error: Option<String>,
    pub written: bool,
    pub revision_seq: Option<u64>,
    pub backup: Option<String>,
}

struct ImportCandidate {
    index: usize,
    text: String,
    provider_id: Option<String>,
    config: Option<V2ProviderConfigFile>,
    errors: Vec<ProviderFieldError>,
    parse_error: Option<String>,
}

/// 批量导入：逐项校验、逐项写入（partial success）。
///
/// 每项独立报告 `ok / written / errors`；失败项原文经 `retry.text` 原样返回，
/// 可直接作为下一次 import 的输入重试。写盘失败或 revision 记录失败同样按项
/// 显式报告，绝不把部分写入伪装成整体成功。
async fn import_providers(
    State(state): State<AppState>,
    Json(request): Json<ImportProvidersRequest>,
) -> Result<Json<Value>, ApiError> {
    let config_dir = config_dir(&state);
    let documents = parse_provider_config_documents(&request.text);
    if documents.is_empty() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "import_empty",
            "no provider document found in `text`",
        ));
    }
    let mut candidates = documents
        .into_iter()
        .enumerate()
        .map(|(index, document)| match document.parsed {
            Err(parse_error) => ImportCandidate {
                index,
                text: document.text,
                provider_id: None,
                config: None,
                errors: Vec::new(),
                parse_error: Some(parse_error),
            },
            Ok(config) => {
                let id = config.provider.id.trim().to_string();
                if id.is_empty() {
                    ImportCandidate {
                        index,
                        text: document.text,
                        provider_id: None,
                        config: None,
                        errors: vec![ProviderFieldError {
                            field: "id".to_string(),
                            message: "provider.id is required".to_string(),
                            source: "contract".to_string(),
                        }],
                        parse_error: None,
                    }
                } else {
                    ImportCandidate {
                        index,
                        text: document.text,
                        provider_id: Some(id),
                        config: Some(config),
                        errors: Vec::new(),
                        parse_error: None,
                    }
                }
            }
        })
        .collect::<Vec<_>>();

    let mut id_counts: BTreeMap<String, usize> = BTreeMap::new();
    for candidate in &candidates {
        if let Some(id) = &candidate.provider_id {
            *id_counts.entry(id.clone()).or_insert(0) += 1;
        }
    }

    let mut items: Vec<ImportItemResult> = Vec::with_capacity(candidates.len());
    let mut writable: Vec<(usize, String, V2ProviderConfigFile)> = Vec::new();
    let mut failed_texts: Vec<String> = Vec::new();
    for candidate in &mut candidates {
        let index = candidate.index;
        let provider_id = candidate.provider_id.clone();
        if candidate.parse_error.is_some() || provider_id.is_none() || !candidate.errors.is_empty()
        {
            failed_texts.push(candidate.text.clone());
            items.push(ImportItemResult {
                index,
                provider_id,
                ok: false,
                retryable: true,
                errors: std::mem::take(&mut candidate.errors),
                parse_error: candidate.parse_error.take(),
                compile_error: None,
                written: false,
                revision_seq: None,
                backup: None,
            });
            continue;
        }
        let id = provider_id.expect("checked above");
        if id_counts.get(&id).copied().unwrap_or(0) > 1 {
            failed_texts.push(candidate.text.clone());
            items.push(ImportItemResult {
                index,
                provider_id: Some(id.clone()),
                ok: false,
                retryable: true,
                errors: vec![ProviderFieldError {
                    field: "id".to_string(),
                    message: format!("provider id {id:?} appears more than once in this import"),
                    source: "contract".to_string(),
                }],
                parse_error: None,
                compile_error: None,
                written: false,
                revision_seq: None,
                backup: None,
            });
            continue;
        }
        let config = candidate
            .config
            .take()
            .expect("parsed candidate carries a config");
        let validation = validate_provider_candidate(&id, &config);
        if !validation.ok {
            failed_texts.push(candidate.text.clone());
            items.push(ImportItemResult {
                index,
                provider_id: Some(id),
                ok: false,
                retryable: true,
                errors: validation.errors,
                parse_error: None,
                compile_error: validation.compile_error,
                written: false,
                revision_seq: None,
                backup: None,
            });
            continue;
        }
        items.push(ImportItemResult {
            index,
            provider_id: Some(id.clone()),
            ok: true,
            retryable: false,
            errors: Vec::new(),
            parse_error: None,
            compile_error: None,
            written: false,
            revision_seq: None,
            backup: None,
        });
        writable.push((index, id, config));
    }

    let mut written = 0;
    if !request.dry_run {
        let reason = request
            .reason
            .clone()
            .unwrap_or_else(|| "webui provider import".to_string());
        for (index, id, config) in &writable {
            let source_sha256 = provider_file_source_sha256(&config_dir, id);
            let (backup, write_error) =
                match write_provider_file_with_backup(&config_dir, id, config) {
                    Ok((_path, backup)) => (backup, None),
                    Err(error) => (None, Some(error)),
                };
            if let Some(error) = write_error {
                if let Some(item) = items.iter_mut().find(|item| item.index == *index) {
                    item.ok = false;
                    item.retryable = true;
                    item.errors.push(ProviderFieldError {
                        field: "provider_file".to_string(),
                        message: error,
                        source: "write".to_string(),
                    });
                }
                if let Some(candidate) = candidates
                    .iter()
                    .find(|candidate| candidate.index == *index)
                {
                    failed_texts.push(candidate.text.clone());
                }
                continue;
            }
            let existed = source_sha256 != "absent";
            let revision = state.store.revision_store().append(
                if existed {
                    "provider.update"
                } else {
                    "provider.create"
                },
                &format!("provider/{id}/{V2_PROVIDER_CONFIG_FILE_NAME}"),
                &reason,
                backup.as_deref(),
                &source_sha256,
                "committed",
            );
            match revision {
                Ok(revision) => {
                    written += 1;
                    if let Some(item) = items.iter_mut().find(|item| item.index == *index) {
                        item.written = true;
                        item.revision_seq = Some(revision.seq);
                        item.backup = backup.map(|path| path.display().to_string());
                    }
                }
                Err(error) => {
                    // 文件已写入但 revision 未记录：显式报告，绝不当作成功。
                    if let Some(item) = items.iter_mut().find(|item| item.index == *index) {
                        item.ok = false;
                        item.retryable = true;
                        item.written = true;
                        item.backup = backup.map(|path| path.display().to_string());
                        item.errors.push(ProviderFieldError {
                            field: "revision".to_string(),
                            message: format!(
                                "provider file was written but the revision entry failed: {error}"
                            ),
                            source: "revision".to_string(),
                        });
                    }
                }
            }
        }
    }

    let failed = items.iter().filter(|item| !item.ok).count();
    Ok(Json(json!({
        "ok": failed == 0,
        "dry_run": request.dry_run,
        "written": written,
        "failed": failed,
        "items": items,
        "retry": {
            "count": failed_texts.len(),
            "text": failed_texts.join("\n---\n"),
        },
    })))
}

// ---------------------------------------------------------------------------
// POST /api/providers/routes/bind
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct BindRouteRequest {
    pub provider_id: String,
    pub server_id: String,
    #[serde(default)]
    pub pool: Option<String>,
    /// canonical model id；缺省用 provider 的 default_model。
    #[serde(default)]
    pub model: Option<String>,
    /// tier 下标（0 = 最高优先级层）；缺省 0。
    #[serde(default)]
    pub tier: Option<usize>,
    #[serde(default)]
    pub weight: Option<u32>,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

/// 把一个 provider/model 成员写入 user routing 的指定 pool tier，并记录 revision。
///
/// pool/tier 的创建与同 `use_ref` 成员的原地替换由 Config Core
/// (`bind_user_route_member`) 拥有；admin 只解析请求、校验 provider 契约并投影结果。
async fn bind_provider_to_route(
    State(state): State<AppState>,
    Json(request): Json<BindRouteRequest>,
) -> Result<Json<Value>, ApiError> {
    let provider_id = request.provider_id.trim().to_string();
    let config_dir = config_dir(&state);
    let entry = read_provider_file(&config_dir, &provider_id)
        .map_err(|error| api_error(StatusCode::NOT_FOUND, "provider_not_found", error))?;
    let declared_models = entry
        .config
        .provider
        .models
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    let model = match request.model.as_deref().map(str::trim) {
        Some(model) if !model.is_empty() => model.to_string(),
        _ => entry.config.provider.default_model.trim().to_string(),
    };
    if model.is_empty() {
        return Err(api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "model_required",
            format!(
                "no model given and provider {provider_id} has no default_model; declared models: {}",
                declared_models.join(", ")
            ),
        ));
    }
    if !declared_models.iter().any(|declared| declared == &model) {
        return Err(api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "model_not_declared",
            format!(
                "model {model:?} is not declared by provider {provider_id}; declared models: {}",
                declared_models.join(", ")
            ),
        ));
    }
    let pool_name = request
        .pool
        .as_deref()
        .map(str::trim)
        .filter(|pool| !pool.is_empty())
        .unwrap_or("default")
        .to_string();
    let tier_index = request.tier.unwrap_or(0);
    let server_id = request.server_id.trim().to_string();

    let mut selection = state.store.read_user_routing().map_err(|error| {
        api_error(
            StatusCode::BAD_REQUEST,
            "user_routing_unavailable",
            error.to_string(),
        )
    })?;
    let known_servers = selection.servers.keys().cloned().collect::<Vec<_>>();
    if !known_servers.iter().any(|known| known == &server_id) {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({
                "ok": false,
                "error_code": "unknown_server",
                "error": format!(
                    "unknown server {server_id:?}; known servers: {}",
                    known_servers.join(", ")
                ),
                "known_servers": known_servers,
            })),
        ));
    }
    // pool / tier 的创建与成员替换全部归 Config Core（`bind_user_route_member`）所有，
    // admin 不手工构造任何 route 视图。
    let use_ref = format!("{provider_id}/{model}");
    let binding = bind_user_route_member(
        &mut selection,
        &server_id,
        &pool_name,
        tier_index,
        &use_ref,
        request.weight,
    )
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, "route_bind_rejected", error))?;
    let groups = user_route_groups_from_selection(&selection);
    let member = json!({ "use_ref": binding.use_ref, "weight": binding.weight });
    if binding.already_bound {
        return Ok(Json(json!({
            "ok": true,
            "already_bound": true,
            "written": false,
            "provider_id": provider_id,
            "server_id": server_id,
            "pool": pool_name,
            "tier": tier_index,
            "use_ref": use_ref,
            "weight": request.weight,
            "member": member,
            "pool_created": false,
            "tier_created": false,
            "replaced": false,
            "servers": groups,
        })));
    }
    let manifest = state
        .store
        .validate_user_routing(selection.clone())
        .map_err(|error| {
            api_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "route_compile_failed",
                error.to_string(),
            )
        })?;
    let compiled_providers = manifest.providers.keys().cloned().collect::<Vec<_>>();
    if request.dry_run {
        return Ok(Json(json!({
            "ok": true,
            "dry_run": true,
            "already_bound": false,
            "written": false,
            "provider_id": provider_id,
            "server_id": server_id,
            "pool": pool_name,
            "tier": tier_index,
            "use_ref": use_ref,
            "weight": request.weight,
            "member": member,
            "pool_created": binding.pool_created,
            "tier_created": binding.tier_created,
            "replaced": binding.replaced,
            "compiled_providers": compiled_providers,
            "servers": groups,
        })));
    }
    let reason = request
        .reason
        .as_deref()
        .unwrap_or("webui provider route bind");
    let outcome = state
        .store
        .commit_user_routing_with_backup(&selection, "route.bind", reason)
        .map_err(|error| {
            api_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "route_commit_failed",
                error.to_string(),
            )
        })?;
    Ok(Json(json!({
        "ok": true,
        "dry_run": false,
        "already_bound": false,
        "written": true,
        "provider_id": provider_id,
        "server_id": server_id,
        "pool": pool_name,
        "tier": tier_index,
        "use_ref": use_ref,
        "weight": request.weight,
        "member": member,
        "pool_created": binding.pool_created,
        "tier_created": binding.tier_created,
        "replaced": binding.replaced,
        "reason": reason,
        "compiled_providers": compiled_providers,
        "backup": outcome.backup.as_ref().map(|path| path.display().to_string()),
        "revision_seq": outcome.revision.seq,
        "servers": user_route_groups_from_selection(&selection),
    })))
}
