use serde::{Deserialize, Serialize};

use super::quota::QuotaViewEntry;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HealthWeightedConfig {
    pub enabled: Option<bool>,
    pub base_weight: Option<i64>,
    pub min_multiplier: Option<f64>,
    pub beta: Option<f64>,
    pub half_life_ms: Option<i64>,
    pub recover_to_best_on_retry: Option<bool>,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedHealthWeightedConfig {
    pub enabled: bool,
    pub base_weight: i64,
    pub min_multiplier: f64,
    pub beta: f64,
    pub half_life_ms: i64,
    pub recover_to_best_on_retry: bool,
}

const DEFAULT_BASE_WEIGHT: i64 = 100;
const DEFAULT_MIN_MULTIPLIER: f64 = 0.5;
const DEFAULT_BETA: f64 = 0.1;
const DEFAULT_HALF_LIFE_MS: i64 = 10 * 60 * 1000;
const DEFAULT_RECOVER_TO_BEST_ON_RETRY: bool = true;

pub(crate) fn resolve_health_weighted_config(
    raw: Option<&HealthWeightedConfig>,
) -> ResolvedHealthWeightedConfig {
    let enabled = raw.and_then(|cfg| cfg.enabled).unwrap_or(false);
    let base_weight = raw
        .and_then(|cfg| cfg.base_weight)
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_BASE_WEIGHT);
    let min_multiplier = raw
        .and_then(|cfg| cfg.min_multiplier)
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.min(1.0))
        .unwrap_or(DEFAULT_MIN_MULTIPLIER);
    let beta = raw
        .and_then(|cfg| cfg.beta)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(DEFAULT_BETA);
    let half_life_ms = raw
        .and_then(|cfg| cfg.half_life_ms)
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_HALF_LIFE_MS);
    let recover_to_best_on_retry = raw
        .and_then(|cfg| cfg.recover_to_best_on_retry)
        .unwrap_or(DEFAULT_RECOVER_TO_BEST_ON_RETRY);

    ResolvedHealthWeightedConfig {
        enabled,
        base_weight,
        min_multiplier,
        beta,
        half_life_ms,
        recover_to_best_on_retry,
    }
}

fn compute_health_multiplier(
    entry: Option<&QuotaViewEntry>,
    now_ms: i64,
    cfg: &ResolvedHealthWeightedConfig,
) -> f64 {
    let Some(entry) = entry else {
        return 1.0;
    };
    let last_error_at_ms = entry.last_error_at_ms;
    let consecutive_error_count = entry.consecutive_error_count.unwrap_or(0).max(0) as f64;
    if last_error_at_ms.is_none() || consecutive_error_count <= 0.0 {
        return 1.0;
    }
    let last_error_at_ms = last_error_at_ms.unwrap_or(now_ms);
    let elapsed_ms = (now_ms - last_error_at_ms).max(0) as f64;
    let half_life = cfg.half_life_ms.max(1) as f64;
    let decay = (-std::f64::consts::LN_2 * elapsed_ms / half_life).exp();
    let effective_errors = consecutive_error_count * decay;
    let raw = 1.0 - cfg.beta * effective_errors;
    raw.max(cfg.min_multiplier).min(1.0)
}

pub(crate) fn compute_health_weight(
    entry: Option<&QuotaViewEntry>,
    now_ms: i64,
    cfg: &ResolvedHealthWeightedConfig,
) -> i64 {
    let multiplier = compute_health_multiplier(entry, now_ms, cfg);
    (cfg.base_weight as f64 * multiplier).round().max(1.0) as i64
}
