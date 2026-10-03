// feature_id: v3.admin_api
//! Provider connectivity probe ladder (L1 contract / L2 reachability+auth / L3 status probe).
//!
//! Advisory diagnostics only: probe outcomes never mutate runtime provider health truth.
//!
//! L2/L3 run through the runtime provider path
//! (`build_v3_provider_global_probe_target` → `build_v3_provider_global_probe_request` →
//! `ReqwestResponsesTransport` / `probe_v3_provider_global_target`), so credentials are
//! resolved exactly where the runtime resolves them and never enter this process.
//! Every emitted evidence string passes through `SecretRedactor`.

use crate::AppState;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use routecodex_v3_config::V2ProviderConfigFile;
use routecodex_v3_config_mgmt::provider::{
    compile_provider_candidate_manifest, read_provider_file, validate_provider_candidate,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_global_probe_request, ProviderResponsesTransport, ResponsesTransport,
    V3ProviderError, V3ResponsesProviderTarget,
};
use routecodex_v3_runtime::{
    build_v3_provider_global_probe_target, probe_v3_provider_global_target,
    V3ProviderHealthProbeFailure,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use tokio::sync::mpsc;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/providers/probe", post(probe_candidate))
        .route("/api/providers/:id/probe", post(probe_existing))
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProbeRequest {
    /// 候选 provider（`/api/providers/probe`）。按 id 探测时忽略。
    #[serde(default)]
    pub config: Option<V2ProviderConfigFile>,
    /// 指定探测的 model（canonical id）；缺省用编译后的第一个 model。
    #[serde(default)]
    pub model: Option<String>,
    /// 指定 auth alias；缺省用编译后的第一个 auth entry。
    #[serde(default)]
    pub auth_alias: Option<String>,
    /// 只跑指定 stage（`l1_contract` / `l2_reachability_auth` / `l3_semantic`）；缺省全部。
    /// `l3_semantic` 是保留的 API 标识，当前语义为 HTTP 2xx 状态探测。
    #[serde(default)]
    pub stages: Option<Vec<String>>,
}

pub(crate) const STAGE_L1: &str = "l1_contract";
pub(crate) const STAGE_L2: &str = "l2_reachability_auth";
/// Legacy stage id retained for API compatibility; this stage is HTTP status-only.
pub(crate) const STAGE_L3: &str = "l3_semantic";

async fn probe_candidate(
    State(state): State<AppState>,
    Json(request): Json<ProbeRequest>,
) -> Response {
    let Some(config) = request.config.clone() else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "candidate_provider_required",
            "POST /api/providers/probe requires a candidate `config`",
        );
    };
    let id = config.provider.id.trim().to_string();
    if id.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "provider_id_required",
            "candidate config.provider.id is required",
        );
    }
    start_probe(state, id, config, request).await
}

async fn probe_existing(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<ProbeRequest>,
) -> Response {
    let config_dir = crate::api::providers::config_dir(&state);
    let entry = match read_provider_file(&config_dir, &id) {
        Ok(entry) => entry,
        Err(error) => return error_response(StatusCode::NOT_FOUND, "provider_not_found", &error),
    };
    start_probe(state, id, entry.config, request).await
}

async fn start_probe(
    _state: AppState,
    id: String,
    config: V2ProviderConfigFile,
    request: ProbeRequest,
) -> Response {
    let probe_id = format!("probe-{}-{}", id, now_ms());
    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(32);
    let runner_id = id.clone();
    let runner_probe_id = probe_id.clone();
    tokio::spawn(async move {
        run_probe(tx, runner_probe_id, runner_id, config, request).await;
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error_code": code, "error": message })),
    )
        .into_response()
}

struct ProbeEmitter {
    tx: mpsc::Sender<Result<Event, Infallible>>,
    probe_id: String,
    redactor: Arc<SecretRedactor>,
}

impl ProbeEmitter {
    async fn send(&self, payload: Value) {
        let _ = self
            .tx
            .send(Ok(Event::default().data(payload.to_string())))
            .await;
    }

    async fn stage_started(&self, stage: &str, label: &str, index: usize, total: usize) {
        self.send(json!({
            "event": "stage_started",
            "probe_id": self.probe_id,
            "at_epoch_ms": now_ms(),
            "stage": stage,
            "label": label,
            "index": index,
            "total": total,
        }))
        .await;
    }

    async fn evidence(&self, stage: &str, kind: &str, data: Value) {
        self.send(json!({
            "event": "evidence",
            "probe_id": self.probe_id,
            "at_epoch_ms": now_ms(),
            "stage": stage,
            "kind": kind,
            "data": scrub_value(&self.redactor, data),
        }))
        .await;
    }

    async fn stage_finished(
        &self,
        stage: &str,
        label: &str,
        ok: bool,
        duration_ms: u64,
        error: Option<Value>,
    ) {
        let payload = json!({
            "event": if ok { "stage_result" } else { "stage_failed" },
            "probe_id": self.probe_id,
            "at_epoch_ms": now_ms(),
            "stage": stage,
            "label": label,
            "ok": ok,
            "duration_ms": duration_ms,
            "error": error.map(|error| scrub_value(&self.redactor, error)),
        });
        self.send(payload).await;
    }

    async fn complete(&self, ok: bool, duration_ms: u64, reports: Vec<Value>) {
        self.send(json!({
            "event": "probe_complete",
            "probe_id": self.probe_id,
            "at_epoch_ms": now_ms(),
            "ok": ok,
            "duration_ms": duration_ms,
            "stages": reports,
        }))
        .await;
    }
}

async fn run_probe(
    tx: mpsc::Sender<Result<Event, Infallible>>,
    probe_id: String,
    id: String,
    config: V2ProviderConfigFile,
    request: ProbeRequest,
) {
    let redactor = Arc::new(SecretRedactor::for_candidate(&config));
    let emitter = ProbeEmitter {
        tx,
        probe_id,
        redactor: Arc::clone(&redactor),
    };
    let selected = selected_stages(&request);
    let total = selected.len();
    let started = std::time::Instant::now();
    let mut all_ok = true;
    let mut reports = Vec::new();

    for (index, stage) in selected.iter().enumerate() {
        let label = stage_label(stage);
        emitter.stage_started(stage, label, index + 1, total).await;
        let run = execute_stage(
            stage,
            &id,
            &config,
            request.model.as_deref(),
            request.auth_alias.as_deref(),
        )
        .await;
        let duration_ms = run.duration_ms;
        for (kind, data) in &run.evidence {
            emitter.evidence(stage, kind, data.clone()).await;
        }
        if run.ok {
            if let Some(result) = &run.result {
                emitter
                    .evidence(stage, "stage_report", result.clone())
                    .await;
            }
        } else {
            all_ok = false;
        }
        let error = if run.ok {
            None
        } else {
            Some(json!({
                "error_code": run.error_code,
                "detail": run.error_detail,
            }))
        };
        emitter
            .stage_finished(stage, label, run.ok, duration_ms, error.clone())
            .await;
        reports.push(json!({
            "stage": stage,
            "label": label,
            "ok": run.ok,
            "duration_ms": duration_ms,
            "error": error.map(|error| scrub_value(&emitter.redactor, error)),
        }));
    }
    emitter
        .complete(all_ok, started.elapsed().as_millis() as u64, reports)
        .await;
}

fn selected_stages(request: &ProbeRequest) -> Vec<String> {
    match request.stages.as_ref() {
        Some(stages) if !stages.is_empty() => stages
            .iter()
            .filter(|stage| matches!(stage.as_str(), STAGE_L1 | STAGE_L2 | STAGE_L3))
            .cloned()
            .collect(),
        _ => vec![
            STAGE_L1.to_string(),
            STAGE_L2.to_string(),
            STAGE_L3.to_string(),
        ],
    }
}

fn stage_label(stage: &str) -> &'static str {
    match stage {
        STAGE_L1 => "L1 contract (offline candidate validation)",
        STAGE_L2 => "L2 reachability + auth",
        STAGE_L3 => "L3 HTTP status probe (2xx)",
        _ => "unknown stage",
    }
}

/// 单个 probe stage 的执行结果。与 SSE 无关，供 SSE probe 与 patrol 共用同一实现。
pub(crate) struct StageRun {
    pub ok: bool,
    pub error_code: Option<&'static str>,
    pub error_detail: Option<Value>,
    pub evidence: Vec<(&'static str, Value)>,
    pub result: Option<Value>,
    pub duration_ms: u64,
}

impl StageRun {
    fn passed(evidence: Vec<(&'static str, Value)>, result: Value) -> Self {
        Self {
            ok: true,
            error_code: None,
            error_detail: None,
            evidence,
            result: Some(result),
            duration_ms: 0,
        }
    }

    fn failed(code: &'static str, detail: Value) -> Self {
        Self {
            ok: false,
            error_code: Some(code),
            error_detail: Some(detail),
            evidence: Vec::new(),
            result: None,
            duration_ms: 0,
        }
    }

    fn with_evidence(mut self, evidence: Vec<(&'static str, Value)>) -> Self {
        self.evidence = evidence;
        self
    }
}

/// 顺序执行若干 stage；patrol 与 SSE probe 走同一条实现。
pub(crate) async fn execute_stages(
    id: &str,
    config: &V2ProviderConfigFile,
    stages: &[String],
    model: Option<&str>,
    auth_alias: Option<&str>,
) -> Vec<(String, StageRun)> {
    let mut runs = Vec::with_capacity(stages.len());
    for stage in stages {
        let run = execute_stage(stage, id, config, model, auth_alias).await;
        runs.push((stage.clone(), run));
    }
    runs
}

/// 跑一个 stage（`l1_contract` / `l2_reachability_auth` / `l3_semantic`）。
/// `l3_semantic` 只判断 HTTP 2xx，不读取或解释响应 body。
pub(crate) async fn execute_stage(
    stage: &str,
    id: &str,
    config: &V2ProviderConfigFile,
    model: Option<&str>,
    auth_alias: Option<&str>,
) -> StageRun {
    let started = std::time::Instant::now();
    let mut run = match stage {
        STAGE_L1 => stage_l1(id, config).await,
        STAGE_L2 => stage_l2(id, config, model, auth_alias).await,
        STAGE_L3 => stage_l3(id, config, model, auth_alias).await,
        other => StageRun::failed(
            "unknown_stage",
            json!({ "message": format!("unknown probe stage {other}") }),
        ),
    };
    run.duration_ms = started.elapsed().as_millis() as u64;
    run
}

async fn stage_l1(id: &str, config: &V2ProviderConfigFile) -> StageRun {
    let validation = validate_provider_candidate(id, config);
    let evidence = vec![(
        "candidate_validation",
        json!({
            "provider_id": validation.provider_id,
            "provider_type": validation.provider_type,
            "normalized_type": validation.normalized_type,
            "base_url": validation.base_url,
            "default_model": validation.default_model,
            "models": validation.models,
            "errors": validation.errors,
            "compile_error": validation.compile_error,
        }),
    )];
    if !validation.ok {
        return StageRun::failed(
            "candidate_invalid",
            json!({
                "errors": validation.errors,
                "compile_error": validation.compile_error,
            }),
        )
        .with_evidence(evidence);
    }
    StageRun::passed(
        evidence,
        json!({
            "normalized_type": validation.normalized_type,
            "models": validation.models,
            "default_model": validation.default_model,
        }),
    )
}

async fn stage_l2(
    id: &str,
    config: &V2ProviderConfigFile,
    model: Option<&str>,
    auth_alias: Option<&str>,
) -> StageRun {
    let target = match probe_target(id, config, model, auth_alias) {
        Ok(target) => target,
        Err(run) => return run,
    };
    let request_id = format!("admin-probe-l2-{id}-{}", now_ms());
    let built = match build_v3_provider_global_probe_request(target, request_id.clone()) {
        Ok(built) => built,
        Err(error) => {
            return StageRun::failed("probe_request_build_failed", json!({ "message": error }))
        }
    };
    let url = built.url().to_string();
    let headers = built
        .provider_headers()
        .iter()
        .map(|header| {
            json!({
                "name": header.name(),
                "value": redact_header_value(header.name(), header.value()),
            })
        })
        .collect::<Vec<_>>();
    let evidence = vec![(
        "provider_request",
        json!({
            "method": "POST",
            "url": url,
            "request_id": request_id,
            "headers": headers,
            "body": built.body(),
            "note": "auth header is attached by the runtime transport; it is never projected here",
        }),
    )];
    match ProviderResponsesTransport::default().send(built).await {
        Ok(response) => StageRun::passed(
            evidence,
            json!({
                "status": response.status(),
                "content_type": response.header_text("content-type").ok().flatten(),
            }),
        ),
        Err(V3ProviderError::HttpStatus { response }) => StageRun::failed(
            "provider_http_status",
            json!({
                "status": response.status,
                "body_preview": preview_bytes(&response.body),
            }),
        )
        .with_evidence(evidence),
        Err(error) => StageRun::failed(
            "provider_transport_failed",
            json!({ "message": error.to_string() }),
        )
        .with_evidence(evidence),
    }
}

async fn stage_l3(
    id: &str,
    config: &V2ProviderConfigFile,
    model: Option<&str>,
    auth_alias: Option<&str>,
) -> StageRun {
    let target = match probe_target(id, config, model, auth_alias) {
        Ok(target) => target,
        Err(run) => return run,
    };
    let evidence = vec![(
        "provider_probe_target",
        json!({
            "provider_id": id,
            "canonical_model_id": target.canonical_model_id,
            "wire_model": target.wire_model,
            "builder": "routecodex_v3_runtime::probe_v3_provider_global_target",
            "success_condition": "http_2xx_status_only",
        }),
    )];
    match probe_v3_provider_global_target(target).await {
        Ok(()) => StageRun::passed(
            evidence,
            json!({ "status_probe": "2xx", "body_inspected": false }),
        ),
        Err(V3ProviderHealthProbeFailure::Provider(message)) => {
            StageRun::failed("provider_rejected", json!({ "message": message }))
                .with_evidence(evidence)
        }
        Err(V3ProviderHealthProbeFailure::Internal(message)) => {
            StageRun::failed("probe_internal_error", json!({ "message": message }))
                .with_evidence(evidence)
        }
        Err(V3ProviderHealthProbeFailure::ConcurrencyBusy) => StageRun::failed(
            "probe_concurrency_busy",
            json!({ "message": "provider concurrency admission is busy; retry the probe" }),
        )
        .with_evidence(evidence),
    }
}

fn probe_target(
    id: &str,
    config: &V2ProviderConfigFile,
    model: Option<&str>,
    auth_alias: Option<&str>,
) -> Result<V3ResponsesProviderTarget, StageRun> {
    let manifest = compile_provider_candidate_manifest(id, config).map_err(|error| {
        StageRun::failed("candidate_compile_failed", json!({ "message": error }))
    })?;
    build_v3_provider_global_probe_target(&manifest, id, auth_alias, model)
        .map_err(|error| StageRun::failed("probe_target_unavailable", json!({ "message": error })))
}

/// 从候选配置收集需要在 evidence 中抹除的明文凭据。
pub(crate) struct SecretRedactor {
    literals: Vec<String>,
}

impl SecretRedactor {
    pub(crate) fn for_candidate(config: &V2ProviderConfigFile) -> Self {
        let mut literals = Vec::new();
        let auth = &config.provider.auth;
        if let Some(api_key) = auth.api_key.as_deref() {
            literals.push(api_key.to_string());
        }
        if let Some(entries) = auth.entries.as_ref() {
            for entry in entries {
                if let Some(api_key) = entry.api_key.as_deref() {
                    literals.push(api_key.to_string());
                }
            }
        }
        for value in config.provider.headers.values() {
            literals.push(value.to_string());
        }
        Self::new(literals)
    }

    pub(crate) fn new(literals: impl IntoIterator<Item = String>) -> Self {
        let literals = literals
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| value.len() >= 6)
            .collect();
        Self { literals }
    }

    /// 抹除已知凭据字面量，并兜底抹除 `Bearer <token>` 与 `sk-` 形态 token。
    pub(crate) fn scrub(&self, text: &str) -> String {
        let mut scrubbed = text.to_string();
        for literal in &self.literals {
            if scrubbed.contains(literal.as_str()) {
                scrubbed = scrubbed.replace(literal.as_str(), "[redacted]");
            }
        }
        scrubbed = scrub_bearer_tokens(&scrubbed);
        scrub_sk_tokens(&scrubbed)
    }
}

fn scrub_bearer_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = find_ignore_ascii_case(rest, "bearer ") {
        out.push_str(&rest[..index]);
        out.push_str(&rest[index..index + "bearer ".len()]);
        let tail = &rest[index + "bearer ".len()..];
        let end = tail
            .find(|ch: char| ch.is_whitespace() || matches!(ch, '"' | '\'' | ',' | '}' | ']' | ';'))
            .unwrap_or(tail.len());
        out.push_str("[redacted]");
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

fn scrub_sk_tokens(text: &str) -> String {
    let chars = text.chars().collect::<Vec<_>>();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == 's'
            && index + 2 < chars.len()
            && chars[index + 1] == 'k'
            && chars[index + 2] == '-'
        {
            let mut end = index + 3;
            while end < chars.len()
                && (chars[end].is_ascii_alphanumeric() || matches!(chars[end], '-' | '_'))
            {
                end += 1;
            }
            if end - index >= 11 {
                out.push_str("[redacted]");
                index = end;
                continue;
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn find_ignore_ascii_case(haystack: &str, needle: &str) -> Option<usize> {
    let lowered = haystack.to_ascii_lowercase();
    lowered.find(&needle.to_ascii_lowercase())
}

fn redact_header_value(name: &str, value: &str) -> String {
    let lowered = name.to_ascii_lowercase();
    if lowered.contains("authorization")
        || lowered.contains("api-key")
        || lowered.contains("apikey")
        || lowered.contains("token")
        || lowered.contains("secret")
        || lowered.contains("cookie")
    {
        return "[redacted]".to_string();
    }
    value.to_string()
}

fn preview_bytes(body: &[u8]) -> String {
    const LIMIT: usize = 512;
    let text = String::from_utf8_lossy(body);
    if text.chars().count() <= LIMIT {
        return text.to_string();
    }
    let truncated = text.chars().take(LIMIT).collect::<String>();
    format!("{truncated}…(truncated)")
}

/// 递归抹除 JSON 里的字符串（evidence 只经由该函数离开进程）。
fn scrub_value(redactor: &SecretRedactor, value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(redactor.scrub(&text)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| scrub_value(redactor, item))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| {
                    if is_secret_header_key(&key) {
                        (key, Value::String("[redacted]".to_string()))
                    } else {
                        (key, scrub_value(redactor, item))
                    }
                })
                .collect(),
        ),
        other => other,
    }
}

fn is_secret_header_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "authorization" | "x-api-key" | "api_key" | "apikey" | "x-goog-api-key" | "cookie"
    )
}

fn now_ms() -> u64 {
    crate::api::providers::now_ms()
}
