// feature_id: v3.admin_api
//! Periodic provider patrol: advisory probe schedule plus retained result history.
//!
//! Patrol results are diagnostics, not runtime provider health. They never mutate the
//! runtime cooldown/health truth owned by the provider health state, and the runtime
//! never reads them. Probe execution is shared with the SSE probe ladder
//! (`crate::provider_probe::execute_stages`), so there is exactly one implementation.

use crate::api::providers::{config_dir, now_ms};
use crate::provider_probe::{execute_stages, STAGE_L1, STAGE_L3};
use crate::AppState;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use routecodex_v3_config_mgmt::provider::read_provider_file;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;

pub const PATROL_RESULTS_FILE: &str = "provider-patrol.jsonl";
pub const PATROL_PLANS_FILE: &str = "provider-patrol-plans.json";

const MIN_TICK_MS: u64 = 1_000;
const MAX_TICK_MS: u64 = 30_000;
const IDLE_TICK_MS: u64 = 15_000;
const DEFAULT_INTERVAL_SECS: u64 = 300;
const MAX_INTERVAL_SECS: u64 = 86_400;
const DEFAULT_RESULT_LIMIT: usize = 50;
const MAX_RESULT_LIMIT: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatrolPlan {
    pub provider_id: String,
    pub enabled: bool,
    /// 计划间隔（秒）。启用时必须 > 0；0 表示仅手动触发。
    pub interval_secs: u64,
    /// 参与 patrol 的 stage，必须是 `l1_contract` / `l2_reachability_auth` / `l3_semantic` 的非空子集。
    pub stages: Vec<String>,
    pub model: Option<String>,
    pub auth_alias: Option<String>,
    pub updated_at_epoch_ms: u64,
}

impl PatrolPlan {
    pub fn default_for(provider_id: &str) -> Self {
        Self {
            provider_id: provider_id.to_string(),
            enabled: false,
            interval_secs: DEFAULT_INTERVAL_SECS,
            stages: vec![STAGE_L1.to_string(), STAGE_L3.to_string()],
            model: None,
            auth_alias: None,
            updated_at_epoch_ms: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatrolStageResult {
    pub stage: String,
    pub ok: bool,
    pub duration_ms: u64,
    pub error_code: Option<String>,
    pub detail: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatrolResult {
    pub provider_id: String,
    /// `scheduled` 或 `manual`。
    pub trigger: String,
    pub started_at_epoch_ms: u64,
    pub duration_ms: u64,
    pub ok: bool,
    pub stages: Vec<PatrolStageResult>,
    /// 唯一真源标识：admin 侧诊断记录，不是 runtime provider health。
    pub source: String,
    /// 结果写入历史文件失败时的显式错误（不静默丢弃）。
    #[serde(default)]
    pub persist_error: Option<String>,
}

pub struct PatrolRuntime {
    pub config_path: PathBuf,
    plans: Mutex<BTreeMap<String, PatrolPlan>>,
    last_run_epoch_ms: Mutex<BTreeMap<String, u64>>,
    plan_load_error: Option<String>,
    running: AtomicBool,
    /// Set when this runtime owns the process-wide background tick loop.
    loop_started: AtomicBool,
    /// Wakes the tick loop when a plan is saved or deleted, so a newly enabled
    /// plan is picked up immediately instead of at the end of the idle tick.
    plan_change: Notify,
}

impl std::fmt::Debug for PatrolRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PatrolRuntime")
            .field("config_path", &self.config_path)
            .field("plan_load_error", &self.plan_load_error)
            .finish()
    }
}

impl PatrolRuntime {
    pub fn new(config_path: PathBuf) -> Self {
        let mut plans = BTreeMap::new();
        let mut plan_load_error = None;
        let plans_path = Self::plans_path_for(&config_path);
        match std::fs::read_to_string(&plans_path) {
            Ok(raw) => match serde_json::from_str::<BTreeMap<String, PatrolPlan>>(&raw) {
                Ok(loaded) => plans = loaded,
                Err(error) => {
                    plan_load_error = Some(format!(
                        "provider patrol plans {} parse failed: {error}",
                        plans_path.display()
                    ))
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                plan_load_error = Some(format!(
                    "provider patrol plans {} read failed: {error}",
                    plans_path.display()
                ))
            }
        }
        Self {
            config_path,
            plans: Mutex::new(plans),
            last_run_epoch_ms: Mutex::new(BTreeMap::new()),
            plan_load_error,
            running: AtomicBool::new(false),
            loop_started: AtomicBool::new(false),
            plan_change: Notify::new(),
        }
    }

    fn state_dir_for(config_path: &Path) -> PathBuf {
        config_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("state")
    }

    pub fn state_dir(&self) -> PathBuf {
        Self::state_dir_for(&self.config_path)
    }

    pub fn results_path(&self) -> PathBuf {
        self.state_dir().join(PATROL_RESULTS_FILE)
    }

    pub fn plans_path(&self) -> PathBuf {
        Self::plans_path_for(&self.config_path)
    }

    fn plans_path_for(config_path: &Path) -> PathBuf {
        Self::state_dir_for(config_path).join(PATROL_PLANS_FILE)
    }

    /// 已保存的计划；未配置时返回该 provider 的默认计划（disabled）。
    pub fn plan(&self, provider_id: &str) -> PatrolPlan {
        self.plans
            .lock()
            .expect("patrol plans lock")
            .get(provider_id)
            .cloned()
            .unwrap_or_else(|| PatrolPlan::default_for(provider_id))
    }

    pub fn stored_plan(&self, provider_id: &str) -> Option<PatrolPlan> {
        self.plans
            .lock()
            .expect("patrol plans lock")
            .get(provider_id)
            .cloned()
    }

    pub fn plans(&self) -> Vec<PatrolPlan> {
        self.plans
            .lock()
            .expect("patrol plans lock")
            .values()
            .cloned()
            .collect()
    }

    pub fn plan_load_error(&self) -> Option<&str> {
        self.plan_load_error.as_deref()
    }

    pub fn last_run_epoch_ms(&self, provider_id: &str) -> Option<u64> {
        self.last_run_epoch_ms
            .lock()
            .expect("patrol last-run lock")
            .get(provider_id)
            .copied()
    }

    /// 保存计划：先校验，再原子写 plans 文件；失败时内存状态不变。
    pub fn set_plan(&self, plan: PatrolPlan) -> Result<PatrolPlan, String> {
        validate_plan(&plan)?;
        let mut stored = plan;
        stored.updated_at_epoch_ms = now_ms();
        let serialized = serde_json::to_string_pretty(&{
            let mut all = self.plans.lock().expect("patrol plans lock").clone();
            all.insert(stored.provider_id.clone(), stored.clone());
            all
        })
        .map_err(|error| format!("serialize provider patrol plans failed: {error}"))?;
        let path = self.plans_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create {} failed: {error}", parent.display()))?;
        }
        let temp_path = path.with_extension(format!("json.tmp-{}", std::process::id()));
        std::fs::write(&temp_path, serialized)
            .map_err(|error| format!("write {} failed: {error}", temp_path.display()))?;
        std::fs::rename(&temp_path, &path)
            .map_err(|error| format!("atomic replace {} failed: {error}", path.display()))?;
        self.plans
            .lock()
            .expect("patrol plans lock")
            .insert(stored.provider_id.clone(), stored.clone());
        // `notify_one` stores a permit when the loop is busy running a batch, so a
        // plan saved between two ticks is still picked up immediately.
        self.plan_change.notify_one();
        Ok(stored)
    }

    /// 删除计划；返回是否确实删除了已保存的计划。
    pub fn delete_plan(&self, provider_id: &str) -> Result<bool, String> {
        let mut all = self.plans.lock().expect("patrol plans lock").clone();
        let removed = all.remove(provider_id).is_some();
        if removed {
            let serialized = serde_json::to_string_pretty(&all)
                .map_err(|error| format!("serialize provider patrol plans failed: {error}"))?;
            let path = self.plans_path();
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("create {} failed: {error}", parent.display()))?;
            }
            let temp_path = path.with_extension(format!("json.tmp-{}", std::process::id()));
            std::fs::write(&temp_path, serialized)
                .map_err(|error| format!("write {} failed: {error}", temp_path.display()))?;
            std::fs::rename(&temp_path, &path)
                .map_err(|error| format!("atomic replace {} failed: {error}", path.display()))?;
            self.plans
                .lock()
                .expect("patrol plans lock")
                .remove(provider_id);
            self.plan_change.notify_one();
        }
        Ok(removed)
    }

    /// 是否已启动本进程唯一的后台 tick loop（`loop_started` 只在真实入口启动后为真）。
    pub fn loop_started(&self) -> bool {
        self.loop_started.load(Ordering::SeqCst)
    }

    /// 等待计划变更（保存/删除）；由 tick loop 与定时睡眠一起 select。
    pub async fn wait_for_plan_change(&self) {
        self.plan_change.notified().await;
    }

    /// 读取某个 provider 的历史结果（最新在前）。
    pub fn results(&self, provider_id: &str, limit: usize) -> Result<Vec<PatrolResult>, String> {
        let path = self.results_path();
        let file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("read {} failed: {error}", path.display())),
        };
        let mut collected: Vec<PatrolResult> = Vec::new();
        let mut malformed = 0_usize;
        for line in std::io::BufReader::new(file).lines() {
            let line = line.map_err(|error| format!("read {} failed: {error}", path.display()))?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<PatrolResult>(&line) {
                Ok(result) => {
                    if result.provider_id == provider_id {
                        collected.push(result);
                        if collected.len() > limit {
                            collected.remove(0);
                        }
                    }
                }
                Err(_) => malformed += 1,
            }
        }
        if malformed > 0 {
            eprintln!(
                "[admin] provider patrol history {} has {malformed} unreadable line(s)",
                path.display()
            );
        }
        collected.reverse();
        Ok(collected)
    }

    fn append_result(&self, result: &PatrolResult) -> Result<(), String> {
        let path = self.results_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create {} failed: {error}", parent.display()))?;
        }
        let mut line = serde_json::to_string(result)
            .map_err(|error| format!("serialize provider patrol result failed: {error}"))?;
        line.push('\n');
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| format!("open {} failed: {error}", path.display()))?;
        file.write_all(line.as_bytes())
            .map_err(|error| format!("append {} failed: {error}", path.display()))?;
        Ok(())
    }

    /// 执行一次 patrol（手动或计划）。结果一定返回，落盘失败以 `persist_error` 显式暴露。
    pub async fn run(&self, state: &AppState, provider_id: &str, trigger: &str) -> PatrolResult {
        let plan = self.plan(provider_id);
        let started_at_epoch_ms = now_ms();
        let started = std::time::Instant::now();
        let config_dir = config_dir(state);
        let stages = match read_provider_file(&config_dir, provider_id) {
            Err(error) => vec![PatrolStageResult {
                stage: "provider_file".to_string(),
                ok: false,
                duration_ms: 0,
                error_code: Some("provider_not_found".to_string()),
                detail: Some(json!({ "message": error })),
            }],
            Ok(entry) => execute_stages(
                provider_id,
                &entry.config,
                &plan.stages,
                plan.model.as_deref(),
                plan.auth_alias.as_deref(),
            )
            .await
            .into_iter()
            .map(|(stage, run)| PatrolStageResult {
                stage,
                ok: run.ok,
                duration_ms: run.duration_ms,
                error_code: run.error_code.map(str::to_string),
                detail: run.error_detail,
            })
            .collect(),
        };
        let ok = !stages.is_empty() && stages.iter().all(|stage| stage.ok);
        let mut result = PatrolResult {
            provider_id: provider_id.to_string(),
            trigger: trigger.to_string(),
            started_at_epoch_ms,
            duration_ms: started.elapsed().as_millis() as u64,
            ok,
            stages,
            source: "admin_provider_patrol".to_string(),
            persist_error: None,
        };
        result.persist_error = self.append_result(&result).err();
        self.last_run_epoch_ms
            .lock()
            .expect("patrol last-run lock")
            .insert(provider_id.to_string(), started_at_epoch_ms);
        result
    }

    /// 跑所有到期的已启用计划（同一时刻只允许一个 run 批次）。
    pub async fn run_due(&self, state: &AppState) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let now = now_ms();
        let due = {
            let plans = self.plans.lock().expect("patrol plans lock");
            let last = self.last_run_epoch_ms.lock().expect("patrol last-run lock");
            plans
                .values()
                .filter(|plan| plan.enabled && plan.interval_secs > 0)
                .filter(|plan| {
                    let interval_ms = plan.interval_secs.saturating_mul(1_000);
                    let elapsed =
                        now.saturating_sub(last.get(&plan.provider_id).copied().unwrap_or(0));
                    elapsed >= interval_ms
                })
                .map(|plan| plan.provider_id.clone())
                .collect::<Vec<_>>()
        };
        for provider_id in due {
            self.run(state, &provider_id, "scheduled").await;
        }
        self.running.store(false, Ordering::SeqCst);
    }

    /// 下一次 tick 的等待时间：最短的到期剩余时间，限制在 [1s, 30s]。
    pub fn next_tick_ms(&self) -> u64 {
        let now = now_ms();
        let plans = self.plans.lock().expect("patrol plans lock");
        let last = self.last_run_epoch_ms.lock().expect("patrol last-run lock");
        let mut soonest = IDLE_TICK_MS;
        for plan in plans
            .values()
            .filter(|plan| plan.enabled && plan.interval_secs > 0)
        {
            let interval_ms = plan.interval_secs.saturating_mul(1_000);
            let elapsed = now.saturating_sub(last.get(&plan.provider_id).copied().unwrap_or(0));
            soonest = soonest.min(interval_ms.saturating_sub(elapsed).max(MIN_TICK_MS));
        }
        soonest.clamp(MIN_TICK_MS, MAX_TICK_MS)
    }
}

fn validate_plan(plan: &PatrolPlan) -> Result<(), String> {
    if plan.provider_id.trim().is_empty() {
        return Err("patrol plan provider_id is required".to_string());
    }
    if plan.enabled && plan.interval_secs == 0 {
        return Err("enabled patrol plan requires interval_secs > 0".to_string());
    }
    if plan.interval_secs > MAX_INTERVAL_SECS {
        return Err(format!(
            "patrol interval_secs {} exceeds the {MAX_INTERVAL_SECS}s maximum",
            plan.interval_secs
        ));
    }
    if plan.stages.is_empty() {
        return Err("patrol plan requires at least one stage".to_string());
    }
    for stage in &plan.stages {
        if !matches!(stage.as_str(), STAGE_L1 | STAGE_L3 | "l2_reachability_auth") {
            return Err(format!("unknown patrol stage {stage:?}"));
        }
    }
    Ok(())
}

/// Claim the single background patrol loop slot for this process.
///
/// The process is the scheduler boundary: a process serves one admin WebUI
/// surface over one plans file, so exactly one tick loop may own `plans_path`.
/// A second start (the standalone `rccv3-admin` binary plus an in-process admin
/// router in the same process, or two aggregates over the same config) is
/// refused instead of scheduling the same plan file twice.
fn try_claim_patrol_loop(owner: &OnceLock<PathBuf>, plans_path: &Path) -> bool {
    owner.set(plans_path.to_path_buf()).is_ok()
}

static PATROL_LOOP_OWNER: OnceLock<PathBuf> = OnceLock::new();

/// Plans file owned by the process-wide background tick loop, when one started.
pub fn patrol_loop_owner() -> Option<PathBuf> {
    PATROL_LOOP_OWNER.get().cloned()
}

/// Background tick loop. Wakes on the shortest configured interval (or as soon
/// as a plan changes) and runs due patrols.
///
/// Advisory only: this never blocks the caller, never fails startup, and a
/// patrol error cannot terminate the server. Detached by design — it holds one
/// task for the life of the process and is dropped with the runtime, so it can
/// never keep shutdown waiting.
pub fn spawn_patrol_loop(state: Arc<AppState>) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        eprintln!("[admin] provider patrol loop not started: no tokio runtime on this thread");
        return;
    };
    if !try_claim_patrol_loop(&PATROL_LOOP_OWNER, &state.patrol.plans_path()) {
        eprintln!(
            "[admin] provider patrol loop already running for {}; ignoring duplicate start",
            patrol_loop_owner()
                .map(|path| path.display().to_string())
                .unwrap_or_default()
        );
        return;
    }
    state.patrol.loop_started.store(true, Ordering::SeqCst);
    runtime.spawn(async move {
        loop {
            // The due check and the wake interval are separate concerns: wake no
            // later than the soonest due plan (or a plan change), then run whatever
            // is due. `next_tick_ms` is clamped to >= 1s, so this never spins.
            let tick_ms = state.patrol.next_tick_ms();
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(tick_ms)) => {}
                _ = state.patrol.wait_for_plan_change() => {}
            }
            state.patrol.run_due(&state).await;
        }
    });
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/providers/patrol/status", get(patrol_status))
        .route(
            "/api/providers/:id/patrol",
            get(get_plan).put(put_plan).delete(delete_plan),
        )
        .route("/api/providers/:id/patrol/results", get(get_results))
        .route("/api/providers/:id/patrol/run", post(run_now))
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

fn require_provider(state: &AppState, provider_id: &str) -> Result<(), ApiError> {
    read_provider_file(&config_dir(state), provider_id)
        .map(|_| ())
        .map_err(|error| api_error(StatusCode::NOT_FOUND, "provider_not_found", error))
}

async fn patrol_status(State(state): State<AppState>) -> Json<Value> {
    let plans = state.patrol.plans();
    Json(json!({
        "ok": true,
        "running": state.patrol.running.load(Ordering::SeqCst),
        "loop_started": state.patrol.loop_started(),
        "plan_count": plans.len(),
        "enabled_count": plans.iter().filter(|plan| plan.enabled).count(),
        "next_tick_ms": state.patrol.next_tick_ms(),
        "results_path": state.patrol.results_path().display().to_string(),
        "plans_path": state.patrol.plans_path().display().to_string(),
        "plan_load_error": state.patrol.plan_load_error(),
        "plans": plans,
        "advisory": "admin patrol results are diagnostics; runtime provider health truth lives in the runtime cooldown projection",
    }))
}

async fn get_plan(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    require_provider(&state, &id)?;
    let stored = state.patrol.stored_plan(&id);
    Ok(Json(json!({
        "ok": true,
        "provider_id": id,
        "stored": stored.is_some(),
        "plan": stored.unwrap_or_else(|| PatrolPlan::default_for(&id)),
        "default_plan": PatrolPlan::default_for(&id),
        "last_run_epoch_ms": state.patrol.last_run_epoch_ms(&id),
    })))
}

#[derive(Debug, Clone, Deserialize)]
pub struct PatrolPlanRequest {
    pub enabled: bool,
    pub interval_secs: u64,
    pub stages: Vec<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub auth_alias: Option<String>,
}

async fn put_plan(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<PatrolPlanRequest>,
) -> Result<Json<Value>, ApiError> {
    require_provider(&state, &id)?;
    let plan = PatrolPlan {
        provider_id: id.clone(),
        enabled: request.enabled,
        interval_secs: request.interval_secs,
        stages: request.stages,
        model: request.model,
        auth_alias: request.auth_alias,
        updated_at_epoch_ms: 0,
    };
    let stored = state
        .patrol
        .set_plan(plan)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, "patrol_plan_rejected", error))?;
    Ok(Json(
        json!({ "ok": true, "provider_id": id, "stored": true, "plan": stored }),
    ))
}

async fn delete_plan(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let removed = state.patrol.delete_plan(&id).map_err(|error| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "patrol_plan_delete_failed",
            error,
        )
    })?;
    Ok(Json(json!({
        "ok": true,
        "provider_id": id,
        "removed": removed,
        "plan": PatrolPlan::default_for(&id),
    })))
}

#[derive(Debug, Clone, Deserialize)]
pub struct PatrolResultsQuery {
    #[serde(default)]
    pub limit: Option<usize>,
}

async fn get_results(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<PatrolResultsQuery>,
) -> Result<Json<Value>, ApiError> {
    require_provider(&state, &id)?;
    let limit = query
        .limit
        .unwrap_or(DEFAULT_RESULT_LIMIT)
        .clamp(1, MAX_RESULT_LIMIT);
    let results = state.patrol.results(&id, limit).map_err(|error| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "patrol_results_read_failed",
            error,
        )
    })?;
    Ok(Json(json!({
        "ok": true,
        "provider_id": id,
        "limit": limit,
        "count": results.len(),
        "results": results,
    })))
}

/// 手动触发一次 patrol（使用已保存的计划；未保存时用默认计划）。
async fn run_now(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    require_provider(&state, &id)?;
    let result = state.patrol.run(&state, &id, "manual").await;
    Ok(Json(json!({ "ok": result.ok, "result": result })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patrol_loop_claim_is_exactly_one_scheduler_per_plan_file_per_process() {
        let owner = OnceLock::new();
        let plans = Path::new("/tmp/patrol-claim/provider-patrol-plans.json");
        assert!(
            try_claim_patrol_loop(&owner, plans),
            "first start in a process owns the loop slot"
        );
        assert!(
            !try_claim_patrol_loop(&owner, plans),
            "a second start for the same plan file must be refused"
        );
        assert!(
            !try_claim_patrol_loop(&owner, Path::new("/tmp/other/provider-patrol-plans.json")),
            "a second start for any plan file must be refused: one scheduler per process"
        );
    }
}
