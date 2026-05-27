use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextWeightedConfig {
    pub enabled: Option<bool>,
    pub client_cap_tokens: Option<f64>,
    pub gamma: Option<f64>,
    pub max_multiplier: Option<f64>,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedContextWeightedConfig {
    pub enabled: bool,
    pub client_cap_tokens: i64,
    pub gamma: f64,
    pub max_multiplier: f64,
}

const DEFAULT_CLIENT_CAP_TOKENS: i64 = 200_000;
const DEFAULT_GAMMA: f64 = 1.0;
const DEFAULT_MAX_MULTIPLIER: f64 = 2.0;

pub(crate) fn resolve_context_weighted_config(
    raw: Option<&ContextWeightedConfig>,
) -> ResolvedContextWeightedConfig {
    let enabled = raw.and_then(|cfg| cfg.enabled).unwrap_or(false);
    let client_cap_tokens = raw
        .and_then(|cfg| cfg.client_cap_tokens)
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.floor() as i64)
        .unwrap_or(DEFAULT_CLIENT_CAP_TOKENS);
    let gamma = raw
        .and_then(|cfg| cfg.gamma)
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(DEFAULT_GAMMA);
    let max_multiplier = raw
        .and_then(|cfg| cfg.max_multiplier)
        .filter(|value| value.is_finite() && *value >= 1.0)
        .unwrap_or(DEFAULT_MAX_MULTIPLIER);
    ResolvedContextWeightedConfig {
        enabled,
        client_cap_tokens,
        gamma,
        max_multiplier,
    }
}

pub(crate) fn compute_effective_safe_window_tokens(
    model_max_tokens: i64,
    warn_ratio: f64,
    client_cap_tokens: i64,
) -> i64 {
    let model_max_tokens = model_max_tokens.max(1);
    let client_cap_tokens = client_cap_tokens.max(1);
    let warn_ratio = if warn_ratio.is_finite() && warn_ratio > 0.0 && warn_ratio < 1.0 {
        warn_ratio
    } else {
        0.9
    };
    let effective_max = model_max_tokens.min(client_cap_tokens);
    let reserve = ((effective_max as f64) * (1.0 - warn_ratio)).ceil() as i64;
    let slack = (model_max_tokens - client_cap_tokens).max(0);
    let reserve_eff = (reserve - slack).max(0);
    (effective_max - reserve_eff).max(1)
}

pub(crate) fn compute_context_multiplier(
    effective_safe_ref_tokens: i64,
    effective_safe_tokens: i64,
    cfg: &ResolvedContextWeightedConfig,
) -> f64 {
    let reference = effective_safe_ref_tokens.max(1) as f64;
    let current = effective_safe_tokens.max(1) as f64;
    let ratio = (reference / current).max(1.0);
    let raw = ratio.powf(cfg.gamma);
    raw.min(cfg.max_multiplier)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_safe_window_matches_ts_formula() {
        assert_eq!(
            compute_effective_safe_window_tokens(150_000, 0.9, 200_000),
            135_000
        );
        assert_eq!(
            compute_effective_safe_window_tokens(200_000, 0.9, 200_000),
            180_000
        );
        assert_eq!(
            compute_effective_safe_window_tokens(1_000_000, 0.9, 200_000),
            200_000
        );
    }

    #[test]
    fn multiplier_matches_expected_examples() {
        let cfg = resolve_context_weighted_config(Some(&ContextWeightedConfig {
            enabled: Some(true),
            client_cap_tokens: Some(200_000.0),
            gamma: Some(1.0),
            max_multiplier: Some(2.0),
        }));
        assert!((compute_context_multiplier(200_000, 135_000, &cfg) - 1.48148).abs() < 0.001);
        assert!((compute_context_multiplier(200_000, 180_000, &cfg) - 1.11111).abs() < 0.001);
        assert!((compute_context_multiplier(200_000, 200_000, &cfg) - 1.0).abs() < 0.0001);
    }
}
