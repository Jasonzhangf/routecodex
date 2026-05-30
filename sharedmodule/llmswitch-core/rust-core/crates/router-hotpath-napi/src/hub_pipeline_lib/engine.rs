use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hub_pipeline::{run_hub_pipeline, HubPipelineInput};

use super::diagnostics::{HubPipelineDiagnostic, HubPipelineDiagnosticStatus};
use super::effect_plan::HubPipelineEffectPlan;
use super::errors::{HubPipelineError, HubPipelineResult};
use super::stage_catalog::HubPipelineStageId;
use super::types::{HubPipelineConfig, HubPipelineExecutionOutput, HubPipelineRequest};

#[derive(Debug, Clone, Default)]
pub struct HubPipelineEngine {
    config: HubPipelineConfig,
}

impl HubPipelineEngine {
    pub fn new(config: HubPipelineConfig) -> HubPipelineResult<Self> {
        Ok(Self { config })
    }

    pub fn update_virtual_router_config(&mut self, config: Value) -> HubPipelineResult<()> {
        if !config.is_object() {
            return Err(HubPipelineError::new(
                "hub_pipeline_invalid_virtual_router_config",
                "Virtual router config must be a JSON object",
            ));
        }
        self.config.virtual_router = config;
        Ok(())
    }

    pub fn update_runtime_deps(&mut self, deps: Value) -> HubPipelineResult<()> {
        if !deps.is_object() && !deps.is_null() {
            return Err(HubPipelineError::new(
                "hub_pipeline_invalid_runtime_deps",
                "Runtime deps must be a JSON object or null",
            ));
        }
        Ok(())
    }

    pub fn execute(
        &mut self,
        request: HubPipelineRequest,
    ) -> HubPipelineResult<HubPipelineExecutionOutput> {
        let request_id = if request.request_id.trim().is_empty() {
            "hub_pipeline_rust_lib_request".to_string()
        } else {
            request.request_id.clone()
        };
        let mut diagnostics = vec![diagnostic(
            HubPipelineStageId::NormalizeRequest,
            HubPipelineDiagnosticStatus::Started,
            None,
        )];
        let input = HubPipelineInput {
            request_id: request_id.clone(),
            endpoint: request.endpoint,
            entry_endpoint: request.entry_endpoint,
            provider_protocol: request.provider_protocol,
            payload: request.payload,
            metadata: request.metadata,
            stream: request.stream,
            process_mode: request.process_mode,
            direction: request.direction,
            stage: request.stage,
        };
        let output = run_hub_pipeline(input).map_err(HubPipelineError::from)?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::NormalizeRequest,
            HubPipelineDiagnosticStatus::Completed,
            None,
        ));
        diagnostics.push(diagnostic(
            HubPipelineStageId::EffectPlan,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({ "effects": 0 })),
        ));
        Ok(HubPipelineExecutionOutput {
            request_id: output.request_id,
            success: output.success,
            payload: output.payload,
            metadata: output.metadata,
            effect_plan: HubPipelineEffectPlan::empty(),
            diagnostics,
            error: output.error.map(|error| HubPipelineError {
                code: error.code,
                message: error.message,
                details: error.details,
            }),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteHubPipelineInput {
    #[serde(default)]
    config: HubPipelineConfig,
    request: HubPipelineRequest,
}

pub fn execute_hub_pipeline_json(input_json: String) -> HubPipelineResult<String> {
    if input_json.trim().is_empty() {
        return Err(HubPipelineError::new(
            "hub_pipeline_empty_input",
            "Input JSON is empty",
        ));
    }
    let input: ExecuteHubPipelineInput = serde_json::from_str(&input_json)?;
    let mut engine = HubPipelineEngine::new(input.config)?;
    let output = engine.execute(input.request)?;
    serde_json::to_string(&output).map_err(HubPipelineError::from)
}

fn diagnostic(
    stage_id: HubPipelineStageId,
    status: HubPipelineDiagnosticStatus,
    details: Option<Value>,
) -> HubPipelineDiagnostic {
    HubPipelineDiagnostic {
        stage_id: format!("{:?}", stage_id),
        status,
        details,
    }
}
