use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::diagnostics::HubPipelineDiagnostic;
use super::effect_plan::HubPipelineEffectPlan;
use super::errors::HubPipelineError;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(transparent)]
pub struct RouteRetryExclusionSet(Vec<String>);

impl RouteRetryExclusionSet {
    pub fn normalize(self) -> Result<Self, HubPipelineError> {
        let mut normalized = Vec::with_capacity(self.0.len());
        for provider_key in self.0 {
            let provider_key = provider_key.trim();
            if provider_key.is_empty() {
                return Err(HubPipelineError::new(
                    "hub_pipeline_invalid_retry_exclusion_set",
                    "Rust HubPipeline retryExclusionSet cannot contain blank provider keys",
                ));
            }
            if normalized.iter().any(|existing| existing == provider_key) {
                return Err(HubPipelineError::new(
                    "hub_pipeline_invalid_retry_exclusion_set",
                    format!(
                        "Rust HubPipeline retryExclusionSet contains duplicate provider key: {provider_key}"
                    ),
                ));
            }
            normalized.push(provider_key.to_string());
        }
        Ok(Self(normalized))
    }

    pub fn as_slice(&self) -> &[String] {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubPipelineConfig {
    #[serde(default)]
    pub virtual_router: Value,
    #[serde(default)]
    pub policy: Value,
    #[serde(default)]
    pub tool_surface: Value,
    #[serde(default)]
    pub runtime_router_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubPipelineRequest {
    #[serde(default)]
    pub request_id: String,
    pub endpoint: String,
    #[serde(default)]
    pub entry_endpoint: String,
    #[serde(default)]
    pub provider_protocol: String,
    pub payload: Value,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub metadata_center_snapshot: Value,
    #[serde(default)]
    pub retry_exclusion_set: RouteRetryExclusionSet,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub process_mode: String,
    #[serde(default)]
    pub direction: String,
    #[serde(default)]
    pub stage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubPipelineExecutionOutput {
    pub request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub standardized_request: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_origin_request: Option<Value>,
    pub effect_plan: HubPipelineEffectPlan,
    #[serde(default)]
    pub diagnostics: Vec<HubPipelineDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<HubPipelineError>,
}
