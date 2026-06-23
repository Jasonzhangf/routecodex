use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextWeightedConfig {
    pub enabled: Option<bool>,
    pub client_cap_tokens: Option<f64>,
    pub gamma: Option<f64>,
    pub max_multiplier: Option<f64>,
}
