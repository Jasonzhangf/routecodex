use serde::{Deserialize, Serialize};

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
